import {
  AppError,
  Project,
  err,
  normalizeProjectName,
  ok,
  parseIsoUtcTimestamp,
  type Clock,
  type ProjectStatus,
  type Result,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";

import type { ProjectListQuery, ProjectRepository } from "../ports/project-repository.js";
import { findProject } from "./shared.js";

const PROJECT_RETENTION_DAYS = 30;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface CreateProjectCommand {
  readonly name: string;
}

export interface ListProjectsQuery {
  readonly statuses?: readonly ProjectStatus[];
  readonly search?: string | null;
}

export interface ProjectCommand {
  readonly projectId: UuidV7;
}

export interface RenameProjectCommand extends ProjectCommand {
  readonly name: string;
}

export class CreateProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateProjectCommand): Promise<Result<Project, AppError>> {
    const normalized = normalizeProjectName(command.name);
    if (!normalized.ok) {
      return normalized;
    }

    const duplicate = await this.projects.nameExists(normalized.value, null);
    if (!duplicate.ok) {
      return duplicate;
    }
    if (duplicate.value) {
      return err(projectNameConflict(normalized.value));
    }

    const project = Project.create({
      id: this.ids.next(),
      name: normalized.value,
      now: this.clock.now(),
    });
    if (!project.ok) {
      return project;
    }

    const persisted = await this.projects.create(project.value);
    return persisted.ok ? ok(project.value) : persisted;
  }
}

export class ListProjects {
  constructor(private readonly projects: ProjectRepository) {}

  execute(query: ListProjectsQuery = {}): Promise<Result<readonly Project[], AppError>> {
    const search = query.search?.trim();
    const repositoryQuery: ProjectListQuery = {
      statuses: query.statuses ?? ["active"],
      search: search === undefined || search.length === 0 ? null : search,
    };
    return this.projects.list(repositoryQuery);
  }
}

export class RenameProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: RenameProjectCommand): Promise<Result<Project, AppError>> {
    const found = await findProject(this.projects, command.projectId);
    if (!found.ok) {
      return found;
    }

    const renamed = found.value.rename(command.name, this.clock.now());
    if (!renamed.ok) {
      return renamed;
    }
    if (renamed.value === found.value) {
      return renamed;
    }

    const duplicate = await this.projects.nameExists(renamed.value.name, found.value.id);
    if (!duplicate.ok) {
      return duplicate;
    }
    if (duplicate.value) {
      return err(projectNameConflict(renamed.value.name));
    }

    const saved = await this.projects.save(renamed.value, found.value.revision);
    return saved.ok ? renamed : saved;
  }
}

export class ArchiveProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: ProjectCommand): Promise<Result<Project, AppError>> {
    const found = await findProject(this.projects, command.projectId);
    if (!found.ok) {
      return found;
    }

    const archived = found.value.archive(this.clock.now());
    if (!archived.ok) {
      return archived;
    }

    const saved = await this.projects.save(archived.value, found.value.revision);
    return saved.ok ? archived : saved;
  }
}

export class UnarchiveProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: ProjectCommand): Promise<Result<Project, AppError>> {
    const found = await findProject(this.projects, command.projectId);
    if (!found.ok) {
      return found;
    }

    const active = found.value.unarchive(this.clock.now());
    if (!active.ok) {
      return active;
    }

    const duplicate = await this.projects.nameExists(active.value.name, active.value.id);
    if (!duplicate.ok) {
      return duplicate;
    }
    if (duplicate.value) {
      return err(projectNameConflict(active.value.name));
    }

    const saved = await this.projects.save(active.value, found.value.revision);
    return saved.ok ? active : saved;
  }
}

export class TrashProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: ProjectCommand): Promise<Result<Project, AppError>> {
    const found = await findProject(this.projects, command.projectId);
    if (!found.ok) {
      return found;
    }

    const now = this.clock.now();
    const retentionUntil = parseIsoUtcTimestamp(
      new Date(Date.parse(now) + PROJECT_RETENTION_DAYS * MILLISECONDS_PER_DAY).toISOString(),
    );
    if (!retentionUntil.ok) {
      return retentionUntil;
    }

    const trashed = found.value.trash({
      now,
      retentionUntil: retentionUntil.value,
    });
    if (!trashed.ok) {
      return trashed;
    }

    const saved = await this.projects.save(trashed.value, found.value.revision);
    return saved.ok ? trashed : saved;
  }
}

export class RestoreProject {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(command: ProjectCommand): Promise<Result<Project, AppError>> {
    const found = await findProject(this.projects, command.projectId);
    if (!found.ok) {
      return found;
    }

    const restored = found.value.restore(this.clock.now());
    if (!restored.ok) {
      return restored;
    }

    const duplicate = await this.projects.nameExists(restored.value.name, restored.value.id);
    if (!duplicate.ok) {
      return duplicate;
    }
    if (duplicate.value) {
      return err(projectNameConflict(restored.value.name));
    }

    const saved = await this.projects.save(restored.value, found.value.revision);
    return saved.ok ? restored : saved;
  }
}

function projectNameConflict(name: string): AppError {
  return new AppError({
    code: "PROJECT_NAME_CONFLICT",
    message: "Another visible project already uses this name.",
    actions: ["RENAME"],
    details: { name },
  });
}
