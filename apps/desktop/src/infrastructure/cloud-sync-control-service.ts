import type { ProjectSyncRegistration, SyncMaterializationSqliteStore } from "@inkshadow/data";
import type { AppError, Clock, Result } from "@inkshadow/domain";

import type {
  CloudProjectSyncEnableResult,
  CloudProjectSyncEnrollmentService,
} from "./cloud-project-sync-enrollment-service.js";
import type {
  CloudSyncRuntimeResult,
  CloudSyncRuntimeService,
} from "./cloud-sync-runtime-service.js";

export type CloudSyncControlAuthority = Pick<
  SyncMaterializationSqliteStore,
  "loadProjectSyncRegistration" | "transitionProjectSyncRegistration"
>;

export type CloudSyncControlRuntime = Pick<
  CloudSyncRuntimeService,
  "cancelAndWaitProject" | "resumeProject" | "runProject"
>;

export type CloudSyncControlEnrollment = Pick<CloudProjectSyncEnrollmentService, "enableProject">;

export type CloudSyncControlState =
  | "attention_required"
  | "cancelled"
  | "conflict"
  | "device_revoked"
  | "disabled"
  | "key_error"
  | "offline"
  | "paused"
  | "pending"
  | "quota_exceeded"
  | "reauth_required"
  | "retry_wait"
  | "synced"
  | "syncing"
  | "version_incompatible";

export interface CloudSyncControlSnapshot {
  readonly projectId: string;
  readonly state: CloudSyncControlState;
  readonly registrationRevision: number | null;
  readonly lastErrorCode: string | null;
  readonly retryable: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canRetry: boolean;
  /**
   * Cloud state never changes local read/edit/backup/export admission.
   */
  readonly localWorkAvailable: true;
}

export interface CloudSyncControlServiceDependencies {
  readonly enabled?: boolean;
  readonly authority: CloudSyncControlAuthority;
  readonly runtime: CloudSyncControlRuntime;
  readonly enrollment: CloudSyncControlEnrollment;
  readonly clock: Pick<Clock, "now">;
  readonly onStateChange?: (snapshot: CloudSyncControlSnapshot) => void | Promise<void>;
}

/**
 * User-owned lifecycle boundary around the already durable sync runtime.
 *
 * The registration row remains the only persistent admission authority:
 * `paused` closes every push/key gate and `enableProject` performs the full
 * consent/key/bootstrap revalidation before resuming. Transient observations
 * are intentionally metadata-only and never contain tokens, keys, payloads,
 * chapter text, or ciphertext.
 */
export class CloudSyncControlService {
  private readonly enabled: boolean;
  private readonly active = new Map<string, Promise<CloudSyncControlSnapshot>>();
  private readonly observations = new Map<string, CloudSyncControlSnapshot>();

  public constructor(private readonly dependencies: CloudSyncControlServiceDependencies) {
    this.enabled = dependencies.enabled === true;
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public async inspectProject(projectId: string): Promise<CloudSyncControlSnapshot> {
    if (!this.enabled) {
      return snapshot(projectId, "disabled", null, null, false);
    }
    const registration = unwrap(
      await this.dependencies.authority.loadProjectSyncRegistration(projectId),
    );
    const observed = this.observations.get(projectId);
    if (
      observed !== undefined &&
      registration !== null &&
      observed.registrationRevision === registration.revision &&
      registration.state !== "paused" &&
      registration.state !== "disabled" &&
      registration.state !== "error"
    ) {
      return observed;
    }
    return registrationSnapshot(projectId, registration);
  }

  public runProject(projectId: string, signal?: AbortSignal): Promise<CloudSyncControlSnapshot> {
    return this.singleFlight(projectId, async () => {
      if (!this.enabled) {
        return this.publish(snapshot(projectId, "disabled", null, null, false));
      }
      if (signal?.aborted === true) {
        return this.publish(await this.cancelProjectInternal(projectId));
      }
      const registration = unwrap(
        await this.dependencies.authority.loadProjectSyncRegistration(projectId),
      );
      if (!isRunnableRegistration(registration)) {
        return this.publish(registrationSnapshot(projectId, registration));
      }
      this.dependencies.runtime.resumeProject(projectId);
      await this.publish(snapshot(projectId, "syncing", registration.revision, null, false));
      const result = await this.dependencies.runtime.runProject(
        projectId,
        signal === undefined ? {} : { signal },
      );
      return this.publish(runtimeSnapshot(result, registration.revision));
    });
  }

  public pauseProject(projectId: string): Promise<CloudSyncControlSnapshot> {
    return this.singleFlight(projectId, async () => {
      if (!this.enabled) {
        return this.publish(snapshot(projectId, "disabled", null, null, false));
      }

      // Establish the in-process privacy fence first. The command is not
      // acknowledged until the same boundary is durably represented by the
      // registration row.
      await this.dependencies.runtime.cancelAndWaitProject(projectId);
      const registration = unwrap(
        await this.dependencies.authority.loadProjectSyncRegistration(projectId),
      );
      if (
        registration === null ||
        registration.state === "disabled" ||
        registration.state === "paused"
      ) {
        return this.publish(registrationSnapshot(projectId, registration));
      }
      const paused = unwrap(
        await this.dependencies.authority.transitionProjectSyncRegistration({
          projectId,
          expectedAccountId: registration.accountId,
          expectedDeviceId: registration.deviceId,
          expectedConsentRevision: registration.consentRevision,
          expectedKeyVersion: registration.keyVersion,
          expectedRevision: registration.revision,
          target: { state: "paused" },
          transitionedAt: monotonicNow(this.dependencies.clock.now(), registration.updatedAt),
        }),
      );
      return this.publish(registrationSnapshot(projectId, paused));
    });
  }

  public resumeProject(projectId: string, signal?: AbortSignal): Promise<CloudSyncControlSnapshot> {
    return this.singleFlight(projectId, async () => {
      if (!this.enabled) {
        return this.publish(snapshot(projectId, "disabled", null, null, false));
      }
      const registration = unwrap(
        await this.dependencies.authority.loadProjectSyncRegistration(projectId),
      );
      if (registration === null || registration.state === "disabled") {
        return this.publish(registrationSnapshot(projectId, registration));
      }
      if (registration.state !== "paused" && registration.state !== "error") {
        this.dependencies.runtime.resumeProject(projectId);
        const result = await this.dependencies.runtime.runProject(
          projectId,
          signal === undefined ? {} : { signal },
        );
        return this.publish(runtimeSnapshot(result, registration.revision));
      }
      const enabled = await this.dependencies.enrollment.enableProject(
        projectId,
        signal === undefined ? {} : { signal },
      );
      return this.publish(enrollmentSnapshot(enabled));
    });
  }

  public retryProject(projectId: string, signal?: AbortSignal): Promise<CloudSyncControlSnapshot> {
    return this.singleFlight(projectId, async () => {
      if (!this.enabled) {
        return this.publish(snapshot(projectId, "disabled", null, null, false));
      }
      const observed = this.observations.get(projectId);
      if (observed?.state === "conflict") {
        return this.publish(observed);
      }
      const registration = unwrap(
        await this.dependencies.authority.loadProjectSyncRegistration(projectId),
      );
      if (registration?.state === "paused" || registration?.state === "error") {
        const enabled = await this.dependencies.enrollment.enableProject(
          projectId,
          signal === undefined ? {} : { signal },
        );
        return this.publish(enrollmentSnapshot(enabled));
      }
      if (!isRunnableRegistration(registration)) {
        return this.publish(registrationSnapshot(projectId, registration));
      }
      this.dependencies.runtime.resumeProject(projectId);
      const result = await this.dependencies.runtime.runProject(
        projectId,
        signal === undefined ? {} : { signal },
      );
      return this.publish(runtimeSnapshot(result, registration.revision));
    });
  }

  /**
   * Transient cancellation is used by app shutdown and route ownership. A
   * durable user pause must call `pauseProject`.
   */
  public cancelProject(projectId: string): Promise<CloudSyncControlSnapshot> {
    return this.singleFlight(projectId, () => this.cancelProjectInternal(projectId));
  }

  private async cancelProjectInternal(projectId: string): Promise<CloudSyncControlSnapshot> {
    await this.dependencies.runtime.cancelAndWaitProject(projectId);
    const registration = this.enabled
      ? unwrap(await this.dependencies.authority.loadProjectSyncRegistration(projectId))
      : null;
    return this.publish(
      snapshot(
        projectId,
        this.enabled ? "cancelled" : "disabled",
        registration?.revision ?? null,
        null,
        false,
      ),
    );
  }

  private singleFlight(
    projectId: string,
    operation: () => Promise<CloudSyncControlSnapshot>,
  ): Promise<CloudSyncControlSnapshot> {
    const current = this.active.get(projectId);
    if (current !== undefined) {
      return current;
    }
    const running = operation().finally(() => {
      if (this.active.get(projectId) === running) {
        this.active.delete(projectId);
      }
    });
    this.active.set(projectId, running);
    return running;
  }

  private async publish(next: CloudSyncControlSnapshot): Promise<CloudSyncControlSnapshot> {
    this.observations.set(next.projectId, next);
    try {
      await this.dependencies.onStateChange?.(next);
    } catch {
      // Observability must not affect synchronization or expose user content.
    }
    return next;
  }
}

function enrollmentSnapshot(result: CloudProjectSyncEnableResult): CloudSyncControlSnapshot {
  const revision = result.registration?.revision ?? null;
  switch (result.state) {
    case "enabled":
      return result.runtime === null
        ? snapshot(result.projectId, "pending", revision, null, false)
        : runtimeSnapshot(result.runtime, revision);
    case "retryable":
      return snapshot(
        result.projectId,
        result.runtime?.state === "offline" ? "offline" : "retry_wait",
        revision,
        result.failure?.code ?? result.runtime?.failure?.code ?? "SYNC_RETRY_REQUIRED",
        true,
      );
    case "aborted":
      return snapshot(result.projectId, "cancelled", revision, null, false);
    case "blocked":
      return classifyFailureSnapshot(
        result.projectId,
        revision,
        result.failure?.code ?? result.runtime?.failure?.code ?? "SYNC_RESUME_BLOCKED",
        false,
      );
    case "configuration_disabled":
      return snapshot(result.projectId, "disabled", revision, null, false);
  }
}

function runtimeSnapshot(
  result: CloudSyncRuntimeResult,
  registrationRevision: number | null,
): CloudSyncControlSnapshot {
  const code = result.failure?.code ?? null;
  switch (result.state) {
    case "completed":
      return snapshot(result.projectId, "synced", registrationRevision, null, false);
    case "aborted":
      return snapshot(result.projectId, "cancelled", registrationRevision, null, false);
    case "offline":
      return snapshot(result.projectId, "offline", registrationRevision, code, true);
    case "retryable":
      return snapshot(result.projectId, "retry_wait", registrationRevision, code, true);
    case "conflict_blocked":
      return snapshot(result.projectId, "conflict", registrationRevision, code, false);
    case "disabled":
      return snapshot(result.projectId, "disabled", registrationRevision, code, false);
    default:
      return classifyFailureSnapshot(
        result.projectId,
        registrationRevision,
        code ?? "SYNC_ATTENTION_REQUIRED",
        false,
      );
  }
}

function classifyFailureSnapshot(
  projectId: string,
  registrationRevision: number | null,
  code: string,
  retryable: boolean,
): CloudSyncControlSnapshot {
  if (/DEVICE.*REVOK|REVOK.*DEVICE/u.test(code)) {
    return snapshot(projectId, "device_revoked", registrationRevision, code, false);
  }
  if (/VERSION|PROTOCOL.*INCOMPAT/u.test(code)) {
    return snapshot(projectId, "version_incompatible", registrationRevision, code, false);
  }
  if (code.includes("QUOTA")) {
    return snapshot(projectId, "quota_exceeded", registrationRevision, code, false);
  }
  if (/KEY|ENVELOPE|RECOVERY/u.test(code)) {
    return snapshot(projectId, "key_error", registrationRevision, code, false);
  }
  if (/AUTH|SESSION|LOGIN/u.test(code)) {
    return snapshot(projectId, "reauth_required", registrationRevision, code, false);
  }
  return snapshot(projectId, "attention_required", registrationRevision, code, retryable);
}

function registrationSnapshot(
  projectId: string,
  registration: ProjectSyncRegistration | null,
): CloudSyncControlSnapshot {
  if (registration === null || registration.state === "disabled") {
    return snapshot(projectId, "disabled", registration?.revision ?? null, null, false);
  }
  if (registration.state === "paused") {
    return snapshot(projectId, "paused", registration.revision, null, false);
  }
  if (registration.state === "error") {
    return classifyFailureSnapshot(
      projectId,
      registration.revision,
      registration.lastErrorCode ?? "SYNC_REGISTRATION_ERROR",
      false,
    );
  }
  return snapshot(projectId, "pending", registration.revision, null, false);
}

function snapshot(
  projectId: string,
  state: CloudSyncControlState,
  registrationRevision: number | null,
  lastErrorCode: string | null,
  retryable: boolean,
): CloudSyncControlSnapshot {
  const active =
    state !== "disabled" && state !== "paused" && state !== "cancelled" && state !== "conflict";
  return Object.freeze({
    projectId,
    state,
    registrationRevision,
    lastErrorCode: normalizeFailureCode(lastErrorCode),
    retryable,
    canPause: active,
    canResume: state === "paused" || state === "cancelled",
    canRetry: retryable || state === "attention_required",
    localWorkAvailable: true,
  });
}

function isRunnableRegistration(
  registration: ProjectSyncRegistration | null,
): registration is ProjectSyncRegistration {
  return (
    registration !== null &&
    (registration.state === "enabled" ||
      registration.state === "enabling" ||
      registration.state === "bootstrap_required")
  );
}

function monotonicNow(candidate: string, lowerBound: string): string {
  if (Number.isNaN(Date.parse(candidate)) || !candidate.endsWith("Z")) {
    throw new Error("The sync control clock returned an invalid UTC timestamp.");
  }
  return Date.parse(candidate) >= Date.parse(lowerBound) ? candidate : lowerBound;
}

function normalizeFailureCode(code: string | null): string | null {
  return code !== null && /^[A-Z][A-Z0-9_.:-]{2,119}$/u.test(code)
    ? code
    : code === null
      ? null
      : "SYNC_CONTROL_FAILURE";
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
