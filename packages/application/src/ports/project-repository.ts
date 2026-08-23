import type {
  AppError,
  IsoUtcTimestamp,
  Project,
  ProjectStatus,
  Result,
  UuidV7,
} from "@inkshadow/domain";

export interface ProjectListQuery {
  readonly statuses: readonly ProjectStatus[];
  readonly search: string | null;
}

export interface ProjectRepository {
  create(
    project: Project,
    displayKind?: Exclude<ProjectDisplayKind, "system_evaluation">,
  ): Promise<Result<void, AppError>>;
  findById(id: UuidV7): Promise<Result<Project | null, AppError>>;
  list(query: ProjectListQuery): Promise<Result<readonly Project[], AppError>>;
  nameExists(
    normalizedName: string,
    excludingProjectId: UuidV7 | null,
  ): Promise<Result<boolean, AppError>>;
  save(project: Project, expectedRevision: number): Promise<Result<void, AppError>>;
}

export type ProjectDisplayKind =
  "author_work" | "test_work" | "builtin_example" | "system_evaluation";

export type ProjectDisplayIdentityProvenance =
  | "explicit_creation"
  | "explicit_test"
  | "builtin_example"
  | "evaluation_project_id"
  | "legacy_unknown";

/**
 * Content-free UI classification. A legacy project can have no persisted row;
 * in that case it resolves safely as an author work with legacy-unknown
 * provenance. The project name is never an identity signal.
 */
export interface ProjectDisplayIdentity {
  readonly projectId: UuidV7;
  readonly displayKind: ProjectDisplayKind;
  readonly provenance: ProjectDisplayIdentityProvenance;
  readonly recordedAt: IsoUtcTimestamp | null;
  readonly revision: number | null;
}

export interface ProjectDisplayIdentityRevision {
  readonly projectId: UuidV7;
  readonly revision: number;
  readonly previousDisplayKind: ProjectDisplayKind | null;
  readonly displayKind: ProjectDisplayKind;
  readonly provenance: Exclude<ProjectDisplayIdentityProvenance, "legacy_unknown">;
  readonly recordedAt: IsoUtcTimestamp;
}

export interface ProjectDisplayIdentityRepository {
  resolveByProjectId(projectId: UuidV7): Promise<Result<ProjectDisplayIdentity | null, AppError>>;
  recordAuthorWork(
    projectId: UuidV7,
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>>;
  recordTestWork(
    projectId: UuidV7,
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>>;
  recordBuiltinExampleOnCreation(
    projectId: UuidV7,
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>>;
  listRevisions(
    projectId: UuidV7,
  ): Promise<Result<readonly ProjectDisplayIdentityRevision[], AppError>>;
}
