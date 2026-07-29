import {
  EncryptedSyncChunkContractSchema,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  SyncOperationContractSchema,
  SyncTombstoneContractSchema,
  UuidV7Schema,
  type EncryptedSyncChunkContract,
} from "@inkshadow/contracts";
import { AppError, err, ok, type Result } from "@inkshadow/domain";
import {
  SyncOperation,
  SyncTombstone,
  type SyncOperationSnapshot,
  type SyncTombstoneSnapshot,
} from "@inkshadow/sync-core";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export const SNAPSHOT_MATERIALIZATION_OUTCOMES = ["applied", "skipped", "conflict"] as const;

export type SnapshotMaterializationOutcome = (typeof SNAPSHOT_MATERIALIZATION_OUTCOMES)[number];

export interface SnapshotMaterializationCiphertextChunk {
  readonly chunkId: string;
  readonly encrypted: EncryptedSyncChunkContract;
}

/**
 * This is intentionally structurally compatible with
 * IncomingContentCiphertextWork. Snapshot identity and the deterministic
 * operation fingerprint are additional coordination metadata only.
 */
export interface SnapshotMaterializationWork {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly operationFingerprint: string;
  readonly operation: SyncOperationSnapshot;
  readonly chunks: readonly SnapshotMaterializationCiphertextChunk[];
  readonly tombstone: SyncTombstoneSnapshot | null;
}

export interface SnapshotMaterializationReceipt {
  readonly snapshotId: string;
  readonly operationId: string;
  readonly operationFingerprint: string;
  readonly outcome: SnapshotMaterializationOutcome;
  readonly conflictCode: string | null;
  readonly resolvedAt: string;
}

export interface SnapshotMaterializationState {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly total: number;
  readonly resolved: number;
  readonly conflict: number;
  readonly remaining: number;
}

export interface SnapshotMaterializationTarget extends SnapshotMaterializationIdentity {
  readonly signedRemoteCursor: string;
  readonly downloadedCheckpointRevision: number;
  readonly committedAt: string;
}

export interface SnapshotMaterializationIdentity {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
}

export interface ListSnapshotMaterializationWorkInput extends SnapshotMaterializationIdentity {
  readonly limit?: number;
}

export interface ResolveSnapshotMaterializationWorkInput extends SnapshotMaterializationIdentity {
  readonly operationId: string;
  readonly operationFingerprint: string;
  readonly resolvedAt: string;
}

export type SnapshotMaterializationDecision =
  | Readonly<{ outcome: "applied" | "skipped"; conflictCode?: never }>
  | Readonly<{ outcome: "conflict"; conflictCode: string }>;

export type SnapshotMaterializationResolver = (
  transaction: TransactionExecutor,
  work: SnapshotMaterializationWork,
) => Promise<SnapshotMaterializationDecision> | SnapshotMaterializationDecision;

export interface ResolveSnapshotMaterializationWorkResult {
  readonly replayed: boolean;
  readonly receipt: SnapshotMaterializationReceipt;
}

export interface SettleSnapshotMaterializationConflictInput extends ResolveSnapshotMaterializationWorkInput {
  readonly expectedConflictCode: string;
}

export type SnapshotMaterializationConflictSettlement = Readonly<{
  outcome: "applied" | "skipped";
}>;

export type SnapshotMaterializationConflictSettler = (
  transaction: TransactionExecutor,
  work: SnapshotMaterializationWork,
) => Promise<SnapshotMaterializationConflictSettlement> | SnapshotMaterializationConflictSettlement;

export interface FinalizeSnapshotMaterializationResult {
  readonly finalized: boolean;
  readonly reason: "finalized" | "snapshot_absent";
}

export type SnapshotMaterializationFinalizer = (
  transaction: TransactionExecutor,
  target: SnapshotMaterializationTarget,
) => Promise<void> | void;

interface SnapshotSessionDbRow {
  readonly snapshot_id: string;
  readonly project_id: string;
  readonly epoch: number;
  readonly state: string;
  readonly final_signed_remote_cursor: string | null;
  readonly total_operation_count: number;
  readonly committed_checkpoint_revision: number | null;
  readonly committed_at: string | null;
}

interface SnapshotOperationDbRow {
  readonly snapshot_id: string;
  readonly page_index: number;
  readonly operation_position: number;
  readonly operation_id: string;
  readonly project_id: string;
  readonly device_id: string;
  readonly device_sequence: number;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly kind: string;
  readonly vector_json: string;
  readonly operation_created_at: string;
}

interface SnapshotChunkDbRow {
  readonly position: number;
  readonly chunk_id: string;
  readonly project_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly version_id: string;
  readonly chunk_index: number;
  readonly key_version: number;
  readonly algorithm: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly ciphertext_sha256: string;
  readonly plaintext_bytes: number;
}

interface SnapshotTombstoneDbRow {
  readonly project_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly deleted_by_device_id: string;
  readonly vector_json: string;
  readonly deleted_at: string;
  readonly retain_until: string;
  readonly acknowledged_device_ids_json: string;
}

interface SnapshotReceiptDbRow {
  readonly snapshot_id: string;
  readonly operation_id: string;
  readonly operation_fingerprint: string;
  readonly outcome: string;
  readonly conflict_code: string | null;
  readonly resolved_at: string;
}

interface CountDbRow {
  readonly count: number;
}

interface CheckpointDbRow {
  readonly signed_remote_cursor: string;
  readonly revision: number;
}

interface MaterializedCheckpointDbRow {
  readonly signed_remote_cursor: string;
  readonly downloaded_checkpoint_revision: number;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAXIMUM_PAGE_LIMIT = 256;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const CONFLICT_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/u;

export class SyncSnapshotMaterializationSqliteStore {
  private readonly cryptoProvider: Crypto;

  public constructor(
    private readonly executor: SqlExecutor,
    options: Readonly<{ cryptoProvider?: Crypto }> = {},
  ) {
    this.cryptoProvider = options.cryptoProvider ?? globalThis.crypto;
  }

  public async loadNextPendingWork(
    inputValue: SnapshotMaterializationIdentity,
  ): Promise<Result<SnapshotMaterializationWork | null, AppError>> {
    const result = await this.listPendingWork({ ...inputValue, limit: 1 });
    return result.ok ? ok(result.value[0] ?? null) : result;
  }

  public async listPendingWork(
    inputValue: ListSnapshotMaterializationWorkInput,
  ): Promise<Result<readonly SnapshotMaterializationWork[], AppError>> {
    return attempt("SYNC_SNAPSHOT_MATERIALIZATION_LIST_FAILED", async () => {
      const input = normalizeListInput(inputValue);
      return this.executor.transaction(async (transaction) => {
        const session = await requireCommittedSession(transaction, input);
        const rows = await transaction.select<{ operation_id: string }>(
          `SELECT operation.operation_id
           FROM sync_snapshot_staging_operations AS operation
           LEFT JOIN sync_snapshot_materialization_receipts AS receipt
             ON receipt.snapshot_id = operation.snapshot_id
            AND receipt.operation_id = operation.operation_id
           WHERE operation.snapshot_id = ?
             AND receipt.operation_id IS NULL
           ORDER BY operation.page_index, operation.operation_position
           LIMIT ?`,
          [session.snapshotId, input.limit],
        );
        const work: SnapshotMaterializationWork[] = [];
        for (const row of rows) {
          work.push(
            await loadAndValidateWork(
              transaction,
              session,
              parseStoredUuid(row.operation_id, "operation.operationId"),
              this.cryptoProvider,
            ),
          );
        }
        return Object.freeze(work);
      });
    });
  }

  public async readState(
    inputValue: SnapshotMaterializationIdentity,
  ): Promise<Result<SnapshotMaterializationState | null, AppError>> {
    return attempt("SYNC_SNAPSHOT_MATERIALIZATION_STATE_FAILED", async () => {
      const input = normalizeIdentity(inputValue);
      return this.executor.transaction(async (transaction) => {
        const row = await findSession(transaction, input.snapshotId);
        if (row === null) {
          return null;
        }
        const session = rehydrateCommittedSession(row, input);
        return readState(transaction, session);
      });
    });
  }

  public async readCommittedTarget(
    inputValue: SnapshotMaterializationIdentity,
  ): Promise<Result<SnapshotMaterializationTarget | null, AppError>> {
    return attempt("SYNC_SNAPSHOT_MATERIALIZATION_TARGET_READ_FAILED", async () => {
      const input = normalizeIdentity(inputValue);
      return this.executor.transaction(async (transaction) => {
        const row = await findSession(transaction, input.snapshotId);
        if (row === null) {
          return null;
        }
        const session = rehydrateCommittedSession(row, input);
        return {
          snapshotId: session.snapshotId,
          projectId: session.projectId,
          epoch: session.epoch,
          signedRemoteCursor: session.finalSignedRemoteCursor,
          downloadedCheckpointRevision: session.committedCheckpointRevision,
          committedAt: session.committedAt,
        };
      });
    });
  }

  public async resolveWorkAtomically(
    inputValue: ResolveSnapshotMaterializationWorkInput,
    resolver: SnapshotMaterializationResolver,
  ): Promise<Result<ResolveSnapshotMaterializationWorkResult, AppError>> {
    return attempt("SYNC_SNAPSHOT_MATERIALIZATION_RESOLVE_FAILED", async () => {
      const input = normalizeResolveInput(inputValue);
      if (typeof resolver !== "function") {
        throw validationError("A snapshot materialization resolver is required.");
      }
      return this.executor.transaction(async (transaction) => {
        const session = await requireCommittedSession(transaction, input);
        const work = await loadAndValidateWork(
          transaction,
          session,
          input.operationId,
          this.cryptoProvider,
        );
        if (work.operationFingerprint !== input.operationFingerprint) {
          throw concurrencyError(
            "The prepared operation fingerprint no longer matches the committed snapshot.",
          );
        }
        const existingRow = await findReceipt(transaction, input.snapshotId, input.operationId);
        if (existingRow !== null) {
          const receipt = rehydrateReceipt(existingRow, session);
          if (receipt.operationFingerprint !== work.operationFingerprint) {
            throw corruptionError(
              "The stored materialization receipt does not match its committed operation.",
            );
          }
          return { replayed: true, receipt };
        }

        if (Date.parse(input.resolvedAt) < Date.parse(session.committedAt)) {
          throw validationError(
            "A snapshot operation cannot be resolved before the snapshot was committed.",
          );
        }
        const decision = normalizeDecision(await resolver(transaction, work));
        const receipt: SnapshotMaterializationReceipt = {
          snapshotId: session.snapshotId,
          operationId: work.operation.operationId,
          operationFingerprint: work.operationFingerprint,
          outcome: decision.outcome,
          conflictCode: decision.outcome === "conflict" ? decision.conflictCode : null,
          resolvedAt: input.resolvedAt,
        };
        const inserted = await transaction.execute(
          `INSERT INTO sync_snapshot_materialization_receipts (
             snapshot_id,
             operation_id,
             operation_fingerprint,
             outcome,
             conflict_code,
             resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            receipt.snapshotId,
            receipt.operationId,
            receipt.operationFingerprint,
            receipt.outcome,
            receipt.conflictCode,
            receipt.resolvedAt,
          ],
        );
        requireSingleMutation(inserted.rowsAffected, "The materialization receipt was not saved.");
        return { replayed: false, receipt };
      });
    });
  }

  /**
   * A conflict receipt is durable evidence that the first materialization
   * callback completed by creating conflict metadata. Once the user resolves
   * that conflict, this separate command lets the caller commit the chosen
   * business mutation and replace the blocking receipt outcome in one
   * transaction. Ordinary receipt replay remains callback-free.
   */
  public async settleConflictAtomically(
    inputValue: SettleSnapshotMaterializationConflictInput,
    settler: SnapshotMaterializationConflictSettler,
  ): Promise<Result<ResolveSnapshotMaterializationWorkResult, AppError>> {
    return attempt("SYNC_SNAPSHOT_MATERIALIZATION_CONFLICT_SETTLE_FAILED", async () => {
      const input = normalizeConflictSettlementInput(inputValue);
      if (typeof settler !== "function") {
        throw validationError("A snapshot conflict settlement callback is required.");
      }
      return this.executor.transaction(async (transaction) => {
        const session = await requireCommittedSession(transaction, input);
        const work = await loadAndValidateWork(
          transaction,
          session,
          input.operationId,
          this.cryptoProvider,
        );
        if (work.operationFingerprint !== input.operationFingerprint) {
          throw concurrencyError(
            "The prepared operation fingerprint no longer matches the committed snapshot.",
          );
        }
        const existingRow = await findReceipt(transaction, input.snapshotId, input.operationId);
        if (existingRow === null) {
          throw concurrencyError(
            "A snapshot operation must first have a conflict receipt before it can be settled.",
          );
        }
        const existing = rehydrateReceipt(existingRow, session);
        if (existing.operationFingerprint !== work.operationFingerprint) {
          throw corruptionError(
            "The stored conflict receipt does not match its committed operation.",
          );
        }
        if (existing.outcome !== "conflict") {
          return { replayed: true, receipt: existing };
        }
        if (existing.conflictCode !== input.expectedConflictCode) {
          throw concurrencyError("The snapshot conflict evidence no longer matches.");
        }
        if (Date.parse(input.resolvedAt) < Date.parse(existing.resolvedAt)) {
          throw validationError(
            "A snapshot conflict cannot be settled before it was first recorded.",
          );
        }
        const settlement = normalizeConflictSettlement(await settler(transaction, work));
        const updated = await transaction.execute(
          `UPDATE sync_snapshot_materialization_receipts
           SET outcome = ?,
               conflict_code = NULL,
               resolved_at = ?
           WHERE snapshot_id = ?
             AND operation_id = ?
             AND operation_fingerprint = ?
             AND outcome = 'conflict'
             AND conflict_code = ?`,
          [
            settlement.outcome,
            input.resolvedAt,
            input.snapshotId,
            input.operationId,
            input.operationFingerprint,
            input.expectedConflictCode,
          ],
        );
        requireSingleMutation(
          updated.rowsAffected,
          "The snapshot materialization conflict receipt changed.",
        );
        return {
          replayed: false,
          receipt: {
            ...existing,
            outcome: settlement.outcome,
            conflictCode: null,
            resolvedAt: input.resolvedAt,
          },
        };
      });
    });
  }

  public async finalize(
    inputValue: SnapshotMaterializationIdentity,
  ): Promise<Result<FinalizeSnapshotMaterializationResult, AppError>> {
    return this.finalizeAtomically(inputValue, () => undefined);
  }

  /**
   * Runs the final plaintext checkpoint/registration boundary and removes the
   * committed ciphertext staging session in one SQLite commit. The callback
   * executes before the exact checkpoint assertion so it may advance the
   * materialized checkpoint; any callback or assertion failure rolls every
   * mutation back and leaves the snapshot resumable.
   */
  public async finalizeAtomically(
    inputValue: SnapshotMaterializationIdentity,
    finalizer: SnapshotMaterializationFinalizer,
  ): Promise<Result<FinalizeSnapshotMaterializationResult, AppError>> {
    return attempt("SYNC_SNAPSHOT_MATERIALIZATION_FINALIZE_FAILED", async () => {
      const input = normalizeIdentity(inputValue);
      if (typeof finalizer !== "function") {
        throw validationError("A snapshot materialization finalizer is required.");
      }
      return this.executor.transaction(async (transaction) => {
        const row = await findSession(transaction, input.snapshotId);
        if (row === null) {
          return { finalized: false, reason: "snapshot_absent" };
        }
        const session = rehydrateCommittedSession(row, input);
        const state = await readState(transaction, session);
        if (state.remaining !== 0) {
          throw concurrencyError(
            "The committed snapshot still has operations awaiting plaintext materialization.",
          );
        }
        if (state.conflict !== 0) {
          throw concurrencyError(
            "The committed snapshot still has unresolved plaintext materialization conflicts.",
          );
        }
        await finalizer(transaction, {
          snapshotId: session.snapshotId,
          projectId: session.projectId,
          epoch: session.epoch,
          signedRemoteCursor: session.finalSignedRemoteCursor,
          downloadedCheckpointRevision: session.committedCheckpointRevision,
          committedAt: session.committedAt,
        });
        await requireExactFinalCheckpoints(transaction, session);
        const deleted = await transaction.execute(
          `DELETE FROM sync_snapshot_staging_sessions
           WHERE snapshot_id = ?
             AND project_id = ?
             AND epoch = ?
             AND state = 'committed'`,
          [session.snapshotId, session.projectId, session.epoch],
        );
        requireSingleMutation(deleted.rowsAffected, "The committed snapshot changed.");
        return { finalized: true, reason: "finalized" };
      });
    });
  }
}

interface CommittedSession {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly finalSignedRemoteCursor: string;
  readonly totalOperationCount: number;
  readonly committedCheckpointRevision: number;
  readonly committedAt: string;
}

async function requireCommittedSession(
  transaction: TransactionExecutor,
  identity: SnapshotMaterializationIdentity,
): Promise<CommittedSession> {
  const row = await findSession(transaction, identity.snapshotId);
  if (row === null) {
    throw notFoundError("The committed snapshot materialization session does not exist.");
  }
  return rehydrateCommittedSession(row, identity);
}

async function findSession(
  transaction: TransactionExecutor,
  snapshotId: string,
): Promise<SnapshotSessionDbRow | null> {
  const rows = await transaction.select<SnapshotSessionDbRow>(
    `SELECT
       snapshot_id,
       project_id,
       epoch,
       state,
       final_signed_remote_cursor,
       total_operation_count,
       committed_checkpoint_revision,
       committed_at
     FROM sync_snapshot_staging_sessions
     WHERE snapshot_id = ?`,
    [snapshotId],
  );
  return requireAtMostOne(rows, "A snapshot materialization session is duplicated.");
}

function rehydrateCommittedSession(
  row: SnapshotSessionDbRow,
  expected: SnapshotMaterializationIdentity,
): CommittedSession {
  const snapshotId = parseStoredUuid(row.snapshot_id, "snapshot.snapshotId");
  const projectId = parseStoredUuid(row.project_id, "snapshot.projectId");
  const epoch = parseStoredPositiveInteger(row.epoch, "snapshot.epoch");
  if (
    snapshotId !== expected.snapshotId ||
    projectId !== expected.projectId ||
    epoch !== expected.epoch
  ) {
    throw concurrencyError(
      "The snapshot materialization identity no longer matches the committed session.",
    );
  }
  if (row.state !== "committed") {
    throw concurrencyError("Only a committed snapshot can be materialized.");
  }
  if (
    row.final_signed_remote_cursor === null ||
    row.committed_checkpoint_revision === null ||
    row.committed_at === null
  ) {
    throw corruptionError("The committed snapshot is missing its final checkpoint evidence.");
  }
  return {
    snapshotId,
    projectId,
    epoch,
    finalSignedRemoteCursor: parseStoredCursor(
      row.final_signed_remote_cursor,
      "snapshot.finalSignedRemoteCursor",
    ),
    totalOperationCount: parseStoredNonNegativeInteger(
      row.total_operation_count,
      "snapshot.totalOperationCount",
    ),
    committedCheckpointRevision: parseStoredPositiveInteger(
      row.committed_checkpoint_revision,
      "snapshot.committedCheckpointRevision",
    ),
    committedAt: parseStoredTimestamp(row.committed_at, "snapshot.committedAt"),
  };
}

async function readState(
  transaction: TransactionExecutor,
  session: CommittedSession,
): Promise<SnapshotMaterializationState> {
  const [operationRows, resolvedRows, conflictRows] = await Promise.all([
    transaction.select<CountDbRow>(
      "SELECT count(*) AS count FROM sync_snapshot_staging_operations WHERE snapshot_id = ?",
      [session.snapshotId],
    ),
    transaction.select<CountDbRow>(
      "SELECT count(*) AS count FROM sync_snapshot_materialization_receipts WHERE snapshot_id = ?",
      [session.snapshotId],
    ),
    transaction.select<CountDbRow>(
      `SELECT count(*) AS count
       FROM sync_snapshot_materialization_receipts
       WHERE snapshot_id = ? AND outcome = 'conflict'`,
      [session.snapshotId],
    ),
  ]);
  const operationCount = parseCount(operationRows, "snapshot operation count");
  const resolved = parseCount(resolvedRows, "snapshot receipt count");
  const conflict = parseCount(conflictRows, "snapshot conflict receipt count");
  if (operationCount !== session.totalOperationCount) {
    throw corruptionError("The committed snapshot operation count is inconsistent.");
  }
  if (resolved > operationCount || conflict > resolved) {
    throw corruptionError("The snapshot materialization receipt counts are inconsistent.");
  }
  return {
    snapshotId: session.snapshotId,
    projectId: session.projectId,
    epoch: session.epoch,
    total: operationCount,
    resolved,
    conflict,
    remaining: operationCount - resolved,
  };
}

async function loadAndValidateWork(
  transaction: TransactionExecutor,
  session: CommittedSession,
  operationId: string,
  cryptoProvider: Crypto,
): Promise<SnapshotMaterializationWork> {
  const operationRows = await transaction.select<SnapshotOperationDbRow>(
    `SELECT
       snapshot_id,
       page_index,
       operation_position,
       operation_id,
       project_id,
       device_id,
       device_sequence,
       object_type,
       object_id,
       object_generation,
       kind,
       vector_json,
       operation_created_at
     FROM sync_snapshot_staging_operations
     WHERE snapshot_id = ? AND operation_id = ?`,
    [session.snapshotId, operationId],
  );
  const row = requireAtMostOne(operationRows, "A committed snapshot operation is duplicated.");
  if (row === null) {
    throw notFoundError("The committed snapshot operation does not exist.");
  }
  if (
    row.snapshot_id !== session.snapshotId ||
    row.project_id !== session.projectId ||
    !Number.isSafeInteger(row.page_index) ||
    row.page_index < 0 ||
    !Number.isSafeInteger(row.operation_position) ||
    row.operation_position < 0
  ) {
    throw corruptionError("The committed snapshot operation identity is inconsistent.");
  }

  const chunkRows = await transaction.select<SnapshotChunkDbRow>(
    `SELECT
       link.position,
       chunk.chunk_id,
       chunk.project_id,
       chunk.object_type,
       chunk.object_id,
       chunk.version_id,
       chunk.chunk_index,
       chunk.key_version,
       chunk.algorithm,
       chunk.nonce,
       chunk.ciphertext,
       chunk.ciphertext_sha256,
       chunk.plaintext_bytes
     FROM sync_snapshot_staging_operation_chunks AS link
     JOIN sync_snapshot_staging_chunks AS chunk
       ON chunk.snapshot_id = link.snapshot_id
      AND chunk.chunk_id = link.chunk_id
     WHERE link.snapshot_id = ? AND link.operation_id = ?
     ORDER BY link.position`,
    [session.snapshotId, operationId],
  );
  const chunks: SnapshotMaterializationCiphertextChunk[] = [];
  let sharedVersionId: string | null = null;
  let sharedKeyVersion: number | null = null;
  for (const [index, chunkRow] of chunkRows.entries()) {
    if (chunkRow.position !== index || chunkRow.chunk_index !== index) {
      throw corruptionError(
        "The committed snapshot ciphertext chunks are not in contiguous authenticated order.",
      );
    }
    const encryptedCandidate = {
      schemaVersion: 1,
      algorithm: chunkRow.algorithm,
      nonce: chunkRow.nonce,
      ciphertext: chunkRow.ciphertext,
      ciphertextSha256: chunkRow.ciphertext_sha256,
      plaintextBytes: chunkRow.plaintext_bytes,
      aad: {
        projectId: chunkRow.project_id,
        objectType: chunkRow.object_type,
        objectId: chunkRow.object_id,
        versionId: chunkRow.version_id,
        chunkIndex: chunkRow.chunk_index,
        keyVersion: chunkRow.key_version,
      },
    };
    const parsed = EncryptedSyncChunkContractSchema.safeParse(encryptedCandidate);
    if (!parsed.success) {
      throw corruptionError("A committed snapshot ciphertext chunk is malformed.");
    }
    const encrypted = parsed.data;
    if (
      encrypted.aad.projectId !== session.projectId ||
      encrypted.aad.objectType !== row.object_type ||
      encrypted.aad.objectId !== row.object_id ||
      encrypted.aad.chunkIndex !== index
    ) {
      throw corruptionError(
        "A committed snapshot ciphertext chunk AAD does not match its typed operation.",
      );
    }
    if (
      (sharedVersionId !== null && encrypted.aad.versionId !== sharedVersionId) ||
      (sharedKeyVersion !== null && encrypted.aad.keyVersion !== sharedKeyVersion)
    ) {
      throw corruptionError(
        "A committed snapshot operation mixes ciphertext key or version identifiers.",
      );
    }
    sharedVersionId = encrypted.aad.versionId;
    sharedKeyVersion = encrypted.aad.keyVersion;
    await verifyCiphertextHash(encrypted, cryptoProvider);
    chunks.push({
      chunkId: parseStoredUuid(chunkRow.chunk_id, "chunk.chunkId"),
      encrypted,
    });
  }

  const operationCandidate = {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId: row.operation_id,
    projectId: row.project_id,
    deviceId: row.device_id,
    deviceSequence: row.device_sequence,
    objectType: row.object_type,
    objectId: row.object_id,
    objectGeneration: row.object_generation,
    kind: row.kind,
    vector: parseStoredJson(row.vector_json, "operation.vector"),
    encryptedChunkIds: chunks.map((chunk) => chunk.chunkId),
    createdAt: row.operation_created_at,
  };
  const parsedOperation = SyncOperationContractSchema.safeParse(operationCandidate);
  if (!parsedOperation.success) {
    throw corruptionError("A committed snapshot operation is not valid protocol v2 data.");
  }
  const operation = SyncOperation.create(parsedOperation.data).toSnapshot();
  const tombstone = await loadExactTombstone(transaction, session.snapshotId, operation);
  const operationFingerprint = await fingerprintOperation(operation, cryptoProvider);
  return Object.freeze({
    snapshotId: session.snapshotId,
    projectId: session.projectId,
    epoch: session.epoch,
    operationFingerprint,
    operation,
    chunks: Object.freeze(chunks),
    tombstone,
  });
}

async function loadExactTombstone(
  transaction: TransactionExecutor,
  snapshotId: string,
  operation: SyncOperationSnapshot,
): Promise<SyncTombstoneSnapshot | null> {
  const rows = await transaction.select<SnapshotTombstoneDbRow>(
    `SELECT
       project_id,
       object_type,
       object_id,
       object_generation,
       deleted_by_device_id,
       vector_json,
       deleted_at,
       retain_until,
       acknowledged_device_ids_json
     FROM sync_snapshot_staging_tombstones
     WHERE snapshot_id = ?
       AND project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?`,
    [
      snapshotId,
      operation.projectId,
      operation.objectType,
      operation.objectId,
      operation.objectGeneration,
    ],
  );
  const row = requireAtMostOne(rows, "A committed snapshot tombstone is duplicated.");
  if (operation.kind === "upsert") {
    if (row !== null) {
      throw corruptionError("A committed snapshot upsert unexpectedly carries a tombstone.");
    }
    return null;
  }
  if (row === null) {
    throw corruptionError("A committed snapshot delete is missing its exact typed tombstone.");
  }
  const candidate = {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    projectId: row.project_id,
    objectType: row.object_type,
    objectId: row.object_id,
    objectGeneration: row.object_generation,
    deletedByDeviceId: row.deleted_by_device_id,
    vector: parseStoredJson(row.vector_json, "tombstone.vector"),
    deletedAt: row.deleted_at,
    retainUntil: row.retain_until,
    acknowledgedDeviceIds: parseStoredJson(
      row.acknowledged_device_ids_json,
      "tombstone.acknowledgedDeviceIds",
    ),
  };
  const parsed = SyncTombstoneContractSchema.safeParse(candidate);
  if (!parsed.success) {
    throw corruptionError("A committed snapshot tombstone is not valid protocol v2 data.");
  }
  const tombstone = SyncTombstone.create(parsed.data).toSnapshot();
  if (
    tombstone.deletedByDeviceId !== operation.deviceId ||
    canonicalVector(tombstone.vector) !== canonicalVector(operation.vector)
  ) {
    throw corruptionError(
      "A committed snapshot tombstone does not match its typed delete operation.",
    );
  }
  return tombstone;
}

async function verifyCiphertextHash(
  encrypted: EncryptedSyncChunkContract,
  cryptoProvider: Crypto,
): Promise<void> {
  let ciphertext: Uint8Array;
  try {
    ciphertext = decodeBase64Url(encrypted.ciphertext);
  } catch {
    throw corruptionError("A committed snapshot ciphertext value is not canonical base64url.");
  }
  const digest = new Uint8Array(
    await cryptoProvider.subtle.digest("SHA-256", ownedBytes(ciphertext)),
  );
  if (toHex(digest) !== encrypted.ciphertextSha256) {
    throw corruptionError("A committed snapshot ciphertext checksum does not match.");
  }
}

async function fingerprintOperation(
  operation: SyncOperationSnapshot,
  cryptoProvider: Crypto,
): Promise<string> {
  const canonicalOperation = JSON.stringify({
    domain: "inkshadow/incoming-operation-fingerprint/v1",
    operationId: operation.operationId,
    projectId: operation.projectId,
    deviceId: operation.deviceId,
    deviceSequence: operation.deviceSequence,
    objectType: operation.objectType,
    objectId: operation.objectId,
    objectGeneration: operation.objectGeneration,
    kind: operation.kind,
    vector: Object.fromEntries(
      Object.entries(operation.vector).sort(([left], [right]) => left.localeCompare(right)),
    ),
    encryptedChunkIds: [...operation.encryptedChunkIds],
    createdAt: operation.createdAt,
  });
  const digest = new Uint8Array(
    await cryptoProvider.subtle.digest("SHA-256", new TextEncoder().encode(canonicalOperation)),
  );
  return toHex(digest);
}

async function findReceipt(
  transaction: TransactionExecutor,
  snapshotId: string,
  operationId: string,
): Promise<SnapshotReceiptDbRow | null> {
  const rows = await transaction.select<SnapshotReceiptDbRow>(
    `SELECT
       snapshot_id,
       operation_id,
       operation_fingerprint,
       outcome,
       conflict_code,
       resolved_at
     FROM sync_snapshot_materialization_receipts
     WHERE snapshot_id = ? AND operation_id = ?`,
    [snapshotId, operationId],
  );
  return requireAtMostOne(rows, "A snapshot materialization receipt is duplicated.");
}

function rehydrateReceipt(
  row: SnapshotReceiptDbRow,
  session: CommittedSession,
): SnapshotMaterializationReceipt {
  const outcome = parseStoredOutcome(row.outcome);
  const conflictCode =
    row.conflict_code === null
      ? null
      : parseStoredConflictCode(row.conflict_code, "receipt.conflictCode");
  if (
    (outcome === "conflict" && conflictCode === null) ||
    (outcome !== "conflict" && conflictCode !== null)
  ) {
    throw corruptionError("The stored materialization receipt outcome is inconsistent.");
  }
  const receipt: SnapshotMaterializationReceipt = {
    snapshotId: parseStoredUuid(row.snapshot_id, "receipt.snapshotId"),
    operationId: parseStoredUuid(row.operation_id, "receipt.operationId"),
    operationFingerprint: parseStoredFingerprint(
      row.operation_fingerprint,
      "receipt.operationFingerprint",
    ),
    outcome,
    conflictCode,
    resolvedAt: parseStoredTimestamp(row.resolved_at, "receipt.resolvedAt"),
  };
  if (
    receipt.snapshotId !== session.snapshotId ||
    Date.parse(receipt.resolvedAt) < Date.parse(session.committedAt)
  ) {
    throw corruptionError("The stored materialization receipt session evidence is inconsistent.");
  }
  return receipt;
}

async function requireExactFinalCheckpoints(
  transaction: TransactionExecutor,
  session: CommittedSession,
): Promise<void> {
  const [materializedRows, remoteRows] = await Promise.all([
    transaction.select<MaterializedCheckpointDbRow>(
      `SELECT signed_remote_cursor, downloaded_checkpoint_revision
       FROM sync_materialized_checkpoints
       WHERE project_id = ?`,
      [session.projectId],
    ),
    transaction.select<CheckpointDbRow>(
      `SELECT signed_remote_cursor, revision
       FROM sync_remote_checkpoints
       WHERE project_id = ?`,
      [session.projectId],
    ),
  ]);
  const materialized = requireAtMostOne(
    materializedRows,
    "The materialized snapshot checkpoint is duplicated.",
  );
  if (
    materialized === null ||
    parseStoredCursor(
      materialized.signed_remote_cursor,
      "materializedCheckpoint.signedRemoteCursor",
    ) !== session.finalSignedRemoteCursor ||
    parseStoredPositiveInteger(
      materialized.downloaded_checkpoint_revision,
      "materializedCheckpoint.downloadedCheckpointRevision",
    ) !== session.committedCheckpointRevision
  ) {
    throw concurrencyError(
      "The plaintext-materialized checkpoint does not match the committed snapshot.",
    );
  }
  const remote = requireAtMostOne(remoteRows, "The downloaded snapshot checkpoint is duplicated.");
  if (
    remote === null ||
    parseStoredCursor(remote.signed_remote_cursor, "remoteCheckpoint.signedRemoteCursor") !==
      session.finalSignedRemoteCursor ||
    parseStoredPositiveInteger(remote.revision, "remoteCheckpoint.revision") !==
      session.committedCheckpointRevision
  ) {
    throw concurrencyError(
      "The downloaded checkpoint changed before snapshot materialization finalized.",
    );
  }
}

function normalizeIdentity(
  input: SnapshotMaterializationIdentity,
): SnapshotMaterializationIdentity {
  return {
    snapshotId: parseUuid(input.snapshotId, "snapshotId"),
    projectId: parseUuid(input.projectId, "projectId"),
    epoch: parsePositiveInteger(input.epoch, "epoch"),
  };
}

function normalizeListInput(
  input: ListSnapshotMaterializationWorkInput,
): Required<ListSnapshotMaterializationWorkInput> {
  const identity = normalizeIdentity(input);
  const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_PAGE_LIMIT) {
    throw validationError(`limit must be an integer between 1 and ${String(MAXIMUM_PAGE_LIMIT)}.`);
  }
  return { ...identity, limit };
}

function normalizeResolveInput(
  input: ResolveSnapshotMaterializationWorkInput,
): ResolveSnapshotMaterializationWorkInput {
  return {
    ...normalizeIdentity(input),
    operationId: parseUuid(input.operationId, "operationId"),
    operationFingerprint: parseFingerprint(input.operationFingerprint, "operationFingerprint"),
    resolvedAt: parseTimestamp(input.resolvedAt, "resolvedAt"),
  };
}

function normalizeConflictSettlementInput(
  input: SettleSnapshotMaterializationConflictInput,
): SettleSnapshotMaterializationConflictInput {
  return {
    ...normalizeResolveInput(input),
    expectedConflictCode: parseConflictCode(input.expectedConflictCode, "expectedConflictCode"),
  };
}

function normalizeDecision(value: unknown): SnapshotMaterializationDecision {
  if (typeof value !== "object" || value === null) {
    throw validationError("The materialization resolver returned no outcome.");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.outcome === "applied" || candidate.outcome === "skipped") {
    if ("conflictCode" in candidate && candidate.conflictCode !== undefined) {
      throw validationError("Only a conflict outcome may include a conflict code.");
    }
    return { outcome: candidate.outcome };
  }
  if (candidate.outcome === "conflict") {
    return {
      outcome: "conflict",
      conflictCode: parseConflictCode(candidate.conflictCode, "conflictCode"),
    };
  }
  throw validationError("The materialization resolver returned an unsupported outcome.");
}

function normalizeConflictSettlement(value: unknown): SnapshotMaterializationConflictSettlement {
  if (typeof value !== "object" || value === null) {
    throw validationError("The snapshot conflict settler returned no outcome.");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.outcome !== "applied" && candidate.outcome !== "skipped") {
    throw validationError("A snapshot conflict settlement must finish as applied or skipped.");
  }
  return { outcome: candidate.outcome };
}

function parseUuid(value: string, field: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be a UUIDv7.`);
  }
  return parsed.data.toLowerCase();
}

function parseStoredUuid(value: string, field: string): string {
  try {
    return parseUuid(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored UUIDv7.`);
  }
}

function parsePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function parseStoredPositiveInteger(value: number, field: string): number {
  try {
    return parsePositiveInteger(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored positive safe integer.`);
  }
}

function parseStoredNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw corruptionError(`${field} is not a stored non-negative safe integer.`);
  }
  return value;
}

function parseTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw validationError(`${field} must be an ISO UTC timestamp.`);
  }
  return value;
}

function parseStoredTimestamp(value: string, field: string): string {
  try {
    return parseTimestamp(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored ISO UTC timestamp.`);
  }
}

function parseFingerprint(value: string, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw validationError(`${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function parseStoredFingerprint(value: string, field: string): string {
  try {
    return parseFingerprint(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored SHA-256 digest.`);
  }
}

function parseConflictCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !CONFLICT_CODE_PATTERN.test(value)) {
    throw validationError(`${field} is not a supported conflict code.`);
  }
  return value;
}

function parseStoredConflictCode(value: string, field: string): string {
  try {
    return parseConflictCode(value, field);
  } catch {
    throw corruptionError(`${field} is not a stored conflict code.`);
  }
}

function parseStoredCursor(value: string, field: string): string {
  if (!CURSOR_PATTERN.test(value)) {
    throw corruptionError(`${field} is not a stored signed remote cursor.`);
  }
  return value;
}

function parseStoredOutcome(value: string): SnapshotMaterializationOutcome {
  if (!SNAPSHOT_MATERIALIZATION_OUTCOMES.includes(value as SnapshotMaterializationOutcome)) {
    throw corruptionError("The stored materialization receipt outcome is unsupported.");
  }
  return value as SnapshotMaterializationOutcome;
}

function parseStoredJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw corruptionError(`${field} is not valid JSON.`);
  }
}

function parseCount(rows: readonly CountDbRow[], field: string): number {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw corruptionError(`${field} could not be read exactly once.`);
  }
  return parseStoredNonNegativeInteger(rows[0].count, field);
}

function canonicalVector(vector: Readonly<Record<string, number>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(vector).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "=");
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  return owned;
}

function toHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}

function requireAtMostOne<Row>(rows: readonly Row[], duplicateMessage: string): Row | null {
  if (rows.length > 1) {
    throw corruptionError(duplicateMessage);
  }
  return rows[0] ?? null;
}

function requireSingleMutation(rowsAffected: number, message: string): void {
  if (rowsAffected !== 1) {
    throw concurrencyError(message);
  }
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
        message: "The local snapshot materialization store could not complete the operation.",
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

function notFoundError(message: string): AppError {
  return new AppError({
    code: "PROJECT_NOT_FOUND",
    message,
    actions: ["OPEN_SETTINGS"],
  });
}

function corruptionError(message: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message,
    actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
    details: { operation: "SYNC_SNAPSHOT_MATERIALIZATION_LOCAL_RECORD_INVALID" },
  });
}
