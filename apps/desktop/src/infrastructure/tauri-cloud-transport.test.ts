import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudClientError, InkShadowCloudApiClient } from "@inkshadow/cloud-client";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

import { TauriCloudTransport } from "./tauri-cloud-transport";

const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000111";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000112";
const DELETION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000113";
const CONFIRMATION_ID = "019f9f4a-b3c7-7350-9226-000000000114";
const TEAM_ID = "019f9f4a-b3c7-7350-9226-000000000115";
const MEMBERSHIP_ID = "019f9f4a-b3c7-7350-9226-000000000116";
const ASSIGNMENT_ID = "019f9f4a-b3c7-7350-9226-000000000117";
const ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000118";
const RECIPIENT_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000119";
const PASSWORD = "test-correct-horse-battery-staple";

describe("TauriCloudTransport", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
  });

  it("delegates session authentication to the native gateway without an Authorization header", async () => {
    tauriMocks.invoke.mockResolvedValueOnce({
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": REQUEST_ID,
      },
      body: {
        schemaVersion: 1,
        requestId: REQUEST_ID,
        sessions: [],
        nextCursor: null,
      },
    });
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });

    const response = await transport.send({
      method: "GET",
      path: "/v1/auth/sessions?limit=50",
      authentication: "session",
      headers: { "X-Request-Id": REQUEST_ID },
      body: null,
    });

    expect(transport.handlesSessionAuthentication).toBe(true);
    expect(transport.handlesNativePasswordBoundary).toBe(true);
    expect(response.status).toBe(200);
    expect(tauriMocks.invoke).toHaveBeenCalledWith("send_cloud_api_request", {
      input: {
        baseUrl: "https://cloud.example.test",
        allowInsecureLoopback: false,
        method: "GET",
        path: "/v1/auth/sessions?limit=50",
        headers: { "X-Request-Id": REQUEST_ID },
        body: null,
        authentication: "session",
      },
    });
    expect(JSON.stringify(tauriMocks.invoke.mock.calls)).not.toContain("Bearer");
  });

  it("relays ciphertext-free key metadata and publication but blocks device ciphertext", async () => {
    const request = teamEnvelopeRequest();
    tauriMocks.invoke
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": REQUEST_ID,
        },
        body: {
          schemaVersion: 1,
          requestId: REQUEST_ID,
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          keyVersion: 3,
          recipients: [],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": REQUEST_ID,
        },
        body: {
          schemaVersion: 1,
          requestId: REQUEST_ID,
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          keyVersion: 3,
          state: "active",
          serverRevision: 9,
          updatedAt: "2026-07-28T01:59:00.000Z",
          currentDeviceEnvelopeAvailable: true,
        },
      })
      .mockResolvedValueOnce({
        status: 201,
        headers: {
          "content-type": "application/json",
          "x-request-id": REQUEST_ID,
        },
        body: {
          schemaVersion: 1,
          requestId: REQUEST_ID,
          envelope: { ...request, createdAt: "2026-07-28T02:00:00.000Z" },
        },
      });
    const client = new InkShadowCloudApiClient({
      transport: new TauriCloudTransport({
        baseUrl: "https://cloud.example.test",
      }),
      requestIdFactory: () => REQUEST_ID,
    });

    await client.listEligibleTeamProjectKeyRecipients(TEAM_ID, PROJECT_ID, 3);
    await client.getCurrentTeamProjectKeyMetadata(TEAM_ID, PROJECT_ID);
    await client.publishTeamProjectKeyEnvelope(TEAM_ID, PROJECT_ID, 3, request, {
      idempotencyKey: "team-envelope-idempotency-0001",
    });
    await expect(
      client.getCurrentDeviceTeamProjectKeyEnvelope(TEAM_ID, PROJECT_ID, 3, RECIPIENT_DEVICE_ID),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID", retryable: false });

    expect(tauriMocks.invoke.mock.calls.map(([, payload]) => payload as unknown)).toEqual([
      {
        input: {
          baseUrl: "https://cloud.example.test",
          allowInsecureLoopback: false,
          method: "GET",
          path: `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/keys/3/recipients`,
          headers: { "X-Request-Id": REQUEST_ID },
          body: null,
          authentication: "session",
        },
      },
      {
        input: {
          baseUrl: "https://cloud.example.test",
          allowInsecureLoopback: false,
          method: "GET",
          path: `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/keys/current`,
          headers: { "X-Request-Id": REQUEST_ID },
          body: null,
          authentication: "session",
        },
      },
      {
        input: {
          baseUrl: "https://cloud.example.test",
          allowInsecureLoopback: false,
          method: "POST",
          path: `/v1/teams/${TEAM_ID}/projects/${PROJECT_ID}/keys/3/envelopes`,
          headers: {
            "X-Request-Id": REQUEST_ID,
            "Idempotency-Key": "team-envelope-idempotency-0001",
          },
          body: request,
          authentication: "session",
        },
      },
    ]);
    const calls = JSON.stringify(tauriMocks.invoke.mock.calls);
    expect(calls).not.toContain("rawProjectDataKey");
    expect(calls).not.toContain("privateKey");
    expect(calls).not.toContain("recoveryCode");
  });

  it("rejects WebView-supplied authorization before invoking native code", async () => {
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });

    await expect(
      transport.send({
        method: "GET",
        path: "/v1/devices",
        authentication: "session",
        headers: {
          "X-Request-Id": REQUEST_ID,
          Authorization: ["Bearer", "test-forbidden-value"].join(" "),
        },
        body: null,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_REQUEST_INVALID",
      retryable: false,
    });
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("maps structured native session failures to a typed authentication error", async () => {
    tauriMocks.invoke.mockRejectedValueOnce({
      code: "CLOUD_SESSION_NOT_CONFIGURED",
      message: "No cloud session is stored on this device.",
      retryable: false,
      actions: ["SIGN_IN"],
      requestId: REQUEST_ID,
    });
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });

    const failure = await transport
      .send({
        method: "GET",
        path: "/v1/devices",
        authentication: "session",
        headers: { "X-Request-Id": REQUEST_ID },
        body: null,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CloudClientError);
    expect(failure).toMatchObject({
      code: "CLOUD_AUTHENTICATION_REQUIRED",
      requestId: REQUEST_ID,
      actions: ["SIGN_IN"],
    });
  });

  it("fails closed on unexpected response headers or an already-aborted request", async () => {
    tauriMocks.invoke.mockResolvedValueOnce({
      status: 200,
      headers: { "set-cookie": "session=test-forbidden-value" },
      body: {},
    });
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });

    await expect(
      transport.send({
        method: "GET",
        path: "/v1/devices",
        authentication: "session",
        headers: { "X-Request-Id": REQUEST_ID },
        body: null,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_PROTOCOL_INVALID_RESPONSE" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.send({
        method: "GET",
        path: "/v1/devices",
        authentication: "session",
        headers: { "X-Request-Id": REQUEST_ID },
        body: null,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_ABORTED" });
    expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects every dedicated credential route before values reach IPC", async () => {
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });
    const client = new InkShadowCloudApiClient({
      transport,
      requestIdFactory: () => REQUEST_ID,
    });
    const device = {
      deviceId: "019f9f4a-b3c7-7350-9226-000000000112",
      displayName: "Writer",
      algorithm: "DHKEM-P256-HKDF-SHA256" as const,
      publicKey: "A".repeat(87),
      publicKeyFingerprint: "a".repeat(64),
      clientVersion: "0.1.0",
    };
    const options = { idempotencyKey: REQUEST_ID };

    const attempts = [
      client.login(
        {
          schemaVersion: 1,
          email: "writer@example.test",
          password: "test-secure-password",
          device,
        },
        options,
      ),
      client.verifyEmail(
        {
          schemaVersion: 1,
          challengeId: "019f9f4a-b3c7-7350-9226-000000000113",
          code: "123456",
          device,
        },
        options,
      ),
      client.refresh(
        {
          schemaVersion: 1,
          deviceId: device.deviceId,
          refreshToken: "A".repeat(43),
        },
        options,
      ),
      client.logout(
        {
          schemaVersion: 1,
          sessionId: "019f9f4a-b3c7-7350-9226-000000000114",
        },
        options,
      ),
    ];

    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        code: "CLOUD_REQUEST_INVALID",
        retryable: false,
      });
    }
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("rejects nested token-shaped fields before IPC even on an otherwise allowed route", async () => {
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });

    await expect(
      transport.send({
        method: "POST",
        path: "/v1/devices",
        authentication: "session",
        headers: {
          "X-Request-Id": REQUEST_ID,
          "Idempotency-Key": REQUEST_ID,
        },
        body: {
          nested: {
            refresh_token: "A".repeat(43),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("routes every password-reauthenticated deletion operation through its dedicated command", async () => {
    tauriMocks.invoke.mockResolvedValue({
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": REQUEST_ID,
      },
      body: {},
    });
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });
    const mutationHeaders = {
      "X-Request-Id": REQUEST_ID,
      "Idempotency-Key": "deletion-idempotency-key-0001",
    };
    const submission = {
      schemaVersion: 1,
      expectedRevision: 2,
      confirmationId: CONFIRMATION_ID,
      password: PASSWORD,
    };
    const accountProof = {
      schemaVersion: 1,
      deletionRequestId: DELETION_REQUEST_ID,
      email: "Writer@Example.COM",
      password: PASSWORD,
    };

    await transport.send({
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/deletion-requests`,
      authentication: "session",
      headers: mutationHeaders,
      body: submission,
    });
    await transport.send({
      method: "POST",
      path: "/v1/account/deletion-requests",
      authentication: "session",
      headers: mutationHeaders,
      body: { ...submission, email: accountProof.email },
    });
    await transport.send({
      method: "POST",
      path: "/v1/account/deletion-request-lookups",
      authentication: "none",
      headers: { "X-Request-Id": REQUEST_ID },
      body: {
        schemaVersion: 1,
        confirmationId: CONFIRMATION_ID,
        email: accountProof.email,
        password: PASSWORD,
      },
    });
    await transport.send({
      method: "POST",
      path: "/v1/account/deletion-cancellations",
      authentication: "none",
      headers: mutationHeaders,
      body: { ...accountProof, expectedDeletionRevision: 3 },
    });

    expect(tauriMocks.invoke.mock.calls.map(([command]) => String(command))).toEqual([
      "send_cloud_deletion_credential_request",
      "send_cloud_deletion_credential_request",
      "send_cloud_deletion_credential_request",
      "send_cloud_deletion_credential_request",
    ]);
    expect(tauriMocks.invoke.mock.calls[0]?.[1]).toEqual({
      input: {
        operation: "request_project",
        baseUrl: "https://cloud.example.test",
        allowInsecureLoopback: false,
        projectId: PROJECT_ID,
        requestId: REQUEST_ID,
        idempotencyKey: mutationHeaders["Idempotency-Key"],
        expectedRevision: 2,
        confirmationId: CONFIRMATION_ID,
        password: PASSWORD,
      },
    });
    expect(tauriMocks.invoke.mock.calls[2]?.[1]).toMatchObject({
      input: {
        operation: "lookup_account",
        email: "writer@example.com",
        confirmationId: CONFIRMATION_ID,
      },
    });
    expect(tauriMocks.invoke.mock.calls[1]?.[1]).toMatchObject({
      input: {
        operation: "request_account",
        email: "writer@example.com",
      },
    });
    expect(tauriMocks.invoke.mock.calls[3]?.[1]).toMatchObject({
      input: {
        operation: "cancel_account",
        expectedDeletionRevision: 3,
      },
    });
  });

  it("rejects deletion passwords on the generic relay and malformed dedicated payloads", async () => {
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });

    await expect(
      transport.send({
        method: "POST",
        path: "/v1/devices",
        authentication: "session",
        headers: {
          "X-Request-Id": REQUEST_ID,
          "Idempotency-Key": "deletion-idempotency-key-0001",
        },
        body: { nested: { password: PASSWORD } },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    await expect(
      transport.send({
        method: "POST",
        path: `/v1/projects/${PROJECT_ID}/deletion-requests`,
        authentication: "session",
        headers: {
          "X-Request-Id": REQUEST_ID,
          "Idempotency-Key": "deletion-idempotency-key-0001",
        },
        body: {
          schemaVersion: 1,
          expectedRevision: 2,
          confirmationId: CONFIRMATION_ID,
          password: PASSWORD,
          plaintext: "must-not-cross",
        },
      }),
    ).rejects.toMatchObject({ code: "CLOUD_REQUEST_INVALID" });
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("treats malformed IPC failures and response headers as protocol errors", async () => {
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });
    tauriMocks.invoke.mockRejectedValueOnce("command not found");

    await expect(
      transport.send({
        method: "GET",
        path: "/v1/devices",
        authentication: "session",
        headers: { "X-Request-Id": REQUEST_ID },
        body: null,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_PROTOCOL_INVALID_RESPONSE",
      retryable: false,
      requestId: REQUEST_ID,
    });

    tauriMocks.invoke.mockResolvedValueOnce({
      status: 200,
      headers: {
        "content-type": "application/json\n",
      },
      body: {},
    });
    await expect(
      transport.send({
        method: "GET",
        path: "/v1/devices",
        authentication: "session",
        headers: { "X-Request-Id": REQUEST_ID },
        body: null,
      }),
    ).rejects.toMatchObject({ code: "CLOUD_PROTOCOL_INVALID_RESPONSE" });
  });

  it("does not report an in-flight native mutation as canceled after dispatch", async () => {
    let resolveInvoke: (value: unknown) => void = () => {
      throw new Error("test invoke resolver was not initialized");
    };
    tauriMocks.invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
    );
    const transport = new TauriCloudTransport({
      baseUrl: "https://cloud.example.test",
    });
    const controller = new AbortController();
    const operation = transport.send({
      method: "DELETE",
      path: "/v1/devices/019f9f4a-b3c7-7350-9226-000000000112",
      authentication: "session",
      headers: {
        "X-Request-Id": REQUEST_ID,
        "Idempotency-Key": REQUEST_ID,
      },
      body: null,
      signal: controller.signal,
    });
    controller.abort();
    resolveInvoke({
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": REQUEST_ID,
      },
      body: { schemaVersion: 1, requestId: REQUEST_ID },
    });

    await expect(operation).resolves.toMatchObject({ status: 200 });
  });
});

function teamEnvelopeRequest() {
  return {
    schemaVersion: 1 as const,
    envelopeKind: "team_project_member_device" as const,
    envelopeId: ENVELOPE_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    membershipId: MEMBERSHIP_ID,
    membershipRevision: 7,
    assignmentId: ASSIGNMENT_ID,
    assignmentRevision: 11,
    algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM" as const,
    senderDeviceId: RECIPIENT_DEVICE_ID,
    senderPublicKey: "A".repeat(87),
    senderPublicKeyFingerprint: "a".repeat(64),
    recipientDeviceId: RECIPIENT_DEVICE_ID,
    recipientPublicKey: "A".repeat(87),
    recipientPublicKeyFingerprint: "a".repeat(64),
    encapsulatedKey: "B".repeat(87),
    ciphertext: "C".repeat(64),
  };
}
