import { AesGcmChunkCipher } from "@inkshadow/sync-core";
import {
  IsoUtcTimestampSchema,
  UuidV7Schema,
  type CloudProjectKeySet,
  type DeviceProjectKeyEnvelopeContract,
} from "@inkshadow/contracts";
import { AppError, type Clock, type Result, type UuidV7Generator } from "@inkshadow/domain";
import type {
  DevicePublicKeyRecord,
  MarkTeamProjectKeyReceiptStateInput,
  ProjectKeyBundle,
  ProjectKeySqliteStore,
  SaveTeamProjectKeyReceiptInput,
  TeamProjectKeyReceiptMetadata,
} from "@inkshadow/data/project-key-sqlite-store";

import type {
  DeviceIdentitySummary,
  NativeDeviceProjectKeyEnvelope,
  NativeRecoveryProjectKeyEnvelope,
  NativeTeamProjectKeyEnvelope,
  NativeTeamProjectKeyReceiptBinding,
  NativeTeamProjectKeyReceiptCommit,
  ProjectDataKeyMaterial,
  ProjectKeyVault,
  TeamProjectKeyRecipientInput,
} from "./project-key-vault";

export interface PendingProjectRecoveryDisplay {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly deviceId: string;
  readonly projectKeyFingerprint: string;
  readonly recoveryCode: string;
}

export interface PendingProjectRotationDisplay extends PendingProjectRecoveryDisplay {
  readonly previousKeyVersion: number;
  readonly recipientDeviceCount: number;
}

export interface OpenProjectDataKey {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly projectKeyFingerprint: string;
  readonly key: CryptoKey;
}

export interface PreparedCloudProjectKeyRecovery {
  readonly openKey: OpenProjectDataKey;
  readonly deviceEnvelope: DeviceProjectKeyEnvelopeContract;
}

export interface EnsureLocalDeviceIdentityInput {
  readonly accountId?: string | null;
  readonly displayName?: string;
}

export interface ProjectKeyEnvelopeDeviceIdentity {
  readonly algorithm: string;
  readonly deviceId: string;
  readonly publicKey: string;
  readonly publicKeyFingerprint: string;
}

export interface TeamProjectKeyEnvelopeRecipientTarget extends ProjectKeyEnvelopeDeviceIdentity {
  readonly envelopeId: string;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
}

export interface CurrentDeviceTeamProjectKeyEnvelopeScope {
  readonly teamId: string;
  readonly projectId: string;
  readonly expectedSessionId: string;
  readonly expectedAccountId: string;
}

export interface VerifiedTeamProjectKeyEnvelope {
  readonly capabilityState: "persisted_team_managed_receipt";
  readonly keyVersionDiscovery: "authoritative_team_current_metadata";
  readonly verificationState: "verified_native_hpke";
  readonly persistenceState: "persisted_open_ready";
  readonly recoveryModel: "redownload_current_device_envelope";
  readonly nativeWriteState: NativeTeamProjectKeyReceiptCommit["nativeWriteState"];
  readonly receipt: TeamProjectKeyReceiptMetadata;
}

export type ProjectKeyAccess =
  | Readonly<{
      kind: "personal_recovery_backed";
      bundle: ProjectKeyBundle;
    }>
  | Readonly<{
      kind: "team_managed_receipt";
      receipt: TeamProjectKeyReceiptMetadata;
    }>;

export interface TeamProjectKeyOpenAuthority {
  readonly accountId: string;
  readonly expectedSessionId: string | null;
}

export interface TeamProjectKeyReceiptOpenStatus {
  readonly receipt: TeamProjectKeyReceiptMetadata;
  readonly nativeConfigured: boolean;
  readonly openReady: boolean;
}

export type ProjectKeyPersistence = Pick<
  ProjectKeySqliteStore,
  | "beginProjectKeySetup"
  | "abandonPendingProjectKeySetup"
  | "confirmRecovery"
  | "confirmRecoveryForPublication"
  | "beginProjectKeyRotation"
  | "listLocalDevicePublicKeys"
  | "loadProjectKeyBundle"
  | "loadTeamProjectKeyReceipt"
  | "saveDeviceEnvelope"
  | "saveDevicePublicKey"
  | "saveTeamProjectKeyReceipt"
  | "transitionTeamProjectKeyReceiptState"
>;

export class ProjectKeyLifecycleService {
  private teamReceiptMutationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly vault: ProjectKeyVault,
    private readonly store: ProjectKeyPersistence,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
    private readonly cipher: AesGcmChunkCipher = new AesGcmChunkCipher(),
    private readonly cryptoProvider: Crypto = globalThis.crypto,
  ) {}

  public async ensureLocalDeviceIdentity(
    input: EnsureLocalDeviceIdentityInput = {},
  ): Promise<DevicePublicKeyRecord> {
    this.requireNativeVault();
    const accountId = input.accountId ?? null;
    const requestedDisplayName =
      input.displayName === undefined ? null : normalizeDeviceDisplayName(input.displayName);
    const localDevices = unwrap(await this.store.listLocalDevicePublicKeys());
    const current = localDevices[0] ?? null;
    if (current === null) {
      const identity = await this.vault.createDeviceIdentity(this.ids.next());
      assertNativeDeviceIdentity(identity);
      const now = this.clock.now();
      const record = deviceRecordFromIdentity(
        identity,
        accountId,
        requestedDisplayName ?? "此设备",
        now,
      );
      unwrap(await this.store.saveDevicePublicKey(record));
      return record;
    }
    if (current.state === "revoked") {
      throw securityStateError(
        "The latest local device identity has been revoked and cannot authorize new envelopes.",
      );
    }

    const status = await this.vault.getDeviceIdentityStatus(current.deviceId);
    if (!status.configured || status.identity === null) {
      const now = this.clock.now();
      unwrap(
        await this.store.saveDevicePublicKey({
          ...current,
          state: "credential_missing",
          updatedAt: now,
          revokedAt: null,
        }),
      );
      throw securityStateError(
        "The operating-system credential store no longer contains this device private key.",
      );
    }
    assertNativeDeviceIdentity(status.identity);
    assertIdentityMatchesRecord(status.identity, current);
    if (current.accountId !== null && accountId !== null && current.accountId !== accountId) {
      throw securityStateError(
        "A device identity already bound to another cloud account cannot be silently reused.",
      );
    }
    const nextAccountId = current.accountId ?? accountId;
    const nextDisplayName = requestedDisplayName ?? current.displayName;
    const next: DevicePublicKeyRecord = {
      ...current,
      accountId: nextAccountId,
      displayName: nextDisplayName,
      state: "trusted",
      updatedAt:
        current.state === "trusted" &&
        current.accountId === nextAccountId &&
        current.displayName === nextDisplayName
          ? current.updatedAt
          : this.clock.now(),
      revokedAt: null,
    };
    unwrap(await this.store.saveDevicePublicKey(next));
    return next;
  }

  public async getVerifiedLocalDeviceIdentity(
    deviceId: string,
  ): Promise<DeviceIdentitySummary | null> {
    this.requireNativeVault();
    const status = await this.vault.getDeviceIdentityStatus(deviceId);
    if (status.configured !== (status.identity !== null)) {
      throw securityValidationError(
        "The operating-system device identity status is internally inconsistent.",
      );
    }
    if (status.identity === null) {
      return null;
    }
    assertNativeDeviceIdentity(status.identity);
    if (status.identity.deviceId !== deviceId) {
      throw securityValidationError(
        "The operating-system device identity does not match the requested device.",
      );
    }
    return status.identity;
  }

  public async prepareInitialProjectKey(
    projectId: string,
    device: DevicePublicKeyRecord,
  ): Promise<PendingProjectRecoveryDisplay> {
    this.requireNativeVault();
    if (device.state !== "trusted" || device.keyOrigin !== "local_os_credential") {
      throw securityStateError("A trusted local device identity is required.");
    }
    const existing = unwrap(await this.store.loadProjectKeyBundle(projectId, device.deviceId));
    if (existing !== null) {
      throw securityStateError("This project already has a pending or active project key version.");
    }

    const keyVersion = 1;
    const envelopeId = this.ids.next();
    const recoveryId = this.ids.next();
    const material = await this.vault.generateProjectDataKey();
    const [deviceCryptogram, recoveryKit] = await Promise.all([
      this.vault.wrapProjectDataKeyForDevice({
        envelopeId,
        projectId,
        keyVersion,
        senderDeviceId: device.deviceId,
        recipientDeviceId: device.deviceId,
        recipientPublicKey: device.publicKey,
        recipientPublicKeyFingerprint: device.publicKeyFingerprint,
        rawProjectDataKey: material.rawProjectDataKey,
      }),
      this.vault.createProjectRecoveryKit({
        recoveryId,
        projectId,
        keyVersion,
        rawProjectDataKey: material.rawProjectDataKey,
      }),
    ]);
    const now = this.clock.now();
    const setup: ProjectKeyBundle = {
      version: {
        schemaVersion: 1,
        projectId,
        keyVersion,
        algorithm: "AES-256-GCM",
        state: "pending_confirmation",
        revision: 1,
        createdAt: now,
        retiredAt: null,
      },
      deviceEnvelope: {
        ...deviceCryptogram,
        createdAt: now,
        revokedAt: null,
      },
      recoveryEnvelope: {
        ...recoveryKit.envelope,
        createdAt: now,
        confirmedAt: null,
        revokedAt: null,
      },
    };
    unwrap(await this.store.beginProjectKeySetup(setup));
    return {
      projectId,
      keyVersion,
      deviceId: device.deviceId,
      projectKeyFingerprint: material.projectKeyFingerprint,
      recoveryCode: recoveryKit.recoveryCode,
    };
  }

  public async confirmPendingProjectKey(
    projectId: string,
    deviceId: string,
    recoveryCode: string,
  ): Promise<ProjectKeyBundle> {
    this.requireNativeVault();
    const bundle = unwrap(await this.store.loadProjectKeyBundle(projectId, deviceId));
    if (bundle === null) {
      throw securityStateError("No pending project recovery confirmation is available.");
    }
    if (
      bundle.version.state !== "pending_confirmation" ||
      bundle.recoveryEnvelope.confirmedAt !== null
    ) {
      throw securityStateError("No pending project recovery confirmation is available.");
    }
    await this.vault.verifyProjectRecoveryKit(
      recoveryCode,
      withoutRecoveryLifecycle(bundle.recoveryEnvelope),
    );
    return unwrap(
      await this.store.confirmRecovery({
        projectId,
        keyVersion: bundle.version.keyVersion,
        recoveryId: bundle.recoveryEnvelope.recoveryId,
        expectedRevision: bundle.version.revision,
        confirmedAt: this.clock.now(),
      }),
    );
  }

  public async confirmPendingProjectKeyForCloudPublication(
    projectId: string,
    deviceId: string,
    recoveryCode?: string,
  ): Promise<ProjectKeyBundle> {
    this.requireNativeVault();
    let bundle = unwrap(await this.store.loadProjectKeyBundle(projectId, deviceId));
    if (bundle?.version.state !== "pending_confirmation") {
      throw securityStateError("No pending project-key publication confirmation is available.");
    }
    if (bundle.recoveryEnvelope.confirmedAt === null) {
      if (recoveryCode === undefined || recoveryCode.trim() === "") {
        throw securityStateError(
          "The one-time recovery code is required before cloud publication.",
        );
      }
      await this.vault.verifyProjectRecoveryKit(
        recoveryCode,
        withoutRecoveryLifecycle(bundle.recoveryEnvelope),
      );
      bundle = unwrap(
        await this.store.confirmRecoveryForPublication({
          projectId,
          keyVersion: bundle.version.keyVersion,
          recoveryId: bundle.recoveryEnvelope.recoveryId,
          expectedRevision: bundle.version.revision,
          confirmedAt: this.clock.now(),
        }),
      );
    }
    if (
      bundle.version.state !== "pending_confirmation" ||
      bundle.recoveryEnvelope.confirmedAt === null
    ) {
      throw securityStateError("The pending project-key publication changed during confirmation.");
    }
    return {
      ...bundle,
      version: {
        ...bundle.version,
        state: "active",
        revision: bundle.version.revision + 1,
      },
    };
  }

  public async createDeviceEnvelopesForExistingKey(
    projectId: string,
    sender: DevicePublicKeyRecord,
    recipients: readonly DevicePublicKeyRecord[],
    keyVersion?: number,
  ): Promise<readonly DeviceProjectKeyEnvelopeContract[]> {
    this.requireNativeVault();
    assertTrustedLocalSender(sender);
    const normalizedRecipients = normalizeRecipients(sender, recipients);
    const bundle = unwrap(
      await this.store.loadProjectKeyBundle(projectId, sender.deviceId, keyVersion),
    );
    if (
      bundle === null ||
      (!["active", "retiring"].includes(bundle.version.state) &&
        !(
          bundle.version.state === "pending_confirmation" &&
          bundle.recoveryEnvelope.confirmedAt !== null
        )) ||
      bundle.recoveryEnvelope.confirmedAt === null
    ) {
      throw securityStateError(
        "A confirmed active project key is required before device authorization.",
      );
    }
    await this.assertCurrentNativeSender(sender);
    const material = await this.vault.unwrapProjectDataKeyForDevice(
      withoutDeviceLifecycle(bundle.deviceEnvelope),
    );
    await this.importVerifiedMaterial(material);
    const createdAt = this.clock.now();
    const envelopes: DeviceProjectKeyEnvelopeContract[] = [];
    for (const recipient of normalizedRecipients) {
      if (recipient.deviceId === sender.deviceId) {
        envelopes.push(bundle.deviceEnvelope);
        continue;
      }
      const wrapped = await this.vault.wrapProjectDataKeyForDevice({
        envelopeId: this.ids.next(),
        projectId,
        keyVersion: bundle.version.keyVersion,
        senderDeviceId: sender.deviceId,
        recipientDeviceId: recipient.deviceId,
        recipientPublicKey: recipient.publicKey,
        recipientPublicKeyFingerprint: recipient.publicKeyFingerprint,
        rawProjectDataKey: material.rawProjectDataKey,
      });
      envelopes.push({ ...wrapped, createdAt, revokedAt: null });
    }
    return Object.freeze(envelopes);
  }

  /**
   * Rewraps one active local project key for an exact external recipient
   * snapshot. The source envelope and recipient public metadata cross the IPC
   * boundary, but the plaintext DEK remains inside the native vault command.
   */
  public async createTeamProjectKeyEnvelopesForActiveKey(
    teamId: string,
    projectId: string,
    keyVersion: number,
    sender: ProjectKeyEnvelopeDeviceIdentity,
    recipients: readonly TeamProjectKeyEnvelopeRecipientTarget[],
  ): Promise<readonly NativeTeamProjectKeyEnvelope[]> {
    this.requireNativeVault();
    assertProjectKeyEnvelopeIdentity(sender);
    const normalizedRecipients = normalizeTeamRecipientTargets(recipients);
    const nativeSender = await this.getVerifiedLocalDeviceIdentity(sender.deviceId);
    if (nativeSender === null) {
      throw securityStateError(
        "The operating-system credential store no longer contains the sender private key.",
      );
    }
    assertProjectKeyEnvelopeIdentityMatches(nativeSender, sender);

    const bundle = unwrap(
      await this.store.loadProjectKeyBundle(projectId, sender.deviceId, keyVersion),
    );
    if (
      bundle?.version.projectId !== projectId ||
      bundle.version.keyVersion !== keyVersion ||
      bundle.version.state !== "active" ||
      bundle.recoveryEnvelope.confirmedAt === null ||
      bundle.deviceEnvelope.revokedAt !== null ||
      bundle.deviceEnvelope.recipientDeviceId !== sender.deviceId ||
      bundle.deviceEnvelope.recipientPublicKey !== sender.publicKey ||
      bundle.deviceEnvelope.recipientPublicKeyFingerprint !== sender.publicKeyFingerprint
    ) {
      throw securityStateError(
        "An exact active local project key is required before team recipients can be authorized.",
      );
    }

    const nativeRecipients: readonly TeamProjectKeyRecipientInput[] = normalizedRecipients.map(
      (recipient) => ({
        envelopeId: recipient.envelopeId,
        membershipId: recipient.membershipId,
        membershipRevision: recipient.membershipRevision,
        assignmentId: recipient.assignmentId,
        assignmentRevision: recipient.assignmentRevision,
        recipientDeviceId: recipient.deviceId,
        recipientPublicKey: recipient.publicKey,
        recipientPublicKeyFingerprint: recipient.publicKeyFingerprint,
      }),
    );
    const envelopes = await this.vault.rewrapProjectDataKeyForTeamRecipients({
      teamId,
      projectId,
      keyVersion,
      senderDeviceId: sender.deviceId,
      sourceEnvelope: withoutDeviceLifecycle(bundle.deviceEnvelope),
      recipients: nativeRecipients,
    });
    assertRewrappedTeamEnvelopes(
      envelopes,
      teamId,
      projectId,
      keyVersion,
      sender,
      normalizedRecipients,
    );
    return Object.freeze([...envelopes]);
  }

  /**
   * Accepts the authoritative current-device team envelope into the native
   * credential store, then records only its non-secret receipt metadata in
   * SQLite. A newly-created native value is removed if the SQLite commit
   * fails; updated/idempotent values remain orphan-safe for a later retry.
   */
  public async verifyTeamProjectKeyEnvelopeForCurrentDevice(
    scope: CurrentDeviceTeamProjectKeyEnvelopeScope,
    currentDevice: ProjectKeyEnvelopeDeviceIdentity,
  ): Promise<VerifiedTeamProjectKeyEnvelope> {
    return this.runSerializedTeamReceiptMutation(async () => {
      this.requireNativeVault();
      assertProjectKeyEnvelopeIdentity(currentDevice);
      assertCurrentDeviceTeamEnvelopeScope(scope);
      const nativeIdentity = await this.getVerifiedLocalDeviceIdentity(currentDevice.deviceId);
      if (nativeIdentity === null) {
        throw securityStateError(
          "The operating-system credential store no longer contains the recipient private key.",
        );
      }
      assertProjectKeyEnvelopeIdentityMatches(nativeIdentity, currentDevice);
      const commit = await this.vault.acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud({
        teamId: scope.teamId,
        projectId: scope.projectId,
        expectedSessionId: scope.expectedSessionId,
        expectedAccountId: scope.expectedAccountId,
        expectedDeviceId: currentDevice.deviceId,
        expectedRecipientPublicKey: currentDevice.publicKey,
        expectedRecipientPublicKeyFingerprint: currentDevice.publicKeyFingerprint,
      });
      assertNativeTeamProjectKeyReceiptCommit(commit, scope, currentDevice);
      const receiptBinding = nativeTeamProjectKeyReceiptBinding(commit);
      const saveInput: SaveTeamProjectKeyReceiptInput = {
        ...receiptBinding,
        receivedAt: this.clock.now(),
      };
      const saved = await this.store.saveTeamProjectKeyReceipt(saveInput);
      if (!saved.ok) {
        if (commit.nativeWriteState === "created") {
          try {
            const compensation = await this.vault.removeStoredTeamProjectKeyReceipt({
              expectedSessionId: scope.expectedSessionId,
              receipt: receiptBinding,
            });
            if (!compensation.removed) {
              throw securityStateError(
                "The native team project-key receipt could not be compensated after a local metadata failure.",
              );
            }
          } catch {
            throw securityStateError(
              "The native team project-key receipt was retained safely after local metadata persistence and compensation both failed.",
            );
          }
        }
        throw saved.error;
      }
      return Object.freeze({
        capabilityState: "persisted_team_managed_receipt",
        keyVersionDiscovery: "authoritative_team_current_metadata",
        verificationState: "verified_native_hpke",
        persistenceState: "persisted_open_ready",
        recoveryModel: "redownload_current_device_envelope",
        nativeWriteState: commit.nativeWriteState,
        receipt: saved.value,
      });
    });
  }

  public async prepareProjectKeyRotation(
    projectId: string,
    sender: DevicePublicKeyRecord,
    recipients: readonly DevicePublicKeyRecord[],
    expectedCurrentKeyVersion: number,
  ): Promise<PendingProjectRotationDisplay> {
    this.requireNativeVault();
    assertTrustedLocalSender(sender);
    const normalizedRecipients = normalizeRecipients(sender, recipients);
    const current = unwrap(
      await this.store.loadProjectKeyBundle(projectId, sender.deviceId, expectedCurrentKeyVersion),
    );
    if (current?.version.state !== "active") {
      throw securityStateError("The active project key changed before rotation.");
    }
    await this.assertCurrentNativeSender(sender);
    const keyVersion = expectedCurrentKeyVersion + 1;
    const recoveryId = this.ids.next();
    const material = await this.vault.generateProjectDataKey();
    const createdAt = this.clock.now();
    const deviceEnvelopes: DeviceProjectKeyEnvelopeContract[] = [];
    for (const recipient of normalizedRecipients) {
      const wrapped = await this.vault.wrapProjectDataKeyForDevice({
        envelopeId: this.ids.next(),
        projectId,
        keyVersion,
        senderDeviceId: sender.deviceId,
        recipientDeviceId: recipient.deviceId,
        recipientPublicKey: recipient.publicKey,
        recipientPublicKeyFingerprint: recipient.publicKeyFingerprint,
        rawProjectDataKey: material.rawProjectDataKey,
      });
      deviceEnvelopes.push({ ...wrapped, createdAt, revokedAt: null });
    }
    const recoveryKit = await this.vault.createProjectRecoveryKit({
      recoveryId,
      projectId,
      keyVersion,
      rawProjectDataKey: material.rawProjectDataKey,
    });
    unwrap(
      await this.store.beginProjectKeyRotation({
        expectedCurrentKeyVersion,
        version: {
          schemaVersion: 1,
          projectId,
          keyVersion,
          algorithm: "AES-256-GCM",
          state: "pending_confirmation",
          revision: 1,
          createdAt,
          retiredAt: null,
        },
        deviceEnvelopes,
        recoveryEnvelope: {
          ...recoveryKit.envelope,
          createdAt,
          confirmedAt: null,
          revokedAt: null,
        },
      }),
    );
    return {
      projectId,
      keyVersion,
      previousKeyVersion: expectedCurrentKeyVersion,
      deviceId: sender.deviceId,
      recipientDeviceCount: normalizedRecipients.length,
      projectKeyFingerprint: material.projectKeyFingerprint,
      recoveryCode: recoveryKit.recoveryCode,
    };
  }

  public async recoverCloudProjectKeyForLocalDevice(
    keySet: CloudProjectKeySet,
    device: DevicePublicKeyRecord,
    recoveryCode: string,
  ): Promise<OpenProjectDataKey> {
    const prepared = await this.prepareCloudProjectKeyRecoveryForLocalDevice(
      keySet,
      device,
      recoveryCode,
    );
    unwrap(await this.store.saveDeviceEnvelope(prepared.deviceEnvelope));
    return prepared.openKey;
  }

  public async prepareCloudProjectKeyRecoveryForLocalDevice(
    keySet: CloudProjectKeySet,
    device: DevicePublicKeyRecord,
    recoveryCode: string,
  ): Promise<PreparedCloudProjectKeyRecovery> {
    this.requireNativeVault();
    assertTrustedLocalSender(device);
    if (
      !["active", "retiring"].includes(keySet.version.state) ||
      keySet.recoveryEnvelope.confirmedAt === null ||
      keySet.recoveryEnvelope.revokedAt !== null
    ) {
      throw securityStateError("A confirmed cloud recovery envelope is required.");
    }
    await this.assertCurrentNativeSender(device);
    const material = await this.vault.recoverProjectDataKey(
      recoveryCode,
      withoutRecoveryLifecycle(keySet.recoveryEnvelope),
    );
    const key = await this.importVerifiedMaterial(material);
    const wrapped = await this.vault.wrapProjectDataKeyForDevice({
      envelopeId: this.ids.next(),
      projectId: keySet.projectId,
      keyVersion: keySet.keyVersion,
      senderDeviceId: device.deviceId,
      recipientDeviceId: device.deviceId,
      recipientPublicKey: device.publicKey,
      recipientPublicKeyFingerprint: device.publicKeyFingerprint,
      rawProjectDataKey: material.rawProjectDataKey,
    });
    return {
      openKey: {
        projectId: keySet.projectId,
        keyVersion: keySet.keyVersion,
        projectKeyFingerprint: material.projectKeyFingerprint,
        key,
      },
      deviceEnvelope: {
        ...wrapped,
        createdAt: this.clock.now(),
        revokedAt: null,
      },
    };
  }

  public async openCloudProjectKeyForLocalDevice(
    keySet: CloudProjectKeySet,
    device: DevicePublicKeyRecord,
  ): Promise<OpenProjectDataKey> {
    this.requireNativeVault();
    assertTrustedLocalSender(device);
    if (!["active", "retiring"].includes(keySet.version.state)) {
      throw securityStateError("The cloud project key is not available for this device.");
    }
    const envelope = keySet.deviceEnvelopes.find(
      (candidate) =>
        candidate.recipientDeviceId === device.deviceId &&
        candidate.recipientPublicKey === device.publicKey &&
        candidate.recipientPublicKeyFingerprint === device.publicKeyFingerprint &&
        candidate.revokedAt === null,
    );
    if (envelope === undefined) {
      throw securityStateError("The cloud project key does not authorize this device.");
    }
    await this.assertCurrentNativeSender(device);
    const material = await this.vault.unwrapProjectDataKeyForDevice(
      withoutDeviceLifecycle(envelope),
    );
    const key = await this.importVerifiedMaterial(material);
    return {
      projectId: keySet.projectId,
      keyVersion: keySet.keyVersion,
      projectKeyFingerprint: material.projectKeyFingerprint,
      key,
    };
  }

  public async abandonPendingProjectKeySetup(projectId: string, deviceId: string): Promise<void> {
    this.requireNativeVault();
    const bundle = unwrap(await this.store.loadProjectKeyBundle(projectId, deviceId));
    if (bundle === null) {
      throw securityStateError("Only an unconfirmed project key setup can be safely reset.");
    }
    if (
      bundle.version.state !== "pending_confirmation" ||
      bundle.recoveryEnvelope.confirmedAt !== null
    ) {
      throw securityStateError("Only an unconfirmed project key setup can be safely reset.");
    }
    unwrap(
      await this.store.abandonPendingProjectKeySetup({
        projectId,
        keyVersion: bundle.version.keyVersion,
        expectedRevision: bundle.version.revision,
      }),
    );
  }

  public async openProjectDataKeyForDevice(
    projectId: string,
    deviceId: string,
    keyVersion?: number,
    teamAuthority?: TeamProjectKeyOpenAuthority,
  ): Promise<OpenProjectDataKey> {
    this.requireNativeVault();
    const access = await this.resolveProjectKeyAccess(
      projectId,
      deviceId,
      keyVersion,
      teamAuthority?.accountId,
    );
    if (access === null) {
      throw securityStateError("The project key is not active for this device.");
    }
    let material: ProjectDataKeyMaterial;
    let openedKeyVersion: number;
    if (access.kind === "personal_recovery_backed") {
      if (!["active", "retiring"].includes(access.bundle.version.state)) {
        throw securityStateError("The project key is not active for this device.");
      }
      material = await this.vault.unwrapProjectDataKeyForDevice(
        withoutDeviceLifecycle(access.bundle.deviceEnvelope),
      );
      openedKeyVersion = access.bundle.version.keyVersion;
    } else {
      const authorityAccountId = teamAuthority?.accountId;
      const authoritySessionId = teamAuthority?.expectedSessionId;
      if (
        authorityAccountId !== access.receipt.accountId ||
        authoritySessionId === undefined ||
        (authoritySessionId !== null && !UuidV7Schema.safeParse(authoritySessionId).success)
      ) {
        throw securityStateError(
          "The active cloud account and session are required to open a team-managed project key.",
        );
      }
      const status = await this.inspectTeamManagedProjectKeyReceipt(
        access.receipt,
        authoritySessionId,
      );
      if (!status.openReady) {
        throw securityStateError(
          "The team-managed project key must be downloaded again for this device.",
        );
      }
      material = await this.vault.openStoredTeamProjectKeyReceipt({
        expectedSessionId: authoritySessionId,
        receipt: nativeTeamProjectKeyReceiptBinding(status.receipt),
      });
      openedKeyVersion = status.receipt.keyVersion;
    }
    const key = await this.importVerifiedMaterial(material);
    return {
      projectId,
      keyVersion: openedKeyVersion,
      projectKeyFingerprint: material.projectKeyFingerprint,
      key,
    };
  }

  public async resolveProjectKeyAccess(
    projectId: string,
    deviceId: string,
    keyVersion?: number,
    accountId?: string,
  ): Promise<ProjectKeyAccess | null> {
    const bundle = unwrap(await this.store.loadProjectKeyBundle(projectId, deviceId, keyVersion));
    if (bundle !== null) {
      return Object.freeze({ kind: "personal_recovery_backed", bundle });
    }
    if (accountId === undefined) {
      return null;
    }
    const receipt = unwrap(
      await this.store.loadTeamProjectKeyReceipt({
        projectId,
        accountId,
        deviceId,
        ...(keyVersion === undefined ? {} : { keyVersion }),
      }),
    );
    return receipt === null ? null : Object.freeze({ kind: "team_managed_receipt", receipt });
  }

  public async inspectTeamManagedProjectKeyReceipt(
    receipt: TeamProjectKeyReceiptMetadata,
    expectedSessionId: string | null,
  ): Promise<TeamProjectKeyReceiptOpenStatus> {
    return this.runSerializedTeamReceiptMutation(async () => {
      const status = await this.vault.inspectStoredTeamProjectKeyReceipt({
        expectedSessionId,
        receipt: nativeTeamProjectKeyReceiptBinding(receipt),
      });
      if (
        status.configured &&
        status.nativeReceiptFingerprint !== receipt.nativeReceiptFingerprint
      ) {
        throw securityValidationError(
          "The native team project-key receipt fingerprint does not match SQLite metadata.",
        );
      }
      let current = receipt;
      if (
        !status.configured &&
        (receipt.state === "active" || receipt.state === "authority_unavailable")
      ) {
        const transition: MarkTeamProjectKeyReceiptStateInput = {
          nativeStorageRef: receipt.nativeStorageRef,
          nativeReceiptFingerprint: receipt.nativeReceiptFingerprint,
          expectedState: receipt.state,
          nextState: "credential_missing",
          updatedAt: this.clock.now(),
        };
        current = unwrap(await this.store.transitionTeamProjectKeyReceiptState(transition));
      }
      return Object.freeze({
        receipt: current,
        nativeConfigured: status.configured,
        openReady: status.configured && current.state !== "credential_missing",
      });
    });
  }

  public async recoverProjectDataKey(
    projectId: string,
    deviceId: string,
    recoveryCode: string,
    keyVersion?: number,
  ): Promise<OpenProjectDataKey> {
    this.requireNativeVault();
    const bundle = unwrap(await this.store.loadProjectKeyBundle(projectId, deviceId, keyVersion));
    if (bundle === null) {
      throw securityStateError("A confirmed project recovery envelope is required.");
    }
    if (bundle.recoveryEnvelope.confirmedAt === null) {
      throw securityStateError("A confirmed project recovery envelope is required.");
    }
    const material = await this.vault.recoverProjectDataKey(
      recoveryCode,
      withoutRecoveryLifecycle(bundle.recoveryEnvelope),
    );
    const key = await this.importVerifiedMaterial(material);
    return {
      projectId,
      keyVersion: bundle.version.keyVersion,
      projectKeyFingerprint: material.projectKeyFingerprint,
      key,
    };
  }

  private async importVerifiedMaterial(material: ProjectDataKeyMaterial): Promise<CryptoKey> {
    const bytes = decodeBase64Url(material.rawProjectDataKey);
    try {
      if (bytes.byteLength !== 32) {
        throw securityValidationError("The native project data key has an invalid length.");
      }
      const fingerprint = await sha256Hex(this.cryptoProvider, bytes);
      if (fingerprint !== material.projectKeyFingerprint) {
        throw securityValidationError("The native project data key fingerprint does not match.");
      }
      return await this.cipher.importProjectDataKey(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  private async runSerializedTeamReceiptMutation<Value>(
    operation: () => Promise<Value>,
  ): Promise<Value> {
    const predecessor = this.teamReceiptMutationTail;
    let release: (() => void) | undefined;
    this.teamReceiptMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async assertCurrentNativeSender(sender: DevicePublicKeyRecord): Promise<void> {
    const identity = await this.getVerifiedLocalDeviceIdentity(sender.deviceId);
    if (identity === null) {
      throw securityStateError(
        "The operating-system credential store no longer contains the sender private key.",
      );
    }
    assertIdentityMatchesRecord(identity, sender);
  }

  private requireNativeVault(): void {
    if (!this.vault.available) {
      throw securityStateError(
        "Project key operations require the native desktop credential boundary.",
      );
    }
  }
}

function deviceRecordFromIdentity(
  identity: DeviceIdentitySummary,
  accountId: string | null,
  displayName: string,
  now: string,
): DevicePublicKeyRecord {
  return {
    schemaVersion: 1,
    deviceId: identity.deviceId,
    accountId,
    algorithm: identity.algorithm,
    publicKey: identity.publicKey,
    publicKeyFingerprint: identity.publicKeyFingerprint,
    displayName,
    keyOrigin: "local_os_credential",
    state: "trusted",
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
  };
}

function assertTrustedLocalSender(sender: DevicePublicKeyRecord): void {
  if (sender.state !== "trusted" || sender.keyOrigin !== "local_os_credential") {
    throw securityStateError(
      "A trusted local device identity is required to authorize project keys.",
    );
  }
}

function normalizeRecipients(
  sender: DevicePublicKeyRecord,
  recipients: readonly DevicePublicKeyRecord[],
): readonly DevicePublicKeyRecord[] {
  if (
    recipients.length < 1 ||
    recipients.length > 1_024 ||
    new Set(recipients.map(({ deviceId }) => deviceId)).size !== recipients.length ||
    !recipients.some(({ deviceId }) => deviceId === sender.deviceId) ||
    recipients.some(
      (recipient) =>
        recipient.state !== "trusted" ||
        recipient.accountId === null ||
        sender.accountId === null ||
        recipient.accountId !== sender.accountId,
    )
  ) {
    throw securityValidationError(
      "Project-key envelopes must cover every unique trusted account device.",
    );
  }
  return Object.freeze(
    [...recipients].sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
  );
}

function normalizeDeviceDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80 || normalized !== value) {
    throw securityValidationError(
      "The device name must contain 1 to 80 characters without outer whitespace.",
    );
  }
  return normalized;
}

function assertIdentityMatchesRecord(
  identity: DeviceIdentitySummary,
  record: DevicePublicKeyRecord,
): void {
  if (
    identity.deviceId !== record.deviceId ||
    identity.publicKey !== record.publicKey ||
    identity.publicKeyFingerprint !== record.publicKeyFingerprint
  ) {
    throw securityValidationError(
      "The operating-system device identity does not match its public metadata.",
    );
  }
}

function assertNativeDeviceIdentity(identity: DeviceIdentitySummary): void {
  const candidate = identity as unknown as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.algorithm !== "DHKEM-P256-HKDF-SHA256" ||
    candidate.privateKeyStorage !== "os_credential_store" ||
    typeof candidate.deviceId !== "string" ||
    typeof candidate.publicKey !== "string" ||
    !/^[A-Za-z0-9_-]{87}$/u.test(candidate.publicKey) ||
    typeof candidate.publicKeyFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.publicKeyFingerprint)
  ) {
    throw securityValidationError("The native device identity response is invalid.");
  }
}

function normalizeTeamRecipientTargets(
  recipients: readonly TeamProjectKeyEnvelopeRecipientTarget[],
): readonly TeamProjectKeyEnvelopeRecipientTarget[] {
  if (
    recipients.length < 1 ||
    recipients.length > 10_000 ||
    new Set(recipients.map(({ envelopeId }) => envelopeId)).size !== recipients.length ||
    new Set(recipients.map(({ deviceId }) => deviceId)).size !== recipients.length ||
    new Set(recipients.map(({ assignmentId }) => assignmentId)).size !== recipients.length
  ) {
    throw securityValidationError(
      "Team project-key recipients must be a non-empty unique snapshot.",
    );
  }
  for (const recipient of recipients) {
    if (
      !UuidV7Schema.safeParse(recipient.envelopeId).success ||
      !UuidV7Schema.safeParse(recipient.membershipId).success ||
      !UuidV7Schema.safeParse(recipient.assignmentId).success ||
      !isPositivePortableInteger(recipient.membershipRevision) ||
      !isPositivePortableInteger(recipient.assignmentRevision)
    ) {
      throw securityValidationError("A team project-key envelope identifier is invalid.");
    }
    assertProjectKeyEnvelopeIdentity(recipient);
  }
  return Object.freeze([...recipients]);
}

function assertProjectKeyEnvelopeIdentity(identity: ProjectKeyEnvelopeDeviceIdentity): void {
  if (
    identity.algorithm !== "DHKEM-P256-HKDF-SHA256" ||
    !UuidV7Schema.safeParse(identity.deviceId).success ||
    !/^[A-Za-z0-9_-]{87}$/u.test(identity.publicKey) ||
    !/^[a-f0-9]{64}$/u.test(identity.publicKeyFingerprint)
  ) {
    throw securityValidationError("A project-key recipient identity is invalid.");
  }
}

function assertProjectKeyEnvelopeIdentityMatches(
  nativeIdentity: DeviceIdentitySummary,
  expected: ProjectKeyEnvelopeDeviceIdentity,
): void {
  if (
    nativeIdentity.deviceId !== expected.deviceId ||
    nativeIdentity.algorithm !== expected.algorithm ||
    nativeIdentity.publicKey !== expected.publicKey ||
    nativeIdentity.publicKeyFingerprint !== expected.publicKeyFingerprint
  ) {
    throw securityStateError(
      "The active cloud device identity does not match the native project-key sender.",
    );
  }
}

function assertRewrappedTeamEnvelopes(
  envelopes: readonly NativeTeamProjectKeyEnvelope[],
  teamId: string,
  projectId: string,
  keyVersion: number,
  sender: ProjectKeyEnvelopeDeviceIdentity,
  recipients: readonly TeamProjectKeyEnvelopeRecipientTarget[],
): void {
  if (envelopes.length !== recipients.length) {
    throw securityValidationError(
      "The native vault returned an incomplete team project-key envelope set.",
    );
  }
  for (const [index, recipient] of recipients.entries()) {
    const envelope = envelopes[index];
    if (envelope === undefined) {
      throw securityValidationError(
        "The native vault returned an incomplete team project-key envelope set.",
      );
    }
    const candidate = envelope as unknown as Record<string, unknown>;
    if (
      candidate.schemaVersion !== 1 ||
      candidate.envelopeKind !== "team_project_member_device" ||
      candidate.algorithm !== "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM" ||
      envelope.envelopeId !== recipient.envelopeId ||
      envelope.teamId !== teamId ||
      envelope.projectId !== projectId ||
      envelope.keyVersion !== keyVersion ||
      envelope.membershipId !== recipient.membershipId ||
      envelope.membershipRevision !== recipient.membershipRevision ||
      envelope.assignmentId !== recipient.assignmentId ||
      envelope.assignmentRevision !== recipient.assignmentRevision ||
      envelope.senderDeviceId !== sender.deviceId ||
      envelope.senderPublicKey !== sender.publicKey ||
      envelope.senderPublicKeyFingerprint !== sender.publicKeyFingerprint ||
      envelope.recipientDeviceId !== recipient.deviceId ||
      envelope.recipientPublicKey !== recipient.publicKey ||
      envelope.recipientPublicKeyFingerprint !== recipient.publicKeyFingerprint ||
      !/^[A-Za-z0-9_-]{87}$/u.test(envelope.encapsulatedKey) ||
      !/^[A-Za-z0-9_-]{64}$/u.test(envelope.ciphertext)
    ) {
      throw securityValidationError(
        "The native vault returned a team project-key envelope outside the requested snapshot.",
      );
    }
  }
}

function assertNativeTeamProjectKeyReceiptCommit(
  commit: NativeTeamProjectKeyReceiptCommit,
  scope: CurrentDeviceTeamProjectKeyEnvelopeScope,
  currentDevice: ProjectKeyEnvelopeDeviceIdentity,
): void {
  const candidate = commit as unknown as Record<string, unknown>;
  const forbiddenFields = [
    "ciphertext",
    "encapsulatedKey",
    "rawProjectDataKey",
    "privateKey",
    "recoveryCode",
    "recoveryEnvelope",
  ];
  if (
    forbiddenFields.some((field) => Object.hasOwn(candidate, field)) ||
    candidate.schemaVersion !== 1 ||
    candidate.receiptKind !== "team_managed_device_envelope" ||
    commit.teamId !== scope.teamId ||
    commit.projectId !== scope.projectId ||
    commit.accountId !== scope.expectedAccountId ||
    commit.deviceId !== currentDevice.deviceId ||
    commit.recipientPublicKeyFingerprint !== currentDevice.publicKeyFingerprint ||
    !isValidKeyVersion(commit.keyVersion) ||
    !isPositivePortableInteger(commit.currentServerRevision) ||
    !IsoUtcTimestampSchema.safeParse(commit.currentKeyUpdatedAt).success ||
    !IsoUtcTimestampSchema.safeParse(commit.envelopeCreatedAt).success ||
    !UuidV7Schema.safeParse(commit.envelopeId).success ||
    !UuidV7Schema.safeParse(commit.membershipId).success ||
    !UuidV7Schema.safeParse(commit.assignmentId).success ||
    !UuidV7Schema.safeParse(commit.senderDeviceId).success ||
    !isPositivePortableInteger(commit.membershipRevision) ||
    !isPositivePortableInteger(commit.assignmentRevision) ||
    !/^[a-f0-9]{64}$/u.test(commit.senderPublicKeyFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(commit.projectKeyFingerprint) ||
    !/^[a-f0-9]{64}$/u.test(commit.nativeReceiptFingerprint) ||
    !/^team_project_key_receipt_v1_[a-f0-9]{64}$/u.test(commit.nativeStorageRef) ||
    !["created", "already_present", "updated"].includes(commit.nativeWriteState)
  ) {
    throw securityValidationError(
      "The native team project-key acceptance crossed its requested authority scope.",
    );
  }
}

function nativeTeamProjectKeyReceiptBinding(
  receipt: NativeTeamProjectKeyReceiptCommit | TeamProjectKeyReceiptMetadata,
): NativeTeamProjectKeyReceiptBinding {
  return Object.freeze({
    schemaVersion: 1,
    receiptKind: "team_managed_device_envelope",
    teamId: receipt.teamId,
    projectId: receipt.projectId,
    keyVersion: receipt.keyVersion,
    accountId: receipt.accountId,
    deviceId: receipt.deviceId,
    envelopeId: receipt.envelopeId,
    membershipId: receipt.membershipId,
    membershipRevision: receipt.membershipRevision,
    assignmentId: receipt.assignmentId,
    assignmentRevision: receipt.assignmentRevision,
    senderDeviceId: receipt.senderDeviceId,
    senderPublicKeyFingerprint: receipt.senderPublicKeyFingerprint,
    recipientPublicKeyFingerprint: receipt.recipientPublicKeyFingerprint,
    projectKeyFingerprint: receipt.projectKeyFingerprint,
    nativeStorageRef: receipt.nativeStorageRef,
    nativeReceiptFingerprint: receipt.nativeReceiptFingerprint,
    currentServerRevision: receipt.currentServerRevision,
    currentKeyUpdatedAt: receipt.currentKeyUpdatedAt,
    envelopeCreatedAt: receipt.envelopeCreatedAt,
  });
}

function assertCurrentDeviceTeamEnvelopeScope(
  scope: CurrentDeviceTeamProjectKeyEnvelopeScope,
): void {
  if (
    !UuidV7Schema.safeParse(scope.teamId).success ||
    !UuidV7Schema.safeParse(scope.projectId).success ||
    !UuidV7Schema.safeParse(scope.expectedSessionId).success ||
    !UuidV7Schema.safeParse(scope.expectedAccountId).success
  ) {
    throw securityValidationError("The current-device team project-key scope is invalid.");
  }
}

function isValidKeyVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function isPositivePortableInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function withoutDeviceLifecycle(
  envelope: ProjectKeyBundle["deviceEnvelope"],
): NativeDeviceProjectKeyEnvelope {
  return {
    schemaVersion: envelope.schemaVersion,
    algorithm: envelope.algorithm,
    envelopeId: envelope.envelopeId,
    projectId: envelope.projectId,
    keyVersion: envelope.keyVersion,
    senderDeviceId: envelope.senderDeviceId,
    senderPublicKey: envelope.senderPublicKey,
    senderPublicKeyFingerprint: envelope.senderPublicKeyFingerprint,
    recipientDeviceId: envelope.recipientDeviceId,
    recipientPublicKey: envelope.recipientPublicKey,
    recipientPublicKeyFingerprint: envelope.recipientPublicKeyFingerprint,
    encapsulatedKey: envelope.encapsulatedKey,
    ciphertext: envelope.ciphertext,
  };
}

function withoutRecoveryLifecycle(
  envelope: ProjectKeyBundle["recoveryEnvelope"],
): NativeRecoveryProjectKeyEnvelope {
  return {
    schemaVersion: envelope.schemaVersion,
    algorithm: envelope.algorithm,
    recoveryId: envelope.recoveryId,
    projectId: envelope.projectId,
    keyVersion: envelope.keyVersion,
    kdf: envelope.kdf,
    salt: envelope.salt,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    verifier: envelope.verifier,
  };
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.includes("=")) {
    throw securityValidationError("The native project data key encoding is invalid.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw securityValidationError("The native project data key encoding is invalid.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (encodeBase64Url(bytes) !== value) {
    bytes.fill(0);
    throw securityValidationError("The native project data key encoding is not canonical.");
  }
  return bytes;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(cryptoProvider: Crypto, value: Uint8Array): Promise<string> {
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function securityStateError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["OPEN_SETTINGS"],
  });
}

function securityValidationError(message: string): AppError {
  return new AppError({
    code: "VALIDATION_FAILED",
    message,
    actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
  });
}
