import { isCloudClientError, type InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import {
  hashCloudProjectKeyPublication,
  type CloudProjectKeyPublicationReceipt,
  type CloudProjectKeySet,
  type DeviceProjectKeyEnvelopeContract,
} from "@inkshadow/contracts";
import type {
  CloudProjectKeyPublication,
  DevicePublicKeyRecord,
  ProjectKeyBundle,
  ProjectKeySqliteStore,
} from "@inkshadow/data/project-key-sqlite-store";
import { AppError, type Clock, type Result, type UuidV7Generator } from "@inkshadow/domain";

import type {
  CloudAccountManagementService,
  CloudAccountManagementSnapshot,
} from "./cloud-account-management-service";
import type {
  CloudSessionCoordinator,
  ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import type {
  OpenProjectDataKey,
  PendingProjectRotationDisplay,
  ProjectKeyLifecycleService,
} from "./project-key-lifecycle";

type CloudProjectKeyApi = Pick<
  InkShadowCloudApiClient,
  "getCurrentProjectKeys" | "getProjectKeys" | "getProjectState" | "publishProjectKeys"
>;
type CloudProjectKeySession = Pick<CloudSessionCoordinator, "runWithSession">;
type CloudProjectKeyAccount = Pick<CloudAccountManagementService, "load">;
type CloudProjectKeyLifecycle = Pick<
  ProjectKeyLifecycleService,
  | "confirmPendingProjectKeyForCloudPublication"
  | "createDeviceEnvelopesForExistingKey"
  | "openCloudProjectKeyForLocalDevice"
  | "openProjectDataKeyForDevice"
  | "prepareCloudProjectKeyRecoveryForLocalDevice"
  | "prepareProjectKeyRotation"
>;
type CloudProjectKeyPersistence = Pick<
  ProjectKeySqliteStore,
  | "beginCloudProjectKeyPublication"
  | "findDevicePublicKey"
  | "listDeviceEnvelopes"
  | "loadCloudProjectKeyCheckpoint"
  | "loadCloudProjectKeyPublication"
  | "loadProjectKeyBundle"
  | "markCloudProjectKeyPublicationConflicted"
  | "rebaseCloudProjectKeyPublication"
  | "resolveCloudProjectKeyPublication"
  | "saveCloudProjectKeySet"
  | "saveDeviceEnvelope"
>;

export interface CloudProjectKeyOperationOptions {
  readonly signal?: AbortSignal;
}

export type FetchCloudProjectKeyOptions = CloudProjectKeyOperationOptions;

export interface CloudProjectKeyFetchResult {
  readonly keySet: CloudProjectKeySet;
  readonly localKeyAvailable: boolean;
  readonly cloudDeviceAuthorized: boolean;
}

export interface CloudProjectKeyRecoveryResult {
  readonly keySet: CloudProjectKeySet;
  readonly openKey: OpenProjectDataKey;
  readonly localKeyAvailable: true;
  readonly cloudDeviceAuthorized: boolean;
  readonly rotationRequired: boolean;
}

export interface CloudProjectKeyPublicationEvidence {
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly devicePublicKeyFingerprint: string;
  readonly keyVersion: number;
}

export type CloudProjectKeyPublicationAuthority = CloudProjectKeyPublicationEvidence;

interface AccountKeyContext {
  readonly snapshot: CloudAccountManagementSnapshot;
  readonly currentDevice: DevicePublicKeyRecord;
  readonly trustedDevices: readonly DevicePublicKeyRecord[];
}

const PUBLICATION_CONFLICT_CODES = new Set([
  "ACCESS_FORBIDDEN",
  "IDEMPOTENCY_CONFLICT",
  "VALIDATION_FAILED",
]);

/**
 * Coordinates native project-key operations with authenticated cloud
 * publication. Every mutation is journalled before its first network call, so
 * refresh replay and process restart must reuse the exact ciphertext body and
 * idempotency key.
 */
export class CloudProjectKeyCoordinator {
  public constructor(
    private readonly api: CloudProjectKeyApi,
    private readonly session: CloudProjectKeySession,
    private readonly account: CloudProjectKeyAccount,
    private readonly lifecycle: CloudProjectKeyLifecycle,
    private readonly store: CloudProjectKeyPersistence,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
  ) {}

  public async publishInitialProjectKey(
    projectId: string,
    options: CloudProjectKeyOperationOptions = {},
  ): Promise<CloudProjectKeySet> {
    const authority = await this.freezePublicationAuthority(projectId, 1, options);
    return this.publishInitialProjectKeyInternal(projectId, options, authority);
  }

  private async publishInitialProjectKeyInternal(
    projectId: string,
    options: CloudProjectKeyOperationOptions,
    authority: CloudProjectKeyPublicationAuthority,
  ): Promise<CloudProjectKeySet> {
    const context = await this.loadAccountContext(options, authority);
    const checkpoint = unwrap(await this.store.loadCloudProjectKeyCheckpoint(projectId));
    if (checkpoint !== null) {
      throw stateError("This project already has a cloud project-key checkpoint.");
    }
    const bundle = unwrap(
      await this.store.loadProjectKeyBundle(projectId, context.currentDevice.deviceId),
    );
    if (
      bundle?.version.keyVersion !== 1 ||
      bundle.version.state !== "active" ||
      bundle.recoveryEnvelope.confirmedAt === null
    ) {
      throw stateError("A confirmed local version-one project key is required.");
    }
    const existing = unwrap(
      await this.store.loadCloudProjectKeyPublication(projectId, bundle.version.keyVersion),
    );
    if (existing !== null) {
      this.assertPublicationCanRun(existing, context.currentDevice, authority);
      return this.publish(existing, options, true, authority);
    }
    await this.assertSessionAuthority(authority, options);
    const deviceEnvelopes = await this.ensureTrustedDeviceEnvelopes(
      bundle,
      context.currentDevice,
      context.trustedDevices,
    );
    await this.assertSessionAuthority(authority, options);
    const publication = unwrap(
      await this.store.beginCloudProjectKeyPublication({
        projectId,
        keyVersion: 1,
        idempotencyKey: this.ids.next(),
        request: {
          schemaVersion: 1,
          expectedServerRevision: null,
          version: bundle.version,
          recoveryEnvelope: bundle.recoveryEnvelope,
          deviceEnvelopes: [...deviceEnvelopes],
        },
        createdAt: this.clock.now(),
      }),
    );
    return this.publish(publication, options, true, authority);
  }

  /**
   * Idempotently establishes the exact active local key as the cloud key
   * checkpoint. Existing durable publication work is resumed instead of
   * creating a second request.
   */
  public async ensureProjectKeyPublished(
    authority: CloudProjectKeyPublicationAuthority,
    options: CloudProjectKeyOperationOptions = {},
  ): Promise<CloudProjectKeyPublicationEvidence> {
    await this.assertSessionAuthority(authority, options);
    const { projectId, keyVersion } = authority;
    const checkpoint = unwrap(await this.store.loadCloudProjectKeyCheckpoint(projectId));
    if (checkpoint?.currentKeyVersion === keyVersion) {
      await this.assertSessionAuthority(authority, options);
      return publicationEvidence(authority);
    }
    if (checkpoint !== null && checkpoint.currentKeyVersion + 1 !== keyVersion) {
      throw stateError("The cloud project-key checkpoint cannot publish the requested version.");
    }
    if (checkpoint === null && keyVersion !== 1) {
      throw stateError("The initial cloud project-key publication must use version one.");
    }

    const existing = unwrap(await this.store.loadCloudProjectKeyPublication(projectId, keyVersion));
    const keySet =
      existing !== null
        ? await this.resumePublicationInternal(projectId, keyVersion, options, authority)
        : checkpoint === null
          ? await this.publishInitialProjectKeyInternal(projectId, options, authority)
          : await this.confirmAndPublishRotationInternal(projectId, undefined, options, authority);
    if (keySet.projectId !== projectId || keySet.keyVersion !== keyVersion) {
      throw stateError("Cloud project-key publication returned a different key authority.");
    }
    await this.assertSessionAuthority(authority, options);
    return publicationEvidence(authority);
  }

  public async fetchProjectKeyVersion(
    projectId: string,
    keyVersion: number,
    options: FetchCloudProjectKeyOptions = {},
  ): Promise<CloudProjectKeyFetchResult> {
    const context = await this.loadAccountContext(options);
    const keySet = await this.readExactProjectKeyVersion(projectId, keyVersion, options);
    const cloudDeviceAuthorized = hasCurrentDeviceEnvelope(keySet, context.currentDevice);
    const localKeyAvailable =
      (await this.tryOpenExistingLocalKey(keySet, context.currentDevice)) !== null;
    unwrap(await this.store.saveCloudProjectKeySet({ keySet, makeCurrent: false }));
    return {
      keySet,
      localKeyAvailable,
      cloudDeviceAuthorized,
    };
  }

  public async fetchCurrentProjectKey(
    projectId: string,
    options: FetchCloudProjectKeyOptions = {},
  ): Promise<CloudProjectKeyFetchResult> {
    const context = await this.loadAccountContext(options);
    const keySet = await this.readCurrentProjectKey(projectId, options);
    const cloudDeviceAuthorized = hasCurrentDeviceEnvelope(keySet, context.currentDevice);
    const localKeyAvailable =
      (await this.tryOpenExistingLocalKey(keySet, context.currentDevice)) !== null;
    if (localKeyAvailable) {
      unwrap(await this.store.saveCloudProjectKeySet({ keySet, makeCurrent: true }));
    }
    return {
      keySet,
      localKeyAvailable,
      cloudDeviceAuthorized,
    };
  }

  public async recoverProjectKeyVersion(
    projectId: string,
    keyVersion: number,
    recoveryCode: string | undefined,
    options: FetchCloudProjectKeyOptions = {},
  ): Promise<CloudProjectKeyRecoveryResult> {
    return this.recoverProjectKeyInternal(
      projectId,
      { kind: "exact", keyVersion },
      recoveryCode,
      options,
    );
  }

  public async recoverCurrentProjectKey(
    projectId: string,
    recoveryCode: string | undefined,
    options: FetchCloudProjectKeyOptions = {},
  ): Promise<CloudProjectKeyRecoveryResult> {
    return this.recoverProjectKeyInternal(projectId, { kind: "current" }, recoveryCode, options);
  }

  private async recoverProjectKeyInternal(
    projectId: string,
    selection: Readonly<{ kind: "current" }> | Readonly<{ kind: "exact"; keyVersion: number }>,
    recoveryCode: string | undefined,
    options: FetchCloudProjectKeyOptions,
  ): Promise<CloudProjectKeyRecoveryResult> {
    const context = await this.loadAccountContext(options);
    const keySet =
      selection.kind === "current"
        ? await this.readCurrentProjectKey(projectId, options)
        : await this.readExactProjectKeyVersion(projectId, selection.keyVersion, options);
    const cloudDeviceAuthorized = hasCurrentDeviceEnvelope(keySet, context.currentDevice);
    const storedLocalEnvelope = cloudDeviceAuthorized
      ? null
      : await this.findStoredLocalDeviceEnvelope(keySet, context.currentDevice);
    let openKey: OpenProjectDataKey;
    let localDeviceEnvelope: DeviceProjectKeyEnvelopeContract | undefined;
    if (cloudDeviceAuthorized) {
      openKey = await this.lifecycle.openCloudProjectKeyForLocalDevice(
        keySet,
        context.currentDevice,
      );
    } else if (storedLocalEnvelope !== null) {
      openKey = await this.lifecycle.openProjectDataKeyForDevice(
        projectId,
        context.currentDevice.deviceId,
        keySet.keyVersion,
      );
    } else {
      if (recoveryCode === undefined || recoveryCode.trim() === "") {
        throw stateError("The recovery code is required before this device can open the key.");
      }
      const prepared = await this.lifecycle.prepareCloudProjectKeyRecoveryForLocalDevice(
        keySet,
        context.currentDevice,
        recoveryCode,
      );
      openKey = prepared.openKey;
      localDeviceEnvelope = prepared.deviceEnvelope;
    }
    unwrap(
      await this.store.saveCloudProjectKeySet({
        keySet,
        makeCurrent: selection.kind === "current",
        ...(localDeviceEnvelope === undefined ? {} : { localDeviceEnvelope }),
      }),
    );
    return {
      keySet,
      openKey,
      localKeyAvailable: true,
      cloudDeviceAuthorized,
      rotationRequired: !cloudDeviceAuthorized,
    };
  }

  public async prepareRotation(
    projectId: string,
    options: CloudProjectKeyOperationOptions = {},
  ): Promise<PendingProjectRotationDisplay> {
    const context = await this.loadAccountContext(options);
    const checkpoint = unwrap(await this.store.loadCloudProjectKeyCheckpoint(projectId));
    if (checkpoint === null) {
      throw stateError("The initial project key must be published before rotation.");
    }
    const nextVersion = checkpoint.currentKeyVersion + 1;
    const publication = unwrap(
      await this.store.loadCloudProjectKeyPublication(projectId, nextVersion),
    );
    if (publication !== null) {
      throw stateError(
        publication.state === "conflicted"
          ? "The next project-key publication requires conflict resolution."
          : "The next project-key publication is already ready to resume.",
      );
    }
    const latest = unwrap(
      await this.store.loadProjectKeyBundle(projectId, context.currentDevice.deviceId),
    );
    if (
      latest?.version.keyVersion !== checkpoint.currentKeyVersion ||
      latest.version.state !== "active"
    ) {
      throw stateError("A pending or confirmed local rotation already exists for this project.");
    }
    return this.lifecycle.prepareProjectKeyRotation(
      projectId,
      context.currentDevice,
      context.trustedDevices,
      checkpoint.currentKeyVersion,
    );
  }

  public async confirmAndPublishRotation(
    projectId: string,
    recoveryCode: string | undefined,
    options: CloudProjectKeyOperationOptions = {},
  ): Promise<CloudProjectKeySet> {
    const checkpoint = unwrap(await this.store.loadCloudProjectKeyCheckpoint(projectId));
    if (checkpoint === null) {
      throw stateError("The initial project key must be published before rotation.");
    }
    const authority = await this.freezePublicationAuthority(
      projectId,
      checkpoint.currentKeyVersion + 1,
      options,
    );
    return this.confirmAndPublishRotationInternal(projectId, recoveryCode, options, authority);
  }

  private async confirmAndPublishRotationInternal(
    projectId: string,
    recoveryCode: string | undefined,
    options: CloudProjectKeyOperationOptions,
    authority: CloudProjectKeyPublicationAuthority,
  ): Promise<CloudProjectKeySet> {
    const context = await this.loadAccountContext(options, authority);
    const checkpoint = unwrap(await this.store.loadCloudProjectKeyCheckpoint(projectId));
    if (checkpoint === null) {
      throw stateError("The initial project key must be published before rotation.");
    }
    const nextVersion = checkpoint.currentKeyVersion + 1;
    const existing = unwrap(
      await this.store.loadCloudProjectKeyPublication(projectId, nextVersion),
    );
    if (existing !== null) {
      this.assertPublicationCanRun(existing, context.currentDevice, authority);
      return this.publish(existing, options, true, authority);
    }

    const latest = unwrap(
      await this.store.loadProjectKeyBundle(projectId, context.currentDevice.deviceId),
    );
    if (latest?.version.keyVersion !== nextVersion) {
      throw stateError("No local project-key rotation is ready for publication.");
    }
    let confirmed: ProjectKeyBundle;
    if (latest.version.state === "pending_confirmation") {
      if (recoveryCode === undefined || recoveryCode.trim() === "") {
        throw stateError("The one-time recovery code must be confirmed before publication.");
      }
      await this.assertSessionAuthority(authority, options);
      confirmed = await this.lifecycle.confirmPendingProjectKeyForCloudPublication(
        projectId,
        context.currentDevice.deviceId,
        recoveryCode,
      );
    } else if (latest.version.state === "active") {
      confirmed = latest;
    } else {
      throw stateError("The local project-key rotation is not publishable.");
    }
    await this.assertSessionAuthority(authority, options);
    const deviceEnvelopes = await this.ensureTrustedDeviceEnvelopes(
      confirmed,
      context.currentDevice,
      context.trustedDevices,
    );
    await this.assertSessionAuthority(authority, options);
    const publication = unwrap(
      await this.store.beginCloudProjectKeyPublication({
        projectId,
        keyVersion: nextVersion,
        idempotencyKey: this.ids.next(),
        request: {
          schemaVersion: 1,
          expectedServerRevision: checkpoint.serverRevision,
          version: confirmed.version,
          recoveryEnvelope: confirmed.recoveryEnvelope,
          deviceEnvelopes: [...deviceEnvelopes],
        },
        createdAt: this.clock.now(),
      }),
    );
    return this.publish(publication, options, true, authority);
  }

  public async resumePublication(
    projectId: string,
    keyVersion: number,
    options: CloudProjectKeyOperationOptions = {},
  ): Promise<CloudProjectKeySet> {
    const authority = await this.freezePublicationAuthority(projectId, keyVersion, options);
    return this.resumePublicationInternal(projectId, keyVersion, options, authority);
  }

  private async resumePublicationInternal(
    projectId: string,
    keyVersion: number,
    options: CloudProjectKeyOperationOptions,
    authority: CloudProjectKeyPublicationAuthority,
  ): Promise<CloudProjectKeySet> {
    const context = await this.loadAccountContext(options, authority);
    const publication = unwrap(
      await this.store.loadCloudProjectKeyPublication(projectId, keyVersion),
    );
    if (publication === null) {
      throw stateError("No durable cloud project-key publication is ready to resume.");
    }
    this.assertPublicationCanRun(publication, context.currentDevice, authority);
    return this.publish(publication, options, true, authority);
  }

  private async loadAccountContext(
    options: CloudProjectKeyOperationOptions,
    authority?: CloudProjectKeyPublicationAuthority,
  ): Promise<AccountKeyContext> {
    await this.assertSessionAuthority(authority, options);
    const snapshot = await this.account.load(
      authority === undefined
        ? options
        : {
            ...options,
            expectedAuthority: {
              accountId: authority.accountId,
              deviceId: authority.deviceId,
              devicePublicKeyFingerprint: authority.devicePublicKeyFingerprint,
            },
          },
    );
    const trustedIds = snapshot.devices
      .filter(({ device }) => device.state === "trusted")
      .map(({ device }) => device.deviceId)
      .sort();
    if (
      trustedIds.length === 0 ||
      !trustedIds.includes(snapshot.currentDeviceId) ||
      new Set(trustedIds).size !== trustedIds.length
    ) {
      throw stateError("The cloud account does not have a valid trusted-device set.");
    }
    const records = await Promise.all(
      trustedIds.map(async (deviceId) => {
        const record = unwrap(await this.store.findDevicePublicKey(deviceId));
        if (record?.accountId !== snapshot.accountId || record.state !== "trusted") {
          throw stateError("Trusted cloud device metadata is missing from local storage.");
        }
        return record;
      }),
    );
    const currentDevice = records.find((record) => record.deviceId === snapshot.currentDeviceId);
    if (currentDevice?.keyOrigin !== "local_os_credential") {
      throw stateError("The authenticated device is not backed by the local native identity.");
    }
    if (
      authority !== undefined &&
      (snapshot.accountId !== authority.accountId ||
        snapshot.currentDeviceId !== authority.deviceId ||
        currentDevice.publicKeyFingerprint !== authority.devicePublicKeyFingerprint)
    ) {
      throw publicationAuthorityChanged(authority);
    }
    await this.assertSessionAuthority(authority, options);
    return {
      snapshot,
      currentDevice,
      trustedDevices: Object.freeze(records),
    };
  }

  private async ensureTrustedDeviceEnvelopes(
    bundle: ProjectKeyBundle,
    currentDevice: DevicePublicKeyRecord,
    trustedDevices: readonly DevicePublicKeyRecord[],
  ): Promise<readonly DeviceProjectKeyEnvelopeContract[]> {
    const stored = unwrap(
      await this.store.listDeviceEnvelopes(bundle.version.projectId, bundle.version.keyVersion),
    );
    const byRecipient = new Map(stored.map((envelope) => [envelope.recipientDeviceId, envelope]));
    const missing = trustedDevices.filter((device) => !byRecipient.has(device.deviceId));
    if (missing.length > 0) {
      const generated = await this.lifecycle.createDeviceEnvelopesForExistingKey(
        bundle.version.projectId,
        currentDevice,
        [currentDevice, ...missing.filter((device) => device.deviceId !== currentDevice.deviceId)],
        bundle.version.keyVersion,
      );
      for (const envelope of generated) {
        if (!byRecipient.has(envelope.recipientDeviceId)) {
          unwrap(await this.store.saveDeviceEnvelope(envelope));
          byRecipient.set(envelope.recipientDeviceId, envelope);
        }
      }
    }
    const selected = trustedDevices.map((device) => {
      const envelope = byRecipient.get(device.deviceId);
      if (
        envelope?.senderDeviceId !== currentDevice.deviceId ||
        envelope.senderPublicKey !== currentDevice.publicKey ||
        envelope.senderPublicKeyFingerprint !== currentDevice.publicKeyFingerprint ||
        envelope.recipientPublicKey !== device.publicKey ||
        envelope.recipientPublicKeyFingerprint !== device.publicKeyFingerprint ||
        envelope.revokedAt !== null
      ) {
        throw stateError("The project-key envelopes do not match the current trusted-device set.");
      }
      return envelope;
    });
    return Object.freeze([...selected].sort(compareDeviceEnvelopes));
  }

  private assertPublicationCanRun(
    publication: CloudProjectKeyPublication,
    currentDevice: DevicePublicKeyRecord,
    authority: CloudProjectKeyPublicationAuthority,
  ): void {
    if (publication.state === "conflicted") {
      throw conflictError("The cloud project-key publication is parked for conflict resolution.");
    }
    const currentEnvelope = publication.request.deviceEnvelopes.find(
      (envelope) => envelope.recipientDeviceId === currentDevice.deviceId,
    );
    if (
      currentEnvelope === undefined ||
      publication.projectId !== authority.projectId ||
      publication.keyVersion !== authority.keyVersion ||
      currentDevice.accountId !== authority.accountId ||
      currentDevice.deviceId !== authority.deviceId ||
      currentDevice.publicKeyFingerprint !== authority.devicePublicKeyFingerprint ||
      publication.request.deviceEnvelopes.some(
        (envelope) =>
          envelope.senderDeviceId !== currentDevice.deviceId ||
          envelope.senderPublicKey !== currentDevice.publicKey ||
          envelope.senderPublicKeyFingerprint !== currentDevice.publicKeyFingerprint,
      )
    ) {
      throw conflictError(
        "The durable publication belongs to another authenticated device identity.",
      );
    }
  }

  private async publish(
    publication: CloudProjectKeyPublication,
    options: CloudProjectKeyOperationOptions,
    allowRebase: boolean,
    authority: CloudProjectKeyPublicationAuthority,
  ): Promise<CloudProjectKeySet> {
    let receipt: CloudProjectKeyPublicationReceipt;
    try {
      const response = await this.session.runWithSession((current) => {
        requirePublicationAuthority(current, authority);
        return this.api.publishProjectKeys(
          publication.projectId,
          publication.keyVersion,
          publication.request,
          {
            idempotencyKey: publication.idempotencyKey,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
      }, options);
      receipt = response.keySet.publication;
    } catch (cause: unknown) {
      if (isCloudClientError(cause) && cause.code === "REVISION_CONFLICT") {
        return this.reconcileRevisionConflict(publication, options, allowRebase, authority);
      }
      if (isCloudClientError(cause) && PUBLICATION_CONFLICT_CODES.has(cause.code)) {
        await this.parkPublication(publication, cause.code, options, authority);
      }
      throw cause;
    }
    return this.completePublication(
      publication,
      receipt,
      "CLOUD_PROTOCOL_MISMATCH",
      options,
      authority,
    );
  }

  private async reconcileRevisionConflict(
    publication: CloudProjectKeyPublication,
    options: CloudProjectKeyOperationOptions,
    allowRebase: boolean,
    authority: CloudProjectKeyPublicationAuthority,
  ): Promise<CloudProjectKeySet> {
    try {
      const response = await this.session.runWithSession((current) => {
        requirePublicationAuthority(current, authority);
        return this.api.getProjectKeys(publication.projectId, publication.keyVersion, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }, options);
      return await this.completePublication(
        publication,
        response.keySet.publication,
        "REVISION_CONFLICT",
        options,
        authority,
      );
    } catch (cause: unknown) {
      if (!isCloudClientError(cause) || cause.code !== "RESOURCE_NOT_FOUND") {
        throw cause;
      }
    }
    return this.reconcileMissingPublication(publication, options, allowRebase, authority);
  }

  private async completePublication(
    publication: CloudProjectKeyPublication,
    receipt: CloudProjectKeyPublicationReceipt,
    mismatchCode: string,
    options: CloudProjectKeyOperationOptions,
    authority: CloudProjectKeyPublicationAuthority,
  ): Promise<CloudProjectKeySet> {
    if (!(await receiptMatchesPublication(receipt, publication))) {
      await this.parkPublication(publication, mismatchCode, options, authority);
      throw conflictError(
        "The immutable cloud publication receipt did not match the durable request.",
      );
    }
    await this.assertSessionAuthority(authority, options);
    return unwrap(
      await this.store.resolveCloudProjectKeyPublication({
        projectId: publication.projectId,
        keyVersion: publication.keyVersion,
        idempotencyKey: publication.idempotencyKey,
        receipt,
      }),
    );
  }

  private async reconcileMissingPublication(
    publication: CloudProjectKeyPublication,
    options: CloudProjectKeyOperationOptions,
    allowRebase: boolean,
    authority: CloudProjectKeyPublicationAuthority,
  ): Promise<CloudProjectKeySet> {
    let observedCurrentPublication: CloudProjectKeyPublicationReceipt | null;
    try {
      const response = await this.session.runWithSession((current) => {
        requirePublicationAuthority(current, authority);
        return this.api.getProjectState(publication.projectId, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }, options);
      observedCurrentPublication = response.project.currentKeyPublication;
    } catch (cause: unknown) {
      if (!isCloudClientError(cause) || cause.code !== "RESOURCE_NOT_FOUND") {
        throw cause;
      }
      observedCurrentPublication = null;
    }

    if (
      observedCurrentPublication !== null &&
      (await receiptMatchesPublication(observedCurrentPublication, publication))
    ) {
      return this.completePublication(
        publication,
        observedCurrentPublication,
        "REVISION_CONFLICT",
        options,
        authority,
      );
    }

    if (allowRebase && isPublicationPredecessor(publication, observedCurrentPublication)) {
      await this.assertSessionAuthority(authority, options);
      const rebased = unwrap(
        await this.store.rebaseCloudProjectKeyPublication({
          projectId: publication.projectId,
          keyVersion: publication.keyVersion,
          idempotencyKey: publication.idempotencyKey,
          nextIdempotencyKey: this.ids.next(),
          observedCurrentPublication,
          updatedAt: this.clock.now(),
        }),
      );
      return this.publish(rebased, options, false, authority);
    }

    if (!allowRebase && isPublicationPredecessor(publication, observedCurrentPublication)) {
      throw conflictError(
        "The rebased project-key publication is still racing cloud state; it remains resumable.",
      );
    }

    await this.parkPublication(publication, "REVISION_CONFLICT", options, authority);
    throw conflictError(
      "Cloud state cannot prove that this exact project-key request was published or is safe to retry.",
    );
  }

  private async parkPublication(
    publication: CloudProjectKeyPublication,
    errorCode: string,
    options: CloudProjectKeyOperationOptions,
    authority: CloudProjectKeyPublicationAuthority,
  ): Promise<void> {
    await this.assertSessionAuthority(authority, options);
    unwrap(
      await this.store.markCloudProjectKeyPublicationConflicted({
        projectId: publication.projectId,
        keyVersion: publication.keyVersion,
        idempotencyKey: publication.idempotencyKey,
        errorCode,
        updatedAt: this.clock.now(),
      }),
    );
  }

  private async assertSessionAuthority(
    authority: CloudProjectKeyPublicationAuthority | undefined,
    options: CloudProjectKeyOperationOptions,
  ): Promise<void> {
    if (authority === undefined) {
      return;
    }
    await this.session.runWithSession((current) => {
      requirePublicationAuthority(current, authority);
      return Promise.resolve();
    }, options);
  }

  private freezePublicationAuthority(
    projectId: string,
    keyVersion: number,
    options: CloudProjectKeyOperationOptions,
  ): Promise<CloudProjectKeyPublicationAuthority> {
    return this.session.runWithSession(
      (current) =>
        Promise.resolve({
          projectId,
          accountId: current.account.accountId,
          deviceId: current.device.device.deviceId,
          devicePublicKeyFingerprint: current.device.publicKey.publicKeyFingerprint,
          keyVersion,
        }),
      options,
    );
  }

  private async readExactProjectKeyVersion(
    projectId: string,
    keyVersion: number,
    options: CloudProjectKeyOperationOptions,
  ): Promise<CloudProjectKeySet> {
    const response = await this.session.runWithSession(
      () =>
        this.api.getProjectKeys(projectId, keyVersion, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      options,
    );
    return response.keySet;
  }

  private async readCurrentProjectKey(
    projectId: string,
    options: CloudProjectKeyOperationOptions,
  ): Promise<CloudProjectKeySet> {
    const response = await this.session.runWithSession(
      () =>
        this.api.getCurrentProjectKeys(projectId, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      options,
    );
    return response.keySet;
  }

  private async tryOpenExistingLocalKey(
    keySet: CloudProjectKeySet,
    currentDevice: DevicePublicKeyRecord,
  ): Promise<OpenProjectDataKey | null> {
    if (hasCurrentDeviceEnvelope(keySet, currentDevice)) {
      try {
        return await this.lifecycle.openCloudProjectKeyForLocalDevice(keySet, currentDevice);
      } catch {
        return null;
      }
    }
    const localEnvelope = await this.findStoredLocalDeviceEnvelope(keySet, currentDevice);
    if (localEnvelope === null) {
      return null;
    }
    try {
      return await this.lifecycle.openProjectDataKeyForDevice(
        keySet.projectId,
        currentDevice.deviceId,
        keySet.keyVersion,
      );
    } catch {
      return null;
    }
  }

  private async findStoredLocalDeviceEnvelope(
    keySet: CloudProjectKeySet,
    currentDevice: DevicePublicKeyRecord,
  ): Promise<DeviceProjectKeyEnvelopeContract | null> {
    const stored = unwrap(
      await this.store.listDeviceEnvelopes(keySet.projectId, keySet.keyVersion),
    );
    return (
      stored.find(
        (envelope) =>
          envelope.recipientDeviceId === currentDevice.deviceId &&
          envelope.recipientPublicKey === currentDevice.publicKey &&
          envelope.recipientPublicKeyFingerprint === currentDevice.publicKeyFingerprint &&
          envelope.revokedAt === null,
      ) ?? null
    );
  }
}

function hasCurrentDeviceEnvelope(
  keySet: CloudProjectKeySet,
  device: DevicePublicKeyRecord,
): boolean {
  return keySet.deviceEnvelopes.some(
    (envelope) =>
      envelope.recipientDeviceId === device.deviceId &&
      envelope.recipientPublicKey === device.publicKey &&
      envelope.recipientPublicKeyFingerprint === device.publicKeyFingerprint &&
      envelope.revokedAt === null,
  );
}

async function receiptMatchesPublication(
  receipt: CloudProjectKeyPublicationReceipt,
  publication: CloudProjectKeyPublication,
): Promise<boolean> {
  const publicationRequestSha256 = await hashCloudProjectKeyPublication(
    publication.projectId,
    publication.keyVersion,
    publication.request,
  );
  return (
    receipt.projectId === publication.projectId &&
    receipt.keyVersion === publication.keyVersion &&
    receipt.serverRevision === (publication.expectedServerRevision ?? 0) + 1 &&
    receipt.publicationRequestSha256 === publicationRequestSha256
  );
}

function isPublicationPredecessor(
  publication: CloudProjectKeyPublication,
  observedCurrentPublication: CloudProjectKeyPublicationReceipt | null,
): boolean {
  if (publication.expectedServerRevision === null) {
    return publication.keyVersion === 1 && observedCurrentPublication === null;
  }
  return (
    observedCurrentPublication?.projectId === publication.projectId &&
    observedCurrentPublication.keyVersion === publication.keyVersion - 1 &&
    observedCurrentPublication.serverRevision === publication.expectedServerRevision
  );
}

function compareDeviceEnvelopes(
  left: DeviceProjectKeyEnvelopeContract,
  right: DeviceProjectKeyEnvelopeContract,
): number {
  return (
    left.recipientDeviceId.localeCompare(right.recipientDeviceId) ||
    left.envelopeId.localeCompare(right.envelopeId)
  );
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function requirePublicationAuthority(
  current: ConfiguredCloudSessionStatus,
  authority: CloudProjectKeyPublicationAuthority | undefined,
): void {
  if (authority === undefined) {
    return;
  }
  if (
    current.account.accountId !== authority.accountId ||
    current.device.device.deviceId !== authority.deviceId ||
    current.device.device.publicKeyFingerprint !== authority.devicePublicKeyFingerprint ||
    current.device.publicKey.publicKeyFingerprint !== authority.devicePublicKeyFingerprint
  ) {
    throw publicationAuthorityChanged(authority);
  }
}

function publicationEvidence(
  authority: CloudProjectKeyPublicationAuthority,
): CloudProjectKeyPublicationEvidence {
  return {
    projectId: authority.projectId,
    accountId: authority.accountId,
    deviceId: authority.deviceId,
    devicePublicKeyFingerprint: authority.devicePublicKeyFingerprint,
    keyVersion: authority.keyVersion,
  };
}

function publicationAuthorityChanged(authority: CloudProjectKeyPublicationAuthority): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message:
      "The active cloud account, device, or device public key changed during project-key publication.",
    actions: ["REAUTHENTICATE", "USE_LOCAL", "CONTACT_SUPPORT"],
    details: {
      operation: "CLOUD_PROJECT_KEY_PUBLICATION_AUTHORITY",
      reasonCode: "CLOUD_PROJECT_KEY_PUBLICATION_AUTHORITY_CHANGED",
      projectId: authority.projectId,
      accountId: authority.accountId,
      deviceId: authority.deviceId,
      devicePublicKeyFingerprint: authority.devicePublicKeyFingerprint,
      keyVersion: authority.keyVersion,
    },
  });
}

function stateError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY", "USE_LOCAL"],
  });
}

function conflictError(message: string): AppError {
  return new AppError({
    code: "VERSION_CONFLICT",
    message,
    actions: ["RESOLVE_CONFLICT", "USE_LOCAL", "CONTACT_SUPPORT"],
  });
}
