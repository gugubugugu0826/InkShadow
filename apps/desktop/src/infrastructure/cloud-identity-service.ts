import type {
  CloudIdentityChallengeResponse,
  CloudMutationAcceptedResponse,
} from "@inkshadow/contracts";
import type { InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import { AppError, type Clock, type Result, type UuidV7Generator } from "@inkshadow/domain";
import type { AccessSqliteStore } from "@inkshadow/data/access-sqlite-store";
import type {
  DevicePublicKeyRecord,
  ProjectKeySqliteStore,
} from "@inkshadow/data/project-key-sqlite-store";

import type { ProjectKeyLifecycleService } from "./project-key-lifecycle";
import type { DeviceIdentitySummary } from "./project-key-vault";
import type { CloudSessionVault, CloudSessionVaultStatus } from "./cloud-session-vault";

export interface CloudIdentityCredentials {
  readonly email: string;
  readonly password: string;
}

export interface CloudIdentityLoginInput extends CloudIdentityCredentials {
  readonly deviceDisplayName: string;
}

export interface CloudIdentityVerificationInput {
  readonly challengeId: string;
  readonly code: string;
  readonly deviceDisplayName: string;
}

export interface CloudPasswordResetConfirmationInput {
  readonly challengeId: string;
  readonly code: string;
  readonly newPassword: string;
}

type AccessPersistence = Pick<
  AccessSqliteStore,
  "revokeDeviceSessionMetadata" | "saveCurrentSessionGrantMetadata" | "saveSessionMetadata"
>;
type ProjectKeyPersistence = Pick<
  ProjectKeySqliteStore,
  "findDevicePublicKey" | "listLocalDevicePublicKeys" | "saveDevicePublicKey"
>;

export class CloudIdentityService {
  private operational = true;

  public constructor(
    private readonly vault: CloudSessionVault,
    private readonly api: InkShadowCloudApiClient,
    private readonly projectSecurity: ProjectKeyLifecycleService,
    private readonly access: AccessPersistence,
    private readonly projectKeys: ProjectKeyPersistence,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
  ) {}

  public get available(): boolean {
    return this.vault.available && this.operational;
  }

  public disableAfterReconciliationFailure(): void {
    this.operational = false;
  }

  public registerIdentity(
    input: CloudIdentityCredentials,
  ): Promise<CloudIdentityChallengeResponse> {
    this.requireAvailable();
    return this.api.registerIdentity(
      {
        schemaVersion: 1,
        email: input.email,
        password: input.password,
      },
      { idempotencyKey: this.ids.next() },
    );
  }

  public requestPasswordReset(email: string): Promise<CloudIdentityChallengeResponse> {
    this.requireAvailable();
    return this.api.requestPasswordReset(
      { schemaVersion: 1, email },
      { idempotencyKey: this.ids.next() },
    );
  }

  public confirmPasswordReset(
    input: CloudPasswordResetConfirmationInput,
  ): Promise<CloudMutationAcceptedResponse> {
    this.requireAvailable();
    return this.api.confirmPasswordReset(
      {
        schemaVersion: 1,
        challengeId: input.challengeId,
        code: input.code,
        newPassword: input.newPassword,
      },
      { idempotencyKey: this.ids.next() },
    );
  }

  public async login(input: CloudIdentityLoginInput): Promise<CloudSessionVaultStatus> {
    this.requireAvailable();
    const device = await this.projectSecurity.ensureLocalDeviceIdentity({
      displayName: input.deviceDisplayName,
    });
    const status = await this.vault.login({
      email: input.email,
      password: input.password,
      deviceId: device.deviceId,
      displayName: device.displayName,
    });
    return this.commitNewSession(status, device);
  }

  public async verifyEmail(
    input: CloudIdentityVerificationInput,
  ): Promise<CloudSessionVaultStatus> {
    this.requireAvailable();
    const device = await this.projectSecurity.ensureLocalDeviceIdentity({
      displayName: input.deviceDisplayName,
    });
    const status = await this.vault.verifyEmail({
      challengeId: input.challengeId,
      code: input.code,
      deviceId: device.deviceId,
      displayName: device.displayName,
    });
    return this.commitNewSession(status, device);
  }

  public getStatus(): Promise<CloudSessionVaultStatus> {
    this.requireAvailable();
    return this.vault.getStatus();
  }

  public async reconcileLocalState(): Promise<CloudSessionVaultStatus> {
    this.requireAvailable();
    const status = await this.vault.getStatus();
    if (!status.configured) {
      requireEmptyStatus(status);
      const localDevices = unwrap(await this.projectKeys.listLocalDevicePublicKeys());
      for (const device of localDevices) {
        unwrap(
          await this.access.revokeDeviceSessionMetadata({
            deviceId: device.deviceId,
            revokedAt: maximumTimestamp(this.clock.now(), device.createdAt),
          }),
        );
      }
      return status;
    }

    requireConfiguredStatus(status);
    let verifiedIdentity: DeviceIdentitySummary;
    let existing: DevicePublicKeyRecord | null;
    try {
      const identity = await this.projectSecurity.getVerifiedLocalDeviceIdentity(
        status.device.device.deviceId,
      );
      if (identity === null) {
        throw stateError(
          "The cloud session device private key is not available in the operating-system credential store.",
        );
      }
      assertStatusMatchesNativeDevice(status, identity);
      verifiedIdentity = identity;
      existing = unwrap(await this.projectKeys.findDevicePublicKey(status.device.device.deviceId));
    } catch (cause: unknown) {
      await this.revokeOrClearFailedGrant(status.session.sessionId);
      throw cause;
    }
    const localDevice: DevicePublicKeyRecord = existing ?? {
      schemaVersion: 1,
      deviceId: verifiedIdentity.deviceId,
      accountId: status.account.accountId,
      algorithm: verifiedIdentity.algorithm,
      publicKey: verifiedIdentity.publicKey,
      publicKeyFingerprint: verifiedIdentity.publicKeyFingerprint,
      displayName: status.device.displayName,
      keyOrigin: "local_os_credential",
      state: "trusted",
      createdAt: status.device.publicKey.createdAt,
      updatedAt: maximumTimestamp(this.clock.now(), status.device.publicKey.createdAt),
      revokedAt: null,
    };
    return this.commitNewSession(status, localDevice);
  }

  public async refresh(expectedSessionId: string): Promise<CloudSessionVaultStatus> {
    this.requireAvailable();
    const status = await this.vault.refresh(expectedSessionId);
    let device: DevicePublicKeyRecord;
    try {
      device = await this.loadBoundLocalDevice(status);
    } catch (cause: unknown) {
      requireConfiguredStatus(status);
      await this.revokeOrClearFailedGrant(status.session.sessionId);
      throw cause;
    }
    return this.commitNewSession(status, device);
  }

  public async logout(expectedSessionId: string): Promise<CloudSessionVaultStatus> {
    this.requireAvailable();
    const current = await this.vault.getStatus();
    requireConfiguredStatus(current);
    if (current.session.sessionId !== expectedSessionId) {
      throw stateError("The active cloud session changed before sign-out.");
    }
    const empty = await this.vault.logout(expectedSessionId);
    requireEmptyStatus(empty);
    await this.persistLocalSessionRevocation(current);
    return empty;
  }

  public async clearLocalSession(expectedSessionId: string): Promise<CloudSessionVaultStatus> {
    this.requireAvailable();
    const current = await this.vault.getStatus();
    requireConfiguredStatus(current);
    if (current.session.sessionId !== expectedSessionId) {
      throw stateError("The active cloud session changed before local clearing.");
    }
    const empty = await this.vault.clear(expectedSessionId);
    requireEmptyStatus(empty);
    await this.persistLocalSessionRevocation(current);
    return empty;
  }

  private async commitNewSession(
    status: CloudSessionVaultStatus,
    localDevice: DevicePublicKeyRecord,
  ): Promise<CloudSessionVaultStatus> {
    requireConfiguredStatus(status);
    try {
      assertStatusMatchesLocalDevice(status, localDevice);
      const updatedAt = maximumTimestamp(
        this.clock.now(),
        localDevice.updatedAt,
        status.device.device.createdAt,
      );
      unwrap(
        await this.projectKeys.saveDevicePublicKey({
          ...localDevice,
          accountId: status.account.accountId,
          displayName: status.device.displayName,
          state: "trusted",
          updatedAt,
          revokedAt: null,
        }),
      );
      unwrap(
        await this.access.saveCurrentSessionGrantMetadata({
          account: status.account,
          device: status.device.device,
          session: status.session,
          supersededAt: maximumTimestamp(this.clock.now(), status.session.issuedAt),
        }),
      );
      return status;
    } catch (cause: unknown) {
      await this.revokeOrClearFailedGrant(status.session.sessionId);
      throw cause;
    }
  }

  private async loadBoundLocalDevice(
    status: CloudSessionVaultStatus,
  ): Promise<DevicePublicKeyRecord> {
    requireConfiguredStatus(status);
    const stored = unwrap(
      await this.projectKeys.findDevicePublicKey(status.device.device.deviceId),
    );
    if (stored === null) {
      throw stateError("The cloud session has no matching local device public-key metadata.");
    }
    assertStatusMatchesLocalDevice(status, stored);
    return stored;
  }

  private async revokeOrClearFailedGrant(sessionId: string): Promise<void> {
    try {
      requireEmptyStatus(await this.vault.logout(sessionId));
      return;
    } catch {
      // The local grant must still be removed if remote compensation is unavailable.
    }
    try {
      requireEmptyStatus(await this.vault.clear(sessionId));
    } catch {
      // Preserve the original failure while preventing any further cloud use in
      // this process when the native grant could not be proven absent.
      this.operational = false;
    }
  }

  private async persistLocalSessionRevocation(
    current: CloudSessionVaultStatus & {
      readonly configured: true;
      readonly session: NonNullable<CloudSessionVaultStatus["session"]>;
    },
  ): Promise<void> {
    try {
      unwrap(
        await this.access.saveSessionMetadata({
          ...current.session,
          revokedAt: maximumTimestamp(this.clock.now(), current.session.issuedAt),
        }),
      );
    } catch (cause: unknown) {
      this.operational = false;
      throw cause;
    }
  }

  private requireAvailable(): void {
    if (!this.available) {
      throw stateError("Cloud identity requires the native desktop credential boundary.");
    }
  }
}

function assertStatusMatchesLocalDevice(
  status: CloudSessionVaultStatus & {
    readonly configured: true;
    readonly account: NonNullable<CloudSessionVaultStatus["account"]>;
    readonly device: NonNullable<CloudSessionVaultStatus["device"]>;
    readonly session: NonNullable<CloudSessionVaultStatus["session"]>;
    readonly expiry: NonNullable<CloudSessionVaultStatus["expiry"]>;
  },
  local: DevicePublicKeyRecord,
): void {
  const remote = status.device;
  if (
    local.keyOrigin !== "local_os_credential" ||
    local.state !== "trusted" ||
    (local.accountId !== null && local.accountId !== status.account.accountId) ||
    local.deviceId !== remote.device.deviceId ||
    local.publicKey !== remote.publicKey.publicKey ||
    local.publicKeyFingerprint !== remote.publicKey.publicKeyFingerprint ||
    local.publicKeyFingerprint !== remote.device.publicKeyFingerprint
  ) {
    throw stateError("Cloud session metadata does not match the local device identity.");
  }
}

function assertStatusMatchesNativeDevice(
  status: CloudSessionVaultStatus & {
    readonly configured: true;
    readonly device: NonNullable<CloudSessionVaultStatus["device"]>;
  },
  local: DeviceIdentitySummary,
): void {
  const remote = status.device;
  if (
    local.deviceId !== remote.device.deviceId ||
    local.publicKey !== remote.publicKey.publicKey ||
    local.publicKeyFingerprint !== remote.publicKey.publicKeyFingerprint ||
    local.publicKeyFingerprint !== remote.device.publicKeyFingerprint
  ) {
    throw stateError("Cloud session metadata does not match the operating-system device identity.");
  }
}

function requireConfiguredStatus(
  status: CloudSessionVaultStatus,
): asserts status is CloudSessionVaultStatus & {
  readonly configured: true;
  readonly account: NonNullable<CloudSessionVaultStatus["account"]>;
  readonly device: NonNullable<CloudSessionVaultStatus["device"]>;
  readonly session: NonNullable<CloudSessionVaultStatus["session"]>;
  readonly expiry: NonNullable<CloudSessionVaultStatus["expiry"]>;
} {
  if (
    !status.configured ||
    status.account === null ||
    status.device === null ||
    status.session === null ||
    status.expiry === null
  ) {
    throw stateError("The native cloud gateway did not establish a complete session.");
  }
}

function requireEmptyStatus(status: CloudSessionVaultStatus): void {
  if (
    status.configured ||
    status.account !== null ||
    status.device !== null ||
    status.session !== null ||
    status.expiry !== null
  ) {
    throw stateError("The native cloud gateway did not clear the active session.");
  }
}

function maximumTimestamp(...values: readonly string[]): string {
  return values.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function stateError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["USE_LOCAL", "OPEN_SETTINGS"],
  });
}
