import {
  CloudCursorSchema,
  CloudSyncPullResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  EncryptedSyncChunkContractSchema,
  IsoUtcTimestampSchema,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  SyncObjectTypeSchema,
  SyncOperationContractSchema,
  SyncTombstoneContractSchema,
  UuidV7Schema,
  VersionVectorSchema,
  type CloudSyncPullResponse,
  type EncryptedSyncChunkContract,
  type SyncObjectType,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";
import { AppError, err, ok, type Result } from "@inkshadow/domain";
import {
  ChunkTransferLedger,
  SyncOperation,
  SyncTombstone,
  type ChunkTransferManifest,
  type ChunkTransferProgress,
  type ChunkUploadReceipt,
  type SyncOperationSnapshot,
  type SyncTombstoneSnapshot,
  type VersionVector,
} from "@inkshadow/sync-core";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export type SyncOutboxStatus = "queued" | "in_flight" | "acknowledged" | "failed" | "paused";
export type SyncInboxStatus = "received" | "applying" | "applied" | "conflict" | "failed";

export interface StoredEncryptedChunk {
  readonly chunkId: string;
  readonly encrypted: EncryptedSyncChunkContract;
  readonly createdAt: string;
}

export interface EnqueueSyncOperationInput {
  readonly operation: SyncOperationContract;
  readonly chunks: readonly StoredEncryptedChunk[];
  readonly now: string;
}

export interface EnqueueSyncOperationReceipt {
  readonly operationId: string;
  readonly created: boolean;
}

export interface EnqueueSyncDeleteOperationInput {
  readonly operation: SyncOperationContract;
  readonly tombstone: SyncTombstoneContract;
  readonly now: string;
}

export interface SyncOutboxRecord {
  readonly operation: SyncOperationSnapshot;
  readonly status: SyncOutboxStatus;
  readonly attempt: number;
  readonly nextAttemptAt: string | null;
  readonly failureCode: string | null;
  readonly acknowledgedAt: string | null;
}

export interface ClaimSyncOperationCommand {
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimProjectSyncOperationCommand extends ClaimSyncOperationCommand {
  readonly projectId: string;
  readonly deviceId: string;
}

export interface ClaimedSyncOperation extends SyncOutboxRecord {
  readonly status: "in_flight";
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface RescheduleSyncOperationCommand {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly failureCode: string;
  readonly now: string;
  readonly nextAttemptAt: string;
}

export interface PauseSyncOperationCommand {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly failureCode: string;
  readonly now: string;
}

export interface CreateTransferReceipt {
  readonly transferId: string;
  readonly created: boolean;
  readonly progress: ChunkTransferProgress;
}

export interface LocalSyncStoreHealth {
  readonly ciphertextChunkCount: number;
  readonly tombstoneCount: number;
  readonly outboxByStatus: Readonly<Record<SyncOutboxStatus, number>>;
  readonly transfersByStatus: Readonly<
    Record<"pending" | "in_flight" | "paused" | "completed" | "failed", number>
  >;
}

export interface ProjectSyncBlockingState {
  readonly projectId: string;
  readonly incomingConflictCount: number;
  readonly incomingPendingCount: number;
  readonly incomingPausedCount: number;
  readonly incomingAttemptExhaustedCount: number;
  readonly outgoingPendingCount: number;
  readonly outgoingPausedCount: number;
  readonly outgoingAttemptExhaustedCount: number;
}

export interface SyncRemoteCheckpoint {
  readonly projectId: string;
  readonly signedRemoteCursor: string | null;
  readonly revision: number;
  readonly updatedAt: string | null;
}

export interface AllocateDeviceSequenceCommand {
  readonly projectId: string;
  readonly deviceId: string;
  readonly now: string;
}

export interface AllocatedDeviceSequence {
  readonly projectId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly revision: number;
}

export interface CompareAndSwapRemoteCheckpointCommand {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly expectedSignedRemoteCursor: string | null;
  readonly nextSignedRemoteCursor: string;
  readonly now: string;
}

export interface StageIncomingSyncBatchCommand {
  readonly projectId: string;
  readonly priorSignedRemoteCursor: string | null;
  readonly response: CloudSyncPullResponse;
  readonly receivedAt: string;
}

export interface StageIncomingSyncBatchReceipt {
  readonly batchId: string;
  readonly created: boolean;
  readonly operationCount: number;
  readonly chunkCount: number;
  readonly tombstoneCount: number;
  readonly checkpoint: SyncRemoteCheckpoint;
}

export interface SyncSnapshotCiphertextUpload {
  readonly chunkId: string;
  readonly encrypted: EncryptedSyncChunkContract;
}

export interface StageSyncSnapshotPageCommand {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly pageIndex: number;
  readonly resumeCursor: string | null;
  readonly snapshotSignedRemoteCursor: string;
  readonly snapshotExpiresAt: string;
  readonly nextSnapshotCursor: string | null;
  readonly finalSignedRemoteCursor: string | null;
  readonly operations: readonly SyncOperationContract[];
  readonly chunks: readonly SyncSnapshotCiphertextUpload[];
  readonly tombstones: readonly SyncTombstoneContract[];
  readonly receivedAt: string;
}

export type SyncSnapshotStagingState = "staging" | "committed";

export interface SyncSnapshotStagingSummary {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly state: SyncSnapshotStagingState;
  readonly baseCheckpoint: SyncRemoteCheckpoint;
  readonly snapshotSignedRemoteCursor: string;
  readonly snapshotExpiresAt: string;
  readonly nextPageIndex: number;
  readonly nextSnapshotCursor: string | null;
  readonly pagesComplete: boolean;
  readonly finalSignedRemoteCursor: string | null;
  readonly operationCount: number;
  readonly chunkCount: number;
  readonly tombstoneCount: number;
  readonly committedCheckpointRevision: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly committedAt: string | null;
}

export interface StageSyncSnapshotPageReceipt {
  readonly created: boolean;
  readonly pageIndex: number;
  readonly pageDigest: string;
  readonly snapshot: SyncSnapshotStagingSummary;
}

export interface CommitSyncSnapshotCommand {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly now: string;
}

export interface CommitSyncSnapshotReceipt {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly operationCount: number;
  readonly chunkCount: number;
  readonly tombstoneCount: number;
  readonly checkpoint: SyncRemoteCheckpoint;
  readonly replayed: boolean;
}

export interface DiscardSyncSnapshotCommand {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
}

export interface DiscardSyncSnapshotReceipt {
  readonly snapshotId: string;
  readonly discarded: boolean;
}

export interface IncomingSyncWork {
  readonly operation: SyncOperationSnapshot;
  readonly chunks: readonly StoredEncryptedChunk[];
  readonly tombstone: SyncTombstoneSnapshot | null;
  readonly status: SyncInboxStatus;
  readonly attempt: number;
  readonly nextAttemptAt: string | null;
  readonly failureCode: string | null;
  readonly conflictCode: string | null;
  readonly resolvedAt: string | null;
}

export interface ClaimIncomingSyncWorkCommand {
  readonly projectId: string;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimedIncomingSyncWork extends IncomingSyncWork {
  readonly status: "applying";
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
}

export interface ResolveIncomingSyncWorkCommand {
  readonly operationId: string;
  readonly leaseToken: string;
  readonly now: string;
}

export interface MarkIncomingConflictCommand extends ResolveIncomingSyncWorkCommand {
  readonly conflictCode: string;
}

export interface MarkIncomingFailureCommand extends ResolveIncomingSyncWorkCommand {
  readonly failureCode: string;
  readonly nextAttemptAt: string | null;
}

export type AtomicIncomingResolution =
  Readonly<{ status: "applied" }> | Readonly<{ status: "conflict"; conflictCode: string }>;

export interface AtomicIncomingResolutionReceipt {
  readonly operationId: string;
  readonly status: "applied" | "conflict";
  readonly conflictCode: string | null;
  readonly replayed: boolean;
}

export type AtomicIncomingApply = (
  transaction: TransactionExecutor,
  work: ClaimedIncomingSyncWork,
) => Promise<AtomicIncomingResolution>;

interface CountDbRow {
  count: number;
}

interface StatusCountDbRow {
  status: string;
  count: number;
}

interface ProjectSyncBlockingDbRow {
  incoming_conflict_count: number;
  incoming_pending_count: number;
  incoming_paused_count: number;
  incoming_attempt_exhausted_count: number;
  outgoing_pending_count: number;
  outgoing_paused_count: number;
  outgoing_attempt_exhausted_count: number;
}

interface OutboxDbRow {
  operation_id: string;
  project_id: string;
  device_id: string;
  device_sequence: number;
  object_type: string;
  object_id: string;
  object_generation: number;
  kind: string;
  vector_json: string;
  status: string;
  attempt: number;
  next_attempt_at: string | null;
  lease_owner_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  failure_code: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationChunkDbRow {
  chunk_id: string;
  position: number;
}

interface CiphertextChunkDbRow {
  chunk_id: string;
  project_id: string;
  object_type: string;
  object_id: string;
  version_id: string;
  chunk_index: number;
  key_version: number;
  algorithm: string;
  nonce: string;
  ciphertext: string;
  ciphertext_sha256: string;
  plaintext_bytes: number;
  created_at: string;
}

interface TombstoneDbRow {
  project_id: string;
  object_type: string;
  object_id: string;
  object_generation: number;
  deleted_by_device_id: string;
  vector_json: string;
  deleted_at: string;
  retain_until: string;
  acknowledged_device_ids_json: string;
  updated_at: string;
}

interface TransferDbRow {
  transfer_id: string;
  project_id: string;
  object_id: string;
  version_id: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface TransferChunkDbRow {
  chunk_id: string;
  chunk_index: number;
  ciphertext_bytes: number;
  ciphertext_sha256: string;
  remote_etag: string | null;
  acknowledged_at: string | null;
}

interface RemoteCheckpointDbRow {
  project_id: string;
  signed_remote_cursor: string;
  revision: number;
  updated_at: string;
}

interface DeviceSequenceDbRow {
  project_id: string;
  device_id: string;
  last_allocated_sequence: number;
  revision: number;
  updated_at: string;
}

interface IncomingBatchDbRow {
  batch_id: string;
  project_id: string;
  prior_signed_remote_cursor: string | null;
  next_signed_remote_cursor: string;
  response_digest: string;
  request_id: string;
  has_more: number;
  operation_count: number;
  chunk_count: number;
  tombstone_count: number;
  received_at: string;
}

interface IncrementalTerminalObservationDbRow {
  project_id: string;
  signed_remote_cursor: string;
  downloaded_checkpoint_revision: number;
  response_digest: string;
}

interface InboxOperationDbRow {
  operation_id: string;
  batch_id: string;
  operation_position: number;
  project_id: string;
  device_id: string;
  device_sequence: number;
  object_type: string;
  object_id: string;
  object_generation: number;
  kind: string;
  vector_json: string;
  operation_created_at: string;
  status: string;
  attempt: number;
  next_attempt_at: string | null;
  lease_owner_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  resolution_token: string | null;
  conflict_code: string | null;
  failure_code: string | null;
  received_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface SnapshotSessionDbRow {
  snapshot_id: string;
  project_id: string;
  epoch: number;
  state: string;
  base_signed_remote_cursor: string | null;
  base_checkpoint_revision: number;
  base_checkpoint_updated_at: string | null;
  snapshot_signed_remote_cursor: string;
  snapshot_expires_at: string;
  next_page_index: number;
  next_snapshot_cursor: string | null;
  pages_complete: number;
  final_signed_remote_cursor: string | null;
  total_operation_count: number;
  total_chunk_count: number;
  total_tombstone_count: number;
  committed_checkpoint_revision: number | null;
  created_at: string;
  updated_at: string;
  committed_at: string | null;
}

interface SnapshotPageDbRow {
  snapshot_id: string;
  page_index: number;
  resume_cursor: string | null;
  snapshot_signed_remote_cursor: string;
  snapshot_expires_at: string;
  next_snapshot_cursor: string | null;
  final_signed_remote_cursor: string | null;
  response_digest: string;
  operation_count: number;
  chunk_count: number;
  tombstone_count: number;
  received_at: string;
}

interface SnapshotDeviceSequenceDbRow {
  device_id: string;
  maximum_sequence: number;
}

const OUTBOX_COLUMNS = `
  operation_id,
  project_id,
  device_id,
  device_sequence,
  object_type,
  object_id,
  object_generation,
  kind,
  vector_json,
  status,
  attempt,
  next_attempt_at,
  lease_owner_id,
  lease_token,
  lease_expires_at,
  failure_code,
  acknowledged_at,
  created_at,
  updated_at
`;

const CIPHERTEXT_CHUNK_COLUMNS = `
  chunk_id,
  project_id,
  object_type,
  object_id,
  version_id,
  chunk_index,
  key_version,
  algorithm,
  nonce,
  ciphertext,
  ciphertext_sha256,
  plaintext_bytes,
  created_at
`;

const INBOX_COLUMNS = `
  operation_id,
  batch_id,
  operation_position,
  project_id,
  device_id,
  device_sequence,
  object_type,
  object_id,
  object_generation,
  kind,
  vector_json,
  operation_created_at,
  status,
  attempt,
  next_attempt_at,
  lease_owner_id,
  lease_token,
  lease_expires_at,
  resolution_token,
  conflict_code,
  failure_code,
  received_at,
  updated_at,
  resolved_at
`;

/**
 * Enqueues a fully encrypted operation on a caller-owned transaction. This is
 * used when projection-job completion and the materialized vector must commit
 * with the outbox row as one crash-safe unit.
 */
export async function enqueueSyncOperationInTransaction(
  transaction: TransactionExecutor,
  inputValue: EnqueueSyncOperationInput,
): Promise<Result<EnqueueSyncOperationReceipt, AppError>> {
  return attempt("SYNC_OUTBOX_ATOMIC_ENQUEUE_FAILED", async () => {
    const input = normalizeEnqueueInput(inputValue);
    await Promise.all(input.chunks.map((chunk) => verifyEncryptedChunk(chunk)));
    return enqueueNormalizedSyncOperation(transaction, input);
  });
}

/**
 * Atomically binds a ciphertext-free delete operation to its exact retained
 * tombstone. Callers cannot commit either half independently.
 */
export async function enqueueSyncDeleteOperationInTransaction(
  transaction: TransactionExecutor,
  inputValue: EnqueueSyncDeleteOperationInput,
): Promise<Result<EnqueueSyncOperationReceipt, AppError>> {
  return attempt("SYNC_OUTBOX_ATOMIC_DELETE_ENQUEUE_FAILED", async () => {
    const input = normalizeEnqueueInput({
      operation: inputValue.operation,
      chunks: [],
      now: inputValue.now,
    });
    const tombstone = normalizeTombstone(inputValue.tombstone);
    if (
      input.operation.kind !== "delete" ||
      input.operation.encryptedChunkIds.length !== 0 ||
      tombstone.projectId !== input.operation.projectId ||
      tombstone.objectType !== input.operation.objectType ||
      tombstone.objectId !== input.operation.objectId ||
      tombstone.objectGeneration !== input.operation.objectGeneration ||
      tombstone.deletedByDeviceId !== input.operation.deviceId ||
      canonicalJson(tombstone.vector) !== canonicalJson(input.operation.vector) ||
      tombstone.acknowledgedDeviceIds.length !== 0
    ) {
      throw validationError("The outgoing delete operation does not carry its exact tombstone.");
    }
    const receipt = await enqueueNormalizedSyncOperation(transaction, input);
    await saveNormalizedTombstone(transaction, tombstone, input.now);
    return receipt;
  });
}

export class SyncSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async allocateNextDeviceSequence(
    commandValue: AllocateDeviceSequenceCommand,
  ): Promise<Result<AllocatedDeviceSequence, AppError>> {
    return attempt("SYNC_DEVICE_SEQUENCE_ALLOCATE_FAILED", async () => {
      const command = {
        projectId: parseUuid(commandValue.projectId, "projectId"),
        deviceId: parseUuid(commandValue.deviceId, "deviceId"),
        now: parseTimestamp(commandValue.now, "now"),
      };
      return this.executor.transaction(async (transaction) => {
        const row = await findDeviceSequenceRow(transaction, command.projectId, command.deviceId);
        if (row === null) {
          await transaction.execute(
            `INSERT INTO sync_device_sequences (
              project_id,
              device_id,
              last_allocated_sequence,
              revision,
              updated_at
            ) VALUES (?, ?, 1, 1, ?)`,
            [command.projectId, command.deviceId, command.now],
          );
          return {
            projectId: command.projectId,
            deviceId: command.deviceId,
            sequence: 1,
            revision: 1,
          };
        }
        const nextSequence = incrementSafeInteger(
          row.last_allocated_sequence,
          "The sync device sequence is exhausted.",
        );
        const nextRevision = incrementSafeInteger(
          row.revision,
          "The sync device sequence revision is exhausted.",
        );
        const updated = await transaction.execute(
          `UPDATE sync_device_sequences
           SET last_allocated_sequence = ?, revision = ?, updated_at = ?
           WHERE project_id = ? AND device_id = ? AND revision = ?`,
          [
            nextSequence,
            nextRevision,
            command.now,
            command.projectId,
            command.deviceId,
            row.revision,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw concurrencyError("The sync device sequence changed before allocation.");
        }
        return {
          projectId: command.projectId,
          deviceId: command.deviceId,
          sequence: nextSequence,
          revision: nextRevision,
        };
      });
    });
  }

  public async readRemoteCheckpoint(
    projectIdValue: string,
  ): Promise<Result<SyncRemoteCheckpoint, AppError>> {
    return attempt("SYNC_REMOTE_CHECKPOINT_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const row = await findRemoteCheckpointRow(this.executor, projectId);
      return rehydrateRemoteCheckpoint(projectId, row);
    });
  }

  public async compareAndSwapRemoteCheckpoint(
    commandValue: CompareAndSwapRemoteCheckpointCommand,
  ): Promise<Result<SyncRemoteCheckpoint, AppError>> {
    return attempt("SYNC_REMOTE_CHECKPOINT_CAS_FAILED", async () => {
      const command = normalizeCheckpointCommand(commandValue);
      return this.executor.transaction((transaction) =>
        compareAndSwapRemoteCheckpoint(transaction, command),
      );
    });
  }

  public async stageIncomingSyncBatch(
    commandValue: StageIncomingSyncBatchCommand,
  ): Promise<Result<StageIncomingSyncBatchReceipt, AppError>> {
    return attempt("SYNC_INCOMING_BATCH_STAGE_FAILED", async () => {
      const command = await normalizeIncomingBatch(commandValue);
      return this.executor.transaction(async (transaction) => {
        const checkpointRow = await findRemoteCheckpointRow(transaction, command.projectId);
        const checkpoint = rehydrateRemoteCheckpoint(command.projectId, checkpointRow);
        if (isStableEmptyPull(command)) {
          if (checkpoint.signedRemoteCursor !== command.priorSignedRemoteCursor) {
            throw concurrencyError(
              "The remote sync checkpoint changed before this empty pull was observed.",
            );
          }
          await recordOrVerifyIncrementalTerminalObservation(transaction, command, checkpoint);
          return {
            batchId: command.batchId,
            created: false,
            operationCount: 0,
            chunkCount: 0,
            tombstoneCount: 0,
            checkpoint,
          };
        }
        const existingBatch = await findIncomingBatchByCursor(
          transaction,
          command.projectId,
          command.response.nextCursor,
        );
        if (
          checkpoint.signedRemoteCursor === command.response.nextCursor &&
          existingBatch !== null &&
          sameIncomingBatch(existingBatch, command)
        ) {
          return incomingBatchReceipt(existingBatch, false, checkpoint);
        }
        if (checkpoint.signedRemoteCursor !== command.priorSignedRemoteCursor) {
          throw concurrencyError(
            "The remote sync checkpoint changed before this pull batch was staged.",
          );
        }
        if (existingBatch !== null) {
          throw concurrencyError(
            "The remote cursor is already bound to a different incoming sync batch.",
          );
        }

        await transaction.execute(
          `INSERT INTO sync_incoming_batches (
            batch_id,
            project_id,
            prior_signed_remote_cursor,
            next_signed_remote_cursor,
            response_digest,
            request_id,
            has_more,
            operation_count,
            chunk_count,
            tombstone_count,
            received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            command.batchId,
            command.projectId,
            command.priorSignedRemoteCursor,
            command.response.nextCursor,
            command.responseDigest,
            command.response.requestId,
            command.response.hasMore ? 1 : 0,
            command.response.operations.length,
            command.response.chunks.length,
            command.response.tombstones.length,
            command.receivedAt,
          ],
        );
        for (const chunk of command.chunks) {
          await insertOrVerifyIncomingChunk(transaction, chunk);
        }
        for (const [operationPosition, operation] of command.response.operations.entries()) {
          const existingOperation = await findInboxOperationById(
            transaction,
            operation.operationId,
          );
          if (existingOperation !== null) {
            throw concurrencyError(
              "An incoming operation is already bound to an earlier remote cursor.",
            );
          }
          await transaction.execute(
            `INSERT INTO sync_inbox_operations (
              operation_id,
              batch_id,
              operation_position,
              project_id,
              device_id,
              device_sequence,
              object_type,
              object_id,
              object_generation,
              kind,
              vector_json,
              operation_created_at,
              status,
              attempt,
              next_attempt_at,
              lease_owner_id,
              lease_token,
              lease_expires_at,
              resolution_token,
              conflict_code,
              failure_code,
              received_at,
              updated_at,
              resolved_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              'received', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
            )`,
            [
              operation.operationId,
              command.batchId,
              operationPosition,
              operation.projectId,
              operation.deviceId,
              operation.deviceSequence,
              operation.objectType,
              operation.objectId,
              operation.objectGeneration,
              operation.kind,
              JSON.stringify(operation.vector),
              operation.createdAt,
              command.receivedAt,
              command.receivedAt,
              command.receivedAt,
            ],
          );
          for (const [position, chunkId] of operation.encryptedChunkIds.entries()) {
            await transaction.execute(
              `INSERT INTO sync_inbox_operation_chunks (operation_id, chunk_id, position)
               VALUES (?, ?, ?)`,
              [operation.operationId, chunkId, position],
            );
          }
          await observeDeviceSequence(
            transaction,
            operation.projectId,
            operation.deviceId,
            operation.deviceSequence,
            command.receivedAt,
          );
        }
        for (const tombstone of command.response.tombstones) {
          await stageIncomingTombstone(transaction, tombstone, command.receivedAt);
        }
        const nextCheckpoint = await compareAndSwapRemoteCheckpoint(transaction, {
          projectId: command.projectId,
          expectedRevision: checkpoint.revision,
          expectedSignedRemoteCursor: command.priorSignedRemoteCursor,
          nextSignedRemoteCursor: command.response.nextCursor,
          now: command.receivedAt,
        });
        return {
          batchId: command.batchId,
          created: true,
          operationCount: command.response.operations.length,
          chunkCount: command.response.chunks.length,
          tombstoneCount: command.response.tombstones.length,
          checkpoint: nextCheckpoint,
        };
      });
    });
  }

  public async readStagedSyncSnapshot(
    projectIdValue: string,
  ): Promise<Result<SyncSnapshotStagingSummary | null, AppError>> {
    return attempt("SYNC_SNAPSHOT_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const row = await findSnapshotSessionByProject(this.executor, projectId);
      return row === null ? null : rehydrateSnapshotSummary(row);
    });
  }

  public async stageSyncSnapshotPage(
    commandValue: StageSyncSnapshotPageCommand,
  ): Promise<Result<StageSyncSnapshotPageReceipt, AppError>> {
    return attempt("SYNC_SNAPSHOT_PAGE_STAGE_FAILED", async () => {
      const command = await normalizeSnapshotPage(commandValue);
      return this.executor.transaction(async (transaction) => {
        let session = await findSnapshotSessionById(transaction, command.snapshotId);
        if (
          session !== null &&
          (session.project_id !== command.projectId || session.epoch !== command.epoch)
        ) {
          throw concurrencyError(
            "The snapshot identifier is already bound to a different project or epoch.",
          );
        }

        const projectSession = await findSnapshotSessionByProject(transaction, command.projectId);
        if (projectSession !== null && projectSession.snapshot_id !== command.snapshotId) {
          throw concurrencyError(
            projectSession.state === "committed"
              ? "The committed snapshot is awaiting plaintext materialization and cannot be replaced."
              : "Another snapshot is already being staged for this project.",
          );
        }

        if (session !== null) {
          const existingPage = await findSnapshotPage(
            transaction,
            command.snapshotId,
            command.pageIndex,
          );
          if (existingPage !== null) {
            if (!sameSnapshotPage(existingPage, command)) {
              throw concurrencyError(
                "The snapshot page index is already bound to different ciphertext.",
              );
            }
            return {
              created: false,
              pageIndex: command.pageIndex,
              pageDigest: command.pageDigest,
              snapshot: rehydrateSnapshotSummary(session),
            };
          }
          if (session.state !== "staging" || session.pages_complete === 1) {
            throw concurrencyError("The completed snapshot cannot accept another page.");
          }
          if (
            session.next_page_index !== command.pageIndex ||
            session.next_snapshot_cursor !== command.resumeCursor ||
            session.snapshot_signed_remote_cursor !== command.snapshotSignedRemoteCursor ||
            session.snapshot_expires_at !== command.snapshotExpiresAt
          ) {
            throw concurrencyError(
              "The snapshot page does not continue the exact staged cursor sequence and high-water mark.",
            );
          }
          if (Date.parse(command.receivedAt) < Date.parse(session.updated_at)) {
            throw concurrencyError("Snapshot page receive times must remain monotonic.");
          }
        } else {
          if (command.pageIndex !== 0 || command.resumeCursor !== null) {
            throw concurrencyError(
              "A new snapshot must begin at page zero without a resume cursor.",
            );
          }
          const checkpointRow = await findRemoteCheckpointRow(transaction, command.projectId);
          const checkpoint = rehydrateRemoteCheckpoint(command.projectId, checkpointRow);
          session = snapshotSessionFromFirstPage(command, checkpoint);
          await insertSnapshotSession(transaction, session);
        }

        try {
          await insertSnapshotPage(transaction, command);
          await insertSnapshotPayload(transaction, command);
        } catch (cause: unknown) {
          if (isSnapshotStagingUniquenessViolation(cause)) {
            throw concurrencyError("The snapshot page reuses an identity from an earlier page.");
          }
          throw cause;
        }
        if (command.pageIndex > 0) {
          const nextSession = advanceSnapshotSession(session, command);
          const updated = await transaction.execute(
            `UPDATE sync_snapshot_staging_sessions
             SET
               next_page_index = ?,
               next_snapshot_cursor = ?,
               pages_complete = ?,
               final_signed_remote_cursor = ?,
               total_operation_count = ?,
               total_chunk_count = ?,
               total_tombstone_count = ?,
               updated_at = ?
             WHERE
               snapshot_id = ?
               AND state = 'staging'
               AND next_page_index = ?
               AND next_snapshot_cursor = ?`,
            [
              nextSession.next_page_index,
              nextSession.next_snapshot_cursor,
              nextSession.pages_complete,
              nextSession.final_signed_remote_cursor,
              nextSession.total_operation_count,
              nextSession.total_chunk_count,
              nextSession.total_tombstone_count,
              nextSession.updated_at,
              command.snapshotId,
              session.next_page_index,
              session.next_snapshot_cursor,
            ],
          );
          if (updated.rowsAffected !== 1) {
            throw concurrencyError("The snapshot staging cursor changed during page insertion.");
          }
          session = nextSession;
        }
        return {
          created: true,
          pageIndex: command.pageIndex,
          pageDigest: command.pageDigest,
          snapshot: rehydrateSnapshotSummary(session),
        };
      });
    });
  }

  public async commitStagedSyncSnapshot(
    commandValue: CommitSyncSnapshotCommand,
  ): Promise<Result<CommitSyncSnapshotReceipt, AppError>> {
    return attempt("SYNC_SNAPSHOT_COMMIT_FAILED", async () => {
      const command = {
        ...normalizeSnapshotIdentity(commandValue),
        now: parseTimestamp(commandValue.now, "now"),
      };
      return this.executor.transaction(async (transaction) => {
        const session = await findSnapshotSessionById(transaction, command.snapshotId);
        if (session === null) {
          throw notFoundError("The staged sync snapshot does not exist.");
        }
        requireSnapshotIdentity(session, command);
        if (session.state === "committed") {
          return committedSnapshotReceipt(session, true);
        }
        if (session.pages_complete !== 1 || session.final_signed_remote_cursor === null) {
          throw concurrencyError("The staged sync snapshot has not received its final page.");
        }
        if (Date.parse(command.now) >= Date.parse(session.snapshot_expires_at)) {
          throw concurrencyError("The staged sync snapshot expired before its atomic commit.");
        }
        if (Date.parse(command.now) < Date.parse(session.updated_at)) {
          throw concurrencyError("The snapshot commit time precedes its final staged page.");
        }
        await verifySnapshotStagingCounts(transaction, session);
        await requireSnapshotCommitQuiescence(transaction, command.projectId);
        await verifyStagedSnapshotChunks(transaction, command.snapshotId);

        await transaction.execute(
          "DELETE FROM sync_incremental_terminal_observations WHERE project_id = ?",
          [command.projectId],
        );
        await transaction.execute("DELETE FROM sync_incoming_batches WHERE project_id = ?", [
          command.projectId,
        ]);
        await transaction.execute("DELETE FROM sync_transfers WHERE project_id = ?", [
          command.projectId,
        ]);
        await transaction.execute("DELETE FROM sync_tombstones WHERE project_id = ?", [
          command.projectId,
        ]);
        await transaction.execute(
          `DELETE FROM sync_outbox_operations
           WHERE project_id = ? AND status = 'acknowledged'`,
          [command.projectId],
        );
        await transaction.execute("DELETE FROM sync_ciphertext_chunks WHERE project_id = ?", [
          command.projectId,
        ]);
        await copySnapshotChunksToBaseline(transaction, command.snapshotId);
        await copySnapshotTombstonesToBaseline(transaction, command.snapshotId);

        const deviceSequences = await transaction.select<SnapshotDeviceSequenceDbRow>(
          `SELECT device_id, MAX(device_sequence) AS maximum_sequence
           FROM sync_snapshot_staging_operations
           WHERE snapshot_id = ?
           GROUP BY device_id`,
          [command.snapshotId],
        );
        for (const row of deviceSequences) {
          await observeDeviceSequence(
            transaction,
            command.projectId,
            parseUuid(row.device_id, "deviceId"),
            parsePositiveRevision(row.maximum_sequence),
            command.now,
          );
        }

        const checkpoint = await compareAndSwapRemoteCheckpoint(transaction, {
          projectId: command.projectId,
          expectedRevision: session.base_checkpoint_revision,
          expectedSignedRemoteCursor: session.base_signed_remote_cursor,
          nextSignedRemoteCursor: session.final_signed_remote_cursor,
          now: command.now,
        });
        const updated = await transaction.execute(
          `UPDATE sync_snapshot_staging_sessions
           SET
             state = 'committed',
             committed_checkpoint_revision = ?,
             updated_at = ?,
             committed_at = ?
           WHERE snapshot_id = ? AND state = 'staging' AND pages_complete = 1`,
          [checkpoint.revision, command.now, command.now, command.snapshotId],
        );
        if (updated.rowsAffected !== 1) {
          throw concurrencyError("The snapshot changed before its commit receipt was recorded.");
        }
        return {
          snapshotId: command.snapshotId,
          projectId: command.projectId,
          epoch: command.epoch,
          operationCount: session.total_operation_count,
          chunkCount: session.total_chunk_count,
          tombstoneCount: session.total_tombstone_count,
          checkpoint,
          replayed: false,
        };
      });
    });
  }

  public async discardStagedSyncSnapshot(
    commandValue: DiscardSyncSnapshotCommand,
  ): Promise<Result<DiscardSyncSnapshotReceipt, AppError>> {
    return attempt("SYNC_SNAPSHOT_DISCARD_FAILED", async () => {
      const command = normalizeSnapshotIdentity(commandValue);
      return this.executor.transaction(async (transaction) => {
        const session = await findSnapshotSessionById(transaction, command.snapshotId);
        if (session === null) {
          return { snapshotId: command.snapshotId, discarded: false };
        }
        requireSnapshotIdentity(session, command);
        if (session.state === "committed") {
          throw concurrencyError("A committed snapshot receipt cannot be discarded.");
        }
        const deleted = await transaction.execute(
          "DELETE FROM sync_snapshot_staging_sessions WHERE snapshot_id = ? AND state = 'staging'",
          [command.snapshotId],
        );
        return {
          snapshotId: command.snapshotId,
          discarded: deleted.rowsAffected === 1,
        };
      });
    });
  }

  public async listIncomingRunnable(
    projectIdValue: string,
    nowValue: string,
    limitValue = 50,
  ): Promise<Result<readonly IncomingSyncWork[], AppError>> {
    return attempt("SYNC_INBOX_LIST_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const now = parseTimestamp(nowValue, "now");
      const limit = parseLimit(limitValue);
      const rows = await this.executor.select<InboxOperationDbRow>(
        `SELECT ${INBOX_COLUMNS}
         FROM sync_inbox_operations AS candidate
         WHERE
           candidate.project_id = ?
           AND candidate.attempt < 100
           AND (
             (candidate.status IN ('received', 'failed') AND candidate.next_attempt_at <= ?)
             OR (candidate.status = 'applying' AND candidate.lease_expires_at <= ?)
           )
           AND NOT EXISTS (
             SELECT 1
             FROM sync_inbox_operations AS predecessor
             WHERE
               predecessor.project_id = candidate.project_id
               AND predecessor.device_id = candidate.device_id
               AND predecessor.device_sequence < candidate.device_sequence
               AND predecessor.status <> 'applied'
           )
         ORDER BY
           CASE WHEN candidate.status = 'applying' THEN 0 ELSE 1 END,
           COALESCE(candidate.lease_expires_at, candidate.next_attempt_at) ASC,
           candidate.received_at ASC,
           candidate.batch_id ASC,
           candidate.operation_position ASC
         LIMIT ?`,
        [projectId, now, now, limit],
      );
      return Promise.all(rows.map((row) => rehydrateIncomingWork(this.executor, row)));
    });
  }

  public async loadIncomingWork(
    operationIdValue: string,
  ): Promise<Result<IncomingSyncWork | null, AppError>> {
    return attempt("SYNC_INBOX_READ_FAILED", async () => {
      const operationId = parseUuid(operationIdValue, "operationId");
      const row = await findInboxOperationById(this.executor, operationId);
      return row === null ? null : rehydrateIncomingWork(this.executor, row);
    });
  }

  public async claimNextIncoming(
    commandValue: ClaimIncomingSyncWorkCommand,
  ): Promise<Result<ClaimedIncomingSyncWork | null, AppError>> {
    return attempt("SYNC_INBOX_CLAIM_FAILED", async () => {
      const command = normalizeIncomingClaimCommand(commandValue);
      return this.executor.transaction(async (transaction) => {
        const rows = await transaction.select<InboxOperationDbRow>(
          `SELECT ${INBOX_COLUMNS}
           FROM sync_inbox_operations AS candidate
           WHERE
             candidate.project_id = ?
             AND candidate.attempt < 100
             AND (
               (candidate.status IN ('received', 'failed') AND candidate.next_attempt_at <= ?)
               OR (candidate.status = 'applying' AND candidate.lease_expires_at <= ?)
             )
             AND NOT EXISTS (
               SELECT 1
               FROM sync_inbox_operations AS predecessor
               WHERE
                 predecessor.project_id = candidate.project_id
                 AND predecessor.device_id = candidate.device_id
                 AND predecessor.device_sequence < candidate.device_sequence
                 AND predecessor.status <> 'applied'
             )
           ORDER BY
             CASE WHEN candidate.status = 'applying' THEN 0 ELSE 1 END,
             COALESCE(candidate.lease_expires_at, candidate.next_attempt_at) ASC,
             candidate.received_at ASC,
             candidate.batch_id ASC,
             candidate.operation_position ASC
           LIMIT 1`,
          [command.projectId, command.now, command.now],
        );
        const row = rows[0];
        if (row === undefined) {
          return null;
        }
        const updated = await transaction.execute(
          `UPDATE sync_inbox_operations
           SET
             status = 'applying',
             attempt = attempt + 1,
             next_attempt_at = NULL,
             lease_owner_id = ?,
             lease_token = ?,
             lease_expires_at = ?,
             resolution_token = NULL,
             conflict_code = NULL,
             failure_code = NULL,
             updated_at = ?,
             resolved_at = NULL
           WHERE operation_id = ? AND updated_at = ?`,
          [
            command.ownerId,
            command.leaseToken,
            command.leaseExpiresAt,
            command.now,
            row.operation_id,
            row.updated_at,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw concurrencyError("The incoming sync work changed before it could be claimed.");
        }
        const claimedRow: InboxOperationDbRow = {
          ...row,
          status: "applying",
          attempt: row.attempt + 1,
          next_attempt_at: null,
          lease_owner_id: command.ownerId,
          lease_token: command.leaseToken,
          lease_expires_at: command.leaseExpiresAt,
          resolution_token: null,
          conflict_code: null,
          failure_code: null,
          updated_at: command.now,
          resolved_at: null,
        };
        const work = await rehydrateIncomingWork(transaction, claimedRow);
        return {
          ...work,
          status: "applying",
          leaseOwnerId: command.ownerId,
          leaseToken: command.leaseToken,
          leaseExpiresAt: command.leaseExpiresAt,
        };
      });
    });
  }

  public async markIncomingApplied(
    commandValue: ResolveIncomingSyncWorkCommand,
  ): Promise<Result<void, AppError>> {
    return this.resolveIncoming("applied", commandValue, null, null, null);
  }

  public async markIncomingConflict(
    commandValue: MarkIncomingConflictCommand,
  ): Promise<Result<void, AppError>> {
    return attempt("SYNC_INBOX_CONFLICT_FAILED", async () => {
      const code = parseResolutionCode(commandValue.conflictCode, "conflictCode");
      await this.resolveIncomingOrThrow("conflict", commandValue, code, null, null);
    });
  }

  public async markIncomingFailure(
    commandValue: MarkIncomingFailureCommand,
  ): Promise<Result<void, AppError>> {
    return attempt("SYNC_INBOX_FAILURE_FAILED", async () => {
      const failureCode = parseResolutionCode(commandValue.failureCode, "failureCode");
      const now = parseTimestamp(commandValue.now, "now");
      const nextAttemptAt =
        commandValue.nextAttemptAt === null
          ? null
          : parseTimestamp(commandValue.nextAttemptAt, "nextAttemptAt");
      if (nextAttemptAt !== null && Date.parse(nextAttemptAt) <= Date.parse(now)) {
        throw validationError("An incoming sync retry must be scheduled in the future.");
      }
      await this.resolveIncomingOrThrow(
        "failed",
        { ...commandValue, now },
        null,
        failureCode,
        nextAttemptAt,
      );
    });
  }

  /**
   * Commits a materialized incoming mutation and its inbox terminal marker in
   * one SQLite transaction. A process crash can therefore expose either both
   * changes or neither change, never a business mutation that will later be
   * applied a second time.
   */
  public async resolveClaimedIncomingAtomically(
    commandValue: ResolveIncomingSyncWorkCommand,
    apply: AtomicIncomingApply,
  ): Promise<Result<AtomicIncomingResolutionReceipt, AppError>> {
    return attempt("SYNC_INBOX_ATOMIC_APPLY_FAILED", async () => {
      const command = normalizeIncomingResolutionCommand(commandValue);
      return this.executor.transaction(async (transaction) => {
        const row = await findInboxOperationById(transaction, command.operationId);
        if (row === null) {
          throw notFoundError("The incoming sync operation does not exist.");
        }
        if (
          (row.status === "applied" || row.status === "conflict") &&
          row.resolution_token === command.leaseToken
        ) {
          return {
            operationId: command.operationId,
            status: row.status,
            conflictCode: row.status === "conflict" ? row.conflict_code : null,
            replayed: true,
          };
        }
        requireCurrentIncomingLease(row, command);
        if (
          row.lease_owner_id === null ||
          row.lease_expires_at === null ||
          row.lease_token === null
        ) {
          throw repositoryCorruptionError("The claimed incoming sync lease is incomplete.");
        }
        const hydrated = await rehydrateIncomingWork(transaction, row);
        const claimed: ClaimedIncomingSyncWork = {
          ...hydrated,
          status: "applying",
          leaseOwnerId: row.lease_owner_id,
          leaseToken: row.lease_token,
          leaseExpiresAt: row.lease_expires_at,
        };
        const resolution = normalizeAtomicIncomingResolution(await apply(transaction, claimed));
        const conflictCode = resolution.status === "conflict" ? resolution.conflictCode : null;
        await writeIncomingResolution(
          transaction,
          resolution.status,
          command,
          conflictCode,
          null,
          null,
        );
        return {
          operationId: command.operationId,
          status: resolution.status,
          conflictCode,
          replayed: false,
        };
      });
    });
  }

  private async resolveIncoming(
    status: "applied",
    commandValue: ResolveIncomingSyncWorkCommand,
    conflictCode: null,
    failureCode: null,
    nextAttemptAt: null,
  ): Promise<Result<void, AppError>> {
    return attempt("SYNC_INBOX_APPLY_FAILED", async () => {
      await this.resolveIncomingOrThrow(
        status,
        commandValue,
        conflictCode,
        failureCode,
        nextAttemptAt,
      );
    });
  }

  private async resolveIncomingOrThrow(
    status: "applied" | "conflict" | "failed",
    commandValue: ResolveIncomingSyncWorkCommand,
    conflictCode: string | null,
    failureCode: string | null,
    nextAttemptAt: string | null,
  ): Promise<void> {
    const command = normalizeIncomingResolutionCommand(commandValue);
    await this.executor.transaction(async (transaction) => {
      const row = await findInboxOperationById(transaction, command.operationId);
      if (row === null) {
        throw notFoundError("The incoming sync operation does not exist.");
      }
      if (
        row.status === status &&
        row.resolution_token === command.leaseToken &&
        row.conflict_code === conflictCode &&
        row.failure_code === failureCode &&
        row.next_attempt_at === nextAttemptAt
      ) {
        return;
      }
      requireCurrentIncomingLease(row, command);
      await writeIncomingResolution(
        transaction,
        status,
        command,
        conflictCode,
        failureCode,
        nextAttemptAt,
      );
    });
  }

  public async enqueue(
    inputValue: EnqueueSyncOperationInput,
  ): Promise<Result<EnqueueSyncOperationReceipt, AppError>> {
    return attempt("SYNC_OUTBOX_ENQUEUE_FAILED", async () => {
      const input = normalizeEnqueueInput(inputValue);
      await Promise.all(input.chunks.map((chunk) => verifyEncryptedChunk(chunk)));
      return this.executor.transaction((transaction) =>
        enqueueNormalizedSyncOperation(transaction, input),
      );
    });
  }

  public async health(): Promise<Result<LocalSyncStoreHealth, AppError>> {
    return attempt("SYNC_LOCAL_HEALTH_FAILED", async () => {
      const [chunkRows, tombstoneRows, outboxRows, transferRows] = await Promise.all([
        this.executor.select<CountDbRow>("SELECT count(*) AS count FROM sync_ciphertext_chunks"),
        this.executor.select<CountDbRow>("SELECT count(*) AS count FROM sync_tombstones"),
        this.executor.select<StatusCountDbRow>(
          `SELECT status, count(*) AS count
           FROM sync_outbox_operations
           GROUP BY status`,
        ),
        this.executor.select<StatusCountDbRow>(
          `SELECT status, count(*) AS count
           FROM sync_transfers
           GROUP BY status`,
        ),
      ]);
      return {
        ciphertextChunkCount: requireCount(chunkRows[0]?.count),
        tombstoneCount: requireCount(tombstoneRows[0]?.count),
        outboxByStatus: buildStatusCounts(
          ["queued", "in_flight", "acknowledged", "failed", "paused"],
          outboxRows,
        ),
        transfersByStatus: buildStatusCounts(
          ["pending", "in_flight", "paused", "completed", "failed"],
          transferRows,
        ),
      };
    });
  }

  public async readProjectSyncBlockingState(
    projectIdValue: string,
  ): Promise<Result<ProjectSyncBlockingState, AppError>> {
    return attempt("SYNC_PROJECT_BLOCKING_STATE_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const rows = await this.executor.select<ProjectSyncBlockingDbRow>(
        `SELECT
           (
             SELECT count(*)
             FROM sync_inbox_operations
             WHERE project_id = ? AND status = 'conflict'
           ) AS incoming_conflict_count,
           (
             SELECT count(*)
             FROM sync_inbox_operations
             WHERE project_id = ? AND status IN ('received', 'applying', 'failed')
           ) AS incoming_pending_count,
           (
             SELECT count(*)
             FROM sync_inbox_operations
             WHERE project_id = ?
               AND status = 'failed'
               AND next_attempt_at IS NULL
               AND attempt < 100
           ) AS incoming_paused_count,
           (
             SELECT count(*)
             FROM sync_inbox_operations
             WHERE project_id = ?
               AND status = 'failed'
               AND attempt >= 100
           ) AS incoming_attempt_exhausted_count,
           (
             SELECT count(*)
             FROM sync_outbox_operations
             WHERE project_id = ? AND status IN ('queued', 'in_flight', 'failed')
           ) AS outgoing_pending_count,
           (
             SELECT count(*)
             FROM sync_outbox_operations
             WHERE project_id = ? AND status = 'paused'
           ) AS outgoing_paused_count,
           (
             SELECT count(*)
             FROM sync_outbox_operations
             WHERE project_id = ?
               AND status = 'failed'
               AND attempt >= 100
           ) AS outgoing_attempt_exhausted_count`,
        [projectId, projectId, projectId, projectId, projectId, projectId, projectId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw repositoryCorruptionError("The project sync blocking summary is unavailable.");
      }
      const counts = [
        row.incoming_conflict_count,
        row.incoming_pending_count,
        row.incoming_paused_count,
        row.incoming_attempt_exhausted_count,
        row.outgoing_pending_count,
        row.outgoing_paused_count,
        row.outgoing_attempt_exhausted_count,
      ];
      if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
        throw repositoryCorruptionError("The project sync blocking summary is invalid.");
      }
      return {
        projectId,
        incomingConflictCount: row.incoming_conflict_count,
        incomingPendingCount: row.incoming_pending_count,
        incomingPausedCount: row.incoming_paused_count,
        incomingAttemptExhaustedCount: row.incoming_attempt_exhausted_count,
        outgoingPendingCount: row.outgoing_pending_count,
        outgoingPausedCount: row.outgoing_paused_count,
        outgoingAttemptExhaustedCount: row.outgoing_attempt_exhausted_count,
      };
    });
  }

  public async findOutbox(
    operationIdValue: string,
  ): Promise<Result<SyncOutboxRecord | null, AppError>> {
    return attempt("SYNC_OUTBOX_READ_FAILED", async () => {
      const operationId = parseUuid(operationIdValue, "operationId");
      const row = await findOutboxById(this.executor, operationId);
      return row === null ? null : rehydrateOutboxRecord(this.executor, row);
    });
  }

  public async listRunnable(
    nowValue: string,
    limitValue = 50,
  ): Promise<Result<readonly SyncOutboxRecord[], AppError>> {
    return attempt("SYNC_OUTBOX_LIST_FAILED", async () => {
      const now = parseTimestamp(nowValue, "now");
      const limit = parseLimit(limitValue);
      const rows = await this.executor.select<OutboxDbRow>(
        `SELECT ${OUTBOX_COLUMNS}
         FROM sync_outbox_operations
         WHERE
           attempt < 100
           AND (
             (status IN ('queued', 'failed') AND next_attempt_at <= ?)
             OR (status = 'in_flight' AND lease_expires_at <= ?)
           )
         ORDER BY
           CASE WHEN status = 'in_flight' THEN 0 ELSE 1 END,
           COALESCE(lease_expires_at, next_attempt_at) ASC,
           created_at ASC,
           operation_id ASC
         LIMIT ?`,
        [now, now, limit],
      );
      return Promise.all(rows.map((row) => rehydrateOutboxRecord(this.executor, row)));
    });
  }

  public async claimNext(
    commandValue: ClaimSyncOperationCommand,
  ): Promise<Result<ClaimedSyncOperation | null, AppError>> {
    return attempt("SYNC_OUTBOX_CLAIM_FAILED", async () => {
      const command = normalizeClaimCommand(commandValue);
      return this.claimNextMatchingProject(command, null);
    });
  }

  public async claimNextForProject(
    commandValue: ClaimProjectSyncOperationCommand,
  ): Promise<Result<ClaimedSyncOperation | null, AppError>> {
    return attempt("SYNC_OUTBOX_PROJECT_CLAIM_FAILED", async () => {
      const projectId = parseUuid(commandValue.projectId, "projectId");
      const deviceId = parseUuid(commandValue.deviceId, "deviceId");
      const command = normalizeClaimCommand(commandValue);
      return this.claimNextMatchingProject(command, { projectId, deviceId });
    });
  }

  public async acknowledge(
    operationIdValue: string,
    leaseTokenValue: string,
    nowValue: string,
  ): Promise<Result<void, AppError>> {
    return attempt("SYNC_OUTBOX_ACKNOWLEDGE_FAILED", async () => {
      const operationId = parseUuid(operationIdValue, "operationId");
      const leaseToken = parseUuid(leaseTokenValue, "leaseToken");
      const now = parseTimestamp(nowValue, "now");
      const result = await this.executor.execute(
        `UPDATE sync_outbox_operations
         SET
           status = 'acknowledged',
           next_attempt_at = NULL,
           lease_owner_id = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           failure_code = NULL,
           acknowledged_at = ?,
           updated_at = ?
         WHERE
           operation_id = ?
           AND status = 'in_flight'
           AND lease_token = ?
           AND lease_expires_at > ?`,
        [now, now, operationId, leaseToken, now],
      );
      if (result.rowsAffected !== 1) {
        throw concurrencyError("The sync operation lease is no longer current.");
      }
    });
  }

  public async rescheduleFailure(
    commandValue: RescheduleSyncOperationCommand,
  ): Promise<Result<void, AppError>> {
    return attempt("SYNC_OUTBOX_RESCHEDULE_FAILED", async () => {
      const command = normalizeRescheduleCommand(commandValue);
      const result = await this.executor.execute(
        `UPDATE sync_outbox_operations
         SET
           status = 'failed',
           next_attempt_at = ?,
           lease_owner_id = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           failure_code = ?,
           updated_at = ?
         WHERE
           operation_id = ?
           AND status = 'in_flight'
           AND lease_token = ?
           AND lease_expires_at > ?`,
        [
          command.nextAttemptAt,
          command.failureCode,
          command.now,
          command.operationId,
          command.leaseToken,
          command.now,
        ],
      );
      if (result.rowsAffected !== 1) {
        throw concurrencyError("The sync operation lease is no longer current.");
      }
    });
  }

  public async pauseFailure(
    commandValue: PauseSyncOperationCommand,
  ): Promise<Result<void, AppError>> {
    return attempt("SYNC_OUTBOX_PAUSE_FAILED", async () => {
      const command = normalizePauseCommand(commandValue);
      const result = await this.executor.execute(
        `UPDATE sync_outbox_operations
         SET
           status = 'paused',
           next_attempt_at = NULL,
           lease_owner_id = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           failure_code = ?,
           updated_at = ?
         WHERE
           operation_id = ?
           AND status = 'in_flight'
           AND lease_token = ?
           AND lease_expires_at > ?`,
        [command.failureCode, command.now, command.operationId, command.leaseToken, command.now],
      );
      if (result.rowsAffected !== 1) {
        throw concurrencyError("The sync operation lease is no longer current.");
      }
    });
  }

  public async getEncryptedChunk(
    chunkIdValue: string,
  ): Promise<Result<StoredEncryptedChunk | null, AppError>> {
    return attempt("SYNC_CHUNK_READ_FAILED", async () => {
      const chunkId = parseUuid(chunkIdValue, "chunkId");
      const rows = await this.executor.select<CiphertextChunkDbRow>(
        `SELECT ${CIPHERTEXT_CHUNK_COLUMNS}
         FROM sync_ciphertext_chunks
         WHERE chunk_id = ?
         LIMIT 1`,
        [chunkId],
      );
      if (rows[0] === undefined) {
        return null;
      }
      const chunk = rehydrateChunk(rows[0]);
      await verifyEncryptedChunk(chunk, repositoryCorruptionError);
      return chunk;
    });
  }

  private async claimNextMatchingProject(
    command: ClaimSyncOperationCommand,
    scope: Readonly<{ projectId: string; deviceId: string }> | null,
  ): Promise<ClaimedSyncOperation | null> {
    return this.executor.transaction(async (transaction) => {
      const projectPredicate =
        scope === null ? "" : "candidate.project_id = ? AND candidate.device_id = ? AND";
      const selectParameters =
        scope === null
          ? [command.now, command.now]
          : [scope.projectId, scope.deviceId, command.now, command.now];
      const rows = await transaction.select<OutboxDbRow>(
        `SELECT ${OUTBOX_COLUMNS}
         FROM sync_outbox_operations AS candidate
         WHERE
           ${projectPredicate}
           candidate.attempt < 100
           AND (
             (candidate.status IN ('queued', 'failed') AND candidate.next_attempt_at <= ?)
             OR (candidate.status = 'in_flight' AND candidate.lease_expires_at <= ?)
           )
           AND NOT EXISTS (
             SELECT 1
             FROM sync_outbox_operations AS predecessor
             WHERE
               predecessor.project_id = candidate.project_id
               AND predecessor.device_id = candidate.device_id
               AND predecessor.device_sequence < candidate.device_sequence
               AND predecessor.status <> 'acknowledged'
           )
         ORDER BY
           CASE WHEN candidate.status = 'in_flight' THEN 0 ELSE 1 END,
           COALESCE(candidate.lease_expires_at, candidate.next_attempt_at) ASC,
           candidate.created_at ASC,
           candidate.operation_id ASC
         LIMIT 1`,
        selectParameters,
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const updated = await transaction.execute(
        `UPDATE sync_outbox_operations
         SET
           status = 'in_flight',
           attempt = attempt + 1,
           next_attempt_at = NULL,
           lease_owner_id = ?,
           lease_token = ?,
           lease_expires_at = ?,
           failure_code = NULL,
           updated_at = ?
         WHERE operation_id = ? AND project_id = ? AND updated_at = ?`,
        [
          command.ownerId,
          command.leaseToken,
          command.leaseExpiresAt,
          command.now,
          row.operation_id,
          row.project_id,
          row.updated_at,
        ],
      );
      if (updated.rowsAffected !== 1) {
        throw concurrencyError("The sync operation changed before it could be claimed.");
      }
      const claimedRow: OutboxDbRow = {
        ...row,
        status: "in_flight",
        attempt: row.attempt + 1,
        next_attempt_at: null,
        lease_owner_id: command.ownerId,
        lease_token: command.leaseToken,
        lease_expires_at: command.leaseExpiresAt,
        failure_code: null,
        updated_at: command.now,
      };
      const record = await rehydrateOutboxRecord(transaction, claimedRow);
      return {
        ...record,
        status: "in_flight",
        leaseOwnerId: command.ownerId,
        leaseToken: command.leaseToken,
        leaseExpiresAt: command.leaseExpiresAt,
      };
    });
  }

  public async saveTombstone(
    snapshotValue: SyncTombstoneContract,
    nowValue: string,
  ): Promise<Result<void, AppError>> {
    return attempt("SYNC_TOMBSTONE_SAVE_FAILED", async () => {
      const snapshot = normalizeTombstone(snapshotValue);
      const now = parseTimestamp(nowValue, "now");
      await this.executor.transaction((transaction) =>
        saveNormalizedTombstone(transaction, snapshot, now),
      );
    });
  }

  public async findLatestTombstone(
    projectIdValue: string,
    objectTypeValue: SyncObjectType,
    objectIdValue: string,
  ): Promise<Result<SyncTombstoneSnapshot | null, AppError>> {
    return attempt("SYNC_TOMBSTONE_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const objectType = parseWithSchema(SyncObjectTypeSchema, objectTypeValue);
      const objectId = parseUuid(objectIdValue, "objectId");
      const row = await findLatestTombstoneRow(this.executor, projectId, objectType, objectId);
      return row === null ? null : rehydrateTombstone(row);
    });
  }

  public async findTombstone(
    projectIdValue: string,
    objectTypeValue: SyncObjectType,
    objectIdValue: string,
    objectGenerationValue: number,
  ): Promise<Result<SyncTombstoneSnapshot | null, AppError>> {
    return attempt("SYNC_TOMBSTONE_READ_FAILED", async () => {
      const projectId = parseUuid(projectIdValue, "projectId");
      const objectType = parseWithSchema(SyncObjectTypeSchema, objectTypeValue);
      const objectId = parseUuid(objectIdValue, "objectId");
      if (!Number.isSafeInteger(objectGenerationValue) || objectGenerationValue < 1) {
        throw validationError("objectGeneration must be a positive safe integer.");
      }
      const row = await findTombstoneRow(
        this.executor,
        projectId,
        objectType,
        objectId,
        objectGenerationValue,
      );
      return row === null ? null : rehydrateTombstone(row);
    });
  }

  public async acknowledgeTombstone(input: {
    readonly projectId: string;
    readonly objectType: SyncObjectType;
    readonly objectId: string;
    readonly objectGeneration: number;
    readonly deviceId: string;
    readonly observedVector: VersionVector;
    readonly now: string;
  }): Promise<Result<SyncTombstoneSnapshot, AppError>> {
    return attempt("SYNC_TOMBSTONE_ACKNOWLEDGE_FAILED", async () => {
      const projectId = parseUuid(input.projectId, "projectId");
      const objectType = parseWithSchema(SyncObjectTypeSchema, input.objectType);
      const objectId = parseUuid(input.objectId, "objectId");
      const deviceId = parseUuid(input.deviceId, "deviceId");
      const now = parseTimestamp(input.now, "now");
      return this.executor.transaction(async (transaction) => {
        const rows = await transaction.select<TombstoneDbRow>(
          `SELECT
             project_id,
             object_type,
             object_id,
             object_generation,
             deleted_by_device_id,
             vector_json,
             deleted_at,
             retain_until,
             acknowledged_device_ids_json,
             updated_at
           FROM sync_tombstones
           WHERE project_id = ?
             AND object_type = ?
             AND object_id = ?
             AND object_generation = ?
           LIMIT 1`,
          [projectId, objectType, objectId, input.objectGeneration],
        );
        const row = rows[0];
        if (row === undefined) {
          throw notFoundError("The sync tombstone does not exist.");
        }
        let acknowledged: SyncTombstone;
        try {
          acknowledged = SyncTombstone.create(rehydrateTombstone(row)).acknowledge(
            deviceId,
            normalizeVersionVectorContract(input.observedVector),
          );
        } catch {
          throw validationError("The device has not observed the tombstone version.");
        }
        const snapshot = acknowledged.toSnapshot();
        await transaction.execute(
          `UPDATE sync_tombstones
           SET acknowledged_device_ids_json = ?, updated_at = ?
           WHERE project_id = ?
             AND object_type = ?
             AND object_id = ?
             AND object_generation = ?`,
          [
            JSON.stringify(snapshot.acknowledgedDeviceIds),
            now,
            projectId,
            objectType,
            objectId,
            input.objectGeneration,
          ],
        );
        return snapshot;
      });
    });
  }

  public async createTransfer(
    manifestValue: ChunkTransferManifest,
    nowValue: string,
  ): Promise<Result<CreateTransferReceipt, AppError>> {
    return attempt("SYNC_TRANSFER_CREATE_FAILED", async () => {
      const manifest = normalizeTransferManifest(manifestValue);
      const now = parseTimestamp(nowValue, "now");
      return this.executor.transaction(async (transaction) => {
        const existing = await findTransferRow(transaction, manifest.transferId);
        if (existing !== null) {
          const ledger = await rehydrateTransferLedger(transaction, existing);
          if (!sameManifest(manifest, await readTransferManifest(transaction, existing))) {
            throw validationError("The transfer identifier is already bound to another manifest.");
          }
          return {
            transferId: manifest.transferId,
            created: false,
            progress: ledger.progress(),
          };
        }

        for (const manifestChunk of manifest.chunks) {
          const stored = await findChunkRow(transaction, manifestChunk.chunkId);
          if (stored === null) {
            throw notFoundError("A transfer ciphertext chunk does not exist.");
          }
          if (
            stored.project_id !== manifest.projectId ||
            stored.object_id !== manifest.objectId ||
            stored.version_id !== manifest.versionId ||
            stored.chunk_index !== manifestChunk.index ||
            stored.ciphertext_sha256 !== manifestChunk.ciphertextSha256 ||
            decodedByteLength(stored.ciphertext) !== manifestChunk.ciphertextBytes
          ) {
            throw validationError("The transfer manifest does not match stored ciphertext.");
          }
          await verifyEncryptedChunk(rehydrateChunk(stored), repositoryCorruptionError);
        }
        await transaction.execute(
          `INSERT INTO sync_transfers (
            transfer_id,
            project_id,
            object_id,
            version_id,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
          [
            manifest.transferId,
            manifest.projectId,
            manifest.objectId,
            manifest.versionId,
            now,
            now,
          ],
        );
        for (const chunk of manifest.chunks) {
          await transaction.execute(
            `INSERT INTO sync_transfer_chunks (
              transfer_id,
              chunk_id,
              chunk_index,
              ciphertext_bytes,
              ciphertext_sha256,
              remote_etag,
              acknowledged_at
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
            [
              manifest.transferId,
              chunk.chunkId,
              chunk.index,
              chunk.ciphertextBytes,
              chunk.ciphertextSha256,
            ],
          );
        }
        return {
          transferId: manifest.transferId,
          created: true,
          progress: new ChunkTransferLedger(manifest).progress(),
        };
      });
    });
  }

  public async loadTransfer(
    transferIdValue: string,
  ): Promise<Result<ChunkTransferProgress | null, AppError>> {
    return attempt("SYNC_TRANSFER_READ_FAILED", async () => {
      const transferId = parseUuid(transferIdValue, "transferId");
      const row = await findTransferRow(this.executor, transferId);
      return row === null ? null : (await rehydrateTransferLedger(this.executor, row)).progress();
    });
  }

  public async acknowledgeTransferChunk(input: {
    readonly transferId: string;
    readonly chunkId: string;
    readonly receipt: ChunkUploadReceipt;
    readonly now: string;
  }): Promise<Result<ChunkTransferProgress, AppError>> {
    return attempt("SYNC_TRANSFER_ACKNOWLEDGE_FAILED", async () => {
      const transferId = parseUuid(input.transferId, "transferId");
      const chunkId = parseUuid(input.chunkId, "chunkId");
      const now = parseTimestamp(input.now, "now");
      return this.executor.transaction(async (transaction) => {
        const transfer = await findTransferRow(transaction, transferId);
        if (transfer === null) {
          throw notFoundError("The sync transfer does not exist.");
        }
        const ledger = await rehydrateTransferLedger(transaction, transfer);
        let acknowledgement: { readonly created: boolean };
        try {
          acknowledgement = ledger.acknowledge(chunkId, input.receipt);
        } catch {
          throw validationError("The remote receipt does not match the ciphertext manifest.");
        }
        if (acknowledgement.created) {
          await transaction.execute(
            `UPDATE sync_transfer_chunks
             SET remote_etag = ?, acknowledged_at = ?
             WHERE transfer_id = ? AND chunk_id = ?`,
            [input.receipt.remoteETag, now, transferId, chunkId],
          );
        }
        const progress = ledger.progress();
        await transaction.execute(
          `UPDATE sync_transfers
           SET status = ?, updated_at = ?
           WHERE transfer_id = ?`,
          [progress.complete ? "completed" : "in_flight", now, transferId],
        );
        return progress;
      });
    });
  }
}

interface NormalizedSnapshotIdentity {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
}

interface NormalizedSnapshotPage extends NormalizedSnapshotIdentity {
  readonly pageIndex: number;
  readonly resumeCursor: string | null;
  readonly snapshotSignedRemoteCursor: string;
  readonly snapshotExpiresAt: string;
  readonly nextSnapshotCursor: string | null;
  readonly finalSignedRemoteCursor: string | null;
  readonly operations: readonly SyncOperationContract[];
  readonly chunks: readonly StoredEncryptedChunk[];
  readonly uploads: readonly SyncSnapshotCiphertextUpload[];
  readonly tombstones: readonly SyncTombstoneContract[];
  readonly receivedAt: string;
  readonly pageDigest: string;
}

interface NormalizedIncomingBatch {
  readonly projectId: string;
  readonly priorSignedRemoteCursor: string | null;
  readonly response: CloudSyncPullResponse;
  readonly receivedAt: string;
  readonly chunks: readonly StoredEncryptedChunk[];
  readonly responseDigest: string;
  readonly batchId: string;
}

async function normalizeSnapshotPage(
  command: StageSyncSnapshotPageCommand,
): Promise<NormalizedSnapshotPage> {
  const identity = normalizeSnapshotIdentity(command);
  const pageIndex = parseNonNegativeSafeInteger(command.pageIndex, "pageIndex");
  if (pageIndex >= Number.MAX_SAFE_INTEGER) {
    throw validationError("pageIndex must leave room for the next snapshot page.");
  }
  const resumeCursor =
    command.resumeCursor === null ? null : parseCloudCursor(command.resumeCursor, "resumeCursor");
  const snapshotSignedRemoteCursor = parseCloudCursor(
    command.snapshotSignedRemoteCursor,
    "snapshotSignedRemoteCursor",
  );
  const snapshotExpiresAt = parseTimestamp(command.snapshotExpiresAt, "snapshotExpiresAt");
  const nextSnapshotCursor =
    command.nextSnapshotCursor === null
      ? null
      : parseCloudCursor(command.nextSnapshotCursor, "nextSnapshotCursor");
  const finalSignedRemoteCursor =
    command.finalSignedRemoteCursor === null
      ? null
      : parseCloudCursor(command.finalSignedRemoteCursor, "finalSignedRemoteCursor");
  const receivedAt = parseTimestamp(command.receivedAt, "receivedAt");
  if (Date.parse(receivedAt) >= Date.parse(snapshotExpiresAt)) {
    throw validationError("A snapshot page cannot be staged at or after its expiry.");
  }
  if ((pageIndex === 0) !== (resumeCursor === null)) {
    throw validationError("Only snapshot page zero may omit its resume cursor.");
  }
  if (
    (nextSnapshotCursor === null) === (finalSignedRemoteCursor === null) ||
    (nextSnapshotCursor !== null && nextSnapshotCursor === resumeCursor) ||
    (finalSignedRemoteCursor !== null && finalSignedRemoteCursor !== snapshotSignedRemoteCursor)
  ) {
    throw validationError(
      "A snapshot page must advance its snapshot cursor or finish at its fixed remote high-water mark.",
    );
  }
  if (
    command.operations.length > 256 ||
    command.chunks.length > 10_000 ||
    command.tombstones.length > 256
  ) {
    throw validationError("The snapshot page exceeds its bounded ciphertext payload limits.");
  }

  const operations = command.operations.map((operation) => {
    const parsed = parseWithSchema(SyncOperationContractSchema, operation);
    if (parsed.projectId !== identity.projectId) {
      throw validationError("A snapshot operation is outside the staged project.");
    }
    toCoreOperation(parsed);
    return parsed;
  });
  const operationIds = new Set<string>();
  const deviceSequences = new Set<string>();
  const chunkOwners = new Map<string, SyncOperationContract>();
  for (const operation of operations) {
    const deviceSequence = `${operation.deviceId}:${String(operation.deviceSequence)}`;
    if (operationIds.has(operation.operationId) || deviceSequences.has(deviceSequence)) {
      throw validationError("Snapshot operations must have unique identities and sequences.");
    }
    operationIds.add(operation.operationId);
    deviceSequences.add(deviceSequence);
    for (const chunkId of operation.encryptedChunkIds) {
      if (chunkOwners.has(chunkId)) {
        throw validationError("A snapshot ciphertext chunk has more than one operation owner.");
      }
      chunkOwners.set(chunkId, operation);
    }
  }

  const chunksById = new Map<string, StoredEncryptedChunk>();
  const uploads: SyncSnapshotCiphertextUpload[] = [];
  for (const uploadValue of command.chunks) {
    const upload = {
      chunkId: parseUuid(uploadValue.chunkId, "chunkId"),
      encrypted: parseWithSchema(EncryptedSyncChunkContractSchema, uploadValue.encrypted),
    };
    if (chunksById.has(upload.chunkId)) {
      throw validationError("Snapshot ciphertext chunk identifiers must be unique.");
    }
    const owner = chunkOwners.get(upload.chunkId);
    if (
      owner === undefined ||
      upload.encrypted.aad.projectId !== identity.projectId ||
      upload.encrypted.aad.objectType !== owner.objectType ||
      upload.encrypted.aad.objectId !== owner.objectId
    ) {
      throw validationError("Snapshot ciphertext ownership does not match its operation.");
    }
    const chunk = {
      chunkId: upload.chunkId,
      encrypted: upload.encrypted,
      createdAt: receivedAt,
    };
    chunksById.set(upload.chunkId, chunk);
    uploads.push(upload);
  }
  if (
    chunksById.size !== chunkOwners.size ||
    [...chunkOwners.keys()].some((chunkId) => !chunksById.has(chunkId))
  ) {
    throw validationError("The snapshot page does not contain its exact ciphertext set.");
  }
  for (const operation of operations) {
    const ownedChunks = operation.encryptedChunkIds.map((chunkId) => {
      const chunk = chunksById.get(chunkId);
      if (chunk === undefined) {
        throw validationError("A snapshot operation ciphertext chunk is missing.");
      }
      return chunk;
    });
    const first = ownedChunks[0];
    for (const [position, chunk] of ownedChunks.entries()) {
      if (
        chunk.encrypted.aad.chunkIndex !== position ||
        (first !== undefined &&
          (chunk.encrypted.aad.objectType !== first.encrypted.aad.objectType ||
            chunk.encrypted.aad.versionId !== first.encrypted.aad.versionId ||
            chunk.encrypted.aad.keyVersion !== first.encrypted.aad.keyVersion))
      ) {
        throw validationError("Snapshot ciphertext chunk metadata is not a complete ordered set.");
      }
    }
  }
  await Promise.all([...chunksById.values()].map((chunk) => verifyEncryptedChunk(chunk)));

  const tombstones = command.tombstones.map((value) => normalizeTombstone(value));
  const tombstonesByObject = new Map<string, SyncTombstoneContract>();
  for (const tombstone of tombstones) {
    const key = tombstoneKey(tombstone.objectType, tombstone.objectId, tombstone.objectGeneration);
    if (tombstone.projectId !== identity.projectId || tombstonesByObject.has(key)) {
      throw validationError("A snapshot tombstone is duplicated or outside the project.");
    }
    tombstonesByObject.set(key, tombstone);
  }
  for (const operation of operations) {
    const key = tombstoneKey(operation.objectType, operation.objectId, operation.objectGeneration);
    const tombstone = tombstonesByObject.get(key);
    if (operation.kind === "delete") {
      if (
        tombstone?.deletedByDeviceId !== operation.deviceId ||
        canonicalJson(tombstone.vector) !== canonicalJson(operation.vector)
      ) {
        throw validationError("A snapshot delete operation lacks its exact tombstone.");
      }
      tombstonesByObject.delete(key);
    } else if (tombstone !== undefined) {
      throw validationError("Only snapshot delete operations can carry tombstones.");
    }
  }
  if (tombstonesByObject.size !== 0) {
    throw validationError("A snapshot tombstone has no matching delete operation.");
  }

  const pageDigest = await sha256Hex(
    canonicalJson({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ...identity,
      pageIndex,
      resumeCursor,
      snapshotSignedRemoteCursor,
      snapshotExpiresAt,
      nextSnapshotCursor,
      finalSignedRemoteCursor,
      operations,
      chunks: uploads,
      tombstones,
    }),
  );
  return {
    ...identity,
    pageIndex,
    resumeCursor,
    snapshotSignedRemoteCursor,
    snapshotExpiresAt,
    nextSnapshotCursor,
    finalSignedRemoteCursor,
    operations,
    chunks: [...chunksById.values()],
    uploads,
    tombstones,
    receivedAt,
    pageDigest,
  };
}

async function normalizeIncomingBatch(
  command: StageIncomingSyncBatchCommand,
): Promise<NormalizedIncomingBatch> {
  const projectId = parseUuid(command.projectId, "projectId");
  const priorSignedRemoteCursor =
    command.priorSignedRemoteCursor === null
      ? null
      : parseCloudCursor(command.priorSignedRemoteCursor, "priorSignedRemoteCursor");
  const response = parseWithSchema(CloudSyncPullResponseSchema, command.response);
  const receivedAt = parseTimestamp(command.receivedAt, "receivedAt");
  if (
    priorSignedRemoteCursor === response.nextCursor &&
    (response.hasMore ||
      response.operations.length > 0 ||
      response.chunks.length > 0 ||
      response.tombstones.length > 0)
  ) {
    throw validationError(
      "An unchanged remote cursor is only valid for an empty completed pull page.",
    );
  }
  const operationIds = new Set<string>();
  const chunkOwners = new Map<string, SyncOperationContract>();
  for (const operation of response.operations) {
    if (operation.projectId !== projectId || operationIds.has(operation.operationId)) {
      throw validationError("An incoming sync operation is duplicated or outside the project.");
    }
    operationIds.add(operation.operationId);
    toCoreOperation(operation);
    for (const chunkId of operation.encryptedChunkIds) {
      if (chunkOwners.has(chunkId)) {
        throw validationError("An incoming ciphertext chunk has more than one operation owner.");
      }
      chunkOwners.set(chunkId, operation);
    }
  }

  const chunksById = new Map<string, StoredEncryptedChunk>();
  for (const upload of response.chunks) {
    if (chunksById.has(upload.chunkId)) {
      throw validationError("Incoming ciphertext chunk identifiers must be unique.");
    }
    const chunk: StoredEncryptedChunk = {
      chunkId: parseUuid(upload.chunkId, "chunkId"),
      encrypted: parseWithSchema(EncryptedSyncChunkContractSchema, upload.encrypted),
      createdAt: receivedAt,
    };
    const owner = chunkOwners.get(chunk.chunkId);
    if (
      owner === undefined ||
      chunk.encrypted.aad.projectId !== projectId ||
      chunk.encrypted.aad.objectType !== owner.objectType ||
      chunk.encrypted.aad.objectId !== owner.objectId
    ) {
      throw validationError("Incoming ciphertext ownership does not match its operation.");
    }
    chunksById.set(chunk.chunkId, chunk);
  }
  if (
    chunksById.size !== chunkOwners.size ||
    [...chunkOwners.keys()].some((chunkId) => !chunksById.has(chunkId))
  ) {
    throw validationError("The incoming sync batch does not contain its exact ciphertext set.");
  }
  for (const operation of response.operations) {
    const ownedChunks = operation.encryptedChunkIds.map((chunkId) => {
      const chunk = chunksById.get(chunkId);
      if (chunk === undefined) {
        throw validationError("An incoming operation ciphertext chunk is missing.");
      }
      return chunk;
    });
    const first = ownedChunks[0];
    for (const [position, chunk] of ownedChunks.entries()) {
      if (
        chunk.encrypted.aad.chunkIndex !== position ||
        (first !== undefined &&
          (chunk.encrypted.aad.objectType !== first.encrypted.aad.objectType ||
            chunk.encrypted.aad.versionId !== first.encrypted.aad.versionId ||
            chunk.encrypted.aad.keyVersion !== first.encrypted.aad.keyVersion))
      ) {
        throw validationError("Incoming ciphertext chunk metadata is not a complete ordered set.");
      }
    }
  }
  await Promise.all([...chunksById.values()].map((chunk) => verifyEncryptedChunk(chunk)));

  const tombstonesByObject = new Map<string, SyncTombstoneContract>();
  for (const value of response.tombstones) {
    const tombstone = normalizeTombstone(value);
    const key = tombstoneKey(tombstone.objectType, tombstone.objectId, tombstone.objectGeneration);
    if (tombstone.projectId !== projectId || tombstonesByObject.has(key)) {
      throw validationError("An incoming tombstone is duplicated or outside the project.");
    }
    tombstonesByObject.set(key, tombstone);
  }
  for (const operation of response.operations) {
    const key = tombstoneKey(operation.objectType, operation.objectId, operation.objectGeneration);
    const tombstone = tombstonesByObject.get(key);
    if (operation.kind === "delete") {
      if (tombstone === undefined) {
        throw validationError("An incoming delete operation does not carry its exact tombstone.");
      }
      if (
        tombstone.deletedByDeviceId !== operation.deviceId ||
        canonicalJson(tombstone.vector) !== canonicalJson(operation.vector)
      ) {
        throw validationError("An incoming delete operation does not carry its exact tombstone.");
      }
      tombstonesByObject.delete(key);
    } else if (tombstone !== undefined) {
      throw validationError("Only incoming delete operations can carry tombstones.");
    }
  }
  if (tombstonesByObject.size !== 0) {
    throw validationError("An incoming tombstone has no matching delete operation.");
  }

  const semanticResponse = {
    schemaVersion: response.schemaVersion,
    operations: response.operations,
    chunks: response.chunks,
    tombstones: response.tombstones,
    nextCursor: response.nextCursor,
    hasMore: response.hasMore,
  };
  const responseDigest = await sha256Hex(canonicalJson(semanticResponse));
  const batchId = await sha256Hex(
    `inkshadow/local-sync-incoming/v1\u0000${projectId}\u0000${
      priorSignedRemoteCursor ?? ""
    }\u0000${responseDigest}`,
  );
  return {
    projectId,
    priorSignedRemoteCursor,
    response,
    receivedAt,
    chunks: [...chunksById.values()],
    responseDigest,
    batchId,
  };
}

function isStableEmptyPull(command: NormalizedIncomingBatch): boolean {
  return (
    command.priorSignedRemoteCursor === command.response.nextCursor &&
    !command.response.hasMore &&
    command.response.operations.length === 0 &&
    command.response.chunks.length === 0 &&
    command.response.tombstones.length === 0
  );
}

function normalizeSnapshotIdentity(value: {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
}): NormalizedSnapshotIdentity {
  return {
    snapshotId: parseSnapshotIdentifier(value.snapshotId),
    projectId: parseUuid(value.projectId, "projectId"),
    epoch: parsePositiveSafeInteger(value.epoch, "epoch"),
  };
}

function snapshotSessionFromFirstPage(
  command: NormalizedSnapshotPage,
  checkpoint: SyncRemoteCheckpoint,
): SnapshotSessionDbRow {
  return {
    snapshot_id: command.snapshotId,
    project_id: command.projectId,
    epoch: command.epoch,
    state: "staging",
    base_signed_remote_cursor: checkpoint.signedRemoteCursor,
    base_checkpoint_revision: checkpoint.revision,
    base_checkpoint_updated_at: checkpoint.updatedAt,
    snapshot_signed_remote_cursor: command.snapshotSignedRemoteCursor,
    snapshot_expires_at: command.snapshotExpiresAt,
    next_page_index: 1,
    next_snapshot_cursor: command.nextSnapshotCursor,
    pages_complete: command.nextSnapshotCursor === null ? 1 : 0,
    final_signed_remote_cursor: command.finalSignedRemoteCursor,
    total_operation_count: command.operations.length,
    total_chunk_count: command.chunks.length,
    total_tombstone_count: command.tombstones.length,
    committed_checkpoint_revision: null,
    created_at: command.receivedAt,
    updated_at: command.receivedAt,
    committed_at: null,
  };
}

function advanceSnapshotSession(
  session: SnapshotSessionDbRow,
  command: NormalizedSnapshotPage,
): SnapshotSessionDbRow {
  return {
    ...session,
    next_page_index: incrementSafeInteger(
      session.next_page_index,
      "The snapshot page sequence is exhausted.",
    ),
    next_snapshot_cursor: command.nextSnapshotCursor,
    pages_complete: command.nextSnapshotCursor === null ? 1 : 0,
    final_signed_remote_cursor: command.finalSignedRemoteCursor,
    total_operation_count: addSafeInteger(
      session.total_operation_count,
      command.operations.length,
      "The snapshot operation count is exhausted.",
    ),
    total_chunk_count: addSafeInteger(
      session.total_chunk_count,
      command.chunks.length,
      "The snapshot chunk count is exhausted.",
    ),
    total_tombstone_count: addSafeInteger(
      session.total_tombstone_count,
      command.tombstones.length,
      "The snapshot tombstone count is exhausted.",
    ),
    updated_at: command.receivedAt,
  };
}

async function insertSnapshotSession(
  executor: TransactionExecutor,
  session: SnapshotSessionDbRow,
): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_snapshot_staging_sessions (
       snapshot_id,
       project_id,
       epoch,
       state,
       base_signed_remote_cursor,
       base_checkpoint_revision,
       base_checkpoint_updated_at,
       snapshot_signed_remote_cursor,
       snapshot_expires_at,
       next_page_index,
       next_snapshot_cursor,
       pages_complete,
       final_signed_remote_cursor,
       total_operation_count,
       total_chunk_count,
       total_tombstone_count,
       committed_checkpoint_revision,
       created_at,
       updated_at,
       committed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.snapshot_id,
      session.project_id,
      session.epoch,
      session.state,
      session.base_signed_remote_cursor,
      session.base_checkpoint_revision,
      session.base_checkpoint_updated_at,
      session.snapshot_signed_remote_cursor,
      session.snapshot_expires_at,
      session.next_page_index,
      session.next_snapshot_cursor,
      session.pages_complete,
      session.final_signed_remote_cursor,
      session.total_operation_count,
      session.total_chunk_count,
      session.total_tombstone_count,
      session.committed_checkpoint_revision,
      session.created_at,
      session.updated_at,
      session.committed_at,
    ],
  );
}

async function insertSnapshotPage(
  executor: TransactionExecutor,
  command: NormalizedSnapshotPage,
): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_snapshot_staging_pages (
       snapshot_id,
       page_index,
       resume_cursor,
       snapshot_signed_remote_cursor,
       snapshot_expires_at,
       next_snapshot_cursor,
       final_signed_remote_cursor,
       response_digest,
       operation_count,
       chunk_count,
       tombstone_count,
       received_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      command.snapshotId,
      command.pageIndex,
      command.resumeCursor,
      command.snapshotSignedRemoteCursor,
      command.snapshotExpiresAt,
      command.nextSnapshotCursor,
      command.finalSignedRemoteCursor,
      command.pageDigest,
      command.operations.length,
      command.chunks.length,
      command.tombstones.length,
      command.receivedAt,
    ],
  );
}

async function insertSnapshotPayload(
  executor: TransactionExecutor,
  command: NormalizedSnapshotPage,
): Promise<void> {
  for (const [position, operation] of command.operations.entries()) {
    await executor.execute(
      `INSERT INTO sync_snapshot_staging_operations (
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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        command.snapshotId,
        command.pageIndex,
        position,
        operation.operationId,
        operation.projectId,
        operation.deviceId,
        operation.deviceSequence,
        operation.objectType,
        operation.objectId,
        operation.objectGeneration,
        operation.kind,
        JSON.stringify(operation.vector),
        operation.createdAt,
      ],
    );
  }
  for (const chunk of command.chunks) {
    const encrypted = chunk.encrypted;
    await executor.execute(
      `INSERT INTO sync_snapshot_staging_chunks (
         snapshot_id,
         page_index,
         chunk_id,
         project_id,
         object_type,
         object_id,
         version_id,
         chunk_index,
         key_version,
         algorithm,
         nonce,
         ciphertext,
         ciphertext_sha256,
         plaintext_bytes,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        command.snapshotId,
        command.pageIndex,
        chunk.chunkId,
        encrypted.aad.projectId,
        encrypted.aad.objectType,
        encrypted.aad.objectId,
        encrypted.aad.versionId,
        encrypted.aad.chunkIndex,
        encrypted.aad.keyVersion,
        encrypted.algorithm,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.ciphertextSha256,
        encrypted.plaintextBytes,
        chunk.createdAt,
      ],
    );
  }
  for (const operation of command.operations) {
    for (const [position, chunkId] of operation.encryptedChunkIds.entries()) {
      await executor.execute(
        `INSERT INTO sync_snapshot_staging_operation_chunks (
           snapshot_id,
           operation_id,
           chunk_id,
           position
         ) VALUES (?, ?, ?, ?)`,
        [command.snapshotId, operation.operationId, chunkId, position],
      );
    }
  }
  for (const [position, tombstone] of command.tombstones.entries()) {
    await executor.execute(
      `INSERT INTO sync_snapshot_staging_tombstones (
         snapshot_id,
         page_index,
         tombstone_position,
         project_id,
         object_type,
         object_id,
         object_generation,
         deleted_by_device_id,
         vector_json,
         deleted_at,
         retain_until,
         acknowledged_device_ids_json,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        command.snapshotId,
        command.pageIndex,
        position,
        tombstone.projectId,
        tombstone.objectType,
        tombstone.objectId,
        tombstone.objectGeneration,
        tombstone.deletedByDeviceId,
        JSON.stringify(tombstone.vector),
        tombstone.deletedAt,
        tombstone.retainUntil,
        JSON.stringify(tombstone.acknowledgedDeviceIds),
        command.receivedAt,
      ],
    );
  }
}

async function findSnapshotSessionById(
  executor: TransactionExecutor,
  snapshotId: string,
): Promise<SnapshotSessionDbRow | null> {
  const rows = await executor.select<SnapshotSessionDbRow>(
    "SELECT * FROM sync_snapshot_staging_sessions WHERE snapshot_id = ? LIMIT 1",
    [snapshotId],
  );
  return rows[0] ?? null;
}

async function findSnapshotSessionByProject(
  executor: TransactionExecutor,
  projectId: string,
): Promise<SnapshotSessionDbRow | null> {
  const rows = await executor.select<SnapshotSessionDbRow>(
    "SELECT * FROM sync_snapshot_staging_sessions WHERE project_id = ? LIMIT 1",
    [projectId],
  );
  return rows[0] ?? null;
}

async function findSnapshotPage(
  executor: TransactionExecutor,
  snapshotId: string,
  pageIndex: number,
): Promise<SnapshotPageDbRow | null> {
  const rows = await executor.select<SnapshotPageDbRow>(
    `SELECT *
     FROM sync_snapshot_staging_pages
     WHERE snapshot_id = ? AND page_index = ?
     LIMIT 1`,
    [snapshotId, pageIndex],
  );
  return rows[0] ?? null;
}

function sameSnapshotPage(row: SnapshotPageDbRow, command: NormalizedSnapshotPage): boolean {
  return (
    row.snapshot_id === command.snapshotId &&
    row.page_index === command.pageIndex &&
    row.resume_cursor === command.resumeCursor &&
    row.snapshot_signed_remote_cursor === command.snapshotSignedRemoteCursor &&
    row.snapshot_expires_at === command.snapshotExpiresAt &&
    row.next_snapshot_cursor === command.nextSnapshotCursor &&
    row.final_signed_remote_cursor === command.finalSignedRemoteCursor &&
    row.response_digest === command.pageDigest &&
    row.operation_count === command.operations.length &&
    row.chunk_count === command.chunks.length &&
    row.tombstone_count === command.tombstones.length
  );
}

function isSnapshotStagingUniquenessViolation(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("UNIQUE constraint failed: sync_snapshot_staging_")
  );
}

function rehydrateSnapshotSummary(row: SnapshotSessionDbRow): SyncSnapshotStagingSummary {
  try {
    const snapshotId = parseSnapshotIdentifier(row.snapshot_id);
    const projectId = parseUuid(row.project_id, "projectId");
    const epoch = parsePositiveSafeInteger(row.epoch, "epoch");
    if (row.state !== "staging" && row.state !== "committed") {
      throw repositoryCorruptionError("Stored snapshot staging state is invalid.");
    }
    const baseSignedRemoteCursor =
      row.base_signed_remote_cursor === null
        ? null
        : parseCloudCursor(row.base_signed_remote_cursor, "baseSignedRemoteCursor");
    const baseCheckpointRevision = parseNonNegativeRevision(row.base_checkpoint_revision);
    const baseCheckpointUpdatedAt =
      row.base_checkpoint_updated_at === null
        ? null
        : parseTimestamp(row.base_checkpoint_updated_at, "baseCheckpointUpdatedAt");
    if (
      (baseCheckpointRevision === 0 &&
        (baseSignedRemoteCursor !== null || baseCheckpointUpdatedAt !== null)) ||
      (baseCheckpointRevision > 0 &&
        (baseSignedRemoteCursor === null || baseCheckpointUpdatedAt === null))
    ) {
      throw repositoryCorruptionError("Stored snapshot base checkpoint is inconsistent.");
    }
    const pagesComplete = row.pages_complete === 1;
    if (!pagesComplete && row.pages_complete !== 0) {
      throw repositoryCorruptionError("Stored snapshot completion state is invalid.");
    }
    return {
      snapshotId,
      projectId,
      epoch,
      state: row.state,
      baseCheckpoint: {
        projectId,
        signedRemoteCursor: baseSignedRemoteCursor,
        revision: baseCheckpointRevision,
        updatedAt: baseCheckpointUpdatedAt,
      },
      snapshotSignedRemoteCursor: parseCloudCursor(
        row.snapshot_signed_remote_cursor,
        "snapshotSignedRemoteCursor",
      ),
      snapshotExpiresAt: parseTimestamp(row.snapshot_expires_at, "snapshotExpiresAt"),
      nextPageIndex: parsePositiveSafeInteger(row.next_page_index, "nextPageIndex"),
      nextSnapshotCursor:
        row.next_snapshot_cursor === null
          ? null
          : parseCloudCursor(row.next_snapshot_cursor, "nextSnapshotCursor"),
      pagesComplete,
      finalSignedRemoteCursor:
        row.final_signed_remote_cursor === null
          ? null
          : parseCloudCursor(row.final_signed_remote_cursor, "finalSignedRemoteCursor"),
      operationCount: parseNonNegativeSafeInteger(row.total_operation_count, "operationCount"),
      chunkCount: parseNonNegativeSafeInteger(row.total_chunk_count, "chunkCount"),
      tombstoneCount: parseNonNegativeSafeInteger(row.total_tombstone_count, "tombstoneCount"),
      committedCheckpointRevision:
        row.committed_checkpoint_revision === null
          ? null
          : parsePositiveRevision(row.committed_checkpoint_revision),
      createdAt: parseTimestamp(row.created_at, "createdAt"),
      updatedAt: parseTimestamp(row.updated_at, "updatedAt"),
      committedAt:
        row.committed_at === null ? null : parseTimestamp(row.committed_at, "committedAt"),
    };
  } catch (cause: unknown) {
    if (cause instanceof AppError && cause.details.operation === "SYNC_LOCAL_RECORD_INVALID") {
      throw cause;
    }
    throw repositoryCorruptionError("Stored snapshot staging metadata is invalid.");
  }
}

function requireSnapshotIdentity(
  session: SnapshotSessionDbRow,
  identity: NormalizedSnapshotIdentity,
): void {
  if (
    session.snapshot_id !== identity.snapshotId ||
    session.project_id !== identity.projectId ||
    session.epoch !== identity.epoch
  ) {
    throw concurrencyError("The snapshot commit identity does not match the staged project epoch.");
  }
}

function committedSnapshotReceipt(
  session: SnapshotSessionDbRow,
  replayed: boolean,
): CommitSyncSnapshotReceipt {
  const summary = rehydrateSnapshotSummary(session);
  if (
    summary.state !== "committed" ||
    summary.finalSignedRemoteCursor === null ||
    summary.committedCheckpointRevision === null ||
    summary.committedAt === null
  ) {
    throw repositoryCorruptionError("The committed snapshot receipt is incomplete.");
  }
  return {
    snapshotId: summary.snapshotId,
    projectId: summary.projectId,
    epoch: summary.epoch,
    operationCount: summary.operationCount,
    chunkCount: summary.chunkCount,
    tombstoneCount: summary.tombstoneCount,
    checkpoint: {
      projectId: summary.projectId,
      signedRemoteCursor: summary.finalSignedRemoteCursor,
      revision: summary.committedCheckpointRevision,
      updatedAt: summary.committedAt,
    },
    replayed,
  };
}

async function verifySnapshotStagingCounts(
  executor: TransactionExecutor,
  session: SnapshotSessionDbRow,
): Promise<void> {
  const [pageRows, operationRows, chunkRows, linkRows, tombstoneRows, outsideRows] =
    await Promise.all([
      executor.select<CountDbRow>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_pages WHERE snapshot_id = ?",
        [session.snapshot_id],
      ),
      executor.select<CountDbRow>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_operations WHERE snapshot_id = ?",
        [session.snapshot_id],
      ),
      executor.select<CountDbRow>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_chunks WHERE snapshot_id = ?",
        [session.snapshot_id],
      ),
      executor.select<CountDbRow>(
        `SELECT count(*) AS count
         FROM sync_snapshot_staging_operation_chunks
         WHERE snapshot_id = ?`,
        [session.snapshot_id],
      ),
      executor.select<CountDbRow>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_tombstones WHERE snapshot_id = ?",
        [session.snapshot_id],
      ),
      executor.select<CountDbRow>(
        `SELECT
           (
             SELECT count(*)
             FROM sync_snapshot_staging_operations
             WHERE snapshot_id = ? AND project_id <> ?
           )
           + (
             SELECT count(*)
             FROM sync_snapshot_staging_chunks
             WHERE snapshot_id = ? AND project_id <> ?
           )
           + (
             SELECT count(*)
             FROM sync_snapshot_staging_tombstones
             WHERE snapshot_id = ? AND project_id <> ?
           ) AS count`,
        [
          session.snapshot_id,
          session.project_id,
          session.snapshot_id,
          session.project_id,
          session.snapshot_id,
          session.project_id,
        ],
      ),
    ]);
  if (
    pageRows[0]?.count !== session.next_page_index ||
    operationRows[0]?.count !== session.total_operation_count ||
    chunkRows[0]?.count !== session.total_chunk_count ||
    linkRows[0]?.count !== session.total_chunk_count ||
    tombstoneRows[0]?.count !== session.total_tombstone_count ||
    outsideRows[0]?.count !== 0
  ) {
    throw repositoryCorruptionError("The staged snapshot payload counts are inconsistent.");
  }
}

async function requireSnapshotCommitQuiescence(
  executor: TransactionExecutor,
  projectId: string,
): Promise<void> {
  const [outboxRows, incomingRows] = await Promise.all([
    executor.select<CountDbRow>(
      `SELECT count(*) AS count
       FROM sync_outbox_operations
       WHERE project_id = ? AND status <> 'acknowledged'`,
      [projectId],
    ),
    executor.select<CountDbRow>(
      `SELECT count(*) AS count
       FROM sync_inbox_operations
       WHERE project_id = ? AND status <> 'applied'`,
      [projectId],
    ),
  ]);
  if (outboxRows[0]?.count !== 0) {
    throw concurrencyError(
      "A snapshot cannot commit while the project has unacknowledged outgoing work.",
    );
  }
  if (incomingRows[0]?.count !== 0) {
    throw concurrencyError(
      "A snapshot cannot commit while incoming work or conflicts remain unresolved.",
    );
  }
}

async function verifyStagedSnapshotChunks(
  executor: TransactionExecutor,
  snapshotId: string,
): Promise<void> {
  const rows = await executor.select<CiphertextChunkDbRow>(
    `SELECT
       chunk_id,
       project_id,
       object_type,
       object_id,
       version_id,
       chunk_index,
       key_version,
       algorithm,
       nonce,
       ciphertext,
       ciphertext_sha256,
       plaintext_bytes,
       created_at
     FROM sync_snapshot_staging_chunks
     WHERE snapshot_id = ?
     ORDER BY page_index, chunk_id`,
    [snapshotId],
  );
  for (const row of rows) {
    await verifyEncryptedChunk(rehydrateChunk(row), repositoryCorruptionError);
  }
}

async function copySnapshotChunksToBaseline(
  executor: TransactionExecutor,
  snapshotId: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_ciphertext_chunks (
       chunk_id,
       project_id,
       object_type,
       object_id,
       version_id,
       chunk_index,
       key_version,
       algorithm,
       nonce,
       ciphertext,
       ciphertext_sha256,
       plaintext_bytes,
       created_at
     )
     SELECT
       chunk_id,
       project_id,
       object_type,
       object_id,
       version_id,
       chunk_index,
       key_version,
       algorithm,
       nonce,
       ciphertext,
       ciphertext_sha256,
       plaintext_bytes,
       created_at
     FROM sync_snapshot_staging_chunks
     WHERE snapshot_id = ?`,
    [snapshotId],
  );
}

async function copySnapshotTombstonesToBaseline(
  executor: TransactionExecutor,
  snapshotId: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_tombstones (
       project_id,
       object_type,
       object_id,
       object_generation,
       deleted_by_device_id,
       vector_json,
       deleted_at,
       retain_until,
       acknowledged_device_ids_json,
       updated_at
     )
     SELECT
       project_id,
       object_type,
       object_id,
       object_generation,
       deleted_by_device_id,
       vector_json,
       deleted_at,
       retain_until,
       acknowledged_device_ids_json,
       updated_at
     FROM sync_snapshot_staging_tombstones
     WHERE snapshot_id = ?`,
    [snapshotId],
  );
}

function normalizeCheckpointCommand(
  command: CompareAndSwapRemoteCheckpointCommand,
): CompareAndSwapRemoteCheckpointCommand {
  const expectedRevision = parseNonNegativeRevision(command.expectedRevision);
  const expectedSignedRemoteCursor =
    command.expectedSignedRemoteCursor === null
      ? null
      : parseCloudCursor(command.expectedSignedRemoteCursor, "expectedSignedRemoteCursor");
  if (
    (expectedRevision === 0 && expectedSignedRemoteCursor !== null) ||
    (expectedRevision > 0 && expectedSignedRemoteCursor === null)
  ) {
    throw validationError("The remote checkpoint revision and cursor are inconsistent.");
  }
  return {
    projectId: parseUuid(command.projectId, "projectId"),
    expectedRevision,
    expectedSignedRemoteCursor,
    nextSignedRemoteCursor: parseCloudCursor(
      command.nextSignedRemoteCursor,
      "nextSignedRemoteCursor",
    ),
    now: parseTimestamp(command.now, "now"),
  };
}

async function compareAndSwapRemoteCheckpoint(
  executor: TransactionExecutor,
  command: CompareAndSwapRemoteCheckpointCommand,
): Promise<SyncRemoteCheckpoint> {
  const existing = await findRemoteCheckpointRow(executor, command.projectId);
  if (existing === null) {
    if (command.expectedRevision !== 0 || command.expectedSignedRemoteCursor !== null) {
      throw concurrencyError("The remote sync checkpoint no longer matches its expected state.");
    }
    await executor.execute(
      `INSERT INTO sync_remote_checkpoints (
        project_id,
        signed_remote_cursor,
        revision,
        updated_at
      ) VALUES (?, ?, 1, ?)`,
      [command.projectId, command.nextSignedRemoteCursor, command.now],
    );
    return {
      projectId: command.projectId,
      signedRemoteCursor: command.nextSignedRemoteCursor,
      revision: 1,
      updatedAt: command.now,
    };
  }
  if (
    existing.revision !== command.expectedRevision ||
    existing.signed_remote_cursor !== command.expectedSignedRemoteCursor
  ) {
    throw concurrencyError("The remote sync checkpoint no longer matches its expected state.");
  }
  const revision = incrementSafeInteger(
    existing.revision,
    "The remote sync checkpoint revision is exhausted.",
  );
  const updated = await executor.execute(
    `UPDATE sync_remote_checkpoints
     SET signed_remote_cursor = ?, revision = ?, updated_at = ?
     WHERE project_id = ? AND revision = ? AND signed_remote_cursor = ?`,
    [
      command.nextSignedRemoteCursor,
      revision,
      command.now,
      command.projectId,
      existing.revision,
      existing.signed_remote_cursor,
    ],
  );
  if (updated.rowsAffected !== 1) {
    throw concurrencyError("The remote sync checkpoint changed during comparison and swap.");
  }
  return {
    projectId: command.projectId,
    signedRemoteCursor: command.nextSignedRemoteCursor,
    revision,
    updatedAt: command.now,
  };
}

async function findRemoteCheckpointRow(
  executor: TransactionExecutor,
  projectId: string,
): Promise<RemoteCheckpointDbRow | null> {
  const rows = await executor.select<RemoteCheckpointDbRow>(
    `SELECT project_id, signed_remote_cursor, revision, updated_at
     FROM sync_remote_checkpoints
     WHERE project_id = ?
     LIMIT 1`,
    [projectId],
  );
  return rows[0] ?? null;
}

function rehydrateRemoteCheckpoint(
  projectId: string,
  row: RemoteCheckpointDbRow | null,
): SyncRemoteCheckpoint {
  if (row === null) {
    return { projectId, signedRemoteCursor: null, revision: 0, updatedAt: null };
  }
  try {
    return {
      projectId: parseUuid(row.project_id, "projectId"),
      signedRemoteCursor: parseCloudCursor(row.signed_remote_cursor, "signedRemoteCursor"),
      revision: parsePositiveRevision(row.revision),
      updatedAt: parseTimestamp(row.updated_at, "updatedAt"),
    };
  } catch {
    throw repositoryCorruptionError("Stored remote sync checkpoint metadata is invalid.");
  }
}

async function findDeviceSequenceRow(
  executor: TransactionExecutor,
  projectId: string,
  deviceId: string,
): Promise<DeviceSequenceDbRow | null> {
  const rows = await executor.select<DeviceSequenceDbRow>(
    `SELECT project_id, device_id, last_allocated_sequence, revision, updated_at
     FROM sync_device_sequences
     WHERE project_id = ? AND device_id = ?
     LIMIT 1`,
    [projectId, deviceId],
  );
  return rows[0] ?? null;
}

async function observeDeviceSequence(
  executor: TransactionExecutor,
  projectId: string,
  deviceId: string,
  sequence: number,
  now: string,
): Promise<void> {
  const row = await findDeviceSequenceRow(executor, projectId, deviceId);
  if (row === null) {
    await executor.execute(
      `INSERT INTO sync_device_sequences (
        project_id,
        device_id,
        last_allocated_sequence,
        revision,
        updated_at
      ) VALUES (?, ?, ?, 1, ?)`,
      [projectId, deviceId, sequence, now],
    );
    return;
  }
  if (row.last_allocated_sequence >= sequence) {
    return;
  }
  const revision = incrementSafeInteger(
    row.revision,
    "The sync device sequence revision is exhausted.",
  );
  const updated = await executor.execute(
    `UPDATE sync_device_sequences
     SET last_allocated_sequence = ?, revision = ?, updated_at = ?
     WHERE project_id = ? AND device_id = ? AND revision = ?`,
    [sequence, revision, now, projectId, deviceId, row.revision],
  );
  if (updated.rowsAffected !== 1) {
    throw concurrencyError("The sync device sequence changed while observing remote work.");
  }
}

async function findIncomingBatchByCursor(
  executor: TransactionExecutor,
  projectId: string,
  cursor: string,
): Promise<IncomingBatchDbRow | null> {
  const rows = await executor.select<IncomingBatchDbRow>(
    `SELECT
       batch_id,
       project_id,
       prior_signed_remote_cursor,
       next_signed_remote_cursor,
       response_digest,
       request_id,
       has_more,
       operation_count,
       chunk_count,
       tombstone_count,
       received_at
     FROM sync_incoming_batches
     WHERE project_id = ? AND next_signed_remote_cursor = ?
     LIMIT 1`,
    [projectId, cursor],
  );
  return rows[0] ?? null;
}

async function recordOrVerifyIncrementalTerminalObservation(
  transaction: TransactionExecutor,
  command: NormalizedIncomingBatch,
  checkpoint: SyncRemoteCheckpoint,
): Promise<void> {
  if (
    checkpoint.revision < 1 ||
    checkpoint.signedRemoteCursor === null ||
    checkpoint.signedRemoteCursor !== command.response.nextCursor
  ) {
    throw concurrencyError(
      "The empty terminal pull is not bound to an exact downloaded checkpoint.",
    );
  }
  const existingRows = await transaction.select<IncrementalTerminalObservationDbRow>(
    `SELECT
       project_id,
       signed_remote_cursor,
       downloaded_checkpoint_revision,
       response_digest
     FROM sync_incremental_terminal_observations
     WHERE project_id = ? AND downloaded_checkpoint_revision = ?
     LIMIT 1`,
    [command.projectId, checkpoint.revision],
  );
  const existing = existingRows[0];
  if (existing !== undefined) {
    if (
      existing.project_id !== command.projectId ||
      existing.signed_remote_cursor !== command.response.nextCursor ||
      existing.downloaded_checkpoint_revision !== checkpoint.revision ||
      existing.response_digest !== command.responseDigest
    ) {
      throw concurrencyError(
        "The downloaded checkpoint is already bound to a different terminal pull observation.",
      );
    }
    return;
  }
  await transaction.execute(
    `INSERT INTO sync_incremental_terminal_observations (
       project_id,
       signed_remote_cursor,
       downloaded_checkpoint_revision,
       response_digest,
       request_id,
       observed_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      command.projectId,
      command.response.nextCursor,
      checkpoint.revision,
      command.responseDigest,
      command.response.requestId,
      command.receivedAt,
    ],
  );
}

function sameIncomingBatch(row: IncomingBatchDbRow, command: NormalizedIncomingBatch): boolean {
  return (
    row.batch_id === command.batchId &&
    row.project_id === command.projectId &&
    row.prior_signed_remote_cursor === command.priorSignedRemoteCursor &&
    row.next_signed_remote_cursor === command.response.nextCursor &&
    row.response_digest === command.responseDigest &&
    row.has_more === (command.response.hasMore ? 1 : 0) &&
    row.operation_count === command.response.operations.length &&
    row.chunk_count === command.response.chunks.length &&
    row.tombstone_count === command.response.tombstones.length
  );
}

function incomingBatchReceipt(
  row: IncomingBatchDbRow,
  created: boolean,
  checkpoint: SyncRemoteCheckpoint,
): StageIncomingSyncBatchReceipt {
  return {
    batchId: requireSha256(row.batch_id, "batch identifier"),
    created,
    operationCount: requireBoundedCount(row.operation_count, 256),
    chunkCount: requireBoundedCount(row.chunk_count, 10_000),
    tombstoneCount: requireBoundedCount(row.tombstone_count, 256),
    checkpoint,
  };
}

async function stageIncomingTombstone(
  executor: TransactionExecutor,
  value: SyncTombstoneContract,
  now: string,
): Promise<void> {
  const incoming = toCoreTombstone(normalizeTombstone(value));
  const rows = await executor.select<TombstoneDbRow>(
    `SELECT
       project_id,
       object_type,
       object_id,
       object_generation,
       deleted_by_device_id,
       vector_json,
       deleted_at,
       retain_until,
       acknowledged_device_ids_json,
       updated_at
     FROM sync_tombstones
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?
     LIMIT 1`,
    [incoming.projectId, incoming.objectType, incoming.objectId, incoming.objectGeneration],
  );
  const existingRow = rows[0];
  if (existingRow === undefined) {
    await executor.execute(
      `INSERT INTO sync_tombstones (
        project_id,
        object_type,
        object_id,
        object_generation,
        deleted_by_device_id,
        vector_json,
        deleted_at,
        retain_until,
        acknowledged_device_ids_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        incoming.projectId,
        incoming.objectType,
        incoming.objectId,
        incoming.objectGeneration,
        incoming.deletedByDeviceId,
        JSON.stringify(incoming.vector),
        incoming.deletedAt,
        incoming.retainUntil,
        JSON.stringify(incoming.acknowledgedDeviceIds),
        now,
      ],
    );
    return;
  }
  const existing = rehydrateTombstone(existingRow);
  if (!sameTombstoneAuthority(existing, incoming)) {
    throw concurrencyError("A local tombstone identifier is bound to different remote metadata.");
  }
  const acknowledgements = [
    ...new Set([...existing.acknowledgedDeviceIds, ...incoming.acknowledgedDeviceIds]),
  ].sort();
  await executor.execute(
    `UPDATE sync_tombstones
     SET acknowledged_device_ids_json = ?, updated_at = ?
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?`,
    [
      JSON.stringify(acknowledgements),
      now,
      incoming.projectId,
      incoming.objectType,
      incoming.objectId,
      incoming.objectGeneration,
    ],
  );
}

function sameTombstoneAuthority(
  left: SyncTombstoneSnapshot,
  right: SyncTombstoneSnapshot,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.objectType === right.objectType &&
    left.objectId === right.objectId &&
    left.objectGeneration === right.objectGeneration &&
    left.deletedByDeviceId === right.deletedByDeviceId &&
    canonicalJson(left.vector) === canonicalJson(right.vector) &&
    left.deletedAt === right.deletedAt &&
    left.retainUntil === right.retainUntil
  );
}

function normalizeIncomingClaimCommand(
  command: ClaimIncomingSyncWorkCommand,
): ClaimIncomingSyncWorkCommand {
  const now = parseTimestamp(command.now, "now");
  const leaseExpiresAt = parseTimestamp(command.leaseExpiresAt, "leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw validationError("An incoming sync work lease must expire in the future.");
  }
  return {
    projectId: parseUuid(command.projectId, "projectId"),
    ownerId: parseUuid(command.ownerId, "ownerId"),
    leaseToken: parseUuid(command.leaseToken, "leaseToken"),
    now,
    leaseExpiresAt,
  };
}

function normalizeIncomingResolutionCommand(
  command: ResolveIncomingSyncWorkCommand,
): ResolveIncomingSyncWorkCommand {
  return {
    operationId: parseUuid(command.operationId, "operationId"),
    leaseToken: parseUuid(command.leaseToken, "leaseToken"),
    now: parseTimestamp(command.now, "now"),
  };
}

function normalizeAtomicIncomingResolution(value: unknown): AtomicIncomingResolution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw validationError("The incoming sync resolution is invalid.");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.status === "applied" && Object.keys(candidate).length === 1) {
    return { status: "applied" };
  }
  if (
    candidate.status === "conflict" &&
    Object.keys(candidate).length === 2 &&
    typeof candidate.conflictCode === "string"
  ) {
    return {
      status: "conflict",
      conflictCode: parseResolutionCode(candidate.conflictCode, "conflictCode"),
    };
  }
  throw validationError("The incoming sync resolution is invalid.");
}

function requireCurrentIncomingLease(
  row: InboxOperationDbRow,
  command: ResolveIncomingSyncWorkCommand,
): void {
  if (
    row.status !== "applying" ||
    row.lease_token !== command.leaseToken ||
    row.lease_expires_at === null ||
    Date.parse(row.lease_expires_at) <= Date.parse(command.now)
  ) {
    throw concurrencyError("The incoming sync operation lease is no longer current.");
  }
}

async function writeIncomingResolution(
  transaction: TransactionExecutor,
  status: "applied" | "conflict" | "failed",
  command: ResolveIncomingSyncWorkCommand,
  conflictCode: string | null,
  failureCode: string | null,
  nextAttemptAt: string | null,
): Promise<void> {
  const updated = await transaction.execute(
    `UPDATE sync_inbox_operations
     SET
       status = ?,
       next_attempt_at = ?,
       lease_owner_id = NULL,
       lease_token = NULL,
       lease_expires_at = NULL,
       resolution_token = ?,
       conflict_code = ?,
       failure_code = ?,
       updated_at = ?,
       resolved_at = ?
     WHERE operation_id = ? AND status = 'applying' AND lease_token = ?`,
    [
      status,
      nextAttemptAt,
      command.leaseToken,
      conflictCode,
      failureCode,
      command.now,
      command.now,
      command.operationId,
      command.leaseToken,
    ],
  );
  if (updated.rowsAffected !== 1) {
    throw concurrencyError("The incoming sync operation lease is no longer current.");
  }
}

async function findInboxOperationById(
  executor: TransactionExecutor,
  operationId: string,
): Promise<InboxOperationDbRow | null> {
  const rows = await executor.select<InboxOperationDbRow>(
    `SELECT ${INBOX_COLUMNS}
     FROM sync_inbox_operations
     WHERE operation_id = ?
     LIMIT 1`,
    [operationId],
  );
  return rows[0] ?? null;
}

async function rehydrateIncomingWork(
  executor: TransactionExecutor,
  row: InboxOperationDbRow,
): Promise<IncomingSyncWork> {
  const mappingRows = await executor.select<OperationChunkDbRow>(
    `SELECT chunk_id, position
     FROM sync_inbox_operation_chunks
     WHERE operation_id = ?
     ORDER BY position ASC`,
    [row.operation_id],
  );
  try {
    const contract = parseWithSchema(SyncOperationContractSchema, {
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      operationId: row.operation_id,
      projectId: row.project_id,
      deviceId: row.device_id,
      deviceSequence: row.device_sequence,
      objectType: row.object_type,
      objectId: row.object_id,
      objectGeneration: row.object_generation,
      kind: requireOutboxKind(row.kind),
      vector: parseJsonObject(row.vector_json, "incoming version vector"),
      encryptedChunkIds: mappingRows.map(({ chunk_id }) => chunk_id),
      createdAt: row.operation_created_at,
    });
    const chunks = await Promise.all(
      mappingRows.map(async ({ chunk_id }) => {
        const chunkRow = await findChunkRow(executor, chunk_id);
        if (chunkRow === null) {
          throw repositoryCorruptionError("An incoming operation ciphertext chunk is missing.");
        }
        const chunk = rehydrateChunk(chunkRow);
        await verifyEncryptedChunk(chunk, repositoryCorruptionError);
        return chunk;
      }),
    );
    const firstChunk = chunks[0];
    for (const [position, chunk] of chunks.entries()) {
      if (
        chunk.encrypted.aad.projectId !== contract.projectId ||
        chunk.encrypted.aad.objectType !== contract.objectType ||
        chunk.encrypted.aad.objectId !== contract.objectId ||
        chunk.encrypted.aad.chunkIndex !== position ||
        (firstChunk !== undefined &&
          (chunk.encrypted.aad.objectType !== firstChunk.encrypted.aad.objectType ||
            chunk.encrypted.aad.versionId !== firstChunk.encrypted.aad.versionId ||
            chunk.encrypted.aad.keyVersion !== firstChunk.encrypted.aad.keyVersion))
      ) {
        throw repositoryCorruptionError(
          "Stored incoming ciphertext ownership does not match its operation.",
        );
      }
    }
    const tombstone =
      contract.kind === "delete"
        ? await findExactIncomingTombstone(
            executor,
            contract.projectId,
            contract.objectType,
            contract.objectId,
            contract.objectGeneration,
          )
        : null;
    if (contract.kind === "delete" && tombstone === null) {
      throw repositoryCorruptionError("An incoming delete operation tombstone is missing.");
    }
    const status = requireInboxStatus(row.status);
    if (!Number.isSafeInteger(row.attempt) || row.attempt < 0 || row.attempt > 100) {
      throw repositoryCorruptionError("Stored incoming sync attempt is invalid.");
    }
    return {
      operation: toCoreOperation(contract),
      chunks,
      tombstone,
      status,
      attempt: row.attempt,
      nextAttemptAt:
        row.next_attempt_at === null ? null : parseTimestamp(row.next_attempt_at, "nextAttemptAt"),
      failureCode: row.failure_code,
      conflictCode: row.conflict_code,
      resolvedAt: row.resolved_at === null ? null : parseTimestamp(row.resolved_at, "resolvedAt"),
    };
  } catch (cause: unknown) {
    if (cause instanceof AppError && cause.details.operation === "SYNC_LOCAL_RECORD_INVALID") {
      throw cause;
    }
    throw repositoryCorruptionError("Stored incoming sync work metadata is invalid.");
  }
}

async function findExactIncomingTombstone(
  executor: TransactionExecutor,
  projectId: string,
  objectType: SyncObjectType,
  objectId: string,
  objectGeneration: number,
): Promise<SyncTombstoneSnapshot | null> {
  const rows = await executor.select<TombstoneDbRow>(
    `SELECT
       project_id,
       object_type,
       object_id,
       object_generation,
       deleted_by_device_id,
       vector_json,
       deleted_at,
       retain_until,
       acknowledged_device_ids_json,
       updated_at
     FROM sync_tombstones
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?
     LIMIT 1`,
    [projectId, objectType, objectId, objectGeneration],
  );
  return rows[0] === undefined ? null : rehydrateTombstone(rows[0]);
}

function requireInboxStatus(value: string): SyncInboxStatus {
  if (!["received", "applying", "applied", "conflict", "failed"].includes(value)) {
    throw repositoryCorruptionError("Stored incoming sync status is invalid.");
  }
  return value as SyncInboxStatus;
}

function parseCloudCursor(value: string, field: string): string {
  const parsed = CloudCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be a bounded opaque signed cursor.`);
  }
  return parsed.data;
}

function parseSnapshotIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(value)) {
    throw validationError("snapshotId must be a bounded opaque identifier.");
  }
  return value;
}

function parseNonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validationError(`${field} must be a non-negative safe integer.`);
  }
  return value;
}

function parsePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function parseNonNegativeRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validationError("The remote checkpoint revision must be a non-negative safe integer.");
  }
  return value;
}

function parsePositiveRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError("The remote checkpoint revision must be a positive safe integer.");
  }
  return value;
}

function incrementSafeInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw concurrencyError(message);
  }
  return value + 1;
}

function addSafeInteger(left: number, right: number, message: string): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw concurrencyError(message);
  }
  return left + right;
}

function parseResolutionCode(value: string, field: string): string {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(value)) {
    throw validationError(`${field} must be a stable uppercase error code.`);
  }
  return value;
}

function tombstoneKey(
  objectType: SyncObjectType,
  objectId: string,
  objectGeneration: number,
): string {
  return `${objectType}:${objectId}:${String(objectGeneration)}`;
}

function requireSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw repositoryCorruptionError(`Stored ${label} is invalid.`);
  }
  return value;
}

function requireBoundedCount(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw repositoryCorruptionError("Stored incoming sync batch counts are invalid.");
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEnqueueInput(input: EnqueueSyncOperationInput): {
  readonly operation: SyncOperationContract;
  readonly chunks: readonly StoredEncryptedChunk[];
  readonly now: string;
} {
  const parsed = parseWithSchema(SyncOperationContractSchema, input.operation);
  const operation = {
    ...parsed,
    vector: toCoreOperation(parsed).vector,
    encryptedChunkIds: [...parsed.encryptedChunkIds],
  };
  const now = parseTimestamp(input.now, "now");
  const chunks = input.chunks.map((chunk) => ({
    chunkId: parseUuid(chunk.chunkId, "chunkId"),
    encrypted: parseWithSchema(EncryptedSyncChunkContractSchema, chunk.encrypted),
    createdAt: parseTimestamp(chunk.createdAt, "createdAt"),
  }));
  if (
    chunks.length !== operation.encryptedChunkIds.length ||
    new Set(chunks.map(({ chunkId }) => chunkId)).size !== chunks.length ||
    chunks.some((chunk) => !operation.encryptedChunkIds.includes(chunk.chunkId))
  ) {
    throw validationError("The operation ciphertext chunk set is incomplete or inconsistent.");
  }
  const chunksById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const orderedChunks = operation.encryptedChunkIds.map((chunkId) => {
    const chunk = chunksById.get(chunkId);
    if (chunk === undefined) {
      throw validationError("The operation ciphertext chunk set is incomplete.");
    }
    return chunk;
  });
  const firstChunk = orderedChunks[0];
  for (const [index, chunk] of orderedChunks.entries()) {
    if (
      chunk.encrypted.aad.projectId !== operation.projectId ||
      chunk.encrypted.aad.objectType !== operation.objectType ||
      chunk.encrypted.aad.objectId !== operation.objectId ||
      chunk.encrypted.aad.chunkIndex !== index ||
      (firstChunk !== undefined &&
        (chunk.encrypted.aad.objectType !== firstChunk.encrypted.aad.objectType ||
          chunk.encrypted.aad.versionId !== firstChunk.encrypted.aad.versionId ||
          chunk.encrypted.aad.keyVersion !== firstChunk.encrypted.aad.keyVersion))
    ) {
      throw validationError("Ciphertext metadata does not match the sync operation.");
    }
  }
  return { operation, chunks: orderedChunks, now };
}

async function enqueueNormalizedSyncOperation(
  transaction: TransactionExecutor,
  input: ReturnType<typeof normalizeEnqueueInput>,
): Promise<EnqueueSyncOperationReceipt> {
  const existing = await findOutboxById(transaction, input.operation.operationId);
  if (existing !== null) {
    const existingRecord = await rehydrateOutboxRecord(transaction, existing);
    if (!sameOperation(existingRecord.operation, toCoreOperation(input.operation))) {
      throw validationError("The operation identifier is already bound to other metadata.");
    }
    for (const chunk of input.chunks) {
      const stored = await findChunkRow(transaction, chunk.chunkId);
      if (stored === null || JSON.stringify(rehydrateChunk(stored)) !== JSON.stringify(chunk)) {
        throw validationError(
          "The existing operation ciphertext does not match the repeated request.",
        );
      }
    }
    return { operationId: input.operation.operationId, created: false };
  }

  for (const chunk of input.chunks) {
    await insertOrVerifyChunk(transaction, chunk);
  }
  await transaction.execute(
    `INSERT INTO sync_outbox_operations (
      operation_id,
      project_id,
      device_id,
      device_sequence,
      object_type,
      object_id,
      object_generation,
      kind,
      vector_json,
      status,
      attempt,
      next_attempt_at,
      lease_owner_id,
      lease_token,
      lease_expires_at,
      failure_code,
      acknowledged_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [
      input.operation.operationId,
      input.operation.projectId,
      input.operation.deviceId,
      input.operation.deviceSequence,
      input.operation.objectType,
      input.operation.objectId,
      input.operation.objectGeneration,
      input.operation.kind,
      JSON.stringify(input.operation.vector),
      input.now,
      input.operation.createdAt,
      input.now,
    ],
  );
  for (const [position, chunkId] of input.operation.encryptedChunkIds.entries()) {
    await transaction.execute(
      `INSERT INTO sync_operation_chunks (operation_id, chunk_id, position)
       VALUES (?, ?, ?)`,
      [input.operation.operationId, chunkId, position],
    );
  }
  return { operationId: input.operation.operationId, created: true };
}

async function saveNormalizedTombstone(
  transaction: TransactionExecutor,
  snapshot: SyncTombstoneContract,
  now: string,
): Promise<void> {
  const latest = await findLatestTombstoneRow(
    transaction,
    snapshot.projectId,
    snapshot.objectType,
    snapshot.objectId,
  );
  if (
    latest !== null &&
    (latest.object_generation > snapshot.objectGeneration ||
      (latest.object_generation === snapshot.objectGeneration &&
        !sameTombstone(rehydrateTombstone(latest), toCoreTombstone(snapshot))))
  ) {
    throw concurrencyError("A newer or different tombstone is already stored.");
  }
  if (latest?.object_generation === snapshot.objectGeneration) {
    return;
  }
  await transaction.execute(
    `INSERT INTO sync_tombstones (
       project_id, object_type, object_id, object_generation,
       deleted_by_device_id, vector_json, deleted_at, retain_until,
       acknowledged_device_ids_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.projectId,
      snapshot.objectType,
      snapshot.objectId,
      snapshot.objectGeneration,
      snapshot.deletedByDeviceId,
      JSON.stringify(snapshot.vector),
      snapshot.deletedAt,
      snapshot.retainUntil,
      JSON.stringify(snapshot.acknowledgedDeviceIds),
      now,
    ],
  );
}

function normalizeTombstone(value: SyncTombstoneContract): SyncTombstoneContract {
  const parsed = parseWithSchema(SyncTombstoneContractSchema, value);
  const snapshot = toCoreTombstone(parsed);
  return {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    ...snapshot,
    vector: { ...snapshot.vector },
    acknowledgedDeviceIds: [...snapshot.acknowledgedDeviceIds],
  };
}

function normalizeTransferManifest(value: ChunkTransferManifest): ChunkTransferManifest {
  try {
    new ChunkTransferLedger(value);
    return {
      transferId: parseUuid(value.transferId, "transferId"),
      projectId: parseUuid(value.projectId, "projectId"),
      objectId: parseUuid(value.objectId, "objectId"),
      versionId: parseUuid(value.versionId, "versionId"),
      chunks: [...value.chunks]
        .sort((left, right) => left.index - right.index)
        .map((chunk) => ({
          ...chunk,
          chunkId: parseUuid(chunk.chunkId, "chunkId"),
        })),
    };
  } catch {
    throw validationError("The ciphertext transfer manifest is invalid.");
  }
}

function normalizeClaimCommand(value: ClaimSyncOperationCommand): ClaimSyncOperationCommand {
  const now = parseTimestamp(value.now, "now");
  const leaseExpiresAt = parseTimestamp(value.leaseExpiresAt, "leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw validationError("A sync operation lease must expire in the future.");
  }
  return {
    ownerId: parseUuid(value.ownerId, "ownerId"),
    leaseToken: parseUuid(value.leaseToken, "leaseToken"),
    now,
    leaseExpiresAt,
  };
}

function normalizeRescheduleCommand(
  value: RescheduleSyncOperationCommand,
): RescheduleSyncOperationCommand {
  const now = parseTimestamp(value.now, "now");
  const nextAttemptAt = parseTimestamp(value.nextAttemptAt, "nextAttemptAt");
  if (Date.parse(nextAttemptAt) <= Date.parse(now)) {
    throw validationError("A sync retry must be scheduled in the future.");
  }
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.failureCode)) {
    throw validationError("The sync failure code is invalid.");
  }
  return {
    operationId: parseUuid(value.operationId, "operationId"),
    leaseToken: parseUuid(value.leaseToken, "leaseToken"),
    failureCode: value.failureCode,
    now,
    nextAttemptAt,
  };
}

function normalizePauseCommand(value: PauseSyncOperationCommand): PauseSyncOperationCommand {
  const now = parseTimestamp(value.now, "now");
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.failureCode)) {
    throw validationError("The sync failure code is invalid.");
  }
  return {
    operationId: parseUuid(value.operationId, "operationId"),
    leaseToken: parseUuid(value.leaseToken, "leaseToken"),
    failureCode: value.failureCode,
    now,
  };
}

async function insertOrVerifyChunk(
  executor: TransactionExecutor,
  chunk: StoredEncryptedChunk,
): Promise<void> {
  const existing = await findChunkRow(executor, chunk.chunkId);
  if (existing !== null) {
    if (JSON.stringify(rehydrateChunk(existing)) !== JSON.stringify(chunk)) {
      throw validationError("The chunk identifier is already bound to different ciphertext.");
    }
    return;
  }
  const { encrypted } = chunk;
  await executor.execute(
    `INSERT INTO sync_ciphertext_chunks (
      chunk_id,
      project_id,
      object_type,
      object_id,
      version_id,
      chunk_index,
      key_version,
      algorithm,
      nonce,
      ciphertext,
      ciphertext_sha256,
      plaintext_bytes,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chunk.chunkId,
      encrypted.aad.projectId,
      encrypted.aad.objectType,
      encrypted.aad.objectId,
      encrypted.aad.versionId,
      encrypted.aad.chunkIndex,
      encrypted.aad.keyVersion,
      encrypted.algorithm,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.ciphertextSha256,
      encrypted.plaintextBytes,
      chunk.createdAt,
    ],
  );
}

async function insertOrVerifyIncomingChunk(
  executor: TransactionExecutor,
  chunk: StoredEncryptedChunk,
): Promise<void> {
  const existing = await findChunkRow(executor, chunk.chunkId);
  if (existing === null) {
    await insertOrVerifyChunk(executor, chunk);
    return;
  }
  const stored = rehydrateChunk(existing);
  if (
    stored.chunkId !== chunk.chunkId ||
    canonicalJson(stored.encrypted) !== canonicalJson(chunk.encrypted)
  ) {
    throw validationError("The incoming chunk identifier is bound to different ciphertext.");
  }
  await verifyEncryptedChunk(stored, repositoryCorruptionError);
}

async function findChunkRow(
  executor: TransactionExecutor,
  chunkId: string,
): Promise<CiphertextChunkDbRow | null> {
  const rows = await executor.select<CiphertextChunkDbRow>(
    `SELECT ${CIPHERTEXT_CHUNK_COLUMNS}
     FROM sync_ciphertext_chunks
     WHERE chunk_id = ?
     LIMIT 1`,
    [chunkId],
  );
  return rows[0] ?? null;
}

function rehydrateChunk(row: CiphertextChunkDbRow): StoredEncryptedChunk {
  return {
    chunkId: parseUuid(row.chunk_id, "chunkId"),
    encrypted: parseWithSchema(EncryptedSyncChunkContractSchema, {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: row.algorithm,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      ciphertextSha256: row.ciphertext_sha256,
      plaintextBytes: row.plaintext_bytes,
      aad: {
        projectId: row.project_id,
        objectType: row.object_type,
        objectId: row.object_id,
        versionId: row.version_id,
        chunkIndex: row.chunk_index,
        keyVersion: row.key_version,
      },
    }),
    createdAt: parseTimestamp(row.created_at, "createdAt"),
  };
}

async function findOutboxById(
  executor: TransactionExecutor,
  operationId: string,
): Promise<OutboxDbRow | null> {
  const rows = await executor.select<OutboxDbRow>(
    `SELECT ${OUTBOX_COLUMNS}
     FROM sync_outbox_operations
     WHERE operation_id = ?
     LIMIT 1`,
    [operationId],
  );
  return rows[0] ?? null;
}

async function rehydrateOutboxRecord(
  executor: TransactionExecutor,
  row: OutboxDbRow,
): Promise<SyncOutboxRecord> {
  const chunkRows = await executor.select<OperationChunkDbRow>(
    `SELECT chunk_id, position
     FROM sync_operation_chunks
     WHERE operation_id = ?
     ORDER BY position ASC`,
    [row.operation_id],
  );
  try {
    const contract = parseWithSchema(SyncOperationContractSchema, {
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      operationId: row.operation_id,
      projectId: row.project_id,
      deviceId: row.device_id,
      deviceSequence: row.device_sequence,
      objectType: row.object_type,
      objectId: row.object_id,
      objectGeneration: row.object_generation,
      kind: requireOutboxKind(row.kind),
      vector: parseJsonObject(row.vector_json, "version vector"),
      encryptedChunkIds: chunkRows.map(({ chunk_id }) => chunk_id),
      createdAt: row.created_at,
    });
    const chunks = await Promise.all(
      chunkRows.map(async ({ chunk_id }) => {
        const chunkRow = await findChunkRow(executor, chunk_id);
        if (chunkRow === null) {
          throw repositoryCorruptionError("An outgoing operation ciphertext chunk is missing.");
        }
        const chunk = rehydrateChunk(chunkRow);
        await verifyEncryptedChunk(chunk, repositoryCorruptionError);
        return chunk;
      }),
    );
    const firstChunk = chunks[0];
    for (const [position, chunk] of chunks.entries()) {
      if (
        chunk.encrypted.aad.projectId !== contract.projectId ||
        chunk.encrypted.aad.objectType !== contract.objectType ||
        chunk.encrypted.aad.objectId !== contract.objectId ||
        chunk.encrypted.aad.chunkIndex !== position ||
        (firstChunk !== undefined &&
          (chunk.encrypted.aad.versionId !== firstChunk.encrypted.aad.versionId ||
            chunk.encrypted.aad.keyVersion !== firstChunk.encrypted.aad.keyVersion))
      ) {
        throw repositoryCorruptionError(
          "Stored outgoing ciphertext ownership does not match its operation.",
        );
      }
    }
    if (!Number.isSafeInteger(row.attempt) || row.attempt < 0 || row.attempt > 100) {
      throw validationError("Stored sync operation attempt is invalid.");
    }
    return {
      operation: toCoreOperation(contract),
      status: requireOutboxStatus(row.status),
      attempt: row.attempt,
      nextAttemptAt:
        row.next_attempt_at === null ? null : parseTimestamp(row.next_attempt_at, "nextAttemptAt"),
      failureCode: row.failure_code,
      acknowledgedAt:
        row.acknowledged_at === null ? null : parseTimestamp(row.acknowledged_at, "acknowledgedAt"),
    };
  } catch {
    throw repositoryCorruptionError("Stored sync operation metadata is invalid.");
  }
}

function toCoreOperation(value: SyncOperationContract): SyncOperationSnapshot {
  try {
    return SyncOperation.create({
      operationId: value.operationId,
      projectId: value.projectId,
      deviceId: value.deviceId,
      deviceSequence: value.deviceSequence,
      objectType: value.objectType,
      objectId: value.objectId,
      objectGeneration: value.objectGeneration,
      kind: value.kind,
      vector: value.vector,
      encryptedChunkIds: value.encryptedChunkIds,
      createdAt: value.createdAt,
    }).toSnapshot();
  } catch {
    throw validationError("The sync operation is invalid.");
  }
}

function toCoreTombstone(value: SyncTombstoneContract): SyncTombstoneSnapshot {
  try {
    return SyncTombstone.create({
      projectId: value.projectId,
      objectType: value.objectType,
      objectId: value.objectId,
      objectGeneration: value.objectGeneration,
      deletedByDeviceId: value.deletedByDeviceId,
      vector: value.vector,
      deletedAt: value.deletedAt,
      retainUntil: value.retainUntil,
      acknowledgedDeviceIds: value.acknowledgedDeviceIds,
    }).toSnapshot();
  } catch {
    throw validationError("The sync tombstone is invalid.");
  }
}

async function findLatestTombstoneRow(
  executor: TransactionExecutor,
  projectId: string,
  objectType: SyncObjectType,
  objectId: string,
): Promise<TombstoneDbRow | null> {
  const rows = await executor.select<TombstoneDbRow>(
    `SELECT
       project_id,
       object_type,
       object_id,
       object_generation,
       deleted_by_device_id,
       vector_json,
       deleted_at,
       retain_until,
       acknowledged_device_ids_json,
       updated_at
     FROM sync_tombstones
     WHERE project_id = ? AND object_type = ? AND object_id = ?
     ORDER BY object_generation DESC
     LIMIT 1`,
    [projectId, objectType, objectId],
  );
  return rows[0] ?? null;
}

async function findTombstoneRow(
  executor: TransactionExecutor,
  projectId: string,
  objectType: SyncObjectType,
  objectId: string,
  objectGeneration: number,
): Promise<TombstoneDbRow | null> {
  const rows = await executor.select<TombstoneDbRow>(
    `SELECT
       project_id,
       object_type,
       object_id,
       object_generation,
       deleted_by_device_id,
       vector_json,
       deleted_at,
       retain_until,
       acknowledged_device_ids_json,
       updated_at
     FROM sync_tombstones
     WHERE project_id = ?
       AND object_type = ?
       AND object_id = ?
       AND object_generation = ?
     LIMIT 1`,
    [projectId, objectType, objectId, objectGeneration],
  );
  return rows[0] ?? null;
}

function rehydrateTombstone(row: TombstoneDbRow): SyncTombstoneSnapshot {
  try {
    const contract = parseWithSchema(SyncTombstoneContractSchema, {
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      projectId: row.project_id,
      objectType: row.object_type,
      objectId: row.object_id,
      objectGeneration: row.object_generation,
      deletedByDeviceId: row.deleted_by_device_id,
      vector: parseJsonObject(row.vector_json, "tombstone vector"),
      deletedAt: row.deleted_at,
      retainUntil: row.retain_until,
      acknowledgedDeviceIds: parseJsonStringArray(
        row.acknowledged_device_ids_json,
        "acknowledged devices",
      ),
    });
    return toCoreTombstone(contract);
  } catch {
    throw repositoryCorruptionError("Stored sync tombstone metadata is invalid.");
  }
}

async function findTransferRow(
  executor: TransactionExecutor,
  transferId: string,
): Promise<TransferDbRow | null> {
  const rows = await executor.select<TransferDbRow>(
    `SELECT transfer_id, project_id, object_id, version_id, status, created_at, updated_at
     FROM sync_transfers
     WHERE transfer_id = ?
     LIMIT 1`,
    [transferId],
  );
  return rows[0] ?? null;
}

async function readTransferManifest(
  executor: TransactionExecutor,
  transfer: TransferDbRow,
): Promise<ChunkTransferManifest> {
  const rows = await executor.select<TransferChunkDbRow>(
    `SELECT
       chunk_id,
       chunk_index,
       ciphertext_bytes,
       ciphertext_sha256,
       remote_etag,
       acknowledged_at
     FROM sync_transfer_chunks
     WHERE transfer_id = ?
     ORDER BY chunk_index ASC`,
    [transfer.transfer_id],
  );
  try {
    parseTimestamp(transfer.created_at, "createdAt");
    parseTimestamp(transfer.updated_at, "updatedAt");
    return {
      transferId: parseUuid(transfer.transfer_id, "transferId"),
      projectId: parseUuid(transfer.project_id, "projectId"),
      objectId: parseUuid(transfer.object_id, "objectId"),
      versionId: parseUuid(transfer.version_id, "versionId"),
      chunks: rows.map((row) => ({
        chunkId: parseUuid(row.chunk_id, "chunkId"),
        index: row.chunk_index,
        ciphertextBytes: row.ciphertext_bytes,
        ciphertextSha256: row.ciphertext_sha256,
      })),
    };
  } catch {
    throw repositoryCorruptionError("Stored sync transfer manifest is invalid.");
  }
}

async function rehydrateTransferLedger(
  executor: TransactionExecutor,
  transfer: TransferDbRow,
): Promise<ChunkTransferLedger> {
  const manifest = await readTransferManifest(executor, transfer);
  let ledger: ChunkTransferLedger;
  try {
    ledger = new ChunkTransferLedger(manifest);
  } catch {
    throw repositoryCorruptionError("Stored sync transfer metadata is invalid.");
  }
  const receiptRows = await executor.select<TransferChunkDbRow>(
    `SELECT
       chunk_id,
       chunk_index,
       ciphertext_bytes,
       ciphertext_sha256,
       remote_etag,
       acknowledged_at
     FROM sync_transfer_chunks
     WHERE transfer_id = ? AND remote_etag IS NOT NULL
     ORDER BY chunk_index ASC`,
    [transfer.transfer_id],
  );
  for (const row of receiptRows) {
    if (row.remote_etag === null || row.acknowledged_at === null) {
      throw repositoryCorruptionError("Stored sync transfer receipt is inconsistent.");
    }
    try {
      ledger.acknowledge(row.chunk_id, {
        ciphertextSha256: row.ciphertext_sha256,
        remoteETag: row.remote_etag,
      });
    } catch {
      throw repositoryCorruptionError("Stored sync transfer receipt is invalid.");
    }
  }
  return ledger;
}

function sameOperation(left: SyncOperationSnapshot, right: SyncOperationSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameTombstone(left: SyncTombstoneSnapshot, right: SyncTombstoneSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameManifest(left: ChunkTransferManifest, right: ChunkTransferManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireOutboxKind(value: string): "upsert" | "delete" {
  if (value !== "upsert" && value !== "delete") {
    throw repositoryCorruptionError("Stored sync operation kind is invalid.");
  }
  return value;
}

function requireOutboxStatus(value: string): SyncOutboxStatus {
  if (!["queued", "in_flight", "acknowledged", "failed", "paused"].includes(value)) {
    throw repositoryCorruptionError("Stored sync operation status is invalid.");
  }
  return value as SyncOutboxStatus;
}

function requireCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw repositoryCorruptionError("Stored local sync counts are invalid.");
  }
  return value;
}

function buildStatusCounts<const Status extends string>(
  statuses: readonly Status[],
  rows: readonly StatusCountDbRow[],
): Readonly<Record<Status, number>> {
  const allowed = new Set<string>(statuses);
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    Status,
    number
  >;
  for (const row of rows) {
    if (!allowed.has(row.status)) {
      throw repositoryCorruptionError("Stored local sync status counts are invalid.");
    }
    counts[row.status as Status] = requireCount(row.count);
  }
  return counts;
}

function parseUuid(value: string, field: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be a UUIDv7 identifier.`);
  }
  return parsed.data;
}

function parseTimestamp(value: string, field: string): string {
  const parsed = IsoUtcTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be an ISO UTC timestamp.`);
  }
  return parsed.data;
}

function parseLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) {
    throw validationError("The query limit must be between 1 and 256.");
  }
  return value;
}

function parseJsonObject(serialized: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw repositoryCorruptionError(`Stored ${label} JSON is invalid.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw repositoryCorruptionError(`Stored ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseJsonStringArray(serialized: string, label: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw repositoryCorruptionError(`Stored ${label} JSON is invalid.`);
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw repositoryCorruptionError(`Stored ${label} must be a string array.`);
  }
  return value;
}

function normalizeVersionVectorContract(value: VersionVector): VersionVector {
  const parsed = VersionVectorSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError("The observed version vector is invalid.");
  }
  return parsed.data;
}

async function verifyEncryptedChunk(
  chunk: StoredEncryptedChunk,
  errorFactory: (message: string) => AppError = validationError,
): Promise<void> {
  let nonce: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    nonce = decodeBase64UrlBytes(chunk.encrypted.nonce);
    ciphertext = decodeBase64UrlBytes(chunk.encrypted.ciphertext);
  } catch {
    throw errorFactory("The encrypted chunk is not valid base64url ciphertext.");
  }
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 16) {
    throw errorFactory("The encrypted chunk nonce or authentication tag is invalid.");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", ciphertext));
  const digestHex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (digestHex !== chunk.encrypted.ciphertextSha256) {
    throw errorFactory("The encrypted chunk transport checksum does not match.");
  }
}

function decodedByteLength(base64url: string): number {
  return decodeBase64UrlBytes(base64url).byteLength;
}

function decodeBase64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseWithSchema<Output>(
  schema: { safeParse(value: unknown): { success: true; data: Output } | { success: false } },
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationError("The persisted cloud/sync contract is invalid.");
  }
  return parsed.data;
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
        message: "The local encrypted sync store could not complete the operation.",
        retryable: true,
        actions: ["RETRY", "EXPORT_DRAFT"],
        details: {
          operation,
          causeType: cause instanceof Error ? cause.name : "UnknownError",
        },
      }),
    );
  }
}

function validationError(message: string): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message,
  });
}

function concurrencyError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY"],
  });
}

function notFoundError(message: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message,
    details: { operation: "SYNC_LOCAL_RECORD_NOT_FOUND" },
  });
}

function repositoryCorruptionError(message: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message,
    actions: ["CONTACT_SUPPORT"],
    details: { operation: "SYNC_LOCAL_RECORD_INVALID" },
  });
}
