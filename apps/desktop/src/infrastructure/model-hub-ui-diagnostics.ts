import {
  MODEL_HUB_PAGE_ACTIONS,
  type ModelHubOperationToken,
  type ModelHubPageAction,
  type ModelHubPageSnapshot,
} from "./model-hub-page-hydration";
import { isModelProviderKind } from "./model-hub-provider-registry";

export interface SafeModelHubUiSnapshotDiagnostic {
  readonly exportedAt: string;
  readonly pageMounted: boolean;
  readonly pageMountedAt: string;
  readonly pageUnmountedAt: string | null;
  readonly hydrationPhase: ModelHubPageSnapshot["phase"];
  readonly phaseStartedAt: string;
  readonly hydrationStartedAt: string | null;
  readonly hydrationCompletedAt: string | null;
  readonly selectedProviderKind: ModelHubPageSnapshot["providerKind"];
  readonly selectedConnectionId: string | null;
  readonly connectionCountInUi: number;
  readonly credentialUiStatus: ModelHubPageSnapshot["credentialStatus"];
  readonly catalogUiStatus: ModelHubPageSnapshot["catalogStatus"];
  readonly catalogEntryCountInUi: number;
  readonly selectedModelIdInUi: string | null;
  readonly lastSnapshotRevision: number;
}

export type SafeModelHubActionOutcome =
  "running" | "succeeded" | "succeeded_with_warning" | "failed" | "cancelled" | "stale_ignored";

export interface SafeModelHubActionDiagnostic {
  readonly diagnosticId: string;
  readonly timestamp: string;
  readonly action: ModelHubPageAction;
  readonly operationId: string;
  readonly providerKind: ModelHubOperationToken["providerKind"];
  readonly connectionId: string | null;
  readonly modelId: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly outcome: SafeModelHubActionOutcome;
  readonly backendCommitted: boolean;
  readonly storeRefreshed: boolean;
  readonly staleResultIgnored: boolean;
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
  readonly catalogCount: number | null;
}

export interface SafeModelHubSessionDiagnostics {
  readonly currentSessionStartedAt: string;
  readonly modelHubUiSnapshot: SafeModelHubUiSnapshotDiagnostic | null;
  readonly recentModelHubActions: readonly SafeModelHubActionDiagnostic[];
  readonly currentSessionErrorCodes: readonly string[];
}

interface MutableSessionState {
  readonly startedAt: string;
  pageMounted: boolean;
  pageMountedAt: string | null;
  pageUnmountedAt: string | null;
  mountBootstrapCoordinatorId: number | null;
  pendingMountBootstrap: Readonly<{
    coordinatorId: number;
    startedAt: string;
  }> | null;
  hydrationStartedAt: string | null;
  hydrationCompletedAt: string | null;
  phase: ModelHubPageSnapshot["phase"] | null;
  phaseStartedAt: string | null;
  lastInitialSnapshot: ModelHubPageSnapshot | null;
  snapshot: SafeModelHubUiSnapshotDiagnostic | null;
  actions: SafeModelHubActionDiagnostic[];
}

const MAX_ACTIONS = 25;
const SAFE_ACTION_ERROR_CODES = new Set([
  "MODEL_HUB_CATALOG_REFRESH_FAILED",
  "MODEL_HUB_STALE_RESULT_IGNORED",
]);
const states = new WeakMap<object, MutableSessionState>();

export function recordModelHubUiSnapshot(
  owner: object,
  snapshot: ModelHubPageSnapshot,
  exportedAt: string,
): void {
  exportedAt = safeTimestamp(exportedAt);
  const state = ensureState(owner, exportedAt);
  state.pageMounted = true;
  state.pageUnmountedAt = null;
  if (
    snapshot.phase === "UNINITIALIZED" &&
    snapshot.hydratedAt === null &&
    snapshot.snapshotRevision === 0 &&
    state.lastInitialSnapshot !== snapshot
  ) {
    const pendingMountBootstrap = state.pendingMountBootstrap;
    state.pageMountedAt = exportedAt;
    state.mountBootstrapCoordinatorId = pendingMountBootstrap?.coordinatorId ?? null;
    state.pendingMountBootstrap = null;
    state.hydrationStartedAt = pendingMountBootstrap?.startedAt ?? null;
    state.hydrationCompletedAt = null;
    state.phase = null;
    state.phaseStartedAt = null;
    state.lastInitialSnapshot = snapshot;
  }
  state.pageMountedAt ??= exportedAt;
  if (state.phase !== snapshot.phase) {
    state.phase = snapshot.phase;
    state.phaseStartedAt = exportedAt;
  }
  if (
    snapshot.lastAction === "bootstrap" &&
    snapshot.hydratedAt !== null &&
    (snapshot.phase === "READY" ||
      snapshot.phase === "READY_WITH_WARNINGS" ||
      snapshot.phase === "ERROR")
  ) {
    state.hydrationCompletedAt = safeTimestamp(snapshot.hydratedAt);
  }
  state.snapshot = Object.freeze({
    exportedAt,
    pageMounted: state.pageMounted,
    pageMountedAt: state.pageMountedAt,
    pageUnmountedAt: state.pageUnmountedAt,
    hydrationPhase: snapshot.phase,
    phaseStartedAt: state.phaseStartedAt ?? exportedAt,
    hydrationStartedAt: state.hydrationStartedAt,
    hydrationCompletedAt: state.hydrationCompletedAt,
    selectedProviderKind: isModelProviderKind(snapshot.providerKind) ? snapshot.providerKind : null,
    selectedConnectionId: null,
    connectionCountInUi: snapshot.connections.length,
    credentialUiStatus: snapshot.credentialStatus,
    catalogUiStatus: snapshot.catalogStatus,
    catalogEntryCountInUi: snapshot.catalogEntries.length,
    selectedModelIdInUi: null,
    lastSnapshotRevision: snapshot.snapshotRevision,
  });
}

export function recordModelHubUiUnmount(owner: object, timestamp: string): void {
  timestamp = safeTimestamp(timestamp);
  const state = ensureState(owner, timestamp);
  state.pageMounted = false;
  state.pageUnmountedAt = timestamp;
  if (state.snapshot !== null) {
    state.snapshot = Object.freeze({
      ...state.snapshot,
      exportedAt: timestamp,
      pageMounted: false,
      pageUnmountedAt: timestamp,
    });
  }
}

export function startModelHubDiagnosticAction(
  owner: object,
  token: ModelHubOperationToken,
  timestamp: string,
): void {
  timestamp = safeTimestamp(timestamp);
  const state = ensureState(owner, timestamp);
  const operationId = safeOperationId(token);
  if (token.action === "bootstrap") {
    const bootstrapStartedBeforeInitialSnapshot = state.lastInitialSnapshot === null;
    const bootstrapStartedByNewCoordinator =
      state.mountBootstrapCoordinatorId !== null &&
      state.mountBootstrapCoordinatorId !== token.coordinatorId;
    if (bootstrapStartedBeforeInitialSnapshot || bootstrapStartedByNewCoordinator) {
      state.pendingMountBootstrap = Object.freeze({
        coordinatorId: token.coordinatorId,
        startedAt: timestamp,
      });
    } else {
      state.mountBootstrapCoordinatorId ??= token.coordinatorId;
    }
    state.hydrationStartedAt = timestamp;
  }
  state.actions = [
    Object.freeze({
      diagnosticId: operationId,
      timestamp,
      action: token.action,
      operationId,
      providerKind: isModelProviderKind(token.providerKind) ? token.providerKind : null,
      connectionId: null,
      modelId: null,
      startedAt: timestamp,
      completedAt: null,
      outcome: "running",
      backendCommitted: false,
      storeRefreshed: false,
      staleResultIgnored: false,
      errorCode: null,
      httpStatus: null,
      catalogCount: null,
    }),
    ...state.actions.filter((action) => action.operationId !== operationId),
  ].slice(0, MAX_ACTIONS);
}

export function finishModelHubDiagnosticAction(
  owner: object,
  token: ModelHubOperationToken,
  input: Readonly<{
    completedAt: string;
    outcome: Exclude<SafeModelHubActionOutcome, "running">;
    backendCommitted?: boolean;
    storeRefreshed?: boolean;
    staleResultIgnored?: boolean;
    errorCode?: string | null;
    httpStatus?: number | null;
    catalogCount?: number | null;
  }>,
): void {
  const completedAt = safeTimestamp(input.completedAt);
  const state = ensureState(owner, completedAt);
  const operationId = safeOperationId(token);
  const existing = state.actions.find((action) => action.operationId === operationId);
  const startedAt = existing?.startedAt ?? completedAt;
  const completed = Object.freeze({
    diagnosticId: operationId,
    timestamp: startedAt,
    action: token.action,
    operationId,
    providerKind: isModelProviderKind(token.providerKind) ? token.providerKind : null,
    connectionId: null,
    modelId: null,
    startedAt,
    completedAt,
    outcome: input.outcome,
    backendCommitted: input.backendCommitted ?? false,
    storeRefreshed: input.storeRefreshed ?? false,
    staleResultIgnored: input.staleResultIgnored ?? input.outcome === "stale_ignored",
    errorCode: safeActionErrorCode(input.errorCode),
    httpStatus: safeInteger(input.httpStatus, 100, 599),
    catalogCount: safeInteger(input.catalogCount, 0, 1_000_000),
  } satisfies SafeModelHubActionDiagnostic);
  state.actions = [
    completed,
    ...state.actions.filter((action) => action.operationId !== operationId),
  ].slice(0, MAX_ACTIONS);
}

export function readSafeModelHubSessionDiagnostics(
  owner: object,
  now: string,
): SafeModelHubSessionDiagnostics {
  now = safeTimestamp(now);
  const state = ensureState(owner, now);
  return Object.freeze({
    currentSessionStartedAt: state.startedAt,
    modelHubUiSnapshot:
      state.snapshot === null ? null : Object.freeze({ ...state.snapshot, exportedAt: now }),
    recentModelHubActions: Object.freeze([...state.actions]),
    currentSessionErrorCodes: Object.freeze([
      ...new Set(state.actions.flatMap(({ errorCode }) => (errorCode === null ? [] : [errorCode]))),
    ]),
  });
}

export function resetModelHubSessionDiagnosticsForTests(owner: object): void {
  states.delete(owner);
}

function ensureState(owner: object, now: string): MutableSessionState {
  const existing = states.get(owner);
  if (existing !== undefined) return existing;
  const created: MutableSessionState = {
    startedAt: now,
    pageMounted: false,
    pageMountedAt: null,
    pageUnmountedAt: null,
    mountBootstrapCoordinatorId: null,
    pendingMountBootstrap: null,
    hydrationStartedAt: null,
    hydrationCompletedAt: null,
    phase: null,
    phaseStartedAt: null,
    lastInitialSnapshot: null,
    snapshot: null,
    actions: [],
  };
  states.set(owner, created);
  return created;
}

function safeOperationId(token: ModelHubOperationToken): string {
  const coordinatorId = safeInteger(token.coordinatorId, 1, Number.MAX_SAFE_INTEGER) ?? 0;
  const generation = safeInteger(token.generation, 1, Number.MAX_SAFE_INTEGER) ?? 0;
  const action = (MODEL_HUB_PAGE_ACTIONS as readonly unknown[]).includes(token.action)
    ? token.action
    : "bootstrap";
  return `model-hub:${String(coordinatorId)}:${action}:${String(generation)}`;
}

function safeActionErrorCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return SAFE_ACTION_ERROR_CODES.has(value) ? value : "MODEL_HUB_ACTION_FAILED";
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
