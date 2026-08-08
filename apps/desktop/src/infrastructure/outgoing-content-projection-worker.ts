import {
  SyncMaterializationSqliteStore,
  completeSyncProjectionJobInTransaction,
  findCurrentSyncMaterializedObjectInTransaction,
  loadProjectSyncRegistrationInTransaction,
  writeSyncMaterializedObjectInTransaction,
  type MaterializedSyncObject,
  type ProjectSyncRegistration,
  type SqlExecutor,
  type SyncProjectionBlockedReason,
  type SyncProjectionJob,
  type TransactionExecutor,
} from "@inkshadow/data";
import {
  enqueueSyncDeleteOperationInTransaction,
  enqueueSyncOperationInTransaction,
} from "@inkshadow/data/sync-sqlite-store";
import { AppError, type Clock, type Result, type UuidV7Generator } from "@inkshadow/domain";
import {
  CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
  SyncCoreError,
  mergeVersionVectors,
  normalizeVersionVector,
  type ChapterVersionContentSyncPayload,
  type ContentSyncPayload,
  type ProjectManifestContentSyncPayload,
  type VersionVector,
} from "@inkshadow/sync-core";

import { OutgoingContentEncryptionBuilder } from "./outgoing-content-encryption-builder.js";
import { OutgoingContentTombstoneBuilder } from "./outgoing-content-tombstone-builder.js";

const DEFAULT_LEASE_MILLISECONDS = 60_000;
const DEFAULT_RETRY_MILLISECONDS = 5_000;
const MAX_RETRY_MILLISECONDS = 5 * 60_000;

export interface OpenedProjectionProjectKey {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly key: CryptoKey;
}

/**
 * ProjectKeyLifecycleService satisfies this port structurally. Keeping the
 * worker coupled to only the exact-key operation also makes accidental
 * "latest key" fallback impossible.
 */
export interface ProjectionProjectKeyOpener {
  openProjectDataKeyForDevice(
    projectId: string,
    deviceId: string,
    keyVersion: number,
  ): Promise<OpenedProjectionProjectKey>;
}

export interface OutgoingContentProjectionWorkerOptions {
  readonly executor: SqlExecutor;
  readonly projectKeys: ProjectionProjectKeyOpener;
  readonly ids: Pick<UuidV7Generator, "next">;
  readonly clock: Pick<Clock, "now">;
  readonly workerId: string;
  readonly leaseMilliseconds?: number;
  readonly retryDelayMilliseconds?: (attempt: number) => number;
  readonly builder?: OutgoingContentEncryptionBuilder;
  readonly tombstoneBuilder?: OutgoingContentTombstoneBuilder;
  readonly cryptoProvider?: Crypto;
}

export type OutgoingContentProjectionWorkerOutcome =
  | Readonly<{ status: "idle"; projectId: string }>
  | Readonly<{
      status: "backoff";
      projectId: string;
      jobId: string;
      attempt: number;
      nextAttemptAt: string;
      failureCode: string | null;
    }>
  | Readonly<{
      status: "permanent_failure";
      projectId: string;
      jobId: string;
      attempt: number;
      failureCode: string;
    }>
  | Readonly<{
      status: "attempt_exhausted";
      projectId: string;
      jobId: string;
      attempt: number;
      failureCode: string;
    }>
  | Readonly<{
      status: "blocked";
      projectId: string;
      jobId: string;
      reason: SyncProjectionBlockedReason;
      blockerJobId: string | null;
      resumeAt: string | null;
    }>
  | Readonly<{
      status: "completed";
      projectId: string;
      jobId: string;
      operationId: string;
      objectType: "project_manifest" | "chapter_version";
      sourceRevision: number;
      deviceSequence: number;
    }>
  | Readonly<{
      status: "retry_scheduled";
      projectId: string;
      jobId: string;
      failureCode: string;
      nextAttemptAt: string;
    }>
  | Readonly<{
      status: "failed";
      projectId: string;
      jobId: string;
      failureCode: string;
    }>
  | Readonly<{
      status: "lease_lost";
      projectId: string;
      jobId: string;
      failureCode: string;
    }>;

interface ProjectDbRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly revision: number;
  readonly privacy_mode: string;
  readonly privacy_revision: number;
  readonly deletion_generation: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at: string | null;
  readonly trashed_at: string | null;
  readonly retention_until: string | null;
  readonly status_before_trash: string | null;
}

interface ChapterDbRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly content: string;
  readonly status: string;
  readonly revision: number;
  readonly privacy_mode: "standard" | "local_only";
  readonly privacy_revision: number;
  readonly current_version_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly trashed_at: string | null;
}

interface ChapterVersionDbRow {
  readonly id: string;
  readonly project_id: string;
  readonly chapter_id: string;
  readonly parent_version_id: string | null;
  readonly sequence: number;
  readonly content: string;
  readonly content_checksum: string;
  readonly reason: string;
  readonly source_candidate_id: string | null;
  readonly created_at: string;
}

interface DeviceSequenceDbRow {
  readonly last_allocated_sequence: number;
  readonly revision: number;
}

interface PreparedSource {
  readonly payload: ContentSyncPayload;
  readonly fingerprint: string;
  readonly manifestVersionId: string | undefined;
}

interface PreparedDeleteSource {
  readonly fingerprint: string;
  readonly deletedAt: string;
}

interface ReservedSequence {
  readonly sequence: number;
  readonly baseMarker: MaterializedSyncObject | null;
  readonly vector: VersionVector;
}

interface ProjectionFailure {
  readonly code: string;
  readonly retryable: boolean;
}

interface ConflictResolutionVectorFloorRow {
  readonly project_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly remote_vector_json: string;
}

/**
 * Turns opaque projection jobs into encrypted protocol-v2 outbox operations.
 *
 * Plaintext reads, checksum validation, key opening, and encryption happen
 * outside SQLite transactions. The final transaction revalidates the exact
 * source and vector base, then commits ciphertext, the materialized marker,
 * and job completion together.
 */
export class OutgoingContentProjectionWorker {
  private readonly store: SyncMaterializationSqliteStore;
  private readonly builder: OutgoingContentEncryptionBuilder;
  private readonly tombstoneBuilder: OutgoingContentTombstoneBuilder;
  private readonly cryptoProvider: Crypto;
  private readonly leaseMilliseconds: number;
  private readonly retryDelayMilliseconds: (attempt: number) => number;

  public constructor(private readonly options: OutgoingContentProjectionWorkerOptions) {
    this.cryptoProvider = options.cryptoProvider ?? globalThis.crypto;
    this.store = new SyncMaterializationSqliteStore(options.executor);
    this.builder = options.builder ?? new OutgoingContentEncryptionBuilder(this.cryptoProvider);
    this.tombstoneBuilder = options.tombstoneBuilder ?? new OutgoingContentTombstoneBuilder();
    this.leaseMilliseconds = requirePositiveDuration(
      options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS,
      "leaseMilliseconds",
    );
    this.retryDelayMilliseconds =
      options.retryDelayMilliseconds ??
      ((attempt) =>
        Math.min(
          DEFAULT_RETRY_MILLISECONDS * 2 ** Math.min(Math.max(attempt - 1, 0), 6),
          MAX_RETRY_MILLISECONDS,
        ));
  }

  public async runOnce(projectId: string): Promise<OutgoingContentProjectionWorkerOutcome> {
    const leasedAt = requireCanonicalTimestamp(this.options.clock.now(), "clock.now()");
    const leaseToken = this.options.ids.next();
    const leaseExpiresAt = addMilliseconds(leasedAt, this.leaseMilliseconds);
    const claimed = unwrap(
      await this.store.claimProjectionJob({
        projectId,
        leaseOwnerId: this.options.workerId,
        leaseToken,
        leasedAt,
        leaseExpiresAt,
      }),
    );
    if (claimed === null) {
      const blocking = unwrap(
        await this.store.readProjectionBlockingState({
          projectId,
          observedAt: leasedAt,
        }),
      );
      switch (blocking.state) {
        case "idle":
          return { status: "idle", projectId };
        case "backoff":
          return {
            status: "backoff",
            projectId,
            jobId: blocking.jobId,
            attempt: blocking.attempt,
            nextAttemptAt: blocking.nextAttemptAt,
            failureCode: blocking.failureCode,
          };
        case "permanent_failure":
          return {
            status: "permanent_failure",
            projectId,
            jobId: blocking.jobId,
            attempt: blocking.attempt,
            failureCode: blocking.failureCode,
          };
        case "attempt_exhausted":
          return {
            status: "attempt_exhausted",
            projectId,
            jobId: blocking.jobId,
            attempt: blocking.attempt,
            failureCode: blocking.failureCode,
          };
        case "blocked":
          return {
            status: "blocked",
            projectId,
            jobId: blocking.jobId,
            reason: blocking.reason,
            blockerJobId: blocking.blockerJobId,
            resumeAt: blocking.resumeAt,
          };
      }
    }

    try {
      return await this.projectClaimedJob(claimed, leasedAt);
    } catch (cause: unknown) {
      return this.settleFailure(claimed, classifyProjectionFailure(cause));
    }
  }

  private async projectClaimedJob(
    job: SyncProjectionJob,
    preparedAt: string,
  ): Promise<OutgoingContentProjectionWorkerOutcome> {
    requireSupportedContentJob(job);
    const registration = unwrap(await this.store.loadProjectSyncRegistration(job.projectId));
    requireRegistrationAuthority(registration, job);
    if (job.projectionKind === "delete") {
      return this.projectClaimedDelete(job, preparedAt);
    }

    const source = await loadProjectionSource(this.options.executor, job, this.cryptoProvider);
    const openedKey = await this.options.projectKeys.openProjectDataKeyForDevice(
      job.projectId,
      job.deviceId,
      job.keyVersion,
    );
    if (openedKey.projectId !== job.projectId || openedKey.keyVersion !== job.keyVersion) {
      throw permanentFailure(
        "SYNC_PROJECT_KEY_VERSION_MISMATCH",
        "The key opener did not return the exact requested project key version.",
      );
    }

    const reservation = await this.reserveDeviceSequence(job, preparedAt);
    const operationId = this.options.ids.next();
    const built = await this.builder.build({
      key: openedKey.key,
      keyVersion: job.keyVersion,
      deviceId: job.deviceId,
      deviceSequence: reservation.sequence,
      operationId,
      vector: reservation.vector,
      createdAt: preparedAt,
      chunkIdGenerator: this.options.ids,
      payload: source.payload,
      ...(source.manifestVersionId === undefined
        ? {}
        : { manifestVersionId: source.manifestVersionId }),
    });
    const completedAt = requireCanonicalTimestamp(this.options.clock.now(), "clock.now()");
    if (Date.parse(completedAt) < Date.parse(preparedAt)) {
      throw permanentFailure(
        "SYNC_CLOCK_REGRESSED",
        "The local clock regressed during projection.",
      );
    }

    await this.options.executor.transaction(async (transaction) => {
      const exactRegistration = unwrap(
        await loadProjectSyncRegistrationInTransaction(transaction, job.projectId),
      );
      requireRegistrationAuthority(exactRegistration, job);

      const exactSource = await loadProjectionSource(transaction, job, this.cryptoProvider);
      if (exactSource.fingerprint !== source.fingerprint) {
        throw retryableFailure(
          "SYNC_PROJECTION_SOURCE_CHANGED",
          "The projection source changed while ciphertext was being prepared.",
        );
      }

      const exactMarker = unwrap(
        await findCurrentSyncMaterializedObjectInTransaction(
          transaction,
          job.projectId,
          job.objectType,
          job.objectId,
        ),
      );
      if (!sameMarker(exactMarker, reservation.baseMarker)) {
        throw retryableFailure(
          "SYNC_PROJECTION_VECTOR_CHANGED",
          "The materialized vector changed while ciphertext was being prepared.",
        );
      }

      unwrap(
        await enqueueSyncOperationInTransaction(transaction, {
          operation: built.operation,
          chunks: built.chunks,
          now: completedAt,
        }),
      );
      unwrap(
        await writeSyncMaterializedObjectInTransaction(transaction, {
          object: {
            projectId: job.projectId,
            objectType: job.objectType,
            objectId: job.objectId,
            objectGeneration: job.objectGeneration,
            versionId:
              job.objectType === "chapter_version"
                ? requireVersionId(job)
                : (source.manifestVersionId ?? job.jobId),
            vector: built.operation.vector,
            payloadSha256: built.payloadSha256,
            sourceOperationId: operationId,
            sourceDeviceId: job.deviceId,
            sourceDeviceSequence: reservation.sequence,
            state: "present",
            materializedAt: completedAt,
          },
          expectedSourceOperationId:
            exactMarker?.objectGeneration === job.objectGeneration
              ? exactMarker.sourceOperationId
              : null,
        }),
      );
      unwrap(
        await completeSyncProjectionJobInTransaction(transaction, {
          jobId: job.jobId,
          expectedRevision: job.revision,
          leaseOwnerId: requireLeaseOwner(job),
          leaseToken: requireLeaseToken(job),
          operationId,
          completedAt,
        }),
      );
    });

    return {
      status: "completed",
      projectId: job.projectId,
      jobId: job.jobId,
      operationId,
      objectType: requireContentObjectType(job),
      sourceRevision: job.sourceRevision,
      deviceSequence: reservation.sequence,
    };
  }

  private async projectClaimedDelete(
    job: SyncProjectionJob,
    preparedAt: string,
  ): Promise<OutgoingContentProjectionWorkerOutcome> {
    const source = await loadProjectionDeleteSource(this.options.executor, job);
    const reservation = await this.reserveDeviceSequence(job, preparedAt);
    const operationId = this.options.ids.next();
    const built = this.tombstoneBuilder.build({
      projectId: job.projectId,
      objectType: requireContentObjectType(job),
      objectId: job.objectId,
      objectGeneration: job.objectGeneration,
      deviceId: job.deviceId,
      deviceSequence: reservation.sequence,
      operationId,
      vector: reservation.vector,
      deletedAt: source.deletedAt,
      retainUntil: addMilliseconds(source.deletedAt, 365 * 24 * 60 * 60 * 1_000),
    });
    const completedAt = requireCanonicalTimestamp(this.options.clock.now(), "clock.now()");
    if (Date.parse(completedAt) < Date.parse(preparedAt)) {
      throw permanentFailure(
        "SYNC_CLOCK_REGRESSED",
        "The local clock regressed during delete projection.",
      );
    }

    await this.options.executor.transaction(async (transaction) => {
      const exactRegistration = unwrap(
        await loadProjectSyncRegistrationInTransaction(transaction, job.projectId),
      );
      requireRegistrationAuthority(exactRegistration, job);
      const exactSource = await loadProjectionDeleteSource(transaction, job);
      if (exactSource.fingerprint !== source.fingerprint) {
        throw retryableFailure(
          "SYNC_PROJECTION_SOURCE_CHANGED",
          "The deletion source changed while its tombstone was being prepared.",
        );
      }
      const exactMarker = unwrap(
        await findCurrentSyncMaterializedObjectInTransaction(
          transaction,
          job.projectId,
          job.objectType,
          job.objectId,
        ),
      );
      if (!sameMarker(exactMarker, reservation.baseMarker)) {
        throw retryableFailure(
          "SYNC_PROJECTION_VECTOR_CHANGED",
          "The materialized vector changed while the tombstone was being prepared.",
        );
      }

      unwrap(
        await enqueueSyncDeleteOperationInTransaction(transaction, {
          operation: built.operation,
          tombstone: built.tombstone,
          now: completedAt,
        }),
      );
      unwrap(
        await writeSyncMaterializedObjectInTransaction(transaction, {
          object: {
            projectId: job.projectId,
            objectType: job.objectType,
            objectId: job.objectId,
            objectGeneration: job.objectGeneration,
            versionId: null,
            vector: built.operation.vector,
            payloadSha256: null,
            sourceOperationId: operationId,
            sourceDeviceId: job.deviceId,
            sourceDeviceSequence: reservation.sequence,
            state: "deleted",
            materializedAt: completedAt,
          },
          expectedSourceOperationId:
            exactMarker?.objectGeneration === job.objectGeneration
              ? exactMarker.sourceOperationId
              : null,
        }),
      );
      unwrap(
        await completeSyncProjectionJobInTransaction(transaction, {
          jobId: job.jobId,
          expectedRevision: job.revision,
          leaseOwnerId: requireLeaseOwner(job),
          leaseToken: requireLeaseToken(job),
          operationId,
          completedAt,
        }),
      );
    });

    return {
      status: "completed",
      projectId: job.projectId,
      jobId: job.jobId,
      operationId,
      objectType: requireContentObjectType(job),
      sourceRevision: job.sourceRevision,
      deviceSequence: reservation.sequence,
    };
  }

  /**
   * Sequence reservations intentionally commit before encryption. A failed or
   * crashed attempt may leave a gap, but can never reuse a device sequence.
   */
  private async reserveDeviceSequence(
    job: SyncProjectionJob,
    now: string,
  ): Promise<ReservedSequence> {
    return this.options.executor.transaction(async (transaction) => {
      const marker = unwrap(
        await findCurrentSyncMaterializedObjectInTransaction(
          transaction,
          job.projectId,
          job.objectType,
          job.objectId,
        ),
      );
      requireProjectableGeneration(marker, job);
      const rows = await transaction.select<DeviceSequenceDbRow>(
        `SELECT last_allocated_sequence, revision
         FROM sync_device_sequences
         WHERE project_id = ? AND device_id = ?`,
        [job.projectId, job.deviceId],
      );
      if (rows.length > 1) {
        throw permanentFailure(
          "SYNC_DEVICE_SEQUENCE_CORRUPT",
          "The device sequence authority is duplicated.",
        );
      }
      const existing = rows[0] ?? null;
      const resolutionVectorFloor = await loadConflictResolutionVectorFloor(transaction, job);
      const baseVector = mergeVersionVectors(marker?.vector ?? {}, resolutionVectorFloor ?? {});
      const observed = baseVector[job.deviceId] ?? 0;
      const previous = Math.max(existing?.last_allocated_sequence ?? 0, observed);
      if (!Number.isSafeInteger(previous) || previous >= Number.MAX_SAFE_INTEGER) {
        throw permanentFailure(
          "SYNC_DEVICE_SEQUENCE_EXHAUSTED",
          "The local device sequence is exhausted.",
        );
      }
      const sequence = previous + 1;
      if (existing === null) {
        const inserted = await transaction.execute(
          `INSERT INTO sync_device_sequences (
             project_id, device_id, last_allocated_sequence, revision, updated_at
           ) VALUES (?, ?, ?, 1, ?)`,
          [job.projectId, job.deviceId, sequence, now],
        );
        requireSingleMutation(inserted.rowsAffected);
      } else {
        const nextRevision = existing.revision + 1;
        if (!Number.isSafeInteger(nextRevision)) {
          throw permanentFailure(
            "SYNC_DEVICE_SEQUENCE_EXHAUSTED",
            "The local device sequence revision is exhausted.",
          );
        }
        const updated = await transaction.execute(
          `UPDATE sync_device_sequences
           SET last_allocated_sequence = ?, revision = ?, updated_at = ?
           WHERE project_id = ? AND device_id = ? AND revision = ?`,
          [sequence, nextRevision, now, job.projectId, job.deviceId, existing.revision],
        );
        requireSingleMutation(updated.rowsAffected);
      }
      return {
        sequence,
        baseMarker: marker,
        vector: normalizeVersionVector({
          ...baseVector,
          [job.deviceId]: sequence,
        }),
      };
    });
  }

  private async settleFailure(
    job: SyncProjectionJob,
    failure: ProjectionFailure,
  ): Promise<OutgoingContentProjectionWorkerOutcome> {
    const failedAt = monotonicFailureTimestamp(this.options.clock.now(), job.updatedAt);
    if (failure.retryable) {
      const delay = requirePositiveDuration(
        this.retryDelayMilliseconds(job.attempt),
        "retryDelayMilliseconds",
      );
      const nextAttemptAt = addMilliseconds(failedAt, delay);
      const settled = await this.store.retryProjectionJob({
        jobId: job.jobId,
        expectedRevision: job.revision,
        leaseOwnerId: requireLeaseOwner(job),
        leaseToken: requireLeaseToken(job),
        failureCode: failure.code,
        failedAt,
        nextAttemptAt,
      });
      if (!settled.ok) {
        return {
          status: "lease_lost",
          projectId: job.projectId,
          jobId: job.jobId,
          failureCode: failure.code,
        };
      }
      return {
        status: "retry_scheduled",
        projectId: job.projectId,
        jobId: job.jobId,
        failureCode: failure.code,
        nextAttemptAt,
      };
    }

    const settled = await this.store.failProjectionJob({
      jobId: job.jobId,
      expectedRevision: job.revision,
      leaseOwnerId: requireLeaseOwner(job),
      leaseToken: requireLeaseToken(job),
      failureCode: failure.code,
      failedAt,
    });
    if (!settled.ok) {
      return {
        status: "lease_lost",
        projectId: job.projectId,
        jobId: job.jobId,
        failureCode: failure.code,
      };
    }
    return {
      status: "failed",
      projectId: job.projectId,
      jobId: job.jobId,
      failureCode: failure.code,
    };
  }
}

async function loadProjectionSource(
  executor: TransactionExecutor,
  job: SyncProjectionJob,
  cryptoProvider: Crypto,
): Promise<PreparedSource> {
  if (job.objectType === "project_manifest") {
    const rows = await executor.select<ProjectDbRow>(
      `SELECT id, name, status, revision, deletion_generation, created_at, updated_at,
              archived_at, trashed_at, retention_until, status_before_trash
       FROM projects WHERE id = ?`,
      [job.projectId],
    );
    const row = requireExactlyOne(
      rows,
      "SYNC_PROJECTION_SOURCE_MISSING",
      "The project projection source is missing or duplicated.",
    );
    if (
      job.objectId !== job.projectId ||
      job.versionId !== job.projectId ||
      row.id !== job.projectId ||
      row.revision !== job.sourceRevision ||
      row.deletion_generation + 1 !== job.objectGeneration
    ) {
      throw permanentFailure(
        "SYNC_PROJECTION_SOURCE_STALE",
        "The project projection job no longer identifies the exact source revision.",
      );
    }
    const payload: ProjectManifestContentSyncPayload = {
      schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
      objectType: "project_manifest",
      projectId: row.id,
      objectId: row.id,
      objectGeneration: job.objectGeneration,
      project: {
        id: row.id,
        name: row.name,
        status: requireProjectStatus(row.status),
        revision: row.revision,
        deletionGeneration: row.deletion_generation,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archivedAt: row.archived_at,
        trashedAt: row.trashed_at,
        retentionUntil: row.retention_until,
        statusBeforeTrash: requireProjectStatusBeforeTrash(row.status_before_trash),
      },
    };
    return {
      payload,
      fingerprint: await fingerprintProjectionSource(payload, cryptoProvider),
      // A job identifier is fresh for each manifest source revision and is
      // therefore the authenticated manifest version, unlike project.id.
      manifestVersionId: job.jobId,
    };
  }

  if (job.objectType === "chapter_version") {
    const versionId = requireVersionId(job);
    const [chapterRows, versionRows] = await Promise.all([
      executor.select<ChapterDbRow>(
        `SELECT id, project_id, title, content, status, revision, privacy_mode, privacy_revision,
                current_version_id,
                created_at, updated_at, trashed_at
         FROM chapters WHERE id = ?`,
        [job.objectId],
      ),
      executor.select<ChapterVersionDbRow>(
        `SELECT id, project_id, chapter_id, parent_version_id, sequence, content,
                content_checksum, reason, source_candidate_id, created_at
         FROM chapter_versions WHERE id = ?`,
        [versionId],
      ),
    ]);
    const chapter = requireExactlyOne(
      chapterRows,
      "SYNC_PROJECTION_SOURCE_MISSING",
      "The chapter projection source is missing or duplicated.",
    );
    const version = requireExactlyOne(
      versionRows,
      "SYNC_PROJECTION_SOURCE_MISSING",
      "The immutable chapter version is missing or duplicated.",
    );
    if (chapter.privacy_mode === "local_only") {
      throw permanentFailure(
        "PRIVATE_CHAPTER_LOCAL_ONLY",
        "A local-only chapter cannot be projected, encrypted, or uploaded.",
      );
    }
    if (
      chapter.id !== job.objectId ||
      chapter.project_id !== job.projectId ||
      chapter.revision < job.sourceRevision ||
      version.id !== versionId ||
      version.project_id !== job.projectId ||
      version.chapter_id !== job.objectId ||
      version.sequence !== job.sourceRevision
    ) {
      throw permanentFailure(
        "SYNC_PROJECTION_SOURCE_STALE",
        "The chapter projection job no longer identifies the exact immutable version.",
      );
    }

    const payload: ChapterVersionContentSyncPayload = {
      schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
      objectType: "chapter_version",
      projectId: job.projectId,
      objectId: job.objectId,
      versionId,
      objectGeneration: job.objectGeneration,
      chapter: {
        id: chapter.id,
        projectId: chapter.project_id,
        title: chapter.title,
        // Historical jobs keep current projection metadata, but their content
        // and revision identity must come from the immutable requested version.
        content: version.content,
        status: requireChapterStatus(chapter.status),
        revision: version.sequence,
        currentVersionId: version.id,
        createdAt: chapter.created_at,
        updatedAt: chapter.updated_at,
        trashedAt: chapter.trashed_at,
      },
      version: {
        id: version.id,
        projectId: version.project_id,
        chapterId: version.chapter_id,
        parentVersionId: version.parent_version_id,
        sequence: version.sequence,
        content: version.content,
        contentChecksum: version.content_checksum,
        reason: requireChapterVersionReason(version.reason),
        sourceCandidateId: version.source_candidate_id,
        createdAt: version.created_at,
      },
    };
    return {
      payload,
      fingerprint: await fingerprintProjectionSource(
        {
          payload,
          currentChapterProjection: {
            id: chapter.id,
            projectId: chapter.project_id,
            title: chapter.title,
            content: chapter.content,
            status: chapter.status,
            revision: chapter.revision,
            currentVersionId: chapter.current_version_id,
            createdAt: chapter.created_at,
            updatedAt: chapter.updated_at,
            trashedAt: chapter.trashed_at,
          },
        },
        cryptoProvider,
      ),
      manifestVersionId: undefined,
    };
  }

  throw permanentFailure(
    "SYNC_PROJECTION_OBJECT_UNSUPPORTED",
    "This worker only supports InkShadow content projection objects.",
  );
}

async function loadProjectionDeleteSource(
  executor: TransactionExecutor,
  job: SyncProjectionJob,
): Promise<PreparedDeleteSource> {
  if (job.objectGeneration % 2 !== 0) {
    throw permanentFailure(
      "SYNC_PROJECTION_GENERATION_INVALID",
      "Content deletion jobs must use an even object generation.",
    );
  }
  if (job.objectType === "project_manifest") {
    const rows = await executor.select<ProjectDbRow>(
      `SELECT id, name, status, revision, deletion_generation, created_at, updated_at,
              archived_at, trashed_at, retention_until, status_before_trash
       FROM projects WHERE id = ?`,
      [job.projectId],
    );
    const row = requireExactlyOne(
      rows,
      "SYNC_PROJECTION_SOURCE_MISSING",
      "The project deletion source is missing or duplicated.",
    );
    if (
      job.objectId !== job.projectId ||
      row.id !== job.projectId ||
      row.status !== "trashed" ||
      row.revision !== job.sourceRevision ||
      row.deletion_generation + 1 !== job.objectGeneration ||
      row.trashed_at === null
    ) {
      throw permanentFailure(
        "SYNC_PROJECTION_SOURCE_STALE",
        "The project deletion job no longer identifies the exact lifecycle revision.",
      );
    }
    return {
      deletedAt: requireCanonicalTimestamp(row.trashed_at, "project.trashedAt"),
      fingerprint: JSON.stringify([
        row.id,
        row.status,
        row.revision,
        row.deletion_generation,
        row.updated_at,
        row.trashed_at,
        row.retention_until,
        row.status_before_trash,
      ]),
    };
  }
  if (job.objectType === "chapter_version") {
    const rows = await executor.select<ChapterDbRow>(
      `SELECT id, project_id, title, content, status, revision, privacy_mode, privacy_revision,
              current_version_id,
              created_at, updated_at, trashed_at
       FROM chapters WHERE id = ?`,
      [job.objectId],
    );
    const row = requireExactlyOne(
      rows,
      "SYNC_PROJECTION_SOURCE_MISSING",
      "The chapter deletion source is missing or duplicated.",
    );
    if (
      row.id !== job.objectId ||
      row.project_id !== job.projectId ||
      row.status !== "trashed" ||
      row.revision !== job.sourceRevision ||
      row.trashed_at === null
    ) {
      throw permanentFailure(
        "SYNC_PROJECTION_SOURCE_STALE",
        "The chapter deletion job no longer identifies the exact lifecycle revision.",
      );
    }
    return {
      deletedAt: requireCanonicalTimestamp(row.trashed_at, "chapter.trashedAt"),
      fingerprint: JSON.stringify([
        row.id,
        row.project_id,
        row.status,
        row.revision,
        row.current_version_id,
        row.updated_at,
        row.trashed_at,
      ]),
    };
  }
  throw permanentFailure(
    "SYNC_PROJECTION_OBJECT_UNSUPPORTED",
    "This worker only supports InkShadow content projection objects.",
  );
}

function requireSupportedContentJob(job: SyncProjectionJob): void {
  requireContentObjectType(job);
  if (job.projectionKind === "upsert") {
    if (job.objectGeneration % 2 !== 1) {
      throw permanentFailure(
        "SYNC_PROJECTION_GENERATION_INVALID",
        "Content upsert jobs must use an odd object generation.",
      );
    }
    requireVersionId(job);
  } else if (job.versionId !== null) {
    throw permanentFailure(
      "SYNC_PROJECTION_SOURCE_STALE",
      "Content deletion jobs must not reference a plaintext version.",
    );
  }
  requireLeaseOwner(job);
  requireLeaseToken(job);
}

function requireContentObjectType(job: SyncProjectionJob): "project_manifest" | "chapter_version" {
  if (job.objectType !== "project_manifest" && job.objectType !== "chapter_version") {
    throw permanentFailure(
      "SYNC_PROJECTION_OBJECT_UNSUPPORTED",
      "This worker only supports InkShadow content projection objects.",
    );
  }
  return job.objectType;
}

function requireRegistrationAuthority(
  registration: ProjectSyncRegistration | null,
  job: SyncProjectionJob,
): void {
  if (registration === null) {
    throw permanentFailure(
      "SYNC_REGISTRATION_MISSING",
      "The projection no longer has a local sync registration.",
    );
  }
  if (
    registration.accountId !== job.accountId ||
    registration.deviceId !== job.deviceId ||
    registration.keyVersion !== job.keyVersion ||
    registration.consentRevision !== job.consentRevision
  ) {
    throw permanentFailure(
      "SYNC_REGISTRATION_AUTHORITY_CHANGED",
      "The projection authority changed after this job was queued.",
    );
  }
  if (registration.state !== "enabled" || !registration.plaintextBootstrapCompleted) {
    throw retryableFailure(
      "SYNC_REGISTRATION_NOT_ENABLED",
      "The projection registration is temporarily unable to push.",
    );
  }
}

function requireProjectableGeneration(
  marker: MaterializedSyncObject | null,
  job: SyncProjectionJob,
): void {
  if (
    marker !== null &&
    (marker.objectGeneration > job.objectGeneration ||
      (marker.objectGeneration === job.objectGeneration && marker.state === "deleted"))
  ) {
    throw permanentFailure(
      "SYNC_PROJECTION_GENERATION_STALE",
      "The projection object generation has already been deleted or superseded.",
    );
  }
  if (marker !== null && job.objectGeneration > marker.objectGeneration + 1) {
    throw permanentFailure(
      "SYNC_PROJECTION_GENERATION_INVALID",
      "The projection object generation skips a durable generation.",
    );
  }
}

function classifyProjectionFailure(cause: unknown): ProjectionFailure {
  if (cause instanceof ProjectionWorkerError) {
    return { code: cause.code, retryable: cause.retryable };
  }
  if (cause instanceof SyncCoreError) {
    return { code: cause.code, retryable: cause.retryable };
  }
  if (cause instanceof AppError) {
    return {
      code:
        cause.code === "INVALID_STATE_TRANSITION"
          ? "SYNC_PROJECTION_AUTHORITY_CHANGED"
          : "SYNC_PROJECTION_LOCAL_STORE_ERROR",
      retryable: cause.code === "INVALID_STATE_TRANSITION" || cause.retryable,
    };
  }
  return { code: "SYNC_PROJECTION_TRANSIENT", retryable: true };
}

class ProjectionWorkerError extends Error {
  public override readonly name = "ProjectionWorkerError";

  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

function permanentFailure(code: string, message: string): ProjectionWorkerError {
  return new ProjectionWorkerError(code, message, false);
}

function retryableFailure(code: string, message: string): ProjectionWorkerError {
  return new ProjectionWorkerError(code, message, true);
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function requireExactlyOne<Row>(rows: readonly Row[], code: string, message: string): Row {
  if (rows.length !== 1 || rows[0] === undefined) {
    throw permanentFailure(code, message);
  }
  return rows[0];
}

function requireVersionId(job: SyncProjectionJob): string {
  if (job.versionId === null) {
    throw permanentFailure(
      "SYNC_PROJECTION_VERSION_MISSING",
      "An upsert projection must reference an exact source version.",
    );
  }
  return job.versionId;
}

function requireLeaseOwner(job: SyncProjectionJob): string {
  if (job.status !== "leased" || job.leaseOwnerId === null) {
    throw retryableFailure("SYNC_PROJECTION_LEASE_LOST", "The projection lease is no longer held.");
  }
  return job.leaseOwnerId;
}

function requireLeaseToken(job: SyncProjectionJob): string {
  if (job.status !== "leased" || job.leaseToken === null) {
    throw retryableFailure("SYNC_PROJECTION_LEASE_LOST", "The projection lease is no longer held.");
  }
  return job.leaseToken;
}

function requireProjectStatus(value: string): "active" | "archived" | "trashed" {
  if (value !== "active" && value !== "archived" && value !== "trashed") {
    throw permanentFailure(
      "SYNC_PROJECTION_SOURCE_INVALID",
      "The project lifecycle state is invalid.",
    );
  }
  return value;
}

function requireProjectStatusBeforeTrash(value: string | null): "active" | "archived" | null {
  if (value !== null && value !== "active" && value !== "archived") {
    throw permanentFailure(
      "SYNC_PROJECTION_SOURCE_INVALID",
      "The project prior lifecycle state is invalid.",
    );
  }
  return value;
}

function requireChapterStatus(value: string): "active" | "trashed" {
  if (value !== "active" && value !== "trashed") {
    throw permanentFailure(
      "SYNC_PROJECTION_SOURCE_INVALID",
      "The chapter lifecycle state is invalid.",
    );
  }
  return value;
}

function requireChapterVersionReason(
  value: string,
): "created" | "autosave" | "manual" | "candidate_accept" | "recovery" | "import" {
  if (
    value !== "created" &&
    value !== "autosave" &&
    value !== "manual" &&
    value !== "candidate_accept" &&
    value !== "recovery" &&
    value !== "import"
  ) {
    throw permanentFailure(
      "SYNC_PROJECTION_SOURCE_INVALID",
      "The chapter version reason is invalid.",
    );
  }
  return value;
}

async function loadConflictResolutionVectorFloor(
  transaction: TransactionExecutor,
  job: SyncProjectionJob,
): Promise<VersionVector | null> {
  const rows = await transaction.select<ConflictResolutionVectorFloorRow>(
    `SELECT
       project_id,
       object_type,
       object_id,
       object_generation,
       remote_vector_json
     FROM sync_content_conflicts
     WHERE status = 'resolved'
       AND resolution_operation_id = ?`,
    [job.jobId],
  );
  if (rows.length === 0) {
    return null;
  }
  if (rows.length !== 1 || rows[0] === undefined) {
    throw permanentFailure(
      "SYNC_CONFLICT_RESOLUTION_VECTOR_AMBIGUOUS",
      "The conflict resolution vector floor is duplicated.",
    );
  }
  const row = rows[0];
  if (
    row.project_id !== job.projectId ||
    row.object_type !== job.objectType ||
    row.object_id !== job.objectId ||
    row.object_generation !== job.objectGeneration
  ) {
    throw permanentFailure(
      "SYNC_CONFLICT_RESOLUTION_VECTOR_MISMATCH",
      "The conflict resolution vector floor does not match its projection.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.remote_vector_json) as unknown;
  } catch {
    throw permanentFailure(
      "SYNC_CONFLICT_RESOLUTION_VECTOR_INVALID",
      "The conflict resolution vector floor is malformed.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw permanentFailure(
      "SYNC_CONFLICT_RESOLUTION_VECTOR_INVALID",
      "The conflict resolution vector floor is malformed.",
    );
  }
  try {
    return normalizeVersionVector(parsed as VersionVector);
  } catch {
    throw permanentFailure(
      "SYNC_CONFLICT_RESOLUTION_VECTOR_INVALID",
      "The conflict resolution vector floor is invalid.",
    );
  }
}

async function fingerprintProjectionSource(
  source: unknown,
  cryptoProvider: Crypto,
): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(source));
  const owned = new Uint8Array(encoded.byteLength);
  owned.set(encoded);
  try {
    const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", owned));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    owned.fill(0);
    encoded.fill(0);
  }
}

function sameMarker(
  left: MaterializedSyncObject | null,
  right: MaterializedSyncObject | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireSingleMutation(rowsAffected: number): void {
  if (rowsAffected !== 1) {
    throw retryableFailure(
      "SYNC_DEVICE_SEQUENCE_CHANGED",
      "The device sequence changed during reservation.",
    );
  }
}

function requirePositiveDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function requireCanonicalTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${field} must be a canonical ISO UTC timestamp.`);
  }
  return value;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp) + milliseconds;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("The projected timestamp is outside the supported range.");
  }
  return new Date(value).toISOString();
}

function monotonicFailureTimestamp(value: string, minimum: string): string {
  const timestamp = requireCanonicalTimestamp(value, "clock.now()");
  return Date.parse(timestamp) < Date.parse(minimum) ? minimum : timestamp;
}
