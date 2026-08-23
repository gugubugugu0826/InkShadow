import type {
  ProjectDisplayIdentity,
  ProjectDisplayIdentityProvenance,
  ProjectDisplayIdentityRepository,
  ProjectDisplayIdentityRevision,
  ProjectDisplayKind,
} from "@inkshadow/application";
import {
  AppError,
  err,
  ok,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";

import type { SqlExecutor } from "./executor.js";

type PersistedProvenance = Exclude<ProjectDisplayIdentityProvenance, "legacy_unknown">;

interface ProjectDisplayIdentityDbRow {
  readonly project_id: string;
  readonly display_kind: string | null;
  readonly provenance: string | null;
  readonly recorded_at: string | null;
  readonly revision: number | null;
}

interface ProjectDisplayIdentityRevisionDbRow {
  readonly project_id: string;
  readonly revision: number;
  readonly previous_display_kind: string | null;
  readonly display_kind: string;
  readonly provenance: string;
  readonly recorded_at: string;
}

/**
 * Stores only explicit, content-free project classification. Names and story
 * contents are deliberately absent from every query in this repository.
 */
export class SqliteProjectDisplayIdentityRepository implements ProjectDisplayIdentityRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async resolveByProjectId(
    projectId: UuidV7,
  ): Promise<Result<ProjectDisplayIdentity | null, AppError>> {
    return attempt("read project display identity", async () => {
      const rows = await this.executor.select<ProjectDisplayIdentityDbRow>(
        `SELECT
           project.id AS project_id,
           identity.display_kind,
           identity.provenance,
           identity.updated_at AS recorded_at,
           identity.revision
         FROM projects AS project
         LEFT JOIN project_display_identities AS identity
           ON identity.project_id = project.id
         WHERE project.id = ?
         LIMIT 1`,
        [projectId],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return rehydrateIdentity(row);
    });
  }

  public recordAuthorWork(
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

  public recordTestWork(
    projectId: UuidV7,
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>> {
    return this.recordAuthorControlledIdentity(projectId, "test_work", "explicit_test", recordedAt);
  }

  public async recordBuiltinExampleOnCreation(
    projectId: UuidV7,
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>> {
    const recorded = await attempt("record built-in example project display identity", async () => {
      await this.executor.execute(
        `INSERT INTO project_display_identities (
           project_id, display_kind, provenance, revision, created_at, updated_at
         )
         SELECT ?, 'builtin_example', 'builtin_example', 1, ?, ?
         WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM novel_skill_evaluation_suites
             WHERE evaluation_project_id = ?
           )
         ON CONFLICT(project_id) DO NOTHING`,
        [projectId, recordedAt, recordedAt, projectId, projectId],
      );
    });
    if (!recorded.ok) return recorded;
    return this.requireResolved(projectId, "builtin_example");
  }

  public async listRevisions(
    projectId: UuidV7,
  ): Promise<Result<readonly ProjectDisplayIdentityRevision[], AppError>> {
    return attempt("list project display identity revisions", async () => {
      const rows = await this.executor.select<ProjectDisplayIdentityRevisionDbRow>(
        `SELECT
           project_id,
           revision,
           previous_display_kind,
           display_kind,
           provenance,
           recorded_at
         FROM project_display_identity_revisions
         WHERE project_id = ?
         ORDER BY revision ASC`,
        [projectId],
      );
      return Object.freeze(rows.map(rehydrateRevision));
    });
  }

  private async recordAuthorControlledIdentity(
    projectId: UuidV7,
    displayKind: "author_work" | "test_work",
    provenance: "explicit_creation" | "explicit_test",
    recordedAt: IsoUtcTimestamp,
  ): Promise<Result<ProjectDisplayIdentity, AppError>> {
    const recorded = await attempt(
      "record author-controlled project display identity",
      async () => {
        await this.executor.execute(
          `INSERT INTO project_display_identities (
           project_id, display_kind, provenance, revision, created_at, updated_at
         )
         SELECT ?, ?, ?, 1, ?, ?
         WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)
           AND NOT EXISTS (
             SELECT 1 FROM novel_skill_evaluation_suites
             WHERE evaluation_project_id = ?
           )
         ON CONFLICT(project_id) DO UPDATE SET
           display_kind = excluded.display_kind,
           provenance = excluded.provenance,
           revision = project_display_identities.revision + 1,
           updated_at = excluded.updated_at
         WHERE project_display_identities.display_kind IN ('author_work', 'test_work')
           AND (
             project_display_identities.display_kind <> excluded.display_kind
             OR project_display_identities.provenance <> excluded.provenance
           )
           AND NOT EXISTS (
             SELECT 1 FROM novel_skill_evaluation_suites
             WHERE evaluation_project_id = excluded.project_id
           )`,
          [projectId, displayKind, provenance, recordedAt, recordedAt, projectId, projectId],
        );
      },
    );
    if (!recorded.ok) return recorded;
    return this.requireResolved(projectId, displayKind);
  }

  private async requireResolved(
    projectId: UuidV7,
    requestedDisplayKind: ProjectDisplayKind,
  ): Promise<Result<ProjectDisplayIdentity, AppError>> {
    const resolved = await this.resolveByProjectId(projectId);
    if (!resolved.ok) return resolved;
    if (resolved.value !== null) {
      if (resolved.value.displayKind === requestedDisplayKind) return ok(resolved.value);
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "该作品类型受保护，不能执行这次分类变更。",
          retryable: false,
          actions: ["CONTACT_SUPPORT"],
          details: {
            operation: "PROJECT_DISPLAY_IDENTITY_PROTECTED",
            projectId,
            requestedDisplayKind,
            actualDisplayKind: resolved.value.displayKind,
          },
        }),
      );
    }
    return err(
      new AppError({
        code: "REPOSITORY_ERROR",
        message: "找不到要记录显示分类的作品。",
        details: { projectId },
      }),
    );
  }
}

function rehydrateIdentity(row: ProjectDisplayIdentityDbRow): ProjectDisplayIdentity {
  const projectId = requiredUuid(row.project_id, "projectDisplayIdentity.projectId");
  if (
    row.display_kind === null ||
    row.provenance === null ||
    row.recorded_at === null ||
    row.revision === null
  ) {
    return Object.freeze({
      projectId,
      displayKind: "author_work",
      provenance: "legacy_unknown",
      recordedAt: null,
      revision: null,
    });
  }
  const displayKind = requiredDisplayKind(row.display_kind);
  const provenance = requiredPersistedProvenance(row.provenance);
  requireIdentityPair(displayKind, provenance, row.project_id);
  return Object.freeze({
    projectId,
    displayKind,
    provenance,
    recordedAt: requiredTimestamp(row.recorded_at, "projectDisplayIdentity.recordedAt"),
    revision: requiredRevision(row.revision, "projectDisplayIdentity.revision"),
  });
}

function rehydrateRevision(
  row: ProjectDisplayIdentityRevisionDbRow,
): ProjectDisplayIdentityRevision {
  const displayKind = requiredDisplayKind(row.display_kind);
  const provenance = requiredPersistedProvenance(row.provenance);
  requireIdentityPair(displayKind, provenance, row.project_id);
  return Object.freeze({
    projectId: requiredUuid(row.project_id, "projectDisplayIdentityRevision.projectId"),
    revision: requiredRevision(row.revision, "projectDisplayIdentityRevision.revision"),
    previousDisplayKind:
      row.previous_display_kind === null ? null : requiredDisplayKind(row.previous_display_kind),
    displayKind,
    provenance,
    recordedAt: requiredTimestamp(row.recorded_at, "projectDisplayIdentityRevision.recordedAt"),
  });
}

function requiredDisplayKind(value: string): ProjectDisplayKind {
  if (
    value === "author_work" ||
    value === "test_work" ||
    value === "builtin_example" ||
    value === "system_evaluation"
  ) {
    return value;
  }
  throw corruptData("projectDisplayIdentity.displayKind", "INVALID_METADATA");
}

function requiredPersistedProvenance(value: string): PersistedProvenance {
  if (
    value === "explicit_creation" ||
    value === "explicit_test" ||
    value === "builtin_example" ||
    value === "evaluation_project_id"
  ) {
    return value;
  }
  throw corruptData("projectDisplayIdentity.provenance", "INVALID_METADATA");
}

function requireIdentityPair(
  displayKind: ProjectDisplayKind,
  provenance: PersistedProvenance,
  projectId: string,
): void {
  const valid =
    (displayKind === "author_work" && provenance === "explicit_creation") ||
    (displayKind === "test_work" && provenance === "explicit_test") ||
    (displayKind === "builtin_example" && provenance === "builtin_example") ||
    (displayKind === "system_evaluation" && provenance === "evaluation_project_id");
  if (!valid) throw corruptData(`project-display-identity:${projectId}`, "INVALID_METADATA");
}

function requiredRevision(value: number, field: string): number {
  if (Number.isSafeInteger(value) && value >= 1) return value;
  throw corruptData(field, "INVALID_REVISION");
}

function requiredUuid(value: string, field: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (parsed.ok) return parsed.value;
  throw corruptData(field, parsed.error.code);
}

function requiredTimestamp(value: string, field: string): IsoUtcTimestamp {
  const parsed = parseIsoUtcTimestamp(value);
  if (parsed.ok) return parsed.value;
  throw corruptData(field, parsed.error.code);
}

function corruptData(field: string, validationCode: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "本地作品分类记录未通过完整性检查。",
    actions: ["EXPORT_DRAFT", "CONTACT_SUPPORT"],
    details: { field, validationCode },
  });
}

async function attempt<Value>(
  operation: string,
  action: () => Promise<Value>,
): Promise<Result<Value, AppError>> {
  try {
    return ok(await action());
  } catch (cause: unknown) {
    if (cause instanceof AppError) return err(cause);
    const error = new AppError({
      code: "REPOSITORY_ERROR",
      message: "本地作品分类操作未完成。",
      retryable: true,
      actions: ["RETRY", "CONTACT_SUPPORT"],
      details: { operation },
    });
    Object.defineProperty(error, "cause", {
      value: cause,
      enumerable: false,
      configurable: true,
    });
    return err(error);
  }
}
