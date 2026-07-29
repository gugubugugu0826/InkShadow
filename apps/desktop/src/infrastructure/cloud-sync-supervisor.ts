import type { ProjectSyncRegistration } from "@inkshadow/data";
import { AppError, type Result } from "@inkshadow/domain";

import type {
  CloudSyncRuntimeResult,
  CloudSyncRuntimeService,
} from "./cloud-sync-runtime-service.js";

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_RETRY_INTERVAL_MS = 5_000;
const DEFAULT_MAXIMUM_RETRY_INTERVAL_MS = 15 * 60_000;
const DEFAULT_MAXIMUM_PROJECTS_PER_CYCLE = 64;
const MINIMUM_INTERVAL_MS = 250;
const MAXIMUM_INTERVAL_MS = 10 * 60_000;
const MAXIMUM_BACKOFF_INTERVAL_MS = 60 * 60_000;

export interface CloudSyncSupervisorRegistrationSource {
  listRunnableProjectSyncRegistrations(): Promise<
    Result<readonly ProjectSyncRegistration[], AppError>
  >;
}

export type CloudSyncSupervisorRuntime = Pick<CloudSyncRuntimeService, "runProject">;

export interface CloudSyncSupervisorWaiter {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface CloudSyncSupervisorDependencies {
  readonly enabled?: boolean;
  readonly registrations: CloudSyncSupervisorRegistrationSource;
  readonly runtime: CloudSyncSupervisorRuntime;
  readonly waiter?: CloudSyncSupervisorWaiter;
  readonly intervalMs?: number;
  readonly retryIntervalMs?: number;
  readonly maximumRetryIntervalMs?: number;
  readonly maximumProjectsPerCycle?: number;
  readonly onCycle?: (result: CloudSyncSupervisorCycleResult) => void | Promise<void>;
}

export type CloudSyncSupervisorCycleState =
  "aborted" | "attention_required" | "completed" | "disabled" | "idle" | "retryable";

export interface CloudSyncSupervisorCycleFailure {
  readonly code: string;
  readonly retryable: boolean;
}

export interface CloudSyncSupervisorCycleResult {
  readonly state: CloudSyncSupervisorCycleState;
  readonly registrationCount: number;
  readonly attemptedProjectCount: number;
  readonly projectLimitReached: boolean;
  readonly projectResults: readonly CloudSyncRuntimeResult[];
  readonly failure: CloudSyncSupervisorCycleFailure | null;
}

/**
 * Discovers only durable, explicitly enrolled projects and keeps their complete
 * bootstrap/materialization/projection/sync runtime moving. It never creates or
 * changes project consent.
 */
export class CloudSyncSupervisor {
  private readonly enabled: boolean;
  private readonly waiter: CloudSyncSupervisorWaiter;
  private readonly intervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly maximumRetryIntervalMs: number;
  private readonly maximumProjectsPerCycle: number;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private activeCycle: Promise<CloudSyncSupervisorCycleResult> | null = null;
  private lastAttemptedProjectId: string | null = null;

  public constructor(private readonly dependencies: CloudSyncSupervisorDependencies) {
    this.enabled = dependencies.enabled === true;
    this.waiter = dependencies.waiter ?? { wait: abortableDelay };
    this.intervalMs = boundedInterval(dependencies.intervalMs ?? DEFAULT_INTERVAL_MS, "intervalMs");
    this.retryIntervalMs = boundedInterval(
      dependencies.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS,
      "retryIntervalMs",
    );
    this.maximumRetryIntervalMs = boundedBackoffInterval(
      dependencies.maximumRetryIntervalMs ?? DEFAULT_MAXIMUM_RETRY_INTERVAL_MS,
      "maximumRetryIntervalMs",
    );
    if (this.maximumRetryIntervalMs < this.retryIntervalMs) {
      throw new RangeError("maximumRetryIntervalMs cannot be shorter than retryIntervalMs.");
    }
    this.maximumProjectsPerCycle = boundedProjectLimit(
      dependencies.maximumProjectsPerCycle ?? DEFAULT_MAXIMUM_PROJECTS_PER_CYCLE,
    );
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public get isRunning(): boolean {
    return this.loop !== null;
  }

  public start(): void {
    if (!this.enabled || this.loop !== null) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const loop = this.runLoop(controller.signal).finally(() => {
      if (this.loop === loop) {
        this.loop = null;
        this.controller = null;
      }
    });
    this.loop = loop;
  }

  public async stop(): Promise<void> {
    const loop = this.loop;
    if (loop === null) {
      return;
    }
    this.controller?.abort();
    await loop;
  }

  public runOnce(signal?: AbortSignal): Promise<CloudSyncSupervisorCycleResult> {
    if (!this.enabled) {
      return Promise.resolve(emptyCycle("disabled"));
    }
    if (isSignalAborted(signal)) {
      return Promise.resolve(emptyCycle("aborted"));
    }
    if (this.activeCycle !== null) {
      return this.activeCycle;
    }
    const cycle = this.executeCycle(signal).finally(() => {
      if (this.activeCycle === cycle) {
        this.activeCycle = null;
      }
    });
    this.activeCycle = cycle;
    return cycle;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let consecutiveRetryableCycles = 0;
    while (!signal.aborted) {
      const result = await this.runOnce(signal);
      await this.notifyCycle(result);
      if (result.state === "aborted") {
        return;
      }
      consecutiveRetryableCycles =
        result.state === "retryable" ? consecutiveRetryableCycles + 1 : 0;
      const delay =
        result.state === "retryable"
          ? retryBackoff(
              this.retryIntervalMs,
              this.maximumRetryIntervalMs,
              consecutiveRetryableCycles,
            )
          : this.intervalMs;
      try {
        await this.waiter.wait(delay, signal);
      } catch (cause: unknown) {
        if (isAbort(cause, signal)) {
          return;
        }
        throw cause;
      }
    }
  }

  private async executeCycle(
    signal: AbortSignal | undefined,
  ): Promise<CloudSyncSupervisorCycleResult> {
    let registrations: readonly ProjectSyncRegistration[];
    try {
      registrations = unwrap(
        await this.dependencies.registrations.listRunnableProjectSyncRegistrations(),
      );
      validateRegistrations(registrations);
    } catch (cause: unknown) {
      const failure = classifyFailure(cause);
      return {
        state: failure.retryable ? "retryable" : "attention_required",
        registrationCount: 0,
        attemptedProjectCount: 0,
        projectLimitReached: false,
        projectResults: [],
        failure,
      };
    }
    if (signal?.aborted === true) {
      return {
        ...emptyCycle("aborted"),
        registrationCount: registrations.length,
      };
    }
    if (registrations.length === 0) {
      return emptyCycle("idle");
    }

    const selected = selectProjectWindow(
      registrations,
      this.maximumProjectsPerCycle,
      this.lastAttemptedProjectId,
    );
    const projectLimitReached = selected.length < registrations.length;
    const projectResults: CloudSyncRuntimeResult[] = [];
    for (const registration of selected) {
      if (isSignalAborted(signal)) {
        return {
          state: "aborted",
          registrationCount: registrations.length,
          attemptedProjectCount: projectResults.length,
          projectLimitReached,
          projectResults,
          failure: null,
        };
      }
      try {
        const result = await this.dependencies.runtime.runProject(
          registration.projectId,
          signal === undefined ? {} : { signal },
        );
        if (result.projectId !== registration.projectId) {
          throw new Error("The cloud sync runtime returned a different project.");
        }
        projectResults.push(result);
        this.lastAttemptedProjectId = registration.projectId;
      } catch (cause: unknown) {
        this.lastAttemptedProjectId = registration.projectId;
        return {
          state: "retryable",
          registrationCount: registrations.length,
          attemptedProjectCount: projectResults.length + 1,
          projectLimitReached,
          projectResults,
          failure: classifyFailure(cause),
        };
      }
    }

    return {
      state: classifyProjectResults(projectResults),
      registrationCount: registrations.length,
      attemptedProjectCount: projectResults.length,
      projectLimitReached,
      projectResults,
      failure: null,
    };
  }

  private async notifyCycle(result: CloudSyncSupervisorCycleResult): Promise<void> {
    try {
      await this.dependencies.onCycle?.(result);
    } catch {
      // Observability must never stop synchronization or expose application data.
    }
  }
}

function validateRegistrations(registrations: readonly ProjectSyncRegistration[]): void {
  const projectIds = new Set<string>();
  for (const registration of registrations) {
    if (
      (registration.state !== "enabled" &&
        registration.state !== "enabling" &&
        registration.state !== "bootstrap_required") ||
      projectIds.has(registration.projectId)
    ) {
      throw new Error("The runnable project registration list is inconsistent.");
    }
    projectIds.add(registration.projectId);
  }
}

function classifyProjectResults(
  results: readonly CloudSyncRuntimeResult[],
): CloudSyncSupervisorCycleState {
  if (results.some((result) => result.state === "aborted")) {
    return "aborted";
  }
  if (results.some((result) => result.state === "offline" || result.state === "retryable")) {
    return "retryable";
  }
  if (results.some((result) => result.state !== "completed")) {
    return "attention_required";
  }
  return "completed";
}

function emptyCycle(
  state: "aborted" | "disabled" | "idle" | "retryable",
): CloudSyncSupervisorCycleResult {
  return {
    state,
    registrationCount: 0,
    attemptedProjectCount: 0,
    projectLimitReached: false,
    projectResults: [],
    failure: null,
  };
}

function classifyFailure(cause: unknown): CloudSyncSupervisorCycleFailure {
  if (cause instanceof AppError) {
    return { code: cause.code, retryable: cause.retryable };
  }
  return { code: "SYNC_SUPERVISOR_CYCLE_FAILED", retryable: true };
}

function unwrap<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function boundedInterval(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < MINIMUM_INTERVAL_MS || value > MAXIMUM_INTERVAL_MS) {
    throw new RangeError(`${field} is outside the supported range.`);
  }
  return value;
}

function boundedBackoffInterval(value: number, field: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_INTERVAL_MS ||
    value > MAXIMUM_BACKOFF_INTERVAL_MS
  ) {
    throw new RangeError(`${field} is outside the supported range.`);
  }
  return value;
}

function boundedProjectLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_024) {
    throw new RangeError("maximumProjectsPerCycle is outside the supported range.");
  }
  return value;
}

function retryBackoff(base: number, maximum: number, attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(maximum, base * 2 ** exponent);
}

function selectProjectWindow(
  registrations: readonly ProjectSyncRegistration[],
  limit: number,
  afterProjectId: string | null,
): readonly ProjectSyncRegistration[] {
  const ordered = [...registrations].sort((left, right) =>
    left.projectId.localeCompare(right.projectId),
  );
  if (ordered.length <= limit) {
    return ordered;
  }
  const firstAfter =
    afterProjectId === null ? 0 : ordered.findIndex(({ projectId }) => projectId > afterProjectId);
  const start = firstAfter < 0 ? 0 : firstAfter;
  return [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, limit);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });

    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function isAbort(cause: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
