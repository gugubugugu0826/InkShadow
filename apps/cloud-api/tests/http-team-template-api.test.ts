import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloudApiErrorResponseSchema,
  CloudTeamTemplateApplicationResponseSchema,
  CloudTeamTemplateListResponseSchema,
  CloudTeamTemplateMutationResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudTeamTemplateCreateRequest,
  type CloudTeamTemplateSummary,
  type CloudTeamTemplateVersionSummary,
} from "@inkshadow/contracts";

import { createCloudApiServer } from "../src/http/server.js";
import type { CloudIdentityService, CloudPrincipal } from "../src/service/identity-service.js";
import type { CloudProjectSyncService } from "../src/service/project-sync-service.js";
import type { CloudTeamTemplateService } from "../src/service/team-template-service.js";

const REQUEST_ID = uuid(1);
const ACCOUNT_ID = uuid(2);
const DEVICE_ID = uuid(3);
const SESSION_ID = uuid(4);
const TENANT_ID = uuid(5);
const TEAM_ID = uuid(6);
const PROJECT_ID = uuid(7);
const TEMPLATE_ID = uuid(8);
const VERSION_ID = uuid(9);
const MEMBERSHIP_ID = uuid(10);
const APPLICATION_ID = uuid(11);
const NOW = "2026-07-28T10:00:00.000Z";
const ACCESS_TOKEN = "a".repeat(64);

const principal: CloudPrincipal = {
  accountId: ACCOUNT_ID,
  deviceId: DEVICE_ID,
  sessionId: SESSION_ID,
};

const servers: ReturnType<typeof createCloudApiServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("encrypted team-template HTTP boundary", () => {
  it("registers all ten frozen routes", async () => {
    const server = createServer(teamTemplateServiceStub());
    await server.ready();

    for (const [method, url] of [
      ["POST", "/v1/teams/:teamId/projects/:projectId/templates"],
      ["GET", "/v1/teams/:teamId/projects/:projectId/templates"],
      ["GET", "/v1/teams/:teamId/projects/:projectId/templates/:templateId"],
      ["POST", "/v1/teams/:teamId/projects/:projectId/templates/:templateId/versions"],
      ["GET", "/v1/teams/:teamId/projects/:projectId/templates/:templateId/versions"],
      ["GET", "/v1/teams/:teamId/projects/:projectId/templates/:templateId/versions/:versionId"],
      ["POST", "/v1/teams/:teamId/projects/:projectId/templates/:templateId/clones"],
      ["POST", "/v1/teams/:teamId/projects/:projectId/templates/:templateId/publications"],
      ["POST", "/v1/teams/:teamId/projects/:projectId/templates/:templateId/archives"],
      ["POST", "/v1/teams/:teamId/projects/:projectId/templates/:templateId/applications"],
    ] as const) {
      expect(server.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
  });

  it("executes encrypted create, list and metadata-only application routes", async () => {
    const service = teamTemplateServiceStub();
    const server = createServer(service);

    const createResponse = await server.inject({
      method: "POST",
      url: `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/templates`,
      headers: mutationHeaders("team-template-create-idempotency-0001"),
      payload: createRequest(),
    });
    expect(createResponse.statusCode).toBe(201);
    expect(CloudTeamTemplateMutationResponseSchema.parse(createResponse.json())).toEqual(
      mutationResponse(),
    );
    expect(service.createTemplate.mock.calls).toContainEqual([
      principal,
      TEAM_ID,
      PROJECT_ID,
      createRequest(),
      {
        idempotencyKey: "team-template-create-idempotency-0001",
        requestId: REQUEST_ID,
      },
    ]);

    const listResponse = await server.inject({
      method: "GET",
      url: `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/templates?limit=12`,
      headers: readHeaders(),
    });
    expect(listResponse.statusCode).toBe(200);
    expect(CloudTeamTemplateListResponseSchema.parse(listResponse.json())).toEqual({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      templates: [templateSummary()],
      nextCursor: null,
    });
    expect(service.listTemplates.mock.calls).toContainEqual([
      principal,
      TEAM_ID,
      PROJECT_ID,
      null,
      12,
      { requestId: REQUEST_ID },
    ]);

    const applicationResponse = await server.inject({
      method: "POST",
      url: `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/templates/${TEMPLATE_ID}/applications`,
      headers: mutationHeaders("team-template-application-idempotency-0001"),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        applicationId: APPLICATION_ID,
        expectedRevision: 3,
        versionId: VERSION_ID,
      },
    });
    expect(applicationResponse.statusCode).toBe(201);
    expect(CloudTeamTemplateApplicationResponseSchema.parse(applicationResponse.json())).toEqual(
      applicationResponseBody(),
    );
    expect(applicationResponse.body).not.toContain("ciphertext");
    expect(applicationResponse.body).not.toContain("title");
  });

  it("rejects plaintext extension fields before the service and fails closed without a service", async () => {
    const service = teamTemplateServiceStub();
    const server = createServer(service);
    const invalidResponse = await server.inject({
      method: "POST",
      url: `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/templates`,
      headers: mutationHeaders("team-template-invalid-idempotency-0001"),
      payload: { ...createRequest(), title: "must never reach cloud" },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(CloudApiErrorResponseSchema.parse(invalidResponse.json()).error.code).toBe(
      "VALIDATION_FAILED",
    );
    expect(service.createTemplate.mock.calls).toHaveLength(0);

    const unavailableServer = createServer();
    const unavailableResponse = await unavailableServer.inject({
      method: "POST",
      url: `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/templates`,
      headers: mutationHeaders("team-template-unavailable-idempotency-0001"),
      payload: createRequest(),
    });
    expect(unavailableResponse.statusCode).toBe(503);
    expect(CloudApiErrorResponseSchema.parse(unavailableResponse.json()).error.code).toBe(
      "SERVICE_UNAVAILABLE",
    );
  });
});

function createServer(teamTemplateService?: CloudTeamTemplateService) {
  const identityService = {
    authenticateAccessToken: () => Promise.resolve(principal),
  } as unknown as CloudIdentityService;
  const server = createCloudApiServer({
    identityService,
    projectSyncService: {} as CloudProjectSyncService,
    ...(teamTemplateService === undefined ? {} : { teamTemplateService }),
    requireHttps: false,
    uuid: () => REQUEST_ID,
  });
  servers.push(server);
  return server;
}

function teamTemplateServiceStub() {
  const service = {
    createTemplate: vi.fn(() => Promise.resolve(mutationResponse())),
    listTemplates: vi.fn(() =>
      Promise.resolve({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        templates: [templateSummary()],
        nextCursor: null,
      }),
    ),
    recordApplication: vi.fn(() => Promise.resolve(applicationResponseBody())),
  };
  return service as unknown as CloudTeamTemplateService & typeof service;
}

function createRequest(): CloudTeamTemplateCreateRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    templateId: TEMPLATE_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    projectKeyVersion: 1,
    authorDeviceId: DEVICE_ID,
    payload: {
      algorithm: "AES-256-GCM",
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      ciphertextSha256: "a".repeat(64),
      aad: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        purpose: "inkshadow.studio.team-template",
        tenantId: TENANT_ID,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        templateId: TEMPLATE_ID,
        versionId: VERSION_ID,
        versionNumber: 1,
        projectKeyVersion: 1,
      },
    },
  };
}

function templateSummary(): CloudTeamTemplateSummary {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    templateId: TEMPLATE_ID,
    state: "published",
    revision: 3,
    latestVersionNumber: 1,
    publishedVersionNumber: 1,
    createdByMembershipId: MEMBERSHIP_ID,
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: NOW,
    archivedAt: null,
  };
}

function versionSummary(): CloudTeamTemplateVersionSummary {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    templateId: TEMPLATE_ID,
    versionId: VERSION_ID,
    versionNumber: 1,
    projectKeyVersion: 1,
    authorMembershipId: MEMBERSHIP_ID,
    authorDeviceId: DEVICE_ID,
    clonedFromTemplateId: null,
    clonedFromVersionId: null,
    createdAt: NOW,
  };
}

function mutationResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    template: templateSummary(),
    version: versionSummary(),
  };
}

function applicationResponseBody() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    templateId: TEMPLATE_ID,
    versionId: VERSION_ID,
    appliedByMembershipId: MEMBERSHIP_ID,
    appliedAt: NOW,
    effect: "metadata_only_no_server_content_mutation" as const,
  };
}

function mutationHeaders(idempotencyKey: string): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${ACCESS_TOKEN}`,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-request-id": REQUEST_ID,
  };
}

function readHeaders(): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${ACCESS_TOKEN}`,
    "x-request-id": REQUEST_ID,
  };
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
