import type { ContentHasher } from "@inkshadow/application";
import type {
  SearchVectorIndexState,
  SearchVectorSqliteStore,
  StoredSearchVectorProject,
} from "@inkshadow/data";
import { parseContentChecksum, parseIsoUtcTimestamp, type Clock } from "@inkshadow/domain";
import { CryptoUuidV7Generator } from "@inkshadow/platform";
import type { DocumentEmbedding, SearchDocument } from "@inkshadow/search-core";
import { describe, expect, it, vi } from "vitest";

import type { ModelCenterStore, ModelProfile } from "./model-center-store";
import {
  inspectModelHubEmbeddingTask,
  type ModelHubEmbeddingExecutionDependencies,
} from "./model-hub-embedding-service";
import type { ModelProviderKind } from "./model-hub-provider-registry";
import {
  BrowserDevelopmentModelHubStore,
  type ModelHubStore,
  type NovelTaskRoute,
} from "./model-hub-store";
import type { ModelRoleRoute, ModelRoutingStore } from "./model-routing-store";
import type {
  NativeEmbeddingGatewayClient,
  NativeEmbeddingInput,
} from "./native-embedding-gateway";
import {
  PersistentProjectEmbeddingService,
  ProjectEmbeddingServiceError,
} from "./project-search-vector-service";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const NOW = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T01:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const FIXED_NOW = parsedNow.value;

describe("persistent project embedding service", () => {
  it("binds remote confirmation to the exact endpoint path and never uses fallback routing", async () => {
    const store = new InMemoryVectorStore();
    const gateway = new FakeEmbeddingGateway();
    const hasher = fingerprintHasher();
    const service = createService({
      store,
      gateway,
      hasher,
      route: route(),
      profile: profile("https://models.example/tenant/v1"),
    });
    const documents = [document(0, "first authoritative text")];

    const initial = await service.synchronizeProject(PROJECT_ID, documents, false);
    expect(initial.diagnostics).toMatchObject({
      status: "rebuild_required",
      reason: "vector_index_not_built",
      destination: "remote",
      endpointUrl: "https://models.example/tenant/v1/embeddings",
    });
    await expect(service.rebuildProject(PROJECT_ID, documents, null)).rejects.toMatchObject({
      code: "EMBEDDING_REMOTE_CONFIRMATION_REQUIRED",
    });
    expect(gateway.inputs).toHaveLength(0);

    const rebuilt = await service.rebuildProject(
      PROJECT_ID,
      documents,
      initial.diagnostics.confirmationId,
    );

    expect(rebuilt.diagnostics).toMatchObject({
      status: "ready",
      model: "embed-primary",
      dimension: 2,
      embeddingCount: 1,
    });
    expect(gateway.inputs).toHaveLength(1);
    expect(gateway.inputs[0]).toMatchObject({
      model: "embed-primary",
      config: {
        providerId: "primary-provider",
        baseUrl: "https://models.example/tenant/v1",
      },
    });
    expect(gateway.inputs[0]?.config.providerId).not.toBe("fallback-provider");
    expect(hasher.inputs[0]).toContain("https://models.example/tenant/v1/embeddings");
  });

  it("batches bounded documents, reloads the exact ready generation, and detects config drift", async () => {
    const store = new InMemoryVectorStore();
    const gateway = new FakeEmbeddingGateway();
    const hasher = fingerprintHasher();
    const firstProfile = profile("https://models.example/v1");
    const documents = Array.from({ length: 33 }, (_, index) =>
      document(index, `authoritative-${String(index)}`),
    );
    const first = createService({
      store,
      gateway,
      hasher,
      route: route(),
      profile: firstProfile,
    });
    const initial = await first.synchronizeProject(PROJECT_ID, documents, false);
    await first.rebuildProject(PROJECT_ID, documents, initial.diagnostics.confirmationId);

    expect(gateway.inputs.map(({ inputs }) => inputs.length)).toEqual([32, 1]);
    expect(store.project?.embeddings).toHaveLength(33);
    const callsAfterRebuild = gateway.inputs.length;

    const restarted = createService({
      store,
      gateway,
      hasher,
      route: route(),
      profile: firstProfile,
    });
    const loaded = await restarted.synchronizeProject(PROJECT_ID, documents, false);
    expect(loaded.diagnostics.status).toBe("ready");
    expect(loaded.embeddings).toHaveLength(33);
    expect(gateway.inputs).toHaveLength(callsAfterRebuild);

    const changed = createService({
      store,
      gateway,
      hasher,
      route: route(),
      profile: profile("https://models.example/v2"),
    });
    const drifted = await changed.synchronizeProject(PROJECT_ID, documents, false);
    expect(drifted.diagnostics).toMatchObject({
      status: "rebuild_required",
      reason: "embedding_configuration_changed",
    });
    expect(store.project?.state.status).toBe("ready");
    expect(gateway.inputs).toHaveLength(callsAfterRebuild);
  });

  it("marks authoritative source drift and visibly degrades only the failed query", async () => {
    const store = new InMemoryVectorStore();
    const gateway = new FakeEmbeddingGateway();
    const service = createService({
      store,
      gateway,
      hasher: fingerprintHasher(),
      route: route(),
      profile: profile("http://127.0.0.1:11434", "ollama"),
    });
    const documents = [document(0, "stable")];
    const ready = await service.rebuildProject(PROJECT_ID, documents, null);
    expect(ready.diagnostics.destination).toBe("local_ollama");

    gateway.failure = Object.assign(new Error("query text must not escape"), {
      code: "MODEL_TIMEOUT",
      retryable: true,
    });
    const query = await service.embedQuery(ready, "private query");
    expect(query.embedding).toBeNull();
    expect(query.notice).toBe("vector_query_failed_model_timeout_keyword_relation_fallback");
    expect(query.diagnostics).toMatchObject({
      status: "degraded",
      reason: "query_embedding_failed",
      queryFailureCode: "MODEL_TIMEOUT",
    });
    expect(JSON.stringify(query)).not.toContain("private query");
    expect(JSON.stringify(query)).not.toContain("query text must not escape");

    gateway.failure = null;
    const firstDocument = documents[0];
    if (firstDocument === undefined) {
      throw new Error("Expected a source document.");
    }
    const changedDocuments = [{ ...firstDocument, contentHash: "b".repeat(64) }];
    const drifted = await service.synchronizeProject(PROJECT_ID, changedDocuments, true);
    expect(drifted.diagnostics).toMatchObject({
      status: "rebuild_required",
      reason: "authoritative_source_changed",
    });
    expect(store.markCalls).toBe(1);
  });

  it("reports browser and missing-route capability as unavailable without synthetic vectors", async () => {
    const gateway = new FakeEmbeddingGateway();
    gateway.available = false;
    const service = createService({
      store: null,
      gateway,
      hasher: fingerprintHasher(),
      route: null,
      profile: null,
    });

    const load = await service.synchronizeProject(PROJECT_ID, [document(0, "stable")], false);

    expect(load.diagnostics).toMatchObject({
      status: "disabled",
      reason: "native_gateway_unavailable",
    });
    expect(load.embeddings).toEqual([]);
    expect(gateway.inputs).toEqual([]);
  });

  it("prioritizes Model Hub for remote rebuild and query with an exact content-free confirmation fingerprint", async () => {
    const store = new InMemoryVectorStore();
    const gateway = new FakeEmbeddingGateway();
    const hasher = fingerprintHasher();
    const modelHub = await createModelHubHarness(gateway, {
      connectionId: "model-hub-gemini",
      catalogEntryId: "model-hub-gemini-catalog",
      modelId: "models/model-hub-embedding",
      providerKind: "google_gemini",
    });
    const startInvocation = vi.spyOn(modelHub.store, "startInvocation");
    const finishInvocation = vi.spyOn(modelHub.store, "finishInvocation");
    const service = createService({
      store,
      gateway,
      hasher,
      route: route(),
      profile: profile("https://legacy-must-not-run.example/v1"),
      modelHub: modelHub.dependencies,
    });
    const documents = [document(0, "MODEL_HUB_PRIVATE_REBUILD_TEXT")];
    const expectedInspection = await inspectModelHubEmbeddingTask(modelHub.dependencies, {
      inputs: ["InkShadow embedding capability probe"],
    });

    const initial = await service.synchronizeProject(PROJECT_ID, documents, false);

    expect(initial.diagnostics).toMatchObject({
      status: "rebuild_required",
      reason: "vector_index_not_built",
      providerId: "model-hub-gemini",
      provider: "gemini",
      model: "models/model-hub-embedding",
      destination: "remote",
      endpointOrigin: null,
      endpointUrl: null,
      confirmationId: `embedding-model-hub:${"a".repeat(64)}`,
    });
    expect(hasher.inputs[0]).toBe(JSON.stringify(expectedInspection.fingerprintMaterial));
    await expect(service.rebuildProject(PROJECT_ID, documents, null)).rejects.toMatchObject({
      code: "EMBEDDING_REMOTE_CONFIRMATION_REQUIRED",
    });
    expect(gateway.inputs).toHaveLength(0);

    const rebuilt = await service.rebuildProject(
      PROJECT_ID,
      documents,
      initial.diagnostics.confirmationId,
    );
    const query = await service.embedQuery(rebuilt, "MODEL_HUB_PRIVATE_QUERY_TEXT");

    expect(rebuilt.diagnostics).toMatchObject({
      status: "ready",
      providerId: "model-hub-gemini",
      provider: "gemini",
      model: "models/model-hub-embedding",
      dimension: 2,
      embeddingCount: 1,
    });
    expect(query.embedding).toMatchObject({
      modelId: initial.diagnostics.confirmationId,
      values: [1, 1],
    });
    expect(gateway.inputs).toHaveLength(2);
    expect(gateway.inputs[0]).toMatchObject({
      config: {
        providerId: "model-hub-gemini",
        provider: "gemini",
      },
      model: "models/model-hub-embedding",
      inputs: ["Chapter 0\nMODEL_HUB_PRIVATE_REBUILD_TEXT"],
    });
    expect(gateway.inputs[1]).toMatchObject({
      config: {
        providerId: "model-hub-gemini",
        provider: "gemini",
      },
      model: "models/model-hub-embedding",
      inputs: ["MODEL_HUB_PRIVATE_QUERY_TEXT"],
    });
    expect(startInvocation).toHaveBeenCalledTimes(2);
    expect(finishInvocation).toHaveBeenCalledTimes(2);
    const ledgerPayload = JSON.stringify({
      start: startInvocation.mock.calls,
      finish: finishInvocation.mock.calls,
    });
    expect(ledgerPayload).not.toContain("MODEL_HUB_PRIVATE_REBUILD_TEXT");
    expect(ledgerPayload).not.toContain("MODEL_HUB_PRIVATE_QUERY_TEXT");
    expect(ledgerPayload).not.toMatch(/"(?:inputs|content|text|embeddings|vector)"/iu);
    for (const fingerprintInput of hasher.inputs) {
      expect(fingerprintInput).toBe(JSON.stringify(expectedInspection.fingerprintMaterial));
      expect(fingerprintInput).not.toContain("MODEL_HUB_PRIVATE");
      expect(fingerprintInput).not.toContain("generativelanguage.googleapis.com");
      expect(fingerprintInput).not.toContain("InkShadow embedding capability probe");
    }
  });

  it("allows an evidence-confirmed local Model Hub route to rebuild without confirmation", async () => {
    const store = new InMemoryVectorStore();
    const gateway = new FakeEmbeddingGateway();
    const modelHub = await createModelHubHarness(gateway, {
      connectionId: "model-hub-local",
      catalogEntryId: "model-hub-local-catalog",
      modelId: "nomic-embed-text",
      providerKind: "ollama",
      destination: "local",
      privacyPolicy: "local_only",
    });
    const service = createService({
      store,
      gateway,
      hasher: fingerprintHasher(),
      route: route(),
      profile: profile("https://legacy-must-not-run.example/v1"),
      modelHub: modelHub.dependencies,
    });

    const rebuilt = await service.rebuildProject(
      PROJECT_ID,
      [document(0, "local model hub text")],
      null,
    );

    expect(rebuilt.diagnostics).toMatchObject({
      status: "ready",
      providerId: "model-hub-local",
      provider: "ollama",
      model: "nomic-embed-text",
      destination: "local_ollama",
    });
    expect(gateway.inputs).toHaveLength(1);
    expect(gateway.inputs[0]).toMatchObject({
      config: {
        providerId: "model-hub-local",
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        authentication: "none",
      },
      model: "nomic-embed-text",
    });
  });

  it("uses legacy embedding only when Model Hub reports that no route is configured", async () => {
    const store = new InMemoryVectorStore();
    const gateway = new FakeEmbeddingGateway();
    const hasher = fingerprintHasher();
    const modelHub = await createModelHubHarness(gateway, null);
    const service = createService({
      store,
      gateway,
      hasher,
      route: route(),
      profile: profile("https://legacy-fallback.example/v1"),
      modelHub: modelHub.dependencies,
    });

    const initial = await service.synchronizeProject(
      PROJECT_ID,
      [document(0, "legacy fallback")],
      false,
    );

    expect(initial.diagnostics).toMatchObject({
      providerId: "primary-provider",
      provider: "open_ai_compatible",
      model: "embed-primary",
      endpointUrl: "https://legacy-fallback.example/v1/embeddings",
    });
    expect(hasher.inputs[0]).toContain("https://legacy-fallback.example/v1/embeddings");
    const rebuilt = await service.rebuildProject(
      PROJECT_ID,
      [document(0, "legacy fallback")],
      initial.diagnostics.confirmationId,
    );
    expect(rebuilt.diagnostics.status).toBe("ready");
    expect(gateway.inputs[0]).toMatchObject({
      config: { providerId: "primary-provider" },
      model: "embed-primary",
    });
    expect(await modelHub.store.findTaskRoute("embedding")).toBeNull();
  });

  it("never bypasses a Model Hub capability policy failure through a valid legacy profile", async () => {
    const store = new InMemoryVectorStore();
    const gateway = new FakeEmbeddingGateway();
    const modelHub = await createModelHubHarness(gateway, {
      connectionId: "model-hub-unverified",
      catalogEntryId: "model-hub-unverified-catalog",
      modelId: "model-hub-unverified-model",
      includeCapability: false,
    });
    const service = createService({
      store,
      gateway,
      hasher: fingerprintHasher(),
      route: route(),
      profile: profile("https://legacy-unsafe-bypass.example/v1"),
      modelHub: modelHub.dependencies,
    });
    const startInvocation = vi.spyOn(modelHub.store, "startInvocation");

    await expect(
      service.synchronizeProject(PROJECT_ID, [document(0, "must remain private")], false),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(gateway.inputs).toHaveLength(0);
  });

  it("aborts before native dispatch when the inspected Model Hub selection drifts", async () => {
    const store = new InMemoryVectorStore();
    const gateway = new FakeEmbeddingGateway();
    const modelHub = await createModelHubHarness(gateway, {
      connectionId: "drift-primary",
      catalogEntryId: "drift-primary-catalog",
      modelId: "drift-primary-model",
    });
    const secondaryCatalogId = await seedAdditionalModelHubTarget(modelHub.store, {
      connectionId: "drift-secondary",
      catalogEntryId: "drift-secondary-catalog",
      modelId: "drift-secondary-model",
    });
    let fingerprintCall = 0;
    const hasher: ContentHasher = {
      sha256: async () => {
        fingerprintCall += 1;
        if (fingerprintCall === 3) {
          const activeRoute = await modelHub.store.findTaskRoute("embedding");
          if (activeRoute === null) {
            throw new Error("expected active embedding route");
          }
          await modelHub.store.saveTaskRoute({
            task: "embedding",
            primaryCatalogEntryId: secondaryCatalogId,
            fallbackCatalogEntryId: null,
            parameterPolicy: {},
            maximumCostMicros: null,
            currency: null,
            privacyPolicy: "cloud_allowed",
            failurePolicy: "stop",
            routeOrigin: "user",
            expectedRevision: activeRoute.revision,
          });
        }
        return parseContentChecksum("a".repeat(64));
      },
    };
    const service = createService({
      store,
      gateway,
      hasher,
      route: route(),
      profile: profile("https://legacy-must-not-run.example/v1"),
      modelHub: modelHub.dependencies,
    });
    const startInvocation = vi.spyOn(modelHub.store, "startInvocation");
    const finishInvocation = vi.spyOn(modelHub.store, "finishInvocation");
    const documents = [document(0, "MODEL_HUB_DRIFT_PRIVATE_TEXT")];
    const initial = await service.synchronizeProject(PROJECT_ID, documents, false);

    await expect(
      service.rebuildProject(PROJECT_ID, documents, initial.diagnostics.confirmationId),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_EMBEDDING_SELECTION_DRIFT",
    });
    expect(gateway.inputs).toHaveLength(0);
    expect(store.project).toBeNull();
    expect(startInvocation).toHaveBeenCalledOnce();
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "drift-secondary",
        catalogEntryId: "drift-secondary-catalog",
        modelIdSnapshot: "drift-secondary-model",
      }),
    );
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "MODEL_HUB_EMBEDDING_SELECTION_DRIFT",
      }),
    );
    expect(JSON.stringify(finishInvocation.mock.calls)).not.toContain(
      "MODEL_HUB_DRIFT_PRIVATE_TEXT",
    );
  });
});

class InMemoryVectorStore {
  public project: StoredSearchVectorProject | null = null;
  public markCalls = 0;

  public loadProject(): Promise<StoredSearchVectorProject | null> {
    return Promise.resolve(this.project);
  }

  public replaceProject(input: {
    readonly expectedGeneration: number;
    readonly configuration: { readonly modelId: string; readonly dimension: number };
    readonly embeddings: readonly DocumentEmbedding[];
    readonly rebuiltAt: string;
  }): Promise<SearchVectorIndexState> {
    const currentGeneration = this.project?.state.generation ?? 0;
    if (currentGeneration !== input.expectedGeneration) {
      return Promise.reject(
        new ProjectEmbeddingServiceError("VECTOR_INDEX_CONFLICT", "conflict", true),
      );
    }
    const state: SearchVectorIndexState = {
      projectId: PROJECT_ID,
      generation: currentGeneration + 1,
      configuration: input.configuration,
      status: "ready",
      embeddingCount: input.embeddings.length,
      lastRebuiltAt: input.rebuiltAt,
      updatedAt: input.rebuiltAt,
    };
    this.project = {
      state,
      embeddings: Object.freeze([...input.embeddings]),
    };
    return Promise.resolve(state);
  }

  public markProjectRebuildRequired(input: {
    readonly expectedGeneration: number;
    readonly markedAt: string;
  }): Promise<SearchVectorIndexState | null> {
    this.markCalls += 1;
    if (this.project?.state.generation !== input.expectedGeneration) {
      return Promise.reject(new Error("generation conflict"));
    }
    const state: SearchVectorIndexState = {
      ...this.project.state,
      generation: this.project.state.generation + 1,
      status: "rebuild_required",
      updatedAt: input.markedAt,
    };
    this.project = { ...this.project, state };
    return Promise.resolve(state);
  }

  public resetProject(): Promise<void> {
    this.project = null;
    return Promise.resolve();
  }
}

class FakeEmbeddingGateway implements NativeEmbeddingGatewayClient {
  public available = true;
  public readonly inputs: NativeEmbeddingInput[] = [];
  public failure: Error | null = null;

  public embed(input: NativeEmbeddingInput) {
    this.inputs.push(input);
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    const embeddings = input.inputs.map((_, index) => [index + 1, 1]);
    return Promise.resolve({
      provider: input.config.provider,
      endpointOrigin: new URL(input.config.baseUrl).origin,
      model: input.model,
      dimension: 2,
      vectorCount: embeddings.length,
      embeddings,
    });
  }
}

async function createModelHubHarness(
  gateway: NativeEmbeddingGatewayClient,
  target: Readonly<{
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
    providerKind?: ModelProviderKind;
    includeCapability?: boolean;
    destination?: "local" | "remote";
    privacyPolicy?: NovelTaskRoute["privacyPolicy"];
  }> | null,
): Promise<
  Readonly<{
    store: BrowserDevelopmentModelHubStore;
    dependencies: ModelHubEmbeddingExecutionDependencies;
  }>
> {
  const clock: Clock = { now: () => FIXED_NOW };
  const store = new BrowserDevelopmentModelHubStore(new MemoryStorage(), clock);
  if (target !== null) {
    const providerKind = target.providerKind ?? "custom_openai_compatible";
    const local = target.destination === "local" || providerKind === "ollama";
    const connection = await store.saveConnection({
      id: target.connectionId,
      providerKind,
      displayName: target.connectionId,
      ...(providerKind === "custom_openai_compatible"
        ? { baseUrlOverride: `https://${target.connectionId}.example.test/v1` }
        : {}),
      credentialRef: local ? null : `keyring:test:${target.connectionId}`,
      credentialState: local ? "missing" : "present",
      expectedRevision: null,
    });
    await store.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    const catalog = await store.syncCatalog({
      syncId: `${target.connectionId}-sync`,
      connectionId: connection.id,
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: target.catalogEntryId,
          providerModelId: target.modelId,
          lifecycle: "stable",
          inputTokenLimit: 200_000,
          outputTokenLimit: null,
          staleAfter: "2026-07-29T00:00:00.000Z",
        },
      ],
    });
    const entry = catalog.find(({ id }) => id === target.catalogEntryId);
    if (entry === undefined) {
      throw new Error("test Model Hub catalog entry missing");
    }
    if (target.includeCapability !== false) {
      await store.recordCapabilityScan({
        scanId: `${target.connectionId}-embedding-scan`,
        catalogEntryId: entry.id,
        scanKind: "lightweight_probe",
        status: "succeeded",
        evidenceVersion: "vector-service-test-v1",
        evidence: [
          {
            id: `${target.connectionId}-embedding-evidence`,
            capability: "embedding",
            verdict: "supported",
            evidenceSource: "lightweight_probe",
          },
        ],
      });
    }
    await store.saveCostPrivacyProfile({
      catalogEntryId: entry.id,
      dataDestination: local ? "local" : (target.destination ?? "remote"),
      retentionPolicy: local ? "none" : "provider_default",
      trainingPolicy: local ? "not_used" : "unknown",
      evidenceSource: "user_confirmed",
      evidenceVersion: "vector-service-test-v1",
      expectedRevision: null,
    });
    await store.saveTaskRoute({
      task: "embedding",
      primaryCatalogEntryId: entry.id,
      fallbackCatalogEntryId: null,
      parameterPolicy: {},
      maximumCostMicros: null,
      currency: null,
      privacyPolicy: target.privacyPolicy ?? "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });
  }
  return Object.freeze({
    store,
    dependencies: {
      modelHub: store,
      modelGateway: gateway,
      credentials: {
        getSummary: vi.fn(() => Promise.resolve({ configured: true })),
      },
      clock,
      ids: new CryptoUuidV7Generator(),
    },
  });
}

async function seedAdditionalModelHubTarget(
  store: ModelHubStore,
  target: Readonly<{
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
  }>,
): Promise<string> {
  const connection = await store.saveConnection({
    id: target.connectionId,
    providerKind: "custom_openai_compatible",
    displayName: target.connectionId,
    baseUrlOverride: `https://${target.connectionId}.example.test/v1`,
    credentialRef: `keyring:test:${target.connectionId}`,
    credentialState: "present",
    expectedRevision: null,
  });
  await store.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  const catalog = await store.syncCatalog({
    syncId: `${target.connectionId}-sync`,
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: target.catalogEntryId,
        providerModelId: target.modelId,
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: null,
        staleAfter: "2026-07-29T00:00:00.000Z",
      },
    ],
  });
  const entry = catalog.find(({ id }) => id === target.catalogEntryId);
  if (entry === undefined) {
    throw new Error("additional Model Hub catalog entry missing");
  }
  await store.recordCapabilityScan({
    scanId: `${target.connectionId}-embedding-scan`,
    catalogEntryId: entry.id,
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "vector-service-test-v1",
    evidence: [
      {
        id: `${target.connectionId}-embedding-evidence`,
        capability: "embedding",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await store.saveCostPrivacyProfile({
    catalogEntryId: entry.id,
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "vector-service-test-v1",
    expectedRevision: null,
  });
  return entry.id;
}

function createService(input: {
  readonly store: InMemoryVectorStore | null;
  readonly gateway: NativeEmbeddingGatewayClient;
  readonly hasher: ContentHasher;
  readonly route: ModelRoleRoute | null;
  readonly profile: ModelProfile | null;
  readonly modelHub?: ModelHubEmbeddingExecutionDependencies | null;
}): PersistentProjectEmbeddingService {
  const routes: ModelRoutingStore = {
    listRoutes: () => Promise.resolve(input.route === null ? [] : [input.route]),
    findRoute: () => Promise.resolve(input.route),
    saveRoute: () => Promise.reject(new Error("not used")),
    deleteRoute: () => Promise.reject(new Error("not used")),
  };
  const profiles: ModelCenterStore = {
    listProfiles: () => Promise.resolve(input.profile === null ? [] : [input.profile]),
    findByProviderId: () => Promise.resolve(input.profile),
    save: () => Promise.reject(new Error("not used")),
  };
  const clock: Clock = {
    now: vi.fn().mockReturnValueOnce(NOW).mockReturnValue(LATER),
  };
  return new PersistentProjectEmbeddingService(
    input.store as unknown as SearchVectorSqliteStore | null,
    routes,
    profiles,
    input.gateway,
    input.hasher,
    clock,
    input.modelHub ?? null,
  );
}

function fingerprintHasher(): ContentHasher & { readonly inputs: string[] } {
  const inputs: string[] = [];
  return {
    inputs,
    sha256: (value: string) => {
      inputs.push(value);
      const fingerprint = value.includes("/v2/") ? "b".repeat(64) : "a".repeat(64);
      return Promise.resolve(parseContentChecksum(fingerprint));
    },
  };
}

function route(): ModelRoleRoute {
  return {
    role: "embedding",
    primaryProviderId: "primary-provider",
    primaryModelId: "embed-primary",
    fallbackProviderId: "fallback-provider",
    fallbackModelId: "embed-fallback",
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function profile(
  baseUrl: string,
  provider: ModelProfile["provider"] = "open_ai_compatible",
): ModelProfile {
  return {
    providerId: "primary-provider",
    provider,
    baseUrl,
    authentication: "none",
    selectedModel: "embed-primary",
    pricing: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function document(index: number, text: string): SearchDocument {
  return {
    id: `chapter:019f9f4a-b3c7-7350-9226-${String(index).padStart(12, "0")}:0`,
    projectId: PROJECT_ID,
    sourceType: "chapter",
    sourceId: `019f9f4a-b3c7-7350-9226-${String(index).padStart(12, "0")}`,
    sourceVersionId: `019f9f4a-b3c7-7350-9227-${String(index).padStart(12, "0")}`,
    title: `Chapter ${String(index)}`,
    text,
    contentHash: "a".repeat(64),
    updatedAt: NOW,
  };
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
