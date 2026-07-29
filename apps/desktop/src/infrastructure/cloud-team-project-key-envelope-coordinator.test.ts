import { CloudClientError } from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  type CloudTeamProjectKeyEligibleRecipient,
  type CloudTeamProjectKeyEnvelopePublishRequest,
} from "@inkshadow/contracts";
import type { UuidV7, UuidV7Generator } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type { ConfiguredCloudSessionStatus } from "./cloud-session-coordinator";
import {
  CloudTeamProjectKeyEnvelopeCoordinator,
  type CloudTeamProjectKeyEnvelopeApi,
  type CloudTeamProjectKeyEnvelopeLifecyclePort,
  type CloudTeamProjectKeyEnvelopeSessionPort,
} from "./cloud-team-project-key-envelope-coordinator";
import type {
  ProjectKeyEnvelopeDeviceIdentity,
  TeamProjectKeyEnvelopeRecipientTarget,
} from "./project-key-lifecycle";

const TEAM_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000103";
const SENDER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000104";
const RECIPIENT_A_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000105";
const RECIPIENT_B_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000106";
const MEMBERSHIP_A_ID = "019f9f4a-b3c7-7350-9226-000000000107";
const MEMBERSHIP_B_ID = "019f9f4a-b3c7-7350-9226-000000000108";
const ASSIGNMENT_A_ID = "019f9f4a-b3c7-7350-9226-000000000109";
const ASSIGNMENT_B_ID = "019f9f4a-b3c7-7350-9226-000000000110";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000111";
const ENVELOPE_A_ID = "019f9f4a-b3c7-7350-9226-000000000112";
const IDEMPOTENCY_A_ID = "019f9f4a-b3c7-7350-9226-000000000113";
const ENVELOPE_B_ID = "019f9f4a-b3c7-7350-9226-000000000114";
const IDEMPOTENCY_B_ID = "019f9f4a-b3c7-7350-9226-000000000115";
const OTHER_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000116";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000117";
const NOW = "2026-07-28T02:00:00.000Z";
const SENDER_PUBLIC_KEY = "A".repeat(87);
const SENDER_FINGERPRINT = "a".repeat(64);

describe("CloudTeamProjectKeyEnvelopeCoordinator", () => {
  it("publishes a sorted exact recipient snapshot through native ciphertext only", async () => {
    const harness = createHarness([recipientB(), recipientA()]);

    const state = await harness.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3);

    expect(state).toMatchObject({
      phase: "published",
      recipientCount: 2,
      publishedCount: 2,
      senderDeviceId: SENDER_DEVICE_ID,
    });
    expect(state.recipients.map(({ recipientDeviceId }) => recipientDeviceId)).toEqual([
      RECIPIENT_A_DEVICE_ID,
      RECIPIENT_B_DEVICE_ID,
    ]);
    expect(harness.lifecycle.createTeamProjectKeyEnvelopesForActiveKey).toHaveBeenCalledWith(
      TEAM_ID,
      PROJECT_ID,
      3,
      {
        accountId: ACCOUNT_ID,
        deviceId: SENDER_DEVICE_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256",
        publicKey: SENDER_PUBLIC_KEY,
        publicKeyFingerprint: SENDER_FINGERPRINT,
      },
      [
        expect.objectContaining({
          envelopeId: ENVELOPE_A_ID,
          deviceId: RECIPIENT_A_DEVICE_ID,
        }),
        expect.objectContaining({
          envelopeId: ENVELOPE_B_ID,
          deviceId: RECIPIENT_B_DEVICE_ID,
        }),
      ],
    );
    expect(harness.api.publishTeamProjectKeyEnvelope).toHaveBeenNthCalledWith(
      1,
      TEAM_ID,
      PROJECT_ID,
      3,
      expect.objectContaining({
        envelopeKind: "team_project_member_device",
        envelopeId: ENVELOPE_A_ID,
        membershipId: MEMBERSHIP_A_ID,
        membershipRevision: 7,
        assignmentId: ASSIGNMENT_A_ID,
        assignmentRevision: 11,
        senderDeviceId: SENDER_DEVICE_ID,
        recipientDeviceId: RECIPIENT_A_DEVICE_ID,
      }),
      { idempotencyKey: IDEMPOTENCY_A_ID },
    );
    expect(harness.api.publishTeamProjectKeyEnvelope).toHaveBeenNthCalledWith(
      2,
      TEAM_ID,
      PROJECT_ID,
      3,
      expect.objectContaining({
        envelopeId: ENVELOPE_B_ID,
        recipientDeviceId: RECIPIENT_B_DEVICE_ID,
      }),
      { idempotencyKey: IDEMPOTENCY_B_ID },
    );
    const nativeCalls = JSON.stringify(
      harness.lifecycle.createTeamProjectKeyEnvelopesForActiveKey.mock.calls,
    );
    expect(nativeCalls).not.toContain("rawProjectDataKey");
    expect(nativeCalls).not.toContain("privateKey");
    expect(nativeCalls).not.toContain("recoveryCode");
  });

  it("shares stable per-recipient work across single and batch publication", async () => {
    const harness = createHarness([recipientA(), recipientB()]);

    await harness.coordinator.publishEligibleRecipient(
      TEAM_ID,
      PROJECT_ID,
      3,
      RECIPIENT_A_DEVICE_ID,
    );
    await harness.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3);
    await harness.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3);

    expect(harness.lifecycle.createTeamProjectKeyEnvelopesForActiveKey).toHaveBeenCalledTimes(2);
    expect(harness.lifecycle.createTeamProjectKeyEnvelopesForActiveKey.mock.calls[1]?.[4]).toEqual([
      expect.objectContaining({
        envelopeId: ENVELOPE_B_ID,
        deviceId: RECIPIENT_B_DEVICE_ID,
      }),
    ]);
    expect(harness.api.publishTeamProjectKeyEnvelope).toHaveBeenCalledTimes(2);
    expect(
      harness.api.publishTeamProjectKeyEnvelope.mock.calls.map(
        ([, , , request, options]) => `${request.envelopeId}:${options.idempotencyKey}`,
      ),
    ).toEqual([`${ENVELOPE_A_ID}:${IDEMPOTENCY_A_ID}`, `${ENVELOPE_B_ID}:${IDEMPOTENCY_B_ID}`]);
    expect(harness.ids.calls).toBe(4);
  });

  it("resumes a partial batch with the identical ciphertext and idempotency key", async () => {
    const harness = createHarness([recipientA(), recipientB()]);
    const transient = new CloudClientError({
      code: "CLOUD_NETWORK_UNAVAILABLE",
      message: "Network unavailable.",
      status: null,
      requestId: REQUEST_ID,
      retryable: true,
    });
    harness.api.publishTeamProjectKeyEnvelope
      .mockImplementationOnce(resolvePublishResponse)
      .mockRejectedValueOnce(transient)
      .mockImplementationOnce(resolvePublishResponse);

    await expect(
      harness.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3),
    ).rejects.toBe(transient);
    expect(harness.coordinator.getPublicationState(TEAM_ID, PROJECT_ID, 3)).toMatchObject({
      phase: "partial",
      publishedCount: 1,
      recipients: [
        { recipientDeviceId: RECIPIENT_A_DEVICE_ID, status: "published" },
        { recipientDeviceId: RECIPIENT_B_DEVICE_ID, status: "sealed" },
      ],
    });

    await expect(
      harness.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3),
    ).resolves.toMatchObject({ phase: "published", publishedCount: 2 });

    expect(harness.lifecycle.createTeamProjectKeyEnvelopesForActiveKey).toHaveBeenCalledTimes(1);
    const recipientBCalls = harness.api.publishTeamProjectKeyEnvelope.mock.calls.filter(
      ([, , , request]) => request.recipientDeviceId === RECIPIENT_B_DEVICE_ID,
    );
    expect(recipientBCalls).toHaveLength(2);
    expect(recipientBCalls[0]?.[3]).toEqual(recipientBCalls[1]?.[3]);
    expect(recipientBCalls[0]?.[4]).toEqual(recipientBCalls[1]?.[4]);
  });

  it("parks deterministic conflicts instead of replacing committed recipient ciphertext", async () => {
    const harness = createHarness([recipientA()]);
    const conflict = new CloudClientError({
      code: "REVISION_CONFLICT",
      message: "Recipient snapshot changed.",
      status: 409,
      requestId: REQUEST_ID,
      retryable: false,
    });
    harness.api.publishTeamProjectKeyEnvelope.mockRejectedValue(conflict);

    await expect(
      harness.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3),
    ).rejects.toBe(conflict);
    expect(harness.coordinator.getPublicationState(TEAM_ID, PROJECT_ID, 3)).toMatchObject({
      phase: "conflicted",
      recipients: [{ status: "conflicted", envelopeId: ENVELOPE_A_ID }],
    });
    await expect(
      harness.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(harness.api.publishTeamProjectKeyEnvelope).toHaveBeenCalledTimes(1);
    expect(harness.lifecycle.createTeamProjectKeyEnvelopesForActiveKey).toHaveBeenCalledTimes(1);
    expect(harness.ids.calls).toBe(2);
  });

  it("fails closed on route-scope drift, authority drift, or native recipient drift", async () => {
    const wrongVersion = createHarness([recipientA()]);
    wrongVersion.api.listEligibleTeamProjectKeyRecipients.mockResolvedValueOnce({
      ...recipientList([recipientA()]),
      keyVersion: 4,
      recipients: [{ ...recipientA(), keyVersion: 4 }],
    });
    await expect(
      wrongVersion.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(wrongVersion.lifecycle.createTeamProjectKeyEnvelopesForActiveKey).not.toHaveBeenCalled();

    const changedSession = new RecordingSession([
      sessionStatus(),
      sessionStatus({ accountId: OTHER_ACCOUNT_ID }),
    ]);
    const authorityDrift = createHarness([recipientA()], changedSession);
    await expect(
      authorityDrift.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(
      authorityDrift.lifecycle.createTeamProjectKeyEnvelopesForActiveKey,
    ).not.toHaveBeenCalled();

    const nativeDrift = createHarness([recipientA()]);
    nativeDrift.lifecycle.createTeamProjectKeyEnvelopesForActiveKey.mockResolvedValueOnce([
      {
        ...nativeEnvelope(ENVELOPE_A_ID, recipientA()),
        recipientDeviceId: RECIPIENT_B_DEVICE_ID,
      },
    ]);
    await expect(
      nativeDrift.coordinator.publishAllEligibleRecipients(TEAM_ID, PROJECT_ID, 3),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(nativeDrift.api.publishTeamProjectKeyEnvelope).not.toHaveBeenCalled();
  });

  it("retrieves and opens the authenticated current-device envelope only inside native code", async () => {
    const harness = createHarness([recipientA()]);

    await expect(
      harness.coordinator.verifyCurrentDeviceEnvelope(TEAM_ID, PROJECT_ID),
    ).resolves.toMatchObject({
      verificationState: "verified_native_hpke",
      persistenceState: "persisted_open_ready",
      receipt: {
        envelopeId: ENVELOPE_A_ID,
        deviceId: SENDER_DEVICE_ID,
      },
    });
    expect(harness.lifecycle.verifyTeamProjectKeyEnvelopeForCurrentDevice).toHaveBeenCalledWith(
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        expectedSessionId: SESSION_ID,
        expectedAccountId: ACCOUNT_ID,
      },
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        deviceId: SENDER_DEVICE_ID,
        publicKeyFingerprint: SENDER_FINGERPRINT,
      }),
    );
    const nativeExchange = JSON.stringify(
      harness.lifecycle.verifyTeamProjectKeyEnvelopeForCurrentDevice.mock.calls,
    );
    expect(nativeExchange).not.toContain("ciphertext");
    expect(nativeExchange).not.toContain("encapsulatedKey");
    expect(nativeExchange).not.toContain("rawProjectDataKey");
    expect(nativeExchange).not.toContain("keyVersion");

    harness.lifecycle.verifyTeamProjectKeyEnvelopeForCurrentDevice.mockResolvedValueOnce({
      ...verifiedCurrentDeviceEnvelope(),
      receipt: {
        ...verifiedCurrentDeviceEnvelope().receipt,
        deviceId: RECIPIENT_B_DEVICE_ID,
      },
    });
    await expect(
      harness.coordinator.verifyCurrentDeviceEnvelope(TEAM_ID, PROJECT_ID),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

function createHarness(
  recipients: readonly CloudTeamProjectKeyEligibleRecipient[],
  session: RecordingSession = new RecordingSession([sessionStatus()]),
) {
  const lifecycle = {
    createTeamProjectKeyEnvelopesForActiveKey: vi.fn(
      (
        _teamId: string,
        _projectId: string,
        _keyVersion: number,
        _sender: ProjectKeyEnvelopeDeviceIdentity,
        targets: readonly TeamProjectKeyEnvelopeRecipientTarget[],
      ) =>
        Promise.resolve(
          targets.map((target) =>
            nativeEnvelope(
              target.envelopeId,
              recipients.find(({ deviceId }) => deviceId === target.deviceId) ?? recipientA(),
            ),
          ),
        ),
    ),
    verifyTeamProjectKeyEnvelopeForCurrentDevice: vi
      .fn<
        CloudTeamProjectKeyEnvelopeLifecyclePort["verifyTeamProjectKeyEnvelopeForCurrentDevice"]
      >()
      .mockResolvedValue(verifiedCurrentDeviceEnvelope()),
  } satisfies CloudTeamProjectKeyEnvelopeLifecyclePort;
  const api = {
    listEligibleTeamProjectKeyRecipients: vi.fn(() => Promise.resolve(recipientList(recipients))),
    publishTeamProjectKeyEnvelope: vi.fn(resolvePublishResponse),
  } satisfies CloudTeamProjectKeyEnvelopeApi;
  const ids = new SequenceIds([ENVELOPE_A_ID, IDEMPOTENCY_A_ID, ENVELOPE_B_ID, IDEMPOTENCY_B_ID]);
  return {
    api,
    coordinator: new CloudTeamProjectKeyEnvelopeCoordinator(api, session, lifecycle, ids),
    ids,
    lifecycle,
    session,
  };
}

class RecordingSession implements CloudTeamProjectKeyEnvelopeSessionPort {
  private index = 0;

  public constructor(private readonly statuses: readonly ConfiguredCloudSessionStatus[]) {}

  public runWithSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
  ): Promise<Value> {
    const status = this.statuses[Math.min(this.index, this.statuses.length - 1)];
    this.index += 1;
    if (status === undefined) {
      throw new Error("Missing session status");
    }
    return operation(status);
  }
}

class SequenceIds implements UuidV7Generator {
  public calls = 0;

  public constructor(private readonly values: readonly string[]) {}

  public next(): UuidV7 {
    const value = this.values[this.calls];
    if (value === undefined) {
      throw new Error("UUID sequence exhausted");
    }
    this.calls += 1;
    return value as UuidV7;
  }
}

function sessionStatus(
  overrides: Readonly<{ accountId?: string }> = {},
): ConfiguredCloudSessionStatus {
  const accountId = overrides.accountId ?? ACCOUNT_ID;
  return {
    configured: true,
    account: {
      accountId,
    },
    device: {
      device: {
        accountId,
        deviceId: SENDER_DEVICE_ID,
        state: "trusted",
        revokedAt: null,
        publicKeyFingerprint: SENDER_FINGERPRINT,
      },
      publicKey: {
        accountId,
        deviceId: SENDER_DEVICE_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256",
        publicKey: SENDER_PUBLIC_KEY,
        publicKeyFingerprint: SENDER_FINGERPRINT,
        revokedAt: null,
      },
    },
    session: {
      sessionId: SESSION_ID,
      accountId,
      deviceId: SENDER_DEVICE_ID,
    },
  } as ConfiguredCloudSessionStatus;
}

function recipientA(): CloudTeamProjectKeyEligibleRecipient {
  return recipient({
    assignmentId: ASSIGNMENT_A_ID,
    assignmentRevision: 11,
    deviceId: RECIPIENT_A_DEVICE_ID,
    membershipId: MEMBERSHIP_A_ID,
    membershipRevision: 7,
    publicKeyCharacter: "B",
    fingerprintCharacter: "b",
  });
}

function recipientB(): CloudTeamProjectKeyEligibleRecipient {
  return recipient({
    assignmentId: ASSIGNMENT_B_ID,
    assignmentRevision: 13,
    deviceId: RECIPIENT_B_DEVICE_ID,
    membershipId: MEMBERSHIP_B_ID,
    membershipRevision: 9,
    publicKeyCharacter: "C",
    fingerprintCharacter: "c",
  });
}

function recipient(input: {
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly deviceId: string;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly publicKeyCharacter: string;
  readonly fingerprintCharacter: string;
}): CloudTeamProjectKeyEligibleRecipient {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    recipientKind: "active_assigned_team_member_device",
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    membershipId: input.membershipId,
    membershipRevision: input.membershipRevision,
    assignmentId: input.assignmentId,
    assignmentRevision: input.assignmentRevision,
    deviceId: input.deviceId,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: input.publicKeyCharacter.repeat(87),
    publicKeyFingerprint: input.fingerprintCharacter.repeat(64),
  };
}

function recipientList(recipients: readonly CloudTeamProjectKeyEligibleRecipient[]) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    recipients: [...recipients],
  };
}

function nativeEnvelope(envelopeId: string, recipient: CloudTeamProjectKeyEligibleRecipient) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    envelopeKind: "team_project_member_device" as const,
    algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM" as const,
    envelopeId,
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    membershipId: recipient.membershipId,
    membershipRevision: recipient.membershipRevision,
    assignmentId: recipient.assignmentId,
    assignmentRevision: recipient.assignmentRevision,
    senderDeviceId: SENDER_DEVICE_ID,
    senderPublicKey: SENDER_PUBLIC_KEY,
    senderPublicKeyFingerprint: SENDER_FINGERPRINT,
    recipientDeviceId: recipient.deviceId,
    recipientPublicKey: recipient.publicKey,
    recipientPublicKeyFingerprint: recipient.publicKeyFingerprint,
    encapsulatedKey: "D".repeat(87),
    ciphertext: "E".repeat(64),
  };
}

function verifiedCurrentDeviceEnvelope() {
  return {
    capabilityState: "persisted_team_managed_receipt" as const,
    keyVersionDiscovery: "authoritative_team_current_metadata" as const,
    verificationState: "verified_native_hpke" as const,
    persistenceState: "persisted_open_ready" as const,
    recoveryModel: "redownload_current_device_envelope" as const,
    nativeWriteState: "created" as const,
    receipt: {
      schemaVersion: 1 as const,
      receiptKind: "team_managed_device_envelope" as const,
      envelopeId: ENVELOPE_A_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      keyVersion: 3,
      accountId: ACCOUNT_ID,
      deviceId: SENDER_DEVICE_ID,
      currentServerRevision: 19,
      currentKeyUpdatedAt: NOW,
      membershipId: MEMBERSHIP_A_ID,
      membershipRevision: 7,
      assignmentId: ASSIGNMENT_A_ID,
      assignmentRevision: 11,
      senderDeviceId: RECIPIENT_A_DEVICE_ID,
      senderPublicKeyFingerprint: "b".repeat(64),
      recipientPublicKeyFingerprint: SENDER_FINGERPRINT,
      projectKeyFingerprint: "f".repeat(64),
      nativeStorageRef: `team_project_key_receipt_v1_${"c".repeat(64)}`,
      nativeReceiptFingerprint: "d".repeat(64),
      envelopeCreatedAt: NOW,
      state: "active" as const,
      receivedAt: NOW,
      lastVerifiedAt: NOW,
      stateUpdatedAt: NOW,
    },
  };
}

function resolvePublishResponse(
  _teamId: string,
  _projectId: string,
  _keyVersion: number,
  request: CloudTeamProjectKeyEnvelopePublishRequest,
  _options: { readonly idempotencyKey: string; readonly signal?: AbortSignal },
) {
  void _options;
  return Promise.resolve({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    envelope: {
      ...request,
      createdAt: NOW,
    },
  });
}
