import type { Pool, PoolClient } from "pg";

import type { CloudDeletionBlockedReason } from "@inkshadow/contracts";

import {
  DELETED_ACCOUNT_PASSWORD_SENTINEL,
  evaluateCloudDeletionJob,
  nextCloudDeletionPhase,
  type CloudDeletionJobRecord,
} from "../domain/deletion-records.js";
import { mapDeletionJob, type DeletionJobRow } from "./deletion-store.js";

const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_BLOCKED_RECHECK_MS = 5 * 60_000;
const DEFAULT_TENANTS_PER_RUN = 32;

export interface CloudDeletionExternalPurgePort {
  /**
   * This pre-commit readiness check must be side-effect free. Destructive
   * external work may begin only after the database commit point is durable;
   * neither path may receive credentials, ciphertext or creative content.
   */
  findCommitBlocker(job: CloudDeletionJobRecord): Promise<"external_purge_pending" | null>;
}

export interface PostgresCloudDeletionWorkerOptions {
  readonly batchSize?: number;
  readonly blockedRecheckMs?: number;
  readonly clock?: () => Date;
  readonly externalPurgePort?: CloudDeletionExternalPurgePort;
  readonly leaseDurationMs?: number;
  readonly retryDelayMs?: number;
  readonly tenantsPerRun?: number;
  readonly workerId: string;
}

export interface CloudDeletionWorkerRunResult {
  readonly advanced: number;
  readonly blocked: number;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly stoppedEarly: boolean;
  readonly tenantsVisited: number;
}

interface ClaimedDeletionJob {
  readonly deletionRequestId: string;
  readonly job: CloudDeletionJobRecord;
  readonly leaseOwner: string;
  readonly tenantId: string;
}

interface PhaseProgress {
  readonly completedJob: boolean;
  readonly stageAdvanced: boolean;
}

type ActiveDeletionPhase = Exclude<
  CloudDeletionJobRecord["phase"],
  "backup_wait" | "complete" | "freeze"
>;

const READY_EXTERNAL_PURGE_PORT: CloudDeletionExternalPurgePort = Object.freeze({
  findCommitBlocker: () => Promise.resolve(null),
});

export class PostgresCloudDeletionWorker {
  private readonly batchSize: number;
  private readonly blockedRecheckMs: number;
  private readonly clock: () => Date;
  private readonly externalPurgePort: CloudDeletionExternalPurgePort;
  private readonly leaseDurationMs: number;
  private readonly retryDelayMs: number;
  private readonly tenantsPerRun: number;
  private tenantCursor: string | null = null;

  public constructor(
    private readonly pool: Pool,
    options: PostgresCloudDeletionWorkerOptions,
  ) {
    assertWorkerId(options.workerId);
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.blockedRecheckMs = options.blockedRecheckMs ?? DEFAULT_BLOCKED_RECHECK_MS;
    this.clock = options.clock ?? (() => new Date());
    this.externalPurgePort = options.externalPurgePort ?? READY_EXTERNAL_PURGE_PORT;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.tenantsPerRun = options.tenantsPerRun ?? DEFAULT_TENANTS_PER_RUN;
    this.workerId = options.workerId;
    assertBoundedPositiveInteger(this.batchSize, 2_000, "deletion batch size");
    assertBoundedPositiveInteger(
      this.blockedRecheckMs,
      24 * 60 * 60 * 1_000,
      "deletion blocked recheck",
    );
    assertBoundedPositiveInteger(this.leaseDurationMs, 10 * 60 * 1_000, "deletion lease duration");
    assertBoundedPositiveInteger(this.retryDelayMs, 24 * 60 * 60 * 1_000, "deletion retry delay");
    assertBoundedPositiveInteger(this.tenantsPerRun, 128, "deletion tenant batch size");
  }

  private readonly workerId: string;

  public async runOnce(signal?: AbortSignal): Promise<CloudDeletionWorkerRunResult> {
    const tenantIds = await this.loadTenantSlice(this.validNow());
    let advanced = 0;
    let blocked = 0;
    let claimed = 0;
    let completed = 0;
    let failed = 0;
    let tenantsVisited = 0;

    for (const tenantId of tenantIds) {
      if (signal?.aborted === true) {
        return freezeRunResult({
          advanced,
          blocked,
          claimed,
          completed,
          failed,
          stoppedEarly: true,
          tenantsVisited,
        });
      }
      tenantsVisited += 1;
      const claimedAt = this.validNow();
      const claim = await this.claimRunnableJob(tenantId, claimedAt);
      if (claim === null) {
        continue;
      }
      claimed += 1;
      try {
        const externalBlocker =
          claim.job.commitStartedAt === null
            ? await this.externalPurgePort.findCommitBlocker(claim.job)
            : null;
        const progress = await this.processClaim(claim, this.validNow(), externalBlocker);
        if (progress === null) {
          continue;
        }
        advanced += progress.stageAdvanced ? 1 : 0;
        completed += progress.completedJob ? 1 : 0;
        blocked += progress.blocked ? 1 : 0;
      } catch {
        failed += 1;
        await this.recordFailure(claim, this.validNow()).catch(() => {
          // A process crash or database outage leaves the lease to expire. No
          // destructive stage can be partially committed.
        });
      }
    }

    return freezeRunResult({
      advanced,
      blocked,
      claimed,
      completed,
      failed,
      stoppedEarly: signal?.aborted === true,
      tenantsVisited,
    });
  }

  private async loadTenantSlice(now: Date): Promise<readonly string[]> {
    const client = await this.pool.connect();
    try {
      let tenantIds = await selectTenantIds(client, this.tenantCursor, this.tenantsPerRun, now);
      if (tenantIds.length === 0 && this.tenantCursor !== null) {
        this.tenantCursor = null;
        tenantIds = await selectTenantIds(client, null, this.tenantsPerRun, now);
      }
      if (tenantIds.length > 0) {
        this.tenantCursor = tenantIds.at(-1) ?? null;
      }
      return tenantIds;
    } finally {
      client.release();
    }
  }

  private async claimRunnableJob(tenantId: string, now: Date): Promise<ClaimedDeletionJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await setTenant(client, tenantId);
      const leaseExpiresAt = addMilliseconds(now, this.leaseDurationMs);
      const result = await client.query<DeletionJobRow>(
        `WITH candidate AS (
           SELECT deletion_request_id
           FROM cloud_deletion_jobs
           WHERE tenant_id = $1
             AND state NOT IN ('purged', 'cancelled')
             AND next_attempt_at <= $2
             AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
             AND (
               state = 'purging'
               OR state = 'blocked'
               OR (
                 state = 'grace_period'
                 AND scheduled_for <= $2
               )
               OR (
                 state = 'backup_retention'
                 AND backup_retained_until <= $2
               )
             )
           ORDER BY next_attempt_at, scheduled_for, deletion_request_id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE cloud_deletion_jobs AS job
         SET lease_owner = $3,
             lease_expires_at = $4,
             updated_at = GREATEST(job.updated_at, $2)
         FROM candidate
         WHERE job.tenant_id = $1
           AND job.deletion_request_id = candidate.deletion_request_id
         RETURNING job.*`,
        [tenantId, now, this.workerId, leaseExpiresAt],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        deletionRequestId: row.deletion_request_id,
        job: mapDeletionJob(row),
        leaseOwner: this.workerId,
        tenantId,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async processClaim(
    claim: ClaimedDeletionJob,
    now: Date,
    externalBlocker: "external_purge_pending" | null,
  ): Promise<(PhaseProgress & { readonly blocked: boolean }) | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await setTenant(client, claim.tenantId);
      const job = await lockClaimedJob(client, claim, now);
      if (job === null) {
        await client.query("COMMIT");
        return null;
      }

      const databaseBlocker =
        job.commitStartedAt === null ? await findDatabaseBlocker(client, job) : null;
      const blocker = databaseBlocker ?? externalBlocker;
      const evaluation = evaluateCloudDeletionJob(job, now, blocker);
      let progress: PhaseProgress & { readonly blocked: boolean };

      switch (evaluation.kind) {
        case "terminal":
          await clearLease(client, job, now, now);
          progress = { blocked: false, completedJob: false, stageAdvanced: false };
          break;
        case "wait":
          await moveToGracePeriod(client, job, now, evaluation.until);
          progress = { blocked: false, completedJob: false, stageAdvanced: false };
          break;
        case "blocked":
          await moveToBlocked(
            client,
            job,
            now,
            evaluation.reason,
            addMilliseconds(now, this.blockedRecheckMs),
          );
          progress = { blocked: true, completedJob: false, stageAdvanced: false };
          break;
        case "begin_commit":
          await assertFrozenTarget(client, job);
          await beginCommit(client, job, now);
          progress = { blocked: false, completedJob: false, stageAdvanced: true };
          break;
        case "complete_backup_retention":
          await completeBackupRetention(client, job, now);
          progress = { blocked: false, completedJob: true, stageAdvanced: true };
          break;
        case "process_phase": {
          const phaseProgress = await this.processPhase(client, job, evaluation.phase, now);
          progress = { ...phaseProgress, blocked: false };
          break;
        }
      }

      await client.query("COMMIT");
      return progress;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async processPhase(
    client: PoolClient,
    job: CloudDeletionJobRecord,
    phase: ActiveDeletionPhase,
    now: Date,
  ): Promise<PhaseProgress> {
    if (job.targetKind === "project") {
      const phaseComplete = await processProjectPhase(
        client,
        job.tenantId,
        job.targetId,
        job.deletionRequestId,
        phase,
        now,
        this.batchSize,
      );
      if (!phaseComplete) {
        await recordPhaseBatchProgress(client, job, now);
        return { completedJob: false, stageAdvanced: false };
      }
      return advanceJobAfterPhase(client, job, phase, now);
    }

    const project = await findAccountJobProjectAtPhase(client, job, phase);
    if (project !== null) {
      const phaseComplete = await processProjectPhase(
        client,
        job.tenantId,
        project.project_id,
        job.deletionRequestId,
        phase,
        now,
        this.batchSize,
      );
      if (phaseComplete) {
        await advanceAccountJobProject(client, job, project.project_id, phase, now);
      }
      await recordPhaseBatchProgress(client, job, now);
      return { completedJob: false, stageAdvanced: phaseComplete };
    }

    await assertAccountProjectPhaseComplete(client, job, phase);
    if (phase === "access") {
      const identityComplete = await purgeAccountIdentityBatch(
        client,
        job.targetId,
        job.deletionRequestId,
        this.batchSize,
        now,
      );
      if (!identityComplete) {
        await recordPhaseBatchProgress(client, job, now);
        return { completedJob: false, stageAdvanced: false };
      }
    } else if (phase === "marker") {
      await insertDeletionMarker(
        client,
        job.tenantId,
        "account",
        job.targetId,
        job.deletionRequestId,
        now,
      );
    } else if (phase === "verify") {
      await verifyAccountPurged(client, job);
    }
    return advanceJobAfterPhase(client, job, phase, now);
  }

  private async recordFailure(claim: ClaimedDeletionJob, now: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await setTenant(client, claim.tenantId);
      await client.query(
        `UPDATE cloud_deletion_jobs
         SET attempt_count = LEAST(attempt_count + 1, 1000000),
             next_attempt_at = $4,
             last_failure_code = 'DELETION_STAGE_FAILED',
             lease_owner = NULL,
             lease_expires_at = NULL,
             revision = LEAST(revision + 1, 9007199254740991),
             updated_at = GREATEST(updated_at, $3)
         WHERE tenant_id = $1
           AND deletion_request_id = $2
           AND lease_owner = $5
           AND lease_expires_at > $3`,
        [
          claim.tenantId,
          claim.deletionRequestId,
          now,
          addMilliseconds(now, this.retryDelayMs),
          claim.leaseOwner,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private validNow(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Cloud deletion worker clock returned an invalid date.");
    }
    return now;
  }
}

async function lockClaimedJob(
  client: PoolClient,
  claim: ClaimedDeletionJob,
  now: Date,
): Promise<CloudDeletionJobRecord | null> {
  const result = await client.query<DeletionJobRow>(
    `SELECT *
     FROM cloud_deletion_jobs
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND lease_owner = $3
       AND lease_expires_at > $4
     FOR UPDATE`,
    [claim.tenantId, claim.deletionRequestId, claim.leaseOwner, now],
  );
  return result.rows[0] === undefined ? null : mapDeletionJob(result.rows[0]);
}

async function findDatabaseBlocker(
  client: PoolClient,
  job: CloudDeletionJobRecord,
): Promise<CloudDeletionBlockedReason | null> {
  const result = await client.query<{ reason: CloudDeletionBlockedReason }>(
    `SELECT hold.reason
     FROM cloud_retention_holds AS hold
     WHERE hold.tenant_id = $1
       AND hold.released_at IS NULL
       AND (
         (
           hold.target_kind = $2
           AND hold.target_id = $3
         )
         OR (
           $2 = 'account'
           AND hold.target_kind = 'project'
           AND EXISTS (
             SELECT 1
             FROM cloud_deletion_job_projects AS project
             WHERE project.tenant_id = $1
               AND project.deletion_request_id = $4
               AND project.project_id = hold.target_id
           )
         )
       )
     ORDER BY
       CASE hold.reason
         WHEN 'legal_hold_active' THEN 1
         WHEN 'ownership_transfer_required' THEN 2
         WHEN 'external_purge_pending' THEN 3
       END,
       hold.placed_at,
       hold.hold_id
     LIMIT 1`,
    [job.tenantId, job.targetKind, job.targetId, job.deletionRequestId],
  );
  const holdReason = result.rows[0]?.reason ?? null;
  if (holdReason === "legal_hold_active" || job.targetKind !== "account") {
    return holdReason;
  }
  const competingProjectJob = await client.query(
    `SELECT 1
     FROM cloud_deletion_job_projects AS frozen
     JOIN cloud_deletion_jobs AS competing
       ON competing.tenant_id = frozen.tenant_id
      AND competing.target_kind = 'project'
      AND competing.target_id = frozen.project_id
      AND competing.deletion_request_id <> frozen.deletion_request_id
      AND competing.state NOT IN ('purged', 'cancelled')
     WHERE frozen.tenant_id = $1
       AND frozen.deletion_request_id = $2
     LIMIT 1`,
    [job.tenantId, job.deletionRequestId],
  );
  return competingProjectJob.rows[0] === undefined ? holdReason : "ownership_transfer_required";
}

async function assertFrozenTarget(client: PoolClient, job: CloudDeletionJobRecord): Promise<void> {
  if (job.targetKind === "project") {
    const result = await client.query(
      `SELECT 1
       FROM cloud_projects
       WHERE tenant_id = $1
         AND project_id = $2
         AND state = 'deletion_scheduled'
         AND deletion_scheduled_for = $3
       LIMIT 1`,
      [job.tenantId, job.targetId, job.scheduledFor],
    );
    requireExists(result.rows[0], "frozen deletion project");
    return;
  }

  const account = await client.query(
    `SELECT 1
     FROM cloud_accounts
     WHERE account_id = $1
       AND state = 'deletion_scheduled'
       AND deletion_scheduled_for = $2
     LIMIT 1`,
    [job.targetId, job.scheduledFor],
  );
  requireExists(account.rows[0], "frozen deletion account");
  const unfrozenProject = await client.query(
    `SELECT 1
     FROM cloud_deletion_job_projects AS frozen
     LEFT JOIN cloud_projects AS project
       ON project.tenant_id = frozen.tenant_id
      AND project.project_id = frozen.project_id
     WHERE frozen.tenant_id = $1
       AND frozen.deletion_request_id = $2
       AND (
         project.project_id IS NULL
         OR project.state <> 'deletion_scheduled'
         OR project.deletion_scheduled_for <> $3
       )
     LIMIT 1`,
    [job.tenantId, job.deletionRequestId, job.scheduledFor],
  );
  if (unfrozenProject.rows[0] !== undefined) {
    throw new Error("Account deletion project set is no longer frozen.");
  }
}

async function beginCommit(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE cloud_deletion_jobs
     SET state = 'purging',
         phase = 'derived',
         revision = revision + 1,
         commit_started_at = $3,
         blocked_reason = NULL,
         attempt_count = 0,
         next_attempt_at = $3,
         last_failure_code = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $3
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND revision = $4::bigint
       AND state IN ('grace_period', 'blocked')
       AND commit_started_at IS NULL`,
    [job.tenantId, job.deletionRequestId, now, job.revision],
  );
  requireSingleUpdate(result.rowCount, "deletion commit point");
}

async function moveToGracePeriod(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  now: Date,
  nextAttemptAt: Date,
): Promise<void> {
  const changed = job.state !== "grace_period" || job.blockedReason !== null;
  const result = await client.query(
    `UPDATE cloud_deletion_jobs
     SET state = 'grace_period',
         phase = 'freeze',
         blocked_reason = NULL,
         revision = revision + $5,
         next_attempt_at = $3,
         last_failure_code = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $4
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND revision = $6::bigint
       AND commit_started_at IS NULL`,
    [job.tenantId, job.deletionRequestId, nextAttemptAt, now, changed ? 1 : 0, job.revision],
  );
  requireSingleUpdate(result.rowCount, "deletion grace-period state");
}

async function moveToBlocked(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  now: Date,
  reason: CloudDeletionBlockedReason,
  nextAttemptAt: Date,
): Promise<void> {
  const scheduledFor = job.scheduledFor < nextAttemptAt ? nextAttemptAt : job.scheduledFor;
  const cancellableUntil = scheduledFor;
  if (scheduledFor.getTime() !== job.scheduledFor.getTime()) {
    await extendFrozenTargetSchedule(client, job, scheduledFor, now);
  }
  const changed =
    job.state !== "blocked" ||
    job.blockedReason !== reason ||
    scheduledFor.getTime() !== job.scheduledFor.getTime() ||
    cancellableUntil.getTime() !== job.cancellableUntil.getTime();
  const result = await client.query(
    `UPDATE cloud_deletion_jobs
     SET state = 'blocked',
         phase = 'freeze',
         blocked_reason = $3,
         scheduled_for = $4,
         cancellable_until = $4,
         revision = revision + $7,
         next_attempt_at = $5,
         last_failure_code = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $6
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND revision = $8::bigint
       AND commit_started_at IS NULL`,
    [
      job.tenantId,
      job.deletionRequestId,
      reason,
      scheduledFor,
      nextAttemptAt,
      now,
      changed ? 1 : 0,
      job.revision,
    ],
  );
  requireSingleUpdate(result.rowCount, "blocked deletion state");
}

async function extendFrozenTargetSchedule(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  scheduledFor: Date,
  now: Date,
): Promise<void> {
  if (job.targetKind === "project") {
    const result = await client.query(
      `UPDATE cloud_projects
       SET deletion_scheduled_for = $4,
           revision = revision + 1,
           updated_at = $5
       WHERE tenant_id = $1
         AND project_id = $2
         AND state = 'deletion_scheduled'
         AND deletion_scheduled_for = $3`,
      [job.tenantId, job.targetId, job.scheduledFor, scheduledFor, now],
    );
    requireSingleUpdate(result.rowCount, "extended project deletion freeze");
    return;
  }

  const accountResult = await client.query(
    `UPDATE cloud_accounts
     SET deletion_scheduled_for = $3,
         revision = revision + 1,
         updated_at = $4
     WHERE account_id = $1
       AND state = 'deletion_scheduled'
       AND deletion_scheduled_for = $2`,
    [job.targetId, job.scheduledFor, scheduledFor, now],
  );
  requireSingleUpdate(accountResult.rowCount, "extended account deletion freeze");
  const expectedProjects = await client.query<{ project_count: string }>(
    `SELECT COUNT(*)::text AS project_count
     FROM cloud_deletion_job_projects
     WHERE tenant_id = $1
       AND deletion_request_id = $2`,
    [job.tenantId, job.deletionRequestId],
  );
  const projectResult = await client.query(
    `UPDATE cloud_projects AS project
     SET deletion_scheduled_for = $4,
         revision = project.revision + 1,
         updated_at = $5
     FROM cloud_deletion_job_projects AS frozen
     WHERE frozen.tenant_id = $1
       AND frozen.deletion_request_id = $2
       AND project.tenant_id = frozen.tenant_id
       AND project.project_id = frozen.project_id
       AND project.state = 'deletion_scheduled'
       AND project.deletion_scheduled_for = $3`,
    [job.tenantId, job.deletionRequestId, job.scheduledFor, scheduledFor, now],
  );
  const expectedCount = Number(expectedProjects.rows[0]?.project_count);
  if (!Number.isSafeInteger(expectedCount) || projectResult.rowCount !== expectedCount) {
    throw new Error("Account deletion project schedules could not all be extended.");
  }
}

async function clearLease(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  now: Date,
  nextAttemptAt: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE cloud_deletion_jobs
     SET next_attempt_at = $3,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = GREATEST(updated_at, $4)
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND revision = $5::bigint`,
    [job.tenantId, job.deletionRequestId, nextAttemptAt, now, job.revision],
  );
  requireSingleUpdate(result.rowCount, "deletion lease");
}

async function processProjectPhase(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  deletionRequestId: string,
  phase: ActiveDeletionPhase,
  now: Date,
  batchSize: number,
): Promise<boolean> {
  switch (phase) {
    case "derived":
      return purgeProjectDerivedBatch(client, tenantId, projectId, batchSize);
    case "ciphertext":
      return purgeProjectCiphertextBatch(client, tenantId, projectId, batchSize);
    case "keys":
      return purgeProjectKeysBatch(client, tenantId, projectId, batchSize);
    case "access":
      return purgeProjectAccessBatch(client, tenantId, projectId, batchSize);
    case "marker":
      await markProjectDeleted(client, tenantId, projectId, deletionRequestId, now);
      return true;
    case "verify":
      await verifyProjectPurged(client, tenantId, projectId);
      return true;
  }
}

async function purgeProjectDerivedBatch(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  batchSize: number,
): Promise<boolean> {
  await client.query(
    `WITH candidates AS (
       SELECT idempotency.scope_hash_sha256
       FROM cloud_idempotency_records AS idempotency
       WHERE idempotency.result_kind <> 'deletion_job'
         AND (
           (
             idempotency.result_kind = 'project_key'
             AND idempotency.result_resource_id = $2
           )
           OR (
             idempotency.result_kind = 'team_project_key_envelope'
             AND idempotency.result_resource_id IS NOT NULL
             AND inkshadow_team_project_key_envelope_belongs_to_project(
               $1,
               $2,
               idempotency.result_resource_id
             )
           )
           OR (
             idempotency.result_kind = 'review'
             AND idempotency.result_resource_id IS NOT NULL
             AND inkshadow_review_resource_belongs_to_project(
               $1,
               $2,
               idempotency.result_resource_id
             )
           )
           OR (
             idempotency.result_kind = 'sync_batch'
             AND EXISTS (
               SELECT 1
               FROM cloud_sync_batches AS batch
               WHERE batch.tenant_id = $1
                 AND batch.project_id = $2
                 AND batch.batch_id = idempotency.result_resource_id
             )
           )
         )
       ORDER BY idempotency.created_at, idempotency.scope_hash_sha256
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM cloud_idempotency_records AS target
     USING candidates
     WHERE target.scope_hash_sha256 = candidates.scope_hash_sha256`,
    [tenantId, projectId, batchSize],
  );
  if (await hasAssociatedProjectIdempotency(client, tenantId, projectId)) {
    return false;
  }
  await deleteBoundedRows(
    client,
    "cloud_sync_batches",
    "tenant_id = $1 AND project_id = $2",
    "server_time, batch_id",
    [tenantId, projectId],
    batchSize,
  );
  return !(await existsWhere(client, "cloud_sync_batches", "tenant_id = $1 AND project_id = $2", [
    tenantId,
    projectId,
  ]));
}

async function hasAssociatedProjectIdempotency(
  client: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM cloud_idempotency_records AS idempotency
     WHERE idempotency.result_kind <> 'deletion_job'
       AND (
         (
           idempotency.result_kind = 'project_key'
           AND idempotency.result_resource_id = $2
         )
         OR (
           idempotency.result_kind = 'team_project_key_envelope'
           AND idempotency.result_resource_id IS NOT NULL
           AND inkshadow_team_project_key_envelope_belongs_to_project(
             $1,
             $2,
             idempotency.result_resource_id
           )
         )
         OR (
           idempotency.result_kind = 'review'
           AND idempotency.result_resource_id IS NOT NULL
           AND inkshadow_review_resource_belongs_to_project(
             $1,
             $2,
             idempotency.result_resource_id
           )
         )
         OR (
           idempotency.result_kind = 'sync_batch'
           AND EXISTS (
             SELECT 1
             FROM cloud_sync_batches AS batch
             WHERE batch.tenant_id = $1
               AND batch.project_id = $2
               AND batch.batch_id = idempotency.result_resource_id
           )
         )
       )
     LIMIT 1`,
    [tenantId, projectId],
  );
  return result.rows[0] !== undefined;
}

async function purgeProjectCiphertextBatch(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  batchSize: number,
): Promise<boolean> {
  await deleteBoundedRows(
    client,
    "sync_tombstone_acknowledgements",
    "tenant_id = $1 AND project_id = $2",
    "object_type, object_id, object_generation, device_id",
    [tenantId, projectId],
    batchSize,
  );
  if (
    await existsWhere(
      client,
      "sync_tombstone_acknowledgements",
      "tenant_id = $1 AND project_id = $2",
      [tenantId, projectId],
    )
  ) {
    return false;
  }
  await deleteBoundedRows(
    client,
    "sync_ciphertext_chunks",
    "tenant_id = $1 AND project_id = $2",
    "created_at, chunk_id",
    [tenantId, projectId],
    batchSize,
  );
  if (
    await existsWhere(client, "sync_ciphertext_chunks", "tenant_id = $1 AND project_id = $2", [
      tenantId,
      projectId,
    ])
  ) {
    return false;
  }
  await deleteBoundedRows(
    client,
    "sync_tombstones",
    "tenant_id = $1 AND project_id = $2",
    "created_at, object_type, object_id, object_generation",
    [tenantId, projectId],
    batchSize,
  );
  if (
    await existsWhere(client, "sync_tombstones", "tenant_id = $1 AND project_id = $2", [
      tenantId,
      projectId,
    ])
  ) {
    return false;
  }
  await deleteBoundedRows(
    client,
    "sync_operations",
    "tenant_id = $1 AND project_id = $2",
    "remote_sequence",
    [tenantId, projectId],
    batchSize,
  );
  return !(await existsWhere(client, "sync_operations", "tenant_id = $1 AND project_id = $2", [
    tenantId,
    projectId,
  ]));
}

async function purgeProjectKeysBatch(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  batchSize: number,
): Promise<boolean> {
  await client.query(`SELECT inkshadow_purge_team_project_key_envelopes_batch($1, $2, $3)`, [
    tenantId,
    projectId,
    batchSize,
  ]);
  if ((await countTeamProjectKeyEnvelopes(client, tenantId, projectId)) > 0n) {
    return false;
  }
  await deleteBoundedRows(
    client,
    "device_project_key_envelopes",
    "tenant_id = $1 AND project_id = $2",
    "key_version, recipient_device_id",
    [tenantId, projectId],
    batchSize,
  );
  if (
    await existsWhere(
      client,
      "device_project_key_envelopes",
      "tenant_id = $1 AND project_id = $2",
      [tenantId, projectId],
    )
  ) {
    return false;
  }
  await deleteBoundedRows(
    client,
    "project_key_versions",
    "tenant_id = $1 AND project_id = $2",
    "key_version",
    [tenantId, projectId],
    batchSize,
  );
  return !(await existsWhere(client, "project_key_versions", "tenant_id = $1 AND project_id = $2", [
    tenantId,
    projectId,
  ]));
}

async function purgeProjectAccessBatch(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  batchSize: number,
): Promise<boolean> {
  await deleteBoundedRows(
    client,
    "cloud_project_access",
    "tenant_id = $1 AND project_id = $2",
    "account_id",
    [tenantId, projectId],
    batchSize,
  );
  return !(await existsWhere(client, "cloud_project_access", "tenant_id = $1 AND project_id = $2", [
    tenantId,
    projectId,
  ]));
}

async function markProjectDeleted(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  deletionRequestId: string,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE cloud_projects
     SET state = 'deleted',
         current_key_version = NULL,
         minimum_available_remote_sequence = 0,
         sync_compaction_epoch = sync_compaction_epoch + 1,
         revision = revision + 1,
         deletion_scheduled_for = NULL,
         updated_at = $3
     WHERE tenant_id = $1
       AND project_id = $2
       AND state IN ('deletion_scheduled', 'deleted')`,
    [tenantId, projectId, now],
  );
  requireSingleUpdate(result.rowCount, "cloud project deletion marker");
  await insertDeletionMarker(client, tenantId, "project", projectId, deletionRequestId, now);
}

async function insertDeletionMarker(
  client: PoolClient,
  tenantId: string,
  targetKind: "account" | "project",
  targetId: string,
  deletionRequestId: string,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO cloud_deletion_markers (
       tenant_id,
       target_kind,
       target_id,
       deletion_request_id,
       deleted_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, target_kind, target_id) DO UPDATE
     SET deleted_at = LEAST(cloud_deletion_markers.deleted_at, EXCLUDED.deleted_at)
     WHERE cloud_deletion_markers.deletion_request_id = EXCLUDED.deletion_request_id`,
    [tenantId, targetKind, targetId, deletionRequestId, now],
  );
  requireSingleUpdate(result.rowCount, "cloud deletion marker");
}

async function verifyProjectPurged(
  client: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<void> {
  const reviewRecords = await client.query<{ record_count: string }>(
    `SELECT inkshadow_count_review_records($1, $2)::text AS record_count`,
    [tenantId, projectId],
  );
  if (reviewRecords.rows[0]?.record_count !== "0") {
    throw new Error("Project deletion verification found residual sensitive rows.");
  }
  if ((await countTeamProjectKeyEnvelopes(client, tenantId, projectId)) > 0n) {
    throw new Error("Project deletion verification found residual sensitive rows.");
  }
  for (const table of [
    "cloud_sync_batches",
    "sync_tombstone_acknowledgements",
    "sync_ciphertext_chunks",
    "sync_tombstones",
    "sync_operations",
    "device_project_key_envelopes",
    "project_key_versions",
    "cloud_project_access",
  ]) {
    if (
      await existsWhere(client, table, "tenant_id = $1 AND project_id = $2", [tenantId, projectId])
    ) {
      throw new Error("Project deletion verification found residual sensitive rows.");
    }
  }
  if (await hasAssociatedProjectIdempotency(client, tenantId, projectId)) {
    throw new Error("Project deletion verification found residual idempotency rows.");
  }
  const marker = await client.query(
    `SELECT 1
     FROM cloud_projects AS project
     JOIN cloud_deletion_markers AS marker
       ON marker.tenant_id = project.tenant_id
      AND marker.target_kind = 'project'
      AND marker.target_id = project.project_id
     WHERE project.tenant_id = $1
       AND project.project_id = $2
       AND project.state = 'deleted'
       AND project.current_key_version IS NULL
       AND project.deletion_scheduled_for IS NULL
     LIMIT 1`,
    [tenantId, projectId],
  );
  requireExists(marker.rows[0], "verified project deletion marker");
}

async function countTeamProjectKeyEnvelopes(
  client: PoolClient,
  tenantId: string,
  projectId: string,
): Promise<bigint> {
  const result = await client.query<{ envelope_count: string }>(
    `SELECT inkshadow_count_team_project_key_envelopes($1, $2)::text
       AS envelope_count`,
    [tenantId, projectId],
  );
  const value = result.rows[0]?.envelope_count;
  if (value === undefined || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Project deletion received an invalid team-envelope count.");
  }
  return BigInt(value);
}

interface AccountJobProjectRow {
  readonly project_id: string;
}

async function findAccountJobProjectAtPhase(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  phase: ActiveDeletionPhase,
): Promise<AccountJobProjectRow | null> {
  const result = await client.query<AccountJobProjectRow>(
    `SELECT project_id
     FROM cloud_deletion_job_projects
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND phase = $3
     ORDER BY ordinal
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [job.tenantId, job.deletionRequestId, phase],
  );
  return result.rows[0] ?? null;
}

async function advanceAccountJobProject(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  projectId: string,
  phase: ActiveDeletionPhase,
  now: Date,
): Promise<void> {
  const nextPhase = nextCloudDeletionPhase(phase);
  const completedAt = nextPhase === "complete" ? now : null;
  const result = await client.query(
    `UPDATE cloud_deletion_job_projects
     SET phase = $4,
         completed_at = $5,
         updated_at = $6
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND project_id = $3
       AND phase = $7`,
    [job.tenantId, job.deletionRequestId, projectId, nextPhase, completedAt, now, phase],
  );
  requireSingleUpdate(result.rowCount, "account deletion project checkpoint");
}

async function assertAccountProjectPhaseComplete(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  phase: ActiveDeletionPhase,
): Promise<void> {
  const allowedPhases = phasesAfter(phase);
  const result = await client.query(
    `SELECT 1
     FROM cloud_deletion_job_projects
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND NOT (phase = ANY($3::text[]))
     LIMIT 1`,
    [job.tenantId, job.deletionRequestId, allowedPhases],
  );
  if (result.rows[0] !== undefined) {
    throw new Error("Account deletion project checkpoint is inconsistent.");
  }
}

function phasesAfter(phase: ActiveDeletionPhase): readonly string[] {
  const phases: readonly string[] = [
    "derived",
    "ciphertext",
    "keys",
    "access",
    "marker",
    "verify",
    "complete",
  ];
  const index = phases.indexOf(phase);
  if (index < 0) {
    throw new Error("Account deletion phase is invalid.");
  }
  return phases.slice(index + 1);
}

async function purgeAccountIdentityBatch(
  client: PoolClient,
  accountId: string,
  deletionRequestId: string,
  batchSize: number,
  now: Date,
): Promise<boolean> {
  const teamAccessRevocation = await client.query<{ revoked_membership_count: number }>(
    `SELECT inkshadow_revoke_account_team_access($1, $2, $3)
       AS revoked_membership_count`,
    [accountId, now, deletionRequestId],
  );
  const revokedMembershipCount = teamAccessRevocation.rows[0]?.revoked_membership_count;
  if (!Number.isSafeInteger(revokedMembershipCount) || (revokedMembershipCount ?? -1) < 0) {
    throw new Error("Account team-access revocation returned an invalid count.");
  }

  const accountResult = await client.query<{ email_canonical: string; state: string }>(
    `SELECT email_canonical, state
     FROM cloud_accounts
     WHERE account_id = $1
     FOR UPDATE`,
    [accountId],
  );
  const account = accountResult.rows[0];
  requireExists(account, "account deletion tombstone source");

  await client.query(
    `WITH candidates AS (
       SELECT idempotency.scope_hash_sha256
       FROM cloud_idempotency_records AS idempotency
       WHERE idempotency.result_kind <> 'deletion_job'
         AND (
           idempotency.actor_account_id = $1
           OR idempotency.result_resource_id = $1
           OR EXISTS (
             SELECT 1
             FROM identity_challenges AS challenge
             WHERE (
                 challenge.account_id = $1
                 OR challenge.email_canonical = $2
               )
               AND challenge.challenge_id = idempotency.result_resource_id
           )
           OR EXISTS (
             SELECT 1
             FROM cloud_sessions AS session
             WHERE session.account_id = $1
               AND session.session_id = idempotency.result_resource_id
           )
           OR EXISTS (
             SELECT 1
             FROM registered_devices AS device
             WHERE device.account_id = $1
               AND device.device_id = idempotency.result_resource_id
           )
         )
       ORDER BY idempotency.created_at, idempotency.scope_hash_sha256
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM cloud_idempotency_records AS target
     USING candidates
     WHERE target.scope_hash_sha256 = candidates.scope_hash_sha256`,
    [accountId, account.email_canonical, batchSize],
  );
  if (await hasAssociatedAccountIdempotency(client, accountId, account.email_canonical)) {
    return false;
  }

  await deleteBoundedRows(
    client,
    "identity_challenges",
    "(account_id = $1 OR email_canonical = $2)",
    "created_at, challenge_id",
    [accountId, account.email_canonical],
    batchSize,
  );
  await deleteBoundedRows(
    client,
    "cloud_sessions",
    "account_id = $1",
    "issued_at, session_id",
    [accountId],
    batchSize,
  );
  if (
    (await existsWhere(client, "identity_challenges", "(account_id = $1 OR email_canonical = $2)", [
      accountId,
      account.email_canonical,
    ])) ||
    (await existsWhere(client, "cloud_sessions", "account_id = $1", [accountId]))
  ) {
    return false;
  }

  await scrubDeviceBatch(client, accountId, now, batchSize);
  if (await hasUnscrubbedDevice(client, accountId)) {
    return false;
  }

  const tombstoneEmail = `deleted-${accountId.replaceAll("-", "")}@deleted.invalid`;
  const accountUpdate = await client.query(
    `UPDATE cloud_accounts
     SET email_canonical = $2,
         password_hash = $3,
         state = 'deleted',
         revision = revision + 1,
         failed_login_count = 0,
         last_failed_login_at = NULL,
         locked_until = NULL,
         verified_at = COALESCE(verified_at, created_at),
         deletion_scheduled_for = NULL,
         updated_at = $4
     WHERE account_id = $1
       AND state IN ('deletion_scheduled', 'deleted')`,
    [accountId, tombstoneEmail, DELETED_ACCOUNT_PASSWORD_SENTINEL, now],
  );
  requireSingleUpdate(accountUpdate.rowCount, "account deletion tombstone");
  return true;
}

async function hasAssociatedAccountIdempotency(
  client: PoolClient,
  accountId: string,
  emailCanonical: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM cloud_idempotency_records AS idempotency
     WHERE idempotency.result_kind <> 'deletion_job'
       AND (
         idempotency.actor_account_id = $1
         OR idempotency.result_resource_id = $1
         OR EXISTS (
           SELECT 1
           FROM identity_challenges AS challenge
           WHERE (
               challenge.account_id = $1
               OR challenge.email_canonical = $2
             )
             AND challenge.challenge_id = idempotency.result_resource_id
         )
         OR EXISTS (
           SELECT 1
           FROM cloud_sessions AS session
           WHERE session.account_id = $1
             AND session.session_id = idempotency.result_resource_id
         )
         OR EXISTS (
           SELECT 1
           FROM registered_devices AS device
           WHERE device.account_id = $1
             AND device.device_id = idempotency.result_resource_id
         )
       )
     LIMIT 1`,
    [accountId, emailCanonical],
  );
  return result.rows[0] !== undefined;
}

async function scrubDeviceBatch(
  client: PoolClient,
  accountId: string,
  now: Date,
  batchSize: number,
): Promise<void> {
  await client.query(
    `WITH candidates AS (
       SELECT device_id
       FROM registered_devices
       WHERE account_id = $1
         AND NOT (
           state = 'revoked'
           AND display_name LIKE 'Deleted device %'
           AND client_version = '0.0.0'
           AND public_key = left(
             replace(device_id::text, '-', '') || repeat('A', 87),
             87
           )
           AND public_key_fingerprint = left(
             replace(device_id::text, '-', '') || repeat('0', 64),
             64
           )
         )
       ORDER BY device_id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     UPDATE registered_devices AS device
     SET display_name = 'Deleted device ' || left(replace(device.device_id::text, '-', ''), 8),
         public_key = left(
           replace(device.device_id::text, '-', '') || repeat('A', 87),
           87
         ),
         public_key_fingerprint = left(
           replace(device.device_id::text, '-', '') || repeat('0', 64),
           64
         ),
         client_version = '0.0.0',
         state = 'revoked',
         revision = revision + 1,
         updated_at = $2,
         revoked_at = COALESCE(revoked_at, $2)
     FROM candidates
     WHERE device.device_id = candidates.device_id`,
    [accountId, now, batchSize],
  );
}

async function hasUnscrubbedDevice(client: PoolClient, accountId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM registered_devices
     WHERE account_id = $1
       AND NOT (
         state = 'revoked'
         AND display_name LIKE 'Deleted device %'
         AND client_version = '0.0.0'
         AND public_key = left(
           replace(device_id::text, '-', '') || repeat('A', 87),
           87
         )
         AND public_key_fingerprint = left(
           replace(device_id::text, '-', '') || repeat('0', 64),
           64
         )
       )
     LIMIT 1`,
    [accountId],
  );
  return result.rows[0] !== undefined;
}

async function verifyAccountPurged(client: PoolClient, job: CloudDeletionJobRecord): Promise<void> {
  const account = await client.query(
    `SELECT 1
     FROM cloud_accounts
     WHERE account_id = $1
       AND state = 'deleted'
       AND email_canonical = $2
       AND password_hash = $3
       AND deletion_scheduled_for IS NULL
     LIMIT 1`,
    [
      job.targetId,
      `deleted-${job.targetId.replaceAll("-", "")}@deleted.invalid`,
      DELETED_ACCOUNT_PASSWORD_SENTINEL,
    ],
  );
  requireExists(account.rows[0], "verified account tombstone");
  for (const table of ["identity_challenges", "cloud_sessions"]) {
    if (await existsWhere(client, table, "account_id = $1", [job.targetId])) {
      throw new Error("Account deletion verification found residual identity rows.");
    }
  }
  if (await hasUnscrubbedDevice(client, job.targetId)) {
    throw new Error("Account deletion verification found an active device identity.");
  }
  const idempotency = await client.query(
    `SELECT 1
     FROM cloud_idempotency_records
     WHERE actor_account_id = $1
       AND result_kind <> 'deletion_job'
     LIMIT 1`,
    [job.targetId],
  );
  if (idempotency.rows[0] !== undefined) {
    throw new Error("Account deletion verification found residual idempotency rows.");
  }
  const teamAccess = await client.query<{ has_active_team_access: boolean }>(
    `SELECT inkshadow_account_has_active_team_access($1)
       AS has_active_team_access`,
    [job.targetId],
  );
  const hasActiveTeamAccess = teamAccess.rows[0]?.has_active_team_access;
  if (typeof hasActiveTeamAccess !== "boolean") {
    throw new Error("Account deletion verification received an invalid team-access result.");
  }
  if (hasActiveTeamAccess) {
    throw new Error("Account deletion verification found residual team access.");
  }
  const invitationOutbox = await client.query(
    `SELECT 1
     FROM cloud_team_invitations AS invitation
     LEFT JOIN cloud_team_invitation_outbox AS delivery
       ON delivery.tenant_id = invitation.tenant_id
      AND delivery.team_id = invitation.team_id
      AND delivery.invitation_id = invitation.invitation_id
     WHERE invitation.invitee_email = $1
       AND (
         invitation.state = 'pending'
         OR delivery.state IN ('pending', 'leased')
         OR delivery.token_ciphertext IS NOT NULL
         OR delivery.token_nonce IS NOT NULL
         OR delivery.token_auth_tag IS NOT NULL
         OR delivery.encryption_key_id IS NOT NULL
         OR delivery.lease_owner IS NOT NULL
         OR delivery.lease_expires_at IS NOT NULL
       )
     LIMIT 1`,
    [`deleted-${job.deletionRequestId}@deleted.invalid`],
  );
  if (invitationOutbox.rows[0] !== undefined) {
    throw new Error(
      "Account deletion verification found a deliverable invitation or residual outbox secret.",
    );
  }
  const marker = await client.query(
    `SELECT 1
     FROM cloud_deletion_markers
     WHERE tenant_id = $1
       AND target_kind = 'account'
       AND target_id = $1
       AND deletion_request_id = $2
     LIMIT 1`,
    [job.tenantId, job.deletionRequestId],
  );
  requireExists(marker.rows[0], "verified account deletion marker");
}

async function recordPhaseBatchProgress(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE cloud_deletion_jobs
     SET revision = revision + 1,
         attempt_count = 0,
         next_attempt_at = $3,
         last_failure_code = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $3
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND revision = $4::bigint
       AND state = 'purging'`,
    [job.tenantId, job.deletionRequestId, now, job.revision],
  );
  requireSingleUpdate(result.rowCount, "deletion batch checkpoint");
}

async function advanceJobAfterPhase(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  phase: ActiveDeletionPhase,
  now: Date,
): Promise<PhaseProgress> {
  if (phase !== "verify") {
    const nextPhase = nextCloudDeletionPhase(phase);
    const liveDataPurgedAt = nextPhase === "marker" ? now : job.liveDataPurgedAt;
    const result = await client.query(
      `UPDATE cloud_deletion_jobs
       SET phase = $3,
           revision = revision + 1,
           live_data_purged_at = $4,
           attempt_count = 0,
           next_attempt_at = $5,
           last_failure_code = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = $5
       WHERE tenant_id = $1
         AND deletion_request_id = $2
         AND revision = $6::bigint
         AND state = 'purging'
         AND phase = $7`,
      [job.tenantId, job.deletionRequestId, nextPhase, liveDataPurgedAt, now, job.revision, phase],
    );
    requireSingleUpdate(result.rowCount, "deletion phase checkpoint");
    return { completedJob: false, stageAdvanced: true };
  }

  const liveDataPurgedAt = job.liveDataPurgedAt;
  if (liveDataPurgedAt === null) {
    throw new Error("Deletion verification is missing its live-data purge timestamp.");
  }
  const backupRetainedUntil = addMilliseconds(liveDataPurgedAt, job.backupRetentionSeconds * 1_000);
  const completeNow = job.backupRetentionSeconds === 0 || backupRetainedUntil <= now;
  const result = await client.query(
    `UPDATE cloud_deletion_jobs
     SET state = $3,
         phase = $4,
         revision = revision + 1,
         backup_retained_until = $5,
         completed_at = $6,
         attempt_count = 0,
         next_attempt_at = $7,
         last_failure_code = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $7
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND revision = $8::bigint
       AND state = 'purging'
       AND phase = 'verify'`,
    [
      job.tenantId,
      job.deletionRequestId,
      completeNow ? "purged" : "backup_retention",
      completeNow ? "complete" : "backup_wait",
      job.backupRetentionSeconds === 0 ? null : backupRetainedUntil,
      completeNow ? now : null,
      completeNow ? now : backupRetainedUntil,
      job.revision,
    ],
  );
  requireSingleUpdate(result.rowCount, "deletion verification checkpoint");
  return { completedJob: completeNow, stageAdvanced: true };
}

async function completeBackupRetention(
  client: PoolClient,
  job: CloudDeletionJobRecord,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE cloud_deletion_jobs
     SET state = 'purged',
         phase = 'complete',
         revision = revision + 1,
         completed_at = $3,
         attempt_count = 0,
         next_attempt_at = $3,
         last_failure_code = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $3
     WHERE tenant_id = $1
       AND deletion_request_id = $2
       AND revision = $4::bigint
       AND state = 'backup_retention'
       AND phase = 'backup_wait'
       AND backup_retained_until <= $3`,
    [job.tenantId, job.deletionRequestId, now, job.revision],
  );
  requireSingleUpdate(result.rowCount, "backup-retention completion");
}

async function deleteBoundedRows(
  client: PoolClient,
  table: string,
  predicate: string,
  orderBy: string,
  parameters: readonly unknown[],
  batchSize: number,
): Promise<void> {
  assertSafeSqlFragment(table);
  assertSafeSqlFragment(orderBy);
  assertSafePredicate(predicate);
  await client.query(
    `WITH candidates AS (
       SELECT ctid
       FROM ${table}
       WHERE ${predicate}
       ORDER BY ${orderBy}
       LIMIT $${String(parameters.length + 1)}
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM ${table} AS target
     USING candidates
     WHERE target.ctid = candidates.ctid`,
    [...parameters, batchSize],
  );
}

async function existsWhere(
  client: PoolClient,
  table: string,
  predicate: string,
  parameters: readonly unknown[],
): Promise<boolean> {
  assertSafeSqlFragment(table);
  assertSafePredicate(predicate);
  const result = await client.query(
    `SELECT 1
     FROM ${table}
     WHERE ${predicate}
     LIMIT 1`,
    [...parameters],
  );
  return result.rows[0] !== undefined;
}

function assertSafeSqlFragment(value: string): void {
  if (!/^[a-z0-9_, ]+$/u.test(value)) {
    throw new Error("Unsafe cloud deletion SQL identifier.");
  }
}

function assertSafePredicate(value: string): void {
  if (!/^[a-z0-9_ =$().<>]+$/iu.test(value)) {
    throw new Error("Unsafe cloud deletion SQL predicate.");
  }
}

async function selectTenantIds(
  client: PoolClient,
  afterTenantId: string | null,
  limit: number,
  now: Date,
): Promise<readonly string[]> {
  const result = await client.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id::text AS tenant_id
     FROM cloud_deletion_jobs
     WHERE ($1::uuid IS NULL OR tenant_id > $1::uuid)
       AND state NOT IN ('purged', 'cancelled')
       AND next_attempt_at <= $2
       AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
       AND (
         state = 'purging'
         OR state = 'blocked'
         OR (
           state = 'grace_period'
           AND scheduled_for <= $2
         )
         OR (
           state = 'backup_retention'
           AND backup_retained_until <= $2
         )
       )
     ORDER BY tenant_id
     LIMIT $3`,
    [afterTenantId, now, limit],
  );
  return result.rows.map((row) => row.tenant_id);
}

async function setTenant(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [tenantId]);
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  const result = new Date(value.getTime() + milliseconds);
  if (!Number.isFinite(result.getTime())) {
    throw new Error("Cloud deletion timestamp is outside the supported range.");
  }
  return result;
}

function requireExists<T>(value: T | undefined, label: string): asserts value is T {
  if (value === undefined) {
    throw new Error(`Cloud deletion could not find ${label}.`);
  }
}

function requireSingleUpdate(rowCount: number | null, label: string): void {
  if (rowCount !== 1) {
    throw new Error(`Cloud deletion failed to update exactly one ${label}.`);
  }
}

function assertWorkerId(value: string): void {
  if (value.length < 1 || value.length > 100 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error("Cloud deletion worker ID is invalid.");
  }
}

function assertBoundedPositiveInteger(value: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Cloud ${label} is outside the supported range.`);
  }
}

function freezeRunResult(result: CloudDeletionWorkerRunResult): CloudDeletionWorkerRunResult {
  return Object.freeze(result);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original operation failure remains actionable.
  }
}
