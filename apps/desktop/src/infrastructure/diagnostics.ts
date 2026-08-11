import {
  createDiagnosticSummary,
  type DiagnosticSummary,
  type HealthState,
} from "@inkshadow/observability";
import { TASK_STATUSES, type TaskStatus } from "@inkshadow/task-engine";
import type { LocalAccessStoreHealth } from "@inkshadow/data/access-sqlite-store";
import type { LocalSyncStoreHealth } from "@inkshadow/data/sync-sqlite-store";

import { NOVEL_AI_TASKS } from "./model-hub-provider-registry";
import {
  buildModelHubRoutingVisibility,
  toAiRoutingDiagnosticSummary,
  type AiRoutingDiagnosticSummary,
} from "./model-hub-routing-visibility";
import type {
  ModelCapabilityEvidence,
  ModelCatalogEntry,
  ModelProviderConnection,
  NovelTaskRoute,
  RecentAiFailure,
} from "./model-hub-store";
import {
  readSafeGenerationPreflightDiagnostic,
  type SafeGenerationPreflightDiagnostic,
} from "./generation-preflight-diagnostics";
import {
  readSafeModelHubSessionDiagnostics,
  type SafeModelHubActionDiagnostic,
  type SafeModelHubUiSnapshotDiagnostic,
} from "./model-hub-ui-diagnostics";
import type { DesktopRuntime } from "./runtime";
import type { PersistedGenerationPreflight } from "./generation-governance-store";

export interface DesktopDiagnosticBundle {
  readonly schemaVersion: 3;
  readonly summary: DiagnosticSummary;
  readonly database: {
    readonly integrityMessageCount: number | null;
    readonly foreignKeyViolationCount: number | null;
  };
  readonly localCloudFoundation: {
    readonly sync: LocalSyncStoreHealth;
    readonly access: LocalAccessStoreHealth;
  } | null;
  readonly aiRoutingSummary: AiRoutingDiagnosticSummary;
  readonly recentAiRoutingFailures: readonly [];
  readonly recentAiFailures: readonly RecentAiFailure[];
  readonly modelHubUiSnapshot: SafeModelHubUiSnapshotDiagnostic | null;
  readonly recentModelHubActions: readonly SafeModelHubActionDiagnostic[];
  readonly currentSessionStartedAt: string;
  readonly currentSessionErrorCodes: readonly string[];
  readonly historicalErrorCodes: readonly string[];
  readonly generationPreflight: SafeGenerationPreflightDiagnostic | null;
  readonly generationBudget: PersistedGenerationPreflight["generationBudget"] | null;
  readonly contextSelectionSummary: PersistedGenerationPreflight["contextSelectionSummary"] | null;
  readonly chapterSummaryStatus: null;
  readonly recentLogs: readonly [];
  readonly privacy: {
    readonly projectContentIncluded: false;
    readonly promptContentIncluded: false;
    readonly credentialsIncluded: false;
    readonly uploadedFilesIncluded: false;
  };
  readonly limitations: readonly string[];
}

export interface DesktopDiagnosticArtifact {
  readonly fileName: string;
  readonly mediaType: "application/json";
  readonly content: string;
  readonly bundle: DesktopDiagnosticBundle;
}

export async function collectDesktopDiagnosticArtifact(
  runtime: DesktopRuntime,
): Promise<DesktopDiagnosticArtifact> {
  const information = await runtime.getRuntimeInformation();
  const errorCodes: string[] = [];
  const requestIds: string[] = [];
  const taskStateCounts = emptyTaskStateCounts();
  let databaseHealth: HealthState = runtime.maintenance === null ? "unknown" : "unavailable";
  let integrityMessageCount: number | null = null;
  let foreignKeyViolationCount: number | null = null;
  let localCloudFoundation: DesktopDiagnosticBundle["localCloudFoundation"] = null;
  let recentAiFailures: readonly RecentAiFailure[] = [];
  let legacyModelProfileCount: number | null = null;
  let legacyModelProfilesWithSelection: number | null = null;
  let modelHubConnectionCount: number | null = null;
  let modelHubUsableConnectionCount: number | null = null;
  let modelHubCatalogEntryCount: number | null = null;
  let modelHubEnabledTaskRouteCount: number | null = null;
  let modelHubConnections: readonly ModelProviderConnection[] = [];
  let modelHubCatalog: readonly ModelCatalogEntry[] = [];
  let modelHubRoutes: readonly NovelTaskRoute[] = [];
  let modelHubCapabilityEvidence: readonly ModelCapabilityEvidence[] = [];
  let generationBudget: DesktopDiagnosticBundle["generationBudget"] = null;
  let contextSelectionSummary: DesktopDiagnosticBundle["contextSelectionSummary"] = null;

  try {
    const taskCenter = await runtime.taskCenter.load();
    for (const task of taskCenter.tasks) {
      taskStateCounts[task.status] += 1;
      if (task.failure !== null) {
        errorCodes.push(task.failure.code);
        requestIds.push(task.failure.requestId);
      }
    }
  } catch (cause: unknown) {
    errorCodes.push(errorCode(cause, "TASK_DIAGNOSTIC_UNAVAILABLE"));
  }

  if (runtime.maintenance !== null) {
    const inspection = await runtime.maintenance.inspect();
    if (inspection.ok) {
      databaseHealth = inspection.value.healthy ? "healthy" : "degraded";
      integrityMessageCount = inspection.value.integrityMessages.length;
      foreignKeyViolationCount = inspection.value.foreignKeyViolations.length;
    } else {
      errorCodes.push(inspection.error.code);
    }
  }

  if (runtime.cloudFoundation !== null) {
    const [syncHealth, accessHealth] = await Promise.all([
      runtime.cloudFoundation.sync.health(),
      runtime.cloudFoundation.access.health(),
    ]);
    if (syncHealth.ok && accessHealth.ok) {
      localCloudFoundation = {
        sync: syncHealth.value,
        access: accessHealth.value,
      };
    } else {
      if (!syncHealth.ok) {
        errorCodes.push(syncHealth.error.code);
      }
      if (!accessHealth.ok) {
        errorCodes.push(accessHealth.error.code);
      }
    }
  }

  try {
    const modelProfiles = await runtime.modelCenter.listProfiles();
    legacyModelProfileCount = modelProfiles.length;
    legacyModelProfilesWithSelection = modelProfiles.filter(
      ({ selectedModel }) => selectedModel !== null,
    ).length;
  } catch (cause: unknown) {
    errorCodes.push(errorCode(cause, "MODEL_PROFILE_DIAGNOSTIC_UNAVAILABLE"));
  }

  try {
    const connections = await runtime.modelHub.listConnections();
    const [catalogs, routes] = await Promise.all([
      Promise.all(connections.map((connection) => runtime.modelHub.listCatalog(connection.id))),
      Promise.all(NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task))),
    ]);
    const catalog = catalogs.flat();
    const persistedRoutes = routes.filter((route): route is NovelTaskRoute => route !== null);
    const capabilityEvidence = (
      await Promise.all(catalog.map((entry) => runtime.modelHub.listCapabilityEvidence(entry.id)))
    ).flat();
    modelHubConnections = connections;
    modelHubCatalog = catalog;
    modelHubRoutes = persistedRoutes;
    modelHubCapabilityEvidence = capabilityEvidence;
    modelHubConnectionCount = connections.length;
    modelHubUsableConnectionCount = connections.filter(
      (connection) =>
        connection.enabled &&
        (connection.connectionStatus === "ready" || connection.connectionStatus === "degraded"),
    ).length;
    modelHubCatalogEntryCount = catalog.length;
    modelHubEnabledTaskRouteCount = routes.filter((route) => route?.enabled === true).length;
  } catch (cause: unknown) {
    errorCodes.push(errorCode(cause, "MODEL_HUB_DIAGNOSTIC_UNAVAILABLE"));
  }

  try {
    recentAiFailures = await runtime.modelHub.listRecentAiFailures(25);
    for (const failure of recentAiFailures) {
      errorCodes.push(failure.normalizedErrorCode);
      if (failure.requestId !== null) {
        requestIds.push(failure.requestId);
      }
    }
  } catch (cause: unknown) {
    errorCodes.push(errorCode(cause, "AI_FAILURE_DIAGNOSTIC_UNAVAILABLE"));
  }

  try {
    const projects = await runtime.repositories.projects.list({
      statuses: ["active", "archived", "trashed"],
      search: null,
    });
    if (projects.ok) {
      const runs = (
        await Promise.all(
          projects.value.map((project) =>
            runtime.generationGovernance.listRunsByProjectId(project.id),
          ),
        )
      )
        .flat()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      generationBudget = runs[0]?.preflight.generationBudget ?? null;
      contextSelectionSummary = runs[0]?.preflight.contextSelectionSummary ?? null;
    } else {
      errorCodes.push(projects.error.code);
    }
  } catch (cause: unknown) {
    errorCodes.push(errorCode(cause, "GENERATION_BUDGET_DIAGNOSTIC_UNAVAILABLE"));
  }

  const aiRoutingSummary = toAiRoutingDiagnosticSummary(
    buildModelHubRoutingVisibility({
      connections: modelHubConnections,
      catalog: modelHubCatalog,
      routes: modelHubRoutes,
      capabilityEvidence: modelHubCapabilityEvidence,
      recentAiFailures,
      now: runtime.clock.now(),
      validating: false,
      loadFailed: modelHubConnectionCount === null,
      saveFailed: false,
    }),
  );
  const modelHubSession = readSafeModelHubSessionDiagnostics(runtime, runtime.clock.now());
  const { currentSessionErrorCodes, historicalErrorCodes } = partitionDiagnosticErrorCodes(
    modelHubSession.currentSessionStartedAt,
    modelHubSession.currentSessionErrorCodes,
    recentAiFailures,
  );

  const searchHealth = runtime.search.health();
  const embeddingDiagnostics = runtime.search.embeddingDiagnostics();
  const indexHealth: HealthState =
    searchHealth.lastRebuiltAt === undefined
      ? "unknown"
      : searchHealth.mutationStatus !== "ready" ||
          searchHealth.degradedReasons.length > 0 ||
          searchHealth.vectorStatus === "degraded" ||
          searchHealth.vectorStatus === "rebuild_required"
        ? "degraded"
        : "healthy";
  const summary = createDiagnosticSummary({
    appVersion: information.appVersion,
    platform: `${information.platform}/${information.architecture}`,
    environment: information.environment,
    databaseHealth,
    indexHealth,
    syncState: "local_only",
    errorCodes,
    taskStateCounts,
    requestIds,
    configuration: {
      diagnosticSchemaVersion: 3,
      runtimeMode: runtime.mode,
      storageBackend: runtime.mode === "tauri" ? "sqlite" : "development_local_storage",
      telemetryEnabled: false,
      indexIntegrated: true,
      indexPersistence:
        runtime.mode === "tauri" ? "sqlite_vectors_runtime_documents" : "runtime_rebuild",
      indexedDocumentCount: searchHealth.documentCount,
      indexedEmbeddingCount: searchHealth.embeddingCount,
      vectorStatus: searchHealth.vectorStatus,
      embeddingProviderId: embeddingDiagnostics.providerId,
      embeddingProvider: embeddingDiagnostics.provider,
      embeddingModel: embeddingDiagnostics.model,
      embeddingDimension: embeddingDiagnostics.dimension,
      embeddingDestination: embeddingDiagnostics.destination,
      embeddingEndpoint: embeddingDiagnostics.endpointUrl,
      embeddingReason: embeddingDiagnostics.reason,
      embeddingGeneration: embeddingDiagnostics.generation,
      embeddingLastRebuiltAt: embeddingDiagnostics.lastRebuiltAt,
      embeddingQueryFailureCode: embeddingDiagnostics.queryFailureCode,
      legacyModelProfileCount,
      legacyModelProfilesWithSelection,
      modelHubConnectionCount,
      modelHubUsableConnectionCount,
      modelHubCatalogEntryCount,
      modelHubEnabledTaskRouteCount,
      nativeModelGatewayAvailable: runtime.modelGateway.available,
      cloudIdentityEnabled: runtime.featureFlags.cloudIdentity,
      cloudSyncEnabled: runtime.featureFlags.cloudSync,
      encryptedSyncStore:
        runtime.cloudFoundation === null ? "unavailable" : "sqlite_ciphertext_only",
      entitlementCacheTrust: "unverified_only",
    },
  });

  const limitations = [
    ...(runtime.maintenance === null
      ? ["Database integrity inspection is available only in the desktop runtime."]
      : []),
    "Persistent redacted log collection is not enabled; recentLogs is intentionally empty.",
    "AI routing write failures are not persisted as a dedicated safe fact; recentAiRoutingFailures is intentionally empty and cannot locate historical routing write failures.",
    ...(runtime.mode === "tauri"
      ? [
          "Keyword and relation projections are rebuilt in memory; validated document vectors persist in local SQLite.",
        ]
      : [
          "Browser development mode does not provide native embedding or persistent vector capability.",
        ]),
    "A bounded global chapter-summary status reader is not available; chapterSummaryStatus is null rather than inferred from routes or tasks.",
  ];
  const bundle: DesktopDiagnosticBundle = {
    schemaVersion: 3,
    summary,
    database: {
      integrityMessageCount,
      foreignKeyViolationCount,
    },
    localCloudFoundation,
    aiRoutingSummary,
    recentAiRoutingFailures: [],
    recentAiFailures,
    modelHubUiSnapshot: modelHubSession.modelHubUiSnapshot,
    recentModelHubActions: modelHubSession.recentModelHubActions,
    currentSessionStartedAt: modelHubSession.currentSessionStartedAt,
    currentSessionErrorCodes,
    historicalErrorCodes,
    generationPreflight: readSafeGenerationPreflightDiagnostic(runtime),
    generationBudget,
    contextSelectionSummary,
    chapterSummaryStatus: null,
    recentLogs: [],
    privacy: {
      projectContentIncluded: false,
      promptContentIncluded: false,
      credentialsIncluded: false,
      uploadedFilesIncluded: false,
    },
    limitations,
  };

  return {
    fileName: `InkShadow-diagnostics-${summary.generatedAt.slice(0, 10)}-${summary.diagnosticId}.json`,
    mediaType: "application/json",
    content: JSON.stringify(bundle, null, 2),
    bundle,
  };
}

export function partitionDiagnosticErrorCodes(
  currentSessionStartedAt: string,
  modelHubActionErrorCodes: readonly string[],
  recentAiFailures: readonly Pick<RecentAiFailure, "timestamp" | "normalizedErrorCode">[],
): Readonly<{
  currentSessionErrorCodes: readonly string[];
  historicalErrorCodes: readonly string[];
}> {
  return Object.freeze({
    currentSessionErrorCodes: Object.freeze([
      ...new Set([
        ...modelHubActionErrorCodes,
        ...recentAiFailures.flatMap(({ timestamp, normalizedErrorCode }) =>
          timestamp >= currentSessionStartedAt ? [normalizedErrorCode] : [],
        ),
      ]),
    ]),
    historicalErrorCodes: Object.freeze([
      ...new Set(
        recentAiFailures.flatMap(({ timestamp, normalizedErrorCode }) =>
          timestamp < currentSessionStartedAt ? [normalizedErrorCode] : [],
        ),
      ),
    ]),
  });
}

function emptyTaskStateCounts(): Record<TaskStatus, number> {
  return Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
    TaskStatus,
    number
  >;
}

function errorCode(cause: unknown, fallback: string): string {
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : fallback;
}
