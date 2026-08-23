import type {
  AcceptCandidateCommit,
  AiCandidateRepository,
  ChapterPrivacyAuthoritySnapshot,
  ChapterRepository,
  ChapterPrivacyRepository,
  ChapterVersionRepository,
  ContentCommitReceipt,
  ContentCommitRepository,
  ImportProjectCommit,
  ProjectImportCommitRepository,
  ProjectListQuery,
  ProjectDisplayKind,
  ProjectRepository,
  RecoveryDraftRepository,
  SaveChapterCommit,
} from "@inkshadow/application";
import {
  AiCandidate,
  AppError,
  CHAPTER_PRIVACY_MODES,
  CHAPTER_STATUSES,
  Chapter,
  ChapterVersion,
  Project,
  RecoveryDraft,
  err,
  ok,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AiCandidateApplicationIntent,
  type AiCandidatePurpose,
  type AiCandidateSource,
  type AiCandidateStatus,
  type ChapterStatus,
  type ChapterPrivacyMode,
  type ChapterVersionReason,
  type IsoUtcTimestamp,
  type ProjectStatus,
  type ProjectStatusBeforeTrash,
  type Result,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import { Task, type CreateTaskInput } from "@inkshadow/task-engine";

import type { SqlExecutor, SqlPrimitive, TransactionExecutor } from "./executor.js";
import { SqliteProjectDisplayIdentityRepository } from "./project-display-identity-sqlite-repository.js";
export { SqliteProjectDisplayIdentityRepository } from "./project-display-identity-sqlite-repository.js";
import { createTaskIfAbsentInTransaction } from "./task-sqlite-repositories.js";
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
  privacy_mode: string;
  privacy_revision: number;
  current_version_id: string;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
}

interface ChapterPrivacyAuthorityDbRow {
  readonly chapter_id: string;
  readonly current_version_id: string;
  readonly chapter_revision: number;
  readonly privacy_revision: number;
  readonly privacy_mode: string;
  readonly status: string;
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
  organize_local_story_facts: number;
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
  purpose: string;
  base_version_id: string | null;
  content: string;
  content_checksum: string | null;
  status: string;
  revision: number;
  incomplete: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  task_intent: string;
  application_mode: string;
  payload_kind: string;
  anchor_start_utf16: number | null;
  anchor_end_utf16: number | null;
}

interface CountDbRow {
  count: number;
}

interface CandidateAuthorityDbRow {
  readonly status: string;
  readonly revision: number;
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
  privacy_mode,
  privacy_revision,
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
  organize_local_story_facts,
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
  purpose,
  base_version_id,
  content,
  content_checksum,
  status,
  revision,
  incomplete,
  created_at,
  updated_at,
  decided_at,
  task_intent,
  application_mode,
  payload_kind,
  anchor_start_utf16,
  anchor_end_utf16
`;

export class SqliteProjectRepository implements ProjectRepository {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly syncProjectionIds?: UuidV7Generator,
  ) {}

  public async create(
    project: Project,
    displayKind: Exclude<ProjectDisplayKind, "system_evaluation"> = "author_work",
  ): Promise<Result<void, AppError>> {
    const snapshot = project.toSnapshot();
    return attempt("create project", async () => {
      await this.executor.transaction(async (transaction) => {
        await insertProject(transaction, project);
        await insertProjectDisplayIdentityIfAvailable(
          transaction,
          snapshot.id,
          displayKind,
          snapshot.createdAt,
        );
      });
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

  public async listPrivacyAuthorityByProjectId(
    projectId: UuidV7,
  ): Promise<Result<readonly ChapterPrivacyAuthoritySnapshot[], AppError>> {
    return attempt("list chapter privacy authority", async () => {
      const rows = await this.executor.select<ChapterPrivacyAuthorityDbRow>(
        `SELECT
           id AS chapter_id,
           current_version_id,
           revision AS chapter_revision,
           privacy_revision,
           privacy_mode,
           status
         FROM chapters
         WHERE project_id = ?
         ORDER BY id ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(rehydrateChapterPrivacyAuthority));
    });
  }
}

export class SqliteChapterPrivacyRepository implements ChapterPrivacyRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async updatePrivacy(
    chapter: Chapter,
    expectedPrivacyRevision: number,
  ): ReturnType<ChapterPrivacyRepository["updatePrivacy"]> {
    return attempt("update chapter privacy", async () => {
      return this.executor.transaction(async (transaction) => {
        const snapshot = chapter.toSnapshot();
        const [projectionRows, outboxRows, acknowledgedRows] =
          snapshot.privacyMode === "local_only"
            ? await Promise.all([
                transaction.select<CountDbRow>(
                  `SELECT count(*) AS count
                   FROM sync_projection_jobs
                   WHERE project_id = ?
                     AND object_type = 'chapter_version'
                     AND object_id = ?
                     AND projection_kind = 'upsert'
                     AND status IN ('queued', 'leased', 'retry_wait')`,
                  [snapshot.projectId, snapshot.id],
                ),
                transaction.select<CountDbRow>(
                  `SELECT count(*) AS count
                   FROM sync_outbox_operations
                   WHERE project_id = ?
                     AND object_type = 'chapter_version'
                     AND object_id = ?
                     AND kind = 'upsert'
                     AND status <> 'acknowledged'`,
                  [snapshot.projectId, snapshot.id],
                ),
                transaction.select<CountDbRow>(
                  `SELECT (
                     SELECT count(*)
                     FROM sync_outbox_operations
                     WHERE project_id = ?
                       AND object_type = 'chapter_version'
                       AND object_id = ?
                       AND kind = 'upsert'
                       AND status = 'acknowledged'
                       AND acknowledged_at IS NOT NULL
                   ) + (
                     SELECT count(*)
                     FROM sync_transfers AS transfer
                     WHERE transfer.project_id = ?
                       AND transfer.object_id = ?
                       AND transfer.status = 'completed'
                       AND EXISTS (
                         SELECT 1
                         FROM sync_transfer_chunks AS chunk
                         WHERE chunk.transfer_id = transfer.transfer_id
                           AND chunk.remote_etag IS NOT NULL
                           AND chunk.acknowledged_at IS NOT NULL
                       )
                   ) AS count`,
                  [snapshot.projectId, snapshot.id, snapshot.projectId, snapshot.id],
                ),
              ])
            : [[{ count: 0 }], [{ count: 0 }], [{ count: 0 }]];
        const updated = await transaction.execute(
          `UPDATE chapters
           SET privacy_mode = ?, privacy_revision = ?, updated_at = ?
           WHERE id = ? AND project_id = ? AND privacy_revision = ?`,
          [
            snapshot.privacyMode,
            snapshot.privacyRevision,
            snapshot.updatedAt,
            snapshot.id,
            snapshot.projectId,
            expectedPrivacyRevision,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw concurrencyError("chapter", snapshot.id, expectedPrivacyRevision);
        }
        return {
          chapter,
          blockedProjectionCount: projectionRows[0]?.count ?? 0,
          removedOutboxOperationCount: outboxRows[0]?.count ?? 0,
          acknowledgedCloudEvidenceCount: acknowledgedRows[0]?.count ?? 0,
        };
      });
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
      return rows[0] === undefined ? null : rehydrateChapterVersionRow(rows[0]);
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
      return rows.map(rehydrateChapterVersionRow);
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

export interface AiCandidateRowReference {
  readonly table: "ai_candidates";
  readonly candidateId: UuidV7 | null;
  readonly rowFingerprint: string;
}

export interface AiCandidateIsolationIncident {
  readonly rowReference: AiCandidateRowReference;
  readonly reasonCodeChain: readonly string[];
  readonly applicationStack: readonly string[];
}

export interface AiCandidateListWithIsolation {
  readonly candidates: readonly AiCandidate[];
  readonly isolatedRows: readonly AiCandidateIsolationIncident[];
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
    const read = await this.listByChapterIdWithIsolation(chapterId);
    if (!read.ok) {
      return err(read.error);
    }
    if (read.value.isolatedRows.length > 0) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "部分可选生成记录暂时无法读取。",
          retryable: true,
          actions: ["RETRY", "CONTACT_SUPPORT"],
          details: {
            operation: "list AI candidates",
            isolatedRowCount: read.value.isolatedRows.length,
            isolatedRows: read.value.isolatedRows,
          },
        }),
      );
    }
    return ok(read.value.candidates);
  }

  public async listByChapterIdWithIsolation(
    chapterId: UuidV7,
  ): Promise<Result<AiCandidateListWithIsolation, AppError>> {
    return attempt("list AI candidates", async () => {
      const rows = await this.executor.select<AiCandidateDbRow>(
        `SELECT ${CANDIDATE_COLUMNS}
         FROM ai_candidates
         WHERE chapter_id = ?
         ORDER BY created_at DESC`,
        [chapterId],
      );
      const candidates: AiCandidate[] = [];
      const isolatedRows: AiCandidateIsolationIncident[] = [];
      for (const row of rows) {
        try {
          candidates.push(rehydrateAiCandidate(row));
        } catch (cause: unknown) {
          if (!isIsolatableAiCandidateRowError(cause)) {
            throw cause;
          }
          isolatedRows.push(isolateAiCandidateRow(row, cause));
        }
      }
      return Object.freeze({
        candidates: Object.freeze(candidates),
        isolatedRows: Object.freeze(isolatedRows),
      });
    });
  }

  public async save(
    candidate: AiCandidate,
    expected: Readonly<{ status: AiCandidateStatus; revision: number }>,
  ): Promise<Result<void, AppError>> {
    const snapshot = candidate.toSnapshot();
    return attempt("save AI candidate", async () => {
      const result = await this.executor.execute(
        `UPDATE ai_candidates
         SET
           content = ?,
           content_checksum = ?,
           status = ?,
           revision = ?,
           incomplete = ?,
           updated_at = ?,
           decided_at = ?
         WHERE id = ? AND status = ? AND revision = ?`,
        [
          snapshot.content,
          snapshot.contentChecksum,
          snapshot.status,
          candidate.revision,
          snapshot.incomplete ? 1 : 0,
          snapshot.updatedAt,
          snapshot.decidedAt,
          snapshot.id,
          expected.status,
          expected.revision,
        ],
      );
      if (result.rowsAffected !== 1) {
        throw await candidateAuthorityError(this.executor, snapshot.id, expected);
      }
    });
  }
}

export class SqliteContentCommitRepository implements ContentCommitRepository {
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly syncProjectionIds?: UuidV7Generator,
    private readonly acceptedCandidateTaskFactory?: AcceptedCandidateTaskFactory,
    private readonly acceptedVersionTaskFactory?: AcceptedVersionTaskFactory,
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
        await registerAcceptedVersionTaskInTransaction(
          transaction,
          this.acceptedVersionTaskFactory?.({
            source: acceptedVersionTaskSourceForChapterSave(commit.version),
            version: commit.version,
          }),
        );
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
             revision = ?,
             incomplete = ?,
             updated_at = ?,
             decided_at = ?
           WHERE id = ? AND status = ? AND revision = ?`,
          [
            snapshot.content,
            snapshot.contentChecksum,
            snapshot.status,
            commit.candidate.revision,
            snapshot.incomplete ? 1 : 0,
            snapshot.updatedAt,
            snapshot.decidedAt,
            snapshot.id,
            commit.expectedCandidateStatus,
            commit.expectedCandidateRevision,
          ],
        );
        if (updated.rowsAffected !== 1) {
          throw await candidateAuthorityError(transaction, snapshot.id, {
            status: commit.expectedCandidateStatus,
            revision: commit.expectedCandidateRevision,
          });
        }
        await registerAcceptedVersionTaskInTransaction(
          transaction,
          this.acceptedVersionTaskFactory?.({
            source: "candidate_accept",
            version: commit.version,
          }) ?? this.acceptedCandidateTaskFactory?.(commit),
        );
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
        await registerAcceptedVersionTaskInTransaction(
          transaction,
          this.acceptedVersionTaskFactory?.({
            source: "version_restore",
            version: commit.version,
          }),
        );
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
  public constructor(
    private readonly executor: SqlExecutor,
    private readonly acceptedVersionTaskFactory?: AcceptedVersionTaskFactory,
  ) {}

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
        const projectSnapshot = commit.project.toSnapshot();
        await insertProjectDisplayIdentityIfAvailable(
          transaction,
          projectSnapshot.id,
          "author_work",
          projectSnapshot.createdAt,
        );
        for (const imported of commit.chapters) {
          await insertChapter(transaction, imported.chapter);
          await insertChapterVersion(transaction, imported.initialVersion);
          await registerAcceptedVersionTaskInTransaction(
            transaction,
            this.acceptedVersionTaskFactory?.({
              source: "chapter_import",
              version: imported.initialVersion,
            }),
          );
        }
      });
    });
  }
}

export interface SqliteRepositories {
  readonly projects: SqliteProjectRepository;
  readonly projectDisplayIdentities: SqliteProjectDisplayIdentityRepository;
  readonly chapters: SqliteChapterRepository;
  readonly chapterPrivacy: SqliteChapterPrivacyRepository;
  readonly chapterVersions: SqliteChapterVersionRepository;
  readonly recoveryDrafts: SqliteRecoveryDraftRepository;
  readonly aiCandidates: SqliteAiCandidateRepository;
  readonly contentCommits: SqliteContentCommitRepository;
  readonly projectImports: SqliteProjectImportCommitRepository;
}

export interface CreateSqliteRepositoriesOptions {
  readonly syncProjectionIds?: UuidV7Generator;
  /**
   * Production may provide the accepted-version task request here so Candidate
   * acceptance and its recovery work become durable in the same transaction.
   */
  readonly acceptedVersionTaskFactory?: AcceptedVersionTaskFactory;
  readonly acceptedCandidateTaskFactory?: AcceptedCandidateTaskFactory;
}

export type AcceptedVersionTaskSource =
  | "candidate_accept"
  | "chapter_import"
  | "autosave"
  | "manual_save"
  | "recovery_save"
  | "version_restore";

export interface AcceptedVersionTaskRegistration {
  readonly source: AcceptedVersionTaskSource;
  readonly version: ChapterVersion;
}

export type AcceptedVersionTaskFactory = (
  input: AcceptedVersionTaskRegistration,
) => CreateTaskInput;
export type AcceptedCandidateTaskFactory = (commit: AcceptCandidateCommit) => CreateTaskInput;

export function acceptedVersionTaskSourceForChapterSave(
  version: ChapterVersion,
): Extract<AcceptedVersionTaskSource, "autosave" | "manual_save" | "recovery_save"> {
  switch (version.toSnapshot().reason) {
    case "autosave":
      return "autosave";
    case "manual":
      return "manual_save";
    case "recovery":
      return "recovery_save";
    default:
      throw new AppError({
        code: "SAVE_FAILED",
        message: "The chapter-save version reason cannot register accepted-version work.",
        retryable: false,
        actions: ["CONTACT_SUPPORT"],
        details: { reason: version.toSnapshot().reason },
      });
  }
}

export function createSqliteRepositories(
  executor: SqlExecutor,
  options: CreateSqliteRepositoriesOptions = {},
): SqliteRepositories {
  return {
    projects: new SqliteProjectRepository(executor, options.syncProjectionIds),
    projectDisplayIdentities: new SqliteProjectDisplayIdentityRepository(executor),
    chapters: new SqliteChapterRepository(executor),
    chapterPrivacy: new SqliteChapterPrivacyRepository(executor),
    chapterVersions: new SqliteChapterVersionRepository(executor),
    recoveryDrafts: new SqliteRecoveryDraftRepository(executor),
    aiCandidates: new SqliteAiCandidateRepository(executor),
    contentCommits: new SqliteContentCommitRepository(
      executor,
      options.syncProjectionIds,
      options.acceptedCandidateTaskFactory,
      options.acceptedVersionTaskFactory,
    ),
    projectImports: new SqliteProjectImportCommitRepository(
      executor,
      options.acceptedVersionTaskFactory,
    ),
  };
}

async function registerAcceptedVersionTaskInTransaction(
  transaction: TransactionExecutor,
  taskInput: CreateTaskInput | undefined,
): Promise<void> {
  if (taskInput === undefined) {
    return;
  }
  const task = Task.create(taskInput);
  if (!task.ok) {
    throw new AppError({
      code: "SAVE_FAILED",
      message: "The accepted-version recovery task is invalid.",
      retryable: true,
      actions: ["RETRY", "CONTACT_SUPPORT"],
      details: { taskErrorCode: task.error.code },
    });
  }
  await createTaskIfAbsentInTransaction(transaction, task.value);
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
  if (chapterSnapshot.privacyMode === "local_only") {
    return false;
  }
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

async function insertProjectDisplayIdentityIfAvailable(
  executor: TransactionExecutor,
  projectId: UuidV7,
  displayKind: Exclude<ProjectDisplayKind, "system_evaluation">,
  recordedAt: IsoUtcTimestamp,
): Promise<void> {
  const schemaComponents = await executor.select<{ readonly name: string }>(
    `SELECT name
     FROM sqlite_schema
     WHERE (
       type = 'table'
       AND name IN (
         'project_display_identities',
         'project_display_identity_revisions'
       )
     ) OR (
       type = 'trigger'
       AND name = 'project_display_identity_revision_insert'
     )
     ORDER BY name`,
  );
  if (schemaComponents.length === 0) return;
  if (schemaComponents.length !== 3) {
    throw new AppError({
      code: "REPOSITORY_ERROR",
      message: "本地作品分类结构不完整，已停止创建以保护作品数据。",
      retryable: false,
      actions: ["CONTACT_SUPPORT"],
      details: {
        operation: "PROJECT_DISPLAY_IDENTITY_SCHEMA_INCOMPLETE",
        foundComponentCount: schemaComponents.length,
        requiredComponentCount: 3,
        foundComponents: schemaComponents.map(({ name }) => name),
      },
    });
  }
  const provenance =
    displayKind === "author_work"
      ? "explicit_creation"
      : displayKind === "test_work"
        ? "explicit_test"
        : "builtin_example";
  await executor.execute(
    `INSERT INTO project_display_identities (
       project_id, display_kind, provenance, revision, created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, ?)`,
    [projectId, displayKind, provenance, recordedAt, recordedAt],
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
      privacy_mode,
      privacy_revision,
      current_version_id,
      created_at,
      updated_at,
      trashed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.title,
      snapshot.content,
      snapshot.status,
      snapshot.revision,
      snapshot.privacyMode,
      snapshot.privacyRevision,
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
     WHERE id = ? AND revision = ? AND privacy_revision = ?`,
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
      snapshot.privacyRevision,
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
      organize_local_story_facts,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      snapshot.organizeLocalStoryFacts ? 1 : 0,
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
      purpose,
      base_version_id,
      content,
      content_checksum,
      status,
      revision,
      incomplete,
      created_at,
      updated_at,
      decided_at,
      task_intent,
      application_mode,
      payload_kind,
      anchor_start_utf16,
      anchor_end_utf16
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.id,
      snapshot.projectId,
      snapshot.chapterId,
      snapshot.source,
      snapshot.purpose ?? "prose",
      snapshot.baseVersionId,
      snapshot.content,
      snapshot.contentChecksum,
      snapshot.status,
      candidate.revision,
      snapshot.incomplete ? 1 : 0,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.decidedAt,
      snapshot.applicationIntent?.task ?? "legacy_full_document",
      snapshot.applicationIntent?.application ?? "replace_document",
      snapshot.applicationIntent?.payload ?? "full_document",
      snapshot.applicationIntent?.startUtf16 ?? null,
      snapshot.applicationIntent?.endUtf16 ?? null,
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
    privacyMode: row.privacy_mode as ChapterPrivacyMode,
    privacyRevision: row.privacy_revision,
    currentVersionId: requiredUuid(row.current_version_id, "chapter.currentVersionId"),
    createdAt: requiredTimestamp(row.created_at, "chapter.createdAt"),
    updatedAt: requiredTimestamp(row.updated_at, "chapter.updatedAt"),
    trashedAt: optionalTimestamp(row.trashed_at, "chapter.trashedAt"),
  });
  return requireEntity(restored, "chapter", row.id);
}

function rehydrateChapterPrivacyAuthority(
  row: ChapterPrivacyAuthorityDbRow,
): ChapterPrivacyAuthoritySnapshot {
  if (
    !Number.isSafeInteger(row.chapter_revision) ||
    row.chapter_revision < 1 ||
    !Number.isSafeInteger(row.privacy_revision) ||
    row.privacy_revision < 1 ||
    !CHAPTER_PRIVACY_MODES.includes(row.privacy_mode as ChapterPrivacyMode) ||
    !CHAPTER_STATUSES.includes(row.status as ChapterStatus)
  ) {
    throw corruptData(`chapter-privacy-authority:${row.chapter_id}`, "INVALID_METADATA");
  }
  return Object.freeze({
    chapterId: requiredUuid(row.chapter_id, "chapterPrivacyAuthority.chapterId"),
    currentVersionId: requiredUuid(
      row.current_version_id,
      "chapterPrivacyAuthority.currentVersionId",
    ),
    chapterRevision: row.chapter_revision,
    privacyRevision: row.privacy_revision,
    privacyMode: row.privacy_mode as ChapterPrivacyMode,
    status: row.status as ChapterStatus,
  });
}

function rehydrateChapterVersionRow(row: ChapterVersionDbRow): ChapterVersion {
  try {
    return rehydrateChapterVersion(row);
  } catch (cause: unknown) {
    if (!(cause instanceof AppError)) {
      throw cause;
    }
    const parsedVersionId = parseUuidV7(row.id);
    const sequence = Number.isSafeInteger(row.sequence) && row.sequence > 0 ? row.sequence : null;
    const wrapped = new AppError({
      code: cause.code,
      message: cause.message,
      retryable: cause.retryable,
      actions: cause.actions,
      details: {
        ...cause.details,
        rowReference: Object.freeze({
          table: "chapter_versions",
          versionId: parsedVersionId.ok ? parsedVersionId.value : null,
          sequence,
          rowFingerprint: `version-row-${safeMetadataFingerprint([
            row.id,
            row.project_id,
            row.chapter_id,
            row.parent_version_id ?? "none",
            String(row.sequence),
            row.created_at,
          ])}`,
        }),
      },
    });
    throw attachErrorCause(wrapped, cause);
  }
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
    organizeLocalStoryFacts: requiredBooleanFlag(
      row.organize_local_story_facts,
      "chapterVersion.organizeLocalStoryFacts",
    ),
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
    purpose: row.purpose as AiCandidatePurpose,
    baseVersionId: optionalUuid(row.base_version_id, "aiCandidate.baseVersionId"),
    content: row.content,
    contentChecksum:
      row.content_checksum === null
        ? null
        : requiredChecksum(row.content_checksum, "aiCandidate.contentChecksum"),
    status: row.status as AiCandidateStatus,
    revision: row.revision,
    incomplete: row.incomplete === 1,
    createdAt: requiredTimestamp(row.created_at, "aiCandidate.createdAt"),
    updatedAt: requiredTimestamp(row.updated_at, "aiCandidate.updatedAt"),
    decidedAt: optionalTimestamp(row.decided_at, "aiCandidate.decidedAt"),
    applicationIntent: rehydrateCandidateApplicationIntent(row),
  });
  return requireEntity(restored, "AI candidate", row.id);
}

function rehydrateCandidateApplicationIntent(row: AiCandidateDbRow): AiCandidateApplicationIntent {
  return {
    task: row.task_intent,
    application: row.application_mode,
    payload: row.payload_kind,
    startUtf16: row.anchor_start_utf16,
    endUtf16: row.anchor_end_utf16,
  } as AiCandidateApplicationIntent;
}

function isolateAiCandidateRow(
  row: AiCandidateDbRow,
  cause: unknown,
): AiCandidateIsolationIncident {
  const parsedCandidateId = parseUuidV7(row.id);
  return Object.freeze({
    rowReference: Object.freeze({
      table: "ai_candidates" as const,
      candidateId: parsedCandidateId.ok ? parsedCandidateId.value : null,
      rowFingerprint: `candidate-${safeMetadataFingerprint([
        row.id,
        row.project_id,
        row.chapter_id ?? "none",
        row.created_at,
      ])}`,
    }),
    reasonCodeChain: candidateReasonCodeChain(cause),
    applicationStack: safeRepositoryStack(cause),
  });
}
function isIsolatableAiCandidateRowError(cause: unknown): cause is AppError {
  if (!(cause instanceof AppError) || cause.code !== "REPOSITORY_ERROR") {
    return false;
  }
  const field = cause.details.field;
  const validationCode = cause.details.validationCode;
  return (
    typeof validationCode === "string" &&
    typeof field === "string" &&
    (field.startsWith("aiCandidate.") || field.startsWith("AI candidate:"))
  );
}

function candidateReasonCodeChain(cause: unknown): readonly string[] {
  const reasonCodes = ["LEGACY_CANDIDATE_METADATA_INVALID"];
  if (cause instanceof AppError) {
    reasonCodes.push(cause.code);
    reasonCodes.push(candidateFieldReasonCode(cause.details.field));
    const validationCode = safeReasonCode(cause.details.validationCode);
    if (validationCode !== null) reasonCodes.push(validationCode);
  } else {
    reasonCodes.push("UNKNOWN_CANDIDATE_VALIDATION_FAILURE");
  }
  return Object.freeze([...new Set(reasonCodes)]);
}

function candidateFieldReasonCode(field: unknown): string {
  switch (field) {
    case "aiCandidate.id":
      return "AI_CANDIDATE_ID_INVALID";
    case "aiCandidate.projectId":
      return "AI_CANDIDATE_PROJECT_ID_INVALID";
    case "aiCandidate.chapterId":
      return "AI_CANDIDATE_CHAPTER_ID_INVALID";
    case "aiCandidate.baseVersionId":
      return "AI_CANDIDATE_BASE_VERSION_ID_INVALID";
    case "aiCandidate.contentChecksum":
      return "AI_CANDIDATE_CONTENT_CHECKSUM_INVALID";
    case "aiCandidate.createdAt":
      return "AI_CANDIDATE_CREATED_AT_INVALID";
    case "aiCandidate.updatedAt":
      return "AI_CANDIDATE_UPDATED_AT_INVALID";
    case "aiCandidate.decidedAt":
      return "AI_CANDIDATE_DECIDED_AT_INVALID";
    default:
      return typeof field === "string" && field.startsWith("AI candidate:")
        ? "AI_CANDIDATE_ENTITY_INVALID"
        : "AI_CANDIDATE_METADATA_INVALID";
  }
}

function safeReasonCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : null;
}

function safeRepositoryStack(cause: unknown): readonly string[] {
  const frames: string[] = [];
  const visited = new Set<unknown>();
  let current: unknown = cause;
  while (current instanceof Error && !visited.has(current) && visited.size < 8) {
    visited.add(current);
    if (typeof current.stack === "string") {
      for (const rawLine of current.stack.split(/\r?\n/gu).slice(1)) {
        const line = rawLine.trim().replaceAll("\\", "/");
        const functionName = /^at\s+([A-Za-z_$<>][A-Za-z0-9_$<>.]*)/u.exec(line)?.[1] ?? null;
        const path =
          /((?:(?:apps\/desktop\/src|packages\/[A-Za-z0-9_-]+\/src|src)\/[A-Za-z0-9_./-]+|assets\/[A-Za-z0-9_.-]+\.js):\d+:\d+)/u.exec(
            line,
          )?.[1];
        if (path !== undefined) {
          frames.push(`at ${functionName ?? "anonymous"} (${path})`);
        }
        if (frames.length >= 12) break;
      }
    }
    if (frames.length >= 12) break;
    current = errorCause(current);
  }
  return Object.freeze([...new Set(frames)]);
}

function safeMetadataFingerprint(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const codePoint of Array.from(parts.join("\u001f"))) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
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

    return err(attachErrorCause(normalizeDatabaseError(operation, error), error));
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
  if (
    nativeCode === "SQLITE_WRITE_OUTCOME_UNKNOWN" ||
    nativeCode === "SQLITE_COMMIT_OUTCOME_UNKNOWN"
  ) {
    return new AppError({
      code: "REPOSITORY_ERROR",
      message: "本地写入结果暂时无法确认。",
      retryable: false,
      actions: ["EXPORT_DRAFT"],
      details: { databaseCode: nativeCode, operation, outcome: "unknown" },
    });
  }
  if (nativeCode === "SQLITE_OPERATION_TIMEOUT") {
    return new AppError({
      code: "REPOSITORY_ERROR",
      message: "本地数据操作等待超时。",
      retryable: true,
      actions: ["RETRY", "EXPORT_DRAFT"],
      details: { databaseCode: nativeCode, operation, outcome: "not_confirmed" },
    });
  }
  if (nativeCode === "PROJECT_REMOTE_DISPATCH_ACTIVE") {
    return new AppError({
      code: "SAVE_FAILED",
      message:
        "This project is still sending context to AI. Cancel that task or wait for it to finish before enabling local-only privacy.",
      retryable: true,
      actions: ["RETRY"],
      details: { databaseCode: nativeCode, operation },
    });
  }
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
      operation,
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

async function candidateAuthorityError(
  executor: TransactionExecutor,
  candidateId: UuidV7,
  expected: Readonly<{ status: AiCandidateStatus; revision: number }>,
): Promise<AppError> {
  const rows = await executor.select<CandidateAuthorityDbRow>(
    "SELECT status, revision FROM ai_candidates WHERE id = ? LIMIT 1",
    [candidateId],
  );
  const current = rows[0];
  if (current === undefined) {
    return new AppError({
      code: "CANDIDATE_NOT_FOUND",
      message: "The AI candidate no longer exists.",
      details: { candidateId },
    });
  }
  if (current.status !== expected.status) {
    return new AppError({
      code: "CANDIDATE_ALREADY_DECIDED",
      message: "The AI candidate status changed before this operation completed.",
      details: {
        candidateId,
        expectedStatus: expected.status,
        actualStatus: current.status,
      },
    });
  }
  if (current.revision !== expected.revision) {
    return new AppError({
      code: "VERSION_CONFLICT",
      message: "The AI candidate was revised in another window.",
      actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
      details: {
        entityType: "candidate",
        candidateId,
        expectedRevision: expected.revision,
        actualRevision: current.revision,
      },
    });
  }
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The AI candidate write did not complete.",
    retryable: true,
    actions: ["RETRY", "EXPORT_DRAFT"],
    details: { candidateId },
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

function requiredBooleanFlag(value: number, field: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw corruptData(field, "INVALID_BOOLEAN_FLAG");
}

function requireParsed<Value>(parsed: Result<Value, AppError>, field: string): Value {
  if (parsed.ok) {
    return parsed.value;
  }
  throw corruptData(field, parsed.error.code, parsed.error);
}

function requireEntity<Value>(
  restored: Result<Value, AppError>,
  entityType: string,
  entityId: string,
): Value {
  if (restored.ok) {
    return restored.value;
  }
  throw corruptData(`${entityType}:${entityId}`, restored.error.code, restored.error);
}

function corruptData(field: string, validationCode: string, cause?: unknown): AppError {
  const error = new AppError({
    code: "REPOSITORY_ERROR",
    message: "本地数据未通过完整性检查。",
    actions: ["EXPORT_DRAFT", "CONTACT_SUPPORT"],
    details: { field, validationCode },
  });
  return cause === undefined ? error : attachErrorCause(error, cause);
}

function attachErrorCause<ErrorType extends Error>(error: ErrorType, cause: unknown): ErrorType {
  if (cause === error || "cause" in error) {
    return error;
  }
  Object.defineProperty(error, "cause", {
    value: cause,
    enumerable: false,
    configurable: true,
  });
  return error;
}

function errorCause(error: Error): unknown {
  return "cause" in error ? (error as Error & { readonly cause?: unknown }).cause : undefined;
}
