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
  type RetryTaskNowInput,
  type TaskFailureInput,
  type TaskSnapshot,
} from "@inkshadow/task-engine";

export const DEVELOPMENT_TASK_CENTER_KEY = "inkshadow.development.task-center.v1";

const TASK_LIST_LIMIT = 200;
const NOTIFICATION_LIST_LIMIT = 200;
const MAX_DUE_TASK_QUERY_LIMIT = 500;
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
  readonly hasReadNotifications: boolean;
}

export interface CreateTaskSnapshotResult {
  readonly task: TaskSnapshot;
  readonly created: boolean;
}

export interface DueTaskQuery {
  readonly taskType: string;
  readonly metadataOperation: string;
  readonly now: string;
  readonly queuedUpdatedAtOrBefore: string;
  readonly after: DueTaskCursor | null;
  readonly limit: number;
}

export interface DueTaskCursor {
  readonly runAfter: string;
  readonly createdAt: string;
  readonly id: string;
}

export interface TaskCenterStore {
  load(): Promise<TaskCenterSnapshot>;
  /** Read-only lookup used by idempotent planning before any task is registered. */
  findTaskByIdempotencyKey(idempotencyKey: string): Promise<TaskSnapshot | null>;
  /**
   * Loads one oldest-first bounded batch for a specific worker. This is kept
   * separate from load(), whose newest-first limit is intentionally a UI
   * concern and must never decide whether durable work can be recovered.
   */
  listDueTasks(input: DueTaskQuery): Promise<readonly TaskSnapshot[]>;
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
  retryTaskNow(taskId: string, recovery?: RetryTaskNowInput): Promise<TaskSnapshot>;
  cancelTask(taskId: string): Promise<TaskSnapshot>;
  acknowledgeTaskCancellation(taskId: string, leaseToken: string): Promise<TaskSnapshot>;
  recoverExpiredTasks(): Promise<number>;
  publishNotification(input: CreateNotificationInput): Promise<NotificationSnapshot>;
  markNotificationRead(notificationId: string): Promise<NotificationSnapshot>;
  markAllNotificationsRead(): Promise<number>;
  /** Hides read inbox items while preserving their durable audit rows. */
  dismissAllReadNotifications(): Promise<number>;
}

interface ClockLike {
  now(): string;
}

export interface DevelopmentTaskCenterState {
  readonly schemaVersion: 1;
  tasks: TaskSnapshot[];
  notifications: NotificationSnapshot[];
}

type StoredTaskCenter = DevelopmentTaskCenterState;

export interface BrowserDevelopmentTaskCenterPersistence {
  read(): DevelopmentTaskCenterState;
  write(database: DevelopmentTaskCenterState): void;
}

export function createDevelopmentTaskIfAbsent(
  database: DevelopmentTaskCenterState,
  input: CreateTaskInput,
): CreateTaskSnapshotResult {
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
}

export function normalizeDevelopmentTaskCenterState(value: unknown): DevelopmentTaskCenterState {
  try {
    if (!isStoredTaskCenter(value)) {
      throw new Error("Invalid development task center shape.");
    }
    const database = structuredClone(value);
    database.tasks.forEach(rehydrateTask);
    database.notifications.forEach(rehydrateNotification);
    return database;
  } catch (error: unknown) {
    if (error instanceof TaskEngineError) throw error;
    throw taskCenterRepositoryError(error);
  }
}

export function readDevelopmentTaskCenterState(storage: Storage): DevelopmentTaskCenterState {
  const serialized = storage.getItem(DEVELOPMENT_TASK_CENTER_KEY);
  if (serialized === null) {
    return emptyTaskCenter();
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return normalizeDevelopmentTaskCenterState(parsed);
  } catch (error: unknown) {
    if (error instanceof TaskEngineError) {
      throw error;
    }
    throw taskCenterRepositoryError(error);
  }
}

function browserTaskCenterStoragePersistence(
  storage: Storage,
): BrowserDevelopmentTaskCenterPersistence {
  return {
    read: () => readDevelopmentTaskCenterState(storage),
    write: (database) => {
      storage.setItem(DEVELOPMENT_TASK_CENTER_KEY, JSON.stringify(database));
    },
  };
}

function isStorage(value: Storage | BrowserDevelopmentTaskCenterPersistence): value is Storage {
  return (
    "getItem" in value &&
    typeof value.getItem === "function" &&
    "setItem" in value &&
    typeof value.setItem === "function"
  );
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
    const [taskRows, notificationRows, readNotificationRows] = await Promise.all([
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
      this.executor.select<IdRow>(
        `SELECT id
         FROM notifications
         WHERE status = 'read'
         LIMIT 1`,
      ),
    ]);

    const tasks = await Promise.all(taskRows.map(({ id }) => this.loadTask(id)));
    const notifications = await Promise.all(
      notificationRows.map(({ id }) => this.loadNotification(id)),
    );

    return {
      tasks: tasks.map((task) => task.toSnapshot()),
      notifications: notifications.map((notification) => notification.toSnapshot()),
      hasReadNotifications: readNotificationRows.length > 0,
    };
  }

  public async listDueTasks(input: DueTaskQuery): Promise<readonly TaskSnapshot[]> {
    assertDueTaskQuery(input);
    await this.recoverExpiredTasks();
    const rows = await this.executor.select<IdRow>(
      `SELECT id
       FROM background_tasks
       WHERE task_type = ?
         AND json_extract(metadata_json, '$.operation') = ?
         AND run_after <= ?
         AND (
           ? IS NULL
           OR run_after > ?
           OR (run_after = ? AND created_at > ?)
           OR (run_after = ? AND created_at = ? AND id > ?)
         )
         AND (
           (status = 'queued' AND updated_at <= ?)
           OR (
             status = 'waiting_retry'
             AND failure_retryable = 1
             AND EXISTS (
               SELECT 1
               FROM json_each(background_tasks.failure_actions_json)
               WHERE json_each.value = 'RETRY'
             )
           )
         )
       ORDER BY run_after ASC, created_at ASC, id ASC
       LIMIT ?`,
      [
        input.taskType,
        input.metadataOperation,
        input.now,
        input.after?.runAfter ?? null,
        input.after?.runAfter ?? null,
        input.after?.runAfter ?? null,
        input.after?.createdAt ?? null,
        input.after?.runAfter ?? null,
        input.after?.createdAt ?? null,
        input.after?.id ?? null,
        input.queuedUpdatedAtOrBefore,
        input.limit,
      ],
    );
    const tasks = await Promise.all(rows.map(({ id }) => this.loadTask(id)));
    return tasks.map((task) => task.toSnapshot());
  }

  public async findTaskByIdempotencyKey(idempotencyKey: string): Promise<TaskSnapshot | null> {
    const rows = await this.executor.select<IdRow>(
      `SELECT id
       FROM background_tasks
       WHERE idempotency_key = ?
       LIMIT 1`,
      [idempotencyKey],
    );
    const row = rows[0];
    return row === undefined ? null : (await this.loadTask(row.id)).toSnapshot();
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

  public async retryTaskNow(taskId: string, recovery?: RetryTaskNowInput): Promise<TaskSnapshot> {
    return this.mutateTask(taskId, (current) => current.retryNow(this.clock.now(), recovery));
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
    let markedRead = 0;
    for (;;) {
      const rows = await this.executor.select<IdRow>(
        `SELECT id
         FROM notifications
         WHERE status IN ('created', 'queued', 'visible')
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
        [NOTIFICATION_LIST_LIMIT],
      );
      if (rows.length === 0) break;
      for (const { id } of rows) {
        await this.markNotificationRead(id);
        markedRead += 1;
      }
    }
    return markedRead;
  }

  public async dismissAllReadNotifications(): Promise<number> {
    let dismissed = 0;
    for (;;) {
      const rows = await this.executor.select<IdRow>(
        `SELECT id
         FROM notifications
         WHERE status = 'read'
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`,
        [NOTIFICATION_LIST_LIMIT],
      );
      if (rows.length === 0) break;
      for (const { id } of rows) {
        const current = await this.loadNotification(id);
        await this.saveNotificationTransition(current, current.dismiss(this.clock.now()));
        dismissed += 1;
      }
    }
    return dismissed;
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
  private readonly persistence: BrowserDevelopmentTaskCenterPersistence;

  public constructor(
    storageOrPersistence: Storage | BrowserDevelopmentTaskCenterPersistence,
    private readonly clock: ClockLike,
  ) {
    this.persistence = isStorage(storageOrPersistence)
      ? browserTaskCenterStoragePersistence(storageOrPersistence)
      : storageOrPersistence;
  }

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
        hasReadNotifications: database.notifications.some(({ status }) => status === "read"),
      };
    });
  }

  public async listDueTasks(input: DueTaskQuery): Promise<readonly TaskSnapshot[]> {
    assertDueTaskQuery(input);
    await this.recoverExpiredTasks();
    return Promise.resolve().then(() =>
      this.read()
        .tasks.map(rehydrateTask)
        .map((task) => task.toSnapshot())
        .filter((task) => matchesDueTaskQuery(task, input))
        .filter((task) => input.after === null || compareTaskToCursor(task, input.after) > 0)
        .sort(compareDueTasks)
        .slice(0, input.limit),
    );
  }

  public findTaskByIdempotencyKey(idempotencyKey: string): Promise<TaskSnapshot | null> {
    return Promise.resolve().then(() => {
      const snapshot = this.read().tasks.find((task) => task.idempotencyKey === idempotencyKey);
      return snapshot === undefined ? null : rehydrateTask(snapshot).toSnapshot();
    });
  }

  public enqueueTask(input: CreateTaskInput): Promise<CreateTaskSnapshotResult> {
    return this.mutate((database) => createDevelopmentTaskIfAbsent(database, input));
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

  public retryTaskNow(taskId: string, recovery?: RetryTaskNowInput): Promise<TaskSnapshot> {
    return this.transitionTask(taskId, (current) => current.retryNow(this.clock.now(), recovery));
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

  public dismissAllReadNotifications(): Promise<number> {
    return this.mutate((database) => {
      let dismissed = 0;
      database.notifications = database.notifications.map((snapshot) => {
        const notification = rehydrateNotification(snapshot);
        if (notification.status !== "read") return snapshot;
        dismissed += 1;
        return unwrap(notification.dismiss(this.clock.now())).toSnapshot();
      });
      return dismissed;
    });
  }

  private read(): StoredTaskCenter {
    try {
      const parsed: unknown = this.persistence.read();
      return normalizeDevelopmentTaskCenterState(parsed);
    } catch (error: unknown) {
      if (error instanceof TaskEngineError) {
        throw error;
      }
      throw taskCenterRepositoryError(error);
    }
  }

  private write(database: StoredTaskCenter): void {
    this.persistence.write(database);
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

function assertDueTaskQuery(input: DueTaskQuery): void {
  if (
    input.taskType.length === 0 ||
    input.metadataOperation.length === 0 ||
    !Number.isFinite(Date.parse(input.now)) ||
    !Number.isFinite(Date.parse(input.queuedUpdatedAtOrBefore)) ||
    (input.after !== null &&
      (!Number.isFinite(Date.parse(input.after.runAfter)) ||
        !Number.isFinite(Date.parse(input.after.createdAt)) ||
        input.after.id.length === 0)) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > MAX_DUE_TASK_QUERY_LIMIT
  ) {
    throw new TaskEngineError({
      code: "TASK_REPOSITORY_ERROR",
      message: "The due task query is invalid.",
    });
  }
}

function matchesDueTaskQuery(task: TaskSnapshot, input: DueTaskQuery): boolean {
  if (
    task.type !== input.taskType ||
    task.metadata.operation !== input.metadataOperation ||
    task.runAfter === null ||
    task.runAfter > input.now
  ) {
    return false;
  }
  if (task.status === "queued") {
    return task.updatedAt <= input.queuedUpdatedAtOrBefore;
  }
  return (
    task.status === "waiting_retry" &&
    task.failure?.retryable === true &&
    task.failure.actions.includes("RETRY")
  );
}

function compareDueTasks(left: TaskSnapshot, right: TaskSnapshot): number {
  const runAfter = (left.runAfter ?? "").localeCompare(right.runAfter ?? "");
  if (runAfter !== 0) {
    return runAfter;
  }
  const createdAt = left.createdAt.localeCompare(right.createdAt);
  return createdAt !== 0 ? createdAt : left.id.localeCompare(right.id);
}

function compareTaskToCursor(task: TaskSnapshot, cursor: DueTaskCursor): number {
  const runAfter = (task.runAfter ?? "").localeCompare(cursor.runAfter);
  if (runAfter !== 0) {
    return runAfter;
  }
  const createdAt = task.createdAt.localeCompare(cursor.createdAt);
  return createdAt !== 0 ? createdAt : task.id.localeCompare(cursor.id);
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
