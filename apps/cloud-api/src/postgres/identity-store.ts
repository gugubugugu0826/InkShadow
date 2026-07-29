import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  CloudAccountRecord,
  CloudAccountState,
  CloudAuditEventRecord,
  CloudIdempotencyRecord,
  CloudPageAnchor,
  CloudSessionRecord,
  IdentityChallengeKind,
  IdentityChallengeRecord,
  IdempotencyResultKind,
  RegisteredDeviceRecord,
} from "../domain/records.js";
import type { CloudIdentityStore, CloudIdentityTransaction } from "../repository/identity-store.js";

interface AccountRow extends QueryResultRow {
  readonly account_id: string;
  readonly created_at: Date;
  readonly deletion_scheduled_for: Date | null;
  readonly email_canonical: string;
  readonly failed_login_count: number;
  readonly last_failed_login_at: Date | null;
  readonly locked_until: Date | null;
  readonly password_hash: string;
  readonly revision: string;
  readonly state: CloudAccountState;
  readonly updated_at: Date;
  readonly verified_at: Date | null;
}

interface ChallengeRow extends QueryResultRow {
  readonly account_id: string | null;
  readonly attempt_count: number;
  readonly challenge_id: string;
  readonly code_hash_sha256: string;
  readonly consumed_at: Date | null;
  readonly created_at: Date;
  readonly email_canonical: string;
  readonly expires_at: Date;
  readonly kind: IdentityChallengeKind;
  readonly notification_attempts: number;
  readonly notified_at: Date | null;
  readonly pending_password_hash: string | null;
}

interface DeviceRow extends QueryResultRow {
  readonly account_id: string;
  readonly algorithm: "DHKEM-P256-HKDF-SHA256";
  readonly client_version: string;
  readonly created_at: Date;
  readonly device_id: string;
  readonly display_name: string;
  readonly public_key: string;
  readonly public_key_fingerprint: string;
  readonly revision: string;
  readonly revoked_at: Date | null;
  readonly state: "revoked" | "trusted";
  readonly updated_at: Date;
}

interface SessionRow extends QueryResultRow {
  readonly absolute_expires_at: Date | null;
  readonly access_token_hash_sha256: string;
  readonly account_id: string;
  readonly client_version: string;
  readonly device_id: string;
  readonly expires_at: Date;
  readonly authentication_method: "password" | "oidc";
  readonly issued_at: Date;
  readonly last_seen_at: Date;
  readonly minimum_client_version: string;
  readonly refresh_expires_at: Date;
  readonly refresh_generation: number;
  readonly refresh_token_hash_sha256: string;
  readonly replaced_by_session_id: string | null;
  readonly revoked_at: Date | null;
  readonly session_id: string;
}

interface IdempotencyRow extends QueryResultRow {
  readonly actor_account_id: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly idempotency_key_hash_sha256: string;
  readonly operation_id: CloudIdempotencyRecord["operationId"];
  readonly request_hash_sha256: string;
  readonly response_snapshot: unknown;
  readonly response_status: number;
  readonly result_digest_sha256: string;
  readonly result_kind: IdempotencyResultKind;
  readonly result_resource_id: string | null;
  readonly scope_hash_sha256: string;
}

export class PostgresCloudIdentityStore implements CloudIdentityStore {
  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(
    operation: (transaction: CloudIdentityTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(new PostgresCloudIdentityTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordChallengeNotificationAttempt(
    challengeId: string,
    attemptedAt: Date,
    delivered: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE identity_challenges
       SET notification_attempts = LEAST(notification_attempts + 1, 20),
           notified_at = CASE WHEN $3 THEN COALESCE(notified_at, $2) ELSE notified_at END
       WHERE challenge_id = $1`,
      [challengeId, attemptedAt, delivered],
    );
  }
}

class PostgresCloudIdentityTransaction implements CloudIdentityTransaction {
  public constructor(private readonly client: PoolClient) {}

  public async setTenant(tenantId: string): Promise<void> {
    await this.client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [tenantId]);
  }

  public async lockIdempotency(scopeHashSha256: string): Promise<void> {
    const signedLockId = BigInt.asIntN(64, BigInt(`0x${scopeHashSha256.slice(0, 16)}`));
    await this.client.query("SELECT pg_advisory_xact_lock($1::bigint)", [signedLockId.toString()]);
  }

  public async findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null> {
    const result = await this.client.query<IdempotencyRow>(
      `SELECT *
       FROM cloud_idempotency_records
       WHERE scope_hash_sha256 = $1`,
      [scopeHashSha256],
    );
    return mapNullable(result.rows[0], mapIdempotency);
  }

  public async insertIdempotency(record: CloudIdempotencyRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_idempotency_records (
         scope_hash_sha256,
         actor_account_id,
         operation_id,
         idempotency_key_hash_sha256,
         request_hash_sha256,
         response_snapshot,
         result_kind,
         result_resource_id,
         result_digest_sha256,
         response_status,
         created_at,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.scopeHashSha256,
        record.actorAccountId,
        record.operationId,
        record.idempotencyKeyHashSha256,
        record.requestHashSha256,
        record.responseSnapshot,
        record.resultKind,
        record.resultResourceId,
        record.resultDigestSha256,
        record.responseStatus,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  public async findChallenge(
    challengeId: string,
    forUpdate = false,
  ): Promise<IdentityChallengeRecord | null> {
    const result = await this.client.query<ChallengeRow>(
      `SELECT *
       FROM identity_challenges
       WHERE challenge_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [challengeId],
    );
    return mapNullable(result.rows[0], mapChallenge);
  }

  public async insertChallenge(record: IdentityChallengeRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO identity_challenges (
         challenge_id,
         kind,
         email_canonical,
         account_id,
         pending_password_hash,
         code_hash_sha256,
         attempt_count,
         expires_at,
         consumed_at,
         notified_at,
         notification_attempts,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.challengeId,
        record.kind,
        record.emailCanonical,
        record.accountId,
        record.pendingPasswordHash,
        record.codeHashSha256,
        record.attemptCount,
        record.expiresAt,
        record.consumedAt,
        record.notifiedAt,
        record.notificationAttempts,
        record.createdAt,
      ],
    );
  }

  public async updateChallenge(record: IdentityChallengeRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE identity_challenges
       SET account_id = $2,
           pending_password_hash = $3,
           code_hash_sha256 = $4,
           attempt_count = $5,
           expires_at = $6,
           consumed_at = $7,
           notified_at = $8,
           notification_attempts = $9
       WHERE challenge_id = $1`,
      [
        record.challengeId,
        record.accountId,
        record.pendingPasswordHash,
        record.codeHashSha256,
        record.attemptCount,
        record.expiresAt,
        record.consumedAt,
        record.notifiedAt,
        record.notificationAttempts,
      ],
    );
    requireAffectedRow(result.rowCount, "identity challenge");
  }

  public async findAccountByEmail(
    emailCanonical: string,
    forUpdate = false,
  ): Promise<CloudAccountRecord | null> {
    const result = await this.client.query<AccountRow>(
      `SELECT *
       FROM cloud_accounts
       WHERE email_canonical = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [emailCanonical],
    );
    return mapNullable(result.rows[0], mapAccount);
  }

  public async findAccountById(
    accountId: string,
    forUpdate = false,
  ): Promise<CloudAccountRecord | null> {
    const result = await this.client.query<AccountRow>(
      `SELECT *
       FROM cloud_accounts
       WHERE account_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [accountId],
    );
    return mapNullable(result.rows[0], mapAccount);
  }

  public async insertAccount(record: CloudAccountRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_accounts (
         account_id,
         email_canonical,
         password_hash,
         state,
         revision,
         failed_login_count,
         last_failed_login_at,
         locked_until,
         verified_at,
         deletion_scheduled_for,
         created_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.accountId,
        record.emailCanonical,
        record.passwordHash,
        record.state,
        record.revision,
        record.failedLoginCount,
        record.lastFailedLoginAt,
        record.lockedUntil,
        record.verifiedAt,
        record.deletionScheduledFor,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  public async updateAccount(record: CloudAccountRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE cloud_accounts
       SET email_canonical = $2,
           password_hash = $3,
           state = $4,
           revision = $5,
           failed_login_count = $6,
           last_failed_login_at = $7,
           locked_until = $8,
           verified_at = $9,
           deletion_scheduled_for = $10,
           updated_at = $11
       WHERE account_id = $1`,
      [
        record.accountId,
        record.emailCanonical,
        record.passwordHash,
        record.state,
        record.revision,
        record.failedLoginCount,
        record.lastFailedLoginAt,
        record.lockedUntil,
        record.verifiedAt,
        record.deletionScheduledFor,
        record.updatedAt,
      ],
    );
    requireAffectedRow(result.rowCount, "cloud account");
  }

  public async findDeviceById(
    deviceId: string,
    forUpdate = false,
  ): Promise<RegisteredDeviceRecord | null> {
    const result = await this.client.query<DeviceRow>(
      `SELECT *
       FROM registered_devices
       WHERE device_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [deviceId],
    );
    return mapNullable(result.rows[0], mapDevice);
  }

  public async findDeviceByFingerprint(
    accountId: string,
    publicKeyFingerprint: string,
    forUpdate = false,
  ): Promise<RegisteredDeviceRecord | null> {
    const result = await this.client.query<DeviceRow>(
      `SELECT *
       FROM registered_devices
       WHERE account_id = $1
         AND public_key_fingerprint = $2${forUpdate ? " FOR UPDATE" : ""}`,
      [accountId, publicKeyFingerprint],
    );
    return mapNullable(result.rows[0], mapDevice);
  }

  public async insertDevice(record: RegisteredDeviceRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO registered_devices (
         device_id,
         account_id,
         display_name,
         algorithm,
         public_key,
         public_key_fingerprint,
         client_version,
         state,
         revision,
         created_at,
         updated_at,
         revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.deviceId,
        record.accountId,
        record.displayName,
        record.algorithm,
        record.publicKey,
        record.publicKeyFingerprint,
        record.clientVersion,
        record.state,
        record.revision,
        record.createdAt,
        record.updatedAt,
        record.revokedAt,
      ],
    );
  }

  public async updateDevice(record: RegisteredDeviceRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE registered_devices
       SET display_name = $2,
           algorithm = $3,
           public_key = $4,
           public_key_fingerprint = $5,
           client_version = $6,
           state = $7,
           revision = $8,
           updated_at = $9,
           revoked_at = $10
       WHERE device_id = $1`,
      [
        record.deviceId,
        record.displayName,
        record.algorithm,
        record.publicKey,
        record.publicKeyFingerprint,
        record.clientVersion,
        record.state,
        record.revision,
        record.updatedAt,
        record.revokedAt,
      ],
    );
    requireAffectedRow(result.rowCount, "registered device");
  }

  public async listDevices(
    accountId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly RegisteredDeviceRecord[]> {
    const result = await this.client.query<DeviceRow>(
      `SELECT *
       FROM registered_devices
       WHERE account_id = $1
         AND (
           $3::timestamptz IS NULL
           OR (created_at, device_id) < ($3::timestamptz, $4::uuid)
         )
       ORDER BY created_at DESC, device_id DESC
       LIMIT $2`,
      [accountId, limit, anchor?.createdAt ?? null, anchor?.id ?? null],
    );
    return result.rows.map(mapDevice);
  }

  public async findSessionById(
    sessionId: string,
    forUpdate = false,
  ): Promise<CloudSessionRecord | null> {
    return this.findSession("session_id", sessionId, forUpdate);
  }

  public async findSessionByAccessTokenHash(
    accessTokenHashSha256: string,
    forUpdate = false,
  ): Promise<CloudSessionRecord | null> {
    return this.findSession("access_token_hash_sha256", accessTokenHashSha256, forUpdate);
  }

  public async findSessionByRefreshTokenHash(
    refreshTokenHashSha256: string,
    forUpdate = false,
  ): Promise<CloudSessionRecord | null> {
    return this.findSession("refresh_token_hash_sha256", refreshTokenHashSha256, forUpdate);
  }

  public async insertSession(record: CloudSessionRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_sessions (
         session_id,
         account_id,
         device_id,
         client_version,
         minimum_client_version,
         access_token_hash_sha256,
         refresh_token_hash_sha256,
         refresh_generation,
         issued_at,
         expires_at,
         refresh_expires_at,
         last_seen_at,
         revoked_at,
         replaced_by_session_id,
         authentication_method,
         absolute_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
       )`,
      [
        record.sessionId,
        record.accountId,
        record.deviceId,
        record.clientVersion,
        record.minimumClientVersion,
        record.accessTokenHashSha256,
        record.refreshTokenHashSha256,
        record.refreshGeneration,
        record.issuedAt,
        record.expiresAt,
        record.refreshExpiresAt,
        record.lastSeenAt,
        record.revokedAt,
        record.replacedBySessionId,
        record.authenticationMethod ?? "password",
        record.absoluteExpiresAt ?? null,
      ],
    );
  }

  public async updateSession(record: CloudSessionRecord): Promise<void> {
    const result = await this.client.query(
      `UPDATE cloud_sessions
       SET client_version = $2,
           minimum_client_version = $3,
           access_token_hash_sha256 = $4,
           refresh_token_hash_sha256 = $5,
           refresh_generation = $6,
           expires_at = $7,
           refresh_expires_at = $8,
           last_seen_at = $9,
           revoked_at = $10,
           replaced_by_session_id = $11,
           authentication_method = $12,
           absolute_expires_at = $13
       WHERE session_id = $1`,
      [
        record.sessionId,
        record.clientVersion,
        record.minimumClientVersion,
        record.accessTokenHashSha256,
        record.refreshTokenHashSha256,
        record.refreshGeneration,
        record.expiresAt,
        record.refreshExpiresAt,
        record.lastSeenAt,
        record.revokedAt,
        record.replacedBySessionId,
        record.authenticationMethod ?? "password",
        record.absoluteExpiresAt ?? null,
      ],
    );
    requireAffectedRow(result.rowCount, "cloud session");
  }

  public async listSessions(
    accountId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudSessionRecord[]> {
    const result = await this.client.query<SessionRow>(
      `SELECT *
       FROM cloud_sessions
       WHERE account_id = $1
         AND (
           $3::timestamptz IS NULL
           OR (issued_at, session_id) < ($3::timestamptz, $4::uuid)
         )
       ORDER BY issued_at DESC, session_id DESC
       LIMIT $2`,
      [accountId, limit, anchor?.createdAt ?? null, anchor?.id ?? null],
    );
    return result.rows.map(mapSession);
  }

  public async revokeSessionsForAccount(
    accountId: string,
    revokedAt: Date,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await this.client.query(
      `UPDATE cloud_sessions
       SET revoked_at = $2
       WHERE account_id = $1
         AND revoked_at IS NULL
         AND ($3::uuid IS NULL OR session_id <> $3::uuid)`,
      [accountId, revokedAt, exceptSessionId ?? null],
    );
    return result.rowCount ?? 0;
  }

  public async revokeSessionsForDevice(deviceId: string, revokedAt: Date): Promise<number> {
    const result = await this.client.query(
      `UPDATE cloud_sessions
       SET revoked_at = $2
       WHERE device_id = $1
         AND revoked_at IS NULL`,
      [deviceId, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  public async revokeRecipientDeviceEnvelopes(
    tenantId: string,
    recipientDeviceId: string,
    revokedAt: Date,
  ): Promise<number> {
    const result = await this.client.query(
      `UPDATE device_project_key_envelopes
       SET revoked_at = $3
       WHERE tenant_id = $1
         AND recipient_device_id = $2
         AND revoked_at IS NULL`,
      [tenantId, recipientDeviceId, revokedAt],
    );
    return result.rowCount ?? 0;
  }

  public async insertAuditEvent(record: CloudAuditEventRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO cloud_audit_events (
         event_id,
         request_id,
         actor_account_id,
         actor_device_id,
         tenant_id,
         resource_type,
         resource_id,
         action,
         result,
         redacted_diff,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        record.eventId,
        record.requestId,
        record.actorAccountId,
        record.actorDeviceId,
        record.tenantId,
        record.resourceType,
        record.resourceId,
        record.action,
        record.result,
        JSON.stringify(record.redactedDiff),
        record.createdAt,
      ],
    );
  }

  private async findSession(
    column: "access_token_hash_sha256" | "refresh_token_hash_sha256" | "session_id",
    value: string,
    forUpdate: boolean,
  ): Promise<CloudSessionRecord | null> {
    const result = await this.client.query<SessionRow>(
      `SELECT *
       FROM cloud_sessions
       WHERE ${column} = $1${forUpdate ? " FOR UPDATE" : ""}`,
      [value],
    );
    return mapNullable(result.rows[0], mapSession);
  }
}

function mapAccount(row: AccountRow): CloudAccountRecord {
  return {
    accountId: row.account_id,
    createdAt: requireDate(row.created_at, "account created_at"),
    deletionScheduledFor: nullableDate(
      row.deletion_scheduled_for,
      "account deletion_scheduled_for",
    ),
    emailCanonical: row.email_canonical,
    failedLoginCount: requireSafeInteger(row.failed_login_count, "failed_login_count"),
    lastFailedLoginAt: nullableDate(row.last_failed_login_at, "last_failed_login_at"),
    lockedUntil: nullableDate(row.locked_until, "locked_until"),
    passwordHash: row.password_hash,
    revision: requireSafeInteger(row.revision, "account revision"),
    state: row.state,
    updatedAt: requireDate(row.updated_at, "account updated_at"),
    verifiedAt: nullableDate(row.verified_at, "account verified_at"),
  };
}

function mapChallenge(row: ChallengeRow): IdentityChallengeRecord {
  return {
    accountId: row.account_id,
    attemptCount: requireSafeInteger(row.attempt_count, "challenge attempt_count"),
    challengeId: row.challenge_id,
    codeHashSha256: row.code_hash_sha256,
    consumedAt: nullableDate(row.consumed_at, "challenge consumed_at"),
    createdAt: requireDate(row.created_at, "challenge created_at"),
    emailCanonical: row.email_canonical,
    expiresAt: requireDate(row.expires_at, "challenge expires_at"),
    kind: row.kind,
    notificationAttempts: requireSafeInteger(
      row.notification_attempts,
      "challenge notification_attempts",
    ),
    notifiedAt: nullableDate(row.notified_at, "challenge notified_at"),
    pendingPasswordHash: row.pending_password_hash,
  };
}

function mapDevice(row: DeviceRow): RegisteredDeviceRecord {
  return {
    accountId: row.account_id,
    algorithm: row.algorithm,
    clientVersion: row.client_version,
    createdAt: requireDate(row.created_at, "device created_at"),
    deviceId: row.device_id,
    displayName: row.display_name,
    publicKey: row.public_key,
    publicKeyFingerprint: row.public_key_fingerprint,
    revision: requireSafeInteger(row.revision, "device revision"),
    revokedAt: nullableDate(row.revoked_at, "device revoked_at"),
    state: row.state,
    updatedAt: requireDate(row.updated_at, "device updated_at"),
  };
}

function mapSession(row: SessionRow): CloudSessionRecord {
  return {
    absoluteExpiresAt: nullableDate(row.absolute_expires_at, "session absolute_expires_at"),
    accessTokenHashSha256: row.access_token_hash_sha256,
    accountId: row.account_id,
    clientVersion: row.client_version,
    deviceId: row.device_id,
    expiresAt: requireDate(row.expires_at, "session expires_at"),
    authenticationMethod: row.authentication_method,
    issuedAt: requireDate(row.issued_at, "session issued_at"),
    lastSeenAt: requireDate(row.last_seen_at, "session last_seen_at"),
    minimumClientVersion: row.minimum_client_version,
    refreshExpiresAt: requireDate(row.refresh_expires_at, "session refresh_expires_at"),
    refreshGeneration: requireSafeInteger(row.refresh_generation, "refresh_generation"),
    refreshTokenHashSha256: row.refresh_token_hash_sha256,
    replacedBySessionId: row.replaced_by_session_id,
    revokedAt: nullableDate(row.revoked_at, "session revoked_at"),
    sessionId: row.session_id,
  };
}

function mapIdempotency(row: IdempotencyRow): CloudIdempotencyRecord {
  return {
    actorAccountId: row.actor_account_id,
    createdAt: requireDate(row.created_at, "idempotency created_at"),
    expiresAt: requireDate(row.expires_at, "idempotency expires_at"),
    idempotencyKeyHashSha256: row.idempotency_key_hash_sha256,
    operationId: row.operation_id,
    requestHashSha256: row.request_hash_sha256,
    responseSnapshot: row.response_snapshot,
    responseStatus: requireSafeInteger(row.response_status, "idempotency response_status"),
    resultDigestSha256: row.result_digest_sha256,
    resultKind: row.result_kind,
    resultResourceId: row.result_resource_id,
    scopeHashSha256: row.scope_hash_sha256,
  };
}

function mapNullable<Row, Value>(
  row: Row | undefined,
  mapper: (value: Row) => Value,
): Value | null {
  return row === undefined ? null : mapper(row);
}

function requireSafeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an unsafe ${label}.`);
  }
  return parsed;
}

function requireDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return value;
}

function nullableDate(value: Date | null, label: string): Date | null {
  return value === null ? null : requireDate(value, label);
}

function requireAffectedRow(rowCount: number | null, resource: string): void {
  if (rowCount !== 1) {
    throw new Error(`Expected exactly one ${resource} row to be updated.`);
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original transaction failure remains the actionable error.
  }
}
