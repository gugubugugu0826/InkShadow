import { describe, expect, it } from "vitest";

import {
  LOCAL_EVIDENCE_RERANK_ALGORITHM,
  LOCAL_EVIDENCE_RERANK_WEIGHTS,
  REMOTE_MODEL_RERANK_ADAPTER_STATUS,
  rerankWithLocalEvidence,
  type EvidenceRerankCandidate,
} from "../src/evidence-rerank.js";

describe("local evidence rerank", () => {
  it("combines term coverage, phrase match, retrieval, importance, and pinning explainably", () => {
    const exactPhrase = candidate("exact", "雨夜 列车在站台停下。", 0.4);
    const highRetrieval = candidate("retrieval", "雨夜里，那列车终于到站。", 0.9);
    const governed = candidate("governed", "与查询没有关系的档案。", 0.8, {
      importance: 1,
      pinned: true,
    });

    const result = rerankWithLocalEvidence({
      query: "雨夜 列车",
      candidates: [governed, highRetrieval, exactPhrase],
      limit: 3,
    });

    expect(result.ranked.map(({ candidate }) => candidate.id)).toEqual([
      "exact",
      "retrieval",
      "governed",
    ]);
    expect(result.ranked[0]).toMatchObject({
      rank: 1,
      matchedTerms: ["雨夜", "列车"],
      scores: {
        termCoverage: 1,
        phraseMatch: 1,
        retrievalScore: 0.4,
        importance: 0,
        pinnedBoost: 0,
        governance: 0,
        weighted: {
          termCoverage: 0.35,
          phraseMatch: 0.25,
          retrievalScore: 0.1,
          governance: 0,
        },
        total: 0.7,
      },
    });
    expect(result.ranked[0]?.selectionReason).toContain("Matched 2/2 query terms");
    expect(result.ranked[0]?.selectionReason).toContain("exact normalized phrase matched");
    expect(result.ranked[2]?.scores.governance).toBe(1);
    expect(result.ranked[2]?.selectionReason).toContain("user-pinned");
  });

  it("returns the original versioned evidence without rewriting it", () => {
    const original = candidate("evidenced", "城门在日落之后关闭。", 0.6);
    const result = rerankWithLocalEvidence({
      query: "城门关闭",
      candidates: [original],
    });

    expect(result.ranked[0]?.candidate.evidence).toEqual(original.evidence);
    expect(result.ranked[0]?.candidate.evidence).not.toBe(original.evidence);
    expect(Object.isFrozen(result.ranked[0]?.candidate.evidence)).toBe(true);
    expect(result).toMatchObject({
      algorithm: LOCAL_EVIDENCE_RERANK_ALGORITHM,
      execution: "local_deterministic",
      remoteModelAdapter: "delegated_to_runtime",
      evaluatedCandidateCount: 1,
      returnedCandidateCount: 1,
      omittedCandidateIds: [],
    });
  });

  it("uses an identifier tie-break that is stable across input order", () => {
    const alpha = candidate("alpha", "同样的命中内容。", 0.5);
    const beta = candidate("beta", "同样的命中内容。", 0.5);

    const first = rerankWithLocalEvidence({
      query: "命中内容",
      candidates: [beta, alpha],
    });
    const second = rerankWithLocalEvidence({
      query: "命中内容",
      candidates: [alpha, beta],
    });

    expect(first.ranked.map(({ candidate }) => candidate.id)).toEqual(["alpha", "beta"]);
    expect(second.ranked.map(({ candidate }) => candidate.id)).toEqual(["alpha", "beta"]);
    expect(first.ranked.map(({ scores }) => scores.total)).toEqual(
      second.ranked.map(({ scores }) => scores.total),
    );
  });

  it("applies the result limit after stable scoring and audits omitted candidates", () => {
    const result = rerankWithLocalEvidence({
      query: "钥匙",
      candidates: [
        candidate("third", "钥匙在桌上。", 0.3),
        candidate("first", "钥匙在桌上。", 0.9),
        candidate("second", "钥匙在桌上。", 0.6),
      ],
      limit: 2,
    });

    expect(result.ranked.map(({ candidate }) => candidate.id)).toEqual(["first", "second"]);
    expect(result.omittedCandidateIds).toEqual(["third"]);
    expect(result).toMatchObject({ evaluatedCandidateCount: 3, returnedCandidateCount: 2 });
  });

  it("fails the entire rerank when any candidate lacks complete evidence", () => {
    const valid = candidate("valid", "有效候选。", 0.8);
    const missingVersion = {
      ...candidate("missing-version", "缺少来源版本。", 0.9),
      evidence: {
        sourceType: "chapter",
        sourceId: "chapter-2",
        locator: "chapter:2#0-6",
        contentHash: hash("b"),
      },
    } as unknown as EvidenceRerankCandidate;

    expect(() =>
      rerankWithLocalEvidence({
        query: "候选",
        candidates: [valid, missingVersion],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "RERANK_EVIDENCE_REQUIRED",
      }),
    );
  });

  it("rejects forged hashes, unsafe locators, duplicate ids, and invalid scores", () => {
    const forgedHash = {
      ...candidate("forged", "伪造哈希。", 0.5),
      evidence: {
        ...candidate("forged-source", "来源。", 0.5).evidence,
        contentHash: "not-a-sha256",
      },
    };
    const unsafeLocator = {
      ...candidate("unsafe-locator", "危险定位。", 0.5),
      evidence: {
        ...candidate("unsafe-source", "来源。", 0.5).evidence,
        locator: "chapter:1\u0001span",
      },
    };

    expect(() => rerankWithLocalEvidence({ query: "哈希", candidates: [forgedHash] })).toThrow(
      expect.objectContaining({ code: "RERANK_EVIDENCE_REQUIRED" }),
    );
    expect(() => rerankWithLocalEvidence({ query: "定位", candidates: [unsafeLocator] })).toThrow(
      expect.objectContaining({ code: "RERANK_EVIDENCE_REQUIRED" }),
    );
    expect(() =>
      rerankWithLocalEvidence({
        query: "重复",
        candidates: [candidate("same", "重复一。", 0.5), candidate("same", "重复二。", 0.5)],
      }),
    ).toThrow(expect.objectContaining({ code: "RERANK_DUPLICATE_CANDIDATE" }));
    expect(() =>
      rerankWithLocalEvidence({
        query: "分数",
        candidates: [{ ...candidate("score", "无效分数。", 0.5), retrievalScore: 1.1 }],
      }),
    ).toThrow(expect.objectContaining({ code: "RERANK_CANDIDATE_INVALID" }));
  });

  it("bounds query, pool, per-candidate, combined content, and result length", () => {
    expect(() =>
      rerankWithLocalEvidence({ query: " ", candidates: [candidate("one", "内容。", 0.5)] }),
    ).toThrow(expect.objectContaining({ code: "RERANK_QUERY_INVALID" }));
    expect(() =>
      rerankWithLocalEvidence({
        query: "查询",
        candidates: Array.from({ length: 513 }, (_, index) =>
          candidate(`candidate-${String(index)}`, "内容。", 0.5),
        ),
      }),
    ).toThrow(expect.objectContaining({ code: "RERANK_CANDIDATE_LIMIT_EXCEEDED" }));
    expect(() =>
      rerankWithLocalEvidence({
        query: "查询",
        candidates: [candidate("too-long", "字".repeat(200_001), 0.5)],
      }),
    ).toThrow(expect.objectContaining({ code: "RERANK_CANDIDATE_INVALID" }));
    expect(() =>
      rerankWithLocalEvidence({
        query: "查询",
        candidates: Array.from({ length: 11 }, (_, index) =>
          candidate(`large-${String(index)}`, "字".repeat(190_000), 0.5),
        ),
      }),
    ).toThrow(expect.objectContaining({ code: "RERANK_CONTENT_LIMIT_EXCEEDED" }));
    expect(() =>
      rerankWithLocalEvidence({
        query: "查询",
        candidates: [candidate("limit", "查询。", 0.5)],
        limit: 101,
      }),
    ).toThrow(expect.objectContaining({ code: "RERANK_LIMIT_INVALID" }));
  });

  it("normalizes text deterministically while preserving the original candidate text", () => {
    const text = "ＡＩ　写作让雨夜更安静。";
    const result = rerankWithLocalEvidence({
      query: "ai 写作",
      candidates: [candidate("normalized", text, 0.4)],
    });

    expect(result.normalizedQuery).toBe("ai 写作");
    expect(result.queryTerms).toEqual(["ai", "写作"]);
    expect(result.ranked[0]?.scores).toMatchObject({ termCoverage: 1, phraseMatch: 1 });
    expect(result.ranked[0]?.candidate.text).toBe(text);
  });

  it("delegates optional provider reranking to the runtime without accepting a model name", () => {
    expect(REMOTE_MODEL_RERANK_ADAPTER_STATUS).toBe("delegated_to_runtime");
    expect(Object.keys(LOCAL_EVIDENCE_RERANK_WEIGHTS)).toEqual([
      "termCoverage",
      "phraseMatch",
      "retrievalScore",
      "governance",
    ]);
    expect(
      Object.values(LOCAL_EVIDENCE_RERANK_WEIGHTS).reduce((total, weight) => total + weight, 0),
    ).toBe(1);
    expect(rerankWithLocalEvidence).toHaveLength(1);
  });

  it("returns deeply immutable ranking output", () => {
    const result = rerankWithLocalEvidence({
      query: "世界规则",
      candidates: [candidate("rule", "这是一条世界规则。", 0.7)],
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.queryTerms)).toBe(true);
    expect(Object.isFrozen(result.ranked)).toBe(true);
    expect(Object.isFrozen(result.ranked[0])).toBe(true);
    expect(Object.isFrozen(result.ranked[0]?.candidate)).toBe(true);
    expect(Object.isFrozen(result.ranked[0]?.scores)).toBe(true);
    expect(Object.isFrozen(result.ranked[0]?.scores.weighted)).toBe(true);
    expect(Object.isFrozen(result.ranked[0]?.matchedTerms)).toBe(true);
  });
});

function candidate(
  id: string,
  text: string,
  retrievalScore: number,
  governance: Readonly<{ importance?: number; pinned?: boolean }> = {},
): EvidenceRerankCandidate {
  return {
    id,
    text,
    retrievalScore,
    ...(governance.importance === undefined ? {} : { importance: governance.importance }),
    ...(governance.pinned === undefined ? {} : { pinned: governance.pinned }),
    evidence: {
      sourceType: "chapter",
      sourceId: `source-${id}`,
      sourceVersionId: `version-${id}`,
      locator: `chapter:${id}#0-${String(text.length)}`,
      contentHash: hash(id.at(0) ?? "a"),
    },
  };
}

function hash(seed: string): string {
  return (
    seed.codePointAt(0)?.toString(16).padStart(2, "0").repeat(32).slice(0, 64) ?? "a".repeat(64)
  );
}
