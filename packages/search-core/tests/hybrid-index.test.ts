import { describe, expect, it } from "vitest";

import {
  InMemoryHybridSearchIndex,
  SearchIndexError,
  tokenizeForSearch,
  type DocumentEmbedding,
  type SearchDocument,
  type SearchRelation,
} from "../src/index.js";

const NOW = "2026-07-27T00:00:00.000Z";

function document(
  id: string,
  title: string,
  text: string,
  overrides: Partial<SearchDocument> = {},
): SearchDocument {
  return {
    id,
    projectId: "project-1",
    sourceType: "chapter",
    sourceId: `source-${id}`,
    sourceVersionId: `version-${id}`,
    title,
    text,
    contentHash: `hash-${id}`,
    updatedAt: NOW,
    ...overrides,
  };
}

function embedding(
  target: SearchDocument,
  values: readonly number[],
  modelId = "embed-local-v1",
): DocumentEmbedding {
  return {
    documentId: target.id,
    projectId: target.projectId,
    sourceVersionId: target.sourceVersionId,
    contentHash: target.contentHash,
    modelId,
    values,
  };
}

function relation(id: string, fromDocumentId: string, toDocumentId: string): SearchRelation {
  return {
    id,
    projectId: "project-1",
    fromDocumentId,
    toDocumentId,
    kind: "foreshadows",
    weight: 0.8,
    evidence: [{ sourceId: "chapter-1", sourceVersionId: "chapter-version-1" }],
  };
}

describe("Chinese search tokenization", () => {
  it("uses trigrams for continuous Chinese text", () => {
    expect(tokenizeForSearch("星河帝国")).toEqual(["星河帝", "河帝国"]);
  });

  it("keeps one and two character queries for bounded substring fallback", () => {
    expect(tokenizeForSearch("星 河")).toEqual(["星", "河"]);
  });
});

describe("InMemoryHybridSearchIndex", () => {
  it("returns keyword results with transparent source provenance", () => {
    const index = new InMemoryHybridSearchIndex();
    const target = document("chapter-1", "星河序章", "舰队驶入星河帝国边境。");
    index.upsertDocument(target);

    const response = index.search({ projectId: "project-1", query: "星河帝国" });

    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]?.document.id).toBe("chapter-1");
    expect(response.hits[0]?.scores.keyword).toBeGreaterThan(0);
    expect(response.hits[0]?.scores.vector).toBe(0);
    expect(response.hits[0]?.evidence).toMatchObject({
      sourceVersionId: "version-chapter-1",
      contentHash: "hash-chapter-1",
    });
  });

  it("supports exact cosine ranking while keeping score components separate", () => {
    const index = new InMemoryHybridSearchIndex({
      modelId: "embed-local-v1",
      dimension: 3,
    });
    const near = document("near", "近邻", "没有关键词");
    const far = document("far", "远端", "仍然没有关键词");
    index.upsertDocument(near, embedding(near, [1, 0, 0]));
    index.upsertDocument(far, embedding(far, [0, 1, 0]));

    const response = index.search({
      projectId: "project-1",
      query: "不存在的词",
      queryEmbedding: { modelId: "embed-local-v1", values: [1, 0, 0] },
    });

    expect(response.hits[0]?.document.id).toBe("near");
    expect(response.hits[0]?.scores.vector).toBe(1);
    expect(response.hits[0]?.scores.keyword).toBe(0);
  });

  it("falls back visibly when a query embedding is unavailable", () => {
    const index = new InMemoryHybridSearchIndex({
      modelId: "embed-local-v1",
      dimension: 2,
    });
    index.upsertDocument(document("chapter-1", "边境", "星河边境"));

    const response = index.search({ projectId: "project-1", query: "星河" });

    expect(response.hits).toHaveLength(1);
    expect(response.notices).toContain("vector_query_unavailable_keyword_relation_fallback");
    expect(response.capabilities.vector).toBe("ready");
  });

  it("requires a rebuild after the embedding model or dimension changes", () => {
    const target = document("chapter-1", "边境", "星河边境");
    const index = new InMemoryHybridSearchIndex({
      modelId: "embed-local-v1",
      dimension: 2,
    });
    index.upsertDocument(target, embedding(target, [1, 0]));

    const health = index.configureEmbedding({
      modelId: "embed-local-v2",
      dimension: 3,
    });
    const response = index.search({
      projectId: "project-1",
      query: "星河",
      queryEmbedding: { modelId: "embed-local-v2", values: [1, 0, 0] },
    });

    expect(health.vectorStatus).toBe("rebuild_required");
    expect(health.degradedReasons).toContain("embedding_configuration_changed");
    expect(response.hits[0]?.scores.vector).toBe(0);
    expect(response.notices).toContain("vector_query_incompatible_keyword_relation_fallback");
  });

  it("atomically swaps a valid rebuilt project and clears vector degradation", () => {
    const original = document("original", "旧章", "旧内容");
    const replacement = document("replacement", "新章", "新内容");
    const index = new InMemoryHybridSearchIndex({
      modelId: "embed-local-v1",
      dimension: 2,
    });
    index.upsertDocument(original, embedding(original, [1, 0]));
    index.configureEmbedding({ modelId: "embed-local-v2", dimension: 2 });
    const generation = index.health().generation;

    const health = index.rebuildProject(
      {
        projectId: "project-1",
        documents: [replacement],
        embeddings: [embedding(replacement, [0, 1], "embed-local-v2")],
        rebuiltAt: NOW,
      },
      generation,
    );

    expect(health.vectorStatus).toBe("ready");
    expect(health.lastRebuiltAt).toBe(NOW);
    expect(index.search({ projectId: "project-1", query: "旧内容" }).hits).toHaveLength(0);
    expect(index.search({ projectId: "project-1", query: "新内容" }).hits[0]?.document.id).toBe(
      "replacement",
    );
  });

  it("keeps the previous index intact when a rebuild snapshot is invalid", () => {
    const original = document("original", "旧章", "仍可检索的正文");
    const index = new InMemoryHybridSearchIndex();
    index.upsertDocument(original);
    const before = index.health();

    expect(() =>
      index.rebuildProject(
        {
          projectId: "project-1",
          documents: [document("wrong", "错章", "错误", { projectId: "project-2" })],
          rebuiltAt: NOW,
        },
        before.generation,
      ),
    ).toThrowError(SearchIndexError);

    expect(index.health().generation).toBe(before.generation);
    expect(index.search({ projectId: "project-1", query: "仍可检索" }).hits[0]?.document.id).toBe(
      "original",
    );
  });

  it("rejects stale rebuild commits with a generation CAS", () => {
    const index = new InMemoryHybridSearchIndex();
    const staleGeneration = index.health().generation;
    index.upsertDocument(document("later", "后来", "并发写入"));

    expect(() =>
      index.rebuildProject(
        {
          projectId: "project-1",
          documents: [],
          rebuiltAt: NOW,
        },
        staleGeneration,
      ),
    ).toThrowError(expect.objectContaining({ code: "GENERATION_CONFLICT" }));
  });

  it("propagates deletion to embeddings and relations", () => {
    const first = document("first", "第一章", "星河");
    const second = document("second", "第二章", "边境");
    const index = new InMemoryHybridSearchIndex({
      modelId: "embed-local-v1",
      dimension: 2,
    });
    index.upsertDocument(first, embedding(first, [1, 0]));
    index.upsertDocument(second, embedding(second, [0, 1]));
    index.upsertRelation(relation("relation-1", first.id, second.id));

    const health = index.deleteDocument("project-1", first.id);

    expect(health.documentCount).toBe(1);
    expect(health.embeddingCount).toBe(1);
    expect(health.relationCount).toBe(0);
  });

  it("records an incremental synchronization timestamp without inventing a data mutation", () => {
    const index = new InMemoryHybridSearchIndex();
    index.upsertDocument(document("chapter-1", "章节", "正文"));
    const generation = index.health().generation;

    const health = index.markProjectSynced("project-1", NOW);

    expect(health.lastRebuiltAt).toBe(NOW);
    expect(health.generation).toBe(generation);
  });

  it("uses evidence-backed relations to surface connected documents", () => {
    const seed = document("seed", "线索", "失落王冠");
    const connected = document("connected", "人物", "守门人");
    const unrelated = document("unrelated", "远方", "风暴");
    const index = new InMemoryHybridSearchIndex();
    index.upsertDocument(seed);
    index.upsertDocument(connected);
    index.upsertDocument(unrelated);
    index.upsertRelation(relation("relation-1", seed.id, connected.id));

    const response = index.search({ projectId: "project-1", query: "失落王冠" });
    const connectedHit = response.hits.find((hit) => hit.document.id === connected.id);

    expect(connectedHit?.scores.relation).toBe(0.8);
    expect(connectedHit?.evidence.relationIds).toEqual(["relation-1"]);
    expect(response.hits.some((hit) => hit.document.id === unrelated.id)).toBe(false);
  });

  it("never leaks results across project boundaries", () => {
    const index = new InMemoryHybridSearchIndex();
    index.upsertDocument(document("one", "同名", "相同正文", { projectId: "project-1" }));
    index.upsertDocument(document("two", "同名", "相同正文", { projectId: "project-2" }));

    const response = index.search({ projectId: "project-1", query: "相同正文" });

    expect(response.hits.map((hit) => hit.document.id)).toEqual(["one"]);
  });

  it("can score a persistent keyword index candidate set without admitting other documents", () => {
    const index = new InMemoryHybridSearchIndex();
    index.upsertDocument(document("selected", "命中", "星河帝国"));
    index.upsertDocument(document("excluded", "命中", "星河帝国"));

    const response = index.search({
      projectId: "project-1",
      query: "星河帝国",
      candidateDocumentIds: ["selected"],
    });

    expect(response.hits.map(({ document: hitDocument }) => hitDocument.id)).toEqual(["selected"]);
  });

  it("pauses mutations without preventing safe reads", () => {
    const index = new InMemoryHybridSearchIndex();
    index.upsertDocument(document("one", "现有", "可读取"));
    index.pauseIndexing();

    expect(() => index.upsertDocument(document("two", "新建", "不可写入"))).toThrowError(
      expect.objectContaining({ code: "INDEX_PAUSED" }),
    );
    expect(index.search({ projectId: "project-1", query: "可读取" }).hits).toHaveLength(1);
    expect(index.health().mutationStatus).toBe("paused");
  });

  it("orders equal scores deterministically", () => {
    const index = new InMemoryHybridSearchIndex();
    index.upsertDocument(document("b", "相同", "命中"));
    index.upsertDocument(document("a", "相同", "命中"));

    const ids = index
      .search({ projectId: "project-1", query: "命中" })
      .hits.map((hit) => hit.document.id);

    expect(ids).toEqual(["a", "b"]);
  });

  it("validates embedding provenance instead of accepting stale vectors", () => {
    const target = document("chapter-1", "章节", "正文");
    const index = new InMemoryHybridSearchIndex({
      modelId: "embed-local-v1",
      dimension: 2,
    });

    expect(() =>
      index.upsertDocument(target, {
        ...embedding(target, [1, 0]),
        sourceVersionId: "stale-version",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EMBEDDING" }));
  });
});
