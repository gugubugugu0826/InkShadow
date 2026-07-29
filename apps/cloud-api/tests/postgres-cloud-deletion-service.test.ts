import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import type { Pool } from "pg";

import { PostgresCloudDeletionStore } from "../src/postgres/deletion-store.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresCloudProjectStore } from "../src/postgres/project-store.js";
import { hashCanonicalJson, hashUtf8 } from "../src/security/canonical-hash.js";
import { ScryptPasswordHasher } from "../src/security/passwords.js";
import { SyncCursorCodec } from "../src/security/sync-cursor.js";
import { SyncSnapshotCursorCodec } from "../src/security/sync-snapshot-cursor.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import { CloudDeletionDomainService } from "../src/service/cloud-deletion-service.js";
import { CloudProjectSyncService } from "../src/service/project-sync-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-07-28T04:00:00.000Z");

describePostgres("PostgreSQL cloud deletion service", () => {
  let pool: Pool;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      connectionString: databaseUrl,
      applicationName: "inkshadow-cloud-deletion-service-test",
      maximumConnections: 8,
      requireTls: false,
    });
    await runCloudMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("atomically freezes account projects, revokes sessions, recovers by confirmation and cancels", async () => {
    const uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    const passwordHasher = new ScryptPasswordHasher({
      cost: 1_024,
      maximumMemoryBytes: 16 * 1024 * 1024,
    });
    const fixture = await insertFixture(pool, uuid, passwordHasher);
    const service = new CloudDeletionDomainService({
      backupRetentionMs: 0,
      clock: () => now,
      passwordHasher,
      store: new PostgresCloudDeletionStore(pool),
      uuid,
    });
    const confirmationId = uuid();
    const idempotencyKey = `account-deletion-${randomBytes(12).toString("hex")}`;
    const firstRequestId = uuid();
    const secondRequestId = uuid();
    const submission = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      confirmationId,
      email: fixture.email,
      expectedRevision: 1,
      password: fixture.password,
    } as const;

    const [first, replay] = await Promise.all([
      service.requestAccountDeletion(fixture.principal, submission, {
        idempotencyKey,
        requestId: firstRequestId,
      }),
      service.requestAccountDeletion(fixture.principal, submission, {
        idempotencyKey,
        requestId: secondRequestId,
      }),
    ]);

    expect(first.deletionRequest.deletionRequestId).toBe(replay.deletionRequest.deletionRequestId);
    expect(new Set([first.requestId, replay.requestId])).toEqual(
      new Set([firstRequestId, secondRequestId]),
    );
    const rotatedPasswordReplay = await service.requestAccountDeletion(
      fixture.principal,
      {
        ...submission,
        password: ["test", "rotated", "deletion", "reauth", "proof"].join("-"),
      },
      {
        idempotencyKey,
        requestId: uuid(),
      },
    );
    expect(rotatedPasswordReplay.deletionRequest.deletionRequestId).toBe(
      first.deletionRequest.deletionRequestId,
    );

    const persistedCredentialBoundary = await pool.query<{
      request_hash_sha256: string;
      response_snapshot: unknown;
      result_digest_sha256: string;
    }>(
      `SELECT request_hash_sha256, result_digest_sha256, response_snapshot
       FROM cloud_idempotency_records
       WHERE actor_account_id = $1
         AND operation_id = 'accountDeletions.request'
         AND result_resource_id = $2`,
      [fixture.principal.accountId, first.deletionRequest.deletionRequestId],
    );
    expect(persistedCredentialBoundary.rows).toHaveLength(1);
    expect(persistedCredentialBoundary.rows[0]?.request_hash_sha256).toBe(
      hashCanonicalJson({
        confirmationId,
        email: fixture.email,
        expectedRevision: 1,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        targetId: fixture.principal.accountId,
        targetKind: "account",
      }),
    );
    expect(persistedCredentialBoundary.rows[0]?.request_hash_sha256).not.toBe(
      hashCanonicalJson({
        request: submission,
        targetId: fixture.principal.accountId,
        targetKind: "account",
      }),
    );
    const deletionAudit = await pool.query<{ redacted_diff: unknown }>(
      `SELECT redacted_diff
       FROM cloud_audit_events
       WHERE tenant_id = $1
         AND action = 'account.deletion_requested'
         AND resource_id = $1`,
      [fixture.principal.accountId],
    );
    const persistedSecurityText = JSON.stringify({
      audit: deletionAudit.rows,
      idempotency: persistedCredentialBoundary.rows,
    });
    expect(persistedSecurityText).not.toContain(fixture.password);
    expect(persistedSecurityText).not.toContain(hashUtf8(fixture.password));
    expect(persistedSecurityText).not.toContain(hashCanonicalJson({ password: fixture.password }));

    const frozen = await pool.query<{
      account_state: string;
      project_count: string;
      revoked_sessions: string;
    }>(
      `SELECT
         account.state AS account_state,
         (
           SELECT COUNT(*)::text
           FROM cloud_projects
           WHERE tenant_id = account.account_id
             AND state = 'deletion_scheduled'
         ) AS project_count,
         (
           SELECT COUNT(*)::text
           FROM cloud_sessions
           WHERE account_id = account.account_id
             AND revoked_at IS NOT NULL
         ) AS revoked_sessions
       FROM cloud_accounts AS account
       WHERE account.account_id = $1`,
      [fixture.principal.accountId],
    );
    expect(frozen.rows[0]).toEqual({
      account_state: "deletion_scheduled",
      project_count: "2",
      revoked_sessions: "1",
    });

    const recovered = await service.lookupAccountDeletion(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        confirmationId,
        email: fixture.email,
        password: fixture.password,
      },
      { requestId: uuid() },
    );
    expect(recovered.deletionRequest.deletionRequestId).toBe(
      first.deletionRequest.deletionRequestId,
    );

    const cursorKey = Buffer.alloc(32, 0x71);
    const projectService = new CloudProjectSyncService({
      clock: () => now,
      cursorCodec: new SyncCursorCodec(cursorKey),
      snapshotCursorCodec: new SyncSnapshotCursorCodec(cursorKey),
      store: new PostgresCloudProjectStore(pool),
      uuid,
    });
    const frozenProjectId = fixture.projectIds[0] ?? "";
    await expect(
      projectService.publishProjectKey(
        fixture.principal,
        frozenProjectId,
        1,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedServerRevision: null,
          version: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            projectId: frozenProjectId,
            keyVersion: 1,
            algorithm: "AES-256-GCM",
            state: "active",
            revision: 1,
            createdAt: now.toISOString(),
            retiredAt: null,
          },
          recoveryEnvelope: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            algorithm: "ARGON2ID-AES256GCM",
            recoveryId: uuid(),
            projectId: frozenProjectId,
            keyVersion: 1,
            kdf: {
              algorithm: "ARGON2ID",
              version: 19,
              memoryKib: 65_536,
              timeCost: 3,
              parallelism: 4,
              outputBytes: 64,
            },
            salt: "s".repeat(22),
            nonce: "n".repeat(16),
            ciphertext: "c".repeat(64),
            verifier: "v".repeat(43),
            createdAt: now.toISOString(),
            confirmedAt: now.toISOString(),
            revokedAt: null,
          },
          deviceEnvelopes: [
            {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
              envelopeId: uuid(),
              projectId: frozenProjectId,
              keyVersion: 1,
              senderDeviceId: fixture.principal.deviceId,
              senderPublicKey: fixture.devicePublicKey,
              senderPublicKeyFingerprint: fixture.devicePublicKeyFingerprint,
              recipientDeviceId: fixture.principal.deviceId,
              recipientPublicKey: fixture.devicePublicKey,
              recipientPublicKeyFingerprint: fixture.devicePublicKeyFingerprint,
              encapsulatedKey: "e".repeat(87),
              ciphertext: "c".repeat(64),
              createdAt: now.toISOString(),
              revokedAt: null,
            },
          ],
        },
        { idempotencyKey: `key-rotation-${randomBytes(12).toString("hex")}`, requestId: uuid() },
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      projectService.getProjectState(fixture.principal, frozenProjectId, null, {
        requestId: uuid(),
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      pool.query<{ key_count: string }>(
        `SELECT COUNT(*)::text AS key_count
         FROM project_key_versions
         WHERE tenant_id = $1
           AND project_id = $2`,
        [fixture.principal.accountId, frozenProjectId],
      ),
    ).resolves.toMatchObject({ rows: [{ key_count: "0" }] });

    const cancellation = await service.cancelAccountDeletion(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deletionRequestId: first.deletionRequest.deletionRequestId,
        email: fixture.email,
        expectedDeletionRevision: first.deletionRequest.revision,
        password: fixture.password,
      },
      {
        idempotencyKey: `account-cancellation-${randomBytes(12).toString("hex")}`,
        requestId: uuid(),
      },
    );
    expect(cancellation.deletionRequest.state).toBe("cancelled");
    const restored = await pool.query<{
      account_state: string;
      project_count: string;
      unrevoked_sessions: string;
    }>(
      `SELECT
         account.state AS account_state,
         (
           SELECT COUNT(*)::text
           FROM cloud_projects
           WHERE tenant_id = account.account_id
             AND state = 'active'
         ) AS project_count,
         (
           SELECT COUNT(*)::text
           FROM cloud_sessions
           WHERE account_id = account.account_id
             AND revoked_at IS NULL
         ) AS unrevoked_sessions
       FROM cloud_accounts AS account
       WHERE account.account_id = $1`,
      [fixture.principal.accountId],
    );
    expect(restored.rows[0]).toEqual({
      account_state: "active",
      project_count: "2",
      unrevoked_sessions: "0",
    });

    const replayAfterCancellation = await service.requestAccountDeletion(
      fixture.principal,
      submission,
      {
        idempotencyKey,
        requestId: uuid(),
      },
    );
    expect({
      ...replayAfterCancellation,
      requestId: first.requestId,
    }).toEqual(first);
    expect(replayAfterCancellation.deletionRequest.state).toBe("grace_period");
  });

  it("blocks a sole team owner before changing account, project or session state", async () => {
    const uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    const passwordHasher = new ScryptPasswordHasher({
      cost: 1_024,
      maximumMemoryBytes: 16 * 1024 * 1024,
    });
    const fixture = await insertFixture(pool, uuid, passwordHasher);
    await insertSoleOwnerTeam(pool, fixture.principal.accountId, uuid);
    const service = new CloudDeletionDomainService({
      clock: () => now,
      passwordHasher,
      store: new PostgresCloudDeletionStore(pool),
      uuid,
    });
    const requestId = uuid();

    await expect(
      service.requestAccountDeletion(
        fixture.principal,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          confirmationId: uuid(),
          email: fixture.email,
          expectedRevision: 1,
          password: fixture.password,
        },
        {
          idempotencyKey: `account-owner-guard-${randomBytes(12).toString("hex")}`,
          requestId,
        },
      ),
    ).rejects.toMatchObject({
      code: "ACCESS_FORBIDDEN",
      httpStatus: 403,
      message:
        "Resolve team ownership and collaborative project access assignments before scheduling account deletion.",
    });

    const unchanged = await pool.query<{
      account_state: string;
      audit_count: string;
      deletion_count: string;
      project_count: string;
      unrevoked_sessions: string;
    }>(
      `SELECT
         account.state AS account_state,
         (
           SELECT COUNT(*)::text
           FROM cloud_projects
           WHERE tenant_id = account.account_id
             AND state = 'active'
         ) AS project_count,
         (
           SELECT COUNT(*)::text
           FROM cloud_sessions
           WHERE account_id = account.account_id
             AND revoked_at IS NULL
         ) AS unrevoked_sessions,
         (
           SELECT COUNT(*)::text
           FROM cloud_deletion_jobs
           WHERE tenant_id = account.account_id
             AND target_kind = 'account'
             AND target_id = account.account_id
         ) AS deletion_count,
         (
           SELECT COUNT(*)::text
           FROM cloud_audit_events
           WHERE tenant_id = account.account_id
             AND request_id = $2
             AND action = 'account.deletion_denied'
             AND result = 'denied'
             AND redacted_diff = '{"reason":"ownership_transfer_required"}'::jsonb
         ) AS audit_count
       FROM cloud_accounts AS account
       WHERE account.account_id = $1`,
      [fixture.principal.accountId, requestId],
    );
    expect(unchanged.rows[0]).toEqual({
      account_state: "active",
      audit_count: "1",
      deletion_count: "0",
      project_count: "2",
      unrevoked_sessions: "1",
    });
  });
});

async function insertSoleOwnerTeam(
  pool: Pool,
  accountId: string,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
): Promise<void> {
  const teamId = uuid();
  const membershipId = uuid();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT
         set_config('inkshadow.account_id', $1, true),
         set_config('inkshadow.tenant_id', $1, true),
         set_config('inkshadow.team_id', $2, true)`,
      [accountId, teamId],
    );
    await client.query(
      `INSERT INTO cloud_teams (
         tenant_id, team_id, display_name, state, created_at, updated_at
       ) VALUES ($1, $2, 'Deletion owner guard', 'active', $3, $3)`,
      [accountId, teamId, now],
    );
    await client.query(
      `INSERT INTO cloud_team_memberships (
         tenant_id, team_id, membership_id, account_id, role,
         state, created_at, updated_at
       ) VALUES ($1, $2, $3, $1, 'owner', 'active', $4, $4)`,
      [accountId, teamId, membershipId, now],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertFixture(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  passwordHasher: ScryptPasswordHasher,
): Promise<{
  readonly email: string;
  readonly password: string;
  readonly devicePublicKey: string;
  readonly devicePublicKeyFingerprint: string;
  readonly principal: {
    readonly accountId: string;
    readonly deviceId: string;
    readonly sessionId: string;
  };
  readonly projectIds: readonly string[];
}> {
  const accountId = uuid();
  const deviceId = uuid();
  const sessionId = uuid();
  const projectIds = [uuid(), uuid()] as const;
  const password = ["test", "valid", "deletion", "reauth", "fixture"].join("-");
  const email = `deletion-${randomBytes(10).toString("hex")}@example.test`;
  const passwordHash = await passwordHasher.hash(password);
  const devicePublicKey = "A".repeat(87);
  const devicePublicKeyFingerprint = hash(`device-${deviceId}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO cloud_accounts (
         account_id, email_canonical, password_hash, state,
         verified_at, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
      [accountId, email, passwordHash, now],
    );
    await client.query(
      `INSERT INTO registered_devices (
         device_id, account_id, display_name, algorithm, public_key,
         public_key_fingerprint, client_version, state, created_at, updated_at
       ) VALUES (
         $1, $2, 'Deletion test device', 'DHKEM-P256-HKDF-SHA256',
         $3, $4, '0.1.0', 'trusted', $5, $5
       )`,
      [deviceId, accountId, devicePublicKey, devicePublicKeyFingerprint, now],
    );
    await client.query(
      `INSERT INTO cloud_sessions (
         session_id, account_id, device_id, client_version, minimum_client_version,
         access_token_hash_sha256, refresh_token_hash_sha256, issued_at,
         expires_at, refresh_expires_at, last_seen_at
       ) VALUES (
         $1, $2, $3, '0.1.0', '0.1.0', $4, $5, $6, $7, $8, $6
       )`,
      [
        sessionId,
        accountId,
        deviceId,
        hash(`access-${sessionId}`),
        hash(`refresh-${sessionId}`),
        now,
        new Date(now.getTime() + 60_000),
        new Date(now.getTime() + 120_000),
      ],
    );
    await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [accountId]);
    for (const projectId of projectIds) {
      await client.query(
        `INSERT INTO cloud_projects (
           tenant_id, project_id, owner_account_id, state, created_at, updated_at
         ) VALUES ($1, $2, $1, 'active', $3, $3)`,
        [accountId, projectId, now],
      );
      await client.query(
        `INSERT INTO cloud_project_access (
           tenant_id, project_id, account_id, role,
           can_manage_keys, can_sync, created_at
         ) VALUES ($1, $2, $1, 'owner', true, true, $3)`,
        [accountId, projectId, now],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    email,
    password,
    devicePublicKey,
    devicePublicKeyFingerprint,
    principal: { accountId, deviceId, sessionId },
    projectIds,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
