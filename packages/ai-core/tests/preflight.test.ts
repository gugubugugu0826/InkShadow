import { describe, expect, it } from "vitest";

import {
  GenerationPreflightInputError,
  runGenerationPreflight,
  type GenerationPreflightInput,
} from "../src/preflight.js";

const baseInput: GenerationPreflightInput = {
  now: "2026-07-27T00:00:00.000Z",
  migrationReady: true,
  chapterExists: true,
  chapterSaved: true,
  projectWritable: true,
  gatewayAvailable: true,
  networkAvailable: true,
  providerLocation: "remote",
  profileConfigured: true,
  modelSelected: true,
  credentialConfigured: true,
  connectionStatus: "verified",
  selectedModelAvailable: true,
  inputBytes: 12_000,
  maximumInputBytes: 1_000_000,
  inputTokens: 4_000,
  maximumOutputTokens: 2_000,
  contextWindowTokens: 16_000,
  pricing: {
    currency: "USD",
    pricingVersion: "2026-07",
    updatedAt: "2026-07-20T00:00:00.000Z",
    inputMicrosPerMillionTokens: 1_000_000n,
    outputMicrosPerMillionTokens: 2_000_000n,
  },
  budgets: [],
};

describe("runGenerationPreflight", () => {
  it("returns a deterministic ready snapshot with a source-backed estimate", () => {
    const snapshot = runGenerationPreflight(baseInput);

    expect(snapshot.canStart).toBe(true);
    expect(snapshot.requiresConfirmation).toBe(false);
    expect(snapshot.checks).toEqual([
      {
        code: "READY",
        severity: "notice",
        action: "CONTINUE",
        scope: "model",
      },
    ]);
    expect(snapshot.estimate).toMatchObject({
      currency: "USD",
      micros: 8_000n,
      pricingVersion: "2026-07",
      priceUpdatedAt: "2026-07-20T00:00:00.000Z",
    });
  });

  it("orders all blocking checks independently of UI rendering", () => {
    const snapshot = runGenerationPreflight({
      ...baseInput,
      migrationReady: false,
      chapterExists: false,
      chapterSaved: false,
      projectWritable: false,
      gatewayAvailable: false,
      networkAvailable: false,
      profileConfigured: false,
      modelSelected: false,
      pricing: null,
      inputBytes: 1_000_001,
      contextWindowTokens: 5_000,
    });

    expect(snapshot.canStart).toBe(false);
    expect(snapshot.checks.map(({ code }) => code)).toEqual([
      "MIGRATION_REQUIRED",
      "CHAPTER_NOT_FOUND",
      "PROJECT_READONLY",
      "MODEL_GATEWAY_UNAVAILABLE",
      "NETWORK_OFFLINE",
      "MODEL_PROFILE_MISSING",
      "MODEL_PRICING_MISSING",
      "INPUT_TOO_LARGE",
      "CONTEXT_WINDOW_EXCEEDED",
    ]);
  });

  it("warns at 80 percent and blocks only hard budget overruns", () => {
    const warning = runGenerationPreflight({
      ...baseInput,
      budgets: [
        {
          scope: "project",
          limitMicros: 10_000n,
          spentMicros: 0n,
          enforcement: "hard",
        },
      ],
    });
    expect(warning.canStart).toBe(true);
    expect(warning.requiresConfirmation).toBe(true);
    expect(warning.checks.map(({ code }) => code)).toContain("BUDGET_WARNING");

    const blocked = runGenerationPreflight({
      ...baseInput,
      budgets: [
        {
          scope: "month",
          limitMicros: 7_999n,
          spentMicros: 0n,
          enforcement: "hard",
        },
      ],
    });
    expect(blocked.canStart).toBe(false);
    expect(blocked.checks.map(({ code }) => code)).toContain("BUDGET_EXCEEDED");
  });

  it("requires confirmation for stale prices and near-full contexts", () => {
    const pricing = baseInput.pricing;
    if (pricing === null) {
      throw new Error("Expected base pricing.");
    }
    const snapshot = runGenerationPreflight({
      ...baseInput,
      now: "2026-07-27T00:00:00.000Z",
      pricing: {
        ...pricing,
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      contextWindowTokens: 6_500,
    });

    expect(snapshot.canStart).toBe(true);
    expect(snapshot.requiresConfirmation).toBe(true);
    expect(snapshot.checks.map(({ code }) => code)).toEqual([
      "MODEL_PRICING_STALE",
      "CONTEXT_WINDOW_NEAR_LIMIT",
    ]);
  });

  it("blocks missing credentials, failed discovery, and unavailable selected models", () => {
    expect(
      runGenerationPreflight({
        ...baseInput,
        credentialConfigured: false,
      }).checks.map(({ code }) => code),
    ).toContain("MODEL_CREDENTIAL_MISSING");
    expect(
      runGenerationPreflight({
        ...baseInput,
        connectionStatus: "failed",
      }).checks.map(({ code }) => code),
    ).toContain("MODEL_CONNECTION_FAILED");
    expect(
      runGenerationPreflight({
        ...baseInput,
        selectedModelAvailable: false,
      }).checks.map(({ code }) => code),
    ).toContain("SELECTED_MODEL_UNAVAILABLE");
  });

  it("treats a local demo as explicitly zero cost without a provider profile", () => {
    const snapshot = runGenerationPreflight({
      ...baseInput,
      providerLocation: "demo",
      gatewayAvailable: false,
      networkAvailable: false,
      profileConfigured: false,
      modelSelected: false,
      pricing: null,
      contextWindowTokens: null,
    });

    expect(snapshot.canStart).toBe(true);
    expect(snapshot.estimate).toMatchObject({
      micros: 0n,
      pricingVersion: "local-demo-zero-cost",
    });
    expect(snapshot.checks.map(({ code }) => code)).toEqual(["READY"]);
  });

  it("rejects malformed numeric inputs before producing a snapshot", () => {
    expect(() =>
      runGenerationPreflight({
        ...baseInput,
        inputTokens: -1,
      }),
    ).toThrow(GenerationPreflightInputError);
  });
});
