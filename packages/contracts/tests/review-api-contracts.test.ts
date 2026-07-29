import { describe, expect, it } from "vitest";

import {
  CLOUD_API_OPERATIONS,
  CloudReviewSubmissionRequestSchema,
  CloudReviewSuggestionDecisionResponseSchema,
  CloudReviewThreadItemAppendRequestSchema,
  CloudReviewThreadItemResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  getCloudApiOperation,
} from "../src/index.js";

const ids = {
  item: "018f0f9f-6f00-7001-8000-000000000001",
  membership: "018f0f9f-6f00-7001-8000-000000000002",
  project: "018f0f9f-6f00-7001-8000-000000000003",
  review: "018f0f9f-6f00-7001-8000-000000000004",
  source: "018f0f9f-6f00-7001-8000-000000000005",
  team: "018f0f9f-6f00-7001-8000-000000000006",
  tenant: "018f0f9f-6f00-7001-8000-000000000007",
  thread: "018f0f9f-6f00-7001-8000-000000000008",
  request: "018f0f9f-6f00-7001-8000-000000000009",
} as const;

const payload = {
  algorithm: "AES-256-GCM" as const,
  nonce: "AAAAAAAAAAAAAAAA",
  ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  ciphertextSha256: "a".repeat(64),
};

describe("Studio encrypted review API contracts", () => {
  it("accepts only bounded ciphertext review submissions with exact version/key metadata", () => {
    const submission = CloudReviewSubmissionRequestSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      reviewId: ids.review,
      teamId: ids.team,
      projectId: ids.project,
      sourceVersionId: ids.source,
      sourceVersionRevision: 3,
      sourceCiphertextSha256: "b".repeat(64),
      projectKeyVersion: 4,
      payload,
    });
    expect(submission.payload).toEqual(payload);
    expect(
      CloudReviewSubmissionRequestSchema.safeParse({
        ...submission,
        plaintext: "must never cross the cloud boundary",
      }).success,
    ).toBe(false);
    expect(
      CloudReviewSubmissionRequestSchema.safeParse({
        ...submission,
        payload: { ...payload, nonce: "too-short" },
      }).success,
    ).toBe(false);
    expect(
      CloudReviewSubmissionRequestSchema.safeParse({
        ...submission,
        payload: { ...payload, ciphertext: "A".repeat(349_548) },
      }).success,
    ).toBe(false);
  });

  it("binds root and reply item shapes to explicit thread CAS", () => {
    expect(
      CloudReviewThreadItemAppendRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        threadId: ids.thread,
        itemId: ids.item,
        itemType: "suggestion",
        parentItemId: null,
        expectedThreadRevision: null,
        payload,
      }).success,
    ).toBe(true);
    expect(
      CloudReviewThreadItemAppendRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        threadId: ids.thread,
        itemId: ids.item,
        itemType: "reply",
        parentItemId: null,
        expectedThreadRevision: 1,
        payload,
      }).success,
    ).toBe(false);
  });

  it("makes suggestion decisions metadata-only and keeps item ciphertext unchanged in shape", () => {
    const thread = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      threadId: ids.thread,
      tenantId: ids.tenant,
      teamId: ids.team,
      projectId: ids.project,
      reviewId: ids.review,
      rootItemId: ids.item,
      state: "open",
      revision: 1,
      itemCount: 1,
      createdByMembershipId: ids.membership,
      resolvedByMembershipId: null,
      resolvedAt: null,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    } as const;
    const item = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      itemId: ids.item,
      threadId: ids.thread,
      tenantId: ids.tenant,
      teamId: ids.team,
      projectId: ids.project,
      reviewId: ids.review,
      itemType: "suggestion",
      parentItemId: null,
      payload,
      createdByMembershipId: ids.membership,
      revision: 2,
      suggestionDecision: "accepted",
      suggestionDecidedByMembershipId: ids.membership,
      suggestionDecidedAt: "2026-07-28T00:01:00.000Z",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:01:00.000Z",
    } as const;
    expect(
      CloudReviewSuggestionDecisionResponseSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: ids.request,
        effect: "metadata_only_no_content_mutation",
        thread,
        item,
      }).effect,
    ).toBe("metadata_only_no_content_mutation");
    expect(
      CloudReviewThreadItemResponseSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: ids.request,
        thread,
        item: { ...item, projectId: ids.source },
      }).success,
    ).toBe(false);
  });

  it("publishes every review operation with authentication and mutation idempotency", () => {
    const operationIds = [
      "reviews.submit",
      "reviews.list",
      "reviews.get",
      "reviewDecisions.create",
      "reviewThreadItems.append",
      "reviewThreadItems.list",
      "reviewThreads.resolve",
      "reviewSuggestionDecisions.create",
    ] as const;
    expect(CLOUD_API_OPERATIONS.map((operation) => operation.operationId)).toEqual(
      expect.arrayContaining([...operationIds]),
    );
    for (const operationId of operationIds) {
      const operation = getCloudApiOperation(operationId);
      expect(operation.requiresAuthentication).toBe(true);
      expect(operation.requiresIdempotencyKey).toBe(operation.method === "post");
    }
  });
});
