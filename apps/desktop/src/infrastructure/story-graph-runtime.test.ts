import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { AUTHORITATIVE_STORY_GRAPH_LIMITS, type ContentHasher } from "@inkshadow/application";
import { parseContentChecksum, parseIsoUtcTimestamp, type Clock } from "@inkshadow/domain";
import {
  GraphRagSqliteRepository,
  type ExecuteResult,
  type SqlExecutor,
  type SqlPrimitive,
  type TransactionExecutor,
} from "@inkshadow/data";
import {
  graphEvidenceSpanHash,
  type GraphEntity,
  type GraphRagProjectSnapshot,
  type GraphRelation,
  type GraphRelationEvidence,
  type GraphSourceVersion,
} from "@inkshadow/search-core";
import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { createSqliteStoryGraphRuntime } from "./story-graph-runtime";

const migration = [
  readWorkspaceFile("packages", "data", "migrations", "0001_core.sql"),
  readWorkspaceFile("packages", "story-core", "migrations", "0001_story_core.sql"),
  readWorkspaceFile("packages", "data", "migrations", "0020_graph_rag_projection.sql"),
  readWorkspaceFile("packages", "data", "migrations", "0023_authoritative_story_graph_epoch.sql"),
].join("\n");

const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const NOW = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T00:01:00.000Z";
const SEED_ID = "chapter:seed";

describe("authoritative Story graph SQLite runtime", () => {
  it("uses a non-blocking epoch seqlock and never returns a candidate across Story autosave", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    await seedPublishedGraph(executor);
    const delayed = new DelayedGraphReadExecutor(executor);
    const hasher = new CountingHasher();
    const runtime = createSqliteStoryGraphRuntime({
      executor: delayed,
      hasher,
      clock: fixedClock(),
    });

    const pending = runtime.queryContext({
      projectId: PROJECT_ID,
      seedEntityIds: [SEED_ID],
    });
    await delayed.waitUntilGraphRead();
    await executor.execute(
      `INSERT INTO story_formal_records (
         id, project_id, kind, record_key, revision, current_version,
         created_at, updated_at, snapshot_json
       ) VALUES (?, ?, 'character', 'invalid-fixture', 1, 1, ?, ?, '{}')`,
      ["018f0d7a-3b2c-7abc-8def-000000000099", PROJECT_ID, NOW, NOW],
    );
    delayed.releaseGraphRead();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: {
        code: "CANDIDATE_NOT_READY",
        details: { reason: "AUTHORITY_CHANGED_DURING_QUERY" },
      },
    });
    expect(delayed.graphSourceReads).toBe(1);

    const inspection = await runtime.inspectProject(PROJECT_ID);
    expect(inspection).toMatchObject({
      ok: true,
      value: { freshness: "stale", projection: { revision: 1 } },
    });
    expect(hasher.calls).toBe(0);

    await executor.execute("DELETE FROM story_formal_records WHERE project_id = ?", [PROJECT_ID]);
    const rebuilt = await runtime.rebuildProject(PROJECT_ID);
    expect(rebuilt).toMatchObject({
      ok: true,
      value: {
        previousRevision: 1,
        revision: 2,
        casAttempts: 1,
        relationCount: 0,
      },
    });
    await expect(runtime.inspectProject(PROJECT_ID)).resolves.toMatchObject({
      ok: true,
      value: {
        freshness: "fresh",
        projection: { revision: 2, relations: [] },
      },
    });

    await executor.close();
  });

  it("rolls back the graph and owner receipt when publication faults after deletion", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    await seedPublishedGraph(executor);
    const faulted = new FailOnceTransactionExecutor(
      executor,
      "DELETE FROM graph_rag_source_versions",
    );
    const runtime = createSqliteStoryGraphRuntime({
      executor: faulted,
      hasher: new CountingHasher(),
      clock: fixedClock(),
    });

    await expect(runtime.rebuildProject(PROJECT_ID)).resolves.toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_ERROR" },
    });
    await expect(
      new GraphRagSqliteRepository(executor).loadProject(PROJECT_ID),
    ).resolves.toMatchObject({
      ok: true,
      value: { revision: 1, relations: [{ id: "extraction-review:seed" }] },
    });
    expect(await readOwnerReceipt(executor)).toEqual({
      authority_epoch: 0,
      projected_epoch: 0,
      projected_graph_revision: 1,
    });

    await executor.close();
  });

  it("recovers corrupt Story-owned rows but refuses an unowned or revision-drifted graph", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    await seedPublishedGraph(executor);
    await executor.execute(
      `UPDATE graph_rag_relation_evidence
       SET quote = 'forged'
       WHERE project_id = ?`,
      [PROJECT_ID],
    );
    await expect(
      new GraphRagSqliteRepository(executor).loadProject(PROJECT_ID),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_ERROR" },
    });

    const runtime = createSqliteStoryGraphRuntime({
      executor,
      hasher: new CountingHasher(),
      clock: fixedClock(),
    });
    await expect(runtime.rebuildProject(PROJECT_ID)).resolves.toMatchObject({
      ok: true,
      value: { previousRevision: 1, revision: 2 },
    });
    await expect(
      new GraphRagSqliteRepository(executor).loadProject(PROJECT_ID),
    ).resolves.toMatchObject({
      ok: true,
      value: { revision: 2, relations: [] },
    });

    await executor.execute(
      "UPDATE graph_rag_projection_state SET revision = 3 WHERE project_id = ?",
      [PROJECT_ID],
    );
    await expect(runtime.rebuildProject(PROJECT_ID)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { reason: "GRAPH_OWNER_REVISION_MISMATCH" },
      },
    });
    await executor.close();

    const unowned = new NodeSqliteExecutor(migration);
    await seedProject(unowned);
    await new GraphRagSqliteRepository(unowned).replaceProject({
      snapshot: graphSnapshot(),
      expectedRevision: 0,
      mutatedAt: NOW,
    });
    const unownedRuntime = createSqliteStoryGraphRuntime({
      executor: unowned,
      hasher: new CountingHasher(),
      clock: fixedClock(),
    });
    await expect(unownedRuntime.rebuildProject(PROJECT_ID)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { reason: "GRAPH_OWNER_RECEIPT_MISSING" },
      },
    });
    await unowned.close();
  });

  it("excludes non-current autosave history from the materialization byte budget", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    const chapterId = "018f0d7a-3b2c-7abc-8def-000000000010";
    const oldVersionId = "018f0d7a-3b2c-7abc-8def-000000000011";
    const currentVersionId = "018f0d7a-3b2c-7abc-8def-000000000012";
    await executor.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision,
           current_version_id, created_at, updated_at
         ) VALUES (?, ?, 'Chapter', 'x', 'active', 1, ?, ?, ?)`,
        [chapterId, PROJECT_ID, currentVersionId, NOW, NOW],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
        [oldVersionId, PROJECT_ID, chapterId, "h".repeat(2_000), "0".repeat(64), NOW],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, 2, 'x', ?, 'autosave', NULL, ?)`,
        [
          currentVersionId,
          PROJECT_ID,
          chapterId,
          oldVersionId,
          createHash("sha256").update("x").digest("hex"),
          LATER,
        ],
      );
    });
    expect(await readOwnerReceipt(executor)).toEqual({
      authority_epoch: 3,
      projected_epoch: null,
      projected_graph_revision: null,
    });

    const runtime = createSqliteStoryGraphRuntime({
      executor,
      hasher: new CountingHasher(),
      clock: fixedClock(),
      capacityLimits: {
        ...AUTHORITATIVE_STORY_GRAPH_LIMITS,
        storedAuthorityUtf8Bytes: 128,
      },
    });
    await expect(runtime.rebuildProject(PROJECT_ID)).resolves.toMatchObject({
      ok: true,
      value: { chapterCount: 1 },
    });

    await executor.close();
  });

  it("rejects incomplete and paused publications before graph traversal", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedProject(executor);
    await seedPublishedGraph(executor);
    const runtime = createSqliteStoryGraphRuntime({
      executor,
      hasher: new CountingHasher(),
      clock: fixedClock(),
    });

    await executor.execute(
      "UPDATE authoritative_story_graph_state SET projection_complete = 0 WHERE project_id = ?",
      [PROJECT_ID],
    );
    await expect(
      runtime.queryContext({ projectId: PROJECT_ID, seedEntityIds: [SEED_ID] }),
    ).resolves.toMatchObject({ ok: false, error: { code: "CANDIDATE_NOT_READY" } });

    await executor.execute(
      "UPDATE authoritative_story_graph_state SET projection_complete = 1 WHERE project_id = ?",
      [PROJECT_ID],
    );
    await executor.execute(
      "UPDATE graph_rag_projection_state SET status = 'paused' WHERE project_id = ?",
      [PROJECT_ID],
    );
    await expect(
      runtime.queryContext({ projectId: PROJECT_ID, seedEntityIds: [SEED_ID] }),
    ).resolves.toMatchObject({ ok: false, error: { code: "CANDIDATE_NOT_READY" } });

    await executor.close();
  });
});

class CountingHasher implements ContentHasher {
  public calls = 0;

  public sha256(content: string) {
    this.calls += 1;
    return Promise.resolve(
      parseContentChecksum(createHash("sha256").update(content).digest("hex")),
    );
  }
}

class DelayedGraphReadExecutor implements SqlExecutor {
  public graphSourceReads = 0;
  private graphReadStarted: (() => void) | null = null;
  private graphReadReleased: (() => void) | null = null;
  private readonly started = new Promise<void>((resolve) => {
    this.graphReadStarted = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.graphReadReleased = resolve;
  });

  public constructor(private readonly delegate: SqlExecutor) {}

  public async select<Row extends object>(
    query: string,
    bindValues?: readonly SqlPrimitive[],
  ): Promise<Row[]> {
    if (query.includes("SELECT project_id, source_id, source_version_id")) {
      this.graphSourceReads += 1;
      this.graphReadStarted?.();
      await this.released;
    }
    return this.delegate.select<Row>(query, bindValues);
  }

  public execute(query: string, bindValues?: readonly SqlPrimitive[]): Promise<ExecuteResult> {
    return this.delegate.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction(operation);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  public waitUntilGraphRead(): Promise<void> {
    return this.started;
  }

  public releaseGraphRead(): void {
    this.graphReadReleased?.();
  }
}

class FailOnceTransactionExecutor implements SqlExecutor {
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

  public execute(query: string, bindValues?: readonly SqlPrimitive[]): Promise<ExecuteResult> {
    return this.delegate.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction((transaction) =>
      operation({
        select: <Row extends object>(query: string, bindValues: readonly SqlPrimitive[] = []) =>
          transaction.select<Row>(query, bindValues),
        execute: (
          query: string,
          bindValues: readonly SqlPrimitive[] = [],
        ): Promise<ExecuteResult> => {
          if (this.armed && query.includes(this.queryFragment)) {
            this.armed = false;
            throw new Error("Injected graph publication failure.");
          }
          return transaction.execute(query, bindValues);
        },
      }),
    );
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

async function seedProject(executor: SqlExecutor): Promise<void> {
  await executor.execute(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [PROJECT_ID, "Story graph", NOW, NOW],
  );
}

async function seedPublishedGraph(executor: SqlExecutor): Promise<void> {
  const replaced = await new GraphRagSqliteRepository(executor).replaceProject({
    snapshot: graphSnapshot(),
    expectedRevision: 0,
    mutatedAt: NOW,
  });
  if (!replaced.ok) {
    throw replaced.error;
  }
  await executor.execute(
    `INSERT INTO authoritative_story_graph_state (
       project_id, authority_epoch, projected_epoch,
       projected_graph_revision, projection_complete, diagnostics_json
     ) VALUES (?, 0, 0, 1, 1, ?)`,
    [PROJECT_ID, JSON.stringify(publishedDiagnostics())],
  );
}

function graphSnapshot(): GraphRagProjectSnapshot {
  const chapter = source("chapter-source:seed", "chapter-version:seed", "Aria met Borin.");
  const formal = source("formal-source:seed", "formal-version:seed", "Aria");
  const chapterEntity = entity(SEED_ID, "chapter", chapter);
  const formalEntity = entity("formal:seed", "character", formal);
  const support = evidence("extraction-review-evidence:seed", chapter, "Aria");
  return {
    projectId: PROJECT_ID,
    sourceVersions: [chapter, formal].map((item) => ({
      source: item,
      state: "current" as const,
    })),
    entities: [chapterEntity, formalEntity],
    relations: [relation("extraction-review:seed", chapterEntity.id, formalEntity.id, support)],
  };
}

function source(sourceId: string, sourceVersionId: string, content: string): GraphSourceVersion {
  return {
    projectId: PROJECT_ID,
    sourceId,
    sourceVersionId,
    contentHash: createHash("sha256").update(content).digest("hex"),
    content,
    createdAt: NOW,
  };
}

function entity(id: string, kind: string, entitySource: GraphSourceVersion): GraphEntity {
  return {
    id,
    projectId: PROJECT_ID,
    kind,
    label: id,
    source: {
      sourceId: entitySource.sourceId,
      sourceVersionId: entitySource.sourceVersionId,
      contentHash: entitySource.contentHash,
    },
    updatedAt: NOW,
  };
}

function evidence(
  id: string,
  evidenceSource: GraphSourceVersion,
  quote: string,
): GraphRelationEvidence {
  const startOffset = evidenceSource.content.indexOf(quote);
  return {
    id,
    projectId: PROJECT_ID,
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
): GraphRelation {
  return {
    id,
    projectId: PROJECT_ID,
    fromEntityId,
    toEntityId,
    kind: "extraction_supports",
    polarity: "affirmed",
    confidence: 1,
    evidence: [relationEvidence],
    updatedAt: NOW,
  };
}

function publishedDiagnostics() {
  return {
    formalRecordCount: 1,
    reviewItemCount: 1,
    chapterCount: 1,
    formalEntityCount: 1,
    chapterEntityCount: 1,
    relationCount: 1,
    sourceVersionCount: 2,
    skippedRelationCount: 0,
    invalidatedSupportCount: 0,
    projectionOmissionCount: 0,
    nonReviewDerivedFormalCount: 0,
    nonExtractionReviewFormalCount: 0,
    skipped: [],
    partial: false,
    stale: false,
  };
}

function fixedClock(): Clock {
  const parsed = parseIsoUtcTimestamp(LATER);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return { now: () => parsed.value };
}

async function readOwnerReceipt(executor: SqlExecutor) {
  const rows = await executor.select<{
    readonly authority_epoch: number;
    readonly projected_epoch: number | null;
    readonly projected_graph_revision: number | null;
  }>(
    `SELECT authority_epoch, projected_epoch, projected_graph_revision
     FROM authoritative_story_graph_state
     WHERE project_id = ?`,
    [PROJECT_ID],
  );
  return rows[0] ?? null;
}

function readWorkspaceFile(...segments: string[]): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (
    !existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml")) &&
    path.dirname(workspaceRoot) !== workspaceRoot
  ) {
    workspaceRoot = path.dirname(workspaceRoot);
  }
  return readFileSync(path.join(workspaceRoot, ...segments), "utf8");
}
