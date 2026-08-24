export interface StartupFailureIncident {
  readonly schemaVersion: 1;
  readonly supportId: string;
  readonly occurredAt: string;
  readonly normalizedErrorCode: "SQLITE_MIGRATION_INTEGRITY_FAILED" | "SQLITE_MIGRATION_FAILED";
  readonly stage: "migration_history_validation" | "migration_apply" | "database_open";
  readonly reasonCode: string;
  readonly expectedVersion: number | null;
  readonly actualVersion: number | null;
  readonly migrationVersion: number | null;
  readonly whitelistReasonCode: string;
  readonly nativeErrorClass: string;
  readonly sqlitePrimaryCode: number | null;
  readonly sqliteExtendedCode: number | null;
  readonly causeChain: readonly string[];
  readonly componentStack: readonly string[];
}

export interface StartupDiagnosticArtifact {
  readonly fileName: string;
  readonly mediaType: "application/json";
  readonly content: string;
  readonly incident: StartupFailureIncident;
}

interface PersistedStartupIncident {
  readonly supportId: string;
  readonly occurredAt: string;
  readonly fingerprint: string;
}

interface PersistedStartupDiagnosticState {
  readonly schemaVersion: 1;
  readonly nextSequence: number;
  readonly activeIncident: PersistedStartupIncident | null;
}

const STORAGE_KEY = "inkshadow.startup-diagnostic.v1";
const SUPPORT_ID_PATTERN = /^墨影-[0-9]{14}-[0-9]{3,}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE_NATIVE_ERROR_CLASS_PATTERN =
  /^(?:MIGRATE_(?:SOURCE|VERSION_(?:MISSING|MISMATCH|NOT_PRESENT|TOO_(?:OLD|NEW))|DIRTY|OTHER)|SQLITE_(?:BUSY|READ_ONLY|IO_ERROR|CORRUPT|FULL|CONSTRAINT|NOT_A_DATABASE|DATABASE_ERROR)|SQLX_(?:CONFIGURATION|INVALID_ARGUMENT|IO|PROTOCOL|ROW_NOT_FOUND|ENCODE|DECODE|OTHER))$/u;
const SAFE_SQLITE_CLASS_BY_PRIMARY_CODE = new Map<number, string>([
  [5, "SQLITE_BUSY"],
  [8, "SQLITE_READ_ONLY"],
  [10, "SQLITE_IO_ERROR"],
  [11, "SQLITE_CORRUPT"],
  [13, "SQLITE_FULL"],
  [19, "SQLITE_CONSTRAINT"],
  [26, "SQLITE_NOT_A_DATABASE"],
]);
const SAFE_REASON_PATTERN =
  /^(?:MIGRATION_(?:CHECKSUM_UNKNOWN|DESCRIPTION_UNKNOWN|FORWARD_APPLY_FAILED|HISTORY_(?:DIRTY|MISSING_VERSION|UNREADABLE)|VERSION_(?:AHEAD_OF_BUILD|ORDER_INVALID|DUPLICATE|UNKNOWN))|PUBLISHED_MIGRATION_BASELINE_INVALID)$/u;
const SAFE_WHITELIST_PATTERN =
  /^(?:MIGRATION_HISTORY_NOT_AUDITED|NO_PUBLISHED_MIGRATION_MATCH|PUBLISHED_BASELINE_FINGERPRINT_MISMATCH|PUBLISHED_HISTORY_(?:ACCEPTED|INCOMPLETE|NOT_COMPLETED))$/u;
const SAFE_CAUSE_PATTERN =
  /^(?:LocalMigrationError|MigrationSourceError|MigrateError(?:::(?:Execute(?:Migration)?|Source|Version(?:Missing|Mismatch|NotPresent|TooOld|TooNew)|Dirty|Other))?|SqlxError::(?:Database|Configuration|InvalidArgument|Io|Protocol|RowNotFound|Encode|Decode|Other))$/u;
const SAFE_COMPONENT_PATTERN =
  /^(?:native_sqlite_open|NativeSqliteBridge::(?:open_file|open_options_and_migrate)|run_local_migrations|verify_published_v029_manifest|audit_applied_migration_history|Migrator::run_direct|migration_history_validation|migration_apply)$/u;

let memoryState: PersistedStartupDiagnosticState | null = null;

export function isMigrationStartupFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error.code ?? error.normalizedErrorCode;
  return code === "SQLITE_MIGRATION_INTEGRITY_FAILED" || code === "SQLITE_MIGRATION_FAILED";
}

export function recordStartupFailure(
  error: unknown,
  occurredAt = new Date().toISOString(),
): StartupFailureIncident {
  const safe = projectFailure(error);
  const state = readState();
  const fingerprint = projectedFingerprint(safe);
  if (state.activeIncident?.fingerprint === fingerprint) {
    return restoreIncident(state.activeIncident, safe);
  }

  const timestamp = safeTimestamp(occurredAt);
  const nextSequence = state.nextSequence + 1;
  const activeIncident = {
    supportId: `墨影-${timestamp.replace(/[^0-9]/gu, "").slice(0, 14)}-${String(
      nextSequence,
    ).padStart(3, "0")}`,
    occurredAt: timestamp,
    fingerprint,
  };
  memoryState = { schemaVersion: 1, nextSequence, activeIncident };
  persistState(memoryState);
  return restoreIncident(activeIncident, safe);
}

export function clearStartupFailure(): void {
  const state = readState();
  memoryState = { ...state, activeIncident: null };
  persistState(memoryState);
}

export function collectStartupDiagnosticArtifact(
  incident: StartupFailureIncident,
): StartupDiagnosticArtifact {
  const content = JSON.stringify(
    {
      schemaVersion: 1,
      kind: "inkshadow-startup-diagnostic",
      incident,
      recoveryActions: ["reread", "export_redacted_diagnostic", "read_recovery", "safe_exit"],
      privacy: {
        projectContentIncluded: false,
        projectIdeaIncluded: false,
        storyFactsIncluded: false,
        credentialsIncluded: false,
        modelOutputIncluded: false,
        fullPathIncluded: false,
      },
    },
    null,
    2,
  );
  return Object.freeze({
    fileName: `墨影-启动诊断-${incident.occurredAt.slice(0, 10)}-${incident.supportId}.json`,
    mediaType: "application/json",
    content,
    incident,
  });
}

export function resetStartupDiagnosticsForTests(): void {
  memoryState = null;
  safeStorage()?.removeItem(STORAGE_KEY);
}

function projectFailure(
  error: unknown,
): Omit<StartupFailureIncident, "schemaVersion" | "supportId" | "occurredAt"> {
  const source = isRecord(error) ? error : {};
  const sourceCode = source.code ?? source.normalizedErrorCode;
  const normalizedErrorCode =
    sourceCode === "SQLITE_MIGRATION_FAILED"
      ? "SQLITE_MIGRATION_FAILED"
      : "SQLITE_MIGRATION_INTEGRITY_FAILED";
  const stage =
    source.stage === "migration_history_validation" || source.stage === "migration_apply"
      ? source.stage
      : "database_open";
  const reasonCode = safeListedReason(
    source.reasonCode,
    SAFE_REASON_PATTERN,
    "MIGRATION_HISTORY_UNREADABLE",
  );
  const whitelistReasonCode = safeListedReason(
    source.whitelistReasonCode,
    SAFE_WHITELIST_PATTERN,
    "MIGRATION_HISTORY_NOT_AUDITED",
  );
  const nativeErrorClass = safeListedReason(
    source.nativeErrorClass,
    SAFE_NATIVE_ERROR_CLASS_PATTERN,
    "MIGRATE_OTHER",
  );
  const sqliteCodes = safeSqliteCodes(
    source.sqlitePrimaryCode,
    source.sqliteExtendedCode,
    nativeErrorClass,
  );
  const nativeCauseChain = Array.isArray(source.causeChain)
    ? source.causeChain.filter(
        (value): value is string =>
          typeof value === "string" &&
          (SAFE_CAUSE_PATTERN.test(value) ||
            SAFE_NATIVE_ERROR_CLASS_PATTERN.test(value) ||
            SAFE_REASON_PATTERN.test(value)),
      )
    : [];
  const nativeComponentStack = Array.isArray(source.componentStack)
    ? source.componentStack.filter(
        (value): value is string => typeof value === "string" && SAFE_COMPONENT_PATTERN.test(value),
      )
    : [];
  return Object.freeze({
    normalizedErrorCode,
    stage,
    reasonCode,
    expectedVersion: safeVersion(source.expectedVersion),
    actualVersion: safeVersion(source.actualVersion),
    migrationVersion: safeVersion(source.migrationVersion),
    whitelistReasonCode,
    nativeErrorClass: sqliteCodes.nativeErrorClass,
    sqlitePrimaryCode: sqliteCodes.primary,
    sqliteExtendedCode: sqliteCodes.extended,
    causeChain: Object.freeze(
      nativeCauseChain.length > 0
        ? nativeCauseChain.slice(0, 6)
        : ["LocalMigrationError", "MigrateError", reasonCode],
    ),
    componentStack: Object.freeze(
      nativeComponentStack.length > 0
        ? nativeComponentStack.slice(0, 6)
        : ["native_sqlite_open", "NativeSqliteBridge::open_file", "run_local_migrations", stage],
    ),
  });
}

function readState(): PersistedStartupDiagnosticState {
  if (memoryState !== null) return memoryState;
  const storage = safeStorage();
  if (storage !== null) {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw !== null) {
        const value: unknown = JSON.parse(raw);
        const parsed = parseState(value);
        if (parsed !== null) {
          memoryState = parsed;
          return parsed;
        }
      }
    } catch {
      // Startup diagnostics must remain available in memory when storage is unavailable.
    }
  }
  memoryState = { schemaVersion: 1, nextSequence: 0, activeIncident: null };
  return memoryState;
}

function parseState(value: unknown): PersistedStartupDiagnosticState | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.nextSequence) ||
    Number(value.nextSequence) < 0
  ) {
    return null;
  }
  const active = value.activeIncident;
  let activeIncident: PersistedStartupIncident | null = null;
  if (active !== null) {
    if (
      !isRecord(active) ||
      typeof active.supportId !== "string" ||
      !SUPPORT_ID_PATTERN.test(active.supportId) ||
      typeof active.occurredAt !== "string" ||
      !ISO_TIMESTAMP_PATTERN.test(active.occurredAt) ||
      typeof active.fingerprint !== "string" ||
      active.fingerprint.length > 1_000
    ) {
      return null;
    }
    activeIncident = {
      supportId: active.supportId,
      occurredAt: active.occurredAt,
      fingerprint: active.fingerprint,
    };
  }
  return {
    schemaVersion: 1,
    nextSequence: Number(value.nextSequence),
    activeIncident,
  };
}

function restoreIncident(
  persisted: PersistedStartupIncident,
  projected: Omit<StartupFailureIncident, "schemaVersion" | "supportId" | "occurredAt">,
): StartupFailureIncident {
  return Object.freeze({
    schemaVersion: 1,
    supportId: persisted.supportId,
    occurredAt: persisted.occurredAt,
    ...projected,
  });
}

function persistState(state: PersistedStartupDiagnosticState): void {
  try {
    safeStorage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The support number and recovery page remain usable from memory.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function safeListedReason(value: unknown, allowed: RegExp, fallback: string): string {
  return typeof value === "string" && allowed.test(value) ? value : fallback;
}

function safeVersion(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
    ? value
    : null;
}

function safeSqliteCodes(
  primaryValue: unknown,
  extendedValue: unknown,
  nativeErrorClass: string,
): {
  readonly nativeErrorClass: string;
  readonly primary: number | null;
  readonly extended: number | null;
} {
  const primary = safeSqliteCode(primaryValue);
  const extended = safeSqliteCode(extendedValue);
  if (primary === null && extended === null) {
    return { nativeErrorClass, primary: null, extended: null };
  }
  const derivedPrimary = extended === null ? primary : extended & 0xff;
  const expectedClass =
    derivedPrimary === null
      ? null
      : (SAFE_SQLITE_CLASS_BY_PRIMARY_CODE.get(derivedPrimary) ?? null);
  if (
    expectedClass === null ||
    nativeErrorClass !== expectedClass ||
    (primary !== null && primary !== derivedPrimary)
  ) {
    return { nativeErrorClass: "MIGRATE_OTHER", primary: null, extended: null };
  }
  return { nativeErrorClass, primary: derivedPrimary, extended };
}

function safeSqliteCode(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0x7fffffff
    ? value
    : null;
}

function safeTimestamp(value: string): string {
  return ISO_TIMESTAMP_PATTERN.test(value) ? value : new Date().toISOString();
}

function projectedFingerprint(
  incident: Omit<StartupFailureIncident, "schemaVersion" | "supportId" | "occurredAt">,
): string {
  return JSON.stringify([
    incident.normalizedErrorCode,
    incident.stage,
    incident.reasonCode,
    incident.expectedVersion,
    incident.actualVersion,
    incident.migrationVersion,
    incident.whitelistReasonCode,
    incident.nativeErrorClass,
    incident.sqlitePrimaryCode,
    incident.sqliteExtendedCode,
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
