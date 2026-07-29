import { describe, expect, it } from "vitest";

import {
  graphEvidenceSpanHash,
  InMemoryGraphRagIndex,
  type GraphEntity,
  type GraphRelation,
  type GraphRelationEvidence,
  type GraphSourceVersion,
} from "../src/index.js";

const NOW = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T01:00:00.000Z";

function fakeSha256(value: string): string {
  const sum = [...value].reduce((total, character) => total + (character.codePointAt(0) ?? 0), 0);
  return sum.toString(16).padStart(64, "0");
}

function source(
  sourceId: string,
  content: string,
  overrides: Partial<GraphSourceVersion> = {},
): GraphSourceVersion {
  return {
    projectId: "project-1",
    sourceId,
    sourceVersionId: `${sourceId}-v1`,
    contentHash: fakeSha256(`${sourceId}-v1`),
    content,
    createdAt: NOW,
    ...overrides,
  };
}

function entity(
  id: string,
  entitySource: GraphSourceVersion,
  overrides: Partial<GraphEntity> = {},
): GraphEntity {
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
    updatedAt: NOW,
    ...overrides,
  };
}

function evidence(
  id: string,
  evidenceSource: GraphSourceVersion,
  quote = evidenceSource.content,
): GraphRelationEvidence {
  const startOffset = evidenceSource.content.indexOf(quote);
  if (startOffset < 0) {
    throw new Error("Test evidence quote is absent from its source.");
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
      label: "Chapter 1",
      locator: `offset:${String(startOffset)}-${String(startOffset + quote.length)}`,
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

function addEntity(index: InMemoryGraphRagIndex, id: string, projectId = "project-1"): GraphEntity {
  const entitySource = source(`source-${id}`, `${id} dossier`, {
    projectId,
    sourceVersionId: `source-${id}-v1`,
    contentHash: fakeSha256(`source-${id}-v1`),
  });
  index.upsertSourceVersion(entitySource);
  const graphEntity = entity(id, entitySource);
  index.upsertEntity(graphEntity);
  return graphEntity;
}

function addEvidenceSource(
  index: InMemoryGraphRagIndex,
  sourceId: string,
  content: string,
  projectId = "project-1",
): GraphSourceVersion {
  const evidenceSource = source(sourceId, content, { projectId });
  index.upsertSourceVersion(evidenceSource);
  return evidenceSource;
}

describe("InMemoryGraphRagIndex", () => {
  it("returns bounded relation-only candidates with exact, attributable evidence", () => {
    const index = new InMemoryGraphRagIndex();
    addEntity(index, "aria");
    addEntity(index, "borin");
    const chapter = addEvidenceSource(
      index,
      "chapter-1",
      "At dawn, Aria entrusted the obsidian key to Borin.",
    );
    index.upsertRelation(
      relation("relation-1", "aria", "borin", evidence("evidence-1", chapter, "obsidian key"), {
        kind: "entrusted_key_to",
        confidence: 0.9,
      }),
    );

    const result = index.query({
      projectId: "project-1",
      seedEntityIds: ["aria"],
    });

    expect(result.entities.map(({ entity: item }) => item.id)).toEqual(["aria", "borin"]);
    expect(result.relationCandidates).toHaveLength(1);
    expect(result.relationCandidates[0]).toMatchObject({
      fromEntityId: "aria",
      toEntityId: "borin",
      kind: "entrusted_key_to",
      relationScore: 0.9,
      conflict: { detected: false, polarities: ["affirmed"] },
      explanation: {
        scoreSource: "relation",
        reachedEntityId: "borin",
        duplicateRelationsCollapsed: 0,
      },
      assertions: [
        {
          relationIds: ["relation-1"],
          evidence: [
            {
              sourceVersionId: "chapter-1-v1",
              contentHash: fakeSha256("chapter-1-v1"),
              quote: "obsidian key",
              spanHash: graphEvidenceSpanHash("obsidian key"),
              citation: {
                label: "Chapter 1",
              },
            },
          ],
        },
      ],
    });
    expect(result.fusionCandidates).toEqual([
      expect.objectContaining({
        entityId: "borin",
        documentId: "document-borin",
        relationScore: 0.9,
        explanation: expect.objectContaining({ scoreSource: "relation", depth: 1 }),
      }),
    ]);
    expect(result.capabilities.embeddingContribution).toBe("not_used");
  });

  it("fails closed for missing, forged, or cross-project evidence", () => {
    const index = new InMemoryGraphRagIndex();
    addEntity(index, "aria");
    addEntity(index, "borin");
    const chapter = addEvidenceSource(index, "chapter-1", "Aria met Borin.");

    expect(() =>
      index.upsertRelation({
        ...relation("missing", "aria", "borin", evidence("unused", chapter)),
        evidence: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GRAPH_RELATION" }));
    expect(() =>
      index.upsertRelation(
        relation("forged", "aria", "borin", {
          ...evidence("forged-evidence", chapter, "Aria"),
          spanHash: graphEvidenceSpanHash("different text"),
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GRAPH_EVIDENCE" }));

    const foreign = source("foreign", "Aria met Borin.", {
      projectId: "project-2",
      sourceVersionId: "foreign-v1",
      contentHash: fakeSha256("foreign-v1"),
    });
    index.upsertSourceVersion(foreign);
    expect(() =>
      index.upsertRelation(
        relation("cross-project", "aria", "borin", {
          ...evidence("foreign-evidence", foreign),
          projectId: "project-1",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GRAPH_EVIDENCE" }));
  });

  it("does not distinguish a foreign seed from a missing seed", () => {
    const index = new InMemoryGraphRagIndex();
    addEntity(index, "private-entity", "project-2");

    const foreign = () =>
      index.query({ projectId: "project-1", seedEntityIds: ["private-entity"] });
    const missing = () => index.query({ projectId: "project-1", seedEntityIds: ["missing"] });

    expect(foreign).toThrowError(
      expect.objectContaining({
        code: "GRAPH_SEED_NOT_FOUND",
        message: "One or more graph seeds are unavailable in the requested project.",
      }),
    );
    expect(missing).toThrowError(
      expect.objectContaining({
        code: "GRAPH_SEED_NOT_FOUND",
        message: "One or more graph seeds are unavailable in the requested project.",
      }),
    );
  });

  it("prevents cycles and reports a reached depth bound", () => {
    const index = new InMemoryGraphRagIndex();
    for (const id of ["a", "b", "c", "d"]) {
      addEntity(index, id);
    }
    const chapter = addEvidenceSource(index, "chapter-cycle", "cycle evidence");
    index.upsertRelation(relation("ab", "a", "b", evidence("e-ab", chapter)));
    index.upsertRelation(relation("bc", "b", "c", evidence("e-bc", chapter)));
    index.upsertRelation(relation("ca", "c", "a", evidence("e-ca", chapter)));
    index.upsertRelation(relation("cd", "c", "d", evidence("e-cd", chapter)));

    const result = index.query({
      projectId: "project-1",
      seedEntityIds: ["a"],
      direction: "outgoing",
      limits: { maxDepth: 2 },
    });

    expect(result.entities.map(({ entity: item }) => item.id)).toEqual(["a", "b", "c"]);
    expect(result.relationCandidates.map(({ candidateId }) => candidateId)).toHaveLength(2);
    expect(new Set(result.entities.map(({ entity: item }) => item.id)).size).toBe(3);
    expect(result.limits.depthLimitReached).toBe(true);
    expect(result.notices).toContain("graph_depth_limit_reached");
  });

  it("enforces node and edge limits without nondeterministic partial expansion", () => {
    const index = new InMemoryGraphRagIndex();
    for (const id of ["seed", "high", "middle", "low"]) {
      addEntity(index, id);
    }
    const chapter = addEvidenceSource(index, "chapter-limits", "bounded traversal evidence");
    index.upsertRelation(
      relation("low-edge", "seed", "low", evidence("low-evidence", chapter), {
        confidence: 0.2,
      }),
    );
    index.upsertRelation(
      relation("high-edge", "seed", "high", evidence("high-evidence", chapter), {
        confidence: 0.9,
      }),
    );
    index.upsertRelation(
      relation("middle-edge", "seed", "middle", evidence("middle-evidence", chapter), {
        confidence: 0.5,
      }),
    );

    const nodeBound = index.query({
      projectId: "project-1",
      seedEntityIds: ["seed"],
      direction: "outgoing",
      limits: { maxNodes: 2 },
    });
    const edgeBound = index.query({
      projectId: "project-1",
      seedEntityIds: ["seed"],
      direction: "outgoing",
      limits: { maxEdges: 1 },
    });

    expect(nodeBound.entities.map(({ entity: item }) => item.id)).toEqual(["seed", "high"]);
    expect(nodeBound.limits.nodeLimitReached).toBe(true);
    expect(edgeBound.entities.map(({ entity: item }) => item.id)).toEqual(["seed", "high"]);
    expect(edgeBound.limits.edgeLimitReached).toBe(true);
  });

  it("is stable across insertion order", () => {
    function build(reverse: boolean): InMemoryGraphRagIndex {
      const index = new InMemoryGraphRagIndex();
      for (const id of reverse ? ["c", "b", "a"] : ["a", "b", "c"]) {
        addEntity(index, id);
      }
      const chapter = addEvidenceSource(index, "chapter-stable", "stable evidence");
      const relations = [
        relation("ac", "a", "c", evidence("e-ac", chapter), { confidence: 0.7 }),
        relation("ab", "a", "b", evidence("e-ab", chapter), { confidence: 0.7 }),
      ];
      for (const item of reverse ? relations.reverse() : relations) {
        index.upsertRelation(item);
      }
      return index;
    }

    const request = {
      projectId: "project-1",
      seedEntityIds: ["a"],
      direction: "outgoing" as const,
    };
    expect(build(false).query(request)).toEqual(build(true).query(request));
  });

  it("propagates source-version invalidation and reports a truthful degraded fallback", () => {
    const index = new InMemoryGraphRagIndex();
    addEntity(index, "aria");
    addEntity(index, "borin");
    const firstVersion = addEvidenceSource(index, "chapter-versioned", "Aria knows Borin.");
    index.upsertRelation(
      relation("relation-v1", "aria", "borin", evidence("evidence-v1", firstVersion)),
    );
    expect(
      index.query({ projectId: "project-1", seedEntityIds: ["aria"] }).relationCandidates,
    ).toHaveLength(1);

    index.upsertSourceVersion(
      source("chapter-versioned", "Aria no longer knows Borin.", {
        sourceVersionId: "chapter-versioned-v2",
        contentHash: fakeSha256("chapter-versioned-v2"),
        createdAt: LATER,
      }),
    );
    const result = index.query({ projectId: "project-1", seedEntityIds: ["aria"] });

    expect(result.relationCandidates).toEqual([]);
    expect(result.capabilities.relation).toBe("degraded");
    expect(result.notices).toContain("graph_stale_or_missing_evidence_filtered");
  });

  it("propagates entity soft deletion to incident relations", () => {
    const index = new InMemoryGraphRagIndex();
    addEntity(index, "aria");
    addEntity(index, "borin");
    const chapter = addEvidenceSource(index, "chapter-delete", "Aria knows Borin.");
    index.upsertRelation(relation("relation-1", "aria", "borin", evidence("evidence-1", chapter)));

    index.softDeleteEntity("project-1", "borin", LATER);
    const result = index.query({ projectId: "project-1", seedEntityIds: ["aria"] });

    expect(result.entities.map(({ entity: item }) => item.id)).toEqual(["aria"]);
    expect(result.relationCandidates).toEqual([]);
    expect(result.notices).toContain("graph_stale_or_deleted_entities_filtered");
  });

  it("deduplicates equivalent edges while retaining explicit conflicting assertions", () => {
    const index = new InMemoryGraphRagIndex();
    addEntity(index, "aria");
    addEntity(index, "borin");
    const chapter = addEvidenceSource(
      index,
      "chapter-conflict",
      "One witness says Aria knows Borin; another denies it.",
    );
    index.upsertRelation(
      relation("affirmed-b", "aria", "borin", evidence("affirmed-evidence", chapter, "knows"), {
        confidence: 0.7,
      }),
    );
    index.upsertRelation(
      relation(
        "affirmed-a",
        "aria",
        "borin",
        evidence("affirmed-evidence-duplicate", chapter, "knows"),
        {
          confidence: 0.8,
        },
      ),
    );
    index.upsertRelation(
      relation("negated", "aria", "borin", evidence("negated-evidence", chapter, "denies"), {
        polarity: "negated",
        confidence: 0.6,
      }),
    );

    const result = index.query({ projectId: "project-1", seedEntityIds: ["aria"] });
    const candidate = result.relationCandidates[0];

    expect(result.relationCandidates).toHaveLength(1);
    expect(candidate?.conflict).toEqual({
      detected: true,
      polarities: ["affirmed", "negated"],
    });
    expect(candidate?.assertions).toEqual([
      expect.objectContaining({
        polarity: "affirmed",
        relationIds: ["affirmed-a", "affirmed-b"],
        confidence: 0.8,
        evidence: [expect.objectContaining({ id: "affirmed-evidence" })],
      }),
      expect.objectContaining({
        polarity: "negated",
        relationIds: ["negated"],
      }),
    ]);
    expect(candidate?.explanation.duplicateRelationsCollapsed).toBe(1);
  });

  it("filters relation kinds and traversal direction without broadening the graph", () => {
    const index = new InMemoryGraphRagIndex();
    for (const id of ["a", "b", "c"]) {
      addEntity(index, id);
    }
    const chapter = addEvidenceSource(index, "chapter-filter", "filter evidence");
    index.upsertRelation(
      relation("incoming", "b", "a", evidence("incoming-evidence", chapter), {
        kind: "enemy_of",
      }),
    );
    index.upsertRelation(
      relation("outgoing", "a", "c", evidence("outgoing-evidence", chapter), {
        kind: "ally_of",
      }),
    );

    const result = index.query({
      projectId: "project-1",
      seedEntityIds: ["a"],
      direction: "incoming",
      relationKinds: ["enemy_of"],
    });

    expect(result.entities.map(({ entity: item }) => item.id)).toEqual(["a", "b"]);
    expect(result.relationCandidates.map(({ kind }) => kind)).toEqual(["enemy_of"]);
  });

  it("keeps formal source versions immutable", () => {
    const index = new InMemoryGraphRagIndex();
    const original = source("chapter-immutable", "original");
    index.upsertSourceVersion(original);

    expect(() =>
      index.upsertSourceVersion({
        ...original,
        content: "mutated",
      }),
    ).toThrowError(expect.objectContaining({ code: "GRAPH_VERSION_CONFLICT" }));
  });

  it("rejects ill-formed UTF-16 graph source content", () => {
    const index = new InMemoryGraphRagIndex();

    expect(() =>
      index.upsertSourceVersion(source("chapter-lone-surrogate", "before\ud800after")),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GRAPH_SOURCE" }));
  });

  it("rejects evidence spans that split a surrogate pair", () => {
    const index = new InMemoryGraphRagIndex();
    addEntity(index, "aria");
    addEntity(index, "borin");
    const chapter = addEvidenceSource(index, "chapter-emoji-boundary", "A😀B");
    const splitPairEvidence: GraphRelationEvidence = {
      ...evidence("emoji-split", chapter, "😀"),
      span: {
        startOffset: 1,
        endOffset: 2,
        encoding: "utf16",
      },
      quote: "\ud83d",
      spanHash: graphEvidenceSpanHash("\ud83d"),
    };

    expect(() =>
      index.upsertRelation(relation("emoji-split-relation", "aria", "borin", splitPairEvidence)),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GRAPH_EVIDENCE" }));
  });

  it("does not resurrect an older source version or accept out-of-order replacement", () => {
    const index = new InMemoryGraphRagIndex();
    const first = source("chapter-monotonic", "first");
    const second = source("chapter-monotonic", "second", {
      sourceVersionId: "chapter-monotonic-v2",
      contentHash: fakeSha256("chapter-monotonic-v2"),
      createdAt: LATER,
    });
    index.upsertSourceVersion(first);
    index.upsertSourceVersion(second);

    expect(() => index.upsertSourceVersion(first)).toThrowError(
      expect.objectContaining({ code: "GRAPH_VERSION_CONFLICT" }),
    );
    expect(() =>
      index.upsertSourceVersion(
        source("chapter-monotonic", "out-of-order", {
          sourceVersionId: "chapter-monotonic-v3",
          contentHash: fakeSha256("chapter-monotonic-v3"),
          createdAt: NOW,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "GRAPH_VERSION_CONFLICT" }));
  });

  it("keeps relation identifiers immutable and deletion timestamps monotonic", () => {
    const index = new InMemoryGraphRagIndex();
    addEntity(index, "aria");
    addEntity(index, "borin");
    const chapter = addEvidenceSource(index, "chapter-relation-authority", "Aria knows Borin.");
    const original = relation(
      "relation-authority",
      "aria",
      "borin",
      evidence("evidence-authority", chapter),
    );
    index.upsertRelation(original);

    expect(() =>
      index.upsertRelation({
        ...original,
        kind: "enemy_of",
      }),
    ).toThrowError(expect.objectContaining({ code: "GRAPH_VERSION_CONFLICT" }));
    expect(() =>
      index.softDeleteRelation("project-1", "relation-authority", "2026-07-27T23:59:59.999Z"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_GRAPH_RELATION" }));
  });
});
