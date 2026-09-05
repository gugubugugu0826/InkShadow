export type SafeOperationKind =
  | "story_planning"
  | "opening_creation"
  | "continuation"
  | "chapter_privacy"
  | "story_fact"
  | "consistency_investigation";

export type SafeOperationStage =
  | "read_local_state"
  | "prepare_disclosure"
  | "await_confirmation"
  | "pre_dispatch_check"
  | "reserve_invocation"
  | "provider_dispatch"
  | "persist_result"
  | "settle_terminal_state";

export interface SafeOperationIncident {
  readonly supportId: string;
  readonly occurredAt: string;
  readonly operation: SafeOperationKind;
  readonly stage: SafeOperationStage;
  readonly projectId: string | null;
  readonly chapterId: string | null;
  readonly requestId: string | null;
  readonly normalizedErrorCode: string;
  readonly causeChain: readonly Readonly<{ errorType: string; errorCode: string }>[];
  readonly dispatched: boolean | "unknown";
  readonly automaticRetryCount: 0;
}

interface PersistedState {
  readonly schemaVersion: 1;
  readonly nextSequence: number;
  readonly incidents: readonly SafeOperationIncident[];
}

const STORAGE_KEY = "inkshadow.safe-operation-incidents.v1";
const MAX_INCIDENTS = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,79}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

let memoryState: PersistedState | null = null;

export function recordSafeOperationIncident(
  input: Readonly<{
    operation: SafeOperationKind;
    stage: SafeOperationStage;
    cause: unknown;
    projectId?: string | null;
    chapterId?: string | null;
    requestId?: string | null;
    dispatched?: boolean | "unknown";
    occurredAt?: string;
  }>,
): SafeOperationIncident {
  const state = readState();
  const nextSequence = state.nextSequence + 1;
  const occurredAt = safeTimestamp(input.occurredAt);
  const causeChain = safeCauseChain(input.cause);
  const incident = Object.freeze({
    supportId: `墨影-${occurredAt.replace(/[^0-9]/gu, "").slice(0, 14)}-${String(
      nextSequence,
    ).padStart(3, "0")}`,
    occurredAt,
    operation: input.operation,
    stage: input.stage,
    projectId: safeUuid(input.projectId),
    chapterId: safeUuid(input.chapterId),
    requestId: safeUuid(input.requestId),
    normalizedErrorCode: causeChain[0]?.errorCode ?? "UNEXPECTED_OPERATION_FAILURE",
    causeChain,
    dispatched: input.dispatched ?? "unknown",
    automaticRetryCount: 0 as const,
  } satisfies SafeOperationIncident);
  memoryState = Object.freeze({
    schemaVersion: 1,
    nextSequence,
    incidents: Object.freeze([incident, ...state.incidents].slice(0, MAX_INCIDENTS)),
  });
  persistState(memoryState);
  return incident;
}

export function readSafeOperationIncidents(): readonly SafeOperationIncident[] {
  return Object.freeze([...readState().incidents]);
}

export function resetSafeOperationDiagnosticsForTests(): void {
  memoryState = null;
  safeStorage()?.removeItem(STORAGE_KEY);
}

export function forgetSafeOperationDiagnosticsMemoryForTests(): void {
  memoryState = null;
}

function readState(): PersistedState {
  if (memoryState !== null) return memoryState;
  const storage = safeStorage();
  if (storage !== null) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (
          isRecord(parsed) &&
          parsed.schemaVersion === 1 &&
          Number.isSafeInteger(parsed.nextSequence)
        ) {
          const incidents = Array.isArray(parsed.incidents)
            ? parsed.incidents.flatMap((value) => {
                const incident = parseIncident(value);
                return incident === null ? [] : [incident];
              })
            : [];
          memoryState = Object.freeze({
            schemaVersion: 1,
            nextSequence: Math.max(0, Number(parsed.nextSequence)),
            incidents: Object.freeze(incidents.slice(0, MAX_INCIDENTS)),
          });
          return memoryState;
        }
      }
    } catch {
      // A malformed local diagnostic cache must not block the recovery surface.
    }
  }
  memoryState = Object.freeze({ schemaVersion: 1, nextSequence: 0, incidents: Object.freeze([]) });
  return memoryState;
}

function persistState(state: PersistedState): void {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Diagnostics are additive and must never replace the user-facing failure state.
  }
}

function parseIncident(value: unknown): SafeOperationIncident | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.supportId !== "string" ||
    !/^墨影-[0-9]{14}-[0-9]{3,}$/u.test(value.supportId) ||
    typeof value.occurredAt !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value.occurredAt) ||
    (value.operation !== "story_planning" &&
      value.operation !== "opening_creation" &&
      value.operation !== "continuation" &&
      value.operation !== "chapter_privacy" &&
      value.operation !== "story_fact" &&
      value.operation !== "consistency_investigation") ||
    !isSafeStage(value.stage) ||
    typeof value.normalizedErrorCode !== "string" ||
    !ERROR_CODE_PATTERN.test(value.normalizedErrorCode)
  ) {
    return null;
  }
  const causeChain = Array.isArray(value.causeChain)
    ? value.causeChain.flatMap((cause) => {
        if (!isRecord(cause)) return [];
        const errorCode = safeErrorCode(cause.errorCode);
        const errorType = safeErrorType(cause.errorType);
        return [Object.freeze({ errorType, errorCode })];
      })
    : [];
  return Object.freeze({
    supportId: value.supportId,
    occurredAt: value.occurredAt,
    operation: value.operation,
    stage: value.stage,
    projectId: safeUuid(value.projectId),
    chapterId: safeUuid(value.chapterId),
    requestId: safeUuid(value.requestId),
    normalizedErrorCode: safeErrorCode(value.normalizedErrorCode),
    causeChain: Object.freeze(causeChain.slice(0, 5)),
    dispatched:
      value.dispatched === true || value.dispatched === false ? value.dispatched : "unknown",
    automaticRetryCount: 0,
  });
}

function safeCauseChain(
  cause: unknown,
): readonly Readonly<{ errorType: string; errorCode: string }>[] {
  const chain: Readonly<{ errorType: string; errorCode: string }>[] = [];
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current !== null && current !== undefined && chain.length < 5 && !seen.has(current)) {
    seen.add(current);
    const errorCode = safeErrorCode(isRecord(current) ? current.code : null);
    chain.push(
      Object.freeze({
        errorType: safeErrorType(current instanceof Error ? current.name : null),
        errorCode,
      }),
    );
    const databaseCode = safeDatabaseErrorCode(current);
    if (databaseCode !== null && databaseCode !== errorCode && chain.length < 5) {
      chain.push(Object.freeze({ errorType: "Error", errorCode: databaseCode }));
    }
    current = isRecord(current) && "cause" in current ? current.cause : null;
  }
  return Object.freeze(
    chain.length === 0
      ? [{ errorType: "Error", errorCode: "UNEXPECTED_OPERATION_FAILURE" }]
      : chain,
  );
}

function safeDatabaseErrorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.details)) return null;
  const databaseCode = value.details.databaseCode;
  return typeof databaseCode === "string" && ERROR_CODE_PATTERN.test(databaseCode)
    ? databaseCode
    : null;
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value)
    ? value
    : "UNEXPECTED_OPERATION_FAILURE";
}

function safeErrorType(value: unknown): string {
  return typeof value === "string" && /^[A-Z][A-Za-z0-9]{0,63}$/u.test(value) ? value : "Error";
}

function safeUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function safeTimestamp(value: string | undefined): string {
  if (value !== undefined && ISO_TIMESTAMP_PATTERN.test(value)) return value;
  return new Date().toISOString();
}

function safeStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isSafeStage(value: unknown): value is SafeOperationStage {
  return (
    value === "read_local_state" ||
    value === "prepare_disclosure" ||
    value === "await_confirmation" ||
    value === "pre_dispatch_check" ||
    value === "reserve_invocation" ||
    value === "provider_dispatch" ||
    value === "persist_result" ||
    value === "settle_terminal_state"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
