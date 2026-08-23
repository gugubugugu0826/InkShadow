import type {
  AcceptCandidateCommit,
  AiCandidateRepository,
  ChapterPrivacyRepository,
  ChapterRepository,
  ChapterVersionRepository,
  ContentCommitRepository,
  ProjectDisplayIdentity,
  ProjectDisplayIdentityProvenance,
  ProjectDisplayIdentityRepository,
  ProjectDisplayIdentityRevision,
  ProjectDisplayKind,
  ProjectListQuery,
  ProjectImportCommitRepository,
  ProjectRepository,
  RecoveryDraftRepository,
  RestoreChapterVersionCommit,
  SaveChapterCommit,
  ImportProjectCommit,
} from "@inkshadow/application";
import {
  acceptedVersionTaskSourceForChapterSave,
  type AcceptedCandidateTaskFactory,
  type AcceptedVersionTaskFactory,
} from "@inkshadow/data";
import {
  AiCandidate,
  AppError,
  Chapter,
  ChapterVersion,
  Project,
  RecoveryDraft,
  err,
  ok,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AiCandidateSnapshot,
  type AiCandidateStatus,
  type AppErrorCode,
  type ChapterSnapshot,
  type ChapterVersionSnapshot,
  type IsoUtcTimestamp,
  type ProjectSnapshot,
  type RecoveryDraftSnapshot,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";

import {
  DEVELOPMENT_DATABASE_KEY,
  recoverPreparedIdeationCommit,
} from "./development-atomic-journal";
import {
  createDevelopmentTaskIfAbsent,
  normalizeDevelopmentTaskCenterState,
  readDevelopmentTaskCenterState,
  type BrowserDevelopmentTaskCenterPersistence,
  type DevelopmentTaskCenterState,
} from "./task-center-store";

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

type PersistedProjectDisplayIdentityProvenance = Exclude<
  ProjectDisplayIdentityProvenance,
  "legacy_unknown"
>;

type DevelopmentProjectDisplayIdentityReadError =
  "IncompleteProjectDisplayIdentityAuditChain" | "InvalidProjectDisplayIdentityAuditChain";

export type DevelopmentProjectCreationDisplayKind = Exclude<
  ProjectDisplayKind,
  "system_evaluation"
>;

export interface DevelopmentProjectDisplayIdentitySnapshot {
  readonly projectId: UuidV7;
  readonly displayKind: ProjectDisplayKind;
  readonly provenance: PersistedProjectDisplayIdentityProvenance;
  readonly recordedAt: IsoUtcTimestamp;
  readonly revision: number;
}

export interface DevelopmentProjectDisplayIdentityRevisionSnapshot extends DevelopmentProjectDisplayIdentitySnapshot {
  readonly previousDisplayKind: ProjectDisplayKind | null;
}
export interface DevelopmentStoredDatabase {
  readonly schemaVersion: 2;
  projects: ProjectSnapshot[];
  chapters: ChapterSnapshot[];
  versions: ChapterVersionSnapshot[];
  drafts: RecoveryDraftSnapshot[];
  candidates: AiCandidateSnapshot[];
  auditEvents: DevelopmentLocalAuditEventSnapshot[];
  projectDisplayIdentities?: DevelopmentProjectDisplayIdentitySnapshot[];
  projectDisplayIdentityRevisions?: DevelopmentProjectDisplayIdentityRevisionSnapshot[];
  taskCenter?: DevelopmentTaskCenterState;
}

export interface NormalizedDevelopmentStoredDatabase extends DevelopmentStoredDatabase {
  projectDisplayIdentities: DevelopmentProjectDisplayIdentitySnapshot[];
  projectDisplayIdentityRevisions: DevelopmentProjectDisplayIdentityRevisionSnapshot[];
  readonly projectDisplayIdentityReadError: DevelopmentProjectDisplayIdentityReadError | null;
  taskCenter: DevelopmentTaskCenterState;
}

type StoredDatabase = NormalizedDevelopmentStoredDatabase;

export interface DevelopmentAiCandidateRepository extends AiCandidateRepository {
  create(candidate: AiCandidate): Promise<Result<void, AppError>>;
  listByChapterId(chapterId: UuidV7): Promise<Result<readonly AiCandidate[], AppError>>;
}

export interface DevelopmentProjectRepositoryContract extends ProjectRepository {
  create(
    project: Project,
    displayKind?: DevelopmentProjectCreationDisplayKind,
  ): Promise<Result<void, AppError>>;
}

export interface DevelopmentRepositories {
  readonly projects: DevelopmentProjectRepositoryContract;
  readonly projectDisplayIdentities: ProjectDisplayIdentityRepository;
  readonly chapters: ChapterRepository;
  readonly chapterPrivacy: ChapterPrivacyRepository;
  readonly chapterVersions: ChapterVersionRepository;
  readonly recoveryDrafts: RecoveryDraftRepository;
  readonly aiCandidates: DevelopmentAiCandidateRepository;
  readonly contentCommits: ContentCommitRepository;
  readonly projectImports: ProjectImportCommitRepository;
  readonly taskCenterPersistence: BrowserDevelopmentTaskCenterPersistence;
}
export interface CreateDevelopmentRepositoriesOptions {
  readonly acceptedVersionTaskFactory?: AcceptedVersionTaskFactory;
  readonly acceptedCandidateTaskFactory?: AcceptedCandidateTaskFactory;
}

function emptyDatabase(taskCenter: DevelopmentTaskCenterState): StoredDatabase {
  return {
    schemaVersion: 2,
    projects: [],
    chapters: [],
    versions: [],
    drafts: [],
    candidates: [],
    auditEvents: [],
    projectDisplayIdentities: [],
    projectDisplayIdentityRevisions: [],
    projectDisplayIdentityReadError: null,
    taskCenter,
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

function isStoredDatabase(value: unknown): value is DevelopmentStoredDatabase {
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

function migrateStoredDatabaseV1(
  database: StoredDatabaseV1,
  taskCenter: DevelopmentTaskCenterState,
): StoredDatabase {
  return {
    ...structuredClone(database),
    schemaVersion: 2,
    auditEvents: [],
    projectDisplayIdentities: [],
    projectDisplayIdentityRevisions: [],
    projectDisplayIdentityReadError: null,
    taskCenter,
  };
}

interface NormalizedProjectDisplayIdentityState {
  readonly projectDisplayIdentities: DevelopmentProjectDisplayIdentitySnapshot[];
  readonly projectDisplayIdentityRevisions: DevelopmentProjectDisplayIdentityRevisionSnapshot[];
  readonly projectDisplayIdentityReadError: DevelopmentProjectDisplayIdentityReadError | null;
}

function normalizeProjectDisplayIdentityState(
  database: DevelopmentStoredDatabase,
): NormalizedProjectDisplayIdentityState {
  const hasIdentities = database.projectDisplayIdentities !== undefined;
  const hasRevisions = database.projectDisplayIdentityRevisions !== undefined;
  if (!hasIdentities && !hasRevisions) {
    return {
      projectDisplayIdentities: [],
      projectDisplayIdentityRevisions: [],
      projectDisplayIdentityReadError: null,
    };
  }
  if (hasIdentities !== hasRevisions) {
    return invalidProjectDisplayIdentityState("IncompleteProjectDisplayIdentityAuditChain");
  }
  try {
    const identities = normalizeProjectDisplayIdentities(database.projectDisplayIdentities);
    const revisions = normalizeProjectDisplayIdentityRevisions(
      database.projectDisplayIdentityRevisions,
    );
    if (!hasValidProjectDisplayIdentityAuditChain(identities, revisions)) {
      return invalidProjectDisplayIdentityState("InvalidProjectDisplayIdentityAuditChain");
    }
    return {
      projectDisplayIdentities: identities,
      projectDisplayIdentityRevisions: revisions,
      projectDisplayIdentityReadError: null,
    };
  } catch {
    return invalidProjectDisplayIdentityState("InvalidProjectDisplayIdentityAuditChain");
  }
}

function invalidProjectDisplayIdentityState(
  error: DevelopmentProjectDisplayIdentityReadError,
): NormalizedProjectDisplayIdentityState {
  return {
    projectDisplayIdentities: [],
    projectDisplayIdentityRevisions: [],
    projectDisplayIdentityReadError: error,
  };
}

function hasValidProjectDisplayIdentityAuditChain(
  identities: readonly DevelopmentProjectDisplayIdentitySnapshot[],
  revisions: readonly DevelopmentProjectDisplayIdentityRevisionSnapshot[],
): boolean {
  const identitiesByProject = new Map(identities.map((identity) => [identity.projectId, identity]));
  const revisionsByProject = new Map<string, DevelopmentProjectDisplayIdentityRevisionSnapshot[]>();
  for (const revision of revisions) {
    if (!identitiesByProject.has(revision.projectId)) return false;
    const projectRevisions = revisionsByProject.get(revision.projectId) ?? [];
    projectRevisions.push(revision);
    revisionsByProject.set(revision.projectId, projectRevisions);
  }
  for (const identity of identities) {
    const projectRevisions = [...(revisionsByProject.get(identity.projectId) ?? [])].sort(
      (left, right) => left.revision - right.revision,
    );
    if (projectRevisions.length !== identity.revision) return false;
    for (const [index, revision] of projectRevisions.entries()) {
      const previous = projectRevisions[index - 1];
      if (
        revision.revision !== index + 1 ||
        revision.previousDisplayKind !== (previous?.displayKind ?? null)
      ) {
        return false;
      }
    }
    const latest = projectRevisions.at(-1);
    if (
      latest?.displayKind !== identity.displayKind ||
      latest.provenance !== identity.provenance ||
      latest.recordedAt !== identity.recordedAt
    ) {
      return false;
    }
  }
  return true;
}

function normalizeProjectDisplayIdentities(
  value: unknown,
): DevelopmentProjectDisplayIdentitySnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw repositoryError("读取项目显示身份", "InvalidIdentityCollection");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const identity = parseProjectDisplayIdentitySnapshot(item);
    if (seen.has(identity.projectId)) {
      throw repositoryError("读取项目显示身份", "DuplicateProjectIdentity");
    }
    seen.add(identity.projectId);
    return identity;
  });
}

function normalizeProjectDisplayIdentityRevisions(
  value: unknown,
): DevelopmentProjectDisplayIdentityRevisionSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw repositoryError("读取项目显示身份历史", "InvalidIdentityRevisionCollection");
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const revision = parseProjectDisplayIdentityRevisionSnapshot(item);
    const key = `${revision.projectId}:${String(revision.revision)}`;
    if (seen.has(key)) {
      throw repositoryError("读取项目显示身份历史", "DuplicateProjectIdentityRevision");
    }
    seen.add(key);
    return revision;
  });
}

function parseProjectDisplayIdentitySnapshot(
  value: unknown,
): DevelopmentProjectDisplayIdentitySnapshot {
  if (!isRecord(value)) {
    throw repositoryError("读取项目显示身份", "InvalidIdentityShape");
  }
  const projectId = parseStoredProjectId(value.projectId);
  const displayKind = parseStoredDisplayKind(value.displayKind);
  const provenance = parseStoredIdentityProvenance(value.provenance);
  requireStoredIdentityPair(displayKind, provenance);
  return {
    projectId,
    displayKind,
    provenance,
    recordedAt: parseStoredTimestamp(value.recordedAt),
    revision: parseStoredIdentityRevision(value.revision),
  };
}

function parseProjectDisplayIdentityRevisionSnapshot(
  value: unknown,
): DevelopmentProjectDisplayIdentityRevisionSnapshot {
  const identity = parseProjectDisplayIdentitySnapshot(value);
  if (!isRecord(value)) {
    throw repositoryError("读取项目显示身份历史", "InvalidIdentityRevisionShape");
  }
  const previousDisplayKind =
    value.previousDisplayKind === null ? null : parseStoredDisplayKind(value.previousDisplayKind);
  return { ...identity, previousDisplayKind };
}

function parseStoredProjectId(value: unknown): UuidV7 {
  if (typeof value !== "string") {
    throw repositoryError("读取项目显示身份", "InvalidProjectId");
  }
  const parsed = parseUuidV7(value);
  if (!parsed.ok) throw repositoryError("读取项目显示身份", parsed.error.code);
  return parsed.value;
}

function parseStoredTimestamp(value: unknown): IsoUtcTimestamp {
  if (typeof value !== "string") {
    throw repositoryError("读取项目显示身份", "InvalidRecordedAt");
  }
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) throw repositoryError("读取项目显示身份", parsed.error.code);
  return parsed.value;
}

function parseStoredIdentityRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw repositoryError("读取项目显示身份", "InvalidRevision");
  }
  return value as number;
}

function parseStoredDisplayKind(value: unknown): ProjectDisplayKind {
  if (
    value === "author_work" ||
    value === "test_work" ||
    value === "builtin_example" ||
    value === "system_evaluation"
  ) {
    return value;
  }
  throw repositoryError("读取项目显示身份", "InvalidDisplayKind");
}

function parseStoredIdentityProvenance(value: unknown): PersistedProjectDisplayIdentityProvenance {
  if (
    value === "explicit_creation" ||
    value === "explicit_test" ||
    value === "builtin_example" ||
    value === "evaluation_project_id"
  ) {
    return value;
  }
  throw repositoryError("读取项目显示身份", "InvalidProvenance");
}

function requireStoredIdentityPair(
  displayKind: ProjectDisplayKind,
  provenance: PersistedProjectDisplayIdentityProvenance,
): void {
  const valid =
    (displayKind === "author_work" && provenance === "explicit_creation") ||
    (displayKind === "test_work" && provenance === "explicit_test") ||
    (displayKind === "builtin_example" && provenance === "builtin_example") ||
    (displayKind === "system_evaluation" && provenance === "evaluation_project_id");
  if (!valid) throw repositoryError("读取项目显示身份", "MismatchedIdentityPair");
}
class DevelopmentDatabase {
  constructor(private readonly storage: Storage) {}

  read(): StoredDatabase {
    return readDevelopmentDatabase(this.storage);
  }

  write(database: StoredDatabase): void {
    const persisted: DevelopmentStoredDatabase = {
      schemaVersion: database.schemaVersion,
      projects: database.projects,
      chapters: database.chapters,
      versions: database.versions,
      drafts: database.drafts,
      candidates: database.candidates,
      auditEvents: database.auditEvents,
      projectDisplayIdentities: database.projectDisplayIdentities,
      projectDisplayIdentityRevisions: database.projectDisplayIdentityRevisions,
      taskCenter: database.taskCenter,
    };
    this.storage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(persisted));
  }

  update(operation: (database: StoredDatabase) => void): void {
    const database = this.read();
    operation(database);
    this.write(database);
  }

  taskCenterPersistence(): BrowserDevelopmentTaskCenterPersistence {
    return {
      read: () => this.read().taskCenter,
      write: (taskCenter) => {
        const normalized = normalizeDevelopmentTaskCenterState(taskCenter);
        this.update((database) => {
          database.taskCenter = normalized;
        });
      },
    };
  }
}

export function readDevelopmentDatabase(storage: Storage): NormalizedDevelopmentStoredDatabase {
  recoverPreparedIdeationCommit(storage);

  const serialized = storage.getItem(DEVELOPMENT_DATABASE_KEY);
  if (serialized === null) {
    return emptyDatabase(readDevelopmentTaskCenterState(storage));
  }

  const parsed: unknown = JSON.parse(serialized);
  if (isStoredDatabaseV1(parsed)) {
    return migrateStoredDatabaseV1(parsed, readDevelopmentTaskCenterState(storage));
  }
  if (!isStoredDatabase(parsed)) {
    throw repositoryError("读取浏览器开发数据", "DevelopmentDataShapeError");
  }
  const database = structuredClone(parsed);
  const identityState = normalizeProjectDisplayIdentityState(database);
  return {
    ...database,
    ...identityState,
    taskCenter: normalizeDevelopmentTaskCenterState(
      database.taskCenter ?? readDevelopmentTaskCenterState(storage),
    ),
  };
}

class DevelopmentProjectRepository implements DevelopmentProjectRepositoryContract {
  constructor(private readonly database: DevelopmentDatabase) {}

  create(
    project: Project,
    displayKind: DevelopmentProjectCreationDisplayKind = "author_work",
  ): Promise<Result<void, AppError>> {
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
        if (database.projects.some((item) => item.id === snapshot.id)) {
          throw repositoryError("创建项目", "DuplicateProjectId");
        }
        database.projects.push(snapshot);
        appendInitialProjectDisplayIdentity(database, snapshot.id, displayKind, snapshot.createdAt);
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

class DevelopmentProjectDisplayIdentityRepository implements ProjectDisplayIdentityRepository {
  constructor(private readonly database: DevelopmentDatabase) {}

  resolveByProjectId(projectId: UuidV7): Promise<Result<ProjectDisplayIdentity | null, AppError>> {
    return attempt("读取项目显示身份", () => {
      const database = this.database.read();
      requireProjectDisplayIdentityAuditChain(database);
      if (!database.projects.some((project) => project.id === projectId)) return null;
      const identity = database.projectDisplayIdentities.find(
        (candidate) => candidate.projectId === projectId,
      );
      return identity === undefined
        ? Object.freeze({
            projectId,
            displayKind: "author_work" as const,
            provenance: "legacy_unknown" as const,
            recordedAt: null,
            revision: null,
          })
        : toProjectDisplayIdentity(identity);
    });
  }

  recordAuthorWork(
    projectId: UuidV7,
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>> {
    return this.recordAuthorControlledIdentity(
      projectId,
      "author_work",
      "explicit_creation",
      recordedAt,
    );
  }

  recordTestWork(
    projectId: UuidV7,
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>> {
    return this.recordAuthorControlledIdentity(projectId, "test_work", "explicit_test", recordedAt);
  }

  recordBuiltinExampleOnCreation(
    projectId: UuidV7,
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>> {
    return attempt("记录内置示例身份", () => {
      this.database.update((database) => {
        requireStoredProject(database, projectId);
        const current = database.projectDisplayIdentities.find(
          (identity) => identity.projectId === projectId,
        );
        if (current !== undefined) {
          if (current.displayKind !== "builtin_example") {
            throw projectDisplayIdentityProtected("builtin_example", current.displayKind);
          }
          return;
        }
        appendInitialProjectDisplayIdentity(database, projectId, "builtin_example", recordedAt);
      });
      return toProjectDisplayIdentity(requireStoredIdentity(this.database.read(), projectId));
    });
  }

  listRevisions(
    projectId: UuidV7,
  ): Promise<Result<readonly ProjectDisplayIdentityRevision[], AppError>> {
    return attempt("读取项目显示身份历史", () => {
      const database = this.database.read();
      requireProjectDisplayIdentityAuditChain(database);
      return Object.freeze(
        database.projectDisplayIdentityRevisions
          .filter((revision) => revision.projectId === projectId)
          .sort((left, right) => left.revision - right.revision)
          .map((revision) => Object.freeze({ ...revision })),
      );
    });
  }

  private recordAuthorControlledIdentity(
    projectId: UuidV7,
    displayKind: "author_work" | "test_work",
    provenance: "explicit_creation" | "explicit_test",
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>> {
    return attempt("记录项目显示身份", () => {
      this.database.update((database) => {
        requireStoredProject(database, projectId);
        const index = database.projectDisplayIdentities.findIndex(
          (identity) => identity.projectId === projectId,
        );
        const current = database.projectDisplayIdentities[index];
        if (current === undefined) {
          appendInitialProjectDisplayIdentity(database, projectId, displayKind, recordedAt);
          return;
        }
        if (
          current.displayKind === "builtin_example" ||
          current.displayKind === "system_evaluation"
        ) {
          throw projectDisplayIdentityProtected(displayKind, current.displayKind);
        }
        if (current.displayKind === displayKind && current.provenance === provenance) {
          return;
        }
        const next = Object.freeze({
          projectId,
          displayKind,
          provenance,
          recordedAt,
          revision: current.revision + 1,
        });
        database.projectDisplayIdentities[index] = next;
        database.projectDisplayIdentityRevisions.push(
          Object.freeze({
            ...next,
            previousDisplayKind: current.displayKind,
          }),
        );
      });
      return toProjectDisplayIdentity(requireStoredIdentity(this.database.read(), projectId));
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

  listPrivacyAuthorityByProjectId(
    projectId: UuidV7,
  ): ReturnType<NonNullable<ChapterRepository["listPrivacyAuthorityByProjectId"]>> {
    return attempt("读取章节隐私元数据", () =>
      this.database
        .read()
        .chapters.filter((chapter) => chapter.projectId === projectId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((chapter) =>
          Object.freeze({
            chapterId: chapter.id,
            currentVersionId: chapter.currentVersionId,
            chapterRevision: chapter.revision,
            privacyRevision: chapter.privacyRevision,
            privacyMode: chapter.privacyMode,
            status: chapter.status,
          }),
        ),
    );
  }
}

class DevelopmentChapterPrivacyRepository implements ChapterPrivacyRepository {
  public constructor(private readonly database: DevelopmentDatabase) {}

  public updatePrivacy(
    chapter: Chapter,
    expectedPrivacyRevision: number,
  ): ReturnType<ChapterPrivacyRepository["updatePrivacy"]> {
    return attempt("update chapter privacy", () => {
      const snapshot = chapter.toSnapshot();
      this.database.update((database) => {
        const index = database.chapters.findIndex(({ id }) => id === snapshot.id);
        const currentSnapshot = database.chapters[index];
        if (currentSnapshot === undefined) {
          throw appError("CHAPTER_NOT_FOUND", "Chapter not found.");
        }
        const current = requireEntity(Chapter.rehydrate(currentSnapshot));
        if (current.privacyRevision !== expectedPrivacyRevision) {
          throw concurrencyError("chapter privacy", snapshot.id);
        }
        database.chapters[index] = snapshot;
      });
      return {
        chapter,
        blockedProjectionCount: 0,
        removedOutboxOperationCount: 0,
        acknowledgedCloudEvidenceCount: 0,
      };
    });
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

  save(
    candidate: AiCandidate,
    expected: Readonly<{ status: AiCandidateStatus; revision: number }>,
  ): Promise<Result<void, AppError>> {
    return attempt("保存候选", () => {
      const snapshot = candidate.toSnapshot();
      this.database.update((database) => {
        const index = database.candidates.findIndex((item) => item.id === snapshot.id);
        const current = database.candidates[index];
        if (current?.status !== expected.status) {
          throw appError("CANDIDATE_ALREADY_DECIDED", "候选状态已发生变化。");
        }
        const currentRevision = current.revision ?? 1;
        if (currentRevision !== expected.revision) {
          throw candidateRevisionConflict(snapshot.id, expected.revision, currentRevision);
        }
        database.candidates[index] = snapshot;
      });
    });
  }
}

class DevelopmentContentCommitRepository implements ContentCommitRepository {
  constructor(
    private readonly database: DevelopmentDatabase,
    private readonly acceptedCandidateTaskFactory?: AcceptedCandidateTaskFactory,
    private readonly acceptedVersionTaskFactory?: AcceptedVersionTaskFactory,
  ) {}

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
        const taskInput = this.acceptedVersionTaskFactory?.({
          source: acceptedVersionTaskSourceForChapterSave(commit.version),
          version: commit.version,
        });
        if (taskInput !== undefined) {
          createDevelopmentTaskIfAbsent(database.taskCenter, taskInput);
        }
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
        const currentCandidateRevision = currentCandidate.revision ?? 1;
        if (currentCandidateRevision !== commit.expectedCandidateRevision) {
          throw candidateRevisionConflict(
            candidate.id,
            commit.expectedCandidateRevision,
            currentCandidateRevision,
          );
        }
        database.versions.push(version);
        database.chapters[chapterIndex] = chapter;
        database.candidates[candidateIndex] = candidate;
        const taskInput =
          this.acceptedVersionTaskFactory?.({
            source: "candidate_accept",
            version: commit.version,
          }) ?? this.acceptedCandidateTaskFactory?.(commit);
        if (taskInput !== undefined) {
          createDevelopmentTaskIfAbsent(database.taskCenter, taskInput);
        }
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
        const taskInput = this.acceptedVersionTaskFactory?.({
          source: "version_restore",
          version: commit.version,
        });
        if (taskInput !== undefined) {
          createDevelopmentTaskIfAbsent(database.taskCenter, taskInput);
        }
      });
      return { syncQueued: false };
    });
  }
}

class DevelopmentProjectImportCommitRepository implements ProjectImportCommitRepository {
  constructor(
    private readonly database: DevelopmentDatabase,
    private readonly acceptedVersionTaskFactory?: AcceptedVersionTaskFactory,
  ) {}

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
        appendInitialProjectDisplayIdentity(
          database,
          projectSnapshot.id,
          "author_work",
          projectSnapshot.createdAt,
        );
        for (const imported of commit.chapters) {
          database.chapters.push(imported.chapter.toSnapshot());
          database.versions.push(imported.initialVersion.toSnapshot());
          const taskInput = this.acceptedVersionTaskFactory?.({
            source: "chapter_import",
            version: imported.initialVersion,
          });
          if (taskInput !== undefined) {
            createDevelopmentTaskIfAbsent(database.taskCenter, taskInput);
          }
        }
      });
    });
  }
}

export function createDevelopmentRepositories(
  storage: Storage,
  options: CreateDevelopmentRepositoriesOptions = {},
): DevelopmentRepositories {
  const database = new DevelopmentDatabase(storage);
  return {
    projects: new DevelopmentProjectRepository(database),
    projectDisplayIdentities: new DevelopmentProjectDisplayIdentityRepository(database),
    chapters: new DevelopmentChapterRepository(database),
    chapterPrivacy: new DevelopmentChapterPrivacyRepository(database),
    chapterVersions: new DevelopmentVersionRepository(database),
    recoveryDrafts: new DevelopmentDraftRepository(database),
    aiCandidates: new DevelopmentCandidateRepository(database),
    contentCommits: new DevelopmentContentCommitRepository(
      database,
      options.acceptedCandidateTaskFactory,
      options.acceptedVersionTaskFactory,
    ),
    projectImports: new DevelopmentProjectImportCommitRepository(
      database,
      options.acceptedVersionTaskFactory,
    ),
    taskCenterPersistence: database.taskCenterPersistence(),
  };
}

function appendInitialProjectDisplayIdentity(
  database: StoredDatabase,
  projectId: UuidV7,
  displayKind: DevelopmentProjectCreationDisplayKind,
  recordedAt: IsoUtcTimestamp,
): DevelopmentProjectDisplayIdentitySnapshot {
  requireProjectDisplayIdentityAuditChain(database);
  if (
    database.projectDisplayIdentities.some((identity) => identity.projectId === projectId) ||
    database.projectDisplayIdentityRevisions.some((revision) => revision.projectId === projectId)
  ) {
    throw repositoryError("记录项目显示身份", "DuplicateProjectIdentity");
  }
  const provenance = projectDisplayIdentityProvenanceForCreation(displayKind);
  const identity = Object.freeze({
    projectId,
    displayKind,
    provenance,
    recordedAt,
    revision: 1,
  });
  database.projectDisplayIdentities.push(identity);
  database.projectDisplayIdentityRevisions.push(
    Object.freeze({
      ...identity,
      previousDisplayKind: null,
    }),
  );
  return identity;
}

function projectDisplayIdentityProvenanceForCreation(
  displayKind: DevelopmentProjectCreationDisplayKind,
): "explicit_creation" | "explicit_test" | "builtin_example" {
  if (displayKind === "author_work") return "explicit_creation";
  if (displayKind === "test_work") return "explicit_test";
  return "builtin_example";
}

function requireProjectDisplayIdentityAuditChain(database: StoredDatabase): void {
  if (database.projectDisplayIdentityReadError !== null) {
    throw repositoryError("读取项目显示身份", database.projectDisplayIdentityReadError);
  }
}

function requireStoredProject(database: StoredDatabase, projectId: UuidV7): void {
  requireProjectDisplayIdentityAuditChain(database);
  if (!database.projects.some((project) => project.id === projectId)) {
    throw repositoryError("记录项目显示身份", "MissingProject");
  }
}

function requireStoredIdentity(
  database: StoredDatabase,
  projectId: UuidV7,
): DevelopmentProjectDisplayIdentitySnapshot {
  requireProjectDisplayIdentityAuditChain(database);
  const identity = database.projectDisplayIdentities.find(
    (candidate) => candidate.projectId === projectId,
  );
  if (identity === undefined) {
    throw repositoryError("读取项目显示身份", "MissingIdentityAfterWrite");
  }
  return identity;
}
function toProjectDisplayIdentity(
  identity: DevelopmentProjectDisplayIdentitySnapshot,
): ProjectDisplayIdentity {
  return Object.freeze({ ...identity });
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

function projectDisplayIdentityProtected(
  requestedDisplayKind: ProjectDisplayKind,
  actualDisplayKind: ProjectDisplayKind,
): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "该作品类型受保护，不能执行这次分类变更。",
    retryable: false,
    actions: ["CONTACT_SUPPORT"],
    details: {
      operation: "PROJECT_DISPLAY_IDENTITY_PROTECTED",
      requestedDisplayKind,
      actualDisplayKind,
    },
  });
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

function candidateRevisionConflict(
  candidateId: UuidV7,
  expectedRevision: number,
  actualRevision: number,
): AppError {
  return new AppError({
    code: "VERSION_CONFLICT",
    message: "The AI candidate was revised in another window.",
    actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
    details: {
      entityType: "candidate",
      candidateId,
      expectedRevision,
      actualRevision,
    },
  });
}
