import type { BackoffPolicy } from "./backoff.js";
import { TaskEngineError, createTaskFailure, type TaskFailureInput } from "./errors.js";
import { Notification, type CreateNotificationInput } from "./notification.js";
import type {
  CreateNotificationResult,
  CreateTaskResult,
  NotificationRepository,
  TaskLogEvent,
  TaskLogEventType,
  TaskLogSink,
  TaskRepository,
} from "./ports.js";
import { err, ok, type Result } from "./result.js";
import { Task } from "./task.js";
import {
  addMilliseconds,
  parseIsoUtcTimestamp,
  parseNotificationDedupeKey,
  parseUuidV7,
  parseWorkerId,
  type Clock,
  type IsoUtcTimestamp,
  type UuidV7Generator,
  type WorkerId,
} from "./value-objects.js";

export interface TaskSchedulerOptions {
  readonly tasks: TaskRepository;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
  readonly backoff: BackoffPolicy;
  readonly leaseDurationMilliseconds: number;
  readonly log?: TaskLogSink;
}

export interface EnqueueTaskCommand {
  readonly type: string;
  readonly idempotencyKey: string;
  readonly metadata: unknown;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly runAfter?: string;
}

export interface ReportProgressCommand {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly step: string;
  readonly completedUnits: number;
  readonly totalUnits: number | null;
}

export interface RecoverExpiredLeasesReport {
  readonly recovered: number;
  readonly cancelled: number;
  readonly conflicts: number;
}

export class TaskScheduler {
  public constructor(private readonly options: TaskSchedulerOptions) {}

  public async enqueue(
    command: EnqueueTaskCommand,
  ): Promise<Result<CreateTaskResult, TaskEngineError>> {
    const now = this.now();
    if (!now.ok) {
      return now;
    }
    const task = Task.create({
      id: this.options.ids.next(),
      type: command.type,
      idempotencyKey: command.idempotencyKey,
      metadata: command.metadata,
      priority: command.priority ?? 50,
      maxAttempts: command.maxAttempts ?? 3,
      now: now.value,
      ...(command.runAfter === undefined ? {} : { runAfter: command.runAfter }),
    });
    if (!task.ok) {
      return task;
    }

    const created = await this.options.tasks.createIfAbsent(task.value);
    if (!created.ok) {
      return created;
    }
    if (!created.value.created && !created.value.task.isSameRequestAs(task.value)) {
      return err(
        new TaskEngineError({
          code: "TASK_IDEMPOTENCY_CONFLICT",
          message: "Idempotency key already belongs to a different task request.",
        }),
      );
    }

    await this.writeLog(
      created.value.created ? "task.enqueued" : "task.deduplicated",
      created.value.task,
      now.value,
      null,
      null,
    );
    return created;
  }

  public async claimNext(workerIdValue: string): Promise<Result<Task | null, TaskEngineError>> {
    const now = this.now();
    if (!now.ok) {
      return now;
    }
    const workerId = parseWorkerId(workerIdValue);
    if (!workerId.ok) {
      return workerId;
    }
    const leaseToken = parseUuidV7(this.options.ids.next());
    if (!leaseToken.ok) {
      return leaseToken;
    }
    const leaseExpiresAt = addMilliseconds(now.value, this.options.leaseDurationMilliseconds);
    if (!leaseExpiresAt.ok) {
      return leaseExpiresAt;
    }

    const claimed = await this.options.tasks.claimNext({
      ownerId: workerId.value,
      leaseToken: leaseToken.value,
      now: now.value,
      leaseExpiresAt: leaseExpiresAt.value,
    });
    if (!claimed.ok || claimed.value === null) {
      return claimed;
    }
    await this.writeLog("task.claimed", claimed.value, now.value, workerId.value, null);
    return claimed;
  }

  public async renewLease(
    taskIdValue: string,
    leaseToken: string,
  ): Promise<Result<Task, TaskEngineError>> {
    return this.mutateTask(
      taskIdValue,
      (task, now) => {
        const expiresAt = addMilliseconds(now, this.options.leaseDurationMilliseconds);
        return expiresAt.ok ? task.renewLease(leaseToken, now, expiresAt.value) : expiresAt;
      },
      "task.lease_renewed",
      null,
    );
  }

  public async reportProgress(
    command: ReportProgressCommand,
  ): Promise<Result<Task, TaskEngineError>> {
    return this.mutateTask(
      command.taskId,
      (task, now) =>
        task.reportProgress({
          leaseToken: command.leaseToken,
          step: command.step,
          completedUnits: command.completedUnits,
          totalUnits: command.totalUnits,
          now,
        }),
      "task.progressed",
      null,
    );
  }

  public async complete(
    taskIdValue: string,
    leaseToken: string,
  ): Promise<Result<Task, TaskEngineError>> {
    return this.mutateTask(
      taskIdValue,
      (task, now) => task.complete(leaseToken, now),
      "task.succeeded",
      null,
    );
  }

  public async fail(
    taskIdValue: string,
    leaseToken: string,
    failureInput: TaskFailureInput,
  ): Promise<Result<Task, TaskEngineError>> {
    const failure = createTaskFailure(failureInput);
    if (!failure.ok) {
      return failure;
    }

    const current = await this.loadTask(taskIdValue);
    if (!current.ok) {
      return current;
    }
    const now = this.now();
    if (!now.ok) {
      return now;
    }

    let retryAt: IsoUtcTimestamp | null = null;
    if (failure.value.retryable && current.value.attempt < current.value.maxAttempts) {
      const delay = this.options.backoff.delayMilliseconds(current.value.attempt);
      if (!delay.ok) {
        return delay;
      }
      const calculated = addMilliseconds(now.value, delay.value);
      if (!calculated.ok) {
        return calculated;
      }
      retryAt = calculated.value;
    }

    const next = current.value.recordFailure({
      leaseToken,
      failure: failure.value,
      now: now.value,
      retryAt,
    });
    if (!next.ok) {
      return next;
    }
    const saved = await this.options.tasks.save(next.value, current.value.sequence);
    if (!saved.ok) {
      return saved;
    }
    await this.writeLog(
      next.value.status === "waiting_retry"
        ? "task.retry_scheduled"
        : next.value.status === "cancelled"
          ? "task.cancelled"
          : "task.failed",
      next.value,
      now.value,
      current.value.lease?.ownerId ?? null,
      next.value.failure?.code ?? failure.value.code,
    );
    return next;
  }

  public async requestCancellation(taskIdValue: string): Promise<Result<Task, TaskEngineError>> {
    const current = await this.loadTask(taskIdValue);
    if (!current.ok) {
      return current;
    }
    const now = this.now();
    if (!now.ok) {
      return now;
    }
    const next = current.value.requestCancellation(now.value);
    if (!next.ok) {
      return next;
    }
    if (next.value.sequence === current.value.sequence) {
      return next;
    }
    const saved = await this.options.tasks.save(next.value, current.value.sequence);
    if (!saved.ok) {
      return saved;
    }
    await this.writeLog(
      next.value.status === "cancelled" ? "task.cancelled" : "task.cancel_requested",
      next.value,
      now.value,
      current.value.lease?.ownerId ?? null,
      null,
    );
    return next;
  }

  public async acknowledgeCancellation(
    taskIdValue: string,
    leaseToken: string,
  ): Promise<Result<Task, TaskEngineError>> {
    return this.mutateTask(
      taskIdValue,
      (task, now) => task.acknowledgeCancellation(leaseToken, now),
      "task.cancelled",
      null,
    );
  }

  public async pause(
    taskIdValue: string,
    leaseToken: string | null = null,
  ): Promise<Result<Task, TaskEngineError>> {
    return this.mutateTask(
      taskIdValue,
      (task, now) => task.pause(now, leaseToken),
      "task.paused",
      null,
    );
  }

  public async resume(taskIdValue: string): Promise<Result<Task, TaskEngineError>> {
    return this.mutateTask(taskIdValue, (task, now) => task.resume(now), "task.resumed", null);
  }

  public async recoverExpiredLeases(
    limit = 100,
  ): Promise<Result<RecoverExpiredLeasesReport, TaskEngineError>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      return err(
        new TaskEngineError({
          code: "TASK_VALIDATION_FAILED",
          message: "Lease recovery limit is invalid.",
        }),
      );
    }
    const now = this.now();
    if (!now.ok) {
      return now;
    }
    const expired = await this.options.tasks.listExpiredLeases(now.value, limit);
    if (!expired.ok) {
      return expired;
    }

    let recovered = 0;
    let cancelled = 0;
    let conflicts = 0;
    for (const task of expired.value) {
      const next = task.recoverExpiredLease(now.value);
      if (!next.ok) {
        continue;
      }
      const saved = await this.options.tasks.save(next.value, task.sequence);
      if (!saved.ok) {
        if (saved.error.code === "TASK_SEQUENCE_CONFLICT") {
          conflicts += 1;
          continue;
        }
        return saved;
      }
      if (next.value.status === "cancelled") {
        cancelled += 1;
      } else {
        recovered += 1;
      }
      await this.writeLog(
        next.value.status === "cancelled" ? "task.cancelled" : "task.lease_recovered",
        next.value,
        now.value,
        task.lease?.ownerId ?? null,
        null,
      );
    }
    return ok({ recovered, cancelled, conflicts });
  }

  private async mutateTask(
    taskIdValue: string,
    mutate: (task: Task, now: IsoUtcTimestamp) => Result<Task, TaskEngineError>,
    logEvent: TaskLogEventType,
    errorCode: string | null,
  ): Promise<Result<Task, TaskEngineError>> {
    const current = await this.loadTask(taskIdValue);
    if (!current.ok) {
      return current;
    }
    const now = this.now();
    if (!now.ok) {
      return now;
    }
    const next = mutate(current.value, now.value);
    if (!next.ok) {
      return next;
    }
    if (next.value.sequence === current.value.sequence) {
      return next;
    }
    const saved = await this.options.tasks.save(next.value, current.value.sequence);
    if (!saved.ok) {
      return saved;
    }
    await this.writeLog(
      logEvent,
      next.value,
      now.value,
      current.value.lease?.ownerId ?? null,
      errorCode,
    );
    return next;
  }

  private async loadTask(taskIdValue: string): Promise<Result<Task, TaskEngineError>> {
    const taskId = parseUuidV7(taskIdValue);
    if (!taskId.ok) {
      return taskId;
    }
    const task = await this.options.tasks.findById(taskId.value);
    if (!task.ok) {
      return task;
    }
    return task.value === null
      ? err(
          new TaskEngineError({
            code: "TASK_NOT_FOUND",
            message: "Task was not found.",
          }),
        )
      : ok(task.value);
  }

  private now(): Result<IsoUtcTimestamp, TaskEngineError> {
    return parseIsoUtcTimestamp(this.options.clock.now());
  }

  private async writeLog(
    event: TaskLogEventType,
    task: Task,
    at: IsoUtcTimestamp,
    workerId: WorkerId | null,
    errorCode: string | null,
  ): Promise<void> {
    if (this.options.log === undefined) {
      return;
    }
    const record: TaskLogEvent = Object.freeze({
      event,
      taskId: task.id,
      taskType: task.type,
      status: task.status,
      attempt: task.attempt,
      sequence: task.sequence,
      workerId,
      errorCode,
      at,
    });
    try {
      await this.options.log.write(record);
    } catch {
      // Task truth is already durable; diagnostic delivery cannot rewrite it.
    }
  }
}

export interface NotificationServiceOptions {
  readonly notifications: NotificationRepository;
  readonly clock: Clock;
  readonly ids: UuidV7Generator;
}

export type PublishNotificationCommand = Omit<CreateNotificationInput, "id" | "now">;

export interface ExpireNotificationsReport {
  readonly expired: number;
  readonly conflicts: number;
  readonly retained: number;
}

export class NotificationService {
  public constructor(private readonly options: NotificationServiceOptions) {}

  public async publish(
    command: PublishNotificationCommand,
  ): Promise<Result<CreateNotificationResult, TaskEngineError>> {
    const now = this.now();
    if (!now.ok) {
      return now;
    }
    const notification = Notification.create({
      ...command,
      id: this.options.ids.next(),
      now: now.value,
    });
    if (!notification.ok) {
      return notification;
    }
    const created = await this.options.notifications.createIfAbsent(notification.value);
    if (!created.ok) {
      return created;
    }
    if (
      !created.value.created &&
      !created.value.notification.isSameNotificationAs(notification.value)
    ) {
      return err(
        new TaskEngineError({
          code: "NOTIFICATION_DEDUPE_CONFLICT",
          message: "Notification dedupe key belongs to different notification semantics.",
        }),
      );
    }
    return created;
  }

  public async queue(notificationId: string): Promise<Result<Notification, TaskEngineError>> {
    return this.mutate(notificationId, (item, now) => item.queue(now));
  }

  public async markVisible(notificationId: string): Promise<Result<Notification, TaskEngineError>> {
    return this.mutate(notificationId, (item, now) => item.markVisible(now));
  }

  public async markRead(notificationId: string): Promise<Result<Notification, TaskEngineError>> {
    return this.mutate(notificationId, (item, now) => item.markRead(now));
  }

  public async markActed(notificationId: string): Promise<Result<Notification, TaskEngineError>> {
    return this.mutate(notificationId, (item, now) => item.markActed(now));
  }

  public async dismiss(notificationId: string): Promise<Result<Notification, TaskEngineError>> {
    return this.mutate(notificationId, (item, now) => item.dismiss(now));
  }

  public async failDelivery(
    notificationId: string,
  ): Promise<Result<Notification, TaskEngineError>> {
    return this.mutate(notificationId, (item, now) => item.failDelivery(now));
  }

  public async expireDue(limit = 100): Promise<Result<ExpireNotificationsReport, TaskEngineError>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      return err(
        new TaskEngineError({
          code: "TASK_VALIDATION_FAILED",
          message: "Notification expiration limit is invalid.",
        }),
      );
    }
    const now = this.now();
    if (!now.ok) {
      return now;
    }
    const due = await this.options.notifications.listDueForExpiration(now.value, limit);
    if (!due.ok) {
      return due;
    }

    let expired = 0;
    let conflicts = 0;
    let retained = 0;
    for (const notification of due.value) {
      const next = notification.expire(now.value);
      if (!next.ok) {
        retained += 1;
        continue;
      }
      const saved = await this.options.notifications.save(next.value, notification.sequence);
      if (!saved.ok) {
        if (saved.error.code === "NOTIFICATION_SEQUENCE_CONFLICT") {
          conflicts += 1;
          continue;
        }
        return saved;
      }
      expired += 1;
    }
    return ok({ expired, conflicts, retained });
  }

  public async findByDedupeKey(
    dedupeKeyValue: string,
  ): Promise<Result<Notification | null, TaskEngineError>> {
    const dedupeKey = parseNotificationDedupeKey(dedupeKeyValue);
    return dedupeKey.ok ? this.options.notifications.findByDedupeKey(dedupeKey.value) : dedupeKey;
  }

  private async mutate(
    notificationIdValue: string,
    mutate: (
      notification: Notification,
      now: IsoUtcTimestamp,
    ) => Result<Notification, TaskEngineError>,
  ): Promise<Result<Notification, TaskEngineError>> {
    const id = parseUuidV7(notificationIdValue);
    if (!id.ok) {
      return id;
    }
    const current = await this.options.notifications.findById(id.value);
    if (!current.ok) {
      return current;
    }
    if (current.value === null) {
      return err(
        new TaskEngineError({
          code: "NOTIFICATION_NOT_FOUND",
          message: "Notification was not found.",
        }),
      );
    }
    const now = this.now();
    if (!now.ok) {
      return now;
    }
    const next = mutate(current.value, now.value);
    if (!next.ok) {
      return next;
    }
    if (next.value.sequence === current.value.sequence) {
      return next;
    }
    const saved = await this.options.notifications.save(next.value, current.value.sequence);
    return saved.ok ? next : saved;
  }

  private now(): Result<IsoUtcTimestamp, TaskEngineError> {
    return parseIsoUtcTimestamp(this.options.clock.now());
  }
}
