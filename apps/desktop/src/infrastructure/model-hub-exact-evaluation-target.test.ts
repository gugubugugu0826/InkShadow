import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import {
  executeModelHubExactEvaluationTarget,
  hashModelHubExactEvaluationExecutionLock,
  inspectModelHubExactEvaluationTarget,
  MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
  MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
  ModelHubExactEvaluationError,
  type InspectModelHubExactEvaluationTargetInput,
  type ModelHubExactEvaluationDependencies,
  type ModelHubExactEvaluationPredispatchReceipt,
} from "./model-hub-exact-evaluation-target";
import type { ModelProviderKind } from "./model-hub-provider-registry";
import {
  BrowserDevelopmentModelHubStore,
  type ModelCatalogEntry,
  type ModelCostPrivacyProfile,
  type ModelHubStore,
} from "./model-hub-store";
import type { NativeModelGatewayClient } from "./runtime";

const NOW = "2026-08-01T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) throw parsedNow.error;
const clock = { now: () => parsedNow.value };
const PRIVATE_FIXTURE = "evaluation fixture content must not appear in the inspection";
const VISIBLE_OUTPUT = "甲😀𠮷";

describe("Model Hub exact evaluation target", () => {
  it("ignores task routes and fallback, locks the exact target, and calls the provider once", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "exact-connection",
      catalogEntryId: "exact-catalog",
      modelId: "exact-model",
    });
    const routedPrimary = await seedTarget(harness.modelHub, {
      connectionId: "route-primary",
      catalogEntryId: "route-primary-catalog",
      modelId: "route-primary-model",
    });
    const routedFallback = await seedTarget(harness.modelHub, {
      connectionId: "route-fallback",
      catalogEntryId: "route-fallback-catalog",
      modelId: "route-fallback-model",
    });
    await harness.modelHub.saveTaskRoute({
      task: "prose_generation",
      primaryCatalogEntryId: routedPrimary.id,
      fallbackCatalogEntryId: routedFallback.id,
      parameterPolicy: { maximumOutputTokens: 1 },
      maximumCostMicros: "1",
      currency: "USD",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "use_fallback",
      routeOrigin: "user",
      expectedRevision: null,
    });
    const findRoute = vi.spyOn(harness.modelHub, "findTaskRoute");
    const saveRoute = vi.spyOn(harness.modelHub, "saveTaskRoute");
    const deleteRoute = vi.spyOn(harness.modelHub, "deleteTaskRoute");
    const input = request(exact);

    const inspection = await inspectModelHubExactEvaluationTarget(harness.dependencies, input);
    const exactConnection = await harness.modelHub.findConnection("exact-connection");
    if (exactConnection === null) throw new Error("exact connection missing");

    expect(inspection.target).toMatchObject({
      connectionId: "exact-connection",
      catalogEntryId: "exact-catalog",
      providerKind: "custom_openai_compatible",
      modelId: "exact-model",
      connectionRevision: exactConnection.revision,
      catalogRevision: 1,
      costPrivacyRevision: 1,
    });
    expect(inspection.target.targetIdentityHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection.target.capabilityEvidenceHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection.target.costProfileHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection.requestProfileHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection.executionLockHash).toBe(
      await hashModelHubExactEvaluationExecutionLock({
        targetIdentityHash: inspection.target.targetIdentityHash,
        requestProfileHash: inspection.requestProfileHash,
        payloadHash: inspection.payloadHash,
        currency: inspection.pricing.currency,
        estimatedMaximumCostMicros: inspection.pricing.estimatedMaximumCostMicros,
      }),
    );
    expect(JSON.stringify(inspection)).not.toContain(PRIVATE_FIXTURE);

    harness.generate.mockResolvedValue({
      text: VISIBLE_OUTPUT,
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
      streamed: true,
    });
    const reserveAndBindBeforeDispatch = vi.fn(
      (receipt: ModelHubExactEvaluationPredispatchReceipt) => {
        void receipt;
        return Promise.resolve();
      },
    );
    const markDispatchStarted = vi.fn((receipt: ModelHubExactEvaluationPredispatchReceipt) => {
      void receipt;
      return Promise.resolve();
    });
    const finalLatch = vi.fn();
    const result = await executeModelHubExactEvaluationTarget(harness.dependencies, {
      generationId: "exact-generation",
      inspection,
      messages: input.messages,
      reserveAndBindBeforeDispatch,
      markDispatchStarted,
      assertBeforeProviderDispatch: finalLatch,
    });

    expect(harness.generate).toHaveBeenCalledOnce();
    const providerRequest = harness.generate.mock.calls[0]?.[0];
    expect(providerRequest).toMatchObject({
      generationId: "exact-generation",
      model: "exact-model",
      messages: input.messages,
      maxOutputTokens: 64,
      temperature: 0,
      topP: 1,
      reasoningMode: "disabled",
      dispatchScope: { kind: "non_project", reason: "novel_skill_evaluation" },
    });
    expect(providerRequest?.config.providerId).toBe("exact-connection");
    expect(providerRequest?.config.retryLimit).toBe(0);
    expect(reserveAndBindBeforeDispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(reserveAndBindBeforeDispatch.mock.calls[0]?.[0])).not.toContain(
      PRIVATE_FIXTURE,
    );
    expect(markDispatchStarted).toHaveBeenCalledOnce();
    expect(markDispatchStarted.mock.calls[0]?.[0]).toEqual(
      reserveAndBindBeforeDispatch.mock.calls[0]?.[0],
    );
    expect(finalLatch).toHaveBeenCalledTimes(2);
    expect(reserveAndBindBeforeDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      markDispatchStarted.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(markDispatchStarted.mock.invocationCallOrder[0]).toBeLessThan(
      harness.generate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(result.visibleOutputHash).toBe(await sha256Hex(VISIBLE_OUTPUT));
    expect(result.visibleContentLength).toBe(3);
    expect(result.text).toBe(VISIBLE_OUTPUT);
    expect(result.target.catalogEntryId).toBe("exact-catalog");
    expect(findRoute).not.toHaveBeenCalled();
    expect(saveRoute).not.toHaveBeenCalled();
    expect(deleteRoute).not.toHaveBeenCalled();
  });

  it("rejects a provider or model that does not match the exact catalog row", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "mismatch-connection",
      catalogEntryId: "mismatch-catalog",
      modelId: "real-model",
    });

    await expect(
      inspectModelHubExactEvaluationTarget(harness.dependencies, {
        ...request(exact),
        target: {
          connectionId: "mismatch-connection",
          catalogEntryId: "mismatch-catalog",
          providerKind: "custom_openai_compatible",
          modelId: "invented-model",
        },
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_EXACT_EVALUATION_TARGET_MISMATCH" });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("binds the exact message payload and stops before dispatch when it changes", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "payload-connection",
      catalogEntryId: "payload-catalog",
      modelId: "payload-model",
    });
    const input = request(exact);
    const inspection = await inspectModelHubExactEvaluationTarget(harness.dependencies, input);
    const reserveAndBindBeforeDispatch = vi.fn();
    const markDispatchStarted = vi.fn();

    await expect(
      executeModelHubExactEvaluationTarget(harness.dependencies, {
        generationId: "payload-generation",
        inspection,
        messages: [{ role: "user", content: `${PRIVATE_FIXTURE} changed` }],
        reserveAndBindBeforeDispatch,
        markDispatchStarted,
        assertBeforeProviderDispatch: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_EXACT_EVALUATION_CONFIGURATION_CHANGED",
      dispatched: false,
    });
    expect(reserveAndBindBeforeDispatch).not.toHaveBeenCalled();
    expect(markDispatchStarted).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("dispatches the locked message snapshot when a callback mutates the caller array", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "snapshot-connection",
      catalogEntryId: "snapshot-catalog",
      modelId: "snapshot-model",
    });
    const mutableMessages: { role: "user"; content: string }[] = [
      { role: "user", content: PRIVATE_FIXTURE },
    ];
    const inspection = await inspectModelHubExactEvaluationTarget(harness.dependencies, {
      ...request(exact),
      messages: mutableMessages,
    });
    harness.generate.mockResolvedValue({
      text: VISIBLE_OUTPUT,
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 },
      streamed: true,
    });

    await executeModelHubExactEvaluationTarget(harness.dependencies, {
      generationId: "snapshot-generation",
      inspection,
      messages: mutableMessages,
      reserveAndBindBeforeDispatch: () => Promise.resolve(),
      markDispatchStarted: () => {
        mutableMessages[0] = { role: "user", content: `${PRIVATE_FIXTURE} changed` };
        mutableMessages.push({ role: "user", content: "late message" });
        return Promise.resolve();
      },
      assertBeforeProviderDispatch: () => undefined,
    });

    const sent = harness.generate.mock.calls[0]?.[0].messages;
    expect(sent).toEqual([{ role: "user", content: PRIVATE_FIXTURE }]);
    expect(sent).not.toBe(mutableMessages);
  });

  it("dispatches the locked inspection snapshot when a callback mutates the caller receipt", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "inspection-snapshot-connection",
      catalogEntryId: "inspection-snapshot-catalog",
      modelId: "inspection-snapshot-model",
    });
    const originalRequest = request(exact);
    const inspection = await inspectModelHubExactEvaluationTarget(
      harness.dependencies,
      originalRequest,
    );
    const alternateRequest = {
      ...originalRequest,
      requestProfile: {
        ...originalRequest.requestProfile,
        maximumOutputTokens: originalRequest.requestProfile.maximumOutputTokens + 1,
      },
    };
    const alternate = await inspectModelHubExactEvaluationTarget(
      harness.dependencies,
      alternateRequest,
    );
    const mutableInspection = {
      ...inspection,
      target: { ...inspection.target },
      requestProfile: { ...inspection.requestProfile },
      requiredCapabilities: [...inspection.requiredCapabilities],
      pricing: { ...inspection.pricing },
    };
    harness.generate.mockResolvedValue({
      text: VISIBLE_OUTPUT,
      usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 0 },
      streamed: true,
    });
    let reservedRequestProfileHash = "";

    await executeModelHubExactEvaluationTarget(harness.dependencies, {
      generationId: "inspection-snapshot-generation",
      inspection: mutableInspection,
      messages: originalRequest.messages,
      reserveAndBindBeforeDispatch: (receipt) => {
        reservedRequestProfileHash = receipt.requestProfileHash;
        Object.assign(mutableInspection.target, alternate.target);
        Object.assign(mutableInspection.requestProfile, alternate.requestProfile);
        Object.assign(mutableInspection.pricing, alternate.pricing);
        Object.assign(mutableInspection, {
          requestProfileHash: alternate.requestProfileHash,
          messagePayloadHash: alternate.messagePayloadHash,
          payloadHash: alternate.payloadHash,
          executionLockHash: alternate.executionLockHash,
        });
      },
      markDispatchStarted: () => Promise.resolve(),
      assertBeforeProviderDispatch: () => undefined,
    });

    expect(reservedRequestProfileHash).toBe(inspection.requestProfileHash);
    expect(harness.generate.mock.calls[0]?.[0].maxOutputTokens).toBe(
      inspection.requestProfile.maximumOutputTokens,
    );
  });

  it("rechecks cost and revisions after the async predispatch UoW seam", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "drift-connection",
      catalogEntryId: "drift-catalog",
      modelId: "drift-model",
    });
    const input = request(exact);
    const inspection = await inspectModelHubExactEvaluationTarget(harness.dependencies, input);
    const reserveAndBindBeforeDispatch = vi.fn(async () => {
      const current = await harness.modelHub.findCostPrivacyProfile(exact.id);
      if (current === null) throw new Error("expected cost profile");
      await updateCostProfile(harness.modelHub, current, "9000");
    });

    await expect(
      executeModelHubExactEvaluationTarget(harness.dependencies, {
        generationId: "drift-generation",
        inspection,
        messages: input.messages,
        reserveAndBindBeforeDispatch,
        markDispatchStarted: vi.fn(),
        assertBeforeProviderDispatch: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_EXACT_EVALUATION_CONFIGURATION_CHANGED",
      dispatched: false,
    });
    expect(reserveAndBindBeforeDispatch).toHaveBeenCalledOnce();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("honors the final synchronous authorization latch without a provider call", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "latch-connection",
      catalogEntryId: "latch-catalog",
      modelId: "latch-model",
    });
    const input = request(exact);
    const inspection = await inspectModelHubExactEvaluationTarget(harness.dependencies, input);

    await expect(
      executeModelHubExactEvaluationTarget(harness.dependencies, {
        generationId: "latch-generation",
        inspection,
        messages: input.messages,
        reserveAndBindBeforeDispatch: () => Promise.resolve(),
        markDispatchStarted: vi.fn(),
        assertBeforeProviderDispatch: () => {
          throw new Error("authorization cancelled");
        },
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_EXACT_EVALUATION_CANCELLED_BEFORE_DISPATCH",
      dispatched: false,
    });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("does not call the provider when the dispatched boundary cannot be committed", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "mark-failure-connection",
      catalogEntryId: "mark-failure-catalog",
      modelId: "mark-failure-model",
    });
    const input = request(exact);
    const inspection = await inspectModelHubExactEvaluationTarget(harness.dependencies, input);

    await expect(
      executeModelHubExactEvaluationTarget(harness.dependencies, {
        generationId: "mark-failure-generation",
        inspection,
        messages: input.messages,
        reserveAndBindBeforeDispatch: () => Promise.resolve(),
        markDispatchStarted: () => Promise.reject(new Error("sqlite unavailable")),
        assertBeforeProviderDispatch: vi.fn(),
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_EXACT_EVALUATION_DISPATCH_MARK_FAILED",
      dispatched: false,
    });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("treats cancellation after the dispatched mark as ambiguous without calling the provider", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "post-mark-cancel-connection",
      catalogEntryId: "post-mark-cancel-catalog",
      modelId: "post-mark-cancel-model",
    });
    const input = request(exact);
    const inspection = await inspectModelHubExactEvaluationTarget(harness.dependencies, input);
    const finalLatch = vi
      .fn<() => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("cancelled while committing dispatch");
      });

    await expect(
      executeModelHubExactEvaluationTarget(harness.dependencies, {
        generationId: "post-mark-cancel-generation",
        inspection,
        messages: input.messages,
        reserveAndBindBeforeDispatch: () => Promise.resolve(),
        markDispatchStarted: () => Promise.resolve(),
        assertBeforeProviderDispatch: finalLatch,
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_EXACT_EVALUATION_CANCELLED_AFTER_DISPATCH_MARK",
      dispatched: true,
    });
    expect(finalLatch).toHaveBeenCalledTimes(2);
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("does not retry or route around a dispatched provider failure", async () => {
    const harness = createHarness();
    const exact = await seedTarget(harness.modelHub, {
      connectionId: "failure-connection",
      catalogEntryId: "failure-catalog",
      modelId: "failure-model",
    });
    const input = request(exact);
    const inspection = await inspectModelHubExactEvaluationTarget(harness.dependencies, input);
    harness.generate.mockRejectedValue(new Error("retryable-looking provider failure"));

    await expect(
      executeModelHubExactEvaluationTarget(harness.dependencies, {
        generationId: "failure-generation",
        inspection,
        messages: input.messages,
        reserveAndBindBeforeDispatch: () => Promise.resolve(),
        markDispatchStarted: () => Promise.resolve(),
        assertBeforeProviderDispatch: vi.fn(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "MODEL_HUB_EXACT_EVALUATION_PROVIDER_FAILED",
        dispatched: true,
      }),
    );
    expect(harness.generate).toHaveBeenCalledOnce();
  });

  it("fails closed when the native desktop gateway is unavailable", async () => {
    const harness = createHarness(false);
    const input = request({
      id: "browser-catalog",
      connectionId: "browser-connection",
      providerModelId: "browser-model",
    } as ModelCatalogEntry);

    await expect(
      inspectModelHubExactEvaluationTarget(harness.dependencies, input),
    ).rejects.toBeInstanceOf(ModelHubExactEvaluationError);
    await expect(
      inspectModelHubExactEvaluationTarget(harness.dependencies, input),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_EXACT_EVALUATION_GATEWAY_UNAVAILABLE",
      dispatched: false,
    });
    expect(harness.generate).not.toHaveBeenCalled();
  });
});

function createHarness(available = true): Readonly<{
  modelHub: BrowserDevelopmentModelHubStore;
  generate: ReturnType<typeof vi.fn<NativeModelGatewayClient["generate"]>>;
  dependencies: ModelHubExactEvaluationDependencies;
}> {
  const modelHub = new BrowserDevelopmentModelHubStore(new MemoryStorage(), clock);
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  return Object.freeze({
    modelHub,
    generate,
    dependencies: {
      modelHub,
      modelGateway: { available, generate },
      credentials: { getSummary: vi.fn(() => Promise.resolve({ configured: true })) },
      clock,
    },
  });
}

function request(catalog: ModelCatalogEntry): InspectModelHubExactEvaluationTargetInput {
  return {
    target: {
      connectionId: catalog.connectionId,
      catalogEntryId: catalog.id,
      providerKind: "custom_openai_compatible",
      modelId: catalog.providerModelId,
    },
    requestProfile: {
      version: MODEL_HUB_EXACT_EVALUATION_REQUEST_PROFILE_VERSION,
      task: "prose_generation",
      maximumInputTokens: 7_000,
      maximumOutputTokens: 64,
      temperatureBasisPoints: 0,
      topPBasisPoints: 10_000,
      reasoningMode: "disabled",
      responseFormat: "text",
      streaming: true,
      stopPolicyHash: MODEL_HUB_EXACT_EVALUATION_NO_STOP_POLICY_HASH,
      providerCallPolicy: "single_attempt",
    },
    messages: [{ role: "user", content: PRIVATE_FIXTURE }],
  };
}

async function seedTarget(
  modelHub: ModelHubStore,
  input: Readonly<{
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
    providerKind?: ModelProviderKind;
  }>,
): Promise<ModelCatalogEntry> {
  const providerKind = input.providerKind ?? "custom_openai_compatible";
  const connection = await modelHub.saveConnection({
    id: input.connectionId,
    providerKind,
    displayName: input.connectionId,
    ...(providerKind === "custom_openai_compatible"
      ? { baseUrlOverride: `https://${input.connectionId}.example.test/v1` }
      : {}),
    credentialRef: `keyring:model-hub:${input.connectionId}`,
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  const catalog = await modelHub.syncCatalog({
    syncId: `${input.connectionId}-sync`,
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: input.catalogEntryId,
        providerModelId: input.modelId,
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: "2026-08-02T00:00:00.000Z",
      },
    ],
  });
  const entry = catalog.find(({ id }) => id === input.catalogEntryId);
  if (entry === undefined) throw new Error("test catalog entry missing");
  await modelHub.recordCapabilityScan({
    scanId: `${input.connectionId}-text-scan`,
    catalogEntryId: entry.id,
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "exact-evaluation-test-v1",
    evidence: [
      {
        id: `${input.connectionId}-text-evidence`,
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: entry.id,
    currency: "USD",
    inputMicrosPerMillionTokens: "1000",
    outputMicrosPerMillionTokens: "2000",
    cachedInputMicrosPerMillionTokens: "500",
    pricingVersion: "exact-evaluation-test-v1",
    priceUpdatedAt: NOW,
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "exact-evaluation-test-v1",
    expectedRevision: null,
  });
  return entry;
}

function updateCostProfile(
  modelHub: ModelHubStore,
  current: ModelCostPrivacyProfile,
  outputRate: string,
): Promise<ModelCostPrivacyProfile> {
  return modelHub.saveCostPrivacyProfile({
    catalogEntryId: current.catalogEntryId,
    currency: current.currency,
    inputMicrosPerMillionTokens: current.inputMicrosPerMillionTokens,
    outputMicrosPerMillionTokens: outputRate,
    cachedInputMicrosPerMillionTokens: current.cachedInputMicrosPerMillionTokens,
    pricingVersion: current.pricingVersion,
    priceUpdatedAt: current.priceUpdatedAt,
    dataDestination: current.dataDestination,
    retentionPolicy: current.retentionPolicy,
    trainingPolicy: current.trainingPolicy,
    evidenceSource: current.evidenceSource,
    evidenceVersion: current.evidenceVersion,
    evidenceSummary: current.evidenceSummary,
    expectedRevision: current.revision,
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
