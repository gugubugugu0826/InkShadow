import { describe, expect, it } from "vitest";

import {
  CandidateQualityError,
  evaluateCandidateQuality,
  scoreCandidateRepetition,
  type CandidateQualityObservation,
  type CandidateQualityPolicy,
} from "../src/index.js";

const HASH = "d".repeat(64);
const policy: CandidateQualityPolicy = {
  policyId: "chapter.quality",
  version: 1,
  minimumOverallScore: 0.75,
  thresholds: [
    {
      metric: "consistency",
      minimumScore: 0.8,
      weight: 0.4,
      required: true,
      allowedSources: ["model_review", "human_review"],
    },
    {
      metric: "repetition",
      minimumScore: 0.75,
      weight: 0.2,
      required: true,
      allowedSources: ["deterministic_rule"],
    },
    {
      metric: "structure",
      minimumScore: 0.7,
      weight: 0.2,
      required: false,
      allowedSources: ["deterministic_rule", "human_review"],
    },
    {
      metric: "cost",
      minimumScore: 0.8,
      weight: 0.2,
      required: true,
      allowedSources: ["provider_receipt"],
    },
  ],
};

function observation(
  value: Partial<CandidateQualityObservation> &
    Pick<CandidateQualityObservation, "metric" | "score" | "source">,
): CandidateQualityObservation {
  return {
    evidenceIds: [`evidence:${value.metric}`],
    measuredAt: "2026-07-27T03:00:00.000Z",
    ...value,
  };
}

function evaluate(observations: readonly CandidateQualityObservation[]) {
  return evaluateCandidateQuality({
    candidateId: "candidate-1",
    promptTrace: {
      promptId: "chapter.generate",
      promptVersion: 4,
      promptContentHashSha256: HASH,
    },
    observations,
    policy,
  });
}

describe("candidate quality gate", () => {
  it("passes only when every required metric has allowed, sufficient evidence", () => {
    const result = evaluate([
      observation({ metric: "consistency", score: 0.9, source: "model_review" }),
      observation({ metric: "repetition", score: 1, source: "deterministic_rule" }),
      observation({ metric: "structure", score: 0.8, source: "human_review" }),
      observation({ metric: "cost", score: 0.9, source: "provider_receipt" }),
    ]);

    expect(result.outcome).toBe("pass");
    expect(result.overallScore).toBe(0.9);
    expect(result.blockingCodes).toEqual([]);
    expect(result.trace).toEqual({
      policyId: "chapter.quality",
      policyVersion: 1,
      promptId: "chapter.generate",
      promptVersion: 4,
      promptContentHashSha256: HASH,
    });
  });

  it("blocks missing required evidence and rejects disallowed source substitution", () => {
    const result = evaluate([
      observation({
        metric: "consistency",
        score: 1,
        source: "deterministic_rule",
      }),
      observation({ metric: "repetition", score: 1, source: "deterministic_rule" }),
      observation({ metric: "structure", score: 1, source: "human_review" }),
    ]);

    expect(result.outcome).toBe("block");
    expect(result.blockingCodes).toEqual(["quality.consistency.missing", "quality.cost.missing"]);
    expect(result.results.find(({ metric }) => metric === "consistency")).toMatchObject({
      status: "missing",
      source: null,
    });
  });

  it("blocks a required threshold failure even if the weighted average is high", () => {
    const result = evaluate([
      observation({ metric: "consistency", score: 0.79, source: "model_review" }),
      observation({ metric: "repetition", score: 1, source: "deterministic_rule" }),
      observation({ metric: "structure", score: 1, source: "human_review" }),
      observation({ metric: "cost", score: 1, source: "provider_receipt" }),
    ]);

    expect(result.overallScore).toBeGreaterThan(0.9);
    expect(result.outcome).toBe("block");
    expect(result.blockingCodes).toContain("quality.consistency.below_threshold");
  });

  it("warns for missing optional evidence when required and overall gates pass", () => {
    const result = evaluate([
      observation({ metric: "consistency", score: 1, source: "human_review" }),
      observation({ metric: "repetition", score: 1, source: "deterministic_rule" }),
      observation({ metric: "cost", score: 1, source: "provider_receipt" }),
    ]);

    expect(result.outcome).toBe("warn");
    expect(result.warningCodes).toEqual(["quality.structure.missing"]);
  });

  it("detects exact normalized repeated segments deterministically", () => {
    const clean = scoreCandidateRepetition("雨停了很久很久，城门终于打开。新的旅程就此开始。");
    const repeated = scoreCandidateRepetition(
      "雨停了很久很久，城门终于打开。\n雨停了很久很久，城门终于打开。",
    );

    expect(clean.score).toBe(1);
    expect(repeated.score).toBe(0.5);
    expect(repeated.source).toBe("deterministic_rule");
    expect(repeated.evidenceIds).toEqual(["repetition:1"]);
  });

  it("rejects duplicate observations and policy weights that do not sum to one", () => {
    expect(() =>
      evaluate([
        observation({ metric: "consistency", score: 1, source: "human_review" }),
        observation({ metric: "consistency", score: 1, source: "model_review" }),
      ]),
    ).toThrow(expect.objectContaining({ code: "QUALITY_OBSERVATION_DUPLICATE" }));
    expect(() =>
      evaluateCandidateQuality({
        candidateId: "candidate-1",
        promptTrace: {
          promptId: "chapter.generate",
          promptVersion: 1,
          promptContentHashSha256: HASH,
        },
        observations: [],
        policy: {
          ...policy,
          thresholds: policy.thresholds.map((threshold) => ({
            ...threshold,
            weight: 0.1,
          })),
        },
      }),
    ).toThrow(CandidateQualityError);
  });
});
