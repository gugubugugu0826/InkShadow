import type {
  AcceptCandidateCommit,
  AiCandidateRepository,
  ChapterRepository,
  ChapterVersionRepository,
  ContentCommitRepository,
  ProjectListQuery,
  ProjectImportCommitRepository,
  ProjectRepository,
  RecoveryDraftRepository,
  RestoreChapterVersionCommit,
  SaveChapterCommit,
  ImportProjectCommit,
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
  type AiCandidateSnapshot,
  type AiCandidateStatus,
  type AppErrorCode,
  type ChapterSnapshot,
  type ChapterVersionSnapshot,
  type ProjectSnapshot,
  type RecoveryDraftSnapshot,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";

import {
  DEVELOPMENT_DATABASE_KEY,
  recoverPreparedIdeationCommit,
} from "./development-atomic-journal";

export { DEVELOPMENT_DATABASE_KEY };

interface StoredDatabaseV1 {
  readonly schemaVersion: 1;
  projects: ProjectSnapshot[];
  chapters: ChapterSnapshot[];
  versions: ChapterVersionSnapshot[];
  drafts: RecoveryDraftSnapshot[];
  candidates: AiCandidateSnapshot[];
}

export interface DevelopmentLocalAuditEventSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly entityType: "project";
  readonly entityId: string;
  readonly action: "create_from_ideation";
  readonly requestId: string;
  readonly metadata: Readonly<{
    readonly source: "ideation";
    readonly mode: string;
  }>;
  readonly createdAt: string;
}

export interface DevelopmentStoredDatabase {
  readonly schemaVersion: 2;
  projects: ProjectSnapshot[];
  chapters: ChapterSnapshot[];
  versions: ChapterVersionSnapshot[];
  drafts: RecoveryDraftSnapshot[];
  candidates: AiCandidateSnapshot[];
  auditEvents: DevelopmentLocalAuditEventSnapshot[];
}

type StoredDatabase = DevelopmentStoredDatabase;

export interface DevelopmentAiCandidateRepository extends AiCandidateRepository {
  create(candidate: AiCandidate): Promise<Result<void, AppError>>;
  listByChapterId(chapterId: UuidV7): Promise<Result<readonly AiCandidate[], AppError>>;
}

export interface DevelopmentRepositories {
  readonly projects: ProjectRepository;
  readonly chapters: ChapterRepository;
  readonly chapterVersions: ChapterVersionRepository;
  readonly recoveryDrafts: RecoveryDraftRepository;
  readonly aiCandidates: DevelopmentAiCandidateRepository;
  readonly contentCommits: ContentCommitRepository;
  readonly projectImports: ProjectImportCommitRepository;
}

function emptyDatabase(): StoredDatabase {
  return {
    schemaVersion: 2,
    projects: [],
    chapters: [],
    versions: [],
    drafts: [],
    candidates: [],
    auditEvents: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStoredDatabaseV1(value: unknown): value is StoredDatabaseV1 {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.projects) &&
    Array.isArray(value.chapters) &&
    Array.isArray(value.versions) &&
    Array.isArray(value.drafts) &&
    Array.isArray(value.candidates)
  );
}

function isStoredDatabase(value: unknown): value is StoredDatabase {
  return (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    Array.isArray(value.projects) &&
    Array.isArray(value.chapters) &&
    Array.isArray(value.versions) &&
    Array.isArray(value.drafts) &&
    Array.isArray(value.candidates) &&
    Array.isArray(value.auditEvents)
  );
}

function migrateStoredDatabaseV1(database: StoredDatabaseV1): StoredDatabase {
  return {
    ...structuredClone(database),
    schemaVersion: 2,
    auditEvents: [],
  };
}

class DevelopmentDatabase {
  constructor(private readonly storage: Storage) {}

  read(): StoredDatabase {
    return readDevelopmentDatabase(this.storage);
  }

  write(database: StoredDatabase): void {
    this.storage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(database));
  }

  update(operation: (database: StoredDatabase) => void): void {
    const database = this.read();
    operation(database);
    this.write(database);
  }
}

export function readDevelopmentDatabase(storage: Storage): DevelopmentStoredDatabase {
  recoverPreparedIdeationCommit(storage);
  const serialized = storage.getItem(DEVELOPMENT_DATABASE_KEY);
  if (serialized === null) {
    return emptyDatabase();
  }

  const parsed: unknown = JSON.parse(serialized);
  if (isStoredDatabaseV1(parsed)) {
    return migrateStoredDatabaseV1(parsed);
  }
  if (!isStoredDatabase(parsed)) {
    throw repositoryError("读取浏览器开发数据", "DevelopmentDataShapeError");
  }
  return structuredClone(parsed);
}

class DevelopmentProjectRepository implements ProjectRepository {
  constructor(private readonly database: DevelopmentDatabase) {}

  create(project: Project): Promise<Result<void, AppError>> {
    return attempt("创建项目", () => {
      const snapshot = project.toSnapshot();
      this.database.update((database) => {
        if (
          database.projects.some(
            (item) =>
              item.status !== "trashed" &&
              item.name.toLocaleLowerCase() === snapshot.name.toLocaleLowerCase(),
          )
        ) {
          throw appError("PROJECT_NAME_CONFLICT", "已有同名项目。");
        }
        database.projects.push(snapshot);
      });
    });
  }

  findById(id: UuidV7): Promise<Result<Project | null, AppError>> {
    return attempt("读取项目", () => {
      const snapshot = this.database.read().projects.find((item) => item.id === id);
      return snapshot === undefined ? null : requireEntity(Project.rehydrate(snapshot));
    });
  }

  list(query: ProjectListQuery): Promise<Result<readonly Project[], AppError>> {
    return attempt("读取项目列表", () => {
      const search = query.search?.toLocaleLowerCase() ?? null;
      return this.database
        .read()
        .projects.filter(
          (project) =>
            query.statuses.includes(project.status) &&
            (search === null || project.name.toLocaleLowerCase().includes(search)),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((snapshot) => requireEntity(Project.rehydrate(snapshot)));
    });
  }

  nameExists(
    normalizedName: string,
    excludingProjectId: UuidV7 | null,
  ): Promise<Result<boolean, AppError>> {
    return attempt("检查项目名称", () =>
      this.database
        .read()
        .projects.some(
          (project) =>
            project.status !== "trashed" &&
            project.id !== excludingProjectId &&
            project.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
        ),
    );
  }

  save(project: Project, expectedRevision: number): Promise<Result<void, AppError>> {
    return attempt("保存项目", () => {
      const snapshot = project.toSnapshot();
      this.database.update((database) => {
        const index = database.projects.findIndex((item) => item.id === snapshot.id);
        const current = database.projects[index];
        if (current?.revision !== expectedRevision) {
          throw concurrencyError("项目", snapshot.id);
        }
        database.projects[index] = snapshot;
      });
    });
  }
}

class DevelopmentChapterRepository implements ChapterRepository {
  constructor(private readonly database: DevelopmentDatabase) {}

  findById(id: UuidV7): Promise<Result<Chapter | null, AppError>> {
    return attempt("读取章节", () => {
      const snapshot = this.database.read().chapters.find((item) => item.id === id);
      return snapshot === undefined ? null : requireEntity(Chapter.rehydrate(snapshot));
    });
  }

  listByProjectId(projectId: UuidV7): Promise<Result<readonly Chapter[], AppError>> {
    return attempt("读取章节列表", () =>
      this.database
        .read()
        .chapters.filter((chapter) => chapter.projectId === projectId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((snapshot) => requireEntity(Chapter.rehydrate(snapshot))),
    );
  }
}

class DevelopmentVersionRepository implements ChapterVersionRepository {
  constructor(private readonly database: DevelopmentDatabase) {}

  findVersionById(id: UuidV7): Promise<Result<ChapterVersion | null, AppError>> {
    return attempt("read chapter version", () => {
      const snapshot = this.database.read().versions.find((version) => version.id === id);
      return snapshot === undefined ? null : requireEntity(ChapterVersion.create(snapshot));
    });
  }

  listByChapterId(chapterId: UuidV7): Promise<Result<readonly ChapterVersion[], AppError>> {
    return attempt("读取版本历史", () =>
      this.database
        .read()
        .versions.filter((version) => version.chapterId === chapterId)
        .sort((left, right) => right.sequence - left.sequence)
        .map((snapshot) => requireEntity(ChapterVersion.create(snapshot))),
    );
  }
}

class DevelopmentDraftRepository implements RecoveryDraftRepository {
  constructor(private readonly database: DevelopmentDatabase) {}

  findByChapterId(chapterId: UuidV7): Promise<Result<RecoveryDraft | null, AppError>> {
    return attempt("读取恢复草稿", () => {
      const snapshot = this.database.read().drafts.find((draft) => draft.chapterId === chapterId);
      return snapshot === undefined ? null : requireEntity(RecoveryDraft.rehydrate(snapshot));
    });
  }

  upsert(draft: RecoveryDraft): Promise<Result<void, AppError>> {
    return attempt("保存恢复草稿", () => {
      const snapshot = draft.toSnapshot();
      this.database.update((database) => {
        database.drafts = database.drafts.filter((item) => item.chapterId !== snapshot.chapterId);
        database.drafts.push(snapshot);
      });
    });
  }

  delete(chapterId: UuidV7, draftId: UuidV7): Promise<Result<void, AppError>> {
    return attempt("删除恢复草稿", () => {
      this.database.update((database) => {
        database.drafts = database.drafts.filter(
          (draft) => !(draft.chapterId === chapterId && draft.id === draftId),
        );
      });
    });
  }
}

class DevelopmentCandidateRepository implements DevelopmentAiCandidateRepository {
  constructor(private readonly database: DevelopmentDatabase) {}

  create(candidate: AiCandidate): Promise<Result<void, AppError>> {
    return attempt("创建候选", () => {
      const snapshot = candidate.toSnapshot();
      this.database.update((database) => {
        if (database.candidates.some((item) => item.id === snapshot.id)) {
          throw repositoryError("创建候选", "DuplicateCandidate");
        }
        database.candidates.push(snapshot);
      });
    });
  }

  findById(id: UuidV7): Promise<Result<AiCandidate | null, AppError>> {
    return attempt("读取候选", () => {
      const snapshot = this.database.read().candidates.find((item) => item.id === id);
      return snapshot === undefined ? null : requireEntity(AiCandidate.rehydrate(snapshot));
    });
  }

  listByChapterId(chapterId: UuidV7): Promise<Result<readonly AiCandidate[], AppError>> {
    return attempt("读取候选列表", () =>
      this.database
        .read()
        .candidates.filter((candidate) => candidate.chapterId === chapterId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((snapshot) => requireEntity(AiCandidate.rehydrate(snapshot))),
    );
  }

  save(candidate: AiCandidate, expectedStatus: AiCandidateStatus): Promise<Result<void, AppError>> {
    return attempt("保存候选", () => {
      const snapshot = candidate.toSnapshot();
      this.database.update((database) => {
        const index = database.candidates.findIndex((item) => item.id === snapshot.id);
        const current = database.candidates[index];
        if (current?.status !== expectedStatus) {
          throw appError("CANDIDATE_ALREADY_DECIDED", "候选状态已发生变化。");
        }
        database.candidates[index] = snapshot;
      });
    });
  }
}

class DevelopmentContentCommitRepository implements ContentCommitRepository {
  constructor(private readonly database: DevelopmentDatabase) {}

  createChapter(
    commit: Parameters<ContentCommitRepository["createChapter"]>[0],
  ): ReturnType<ContentCommitRepository["createChapter"]> {
    return attempt("创建章节", () => {
      const chapter = commit.chapter.toSnapshot();
      const version = commit.initialVersion.toSnapshot();
      this.database.update((database) => {
        database.chapters.push(chapter);
        database.versions.push(version);
      });
      return { syncQueued: false };
    });
  }

  saveChapter(commit: SaveChapterCommit): ReturnType<ContentCommitRepository["saveChapter"]> {
    return attempt("提交章节版本", () => {
      const chapter = commit.chapter.toSnapshot();
      const version = commit.version.toSnapshot();
      this.database.update((database) => {
        const chapterIndex = database.chapters.findIndex((item) => item.id === chapter.id);
        const current = database.chapters[chapterIndex];
        if (current?.revision !== commit.expectedChapterRevision) {
          throw concurrencyError("章节", chapter.id);
        }
        const draftIndex = database.drafts.findIndex(
          (draft) => draft.chapterId === chapter.id && draft.id === commit.recoveryDraftId,
        );
        if (draftIndex < 0) {
          throw appError("RECOVERY_DRAFT_NOT_FOUND", "恢复草稿不存在。");
        }
        database.versions.push(version);
        database.chapters[chapterIndex] = chapter;
        database.drafts.splice(draftIndex, 1);
      });
      return { syncQueued: false };
    });
  }

  acceptCandidate(
    commit: AcceptCandidateCommit,
  ): ReturnType<ContentCommitRepository["acceptCandidate"]> {
    return attempt("接受候选", () => {
      const chapter = commit.chapter.toSnapshot();
      const version = commit.version.toSnapshot();
      const candidate = commit.candidate.toSnapshot();
      this.database.update((database) => {
        const chapterIndex = database.chapters.findIndex((item) => item.id === chapter.id);
        const currentChapter = database.chapters[chapterIndex];
        const candidateIndex = database.candidates.findIndex((item) => item.id === candidate.id);
        const currentCandidate = database.candidates[candidateIndex];
        if (currentChapter?.revision !== commit.expectedChapterRevision) {
          throw concurrencyError("章节", chapter.id);
        }
        if (currentCandidate?.status !== commit.expectedCandidateStatus) {
          throw appError("CANDIDATE_ALREADY_DECIDED", "候选状态已发生变化。");
        }
        database.versions.push(version);
        database.chapters[chapterIndex] = chapter;
        database.candidates[candidateIndex] = candidate;
      });
      return { syncQueued: false };
    });
  }

  restoreChapterVersion(
    commit: RestoreChapterVersionCommit,
  ): ReturnType<ContentCommitRepository["restoreChapterVersion"]> {
    return attempt("restore chapter version", () => {
      const chapter = commit.chapter.toSnapshot();
      const version = commit.version.toSnapshot();
      this.database.update((database) => {
        const chapterIndex = database.chapters.findIndex((item) => item.id === chapter.id);
        const current = database.chapters[chapterIndex];
        if (current?.revision !== commit.expectedChapterRevision) {
          throw concurrencyError("chapter", chapter.id);
        }
        if (database.versions.some((item) => item.id === version.id)) {
          throw repositoryError("restore chapter version", "DuplicateChapterVersion");
        }
        if (
          version.chapterId !== chapter.id ||
          version.projectId !== chapter.projectId ||
          version.parentVersionId !== current.currentVersionId ||
          version.sequence !== commit.expectedChapterRevision + 1 ||
          chapter.currentVersionId !== version.id ||
          chapter.revision !== version.sequence
        ) {
          throw repositoryError("restore chapter version", "InvalidRecoveryCommit");
        }
        database.versions.push(version);
        database.chapters[chapterIndex] = chapter;
      });
      return { syncQueued: false };
    });
  }
}

class DevelopmentProjectImportCommitRepository implements ProjectImportCommitRepository {
  constructor(private readonly database: DevelopmentDatabase) {}

  commitImport(commit: ImportProjectCommit): Promise<Result<void, AppError>> {
    return attempt("导入项目", () => {
      const projectSnapshot = commit.project.toSnapshot();
      this.database.update((database) => {
        const comparableName = projectSnapshot.name.toLocaleLowerCase();
        if (
          database.projects.some(
            (project) =>
              project.status !== "trashed" && project.name.toLocaleLowerCase() === comparableName,
          )
        ) {
          throw appError("PROJECT_NAME_CONFLICT", "已有同名项目。");
        }
        if (database.projects.some(({ id }) => id === projectSnapshot.id)) {
          throw repositoryError("导入项目", "DuplicateProjectId");
        }

        const chapterIds = new Set(database.chapters.map(({ id }) => id));
        const versionIds = new Set(database.versions.map(({ id }) => id));
        for (const imported of commit.chapters) {
          if (chapterIds.has(imported.chapter.id) || versionIds.has(imported.initialVersion.id)) {
            throw repositoryError("导入项目", "DuplicateImportedEntityId");
          }
          chapterIds.add(imported.chapter.id);
          versionIds.add(imported.initialVersion.id);
        }

        database.projects.push(projectSnapshot);
        for (const imported of commit.chapters) {
          database.chapters.push(imported.chapter.toSnapshot());
          database.versions.push(imported.initialVersion.toSnapshot());
        }
      });
    });
  }
}

export function createDevelopmentRepositories(storage: Storage): DevelopmentRepositories {
  const database = new DevelopmentDatabase(storage);
  return {
    projects: new DevelopmentProjectRepository(database),
    chapters: new DevelopmentChapterRepository(database),
    chapterVersions: new DevelopmentVersionRepository(database),
    recoveryDrafts: new DevelopmentDraftRepository(database),
    aiCandidates: new DevelopmentCandidateRepository(database),
    contentCommits: new DevelopmentContentCommitRepository(database),
    projectImports: new DevelopmentProjectImportCommitRepository(database),
  };
}

function requireEntity<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function attempt<Value>(operation: string, action: () => Value): Promise<Result<Value, AppError>> {
  try {
    return Promise.resolve(ok(action()));
  } catch (error: unknown) {
    return Promise.resolve(
      err(
        error instanceof AppError
          ? error
          : repositoryError(
              operation,
              error instanceof Error ? error.name : "UnknownDevelopmentStorageError",
            ),
      ),
    );
  }
}

function appError(code: AppErrorCode, message: string): AppError {
  return new AppError({ code, message });
}

function repositoryError(operation: string, cause: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: `无法${operation}。`,
    retryable: true,
    actions: ["RETRY", "EXPORT_DRAFT"],
    details: { cause },
  });
}

function concurrencyError(entity: string, id: UuidV7): AppError {
  return new AppError({
    code: "VERSION_CONFLICT",
    message: `${entity}已在其他操作中更新。`,
    actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
    details: { id },
  });
}
