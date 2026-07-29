import {
  CloudAccountContractSchema,
  CloudSessionContractSchema,
  IsoUtcTimestampSchema,
  RegisteredDeviceContractSchema,
  SignedOfflineLicenseContractSchema,
  TeamMembershipContractSchema,
  UuidV7Schema,
  type CloudAccountContract,
  type CloudSessionContract,
  type RegisteredDeviceContract,
  type SignedOfflineLicenseContract,
  type TeamMembershipContract,
} from "@inkshadow/contracts";
import { AppError, err, ok, type Result } from "@inkshadow/domain";
import {
  CloudAccount,
  evaluateEntitlements,
  parseSignedOfflineLicense,
  type CloudAccountState,
  type EntitlementEvaluation,
  type ProductCapability,
  type ReleaseTier,
  type SignedOfflineLicense,
  type SubscriptionState,
} from "@inkshadow/access-core";

import type { SqlExecutor, TransactionExecutor } from "./executor.js";

export interface EntitlementHintInput {
  readonly accountId: string;
  readonly tier: ReleaseTier;
  readonly subscriptionState: SubscriptionState;
  readonly grantedCapabilities: readonly ProductCapability[];
  readonly enabledFlags: readonly string[];
  readonly observedAt: string;
}

export interface CachedEntitlementHint {
  readonly authoritative: false;
  readonly observedAt: string;
  readonly evaluation: EntitlementEvaluation;
}

export interface CachedOfflineLicense {
  readonly requiresCryptographicVerification: true;
  readonly accountId: string;
  readonly savedAt: string;
  readonly envelope: SignedOfflineLicense;
}

export interface CachedTeamMembership {
  readonly authoritative: false;
  readonly membership: TeamMembershipContract;
}

export interface LocalAccessStoreHealth {
  readonly accountsByState: Readonly<Record<CloudAccountState, number>>;
  readonly devicesByState: Readonly<Record<"trusted" | "revoked", number>>;
  readonly sessionMetadataCount: number;
  readonly revokedSessionMetadataCount: number;
  readonly entitlementHintCount: number;
  readonly offlineLicenseEnvelopeCount: number;
  readonly membershipsByState: Readonly<Record<"active" | "revoked", number>>;
}

export interface CloudSessionGrantMetadata {
  readonly account: CloudAccountContract;
  readonly device: RegisteredDeviceContract;
  readonly session: CloudSessionContract;
}

export interface CurrentCloudSessionGrantMetadata extends CloudSessionGrantMetadata {
  readonly supersededAt: string;
}

export interface RevokeDeviceSessionMetadataInput {
  readonly deviceId: string;
  readonly revokedAt: string;
}

export interface CloudAccountManagementMetadataInput {
  readonly accountId: string;
  readonly devices: readonly RegisteredDeviceContract[];
  readonly sessions: readonly CloudSessionContract[];
}

interface CountDbRow {
  count: number;
}

interface StatusCountDbRow {
  status: string;
  count: number;
}

interface CloudAccountDbRow {
  account_id: string;
  schema_version: number;
  state: string;
  revision: number;
  verified_at: string | null;
  deletion_scheduled_for: string | null;
  created_at: string;
  updated_at: string;
}

interface RegisteredDeviceDbRow {
  device_id: string;
  account_id: string;
  schema_version: number;
  state: string;
  public_key_fingerprint: string;
  created_at: string;
  revoked_at: string | null;
}

interface CloudSessionDbRow {
  session_id: string;
  account_id: string;
  device_id: string;
  schema_version: number;
  client_version: string;
  minimum_client_version: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface EntitlementDbRow {
  account_id: string;
  tier: string;
  subscription_state: string;
  granted_capabilities_json: string;
  enabled_flags_json: string;
  observed_at: string;
}

interface OfflineLicenseDbRow {
  license_id: string;
  account_id: string;
  device_id: string;
  envelope_json: string;
  saved_at: string;
}

interface TeamMembershipDbRow {
  membership_id: string;
  account_id: string;
  schema_version: number;
  tenant_id: string;
  team_id: string;
  role: string;
  state: string;
  project_ids_json: string | null;
  created_at: string;
  revoked_at: string | null;
}

export class AccessSqliteStore {
  public constructor(private readonly executor: SqlExecutor) {}

  public async health(): Promise<Result<LocalAccessStoreHealth, AppError>> {
    return attempt("ACCESS_LOCAL_HEALTH_FAILED", async () => {
      const [
        accountRows,
        deviceRows,
        sessionRows,
        revokedSessionRows,
        entitlementRows,
        licenseRows,
        membershipRows,
      ] = await Promise.all([
        this.executor.select<StatusCountDbRow>(
          `SELECT state AS status, count(*) AS count
           FROM cloud_account_snapshots
           GROUP BY state`,
        ),
        this.executor.select<StatusCountDbRow>(
          `SELECT state AS status, count(*) AS count
           FROM registered_device_snapshots
           GROUP BY state`,
        ),
        this.executor.select<CountDbRow>("SELECT count(*) AS count FROM cloud_session_snapshots"),
        this.executor.select<CountDbRow>(
          "SELECT count(*) AS count FROM cloud_session_snapshots WHERE revoked_at IS NOT NULL",
        ),
        this.executor.select<CountDbRow>("SELECT count(*) AS count FROM entitlement_cache"),
        this.executor.select<CountDbRow>("SELECT count(*) AS count FROM offline_license_envelopes"),
        this.executor.select<StatusCountDbRow>(
          `SELECT state AS status, count(*) AS count
           FROM team_membership_snapshots
           GROUP BY state`,
        ),
      ]);
      return {
        accountsByState: buildStatusCounts(
          ["pending_verification", "active", "locked", "frozen", "deletion_scheduled", "deleted"],
          accountRows,
        ),
        devicesByState: buildStatusCounts(["trusted", "revoked"], deviceRows),
        sessionMetadataCount: requireCount(sessionRows[0]?.count),
        revokedSessionMetadataCount: requireCount(revokedSessionRows[0]?.count),
        entitlementHintCount: requireCount(entitlementRows[0]?.count),
        offlineLicenseEnvelopeCount: requireCount(licenseRows[0]?.count),
        membershipsByState: buildStatusCounts(["active", "revoked"], membershipRows),
      };
    });
  }

  public async saveAccount(snapshotValue: CloudAccountContract): Promise<Result<void, AppError>> {
    return attempt("ACCESS_ACCOUNT_SAVE_FAILED", async () => {
      const snapshot = normalizeAccount(snapshotValue);
      await this.executor.transaction((transaction) => saveAccountSnapshot(transaction, snapshot));
    });
  }

  public async findAccount(
    accountIdValue: string,
  ): Promise<Result<CloudAccountContract | null, AppError>> {
    return attempt("ACCESS_ACCOUNT_READ_FAILED", async () => {
      const accountId = parseUuid(accountIdValue, "accountId");
      const row = await findAccountRow(this.executor, accountId);
      return row === null ? null : rehydrateAccount(row);
    });
  }

  public async saveDevice(
    snapshotValue: RegisteredDeviceContract,
  ): Promise<Result<void, AppError>> {
    return attempt("ACCESS_DEVICE_SAVE_FAILED", async () => {
      const snapshot = normalizeDevice(snapshotValue);
      await this.executor.transaction((transaction) => saveDeviceSnapshot(transaction, snapshot));
    });
  }

  public async findDevice(
    deviceIdValue: string,
  ): Promise<Result<RegisteredDeviceContract | null, AppError>> {
    return attempt("ACCESS_DEVICE_READ_FAILED", async () => {
      const deviceId = parseUuid(deviceIdValue, "deviceId");
      const row = await findDeviceRow(this.executor, deviceId);
      return row === null ? null : rehydrateDevice(row);
    });
  }

  public async saveSessionMetadata(
    snapshotValue: CloudSessionContract,
  ): Promise<Result<void, AppError>> {
    return attempt("ACCESS_SESSION_SAVE_FAILED", async () => {
      const snapshot = normalizeSession(snapshotValue);
      await this.executor.transaction((transaction) => saveSessionSnapshot(transaction, snapshot));
    });
  }

  public async saveSessionGrantMetadata(
    input: CloudSessionGrantMetadata,
  ): Promise<Result<void, AppError>> {
    return attempt("ACCESS_SESSION_GRANT_SAVE_FAILED", async () => {
      const account = normalizeAccount(input.account);
      const device = normalizeDevice(input.device);
      const session = normalizeSession(input.session);
      assertActiveSessionGrant(account, device, session);
      await this.executor.transaction(async (transaction) => {
        await saveAccountSnapshot(transaction, account);
        await saveDeviceSnapshot(transaction, device);
        await saveSessionSnapshot(transaction, session);
      });
    });
  }

  public async saveCurrentSessionGrantMetadata(
    input: CurrentCloudSessionGrantMetadata,
  ): Promise<Result<void, AppError>> {
    return attempt("ACCESS_CURRENT_SESSION_GRANT_SAVE_FAILED", async () => {
      const account = normalizeAccount(input.account);
      const device = normalizeDevice(input.device);
      const session = normalizeSession(input.session);
      const supersededAt = parseTimestamp(input.supersededAt, "supersededAt");
      assertActiveSessionGrant(account, device, session);
      await this.executor.transaction(async (transaction) => {
        await saveAccountSnapshot(transaction, account);
        await saveDeviceSnapshot(transaction, device);
        await revokeSupersededDeviceSessions(
          transaction,
          device.deviceId,
          session.sessionId,
          supersededAt,
        );
        await saveSessionSnapshot(transaction, session);
      });
    });
  }

  public async saveAccountManagementMetadata(
    inputValue: CloudAccountManagementMetadataInput,
  ): Promise<Result<void, AppError>> {
    return attempt("ACCESS_ACCOUNT_MANAGEMENT_SAVE_FAILED", async () => {
      const accountId = parseUuid(inputValue.accountId, "accountId");
      if (inputValue.devices.length > 1_024 || inputValue.sessions.length > 1_024) {
        throw validationError("The cloud account-management snapshot is too large.");
      }
      const devices = inputValue.devices.map(normalizeDevice);
      const sessions = inputValue.sessions.map(normalizeSession);
      if (
        new Set(devices.map(({ deviceId }) => deviceId)).size !== devices.length ||
        new Set(sessions.map(({ sessionId }) => sessionId)).size !== sessions.length ||
        devices.some((device) => device.accountId !== accountId) ||
        sessions.some((session) => session.accountId !== accountId)
      ) {
        throw validationError("The cloud account-management snapshot scope is invalid.");
      }
      const snapshotDeviceIds = new Set(devices.map(({ deviceId }) => deviceId));
      if (sessions.some((session) => !snapshotDeviceIds.has(session.deviceId))) {
        throw validationError("A cloud session references a device outside the snapshot.");
      }

      await this.executor.transaction(async (transaction) => {
        const account = await findAccountRow(transaction, accountId);
        if (account === null) {
          throw validationError("The cloud account metadata must exist before reconciliation.");
        }
        for (const device of devices) {
          await saveDeviceSnapshot(transaction, device);
        }
        for (const session of sessions) {
          await saveSessionSnapshot(transaction, session);
        }
      });
    });
  }

  public async findSessionMetadata(
    sessionIdValue: string,
  ): Promise<Result<CloudSessionContract | null, AppError>> {
    return attempt("ACCESS_SESSION_READ_FAILED", async () => {
      const sessionId = parseUuid(sessionIdValue, "sessionId");
      const row = await findSessionRow(this.executor, sessionId);
      return row === null ? null : rehydrateSession(row);
    });
  }

  public async revokeDeviceSessionMetadata(
    inputValue: RevokeDeviceSessionMetadataInput,
  ): Promise<Result<number, AppError>> {
    return attempt("ACCESS_DEVICE_SESSIONS_REVOKE_FAILED", async () => {
      const deviceId = parseUuid(inputValue.deviceId, "deviceId");
      const revokedAt = parseTimestamp(inputValue.revokedAt, "revokedAt");
      const result = await this.executor.execute(
        `UPDATE cloud_session_snapshots
         SET revoked_at = CASE
           WHEN julianday(?) < julianday(issued_at) THEN issued_at
           ELSE ?
         END
         WHERE device_id = ? AND revoked_at IS NULL`,
        [revokedAt, revokedAt, deviceId],
      );
      return result.rowsAffected;
    });
  }

  public async saveEntitlementHint(
    inputValue: EntitlementHintInput,
  ): Promise<Result<void, AppError>> {
    return attempt("ACCESS_ENTITLEMENT_HINT_SAVE_FAILED", async () => {
      const input = normalizeEntitlementHint(inputValue);
      await this.executor.execute(
        `INSERT INTO entitlement_cache (
          account_id,
          tier,
          subscription_state,
          granted_capabilities_json,
          enabled_flags_json,
          observed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          tier = excluded.tier,
          subscription_state = excluded.subscription_state,
          granted_capabilities_json = excluded.granted_capabilities_json,
          enabled_flags_json = excluded.enabled_flags_json,
          observed_at = excluded.observed_at`,
        [
          input.accountId,
          input.tier,
          input.subscriptionState,
          JSON.stringify(input.grantedCapabilities),
          JSON.stringify(input.enabledFlags),
          input.observedAt,
        ],
      );
    });
  }

  public async findEntitlementHint(
    accountIdValue: string,
  ): Promise<Result<CachedEntitlementHint | null, AppError>> {
    return attempt("ACCESS_ENTITLEMENT_HINT_READ_FAILED", async () => {
      const accountId = parseUuid(accountIdValue, "accountId");
      const rows = await this.executor.select<EntitlementDbRow>(
        `SELECT
           account_id,
           tier,
           subscription_state,
           granted_capabilities_json,
           enabled_flags_json,
           observed_at
         FROM entitlement_cache
         WHERE account_id = ?
         LIMIT 1`,
        [accountId],
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const input = normalizeEntitlementHint({
        accountId: row.account_id,
        tier: row.tier as ReleaseTier,
        subscriptionState: row.subscription_state as SubscriptionState,
        grantedCapabilities: parseJsonStringArray(
          row.granted_capabilities_json,
          "granted capabilities",
        ) as ProductCapability[],
        enabledFlags: parseJsonStringArray(row.enabled_flags_json, "enabled flags"),
        observedAt: row.observed_at,
      });
      return {
        authoritative: false,
        observedAt: input.observedAt,
        evaluation: evaluateEntitlements({
          tier: input.tier,
          subscriptionState: input.subscriptionState,
          evidence: "unverified",
          grantedCapabilities: input.grantedCapabilities,
          enabledFlags: input.enabledFlags,
        }),
      };
    });
  }

  public async saveOfflineLicenseEnvelope(input: {
    readonly accountId: string;
    readonly envelope: SignedOfflineLicenseContract;
    readonly savedAt: string;
  }): Promise<Result<void, AppError>> {
    return attempt("ACCESS_OFFLINE_LICENSE_SAVE_FAILED", async () => {
      const accountId = parseUuid(input.accountId, "accountId");
      const envelope = normalizeOfflineLicense(input.envelope);
      const savedAt = parseTimestamp(input.savedAt, "savedAt");
      await this.executor.transaction(async (transaction) => {
        const device = await findDeviceRow(transaction, envelope.payload.deviceId);
        if (device?.account_id !== accountId) {
          throw validationError("The offline license device is not registered to this account.");
        }
        const existing = await findOfflineLicenseRow(transaction, envelope.payload.licenseId);
        if (existing !== null) {
          if (
            existing.account_id !== accountId ||
            existing.device_id !== envelope.payload.deviceId ||
            JSON.stringify(normalizeOfflineLicense(JSON.parse(existing.envelope_json))) !==
              JSON.stringify(envelope)
          ) {
            throw validationError("The offline license identifier has conflicting evidence.");
          }
          return;
        }
        await transaction.execute(
          `INSERT INTO offline_license_envelopes (
            license_id,
            account_id,
            device_id,
            envelope_json,
            saved_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [
            envelope.payload.licenseId,
            accountId,
            envelope.payload.deviceId,
            JSON.stringify(envelope),
            savedAt,
          ],
        );
      });
    });
  }

  public async findOfflineLicenseEnvelope(
    licenseIdValue: string,
  ): Promise<Result<CachedOfflineLicense | null, AppError>> {
    return attempt("ACCESS_OFFLINE_LICENSE_READ_FAILED", async () => {
      const licenseId = parseUuid(licenseIdValue, "licenseId");
      const row = await findOfflineLicenseRow(this.executor, licenseId);
      if (row === null) {
        return null;
      }
      return {
        requiresCryptographicVerification: true,
        accountId: parseUuid(row.account_id, "accountId"),
        savedAt: parseTimestamp(row.saved_at, "savedAt"),
        envelope: normalizeOfflineLicense(JSON.parse(row.envelope_json)),
      };
    });
  }

  public async saveTeamMembership(
    snapshotValue: TeamMembershipContract,
  ): Promise<Result<void, AppError>> {
    return attempt("ACCESS_TEAM_MEMBERSHIP_SAVE_FAILED", async () => {
      const snapshot = normalizeTeamMembership(snapshotValue);
      await this.executor.transaction(async (transaction) => {
        const existing = await findTeamMembershipRow(transaction, snapshot.membershipId);
        if (existing !== null) {
          const current = rehydrateTeamMembership(existing);
          if (
            current.accountId !== snapshot.accountId ||
            current.tenantId !== snapshot.tenantId ||
            current.teamId !== snapshot.teamId ||
            current.createdAt !== snapshot.createdAt
          ) {
            throw validationError("Immutable team-membership metadata cannot be replaced.");
          }
          if (current.state === "revoked" && snapshot.state === "active") {
            throw concurrencyError("A revoked team membership cannot become active again.");
          }
          if (JSON.stringify(current) === JSON.stringify(snapshot)) {
            return;
          }
        }
        await transaction.execute(
          `INSERT INTO team_membership_snapshots (
            membership_id,
            account_id,
            schema_version,
            tenant_id,
            team_id,
            role,
            state,
            project_ids_json,
            created_at,
            revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(membership_id) DO UPDATE SET
            role = excluded.role,
            state = excluded.state,
            project_ids_json = excluded.project_ids_json,
            revoked_at = excluded.revoked_at`,
          [
            snapshot.membershipId,
            snapshot.accountId,
            snapshot.schemaVersion,
            snapshot.tenantId,
            snapshot.teamId,
            snapshot.role,
            snapshot.state,
            snapshot.projectIds === null ? null : JSON.stringify(snapshot.projectIds),
            snapshot.createdAt,
            snapshot.revokedAt,
          ],
        );
      });
    });
  }

  public async findTeamMembership(
    membershipIdValue: string,
  ): Promise<Result<CachedTeamMembership | null, AppError>> {
    return attempt("ACCESS_TEAM_MEMBERSHIP_READ_FAILED", async () => {
      const membershipId = parseUuid(membershipIdValue, "membershipId");
      const row = await findTeamMembershipRow(this.executor, membershipId);
      return row === null
        ? null
        : { authoritative: false, membership: rehydrateTeamMembership(row) };
    });
  }
}

async function saveAccountSnapshot(
  transaction: TransactionExecutor,
  snapshot: CloudAccountContract,
): Promise<void> {
  const existing = await findAccountRow(transaction, snapshot.accountId);
  if (existing !== null) {
    const current = rehydrateAccount(existing);
    if (current.revision > snapshot.revision) {
      throw concurrencyError("A newer cloud account snapshot is already stored.");
    }
    if (current.revision === snapshot.revision) {
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
        throw concurrencyError("The cloud account revision has conflicting metadata.");
      }
      return;
    }
    if (
      current.createdAt !== snapshot.createdAt ||
      (current.verifiedAt !== null && current.verifiedAt !== snapshot.verifiedAt)
    ) {
      throw validationError("Immutable cloud account metadata cannot be replaced.");
    }
    if (current.state === "deleted" && snapshot.state !== "deleted") {
      throw concurrencyError("A deleted cloud account cannot become active again.");
    }
  }
  await transaction.execute(
    `INSERT INTO cloud_account_snapshots (
      account_id,
      schema_version,
      state,
      revision,
      verified_at,
      deletion_scheduled_for,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      schema_version = excluded.schema_version,
      state = excluded.state,
      revision = excluded.revision,
      verified_at = excluded.verified_at,
      deletion_scheduled_for = excluded.deletion_scheduled_for,
      updated_at = excluded.updated_at`,
    [
      snapshot.accountId,
      snapshot.schemaVersion,
      snapshot.state,
      snapshot.revision,
      snapshot.verifiedAt,
      snapshot.deletionScheduledFor,
      snapshot.createdAt,
      snapshot.updatedAt,
    ],
  );
}

async function saveDeviceSnapshot(
  transaction: TransactionExecutor,
  snapshot: RegisteredDeviceContract,
): Promise<void> {
  const existing = await findDeviceRow(transaction, snapshot.deviceId);
  if (existing !== null) {
    const current = rehydrateDevice(existing);
    if (
      current.accountId !== snapshot.accountId ||
      current.createdAt !== snapshot.createdAt ||
      current.publicKeyFingerprint !== snapshot.publicKeyFingerprint
    ) {
      throw validationError("Immutable registered-device metadata cannot be replaced.");
    }
    if (current.state === "revoked" && snapshot.state === "trusted") {
      throw concurrencyError("A revoked device identifier cannot become trusted again.");
    }
    if (JSON.stringify(current) === JSON.stringify(snapshot)) {
      return;
    }
  }
  await transaction.execute(
    `INSERT INTO registered_device_snapshots (
      device_id,
      account_id,
      schema_version,
      state,
      public_key_fingerprint,
      created_at,
      revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      state = excluded.state,
      revoked_at = excluded.revoked_at`,
    [
      snapshot.deviceId,
      snapshot.accountId,
      snapshot.schemaVersion,
      snapshot.state,
      snapshot.publicKeyFingerprint,
      snapshot.createdAt,
      snapshot.revokedAt,
    ],
  );
}

async function saveSessionSnapshot(
  transaction: TransactionExecutor,
  snapshot: CloudSessionContract,
): Promise<void> {
  const existing = await findSessionRow(transaction, snapshot.sessionId);
  if (existing !== null) {
    const current = rehydrateSession(existing);
    if (
      current.accountId !== snapshot.accountId ||
      current.deviceId !== snapshot.deviceId ||
      current.clientVersion !== snapshot.clientVersion ||
      current.minimumClientVersion !== snapshot.minimumClientVersion ||
      current.issuedAt !== snapshot.issuedAt ||
      current.expiresAt !== snapshot.expiresAt
    ) {
      throw validationError("Immutable cloud-session metadata cannot be replaced.");
    }
    if (current.revokedAt !== null && snapshot.revokedAt === null) {
      throw concurrencyError("A revoked cloud session cannot become active again.");
    }
    if (JSON.stringify(current) === JSON.stringify(snapshot)) {
      return;
    }
  }
  const device = await findDeviceRow(transaction, snapshot.deviceId);
  if (
    device?.account_id !== snapshot.accountId ||
    (device.state === "revoked" && snapshot.revokedAt === null)
  ) {
    throw validationError("The session device is not trusted for this account.");
  }
  await transaction.execute(
    `INSERT INTO cloud_session_snapshots (
      session_id,
      account_id,
      device_id,
      schema_version,
      client_version,
      minimum_client_version,
      issued_at,
      expires_at,
      revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET revoked_at = excluded.revoked_at`,
    [
      snapshot.sessionId,
      snapshot.accountId,
      snapshot.deviceId,
      snapshot.schemaVersion,
      snapshot.clientVersion,
      snapshot.minimumClientVersion,
      snapshot.issuedAt,
      snapshot.expiresAt,
      snapshot.revokedAt,
    ],
  );
}

async function revokeSupersededDeviceSessions(
  transaction: TransactionExecutor,
  deviceId: string,
  currentSessionId: string,
  revokedAt: string,
): Promise<void> {
  await transaction.execute(
    `UPDATE cloud_session_snapshots
     SET revoked_at = CASE
       WHEN julianday(?) < julianday(issued_at) THEN issued_at
       ELSE ?
     END
     WHERE device_id = ?
       AND session_id <> ?
       AND revoked_at IS NULL`,
    [revokedAt, revokedAt, deviceId, currentSessionId],
  );
}

function assertActiveSessionGrant(
  account: CloudAccountContract,
  device: RegisteredDeviceContract,
  session: CloudSessionContract,
): void {
  if (
    account.state !== "active" ||
    device.state !== "trusted" ||
    session.revokedAt !== null ||
    device.accountId !== account.accountId ||
    session.accountId !== account.accountId ||
    session.deviceId !== device.deviceId
  ) {
    throw validationError("Cloud session grant metadata is internally inconsistent.");
  }
}

function normalizeAccount(value: CloudAccountContract): CloudAccountContract {
  const snapshot = parseWithSchema(CloudAccountContractSchema, value);
  try {
    CloudAccount.rehydrate({
      accountId: snapshot.accountId,
      state: snapshot.state,
      revision: snapshot.revision,
      verifiedAt: snapshot.verifiedAt,
      deletionScheduledFor: snapshot.deletionScheduledFor,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    });
  } catch {
    throw validationError("The cloud account snapshot is inconsistent.");
  }
  return snapshot;
}

function normalizeDevice(value: unknown): RegisteredDeviceContract {
  const snapshot = parseWithSchema(RegisteredDeviceContractSchema, value);
  if (
    snapshot.revokedAt !== null &&
    Date.parse(snapshot.revokedAt) < Date.parse(snapshot.createdAt)
  ) {
    throw validationError("Device revocation cannot precede registration.");
  }
  return snapshot;
}

function normalizeSession(value: unknown): CloudSessionContract {
  const snapshot = parseWithSchema(CloudSessionContractSchema, value);
  if (
    snapshot.revokedAt !== null &&
    Date.parse(snapshot.revokedAt) < Date.parse(snapshot.issuedAt)
  ) {
    throw validationError("Session revocation cannot precede issuance.");
  }
  return snapshot;
}

function normalizeTeamMembership(value: unknown): TeamMembershipContract {
  const snapshot = parseWithSchema(TeamMembershipContractSchema, value);
  if (
    snapshot.revokedAt !== null &&
    Date.parse(snapshot.revokedAt) < Date.parse(snapshot.createdAt)
  ) {
    throw validationError("Membership revocation cannot precede creation.");
  }
  return snapshot;
}

function normalizeEntitlementHint(input: EntitlementHintInput): EntitlementHintInput {
  const accountId = parseUuid(input.accountId, "accountId");
  const observedAt = parseTimestamp(input.observedAt, "observedAt");
  try {
    evaluateEntitlements({
      tier: input.tier,
      subscriptionState: input.subscriptionState,
      evidence: "unverified",
      grantedCapabilities: input.grantedCapabilities,
      enabledFlags: input.enabledFlags,
    });
  } catch {
    throw validationError("The cached entitlement hint is invalid.");
  }
  return {
    accountId,
    tier: input.tier,
    subscriptionState: input.subscriptionState,
    grantedCapabilities: [...input.grantedCapabilities].sort(),
    enabledFlags: [...input.enabledFlags].sort(),
    observedAt,
  };
}

function normalizeOfflineLicense(value: unknown): SignedOfflineLicense {
  const contract = parseWithSchema(SignedOfflineLicenseContractSchema, value);
  try {
    return parseSignedOfflineLicense(contract);
  } catch {
    throw validationError("The signed offline-license envelope is invalid.");
  }
}

async function findAccountRow(
  executor: TransactionExecutor,
  accountId: string,
): Promise<CloudAccountDbRow | null> {
  const rows = await executor.select<CloudAccountDbRow>(
    `SELECT
       account_id,
       schema_version,
       state,
       revision,
       verified_at,
       deletion_scheduled_for,
       created_at,
       updated_at
     FROM cloud_account_snapshots
     WHERE account_id = ?
     LIMIT 1`,
    [accountId],
  );
  return rows[0] ?? null;
}

function rehydrateAccount(row: CloudAccountDbRow): CloudAccountContract {
  return parseWithSchema(CloudAccountContractSchema, {
    schemaVersion: row.schema_version,
    accountId: row.account_id,
    state: row.state,
    revision: row.revision,
    verifiedAt: row.verified_at,
    deletionScheduledFor: row.deletion_scheduled_for,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function findDeviceRow(
  executor: TransactionExecutor,
  deviceId: string,
): Promise<RegisteredDeviceDbRow | null> {
  const rows = await executor.select<RegisteredDeviceDbRow>(
    `SELECT
       device_id,
       account_id,
       schema_version,
       state,
       public_key_fingerprint,
       created_at,
       revoked_at
     FROM registered_device_snapshots
     WHERE device_id = ?
     LIMIT 1`,
    [deviceId],
  );
  return rows[0] ?? null;
}

function rehydrateDevice(row: RegisteredDeviceDbRow): RegisteredDeviceContract {
  return normalizeDevice({
    schemaVersion: row.schema_version,
    deviceId: row.device_id,
    accountId: row.account_id,
    state: row.state,
    publicKeyFingerprint: row.public_key_fingerprint,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  });
}

async function findSessionRow(
  executor: TransactionExecutor,
  sessionId: string,
): Promise<CloudSessionDbRow | null> {
  const rows = await executor.select<CloudSessionDbRow>(
    `SELECT
       session_id,
       account_id,
       device_id,
       schema_version,
       client_version,
       minimum_client_version,
       issued_at,
       expires_at,
       revoked_at
     FROM cloud_session_snapshots
     WHERE session_id = ?
     LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

function rehydrateSession(row: CloudSessionDbRow): CloudSessionContract {
  return normalizeSession({
    schemaVersion: row.schema_version,
    sessionId: row.session_id,
    accountId: row.account_id,
    deviceId: row.device_id,
    clientVersion: row.client_version,
    minimumClientVersion: row.minimum_client_version,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  });
}

async function findOfflineLicenseRow(
  executor: TransactionExecutor,
  licenseId: string,
): Promise<OfflineLicenseDbRow | null> {
  const rows = await executor.select<OfflineLicenseDbRow>(
    `SELECT license_id, account_id, device_id, envelope_json, saved_at
     FROM offline_license_envelopes
     WHERE license_id = ?
     LIMIT 1`,
    [licenseId],
  );
  return rows[0] ?? null;
}

async function findTeamMembershipRow(
  executor: TransactionExecutor,
  membershipId: string,
): Promise<TeamMembershipDbRow | null> {
  const rows = await executor.select<TeamMembershipDbRow>(
    `SELECT
       membership_id,
       account_id,
       schema_version,
       tenant_id,
       team_id,
       role,
       state,
       project_ids_json,
       created_at,
       revoked_at
     FROM team_membership_snapshots
     WHERE membership_id = ?
     LIMIT 1`,
    [membershipId],
  );
  return rows[0] ?? null;
}

function rehydrateTeamMembership(row: TeamMembershipDbRow): TeamMembershipContract {
  return normalizeTeamMembership({
    schemaVersion: row.schema_version,
    membershipId: row.membership_id,
    accountId: row.account_id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    role: row.role,
    state: row.state,
    projectIds:
      row.project_ids_json === null
        ? null
        : parseJsonStringArray(row.project_ids_json, "membership project scope"),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  });
}

function parseUuid(value: string, field: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be a UUIDv7 identifier.`);
  }
  return parsed.data;
}

function parseTimestamp(value: string, field: string): string {
  const parsed = IsoUtcTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be an ISO UTC timestamp.`);
  }
  return parsed.data;
}

function parseJsonStringArray(serialized: string, label: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw repositoryCorruptionError(`Stored ${label} JSON is invalid.`);
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw repositoryCorruptionError(`Stored ${label} must be a string array.`);
  }
  return value;
}

function requireCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw repositoryCorruptionError("Stored local access counts are invalid.");
  }
  return value;
}

function buildStatusCounts<const Status extends string>(
  statuses: readonly Status[],
  rows: readonly StatusCountDbRow[],
): Readonly<Record<Status, number>> {
  const allowed = new Set<string>(statuses);
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
    Status,
    number
  >;
  for (const row of rows) {
    if (!allowed.has(row.status)) {
      throw repositoryCorruptionError("Stored local access status counts are invalid.");
    }
    counts[row.status as Status] = requireCount(row.count);
  }
  return counts;
}

function parseWithSchema<Output>(
  schema: { safeParse(value: unknown): { success: true; data: Output } | { success: false } },
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationError("The local access contract is invalid.");
  }
  return parsed.data;
}

async function attempt<Value>(
  operation: string,
  run: () => Promise<Value>,
): Promise<Result<Value, AppError>> {
  try {
    return ok(await run());
  } catch (cause: unknown) {
    if (cause instanceof AppError) {
      return err(cause);
    }
    return err(
      new AppError({
        code: "REPOSITORY_ERROR",
        message: "The local cloud-access metadata store could not complete the operation.",
        retryable: true,
        actions: ["RETRY"],
        details: {
          operation,
          causeType: cause instanceof Error ? cause.name : "UnknownError",
        },
      }),
    );
  }
}

function validationError(message: string): AppError {
  return new AppError({ code: "VALIDATION_FAILED", message });
}

function concurrencyError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY"],
  });
}

function repositoryCorruptionError(message: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message,
    actions: ["CONTACT_SUPPORT"],
    details: { operation: "ACCESS_LOCAL_RECORD_INVALID" },
  });
}
