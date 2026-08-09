import {
  createDiagnosticSummary,
  type DiagnosticSummary,
  type HealthState,
} from "@inkshadow/observability";
import { TASK_STATUSES, type TaskStatus } from "@inkshadow/task-engine";
import type { LocalAccessStoreHealth } from "@inkshadow/data/access-sqlite-store";
import type { LocalSyncStoreHealth } from "@inkshadow/data/sync-sqlite-store";

import { NOVEL_AI_TASKS } from "./model-hub-provider-registry";
import type { RecentAiFailure } from "./model-hub-store";
import type { DesktopRuntime } from "./runtime";

export interface DesktopDiagnosticBundle {
  readonly schemaVersion: 2;
  readonly summary: DiagnosticSummary;
  readonly database: {
    readonly integrityMessageCount: number | null;
    readonly foreignKeyViolationCount: number | null;
  };
  readonly localCloudFoundation: {
    readonly sync: LocalSyncStoreHealth;
    readonly access: LocalAccessStoreHealth;
  } | null;
  readonly recentAiFailures: readonly RecentAiFailure[];
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
    modelHubConnectionCount = connections.length;
    modelHubUsableConnectionCount = connections.filter(
      (connection) =>
        connection.enabled &&
        (connection.connectionStatus === "ready" || connection.connectionStatus === "degraded"),
    ).length;
    modelHubCatalogEntryCount = catalogs.reduce((count, catalog) => count + catalog.length, 0);
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
      diagnosticSchemaVersion: 2,
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
    ...(runtime.mode === "tauri"
      ? [
          "Keyword and relation projections are rebuilt in memory; validated document vectors persist in local SQLite.",
        ]
      : [
          "Browser development mode does not provide native embedding or persistent vector capability.",
        ]),
  ];
  const bundle: DesktopDiagnosticBundle = {
    schemaVersion: 2,
    summary,
    database: {
      integrityMessageCount,
      foreignKeyViolationCount,
    },
    localCloudFoundation,
    recentAiFailures,
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
