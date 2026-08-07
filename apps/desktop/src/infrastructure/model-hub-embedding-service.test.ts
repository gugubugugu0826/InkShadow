import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { CryptoUuidV7Generator } from "@inkshadow/platform";
import { describe, expect, it, vi } from "vitest";

import {
  executeModelHubEmbeddingTask,
  inspectModelHubEmbeddingTask,
  type ModelHubEmbeddingExecutionDependencies,
} from "./model-hub-embedding-service";
import { ModelHubExecutionError } from "./model-hub-execution-service";
import type { ModelProviderKind } from "./model-hub-provider-registry";
import {
  BrowserDevelopmentModelHubStore,
  type ModelCatalogEntry,
  type ModelHubStore,
  type NovelTaskRoute,
} from "./model-hub-store";
import type {
  NativeEmbeddingGatewayClient,
  NativeEmbeddingResult,
} from "./native-embedding-gateway";

const NOW = "2026-08-01T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };
const PRIVATE_INPUT = "PRIVATE_CHAPTER_TEXT_绝不能写入调用账本";
const PRIVATE_VECTOR = [0.123456789, 0.987654321] as const;

describe("Model Hub embedding execution service", () => {
  it("inspects exact routing, evidence, limits, price and fingerprint metadata without side effects or content", async () => {
    const harness = createHarness();
    await seedTarget(harness.modelHub, {
      connectionId: "inspection-decoy",
      catalogEntryId: "inspection-decoy-catalog",
      modelId: "inspection-decoy-model",
    });
    const target = await seedTarget(harness.modelHub, {
      connectionId: "inspection-gemini",
      catalogEntryId: "inspection-gemini-catalog",
      modelId: "models/inspection-embedding",
      providerKind: "google_gemini",
      inputRate: "1000000",
      outputRate: "9000000",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "10000",
      currency: "USD",
      parameterPolicy: { maximumInputs: 8, maximumInputTokens: 10_000 },
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(harness.modelHub, "finishInvocation");
    const inputBytes = new TextEncoder().encode(PRIVATE_INPUT).length;
    const expectedInputTokens = estimateInputTokens([PRIVATE_INPUT]);

    const inspection = await inspectModelHubEmbeddingTask(harness.dependencies, {
      inputs: [PRIVATE_INPUT],
    });

    expect(inspection).toEqual({
      task: "embedding",
      routeRevision: 1,
      configuredPrimaryCatalogEntryId: "inspection-gemini-catalog",
      configuredFallbackCatalogEntryId: null,
      selectionKind: "task_primary",
      usedFallback: false,
      attempt: 1,
      connectionId: "inspection-gemini",
      catalogEntryId: "inspection-gemini-catalog",
      providerKind: "google_gemini",
      providerProtocol: "gemini",
      gatewayProvider: "gemini",
      modelId: "models/inspection-embedding",
      dataDestination: "remote",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      capability: {
        required: ["embedding"],
        verdict: "supported",
        evidence: [
          {
            id: "inspection-gemini-embedding-evidence",
            verdict: "supported",
            evidenceSource: "lightweight_probe",
            evidenceVersion: "embedding-execution-test-v1",
            observedAt: NOW,
            expiresAt: null,
          },
        ],
      },
      privacy: {
        dataDestination: "remote",
        retentionPolicy: "provider_default",
        trainingPolicy: "unknown",
        evidenceSource: "user_confirmed",
        evidenceVersion: "embedding-execution-test-v1",
        evidenceUpdatedAt: NOW,
      },
      fingerprintMaterial: {
        version: "model-hub-embedding-v1",
        routeRevision: 1,
        connectionId: "inspection-gemini",
        connectionRevision: 3,
        catalogEntryId: "inspection-gemini-catalog",
        catalogRevision: 1,
        providerKind: "google_gemini",
        providerProtocol: "gemini",
        gatewayProvider: "gemini",
        authenticationMode: "bearer_keyring",
        modelId: "models/inspection-embedding",
        dataDestination: "remote",
        costPrivacyRevision: 1,
        privacyEvidenceSource: "user_confirmed",
        privacyEvidenceVersion: "embedding-execution-test-v1",
      },
      input: {
        inputCount: 1,
        totalInputBytes: inputBytes,
        maximumBatchSize: 64,
        maximumItemBytes: 65_536,
        maximumTotalBytes: 524_288,
        routeMaximumInputs: 8,
        routeMaximumInputTokens: 10_000,
        catalogInputTokenLimit: 200_000,
        estimatedInputTokens: expectedInputTokens,
        maximumEstimatedItemTokens: inputBytes + 64,
      },
      pricing: {
        currency: "USD",
        inputMicrosPerMillionTokens: "1000000",
        outputMicrosPerMillionTokens: "9000000",
        cachedInputMicrosPerMillionTokens: null,
        pricingVersion: "embedding-execution-test-v1",
        priceUpdatedAt: NOW,
        evidenceSource: "user_confirmed",
        evidenceVersion: "embedding-execution-test-v1",
        evidenceUpdatedAt: NOW,
        estimatedCostMicros: String(expectedInputTokens),
        maximumCostMicros: "10000",
        maximumCostCurrency: "USD",
      },
    });
    expect(harness.credentials.getSummary).toHaveBeenCalledOnce();
    expect(harness.credentials.getSummary).toHaveBeenCalledWith("inspection-gemini");
    expect(startInvocation).not.toHaveBeenCalled();
    expect(finishInvocation).not.toHaveBeenCalled();
    expect(harness.embed).not.toHaveBeenCalled();
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain(PRIVATE_INPUT);
    expect(serialized).not.toContain("https://generativelanguage.googleapis.com/v1beta");
    expect(serialized).not.toMatch(/baseUrl|credentialRef|credentialState|apiKey|secret/iu);
    expect(serialized).not.toMatch(/"(?:inputs|content|text|embeddings|vector)"/iu);
  });

  it("reports the configured fallback as the actual side-effect-free embedding selection", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {
      connectionId: "inspection-primary-not-ready",
      catalogEntryId: "inspection-primary-catalog",
      modelId: "inspection-primary-model",
      connectionReady: false,
    });
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "inspection-fallback-ready",
      catalogEntryId: "inspection-fallback-catalog",
      modelId: "inspection-fallback-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: primary.id,
      fallbackCatalogEntryId: fallback.id,
      failurePolicy: "use_fallback",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    const inspection = await inspectModelHubEmbeddingTask(harness.dependencies, {
      inputs: [PRIVATE_INPUT],
    });

    expect(inspection).toMatchObject({
      configuredPrimaryCatalogEntryId: "inspection-primary-catalog",
      configuredFallbackCatalogEntryId: "inspection-fallback-catalog",
      selectionKind: "task_fallback",
      usedFallback: true,
      attempt: 2,
      connectionId: "inspection-fallback-ready",
      catalogEntryId: "inspection-fallback-catalog",
      modelId: "inspection-fallback-model",
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("uses the same selected target and accounting for inspection and execution", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "shared-embedding-resolution",
      catalogEntryId: "shared-embedding-catalog",
      modelId: "shared-embedding-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      parameterPolicy: { maximumInputs: 4, maximumInputTokens: 20_000 },
    });
    harness.embed.mockResolvedValue(
      embeddingResult("open_ai_compatible", "shared-embedding-model", [PRIVATE_VECTOR]),
    );

    const inspection = await inspectModelHubEmbeddingTask(harness.dependencies, {
      inputs: [PRIVATE_INPUT],
    });
    expect(harness.embed).not.toHaveBeenCalled();
    const result = await executeModelHubEmbeddingTask(harness.dependencies, {
      inputs: [PRIVATE_INPUT],
    });

    expect(result).toMatchObject({
      connectionId: inspection.connectionId,
      catalogEntryId: inspection.catalogEntryId,
      providerKind: inspection.providerKind,
      modelId: inspection.modelId,
      usedFallback: inspection.usedFallback,
      estimatedInputTokens: inspection.input.estimatedInputTokens,
      estimatedCostMicros: inspection.pricing.estimatedCostMicros,
    });
    expect(harness.embed.mock.calls[0]?.[0]).toMatchObject({
      config: {
        providerId: inspection.connectionId,
        provider: inspection.gatewayProvider,
        authentication: inspection.fingerprintMaterial.authenticationMode,
      },
      model: inspection.modelId,
      inputs: [PRIVATE_INPUT],
    });
  });

  it("returns the same fail-closed preflight error for inspection and execution", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "shared-cost-failure",
      catalogEntryId: "shared-cost-failure-catalog",
      modelId: "shared-cost-failure-model",
      inputRate: "1000000",
      outputRate: "1000000",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "1",
      currency: "USD",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    const inspectedError = await inspectModelHubEmbeddingTask(harness.dependencies, {
      inputs: [PRIVATE_INPUT],
    }).catch((cause: unknown) => cause);
    const executedError = await executeModelHubEmbeddingTask(harness.dependencies, {
      inputs: [PRIVATE_INPUT],
    }).catch((cause: unknown) => cause);

    expect(inspectedError).toMatchObject({
      code: "MODEL_HUB_COST_CEILING_EXCEEDED",
      dispatched: false,
    });
    expect(executedError).toMatchObject({
      code: "MODEL_HUB_COST_CEILING_EXCEEDED",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("uses the exact route, credential id and native provider while keeping text and vectors out of the ledger", async () => {
    const harness = createHarness();
    await seedTarget(harness.modelHub, {
      connectionId: "decoy-connection",
      catalogEntryId: "decoy-catalog",
      modelId: "decoy-embedding-model",
    });
    const target = await seedTarget(harness.modelHub, {
      connectionId: "gemini-embedding-connection",
      catalogEntryId: "gemini-embedding-catalog",
      modelId: "models/text-embedding-exact",
      providerKind: "google_gemini",
      inputRate: "1000000",
      outputRate: "9000000",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "10000",
      currency: "USD",
    });
    harness.embed.mockResolvedValue(
      embeddingResult("gemini", "models/text-embedding-exact", [PRIVATE_VECTOR]),
    );
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(harness.modelHub, "finishInvocation");
    const beforeDispatch = vi.fn();

    const result = await executeModelHubEmbeddingTask(harness.dependencies, {
      inputs: [PRIVATE_INPUT],
      onBeforeDispatch: beforeDispatch,
    });

    const expectedInputTokens = estimateInputTokens([PRIVATE_INPUT]);
    expect(result).toMatchObject({
      provider: "gemini",
      model: "models/text-embedding-exact",
      dimension: 2,
      vectorCount: 1,
      embeddings: [PRIVATE_VECTOR],
      connectionId: "gemini-embedding-connection",
      catalogEntryId: "gemini-embedding-catalog",
      providerKind: "google_gemini",
      modelId: "models/text-embedding-exact",
      usedFallback: false,
      estimatedInputTokens: expectedInputTokens,
      estimatedCostMicros: String(expectedInputTokens),
    });
    expect(harness.credentials.getSummary).toHaveBeenCalledOnce();
    expect(harness.credentials.getSummary).toHaveBeenCalledWith("gemini-embedding-connection");
    expect(harness.embed).toHaveBeenCalledOnce();
    expect(harness.embed).toHaveBeenCalledWith({
      config: {
        providerId: "gemini-embedding-connection",
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        authentication: "bearer_keyring",
        requestTimeoutMs: 30_000,
        retryLimit: 0,
      },
      model: "models/text-embedding-exact",
      inputs: [PRIVATE_INPUT],
    });
    expect(beforeDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "gemini-embedding-connection",
        catalogEntryId: "gemini-embedding-catalog",
        modelId: "models/text-embedding-exact",
        inputCount: 1,
        estimatedInputTokens: expectedInputTokens,
        usedFallback: false,
      }),
    );
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "embedding",
        routeTask: "embedding",
        connectionId: "gemini-embedding-connection",
        catalogEntryId: "gemini-embedding-catalog",
        providerKindSnapshot: "google_gemini",
        modelIdSnapshot: "models/text-embedding-exact",
        routeReason: "task_primary",
      }),
    );
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        inputTokens: expectedInputTokens,
        outputTokens: 0,
        cachedInputTokens: null,
        estimatedCostMicros: String(expectedInputTokens),
        currency: "USD",
      }),
    );
    const ledgerPayload = JSON.stringify({
      start: startInvocation.mock.calls,
      finish: finishInvocation.mock.calls,
      invocation: result.invocation,
    });
    expect(ledgerPayload).not.toContain(PRIVATE_INPUT);
    expect(ledgerPayload).not.toContain(JSON.stringify(PRIVATE_VECTOR));
    expect(ledgerPayload).not.toMatch(/"(?:prompt|messages|content|inputs|embeddings|vector)"/iu);
  });

  it("fails closed when the embedding route is absent and never dispatches directly", async () => {
    const harness = createHarness();
    await seedTarget(harness.modelHub, {
      connectionId: "legacy-looking-connection",
      catalogEntryId: "legacy-looking-catalog",
      modelId: "legacy-looking-model",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    await expect(
      executeModelHubEmbeddingTask(harness.dependencies, { inputs: [PRIVATE_INPUT] }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("rechecks embedding capability evidence before dispatch", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "unknown-capability",
      catalogEntryId: "unknown-capability-catalog",
      modelId: "unknown-capability-model",
      includeEmbeddingCapability: false,
    });
    await saveRoute(harness.modelHub, { primaryCatalogEntryId: target.id });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    await expect(
      executeModelHubEmbeddingTask(harness.dependencies, { inputs: [PRIVATE_INPUT] }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("uses the exact connection id when checking credentials and blocks a missing key", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "missing-key-connection",
      catalogEntryId: "missing-key-catalog",
      modelId: "missing-key-model",
      providerKind: "openai",
    });
    await saveRoute(harness.modelHub, { primaryCatalogEntryId: target.id });
    harness.credentials.getSummary.mockResolvedValue({ configured: false });

    await expect(
      executeModelHubEmbeddingTask(harness.dependencies, { inputs: [PRIVATE_INPUT] }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_CREDENTIAL_MISSING",
      dispatched: false,
    });
    expect(harness.credentials.getSummary).toHaveBeenCalledWith("missing-key-connection");
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("rechecks local-only destination evidence instead of trusting a stored route", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "local-privacy-target",
      catalogEntryId: "local-privacy-catalog",
      modelId: "local-privacy-model",
      providerKind: "ollama",
      destination: "local",
    });
    const route = await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      privacyPolicy: "local_only",
    });
    const privacy = await harness.modelHub.findCostPrivacyProfile(target.id);
    if (privacy === null) {
      throw new Error("test privacy profile missing");
    }
    vi.spyOn(harness.modelHub, "findTaskRoute").mockResolvedValue(route);
    vi.spyOn(harness.modelHub, "findCostPrivacyProfile").mockResolvedValue({
      ...privacy,
      evidenceSource: "unknown",
    });

    await expect(
      executeModelHubEmbeddingTask(harness.dependencies, { inputs: [PRIVATE_INPUT] }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_PRIVACY_BLOCKED",
      dispatched: false,
    });
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("blocks remote Ollama from a stale local-only embedding route", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "remote-ollama-embedding",
      catalogEntryId: "remote-ollama-embedding-catalog",
      modelId: "remote-ollama-embedding-model",
      providerKind: "ollama",
      baseUrlOverride: "https://remote-ollama.example.test",
      destination: "local",
    });
    const route = await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      privacyPolicy: "cloud_allowed",
    });
    vi.spyOn(harness.modelHub, "findTaskRoute").mockResolvedValue({
      ...route,
      privacyPolicy: "local_only",
    });

    await expect(
      executeModelHubEmbeddingTask(harness.dependencies, { inputs: [PRIVATE_INPUT] }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_PRIVACY_BLOCKED", dispatched: false });
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("uses a conservative input estimate to enforce the cost ceiling before dispatch", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "cost-target",
      catalogEntryId: "cost-catalog",
      modelId: "cost-model",
      inputRate: "1000000",
      outputRate: "999999999",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "1",
      currency: "USD",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    await expect(
      executeModelHubEmbeddingTask(harness.dependencies, { inputs: ["x"] }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_COST_CEILING_EXCEEDED",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("refuses a hard cost ceiling when embedding input pricing cannot be verified", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "unknown-cost-target",
      catalogEntryId: "unknown-cost-catalog",
      modelId: "unknown-cost-model",
      pricingKnown: false,
    });
    const route = await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
    });
    vi.spyOn(harness.modelHub, "findTaskRoute").mockResolvedValue({
      ...route,
      maximumCostMicros: "1000",
      currency: "USD",
    });

    await expect(
      executeModelHubEmbeddingTask(harness.dependencies, { inputs: [PRIVATE_INPUT] }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_COST_CEILING_UNVERIFIABLE",
      dispatched: false,
    });
    expect(harness.embed).not.toHaveBeenCalled();
  });

  it("switches to a configured fallback only when the primary fails before dispatch", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {
      connectionId: "primary-not-ready",
      catalogEntryId: "primary-not-ready-catalog",
      modelId: "primary-model",
      connectionReady: false,
    });
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "fallback-ready",
      catalogEntryId: "fallback-ready-catalog",
      modelId: "fallback-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: primary.id,
      fallbackCatalogEntryId: fallback.id,
      failurePolicy: "use_fallback",
    });
    harness.embed.mockResolvedValue(
      embeddingResult("open_ai_compatible", "fallback-model", [PRIVATE_VECTOR]),
    );
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    const result = await executeModelHubEmbeddingTask(harness.dependencies, {
      inputs: [PRIVATE_INPUT],
    });

    expect(result).toMatchObject({
      usedFallback: true,
      connectionId: "fallback-ready",
      catalogEntryId: "fallback-ready-catalog",
      modelId: "fallback-model",
    });
    expect(harness.embed).toHaveBeenCalledOnce();
    expect(harness.embed.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "fallback-ready" },
      model: "fallback-model",
    });
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        routeReason: "task_fallback",
        attempt: 2,
        connectionId: "fallback-ready",
      }),
    );
  });

  it("does not call the fallback after a dispatched provider failure and records no content", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {
      connectionId: "dispatched-primary",
      catalogEntryId: "dispatched-primary-catalog",
      modelId: "dispatched-primary-model",
    });
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "unused-fallback",
      catalogEntryId: "unused-fallback-catalog",
      modelId: "unused-fallback-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: primary.id,
      fallbackCatalogEntryId: fallback.id,
      failurePolicy: "use_fallback",
    });
    harness.embed.mockRejectedValue({
      code: "UPSTREAM_TIMEOUT",
      retryable: true,
      message: PRIVATE_INPUT,
    });
    const finishInvocation = vi.spyOn(harness.modelHub, "finishInvocation");

    let error: unknown;
    try {
      await executeModelHubEmbeddingTask(harness.dependencies, { inputs: [PRIVATE_INPUT] });
    } catch (cause: unknown) {
      error = cause;
    }

    expect(error).toBeInstanceOf(ModelHubExecutionError);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", dispatched: true, retryable: true });
    expect(harness.embed).toHaveBeenCalledOnce();
    expect(harness.embed.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "dispatched-primary" },
      model: "dispatched-primary-model",
    });
    expect(finishInvocation).toHaveBeenCalledOnce();
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "UPSTREAM_TIMEOUT",
      }),
    );
    expect(JSON.stringify(finishInvocation.mock.calls)).not.toContain(PRIVATE_INPUT);
  });

  it("rejects invalid input and unsupported Anthropic embedding before native dispatch", async () => {
    const invalidHarness = createHarness();
    const findTaskRoute = vi.spyOn(invalidHarness.modelHub, "findTaskRoute");
    await expect(
      executeModelHubEmbeddingTask(invalidHarness.dependencies, { inputs: [] }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_REQUEST_INVALID", dispatched: false });
    expect(findTaskRoute).not.toHaveBeenCalled();

    const anthropicHarness = createHarness();
    const target = await seedTarget(anthropicHarness.modelHub, {
      connectionId: "anthropic-connection",
      catalogEntryId: "anthropic-catalog",
      modelId: "claude-user-claimed-embedding",
      providerKind: "anthropic_claude",
    });
    await saveRoute(anthropicHarness.modelHub, { primaryCatalogEntryId: target.id });
    await expect(
      executeModelHubEmbeddingTask(anthropicHarness.dependencies, {
        inputs: [PRIVATE_INPUT],
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_EMBEDDING_PROTOCOL_UNSUPPORTED",
      dispatched: false,
    });
    expect(anthropicHarness.embed).not.toHaveBeenCalled();
  });
});

function createHarness(): Readonly<{
  modelHub: BrowserDevelopmentModelHubStore;
  embed: ReturnType<typeof vi.fn<NativeEmbeddingGatewayClient["embed"]>>;
  credentials: Readonly<{
    getSummary: ReturnType<
      typeof vi.fn<(providerId: string) => Promise<Readonly<{ configured: boolean }>>>
    >;
  }>;
  dependencies: ModelHubEmbeddingExecutionDependencies;
}> {
  const modelHub = new BrowserDevelopmentModelHubStore(new MemoryStorage(), clock);
  const embed = vi.fn<NativeEmbeddingGatewayClient["embed"]>();
  const credentials = {
    getSummary: vi.fn(() => Promise.resolve({ configured: true })),
  };
  return Object.freeze({
    modelHub,
    embed,
    credentials,
    dependencies: {
      modelHub,
      modelGateway: { available: true, embed },
      credentials,
      clock,
      ids: new CryptoUuidV7Generator(),
    },
  });
}

function embeddingResult(
  provider: NativeEmbeddingResult["provider"],
  model: string,
  embeddings: readonly (readonly number[])[],
): NativeEmbeddingResult {
  return Object.freeze({
    provider,
    endpointOrigin:
      provider === "gemini" ? "https://generativelanguage.googleapis.com" : "https://test.example",
    model,
    dimension: embeddings[0]?.length ?? 0,
    vectorCount: embeddings.length,
    embeddings,
  });
}

async function seedTarget(
  modelHub: ModelHubStore,
  input: Readonly<{
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
    providerKind?: ModelProviderKind;
    connectionReady?: boolean;
    includeEmbeddingCapability?: boolean;
    destination?: "local" | "remote";
    lifecycle?: ModelCatalogEntry["lifecycle"];
    staleAfter?: string | null;
    baseUrlOverride?: string;
    pricingKnown?: boolean;
    inputRate?: string;
    outputRate?: string;
  }>,
): Promise<ModelCatalogEntry> {
  const providerKind = input.providerKind ?? "custom_openai_compatible";
  const local = input.destination === "local" || providerKind === "ollama";
  const connection = await modelHub.saveConnection({
    id: input.connectionId,
    providerKind,
    displayName: input.connectionId,
    ...(input.baseUrlOverride !== undefined
      ? { baseUrlOverride: input.baseUrlOverride }
      : providerKind === "custom_openai_compatible"
        ? { baseUrlOverride: `https://${input.connectionId}.example.test/v1` }
        : {}),
    credentialRef: local ? null : `keyring:test:${input.connectionId}`,
    credentialState: local ? "missing" : "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: input.connectionReady === false ? "error" : "ready",
    ...(input.connectionReady === false
      ? { errorCode: "TEST_CONNECTION_NOT_READY", errorSummary: "test state" }
      : {}),
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
        lifecycle: input.lifecycle ?? "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: null,
        staleAfter: input.staleAfter ?? "2026-08-02T00:00:00.000Z",
      },
    ],
  });
  const entry = catalog.find(({ id }) => id === input.catalogEntryId);
  if (entry === undefined) {
    throw new Error("test catalog entry missing");
  }
  if (input.includeEmbeddingCapability !== false) {
    await modelHub.recordCapabilityScan({
      scanId: `${input.connectionId}-embedding-scan`,
      catalogEntryId: entry.id,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "embedding-execution-test-v1",
      evidence: [
        {
          id: `${input.connectionId}-embedding-evidence`,
          capability: "embedding",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        },
      ],
    });
  }
  const pricingKnown = input.pricingKnown !== false;
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: entry.id,
    ...(pricingKnown
      ? {
          currency: "USD",
          inputMicrosPerMillionTokens: input.inputRate ?? "1000",
          outputMicrosPerMillionTokens: input.outputRate ?? "1000",
          pricingVersion: "embedding-execution-test-v1",
          priceUpdatedAt: NOW,
        }
      : {}),
    dataDestination: local ? "local" : (input.destination ?? "remote"),
    retentionPolicy: local ? "none" : "provider_default",
    trainingPolicy: local ? "not_used" : "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "embedding-execution-test-v1",
    expectedRevision: null,
  });
  return entry;
}

async function saveRoute(
  modelHub: ModelHubStore,
  input: Readonly<{
    primaryCatalogEntryId: string;
    fallbackCatalogEntryId?: string | null;
    maximumCostMicros?: string | null;
    currency?: string | null;
    privacyPolicy?: NovelTaskRoute["privacyPolicy"];
    failurePolicy?: NovelTaskRoute["failurePolicy"];
    parameterPolicy?: Readonly<Record<string, unknown>>;
  }>,
): Promise<NovelTaskRoute> {
  return modelHub.saveTaskRoute({
    task: "embedding",
    primaryCatalogEntryId: input.primaryCatalogEntryId,
    fallbackCatalogEntryId: input.fallbackCatalogEntryId ?? null,
    parameterPolicy: input.parameterPolicy ?? {},
    maximumCostMicros: input.maximumCostMicros ?? null,
    currency: input.currency ?? null,
    privacyPolicy: input.privacyPolicy ?? "cloud_allowed",
    failurePolicy:
      input.failurePolicy ??
      (input.fallbackCatalogEntryId === undefined || input.fallbackCatalogEntryId === null
        ? "stop"
        : "use_fallback"),
    routeOrigin: "user",
    expectedRevision: null,
  });
}

function estimateInputTokens(inputs: readonly string[]): number {
  const encoder = new TextEncoder();
  return inputs.reduce((total, value) => total + encoder.encode(value).length + 64, 1_024);
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
