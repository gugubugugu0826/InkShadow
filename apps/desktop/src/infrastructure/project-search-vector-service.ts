import type { ContentHasher } from "@inkshadow/application";
import {
  SearchVectorIndexStoreError,
  type SearchVectorIndexState,
  type SearchVectorSqliteStore,
  type StoredSearchVectorProject,
} from "@inkshadow/data";
import type { Clock } from "@inkshadow/domain";
import type {
  DocumentEmbedding,
  EmbeddingConfiguration,
  SearchCapabilityStatus,
  SearchDocument,
} from "@inkshadow/search-core";

import type { ModelCenterStore, ModelProfile, NativeProviderKind } from "./model-center-store";
import type { ModelRoleRoute, ModelRoutingStore } from "./model-routing-store";
import type {
  NativeEmbeddingGatewayClient,
  NativeEmbeddingResult,
} from "./native-embedding-gateway";

const MAX_DOCUMENTS = 25_000;
const MAX_BATCH_ITEMS = 32;
const MAX_BATCH_BYTES = 384 * 1024;
const MAX_ITEM_BYTES = 64 * 1024;
const MAX_DIMENSION = 4_096;
const CAPABILITY_PROBE = "InkShadow embedding capability probe";

export type EmbeddingDestinationKind = "local_ollama" | "remote";

export type ProjectEmbeddingReason =
  | "no_embedding_route"
  | "embedding_profile_missing"
  | "embedding_route_profile_mismatch"
  | "native_gateway_unavailable"
  | "vector_store_unavailable"
  | "vector_index_not_built"
  | "embedding_configuration_changed"
  | "authoritative_source_changed"
  | "vector_index_corrupt"
  | "query_embedding_failed"
  | null;

export interface ProjectEmbeddingDiagnostics {
  readonly status: SearchCapabilityStatus;
  readonly reason: ProjectEmbeddingReason;
  readonly providerId: string | null;
  readonly provider: NativeProviderKind | null;
  readonly model: string | null;
  readonly dimension: number | null;
  readonly embeddingCount: number;
  readonly generation: number | null;
  readonly destination: EmbeddingDestinationKind | null;
  readonly endpointOrigin: string | null;
  readonly endpointUrl: string | null;
  readonly confirmationId: string | null;
  readonly lastRebuiltAt: string | null;
  readonly queryFailureCode: string | null;
}

export interface ProjectVectorLoad {
  readonly diagnostics: ProjectEmbeddingDiagnostics;
  readonly configuration: EmbeddingConfiguration | null;
  readonly embeddings: readonly DocumentEmbedding[];
}

export interface QueryEmbeddingOutcome {
  readonly embedding: Readonly<{
    modelId: string;
    values: readonly number[];
  }> | null;
  readonly notice: string | null;
  readonly diagnostics: ProjectEmbeddingDiagnostics;
}

export interface ProjectSearchVectorService {
  synchronizeProject(
    projectId: string,
    documents: readonly SearchDocument[],
    authoritativeSourcesChanged: boolean,
  ): Promise<ProjectVectorLoad>;
  rebuildProject(
    projectId: string,
    documents: readonly SearchDocument[],
    confirmationId: string | null,
  ): Promise<ProjectVectorLoad>;
  embedQuery(load: ProjectVectorLoad, query: string): Promise<QueryEmbeddingOutcome>;
  resetProject(projectId: string): Promise<void>;
  diagnostics(): ProjectEmbeddingDiagnostics;
}

interface ResolvedEmbeddingProfile {
  readonly route: ModelRoleRoute;
  readonly profile: ModelProfile;
  readonly model: string;
  readonly configurationKey: string;
  readonly endpointOrigin: string;
  readonly endpointUrl: string;
  readonly destination: EmbeddingDestinationKind;
}

interface EmbeddingProfileResolution {
  readonly resolved: ResolvedEmbeddingProfile | null;
  readonly diagnostics: ProjectEmbeddingDiagnostics;
}

export class ProjectEmbeddingServiceError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ProjectEmbeddingServiceError";
  }
}

export class PersistentProjectEmbeddingService implements ProjectSearchVectorService {
  private lastDiagnostics = EMPTY_DIAGNOSTICS;

  public constructor(
    private readonly store: SearchVectorSqliteStore | null,
    private readonly routes: ModelRoutingStore,
    private readonly profiles: ModelCenterStore,
    private readonly gateway: NativeEmbeddingGatewayClient,
    private readonly hasher: ContentHasher,
    private readonly clock: Clock,
  ) {}

  public diagnostics(): ProjectEmbeddingDiagnostics {
    return { ...this.lastDiagnostics };
  }

  public async synchronizeProject(
    projectId: string,
    documents: readonly SearchDocument[],
    authoritativeSourcesChanged: boolean,
  ): Promise<ProjectVectorLoad> {
    const resolution = await this.resolveProfile();
    if (resolution.resolved === null || this.store === null) {
      return this.remember(emptyLoad(resolution.diagnostics));
    }

    const resolved = resolution.resolved;
    let stored: StoredSearchVectorProject | null;
    try {
      stored = await this.store.loadProject(projectId);
    } catch (cause: unknown) {
      return this.remember(
        emptyLoad(
          diagnosticsFor(resolved, {
            status: "degraded",
            reason: isVectorCorruption(cause) ? "vector_index_corrupt" : "vector_store_unavailable",
          }),
        ),
      );
    }

    if (stored === null) {
      return this.remember(
        emptyLoad(
          diagnosticsFor(resolved, {
            status: "rebuild_required",
            reason: "vector_index_not_built",
          }),
        ),
      );
    }

    if (stored.state.configuration.modelId !== resolved.configurationKey) {
      return this.remember(
        emptyLoad(
          diagnosticsFor(resolved, {
            status: "rebuild_required",
            reason: "embedding_configuration_changed",
            state: stored.state,
          }),
        ),
      );
    }

    if (
      stored.state.status === "ready" &&
      (authoritativeSourcesChanged || !matchesDocuments(stored.embeddings, documents))
    ) {
      try {
        const marked = await this.store.markProjectRebuildRequired({
          projectId,
          expectedGeneration: stored.state.generation,
          markedAt: this.clock.now(),
        });
        if (marked !== null) {
          stored = { state: marked, embeddings: stored.embeddings };
        }
      } catch {
        return this.remember(
          emptyLoad(
            diagnosticsFor(resolved, {
              status: "degraded",
              reason: "vector_store_unavailable",
              state: stored.state,
            }),
          ),
        );
      }
    }

    if (stored.state.status !== "ready") {
      return this.remember(
        emptyLoad(
          diagnosticsFor(resolved, {
            status: stored.state.status,
            reason:
              authoritativeSourcesChanged || !matchesDocuments(stored.embeddings, documents)
                ? "authoritative_source_changed"
                : "vector_index_not_built",
            state: stored.state,
          }),
        ),
      );
    }

    if (!matchesDocuments(stored.embeddings, documents)) {
      return this.remember(
        emptyLoad(
          diagnosticsFor(resolved, {
            status: "rebuild_required",
            reason: "authoritative_source_changed",
            state: stored.state,
          }),
        ),
      );
    }

    return this.remember({
      diagnostics: diagnosticsFor(resolved, {
        status: "ready",
        reason: null,
        state: stored.state,
      }),
      configuration: stored.state.configuration,
      embeddings: stored.embeddings,
    });
  }

  public async rebuildProject(
    projectId: string,
    documents: readonly SearchDocument[],
    confirmationId: string | null,
  ): Promise<ProjectVectorLoad> {
    const resolution = await this.resolveProfile();
    const resolved = resolution.resolved;
    if (resolved === null) {
      throw embeddingUnavailable(resolution.diagnostics.reason);
    }
    if (this.store === null) {
      throw new ProjectEmbeddingServiceError(
        "VECTOR_STORE_UNAVAILABLE",
        "Persistent vector storage is unavailable in this runtime.",
      );
    }
    if (confirmationId !== null && confirmationId !== resolved.configurationKey) {
      throw new ProjectEmbeddingServiceError(
        "EMBEDDING_CONFIRMATION_STALE",
        "The embedding destination changed before rebuild confirmation.",
        true,
      );
    }
    if (resolved.destination === "remote" && confirmationId !== resolved.configurationKey) {
      throw new ProjectEmbeddingServiceError(
        "EMBEDDING_REMOTE_CONFIRMATION_REQUIRED",
        "Remote embedding requires confirmation for the exact configured destination.",
      );
    }
    if (documents.length > MAX_DOCUMENTS) {
      throw new ProjectEmbeddingServiceError(
        "EMBEDDING_DOCUMENT_LIMIT_EXCEEDED",
        "The project exceeds the supported vector document limit.",
      );
    }

    let current: StoredSearchVectorProject | null;
    try {
      current = await this.store.loadProject(projectId);
    } catch (cause: unknown) {
      throw safeStoreFailure(cause);
    }

    const batches = createBatches(documents);
    const embeddings: DocumentEmbedding[] = [];
    let dimension: number | null = null;

    if (batches.length === 0) {
      const result = await this.callGateway(resolved, [CAPABILITY_PROBE]);
      dimension = validateGatewayResult(result, resolved, 1, null);
    } else {
      for (const batch of batches) {
        const result = await this.callGateway(
          resolved,
          batch.map(({ text }) => text),
        );
        dimension = validateGatewayResult(result, resolved, batch.length, dimension);
        for (const [index, source] of batch.entries()) {
          const values = result.embeddings[index];
          if (values === undefined) {
            throw invalidGatewayResponse();
          }
          embeddings.push(
            Object.freeze({
              documentId: source.document.id,
              projectId,
              sourceVersionId: source.document.sourceVersionId,
              contentHash: source.document.contentHash,
              modelId: resolved.configurationKey,
              values: Object.freeze([...values]),
            }),
          );
        }
      }
    }

    if (dimension === null) {
      throw invalidGatewayResponse();
    }
    const configuration = Object.freeze({
      modelId: resolved.configurationKey,
      dimension,
    });
    try {
      await this.store.replaceProject({
        projectId,
        expectedGeneration: current?.state.generation ?? 0,
        configuration,
        embeddings,
        rebuiltAt: this.clock.now(),
      });
    } catch (cause: unknown) {
      throw safeStoreFailure(cause);
    }
    return this.synchronizeProject(projectId, documents, false);
  }

  public async embedQuery(load: ProjectVectorLoad, query: string): Promise<QueryEmbeddingOutcome> {
    if (load.diagnostics.status !== "ready" || load.configuration === null) {
      return {
        embedding: null,
        notice: fallbackNotice(load.diagnostics.reason),
        diagnostics: load.diagnostics,
      };
    }
    const resolution = await this.resolveProfile();
    const resolved = resolution.resolved;
    if (resolved?.configurationKey !== load.configuration.modelId) {
      const diagnostics = diagnosticsFromLoad(load, {
        status: "rebuild_required",
        reason: "embedding_configuration_changed",
      });
      this.lastDiagnostics = diagnostics;
      return {
        embedding: null,
        notice: fallbackNotice("embedding_configuration_changed"),
        diagnostics,
      };
    }

    try {
      const result = await this.callGateway(resolved, [query]);
      validateGatewayResult(result, resolved, 1, load.configuration.dimension);
      const values = result.embeddings[0];
      if (values === undefined) {
        throw invalidGatewayResponse();
      }
      const diagnostics = diagnosticsFromLoad(load, {
        status: "ready",
        reason: null,
        queryFailureCode: null,
      });
      this.lastDiagnostics = diagnostics;
      return {
        embedding: Object.freeze({
          modelId: resolved.configurationKey,
          values: Object.freeze([...values]),
        }),
        notice: null,
        diagnostics,
      };
    } catch (cause: unknown) {
      const code = safeErrorCode(cause, "EMBEDDING_QUERY_FAILED");
      const diagnostics = diagnosticsFromLoad(load, {
        status: "degraded",
        reason: "query_embedding_failed",
        queryFailureCode: code,
      });
      this.lastDiagnostics = diagnostics;
      return {
        embedding: null,
        notice: `vector_query_failed_${code.toLowerCase()}_keyword_relation_fallback`,
        diagnostics,
      };
    }
  }

  public async resetProject(projectId: string): Promise<void> {
    if (this.store !== null) {
      await this.store.resetProject(projectId);
    }
    this.lastDiagnostics = EMPTY_DIAGNOSTICS;
  }

  private async resolveProfile(): Promise<EmbeddingProfileResolution> {
    if (!this.gateway.available) {
      return {
        resolved: null,
        diagnostics: {
          ...EMPTY_DIAGNOSTICS,
          reason: "native_gateway_unavailable",
        },
      };
    }
    if (this.store === null) {
      return {
        resolved: null,
        diagnostics: {
          ...EMPTY_DIAGNOSTICS,
          reason: "vector_store_unavailable",
        },
      };
    }

    const route = await this.routes.findRoute("embedding");
    if (route === null) {
      return {
        resolved: null,
        diagnostics: {
          ...EMPTY_DIAGNOSTICS,
          reason: "no_embedding_route",
        },
      };
    }
    const profile = await this.profiles.findByProviderId(route.primaryProviderId);
    if (profile === null) {
      return {
        resolved: null,
        diagnostics: unavailableProfileDiagnostics(route, "embedding_profile_missing"),
      };
    }
    if (
      profile.selectedModel === null ||
      profile.selectedModel !== route.primaryModelId ||
      profile.providerId !== route.primaryProviderId
    ) {
      return {
        resolved: null,
        diagnostics: unavailableProfileDiagnostics(
          route,
          "embedding_route_profile_mismatch",
          profile,
        ),
      };
    }

    const endpointOrigin = new URL(profile.baseUrl).origin;
    const endpointUrl = `${profile.baseUrl.replace(/\/$/u, "")}${
      profile.provider === "ollama" ? "/api/embed" : "/embeddings"
    }`;
    const fingerprint = await this.hasher.sha256(
      JSON.stringify([
        profile.providerId,
        profile.provider,
        endpointUrl,
        profile.authentication,
        route.primaryModelId,
      ]),
    );
    if (!fingerprint.ok) {
      throw new ProjectEmbeddingServiceError(
        "EMBEDDING_CONFIGURATION_FINGERPRINT_FAILED",
        "The embedding configuration could not be fingerprinted.",
        fingerprint.error.retryable,
      );
    }
    const configurationKey = `embedding-profile:${fingerprint.value}`;
    const resolved: ResolvedEmbeddingProfile = Object.freeze({
      route,
      profile,
      model: route.primaryModelId,
      configurationKey,
      endpointOrigin,
      endpointUrl,
      destination:
        profile.provider === "ollama" && isLoopbackHost(new URL(profile.baseUrl).hostname)
          ? "local_ollama"
          : "remote",
    });
    return {
      resolved,
      diagnostics: diagnosticsFor(resolved, {
        status: "rebuild_required",
        reason: "vector_index_not_built",
      }),
    };
  }

  private async callGateway(
    resolved: ResolvedEmbeddingProfile,
    inputs: readonly string[],
  ): Promise<NativeEmbeddingResult> {
    try {
      return await this.gateway.embed({
        config: {
          providerId: resolved.profile.providerId,
          provider: resolved.profile.provider,
          baseUrl: resolved.profile.baseUrl,
          authentication: resolved.profile.authentication,
        },
        model: resolved.model,
        inputs,
      });
    } catch (cause: unknown) {
      throw new ProjectEmbeddingServiceError(
        safeErrorCode(cause, "EMBEDDING_GATEWAY_FAILED"),
        "The configured embedding provider request failed.",
        safeRetryable(cause),
      );
    }
  }

  private remember(load: ProjectVectorLoad): ProjectVectorLoad {
    this.lastDiagnostics = load.diagnostics;
    return load;
  }
}

interface BatchedDocument {
  readonly document: SearchDocument;
  readonly text: string;
}

function createBatches(
  documents: readonly SearchDocument[],
): readonly (readonly BatchedDocument[])[] {
  const encoder = new TextEncoder();
  const batches: BatchedDocument[][] = [];
  let current: BatchedDocument[] = [];
  let currentBytes = 0;
  for (const document of documents) {
    const text =
      document.text.length === 0 ? document.title : `${document.title}\n${document.text}`;
    const bytes = encoder.encode(text).byteLength;
    if (bytes < 1 || bytes > MAX_ITEM_BYTES) {
      throw new ProjectEmbeddingServiceError(
        "EMBEDDING_SOURCE_LIMIT_EXCEEDED",
        "A search document exceeds the embedding source limit.",
      );
    }
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_ITEMS || currentBytes + bytes > MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push({ document, text });
    currentBytes += bytes;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

function validateGatewayResult(
  result: NativeEmbeddingResult,
  resolved: ResolvedEmbeddingProfile,
  expectedCount: number,
  expectedDimension: number | null,
): number {
  if (
    result.provider !== resolved.profile.provider ||
    result.endpointOrigin !== resolved.endpointOrigin ||
    result.model !== resolved.model ||
    result.vectorCount !== expectedCount ||
    result.embeddings.length !== expectedCount ||
    !Number.isSafeInteger(result.dimension) ||
    result.dimension < 1 ||
    result.dimension > MAX_DIMENSION ||
    (expectedDimension !== null && result.dimension !== expectedDimension)
  ) {
    throw invalidGatewayResponse();
  }
  for (const vector of result.embeddings) {
    if (
      vector.length !== result.dimension ||
      !vector.every(Number.isFinite) ||
      !vector.some((value) => value !== 0)
    ) {
      throw invalidGatewayResponse();
    }
  }
  return result.dimension;
}

function matchesDocuments(
  embeddings: readonly DocumentEmbedding[],
  documents: readonly SearchDocument[],
): boolean {
  if (embeddings.length !== documents.length) {
    return false;
  }
  const documentsById = new Map(documents.map((document) => [document.id, document]));
  return embeddings.every((embedding) => {
    const document = documentsById.get(embedding.documentId);
    if (document === undefined) {
      return false;
    }
    return (
      embedding.sourceVersionId === document.sourceVersionId &&
      embedding.contentHash === document.contentHash
    );
  });
}

function diagnosticsFor(
  resolved: ResolvedEmbeddingProfile,
  input: Readonly<{
    status: SearchCapabilityStatus;
    reason: ProjectEmbeddingReason;
    state?: SearchVectorIndexState;
  }>,
): ProjectEmbeddingDiagnostics {
  return Object.freeze({
    status: input.status,
    reason: input.reason,
    providerId: resolved.profile.providerId,
    provider: resolved.profile.provider,
    model: resolved.model,
    dimension: input.state?.configuration.dimension ?? null,
    embeddingCount: input.state?.embeddingCount ?? 0,
    generation: input.state?.generation ?? null,
    destination: resolved.destination,
    endpointOrigin: resolved.endpointOrigin,
    endpointUrl: resolved.endpointUrl,
    confirmationId: resolved.configurationKey,
    lastRebuiltAt: input.state?.lastRebuiltAt ?? null,
    queryFailureCode: null,
  });
}

function unavailableProfileDiagnostics(
  route: ModelRoleRoute,
  reason: ProjectEmbeddingReason,
  profile?: ModelProfile,
): ProjectEmbeddingDiagnostics {
  return Object.freeze({
    ...EMPTY_DIAGNOSTICS,
    status: "rebuild_required",
    reason,
    providerId: route.primaryProviderId,
    provider: profile?.provider ?? null,
    model: route.primaryModelId,
    endpointOrigin: profile === undefined ? null : new URL(profile.baseUrl).origin,
    endpointUrl:
      profile === undefined
        ? null
        : `${profile.baseUrl.replace(/\/$/u, "")}${
            profile.provider === "ollama" ? "/api/embed" : "/embeddings"
          }`,
  });
}

function diagnosticsFromLoad(
  load: ProjectVectorLoad,
  changes: Partial<ProjectEmbeddingDiagnostics>,
): ProjectEmbeddingDiagnostics {
  return Object.freeze({ ...load.diagnostics, ...changes });
}

function emptyLoad(diagnostics: ProjectEmbeddingDiagnostics): ProjectVectorLoad {
  return Object.freeze({
    diagnostics,
    configuration: null,
    embeddings: Object.freeze([]),
  });
}

function fallbackNotice(reason: ProjectEmbeddingReason): string {
  const suffix = reason ?? "unavailable";
  return `vector_${suffix}_keyword_relation_fallback`;
}

function embeddingUnavailable(reason: ProjectEmbeddingReason): ProjectEmbeddingServiceError {
  const code =
    reason === "no_embedding_route"
      ? "EMBEDDING_ROUTE_NOT_CONFIGURED"
      : reason === "native_gateway_unavailable"
        ? "MODEL_NATIVE_GATEWAY_UNAVAILABLE"
        : reason === "embedding_route_profile_mismatch"
          ? "EMBEDDING_ROUTE_PROFILE_MISMATCH"
          : "EMBEDDING_PROFILE_UNAVAILABLE";
  return new ProjectEmbeddingServiceError(
    code,
    "A usable primary embedding route is not configured.",
  );
}

function safeStoreFailure(cause: unknown): ProjectEmbeddingServiceError {
  return new ProjectEmbeddingServiceError(
    cause instanceof SearchVectorIndexStoreError ? cause.code : "VECTOR_INDEX_UNAVAILABLE",
    "The persistent vector index operation failed.",
    cause instanceof SearchVectorIndexStoreError && cause.retryable,
  );
}

function invalidGatewayResponse(): ProjectEmbeddingServiceError {
  return new ProjectEmbeddingServiceError(
    "MODEL_RESPONSE_INVALID",
    "The embedding provider returned an invalid response.",
  );
}

function safeErrorCode(cause: unknown, fallback: string): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,79}$/u.test(cause.code)
  ) {
    return cause.code;
  }
  return fallback;
}

function safeRetryable(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "retryable" in cause && cause.retryable === true
  );
}

function isVectorCorruption(cause: unknown): boolean {
  return cause instanceof SearchVectorIndexStoreError && cause.code === "VECTOR_INDEX_CORRUPT";
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every(
      (octet) =>
        /^\d{1,3}$/u.test(octet) &&
        Number.parseInt(octet, 10) >= 0 &&
        Number.parseInt(octet, 10) <= 255,
    )
  );
}

const EMPTY_DIAGNOSTICS: ProjectEmbeddingDiagnostics = Object.freeze({
  status: "disabled",
  reason: "no_embedding_route",
  providerId: null,
  provider: null,
  model: null,
  dimension: null,
  embeddingCount: 0,
  generation: null,
  destination: null,
  endpointOrigin: null,
  endpointUrl: null,
  confirmationId: null,
  lastRebuiltAt: null,
  queryFailureCode: null,
});
