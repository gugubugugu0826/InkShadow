import type {
  CloudAccountRecord,
  CloudAuditEventRecord,
  CloudIdempotencyRecord,
  CloudPageAnchor,
  CloudSessionRecord,
  IdentityChallengeRecord,
  RegisteredDeviceRecord,
} from "../domain/records.js";

export interface CloudIdentityTransaction {
  setTenant(tenantId: string): Promise<void>;
  lockIdempotency(scopeHashSha256: string): Promise<void>;
  findIdempotency(scopeHashSha256: string): Promise<CloudIdempotencyRecord | null>;
  insertIdempotency(record: CloudIdempotencyRecord): Promise<void>;

  findChallenge(challengeId: string, forUpdate?: boolean): Promise<IdentityChallengeRecord | null>;
  insertChallenge(record: IdentityChallengeRecord): Promise<void>;
  updateChallenge(record: IdentityChallengeRecord): Promise<void>;

  findAccountByEmail(
    emailCanonical: string,
    forUpdate?: boolean,
  ): Promise<CloudAccountRecord | null>;
  findAccountById(accountId: string, forUpdate?: boolean): Promise<CloudAccountRecord | null>;
  insertAccount(record: CloudAccountRecord): Promise<void>;
  updateAccount(record: CloudAccountRecord): Promise<void>;

  findDeviceById(deviceId: string, forUpdate?: boolean): Promise<RegisteredDeviceRecord | null>;
  findDeviceByFingerprint(
    accountId: string,
    publicKeyFingerprint: string,
    forUpdate?: boolean,
  ): Promise<RegisteredDeviceRecord | null>;
  insertDevice(record: RegisteredDeviceRecord): Promise<void>;
  updateDevice(record: RegisteredDeviceRecord): Promise<void>;
  listDevices(
    accountId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly RegisteredDeviceRecord[]>;

  findSessionById(sessionId: string, forUpdate?: boolean): Promise<CloudSessionRecord | null>;
  findSessionByAccessTokenHash(
    accessTokenHashSha256: string,
    forUpdate?: boolean,
  ): Promise<CloudSessionRecord | null>;
  findSessionByRefreshTokenHash(
    refreshTokenHashSha256: string,
    forUpdate?: boolean,
  ): Promise<CloudSessionRecord | null>;
  insertSession(record: CloudSessionRecord): Promise<void>;
  updateSession(record: CloudSessionRecord): Promise<void>;
  listSessions(
    accountId: string,
    limit: number,
    anchor: CloudPageAnchor | null,
  ): Promise<readonly CloudSessionRecord[]>;
  revokeSessionsForAccount(
    accountId: string,
    revokedAt: Date,
    exceptSessionId?: string,
  ): Promise<number>;
  revokeSessionsForDevice(deviceId: string, revokedAt: Date): Promise<number>;
  revokeRecipientDeviceEnvelopes(
    tenantId: string,
    recipientDeviceId: string,
    revokedAt: Date,
  ): Promise<number>;

  insertAuditEvent(record: CloudAuditEventRecord): Promise<void>;
}

export interface CloudIdentityStore {
  transaction<T>(operation: (transaction: CloudIdentityTransaction) => Promise<T>): Promise<T>;
  recordChallengeNotificationAttempt(
    challengeId: string,
    attemptedAt: Date,
    delivered: boolean,
  ): Promise<void>;
}
