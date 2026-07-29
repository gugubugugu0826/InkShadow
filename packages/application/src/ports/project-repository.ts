import type { AppError, Project, ProjectStatus, Result, UuidV7 } from "@inkshadow/domain";

export interface ProjectListQuery {
  readonly statuses: readonly ProjectStatus[];
  readonly search: string | null;
}

export interface ProjectRepository {
  create(project: Project): Promise<Result<void, AppError>>;
  findById(id: UuidV7): Promise<Result<Project | null, AppError>>;
  list(query: ProjectListQuery): Promise<Result<readonly Project[], AppError>>;
  nameExists(
    normalizedName: string,
    excludingProjectId: UuidV7 | null,
  ): Promise<Result<boolean, AppError>>;
  save(project: Project, expectedRevision: number): Promise<Result<void, AppError>>;
}
