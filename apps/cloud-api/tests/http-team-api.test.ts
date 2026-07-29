import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CloudProjectAssignmentListResponseSchema,
  CloudProjectAssignmentResponseSchema,
  CloudTeamInvitationAcceptanceResponseSchema,
  CloudTeamInvitationResponseSchema,
  CloudTeamListResponseSchema,
  CloudTeamMemberListResponseSchema,
  CloudTeamMembershipResponseSchema,
  CloudTeamResponseSchema,
  CONTRACT_SCHEMA_VERSION,
} from "@inkshadow/contracts";
import type { Pool } from "pg";

import { createCloudApiServer } from "../src/http/server.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresTeamInvitationOutboxStore } from "../src/postgres/team-invitation-outbox-store.js";
import { PostgresCloudTeamStore } from "../src/postgres/team-store.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { Aes256GcmTeamInvitationTokenProtector } from "../src/security/team-invitation-token-protector.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import type { CloudIdentityService, CloudPrincipal } from "../src/service/identity-service.js";
import type { CloudProjectSyncService } from "../src/service/project-sync-service.js";
import {
  TeamInvitationOutboxWorker,
  type TeamInvitationOutboxDelivery,
  type TeamInvitationOutboxDeliveryPort,
} from "../src/service/team-invitation-outbox-worker.js";
import { CloudTeamService } from "../src/service/team-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const now = new Date("2026-07-28T03:00:00.000Z");

class HttpCaptureNotifier implements TeamInvitationOutboxDeliveryPort {
  public readonly deliveries: TeamInvitationOutboxDelivery[] = [];

  public deliver(delivery: TeamInvitationOutboxDelivery): Promise<void> {
    this.deliveries.push(delivery);
    return Promise.resolve();
  }
}

describePostgres("Studio team HTTP API", () => {
  let pool: Pool;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;
  let owner: SeededPrincipal;
  let member: SeededPrincipal;
  let ownerToken: string;
  let memberToken: string;
  let notifier: HttpCaptureNotifier;
  let outboxWorker: TeamInvitationOutboxWorker;
  let server: ReturnType<typeof createCloudApiServer>;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      applicationName: "inkshadow-cloud-team-http-test",
      connectionString: databaseUrl,
      maximumConnections: 8,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    owner = await seedPrincipal(pool, uuid, "http-team-owner");
    member = await seedPrincipal(pool, uuid, "http-team-member");
    ownerToken = `owner.${"A".repeat(43)}`;
    memberToken = `member.${"B".repeat(43)}`;
    notifier = new HttpCaptureNotifier();
    const principals = new Map<string, CloudPrincipal>([
      [ownerToken, owner],
      [memberToken, member],
    ]);
    const identityService = {
      authenticateAccessToken: (token: string) => {
        const principal = principals.get(token);
        return principal === undefined
          ? Promise.reject(new Error("unknown test token"))
          : Promise.resolve(principal);
      },
    } as unknown as CloudIdentityService;
    const protector = new Aes256GcmTeamInvitationTokenProtector({
      keys: { "http-test-v1": Buffer.alloc(32, 0xb2) },
      primaryKeyId: "http-test-v1",
    });
    outboxWorker = new TeamInvitationOutboxWorker({
      clock: () => now,
      delivery: notifier,
      protector,
      store: new PostgresTeamInvitationOutboxStore(pool),
      workerId: uuid(),
    });
    const teamService = new CloudTeamService({
      clock: () => now,
      invitationTokenProtector: protector,
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0xb1)),
      store: new PostgresCloudTeamStore(pool),
      uuid,
    });
    server = createCloudApiServer({
      clock: () => now,
      identityService,
      projectSyncService: {} as CloudProjectSyncService,
      teamService,
      uuid,
    });
  });

  afterAll(async () => {
    await server.close();
    await pool.end();
  });

  it("registers and executes all nine frozen team routes against PostgreSQL", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/v1/teams",
      headers: mutationHeaders(ownerToken, "http-team-create-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        displayName: "HTTP Studio",
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = CloudTeamResponseSchema.parse(createResponse.json());

    const teamsResponse = await server.inject({
      method: "GET",
      url: "/v1/teams?limit=100",
      headers: authorizationHeader(ownerToken),
    });
    expect(teamsResponse.statusCode).toBe(200);
    expect(CloudTeamListResponseSchema.parse(teamsResponse.json()).teams).toEqual([created.team]);
    const maximumPageResponse = await server.inject({
      method: "GET",
      url: "/v1/teams?limit=1024",
      headers: authorizationHeader(ownerToken),
    });
    expect(maximumPageResponse.statusCode).toBe(200);

    const firstMembersResponse = await server.inject({
      method: "GET",
      url: `/v1/teams/${created.team.teamId}/members?limit=100`,
      headers: authorizationHeader(ownerToken),
    });
    expect(firstMembersResponse.statusCode).toBe(200);
    expect(
      CloudTeamMemberListResponseSchema.parse(firstMembersResponse.json()).memberships,
    ).toHaveLength(1);

    const inviteResponse = await server.inject({
      method: "POST",
      url: `/v1/teams/${created.team.teamId}/invitations`,
      headers: mutationHeaders(ownerToken, "http-team-invite-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
        inviteeEmail: member.email,
        role: "reviewer",
      },
    });
    expect(inviteResponse.statusCode).toBe(201);
    expect(inviteResponse.body).not.toContain("invitationToken");
    const invitation = CloudTeamInvitationResponseSchema.parse(inviteResponse.json());
    await outboxWorker.runOnce();
    const delivery = notifier.deliveries.at(-1);

    const acceptanceResponse = await server.inject({
      method: "POST",
      url: `/v1/team-invitations/${invitation.invitation.invitationId}/acceptances`,
      headers: mutationHeaders(memberToken, "http-team-accept-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: invitation.invitation.revision,
        invitationToken: delivery?.invitationToken,
      },
    });
    expect(acceptanceResponse.statusCode).toBe(200);
    const acceptance = CloudTeamInvitationAcceptanceResponseSchema.parse(acceptanceResponse.json());

    const roleResponse = await server.inject({
      method: "POST",
      url: `/v1/teams/${created.team.teamId}/members/${acceptance.membership.membershipId}/role-changes`,
      headers: mutationHeaders(ownerToken, "http-team-role-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: acceptance.membership.revision,
        role: "author",
      },
    });
    expect(roleResponse.statusCode).toBe(200);
    const changed = CloudTeamMembershipResponseSchema.parse(roleResponse.json());
    expect(changed.membership.role).toBe("author");
    const roleReplayResponse = await server.inject({
      method: "POST",
      url: `/v1/teams/${created.team.teamId}/members/${acceptance.membership.membershipId}/role-changes`,
      headers: mutationHeaders(ownerToken, "http-team-role-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: acceptance.membership.revision,
        role: "author",
      },
    });
    expect(roleReplayResponse.statusCode).toBe(200);
    expect(CloudTeamMembershipResponseSchema.parse(roleReplayResponse.json()).membership).toEqual(
      changed.membership,
    );
    const conflictingReplayResponse = await server.inject({
      method: "POST",
      url: `/v1/teams/${created.team.teamId}/members/${acceptance.membership.membershipId}/role-changes`,
      headers: mutationHeaders(ownerToken, "http-team-role-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: changed.membership.revision,
        role: "author",
      },
    });
    expect(conflictingReplayResponse.statusCode).toBe(409);

    const projectId = uuid();
    await seedProject(pool, owner.accountId, projectId);
    const assignmentResponse = await server.inject({
      method: "PUT",
      url: `/v1/teams/${created.team.teamId}/projects/${projectId}/assignments/${changed.membership.membershipId}`,
      headers: mutationHeaders(ownerToken, "http-team-assignment-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        desiredState: "active",
        expectedRevision: null,
      },
    });
    expect(assignmentResponse.statusCode).toBe(200);
    const assignment = CloudProjectAssignmentResponseSchema.parse(assignmentResponse.json());

    const assignmentsResponse = await server.inject({
      method: "GET",
      url: `/v1/teams/${created.team.teamId}/projects/${projectId}/assignments?limit=100`,
      headers: authorizationHeader(ownerToken),
    });
    expect(assignmentsResponse.statusCode).toBe(200);
    expect(
      CloudProjectAssignmentListResponseSchema.parse(assignmentsResponse.json()).assignments,
    ).toEqual([assignment.assignment]);
    const revokedAssignmentResponse = await server.inject({
      method: "PUT",
      url: `/v1/teams/${created.team.teamId}/projects/${projectId}/assignments/${changed.membership.membershipId}`,
      headers: mutationHeaders(ownerToken, "http-team-assignment-idempotency-0002"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        desiredState: "revoked",
        expectedRevision: assignment.assignment.revision,
      },
    });
    expect(revokedAssignmentResponse.statusCode).toBe(200);
    const revokedAssignment = CloudProjectAssignmentResponseSchema.parse(
      revokedAssignmentResponse.json(),
    );
    expect(revokedAssignment.assignment.state).toBe("revoked");
    const restoredAssignmentResponse = await server.inject({
      method: "PUT",
      url: `/v1/teams/${created.team.teamId}/projects/${projectId}/assignments/${changed.membership.membershipId}`,
      headers: mutationHeaders(ownerToken, "http-team-assignment-idempotency-0003"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        desiredState: "active",
        expectedRevision: revokedAssignment.assignment.revision,
      },
    });
    expect(restoredAssignmentResponse.statusCode).toBe(200);
    expect(
      CloudProjectAssignmentResponseSchema.parse(restoredAssignmentResponse.json()).assignment
        .state,
    ).toBe("active");

    const revokeResponse = await server.inject({
      method: "POST",
      url: `/v1/teams/${created.team.teamId}/members/${changed.membership.membershipId}/revocations`,
      headers: mutationHeaders(ownerToken, "http-team-revoke-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: changed.membership.revision,
      },
    });
    expect(revokeResponse.statusCode).toBe(200);
    expect(CloudTeamMembershipResponseSchema.parse(revokeResponse.json()).membership.state).toBe(
      "revoked",
    );
  });

  it("requires authentication, idempotency and strict request schemas", async () => {
    const missingAuthentication = await server.inject({
      method: "GET",
      url: "/v1/teams",
    });
    expect(missingAuthentication.statusCode).toBe(401);

    const missingIdempotency = await server.inject({
      method: "POST",
      url: "/v1/teams",
      headers: authorizationHeader(ownerToken),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        displayName: "Must not be created",
      },
    });
    expect(missingIdempotency.statusCode).toBe(400);

    const unknownField = await server.inject({
      method: "POST",
      url: "/v1/teams",
      headers: mutationHeaders(ownerToken, "http-team-invalid-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        displayName: "Must not be created",
        invitationToken: "T".repeat(43),
      },
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.body).not.toContain("T".repeat(43));
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
    [deviceId, accountId, `${label} device`, "B".repeat(87), sha256(deviceId), now],
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

function authorizationHeader(token: string): Readonly<Record<string, string>> {
  return { authorization: `Bearer ${token}` };
}

function mutationHeaders(token: string, idempotencyKey: string): Readonly<Record<string, string>> {
  return {
    ...authorizationHeader(token),
    "idempotency-key": idempotencyKey,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
