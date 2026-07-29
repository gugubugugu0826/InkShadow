import {
  loadProjectSyncRegistrationInTransaction,
  transitionProjectSyncRegistrationInTransaction,
  type ProjectSyncRegistration,
  type SettleSyncIncrementalMaterializationInput,
  type SyncIncrementalSettlementFinalizer,
  type SyncIncrementalSettlementResult,
  type SyncIncrementalSettlementSqliteStore,
  type SyncMaterializationSqliteStore,
  type SyncMaterializedCheckpoint,
  type TransactionExecutor,
  type TransitionProjectSyncRegistrationInput,
} from "@inkshadow/data";
import { AppError, type Clock, type Result } from "@inkshadow/domain";

import type {
  CloudSyncInitialProjectionSeederPort,
  CloudSyncInitialProjectionSeedResult,
} from "./cloud-sync-snapshot-materialization-coordinator";

export type CloudSyncIncrementalSettlementPersistence = Pick<
  SyncIncrementalSettlementSqliteStore,
  "settleAtomically"
>;

export type CloudSyncIncrementalSettlementAuthority = Pick<
  SyncMaterializationSqliteStore,
  "loadMaterializedCheckpoint" | "loadProjectSyncRegistration"
>;

export interface CloudSyncIncrementalAtomicAuthority {
  loadRegistrationInTransaction(
    transaction: TransactionExecutor,
    projectId: string,
  ): Promise<Result<ProjectSyncRegistration | null, AppError>>;

  transitionRegistrationInTransaction(
    transaction: TransactionExecutor,
    input: TransitionProjectSyncRegistrationInput,
  ): Promise<Result<ProjectSyncRegistration, AppError>>;
}

export interface CloudSyncIncrementalSettlementCoordinatorDependencies {
  /**
   * Incremental plaintext settlement is opt-in and fail-closed.
   */
  readonly enabled?: boolean;
  readonly store: CloudSyncIncrementalSettlementPersistence;
  readonly authority: CloudSyncIncrementalSettlementAuthority;
  readonly seeder: CloudSyncInitialProjectionSeederPort;
  readonly clock: Clock;
  readonly atomicAuthority?: CloudSyncIncrementalAtomicAuthority;
}

export interface SettleCloudSyncIncrementalInput {
  readonly projectId: string;
  readonly activeAccountId: string;
  readonly activeDeviceId: string;
  readonly signedRemoteCursor: string;
  readonly downloadedCheckpointRevision: number;
  readonly signal?: AbortSignal;
}

export type CloudSyncIncrementalSettlementState =
  | "aborted"
  | "auth_blocked"
  | "bootstrap_required"
  | "conflict_blocked"
  | "disabled"
  | "permanent_paused"
  | "ready"
  | "retryable";

export type CloudSyncIncrementalSettlementFailureCategory =
  "auth_blocked" | "bootstrap_required" | "conflict_blocked" | "permanent_paused" | "retryable";

export interface CloudSyncIncrementalSettlementResult {
  readonly projectId: string;
  readonly state: CloudSyncIncrementalSettlementState;
  readonly pushAllowed: boolean;
  readonly checkpoint: SyncMaterializedCheckpoint | null;
  readonly checkpointAdvanced: boolean;
  readonly registrationEnabled: boolean;
  readonly seededJobs: number;
  readonly skippedSeedJobs: number;
  readonly failure: Readonly<{
    category: CloudSyncIncrementalSettlementFailureCategory;
    code: string;
  }> | null;
}

const DEFAULT_ATOMIC_AUTHORITY: CloudSyncIncrementalAtomicAuthority = {
  loadRegistrationInTransaction: loadProjectSyncRegistrationInTransaction,
  transitionRegistrationInTransaction: transitionProjectSyncRegistrationInTransaction,
};

/**
 * Closes the incremental pull -> plaintext -> push boundary.
 *
 * For first-time enablement, the materialized checkpoint, enabled
 * registration, and initial local projection jobs commit together. For an
 * already-enabled project, only the exact plaintext checkpoint advances.
 */
export class CloudSyncIncrementalSettlementCoordinator {
  private readonly enabled: boolean;
  private readonly store: CloudSyncIncrementalSettlementPersistence;
  private readonly authority: CloudSyncIncrementalSettlementAuthority;
  private readonly seeder: CloudSyncInitialProjectionSeederPort;
  private readonly clock: Clock;
  private readonly atomicAuthority: CloudSyncIncrementalAtomicAuthority;
  private readonly activeProjects = new Map<
    string,
    Promise<CloudSyncIncrementalSettlementResult>
  >();

  public constructor(dependencies: CloudSyncIncrementalSettlementCoordinatorDependencies) {
    this.enabled = dependencies.enabled === true;
    this.store = dependencies.store;
    this.authority = dependencies.authority;
    this.seeder = dependencies.seeder;
    this.clock = dependencies.clock;
    this.atomicAuthority = dependencies.atomicAuthority ?? DEFAULT_ATOMIC_AUTHORITY;
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public settleProjectIncremental(
    input: SettleCloudSyncIncrementalInput,
  ): Promise<CloudSyncIncrementalSettlementResult> {
    const active = this.activeProjects.get(input.projectId);
    if (active !== undefined) {
      return active;
    }
    const run = this.execute(input).finally(() => {
      if (this.activeProjects.get(input.projectId) === run) {
        this.activeProjects.delete(input.projectId);
      }
    });
    this.activeProjects.set(input.projectId, run);
    return run;
  }

  private async execute(
    input: SettleCloudSyncIncrementalInput,
  ): Promise<CloudSyncIncrementalSettlementResult> {
    if (!this.enabled) {
      return outcome(input.projectId, "disabled");
    }
    if (isAborted(input.signal)) {
      return outcome(input.projectId, "aborted");
    }

    const registrationResult = await this.authority.loadProjectSyncRegistration(input.projectId);
    if (!registrationResult.ok) {
      return failureOutcome(input.projectId, registrationResult.error);
    }
    const registration = registrationResult.value;
    if (registration === null || registration.state === "disabled") {
      return outcome(input.projectId, "auth_blocked", {
        failure: { category: "auth_blocked", code: "SYNC_REGISTRATION_MISSING" },
      });
    }
    if (
      registration.accountId !== input.activeAccountId ||
      registration.deviceId !== input.activeDeviceId
    ) {
      return outcome(input.projectId, "auth_blocked", {
        failure: { category: "auth_blocked", code: "SYNC_SESSION_AUTHORITY_MISMATCH" },
      });
    }
    if (registration.state === "bootstrap_required") {
      return outcome(input.projectId, "bootstrap_required", {
        failure: { category: "bootstrap_required", code: "SYNC_SNAPSHOT_BOOTSTRAP_REQUIRED" },
      });
    }
    if (
      registration.state !== "enabling" &&
      !(registration.state === "enabled" && registration.plaintextBootstrapCompleted)
    ) {
      return outcome(input.projectId, "permanent_paused", {
        failure: {
          category: "permanent_paused",
          code: "SYNC_INCREMENTAL_REGISTRATION_INVALID",
        },
      });
    }
    const frozenRegistration = Object.freeze({ ...registration });
    const checkpointResult = await this.authority.loadMaterializedCheckpoint(input.projectId);
    if (!checkpointResult.ok) {
      return failureOutcome(input.projectId, checkpointResult.error);
    }
    const previousCheckpoint = checkpointResult.value;
    if (isAborted(input.signal)) {
      return outcome(input.projectId, "aborted");
    }

    const settledAt = maximumTimestamp(
      this.clock.now(),
      frozenRegistration.updatedAt,
      previousCheckpoint?.updatedAt,
    );
    const seedReceipt: { value?: CloudSyncInitialProjectionSeedResult } = {};
    let registrationEnabled = false;
    const finalizer: SyncIncrementalSettlementFinalizer = async (transaction, settlement) => {
      if (isAborted(input.signal)) {
        throw controlError("SYNC_INCREMENTAL_SETTLEMENT_ABORTED");
      }
      const exactRegistration = requireResult(
        await this.atomicAuthority.loadRegistrationInTransaction(transaction, input.projectId),
      );
      requireExactRegistration(exactRegistration, frozenRegistration);
      if (frozenRegistration.state === "enabled") {
        registrationEnabled = true;
        return;
      }
      const enabledRegistration = requireResult(
        await this.atomicAuthority.transitionRegistrationInTransaction(transaction, {
          projectId: frozenRegistration.projectId,
          expectedAccountId: frozenRegistration.accountId,
          expectedDeviceId: frozenRegistration.deviceId,
          expectedConsentRevision: frozenRegistration.consentRevision,
          expectedKeyVersion: frozenRegistration.keyVersion,
          expectedRevision: frozenRegistration.revision,
          target: { state: "enabled" },
          transitionedAt: settlement.target.settledAt,
        }),
      );
      seedReceipt.value = await this.seeder.seedProjectInTransaction(
        transaction,
        enabledRegistration,
        settlement.target.settledAt,
      );
      registrationEnabled = true;
    };

    const settlementInput: SettleSyncIncrementalMaterializationInput = {
      projectId: input.projectId,
      signedRemoteCursor: input.signedRemoteCursor,
      downloadedCheckpointRevision: input.downloadedCheckpointRevision,
      expectedMaterializedCheckpointRevision: previousCheckpoint?.revision ?? null,
      settledAt,
    };
    const settlementResult = await this.store.settleAtomically(settlementInput, finalizer);
    if (!settlementResult.ok) {
      if (settlementResult.error.details.operation === "SYNC_INCREMENTAL_SETTLEMENT_ABORTED") {
        return outcome(input.projectId, "aborted");
      }
      return failureOutcome(input.projectId, settlementResult.error);
    }
    return fromSettlement(
      input.projectId,
      settlementResult.value,
      registrationEnabled,
      seedReceipt.value,
    );
  }
}

function fromSettlement(
  projectId: string,
  settlement: SyncIncrementalSettlementResult,
  registrationEnabled: boolean,
  seeds: CloudSyncInitialProjectionSeedResult | undefined,
): CloudSyncIncrementalSettlementResult {
  if (settlement.status === "settled") {
    if (!registrationEnabled) {
      return outcome(projectId, "permanent_paused", {
        failure: {
          category: "permanent_paused",
          code: "SYNC_INCREMENTAL_FINALIZER_NOT_EXECUTED",
        },
      });
    }
    return outcome(projectId, "ready", {
      pushAllowed: true,
      checkpoint: settlement.checkpoint,
      checkpointAdvanced: settlement.checkpointAdvanced,
      registrationEnabled: true,
      seededJobs: seeds?.enqueuedJobIds.length ?? 0,
      skippedSeedJobs: seeds?.skippedJobIds.length ?? 0,
    });
  }
  switch (settlement.reason) {
    case "snapshot_pending":
      return outcome(projectId, "bootstrap_required", {
        failure: { category: "bootstrap_required", code: "SYNC_SNAPSHOT_BOOTSTRAP_REQUIRED" },
      });
    case "incoming_conflict":
    case "content_conflict":
      return outcome(projectId, "conflict_blocked", {
        failure: { category: "conflict_blocked", code: "SYNC_CONTENT_CONFLICT" },
      });
    case "incoming_attempt_exhausted":
      return outcome(projectId, "permanent_paused", {
        failure: {
          category: "permanent_paused",
          code: "SYNC_INCOMING_ATTEMPT_BUDGET_EXHAUSTED",
        },
      });
    case "incoming_permanent_failure":
      return outcome(projectId, "permanent_paused", {
        failure: {
          category: "permanent_paused",
          code: "SYNC_INCOMING_MATERIALIZATION_PERMANENT_FAILURE",
        },
      });
    case "incoming_pending":
      return outcome(projectId, "retryable", {
        failure: { category: "retryable", code: "SYNC_INCOMING_MATERIALIZATION_PENDING" },
      });
    case "pull_incomplete":
      return outcome(projectId, "retryable", {
        failure: { category: "retryable", code: "SYNC_INCREMENTAL_PULL_INCOMPLETE" },
      });
  }
}

function failureOutcome(projectId: string, error: AppError): CloudSyncIncrementalSettlementResult {
  const retryable = error.retryable || error.code === "INVALID_STATE_TRANSITION";
  return outcome(projectId, retryable ? "retryable" : "permanent_paused", {
    failure: {
      category: retryable ? "retryable" : "permanent_paused",
      code: normalizeCode(error.code, "SYNC_INCREMENTAL_SETTLEMENT_FAILED"),
    },
  });
}

function requireExactRegistration(
  current: ProjectSyncRegistration | null,
  frozen: ProjectSyncRegistration,
): asserts current is ProjectSyncRegistration {
  const exact =
    current !== null &&
    current.projectId === frozen.projectId &&
    current.accountId === frozen.accountId &&
    current.deviceId === frozen.deviceId &&
    current.state === frozen.state &&
    current.consentRevision === frozen.consentRevision &&
    current.keyVersion === frozen.keyVersion &&
    current.revision === frozen.revision &&
    current.plaintextBootstrapCompleted === frozen.plaintextBootstrapCompleted;
  if (!exact) {
    throw new AppError({
      code: "INVALID_STATE_TRANSITION",
      message: "The project sync authority changed during incremental settlement.",
      actions: ["RETRY", "OPEN_SETTINGS"],
    });
  }
}

function outcome(
  projectId: string,
  state: CloudSyncIncrementalSettlementState,
  overrides: Partial<CloudSyncIncrementalSettlementResult> = {},
): CloudSyncIncrementalSettlementResult {
  return {
    projectId,
    state,
    pushAllowed: false,
    checkpoint: null,
    checkpointAdvanced: false,
    registrationEnabled: false,
    seededJobs: 0,
    skippedSeedJobs: 0,
    failure: null,
    ...overrides,
  };
}

function maximumTimestamp(...values: readonly (string | null | undefined)[]): string {
  let maximum = "";
  let maximumTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const time = Date.parse(value);
    if (!Number.isFinite(time)) {
      throw new AppError({
        code: "REPOSITORY_ERROR",
        message: "Incremental settlement encountered a non-canonical timestamp.",
        actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
      });
    }
    if (time > maximumTime) {
      maximum = value;
      maximumTime = time;
    }
  }
  if (maximum === "") {
    throw new AppError({
      code: "REPOSITORY_ERROR",
      message: "Incremental settlement could not establish a transaction time.",
      actions: ["OPEN_SETTINGS", "CONTACT_SUPPORT"],
    });
  }
  return maximum;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function requireResult<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function controlError(operation: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message: "Incremental settlement was aborted before its atomic boundary.",
    retryable: true,
    actions: ["RETRY"],
    details: { operation },
  });
}

function normalizeCode(value: string, fallback: string): string {
  return /^[A-Z][A-Z0-9_]{2,127}$/u.test(value) ? value : fallback;
}
