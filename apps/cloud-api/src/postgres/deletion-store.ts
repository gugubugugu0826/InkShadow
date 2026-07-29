import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  CloudDeletionBlockedReason,
  CloudDeletionPhase,
  CloudDeletionState,
  CloudDeletionTargetKind,
} from "@inkshadow/contracts";

import type {
  CloudDeletionImpactRecord,
  CloudDeletionJobProjectRecord,
  CloudDeletionJobRecord,
  CloudDeletionMarkerRecord,
  CloudRetentionHoldRecord,
} from "../domain/deletion-records.js";
import type { CloudProjectRecord } from "../domain/project-records.js";
import type {
  CloudAccountRecord,
  CloudAccountState,
  CloudAuditEventRecord,
  CloudIdempotencyRecord,
  IdempotencyResultKind,
} from "../domain/records.js";
import type {
  CloudDeletionCancellationResult,
  CloudDeletionStore,
  CloudDeletionTransaction,
} from "../repository/deletion-store.js";

export interface DeletionJobRow extends QueryResultRow {
  readonly attempt_count: number;
  readonly backup_retained_until: Date | null;
  readonly backup_retention_seconds: string;
  readonly blocked_reason: CloudDeletionBlockedReason | null;
  readonly cancellable_until: Date;
  readonly commit_started_at: Date | null;
  readonly completed_at: Date | null;
  readonly confirmation_id: string;
  readonly created_at: Date;
  readonly deletion_request_id: string;
  readonly impact_device_count: string;
  readonly impact_encrypted_chunk_count: string;
  readonly impact_key_envelope_count: string;
  readonly impact_project_count: string;
  readonly impact_session_count: string;
  readonly impact_sync_operation_count: string;
  readonly last_failure_code: string | null;
  readonly lease_expires_at: Date | null;
  readonly lease_owner: string | null;
  readonly live_data_purged_at: Date | null;
  readonly next_attempt_at: Date;
  readonly phase: CloudDeletionPhase;
  readonly requested_at: Date;
  readonly requested_by_account_id: string;
  readonly revision: string;
  readonly scheduled_for: Date;
  readonly state: CloudDeletionState;
  readonly target_id: string;
  readonly target_kind: CloudDeletionTargetKind;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface DeletionJobProjectRow extends QueryResultRow {
  readonly completed_at: Date | null;
  readonly deletion_request_id: string;
  readonly ordinal: number;
  readonly original_deletion_scheduled_for: Date | null;
  readonly original_state: CloudDeletionJobProjectRecord["originalState"];
  readonly phase: CloudDeletionJobProjectRecord["phase"];
  readonly project_id: string;
  readonly project_revision_at_freeze: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface AccountRow extends QueryResultRow {
  readonly account_id: string;
  readonly created_at: Date;
  readonly deletion_scheduled_for: Date | null;
  readonly email_canonical: string;
  readonly failed_login_count: number;
  readonly last_failed_login_at: Date | null;
  readonly locked_until: Date | null;
  readonly password_hash: string;
  readonly revision: string;
  readonly state: CloudAccountState;
  readonly updated_at: Date;
  readonly verified_at: Date | null;
}

interface ProjectRow extends QueryResultRow {
  readonly created_at: Date;
  readonly current_key_version: number | null;
  readonly deletion_scheduled_for: Date | null;
  readonly minimum_available_remote_sequence: string;
  readonly owner_account_id: string;
  readonly project_id: string;
  readonly revision: string;
  readonly state: CloudProjectRecord["state"];
  readonly sync_compaction_epoch: string;
  readonly tenant_id: string;
  readonly updated_at: Date;
}

interface IdempotencyRow extends QueryResultRow {
  readonly actor_account_id: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly idempotency_key_hash_sha256: string;
  readonly operation_id: CloudIdempotencyRecord["operationId"];
  readonly request_hash_sha256: string;
  readonly response_snapshot: unknown;
  readonly response_status: number;
  readonly result_digest_sha256: string;
  readonly result_kind: IdempotencyResultKind;
  readonly result_resource_id: string | null;
  readonly scope_hash_sha256: string;
}

interface ImpactRow extends QueryResultRow {
  readonly device_count: string;
  readonly encrypted_chunk_count: string;
  readonly key_envelope_count: string;
  readonly project_count: string;
  readonly session_count: string;
  readonly sync_operation_count: string;
}

export class PostgresCloudDeletionStore implements CloudDeletionStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    operation: (transaction: CloudDeletionTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudDeletionTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresCloudDeletionTransaction implements CloudDeletionTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async setTenant(tenantId: string): Promise<void> {
    await this.client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [tenantId]);
  }

  public async lockIdempotency(scopeHashSha256: string): Promise<void> {
    const signedLockId = BigInt.asIntN(64, BigInt(`0x${scopeHashSha256.slice(0, 16)}`));
    await this.client.query("SELECT pg_advisory_xact_lock($1::bigint)", [signedLockId.toString()]);
  }

  public async findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null> {
    const result = await this.client.query<IdempotencyRow>(
      `SELECT *
       FROM cloud_idempotency_records
       WHERE scope_hash_sha256 = $1`,
      [scopeHashSha256],
    );
    return mapNullable(result.rows[0], mapIdempotency);
  }

  public async insertIdempotency(record: CloudIdempotencyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_idempotency_records (
         scope_hash_sha256,
         actor_account_id,
         operation_id,
         idempotency_key_hash_sha256,
         request_hash_sha256,
         response_snapshot,
         result_kind,
         result_resource_id,
         result_digest_sha256,
         response_status,
         created_at,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)`,
      [
        record.scopeHashSha256,
        record.actorAccountId,
        record.operationId,
        record.idempotencyKeyHashSha256,
        record.requestHashSha256,
        record.responseSnapshot === null ? null : JSON.stringify(record.responseSnapshot),
        record.resultKind,
        record.resultResourceId,
        record.resultDigestSha256,
        record.responseStatus,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  public async findAccountById(
    accountId: string,
    forUpdate = false,
  ): Promise<CloudAccountRecord | null> {
    const result = await this.client.query<AccountRow>(
      `SELECT *
       FROM cloud_accounts
       WHERE account_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [accountId],
    );
    return mapNullable(result.rows[0], mapAccount);
  }

  public async findAccountByEmail(
    emailCanonical: string,
    forUpdate = false,
  ): Promise<CloudAccountRecord | null> {
    const result = await this.client.query<AccountRow>(
      `SELECT *
       FROM cloud_accounts
       WHERE email_canonical = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [emailCanonical],
    );
    return mapNullable(result.rows[0], mapAccount);
  }

  public async accountRequiresOwnershipTransfer(accountId: string): Promise<boolean> {
    const result = await this.client.query<{ transfer_required: boolean }>(
      `SELECT inkshadow_account_requires_ownership_transfer($1) AS transfer_required`,
      [accountId],
    );
    const transferRequired = result.rows[0]?.transfer_required;
    if (typeof transferRequired !== "boolean") {
      throw new Error("The team-ownership deletion preflight returned an invalid result.");
    }
    return transferRequired;
  }

  public async findProject(
    tenantId: string,
    projectId: string,
    forUpdate = false,
  ): Promise<CloudProjectRecord | null> {
    const result = await this.client.query<ProjectRow>(
      `SELECT *
       FROM cloud_projects
       WHERE tenant_id = $1
         AND project_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, projectId],
    );
    return mapNullable(result.rows[0], mapProject);
  }

  public async listOwnedProjects(
    tenantId: string,
    ownerAccountId: string,
    afterProjectId: string | null,
    limit: number,
    forUpdate = false,
  ): Promise<readonly CloudProjectRecord[]> {
    assertBoundedLimit(limit);
    const result = await this.client.query<ProjectRow>(
      `SELECT *
       FROM cloud_projects
       WHERE tenant_id = $1
         AND owner_account_id = $2
         AND state <> 'deleted'
         AND ($3::uuid IS NULL OR project_id > $3::uuid)
       ORDER BY project_id
       LIMIT $4${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, ownerAccountId, afterProjectId, limit],
    );
    return result.rows.map(mapProject);
  }

  public async listActiveProjectDeletionJobsForOwner(
    tenantId: string,
    ownerAccountId: string,
    afterProjectId: string | null,
    limit: number,
    forUpdate = false,
  ): Promise<readonly CloudDeletionJobRecord[]> {
    assertBoundedLimit(limit);
    const result = await this.client.query<DeletionJobRow>(
      `SELECT job.*
       FROM cloud_deletion_jobs AS job
       JOIN cloud_projects AS project
         ON project.tenant_id = job.tenant_id
        AND project.project_id = job.target_id
       WHERE job.tenant_id = $1
         AND job.target_kind = 'project'
         AND job.state NOT IN ('purged', 'cancelled')
         AND project.owner_account_id = $2
         AND project.state <> 'deleted'
         AND ($3::uuid IS NULL OR project.project_id > $3::uuid)
       ORDER BY project.project_id
       LIMIT $4${forUpdate ? " FOR UPDATE OF job" : ""}`,
      [tenantId, ownerAccountId, afterProjectId, limit],
    );
    return result.rows.map(mapDeletionJob);
  }

  public async findDeletionJob(
    tenantId: string,
    deletionRequestId: string,
    forUpdate = false,
  ): Promise<CloudDeletionJobRecord | null> {
    const result = await this.client.query<DeletionJobRow>(
      `SELECT *
       FROM cloud_deletion_jobs
       WHERE tenant_id = $1
         AND deletion_request_id = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, deletionRequestId],
    );
    return mapNullable(result.rows[0], mapDeletionJob);
  }

  public async findDeletionJobByConfirmation(
    tenantId: string,
    targetKind: CloudDeletionTargetKind,
    targetId: string,
    confirmationId: string,
    forUpdate = false,
  ): Promise<CloudDeletionJobRecord | null> {
    const result = await this.client.query<DeletionJobRow>(
      `SELECT *
       FROM cloud_deletion_jobs
       WHERE tenant_id = $1
         AND target_kind = $2
         AND target_id = $3
         AND confirmation_id = $4${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, targetKind, targetId, confirmationId],
    );
    return mapNullable(result.rows[0], mapDeletionJob);
  }

  public async findActiveDeletionJob(
    tenantId: string,
    targetKind: CloudDeletionTargetKind,
    targetId: string,
    forUpdate = false,
  ): Promise<CloudDeletionJobRecord | null> {
    const result = await this.client.query<DeletionJobRow>(
      `SELECT *
       FROM cloud_deletion_jobs
       WHERE tenant_id = $1
         AND target_kind = $2
         AND target_id = $3
         AND state NOT IN ('purged', 'cancelled')
       ORDER BY requested_at DESC, deletion_request_id DESC
       LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, targetKind, targetId],
    );
    return mapNullable(result.rows[0], mapDeletionJob);
  }

  public async findLatestDeletionJobForTarget(
    tenantId: string,
    targetKind: CloudDeletionTargetKind,
    targetId: string,
    forUpdate = false,
  ): Promise<CloudDeletionJobRecord | null> {
    const result = await this.client.query<DeletionJobRow>(
      `SELECT *
       FROM cloud_deletion_jobs
       WHERE tenant_id = $1
         AND target_kind = $2
         AND target_id = $3
       ORDER BY requested_at DESC, deletion_request_id DESC
       LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, targetKind, targetId],
    );
    return mapNullable(result.rows[0], mapDeletionJob);
  }

  public async insertDeletionJob(record: CloudDeletionJobRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_deletion_jobs (
         tenant_id,
         deletion_request_id,
         target_kind,
         target_id,
         requested_by_account_id,
         confirmation_id,
         state,
         phase,
         revision,
         requested_at,
         scheduled_for,
         cancellable_until,
         commit_started_at,
         live_data_purged_at,
         backup_retained_until,
         completed_at,
         blocked_reason,
         impact_project_count,
         impact_sync_operation_count,
         impact_encrypted_chunk_count,
         impact_key_envelope_count,
         impact_device_count,
         impact_session_count,
         backup_retention_seconds,
         attempt_count,
         next_attempt_at,
         last_failure_code,
         lease_owner,
         lease_expires_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10,
         $11, $12, $13, $14, $15, $16, $17, $18::bigint,
         $19::bigint, $20::bigint, $21::bigint, $22::bigint,
         $23::bigint, $24::bigint, $25, $26, $27, $28, $29, $30, $31
       )`,
      deletionJobParameters(record),
    );
  }

  public async updateDeletionJob(
    record: CloudDeletionJobRecord,
    expectedRevision: number,
  ): Promise<boolean> {
    requirePositiveSafeInteger(expectedRevision, "expected deletion revision");
    const parameters = deletionJobParameters(record);
    const result = await this.client.query(
      `UPDATE cloud_deletion_jobs
       SET target_kind = $3,
           target_id = $4,
           requested_by_account_id = $5,
           confirmation_id = $6,
           state = $7,
           phase = $8,
           revision = $9::bigint,
           requested_at = $10,
           scheduled_for = $11,
           cancellable_until = $12,
           commit_started_at = $13,
           live_data_purged_at = $14,
           backup_retained_until = $15,
           completed_at = $16,
           blocked_reason = $17,
           impact_project_count = $18::bigint,
           impact_sync_operation_count = $19::bigint,
           impact_encrypted_chunk_count = $20::bigint,
           impact_key_envelope_count = $21::bigint,
           impact_device_count = $22::bigint,
           impact_session_count = $23::bigint,
           backup_retention_seconds = $24::bigint,
           attempt_count = $25,
           next_attempt_at = $26,
           last_failure_code = $27,
           lease_owner = $28,
           lease_expires_at = $29,
           updated_at = $31
       WHERE tenant_id = $1
         AND deletion_request_id = $2
         AND revision = $32::bigint`,
      [...parameters, expectedRevision],
    );
    return result.rowCount === 1;
  }

  public async cancelDeletionJob(
    tenantId: string,
    deletionRequestId: string,
    expectedRevision: number,
    cancelledAt: Date,
  ): Promise<CloudDeletionCancellationResult> {
    requirePositiveSafeInteger(expectedRevision, "expected deletion revision");
    const selected = await this.client.query<DeletionJobRow>(
      `SELECT *
       FROM cloud_deletion_jobs
       WHERE tenant_id = $1
         AND deletion_request_id = $2
       FOR UPDATE`,
      [tenantId, deletionRequestId],
    );
    const row = selected.rows[0];
    if (row === undefined) {
      return { kind: "not_found" };
    }
    const job = mapDeletionJob(row);
    if (job.revision !== expectedRevision) {
      return { kind: "revision_mismatch" };
    }
    if (
      (job.state !== "grace_period" && job.state !== "blocked") ||
      job.commitStartedAt !== null ||
      cancelledAt > job.cancellableUntil
    ) {
      return { kind: "not_cancellable" };
    }

    if (job.targetKind === "project") {
      const restored = await this.restoreProject(
        tenantId,
        job.targetId,
        job.scheduledFor,
        "active",
        null,
        cancelledAt,
      );
      if (!restored) {
        throw new Error("Cloud project deletion freeze could not be restored.");
      }
    } else {
      const frozenCount = await this.client.query<{ project_count: string }>(
        `SELECT COUNT(*)::text AS project_count
         FROM cloud_deletion_job_projects
         WHERE tenant_id = $1
           AND deletion_request_id = $2`,
        [tenantId, deletionRequestId],
      );
      const restored = await this.client.query(
        `UPDATE cloud_projects AS project
         SET state = frozen.original_state,
             revision = project.revision + 1,
             deletion_scheduled_for = frozen.original_deletion_scheduled_for,
             updated_at = $4
         FROM cloud_deletion_job_projects AS frozen
         WHERE frozen.tenant_id = $1
           AND frozen.deletion_request_id = $2
           AND project.tenant_id = frozen.tenant_id
           AND project.project_id = frozen.project_id
           AND project.state = 'deletion_scheduled'
           AND project.deletion_scheduled_for = $3`,
        [tenantId, deletionRequestId, job.scheduledFor, cancelledAt],
      );
      const expectedProjectCount = requireNonnegativeSafeInteger(
        frozenCount.rows[0]?.project_count ?? "",
        "frozen deletion project count",
      );
      if (restored.rowCount !== expectedProjectCount) {
        throw new Error("Account deletion project freezes could not all be restored.");
      }
      const accountRestored = await this.restoreAccount(
        job.targetId,
        job.scheduledFor,
        cancelledAt,
      );
      if (!accountRestored) {
        throw new Error("Cloud account deletion freeze could not be restored.");
      }
    }

    const cancelled = await this.client.query<DeletionJobRow>(
      `UPDATE cloud_deletion_jobs
       SET state = 'cancelled',
           phase = 'freeze',
           revision = revision + 1,
           completed_at = $3,
           blocked_reason = NULL,
           next_attempt_at = $3,
           last_failure_code = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = $3
       WHERE tenant_id = $1
         AND deletion_request_id = $2
         AND revision = $4::bigint
         AND state IN ('grace_period', 'blocked')
         AND commit_started_at IS NULL
       RETURNING *`,
      [tenantId, deletionRequestId, cancelledAt, expectedRevision],
    );
    return {
      job: mapDeletionJob(requireRow(cancelled.rows[0], "cancelled deletion job")),
      kind: "cancelled",
    };
  }

  public async insertDeletionJobProject(record: CloudDeletionJobProjectRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_deletion_job_projects (
         tenant_id,
         deletion_request_id,
         project_id,
         ordinal,
         original_state,
         original_deletion_scheduled_for,
         project_revision_at_freeze,
         phase,
         completed_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9, $10)`,
      [
        record.tenantId,
        record.deletionRequestId,
        record.projectId,
        record.ordinal,
        record.originalState,
        record.originalDeletionScheduledFor,
        record.projectRevisionAtFreeze,
        record.phase,
        record.completedAt,
        record.updatedAt,
      ],
    );
  }

  public async listDeletionJobProjects(
    tenantId: string,
    deletionRequestId: string,
    afterOrdinal: number | null,
    limit: number,
    forUpdate = false,
  ): Promise<readonly CloudDeletionJobProjectRecord[]> {
    assertBoundedLimit(limit);
    if (afterOrdinal !== null && (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0)) {
      throw new Error("Deletion project cursor must be a non-negative safe integer.");
    }
    const result = await this.client.query<DeletionJobProjectRow>(
      `SELECT *
       FROM cloud_deletion_job_projects
       WHERE tenant_id = $1
         AND deletion_request_id = $2
         AND ($3::integer IS NULL OR ordinal > $3)
       ORDER BY ordinal
       LIMIT $4${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, deletionRequestId, afterOrdinal, limit],
    );
    return result.rows.map(mapDeletionJobProject);
  }

  public async calculateProjectImpact(
    tenantId: string,
    projectId: string,
  ): Promise<CloudDeletionImpactRecord> {
    const result = await this.client.query<ImpactRow>(
      `SELECT
         1::bigint AS project_count,
         (
           SELECT COUNT(*)
           FROM sync_operations
           WHERE tenant_id = $1 AND project_id = $2
         ) AS sync_operation_count,
         (
           SELECT COUNT(*)
           FROM sync_ciphertext_chunks
           WHERE tenant_id = $1 AND project_id = $2
         ) + inkshadow_count_review_ciphertexts($1, $2)
           AS encrypted_chunk_count,
         (
           SELECT COUNT(*)
           FROM device_project_key_envelopes
           WHERE tenant_id = $1 AND project_id = $2
         ) + inkshadow_count_team_project_key_envelopes($1, $2)
           AS key_envelope_count,
         0::bigint AS device_count,
         0::bigint AS session_count`,
      [tenantId, projectId],
    );
    return mapImpact(requireRow(result.rows[0], "project deletion impact"));
  }

  public async calculateAccountImpact(
    tenantId: string,
    accountId: string,
  ): Promise<CloudDeletionImpactRecord> {
    const result = await this.client.query<ImpactRow>(
      `SELECT
         (
           SELECT COUNT(*)
           FROM cloud_projects
           WHERE tenant_id = $1
             AND owner_account_id = $2
             AND state <> 'deleted'
         ) AS project_count,
         (
           SELECT COUNT(*)
           FROM sync_operations AS operation
           JOIN cloud_projects AS project
             ON project.tenant_id = operation.tenant_id
            AND project.project_id = operation.project_id
           WHERE operation.tenant_id = $1
             AND project.owner_account_id = $2
             AND project.state <> 'deleted'
         ) AS sync_operation_count,
         (
           SELECT COUNT(*)
           FROM sync_ciphertext_chunks AS chunk
           JOIN cloud_projects AS project
             ON project.tenant_id = chunk.tenant_id
            AND project.project_id = chunk.project_id
           WHERE chunk.tenant_id = $1
             AND project.owner_account_id = $2
             AND project.state <> 'deleted'
         ) + COALESCE(
           (
             SELECT SUM(
               inkshadow_count_review_ciphertexts(
                 project.tenant_id,
                 project.project_id
               )
             )
             FROM cloud_projects AS project
             WHERE project.tenant_id = $1
               AND project.owner_account_id = $2
               AND project.state <> 'deleted'
           ),
           0
         ) AS encrypted_chunk_count,
         (
           SELECT COUNT(*)
           FROM device_project_key_envelopes AS envelope
           JOIN cloud_projects AS project
             ON project.tenant_id = envelope.tenant_id
            AND project.project_id = envelope.project_id
           WHERE envelope.tenant_id = $1
             AND project.owner_account_id = $2
             AND project.state <> 'deleted'
         ) + COALESCE(
           (
             SELECT SUM(
               inkshadow_count_team_project_key_envelopes(
                 project.tenant_id,
                 project.project_id
               )
             )
             FROM cloud_projects AS project
             WHERE project.tenant_id = $1
               AND project.owner_account_id = $2
               AND project.state <> 'deleted'
           ),
           0
         ) AS key_envelope_count,
         (
           SELECT COUNT(*)
           FROM registered_devices
           WHERE account_id = $2
         ) AS device_count,
         (
           SELECT COUNT(*)
           FROM cloud_sessions
           WHERE account_id = $2
         ) AS session_count`,
      [tenantId, accountId],
    );
    return mapImpact(requireRow(result.rows[0], "account deletion impact"));
  }

  public async freezeProject(
    tenantId: string,
    projectId: string,
    expectedRevision: number,
    scheduledFor: Date,
    updatedAt: Date,
  ): Promise<boolean> {
    requirePositiveSafeInteger(expectedRevision, "expected project revision");
    const result = await this.client.query(
      `UPDATE cloud_projects
       SET state = 'deletion_scheduled',
           revision = revision + 1,
           deletion_scheduled_for = $4,
           updated_at = $5
       WHERE tenant_id = $1
         AND project_id = $2
         AND revision = $3::bigint
         AND state = 'active'`,
      [tenantId, projectId, expectedRevision, scheduledFor, updatedAt],
    );
    return result.rowCount === 1;
  }

  public async restoreProject(
    tenantId: string,
    projectId: string,
    deletionScheduledFor: Date,
    originalState: CloudDeletionJobProjectRecord["originalState"],
    originalDeletionScheduledFor: Date | null,
    updatedAt: Date,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_projects
       SET state = $4,
           revision = revision + 1,
           deletion_scheduled_for = $5,
           updated_at = $6
       WHERE tenant_id = $1
         AND project_id = $2
         AND state = 'deletion_scheduled'
         AND deletion_scheduled_for = $3`,
      [
        tenantId,
        projectId,
        deletionScheduledFor,
        originalState,
        originalDeletionScheduledFor,
        updatedAt,
      ],
    );
    return result.rowCount === 1;
  }

  public async freezeAccount(
    accountId: string,
    expectedRevision: number,
    scheduledFor: Date,
    updatedAt: Date,
  ): Promise<boolean> {
    requirePositiveSafeInteger(expectedRevision, "expected account revision");
    const result = await this.client.query(
      `UPDATE cloud_accounts
       SET state = 'deletion_scheduled',
           revision = revision + 1,
           deletion_scheduled_for = $3,
           updated_at = $4
       WHERE account_id = $1
         AND revision = $2::bigint
         AND state = 'active'`,
      [accountId, expectedRevision, scheduledFor, updatedAt],
    );
    return result.rowCount === 1;
  }

  public async restoreAccount(
    accountId: string,
    deletionScheduledFor: Date,
    updatedAt: Date,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_accounts
       SET state = 'active',
           revision = revision + 1,
           deletion_scheduled_for = NULL,
           updated_at = $3
       WHERE account_id = $1
         AND state = 'deletion_scheduled'
         AND deletion_scheduled_for = $2`,
      [accountId, deletionScheduledFor, updatedAt],
    );
    return result.rowCount === 1;
  }

  public async revokeSessionsForAccount(accountId: string, revokedAt: Date): Promise<number> {
    const result = await this.client.query(
      `UPDATE cloud_sessions
       SET revoked_at = $2
       WHERE account_id = $1
         AND revoked_at IS NULL`,
      [accountId, revokedAt],
    );
    return requireRowCount(result.rowCount, "revoked account sessions");
  }

  public async findActiveRetentionHoldReason(
    tenantId: string,
    targetKind: CloudDeletionTargetKind,
    targetId: string,
  ): Promise<CloudDeletionBlockedReason | null> {
    const result = await this.client.query<{ reason: CloudDeletionBlockedReason }>(
      `SELECT reason
       FROM cloud_retention_holds
       WHERE tenant_id = $1
         AND target_kind = $2
         AND target_id = $3
         AND released_at IS NULL
       ORDER BY
         CASE reason
           WHEN 'legal_hold_active' THEN 1
           WHEN 'ownership_transfer_required' THEN 2
           WHEN 'external_purge_pending' THEN 3
         END,
         placed_at,
         hold_id
       LIMIT 1`,
      [tenantId, targetKind, targetId],
    );
    return result.rows[0]?.reason ?? null;
  }

  public async insertRetentionHold(record: CloudRetentionHoldRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_retention_holds (
         tenant_id,
         hold_id,
         target_kind,
         target_id,
         reason,
         placed_at,
         released_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.tenantId,
        record.holdId,
        record.targetKind,
        record.targetId,
        record.reason,
        record.placedAt,
        record.releasedAt,
      ],
    );
  }

  public async releaseRetentionHold(
    tenantId: string,
    holdId: string,
    releasedAt: Date,
  ): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE cloud_retention_holds
       SET released_at = $3
       WHERE tenant_id = $1
         AND hold_id = $2
         AND released_at IS NULL
         AND placed_at <= $3`,
      [tenantId, holdId, releasedAt],
    );
    return result.rowCount === 1;
  }

  public async insertDeletionMarker(record: CloudDeletionMarkerRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_deletion_markers (
         tenant_id,
         target_kind,
         target_id,
         deletion_request_id,
         deleted_at
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, target_kind, target_id) DO NOTHING`,
      [
        record.tenantId,
        record.targetKind,
        record.targetId,
        record.deletionRequestId,
        record.deletedAt,
      ],
    );
  }

  public async insertAuditEvent(record: CloudAuditEventRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_audit_events (
         event_id,
         request_id,
         actor_account_id,
         actor_device_id,
         tenant_id,
         resource_type,
         resource_id,
         action,
         result,
         redacted_diff,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        record.eventId,
        record.requestId,
        record.actorAccountId,
        record.actorDeviceId,
        record.tenantId,
        record.resourceType,
        record.resourceId,
        record.action,
        record.result,
        JSON.stringify(record.redactedDiff),
        record.createdAt,
      ],
    );
  }
}

export function mapDeletionJob(row: DeletionJobRow): CloudDeletionJobRecord {
  return {
    attemptCount: requireNonnegativeSafeInteger(row.attempt_count, "deletion attempt count"),
    backupRetainedUntil: nullableDate(row.backup_retained_until, "deletion backup_retained_until"),
    backupRetentionSeconds: requireNonnegativeSafeInteger(
      row.backup_retention_seconds,
      "deletion backup retention",
    ),
    blockedReason: row.blocked_reason,
    cancellableUntil: requireDate(row.cancellable_until, "deletion cancellable_until"),
    commitStartedAt: nullableDate(row.commit_started_at, "deletion commit_started_at"),
    completedAt: nullableDate(row.completed_at, "deletion completed_at"),
    confirmationId: row.confirmation_id,
    createdAt: requireDate(row.created_at, "deletion created_at"),
    deletionRequestId: row.deletion_request_id,
    impact: {
      deviceCount: requireNonnegativeSafeInteger(
        row.impact_device_count,
        "deletion device impact count",
      ),
      encryptedChunkCount: requireNonnegativeSafeInteger(
        row.impact_encrypted_chunk_count,
        "deletion encrypted-chunk impact count",
      ),
      keyEnvelopeCount: requireNonnegativeSafeInteger(
        row.impact_key_envelope_count,
        "deletion key-envelope impact count",
      ),
      projectCount: requireNonnegativeSafeInteger(
        row.impact_project_count,
        "deletion project impact count",
      ),
      sessionCount: requireNonnegativeSafeInteger(
        row.impact_session_count,
        "deletion session impact count",
      ),
      syncOperationCount: requireNonnegativeSafeInteger(
        row.impact_sync_operation_count,
        "deletion sync-operation impact count",
      ),
    },
    lastFailureCode: row.last_failure_code,
    leaseExpiresAt: nullableDate(row.lease_expires_at, "deletion lease_expires_at"),
    leaseOwner: row.lease_owner,
    liveDataPurgedAt: nullableDate(row.live_data_purged_at, "deletion live_data_purged_at"),
    nextAttemptAt: requireDate(row.next_attempt_at, "deletion next_attempt_at"),
    phase: row.phase,
    requestedAt: requireDate(row.requested_at, "deletion requested_at"),
    requestedByAccountId: row.requested_by_account_id,
    revision: requirePositiveSafeInteger(row.revision, "deletion revision"),
    scheduledFor: requireDate(row.scheduled_for, "deletion scheduled_for"),
    state: row.state,
    targetId: row.target_id,
    targetKind: row.target_kind,
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "deletion updated_at"),
  };
}

function mapDeletionJobProject(row: DeletionJobProjectRow): CloudDeletionJobProjectRecord {
  return {
    completedAt: nullableDate(row.completed_at, "deletion project completed_at"),
    deletionRequestId: row.deletion_request_id,
    ordinal: requireNonnegativeSafeInteger(row.ordinal, "deletion project ordinal"),
    originalDeletionScheduledFor: nullableDate(
      row.original_deletion_scheduled_for,
      "original project deletion_scheduled_for",
    ),
    originalState: row.original_state,
    phase: row.phase,
    projectId: row.project_id,
    projectRevisionAtFreeze: requirePositiveSafeInteger(
      row.project_revision_at_freeze,
      "project revision at deletion freeze",
    ),
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "deletion project updated_at"),
  };
}

function mapAccount(row: AccountRow): CloudAccountRecord {
  return {
    accountId: row.account_id,
    createdAt: requireDate(row.created_at, "account created_at"),
    deletionScheduledFor: nullableDate(
      row.deletion_scheduled_for,
      "account deletion_scheduled_for",
    ),
    emailCanonical: row.email_canonical,
    failedLoginCount: requireNonnegativeSafeInteger(
      row.failed_login_count,
      "account failed-login count",
    ),
    lastFailedLoginAt: nullableDate(row.last_failed_login_at, "account last_failed_login_at"),
    lockedUntil: nullableDate(row.locked_until, "account locked_until"),
    passwordHash: row.password_hash,
    revision: requirePositiveSafeInteger(row.revision, "account revision"),
    state: row.state,
    updatedAt: requireDate(row.updated_at, "account updated_at"),
    verifiedAt: nullableDate(row.verified_at, "account verified_at"),
  };
}

function mapProject(row: ProjectRow): CloudProjectRecord {
  return {
    createdAt: requireDate(row.created_at, "project created_at"),
    currentKeyVersion:
      row.current_key_version === null
        ? null
        : requirePositiveSafeInteger(row.current_key_version, "project key version"),
    deletionScheduledFor: nullableDate(
      row.deletion_scheduled_for,
      "project deletion_scheduled_for",
    ),
    minimumAvailableRemoteSequence: requireNonnegativeBigInt(
      row.minimum_available_remote_sequence,
      "minimum available remote sequence",
    ),
    ownerAccountId: row.owner_account_id,
    projectId: row.project_id,
    revision: requirePositiveSafeInteger(row.revision, "project revision"),
    state: row.state,
    syncCompactionEpoch: requireNonnegativeBigInt(
      row.sync_compaction_epoch,
      "sync compaction epoch",
    ),
    tenantId: row.tenant_id,
    updatedAt: requireDate(row.updated_at, "project updated_at"),
  };
}

function mapIdempotency(row: IdempotencyRow): CloudIdempotencyRecord {
  return {
    actorAccountId: row.actor_account_id,
    createdAt: requireDate(row.created_at, "idempotency created_at"),
    expiresAt: requireDate(row.expires_at, "idempotency expires_at"),
    idempotencyKeyHashSha256: row.idempotency_key_hash_sha256,
    operationId: row.operation_id,
    requestHashSha256: row.request_hash_sha256,
    responseSnapshot: row.response_snapshot,
    responseStatus: requirePositiveSafeInteger(row.response_status, "idempotency response status"),
    resultDigestSha256: row.result_digest_sha256,
    resultKind: row.result_kind,
    resultResourceId: row.result_resource_id,
    scopeHashSha256: row.scope_hash_sha256,
  };
}

function mapImpact(row: ImpactRow): CloudDeletionImpactRecord {
  return {
    deviceCount: requireNonnegativeSafeInteger(row.device_count, "device impact count"),
    encryptedChunkCount: requireNonnegativeSafeInteger(
      row.encrypted_chunk_count,
      "encrypted-chunk impact count",
    ),
    keyEnvelopeCount: requireNonnegativeSafeInteger(
      row.key_envelope_count,
      "key-envelope impact count",
    ),
    projectCount: requireNonnegativeSafeInteger(row.project_count, "project impact count"),
    sessionCount: requireNonnegativeSafeInteger(row.session_count, "session impact count"),
    syncOperationCount: requireNonnegativeSafeInteger(
      row.sync_operation_count,
      "sync-operation impact count",
    ),
  };
}

function deletionJobParameters(record: CloudDeletionJobRecord): unknown[] {
  return [
    record.tenantId,
    record.deletionRequestId,
    record.targetKind,
    record.targetId,
    record.requestedByAccountId,
    record.confirmationId,
    record.state,
    record.phase,
    record.revision,
    record.requestedAt,
    record.scheduledFor,
    record.cancellableUntil,
    record.commitStartedAt,
    record.liveDataPurgedAt,
    record.backupRetainedUntil,
    record.completedAt,
    record.blockedReason,
    record.impact.projectCount,
    record.impact.syncOperationCount,
    record.impact.encryptedChunkCount,
    record.impact.keyEnvelopeCount,
    record.impact.deviceCount,
    record.impact.sessionCount,
    record.backupRetentionSeconds,
    record.attemptCount,
    record.nextAttemptAt,
    record.lastFailureCode,
    record.leaseOwner,
    record.leaseExpiresAt,
    record.createdAt,
    record.updatedAt,
  ];
}

function assertBoundedLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Cloud deletion query limit must be between 1 and 1000.");
  }
}

function requireRow<Row>(row: Row | undefined, label: string): Row {
  if (row === undefined) {
    throw new Error(`PostgreSQL did not return ${label}.`);
  }
  return row;
}

function mapNullable<Row, Output>(
  row: Row | undefined,
  mapper: (value: Row) => Output,
): Output | null {
  return row === undefined ? null : mapper(row);
}

function requirePositiveSafeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return parsed;
}

function requireNonnegativeSafeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return parsed;
}

function requireNonnegativeBigInt(value: string, label: string): bigint {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return BigInt(value);
}

function requireDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return value;
}

function nullableDate(value: Date | null, label: string): Date | null {
  return value === null ? null : requireDate(value, label);
}

function requireRowCount(rowCount: number | null, label: string): number {
  if (rowCount === null || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label} count.`);
  }
  return rowCount;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original transaction error remains actionable.
  }
}
