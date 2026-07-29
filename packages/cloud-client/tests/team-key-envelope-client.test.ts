import { describe, expect, it } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  type CloudTeamProjectKeyEnvelopePublishRequest,
} from "@inkshadow/contracts";

import {
  InkShadowCloudApiClient,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../src/index.js";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const OTHER_TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const ASSIGNMENT_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const SENDER_DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const RECIPIENT_DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const OTHER_DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const ENVELOPE_ID = "018f0d7a-3b2c-7abc-8def-00000000000a";
const ACCESS_TOKEN = "t".repeat(64);
const IDEMPOTENCY_KEY = "team-envelope-publication-0001";
const NOW = "2026-07-28T00:00:00.000Z";

describe("InkShadowCloudApiClient team-project key envelopes", () => {
  it("uses the four frozen session-authenticated routes and idempotency only for publication", async () => {
    const request = publishRequest();
    const transport = new RecordingTransport((outbound) => {
      expect(outbound.authentication).toBe("session");
      expect(outbound.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
      switch (`${outbound.method} ${outbound.path}`) {
        case `GET /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/keys/current`:
          expect(outbound.body).toBeNull();
          expect(outbound.headers["Idempotency-Key"]).toBeUndefined();
          return success(currentKeyResponse());
        case `GET /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/keys/3/recipients`:
          expect(outbound.body).toBeNull();
          expect(outbound.headers["Idempotency-Key"]).toBeUndefined();
          return success(eligibleRecipientResponse());
        case `POST /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/keys/3/envelopes`:
          expect(outbound.headers["Idempotency-Key"]).toBe(IDEMPOTENCY_KEY);
          expect(outbound.body).toEqual(request);
          return success(envelopeResponse(), 201);
        case `GET /v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/keys/3/envelopes/current-device`:
          expect(outbound.body).toBeNull();
          expect(outbound.headers["Idempotency-Key"]).toBeUndefined();
          return success(envelopeResponse());
        default:
          throw new Error(`Unexpected team-envelope request: ${outbound.method} ${outbound.path}`);
      }
    });
    const client = createClient(transport);

    await expect(client.getCurrentTeamProjectKeyMetadata(TEAM_ID, PROJECT_ID)).resolves.toEqual(
      currentKeyResponse(),
    );
    await expect(
      client.listEligibleTeamProjectKeyRecipients(TEAM_ID, PROJECT_ID, 3),
    ).resolves.toMatchObject({
      recipients: [{ deviceId: RECIPIENT_DEVICE_ID }],
    });
    await expect(
      client.publishTeamProjectKeyEnvelope(TEAM_ID, PROJECT_ID, 3, request, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toMatchObject({ envelope: { envelopeId: ENVELOPE_ID } });
    await expect(
      client.getCurrentDeviceTeamProjectKeyEnvelope(TEAM_ID, PROJECT_ID, 3, RECIPIENT_DEVICE_ID),
    ).resolves.toMatchObject({ envelope: { recipientDeviceId: RECIPIENT_DEVICE_ID } });
    expect(transport.requests).toHaveLength(4);
  });

  it("rejects a publish request whose embedded scope differs before transport", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("Transport must not be reached.");
    });
    const client = createClient(transport);

    await expect(
      client.publishTeamProjectKeyEnvelope(
        TEAM_ID,
        PROJECT_ID,
        3,
        { ...publishRequest(), teamId: OTHER_TEAM_ID },
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).rejects.toMatchObject({
      code: "CLOUD_REQUEST_INVALID",
      requestId: REQUEST_ID,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("fails closed on cross-scope recipient lists and altered publication responses", async () => {
    const crossScopeClient = createClient(
      new RecordingTransport(() =>
        success({
          ...eligibleRecipientResponse(),
          teamId: OTHER_TEAM_ID,
          recipients: [
            {
              ...eligibleRecipientResponse().recipients[0],
              teamId: OTHER_TEAM_ID,
            },
          ],
        }),
      ),
    );
    await expect(
      crossScopeClient.listEligibleTeamProjectKeyRecipients(TEAM_ID, PROJECT_ID, 3),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });

    const alteredEnvelopeClient = createClient(
      new RecordingTransport(() =>
        success(
          {
            ...envelopeResponse(),
            envelope: {
              ...envelopeResponse().envelope,
              ciphertext: "X".repeat(64),
            },
          },
          201,
        ),
      ),
    );
    await expect(
      alteredEnvelopeClient.publishTeamProjectKeyEnvelope(
        TEAM_ID,
        PROJECT_ID,
        3,
        publishRequest(),
        { idempotencyKey: IDEMPOTENCY_KEY },
      ),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });
  });

  it("rejects cross-scope or secret-bearing current-key discovery responses", async () => {
    const crossScopeClient = createClient(
      new RecordingTransport(() =>
        success({
          ...currentKeyResponse(),
          teamId: OTHER_TEAM_ID,
        }),
      ),
    );
    await expect(
      crossScopeClient.getCurrentTeamProjectKeyMetadata(TEAM_ID, PROJECT_ID),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });

    const secretBearingClient = createClient(
      new RecordingTransport(() =>
        success({
          ...currentKeyResponse(),
          ciphertext: "C".repeat(64),
        }),
      ),
    );
    await expect(
      secretBearingClient.getCurrentTeamProjectKeyMetadata(TEAM_ID, PROJECT_ID),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });
  });

  it("rejects another device's ciphertext and invalid current-device identity", async () => {
    const transport = new RecordingTransport(() => success(envelopeResponse()));
    const client = createClient(transport);

    await expect(
      client.getCurrentDeviceTeamProjectKeyEnvelope(TEAM_ID, PROJECT_ID, 3, OTHER_DEVICE_ID),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      requestId: REQUEST_ID,
    });
    await expect(
      client.getCurrentDeviceTeamProjectKeyEnvelope(TEAM_ID, PROJECT_ID, 3, "not-a-device"),
    ).rejects.toMatchObject({
      code: "CLOUD_REQUEST_INVALID",
      requestId: null,
    });
    expect(transport.requests).toHaveLength(1);
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

function success(body: unknown, status = 200): CloudTransportResponse {
  return {
    status,
    headers: { "x-request-id": REQUEST_ID },
    body,
  };
}

function eligibleRecipientResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    recipients: [
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        recipientKind: "active_assigned_team_member_device" as const,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        keyVersion: 3,
        membershipId: MEMBERSHIP_ID,
        membershipRevision: 4,
        assignmentId: ASSIGNMENT_ID,
        assignmentRevision: 2,
        deviceId: RECIPIENT_DEVICE_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256" as const,
        publicKey: "B".repeat(87),
        publicKeyFingerprint: "b".repeat(64),
      },
    ],
  };
}

function currentKeyResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    state: "active" as const,
    serverRevision: 5,
    updatedAt: NOW,
    currentDeviceEnvelopeAvailable: false,
  };
}

function publishRequest(): CloudTeamProjectKeyEnvelopePublishRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    envelopeKind: "team_project_member_device",
    envelopeId: ENVELOPE_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    membershipId: MEMBERSHIP_ID,
    membershipRevision: 4,
    assignmentId: ASSIGNMENT_ID,
    assignmentRevision: 2,
    algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
    senderDeviceId: SENDER_DEVICE_ID,
    senderPublicKey: "A".repeat(87),
    senderPublicKeyFingerprint: "a".repeat(64),
    recipientDeviceId: RECIPIENT_DEVICE_ID,
    recipientPublicKey: "B".repeat(87),
    recipientPublicKeyFingerprint: "b".repeat(64),
    encapsulatedKey: "E".repeat(87),
    ciphertext: "C".repeat(64),
  };
}

function envelopeResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    envelope: {
      ...publishRequest(),
      createdAt: NOW,
    },
  };
}
