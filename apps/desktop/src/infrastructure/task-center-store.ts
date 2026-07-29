import {
  SqliteNotificationRepository,
  SqliteTaskRepository,
  type SqlExecutor,
} from "@inkshadow/data";
import {
  Notification,
  Task,
  TaskEngineError,
  createTaskFailure,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type CreateNotificationInput,
  type CreateTaskInput,
  type NotificationSnapshot,
  type TaskFailureInput,
  type TaskSnapshot,
} from "@inkshadow/task-engine";

export const DEVELOPMENT_TASK_CENTER_KEY = "inkshadow.development.task-center.v1";

const TASK_LIST_LIMIT = 200;
const NOTIFICATION_LIST_LIMIT = 200;
const ACTIVE_NOTIFICATION_STATUSES = [
  "created",
  "queued",
  "visible",
  "read",
  "failed_delivery",
] as const;

export interface TaskCenterSnapshot {
  readonly tasks: readonly TaskSnapshot[];
  readonly notifications: readonly NotificationSnapshot[];
}

export interface CreateTaskSnapshotResult {
  readonly task: TaskSnapshot;
  readonly created: boolean;
}

export interface TaskCenterStore {
  load(): Promise<TaskCenterSnapshot>;
  enqueueTask(input: CreateTaskInput): Promise<CreateTaskSnapshotResult>;
  startTask(
    taskId: string,
    ownerId: string,
    leaseToken: string,
    leaseExpiresAt: string,
  ): Promise<TaskSnapshot>;
  reportTaskProgress(
    taskId: string,
    leaseToken: string,
    step: string,
    completedUnits: number,
    totalUnits: number | null,
  ): Promise<TaskSnapshot>;
  completeTask(taskId: string, leaseToken: string): Promise<TaskSnapshot>;
  failTask(
    taskId: string,
    leaseToken: string,
    failure: TaskFailureInput,
    retryAt: string | null,
  ): Promise<TaskSnapshot>;
  cancelTask(taskId: string): Promise<TaskSnapshot>;
  acknowledgeTaskCancellation(taskId: string, leaseToken: string): Promise<TaskSnapshot>;
  recoverExpiredTasks(): Promise<number>;
  publishNotification(input: CreateNotificationInput): Promise<NotificationSnapshot>;
  markNotificationRead(notificationId: string): Promise<NotificationSnapshot>;
  markAllNotificationsRead(): Promise<number>;
}

interface ClockLike {
  now(): string;
}

interface StoredTaskCenter {
  readonly schemaVersion: 1;
  tasks: TaskSnapshot[];
  notifications: NotificationSnapshot[];
}

interface IdRow {
  id: string;
}

export class TauriTaskCenterStore implements TaskCenterStore {
  private readonly tasks: SqliteTaskRepository;
  private readonly notifications: SqliteNotificationRepository;

  public constructor(
    private readonly executor: SqlExecutor,
    private readonly clock: ClockLike,
  ) {
    this.tasks = new SqliteTaskRepository(executor);
    this.notifications = new SqliteNotificationRepository(executor);
  }

  public async load(): Promise<TaskCenterSnapshot> {
    await this.recoverExpiredTasks();
    const [taskRows, notificationRows] = await Promise.all([
      this.executor.select<IdRow>(
        `SELECT id
         FROM background_tasks
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [TASK_LIST_LIMIT],
      ),
      this.executor.select<IdRow>(
        `SELECT id
         FROM notifications
         WHERE status IN ('created', 'queued', 'visible', 'read', 'failed_delivery')
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
        [NOTIFICATION_LIST_LIMIT],
      ),
    ]);

    const tasks = await Promise.all(taskRows.map(({ id }) => this.loadTask(id)));
    const notifications = await Promise.all(
      notificationRows.map(({ id }) => this.loadNotification(id)),
    );

    return {
      tasks: tasks.map((task) => task.toSnapshot()),
      notifications: notifications.map((notification) => notification.toSnapshot()),
    };
  }

  public async enqueueTask(input: CreateTaskInput): Promise<CreateTaskSnapshotResult> {
    const task = unwrap(Task.create(input));
    const created = unwrap(await this.tasks.createIfAbsent(task));
    if (!created.created && !created.task.isSameRequestAs(task)) {
      throw new TaskEngineError({
        code: "TASK_IDEMPOTENCY_CONFLICT",
        message: "Idempotency key already belongs to a different task request.",
      });
    }
    return { task: created.task.toSnapshot(), created: created.created };
  }

  public async startTask(
    taskId: string,
    ownerId: string,
    leaseToken: string,
    leaseExpiresAt: string,
  ): Promise<TaskSnapshot> {
    return this.mutateTask(taskId, (current) =>
      current.claim({
        ownerId,
        leaseToken,
        now: this.clock.now(),
        leaseExpiresAt,
      }),
    );
  }

  public async reportTaskProgress(
    taskId: string,
    leaseToken: string,
    step: string,
    completedUnits: number,
    totalUnits: number | null,
  ): Promise<TaskSnapshot> {
    return this.mutateTask(taskId, (current) =>
      current.reportProgress({
        leaseToken,
        step,
        completedUnits,
        totalUnits,
        now: this.clock.now(),
      }),
    );
  }

  public async completeTask(taskId: string, leaseToken: string): Promise<TaskSnapshot> {
    return this.mutateTask(taskId, (current) => current.complete(leaseToken, this.clock.now()));
  }

  public async failTask(
    taskId: string,
    leaseToken: string,
    failureInput: TaskFailureInput,
    retryAt: string | null,
  ): Promise<TaskSnapshot> {
    const failure = unwrap(createTaskFailure(failureInput));
    return this.mutateTask(taskId, (current) =>
      current.recordFailure({
        leaseToken,
        failure,
        now: this.clock.now(),
        retryAt,
      }),
    );
  }

  public async cancelTask(taskId: string): Promise<TaskSnapshot> {
    const current = await this.loadTask(taskId);
    const next = unwrap(current.requestCancellation(this.clock.now()));
    if (next.sequence !== current.sequence) {
      unwrap(await this.tasks.save(next, current.sequence));
    }
    return next.toSnapshot();
  }

  public async acknowledgeTaskCancellation(
    taskId: string,
    leaseToken: string,
  ): Promise<TaskSnapshot> {
    return this.mutateTask(taskId, (current) =>
      current.acknowledgeCancellation(leaseToken, this.clock.now()),
    );
  }

  public async recoverExpiredTasks(): Promise<number> {
    const now = unwrap(parseIsoUtcTimestamp(this.clock.now()));
    const expired = unwrap(await this.tasks.listExpiredLeases(now, TASK_LIST_LIMIT));
    let recovered = 0;
    for (const task of expired) {
      const next = unwrap(task.recoverExpiredLease(now));
      const saved = await this.tasks.save(next, task.sequence);
      if (saved.ok) {
        recovered += 1;
      } else if (saved.error.code !== "TASK_SEQUENCE_CONFLICT") {
        throw saved.error;
      }
    }
    return recovered;
  }

  public async publishNotification(input: CreateNotificationInput): Promise<NotificationSnapshot> {
    const notification = unwrap(Notification.create(input));
    const created = unwrap(await this.notifications.createIfAbsent(notification));
    if (!created.created && !created.notification.isSameNotificationAs(notification)) {
      throw new TaskEngineError({
        code: "NOTIFICATION_DEDUPE_CONFLICT",
        message: "Notification dedupe key belongs to different notification semantics.",
      });
    }
    let current = created.notification;
    if (current.status === "created") {
      current = await this.saveNotificationTransition(current, current.queue(this.clock.now()));
    }
    if (current.status === "queued") {
      current = await this.saveNotificationTransition(
        current,
        current.markVisible(this.clock.now()),
      );
    }
    return current.toSnapshot();
  }

  public async markNotificationRead(notificationId: string): Promise<NotificationSnapshot> {
    let current = await this.loadNotification(notificationId);

    if (current.status === "created") {
      current = await this.saveNotificationTransition(current, current.queue(this.clock.now()));
    }
    if (current.status === "queued") {
      current = await this.saveNotificationTransition(
        current,
        current.markVisible(this.clock.now()),
      );
    }
    if (current.status === "visible") {
      current = await this.saveNotificationTransition(current, current.markRead(this.clock.now()));
    }

    if (current.status !== "read") {
      throw invalidNotificationTransition(current.status);
    }
    return current.toSnapshot();
  }

  public async markAllNotificationsRead(): Promise<number> {
    const rows = await this.executor.select<IdRow>(
      `SELECT id
       FROM notifications
       WHERE status IN ('created', 'queued', 'visible')
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
      [NOTIFICATION_LIST_LIMIT],
    );
    let markedRead = 0;
    for (const { id } of rows) {
      await this.markNotificationRead(id);
      markedRead += 1;
    }
    return markedRead;
  }

  private async loadTask(taskId: string): Promise<Task> {
    const id = unwrap(parseUuidV7(taskId));
    const result = unwrap(await this.tasks.findById(id));
    if (result === null) {
      throw new TaskEngineError({
        code: "TASK_NOT_FOUND",
        message: "Task was not found.",
      });
    }
    return result;
  }

  private async loadNotification(notificationId: string): Promise<Notification> {
    const id = unwrap(parseUuidV7(notificationId));
    const result = unwrap(await this.notifications.findById(id));
    if (result === null) {
      throw new TaskEngineError({
        code: "NOTIFICATION_NOT_FOUND",
        message: "Notification was not found.",
      });
    }
    return result;
  }

  private async mutateTask(
    taskId: string,
    transition: (current: Task) => ReturnType<Task["requestCancellation"]>,
  ): Promise<TaskSnapshot> {
    const current = await this.loadTask(taskId);
    const next = unwrap(transition(current));
    if (next.sequence !== current.sequence) {
      unwrap(await this.tasks.save(next, current.sequence));
    }
    return next.toSnapshot();
  }

  private async saveNotificationTransition(
    current: Notification,
    transition: ReturnType<Notification["markRead"]>,
  ): Promise<Notification> {
    const next = unwrap(transition);
    if (next.sequence !== current.sequence) {
      unwrap(await this.notifications.save(next, current.sequence));
    }
    return next;
  }
}

export class BrowserDevelopmentTaskCenterStore implements TaskCenterStore {
  public constructor(
    private readonly storage: Storage,
    private readonly clock: ClockLike,
  ) {}

  public async load(): Promise<TaskCenterSnapshot> {
    await this.recoverExpiredTasks();
    return Promise.resolve().then(() => {
      const database = this.read();
      return {
        tasks: database.tasks
          .map(rehydrateTask)
          .sort((left, right) =>
            right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt),
          )
          .slice(0, TASK_LIST_LIMIT)
          .map((task) => task.toSnapshot()),
        notifications: database.notifications
          .map(rehydrateNotification)
          .filter((notification) =>
            ACTIVE_NOTIFICATION_STATUSES.includes(
              notification.status as (typeof ACTIVE_NOTIFICATION_STATUSES)[number],
            ),
          )
          .sort((left, right) =>
            right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt),
          )
          .slice(0, NOTIFICATION_LIST_LIMIT)
          .map((notification) => notification.toSnapshot()),
      };
    });
  }

  public enqueueTask(input: CreateTaskInput): Promise<CreateTaskSnapshotResult> {
    return this.mutate((database) => {
      const task = unwrap(Task.create(input));
      const existingSnapshot = database.tasks.find(
        ({ idempotencyKey }) => idempotencyKey === task.idempotencyKey,
      );
      if (existingSnapshot !== undefined) {
        const existing = rehydrateTask(existingSnapshot);
        if (!existing.isSameRequestAs(task)) {
          throw new TaskEngineError({
            code: "TASK_IDEMPOTENCY_CONFLICT",
            message: "Idempotency key already belongs to a different task request.",
          });
        }
        return { task: existing.toSnapshot(), created: false };
      }
      database.tasks.push(task.toSnapshot());
      return { task: task.toSnapshot(), created: true };
    });
  }

  public startTask(
    taskId: string,
    ownerId: string,
    leaseToken: string,
    leaseExpiresAt: string,
  ): Promise<TaskSnapshot> {
    return this.transitionTask(taskId, (current) =>
      current.claim({
        ownerId,
        leaseToken,
        now: this.clock.now(),
        leaseExpiresAt,
      }),
    );
  }

  public reportTaskProgress(
    taskId: string,
    leaseToken: string,
    step: string,
    completedUnits: number,
    totalUnits: number | null,
  ): Promise<TaskSnapshot> {
    return this.transitionTask(taskId, (current) =>
      current.reportProgress({
        leaseToken,
        step,
        completedUnits,
        totalUnits,
        now: this.clock.now(),
      }),
    );
  }

  public completeTask(taskId: string, leaseToken: string): Promise<TaskSnapshot> {
    return this.transitionTask(taskId, (current) => current.complete(leaseToken, this.clock.now()));
  }

  public failTask(
    taskId: string,
    leaseToken: string,
    failureInput: TaskFailureInput,
    retryAt: string | null,
  ): Promise<TaskSnapshot> {
    const failure = unwrap(createTaskFailure(failureInput));
    return this.transitionTask(taskId, (current) =>
      current.recordFailure({
        leaseToken,
        failure,
        now: this.clock.now(),
        retryAt,
      }),
    );
  }

  public cancelTask(taskId: string): Promise<TaskSnapshot> {
    return this.transitionTask(taskId, (current) => current.requestCancellation(this.clock.now()));
  }

  public acknowledgeTaskCancellation(taskId: string, leaseToken: string): Promise<TaskSnapshot> {
    return this.transitionTask(taskId, (current) =>
      current.acknowledgeCancellation(leaseToken, this.clock.now()),
    );
  }

  public recoverExpiredTasks(): Promise<number> {
    return this.mutate((database) => {
      const now = this.clock.now();
      let recovered = 0;
      database.tasks = database.tasks.map((snapshot) => {
        if (
          snapshot.status !== "running" ||
          snapshot.lease === null ||
          Date.parse(snapshot.lease.expiresAt) > Date.parse(now)
        ) {
          return snapshot;
        }
        recovered += 1;
        return unwrap(rehydrateTask(snapshot).recoverExpiredLease(now)).toSnapshot();
      });
      return recovered;
    });
  }

  public publishNotification(input: CreateNotificationInput): Promise<NotificationSnapshot> {
    return this.mutate((database) => {
      const notification = unwrap(Notification.create(input));
      const existingSnapshot = database.notifications.find(
        ({ dedupeKey }) => dedupeKey === notification.dedupeKey,
      );
      if (existingSnapshot !== undefined) {
        const existing = rehydrateNotification(existingSnapshot);
        if (!existing.isSameNotificationAs(notification)) {
          throw new TaskEngineError({
            code: "NOTIFICATION_DEDUPE_CONFLICT",
            message: "Notification dedupe key belongs to different notification semantics.",
          });
        }
        return existing.toSnapshot();
      }
      const visible = makeVisible(notification, this.clock);
      database.notifications.push(visible.toSnapshot());
      return visible.toSnapshot();
    });
  }

  public markNotificationRead(notificationId: string): Promise<NotificationSnapshot> {
    return this.mutate((database) => {
      const index = database.notifications.findIndex(
        (notification) => notification.id === notificationId,
      );
      const snapshot = database.notifications[index];
      if (snapshot === undefined) {
        throw new TaskEngineError({
          code: "NOTIFICATION_NOT_FOUND",
          message: "Notification was not found.",
        });
      }
      const next = markRead(rehydrateNotification(snapshot), this.clock);
      database.notifications[index] = next.toSnapshot();
      return next.toSnapshot();
    });
  }

  public markAllNotificationsRead(): Promise<number> {
    return this.mutate((database) => {
      let markedRead = 0;
      database.notifications = database.notifications.map((snapshot) => {
        const notification = rehydrateNotification(snapshot);
        if (
          notification.status !== "created" &&
          notification.status !== "queued" &&
          notification.status !== "visible"
        ) {
          return snapshot;
        }
        markedRead += 1;
        return markRead(notification, this.clock).toSnapshot();
      });
      return markedRead;
    });
  }

  private read(): StoredTaskCenter {
    const serialized = this.storage.getItem(DEVELOPMENT_TASK_CENTER_KEY);
    if (serialized === null) {
      return emptyTaskCenter();
    }

    try {
      const parsed: unknown = JSON.parse(serialized);
      if (!isStoredTaskCenter(parsed)) {
        throw new Error("Invalid development task center shape.");
      }
      const database = structuredClone(parsed);
      database.tasks.forEach(rehydrateTask);
      database.notifications.forEach(rehydrateNotification);
      return database;
    } catch (error: unknown) {
      if (error instanceof TaskEngineError) {
        throw error;
      }
      throw taskCenterRepositoryError(error);
    }
  }

  private write(database: StoredTaskCenter): void {
    this.storage.setItem(DEVELOPMENT_TASK_CENTER_KEY, JSON.stringify(database));
  }

  private transitionTask(
    taskId: string,
    transition: (current: Task) => ReturnType<Task["requestCancellation"]>,
  ): Promise<TaskSnapshot> {
    return this.mutate((database) => {
      const index = database.tasks.findIndex((task) => task.id === taskId);
      const snapshot = database.tasks[index];
      if (snapshot === undefined) {
        throw new TaskEngineError({
          code: "TASK_NOT_FOUND",
          message: "Task was not found.",
        });
      }
      const next = unwrap(transition(rehydrateTask(snapshot)));
      database.tasks[index] = next.toSnapshot();
      return next.toSnapshot();
    });
  }

  private mutate<Value>(operation: (database: StoredTaskCenter) => Value): Promise<Value> {
    try {
      const database = this.read();
      const value = operation(database);
      this.write(database);
      return Promise.resolve(value);
    } catch (error: unknown) {
      return Promise.reject(
        error instanceof TaskEngineError ? error : taskCenterRepositoryError(error),
      );
    }
  }
}

function markRead(notification: Notification, clock: ClockLike): Notification {
  let current = notification;
  if (current.status === "created") {
    current = unwrap(current.queue(clock.now()));
  }
  if (current.status === "queued") {
    current = unwrap(current.markVisible(clock.now()));
  }
  if (current.status === "visible") {
    current = unwrap(current.markRead(clock.now()));
  }
  if (current.status !== "read") {
    throw invalidNotificationTransition(current.status);
  }
  return current;
}

function makeVisible(notification: Notification, clock: ClockLike): Notification {
  let current = notification;
  if (current.status === "created") {
    current = unwrap(current.queue(clock.now()));
  }
  if (current.status === "queued") {
    current = unwrap(current.markVisible(clock.now()));
  }
  return current;
}

function rehydrateTask(snapshot: TaskSnapshot): Task {
  return unwrap(Task.rehydrate(snapshot));
}

function rehydrateNotification(snapshot: NotificationSnapshot): Notification {
  return unwrap(Notification.rehydrate(snapshot));
}

function unwrap<Value>(
  result:
    | {
        readonly ok: true;
        readonly value: Value;
      }
    | {
        readonly ok: false;
        readonly error: TaskEngineError;
      },
): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function emptyTaskCenter(): StoredTaskCenter {
  return {
    schemaVersion: 1,
    tasks: [],
    notifications: [],
  };
}

function isStoredTaskCenter(value: unknown): value is StoredTaskCenter {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 1 &&
    "tasks" in value &&
    Array.isArray(value.tasks) &&
    "notifications" in value &&
    Array.isArray(value.notifications)
  );
}

function invalidNotificationTransition(status: string): TaskEngineError {
  return new TaskEngineError({
    code: "NOTIFICATION_INVALID_TRANSITION",
    message: `Notification in ${status} state cannot be marked as read.`,
  });
}

function taskCenterRepositoryError(error: unknown): TaskEngineError {
  return new TaskEngineError({
    code: "TASK_REPOSITORY_ERROR",
    message: "Unable to read the local task center.",
    retryable: true,
    actions: ["RETRY", "EXPORT_DIAGNOSTICS"],
    details: {
      cause: error instanceof Error ? error.name : "UnknownTaskCenterStorageError",
    },
  });
}
