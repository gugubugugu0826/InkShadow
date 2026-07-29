import {
  Notification,
  Task,
  TaskEngineError,
  compareTimestamps,
  err,
  ok,
  parseIsoUtcTimestamp,
  type ClaimNextTaskCommand,
  type Clock,
  type CreateNotificationResult,
  type CreateTaskResult,
  type IsoUtcTimestamp,
  type NotificationDedupeKey,
  type NotificationRepository,
  type Result,
  type TaskRepository,
  type UuidV7,
  type UuidV7Generator,
} from "../src/index.js";

export class ManualClock implements Clock {
  public constructor(private current: string) {}

  public now(): string {
    return this.current;
  }

  public set(value: string): void {
    this.current = value;
  }

  public advance(milliseconds: number): void {
    this.current = new Date(Date.parse(this.current) + milliseconds).toISOString();
  }
}

export class SequenceUuidV7Generator implements UuidV7Generator {
  private sequence = 1;

  public next(): string {
    const tail = this.sequence.toString(16).padStart(12, "0");
    this.sequence += 1;
    return `019f9f4a-b3c7-7350-9226-${tail}`;
  }
}

export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, Task>();

  public beforeNextSave:
    | ((
        repository: InMemoryTaskRepository,
        candidate: Task,
        expectedSequence: number,
      ) => void | Promise<void>)
    | null = null;

  public async createIfAbsent(task: Task): Promise<Result<CreateTaskResult, TaskEngineError>> {
    const existing = [...this.tasks.values()].find(
      (candidate) => candidate.idempotencyKey === task.idempotencyKey,
    );
    if (existing !== undefined) {
      return existing.isSameRequestAs(task)
        ? ok({ task: cloneTask(existing), created: false })
        : err(
            new TaskEngineError({
              code: "TASK_IDEMPOTENCY_CONFLICT",
              message: "Idempotency key already belongs to another request.",
            }),
          );
    }
    const stored = cloneTask(task);
    this.tasks.set(task.id, stored);
    return ok({ task: cloneTask(stored), created: true });
  }

  public async findById(id: UuidV7): Promise<Result<Task | null, TaskEngineError>> {
    const task = this.tasks.get(id);
    return ok(task === undefined ? null : cloneTask(task));
  }

  public async claimNext(
    command: ClaimNextTaskCommand,
  ): Promise<Result<Task | null, TaskEngineError>> {
    const eligible = [...this.tasks.values()]
      .filter((task) => {
        const runnable = task.status === "queued" || task.status === "waiting_retry";
        return (
          runnable && task.runAfter !== null && compareTimestamps(task.runAfter, command.now) <= 0
        );
      })
      .sort((left, right) => {
        if (left.priority !== right.priority) {
          return right.priority - left.priority;
        }
        const byCreatedAt =
          Date.parse(left.toSnapshot().createdAt) - Date.parse(right.toSnapshot().createdAt);
        return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
      });
    const selected = eligible[0];
    if (selected === undefined) {
      return ok(null);
    }
    const claimed = selected.claim({
      ownerId: command.ownerId,
      leaseToken: command.leaseToken,
      now: command.now,
      leaseExpiresAt: command.leaseExpiresAt,
    });
    if (!claimed.ok) {
      return claimed;
    }
    this.tasks.set(selected.id, cloneTask(claimed.value));
    return ok(cloneTask(claimed.value));
  }

  public async save(task: Task, expectedSequence: number): Promise<Result<void, TaskEngineError>> {
    const beforeSave = this.beforeNextSave;
    this.beforeNextSave = null;
    if (beforeSave !== null) {
      await beforeSave(this, task, expectedSequence);
    }

    const current = this.tasks.get(task.id);
    if (current === undefined) {
      return err(
        new TaskEngineError({
          code: "TASK_NOT_FOUND",
          message: "Task was not found.",
        }),
      );
    }
    if (current.sequence !== expectedSequence) {
      return err(
        new TaskEngineError({
          code: "TASK_SEQUENCE_CONFLICT",
          message: "Task changed before compare-and-swap persistence.",
          retryable: true,
          actions: ["RETRY"],
        }),
      );
    }
    this.tasks.set(task.id, cloneTask(task));
    return ok(undefined);
  }

  public async listExpiredLeases(
    now: IsoUtcTimestamp,
    limit: number,
  ): Promise<Result<readonly Task[], TaskEngineError>> {
    return ok(
      [...this.tasks.values()]
        .filter((task) => {
          const lease = task.lease;
          return (
            task.status === "running" &&
            lease !== null &&
            compareTimestamps(lease.expiresAt, now) <= 0
          );
        })
        .slice(0, limit)
        .map(cloneTask),
    );
  }

  public get(taskId: string): Task | null {
    const task = this.tasks.get(taskId);
    return task === undefined ? null : cloneTask(task);
  }

  public mutateStored(taskId: string, mutate: (task: Task) => Task): void {
    const current = this.tasks.get(taskId);
    if (current === undefined) {
      throw new Error("Missing task in test repository.");
    }
    this.tasks.set(taskId, cloneTask(mutate(cloneTask(current))));
  }
}

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly notifications = new Map<string, Notification>();

  public async createIfAbsent(
    notification: Notification,
  ): Promise<Result<CreateNotificationResult, TaskEngineError>> {
    const existing = [...this.notifications.values()].find(
      (candidate) => candidate.dedupeKey === notification.dedupeKey,
    );
    if (existing !== undefined) {
      return existing.isSameNotificationAs(notification)
        ? ok({
            notification: cloneNotification(existing),
            created: false,
          })
        : err(
            new TaskEngineError({
              code: "NOTIFICATION_DEDUPE_CONFLICT",
              message: "Dedupe key belongs to another notification.",
            }),
          );
    }
    const stored = cloneNotification(notification);
    this.notifications.set(notification.id, stored);
    return ok({
      notification: cloneNotification(stored),
      created: true,
    });
  }

  public async findById(id: UuidV7): Promise<Result<Notification | null, TaskEngineError>> {
    const notification = this.notifications.get(id);
    return ok(notification === undefined ? null : cloneNotification(notification));
  }

  public async findByDedupeKey(
    dedupeKey: NotificationDedupeKey,
  ): Promise<Result<Notification | null, TaskEngineError>> {
    const notification = [...this.notifications.values()].find(
      (candidate) => candidate.dedupeKey === dedupeKey,
    );
    return ok(notification === undefined ? null : cloneNotification(notification));
  }

  public async save(
    notification: Notification,
    expectedSequence: number,
  ): Promise<Result<void, TaskEngineError>> {
    const current = this.notifications.get(notification.id);
    if (current === undefined) {
      return err(
        new TaskEngineError({
          code: "NOTIFICATION_NOT_FOUND",
          message: "Notification was not found.",
        }),
      );
    }
    if (current.sequence !== expectedSequence) {
      return err(
        new TaskEngineError({
          code: "NOTIFICATION_SEQUENCE_CONFLICT",
          message: "Notification changed before compare-and-swap persistence.",
          retryable: true,
          actions: ["RETRY"],
        }),
      );
    }
    this.notifications.set(notification.id, cloneNotification(notification));
    return ok(undefined);
  }

  public async listDueForExpiration(
    now: IsoUtcTimestamp,
    limit: number,
  ): Promise<Result<readonly Notification[], TaskEngineError>> {
    return ok(
      [...this.notifications.values()]
        .filter((notification) => {
          const snapshot = notification.toSnapshot();
          return (
            snapshot.expiresAt !== null &&
            compareTimestamps(snapshot.expiresAt, now) <= 0 &&
            (snapshot.status === "visible" ||
              snapshot.status === "read" ||
              snapshot.status === "dismissed")
          );
        })
        .slice(0, limit)
        .map(cloneNotification),
    );
  }
}

export function timestamp(minutes: number): IsoUtcTimestamp {
  const parsed = parseIsoUtcTimestamp(new Date(Date.UTC(2026, 6, 27, 0, minutes)).toISOString());
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

export function uuid(sequence: number): UuidV7 {
  const result = Task.create({
    id: `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`,
    type: "test.uuid",
    idempotencyKey: `test:uuid:${String(sequence).padStart(8, "0")}`,
    metadata: {},
    priority: 0,
    maxAttempts: 1,
    now: timestamp(0),
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.value.id;
}

function cloneTask(task: Task): Task {
  const cloned = Task.rehydrate(task.toSnapshot());
  if (!cloned.ok) {
    throw cloned.error;
  }
  return cloned.value;
}

function cloneNotification(notification: Notification): Notification {
  const cloned = Notification.rehydrate(notification.toSnapshot());
  if (!cloned.ok) {
    throw cloned.error;
  }
  return cloned.value;
}
