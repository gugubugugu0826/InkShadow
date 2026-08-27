import { describe, expect, it } from "vitest";

import {
  CLOUD_API_OPERATIONS,
  canonicalCloudJson,
  CloudAuthenticationRequestSchema,
  CloudProjectKeyResponseSchema,
  CloudProjectKeyPublishRequestSchema,
  CloudProjectStateResponseSchema,
  CloudSessionGrantResponseSchema,
  CloudSyncSnapshotResponseSchema,
  CloudSyncPushRequestSchema,
  CloudTombstoneAcknowledgementRequestSchema,
  CONTRACT_SCHEMA_VERSION,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  hashCloudProjectKeyPublication,
  type CloudProjectKeyPublishRequest,
} from "../src/index.js";
import { INKSHADOW_CLOUD_OPENAPI } from "@inkshadow/contracts/openapi";

const ACCOUNT_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const SESSION_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const OBJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const VERSION_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const OPERATION_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const CHUNK_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const ENVELOPE_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const RECOVERY_ID = "018f0d7a-3b2c-7abc-8def-00000000000a";
const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-00000000000b";
const SNAPSHOT_ID = "018f0d7a-3b2c-7abc-8def-00000000000c";
const SECOND_OPERATION_ID = "018f0d7a-3b2c-7abc-8def-00000000000d";
const SECOND_OBJECT_ID = "018f0d7a-3b2c-7abc-8def-00000000000e";
const SECOND_CHUNK_ID = "018f0d7a-3b2c-7abc-8def-00000000000f";
const SECOND_VERSION_ID = "018f0d7a-3b2c-7abc-8def-000000000010";
const NOW = "2026-07-27T00:00:00.000Z";
const LATER = "2026-07-27T01:00:00.000Z";
const RETAIN_UNTIL = "2027-07-27T00:00:00.000Z";

describe("cloud API contract", () => {
  it("materializes the compact operation table byte-for-byte without changing the public contract", async () => {
    const serialized = JSON.stringify(CLOUD_API_OPERATIONS);
    const serializedBytes = new TextEncoder().encode(serialized);
    const digest = await crypto.subtle.digest("SHA-256", serializedBytes);
    const fingerprint = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");

    expect(serializedBytes.byteLength).toBe(35_987);
    expect(fingerprint).toBe("38afca50acf2864cf3bd0f146c63d5ec5fb295595071492adc7dc30cec424610");
    expect(CLOUD_API_OPERATIONS.every((operation) => Object.isFrozen(operation))).toBe(true);
  });

  it("keeps document generation behind the explicit OpenAPI subpath", async () => {
    const runtimeContracts = await import("../src/index.js");

    expect(runtimeContracts).not.toHaveProperty("INKSHADOW_CLOUD_OPENAPI");
    expect(INKSHADOW_CLOUD_OPENAPI).toHaveProperty("openapi", "3.1.1");
  });

  it("exports one OpenAPI operation for every unique client operation", () => {
    const operationIds = CLOUD_API_OPERATIONS.map((operation) => operation.operationId);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(CLOUD_API_OPERATIONS).toHaveLength(81);

    const document = INKSHADOW_CLOUD_OPENAPI as {
      readonly openapi: string;
      readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      readonly components: {
        readonly schemas: Readonly<Record<string, unknown>>;
      };
    };
    expect(document.openapi).toBe("3.1.1");
    expect(Object.keys(document.components.schemas)).toHaveLength(105);
    for (const operation of CLOUD_API_OPERATIONS) {
      expect(document.paths[operation.path]?.[operation.method]).toMatchObject({
        operationId: operation.operationId,
        security: operation.requiresAuthentication ? [{ bearerAuth: [] }] : [],
        "x-inkshadow-authentication-required": operation.requiresAuthentication,
        "x-inkshadow-idempotency-required": operation.requiresIdempotencyKey,
        "x-inkshadow-native-password-boundary": operation.requiresNativePasswordBoundary,
      });
    }
    expect(document.components.schemas.SyncPushRequest).toMatchObject({
      properties: {
        operations: {
          items: {
            properties: {
              schemaVersion: { const: SYNC_PROTOCOL_SCHEMA_VERSION },
              objectType: {
                enum: [
                  "project_manifest",
                  "chapter_version",
                  "story_record",
                  "outline",
                  "memory",
                  "material",
                  "attachment",
                ],
              },
            },
            required: expect.arrayContaining(["schemaVersion", "objectType"]),
          },
        },
      },
    });
    expect(document.components.schemas.TombstoneAcknowledgementRequest).toMatchObject({
      properties: {
        acknowledgements: {
          items: {
            properties: {
              objectType: {
                enum: [
                  "project_manifest",
                  "chapter_version",
                  "story_record",
                  "outline",
                  "memory",
                  "material",
                  "attachment",
                ],
              },
            },
            required: expect.arrayContaining(["objectType", "objectId", "objectGeneration"]),
          },
        },
      },
    });
    expect(document.components.schemas.DeletionRequestResponse).toMatchObject({
      properties: {
        deletionRequest: {
          $ref: "#/components/schemas/DeletionRequest",
        },
      },
    });
    expect(document.components.schemas.DeletionRequest).toMatchObject({
      allOf: [
        {
          oneOf: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                state: { const: "grace_period" },
                phase: { const: "freeze" },
                canCancel: { const: true },
              }),
            }),
            expect.objectContaining({
              properties: expect.objectContaining({
                state: { const: "purged" },
                phase: { const: "complete" },
                canCancel: { const: false },
              }),
            }),
          ]),
        },
        expect.objectContaining({ oneOf: expect.any(Array) }),
      ],
      "x-inkshadow-timestamp-order": expect.arrayContaining([
        "requestedAt <= cancellableUntil <= scheduledFor",
        "backupRetainedUntil <= completedAt when backupRetainedUntil is present",
      ]),
    });
  });

  it("requires idempotency for every side-effecting route", () => {
    for (const operation of CLOUD_API_OPERATIONS) {
      if (operation.method !== "get" && operation.operationId !== "accountDeletions.lookup") {
        expect(operation.requiresIdempotencyKey, operation.operationId).toBe(true);
      }
    }
    expect(
      CLOUD_API_OPERATIONS.find((operation) => operation.operationId === "accountDeletions.lookup"),
    ).toMatchObject({
      method: "post",
      requiresIdempotencyKey: false,
      requiresNativePasswordBoundary: true,
    });
  });

  it("uses one stable browser-safe canonical hash for publication receipts", async () => {
    const request = {
      schemaVersion: 1,
      expectedServerRevision: null,
    } as CloudProjectKeyPublishRequest;
    expect(
      canonicalCloudJson({
        projectId: PROJECT_ID,
        keyVersion: 1,
        request,
      }),
    ).toBe(
      `{"keyVersion":1,"projectId":"${PROJECT_ID}","request":{"expectedServerRevision":null,"schemaVersion":1}}`,
    );
    await expect(hashCloudProjectKeyPublication(PROJECT_ID, 1, request)).resolves.toBe(
      "0870ea4fe431a6a1b5dbbd68947508bcf9c0c8e2b7f7edb8d3d14bc7a1157909",
    );
  });

  it("normalizes email but rejects unknown login fields and weak passwords", () => {
    const device = deviceRegistration();
    const parsed = CloudAuthenticationRequestSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      email: " Writer@Example.COM ",
      password: "test-correct-horse-battery-staple",
      device,
    });
    expect(parsed.email).toBe("writer@example.com");
    expect(
      CloudAuthenticationRequestSchema.safeParse({
        ...parsed,
        password: "test-short",
      }).success,
    ).toBe(false);
    expect(
      CloudAuthenticationRequestSchema.safeParse({
        ...parsed,
        rawProjectDataKey: "must-not-cross-the-wire",
      }).success,
    ).toBe(false);
  });

  it("binds account, device and session identities in session grants", () => {
    const grant = sessionGrant();
    expect(CloudSessionGrantResponseSchema.safeParse(grant).success).toBe(true);
    expect(
      CloudSessionGrantResponseSchema.safeParse({
        ...grant,
        session: {
          ...grant.session,
          deviceId: "018f0d7a-3b2c-7abc-8def-00000000000c",
        },
      }).success,
    ).toBe(false);
  });

  it("publishes only confirmed, internally consistent ciphertext key envelopes", () => {
    const request = projectKeyPublishRequest();
    expect(CloudProjectKeyPublishRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CloudProjectKeyPublishRequestSchema.safeParse({
        ...request,
        version: { ...request.version, state: "pending_confirmation" },
      }).success,
    ).toBe(false);
    expect(
      CloudProjectKeyPublishRequestSchema.safeParse({
        ...request,
        version: { ...request.version, state: "retiring" },
      }).success,
    ).toBe(false);
    expect(
      CloudProjectKeyPublishRequestSchema.safeParse({
        ...request,
        expectedServerRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      CloudProjectKeyPublishRequestSchema.safeParse({
        ...request,
        expectedServerRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      CloudProjectKeyPublishRequestSchema.safeParse({
        ...request,
        recoveryEnvelope: {
          ...request.recoveryEnvelope,
          revokedAt: "2026-07-27T01:00:00.000Z",
        },
      }).success,
    ).toBe(false);
    expect(
      CloudProjectKeyPublishRequestSchema.safeParse({
        ...request,
        deviceEnvelopes: request.deviceEnvelopes.map((envelope) => ({
          ...envelope,
          revokedAt: "2026-07-27T01:00:00.000Z",
        })),
      }).success,
    ).toBe(false);
    expect(
      CloudProjectKeyPublishRequestSchema.safeParse({
        ...request,
        recoveryEnvelope: {
          ...request.recoveryEnvelope,
          recoveryCode: "must-remain-local",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts an exact ciphertext push set and rejects plaintext or orphan chunks", () => {
    const request = syncPushRequest();
    expect(CloudSyncPushRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CloudSyncPushRequestSchema.safeParse({
        ...request,
        chunks: [
          {
            ...request.chunks[0],
            encrypted: {
              ...request.chunks[0]?.encrypted,
              plaintext: "must-never-upload",
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      CloudSyncPushRequestSchema.safeParse({
        ...request,
        chunks: [],
      }).success,
    ).toBe(false);
    expect(
      CloudSyncPushRequestSchema.safeParse({
        ...request,
        chunks: request.chunks.map((chunk) => ({
          ...chunk,
          encrypted: {
            ...chunk.encrypted,
            aad: { ...chunk.encrypted.aad, objectType: "material" },
          },
        })),
      }).success,
    ).toBe(false);

    const deletion = deleteSnapshotResponse();
    expect(
      CloudSyncPushRequestSchema.safeParse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        baseCursor: null,
        operations: deletion.operations,
        chunks: deletion.chunks,
        tombstones: deletion.tombstones.map((tombstone) => ({
          ...tombstone,
          objectType: "material",
        })),
      }).success,
    ).toBe(false);
  });

  it("requires push operations to use strictly increasing portable device sequences", () => {
    const request = syncPushRequest();
    const firstOperation = request.operations[0];
    const firstChunk = request.chunks[0];
    if (firstOperation === undefined || firstChunk === undefined) {
      throw new Error("The sync push fixture is incomplete.");
    }
    const secondOperation = {
      ...firstOperation,
      operationId: SECOND_OPERATION_ID,
      deviceSequence: 2,
      objectId: SECOND_OBJECT_ID,
      vector: { [DEVICE_ID]: 2 },
      encryptedChunkIds: [SECOND_CHUNK_ID],
    };
    const secondChunk = {
      chunkId: SECOND_CHUNK_ID,
      encrypted: {
        ...firstChunk.encrypted,
        aad: {
          ...firstChunk.encrypted.aad,
          objectId: SECOND_OBJECT_ID,
          versionId: SECOND_VERSION_ID,
        },
      },
    };
    expect(
      CloudSyncPushRequestSchema.safeParse({
        ...request,
        operations: [firstOperation, secondOperation],
        chunks: [firstChunk, secondChunk],
      }).success,
    ).toBe(true);
    expect(
      CloudSyncPushRequestSchema.safeParse({
        ...request,
        operations: [secondOperation, firstOperation],
        chunks: [firstChunk, secondChunk],
      }).success,
    ).toBe(false);
    expect(
      CloudSyncPushRequestSchema.safeParse({
        ...request,
        operations: [
          firstOperation,
          {
            ...secondOperation,
            deviceSequence: 1,
            vector: { [DEVICE_ID]: 1 },
          },
        ],
        chunks: [firstChunk, secondChunk],
      }).success,
    ).toBe(false);
  });

  it("binds immutable publication receipts to key sets and current project state", () => {
    const keyResponse = projectKeyResponse();
    expect(CloudProjectKeyResponseSchema.safeParse(keyResponse).success).toBe(true);
    expect(
      CloudProjectKeyResponseSchema.safeParse({
        ...keyResponse,
        keySet: {
          ...keyResponse.keySet,
          publication: {
            ...keyResponse.keySet.publication,
            serverRevision: 2,
          },
        },
      }).success,
    ).toBe(false);

    const state = projectStateResponse();
    expect(CloudProjectStateResponseSchema.safeParse(state).success).toBe(true);
    expect(
      CloudProjectStateResponseSchema.safeParse({
        ...state,
        project: {
          ...state.project,
          currentKeyPublication: {
            ...state.project.currentKeyPublication,
            keyVersion: 2,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts only project-scoped snapshot pages with exact ciphertext bindings", () => {
    const snapshot = syncSnapshotResponse();
    expect(CloudSyncSnapshotResponseSchema.safeParse(snapshot).success).toBe(true);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        chunks: [],
      }).success,
    ).toBe(false);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        chunks: snapshot.chunks.map((chunk) => ({
          ...chunk,
          encrypted: {
            ...chunk.encrypted,
            aad: {
              ...chunk.encrypted.aad,
              objectType: "material",
            },
          },
        })),
      }).success,
    ).toBe(false);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        chunks: snapshot.chunks.map((chunk) => ({
          ...chunk,
          encrypted: {
            ...chunk.encrypted,
            aad: {
              ...chunk.encrypted.aad,
              objectId: VERSION_ID,
            },
          },
        })),
      }).success,
    ).toBe(false);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        projectId: VERSION_ID,
      }).success,
    ).toBe(false);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        hasMore: false,
      }).success,
    ).toBe(false);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        nextSnapshotCursor: snapshot.resumeCursor,
      }).success,
    ).toBe(false);
  });

  it("requires every snapshot delete to carry one exact tombstone", () => {
    const snapshot = deleteSnapshotResponse();
    expect(CloudSyncSnapshotResponseSchema.safeParse(snapshot).success).toBe(true);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        tombstones: snapshot.tombstones.map((tombstone) => ({
          ...tombstone,
          vector: { [DEVICE_ID]: 2 },
        })),
      }).success,
    ).toBe(false);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        tombstones: [],
      }).success,
    ).toBe(false);
    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        tombstones: snapshot.tombstones.map((tombstone) => ({
          ...tombstone,
          objectType: "material",
        })),
      }).success,
    ).toBe(false);
  });

  it("namespaces snapshot object identity by object type", () => {
    const snapshot = deleteSnapshotResponse();
    const secondOperation = {
      ...snapshot.operations[0],
      operationId: CHUNK_ID,
      deviceSequence: 2,
      objectType: "material" as const,
      vector: { [DEVICE_ID]: 2 },
    };
    const secondTombstone = {
      ...snapshot.tombstones[0],
      objectType: "material" as const,
      vector: { [DEVICE_ID]: 2 },
    };

    expect(
      CloudSyncSnapshotResponseSchema.safeParse({
        ...snapshot,
        operations: [...snapshot.operations, secondOperation],
        tombstones: [...snapshot.tombstones, secondTombstone],
      }).success,
    ).toBe(true);
  });

  it("namespaces tombstone acknowledgements by object type", () => {
    const acknowledgement = {
      objectType: "chapter_version" as const,
      objectId: OBJECT_ID,
      objectGeneration: 1,
    };
    const request = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      acknowledgements: [acknowledgement, { ...acknowledgement, objectType: "material" as const }],
    };

    expect(CloudTombstoneAcknowledgementRequestSchema.safeParse(request).success).toBe(true);
    expect(
      CloudTombstoneAcknowledgementRequestSchema.safeParse({
        ...request,
        acknowledgements: [acknowledgement, acknowledgement],
      }).success,
    ).toBe(false);
    expect(
      CloudTombstoneAcknowledgementRequestSchema.safeParse({
        ...request,
        acknowledgements: [{ objectId: OBJECT_ID, objectGeneration: 1 }],
      }).success,
    ).toBe(false);
    expect(
      CloudTombstoneAcknowledgementRequestSchema.safeParse({
        ...request,
        acknowledgements: [{ ...acknowledgement, objectType: "unsupported" }],
      }).success,
    ).toBe(false);
    expect(
      CloudTombstoneAcknowledgementRequestSchema.safeParse({
        ...request,
        acknowledgements: [
          {
            ...acknowledgement,
            objectGeneration: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

function deviceRegistration() {
  return {
    deviceId: DEVICE_ID,
    displayName: "主力写作设备",
    algorithm: "DHKEM-P256-HKDF-SHA256" as const,
    publicKey: "A".repeat(87),
    publicKeyFingerprint: "a".repeat(64),
    clientVersion: "0.1.0",
  };
}

function sessionGrant() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    account: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      accountId: ACCOUNT_ID,
      state: "active" as const,
      revision: 2,
      verifiedAt: NOW,
      deletionScheduledFor: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    device: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      device: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        state: "trusted" as const,
        publicKeyFingerprint: "a".repeat(64),
        createdAt: NOW,
        revokedAt: null,
      },
      publicKey: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256" as const,
        publicKey: "A".repeat(87),
        publicKeyFingerprint: "a".repeat(64),
        createdAt: NOW,
        revokedAt: null,
      },
      displayName: "主力写作设备",
      revision: 1,
    },
    session: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      clientVersion: "0.1.0",
      minimumClientVersion: "0.1.0",
      issuedAt: NOW,
      expiresAt: "2026-07-27T01:00:00.000Z",
      revokedAt: null,
    },
    tokens: {
      accessToken: "a".repeat(64),
      accessTokenExpiresAt: "2026-07-27T01:00:00.000Z",
      refreshToken: "b".repeat(64),
      refreshTokenExpiresAt: "2026-08-26T00:00:00.000Z",
    },
  };
}

function projectKeyPublishRequest() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    expectedServerRevision: null,
    version: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      keyVersion: 1,
      algorithm: "AES-256-GCM" as const,
      state: "active" as const,
      revision: 2,
      createdAt: NOW,
      retiredAt: null,
    },
    recoveryEnvelope: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: "ARGON2ID-AES256GCM" as const,
      recoveryId: RECOVERY_ID,
      projectId: PROJECT_ID,
      keyVersion: 1,
      kdf: {
        algorithm: "ARGON2ID" as const,
        version: 19 as const,
        memoryKib: 65_536 as const,
        timeCost: 3 as const,
        parallelism: 4 as const,
        outputBytes: 64 as const,
      },
      salt: "B".repeat(22),
      nonce: "C".repeat(16),
      ciphertext: "D".repeat(64),
      verifier: "E".repeat(43),
      createdAt: NOW,
      confirmedAt: NOW,
      revokedAt: null,
    },
    deviceEnvelopes: [
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM" as const,
        envelopeId: ENVELOPE_ID,
        projectId: PROJECT_ID,
        keyVersion: 1,
        senderDeviceId: DEVICE_ID,
        senderPublicKey: "A".repeat(87),
        senderPublicKeyFingerprint: "a".repeat(64),
        recipientDeviceId: DEVICE_ID,
        recipientPublicKey: "A".repeat(87),
        recipientPublicKeyFingerprint: "a".repeat(64),
        encapsulatedKey: "F".repeat(87),
        ciphertext: "G".repeat(64),
        createdAt: NOW,
        revokedAt: null,
      },
    ],
  };
}

function projectKeyResponse() {
  const request = projectKeyPublishRequest();
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    keySet: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      keyVersion: 1,
      serverRevision: 1,
      publication: projectKeyPublication(),
      version: request.version,
      recoveryEnvelope: request.recoveryEnvelope,
      deviceEnvelopes: request.deviceEnvelopes,
      updatedAt: NOW,
    },
  };
}

function projectKeyPublication() {
  return {
    projectId: PROJECT_ID,
    keyVersion: 1,
    serverRevision: 1,
    publicationRequestSha256: "c".repeat(64),
    publishedAt: NOW,
  };
}

function projectStateResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    project: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 1,
      currentKeyPublication: projectKeyPublication(),
      updatedAt: LATER,
      sync: {
        headCursor: "head_cursor",
        minimumAvailableCursor: "minimum_cursor",
        cursorStatus: "incremental_available" as const,
      },
    },
  };
}

function syncPushRequest() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    baseCursor: null,
    operations: [
      {
        schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        deviceSequence: 1,
        objectType: "chapter_version" as const,
        objectId: OBJECT_ID,
        objectGeneration: 1,
        kind: "upsert" as const,
        vector: { [DEVICE_ID]: 1 },
        encryptedChunkIds: [CHUNK_ID],
        createdAt: NOW,
      },
    ],
    chunks: [
      {
        chunkId: CHUNK_ID,
        encrypted: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          algorithm: "AES-256-GCM" as const,
          nonce: "A".repeat(16),
          ciphertext: "ciphertext_payload",
          ciphertextSha256: "b".repeat(64),
          plaintextBytes: 128,
          aad: {
            projectId: PROJECT_ID,
            objectType: "chapter_version" as const,
            objectId: OBJECT_ID,
            versionId: VERSION_ID,
            chunkIndex: 0,
            keyVersion: 1,
          },
        },
      },
    ],
    tombstones: [],
  };
}

function syncSnapshotResponse() {
  const payload = syncPushRequest();
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    projectId: PROJECT_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotExpiresAt: LATER,
    operations: payload.operations,
    chunks: payload.chunks,
    tombstones: payload.tombstones,
    resumeCursor: "resume_cursor",
    nextSnapshotCursor: "snapshot_cursor",
    hasMore: true,
  };
}

function deleteSnapshotResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    projectId: PROJECT_ID,
    snapshotId: SNAPSHOT_ID,
    snapshotExpiresAt: LATER,
    operations: [
      {
        schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
        operationId: OPERATION_ID,
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        deviceSequence: 1,
        objectType: "chapter_version" as const,
        objectId: OBJECT_ID,
        objectGeneration: 1,
        kind: "delete" as const,
        vector: { [DEVICE_ID]: 1 },
        encryptedChunkIds: [],
        createdAt: NOW,
      },
    ],
    chunks: [],
    tombstones: [
      {
        schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
        projectId: PROJECT_ID,
        objectType: "chapter_version" as const,
        objectId: OBJECT_ID,
        objectGeneration: 1,
        deletedByDeviceId: DEVICE_ID,
        vector: { [DEVICE_ID]: 1 },
        deletedAt: NOW,
        retainUntil: RETAIN_UNTIL,
        acknowledgedDeviceIds: [],
      },
    ],
    resumeCursor: "resume_cursor",
    nextSnapshotCursor: null,
    hasMore: false,
  };
}
