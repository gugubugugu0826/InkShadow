import {
  AUTHORITATIVE_STORY_GRAPH_LIMITS,
  AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS,
  BuildAuthoritativeStoryGraphProjection,
  QueryGraphRagContext,
  type AuditableGraphContextCandidate,
  type AuthoritativeStoryGraphBuildDiagnostics,
  type AuthoritativeStoryGraphProjectionBuild,
  type AuthoritativeStoryGraphReadSources,
  type AuthoritativeStoryGraphRebuildReceipt,
  type ContentHasher,
  type PersistedGraphRagProject,
} from "@inkshadow/application";
import { AppError, err, ok, parseUuidV7, type Clock, type Result } from "@inkshadow/domain";
import {
  GraphRagSqliteRepository,
  SqliteChapterRepository,
  SqliteChapterVersionRepository,
  type ExecuteResult,
  type SqlExecutor,
  type SqlPrimitive,
  type TransactionExecutor,
} from "@inkshadow/data";
import type { GraphRagQuery } from "@inkshadow/search-core";
import {
  SqliteStoryFactStore,
  SqliteFormalStoryRecordRepository,
  SqliteReviewItemRepository,
} from "@inkshadow/story-core";

export type StoryGraphFreshness = "fresh" | "missing" | "stale";

export interface StoryGraphInspection {
  readonly projectId: string;
  readonly freshness: StoryGraphFreshness;
  readonly projection: PersistedGraphRagProject | null;
  readonly authoritative: AuthoritativeStoryGraphBuildDiagnostics;
}

export interface StoryGraphRuntimePort {
  readonly available: true;
  inspectProject(projectId: string): Promise<Result<StoryGraphInspection, AppError>>;
  rebuildProject(
    projectId: string,
  ): Promise<Result<AuthoritativeStoryGraphRebuildReceipt, AppError>>;
  queryContext(query: GraphRagQuery): Promise<Result<AuditableGraphContextCandidate, AppError>>;
}

export interface SqliteStoryGraphRuntimeDependencies {
  /** Shared local executor used by Story autosave and the graph epoch seqlock. */
  readonly executor: SqlExecutor;
  readonly hasher: ContentHasher;
  readonly clock: Clock;
  /** Test/embedding seam; omitted production values use the audited defaults. */
  readonly capacityLimits?: AuthoritativeStoryGraphCapacityLimits;
}

export interface AuthoritativeStoryGraphCapacityLimits {
  readonly formalRecords: number;
  readonly reviewItems: number;
  readonly chapters: number;
  readonly totalFormalVersions: number;
  readonly totalReviewDecisions: number;
  readonly projectionSourceUtf8Bytes: number;
  readonly storedAuthorityUtf8Bytes: number;
}

interface AuthorityStateRow {
  readonly authority_epoch: number;
  readonly projected_epoch: number | null;
  readonly projected_graph_revision: number | null;
  readonly projection_complete: number | null;
  readonly diagnostics_json: string | null;
}

interface GraphProjectionMetadataRow {
  readonly revision: number;
  readonly status: string;
}

interface StoryGraphCheckpoint {
  readonly authorityEpoch: number;
  readonly projectedEpoch: number | null;
  readonly projectedGraphRevision: number | null;
  readonly projectionComplete: boolean | null;
  readonly graphRevision: number | null;
  readonly graphStatus: string | null;
  readonly diagnostics: AuthoritativeStoryGraphBuildDiagnostics | null;
}

interface AuthorityCapacityRow {
  readonly formal_record_count: number;
  readonly review_item_count: number;
  readonly chapter_count: number;
  readonly formal_version_count: number;
  readonly review_decision_count: number;
  readonly stored_authority_bytes: number;
}

type AuthorityBuildAttempt =
  | Readonly<{
      kind: "stable";
      epoch: number;
      build: AuthoritativeStoryGraphProjectionBuild;
    }>
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "error"; error: AppError }>;

/**
 * Production SQLite adapter.
 *
 * Story/chapter triggers advance a project authority epoch in the same commit
 * as every relevant mutation. Rebuild hashes outside the write lock, then uses
 * a short BEGIN IMMEDIATE transaction to compare-and-publish that epoch with
 * the graph revision. Queries compare two lightweight checkpoints around one
 * bounded graph load and discard their candidate if authority changed. Reads
 * intentionally avoid a long SQLite transaction so chapter autosave is never
 * held behind graph hydration.
 */
class SqliteStoryGraphRuntimeService implements StoryGraphRuntimePort {
  public readonly available = true as const;

  public constructor(private readonly dependencies: SqliteStoryGraphRuntimeDependencies) {}

  public async inspectProject(
    projectIdValue: string,
  ): Promise<Result<StoryGraphInspection, AppError>> {
    const projectId = normalizeProjectId(projectIdValue);
    if (!projectId.ok) {
      return projectId;
    }

    for (let attempt = 1; attempt <= AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS; attempt += 1) {
      const initial = await readCheckpoint(this.dependencies.executor, projectId.value);
      if (!initial.ok) {
        return initial;
      }

      const loaded = await new GraphRagSqliteRepository(this.dependencies.executor).loadProject(
        projectId.value,
      );
      if (!loaded.ok) {
        return loaded;
      }
      const final = await readCheckpoint(this.dependencies.executor, projectId.value);
      if (!final.ok) {
        return final;
      }
      if (
        !checkpointsEqual(initial.value, final.value) ||
        final.value.graphRevision !== (loaded.value?.revision ?? null)
      ) {
        continue;
      }

      return ok({
        projectId: projectId.value,
        freshness: inspectionFreshness(final.value, loaded.value),
        projection: loaded.value,
        authoritative:
          final.value.diagnostics ??
          emptyAuthoritativeDiagnostics(final.value.authorityEpoch !== 0),
      });
    }

    return err(authoritySnapshotConflict(projectId.value));
  }

  public async rebuildProject(
    projectIdValue: string,
  ): Promise<Result<AuthoritativeStoryGraphRebuildReceipt, AppError>> {
    const projectId = normalizeProjectId(projectIdValue);
    if (!projectId.ok) {
      return projectId;
    }

    for (let attempt = 1; attempt <= AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS; attempt += 1) {
      const authority = await this.buildAuthorityAttempt(projectId.value);
      if (authority.kind === "changed") {
        continue;
      }
      if (authority.kind === "error") {
        return err(authority.error);
      }

      try {
        const receipt = await this.dependencies.executor.transaction(async (transaction) => {
          await requireExistingProject(transaction, projectId.value);
          const state = await readAuthorityState(transaction, projectId.value);
          const currentEpoch =
            (state?.authority_epoch ?? 0) +
            (await readConfirmedStoryFactRevisionSum(transaction, projectId.value));
          if (currentEpoch !== authority.epoch) {
            throw new StoryGraphEpochChanged();
          }

          const metadata = await readGraphMetadata(transaction, projectId.value);
          await assertExclusiveStoryOwnership(transaction, projectId.value, state, metadata);
          const expectedRevision = metadata?.revision ?? 0;
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            throw new StoryGraphTransactionAbort(
              graphContractError(projectId.value, "GRAPH_REVISION_INVALID"),
            );
          }

          const scopedExecutor = new TransactionBoundSqlExecutor(transaction);
          // The authoritative Story projection exclusively owns this project.
          // Clearing its identity ledger inside the rollback boundary permits
          // recovery from a corrupt old relation row without permitting another
          // graph producer to be overwritten.
          await transaction.execute(
            "DELETE FROM graph_rag_relation_identities WHERE project_id = ?",
            [projectId.value],
          );
          const rebuiltAt = this.dependencies.clock.now();
          const replaced = await new GraphRagSqliteRepository(scopedExecutor).replaceProject({
            snapshot: authority.build.snapshot,
            expectedRevision,
            mutatedAt: rebuiltAt,
          });
          if (!replaced.ok) {
            throw new StoryGraphTransactionAbort(replaced.error);
          }
          if (
            replaced.value.projectId !== projectId.value ||
            replaced.value.previousRevision !== expectedRevision ||
            replaced.value.revision !== expectedRevision + 1 ||
            replaced.value.updatedAt !== rebuiltAt
          ) {
            throw new StoryGraphTransactionAbort(
              graphContractError(projectId.value, "MUTATION_RECEIPT_MISMATCH"),
            );
          }

          const published = await transaction.execute(
            `INSERT INTO authoritative_story_graph_state (
               project_id,
               schema_version,
               authority_epoch,
               projected_epoch,
               projected_graph_revision,
               projection_complete,
               diagnostics_json
             ) VALUES (?, 1, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id) DO UPDATE SET
               projected_epoch = excluded.projected_epoch,
               projected_graph_revision = excluded.projected_graph_revision,
               projection_complete = excluded.projection_complete,
               diagnostics_json = excluded.diagnostics_json
             WHERE authoritative_story_graph_state.authority_epoch =
               excluded.authority_epoch`,
            [
              projectId.value,
              state?.authority_epoch ?? 0,
              authority.epoch,
              replaced.value.revision,
              authority.build.diagnostics.partial ? 0 : 1,
              JSON.stringify(authority.build.diagnostics),
            ],
          );
          if (published.rowsAffected !== 1) {
            throw new StoryGraphEpochChanged();
          }

          return {
            ...authority.build.diagnostics,
            projectId: projectId.value,
            previousRevision: expectedRevision,
            revision: replaced.value.revision,
            rebuiltAt,
            casAttempts: attempt,
          } satisfies AuthoritativeStoryGraphRebuildReceipt;
        });
        return ok(receipt);
      } catch (cause: unknown) {
        if (cause instanceof StoryGraphEpochChanged) {
          continue;
        }
        if (cause instanceof StoryGraphTransactionAbort) {
          return err(cause.error);
        }
        return err(transactionFailure("STORY_GRAPH_REBUILD", cause));
      }
    }

    return err(authoritySnapshotConflict(projectId.value));
  }

  public async queryContext(
    query: GraphRagQuery,
  ): Promise<Result<AuditableGraphContextCandidate, AppError>> {
    const projectId = normalizeProjectId(query.projectId);
    if (!projectId.ok) {
      return projectId;
    }
    const initial = await readCheckpoint(this.dependencies.executor, projectId.value);
    if (!initial.ok) {
      return initial;
    }
    const queryable = requireQueryableCheckpoint(projectId.value, initial.value);
    if (!queryable.ok) {
      return queryable;
    }

    const repository = new GraphRagSqliteRepository(this.dependencies.executor);
    const loaded = await repository.loadProject(projectId.value);
    if (!loaded.ok) {
      return loaded;
    }
    if (loaded.value?.revision !== initial.value.projectedGraphRevision) {
      return err(graphNotReady(projectId.value, initial.value, "GRAPH_SNAPSHOT_CHANGED"));
    }
    const candidate = new QueryGraphRagContext(repository).executeLoaded(loaded.value, query);
    if (!candidate.ok) {
      return candidate;
    }

    const final = await readCheckpoint(this.dependencies.executor, projectId.value);
    if (!final.ok) {
      return final;
    }
    if (!checkpointsEqual(initial.value, final.value)) {
      return err(graphNotReady(projectId.value, final.value, "AUTHORITY_CHANGED_DURING_QUERY"));
    }
    return candidate;
  }

  private async buildAuthorityAttempt(projectId: string): Promise<AuthorityBuildAttempt> {
    const useConfirmedFacts = await hasConfirmedStoryFactAuthority(this.dependencies.executor);
    const before = await readAuthorityEpoch(this.dependencies.executor, projectId);
    if (!before.ok) {
      return { kind: "error", error: before.error };
    }
    const capacity = await preflightAuthorityCapacity(
      this.dependencies.executor,
      projectId,
      this.dependencies.capacityLimits ?? AUTHORITATIVE_STORY_GRAPH_LIMITS,
      useConfirmedFacts,
    );
    if (!capacity.ok) {
      const after = await readAuthorityEpoch(this.dependencies.executor, projectId);
      return after.ok && after.value !== before.value
        ? { kind: "changed" }
        : { kind: "error", error: capacity.error };
    }

    const built = await new BuildAuthoritativeStoryGraphProjection(
      createAuthoritativeSources(this.dependencies.executor, useConfirmedFacts),
      this.dependencies.hasher,
    ).execute(projectId);
    const after = await readAuthorityEpoch(this.dependencies.executor, projectId);
    if (!after.ok) {
      return { kind: "error", error: after.error };
    }
    if (before.value !== after.value) {
      return { kind: "changed" };
    }
    if (!built.ok) {
      return { kind: "error", error: built.error };
    }
    return { kind: "stable", epoch: before.value, build: built.value };
  }
}

export function createSqliteStoryGraphRuntime(
  dependencies: SqliteStoryGraphRuntimeDependencies,
): StoryGraphRuntimePort {
  return new SqliteStoryGraphRuntimeService(dependencies);
}

function createAuthoritativeSources(
  executor: SqlExecutor,
  useConfirmedFacts: boolean,
): AuthoritativeStoryGraphReadSources {
  return {
    ...(useConfirmedFacts ? { confirmedFacts: new SqliteStoryFactStore(executor) } : {}),
    formalRecords: new SqliteFormalStoryRecordRepository(executor),
    extractionReviews: new SqliteReviewItemRepository(executor, "extraction"),
    consistencyReviews: new SqliteReviewItemRepository(executor, "consistency"),
    chapters: new SqliteChapterRepository(executor),
    chapterVersions: new SqliteChapterVersionRepository(executor),
  };
}

async function hasConfirmedStoryFactAuthority(
  executor: Pick<SqlExecutor, "select">,
): Promise<boolean> {
  const rows = await executor.select<{ readonly present: number }>(
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'story_facts'
     ) THEN 1 ELSE 0 END AS present`,
  );
  return rows[0]?.present === 1;
}

async function readConfirmedStoryFactRevisionSum(
  executor: Pick<SqlExecutor, "select">,
  projectId: string,
): Promise<number> {
  if (!(await hasConfirmedStoryFactAuthority(executor))) return 0;
  const rows = await executor.select<{ readonly revision_sum: number }>(
    `SELECT COALESCE(SUM(revision), 0) AS revision_sum
     FROM story_facts
     WHERE project_id = ?`,
    [projectId],
  );
  const value = rows[0]?.revision_sum ?? 0;
  if (!safeEpoch(value)) throw new Error("STORY_FACT_AUTHORITY_REVISION_INVALID");
  return value;
}

async function readAuthorityEpoch(
  executor: SqlExecutor,
  projectId: string,
): Promise<Result<number, AppError>> {
  try {
    const factRevisionSum = await readConfirmedStoryFactRevisionSum(executor, projectId);
    const rows = await executor.select<{ readonly authority_epoch: number }>(
      `SELECT (COALESCE(state.authority_epoch, 0) + ?) AS authority_epoch
       FROM projects AS project
       LEFT JOIN authoritative_story_graph_state AS state
         ON state.project_id = project.id
       WHERE project.id = ?
       LIMIT 1`,
      [factRevisionSum, projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      return err(projectNotFound(projectId, "STORY_GRAPH_AUTHORITY_EPOCH"));
    }
    if (!safeEpoch(row.authority_epoch)) {
      return err(graphContractError(projectId, "AUTHORITY_EPOCH_INVALID"));
    }
    return ok(row.authority_epoch);
  } catch (cause: unknown) {
    return err(normalizeTransactionCause("STORY_GRAPH_AUTHORITY_EPOCH", cause));
  }
}

async function readCheckpoint(
  executor: SqlExecutor,
  projectId: string,
): Promise<Result<StoryGraphCheckpoint, AppError>> {
  try {
    const factRevisionSum = await readConfirmedStoryFactRevisionSum(executor, projectId);
    const rows = await executor.select<
      Readonly<{
        authority_epoch: number;
        projected_epoch: number | null;
        projected_graph_revision: number | null;
        projection_complete: number | null;
        diagnostics_json: string | null;
        graph_revision: number | null;
        graph_status: string | null;
      }>
    >(
      `SELECT
         (COALESCE(state.authority_epoch, 0) + ?) AS authority_epoch,
         state.projected_epoch,
         state.projected_graph_revision,
         state.projection_complete,
         state.diagnostics_json,
         graph.revision AS graph_revision,
         graph.status AS graph_status
       FROM projects AS project
       LEFT JOIN authoritative_story_graph_state AS state
         ON state.project_id = project.id
       LEFT JOIN graph_rag_projection_state AS graph
         ON graph.project_id = project.id
       WHERE project.id = ?
       LIMIT 1`,
      [factRevisionSum, projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      return err(projectNotFound(projectId, "STORY_GRAPH_CHECKPOINT"));
    }
    if (
      !safeEpoch(row.authority_epoch) ||
      (row.projected_epoch !== null && !safeEpoch(row.projected_epoch)) ||
      (row.projected_graph_revision !== null &&
        (!Number.isSafeInteger(row.projected_graph_revision) ||
          row.projected_graph_revision < 1)) ||
      (row.projection_complete !== null &&
        row.projection_complete !== 0 &&
        row.projection_complete !== 1) ||
      (row.graph_revision !== null &&
        (!Number.isSafeInteger(row.graph_revision) || row.graph_revision < 1))
    ) {
      return err(graphContractError(projectId, "CHECKPOINT_INVALID"));
    }
    const diagnostics = parseStoredDiagnostics(projectId, row.diagnostics_json);
    if (!diagnostics.ok) {
      return diagnostics;
    }
    return ok({
      authorityEpoch: row.authority_epoch,
      projectedEpoch: row.projected_epoch,
      projectedGraphRevision: row.projected_graph_revision,
      projectionComplete: row.projection_complete === null ? null : row.projection_complete === 1,
      graphRevision: row.graph_revision,
      graphStatus: row.graph_status,
      diagnostics: diagnostics.value,
    });
  } catch (cause: unknown) {
    return err(normalizeTransactionCause("STORY_GRAPH_CHECKPOINT", cause));
  }
}

async function preflightAuthorityCapacity(
  executor: SqlExecutor,
  projectId: string,
  limits: AuthoritativeStoryGraphCapacityLimits,
  useConfirmedFacts: boolean,
): Promise<Result<void, AppError>> {
  try {
    const rows = await executor.select<AuthorityCapacityRow>(
      useConfirmedFacts
        ? `SELECT
           (SELECT COUNT(*) FROM story_facts
             WHERE project_id = ? AND status = 'formal' AND user_confirmed = 1
               AND deprecated = 0 AND needs_review = 0 AND branch_id IS NULL) AS formal_record_count,
           (SELECT COUNT(*) FROM story_review_items WHERE project_id = ?) AS review_item_count,
           (SELECT COUNT(*) FROM chapters WHERE project_id = ?) AS chapter_count,
           COALESCE((
             SELECT SUM(revision)
             FROM story_facts
             WHERE project_id = ? AND status = 'formal' AND user_confirmed = 1
           ), 0) AS formal_version_count,
           COALESCE((
             SELECT SUM(json_array_length(snapshot_json, '$.decisions'))
             FROM story_review_items
             WHERE project_id = ?
           ), 0) AS review_decision_count,
           (
             COALESCE((
               SELECT SUM(length(CAST(COALESCE(content_text, '') AS BLOB)) + length(CAST(COALESCE(value_json, '') AS BLOB)))
               FROM story_facts
               WHERE project_id = ? AND status = 'formal' AND user_confirmed = 1
             ), 0)
             + COALESCE((
               SELECT SUM(length(CAST(snapshot_json AS BLOB)))
               FROM story_review_items
               WHERE project_id = ?
             ), 0)
             + COALESCE((
               SELECT SUM(length(CAST(content AS BLOB)))
               FROM chapters
               WHERE project_id = ?
             ), 0)
             + COALESCE((
               SELECT SUM(length(CAST(version.content AS BLOB)))
               FROM chapter_versions AS version
               INNER JOIN chapters AS chapter
                 ON chapter.project_id = version.project_id
                AND chapter.current_version_id = version.id
               WHERE version.project_id = ?
             ), 0)
           ) AS stored_authority_bytes
         FROM projects
         WHERE id = ?`
        : `SELECT
           (SELECT COUNT(*) FROM story_formal_records WHERE project_id = ?) AS formal_record_count,
           (SELECT COUNT(*) FROM story_review_items WHERE project_id = ?) AS review_item_count,
           (SELECT COUNT(*) FROM chapters WHERE project_id = ?) AS chapter_count,
           COALESCE((SELECT SUM(json_array_length(snapshot_json, '$.versions')) FROM story_formal_records WHERE project_id = ?), 0) AS formal_version_count,
           COALESCE((SELECT SUM(json_array_length(snapshot_json, '$.decisions')) FROM story_review_items WHERE project_id = ?), 0) AS review_decision_count,
           (
             COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM story_formal_records WHERE project_id = ?), 0) +
             COALESCE((SELECT SUM(length(CAST(snapshot_json AS BLOB))) FROM story_review_items WHERE project_id = ?), 0) +
             COALESCE((SELECT SUM(length(CAST(content AS BLOB))) FROM chapters WHERE project_id = ?), 0) +
             COALESCE((SELECT SUM(length(CAST(version.content AS BLOB))) FROM chapter_versions AS version INNER JOIN chapters AS chapter ON chapter.project_id = version.project_id AND chapter.current_version_id = version.id WHERE version.project_id = ?), 0)
           ) AS stored_authority_bytes
         FROM projects WHERE id = ?`,
      Array.from({ length: 10 }, () => projectId),
    );
    const row = rows[0];
    if (row === undefined) {
      return err(projectNotFound(projectId, "STORY_GRAPH_CAPACITY_PREFLIGHT"));
    }
    const checks = [
      ["formal_records", row.formal_record_count, limits.formalRecords],
      ["review_items", row.review_item_count, limits.reviewItems],
      ["chapters", row.chapter_count, limits.chapters],
      ["formal_versions", row.formal_version_count, limits.totalFormalVersions],
      ["review_decisions", row.review_decision_count, limits.totalReviewDecisions],
      ["stored_authority_utf8_bytes", row.stored_authority_bytes, limits.storedAuthorityUtf8Bytes],
    ] as const;
    for (const [capacity, actual, limit] of checks) {
      if (!Number.isSafeInteger(actual) || actual < 0) {
        return err(graphContractError(projectId, "CAPACITY_PREFLIGHT_VALUE_INVALID"));
      }
      if (actual > limit) {
        return err(capacityError(projectId, capacity, limit, actual));
      }
    }
    return ok(undefined);
  } catch (cause: unknown) {
    return err(normalizeTransactionCause("STORY_GRAPH_CAPACITY_PREFLIGHT", cause));
  }
}

async function requireExistingProject(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<void> {
  const rows = await transaction.select<{ readonly id: string }>(
    "SELECT id FROM projects WHERE id = ? LIMIT 1",
    [projectId],
  );
  if (rows[0]?.id !== projectId) {
    throw new StoryGraphTransactionAbort(projectNotFound(projectId, "STORY_GRAPH_PROJECT_LOOKUP"));
  }
}

async function readAuthorityState(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<AuthorityStateRow | null> {
  const rows = await transaction.select<AuthorityStateRow>(
    `SELECT
       authority_epoch,
       projected_epoch,
       projected_graph_revision,
       projection_complete,
       diagnostics_json
     FROM authoritative_story_graph_state
     WHERE project_id = ?
     LIMIT 1`,
    [projectId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  if (
    !safeEpoch(row.authority_epoch) ||
    (row.projected_epoch !== null && !safeEpoch(row.projected_epoch)) ||
    (row.projected_graph_revision !== null &&
      (!Number.isSafeInteger(row.projected_graph_revision) || row.projected_graph_revision < 1)) ||
    (row.projection_complete !== null &&
      row.projection_complete !== 0 &&
      row.projection_complete !== 1)
  ) {
    throw new StoryGraphTransactionAbort(graphContractError(projectId, "AUTHORITY_STATE_INVALID"));
  }
  return row;
}

async function readGraphMetadata(
  transaction: TransactionExecutor,
  projectId: string,
): Promise<GraphProjectionMetadataRow | null> {
  const rows = await transaction.select<GraphProjectionMetadataRow>(
    `SELECT revision, status
     FROM graph_rag_projection_state
     WHERE project_id = ?
     LIMIT 1`,
    [projectId],
  );
  return rows[0] ?? null;
}

async function assertExclusiveStoryOwnership(
  transaction: TransactionExecutor,
  projectId: string,
  authority: AuthorityStateRow | null,
  graph: GraphProjectionMetadataRow | null,
): Promise<void> {
  const ownerRevision = authority?.projected_graph_revision ?? null;
  if (ownerRevision !== null) {
    if (graph === null || graph.revision === ownerRevision) {
      return;
    }
    throw new StoryGraphTransactionAbort(
      graphContractError(projectId, "GRAPH_OWNER_REVISION_MISMATCH"),
    );
  }

  const rows = await transaction.select<{ readonly graph_rows_exist: number }>(
    `SELECT (
       EXISTS (SELECT 1 FROM graph_rag_projection_state WHERE project_id = ?)
       OR EXISTS (SELECT 1 FROM graph_rag_source_versions WHERE project_id = ?)
       OR EXISTS (SELECT 1 FROM graph_rag_entities WHERE project_id = ?)
       OR EXISTS (SELECT 1 FROM graph_rag_relations WHERE project_id = ?)
       OR EXISTS (SELECT 1 FROM graph_rag_relation_evidence WHERE project_id = ?)
       OR EXISTS (SELECT 1 FROM graph_rag_relation_identities WHERE project_id = ?)
     ) AS graph_rows_exist`,
    [projectId, projectId, projectId, projectId, projectId, projectId],
  );
  if (rows[0]?.graph_rows_exist !== 0) {
    throw new StoryGraphTransactionAbort(
      graphContractError(projectId, "GRAPH_OWNER_RECEIPT_MISSING"),
    );
  }
}

function requireQueryableCheckpoint(
  projectId: string,
  checkpoint: StoryGraphCheckpoint,
): Result<StoryGraphCheckpoint, AppError> {
  if (
    checkpoint.projectedEpoch !== null &&
    checkpoint.projectedEpoch === checkpoint.authorityEpoch &&
    checkpoint.projectionComplete === true &&
    checkpoint.projectedGraphRevision !== null &&
    checkpoint.projectedGraphRevision === checkpoint.graphRevision &&
    checkpoint.graphStatus === "ready"
  ) {
    return ok(checkpoint);
  }
  return err(graphNotReady(projectId, checkpoint, "PROJECTION_NOT_CURRENT"));
}

function inspectionFreshness(
  checkpoint: StoryGraphCheckpoint,
  persisted: PersistedGraphRagProject | null,
): StoryGraphFreshness {
  if (
    persisted === null ||
    checkpoint.projectedEpoch === null ||
    checkpoint.projectedGraphRevision === null
  ) {
    return "missing";
  }
  return checkpoint.projectedEpoch === checkpoint.authorityEpoch &&
    checkpoint.projectedGraphRevision === persisted.revision &&
    checkpoint.graphRevision === persisted.revision &&
    checkpoint.graphStatus === "ready"
    ? "fresh"
    : "stale";
}

function emptyAuthoritativeDiagnostics(stale: boolean): AuthoritativeStoryGraphBuildDiagnostics {
  return Object.freeze({
    formalRecordCount: 0,
    reviewItemCount: 0,
    chapterCount: 0,
    formalEntityCount: 0,
    chapterEntityCount: 0,
    relationCount: 0,
    sourceVersionCount: 0,
    skippedRelationCount: 0,
    invalidatedSupportCount: 0,
    projectionOmissionCount: 0,
    nonReviewDerivedFormalCount: 0,
    nonExtractionReviewFormalCount: 0,
    skipped: Object.freeze([]),
    partial: false,
    stale,
  });
}

const AUTHORITATIVE_DIAGNOSTIC_COUNT_FIELDS = [
  "formalRecordCount",
  "reviewItemCount",
  "chapterCount",
  "formalEntityCount",
  "chapterEntityCount",
  "relationCount",
  "sourceVersionCount",
  "skippedRelationCount",
  "invalidatedSupportCount",
  "projectionOmissionCount",
  "nonReviewDerivedFormalCount",
  "nonExtractionReviewFormalCount",
] as const;

const AUTHORITATIVE_SKIP_REASONS = new Set([
  "chapter_source_ill_formed_utf16",
  "chapter_source_too_large",
  "chapter_source_unsafe_control",
  "current_chapter_missing",
  "current_chapter_trashed",
  "current_chapter_version_changed",
]);

function parseStoredDiagnostics(
  projectId: string,
  serialized: string | null,
): Result<AuthoritativeStoryGraphBuildDiagnostics | null, AppError> {
  if (serialized === null) {
    return ok(null);
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isStoredDiagnostics(value)) {
      return err(graphContractError(projectId, "DIAGNOSTICS_INVALID"));
    }
    return ok(
      Object.freeze({
        ...value,
        skipped: Object.freeze(value.skipped.map((item) => Object.freeze({ ...item }))),
      }),
    );
  } catch {
    return err(graphContractError(projectId, "DIAGNOSTICS_INVALID"));
  }
}

function isStoredDiagnostics(value: unknown): value is AuthoritativeStoryGraphBuildDiagnostics {
  if (!isRecord(value)) {
    return false;
  }
  for (const field of AUTHORITATIVE_DIAGNOSTIC_COUNT_FIELDS) {
    if (!isNonNegativeSafeInteger(value[field])) {
      return false;
    }
  }
  if (
    typeof value.partial !== "boolean" ||
    typeof value.stale !== "boolean" ||
    !Array.isArray(value.skipped)
  ) {
    return false;
  }
  return value.skipped.every(
    (item) =>
      isRecord(item) &&
      typeof item.reason === "string" &&
      AUTHORITATIVE_SKIP_REASONS.has(item.reason) &&
      isNonNegativeSafeInteger(item.count),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqualJson(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftObject = left as Readonly<Record<string, unknown>>;
  const rightObject = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftObject).filter((key) => leftObject[key] !== undefined);
  const rightKeys = Object.keys(rightObject).filter((key) => rightObject[key] !== undefined);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightObject, key) &&
        deepEqualJson(leftObject[key], rightObject[key]),
    )
  );
}

function checkpointsEqual(left: StoryGraphCheckpoint, right: StoryGraphCheckpoint): boolean {
  return (
    left.authorityEpoch === right.authorityEpoch &&
    left.projectedEpoch === right.projectedEpoch &&
    left.projectedGraphRevision === right.projectedGraphRevision &&
    left.projectionComplete === right.projectionComplete &&
    left.graphRevision === right.graphRevision &&
    left.graphStatus === right.graphStatus &&
    deepEqualJson(left.diagnostics, right.diagnostics)
  );
}

function graphNotReady(
  projectId: string,
  checkpoint: StoryGraphCheckpoint,
  reason: string,
): AppError {
  return new AppError({
    code: "CANDIDATE_NOT_READY",
    message: "Graph context is unavailable until the Story projection is complete and current.",
    actions: ["RETRY"],
    details: {
      operation: "STORY_GRAPH_QUERY_FRESHNESS",
      projectId,
      reason,
      authorityEpoch: checkpoint.authorityEpoch,
      projectedEpoch: checkpoint.projectedEpoch,
      projectedGraphRevision: checkpoint.projectedGraphRevision,
      graphRevision: checkpoint.graphRevision,
      projectionComplete: checkpoint.projectionComplete,
      graphStatus: checkpoint.graphStatus,
    },
  });
}

function normalizeProjectId(value: string): Result<string, AppError> {
  const parsed = parseUuidV7(value);
  return parsed.ok ? ok(parsed.value) : parsed;
}

function safeEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function projectNotFound(projectId: string, operation: string): AppError {
  return new AppError({
    code: "PROJECT_NOT_FOUND",
    message: "The requested Story graph project does not exist.",
    details: { operation, projectId },
  });
}

class TransactionBoundSqlExecutor implements SqlExecutor {
  public constructor(private readonly transactionExecutor: TransactionExecutor) {}

  public select<Row extends object>(
    query: string,
    bindValues?: readonly SqlPrimitive[],
  ): Promise<Row[]> {
    return this.transactionExecutor.select<Row>(query, bindValues);
  }

  public execute(query: string, bindValues?: readonly SqlPrimitive[]): Promise<ExecuteResult> {
    return this.transactionExecutor.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return operation(this.transactionExecutor);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

class StoryGraphTransactionAbort extends Error {
  public constructor(public readonly error: AppError) {
    super(error.message);
    this.name = "StoryGraphTransactionAbort";
  }
}

class StoryGraphEpochChanged extends Error {
  public constructor() {
    super("Story authority changed before graph publication.");
    this.name = "StoryGraphEpochChanged";
  }
}

function normalizeTransactionCause(operation: string, cause: unknown): AppError {
  return cause instanceof StoryGraphTransactionAbort
    ? cause.error
    : transactionFailure(operation, cause);
}

function transactionFailure(operation: string, cause: unknown): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The Story graph persistence operation could not be completed.",
    retryable: true,
    actions: ["RETRY", "CONTACT_SUPPORT"],
    details: {
      operation,
      causeName: cause instanceof Error ? cause.name : "UnknownError",
    },
  });
}

function authoritySnapshotConflict(projectId: string): AppError {
  return new AppError({
    code: "VERSION_CONFLICT",
    message: "Story authority changed repeatedly while the graph snapshot was being prepared.",
    retryable: true,
    actions: ["RETRY"],
    details: {
      operation: "STORY_GRAPH_AUTHORITY_SNAPSHOT",
      projectId,
      attempts: AUTHORITATIVE_STORY_GRAPH_MAX_CAS_ATTEMPTS,
    },
  });
}

function graphContractError(projectId: string, reason: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The Story graph repository violated its ownership or persistence contract.",
    actions: ["CONTACT_SUPPORT"],
    details: {
      operation: "STORY_GRAPH_PROJECTION_CONTRACT",
      projectId,
      reason,
    },
  });
}

function capacityError(
  projectId: string,
  capacity: string,
  limit: number,
  actual: number,
): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message: "This project exceeds the current Story graph projection capacity.",
    actions: ["REDUCE_CONTEXT"],
    details: {
      operation: "AUTHORITATIVE_STORY_GRAPH_CAPACITY",
      projectId,
      capacity,
      limit,
      actual,
    },
  });
}
