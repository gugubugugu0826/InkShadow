import type { CloudApiOperationId, CloudDeviceRegistrationInput } from "@inkshadow/contracts";

export type CloudAccountState =
  "active" | "deleted" | "deletion_scheduled" | "frozen" | "locked" | "pending_verification";

export interface CloudAccountRecord {
  readonly accountId: string;
  readonly createdAt: Date;
  readonly deletionScheduledFor: Date | null;
  readonly emailCanonical: string;
  readonly failedLoginCount: number;
  readonly lastFailedLoginAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly passwordHash: string;
  readonly revision: number;
  readonly state: CloudAccountState;
  readonly updatedAt: Date;
  readonly verifiedAt: Date | null;
}

export type IdentityChallengeKind = "password_reset" | "registration";

export interface IdentityChallengeRecord {
  readonly accountId: string | null;
  readonly attemptCount: number;
  readonly challengeId: string;
  readonly codeHashSha256: string;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
  readonly emailCanonical: string;
  readonly expiresAt: Date;
  readonly kind: IdentityChallengeKind;
  readonly notificationAttempts: number;
  readonly notifiedAt: Date | null;
  readonly pendingPasswordHash: string | null;
}

export interface RegisteredDeviceRecord extends CloudDeviceRegistrationInput {
  readonly accountId: string;
  readonly createdAt: Date;
  readonly revision: number;
  readonly revokedAt: Date | null;
  readonly state: "revoked" | "trusted";
  readonly updatedAt: Date;
}

export interface CloudSessionRecord {
  readonly absoluteExpiresAt?: Date | null;
  readonly accessTokenHashSha256: string;
  readonly accountId: string;
  readonly clientVersion: string;
  readonly deviceId: string;
  readonly expiresAt: Date;
  readonly authenticationMethod?: "password" | "oidc";
  readonly issuedAt: Date;
  readonly lastSeenAt: Date;
  readonly minimumClientVersion: string;
  readonly refreshExpiresAt: Date;
  readonly refreshGeneration: number;
  readonly refreshTokenHashSha256: string;
  readonly replacedBySessionId: string | null;
  readonly revokedAt: Date | null;
  readonly sessionId: string;
}

export type IdempotencyResultKind =
  | "accepted"
  | "challenge"
  | "deletion_job"
  | "device"
  | "project_assignment"
  | "project_key"
  | "review"
  | "session"
  | "sync_batch"
  | "team"
  | "team_invitation"
  | "team_invitation_acceptance"
  | "team_membership"
  | "team_template"
  | "team_project_key_envelope";

export interface CloudIdempotencyRecord {
  readonly actorAccountId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly idempotencyKeyHashSha256: string;
  readonly operationId: CloudApiOperationId;
  readonly requestHashSha256: string;
  readonly responseSnapshot: unknown;
  readonly responseStatus: number;
  readonly resultDigestSha256: string;
  readonly resultKind: IdempotencyResultKind;
  readonly resultResourceId: string | null;
  readonly scopeHashSha256: string;
}

export interface CloudAuditEventRecord {
  readonly action: string;
  readonly actorAccountId: string | null;
  readonly actorDeviceId: string | null;
  readonly createdAt: Date;
  readonly eventId: string;
  readonly redactedDiff: Readonly<Record<string, unknown>>;
  readonly requestId: string;
  readonly resourceId: string | null;
  readonly resourceType: string;
  readonly result: "allowed" | "denied" | "failed";
  readonly tenantId: string | null;
}

export interface CloudPageAnchor {
  readonly createdAt: Date;
  readonly id: string;
}
