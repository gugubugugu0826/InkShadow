import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CloudTeamProjectCurrentKeyResponseSchema,
  CloudTeamProjectKeyEligibleRecipientListResponseSchema,
  CloudTeamProjectKeyEnvelopeResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudTeamProjectKeyEnvelopePublishRequest,
} from "@inkshadow/contracts";
import type { Pool, PoolClient } from "pg";

import { createCloudApiServer } from "../src/http/server.js";
import { PostgresCloudDeletionStore } from "../src/postgres/deletion-store.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresCloudTeamStore } from "../src/postgres/team-store.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import type { CloudIdentityService, CloudPrincipal } from "../src/service/identity-service.js";
import type { CloudProjectSyncService } from "../src/service/project-sync-service.js";
import { CloudTeamProjectKeyService } from "../src/service/team-project-key-service.js";
import {
  CloudTeamService,
  UnavailableTeamInvitationTokenProtector,
} from "../src/service/team-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-07-28T07:00:00.000Z");

describePostgres("PostgreSQL Studio team project-key envelopes", () => {
  let pool: Pool;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;
  let keyService: CloudTeamProjectKeyService;
  let teamService: CloudTeamService;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      applicationName: "inkshadow-team-project-key-test",
      connectionString: databaseUrl,
      maximumConnections: 16,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    const store = new PostgresCloudTeamStore(pool);
    keyService = new CloudTeamProjectKeyService({
      clock: () => now,
      store,
      uuid,
    });
    teamService = new CloudTeamService({
      clock: () => now,
      invitationTokenProtector: new UnavailableTeamInvitationTokenProtector(),
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0xd1)),
      store,
      uuid,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("discovers only eligible devices, publishes once under concurrency and returns only the current-device envelope", async () => {
    const fixture = await seedFixture(pool, uuid, "concurrent");
    const recipients = await keyService.listEligibleRecipients(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      1,
      read(uuid()),
    );
    expect(recipients.recipients).toEqual([
      expect.objectContaining({
        assignmentId: fixture.assignmentId,
        assignmentRevision: 1,
        deviceId: fixture.recipient.deviceId,
        membershipId: fixture.recipientMembershipId,
        membershipRevision: 1,
        publicKey: fixture.recipient.publicKey,
        publicKeyFingerprint: fixture.recipient.publicKeyFingerprint,
        recipientKind: "active_assigned_team_member_device",
      }),
    ]);
    expect(JSON.stringify(recipients)).not.toMatch(
      /ciphertext|envelope|invite|recovery|accountId|displayName/iu,
    );

    const request = envelopeRequest(fixture, uuid());
    const [first, replay] = await Promise.all([
      keyService.publishEnvelope(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        request,
        mutation(uuid(), "team-key-concurrent-idempotency-0001"),
      ),
      keyService.publishEnvelope(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        request,
        mutation(uuid(), "team-key-concurrent-idempotency-0001"),
      ),
    ]);
    expect(replay.envelope).toEqual(first.envelope);
    expect(replay.requestId).not.toBe(first.requestId);

    const current = await keyService.getCurrentDeviceEnvelope(
      fixture.recipient,
      fixture.teamId,
      fixture.projectId,
      1,
      read(uuid()),
    );
    expect(current.envelope).toEqual(first.envelope);
    expect(Array.isArray(current.envelope)).toBe(false);
    expect(JSON.stringify(current)).not.toMatch(/recovery|invitationToken|password/iu);

    const persisted = await pool.query<{
      audit_count: string;
      envelope_count: string;
      idempotency_count: string;
    }>(
      `SELECT
         (
           SELECT count(*)::text
           FROM cloud_team_project_key_envelopes
           WHERE envelope_id = $1
         ) AS envelope_count,
         (
           SELECT count(*)::text
           FROM cloud_idempotency_records
           WHERE operation_id = 'teamProjectKeyEnvelopes.publish'
             AND result_resource_id = $1
         ) AS idempotency_count,
         (
           SELECT count(*)::text
           FROM cloud_team_audit_events
           WHERE resource_type = 'project_key_envelope'
             AND resource_id = $1
         ) AS audit_count`,
      [request.envelopeId],
    );
    expect(persisted.rows).toEqual([
      { audit_count: "1", envelope_count: "1", idempotency_count: "1" },
    ]);
    const audit = await pool.query<{ redacted_diff: string }>(
      `SELECT redacted_diff::text
       FROM cloud_team_audit_events
       WHERE resource_id = $1`,
      [request.envelopeId],
    );
    expect(audit.rows[0]?.redacted_diff).not.toContain(request.ciphertext);
    expect(audit.rows[0]?.redacted_diff).not.toContain(request.encapsulatedKey);
    expect(audit.rows[0]?.redacted_diff).not.toContain(request.recipientPublicKey);

    await pool.query(
      `UPDATE cloud_idempotency_records
       SET response_snapshot = jsonb_set(
         response_snapshot,
         '{requestId}',
         to_jsonb($2::text),
         false
       )
       WHERE operation_id = 'teamProjectKeyEnvelopes.publish'
         AND result_resource_id = $1`,
      [request.envelopeId, uuid()],
    );
    await expect(
      keyService.publishEnvelope(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        request,
        mutation(uuid(), "team-key-concurrent-idempotency-0001"),
      ),
    ).rejects.toThrow("team project-key idempotency record is internally inconsistent");
  });

  it("discovers only authoritative current-key metadata for an exact assigned reader", async () => {
    const fixture = await seedFixture(pool, uuid, "current-metadata");
    const withoutEnvelope = await keyService.getCurrentKeyMetadata(
      fixture.recipient,
      fixture.teamId,
      fixture.projectId,
      read(uuid()),
    );
    expect(CloudTeamProjectCurrentKeyResponseSchema.parse(withoutEnvelope)).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: withoutEnvelope.requestId,
      teamId: fixture.teamId,
      projectId: fixture.projectId,
      keyVersion: 1,
      state: "active",
      serverRevision: 1,
      updatedAt: now.toISOString(),
      currentDeviceEnvelopeAvailable: false,
    });
    expect(Object.keys(withoutEnvelope).sort()).toEqual([
      "currentDeviceEnvelopeAvailable",
      "keyVersion",
      "projectId",
      "requestId",
      "schemaVersion",
      "serverRevision",
      "state",
      "teamId",
      "updatedAt",
    ]);
    expect(JSON.stringify(withoutEnvelope)).not.toMatch(
      /ciphertext|encapsulated|publicKey|privateKey|recovery|membership|assignment|recipient|sender|accountId/iu,
    );

    await expect(
      keyService.getCurrentKeyMetadata(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const unassignedAdmin = await seedPrincipal(pool, uuid, "current-metadata-admin", "D");
    await setTeamScope(pool, fixture.owner, fixture.teamId, async (client) => {
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
         ) VALUES ($1, $2, $3, $4, 'admin', 'active', 1, $5, $5)`,
        [fixture.owner.accountId, fixture.teamId, uuid(), unassignedAdmin.accountId, now],
      );
    });
    await expect(
      keyService.getCurrentKeyMetadata(
        unassignedAdmin,
        fixture.teamId,
        fixture.projectId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    await keyService.publishEnvelope(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      1,
      envelopeRequest(fixture, uuid()),
      mutation(uuid(), "team-key-current-metadata-publish-0001"),
    );
    await expect(
      keyService.getCurrentKeyMetadata(
        fixture.recipient,
        fixture.teamId,
        fixture.projectId,
        read(uuid()),
      ),
    ).resolves.toMatchObject({
      currentDeviceEnvelopeAvailable: true,
      keyVersion: 1,
      projectId: fixture.projectId,
      state: "active",
      teamId: fixture.teamId,
    });
  });

  it("hides cross-tenant identifiers and rejects revoked assignment, membership and device state", async () => {
    const target = await seedFixture(pool, uuid, "current-scope-target");
    const otherTenant = await seedFixture(pool, uuid, "current-scope-other");
    for (const [principal, teamId, projectId] of [
      [otherTenant.recipient, target.teamId, target.projectId],
      [otherTenant.recipient, otherTenant.teamId, target.projectId],
      [target.recipient, target.teamId, uuid()],
    ] as const) {
      await expect(
        keyService.getCurrentKeyMetadata(principal, teamId, projectId, read(uuid())),
      ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    }

    await teamService.setProjectAssignment(
      target.owner,
      target.teamId,
      target.projectId,
      target.recipientMembershipId,
      {
        desiredState: "revoked",
        expectedRevision: 1,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
      },
      mutation(uuid(), "team-key-current-assignment-revoke-0001"),
    );
    await expect(
      keyService.getCurrentKeyMetadata(
        target.recipient,
        target.teamId,
        target.projectId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const noProjectRead = await seedFixture(pool, uuid, "current-no-project-read");
    await teamService.changeMemberRole(
      noProjectRead.owner,
      noProjectRead.teamId,
      noProjectRead.recipientMembershipId,
      {
        expectedRevision: 1,
        role: "finance_admin",
        schemaVersion: CONTRACT_SCHEMA_VERSION,
      },
      mutation(uuid(), "team-key-current-finance-role-0001"),
    );
    await expect(
      keyService.getCurrentKeyMetadata(
        noProjectRead.recipient,
        noProjectRead.teamId,
        noProjectRead.projectId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const revokedMembership = await seedFixture(pool, uuid, "current-revoked-membership");
    await teamService.revokeMembership(
      revokedMembership.owner,
      revokedMembership.teamId,
      revokedMembership.recipientMembershipId,
      {
        expectedRevision: 1,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
      },
      mutation(uuid(), "team-key-current-membership-revoke-0001"),
    );
    await expect(
      keyService.getCurrentKeyMetadata(
        revokedMembership.recipient,
        revokedMembership.teamId,
        revokedMembership.projectId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    const revokedDevice = await seedFixture(pool, uuid, "current-revoked-device");
    await pool.query(
      `UPDATE registered_devices
       SET state = 'revoked',
           revision = revision + 1,
           revoked_at = $2,
           updated_at = $2
       WHERE device_id = $1`,
      [revokedDevice.recipient.deviceId, new Date(now.getTime() + 1_000)],
    );
    await expect(
      keyService.getCurrentKeyMetadata(
        revokedDevice.recipient,
        revokedDevice.teamId,
        revokedDevice.projectId,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_EXPIRED" });
  });

  it("invalidates on assignment and role revisions, while stale idempotent replays cannot revive access", async () => {
    const fixture = await seedFixture(pool, uuid, "assignment");
    const firstRequest = envelopeRequest(fixture, uuid());
    await keyService.publishEnvelope(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      1,
      firstRequest,
      mutation(uuid(), "team-key-assignment-publish-0001"),
    );

    const revoked = await teamService.setProjectAssignment(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      fixture.recipientMembershipId,
      {
        desiredState: "revoked",
        expectedRevision: 1,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
      },
      mutation(uuid(), "team-key-assignment-revoke-0001"),
    );
    expect(revoked.assignment.revision).toBe(2);
    await expect(
      keyService.getCurrentDeviceEnvelope(
        fixture.recipient,
        fixture.teamId,
        fixture.projectId,
        1,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      keyService.publishEnvelope(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        firstRequest,
        mutation(uuid(), "team-key-assignment-publish-0001"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const reactivated = await teamService.setProjectAssignment(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      fixture.recipientMembershipId,
      {
        desiredState: "active",
        expectedRevision: revoked.assignment.revision,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
      },
      mutation(uuid(), "team-key-assignment-reactivate-0001"),
    );
    const replacementRequest = envelopeRequest(fixture, uuid(), {
      assignmentRevision: reactivated.assignment.revision,
    });
    await keyService.publishEnvelope(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      1,
      replacementRequest,
      mutation(uuid(), "team-key-assignment-publish-0002"),
    );

    const roleChange = await teamService.changeMemberRole(
      fixture.owner,
      fixture.teamId,
      fixture.recipientMembershipId,
      {
        expectedRevision: 1,
        role: "finance_admin",
        schemaVersion: CONTRACT_SCHEMA_VERSION,
      },
      mutation(uuid(), "team-key-recipient-finance-0001"),
    );
    expect(roleChange.membership.revision).toBe(2);
    await expect(
      keyService.getCurrentDeviceEnvelope(
        fixture.recipient,
        fixture.teamId,
        fixture.projectId,
        1,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    await expect(
      keyService.publishEnvelope(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        replacementRequest,
        mutation(uuid(), "team-key-assignment-publish-0002"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });

    const invalidated = await pool.query<{
      invalidation_reason: string;
      invalidated_at: Date;
    }>(
      `SELECT invalidation_reason, invalidated_at
       FROM cloud_team_project_key_envelopes
       WHERE envelope_id = ANY($1::uuid[])
       ORDER BY created_at, envelope_id`,
      [[firstRequest.envelopeId, replacementRequest.envelopeId]],
    );
    expect(invalidated.rows.map((row) => row.invalidation_reason).sort()).toEqual([
      "assignment_changed",
      "membership_changed",
    ]);
    const personalEnvelope = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at
       FROM device_project_key_envelopes
       WHERE tenant_id = $1
         AND project_id = $2
         AND key_version = 1
         AND recipient_device_id = $3`,
      [fixture.owner.accountId, fixture.projectId, fixture.owner.deviceId],
    );
    expect(personalEnvelope.rows).toEqual([{ revoked_at: null }]);
  });

  it("invalidates the recipient envelope on trusted-device revocation without touching the owner's personal envelope", async () => {
    const fixture = await seedFixture(pool, uuid, "device");
    const request = envelopeRequest(fixture, uuid());
    await keyService.publishEnvelope(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      1,
      request,
      mutation(uuid(), "team-key-device-publish-0001"),
    );
    await pool.query(
      `UPDATE registered_devices
       SET state = 'revoked',
           revision = revision + 1,
           revoked_at = $2,
           updated_at = $2
       WHERE device_id = $1`,
      [fixture.recipient.deviceId, new Date(now.getTime() + 1_000)],
    );
    await expect(
      keyService.publishEnvelope(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        request,
        mutation(uuid(), "team-key-device-publish-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    const envelope = await pool.query<{
      invalidation_reason: string;
      invalidated_at: Date;
    }>(
      `SELECT invalidation_reason, invalidated_at
       FROM cloud_team_project_key_envelopes
       WHERE envelope_id = $1`,
      [request.envelopeId],
    );
    expect(envelope.rows[0]?.invalidation_reason).toBe("recipient_device_changed");
    const personalCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text
       FROM device_project_key_envelopes
       WHERE tenant_id = $1
         AND project_id = $2
         AND recipient_device_id = $3
         AND revoked_at IS NULL`,
      [fixture.owner.accountId, fixture.projectId, fixture.owner.deviceId],
    );
    expect(personalCount.rows).toEqual([{ count: "1" }]);
  });

  it("fails closed for key managers, recipient role, device identity and immutable ciphertext", async () => {
    const fixture = await seedFixture(pool, uuid, "fail-closed");
    await setTenant(pool, fixture.owner.accountId, async (client) => {
      await client.query(
        `UPDATE cloud_project_access
         SET can_manage_keys = false
         WHERE tenant_id = $1
           AND project_id = $2
           AND account_id = $1`,
        [fixture.owner.accountId, fixture.projectId],
      );
    });
    await expect(
      keyService.listEligibleRecipients(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        read(uuid()),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    await setTenant(pool, fixture.owner.accountId, async (client) => {
      await client.query(
        `UPDATE cloud_project_access
         SET can_manage_keys = true
         WHERE tenant_id = $1
           AND project_id = $2
           AND account_id = $1`,
        [fixture.owner.accountId, fixture.projectId],
      );
    });

    const wrongPublicKey = envelopeRequest(fixture, uuid(), {
      recipientPublicKey: "Z".repeat(87),
    });
    await expect(
      keyService.publishEnvelope(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        wrongPublicKey,
        mutation(uuid(), "team-key-wrong-public-key-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const outsider = await seedPrincipal(pool, uuid, "fail-closed-outsider", "D");
    const crossAccountDevice = envelopeRequest(fixture, uuid(), {
      recipientDeviceId: outsider.deviceId,
      recipientPublicKey: outsider.publicKey,
      recipientPublicKeyFingerprint: outsider.publicKeyFingerprint,
    });
    await expect(
      keyService.publishEnvelope(
        fixture.owner,
        fixture.teamId,
        fixture.projectId,
        1,
        crossAccountDevice,
        mutation(uuid(), "team-key-cross-account-device-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const request = envelopeRequest(fixture, uuid());
    await keyService.publishEnvelope(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      1,
      request,
      mutation(uuid(), "team-key-immutable-publish-0001"),
    );
    await setTeamScope(pool, fixture.owner, fixture.teamId, async (client) => {
      await expect(
        client.query(
          `UPDATE cloud_team_project_key_envelopes
           SET ciphertext = $2
           WHERE envelope_id = $1`,
          [request.envelopeId, "Z".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    });

    const schemaBoundary = await pool.query<{
      relforcerowsecurity: boolean;
      relrowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = 'cloud_team_project_key_envelopes'`,
    );
    expect(schemaBoundary.rows).toEqual([{ relforcerowsecurity: true, relrowsecurity: true }]);
    const forbiddenColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'cloud_team_project_key_envelopes'
         AND column_name = ANY($1::text[])`,
      [["dek", "private_key", "plaintext", "recovery_code", "recovery_envelope"]],
    );
    expect(forbiddenColumns.rows).toEqual([]);
  });

  it("serves the four strict HTTP routes without exposing another device or recovery material", async () => {
    const fixture = await seedFixture(pool, uuid, "http");
    const ownerToken = `owner.${"A".repeat(43)}`;
    const recipientToken = `recipient.${"B".repeat(43)}`;
    const principals = new Map<string, CloudPrincipal>([
      [ownerToken, fixture.owner],
      [recipientToken, fixture.recipient],
    ]);
    const identityService = {
      authenticateAccessToken: (token: string) => {
        const principal = principals.get(token);
        return principal === undefined
          ? Promise.reject(new Error("unknown test token"))
          : Promise.resolve(principal);
      },
    } as unknown as CloudIdentityService;
    const server = createCloudApiServer({
      clock: () => now,
      identityService,
      projectSyncService: {} as CloudProjectSyncService,
      teamProjectKeyService: keyService,
      teamService,
      uuid,
    });
    try {
      const currentMetadataRoute = `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}/keys/current`;
      const beforePublish = await server.inject({
        headers: authorizationHeader(recipientToken),
        method: "GET",
        url: currentMetadataRoute,
      });
      expect(beforePublish.statusCode).toBe(200);
      expect(CloudTeamProjectCurrentKeyResponseSchema.parse(beforePublish.json())).toMatchObject({
        currentDeviceEnvelopeAvailable: false,
        keyVersion: 1,
        projectId: fixture.projectId,
        teamId: fixture.teamId,
      });
      expect(beforePublish.body).not.toMatch(
        /ciphertext|encapsulated|publicKey|privateKey|recovery|membership|assignment|recipient|sender|accountId/iu,
      );

      const route = `/v1/teams/${fixture.teamId}/projects/${fixture.projectId}` + `/keys/1`;
      const eligibleResponse = await server.inject({
        headers: authorizationHeader(ownerToken),
        method: "GET",
        url: `${route}/recipients`,
      });
      expect(eligibleResponse.statusCode).toBe(200);
      const eligible = CloudTeamProjectKeyEligibleRecipientListResponseSchema.parse(
        eligibleResponse.json(),
      );
      expect(eligible.recipients.map((recipient) => recipient.deviceId)).toEqual([
        fixture.recipient.deviceId,
      ]);

      const request = envelopeRequest(fixture, uuid());
      const publishResponse = await server.inject({
        headers: mutationHeaders(ownerToken, "team-key-http-publish-0001"),
        method: "POST",
        payload: request,
        url: `${route}/envelopes`,
      });
      expect(publishResponse.statusCode).toBe(201);
      const published = CloudTeamProjectKeyEnvelopeResponseSchema.parse(publishResponse.json());

      const currentResponse = await server.inject({
        headers: authorizationHeader(recipientToken),
        method: "GET",
        url: `${route}/envelopes/current-device`,
      });
      expect(currentResponse.statusCode).toBe(200);
      expect(
        CloudTeamProjectKeyEnvelopeResponseSchema.parse(currentResponse.json()).envelope,
      ).toEqual(published.envelope);
      expect(currentResponse.body).not.toMatch(/recovery|invite|password/iu);

      const afterPublish = await server.inject({
        headers: authorizationHeader(recipientToken),
        method: "GET",
        url: currentMetadataRoute,
      });
      expect(afterPublish.statusCode).toBe(200);
      expect(CloudTeamProjectCurrentKeyResponseSchema.parse(afterPublish.json())).toMatchObject({
        currentDeviceEnvelopeAvailable: true,
        keyVersion: 1,
      });

      const strictResponse = await server.inject({
        headers: mutationHeaders(ownerToken, "team-key-http-strict-0001"),
        method: "POST",
        payload: { ...envelopeRequest(fixture, uuid()), unexpected: true },
        url: `${route}/envelopes`,
      });
      expect(strictResponse.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("uses FORCE RLS to expose ciphertext only to its publisher or exact recipient device", async () => {
    const fixture = await seedFixture(pool, uuid, "rls");
    const request = envelopeRequest(fixture, uuid());
    await keyService.publishEnvelope(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      1,
      request,
      mutation(uuid(), "team-key-rls-publish-0001"),
    );
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_roles
          WHERE rolname = 'inkshadow_team_envelope_rls_test'
        ) THEN
          CREATE ROLE inkshadow_team_envelope_rls_test
            LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await pool.query("ALTER ROLE inkshadow_team_envelope_rls_test LOGIN NOSUPERUSER NOBYPASSRLS");
    await pool.query("GRANT USAGE ON SCHEMA public TO inkshadow_team_envelope_rls_test");
    await pool.query(
      `GRANT SELECT, UPDATE
         ON cloud_team_project_key_envelopes
         TO inkshadow_team_envelope_rls_test`,
    );
    await pool.query(
      `GRANT EXECUTE
         ON FUNCTION inkshadow_has_active_team_membership(UUID, UUID)
         TO inkshadow_team_envelope_rls_test`,
    );
    await pool.query(
      `REVOKE EXECUTE
         ON FUNCTION inkshadow_active_team_project_key_envelope_exists(
           UUID,
           UUID,
           UUID,
           INTEGER,
           UUID
         )
         FROM inkshadow_team_envelope_rls_test`,
    );

    const limitedUrl = new URL(databaseUrl ?? "");
    limitedUrl.username = "inkshadow_team_envelope_rls_test";
    limitedUrl.password = "";
    const limitedPool = createCloudPostgresPool({
      applicationName: "inkshadow-team-envelope-rls-test",
      connectionString: limitedUrl.toString(),
      maximumConnections: 1,
      requireTls: false,
    });
    const client = await limitedPool.connect();
    try {
      expect(
        (await client.query("SELECT envelope_id FROM cloud_team_project_key_envelopes")).rows,
      ).toEqual([]);
      await client.query("BEGIN");
      await client.query(
        `SELECT
           set_config('inkshadow.account_id', $1, true),
           set_config('inkshadow.tenant_id', $2, true),
           set_config('inkshadow.team_id', $3, true),
           set_config('inkshadow.device_id', $4, true)`,
        [
          fixture.recipient.accountId,
          fixture.owner.accountId,
          fixture.teamId,
          fixture.recipient.deviceId,
        ],
      );
      expect(
        (
          await client.query(
            "SELECT envelope_id FROM cloud_team_project_key_envelopes ORDER BY envelope_id",
          )
        ).rows,
      ).toEqual([{ envelope_id: request.envelopeId }]);
      await client.query("SELECT set_config('inkshadow.device_id', $1, true)", [uuid()]);
      expect(
        (await client.query("SELECT envelope_id FROM cloud_team_project_key_envelopes")).rows,
      ).toEqual([]);
      await client.query("SELECT set_config('inkshadow.device_id', $1, true)", [
        fixture.recipient.deviceId,
      ]);
      await expect(
        client.query(
          `UPDATE cloud_team_project_key_envelopes
           SET invalidated_at = $2,
               invalidation_reason = 'membership_changed',
               server_revision = server_revision + 1
           WHERE envelope_id = $1`,
          [request.envelopeId, new Date(now.getTime() + 1_000)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");

      await expect(
        client.query(
          `SELECT inkshadow_active_team_project_key_envelope_exists(
             $1,
             $2,
             $3,
             1,
             $4
           )`,
          [fixture.owner.accountId, fixture.teamId, fixture.projectId, fixture.recipient.deviceId],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK").catch(() => {
        // A successful rollback already closed the scoped transaction.
      });
      client.release();
      await limitedPool.end();
    }
  });

  it("counts and purges team envelopes through the bounded deletion boundary", async () => {
    const fixture = await seedFixture(pool, uuid, "deletion");
    const request = envelopeRequest(fixture, uuid());
    await keyService.publishEnvelope(
      fixture.owner,
      fixture.teamId,
      fixture.projectId,
      1,
      request,
      mutation(uuid(), "team-key-deletion-publish-0001"),
    );
    const deletionStore = new PostgresCloudDeletionStore(pool);
    const impact = await deletionStore.transaction(async (transaction) => {
      await transaction.setTenant(fixture.owner.accountId);
      return transaction.calculateProjectImpact(fixture.owner.accountId, fixture.projectId);
    });
    expect(impact.keyEnvelopeCount).toBe(2);
    const associatedIdempotency = await pool.query<{ idempotency_count: string }>(
      `SELECT COUNT(*)::text AS idempotency_count
       FROM cloud_idempotency_records AS idempotency
       WHERE idempotency.result_kind = 'team_project_key_envelope'
         AND inkshadow_team_project_key_envelope_belongs_to_project(
           $1,
           $2,
           idempotency.result_resource_id
         )`,
      [fixture.owner.accountId, fixture.projectId],
    );
    expect(associatedIdempotency.rows).toEqual([{ idempotency_count: "1" }]);

    const purge = await pool.query<{ deleted_count: string }>(
      `SELECT inkshadow_purge_team_project_key_envelopes_batch($1, $2, 1)::text
         AS deleted_count`,
      [fixture.owner.accountId, fixture.projectId],
    );
    expect(purge.rows).toEqual([{ deleted_count: "1" }]);
    const remaining = await pool.query<{ envelope_count: string }>(
      `SELECT inkshadow_count_team_project_key_envelopes($1, $2)::text
         AS envelope_count`,
      [fixture.owner.accountId, fixture.projectId],
    );
    expect(remaining.rows).toEqual([{ envelope_count: "0" }]);
    const personal = await pool.query<{ envelope_count: string }>(
      `SELECT COUNT(*)::text AS envelope_count
       FROM device_project_key_envelopes
       WHERE tenant_id = $1
         AND project_id = $2
         AND revoked_at IS NULL`,
      [fixture.owner.accountId, fixture.projectId],
    );
    expect(personal.rows).toEqual([{ envelope_count: "1" }]);
  });
});

interface SeededPrincipal extends CloudPrincipal {
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
}

interface Fixture {
  readonly assignmentId: string;
  readonly owner: SeededPrincipal;
  readonly ownerMembershipId: string;
  readonly projectId: string;
  readonly recipient: SeededPrincipal;
  readonly recipientMembershipId: string;
  readonly teamId: string;
}

async function seedFixture(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  label: string,
): Promise<Fixture> {
  const owner = await seedPrincipal(pool, uuid, `${label}-owner`, "A");
  const recipient = await seedPrincipal(pool, uuid, `${label}-recipient`, "B");
  const projectId = uuid();
  const recoveryId = uuid();
  const personalEnvelopeId = uuid();
  await setTenant(pool, owner.accountId, async (client) => {
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
      [owner.accountId, projectId, now],
    );
    await client.query(
      `INSERT INTO cloud_project_access (
         tenant_id,
         project_id,
         account_id,
         role,
         can_manage_keys,
         can_sync,
         revision,
         created_at
       ) VALUES ($1, $2, $1, 'owner', true, true, 1, $3)`,
      [owner.accountId, projectId, now],
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
         updated_at,
         publication_request_sha256,
         publication_published_at
       ) VALUES (
         $1, $2, 1, 1, 'AES-256-GCM', 'active', 1, $3,
         'ARGON2ID-AES256GCM', $4, $5, $6, $7, $8, $8, $8, $8, $9, $8
       )`,
      [
        owner.accountId,
        projectId,
        recoveryId,
        "S".repeat(22),
        "N".repeat(16),
        "R".repeat(64),
        "V".repeat(43),
        now,
        sha256(`publication-${projectId}`),
      ],
    );
    await client.query(
      `INSERT INTO device_project_key_envelopes (
         tenant_id,
         project_id,
         key_version,
         envelope_id,
         algorithm,
         sender_device_id,
         sender_public_key,
         sender_public_key_fingerprint,
         recipient_device_id,
         recipient_public_key,
         recipient_public_key_fingerprint,
         encapsulated_key,
         ciphertext,
         created_at
       ) VALUES (
         $1, $2, 1, $3, 'HPKE-AUTH-P256-HKDF-SHA256-AES128GCM',
         $4, $5, $6, $4, $5, $6, $7, $8, $9
       )`,
      [
        owner.accountId,
        projectId,
        personalEnvelopeId,
        owner.deviceId,
        owner.publicKey,
        owner.publicKeyFingerprint,
        "E".repeat(87),
        "C".repeat(64),
        now,
      ],
    );
  });

  const teamId = uuid();
  const ownerMembershipId = uuid();
  const recipientMembershipId = uuid();
  const assignmentId = uuid();
  await setTeamScope(pool, owner, teamId, async (client) => {
    await client.query(
      `INSERT INTO cloud_teams (
         tenant_id,
         team_id,
         display_name,
         state,
         revision,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, 'active', 1, $4, $4)`,
      [owner.accountId, teamId, `${label} Studio`, now],
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
       ) VALUES
         ($1, $2, $3, $1, 'owner', 'active', 1, $5, $5),
         ($1, $2, $4, $6, 'reviewer', 'active', 1, $5, $5)`,
      [owner.accountId, teamId, ownerMembershipId, recipientMembershipId, now, recipient.accountId],
    );
    await client.query(
      `INSERT INTO cloud_project_assignments (
         tenant_id,
         team_id,
         project_id,
         membership_id,
         assignment_id,
         state,
         revision,
         granted_by_membership_id,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $7, $7)`,
      [
        owner.accountId,
        teamId,
        projectId,
        recipientMembershipId,
        assignmentId,
        ownerMembershipId,
        now,
      ],
    );
  });
  return {
    assignmentId,
    owner,
    ownerMembershipId,
    projectId,
    recipient,
    recipientMembershipId,
    teamId,
  };
}

async function seedPrincipal(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  label: string,
  publicKeyCharacter: string,
): Promise<SeededPrincipal> {
  const accountId = uuid();
  const deviceId = uuid();
  const sessionId = uuid();
  const publicKey = publicKeyCharacter.repeat(87);
  const publicKeyFingerprint = sha256(deviceId);
  await pool.query(
    `INSERT INTO cloud_accounts (
       account_id,
       email_canonical,
       password_hash,
       state,
       verified_at,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, 'active', $4, $4, $4)`,
    [accountId, `${label}-${accountId}@example.test`, `scrypt-test-${"x".repeat(32)}`, now],
  );
  await pool.query(
    `INSERT INTO registered_devices (
       device_id,
       account_id,
       display_name,
       algorithm,
       public_key,
       public_key_fingerprint,
       client_version,
       state,
       revision,
       created_at,
       updated_at
     ) VALUES (
       $1, $2, $3, 'DHKEM-P256-HKDF-SHA256', $4, $5, '0.1.0',
       'trusted', 1, $6, $6
     )`,
    [deviceId, accountId, `${label} device`, publicKey, publicKeyFingerprint, now],
  );
  await pool.query(
    `INSERT INTO cloud_sessions (
       session_id,
       account_id,
       device_id,
       client_version,
       minimum_client_version,
       access_token_hash_sha256,
       refresh_token_hash_sha256,
       refresh_generation,
       issued_at,
       expires_at,
       refresh_expires_at,
       last_seen_at
     ) VALUES ($1, $2, $3, '0.1.0', '0.1.0', $4, $5, 1, $6, $7, $8, $6)`,
    [
      sessionId,
      accountId,
      deviceId,
      sha256(`access-${sessionId}`),
      sha256(`refresh-${sessionId}`),
      now,
      new Date(now.getTime() + 60 * 60 * 1_000),
      new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    ],
  );
  return { accountId, deviceId, publicKey, publicKeyFingerprint, sessionId };
}

function envelopeRequest(
  fixture: Fixture,
  envelopeId: string,
  overrides: Partial<CloudTeamProjectKeyEnvelopePublishRequest> = {},
): CloudTeamProjectKeyEnvelopePublishRequest {
  return {
    algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
    assignmentId: fixture.assignmentId,
    assignmentRevision: 1,
    ciphertext: "T".repeat(64),
    encapsulatedKey: "K".repeat(87),
    envelopeId,
    envelopeKind: "team_project_member_device",
    keyVersion: 1,
    membershipId: fixture.recipientMembershipId,
    membershipRevision: 1,
    projectId: fixture.projectId,
    recipientDeviceId: fixture.recipient.deviceId,
    recipientPublicKey: fixture.recipient.publicKey,
    recipientPublicKeyFingerprint: fixture.recipient.publicKeyFingerprint,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    senderDeviceId: fixture.owner.deviceId,
    senderPublicKey: fixture.owner.publicKey,
    senderPublicKeyFingerprint: fixture.owner.publicKeyFingerprint,
    teamId: fixture.teamId,
    ...overrides,
  };
}

async function setTenant(
  pool: Pool,
  tenantId: string,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [tenantId]);
    await operation(client);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setTeamScope(
  pool: Pool,
  principal: Pick<SeededPrincipal, "accountId" | "deviceId">,
  teamId: string,
  operation: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT
         set_config('inkshadow.account_id', $1, true),
         set_config('inkshadow.tenant_id', $1, true),
         set_config('inkshadow.team_id', $2, true),
         set_config('inkshadow.device_id', $3, true)`,
      [principal.accountId, teamId, principal.deviceId],
    );
    await operation(client);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function mutation(requestId: string, idempotencyKey: string) {
  return { idempotencyKey, requestId };
}

function read(requestId: string) {
  return { requestId };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function authorizationHeader(token: string): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${token}` };
}

function mutationHeaders(token: string, idempotencyKey: string): Readonly<Record<string, string>> {
  return {
    ...authorizationHeader(token),
    "idempotency-key": idempotencyKey,
  };
}
