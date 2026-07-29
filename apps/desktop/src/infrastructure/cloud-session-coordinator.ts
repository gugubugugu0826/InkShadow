import { CloudClientError } from "@inkshadow/cloud-client";
import type { Clock } from "@inkshadow/domain";

import type { CloudSessionVaultStatus } from "./cloud-session-vault";

const DEFAULT_MINIMUM_ACCESS_VALIDITY_MS = 60_000;

export type CloudSessionBlockReason =
  "account_blocked" | "device_revoked" | "reauth_required" | "version_incompatible";

export class CloudSessionCoordinatorError extends Error {
  public readonly reason: CloudSessionBlockReason;
  public readonly sourceCode: string;

  public constructor(reason: CloudSessionBlockReason, sourceCode: string, message: string) {
    super(message);
    this.name = "CloudSessionCoordinatorError";
    this.reason = reason;
    this.sourceCode = sourceCode;
  }
}

export interface CloudIdentitySessionPort {
  readonly available: boolean;
  getStatus(): Promise<CloudSessionVaultStatus>;
  refresh(expectedSessionId: string): Promise<CloudSessionVaultStatus>;
  clearLocalSession(expectedSessionId: string): Promise<CloudSessionVaultStatus>;
  disableAfterReconciliationFailure(): void;
}

export interface CloudSessionCoordinatorOptions {
  readonly minimumAccessValidityMs?: number;
}

export interface CloudSessionOperationOptions {
  readonly signal?: AbortSignal;
}

export type ConfiguredCloudSessionStatus = CloudSessionVaultStatus & {
  readonly configured: true;
  readonly account: NonNullable<CloudSessionVaultStatus["account"]>;
  readonly device: NonNullable<CloudSessionVaultStatus["device"]>;
  readonly session: NonNullable<CloudSessionVaultStatus["session"]>;
  readonly expiry: NonNullable<CloudSessionVaultStatus["expiry"]>;
};

/**
 * Keeps access-token rotation behind CloudIdentityService's native vault
 * boundary. The coordinator sees only public session metadata and serializes
 * refreshes so concurrent cloud callers cannot replay a refresh credential.
 */
export class CloudSessionCoordinator {
  private readonly minimumAccessValidityMs: number;
  private refreshFlight: Promise<CloudSessionVaultStatus> | null = null;

  public constructor(
    private readonly identity: CloudIdentitySessionPort,
    private readonly clock: Clock,
    options: CloudSessionCoordinatorOptions = {},
  ) {
    this.minimumAccessValidityMs = boundedValidityWindow(
      options.minimumAccessValidityMs ?? DEFAULT_MINIMUM_ACCESS_VALIDITY_MS,
    );
  }

  public async ensureReady(
    options: CloudSessionOperationOptions = {},
  ): Promise<ConfiguredCloudSessionStatus> {
    throwIfAborted(options.signal);
    if (!this.identity.available) {
      throw blocked(
        "reauth_required",
        "CLOUD_IDENTITY_UNAVAILABLE",
        "Cloud identity is unavailable until local session state is reconciled.",
      );
    }
    const status = await this.identity.getStatus();
    requireConfigured(status);
    throwIfAborted(options.signal);

    const now = Date.parse(this.clock.now());
    const accessExpiresAt = Date.parse(status.expiry.accessExpiresAt);
    const refreshExpiresAt = Date.parse(status.expiry.refreshExpiresAt);
    if (refreshExpiresAt <= now) {
      await this.clearExpired(status.session.sessionId);
      throw blocked(
        "reauth_required",
        "AUTH_REFRESH_EXPIRED",
        "The cloud session must be authenticated again.",
      );
    }
    if (accessExpiresAt - now > this.minimumAccessValidityMs) {
      return status;
    }
    return this.refresh(status.session.sessionId, options.signal);
  }

  public async runWithSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
    options: CloudSessionOperationOptions = {},
  ): Promise<Value> {
    const initial = await this.ensureReady(options);
    throwIfAborted(options.signal);
    try {
      return await operation(initial);
    } catch (cause: unknown) {
      if (!(cause instanceof CloudClientError) || cause.code !== "AUTH_SESSION_EXPIRED") {
        throw classifyTerminalCloudError(cause);
      }
      throwIfAborted(options.signal);
      const refreshed = await this.recoverExpiredAccess(initial.session.sessionId, options.signal);
      throwIfAborted(options.signal);
      return operation(refreshed);
    }
  }

  private async recoverExpiredAccess(
    observedSessionId: string,
    signal: AbortSignal | undefined,
  ): Promise<ConfiguredCloudSessionStatus> {
    const current = await this.identity.getStatus();
    requireConfigured(current);
    throwIfAborted(signal);
    if (current.session.sessionId !== observedSessionId) {
      return current;
    }
    return this.refresh(observedSessionId, signal);
  }

  private refresh(
    expectedSessionId: string,
    signal: AbortSignal | undefined,
  ): Promise<ConfiguredCloudSessionStatus> {
    throwIfAborted(signal);
    const existing = this.refreshFlight;
    if (existing !== null) {
      return existing.then((status) => {
        requireConfigured(status);
        return status;
      });
    }
    const flight = this.identity
      .refresh(expectedSessionId)
      .catch(async (cause: unknown) => {
        const classified = classifyTerminalCloudError(cause);
        if (classified instanceof CloudSessionCoordinatorError) {
          await this.clearAfterTerminalFailure(expectedSessionId);
        }
        throw classified;
      })
      .finally(() => {
        if (this.refreshFlight === flight) {
          this.refreshFlight = null;
        }
      });
    this.refreshFlight = flight;
    return flight.then((status) => {
      requireConfigured(status);
      return status;
    });
  }

  private async clearExpired(expectedSessionId: string): Promise<void> {
    try {
      await this.identity.clearLocalSession(expectedSessionId);
    } catch {
      this.identity.disableAfterReconciliationFailure();
    }
  }

  private async clearAfterTerminalFailure(expectedSessionId: string): Promise<void> {
    try {
      await this.identity.clearLocalSession(expectedSessionId);
    } catch {
      this.identity.disableAfterReconciliationFailure();
    }
  }
}

function requireConfigured(
  status: CloudSessionVaultStatus,
): asserts status is ConfiguredCloudSessionStatus {
  if (
    !status.configured ||
    status.account === null ||
    status.device === null ||
    status.session === null ||
    status.expiry === null
  ) {
    throw blocked(
      "reauth_required",
      "AUTH_SESSION_REQUIRED",
      "A configured cloud session is required.",
    );
  }
}

function classifyTerminalCloudError(cause: unknown): unknown {
  if (!(cause instanceof CloudClientError)) {
    return cause;
  }
  switch (cause.code) {
    case "AUTH_DEVICE_REVOKED":
      return blocked("device_revoked", cause.code, "This device no longer has cloud access.");
    case "AUTH_UPGRADE_REQUIRED":
      return blocked(
        "version_incompatible",
        cause.code,
        "The desktop app must be updated before cloud access can continue.",
      );
    case "AUTH_ACCOUNT_FROZEN":
    case "AUTH_ACCOUNT_LOCKED":
      return blocked("account_blocked", cause.code, "The cloud account is temporarily blocked.");
    case "AUTH_REFRESH_REPLAYED":
    case "AUTH_SESSION_REVOKED":
      return blocked(
        "reauth_required",
        cause.code,
        "The cloud session must be authenticated again.",
      );
    default:
      return cause;
  }
}

function blocked(
  reason: CloudSessionBlockReason,
  sourceCode: string,
  message: string,
): CloudSessionCoordinatorError {
  return new CloudSessionCoordinatorError(reason, sourceCode, message);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The cloud operation was aborted.", "AbortError");
  }
}

function boundedValidityWindow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5_000 || value > 15 * 60_000) {
    throw new RangeError("minimumAccessValidityMs is outside the supported range.");
  }
  return value;
}
