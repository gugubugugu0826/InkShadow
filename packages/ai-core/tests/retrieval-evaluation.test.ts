import { describe, expect, it } from "vitest";

import { evaluateRetrievalRanking } from "../src/retrieval-evaluation.js";
import type { RetrievalEvaluationError } from "../src/retrieval-evaluation.js";
import { rerankWithLocalEvidence, type EvidenceRerankCandidate } from "../src/evidence-rerank.js";

describe("retrieval ranking evaluation", () => {
  it("quantifies recall, precision, MRR, nDCG, authority, contamination, and leakage", () => {
    const result = evaluateRetrievalRanking({
      rankedIds: ["noise", "relevant-a", "stale", "relevant-b", "private"],
      relevantIds: ["relevant-a", "relevant-b", "missing"],
      authoritativeIds: ["relevant-a", "relevant-b"],
      staleIds: ["stale"],
      rejectedCandidateIds: ["noise"],
      privateIds: ["private"],
      limit: 5,
    });

    expect(result).toEqual({
      evaluatedAtK: 5,
      returnedCount: 5,
      relevantCount: 3,
      relevantReturnedCount: 2,
      recallAtK: 0.666667,
      precisionAtK: 0.4,
      meanReciprocalRank: 0.5,
      normalizedDiscountedCumulativeGain: 0.498189,
      hitRate: 1,
      authorityPrecision: 0.4,
      staleHitRate: 0.2,
      rejectedCandidateContaminationRate: 0.2,
      privateLeakageCount: 1,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("provides fixed evidence that local rerank improves MRR and nDCG over raw FTS order", () => {
    const candidates = [
      candidate("noise", "天气晴朗。", 0.9),
      candidate("partial", "林晚拿起钥匙。", 0.8),
      candidate("answer", "林晚用铜钥匙打开北塔。", 0.45),
    ];
    const raw = evaluateRetrievalRanking({
      rankedIds: candidates.map(({ id }) => id),
      relevantIds: ["answer"],
      limit: 3,
    });
    const rerankedIds = rerankWithLocalEvidence({
      query: "林晚 铜钥匙 北塔",
      candidates,
      limit: 3,
    }).ranked.map(({ candidate: item }) => item.id);
    const reranked = evaluateRetrievalRanking({
      rankedIds: rerankedIds,
      relevantIds: ["answer"],
      limit: 3,
    });

    expect(rerankedIds[0]).toBe("answer");
    expect(reranked.meanReciprocalRank).toBeGreaterThan(raw.meanReciprocalRank);
    expect(reranked.normalizedDiscountedCumulativeGain).toBeGreaterThan(
      raw.normalizedDiscountedCumulativeGain,
    );
    expect(reranked.recallAtK).toBe(raw.recallAtK);
  });

  it("bounds K and identities and rejects duplicate ranks", () => {
    expect(() =>
      evaluateRetrievalRanking({ rankedIds: ["same", "same"], relevantIds: ["same"], limit: 2 }),
    ).toThrow(
      expect.objectContaining<Partial<RetrievalEvaluationError>>({
        code: "RETRIEVAL_EVALUATION_DUPLICATE_RANK",
      }),
    );
    expect(() => evaluateRetrievalRanking({ rankedIds: [], relevantIds: [], limit: 0 })).toThrow(
      expect.objectContaining<Partial<RetrievalEvaluationError>>({
        code: "RETRIEVAL_EVALUATION_LIMIT_INVALID",
      }),
    );
    expect(() =>
      evaluateRetrievalRanking({ rankedIds: ["bad\nidentity"], relevantIds: [], limit: 1 }),
    ).toThrow(
      expect.objectContaining<Partial<RetrievalEvaluationError>>({
        code: "RETRIEVAL_EVALUATION_INPUT_INVALID",
      }),
    );
  });
});

function candidate(id: string, text: string, retrievalScore: number): EvidenceRerankCandidate {
  return {
    id,
    text,
    retrievalScore,
    evidence: {
      sourceType: "chapter",
      sourceId: `source-${id}`,
      sourceVersionId: `version-${id}`,
      locator: `chapter:${id}#0-${String(text.length)}`,
      contentHash:
        id.codePointAt(0)?.toString(16).padStart(2, "0").repeat(32).slice(0, 64) ?? "a".repeat(64),
    },
  };
}
