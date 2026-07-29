import { describe, expect, it } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  type CloudEnterprisePolicyUpdateRequest,
  type CloudEnterpriseSsoAuthorizationRequest,
} from "@inkshadow/contracts";

import {
  InkShadowCloudApiClient,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../src/index.js";

const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const FLOW_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const NOW = "2026-07-28T00:00:00.000Z";
const IDEMPOTENCY_KEY = "enterprise-idempotency-key-0001";

describe("Enterprise cloud client", () => {
  it("sends revision-bound organization policy through the authenticated route", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request).toMatchObject({
        method: "PUT",
        path: `/v1/teams/${TEAM_ID}/enterprise/policy`,
        authentication: "session",
        headers: {
          "X-Request-Id": REQUEST_ID,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
      });
      return success(policyResponse());
    });
    const client = createClient(transport);
    const response = await client.updateEnterprisePolicy(TEAM_ID, policyUpdate(), {
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(response.policy.revision).toBe(1);
  });

  it("creates an unauthenticated, idempotent and team-bound authorization flow", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request).toMatchObject({
        method: "POST",
        path: "/v1/enterprise/sso/authorizations",
        authentication: "none",
        headers: {
          "X-Request-Id": REQUEST_ID,
          "Idempotency-Key": IDEMPOTENCY_KEY,
        },
      });
      return success(
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          teamId: TEAM_ID,
          flowId: FLOW_ID,
          flowSecret: "f".repeat(43),
          authorizationUrl: "https://idp.example.test/oauth/authorize?client_id=inkshadow",
          expiresAt: "2026-07-28T00:10:00.000Z",
        },
        201,
      );
    });
    const client = createClient(transport);
    await expect(
      client.authorizeEnterpriseSso(authorizationRequest(), {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toMatchObject({ flowId: FLOW_ID, teamId: TEAM_ID });
  });

  it("fails closed when an Enterprise response crosses its requested team scope", async () => {
    const transport = new RecordingTransport(() =>
      success({
        ...policyResponse(),
        policy: {
          ...policyResponse().policy,
          teamId: "018f0d7a-3b2c-7abc-8def-000000000099",
        },
      }),
    );
    const client = createClient(transport);
    await expect(client.getEnterprisePolicy(TEAM_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    });
  });
});

class RecordingTransport implements CloudTransport {
  public readonly handlesSessionAuthentication = true;
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
    requestIdFactory: () => REQUEST_ID,
    transport,
  });
}

function policyUpdate(): CloudEnterprisePolicyUpdateRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    expectedRevision: null,
    ssoMode: "optional",
    allowedEmailDomains: ["example.com"],
    sessionMaximumMinutes: 480,
    maximumTrustedDevices: 3,
    deviceApprovalMode: "trusted_device",
    approvedDeviceFingerprints: [],
    exportMode: "owners_and_admins",
    externalEgressMode: "blocked",
    allowedExternalHosts: [],
    supportBundleMode: "owners_and_admins",
  };
}

function policyResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    policy: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      revision: 1,
      ssoMode: "optional",
      allowedEmailDomains: ["example.com"],
      sessionMaximumMinutes: 480,
      maximumTrustedDevices: 3,
      deviceApprovalMode: "trusted_device",
      approvedDeviceFingerprints: [],
      exportMode: "owners_and_admins",
      externalEgressMode: "blocked",
      allowedExternalHosts: [],
      supportBundleMode: "owners_and_admins",
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function authorizationRequest(): CloudEnterpriseSsoAuthorizationRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    teamId: TEAM_ID,
    redirectUri: "inkshadow://enterprise/sso/callback",
    device: {
      deviceId: DEVICE_ID,
      displayName: "Private workstation",
      algorithm: "DHKEM-P256-HKDF-SHA256",
      publicKey: "A".repeat(87),
      publicKeyFingerprint: "a1".repeat(32),
      clientVersion: "0.1.0",
    },
  };
}

function success(body: unknown, status = 200): CloudTransportResponse {
  return {
    status,
    headers: { "x-request-id": REQUEST_ID },
    body,
  };
}
