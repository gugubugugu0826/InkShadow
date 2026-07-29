import {
  AppError,
  err,
  ok,
  type Clock,
  type Result,
  type UuidV7Generator,
} from "@inkshadow/domain";
import type {
  AbandonPendingProjectKeySetupInput,
  ConfirmRecoveryInput,
  DevicePublicKeyRecord,
  PendingProjectKeyRotation,
  PendingProjectKeySetup,
  ProjectKeyBundle,
  SaveTeamProjectKeyReceiptInput,
  TeamProjectKeyReceiptMetadata,
  TeamProjectKeyReceiptScope,
  MarkTeamProjectKeyReceiptStateInput,
} from "@inkshadow/data/project-key-sqlite-store";
import type { DeviceProjectKeyEnvelopeContract } from "@inkshadow/contracts";
import type { CloudProjectKeySet } from "@inkshadow/contracts";
import { AesGcmChunkCipher } from "@inkshadow/sync-core";
import { describe, expect, it, vi } from "vitest";

import { ProjectKeyLifecycleService, type ProjectKeyPersistence } from "./project-key-lifecycle";
import {
  BrowserDevelopmentProjectKeyVault,
  type AcceptCurrentDeviceTeamProjectKeyEnvelopeInput,
  type CreateRecoveryKitInput,
  type DeviceIdentityStatus,
  type DeviceIdentitySummary,
  type NativeDeviceProjectKeyEnvelope,
  type NativeRecoveryProjectKeyEnvelope,
  type NativeTeamProjectKeyEnvelope,
  type NativeTeamProjectKeyReceiptCommit,
  type NativeTeamProjectKeyReceiptRemoval,
  type NativeTeamProjectKeyReceiptStatus,
  type ProjectDataKeyMaterial,
  type ProjectKeyVault,
  type RewrapProjectDataKeyForTeamRecipientsInput,
  type RecoveryKit,
  type RecoveryVerification,
  type TeamProjectKeyReceiptAccessInput,
  type WrapProjectDataKeyInput,
} from "./project-key-vault";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const RECOVERY_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const OTHER_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const REMOTE_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const NEXT_RECOVERY_ID = "019f9f4a-b3c7-7350-9226-000000000008";
const NEXT_ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000009";
const REMOTE_ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000010";
const TEAM_ID = "019f9f4a-b3c7-7350-9226-000000000011";
const MEMBERSHIP_ID = "019f9f4a-b3c7-7350-9226-000000000012";
const ASSIGNMENT_ID = "019f9f4a-b3c7-7350-9226-000000000013";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000014";
const NOW = "2026-07-27T03:00:00.000Z";
const CONFIRMED_AT = "2026-07-27T03:01:00.000Z";
const RECOVERY_CODE = "inkshadow-one-time-recovery-code";

describe("ProjectKeyLifecycleService", () => {
  it("creates an OS-backed device identity and persists public metadata only", async () => {
    const harness = await createHarness();

    const device = await harness.service.ensureLocalDeviceIdentity();

    expect(device).toMatchObject({
      deviceId: harness.vault.identity.deviceId,
      publicKey: harness.vault.identity.publicKey,
      publicKeyFingerprint: harness.vault.identity.publicKeyFingerprint,
      keyOrigin: "local_os_credential",
      state: "trusted",
    });
    expect(harness.store.device).toEqual(device);
    expect(harness.vault.createDeviceIdentity).toHaveBeenCalledWith(DEVICE_ID);
    expect(JSON.stringify(harness.store.device)).not.toContain("private");
  });

  it("persists an atomic pending setup and activates it only after recovery verification", async () => {
    const harness = await createHarness();
    const device = await harness.service.ensureLocalDeviceIdentity();

    const display = await harness.service.prepareInitialProjectKey(PROJECT_ID, device);

    expect(display).toEqual({
      projectId: PROJECT_ID,
      keyVersion: 1,
      deviceId: DEVICE_ID,
      projectKeyFingerprint: harness.vault.material.projectKeyFingerprint,
      recoveryCode: RECOVERY_CODE,
    });
    expect(harness.store.bundle?.version.state).toBe("pending_confirmation");
    expect(JSON.stringify(harness.store.bundle)).not.toContain(
      harness.vault.material.rawProjectDataKey,
    );
    expect(JSON.stringify(harness.store.bundle)).not.toContain(RECOVERY_CODE);

    harness.clock.timestamp = CONFIRMED_AT;
    const confirmed = await harness.service.confirmPendingProjectKey(
      PROJECT_ID,
      DEVICE_ID,
      RECOVERY_CODE,
    );

    expect(harness.vault.verifyProjectRecoveryKit).toHaveBeenCalledWith(
      RECOVERY_CODE,
      expect.objectContaining({ recoveryId: RECOVERY_ID }),
    );
    expect(confirmed.version).toMatchObject({ state: "active", revision: 2 });
    expect(confirmed.recoveryEnvelope.confirmedAt).toBe(CONFIRMED_AT);
  });

  it("imports an active project key as non-extractable and zeroes decoded bytes", async () => {
    const cipher = new CapturingCipher();
    const harness = await createHarness(cipher);
    const device = await harness.service.ensureLocalDeviceIdentity();
    await harness.service.prepareInitialProjectKey(PROJECT_ID, device);
    harness.clock.timestamp = CONFIRMED_AT;
    await harness.service.confirmPendingProjectKey(PROJECT_ID, DEVICE_ID, RECOVERY_CODE);

    const opened = await harness.service.openProjectDataKeyForDevice(PROJECT_ID, DEVICE_ID);

    expect(opened.projectKeyFingerprint).toBe(harness.vault.material.projectKeyFingerprint);
    expect(opened.key.extractable).toBe(false);
    expect(opened.key.usages).toEqual(["encrypt", "decrypt"]);
    const captured = cipher.captured;
    if (captured === undefined) {
      throw new Error("Expected the cipher to capture decoded key bytes");
    }
    expect([...captured]).toEqual(new Array<number>(32).fill(0));
  });

  it("wraps an existing confirmed key for every trusted account device", async () => {
    const harness = await createHarness();
    const sender = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.prepareInitialProjectKey(PROJECT_ID, sender);
    harness.clock.timestamp = CONFIRMED_AT;
    await harness.service.confirmPendingProjectKey(PROJECT_ID, DEVICE_ID, RECOVERY_CODE);

    const envelopes = await harness.service.createDeviceEnvelopesForExistingKey(
      PROJECT_ID,
      sender,
      [remoteDevice(), sender],
    );

    expect(envelopes).toHaveLength(2);
    expect(envelopes.map(({ recipientDeviceId }) => recipientDeviceId)).toEqual([
      DEVICE_ID,
      REMOTE_DEVICE_ID,
    ]);
    expect(envelopes[0]?.envelopeId).toBe(ENVELOPE_ID);
    expect(envelopes[1]).toMatchObject({
      envelopeId: NEXT_RECOVERY_ID,
      recipientDeviceId: REMOTE_DEVICE_ID,
      senderDeviceId: DEVICE_ID,
    });
    expect(harness.vault.unwrapProjectDataKeyForDevice).toHaveBeenCalledTimes(1);
  });

  it("rewraps an exact team-recipient snapshot without exposing the project key to WebView code", async () => {
    const harness = await createHarness();
    const sender = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.prepareInitialProjectKey(PROJECT_ID, sender);
    harness.clock.timestamp = CONFIRMED_AT;
    await harness.service.confirmPendingProjectKey(PROJECT_ID, DEVICE_ID, RECOVERY_CODE);
    const recipient = remoteDevice();

    const envelopes = await harness.service.createTeamProjectKeyEnvelopesForActiveKey(
      TEAM_ID,
      PROJECT_ID,
      1,
      sender,
      [
        {
          envelopeId: REMOTE_ENVELOPE_ID,
          membershipId: MEMBERSHIP_ID,
          membershipRevision: 2,
          assignmentId: ASSIGNMENT_ID,
          assignmentRevision: 3,
          deviceId: recipient.deviceId,
          algorithm: recipient.algorithm,
          publicKey: recipient.publicKey,
          publicKeyFingerprint: recipient.publicKeyFingerprint,
        },
      ],
    );

    expect(envelopes).toEqual([
      expect.objectContaining({
        envelopeId: REMOTE_ENVELOPE_ID,
        projectId: PROJECT_ID,
        keyVersion: 1,
        senderDeviceId: DEVICE_ID,
        recipientDeviceId: REMOTE_DEVICE_ID,
      }),
    ]);
    const rewrapInput = harness.vault.rewrapProjectDataKeyForTeamRecipients.mock.calls[0]?.[0];
    expect(rewrapInput).toMatchObject({
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      keyVersion: 1,
      senderDeviceId: DEVICE_ID,
    });
    expect(rewrapInput === undefined || "rawProjectDataKey" in rewrapInput.sourceEnvelope).toBe(
      false,
    );
    expect(harness.vault.unwrapProjectDataKeyForDevice).not.toHaveBeenCalled();
    expect(
      JSON.stringify(harness.vault.rewrapProjectDataKeyForTeamRecipients.mock.calls),
    ).not.toContain(harness.vault.material.rawProjectDataKey);
  });

  it("fails closed before native rewrap when the local key version or sender authority drifts", async () => {
    const harness = await createHarness();
    const sender = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.prepareInitialProjectKey(PROJECT_ID, sender);
    harness.clock.timestamp = CONFIRMED_AT;
    await harness.service.confirmPendingProjectKey(PROJECT_ID, DEVICE_ID, RECOVERY_CODE);
    const recipient = remoteDevice();
    const target = {
      envelopeId: REMOTE_ENVELOPE_ID,
      membershipId: MEMBERSHIP_ID,
      membershipRevision: 2,
      assignmentId: ASSIGNMENT_ID,
      assignmentRevision: 3,
      deviceId: recipient.deviceId,
      algorithm: recipient.algorithm,
      publicKey: recipient.publicKey,
      publicKeyFingerprint: recipient.publicKeyFingerprint,
    };

    await expect(
      harness.service.createTeamProjectKeyEnvelopesForActiveKey(TEAM_ID, PROJECT_ID, 2, sender, [
        target,
      ]),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(
      harness.service.createTeamProjectKeyEnvelopesForActiveKey(
        TEAM_ID,
        PROJECT_ID,
        1,
        { ...sender, publicKeyFingerprint: "f".repeat(64) },
        [target],
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(harness.vault.rewrapProjectDataKeyForTeamRecipients).not.toHaveBeenCalled();
  });

  it("persists a verified team envelope as a native receipt plus non-secret SQLite metadata", async () => {
    const harness = await createHarness();
    const currentDevice = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    const bundleBefore = harness.store.bundle;

    const verified = await harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        expectedSessionId: SESSION_ID,
        expectedAccountId: ACCOUNT_ID,
      },
      currentDevice,
    );

    expect(verified).toMatchObject({
      capabilityState: "persisted_team_managed_receipt",
      keyVersionDiscovery: "authoritative_team_current_metadata",
      verificationState: "verified_native_hpke",
      persistenceState: "persisted_open_ready",
      recoveryModel: "redownload_current_device_envelope",
      nativeWriteState: "created",
      receipt: {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        keyVersion: 4,
        currentServerRevision: 9,
        currentKeyUpdatedAt: NOW,
        deviceId: DEVICE_ID,
        projectKeyFingerprint: harness.vault.material.projectKeyFingerprint,
        state: "active",
      },
    });
    expect(harness.vault.acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud).toHaveBeenCalledWith({
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      expectedSessionId: SESSION_ID,
      expectedAccountId: ACCOUNT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedRecipientPublicKey: harness.vault.identity.publicKey,
      expectedRecipientPublicKeyFingerprint: harness.vault.identity.publicKeyFingerprint,
    });
    expect(harness.store.bundle).toBe(bundleBefore);
    expect(harness.store.teamReceipt).toEqual(verified.receipt);
    const nativeInput = JSON.stringify(
      harness.vault.acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud.mock.calls,
    );
    expect(nativeInput).not.toContain("ciphertext");
    expect(nativeInput).not.toContain("rawProjectDataKey");
    expect(nativeInput).not.toContain("privateKey");
    expect(nativeInput).not.toContain("keyVersion");
  });

  it("compensates a newly-created native receipt when SQLite persistence fails", async () => {
    const harness = await createHarness();
    const currentDevice = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    harness.store.failTeamReceiptSaves = true;

    await expect(
      harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
        {
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          expectedSessionId: SESSION_ID,
          expectedAccountId: ACCOUNT_ID,
        },
        currentDevice,
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_ERROR" });

    expect(harness.vault.removeStoredTeamProjectKeyReceipt).toHaveBeenCalledTimes(1);
    expect(harness.vault.nativeReceiptConfigured).toBe(false);
    expect(harness.store.teamReceipt).toBeNull();
  });

  it("keeps an updated native receipt orphan-safe and reconciles it on retry", async () => {
    const harness = await createHarness();
    const currentDevice = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    harness.vault.nativeWriteState = "updated";
    harness.store.failTeamReceiptSaves = true;

    await expect(
      harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
        {
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          expectedSessionId: SESSION_ID,
          expectedAccountId: ACCOUNT_ID,
        },
        currentDevice,
      ),
    ).rejects.toMatchObject({ code: "REPOSITORY_ERROR" });
    expect(harness.vault.removeStoredTeamProjectKeyReceipt).not.toHaveBeenCalled();
    expect(harness.vault.nativeReceiptConfigured).toBe(true);

    harness.store.failTeamReceiptSaves = false;
    harness.vault.nativeWriteState = "already_present";
    await expect(
      harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
        {
          teamId: TEAM_ID,
          projectId: PROJECT_ID,
          expectedSessionId: SESSION_ID,
          expectedAccountId: ACCOUNT_ID,
        },
        currentDevice,
      ),
    ).resolves.toMatchObject({
      persistenceState: "persisted_open_ready",
      nativeWriteState: "already_present",
    });
  });

  it("opens a persisted team receipt after service restart without a cloud fetch", async () => {
    const harness = await createHarness();
    const currentDevice = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        expectedSessionId: SESSION_ID,
        expectedAccountId: ACCOUNT_ID,
      },
      currentDevice,
    );
    const restarted = new ProjectKeyLifecycleService(
      harness.vault,
      harness.store,
      new SequenceIds([]),
      harness.clock,
    );

    const opened = await restarted.openProjectDataKeyForDevice(PROJECT_ID, DEVICE_ID, 4, {
      accountId: ACCOUNT_ID,
      expectedSessionId: SESSION_ID,
    });

    expect(opened).toMatchObject({
      projectId: PROJECT_ID,
      keyVersion: 4,
      projectKeyFingerprint: harness.vault.material.projectKeyFingerprint,
    });
    expect(harness.vault.openStoredTeamProjectKeyReceipt).toHaveBeenCalledTimes(1);
    expect(harness.vault.acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud).toHaveBeenCalledTimes(
      1,
    );
  });

  it("marks SQLite credential_missing when the native receipt disappeared", async () => {
    const harness = await createHarness();
    const currentDevice = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        expectedSessionId: SESSION_ID,
        expectedAccountId: ACCOUNT_ID,
      },
      currentDevice,
    );
    harness.vault.nativeReceiptConfigured = false;

    await expect(
      harness.service.openProjectDataKeyForDevice(PROJECT_ID, DEVICE_ID, 4, {
        accountId: ACCOUNT_ID,
        expectedSessionId: SESSION_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(harness.store.teamReceipt?.state).toBe("credential_missing");
    expect(harness.vault.openStoredTeamProjectKeyReceipt).not.toHaveBeenCalled();
  });

  it("fails closed on the newest missing receipt instead of rolling back to a superseded key", async () => {
    const harness = await createHarness();
    const currentDevice = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        expectedSessionId: SESSION_ID,
        expectedAccountId: ACCOUNT_ID,
      },
      currentDevice,
    );
    const versionFour = harness.store.teamReceipt;
    if (versionFour === null) {
      throw new Error("Expected a persisted team receipt");
    }
    const newestMissing: TeamProjectKeyReceiptMetadata = {
      ...versionFour,
      keyVersion: 5,
      currentServerRevision: 10,
      nativeStorageRef: `team_project_key_receipt_v1_${"e".repeat(64)}`,
      nativeReceiptFingerprint: "f".repeat(64),
      state: "credential_missing",
    };
    vi.spyOn(harness.store, "loadTeamProjectKeyReceipt").mockResolvedValue(ok(newestMissing));

    await expect(
      harness.service.openProjectDataKeyForDevice(PROJECT_ID, DEVICE_ID, undefined, {
        accountId: ACCOUNT_ID,
        expectedSessionId: SESSION_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(harness.vault.openStoredTeamProjectKeyReceipt).not.toHaveBeenCalled();
  });

  it("rejects account or device changes before opening a stored team receipt", async () => {
    const harness = await createHarness();
    const currentDevice = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        expectedSessionId: SESSION_ID,
        expectedAccountId: ACCOUNT_ID,
      },
      currentDevice,
    );

    await expect(
      harness.service.openProjectDataKeyForDevice(PROJECT_ID, DEVICE_ID, 4, {
        accountId: OTHER_ACCOUNT_ID,
        expectedSessionId: SESSION_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(
      harness.service.openProjectDataKeyForDevice(PROJECT_ID, REMOTE_DEVICE_ID, 4, {
        accountId: ACCOUNT_ID,
        expectedSessionId: SESSION_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(harness.vault.openStoredTeamProjectKeyReceipt).not.toHaveBeenCalled();
  });

  it("keeps an authority-unavailable receipt openable offline after local sign-out", async () => {
    const harness = await createHarness();
    const currentDevice = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.verifyTeamProjectKeyEnvelopeForCurrentDevice(
      {
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        expectedSessionId: SESSION_ID,
        expectedAccountId: ACCOUNT_ID,
      },
      currentDevice,
    );
    if (harness.store.teamReceipt === null) {
      throw new Error("Expected a persisted team receipt");
    }
    harness.store.teamReceipt = {
      ...harness.store.teamReceipt,
      state: "authority_unavailable",
    };

    await expect(
      harness.service.openProjectDataKeyForDevice(PROJECT_ID, DEVICE_ID, 4, {
        accountId: ACCOUNT_ID,
        expectedSessionId: null,
      }),
    ).resolves.toMatchObject({ projectId: PROJECT_ID, keyVersion: 4 });
    expect(harness.vault.inspectStoredTeamProjectKeyReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedSessionId: null }),
    );
  });

  it("prepares a fresh-key rotation for all trusted devices and confirms it locally", async () => {
    const harness = await createHarness();
    const sender = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.prepareInitialProjectKey(PROJECT_ID, sender);
    harness.clock.timestamp = CONFIRMED_AT;
    await harness.service.confirmPendingProjectKey(PROJECT_ID, DEVICE_ID, RECOVERY_CODE);

    const display = await harness.service.prepareProjectKeyRotation(
      PROJECT_ID,
      sender,
      [sender, remoteDevice()],
      1,
    );

    expect(display).toMatchObject({
      projectId: PROJECT_ID,
      previousKeyVersion: 1,
      keyVersion: 2,
      recipientDeviceCount: 2,
      recoveryCode: RECOVERY_CODE,
    });
    expect(harness.store.bundle?.version).toMatchObject({
      keyVersion: 2,
      state: "pending_confirmation",
    });
    harness.clock.timestamp = "2026-07-27T03:02:00.000Z";
    await expect(
      harness.service.confirmPendingProjectKey(PROJECT_ID, DEVICE_ID, RECOVERY_CODE),
    ).resolves.toMatchObject({
      version: { keyVersion: 2, state: "active" },
    });
  });

  it("stages a cloud rotation without activating it before cloud acknowledgement", async () => {
    const harness = await createHarness();
    const sender = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.prepareInitialProjectKey(PROJECT_ID, sender);
    harness.clock.timestamp = CONFIRMED_AT;
    await harness.service.confirmPendingProjectKey(PROJECT_ID, DEVICE_ID, RECOVERY_CODE);
    await harness.service.prepareProjectKeyRotation(
      PROJECT_ID,
      sender,
      [sender, remoteDevice()],
      1,
    );
    harness.clock.timestamp = "2026-07-27T03:02:00.000Z";

    const publishable = await harness.service.confirmPendingProjectKeyForCloudPublication(
      PROJECT_ID,
      DEVICE_ID,
      RECOVERY_CODE,
    );

    expect(publishable).toMatchObject({
      version: { keyVersion: 2, state: "active", revision: 2 },
      recoveryEnvelope: { confirmedAt: "2026-07-27T03:02:00.000Z" },
    });
    expect(harness.store.bundle).toMatchObject({
      version: { keyVersion: 2, state: "pending_confirmation", revision: 1 },
      recoveryEnvelope: { confirmedAt: "2026-07-27T03:02:00.000Z" },
    });
    await expect(
      harness.service.confirmPendingProjectKeyForCloudPublication(PROJECT_ID, DEVICE_ID),
    ).resolves.toEqual(publishable);
    expect(harness.vault.verifyProjectRecoveryKit).toHaveBeenCalledTimes(2);
  });

  it("recovers a confirmed cloud key and stores only a local device envelope", async () => {
    const harness = await createHarness();
    const device = await harness.service.ensureLocalDeviceIdentity({
      accountId: ACCOUNT_ID,
    });
    await harness.service.prepareInitialProjectKey(PROJECT_ID, device);
    harness.clock.timestamp = CONFIRMED_AT;
    const bundle = await harness.service.confirmPendingProjectKey(
      PROJECT_ID,
      DEVICE_ID,
      RECOVERY_CODE,
    );
    const keySet: CloudProjectKeySet = {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      keyVersion: 1,
      serverRevision: 1,
      publication: {
        projectId: PROJECT_ID,
        keyVersion: 1,
        serverRevision: 1,
        publicationRequestSha256: "0".repeat(64),
        publishedAt: CONFIRMED_AT,
      },
      version: bundle.version,
      recoveryEnvelope: bundle.recoveryEnvelope,
      deviceEnvelopes: [bundle.deviceEnvelope],
      updatedAt: CONFIRMED_AT,
    };

    await expect(
      harness.service.recoverCloudProjectKeyForLocalDevice(keySet, device, RECOVERY_CODE),
    ).resolves.toMatchObject({
      projectId: PROJECT_ID,
      keyVersion: 1,
      projectKeyFingerprint: harness.vault.material.projectKeyFingerprint,
    });
    expect(harness.store.bundle?.deviceEnvelope).toMatchObject({
      envelopeId: NEXT_RECOVERY_ID,
      recipientDeviceId: DEVICE_ID,
    });
    expect(JSON.stringify(harness.store.bundle)).not.toContain(RECOVERY_CODE);
  });

  it("can reset only the unconfirmed setup when its one-time code was lost", async () => {
    const harness = await createHarness();
    const device = await harness.service.ensureLocalDeviceIdentity();
    await harness.service.prepareInitialProjectKey(PROJECT_ID, device);

    await harness.service.abandonPendingProjectKeySetup(PROJECT_ID, DEVICE_ID);

    expect(harness.store.bundle).toBeNull();
  });

  it("fails closed outside the native credential boundary", async () => {
    const store = new MemoryProjectKeyPersistence();
    const service = new ProjectKeyLifecycleService(
      new BrowserDevelopmentProjectKeyVault(),
      store,
      new SequenceIds([DEVICE_ID]),
      new MutableClock(NOW),
    );

    await expect(service.ensureLocalDeviceIdentity()).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(store.device).toBeNull();
  });

  it("marks public metadata credential_missing when the OS private key disappeared", async () => {
    const harness = await createHarness();
    const existing = await harness.service.ensureLocalDeviceIdentity();
    harness.vault.identityStatus = { configured: false, identity: null };

    await expect(harness.service.ensureLocalDeviceIdentity()).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });

    expect(harness.store.device).toEqual({
      ...existing,
      state: "credential_missing",
      updatedAt: NOW,
    });
  });

  it("returns a device identity only after the OS credential entry is verified", async () => {
    const harness = await createHarness();

    await expect(harness.service.getVerifiedLocalDeviceIdentity(DEVICE_ID)).resolves.toEqual(
      harness.vault.identity,
    );
    expect(harness.vault.getDeviceIdentityStatus).toHaveBeenCalledWith(DEVICE_ID);

    harness.vault.identityStatus = { configured: false, identity: null };
    await expect(harness.service.getVerifiedLocalDeviceIdentity(DEVICE_ID)).resolves.toBeNull();
  });

  it("never reuses an account-bound device identity for a different account", async () => {
    const harness = await createHarness();
    const bound = await harness.service.ensureLocalDeviceIdentity({ accountId: ACCOUNT_ID });

    await expect(
      harness.service.ensureLocalDeviceIdentity({ accountId: OTHER_ACCOUNT_ID }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(harness.store.device).toEqual(bound);
    expect(harness.vault.createDeviceIdentity).toHaveBeenCalledTimes(1);
  });
});

class MemoryProjectKeyPersistence implements ProjectKeyPersistence {
  public device: DevicePublicKeyRecord | null = null;
  public bundle: ProjectKeyBundle | null = null;
  public teamReceipt: TeamProjectKeyReceiptMetadata | null = null;
  public failTeamReceiptSaves = false;

  public listLocalDevicePublicKeys(): Promise<Result<readonly DevicePublicKeyRecord[], AppError>> {
    return Promise.resolve(ok(this.device === null ? [] : [this.device]));
  }

  public saveDevicePublicKey(record: DevicePublicKeyRecord): Promise<Result<void, AppError>> {
    this.device = record;
    return Promise.resolve(ok(undefined));
  }

  public loadProjectKeyBundle(
    projectId: string,
    deviceId: string,
    keyVersion?: number,
  ): Promise<Result<ProjectKeyBundle | null, AppError>> {
    void projectId;
    void deviceId;
    void keyVersion;
    return Promise.resolve(ok(this.bundle));
  }

  public saveTeamProjectKeyReceipt(
    input: SaveTeamProjectKeyReceiptInput,
  ): Promise<Result<TeamProjectKeyReceiptMetadata, AppError>> {
    if (this.failTeamReceiptSaves) {
      return Promise.resolve(
        err(
          new AppError({
            code: "REPOSITORY_ERROR",
            message: "Injected team receipt persistence failure.",
          }),
        ),
      );
    }
    this.teamReceipt = {
      ...input,
      state: "active",
      receivedAt: this.teamReceipt?.receivedAt ?? input.receivedAt,
      lastVerifiedAt: input.receivedAt,
      stateUpdatedAt: input.receivedAt,
    };
    return Promise.resolve(ok(this.teamReceipt));
  }

  public loadTeamProjectKeyReceipt(
    scope: TeamProjectKeyReceiptScope,
  ): Promise<Result<TeamProjectKeyReceiptMetadata | null, AppError>> {
    const receipt = this.teamReceipt;
    if (
      receipt?.projectId !== scope.projectId ||
      receipt.accountId !== scope.accountId ||
      receipt.deviceId !== scope.deviceId ||
      (scope.teamId !== undefined && receipt.teamId !== scope.teamId) ||
      (scope.keyVersion !== undefined && receipt.keyVersion !== scope.keyVersion)
    ) {
      return Promise.resolve(ok(null));
    }
    return Promise.resolve(ok(receipt));
  }

  public transitionTeamProjectKeyReceiptState(
    input: MarkTeamProjectKeyReceiptStateInput,
  ): Promise<Result<TeamProjectKeyReceiptMetadata, AppError>> {
    const current = this.teamReceipt;
    if (
      current?.nativeStorageRef !== input.nativeStorageRef ||
      current.nativeReceiptFingerprint !== input.nativeReceiptFingerprint ||
      current.state !== input.expectedState
    ) {
      throw new Error("Team receipt test CAS mismatch");
    }
    this.teamReceipt = {
      ...current,
      state: input.nextState,
      stateUpdatedAt: input.updatedAt,
    };
    return Promise.resolve(ok(this.teamReceipt));
  }

  public beginProjectKeySetup(
    setup: PendingProjectKeySetup,
  ): Promise<Result<ProjectKeyBundle, AppError>> {
    this.bundle = setup;
    return Promise.resolve(ok(setup));
  }

  public beginProjectKeyRotation(
    rotation: PendingProjectKeyRotation,
  ): Promise<Result<ProjectKeyBundle, AppError>> {
    const first = rotation.deviceEnvelopes[0];
    if (first === undefined) {
      throw new Error("Missing test rotation envelope");
    }
    this.bundle = {
      version: rotation.version,
      deviceEnvelope: first,
      recoveryEnvelope: rotation.recoveryEnvelope,
    };
    return Promise.resolve(ok(this.bundle));
  }

  public saveDeviceEnvelope(
    envelope: DeviceProjectKeyEnvelopeContract,
  ): Promise<Result<void, AppError>> {
    if (this.bundle === null) {
      throw new Error("Missing test bundle");
    }
    this.bundle = { ...this.bundle, deviceEnvelope: envelope };
    return Promise.resolve(ok(undefined));
  }

  public confirmRecovery(input: ConfirmRecoveryInput): Promise<Result<ProjectKeyBundle, AppError>> {
    if (this.bundle === null) {
      throw new Error("Missing test bundle");
    }
    this.bundle = {
      version: {
        ...this.bundle.version,
        state: "active",
        revision: input.expectedRevision + 1,
      },
      deviceEnvelope: this.bundle.deviceEnvelope,
      recoveryEnvelope: {
        ...this.bundle.recoveryEnvelope,
        confirmedAt: input.confirmedAt,
      },
    };
    return Promise.resolve(ok(this.bundle));
  }

  public confirmRecoveryForPublication(
    input: ConfirmRecoveryInput,
  ): Promise<Result<ProjectKeyBundle, AppError>> {
    if (this.bundle === null) {
      throw new Error("Missing test bundle");
    }
    this.bundle = {
      ...this.bundle,
      recoveryEnvelope: {
        ...this.bundle.recoveryEnvelope,
        confirmedAt: input.confirmedAt,
      },
    };
    return Promise.resolve(ok(this.bundle));
  }

  public abandonPendingProjectKeySetup(
    input: AbandonPendingProjectKeySetupInput,
  ): Promise<Result<void, AppError>> {
    void input;
    this.bundle = null;
    return Promise.resolve(ok(undefined));
  }
}

class FakeProjectKeyVault implements ProjectKeyVault {
  public readonly available = true;
  public identityStatus: DeviceIdentityStatus;
  public nativeReceiptConfigured = false;
  public nativeWriteState: NativeTeamProjectKeyReceiptCommit["nativeWriteState"] = "created";
  public teamKeyVersion = 4;
  public teamServerRevision = 9;

  public readonly createDeviceIdentity = vi.fn(
    (deviceId: string): Promise<DeviceIdentitySummary> => {
      void deviceId;
      return Promise.resolve(this.identity);
    },
  );

  public readonly getDeviceIdentityStatus = vi.fn(
    (deviceId: string): Promise<DeviceIdentityStatus> => {
      void deviceId;
      return Promise.resolve(this.identityStatus);
    },
  );

  public readonly generateProjectDataKey = vi.fn((): Promise<ProjectDataKeyMaterial> =>
    Promise.resolve(this.material),
  );

  public readonly wrapProjectDataKeyForDevice = vi.fn(
    (input: WrapProjectDataKeyInput): Promise<NativeDeviceProjectKeyEnvelope> =>
      Promise.resolve({
        schemaVersion: 1,
        algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
        envelopeId: input.envelopeId,
        projectId: input.projectId,
        keyVersion: input.keyVersion,
        senderDeviceId: input.senderDeviceId,
        senderPublicKey: this.identity.publicKey,
        senderPublicKeyFingerprint: this.identity.publicKeyFingerprint,
        recipientDeviceId: input.recipientDeviceId,
        recipientPublicKey: input.recipientPublicKey,
        recipientPublicKeyFingerprint: input.recipientPublicKeyFingerprint,
        encapsulatedKey: "B".repeat(87),
        ciphertext: "C".repeat(64),
      }),
  );

  public readonly unwrapProjectDataKeyForDevice = vi.fn(
    (envelope: NativeDeviceProjectKeyEnvelope): Promise<ProjectDataKeyMaterial> => {
      void envelope;
      return Promise.resolve(this.material);
    },
  );

  public readonly rewrapProjectDataKeyForTeamRecipients = vi.fn(
    (
      input: RewrapProjectDataKeyForTeamRecipientsInput,
    ): Promise<readonly NativeTeamProjectKeyEnvelope[]> =>
      Promise.resolve(
        input.recipients.map((recipient) => ({
          schemaVersion: 1,
          envelopeKind: "team_project_member_device",
          algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
          envelopeId: recipient.envelopeId,
          teamId: input.teamId,
          projectId: input.projectId,
          keyVersion: input.keyVersion,
          membershipId: recipient.membershipId,
          membershipRevision: recipient.membershipRevision,
          assignmentId: recipient.assignmentId,
          assignmentRevision: recipient.assignmentRevision,
          senderDeviceId: input.senderDeviceId,
          senderPublicKey: this.identity.publicKey,
          senderPublicKeyFingerprint: this.identity.publicKeyFingerprint,
          recipientDeviceId: recipient.recipientDeviceId,
          recipientPublicKey: recipient.recipientPublicKey,
          recipientPublicKeyFingerprint: recipient.recipientPublicKeyFingerprint,
          encapsulatedKey: "B".repeat(87),
          ciphertext: "C".repeat(64),
        })),
      ),
  );

  public readonly acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud = vi.fn(
    (
      input: AcceptCurrentDeviceTeamProjectKeyEnvelopeInput,
    ): Promise<NativeTeamProjectKeyReceiptCommit> => {
      this.nativeReceiptConfigured = true;
      return Promise.resolve({
        schemaVersion: 1,
        receiptKind: "team_managed_device_envelope",
        envelopeId: REMOTE_ENVELOPE_ID,
        teamId: input.teamId,
        projectId: input.projectId,
        keyVersion: this.teamKeyVersion,
        accountId: input.expectedAccountId,
        deviceId: input.expectedDeviceId,
        currentServerRevision: this.teamServerRevision,
        currentKeyUpdatedAt: NOW,
        membershipId: MEMBERSHIP_ID,
        membershipRevision: 2,
        assignmentId: ASSIGNMENT_ID,
        assignmentRevision: 3,
        senderDeviceId: REMOTE_DEVICE_ID,
        senderPublicKeyFingerprint: "b".repeat(64),
        recipientPublicKeyFingerprint: input.expectedRecipientPublicKeyFingerprint,
        projectKeyFingerprint: this.material.projectKeyFingerprint,
        nativeStorageRef: `team_project_key_receipt_v1_${"c".repeat(64)}`,
        nativeReceiptFingerprint: "d".repeat(64),
        envelopeCreatedAt: NOW,
        nativeWriteState: this.nativeWriteState,
      });
    },
  );

  public readonly inspectStoredTeamProjectKeyReceipt = vi.fn(
    (input: TeamProjectKeyReceiptAccessInput): Promise<NativeTeamProjectKeyReceiptStatus> =>
      Promise.resolve({
        configured: this.nativeReceiptConfigured,
        nativeReceiptFingerprint: this.nativeReceiptConfigured
          ? input.receipt.nativeReceiptFingerprint
          : null,
      }),
  );

  public readonly openStoredTeamProjectKeyReceipt = vi.fn(
    (input: TeamProjectKeyReceiptAccessInput): Promise<ProjectDataKeyMaterial> => {
      void input;
      return Promise.resolve(this.material);
    },
  );

  public readonly removeStoredTeamProjectKeyReceipt = vi.fn(
    (input: TeamProjectKeyReceiptAccessInput): Promise<NativeTeamProjectKeyReceiptRemoval> => {
      void input;
      const removed = this.nativeReceiptConfigured;
      this.nativeReceiptConfigured = false;
      return Promise.resolve({ removed });
    },
  );

  public readonly createProjectRecoveryKit = vi.fn(
    (input: CreateRecoveryKitInput): Promise<RecoveryKit> =>
      Promise.resolve({
        recoveryCode: RECOVERY_CODE,
        envelope: recoveryEnvelope(input),
      }),
  );

  public readonly verifyProjectRecoveryKit = vi.fn(
    (
      recoveryCode: string,
      envelope: NativeRecoveryProjectKeyEnvelope,
    ): Promise<RecoveryVerification> => {
      void envelope;
      if (recoveryCode !== RECOVERY_CODE) {
        return Promise.reject(new Error("Recovery verification failed"));
      }
      return Promise.resolve({
        valid: true,
        projectKeyFingerprint: this.material.projectKeyFingerprint,
      });
    },
  );

  public readonly recoverProjectDataKey = vi.fn(
    (
      recoveryCode: string,
      envelope: NativeRecoveryProjectKeyEnvelope,
    ): Promise<ProjectDataKeyMaterial> => {
      void envelope;
      if (recoveryCode !== RECOVERY_CODE) {
        return Promise.reject(new Error("Recovery failed"));
      }
      return Promise.resolve(this.material);
    },
  );

  public constructor(
    public readonly identity: DeviceIdentitySummary,
    public readonly material: ProjectDataKeyMaterial,
  ) {
    this.identityStatus = { configured: true, identity };
  }
}

class MutableClock implements Clock {
  public constructor(public timestamp: string) {}

  public now(): ReturnType<Clock["now"]> {
    return this.timestamp as ReturnType<Clock["now"]>;
  }
}

class SequenceIds implements UuidV7Generator {
  private index = 0;

  public constructor(private readonly values: readonly string[]) {}

  public next(): ReturnType<UuidV7Generator["next"]> {
    const value = this.values[this.index];
    if (value === undefined) {
      throw new Error("Test UUID sequence exhausted");
    }
    this.index += 1;
    return value as ReturnType<UuidV7Generator["next"]>;
  }
}

class CapturingCipher extends AesGcmChunkCipher {
  public captured: Uint8Array | undefined;

  public override async importProjectDataKey(rawKey: Uint8Array): Promise<CryptoKey> {
    this.captured = rawKey;
    return super.importProjectDataKey(rawKey);
  }
}

async function createHarness(cipher: AesGcmChunkCipher = new AesGcmChunkCipher()) {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const material: ProjectDataKeyMaterial = {
    rawProjectDataKey: encodeBase64Url(bytes),
    projectKeyFingerprint: await sha256Hex(bytes),
  };
  const identity: DeviceIdentitySummary = {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: "A".repeat(87),
    publicKeyFingerprint: "a".repeat(64),
    privateKeyStorage: "os_credential_store",
  };
  const vault = new FakeProjectKeyVault(identity, material);
  const store = new MemoryProjectKeyPersistence();
  const clock = new MutableClock(NOW);
  const service = new ProjectKeyLifecycleService(
    vault,
    store,
    new SequenceIds([
      DEVICE_ID,
      ENVELOPE_ID,
      RECOVERY_ID,
      NEXT_RECOVERY_ID,
      NEXT_ENVELOPE_ID,
      REMOTE_ENVELOPE_ID,
    ]),
    clock,
    cipher,
  );
  return { clock, service, store, vault };
}

function remoteDevice(): DevicePublicKeyRecord {
  return {
    schemaVersion: 1,
    deviceId: REMOTE_DEVICE_ID,
    accountId: ACCOUNT_ID,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: "R".repeat(87),
    publicKeyFingerprint: "b".repeat(64),
    displayName: "远端设备",
    keyOrigin: "remote_registered",
    state: "trusted",
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function recoveryEnvelope(input: CreateRecoveryKitInput): NativeRecoveryProjectKeyEnvelope {
  return {
    schemaVersion: 1,
    algorithm: "ARGON2ID-AES256GCM",
    recoveryId: input.recoveryId,
    projectId: input.projectId,
    keyVersion: input.keyVersion,
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

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
