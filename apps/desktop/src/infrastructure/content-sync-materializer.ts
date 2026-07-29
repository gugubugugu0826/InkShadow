import {
  findCurrentSyncMaterializedObjectInTransaction,
  findSyncMaterializedObjectInTransaction,
  registerSyncContentConflictInTransaction,
  writeSyncMaterializedObjectInTransaction,
  type MaterializedSyncObject,
  type TransactionExecutor,
} from "@inkshadow/data";
import { type AppError, type Result } from "@inkshadow/domain";
import {
  SyncCoreError,
  compareVersionVectors,
  type ContentSyncChapterSnapshot,
  type ContentSyncChapterVersionSnapshot,
  type ContentSyncProjectSnapshot,
} from "@inkshadow/sync-core";

import {
  fingerprintIncomingContentCiphertextWork,
  type IncomingContentDecryptor,
  type IncomingContentCiphertextWork,
  type PreparedChapterVersionUpsert,
  type PreparedIncomingContentDelete,
  type PreparedIncomingContentMutation,
  type PreparedProjectManifestUpsert,
} from "./incoming-content-decryptor.js";

export type ContentSyncMaterializationSkipReason =
  | "duplicate"
  | "older_generation"
  | "causally_older"
  | "bootstrap_business_match"
  | "historical_business_match"
  | "already_deleted";

interface ContentSyncMaterializationOutcomeBase {
  readonly projectId: string;
  readonly objectType: "project_manifest" | "chapter_version";
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly sourceOperationId: string;
}

export type ContentSyncMaterializationOutcome =
  | (ContentSyncMaterializationOutcomeBase &
      Readonly<{
        status: "applied";
        marker: MaterializedSyncObject;
      }>)
  | (ContentSyncMaterializationOutcomeBase &
      Readonly<{
        status: "skipped";
        reason: ContentSyncMaterializationSkipReason;
        marker: MaterializedSyncObject | null;
      }>)
  | (ContentSyncMaterializationOutcomeBase &
      Readonly<{
        status: "conflict";
        conflictId: string;
      }>)
  | (ContentSyncMaterializationOutcomeBase &
      Readonly<{
        status: "retry";
        code: "SYNC_PROJECT_MANIFEST_MISSING" | "SYNC_PARENT_VERSION_MISSING";
        missingId: string;
      }>);

type MaterializationDecision =
  | Readonly<{ kind: "apply" }>
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{ kind: "skip"; reason: "older_generation" | "causally_older" }>
  | Readonly<{ kind: "conflict" }>;

interface ProjectDbRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly revision: number;
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

/**
 * Authenticates incoming ciphertext outside SQLite, then materializes the
 * already-prepared plaintext inside a caller-owned transaction.
 */
export class ContentSyncMaterializer {
  public constructor(private readonly decryptor: IncomingContentDecryptor) {}

  public prepare(work: IncomingContentCiphertextWork): Promise<PreparedIncomingContentMutation> {
    return this.decryptor.prepare(work);
  }

  public async applyPrepared(
    transaction: TransactionExecutor,
    exactWork: IncomingContentCiphertextWork,
    prepared: PreparedIncomingContentMutation,
    nowValue: string,
  ): Promise<ContentSyncMaterializationOutcome> {
    const now = requireCanonicalTimestamp(nowValue, "now");
    const exactFingerprint = await fingerprintIncomingContentCiphertextWork(exactWork);
    if (!constantTimeEqualHex(exactFingerprint, prepared.operationFingerprint)) {
      throw new SyncCoreError(
        "SYNC_TRANSFER_MISMATCH",
        "Prepared plaintext does not belong to the exact incoming ciphertext work.",
      );
    }

    const exact = unwrap(
      await findSyncMaterializedObjectInTransaction(
        transaction,
        prepared.projectId,
        prepared.objectType,
        prepared.objectId,
        prepared.objectGeneration,
      ),
    );
    const current = unwrap(
      await findCurrentSyncMaterializedObjectInTransaction(
        transaction,
        prepared.projectId,
        prepared.objectType,
        prepared.objectId,
      ),
    );
    const remoteMarker = markerForPrepared(prepared, now);
    const decision = decideMaterialization(current, exact, remoteMarker);

    if (decision.kind === "conflict") {
      return this.registerConflict(transaction, prepared, current, now);
    }
    if (decision.kind === "skip") {
      return skippedOutcome(prepared, decision.reason, exact);
    }

    if (prepared.kind === "delete") {
      return this.applyDelete(transaction, prepared, current, exact, decision, now);
    }
    if (prepared.objectType === "project_manifest") {
      return this.applyProjectManifest(transaction, prepared, current, exact, decision, now);
    }
    return this.applyChapterVersion(transaction, prepared, current, exact, decision, now);
  }

  private async applyProjectManifest(
    transaction: TransactionExecutor,
    prepared: PreparedProjectManifestUpsert,
    current: MaterializedSyncObject | null,
    exact: MaterializedSyncObject | null,
    decision: Extract<MaterializationDecision, { kind: "apply" | "duplicate" }>,
    now: string,
  ): Promise<ContentSyncMaterializationOutcome> {
    const local = await findProject(transaction, prepared.projectId);
    const businessMatches = local !== null && sameProject(local, prepared.payload.project);

    if (decision.kind === "duplicate") {
      if (!businessMatches) {
        throw materializationCorruption(
          "A duplicate project marker does not match the materialized project row.",
        );
      }
      return skippedOutcome(prepared, "duplicate", exact ?? current);
    }

    if (current === null) {
      if (local === null) {
        await insertProject(transaction, prepared.payload.project);
        return appliedOutcome(prepared, await this.writeMarker(transaction, prepared, exact, now));
      }
      if (businessMatches) {
        return skippedOutcome(
          prepared,
          "bootstrap_business_match",
          await this.writeMarker(transaction, prepared, exact, now),
        );
      }
      if (local.revision > prepared.payload.project.revision) {
        return skippedOutcome(
          prepared,
          "historical_business_match",
          await this.writeMarker(transaction, prepared, exact, now),
        );
      }
      return this.registerConflict(transaction, prepared, current, now);
    }

    if (local === null) {
      throw materializationCorruption(
        "A trusted project materialization marker has no project row.",
      );
    }
    if (local.revision > prepared.payload.project.revision) {
      return this.registerConflict(transaction, prepared, current, now);
    }
    if (local.revision === prepared.payload.project.revision) {
      if (!businessMatches) {
        return this.registerConflict(transaction, prepared, current, now);
      }
      return skippedOutcome(
        prepared,
        "bootstrap_business_match",
        await this.writeMarker(transaction, prepared, exact, now),
      );
    }

    await updateProject(transaction, prepared.payload.project);
    return appliedOutcome(prepared, await this.writeMarker(transaction, prepared, exact, now));
  }

  private async applyChapterVersion(
    transaction: TransactionExecutor,
    prepared: PreparedChapterVersionUpsert,
    current: MaterializedSyncObject | null,
    exact: MaterializedSyncObject | null,
    decision: Extract<MaterializationDecision, { kind: "apply" | "duplicate" }>,
    now: string,
  ): Promise<ContentSyncMaterializationOutcome> {
    if ((await findProject(transaction, prepared.projectId)) === null) {
      return retryOutcome(prepared, "SYNC_PROJECT_MANIFEST_MISSING", prepared.projectId);
    }

    const { chapter, version } = prepared.payload;
    const [localChapter, exactVersion, sequenceVersion] = await Promise.all([
      findChapter(transaction, chapter.id),
      findChapterVersion(transaction, version.id),
      findChapterVersionBySequence(transaction, chapter.id, version.sequence),
    ]);
    if (exactVersion !== null && !sameChapterVersion(exactVersion, version)) {
      return this.registerConflict(transaction, prepared, current, now);
    }
    if (sequenceVersion !== null && sequenceVersion.id !== version.id) {
      return this.registerConflict(transaction, prepared, current, now);
    }

    const parent = await this.findAndValidateParent(transaction, prepared);
    if (parent.kind === "retry") {
      return retryOutcome(prepared, "SYNC_PARENT_VERSION_MISSING", parent.parentVersionId);
    }
    if (parent.kind === "conflict") {
      return this.registerConflict(transaction, prepared, current, now);
    }

    const businessMatches =
      localChapter !== null &&
      exactVersion !== null &&
      sameChapter(localChapter, chapter) &&
      sameChapterVersion(exactVersion, version);
    if (decision.kind === "duplicate") {
      if (!businessMatches) {
        const historicalMatch =
          localChapter !== null &&
          localChapter.revision > version.sequence &&
          exactVersion !== null &&
          sameChapterVersion(exactVersion, version);
        if (historicalMatch) {
          return skippedOutcome(prepared, "historical_business_match", exact ?? current);
        }
        throw materializationCorruption(
          "A duplicate chapter marker does not match its immutable business rows.",
        );
      }
      return skippedOutcome(prepared, "duplicate", exact ?? current);
    }

    if (current === null) {
      if (localChapter === null) {
        if (version.sequence !== 1) {
          return retryOutcome(
            prepared,
            "SYNC_PARENT_VERSION_MISSING",
            version.parentVersionId ?? version.id,
          );
        }
        await insertChapterAndVersion(transaction, chapter, version);
        return appliedOutcome(prepared, await this.writeMarker(transaction, prepared, exact, now));
      }
      if (businessMatches) {
        return skippedOutcome(
          prepared,
          "bootstrap_business_match",
          await this.writeMarker(transaction, prepared, exact, now),
        );
      }
      if (
        localChapter.revision > version.sequence &&
        exactVersion !== null &&
        sameChapterVersion(exactVersion, version)
      ) {
        return skippedOutcome(
          prepared,
          "historical_business_match",
          await this.writeMarker(transaction, prepared, exact, now),
        );
      }
      return this.registerConflict(transaction, prepared, current, now);
    }

    if (localChapter === null) {
      throw materializationCorruption(
        "A trusted chapter materialization marker has no chapter row.",
      );
    }
    if (localChapter.revision > version.sequence) {
      if (exactVersion !== null && sameChapterVersion(exactVersion, version)) {
        return skippedOutcome(
          prepared,
          "historical_business_match",
          await this.writeMarker(transaction, prepared, exact, now),
        );
      }
      return this.registerConflict(transaction, prepared, current, now);
    }
    if (localChapter.revision === version.sequence) {
      if (!businessMatches) {
        return this.registerConflict(transaction, prepared, current, now);
      }
      return skippedOutcome(
        prepared,
        "bootstrap_business_match",
        await this.writeMarker(transaction, prepared, exact, now),
      );
    }
    if (
      version.parentVersionId !== localChapter.current_version_id ||
      parent.kind !== "present" ||
      parent.version.sequence !== version.sequence - 1
    ) {
      return this.registerConflict(transaction, prepared, current, now);
    }

    if (exactVersion === null) {
      await insertChapterVersion(transaction, version);
    }
    await updateChapter(transaction, chapter);
    return appliedOutcome(prepared, await this.writeMarker(transaction, prepared, exact, now));
  }

  private async applyDelete(
    transaction: TransactionExecutor,
    prepared: PreparedIncomingContentDelete,
    current: MaterializedSyncObject | null,
    exact: MaterializedSyncObject | null,
    decision: Extract<MaterializationDecision, { kind: "apply" | "duplicate" }>,
    now: string,
  ): Promise<ContentSyncMaterializationOutcome> {
    assertLegalDelete(prepared);

    if (prepared.objectType === "project_manifest") {
      const local = await findProject(transaction, prepared.projectId);
      const matches = local !== null && projectMatchesDelete(local, prepared);
      if (decision.kind === "duplicate") {
        if (local !== null && !matches) {
          throw materializationCorruption(
            "A duplicate project deletion marker does not match project lifecycle state.",
          );
        }
        return skippedOutcome(prepared, "duplicate", exact ?? current);
      }
      if (current === null && local !== null && !matches) {
        return this.registerConflict(transaction, prepared, current, now);
      }
      if (local === null) {
        return retryOutcome(prepared, "SYNC_PROJECT_MANIFEST_MISSING", prepared.projectId);
      }
      if (!matches) {
        await logicallyDeleteProject(transaction, prepared);
      }
      const marker = await this.writeMarker(transaction, prepared, exact, now);
      return matches
        ? skippedOutcome(prepared, "already_deleted", marker)
        : appliedOutcome(prepared, marker);
    }

    if ((await findProject(transaction, prepared.projectId)) === null) {
      return retryOutcome(prepared, "SYNC_PROJECT_MANIFEST_MISSING", prepared.projectId);
    }
    const local = await findChapter(transaction, prepared.objectId);
    const matches = local !== null && chapterMatchesDelete(local, prepared);
    if (decision.kind === "duplicate") {
      if (local !== null && !matches) {
        throw materializationCorruption(
          "A duplicate chapter deletion marker does not match chapter lifecycle state.",
        );
      }
      return skippedOutcome(prepared, "duplicate", exact ?? current);
    }
    if (current === null && local !== null && !matches) {
      return this.registerConflict(transaction, prepared, current, now);
    }
    if (local !== null && !matches) {
      await logicallyDeleteChapter(transaction, prepared);
    }
    const marker = await this.writeMarker(transaction, prepared, exact, now);
    return local === null || matches
      ? skippedOutcome(prepared, "already_deleted", marker)
      : appliedOutcome(prepared, marker);
  }

  private async findAndValidateParent(
    transaction: TransactionExecutor,
    prepared: PreparedChapterVersionUpsert,
  ): Promise<
    | Readonly<{ kind: "none" }>
    | Readonly<{ kind: "present"; version: ChapterVersionDbRow }>
    | Readonly<{ kind: "retry"; parentVersionId: string }>
    | Readonly<{ kind: "conflict" }>
  > {
    const version = prepared.payload.version;
    if (version.parentVersionId === null) {
      return version.sequence === 1 ? { kind: "none" } : { kind: "conflict" };
    }
    const parent = await findChapterVersion(transaction, version.parentVersionId);
    if (parent === null) {
      return { kind: "retry", parentVersionId: version.parentVersionId };
    }
    if (
      parent.project_id !== prepared.projectId ||
      parent.chapter_id !== prepared.objectId ||
      parent.sequence !== version.sequence - 1
    ) {
      return { kind: "conflict" };
    }
    return { kind: "present", version: parent };
  }

  private async writeMarker(
    transaction: TransactionExecutor,
    prepared: PreparedIncomingContentMutation,
    exact: MaterializedSyncObject | null,
    now: string,
  ): Promise<MaterializedSyncObject> {
    return unwrap(
      await writeSyncMaterializedObjectInTransaction(transaction, {
        object: markerForPrepared(prepared, now),
        expectedSourceOperationId: exact?.sourceOperationId ?? null,
      }),
    );
  }

  private async registerConflict(
    transaction: TransactionExecutor,
    prepared: PreparedIncomingContentMutation,
    current: MaterializedSyncObject | null,
    now: string,
  ): Promise<ContentSyncMaterializationOutcome> {
    // conflictId is the UUIDv7 remote operation id itself. This is stable and
    // satisfies the data authority store's UUID-only identifier contract.
    const conflictId = prepared.sourceOperationId;
    unwrap(
      await registerSyncContentConflictInTransaction(transaction, {
        conflictId,
        projectId: prepared.projectId,
        objectType: prepared.objectType,
        objectId: prepared.objectId,
        objectGeneration: prepared.objectGeneration,
        localVector: current?.vector ?? {},
        remoteVector: prepared.vector,
        remoteOperationId: prepared.sourceOperationId,
        remoteKind: prepared.kind,
        remotePayloadSha256: prepared.kind === "upsert" ? prepared.payloadSha256 : null,
        createdAt: now,
      }),
    );
    return {
      ...outcomeIdentity(prepared),
      status: "conflict",
      conflictId,
    };
  }
}

function decideMaterialization(
  current: MaterializedSyncObject | null,
  exact: MaterializedSyncObject | null,
  remote: MaterializedSyncObject,
): MaterializationDecision {
  if (exact !== null && exact.objectGeneration !== remote.objectGeneration) {
    throw materializationCorruption("The exact materialized marker has the wrong generation.");
  }
  if (current === null) {
    return { kind: "apply" };
  }
  if (remote.objectGeneration < current.objectGeneration) {
    if (exact !== null && !sameMarkerState(exact, remote)) {
      return { kind: "conflict" };
    }
    return { kind: "skip", reason: "older_generation" };
  }
  if (remote.objectGeneration > current.objectGeneration) {
    return { kind: "apply" };
  }

  const relation = compareVersionVectors(current.vector, remote.vector);
  if (relation === "before") {
    return { kind: "apply" };
  }
  if (relation === "after") {
    return { kind: "skip", reason: "causally_older" };
  }
  if (relation === "concurrent") {
    return { kind: "conflict" };
  }
  return sameMarkerState(current, remote) ? { kind: "duplicate" } : { kind: "conflict" };
}

function markerForPrepared(
  prepared: PreparedIncomingContentMutation,
  now: string,
): MaterializedSyncObject {
  const base = {
    projectId: prepared.projectId,
    objectType: prepared.objectType,
    objectId: prepared.objectId,
    objectGeneration: prepared.objectGeneration,
    vector: prepared.vector,
    sourceOperationId: prepared.sourceOperationId,
    sourceDeviceId: prepared.sourceDeviceId,
    sourceDeviceSequence: prepared.sourceDeviceSequence,
    materializedAt: now,
  };
  return prepared.kind === "upsert"
    ? {
        ...base,
        state: "present",
        versionId: prepared.versionId,
        payloadSha256: prepared.payloadSha256,
      }
    : {
        ...base,
        state: "deleted",
        versionId: null,
        payloadSha256: null,
      };
}

function sameMarkerState(left: MaterializedSyncObject, right: MaterializedSyncObject): boolean {
  return (
    left.state === right.state &&
    left.versionId === right.versionId &&
    left.payloadSha256 === right.payloadSha256
  );
}

function outcomeIdentity(
  prepared: PreparedIncomingContentMutation,
): ContentSyncMaterializationOutcomeBase {
  return {
    projectId: prepared.projectId,
    objectType: prepared.objectType,
    objectId: prepared.objectId,
    objectGeneration: prepared.objectGeneration,
    sourceOperationId: prepared.sourceOperationId,
  };
}

function appliedOutcome(
  prepared: PreparedIncomingContentMutation,
  marker: MaterializedSyncObject,
): ContentSyncMaterializationOutcome {
  return { ...outcomeIdentity(prepared), status: "applied", marker };
}

function skippedOutcome(
  prepared: PreparedIncomingContentMutation,
  reason: ContentSyncMaterializationSkipReason,
  marker: MaterializedSyncObject | null,
): ContentSyncMaterializationOutcome {
  return { ...outcomeIdentity(prepared), status: "skipped", reason, marker };
}

function retryOutcome(
  prepared: PreparedIncomingContentMutation,
  code: "SYNC_PROJECT_MANIFEST_MISSING" | "SYNC_PARENT_VERSION_MISSING",
  missingId: string,
): ContentSyncMaterializationOutcome {
  return { ...outcomeIdentity(prepared), status: "retry", code, missingId };
}

async function findProject(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<ProjectDbRow | null> {
  return requireAtMostOne(
    await transaction.select<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", [projectId]),
    "A project identifier resolved to duplicate rows.",
  );
}

async function findChapter(
  transaction: TransactionExecutor,
  chapterId: string,
): Promise<ChapterDbRow | null> {
  return requireAtMostOne(
    await transaction.select<ChapterDbRow>("SELECT * FROM chapters WHERE id = ?", [chapterId]),
    "A chapter identifier resolved to duplicate rows.",
  );
}

async function findChapterVersion(
  transaction: TransactionExecutor,
  versionId: string,
): Promise<ChapterVersionDbRow | null> {
  return requireAtMostOne(
    await transaction.select<ChapterVersionDbRow>("SELECT * FROM chapter_versions WHERE id = ?", [
      versionId,
    ]),
    "A chapter version identifier resolved to duplicate rows.",
  );
}

async function findChapterVersionBySequence(
  transaction: TransactionExecutor,
  chapterId: string,
  sequence: number,
): Promise<ChapterVersionDbRow | null> {
  return requireAtMostOne(
    await transaction.select<ChapterVersionDbRow>(
      "SELECT * FROM chapter_versions WHERE chapter_id = ? AND sequence = ?",
      [chapterId, sequence],
    ),
    "A chapter sequence resolved to duplicate immutable versions.",
  );
}

async function insertProject(
  transaction: TransactionExecutor,
  project: ContentSyncProjectSnapshot,
): Promise<void> {
  requireOneMutation(
    await transaction.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at,
         archived_at, trashed_at, retention_until, status_before_trash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectBindings(project),
    ),
    "The incoming project was not inserted.",
  );
}

async function updateProject(
  transaction: TransactionExecutor,
  project: ContentSyncProjectSnapshot,
): Promise<void> {
  requireOneMutation(
    await transaction.execute(
      `UPDATE projects
       SET name = ?, status = ?, revision = ?, deletion_generation = ?,
           created_at = ?, updated_at = ?, archived_at = ?, trashed_at = ?,
           retention_until = ?, status_before_trash = ?
       WHERE id = ?`,
      [
        project.name,
        project.status,
        project.revision,
        project.deletionGeneration,
        project.createdAt,
        project.updatedAt,
        project.archivedAt,
        project.trashedAt,
        project.retentionUntil,
        project.statusBeforeTrash,
        project.id,
      ],
    ),
    "The incoming project changed before materialization.",
  );
}

function projectBindings(project: ContentSyncProjectSnapshot): readonly (string | number | null)[] {
  return [
    project.id,
    project.name,
    project.status,
    project.revision,
    project.deletionGeneration,
    project.createdAt,
    project.updatedAt,
    project.archivedAt,
    project.trashedAt,
    project.retentionUntil,
    project.statusBeforeTrash,
  ];
}

async function insertChapterAndVersion(
  transaction: TransactionExecutor,
  chapter: ContentSyncChapterSnapshot,
  version: ContentSyncChapterVersionSnapshot,
): Promise<void> {
  requireOneMutation(
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision, current_version_id,
         created_at, updated_at, trashed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chapterBindings(chapter),
    ),
    "The incoming chapter was not inserted.",
  );
  await insertChapterVersion(transaction, version);
}

async function insertChapterVersion(
  transaction: TransactionExecutor,
  version: ContentSyncChapterVersionSnapshot,
): Promise<void> {
  requireOneMutation(
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        version.id,
        version.projectId,
        version.chapterId,
        version.parentVersionId,
        version.sequence,
        version.content,
        version.contentChecksum,
        version.reason,
        version.sourceCandidateId,
        version.createdAt,
      ],
    ),
    "The immutable incoming chapter version was not inserted.",
  );
}

async function updateChapter(
  transaction: TransactionExecutor,
  chapter: ContentSyncChapterSnapshot,
): Promise<void> {
  requireOneMutation(
    await transaction.execute(
      `UPDATE chapters
       SET project_id = ?, title = ?, content = ?, status = ?, revision = ?,
           current_version_id = ?, created_at = ?, updated_at = ?, trashed_at = ?
       WHERE id = ?`,
      [
        chapter.projectId,
        chapter.title,
        chapter.content,
        chapter.status,
        chapter.revision,
        chapter.currentVersionId,
        chapter.createdAt,
        chapter.updatedAt,
        chapter.trashedAt,
        chapter.id,
      ],
    ),
    "The incoming chapter changed before materialization.",
  );
}

function chapterBindings(chapter: ContentSyncChapterSnapshot): readonly (string | number | null)[] {
  return [
    chapter.id,
    chapter.projectId,
    chapter.title,
    chapter.content,
    chapter.status,
    chapter.revision,
    chapter.currentVersionId,
    chapter.createdAt,
    chapter.updatedAt,
    chapter.trashedAt,
  ];
}

async function logicallyDeleteProject(
  transaction: TransactionExecutor,
  prepared: PreparedIncomingContentDelete,
): Promise<void> {
  const result = await transaction.execute(
    `UPDATE projects
     SET status_before_trash = CASE
           WHEN status = 'trashed' THEN status_before_trash
           ELSE status
         END,
         status = 'trashed',
         revision = CASE
           WHEN revision >= ? THEN revision + 1
           ELSE ? + 1
         END,
         deletion_generation = ? - 1,
         updated_at = ?,
         trashed_at = ?,
         retention_until = ?
     WHERE id = ?`,
    [
      prepared.objectGeneration,
      prepared.objectGeneration,
      prepared.objectGeneration,
      prepared.tombstone.deletedAt,
      prepared.tombstone.deletedAt,
      prepared.tombstone.retainUntil,
      prepared.projectId,
    ],
  );
  requireOneMutation(result, "The project could not be logically deleted.");
}

async function logicallyDeleteChapter(
  transaction: TransactionExecutor,
  prepared: PreparedIncomingContentDelete,
): Promise<void> {
  requireOneMutation(
    await transaction.execute(
      `UPDATE chapters
       SET status = 'trashed', updated_at = ?, trashed_at = ?
       WHERE id = ? AND project_id = ?`,
      [
        prepared.tombstone.deletedAt,
        prepared.tombstone.deletedAt,
        prepared.objectId,
        prepared.projectId,
      ],
    ),
    "The chapter could not be logically deleted.",
  );
}

function sameProject(row: ProjectDbRow, project: ContentSyncProjectSnapshot): boolean {
  return (
    row.id === project.id &&
    row.name === project.name &&
    row.status === project.status &&
    row.revision === project.revision &&
    row.deletion_generation === project.deletionGeneration &&
    row.created_at === project.createdAt &&
    row.updated_at === project.updatedAt &&
    row.archived_at === project.archivedAt &&
    row.trashed_at === project.trashedAt &&
    row.retention_until === project.retentionUntil &&
    row.status_before_trash === project.statusBeforeTrash
  );
}

function sameChapter(row: ChapterDbRow, chapter: ContentSyncChapterSnapshot): boolean {
  return (
    row.id === chapter.id &&
    row.project_id === chapter.projectId &&
    row.title === chapter.title &&
    row.content === chapter.content &&
    row.status === chapter.status &&
    row.revision === chapter.revision &&
    row.current_version_id === chapter.currentVersionId &&
    row.created_at === chapter.createdAt &&
    row.updated_at === chapter.updatedAt &&
    row.trashed_at === chapter.trashedAt
  );
}

function sameChapterVersion(
  row: ChapterVersionDbRow,
  version: ContentSyncChapterVersionSnapshot,
): boolean {
  return (
    row.id === version.id &&
    row.project_id === version.projectId &&
    row.chapter_id === version.chapterId &&
    row.parent_version_id === version.parentVersionId &&
    row.sequence === version.sequence &&
    row.content === version.content &&
    row.content_checksum === version.contentChecksum &&
    row.reason === version.reason &&
    row.source_candidate_id === version.sourceCandidateId &&
    row.created_at === version.createdAt
  );
}

function projectMatchesDelete(row: ProjectDbRow, prepared: PreparedIncomingContentDelete): boolean {
  return (
    row.status === "trashed" &&
    row.deletion_generation === prepared.objectGeneration - 1 &&
    row.trashed_at === prepared.tombstone.deletedAt &&
    row.retention_until === prepared.tombstone.retainUntil
  );
}

function chapterMatchesDelete(row: ChapterDbRow, prepared: PreparedIncomingContentDelete): boolean {
  return row.status === "trashed" && row.trashed_at === prepared.tombstone.deletedAt;
}

function assertLegalDelete(prepared: PreparedIncomingContentDelete): void {
  if (prepared.objectGeneration % 2 !== 0) {
    throw new SyncCoreError(
      "SYNC_VALIDATION_FAILED",
      "Content tombstones must use a positive even object generation.",
    );
  }
  const deletedAt = Date.parse(prepared.tombstone.deletedAt);
  const retainUntil = Date.parse(prepared.tombstone.retainUntil);
  if (
    !Number.isFinite(deletedAt) ||
    !Number.isFinite(retainUntil) ||
    retainUntil - deletedAt < 365 * 24 * 60 * 60 * 1_000
  ) {
    throw new SyncCoreError(
      "SYNC_VALIDATION_FAILED",
      "Content tombstone retention must be valid for at least 365 days.",
    );
  }
}

function requireCanonicalTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new SyncCoreError(
      "SYNC_VALIDATION_FAILED",
      `${field} must be a canonical UTC timestamp.`,
    );
  }
  return value;
}

function constantTimeEqualHex(left: string, right: string): boolean {
  const maximum = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function requireAtMostOne<Row>(rows: readonly Row[], message: string): Row | null {
  if (rows.length > 1) {
    throw materializationCorruption(message);
  }
  return rows[0] ?? null;
}

function requireOneMutation(result: Readonly<{ rowsAffected: number }>, message: string): void {
  if (result.rowsAffected !== 1) {
    throw materializationCorruption(message);
  }
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function materializationCorruption(message: string): SyncCoreError {
  return new SyncCoreError("SYNC_TRANSFER_MISMATCH", message);
}
