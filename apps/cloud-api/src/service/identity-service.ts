import type {
  CloudAuthenticationRequest,
  CloudDeviceContract,
  CloudDeviceListResponse,
  CloudDeviceRegistrationInput,
  CloudDeviceRegistrationRequest,
  CloudDeviceResponse,
  CloudIdentityChallengeResponse,
  CloudIdentityRegistrationRequest,
  CloudIdentityVerificationRequest,
  CloudMutationAcceptedResponse,
  CloudPasswordResetConfirmationRequest,
  CloudPasswordResetRequest,
  CloudSessionContract,
  CloudSessionGrantResponse,
  CloudSessionListResponse,
  CloudSessionLogoutRequest,
  CloudSessionRefreshRequest,
} from "@inkshadow/contracts";
import {
  CloudDeviceResponseSchema,
  CloudIdentityChallengeResponseSchema,
  CloudMutationAcceptedResponseSchema,
  CloudSessionGrantResponseSchema,
  CONTRACT_SCHEMA_VERSION,
} from "@inkshadow/contracts";

import type {
  CloudAccountRecord,
  CloudAuditEventRecord,
  CloudIdempotencyRecord,
  CloudSessionRecord,
  IdentityChallengeRecord,
  RegisteredDeviceRecord,
} from "../domain/records.js";
import type { CloudIdentityStore, CloudIdentityTransaction } from "../repository/identity-store.js";
import {
  createIdempotencyScopeHash,
  hashCanonicalJson,
  hashUtf8,
} from "../security/canonical-hash.js";
import { verifyDevicePublicKey } from "../security/device-public-key.js";
import {
  hashAuthenticationIdempotencyRequest,
  hashIdentityRegistrationIdempotencyRequest,
  hashIdentityVerificationIdempotencyRequest,
  hashPasswordResetConfirmationIdempotencyRequest,
  hashSessionRefreshIdempotencyRequest,
} from "../security/identity-idempotency.js";
import { InvalidPageCursorError } from "../security/page-cursor.js";
import type { CloudPageCursorCodec } from "../security/page-cursor.js";
import type { PasswordHasher } from "../security/passwords.js";
import type { CloudTokenService } from "../security/tokens.js";
import type { UuidV7Factory } from "../security/uuid-v7.js";
import {
  accessForbidden,
  accountFrozen,
  accountLocked,
  CloudServiceError,
  deviceRevoked,
  emailUnverified,
  idempotencyConflict,
  invalidCredentials,
  refreshReplayed,
  resourceNotFound,
  serviceUnavailable,
  sessionExpired,
  sessionRevoked,
  upgradeRequired,
  validationFailed,
} from "./errors.js";

export interface CloudMutationContext {
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface CloudReadContext {
  readonly requestId: string;
}

export interface CloudPrincipal {
  readonly accountId: string;
  readonly deviceId: string;
  readonly sessionId: string;
}

export interface IdentityChallengeDelivery {
  readonly challengeId: string;
  readonly code: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly kind: "password_reset" | "registration";
}

export interface IdentityChallengeNotifier {
  deliver(delivery: IdentityChallengeDelivery): Promise<void>;
}

export interface CloudIdentityServiceOptions {
  readonly accessTokenLifetimeMs?: number;
  readonly challengeLifetimeMs?: number;
  readonly clock?: () => Date;
  readonly idempotencyLifetimeMs?: number;
  readonly lockoutDurationMs?: number;
  readonly maximumDevices?: number;
  readonly maximumLoginFailures?: number;
  readonly minimumClientVersion: string;
  readonly notifier: IdentityChallengeNotifier;
  readonly pageCursorCodec: CloudPageCursorCodec;
  readonly pageSize?: number;
  readonly passwordHasher: PasswordHasher;
  readonly passwordLoginPolicy?: CloudPasswordLoginPolicy;
  readonly refreshTokenLifetimeMs?: number;
  readonly store: CloudIdentityStore;
  readonly tokenService: CloudTokenService;
  readonly uuid: UuidV7Factory;
}

export interface CloudPasswordLoginPolicy {
  assertPasswordLoginAllowed(input: {
    readonly accountId: string;
    readonly emailCanonical: string;
  }): Promise<void>;
}

export interface CloudEnterpriseOidcSessionInput {
  readonly accountId: string;
  readonly device: CloudDeviceRegistrationInput;
  readonly maximumTrustedDevices: number;
  readonly sessionMaximumMinutes: number;
  readonly teamId: string;
  readonly policyRevision: number;
}

interface SessionMaterial {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly session: CloudSessionRecord;
}

interface ChallengeOutcome {
  readonly challenge: IdentityChallengeRecord;
  readonly notify: boolean;
  readonly response: CloudIdentityChallengeResponse;
}

type ServiceOutcome<Value> = { readonly error: CloudServiceError } | { readonly value: Value };

const DEFAULT_ACCESS_TOKEN_LIFETIME_MS = 15 * 60 * 1_000;
const DEFAULT_REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_CHALLENGE_LIFETIME_MS = 15 * 60 * 1_000;
const DEFAULT_IDEMPOTENCY_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LOCKOUT_DURATION_MS = 15 * 60 * 1_000;
const DEFAULT_MAXIMUM_LOGIN_FAILURES = 5;
const DEFAULT_MAXIMUM_DEVICES = 10;
const DEFAULT_PAGE_SIZE = 100;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1_000;

export class CloudIdentityService {
  private readonly accessTokenLifetimeMs: number;
  private readonly challengeLifetimeMs: number;
  private readonly clock: () => Date;
  private readonly dummyPasswordHash: Promise<string>;
  private readonly idempotencyLifetimeMs: number;
  private readonly lockoutDurationMs: number;
  private readonly maximumDevices: number;
  private readonly maximumLoginFailures: number;
  private readonly minimumClientVersion: string;
  private readonly notifier: IdentityChallengeNotifier;
  private readonly pageCursorCodec: CloudPageCursorCodec;
  private readonly pageSize: number;
  private readonly passwordHasher: PasswordHasher;
  private readonly passwordLoginPolicy: CloudPasswordLoginPolicy | null;
  private readonly refreshTokenLifetimeMs: number;
  private readonly store: CloudIdentityStore;
  private readonly tokenService: CloudTokenService;
  private readonly uuid: UuidV7Factory;

  public constructor(options: CloudIdentityServiceOptions) {
    this.accessTokenLifetimeMs = options.accessTokenLifetimeMs ?? DEFAULT_ACCESS_TOKEN_LIFETIME_MS;
    this.challengeLifetimeMs = options.challengeLifetimeMs ?? DEFAULT_CHALLENGE_LIFETIME_MS;
    this.clock = options.clock ?? (() => new Date());
    this.idempotencyLifetimeMs = options.idempotencyLifetimeMs ?? DEFAULT_IDEMPOTENCY_LIFETIME_MS;
    this.lockoutDurationMs = options.lockoutDurationMs ?? DEFAULT_LOCKOUT_DURATION_MS;
    this.maximumDevices = options.maximumDevices ?? DEFAULT_MAXIMUM_DEVICES;
    this.maximumLoginFailures = options.maximumLoginFailures ?? DEFAULT_MAXIMUM_LOGIN_FAILURES;
    this.minimumClientVersion = options.minimumClientVersion;
    this.notifier = options.notifier;
    this.pageCursorCodec = options.pageCursorCodec;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.passwordHasher = options.passwordHasher;
    this.passwordLoginPolicy = options.passwordLoginPolicy ?? null;
    this.refreshTokenLifetimeMs =
      options.refreshTokenLifetimeMs ?? DEFAULT_REFRESH_TOKEN_LIFETIME_MS;
    this.store = options.store;
    this.tokenService = options.tokenService;
    this.uuid = options.uuid;
    validateServiceOptions({
      accessTokenLifetimeMs: this.accessTokenLifetimeMs,
      challengeLifetimeMs: this.challengeLifetimeMs,
      idempotencyLifetimeMs: this.idempotencyLifetimeMs,
      lockoutDurationMs: this.lockoutDurationMs,
      maximumDevices: this.maximumDevices,
      maximumLoginFailures: this.maximumLoginFailures,
      pageSize: this.pageSize,
      refreshTokenLifetimeMs: this.refreshTokenLifetimeMs,
    });
    this.dummyPasswordHash = this.passwordHasher.hash("inkshadow-dummy-password-boundary");
  }

  public async registerIdentity(
    request: CloudIdentityRegistrationRequest,
    context: CloudMutationContext,
  ): Promise<CloudIdentityChallengeResponse> {
    const now = this.now();
    const requestHash = hashIdentityRegistrationIdempotencyRequest(request);
    const passwordHash = await this.passwordHasher.hash(request.password);
    const outcome = await this.store.transaction<ChallengeOutcome>(async (transaction) => {
      const existing = await this.findIdempotency(
        transaction,
        "identity.register",
        null,
        context.idempotencyKey,
        requestHash,
        now,
      );
      if (existing !== null) {
        const replay = await this.replayChallenge(transaction, existing, context.requestId, true);
        if (
          replay.challenge.pendingPasswordHash === null ||
          !(await this.passwordHasher.verify(
            request.password,
            replay.challenge.pendingPasswordHash,
          ))
        ) {
          throw idempotencyConflict();
        }
        return replay;
      }

      const account = await transaction.findAccountByEmail(request.email, false);
      const challenge = this.createChallenge({
        accountId: account?.accountId ?? null,
        email: request.email,
        kind: "registration",
        now,
        pendingPasswordHash: passwordHash,
      });
      await transaction.insertChallenge(challenge);
      const response = toChallengeResponse(challenge, context.requestId);
      await this.insertIdempotency(transaction, {
        actorAccountId: null,
        context,
        now,
        operationId: "identity.register",
        requestHash,
        response,
        responseStatus: 202,
        resultKind: "challenge",
        resultResourceId: challenge.challengeId,
      });
      await transaction.insertAuditEvent(
        this.auditEvent({
          action: "identity.registration_requested",
          context,
          now,
          resourceId: challenge.challengeId,
          resourceType: "identity_challenge",
        }),
      );
      return { challenge, notify: account === null, response };
    });
    if (outcome.notify) {
      await this.deliverChallenge(outcome.challenge);
    }
    return outcome.response;
  }

  public async verifyEmail(
    request: CloudIdentityVerificationRequest,
    context: CloudMutationContext,
  ): Promise<CloudSessionGrantResponse> {
    this.assertDeviceInput(request.device);
    const now = this.now();
    const requestHash = hashIdentityVerificationIdempotencyRequest(
      request,
      this.tokenService.hashChallengeCode(request.challengeId, request.code),
    );
    const outcome = await this.store.transaction<ServiceOutcome<CloudSessionGrantResponse>>(
      async (transaction) => {
        const existing = await this.findIdempotency(
          transaction,
          "identity.verifyEmail",
          null,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existing !== null) {
          return {
            value: this.replaySessionGrant(existing, context.requestId),
          };
        }

        const challenge = await transaction.findChallenge(request.challengeId, true);
        const challengeError = await this.validateChallenge(
          transaction,
          challenge,
          "registration",
          request.code,
          now,
          context,
        );
        if (challengeError !== null) {
          return { error: challengeError };
        }
        if (challenge === null) {
          throw new Error("A validated email-verification challenge disappeared.");
        }
        if (challenge.accountId !== null || challenge.pendingPasswordHash === null) {
          return { error: validationFailed("The email-verification challenge is invalid.") };
        }

        const existingAccount = await transaction.findAccountByEmail(
          challenge.emailCanonical,
          true,
        );
        if (existingAccount !== null) {
          await transaction.updateChallenge({ ...challenge, consumedAt: now });
          return {
            error: validationFailed(
              "This email address is already registered. Sign in or reset the password.",
            ),
          };
        }

        const account: CloudAccountRecord = {
          accountId: this.uuid(),
          createdAt: now,
          deletionScheduledFor: null,
          emailCanonical: challenge.emailCanonical,
          failedLoginCount: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
          passwordHash: challenge.pendingPasswordHash,
          revision: 1,
          state: "active",
          updatedAt: now,
          verifiedAt: now,
        };
        await transaction.insertAccount(account);
        await transaction.updateChallenge({
          ...challenge,
          accountId: account.accountId,
          consumedAt: now,
        });
        const device = await this.upsertTrustedDevice(
          transaction,
          account.accountId,
          request.device,
          now,
        );
        const material = this.createSession(account.accountId, device, now, 1);
        await transaction.insertSession(material.session);
        const response = this.toGrant(account, device, material, context.requestId);
        await this.insertIdempotency(transaction, {
          actorAccountId: null,
          context,
          now,
          operationId: "identity.verifyEmail",
          requestHash,
          response,
          responseSnapshot: sessionGrantSnapshot(response, material.session.refreshGeneration),
          responseStatus: 200,
          resultKind: "session",
          resultResourceId: material.session.sessionId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "identity.email_verified",
            actorAccountId: account.accountId,
            actorDeviceId: device.deviceId,
            context,
            now,
            resourceId: account.accountId,
            resourceType: "cloud_account",
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async requestPasswordReset(
    request: CloudPasswordResetRequest,
    context: CloudMutationContext,
  ): Promise<CloudIdentityChallengeResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson(request);
    const outcome = await this.store.transaction<ChallengeOutcome>(async (transaction) => {
      const existing = await this.findIdempotency(
        transaction,
        "identity.requestPasswordReset",
        null,
        context.idempotencyKey,
        requestHash,
        now,
      );
      if (existing !== null) {
        return this.replayChallenge(transaction, existing, context.requestId, false);
      }

      const account = await transaction.findAccountByEmail(request.email, false);
      const resettable =
        account !== null &&
        (account.state === "active" || account.state === "locked" || account.state === "frozen");
      const challenge = this.createChallenge({
        accountId: resettable ? account.accountId : null,
        email: request.email,
        kind: "password_reset",
        now,
        pendingPasswordHash: null,
      });
      await transaction.insertChallenge(challenge);
      const response = toChallengeResponse(challenge, context.requestId);
      await this.insertIdempotency(transaction, {
        actorAccountId: null,
        context,
        now,
        operationId: "identity.requestPasswordReset",
        requestHash,
        response,
        responseStatus: 202,
        resultKind: "challenge",
        resultResourceId: challenge.challengeId,
      });
      await transaction.insertAuditEvent(
        this.auditEvent({
          action: "identity.password_reset_requested",
          actorAccountId: resettable ? account.accountId : null,
          context,
          now,
          resourceId: challenge.challengeId,
          resourceType: "identity_challenge",
        }),
      );
      return { challenge, notify: resettable, response };
    });
    if (outcome.notify) {
      await this.deliverChallenge(outcome.challenge);
    }
    return outcome.response;
  }

  public async confirmPasswordReset(
    request: CloudPasswordResetConfirmationRequest,
    context: CloudMutationContext,
  ): Promise<CloudMutationAcceptedResponse> {
    const now = this.now();
    const requestHash = hashPasswordResetConfirmationIdempotencyRequest(
      request,
      this.tokenService.hashChallengeCode(request.challengeId, request.code),
    );
    const newPasswordHash = await this.passwordHasher.hash(request.newPassword);
    const outcome = await this.store.transaction<ServiceOutcome<CloudMutationAcceptedResponse>>(
      async (transaction) => {
        const existing = await this.findIdempotency(
          transaction,
          "identity.confirmPasswordReset",
          null,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existing !== null) {
          if (existing.resultKind !== "accepted" || existing.resultResourceId === null) {
            throw new Error("The idempotency record does not reference a password-reset account.");
          }
          const replayAccount = await transaction.findAccountById(existing.resultResourceId, false);
          if (
            replayAccount === null ||
            !(await this.passwordHasher.verify(request.newPassword, replayAccount.passwordHash))
          ) {
            throw idempotencyConflict();
          }
          return {
            value: replayAccepted(existing, context.requestId),
          };
        }

        const challenge = await transaction.findChallenge(request.challengeId, true);
        const challengeError = await this.validateChallenge(
          transaction,
          challenge,
          "password_reset",
          request.code,
          now,
          context,
        );
        if (challengeError !== null) {
          return { error: challengeError };
        }
        if (challenge === null) {
          throw new Error("A validated password-reset challenge disappeared.");
        }
        if (challenge.accountId === null) {
          return { error: validationFailed("The password-reset challenge is invalid.") };
        }
        const account = await transaction.findAccountById(challenge.accountId, true);
        if (
          account === null ||
          (account.state !== "active" && account.state !== "locked" && account.state !== "frozen")
        ) {
          return { error: validationFailed("The account cannot be reset.") };
        }

        const updatedAccount: CloudAccountRecord = {
          ...account,
          failedLoginCount: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
          passwordHash: newPasswordHash,
          revision: account.revision + 1,
          state: account.state === "locked" ? "active" : account.state,
          updatedAt: now,
        };
        await transaction.updateAccount(updatedAccount);
        await transaction.updateChallenge({ ...challenge, consumedAt: now });
        await transaction.revokeSessionsForAccount(account.accountId, now);
        const response = acceptedResponse(context.requestId, now);
        await this.insertIdempotency(transaction, {
          actorAccountId: null,
          context,
          now,
          operationId: "identity.confirmPasswordReset",
          requestHash,
          response,
          responseStatus: 202,
          resultKind: "accepted",
          resultResourceId: account.accountId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "identity.password_reset_confirmed",
            actorAccountId: account.accountId,
            context,
            now,
            resourceId: account.accountId,
            resourceType: "cloud_account",
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async login(
    request: CloudAuthenticationRequest,
    context: CloudMutationContext,
  ): Promise<CloudSessionGrantResponse> {
    this.assertDeviceInput(request.device);
    const now = this.now();
    const requestHash = hashAuthenticationIdempotencyRequest(request);
    const outcome = await this.store.transaction<ServiceOutcome<CloudSessionGrantResponse>>(
      async (transaction) => {
        let account = await transaction.findAccountByEmail(request.email, true);
        const passwordMatches = await this.passwordHasher.verify(
          request.password,
          account?.passwordHash ?? (await this.dummyPasswordHash),
        );
        if (account === null || !passwordMatches) {
          if (account !== null) {
            account = await this.recordFailedLogin(transaction, account, now);
          }
          await transaction.insertAuditEvent(
            this.auditEvent({
              action: "auth.login",
              actorAccountId: account?.accountId ?? null,
              context,
              now,
              redactedDiff: { reason: "invalid_credentials" },
              resourceId: account?.accountId ?? null,
              resourceType: "cloud_account",
              result: "denied",
            }),
          );
          return { error: invalidCredentials() };
        }

        const accountError = this.validateAccountForLogin(account, now);
        if (accountError !== null) {
          await transaction.insertAuditEvent(
            this.auditEvent({
              action: "auth.login",
              actorAccountId: account.accountId,
              context,
              now,
              redactedDiff: { reason: accountError.code },
              resourceId: account.accountId,
              resourceType: "cloud_account",
              result: "denied",
            }),
          );
          return { error: accountError };
        }
        if (this.passwordLoginPolicy !== null) {
          try {
            await this.passwordLoginPolicy.assertPasswordLoginAllowed({
              accountId: account.accountId,
              emailCanonical: account.emailCanonical,
            });
          } catch (error: unknown) {
            if (!(error instanceof CloudServiceError)) {
              throw error;
            }
            await transaction.insertAuditEvent(
              this.auditEvent({
                action: "auth.login",
                actorAccountId: account.accountId,
                context,
                now,
                redactedDiff: {
                  authenticationMethod: "password",
                  reason: error.code,
                },
                resourceId: account.accountId,
                resourceType: "cloud_account",
                result: "denied",
              }),
            );
            return { error };
          }
        }
        const existingIdempotency = await this.findIdempotency(
          transaction,
          "auth.login",
          null,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existingIdempotency !== null) {
          return {
            value: this.replaySessionGrant(existingIdempotency, context.requestId),
          };
        }
        if (
          account.failedLoginCount !== 0 ||
          account.lastFailedLoginAt !== null ||
          account.lockedUntil !== null ||
          account.state === "locked"
        ) {
          account = {
            ...account,
            failedLoginCount: 0,
            lastFailedLoginAt: null,
            lockedUntil: null,
            revision: account.revision + 1,
            state: "active",
            updatedAt: now,
          };
          await transaction.updateAccount(account);
        }

        const device = await this.upsertTrustedDevice(
          transaction,
          account.accountId,
          request.device,
          now,
        );
        const material = this.createSession(account.accountId, device, now, 1);
        await transaction.insertSession(material.session);
        const response = this.toGrant(account, device, material, context.requestId);
        await this.insertIdempotency(transaction, {
          actorAccountId: null,
          context,
          now,
          operationId: "auth.login",
          requestHash,
          response,
          responseSnapshot: sessionGrantSnapshot(response, material.session.refreshGeneration),
          responseStatus: 200,
          resultKind: "session",
          resultResourceId: material.session.sessionId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "auth.login",
            actorAccountId: account.accountId,
            actorDeviceId: device.deviceId,
            context,
            now,
            resourceId: material.session.sessionId,
            resourceType: "cloud_session",
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async issueEnterpriseOidcSession(
    input: CloudEnterpriseOidcSessionInput,
    context: CloudMutationContext,
  ): Promise<CloudSessionGrantResponse> {
    this.assertDeviceInput(input.device);
    if (
      !Number.isSafeInteger(input.maximumTrustedDevices) ||
      input.maximumTrustedDevices < 1 ||
      input.maximumTrustedDevices > 100 ||
      !Number.isSafeInteger(input.sessionMaximumMinutes) ||
      input.sessionMaximumMinutes < 15 ||
      input.sessionMaximumMinutes > 43_200 ||
      !Number.isSafeInteger(input.policyRevision) ||
      input.policyRevision < 1
    ) {
      throw validationFailed("The Enterprise session policy is invalid.");
    }
    const now = this.now();
    const requestHash = hashCanonicalJson({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      accountId: input.accountId,
      device: input.device,
      maximumTrustedDevices: input.maximumTrustedDevices,
      sessionMaximumMinutes: input.sessionMaximumMinutes,
      teamId: input.teamId,
      policyRevision: input.policyRevision,
    });
    const outcome = await this.store.transaction<ServiceOutcome<CloudSessionGrantResponse>>(
      async (transaction) => {
        const existing = await this.findIdempotency(
          transaction,
          "enterpriseSso.complete",
          input.accountId,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existing !== null) {
          return { value: this.replaySessionGrant(existing, context.requestId) };
        }
        const account = await transaction.findAccountById(input.accountId, true);
        if (account === null) {
          return { error: invalidCredentials() };
        }
        if (account.verifiedAt === null) {
          return { error: invalidCredentials() };
        }
        const accountError = this.validateActiveAccount(account, now);
        if (accountError !== null) {
          return { error: accountError };
        }
        const device = await this.upsertTrustedDevice(
          transaction,
          account.accountId,
          input.device,
          now,
          input.maximumTrustedDevices,
        );
        const material = this.createSession(
          account.accountId,
          device,
          now,
          1,
          input.sessionMaximumMinutes * 60 * 1_000,
          "oidc",
          addMilliseconds(now, input.sessionMaximumMinutes * 60 * 1_000),
        );
        await transaction.insertSession(material.session);
        const response = this.toGrant(account, device, material, context.requestId);
        await this.insertIdempotency(transaction, {
          actorAccountId: account.accountId,
          context,
          now,
          operationId: "enterpriseSso.complete",
          requestHash,
          response,
          responseSnapshot: sessionGrantSnapshot(response, material.session.refreshGeneration),
          responseStatus: 200,
          resultKind: "session",
          resultResourceId: material.session.sessionId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "auth.oidc_login",
            actorAccountId: account.accountId,
            actorDeviceId: device.deviceId,
            context,
            now,
            redactedDiff: { authenticationMethod: "oidc" },
            resourceId: material.session.sessionId,
            resourceType: "cloud_session",
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async refresh(
    request: CloudSessionRefreshRequest,
    context: CloudMutationContext,
  ): Promise<CloudSessionGrantResponse> {
    const now = this.now();
    const refreshHash = this.tokenService.hashBearerToken(request.refreshToken);
    const outcome = await this.store.transaction<ServiceOutcome<CloudSessionGrantResponse>>(
      async (transaction) => {
        const current = await transaction.findSessionByRefreshTokenHash(refreshHash, true);
        if (current === null) {
          return { error: invalidCredentials() };
        }
        const requestHash = hashSessionRefreshIdempotencyRequest(request, current.sessionId);
        const existingIdempotency = await this.findIdempotency(
          transaction,
          "auth.refresh",
          current.accountId,
          context.idempotencyKey,
          requestHash,
          now,
        );
        if (existingIdempotency !== null) {
          return {
            value: this.replaySessionGrant(existingIdempotency, context.requestId),
          };
        }
        if (current.deviceId !== request.deviceId) {
          return { error: invalidCredentials() };
        }
        if (current.revokedAt !== null) {
          if (current.replacedBySessionId !== null) {
            await transaction.revokeSessionsForDevice(current.deviceId, now);
            await transaction.insertAuditEvent(
              this.auditEvent({
                action: "auth.refresh_replay",
                actorAccountId: current.accountId,
                actorDeviceId: current.deviceId,
                context,
                now,
                redactedDiff: { response: "device_sessions_revoked" },
                resourceId: current.sessionId,
                resourceType: "cloud_session",
                result: "denied",
              }),
            );
            return { error: refreshReplayed() };
          }
          return { error: sessionRevoked() };
        }
        if (current.refreshExpiresAt.getTime() <= now.getTime()) {
          await transaction.updateSession({ ...current, revokedAt: now });
          return { error: sessionExpired() };
        }
        const account = await transaction.findAccountById(current.accountId, true);
        if (account === null) {
          return { error: sessionExpired() };
        }
        const accountError = this.validateActiveAccount(account, now);
        if (accountError !== null) {
          return { error: accountError };
        }
        const device = await transaction.findDeviceById(current.deviceId, true);
        if (device?.accountId !== account.accountId) {
          return { error: sessionExpired() };
        }
        if (device.state === "revoked") {
          return { error: deviceRevoked() };
        }

        const absoluteExpiresAt = current.absoluteExpiresAt ?? null;
        const replacement = this.createSession(
          account.accountId,
          device,
          now,
          current.refreshGeneration + 1,
          absoluteExpiresAt === null
            ? this.refreshTokenLifetimeMs
            : absoluteExpiresAt.getTime() - now.getTime(),
          current.authenticationMethod ?? "password",
          absoluteExpiresAt,
        );
        await transaction.insertSession(replacement.session);
        await transaction.updateSession({
          ...current,
          lastSeenAt: now,
          replacedBySessionId: replacement.session.sessionId,
          revokedAt: now,
        });
        const response = this.toGrant(account, device, replacement, context.requestId);
        await this.insertIdempotency(transaction, {
          actorAccountId: account.accountId,
          context,
          now,
          operationId: "auth.refresh",
          requestHash,
          response,
          responseSnapshot: sessionGrantSnapshot(response, replacement.session.refreshGeneration),
          responseStatus: 200,
          resultKind: "session",
          resultResourceId: replacement.session.sessionId,
        });
        await transaction.insertAuditEvent(
          this.auditEvent({
            action: "auth.session_rotated",
            actorAccountId: account.accountId,
            actorDeviceId: device.deviceId,
            context,
            now,
            resourceId: replacement.session.sessionId,
            resourceType: "cloud_session",
          }),
        );
        return { value: response };
      },
    );
    return unwrap(outcome);
  }

  public async authenticateAccessToken(
    accessToken: string,
    context: CloudReadContext,
  ): Promise<CloudPrincipal> {
    const now = this.now();
    const tokenHash = this.tokenService.hashBearerToken(accessToken);
    const outcome = await this.store.transaction<ServiceOutcome<CloudPrincipal>>(
      async (transaction) => {
        let session = await transaction.findSessionByAccessTokenHash(tokenHash, true);
        if (session === null) {
          return { error: sessionExpired() };
        }
        if (session.revokedAt !== null) {
          return { error: sessionRevoked() };
        }
        if (session.expiresAt.getTime() <= now.getTime()) {
          await transaction.updateSession({ ...session, revokedAt: now });
          return { error: sessionExpired() };
        }
        const account = await transaction.findAccountById(session.accountId, false);
        if (account === null) {
          return { error: sessionExpired() };
        }
        const accountError = this.validateActiveAccount(account, now);
        if (accountError !== null) {
          return { error: accountError };
        }
        const device = await transaction.findDeviceById(session.deviceId, false);
        if (device?.accountId !== account.accountId) {
          return { error: sessionExpired() };
        }
        if (device.state === "revoked") {
          return { error: deviceRevoked() };
        }
        if (now.getTime() - session.lastSeenAt.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
          session = { ...session, lastSeenAt: now };
          await transaction.updateSession(session);
        }
        return {
          value: {
            accountId: session.accountId,
            deviceId: session.deviceId,
            sessionId: session.sessionId,
          },
        };
      },
    );
    void context;
    return unwrap(outcome);
  }

  public async logout(
    principal: CloudPrincipal,
    request: CloudSessionLogoutRequest,
    context: CloudMutationContext,
  ): Promise<CloudMutationAcceptedResponse> {
    if (request.sessionId !== principal.sessionId) {
      throw accessForbidden("Logout can revoke only the active session.");
    }
    return this.revokeSessionMutation(
      principal,
      request.sessionId,
      context,
      "auth.logout",
      request,
      "auth.logout",
    );
  }

  public async revokeSession(
    principal: CloudPrincipal,
    sessionId: string,
    context: CloudMutationContext,
  ): Promise<CloudMutationAcceptedResponse> {
    return this.revokeSessionMutation(
      principal,
      sessionId,
      context,
      "auth.revokeSession",
      { sessionId },
      "auth.session_revoked",
    );
  }

  public async listSessions(
    principal: CloudPrincipal,
    cursor: string | null,
    context: CloudReadContext,
  ): Promise<CloudSessionListResponse> {
    const anchor = this.decodePageCursor("sessions", cursor);
    const sessions = await this.store.transaction((transaction) =>
      transaction.listSessions(principal.accountId, this.pageSize + 1, anchor),
    );
    const page = sessions.slice(0, this.pageSize);
    const last = page.at(-1);
    const nextCursor =
      sessions.length > this.pageSize && last !== undefined
        ? this.pageCursorCodec.encode("sessions", {
            createdAt: last.issuedAt,
            id: last.sessionId,
          })
        : null;
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: context.requestId,
      sessions: page.map(toSessionContract),
      nextCursor,
    };
  }

  public async listDevices(
    principal: CloudPrincipal,
    cursor: string | null,
    context: CloudReadContext,
  ): Promise<CloudDeviceListResponse> {
    const anchor = this.decodePageCursor("devices", cursor);
    const devices = await this.store.transaction((transaction) =>
      transaction.listDevices(principal.accountId, this.pageSize + 1, anchor),
    );
    const page = devices.slice(0, this.pageSize);
    const last = page.at(-1);
    const nextCursor =
      devices.length > this.pageSize && last !== undefined
        ? this.pageCursorCodec.encode("devices", {
            createdAt: last.createdAt,
            id: last.deviceId,
          })
        : null;
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: context.requestId,
      devices: page.map(toDeviceContract),
      nextCursor,
    };
  }

  public async registerDevice(
    principal: CloudPrincipal,
    request: CloudDeviceRegistrationRequest,
    context: CloudMutationContext,
  ): Promise<CloudDeviceResponse> {
    this.assertDeviceInput(request.device);
    const now = this.now();
    const requestHash = hashCanonicalJson(request);
    return this.store.transaction(async (transaction) => {
      const existingIdempotency = await this.findIdempotency(
        transaction,
        "devices.register",
        principal.accountId,
        context.idempotencyKey,
        requestHash,
        now,
      );
      if (existingIdempotency !== null) {
        return this.replayDevice(existingIdempotency, context.requestId);
      }
      const device = await this.upsertTrustedDevice(
        transaction,
        principal.accountId,
        request.device,
        now,
      );
      const response = toDeviceResponse(device, context.requestId);
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "devices.register",
        requestHash,
        response,
        responseStatus: 201,
        resultKind: "device",
        resultResourceId: device.deviceId,
      });
      await transaction.insertAuditEvent(
        this.auditEvent({
          action: "device.registered",
          actorAccountId: principal.accountId,
          actorDeviceId: principal.deviceId,
          context,
          now,
          resourceId: device.deviceId,
          resourceType: "registered_device",
        }),
      );
      return response;
    });
  }

  public async revokeDevice(
    principal: CloudPrincipal,
    deviceId: string,
    context: CloudMutationContext,
  ): Promise<CloudDeviceResponse> {
    const now = this.now();
    const requestBody = { deviceId };
    const requestHash = hashCanonicalJson(requestBody);
    return this.store.transaction(async (transaction) => {
      await transaction.setTenant(principal.accountId);
      const existingIdempotency = await this.findIdempotency(
        transaction,
        "devices.revoke",
        principal.accountId,
        context.idempotencyKey,
        requestHash,
        now,
      );
      if (existingIdempotency !== null) {
        return this.replayDevice(existingIdempotency, context.requestId);
      }
      const device = await transaction.findDeviceById(deviceId, true);
      if (device?.accountId !== principal.accountId) {
        throw resourceNotFound("The device was not found.");
      }
      const revoked =
        device.state === "revoked"
          ? device
          : {
              ...device,
              revision: device.revision + 1,
              revokedAt: now,
              state: "revoked" as const,
              updatedAt: now,
            };
      if (device.state !== "revoked") {
        await transaction.updateDevice(revoked);
        await transaction.revokeSessionsForDevice(device.deviceId, now);
        await transaction.revokeRecipientDeviceEnvelopes(principal.accountId, device.deviceId, now);
      }
      const response = toDeviceResponse(revoked, context.requestId);
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId: "devices.revoke",
        requestHash,
        response,
        responseStatus: 200,
        resultKind: "device",
        resultResourceId: revoked.deviceId,
      });
      await transaction.insertAuditEvent(
        this.auditEvent({
          action: "device.revoked",
          actorAccountId: principal.accountId,
          actorDeviceId: principal.deviceId,
          context,
          now,
          resourceId: revoked.deviceId,
          resourceType: "registered_device",
        }),
      );
      return response;
    });
  }

  private async revokeSessionMutation(
    principal: CloudPrincipal,
    sessionId: string,
    context: CloudMutationContext,
    operationId: "auth.logout" | "auth.revokeSession",
    requestForHash: unknown,
    auditAction: string,
  ): Promise<CloudMutationAcceptedResponse> {
    const now = this.now();
    const requestHash = hashCanonicalJson(requestForHash);
    return this.store.transaction(async (transaction) => {
      const existingIdempotency = await this.findIdempotency(
        transaction,
        operationId,
        principal.accountId,
        context.idempotencyKey,
        requestHash,
        now,
      );
      if (existingIdempotency !== null) {
        return replayAccepted(existingIdempotency, context.requestId);
      }
      const session = await transaction.findSessionById(sessionId, true);
      if (session?.accountId !== principal.accountId) {
        throw resourceNotFound("The session was not found.");
      }
      if (session.revokedAt === null) {
        await transaction.updateSession({ ...session, revokedAt: now });
      }
      const response = acceptedResponse(context.requestId, now);
      await this.insertIdempotency(transaction, {
        actorAccountId: principal.accountId,
        context,
        now,
        operationId,
        requestHash,
        response,
        responseStatus: 202,
        resultKind: "accepted",
        resultResourceId: session.sessionId,
      });
      await transaction.insertAuditEvent(
        this.auditEvent({
          action: auditAction,
          actorAccountId: principal.accountId,
          actorDeviceId: principal.deviceId,
          context,
          now,
          resourceId: session.sessionId,
          resourceType: "cloud_session",
        }),
      );
      return response;
    });
  }

  private async validateChallenge(
    transaction: CloudIdentityTransaction,
    challenge: IdentityChallengeRecord | null,
    expectedKind: IdentityChallengeRecord["kind"],
    code: string,
    now: Date,
    context: CloudMutationContext,
  ): Promise<CloudServiceError | null> {
    if (
      challenge?.kind !== expectedKind ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.attemptCount >= 10
    ) {
      return validationFailed("The verification challenge is invalid or expired.");
    }
    const valid = this.tokenService.verifyChallengeCode(
      challenge.challengeId,
      code,
      challenge.codeHashSha256,
    );
    if (valid) {
      return null;
    }
    await transaction.updateChallenge({
      ...challenge,
      attemptCount: Math.min(challenge.attemptCount + 1, 10),
    });
    await transaction.insertAuditEvent(
      this.auditEvent({
        action: "identity.challenge_failed",
        actorAccountId: challenge.accountId,
        context,
        now,
        redactedDiff: { kind: challenge.kind, reason: "invalid_code" },
        resourceId: challenge.challengeId,
        resourceType: "identity_challenge",
        result: "denied",
      }),
    );
    return validationFailed("The verification challenge is invalid or expired.");
  }

  private async recordFailedLogin(
    transaction: CloudIdentityTransaction,
    account: CloudAccountRecord,
    now: Date,
  ): Promise<CloudAccountRecord> {
    const nextCount = Math.min(account.failedLoginCount + 1, 20);
    const canLock = account.verifiedAt !== null && account.state !== "frozen";
    const shouldLock = canLock && nextCount >= this.maximumLoginFailures;
    const updated: CloudAccountRecord = {
      ...account,
      failedLoginCount: nextCount,
      lastFailedLoginAt: now,
      lockedUntil: shouldLock ? addMilliseconds(now, this.lockoutDurationMs) : account.lockedUntil,
      revision: account.revision + 1,
      state: shouldLock ? "locked" : account.state,
      updatedAt: now,
    };
    await transaction.updateAccount(updated);
    return updated;
  }

  private validateAccountForLogin(
    account: CloudAccountRecord,
    now: Date,
  ): CloudServiceError | null {
    if (account.state === "pending_verification") {
      return emailUnverified();
    }
    return this.validateActiveAccount(account, now);
  }

  private validateActiveAccount(account: CloudAccountRecord, now: Date): CloudServiceError | null {
    if (
      account.state === "locked" &&
      account.lockedUntil !== null &&
      account.lockedUntil.getTime() > now.getTime()
    ) {
      return accountLocked();
    }
    if (account.state === "frozen") {
      return accountFrozen();
    }
    if (
      account.state === "deleted" ||
      account.state === "deletion_scheduled" ||
      account.state === "pending_verification"
    ) {
      return invalidCredentials();
    }
    return null;
  }

  private async upsertTrustedDevice(
    transaction: CloudIdentityTransaction,
    accountId: string,
    input: CloudDeviceRegistrationInput,
    now: Date,
    maximumDevices = this.maximumDevices,
  ): Promise<RegisteredDeviceRecord> {
    this.assertDeviceInput(input);
    const effectiveMaximumDevices = Math.min(this.maximumDevices, maximumDevices);
    const existing = await transaction.findDeviceById(input.deviceId, true);
    if (existing !== null) {
      if (existing.accountId !== accountId) {
        throw accessForbidden("The device identity belongs to another account.");
      }
      if (existing.state === "revoked") {
        throw deviceRevoked();
      }
      if (
        existing.publicKey !== input.publicKey ||
        existing.publicKeyFingerprint !== input.publicKeyFingerprint
      ) {
        throw accessForbidden("The device identity cannot replace its registered public key.");
      }
      const existingDevices = await transaction.listDevices(
        accountId,
        effectiveMaximumDevices + 1,
        null,
      );
      if (
        existingDevices.filter((device) => device.state === "trusted").length >
        effectiveMaximumDevices
      ) {
        throw trustedDeviceLimitReached();
      }
      if (
        existing.displayName === input.displayName &&
        existing.clientVersion === input.clientVersion
      ) {
        return existing;
      }
      const updated: RegisteredDeviceRecord = {
        ...existing,
        clientVersion: input.clientVersion,
        displayName: input.displayName,
        revision: existing.revision + 1,
        updatedAt: now,
      };
      await transaction.updateDevice(updated);
      return updated;
    }
    const fingerprintMatch = await transaction.findDeviceByFingerprint(
      accountId,
      input.publicKeyFingerprint,
      true,
    );
    if (fingerprintMatch !== null) {
      throw accessForbidden("The registered public key is bound to another device identity.");
    }
    const devices = await transaction.listDevices(accountId, effectiveMaximumDevices + 1, null);
    if (devices.filter((device) => device.state === "trusted").length >= effectiveMaximumDevices) {
      throw trustedDeviceLimitReached();
    }
    const created: RegisteredDeviceRecord = {
      ...input,
      accountId,
      createdAt: now,
      revision: 1,
      revokedAt: null,
      state: "trusted",
      updatedAt: now,
    };
    await transaction.insertDevice(created);
    return created;
  }

  private assertDeviceInput(input: CloudDeviceRegistrationInput): void {
    if (compareSemanticVersions(input.clientVersion, this.minimumClientVersion) < 0) {
      throw upgradeRequired();
    }
    if (
      !verifyDevicePublicKey({
        publicKey: input.publicKey,
        publicKeyFingerprint: input.publicKeyFingerprint,
      })
    ) {
      throw validationFailed("The device public key or fingerprint is invalid.");
    }
  }

  private createSession(
    accountId: string,
    device: RegisteredDeviceRecord,
    now: Date,
    refreshGeneration: number,
    maximumLifetimeMs = this.refreshTokenLifetimeMs,
    authenticationMethod: "password" | "oidc" = "password",
    absoluteExpiresAt: Date | null = null,
  ): SessionMaterial {
    const refreshLifetimeMs = Math.min(this.refreshTokenLifetimeMs, maximumLifetimeMs);
    if (
      !Number.isSafeInteger(refreshLifetimeMs) ||
      refreshLifetimeMs <= 1 ||
      (authenticationMethod === "oidc") !== (absoluteExpiresAt !== null)
    ) {
      throw sessionExpired();
    }
    const accessLifetimeMs = Math.min(this.accessTokenLifetimeMs, refreshLifetimeMs - 1);
    const sessionId = this.uuid();
    const accessToken = this.tokenService.deriveSessionToken(
      "access",
      sessionId,
      refreshGeneration,
    );
    const refreshToken = this.tokenService.deriveSessionToken(
      "refresh",
      sessionId,
      refreshGeneration,
    );
    return {
      accessToken,
      refreshToken,
      session: {
        accessTokenHashSha256: this.tokenService.hashBearerToken(accessToken),
        absoluteExpiresAt,
        accountId,
        authenticationMethod,
        clientVersion: device.clientVersion,
        deviceId: device.deviceId,
        expiresAt: addMilliseconds(now, accessLifetimeMs),
        issuedAt: now,
        lastSeenAt: now,
        minimumClientVersion: this.minimumClientVersion,
        refreshExpiresAt: addMilliseconds(now, refreshLifetimeMs),
        refreshGeneration,
        refreshTokenHashSha256: this.tokenService.hashBearerToken(refreshToken),
        replacedBySessionId: null,
        revokedAt: null,
        sessionId,
      },
    };
  }

  private toGrant(
    account: CloudAccountRecord,
    device: RegisteredDeviceRecord,
    material: SessionMaterial,
    requestId: string,
  ): CloudSessionGrantResponse {
    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId,
      account: toAccountContract(account),
      device: toDeviceContract(device),
      session: toSessionContract(material.session),
      tokens: {
        accessToken: material.accessToken,
        accessTokenExpiresAt: material.session.expiresAt.toISOString(),
        refreshToken: material.refreshToken,
        refreshTokenExpiresAt: material.session.refreshExpiresAt.toISOString(),
      },
    };
  }

  private replaySessionGrant(
    idempotency: CloudIdempotencyRecord,
    requestId: string,
  ): CloudSessionGrantResponse {
    if (idempotency.resultKind !== "session" || idempotency.resultResourceId === null) {
      throw new Error("The idempotency record does not reference a cloud session.");
    }
    const snapshot = parseSessionGrantSnapshot(idempotency.responseSnapshot);
    if (snapshot.grant.session.sessionId !== idempotency.resultResourceId) {
      throw new Error("The idempotent session snapshot crossed its resource scope.");
    }
    const accessToken = this.tokenService.deriveSessionToken(
      "access",
      snapshot.grant.session.sessionId,
      snapshot.tokenGeneration,
    );
    const refreshToken = this.tokenService.deriveSessionToken(
      "refresh",
      snapshot.grant.session.sessionId,
      snapshot.tokenGeneration,
    );
    const parsed = CloudSessionGrantResponseSchema.parse({
      schemaVersion: snapshot.grant.schemaVersion,
      requestId: snapshot.grant.requestId,
      account: snapshot.grant.account,
      device: snapshot.grant.device,
      session: snapshot.grant.session,
      tokens: {
        accessToken,
        accessTokenExpiresAt: snapshot.grant.session.expiresAt,
        refreshToken,
        refreshTokenExpiresAt: snapshot.grant.refreshTokenExpiresAt,
      },
    });
    if (hashCanonicalJson(parsed) !== idempotency.resultDigestSha256) {
      throw new Error("The idempotent session response snapshot digest is invalid.");
    }
    return { ...parsed, requestId };
  }

  private createChallenge(options: {
    readonly accountId: string | null;
    readonly email: string;
    readonly kind: IdentityChallengeRecord["kind"];
    readonly now: Date;
    readonly pendingPasswordHash: string | null;
  }): IdentityChallengeRecord {
    const challengeId = this.uuid();
    const code = this.tokenService.deriveChallengeCode(challengeId);
    return {
      accountId: options.accountId,
      attemptCount: 0,
      challengeId,
      codeHashSha256: this.tokenService.hashChallengeCode(challengeId, code),
      consumedAt: null,
      createdAt: options.now,
      emailCanonical: options.email,
      expiresAt: addMilliseconds(options.now, this.challengeLifetimeMs),
      kind: options.kind,
      notificationAttempts: 0,
      notifiedAt: null,
      pendingPasswordHash: options.pendingPasswordHash,
    };
  }

  private async deliverChallenge(challenge: IdentityChallengeRecord): Promise<void> {
    const attemptedAt = this.now();
    try {
      await this.notifier.deliver({
        challengeId: challenge.challengeId,
        code: this.tokenService.deriveChallengeCode(challenge.challengeId),
        email: challenge.emailCanonical,
        expiresAt: challenge.expiresAt.toISOString(),
        kind: challenge.kind,
      });
      await this.store.recordChallengeNotificationAttempt(challenge.challengeId, attemptedAt, true);
    } catch {
      try {
        await this.store.recordChallengeNotificationAttempt(
          challenge.challengeId,
          attemptedAt,
          false,
        );
      } catch {
        // Delivery failure remains the only externally visible result.
      }
      throw serviceUnavailable();
    }
  }

  private async replayChallenge(
    transaction: CloudIdentityTransaction,
    idempotency: CloudIdempotencyRecord,
    requestId: string,
    registration: boolean,
  ): Promise<ChallengeOutcome> {
    if (idempotency.resultKind !== "challenge" || idempotency.resultResourceId === null) {
      throw new Error("The idempotency record does not reference an identity challenge.");
    }
    const challenge = await transaction.findChallenge(idempotency.resultResourceId, false);
    if (challenge === null) {
      throw new Error("The idempotent identity challenge no longer exists.");
    }
    const response = replayIdentitySnapshot(
      CloudIdentityChallengeResponseSchema,
      idempotency,
      "challenge",
      requestId,
    );
    if (response.challengeId !== challenge.challengeId) {
      throw new Error("The idempotent challenge snapshot crossed its resource scope.");
    }
    const realRecipient = registration
      ? challenge.accountId === null
      : challenge.accountId !== null;
    return {
      challenge,
      notify: realRecipient && challenge.notifiedAt === null,
      response,
    };
  }

  private replayDevice(
    idempotency: CloudIdempotencyRecord,
    requestId: string,
  ): CloudDeviceResponse {
    if (idempotency.resultKind !== "device" || idempotency.resultResourceId === null) {
      throw new Error("The idempotency record does not reference a registered device.");
    }
    const response = replayIdentitySnapshot(
      CloudDeviceResponseSchema,
      idempotency,
      "device",
      requestId,
    );
    if (response.device.device.deviceId !== idempotency.resultResourceId) {
      throw new Error("The idempotent device snapshot crossed its resource scope.");
    }
    return response;
  }

  private async findIdempotency(
    transaction: CloudIdentityTransaction,
    operationId: CloudIdempotencyRecord["operationId"],
    actorAccountId: string | null,
    idempotencyKey: string,
    requestHash: string,
    now: Date,
  ): Promise<CloudIdempotencyRecord | null> {
    const scopeHash = createIdempotencyScopeHash({
      actorAccountId,
      idempotencyKey,
      operationId,
    });
    await transaction.lockIdempotency(scopeHash);
    const existing = await transaction.findIdempotency(scopeHash);
    if (existing === null) {
      return null;
    }
    if (
      existing.operationId !== operationId ||
      existing.requestHashSha256 !== requestHash ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      throw idempotencyConflict();
    }
    return existing;
  }

  private async insertIdempotency(
    transaction: CloudIdentityTransaction,
    options: {
      readonly actorAccountId: string | null;
      readonly context: CloudMutationContext;
      readonly now: Date;
      readonly operationId: CloudIdempotencyRecord["operationId"];
      readonly requestHash: string;
      readonly response: unknown;
      readonly responseSnapshot?: unknown;
      readonly responseStatus: number;
      readonly resultKind: CloudIdempotencyRecord["resultKind"];
      readonly resultResourceId: string | null;
    },
  ): Promise<void> {
    await transaction.insertIdempotency({
      actorAccountId: options.actorAccountId,
      createdAt: options.now,
      expiresAt: addMilliseconds(options.now, this.idempotencyLifetimeMs),
      idempotencyKeyHashSha256: hashUtf8(options.context.idempotencyKey),
      operationId: options.operationId,
      requestHashSha256: options.requestHash,
      responseSnapshot:
        options.responseSnapshot ??
        (options.resultKind === "accepted" ||
        options.resultKind === "challenge" ||
        options.resultKind === "device"
          ? options.response
          : null),
      responseStatus: options.responseStatus,
      resultDigestSha256: hashCanonicalJson(options.response),
      resultKind: options.resultKind,
      resultResourceId: options.resultResourceId,
      scopeHashSha256: createIdempotencyScopeHash({
        actorAccountId: options.actorAccountId,
        idempotencyKey: options.context.idempotencyKey,
        operationId: options.operationId,
      }),
    });
  }

  private auditEvent(options: {
    readonly action: string;
    readonly actorAccountId?: string | null;
    readonly actorDeviceId?: string | null;
    readonly context: CloudReadContext;
    readonly now: Date;
    readonly redactedDiff?: Readonly<Record<string, unknown>>;
    readonly resourceId: string | null;
    readonly resourceType: string;
    readonly result?: CloudAuditEventRecord["result"];
  }): CloudAuditEventRecord {
    return {
      action: options.action,
      actorAccountId: options.actorAccountId ?? null,
      actorDeviceId: options.actorDeviceId ?? null,
      createdAt: options.now,
      eventId: this.uuid(),
      redactedDiff: options.redactedDiff ?? {},
      requestId: options.context.requestId,
      resourceId: options.resourceId,
      resourceType: options.resourceType,
      result: options.result ?? "allowed",
      tenantId: null,
    };
  }

  private decodePageCursor(
    kind: "devices" | "sessions",
    cursor: string | null,
  ): ReturnType<CloudPageCursorCodec["decode"]> | null {
    if (cursor === null) {
      return null;
    }
    try {
      return this.pageCursorCodec.decode(kind, cursor);
    } catch (error) {
      if (error instanceof InvalidPageCursorError) {
        throw validationFailed("The page cursor is invalid.");
      }
      throw error;
    }
  }

  private now(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("The cloud-service clock returned an invalid timestamp.");
    }
    return new Date(now);
  }
}

function toAccountContract(account: CloudAccountRecord): CloudSessionGrantResponse["account"] {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    accountId: account.accountId,
    state: account.state,
    revision: account.revision,
    verifiedAt: account.verifiedAt?.toISOString() ?? null,
    deletionScheduledFor: account.deletionScheduledFor?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

function toDeviceContract(device: RegisteredDeviceRecord): CloudDeviceContract {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    device: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deviceId: device.deviceId,
      accountId: device.accountId,
      state: device.state,
      publicKeyFingerprint: device.publicKeyFingerprint,
      createdAt: device.createdAt.toISOString(),
      revokedAt: device.revokedAt?.toISOString() ?? null,
    },
    publicKey: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deviceId: device.deviceId,
      accountId: device.accountId,
      algorithm: device.algorithm,
      publicKey: device.publicKey,
      publicKeyFingerprint: device.publicKeyFingerprint,
      createdAt: device.createdAt.toISOString(),
      revokedAt: device.revokedAt?.toISOString() ?? null,
    },
    displayName: device.displayName,
    revision: device.revision,
  };
}

function toDeviceResponse(device: RegisteredDeviceRecord, requestId: string): CloudDeviceResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    device: toDeviceContract(device),
  };
}

interface StoredSessionGrantSnapshot {
  readonly snapshotKind: "session_grant_v1";
  readonly tokenGeneration: number;
  readonly grant: Omit<CloudSessionGrantResponse, "tokens"> & {
    readonly refreshTokenExpiresAt: string;
  };
}

function sessionGrantSnapshot(
  response: CloudSessionGrantResponse,
  tokenGeneration: number,
): StoredSessionGrantSnapshot {
  if (!Number.isSafeInteger(tokenGeneration) || tokenGeneration < 1) {
    throw new Error("The session token generation is invalid.");
  }
  return {
    snapshotKind: "session_grant_v1",
    tokenGeneration,
    grant: {
      schemaVersion: response.schemaVersion,
      requestId: response.requestId,
      account: response.account,
      device: response.device,
      session: response.session,
      refreshTokenExpiresAt: response.tokens.refreshTokenExpiresAt,
    },
  };
}

function parseSessionGrantSnapshot(value: unknown): StoredSessionGrantSnapshot {
  const snapshot = requireExactRecord(value, ["snapshotKind", "tokenGeneration", "grant"]);
  if (
    snapshot.snapshotKind !== "session_grant_v1" ||
    !Number.isSafeInteger(snapshot.tokenGeneration) ||
    (snapshot.tokenGeneration as number) < 1
  ) {
    throw new Error("The idempotent session response snapshot is invalid.");
  }
  const grant = requireExactRecord(snapshot.grant, [
    "schemaVersion",
    "requestId",
    "account",
    "device",
    "session",
    "refreshTokenExpiresAt",
  ]);
  if (typeof grant.refreshTokenExpiresAt !== "string") {
    throw new Error("The idempotent session response snapshot is invalid.");
  }
  return {
    snapshotKind: "session_grant_v1",
    tokenGeneration: snapshot.tokenGeneration as number,
    grant: grant as unknown as StoredSessionGrantSnapshot["grant"],
  };
}

function replayIdentitySnapshot<Output extends object>(
  schema: { readonly parse: (value: unknown) => Output },
  idempotency: CloudIdempotencyRecord,
  expectedKind: CloudIdempotencyRecord["resultKind"],
  requestId: string,
): Output {
  if (idempotency.resultKind !== expectedKind) {
    throw new Error("The identity idempotency record has an invalid result kind.");
  }
  const parsed = schema.parse(idempotency.responseSnapshot);
  if (hashCanonicalJson(parsed) !== idempotency.resultDigestSha256) {
    throw new Error("The identity idempotency response snapshot digest is invalid.");
  }
  return schema.parse({ ...parsed, requestId });
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("The idempotency response snapshot is invalid.");
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw new Error("The idempotency response snapshot is invalid.");
  }
  return record;
}

function toSessionContract(session: CloudSessionRecord): CloudSessionContract {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sessionId: session.sessionId,
    accountId: session.accountId,
    deviceId: session.deviceId,
    clientVersion: session.clientVersion,
    minimumClientVersion: session.minimumClientVersion,
    issuedAt: session.issuedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    revokedAt: session.revokedAt?.toISOString() ?? null,
  };
}

function toChallengeResponse(
  challenge: IdentityChallengeRecord,
  requestId: string,
): CloudIdentityChallengeResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    accepted: true,
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

function acceptedResponse(requestId: string, completedAt: Date): CloudMutationAcceptedResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId,
    accepted: true,
    completedAt: completedAt.toISOString(),
  };
}

function replayAccepted(
  idempotency: CloudIdempotencyRecord,
  requestId: string,
): CloudMutationAcceptedResponse {
  return replayIdentitySnapshot(
    CloudMutationAcceptedResponseSchema,
    idempotency,
    "accepted",
    requestId,
  );
}

function trustedDeviceLimitReached(): CloudServiceError {
  return new CloudServiceError({
    actions: ["OPEN_SETTINGS"],
    code: "ACCESS_FORBIDDEN",
    httpStatus: 409,
    message: "The trusted-device limit has been reached.",
  });
}

function unwrap<Value>(outcome: ServiceOutcome<Value>): Value {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function compareSemanticVersions(left: string, right: string): number {
  const leftParts = parseSemanticVersion(left);
  const rightParts = parseSemanticVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function parseSemanticVersion(value: string): readonly number[] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match === null) {
    throw validationFailed("The client version is invalid.");
  }
  return match.slice(1).map(Number);
}

function validateServiceOptions(service: {
  readonly accessTokenLifetimeMs: number;
  readonly challengeLifetimeMs: number;
  readonly idempotencyLifetimeMs: number;
  readonly lockoutDurationMs: number;
  readonly maximumDevices: number;
  readonly maximumLoginFailures: number;
  readonly pageSize: number;
  readonly refreshTokenLifetimeMs: number;
}): void {
  const positiveDurations = [
    service.accessTokenLifetimeMs,
    service.challengeLifetimeMs,
    service.idempotencyLifetimeMs,
    service.lockoutDurationMs,
    service.refreshTokenLifetimeMs,
  ];
  if (positiveDurations.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Cloud identity durations must be positive safe integers.");
  }
  if (service.refreshTokenLifetimeMs <= service.accessTokenLifetimeMs) {
    throw new Error("Refresh-token lifetime must exceed access-token lifetime.");
  }
  if (
    !Number.isSafeInteger(service.maximumDevices) ||
    service.maximumDevices < 1 ||
    service.maximumDevices > 1_024
  ) {
    throw new Error("The trusted-device limit is invalid.");
  }
  if (
    !Number.isSafeInteger(service.maximumLoginFailures) ||
    service.maximumLoginFailures < 1 ||
    service.maximumLoginFailures > 20
  ) {
    throw new Error("The login-failure limit is invalid.");
  }
  if (!Number.isSafeInteger(service.pageSize) || service.pageSize < 1 || service.pageSize > 1_023) {
    throw new Error("The cloud page size is invalid.");
  }
}
