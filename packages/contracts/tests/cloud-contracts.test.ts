import { describe, expect, it } from "vitest";

import {
  CloudAccountContractSchema,
  CloudSessionContractSchema,
  CONTRACT_SCHEMA_VERSION,
  DeviceProjectKeyEnvelopeContractSchema,
  EncryptedSyncChunkContractSchema,
  MAX_PORTABLE_INTEGER,
  ProjectKeyVersionContractSchema,
  RecoveryProjectKeyEnvelopeContractSchema,
  RegisteredDevicePublicKeyContractSchema,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  SignedOfflineLicenseContractSchema,
  SyncOperationContractSchema,
  SyncObjectTypeSchema,
  SyncTombstoneContractSchema,
  TeamMembershipContractSchema,
} from "../src/index.js";

const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const OBJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const VERSION_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const OPERATION_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const CHUNK_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const ACCOUNT_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const TEAM_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const TENANT_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const NOW = "2026-07-27T00:00:00.000Z";

describe("cloud and encrypted-sync wire contracts", () => {
  it("supports a project manifest for empty-project and new-device discovery", () => {
    expect(SyncObjectTypeSchema.parse("project_manifest")).toBe("project_manifest");
  });

  it("accepts ciphertext metadata and rejects any plaintext extension", () => {
    const chunk = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: "AES-256-GCM",
      nonce: "abcdefghijklmnop",
      ciphertext: "ciphertext_payload",
      ciphertextSha256: "a".repeat(64),
      plaintextBytes: 128,
      aad: {
        projectId: PROJECT_ID,
        objectType: "chapter_version",
        objectId: OBJECT_ID,
        versionId: VERSION_ID,
        chunkIndex: 0,
        keyVersion: 1,
      },
    };

    expect(EncryptedSyncChunkContractSchema.safeParse(chunk).success).toBe(true);
    expect(
      EncryptedSyncChunkContractSchema.safeParse({ ...chunk, plaintext: "must-not-upload" })
        .success,
    ).toBe(false);
  });

  it("requires operation sequence/vector agreement and ciphertext-only delete semantics", () => {
    const operation = {
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 2,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 1,
      kind: "upsert",
      vector: { [DEVICE_ID]: 2 },
      encryptedChunkIds: [CHUNK_ID],
      createdAt: NOW,
    };

    expect(SyncOperationContractSchema.safeParse(operation).success).toBe(true);
    expect(
      SyncOperationContractSchema.safeParse({
        ...operation,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
      }).success,
    ).toBe(false);
    expect(
      SyncOperationContractSchema.safeParse({ ...operation, objectType: "unsupported" }).success,
    ).toBe(false);
    expect(SyncOperationContractSchema.safeParse({ ...operation, deviceSequence: 3 }).success).toBe(
      false,
    );
    expect(
      SyncOperationContractSchema.safeParse({
        ...operation,
        kind: "delete",
        encryptedChunkIds: [CHUNK_ID],
      }).success,
    ).toBe(false);

    const maximumPortableOperation = {
      ...operation,
      deviceSequence: MAX_PORTABLE_INTEGER,
      objectGeneration: MAX_PORTABLE_INTEGER,
      vector: { [DEVICE_ID]: MAX_PORTABLE_INTEGER },
    };
    expect(SyncOperationContractSchema.safeParse(maximumPortableOperation).success).toBe(true);
    expect(
      SyncOperationContractSchema.safeParse({
        ...maximumPortableOperation,
        deviceSequence: MAX_PORTABLE_INTEGER + 1,
        vector: { [DEVICE_ID]: MAX_PORTABLE_INTEGER + 1 },
      }).success,
    ).toBe(false);
    expect(
      SyncOperationContractSchema.safeParse({
        ...maximumPortableOperation,
        objectGeneration: MAX_PORTABLE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      SyncOperationContractSchema.safeParse({
        ...maximumPortableOperation,
        vector: {
          [DEVICE_ID]: MAX_PORTABLE_INTEGER,
          [ACCOUNT_ID]: MAX_PORTABLE_INTEGER + 1,
        },
      }).success,
    ).toBe(false);
  });

  it("enforces 365-day tombstone retention and unique device acknowledgement", () => {
    const tombstone = {
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 2,
      deletedByDeviceId: DEVICE_ID,
      vector: { [DEVICE_ID]: 3 },
      deletedAt: "2026-01-01T00:00:00.000Z",
      retainUntil: "2027-01-01T00:00:00.000Z",
      acknowledgedDeviceIds: [DEVICE_ID],
    };
    expect(SyncTombstoneContractSchema.safeParse(tombstone).success).toBe(true);
    expect(
      SyncTombstoneContractSchema.safeParse({
        ...tombstone,
        schemaVersion: CONTRACT_SCHEMA_VERSION,
      }).success,
    ).toBe(false);
    expect(
      SyncTombstoneContractSchema.safeParse({
        ...tombstone,
        retainUntil: "2026-12-31T23:59:59.999Z",
      }).success,
    ).toBe(false);
    expect(
      SyncTombstoneContractSchema.safeParse({
        ...tombstone,
        acknowledgedDeviceIds: [DEVICE_ID, DEVICE_ID],
      }).success,
    ).toBe(false);
    expect(
      SyncTombstoneContractSchema.safeParse({
        ...tombstone,
        objectGeneration: MAX_PORTABLE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it("keeps cloud account/session lifecycle strict and excludes bearer secrets", () => {
    const account = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      accountId: ACCOUNT_ID,
      state: "active",
      revision: 2,
      verifiedAt: NOW,
      deletionScheduledFor: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const session = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sessionId: OPERATION_ID,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      clientVersion: "1.2.0",
      minimumClientVersion: "1.1.0",
      issuedAt: NOW,
      expiresAt: "2026-07-28T00:00:00.000Z",
      revokedAt: null,
    };
    expect(CloudAccountContractSchema.safeParse(account).success).toBe(true);
    expect(CloudSessionContractSchema.safeParse(session).success).toBe(true);
    expect(
      CloudSessionContractSchema.safeParse({ ...session, unexpectedField: "not-allowed" }).success,
    ).toBe(false);
  });

  it("accepts only public device material and authenticated project-key envelopes", () => {
    const publicKeyRecord = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deviceId: DEVICE_ID,
      accountId: ACCOUNT_ID,
      algorithm: "DHKEM-P256-HKDF-SHA256",
      publicKey: "A".repeat(87),
      publicKeyFingerprint: "a".repeat(64),
      createdAt: NOW,
      revokedAt: null,
    };
    const keyVersion = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      keyVersion: 1,
      algorithm: "AES-256-GCM",
      state: "active",
      revision: 1,
      createdAt: NOW,
      retiredAt: null,
    };
    const deviceEnvelope = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
      envelopeId: OPERATION_ID,
      projectId: PROJECT_ID,
      keyVersion: 1,
      senderDeviceId: DEVICE_ID,
      senderPublicKey: "A".repeat(87),
      senderPublicKeyFingerprint: "a".repeat(64),
      recipientDeviceId: DEVICE_ID,
      recipientPublicKey: "A".repeat(87),
      recipientPublicKeyFingerprint: "a".repeat(64),
      encapsulatedKey: "B".repeat(87),
      ciphertext: "C".repeat(64),
      createdAt: NOW,
      revokedAt: null,
    };

    expect(RegisteredDevicePublicKeyContractSchema.safeParse(publicKeyRecord).success).toBe(true);
    expect(ProjectKeyVersionContractSchema.safeParse(keyVersion).success).toBe(true);
    expect(DeviceProjectKeyEnvelopeContractSchema.safeParse(deviceEnvelope).success).toBe(true);
    expect(
      RegisteredDevicePublicKeyContractSchema.safeParse({
        ...publicKeyRecord,
        privateKey: "must-never-cross-the-wire",
      }).success,
    ).toBe(false);
    expect(
      DeviceProjectKeyEnvelopeContractSchema.safeParse({
        ...deviceEnvelope,
        rawProjectDataKey: "must-never-persist",
      }).success,
    ).toBe(false);
  });

  it("freezes recovery KDF parameters and excludes the one-time recovery code", () => {
    const recoveryEnvelope = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: "ARGON2ID-AES256GCM",
      recoveryId: OPERATION_ID,
      projectId: PROJECT_ID,
      keyVersion: 1,
      kdf: {
        algorithm: "ARGON2ID",
        version: 19,
        memoryKib: 65_536,
        timeCost: 3,
        parallelism: 4,
        outputBytes: 64,
      },
      salt: "A".repeat(22),
      nonce: "B".repeat(16),
      ciphertext: "C".repeat(64),
      verifier: "D".repeat(43),
      createdAt: NOW,
      confirmedAt: NOW,
      revokedAt: null,
    };

    expect(RecoveryProjectKeyEnvelopeContractSchema.safeParse(recoveryEnvelope).success).toBe(true);
    expect(
      RecoveryProjectKeyEnvelopeContractSchema.safeParse({
        ...recoveryEnvelope,
        kdf: { ...recoveryEnvelope.kdf, memoryKib: 1_024 },
      }).success,
    ).toBe(false);
    expect(
      RecoveryProjectKeyEnvelopeContractSchema.safeParse({
        ...recoveryEnvelope,
        recoveryCode: "must-never-upload",
      }).success,
    ).toBe(false);
  });

  it("validates signed-license chronology/grant uniqueness and team revocation coherence", () => {
    const license = {
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        licenseId: OPERATION_ID,
        product: "inkshadow",
        keyId: "release-key-1",
        deviceId: DEVICE_ID,
        tier: "studio",
        issuedAt: NOW,
        notBefore: NOW,
        validUntil: "2026-08-01T00:00:00.000Z",
        graceUntil: "2026-08-08T00:00:00.000Z",
        capabilities: ["team.review"],
        featureFlags: ["team.review"],
      },
      signature: "signature",
    };
    expect(SignedOfflineLicenseContractSchema.safeParse(license).success).toBe(true);
    expect(
      SignedOfflineLicenseContractSchema.safeParse({
        ...license,
        payload: {
          ...license.payload,
          capabilities: ["team.review", "team.review"],
        },
      }).success,
    ).toBe(false);

    const membership = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      membershipId: OPERATION_ID,
      accountId: ACCOUNT_ID,
      tenantId: TENANT_ID,
      teamId: TEAM_ID,
      role: "reviewer",
      state: "revoked",
      projectIds: [PROJECT_ID],
      createdAt: NOW,
      revokedAt: null,
    };
    expect(TeamMembershipContractSchema.safeParse(membership).success).toBe(false);
  });
});
