import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Pool, PoolClient } from "pg";

import { DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION } from "../src/maintenance/configuration.js";
import {
  CLOUD_MAINTENANCE_ADVISORY_LOCK_KEY,
  PostgresCloudMaintenanceWorker,
} from "../src/postgres/maintenance-worker.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresCloudProjectStore } from "../src/postgres/project-store.js";
import { SyncCursorCodec } from "../src/security/sync-cursor.js";
import { SyncSnapshotCursorCodec } from "../src/security/sync-snapshot-cursor.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import { CloudProjectSyncService } from "../src/service/project-sync-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-07-27T14:00:00.000Z");

describePostgres("PostgreSQL bounded cloud maintenance", () => {
  let applicationPool: Pool;
  let pool: Pool;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      connectionString: databaseUrl,
      applicationName: "inkshadow-cloud-maintenance-test",
      maximumConnections: 4,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'inkshadow_maintenance_rls_test'
        ) THEN
          CREATE ROLE inkshadow_maintenance_rls_test LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await pool.query("ALTER ROLE inkshadow_maintenance_rls_test NOSUPERUSER NOBYPASSRLS");
    await pool.query("GRANT USAGE ON SCHEMA public TO inkshadow_maintenance_rls_test");
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE
       ON ALL TABLES IN SCHEMA public
       TO inkshadow_maintenance_rls_test`,
    );
    const applicationUrl = new URL(databaseUrl);
    applicationUrl.username = "inkshadow_maintenance_rls_test";
    applicationUrl.password = "";
    applicationPool = createCloudPostgresPool({
      connectionString: applicationUrl.toString(),
      applicationName: "inkshadow-cloud-maintenance-rls-test",
      maximumConnections: 2,
      requireTls: false,
    });
  });

  afterAll(async () => {
    await applicationPool.end();
    await pool.end();
  });

  it("skips safely while another instance owns the distributed advisory lock", async () => {
    const lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock($1::bigint)", [
      CLOUD_MAINTENANCE_ADVISORY_LOCK_KEY,
    ]);
    try {
      const worker = createWorker(applicationPool);
      await expect(worker.runOnce()).resolves.toMatchObject({
        acquiredLock: false,
        batchesExecuted: 0,
      });
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [
        CLOUD_MAINTENANCE_ADVISORY_LOCK_KEY,
      ]);
      lockClient.release();
    }
  });

  it("deletes only expired ephemeral rows and fully acknowledged retained tombstones", async () => {
    const fixture = await insertMaintenanceFixture(pool);
    try {
      const projectService = new CloudProjectSyncService({
        clock: () => now,
        cursorCodec: new SyncCursorCodec(Buffer.alloc(32, 0x71)),
        snapshotCursorCodec: new SyncSnapshotCursorCodec(Buffer.alloc(32, 0x72)),
        store: new PostgresCloudProjectStore(pool),
        uuid: createMonotonicUuidV7Factory(() => now.getTime()),
      });
      const snapshotBeforeCompaction = await projectService.getSyncSnapshot(
        {
          accountId: fixture.accountId,
          deviceId: fixture.firstDeviceId,
          sessionId: randomUUID(),
        },
        fixture.projectId,
        null,
        1,
        { requestId: randomUUID() },
      );
      expect(snapshotBeforeCompaction.nextSnapshotCursor).not.toBeNull();
      const worker = createWorker(applicationPool);
      const result = await worker.runOnce();
      expect(result.acquiredLock).toBe(true);
      expect(result.stoppedEarly).toBe(false);
      expect(result.deleted.ciphertextChunks).toBeGreaterThanOrEqual(1);
      expect(result.deleted.idempotencyRecords).toBeGreaterThanOrEqual(1);
      expect(result.deleted.identityChallenges).toBeGreaterThanOrEqual(2);
      expect(result.deleted.rateLimitWindows).toBeGreaterThanOrEqual(5);
      expect(result.deleted.sessions).toBeGreaterThanOrEqual(1);
      expect(result.deleted.syncBatches).toBeGreaterThanOrEqual(1);
      expect(result.deleted.tombstones).toBeGreaterThanOrEqual(1);

      await expectExistingIds(pool, "cloud_rate_limit_windows", "key_hash_sha256", [
        fixture.currentRateLimitHash,
      ]);
      await expectMissingIds(
        pool,
        "cloud_rate_limit_windows",
        "key_hash_sha256",
        fixture.expiredRateLimitHashes,
      );
      await expectExistingIds(pool, "identity_challenges", "challenge_id", [
        fixture.currentChallengeId,
      ]);
      await expectMissingIds(
        pool,
        "identity_challenges",
        "challenge_id",
        fixture.completedChallengeIds,
      );
      await expectExistingIds(pool, "cloud_sessions", "session_id", [fixture.currentSessionId]);
      await expectMissingIds(pool, "cloud_sessions", "session_id", [fixture.expiredSessionId]);
      await expectExistingIds(pool, "cloud_idempotency_records", "scope_hash_sha256", [
        fixture.currentIdempotencyHash,
      ]);
      await expectMissingIds(pool, "cloud_idempotency_records", "scope_hash_sha256", [
        fixture.expiredIdempotencyHash,
      ]);
      await expectExistingIds(pool, "cloud_sync_batches", "batch_id", [fixture.currentSyncBatchId]);
      await expectMissingIds(pool, "cloud_sync_batches", "batch_id", [fixture.expiredSyncBatchId]);
      await expectMissingIds(pool, "sync_ciphertext_chunks", "chunk_id", [fixture.eligibleChunkId]);
      await expectMissingIds(pool, "sync_tombstones", "object_id", [fixture.eligibleObjectId]);
      const compactionFloor = await pool.query<{
        advanced: boolean;
        epoch_advanced: boolean;
      }>(
        `SELECT
           project.minimum_available_remote_sequence >= operation.remote_sequence AS advanced,
           project.sync_compaction_epoch > 0 AS epoch_advanced
         FROM cloud_projects AS project
         JOIN sync_operations AS operation
           ON operation.tenant_id = project.tenant_id
          AND operation.project_id = project.project_id
         WHERE project.tenant_id = $1
           AND project.project_id = $2
           AND operation.operation_id = $3`,
        [fixture.accountId, fixture.projectId, fixture.eligibleDeleteOperationId],
      );
      expect(compactionFloor.rows).toEqual([{ advanced: true, epoch_advanced: true }]);
      await expect(
        projectService.getSyncSnapshot(
          {
            accountId: fixture.accountId,
            deviceId: fixture.firstDeviceId,
            sessionId: randomUUID(),
          },
          fixture.projectId,
          snapshotBeforeCompaction.nextSnapshotCursor,
          1,
          { requestId: randomUUID() },
        ),
      ).rejects.toMatchObject({ code: "SYNC_CURSOR_EXPIRED" });
      await expect(
        projectService.pullSync(
          {
            accountId: fixture.accountId,
            deviceId: fixture.firstDeviceId,
            sessionId: randomUUID(),
          },
          fixture.projectId,
          null,
          100,
          { requestId: randomUUID() },
        ),
      ).rejects.toMatchObject({ code: "SYNC_CURSOR_EXPIRED" });
      await expectExistingIds(pool, "sync_ciphertext_chunks", "chunk_id", [
        fixture.crossTypeChunkId,
        fixture.futureRetentionChunkId,
        fixture.recentAcknowledgementChunkId,
        fixture.unacknowledgedChunkId,
      ]);
      await expectMissingIds(pool, "sync_tombstones", "object_id", [fixture.crossTypeObjectId]);
      await expectExistingIds(pool, "sync_tombstones", "object_id", [
        fixture.futureRetentionObjectId,
        fixture.recentAcknowledgementObjectId,
        fixture.unacknowledgedObjectId,
      ]);
      await expectExistingIds(pool, "cloud_audit_events", "event_id", [fixture.auditEventId]);
    } finally {
      await removeMaintenanceFixture(pool, fixture);
    }
  });
});

function createWorker(pool: Pool): PostgresCloudMaintenanceWorker {
  return new PostgresCloudMaintenanceWorker(
    pool,
    {
      ...DEFAULT_CLOUD_MAINTENANCE_CONFIGURATION,
      batchSize: 10,
      maximumBatchesPerTarget: 3,
    },
    { clock: () => now },
  );
}

interface MaintenanceFixture {
  readonly accountId: string;
  readonly auditEventId: string;
  readonly completedChallengeIds: readonly string[];
  readonly currentChallengeId: string;
  readonly currentIdempotencyHash: string;
  readonly currentRateLimitHash: string;
  readonly currentSessionId: string;
  readonly currentSyncBatchId: string;
  readonly crossTypeChunkId: string;
  readonly crossTypeObjectId: string;
  readonly eligibleChunkId: string;
  readonly eligibleDeleteOperationId: string;
  readonly eligibleObjectId: string;
  readonly expiredIdempotencyHash: string;
  readonly expiredRateLimitHashes: readonly string[];
  readonly expiredSessionId: string;
  readonly expiredSyncBatchId: string;
  readonly firstDeviceId: string;
  readonly futureRetentionChunkId: string;
  readonly futureRetentionObjectId: string;
  readonly projectId: string;
  readonly rateLimitHashes: readonly string[];
  readonly recentAcknowledgementChunkId: string;
  readonly recentAcknowledgementObjectId: string;
  readonly unacknowledgedChunkId: string;
  readonly unacknowledgedObjectId: string;
}

async function insertMaintenanceFixture(pool: Pool): Promise<MaintenanceFixture> {
  const client = await pool.connect();
  const accountId = `00000000-0000-7000-8000-${randomBytes(6).toString("hex")}`;
  const firstDeviceId = randomUUID();
  const secondDeviceId = randomUUID();
  const revokedDeviceId = randomUUID();
  const projectId = createMonotonicUuidV7Factory()();
  const auditEventId = randomUUID();
  const currentChallengeId = randomUUID();
  const currentIdempotencyHash = hash(`idempotency-current-${accountId}`);
  const currentRateLimitHash = hash(`rate-current-${accountId}`);
  const currentSessionId = randomUUID();
  const currentSyncBatchId = randomUUID();
  const crossType = createDeletedObjectFixture();
  const eligible = createDeletedObjectFixture();
  const unacknowledged = createDeletedObjectFixture();
  const futureRetention = createDeletedObjectFixture();
  const recentAcknowledgement = createDeletedObjectFixture();
  const rateLimitHashes = [
    currentRateLimitHash,
    ...Array.from({ length: 5 }, (_, index) => hash(`rate-old-${accountId}-${String(index)}`)),
  ];
  const oldChallengeIds = [randomUUID(), randomUUID()];
  const oldIdempotencyHash = hash(`idempotency-old-${accountId}`);
  const oldSessionId = randomUUID();
  const oldSyncBatchId = randomUUID();
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO cloud_accounts (
         account_id,
         email_canonical,
         password_hash,
         state,
         verified_at,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
      [accountId, `${accountId}@maintenance.example.test`, `scrypt-${"x".repeat(32)}`, now],
    );
    for (const [index, deviceId] of [firstDeviceId, secondDeviceId, revokedDeviceId].entries()) {
      const revoked = index === 2;
      await client.query(
        `INSERT INTO registered_devices (
           device_id,
           account_id,
           display_name,
           algorithm,
           public_key,
           public_key_fingerprint,
           client_version,
           state,
           created_at,
           updated_at,
           revoked_at
         ) VALUES (
           $1, $2, $3, 'DHKEM-P256-HKDF-SHA256',
           $4, $5, '0.1.0', $6, $7, $7, $8
         )`,
        [
          deviceId,
          accountId,
          `Maintenance device ${String(index + 1)}`,
          ["A", "B", "C"][index]?.repeat(87),
          ["a", "b", "c"][index]?.repeat(64),
          revoked ? "revoked" : "trusted",
          now,
          revoked ? now : null,
        ],
      );
    }
    await client.query(
      `INSERT INTO cloud_projects (
         tenant_id,
         project_id,
         owner_account_id,
         state,
         current_key_version,
         revision,
         created_at,
         updated_at
       ) VALUES ($1, $2, $1, 'active', 1, 1, $3, $3)`,
      [accountId, projectId, now],
    );
    await client.query(
      `INSERT INTO cloud_project_access (
         tenant_id,
         project_id,
         account_id,
         role,
         can_manage_keys,
         can_sync,
         created_at
       ) VALUES ($1, $2, $1, 'owner', true, true, $3)`,
      [accountId, projectId, now],
    );
    await client.query(
      `INSERT INTO project_key_versions (
         tenant_id,
         project_id,
         key_version,
         server_revision,
         algorithm,
         state,
         client_revision,
         recovery_id,
         recovery_algorithm,
         recovery_salt,
         recovery_nonce,
         recovery_ciphertext,
         recovery_verifier,
         recovery_created_at,
         recovery_confirmed_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, 1, 1, 'AES-256-GCM', 'active', 1, $3,
         'ARGON2ID-AES256GCM', $4, $5, $6, $7, $8, $8, $8, $8
       )`,
      [
        accountId,
        projectId,
        randomUUID(),
        "s".repeat(22),
        "n".repeat(16),
        "c".repeat(64),
        "v".repeat(43),
        new Date("2019-01-01T00:00:00.000Z"),
      ],
    );

    let deviceSequence = 0;
    for (const fixture of [eligible, unacknowledged, futureRetention, recentAcknowledgement]) {
      deviceSequence += 1;
      await insertUpsertOperation(
        client,
        accountId,
        projectId,
        firstDeviceId,
        deviceSequence,
        fixture,
      );
      deviceSequence += 1;
      await insertDeleteOperationAndTombstone(
        client,
        accountId,
        projectId,
        firstDeviceId,
        deviceSequence,
        fixture,
        fixture === futureRetention
          ? new Date("2027-01-02T00:00:00.000Z")
          : new Date("2021-01-02T00:00:00.000Z"),
      );
    }
    deviceSequence += 1;
    await insertUpsertOperation(
      client,
      accountId,
      projectId,
      firstDeviceId,
      deviceSequence,
      crossType,
    );
    deviceSequence += 1;
    await insertDeleteOperationAndTombstone(
      client,
      accountId,
      projectId,
      firstDeviceId,
      deviceSequence,
      crossType,
      new Date("2021-01-02T00:00:00.000Z"),
      "memory",
    );

    await acknowledgeTombstone(client, accountId, projectId, eligible, firstDeviceId, "2021-01-03");
    await acknowledgeTombstone(
      client,
      accountId,
      projectId,
      eligible,
      secondDeviceId,
      "2021-01-04",
    );
    await acknowledgeTombstone(
      client,
      accountId,
      projectId,
      unacknowledged,
      firstDeviceId,
      "2021-01-03",
    );
    await acknowledgeTombstone(
      client,
      accountId,
      projectId,
      futureRetention,
      firstDeviceId,
      "2026-01-03",
    );
    await acknowledgeTombstone(
      client,
      accountId,
      projectId,
      futureRetention,
      secondDeviceId,
      "2026-01-04",
    );
    await acknowledgeTombstone(
      client,
      accountId,
      projectId,
      recentAcknowledgement,
      firstDeviceId,
      "2026-07-20",
    );
    await acknowledgeTombstone(
      client,
      accountId,
      projectId,
      recentAcknowledgement,
      secondDeviceId,
      "2026-07-21",
    );
    await acknowledgeTombstone(
      client,
      accountId,
      projectId,
      crossType,
      firstDeviceId,
      "2021-01-03",
      "memory",
    );
    await acknowledgeTombstone(
      client,
      accountId,
      projectId,
      crossType,
      secondDeviceId,
      "2021-01-04",
      "memory",
    );

    await insertChallenge(
      client,
      accountId,
      oldChallengeIds[0] ?? "",
      "2019-01-01",
      "2020-01-01",
      null,
    );
    await insertChallenge(
      client,
      accountId,
      oldChallengeIds[1] ?? "",
      "2019-01-01",
      "2027-01-01",
      "2020-01-01",
    );
    await insertChallenge(
      client,
      accountId,
      currentChallengeId,
      "2026-07-27T13:55:00.000Z",
      "2026-07-27T14:10:00.000Z",
      null,
    );

    await insertSession(
      client,
      accountId,
      firstDeviceId,
      oldSessionId,
      "2019-01-01",
      "2019-01-02",
      "2020-01-01",
    );
    await insertSession(
      client,
      accountId,
      firstDeviceId,
      currentSessionId,
      "2026-07-27T13:00:00.000Z",
      "2026-07-27T14:15:00.000Z",
      "2026-08-27T13:00:00.000Z",
    );

    for (const [scopeHash, expiresAt] of [
      [oldIdempotencyHash, "2020-01-01T00:00:00.000Z"],
      [currentIdempotencyHash, "2026-07-29T00:00:00.000Z"],
    ] as const) {
      await client.query(
        `INSERT INTO cloud_idempotency_records (
           scope_hash_sha256,
           actor_account_id,
           operation_id,
           idempotency_key_hash_sha256,
           request_hash_sha256,
           result_kind,
           result_digest_sha256,
           response_status,
           created_at,
           expires_at
         ) VALUES ($1, $2, 'maintenance.test', $3, $4, 'accepted', $5, 202, $6, $7)`,
        [
          scopeHash,
          accountId,
          hash(`key-${scopeHash}`),
          hash(`request-${scopeHash}`),
          hash(`result-${scopeHash}`),
          new Date("2019-01-01T00:00:00.000Z"),
          new Date(expiresAt),
        ],
      );
    }

    for (const [index, keyHash] of rateLimitHashes.entries()) {
      const current = index === 0;
      await client.query(
        `INSERT INTO cloud_rate_limit_windows (
           key_hash_sha256,
           request_count,
           window_started_at,
           expires_at
         ) VALUES ($1, 1, $2, $3)`,
        [
          keyHash,
          current ? now : new Date("2019-01-01T00:00:00.000Z"),
          current ? new Date("2026-07-27T14:01:00.000Z") : new Date("2020-01-01T00:00:00.000Z"),
        ],
      );
    }

    for (const [batchId, serverTime] of [
      [oldSyncBatchId, "2020-01-01T00:00:00.000Z"],
      [currentSyncBatchId, "2026-07-27T13:59:00.000Z"],
    ] as const) {
      await client.query(
        `INSERT INTO cloud_sync_batches (
           tenant_id,
           project_id,
           batch_id,
           account_id,
           device_id,
           accepted_operations,
           remote_sequence,
           server_time
         ) VALUES ($1, $2, $3, $1, $4, $5::jsonb, 8, $6)`,
        [
          accountId,
          projectId,
          batchId,
          firstDeviceId,
          JSON.stringify([{ operationId: eligible.deleteOperationId, disposition: "accepted" }]),
          new Date(serverTime),
        ],
      );
    }

    await client.query(
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
       ) VALUES ($1, $2, $3, $4, $3, 'maintenance_test', $5, 'fixture.created',
                 'allowed', '{}'::jsonb, $6)`,
      [auditEventId, randomUUID(), null, null, projectId, now],
    );
    await client.query("COMMIT");
  } catch (cause: unknown) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }

  return {
    accountId,
    auditEventId,
    completedChallengeIds: oldChallengeIds,
    currentChallengeId,
    currentIdempotencyHash,
    currentRateLimitHash,
    currentSessionId,
    currentSyncBatchId,
    crossTypeChunkId: crossType.chunkId,
    crossTypeObjectId: crossType.objectId,
    eligibleChunkId: eligible.chunkId,
    eligibleDeleteOperationId: eligible.deleteOperationId,
    eligibleObjectId: eligible.objectId,
    expiredIdempotencyHash: oldIdempotencyHash,
    expiredRateLimitHashes: rateLimitHashes.slice(1),
    expiredSessionId: oldSessionId,
    expiredSyncBatchId: oldSyncBatchId,
    firstDeviceId,
    futureRetentionChunkId: futureRetention.chunkId,
    futureRetentionObjectId: futureRetention.objectId,
    projectId,
    rateLimitHashes,
    recentAcknowledgementChunkId: recentAcknowledgement.chunkId,
    recentAcknowledgementObjectId: recentAcknowledgement.objectId,
    unacknowledgedChunkId: unacknowledged.chunkId,
    unacknowledgedObjectId: unacknowledged.objectId,
  };
}

interface DeletedObjectFixture {
  readonly chunkId: string;
  readonly deleteOperationId: string;
  readonly objectId: string;
  readonly upsertOperationId: string;
  readonly versionId: string;
}

function createDeletedObjectFixture(): DeletedObjectFixture {
  return {
    chunkId: randomUUID(),
    deleteOperationId: randomUUID(),
    objectId: randomUUID(),
    upsertOperationId: randomUUID(),
    versionId: randomUUID(),
  };
}

async function insertUpsertOperation(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  deviceId: string,
  deviceSequence: number,
  fixture: DeletedObjectFixture,
): Promise<void> {
  await client.query(
    `INSERT INTO sync_operations (
       tenant_id,
       project_id,
       operation_id,
       device_id,
       device_sequence,
       object_type,
       object_id,
       object_generation,
       kind,
       version_vector,
       encrypted_chunk_ids,
       created_at,
       received_at
     ) VALUES (
       $1, $2, $3, $4, $5, 'story_record', $6,
       1, 'upsert', $7::jsonb, $8::uuid[], $9, $9
     )`,
    [
      tenantId,
      projectId,
      fixture.upsertOperationId,
      deviceId,
      deviceSequence,
      fixture.objectId,
      JSON.stringify({ [deviceId]: deviceSequence }),
      [fixture.chunkId],
      new Date("2019-01-01T00:00:00.000Z"),
    ],
  );
  await client.query(
    `INSERT INTO sync_ciphertext_chunks (
       tenant_id,
       project_id,
       chunk_id,
       operation_id,
       algorithm,
       nonce,
       ciphertext,
       ciphertext_sha256,
       plaintext_bytes,
       object_type,
       object_id,
       version_id,
       chunk_index,
       key_version,
       created_at
     ) VALUES (
       $1, $2, $3, $4, 'AES-256-GCM', $5, $6, $7, 1,
       'story_record', $8, $9, 0, 1, $10
     )`,
    [
      tenantId,
      projectId,
      fixture.chunkId,
      fixture.upsertOperationId,
      "n".repeat(16),
      "YQ",
      hash(`chunk-${fixture.chunkId}`),
      fixture.objectId,
      fixture.versionId,
      new Date("2019-01-01T00:00:00.000Z"),
    ],
  );
}

async function insertDeleteOperationAndTombstone(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  deviceId: string,
  deviceSequence: number,
  fixture: DeletedObjectFixture,
  retainUntil: Date,
  objectType: "memory" | "story_record" = "story_record",
): Promise<void> {
  const deletedAt = new Date("2020-01-01T00:00:00.000Z");
  const vector = JSON.stringify({ [deviceId]: deviceSequence });
  await client.query(
    `INSERT INTO sync_operations (
       tenant_id,
       project_id,
       operation_id,
       device_id,
       device_sequence,
       object_type,
       object_id,
       object_generation,
       kind,
       version_vector,
       encrypted_chunk_ids,
       created_at,
       received_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       1, 'delete', $8::jsonb, '{}', $9, $9
     )`,
    [
      tenantId,
      projectId,
      fixture.deleteOperationId,
      deviceId,
      deviceSequence,
      objectType,
      fixture.objectId,
      vector,
      deletedAt,
    ],
  );
  await client.query(
    `INSERT INTO sync_tombstones (
       tenant_id,
       project_id,
       object_type,
       object_id,
       object_generation,
       operation_id,
       deleted_by_device_id,
       version_vector,
       deleted_at,
       retain_until,
       created_at
     ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7::jsonb, $8, $9, $8)`,
    [
      tenantId,
      projectId,
      objectType,
      fixture.objectId,
      fixture.deleteOperationId,
      deviceId,
      vector,
      deletedAt,
      retainUntil,
    ],
  );
}

async function acknowledgeTombstone(
  client: PoolClient,
  tenantId: string,
  projectId: string,
  fixture: DeletedObjectFixture,
  deviceId: string,
  acknowledgedAt: string,
  objectType: "memory" | "story_record" = "story_record",
): Promise<void> {
  await client.query(
    `INSERT INTO sync_tombstone_acknowledgements (
       tenant_id,
       project_id,
       object_type,
       object_id,
       object_generation,
       device_id,
       acknowledged_at
     ) VALUES ($1, $2, $3, $4, 1, $5, $6)`,
    [tenantId, projectId, objectType, fixture.objectId, deviceId, new Date(acknowledgedAt)],
  );
}

async function insertChallenge(
  client: PoolClient,
  accountId: string,
  challengeId: string,
  createdAt: string,
  expiresAt: string,
  consumedAt: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO identity_challenges (
       challenge_id,
       kind,
       email_canonical,
       account_id,
       pending_password_hash,
       code_hash_sha256,
       expires_at,
       consumed_at,
       created_at
     ) VALUES ($1, 'registration', $2, $3, $4, $5, $6, $7, $8)`,
    [
      challengeId,
      `${challengeId}@maintenance.example.test`,
      accountId,
      `scrypt-${"p".repeat(32)}`,
      hash(`challenge-${challengeId}`),
      new Date(expiresAt),
      consumedAt === null ? null : new Date(consumedAt),
      new Date(createdAt),
    ],
  );
}

async function insertSession(
  client: PoolClient,
  accountId: string,
  deviceId: string,
  sessionId: string,
  issuedAt: string,
  expiresAt: string,
  refreshExpiresAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO cloud_sessions (
       session_id,
       account_id,
       device_id,
       client_version,
       minimum_client_version,
       access_token_hash_sha256,
       refresh_token_hash_sha256,
       issued_at,
       expires_at,
       refresh_expires_at,
       last_seen_at
     ) VALUES ($1, $2, $3, '0.1.0', '0.1.0', $4, $5, $6, $7, $8, $6)`,
    [
      sessionId,
      accountId,
      deviceId,
      hash(`access-${sessionId}`),
      hash(`refresh-${sessionId}`),
      new Date(issuedAt),
      new Date(expiresAt),
      new Date(refreshExpiresAt),
    ],
  );
}

async function expectExistingIds(
  pool: Pool,
  table: string,
  column: string,
  expectedIds: readonly string[],
): Promise<void> {
  if (!/^[a-z0-9_]+$/u.test(table) || !/^[a-z0-9_]+$/u.test(column)) {
    throw new Error("Unsafe maintenance test identifier.");
  }
  const result = await pool.query<{ id: string }>(
    `SELECT ${column}::text AS id
     FROM ${table}
     WHERE ${column} = ANY($1)
     ORDER BY ${column}`,
    [expectedIds],
  );
  expect(result.rows.map((row) => row.id)).toEqual([...expectedIds].sort());
}

async function expectMissingIds(
  pool: Pool,
  table: string,
  column: string,
  ids: readonly string[],
): Promise<void> {
  if (!/^[a-z0-9_]+$/u.test(table) || !/^[a-z0-9_]+$/u.test(column)) {
    throw new Error("Unsafe maintenance test identifier.");
  }
  const result = await pool.query(
    `SELECT 1
     FROM ${table}
     WHERE ${column} = ANY($1)
     LIMIT 1`,
    [ids],
  );
  expect(result.rows).toEqual([]);
}

async function removeMaintenanceFixture(pool: Pool, fixture: MaintenanceFixture): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [fixture.accountId]);
    await client.query("DELETE FROM cloud_projects WHERE tenant_id = $1", [fixture.accountId]);
    await client.query("DELETE FROM cloud_accounts WHERE account_id = $1", [fixture.accountId]);
    await client.query(
      "DELETE FROM cloud_rate_limit_windows WHERE key_hash_sha256 = ANY($1::text[])",
      [fixture.rateLimitHashes],
    );
    await client.query("COMMIT");
  } catch (cause: unknown) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
