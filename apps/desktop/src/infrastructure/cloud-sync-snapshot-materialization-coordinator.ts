import {
  advanceSyncMaterializedCheckpointInTransaction,
  transitionProjectSyncRegistrationInTransaction,
  type AdvanceSyncMaterializedCheckpointInput,
  type ProjectSyncRegistration,
  type SnapshotMaterializationDecision,
  type SnapshotMaterializationIdentity,
  type SnapshotMaterializationState,
  type SnapshotMaterializationTarget,
  type SnapshotMaterializationWork,
  type SyncMaterializedCheckpoint,
  type SyncSnapshotMaterializationSqliteStore,
  type SyncMaterializationSqliteStore,
  type TransactionExecutor,
  type TransitionProjectSyncRegistrationInput,
} from "@inkshadow/data";
import { AppError, type Clock, type Result } from "@inkshadow/domain";
import { SyncCoreError } from "@inkshadow/sync-core";

import type {
  ContentSyncMaterializationOutcome,
  ContentSyncMaterializer,
} from "./content-sync-materializer";
import type { PreparedIncomingContentMutation } from "./incoming-content-decryptor";

const DEFAULT_MAXIMUM_WORK_ITEMS = 128;
const MAXIMUM_WORK_ITEMS_LIMIT = 4_096;
const CONTROL_OPERATION = "CLOUD_SYNC_SNAPSHOT_MATERIALIZATION_CONTROL";
const CONTENT_CONFLICT_CODE = "SYNC_CONTENT_CONFLICT";

export type CloudSyncSnapshotMaterializationPersistence = Pick<
  SyncSnapshotMaterializationSqliteStore,
  | "finalizeAtomically"
  | "loadNextPendingWork"
  | "readCommittedTarget"
  | "readState"
  | "resolveWorkAtomically"
>;

export type CloudSyncSnapshotMaterializationAuthority = Pick<
  SyncMaterializationSqliteStore,
  "loadMaterializedCheckpoint" | "loadProjectSyncRegistration" | "transitionProjectSyncRegistration"
>;

export type CloudSyncSnapshotContentMaterializer = Pick<
  ContentSyncMaterializer,
  "applyPrepared" | "prepare"
>;

export interface CloudSyncInitialProjectionSeedResult {
  readonly projectId: string;
  readonly enqueuedJobIds: readonly string[];
  readonly skippedJobIds: readonly string[];
}

/**
 * Kept structural so this coordinator does not create an import cycle with the
 * initial projection seeder. The concrete seeder owns UUIDv7 generation.
 */
export interface CloudSyncInitialProjectionSeederPort {
  seedProjectInTransaction(
    transaction: TransactionExecutor,
    enabledRegistration: ProjectSyncRegistration,
    seededAt: string,
  ): Promise<CloudSyncInitialProjectionSeedResult>;
}

export interface CloudSyncSnapshotMaterializationAtomicAuthority {
  advanceMaterializedCheckpointInTransaction(
    transaction: TransactionExecutor,
    input: AdvanceSyncMaterializedCheckpointInput,
  ): Promise<Result<SyncMaterializedCheckpoint, AppError>>;

  transitionRegistrationInTransaction(
    transaction: TransactionExecutor,
    input: TransitionProjectSyncRegistrationInput,
  ): Promise<Result<ProjectSyncRegistration, AppError>>;
}

export interface CloudSyncSnapshotMaterializationLimits {
  readonly maximumWorkItems?: number;
}

export interface CloudSyncSnapshotMaterializationCoordinatorDependencies {
  /**
   * Plaintext bootstrap remains opt-in. Omitting this flag performs no reads,
   * decryptions, writes, or registration transitions.
   */
  readonly enabled?: boolean;
  readonly snapshotStore: CloudSyncSnapshotMaterializationPersistence;
  readonly authority: CloudSyncSnapshotMaterializationAuthority;
  readonly materializer: CloudSyncSnapshotContentMaterializer;
  readonly seeder: CloudSyncInitialProjectionSeederPort;
  readonly clock: Clock;
  readonly limits?: CloudSyncSnapshotMaterializationLimits;
  /**
   * Production uses the data authority's caller-owned transaction helpers.
   * This narrow override exists for deterministic boundary testing.
   */
  readonly atomicAuthority?: CloudSyncSnapshotMaterializationAtomicAuthority;
}

export interface RunCloudSyncSnapshotMaterializationOptions {
  readonly signal?: AbortSignal;
}

export type CloudSyncSnapshotMaterializationState =
  | "aborted"
  | "conflict_blocked"
  | "disabled"
  | "permanent_paused"
  | "plaintext_bootstrap_completed"
  | "retryable";

export type CloudSyncSnapshotMaterializationFailureCategory =
  "conflict_blocked" | "permanent_paused" | "retryable";

export interface CloudSyncSnapshotMaterializationFailure {
  readonly category: CloudSyncSnapshotMaterializationFailureCategory;
  readonly code: string;
}

/**
 * No state in this result calls a ciphertext-only or partially materialized
 * snapshot "synced". Push opens only after the final atomic plaintext boundary.
 */
export interface CloudSyncSnapshotMaterializationResult {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly state: CloudSyncSnapshotMaterializationState;
  readonly pushAllowed: boolean;
  readonly plaintextMaterializationRequired: boolean;
  readonly completion: "already_completed" | "finalized" | null;
  readonly attemptedWorkItems: number;
  readonly appliedReceipts: number;
  readonly skippedReceipts: number;
  readonly conflictReceipts: number;
  readonly seededJobs: number;
  readonly skippedSeedJobs: number;
  readonly permanentPausePersisted: boolean;
  readonly failure: CloudSyncSnapshotMaterializationFailure | null;
}

interface MaterializationCounters {
  attemptedWorkItems: number;
  appliedReceipts: number;
  skippedReceipts: number;
  conflictReceipts: number;
}

interface ClassifiedFailure {
  readonly disposition: "permanent" | "retry";
  readonly code: string;
}

interface MaterializationControl {
  readonly kind: "permanent" | "retry";
  readonly code: string;
}

interface NormalizedLimits {
  readonly maximumWorkItems: number;
}

const DEFAULT_ATOMIC_AUTHORITY: CloudSyncSnapshotMaterializationAtomicAuthority = {
  advanceMaterializedCheckpointInTransaction: advanceSyncMaterializedCheckpointInTransaction,
  transitionRegistrationInTransaction: transitionProjectSyncRegistrationInTransaction,
};

/**
 * Converts one committed ciphertext snapshot into authoritative local
 * plaintext state and opens push only at the final all-or-nothing boundary.
 */
export class CloudSyncSnapshotMaterializationCoordinator {
  private readonly enabled: boolean;
  private readonly snapshotStore: CloudSyncSnapshotMaterializationPersistence;
  private readonly authority: CloudSyncSnapshotMaterializationAuthority;
  private readonly materializer: CloudSyncSnapshotContentMaterializer;
  private readonly seeder: CloudSyncInitialProjectionSeederPort;
  private readonly clock: Clock;
  private readonly limits: NormalizedLimits;
  private readonly atomicAuthority: CloudSyncSnapshotMaterializationAtomicAuthority;
  private readonly activeProjects = new Map<
    string,
    Promise<CloudSyncSnapshotMaterializationResult>
  >();

  public constructor(dependencies: CloudSyncSnapshotMaterializationCoordinatorDependencies) {
    this.enabled = dependencies.enabled === true;
    this.snapshotStore = dependencies.snapshotStore;
    this.authority = dependencies.authority;
    this.materializer = dependencies.materializer;
    this.seeder = dependencies.seeder;
    this.clock = dependencies.clock;
    this.limits = normalizeLimits(dependencies.limits ?? {});
    this.atomicAuthority = dependencies.atomicAuthority ?? DEFAULT_ATOMIC_AUTHORITY;
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public runProjectSnapshotMaterialization(
    identity: SnapshotMaterializationIdentity,
    options: RunCloudSyncSnapshotMaterializationOptions = {},
  ): Promise<CloudSyncSnapshotMaterializationResult> {
    const active = this.activeProjects.get(identity.projectId);
    if (active !== undefined) {
      return active;
    }
    const run = this.execute(identity, options).finally(() => {
      if (this.activeProjects.get(identity.projectId) === run) {
        this.activeProjects.delete(identity.projectId);
      }
    });
    this.activeProjects.set(identity.projectId, run);
    return run;
  }

  private async execute(
    identity: SnapshotMaterializationIdentity,
    options: RunCloudSyncSnapshotMaterializationOptions,
  ): Promise<CloudSyncSnapshotMaterializationResult> {
    const counters = emptyCounters();
    if (!this.enabled) {
      return outcome(identity, "disabled", counters);
    }
    if (isAborted(options.signal)) {
      return outcome(identity, "aborted", counters, {
        plaintextMaterializationRequired: true,
      });
    }

    const registrationResult = await this.authority.loadProjectSyncRegistration(identity.projectId);
    if (!registrationResult.ok) {
      return this.persistenceFailure(identity, counters, registrationResult.error);
    }
    const registration =
      registrationResult.value === null ? null : Object.freeze({ ...registrationResult.value });

    if (isAborted(options.signal)) {
      return outcome(identity, "aborted", counters, {
        plaintextMaterializationRequired: true,
      });
    }

    const targetResult = await this.snapshotStore.readCommittedTarget(identity);
    if (!targetResult.ok) {
      return this.failFromCause(identity, counters, registration, targetResult.error);
    }
    const target = targetResult.value;
    if (target === null) {
      if (isCompletedRegistration(registration, identity.projectId)) {
        return outcome(identity, "plaintext_bootstrap_completed", counters, {
          pushAllowed: true,
          plaintextMaterializationRequired: false,
          completion: "already_completed",
        });
      }
      return this.permanentlyPause(
        identity,
        counters,
        registration,
        "SYNC_COMMITTED_SNAPSHOT_MISSING",
      );
    }
    if (!isExactBootstrapRegistration(registration, identity.projectId)) {
      return this.permanentlyPause(
        identity,
        counters,
        registration,
        "SYNC_BOOTSTRAP_REGISTRATION_INVALID",
      );
    }
    const frozenRegistration = registration;

    while (counters.attemptedWorkItems < this.limits.maximumWorkItems) {
      if (isAborted(options.signal)) {
        return outcome(identity, "aborted", counters, {
          plaintextMaterializationRequired: true,
        });
      }

      const workResult = await this.snapshotStore.loadNextPendingWork(identity);
      if (!workResult.ok) {
        return this.failFromCause(identity, counters, frozenRegistration, workResult.error);
      }
      const work = workResult.value;
      if (work === null) {
        return this.finalizeOrBlock(identity, target, frozenRegistration, counters, options.signal);
      }
      counters.attemptedWorkItems += 1;

      let prepared: PreparedIncomingContentMutation;
      try {
        // This deliberately runs after the store read transaction has closed.
        prepared = await this.materializer.prepare(work);
      } catch (cause: unknown) {
        return this.failFromCause(identity, counters, frozenRegistration, cause);
      }

      if (isAborted(options.signal)) {
        return outcome(identity, "aborted", counters, {
          plaintextMaterializationRequired: true,
        });
      }

      const resolvedAt = maximumTimestamp(this.clock.now(), target.committedAt);
      const resolution = await this.snapshotStore.resolveWorkAtomically(
        {
          snapshotId: identity.snapshotId,
          projectId: identity.projectId,
          epoch: identity.epoch,
          operationId: work.operation.operationId,
          operationFingerprint: work.operationFingerprint,
          resolvedAt,
        },
        async (transaction, exactWork) =>
          this.applyPreparedInsideReceiptTransaction(transaction, exactWork, prepared, resolvedAt),
      );
      if (!resolution.ok) {
        const control = readControl(resolution.error);
        if (control?.kind === "retry") {
          return outcome(identity, "retryable", counters, {
            plaintextMaterializationRequired: true,
            failure: { category: "retryable", code: control.code },
          });
        }
        if (control?.kind === "permanent") {
          return this.permanentlyPause(identity, counters, frozenRegistration, control.code);
        }
        return this.failFromCause(identity, counters, frozenRegistration, resolution.error);
      }

      const receipt = resolution.value.receipt;
      if (receipt.outcome === "applied") {
        counters.appliedReceipts += 1;
      } else if (receipt.outcome === "skipped") {
        counters.skippedReceipts += 1;
      } else {
        counters.conflictReceipts += 1;
        return outcome(identity, "conflict_blocked", counters, {
          plaintextMaterializationRequired: true,
          failure: {
            category: "conflict_blocked",
            code: receipt.conflictCode ?? CONTENT_CONFLICT_CODE,
          },
        });
      }
    }

    return this.finalizeOrLimit(identity, target, frozenRegistration, counters, options.signal);
  }

  private async applyPreparedInsideReceiptTransaction(
    transaction: TransactionExecutor,
    exactWork: SnapshotMaterializationWork,
    prepared: PreparedIncomingContentMutation,
    resolvedAt: string,
  ): Promise<SnapshotMaterializationDecision> {
    let materialized: ContentSyncMaterializationOutcome;
    try {
      materialized = await this.materializer.applyPrepared(
        transaction,
        exactWork,
        prepared,
        resolvedAt,
      );
    } catch (cause: unknown) {
      const classified = classifyFailure(cause);
      throw controlError(classified.disposition, classified.code);
    }

    switch (materialized.status) {
      case "applied":
        return { outcome: "applied" };
      case "skipped":
        return { outcome: "skipped" };
      case "conflict":
        return { outcome: "conflict", conflictCode: CONTENT_CONFLICT_CODE };
      case "retry":
        // Throwing aborts the caller-owned transaction, so neither a receipt
        // nor any partial business mutation can be committed.
        throw controlError("retry", materialized.code);
    }
  }

  private async finalizeOrLimit(
    identity: SnapshotMaterializationIdentity,
    target: SnapshotMaterializationTarget,
    registration: ProjectSyncRegistration,
    counters: MaterializationCounters,
    signal: AbortSignal | undefined,
  ): Promise<CloudSyncSnapshotMaterializationResult> {
    const stateResult = await this.snapshotStore.readState(identity);
    if (!stateResult.ok) {
      return this.failFromCause(identity, counters, registration, stateResult.error);
    }
    const state = stateResult.value;
    if (state === null) {
      return this.handleSnapshotAbsent(identity, counters);
    }
    if (state.conflict > 0) {
      return outcome(identity, "conflict_blocked", counters, {
        plaintextMaterializationRequired: true,
        failure: { category: "conflict_blocked", code: CONTENT_CONFLICT_CODE },
      });
    }
    if (state.remaining > 0) {
      return outcome(identity, "retryable", counters, {
        plaintextMaterializationRequired: true,
        failure: {
          category: "retryable",
          code: "SYNC_SNAPSHOT_MATERIALIZATION_WORK_LIMIT_REACHED",
        },
      });
    }
    return this.finalize(identity, target, registration, state, counters, signal);
  }

  private async finalizeOrBlock(
    identity: SnapshotMaterializationIdentity,
    target: SnapshotMaterializationTarget,
    registration: ProjectSyncRegistration,
    counters: MaterializationCounters,
    signal: AbortSignal | undefined,
  ): Promise<CloudSyncSnapshotMaterializationResult> {
    const stateResult = await this.snapshotStore.readState(identity);
    if (!stateResult.ok) {
      return this.failFromCause(identity, counters, registration, stateResult.error);
    }
    const state = stateResult.value;
    if (state === null) {
      return this.handleSnapshotAbsent(identity, counters);
    }
    if (state.conflict > 0) {
      return outcome(identity, "conflict_blocked", counters, {
        plaintextMaterializationRequired: true,
        failure: { category: "conflict_blocked", code: CONTENT_CONFLICT_CODE },
      });
    }
    if (state.remaining !== 0) {
      return outcome(identity, "retryable", counters, {
        plaintextMaterializationRequired: true,
        failure: {
          category: "retryable",
          code: "SYNC_SNAPSHOT_MATERIALIZATION_STATE_CHANGED",
        },
      });
    }
    return this.finalize(identity, target, registration, state, counters, signal);
  }

  private async finalize(
    identity: SnapshotMaterializationIdentity,
    frozenTarget: SnapshotMaterializationTarget,
    frozenRegistration: ProjectSyncRegistration,
    state: SnapshotMaterializationState,
    counters: MaterializationCounters,
    signal: AbortSignal | undefined,
  ): Promise<CloudSyncSnapshotMaterializationResult> {
    if (state.total !== state.resolved || state.remaining !== 0 || state.conflict !== 0) {
      return outcome(identity, "retryable", counters, {
        plaintextMaterializationRequired: true,
        failure: {
          category: "retryable",
          code: "SYNC_SNAPSHOT_MATERIALIZATION_INCOMPLETE",
        },
      });
    }
    if (isAborted(signal)) {
      return outcome(identity, "aborted", counters, {
        plaintextMaterializationRequired: true,
      });
    }

    const checkpointResult = await this.authority.loadMaterializedCheckpoint(identity.projectId);
    if (!checkpointResult.ok) {
      return this.failFromCause(identity, counters, frozenRegistration, checkpointResult.error);
    }
    const checkpoint = checkpointResult.value;
    const finalizedAt = maximumTimestamp(
      this.clock.now(),
      frozenTarget.committedAt,
      frozenRegistration.updatedAt,
      checkpoint?.updatedAt,
    );
    const seedResult: { value?: CloudSyncInitialProjectionSeedResult } = {};
    const finalizeResult = await this.snapshotStore.finalizeAtomically(
      identity,
      async (transaction, exactTarget) => {
        requireExactTarget(exactTarget, frozenTarget);
        requireResult(
          await this.atomicAuthority.advanceMaterializedCheckpointInTransaction(transaction, {
            projectId: identity.projectId,
            signedRemoteCursor: exactTarget.signedRemoteCursor,
            downloadedCheckpointRevision: exactTarget.downloadedCheckpointRevision,
            expectedRevision: checkpoint?.revision ?? null,
            updatedAt: finalizedAt,
          }),
        );
        const enabledRegistration = requireResult(
          await this.atomicAuthority.transitionRegistrationInTransaction(transaction, {
            projectId: identity.projectId,
            expectedAccountId: frozenRegistration.accountId,
            expectedDeviceId: frozenRegistration.deviceId,
            expectedConsentRevision: frozenRegistration.consentRevision,
            expectedKeyVersion: frozenRegistration.keyVersion,
            expectedRevision: frozenRegistration.revision,
            target: { state: "enabled" },
            transitionedAt: finalizedAt,
          }),
        );
        seedResult.value = await this.seeder.seedProjectInTransaction(
          transaction,
          enabledRegistration,
          finalizedAt,
        );
      },
    );
    if (!finalizeResult.ok) {
      return this.failFromCause(identity, counters, frozenRegistration, finalizeResult.error, {
        finalization: true,
      });
    }
    if (finalizeResult.value.reason === "snapshot_absent") {
      return this.handleSnapshotAbsent(identity, counters);
    }
    const seeds = seedResult.value;
    if (seeds === undefined) {
      return this.permanentlyPause(
        identity,
        counters,
        frozenRegistration,
        "SYNC_SNAPSHOT_FINALIZER_NOT_EXECUTED",
      );
    }
    return outcome(identity, "plaintext_bootstrap_completed", counters, {
      pushAllowed: true,
      plaintextMaterializationRequired: false,
      completion: "finalized",
      seededJobs: seeds.enqueuedJobIds.length,
      skippedSeedJobs: seeds.skippedJobIds.length,
    });
  }

  private async handleSnapshotAbsent(
    identity: SnapshotMaterializationIdentity,
    counters: MaterializationCounters,
  ): Promise<CloudSyncSnapshotMaterializationResult> {
    const currentResult = await this.authority.loadProjectSyncRegistration(identity.projectId);
    if (!currentResult.ok) {
      return this.persistenceFailure(identity, counters, currentResult.error);
    }
    if (isCompletedRegistration(currentResult.value, identity.projectId)) {
      return outcome(identity, "plaintext_bootstrap_completed", counters, {
        pushAllowed: true,
        plaintextMaterializationRequired: false,
        completion: "already_completed",
      });
    }
    return this.permanentlyPause(
      identity,
      counters,
      currentResult.value,
      "SYNC_COMMITTED_SNAPSHOT_MISSING",
    );
  }

  private failFromCause(
    identity: SnapshotMaterializationIdentity,
    counters: MaterializationCounters,
    registration: ProjectSyncRegistration | null,
    cause: unknown,
    options: Readonly<{ finalization?: boolean }> = {},
  ): Promise<CloudSyncSnapshotMaterializationResult> | CloudSyncSnapshotMaterializationResult {
    const classified = classifyFailure(cause, options);
    if (classified.disposition === "permanent") {
      return this.permanentlyPause(identity, counters, registration, classified.code);
    }
    return outcome(identity, "retryable", counters, {
      plaintextMaterializationRequired: true,
      failure: { category: "retryable", code: classified.code },
    });
  }

  private persistenceFailure(
    identity: SnapshotMaterializationIdentity,
    counters: MaterializationCounters,
    error: AppError,
  ): CloudSyncSnapshotMaterializationResult {
    const classified = classifyFailure(error);
    return outcome(
      identity,
      classified.disposition === "permanent" ? "permanent_paused" : "retryable",
      counters,
      {
        plaintextMaterializationRequired: true,
        failure: {
          category: classified.disposition === "permanent" ? "permanent_paused" : "retryable",
          code: classified.code,
        },
      },
    );
  }

  private async permanentlyPause(
    identity: SnapshotMaterializationIdentity,
    counters: MaterializationCounters,
    registration: ProjectSyncRegistration | null,
    codeValue: string,
  ): Promise<CloudSyncSnapshotMaterializationResult> {
    const code = normalizeCode(codeValue, "SYNC_SNAPSHOT_MATERIALIZATION_PERMANENT_FAILURE");
    const persisted = await this.persistPermanentPause(registration, code);
    return outcome(identity, "permanent_paused", counters, {
      plaintextMaterializationRequired: true,
      permanentPausePersisted: persisted,
      failure: { category: "permanent_paused", code },
    });
  }

  private async persistPermanentPause(
    frozen: ProjectSyncRegistration | null,
    code: string,
  ): Promise<boolean> {
    if (frozen === null) {
      return false;
    }
    if (frozen.state === "error") {
      return frozen.lastErrorCode === code;
    }
    if (frozen.state === "disabled") {
      return false;
    }
    const transitionedAt = maximumTimestamp(this.clock.now(), frozen.updatedAt);
    const transition = await this.authority.transitionProjectSyncRegistration({
      projectId: frozen.projectId,
      expectedAccountId: frozen.accountId,
      expectedDeviceId: frozen.deviceId,
      expectedConsentRevision: frozen.consentRevision,
      expectedKeyVersion: frozen.keyVersion,
      expectedRevision: frozen.revision,
      target: { state: "error", errorCode: code },
      transitionedAt,
    });
    if (transition.ok) {
      return (
        transition.value.state === "error" &&
        transition.value.lastErrorCode === code &&
        sameRegistrationAuthority(transition.value, frozen)
      );
    }
    const current = await this.authority.loadProjectSyncRegistration(frozen.projectId);
    return (
      current.ok &&
      current.value !== null &&
      current.value.state === "error" &&
      current.value.lastErrorCode === code &&
      sameRegistrationAuthority(current.value, frozen)
    );
  }
}

function emptyCounters(): MaterializationCounters {
  return {
    attemptedWorkItems: 0,
    appliedReceipts: 0,
    skippedReceipts: 0,
    conflictReceipts: 0,
  };
}

function outcome(
  identity: SnapshotMaterializationIdentity,
  state: CloudSyncSnapshotMaterializationState,
  counters: MaterializationCounters,
  overrides: Partial<CloudSyncSnapshotMaterializationResult> = {},
): CloudSyncSnapshotMaterializationResult {
  return {
    snapshotId: identity.snapshotId,
    projectId: identity.projectId,
    epoch: identity.epoch,
    state,
    pushAllowed: false,
    plaintextMaterializationRequired: false,
    completion: null,
    attemptedWorkItems: counters.attemptedWorkItems,
    appliedReceipts: counters.appliedReceipts,
    skippedReceipts: counters.skippedReceipts,
    conflictReceipts: counters.conflictReceipts,
    seededJobs: 0,
    skippedSeedJobs: 0,
    permanentPausePersisted: false,
    failure: null,
    ...overrides,
  };
}

function isExactBootstrapRegistration(
  registration: ProjectSyncRegistration | null,
  projectId: string,
): registration is ProjectSyncRegistration & Readonly<{ state: "bootstrap_required" }> {
  return (
    registration !== null &&
    registration.projectId === projectId &&
    registration.state === "bootstrap_required" &&
    !registration.plaintextBootstrapCompleted &&
    registration.lastErrorCode === null &&
    registration.enabledAt === null &&
    registration.pausedAt === null
  );
}

function isCompletedRegistration(
  registration: ProjectSyncRegistration | null,
  projectId: string,
): registration is ProjectSyncRegistration & Readonly<{ state: "enabled" }> {
  return (
    registration !== null &&
    registration.projectId === projectId &&
    registration.state === "enabled" &&
    registration.plaintextBootstrapCompleted &&
    registration.lastErrorCode === null &&
    registration.enabledAt !== null &&
    registration.pausedAt === null
  );
}

function sameRegistrationAuthority(
  current: ProjectSyncRegistration,
  frozen: ProjectSyncRegistration,
): boolean {
  return (
    current.projectId === frozen.projectId &&
    current.accountId === frozen.accountId &&
    current.deviceId === frozen.deviceId &&
    current.consentRevision === frozen.consentRevision &&
    current.keyVersion === frozen.keyVersion
  );
}

function requireExactTarget(
  current: SnapshotMaterializationTarget,
  frozen: SnapshotMaterializationTarget,
): void {
  if (
    current.snapshotId !== frozen.snapshotId ||
    current.projectId !== frozen.projectId ||
    current.epoch !== frozen.epoch ||
    current.signedRemoteCursor !== frozen.signedRemoteCursor ||
    current.downloadedCheckpointRevision !== frozen.downloadedCheckpointRevision ||
    current.committedAt !== frozen.committedAt
  ) {
    throw new AppError({
      code: "INVALID_STATE_TRANSITION",
      message: "The committed snapshot target changed before plaintext finalization.",
      actions: ["RETRY", "OPEN_SETTINGS"],
    });
  }
}

function requireResult<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function controlError(kind: MaterializationControl["kind"], codeValue: string): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "Snapshot plaintext materialization did not reach a receipt outcome.",
    retryable: true,
    actions: ["RETRY"],
    details: {
      operation: CONTROL_OPERATION,
      kind,
      failureCode: normalizeCode(codeValue, "SYNC_SNAPSHOT_MATERIALIZATION_FAILED"),
    },
  });
}

function readControl(error: AppError): MaterializationControl | null {
  if (error.details.operation !== CONTROL_OPERATION) {
    return null;
  }
  const kind = error.details.kind;
  const code = error.details.failureCode;
  if ((kind !== "permanent" && kind !== "retry") || typeof code !== "string") {
    return null;
  }
  return { kind, code: normalizeCode(code, "SYNC_SNAPSHOT_MATERIALIZATION_FAILED") };
}

function classifyFailure(
  cause: unknown,
  options: Readonly<{ finalization?: boolean }> = {},
): ClassifiedFailure {
  if (cause instanceof SyncCoreError) {
    return {
      disposition: cause.retryable ? "retry" : "permanent",
      code: normalizeCode(cause.code, "SYNC_SNAPSHOT_MATERIALIZATION_FAILED"),
    };
  }
  if (isPermanentCryptoFailure(cause)) {
    return { disposition: "permanent", code: "SYNC_CHUNK_INTEGRITY_FAILED" };
  }
  if (cause instanceof AppError) {
    const control = readControl(cause);
    if (control !== null) {
      return {
        disposition: control.kind,
        code: control.code,
      };
    }
    if (
      cause.retryable ||
      cause.code === "INVALID_STATE_TRANSITION" ||
      (options.finalization === true && cause.code === "REPOSITORY_ERROR")
    ) {
      return {
        disposition: "retry",
        code: normalizeCode(cause.code, "SYNC_SNAPSHOT_MATERIALIZATION_FAILED"),
      };
    }
    return {
      disposition: "permanent",
      code: normalizeCode(cause.code, "SYNC_SNAPSHOT_MATERIALIZATION_FAILED"),
    };
  }
  return {
    // Unknown native key-store and database exceptions are retried. Only
    // recognized authenticated-data failures are permanently paused.
    disposition: "retry",
    code: "SYNC_SNAPSHOT_MATERIALIZATION_FAILED",
  };
}

function isPermanentCryptoFailure(cause: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    cause instanceof DOMException &&
    ["DataError", "InvalidAccessError", "NotSupportedError", "OperationError"].includes(cause.name)
  );
}

function normalizeCode(value: string, fallback: string): string {
  return /^[A-Z][A-Z0-9_.:-]{2,119}$/u.test(value) ? value : fallback;
}

function normalizeLimits(limits: CloudSyncSnapshotMaterializationLimits): NormalizedLimits {
  const maximumWorkItems = limits.maximumWorkItems ?? DEFAULT_MAXIMUM_WORK_ITEMS;
  if (
    !Number.isSafeInteger(maximumWorkItems) ||
    maximumWorkItems < 1 ||
    maximumWorkItems > MAXIMUM_WORK_ITEMS_LIMIT
  ) {
    throw new Error(`maximumWorkItems must be between 1 and ${String(MAXIMUM_WORK_ITEMS_LIMIT)}.`);
  }
  return { maximumWorkItems };
}

function maximumTimestamp(...values: readonly (string | undefined)[]): string {
  let maximum = "";
  let maximumEpoch = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch)) {
      throw new Error("A snapshot materialization timestamp is invalid.");
    }
    if (epoch >= maximumEpoch) {
      maximumEpoch = epoch;
      maximum = new Date(epoch).toISOString();
    }
  }
  if (maximum.length === 0) {
    throw new Error("A snapshot materialization timestamp is required.");
  }
  return maximum;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
