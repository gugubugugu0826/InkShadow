import { describe, expect, it } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";

import {
  InkShadowCloudApiClient,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../src/index.js";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const OTHER_TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const OTHER_PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const RESERVATION_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const EVENT_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const IDEMPOTENCY_KEY = "usage-client-idempotency-0001";
const ACCESS_TOKEN = "t".repeat(64);
const NOW = "2026-07-28T00:00:00.000Z";
const EXPIRES_AT = "2026-07-28T00:05:00.000Z";

describe("InkShadowCloudApiClient AI usage operations", () => {
  it("executes all seven authenticated routes with scoped queries and metadata-only bodies", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request.authentication).toBe("session");
      expect(request.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(request.headers["X-Request-Id"]).toBe(REQUEST_ID);

      switch (`${request.method} ${request.path}`) {
        case `PUT /v1/teams/${TEAM_ID}/ai-budget`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-team`);
          return success({ ...baseResponse(), budget: teamBudget() });
        case `PUT /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/ai-budget`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-project`);
          return success({ ...baseResponse(), budget: projectBudget() });
        case `GET /v1/teams/${TEAM_ID}/ai-usage?projectId=${PROJECT_ID}`:
          expectRead(request);
          return success(summary());
        case `GET /v1/teams/${TEAM_ID}/ai-usage/events?cursor=usage_cursor&limit=25&projectId=${PROJECT_ID}`:
          expectRead(request);
          return success(eventPage());
        case `POST /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/ai-usage/reservations`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-reserve`);
          expect(request.body).toMatchObject({
            reservationId: RESERVATION_ID,
            modelIdentifier: "openai/gpt-5",
            purpose: "content_generation",
            priceVersion: "aud-2026-07",
          });
          expectMetadataOnly(request.body);
          return success(reservationResponse("active", 1), 201);
        case `POST /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/ai-usage/reservations/${RESERVATION_ID}/settlements`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-settle`);
          expect(request.body).toEqual({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision: 1,
            actualInputTokens: 400,
            actualOutputTokens: 80,
          });
          expectMetadataOnly(request.body);
          return success(reservationResponse("settled", 2));
        case `POST /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/ai-usage/reservations/${RESERVATION_ID}/cancellations`:
          expectMutation(request, `${IDEMPOTENCY_KEY}-cancel`);
          expect(request.body).toEqual({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            expectedRevision: 1,
          });
          expectMetadataOnly(request.body);
          return success(reservationResponse("cancelled", 2));
        default:
          throw new Error(`Unexpected usage request: ${request.method} ${request.path}`);
      }
    });
    const client = createClient(transport);

    await expect(
      client.updateTeamAiBudget(
        TEAM_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: null,
          currency: "AUD",
          monthlyLimitMicrounits: 100_000_000,
          priceVersion: "aud-2026-07",
          inputMicrounitsPerMillionTokens: 1_000_000,
          outputMicrounitsPerMillionTokens: 2_000_000,
          maximumConcurrentRuns: 4,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-team` },
      ),
    ).resolves.toMatchObject({ budget: { teamId: TEAM_ID, revision: 1 } });
    await expect(
      client.updateProjectAiBudget(
        TEAM_ID,
        PROJECT_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: null,
          monthlyLimitMicrounits: 60_000_000,
          maximumConcurrentRuns: 2,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-project` },
      ),
    ).resolves.toMatchObject({ budget: { projectId: PROJECT_ID, revision: 1 } });
    await expect(client.getTeamAiUsageSummary(TEAM_ID, PROJECT_ID)).resolves.toMatchObject({
      teamId: TEAM_ID,
      project: { projectId: PROJECT_ID },
    });
    await expect(
      client.listTeamAiUsageEvents(TEAM_ID, PROJECT_ID, {
        cursor: "usage_cursor",
        limit: 25,
      }),
    ).resolves.toMatchObject({ events: [{ purpose: "content_generation" }] });
    await expect(
      client.reserveTeamProjectAiUsage(
        TEAM_ID,
        PROJECT_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          reservationId: RESERVATION_ID,
          modelIdentifier: "openai/gpt-5",
          purpose: "content_generation",
          priceVersion: "aud-2026-07",
          estimatedInputTokens: 500,
          estimatedOutputTokens: 100,
          leaseTtlSeconds: 300,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-reserve` },
      ),
    ).resolves.toMatchObject({ reservation: { state: "active" } });
    await expect(
      client.settleTeamProjectAiUsage(
        TEAM_ID,
        PROJECT_ID,
        RESERVATION_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 1,
          actualInputTokens: 400,
          actualOutputTokens: 80,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-settle` },
      ),
    ).resolves.toMatchObject({ reservation: { state: "settled" } });
    await expect(
      client.cancelTeamProjectAiUsage(
        TEAM_ID,
        PROJECT_ID,
        RESERVATION_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 1,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-cancel` },
      ),
    ).resolves.toMatchObject({ reservation: { state: "cancelled" } });

    expect(transport.requests).toHaveLength(7);
  });

  it("fails closed when budget or reservation summaries cross the requested scope", async () => {
    const crossedSummary = new RecordingTransport(() =>
      success({
        ...summary(),
        projectBudget: { ...projectBudget(), projectId: OTHER_PROJECT_ID },
      }),
    );
    await expect(
      createClient(crossedSummary).getTeamAiUsageSummary(TEAM_ID, PROJECT_ID),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });

    const crossedReservation = new RecordingTransport(() =>
      success({
        ...reservationResponse("active", 1),
        summary: {
          ...reservationResponse("active", 1).summary,
          teamBudget: { ...teamBudget(), teamId: OTHER_TEAM_ID },
        },
      }),
    );
    await expect(
      createClient(crossedReservation).reserveTeamProjectAiUsage(
        TEAM_ID,
        PROJECT_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          reservationId: RESERVATION_ID,
          modelIdentifier: "openai/gpt-5",
          purpose: "read_only_review",
          priceVersion: "aud-2026-07",
          estimatedInputTokens: 1,
          estimatedOutputTokens: 0,
          leaseTtlSeconds: 30,
        },
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });
  });
});

class RecordingTransport implements CloudTransport {
  public readonly requests: CloudTransportRequest[] = [];

  public constructor(
    private readonly responder: (request: CloudTransportRequest) => CloudTransportResponse,
  ) {}

  public send(request: CloudTransportRequest): Promise<CloudTransportResponse> {
    this.requests.push(request);
    return Promise.resolve(this.responder(request));
  }
}

function createClient(transport: CloudTransport): InkShadowCloudApiClient {
  return new InkShadowCloudApiClient({
    accessTokens: { readAccessToken: () => Promise.resolve(ACCESS_TOKEN) },
    requestIdFactory: () => REQUEST_ID,
    transport,
  });
}

function expectMutation(request: CloudTransportRequest, idempotencyKey: string): void {
  expect(request.headers["Idempotency-Key"]).toBe(idempotencyKey);
  expect(request.body).not.toBeNull();
}

function expectRead(request: CloudTransportRequest): void {
  expect(request.headers["Idempotency-Key"]).toBeUndefined();
  expect(request.body).toBeNull();
}

function expectMetadataOnly(body: unknown): void {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(
    /"(?:prompt|plaintext|ciphertext|projectKey|apiKey|credential)"/iu,
  );
}

function success(body: unknown, status = 200): CloudTransportResponse {
  return {
    status,
    headers: { "x-request-id": REQUEST_ID },
    body,
  };
}

function baseResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
  };
}

function teamBudget() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    currency: "AUD",
    monthlyLimitMicrounits: 100_000_000,
    warningThresholdBasisPoints: 8_000,
    hardCap: true,
    priceVersion: "aud-2026-07",
    inputMicrounitsPerMillionTokens: 1_000_000,
    outputMicrounitsPerMillionTokens: 2_000_000,
    maximumConcurrentRuns: 4,
    revision: 1,
    updatedByMembershipId: MEMBERSHIP_ID,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

function projectBudget() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    monthlyLimitMicrounits: 60_000_000,
    maximumConcurrentRuns: 2,
    revision: 1,
    updatedByMembershipId: MEMBERSHIP_ID,
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

function summary() {
  return {
    ...baseResponse(),
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    periodStart: "2026-07-01",
    currency: "AUD",
    priceVersion: "aud-2026-07",
    teamBudget: teamBudget(),
    projectBudget: projectBudget(),
    team: bucket("team", null, 100_000_000),
    project: bucket("project", PROJECT_ID, 60_000_000),
    leaseExpiredCount: 0,
    activeLeaseCount: 1,
    maximumConcurrentRuns: 4,
    activeProjectLeaseCount: 1,
    projectMaximumConcurrentRuns: 2,
    effectiveMaximumConcurrentRuns: 2,
    concurrencyHardCapReached: false,
    capabilities: {
      manageTeamBudget: true,
      manageProjectBudget: true,
      consume: true,
    },
    serverTime: NOW,
  } as const;
}

function summaryWithoutRequestId() {
  const { requestId: _requestId, ...value } = summary();
  void _requestId;
  return value;
}

function bucket(
  scope: "team" | "project",
  projectId: string | null,
  monthlyLimitMicrounits: number,
) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scope,
    projectId,
    monthlyLimitMicrounits,
    settledMicrounits: 10_000,
    reservedMicrounits: 1_000,
    remainingMicrounits: monthlyLimitMicrounits - 11_000,
    settledInputTokens: 4_000,
    settledOutputTokens: 1_000,
    reservedInputTokens: 500,
    reservedOutputTokens: 100,
    status: "ok",
    updatedAt: NOW,
  } as const;
}

function reservationResponse(state: "active" | "settled" | "cancelled", revision: number) {
  return {
    ...baseResponse(),
    reservation: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      reservationId: RESERVATION_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      membershipId: MEMBERSHIP_ID,
      modelIdentifier: "openai/gpt-5",
      purpose: "content_generation",
      priceVersion: "aud-2026-07",
      currency: "AUD",
      state,
      reservedInputTokens: 500,
      reservedOutputTokens: 100,
      reservedMicrounits: 700,
      settledInputTokens: state === "settled" ? 400 : 0,
      settledOutputTokens: state === "settled" ? 80 : 0,
      settledMicrounits: state === "settled" ? 560 : 0,
      revision,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: EXPIRES_AT,
      settledAt: state === "settled" ? NOW : null,
      cancelledAt: state === "cancelled" ? NOW : null,
      expiredAt: null,
    },
    summary: summaryWithoutRequestId(),
  } as const;
}

function eventPage() {
  return {
    ...baseResponse(),
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    events: [
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        eventId: EVENT_ID,
        tenantId: TENANT_ID,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        membershipId: MEMBERSHIP_ID,
        reservationId: RESERVATION_ID,
        requestId: REQUEST_ID,
        eventType: "reserved",
        inputTokens: 500,
        outputTokens: 100,
        costMicrounits: 700,
        currency: "AUD",
        priceVersion: "aud-2026-07",
        modelIdentifier: "openai/gpt-5",
        purpose: "content_generation",
        createdAt: NOW,
      },
    ],
    nextCursor: null,
  } as const;
}
