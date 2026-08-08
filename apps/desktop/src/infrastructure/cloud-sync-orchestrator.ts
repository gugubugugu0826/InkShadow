import { CloudClientError, type InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type CloudSyncPushRequest,
  type EncryptedSyncChunkContract,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";
import type {
  ProjectionOperationPushGate,
  ProjectionOperationPushGateInput,
  ProjectionOperationPushFenceInput,
  ProjectionOperationPushFenceReason,
  ProjectionOperationPushFenceResult,
  ProjectionOperationPushNetworkResponse,
  TransactionExecutor,
} from "@inkshadow/data";
import { ProjectionOperationPushResponseMismatchError } from "@inkshadow/data";
import type {
  ClaimedIncomingSyncWork,
  ClaimedSyncOperation,
  ClaimProjectSyncOperationCommand,
  ProjectSyncBlockingState,
  SyncSqliteStore,
} from "@inkshadow/data/sync-sqlite-store";
import { AppError, type Clock, type Result, type UuidV7Generator } from "@inkshadow/domain";
import { SyncCoreError } from "@inkshadow/sync-core";

import {
  CloudSessionCoordinatorError,
  type CloudSessionCoordinator,
} from "./cloud-session-coordinator";
import type {
  CloudSyncIncrementalSettlementCoordinator,
  CloudSyncIncrementalSettlementResult,
} from "./cloud-sync-incremental-settlement-coordinator";

const DEFAULT_PULL_PAGE_SIZE = 128;
const DEFAULT_MAXIMUM_PULL_PAGES = 8;
const DEFAULT_MAXIMUM_INCOMING_OPERATIONS = 64;
const DEFAULT_MAXIMUM_OUTGOING_OPERATIONS = 32;
const DEFAULT_LEASE_DURATION_MS = 90_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAXIMUM_MS = 15 * 60_000;
const DEFAULT_LOOP_INTERVAL_MS = 15_000;

type SyncStore = Pick<
  SyncSqliteStore,
  | "claimNextIncoming"
  | "findTombstone"
  | "getEncryptedChunk"
  | "markIncomingFailure"
  | "pauseFailure"
  | "readProjectSyncBlockingState"
  | "readRemoteCheckpoint"
  | "resolveClaimedIncomingAtomically"
  | "rescheduleFailure"
  | "stageIncomingSyncBatch"
>;

/**
 * This narrow port keeps push processing scoped to the active project and
 * authenticated device.
 */
export interface ProjectScopedOutboxClaimer {
  claimNextForProject(
    command: ClaimProjectSyncOperationCommand,
  ): Promise<Result<ClaimedSyncOperation | null, AppError>>;
}

export interface ProjectionOperationPushAuthority {
  evaluateProjectionOperationPushGate(
    input: ProjectionOperationPushGateInput,
  ): Promise<Result<ProjectionOperationPushGate, AppError>>;
  pushProjectionOperationFenced(
    input: ProjectionOperationPushFenceInput,
    push: () => Promise<ProjectionOperationPushNetworkResponse>,
  ): Promise<ProjectionOperationPushFenceResult>;
}

export type CloudSyncIncrementalSettlement = Pick<
  CloudSyncIncrementalSettlementCoordinator,
  "settleProjectIncremental"
>;

export type IncomingApplyOutcome =
  | Readonly<{ status: "applied" }>
  | Readonly<{ status: "skipped" }>
  | Readonly<{ status: "conflict"; code?: string }>
  | Readonly<{ status: "retry"; code: string }>;

export interface IncomingMaterializationContext {
  /**
   * A stable timestamp for the current phase. The prepare and commit phases
   * receive separate contexts because authentication can take meaningful time.
   */
  readonly now: string;
  readonly signal?: AbortSignal;
}

export type IncomingCiphertextPrepare<Prepared> = (
  work: ClaimedIncomingSyncWork,
  context: IncomingMaterializationContext,
) => Promise<Prepared>;

export type IncomingPreparedApply<Prepared> = (
  transaction: TransactionExecutor,
  exactWork: ClaimedIncomingSyncWork,
  prepared: Prepared,
  context: IncomingMaterializationContext,
) => Promise<IncomingApplyOutcome>;

export interface CloudSyncOrchestratorLimits {
  readonly pullPageSize?: number;
  readonly maximumPullPages?: number;
  readonly maximumIncomingOperations?: number;
  readonly maximumOutgoingOperations?: number;
  readonly leaseDurationMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaximumMs?: number;
}

export interface CloudSyncOrchestratorDependencies<Prepared = unknown> {
  /**
   * Cloud sync is disabled unless this is explicitly true.
   */
  readonly enabled?: boolean;
  readonly api: InkShadowCloudApiClient;
  readonly session: Pick<CloudSessionCoordinator, "runWithSession">;
  readonly store: SyncStore;
  /**
   * Authenticates ciphertext, resolves its exact historical key, and decrypts
   * it. This callback always runs after the lease is claimed and before the
   * SQLite resolution transaction starts.
   */
  readonly prepareIncoming: IncomingCiphertextPrepare<Prepared>;
  /**
   * Applies already-authenticated plaintext. Implementations must bind
   * `prepared` to `exactWork` (for example with an operation fingerprint)
   * before changing business rows.
   */
  readonly applyPreparedIncoming: IncomingPreparedApply<Prepared>;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
  readonly ownerId: string;
  readonly activeDeviceId: string;
  /**
   * Revalidates the completed projection job against the current local
   * account/device/consent/key registration immediately before network I/O.
   */
  readonly projectionPushAuthority: ProjectionOperationPushAuthority;
  /**
   * Proves that the exact downloaded cursor reached plaintext state before
   * this cycle may claim or send any outbox operation.
   */
  readonly incrementalSettlement: CloudSyncIncrementalSettlement;
  readonly projectOutbox?: ProjectScopedOutboxClaimer;
  readonly limits?: CloudSyncOrchestratorLimits;
}

export interface CloudSyncPhaseSummary {
  readonly pull: {
    readonly pages: number;
    readonly stagedBatches: number;
    readonly operations: number;
    readonly chunks: number;
    readonly tombstones: number;
    readonly pageLimitReached: boolean;
  };
  readonly incoming: {
    readonly claimed: number;
    readonly applied: number;
    readonly conflicts: number;
    readonly retried: number;
    readonly workLimitReached: boolean;
  };
  readonly outgoing: {
    readonly boundary: "ready" | "project_scoped_claim_unavailable";
    readonly claimed: number;
    readonly pushed: number;
    readonly acknowledged: number;
    readonly retried: number;
    readonly paused: number;
    readonly workLimitReached: boolean;
  };
}

export interface CloudSyncCycleResult extends CloudSyncPhaseSummary {
  readonly projectId: string;
  readonly state:
    | "aborted"
    | "auth_blocked"
    | "boundary_blocked"
    | "bootstrap_required"
    | "conflict_blocked"
    | "disabled"
    | "idle"
    | "offline"
    | "permanent_paused"
    | "retryable";
  readonly failure: CloudSyncFailure | null;
}

export type CloudSyncFailureCategory =
  | "auth_blocked"
  | "bootstrap_required"
  | "boundary_blocked"
  | "conflict_blocked"
  | "offline"
  | "permanent_paused"
  | "retryable";

export interface CloudSyncFailure {
  readonly category: CloudSyncFailureCategory;
  readonly code: string;
}

export interface RunCloudSyncCycleOptions {
  readonly signal?: AbortSignal;
}

export interface RunContinuousCloudSyncOptions extends RunCloudSyncCycleOptions {
  readonly intervalMs?: number;
  readonly onCycle?: (result: CloudSyncCycleResult) => void | Promise<void>;
}

interface NormalizedLimits {
  readonly pullPageSize: number;
  readonly maximumPullPages: number;
  readonly maximumIncomingOperations: number;
  readonly maximumOutgoingOperations: number;
  readonly leaseDurationMs: number;
  readonly retryBaseMs: number;
  readonly retryMaximumMs: number;
}

interface MutableSummary {
  pull: {
    pages: number;
    stagedBatches: number;
    operations: number;
    chunks: number;
    tombstones: number;
    pageLimitReached: boolean;
  };
  incoming: {
    claimed: number;
    applied: number;
    conflicts: number;
    retried: number;
    workLimitReached: boolean;
  };
  outgoing: {
    boundary: "ready" | "project_scoped_claim_unavailable";
    claimed: number;
    pushed: number;
    acknowledged: number;
    retried: number;
    paused: number;
    workLimitReached: boolean;
  };
}

interface SettledIncrementalPushBoundary {
  readonly projectId: string;
  readonly signedRemoteCursor: string;
  readonly downloadedCheckpointRevision: number;
  readonly materializedCheckpointRevision: number;
}

export class CloudSyncOrchestrator<Prepared = unknown> {
  private readonly enabled: boolean;
  private readonly api: InkShadowCloudApiClient;
  private readonly session: Pick<CloudSessionCoordinator, "runWithSession">;
  private readonly store: SyncStore;
  private readonly prepareIncoming: IncomingCiphertextPrepare<Prepared>;
  private readonly applyPreparedIncoming: IncomingPreparedApply<Prepared>;
  private readonly clock: Clock;
  private readonly ids: UuidV7Generator;
  private readonly ownerId: string;
  private readonly activeDeviceId: string;
  private readonly projectionPushAuthority: ProjectionOperationPushAuthority;
  private readonly incrementalSettlement: CloudSyncIncrementalSettlement;
  private readonly projectOutbox: ProjectScopedOutboxClaimer | null;
  private readonly limits: NormalizedLimits;
  private readonly activeProjects = new Map<string, Promise<CloudSyncCycleResult>>();

  public constructor(dependencies: CloudSyncOrchestratorDependencies<Prepared>) {
    this.enabled = dependencies.enabled === true;
    this.api = dependencies.api;
    this.session = dependencies.session;
    this.store = dependencies.store;
    this.prepareIncoming = dependencies.prepareIncoming;
    this.applyPreparedIncoming = dependencies.applyPreparedIncoming;
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
    this.ownerId = dependencies.ownerId;
    this.activeDeviceId = dependencies.activeDeviceId;
    this.projectionPushAuthority = dependencies.projectionPushAuthority;
    this.incrementalSettlement = dependencies.incrementalSettlement;
    this.projectOutbox = dependencies.projectOutbox ?? null;
    this.limits = normalizeLimits(dependencies.limits ?? {});
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public runProjectCycle(
    projectId: string,
    options: RunCloudSyncCycleOptions = {},
  ): Promise<CloudSyncCycleResult> {
    const active = this.activeProjects.get(projectId);
    if (active !== undefined) {
      return active;
    }
    const cycle = this.executeProjectCycle(projectId, options).finally(() => {
      if (this.activeProjects.get(projectId) === cycle) {
        this.activeProjects.delete(projectId);
      }
    });
    this.activeProjects.set(projectId, cycle);
    return cycle;
  }

  public async runProjectContinuously(
    projectId: string,
    options: RunContinuousCloudSyncOptions = {},
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const intervalMs = requireBoundedInteger(
      options.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS,
      "intervalMs",
      250,
      10 * 60_000,
    );
    let consecutiveRetryableFailures = 0;
    while (!isSignalAborted(options.signal)) {
      const result = await this.runProjectCycle(projectId, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      await options.onCycle?.(result);
      if (result.state === "aborted" || isSignalAborted(options.signal)) {
        return;
      }
      if (isTerminalState(result.state)) {
        return;
      }
      if (result.state === "offline" || result.state === "retryable") {
        consecutiveRetryableFailures += 1;
        await abortableDelay(
          retryDelayMs(consecutiveRetryableFailures, this.limits),
          options.signal,
        );
        continue;
      }
      consecutiveRetryableFailures = 0;
      await abortableDelay(intervalMs, options.signal);
    }
  }

  private async executeProjectCycle(
    projectId: string,
    options: RunCloudSyncCycleOptions,
  ): Promise<CloudSyncCycleResult> {
    const summary = createSummary(this.projectOutbox !== null);
    if (!this.enabled) {
      return finalize(projectId, "disabled", summary);
    }
    if (isSignalAborted(options.signal)) {
      return finalize(projectId, "aborted", summary);
    }

    const checkpoint = unwrap(await this.store.readRemoteCheckpoint(projectId));
    let downloadedCheckpoint = checkpoint;
    let pullCursor = checkpoint.signedRemoteCursor;
    let settledPushBoundary: SettledIncrementalPushBoundary | null = null;
    let failure: CloudSyncFailure | null = null;
    let aborted = false;
    let lastPullHadMore = false;

    for (let page = 0; page < this.limits.maximumPullPages; page += 1) {
      if (isSignalAborted(options.signal)) {
        aborted = true;
        break;
      }
      try {
        const response = await this.session.runWithSession(
          () =>
            this.api.pullSync(projectId, {
              cursor: pullCursor,
              limit: this.limits.pullPageSize,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            }),
          options.signal === undefined ? {} : { signal: options.signal },
        );
        const staged = unwrap(
          await this.store.stageIncomingSyncBatch({
            projectId,
            priorSignedRemoteCursor: pullCursor,
            response,
            receivedAt: this.clock.now(),
          }),
        );
        downloadedCheckpoint = staged.checkpoint;
        summary.pull.pages += 1;
        summary.pull.stagedBatches += staged.created ? 1 : 0;
        summary.pull.operations += staged.operationCount;
        summary.pull.chunks += staged.chunkCount;
        summary.pull.tombstones += staged.tombstoneCount;
        lastPullHadMore = response.hasMore;
        if (!response.hasMore) {
          pullCursor = response.nextCursor;
          break;
        }
        if (response.nextCursor === pullCursor) {
          summary.pull.pageLimitReached = true;
          break;
        }
        pullCursor = response.nextCursor;
      } catch (cause: unknown) {
        if (isAbort(cause, options.signal)) {
          aborted = true;
          break;
        }
        const classified = classifyCloudFailure(cause);
        if (classified !== null) {
          failure = classified;
          break;
        }
        throw cause;
      }
    }
    if (lastPullHadMore && summary.pull.pages >= this.limits.maximumPullPages) {
      summary.pull.pageLimitReached = true;
    }

    if (!aborted) {
      aborted = await this.drainIncoming(projectId, summary, options.signal);
    }
    if (!aborted && failure === null) {
      if (summary.pull.pageLimitReached) {
        failure = {
          category: "boundary_blocked",
          code: "SYNC_INCREMENTAL_PULL_INCOMPLETE",
        };
      } else {
        const settlement = await this.settleIncoming(
          projectId,
          downloadedCheckpoint,
          options.signal,
        );
        aborted = settlement.aborted;
        failure = settlement.failure;
        settledPushBoundary = settlement.boundary;
      }
    }
    if (!aborted && failure === null && this.projectOutbox !== null) {
      if (settledPushBoundary === null) {
        failure = {
          category: "boundary_blocked",
          code: "SYNC_INCREMENTAL_SETTLEMENT_EVIDENCE_MISSING",
        };
      } else {
        const outgoing = await this.pushOutgoing(
          projectId,
          settledPushBoundary,
          summary,
          options.signal,
        );
        aborted = outgoing.aborted;
        failure = outgoing.failure;
      }
    }

    if (aborted) {
      return finalize(projectId, "aborted", summary);
    }
    if (failure !== null) {
      return finalize(projectId, failure.category, summary, failure);
    }
    const blocking = unwrap(await this.store.readProjectSyncBlockingState(projectId));
    const outcome = classifyLocalCycleOutcome(summary, blocking);
    return finalize(projectId, outcome.state, summary, outcome.failure);
  }

  private async settleIncoming(
    projectId: string,
    checkpoint: Readonly<{
      projectId: string;
      signedRemoteCursor: string | null;
      revision: number;
    }>,
    signal: AbortSignal | undefined,
  ): Promise<{
    aborted: boolean;
    failure: CloudSyncFailure | null;
    boundary: SettledIncrementalPushBoundary | null;
  }> {
    const signedRemoteCursor = checkpoint.signedRemoteCursor;
    if (
      checkpoint.projectId !== projectId ||
      signedRemoteCursor === null ||
      checkpoint.revision < 1
    ) {
      return {
        aborted: false,
        failure: {
          category: "boundary_blocked",
          code: "SYNC_INCREMENTAL_CHECKPOINT_MISSING",
        },
        boundary: null,
      };
    }
    try {
      const settlement = await this.session.runWithSession(
        async (session) => {
          const activeAccountId = session.account.accountId;
          const activeDeviceId = session.device.device.deviceId;
          if (activeDeviceId !== this.activeDeviceId) {
            throw new ProjectionPushAuthorityError("SYNC_DEVICE_AUTHORITY_CHANGED");
          }
          return this.incrementalSettlement.settleProjectIncremental({
            projectId,
            activeAccountId,
            activeDeviceId,
            signedRemoteCursor,
            downloadedCheckpointRevision: checkpoint.revision,
            ...(signal === undefined ? {} : { signal }),
          });
        },
        signal === undefined ? {} : { signal },
      );
      return settlementBoundary(settlement, {
        projectId: checkpoint.projectId,
        signedRemoteCursor,
        revision: checkpoint.revision,
      });
    } catch (cause: unknown) {
      if (isAbort(cause, signal)) {
        return { aborted: true, failure: null, boundary: null };
      }
      if (cause instanceof ProjectionPushAuthorityError) {
        return {
          aborted: false,
          failure: { category: "auth_blocked", code: cause.code },
          boundary: null,
        };
      }
      const classified = classifyCloudFailure(cause);
      if (classified !== null) {
        return { aborted: false, failure: classified, boundary: null };
      }
      throw cause;
    }
  }

  private async drainIncoming(
    projectId: string,
    summary: MutableSummary,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    for (let index = 0; index < this.limits.maximumIncomingOperations; index += 1) {
      if (isSignalAborted(signal)) {
        return true;
      }
      const now = this.clock.now();
      const leaseToken = this.ids.next();
      const work = unwrap(
        await this.store.claimNextIncoming({
          projectId,
          ownerId: this.ownerId,
          leaseToken,
          now,
          leaseExpiresAt: addMilliseconds(now, this.limits.leaseDurationMs),
        }),
      );
      if (work === null) {
        return false;
      }
      if (
        work.operation.projectId !== projectId ||
        work.leaseOwnerId !== this.ownerId ||
        work.leaseToken !== leaseToken
      ) {
        throw new Error("Incoming sync claim violated its project or lease scope.");
      }
      summary.incoming.claimed += 1;

      const prepareContext: IncomingMaterializationContext = {
        now: this.clock.now(),
        ...(signal === undefined ? {} : { signal }),
      };
      let prepared: Prepared;
      try {
        prepared = await this.prepareIncoming(work, prepareContext);
      } catch (cause: unknown) {
        if (isAbort(cause, signal)) {
          // Preparation never entered SQLite. Keep the intact lease for
          // expiry-based recovery so an abort cannot create a false receipt.
          return true;
        }
        const failure = classifyIncomingMaterializationFailure(cause, "prepare");
        const failedAt = this.clock.now();
        unwrap(
          await this.store.markIncomingFailure({
            operationId: work.operation.operationId,
            leaseToken: work.leaseToken,
            failureCode: failure.code,
            now: failedAt,
            nextAttemptAt:
              failure.disposition === "retry" ? retryAt(failedAt, work.attempt, this.limits) : null,
          }),
        );
        if (failure.disposition === "retry") {
          summary.incoming.retried += 1;
        }
        continue;
      }
      if (isSignalAborted(signal)) {
        // Authenticated plaintext has not entered SQLite and the lease remains
        // recoverable after expiry.
        return true;
      }

      const resolvedAt = this.clock.now();
      const applyContext: IncomingMaterializationContext = {
        now: resolvedAt,
        ...(signal === undefined ? {} : { signal }),
      };
      const resolution = await this.store.resolveClaimedIncomingAtomically(
        {
          operationId: work.operation.operationId,
          leaseToken: work.leaseToken,
          now: resolvedAt,
        },
        async (transaction, exactWork) => {
          if (
            exactWork.operation.projectId !== projectId ||
            exactWork.operation.operationId !== work.operation.operationId ||
            exactWork.leaseOwnerId !== this.ownerId ||
            exactWork.leaseToken !== work.leaseToken
          ) {
            throw incomingApplyControlError("permanent", "INCOMING_ATOMIC_SCOPE_MISMATCH");
          }
          let outcome: IncomingApplyOutcome;
          try {
            outcome = await this.applyPreparedIncoming(
              transaction,
              exactWork,
              prepared,
              applyContext,
            );
          } catch (cause: unknown) {
            if (isAbort(cause, signal)) {
              throw incomingApplyControlError("abort", "INCOMING_APPLY_ABORTED");
            }
            const failure = classifyIncomingMaterializationFailure(cause, "apply");
            throw incomingApplyControlError(failure.disposition, failure.code);
          }
          if (outcome.status === "retry") {
            throw incomingApplyControlError(
              "retry",
              normalizeResolutionCode(outcome.code, "INCOMING_APPLY_RETRY"),
            );
          }
          return outcome.status === "applied" || outcome.status === "skipped"
            ? { status: "applied" }
            : {
                status: "conflict",
                conflictCode: normalizeResolutionCode(
                  outcome.code ?? "INCOMING_VERSION_CONFLICT",
                  "INCOMING_VERSION_CONFLICT",
                ),
              };
        },
      );
      if (!resolution.ok) {
        const control = readIncomingApplyControl(resolution.error);
        if (control?.kind === "abort") {
          // The atomic transaction has rolled back. The intact lease is
          // deliberately recovered only after expiry.
          return true;
        }
        if (control?.kind === "retry" || control?.kind === "permanent") {
          unwrap(
            await this.store.markIncomingFailure({
              operationId: work.operation.operationId,
              leaseToken: work.leaseToken,
              failureCode: control.failureCode,
              now: resolvedAt,
              nextAttemptAt:
                control.kind === "retry" ? retryAt(resolvedAt, work.attempt, this.limits) : null,
            }),
          );
          if (control.kind === "retry") {
            summary.incoming.retried += 1;
          }
          continue;
        }
        const failure = classifyIncomingMaterializationFailure(resolution.error, "apply");
        unwrap(
          await this.store.markIncomingFailure({
            operationId: work.operation.operationId,
            leaseToken: work.leaseToken,
            failureCode: failure.code,
            now: resolvedAt,
            nextAttemptAt:
              failure.disposition === "retry"
                ? retryAt(resolvedAt, work.attempt, this.limits)
                : null,
          }),
        );
        if (failure.disposition === "retry") {
          summary.incoming.retried += 1;
        }
        continue;
      }
      if (resolution.value.status === "applied") {
        summary.incoming.applied += 1;
      } else {
        summary.incoming.conflicts += 1;
      }
      if (isSignalAborted(signal)) {
        return true;
      }
    }
    summary.incoming.workLimitReached = true;
    return false;
  }

  private async pushOutgoing(
    projectId: string,
    boundary: SettledIncrementalPushBoundary,
    summary: MutableSummary,
    signal: AbortSignal | undefined,
  ): Promise<{ aborted: boolean; failure: CloudSyncFailure | null }> {
    const projectOutbox = this.projectOutbox;
    if (projectOutbox === null) {
      return { aborted: false, failure: null };
    }
    for (let index = 0; index < this.limits.maximumOutgoingOperations; index += 1) {
      if (isSignalAborted(signal)) {
        return { aborted: true, failure: null };
      }
      const claimedAt = this.clock.now();
      const leaseToken = this.ids.next();
      const claimed = unwrap(
        await projectOutbox.claimNextForProject({
          projectId,
          deviceId: this.activeDeviceId,
          ownerId: this.ownerId,
          leaseToken,
          now: claimedAt,
          leaseExpiresAt: addMilliseconds(claimedAt, this.limits.leaseDurationMs),
        }),
      );
      if (claimed === null) {
        return { aborted: false, failure: null };
      }
      if (claimed.leaseOwnerId !== this.ownerId || claimed.leaseToken !== leaseToken) {
        throw new Error("Outgoing sync claim violated its lease scope.");
      }
      summary.outgoing.claimed += 1;
      if (
        claimed.operation.projectId !== projectId ||
        claimed.operation.deviceId !== this.activeDeviceId
      ) {
        await this.pauseOutgoing(claimed, "OUTBOX_PROJECT_SCOPE_MISMATCH");
        summary.outgoing.paused += 1;
        return {
          aborted: false,
          failure: {
            category: "permanent_paused",
            code: "OUTBOX_PROJECT_OR_DEVICE_SCOPE_MISMATCH",
          },
        };
      }

      let request: CloudSyncPushRequest;
      try {
        request = await this.buildPushRequest(boundary.signedRemoteCursor, claimed);
      } catch {
        await this.pauseOutgoing(claimed, "OUTBOX_PAYLOAD_INVALID");
        summary.outgoing.paused += 1;
        return {
          aborted: false,
          failure: {
            category: "permanent_paused",
            code: "OUTBOX_PAYLOAD_INVALID",
          },
        };
      }
      if (isSignalAborted(signal)) {
        // As with incoming work, an interrupted claimed item is recovered only
        // after its lease expires.
        return { aborted: true, failure: null };
      }

      try {
        // The key is derived from the complete immutable request. Reclaiming
        // the same body reuses it, while a changed base cursor produces a new
        // idempotency scope.
        const idempotencyKey = await outgoingIdempotencyKey(request);
        // Any access-token refresh occurs after a failed fenced transaction
        // rolls back and before runWithSession starts the next attempt. The
        // immutable request keeps both attempts in one idempotency scope.
        const fenced = await this.session.runWithSession(
          async (session) => {
            const sessionAccountId = session.account.accountId;
            const sessionDeviceId = session.device.device.deviceId;
            if (sessionDeviceId !== this.activeDeviceId) {
              throw new ProjectionPushAuthorityError("SYNC_DEVICE_AUTHORITY_CHANGED");
            }
            return this.projectionPushAuthority.pushProjectionOperationFenced(
              {
                projectId,
                operationId: claimed.operation.operationId,
                activeAccountId: sessionAccountId,
                activeDeviceId: sessionDeviceId,
                settledSignedRemoteCursor: boundary.signedRemoteCursor,
                settledDownloadedCheckpointRevision: boundary.downloadedCheckpointRevision,
                settledMaterializedCheckpointRevision: boundary.materializedCheckpointRevision,
                requestBaseCursor: request.baseCursor,
                leaseOwnerId: claimed.leaseOwnerId,
                leaseToken: claimed.leaseToken,
                authorizedAt: this.clock.now(),
                readAcknowledgedAt: () => this.clock.now(),
              },
              () =>
                this.api.pushSync(projectId, request, {
                  idempotencyKey,
                  ...(signal === undefined ? {} : { signal }),
                }),
            );
          },
          signal === undefined ? {} : { signal },
        );
        if (fenced.status === "blocked") {
          throw new ProjectionPushFenceBlockedError(fenced.reason);
        }
        summary.outgoing.pushed += 1;
        summary.outgoing.acknowledged += 1;
      } catch (cause: unknown) {
        if (isAbort(cause, signal)) {
          return { aborted: true, failure: null };
        }
        const classified = classifyPushFailure(cause);
        if (
          cause instanceof ProjectionPushFenceBlockedError &&
          cause.reason === "outbox_lease_mismatch"
        ) {
          // The claim was already replaced, revoked, or expired. There is no
          // exact lease left for this executor to mutate.
        } else if (classified.category === "permanent_paused") {
          await this.pauseOutgoing(claimed, classified.code);
          summary.outgoing.paused += 1;
        } else {
          await this.rescheduleOutgoing(claimed, classified.code);
          summary.outgoing.retried += 1;
        }
        return { aborted: false, failure: classified };
      }
    }
    summary.outgoing.workLimitReached = true;
    return { aborted: false, failure: null };
  }

  private async buildPushRequest(
    baseCursor: string | null,
    claimed: ClaimedSyncOperation,
  ): Promise<CloudSyncPushRequest> {
    const chunks: {
      readonly chunkId: string;
      readonly encrypted: EncryptedSyncChunkContract;
    }[] = [];
    for (const chunkId of claimed.operation.encryptedChunkIds) {
      const chunk = unwrap(await this.store.getEncryptedChunk(chunkId));
      if (
        chunk?.chunkId !== chunkId ||
        chunk.encrypted.aad.projectId !== claimed.operation.projectId ||
        chunk.encrypted.aad.objectType !== claimed.operation.objectType ||
        chunk.encrypted.aad.objectId !== claimed.operation.objectId
      ) {
        throw new Error("Stored ciphertext is missing or outside the operation scope.");
      }
      chunks.push({ chunkId: chunk.chunkId, encrypted: chunk.encrypted });
    }

    const tombstones: SyncTombstoneContract[] = [];
    if (claimed.operation.kind === "delete") {
      const tombstone = unwrap(
        await this.store.findTombstone(
          claimed.operation.projectId,
          claimed.operation.objectType,
          claimed.operation.objectId,
          claimed.operation.objectGeneration,
        ),
      );
      if (
        tombstone?.projectId !== claimed.operation.projectId ||
        tombstone.objectType !== claimed.operation.objectType ||
        tombstone.objectId !== claimed.operation.objectId ||
        tombstone.objectGeneration !== claimed.operation.objectGeneration ||
        tombstone.deletedByDeviceId !== claimed.operation.deviceId ||
        !sameVersionVector(tombstone.vector, claimed.operation.vector) ||
        tombstone.acknowledgedDeviceIds.length !== 0
      ) {
        throw new Error("The exact stored tombstone is unavailable.");
      }
      tombstones.push({
        schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
        ...tombstone,
        vector: { ...tombstone.vector },
        acknowledgedDeviceIds: [...tombstone.acknowledgedDeviceIds],
      });
    }

    return {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      baseCursor,
      operations: [toOperationContract(claimed.operation)],
      chunks,
      tombstones,
    };
  }

  private async rescheduleOutgoing(
    claimed: ClaimedSyncOperation,
    failureCode: string,
  ): Promise<void> {
    const now = this.clock.now();
    unwrap(
      await this.store.rescheduleFailure({
        operationId: claimed.operation.operationId,
        leaseToken: claimed.leaseToken,
        failureCode: normalizeResolutionCode(failureCode, "CLOUD_SYNC_PUSH_FAILED"),
        now,
        nextAttemptAt: retryAt(now, claimed.attempt, this.limits),
      }),
    );
  }

  private async pauseOutgoing(claimed: ClaimedSyncOperation, failureCode: string): Promise<void> {
    unwrap(
      await this.store.pauseFailure({
        operationId: claimed.operation.operationId,
        leaseToken: claimed.leaseToken,
        failureCode: normalizeResolutionCode(failureCode, "CLOUD_SYNC_PUSH_FAILED"),
        now: this.clock.now(),
      }),
    );
  }
}

function createSummary(hasProjectOutbox: boolean): MutableSummary {
  return {
    pull: {
      pages: 0,
      stagedBatches: 0,
      operations: 0,
      chunks: 0,
      tombstones: 0,
      pageLimitReached: false,
    },
    incoming: {
      claimed: 0,
      applied: 0,
      conflicts: 0,
      retried: 0,
      workLimitReached: false,
    },
    outgoing: {
      boundary: hasProjectOutbox ? "ready" : "project_scoped_claim_unavailable",
      claimed: 0,
      pushed: 0,
      acknowledged: 0,
      retried: 0,
      paused: 0,
      workLimitReached: false,
    },
  };
}

function finalize(
  projectId: string,
  state: CloudSyncCycleResult["state"],
  summary: MutableSummary,
  failure: CloudSyncFailure | null = null,
): CloudSyncCycleResult {
  return {
    projectId,
    state,
    failure,
    pull: { ...summary.pull },
    incoming: { ...summary.incoming },
    outgoing: { ...summary.outgoing },
  };
}

function settlementBoundary(
  settlement: CloudSyncIncrementalSettlementResult,
  checkpoint: Readonly<{
    projectId: string;
    signedRemoteCursor: string;
    revision: number;
  }>,
): {
  aborted: boolean;
  failure: CloudSyncFailure | null;
  boundary: SettledIncrementalPushBoundary | null;
} {
  const code = settlement.failure?.code ?? "SYNC_INCREMENTAL_SETTLEMENT_FAILED";
  switch (settlement.state) {
    case "ready":
      if (
        settlement.pushAllowed &&
        settlement.projectId === checkpoint.projectId &&
        settlement.checkpoint?.projectId === checkpoint.projectId &&
        settlement.checkpoint.signedRemoteCursor === checkpoint.signedRemoteCursor &&
        settlement.checkpoint.downloadedCheckpointRevision === checkpoint.revision &&
        settlement.registrationEnabled
      ) {
        return {
          aborted: false,
          failure: null,
          boundary: {
            projectId: checkpoint.projectId,
            signedRemoteCursor: checkpoint.signedRemoteCursor,
            downloadedCheckpointRevision: checkpoint.revision,
            materializedCheckpointRevision: settlement.checkpoint.revision,
          },
        };
      }
      return {
        aborted: false,
        failure: {
          category: "boundary_blocked",
          code: "SYNC_INCREMENTAL_SETTLEMENT_EVIDENCE_MISMATCH",
        },
        boundary: null,
      };
    case "aborted":
      return { aborted: true, failure: null, boundary: null };
    case "auth_blocked":
      return {
        aborted: false,
        failure: { category: "auth_blocked", code },
        boundary: null,
      };
    case "bootstrap_required":
      return {
        aborted: false,
        failure: { category: "bootstrap_required", code },
        boundary: null,
      };
    case "conflict_blocked":
      return {
        aborted: false,
        failure: { category: "conflict_blocked", code },
        boundary: null,
      };
    case "disabled":
      return {
        aborted: false,
        failure: {
          category: "boundary_blocked",
          code: "SYNC_INCREMENTAL_SETTLEMENT_DISABLED",
        },
        boundary: null,
      };
    case "permanent_paused":
      return {
        aborted: false,
        failure: { category: "permanent_paused", code },
        boundary: null,
      };
    case "retryable":
      return { aborted: false, failure: { category: "retryable", code }, boundary: null };
  }
}

function classifyLocalCycleOutcome(
  summary: MutableSummary,
  blocking: ProjectSyncBlockingState,
): Readonly<{
  state: "boundary_blocked" | "conflict_blocked" | "idle" | "permanent_paused" | "retryable";
  failure: CloudSyncFailure | null;
}> {
  if (summary.incoming.conflicts > 0 || blocking.incomingConflictCount > 0) {
    return {
      state: "conflict_blocked",
      failure: {
        category: "conflict_blocked",
        code: "INCOMING_VERSION_CONFLICT_REQUIRES_RESOLUTION",
      },
    };
  }
  if (blocking.incomingAttemptExhaustedCount > 0 || blocking.outgoingAttemptExhaustedCount > 0) {
    return {
      state: "permanent_paused",
      failure: {
        category: "permanent_paused",
        code: "SYNC_ATTEMPT_BUDGET_EXHAUSTED",
      },
    };
  }
  if (blocking.incomingPausedCount > 0 || blocking.outgoingPausedCount > 0) {
    return {
      state: "permanent_paused",
      failure: {
        category: "permanent_paused",
        code: blocking.incomingPausedCount > 0 ? "INCOMING_WORK_PAUSED" : "OUTGOING_WORK_PAUSED",
      },
    };
  }
  if (
    summary.pull.pageLimitReached ||
    summary.incoming.retried > 0 ||
    summary.incoming.workLimitReached ||
    blocking.incomingPendingCount > 0
  ) {
    return {
      state: "retryable",
      failure: { category: "retryable", code: "SYNC_WORK_REMAINS" },
    };
  }
  if (summary.outgoing.boundary === "project_scoped_claim_unavailable") {
    return {
      state: "boundary_blocked",
      failure: {
        category: "boundary_blocked",
        code: "PROJECT_SCOPED_OUTBOX_UNAVAILABLE",
      },
    };
  }
  if (
    summary.outgoing.retried > 0 ||
    summary.outgoing.workLimitReached ||
    blocking.outgoingPendingCount > 0
  ) {
    return {
      state: "retryable",
      failure: { category: "retryable", code: "SYNC_WORK_REMAINS" },
    };
  }
  return { state: "idle", failure: null };
}

function normalizeLimits(limits: CloudSyncOrchestratorLimits): NormalizedLimits {
  const retryBaseMs = requireBoundedInteger(
    limits.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    "retryBaseMs",
    100,
    60 * 60_000,
  );
  const retryMaximumMs = requireBoundedInteger(
    limits.retryMaximumMs ?? DEFAULT_RETRY_MAXIMUM_MS,
    "retryMaximumMs",
    retryBaseMs,
    24 * 60 * 60_000,
  );
  return {
    pullPageSize: requireBoundedInteger(
      limits.pullPageSize ?? DEFAULT_PULL_PAGE_SIZE,
      "pullPageSize",
      1,
      256,
    ),
    maximumPullPages: requireBoundedInteger(
      limits.maximumPullPages ?? DEFAULT_MAXIMUM_PULL_PAGES,
      "maximumPullPages",
      1,
      64,
    ),
    maximumIncomingOperations: requireBoundedInteger(
      limits.maximumIncomingOperations ?? DEFAULT_MAXIMUM_INCOMING_OPERATIONS,
      "maximumIncomingOperations",
      1,
      256,
    ),
    maximumOutgoingOperations: requireBoundedInteger(
      limits.maximumOutgoingOperations ?? DEFAULT_MAXIMUM_OUTGOING_OPERATIONS,
      "maximumOutgoingOperations",
      1,
      256,
    ),
    leaseDurationMs: requireBoundedInteger(
      limits.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
      1_000,
      10 * 60_000,
    ),
    retryBaseMs,
    retryMaximumMs,
  };
}

function requireBoundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} is outside the supported range.`);
  }
  return value;
}

function unwrap<T>(result: Result<T, AppError>): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function toOperationContract(operation: ClaimedSyncOperation["operation"]): SyncOperationContract {
  return {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    ...operation,
    vector: { ...operation.vector },
    encryptedChunkIds: [...operation.encryptedChunkIds],
  };
}

function normalizeResolutionCode(value: string, fallback: string): string {
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(value) ? value : fallback;
}

type IncomingApplyControl = Readonly<{
  kind: "abort" | "permanent" | "retry";
  failureCode: string;
}>;

function incomingApplyControlError(
  kind: IncomingApplyControl["kind"],
  failureCode: string,
): AppError {
  return new AppError({
    code: "REPOSITORY_ERROR",
    message: "The incoming sync materialization did not reach a terminal state.",
    retryable: true,
    actions: ["RETRY"],
    details: {
      operation: "CLOUD_SYNC_INCOMING_CONTROL",
      kind,
      failureCode: normalizeResolutionCode(failureCode, "INCOMING_APPLY_FAILED"),
    },
  });
}

function readIncomingApplyControl(error: AppError): IncomingApplyControl | null {
  if (error.details.operation !== "CLOUD_SYNC_INCOMING_CONTROL") {
    return null;
  }
  const kind = error.details.kind;
  const failureCode = error.details.failureCode;
  if (
    (kind !== "abort" && kind !== "permanent" && kind !== "retry") ||
    typeof failureCode !== "string"
  ) {
    return null;
  }
  return {
    kind,
    failureCode: normalizeResolutionCode(failureCode, "INCOMING_APPLY_FAILED"),
  };
}

type IncomingMaterializationFailure = Readonly<{
  disposition: "permanent" | "retry";
  code: string;
}>;

function classifyIncomingMaterializationFailure(
  cause: unknown,
  phase: "apply" | "prepare",
): IncomingMaterializationFailure {
  if (cause instanceof SyncCoreError) {
    return {
      disposition: cause.retryable ? "retry" : "permanent",
      code: normalizeResolutionCode(cause.code, `INCOMING_${phase.toUpperCase()}_FAILED`),
    };
  }
  if (cause instanceof AppError) {
    if (cause.retryable || cause.code === "INVALID_STATE_TRANSITION") {
      return {
        disposition: "retry",
        code: normalizeResolutionCode(cause.code, `INCOMING_${phase.toUpperCase()}_FAILED`),
      };
    }
    return {
      disposition: "permanent",
      code: normalizeResolutionCode(cause.code, `INCOMING_${phase.toUpperCase()}_FAILED`),
    };
  }
  return {
    // Unknown exceptions include transient native key-store and SQLite driver
    // failures. They must not permanently strand valid ciphertext.
    disposition: "retry",
    code: `INCOMING_${phase.toUpperCase()}_FAILED`,
  };
}

function classifyCloudFailure(cause: unknown): CloudSyncFailure | null {
  if (cause instanceof CloudSessionCoordinatorError) {
    return {
      category: "auth_blocked",
      code: normalizeResolutionCode(cause.sourceCode, "CLOUD_AUTHENTICATION_REQUIRED"),
    };
  }
  if (!(cause instanceof CloudClientError)) {
    return null;
  }
  const code = normalizeResolutionCode(cause.code, "CLOUD_SYNC_FAILED");
  if (cause.code === "CLOUD_NETWORK_UNAVAILABLE" || cause.code === "CLOUD_REQUEST_TIMEOUT") {
    return { category: "offline", code };
  }
  if (cause.code === "SYNC_CURSOR_EXPIRED") {
    return { category: "bootstrap_required", code };
  }
  if (
    cause.code === "CLOUD_AUTHENTICATION_REQUIRED" ||
    cause.code === "AUTH_ACCOUNT_FROZEN" ||
    cause.code === "AUTH_ACCOUNT_LOCKED" ||
    cause.code === "AUTH_DEVICE_REVOKED" ||
    cause.code === "AUTH_EMAIL_UNVERIFIED" ||
    cause.code === "AUTH_REFRESH_REPLAYED" ||
    cause.code === "AUTH_SESSION_EXPIRED" ||
    cause.code === "AUTH_SESSION_REVOKED" ||
    cause.code === "ACCESS_FORBIDDEN"
  ) {
    return { category: "auth_blocked", code };
  }
  if (
    cause.code === "IDEMPOTENCY_CONFLICT" ||
    cause.code === "SYNC_INVALID_CIPHERTEXT" ||
    cause.code === "SYNC_QUOTA_EXCEEDED" ||
    cause.code === "SYNC_SEQUENCE_CONFLICT" ||
    cause.code === "VALIDATION_FAILED"
  ) {
    return { category: "permanent_paused", code };
  }
  if (cause.retryable) {
    return { category: "retryable", code };
  }
  return { category: "permanent_paused", code };
}

function classifyPushFailure(cause: unknown): CloudSyncFailure {
  if (cause instanceof ProjectionOperationPushResponseMismatchError) {
    return { category: "permanent_paused", code: "SYNC_PUSH_RESPONSE_MISMATCH" };
  }
  if (cause instanceof ProjectionPushFenceBlockedError) {
    if (
      cause.reason === "base_cursor_mismatch" ||
      cause.reason === "incremental_work_pending" ||
      cause.reason === "materialized_checkpoint_mismatch" ||
      cause.reason === "outbox_lease_mismatch" ||
      cause.reason === "remote_checkpoint_mismatch"
    ) {
      return { category: "retryable", code: pushFenceFailureCode(cause.reason) };
    }
    return { category: "permanent_paused", code: pushGateFailureCode(cause.reason) };
  }
  if (cause instanceof ProjectionPushAuthorityError) {
    return { category: "permanent_paused", code: cause.code };
  }
  const cloud = classifyCloudFailure(cause);
  if (cloud !== null) {
    return cloud;
  }
  if (cause instanceof AppError && cause.retryable) {
    return {
      category: "retryable",
      code: normalizeResolutionCode(cause.code, "LOCAL_SYNC_FAILED"),
    };
  }
  return { category: "permanent_paused", code: "CLOUD_SYNC_PUSH_FAILED" };
}

class ProjectionPushFenceBlockedError extends Error {
  public override readonly name = "ProjectionPushFenceBlockedError";

  public constructor(public readonly reason: ProjectionOperationPushFenceReason) {
    super("The outgoing operation crossed a changed local sync boundary.");
  }
}

class ProjectionPushAuthorityError extends Error {
  public override readonly name = "ProjectionPushAuthorityError";

  public constructor(public readonly code: string) {
    super("The outgoing operation is no longer authorized by the active sync consent.");
  }
}

function pushGateFailureCode(reason: ProjectionOperationPushGate["reason"]): string {
  switch (reason) {
    case "allowed":
      return "SYNC_PROJECTION_AUTHORITY_CHANGED";
    case "registration_missing":
    case "not_enabled":
      return "SYNC_CONSENT_REVOKED";
    case "account_mismatch":
      return "SYNC_ACCOUNT_AUTHORITY_CHANGED";
    case "device_mismatch":
      return "SYNC_DEVICE_AUTHORITY_CHANGED";
    case "operation_unbound":
      return "SYNC_PROJECTION_AUTHORITY_MISSING";
    case "chapter_local_only":
      return "PRIVATE_CHAPTER_LOCAL_ONLY";
    case "authority_mismatch":
      return "SYNC_PROJECTION_AUTHORITY_CHANGED";
  }
}

function pushFenceFailureCode(
  reason: Extract<
    ProjectionOperationPushFenceReason,
    | "base_cursor_mismatch"
    | "incremental_work_pending"
    | "materialized_checkpoint_mismatch"
    | "outbox_lease_mismatch"
    | "remote_checkpoint_mismatch"
  >,
): string {
  switch (reason) {
    case "base_cursor_mismatch":
      return "SYNC_PUSH_BASE_CURSOR_CHANGED";
    case "incremental_work_pending":
      return "SYNC_PUSH_INCREMENTAL_WORK_PENDING";
    case "materialized_checkpoint_mismatch":
      return "SYNC_PUSH_MATERIALIZED_BOUNDARY_CHANGED";
    case "outbox_lease_mismatch":
      return "SYNC_PUSH_OUTBOX_LEASE_CHANGED";
    case "remote_checkpoint_mismatch":
      return "SYNC_PUSH_REMOTE_BOUNDARY_CHANGED";
  }
}

async function outgoingIdempotencyKey(request: CloudSyncPushRequest): Promise<string> {
  const digest = await sha256Hex(`inkshadow/cloud-sync-push/v1\u0000${canonicalJson(request)}`);
  return `sync.${digest}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameVersionVector(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isTerminalState(state: CloudSyncCycleResult["state"]): boolean {
  return (
    state === "auth_blocked" ||
    state === "boundary_blocked" ||
    state === "bootstrap_required" ||
    state === "conflict_blocked" ||
    state === "disabled" ||
    state === "permanent_paused"
  );
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbort(cause: unknown, signal: AbortSignal | undefined): boolean {
  return (
    isSignalAborted(signal) ||
    (cause instanceof CloudClientError && cause.code === "CLOUD_REQUEST_ABORTED") ||
    (cause instanceof DOMException && cause.name === "AbortError")
  );
}

function retryAt(
  now: string,
  attempt: number,
  limits: Pick<NormalizedLimits, "retryBaseMs" | "retryMaximumMs">,
): string {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  const delay = Math.min(limits.retryMaximumMs, limits.retryBaseMs * 2 ** exponent);
  return addMilliseconds(now, delay);
}

function retryDelayMs(
  consecutiveFailures: number,
  limits: Pick<NormalizedLimits, "retryBaseMs" | "retryMaximumMs">,
): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
  return Math.min(limits.retryMaximumMs, limits.retryBaseMs * 2 ** exponent);
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (isSignalAborted(signal)) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(handle);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const handle = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal !== undefined) {
      void Promise.resolve().then(() => {
        if (!signal.aborted) {
          return;
        }
        finish();
      });
    }
  });
}
