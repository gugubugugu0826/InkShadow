import { describe, expect, it } from "vitest";

import {
  CloudTeamProjectCurrentKeyResponseSchema,
  CloudTeamProjectKeyEligibleRecipientListResponseSchema,
  CloudTeamProjectKeyEnvelopePublishRequestSchema,
  CloudTeamProjectKeyEnvelopeResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  DeviceProjectKeyEnvelopeContractSchema,
  RecoveryProjectKeyEnvelopeContractSchema,
  getCloudApiOperation,
} from "../src/index.js";
import { INKSHADOW_CLOUD_OPENAPI } from "@inkshadow/contracts/openapi";

const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const MEMBERSHIP_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const ASSIGNMENT_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const SENDER_DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const RECIPIENT_DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const OTHER_DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const ENVELOPE_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const NOW = "2026-07-28T00:00:00.000Z";

describe("team-project key-envelope cloud contracts", () => {
  it("admits only bounded ciphertext-free authoritative current-key metadata", () => {
    const response = currentKeyResponse();
    expect(CloudTeamProjectCurrentKeyResponseSchema.safeParse(response).success).toBe(true);
    expect(Object.keys(response).sort()).toEqual([
      "currentDeviceEnvelopeAvailable",
      "keyVersion",
      "projectId",
      "requestId",
      "schemaVersion",
      "serverRevision",
      "state",
      "teamId",
      "updatedAt",
    ]);
    for (const invalid of [
      { ...response, state: "retiring" },
      { ...response, serverRevision: 0 },
      { ...response, keyVersion: 2_147_483_648 },
      { ...response, ciphertext: "C".repeat(64) },
      { ...response, publicKey: "P".repeat(87) },
      { ...response, recoveryCiphertext: "R".repeat(64) },
      { ...response, recipientDeviceId: RECIPIENT_DEVICE_ID },
    ]) {
      expect(CloudTeamProjectCurrentKeyResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("returns only bounded, unique and exactly scoped eligible public-key recipients", () => {
    const response = eligibleRecipientResponse();
    expect(CloudTeamProjectKeyEligibleRecipientListResponseSchema.safeParse(response).success).toBe(
      true,
    );
    expect(
      CloudTeamProjectKeyEligibleRecipientListResponseSchema.safeParse({
        ...response,
        recipients: [
          response.recipients[0],
          { ...response.recipients[0], membershipId: MEMBERSHIP_ID },
        ],
      }).success,
    ).toBe(false);
    expect(
      CloudTeamProjectKeyEligibleRecipientListResponseSchema.safeParse({
        ...response,
        recipients: [{ ...response.recipients[0], projectId: TEAM_ID }],
      }).success,
    ).toBe(false);
    expect(
      CloudTeamProjectKeyEligibleRecipientListResponseSchema.safeParse({
        ...response,
        recipients: [{ ...response.recipients[0], membershipRevision: 0 }],
      }).success,
    ).toBe(false);
    expect(
      CloudTeamProjectKeyEligibleRecipientListResponseSchema.safeParse({
        ...response,
        recipients: [{ ...response.recipients[0], ciphertext: "C".repeat(64) }],
      }).success,
    ).toBe(false);
  });

  it("requires an exact recipient snapshot and strictly bounded client-created HPKE payload", () => {
    const request = publishRequest();
    expect(CloudTeamProjectKeyEnvelopePublishRequestSchema.safeParse(request).success).toBe(true);
    for (const invalid of [
      { ...request, membershipRevision: 0 },
      { ...request, assignmentRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, algorithm: "AES-256-GCM" },
      { ...request, recipientPublicKeyFingerprint: "A".repeat(64) },
      { ...request, ciphertext: "C".repeat(65) },
      { ...request, recoveryId: OTHER_DEVICE_ID },
    ]) {
      expect(CloudTeamProjectKeyEnvelopePublishRequestSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("keeps team, personal-device and recovery envelopes structurally disjoint", () => {
    const teamEnvelope = {
      ...publishRequest(),
      createdAt: NOW,
    };
    expect(DeviceProjectKeyEnvelopeContractSchema.safeParse(teamEnvelope).success).toBe(false);
    expect(RecoveryProjectKeyEnvelopeContractSchema.safeParse(teamEnvelope).success).toBe(false);
    expect(
      CloudTeamProjectKeyEnvelopePublishRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
        envelopeId: ENVELOPE_ID,
        projectId: PROJECT_ID,
        keyVersion: 3,
        senderDeviceId: SENDER_DEVICE_ID,
        senderPublicKey: "A".repeat(87),
        senderPublicKeyFingerprint: "a".repeat(64),
        recipientDeviceId: RECIPIENT_DEVICE_ID,
        recipientPublicKey: "B".repeat(87),
        recipientPublicKeyFingerprint: "b".repeat(64),
        encapsulatedKey: "E".repeat(87),
        ciphertext: "C".repeat(64),
        createdAt: NOW,
        revokedAt: null,
      }).success,
    ).toBe(false);
  });

  it("represents exactly one current-device envelope and rejects adjacent ciphertext", () => {
    const response = envelopeResponse();
    expect(CloudTeamProjectKeyEnvelopeResponseSchema.safeParse(response).success).toBe(true);
    expect(
      CloudTeamProjectKeyEnvelopeResponseSchema.safeParse({
        ...response,
        envelopes: [response.envelope],
      }).success,
    ).toBe(false);
    expect(
      CloudTeamProjectKeyEnvelopeResponseSchema.safeParse({
        ...response,
        envelope: {
          ...response.envelope,
          otherDeviceCiphertext: "X".repeat(64),
        },
      }).success,
    ).toBe(false);
  });

  it("freezes authenticated read routes and idempotent publication in OpenAPI", () => {
    expect(getCloudApiOperation("teamProjectKeys.getCurrent")).toMatchObject({
      method: "get",
      path: "/v1/teams/{teamId}/projects/{projectId}/keys/current",
      requiresAuthentication: true,
      requiresIdempotencyKey: false,
      requestSchemaName: null,
      successSchemaName: "TeamProjectCurrentKeyResponse",
      successStatus: 200,
    });
    expect(getCloudApiOperation("teamProjectKeyRecipients.list")).toMatchObject({
      method: "get",
      path: "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/recipients",
      requiresAuthentication: true,
      requiresIdempotencyKey: false,
      successSchemaName: "TeamProjectKeyEligibleRecipientListResponse",
    });
    expect(getCloudApiOperation("teamProjectKeyEnvelopes.publish")).toMatchObject({
      method: "post",
      path: "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/envelopes",
      requiresAuthentication: true,
      requiresIdempotencyKey: true,
      requestSchemaName: "TeamProjectKeyEnvelopePublishRequest",
      successSchemaName: "TeamProjectKeyEnvelopeResponse",
      successStatus: 201,
    });
    expect(getCloudApiOperation("teamProjectKeyEnvelopes.getCurrentDevice")).toMatchObject({
      method: "get",
      path: "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/envelopes/current-device",
      requiresAuthentication: true,
      requiresIdempotencyKey: false,
      successSchemaName: "TeamProjectKeyEnvelopeResponse",
    });

    const document = INKSHADOW_CLOUD_OPENAPI as {
      readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    };
    expect(
      document.paths["/v1/teams/{teamId}/projects/{projectId}/keys/current"]?.get,
    ).toMatchObject({
      security: [{ bearerAuth: [] }],
      "x-inkshadow-idempotency-required": false,
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TeamProjectCurrentKeyResponse" },
            },
          },
        },
      },
    });
    expect(
      document.paths[
        "/v1/teams/{teamId}/projects/{projectId}/keys/{keyVersion}/envelopes/current-device"
      ]?.get,
    ).toMatchObject({
      security: [{ bearerAuth: [] }],
      "x-inkshadow-idempotency-required": false,
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TeamProjectKeyEnvelopeResponse" },
            },
          },
        },
      },
    });
  });
});

function currentKeyResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    state: "active" as const,
    serverRevision: 4,
    updatedAt: NOW,
    currentDeviceEnvelopeAvailable: false,
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

function publishRequest() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    envelopeKind: "team_project_member_device" as const,
    envelopeId: ENVELOPE_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    membershipId: MEMBERSHIP_ID,
    membershipRevision: 4,
    assignmentId: ASSIGNMENT_ID,
    assignmentRevision: 2,
    algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM" as const,
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
