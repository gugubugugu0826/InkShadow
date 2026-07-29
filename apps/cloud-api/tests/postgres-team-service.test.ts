import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import type { Pool } from "pg";

import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresTeamInvitationOutboxStore } from "../src/postgres/team-invitation-outbox-store.js";
import { PostgresCloudTeamStore } from "../src/postgres/team-store.js";
import { hashCanonicalJson, hashUtf8 } from "../src/security/canonical-hash.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { Aes256GcmTeamInvitationTokenProtector } from "../src/security/team-invitation-token-protector.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import type { CloudPrincipal } from "../src/service/identity-service.js";
import {
  TeamInvitationOutboxWorker,
  type TeamInvitationOutboxDelivery,
  type TeamInvitationOutboxDeliveryPort,
} from "../src/service/team-invitation-outbox-worker.js";
import {
  CloudTeamService,
  UnavailableTeamInvitationTokenProtector,
} from "../src/service/team-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-07-28T02:00:00.000Z");

class CaptureInvitationNotifier implements TeamInvitationOutboxDeliveryPort {
  public readonly deliveries: TeamInvitationOutboxDelivery[] = [];

  public deliver(delivery: TeamInvitationOutboxDelivery): Promise<void> {
    this.deliveries.push(delivery);
    return Promise.resolve();
  }
}

describePostgres("PostgreSQL Studio team and RBAC service", () => {
  let pool: Pool;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;
  let notifier: CaptureInvitationNotifier;
  let outboxWorker: TeamInvitationOutboxWorker;
  let service: CloudTeamService;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      applicationName: "inkshadow-cloud-team-test",
      connectionString: databaseUrl,
      maximumConnections: 12,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    notifier = new CaptureInvitationNotifier();
    const protector = new Aes256GcmTeamInvitationTokenProtector({
      keys: { "test-v1": Buffer.alloc(32, 0xc1) },
      primaryKeyId: "test-v1",
    });
    outboxWorker = new TeamInvitationOutboxWorker({
      clock: () => now,
      delivery: notifier,
      protector,
      store: new PostgresTeamInvitationOutboxStore(pool),
      workerId: uuid(),
    });
    service = new CloudTeamService({
      clock: () => now,
      invitationTokenProtector: protector,
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0xa1)),
      store: new PostgresCloudTeamStore(pool),
      uuid,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates, invites, accepts and assigns without granting key-envelope access", async () => {
    const owner = await seedPrincipal(pool, uuid, "team-owner");
    const reviewer = await seedPrincipal(pool, uuid, "team-reviewer");
    const projectId = uuid();
    await seedProject(pool, owner.accountId, projectId);

    const created = await service.createTeam(
      owner,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "InkShadow Studio" },
      mutation(uuid(), "team-create-idempotency-0001"),
    );
    const replayed = await service.createTeam(
      owner,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "InkShadow Studio" },
      mutation(uuid(), "team-create-idempotency-0001"),
    );
    expect(replayed.team.teamId).toBe(created.team.teamId);
    expect(replayed.requestId).not.toBe(created.requestId);
    expect((await service.listTeams(owner, null, 100, read(uuid()))).teams).toEqual([created.team]);

    const invitation = await service.createInvitation(
      owner,
      created.team.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
        inviteeEmail: reviewer.email,
        role: "reviewer",
      },
      mutation(uuid(), "team-invite-idempotency-0001"),
    );
    await outboxWorker.runOnce();
    expect(notifier.deliveries).toHaveLength(1);
    expect(JSON.stringify(invitation)).not.toContain("invitationToken");
    const delivered = notifier.deliveries[0];
    expect(delivered).toBeDefined();
    const storedToken = await pool.query<{ token_hash_sha256: string }>(
      `SELECT token_hash_sha256
       FROM cloud_team_invitations
       WHERE invitation_id = $1`,
      [invitation.invitation.invitationId],
    );
    expect(storedToken.rows).toEqual([
      {
        token_hash_sha256: sha256(delivered?.invitationToken ?? ""),
      },
    ]);
    const forbiddenTokenColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'cloud_team_invitations'
         AND column_name IN ('invitation_token', 'token', 'secret')`,
    );
    expect(forbiddenTokenColumns.rows).toEqual([]);

    const accepted = await service.acceptInvitation(
      reviewer,
      invitation.invitation.invitationId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: invitation.invitation.revision,
        invitationToken: delivered?.invitationToken ?? "",
      },
      mutation(uuid(), "team-accept-idempotency-0001"),
    );
    expect(accepted.membership.role).toBe("reviewer");
    expect(accepted.invitation.acceptedMembershipId).toBe(accepted.membership.membershipId);
    await expect(
      service.acceptInvitation(
        reviewer,
        invitation.invitation.invitationId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: invitation.invitation.revision,
          invitationToken: "X".repeat(43),
        },
        mutation(uuid(), "team-accept-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const replayedAcceptance = await service.acceptInvitation(
      reviewer,
      invitation.invitation.invitationId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: invitation.invitation.revision,
        invitationToken: delivered?.invitationToken ?? "",
      },
      mutation(uuid(), "team-accept-idempotency-0001"),
    );
    expect(replayedAcceptance.membership.membershipId).toBe(accepted.membership.membershipId);
    expect(replayedAcceptance.requestId).not.toBe(accepted.requestId);
    const acceptanceIdempotency = await pool.query<{ request_hash_sha256: string }>(
      `SELECT request_hash_sha256
       FROM cloud_idempotency_records
       WHERE operation_id = 'teamInvitations.accept'
         AND actor_account_id = $1
         AND result_resource_id = $2`,
      [reviewer.accountId, invitation.invitation.invitationId],
    );
    expect(acceptanceIdempotency.rows).toEqual([
      {
        request_hash_sha256: hashCanonicalJson({
          invitationId: invitation.invitation.invitationId,
          expectedRevision: invitation.invitation.revision,
        }),
      },
    ]);
    expect(acceptanceIdempotency.rows[0]?.request_hash_sha256).not.toBe(
      hashCanonicalJson({
        invitationId: invitation.invitation.invitationId,
        expectedRevision: invitation.invitation.revision,
        invitationTokenHashSha256: hashUtf8(delivered?.invitationToken ?? ""),
      }),
    );
    expect(
      (await service.listMembers(owner, created.team.teamId, null, 100, read(uuid()))).memberships,
    ).toHaveLength(2);

    const assigned = await service.setProjectAssignment(
      owner,
      created.team.teamId,
      projectId,
      accepted.membership.membershipId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        desiredState: "active",
        expectedRevision: null,
      },
      mutation(uuid(), "team-assignment-idempotency-0001"),
    );
    expect(assigned.assignment.state).toBe("active");
    await expect(
      service.authorizeProjectBusinessAction(
        reviewer,
        created.team.teamId,
        projectId,
        "project.read",
      ),
    ).resolves.toEqual({ allowed: true, reason: "allowed" });
    await expect(
      service.authorizeProjectBusinessAction(
        reviewer,
        created.team.teamId,
        projectId,
        "project.edit_content",
      ),
    ).resolves.toEqual({ allowed: false, reason: "role_forbidden" });
    const financeMembership = await service.changeMemberRole(
      owner,
      created.team.teamId,
      accepted.membership.membershipId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: accepted.membership.revision,
        role: "finance_admin",
      },
      mutation(uuid(), "team-finance-role-idempotency-0001"),
    );
    expect(financeMembership.membership.role).toBe("finance_admin");
    await expect(
      service.authorizeProjectBusinessAction(
        reviewer,
        created.team.teamId,
        projectId,
        "project.read",
      ),
    ).resolves.toEqual({ allowed: false, reason: "role_forbidden" });

    const cryptographicAccess = await pool.query<{
      access_count: string;
      envelope_count: string;
    }>(
      `SELECT
         (
           SELECT COUNT(*)::text
           FROM cloud_project_access
           WHERE tenant_id = $1
             AND project_id = $2
             AND account_id = $3
         ) AS access_count,
         (
           SELECT COUNT(*)::text
           FROM device_project_key_envelopes
           WHERE tenant_id = $1
             AND project_id = $2
             AND recipient_device_id = $4
         ) AS envelope_count`,
      [owner.accountId, projectId, reviewer.accountId, reviewer.deviceId],
    );
    expect(cryptographicAccess.rows[0]).toEqual({
      access_count: "0",
      envelope_count: "0",
    });

    const deletionRequestId = uuid();
    const transferRequired = await pool.query<{ required: boolean }>(
      "SELECT inkshadow_account_requires_ownership_transfer($1) AS required",
      [reviewer.accountId],
    );
    expect(transferRequired.rows).toEqual([{ required: false }]);
    expect(
      (
        await pool.query<{ active: boolean }>(
          "SELECT inkshadow_account_has_active_team_access($1) AS active",
          [reviewer.accountId],
        )
      ).rows,
    ).toEqual([{ active: true }]);
    const revoked = await pool.query<{ revoked_count: number }>(
      `SELECT inkshadow_revoke_account_team_access($1, $2, $3)
         AS revoked_count`,
      [reviewer.accountId, now, deletionRequestId],
    );
    expect(revoked.rows).toEqual([{ revoked_count: 1 }]);
    const replayedRevocation = await pool.query<{ revoked_count: number }>(
      `SELECT inkshadow_revoke_account_team_access($1, $2, $3)
         AS revoked_count`,
      [reviewer.accountId, now, deletionRequestId],
    );
    expect(replayedRevocation.rows).toEqual([{ revoked_count: 0 }]);
    expect(
      (
        await pool.query<{ active: boolean }>(
          "SELECT inkshadow_account_has_active_team_access($1) AS active",
          [reviewer.accountId],
        )
      ).rows,
    ).toEqual([{ active: false }]);
    const deletionEffects = await pool.query<{
      assignment_state: string;
      audit_count: string;
      membership_state: string;
    }>(
      `SELECT
         membership.state AS membership_state,
         assignment.state AS assignment_state,
         (
           SELECT COUNT(*)::text
           FROM cloud_team_audit_events
           WHERE event_id = membership.membership_id
             AND request_id = $4
             AND action = 'account_deletion.team_access_revoked'
         ) AS audit_count
       FROM cloud_team_memberships AS membership
       JOIN cloud_project_assignments AS assignment
         ON assignment.tenant_id = membership.tenant_id
         AND assignment.team_id = membership.team_id
         AND assignment.membership_id = membership.membership_id
       WHERE membership.tenant_id = $1
         AND membership.team_id = $2
         AND membership.membership_id = $3`,
      [
        created.team.tenantId,
        created.team.teamId,
        accepted.membership.membershipId,
        deletionRequestId,
      ],
    );
    expect(deletionEffects.rows).toEqual([
      {
        assignment_state: "revoked",
        audit_count: "1",
        membership_state: "revoked",
      },
    ]);
    const deidentifiedInvitation = await pool.query<{
      audit_count: string;
      invitee_email: string;
      state: string;
    }>(
      `SELECT
         invitation.invitee_email,
         invitation.state,
         (
           SELECT COUNT(*)::text
           FROM cloud_team_audit_events
           WHERE event_id = invitation.invitation_id
             AND request_id = $2
             AND action = 'account_deletion.invitation_deidentified'
         ) AS audit_count
       FROM cloud_team_invitations AS invitation
       WHERE invitation.invitation_id = $1`,
      [invitation.invitation.invitationId, deletionRequestId],
    );
    expect(deidentifiedInvitation.rows).toEqual([
      {
        audit_count: "1",
        invitee_email: `deleted-${deletionRequestId}@deleted.invalid`,
        state: "accepted",
      },
    ]);

    await pool.query(
      `UPDATE cloud_project_assignments
       SET state = 'active',
           revision = revision + 1,
           revoked_by_membership_id = NULL,
           revoked_at = NULL,
           updated_at = $4
       WHERE tenant_id = $1
         AND team_id = $2
         AND membership_id = $3`,
      [created.team.tenantId, created.team.teamId, accepted.membership.membershipId, now],
    );
    expect(
      (
        await pool.query<{ active: boolean }>(
          "SELECT inkshadow_account_has_active_team_access($1) AS active",
          [reviewer.accountId],
        )
      ).rows,
    ).toEqual([{ active: true }]);
    const repairedResidualAssignment = await pool.query<{ revoked_count: number }>(
      `SELECT inkshadow_revoke_account_team_access($1, $2, $3)
         AS revoked_count`,
      [reviewer.accountId, now, deletionRequestId],
    );
    expect(repairedResidualAssignment.rows).toEqual([{ revoked_count: 0 }]);
    expect(
      (
        await pool.query<{ active: boolean }>(
          "SELECT inkshadow_account_has_active_team_access($1) AS active",
          [reviewer.accountId],
        )
      ).rows,
    ).toEqual([{ active: false }]);

    const unavailableService = new CloudTeamService({
      clock: () => now,
      invitationTokenProtector: new UnavailableTeamInvitationTokenProtector(),
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0xa2)),
      store: new PostgresCloudTeamStore(pool),
      uuid,
    });
    const undeliverableEmail = `undeliverable-${uuid()}@example.test`;
    await expect(
      unavailableService.createInvitation(
        owner,
        created.team.teamId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
          inviteeEmail: undeliverableEmail,
          role: "author",
        },
        mutation(uuid(), "unavailable-invite-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(
      (
        await pool.query("SELECT 1 FROM cloud_team_invitations WHERE invitee_email = $1", [
          undeliverableEmail,
        ])
      ).rows,
    ).toEqual([]);

    await pool.query(
      `UPDATE cloud_idempotency_records
       SET response_snapshot = jsonb_set(
         response_snapshot,
         '{requestId}',
         to_jsonb($2::text),
         false
       )
       WHERE operation_id = 'teams.create'
         AND result_resource_id = $1`,
      [created.team.teamId, uuid()],
    );
    await expect(
      service.createTeam(
        owner,
        { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "InkShadow Studio" },
        mutation(uuid(), "team-create-idempotency-0001"),
      ),
    ).rejects.toThrow("team idempotency record is internally inconsistent");
  });

  it("serializes invitation acceptance, blocks privilege escalation and rechecks revoked actors", async () => {
    const owner = await seedPrincipal(pool, uuid, "race-owner");
    const invitee = await seedPrincipal(pool, uuid, "race-invitee");
    const target = await seedPrincipal(pool, uuid, "race-target");
    const created = await service.createTeam(
      owner,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "Race Studio" },
      mutation(uuid(), "race-create-idempotency-0001"),
    );

    const invite = await service.createInvitation(
      owner,
      created.team.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
        inviteeEmail: invitee.email,
        role: "admin",
      },
      mutation(uuid(), "race-invite-idempotency-0001"),
    );
    await outboxWorker.runOnce();
    const delivery = notifier.deliveries.at(-1);
    const request = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      expectedRevision: 1,
      invitationToken: delivery?.invitationToken ?? "",
    } as const;
    await expect(
      service.acceptInvitation(
        target,
        invite.invitation.invitationId,
        request,
        mutation(uuid(), "race-wrong-invitee-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const results = await Promise.allSettled([
      service.acceptInvitation(
        invitee,
        invite.invitation.invitationId,
        request,
        mutation(uuid(), "race-accept-idempotency-0001"),
      ),
      service.acceptInvitation(
        invitee,
        invite.invitation.invitationId,
        request,
        mutation(uuid(), "race-accept-idempotency-0002"),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const members = await service.listMembers(owner, created.team.teamId, null, 100, read(uuid()));
    const admin = members.memberships.find(
      (membership) => membership.accountId === invitee.accountId,
    );
    expect(admin?.role).toBe("admin");
    const deliveryCountBeforePrivilegedInvite = notifier.deliveries.length;
    await expect(
      service.createInvitation(
        invitee,
        created.team.teamId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
          inviteeEmail: `finance-target-${uuid()}@example.test`,
          role: "finance_admin",
        },
        mutation(uuid(), "race-admin-finance-invite-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    expect(notifier.deliveries).toHaveLength(deliveryCountBeforePrivilegedInvite);

    const targetInvitation = await service.createInvitation(
      owner,
      created.team.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
        inviteeEmail: target.email,
        role: "author",
      },
      mutation(uuid(), "race-target-invite-idempotency-0001"),
    );
    await outboxWorker.runOnce();
    const targetDelivery = notifier.deliveries.at(-1);
    const targetMembership = (
      await service.acceptInvitation(
        target,
        targetInvitation.invitation.invitationId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 1,
          invitationToken: targetDelivery?.invitationToken ?? "",
        },
        mutation(uuid(), "race-target-accept-idempotency-0001"),
      )
    ).membership;
    await expect(
      service.changeMemberRole(
        invitee,
        created.team.teamId,
        targetMembership.membershipId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: targetMembership.revision,
          role: "owner",
        },
        mutation(uuid(), "race-escalation-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const currentAdmin = (
      await service.listMembers(owner, created.team.teamId, null, 100, read(uuid()))
    ).memberships.find((membership) => membership.accountId === invitee.accountId);
    expect(currentAdmin).toBeDefined();
    await service.revokeMembership(
      owner,
      created.team.teamId,
      currentAdmin?.membershipId ?? "",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: currentAdmin?.revision ?? 0,
      },
      mutation(uuid(), "race-admin-revoke-idempotency-0001"),
    );
    const deliveryCount = notifier.deliveries.length;
    await expect(
      service.createInvitation(
        invitee,
        created.team.teamId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
          inviteeEmail: "must-not-send@example.test",
          role: "author",
        },
        mutation(uuid(), "race-revoked-invite-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(notifier.deliveries).toHaveLength(deliveryCount);
  });

  it("protects the last owner in both the service and deferred database invariant", async () => {
    const owner = await seedPrincipal(pool, uuid, "last-owner");
    const secondOwner = await seedPrincipal(pool, uuid, "second-owner");
    const created = await service.createTeam(
      owner,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "Owner Guard Studio" },
      mutation(uuid(), "last-owner-create-idempotency-0001"),
    );
    const membership = (
      await service.listMembers(owner, created.team.teamId, null, 100, read(uuid()))
    ).memberships[0];
    expect(membership?.role).toBe("owner");
    expect(
      (
        await pool.query<{ required: boolean }>(
          "SELECT inkshadow_account_requires_ownership_transfer($1) AS required",
          [owner.accountId],
        )
      ).rows,
    ).toEqual([{ required: true }]);
    await expect(
      service.revokeMembership(
        owner,
        created.team.teamId,
        membership?.membershipId ?? "",
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: membership?.revision ?? 0,
        },
        mutation(uuid(), "last-owner-revoke-idempotency-0001"),
      ),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });

    const invitation = await service.createInvitation(
      owner,
      created.team.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
        inviteeEmail: secondOwner.email,
        role: "admin",
      },
      mutation(uuid(), "last-owner-invite-idempotency-0001"),
    );
    await outboxWorker.runOnce();
    const delivery = notifier.deliveries.at(-1);
    const accepted = await service.acceptInvitation(
      secondOwner,
      invitation.invitation.invitationId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: 1,
        invitationToken: delivery?.invitationToken ?? "",
      },
      mutation(uuid(), "last-owner-accept-idempotency-0001"),
    );
    const promoted = await service.changeMemberRole(
      owner,
      created.team.teamId,
      accepted.membership.membershipId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: accepted.membership.revision,
        role: "owner",
      },
      mutation(uuid(), "last-owner-promote-idempotency-0001"),
    );
    expect(
      (
        await pool.query<{ required: boolean }>(
          "SELECT inkshadow_account_requires_ownership_transfer($1) AS required",
          [owner.accountId],
        )
      ).rows,
    ).toEqual([{ required: false }]);
    const competingDemotions = await Promise.allSettled([
      service.changeMemberRole(
        owner,
        created.team.teamId,
        promoted.membership.membershipId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: promoted.membership.revision,
          role: "author",
        },
        mutation(uuid(), "last-owner-race-idempotency-0001"),
      ),
      service.changeMemberRole(
        secondOwner,
        created.team.teamId,
        membership?.membershipId ?? "",
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: membership?.revision ?? 0,
          role: "author",
        },
        mutation(uuid(), "last-owner-race-idempotency-0002"),
      ),
    ]);
    expect(competingDemotions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competingDemotions.filter((result) => result.status === "rejected")).toHaveLength(1);
    const survivingOwnerPrincipal =
      competingDemotions[0].status === "fulfilled" ? owner : secondOwner;
    const survivingOwners = (
      await service.listMembers(
        survivingOwnerPrincipal,
        created.team.teamId,
        null,
        100,
        read(uuid()),
      )
    ).memberships.filter((candidate) => candidate.state === "active" && candidate.role === "owner");
    expect(survivingOwners).toHaveLength(1);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE cloud_team_memberships
         SET state = 'revoked',
             revision = revision + 1,
             revoked_at = $3,
             updated_at = $3
         WHERE tenant_id = $1
           AND team_id = $2
           AND role = 'owner'`,
        [created.team.tenantId, created.team.teamId, now],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK").catch(() => {
        // A failed deferred constraint leaves no open transaction.
      });
      client.release();
    }

    const ownerlessTeamId = uuid();
    const ownerlessClient = await pool.connect();
    try {
      await ownerlessClient.query("BEGIN");
      await ownerlessClient.query(
        `INSERT INTO cloud_teams (
           tenant_id,
           team_id,
           display_name,
           state,
           revision,
           created_at,
           updated_at,
           archived_at
         )
         VALUES ($1, $2, 'Ownerless Studio', 'active', 1, $3, $3, NULL)`,
        [owner.accountId, ownerlessTeamId, now],
      );
      await expect(
        ownerlessClient.query("SET CONSTRAINTS cloud_teams_require_owner IMMEDIATE"),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await ownerlessClient.query("ROLLBACK");
      ownerlessClient.release();
    }

    const accountStateClient = await pool.connect();
    try {
      await accountStateClient.query("BEGIN");
      await accountStateClient.query(
        `UPDATE cloud_accounts
         SET state = 'deletion_scheduled',
             revision = revision + 1,
             deletion_scheduled_for = $2,
             updated_at = $2
         WHERE account_id = $1`,
        [survivingOwnerPrincipal.accountId, now],
      );
      await expect(
        accountStateClient.query("SET CONSTRAINTS cloud_accounts_require_team_owner IMMEDIATE"),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await accountStateClient.query("ROLLBACK");
      accountStateClient.release();
    }
  });

  it("blocks account deletion while an owned project remains assigned to another member", async () => {
    const owner = await seedPrincipal(pool, uuid, "shared-project-owner");
    const successor = await seedPrincipal(pool, uuid, "shared-project-successor");
    const projectId = uuid();
    await seedProject(pool, owner.accountId, projectId);
    const created = await service.createTeam(
      owner,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "Shared Project Studio" },
      mutation(uuid(), "shared-project-create-idempotency-0001"),
    );
    const originalOwnerMembership = (
      await service.listMembers(owner, created.team.teamId, null, 100, read(uuid()))
    ).memberships[0];
    const invitation = await service.createInvitation(
      owner,
      created.team.teamId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
        inviteeEmail: successor.email,
        role: "admin",
      },
      mutation(uuid(), "shared-project-invite-idempotency-0001"),
    );
    await outboxWorker.runOnce();
    const delivery = notifier.deliveries.at(-1);
    const successorMembership = (
      await service.acceptInvitation(
        successor,
        invitation.invitation.invitationId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: invitation.invitation.revision,
          invitationToken: delivery?.invitationToken ?? "",
        },
        mutation(uuid(), "shared-project-accept-idempotency-0001"),
      )
    ).membership;
    const promotedSuccessor = await service.changeMemberRole(
      owner,
      created.team.teamId,
      successorMembership.membershipId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: successorMembership.revision,
        role: "owner",
      },
      mutation(uuid(), "shared-project-promote-idempotency-0001"),
    );
    const assignment = await service.setProjectAssignment(
      owner,
      created.team.teamId,
      projectId,
      promotedSuccessor.membership.membershipId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        desiredState: "active",
        expectedRevision: null,
      },
      mutation(uuid(), "shared-project-assign-idempotency-0001"),
    );
    await service.changeMemberRole(
      successor,
      created.team.teamId,
      originalOwnerMembership?.membershipId ?? "",
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: originalOwnerMembership?.revision ?? 0,
        role: "author",
      },
      mutation(uuid(), "shared-project-demote-idempotency-0001"),
    );
    expect(
      (
        await pool.query<{ required: boolean }>(
          "SELECT inkshadow_account_requires_ownership_transfer($1) AS required",
          [owner.accountId],
        )
      ).rows,
    ).toEqual([{ required: true }]);
    const revokedAssignment = await service.setProjectAssignment(
      successor,
      created.team.teamId,
      projectId,
      promotedSuccessor.membership.membershipId,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        desiredState: "revoked",
        expectedRevision: assignment.assignment.revision,
      },
      mutation(uuid(), "shared-project-unassign-idempotency-0001"),
    );
    expect(
      (
        await pool.query<{ required: boolean }>(
          "SELECT inkshadow_account_requires_ownership_transfer($1) AS required",
          [owner.accountId],
        )
      ).rows,
    ).toEqual([{ required: false }]);

    const deletionClient = await pool.connect();
    try {
      await deletionClient.query("BEGIN");
      expect(
        (
          await deletionClient.query<{ required: boolean }>(
            "SELECT inkshadow_account_requires_ownership_transfer($1) AS required",
            [owner.accountId],
          )
        ).rows,
      ).toEqual([{ required: false }]);
      const racingAssignment = service.setProjectAssignment(
        successor,
        created.team.teamId,
        projectId,
        promotedSuccessor.membership.membershipId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          desiredState: "active",
          expectedRevision: revokedAssignment.assignment.revision,
        },
        mutation(uuid(), "shared-project-racing-assign-idempotency-0001"),
      );
      const initialRaceState = await Promise.race([
        racingAssignment.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<"blocked">((resolve) => {
          setTimeout(() => {
            resolve("blocked");
          }, 25);
        }),
      ]);
      expect(initialRaceState).toBe("blocked");
      await deletionClient.query(
        `UPDATE cloud_projects
         SET state = 'deletion_scheduled',
             revision = revision + 1,
             deletion_scheduled_for = $3,
             updated_at = $4
         WHERE tenant_id = $1
           AND project_id = $2`,
        [owner.accountId, projectId, new Date(now.getTime() + 24 * 60 * 60 * 1_000), now],
      );
      await deletionClient.query("COMMIT");
      await expect(racingAssignment).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
    } finally {
      await deletionClient.query("ROLLBACK").catch(() => {
        // COMMIT already closed the successful deletion-side transaction.
      });
      deletionClient.release();
    }
  });

  it("hides cross-tenant teams and enforces tenant plus team RLS for a non-bypass role", async () => {
    const first = await seedPrincipal(pool, uuid, "rls-team-first");
    const second = await seedPrincipal(pool, uuid, "rls-team-second");
    const firstTeam = await service.createTeam(
      first,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "First RLS Studio" },
      mutation(uuid(), "rls-first-create-idempotency-0001"),
    );
    const secondTeam = await service.createTeam(
      second,
      { schemaVersion: CONTRACT_SCHEMA_VERSION, displayName: "Second RLS Studio" },
      mutation(uuid(), "rls-second-create-idempotency-0001"),
    );
    await expect(
      service.listMembers(second, firstTeam.team.teamId, null, 100, read(uuid())),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = 'inkshadow_team_rls_test'
        ) THEN
          CREATE ROLE inkshadow_team_rls_test LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await pool.query("ALTER ROLE inkshadow_team_rls_test LOGIN NOSUPERUSER NOBYPASSRLS");
    await pool.query("GRANT USAGE ON SCHEMA public TO inkshadow_team_rls_test");
    await pool.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO inkshadow_team_rls_test",
    );
    await pool.query(
      `REVOKE EXECUTE
         ON FUNCTION inkshadow_account_has_active_team_access(UUID),
                     inkshadow_account_requires_ownership_transfer(UUID),
                     inkshadow_revoke_account_team_access(UUID, TIMESTAMPTZ, UUID)
         FROM inkshadow_team_rls_test`,
    );
    await pool.query(
      `GRANT EXECUTE
         ON FUNCTION inkshadow_has_active_team_membership(UUID, UUID),
                     inkshadow_invitation_matches_current_account(TEXT)
         TO inkshadow_team_rls_test`,
    );

    const limitedUrl = new URL(databaseUrl ?? "");
    limitedUrl.username = "inkshadow_team_rls_test";
    limitedUrl.password = "";
    const limitedPool = createCloudPostgresPool({
      applicationName: "inkshadow-cloud-team-rls-test",
      connectionString: limitedUrl.toString(),
      maximumConnections: 1,
      requireTls: false,
    });
    const client = await limitedPool.connect();
    try {
      expect((await client.query("SELECT team_id FROM cloud_teams")).rows).toEqual([]);
      await client.query("BEGIN");
      await client.query("SELECT set_config('inkshadow.account_id', $1, true)", [first.accountId]);
      await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [
        firstTeam.team.tenantId,
      ]);
      await client.query("SELECT set_config('inkshadow.team_id', $1, true)", [
        firstTeam.team.teamId,
      ]);
      expect((await client.query("SELECT team_id FROM cloud_teams")).rows).toEqual([
        { team_id: firstTeam.team.teamId },
      ]);
      const crossTenantUpdate = await client.query(
        `UPDATE cloud_teams
         SET revision = revision + 1
         WHERE tenant_id = $1
           AND team_id = $2`,
        [secondTeam.team.tenantId, secondTeam.team.teamId],
      );
      expect(crossTenantUpdate.rowCount).toBe(0);
      await client.query("ROLLBACK");
      await expect(
        client.query("SELECT inkshadow_account_has_active_team_access($1)", [first.accountId]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      client.release();
      await limitedPool.end();
    }
  });
});

interface SeededPrincipal extends CloudPrincipal {
  readonly email: string;
}

async function seedPrincipal(
  pool: Pool,
  uuid: ReturnType<typeof createMonotonicUuidV7Factory>,
  label: string,
): Promise<SeededPrincipal> {
  const accountId = uuid();
  const deviceId = uuid();
  const sessionId = uuid();
  const email = `${label}-${accountId}@example.test`;
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
    [accountId, email, `scrypt-test-${"x".repeat(32)}`, now],
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
       created_at,
       updated_at
     ) VALUES (
       $1, $2, $3, 'DHKEM-P256-HKDF-SHA256', $4, $5, '0.1.0', 'trusted', $6, $6
     )`,
    [deviceId, accountId, `${label} device`, "A".repeat(87), sha256(deviceId), now],
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
  return { accountId, deviceId, email, sessionId };
}

async function seedProject(pool: Pool, ownerAccountId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO cloud_projects (
       tenant_id,
       project_id,
       owner_account_id,
       state,
       revision,
       created_at,
       updated_at
     ) VALUES ($1, $2, $1, 'active', 1, $3, $3)`,
    [ownerAccountId, projectId, now],
  );
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
