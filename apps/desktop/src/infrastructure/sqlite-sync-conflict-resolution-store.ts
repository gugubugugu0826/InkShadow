import {
  SyncMaterializationSqliteStore,
  enqueueSyncProjectionJobInTransaction,
  findCurrentSyncMaterializedObjectInTransaction,
  loadProjectSyncRegistrationInTransaction,
  loadSyncContentConflictInTransaction,
  resolveSyncContentConflictInTransaction,
  type ProjectSyncRegistration,
  type SqlExecutor,
  type SyncContentConflict,
  type TransactionExecutor,
} from "@inkshadow/data";
import type { IncomingSyncWork, SyncSqliteStore } from "@inkshadow/data/sync-sqlite-store";
import type { AppError, Result } from "@inkshadow/domain";

import type { ContentSyncMaterializer } from "./content-sync-materializer.js";
import type { PreparedChapterVersionUpsert } from "./incoming-content-decryptor.js";
import {
  SyncConflictResolutionError,
  type CommitSyncChapterConflictResolutionInput,
  type SyncConflictChapterBranch,
  type SyncConflictListItem,
  type SyncConflictResolutionCommitter,
  type SyncConflictResolutionReceipt,
  type SyncConflictReviewSource,
  type SyncConflictReviewSourceResult,
} from "./sync-conflict-resolution-coordinator.js";

interface ChapterRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly content: string;
  readonly status: string;
  readonly revision: number;
  readonly current_version_id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly trashed_at: string | null;
}

interface ChapterVersionRow {
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

interface InboxConflictRow {
  readonly project_id: string;
  readonly status: string;
  readonly resolution_token: string | null;
  readonly conflict_code: string | null;
}

export interface SqliteSyncConflictResolutionStoreDependencies {
  readonly executor: SqlExecutor;
  readonly syncStore: Pick<SyncSqliteStore, "loadIncomingWork">;
  readonly materializer: Pick<ContentSyncMaterializer, "prepare">;
}

/**
 * Local-only plaintext adapter for conflict review and resolution.
 *
 * The remote branch is decrypted only while a review is loaded. Durable
 * conflict records retain hashes, vectors, opaque operation IDs, and encrypted
 * inbox chunks; no plaintext branch is added to sync metadata or logs.
 */
export class SqliteSyncConflictResolutionStore
  implements SyncConflictReviewSource, SyncConflictResolutionCommitter
{
  private readonly conflicts: SyncMaterializationSqliteStore;

  public constructor(private readonly dependencies: SqliteSyncConflictResolutionStoreDependencies) {
    this.conflicts = new SyncMaterializationSqliteStore(dependencies.executor);
  }

  public async listUnresolved(projectId: string): Promise<readonly SyncConflictListItem[]> {
    const conflicts = unwrap(await this.conflicts.listUnresolvedContentConflicts(projectId, 200));
    return Promise.all(
      conflicts.map(async (conflict) => {
        const incoming = unwrap(
          await this.dependencies.syncStore.loadIncomingWork(conflict.remoteOperationId),
        );
        return {
          conflictId: conflict.conflictId,
          projectId: conflict.projectId,
          objectType: conflict.objectType,
          objectId: conflict.objectId,
          remoteKind: conflict.remoteKind,
          remoteDeviceId: incoming?.operation.deviceId ?? null,
          createdAt: conflict.createdAt,
        };
      }),
    );
  }

  public async loadReview(conflictId: string): Promise<SyncConflictReviewSourceResult> {
    const loaded = unwrap(await this.conflicts.loadContentConflict(conflictId));
    const conflict = requireUnresolvedConflict(loaded);
    const incoming = unwrap(
      await this.dependencies.syncStore.loadIncomingWork(conflict.remoteOperationId),
    );
    requireExactIncomingConflict(conflict, incoming);

    if (conflict.objectType !== "chapter_version") {
      return {
        status: "unsupported",
        conflict,
        reasonCode: "SYNC_CONFLICT_OBJECT_REVIEW_UNSUPPORTED",
      };
    }
    const local = await loadCurrentChapterBranch(
      this.dependencies.executor,
      conflict.projectId,
      conflict.objectId,
    );
    if (conflict.remoteKind === "delete") {
      return {
        status: "remote_delete",
        conflict,
        local,
      };
    }
    if (incoming === null) {
      throw conflictError(
        "SYNC_CONFLICT_INBOX_MISSING",
        "The encrypted remote conflict payload is unavailable.",
      );
    }

    const prepared = await this.dependencies.materializer.prepare(incoming);
    const remote = requireExactRemoteChapter(conflict, incoming, prepared);
    if (local === null) {
      return {
        status: "unsupported",
        conflict,
        reasonCode: "SYNC_CONFLICT_LOCAL_CHAPTER_MISSING",
      };
    }
    const base = await loadBaseVersion(
      this.dependencies.executor,
      conflict.projectId,
      conflict.objectId,
      remote.payload.version.parentVersionId,
    );
    return {
      status: "ready",
      conflict,
      local,
      remote: {
        chapterId: remote.payload.chapter.id,
        title: remote.payload.chapter.title,
        content: remote.payload.version.content,
        versionId: remote.payload.version.id,
        revision: remote.payload.version.sequence,
        contentChecksum: remote.payload.version.contentChecksum,
        updatedAt: remote.payload.chapter.updatedAt,
        deviceId: incoming.operation.deviceId,
      },
      base,
    };
  }

  public async commitChapterResolution(
    inputValue: CommitSyncChapterConflictResolutionInput,
  ): Promise<SyncConflictResolutionReceipt> {
    const input = normalizeCommit(inputValue);
    return this.dependencies.executor.transaction(async (transaction) => {
      const loaded = unwrap(
        await loadSyncContentConflictInTransaction(transaction, input.conflictId),
      );
      const conflict = requireUnresolvedChapterUpsertConflict(loaded);
      requireExpectedConflict(conflict, input);

      const inbox = await loadInboxConflict(transaction, conflict.remoteOperationId);
      if (
        inbox?.project_id !== conflict.projectId ||
        inbox.status !== "conflict" ||
        inbox.resolution_token === null ||
        inbox.conflict_code === null
      ) {
        throw conflictError(
          "SYNC_CONFLICT_INBOX_STATE_CHANGED",
          "The incoming conflict state changed before resolution.",
        );
      }

      const local = await loadCurrentChapterRows(
        transaction,
        conflict.projectId,
        conflict.objectId,
      );
      requireExpectedLocal(local, input);
      const registration = requireProjectRegistration(
        unwrap(await loadProjectSyncRegistrationInTransaction(transaction, conflict.projectId)),
      );
      const marker = unwrap(
        await findCurrentSyncMaterializedObjectInTransaction(
          transaction,
          conflict.projectId,
          "chapter_version",
          conflict.objectId,
        ),
      );
      if (marker?.state !== "present" || marker.objectGeneration !== conflict.objectGeneration) {
        throw conflictError(
          "SYNC_CONFLICT_MATERIALIZED_BASE_CHANGED",
          "The local materialized conflict base changed before resolution.",
        );
      }

      const nextRevision = increment(local.chapter.revision, "chapter revision");
      await insertChapterVersion(transaction, {
        id: input.stableVersionId,
        projectId: conflict.projectId,
        chapterId: conflict.objectId,
        parentVersionId: local.version.id,
        sequence: nextRevision,
        content: input.selectedContent,
        checksum: input.selectedContentChecksum,
        reason: "manual",
        createdAt: input.confirmedAt,
      });
      requireSingleMutation(
        (
          await transaction.execute(
            `UPDATE chapters
             SET title = ?,
                 content = ?,
                 revision = ?,
                 current_version_id = ?,
                 updated_at = ?
             WHERE id = ?
               AND project_id = ?
               AND revision = ?
               AND current_version_id = ?`,
            [
              input.selectedTitle,
              input.selectedContent,
              nextRevision,
              input.stableVersionId,
              input.confirmedAt,
              conflict.objectId,
              conflict.projectId,
              local.chapter.revision,
              local.version.id,
            ],
          )
        ).rowsAffected,
        "The local chapter changed before conflict resolution.",
      );
      await enqueueChapterProjection(transaction, registration, {
        jobId: input.projectionJobId,
        projectId: conflict.projectId,
        chapterId: conflict.objectId,
        versionId: input.stableVersionId,
        sourceRevision: nextRevision,
        objectGeneration: conflict.objectGeneration,
        now: input.confirmedAt,
      });

      let keptRemoteChapterId: string | null = null;
      let keptRemoteVersionId: string | null = null;
      if (input.action === "keep_both") {
        const remote = requireKeptRemote(input);
        keptRemoteChapterId = remote.chapterId;
        keptRemoteVersionId = remote.versionId;
        await insertKeptRemoteChapter(transaction, conflict.projectId, remote, input.confirmedAt);
        await enqueueChapterProjection(transaction, registration, {
          jobId: remote.projectionJobId,
          projectId: conflict.projectId,
          chapterId: remote.chapterId,
          versionId: remote.versionId,
          sourceRevision: 1,
          objectGeneration: 1,
          now: input.confirmedAt,
        });
      }

      const resolution =
        input.action === "manual_merge"
          ? "merged"
          : input.action === "keep_both"
            ? "dismissed"
            : input.action;
      unwrap(
        await resolveSyncContentConflictInTransaction(transaction, {
          conflictId: conflict.conflictId,
          expectedRevision: conflict.revision,
          resolution,
          // This UUID identifies the durable resolution projection request.
          // The projection worker uses it to include the remote vector floor.
          resolutionOperationId: input.projectionJobId,
          resolvedAt: input.confirmedAt,
        }),
      );
      requireSingleMutation(
        (
          await transaction.execute(
            `UPDATE sync_inbox_operations
             SET status = 'applied',
                 conflict_code = NULL,
                 updated_at = ?,
                 resolved_at = ?
             WHERE operation_id = ?
               AND project_id = ?
               AND status = 'conflict'
               AND conflict_code IS NOT NULL
               AND resolution_token IS NOT NULL`,
            [input.confirmedAt, input.confirmedAt, conflict.remoteOperationId, conflict.projectId],
          )
        ).rowsAffected,
        "The incoming conflict changed before resolution.",
      );

      return {
        conflictId: conflict.conflictId,
        action: input.action,
        stableVersionId: input.stableVersionId,
        projectionJobId: input.projectionJobId,
        keptRemoteChapterId,
        keptRemoteVersionId,
        replayed: false,
      };
    });
  }
}

async function loadCurrentChapterBranch(
  executor: TransactionExecutor,
  projectId: string,
  chapterId: string,
): Promise<SyncConflictChapterBranch | null> {
  const rows = await loadCurrentChapterRows(executor, projectId, chapterId, false);
  if (rows === null) {
    return null;
  }
  return {
    chapterId: rows.chapter.id,
    title: rows.chapter.title,
    content: rows.version.content,
    versionId: rows.version.id,
    revision: rows.chapter.revision,
    contentChecksum: rows.version.content_checksum,
    updatedAt: rows.chapter.updated_at,
    deviceId: null,
  };
}

async function loadCurrentChapterRows(
  executor: TransactionExecutor,
  projectId: string,
  chapterId: string,
  required = true,
): Promise<Readonly<{ chapter: ChapterRow; version: ChapterVersionRow }> | null> {
  const chapters = await executor.select<ChapterRow>(
    `SELECT *
     FROM chapters
     WHERE id = ? AND project_id = ?
     LIMIT 1`,
    [chapterId, projectId],
  );
  const chapter = chapters[0] ?? null;
  if (chapter === null) {
    if (required) {
      throw conflictError(
        "SYNC_CONFLICT_LOCAL_CHAPTER_MISSING",
        "The local chapter no longer exists.",
      );
    }
    return null;
  }
  const versions = await executor.select<ChapterVersionRow>(
    `SELECT *
     FROM chapter_versions
     WHERE id = ? AND chapter_id = ? AND project_id = ?
     LIMIT 1`,
    [chapter.current_version_id, chapterId, projectId],
  );
  const version = versions[0] ?? null;
  if (version?.sequence !== chapter.revision || version.content !== chapter.content) {
    throw conflictError(
      "SYNC_CONFLICT_LOCAL_VERSION_INVALID",
      "The local chapter and stable version are inconsistent.",
    );
  }
  return { chapter, version };
}

async function loadBaseVersion(
  executor: TransactionExecutor,
  projectId: string,
  chapterId: string,
  versionId: string | null,
): Promise<Readonly<{
  versionId: string;
  content: string;
  contentChecksum: string;
}> | null> {
  if (versionId === null) {
    return null;
  }
  const rows = await executor.select<ChapterVersionRow>(
    `SELECT *
     FROM chapter_versions
     WHERE id = ? AND chapter_id = ? AND project_id = ?
     LIMIT 1`,
    [versionId, chapterId, projectId],
  );
  const row = rows[0] ?? null;
  return row === null
    ? null
    : {
        versionId: row.id,
        content: row.content,
        contentChecksum: row.content_checksum,
      };
}

function requireExactRemoteChapter(
  conflict: Extract<SyncContentConflict, { status: "unresolved"; remoteKind: "upsert" }>,
  incoming: IncomingSyncWork,
  prepared: Awaited<ReturnType<ContentSyncMaterializer["prepare"]>>,
): PreparedChapterVersionUpsert {
  if (
    prepared.kind !== "upsert" ||
    prepared.objectType !== "chapter_version" ||
    prepared.projectId !== conflict.projectId ||
    prepared.objectId !== conflict.objectId ||
    prepared.objectGeneration !== conflict.objectGeneration ||
    prepared.sourceOperationId !== conflict.remoteOperationId ||
    prepared.payloadSha256 !== conflict.remotePayloadSha256 ||
    incoming.operation.operationId !== conflict.remoteOperationId
  ) {
    throw conflictError(
      "SYNC_CONFLICT_REMOTE_PAYLOAD_MISMATCH",
      "The decrypted remote branch does not match the conflict record.",
    );
  }
  return prepared;
}

function requireExactIncomingConflict(
  conflict: Extract<SyncContentConflict, { status: "unresolved" }>,
  incoming: IncomingSyncWork | null,
): void {
  if (
    incoming?.status !== "conflict" ||
    incoming.operation.operationId !== conflict.remoteOperationId ||
    incoming.operation.projectId !== conflict.projectId ||
    incoming.operation.objectType !== conflict.objectType ||
    incoming.operation.objectId !== conflict.objectId ||
    incoming.operation.objectGeneration !== conflict.objectGeneration ||
    incoming.operation.kind !== conflict.remoteKind
  ) {
    throw conflictError(
      "SYNC_CONFLICT_INBOX_MISMATCH",
      "The durable incoming conflict evidence is unavailable or inconsistent.",
    );
  }
}

async function loadInboxConflict(
  transaction: TransactionExecutor,
  operationId: string,
): Promise<InboxConflictRow | null> {
  const rows = await transaction.select<InboxConflictRow>(
    `SELECT project_id, status, resolution_token, conflict_code
     FROM sync_inbox_operations
     WHERE operation_id = ?
     LIMIT 1`,
    [operationId],
  );
  return rows[0] ?? null;
}

function requireProjectRegistration(
  registration: ProjectSyncRegistration | null,
): ProjectSyncRegistration {
  if (
    registration === null ||
    registration.state === "disabled" ||
    !registration.plaintextBootstrapCompleted
  ) {
    throw conflictError(
      "SYNC_CONFLICT_PROJECT_AUTHORITY_UNAVAILABLE",
      "The project sync authority is unavailable for a durable resolution.",
    );
  }
  return registration;
}

function requireExpectedConflict(
  conflict: Extract<SyncContentConflict, { status: "unresolved"; remoteKind: "upsert" }>,
  input: CommitSyncChapterConflictResolutionInput,
): void {
  if (
    conflict.revision !== input.expectedConflictRevision ||
    conflict.remoteOperationId !== input.expectedRemoteOperationId ||
    conflict.remotePayloadSha256 !== input.expectedRemotePayloadSha256
  ) {
    throw conflictError(
      "SYNC_CONFLICT_REVIEW_STALE",
      "The conflict changed after it was reviewed.",
    );
  }
}

function requireExpectedLocal(
  local: Readonly<{ chapter: ChapterRow; version: ChapterVersionRow }> | null,
  input: CommitSyncChapterConflictResolutionInput,
): asserts local is Readonly<{ chapter: ChapterRow; version: ChapterVersionRow }> {
  if (
    local?.chapter.status !== "active" ||
    local.chapter.revision !== input.expectedLocalRevision ||
    local.version.id !== input.expectedLocalVersionId ||
    local.version.content_checksum !== input.expectedLocalContentChecksum
  ) {
    throw conflictError(
      "SYNC_CONFLICT_REVIEW_STALE",
      "The local branch changed after it was reviewed.",
    );
  }
}

async function insertChapterVersion(
  transaction: TransactionExecutor,
  input: Readonly<{
    id: string;
    projectId: string;
    chapterId: string;
    parentVersionId: string | null;
    sequence: number;
    content: string;
    checksum: string;
    reason: "created" | "manual";
    createdAt: string;
  }>,
): Promise<void> {
  requireSingleMutation(
    (
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          input.id,
          input.projectId,
          input.chapterId,
          input.parentVersionId,
          input.sequence,
          input.content,
          input.checksum,
          input.reason,
          input.createdAt,
        ],
      )
    ).rowsAffected,
    "The stable conflict-resolution version was not created.",
  );
}

async function enqueueChapterProjection(
  transaction: TransactionExecutor,
  registration: ProjectSyncRegistration,
  input: Readonly<{
    jobId: string;
    projectId: string;
    chapterId: string;
    versionId: string;
    sourceRevision: number;
    objectGeneration: number;
    now: string;
  }>,
): Promise<void> {
  unwrap(
    await enqueueSyncProjectionJobInTransaction(transaction, {
      jobId: input.jobId,
      projectId: input.projectId,
      accountId: registration.accountId,
      objectType: "chapter_version",
      objectId: input.chapterId,
      objectGeneration: input.objectGeneration,
      projectionKind: "upsert",
      versionId: input.versionId,
      sourceRevision: input.sourceRevision,
      keyVersion: registration.keyVersion,
      consentRevision: registration.consentRevision,
      deviceId: registration.deviceId,
      createdAt: input.now,
      nextAttemptAt: input.now,
    }),
  );
}

async function insertKeptRemoteChapter(
  transaction: TransactionExecutor,
  projectId: string,
  remote: Readonly<{
    chapterId: string;
    versionId: string;
    projectionJobId: string;
    title: string;
    content: string;
    checksum: string;
  }>,
  now: string,
): Promise<void> {
  const title = conflictCopyTitle(remote.title);
  // Chapter/version references are deferrable, but inserting the chapter and
  // immutable initial version in one transaction keeps the pair indivisible.
  requireSingleMutation(
    (
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision,
           current_version_id, created_at, updated_at, trashed_at
         ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL)`,
        [remote.chapterId, projectId, title, remote.content, remote.versionId, now, now],
      )
    ).rowsAffected,
    "The retained remote chapter was not created.",
  );
  await insertChapterVersion(transaction, {
    id: remote.versionId,
    projectId,
    chapterId: remote.chapterId,
    parentVersionId: null,
    sequence: 1,
    content: remote.content,
    checksum: remote.checksum,
    reason: "created",
    createdAt: now,
  });
}

function requireKeptRemote(input: CommitSyncChapterConflictResolutionInput): Readonly<{
  chapterId: string;
  versionId: string;
  projectionJobId: string;
  title: string;
  content: string;
  checksum: string;
}> {
  if (
    input.keptRemoteChapterId === null ||
    input.keptRemoteVersionId === null ||
    input.keptRemoteProjectionJobId === null ||
    input.keptRemoteTitle === null ||
    input.keptRemoteContent === null ||
    input.keptRemoteContentChecksum === null
  ) {
    throw conflictError(
      "SYNC_CONFLICT_KEEP_BOTH_INVALID",
      "Keeping both branches requires the exact reviewed remote branch.",
    );
  }
  return {
    chapterId: input.keptRemoteChapterId,
    versionId: input.keptRemoteVersionId,
    projectionJobId: input.keptRemoteProjectionJobId,
    title: input.keptRemoteTitle,
    content: input.keptRemoteContent,
    checksum: input.keptRemoteContentChecksum,
  };
}

function normalizeCommit(
  input: CommitSyncChapterConflictResolutionInput,
): CommitSyncChapterConflictResolutionInput {
  for (const [field, value] of [
    ["conflictId", input.conflictId],
    ["expectedRemoteOperationId", input.expectedRemoteOperationId],
    ["expectedLocalVersionId", input.expectedLocalVersionId],
    ["stableVersionId", input.stableVersionId],
    ["projectionJobId", input.projectionJobId],
  ] as const) {
    requireUuid(value, field);
  }
  requireSha(input.expectedRemotePayloadSha256, "expectedRemotePayloadSha256");
  requireSha(input.expectedLocalContentChecksum, "expectedLocalContentChecksum");
  requireSha(input.selectedContentChecksum, "selectedContentChecksum");
  requireTimestamp(input.confirmedAt, "confirmedAt");
  requirePositive(input.expectedConflictRevision, "expectedConflictRevision");
  requirePositive(input.expectedLocalRevision, "expectedLocalRevision");
  if (
    input.selectedTitle.trim() !== input.selectedTitle ||
    input.selectedTitle.length < 1 ||
    input.selectedTitle.length > 200 ||
    input.selectedContent.length > 5_000_000 ||
    input.selectedContent.includes("\u0000")
  ) {
    throw conflictError(
      "SYNC_CONFLICT_RESOLUTION_CONTENT_INVALID",
      "The selected conflict resolution content is invalid.",
    );
  }
  const keepBoth = input.action === "keep_both";
  const keptValues = [
    input.keptRemoteChapterId,
    input.keptRemoteVersionId,
    input.keptRemoteProjectionJobId,
    input.keptRemoteTitle,
    input.keptRemoteContent,
    input.keptRemoteContentChecksum,
  ];
  if (keptValues.some((value) => (keepBoth ? value === null : value !== null))) {
    throw conflictError(
      "SYNC_CONFLICT_KEEP_BOTH_INVALID",
      "The retained remote branch fields are inconsistent.",
    );
  }
  if (keepBoth) {
    requireUuid(input.keptRemoteChapterId ?? "", "keptRemoteChapterId");
    requireUuid(input.keptRemoteVersionId ?? "", "keptRemoteVersionId");
    requireUuid(input.keptRemoteProjectionJobId ?? "", "keptRemoteProjectionJobId");
    requireSha(input.keptRemoteContentChecksum ?? "", "keptRemoteContentChecksum");
  }
  return input;
}

function requireUnresolvedConflict(
  value: SyncContentConflict | null,
): Extract<SyncContentConflict, { status: "unresolved" }> {
  if (value === null) {
    throw conflictError("SYNC_CONFLICT_NOT_FOUND", "The sync conflict does not exist.");
  }
  if (value.status !== "unresolved") {
    throw conflictError("SYNC_CONFLICT_ALREADY_RESOLVED", "The sync conflict is already resolved.");
  }
  return value;
}

function requireUnresolvedChapterUpsertConflict(
  value: SyncContentConflict | null,
): Extract<SyncContentConflict, { status: "unresolved"; remoteKind: "upsert" }> {
  const conflict = requireUnresolvedConflict(value);
  if (conflict.objectType !== "chapter_version" || conflict.remoteKind !== "upsert") {
    throw conflictError(
      "SYNC_CONFLICT_RESOLUTION_UNSUPPORTED",
      "Only reviewed chapter upsert conflicts use this resolution transaction.",
    );
  }
  return conflict;
}

function conflictCopyTitle(value: string): string {
  const suffix = "（冲突副本）";
  return `${value.slice(0, Math.max(1, 200 - suffix.length))}${suffix}`;
}

function increment(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw conflictError("SYNC_CONFLICT_REVISION_EXHAUSTED", `${field} cannot advance.`);
  }
  return value + 1;
}

function requireSingleMutation(rowsAffected: number, message: string): void {
  if (rowsAffected !== 1) {
    throw conflictError("SYNC_CONFLICT_CONCURRENT_CHANGE", message);
  }
}

function requireUuid(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw conflictError("SYNC_CONFLICT_INPUT_INVALID", `${field} must be a UUIDv7.`);
  }
  return value;
}

function requireSha(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw conflictError("SYNC_CONFLICT_INPUT_INVALID", `${field} must be a SHA-256 digest.`);
  }
  return value;
}

function requireTimestamp(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw conflictError("SYNC_CONFLICT_INPUT_INVALID", `${field} must be canonical UTC.`);
  }
  return value;
}

function requirePositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw conflictError("SYNC_CONFLICT_INPUT_INVALID", `${field} must be positive.`);
  }
  return value;
}

function conflictError(code: string, message: string): SyncConflictResolutionError {
  return new SyncConflictResolutionError(code, message);
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
