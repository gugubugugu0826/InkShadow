import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SqlExecutor, SqlPrimitive, TransactionExecutor } from "../src/executor.js";
import {
  createGraphRagSqliteSlice,
  GraphRagSqliteRepository,
} from "../src/graph-rag-sqlite-store.js";
import {
  graphEvidenceSpanHash,
  type GraphEntity,
  type GraphRagProjectSnapshot,
  type GraphRelation,
  type GraphRelationEvidence,
  type GraphSourceVersion,
} from "@inkshadow/search-core";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0020_graph_rag_projection.sql", import.meta.url), "utf8"),
].join("\n");

const NOW = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T01:00:00.000Z";
const LATER_2 = "2026-07-28T02:00:00.000Z";
const LATER_3 = "2026-07-28T03:00:00.000Z";
const LATER_4 = "2026-07-28T04:00:00.000Z";
const PROJECT_ID = "project-1";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GraphRagSqliteRepository vertical slice", () => {
  it("persists and restarts exact emoji evidence as an auditable context-only candidate", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "inkshadow-graph-rag-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "projection.sqlite");
    let executor = new NodeSqliteExecutor(migration, databasePath);
    await seedProject(executor, PROJECT_ID, "Persistent graph");

    const initial = emojiSnapshot();
    const slice = createGraphRagSqliteSlice(executor);
    const replaced = await slice.indexing.replaceProject({
      snapshot: initial,
      expectedRevision: 0,
      mutatedAt: NOW,
    });
    expect(replaced).toEqual({
      ok: true,
      value: {
        projectId: PROJECT_ID,
        previousRevision: 0,
        revision: 1,
        updatedAt: NOW,
      },
    });

    const first = await slice.querying.execute({
      projectId: PROJECT_ID,
      seedEntityIds: ["aria"],
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value).toMatchObject({
        kind: "graph_context_candidate",
        publicationBoundary: "candidate_only",
        formalContentWriteAllowed: false,
        requiresExplicitAcceptance: true,
        projectionRevision: 1,
      });
      expect(first.value.result.relationCandidates[0]?.assertions[0]?.evidence[0]).toMatchObject({
        quote: "😀阿遥",
        span: {
          startOffset: 2,
          endOffset: 6,
          encoding: "utf16",
        },
      });
      expect(first.value.sourceReferences).toHaveLength(3);
    }

    await executor.close();
    executor = new NodeSqliteExecutor(migration, databasePath);
    const restarted = await createGraphRagSqliteSlice(executor).querying.execute({
      projectId: PROJECT_ID,
      seedEntityIds: ["aria"],
    });
    expect(restarted).toEqual(first);
    await executor.close();
  });

  it("enforces CAS and source monotonicity while propagating version and deletion invalidation", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor, PROJECT_ID, "Monotonic graph");
    const slice = createGraphRagSqliteSlice(executor);
    expect(
      await slice.indexing.replaceProject({
        snapshot: emojiSnapshot(),
        expectedRevision: 0,
        mutatedAt: NOW,
      }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });

    const nextChapter = source("chapter", "v2", "😀阿遥不再信任柏林。", LATER);
    expect(
      await slice.indexing.upsertSourceVersion({
        source: nextChapter,
        expectedRevision: 1,
        mutatedAt: LATER,
      }),
    ).toMatchObject({ ok: true, value: { revision: 2 } });

    const staleEvidenceResult = await slice.querying.execute({
      projectId: PROJECT_ID,
      seedEntityIds: ["aria"],
    });
    expect(staleEvidenceResult.ok).toBe(true);
    if (staleEvidenceResult.ok) {
      expect(staleEvidenceResult.value.result.relationCandidates).toEqual([]);
      expect(staleEvidenceResult.value.result.capabilities.relation).toBe("degraded");
      expect(staleEvidenceResult.value.result.notices).toContain(
        "graph_stale_or_missing_evidence_filtered",
      );
    }

    const staleCas = await slice.indexing.invalidateSourceVersion({
      projectId: PROJECT_ID,
      sourceId: "chapter",
      sourceVersionId: "v2",
      state: "deleted",
      expectedRevision: 1,
      mutatedAt: LATER_2,
    });
    expect(staleCas).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });

    const outOfOrder = await slice.indexing.upsertSourceVersion({
      source: source("chapter", "v3", "out of order", NOW),
      expectedRevision: 2,
      mutatedAt: LATER_2,
    });
    expect(outOfOrder).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });

    expect(
      await slice.indexing.invalidateSourceVersion({
        projectId: PROJECT_ID,
        sourceId: "chapter",
        sourceVersionId: "v2",
        state: "deleted",
        expectedRevision: 2,
        mutatedAt: LATER_3,
      }),
    ).toMatchObject({ ok: true, value: { revision: 3 } });

    const resurrection = await slice.indexing.upsertSourceVersion({
      source: source("chapter", "v3", "must not resurrect", NOW),
      expectedRevision: 3,
      mutatedAt: LATER_4,
    });
    expect(resurrection).toMatchObject({
      ok: false,
      error: { code: "VERSION_CONFLICT" },
    });
    const loaded = await slice.repository.loadProject(PROJECT_ID);
    expect(loaded).toMatchObject({ ok: true, value: { revision: 3 } });

    expect(
      await slice.indexing.invalidateSourceVersion({
        projectId: PROJECT_ID,
        sourceId: "aria-source",
        sourceVersionId: "v1",
        state: "deleted",
        expectedRevision: 3,
        mutatedAt: LATER_4,
      }),
    ).toMatchObject({ ok: true, value: { revision: 4 } });
    expect(
      await slice.querying.execute({
        projectId: PROJECT_ID,
        seedEntityIds: ["aria"],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        details: { graphErrorCode: "GRAPH_SEED_NOT_FOUND" },
      },
    });
    await executor.close();
  });

  it("retains duplicate and conflicting assertions while bounding deterministic cyclic traversal", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor, PROJECT_ID, "Bounded graph");
    const slice = createGraphRagSqliteSlice(executor);
    const graph = cyclicConflictSnapshot();
    expect(
      await slice.indexing.replaceProject({
        snapshot: graph,
        expectedRevision: 0,
        mutatedAt: NOW,
      }),
    ).toMatchObject({ ok: true });

    const queried = await slice.querying.execute({
      projectId: PROJECT_ID,
      seedEntityIds: ["a"],
      direction: "outgoing",
      limits: {
        maxDepth: 3,
        maxNodes: 3,
        maxEdges: 10,
      },
    });
    expect(queried.ok).toBe(true);
    if (queried.ok) {
      expect(queried.value.result.entities.map(({ entity }) => entity.id)).toEqual(["a", "b", "c"]);
      expect(queried.value.result.limits.nodeLimitReached).toBe(true);
      expect(queried.value.result.relationCandidates[0]).toMatchObject({
        fromEntityId: "a",
        toEntityId: "b",
        conflict: {
          detected: true,
          polarities: ["affirmed", "negated"],
        },
        explanation: {
          duplicateRelationsCollapsed: 1,
        },
      });
    }
    await executor.close();
  });

  it("fails closed on forged stored spans and can atomically rebuild a corrupt projection", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor, PROJECT_ID, "Repairable graph");
    const snapshot = emojiSnapshot();
    const slice = createGraphRagSqliteSlice(executor);
    expect(
      await slice.indexing.replaceProject({
        snapshot,
        expectedRevision: 0,
        mutatedAt: NOW,
      }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });

    await executor.execute(
      `UPDATE graph_rag_relation_evidence
       SET quote = '😀柏林'
       WHERE project_id = ? AND evidence_id = 'evidence-1'`,
      [PROJECT_ID],
    );
    const corrupt = await slice.querying.execute({
      projectId: PROJECT_ID,
      seedEntityIds: ["aria"],
    });
    expect(corrupt).toMatchObject({ ok: false, error: { code: "REPOSITORY_ERROR" } });

    const rebuilt = await slice.indexing.replaceProject({
      snapshot,
      expectedRevision: 1,
      mutatedAt: LATER,
    });
    expect(rebuilt).toMatchObject({ ok: true, value: { revision: 2 } });
    const recovered = await slice.querying.execute({
      projectId: PROJECT_ID,
      seedEntityIds: ["aria"],
    });
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        projectionRevision: 2,
        result: { relationCandidates: [{ kind: "entrusted_key_to" }] },
      },
    });
    await executor.close();
  });

  it("rolls the entire rebuild back after a mid-transaction evidence failure", async () => {
    const base = new NodeSqliteExecutor(migration);
    await seedProject(base, PROJECT_ID, "Rollback graph");
    const failing = new FailOnceExecutor(base, "INSERT INTO graph_rag_relation_evidence");
    const repository = new GraphRagSqliteRepository(failing);

    const result = await repository.replaceProject({
      snapshot: emojiSnapshot(),
      expectedRevision: 0,
      mutatedAt: NOW,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "REPOSITORY_ERROR" } });
    await expect(
      base.select<{ count: number }>(
        `SELECT count(*) AS count
         FROM graph_rag_projection_state
         WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      base.select<{ count: number }>(
        `SELECT count(*) AS count
         FROM graph_rag_source_versions
         WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await base.close();
  });

  it("rejects relation rebinding and cross-project evidence without changing revision", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor, PROJECT_ID, "Authority graph");
    await seedProject(executor, "project-2", "Foreign graph");
    const slice = createGraphRagSqliteSlice(executor);
    const snapshot = emojiSnapshot();
    expect(
      await slice.indexing.replaceProject({
        snapshot,
        expectedRevision: 0,
        mutatedAt: NOW,
      }),
    ).toMatchObject({ ok: true });

    const original = requireFirst(snapshot.relations, "test relation");
    const originalEvidence = requireFirst(original.evidence, "test evidence");
    const rebound: GraphRelation = {
      ...original,
      kind: "enemy_of",
    };
    expect(
      await slice.indexing.upsertRelation({
        relation: rebound,
        expectedRevision: 1,
        mutatedAt: LATER,
      }),
    ).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });

    const foreignEvidence: GraphRelation = {
      ...original,
      id: "foreign-evidence-relation",
      evidence: [
        {
          ...originalEvidence,
          projectId: "project-2",
        },
      ],
    };
    expect(
      await slice.indexing.upsertRelation({
        relation: foreignEvidence,
        expectedRevision: 1,
        mutatedAt: LATER,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });

    expect(
      await slice.indexing.replaceProject({
        snapshot: {
          ...snapshot,
          relations: [],
        },
        expectedRevision: 1,
        mutatedAt: LATER,
      }),
    ).toMatchObject({ ok: true, value: { revision: 2 } });
    expect(
      await slice.indexing.replaceProject({
        snapshot: {
          ...snapshot,
          relations: [rebound],
        },
        expectedRevision: 2,
        mutatedAt: LATER_2,
      }),
    ).toMatchObject({ ok: false, error: { code: "VERSION_CONFLICT" } });
    expect(await slice.repository.loadProject(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { revision: 2, relations: [] },
    });
    await executor.close();
  });
});

function emojiSnapshot(): GraphRagProjectSnapshot {
  const ariaSource = source("aria-source", "v1", "阿遥角色档案", NOW);
  const borinSource = source("borin-source", "v1", "柏林角色档案", NOW);
  const chapterSource = source("chapter", "v1", "序章😀阿遥把钥匙交给柏林。", NOW);
  const aria = entity("aria", ariaSource);
  const borin = entity("borin", borinSource);
  return {
    projectId: PROJECT_ID,
    sourceVersions: [ariaSource, borinSource, chapterSource].map((item) => ({
      source: item,
      state: "current" as const,
    })),
    entities: [aria, borin],
    relations: [
      relation("relation-1", "aria", "borin", evidence("evidence-1", chapterSource, "😀阿遥"), {
        kind: "entrusted_key_to",
        confidence: 0.91,
      }),
    ],
  };
}

function cyclicConflictSnapshot(): GraphRagProjectSnapshot {
  const entitySources = (["a", "b", "c", "d"] as const).map((id) => ({
    id,
    source: source(`${id}-source`, "v1", `${id} dossier`, NOW),
  }));
  const chapter = source("cycle-chapter", "v1", "cycle conflict evidence", NOW);
  const entities = entitySources.map((item) => entity(item.id, item.source));
  return {
    projectId: PROJECT_ID,
    sourceVersions: [...entitySources.map(({ source: item }) => item), chapter].map((item) => ({
      source: item,
      state: "current" as const,
    })),
    entities,
    relations: [
      relation("ab-affirmed-high", "a", "b", evidence("e-1", chapter, "conflict"), {
        confidence: 0.9,
      }),
      relation("ab-affirmed-low", "a", "b", evidence("e-2", chapter, "conflict"), {
        confidence: 0.7,
      }),
      relation("ab-negated", "a", "b", evidence("e-3", chapter, "conflict"), {
        polarity: "negated",
        confidence: 0.8,
      }),
      relation("bc", "b", "c", evidence("e-4", chapter, "cycle"), {
        confidence: 0.85,
      }),
      relation("ca", "c", "a", evidence("e-5", chapter, "cycle"), {
        confidence: 0.75,
      }),
      relation("cd", "c", "d", evidence("e-6", chapter, "evidence"), {
        confidence: 0.65,
      }),
    ],
  };
}

function source(
  sourceId: string,
  sourceVersionId: string,
  content: string,
  createdAt: string,
  projectId = PROJECT_ID,
): GraphSourceVersion {
  return {
    projectId,
    sourceId,
    sourceVersionId,
    contentHash: createHash("sha256").update(content).digest("hex"),
    content,
    createdAt,
  };
}

function entity(id: string, entitySource: GraphSourceVersion): GraphEntity {
  return {
    id,
    projectId: entitySource.projectId,
    kind: "character",
    label: id,
    documentId: `document-${id}`,
    source: {
      sourceId: entitySource.sourceId,
      sourceVersionId: entitySource.sourceVersionId,
      contentHash: entitySource.contentHash,
    },
    updatedAt: entitySource.createdAt,
  };
}

function evidence(
  id: string,
  evidenceSource: GraphSourceVersion,
  quote: string,
): GraphRelationEvidence {
  const startOffset = evidenceSource.content.indexOf(quote);
  if (startOffset < 0) {
    throw new Error("The test quote is missing.");
  }
  return {
    id,
    projectId: evidenceSource.projectId,
    sourceId: evidenceSource.sourceId,
    sourceVersionId: evidenceSource.sourceVersionId,
    contentHash: evidenceSource.contentHash,
    span: {
      startOffset,
      endOffset: startOffset + quote.length,
      encoding: "utf16",
    },
    quote,
    spanHash: graphEvidenceSpanHash(quote),
    citation: {
      label: "Chapter",
      locator: `utf16:${String(startOffset)}-${String(startOffset + quote.length)}`,
    },
  };
}

function relation(
  id: string,
  fromEntityId: string,
  toEntityId: string,
  relationEvidence: GraphRelationEvidence,
  overrides: Partial<GraphRelation> = {},
): GraphRelation {
  return {
    id,
    projectId: relationEvidence.projectId,
    fromEntityId,
    toEntityId,
    kind: "knows",
    polarity: "affirmed",
    confidence: 0.8,
    evidence: [relationEvidence],
    updatedAt: NOW,
    ...overrides,
  };
}

async function seedProject(executor: SqlExecutor, projectId: string, name: string): Promise<void> {
  await executor.execute(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [projectId, name, NOW, NOW],
  );
}

class FailOnceExecutor implements SqlExecutor {
  private armed = true;

  public constructor(
    private readonly delegate: SqlExecutor,
    private readonly queryFragment: string,
  ) {}

  public select<Row extends object>(
    query: string,
    bindValues?: readonly SqlPrimitive[],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, bindValues);
  }

  public execute(
    query: string,
    bindValues?: readonly SqlPrimitive[],
  ): Promise<{ rowsAffected: number; lastInsertId?: number }> {
    return this.delegate.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction((transaction) =>
      operation({
        select: <Row extends object>(query: string, bindValues: readonly SqlPrimitive[] = []) =>
          transaction.select<Row>(query, bindValues),
        execute: (query: string, bindValues: readonly SqlPrimitive[] = []) => {
          if (this.armed && query.includes(this.queryFragment)) {
            this.armed = false;
            throw new Error("Injected evidence persistence failure.");
          }
          return transaction.execute(query, bindValues);
        },
      }),
    );
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }
}

function requireFirst<Value>(values: readonly Value[], label: string): Value {
  const value = values[0];
  if (value === undefined) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}
