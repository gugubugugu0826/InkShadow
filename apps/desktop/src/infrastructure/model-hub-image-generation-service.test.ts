import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { CryptoUuidV7Generator } from "@inkshadow/platform";
import { describe, expect, it, vi } from "vitest";

import { ModelHubImageGenerationService } from "./model-hub-image-generation-service";
import type { ModelProviderKind } from "./model-hub-provider-registry";
import {
  BrowserDevelopmentModelHubStore,
  type ModelCatalogEntry,
  type ModelHubStore,
} from "./model-hub-store";
import type { NativeImageGenerationGateway } from "./native-image-generation-gateway";

const NOW_TEXT = "2026-08-01T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW_TEXT);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };
const PRIVATE_PROMPT = "PRIVATE_IMAGE_PROMPT_不会进入调用账本";

describe("Model Hub image generation service", () => {
  it("requires verified image capability and exposes honest privacy and pricing metadata", async () => {
    const harness = createHarness();
    const entry = await seedTarget(harness.modelHub, {});
    await saveRoute(harness.modelHub, entry.id);
    const inspection = await harness.service.inspect();

    expect(inspection).toMatchObject({
      task: "image_generation",
      connectionId: "image-connection",
      catalogEntryId: "image-catalog",
      modelId: "provider-image-model",
      dataDestination: "remote",
      pricingNotice: "per_image_price_not_modeled",
      outputFormat: "png",
    });
    expect(inspection.capabilityEvidence).toHaveLength(1);
    expect(JSON.stringify(inspection)).not.toContain(PRIVATE_PROMPT);
    expect(harness.gateway.generateToFile).not.toHaveBeenCalled();
  });

  it("saves through the exact routed model and keeps prompt, ticket and endpoint out of ledger facts", async () => {
    const harness = createHarness();
    const entry = await seedTarget(harness.modelHub, {});
    await saveRoute(harness.modelHub, entry.id);
    const inspection = await harness.service.inspect();
    const start = vi.spyOn(harness.modelHub, "startInvocation");
    const finish = vi.spyOn(harness.modelHub, "finishInvocation");
    harness.gateway.generateToFile.mockResolvedValue({
      provider: "open_ai_compatible",
      endpointOrigin: "https://images.example",
      model: "provider-image-model",
      fileName: "cover.png",
      mediaType: "image/png",
      bytesWritten: 4_096,
      usage: { inputTokens: 5, outputTokens: 9, cachedInputTokens: null },
    });

    const receipt = await harness.service.generate({
      prompt: PRIVATE_PROMPT,
      destination: { ticket: "c".repeat(64), fileName: "cover.png" },
      acknowledgedCostAndPrivacy: true,
      expectedConfirmationFingerprint: inspection.confirmationFingerprint,
    });

    expect(harness.gateway.generateToFile).toHaveBeenCalledWith({
      destinationTicket: "c".repeat(64),
      config: {
        providerId: "image-connection",
        provider: "open_ai_compatible",
        baseUrl: "https://images.example/v1",
        authentication: "bearer_keyring",
        modelDiscoveryPath: null,
        textGenerationPath: null,
        embeddingPath: null,
        credentialHeaderName: null,
        requestTimeoutMs: 30_000,
        retryLimit: 0,
      },
      model: "provider-image-model",
      prompt: PRIVATE_PROMPT,
    });
    expect(receipt).toMatchObject({
      connectionId: "image-connection",
      catalogEntryId: "image-catalog",
      modelId: "provider-image-model",
      file: { fileName: "cover.png" },
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "image_generation",
        connectionId: "image-connection",
        providerKindSnapshot: "custom_openai_compatible",
        modelIdSnapshot: "provider-image-model",
      }),
    );
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        inputTokens: 5,
        outputTokens: 9,
        estimatedCostMicros: null,
      }),
    );
    const ledger = JSON.stringify({ start: start.mock.calls, finish: finish.mock.calls });
    expect(ledger).not.toContain(PRIVATE_PROMPT);
    expect(ledger).not.toContain("c".repeat(64));
    expect(ledger).not.toContain("https://images.example/v1");
  });

  it("does not send the prompt when the connection is disabled during invocation setup", async () => {
    const harness = createHarness();
    const entry = await seedTarget(harness.modelHub, {});
    await saveRoute(harness.modelHub, entry.id);
    const inspection = await harness.service.inspect();
    const startInvocation = harness.modelHub.startInvocation.bind(harness.modelHub);
    vi.spyOn(harness.modelHub, "startInvocation").mockImplementationOnce(async (input) => {
      const invocation = await startInvocation(input);
      await disableConnection(harness.modelHub, "image-connection");
      return invocation;
    });

    await expect(
      harness.service.generate({
        prompt: PRIVATE_PROMPT,
        destination: { ticket: "f".repeat(64), fileName: "image.png" },
        acknowledgedCostAndPrivacy: true,
        expectedConfirmationFingerprint: inspection.confirmationFingerprint,
      }),
    ).rejects.toMatchObject({ dispatched: false });
    expect(harness.gateway.generateToFile).not.toHaveBeenCalled();
  });

  it("blocks unknown capability, unsupported protocols and absent consent before dispatch", async () => {
    const missingEvidence = createHarness();
    const unknown = await seedTarget(missingEvidence.modelHub, { capability: false });
    await saveRoute(missingEvidence.modelHub, unknown.id);
    await expect(missingEvidence.service.inspect()).rejects.toMatchObject({
      code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      dispatched: false,
    });
    expect(missingEvidence.gateway.generateToFile).not.toHaveBeenCalled();

    const unsupported = createHarness();
    const gemini = await seedTarget(unsupported.modelHub, {
      providerKind: "google_gemini",
    });
    await saveRoute(unsupported.modelHub, gemini.id);
    await expect(unsupported.service.inspect()).rejects.toMatchObject({
      code: "MODEL_HUB_IMAGE_PROTOCOL_UNSUPPORTED",
      dispatched: false,
    });
    expect(unsupported.gateway.generateToFile).not.toHaveBeenCalled();

    const noConsent = createHarness();
    const configured = await seedTarget(noConsent.modelHub, {});
    await saveRoute(noConsent.modelHub, configured.id);
    await expect(
      noConsent.service.generate({
        prompt: PRIVATE_PROMPT,
        destination: { ticket: "d".repeat(64), fileName: "image.png" },
        acknowledgedCostAndPrivacy: false,
        expectedConfirmationFingerprint: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_IMAGE_CONSENT_REQUIRED", dispatched: false });
    expect(noConsent.gateway.generateToFile).not.toHaveBeenCalled();
  });

  it("refuses to pretend text-token pricing can enforce a per-image hard cost ceiling", async () => {
    const harness = createHarness();
    const entry = await seedTarget(harness.modelHub, {});
    const route = await saveRoute(harness.modelHub, entry.id);
    vi.spyOn(harness.modelHub, "findTaskRoute").mockResolvedValue({
      ...route,
      maximumCostMicros: "1000",
      currency: "USD",
    });

    await expect(harness.service.inspect()).rejects.toMatchObject({
      code: "MODEL_HUB_COST_CEILING_UNVERIFIABLE",
      dispatched: false,
    });
    expect(harness.gateway.generateToFile).not.toHaveBeenCalled();
  });

  it("blocks a remote image endpoint from stale local-only privacy evidence", async () => {
    const harness = createHarness();
    const entry = await seedTarget(harness.modelHub, { destination: "local" });
    const route = await saveRoute(harness.modelHub, entry.id);
    vi.spyOn(harness.modelHub, "findTaskRoute").mockResolvedValue({
      ...route,
      privacyPolicy: "local_only",
    });

    await expect(harness.service.inspect()).rejects.toMatchObject({
      code: "MODEL_HUB_PRIVACY_BLOCKED",
      dispatched: false,
    });
    expect(harness.gateway.generateToFile).not.toHaveBeenCalled();
  });

  it("requires a fresh confirmation when the inspected route changes and makes zero gateway calls", async () => {
    const harness = createHarness();
    const entry = await seedTarget(harness.modelHub, {});
    const route = await saveRoute(harness.modelHub, entry.id);
    const inspection = await harness.service.inspect();
    const start = vi.spyOn(harness.modelHub, "startInvocation");
    await harness.modelHub.saveTaskRoute({
      task: route.task,
      primaryCatalogEntryId: route.primaryCatalogEntryId,
      fallbackCatalogEntryId: route.fallbackCatalogEntryId,
      presetId: route.presetId,
      parameterPolicy: { imageStyle: "natural" },
      maximumCostMicros: route.maximumCostMicros,
      currency: route.currency,
      privacyPolicy: route.privacyPolicy,
      failurePolicy: route.failurePolicy,
      routeOrigin: route.routeOrigin,
      enabled: route.enabled,
      expectedRevision: route.revision,
    });

    await expect(
      harness.service.generate({
        prompt: PRIVATE_PROMPT,
        destination: { ticket: "a".repeat(64), fileName: "image.png" },
        acknowledgedCostAndPrivacy: true,
        expectedConfirmationFingerprint: inspection.confirmationFingerprint,
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_IMAGE_CONFIRMATION_STALE",
      dispatched: false,
    });
    expect(harness.gateway.generateToFile).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("does not retry a fallback after dispatch and records a content-free failure", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {});
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "fallback-image-connection",
      catalogEntryId: "fallback-image-catalog",
      modelId: "fallback-image-model",
    });
    await saveRoute(harness.modelHub, primary.id, fallback.id);
    const inspection = await harness.service.inspect();
    harness.gateway.generateToFile.mockRejectedValue({
      code: "MODEL_HTTP_RATE_LIMITED",
      retryable: true,
      message: PRIVATE_PROMPT,
    });
    const finish = vi.spyOn(harness.modelHub, "finishInvocation");

    await expect(
      harness.service.generate({
        prompt: PRIVATE_PROMPT,
        destination: { ticket: "e".repeat(64), fileName: "image.png" },
        acknowledgedCostAndPrivacy: true,
        expectedConfirmationFingerprint: inspection.confirmationFingerprint,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HTTP_RATE_LIMITED", dispatched: true });
    expect(harness.gateway.generateToFile).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "MODEL_HTTP_RATE_LIMITED" }),
    );
    expect(JSON.stringify(finish.mock.calls)).not.toContain(PRIVATE_PROMPT);
  });
});

function createHarness(): Readonly<{
  modelHub: BrowserDevelopmentModelHubStore;
  gateway: Readonly<{
    available: true;
    chooseDestination: ReturnType<typeof vi.fn<NativeImageGenerationGateway["chooseDestination"]>>;
    generateToFile: ReturnType<typeof vi.fn<NativeImageGenerationGateway["generateToFile"]>>;
  }>;
  service: ModelHubImageGenerationService;
}> {
  const modelHub = new BrowserDevelopmentModelHubStore(new MemoryStorage(), clock);
  const gateway = {
    available: true as const,
    chooseDestination: vi.fn<NativeImageGenerationGateway["chooseDestination"]>(),
    generateToFile: vi.fn<NativeImageGenerationGateway["generateToFile"]>(),
  };
  const service = new ModelHubImageGenerationService({
    modelHub,
    imageGateway: gateway,
    credentials: { getSummary: vi.fn(() => Promise.resolve({ configured: true })) },
    ids: new CryptoUuidV7Generator(),
    clock,
  });
  return Object.freeze({ modelHub, gateway, service });
}

async function seedTarget(
  modelHub: ModelHubStore,
  input: Readonly<{
    connectionId?: string;
    catalogEntryId?: string;
    modelId?: string;
    providerKind?: ModelProviderKind;
    capability?: boolean;
    destination?: "local" | "remote";
  }>,
): Promise<ModelCatalogEntry> {
  const connectionId = input.connectionId ?? "image-connection";
  const catalogEntryId = input.catalogEntryId ?? "image-catalog";
  const providerKind = input.providerKind ?? "custom_openai_compatible";
  const connection = await modelHub.saveConnection({
    id: connectionId,
    providerKind,
    displayName: connectionId,
    ...(providerKind === "custom_openai_compatible"
      ? { baseUrlOverride: "https://images.example/v1" }
      : {}),
    credentialRef: `keyring:model-hub:${connectionId}`,
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId,
    status: "ready",
    expectedRevision: connection.revision,
  });
  const entries = await modelHub.syncCatalog({
    syncId: `${connectionId}-sync`,
    connectionId,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: catalogEntryId,
        providerModelId: input.modelId ?? "provider-image-model",
        lifecycle: "stable",
        staleAfter: "2026-08-02T00:00:00.000Z",
      },
    ],
  });
  const entry = entries.find(({ id }) => id === catalogEntryId);
  if (entry === undefined) {
    throw new Error("Expected the image catalog entry.");
  }
  if (input.capability !== false) {
    await modelHub.recordCapabilityScan({
      scanId: `${connectionId}-image-scan`,
      catalogEntryId,
      scanKind: "user_review",
      status: "succeeded",
      evidenceVersion: "image-test-v1",
      evidence: [
        {
          id: `${connectionId}-image-evidence`,
          capability: "image_generation",
          verdict: "supported",
          evidenceSource: "user_confirmed",
        },
      ],
    });
  }
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId,
    dataDestination: input.destination ?? "remote",
    retentionPolicy: input.destination === "local" ? "none" : "provider_default",
    trainingPolicy: input.destination === "local" ? "not_used" : "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "image-test-v1",
    expectedRevision: null,
  });
  return entry;
}

async function disableConnection(modelHub: ModelHubStore, connectionId: string): Promise<void> {
  const connection = await modelHub.findConnection(connectionId);
  if (connection === null) throw new Error("test connection missing");
  await modelHub.saveConnection({
    id: connection.id,
    providerKind: connection.providerKind,
    displayName: connection.displayName,
    baseUrlOverride: connection.baseUrl,
    credentialRef: connection.credentialRef,
    credentialState: connection.credentialState,
    authenticationMode: connection.authenticationMode,
    credentialHeaderName: connection.credentialHeaderName,
    modelDiscoveryPath: connection.modelDiscoveryPath,
    textGenerationPath: connection.textGenerationPath,
    embeddingPath: connection.embeddingPath,
    requestTimeoutMs: connection.requestTimeoutMs,
    retryLimit: connection.retryLimit,
    enabled: false,
    expectedRevision: connection.revision,
  });
}

function saveRoute(
  modelHub: ModelHubStore,
  primaryCatalogEntryId: string,
  fallbackCatalogEntryId: string | null = null,
) {
  return modelHub.saveTaskRoute({
    task: "image_generation",
    primaryCatalogEntryId,
    fallbackCatalogEntryId,
    privacyPolicy: "cloud_allowed",
    failurePolicy: fallbackCatalogEntryId === null ? "stop" : "use_fallback",
    routeOrigin: "user",
    expectedRevision: null,
  });
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
