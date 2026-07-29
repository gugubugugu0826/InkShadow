import { describe, expect, it } from "vitest";

import { BudgetInputError, estimateGenerationCost, evaluateBudget } from "../src/index.js";

const pricing = {
  currency: "USD",
  pricingVersion: "2026-07-27",
  updatedAt: "2026-07-27T00:00:00.000Z",
  inputMicrosPerMillionTokens: 2_000_000n,
  outputMicrosPerMillionTokens: 6_000_000n,
  cachedInputMicrosPerMillionTokens: 500_000n,
} as const;

describe("cost estimates", () => {
  it("uses integer micro-units and separates cached input", () => {
    const estimate = estimateGenerationCost(
      {
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 500,
      },
      pricing,
    );

    expect(estimate.inputMicros).toBe(1_400n);
    expect(estimate.outputMicros).toBe(3_000n);
    expect(estimate.micros).toBe(4_400n);
    expect(estimate.estimated).toBe(true);
  });

  it("rounds fractional micro-units up instead of underestimating", () => {
    const estimate = estimateGenerationCost(
      {
        inputTokens: 1,
        outputTokens: 1,
      },
      {
        ...pricing,
        inputMicrosPerMillionTokens: 1n,
        outputMicrosPerMillionTokens: 1n,
      },
    );

    expect(estimate.micros).toBe(2n);
  });

  it("rejects invalid token accounting", () => {
    expect(() =>
      estimateGenerationCost(
        {
          inputTokens: 10,
          cachedInputTokens: 11,
          outputTokens: 0,
        },
        pricing,
      ),
    ).toThrow(BudgetInputError);
  });
});

describe("budget decisions", () => {
  it("blocks a hard project limit before generation", () => {
    const decision = evaluateBudget(
      {
        currency: "USD",
        micros: 400n,
      },
      [
        {
          scope: "project",
          limitMicros: 1_000n,
          spentMicros: 700n,
          enforcement: "hard",
        },
      ],
    );

    expect(decision.allowed).toBe(false);
    expect(decision.level).toBe("blocked");
    expect(decision.alerts[0]?.scope).toBe("project");
  });

  it("warns at the default eighty percent threshold", () => {
    const decision = evaluateBudget(
      {
        currency: "USD",
        micros: 100n,
      },
      [
        {
          scope: "month",
          limitMicros: 1_000n,
          spentMicros: 700n,
          enforcement: "hard",
        },
      ],
    );

    expect(decision.allowed).toBe(true);
    expect(decision.level).toBe("warning");
  });
});
