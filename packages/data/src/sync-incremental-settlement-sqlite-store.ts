import { AppError, err, ok, type Result } from "@inkshadow/domain";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";
import {
  advanceSyncMaterializedCheckpointInTransaction,
  type SyncMaterializedCheckpoint,
} from "./sync-materialization-sqlite-store.js";

export type SyncIncrementalSettlementBlockReason =
  | "content_conflict"
  | "incoming_attempt_exhausted"
  | "incoming_conflict"
  | "incoming_permanent_failure"
  | "incoming_pending"
  | "pull_incomplete"
  | "snapshot_pending";

export interface SettleSyncIncrementalMaterializationInput {
  readonly projectId: string;
  readonly signedRemoteCursor: string;
  readonly downloadedCheckpointRevision: number;
  readonly expectedMaterializedCheckpointRevision: number | null;
  readonly settledAt: string;
}

export interface SyncIncrementalSettlementTarget {
  readonly projectId: string;
  readonly signedRemoteCursor: string;
  readonly downloadedCheckpointRevision: number;
  readonly downloadedAt: string;
  readonly settledAt: string;
}

export interface SyncIncrementalSettlementCounts {
  readonly snapshotPendingCount: number;
  readonly incomingPendingCount: number;
  readonly incomingPermanentFailureCount: number;
  readonly incomingAttemptExhaustedCount: number;
  readonly incomingConflictCount: number;
  readonly unresolvedContentConflictCount: number;
}

export type SyncIncrementalSettlementResult =
  | Readonly<{
      status: "blocked";
      reason: SyncIncrementalSettlementBlockReason;
      target: SyncIncrementalSettlementTarget;
      counts: SyncIncrementalSettlementCounts;
      checkpoint: null;
      checkpointAdvanced: false;
    }>
  | Readonly<{
      status: "settled";
      reason: "advanced" | "already_settled";
      target: SyncIncrementalSettlementTarget;
      counts: SyncIncrementalSettlementCounts;
      checkpoint: SyncMaterializedCheckpoint;
      checkpointAdvanced: boolean;
    }>;

export interface SyncIncrementalSettlementFinalizerContext {
  readonly target: SyncIncrementalSettlementTarget;
  readonly checkpoint: SyncMaterializedCheckpoint;
  readonly checkpointAdvanced: boolean;
}

export type SyncIncrementalSettlementFinalizer = (
  transaction: TransactionExecutor,
  context: SyncIncrementalSettlementFinalizerContext,
) => Promise<void> | void;

interface RemoteCheckpointDbRow {
  readonly signed_remote_cursor: string;
  readonly revision: number;
  readonly updated_at: string;
}

interface MaterializedCheckpointDbRow {
  readonly project_id: string;
  readonly signed_remote_cursor: string;
  readonly downloaded_checkpoint_revision: number;
  readonly revision: number;
  readonly updated_at: string;
}

interface SettlementCountsDbRow {
  readonly snapshot_pending_count: number;
  readonly incoming_pending_count: number;
  readonly incoming_permanent_failure_count: number;
  readonly incoming_attempt_exhausted_count: number;
  readonly incoming_conflict_count: number;
  readonly unresolved_content_conflict_count: number;
}

interface TargetBatchDbRow {
  readonly has_more: number;
}

interface TerminalObservationDbRow {
  readonly observation_count: number;
}

/**
 * Proves that one exact downloaded incremental cursor is fully reflected in
 * plaintext state before advancing the materialized checkpoint. The optional
 * finalizer shares the same SQLite transaction so registration enablement and
 * initial projection seeding cannot become visible independently.
 */
export class SyncIncrementalSettlementSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async settleAtomically(
    inputValue: SettleSyncIncrementalMaterializationInput,
    finalizer: SyncIncrementalSettlementFinalizer = () => undefined,
  ): Promise<Result<SyncIncrementalSettlementResult, AppError>> {
    return attempt("SYNC_INCREMENTAL_SETTLEMENT_FAILED", async () => {
      const input = normalizeInput(inputValue);
      if (typeof finalizer !== "function") {
        throw validationError("An incremental settlement finalizer is required.");
      }

      return this.executor.transaction(async (transaction) => {
        const target = await requireExactRemoteCheckpoint(transaction, input);
        const existing = await readMaterializedCheckpoint(transaction, input.projectId);
        requireExpectedMaterializedCheckpoint(existing, input);
        requireNonRegressingTarget(existing, target);
        const counts = await readSettlementCounts(transaction, input.projectId);
        const blockReason = await findBlockReason(transaction, target, existing, counts);
        if (blockReason !== null) {
          return {
            status: "blocked",
            reason: blockReason,
            target,
            counts,
            checkpoint: null,
            checkpointAdvanced: false,
          };
        }

        const alreadySettled =
          existing !== null &&
          existing.signedRemoteCursor === target.signedRemoteCursor &&
          existing.downloadedCheckpointRevision === target.downloadedCheckpointRevision;
        const checkpoint = alreadySettled
          ? existing
          : requireResult(
              await advanceSyncMaterializedCheckpointInTransaction(transaction, {
                projectId: target.projectId,
                signedRemoteCursor: target.signedRemoteCursor,
                downloadedCheckpointRevision: target.downloadedCheckpointRevision,
                expectedRevision: input.expectedMaterializedCheckpointRevision,
                updatedAt: target.settledAt,
              }),
            );
        const checkpointAdvanced = !alreadySettled;

        await finalizer(transaction, {
          target,
          checkpoint,
          checkpointAdvanced,
        });
        await requireSettlementStillExact(transaction, target, checkpoint);

        return {
          status: "settled",
          reason: checkpointAdvanced ? "advanced" : "already_settled",
          target,
          counts,
          checkpoint,
          checkpointAdvanced,
        };
      });
    });
  }
}

async function requireExactRemoteCheckpoint(
  transaction: TransactionExecutor,
  input: SettleSyncIncrementalMaterializationInput,
): Promise<SyncIncrementalSettlementTarget> {
  const rows = await transaction.select<RemoteCheckpointDbRow>(
    `SELECT signed_remote_cursor, revision, updated_at
     FROM sync_remote_checkpoints
     WHERE project_id = ?`,
    [input.projectId],
  );
  if (rows.length !== 1 || rows[0] === undefined) {
    throw concurrencyError("The downloaded incremental checkpoint is unavailable.");
  }
  const row = rows[0];
  const signedRemoteCursor = parseCursor(row.signed_remote_cursor, "downloaded cursor");
  const downloadedCheckpointRevision = parsePositiveInteger(
    row.revision,
    "downloaded checkpoint revision",
  );
  const downloadedAt = parseTimestamp(row.updated_at, "downloadedAt");
  if (
    signedRemoteCursor !== input.signedRemoteCursor ||
    downloadedCheckpointRevision !== input.downloadedCheckpointRevision
  ) {
    throw concurrencyError("The downloaded incremental checkpoint changed before settlement.");
  }
  if (Date.parse(input.settledAt) < Date.parse(downloadedAt)) {
    throw validationError("The incremental settlement time predates its downloaded checkpoint.");
  }
  return {
    projectId: input.projectId,
    signedRemoteCursor,
    downloadedCheckpointRevision,
    downloadedAt,
    settledAt: input.settledAt,
  };
}

async function readMaterializedCheckpoint(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<SyncMaterializedCheckpoint | null> {
  const rows = await transaction.select<MaterializedCheckpointDbRow>(
    `SELECT project_id, signed_remote_cursor, downloaded_checkpoint_revision, revision, updated_at
     FROM sync_materialized_checkpoints
     WHERE project_id = ?`,
    [projectId],
  );
  if (rows.length > 1) {
    throw corruptionError("The plaintext-materialized checkpoint is duplicated.");
  }
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    projectId: parseUuid(row.project_id, "materialized projectId"),
    signedRemoteCursor: parseCursor(row.signed_remote_cursor, "materialized cursor"),
    downloadedCheckpointRevision: parsePositiveInteger(
      row.downloaded_checkpoint_revision,
      "materialized downloaded checkpoint revision",
    ),
    revision: parsePositiveInteger(row.revision, "materialized revision"),
    updatedAt: parseTimestamp(row.updated_at, "materialized updatedAt"),
  };
}

function requireExpectedMaterializedCheckpoint(
  existing: SyncMaterializedCheckpoint | null,
  input: SettleSyncIncrementalMaterializationInput,
): void {
  if (existing === null) {
    if (input.expectedMaterializedCheckpointRevision !== null) {
      throw concurrencyError("The plaintext-materialized checkpoint no longer exists.");
    }
    return;
  }
  if (existing.revision !== input.expectedMaterializedCheckpointRevision) {
    throw concurrencyError("The plaintext-materialized checkpoint revision changed.");
  }
  if (Date.parse(input.settledAt) < Date.parse(existing.updatedAt)) {
    throw validationError("The incremental settlement time predates plaintext state.");
  }
}

function requireNonRegressingTarget(
  existing: SyncMaterializedCheckpoint | null,
  target: SyncIncrementalSettlementTarget,
): void {
  if (
    existing !== null &&
    existing.downloadedCheckpointRevision > target.downloadedCheckpointRevision
  ) {
    throw concurrencyError("The plaintext-materialized checkpoint cannot move backwards.");
  }
  if (
    existing !== null &&
    existing.downloadedCheckpointRevision === target.downloadedCheckpointRevision &&
    existing.signedRemoteCursor !== target.signedRemoteCursor
  ) {
    throw corruptionError("One downloaded checkpoint revision is bound to multiple cursors.");
  }
}

async function readSettlementCounts(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<SyncIncrementalSettlementCounts> {
  const rows = await transaction.select<SettlementCountsDbRow>(
    `SELECT
       (
         SELECT count(*)
         FROM sync_snapshot_staging_sessions
         WHERE project_id = ?
       ) AS snapshot_pending_count,
       (
         SELECT count(*)
         FROM sync_inbox_operations
         WHERE project_id = ?
           AND (
             status IN ('received', 'applying')
             OR (
               status = 'failed'
               AND next_attempt_at IS NOT NULL
               AND attempt < 100
             )
           )
       ) AS incoming_pending_count,
       (
         SELECT count(*)
         FROM sync_inbox_operations
         WHERE project_id = ?
           AND status = 'failed'
           AND next_attempt_at IS NULL
           AND attempt < 100
       ) AS incoming_permanent_failure_count,
       (
         SELECT count(*)
         FROM sync_inbox_operations
         WHERE project_id = ?
           AND status = 'failed'
           AND attempt >= 100
       ) AS incoming_attempt_exhausted_count,
       (
         SELECT count(*)
         FROM sync_inbox_operations
         WHERE project_id = ? AND status = 'conflict'
       ) AS incoming_conflict_count,
       (
         SELECT count(*)
         FROM sync_content_conflicts
         WHERE project_id = ? AND status = 'unresolved'
       ) AS unresolved_content_conflict_count`,
    [projectId, projectId, projectId, projectId, projectId, projectId],
  );
  if (rows.length !== 1 || rows[0] === undefined) {
    throw corruptionError("The incremental settlement summary is unavailable.");
  }
  const row = rows[0];
  return {
    snapshotPendingCount: parseNonNegativeInteger(
      row.snapshot_pending_count,
      "snapshot pending count",
    ),
    incomingPendingCount: parseNonNegativeInteger(
      row.incoming_pending_count,
      "incoming pending count",
    ),
    incomingPermanentFailureCount: parseNonNegativeInteger(
      row.incoming_permanent_failure_count,
      "incoming permanent failure count",
    ),
    incomingAttemptExhaustedCount: parseNonNegativeInteger(
      row.incoming_attempt_exhausted_count,
      "incoming attempt exhausted count",
    ),
    incomingConflictCount: parseNonNegativeInteger(
      row.incoming_conflict_count,
      "incoming conflict count",
    ),
    unresolvedContentConflictCount: parseNonNegativeInteger(
      row.unresolved_content_conflict_count,
      "unresolved content conflict count",
    ),
  };
}

async function findBlockReason(
  transaction: TransactionExecutor,
  target: SyncIncrementalSettlementTarget,
  existing: SyncMaterializedCheckpoint | null,
  counts: SyncIncrementalSettlementCounts,
): Promise<SyncIncrementalSettlementBlockReason | null> {
  if (counts.snapshotPendingCount !== 0) {
    return "snapshot_pending";
  }
  if (counts.incomingConflictCount !== 0) {
    return "incoming_conflict";
  }
  if (counts.unresolvedContentConflictCount !== 0) {
    return "content_conflict";
  }
  if (counts.incomingAttemptExhaustedCount !== 0) {
    return "incoming_attempt_exhausted";
  }
  if (counts.incomingPermanentFailureCount !== 0) {
    return "incoming_permanent_failure";
  }
  if (counts.incomingPendingCount !== 0) {
    return "incoming_pending";
  }

  const alreadySettled =
    existing !== null &&
    existing.signedRemoteCursor === target.signedRemoteCursor &&
    existing.downloadedCheckpointRevision === target.downloadedCheckpointRevision;
  if (alreadySettled) {
    return null;
  }
  const batchRows = await transaction.select<TargetBatchDbRow>(
    `SELECT has_more
     FROM sync_incoming_batches
     WHERE project_id = ? AND next_signed_remote_cursor = ?`,
    [target.projectId, target.signedRemoteCursor],
  );
  const terminalBatchObserved = batchRows.length === 1 && batchRows[0]?.has_more === 0;
  if (terminalBatchObserved) {
    return null;
  }
  const terminalRows = await transaction.select<TerminalObservationDbRow>(
    `SELECT count(*) AS observation_count
     FROM sync_incremental_terminal_observations
     WHERE project_id = ?
       AND signed_remote_cursor = ?
       AND downloaded_checkpoint_revision = ?`,
    [target.projectId, target.signedRemoteCursor, target.downloadedCheckpointRevision],
  );
  if (terminalRows[0]?.observation_count !== 1) {
    return "pull_incomplete";
  }
  return null;
}

async function requireSettlementStillExact(
  transaction: TransactionExecutor,
  target: SyncIncrementalSettlementTarget,
  checkpoint: SyncMaterializedCheckpoint,
): Promise<void> {
  const remote = await requireExactRemoteCheckpoint(transaction, {
    projectId: target.projectId,
    signedRemoteCursor: target.signedRemoteCursor,
    downloadedCheckpointRevision: target.downloadedCheckpointRevision,
    expectedMaterializedCheckpointRevision: checkpoint.revision,
    settledAt: target.settledAt,
  });
  const current = await readMaterializedCheckpoint(transaction, target.projectId);
  if (
    remote.signedRemoteCursor !== target.signedRemoteCursor ||
    current?.revision !== checkpoint.revision ||
    current.signedRemoteCursor !== target.signedRemoteCursor ||
    current.downloadedCheckpointRevision !== target.downloadedCheckpointRevision
  ) {
    throw concurrencyError("The incremental settlement boundary changed before commit.");
  }
}

function normalizeInput(
  input: SettleSyncIncrementalMaterializationInput,
): SettleSyncIncrementalMaterializationInput {
  return {
    projectId: parseUuid(input.projectId, "projectId"),
    signedRemoteCursor: parseCursor(input.signedRemoteCursor, "signedRemoteCursor"),
    downloadedCheckpointRevision: parsePositiveInteger(
      input.downloadedCheckpointRevision,
      "downloadedCheckpointRevision",
    ),
    expectedMaterializedCheckpointRevision:
      input.expectedMaterializedCheckpointRevision === null
        ? null
        : parsePositiveInteger(
            input.expectedMaterializedCheckpointRevision,
            "expectedMaterializedCheckpointRevision",
          ),
    settledAt: parseTimestamp(input.settledAt, "settledAt"),
  };
}

function parseUuid(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw validationError(`${field} must be a lowercase UUIDv7.`);
  }
  return value;
}

function parseCursor(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw validationError(`${field} is invalid.`);
  }
  return value;
}

function parseTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw validationError(`${field} must be a canonical UTC timestamp.`);
  }
  return value;
}

function parsePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function parseNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw corruptionError(`${field} is invalid.`);
  }
  return value;
}

function requireResult<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function attempt<Value>(
  operation: string,
  run: () => Promise<Value>,
): Promise<Result<Value, AppError>> {
  try {
    return ok(await run());
  } catch (cause: unknown) {
    if (cause instanceof AppError) {
      return err(cause);
    }
    return err(
      new AppError({
        code: "REPOSITORY_ERROR",
        message: "The local incremental settlement store could not complete the operation.",
        retryable: true,
        actions: ["RETRY", "OPEN_SETTINGS", "CONTACT_SUPPORT"],
        details: {
          operation,
          causeType: cause instanceof Error ? cause.name : "UnknownError",
        },
      }),
    );
  }
}

function validationError(message: string): AppError {
  return new AppError({ code: "VALIDATION_FAILED", message });
}

function concurrencyError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY", "OPEN_SETTINGS"],
  });
}

function corruptionError(message: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message,
    actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
    details: { operation: "SYNC_INCREMENTAL_SETTLEMENT_LOCAL_RECORD_INVALID" },
  });
}
