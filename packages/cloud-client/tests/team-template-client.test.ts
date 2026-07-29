import { describe, expect, it } from "vitest";

import { CONTRACT_SCHEMA_VERSION, type CloudTeamTemplateCreateRequest } from "@inkshadow/contracts";

import {
  InkShadowCloudApiClient,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../src/index.js";

const ids = {
  application: "018f1b00-0000-7001-8000-000000000001",
  device: "018f1b00-0000-7001-8000-000000000002",
  membership: "018f1b00-0000-7001-8000-000000000003",
  project: "018f1b00-0000-7001-8000-000000000004",
  request: "018f1b00-0000-7001-8000-000000000005",
  team: "018f1b00-0000-7001-8000-000000000006",
  template: "018f1b00-0000-7001-8000-000000000007",
  tenant: "018f1b00-0000-7001-8000-000000000008",
  version: "018f1b00-0000-7001-8000-000000000009",
} as const;
const IDEMPOTENCY_KEY = "team-template-operation-0001";
const ACCESS_TOKEN = "t".repeat(64);
const NOW = "2026-07-28T00:00:00.000Z";

describe("InkShadowCloudApiClient encrypted team templates", () => {
  it("uses project-scoped routes, authentication and idempotency without plaintext metadata", async () => {
    const request = createRequest();
    const transport = new RecordingTransport((outbound) => {
      expect(outbound.authentication).toBe("session");
      expect(outbound.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      switch (`${outbound.method} ${outbound.path}`) {
        case `POST /v1/teams/${ids.team}/projects/${ids.project}/templates`:
          expect(outbound.headers["Idempotency-Key"]).toBe(IDEMPOTENCY_KEY);
          expect(outbound.body).toEqual(request);
          return success(mutationResponse(), 201);
        case `GET /v1/teams/${ids.team}/projects/${ids.project}/templates?limit=25`:
          expect(outbound.headers["Idempotency-Key"]).toBeUndefined();
          return success({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            requestId: ids.request,
            templates: [templateSummary()],
            nextCursor: null,
          });
        case `GET /v1/teams/${ids.team}/projects/${ids.project}/templates/${ids.template}/versions/${ids.version}`:
          return success({
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            requestId: ids.request,
            version: { ...versionSummary(), payload: request.payload },
          });
        case `POST /v1/teams/${ids.team}/projects/${ids.project}/templates/${ids.template}/applications`:
          expect(outbound.headers["Idempotency-Key"]).toBe(IDEMPOTENCY_KEY);
          return success(
            {
              schemaVersion: CONTRACT_SCHEMA_VERSION,
              requestId: ids.request,
              applicationId: ids.application,
              tenantId: ids.tenant,
              teamId: ids.team,
              projectId: ids.project,
              templateId: ids.template,
              versionId: ids.version,
              appliedByMembershipId: ids.membership,
              appliedAt: NOW,
              effect: "metadata_only_no_server_content_mutation",
            },
            201,
          );
        default:
          throw new Error(`Unexpected template request: ${outbound.method} ${outbound.path}`);
      }
    });
    const client = createClient(transport);

    await expect(
      client.createTeamTemplate(ids.team, ids.project, request, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toEqual(mutationResponse());
    await expect(
      client.listTeamTemplates(ids.team, ids.project, { limit: 25 }),
    ).resolves.toMatchObject({ templates: [{ templateId: ids.template }] });
    await expect(
      client.getTeamTemplateVersion(ids.team, ids.project, ids.template, ids.version),
    ).resolves.toMatchObject({ version: { payload: request.payload } });
    await expect(
      client.recordTeamTemplateApplication(
        ids.team,
        ids.project,
        ids.template,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          applicationId: ids.application,
          expectedRevision: 2,
          versionId: ids.version,
        },
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).resolves.toMatchObject({
      applicationId: ids.application,
      effect: "metadata_only_no_server_content_mutation",
    });
    expect(transport.requests).toHaveLength(4);
  });

  it("rejects cross-project ciphertext before transport and cross-scope responses after transport", async () => {
    const neverTransport = new RecordingTransport(() => {
      throw new Error("Transport must not be reached.");
    });
    const client = createClient(neverTransport);
    await expect(
      client.createTeamTemplate(
        ids.team,
        ids.project,
        {
          ...createRequest(),
          payload: {
            ...createRequest().payload,
            aad: { ...createRequest().payload.aad, projectId: ids.team },
          },
        },
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    expect(neverTransport.requests).toHaveLength(0);

    const crossed = createClient(
      new RecordingTransport(() =>
        success(
          {
            ...mutationResponse(),
            template: { ...templateSummary(), projectId: ids.team },
            version: { ...versionSummary(), projectId: ids.team },
          },
          201,
        ),
      ),
    );
    await expect(
      crossed.createTeamTemplate(ids.team, ids.project, createRequest(), {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_PROTOCOL_INVALID_RESPONSE" });
  });
});

function createRequest(): CloudTeamTemplateCreateRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    templateId: ids.template,
    versionId: ids.version,
    versionNumber: 1,
    projectKeyVersion: 3,
    authorDeviceId: ids.device,
    payload: {
      algorithm: "AES-256-GCM",
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
      ciphertextSha256: "a".repeat(64),
      aad: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        purpose: "inkshadow.studio.team-template",
        tenantId: ids.tenant,
        teamId: ids.team,
        projectId: ids.project,
        templateId: ids.template,
        versionId: ids.version,
        versionNumber: 1,
        projectKeyVersion: 3,
      },
    },
  };
}

function templateSummary() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: ids.tenant,
    teamId: ids.team,
    projectId: ids.project,
    templateId: ids.template,
    state: "draft",
    revision: 1,
    latestVersionNumber: 1,
    publishedVersionNumber: null,
    createdByMembershipId: ids.membership,
    createdAt: NOW,
    updatedAt: NOW,
    publishedAt: null,
    archivedAt: null,
  } as const;
}

function versionSummary() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    tenantId: ids.tenant,
    teamId: ids.team,
    projectId: ids.project,
    templateId: ids.template,
    versionId: ids.version,
    versionNumber: 1,
    projectKeyVersion: 3,
    authorMembershipId: ids.membership,
    authorDeviceId: ids.device,
    clonedFromTemplateId: null,
    clonedFromVersionId: null,
    createdAt: NOW,
  } as const;
}

function mutationResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: ids.request,
    template: templateSummary(),
    version: versionSummary(),
  } as const;
}

function createClient(transport: CloudTransport): InkShadowCloudApiClient {
  return new InkShadowCloudApiClient({
    accessTokens: { readAccessToken: () => Promise.resolve(ACCESS_TOKEN) },
    requestIdFactory: () => ids.request,
    transport,
  });
}

function success(body: unknown, status = 200): CloudTransportResponse {
  return { status, headers: { "x-request-id": ids.request }, body };
}

class RecordingTransport implements CloudTransport {
  public readonly requests: CloudTransportRequest[] = [];

  public constructor(
    private readonly handler: (request: CloudTransportRequest) => CloudTransportResponse,
  ) {}

  public send(request: CloudTransportRequest): Promise<CloudTransportResponse> {
    this.requests.push(request);
    return Promise.resolve(this.handler(request));
  }
}
