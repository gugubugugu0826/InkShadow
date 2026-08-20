import { describe, expect, it, vi } from "vitest";

import type { ModelHubStore, ModelProviderConnection } from "./model-hub-store";
import {
  disclosureGrantMatches,
  projectDirectWritingDisclosure,
} from "./direct-writing-disclosure";
import { createDevelopmentRuntime, type PreparedGenerationPlan } from "./runtime";

describe("direct writing disclosure", () => {
  it("does not create remote authority metadata for the local demonstration", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await expect(
      projectDirectWritingDisclosure(runtime, createPlan({ executionMode: "local_demo" })),
    ).resolves.toBeNull();
  });

  it("does not mislabel an exact local Model Hub target as cloud disclosure authority", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const plan = createPlan();
    await expect(
      projectDirectWritingDisclosure(runtime, {
        ...plan,
        modelHubInspection: {
          ...plan.modelHubInspection,
          dataDestination: "local",
        },
      } as PreparedGenerationPlan),
    ).resolves.toBeNull();
  });

  it("binds the grant to the exact provider, model, scope, zero generation retries and cost state", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const findConnection = vi.fn(() => Promise.resolve(createConnection(2)));
    const authority = {
      hasher: runtime.hasher,
      modelHub: { findConnection } as unknown as ModelHubStore,
    };
    const disclosure = await projectDirectWritingDisclosure(authority, createPlan());
    if (disclosure === null) throw new Error("Expected a remote disclosure.");

    expect(disclosure.input).toMatchObject({
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      sentScope: "chapter_and_selected_context",
      callCount: 1,
      retryLimit: 0,
      costStatus: "estimated",
      estimatedCostMicros: "125000",
      currency: "CNY",
      privacyPolicy: "cloud_allowed",
    });
    expect(disclosure.sentScopeLabel).toContain("当前章节");
    expect(JSON.stringify(disclosure.input)).not.toContain("不可持久化的正文");
    expect(
      disclosureGrantMatches(disclosure, {
        ...disclosure.input,
        state: "active",
        revision: 1,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        consumedAt: null,
        revokedAt: null,
      }),
    ).toBe(true);

    const changedRetry = await projectDirectWritingDisclosure(
      {
        hasher: runtime.hasher,
        modelHub: {
          findConnection: vi.fn(() => Promise.resolve(createConnection(3))),
        } as unknown as ModelHubStore,
      },
      createPlan(),
    );
    expect(changedRetry?.input.retryLimit).toBe(0);
    expect(changedRetry?.input.fingerprint).toBe(disclosure.input.fingerprint);

    const planWithChangedEstimate = createPlan();
    const changedEstimate = await projectDirectWritingDisclosure(authority, {
      ...planWithChangedEstimate,
      preflight: {
        ...planWithChangedEstimate.preflight,
        estimate:
          planWithChangedEstimate.preflight.estimate === null
            ? null
            : { ...planWithChangedEstimate.preflight.estimate, micros: 250_000n },
      },
    });
    expect(changedEstimate?.input.fingerprint).not.toBe(disclosure.input.fingerprint);
    expect(changedEstimate?.input.estimatedCostMicros).toBe("250000");
    expect(
      changedEstimate === null
        ? false
        : disclosureGrantMatches(changedEstimate, {
            ...disclosure.input,
            state: "active",
            revision: 1,
            createdAt: "2026-08-18T00:00:00.000Z",
            updatedAt: "2026-08-18T00:00:00.000Z",
            consumedAt: null,
            revokedAt: null,
          }),
    ).toBe(false);
    expect(
      disclosureGrantMatches(disclosure, {
        ...disclosure.input,
        retryLimit: 3,
        state: "active",
        revision: 1,
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:00:00.000Z",
        consumedAt: null,
        revokedAt: null,
      }),
    ).toBe(false);
  });
});

function createPlan(
  overrides: Readonly<{ executionMode?: PreparedGenerationPlan["executionMode"] }> = {},
): PreparedGenerationPlan {
  return {
    executionMode: overrides.executionMode ?? "model_hub",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    legacyGatewayConfig: null,
    modelHubInspection: {
      connectionId: "deepseek",
    },
    contextCompilation: {
      compiled: {
        entries: [
          {
            included: true,
            evidence: [
              {
                sourceType: "current_chapter",
              },
            ],
          },
        ],
      },
    },
    preflight: {
      estimate: {
        micros: 125_000n,
        currency: "CNY",
      },
    },
  } as unknown as PreparedGenerationPlan;
}

function createConnection(retryLimit: number): ModelProviderConnection {
  return {
    id: "deepseek",
    displayName: "DeepSeek",
    enabled: true,
    retryLimit,
  } as unknown as ModelProviderConnection;
}
