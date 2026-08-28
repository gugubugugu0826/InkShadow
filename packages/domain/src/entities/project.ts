import { AppError } from "../shared/app-error.js";
import { err, ok, type Result } from "../shared/result.js";
import { compareTimestamps, type IsoUtcTimestamp, type UuidV7 } from "../shared/value-objects.js";

export const PROJECT_STATUSES = ["active", "archived", "trashed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectStatusBeforeTrash = Exclude<ProjectStatus, "trashed">;

export interface ProjectSnapshot {
  readonly id: UuidV7;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly revision: number;
  readonly deletionGeneration: number;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
  readonly archivedAt: IsoUtcTimestamp | null;
  readonly trashedAt: IsoUtcTimestamp | null;
  readonly retentionUntil: IsoUtcTimestamp | null;
  readonly statusBeforeTrash: ProjectStatusBeforeTrash | null;
}

export interface CreateProjectInput {
  readonly id: UuidV7;
  readonly name: string;
  readonly now: IsoUtcTimestamp;
}

export interface TrashProjectInput {
  readonly now: IsoUtcTimestamp;
  readonly retentionUntil: IsoUtcTimestamp;
}

export const MAX_PROJECT_NAME_LENGTH = 120;
const MAX_LEGACY_PROJECT_NAME_LENGTH = 10_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function normalizeProjectName(value: string): Result<string, AppError> {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PROJECT_NAME_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: `Project name must contain 1-${String(
          MAX_PROJECT_NAME_LENGTH,
        )} visible characters.`,
        details: { field: "name" },
      }),
    );
  }

  return ok(normalized);
}

function validateSnapshot(snapshot: ProjectSnapshot): Result<ProjectSnapshot, AppError> {
  const name = preserveLegacyProjectName(snapshot.name);
  if (!name.ok) {
    return name;
  }

  if (
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    !Number.isInteger(snapshot.deletionGeneration) ||
    snapshot.deletionGeneration < 0
  ) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Project revisions and deletion generations must be valid.",
      }),
    );
  }

  const isActive =
    snapshot.status === "active" &&
    snapshot.archivedAt === null &&
    snapshot.trashedAt === null &&
    snapshot.retentionUntil === null &&
    snapshot.statusBeforeTrash === null;
  const isArchived =
    snapshot.status === "archived" &&
    snapshot.archivedAt !== null &&
    snapshot.trashedAt === null &&
    snapshot.retentionUntil === null &&
    snapshot.statusBeforeTrash === null;
  const isTrashed =
    snapshot.status === "trashed" &&
    snapshot.trashedAt !== null &&
    snapshot.retentionUntil !== null &&
    snapshot.statusBeforeTrash !== null;

  if (!isActive && !isArchived && !isTrashed) {
    return err(
      new AppError({
        code: "INVALID_STATE_TRANSITION",
        message: "Project lifecycle timestamps do not match its status.",
        details: { status: snapshot.status },
      }),
    );
  }

  return ok({ ...snapshot, name: name.value });
}

function preserveLegacyProjectName(value: string): Result<string, AppError> {
  if (value.length > MAX_LEGACY_PROJECT_NAME_LENGTH || CONTROL_CHARACTER_PATTERN.test(value)) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "Persisted project name exceeds the safe read boundary.",
        details: { field: "name" },
      }),
    );
  }
  return ok(value);
}

export class Project {
  private constructor(private readonly snapshot: ProjectSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  static create(input: CreateProjectInput): Result<Project, AppError> {
    const name = normalizeProjectName(input.name);
    if (!name.ok) {
      return name;
    }

    return ok(
      new Project({
        id: input.id,
        name: name.value,
        status: "active",
        revision: 1,
        deletionGeneration: 0,
        createdAt: input.now,
        updatedAt: input.now,
        archivedAt: null,
        trashedAt: null,
        retentionUntil: null,
        statusBeforeTrash: null,
      }),
    );
  }

  static rehydrate(snapshot: ProjectSnapshot): Result<Project, AppError> {
    const validated = validateSnapshot(snapshot);
    return validated.ok ? ok(new Project(validated.value)) : validated;
  }

  get id(): UuidV7 {
    return this.snapshot.id;
  }

  get name(): string {
    return this.snapshot.name;
  }

  get status(): ProjectStatus {
    return this.snapshot.status;
  }

  get revision(): number {
    return this.snapshot.revision;
  }

  get retentionUntil(): IsoUtcTimestamp | null {
    return this.snapshot.retentionUntil;
  }

  toSnapshot(): ProjectSnapshot {
    return { ...this.snapshot };
  }

  rename(name: string, now: IsoUtcTimestamp): Result<Project, AppError> {
    if (this.snapshot.status === "trashed") {
      return err(
        new AppError({
          code: "PROJECT_DELETED",
          message: "Restore the project before renaming it.",
          actions: ["RESTORE"],
        }),
      );
    }

    const normalized = normalizeProjectName(name);
    if (!normalized.ok) {
      return normalized;
    }

    if (normalized.value === this.snapshot.name) {
      return ok(this);
    }

    return ok(
      new Project({
        ...this.snapshot,
        name: normalized.value,
        updatedAt: now,
        revision: this.snapshot.revision + 1,
      }),
    );
  }

  archive(now: IsoUtcTimestamp): Result<Project, AppError> {
    if (this.snapshot.status !== "active") {
      return err(
        new AppError({
          code: "INVALID_STATE_TRANSITION",
          message: "Only an active project can be archived.",
          details: { status: this.snapshot.status },
        }),
      );
    }

    return ok(
      new Project({
        ...this.snapshot,
        status: "archived",
        archivedAt: now,
        updatedAt: now,
        revision: this.snapshot.revision + 1,
      }),
    );
  }

  unarchive(now: IsoUtcTimestamp): Result<Project, AppError> {
    if (this.snapshot.status !== "archived") {
      return err(
        new AppError({
          code: "INVALID_STATE_TRANSITION",
          message: "Only an archived project can return to active work.",
          details: { status: this.snapshot.status },
        }),
      );
    }

    return ok(
      new Project({
        ...this.snapshot,
        status: "active",
        archivedAt: null,
        updatedAt: now,
        revision: this.snapshot.revision + 1,
      }),
    );
  }

  trash(input: TrashProjectInput): Result<Project, AppError> {
    if (this.snapshot.status === "trashed") {
      return err(
        new AppError({
          code: "PROJECT_DELETED",
          message: "The project is already in the recycle bin.",
          actions: ["RESTORE"],
        }),
      );
    }

    if (compareTimestamps(input.retentionUntil, input.now) <= 0) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "Project retention must end after the trash time.",
          details: { field: "retentionUntil" },
        }),
      );
    }

    return ok(
      new Project({
        ...this.snapshot,
        status: "trashed",
        updatedAt: input.now,
        trashedAt: input.now,
        retentionUntil: input.retentionUntil,
        statusBeforeTrash: this.snapshot.status,
        deletionGeneration: this.snapshot.deletionGeneration + 1,
        revision: this.snapshot.revision + 1,
      }),
    );
  }

  restore(now: IsoUtcTimestamp): Result<Project, AppError> {
    if (
      this.snapshot.status !== "trashed" ||
      this.snapshot.retentionUntil === null ||
      this.snapshot.statusBeforeTrash === null
    ) {
      return err(
        new AppError({
          code: "INVALID_STATE_TRANSITION",
          message: "Only a project in the recycle bin can be restored.",
        }),
      );
    }

    if (compareTimestamps(now, this.snapshot.retentionUntil) > 0) {
      return err(
        new AppError({
          code: "PROJECT_RETENTION_EXPIRED",
          message: "The project recovery period has expired.",
          actions: ["CONTACT_SUPPORT"],
        }),
      );
    }

    const restoredStatus = this.snapshot.statusBeforeTrash;
    return ok(
      new Project({
        ...this.snapshot,
        status: restoredStatus,
        archivedAt: restoredStatus === "archived" ? (this.snapshot.archivedAt ?? now) : null,
        trashedAt: null,
        retentionUntil: null,
        statusBeforeTrash: null,
        deletionGeneration: this.snapshot.deletionGeneration + 1,
        updatedAt: now,
        revision: this.snapshot.revision + 1,
      }),
    );
  }
}
