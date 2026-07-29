import { describe, expect, it } from "vitest";

import {
  CONTRACT_SCHEMA_VERSION,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type CloudAuthenticationRequest,
  type CloudSyncPushRequest,
  type CloudTombstoneAcknowledgementRequest,
} from "@inkshadow/contracts";

import {
  CloudClientError,
  InkShadowCloudApiClient,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "../src/index.js";

const ACCOUNT_ID = "018f0d7a-3b2c-7abc-8def-000000000001";
const DEVICE_ID = "018f0d7a-3b2c-7abc-8def-000000000002";
const SESSION_ID = "018f0d7a-3b2c-7abc-8def-000000000003";
const PROJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000004";
const OBJECT_ID = "018f0d7a-3b2c-7abc-8def-000000000005";
const VERSION_ID = "018f0d7a-3b2c-7abc-8def-000000000006";
const OPERATION_ID = "018f0d7a-3b2c-7abc-8def-000000000007";
const CHUNK_ID = "018f0d7a-3b2c-7abc-8def-000000000008";
const REQUEST_ID = "018f0d7a-3b2c-7abc-8def-000000000009";
const SNAPSHOT_ID = "018f0d7a-3b2c-7abc-8def-00000000000a";
const DELETION_REQUEST_ID = "018f0d7a-3b2c-7abc-8def-00000000000b";
const CONFIRMATION_ID = "018f0d7a-3b2c-7abc-8def-00000000000c";
const NOW = "2026-07-27T00:00:00.000Z";
const LATER = "2026-07-27T01:00:00.000Z";
const IDEMPOTENCY_KEY = "test-idempotency-key-0001";

describe("InkShadowCloudApiClient", () => {
  it("normalizes and sends login without an authorization header", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1/auth/sessions");
      expect(request.authentication).toBe("none");
      expect(request.headers).toEqual({
        "X-Request-Id": REQUEST_ID,
        "Idempotency-Key": IDEMPOTENCY_KEY,
      });
      expect(request.body).toMatchObject({ email: "writer@example.com" });
      return success(sessionGrant());
    });
    const client = createClient(transport);

    const result = await client.login(loginRequest(), {
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result.session.sessionId).toBe(SESSION_ID);
    expect(result.tokens.refreshToken).toHaveLength(64);
    expect(transport.requests).toHaveLength(1);
  });

  it("fails closed before transport when an authenticated request has no token", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("transport must not run");
    });
    const client = createClient(transport);

    await expect(client.listDevices()).rejects.toMatchObject({
      code: "CLOUD_AUTHENTICATION_REQUIRED",
      requestId: REQUEST_ID,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("delegates session authentication to a native transport without reading a token", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request.authentication).toBe("session");
      expect(request.headers.Authorization).toBeUndefined();
      return success({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        sessions: [sessionGrant().session],
        nextCursor: null,
      });
    }, true);
    const client = createClient(transport);

    const result = await client.listSessions();

    expect(result.sessions).toHaveLength(1);
  });

  it("uses a bearer token for authenticated pagination without exposing it elsewhere", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request.path).toBe("/v1/auth/sessions?cursor=cursor_1&limit=25");
      expect(request.headers.Authorization).toBe(`Bearer ${"t".repeat(64)}`);
      return success({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        sessions: [sessionGrant().session],
        nextCursor: null,
      });
    });
    const client = createClient(transport, {
      readAccessToken: () => Promise.resolve("t".repeat(64)),
    });

    const result = await client.listSessions({ cursor: "cursor_1", limit: 25 });

    expect(result.sessions).toHaveLength(1);
  });

  it("rejects plaintext extensions and project-scope mismatches before upload", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("transport must not run");
    });
    const client = createClient(transport, {
      readAccessToken: () => Promise.resolve("t".repeat(64)),
    });
    const valid = syncPushRequest();
    const firstChunk = valid.chunks[0];
    if (firstChunk === undefined) {
      throw new Error("The sync fixture must contain one ciphertext chunk.");
    }
    const withPlaintext = {
      ...valid,
      chunks: [
        {
          ...firstChunk,
          encrypted: {
            ...firstChunk.encrypted,
            plaintext: "must-remain-local",
          },
        },
      ],
    };

    await expect(
      client.pushSync(PROJECT_ID, withPlaintext, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    await expect(
      client.pushSync("018f0d7a-3b2c-7abc-8def-00000000000a", valid, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    expect(transport.requests).toHaveLength(0);
  });

  it("serializes protocol-v2 sync operations without dropping their object type", async () => {
    const transport = new RecordingTransport((request) => {
      const body = request.body as CloudSyncPushRequest;
      expect(body.operations).toEqual([
        expect.objectContaining({
          schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
          objectType: "chapter_version",
        }),
      ]);
      return success({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        acceptedOperations: [
          {
            operationId: OPERATION_ID,
            disposition: "accepted",
          },
        ],
        remoteCursor: "cursor_2",
        serverTime: NOW,
      });
    }, true);
    const client = createClient(transport);

    await expect(
      client.pushSync(PROJECT_ID, syncPushRequest(), {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toMatchObject({
      acceptedOperations: [{ operationId: OPERATION_ID }],
    });
  });

  it("rejects legacy or untyped nested sync operations before transport", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("transport must not run");
    }, true);
    const client = createClient(transport);
    const valid = syncPushRequest();
    const operation = valid.operations[0];
    if (operation === undefined) {
      throw new Error("The sync fixture must contain one operation.");
    }
    const legacyRequest = {
      ...valid,
      operations: [{ ...operation, schemaVersion: CONTRACT_SCHEMA_VERSION }],
    } as unknown as CloudSyncPushRequest;
    const untypedOperation = withoutObjectType(operation);
    const untypedRequest = {
      ...valid,
      operations: [untypedOperation],
    } as unknown as CloudSyncPushRequest;

    await expect(
      client.pushSync(PROJECT_ID, legacyRequest, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    await expect(
      client.pushSync(PROJECT_ID, untypedRequest, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    expect(transport.requests).toHaveLength(0);
  });

  it("requires exact sync acknowledgements instead of silently dropping operations", async () => {
    const transport = new RecordingTransport(() =>
      success({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        acceptedOperations: [],
        remoteCursor: "cursor_2",
        serverTime: NOW,
      }),
    );
    const client = createClient(transport, {
      readAccessToken: () => Promise.resolve("t".repeat(64)),
    });

    await expect(
      client.pushSync(PROJECT_ID, syncPushRequest(), {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    });
  });

  it("parses protocol-v2 pull operations and tombstones with their exact object type", async () => {
    const deletion = syncDeletePayload();
    const transport = new RecordingTransport(
      () =>
        success({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          operations: deletion.operations,
          chunks: deletion.chunks,
          tombstones: deletion.tombstones,
          nextCursor: "cursor_2",
          hasMore: false,
        }),
      true,
    );
    const client = createClient(transport);

    await expect(client.pullSync(PROJECT_ID)).resolves.toMatchObject({
      operations: [
        {
          schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
          objectType: "memory",
        },
      ],
      tombstones: [
        {
          schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
          objectType: "memory",
        },
      ],
    });
  });

  it("rejects legacy or untyped nested pull responses", async () => {
    const deletion = syncDeletePayload();
    const operation = deletion.operations[0];
    const tombstone = deletion.tombstones[0];
    if (operation === undefined || tombstone === undefined) {
      throw new Error("The deletion fixture must contain an operation and tombstone.");
    }
    const legacyTransport = new RecordingTransport(
      () =>
        success({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          operations: [{ ...operation, schemaVersion: CONTRACT_SCHEMA_VERSION }],
          chunks: [],
          tombstones: deletion.tombstones,
          nextCursor: "cursor_2",
          hasMore: false,
        }),
      true,
    );
    const legacyClient = createClient(legacyTransport);

    await expect(legacyClient.pullSync(PROJECT_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    });

    const untypedTombstone = withoutObjectType(tombstone);
    const untypedTransport = new RecordingTransport(
      () =>
        success({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          operations: deletion.operations,
          chunks: [],
          tombstones: [untypedTombstone],
          nextCursor: "cursor_2",
          hasMore: false,
        }),
      true,
    );
    const untypedClient = createClient(untypedTransport);

    await expect(untypedClient.pullSync(PROJECT_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    });
  });

  it("keeps object types in tombstone acknowledgement requests and rejects untyped entries", async () => {
    const acknowledgement: CloudTombstoneAcknowledgementRequest = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      acknowledgements: [
        {
          objectType: "memory",
          objectId: OBJECT_ID,
          objectGeneration: 1,
        },
      ],
    };
    const transport = new RecordingTransport((request) => {
      expect(request.path).toBe(`/v1/projects/${PROJECT_ID}/sync/tombstone-acknowledgements`);
      expect(request.body).toEqual(acknowledgement);
      return {
        status: 202,
        headers: { "x-request-id": REQUEST_ID },
        body: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          accepted: true,
          completedAt: NOW,
        },
      };
    }, true);
    const client = createClient(transport);

    await expect(
      client.acknowledgeTombstones(PROJECT_ID, acknowledgement, {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toMatchObject({ accepted: true });

    const typedEntry = acknowledgement.acknowledgements[0];
    if (typedEntry === undefined) {
      throw new Error("The acknowledgement fixture must contain one entry.");
    }
    const untypedEntry = withoutObjectType(typedEntry);
    const invalidRequest = {
      ...acknowledgement,
      acknowledgements: [untypedEntry],
    } as unknown as CloudTombstoneAcknowledgementRequest;
    await expect(
      client.acknowledgeTombstones(PROJECT_ID, invalidRequest, {
        idempotencyKey: `${IDEMPOTENCY_KEY}-untyped`,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    expect(transport.requests).toHaveLength(1);
  });

  it("discovers the current active project key without guessing a version", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request.path).toBe(`/v1/projects/${PROJECT_ID}/keys/current`);
      expect(request.method).toBe("GET");
      return success(currentProjectKeyResponse());
    }, true);
    const client = createClient(transport);

    await expect(client.getCurrentProjectKeys(PROJECT_ID)).resolves.toMatchObject({
      keySet: {
        projectId: PROJECT_ID,
        keyVersion: 2,
        serverRevision: 2,
        version: { state: "active" },
      },
    });
  });

  it("reads project state with an opaque checkpoint cursor", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request.path).toBe(`/v1/projects/${PROJECT_ID}?cursor=checkpoint_cursor`);
      expect(request.method).toBe("GET");
      return success(projectStateResponse());
    }, true);
    const client = createClient(transport);

    await expect(
      client.getProjectState(PROJECT_ID, { cursor: "checkpoint_cursor" }),
    ).resolves.toMatchObject({
      project: {
        projectId: PROJECT_ID,
        currentKeyVersion: 2,
        serverRevision: 2,
        currentKeyPublication: {
          publicationRequestSha256: "c".repeat(64),
        },
        sync: { cursorStatus: "incremental_available" },
      },
    });
  });

  it("pages a project-scoped sync snapshot with distinct signed cursors", async () => {
    const transport = new RecordingTransport((request) => {
      expect(request.path).toBe(
        `/v1/projects/${PROJECT_ID}/sync/snapshot?cursor=snapshot_cursor_1&limit=50`,
      );
      expect(request.method).toBe("GET");
      return success(syncSnapshotResponse());
    }, true);
    const client = createClient(transport);

    await expect(
      client.getSyncSnapshot(PROJECT_ID, {
        cursor: "snapshot_cursor_1",
        limit: 50,
      }),
    ).resolves.toMatchObject({
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      resumeCursor: "resume_cursor",
      nextSnapshotCursor: "snapshot_cursor_2",
      hasMore: true,
    });
  });

  it("rejects malformed or cross-project snapshot pages as protocol failures", async () => {
    const otherProjectId = "018f0d7a-3b2c-7abc-8def-00000000000b";
    const crossProjectTransport = new RecordingTransport(() => {
      const response = syncSnapshotResponse();
      return success({
        ...response,
        projectId: otherProjectId,
        operations: response.operations.map((operation) => ({
          ...operation,
          projectId: otherProjectId,
        })),
        chunks: response.chunks.map((chunk) => ({
          ...chunk,
          encrypted: {
            ...chunk.encrypted,
            aad: {
              ...chunk.encrypted.aad,
              projectId: otherProjectId,
            },
          },
        })),
      });
    }, true);
    const crossProjectClient = createClient(crossProjectTransport);

    await expect(crossProjectClient.getSyncSnapshot(PROJECT_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    });

    const missingChunkTransport = new RecordingTransport(() => {
      const response = syncSnapshotResponse();
      return success({ ...response, chunks: [] });
    }, true);
    const missingChunkClient = createClient(missingChunkTransport);

    await expect(missingChunkClient.getSyncSnapshot(PROJECT_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    });

    const untypedOperationTransport = new RecordingTransport(() => {
      const response = syncSnapshotResponse();
      const operation = response.operations[0];
      if (operation === undefined) {
        throw new Error("The snapshot fixture must contain an operation.");
      }
      const untypedOperation = withoutObjectType(operation);
      return success({ ...response, operations: [untypedOperation] });
    }, true);
    const untypedOperationClient = createClient(untypedOperationTransport);

    await expect(untypedOperationClient.getSyncSnapshot(PROJECT_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    });
  });

  it("rejects invalid state and snapshot cursors before transport", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("transport must not run");
    }, true);
    const client = createClient(transport);

    await expect(client.getProjectState(PROJECT_ID, { cursor: "not valid" })).rejects.toMatchObject(
      {
        code: "CLOUD_REQUEST_INVALID",
      },
    );
    await expect(client.getSyncSnapshot(PROJECT_ID, { limit: 257 })).rejects.toMatchObject({
      code: "CLOUD_REQUEST_INVALID",
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("exposes exact project deletion request, lookup and cancellation methods", async () => {
    const transport = new RecordingTransport(
      (request) => {
        if (request.path.endsWith("/deletion-requests")) {
          expect(request.method).toBe("POST");
          expect(request.authentication).toBe("session");
          expect(request.headers["Idempotency-Key"]).toBe(IDEMPOTENCY_KEY);
          expect(request.body).toEqual(deletionSubmission());
          return success(deletionResponse("project", PROJECT_ID), 202);
        }
        if (request.path.endsWith("/deletion-request")) {
          expect(request.method).toBe("GET");
          expect(request.headers["Idempotency-Key"]).toBeUndefined();
          expect(request.body).toBeNull();
          return success(deletionResponse("project", PROJECT_ID));
        }
        expect(request.path).toBe(`/v1/projects/${PROJECT_ID}/deletion-cancellations`);
        expect(request.method).toBe("POST");
        expect(request.body).toEqual({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          deletionRequestId: DELETION_REQUEST_ID,
          expectedDeletionRevision: 1,
        });
        return success(deletionResponse("project", PROJECT_ID, "cancelled"));
      },
      true,
      true,
    );
    const client = createClient(transport);

    await expect(
      client.requestProjectDeletion(PROJECT_ID, deletionSubmission(), {
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).resolves.toMatchObject({ deletionRequest: { targetKind: "project" } });
    await expect(client.getProjectDeletionRequest(PROJECT_ID)).resolves.toMatchObject({
      deletionRequest: { targetId: PROJECT_ID },
    });
    await expect(
      client.cancelProjectDeletion(
        PROJECT_ID,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          deletionRequestId: DELETION_REQUEST_ID,
          expectedDeletionRevision: 1,
        },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-cancel` },
      ),
    ).resolves.toMatchObject({ deletionRequest: { state: "cancelled" } });
    expect(transport.requests).toHaveLength(3);
  });

  it("uses native-password account deletion request, non-mutating POST lookup and cancellation", async () => {
    const transport = new RecordingTransport(
      (request) => {
        if (request.path === "/v1/account/deletion-requests") {
          expect(request.authentication).toBe("session");
          expect(request.headers["Idempotency-Key"]).toBe(IDEMPOTENCY_KEY);
          return success(deletionResponse("account", ACCOUNT_ID), 202);
        }
        if (request.path === "/v1/account/deletion-request-lookups") {
          expect(request.method).toBe("POST");
          expect(request.authentication).toBe("none");
          expect(request.headers["Idempotency-Key"]).toBeUndefined();
          expect(request.body).toMatchObject({
            email: "writer@example.com",
            deletionRequestId: DELETION_REQUEST_ID,
          });
          return success(deletionResponse("account", ACCOUNT_ID));
        }
        expect(request.path).toBe("/v1/account/deletion-cancellations");
        expect(request.authentication).toBe("none");
        expect(request.headers["Idempotency-Key"]).toBe(`${IDEMPOTENCY_KEY}-cancel`);
        return success(deletionResponse("account", ACCOUNT_ID, "cancelled"));
      },
      true,
      true,
    );
    const client = createClient(transport);
    const proof = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deletionRequestId: DELETION_REQUEST_ID,
      email: " Writer@Example.COM ",
      password: "test-correct-horse-battery-staple",
    };

    await expect(
      client.requestAccountDeletion(
        { ...deletionSubmission(), email: "writer@example.com" },
        {
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ),
    ).resolves.toMatchObject({ deletionRequest: { targetKind: "account" } });
    await expect(client.lookupAccountDeletion(proof)).resolves.toMatchObject({
      deletionRequest: { deletionRequestId: DELETION_REQUEST_ID },
    });
    await expect(
      client.cancelAccountDeletion(
        { ...proof, expectedDeletionRevision: 1 },
        { idempotencyKey: `${IDEMPOTENCY_KEY}-cancel` },
      ),
    ).resolves.toMatchObject({ deletionRequest: { state: "cancelled" } });
  });

  it("refuses password-bearing deletion operations on a generic transport", async () => {
    const transport = new RecordingTransport(
      () => {
        throw new Error("transport must not run");
      },
      true,
      false,
    );
    const client = createClient(transport);

    await expect(
      client.requestAccountDeletion(
        { ...deletionSubmission(), email: "writer@example.com" },
        {
          idempotencyKey: IDEMPOTENCY_KEY,
        },
      ),
    ).rejects.toMatchObject({
      code: "CLOUD_REQUEST_INVALID",
      requestId: REQUEST_ID,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("fails closed when a deletion response crosses its target or request scope", async () => {
    const transport = new RecordingTransport(
      () => success(deletionResponse("account", ACCOUNT_ID)),
      true,
    );
    const client = createClient(transport);

    await expect(client.getProjectDeletionRequest(PROJECT_ID)).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
    });
  });

  it("maps stable server errors and never includes a thrown transport secret", async () => {
    const serverErrorTransport = new RecordingTransport(() => ({
      status: 401,
      headers: { "x-request-id": REQUEST_ID },
      body: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        error: {
          code: "AUTH_INVALID_CREDENTIALS",
          message: "The credentials could not be verified.",
          retryable: false,
          actions: ["RETRY"],
          supportId: null,
        },
      },
    }));
    const serverClient = createClient(serverErrorTransport);

    await expect(
      serverClient.login(loginRequest(), { idempotencyKey: IDEMPOTENCY_KEY }),
    ).rejects.toMatchObject({
      code: "AUTH_INVALID_CREDENTIALS",
      status: 401,
      message: "The credentials could not be verified.",
    });

    const transportSecret = "transport-secret-canary";
    const throwingTransport = new RecordingTransport(() => {
      throw new Error(transportSecret);
    });
    const throwingClient = createClient(throwingTransport);
    let error: unknown;
    try {
      await throwingClient.login(loginRequest(), { idempotencyKey: IDEMPOTENCY_KEY });
    } catch (cause: unknown) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CloudClientError);
    expect(JSON.stringify(error)).not.toContain(transportSecret);
    expect((error as CloudClientError).message).not.toContain(transportSecret);
    expect((error as CloudClientError).causeType).toBe("Error");
  });
});

class RecordingTransport implements CloudTransport {
  public readonly requests: CloudTransportRequest[] = [];

  public constructor(
    private readonly responder: (
      request: CloudTransportRequest,
    ) => CloudTransportResponse | Promise<CloudTransportResponse>,
    public readonly handlesSessionAuthentication = false,
    public readonly handlesNativePasswordBoundary = false,
  ) {}

  public async send(request: CloudTransportRequest): Promise<CloudTransportResponse> {
    this.requests.push(request);
    return await this.responder(request);
  }
}

function createClient(
  transport: CloudTransport,
  accessTokens?: { readAccessToken(): Promise<string | null> },
) {
  return new InkShadowCloudApiClient({
    transport,
    ...(accessTokens === undefined ? {} : { accessTokens }),
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

function deletionSubmission() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    expectedRevision: 1,
    confirmationId: CONFIRMATION_ID,
    password: "test-correct-horse-battery-staple",
  };
}

function deletionResponse(
  targetKind: "account" | "project",
  targetId: string,
  state: "grace_period" | "cancelled" = "grace_period",
) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    deletionRequest: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deletionRequestId: DELETION_REQUEST_ID,
      targetKind,
      targetId,
      state,
      phase: "freeze" as const,
      revision: state === "cancelled" ? 2 : 1,
      requestedAt: "2026-07-27T00:00:00.000Z",
      scheduledFor: "2026-07-29T00:00:00.000Z",
      cancellableUntil: "2026-07-28T23:59:59.000Z",
      commitStartedAt: null,
      liveDataPurgedAt: null,
      backupRetainedUntil: null,
      completedAt: state === "cancelled" ? "2026-07-28T00:00:00.000Z" : null,
      blockedReason: null,
      canCancel: state !== "cancelled",
      impactSummary: {
        projectCount: targetKind === "project" ? 1 : 3,
        syncOperationCount: 12,
        encryptedChunkCount: 18,
        keyEnvelopeCount: 4,
        deviceCount: targetKind === "project" ? 0 : 2,
        sessionCount: targetKind === "project" ? 0 : 1,
      },
    },
  };
}

function loginRequest(): CloudAuthenticationRequest {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    email: " Writer@Example.COM ",
    password: "test-correct-horse-battery-staple",
    device: {
      deviceId: DEVICE_ID,
      displayName: "主力写作设备",
      algorithm: "DHKEM-P256-HKDF-SHA256",
      publicKey: "A".repeat(87),
      publicKeyFingerprint: "a".repeat(64),
      clientVersion: "0.1.0",
    },
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

function syncPushRequest(): CloudSyncPushRequest {
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
        objectType: "chapter_version",
        objectId: OBJECT_ID,
        objectGeneration: 1,
        kind: "upsert",
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
          algorithm: "AES-256-GCM",
          nonce: "A".repeat(16),
          ciphertext: "ciphertext_payload",
          ciphertextSha256: "b".repeat(64),
          plaintextBytes: 128,
          aad: {
            projectId: PROJECT_ID,
            objectType: "chapter_version",
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

function syncDeletePayload(): CloudSyncPushRequest {
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
        objectType: "memory",
        objectId: OBJECT_ID,
        objectGeneration: 1,
        kind: "delete",
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
        objectType: "memory",
        objectId: OBJECT_ID,
        objectGeneration: 1,
        deletedByDeviceId: DEVICE_ID,
        vector: { [DEVICE_ID]: 1 },
        deletedAt: NOW,
        retainUntil: "2027-07-28T00:00:00.000Z",
        acknowledgedDeviceIds: [],
      },
    ],
  };
}

function withoutObjectType<Value extends { readonly objectType: unknown }>(
  value: Value,
): Omit<Value, "objectType"> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "objectType")) as Omit<
    Value,
    "objectType"
  >;
}

function currentProjectKeyResponse() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    keySet: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      keyVersion: 2,
      serverRevision: 2,
      publication: projectKeyPublication(),
      version: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        projectId: PROJECT_ID,
        keyVersion: 2,
        algorithm: "AES-256-GCM" as const,
        state: "active" as const,
        revision: 2,
        createdAt: NOW,
        retiredAt: null,
      },
      recoveryEnvelope: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        algorithm: "ARGON2ID-AES256GCM" as const,
        recoveryId: OBJECT_ID,
        projectId: PROJECT_ID,
        keyVersion: 2,
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
          envelopeId: VERSION_ID,
          projectId: PROJECT_ID,
          keyVersion: 2,
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
      updatedAt: NOW,
    },
  };
}

function projectKeyPublication() {
  return {
    projectId: PROJECT_ID,
    keyVersion: 2,
    serverRevision: 2,
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
      currentKeyVersion: 2,
      serverRevision: 2,
      currentKeyPublication: projectKeyPublication(),
      updatedAt: NOW,
      sync: {
        headCursor: "head_cursor",
        minimumAvailableCursor: "minimum_cursor",
        cursorStatus: "incremental_available" as const,
      },
    },
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
    nextSnapshotCursor: "snapshot_cursor_2",
    hasMore: true,
  };
}
