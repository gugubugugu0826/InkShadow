import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { CryptoUuidV7Generator } from "@inkshadow/platform";
import { describe, expect, it, vi } from "vitest";

import {
  mergeRemoteRerankWithLocalFallback,
  ModelHubRerankService,
} from "./model-hub-rerank-service";
import type { ModelProviderKind } from "./model-hub-provider-registry";
import {
  BrowserDevelopmentModelHubStore,
  type ModelCatalogEntry,
  type ModelHubStore,
  type NovelTaskRoute,
} from "./model-hub-store";
import type { NativeRerankGatewayClient } from "./native-rerank-gateway";

const NOW = "2026-08-01T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };
const PRIVATE_QUERY = "PRIVATE_QUERY_不得写入账本";
const PRIVATE_DOCUMENTS = ["PRIVATE_DOCUMENT_A", "PRIVATE_DOCUMENT_B"] as const;
const TEST_DISPATCH_SCOPE = {
  kind: "project_context",
  receipt: {
    schemaVersion: 1,
    projectId: "019f9f4a-b3c7-7350-9226-000000000001",
    fingerprint: "a".repeat(64),
    activeChapterCount: 0,
    retainedChapterCount: 0,
    requiresVerifiedLocal: false,
    chapters: [],
  },
} as const;

describe("ModelHubRerankService", () => {
  it("persists explicit remote-content consent as task policy across runtime reopen", async () => {
    const storage = new MemoryStorage();
    const first = new BrowserDevelopmentModelHubStore(storage, clock);
    const target = await seedTarget(first, {
      connectionId: "qwen-persisted-consent",
      catalogEntryId: "qwen-persisted-consent-catalog",
    });
    await saveRoute(first, target.id, { remoteContentConsent: true });

    const reopened = new BrowserDevelopmentModelHubStore(storage, clock);
    await expect(reopened.findTaskRoute("rerank")).resolves.toMatchObject({
      task: "rerank",
      routeOrigin: "user",
      privacyPolicy: "cloud_allowed",
      parameterPolicy: { remoteContentConsent: true },
    });
  });

  it("preserves every local candidate when provider results are partial or duplicated", () => {
    const merged = mergeRemoteRerankWithLocalFallback({
      documentCount: 4,
      remoteRankings: [
        { index: 2, relevanceScore: 0.9 },
        { index: 2, relevanceScore: 0.8 },
      ],
      localRankings: [
        { index: 1, score: 0.7 },
        { index: 0, score: 0.6 },
      ],
    });

    expect(merged.map(({ index }) => index)).toEqual([2, 1, 0, 3]);
    expect(merged[0]?.source).toBe("qwen_remote");
    expect(new Set(merged.map(({ index }) => index)).size).toBe(4);
  });

  it("defaults to a content-free local fallback until remote sending is explicitly enabled", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "qwen-no-consent",
      catalogEntryId: "qwen-no-consent-catalog",
    });
    await saveRoute(harness.modelHub, target.id, { remoteContentConsent: false });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    const attempt = await harness.service.tryRerank({
      dispatchScope: TEST_DISPATCH_SCOPE,
      query: PRIVATE_QUERY,
      documents: PRIVATE_DOCUMENTS,
      topN: 2,
    });

    expect(attempt).toMatchObject({
      status: "skipped",
      source: "local_deterministic_fallback",
      code: "MODEL_HUB_RERANK_REMOTE_CONSENT_REQUIRED",
    });
    expect(JSON.stringify(attempt)).not.toContain(PRIVATE_QUERY);
    expect(JSON.stringify(attempt)).not.toContain(PRIVATE_DOCUMENTS[0]);
    expect(harness.rerank).not.toHaveBeenCalled();
    expect(startInvocation).not.toHaveBeenCalled();
  });

  it("uses the verified Beijing Workspace endpoint and records only safe invocation metadata", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "qwen-ready",
      catalogEntryId: "qwen-ready-catalog",
      workspaceId: "workspace-safe",
    });
    await saveRoute(harness.modelHub, target.id, { remoteContentConsent: true });
    harness.rerank.mockResolvedValue({
      provider: "open_ai_compatible",
      protocol: "qwen_open_ai_compatible",
      endpointOrigin: "https://workspace-safe.cn-beijing.maas.aliyuncs.com",
      model: "qwen3-rerank",
      rankings: [{ index: 1, relevanceScore: 0.94 }],
      inputTokens: 35,
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(harness.modelHub, "finishInvocation");

    const result = await harness.service.rerank({
      dispatchScope: TEST_DISPATCH_SCOPE,
      query: PRIVATE_QUERY,
      documents: PRIVATE_DOCUMENTS,
      topN: 2,
    });

    expect(result.rankings).toEqual([{ index: 1, relevanceScore: 0.94 }]);
    expect(result.inputTokens).toBe(35);
    expect(harness.rerank).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          providerId: "qwen-ready",
          provider: "open_ai_compatible",
          baseUrl: "https://workspace-safe.cn-beijing.maas.aliyuncs.com/compatible-api/v1",
          authentication: "bearer_keyring",
        },
        protocol: "qwen_open_ai_compatible",
        query: PRIVATE_QUERY,
        documents: PRIVATE_DOCUMENTS,
      }),
    );
    expect(startInvocation).toHaveBeenCalledOnce();
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", inputTokens: 35, outputTokens: 0 }),
    );
    const ledgerCalls = JSON.stringify([startInvocation.mock.calls, finishInvocation.mock.calls]);
    expect(ledgerCalls).not.toContain(PRIVATE_QUERY);
    expect(ledgerCalls).not.toContain(PRIVATE_DOCUMENTS[0]);
    expect(ledgerCalls).not.toMatch(/apiKey|secret|query|documents/iu);
  });

  it("uses a verified Qwen fallback when the primary protocol is unsupported", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {
      connectionId: "openai-primary",
      catalogEntryId: "openai-primary-catalog",
      providerKind: "openai",
    });
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "qwen-fallback",
      catalogEntryId: "qwen-fallback-catalog",
    });
    await saveRoute(harness.modelHub, primary.id, {
      remoteContentConsent: true,
      fallbackCatalogEntryId: fallback.id,
    });

    await expect(
      harness.service.inspect({
        dispatchScope: TEST_DISPATCH_SCOPE,
        query: PRIVATE_QUERY,
        documents: PRIVATE_DOCUMENTS,
        topN: 2,
      }),
    ).resolves.toMatchObject({
      connectionId: "qwen-fallback",
      catalogEntryId: "qwen-fallback-catalog",
      usedFallback: true,
    });
  });

  it("does not send documents when the credential rotates in onBeforeDispatch", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "qwen-rotate-before-dispatch",
      catalogEntryId: "qwen-rotate-before-dispatch-catalog",
    });
    await saveRoute(harness.modelHub, target.id, { remoteContentConsent: true });

    await expect(
      harness.service.rerank({
        dispatchScope: TEST_DISPATCH_SCOPE,
        query: PRIVATE_QUERY,
        documents: PRIVATE_DOCUMENTS,
        topN: 2,
        onBeforeDispatch: async ({ connectionId }) => {
          await rotateConnectionCredential(harness.modelHub, connectionId);
        },
      }),
    ).rejects.toMatchObject({ dispatched: false });
    expect(harness.rerank).not.toHaveBeenCalled();
  });

  it("rejects unverified regions and discards results if routing evidence changes after dispatch", async () => {
    const regionHarness = createHarness();
    const regionTarget = await seedTarget(regionHarness.modelHub, {
      connectionId: "qwen-singapore",
      catalogEntryId: "qwen-singapore-catalog",
      region: "singapore",
    });
    await saveRoute(regionHarness.modelHub, regionTarget.id, { remoteContentConsent: true });
    await expect(
      regionHarness.service.inspect({
        dispatchScope: TEST_DISPATCH_SCOPE,
        query: PRIVATE_QUERY,
        documents: PRIVATE_DOCUMENTS,
        topN: 2,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_RERANK_REGION_UNSUPPORTED", dispatched: false });
    expect(regionHarness.rerank).not.toHaveBeenCalled();

    const changedHarness = createHarness();
    const changedTarget = await seedTarget(changedHarness.modelHub, {
      connectionId: "qwen-changing",
      catalogEntryId: "qwen-changing-catalog",
    });
    await saveRoute(changedHarness.modelHub, changedTarget.id, { remoteContentConsent: true });
    changedHarness.rerank.mockImplementation(async () => {
      const profile = await changedHarness.modelHub.findCostPrivacyProfile(changedTarget.id);
      if (profile === null) {
        throw new Error("missing test profile");
      }
      await changedHarness.modelHub.saveCostPrivacyProfile({
        catalogEntryId: changedTarget.id,
        currency: profile.currency,
        inputMicrosPerMillionTokens: profile.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens: profile.outputMicrosPerMillionTokens,
        cachedInputMicrosPerMillionTokens: profile.cachedInputMicrosPerMillionTokens,
        pricingVersion: profile.pricingVersion,
        priceUpdatedAt: profile.priceUpdatedAt,
        dataDestination: "remote",
        retentionPolicy: "temporary",
        trainingPolicy: "not_used",
        evidenceSource: "user_confirmed",
        evidenceVersion: "changed-after-dispatch",
        expectedRevision: profile.revision,
      });
      return {
        provider: "open_ai_compatible",
        protocol: "qwen_open_ai_compatible",
        endpointOrigin: "https://workspace-safe.cn-beijing.maas.aliyuncs.com",
        model: "qwen3-rerank",
        rankings: [{ index: 0, relevanceScore: 0.9 }],
        inputTokens: 20,
      };
    });
    const finishInvocation = vi.spyOn(changedHarness.modelHub, "finishInvocation");

    await expect(
      changedHarness.service.rerank({
        dispatchScope: TEST_DISPATCH_SCOPE,
        query: PRIVATE_QUERY,
        documents: PRIVATE_DOCUMENTS,
        topN: 2,
      }),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_RERANK_CONFIGURATION_CHANGED",
      dispatched: true,
    });
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_HUB_RERANK_CONFIGURATION_CHANGED",
      }),
    );
    expect(JSON.stringify(finishInvocation.mock.calls)).not.toContain(PRIVATE_QUERY);
  });
});

function createHarness(): Readonly<{
  modelHub: BrowserDevelopmentModelHubStore;
  rerank: ReturnType<typeof vi.fn<NativeRerankGatewayClient["rerank"]>>;
  service: ModelHubRerankService;
}> {
  const modelHub = new BrowserDevelopmentModelHubStore(new MemoryStorage(), clock);
  const rerank = vi.fn<NativeRerankGatewayClient["rerank"]>();
  const service = new ModelHubRerankService({
    modelHub,
    gateway: { available: true, rerank },
    credentials: { getSummary: vi.fn(() => Promise.resolve({ configured: true })) },
    ids: new CryptoUuidV7Generator(),
    clock,
  });
  return Object.freeze({ modelHub, rerank, service });
}

async function seedTarget(
  modelHub: ModelHubStore,
  input: Readonly<{
    connectionId: string;
    catalogEntryId: string;
    providerKind?: ModelProviderKind;
    region?: string;
    workspaceId?: string;
  }>,
): Promise<ModelCatalogEntry> {
  const providerKind = input.providerKind ?? "alibaba_qwen";
  const connection = await modelHub.saveConnection({
    id: input.connectionId,
    providerKind,
    displayName: input.connectionId,
    ...(providerKind === "alibaba_qwen"
      ? {
          region: input.region ?? "china_beijing",
          workspaceId: input.workspaceId ?? "workspace-safe",
        }
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
        providerModelId: "qwen3-rerank",
        lifecycle: "stable",
        inputTokenLimit: 120_000,
        staleAfter: "2026-08-02T00:00:00.000Z",
      },
    ],
  });
  const entry = catalog[0];
  if (entry === undefined) {
    throw new Error("test catalog missing");
  }
  await modelHub.recordCapabilityScan({
    scanId: `${entry.id}-scan`,
    catalogEntryId: entry.id,
    scanKind: "user_review",
    status: "succeeded",
    evidenceVersion: "rerank-test-v1",
    evidence: [
      {
        id: `${entry.id}-rerank-evidence`,
        capability: "rerank",
        verdict: "supported",
        evidenceSource: "user_confirmed",
      },
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: entry.id,
    currency: "USD",
    inputMicrosPerMillionTokens: "1000",
    outputMicrosPerMillionTokens: "1000",
    pricingVersion: "rerank-test-v1",
    priceUpdatedAt: NOW,
    dataDestination: "remote",
    retentionPolicy: "temporary",
    trainingPolicy: "not_used",
    evidenceSource: "user_confirmed",
    evidenceVersion: "rerank-test-v1",
    expectedRevision: null,
  });
  return entry;
}

async function saveRoute(
  modelHub: ModelHubStore,
  primaryCatalogEntryId: string,
  input: Readonly<{
    remoteContentConsent: boolean;
    fallbackCatalogEntryId?: string | null;
  }>,
): Promise<NovelTaskRoute> {
  return modelHub.saveTaskRoute({
    task: "rerank",
    primaryCatalogEntryId,
    fallbackCatalogEntryId: input.fallbackCatalogEntryId ?? null,
    parameterPolicy: { remoteContentConsent: input.remoteContentConsent },
    maximumCostMicros: "1000000",
    currency: "USD",
    privacyPolicy: "cloud_allowed",
    failurePolicy: input.fallbackCatalogEntryId === undefined ? "stop" : "use_fallback",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

async function rotateConnectionCredential(
  modelHub: ModelHubStore,
  connectionId: string,
): Promise<void> {
  const connection = await modelHub.findConnection(connectionId);
  if (connection === null) throw new Error("test connection missing");
  await modelHub.saveConnection({
    id: connection.id,
    providerKind: connection.providerKind,
    displayName: connection.displayName,
    region: connection.region,
    workspaceId: connection.workspaceId,
    endpointId: connection.endpointId,
    credentialRef: `keyring:model-hub:${connection.id}-rotated`,
    credentialState: "present",
    authenticationMode: connection.authenticationMode,
    requestTimeoutMs: connection.requestTimeoutMs,
    retryLimit: connection.retryLimit,
    enabled: true,
    expectedRevision: connection.revision,
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
