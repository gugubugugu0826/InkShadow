import type {
  ModelHubOperationToken,
  ModelHubPageAction,
  ModelHubPageSnapshot,
} from "./model-hub-page-hydration";

export interface SafeModelHubUiSnapshotDiagnostic {
  readonly exportedAt: string;
  readonly pageMounted: true;
  readonly hydrationPhase: ModelHubPageSnapshot["phase"];
  readonly hydrationStartedAt: string;
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
  hydrationStartedAt: string | null;
  snapshot: SafeModelHubUiSnapshotDiagnostic | null;
  actions: SafeModelHubActionDiagnostic[];
}

const MAX_ACTIONS = 25;
const states = new WeakMap<object, MutableSessionState>();

export function recordModelHubUiSnapshot(
  owner: object,
  snapshot: ModelHubPageSnapshot,
  exportedAt: string,
): void {
  const state = ensureState(owner, exportedAt);
  state.hydrationStartedAt ??= exportedAt;
  state.snapshot = Object.freeze({
    exportedAt,
    pageMounted: true,
    hydrationPhase: snapshot.phase,
    hydrationStartedAt: state.hydrationStartedAt,
    hydrationCompletedAt: snapshot.hydratedAt,
    selectedProviderKind: snapshot.providerKind,
    selectedConnectionId: snapshot.selectedConnectionId,
    connectionCountInUi: snapshot.connections.length,
    credentialUiStatus: snapshot.credentialStatus,
    catalogUiStatus: snapshot.catalogStatus,
    catalogEntryCountInUi: snapshot.catalogEntries.length,
    selectedModelIdInUi: snapshot.selectedModelId,
    lastSnapshotRevision: snapshot.snapshotRevision,
  });
}

export function startModelHubDiagnosticAction(
  owner: object,
  token: ModelHubOperationToken,
  timestamp: string,
): void {
  const state = ensureState(owner, timestamp);
  state.actions = [
    Object.freeze({
      diagnosticId: token.operationId,
      timestamp,
      action: token.action,
      operationId: token.operationId,
      providerKind: token.providerKind,
      connectionId: token.connectionId,
      modelId: token.modelId,
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
    ...state.actions.filter(({ operationId }) => operationId !== token.operationId),
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
  const state = ensureState(owner, input.completedAt);
  const existing = state.actions.find(({ operationId }) => operationId === token.operationId);
  const startedAt = existing?.startedAt ?? input.completedAt;
  const completed = Object.freeze({
    diagnosticId: token.operationId,
    timestamp: startedAt,
    action: token.action,
    operationId: token.operationId,
    providerKind: token.providerKind,
    connectionId: token.connectionId,
    modelId: token.modelId,
    startedAt,
    completedAt: input.completedAt,
    outcome: input.outcome,
    backendCommitted: input.backendCommitted ?? false,
    storeRefreshed: input.storeRefreshed ?? false,
    staleResultIgnored: input.staleResultIgnored ?? input.outcome === "stale_ignored",
    errorCode: input.errorCode ?? null,
    httpStatus: input.httpStatus ?? null,
    catalogCount: input.catalogCount ?? null,
  } satisfies SafeModelHubActionDiagnostic);
  state.actions = [
    completed,
    ...state.actions.filter(({ operationId }) => operationId !== token.operationId),
  ].slice(0, MAX_ACTIONS);
}

export function readSafeModelHubSessionDiagnostics(
  owner: object,
  now: string,
): SafeModelHubSessionDiagnostics {
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
    hydrationStartedAt: null,
    snapshot: null,
    actions: [],
  };
  states.set(owner, created);
  return created;
}
