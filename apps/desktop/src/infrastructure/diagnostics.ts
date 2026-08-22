import {
  createDiagnosticSummary,
  type DiagnosticSummary,
  type HealthState,
} from "@inkshadow/observability";
import { TASK_STATUSES, type TaskStatus } from "@inkshadow/task-engine";
import type { LocalAccessStoreHealth } from "@inkshadow/data/access-sqlite-store";
import type { LocalSyncStoreHealth } from "@inkshadow/data/sync-sqlite-store";

import {
  NOVEL_AI_TASKS,
  isModelProviderKind,
  isNovelAiTask,
  type ModelProviderKind,
  type NovelAiTask,
} from "./model-hub-provider-registry";
import {
  buildModelHubRoutingVisibility,
  toAiRoutingDiagnosticSummary,
  type AiRoutingDiagnosticSummary,
} from "./model-hub-routing-visibility";
import {
  MODEL_FAILURE_STAGES,
  type ModelFailureStage,
  type ModelCapabilityEvidence,
  type ModelCatalogEntry,
  type ModelProviderConnection,
  type NovelTaskRoute,
  type RecentAiFailure,
} from "./model-hub-store";
import {
  readSafeGenerationErrorCodes,
  readSafeGenerationPreflightDiagnostic,
  readSafeInvocationRouteDiagnostic,
  type SafeGenerationPreflightDiagnostic,
  type SafeInvocationRouteDiagnostic,
} from "./generation-preflight-diagnostics";
import {
  readSafeGuidedOpeningStatus,
  type SafeGuidedOpeningStatus,
} from "./guided-opening-diagnostics";
import {
  readSafeModelHubSessionDiagnostics,
  type SafeModelHubActionDiagnostic,
  type SafeModelHubUiSnapshotDiagnostic,
} from "./model-hub-ui-diagnostics";
import { readSafeUiRouteIncidents, type SafeUiRouteIncident } from "./ui-route-diagnostics";
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
  readonly recentAiFailures: readonly SafeRecentAiFailureDiagnostic[];
  readonly recentUiFailures: readonly SafeUiRouteIncident[];
  readonly modelHubUiSnapshot: SafeModelHubUiSnapshotDiagnostic | null;
  readonly recentModelHubActions: readonly SafeModelHubActionDiagnostic[];
  readonly currentSessionStartedAt: string;
  readonly currentSessionErrorCodes: readonly string[];
  readonly historicalErrorCodes: readonly string[];
  readonly generationPreflight: SafeGenerationPreflightDiagnostic | null;
  readonly lastRouteResolution: SafeInvocationRouteDiagnostic | null;
  readonly guidedOpeningStatus: SafeGuidedOpeningStatus | null;
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

export interface SafeRecentAiFailureDiagnostic {
  readonly timestamp: string;
  readonly providerKind: ModelProviderKind;
  readonly taskType: NovelAiTask | "capability_probe";
  readonly stage: ModelFailureStage | null;
  readonly normalizedErrorCode: string;
  readonly retryable: boolean | null;
  readonly httpStatus: number | null;
  readonly finishReason: "stop" | "length" | "content_filter" | "tool_calls" | null;
  readonly visibleContentLength: number | null;
  readonly reasoningPresent: boolean | null;
  readonly stream: boolean | null;
  readonly attempt: number;
  readonly requestedMaxOutputTokens: number | null;
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
  let rawRecentAiFailures: readonly RecentAiFailure[] = [];
  let recentAiFailures: readonly SafeRecentAiFailureDiagnostic[] = [];
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
    rawRecentAiFailures = await runtime.modelHub.listRecentAiFailures(25);
    recentAiFailures = Object.freeze(rawRecentAiFailures.map(projectRecentAiFailure));
    for (const failure of recentAiFailures) {
      errorCodes.push(failure.normalizedErrorCode);
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
      recentAiFailures: rawRecentAiFailures,
      now: runtime.clock.now(),
      validating: false,
      loadFailed: modelHubConnectionCount === null,
      saveFailed: false,
    }),
  );
  const modelHubSession = readSafeModelHubSessionDiagnostics(runtime, runtime.clock.now());
  const safeModelHubActions = Object.freeze(
    modelHubSession.recentModelHubActions.map((action) =>
      Object.freeze({
        ...action,
        connectionId: null,
        modelId: null,
        errorCode: action.errorCode === null ? null : safeDiagnosticErrorCode(action.errorCode),
      }),
    ),
  );
  const safeModelHubSnapshot =
    modelHubSession.modelHubUiSnapshot === null
      ? null
      : Object.freeze({
          ...modelHubSession.modelHubUiSnapshot,
          selectedConnectionId: null,
          selectedModelIdInUi: null,
        });
  const recentUiFailures = Object.freeze(
    readSafeUiRouteIncidents(runtime).map((incident) =>
      Object.freeze({
        ...incident,
        normalizedErrorCode: safeDiagnosticErrorCode(incident.normalizedErrorCode),
      }),
    ),
  );
  errorCodes.push(...recentUiFailures.map(({ normalizedErrorCode }) => normalizedErrorCode));
  const { currentSessionErrorCodes, historicalErrorCodes } = partitionDiagnosticErrorCodes(
    modelHubSession.currentSessionStartedAt,
    [
      ...safeModelHubActions.flatMap(({ errorCode }) => (errorCode === null ? [] : [errorCode])),
      ...readSafeGenerationErrorCodes(runtime),
    ],
    recentAiFailures,
    recentUiFailures,
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
    errorCodes: errorCodes.map(safeDiagnosticErrorCode),
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
      embeddingProviderId: null,
      embeddingProvider: embeddingDiagnostics.provider,
      embeddingModel: null,
      embeddingDimension: embeddingDiagnostics.dimension,
      embeddingDestination: embeddingDiagnostics.destination,
      embeddingEndpoint: safeEndpointOrigin(embeddingDiagnostics.endpointUrl),
      embeddingReason: embeddingDiagnostics.reason,
      embeddingGeneration: embeddingDiagnostics.generation,
      embeddingLastRebuiltAt: embeddingDiagnostics.lastRebuiltAt,
      embeddingQueryFailureCode:
        embeddingDiagnostics.queryFailureCode === null
          ? null
          : safeDiagnosticErrorCode(embeddingDiagnostics.queryFailureCode),
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
    recentUiFailures,
    modelHubUiSnapshot: safeModelHubSnapshot,
    recentModelHubActions: safeModelHubActions,
    currentSessionStartedAt: modelHubSession.currentSessionStartedAt,
    currentSessionErrorCodes,
    historicalErrorCodes,
    generationPreflight: projectGenerationPreflightDiagnostic(
      readSafeGenerationPreflightDiagnostic(runtime),
    ),
    lastRouteResolution: projectInvocationRouteDiagnostic(
      readSafeInvocationRouteDiagnostic(runtime),
    ),
    guidedOpeningStatus: projectGuidedOpeningStatus(readSafeGuidedOpeningStatus(runtime)),
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
    fileName: `墨影-诊断-${summary.generatedAt.slice(0, 10)}-${summary.diagnosticId}.json`,
    mediaType: "application/json",
    content: JSON.stringify(bundle, null, 2),
    bundle,
  };
}

export function partitionDiagnosticErrorCodes(
  currentSessionStartedAt: string,
  modelHubActionErrorCodes: readonly string[],
  recentAiFailures: readonly Pick<RecentAiFailure, "timestamp" | "normalizedErrorCode">[],
  recentUiFailures: readonly Pick<SafeUiRouteIncident, "timestamp" | "normalizedErrorCode">[] = [],
): Readonly<{
  currentSessionErrorCodes: readonly string[];
  historicalErrorCodes: readonly string[];
}> {
  return Object.freeze({
    currentSessionErrorCodes: Object.freeze([
      ...new Set([
        ...modelHubActionErrorCodes.map(safeDiagnosticErrorCode),
        ...recentAiFailures.flatMap(({ timestamp, normalizedErrorCode }) =>
          timestamp >= currentSessionStartedAt
            ? [safeDiagnosticErrorCode(normalizedErrorCode)]
            : [],
        ),
        ...recentUiFailures.flatMap(({ timestamp, normalizedErrorCode }) =>
          timestamp >= currentSessionStartedAt
            ? [safeDiagnosticErrorCode(normalizedErrorCode)]
            : [],
        ),
      ]),
    ]),
    historicalErrorCodes: Object.freeze([
      ...new Set([
        ...recentAiFailures.flatMap(({ timestamp, normalizedErrorCode }) =>
          timestamp < currentSessionStartedAt ? [safeDiagnosticErrorCode(normalizedErrorCode)] : [],
        ),
        ...recentUiFailures.flatMap(({ timestamp, normalizedErrorCode }) =>
          timestamp < currentSessionStartedAt ? [safeDiagnosticErrorCode(normalizedErrorCode)] : [],
        ),
      ]),
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
  const candidate =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : fallback;
  return safeDiagnosticErrorCode(candidate);
}

const SAFE_PROVIDER_ERROR_CODES = new Set([
  "AI_UPSTREAM_UNAVAILABLE",
  "MODEL_OUTPUT_TRUNCATED",
  "UPSTREAM_TIMEOUT",
]);
const SAFE_DIAGNOSTIC_ERROR_CODES = new Set([
  ...SAFE_PROVIDER_ERROR_CODES,
  "AI_PROVIDER_REQUEST_FAILED",
  "CREATIVE_INPUT_INVALID",
  "CURRENT_ACTION_FAILED",
  "CURRENT_AI_FAILURE",
  "HISTORICAL_FAILURE",
  "MODEL_HUB_ACTION_FAILED",
  "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
  "MODEL_HUB_CATALOG_REFRESH_FAILED",
  "MODEL_HUB_STALE_RESULT_IGNORED",
  "LEGACY_CANDIDATE_METADATA_INVALID",
  "LEGACY_VERSION_METADATA_INVALID",
  "TASK_METADATA_INVALID",
  "PREFLIGHT_BLOCKED_CONTEXT_OVERFLOW",
  "PREFLIGHT_BLOCKED_CREDENTIAL",
  "PREFLIGHT_BLOCKED_HARD_BUDGET",
  "PREFLIGHT_BLOCKED_MODEL_UNAVAILABLE",
  "PREFLIGHT_BLOCKED_NO_ROUTE",
  "PREFLIGHT_BLOCKED_PRIVACY",
  "PREFLIGHT_WARNING_CONTEXT_UNKNOWN",
  "PREFLIGHT_WARNING_PRICING_UNKNOWN",
  "PREFLIGHT_WARNING_TOKEN_ESTIMATE_APPROXIMATE",
  "UI_CHUNK_LOAD_FAILED",
  "UI_LAZY_LOAD_FAILED",
  "UI_RENDER_FAILED",
]);
const SAFE_FINISH_REASONS = new Set(["stop", "length", "content_filter", "tool_calls"]);

function projectRecentAiFailure(input: RecentAiFailure): SafeRecentAiFailureDiagnostic {
  return Object.freeze({
    timestamp: safeTimestamp(input.timestamp),
    providerKind: isModelProviderKind(input.providerKind)
      ? input.providerKind
      : "custom_openai_compatible",
    taskType:
      input.taskType === "capability_probe" || isNovelAiTask(input.taskType)
        ? input.taskType
        : "capability_probe",
    stage: (MODEL_FAILURE_STAGES as readonly unknown[]).includes(input.stage) ? input.stage : null,
    normalizedErrorCode: SAFE_PROVIDER_ERROR_CODES.has(input.normalizedErrorCode)
      ? input.normalizedErrorCode
      : "AI_PROVIDER_REQUEST_FAILED",
    retryable: typeof input.retryable === "boolean" ? input.retryable : null,
    httpStatus: safeInteger(input.httpStatus, 100, 599),
    finishReason: SAFE_FINISH_REASONS.has(input.finishReason ?? "")
      ? (input.finishReason as SafeRecentAiFailureDiagnostic["finishReason"])
      : null,
    visibleContentLength: safeInteger(input.visibleContentLength, 0, 1_000_000_000),
    reasoningPresent: typeof input.reasoningPresent === "boolean" ? input.reasoningPresent : null,
    stream: typeof input.stream === "boolean" ? input.stream : null,
    attempt: safeInteger(input.attempt, 1, 100) ?? 1,
    requestedMaxOutputTokens: safeInteger(input.requestedMaxOutputTokens, 1, 1_000_000),
  });
}

function projectInvocationRouteDiagnostic(
  input: SafeInvocationRouteDiagnostic | null,
): SafeInvocationRouteDiagnostic | null {
  if (input === null) return null;
  return Object.freeze({
    ...input,
    taskType: isNovelAiTask(input.taskType) ? input.taskType : "continuation",
    resolvedConnectionId: null,
    resolvedModelId: null,
    blockerCode: input.blockerCode === null ? null : safeDiagnosticErrorCode(input.blockerCode),
    checkedAt: safeTimestamp(input.checkedAt),
  });
}

function projectGenerationPreflightDiagnostic(
  input: SafeGenerationPreflightDiagnostic | null,
): SafeGenerationPreflightDiagnostic | null {
  if (input === null) return null;
  return Object.freeze({
    ...input,
    taskType: isNovelAiTask(input.taskType) ? input.taskType : "continuation",
    blockerCodes: Object.freeze(input.blockerCodes.map(safeDiagnosticErrorCode)),
    warningCodes: Object.freeze(input.warningCodes.map(safeDiagnosticErrorCode)),
    checkedAt: safeTimestamp(input.checkedAt),
  });
}

function projectGuidedOpeningStatus(
  input: SafeGuidedOpeningStatus | null,
): SafeGuidedOpeningStatus | null {
  if (input === null) return null;
  return Object.freeze({
    ...input,
    batchId: null,
    selectedSlot: /^slot_[1-3]$/u.test(input.selectedSlot ?? "") ? input.selectedSlot : null,
    currentQuestion: /^[a-z][a-z0-9_]{0,63}$/u.test(input.currentQuestion ?? "")
      ? input.currentQuestion
      : null,
    lastError: input.lastError === null ? null : safeDiagnosticErrorCode(input.lastError),
  });
}

function safeEndpointOrigin(value: string | null): string | null {
  if (value === null) return null;
  try {
    const endpoint = new URL(value);
    return endpoint.username === "" &&
      endpoint.password === "" &&
      (endpoint.protocol === "https:" || endpoint.protocol === "http:")
      ? endpoint.origin
      : null;
  } catch {
    return null;
  }
}

function safeDiagnosticErrorCode(value: string): string {
  return SAFE_DIAGNOSTIC_ERROR_CODES.has(value) ? value : "DIAGNOSTIC_VALUE_REDACTED";
}

function safeInteger(
  value: number | null | undefined,
  minimum: number,
  maximum: number,
): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= minimum && value <= maximum ? value : null;
}

function safeTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : "1970-01-01T00:00:00.000Z";
}
