import type { Clock } from "@inkshadow/domain";

import { modelHubCredentialProviderId } from "./model-hub-native-config";
import {
  NOVEL_AI_TASKS,
  type ModelProviderKind,
  type NovelAiTask,
} from "./model-hub-provider-registry";
import {
  isRetiredModelProviderConnection,
  type ModelCapabilityEvidence,
  type ModelCatalogEntry,
  type ModelCostPrivacyProfile,
  type ModelHubPreset,
  type ModelHubStore,
  type ModelProviderConnection,
  type NovelTaskRoute,
  type RecentAiFailure,
} from "./model-hub-store";
import type { CredentialStore, RuntimeMode, SecretSummary } from "./runtime";

export const MODEL_HUB_HYDRATION_PHASES = [
  "UNINITIALIZED",
  "BOOTSTRAPPING",
  "LOADING_CONNECTIONS",
  "RESTORING_SELECTION",
  "CHECKING_CREDENTIAL",
  "LOADING_CATALOG",
  "READY",
  "READY_WITH_WARNINGS",
  "ERROR",
] as const;

export type ModelHubHydrationPhase = (typeof MODEL_HUB_HYDRATION_PHASES)[number];

export const MODEL_HUB_PAGE_ACTIONS = [
  "bootstrap",
  "load_connections",
  "restore_selection",
  "check_credential",
  "load_cached_catalog",
  "save_connection",
  "save_credential",
  "delete_credential",
  "discover_models",
  "verify_capability",
  "refresh_snapshot",
] as const;

export type ModelHubPageAction = (typeof MODEL_HUB_PAGE_ACTIONS)[number];

export type ModelHubCredentialStatus =
  "checking" | "configured" | "missing" | "not_required" | "unavailable" | "error";

export type ModelHubCatalogStatus = "loading" | "ready" | "empty" | "cached_warning" | "error";

export interface ModelHubPageSnapshot {
  readonly phase: ModelHubHydrationPhase;
  readonly providerKind: ModelProviderKind | null;
  readonly selectedConnectionId: string | null;
  readonly connections: readonly ModelProviderConnection[];
  readonly credentialStatus: ModelHubCredentialStatus;
  readonly catalogStatus: ModelHubCatalogStatus;
  readonly catalogEntries: readonly ModelCatalogEntry[];
  readonly selectedModelId: string | null;
  readonly capabilityStatus: "loading" | "ready" | "empty" | "error";
  readonly routeSummary: Readonly<{
    enabledCount: number;
    totalCount: number;
  }>;
  readonly lastAction: ModelHubPageAction | null;
  readonly errorCode: string | null;
  readonly hydratedAt: string | null;
  readonly snapshotRevision: number;
}

export interface ModelHubOperationToken {
  readonly operationId: string;
  readonly coordinatorId: number;
  readonly generation: number;
  readonly action: ModelHubPageAction;
  readonly providerKind: ModelProviderKind | null;
  readonly connectionId: string | null;
  readonly modelId: string | null;
}

let nextModelHubOperationCoordinatorId = 0;

function allocateModelHubOperationCoordinatorId(): number {
  nextModelHubOperationCoordinatorId += 1;
  return nextModelHubOperationCoordinatorId;
}

/**
 * Page-local ordering authority. Store and keyring calls cannot always be
 * aborted, so late results are rejected by generation and target identity.
 * The deduplicated runner is used for idempotent StrictMode bootstrap work.
 */
export class ModelHubOperationCoordinator {
  private readonly coordinatorId = allocateModelHubOperationCoordinatorId();
  private generation = 0;
  private active: ModelHubOperationToken | null = null;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public begin(
    action: ModelHubPageAction,
    target: Readonly<{
      providerKind?: ModelProviderKind | null;
      connectionId?: string | null;
      modelId?: string | null;
    }> = {},
  ): ModelHubOperationToken {
    this.generation += 1;
    this.active = Object.freeze({
      operationId: `model-hub:${String(this.coordinatorId)}:${action}:${String(this.generation)}`,
      coordinatorId: this.coordinatorId,
      generation: this.generation,
      action,
      providerKind: target.providerKind ?? null,
      connectionId: target.connectionId ?? null,
      modelId: target.modelId ?? null,
    });
    return this.active;
  }

  public invalidate(): void {
    this.generation += 1;
    this.active = null;
  }

  public isCurrent(
    token: ModelHubOperationToken,
    resultTarget: Readonly<{
      providerKind?: ModelProviderKind | null;
      connectionId?: string | null;
      modelId?: string | null;
    }> = {},
  ): boolean {
    if (
      this.active?.coordinatorId !== token.coordinatorId ||
      this.active.operationId !== token.operationId ||
      this.active.generation !== token.generation
    ) {
      return false;
    }
    if (
      resultTarget.providerKind !== undefined &&
      token.providerKind !== null &&
      resultTarget.providerKind !== token.providerKind
    ) {
      return false;
    }
    if (
      resultTarget.connectionId !== undefined &&
      token.connectionId !== null &&
      resultTarget.connectionId !== token.connectionId
    ) {
      return false;
    }
    if (
      resultTarget.modelId !== undefined &&
      token.modelId !== null &&
      resultTarget.modelId !== token.modelId
    ) {
      return false;
    }
    return true;
  }

  public runDeduplicated<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const started = operation();
    this.inFlight.set(key, started);
    const cleanup = (): void => {
      if (this.inFlight.get(key) === started) this.inFlight.delete(key);
    };
    void started.then(cleanup, cleanup);
    return started;
  }
}

export interface AuthoritativeModelHubHydration {
  readonly page: ModelHubPageSnapshot;
  readonly selectedConnection: ModelProviderConnection | null;
  readonly credential: SecretSummary | null;
  readonly credentialErrorCode: string | null;
  readonly selectedCatalog: readonly ModelCatalogEntry[];
  readonly allCatalogEntries: readonly ModelCatalogEntry[];
  readonly selectedCatalogEntry: ModelCatalogEntry | null;
  readonly selectedCostPrivacy: ModelCostPrivacyProfile | null;
  readonly selectedCapabilities: readonly ModelCapabilityEvidence[];
  readonly routes: readonly NovelTaskRoute[];
  readonly activePreset: ModelHubPreset | null;
  readonly routingCapabilityEvidence: readonly ModelCapabilityEvidence[];
  readonly routingCostPrivacyProfiles: readonly ModelCostPrivacyProfile[];
  readonly recentAiFailures: readonly RecentAiFailure[];
  readonly evidenceConfirmedLocalCatalogIds: readonly string[];
}

export interface LoadAuthoritativeModelHubHydrationInput {
  readonly modelHub: ModelHubStore;
  readonly credentials: Pick<CredentialStore, "getSummary">;
  readonly mode: RuntimeMode;
  readonly clock: Clock;
  readonly requestedConnectionId?: string | null;
  readonly requestedModelId?: string | null;
  readonly snapshotRevision: number;
  readonly lastAction: ModelHubPageAction;
  readonly credentialTimeoutMs?: number;
  readonly onPhase?: (phase: ModelHubHydrationPhase) => void;
}

export async function loadAuthoritativeModelHubHydration(
  input: LoadAuthoritativeModelHubHydrationInput,
): Promise<AuthoritativeModelHubHydration> {
  input.onPhase?.("LOADING_CONNECTIONS");
  const connections = await input.modelHub.listConnections();
  input.onPhase?.("RESTORING_SELECTION");
  const [catalogGroups, routeGroups] = await Promise.all([
    Promise.all(connections.map(({ id }) => input.modelHub.listCatalog(id))),
    Promise.all(NOVEL_AI_TASKS.map((task) => input.modelHub.findTaskRoute(task))),
  ]);
  const allCatalogEntries = Object.freeze(catalogGroups.flat());
  const selectableConnections = connections.filter(
    ({ enabled, connectionStatus }) => enabled && connectionStatus !== "disabled",
  );
  const requestedConnection = connections.find(({ id }) => id === input.requestedConnectionId);
  const requestedRebindTarget =
    requestedConnection !== undefined &&
    !requestedConnection.enabled &&
    !isRetiredModelProviderConnection(requestedConnection)
      ? requestedConnection
      : undefined;
  const proseRoute = routeGroups.find(
    (route) => route?.task === "prose_generation" && route.enabled,
  );
  const routedCatalogEntry = allCatalogEntries.find(
    ({ id }) => id === proseRoute?.primaryCatalogEntryId,
  );
  const selectedConnection =
    selectableConnections.find(({ id }) => id === input.requestedConnectionId) ??
    requestedRebindTarget ??
    selectableConnections.find(({ id }) => id === routedCatalogEntry?.connectionId) ??
    selectableConnections[0] ??
    connections.find(
      (connection) => !connection.enabled && !isRetiredModelProviderConnection(connection),
    ) ??
    null;

  input.onPhase?.("CHECKING_CREDENTIAL");
  const credentialResult = await readCredentialSummary(input, selectedConnection);

  input.onPhase?.("LOADING_CATALOG");
  const [activePreset, recentAiFailures] = await Promise.all([
    input.modelHub.findActivePreset(),
    input.modelHub.listRecentAiFailures(25).catch(() => Object.freeze([])),
  ]);
  const selectedCatalog = Object.freeze(
    selectedConnection === null
      ? []
      : allCatalogEntries.filter(({ connectionId }) => connectionId === selectedConnection.id),
  );
  const routes = Object.freeze(
    routeGroups.filter((route): route is NovelTaskRoute => route !== null),
  );
  const selectedCatalogEntry =
    selectedCatalog.find(({ providerModelId }) => providerModelId === input.requestedModelId) ??
    selectedCatalog.find(({ id }) => id === proseRoute?.primaryCatalogEntryId) ??
    selectedCatalog.find(({ availability }) => availability === "available") ??
    null;

  const [selectedCostPrivacy, selectedCapabilities, evidenceGroups, costProfiles] =
    await Promise.all([
      selectedCatalogEntry === null
        ? Promise.resolve(null)
        : input.modelHub.findCostPrivacyProfile(selectedCatalogEntry.id),
      selectedCatalogEntry === null
        ? Promise.resolve(Object.freeze([]) as readonly ModelCapabilityEvidence[])
        : input.modelHub.listCapabilityEvidence(selectedCatalogEntry.id),
      Promise.all(
        allCatalogEntries.map((entry) => input.modelHub.listCapabilityEvidence(entry.id)),
      ),
      Promise.all(
        allCatalogEntries.map((entry) => input.modelHub.findCostPrivacyProfile(entry.id)),
      ),
    ]);
  const routingCostPrivacyProfiles = Object.freeze(
    costProfiles.filter((profile): profile is ModelCostPrivacyProfile => profile !== null),
  );
  const evidenceConfirmedLocalCatalogIds = Object.freeze(
    allCatalogEntries.flatMap((entry) => {
      const profile = routingCostPrivacyProfiles.find(
        ({ catalogEntryId }) => catalogEntryId === entry.id,
      );
      return profile?.dataDestination === "local" && profile.evidenceSource !== "unknown"
        ? [entry.id]
        : [];
    }),
  );
  const credentialRequired = connectionRequiresCredential(selectedConnection);
  const credentialStatus = !credentialRequired
    ? "not_required"
    : credentialResult.errorCode !== null
      ? "error"
      : input.mode !== "tauri"
        ? "unavailable"
        : credentialResult.summary?.configured === true
          ? "configured"
          : "missing";
  const page = Object.freeze({
    phase: credentialResult.errorCode === null ? "READY" : "READY_WITH_WARNINGS",
    providerKind: selectedConnection?.providerKind ?? null,
    selectedConnectionId: selectedConnection?.id ?? null,
    connections,
    credentialStatus,
    catalogStatus: selectedCatalog.length > 0 ? "ready" : "empty",
    catalogEntries: selectedCatalog,
    selectedModelId: selectedCatalogEntry?.providerModelId ?? null,
    capabilityStatus: selectedCatalogEntry === null ? "empty" : "ready",
    routeSummary: Object.freeze({
      enabledCount: routes.filter(({ enabled }) => enabled).length,
      totalCount: NOVEL_AI_TASKS.length,
    }),
    lastAction: input.lastAction,
    errorCode: credentialResult.errorCode,
    hydratedAt: input.clock.now(),
    snapshotRevision: input.snapshotRevision,
  } satisfies ModelHubPageSnapshot);

  return Object.freeze({
    page,
    selectedConnection,
    credential: credentialResult.summary,
    credentialErrorCode: credentialResult.errorCode,
    selectedCatalog,
    allCatalogEntries,
    selectedCatalogEntry,
    selectedCostPrivacy,
    selectedCapabilities,
    routes,
    activePreset,
    routingCapabilityEvidence: Object.freeze(evidenceGroups.flat()),
    routingCostPrivacyProfiles,
    recentAiFailures,
    evidenceConfirmedLocalCatalogIds,
  });
}

export function createInitialModelHubPageSnapshot(): ModelHubPageSnapshot {
  return Object.freeze({
    phase: "UNINITIALIZED",
    providerKind: null,
    selectedConnectionId: null,
    connections: Object.freeze([]),
    credentialStatus: "checking",
    catalogStatus: "loading",
    catalogEntries: Object.freeze([]),
    selectedModelId: null,
    capabilityStatus: "loading",
    routeSummary: Object.freeze({ enabledCount: 0, totalCount: NOVEL_AI_TASKS.length }),
    lastAction: null,
    errorCode: null,
    hydratedAt: null,
    snapshotRevision: 0,
  });
}

export function createProviderDraftModelHubPageSnapshot(
  current: ModelHubPageSnapshot,
  input: Readonly<{
    providerKind: ModelProviderKind;
    credentialRequired: boolean;
    hydratedAt: string;
    snapshotRevision: number;
  }>,
): ModelHubPageSnapshot {
  return Object.freeze({
    ...current,
    phase: "READY",
    providerKind: input.providerKind,
    selectedConnectionId: null,
    credentialStatus: input.credentialRequired ? "missing" : "not_required",
    catalogStatus: "empty",
    catalogEntries: Object.freeze([]),
    selectedModelId: null,
    capabilityStatus: "empty",
    lastAction: "restore_selection",
    errorCode: null,
    hydratedAt: input.hydratedAt,
    snapshotRevision: input.snapshotRevision,
  });
}

export function transitionModelHubPageSnapshot(
  current: ModelHubPageSnapshot,
  phase: ModelHubHydrationPhase,
  action: ModelHubPageAction,
): ModelHubPageSnapshot {
  return Object.freeze({
    ...current,
    phase,
    credentialStatus: phase === "CHECKING_CREDENTIAL" ? "checking" : current.credentialStatus,
    catalogStatus: phase === "LOADING_CATALOG" ? "loading" : current.catalogStatus,
    capabilityStatus: phase === "LOADING_CATALOG" ? "loading" : current.capabilityStatus,
    lastAction: action,
    errorCode: null,
  });
}

export function preserveModelHubPageSnapshotAfterFailure(
  current: ModelHubPageSnapshot,
  input: Readonly<{
    action: ModelHubPageAction;
    errorCode: string;
    catalogRefreshFailed?: boolean;
    failedPhase?: ModelHubHydrationPhase;
    hydratedAt: string;
  }>,
): ModelHubPageSnapshot {
  const hasPersistedState =
    current.hydratedAt !== null ||
    current.connections.length > 0 ||
    current.catalogEntries.length > 0;
  return Object.freeze({
    ...current,
    phase: hasPersistedState ? "READY_WITH_WARNINGS" : "ERROR",
    credentialStatus:
      input.action === "check_credential" || input.failedPhase === "CHECKING_CREDENTIAL"
        ? "error"
        : current.credentialStatus,
    catalogStatus:
      input.catalogRefreshFailed === true && current.catalogEntries.length > 0
        ? "cached_warning"
        : input.catalogRefreshFailed === true
          ? "error"
          : current.catalogStatus,
    lastAction: input.action,
    errorCode: input.errorCode,
    hydratedAt: input.hydratedAt,
  });
}

export function modelHubHydrationPhaseLabel(phase: ModelHubHydrationPhase): string {
  const labels: Record<ModelHubHydrationPhase, string> = {
    UNINITIALIZED: "正在准备模型中心……",
    BOOTSTRAPPING: "正在读取已保存的 AI 连接……",
    LOADING_CONNECTIONS: "正在读取已保存的 AI 连接……",
    RESTORING_SELECTION: "正在恢复上次使用的 AI 连接……",
    CHECKING_CREDENTIAL: "正在检查系统凭据……",
    LOADING_CATALOG: "正在载入模型目录和 AI 分工……",
    READY: "模型中心已载入",
    READY_WITH_WARNINGS: "模型中心已载入，但有一项需要重试",
    ERROR: "模型中心暂时无法读取",
  };
  return labels[phase];
}

export function isModelHubHydrationPending(phase: ModelHubHydrationPhase): boolean {
  return (
    phase === "UNINITIALIZED" ||
    phase === "BOOTSTRAPPING" ||
    phase === "LOADING_CONNECTIONS" ||
    phase === "RESTORING_SELECTION" ||
    phase === "CHECKING_CREDENTIAL" ||
    phase === "LOADING_CATALOG"
  );
}

async function readCredentialSummary(
  input: LoadAuthoritativeModelHubHydrationInput,
  selectedConnection: ModelProviderConnection | null,
): Promise<Readonly<{ summary: SecretSummary | null; errorCode: string | null }>> {
  if (input.mode !== "tauri") {
    return Object.freeze({ summary: null, errorCode: null });
  }
  if (selectedConnection === null) {
    return Object.freeze({ summary: { configured: false, lastFour: null }, errorCode: null });
  }
  if (
    selectedConnection.credentialRef === null &&
    selectedConnection.credentialState === "missing"
  ) {
    // A deleted credential is an explicit local recovery state. Never guess a
    // vault slot from the connection id merely to render the rebind form.
    return Object.freeze({ summary: { configured: false, lastFour: null }, errorCode: null });
  }
  if (!connectionRequiresCredential(selectedConnection)) {
    return Object.freeze({ summary: null, errorCode: null });
  }
  try {
    return Object.freeze({
      summary: await waitForCredentialSummary(
        input.credentials.getSummary(modelHubCredentialProviderId(selectedConnection)),
        input.credentialTimeoutMs ?? 5_000,
      ),
      errorCode: null,
    });
  } catch (cause: unknown) {
    return Object.freeze({
      summary: null,
      errorCode:
        cause instanceof ModelHubCredentialStatusTimeoutError
          ? "MODEL_HUB_CREDENTIAL_STATUS_TIMEOUT"
          : safeErrorCode(cause),
    });
  }
}

class ModelHubCredentialStatusTimeoutError extends Error {}

function waitForCredentialSummary<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5_000;
  return new Promise<T>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new ModelHubCredentialStatusTimeoutError());
    }, boundedTimeoutMs);
    void promise.then(
      (value) => {
        globalThis.clearTimeout(timeout);
        resolve(value);
      },
      (cause: unknown) => {
        globalThis.clearTimeout(timeout);
        if (cause instanceof Error) {
          reject(cause);
          return;
        }
        const code = safeErrorCode(cause);
        reject(Object.assign(new Error(code), { code }));
      },
    );
  });
}

function connectionRequiresCredential(connection: ModelProviderConnection | null): boolean {
  // An absent connection is still an unconfigured credential-required state from the
  // default Model Hub entry point. Only a persisted connection that explicitly uses
  // no authentication (for example Ollama) may be reported as not requiring a key.
  if (connection === null) return true;
  return connection.authenticationMode !== "none";
}

function safeErrorCode(cause: unknown): string {
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
    ? cause.code
    : "MODEL_HUB_CREDENTIAL_STATUS_UNAVAILABLE";
}

export function enabledModelHubRouteCount(
  routes: readonly NovelTaskRoute[],
  tasks: readonly NovelAiTask[] = NOVEL_AI_TASKS,
): number {
  const taskSet = new Set(tasks);
  return routes.filter(({ enabled, task }) => enabled && taskSet.has(task)).length;
}
