import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import type { CloudMarketplaceActor } from "../src/domain/marketplace-records.js";
import {
  registerCloudMarketplaceRoutes,
  type CloudMarketplaceRouteService,
} from "../src/http/marketplace-routes.js";
import { createCloudApiServer } from "../src/http/server.js";
import type { CloudIdentityService } from "../src/service/identity-service.js";
import type { CloudMarketplaceService } from "../src/service/marketplace-service.js";
import type { CloudProjectSyncService } from "../src/service/project-sync-service.js";
import { CloudServiceError } from "../src/service/errors.js";

const ARTIFACT_ID = "0198b222-0000-7000-8000-000000000001";
const VERSION_ID = "0198b222-0000-7000-8000-000000000002";
const ACCOUNT_ID = "0198b222-0000-7000-8000-000000000003";
const DEVICE_ID = "0198b222-0000-7000-8000-000000000004";
const REQUEST_ID = "0198b222-0000-7000-8000-000000000005";
const CREATED_AT = "2026-07-29T04:00:00.000Z";

describe("marketplace HTTP routes", () => {
  it("validates catalog output and preserves request correlation", async () => {
    const listCatalog = vi.fn(() => Promise.resolve(catalogResponse()));
    const server = createServer({ ...unusedService(), listCatalog });
    const response = await server.inject({
      method: "GET",
      url: "/v1/marketplace/artifacts?kind=story_template&limit=25",
      headers: { "x-request-id": REQUEST_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(catalogResponse());
    expect(listCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT_ID }),
      "story_template",
      null,
      25,
      { requestId: REQUEST_ID },
    );
    await server.close();
  });

  it("rejects script-bearing submissions before invoking the service", async () => {
    const submitVersion = vi.fn(() => Promise.resolve(submissionResponse()));
    const server = createServer({ ...unusedService(), submitVersion });
    const request = submissionRequest();
    const firstSection = request.content.sections[0];
    if (firstSection === undefined) {
      throw new Error("Submission fixture requires a first section.");
    }
    firstSection.items[0] = {
      itemId: "premise",
      kind: "text",
      label: "Premise",
      value: "<script>steal()</script>",
    };
    const response = await server.inject({
      method: "POST",
      url: "/v1/marketplace/artifacts/submissions",
      headers: {
        "idempotency-key": "market-http-submission-0001",
        "x-request-id": REQUEST_ID,
      },
      payload: request,
    });
    expect(response.statusCode).toBe(400);
    expect(submitVersion).not.toHaveBeenCalled();
    await server.close();
  });

  it("routes high-risk moderation with server-derived actor assurance", async () => {
    const moderateVersion = vi.fn(() => Promise.resolve(submissionResponse("published")));
    const server = createServer(
      { ...unusedService(), moderateVersion },
      {
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        platformRole: "platform_ops",
        strongMfa: true,
      },
    );
    const response = await server.inject({
      method: "POST",
      url: `/v1/marketplace/artifacts/${ARTIFACT_ID}/versions/${VERSION_ID}/moderation`,
      headers: {
        "idempotency-key": "market-http-moderation-0001",
        "x-request-id": REQUEST_ID,
      },
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        action: "approve",
        expectedRevision: 1,
        reason: "Verified digest, signature, license and structured content.",
        confirmation: `MARKETPLACE:APPROVE:${VERSION_ID}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(moderateVersion).toHaveBeenCalledWith(
      expect.objectContaining({ platformRole: "platform_ops", strongMfa: true }),
      ARTIFACT_ID,
      VERSION_ID,
      expect.objectContaining({ action: "approve", expectedRevision: 1 }),
      { idempotencyKey: "market-http-moderation-0001", requestId: REQUEST_ID },
    );
    await server.close();
  });

  it("fails closed when the marketplace service is not wired", async () => {
    const server = createServer(undefined);
    const response = await server.inject({
      method: "GET",
      url: "/v1/marketplace/artifacts",
      headers: { "x-request-id": REQUEST_ID },
    });
    expect(response.statusCode).toBe(503);
    await server.close();
  });

  it("derives an ordinary member actor from the authenticated session and ignores role headers", async () => {
    const listCatalog = vi.fn(() => Promise.resolve(catalogResponse()));
    const authenticateAccessToken = vi.fn(() =>
      Promise.resolve({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        sessionId: "0198b222-0000-7000-8000-000000000006",
      }),
    );
    const server = createCloudApiServer({
      identityService: {
        authenticateAccessToken,
      } as unknown as CloudIdentityService,
      marketplaceService: {
        ...unusedService(),
        listCatalog,
      } as unknown as CloudMarketplaceService,
      projectSyncService: {} as CloudProjectSyncService,
      uuid: () => REQUEST_ID,
    });
    const response = await server.inject({
      method: "GET",
      url: "/v1/marketplace/artifacts",
      headers: {
        authorization: `Bearer ${"a".repeat(43)}`,
        "x-marketplace-platform-role": "platform_ops",
        "x-marketplace-strong-mfa": "true",
        "x-request-id": REQUEST_ID,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(listCatalog).toHaveBeenCalledWith(
      {
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        platformRole: "member",
        strongMfa: false,
      },
      null,
      null,
      50,
      { requestId: REQUEST_ID },
    );
    await server.close();
  });
});

function createServer(
  marketplaceService?: CloudMarketplaceRouteService,
  actor: CloudMarketplaceActor = {
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    platformRole: "member",
    strongMfa: false,
  },
) {
  const server = Fastify();
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof CloudServiceError) {
      return reply.status(error.httpStatus).send({
        requestId: REQUEST_ID,
        error: { code: error.code, message: error.message },
      });
    }
    return reply.status(500).send({ error: "internal" });
  });
  registerCloudMarketplaceRoutes(server, {
    authenticate: () => Promise.resolve(actor),
    enforceMutationRate: () => Promise.resolve(),
    enforceReadRate: () => Promise.resolve(),
    ...(marketplaceService === undefined ? {} : { marketplaceService }),
    mutationContext: (request) => ({
      idempotencyKey: String(request.headers["idempotency-key"] ?? ""),
      requestId: String(request.headers["x-request-id"]),
    }),
    readContext: (request) => ({
      requestId: String(request.headers["x-request-id"]),
    }),
  });
  return server;
}

function unusedService(): CloudMarketplaceRouteService {
  const unused = (): Promise<never> =>
    Promise.reject(new Error("Unexpected marketplace service invocation."));
  return {
    appealVersion: unused,
    disposeAppeal: unused,
    disposeReport: unused,
    download: unused,
    listCatalog: unused,
    listModerationQueue: unused,
    moderateVersion: unused,
    reportVersion: unused,
    submitVersion: unused,
    withdrawVersion: unused,
  };
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
    content: {
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
    },
    contentDigestSha256: "a".repeat(64),
    authorPublicKeySpki: "A".repeat(60),
    authorSignature: "B".repeat(86),
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

function submissionResponse(state: "pending_review" | "published" = "pending_review") {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    artifact: artifactSummary(state),
    version: versionMetadata(state),
  };
}
