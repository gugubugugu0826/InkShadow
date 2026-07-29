import type { InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import type { CloudDeviceContract, CloudSessionContract } from "@inkshadow/contracts";
import { AppError, type Clock, type Result, type UuidV7Generator } from "@inkshadow/domain";
import type { AccessSqliteStore } from "@inkshadow/data/access-sqlite-store";
import type {
  DevicePublicKeyRecord,
  ProjectKeySqliteStore,
} from "@inkshadow/data/project-key-sqlite-store";

import type {
  CloudSessionCoordinator,
  ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import type { CloudSessionVaultStatus } from "./cloud-session-vault";

const PAGE_SIZE = 128;
const MAXIMUM_PAGES = 8;

type AccessPersistence = Pick<AccessSqliteStore, "saveAccountManagementMetadata">;
type ProjectKeyPersistence = Pick<
  ProjectKeySqliteStore,
  "findDevicePublicKey" | "saveDevicePublicKey"
>;

export interface CloudAccountIdentityPort {
  getStatus(): Promise<CloudSessionVaultStatus>;
  clearLocalSession(expectedSessionId: string): Promise<CloudSessionVaultStatus>;
  disableAfterReconciliationFailure(): void;
}

export interface CloudAccountManagementSnapshot {
  readonly accountId: string;
  readonly currentDeviceId: string;
  readonly currentSessionId: string;
  readonly devices: readonly CloudDeviceContract[];
  readonly sessions: readonly CloudSessionContract[];
}

export interface CloudAccountManagementOptions {
  readonly signal?: AbortSignal;
  readonly expectedAuthority?: CloudAccountManagementAuthority;
}

export interface CloudAccountManagementAuthority {
  readonly accountId: string;
  readonly deviceId: string;
  readonly devicePublicKeyFingerprint: string;
}

interface RemoteSnapshot {
  readonly devices: readonly CloudDeviceContract[];
  readonly sessions: readonly CloudSessionContract[];
}

/**
 * Reconciles bounded public device/session metadata while all bearer and
 * refresh credentials remain behind the native cloud gateway.
 */
export class CloudAccountManagementService {
  public constructor(
    private readonly api: InkShadowCloudApiClient,
    private readonly session: CloudSessionCoordinator,
    private readonly identity: CloudAccountIdentityPort,
    private readonly access: AccessPersistence,
    private readonly projectKeys: ProjectKeyPersistence,
    private readonly ids: UuidV7Generator,
    private readonly clock: Clock,
  ) {}

  public async load(
    options: CloudAccountManagementOptions = {},
  ): Promise<CloudAccountManagementSnapshot> {
    const current = await this.session.ensureReady(options);
    requireExpectedAuthority(current, options.expectedAuthority);
    const observed = await this.session.runWithSession(async (active) => {
      requireExpectedAuthority(active, options.expectedAuthority);
      return {
        active,
        remote: await this.readAllRemoteMetadata(options.signal),
      };
    }, options);
    const snapshot = validateRemoteSnapshot(observed.active, observed.remote);
    requireSnapshotAuthority(snapshot, options.expectedAuthority);
    await this.persist(snapshot);
    return snapshot;
  }

  public async revokeDevice(
    deviceId: string,
    options: CloudAccountManagementOptions = {},
  ): Promise<CloudAccountManagementSnapshot | null> {
    const current = await this.session.ensureReady(options);
    const idempotencyKey = this.ids.next();
    const outcome = await this.session.runWithSession(async () => {
      const remote = await this.readAllRemoteMetadata(options.signal);
      const before = validateRemoteSnapshot(current, remote);
      const response = await this.api.revokeDevice(deviceId, {
        idempotencyKey,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { before, revoked: response.device };
    }, options);
    const revokedAt = outcome.revoked.device.revokedAt;
    if (
      outcome.revoked.device.deviceId !== deviceId ||
      outcome.revoked.device.accountId !== current.account.accountId ||
      revokedAt === null
    ) {
      throw stateError("Cloud device revocation returned inconsistent metadata.");
    }
    const merged = validateRemoteSnapshot(
      current,
      {
        devices: replaceById(
          outcome.before.devices,
          outcome.revoked,
          ({ device }) => device.deviceId,
        ),
        sessions: outcome.before.sessions.map((session) =>
          session.deviceId === deviceId && session.revokedAt === null
            ? { ...session, revokedAt: maximumTimestamp(revokedAt, session.issuedAt) }
            : session,
        ),
      },
      true,
    );
    const revokesCurrentDevice = current.device.device.deviceId === deviceId;
    try {
      await this.persist(merged);
    } finally {
      if (revokesCurrentDevice) {
        await this.clearCurrentLocalGrant();
      }
    }
    return revokesCurrentDevice ? null : merged;
  }

  public async revokeSession(
    sessionId: string,
    options: CloudAccountManagementOptions = {},
  ): Promise<CloudAccountManagementSnapshot | null> {
    const current = await this.session.ensureReady(options);
    const idempotencyKey = this.ids.next();
    const outcome = await this.session.runWithSession(async () => {
      const remote = await this.readAllRemoteMetadata(options.signal);
      const before = validateRemoteSnapshot(current, remote);
      const target = before.sessions.find((session) => session.sessionId === sessionId);
      if (target === undefined) {
        throw stateError("The cloud session no longer exists.");
      }
      const response = await this.api.revokeSession(sessionId, {
        idempotencyKey,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { before, target, completedAt: response.completedAt };
    }, options);
    const merged = validateRemoteSnapshot(
      current,
      {
        devices: outcome.before.devices,
        sessions: replaceById(
          outcome.before.sessions,
          {
            ...outcome.target,
            revokedAt: maximumTimestamp(outcome.completedAt, outcome.target.issuedAt),
          },
          (session) => session.sessionId,
        ),
      },
      true,
    );
    const revokesCurrentSession = current.session.sessionId === sessionId;
    try {
      await this.persist(merged);
    } finally {
      if (revokesCurrentSession) {
        await this.clearCurrentLocalGrant();
      }
    }
    return revokesCurrentSession ? null : merged;
  }

  private async readAllRemoteMetadata(signal: AbortSignal | undefined): Promise<RemoteSnapshot> {
    const [devices, sessions] = await Promise.all([
      readBoundedPages(
        (cursor) =>
          this.api.listDevices({
            cursor,
            limit: PAGE_SIZE,
            ...(signal === undefined ? {} : { signal }),
          }),
        (response) => response.devices,
        (response) => response.nextCursor,
        ({ device }) => device.deviceId,
      ),
      readBoundedPages(
        (cursor) =>
          this.api.listSessions({
            cursor,
            limit: PAGE_SIZE,
            ...(signal === undefined ? {} : { signal }),
          }),
        (response) => response.sessions,
        (response) => response.nextCursor,
        (session) => session.sessionId,
      ),
    ]);
    return { devices, sessions };
  }

  private async persist(snapshot: CloudAccountManagementSnapshot): Promise<void> {
    try {
      unwrap(
        await this.access.saveAccountManagementMetadata({
          accountId: snapshot.accountId,
          devices: snapshot.devices.map(({ device }) => device),
          sessions: snapshot.sessions,
        }),
      );
      const observedAt = this.clock.now();
      for (const device of snapshot.devices) {
        const existing = unwrap(await this.projectKeys.findDevicePublicKey(device.device.deviceId));
        const next = toDevicePublicKeyRecord(device, existing, observedAt);
        unwrap(await this.projectKeys.saveDevicePublicKey(next));
      }
    } catch (cause: unknown) {
      this.identity.disableAfterReconciliationFailure();
      throw cause;
    }
  }

  private async clearCurrentLocalGrant(): Promise<void> {
    try {
      const status = await this.identity.getStatus();
      if (!status.configured || status.session === null) {
        return;
      }
      await this.identity.clearLocalSession(status.session.sessionId);
    } catch (cause: unknown) {
      this.identity.disableAfterReconciliationFailure();
      throw cause;
    }
  }
}

async function readBoundedPages<Response, Item>(
  read: (cursor: string | null) => Promise<Response>,
  items: (response: Response) => readonly Item[],
  nextCursor: (response: Response) => string | null,
  id: (item: Item) => string,
): Promise<readonly Item[]> {
  const collected: Item[] = [];
  const identifiers = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
    const response = await read(cursor);
    for (const item of items(response)) {
      const identifier = id(item);
      if (identifiers.has(identifier)) {
        throw stateError("Cloud account metadata contained a duplicate identifier.");
      }
      identifiers.add(identifier);
      collected.push(item);
    }
    const next = nextCursor(response);
    if (next === null) {
      return collected;
    }
    if (next === cursor || cursors.has(next)) {
      throw stateError("Cloud account metadata pagination did not advance.");
    }
    cursors.add(next);
    cursor = next;
  }
  throw stateError("Cloud account metadata exceeded the bounded pagination limit.");
}

function validateRemoteSnapshot(
  current: ConfiguredCloudSessionStatus,
  remote: RemoteSnapshot,
  allowCurrentRevocation = false,
): CloudAccountManagementSnapshot {
  const accountId = current.account.accountId;
  if (
    remote.devices.length === 0 ||
    remote.devices.some(({ device, publicKey }) => {
      return (
        device.accountId !== accountId ||
        publicKey.accountId !== accountId ||
        device.deviceId !== publicKey.deviceId
      );
    }) ||
    remote.sessions.some((session) => session.accountId !== accountId)
  ) {
    throw stateError("Cloud account metadata crossed its authenticated account scope.");
  }
  const deviceIds = new Set(remote.devices.map(({ device }) => device.deviceId));
  if (remote.sessions.some((session) => !deviceIds.has(session.deviceId))) {
    throw stateError("Cloud session metadata references an unknown device.");
  }
  const currentDevice = remote.devices.find(
    ({ device }) => device.deviceId === current.device.device.deviceId,
  );
  const currentSession = remote.sessions.find(
    (session) => session.sessionId === current.session.sessionId,
  );
  if (
    currentDevice === undefined ||
    currentSession === undefined ||
    (!sameValue(currentDevice, current.device) &&
      (!allowCurrentRevocation || !isRevokedDeviceTransition(current.device, currentDevice))) ||
    (!sameValue(currentSession, current.session) &&
      (!allowCurrentRevocation || !isRevokedSessionTransition(current.session, currentSession)))
  ) {
    throw stateError("Cloud account metadata does not contain the active native grant.");
  }
  return {
    accountId,
    currentDeviceId: current.device.device.deviceId,
    currentSessionId: current.session.sessionId,
    devices: Object.freeze([...remote.devices]),
    sessions: Object.freeze([...remote.sessions]),
  };
}

function isRevokedDeviceTransition(
  current: CloudDeviceContract,
  next: CloudDeviceContract,
): boolean {
  return (
    next.device.state === "revoked" &&
    next.device.revokedAt !== null &&
    next.publicKey.revokedAt === next.device.revokedAt &&
    next.revision >= current.revision &&
    next.displayName === current.displayName &&
    next.device.deviceId === current.device.deviceId &&
    next.device.accountId === current.device.accountId &&
    next.device.publicKeyFingerprint === current.device.publicKeyFingerprint &&
    next.device.createdAt === current.device.createdAt &&
    next.publicKey.publicKey === current.publicKey.publicKey &&
    next.publicKey.publicKeyFingerprint === current.publicKey.publicKeyFingerprint &&
    next.publicKey.createdAt === current.publicKey.createdAt
  );
}

function isRevokedSessionTransition(
  current: CloudSessionContract,
  next: CloudSessionContract,
): boolean {
  return (
    next.revokedAt !== null &&
    next.sessionId === current.sessionId &&
    next.accountId === current.accountId &&
    next.deviceId === current.deviceId &&
    next.clientVersion === current.clientVersion &&
    next.minimumClientVersion === current.minimumClientVersion &&
    next.issuedAt === current.issuedAt &&
    next.expiresAt === current.expiresAt
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toDevicePublicKeyRecord(
  remote: CloudDeviceContract,
  existing: DevicePublicKeyRecord | null,
  observedAt: string,
): DevicePublicKeyRecord {
  return {
    schemaVersion: 1,
    deviceId: remote.device.deviceId,
    accountId: remote.device.accountId,
    algorithm: remote.publicKey.algorithm,
    publicKey: remote.publicKey.publicKey,
    publicKeyFingerprint: remote.publicKey.publicKeyFingerprint,
    displayName: remote.displayName,
    keyOrigin: existing?.keyOrigin ?? "remote_registered",
    state:
      remote.device.state === "revoked"
        ? "revoked"
        : existing?.state === "credential_missing"
          ? "credential_missing"
          : "trusted",
    createdAt: remote.publicKey.createdAt,
    updatedAt: maximumTimestamp(
      observedAt,
      remote.publicKey.createdAt,
      existing?.updatedAt ?? remote.publicKey.createdAt,
      remote.publicKey.revokedAt ?? remote.publicKey.createdAt,
    ),
    revokedAt: remote.publicKey.revokedAt,
  };
}

function replaceById<Item>(
  values: readonly Item[],
  replacement: Item,
  id: (item: Item) => string,
): readonly Item[] {
  const target = id(replacement);
  if (!values.some((value) => id(value) === target)) {
    throw stateError("Cloud account mutation targeted metadata outside the snapshot.");
  }
  return values.map((value) => {
    if (id(value) !== target) {
      return value;
    }
    return replacement;
  });
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
    actions: ["RETRY", "REAUTHENTICATE", "USE_LOCAL"],
  });
}

function requireExpectedAuthority(
  current: ConfiguredCloudSessionStatus,
  expected: CloudAccountManagementAuthority | undefined,
): void {
  if (
    expected !== undefined &&
    (current.account.accountId !== expected.accountId ||
      current.device.device.deviceId !== expected.deviceId ||
      current.device.device.publicKeyFingerprint !== expected.devicePublicKeyFingerprint ||
      current.device.publicKey.publicKeyFingerprint !== expected.devicePublicKeyFingerprint)
  ) {
    throw accountAuthorityError(expected);
  }
}

function requireSnapshotAuthority(
  snapshot: CloudAccountManagementSnapshot,
  expected: CloudAccountManagementAuthority | undefined,
): void {
  const currentDevice = snapshot.devices.find(
    ({ device }) => device.deviceId === snapshot.currentDeviceId,
  );
  if (
    expected !== undefined &&
    (snapshot.accountId !== expected.accountId ||
      snapshot.currentDeviceId !== expected.deviceId ||
      currentDevice?.publicKey.publicKeyFingerprint !== expected.devicePublicKeyFingerprint)
  ) {
    throw accountAuthorityError(expected);
  }
}

function accountAuthorityError(expected: CloudAccountManagementAuthority): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message: "The cloud account or device changed during account metadata reconciliation.",
    actions: ["REAUTHENTICATE", "USE_LOCAL", "CONTACT_SUPPORT"],
    details: {
      operation: "CLOUD_ACCOUNT_MANAGEMENT_AUTHORITY",
      reasonCode: "CLOUD_ACCOUNT_MANAGEMENT_AUTHORITY_CHANGED",
      accountId: expected.accountId,
      deviceId: expected.deviceId,
      devicePublicKeyFingerprint: expected.devicePublicKeyFingerprint,
    },
  });
}
