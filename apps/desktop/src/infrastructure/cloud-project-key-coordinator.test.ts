import { createHash } from "node:crypto";

import { CloudClientError, type InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import {
  canonicalCloudProjectKeyPublication,
  type CloudProjectKeyPublicationReceipt,
  type CloudProjectKeyPublishRequest,
  type CloudProjectKeySet,
  type DeviceProjectKeyEnvelopeContract,
} from "@inkshadow/contracts";
import {
  type BeginCloudProjectKeyPublicationInput,
  type CloudProjectKeyCheckpoint,
  type CloudProjectKeyPublication,
  type DevicePublicKeyRecord,
  type MarkCloudProjectKeyPublicationConflictInput,
  type ProjectKeyBundle,
  type RebaseCloudProjectKeyPublicationInput,
  type ResolveCloudProjectKeyPublicationInput,
  type SaveCloudProjectKeySetInput,
} from "@inkshadow/data/project-key-sqlite-store";
import { AppError, ok, type Clock, type UuidV7Generator } from "@inkshadow/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudAccountManagementSnapshot } from "./cloud-account-management-service";
import {
  CloudProjectKeyCoordinator,
  type CloudProjectKeyPublicationAuthority,
} from "./cloud-project-key-coordinator";
import type { ConfiguredCloudSessionStatus } from "./cloud-session-coordinator";
import type { OpenProjectDataKey, PendingProjectRotationDisplay } from "./project-key-lifecycle";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const LOCAL_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const REMOTE_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const LOCAL_ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const REMOTE_ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const RECOVERY_ID = "019f9f4a-b3c7-7350-9226-000000000008";
const IDEMPOTENCY_KEY = "019f9f4a-b3c7-7350-9226-000000000009";
const REBASED_IDEMPOTENCY_KEY = "019f9f4a-b3c7-7350-9226-00000000000a";
const NOW = "2026-07-27T00:00:00.000Z";
const LATER = "2026-07-27T00:01:00.000Z";

describe("CloudProjectKeyCoordinator", () => {
  let fixture: ReturnType<typeof createFixture>;

  beforeEach(() => {
    fixture = createFixture();
  });

  it("publishes exact envelopes for every trusted device and reuses the body across refresh", async () => {
    let calls = 0;
    fixture.api.publishProjectKeys.mockImplementation(
      (_projectId, _keyVersion, request: CloudProjectKeyPublishRequest) => {
        calls += 1;
        if (calls === 1) {
          throw cloudError("AUTH_SESSION_EXPIRED", true);
        }
        return Promise.resolve(responseFor(request));
      },
    );
    fixture.session.runWithSession.mockImplementation(async (operation) => {
      try {
        return await operation(configuredSession());
      } catch (cause: unknown) {
        if (cause instanceof CloudClientError && cause.code === "AUTH_SESSION_EXPIRED") {
          return operation(
            configuredSession({
              sessionId: "019f9f4a-b3c7-7350-9226-00000000000b",
            }),
          );
        }
        throw cause;
      }
    });

    const keySet = await fixture.coordinator.publishInitialProjectKey(PROJECT_ID);

    expect(keySet.serverRevision).toBe(1);
    expect(fixture.api.publishProjectKeys).toHaveBeenCalledTimes(2);
    const first = fixture.api.publishProjectKeys.mock.calls[0];
    const second = fixture.api.publishProjectKeys.mock.calls[1];
    expect(first?.[2]).toBe(second?.[2]);
    expect(first?.[3]).toEqual(second?.[3]);
    expect(first?.[2].deviceEnvelopes.map((envelope) => envelope.recipientDeviceId)).toEqual([
      LOCAL_DEVICE_ID,
      REMOTE_DEVICE_ID,
    ]);
    expect(fixture.store.publication).toBeNull();
    expect(fixture.store.checkpoint).toMatchObject({
      currentKeyVersion: 1,
      serverRevision: 1,
    });
  });

  it("treats an exact durable cloud key checkpoint as already published", async () => {
    fixture.store.checkpoint = {
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 7,
      updatedAt: NOW,
    };

    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(1)),
    ).resolves.toEqual({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      deviceId: LOCAL_DEVICE_ID,
      devicePublicKeyFingerprint: "a".repeat(64),
      keyVersion: 1,
    });
    expect(fixture.api.publishProjectKeys).not.toHaveBeenCalled();
    expect(fixture.account.load).not.toHaveBeenCalled();
    expect(fixture.session.runWithSession).toHaveBeenCalledTimes(2);
  });

  it("does not return checkpoint evidence after the active principal changes", async () => {
    fixture.store.checkpoint = {
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 7,
      updatedAt: NOW,
    };
    fixture.session.runWithSession
      .mockImplementationOnce((operation) => operation(configuredSession()))
      .mockImplementationOnce((operation) =>
        operation(configuredSession({ devicePublicKeyFingerprint: "c".repeat(64) })),
      );

    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(1)),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: { reasonCode: "CLOUD_PROJECT_KEY_PUBLICATION_AUTHORITY_CHANGED" },
    });

    expect(fixture.account.load).not.toHaveBeenCalled();
    expect(fixture.nextId).not.toHaveBeenCalled();
    expect(fixture.api.publishProjectKeys).not.toHaveBeenCalled();
  });

  it("rejects a changed principal before account reads, journal creation, or publication", async () => {
    fixture.session.runWithSession.mockImplementation((operation) =>
      operation(configuredSession({ accountId: "019f9f4a-b3c7-7350-9226-00000000000c" })),
    );

    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(1)),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: {
        reasonCode: "CLOUD_PROJECT_KEY_PUBLICATION_AUTHORITY_CHANGED",
        accountId: ACCOUNT_ID,
        deviceId: LOCAL_DEVICE_ID,
      },
    });

    expect(fixture.account.load).not.toHaveBeenCalled();
    expect(fixture.nextId).not.toHaveBeenCalled();
    expect(fixture.store.publication).toBeNull();
    expect(fixture.api.publishProjectKeys).not.toHaveBeenCalled();
    expect(fixture.api.getProjectKeys).not.toHaveBeenCalled();
    expect(fixture.api.getProjectState).not.toHaveBeenCalled();
  });

  it("allows no side effect when the principal changes after publication authority is frozen", async () => {
    fixture.session.runWithSession
      .mockImplementationOnce((operation) => operation(configuredSession()))
      .mockImplementationOnce((operation) =>
        operation(configuredSession({ accountId: "019f9f4a-b3c7-7350-9226-00000000000c" })),
      );

    await expect(fixture.coordinator.publishInitialProjectKey(PROJECT_ID)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: { reasonCode: "CLOUD_PROJECT_KEY_PUBLICATION_AUTHORITY_CHANGED" },
    });

    expect(fixture.account.load).not.toHaveBeenCalled();
    expect(fixture.lifecycle.createDeviceEnvelopesForExistingKey).not.toHaveBeenCalled();
    expect(fixture.nextId).not.toHaveBeenCalled();
    expect(fixture.store.publication).toBeNull();
    expect(fixture.api.publishProjectKeys).not.toHaveBeenCalled();
  });

  it("rejects an auth-refresh retry under another principal without replaying the request", async () => {
    fixture.api.publishProjectKeys.mockRejectedValueOnce(cloudError("AUTH_SESSION_EXPIRED", true));
    fixture.session.runWithSession.mockImplementation(async (operation) => {
      try {
        return await operation(configuredSession());
      } catch (cause: unknown) {
        if (cause instanceof CloudClientError && cause.code === "AUTH_SESSION_EXPIRED") {
          return operation(configuredSession({ deviceId: REMOTE_DEVICE_ID }));
        }
        throw cause;
      }
    });

    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(1)),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: { reasonCode: "CLOUD_PROJECT_KEY_PUBLICATION_AUTHORITY_CHANGED" },
    });

    expect(fixture.api.publishProjectKeys).toHaveBeenCalledTimes(1);
    expect(fixture.store.publication).toMatchObject({
      projectId: PROJECT_ID,
      keyVersion: 1,
      state: "pending",
    });
    expect(fixture.store.checkpoint).toBeNull();
  });

  it("checks frozen authority before conflict reconciliation reads", async () => {
    let current = configuredSession();
    fixture.session.runWithSession.mockImplementation((operation) => operation(current));
    fixture.api.publishProjectKeys.mockImplementation(() => {
      current = configuredSession({ deviceId: REMOTE_DEVICE_ID });
      return Promise.reject(cloudError("REVISION_CONFLICT", true));
    });

    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(1)),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: { reasonCode: "CLOUD_PROJECT_KEY_PUBLICATION_AUTHORITY_CHANGED" },
    });

    expect(fixture.api.publishProjectKeys).toHaveBeenCalledTimes(1);
    expect(fixture.api.getProjectKeys).not.toHaveBeenCalled();
    expect(fixture.api.getProjectState).not.toHaveBeenCalled();
    expect(fixture.store.publication).toMatchObject({ state: "pending" });
  });

  it("checks frozen authority again before rebasing durable publication state", async () => {
    let current = configuredSession();
    fixture.session.runWithSession.mockImplementation((operation) => operation(current));
    fixture.store.checkpoint = {
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 7,
      updatedAt: NOW,
    };
    fixture.store.bundle = activeBundle(2);
    fixture.store.envelopes = [localEnvelope(2), remoteEnvelope(2)];
    fixture.api.publishProjectKeys.mockRejectedValue(cloudError("REVISION_CONFLICT", true));
    fixture.api.getProjectKeys.mockRejectedValue(cloudError("RESOURCE_NOT_FOUND", false));
    fixture.api.getProjectState.mockImplementation(() => {
      current = configuredSession({ accountId: "019f9f4a-b3c7-7350-9226-00000000000c" });
      return Promise.resolve(
        projectStateResponse({
          projectId: PROJECT_ID,
          keyVersion: 1,
          serverRevision: 7,
          publicationRequestSha256: "e".repeat(64),
          publishedAt: NOW,
        }),
      );
    });

    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(2)),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: { reasonCode: "CLOUD_PROJECT_KEY_PUBLICATION_AUTHORITY_CHANGED" },
    });

    expect(fixture.api.publishProjectKeys).toHaveBeenCalledTimes(1);
    expect(fixture.nextId).toHaveBeenCalledTimes(1);
    expect(fixture.store.publication).toMatchObject({
      idempotencyKey: IDEMPOTENCY_KEY,
      state: "pending",
    });
  });

  it("publishes or resumes the exact missing key without creating a second durable request", async () => {
    fixture.api.publishProjectKeys.mockRejectedValueOnce(
      cloudError("CLOUD_NETWORK_UNAVAILABLE", true),
    );
    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(1)),
    ).rejects.toMatchObject({
      code: "CLOUD_NETWORK_UNAVAILABLE",
    });
    const pending = fixture.store.publication;

    fixture.api.publishProjectKeys.mockImplementationOnce(
      (_projectId, _keyVersion, request: CloudProjectKeyPublishRequest) =>
        Promise.resolve(responseFor(request)),
    );
    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(1)),
    ).resolves.toEqual({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      deviceId: LOCAL_DEVICE_ID,
      devicePublicKeyFingerprint: "a".repeat(64),
      keyVersion: 1,
    });
    expect(fixture.api.publishProjectKeys.mock.calls[1]?.[2]).toBe(pending?.request);
    expect(fixture.nextId).toHaveBeenCalledTimes(1);
  });

  it("rejects a cloud key publication that skips the checkpoint sequence", async () => {
    fixture.store.checkpoint = {
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 7,
      updatedAt: NOW,
    };

    await expect(
      fixture.coordinator.ensureProjectKeyPublished(publicationAuthority(3)),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(fixture.api.publishProjectKeys).not.toHaveBeenCalled();
  });

  it("retains an unknown network result and resumes with the same durable request", async () => {
    fixture.api.publishProjectKeys.mockRejectedValueOnce(
      cloudError("CLOUD_NETWORK_UNAVAILABLE", true),
    );

    await expect(fixture.coordinator.publishInitialProjectKey(PROJECT_ID)).rejects.toMatchObject({
      code: "CLOUD_NETWORK_UNAVAILABLE",
    });
    const pending = fixture.store.publication;
    expect(pending).toMatchObject({ state: "pending", idempotencyKey: IDEMPOTENCY_KEY });

    fixture.api.publishProjectKeys.mockImplementation(
      (_projectId, _keyVersion, request: CloudProjectKeyPublishRequest) =>
        Promise.resolve(responseFor(request)),
    );
    await fixture.coordinator.resumePublication(PROJECT_ID, 1);

    const first = fixture.api.publishProjectKeys.mock.calls[0];
    const second = fixture.api.publishProjectKeys.mock.calls[1];
    expect(second?.[2]).toBe(pending?.request);
    expect(first?.[3].idempotencyKey).toBe(second?.[3].idempotencyKey);
    expect(fixture.store.publication).toBeNull();
  });

  it("resolves a revision conflict from the immutable receipt, not mutable key-set fields", async () => {
    fixture.api.publishProjectKeys.mockRejectedValue(cloudError("REVISION_CONFLICT", true));
    fixture.api.getProjectKeys.mockImplementation(() => {
      const publication = fixture.store.publication;
      if (publication === null) {
        throw new Error("publication missing");
      }
      const response = responseFor(publication.request);
      return Promise.resolve({
        ...response,
        keySet: {
          ...response.keySet,
          version: {
            ...response.keySet.version,
            state: "retiring" as const,
            revision: response.keySet.version.revision + 1,
          },
          deviceEnvelopes: response.keySet.deviceEnvelopes.map((envelope, index) =>
            index === 0 ? { ...envelope, ciphertext: "Z".repeat(64), revokedAt: LATER } : envelope,
          ),
        },
      });
    });

    await expect(fixture.coordinator.publishInitialProjectKey(PROJECT_ID)).resolves.toMatchObject({
      serverRevision: 1,
      version: { state: "active", revision: 2 },
      deviceEnvelopes: [{ ciphertext: "C".repeat(64), revokedAt: null }, {}],
    });
    expect(fixture.api.getProjectKeys).toHaveBeenCalledWith(PROJECT_ID, 1, {});
    expect(fixture.store.publication).toBeNull();
  });

  it("parks a competing rotation instead of overwriting local key material", async () => {
    fixture.api.publishProjectKeys.mockRejectedValue(cloudError("REVISION_CONFLICT", true));
    fixture.api.getProjectKeys.mockImplementation(() => {
      const publication = fixture.store.publication;
      if (publication === null) {
        throw new Error("publication missing");
      }
      const exact = responseFor(publication.request);
      return Promise.resolve({
        ...exact,
        keySet: {
          ...exact.keySet,
          publication: {
            ...exact.keySet.publication,
            publicationRequestSha256: "f".repeat(64),
          },
        },
      });
    });

    await expect(fixture.coordinator.publishInitialProjectKey(PROJECT_ID)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(fixture.store.publication).toMatchObject({
      state: "conflicted",
      lastErrorCode: "REVISION_CONFLICT",
    });
    expect(fixture.store.checkpoint).toBeNull();
  });

  it("resolves an exact-key 404 from the matching current publication receipt", async () => {
    fixture.api.publishProjectKeys.mockRejectedValue(cloudError("REVISION_CONFLICT", true));
    fixture.api.getProjectKeys.mockRejectedValue(cloudError("RESOURCE_NOT_FOUND", false));
    fixture.api.getProjectState.mockImplementation(() => {
      const publication = fixture.store.publication;
      if (publication === null) {
        throw new Error("publication missing");
      }
      return Promise.resolve(projectStateResponse(publicationReceipt(publication.request)));
    });

    await expect(fixture.coordinator.publishInitialProjectKey(PROJECT_ID)).resolves.toMatchObject({
      keyVersion: 1,
      serverRevision: 1,
      version: { state: "active" },
    });
    expect(fixture.api.getProjectState).toHaveBeenCalledWith(PROJECT_ID, {});
    expect(fixture.store.publication).toBeNull();
  });

  it("rebases a stale idempotency key only against the immutable predecessor receipt", async () => {
    fixture.store.checkpoint = {
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 7,
      updatedAt: NOW,
    };
    fixture.store.bundle = pendingBundle(2);
    fixture.store.envelopes = [localEnvelope(2), remoteEnvelope(2)];
    fixture.nextId
      .mockReset()
      .mockReturnValueOnce(IDEMPOTENCY_KEY)
      .mockReturnValueOnce(REBASED_IDEMPOTENCY_KEY);
    fixture.api.publishProjectKeys
      .mockRejectedValueOnce(cloudError("REVISION_CONFLICT", true))
      .mockImplementationOnce((_projectId, _keyVersion, request: CloudProjectKeyPublishRequest) =>
        Promise.resolve(responseFor(request)),
      );
    fixture.api.getProjectKeys.mockRejectedValue(cloudError("RESOURCE_NOT_FOUND", false));
    fixture.api.getProjectState.mockResolvedValue(
      projectStateResponse({
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 7,
        publicationRequestSha256: "e".repeat(64),
        publishedAt: NOW,
      }),
    );

    await expect(
      fixture.coordinator.confirmAndPublishRotation(PROJECT_ID, "one-time-code"),
    ).resolves.toMatchObject({ keyVersion: 2, serverRevision: 8 });

    const first = fixture.api.publishProjectKeys.mock.calls[0];
    const second = fixture.api.publishProjectKeys.mock.calls[1];
    expect(second?.[2]).toBe(first?.[2]);
    expect(first?.[3].idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(second?.[3].idempotencyKey).toBe(REBASED_IDEMPOTENCY_KEY);
    expect(fixture.store.publication).toBeNull();
  });

  it("does not resolve an exact-key 404 from a different request receipt", async () => {
    fixture.api.publishProjectKeys.mockRejectedValue(cloudError("REVISION_CONFLICT", true));
    fixture.api.getProjectKeys.mockRejectedValue(cloudError("RESOURCE_NOT_FOUND", false));
    fixture.api.getProjectState.mockResolvedValue(
      projectStateResponse({
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 1,
        publicationRequestSha256: "f".repeat(64),
        publishedAt: LATER,
      }),
    );

    await expect(fixture.coordinator.publishInitialProjectKey(PROJECT_ID)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect(fixture.store.publication).toMatchObject({
      state: "conflicted",
      lastErrorCode: "REVISION_CONFLICT",
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(fixture.store.checkpoint).toBeNull();
  });

  it("keeps an exact-version fetch historical even when the native key is available", async () => {
    const remote = keySetFor(activeBundle(1), [localEnvelope(1), remoteEnvelope(1)], 1);
    fixture.api.getProjectKeys.mockResolvedValue({
      schemaVersion: 1,
      requestId: IDEMPOTENCY_KEY,
      keySet: remote,
    });

    await expect(fixture.coordinator.fetchProjectKeyVersion(PROJECT_ID, 1)).resolves.toMatchObject({
      localKeyAvailable: true,
      cloudDeviceAuthorized: true,
      keySet: { keyVersion: 1 },
    });

    expect(fixture.lifecycle.openCloudProjectKeyForLocalDevice).toHaveBeenCalledWith(
      remote,
      fixture.localDevice,
    );
    expect(fixture.store.checkpoint).toBeNull();
    expect(fixture.store.saveInputs.at(-1)).toMatchObject({ makeCurrent: false });
  });

  it("recovers an exact historical key without replacing the current-key checkpoint", async () => {
    const historical = keySetFor(activeBundle(1), [remoteEnvelope(1)], 1);
    fixture.store.envelopes = [];
    fixture.store.checkpoint = {
      projectId: PROJECT_ID,
      currentKeyVersion: 2,
      serverRevision: 2,
      updatedAt: LATER,
    };
    fixture.api.getProjectKeys.mockResolvedValue({
      schemaVersion: 1,
      requestId: IDEMPOTENCY_KEY,
      keySet: historical,
    });

    await expect(
      fixture.coordinator.recoverProjectKeyVersion(PROJECT_ID, 1, "recovery-code"),
    ).resolves.toMatchObject({
      keySet: { keyVersion: 1 },
      openKey: { keyVersion: 1 },
      localKeyAvailable: true,
    });

    expect(fixture.api.getProjectKeys).toHaveBeenCalledWith(PROJECT_ID, 1, {});
    expect(fixture.api.getCurrentProjectKeys).not.toHaveBeenCalled();
    expect(fixture.store.saveInputs.at(-1)).toMatchObject({
      keySet: historical,
      makeCurrent: false,
      localDeviceEnvelope: { keyVersion: 1, recipientDeviceId: LOCAL_DEVICE_ID },
    });
    expect(fixture.store.checkpoint).toMatchObject({
      currentKeyVersion: 2,
      serverRevision: 2,
    });
  });

  it("prepares native recovery before atomically saving the current key and local envelope", async () => {
    const remoteOnly = keySetFor(activeBundle(1), [remoteEnvelope(1)], 1);
    fixture.store.envelopes = [];
    fixture.api.getCurrentProjectKeys.mockResolvedValue({
      schemaVersion: 1,
      requestId: IDEMPOTENCY_KEY,
      keySet: remoteOnly,
    });

    const recovered = await fixture.coordinator.recoverCurrentProjectKey(
      PROJECT_ID,
      "recovery-code",
    );

    expect(recovered).toMatchObject({
      localKeyAvailable: true,
      cloudDeviceAuthorized: false,
      rotationRequired: true,
      openKey: { projectId: PROJECT_ID, keyVersion: 1 },
    });
    expect(fixture.lifecycle.prepareCloudProjectKeyRecoveryForLocalDevice).toHaveBeenCalledWith(
      remoteOnly,
      fixture.localDevice,
      "recovery-code",
    );
    expect(fixture.store.saveInputs).toHaveLength(1);
    expect(fixture.store.saveInputs[0]).toMatchObject({
      keySet: remoteOnly,
      makeCurrent: true,
      localDeviceEnvelope: { recipientDeviceId: LOCAL_DEVICE_ID },
    });
    expect(fixture.lifecycle.openProjectDataKeyForDevice).not.toHaveBeenCalled();
  });

  it("does not advance the current checkpoint when recovery-code validation fails", async () => {
    const remoteOnly = keySetFor(activeBundle(1), [remoteEnvelope(1)], 1);
    fixture.store.envelopes = [];
    fixture.api.getCurrentProjectKeys.mockResolvedValue({
      schemaVersion: 1,
      requestId: IDEMPOTENCY_KEY,
      keySet: remoteOnly,
    });
    fixture.lifecycle.prepareCloudProjectKeyRecoveryForLocalDevice.mockRejectedValue(
      stateFailure("The recovery code is invalid."),
    );

    await expect(
      fixture.coordinator.recoverCurrentProjectKey(PROJECT_ID, "wrong-code"),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(fixture.store.checkpoint).toBeNull();
    expect(fixture.store.saveInputs).toHaveLength(0);
  });

  it("reopens a previously recovered local envelope without the code but still requires rotation", async () => {
    const remoteOnly = keySetFor(activeBundle(1), [remoteEnvelope(1)], 1);
    fixture.store.envelopes = [localEnvelope(1)];
    fixture.api.getCurrentProjectKeys.mockResolvedValue({
      schemaVersion: 1,
      requestId: IDEMPOTENCY_KEY,
      keySet: remoteOnly,
    });

    const recovered = await fixture.coordinator.recoverCurrentProjectKey(PROJECT_ID, undefined);

    expect(recovered).toMatchObject({
      localKeyAvailable: true,
      cloudDeviceAuthorized: false,
      rotationRequired: true,
    });
    expect(fixture.lifecycle.openProjectDataKeyForDevice).toHaveBeenCalledWith(
      PROJECT_ID,
      LOCAL_DEVICE_ID,
      1,
    );
    expect(fixture.lifecycle.prepareCloudProjectKeyRecoveryForLocalDevice).not.toHaveBeenCalled();
    expect(fixture.store.checkpoint).toMatchObject({
      currentKeyVersion: 1,
      serverRevision: 1,
    });
  });

  it("does not report cloud authorization as local access when the native key is missing", async () => {
    const authorized = keySetFor(activeBundle(1), [localEnvelope(1), remoteEnvelope(1)], 1);
    fixture.api.getCurrentProjectKeys.mockResolvedValue({
      schemaVersion: 1,
      requestId: IDEMPOTENCY_KEY,
      keySet: authorized,
    });
    fixture.lifecycle.openCloudProjectKeyForLocalDevice.mockRejectedValue(
      stateFailure("The operating-system device key is missing."),
    );

    await expect(fixture.coordinator.fetchCurrentProjectKey(PROJECT_ID)).resolves.toMatchObject({
      localKeyAvailable: false,
      cloudDeviceAuthorized: true,
    });
    await expect(
      fixture.coordinator.recoverCurrentProjectKey(PROJECT_ID, "recovery-code"),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(fixture.store.checkpoint).toBeNull();
    expect(fixture.store.saveInputs).toHaveLength(0);
    expect(fixture.lifecycle.prepareCloudProjectKeyRecoveryForLocalDevice).not.toHaveBeenCalled();
  });

  it("confirms and publishes the next version against the exact prior server revision", async () => {
    fixture.store.checkpoint = {
      projectId: PROJECT_ID,
      currentKeyVersion: 1,
      serverRevision: 7,
      updatedAt: NOW,
    };
    const pending = pendingBundle(2);
    fixture.store.bundle = pending;
    fixture.store.envelopes = [localEnvelope(2), remoteEnvelope(2)];
    const confirmed = activeBundle(2);
    fixture.lifecycle.confirmPendingProjectKeyForCloudPublication.mockImplementation(() => {
      return Promise.resolve(confirmed);
    });
    fixture.api.publishProjectKeys.mockImplementation(
      (_projectId, _keyVersion, request: CloudProjectKeyPublishRequest) =>
        Promise.resolve(responseFor(request)),
    );

    const result = await fixture.coordinator.confirmAndPublishRotation(PROJECT_ID, "one-time-code");

    expect(result).toMatchObject({ keyVersion: 2, serverRevision: 8 });
    expect(fixture.lifecycle.confirmPendingProjectKeyForCloudPublication).toHaveBeenCalledWith(
      PROJECT_ID,
      LOCAL_DEVICE_ID,
      "one-time-code",
    );
    expect(fixture.api.publishProjectKeys.mock.calls[0]?.[2]).toMatchObject({
      expectedServerRevision: 7,
      version: { keyVersion: 2, state: "active" },
    });
    expect(fixture.store.checkpoint).toMatchObject({
      currentKeyVersion: 2,
      serverRevision: 8,
    });
    expect(fixture.store.bundle.version).toMatchObject({
      keyVersion: 2,
      state: "active",
      revision: 2,
    });
  });
});

function createFixture() {
  const localDevice = deviceRecord("local");
  const remoteDevice = deviceRecord("remote");
  const store = new MemoryCloudProjectKeyStore(localDevice, remoteDevice);
  const api = {
    publishProjectKeys: vi.fn<InkShadowCloudApiClient["publishProjectKeys"]>(),
    getProjectKeys: vi.fn<InkShadowCloudApiClient["getProjectKeys"]>(),
    getCurrentProjectKeys: vi.fn<InkShadowCloudApiClient["getCurrentProjectKeys"]>(),
    getProjectState: vi.fn<InkShadowCloudApiClient["getProjectState"]>(),
  };
  const session = {
    runWithSession: vi.fn(
      async (operation: (status: ConfiguredCloudSessionStatus) => Promise<unknown>) =>
        operation(configuredSession()),
    ),
  };
  const account = {
    load: vi.fn(() => Promise.resolve(accountSnapshot())),
  };
  const openKey: OpenProjectDataKey = {
    projectId: PROJECT_ID,
    keyVersion: 1,
    projectKeyFingerprint: "f".repeat(64),
    key: {} as CryptoKey,
  };
  const rotationDisplay: PendingProjectRotationDisplay = {
    projectId: PROJECT_ID,
    keyVersion: 2,
    previousKeyVersion: 1,
    deviceId: LOCAL_DEVICE_ID,
    recipientDeviceCount: 2,
    projectKeyFingerprint: "f".repeat(64),
    recoveryCode: "one-time-code",
  };
  const lifecycle = {
    createDeviceEnvelopesForExistingKey: vi.fn(
      (
        _projectId: string,
        _sender: DevicePublicKeyRecord,
        recipients: readonly DevicePublicKeyRecord[],
        keyVersion: number,
      ) =>
        Promise.resolve(
          recipients.map((recipient) =>
            recipient.deviceId === LOCAL_DEVICE_ID
              ? localEnvelope(keyVersion)
              : remoteEnvelope(keyVersion),
          ),
        ),
    ),
    prepareProjectKeyRotation: vi.fn(() => Promise.resolve(rotationDisplay)),
    confirmPendingProjectKeyForCloudPublication: vi.fn(() => Promise.resolve(activeBundle(2))),
    prepareCloudProjectKeyRecoveryForLocalDevice: vi.fn((keySet: CloudProjectKeySet) =>
      Promise.resolve({
        openKey: { ...openKey, keyVersion: keySet.keyVersion },
        deviceEnvelope: localEnvelope(keySet.keyVersion),
      }),
    ),
    openCloudProjectKeyForLocalDevice: vi.fn(() => Promise.resolve(openKey)),
    openProjectDataKeyForDevice: vi.fn(() => Promise.resolve(openKey)),
  };
  const nextId = vi.fn().mockReturnValue(IDEMPOTENCY_KEY);
  const ids = { next: nextId } as unknown as UuidV7Generator;
  const clock = { now: vi.fn().mockReturnValue(LATER) } as unknown as Clock;
  type Arguments = ConstructorParameters<typeof CloudProjectKeyCoordinator>;
  const coordinator = new CloudProjectKeyCoordinator(
    api,
    session as unknown as Arguments[1],
    account,
    lifecycle,
    store,
    ids,
    clock,
  );
  return {
    coordinator,
    api,
    session,
    account,
    lifecycle,
    store,
    ids,
    nextId,
    localDevice,
    remoteDevice,
  };
}

class MemoryCloudProjectKeyStore {
  public bundle: ProjectKeyBundle = activeBundle(1);
  public envelopes: DeviceProjectKeyEnvelopeContract[] = [localEnvelope(1)];
  public checkpoint: CloudProjectKeyCheckpoint | null = null;
  public publication: CloudProjectKeyPublication | null = null;
  public readonly saveInputs: SaveCloudProjectKeySetInput[] = [];

  private readonly devices: ReadonlyMap<string, DevicePublicKeyRecord>;

  public constructor(localDevice: DevicePublicKeyRecord, remoteDevice: DevicePublicKeyRecord) {
    this.devices = new Map([
      [localDevice.deviceId, localDevice],
      [remoteDevice.deviceId, remoteDevice],
    ]);
  }

  public findDevicePublicKey(deviceId: string) {
    return Promise.resolve(ok(this.devices.get(deviceId) ?? null));
  }

  public loadProjectKeyBundle() {
    return Promise.resolve(ok(this.bundle));
  }

  public listDeviceEnvelopes(_projectId: string, keyVersion: number) {
    return Promise.resolve(
      ok(this.envelopes.filter((envelope) => envelope.keyVersion === keyVersion)),
    );
  }

  public saveDeviceEnvelope(envelope: DeviceProjectKeyEnvelopeContract) {
    this.envelopes.push(envelope);
    return Promise.resolve(ok(undefined));
  }

  public loadCloudProjectKeyCheckpoint() {
    return Promise.resolve(ok(this.checkpoint));
  }

  public loadCloudProjectKeyPublication(_projectId: string, keyVersion: number) {
    return Promise.resolve(
      ok(this.publication?.keyVersion === keyVersion ? this.publication : null),
    );
  }

  public beginCloudProjectKeyPublication(input: BeginCloudProjectKeyPublicationInput) {
    this.publication ??= {
      projectId: input.projectId,
      keyVersion: input.keyVersion,
      idempotencyKey: input.idempotencyKey,
      expectedServerRevision: input.request.expectedServerRevision,
      request: input.request,
      state: "pending",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      lastErrorCode: null,
    };
    return Promise.resolve(ok(this.publication));
  }

  public markCloudProjectKeyPublicationConflicted(
    input: MarkCloudProjectKeyPublicationConflictInput,
  ) {
    if (this.publication === null) {
      throw new Error("publication missing");
    }
    this.publication = {
      ...this.publication,
      state: "conflicted",
      updatedAt: input.updatedAt,
      lastErrorCode: input.errorCode,
    };
    return Promise.resolve(ok(this.publication));
  }

  public async resolveCloudProjectKeyPublication(input: ResolveCloudProjectKeyPublicationInput) {
    const publication = this.publication;
    if (
      publication?.projectId !== input.projectId ||
      publication.keyVersion !== input.keyVersion ||
      publication.idempotencyKey !== input.idempotencyKey ||
      publicationDigest(publication.request) !== input.receipt.publicationRequestSha256
    ) {
      throw new Error("publication receipt mismatch");
    }
    const keySet: CloudProjectKeySet = {
      ...keySetFor(
        {
          version: publication.request.version,
          recoveryEnvelope: publication.request.recoveryEnvelope,
          deviceEnvelope:
            publication.request.deviceEnvelopes[0] ?? localEnvelope(publication.keyVersion),
        },
        publication.request.deviceEnvelopes,
        input.receipt.serverRevision,
        input.receipt.publicationRequestSha256,
      ),
      publication: input.receipt,
      updatedAt: input.receipt.publishedAt,
    };
    await this.saveCloudProjectKeySet({
      keySet,
      makeCurrent: true,
      completedPublicationIdempotencyKey: input.idempotencyKey,
    });
    return ok(keySet);
  }

  public rebaseCloudProjectKeyPublication(input: RebaseCloudProjectKeyPublicationInput) {
    const publication = this.publication;
    if (
      publication?.projectId !== input.projectId ||
      publication.keyVersion !== input.keyVersion ||
      publication.idempotencyKey !== input.idempotencyKey
    ) {
      throw new Error("publication missing");
    }
    this.publication = {
      ...publication,
      idempotencyKey: input.nextIdempotencyKey,
      state: "pending",
      updatedAt: input.updatedAt,
      lastErrorCode: null,
    };
    return Promise.resolve(ok(this.publication));
  }

  public saveCloudProjectKeySet(input: SaveCloudProjectKeySetInput) {
    this.saveInputs.push(input);
    if (input.localDeviceEnvelope !== undefined) {
      this.envelopes.push(input.localDeviceEnvelope);
    }
    if (
      this.bundle.version.keyVersion === input.keySet.keyVersion &&
      this.bundle.version.state === "pending_confirmation"
    ) {
      this.bundle = {
        ...this.bundle,
        version: input.keySet.version,
        recoveryEnvelope: input.keySet.recoveryEnvelope,
      };
    }
    if (input.makeCurrent) {
      this.checkpoint = {
        projectId: input.keySet.projectId,
        currentKeyVersion: input.keySet.keyVersion,
        serverRevision: input.keySet.serverRevision,
        updatedAt: input.keySet.updatedAt,
      };
    }
    if (
      input.completedPublicationIdempotencyKey !== undefined &&
      input.completedPublicationIdempotencyKey === this.publication?.idempotencyKey
    ) {
      this.publication = null;
    }
    return Promise.resolve(ok(this.checkpoint));
  }
}

function accountSnapshot(): CloudAccountManagementSnapshot {
  return {
    accountId: ACCOUNT_ID,
    currentDeviceId: LOCAL_DEVICE_ID,
    currentSessionId: SESSION_ID,
    devices: [cloudDevice("local"), cloudDevice("remote")],
    sessions: [],
  };
}

function publicationAuthority(keyVersion: number): CloudProjectKeyPublicationAuthority {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    deviceId: LOCAL_DEVICE_ID,
    devicePublicKeyFingerprint: "a".repeat(64),
    keyVersion,
  };
}

function configuredSession(
  overrides: Readonly<{
    accountId?: string;
    deviceId?: string;
    devicePublicKeyFingerprint?: string;
    sessionId?: string;
  }> = {},
): ConfiguredCloudSessionStatus {
  const accountId = overrides.accountId ?? ACCOUNT_ID;
  const deviceId = overrides.deviceId ?? LOCAL_DEVICE_ID;
  const devicePublicKeyFingerprint = overrides.devicePublicKeyFingerprint ?? "a".repeat(64);
  return {
    configured: true,
    account: { accountId },
    device: {
      device: {
        deviceId,
        accountId,
        publicKeyFingerprint: devicePublicKeyFingerprint,
      },
      publicKey: {
        deviceId,
        accountId,
        publicKeyFingerprint: devicePublicKeyFingerprint,
      },
    },
    session: { sessionId: overrides.sessionId ?? SESSION_ID },
    expiry: {},
  } as unknown as ConfiguredCloudSessionStatus;
}

function cloudDevice(kind: "local" | "remote") {
  const record = deviceRecord(kind);
  return {
    schemaVersion: 1 as const,
    device: {
      schemaVersion: 1 as const,
      deviceId: record.deviceId,
      accountId: ACCOUNT_ID,
      state: "trusted" as const,
      publicKeyFingerprint: record.publicKeyFingerprint,
      createdAt: NOW,
      revokedAt: null,
    },
    publicKey: {
      schemaVersion: 1 as const,
      deviceId: record.deviceId,
      accountId: ACCOUNT_ID,
      algorithm: "DHKEM-P256-HKDF-SHA256" as const,
      publicKey: record.publicKey,
      publicKeyFingerprint: record.publicKeyFingerprint,
      createdAt: NOW,
      revokedAt: null,
    },
    displayName: record.displayName,
    revision: 1,
  };
}

function deviceRecord(kind: "local" | "remote"): DevicePublicKeyRecord {
  const local = kind === "local";
  return {
    schemaVersion: 1,
    deviceId: local ? LOCAL_DEVICE_ID : REMOTE_DEVICE_ID,
    accountId: ACCOUNT_ID,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: (local ? "A" : "H").repeat(87),
    publicKeyFingerprint: (local ? "a" : "b").repeat(64),
    displayName: local ? "Local workstation" : "Remote workstation",
    keyOrigin: local ? "local_os_credential" : "remote_registered",
    state: "trusted",
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function pendingBundle(keyVersion: number): ProjectKeyBundle {
  return {
    version: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      keyVersion,
      algorithm: "AES-256-GCM",
      state: "pending_confirmation",
      revision: 1,
      createdAt: NOW,
      retiredAt: null,
    },
    deviceEnvelope: localEnvelope(keyVersion),
    recoveryEnvelope: {
      ...recoveryEnvelope(keyVersion),
      confirmedAt: null,
    },
  };
}

function activeBundle(keyVersion: number): ProjectKeyBundle {
  return {
    version: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      keyVersion,
      algorithm: "AES-256-GCM",
      state: "active",
      revision: 2,
      createdAt: NOW,
      retiredAt: null,
    },
    deviceEnvelope: localEnvelope(keyVersion),
    recoveryEnvelope: recoveryEnvelope(keyVersion),
  };
}

function recoveryEnvelope(keyVersion: number) {
  return {
    schemaVersion: 1 as const,
    algorithm: "ARGON2ID-AES256GCM" as const,
    recoveryId: RECOVERY_ID,
    projectId: PROJECT_ID,
    keyVersion,
    kdf: {
      algorithm: "ARGON2ID" as const,
      version: 19 as const,
      memoryKib: 65_536 as const,
      timeCost: 3 as const,
      parallelism: 4 as const,
      outputBytes: 64 as const,
    },
    salt: "D".repeat(22),
    nonce: "E".repeat(16),
    ciphertext: "F".repeat(64),
    verifier: "G".repeat(43),
    createdAt: NOW,
    confirmedAt: LATER,
    revokedAt: null,
  };
}

function localEnvelope(keyVersion: number): DeviceProjectKeyEnvelopeContract {
  return envelopeFor(keyVersion, "local");
}

function remoteEnvelope(keyVersion: number): DeviceProjectKeyEnvelopeContract {
  return envelopeFor(keyVersion, "remote");
}

function envelopeFor(
  keyVersion: number,
  recipient: "local" | "remote",
): DeviceProjectKeyEnvelopeContract {
  const recipientRecord = deviceRecord(recipient);
  return {
    schemaVersion: 1,
    algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
    envelopeId: recipient === "local" ? LOCAL_ENVELOPE_ID : REMOTE_ENVELOPE_ID,
    projectId: PROJECT_ID,
    keyVersion,
    senderDeviceId: LOCAL_DEVICE_ID,
    senderPublicKey: "A".repeat(87),
    senderPublicKeyFingerprint: "a".repeat(64),
    recipientDeviceId: recipientRecord.deviceId,
    recipientPublicKey: recipientRecord.publicKey,
    recipientPublicKeyFingerprint: recipientRecord.publicKeyFingerprint,
    encapsulatedKey: "B".repeat(87),
    ciphertext: (recipient === "local" ? "C" : "I").repeat(64),
    createdAt: NOW,
    revokedAt: null,
  };
}

function responseFor(request: CloudProjectKeyPublishRequest) {
  return {
    schemaVersion: 1 as const,
    requestId: IDEMPOTENCY_KEY,
    keySet: keySetFor(
      {
        version: request.version,
        recoveryEnvelope: request.recoveryEnvelope,
        deviceEnvelope: request.deviceEnvelopes[0] ?? localEnvelope(request.version.keyVersion),
      },
      request.deviceEnvelopes,
      (request.expectedServerRevision ?? 0) + 1,
      publicationDigest(request),
    ),
  };
}

function publicationDigest(request: CloudProjectKeyPublishRequest): string {
  return createHash("sha256")
    .update(
      canonicalCloudProjectKeyPublication(
        request.version.projectId,
        request.version.keyVersion,
        request,
      ),
      "utf8",
    )
    .digest("hex");
}

function publicationReceipt(
  request: CloudProjectKeyPublishRequest,
): CloudProjectKeyPublicationReceipt {
  return {
    projectId: request.version.projectId,
    keyVersion: request.version.keyVersion,
    serverRevision: (request.expectedServerRevision ?? 0) + 1,
    publicationRequestSha256: publicationDigest(request),
    publishedAt: LATER,
  };
}

function projectStateResponse(currentKeyPublication: CloudProjectKeyPublicationReceipt) {
  return {
    schemaVersion: 1 as const,
    requestId: IDEMPOTENCY_KEY,
    project: {
      schemaVersion: 1 as const,
      projectId: PROJECT_ID,
      currentKeyVersion: currentKeyPublication.keyVersion,
      serverRevision: currentKeyPublication.serverRevision,
      currentKeyPublication,
      updatedAt: LATER,
      sync: {
        headCursor: "cursor-head",
        minimumAvailableCursor: "cursor-minimum",
        cursorStatus: "incremental_available" as const,
      },
    },
  };
}

function keySetFor(
  bundle: ProjectKeyBundle,
  envelopes: readonly DeviceProjectKeyEnvelopeContract[],
  serverRevision: number,
  publicationRequestSha256 = "0".repeat(64),
): CloudProjectKeySet {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    keyVersion: bundle.version.keyVersion,
    serverRevision,
    publication: {
      projectId: PROJECT_ID,
      keyVersion: bundle.version.keyVersion,
      serverRevision,
      publicationRequestSha256,
      publishedAt: LATER,
    },
    version: bundle.version,
    recoveryEnvelope: bundle.recoveryEnvelope,
    deviceEnvelopes: [...envelopes],
    updatedAt: LATER,
  };
}

function cloudError(
  code: ConstructorParameters<typeof CloudClientError>[0]["code"],
  retryable: boolean,
): CloudClientError {
  return new CloudClientError({
    code,
    message: code,
    status: 409,
    requestId: IDEMPOTENCY_KEY,
    retryable,
  });
}

function stateFailure(message: string): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message,
    actions: ["OPEN_SETTINGS"],
  });
}
