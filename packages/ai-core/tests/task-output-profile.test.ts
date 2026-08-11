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
    ).toEqual(["continuation"]);
    expect(TASK_OUTPUT_PROFILE_REGISTRY.chapter_summary).toMatchObject({
      outputKind: "plain_summary",
      truncationPolicy: "fail_without_promotion",
    });
  });
  it("uses a scene-sized standard continuation by default", () => {
    expect(resolveContinuationOutputContract()).toMatchObject({
      profile: "standard",
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
      minimumVisibleCharacters: 2_805,
      targetVisibleCharacters: 3_300,
      maximumVisibleCharacters: 3_795,
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
