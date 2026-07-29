import { AccessCoreError } from "./errors.js";
import { requireIdentifier, requireIsoTimestamp } from "./validation.js";

export const CLOUD_ACCOUNT_STATES = [
  "pending_verification",
  "active",
  "locked",
  "frozen",
  "deletion_scheduled",
  "deleted",
] as const;
export type CloudAccountState = (typeof CLOUD_ACCOUNT_STATES)[number];

export interface CloudAccountSnapshot {
  readonly accountId: string;
  readonly state: CloudAccountState;
  readonly revision: number;
  readonly verifiedAt: string | null;
  readonly deletionScheduledFor: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class CloudAccount {
  private constructor(private readonly snapshot: CloudAccountSnapshot) {
    Object.freeze(snapshot);
    Object.freeze(this);
  }

  public static register(accountIdValue: string, nowValue: string): CloudAccount {
    const now = requireIsoTimestamp(nowValue, "now");
    return new CloudAccount({
      accountId: requireIdentifier(accountIdValue, "accountId"),
      state: "pending_verification",
      revision: 1,
      verifiedAt: null,
      deletionScheduledFor: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static rehydrate(snapshot: CloudAccountSnapshot): CloudAccount {
    const createdAt = requireIsoTimestamp(snapshot.createdAt, "createdAt");
    const updatedAt = requireIsoTimestamp(snapshot.updatedAt, "updatedAt");
    const verifiedAt =
      snapshot.verifiedAt === null ? null : requireIsoTimestamp(snapshot.verifiedAt, "verifiedAt");
    const deletionScheduledFor =
      snapshot.deletionScheduledFor === null
        ? null
        : requireIsoTimestamp(snapshot.deletionScheduledFor, "deletionScheduledFor");
    if (
      !CLOUD_ACCOUNT_STATES.includes(snapshot.state) ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 1 ||
      Date.parse(updatedAt) < Date.parse(createdAt) ||
      (verifiedAt !== null && Date.parse(verifiedAt) < Date.parse(createdAt)) ||
      (snapshot.state === "pending_verification") !== (verifiedAt === null) ||
      (snapshot.state === "deletion_scheduled") !== (deletionScheduledFor !== null)
    ) {
      throw validationError("Cloud account snapshot is inconsistent.");
    }
    return new CloudAccount({
      accountId: requireIdentifier(snapshot.accountId, "accountId"),
      state: snapshot.state,
      revision: snapshot.revision,
      verifiedAt,
      deletionScheduledFor,
      createdAt,
      updatedAt,
    });
  }

  public toSnapshot(): CloudAccountSnapshot {
    return { ...this.snapshot };
  }

  public verify(nowValue: string): CloudAccount {
    this.requireState("pending_verification");
    const now = this.requireMutationTime(nowValue);
    return this.with({
      state: "active",
      verifiedAt: now,
      deletionScheduledFor: null,
      updatedAt: now,
    });
  }

  public lock(nowValue: string): CloudAccount {
    this.requireState("active");
    const now = this.requireMutationTime(nowValue);
    return this.with({ state: "locked", updatedAt: now });
  }

  public unlock(nowValue: string): CloudAccount {
    this.requireState("locked");
    const now = this.requireMutationTime(nowValue);
    return this.with({ state: "active", updatedAt: now });
  }

  public freeze(nowValue: string): CloudAccount {
    this.requireState("active");
    const now = this.requireMutationTime(nowValue);
    return this.with({ state: "frozen", updatedAt: now });
  }

  public unfreeze(nowValue: string): CloudAccount {
    this.requireState("frozen");
    const now = this.requireMutationTime(nowValue);
    return this.with({ state: "active", updatedAt: now });
  }

  public scheduleDeletion(deleteAtValue: string, nowValue: string): CloudAccount {
    this.requireState("active");
    const now = this.requireMutationTime(nowValue);
    const deleteAt = requireIsoTimestamp(deleteAtValue, "deleteAt");
    if (Date.parse(deleteAt) <= Date.parse(now)) {
      throw validationError("Account deletion must be scheduled in the future.");
    }
    return this.with({
      state: "deletion_scheduled",
      deletionScheduledFor: deleteAt,
      updatedAt: now,
    });
  }

  public cancelDeletion(nowValue: string): CloudAccount {
    this.requireState("deletion_scheduled");
    const now = this.requireMutationTime(nowValue);
    return this.with({
      state: "active",
      deletionScheduledFor: null,
      updatedAt: now,
    });
  }

  public finalizeDeletion(nowValue: string): CloudAccount {
    this.requireState("deletion_scheduled");
    const now = this.requireMutationTime(nowValue);
    if (
      this.snapshot.deletionScheduledFor === null ||
      Date.parse(now) < Date.parse(this.snapshot.deletionScheduledFor)
    ) {
      throw stateError(this.snapshot.state, "finalize deletion before its scheduled time");
    }
    return this.with({
      state: "deleted",
      deletionScheduledFor: null,
      updatedAt: now,
    });
  }

  public canCreateCloudSession(): boolean {
    return this.snapshot.state === "active";
  }

  private with(
    updates: Pick<CloudAccountSnapshot, "state" | "updatedAt"> &
      Partial<Pick<CloudAccountSnapshot, "verifiedAt" | "deletionScheduledFor">>,
  ): CloudAccount {
    return CloudAccount.rehydrate({
      ...this.snapshot,
      ...updates,
      revision: this.snapshot.revision + 1,
    });
  }

  private requireState(expected: CloudAccountState): void {
    if (this.snapshot.state !== expected) {
      throw stateError(this.snapshot.state, `transition from ${expected}`);
    }
  }

  private requireMutationTime(value: string): string {
    const now = requireIsoTimestamp(value, "now");
    if (Date.parse(now) < Date.parse(this.snapshot.updatedAt)) {
      throw validationError("Account mutation time cannot move backwards.");
    }
    return now;
  }
}

export type RegisteredDeviceState = "trusted" | "revoked";

export interface RegisteredDevice {
  readonly deviceId: string;
  readonly accountId: string;
  readonly state: RegisteredDeviceState;
  readonly publicKeyFingerprint: string;
}

export type CloudSessionDecision =
  "active" | "expired" | "revoked" | "account_blocked" | "device_revoked" | "upgrade_required";

export interface CloudSessionSnapshot {
  readonly sessionId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly clientVersion: string;
  readonly minimumClientVersion: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export class CloudSession {
  private constructor(private readonly snapshot: CloudSessionSnapshot) {
    Object.freeze(snapshot);
    Object.freeze(this);
  }

  public static create(
    input: Omit<CloudSessionSnapshot, "revokedAt">,
    account: CloudAccount,
    deviceValue: RegisteredDevice,
  ): CloudSession {
    const accountSnapshot = account.toSnapshot();
    const device = normalizeDevice(deviceValue);
    if (!account.canCreateCloudSession() || accountSnapshot.accountId !== input.accountId) {
      throw stateError(accountSnapshot.state, "create cloud session");
    }
    if (
      device.state !== "trusted" ||
      device.accountId !== input.accountId ||
      device.deviceId !== input.deviceId
    ) {
      throw validationError("Cloud session device is not trusted for this account.");
    }
    const issuedAt = requireIsoTimestamp(input.issuedAt, "issuedAt");
    const expiresAt = requireIsoTimestamp(input.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= Date.parse(issuedAt)) {
      throw validationError("Cloud session expiry must follow issuance.");
    }
    return new CloudSession({
      sessionId: requireIdentifier(input.sessionId, "sessionId"),
      accountId: requireIdentifier(input.accountId, "accountId"),
      deviceId: requireIdentifier(input.deviceId, "deviceId"),
      clientVersion: normalizeVersion(input.clientVersion),
      minimumClientVersion: normalizeVersion(input.minimumClientVersion),
      issuedAt,
      expiresAt,
      revokedAt: null,
    });
  }

  public evaluate(
    nowValue: string,
    account: CloudAccount,
    deviceValue: RegisteredDevice,
  ): CloudSessionDecision {
    const now = requireIsoTimestamp(nowValue, "now");
    const accountSnapshot = account.toSnapshot();
    const device = normalizeDevice(deviceValue);
    if (this.snapshot.revokedAt !== null) {
      return "revoked";
    }
    if (Date.parse(now) >= Date.parse(this.snapshot.expiresAt)) {
      return "expired";
    }
    if (!account.canCreateCloudSession() || accountSnapshot.accountId !== this.snapshot.accountId) {
      return "account_blocked";
    }
    if (
      device.state !== "trusted" ||
      device.accountId !== this.snapshot.accountId ||
      device.deviceId !== this.snapshot.deviceId
    ) {
      return "device_revoked";
    }
    return compareVersions(this.snapshot.clientVersion, this.snapshot.minimumClientVersion) < 0
      ? "upgrade_required"
      : "active";
  }

  public revoke(nowValue: string): CloudSession {
    if (this.snapshot.revokedAt !== null) {
      return this;
    }
    const now = requireIsoTimestamp(nowValue, "now");
    if (Date.parse(now) < Date.parse(this.snapshot.issuedAt)) {
      throw validationError("Session revocation cannot precede issuance.");
    }
    return new CloudSession({ ...this.snapshot, revokedAt: now });
  }

  public toSnapshot(): CloudSessionSnapshot {
    return { ...this.snapshot };
  }
}

export interface AuthenticationThrottleSnapshot {
  readonly failureCount: number;
  readonly windowStartedAt: string | null;
  readonly lockedUntil: string | null;
}

export interface AuthenticationThrottlePolicy {
  readonly maximumFailures: number;
  readonly windowMs: number;
  readonly lockMs: number;
}

export function recordAuthenticationFailure(
  snapshotValue: AuthenticationThrottleSnapshot,
  policyValue: AuthenticationThrottlePolicy,
  nowValue: string,
): AuthenticationThrottleSnapshot {
  const snapshot = normalizeThrottle(snapshotValue);
  const policy = normalizeThrottlePolicy(policyValue);
  const now = requireIsoTimestamp(nowValue, "now");
  if (snapshot.lockedUntil !== null && Date.parse(now) < Date.parse(snapshot.lockedUntil)) {
    return snapshot;
  }
  const windowExpired =
    snapshot.windowStartedAt === null ||
    Date.parse(now) - Date.parse(snapshot.windowStartedAt) >= policy.windowMs;
  const failureCount = (windowExpired ? 0 : snapshot.failureCount) + 1;
  return Object.freeze({
    failureCount,
    windowStartedAt: windowExpired ? now : snapshot.windowStartedAt,
    lockedUntil:
      failureCount >= policy.maximumFailures
        ? new Date(Date.parse(now) + policy.lockMs).toISOString()
        : null,
  });
}

export function resetAuthenticationThrottle(): AuthenticationThrottleSnapshot {
  return Object.freeze({ failureCount: 0, windowStartedAt: null, lockedUntil: null });
}

export function isAuthenticationLocked(
  snapshotValue: AuthenticationThrottleSnapshot,
  nowValue: string,
): boolean {
  const snapshot = normalizeThrottle(snapshotValue);
  const now = requireIsoTimestamp(nowValue, "now");
  return snapshot.lockedUntil !== null && Date.parse(now) < Date.parse(snapshot.lockedUntil);
}

function normalizeDevice(value: RegisteredDevice): RegisteredDevice {
  if (!["trusted", "revoked"].includes(value.state)) {
    throw validationError("Device state is invalid.");
  }
  return {
    deviceId: requireIdentifier(value.deviceId, "deviceId"),
    accountId: requireIdentifier(value.accountId, "accountId"),
    state: value.state,
    publicKeyFingerprint: requireIdentifier(value.publicKeyFingerprint, "publicKeyFingerprint"),
  };
}

function normalizeVersion(value: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) {
    throw validationError("Client version must use major.minor.patch.");
  }
  return value;
}

function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split(".").map(Number);
  const rightParts = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function normalizeThrottle(value: AuthenticationThrottleSnapshot): AuthenticationThrottleSnapshot {
  if (!Number.isSafeInteger(value.failureCount) || value.failureCount < 0) {
    throw validationError("Authentication failure count is invalid.");
  }
  const windowStartedAt =
    value.windowStartedAt === null
      ? null
      : requireIsoTimestamp(value.windowStartedAt, "windowStartedAt");
  const lockedUntil =
    value.lockedUntil === null ? null : requireIsoTimestamp(value.lockedUntil, "lockedUntil");
  return Object.freeze({
    failureCount: value.failureCount,
    windowStartedAt,
    lockedUntil,
  });
}

function normalizeThrottlePolicy(
  value: AuthenticationThrottlePolicy,
): AuthenticationThrottlePolicy {
  if (
    !Number.isSafeInteger(value.maximumFailures) ||
    value.maximumFailures < 1 ||
    value.maximumFailures > 100 ||
    !Number.isSafeInteger(value.windowMs) ||
    value.windowMs < 1_000 ||
    !Number.isSafeInteger(value.lockMs) ||
    value.lockMs < 1_000
  ) {
    throw validationError("Authentication throttle policy is invalid.");
  }
  return value;
}

function validationError(message: string): AccessCoreError {
  return new AccessCoreError("ACCESS_VALIDATION_FAILED", message);
}

function stateError(state: string, action: string): AccessCoreError {
  return validationError(`Account state ${state} cannot ${action}.`);
}
