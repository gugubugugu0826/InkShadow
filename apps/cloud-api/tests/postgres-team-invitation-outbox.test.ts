import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import type { TeamInvitationOutboxRecord } from "../src/domain/team-invitation-outbox-record.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import {
  insertTeamInvitationOutbox,
  PostgresTeamInvitationOutboxStore,
} from "../src/postgres/team-invitation-outbox-store.js";
import { Aes256GcmTeamInvitationTokenProtector } from "../src/security/team-invitation-token-protector.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import {
  TeamInvitationOutboxWorker,
  type TeamInvitationOutboxDelivery,
  type TeamInvitationOutboxDeliveryPort,
} from "../src/service/team-invitation-outbox-worker.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const uuid = createMonotonicUuidV7Factory();

describePostgres("PostgreSQL team invitation outbox", () => {
  let pool: Pool;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      applicationName: "inkshadow-team-invitation-outbox-test",
      connectionString: databaseUrl,
      maximumConnections: 6,
      requireTls: false,
    });
    await runCloudMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("claims once across concurrent workers, delivers once and cryptoshreds the token", async () => {
    const fixture = await insertFixture(pool);
    const deliveredIds: string[] = [];
    const delivery: TeamInvitationOutboxDeliveryPort = {
      deliver: vi.fn((value: TeamInvitationOutboxDelivery): Promise<void> => {
        deliveredIds.push(value.deliveryId);
        expect(value.invitationToken).toBe(fixture.token);
        return Promise.resolve();
      }),
    };
    const firstWorker = createWorker(
      pool,
      fixture.protector,
      delivery,
      "018f0d7a-3b2c-7abc-8def-000000000011",
      fixture.now,
    );
    const secondWorker = createWorker(
      pool,
      fixture.protector,
      delivery,
      "018f0d7a-3b2c-7abc-8def-000000000012",
      fixture.now,
    );

    const results = await Promise.all([firstWorker.runOnce(), secondWorker.runOnce()]);
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.delivered, 0)).toBe(1);
    expect(deliveredIds).toEqual([fixture.record.deliveryId]);

    const persisted = await pool.query<{
      encryption_key_id: string | null;
      state: string;
      token_auth_tag: Buffer | null;
      token_ciphertext: Buffer | null;
      token_nonce: Buffer | null;
    }>(
      `SELECT
         state,
         token_ciphertext,
         token_nonce,
         token_auth_tag,
         encryption_key_id
       FROM cloud_team_invitation_outbox
       WHERE delivery_id = $1`,
      [fixture.record.deliveryId],
    );
    expect(persisted.rows).toEqual([
      {
        encryption_key_id: null,
        state: "delivered",
        token_auth_tag: null,
        token_ciphertext: null,
        token_nonce: null,
      },
    ]);
  });

  it("retries with the stable delivery id when persistence fails after downstream acceptance", async () => {
    const fixture = await insertFixture(pool);
    const store = new PostgresTeamInvitationOutboxStore(pool);
    const actualExecute = store.executeWithFence.bind(store);
    vi.spyOn(store, "executeWithFence").mockImplementationOnce((options) =>
      actualExecute({
        ...options,
        operation: async (record) => {
          const decision = await options.operation(record);
          if (decision.kind === "delivered") {
            throw new Error("injected post-delivery persistence failure");
          }
          return decision;
        },
      }),
    );
    const deliveryCalls: string[] = [];
    const downstreamAccepted = new Set<string>();
    let downstreamEffects = 0;
    const delivery: TeamInvitationOutboxDeliveryPort = {
      deliver: (value: TeamInvitationOutboxDelivery): Promise<void> => {
        deliveryCalls.push(value.deliveryId);
        if (!downstreamAccepted.has(value.deliveryId)) {
          downstreamEffects += 1;
        }
        downstreamAccepted.add(value.deliveryId);
        return Promise.resolve();
      },
    };
    const firstWorker = new TeamInvitationOutboxWorker({
      batchSize: 1,
      clock: () => fixture.now,
      delivery,
      protector: fixture.protector,
      store,
      workerId: "018f0d7a-3b2c-7abc-8def-000000000015",
    });
    await expect(firstWorker.runOnce()).rejects.toThrow(
      "injected post-delivery persistence failure",
    );

    const retryAt = new Date(fixture.now.getTime() + 30_001);
    const secondWorker = new TeamInvitationOutboxWorker({
      batchSize: 1,
      clock: () => retryAt,
      delivery,
      protector: fixture.protector,
      store,
      workerId: "018f0d7a-3b2c-7abc-8def-000000000016",
    });
    await expect(secondWorker.runOnce()).resolves.toMatchObject({
      claimed: 1,
      delivered: 1,
    });

    expect(deliveryCalls).toEqual([fixture.record.deliveryId, fixture.record.deliveryId]);
    expect(downstreamAccepted).toEqual(new Set([fixture.record.deliveryId]));
    expect(downstreamEffects).toBe(1);
    await expect(
      pool.query<{ state: string; token_ciphertext: Buffer | null }>(
        `SELECT state, token_ciphertext
         FROM cloud_team_invitation_outbox
         WHERE delivery_id = $1`,
        [fixture.record.deliveryId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "delivered", token_ciphertext: null }],
    });
  });

  it("revalidates the invitation after claim and does not deliver when deletion wins", async () => {
    const fixture = await insertFixture(pool);
    const store = new PostgresTeamInvitationOutboxStore(pool);
    const workerId = "018f0d7a-3b2c-7abc-8def-000000000013";
    const claims = await store.claim({
      leaseExpiresAt: new Date(fixture.now.getTime() + 30_000),
      limit: 1,
      now: fixture.now,
      workerId,
    });
    expect(claims).toHaveLength(1);
    const claim = claims[0];
    if (claim === undefined) {
      throw new Error("Expected a claimed invitation outbox row.");
    }

    await pool.query(
      `WITH revoked AS (
         UPDATE cloud_team_invitations
         SET state = 'revoked',
             revoked_at = $2,
             updated_at = $2,
             revision = revision + 1
         WHERE invitation_id = $1
         RETURNING invitation_id
       )
       UPDATE cloud_team_invitation_outbox
       SET state = 'cancelled',
           token_ciphertext = NULL,
           token_nonce = NULL,
           token_auth_tag = NULL,
           encryption_key_id = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error_code = 'INVITATION_REVOKED',
           revision = revision + 1,
           updated_at = $2
       WHERE delivery_id = $1
         AND EXISTS (SELECT 1 FROM revoked)`,
      [fixture.record.deliveryId, new Date(fixture.now.getTime() + 1)],
    );
    const operation = vi.fn(() => Promise.resolve({ kind: "delivered" } as const));
    await expect(
      store.executeWithFence({
        deliveryId: claim.deliveryId,
        expectedRevision: claim.revision,
        now: new Date(fixture.now.getTime() + 2),
        operation,
        workerId,
      }),
    ).resolves.toEqual({ kind: "claim_lost" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("holds an execution fence so cancellation cannot commit during delivery", async () => {
    const fixture = await insertFixture(pool);
    const store = new PostgresTeamInvitationOutboxStore(pool);
    const workerId = "018f0d7a-3b2c-7abc-8def-000000000014";
    const claims = await store.claim({
      leaseExpiresAt: new Date(fixture.now.getTime() + 30_000),
      limit: 1,
      now: fixture.now,
      workerId,
    });
    const claim = claims[0];
    if (claim === undefined) {
      throw new Error("Expected a claimed invitation outbox row.");
    }
    let enterFence: (() => void) | undefined;
    const enteredFence = new Promise<void>((resolve) => {
      enterFence = resolve;
    });
    let releaseFence: (() => void) | undefined;
    const fenceRelease = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const execution = store.executeWithFence({
      deliveryId: claim.deliveryId,
      expectedRevision: claim.revision,
      now: new Date(fixture.now.getTime() + 1),
      operation: async () => {
        enterFence?.();
        await fenceRelease;
        return { kind: "delivered" };
      },
      workerId,
    });
    await enteredFence;

    const cancellationClient = await pool.connect();
    try {
      await cancellationClient.query("BEGIN");
      await cancellationClient.query("SET LOCAL lock_timeout = '100ms'");
      await expect(
        cancellationClient.query(
          `UPDATE cloud_team_invitation_outbox
           SET state = 'cancelled',
               token_ciphertext = NULL,
               token_nonce = NULL,
               token_auth_tag = NULL,
               encryption_key_id = NULL,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error_code = 'INVITATION_REVOKED',
               revision = revision + 1,
               updated_at = $2
           WHERE delivery_id = $1
             AND state = 'leased'`,
          [fixture.record.deliveryId, new Date(fixture.now.getTime() + 2)],
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await cancellationClient.query("ROLLBACK");
    } finally {
      cancellationClient.release();
    }
    releaseFence?.();
    await expect(execution).resolves.toMatchObject({
      decision: { kind: "delivered" },
      kind: "applied",
    });
  });
});

function createWorker(
  pool: Pool,
  protector: Aes256GcmTeamInvitationTokenProtector,
  delivery: TeamInvitationOutboxDeliveryPort,
  workerId: string,
  now: Date,
): TeamInvitationOutboxWorker {
  return new TeamInvitationOutboxWorker({
    batchSize: 1,
    clock: () => now,
    delivery,
    protector,
    store: new PostgresTeamInvitationOutboxStore(pool),
    workerId,
  });
}

async function insertFixture(pool: Pool): Promise<{
  readonly now: Date;
  readonly protector: Aes256GcmTeamInvitationTokenProtector;
  readonly record: TeamInvitationOutboxRecord;
  readonly token: string;
}> {
  const accountId = uuid();
  const teamId = uuid();
  const membershipId = uuid();
  const invitationId = uuid();
  const now = new Date("2026-07-28T01:00:00.000Z");
  const token = Buffer.from(uuid()).toString("base64url");
  const protector = new Aes256GcmTeamInvitationTokenProtector({
    keys: { "outbox-test-key": Buffer.alloc(32, 0x96) },
    primaryKeyId: "outbox-test-key",
  });
  const protectedToken = protector.protect(token, {
    deliveryId: invitationId,
    invitationId,
    teamId,
    tenantId: accountId,
  });
  const record: TeamInvitationOutboxRecord = {
    attemptCount: 0,
    availableAt: now,
    createdAt: now,
    deliveredAt: null,
    deliveryId: invitationId,
    encryptionKeyId: protectedToken.encryptionKeyId,
    invitationId,
    lastErrorCode: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    revision: 1,
    state: "pending",
    teamId,
    tenantId: accountId,
    tokenAuthTag: protectedToken.authTag,
    tokenCiphertext: protectedToken.ciphertext,
    tokenNonce: protectedToken.nonce,
    updatedAt: now,
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
      [accountId, `outbox-${accountId}@example.test`, `scrypt-test-${"x".repeat(32)}`, now],
    );
    await client.query(
      `INSERT INTO cloud_teams (
         tenant_id,
         team_id,
         display_name,
         state,
         revision,
         created_at,
         updated_at
       ) VALUES ($1, $2, 'Outbox Studio', 'active', 1, $3, $3)`,
      [accountId, teamId, now],
    );
    await client.query(
      `INSERT INTO cloud_team_memberships (
         tenant_id,
         team_id,
         membership_id,
         account_id,
         role,
         state,
         revision,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $1, 'owner', 'active', 1, $4, $4)`,
      [accountId, teamId, membershipId, now],
    );
    await client.query(
      `INSERT INTO cloud_team_invitations (
         tenant_id,
         team_id,
         invitation_id,
         invitee_email,
         role,
         state,
         token_hash_sha256,
         revision,
         invited_by_membership_id,
         created_at,
         updated_at,
         expires_at
       ) VALUES (
         $1, $2, $3, $4, 'reviewer', 'pending', $5, 1, $6, $7, $7, $8
       )`,
      [
        accountId,
        teamId,
        invitationId,
        `reviewer-${invitationId}@example.test`,
        invitationId.replaceAll("-", "").padEnd(64, "a"),
        membershipId,
        now,
        new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      ],
    );
    await insertTeamInvitationOutbox(client, record);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { now, protector, record, token };
}
