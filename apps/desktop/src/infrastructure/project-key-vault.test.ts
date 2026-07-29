import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

import {
  BrowserDevelopmentProjectKeyVault,
  TauriProjectKeyVault,
  type NativeDeviceProjectKeyEnvelope,
  type NativeRecoveryProjectKeyEnvelope,
} from "./project-key-vault";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const RECOVERY_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const TEAM_RECIPIENT_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const TEAM_ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const TEAM_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const MEMBERSHIP_ID = "019f9f4a-b3c7-7350-9226-000000000008";
const ASSIGNMENT_ID = "019f9f4a-b3c7-7350-9226-000000000009";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000010";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000011";

describe("project key vault adapters", () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset();
  });

  it("routes sensitive operations only through the named native commands", async () => {
    const vault = new TauriProjectKeyVault();
    const deviceEnvelope = nativeDeviceEnvelope();
    const recoveryEnvelope = nativeRecoveryEnvelope();
    tauriMocks.invoke
      .mockResolvedValueOnce({
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256",
        publicKey: "A".repeat(87),
        publicKeyFingerprint: "a".repeat(64),
        privateKeyStorage: "os_credential_store",
      })
      .mockResolvedValueOnce({
        rawProjectDataKey: "K".repeat(43),
        projectKeyFingerprint: "b".repeat(64),
      })
      .mockResolvedValueOnce(deviceEnvelope)
      .mockResolvedValueOnce({
        recoveryCode: "one-time-only",
        envelope: recoveryEnvelope,
      })
      .mockResolvedValueOnce({
        valid: true,
        projectKeyFingerprint: "b".repeat(64),
      });

    await vault.createDeviceIdentity(DEVICE_ID);
    const key = await vault.generateProjectDataKey();
    await vault.wrapProjectDataKeyForDevice({
      envelopeId: ENVELOPE_ID,
      projectId: PROJECT_ID,
      keyVersion: 1,
      senderDeviceId: DEVICE_ID,
      recipientDeviceId: DEVICE_ID,
      recipientPublicKey: "A".repeat(87),
      recipientPublicKeyFingerprint: "a".repeat(64),
      rawProjectDataKey: key.rawProjectDataKey,
    });
    const kit = await vault.createProjectRecoveryKit({
      recoveryId: RECOVERY_ID,
      projectId: PROJECT_ID,
      keyVersion: 1,
      rawProjectDataKey: key.rawProjectDataKey,
    });
    await vault.verifyProjectRecoveryKit(kit.recoveryCode, kit.envelope);

    expect(tauriMocks.invoke.mock.calls.map(([command]) => String(command))).toEqual([
      "create_device_identity",
      "generate_project_data_key",
      "wrap_project_data_key_for_device",
      "create_project_recovery_kit",
      "verify_project_recovery_kit",
    ]);
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("verify_project_recovery_kit", {
      input: { recoveryCode: "one-time-only", envelope: recoveryEnvelope },
    });
  });

  it("does not emulate private-key or recovery operations in browser development", async () => {
    const vault = new BrowserDevelopmentProjectKeyVault();

    expect(vault.available).toBe(false);
    await expect(vault.getDeviceIdentityStatus(DEVICE_ID)).resolves.toEqual({
      configured: false,
      identity: null,
    });
    await expect(vault.generateProjectDataKey()).rejects.toThrow("浏览器开发模式不提供设备私钥");
    expect(tauriMocks.invoke).not.toHaveBeenCalled();
  });

  it("rewraps team recipients without sending a plaintext project key through IPC", async () => {
    const vault = new TauriProjectKeyVault();
    const sourceEnvelope = nativeDeviceEnvelope();
    tauriMocks.invoke.mockResolvedValueOnce([
      {
        schemaVersion: 1,
        envelopeKind: "team_project_member_device",
        envelopeId: TEAM_ENVELOPE_ID,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        keyVersion: 1,
        membershipId: MEMBERSHIP_ID,
        membershipRevision: 2,
        assignmentId: ASSIGNMENT_ID,
        assignmentRevision: 3,
        algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
        senderDeviceId: DEVICE_ID,
        senderPublicKey: "A".repeat(87),
        senderPublicKeyFingerprint: "a".repeat(64),
        recipientDeviceId: TEAM_RECIPIENT_DEVICE_ID,
        recipientPublicKey: "D".repeat(87),
        recipientPublicKeyFingerprint: "d".repeat(64),
        encapsulatedKey: "B".repeat(87),
        ciphertext: "C".repeat(64),
      },
    ]);

    await vault.rewrapProjectDataKeyForTeamRecipients({
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      keyVersion: 1,
      senderDeviceId: DEVICE_ID,
      sourceEnvelope,
      recipients: [
        {
          envelopeId: TEAM_ENVELOPE_ID,
          membershipId: MEMBERSHIP_ID,
          membershipRevision: 2,
          assignmentId: ASSIGNMENT_ID,
          assignmentRevision: 3,
          recipientDeviceId: TEAM_RECIPIENT_DEVICE_ID,
          recipientPublicKey: "D".repeat(87),
          recipientPublicKeyFingerprint: "d".repeat(64),
        },
      ],
    });

    expect(tauriMocks.invoke).toHaveBeenCalledWith("rewrap_project_data_key_for_team_recipients", {
      input: {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        keyVersion: 1,
        senderDeviceId: DEVICE_ID,
        sourceEnvelope,
        recipients: [
          {
            envelopeId: TEAM_ENVELOPE_ID,
            membershipId: MEMBERSHIP_ID,
            membershipRevision: 2,
            assignmentId: ASSIGNMENT_ID,
            assignmentRevision: 3,
            recipientDeviceId: TEAM_RECIPIENT_DEVICE_ID,
            recipientPublicKey: "D".repeat(87),
            recipientPublicKeyFingerprint: "d".repeat(64),
          },
        ],
      },
    });
    expect(JSON.stringify(tauriMocks.invoke.mock.calls)).not.toContain("rawProjectDataKey");
  });

  it("retrieves, verifies, and stores a current-device team envelope inside one native command", async () => {
    const vault = new TauriProjectKeyVault();
    tauriMocks.invoke.mockResolvedValueOnce({
      schemaVersion: 1,
      receiptKind: "team_managed_device_envelope",
      envelopeId: TEAM_ENVELOPE_ID,
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      keyVersion: 5,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      currentServerRevision: 9,
      currentKeyUpdatedAt: "2026-07-28T02:59:00.000Z",
      membershipId: MEMBERSHIP_ID,
      membershipRevision: 2,
      assignmentId: ASSIGNMENT_ID,
      assignmentRevision: 3,
      senderDeviceId: TEAM_RECIPIENT_DEVICE_ID,
      senderPublicKeyFingerprint: "d".repeat(64),
      recipientPublicKeyFingerprint: "a".repeat(64),
      projectKeyFingerprint: "e".repeat(64),
      nativeStorageRef: `team_project_key_receipt_v1_${"f".repeat(64)}`,
      nativeReceiptFingerprint: "c".repeat(64),
      envelopeCreatedAt: "2026-07-28T03:00:00.000Z",
      nativeWriteState: "created",
    });

    const result = await vault.acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud({
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      expectedSessionId: SESSION_ID,
      expectedAccountId: ACCOUNT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedRecipientPublicKey: "A".repeat(87),
      expectedRecipientPublicKeyFingerprint: "a".repeat(64),
    });

    expect(result.projectKeyFingerprint).toBe("e".repeat(64));
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "accept_current_device_team_project_key_envelope_from_cloud",
      {
        input: {
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          expectedSessionId: SESSION_ID,
          expectedAccountId: ACCOUNT_ID,
          expectedDeviceId: DEVICE_ID,
          expectedRecipientPublicKey: "A".repeat(87),
          expectedRecipientPublicKeyFingerprint: "a".repeat(64),
        },
      },
    );
    const exchange = JSON.stringify(tauriMocks.invoke.mock.calls);
    expect(exchange).not.toContain("keyVersion");
    expect(exchange).not.toContain("ciphertext");
    expect(exchange).not.toContain("rawProjectDataKey");
    expect(exchange).not.toContain("privateKey");
  });
});

function nativeDeviceEnvelope(): NativeDeviceProjectKeyEnvelope {
  return {
    schemaVersion: 1,
    algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
    envelopeId: ENVELOPE_ID,
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
  };
}

function nativeRecoveryEnvelope(): NativeRecoveryProjectKeyEnvelope {
  return {
    schemaVersion: 1,
    algorithm: "ARGON2ID-AES256GCM",
    recoveryId: RECOVERY_ID,
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
    salt: "D".repeat(22),
    nonce: "E".repeat(16),
    ciphertext: "F".repeat(64),
    verifier: "G".repeat(43),
  };
}
