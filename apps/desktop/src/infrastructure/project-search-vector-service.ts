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

import type { ModelCenterStore, ModelProfile } from "./model-center-store";
import {
  nativeGatewayEndpointIdentity,
  resolveModelProfileGatewayConfig,
} from "./model-profile-gateway-config";
import {
  executeModelHubEmbeddingTask,
  inspectModelHubEmbeddingTask,
  type ModelHubEmbeddingExecutionDependencies,
  type ModelHubEmbeddingTaskInspection,
} from "./model-hub-embedding-service";
import { ModelHubExecutionError } from "./model-hub-execution-service";
import type { ModelRoleRoute, ModelRoutingStore } from "./model-routing-store";
import type {
  NativeEmbeddingGatewayClient,
  NativeEmbeddingResult,
} from "./native-embedding-gateway";
import type {
  NativeGatewayEndpointConfig,
  NativeGatewayProviderKind,
} from "./native-model-gateway-contract";
import {
  ProjectContextPrivacyError,
  projectContextDispatchScope,
  type ProjectContextPrivacyAuthority,
  type ProjectContextPrivacyReceipt,
} from "./project-context-privacy-authority";

const MAX_DOCUMENTS = 25_000;
const MAX_BATCH_ITEMS = 32;
const MAX_BATCH_BYTES = 384 * 1024;
const MAX_ITEM_BYTES = 64 * 1024;
const MAX_DIMENSION = 4_096;
const CAPABILITY_PROBE = "InkShadow embedding capability probe";

type ProjectEmbeddingGatewayDispatch = Readonly<{
  kind: "project_context";
  inputs: readonly string[];
  receipt: ProjectContextPrivacyReceipt;
}>;

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
  readonly provider: NativeGatewayProviderKind | null;
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
  /** Project authority bound to this load; required before any query-vector egress. */
  readonly projectId: string;
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

export type RemoteEmbeddingDocumentFilter = (
  projectId: string,
  documents: readonly SearchDocument[],
) => Promise<readonly SearchDocument[]>;

interface ResolvedEmbeddingProfileBase {
  readonly source: "model_hub" | "legacy";
  readonly providerId: string;
  readonly provider: NativeGatewayProviderKind;
  readonly model: string;
  readonly configurationKey: string;
  readonly endpointOrigin: string | null;
  readonly endpointUrl: string | null;
  readonly destination: EmbeddingDestinationKind;
}

interface ResolvedLegacyEmbeddingProfile extends ResolvedEmbeddingProfileBase {
  readonly source: "legacy";
  readonly route: ModelRoleRoute;
  readonly profile: ModelProfile;
  /** Exact non-secret endpoint and credential-slot identity inspected initially. */
  readonly endpointConfig: NativeGatewayEndpointConfig;
}

interface ResolvedModelHubEmbeddingProfile extends ResolvedEmbeddingProfileBase {
  readonly source: "model_hub";
  readonly inspection: ModelHubEmbeddingTaskInspection;
}

type ResolvedEmbeddingProfile = ResolvedLegacyEmbeddingProfile | ResolvedModelHubEmbeddingProfile;

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
    private readonly modelHub: ModelHubEmbeddingExecutionDependencies | null = null,
    private readonly filterRemoteEligibleDocuments?: RemoteEmbeddingDocumentFilter,
    private readonly projectContextPrivacy: Pick<
      ProjectContextPrivacyAuthority,
      "inspect" | "assertCurrentBeforeDispatch" | "assertRouteEligible"
    > | null = null,
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
      return this.remember(emptyLoad(projectId, resolution.diagnostics));
    }

    const resolved = resolution.resolved;
    const eligibleDocuments = await this.documentsEligibleForDestination(
      resolved,
      projectId,
      documents,
    );
    let stored: StoredSearchVectorProject | null;
    try {
      stored = await this.store.loadProject(projectId);
    } catch (cause: unknown) {
      return this.remember(
        emptyLoad(
          projectId,
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
          projectId,
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
          projectId,
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
      (authoritativeSourcesChanged || !matchesDocuments(stored.embeddings, eligibleDocuments))
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
            projectId,
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
          projectId,
          diagnosticsFor(resolved, {
            status: stored.state.status,
            reason:
              authoritativeSourcesChanged || !matchesDocuments(stored.embeddings, eligibleDocuments)
                ? "authoritative_source_changed"
                : "vector_index_not_built",
            state: stored.state,
          }),
        ),
      );
    }

    if (!matchesDocuments(stored.embeddings, eligibleDocuments)) {
      return this.remember(
        emptyLoad(
          projectId,
          diagnosticsFor(resolved, {
            status: "rebuild_required",
            reason: "authoritative_source_changed",
            state: stored.state,
          }),
        ),
      );
    }

    return this.remember({
      projectId,
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

    const projectPrivacy = await this.inspectProjectPrivacy(projectId);
    if (projectPrivacy === null) {
      throw projectPrivacyUnavailable();
    }
    if (resolved.destination === "remote") {
      this.assertProjectPrivacyRoute(projectPrivacy, false);
    }

    let current: StoredSearchVectorProject | null;
    try {
      current = await this.store.loadProject(projectId);
    } catch (cause: unknown) {
      throw safeStoreFailure(cause);
    }

    const eligibleDocuments = await this.documentsEligibleForDestination(
      resolved,
      projectId,
      documents,
    );
    const batches = createBatches(eligibleDocuments);
    const embeddings: DocumentEmbedding[] = [];
    let dimension: number | null = null;

    if (batches.length === 0) {
      const result = await this.callGateway(resolved, {
        kind: "project_context",
        inputs: [CAPABILITY_PROBE],
        receipt: projectPrivacy,
      });
      dimension = validateGatewayResult(result, resolved, 1, null);
    } else {
      for (const batch of batches) {
        const liveEligibleDocuments = await this.documentsEligibleForDestination(
          resolved,
          projectId,
          batch.map(({ document }) => document),
        );
        const liveEligibleIds = new Set(liveEligibleDocuments.map(({ id }) => id));
        const dispatchBatch = batch.filter(({ document }) => liveEligibleIds.has(document.id));
        if (dispatchBatch.length === 0) {
          continue;
        }
        const result = await this.callGateway(resolved, {
          kind: "project_context",
          inputs: dispatchBatch.map(({ text }) => text),
          receipt: projectPrivacy,
        });
        dimension = validateGatewayResult(result, resolved, dispatchBatch.length, dimension);
        for (const [index, source] of dispatchBatch.entries()) {
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
      const result = await this.callGateway(resolved, {
        kind: "project_context",
        inputs: [CAPABILITY_PROBE],
        receipt: projectPrivacy,
      });
      dimension = validateGatewayResult(result, resolved, 1, null);
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
      const projectPrivacy = await this.inspectProjectPrivacy(load.projectId);
      if (projectPrivacy === null) {
        throw projectPrivacyUnavailable();
      }
      const result = await this.callGateway(resolved, {
        kind: "project_context",
        inputs: [query],
        receipt: projectPrivacy,
      });
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

  private async documentsEligibleForDestination(
    resolved: ResolvedEmbeddingProfile,
    projectId: string,
    documents: readonly SearchDocument[],
  ): Promise<readonly SearchDocument[]> {
    if (resolved.destination !== "remote") {
      return documents;
    }
    if (this.filterRemoteEligibleDocuments === undefined) {
      // A remote embedding route must never guess that chapter text is
      // cloud-eligible. Non-chapter sources remain usable while chapter text
      // fails closed until the runtime supplies live privacy authority.
      return documents.filter(({ sourceType }) => sourceType !== "chapter");
    }
    const eligible = await this.filterRemoteEligibleDocuments(projectId, documents);
    const eligibleIds = new Set(eligible.map(({ id }) => id));
    return documents.filter((document) => eligibleIds.has(document.id));
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

    if (this.modelHub !== null) {
      try {
        const inspection = await inspectModelHubEmbeddingTask(this.modelHub, {
          inputs: [CAPABILITY_PROBE],
        });
        return await this.resolveModelHubProfile(inspection);
      } catch (cause: unknown) {
        if (
          safeErrorCode(cause, "MODEL_HUB_PREFLIGHT_FAILED") !== "MODEL_HUB_ROUTE_NOT_CONFIGURED"
        ) {
          throw modelHubFailure(cause);
        }
      }
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

    const resolvedEndpoint: Readonly<{ config: NativeGatewayEndpointConfig }> | null =
      this.modelHub === null
        ? Object.freeze({
            config: Object.freeze({
              providerId: profile.providerId,
              provider: profile.provider,
              baseUrl: profile.baseUrl,
              authentication: profile.authentication,
            }),
          })
        : await resolveModelProfileGatewayConfig(this.modelHub, profile);
    if (resolvedEndpoint === null) {
      return {
        resolved: null,
        diagnostics: unavailableProfileDiagnostics(route, "embedding_profile_missing", profile),
      };
    }
    const endpointOrigin = new URL(resolvedEndpoint.config.baseUrl).origin;
    const endpointUrl = `${resolvedEndpoint.config.baseUrl.replace(/\/$/u, "")}${
      resolvedEndpoint.config.embeddingPath ??
      (resolvedEndpoint.config.provider === "ollama" ? "/api/embed" : "/embeddings")
    }`;
    const fingerprint = await this.hasher.sha256(
      JSON.stringify([
        profile.providerId,
        resolvedEndpoint.config.provider,
        endpointUrl,
        resolvedEndpoint.config.authentication,
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
    const resolved: ResolvedLegacyEmbeddingProfile = Object.freeze({
      source: "legacy",
      route,
      profile,
      endpointConfig: resolvedEndpoint.config,
      providerId: profile.providerId,
      provider: resolvedEndpoint.config.provider,
      model: route.primaryModelId,
      configurationKey,
      endpointOrigin,
      endpointUrl,
      destination:
        resolvedEndpoint.config.provider === "ollama" &&
        isLoopbackHost(new URL(resolvedEndpoint.config.baseUrl).hostname)
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

  private async resolveModelHubProfile(
    inspection: ModelHubEmbeddingTaskInspection,
  ): Promise<EmbeddingProfileResolution> {
    const configurationKey = await this.modelHubConfigurationKey(inspection);
    const resolved: ResolvedModelHubEmbeddingProfile = Object.freeze({
      source: "model_hub",
      inspection,
      providerId: inspection.connectionId,
      provider: inspection.gatewayProvider,
      model: inspection.modelId,
      configurationKey,
      endpointOrigin: null,
      endpointUrl: null,
      destination: inspection.dataDestination === "local" ? "local_ollama" : "remote",
    });
    return {
      resolved,
      diagnostics: diagnosticsFor(resolved, {
        status: "rebuild_required",
        reason: "vector_index_not_built",
      }),
    };
  }

  private async modelHubConfigurationKey(
    inspection: ModelHubEmbeddingTaskInspection,
  ): Promise<string> {
    const fingerprint = await this.hasher.sha256(JSON.stringify(inspection.fingerprintMaterial));
    if (!fingerprint.ok) {
      throw new ProjectEmbeddingServiceError(
        "EMBEDDING_CONFIGURATION_FINGERPRINT_FAILED",
        "The Model Hub embedding configuration could not be fingerprinted.",
        fingerprint.error.retryable,
      );
    }
    return `embedding-model-hub:${fingerprint.value}`;
  }

  private async callGateway(
    resolved: ResolvedEmbeddingProfile,
    dispatch: ProjectEmbeddingGatewayDispatch,
  ): Promise<NativeEmbeddingResult> {
    try {
      const { inputs, receipt: projectPrivacy } = dispatch;
      const dispatchScope = projectContextDispatchScope(projectPrivacy);
      if (resolved.source === "legacy") {
        await this.assertLegacyFallbackStillAllowed(inputs);
        await this.assertProjectPrivacyBeforeDispatch(
          projectPrivacy,
          resolved.destination === "local_ollama",
        );
        await this.assertLegacyFallbackStillAllowed(inputs);
        const current = await this.resolveCurrentLegacyEmbeddingDispatch(resolved);
        await this.assertLegacyFallbackStillAllowed(inputs);
        return await this.gateway.embed({
          dispatchScope,
          config: current.config,
          model: current.model,
          inputs,
        });
      }
      if (this.modelHub === null) {
        throw new ModelHubExecutionError(
          "MODEL_HUB_EXECUTION_DEPENDENCIES_MISSING",
          "Model Hub embedding execution is unavailable in this runtime.",
        );
      }
      const inspected = await inspectModelHubEmbeddingTask(this.modelHub, { inputs });
      const inspectedConfigurationKey = await this.modelHubConfigurationKey(inspected);
      if (inspectedConfigurationKey !== resolved.configurationKey) {
        throw new ModelHubExecutionError(
          "MODEL_HUB_EMBEDDING_CONFIGURATION_DRIFT",
          "Embedding configuration changed before provider dispatch.",
          true,
        );
      }
      return await executeModelHubEmbeddingTask(this.modelHub, {
        dispatchScope,
        inputs,
        onBeforeDispatch: async (selection) => {
          if (
            selection.connectionId !== inspected.connectionId ||
            selection.catalogEntryId !== inspected.catalogEntryId ||
            selection.modelId !== inspected.modelId ||
            selection.usedFallback !== inspected.usedFallback ||
            JSON.stringify(selection.fingerprintMaterial) !==
              JSON.stringify(inspected.fingerprintMaterial)
          ) {
            throw new ModelHubExecutionError(
              "MODEL_HUB_EMBEDDING_SELECTION_DRIFT",
              "Embedding route changed before provider dispatch.",
              true,
            );
          }
          await this.assertProjectPrivacyBeforeDispatch(
            projectPrivacy,
            selection.localOnlyEligible,
          );
        },
      });
    } catch (cause: unknown) {
      throw new ProjectEmbeddingServiceError(
        safeErrorCode(cause, "EMBEDDING_GATEWAY_FAILED"),
        "The configured embedding provider request failed.",
        safeRetryable(cause),
      );
    }
  }

  private async assertLegacyFallbackStillAllowed(inputs: readonly string[]): Promise<void> {
    if (this.modelHub === null) {
      return;
    }
    try {
      await inspectModelHubEmbeddingTask(this.modelHub, { inputs });
      throw new ModelHubExecutionError(
        "MODEL_HUB_EMBEDDING_CONFIGURATION_DRIFT",
        "A Model Hub embedding route became available before legacy provider dispatch.",
        true,
      );
    } catch (cause: unknown) {
      if (safeErrorCode(cause, "MODEL_HUB_PREFLIGHT_FAILED") === "MODEL_HUB_ROUTE_NOT_CONFIGURED") {
        return;
      }
      throw cause;
    }
  }

  private async resolveCurrentLegacyEmbeddingDispatch(
    expected: ResolvedLegacyEmbeddingProfile,
  ): Promise<Readonly<{ config: NativeGatewayEndpointConfig; model: string }>> {
    const route = await this.routes.findRoute("embedding");
    const profile =
      route === null ? null : await this.profiles.findByProviderId(route.primaryProviderId);
    if (route === null || profile?.selectedModel !== route.primaryModelId) {
      throw legacyEmbeddingConfigurationChanged();
    }
    const resolution: Readonly<{ config: NativeGatewayEndpointConfig }> | null =
      this.modelHub === null
        ? Object.freeze({
            config: Object.freeze({
              providerId: profile.providerId,
              provider: profile.provider,
              baseUrl: profile.baseUrl,
              authentication: profile.authentication,
            }),
          })
        : await resolveModelProfileGatewayConfig(this.modelHub, profile);
    if (
      resolution === null ||
      legacyEmbeddingDispatchIdentity(route, profile, resolution.config) !==
        legacyEmbeddingDispatchIdentity(expected.route, expected.profile, expected.endpointConfig)
    ) {
      throw legacyEmbeddingConfigurationChanged();
    }
    return Object.freeze({ config: resolution.config, model: route.primaryModelId });
  }

  private async inspectProjectPrivacy(
    projectId: string,
  ): Promise<ProjectContextPrivacyReceipt | null> {
    if (this.projectContextPrivacy === null) {
      return null;
    }
    try {
      return await this.projectContextPrivacy.inspect(projectId);
    } catch (cause: unknown) {
      throw projectPrivacyEmbeddingError(cause);
    }
  }

  private assertProjectPrivacyRoute(
    receipt: ProjectContextPrivacyReceipt,
    verifiedLocalEligible: boolean,
  ): void {
    if (this.projectContextPrivacy === null) {
      throw new ProjectEmbeddingServiceError(
        "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
        "无法核对作品隐私范围，因此没有发送语义记忆内容。",
        true,
      );
    }
    try {
      this.projectContextPrivacy.assertRouteEligible(receipt, verifiedLocalEligible);
    } catch (cause: unknown) {
      throw projectPrivacyEmbeddingError(cause);
    }
  }

  private async assertProjectPrivacyBeforeDispatch(
    receipt: ProjectContextPrivacyReceipt,
    verifiedLocalEligible: boolean,
  ): Promise<void> {
    if (this.projectContextPrivacy === null) {
      throw new ProjectEmbeddingServiceError(
        "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
        "无法核对作品隐私范围，因此没有发送语义记忆内容。",
        true,
      );
    }
    try {
      await this.projectContextPrivacy.assertCurrentBeforeDispatch(receipt);
      this.projectContextPrivacy.assertRouteEligible(receipt, verifiedLocalEligible);
    } catch (cause: unknown) {
      throw projectPrivacyEmbeddingError(cause);
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
    result.provider !== resolved.provider ||
    (resolved.endpointOrigin !== null && result.endpointOrigin !== resolved.endpointOrigin) ||
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
    providerId: resolved.providerId,
    provider: resolved.provider,
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

function emptyLoad(projectId: string, diagnostics: ProjectEmbeddingDiagnostics): ProjectVectorLoad {
  return Object.freeze({
    projectId,
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

function legacyEmbeddingDispatchIdentity(
  route: ModelRoleRoute,
  profile: ModelProfile,
  config: NativeGatewayEndpointConfig,
): string {
  return JSON.stringify([
    route.role,
    route.revision,
    route.primaryProviderId,
    route.primaryModelId,
    route.fallbackProviderId,
    route.fallbackModelId,
    profile.providerId,
    profile.revision,
    profile.provider,
    profile.baseUrl,
    profile.authentication,
    profile.selectedModel,
    nativeGatewayEndpointIdentity(config),
  ]);
}

function legacyEmbeddingConfigurationChanged(): ProjectEmbeddingServiceError {
  return new ProjectEmbeddingServiceError(
    "EMBEDDING_CONFIGURATION_CHANGED",
    "The legacy embedding route, profile, model, credential, or endpoint changed before dispatch.",
    true,
  );
}

function modelHubFailure(cause: unknown): ProjectEmbeddingServiceError {
  return new ProjectEmbeddingServiceError(
    safeErrorCode(cause, "MODEL_HUB_PREFLIGHT_FAILED"),
    "The configured Model Hub embedding route could not be used safely.",
    safeRetryable(cause),
  );
}

function projectPrivacyUnavailable(): ProjectEmbeddingServiceError {
  return new ProjectEmbeddingServiceError(
    "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
    "无法核对作品隐私范围，因此没有发送语义记忆内容。",
    true,
  );
}

function projectPrivacyEmbeddingError(cause: unknown): ProjectEmbeddingServiceError {
  return cause instanceof ProjectContextPrivacyError
    ? new ProjectEmbeddingServiceError(cause.code, cause.message, cause.retryable)
    : projectPrivacyUnavailable();
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
