import { graphEvidenceSpanHash, type GraphRagProjectSnapshot } from "@inkshadow/search-core";
import { describe, expect, it } from "vitest";

import {
  QueryGraphRagContext,
  type GraphRagProjectionRepository,
  type PersistedGraphRagProject,
} from "../src/index.js";
import { ok } from "@inkshadow/domain";

const NOW = "2026-07-28T00:00:00.000Z";

describe("QueryGraphRagContext", () => {
  it("returns only an auditable candidate boundary with authoritative source references", async () => {
    const repository = new StaticGraphRepository(persisted(snapshot()));
    const result = await new QueryGraphRagContext(repository).execute({
      projectId: "project-1",
      seedEntityIds: ["a"],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "graph_context_candidate",
        publicationBoundary: "candidate_only",
        formalContentWriteAllowed: false,
        requiresExplicitAcceptance: true,
        projectionRevision: 5,
        sourceReferences: [
          {
            sourceId: "source-1",
            sourceVersionId: "v1",
            contentHash: "a".repeat(64),
          },
        ],
      },
    });
  });

  it("fails closed when a repository returns forged evidence", async () => {
    const valid = snapshot();
    const relation = requireFirst(valid.relations, "test relation");
    const relationEvidence = requireFirst(relation.evidence, "test evidence");
    const forged = {
      ...valid,
      relations: [
        {
          ...relation,
          evidence: [
            {
              ...relationEvidence,
              quote: "B",
            },
          ],
        },
      ],
    };
    const result = await new QueryGraphRagContext(
      new StaticGraphRepository(persisted(forged)),
    ).execute({
      projectId: "project-1",
      seedEntityIds: ["a"],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "REPOSITORY_ERROR",
        details: { operation: "GRAPH_RAG_PROJECTION_CORRUPT" },
      },
    });
  });
});

class StaticGraphRepository implements GraphRagProjectionRepository {
  public constructor(private readonly project: PersistedGraphRagProject) {}

  public loadProject(): ReturnType<GraphRagProjectionRepository["loadProject"]> {
    return Promise.resolve(ok(this.project));
  }

  public upsertSourceVersion(): Promise<never> {
    return Promise.reject(new Error("Not used by this query test."));
  }

  public invalidateSourceVersion(): Promise<never> {
    return Promise.reject(new Error("Not used by this query test."));
  }

  public upsertEntity(): Promise<never> {
    return Promise.reject(new Error("Not used by this query test."));
  }

  public softDeleteEntity(): Promise<never> {
    return Promise.reject(new Error("Not used by this query test."));
  }

  public upsertRelation(): Promise<never> {
    return Promise.reject(new Error("Not used by this query test."));
  }

  public softDeleteRelation(): Promise<never> {
    return Promise.reject(new Error("Not used by this query test."));
  }

  public replaceProject(): Promise<never> {
    return Promise.reject(new Error("Not used by this query test."));
  }
}

function persisted(project: GraphRagProjectSnapshot): PersistedGraphRagProject {
  return {
    ...project,
    revision: 5,
    status: "ready",
    updatedAt: NOW,
  };
}

function snapshot(): GraphRagProjectSnapshot {
  const content = "A😀B";
  const reference = {
    sourceId: "source-1",
    sourceVersionId: "v1",
    contentHash: "a".repeat(64),
  };
  return {
    projectId: "project-1",
    sourceVersions: [
      {
        source: {
          projectId: "project-1",
          ...reference,
          content,
          createdAt: NOW,
        },
        state: "current",
      },
    ],
    entities: [
      {
        id: "a",
        projectId: "project-1",
        kind: "character",
        label: "A",
        source: reference,
        updatedAt: NOW,
      },
      {
        id: "b",
        projectId: "project-1",
        kind: "character",
        label: "B",
        source: reference,
        updatedAt: NOW,
      },
    ],
    relations: [
      {
        id: "ab",
        projectId: "project-1",
        fromEntityId: "a",
        toEntityId: "b",
        kind: "knows",
        polarity: "affirmed",
        confidence: 0.8,
        evidence: [
          {
            id: "evidence-1",
            projectId: "project-1",
            ...reference,
            span: {
              startOffset: 1,
              endOffset: 3,
              encoding: "utf16",
            },
            quote: "😀",
            spanHash: graphEvidenceSpanHash("😀"),
            citation: {
              label: "Chapter",
              locator: "utf16:1-3",
            },
          },
        ],
        updatedAt: NOW,
      },
    ],
  };
}

function requireFirst<Value>(values: readonly Value[], label: string): Value {
  const value = values[0];
  if (value === undefined) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}
