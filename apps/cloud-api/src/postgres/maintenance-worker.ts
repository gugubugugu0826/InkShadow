import type { Pool, PoolClient } from "pg";

import type { CloudMaintenanceConfiguration } from "../maintenance/configuration.js";

export const CLOUD_MAINTENANCE_ADVISORY_LOCK_KEY = "5282253009070371145";

const MAX_TENANTS_PER_RUN = 32;

export interface CloudMaintenanceDeletionCounts {
  readonly ciphertextChunks: number;
  readonly idempotencyRecords: number;
  readonly identityChallenges: number;
  readonly rateLimitWindows: number;
  readonly sessions: number;
  readonly syncBatches: number;
  readonly tombstones: number;
}

export interface CloudMaintenanceRunResult {
  readonly acquiredLock: boolean;
  readonly batchesExecuted: number;
  readonly deleted: CloudMaintenanceDeletionCounts;
  readonly stoppedEarly: boolean;
  readonly tenantsVisited: number;
}

export interface CloudMaintenanceWorkerOptions {
  readonly clock?: () => Date;
}

export interface BoundedBatchDrainResult {
  readonly batchesExecuted: number;
  readonly deleted: number;
  readonly reachedBatchLimit: boolean;
  readonly stoppedEarly: boolean;
}

type MutableDeletionCounts = {
  -readonly [Key in keyof CloudMaintenanceDeletionCounts]: number;
};

export class PostgresCloudMaintenanceWorker {
  private readonly clock: () => Date;
  private tenantCursor: string | null = null;

  public constructor(
    private readonly pool: Pool,
    private readonly configuration: CloudMaintenanceConfiguration,
    options: CloudMaintenanceWorkerOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    assertMaintenanceConfiguration(configuration);
  }

  public async runOnce(signal?: AbortSignal): Promise<CloudMaintenanceRunResult> {
    const client = await this.pool.connect();
    let lockAcquired = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [CLOUD_MAINTENANCE_ADVISORY_LOCK_KEY],
      );
      lockAcquired = lock.rows[0]?.acquired === true;
      if (!lockAcquired) {
        return emptyRunResult(false, signal?.aborted === true);
      }

      const now = this.clock();
      if (!Number.isFinite(now.getTime())) {
        throw new Error("Cloud maintenance clock returned an invalid date.");
      }
      const counts = emptyMutableCounts();
      let batchesExecuted = 0;

      const globalTargets: readonly [
        keyof MutableDeletionCounts,
        (batchSize: number) => Promise<number>,
      ][] = [
        [
          "rateLimitWindows",
          async (batchSize) => deleteExpiredRateLimitWindows(client, now, batchSize),
        ],
        [
          "idempotencyRecords",
          async (batchSize) =>
            deleteExpiredIdempotencyRecords(
              client,
              subtractMilliseconds(now, this.configuration.idempotencyGraceMs),
              batchSize,
            ),
        ],
        [
          "identityChallenges",
          async (batchSize) =>
            deleteCompletedIdentityChallenges(
              client,
              subtractMilliseconds(now, this.configuration.challengeRetentionMs),
              batchSize,
            ),
        ],
        [
          "sessions",
          async (batchSize) =>
            deleteExpiredSessions(
              client,
              subtractMilliseconds(now, this.configuration.sessionRetentionMs),
              batchSize,
            ),
        ],
      ];

      for (const [target, deleteBatch] of globalTargets) {
        const drained = await drainBoundedBatches({
          batchSize: this.configuration.batchSize,
          deleteBatch,
          maximumBatches: this.configuration.maximumBatchesPerTarget,
          ...(signal === undefined ? {} : { signal }),
        });
        counts[target] += drained.deleted;
        batchesExecuted += drained.batchesExecuted;
        if (drained.stoppedEarly) {
          return maintenanceRunResult(true, batchesExecuted, counts, true, 0);
        }
      }

      const tenantIds = await this.loadTenantSlice(client);
      let tenantsVisited = 0;
      for (const tenantId of tenantIds) {
        if (signal?.aborted === true) {
          return maintenanceRunResult(true, batchesExecuted, counts, true, tenantsVisited);
        }
        const tenantResult = await this.cleanTenant(client, tenantId, now, signal);
        mergeCounts(counts, tenantResult.deleted);
        batchesExecuted += tenantResult.batchesExecuted;
        tenantsVisited += 1;
        if (tenantResult.stoppedEarly) {
          return maintenanceRunResult(true, batchesExecuted, counts, true, tenantsVisited);
        }
      }

      return maintenanceRunResult(
        true,
        batchesExecuted,
        counts,
        signal?.aborted === true,
        tenantsVisited,
      );
    } finally {
      if (lockAcquired) {
        await client
          .query("SELECT pg_advisory_unlock($1::bigint)", [CLOUD_MAINTENANCE_ADVISORY_LOCK_KEY])
          .catch(() => {
            // A terminated PostgreSQL session releases its advisory locks.
          });
      }
      client.release();
    }
  }

  private async loadTenantSlice(client: PoolClient): Promise<readonly string[]> {
    const limit = Math.min(this.configuration.batchSize, MAX_TENANTS_PER_RUN);
    let rows = await selectTenantIds(client, this.tenantCursor, limit);
    if (rows.length === 0 && this.tenantCursor !== null) {
      this.tenantCursor = null;
      rows = await selectTenantIds(client, null, limit);
    }
    if (rows.length > 0) {
      this.tenantCursor = rows.at(-1) ?? null;
    }
    return rows;
  }

  private async cleanTenant(
    client: PoolClient,
    tenantId: string,
    now: Date,
    signal?: AbortSignal,
  ): Promise<{
    readonly batchesExecuted: number;
    readonly deleted: CloudMaintenanceDeletionCounts;
    readonly stoppedEarly: boolean;
  }> {
    const counts = emptyMutableCounts();
    let batchesExecuted = 0;
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [tenantId]);
      const syncBatches = await drainBoundedBatches({
        batchSize: this.configuration.batchSize,
        deleteBatch: async (batchSize) =>
          deleteExpiredSyncBatches(
            client,
            subtractMilliseconds(now, this.configuration.syncBatchRetentionMs),
            batchSize,
          ),
        maximumBatches: this.configuration.maximumBatchesPerTarget,
        ...(signal === undefined ? {} : { signal }),
      });
      counts.syncBatches = syncBatches.deleted;
      batchesExecuted += syncBatches.batchesExecuted;

      const ciphertextChunks = await drainBoundedBatches({
        batchSize: this.configuration.batchSize,
        deleteBatch: async (batchSize) =>
          deleteAcknowledgedTombstoneChunks(
            client,
            now,
            subtractMilliseconds(now, this.configuration.tombstoneAcknowledgementGraceMs),
            batchSize,
          ),
        maximumBatches: this.configuration.maximumBatchesPerTarget,
        ...(signal === undefined ? {} : { signal }),
      });
      counts.ciphertextChunks = ciphertextChunks.deleted;
      batchesExecuted += ciphertextChunks.batchesExecuted;

      const tombstones = await drainBoundedBatches({
        batchSize: this.configuration.batchSize,
        deleteBatch: async (batchSize) =>
          deleteAcknowledgedTombstones(
            client,
            now,
            subtractMilliseconds(now, this.configuration.tombstoneAcknowledgementGraceMs),
            batchSize,
          ),
        maximumBatches: this.configuration.maximumBatchesPerTarget,
        ...(signal === undefined ? {} : { signal }),
      });
      counts.tombstones = tombstones.deleted;
      batchesExecuted += tombstones.batchesExecuted;
      await client.query("COMMIT");
      return {
        batchesExecuted,
        deleted: Object.freeze(counts),
        stoppedEarly:
          syncBatches.stoppedEarly || ciphertextChunks.stoppedEarly || tombstones.stoppedEarly,
      };
    } catch (cause: unknown) {
      await client.query("ROLLBACK");
      throw cause;
    }
  }
}

export async function drainBoundedBatches(options: {
  readonly batchSize: number;
  readonly deleteBatch: (batchSize: number) => Promise<number>;
  readonly maximumBatches: number;
  readonly signal?: AbortSignal;
}): Promise<BoundedBatchDrainResult> {
  assertPositiveInteger(options.batchSize, "maintenance batch size");
  assertPositiveInteger(options.maximumBatches, "maintenance maximum batches");
  let batchesExecuted = 0;
  let deleted = 0;
  while (batchesExecuted < options.maximumBatches) {
    if (options.signal?.aborted === true) {
      return Object.freeze({
        batchesExecuted,
        deleted,
        reachedBatchLimit: false,
        stoppedEarly: true,
      });
    }
    const batchDeleted = await options.deleteBatch(options.batchSize);
    if (
      !Number.isSafeInteger(batchDeleted) ||
      batchDeleted < 0 ||
      batchDeleted > options.batchSize
    ) {
      throw new Error("A cloud maintenance batch returned an invalid deletion count.");
    }
    batchesExecuted += 1;
    deleted += batchDeleted;
    if (batchDeleted < options.batchSize) {
      return Object.freeze({
        batchesExecuted,
        deleted,
        reachedBatchLimit: false,
        stoppedEarly: false,
      });
    }
  }
  return Object.freeze({
    batchesExecuted,
    deleted,
    reachedBatchLimit: true,
    stoppedEarly: false,
  });
}

async function deleteExpiredRateLimitWindows(
  client: PoolClient,
  now: Date,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS (
       SELECT key_hash_sha256
       FROM cloud_rate_limit_windows
       WHERE expires_at <= $1
       ORDER BY expires_at, key_hash_sha256
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM cloud_rate_limit_windows AS target
     USING candidates
     WHERE target.key_hash_sha256 = candidates.key_hash_sha256`,
    [now, batchSize],
  );
  return requireRowCount(result.rowCount);
}

async function deleteExpiredIdempotencyRecords(
  client: PoolClient,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS (
       SELECT scope_hash_sha256
       FROM cloud_idempotency_records
       WHERE expires_at <= $1
       ORDER BY expires_at, scope_hash_sha256
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM cloud_idempotency_records AS target
     USING candidates
     WHERE target.scope_hash_sha256 = candidates.scope_hash_sha256`,
    [cutoff, batchSize],
  );
  return requireRowCount(result.rowCount);
}

async function deleteCompletedIdentityChallenges(
  client: PoolClient,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS (
       SELECT challenge_id
       FROM identity_challenges
       WHERE expires_at <= $1
          OR (consumed_at IS NOT NULL AND consumed_at <= $1)
       ORDER BY LEAST(expires_at, COALESCE(consumed_at, expires_at)), challenge_id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM identity_challenges AS target
     USING candidates
     WHERE target.challenge_id = candidates.challenge_id`,
    [cutoff, batchSize],
  );
  return requireRowCount(result.rowCount);
}

async function deleteExpiredSessions(
  client: PoolClient,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS (
       SELECT session_id
       FROM cloud_sessions
       WHERE refresh_expires_at <= $1
       ORDER BY refresh_expires_at, session_id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM cloud_sessions AS target
     USING candidates
     WHERE target.session_id = candidates.session_id`,
    [cutoff, batchSize],
  );
  return requireRowCount(result.rowCount);
}

async function deleteExpiredSyncBatches(
  client: PoolClient,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS (
       SELECT tenant_id, project_id, batch_id
       FROM cloud_sync_batches
       WHERE server_time <= $1
       ORDER BY server_time, project_id, batch_id
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM cloud_sync_batches AS target
     USING candidates
     WHERE target.tenant_id = candidates.tenant_id
       AND target.project_id = candidates.project_id
       AND target.batch_id = candidates.batch_id`,
    [cutoff, batchSize],
  );
  return requireRowCount(result.rowCount);
}

async function deleteAcknowledgedTombstoneChunks(
  client: PoolClient,
  now: Date,
  acknowledgementCutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT
         chunk.ctid,
         chunk.tenant_id,
         chunk.project_id,
         compaction.compact_through
       FROM sync_ciphertext_chunks AS chunk
       JOIN sync_operations AS operation
         ON operation.operation_id = chunk.operation_id
        AND operation.tenant_id = chunk.tenant_id
        AND operation.project_id = chunk.project_id
        AND operation.object_type = chunk.object_type
       JOIN LATERAL (
         SELECT deletion.remote_sequence AS compact_through
         FROM sync_tombstones AS tombstone
         JOIN sync_operations AS deletion
           ON deletion.operation_id = tombstone.operation_id
          AND deletion.tenant_id = tombstone.tenant_id
          AND deletion.project_id = tombstone.project_id
          AND deletion.object_type = tombstone.object_type
         WHERE tombstone.tenant_id = chunk.tenant_id
           AND tombstone.project_id = chunk.project_id
           AND tombstone.object_type = operation.object_type
           AND tombstone.object_id = operation.object_id
           AND operation.object_generation <= tombstone.object_generation
           AND ${eligibleTombstonePredicate("tombstone")}
         ORDER BY tombstone.object_generation DESC, deletion.remote_sequence DESC
         LIMIT 1
       ) AS compaction ON true
       ORDER BY chunk.created_at, chunk.chunk_id
       LIMIT $3
       FOR UPDATE OF chunk SKIP LOCKED
     ),
     floors AS (
       SELECT tenant_id, project_id, MAX(compact_through) AS compact_through
       FROM candidates
       GROUP BY tenant_id, project_id
     ),
     advanced_projects AS (
       UPDATE cloud_projects AS project
       SET minimum_available_remote_sequence = GREATEST(
         project.minimum_available_remote_sequence,
         floors.compact_through
       ),
       sync_compaction_epoch = project.sync_compaction_epoch + 1
       FROM floors
       WHERE project.tenant_id = floors.tenant_id
         AND project.project_id = floors.project_id
       RETURNING project.tenant_id, project.project_id
     )
     DELETE FROM sync_ciphertext_chunks AS target
     USING candidates, advanced_projects
     WHERE target.ctid = candidates.ctid
       AND advanced_projects.tenant_id = candidates.tenant_id
       AND advanced_projects.project_id = candidates.project_id`,
    [now, acknowledgementCutoff, batchSize],
  );
  return requireRowCount(result.rowCount);
}

async function deleteAcknowledgedTombstones(
  client: PoolClient,
  now: Date,
  acknowledgementCutoff: Date,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT
         tombstone.ctid,
         tombstone.tenant_id,
         tombstone.project_id,
         deletion.remote_sequence AS compact_through
       FROM sync_tombstones AS tombstone
       JOIN sync_operations AS deletion
         ON deletion.operation_id = tombstone.operation_id
        AND deletion.tenant_id = tombstone.tenant_id
        AND deletion.project_id = tombstone.project_id
        AND deletion.object_type = tombstone.object_type
       WHERE ${eligibleTombstonePredicate("tombstone")}
         AND NOT EXISTS (
           SELECT 1
           FROM sync_ciphertext_chunks AS chunk
           JOIN sync_operations AS operation
             ON operation.operation_id = chunk.operation_id
            AND operation.tenant_id = chunk.tenant_id
            AND operation.project_id = chunk.project_id
            AND operation.object_type = chunk.object_type
           WHERE chunk.tenant_id = tombstone.tenant_id
             AND chunk.project_id = tombstone.project_id
             AND operation.object_type = tombstone.object_type
             AND operation.object_id = tombstone.object_id
             AND operation.object_generation <= tombstone.object_generation
         )
       ORDER BY
         tombstone.retain_until,
         tombstone.project_id,
         tombstone.object_type,
         tombstone.object_id
       LIMIT $3
       FOR UPDATE OF tombstone SKIP LOCKED
     ),
     floors AS (
       SELECT tenant_id, project_id, MAX(compact_through) AS compact_through
       FROM candidates
       GROUP BY tenant_id, project_id
     ),
     advanced_projects AS (
       UPDATE cloud_projects AS project
       SET minimum_available_remote_sequence = GREATEST(
         project.minimum_available_remote_sequence,
         floors.compact_through
       ),
       sync_compaction_epoch = project.sync_compaction_epoch + 1
       FROM floors
       WHERE project.tenant_id = floors.tenant_id
         AND project.project_id = floors.project_id
       RETURNING project.tenant_id, project.project_id
     )
     DELETE FROM sync_tombstones AS target
     USING candidates, advanced_projects
     WHERE target.ctid = candidates.ctid
       AND advanced_projects.tenant_id = candidates.tenant_id
       AND advanced_projects.project_id = candidates.project_id`,
    [now, acknowledgementCutoff, batchSize],
  );
  return requireRowCount(result.rowCount);
}

function eligibleTombstonePredicate(alias: string): string {
  return `${alias}.retain_until <= $1
    AND GREATEST(
      ${alias}.retain_until,
      COALESCE(
        (
          SELECT MAX(acknowledgement.acknowledged_at)
          FROM cloud_project_access AS project_access
          JOIN registered_devices AS trusted_device
            ON trusted_device.account_id = project_access.account_id
           AND trusted_device.state = 'trusted'
           AND trusted_device.revoked_at IS NULL
          JOIN sync_tombstone_acknowledgements AS acknowledgement
            ON acknowledgement.tenant_id = ${alias}.tenant_id
           AND acknowledgement.project_id = ${alias}.project_id
           AND acknowledgement.object_type = ${alias}.object_type
           AND acknowledgement.object_id = ${alias}.object_id
           AND acknowledgement.object_generation = ${alias}.object_generation
           AND acknowledgement.device_id = trusted_device.device_id
          WHERE project_access.tenant_id = ${alias}.tenant_id
            AND project_access.project_id = ${alias}.project_id
            AND project_access.revoked_at IS NULL
        ),
        ${alias}.retain_until
      )
    ) <= $2
    AND NOT EXISTS (
      SELECT 1
      FROM cloud_project_access AS project_access
      JOIN registered_devices AS trusted_device
        ON trusted_device.account_id = project_access.account_id
       AND trusted_device.state = 'trusted'
       AND trusted_device.revoked_at IS NULL
      LEFT JOIN sync_tombstone_acknowledgements AS acknowledgement
        ON acknowledgement.tenant_id = ${alias}.tenant_id
       AND acknowledgement.project_id = ${alias}.project_id
       AND acknowledgement.object_type = ${alias}.object_type
       AND acknowledgement.object_id = ${alias}.object_id
       AND acknowledgement.object_generation = ${alias}.object_generation
       AND acknowledgement.device_id = trusted_device.device_id
      WHERE project_access.tenant_id = ${alias}.tenant_id
        AND project_access.project_id = ${alias}.project_id
        AND project_access.revoked_at IS NULL
        AND acknowledgement.device_id IS NULL
    )`;
}

async function selectTenantIds(
  client: PoolClient,
  afterTenantId: string | null,
  limit: number,
): Promise<readonly string[]> {
  const result = await client.query<{ tenant_id: string }>(
    `SELECT account_id::text AS tenant_id
     FROM cloud_accounts
     WHERE ($1::uuid IS NULL OR account_id > $1::uuid)
     ORDER BY account_id
     LIMIT $2`,
    [afterTenantId, limit],
  );
  return result.rows.map((row) => row.tenant_id);
}

function subtractMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() - milliseconds);
}

function emptyMutableCounts(): MutableDeletionCounts {
  return {
    ciphertextChunks: 0,
    idempotencyRecords: 0,
    identityChallenges: 0,
    rateLimitWindows: 0,
    sessions: 0,
    syncBatches: 0,
    tombstones: 0,
  };
}

function mergeCounts(target: MutableDeletionCounts, source: CloudMaintenanceDeletionCounts): void {
  for (const key of Object.keys(target) as (keyof MutableDeletionCounts)[]) {
    target[key] += source[key];
  }
}

function emptyRunResult(acquiredLock: boolean, stoppedEarly: boolean): CloudMaintenanceRunResult {
  return maintenanceRunResult(acquiredLock, 0, emptyMutableCounts(), stoppedEarly, 0);
}

function maintenanceRunResult(
  acquiredLock: boolean,
  batchesExecuted: number,
  deleted: MutableDeletionCounts,
  stoppedEarly: boolean,
  tenantsVisited: number,
): CloudMaintenanceRunResult {
  return Object.freeze({
    acquiredLock,
    batchesExecuted,
    deleted: Object.freeze({ ...deleted }),
    stoppedEarly,
    tenantsVisited,
  });
}

function requireRowCount(rowCount: number | null): number {
  if (rowCount === null || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error("PostgreSQL returned an invalid maintenance deletion count.");
  }
  return rowCount;
}

function assertMaintenanceConfiguration(configuration: CloudMaintenanceConfiguration): void {
  assertPositiveInteger(configuration.batchSize, "maintenance batch size");
  assertPositiveInteger(configuration.maximumBatchesPerTarget, "maintenance maximum batches");
  for (const [name, value] of Object.entries({
    challengeRetentionMs: configuration.challengeRetentionMs,
    idempotencyGraceMs: configuration.idempotencyGraceMs,
    intervalMs: configuration.intervalMs,
    sessionRetentionMs: configuration.sessionRetentionMs,
    syncBatchRetentionMs: configuration.syncBatchRetentionMs,
    tombstoneAcknowledgementGraceMs: configuration.tombstoneAcknowledgementGraceMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Cloud ${name} must be a non-negative safe integer.`);
    }
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Cloud ${name} must be a positive safe integer.`);
  }
}
