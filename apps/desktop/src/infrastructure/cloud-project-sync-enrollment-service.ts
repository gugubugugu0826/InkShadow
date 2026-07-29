import type {
  ProjectKeyBundle,
  ProjectKeySqliteStore,
  ProjectSyncRegistration,
  SyncMaterializationSqliteStore,
} from "@inkshadow/data";
import type { ProjectSyncBlockingState, SyncSqliteStore } from "@inkshadow/data/sync-sqlite-store";
import { AppError, type Clock, type Result } from "@inkshadow/domain";

import {
  CloudSessionCoordinatorError,
  type CloudSessionCoordinator,
  type ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import type { CloudSyncRuntimeResult, CloudSyncRuntimeService } from "./cloud-sync-runtime-service";

export type CloudProjectSyncEnrollmentSession = Pick<CloudSessionCoordinator, "runWithSession">;

export type CloudProjectSyncEnrollmentAuthority = Pick<
  SyncMaterializationSqliteStore,
  "beginProjectSyncEnableIfTransportClean" | "disableProjectSync" | "loadProjectSyncRegistration"
>;

export type CloudProjectSyncEnrollmentTransportAudit = Pick<
  SyncSqliteStore,
  "readProjectSyncBlockingState"
>;

export type CloudProjectSyncEnrollmentKeyStore = Pick<
  ProjectKeySqliteStore,
  "loadProjectKeyBundle"
>;

export type CloudProjectSyncEnrollmentRuntime = Pick<
  CloudSyncRuntimeService,
  "cancelAndWaitProject" | "resumeProject" | "runProject"
>;

export interface CloudProjectSyncKeyPublicationEvidence {
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly devicePublicKeyFingerprint: string;
  readonly keyVersion: number;
}

/**
 * This port must be checkpoint-aware and idempotent. In particular, an
 * implementation must treat an already-published exact key as success instead
 * of blindly replaying publishInitialProjectKey against an existing checkpoint.
 */
export interface CloudProjectSyncKeyPublicationPort {
  ensurePublished(
    authority: Readonly<{
      projectId: string;
      accountId: string;
      deviceId: string;
      devicePublicKeyFingerprint: string;
      keyVersion: number;
    }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<CloudProjectSyncKeyPublicationEvidence>;
}

export interface CloudProjectSyncEnrollmentServiceDependencies {
  /**
   * Enrollment is opt-in. Omitting this flag touches no session, database,
   * native key store, publication service, or sync runtime.
   */
  readonly enabled?: boolean;
  readonly session: CloudProjectSyncEnrollmentSession;
  readonly authority: CloudProjectSyncEnrollmentAuthority;
  readonly transportAudit: CloudProjectSyncEnrollmentTransportAudit;
  readonly keyStore: CloudProjectSyncEnrollmentKeyStore;
  readonly keyPublication: CloudProjectSyncKeyPublicationPort;
  readonly runtime: CloudProjectSyncEnrollmentRuntime;
  readonly clock: Pick<Clock, "now">;
}

export interface CloudProjectSyncEnrollmentOperationOptions {
  readonly signal?: AbortSignal;
}

export type CloudProjectSyncEnrollmentPhase =
  | "configuration"
  | "session"
  | "authority"
  | "transport_audit"
  | "project_key"
  | "key_publication"
  | "registration"
  | "runtime"
  | "verification";

export type CloudProjectSyncEnrollmentErrorCode =
  | "SYNC_ENROLLMENT_ACCOUNT_MISMATCH"
  | "SYNC_ENROLLMENT_BUSY"
  | "SYNC_ENROLLMENT_CONSENT_REVISION_EXHAUSTED"
  | "SYNC_ENROLLMENT_DEVICE_MISMATCH"
  | "SYNC_ENROLLMENT_KEY_AUTHORITY_MISMATCH"
  | "SYNC_ENROLLMENT_KEY_PUBLICATION_MISMATCH"
  | "SYNC_ENROLLMENT_LOCAL_KEY_REQUIRED"
  | "SYNC_ENROLLMENT_OPERATION_FAILED"
  | "SYNC_ENROLLMENT_RECOVERY_CONFIRMATION_REQUIRED"
  | "SYNC_ENROLLMENT_REGISTRATION_INVALID"
  | "SYNC_ENROLLMENT_RUNTIME_COMPLETION_UNVERIFIED"
  | "SYNC_ENROLLMENT_UNACKNOWLEDGED_OUTBOX";

export class CloudProjectSyncEnrollmentError extends Error {
  public readonly code: string;
  public readonly phase: CloudProjectSyncEnrollmentPhase;
  public readonly retryable: boolean;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(input: {
    readonly code: string;
    readonly phase: CloudProjectSyncEnrollmentPhase;
    readonly message: string;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message);
    this.name = "CloudProjectSyncEnrollmentError";
    this.code = input.code;
    this.phase = input.phase;
    this.retryable = input.retryable ?? false;
    this.details = Object.freeze({ ...(input.details ?? {}) });
  }
}

export interface CloudProjectSyncEnrollmentFailure {
  readonly phase: "runtime";
  readonly code: string;
  readonly retryable: boolean;
}

export type CloudProjectSyncEnableState =
  "aborted" | "blocked" | "configuration_disabled" | "enabled" | "retryable";

export interface CloudProjectSyncEnableResult {
  readonly operation: "enable";
  readonly projectId: string;
  readonly state: CloudProjectSyncEnableState;
  readonly accountId: string | null;
  readonly deviceId: string | null;
  readonly consentRevision: number | null;
  readonly keyVersion: number | null;
  readonly registration: ProjectSyncRegistration | null;
  readonly runtime: CloudSyncRuntimeResult | null;
  readonly failure: CloudProjectSyncEnrollmentFailure | null;
}

export type CloudProjectSyncDisableState =
  "aborted" | "already_disabled" | "configuration_disabled" | "disabled";

export interface CloudProjectSyncDisableResult {
  readonly operation: "disable";
  readonly projectId: string;
  readonly state: CloudProjectSyncDisableState;
  readonly accountId: string | null;
  readonly deviceId: string | null;
  readonly consentRevision: number | null;
  readonly registration: ProjectSyncRegistration | null;
}

type EnrollmentOperation = "disable" | "enable";

interface ActiveEnrollmentFlight {
  readonly operation: EnrollmentOperation;
  readonly controller: AbortController;
  readonly promise: Promise<CloudProjectSyncDisableResult | CloudProjectSyncEnableResult>;
}

interface FrozenEnrollmentAuthority {
  readonly projectId: string;
  readonly accountId: string;
  readonly deviceId: string;
  readonly devicePublicKeyFingerprint: string;
  readonly consentRevision: number;
  readonly keyVersion: number;
}

interface EnablePlan {
  readonly consentRevision: number;
  readonly expectedRevision: number | null;
  readonly beginRequired: boolean;
}

/**
 * Owns the explicit-consent boundary for project cloud synchronization.
 *
 * The service never deletes cloud ciphertext. Disable only invokes the local
 * atomic registration/transport revocation primitive. Re-enrollment is
 * fail-closed while any old outbox record remains unacknowledged, because a new
 * device or consent epoch cannot safely infer whether the cloud observed that
 * predecessor vector.
 */
export class CloudProjectSyncEnrollmentService {
  private readonly enabled: boolean;
  private readonly activeProjects = new Map<string, ActiveEnrollmentFlight>();

  public constructor(private readonly dependencies: CloudProjectSyncEnrollmentServiceDependencies) {
    this.enabled = dependencies.enabled === true;
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public async loadProjectRegistration(projectId: string): Promise<ProjectSyncRegistration | null> {
    if (!this.enabled) {
      return null;
    }
    return unwrap(await this.dependencies.authority.loadProjectSyncRegistration(projectId));
  }

  public enableProject(
    projectId: string,
    options: CloudProjectSyncEnrollmentOperationOptions = {},
  ): Promise<CloudProjectSyncEnableResult> {
    if (!this.enabled) {
      return Promise.resolve(emptyEnableResult(projectId, "configuration_disabled"));
    }
    if (options.signal?.aborted === true) {
      return Promise.resolve(emptyEnableResult(projectId, "aborted"));
    }
    const active = this.activeProjects.get(projectId);
    if (active !== undefined) {
      if (active.operation !== "enable") {
        return Promise.reject(busyError("enable"));
      }
      return active.promise as Promise<CloudProjectSyncEnableResult>;
    }

    const controller = new AbortController();
    const detachExternalSignal = forwardAbort(options.signal, controller);
    const promise = this.executeEnable(projectId, { signal: controller.signal }).finally(() => {
      if (this.activeProjects.get(projectId)?.promise === promise) {
        this.activeProjects.delete(projectId);
      }
      detachExternalSignal();
    });
    this.activeProjects.set(projectId, { operation: "enable", controller, promise });
    return promise;
  }

  public disableProject(
    projectId: string,
    options: CloudProjectSyncEnrollmentOperationOptions = {},
  ): Promise<CloudProjectSyncDisableResult> {
    if (!this.enabled) {
      return Promise.resolve(emptyDisableResult(projectId, "configuration_disabled"));
    }
    if (options.signal?.aborted === true) {
      return Promise.resolve(emptyDisableResult(projectId, "aborted"));
    }
    const active = this.activeProjects.get(projectId);
    if (active !== undefined) {
      if (active.operation === "disable") {
        return active.promise as Promise<CloudProjectSyncDisableResult>;
      }
      active.controller.abort();
    }

    // Close runtime admission synchronously with the disable request. Waiting
    // for an in-flight enable before establishing this fence leaves a window
    // where the supervisor can observe the newly committed registration and
    // start another project run.
    const runtimeCancellation = this.dependencies.runtime.cancelAndWaitProject(projectId);
    const precedingEnable =
      active?.operation === "enable" ? active.promise.catch(() => undefined) : Promise.resolve();
    const controller = new AbortController();
    const promise = this.executeDisable(projectId, precedingEnable, runtimeCancellation).finally(
      () => {
        if (this.activeProjects.get(projectId)?.promise === promise) {
          this.activeProjects.delete(projectId);
        }
      },
    );
    this.activeProjects.set(projectId, { operation: "disable", controller, promise });
    return promise;
  }

  private async executeEnable(
    projectId: string,
    options: CloudProjectSyncEnrollmentOperationOptions,
  ): Promise<CloudProjectSyncEnableResult> {
    let phase: CloudProjectSyncEnrollmentPhase = "session";
    let frozen: FrozenEnrollmentAuthority | null = null;
    let registration: ProjectSyncRegistration | null = null;
    try {
      const session = await this.currentSession(options.signal);
      throwIfAborted(options.signal);

      phase = "authority";
      registration = unwrap(
        await this.dependencies.authority.loadProjectSyncRegistration(projectId),
      );
      requireRegistrationIdentity(registration, session);

      if (registration === null || registration.state === "disabled") {
        phase = "transport_audit";
        const blocking = unwrap(
          await this.dependencies.transportAudit.readProjectSyncBlockingState(projectId),
        );
        validateTransportAudit(blocking, projectId);
      }
      throwIfAborted(options.signal);

      phase = "project_key";
      const bundle = unwrap(
        await this.dependencies.keyStore.loadProjectKeyBundle(
          projectId,
          session.device.device.deviceId,
        ),
      );
      const keyVersion = requireConfirmedActiveKey(bundle, projectId, session);
      const plan = buildEnablePlan(registration, keyVersion);
      frozen = {
        projectId,
        accountId: session.account.accountId,
        deviceId: session.device.device.deviceId,
        devicePublicKeyFingerprint: session.device.publicKey.publicKeyFingerprint,
        consentRevision: plan.consentRevision,
        keyVersion,
      };
      throwIfAborted(options.signal);

      phase = "key_publication";
      const publication = await this.dependencies.keyPublication.ensurePublished(
        {
          projectId: frozen.projectId,
          accountId: frozen.accountId,
          deviceId: frozen.deviceId,
          devicePublicKeyFingerprint: frozen.devicePublicKeyFingerprint,
          keyVersion: frozen.keyVersion,
        },
        signalOptions(options.signal),
      );
      requirePublicationEvidence(publication, frozen);
      throwIfAborted(options.signal);

      phase = "registration";
      if (plan.beginRequired) {
        registration = unwrap(
          await this.dependencies.authority.beginProjectSyncEnableIfTransportClean({
            projectId,
            accountId: frozen.accountId,
            deviceId: frozen.deviceId,
            consentRevision: frozen.consentRevision,
            keyVersion: frozen.keyVersion,
            expectedRevision: plan.expectedRevision,
            begunAt: this.dependencies.clock.now(),
          }),
        );
      }
      requireFrozenRegistration(registration, frozen);
      throwIfAborted(options.signal);
      this.dependencies.runtime.resumeProject(projectId);
      throwIfAborted(options.signal);

      phase = "runtime";
      const runtime = await this.dependencies.runtime.runProject(
        projectId,
        signalOptions(options.signal),
      );
      requireRuntimeProject(runtime, projectId);

      phase = "verification";
      const current = unwrap(
        await this.dependencies.authority.loadProjectSyncRegistration(projectId),
      );
      requireFrozenRegistration(current, frozen);
      if (runtime.state !== "completed") {
        return runtimeEnableResult(frozen, current, runtime);
      }
      requireCompletedRuntime(runtime, current, frozen);
      return {
        operation: "enable",
        projectId,
        state: "enabled",
        accountId: frozen.accountId,
        deviceId: frozen.deviceId,
        consentRevision: frozen.consentRevision,
        keyVersion: frozen.keyVersion,
        registration: current,
        runtime,
        failure: null,
      };
    } catch (cause: unknown) {
      if (isAbort(cause, options.signal)) {
        return {
          operation: "enable",
          projectId,
          state: "aborted",
          accountId: frozen?.accountId ?? null,
          deviceId: frozen?.deviceId ?? null,
          consentRevision: frozen?.consentRevision ?? null,
          keyVersion: frozen?.keyVersion ?? null,
          registration,
          runtime: null,
          failure: null,
        };
      }
      throw classifyOperationError(cause, phase);
    }
  }

  private async executeDisable(
    projectId: string,
    precedingEnable: Promise<unknown>,
    runtimeCancellation: Promise<void>,
  ): Promise<CloudProjectSyncDisableResult> {
    let phase: CloudProjectSyncEnrollmentPhase = "runtime";
    try {
      // cancelAndWaitProject also closes admission for this project. The fence
      // remains closed after this method returns and is reopened only by a
      // later successful atomic enrollment commit.
      await Promise.all([precedingEnable, runtimeCancellation]);

      phase = "authority";
      const existing = unwrap(
        await this.dependencies.authority.loadProjectSyncRegistration(projectId),
      );

      phase = "registration";
      const disabledAt = this.dependencies.clock.now();
      const disabled = unwrap(
        await this.dependencies.authority.disableProjectSync({
          projectId,
          expectedAccountId: existing?.accountId ?? null,
          expectedDeviceId: existing?.deviceId ?? null,
          expectedRevision: existing?.revision ?? null,
          disabledAt,
        }),
      );
      requireDisabledRegistration(disabled, existing, disabledAt);
      return {
        operation: "disable",
        projectId,
        state: existing === null || existing.state === "disabled" ? "already_disabled" : "disabled",
        accountId: existing?.accountId ?? null,
        deviceId: existing?.deviceId ?? null,
        consentRevision: disabled?.consentRevision ?? existing?.consentRevision ?? null,
        registration: disabled,
      };
    } catch (cause: unknown) {
      throw classifyOperationError(cause, phase);
    }
  }

  private currentSession(signal: AbortSignal | undefined): Promise<ConfiguredCloudSessionStatus> {
    return this.dependencies.session.runWithSession(
      (status) => Promise.resolve(status),
      signalOptions(signal),
    );
  }
}

function requireRegistrationIdentity(
  registration: ProjectSyncRegistration | null,
  session: ConfiguredCloudSessionStatus,
): void {
  if (registration === null) {
    return;
  }
  if (registration.accountId !== session.account.accountId) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_ACCOUNT_MISMATCH",
      "authority",
      "This project registration belongs to a different cloud account.",
    );
  }
  if (registration.deviceId !== session.device.device.deviceId) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_DEVICE_MISMATCH",
      "authority",
      "This project registration belongs to a different cloud device.",
    );
  }
}

function validateTransportAudit(blocking: ProjectSyncBlockingState, projectId: string): void {
  if (blocking.projectId !== projectId) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_OPERATION_FAILED",
      "transport_audit",
      "The transport audit returned a different project.",
    );
  }
  const counts = [
    blocking.outgoingPendingCount,
    blocking.outgoingPausedCount,
    blocking.outgoingAttemptExhaustedCount,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_OPERATION_FAILED",
      "transport_audit",
      "The advisory project transport audit is invalid.",
    );
  }
}

function requireConfirmedActiveKey(
  bundle: ProjectKeyBundle | null,
  projectId: string,
  session: ConfiguredCloudSessionStatus,
): number {
  if (bundle === null) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_LOCAL_KEY_REQUIRED",
      "project_key",
      "A local project key is required before cloud sync can be enabled.",
    );
  }
  if (
    bundle.version.projectId !== projectId ||
    bundle.deviceEnvelope.projectId !== projectId ||
    bundle.recoveryEnvelope.projectId !== projectId ||
    bundle.version.keyVersion !== bundle.deviceEnvelope.keyVersion ||
    bundle.version.keyVersion !== bundle.recoveryEnvelope.keyVersion ||
    bundle.deviceEnvelope.recipientDeviceId !== session.device.device.deviceId ||
    bundle.deviceEnvelope.recipientPublicKeyFingerprint !==
      session.device.publicKey.publicKeyFingerprint ||
    bundle.deviceEnvelope.revokedAt !== null
  ) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_KEY_AUTHORITY_MISMATCH",
      "project_key",
      "The local project key does not match the current project and device authority.",
    );
  }
  if (bundle.version.state !== "active" || bundle.version.retiredAt !== null) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_LOCAL_KEY_REQUIRED",
      "project_key",
      "The current local project key must be active before cloud sync can be enabled.",
    );
  }
  if (bundle.recoveryEnvelope.confirmedAt === null || bundle.recoveryEnvelope.revokedAt !== null) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_RECOVERY_CONFIRMATION_REQUIRED",
      "project_key",
      "The active project key recovery code must be confirmed before cloud sync can be enabled.",
    );
  }
  return bundle.version.keyVersion;
}

function buildEnablePlan(
  registration: ProjectSyncRegistration | null,
  keyVersion: number,
): EnablePlan {
  if (registration === null) {
    return { consentRevision: 1, expectedRevision: null, beginRequired: true };
  }
  requireRegistrationShape(registration);
  if (registration.state === "disabled") {
    if (!Number.isSafeInteger(registration.consentRevision + 1)) {
      throw enrollmentError(
        "SYNC_ENROLLMENT_CONSENT_REVISION_EXHAUSTED",
        "authority",
        "The project consent revision cannot be advanced safely.",
      );
    }
    return {
      consentRevision: registration.consentRevision + 1,
      expectedRevision: registration.revision,
      beginRequired: true,
    };
  }
  if (registration.keyVersion !== keyVersion) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_KEY_AUTHORITY_MISMATCH",
      "authority",
      "An active project registration cannot silently change key authority.",
    );
  }
  if (registration.state === "paused" || registration.state === "error") {
    return {
      consentRevision: registration.consentRevision,
      expectedRevision: registration.revision,
      beginRequired: true,
    };
  }
  return {
    consentRevision: registration.consentRevision,
    expectedRevision: registration.revision,
    beginRequired: false,
  };
}

function requireRegistrationShape(registration: ProjectSyncRegistration): void {
  const enabled = registration.state === "enabled";
  const preEnable =
    registration.state === "enabling" ||
    registration.state === "bootstrap_required" ||
    registration.state === "disabled";
  if (
    (enabled && !registration.plaintextBootstrapCompleted) ||
    (preEnable && registration.plaintextBootstrapCompleted) ||
    (enabled && registration.enabledAt === null) ||
    (registration.state === "error" && registration.lastErrorCode === null) ||
    (registration.state !== "error" && registration.lastErrorCode !== null)
  ) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_REGISTRATION_INVALID",
      "authority",
      "The local project sync registration is internally inconsistent.",
    );
  }
}

function requirePublicationEvidence(
  publication: CloudProjectSyncKeyPublicationEvidence,
  frozen: FrozenEnrollmentAuthority,
): void {
  if (
    publication.projectId !== frozen.projectId ||
    publication.accountId !== frozen.accountId ||
    publication.deviceId !== frozen.deviceId ||
    publication.devicePublicKeyFingerprint !== frozen.devicePublicKeyFingerprint ||
    publication.keyVersion !== frozen.keyVersion
  ) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_KEY_PUBLICATION_MISMATCH",
      "key_publication",
      "Cloud key publication did not confirm the exact local project key.",
    );
  }
}

function requireFrozenRegistration(
  registration: ProjectSyncRegistration | null,
  frozen: FrozenEnrollmentAuthority,
): asserts registration is ProjectSyncRegistration {
  if (
    registration?.projectId !== frozen.projectId ||
    registration.accountId !== frozen.accountId ||
    registration.deviceId !== frozen.deviceId ||
    registration.consentRevision !== frozen.consentRevision ||
    registration.keyVersion !== frozen.keyVersion ||
    registration.state === "disabled"
  ) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_REGISTRATION_INVALID",
      "registration",
      "The project sync registration changed outside the explicit enrollment authority.",
    );
  }
  requireRegistrationShape(registration);
}

function requireRuntimeProject(runtime: CloudSyncRuntimeResult, projectId: string): void {
  if (runtime.projectId !== projectId) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_OPERATION_FAILED",
      "runtime",
      "The sync runtime returned a different project.",
    );
  }
}

function requireCompletedRuntime(
  runtime: CloudSyncRuntimeResult,
  registration: ProjectSyncRegistration,
  frozen: FrozenEnrollmentAuthority,
): void {
  const binding = runtime.binding;
  if (
    runtime.phase !== "complete" ||
    !runtime.pushAllowed ||
    runtime.failure !== null ||
    binding?.projectId !== frozen.projectId ||
    binding.accountId !== frozen.accountId ||
    binding.deviceId !== frozen.deviceId ||
    binding.consentRevision !== frozen.consentRevision ||
    binding.keyVersion !== frozen.keyVersion ||
    registration.state !== "enabled" ||
    !registration.plaintextBootstrapCompleted ||
    registration.enabledAt === null ||
    registration.lastErrorCode !== null
  ) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_RUNTIME_COMPLETION_UNVERIFIED",
      "verification",
      "The sync runtime completed without proving exact plaintext-enabled authority.",
    );
  }
}

function runtimeEnableResult(
  frozen: FrozenEnrollmentAuthority,
  registration: ProjectSyncRegistration,
  runtime: CloudSyncRuntimeResult,
): CloudProjectSyncEnableResult {
  const retryable =
    runtime.state === "retryable" || runtime.state === "offline" || runtime.state === "aborted";
  return {
    operation: "enable",
    projectId: frozen.projectId,
    state: runtime.state === "aborted" ? "aborted" : retryable ? "retryable" : "blocked",
    accountId: frozen.accountId,
    deviceId: frozen.deviceId,
    consentRevision: frozen.consentRevision,
    keyVersion: frozen.keyVersion,
    registration,
    runtime,
    failure: {
      phase: "runtime",
      code: runtime.failure?.code ?? `SYNC_RUNTIME_${runtime.state.toUpperCase()}`,
      retryable,
    },
  };
}

function requireDisabledRegistration(
  disabled: ProjectSyncRegistration | null,
  existing: ProjectSyncRegistration | null,
  disabledAt: string,
): void {
  if (existing === null) {
    if (disabled !== null) {
      throw enrollmentError(
        "SYNC_ENROLLMENT_REGISTRATION_INVALID",
        "registration",
        "A project sync registration appeared during local disable.",
      );
    }
    return;
  }
  if (disabled === null) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_REGISTRATION_INVALID",
      "registration",
      "The persisted project sync registration disappeared during local disable.",
    );
  }
  const expectedRevision =
    existing.state === "disabled" ? existing.revision : existing.revision + 1;
  if (
    disabled.projectId !== existing.projectId ||
    disabled.state !== "disabled" ||
    disabled.plaintextBootstrapCompleted ||
    disabled.accountId !== existing.accountId ||
    disabled.deviceId !== existing.deviceId ||
    disabled.consentRevision !== existing.consentRevision ||
    disabled.keyVersion !== existing.keyVersion ||
    disabled.revision !== expectedRevision ||
    disabled.lastErrorCode !== null ||
    disabled.enabledAt !== null ||
    disabled.pausedAt !== null ||
    (existing.state === "disabled"
      ? disabled.updatedAt !== existing.updatedAt
      : disabled.updatedAt !== disabledAt)
  ) {
    throw enrollmentError(
      "SYNC_ENROLLMENT_REGISTRATION_INVALID",
      "registration",
      "The local project sync registration was not disabled under the exact authority.",
    );
  }
}

function emptyEnableResult(
  projectId: string,
  state: "aborted" | "configuration_disabled",
): CloudProjectSyncEnableResult {
  return {
    operation: "enable",
    projectId,
    state,
    accountId: null,
    deviceId: null,
    consentRevision: null,
    keyVersion: null,
    registration: null,
    runtime: null,
    failure: null,
  };
}

function emptyDisableResult(
  projectId: string,
  state: "aborted" | "configuration_disabled",
): CloudProjectSyncDisableResult {
  return {
    operation: "disable",
    projectId,
    state,
    accountId: null,
    deviceId: null,
    consentRevision: null,
    registration: null,
  };
}

function busyError(requested: EnrollmentOperation): CloudProjectSyncEnrollmentError {
  return new CloudProjectSyncEnrollmentError({
    code: "SYNC_ENROLLMENT_BUSY",
    phase: "authority",
    message: `Project sync cannot ${requested} while the opposite enrollment operation is active.`,
    retryable: true,
  });
}

function enrollmentError(
  code: CloudProjectSyncEnrollmentErrorCode,
  phase: CloudProjectSyncEnrollmentPhase,
  message: string,
): CloudProjectSyncEnrollmentError {
  return new CloudProjectSyncEnrollmentError({ code, phase, message });
}

function classifyOperationError(
  cause: unknown,
  phase: CloudProjectSyncEnrollmentPhase,
): CloudProjectSyncEnrollmentError {
  if (cause instanceof CloudProjectSyncEnrollmentError) {
    return cause;
  }
  if (cause instanceof CloudSessionCoordinatorError) {
    return new CloudProjectSyncEnrollmentError({
      code: cause.sourceCode,
      phase,
      message: cause.message,
      retryable: false,
      details: {
        reason: cause.reason,
        sourceCode: cause.sourceCode,
      },
    });
  }
  if (
    cause instanceof AppError &&
    cause.details.operation === "SYNC_ENROLLMENT_UNACKNOWLEDGED_OUTBOX"
  ) {
    return new CloudProjectSyncEnrollmentError({
      code: "SYNC_ENROLLMENT_UNACKNOWLEDGED_OUTBOX",
      phase,
      message: cause.message,
      retryable: false,
      details: cause.details,
    });
  }
  if (cause instanceof AppError) {
    return new CloudProjectSyncEnrollmentError({
      code: cause.code,
      phase,
      message: cause.message,
      retryable: cause.retryable,
      details: cause.details,
    });
  }
  if (hasErrorMetadata(cause)) {
    return new CloudProjectSyncEnrollmentError({
      code: cause.code,
      phase,
      message: cause instanceof Error ? cause.message : "The enrollment operation failed.",
      retryable: cause.retryable === true,
    });
  }
  return new CloudProjectSyncEnrollmentError({
    code: "SYNC_ENROLLMENT_OPERATION_FAILED",
    phase,
    message: cause instanceof Error ? cause.message : "The enrollment operation failed.",
    retryable: true,
  });
}

function hasErrorMetadata(
  value: unknown,
): value is Readonly<{ code: string; retryable?: boolean }> {
  return (
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
  );
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function signalOptions(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? {} : { signal };
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
  if (signal?.aborted === true) {
    throw new DOMException("The project sync enrollment was aborted.", "AbortError");
  }
}

function isAbort(cause: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}
