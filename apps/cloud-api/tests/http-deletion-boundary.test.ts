import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CloudApiErrorResponseSchema,
  CloudDeletionRequestResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  type CloudDeletionRequestResponse,
} from "@inkshadow/contracts";

import { createCloudApiServer } from "../src/http/server.js";
import type { CloudDeletionService } from "../src/service/deletion-service.js";
import { invalidCredentials, resourceNotFound } from "../src/service/errors.js";
import type { CloudIdentityService, CloudPrincipal } from "../src/service/identity-service.js";
import type { CloudProjectSyncService } from "../src/service/project-sync-service.js";

const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000301";
const OTHER_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000308";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000302";
const OTHER_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000309";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000303";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000304";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000305";
const OTHER_PROJECT_ID = "019f9f4a-b3c7-7350-9226-00000000030a";
const DELETION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000306";
const OTHER_DELETION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-00000000030b";
const CONFIRMATION_ID = "019f9f4a-b3c7-7350-9226-000000000307";
const PASSWORD = "test-correct-horse-battery-staple";
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

describe("cloud deletion HTTP boundary", () => {
  it("registers every frozen route without inventing a successful service implementation", async () => {
    const server = createServer();
    await server.ready();

    for (const [method, url] of [
      ["POST", "/v1/projects/:projectId/deletion-requests"],
      ["GET", "/v1/projects/:projectId/deletion-request"],
      ["POST", "/v1/projects/:projectId/deletion-cancellations"],
      ["POST", "/v1/account/deletion-requests"],
      ["POST", "/v1/account/deletion-request-lookups"],
      ["POST", "/v1/account/deletion-cancellations"],
    ] as const) {
      expect(server.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }

    const response = await server.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/deletion-requests`,
      headers: mutationHeaders(),
      payload: submission(),
    });
    expect(response.statusCode).toBe(503);
    expect(CloudApiErrorResponseSchema.parse(response.json()).error.code).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(response.body).not.toContain(PASSWORD);
  });

  it("passes a strict project request to the service and returns no reauthentication secret", async () => {
    const requestProjectDeletion = vi
      .fn<CloudDeletionService["requestProjectDeletion"]>()
      .mockResolvedValue(deletionResponse("project", PROJECT_ID));
    const server = createServer({
      ...deletionServiceStub(),
      requestProjectDeletion,
    });
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: `/v1/projects/${PROJECT_ID}/deletion-requests`,
      headers: mutationHeaders(),
      payload: submission(),
    });

    expect(response.statusCode).toBe(202);
    expect(CloudDeletionRequestResponseSchema.parse(response.json()).deletionRequest).toMatchObject(
      {
        targetKind: "project",
        targetId: PROJECT_ID,
      },
    );
    expect(requestProjectDeletion).toHaveBeenCalledWith(principal, PROJECT_ID, submission(), {
      idempotencyKey: "deletion-idempotency-key-0001",
      requestId: REQUEST_ID,
    });
    expect(response.body).not.toContain(PASSWORD);
  });

  it("keeps account lookup non-mutating while normalizing its proof email", async () => {
    const lookupAccountDeletion = vi
      .fn<CloudDeletionService["lookupAccountDeletion"]>()
      .mockResolvedValue(deletionResponse("account", ACCOUNT_ID));
    const authenticateAccessToken = vi.fn(() => Promise.resolve(principal));
    const server = createServer(
      {
        ...deletionServiceStub(),
        lookupAccountDeletion,
      },
      authenticateAccessToken,
    );
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/v1/account/deletion-request-lookups",
      headers: readHeaders(),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: " Writer@Example.COM ",
        password: PASSWORD,
        deletionRequestId: DELETION_REQUEST_ID,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(lookupAccountDeletion).toHaveBeenCalledWith(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: "writer@example.com",
        password: PASSWORD,
        deletionRequestId: DELETION_REQUEST_ID,
      },
      { requestId: REQUEST_ID },
    );
    expect(authenticateAccessToken).not.toHaveBeenCalled();
    expect(response.body).not.toContain(PASSWORD);
  });

  it("recovers an account deletion by confirmationId without bearer authentication", async () => {
    const lookupAccountDeletion = vi
      .fn<CloudDeletionService["lookupAccountDeletion"]>()
      .mockResolvedValue(deletionResponse("account", ACCOUNT_ID));
    const authenticateAccessToken = vi.fn(() => Promise.resolve(principal));
    const server = createServer(
      {
        ...deletionServiceStub(),
        lookupAccountDeletion,
      },
      authenticateAccessToken,
    );
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/v1/account/deletion-request-lookups",
      headers: readHeaders(),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: "writer@example.com",
        password: PASSWORD,
        confirmationId: CONFIRMATION_ID,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(lookupAccountDeletion).toHaveBeenCalledWith(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: "writer@example.com",
        password: PASSWORD,
        confirmationId: CONFIRMATION_ID,
      },
      { requestId: REQUEST_ID },
    );
    expect(authenticateAccessToken).not.toHaveBeenCalled();
    expect(response.body).not.toContain(PASSWORD);
  });

  it("cancels an account deletion with credentials after every bearer session is gone", async () => {
    const cancelAccountDeletion = vi
      .fn<CloudDeletionService["cancelAccountDeletion"]>()
      .mockResolvedValue(deletionResponse("account", ACCOUNT_ID, "cancelled"));
    const authenticateAccessToken = vi.fn(() => Promise.resolve(principal));
    const server = createServer(
      {
        ...deletionServiceStub(),
        cancelAccountDeletion,
      },
      authenticateAccessToken,
    );
    await server.ready();

    const response = await server.inject({
      method: "POST",
      url: "/v1/account/deletion-cancellations",
      headers: credentialMutationHeaders(),
      payload: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: "writer@example.com",
        password: PASSWORD,
        deletionRequestId: DELETION_REQUEST_ID,
        expectedDeletionRevision: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(CloudDeletionRequestResponseSchema.parse(response.json()).deletionRequest.state).toBe(
      "cancelled",
    );
    expect(cancelAccountDeletion).toHaveBeenCalledWith(
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        email: "writer@example.com",
        password: PASSWORD,
        deletionRequestId: DELETION_REQUEST_ID,
        expectedDeletionRevision: 1,
      },
      {
        idempotencyKey: "deletion-idempotency-key-0001",
        requestId: REQUEST_ID,
      },
    );
    expect(authenticateAccessToken).not.toHaveBeenCalled();
    expect(response.body).not.toContain(PASSWORD);
  });

  it("fails closed when a deletion service response is not bound to the HTTP request scope", async () => {
    const projectRequestResponse = deletionResponse("project", PROJECT_ID);
    const accountLookupResponse = deletionResponse("account", ACCOUNT_ID);
    const cases = [
      {
        name: "account request target",
        server: createServer({
          ...deletionServiceStub(),
          requestAccountDeletion: () =>
            Promise.resolve(deletionResponse("account", OTHER_ACCOUNT_ID)),
        }),
        request: {
          method: "POST" as const,
          url: "/v1/account/deletion-requests",
          headers: mutationHeaders(),
          payload: accountSubmission(),
        },
      },
      {
        name: "account lookup deletion request",
        server: createServer({
          ...deletionServiceStub(),
          lookupAccountDeletion: () =>
            Promise.resolve(
              replaceDeletionRequest(accountLookupResponse, {
                deletionRequestId: OTHER_DELETION_REQUEST_ID,
              }),
            ),
        }),
        request: {
          method: "POST" as const,
          url: "/v1/account/deletion-request-lookups",
          headers: readHeaders(),
          payload: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            email: "writer@example.com",
            password: PASSWORD,
            deletionRequestId: DELETION_REQUEST_ID,
          },
        },
      },
      {
        name: "project request correlation",
        server: createServer({
          ...deletionServiceStub(),
          requestProjectDeletion: () =>
            Promise.resolve({
              ...projectRequestResponse,
              requestId: OTHER_REQUEST_ID,
            }),
        }),
        request: {
          method: "POST" as const,
          url: `/v1/projects/${PROJECT_ID}/deletion-requests`,
          headers: mutationHeaders(),
          payload: submission(),
        },
      },
      {
        name: "project lookup target",
        server: createServer({
          ...deletionServiceStub(),
          getProjectDeletionRequest: () =>
            Promise.resolve(deletionResponse("project", OTHER_PROJECT_ID)),
        }),
        request: {
          method: "GET" as const,
          url: `/v1/projects/${PROJECT_ID}/deletion-request`,
          headers: authenticatedReadHeaders(),
        },
      },
      {
        name: "project cancellation deletion request",
        server: createServer({
          ...deletionServiceStub(),
          cancelProjectDeletion: () =>
            Promise.resolve(
              replaceDeletionRequest(deletionResponse("project", PROJECT_ID, "cancelled"), {
                deletionRequestId: OTHER_DELETION_REQUEST_ID,
              }),
            ),
        }),
        request: {
          method: "POST" as const,
          url: `/v1/projects/${PROJECT_ID}/deletion-cancellations`,
          headers: mutationHeaders(),
          payload: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            deletionRequestId: DELETION_REQUEST_ID,
            expectedDeletionRevision: 1,
          },
        },
      },
    ];

    for (const testCase of cases) {
      await testCase.server.ready();
      const response = await testCase.server.inject(testCase.request);
      expect(response.statusCode, testCase.name).toBe(500);
      expect(CloudApiErrorResponseSchema.parse(response.json()).error.code, testCase.name).toBe(
        "INTERNAL_ERROR",
      );
    }
  });

  it("requires both cancellation routes to return the cancelled state", async () => {
    const cases = [
      {
        name: "account cancellation",
        server: createServer({
          ...deletionServiceStub(),
          cancelAccountDeletion: () =>
            Promise.resolve(deletionResponse("account", ACCOUNT_ID, "grace_period")),
        }),
        request: {
          method: "POST" as const,
          url: "/v1/account/deletion-cancellations",
          headers: credentialMutationHeaders(),
          payload: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            email: "writer@example.com",
            password: PASSWORD,
            deletionRequestId: DELETION_REQUEST_ID,
            expectedDeletionRevision: 1,
          },
        },
      },
      {
        name: "project cancellation",
        server: createServer({
          ...deletionServiceStub(),
          cancelProjectDeletion: () =>
            Promise.resolve(deletionResponse("project", PROJECT_ID, "grace_period")),
        }),
        request: {
          method: "POST" as const,
          url: `/v1/projects/${PROJECT_ID}/deletion-cancellations`,
          headers: mutationHeaders(),
          payload: {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            deletionRequestId: DELETION_REQUEST_ID,
            expectedDeletionRevision: 1,
          },
        },
      },
    ];

    for (const testCase of cases) {
      await testCase.server.ready();
      const response = await testCase.server.inject(testCase.request);
      expect(response.statusCode, testCase.name).toBe(500);
      expect(CloudApiErrorResponseSchema.parse(response.json()).error.code, testCase.name).toBe(
        "INTERNAL_ERROR",
      );
    }
  });

  it("makes an unknown account deletion request indistinguishable from a bad password", async () => {
    const responses = [];
    for (const error of [resourceNotFound(), invalidCredentials()]) {
      const server = createServer({
        ...deletionServiceStub(),
        lookupAccountDeletion: () => Promise.reject(error),
      });
      await server.ready();
      const response = await server.inject({
        method: "POST",
        url: "/v1/account/deletion-request-lookups",
        headers: readHeaders(),
        payload: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          email: "writer@example.com",
          password: PASSWORD,
          deletionRequestId: DELETION_REQUEST_ID,
        },
      });
      const body = CloudApiErrorResponseSchema.parse(response.json());
      responses.push({
        statusCode: response.statusCode,
        code: body.error.code,
        message: body.error.message,
        retryable: body.error.retryable,
        actions: body.error.actions,
      });
    }

    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]).toMatchObject({
      statusCode: 401,
      code: "AUTH_INVALID_CREDENTIALS",
    });
  });
});

function createServer(
  deletionService?: CloudDeletionService,
  authenticateAccessToken: () => Promise<CloudPrincipal> = () => Promise.resolve(principal),
) {
  const identityService = {
    authenticateAccessToken,
  } as unknown as CloudIdentityService;
  const server = createCloudApiServer({
    identityService,
    projectSyncService: {} as CloudProjectSyncService,
    ...(deletionService === undefined ? {} : { deletionService }),
    requireHttps: false,
    uuid: () => REQUEST_ID,
  });
  servers.push(server);
  return server;
}

function deletionServiceStub(): CloudDeletionService {
  return {
    requestProjectDeletion: () => Promise.resolve(deletionResponse("project", PROJECT_ID)),
    getProjectDeletionRequest: () => Promise.resolve(deletionResponse("project", PROJECT_ID)),
    cancelProjectDeletion: () =>
      Promise.resolve(deletionResponse("project", PROJECT_ID, "cancelled")),
    requestAccountDeletion: () => Promise.resolve(deletionResponse("account", ACCOUNT_ID)),
    lookupAccountDeletion: () => Promise.resolve(deletionResponse("account", ACCOUNT_ID)),
    cancelAccountDeletion: () =>
      Promise.resolve(deletionResponse("account", ACCOUNT_ID, "cancelled")),
  };
}

function mutationHeaders() {
  return {
    authorization: `Bearer ${ACCESS_TOKEN}`,
    "content-type": "application/json",
    "idempotency-key": "deletion-idempotency-key-0001",
    "x-request-id": REQUEST_ID,
  };
}

function readHeaders() {
  return {
    "content-type": "application/json",
    "x-request-id": REQUEST_ID,
  };
}

function authenticatedReadHeaders() {
  return {
    ...readHeaders(),
    authorization: `Bearer ${ACCESS_TOKEN}`,
  };
}

function credentialMutationHeaders() {
  return {
    "content-type": "application/json",
    "idempotency-key": "deletion-idempotency-key-0001",
    "x-request-id": REQUEST_ID,
  };
}

function submission() {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    expectedRevision: 1,
    confirmationId: CONFIRMATION_ID,
    password: PASSWORD,
  };
}

function accountSubmission() {
  return {
    ...submission(),
    email: "writer@example.com",
  };
}

function deletionResponse(
  targetKind: "account" | "project",
  targetId: string,
  state: "cancelled" | "grace_period" = "grace_period",
): CloudDeletionRequestResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    deletionRequest: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deletionRequestId: DELETION_REQUEST_ID,
      targetKind,
      targetId,
      state,
      phase: "freeze",
      revision: state === "cancelled" ? 2 : 1,
      requestedAt: "2026-07-28T00:00:00.000Z",
      scheduledFor: "2026-07-30T00:00:00.000Z",
      cancellableUntil: "2026-07-29T00:00:00.000Z",
      commitStartedAt: null,
      liveDataPurgedAt: null,
      backupRetainedUntil: null,
      completedAt: state === "cancelled" ? "2026-07-28T01:00:00.000Z" : null,
      blockedReason: null,
      canCancel: state !== "cancelled",
      impactSummary: {
        projectCount: targetKind === "project" ? 1 : 2,
        syncOperationCount: 8,
        encryptedChunkCount: 12,
        keyEnvelopeCount: 3,
        deviceCount: targetKind === "project" ? 0 : 2,
        sessionCount: targetKind === "project" ? 0 : 1,
      },
    },
  };
}

function replaceDeletionRequest(
  response: CloudDeletionRequestResponse,
  replacement: Partial<CloudDeletionRequestResponse["deletionRequest"]>,
): CloudDeletionRequestResponse {
  return {
    ...response,
    deletionRequest: {
      ...response.deletionRequest,
      ...replacement,
    },
  };
}
