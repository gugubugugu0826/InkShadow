import { describe, expect, it } from "vitest";

import { CONTRACT_SCHEMA_VERSION, type CloudReviewSubmissionRequest } from "@inkshadow/contracts";

import {
  InkShadowCloudApiClient,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../src/index.js";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const REVIEW_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const VERSION_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const THREAD_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const ITEM_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const IDEMPOTENCY_KEY = "review-client-idempotency-0001";
const NOW = "2026-07-28T00:00:00.000Z";

describe("InkShadowCloudApiClient encrypted reviews", () => {
  it("sends submission and suggestion decision through authenticated idempotent routes", async () => {
    const submission = submissionRequest();
    const transport = new RecordingTransport((request) => {
      expect(request.authentication).toBe("session");
      expect(request.headers.Authorization).toBe(`Bearer ${"t".repeat(64)}`);
      expect(request.headers["Idempotency-Key"]).toBe(IDEMPOTENCY_KEY);
      if (
        request.path === `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/reviews` &&
        request.method === "POST"
      ) {
        expect(request.body).toEqual(submission);
        return success(reviewResponse(), 201);
      }
      if (
        request.path ===
          `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/reviews/${REVIEW_ID}/threads/${THREAD_ID}/suggestions/${ITEM_ID}/decisions` &&
        request.method === "POST"
      ) {
        return success(suggestionDecisionResponse());
      }
      throw new Error(`Unexpected review request: ${request.method} ${request.path}`);
    });
    const client = createClient(transport);

    await expect(
      client.submitReview(TEAM_ID, PROJECT_ID, submission, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toMatchObject({ review: { reviewId: REVIEW_ID, state: "pending" } });
    await expect(
      client.decideReviewSuggestion(
        TEAM_ID,
        PROJECT_ID,
        REVIEW_ID,
        THREAD_ID,
        ITEM_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          expectedRevision: 1,
          decision: "accepted",
        },
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).resolves.toMatchObject({
      effect: "metadata_only_no_content_mutation",
      item: { suggestionDecision: "accepted" },
    });
    expect(transport.requests).toHaveLength(2);
  });

  it("fails closed on embedded submission scope mismatch and cross-scope responses", async () => {
    const transport = new RecordingTransport(() =>
      success({
        ...reviewResponse(),
        review: { ...reviewResponse().review, projectId: VERSION_ID },
      }),
    );
    const client = createClient(transport);

    await expect(
      client.submitReview(
        TEAM_ID,
        PROJECT_ID,
        { ...submissionRequest(), projectId: VERSION_ID },
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    expect(transport.requests).toHaveLength(0);

    await expect(client.getReview(TEAM_ID, PROJECT_ID, REVIEW_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });
  });

  it("discovers review threads through the bounded route and rejects crossed scope", async () => {
    const response = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      threads: [suggestionDecisionResponse().thread],
      nextCursor: null,
    };
    const transport = new RecordingTransport((request) => {
      expect(request.path).toBe(
        `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/reviews/${REVIEW_ID}/threads?limit=50`,
      );
      return success(response);
    });
    const client = createClient(transport);

    await expect(
      client.listReviewThreads(TEAM_ID, PROJECT_ID, REVIEW_ID, { limit: 50 }),
    ).resolves.toMatchObject({ threads: [{ threadId: THREAD_ID }] });

    const crossed = new RecordingTransport(() =>
      success({
        ...response,
        threads: [{ ...response.threads[0], projectId: VERSION_ID }],
      }),
    );
    await expect(
      createClient(crossed).listReviewThreads(TEAM_ID, PROJECT_ID, REVIEW_ID),
    ).rejects.toMatchObject({ code: "CLOUD_PROTOCOL_INVALID_RESPONSE" });
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
    accessTokens: { readAccessToken: () => Promise.resolve("t".repeat(64)) },
    requestIdFactory: () => REQUEST_ID,
    transport,
  });
}

function success(body: unknown, status = 200): CloudTransportResponse {
  return {
    status,
    headers: { "x-request-id": REQUEST_ID },
    body,
  };
}

function submissionRequest(): CloudReviewSubmissionRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    reviewId: REVIEW_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    sourceVersionId: VERSION_ID,
    sourceVersionRevision: 3,
    sourceCiphertextSha256: "b".repeat(64),
    projectKeyVersion: 2,
    payload: {
      algorithm: "AES-256-GCM",
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      ciphertextSha256: "a".repeat(64),
    },
  };
}

function reviewResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    review: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      reviewId: REVIEW_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      sourceVersionId: VERSION_ID,
      sourceVersionRevision: 3,
      sourceCiphertextSha256: "b".repeat(64),
      projectKeyVersion: 2,
      submittedByMembershipId: MEMBERSHIP_ID,
      state: "pending",
      revision: 1,
      decisionByMembershipId: null,
      decidedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      payload: submissionRequest().payload,
    },
  };
}

function suggestionDecisionResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    effect: "metadata_only_no_content_mutation",
    thread: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      threadId: THREAD_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      reviewId: REVIEW_ID,
      rootItemId: ITEM_ID,
      state: "open",
      revision: 1,
      itemCount: 1,
      createdByMembershipId: MEMBERSHIP_ID,
      resolvedByMembershipId: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    item: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      itemId: ITEM_ID,
      threadId: THREAD_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      reviewId: REVIEW_ID,
      itemType: "suggestion",
      parentItemId: null,
      payload: submissionRequest().payload,
      createdByMembershipId: MEMBERSHIP_ID,
      revision: 2,
      suggestionDecision: "accepted",
      suggestionDecidedByMembershipId: MEMBERSHIP_ID,
      suggestionDecidedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}
