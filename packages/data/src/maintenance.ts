import { AppError, err, ok, type Result } from "@inkshadow/domain";

import type { SqlExecutor } from "./executor.js";

export interface ForeignKeyViolation {
  readonly table: string;
  readonly rowId: number | null;
  readonly parent: string;
  readonly foreignKeyIndex: number;
}

export interface DatabaseIntegrityReport {
  readonly healthy: boolean;
  readonly integrityMessages: readonly string[];
  readonly foreignKeyViolations: readonly ForeignKeyViolation[];
}

export interface DatabaseBackupReceipt {
  readonly destinationKind: "user_selected_file";
  readonly integrityVerified: true;
}

export interface DatabaseRestoreReceipt {
  readonly sourceKind: "user_selected_file";
  readonly integrityVerified: true;
  readonly restoredTableCount: number;
}

interface IntegrityRow {
  integrity_check: string;
}

interface ForeignKeyRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

interface DatabaseListRow {
  readonly name: string;
  readonly file: string;
}

interface TableNameRow {
  readonly name: string;
}

interface SchemaContractRow {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
}

interface FineTuningJobRestoreRow {
  readonly id: string;
  readonly datasetId: string;
  readonly datasetRevision: number;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

interface FineTuningDeploymentRestoreRow {
  readonly id: string;
}

const RESTORABLE_TABLES = [
  "projects",
  "team_template_application_receipts",
  "project_team_template_settings",
  "project_team_template_prompt_refs",
  "project_team_template_prompt_rules",
  "project_team_template_checklist_items",
  "chapters",
  "chapter_versions",
  "recovery_drafts",
  "ai_candidates",
  "multi_agent_review_sessions",
  "multi_agent_review_participants",
  "multi_agent_review_turns",
  "multi_agent_review_conclusions",
  "multi_agent_review_source_references",
  "multi_agent_review_candidates",
  "governed_extension_budgets",
  "governed_extension_egress_receipts",
  "governed_extension_requests",
  "governed_extension_candidates",
  "governed_extension_audit_events",
  "chapter_translations",
  "short_drama_scripts",
  "local_audit_events",
  "background_tasks",
  "notifications",
  "story_outlines",
  "story_formal_records",
  "story_timeline_state",
  "story_review_items",
  "authoritative_extraction_jobs",
  "authoritative_extraction_candidates",
  "authoritative_extraction_evaluations",
  "authoritative_extraction_decision_claims",
  "story_memory_policies",
  "story_memory_records",
  "story_what_if_branches",
  "story_outline_drafts",
  "story_ideation_drafts",
  "story_materials",
  "story_material_references",
  "sync_ciphertext_chunks",
  "sync_outbox_operations",
  "sync_operation_chunks",
  "sync_tombstones",
  "sync_transfers",
  "sync_transfer_chunks",
  "sync_remote_checkpoints",
  "sync_device_sequences",
  "sync_incoming_batches",
  "sync_incremental_terminal_observations",
  "sync_inbox_operations",
  "sync_inbox_operation_chunks",
  "sync_snapshot_staging_sessions",
  "sync_snapshot_staging_pages",
  "sync_snapshot_staging_operations",
  "sync_snapshot_staging_chunks",
  "sync_snapshot_staging_operation_chunks",
  "sync_snapshot_staging_tombstones",
  "sync_snapshot_materialization_receipts",
  "project_sync_registrations",
  "sync_materialized_objects",
  "sync_materialized_checkpoints",
  "sync_content_conflicts",
  "sync_projection_jobs",
  "project_key_versions",
  "team_project_key_receipts",
  "cloud_project_key_checkpoints",
  "cloud_project_key_publications",
  "cloud_account_snapshots",
  "registered_device_snapshots",
  "device_public_key_records",
  "project_device_key_envelopes",
  "project_recovery_key_envelopes",
  "cloud_session_snapshots",
  "entitlement_cache",
  "offline_license_envelopes",
  "team_membership_snapshots",
  "model_profiles",
  "model_pricing_profiles",
  "model_role_routes",
  "ai_budget_policies",
  "ai_generation_runs",
  "ai_generation_route_selections",
  "ai_generation_attempt_usage",
  "ai_deferred_generation_requests",
  "fine_tuning_datasets",
  "fine_tuning_samples",
  "fine_tuning_approvals",
  "fine_tuning_quota_policies",
  "fine_tuning_jobs",
  "fine_tuning_model_artifacts",
  "fine_tuning_evaluations",
  "fine_tuning_deployments",
  "fine_tuning_operation_claims",
  "fine_tuning_audit_events",
  "community_marketplace_installs",
] as const;

// Search snapshots are derived projections, not backup authority. Clearing
// them in the same restore transaction prevents restored source data from
// being paired with an index built from the database that was replaced.
const DERIVED_TABLES_TO_CLEAR = [
  "graph_rag_projection_state",
  "search_vector_index_state",
  "search_index_documents",
  "search_index_state",
] as const;

const RESTORE_DELETE_ORDER = [
  "community_marketplace_installs",
  "fine_tuning_deployments",
  "fine_tuning_evaluations",
  "fine_tuning_audit_events",
  "fine_tuning_operation_claims",
  "fine_tuning_model_artifacts",
  "fine_tuning_jobs",
  "fine_tuning_samples",
  "fine_tuning_quota_policies",
  "fine_tuning_approvals",
  "fine_tuning_datasets",
  "authoritative_extraction_decision_claims",
  "authoritative_extraction_candidates",
  "authoritative_extraction_jobs",
  "authoritative_extraction_evaluations",
  "project_team_template_checklist_items",
  "project_team_template_prompt_rules",
  "project_team_template_prompt_refs",
  "project_team_template_settings",
  "team_template_application_receipts",
  "sync_projection_jobs",
  "sync_content_conflicts",
  "sync_materialized_checkpoints",
  "sync_materialized_objects",
  "project_sync_registrations",
  "sync_snapshot_materialization_receipts",
  "sync_snapshot_staging_operation_chunks",
  "sync_snapshot_staging_tombstones",
  "sync_snapshot_staging_chunks",
  "sync_snapshot_staging_operations",
  "sync_snapshot_staging_pages",
  "sync_snapshot_staging_sessions",
  "cloud_project_key_publications",
  "cloud_project_key_checkpoints",
  "team_project_key_receipts",
  "project_recovery_key_envelopes",
  "project_device_key_envelopes",
  "sync_inbox_operation_chunks",
  "sync_inbox_operations",
  "sync_incremental_terminal_observations",
  "sync_incoming_batches",
  "sync_remote_checkpoints",
  "sync_device_sequences",
  "ai_generation_attempt_usage",
  "ai_generation_route_selections",
  "ai_deferred_generation_requests",
  "ai_generation_runs",
  "ai_budget_policies",
  "model_role_routes",
  "model_pricing_profiles",
  "model_profiles",
  "multi_agent_review_source_references",
  "multi_agent_review_conclusions",
  "multi_agent_review_candidates",
  "multi_agent_review_turns",
  "multi_agent_review_participants",
  "multi_agent_review_sessions",
  "chapter_translations",
  "short_drama_scripts",
  "governed_extension_audit_events",
  "governed_extension_candidates",
  "governed_extension_requests",
  "governed_extension_egress_receipts",
  "governed_extension_budgets",
  "story_material_references",
  "story_materials",
  "team_membership_snapshots",
  "offline_license_envelopes",
  "entitlement_cache",
  "cloud_session_snapshots",
  "device_public_key_records",
  "registered_device_snapshots",
  "cloud_account_snapshots",
  "sync_transfer_chunks",
  "sync_transfers",
  "sync_operation_chunks",
  "sync_outbox_operations",
  "sync_tombstones",
  "sync_ciphertext_chunks",
  "project_key_versions",
  "story_ideation_drafts",
  "story_outline_drafts",
  "story_what_if_branches",
  "story_memory_records",
  "story_memory_policies",
  "story_review_items",
  "story_timeline_state",
  "story_formal_records",
  "story_outlines",
  "notifications",
  "background_tasks",
  "recovery_drafts",
  "ai_candidates",
  "local_audit_events",
  "chapter_versions",
  "chapters",
  "projects",
] as const;

const RESTORE_INSERT_ORDER = [
  "projects",
  "team_template_application_receipts",
  "project_team_template_settings",
  "project_team_template_prompt_refs",
  "project_team_template_prompt_rules",
  "project_team_template_checklist_items",
  "project_sync_registrations",
  "project_key_versions",
  "team_project_key_receipts",
  "cloud_project_key_publications",
  "cloud_project_key_checkpoints",
  "chapters",
  "chapter_versions",
  "recovery_drafts",
  "ai_candidates",
  "local_audit_events",
  "background_tasks",
  "notifications",
  "story_outlines",
  "multi_agent_review_sessions",
  "multi_agent_review_participants",
  "multi_agent_review_turns",
  "multi_agent_review_conclusions",
  "multi_agent_review_source_references",
  "multi_agent_review_candidates",
  "governed_extension_budgets",
  "governed_extension_egress_receipts",
  "governed_extension_requests",
  "governed_extension_candidates",
  "governed_extension_audit_events",
  "chapter_translations",
  "short_drama_scripts",
  "story_formal_records",
  "story_timeline_state",
  "story_review_items",
  "authoritative_extraction_jobs",
  "authoritative_extraction_candidates",
  "authoritative_extraction_evaluations",
  "authoritative_extraction_decision_claims",
  "story_memory_policies",
  "story_memory_records",
  "story_what_if_branches",
  "story_outline_drafts",
  "story_ideation_drafts",
  "story_materials",
  "story_material_references",
  "sync_remote_checkpoints",
  "sync_materialized_checkpoints",
  "sync_materialized_objects",
  "sync_content_conflicts",
  "sync_projection_jobs",
  "sync_device_sequences",
  "sync_snapshot_staging_sessions",
  "sync_snapshot_staging_pages",
  "sync_snapshot_staging_operations",
  "sync_snapshot_staging_chunks",
  "sync_snapshot_staging_operation_chunks",
  "sync_snapshot_staging_tombstones",
  "sync_snapshot_materialization_receipts",
  "sync_ciphertext_chunks",
  "sync_incoming_batches",
  "sync_incremental_terminal_observations",
  "sync_inbox_operations",
  "sync_inbox_operation_chunks",
  "sync_outbox_operations",
  "sync_operation_chunks",
  "sync_tombstones",
  "sync_transfers",
  "sync_transfer_chunks",
  "cloud_account_snapshots",
  "registered_device_snapshots",
  "device_public_key_records",
  "project_device_key_envelopes",
  "project_recovery_key_envelopes",
  "cloud_session_snapshots",
  "entitlement_cache",
  "offline_license_envelopes",
  "team_membership_snapshots",
  "model_profiles",
  "model_pricing_profiles",
  "model_role_routes",
  "ai_budget_policies",
  "ai_generation_runs",
  "ai_generation_route_selections",
  "ai_generation_attempt_usage",
  "ai_deferred_generation_requests",
  "fine_tuning_datasets",
  "fine_tuning_samples",
  "fine_tuning_approvals",
  "fine_tuning_quota_policies",
  "fine_tuning_jobs",
  "fine_tuning_model_artifacts",
  "fine_tuning_evaluations",
  "fine_tuning_deployments",
  "fine_tuning_operation_claims",
  "fine_tuning_audit_events",
  "community_marketplace_installs",
] as const;

const FINE_TUNING_JOB_PLACEHOLDER_INSERT = `
  INSERT INTO main.fine_tuning_jobs (
    id,
    project_id,
    dataset_id,
    dataset_revision,
    dataset_manifest_hash,
    dataset_approval_id,
    idempotency_key,
    request_hash,
    plan_hash,
    plan_json,
    provider_location,
    provider_id,
    status,
    revision,
    attempt_count,
    maximum_attempts,
    cancellation_requested,
    lease_owner,
    lease_expires_at,
    reserved_cost_micros,
    settled_cost_micros,
    cost_source,
    currency,
    month_key,
    artifact_id,
    failure_code,
    created_by,
    started_at,
    completed_at,
    created_at,
    updated_at
  )
  SELECT
    id,
    project_id,
    dataset_id,
    dataset_revision,
    dataset_manifest_hash,
    dataset_approval_id,
    idempotency_key,
    request_hash,
    plan_hash,
    plan_json,
    provider_location,
    provider_id,
    'running',
    revision,
    attempt_count,
    maximum_attempts,
    cancellation_requested,
    'inkshadow_restore',
    updated_at,
    reserved_cost_micros,
    settled_cost_micros,
    cost_source,
    currency,
    month_key,
    NULL,
    NULL,
    created_by,
    COALESCE(started_at, created_at),
    NULL,
    created_at,
    updated_at
  FROM restore_source.fine_tuning_jobs
  WHERE id = ?`;

const FINE_TUNING_DATASET_STAGE_FOR_JOB = `
  UPDATE main.fine_tuning_datasets
  SET
    state = 'approved',
    revision = ?,
    approved_by = ?,
    approved_at = ?
  WHERE id = ?`;

const FINE_TUNING_DATASET_FINALIZE = `
  UPDATE main.fine_tuning_datasets AS target
  SET (
    state,
    revision,
    approved_by,
    approved_at,
    updated_at
  ) = (
    SELECT
      source.state,
      source.revision,
      source.approved_by,
      source.approved_at,
      source.updated_at
    FROM restore_source.fine_tuning_datasets AS source
    WHERE source.id = target.id
  )`;

const FINE_TUNING_JOB_FINALIZE = `
  UPDATE main.fine_tuning_jobs AS target
  SET (
    status,
    revision,
    attempt_count,
    cancellation_requested,
    lease_owner,
    lease_expires_at,
    settled_cost_micros,
    cost_source,
    artifact_id,
    failure_code,
    started_at,
    completed_at,
    updated_at
  ) = (
    SELECT
      source.status,
      source.revision,
      source.attempt_count,
      source.cancellation_requested,
      source.lease_owner,
      source.lease_expires_at,
      source.settled_cost_micros,
      source.cost_source,
      source.artifact_id,
      source.failure_code,
      source.started_at,
      source.completed_at,
      source.updated_at
    FROM restore_source.fine_tuning_jobs AS source
    WHERE source.id = target.id
  )`;

const FINE_TUNING_ARTIFACT_PLACEHOLDER_INSERT = `
  INSERT INTO main.fine_tuning_model_artifacts (
    id,
    project_id,
    dataset_id,
    job_id,
    base_model_provider_id,
    base_model_id,
    base_model_revision,
    artifact_digest,
    local_artifact_ref,
    state,
    revision,
    latest_evaluation_id,
    registration_name,
    provider_receipt_digest,
    created_at,
    updated_at
  )
  SELECT
    id,
    project_id,
    dataset_id,
    job_id,
    base_model_provider_id,
    base_model_id,
    base_model_revision,
    artifact_digest,
    local_artifact_ref,
    'candidate',
    revision,
    NULL,
    registration_name,
    provider_receipt_digest,
    created_at,
    updated_at
  FROM restore_source.fine_tuning_model_artifacts`;

const FINE_TUNING_ARTIFACT_FINALIZE = `
  UPDATE main.fine_tuning_model_artifacts AS target
  SET (
    state,
    revision,
    latest_evaluation_id,
    registration_name,
    provider_receipt_digest,
    updated_at
  ) = (
    SELECT
      source.state,
      source.revision,
      source.latest_evaluation_id,
      source.registration_name,
      source.provider_receipt_digest,
      source.updated_at
    FROM restore_source.fine_tuning_model_artifacts AS source
    WHERE source.id = target.id
  )`;

const FINE_TUNING_DEPLOYMENT_ARTIFACT_STAGE = `
  UPDATE main.fine_tuning_model_artifacts
  SET
    state = 'deployment_approved',
    revision = (
      SELECT approval.entity_revision + 1
      FROM restore_source.fine_tuning_deployments AS deployment
      INNER JOIN restore_source.fine_tuning_approvals AS approval
        ON approval.id = deployment.approval_id
      WHERE deployment.id = ?
    )
  WHERE id = (
    SELECT artifact_id
    FROM restore_source.fine_tuning_deployments
    WHERE id = ?
  )`;

const FINE_TUNING_DEPLOYMENT_INSERT = `
  INSERT INTO main.fine_tuning_deployments
  SELECT *
  FROM restore_source.fine_tuning_deployments
  WHERE id = ?`;

export class DatabaseMaintenanceService {
  public constructor(private readonly executor: SqlExecutor) {}

  public async inspect(): Promise<Result<DatabaseIntegrityReport, AppError>> {
    try {
      const [integrityRows, foreignKeyRows] = await Promise.all([
        this.executor.select<IntegrityRow>("PRAGMA integrity_check(100)"),
        this.executor.select<ForeignKeyRow>("PRAGMA foreign_key_check"),
      ]);
      const integrityMessages = integrityRows.map((row) => row.integrity_check);
      const foreignKeyViolations = foreignKeyRows.map((row): ForeignKeyViolation => ({
        table: row.table,
        rowId: row.rowid,
        parent: row.parent,
        foreignKeyIndex: row.fkid,
      }));

      return ok({
        healthy:
          integrityMessages.length === 1 &&
          integrityMessages[0] === "ok" &&
          foreignKeyViolations.length === 0,
        integrityMessages,
        foreignKeyViolations,
      });
    } catch {
      return err(maintenanceError("DATABASE_INTEGRITY_CHECK_FAILED"));
    }
  }

  public async createConsistentBackup(
    destinationPath: string,
  ): Promise<Result<DatabaseBackupReceipt, AppError>> {
    if (
      destinationPath.trim().length === 0 ||
      destinationPath.length > 32_767 ||
      destinationPath.includes("\u0000")
    ) {
      return err(
        new AppError({
          code: "VALIDATION_FAILED",
          message: "The selected backup destination is invalid.",
        }),
      );
    }

    const integrity = await this.inspect();
    if (!integrity.ok) {
      return integrity;
    }
    if (!integrity.value.healthy) {
      return err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "The local database is not healthy enough to create a trusted backup.",
          actions: ["EXPORT_DRAFT", "CONTACT_SUPPORT"],
          details: {
            integrityMessageCount: integrity.value.integrityMessages.length,
            foreignKeyViolationCount: integrity.value.foreignKeyViolations.length,
          },
        }),
      );
    }

    let attached = false;
    let operationError: AppError | undefined;
    try {
      // Binding the path keeps user-selected file names outside SQL syntax.
      // VACUUM INTO creates a transactionally consistent standalone database
      // and fails rather than overwriting an existing non-empty file.
      await this.executor.execute("VACUUM INTO ?", [destinationPath]);
      await this.executor.execute("ATTACH DATABASE ? AS restore_source", [destinationPath]);
      attached = true;

      const [databases, integrityRows, foreignKeyRows, mainSchema, backupSchema] =
        await Promise.all([
          this.executor.select<DatabaseListRow>("PRAGMA database_list"),
          this.executor.select<IntegrityRow>("PRAGMA restore_source.integrity_check(100)"),
          this.executor.select<ForeignKeyRow>("PRAGMA restore_source.foreign_key_check"),
          this.executor.select<SchemaContractRow>(
            `SELECT type, name, tbl_name AS tableName, sql
             FROM main.sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name`,
          ),
          this.executor.select<SchemaContractRow>(
            `SELECT type, name, tbl_name AS tableName, sql
             FROM restore_source.sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name`,
          ),
        ]);
      const main = databases.find(({ name }) => name === "main");
      const backup = databases.find(({ name }) => name === "restore_source");
      if (
        main === undefined ||
        backup === undefined ||
        normalizeDatabasePath(main.file) === normalizeDatabasePath(backup.file) ||
        integrityRows.length !== 1 ||
        integrityRows[0]?.integrity_check !== "ok" ||
        foreignKeyRows.length > 0 ||
        !schemaContractsMatch(mainSchema, backupSchema)
      ) {
        operationError = maintenanceError("DATABASE_BACKUP_VERIFICATION_FAILED");
      }
    } catch {
      operationError = maintenanceError("DATABASE_BACKUP_FAILED");
    }

    if (attached) {
      try {
        await this.executor.execute("DETACH DATABASE restore_source");
      } catch {
        return err(maintenanceError("DATABASE_BACKUP_DETACH_FAILED"));
      }
    }
    if (operationError !== undefined) {
      return err(operationError);
    }
    return ok({
      destinationKind: "user_selected_file",
      integrityVerified: true,
    });
  }

  public async restoreConsistentBackup(
    sourcePath: string,
  ): Promise<Result<DatabaseRestoreReceipt, AppError>> {
    const pathValidation = validateDatabasePath(sourcePath);
    if (!pathValidation.ok) {
      return pathValidation;
    }

    let attached = false;
    let outcome: Result<DatabaseRestoreReceipt, AppError>;
    try {
      await this.executor.execute("ATTACH DATABASE ? AS restore_source", [sourcePath]);
      attached = true;

      const databases = await this.executor.select<DatabaseListRow>("PRAGMA database_list");
      const main = databases.find(({ name }) => name === "main");
      const source = databases.find(({ name }) => name === "restore_source");
      if (
        main === undefined ||
        source === undefined ||
        normalizeDatabasePath(main.file) === normalizeDatabasePath(source.file)
      ) {
        throw restoreError("DATABASE_RESTORE_SOURCE_INVALID");
      }

      const [integrityRows, foreignKeyRows, tableRows] = await Promise.all([
        this.executor.select<IntegrityRow>("PRAGMA restore_source.integrity_check(100)"),
        this.executor.select<ForeignKeyRow>("PRAGMA restore_source.foreign_key_check"),
        this.executor.select<TableNameRow>(
          `SELECT name
           FROM restore_source.sqlite_schema
           WHERE type = 'table' AND name IN (${RESTORABLE_TABLES.map(() => "?").join(", ")})`,
          RESTORABLE_TABLES,
        ),
      ]);
      const sourceTables = new Set(tableRows.map(({ name }) => name));
      if (
        integrityRows.length !== 1 ||
        integrityRows[0]?.integrity_check !== "ok" ||
        foreignKeyRows.length > 0 ||
        RESTORABLE_TABLES.some((table) => !sourceTables.has(table))
      ) {
        throw restoreError("DATABASE_RESTORE_BACKUP_INCOMPATIBLE");
      }

      await this.executor.transaction(async (transaction) => {
        // Fine-tuning jobs and artifacts form a valid, intentional cycle once
        // a job has produced an artifact. Deferral remains transaction-local;
        // both the explicit check below and COMMIT still enforce every FK.
        await transaction.execute("PRAGMA defer_foreign_keys = ON");
        for (const table of DERIVED_TABLES_TO_CLEAR) {
          await transaction.execute(`DELETE FROM main.${table}`);
        }
        for (const table of RESTORE_DELETE_ORDER) {
          await transaction.execute(`DELETE FROM main.${table}`);
        }
        for (const table of RESTORE_INSERT_ORDER) {
          if (table === "fine_tuning_jobs") {
            // A completed source job points at its artifact, while the artifact
            // insertion authority requires that job to be running. Restore a
            // content-free transient state, insert the artifact, then put the
            // backed-up mutable job state back exactly.
            const jobs = await transaction.select<FineTuningJobRestoreRow>(
              `SELECT
                 job.id,
                 job.dataset_id AS datasetId,
                 job.dataset_revision AS datasetRevision,
                 approval.actor_id AS approvedBy,
                 approval.created_at AS approvedAt
               FROM restore_source.fine_tuning_jobs AS job
               INNER JOIN restore_source.fine_tuning_approvals AS approval
                 ON approval.id = job.dataset_approval_id
               ORDER BY job.created_at, job.id`,
            );
            for (const job of jobs) {
              // A dataset may have been archived after its jobs completed.
              // Recreate the exact authority state each job originally saw,
              // then return the dataset to its backed-up current state.
              await transaction.execute(FINE_TUNING_DATASET_STAGE_FOR_JOB, [
                job.datasetRevision,
                job.approvedBy,
                job.approvedAt,
                job.datasetId,
              ]);
              await transaction.execute(FINE_TUNING_JOB_PLACEHOLDER_INSERT, [job.id]);
            }
            await transaction.execute(FINE_TUNING_DATASET_FINALIZE);
          } else if (table === "fine_tuning_model_artifacts") {
            // Evaluation authority accepts candidate artifacts, while later
            // deployment authority requires the backed-up post-evaluation
            // state. Restore that mutable state after evaluations are present.
            await transaction.execute(FINE_TUNING_ARTIFACT_PLACEHOLDER_INSERT);
          } else if (table === "fine_tuning_deployments") {
            const deployments = await transaction.select<FineTuningDeploymentRestoreRow>(
              `SELECT id
               FROM restore_source.fine_tuning_deployments
               ORDER BY activated_at, id`,
            );
            for (const deployment of deployments) {
              // Deployment history can contain several approval revisions for
              // one artifact. Replay each row against its own approved
              // authority state, then restore the artifact's latest state.
              await transaction.execute(FINE_TUNING_DEPLOYMENT_ARTIFACT_STAGE, [
                deployment.id,
                deployment.id,
              ]);
              await transaction.execute(FINE_TUNING_DEPLOYMENT_INSERT, [deployment.id]);
            }
            await transaction.execute(FINE_TUNING_ARTIFACT_FINALIZE);
          } else {
            await transaction.execute(
              `INSERT INTO main.${table} SELECT * FROM restore_source.${table}`,
            );
          }
          if (table === "fine_tuning_model_artifacts") {
            await transaction.execute(FINE_TUNING_JOB_FINALIZE);
          }
        }
        const restoredForeignKeys = await transaction.select<ForeignKeyRow>(
          "PRAGMA foreign_key_check",
        );
        if (restoredForeignKeys.length > 0) {
          throw restoreError("DATABASE_RESTORE_FOREIGN_KEY_FAILED");
        }
      });

      outcome = ok({
        sourceKind: "user_selected_file",
        integrityVerified: true,
        restoredTableCount: RESTORABLE_TABLES.length,
      });
    } catch (cause: unknown) {
      outcome = err(cause instanceof AppError ? cause : restoreError("DATABASE_RESTORE_FAILED"));
    }
    if (attached) {
      try {
        await this.executor.execute("DETACH DATABASE restore_source");
      } catch {
        return err(restoreError("DATABASE_RESTORE_DETACH_FAILED"));
      }
    }
    return outcome;
  }
}

function validateDatabasePath(path: string): Result<true, AppError> {
  if (path.trim().length === 0 || path.length > 32_767 || path.includes("\u0000")) {
    return err(
      new AppError({
        code: "VALIDATION_FAILED",
        message: "The selected backup source is invalid.",
      }),
    );
  }
  return ok(true);
}

function normalizeDatabasePath(path: string): string {
  return path.replaceAll("\\", "/").toLocaleLowerCase();
}

function schemaContractsMatch(
  mainSchema: readonly SchemaContractRow[],
  backupSchema: readonly SchemaContractRow[],
): boolean {
  return (
    mainSchema.length === backupSchema.length &&
    mainSchema.every((mainEntry, index) => {
      const backupEntry = backupSchema[index];
      return (
        mainEntry.type === backupEntry?.type &&
        mainEntry.name === backupEntry.name &&
        mainEntry.tableName === backupEntry.tableName &&
        mainEntry.sql === backupEntry.sql
      );
    })
  );
}

function restoreError(operation: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The selected backup could not be restored safely.",
    retryable: operation === "DATABASE_RESTORE_FAILED",
    actions: ["RETRY", "CONTACT_SUPPORT"],
    details: { operation },
  });
}

function maintenanceError(operation: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The local database maintenance operation could not complete.",
    retryable: true,
    actions: ["RETRY", "EXPORT_DRAFT"],
    details: { operation },
  });
}
