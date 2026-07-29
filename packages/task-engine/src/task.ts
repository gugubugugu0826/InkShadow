import {
  TaskEngineError,
  createTaskFailure,
  retryExhaustedFailure,
  type TaskFailure,
} from "./errors.js";
import { err, ok, type Result } from "./result.js";
import {
  cloneSafeMetadata,
  createSafeMetadata,
  safeMetadataEquals,
  type SafeMetadata,
} from "./safety.js";
import {
  compareTimestamps,
  parseIdempotencyKey,
  parseIsoUtcTimestamp,
  parseTaskType,
  parseUuidV7,
  parseWorkerId,
  type IdempotencyKey,
  type IsoUtcTimestamp,
  type TaskType,
  type UuidV7,
  type WorkerId,
} from "./value-objects.js";

export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting_retry",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskLease {
  readonly ownerId: WorkerId;
  readonly token: UuidV7;
  readonly expiresAt: IsoUtcTimestamp;
}

export interface TaskProgress {
  readonly step: string;
  readonly completedUnits: number;
  readonly totalUnits: number | null;
  readonly updatedAt: IsoUtcTimestamp;
}

export interface TaskSnapshot {
  readonly id: UuidV7;
  readonly type: TaskType;
  readonly idempotencyKey: IdempotencyKey;
  readonly metadata: SafeMetadata;
  readonly priority: number;
  readonly status: TaskStatus;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly sequence: number;
  readonly runAfter: IsoUtcTimestamp | null;
  readonly lease: TaskLease | null;
  readonly progress: TaskProgress | null;
  readonly failure: TaskFailure | null;
  readonly cancelRequestedAt: IsoUtcTimestamp | null;
  readonly createdAt: IsoUtcTimestamp;
  readonly updatedAt: IsoUtcTimestamp;
  readonly startedAt: IsoUtcTimestamp | null;
  readonly finishedAt: IsoUtcTimestamp | null;
}

export interface CreateTaskInput {
  readonly id: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly metadata: unknown;
  readonly priority: number;
  readonly maxAttempts: number;
  readonly now: string;
  readonly runAfter?: string;
}

export interface ClaimTaskInput {
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface ReportTaskProgressInput {
  readonly leaseToken: string;
  readonly step: string;
  readonly completedUnits: number;
  readonly totalUnits: number | null;
  readonly now: string;
}

export interface RecordTaskFailureInput {
  readonly leaseToken: string;
  readonly failure: TaskFailure;
  readonly now: string;
  readonly retryAt: string | null;
}

const PROGRESS_STEP_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;

export class Task {
  private constructor(private readonly snapshot: TaskSnapshot) {
    Object.freeze(this.snapshot);
    Object.freeze(this);
  }

  public static create(input: CreateTaskInput): Result<Task, TaskEngineError> {
    const id = parseUuidV7(input.id);
    if (!id.ok) {
      return id;
    }
    const type = parseTaskType(input.type);
    if (!type.ok) {
      return type;
    }
    const idempotencyKey = parseIdempotencyKey(input.idempotencyKey);
    if (!idempotencyKey.ok) {
      return idempotencyKey;
    }
    const metadata = createSafeMetadata(input.metadata);
    if (!metadata.ok) {
      return metadata;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const runAfter = input.runAfter === undefined ? now : parseIsoUtcTimestamp(input.runAfter);
    if (!runAfter.ok) {
      return runAfter;
    }
    if (
      !Number.isSafeInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 100 ||
      !Number.isSafeInteger(input.maxAttempts) ||
      input.maxAttempts < 1 ||
      input.maxAttempts > 100
    ) {
      return validationError("Task priority or maximum attempt count is invalid.");
    }

    return ok(
      new Task({
        id: id.value,
        type: type.value,
        idempotencyKey: idempotencyKey.value,
        metadata: metadata.value,
        priority: input.priority,
        status: "queued",
        attempt: 1,
        maxAttempts: input.maxAttempts,
        sequence: 1,
        runAfter: runAfter.value,
        lease: null,
        progress: null,
        failure: null,
        cancelRequestedAt: null,
        createdAt: now.value,
        updatedAt: now.value,
        startedAt: null,
        finishedAt: null,
      }),
    );
  }

  public static rehydrate(snapshot: TaskSnapshot): Result<Task, TaskEngineError> {
    const validated = validateTaskSnapshot(snapshot);
    return validated.ok ? ok(new Task(validated.value)) : validated;
  }

  public get id(): UuidV7 {
    return this.snapshot.id;
  }

  public get type(): TaskType {
    return this.snapshot.type;
  }

  public get idempotencyKey(): IdempotencyKey {
    return this.snapshot.idempotencyKey;
  }

  public get status(): TaskStatus {
    return this.snapshot.status;
  }

  public get attempt(): number {
    return this.snapshot.attempt;
  }

  public get maxAttempts(): number {
    return this.snapshot.maxAttempts;
  }

  public get sequence(): number {
    return this.snapshot.sequence;
  }

  public get priority(): number {
    return this.snapshot.priority;
  }

  public get runAfter(): IsoUtcTimestamp | null {
    return this.snapshot.runAfter;
  }

  public get lease(): TaskLease | null {
    return this.snapshot.lease === null ? null : Object.freeze({ ...this.snapshot.lease });
  }

  public get cancellationRequested(): boolean {
    return this.snapshot.cancelRequestedAt !== null;
  }

  public get failure(): TaskFailure | null {
    return cloneTaskFailure(this.snapshot.failure);
  }

  public toSnapshot(): TaskSnapshot {
    return cloneTaskSnapshot(this.snapshot);
  }

  public isSameRequestAs(other: Task): boolean {
    return (
      this.snapshot.type === other.snapshot.type &&
      this.snapshot.priority === other.snapshot.priority &&
      this.snapshot.maxAttempts === other.snapshot.maxAttempts &&
      safeMetadataEquals(this.snapshot.metadata, other.snapshot.metadata)
    );
  }

  public isTerminal(): boolean {
    return (
      this.snapshot.status === "succeeded" ||
      this.snapshot.status === "failed" ||
      this.snapshot.status === "cancelled"
    );
  }

  public claim(input: ClaimTaskInput): Result<Task, TaskEngineError> {
    if (this.snapshot.status !== "queued" && this.snapshot.status !== "waiting_retry") {
      return transitionError("Only runnable tasks can be claimed.");
    }

    const ownerId = parseWorkerId(input.ownerId);
    if (!ownerId.ok) {
      return ownerId;
    }
    const leaseToken = parseUuidV7(input.leaseToken);
    if (!leaseToken.ok) {
      return leaseToken;
    }
    const now = parseIsoUtcTimestamp(input.now);
    if (!now.ok) {
      return now;
    }
    const expiresAt = parseIsoUtcTimestamp(input.leaseExpiresAt);
    if (!expiresAt.ok) {
      return expiresAt;
    }
    if (
      this.snapshot.runAfter === null ||
      compareTimestamps(this.snapshot.runAfter, now.value) > 0 ||
      compareTimestamps(expiresAt.value, now.value) <= 0
    ) {
      return err(
        new TaskEngineError({
          code: "TASK_NOT_RUNNABLE",
          message: "Task is not ready for a valid lease.",
          retryable: true,
          actions: ["RETRY"],
        }),
      );
    }

    return this.evolve({
      status: "running",
      runAfter: null,
      lease: Object.freeze({
        ownerId: ownerId.value,
        token: leaseToken.value,
        expiresAt: expiresAt.value,
      }),
      failure: null,
      updatedAt: now.value,
      startedAt: this.snapshot.startedAt ?? now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public renewLease(
    leaseToken: string,
    nowValue: string,
    leaseExpiresAt: string,
  ): Result<Task, TaskEngineError> {
    const active = this.validateActiveLease(leaseToken, nowValue);
    if (!active.ok) {
      return active;
    }
    const expiresAt = parseIsoUtcTimestamp(leaseExpiresAt);
    if (!expiresAt.ok) {
      return expiresAt;
    }
    if (
      compareTimestamps(expiresAt.value, active.value.now) <= 0 ||
      compareTimestamps(expiresAt.value, active.value.lease.expiresAt) <= 0
    ) {
      return validationError("A heartbeat must extend the active lease.");
    }

    return this.evolve({
      lease: Object.freeze({
        ...active.value.lease,
        expiresAt: expiresAt.value,
      }),
      updatedAt: active.value.now,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public reportProgress(input: ReportTaskProgressInput): Result<Task, TaskEngineError> {
    const active = this.validateActiveLease(input.leaseToken, input.now);
    if (!active.ok) {
      return active;
    }
    if (
      !PROGRESS_STEP_PATTERN.test(input.step) ||
      !Number.isSafeInteger(input.completedUnits) ||
      input.completedUnits < 0 ||
      (input.totalUnits !== null &&
        (!Number.isSafeInteger(input.totalUnits) ||
          input.totalUnits < 1 ||
          input.completedUnits > input.totalUnits))
    ) {
      return validationError("Task progress is invalid.");
    }

    const previous = this.snapshot.progress;
    if (
      previous !== null &&
      (input.completedUnits < previous.completedUnits ||
        (previous.totalUnits !== null && input.totalUnits !== previous.totalUnits) ||
        (previous.totalUnits === null &&
          input.totalUnits !== null &&
          input.totalUnits < previous.completedUnits))
    ) {
      return validationError("Task progress cannot move backwards.");
    }

    return this.evolve({
      progress: Object.freeze({
        step: input.step,
        completedUnits: input.completedUnits,
        totalUnits: input.totalUnits,
        updatedAt: active.value.now,
      }),
      updatedAt: active.value.now,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public complete(leaseToken: string, nowValue: string): Result<Task, TaskEngineError> {
    const active = this.validateActiveLease(leaseToken, nowValue);
    if (!active.ok) {
      return active;
    }
    if (this.snapshot.cancelRequestedAt !== null) {
      return err(
        new TaskEngineError({
          code: "TASK_CANCEL_REQUESTED",
          message: "Cancellation won the race with task completion.",
          actions: ["CANCEL_TASK"],
        }),
      );
    }

    return this.evolve({
      status: "succeeded",
      lease: null,
      runAfter: null,
      failure: null,
      updatedAt: active.value.now,
      finishedAt: active.value.now,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public recordFailure(input: RecordTaskFailureInput): Result<Task, TaskEngineError> {
    const active = this.validateActiveLease(input.leaseToken, input.now);
    if (!active.ok) {
      return active;
    }
    if (this.snapshot.cancelRequestedAt !== null) {
      return this.cancelRunning(active.value.now);
    }

    if (input.failure.retryable && this.snapshot.attempt < this.snapshot.maxAttempts) {
      if (input.retryAt === null) {
        return validationError("A retryable task failure requires the next retry time.");
      }
      const retryAt = parseIsoUtcTimestamp(input.retryAt);
      if (!retryAt.ok) {
        return retryAt;
      }
      if (compareTimestamps(retryAt.value, active.value.now) <= 0) {
        return validationError("The next retry time must be later than the failure time.");
      }
      return this.evolve({
        status: "waiting_retry",
        attempt: this.snapshot.attempt + 1,
        lease: null,
        runAfter: retryAt.value,
        progress: null,
        failure: cloneTaskFailure(input.failure),
        updatedAt: active.value.now,
        sequence: this.snapshot.sequence + 1,
      });
    }

    const failure =
      input.failure.retryable && this.snapshot.attempt >= this.snapshot.maxAttempts
        ? retryExhaustedFailure(input.failure)
        : input.failure;
    return this.evolve({
      status: "failed",
      lease: null,
      runAfter: null,
      failure: cloneTaskFailure(failure),
      updatedAt: active.value.now,
      finishedAt: active.value.now,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public requestCancellation(nowValue: string): Result<Task, TaskEngineError> {
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }

    if (this.snapshot.status === "cancelled") {
      return ok(this);
    }
    if (this.snapshot.status === "succeeded" || this.snapshot.status === "failed") {
      return transitionError("A finished task cannot be cancelled.");
    }
    if (this.snapshot.status === "running") {
      if (this.snapshot.cancelRequestedAt !== null) {
        return ok(this);
      }
      return this.evolve({
        cancelRequestedAt: now.value,
        updatedAt: now.value,
        sequence: this.snapshot.sequence + 1,
      });
    }

    return this.evolve({
      status: "cancelled",
      lease: null,
      runAfter: null,
      failure: null,
      cancelRequestedAt: now.value,
      updatedAt: now.value,
      finishedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public acknowledgeCancellation(
    leaseToken: string,
    nowValue: string,
  ): Result<Task, TaskEngineError> {
    const active = this.validateActiveLease(leaseToken, nowValue);
    if (!active.ok) {
      return active;
    }
    if (this.snapshot.cancelRequestedAt === null) {
      return transitionError("The worker cannot acknowledge an unrequested cancellation.");
    }
    return this.cancelRunning(active.value.now);
  }

  public pause(nowValue: string, leaseToken: string | null = null): Result<Task, TaskEngineError> {
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    if (this.snapshot.status === "paused") {
      return ok(this);
    }
    if (this.isTerminal()) {
      return transitionError("A finished task cannot be paused.");
    }
    if (this.snapshot.status === "running") {
      if (leaseToken === null) {
        return leaseMismatch();
      }
      const active = this.validateActiveLease(leaseToken, nowValue);
      if (!active.ok) {
        return active;
      }
      if (this.snapshot.cancelRequestedAt !== null) {
        return err(
          new TaskEngineError({
            code: "TASK_CANCEL_REQUESTED",
            message: "A cancelling task cannot be paused.",
            actions: ["CANCEL_TASK"],
          }),
        );
      }
    }

    return this.evolve({
      status: "paused",
      lease: null,
      runAfter: null,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public resume(nowValue: string): Result<Task, TaskEngineError> {
    if (this.snapshot.status !== "paused") {
      return transitionError("Only a paused task can be resumed.");
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    return this.evolve({
      status: "queued",
      runAfter: now.value,
      failure: null,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  public recoverExpiredLease(nowValue: string): Result<Task, TaskEngineError> {
    if (this.snapshot.status !== "running" || this.snapshot.lease === null) {
      return transitionError("Only a running task can recover an expired lease.");
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    if (compareTimestamps(this.snapshot.lease.expiresAt, now.value) > 0) {
      return err(
        new TaskEngineError({
          code: "TASK_LEASE_EXPIRED",
          message: "The task lease has not expired yet.",
          retryable: true,
          actions: ["RETRY"],
        }),
      );
    }
    if (this.snapshot.cancelRequestedAt !== null) {
      return this.cancelRunning(now.value);
    }
    return this.evolve({
      status: "queued",
      lease: null,
      runAfter: now.value,
      failure: null,
      updatedAt: now.value,
      sequence: this.snapshot.sequence + 1,
    });
  }

  private validateActiveLease(
    leaseTokenValue: string,
    nowValue: string,
  ): Result<
    Readonly<{
      lease: TaskLease;
      now: IsoUtcTimestamp;
    }>,
    TaskEngineError
  > {
    if (this.snapshot.status !== "running" || this.snapshot.lease === null) {
      return transitionError("Task does not have an active lease.");
    }
    const token = parseUuidV7(leaseTokenValue);
    if (!token.ok) {
      return token;
    }
    if (token.value !== this.snapshot.lease.token) {
      return leaseMismatch();
    }
    const now = parseIsoUtcTimestamp(nowValue);
    if (!now.ok) {
      return now;
    }
    if (compareTimestamps(this.snapshot.lease.expiresAt, now.value) <= 0) {
      return err(
        new TaskEngineError({
          code: "TASK_LEASE_EXPIRED",
          message: "The task lease expired before the operation completed.",
          retryable: true,
          actions: ["RETRY"],
        }),
      );
    }
    return ok({ lease: this.snapshot.lease, now: now.value });
  }

  private cancelRunning(now: IsoUtcTimestamp): Result<Task, TaskEngineError> {
    return this.evolve({
      status: "cancelled",
      lease: null,
      runAfter: null,
      failure: null,
      cancelRequestedAt: this.snapshot.cancelRequestedAt ?? now,
      updatedAt: now,
      finishedAt: now,
      sequence: this.snapshot.sequence + 1,
    });
  }

  private evolve(changes: Partial<TaskSnapshot>): Result<Task, TaskEngineError> {
    return Task.rehydrate({
      ...this.snapshot,
      ...changes,
    });
  }
}

function validateTaskSnapshot(snapshot: TaskSnapshot): Result<TaskSnapshot, TaskEngineError> {
  const id = parseUuidV7(snapshot.id);
  if (!id.ok) {
    return id;
  }
  const type = parseTaskType(snapshot.type);
  if (!type.ok) {
    return type;
  }
  const idempotencyKey = parseIdempotencyKey(snapshot.idempotencyKey);
  if (!idempotencyKey.ok) {
    return idempotencyKey;
  }
  const metadata = createSafeMetadata(snapshot.metadata);
  if (!metadata.ok) {
    return metadata;
  }
  if (!TASK_STATUSES.includes(snapshot.status)) {
    return validationError("Task status is invalid.");
  }
  if (
    !Number.isSafeInteger(snapshot.priority) ||
    snapshot.priority < 0 ||
    snapshot.priority > 100 ||
    !Number.isSafeInteger(snapshot.attempt) ||
    snapshot.attempt < 1 ||
    !Number.isSafeInteger(snapshot.maxAttempts) ||
    snapshot.maxAttempts < snapshot.attempt ||
    snapshot.maxAttempts > 100 ||
    !Number.isSafeInteger(snapshot.sequence) ||
    snapshot.sequence < 1
  ) {
    return validationError("Task counters are invalid.");
  }

  const createdAt = parseIsoUtcTimestamp(snapshot.createdAt);
  if (!createdAt.ok) {
    return createdAt;
  }
  const updatedAt = parseIsoUtcTimestamp(snapshot.updatedAt);
  if (!updatedAt.ok) {
    return updatedAt;
  }
  if (compareTimestamps(updatedAt.value, createdAt.value) < 0) {
    return validationError("Task timestamps are out of order.");
  }
  const runAfter = parseOptionalTimestamp(snapshot.runAfter);
  if (!runAfter.ok) {
    return runAfter;
  }
  const cancelRequestedAt = parseOptionalTimestamp(snapshot.cancelRequestedAt);
  if (!cancelRequestedAt.ok) {
    return cancelRequestedAt;
  }
  const startedAt = parseOptionalTimestamp(snapshot.startedAt);
  if (!startedAt.ok) {
    return startedAt;
  }
  const finishedAt = parseOptionalTimestamp(snapshot.finishedAt);
  if (!finishedAt.ok) {
    return finishedAt;
  }

  const lease = validateLease(snapshot.lease);
  if (!lease.ok) {
    return lease;
  }
  const progress = validateProgress(snapshot.progress);
  if (!progress.ok) {
    return progress;
  }
  const failure = validateFailure(snapshot.failure);
  if (!failure.ok) {
    return failure;
  }

  const isQueued =
    snapshot.status === "queued" &&
    lease.value === null &&
    runAfter.value !== null &&
    failure.value === null &&
    finishedAt.value === null;
  const isRunning =
    snapshot.status === "running" &&
    lease.value !== null &&
    runAfter.value === null &&
    failure.value === null &&
    startedAt.value !== null &&
    finishedAt.value === null;
  const isWaitingRetry =
    snapshot.status === "waiting_retry" &&
    lease.value === null &&
    runAfter.value !== null &&
    failure.value !== null &&
    failure.value.retryable &&
    startedAt.value !== null &&
    finishedAt.value === null;
  const isPaused =
    snapshot.status === "paused" &&
    lease.value === null &&
    runAfter.value === null &&
    finishedAt.value === null;
  const isSucceeded =
    snapshot.status === "succeeded" &&
    lease.value === null &&
    runAfter.value === null &&
    failure.value === null &&
    startedAt.value !== null &&
    finishedAt.value !== null;
  const isFailed =
    snapshot.status === "failed" &&
    lease.value === null &&
    runAfter.value === null &&
    failure.value !== null &&
    startedAt.value !== null &&
    finishedAt.value !== null;
  const isCancelled =
    snapshot.status === "cancelled" &&
    lease.value === null &&
    runAfter.value === null &&
    failure.value === null &&
    cancelRequestedAt.value !== null &&
    finishedAt.value !== null;

  if (
    !isQueued &&
    !isRunning &&
    !isWaitingRetry &&
    !isPaused &&
    !isSucceeded &&
    !isFailed &&
    !isCancelled
  ) {
    return validationError("Task lifecycle fields do not match its current status.");
  }
  if (
    cancelRequestedAt.value !== null &&
    snapshot.status !== "running" &&
    snapshot.status !== "cancelled"
  ) {
    return validationError("Cancellation timestamp does not match task status.");
  }

  return ok({
    id: id.value,
    type: type.value,
    idempotencyKey: idempotencyKey.value,
    metadata: metadata.value,
    priority: snapshot.priority,
    status: snapshot.status,
    attempt: snapshot.attempt,
    maxAttempts: snapshot.maxAttempts,
    sequence: snapshot.sequence,
    runAfter: runAfter.value,
    lease: lease.value,
    progress: progress.value,
    failure: failure.value,
    cancelRequestedAt: cancelRequestedAt.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    startedAt: startedAt.value,
    finishedAt: finishedAt.value,
  });
}

function validateLease(lease: TaskLease | null): Result<TaskLease | null, TaskEngineError> {
  if (lease === null) {
    return ok(null);
  }
  const ownerId = parseWorkerId(lease.ownerId);
  if (!ownerId.ok) {
    return ownerId;
  }
  const token = parseUuidV7(lease.token);
  if (!token.ok) {
    return token;
  }
  const expiresAt = parseIsoUtcTimestamp(lease.expiresAt);
  if (!expiresAt.ok) {
    return expiresAt;
  }
  return ok(
    Object.freeze({
      ownerId: ownerId.value,
      token: token.value,
      expiresAt: expiresAt.value,
    }),
  );
}

function validateProgress(
  progress: TaskProgress | null,
): Result<TaskProgress | null, TaskEngineError> {
  if (progress === null) {
    return ok(null);
  }
  const updatedAt = parseIsoUtcTimestamp(progress.updatedAt);
  if (!updatedAt.ok) {
    return updatedAt;
  }
  if (
    !PROGRESS_STEP_PATTERN.test(progress.step) ||
    !Number.isSafeInteger(progress.completedUnits) ||
    progress.completedUnits < 0 ||
    (progress.totalUnits !== null &&
      (!Number.isSafeInteger(progress.totalUnits) ||
        progress.totalUnits < 1 ||
        progress.completedUnits > progress.totalUnits))
  ) {
    return validationError("Persisted task progress is invalid.");
  }
  return ok(
    Object.freeze({
      step: progress.step,
      completedUnits: progress.completedUnits,
      totalUnits: progress.totalUnits,
      updatedAt: updatedAt.value,
    }),
  );
}

function validateFailure(failure: TaskFailure | null): Result<TaskFailure | null, TaskEngineError> {
  if (failure === null) {
    return ok(null);
  }
  const validated = createTaskFailure({
    code: failure.code,
    causeCode: failure.causeCode,
    retryable: failure.retryable,
    actions: failure.actions,
    requestId: failure.requestId,
  });
  return validated;
}

function parseOptionalTimestamp(
  value: string | null,
): Result<IsoUtcTimestamp | null, TaskEngineError> {
  if (value === null) {
    return ok(null);
  }
  return parseIsoUtcTimestamp(value);
}

function cloneTaskSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
  return {
    ...snapshot,
    metadata: cloneSafeMetadata(snapshot.metadata),
    lease: snapshot.lease === null ? null : Object.freeze({ ...snapshot.lease }),
    progress: snapshot.progress === null ? null : Object.freeze({ ...snapshot.progress }),
    failure: cloneTaskFailure(snapshot.failure),
  };
}

function cloneTaskFailure(failure: TaskFailure | null): TaskFailure | null {
  if (failure === null) {
    return null;
  }
  return Object.freeze({
    ...failure,
    actions: Object.freeze([...failure.actions]),
  });
}

function validationError(message: string): Result<never, TaskEngineError> {
  return err(
    new TaskEngineError({
      code: "TASK_VALIDATION_FAILED",
      message,
    }),
  );
}

function transitionError(message: string): Result<never, TaskEngineError> {
  return err(
    new TaskEngineError({
      code: "TASK_INVALID_TRANSITION",
      message,
    }),
  );
}

function leaseMismatch(): Result<never, TaskEngineError> {
  return err(
    new TaskEngineError({
      code: "TASK_LEASE_MISMATCH",
      message: "Task lease token does not match the active worker lease.",
      retryable: true,
      actions: ["RETRY"],
    }),
  );
}
