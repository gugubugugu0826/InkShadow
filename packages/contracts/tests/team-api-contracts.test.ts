import { describe, expect, it } from "vitest";

import {
  CLOUD_API_OPERATIONS,
  CloudProjectAssignmentListResponseSchema,
  CloudProjectAssignmentSchema,
  CloudProjectAssignmentSetRequestSchema,
  CloudTeamInvitationAcceptanceResponseSchema,
  CloudTeamInvitationAcceptRequestSchema,
  CloudTeamInvitationResponseSchema,
  CloudTeamInvitationSchema,
  CloudTeamListResponseSchema,
  CloudTeamMemberRoleChangeRequestSchema,
  CloudTeamMembershipResponseSchema,
  CloudTeamMembershipSchema,
  CloudTeamSchema,
  CONTRACT_SCHEMA_VERSION,
  INKSHADOW_CLOUD_OPENAPI,
  getCloudApiOperation,
} from "../src/index.js";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const ACCOUNT_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const ACTOR_MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const INVITATION_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const ASSIGNMENT_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const NOW = "2026-07-28T00:00:00.000Z";
const LATER = "2026-07-28T01:00:00.000Z";
const EXPIRES = "2026-07-29T00:00:00.000Z";

describe("Studio team cloud contracts", () => {
  it("enforces UUIDv7, portable revisions and team/membership state chronology", () => {
    const team = activeTeam();
    const membership = activeMembership();

    expect(CloudTeamSchema.safeParse(team).success).toBe(true);
    expect(CloudTeamMembershipSchema.safeParse(membership).success).toBe(true);
    expect(
      CloudTeamSchema.safeParse({
        ...team,
        teamId: "550e8400-e29b-41d4-a716-446655440000",
      }).success,
    ).toBe(false);
    expect(
      CloudTeamSchema.safeParse({
        ...team,
        state: "active",
        archivedAt: LATER,
        updatedAt: LATER,
      }).success,
    ).toBe(false);
    expect(
      CloudTeamMembershipSchema.safeParse({
        ...membership,
        revision: 0,
      }).success,
    ).toBe(false);
    expect(
      CloudTeamMembershipSchema.safeParse({
        ...membership,
        state: "revoked",
        updatedAt: LATER,
        revokedAt: null,
      }).success,
    ).toBe(false);
    expect(
      CloudTeamMembershipSchema.safeParse({
        ...membership,
        state: "revoked",
        updatedAt: NOW,
        revokedAt: LATER,
      }).success,
    ).toBe(false);
  });

  it("accepts only coherent pending, accepted, revoked and expired invitation states", () => {
    const pending = pendingInvitation();
    expect(CloudTeamInvitationSchema.safeParse(pending).success).toBe(true);
    expect(
      CloudTeamInvitationSchema.safeParse({
        ...pending,
        role: "owner",
      }).success,
    ).toBe(false);
    expect(
      CloudTeamInvitationSchema.safeParse({
        ...pending,
        updatedAt: EXPIRES,
      }).success,
    ).toBe(false);

    const accepted = {
      ...pending,
      state: "accepted",
      revision: 2,
      updatedAt: LATER,
      acceptedAt: LATER,
      acceptedMembershipId: MEMBERSHIP_ID,
    };
    expect(CloudTeamInvitationSchema.safeParse(accepted).success).toBe(true);
    expect(
      CloudTeamInvitationSchema.safeParse({
        ...accepted,
        acceptedMembershipId: null,
      }).success,
    ).toBe(false);

    expect(
      CloudTeamInvitationSchema.safeParse({
        ...pending,
        state: "revoked",
        revision: 2,
        updatedAt: LATER,
        revokedAt: LATER,
      }).success,
    ).toBe(true);
    expect(
      CloudTeamInvitationSchema.safeParse({
        ...pending,
        state: "expired",
        revision: 2,
        updatedAt: EXPIRES,
      }).success,
    ).toBe(true);
    expect(
      CloudTeamInvitationSchema.safeParse({
        ...pending,
        state: "expired",
      }).success,
    ).toBe(false);
  });

  it("binds an accepted invitation exactly to its resulting active membership", () => {
    const response = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      invitation: {
        ...pendingInvitation(),
        state: "accepted",
        revision: 2,
        updatedAt: LATER,
        acceptedAt: LATER,
        acceptedMembershipId: MEMBERSHIP_ID,
      },
      membership: activeMembership(),
    };
    expect(CloudTeamInvitationAcceptanceResponseSchema.safeParse(response).success).toBe(true);
    expect(
      CloudTeamInvitationAcceptanceResponseSchema.safeParse({
        ...response,
        membership: { ...response.membership, role: "author" },
      }).success,
    ).toBe(false);
    expect(
      CloudTeamInvitationAcceptanceResponseSchema.safeParse({
        ...response,
        invitation: {
          ...response.invitation,
          teamId: PROJECT_ID,
        },
      }).success,
    ).toBe(false);
  });

  it("enforces project-assignment state, CAS creation and unique pagination", () => {
    const assignment = activeAssignment();
    expect(CloudProjectAssignmentSchema.safeParse(assignment).success).toBe(true);
    expect(
      CloudProjectAssignmentSchema.safeParse({
        ...assignment,
        state: "revoked",
        revokedAt: LATER,
        updatedAt: LATER,
        revokedByMembershipId: null,
      }).success,
    ).toBe(false);
    expect(
      CloudProjectAssignmentSetRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        desiredState: "active",
      }).success,
    ).toBe(true);
    expect(
      CloudProjectAssignmentSetRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: null,
        desiredState: "revoked",
      }).success,
    ).toBe(false);
    expect(
      CloudProjectAssignmentListResponseSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        assignments: [assignment, assignment],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      CloudTeamListResponseSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        teams: [activeTeam(), activeTeam()],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("requires CAS on invitation acceptance, role change, revocation and assignment mutation", () => {
    expect(
      CloudTeamInvitationAcceptRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: 1,
        invitationToken: "T".repeat(43),
      }).success,
    ).toBe(true);
    expect(
      CloudTeamInvitationAcceptRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        invitationToken: "T".repeat(43),
      }).success,
    ).toBe(false);
    expect(
      CloudTeamMemberRoleChangeRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: 1,
        role: "owner",
      }).success,
    ).toBe(true);
    expect(
      CloudTeamMemberRoleChangeRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
        role: "reviewer",
      }).success,
    ).toBe(false);
  });

  it("never permits team responses to carry invitation tokens, passwords or key material", () => {
    const membershipResponse = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      membership: activeMembership(),
    };
    expect(CloudTeamMembershipResponseSchema.safeParse(membershipResponse).success).toBe(true);
    for (const forbidden of [
      { invitationToken: "T".repeat(43) },
      { password: "not-a-real-password" },
      { projectKey: "never-return-this" },
    ]) {
      expect(
        CloudTeamMembershipResponseSchema.safeParse({
          ...membershipResponse,
          membership: { ...membershipResponse.membership, ...forbidden },
        }).success,
      ).toBe(false);
    }
    expect(findSensitiveResponseKeys(membershipResponse)).toEqual([]);
    const invitationResponse = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      invitation: pendingInvitation(),
    };
    expect(findSensitiveResponseKeys(invitationResponse)).toEqual([]);
    expect(
      CloudTeamInvitationResponseSchema.safeParse({
        ...invitationResponse,
        invitation: {
          ...invitationResponse.invitation,
          invitationToken: "T".repeat(43),
        },
      }).success,
    ).toBe(false);
  });

  it("freezes authenticated, paginated and idempotent operation metadata in OpenAPI", () => {
    const expected = [
      ["teams.create", "post", "/v1/teams", true],
      ["teams.list", "get", "/v1/teams", false],
      ["teamMembers.list", "get", "/v1/teams/{teamId}/members", false],
      ["teamInvitations.create", "post", "/v1/teams/{teamId}/invitations", true],
      ["teamInvitations.accept", "post", "/v1/team-invitations/{invitationId}/acceptances", true],
      [
        "teamMembers.changeRole",
        "post",
        "/v1/teams/{teamId}/members/{membershipId}/role-changes",
        true,
      ],
      ["teamMembers.revoke", "post", "/v1/teams/{teamId}/members/{membershipId}/revocations", true],
      [
        "projectAssignments.list",
        "get",
        "/v1/teams/{teamId}/projects/{projectId}/assignments",
        false,
      ],
      [
        "projectAssignments.set",
        "put",
        "/v1/teams/{teamId}/projects/{projectId}/assignments/{membershipId}",
        true,
      ],
    ] as const;

    for (const [operationId, method, path, idempotent] of expected) {
      expect(getCloudApiOperation(operationId)).toMatchObject({
        method,
        path,
        requiresAuthentication: true,
        requiresIdempotencyKey: idempotent,
        requiresNativePasswordBoundary: false,
      });
    }
    expect(
      CLOUD_API_OPERATIONS.filter((operation) => operation.operationId.startsWith("team")),
    ).toHaveLength(21);

    const document = INKSHADOW_CLOUD_OPENAPI as {
      readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    };
    expect(
      document.paths["/v1/teams/{teamId}/members/{membershipId}/role-changes"]?.post,
    ).toMatchObject({
      security: [{ bearerAuth: [] }],
      "x-inkshadow-idempotency-required": true,
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/TeamMemberRoleChangeRequest" },
          },
        },
      },
    });
    expect(document.paths["/v1/teams"]?.get).toMatchObject({
      "x-inkshadow-idempotency-required": false,
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: "cursor", in: "query" }),
        expect.objectContaining({ name: "limit", in: "query" }),
      ]),
    });
  });
});

function activeTeam() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    teamId: TEAM_ID,
    tenantId: TENANT_ID,
    displayName: "墨影工作室",
    state: "active" as const,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
}

function activeMembership() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    membershipId: MEMBERSHIP_ID,
    accountId: ACCOUNT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    role: "reviewer" as const,
    state: "active" as const,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function pendingInvitation() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    invitationId: INVITATION_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    inviteeEmail: "reviewer@example.com",
    role: "reviewer" as const,
    state: "pending" as const,
    revision: 1,
    invitedByMembershipId: ACTOR_MEMBERSHIP_ID,
    acceptedMembershipId: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: EXPIRES,
    acceptedAt: null,
    revokedAt: null,
  };
}

function activeAssignment() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    assignmentId: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    membershipId: MEMBERSHIP_ID,
    state: "active" as const,
    revision: 1,
    grantedByMembershipId: ACTOR_MEMBERSHIP_ID,
    revokedByMembershipId: null,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function findSensitiveResponseKeys(value: unknown, path = ""): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSensitiveResponseKeys(item, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = path === "" ? key : `${path}.${key}`;
    return [
      ...(/(?:password|token|secret|privateKey|projectKey|recoveryCode)/iu.test(key)
        ? [childPath]
        : []),
      ...findSensitiveResponseKeys(child, childPath),
    ];
  });
}
