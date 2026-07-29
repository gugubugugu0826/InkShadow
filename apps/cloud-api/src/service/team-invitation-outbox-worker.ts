import type { TeamInvitationOutboxStore } from "../repository/team-invitation-outbox-store.js";
import type { TeamInvitationTokenProtector } from "../security/team-invitation-token-protector.js";

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_MAXIMUM_ATTEMPTS = 8;
const DEFAULT_MAXIMUM_RETRY_DELAY_MS = 60 * 60 * 1_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEIDENTIFIED_EMAIL_SUFFIX = "@deleted.invalid";

export interface TeamInvitationOutboxDelivery {
  readonly deliveryId: string;
  readonly expiresAt: string;
  readonly invitationId: string;
  readonly invitationToken: string;
  readonly inviteeEmail: string;
  readonly role: "admin" | "author" | "finance_admin" | "read_only" | "reviewer";
  readonly teamDisplayName: string;
  readonly teamId: string;
}

/**
 * Implementations must use deliveryId as the downstream idempotency key. Every
 * retry for a logical invitation uses the same value.
 */
export interface TeamInvitationOutboxDeliveryPort {
  deliver(delivery: TeamInvitationOutboxDelivery): Promise<void>;
}

export interface TeamInvitationOutboxWorkerOptions {
  readonly batchSize?: number;
  readonly clock?: () => Date;
  readonly delivery: TeamInvitationOutboxDeliveryPort;
  readonly leaseDurationMs?: number;
  readonly maximumAttempts?: number;
  readonly maximumRetryDelayMs?: number;
  readonly protector: TeamInvitationTokenProtector;
  readonly retryDelayMs?: number;
  readonly store: TeamInvitationOutboxStore;
  readonly workerId: string;
}

export interface TeamInvitationOutboxRunResult {
  readonly cancelled: number;
  readonly claimLost: number;
  readonly claimed: number;
  readonly deadLettered: number;
  readonly delivered: number;
  readonly retried: number;
}

type AppliedDecision = Exclude<
  Awaited<ReturnType<TeamInvitationOutboxStore["executeWithFence"]>>,
  { readonly kind: "claim_lost" }
>["decision"];

export class TeamInvitationOutboxWorker {
  private readonly batchSize: number;
  private readonly clock: () => Date;
  private readonly delivery: TeamInvitationOutboxDeliveryPort;
  private readonly leaseDurationMs: number;
  private readonly maximumAttempts: number;
  private readonly maximumRetryDelayMs: number;
  private readonly protector: TeamInvitationTokenProtector;
  private readonly retryDelayMs: number;
  private readonly store: TeamInvitationOutboxStore;
  private readonly workerId: string;

  public constructor(options: TeamInvitationOutboxWorkerOptions) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.clock = options.clock ?? (() => new Date());
    this.delivery = options.delivery;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.maximumAttempts = options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
    this.maximumRetryDelayMs = options.maximumRetryDelayMs ?? DEFAULT_MAXIMUM_RETRY_DELAY_MS;
    this.protector = options.protector;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.store = options.store;
    this.workerId = options.workerId;

    requireIntegerInRange(this.batchSize, 1, 256, "outbox batch size");
    requireIntegerInRange(this.leaseDurationMs, 1_000, 10 * 60 * 1_000, "outbox lease duration");
    requireIntegerInRange(this.maximumAttempts, 1, 1_000, "outbox maximum attempts");
    requireIntegerInRange(this.retryDelayMs, 1_000, 24 * 60 * 60 * 1_000, "outbox retry delay");
    requireIntegerInRange(
      this.maximumRetryDelayMs,
      this.retryDelayMs,
      7 * 24 * 60 * 60 * 1_000,
      "outbox maximum retry delay",
    );
    if (!isUuid(this.workerId)) {
      throw new Error("The team-invitation outbox worker id must be a UUID.");
    }
  }

  public async runOnce(): Promise<TeamInvitationOutboxRunResult> {
    const claimTime = this.now();
    const claimed = await this.store.claim({
      leaseExpiresAt: addMilliseconds(claimTime, this.leaseDurationMs),
      limit: this.batchSize,
      now: claimTime,
      workerId: this.workerId,
    });
    const outcomes = await Promise.all(
      claimed.map(async (claim): Promise<AppliedDecision | "claim_lost"> => {
        const executionTime = this.now();
        const result = await this.store.executeWithFence({
          deliveryId: claim.deliveryId,
          expectedRevision: claim.revision,
          now: executionTime,
          operation: async (current) => {
            if (current.invitationState !== "pending") {
              return {
                errorCode: "INVITATION_NOT_PENDING",
                kind: "cancel",
              };
            }
            if (current.teamState !== "active") {
              return { errorCode: "TEAM_NOT_ACTIVE", kind: "cancel" };
            }
            if (current.invitationExpiresAt.getTime() <= executionTime.getTime()) {
              return { errorCode: "INVITATION_EXPIRED", kind: "cancel" };
            }
            if (!isDeliverableEmail(current.inviteeEmail)) {
              return {
                errorCode: "INVITATION_RECIPIENT_UNAVAILABLE",
                kind: "cancel",
              };
            }

            let invitationToken: string;
            try {
              invitationToken = this.protector.unprotect(
                {
                  authTag: current.tokenAuthTag,
                  ciphertext: current.tokenCiphertext,
                  encryptionKeyId: current.encryptionKeyId,
                  nonce: current.tokenNonce,
                },
                {
                  deliveryId: current.deliveryId,
                  invitationId: current.invitationId,
                  teamId: current.teamId,
                  tenantId: current.tenantId,
                },
              );
            } catch {
              return {
                availableAt: executionTime,
                deadLetter: true,
                errorCode: "TOKEN_DECRYPTION_FAILED",
                kind: "retry",
              };
            }

            try {
              await this.delivery.deliver({
                deliveryId: current.deliveryId,
                expiresAt: current.invitationExpiresAt.toISOString(),
                invitationId: current.invitationId,
                invitationToken,
                inviteeEmail: current.inviteeEmail,
                role: current.invitationRole,
                teamDisplayName: current.teamDisplayName,
                teamId: current.teamId,
              });
              return { kind: "delivered" };
            } catch {
              const deadLetter = current.attemptCount >= this.maximumAttempts;
              return {
                availableAt: deadLetter
                  ? executionTime
                  : addMilliseconds(
                      executionTime,
                      calculateRetryDelay(
                        current.attemptCount,
                        this.retryDelayMs,
                        this.maximumRetryDelayMs,
                      ),
                    ),
                deadLetter,
                errorCode: "DELIVERY_FAILED",
                kind: "retry",
              };
            }
          },
          workerId: this.workerId,
        });
        return result.kind === "claim_lost" ? "claim_lost" : result.decision;
      }),
    );

    return {
      cancelled: count(outcomes, "cancel"),
      claimLost: count(outcomes, "claim_lost"),
      claimed: claimed.length,
      deadLettered: outcomes.filter(
        (outcome) => outcome !== "claim_lost" && outcome.kind === "retry" && outcome.deadLetter,
      ).length,
      delivered: count(outcomes, "delivered"),
      retried: outcomes.filter(
        (outcome) => outcome !== "claim_lost" && outcome.kind === "retry" && !outcome.deadLetter,
      ).length,
    };
  }

  private now(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("The team-invitation outbox worker clock returned an invalid date.");
    }
    return new Date(now);
  }
}

function count(
  outcomes: readonly (AppliedDecision | "claim_lost")[],
  expected: AppliedDecision["kind"] | "claim_lost",
): number {
  return outcomes.filter((outcome) =>
    outcome === "claim_lost" ? outcome === expected : outcome.kind === expected,
  ).length;
}

function calculateRetryDelay(
  attemptCount: number,
  initialDelayMs: number,
  maximumDelayMs: number,
): number {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  return Math.min(initialDelayMs * 2 ** exponent, maximumDelayMs);
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function isDeliverableEmail(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 320 &&
    value === value.trim().toLowerCase() &&
    value.includes("@") &&
    !value.endsWith(DEIDENTIFIED_EMAIL_SUFFIX) &&
    !/[\s\r\n]/u.test(value)
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function requireIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`The ${label} is invalid.`);
  }
}
