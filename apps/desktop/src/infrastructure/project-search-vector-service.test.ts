import type { ContentHasher } from "@inkshadow/application";
import type {
  SearchVectorIndexState,
  SearchVectorSqliteStore,
  StoredSearchVectorProject,
} from "@inkshadow/data";
import { parseContentChecksum, type Clock } from "@inkshadow/domain";
import type { DocumentEmbedding, SearchDocument } from "@inkshadow/search-core";
import { describe, expect, it, vi } from "vitest";

import type { ModelCenterStore, ModelProfile } from "./model-center-store";
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

function createService(input: {
  readonly store: InMemoryVectorStore | null;
  readonly gateway: NativeEmbeddingGatewayClient;
  readonly hasher: ContentHasher;
  readonly route: ModelRoleRoute | null;
  readonly profile: ModelProfile | null;
}): PersistentProjectEmbeddingService {
  const routes: ModelRoutingStore = {
    listRoutes: () => Promise.resolve(input.route === null ? [] : [input.route]),
    findRoute: () => Promise.resolve(input.route),
    saveRoute: () => Promise.reject(new Error("not used")),
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
