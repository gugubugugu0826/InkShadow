import type { ProjectSyncRegistration, SyncMaterializationSqliteStore } from "@inkshadow/data";
import type {
  SyncSnapshotStagingSummary,
  SyncSqliteStore,
} from "@inkshadow/data/sync-sqlite-store";
import { AppError, type Clock, type Result } from "@inkshadow/domain";

import type {
  CloudSyncBootstrapCoordinator,
  CloudSyncBootstrapResult,
} from "./cloud-sync-bootstrap-coordinator";
import type { CloudSyncCycleResult, CloudSyncOrchestrator } from "./cloud-sync-orchestrator";
import type {
  CloudSyncSnapshotMaterializationCoordinator,
  CloudSyncSnapshotMaterializationResult,
} from "./cloud-sync-snapshot-materialization-coordinator";
import {
  CloudSessionCoordinatorError,
  type CloudSessionCoordinator,
  type ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import type {
  OutgoingContentProjectionWorker,
  OutgoingContentProjectionWorkerOutcome,
  ProjectionProjectKeyOpener,
} from "./outgoing-content-projection-worker";

const DEFAULT_MAXIMUM_PROJECTION_JOBS = 128;
const MAXIMUM_PROJECTION_JOBS_LIMIT = 4_096;

export type CloudSyncRuntimeSession = Pick<CloudSessionCoordinator, "ensureReady">;

export type CloudSyncRuntimeRegistrationAuthority = Pick<
  SyncMaterializationSqliteStore,
  "loadProjectSyncRegistration" | "transitionProjectSyncRegistration"
>;

export type CloudSyncRuntimeSnapshotLocator = Pick<SyncSqliteStore, "readStagedSyncSnapshot">;

export type CloudSyncRuntimeBootstrap = Pick<CloudSyncBootstrapCoordinator, "runProjectBootstrap">;

export type CloudSyncRuntimeSnapshotMaterializer = Pick<
  CloudSyncSnapshotMaterializationCoordinator,
  "runProjectSnapshotMaterialization"
>;

export type CloudSyncRuntimeProjectionWorker = Pick<OutgoingContentProjectionWorker, "runOnce">;

export interface CloudSyncRuntimeAuthorityBinding {
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly consentRevision: number;
  readonly keyVersion: number;
  readonly registrationRevision: number;
}

/**
 * CloudSyncOrchestrator has an immutable activeDeviceId. A factory is therefore
 * required so every cycle is constructed from the session identity frozen by
 * this project run instead of a stale login.
 */
export interface CloudSyncRuntimeOrchestratorFactory {
  create(binding: CloudSyncRuntimeAuthorityBinding): Pick<CloudSyncOrchestrator, "runProjectCycle">;
}

export interface CloudSyncRuntimeLimits {
  /**
   * Maximum completed projection jobs per run. Reaching this bound without
   * observing idle is reported as remaining work.
   */
  readonly maximumProjectionJobs?: number;
}

export interface CloudSyncRuntimeServiceDependencies {
  /**
   * The complete runtime is opt-in. Omitting this flag performs no session,
   * database, key-store, projection, or network work.
   */
  readonly enabled?: boolean;
  readonly session: CloudSyncRuntimeSession;
  readonly authority: CloudSyncRuntimeRegistrationAuthority;
  readonly projectKeys: ProjectionProjectKeyOpener;
  readonly bootstrap: CloudSyncRuntimeBootstrap;
  readonly snapshotLocator: CloudSyncRuntimeSnapshotLocator;
  readonly snapshotMaterializer: CloudSyncRuntimeSnapshotMaterializer;
  readonly projectionWorker: CloudSyncRuntimeProjectionWorker;
  readonly orchestrators: CloudSyncRuntimeOrchestratorFactory;
  readonly clock: Pick<Clock, "now">;
  readonly limits?: CloudSyncRuntimeLimits;
}

export interface RunCloudSyncRuntimeProjectOptions {
  readonly signal?: AbortSignal;
}

export type CloudSyncRuntimePhase =
  | "configuration"
  | "session"
  | "authority"
  | "key"
  | "bootstrap"
  | "snapshot_materialization"
  | "incremental_intake"
  | "projection"
  | "sync"
  | "complete";

export type CloudSyncRuntimeState =
  | "aborted"
  | "auth_blocked"
  | "authority_blocked"
  | "bootstrap_blocked"
  | "completed"
  | "configuration_error"
  | "conflict_blocked"
  | "disabled"
  | "key_blocked"
  | "offline"
  | "permanent_paused"
  | "projection_blocked"
  | "retryable";

export type CloudSyncRuntimeFailureCategory =
  | "auth_blocked"
  | "authority_blocked"
  | "bootstrap_blocked"
  | "configuration_error"
  | "conflict_blocked"
  | "key_blocked"
  | "offline"
  | "permanent_paused"
  | "projection_blocked"
  | "retryable";

export interface CloudSyncRuntimeFailure {
  readonly phase: Exclude<CloudSyncRuntimePhase, "complete">;
  readonly category: CloudSyncRuntimeFailureCategory;
  readonly code: string;
}

export interface CloudSyncRuntimeProjectionSummary {
  readonly workerRuns: number;
  readonly completedJobs: number;
  readonly reachedIdle: boolean;
  readonly workLimitReached: boolean;
  readonly lastOutcome: OutgoingContentProjectionWorkerOutcome | null;
}

export interface CloudSyncRuntimeResult {
  readonly projectId: string;
  readonly state: CloudSyncRuntimeState;
  readonly phase: CloudSyncRuntimePhase;
  readonly pushAllowed: boolean;
  readonly binding: CloudSyncRuntimeAuthorityBinding | null;
  readonly failure: CloudSyncRuntimeFailure | null;
  readonly bootstrap: CloudSyncBootstrapResult | null;
  readonly snapshotMaterialization: CloudSyncSnapshotMaterializationResult | null;
  readonly incrementalIntake: CloudSyncCycleResult | null;
  readonly projection: OutgoingContentProjectionWorkerOutcome | null;
  readonly projectionSummary: CloudSyncRuntimeProjectionSummary | null;
  readonly sync: CloudSyncCycleResult | null;
}

interface MutableRuntimeEvidence {
  binding: CloudSyncRuntimeAuthorityBinding | null;
  bootstrap: CloudSyncBootstrapResult | null;
  snapshotMaterialization: CloudSyncSnapshotMaterializationResult | null;
  incrementalIntake: CloudSyncCycleResult | null;
  projection: OutgoingContentProjectionWorkerOutcome | null;
  projectionSummary: CloudSyncRuntimeProjectionSummary | null;
  sync: CloudSyncCycleResult | null;
}

interface FrozenAuthority {
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly consentRevision: number;
  readonly keyVersion: number;
}

interface ActiveRuntimeProject {
  readonly controller: AbortController;
  readonly promise: Promise<CloudSyncRuntimeResult>;
  readonly detachExternalSignal: () => void;
}

/**
 * Runs one fail-closed, project-scoped cloud cycle from bootstrap through
 * plaintext authority, outgoing projection, and network synchronization.
 */
export class CloudSyncRuntimeService {
  private readonly enabled: boolean;
  private readonly maximumProjectionJobs: number;
  private readonly activeProjects = new Map<string, ActiveRuntimeProject>();
  private readonly cancelledProjects = new Set<string>();

  public constructor(private readonly dependencies: CloudSyncRuntimeServiceDependencies) {
    this.enabled = dependencies.enabled === true;
    this.maximumProjectionJobs = requireBoundedInteger(
      dependencies.limits?.maximumProjectionJobs ?? DEFAULT_MAXIMUM_PROJECTION_JOBS,
      "maximumProjectionJobs",
      1,
      MAXIMUM_PROJECTION_JOBS_LIMIT,
    );
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public runProject(
    projectId: string,
    options: RunCloudSyncRuntimeProjectOptions = {},
  ): Promise<CloudSyncRuntimeResult> {
    const active = this.activeProjects.get(projectId);
    if (active !== undefined) {
      return active.promise;
    }
    if (this.cancelledProjects.has(projectId)) {
      return Promise.resolve(finish(projectId, "aborted", "configuration", false, emptyEvidence()));
    }
    const controller = new AbortController();
    const detachExternalSignal = forwardAbort(options.signal, controller);
    const run = this.execute(projectId, { signal: controller.signal }).finally(() => {
      const current = this.activeProjects.get(projectId);
      if (current?.promise === run) {
        this.activeProjects.delete(projectId);
      }
      detachExternalSignal();
    });
    this.activeProjects.set(projectId, { controller, promise: run, detachExternalSignal });
    return run;
  }

  /**
   * Establishes a persistent in-process privacy fence, aborts any current
   * project run, and resolves only after that run has stopped all work.
   */
  public async cancelAndWaitProject(projectId: string): Promise<void> {
    this.cancelledProjects.add(projectId);
    const active = this.activeProjects.get(projectId);
    if (active === undefined) {
      return;
    }
    active.controller.abort();
    await active.promise.catch(() => undefined);
  }

  /**
   * Opens the runtime again only after enrollment has atomically committed a
   * new clean transport/registration boundary.
   */
  public resumeProject(projectId: string): void {
    this.cancelledProjects.delete(projectId);
  }

  private async execute(
    projectId: string,
    options: RunCloudSyncRuntimeProjectOptions,
  ): Promise<CloudSyncRuntimeResult> {
    const evidence = emptyEvidence();
    if (!this.enabled) {
      return finish(projectId, "disabled", "configuration", false, evidence);
    }
    if (isAborted(options.signal)) {
      return finish(projectId, "aborted", "configuration", false, evidence);
    }

    let phase: Exclude<CloudSyncRuntimePhase, "complete"> = "session";
    let plaintextPushBoundary = false;
    try {
      const initialSession = await this.dependencies.session.ensureReady(
        signalOptions(options.signal),
      );
      throwIfAborted(options.signal);

      phase = "authority";
      const loadedRegistration = unwrap(
        await this.dependencies.authority.loadProjectSyncRegistration(projectId),
      );
      const runnable = requireRunnableAuthority(projectId, initialSession, loadedRegistration);
      let registration = runnable.registration;
      const frozen = runnable.authority;
      evidence.binding = bindingFromRegistration(registration);

      phase = "key";
      await this.requireExactProjectKey(frozen);
      throwIfAborted(options.signal);

      phase = "bootstrap";
      const bootstrap = await this.dependencies.bootstrap.runProjectBootstrap(
        projectId,
        bootstrapOptions(options.signal, () =>
          this.assertBootstrapAuthority(frozen, options.signal),
        ),
      );
      evidence.bootstrap = bootstrap;
      throwIfAborted(options.signal);
      const bootstrapFailure = failureFromBootstrap(bootstrap);
      if (bootstrapFailure !== null) {
        return finish(
          projectId,
          bootstrapFailure.state,
          "bootstrap",
          false,
          evidence,
          bootstrapFailure.failure,
        );
      }

      if (bootstrap.state === "ciphertext_baseline_committed") {
        phase = "snapshot_materialization";
        registration = await this.requireBootstrapRegistration(registration);
        evidence.binding = bindingFromRegistration(registration);
        const identity = await this.locateCommittedSnapshot(projectId);
        const materialized =
          await this.dependencies.snapshotMaterializer.runProjectSnapshotMaterialization(
            identity,
            signalOptions(options.signal),
          );
        evidence.snapshotMaterialization = materialized;
        const materializationFailure = failureFromSnapshotMaterialization(materialized);
        if (materializationFailure !== null) {
          return finish(
            projectId,
            materializationFailure.state,
            "snapshot_materialization",
            false,
            evidence,
            materializationFailure.failure,
          );
        }
      } else if (bootstrap.state === "incremental_available") {
        if (!isPlaintextEnabled(registration)) {
          phase = "incremental_intake";
          const intakeOrchestrator = this.dependencies.orchestrators.create(
            bindingFromRegistration(registration),
          );
          const intake = await intakeOrchestrator.runProjectCycle(
            projectId,
            signalOptions(options.signal),
          );
          requireSyncProject(intake, projectId);
          evidence.incrementalIntake = intake;
          const intakeFailure = failureFromSync(intake);
          if (intakeFailure !== null) {
            return finish(projectId, intakeFailure.state, "incremental_intake", false, evidence, {
              ...intakeFailure.failure,
              phase: "incremental_intake",
            });
          }
        }
      } else {
        return fail(
          projectId,
          "configuration_error",
          "bootstrap",
          false,
          evidence,
          "configuration_error",
          "SYNC_BOOTSTRAP_RESULT_NOT_RUNNABLE",
        );
      }

      throwIfAborted(options.signal);
      phase = "authority";
      registration = await this.rebindEnabledAuthority(frozen, options.signal);
      evidence.binding = bindingFromRegistration(registration);
      plaintextPushBoundary = true;

      phase = "key";
      await this.requireExactProjectKey(frozen);
      throwIfAborted(options.signal);

      phase = "projection";
      const projectionSummary = await this.drainProjection(projectId, options.signal);
      const projection = projectionSummary.lastOutcome;
      evidence.projection = projection;
      evidence.projectionSummary = projectionSummary;
      throwIfAborted(options.signal);

      phase = "sync";
      const orchestrator = this.dependencies.orchestrators.create(
        bindingFromRegistration(registration),
      );
      const sync = await orchestrator.runProjectCycle(projectId, signalOptions(options.signal));
      requireSyncProject(sync, projectId);
      evidence.sync = sync;
      const syncFailure = failureFromSync(sync);
      if (syncFailure !== null) {
        return finish(
          projectId,
          syncFailure.state,
          "sync",
          syncFailure.pushAllowed && plaintextPushBoundary,
          evidence,
          syncFailure.failure,
        );
      }

      const projectionFailure = failureFromProjectionSummary(projectionSummary);
      if (projectionFailure !== null) {
        return finish(
          projectId,
          projectionFailure.state,
          "projection",
          false,
          evidence,
          projectionFailure.failure,
        );
      }
      return finish(projectId, "completed", "complete", plaintextPushBoundary, evidence);
    } catch (cause: unknown) {
      if (isAbort(cause, options.signal)) {
        return finish(projectId, "aborted", phase, false, evidence);
      }
      const classified = classifyThrownFailure(cause, phase);
      return finish(projectId, classified.state, phase, false, evidence, classified.failure);
    }
  }

  private async requireBootstrapRegistration(
    registration: ProjectSyncRegistration,
  ): Promise<ProjectSyncRegistration> {
    if (registration.state === "bootstrap_required") {
      return registration;
    }
    if (registration.state !== "enabling" && registration.state !== "enabled") {
      throw authorityError(
        "SYNC_REGISTRATION_CANNOT_ENTER_BOOTSTRAP",
        "The project registration cannot enter snapshot bootstrap.",
      );
    }
    return unwrap(
      await this.dependencies.authority.transitionProjectSyncRegistration({
        projectId: registration.projectId,
        expectedAccountId: registration.accountId,
        expectedDeviceId: registration.deviceId,
        expectedConsentRevision: registration.consentRevision,
        expectedKeyVersion: registration.keyVersion,
        expectedRevision: registration.revision,
        target: { state: "bootstrap_required" },
        transitionedAt: this.dependencies.clock.now(),
      }),
    );
  }

  private async assertBootstrapAuthority(
    frozen: FrozenAuthority,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    throwIfAborted(signal);
    const registration = unwrap(
      await this.dependencies.authority.loadProjectSyncRegistration(frozen.projectId),
    );
    requireSameRegistrationAuthority(registration, frozen);
    if (
      registration.state === "disabled" ||
      registration.state === "paused" ||
      registration.state === "error"
    ) {
      throw authorityError(
        "SYNC_REGISTRATION_AUTHORITY_CHANGED",
        "The project sync registration was frozen while bootstrap was active.",
      );
    }
    throwIfAborted(signal);
  }

  private async locateCommittedSnapshot(
    projectId: string,
  ): Promise<Readonly<{ snapshotId: string; projectId: string; epoch: number }>> {
    const snapshot = unwrap(
      await this.dependencies.snapshotLocator.readStagedSyncSnapshot(projectId),
    );
    requireCommittedSnapshot(snapshot, projectId);
    return {
      snapshotId: snapshot.snapshotId,
      projectId: snapshot.projectId,
      epoch: snapshot.epoch,
    };
  }

  private async rebindEnabledAuthority(
    frozen: FrozenAuthority,
    signal: AbortSignal | undefined,
  ): Promise<ProjectSyncRegistration> {
    const currentSession = await this.dependencies.session.ensureReady(signalOptions(signal));
    requireSameSessionAuthority(currentSession, frozen);
    const registration = unwrap(
      await this.dependencies.authority.loadProjectSyncRegistration(frozen.projectId),
    );
    requireSameRegistrationAuthority(registration, frozen);
    if (!isPlaintextEnabled(registration)) {
      throw authorityError(
        "SYNC_PLAINTEXT_AUTHORITY_NOT_ENABLED",
        "Cloud push requires a completed plaintext bootstrap registration.",
      );
    }
    return registration;
  }

  private async requireExactProjectKey(frozen: FrozenAuthority): Promise<void> {
    const opened = await this.dependencies.projectKeys.openProjectDataKeyForDevice(
      frozen.projectId,
      frozen.deviceId,
      frozen.keyVersion,
    );
    if (opened.projectId !== frozen.projectId || opened.keyVersion !== frozen.keyVersion) {
      throw keyError(
        "SYNC_PROJECT_KEY_AUTHORITY_MISMATCH",
        "The opened project key does not match the frozen sync authority.",
      );
    }
  }

  private async drainProjection(
    projectId: string,
    signal: AbortSignal | undefined,
  ): Promise<CloudSyncRuntimeProjectionSummary> {
    let completedJobs = 0;
    let workerRuns = 0;
    let lastOutcome: OutgoingContentProjectionWorkerOutcome | null = null;
    while (completedJobs < this.maximumProjectionJobs) {
      throwIfAborted(signal);
      const outcome = await this.dependencies.projectionWorker.runOnce(projectId);
      requireProjectionProject(outcome, projectId);
      workerRuns += 1;
      lastOutcome = outcome;
      if (outcome.status === "completed") {
        completedJobs += 1;
        continue;
      }
      return {
        workerRuns,
        completedJobs,
        reachedIdle: outcome.status === "idle",
        workLimitReached: false,
        lastOutcome,
      };
    }
    return {
      workerRuns,
      completedJobs,
      reachedIdle: false,
      workLimitReached: true,
      lastOutcome,
    };
  }
}

function emptyEvidence(): MutableRuntimeEvidence {
  return {
    binding: null,
    bootstrap: null,
    snapshotMaterialization: null,
    incrementalIntake: null,
    projection: null,
    projectionSummary: null,
    sync: null,
  };
}

function requireRunnableAuthority(
  projectId: string,
  session: ConfiguredCloudSessionStatus,
  registration: ProjectSyncRegistration | null,
): Readonly<{
  authority: FrozenAuthority;
  registration: ProjectSyncRegistration;
}> {
  if (registration?.projectId !== projectId) {
    throw authorityError(
      "SYNC_REGISTRATION_REQUIRED",
      "A project sync registration is required before cloud runtime work.",
    );
  }
  if (registration.state === "disabled") {
    throw authorityError("SYNC_REGISTRATION_DISABLED", "Project cloud sync is disabled.");
  }
  if (registration.state === "paused") {
    throw authorityError("SYNC_REGISTRATION_PAUSED", "Project cloud sync is paused.");
  }
  if (registration.state === "error") {
    throw authorityError(
      registration.lastErrorCode ?? "SYNC_REGISTRATION_ERROR",
      "Project cloud sync is permanently paused.",
    );
  }
  const accountId = session.account.accountId;
  const deviceId = session.device.device.deviceId;
  if (registration.accountId !== accountId) {
    throw authorityError(
      "SYNC_ACCOUNT_AUTHORITY_MISMATCH",
      "The current cloud account does not own this project registration.",
    );
  }
  if (registration.deviceId !== deviceId) {
    throw authorityError(
      "SYNC_DEVICE_AUTHORITY_MISMATCH",
      "The current cloud device does not own this project registration.",
    );
  }
  if (
    (registration.state === "enabled" && !registration.plaintextBootstrapCompleted) ||
    (registration.state !== "enabled" && registration.plaintextBootstrapCompleted)
  ) {
    throw authorityError(
      "SYNC_REGISTRATION_PLAINTEXT_STATE_INVALID",
      "The project registration plaintext authority is inconsistent.",
    );
  }
  return {
    authority: {
      projectId,
      accountId,
      deviceId,
      consentRevision: registration.consentRevision,
      keyVersion: registration.keyVersion,
    },
    registration,
  };
}

function requireSameSessionAuthority(
  session: ConfiguredCloudSessionStatus,
  frozen: FrozenAuthority,
): void {
  if (
    session.account.accountId !== frozen.accountId ||
    session.device.device.deviceId !== frozen.deviceId
  ) {
    throw authorityError(
      "SYNC_SESSION_AUTHORITY_CHANGED",
      "The cloud session authority changed during the project run.",
    );
  }
}

function requireSameRegistrationAuthority(
  registration: ProjectSyncRegistration | null,
  frozen: FrozenAuthority,
): asserts registration is ProjectSyncRegistration {
  if (
    registration?.projectId !== frozen.projectId ||
    registration.accountId !== frozen.accountId ||
    registration.deviceId !== frozen.deviceId ||
    registration.consentRevision !== frozen.consentRevision ||
    registration.keyVersion !== frozen.keyVersion
  ) {
    throw authorityError(
      "SYNC_REGISTRATION_AUTHORITY_CHANGED",
      "The project sync authority changed during the project run.",
    );
  }
}

function requireCommittedSnapshot(
  snapshot: SyncSnapshotStagingSummary | null,
  projectId: string,
): asserts snapshot is SyncSnapshotStagingSummary {
  if (
    snapshot?.projectId !== projectId ||
    snapshot.state !== "committed" ||
    snapshot.committedAt === null ||
    snapshot.committedCheckpointRevision === null
  ) {
    throw authorityError(
      "SYNC_COMMITTED_SNAPSHOT_REQUIRED",
      "A committed ciphertext snapshot is required before plaintext materialization.",
    );
  }
}

function bindingFromRegistration(
  registration: ProjectSyncRegistration,
): CloudSyncRuntimeAuthorityBinding {
  return Object.freeze({
    projectId: registration.projectId,
    accountId: registration.accountId,
    deviceId: registration.deviceId,
    consentRevision: registration.consentRevision,
    keyVersion: registration.keyVersion,
    registrationRevision: registration.revision,
  });
}

function isPlaintextEnabled(
  registration: ProjectSyncRegistration,
): registration is ProjectSyncRegistration & Readonly<{ state: "enabled" }> {
  return (
    registration.state === "enabled" &&
    registration.plaintextBootstrapCompleted &&
    registration.lastErrorCode === null &&
    registration.enabledAt !== null &&
    registration.pausedAt === null
  );
}

function failureFromBootstrap(bootstrap: CloudSyncBootstrapResult): Readonly<{
  state: CloudSyncRuntimeState;
  failure: CloudSyncRuntimeFailure;
}> | null {
  switch (bootstrap.state) {
    case "incremental_available":
    case "ciphertext_baseline_committed":
      return null;
    case "aborted":
      return runtimeFailure("aborted", "bootstrap", "retryable", "SYNC_RUNTIME_ABORTED");
    case "auth_blocked":
      return runtimeFailure(
        "auth_blocked",
        "bootstrap",
        "auth_blocked",
        bootstrap.failure?.code ?? "AUTH_SESSION_REQUIRED",
      );
    case "ciphertext_bootstrap_incomplete":
      return runtimeFailure(
        "bootstrap_blocked",
        "bootstrap",
        "bootstrap_blocked",
        bootstrap.failure?.code ?? "SYNC_BOOTSTRAP_INCOMPLETE",
      );
    case "disabled":
      return runtimeFailure(
        "configuration_error",
        "bootstrap",
        "configuration_error",
        "SYNC_BOOTSTRAP_COORDINATOR_DISABLED",
      );
    case "offline":
      return runtimeFailure(
        "offline",
        "bootstrap",
        "offline",
        bootstrap.failure?.code ?? "NETWORK_OFFLINE",
      );
    case "permanent_paused":
      return runtimeFailure(
        "permanent_paused",
        "bootstrap",
        "permanent_paused",
        bootstrap.failure?.code ?? "SYNC_BOOTSTRAP_PERMANENT_FAILURE",
      );
    case "retryable":
      return runtimeFailure(
        "retryable",
        "bootstrap",
        "retryable",
        bootstrap.failure?.code ?? "SYNC_BOOTSTRAP_RETRYABLE",
      );
  }
}

function failureFromSnapshotMaterialization(
  materialization: CloudSyncSnapshotMaterializationResult,
): Readonly<{
  state: CloudSyncRuntimeState;
  failure: CloudSyncRuntimeFailure;
}> | null {
  switch (materialization.state) {
    case "plaintext_bootstrap_completed":
      if (materialization.pushAllowed && !materialization.plaintextMaterializationRequired) {
        return null;
      }
      return runtimeFailure(
        "authority_blocked",
        "snapshot_materialization",
        "authority_blocked",
        "SYNC_PLAINTEXT_BOUNDARY_NOT_PROVEN",
      );
    case "aborted":
      return runtimeFailure(
        "aborted",
        "snapshot_materialization",
        "retryable",
        "SYNC_RUNTIME_ABORTED",
      );
    case "conflict_blocked":
      return runtimeFailure(
        "conflict_blocked",
        "snapshot_materialization",
        "conflict_blocked",
        materialization.failure?.code ?? "SYNC_CONTENT_CONFLICT",
      );
    case "disabled":
      return runtimeFailure(
        "configuration_error",
        "snapshot_materialization",
        "configuration_error",
        "SYNC_SNAPSHOT_MATERIALIZER_DISABLED",
      );
    case "permanent_paused":
      return runtimeFailure(
        "permanent_paused",
        "snapshot_materialization",
        "permanent_paused",
        materialization.failure?.code ?? "SYNC_SNAPSHOT_MATERIALIZATION_FAILED",
      );
    case "retryable":
      return runtimeFailure(
        "retryable",
        "snapshot_materialization",
        "retryable",
        materialization.failure?.code ?? "SYNC_SNAPSHOT_MATERIALIZATION_RETRYABLE",
      );
  }
}

function failureFromProjectionSummary(summary: CloudSyncRuntimeProjectionSummary): Readonly<{
  state: CloudSyncRuntimeState;
  failure: CloudSyncRuntimeFailure;
}> | null {
  if (summary.workLimitReached) {
    return runtimeFailure(
      "retryable",
      "projection",
      "retryable",
      "SYNC_PROJECTION_WORK_LIMIT_REACHED",
    );
  }
  const projection = summary.lastOutcome;
  if (projection === null) {
    return runtimeFailure(
      "retryable",
      "projection",
      "retryable",
      "SYNC_PROJECTION_OUTCOME_MISSING",
    );
  }
  switch (projection.status) {
    case "completed":
    case "idle":
      return null;
    case "failed":
    case "attempt_exhausted":
    case "permanent_failure":
      return runtimeFailure(
        "projection_blocked",
        "projection",
        "projection_blocked",
        projection.failureCode,
      );
    case "backoff":
      return runtimeFailure(
        "retryable",
        "projection",
        "retryable",
        projection.failureCode ?? "SYNC_PROJECTION_BACKOFF",
      );
    case "blocked":
      return runtimeFailure(
        "retryable",
        "projection",
        "retryable",
        `SYNC_PROJECTION_BLOCKED_${projection.reason.toUpperCase()}`,
      );
    case "lease_lost":
    case "retry_scheduled":
      return runtimeFailure("retryable", "projection", "retryable", projection.failureCode);
  }
}

function failureFromSync(sync: CloudSyncCycleResult): Readonly<{
  state: CloudSyncRuntimeState;
  pushAllowed: boolean;
  failure: CloudSyncRuntimeFailure;
}> | null {
  const code = sync.failure?.code ?? "SYNC_CYCLE_FAILED";
  switch (sync.state) {
    case "idle":
      return null;
    case "aborted":
      return { ...runtimeFailure("aborted", "sync", "retryable", code), pushAllowed: false };
    case "auth_blocked":
      return {
        ...runtimeFailure("auth_blocked", "sync", "auth_blocked", code),
        pushAllowed: false,
      };
    case "boundary_blocked":
      return {
        ...runtimeFailure("authority_blocked", "sync", "authority_blocked", code),
        pushAllowed: false,
      };
    case "bootstrap_required":
      return {
        ...runtimeFailure("bootstrap_blocked", "sync", "bootstrap_blocked", code),
        pushAllowed: false,
      };
    case "conflict_blocked":
      return {
        ...runtimeFailure("conflict_blocked", "sync", "conflict_blocked", code),
        pushAllowed: false,
      };
    case "disabled":
      return {
        ...runtimeFailure(
          "configuration_error",
          "sync",
          "configuration_error",
          "SYNC_ORCHESTRATOR_DISABLED",
        ),
        pushAllowed: false,
      };
    case "offline":
      return {
        ...runtimeFailure("offline", "sync", "offline", code),
        pushAllowed: false,
      };
    case "permanent_paused":
      return {
        ...runtimeFailure("permanent_paused", "sync", "permanent_paused", code),
        pushAllowed: false,
      };
    case "retryable":
      return {
        ...runtimeFailure("retryable", "sync", "retryable", code),
        pushAllowed: false,
      };
  }
}

function classifyThrownFailure(
  cause: unknown,
  phase: Exclude<CloudSyncRuntimePhase, "complete">,
): Readonly<{ state: CloudSyncRuntimeState; failure: CloudSyncRuntimeFailure }> {
  if (cause instanceof RuntimeBoundaryError) {
    return runtimeFailure(cause.state, phase, cause.category, cause.code);
  }
  if (cause instanceof CloudSessionCoordinatorError) {
    return runtimeFailure("auth_blocked", phase, "auth_blocked", cause.sourceCode);
  }
  if (cause instanceof AppError) {
    if (cause.retryable || cause.code === "INVALID_STATE_TRANSITION") {
      return runtimeFailure("retryable", phase, "retryable", cause.code);
    }
    return runtimeFailure(
      phase === "key" ? "key_blocked" : "permanent_paused",
      phase,
      phase === "key" ? "key_blocked" : "permanent_paused",
      cause.code,
    );
  }
  return runtimeFailure("retryable", phase, "retryable", "SYNC_RUNTIME_UNEXPECTED_FAILURE");
}

class RuntimeBoundaryError extends Error {
  public constructor(
    public readonly state: CloudSyncRuntimeState,
    public readonly category: CloudSyncRuntimeFailureCategory,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeBoundaryError";
  }
}

function authorityError(code: string, message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError("authority_blocked", "authority_blocked", code, message);
}

function keyError(code: string, message: string): RuntimeBoundaryError {
  return new RuntimeBoundaryError("key_blocked", "key_blocked", code, message);
}

function runtimeFailure(
  state: CloudSyncRuntimeState,
  phase: Exclude<CloudSyncRuntimePhase, "complete">,
  category: CloudSyncRuntimeFailureCategory,
  code: string,
): Readonly<{ state: CloudSyncRuntimeState; failure: CloudSyncRuntimeFailure }> {
  return {
    state,
    failure: {
      phase,
      category,
      code: normalizeFailureCode(code),
    },
  };
}

function fail(
  projectId: string,
  state: CloudSyncRuntimeState,
  phase: Exclude<CloudSyncRuntimePhase, "complete">,
  pushAllowed: boolean,
  evidence: MutableRuntimeEvidence,
  category: CloudSyncRuntimeFailureCategory,
  code: string,
): CloudSyncRuntimeResult {
  return finish(
    projectId,
    state,
    phase,
    pushAllowed,
    evidence,
    runtimeFailure(state, phase, category, code).failure,
  );
}

function finish(
  projectId: string,
  state: CloudSyncRuntimeState,
  phase: CloudSyncRuntimePhase,
  pushAllowed: boolean,
  evidence: MutableRuntimeEvidence,
  failure: CloudSyncRuntimeFailure | null = null,
): CloudSyncRuntimeResult {
  return {
    projectId,
    state,
    phase,
    pushAllowed,
    binding: evidence.binding,
    failure,
    bootstrap: evidence.bootstrap,
    snapshotMaterialization: evidence.snapshotMaterialization,
    incrementalIntake: evidence.incrementalIntake,
    projection: evidence.projection,
    projectionSummary: evidence.projectionSummary,
    sync: evidence.sync,
  };
}

function requireProjectionProject(
  projection: OutgoingContentProjectionWorkerOutcome,
  projectId: string,
): void {
  if (projection.projectId !== projectId) {
    throw authorityError(
      "SYNC_PROJECTION_PROJECT_MISMATCH",
      "The projection worker returned another project.",
    );
  }
}

function requireSyncProject(sync: CloudSyncCycleResult, projectId: string): void {
  if (sync.projectId !== projectId) {
    throw authorityError(
      "SYNC_CYCLE_PROJECT_MISMATCH",
      "The cloud orchestrator returned another project.",
    );
  }
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function normalizeFailureCode(value: string): string {
  return /^[A-Z][A-Z0-9_.:-]{2,119}$/u.test(value) ? value : "SYNC_RUNTIME_UNCLASSIFIED_FAILURE";
}

function requireBoundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${String(minimum)} and ${String(maximum)}.`);
  }
  return value;
}

function signalOptions(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? {} : { signal };
}

function bootstrapOptions(
  signal: AbortSignal | undefined,
  assertAuthority: () => Promise<void>,
): Readonly<{ signal?: AbortSignal; assertAuthority: () => Promise<void> }> {
  return signal === undefined ? { assertAuthority } : { signal, assertAuthority };
}

function forwardAbort(source: AbortSignal | undefined, destination: AbortController): () => void {
  if (source === undefined) {
    return () => undefined;
  }
  if (source.aborted) {
    destination.abort();
    return () => undefined;
  }
  const abort = () => destination.abort();
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (isAborted(signal)) {
    throw new DOMException("The cloud sync runtime project run was aborted.", "AbortError");
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbort(cause: unknown, signal: AbortSignal | undefined): boolean {
  return (
    isAborted(signal) ||
    (typeof DOMException !== "undefined" &&
      cause instanceof DOMException &&
      cause.name === "AbortError")
  );
}
