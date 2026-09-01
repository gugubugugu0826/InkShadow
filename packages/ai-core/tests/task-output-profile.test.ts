import { describe, expect, it } from "vitest";

import {
  resolveContinuationOutputContract,
  resolveDynamicContextBudget,
  TASK_OUTPUT_PROFILE_REGISTRY,
  TASK_OUTPUT_PROFILE_TASKS,
} from "../src/index.js";

describe("continuation output contracts", () => {
  it("registers every requested task family without claiming unwired paths", () => {
    expect(Object.keys(TASK_OUTPUT_PROFILE_REGISTRY)).toEqual(TASK_OUTPUT_PROFILE_TASKS);
    expect(
      Object.values(TASK_OUTPUT_PROFILE_REGISTRY)
        .filter(({ implementationStatus }) => implementationStatus === "wired")
        .map(({ task }) => task),
    ).toEqual([
      "book_start",
      "prose_generation",
      "continuation",
      "rewrite",
      "polish",
      "expand",
      "shorten",
      "import_rewrite",
    ]);
    expect(
      Object.values(TASK_OUTPUT_PROFILE_REGISTRY)
        .filter(({ implementationStatus }) => implementationStatus === "wired")
        .every(
          ({ outputKind, thinkingPolicy }) =>
            outputKind === "visible_prose" && thinkingPolicy === "disabled_for_visible_prose",
        ),
    ).toBe(true);
    expect(TASK_OUTPUT_PROFILE_REGISTRY.chapter_summary).toMatchObject({
      outputKind: "plain_summary",
      truncationPolicy: "fail_without_promotion",
    });
  });

  it("keeps story what-if simulation on the strict structured-output contract", () => {
    expect(TASK_OUTPUT_PROFILE_REGISTRY.what_if).toMatchObject({
      outputKind: "structured_data",
      truncationPolicy: "fail_without_promotion",
    });
    expect(TASK_OUTPUT_PROFILE_REGISTRY.what_if.thinkingPolicy as string).toBe(
      "disabled_for_structured_output",
    );
    expect(TASK_OUTPUT_PROFILE_REGISTRY.what_if.thinkingPolicy).not.toBe(
      "disabled_for_visible_prose",
    );
  });
  it("uses a scene-sized standard continuation by default", () => {
    expect(resolveContinuationOutputContract()).toMatchObject({
      profile: "standard",
      advancedTargetVisibleCharacters: null,
      destination: "complete_scene",
      customDestinationInstruction: null,
      minimumVisibleCharacters: 1_800,
      targetVisibleCharacters: 2_200,
      maximumVisibleCharacters: 2_500,
      estimatedVisibleOutputTokens: 2_750,
      requestedMaxOutputTokens: 3_328,
      thinkingPolicy: "disabled_for_visible_prose",
      truncationPolicy: "preserve_partial_candidate",
      continuationPolicy: "resume_without_repetition",
    });
  });

  it("carries a bounded author destination into the continuation contract", () => {
    expect(
      resolveContinuationOutputContract({
        destination: "custom_instruction",
        customDestinationInstruction: " 写到主角发现密信为止。 ",
      }),
    ).toMatchObject({
      destination: "custom_instruction",
      customDestinationInstruction: "写到主角发现密信为止。",
    });
    expect(() => resolveContinuationOutputContract({ destination: "custom_instruction" })).toThrow(
      RangeError,
    );
  });

  it("supports short, long and bounded custom author targets", () => {
    expect(resolveContinuationOutputContract({ profile: "short" })).toMatchObject({
      targetVisibleCharacters: 1_000,
      requestedMaxOutputTokens: 1_792,
    });
    expect(resolveContinuationOutputContract({ profile: "long" })).toMatchObject({
      targetVisibleCharacters: 4_000,
      requestedMaxOutputTokens: 6_144,
    });
    expect(
      resolveContinuationOutputContract({
        profile: "custom",
        customTargetVisibleCharacters: 3_300,
      }),
    ).toMatchObject({
      advancedTargetVisibleCharacters: 3_300,
      minimumVisibleCharacters: 2_640,
      targetVisibleCharacters: 3_300,
      maximumVisibleCharacters: 3_960,
    });
    expect(
      resolveContinuationOutputContract({
        profile: "custom",
        customTargetVisibleCharacters: 200,
      }),
    ).toMatchObject({
      minimumVisibleCharacters: 160,
      targetVisibleCharacters: 200,
      maximumVisibleCharacters: 240,
    });
    expect(
      resolveContinuationOutputContract({
        profile: "custom",
        customTargetVisibleCharacters: 12_000,
      }),
    ).toMatchObject({
      minimumVisibleCharacters: 9_600,
      targetVisibleCharacters: 12_000,
      maximumVisibleCharacters: 14_400,
    });
  });

  it.each(["short", "standard", "long"] as const)(
    "keeps the %s natural-stop profile when an advanced target overrides only the range",
    (profile) => {
      expect(
        resolveContinuationOutputContract({
          profile,
          customTargetVisibleCharacters: 3_300,
        }),
      ).toMatchObject({
        profile,
        advancedTargetVisibleCharacters: 3_300,
        minimumVisibleCharacters: 2_640,
        targetVisibleCharacters: 3_300,
        maximumVisibleCharacters: 3_960,
      });
    },
  );

  it("bounds the observed 5,535-character runaway without shrinking long-form story context", () => {
    const output = resolveContinuationOutputContract({ profile: "long" });
    const context = resolveDynamicContextBudget({
      profile: "long",
      modelContextWindow: 128_000,
      outputReserve: output.requestedMaxOutputTokens,
    });

    expect(output.maximumVisibleCharacters).toBeLessThan(5_535);
    expect(output.requestedMaxOutputTokens).toBeGreaterThan(output.maximumVisibleCharacters);
    expect(context).toMatchObject({
      taskProfileLimit: 64_000,
      effectiveInputBudget: 64_000,
      modelLimitApplied: false,
    });
  });

  it("clamps the computed request to a known provider output limit", () => {
    expect(
      resolveContinuationOutputContract({
        profile: "long",
        providerOutputLimit: 4_096,
      }),
    ).toMatchObject({
      requestedMaxOutputTokensBeforeClamp: 6_144,
      requestedMaxOutputTokens: 4_096,
      providerLimitClamped: true,
    });
  });
});

describe("dynamic context budgets", () => {
  it("uses the standard 32K task ceiling when a long-context model permits it", () => {
    expect(
      resolveDynamicContextBudget({
        profile: "standard",
        modelContextWindow: 1_000_000,
        outputReserve: 3_328,
      }),
    ).toMatchObject({
      taskProfileLimit: 32_000,
      effectiveInputBudget: 32_000,
      modelLimitApplied: false,
      source: "model_limit_and_task_profile",
    });
  });

  it("reserves output and overhead before clamping to a smaller known model", () => {
    expect(
      resolveDynamicContextBudget({
        profile: "standard",
        modelContextWindow: 32_000,
        outputReserve: 3_328,
      }),
    ).toMatchObject({
      effectiveInputBudget: 24_576,
      modelLimitApplied: true,
    });
  });

  it("uses an explicit conservative fallback when model capacity is unknown", () => {
    expect(
      resolveDynamicContextBudget({
        profile: "standard",
        modelContextWindow: null,
        outputReserve: 3_328,
      }),
    ).toMatchObject({
      taskProfileLimit: 32_000,
      effectiveInputBudget: 12_000,
      source: "conservative_unknown_model_fallback",
    });
  });

  it("returns an explicit exhausted budget when output and overhead consume the model window", () => {
    const budget = resolveDynamicContextBudget({
      profile: "standard",
      modelContextWindow: 4_096,
      outputReserve: 3_328,
      systemOverhead: 512,
      safetyMargin: 512,
    });

    expect(budget.effectiveInputBudget).toBe(0);
    expect(budget.budgetStatus).toBe("model_window_exhausted");
    expect(budget.modelLimitApplied).toBe(true);
  });

  it("treats the unknown-model fallback as an already-reserved input budget", () => {
    const budget = resolveDynamicContextBudget({
      profile: "standard",
      modelContextWindow: null,
      outputReserve: 3_328,
      systemOverhead: 2_048,
      safetyMargin: 2_048,
      unknownModelInputBudget: 9_000,
    });

    expect(budget.effectiveInputBudget).toBe(9_000);
    expect(budget.budgetStatus).toBe("available");
  });
});
