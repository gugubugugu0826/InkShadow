import type {
  AcceptCandidateCommit,
  AiCandidateRepository,
  ChapterRepository,
  ChapterVersionRepository,
  ContentCommitReceipt,
  ContentCommitRepository,
  ImportProjectCommit,
  ProjectImportCommitRepository,
  ProjectListQuery,
  ProjectRepository,
  RecoveryDraftRepository,
  SaveChapterCommit,
} from "@inkshadow/application";
import {
  AiCandidate,
  AppError,
  Chapter,
  ChapterVersion,
  Project,
  RecoveryDraft,
  err,
  ok,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AiCandidateSource,
  type AiCandidateStatus,
  type ChapterStatus,
  type ChapterVersionReason,
  type IsoUtcTimestamp,
  type ProjectStatus,
  type ProjectStatusBeforeTrash,
  type Result,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";

import type { SqlExecutor, SqlPrimitive, TransactionExecutor } from "./executor.js";
import {
  enqueueSyncProjectionJobInTransaction,
  findCurrentSyncMaterializedObjectInTransaction,
  loadProjectSyncRegistrationInTransaction,
  type ProjectSyncRegistration,
} from "./sync-materialization-sqlite-store.js";

interface ProjectDbRow {
  id: string;
  name: string;
  status: string;
  revision: number;
  deletion_generation: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  trashed_at: string | null;
  retention_until: string | null;
  status_before_trash: string | null;
}

interface ChapterDbRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  status: string;
  revision: number;
  current_version_id: string;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
}

interface ChapterVersionDbRow {
  id: string;
  project_id: string;
  chapter_id: string;
  parent_version_id: string | null;
  sequence: number;
  content: string;
  content_checksum: string;
  reason: string;
  source_candidate_id: string | null;
  created_at: string;
}

interface RecoveryDraftDbRow {
  id: string;
  project_id: string;
  chapter_id: string;
  base_revision: number;
  content: string;
  cursor_offset: number;
  created_at: string;
  updated_at: string;
}

interface AiCandidateDbRow {
  id: string;
  project_id: string;
  chapter_id: string | null;
  source: string;
  base_version_id: string | null;
  content: string;
  content_checksum: string | null;
  status: string;
  incomplete: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

const PROJECT_COLUMNS = `
  id,
  name,
  status,
  revision,
  deletion_generation,
  created_at,
  updated_at,
  archived_at,
  trashed_at,
  retention_until,
  status_before_trash
`;

const CHAPTER_COLUMNS = `
  id,
  project_id,
  title,
  content,
  status,
  revision,
  current_version_id,
  created_at,
  updated_at,
  trashed_at
`;

const VERSION_COLUMNS = `
  id,
  project_id,
  chapter_id,
  parent_version_id,
  sequence,
  content,
  content_checksum,
  reason,
  source_candidate_id,
  created_at
`;

const DRAFT_COLUMNS = `
  id,
  project_id,
  chapter_id,
  base_revision,
  content,
  cursor_offset,
  created_at,
  updated_at
`;

const CANDIDATE_COLUMNS = `
  id,
  project_id,
  chapter_id,
  source,
  base_version_id,
  content,
  content_checksum,
  status,
  incomplete,
  created_at,
  updated_at,
  decided_at
`;

export class SqliteProjectRepository implements ProjectRepository {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly syncProjectionIds?: UuidV7Generator,
  ) {}

  public async create(project: Project): Promise<Result<void, AppError>> {
    const snapshot = project.toSnapshot();
    return attempt("create project", async () => {
      await this.executor.execute(
        `INSERT INTO projects (
          id,
          name,
          status,
          revision,
          deletion_generation,
          created_at,
          updated_at,
          archived_at,
          trashed_at,
          retention_until,
          status_before_trash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          snapshot.id,
          snapshot.name,
          snapshot.status,
          snapshot.revision,
          snapshot.deletionGeneration,
          snapshot.createdAt,
          snapshot.updatedAt,
          snapshot.archivedAt,
          snapshot.trashedAt,
          snapshot.retentionUntil,
          snapshot.statusBeforeTrash,
        ],
      );
    });
  }

  public async findById(id: UuidV7): Promise<Result<Project | null, AppError>> {
    return attempt("read project", async () => {
      const rows = await this.executor.select<ProjectDbRow>(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ? LIMIT 1`,
        [id],
      );
      return rows[0] === undefined ? null : rehydrateProject(rows[0]);
    });
  }

  public async list(query: ProjectListQuery): Promise<Result<readonly Project[], AppError>> {
    if (query.statuses.length === 0) {
      return ok([]);
    }

    return attempt("list projects", async () => {
      const statusPlaceholders = query.statuses.map(() => "?").join(", ");
      const parameters: SqlPrimitive[] = [...query.statuses];
      let filter = `status IN (${statusPlaceholders})`;
      if (query.search !== null) {
        filter += " AND lower(name) LIKE lower(?) ESCAPE '\\'";
        parameters.push(`%${escapeLike(query.search)}%`);
      }

      const rows = await this.executor.select<ProjectDbRow>(
        `SELECT ${PROJECT_COLUMNS}
         FROM projects
         WHERE ${filter}
         ORDER BY updated_at DESC, id ASC`,
        parameters,
      );
      return rows.map(rehydrateProject);
    });
  }

  public async nameExists(
    normalizedName: string,
    excludingProjectId: UuidV7 | null,
  ): Promise<Result<boolean, AppError>> {
    return attempt("check project name", async () => {
      const parameters: SqlPrimitive[] = [normalizedName];
      let filter = "status <> 'trashed' AND lower(name) = lower(?)";
      if (excludingProjectId !== null) {
        filter += " AND id <> ?";
        parameters.push(excludingProjectId);
      }

      const rows = await this.executor.select<{ found: number }>(
        `SELECT EXISTS(
          SELECT 1 FROM projects WHERE ${filter}
        ) AS found`,
        parameters,
      );
      return rows[0]?.found === 1;
    });
  }

  public async save(project: Project, expectedRevision: number): Promise<Result<void, AppError>> {
    const snapshot = project.toSnapshot();
    return attempt("save project", async () => {
      const persist = async (executor: TransactionExecutor): Promise<void> => {
        const result = await executor.execute(
          `UPDATE projects
           SET
             name = ?,
             status = ?,
             revision = ?,
             deletion_generation = ?,
             updated_at = ?,
             archived_at = ?,
             trashed_at = ?,
             retention_until = ?,
             status_before_trash = ?
           WHERE id = ? AND revision = ?`,
          [
            snapshot.name,
            snapshot.status,
            snapshot.revision,
            snapshot.deletionGeneration,
            snapshot.updatedAt,
            snapshot.archivedAt,
            snapshot.trashedAt,
            snapshot.retentionUntil,
            snapshot.statusBeforeTrash,
            snapshot.id,
            expectedRevision,
          ],
        );
        if (result.rowsAffected !== 1) {
          throw concurrencyError("project", snapshot.id, expectedRevision);
        }
      };
      const syncProjectionIds = this.syncProjectionIds;
      if (syncProjectionIds === undefined) {
        await persist(this.executor);
        return;
      }
      await this.executor.transaction(async (transaction) => {
        await persist(transaction);
        await enqueueProjectProjectionIfEnabled(transaction, syncProjectionIds, project);
      });
    });
  }
}

export class SqliteChapterRepository implements ChapterRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async findById(id: UuidV7): Promise<Result<Chapter | null, AppError>> {
    return attempt("read chapter", async () => {
      const rows = await this.executor.select<ChapterDbRow>(
        `SELECT ${CHAPTER_COLUMNS} FROM chapters WHERE id = ? LIMIT 1`,
        [id],
      );
      return rows[0] === undefined ? null : rehydrateChapter(rows[0]);
    });
  }

  public async listByProjectId(projectId: UuidV7): Promise<Result<readonly Chapter[], AppError>> {
    return attempt("list chapters", async () => {
      const rows = await this.executor.select<ChapterDbRow>(
        `SELECT ${CHAPTER_COLUMNS}
         FROM chapters
         WHERE project_id = ?
         ORDER BY created_at ASC, id ASC`,
        [projectId],
      );
      return rows.map(rehydrateChapter);
    });
  }
}

export class SqliteChapterVersionRepository implements ChapterVersionRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async findVersionById(id: UuidV7): Promise<Result<ChapterVersion | null, AppError>> {
    return attempt("read chapter version", async () => {
      const rows = await this.executor.select<ChapterVersionDbRow>(
        `SELECT ${VERSION_COLUMNS}
         FROM chapter_versions
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      return rows[0] === undefined ? null : rehydrateChapterVersion(rows[0]);
    });
  }

  public async listByChapterId(
    chapterId: UuidV7,
  ): Promise<Result<readonly ChapterVersion[], AppError>> {
    return attempt("list chapter versions", async () => {
      const rows = await this.executor.select<ChapterVersionDbRow>(
        `SELECT ${VERSION_COLUMNS}
         FROM chapter_versions
         WHERE chapter_id = ?
         ORDER BY sequence DESC`,
        [chapterId],
      );
      return rows.map(rehydrateChapterVersion);
    });
  }
}

export class SqliteRecoveryDraftRepository implements RecoveryDraftRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async findByChapterId(chapterId: UuidV7): Promise<Result<RecoveryDraft | null, AppError>> {
    return attempt("read recovery draft", async () => {
      const rows = await this.executor.select<RecoveryDraftDbRow>(
        `SELECT ${DRAFT_COLUMNS}
         FROM recovery_drafts
         WHERE chapter_id = ?
         LIMIT 1`,
        [chapterId],
      );
      return rows[0] === undefined ? null : rehydrateRecoveryDraft(rows[0]);
    });
  }

  public async upsert(draft: RecoveryDraft): Promise<Result<void, AppError>> {
    const snapshot = draft.toSnapshot();
    return attempt("save recovery draft", async () => {
      await this.executor.execute(
        `INSERT INTO recovery_drafts (
          id,
          project_id,
          chapter_id,
          base_revision,
          content,
          cursor_offset,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chapter_id) DO UPDATE SET
          id = excluded.id,
          project_id = excluded.project_id,
          base_revision = excluded.base_revision,
          content = excluded.content,
          cursor_offset = excluded.cursor_offset,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`,
        [
          snapshot.id,
          snapshot.projectId,
          snapshot.chapterId,
          snapshot.baseRevision,
          snapshot.content,
          snapshot.cursorOffset,
          snapshot.createdAt,
          snapshot.updatedAt,
        ],
      );
    });
  }

  public async delete(chapterId: UuidV7, draftId: UuidV7): Promise<Result<void, AppError>> {
    return attempt("delete recovery draft", async () => {
      await this.executor.execute("DELETE FROM recovery_drafts WHERE chapter_id = ? AND id = ?", [
        chapterId,
        draftId,
      ]);
    });
  }
}

export class SqliteAiCandidateRepository implements AiCandidateRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async create(candidate: AiCandidate): Promise<Result<void, AppError>> {
    return attempt("create AI candidate", async () => {
      await insertCandidate(this.executor, candidate);
    });
  }

  public async findById(id: UuidV7): Promise<Result<AiCandidate | null, AppError>> {
    return attempt("read AI candidate", async () => {
      const rows = await this.executor.select<AiCandidateDbRow>(
        `SELECT ${CANDIDATE_COLUMNS}
         FROM ai_candidates
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      return rows[0] === undefined ? null : rehydrateAiCandidate(rows[0]);
    });
  }

  public async listByChapterId(
    chapterId: UuidV7,
  ): Promise<Result<readonly AiCandidate[], AppError>> {
    return attempt("list AI candidates", async () => {
      const rows = await this.executor.select<AiCandidateDbRow>(
        `SELECT ${CANDIDATE_COLUMNS}
         FROM ai_candidates
         WHERE chapter_id = ?
         ORDER BY created_at DESC`,
        [chapterId],
      );
      return rows.map(rehydrateAiCandidate);
    });
  }

  public async save(
    candidate: AiCandidate,
    expectedStatus: AiCandidateStatus,
  ): Promise<Result<void, AppError>> {
    const snapshot = candidate.toSnapshot();
    return attempt("save AI candidate", async () => {
      const result = await this.executor.execute(
        `UPDATE ai_candidates
         SET
           content = ?,
           content_checksum = ?,
           status = ?,
           incomplete = ?,
           updated_at = ?,
           decided_at = ?
         WHERE id = ? AND status = ?`,
        [
          snapshot.content,
          snapshot.contentChecksum,
          snapshot.status,
          snapshot.incomplete ? 1 : 0,
          snapshot.updatedAt,
          snapshot.decidedAt,
          snapshot.id,
          expectedStatus,
        ],
      );
      if (result.rowsAffected !== 1) {
        throw new AppError({
          code: "CANDIDATE_ALREADY_DECIDED",
          message: "The AI candidate changed before it could be saved.",
          details: { candidateId: snapshot.id, expectedStatus },
        });
      }
    });
  }
}

export class SqliteContentCommitRepository implements ContentCommitRepository {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly syncProjectionIds?: UuidV7Generator,
  ) {}

  public async createChapter(
    commit: Parameters<ContentCommitRepository["createChapter"]>[0],
  ): Promise<Result<ContentCommitReceipt, AppError>> {
    return attempt("create chapter", async () => {
      return this.executor.transaction(async (transaction) => {
        await insertChapter(transaction, commit.chapter);
        await insertChapterVersion(transaction, commit.initialVersion);
        const syncQueued = await enqueueChapterProjectionIfEnabled(
          transaction,
          this.syncProjectionIds,
          commit.chapter,
          commit.initialVersion,
        );
        return { syncQueued };
      });
    });
  }

  public async saveChapter(
    commit: SaveChapterCommit,
  ): Promise<Result<ContentCommitReceipt, AppError>> {
    return attempt("save chapter", async () => {
      return this.executor.transaction(async (transaction) => {
        await insertChapterVersion(transaction, commit.version);
        await updateChapter(transaction, commit.chapter, commit.expectedChapterRevision);
        const deleted = await transaction.execute(
          "DELETE FROM recovery_drafts WHERE chapter_id = ? AND id = ?",
          [commit.chapter.id, commit.recoveryDraftId],
        );
        if (deleted.rowsAffected !== 1) {
          throw new AppError({
            code: "RECOVERY_DRAFT_NOT_FOUND",
            message: "The recovery draft disappeared before the save completed.",
            actions: ["RETRY", "EXPORT_DRAFT"],
          });
        }
        const syncQueued = await enqueueChapterProjectionIfEnabled(
          transaction,
          this.syncProjectionIds,
          commit.chapter,
          commit.version,
        );
        return { syncQueued };
      });
    });
  }

  public async acceptCandidate(
    commit: AcceptCandidateCommit,
  ): Promise<Result<ContentCommitReceipt, AppError>> {
    return attempt("accept AI candidate", async () => {
      return this.executor.transaction(async (transaction) => {
        await insertChapterVersion(transaction, commit.version);
        await updateChapter(transaction, commit.chapter, commit.expectedChapterRevision);
        const snapshot = commit.candidate.toSnapshot();
        const updated = await transaction.execute(
          `UPDATE ai_candidates
           SET
             content = ?,
             content_checksum = ?,
             status = ?,
             incomplete = ?,
             updated_at = ?,
             decided_at = ?
           WHERE id = ? AND status = ?`,
          [
            snapshot.content,
            snapshot.contentChecksum,
            snapshot.status,
            snapshot.incomplete ? 1 : 0,
            snapshot.updatedAt,
            snapshot.decidedAt,
            snapshot.id,
            commit.expectedCandidateStatus,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw new AppError({
            code: "CANDIDATE_ALREADY_DECIDED",
            message: "The AI candidate changed before acceptance could be committed.",
          });
        }
        const syncQueued = await enqueueChapterProjectionIfEnabled(
          transaction,
          this.syncProjectionIds,
          commit.chapter,
          commit.version,
        );
        return { syncQueued };
      });
    });
  }

  public async restoreChapterVersion(
    commit: Parameters<ContentCommitRepository["restoreChapterVersion"]>[0],
  ): Promise<Result<ContentCommitReceipt, AppError>> {
    return attempt("restore chapter version", async () => {
      return this.executor.transaction(async (transaction) => {
        await insertChapterVersion(transaction, commit.version);
        await updateChapter(transaction, commit.chapter, commit.expectedChapterRevision);
        const syncQueued = await enqueueChapterProjectionIfEnabled(
          transaction,
          this.syncProjectionIds,
          commit.chapter,
          commit.version,
        );
        return { syncQueued };
      });
    });
  }
}

export class SqliteProjectImportCommitRepository implements ProjectImportCommitRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async commitImport(commit: ImportProjectCommit): Promise<Result<void, AppError>> {
    return attempt("import project", async () => {
      await this.executor.transaction(async (transaction) => {
        const conflict = await transaction.select<{ found: number }>(
          `SELECT EXISTS(
            SELECT 1
            FROM projects
            WHERE status <> 'trashed' AND lower(name) = lower(?)
          ) AS found`,
          [commit.project.name],
        );
        if (conflict[0]?.found === 1) {
          throw new AppError({
            code: "PROJECT_NAME_CONFLICT",
            message: "A visible project already uses this name.",
          });
        }

        await insertProject(transaction, commit.project);
        for (const imported of commit.chapters) {
          await insertChapter(transaction, imported.chapter);
          await insertChapterVersion(transaction, imported.initialVersion);
        }
      });
    });
  }
}

export interface SqliteRepositories {
  readonly projects: SqliteProjectRepository;
  readonly chapters: SqliteChapterRepository;
  readonly chapterVersions: SqliteChapterVersionRepository;
  readonly recoveryDrafts: SqliteRecoveryDraftRepository;
  readonly aiCandidates: SqliteAiCandidateRepository;
  readonly contentCommits: SqliteContentCommitRepository;
  readonly projectImports: SqliteProjectImportCommitRepository;
}

export interface CreateSqliteRepositoriesOptions {
  readonly syncProjectionIds?: UuidV7Generator;
}

export function createSqliteRepositories(
  executor: SqlExecutor,
  options: CreateSqliteRepositoriesOptions = {},
): SqliteRepositories {
  return {
    projects: new SqliteProjectRepository(executor, options.syncProjectionIds),
    chapters: new SqliteChapterRepository(executor),
    chapterVersions: new SqliteChapterVersionRepository(executor),
    recoveryDrafts: new SqliteRecoveryDraftRepository(executor),
    aiCandidates: new SqliteAiCandidateRepository(executor),
    contentCommits: new SqliteContentCommitRepository(executor, options.syncProjectionIds),
    projectImports: new SqliteProjectImportCommitRepository(executor),
  };
}

async function enqueueChapterProjectionIfEnabled(
  transaction: TransactionExecutor,
  ids: UuidV7Generator | undefined,
  chapter: Chapter,
  version: ChapterVersion,
): Promise<boolean> {
  if (ids === undefined) {
    return false;
  }
  const chapterSnapshot = chapter.toSnapshot();
  const versionSnapshot = version.toSnapshot();
  const registration = await loadEnabledSyncRegistration(transaction, chapterSnapshot.projectId);
  if (registration === null) {
    return false;
  }
  const current = requireAtomicResult(
    await findCurrentSyncMaterializedObjectInTransaction(
      transaction,
      chapterSnapshot.projectId,
      "chapter_version",
      chapterSnapshot.id,
    ),
  );
  const objectGeneration =
    current === null
      ? 1
      : current.state === "deleted"
        ? current.objectGeneration + 1
        : current.objectGeneration;
  requireAtomicResult(
    await enqueueSyncProjectionJobInTransaction(transaction, {
      jobId: ids.next(),
      projectId: chapterSnapshot.projectId,
      accountId: registration.accountId,
      objectType: "chapter_version",
      objectId: chapterSnapshot.id,
      objectGeneration,
      projectionKind: "upsert",
      versionId: versionSnapshot.id,
      sourceRevision: versionSnapshot.sequence,
      keyVersion: registration.keyVersion,
      consentRevision: registration.consentRevision,
      deviceId: registration.deviceId,
      createdAt: versionSnapshot.createdAt,
      nextAttemptAt: chapterSnapshot.updatedAt,
    }),
  );
  return true;
}

async function enqueueProjectProjectionIfEnabled(
  transaction: TransactionExecutor,
  ids: UuidV7Generator,
  project: Project,
): Promise<boolean> {
  const snapshot = project.toSnapshot();
  const registration = await loadEnabledSyncRegistration(transaction, snapshot.id);
  if (registration === null) {
    return false;
  }
  const projectionKind = snapshot.status === "trashed" ? "delete" : "upsert";
  requireAtomicResult(
    await enqueueSyncProjectionJobInTransaction(transaction, {
      jobId: ids.next(),
      projectId: snapshot.id,
      accountId: registration.accountId,
      objectType: "project_manifest",
      objectId: snapshot.id,
      objectGeneration: snapshot.deletionGeneration + 1,
      projectionKind,
      versionId: projectionKind === "delete" ? null : snapshot.id,
      sourceRevision: snapshot.revision,
      keyVersion: registration.keyVersion,
      consentRevision: registration.consentRevision,
      deviceId: registration.deviceId,
      createdAt: snapshot.updatedAt,
      nextAttemptAt: snapshot.updatedAt,
    }),
  );
  return true;
}

async function loadEnabledSyncRegistration(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<ProjectSyncRegistration | null> {
  const registration = requireAtomicResult(
    await loadProjectSyncRegistrationInTransaction(transaction, projectId),
  );
  return registration?.state === "enabled" && registration.plaintextBootstrapCompleted
    ? registration
    : null;
}

function requireAtomicResult<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function insertProject(executor: TransactionExecutor, project: Project): Promise<void> {
  const snapshot = project.toSnapshot();
  await executor.execute(
    `INSERT INTO projects (
      id,
      name,
      status,
      revision,
      deletion_generation,
      created_at,
      updated_at,
      archived_at,
      trashed_at,
      retention_until,
      status_before_trash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.name,
      snapshot.status,
      snapshot.revision,
      snapshot.deletionGeneration,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.archivedAt,
      snapshot.trashedAt,
      snapshot.retentionUntil,
      snapshot.statusBeforeTrash,
    ],
  );
}

async function insertChapter(executor: TransactionExecutor, chapter: Chapter): Promise<void> {
  const snapshot = chapter.toSnapshot();
  await executor.execute(
    `INSERT INTO chapters (
      id,
      project_id,
      title,
      content,
      status,
      revision,
      current_version_id,
      created_at,
      updated_at,
      trashed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.title,
      snapshot.content,
      snapshot.status,
      snapshot.revision,
      snapshot.currentVersionId,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.trashedAt,
    ],
  );
}

async function updateChapter(
  executor: TransactionExecutor,
  chapter: Chapter,
  expectedRevision: number,
): Promise<void> {
  const snapshot = chapter.toSnapshot();
  const result = await executor.execute(
    `UPDATE chapters
     SET
       title = ?,
       content = ?,
       status = ?,
       revision = ?,
       current_version_id = ?,
       updated_at = ?,
       trashed_at = ?
     WHERE id = ? AND revision = ?`,
    [
      snapshot.title,
      snapshot.content,
      snapshot.status,
      snapshot.revision,
      snapshot.currentVersionId,
      snapshot.updatedAt,
      snapshot.trashedAt,
      snapshot.id,
      expectedRevision,
    ],
  );
  if (result.rowsAffected !== 1) {
    throw concurrencyError("chapter", snapshot.id, expectedRevision);
  }
}

async function insertChapterVersion(
  executor: TransactionExecutor,
  version: ChapterVersion,
): Promise<void> {
  const snapshot = version.toSnapshot();
  await executor.execute(
    `INSERT INTO chapter_versions (
      id,
      project_id,
      chapter_id,
      parent_version_id,
      sequence,
      content,
      content_checksum,
      reason,
      source_candidate_id,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.chapterId,
      snapshot.parentVersionId,
      snapshot.sequence,
      snapshot.content,
      snapshot.contentChecksum,
      snapshot.reason,
      snapshot.sourceCandidateId,
      snapshot.createdAt,
    ],
  );
}

async function insertCandidate(
  executor: TransactionExecutor,
  candidate: AiCandidate,
): Promise<void> {
  const snapshot = candidate.toSnapshot();
  await executor.execute(
    `INSERT INTO ai_candidates (
      id,
      project_id,
      chapter_id,
      source,
      base_version_id,
      content,
      content_checksum,
      status,
      incomplete,
      created_at,
      updated_at,
      decided_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.chapterId,
      snapshot.source,
      snapshot.baseVersionId,
      snapshot.content,
      snapshot.contentChecksum,
      snapshot.status,
      snapshot.incomplete ? 1 : 0,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.decidedAt,
    ],
  );
}

function rehydrateProject(row: ProjectDbRow): Project {
  const restored = Project.rehydrate({
    id: requiredUuid(row.id, "project.id"),
    name: row.name,
    status: row.status as ProjectStatus,
    revision: row.revision,
    deletionGeneration: row.deletion_generation,
    createdAt: requiredTimestamp(row.created_at, "project.createdAt"),
    updatedAt: requiredTimestamp(row.updated_at, "project.updatedAt"),
    archivedAt: optionalTimestamp(row.archived_at, "project.archivedAt"),
    trashedAt: optionalTimestamp(row.trashed_at, "project.trashedAt"),
    retentionUntil: optionalTimestamp(row.retention_until, "project.retentionUntil"),
    statusBeforeTrash: row.status_before_trash as ProjectStatusBeforeTrash | null,
  });
  return requireEntity(restored, "project", row.id);
}

function rehydrateChapter(row: ChapterDbRow): Chapter {
  const restored = Chapter.rehydrate({
    id: requiredUuid(row.id, "chapter.id"),
    projectId: requiredUuid(row.project_id, "chapter.projectId"),
    title: row.title,
    content: row.content,
    status: row.status as ChapterStatus,
    revision: row.revision,
    currentVersionId: requiredUuid(row.current_version_id, "chapter.currentVersionId"),
    createdAt: requiredTimestamp(row.created_at, "chapter.createdAt"),
    updatedAt: requiredTimestamp(row.updated_at, "chapter.updatedAt"),
    trashedAt: optionalTimestamp(row.trashed_at, "chapter.trashedAt"),
  });
  return requireEntity(restored, "chapter", row.id);
}

function rehydrateChapterVersion(row: ChapterVersionDbRow): ChapterVersion {
  const restored = ChapterVersion.create({
    id: requiredUuid(row.id, "chapterVersion.id"),
    projectId: requiredUuid(row.project_id, "chapterVersion.projectId"),
    chapterId: requiredUuid(row.chapter_id, "chapterVersion.chapterId"),
    parentVersionId: optionalUuid(row.parent_version_id, "chapterVersion.parentVersionId"),
    sequence: row.sequence,
    content: row.content,
    contentChecksum: requiredChecksum(row.content_checksum, "chapterVersion.contentChecksum"),
    reason: row.reason as ChapterVersionReason,
    sourceCandidateId: optionalUuid(row.source_candidate_id, "chapterVersion.sourceCandidateId"),
    createdAt: requiredTimestamp(row.created_at, "chapterVersion.createdAt"),
  });
  return requireEntity(restored, "chapter version", row.id);
}

function rehydrateRecoveryDraft(row: RecoveryDraftDbRow): RecoveryDraft {
  const restored = RecoveryDraft.rehydrate({
    id: requiredUuid(row.id, "recoveryDraft.id"),
    projectId: requiredUuid(row.project_id, "recoveryDraft.projectId"),
    chapterId: requiredUuid(row.chapter_id, "recoveryDraft.chapterId"),
    baseRevision: row.base_revision,
    content: row.content,
    cursorOffset: row.cursor_offset,
    createdAt: requiredTimestamp(row.created_at, "recoveryDraft.createdAt"),
    updatedAt: requiredTimestamp(row.updated_at, "recoveryDraft.updatedAt"),
  });
  return requireEntity(restored, "recovery draft", row.id);
}

function rehydrateAiCandidate(row: AiCandidateDbRow): AiCandidate {
  const restored = AiCandidate.rehydrate({
    id: requiredUuid(row.id, "aiCandidate.id"),
    projectId: requiredUuid(row.project_id, "aiCandidate.projectId"),
    chapterId: optionalUuid(row.chapter_id, "aiCandidate.chapterId"),
    source: row.source as AiCandidateSource,
    baseVersionId: optionalUuid(row.base_version_id, "aiCandidate.baseVersionId"),
    content: row.content,
    contentChecksum:
      row.content_checksum === null
        ? null
        : requiredChecksum(row.content_checksum, "aiCandidate.contentChecksum"),
    status: row.status as AiCandidateStatus,
    incomplete: row.incomplete === 1,
    createdAt: requiredTimestamp(row.created_at, "aiCandidate.createdAt"),
    updatedAt: requiredTimestamp(row.updated_at, "aiCandidate.updatedAt"),
    decidedAt: optionalTimestamp(row.decided_at, "aiCandidate.decidedAt"),
  });
  return requireEntity(restored, "AI candidate", row.id);
}

async function attempt<Value>(
  operation: string,
  action: () => Promise<Value>,
): Promise<Result<Value, AppError>> {
  try {
    return ok(await action());
  } catch (error: unknown) {
    if (error instanceof AppError) {
      return err(error);
    }

    const normalized = normalizeDatabaseError(operation, error);
    return err(normalized);
  }
}

function normalizeDatabaseError(operation: string, error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("projects_visible_name_unique") ||
    message.includes("UNIQUE constraint failed: index 'projects_visible_name_unique'") ||
    message.includes("UNIQUE constraint failed: projects.name")
  ) {
    return new AppError({
      code: "PROJECT_NAME_CONFLICT",
      message: "Another visible project already uses this name.",
      actions: ["RENAME"],
    });
  }

  const nativeCode = readNativeSqliteCode(error);
  if (nativeCode === "SQLITE_BUSY") {
    return new AppError({
      code: "SAVE_FAILED",
      message: "The local database is busy and did not accept the write.",
      retryable: true,
      actions: ["RETRY", "EXPORT_DRAFT"],
      details: { databaseCode: nativeCode, operation },
    });
  }
  if (nativeCode === "SQLITE_DISK_FULL") {
    return new AppError({
      code: "SAVE_FAILED",
      message: "The local disk is full and the write was not committed.",
      retryable: false,
      actions: ["EXPORT_DRAFT"],
      details: { databaseCode: nativeCode, operation },
    });
  }

  return new AppError({
    code: "REPOSITORY_ERROR",
    message: `Unable to ${operation}.`,
    retryable: true,
    actions: ["RETRY", "EXPORT_DRAFT"],
    details: {
      cause: error instanceof Error ? error.name : "UnknownDatabaseError",
    },
  });
}

function readNativeSqliteCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function concurrencyError(
  entityType: "project" | "chapter",
  entityId: UuidV7,
  expectedRevision: number,
): AppError {
  return new AppError({
    code: "VERSION_CONFLICT",
    message: `The ${entityType} changed before this operation completed.`,
    actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
    details: { entityType, entityId, expectedRevision },
  });
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function requiredUuid(value: string, field: string): UuidV7 {
  return requireParsed(parseUuidV7(value), field);
}

function optionalUuid(value: string | null, field: string): UuidV7 | null {
  return value === null ? null : requiredUuid(value, field);
}

function requiredTimestamp(value: string, field: string): IsoUtcTimestamp {
  return requireParsed(parseIsoUtcTimestamp(value), field);
}

function optionalTimestamp(value: string | null, field: string): IsoUtcTimestamp | null {
  return value === null ? null : requiredTimestamp(value, field);
}

function requiredChecksum(value: string, field: string) {
  return requireParsed(parseContentChecksum(value), field);
}

function requireParsed<Value>(parsed: Result<Value, AppError>, field: string): Value {
  if (parsed.ok) {
    return parsed.value;
  }
  throw corruptData(field, parsed.error.code);
}

function requireEntity<Value>(
  restored: Result<Value, AppError>,
  entityType: string,
  entityId: string,
): Value {
  if (restored.ok) {
    return restored.value;
  }
  throw corruptData(`${entityType}:${entityId}`, restored.error.code);
}

function corruptData(field: string, validationCode: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "Stored local data did not pass integrity validation.",
    actions: ["EXPORT_DRAFT", "CONTACT_SUPPORT"],
    details: { field, validationCode },
  });
}
