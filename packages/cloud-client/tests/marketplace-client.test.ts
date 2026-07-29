import { describe, expect, it, vi } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";

import { CloudMarketplaceClient } from "../src/marketplace-client.js";
import type { CloudTransport } from "../src/transport.js";

const ARTIFACT_ID = "0198b333-0000-7000-8000-000000000001";
const VERSION_ID = "0198b333-0000-7000-8000-000000000002";
const ACCOUNT_ID = "0198b333-0000-7000-8000-000000000003";
const REQUEST_ID = "0198b333-0000-7000-8000-000000000004";
const CREATED_AT = "2026-07-29T05:00:00.000Z";

describe("CloudMarketplaceClient", () => {
  it("builds bounded catalog requests and validates correlated responses", async () => {
    const send = vi.fn(async () => ({
      status: 200,
      headers: { "x-request-id": REQUEST_ID },
      body: catalogResponse(),
    }));
    const client = createClient({ send });
    await expect(client.listCatalog({ kind: "story_template", limit: 25 })).resolves.toEqual(
      catalogResponse(),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/v1/marketplace/artifacts?kind=story_template&limit=25",
        authentication: "session",
        headers: expect.objectContaining({
          Authorization: `Bearer ${"t".repeat(48)}`,
          "X-Request-Id": REQUEST_ID,
        }),
      }),
    );
  });

  it("sends strict submissions with stable idempotency and rejects unsafe bodies locally", async () => {
    const send = vi.fn(async () => ({
      status: 201,
      headers: { "x-request-id": REQUEST_ID },
      body: submissionResponse(),
    }));
    const client = createClient({ send });
    const request = submissionRequest();
    await expect(
      client.submitVersion(request, { idempotencyKey: "market-client-submit-0001" }),
    ).resolves.toEqual(submissionResponse());
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/v1/marketplace/artifacts/submissions",
        headers: expect.objectContaining({
          "Idempotency-Key": "market-client-submit-0001",
        }),
        body: request,
      }),
    );

    const unsafe = submissionRequest();
    const firstSection = unsafe.content.sections[0];
    if (firstSection === undefined) {
      throw new Error("Submission fixture requires a first section.");
    }
    firstSection.items[0] = {
      itemId: "premise",
      kind: "text",
      label: "Premise",
      value: "javascript:run()",
    };
    await expect(
      client.submitVersion(unsafe, { idempotencyKey: "market-client-submit-0002" }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fails closed on response-correlation drift", async () => {
    const send = vi.fn(async () => ({
      status: 200,
      headers: { "x-request-id": "0198b333-0000-7000-8000-000000000099" },
      body: catalogResponse(),
    }));
    const client = createClient({ send });
    await expect(client.listCatalog()).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });
  });

  it("parses stable redacted server failures without trusting arbitrary JSON", async () => {
    const send = vi.fn(async () => ({
      status: 503,
      headers: { "x-request-id": REQUEST_ID },
      body: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "The marketplace is disabled.",
          retryable: true,
          actions: ["USE_LOCAL"],
          supportId: null,
        },
      },
    }));
    const client = createClient({ send });
    await expect(client.listCatalog()).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
      retryable: true,
      actions: ["USE_LOCAL"],
    });
  });
});

function createClient(overrides: Pick<CloudTransport, "send">): CloudMarketplaceClient {
  return new CloudMarketplaceClient({
    accessTokens: { readAccessToken: async () => "t".repeat(48) },
    requestIdFactory: () => REQUEST_ID,
    transport: { send: overrides.send },
  });
}

function submissionRequest() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: ARTIFACT_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    semanticVersion: "1.0.0",
    authorAccountId: ACCOUNT_ID,
    authorDisplayName: "Ink Cartographer",
    kind: "story_template" as const,
    title: "The Vanished City",
    summary: "A structured story seed for mystery adventures.",
    tags: ["adventure", "mystery"],
    license: "cc-by-4.0" as const,
    content: structuredContent(),
    contentDigestSha256: "a".repeat(64),
    authorPublicKeySpki: "A".repeat(60),
    authorSignature: "B".repeat(86),
  };
}

function structuredContent() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    format: "inkshadow.marketplace.structured-artifact.v1" as const,
    sections: [
      {
        sectionId: "story_seed",
        title: "Story seed",
        items: [
          {
            itemId: "premise",
            kind: "text" as const,
            label: "Premise",
            value: "A cartographer discovers a city erased from every map.",
          },
        ],
      },
    ],
  };
}

function artifactSummary(state: "pending_review" | "published" = "published") {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: ARTIFACT_ID,
    authorAccountId: ACCOUNT_ID,
    authorDisplayName: "Ink Cartographer",
    kind: "story_template" as const,
    title: "The Vanished City",
    summary: "A structured story seed for mystery adventures.",
    tags: ["adventure", "mystery"],
    license: "cc-by-4.0" as const,
    state,
    revision: state === "published" ? 2 : 1,
    latestVersionNumber: 1,
    pendingVersionId: state === "pending_review" ? VERSION_ID : null,
    publishedVersionId: state === "published" ? VERSION_ID : null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    publishedAt: state === "published" ? CREATED_AT : null,
    quarantinedAt: null,
    withdrawnAt: null,
    retentionUntil: null,
  };
}

function versionMetadata(state: "pending_review" | "published" = "pending_review") {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    artifactId: ARTIFACT_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    semanticVersion: "1.0.0",
    state,
    contentDigestSha256: "a".repeat(64),
    authorSigningKeyFingerprintSha256: "b".repeat(64),
    contentBytes: 256,
    createdAt: CREATED_AT,
    submittedAt: CREATED_AT,
    reviewedAt: state === "published" ? CREATED_AT : null,
    publishedAt: state === "published" ? CREATED_AT : null,
    quarantinedAt: null,
    withdrawnAt: null,
    retentionUntil: null,
  };
}

function catalogResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    artifacts: [artifactSummary("published")],
    nextCursor: null,
  };
}

function submissionResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    artifact: artifactSummary("pending_review"),
    version: versionMetadata("pending_review"),
  };
}
