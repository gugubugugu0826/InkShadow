import { describe, expect, it } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";

import {
  CloudClientError,
  InkShadowCloudApiClient,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../src/index.js";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const ACCOUNT_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const INVITED_ACCOUNT_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const OTHER_TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const OWNER_MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const INVITATION_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-00000000000a";
const ASSIGNMENT_ID = "018f0d7a-3b2c-7abc-8def-00000000000b";
const NOW = "2026-07-28T00:00:00.000Z";
const UPDATED = "2026-07-28T00:05:00.000Z";
const EXPIRES_AT = "2026-08-04T00:00:00.000Z";
const ACCESS_TOKEN = "t".repeat(64);
const INVITATION_TOKEN = `isk_inv_${"s".repeat(64)}`;
const IDEMPOTENCY_KEY = "team-client-idempotency-0001";

describe("InkShadowCloudApiClient team operations", () => {
  it("executes all nine team and project-assignment operations with frozen routes", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request.authentication).toBe("session");
      expect(request.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(request.headers["X-Request-Id"]).toBe(REQUEST_ID);

      switch (`${request.method} ${request.path}`) {
        case "POST /v1/teams":
          expectMutation(request, IDEMPOTENCY_KEY);
          expect(request.body).toEqual({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            displayName: "Novel Studio",
          });
          return success(teamResponse(), 201);
        case "GET /v1/teams?cursor=team_cursor&limit=25":
          expectRead(request);
          return success({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            requestId: REQUEST_ID,
            teams: [team()],
            nextCursor: null,
          });
        case `GET /v1/teams/${TEAM_ID}/members?limit=10`:
          expectRead(request);
          return success({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            requestId: REQUEST_ID,
            memberships: [membership()],
            nextCursor: null,
          });
        case `POST /v1/teams/${TEAM_ID}/invitations`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-invite`);
          expect(request.body).toEqual({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            inviteeEmail: "collaborator@example.com",
            role: "author",
            expiresAt: EXPIRES_AT,
          });
          return success(invitationResponse(), 201);
        case `POST /v1/team-invitations/${INVITATION_ID}/acceptances`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-accept`);
          expect(request.body).toEqual({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision: 1,
            invitationToken: INVITATION_TOKEN,
          });
          return success(invitationAcceptanceResponse());
        case `POST /v1/teams/${TEAM_ID}/members/${MEMBERSHIP_ID}/role-changes`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-role`);
          expect(request.body).toEqual({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision: 1,
            role: "reviewer",
          });
          return success({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            requestId: REQUEST_ID,
            membership: membership({
              accountId: INVITED_ACCOUNT_ID,
              membershipId: MEMBERSHIP_ID,
              revision: 2,
              role: "reviewer",
              updatedAt: UPDATED,
            }),
          });
        case `POST /v1/teams/${TEAM_ID}/members/${MEMBERSHIP_ID}/revocations`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-revoke`);
          expect(request.body).toEqual({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision: 2,
          });
          return success({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            requestId: REQUEST_ID,
            membership: membership({
              accountId: INVITED_ACCOUNT_ID,
              membershipId: MEMBERSHIP_ID,
              revision: 3,
              revokedAt: UPDATED,
              role: "reviewer",
              state: "revoked",
              updatedAt: UPDATED,
            }),
          });
        case `GET /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/assignments?cursor=assignment_cursor&limit=20`:
          expectRead(request);
          return success({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            requestId: REQUEST_ID,
            assignments: [assignment()],
            nextCursor: null,
          });
        case `PUT /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/assignments/${MEMBERSHIP_ID}`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-assignment`);
          expect(request.body).toEqual({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision: null,
            desiredState: "active",
          });
          return success({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            requestId: REQUEST_ID,
            assignment: assignment(),
          });
        default:
          throw new Error(`Unexpected team request: ${request.method} ${request.path}`);
      }
    });
    const client = createClient(transport);

    await expect(
      client.createTeam(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          displayName: " Novel Studio ",
        },
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).resolves.toMatchObject({ team: { teamId: TEAM_ID } });
    await expect(client.listTeams({ cursor: "team_cursor", limit: 25 })).resolves.toMatchObject({
      teams: [{ teamId: TEAM_ID }],
    });
    await expect(client.listTeamMembers(TEAM_ID, { limit: 10 })).resolves.toMatchObject({
      memberships: [{ teamId: TEAM_ID }],
    });
    await expect(
      client.createTeamInvitation(
        TEAM_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          inviteeEmail: " Collaborator@Example.COM ",
          role: "author",
          expiresAt: EXPIRES_AT,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-invite` },
      ),
    ).resolves.toMatchObject({ invitation: { invitationId: INVITATION_ID } });
    await expect(
      client.acceptTeamInvitation(
        INVITATION_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 1,
          invitationToken: INVITATION_TOKEN,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-accept` },
      ),
    ).resolves.toMatchObject({ membership: { membershipId: MEMBERSHIP_ID } });
    await expect(
      client.changeTeamMemberRole(
        TEAM_ID,
        MEMBERSHIP_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 1,
          role: "reviewer",
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-role` },
      ),
    ).resolves.toMatchObject({ membership: { role: "reviewer" } });
    await expect(
      client.revokeTeamMembership(
        TEAM_ID,
        MEMBERSHIP_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 2,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-revoke` },
      ),
    ).resolves.toMatchObject({ membership: { state: "revoked" } });
    await expect(
      client.listProjectAssignments(TEAM_ID, PROJECT_ID, {
        cursor: "assignment_cursor",
        limit: 20,
      }),
    ).resolves.toMatchObject({ assignments: [{ projectId: PROJECT_ID }] });
    await expect(
      client.setProjectAssignment(
        TEAM_ID,
        PROJECT_ID,
        MEMBERSHIP_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: null,
          desiredState: "active",
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-assignment` },
      ),
    ).resolves.toMatchObject({ assignment: { state: "active" } });

    expect(transport.requests).toHaveLength(9);
  });

  it("fails closed on cross-team responses and path-injection input", async () => {
    const transport = new RecordingTransport(() =>
      success({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        memberships: [membership({ teamId: OTHER_TEAM_ID })],
        nextCursor: null,
      }),
    );
    const client = createClient(transport);

    await expect(client.listTeamMembers(TEAM_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });
    await expect(client.listTeamMembers(`${TEAM_ID}/../other`)).rejects.toMatchObject({
      code: "CLOUD_REQUEST_INVALID",
      requestId: REQUEST_ID,
    });
    expect(transport.requests).toHaveLength(1);
  });

  it("redacts the invitation token from server and transport errors", async () => {
    const echoingTransport = new RecordingTransport(() => ({
      status: 403,
      headers: { "x-request-id": REQUEST_ID },
      body: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        error: {
          code: "ACCESS_FORBIDDEN",
          message: `Invitation credential ${INVITATION_TOKEN} was rejected.`,
          retryable: false,
          actions: [],
          supportId: INVITATION_TOKEN,
        },
      },
    }));
    const echoingClient = createClient(echoingTransport);
    const request = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      expectedRevision: 1,
      invitationToken: INVITATION_TOKEN,
    };

    const serverError = await captureError(() =>
      echoingClient.acceptTeamInvitation(INVITATION_ID, request, {
        idempotencyKey: `${IDEMPOTENCY_KEY}-accept`,
      }),
    );
    expect(serverError).toBeInstanceOf(CloudClientError);
    expect((serverError as CloudClientError).message).toContain("[redacted]");
    expect(JSON.stringify(serverError)).not.toContain(INVITATION_TOKEN);
    expect((serverError as CloudClientError).supportId).not.toContain(INVITATION_TOKEN);

    const throwingTransport = new RecordingTransport(() => {
      const error = new Error("Transport rejected the invitation request.");
      error.name = INVITATION_TOKEN;
      throw error;
    });
    const throwingClient = createClient(throwingTransport);
    const transportError = await captureError(() =>
      throwingClient.acceptTeamInvitation(INVITATION_ID, request, {
        idempotencyKey: `${IDEMPOTENCY_KEY}-accept`,
      }),
    );
    expect(transportError).toBeInstanceOf(CloudClientError);
    expect(JSON.stringify(transportError)).not.toContain(INVITATION_TOKEN);
    expect((transportError as CloudClientError).causeType).toBe("[redacted]");
  });
});

class RecordingTransport implements CloudTransport {
  public readonly requests: CloudTransportRequest[] = [];

  public constructor(
    private readonly responder: (
      request: CloudTransportRequest,
    ) => CloudTransportResponse | Promise<CloudTransportResponse>,
  ) {}

  public async send(request: CloudTransportRequest): Promise<CloudTransportResponse> {
    this.requests.push(request);
    return await this.responder(request);
  }
}

function createClient(transport: CloudTransport): InkShadowCloudApiClient {
  return new InkShadowCloudApiClient({
    transport,
    accessTokens: {
      readAccessToken: () => Promise.resolve(ACCESS_TOKEN),
    },
    requestIdFactory: () => REQUEST_ID,
  });
}

function expectMutation(request: CloudTransportRequest, idempotencyKey: string): void {
  expect(request.headers["Idempotency-Key"]).toBe(idempotencyKey);
}

function expectRead(request: CloudTransportRequest): void {
  expect(request.headers["Idempotency-Key"]).toBeUndefined();
  expect(request.body).toBeNull();
}

function success(body: unknown, status = 200): CloudTransportResponse {
  return {
    status,
    headers: { "x-request-id": REQUEST_ID },
    body,
  };
}

function teamResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    team: team(),
  };
}

function team() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    teamId: TEAM_ID,
    tenantId: TENANT_ID,
    displayName: "Novel Studio",
    state: "active" as const,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
}

function membership(
  overrides: Partial<{
    accountId: string;
    membershipId: string;
    revision: number;
    revokedAt: string | null;
    role: "owner" | "admin" | "author" | "reviewer" | "read_only" | "finance_admin";
    state: "active" | "revoked";
    teamId: string;
    updatedAt: string;
  }> = {},
) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    membershipId: OWNER_MEMBERSHIP_ID,
    accountId: ACCOUNT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    role: "owner" as const,
    state: "active" as const,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
    ...overrides,
  };
}

function invitationResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    invitation: invitation(),
  };
}

function invitationAcceptanceResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    invitation: invitation({
      acceptedAt: UPDATED,
      acceptedMembershipId: MEMBERSHIP_ID,
      revision: 2,
      state: "accepted",
      updatedAt: UPDATED,
    }),
    membership: membership({
      accountId: INVITED_ACCOUNT_ID,
      membershipId: MEMBERSHIP_ID,
      role: "author",
      updatedAt: UPDATED,
    }),
  };
}

function invitation(
  overrides: Partial<{
    acceptedAt: string | null;
    acceptedMembershipId: string | null;
    revision: number;
    state: "pending" | "accepted" | "revoked" | "expired";
    updatedAt: string;
  }> = {},
) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    invitationId: INVITATION_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    inviteeEmail: "collaborator@example.com",
    role: "author" as const,
    state: "pending" as const,
    revision: 1,
    invitedByMembershipId: OWNER_MEMBERSHIP_ID,
    acceptedMembershipId: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: EXPIRES_AT,
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function assignment() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    assignmentId: ASSIGNMENT_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    membershipId: MEMBERSHIP_ID,
    state: "active" as const,
    revision: 1,
    grantedByMembershipId: OWNER_MEMBERSHIP_ID,
    revokedByMembershipId: null,
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    throw new Error("Expected the operation to fail.");
  } catch (error: unknown) {
    return error;
  }
}
