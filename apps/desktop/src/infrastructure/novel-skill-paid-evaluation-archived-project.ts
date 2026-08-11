import type { ProjectRepository } from "@inkshadow/application";
import {
  Project,
  parseUuidV7,
  type AppError,
  type Clock,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";
import type { SqlExecutor } from "@inkshadow/data";

import {
  NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE,
  type ArchivedEvaluationProjectContentCounts,
  type ArchivedEvaluationProjectPort,
  type ArchivedEvaluationProjectSnapshot,
  type NovelSkillPaidEvaluationArchivedProjectIdentity,
} from "./novel-skill-paid-evaluation-preparation";

interface EvaluationProjectContentCountRow {
  readonly chapters: number;
  readonly story_facts: number;
  readonly project_seeds: number;
  readonly planning_candidates: number;
  readonly writing_preferences: number;
  readonly settings_receipts: number;
  readonly skill_bindings: number;
}

export type NovelSkillPaidEvaluationArchivedProjectErrorCode =
  | "NOVEL_SKILL_PAID_EVALUATION_PROJECT_INVALID"
  | "NOVEL_SKILL_PAID_EVALUATION_PROJECT_CONFLICT"
  | "NOVEL_SKILL_PAID_EVALUATION_PROJECT_PERSISTENCE_FAILED"
  | "NOVEL_SKILL_PAID_EVALUATION_PROJECT_NOT_EMPTY";

export class NovelSkillPaidEvaluationArchivedProjectError extends Error {
  public constructor(
    readonly code: NovelSkillPaidEvaluationArchivedProjectErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NovelSkillPaidEvaluationArchivedProjectError";
  }
}

export interface SqliteArchivedEvaluationProjectOptions {
  readonly projects: ProjectRepository;
  readonly executor: SqlExecutor;
  readonly clock: Clock;
}

const projectPreparationLocks = new Map<string, Promise<ArchivedEvaluationProjectSnapshot>>();

/**
 * Creates exactly one deterministic, content-free project for a paid evaluation
 * run. Creation and archiving are intentionally resumable: a crash after the
 * first insert leaves an empty active project that the next call archives after
 * rechecking its identity and contents.
 */
export class SqliteArchivedEvaluationProjectPort implements ArchivedEvaluationProjectPort {
  public constructor(private readonly options: SqliteArchivedEvaluationProjectOptions) {}

  public async ensureDedicatedArchivedEmptyProject(
    input: Readonly<
      NovelSkillPaidEvaluationArchivedProjectIdentity & {
        requestedAt: string;
      }
    >,
  ): Promise<ArchivedEvaluationProjectSnapshot> {
    assertProjectIdentity(input);
    const preceding = projectPreparationLocks.get(input.projectId);
    if (preceding !== undefined) return preceding;

    const operation = this.ensureUnlocked(input);
    projectPreparationLocks.set(input.projectId, operation);
    try {
      return await operation;
    } finally {
      if (projectPreparationLocks.get(input.projectId) === operation) {
        projectPreparationLocks.delete(input.projectId);
      }
    }
  }

  private async ensureUnlocked(
    input: Readonly<
      NovelSkillPaidEvaluationArchivedProjectIdentity & {
        requestedAt: string;
      }
    >,
  ): Promise<ArchivedEvaluationProjectSnapshot> {
    const projectId = unwrapDomainResult(
      parseUuidV7(input.projectId),
      "The evaluation project identifier is invalid.",
    );
    let project = unwrapRepositoryResult(
      await this.options.projects.findById(projectId),
      "The evaluation project could not be read.",
    );

    if (project === null) {
      const duplicateName = unwrapRepositoryResult(
        await this.options.projects.nameExists(input.displayName, null),
        "The evaluation project name could not be checked.",
      );
      if (duplicateName) {
        throw projectError(
          "NOVEL_SKILL_PAID_EVALUATION_PROJECT_CONFLICT",
          "A different project already uses the reserved evaluation project name.",
        );
      }

      const created = unwrapDomainResult(
        Project.create({ id: projectId, name: input.displayName, now: this.options.clock.now() }),
        "The evaluation project could not be created.",
      );
      unwrapRepositoryResult(
        await this.options.projects.create(created),
        "The evaluation project could not be persisted.",
      );
      project = created;
    }

    if (project.id !== projectId || project.name !== input.displayName) {
      throw projectError(
        "NOVEL_SKILL_PAID_EVALUATION_PROJECT_CONFLICT",
        "The deterministic evaluation project identity is already occupied.",
      );
    }
    if (project.status === "trashed") {
      throw projectError(
        "NOVEL_SKILL_PAID_EVALUATION_PROJECT_CONFLICT",
        "A trashed evaluation project cannot be reused for commercial evidence.",
      );
    }

    const beforeArchiveCounts = await this.readContentCounts(projectId);
    assertEmptyProject(beforeArchiveCounts);

    if (project.status === "active") {
      const archived = unwrapDomainResult(
        project.archive(this.options.clock.now()),
        "The evaluation project could not be archived.",
      );
      unwrapRepositoryResult(
        await this.options.projects.save(archived, project.revision),
        "The evaluation project archive transition could not be persisted.",
      );
      project = archived;
    }

    const contentCounts = await this.readContentCounts(projectId);
    assertEmptyProject(contentCounts);
    const snapshot = project.toSnapshot();
    if (snapshot.status !== "archived" || snapshot.archivedAt === null) {
      throw projectError(
        "NOVEL_SKILL_PAID_EVALUATION_PROJECT_CONFLICT",
        "Paid evaluation requires an archived project authority.",
      );
    }

    return Object.freeze({
      projectId: snapshot.id,
      displayName: snapshot.name,
      purpose: NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE,
      ownerRunId: input.ownerRunId,
      status: snapshot.status,
      archivedAt: snapshot.archivedAt,
      trashedAt: snapshot.trashedAt,
      contentCounts,
    });
  }

  private async readContentCounts(
    projectId: UuidV7,
  ): Promise<ArchivedEvaluationProjectContentCounts> {
    let rows: readonly EvaluationProjectContentCountRow[];
    try {
      rows = await this.options.executor.select<EvaluationProjectContentCountRow>(
        `SELECT
          (SELECT COUNT(*) FROM chapters WHERE project_id = ?) AS chapters,
          (SELECT COUNT(*) FROM story_facts WHERE project_id = ?) AS story_facts,
          (SELECT COUNT(*) FROM project_seeds WHERE project_id = ?) AS project_seeds,
          (SELECT COUNT(*) FROM story_planning_candidates WHERE project_id = ?) AS planning_candidates,
          (SELECT COUNT(*) FROM writing_preferences WHERE project_id = ?) AS writing_preferences,
          (SELECT COUNT(*) FROM story_settings_import_receipts WHERE project_id = ?) AS settings_receipts,
          (SELECT COUNT(*) FROM project_novel_skill_bindings WHERE project_id = ?) AS skill_bindings`,
        [projectId, projectId, projectId, projectId, projectId, projectId, projectId],
      );
    } catch (error) {
      throw projectError(
        "NOVEL_SKILL_PAID_EVALUATION_PROJECT_PERSISTENCE_FAILED",
        "The evaluation project content boundary could not be verified.",
        error,
      );
    }
    const row = rows[0];
    if (row === undefined || rows.length !== 1) {
      throw projectError(
        "NOVEL_SKILL_PAID_EVALUATION_PROJECT_PERSISTENCE_FAILED",
        "The evaluation project content boundary returned an invalid result.",
      );
    }
    const counts = Object.freeze({
      chapters: row.chapters,
      storyFacts: row.story_facts,
      projectSeeds: row.project_seeds,
      planningCandidates: row.planning_candidates,
      writingPreferences: row.writing_preferences,
      settingsReceipts: row.settings_receipts,
      skillBindings: row.skill_bindings,
    });
    if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw projectError(
        "NOVEL_SKILL_PAID_EVALUATION_PROJECT_PERSISTENCE_FAILED",
        "The evaluation project content counts are invalid.",
      );
    }
    return counts;
  }
}

export function createSqliteArchivedEvaluationProjectPort(
  options: SqliteArchivedEvaluationProjectOptions,
): ArchivedEvaluationProjectPort {
  return new SqliteArchivedEvaluationProjectPort(options);
}

function assertProjectIdentity(
  input: Readonly<
    NovelSkillPaidEvaluationArchivedProjectIdentity & {
      requestedAt: string;
    }
  >,
): void {
  if (
    (input as { readonly purpose: unknown }).purpose !==
      NOVEL_SKILL_PAID_EVALUATION_PROJECT_PURPOSE ||
    input.ownerRunId.length === 0 ||
    input.displayName.length === 0 ||
    input.displayName.length > 120 ||
    input.requestedAt.length === 0
  ) {
    throw projectError(
      "NOVEL_SKILL_PAID_EVALUATION_PROJECT_INVALID",
      "The evaluation project identity is invalid.",
    );
  }
}

function assertEmptyProject(counts: ArchivedEvaluationProjectContentCounts): void {
  if (Object.values(counts).some((count) => count !== 0)) {
    throw projectError(
      "NOVEL_SKILL_PAID_EVALUATION_PROJECT_NOT_EMPTY",
      "The dedicated evaluation project contains user-authored or mutable project data.",
    );
  }
}

function unwrapDomainResult<T>(result: Result<T, AppError>, message: string): T {
  if (result.ok) return result.value;
  throw projectError("NOVEL_SKILL_PAID_EVALUATION_PROJECT_INVALID", message, result.error);
}

function unwrapRepositoryResult<T>(result: Result<T, AppError>, message: string): T {
  if (result.ok) return result.value;
  throw projectError(
    "NOVEL_SKILL_PAID_EVALUATION_PROJECT_PERSISTENCE_FAILED",
    message,
    result.error,
  );
}

function projectError(
  code: NovelSkillPaidEvaluationArchivedProjectErrorCode,
  message: string,
  cause?: unknown,
): NovelSkillPaidEvaluationArchivedProjectError {
  return new NovelSkillPaidEvaluationArchivedProjectError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
