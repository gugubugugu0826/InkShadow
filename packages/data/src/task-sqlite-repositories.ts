import {
  Notification,
  Task,
  TaskEngineError,
  err,
  ok,
  type ClaimNextTaskCommand,
  type CreateNotificationResult,
  type CreateTaskResult,
  type IsoUtcTimestamp,
  type NotificationDedupeKey,
  type NotificationRepository,
  type NotificationSnapshot,
  type Result,
  type TaskRepository,
  type TaskSnapshot,
  type UuidV7,
} from "@inkshadow/task-engine";

import type { SqlExecutor, SqlPrimitive, TransactionExecutor } from "./executor.js";

interface TaskDbRow {
  id: string;
  task_type: string;
  idempotency_key: string;
  metadata_json: string;
  priority: number;
  status: string;
  attempt: number;
  max_attempts: number;
  sequence: number;
  run_after: string | null;
  lease_owner_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  progress_step: string | null;
  progress_completed_units: number | null;
  progress_total_units: number | null;
  progress_updated_at: string | null;
  failure_code: string | null;
  failure_cause_code: string | null;
  failure_retryable: number | null;
  failure_actions_json: string | null;
  failure_request_id: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface NotificationDbRow {
  id: string;
  dedupe_key: string;
  message_key: string;
  level: string;
  severity: string;
  status: string;
  route_entity_type: string | null;
  route_entity_id: string | null;
  metadata_json: string;
  requires_resolution: number;
  expires_at: string | null;
  sequence: number;
  created_at: string;
  updated_at: string;
  visible_at: string | null;
  read_at: string | null;
  acted_at: string | null;
  dismissed_at: string | null;
  expired_at: string | null;
}

const TASK_COLUMNS = `
  id,
  task_type,
  idempotency_key,
  metadata_json,
  priority,
  status,
  attempt,
  max_attempts,
  sequence,
  run_after,
  lease_owner_id,
  lease_token,
  lease_expires_at,
  progress_step,
  progress_completed_units,
  progress_total_units,
  progress_updated_at,
  failure_code,
  failure_cause_code,
  failure_retryable,
  failure_actions_json,
  failure_request_id,
  cancel_requested_at,
  created_at,
  updated_at,
  started_at,
  finished_at
`;

const NOTIFICATION_COLUMNS = `
  id,
  dedupe_key,
  message_key,
  level,
  severity,
  status,
  route_entity_type,
  route_entity_id,
  metadata_json,
  requires_resolution,
  expires_at,
  sequence,
  created_at,
  updated_at,
  visible_at,
  read_at,
  acted_at,
  dismissed_at,
  expired_at
`;

export class SqliteTaskRepository implements TaskRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async createIfAbsent(task: Task): Promise<Result<CreateTaskResult, TaskEngineError>> {
    return attempt("create task", "task", async () =>
      this.executor.transaction(async (transaction) => {
        const existing = await findTaskByIdempotencyKey(transaction, task.idempotencyKey);
        if (existing !== null) {
          if (!existing.isSameRequestAs(task)) {
            throw new TaskEngineError({
              code: "TASK_IDEMPOTENCY_CONFLICT",
              message: "The task idempotency key is already bound to a different request.",
            });
          }
          return { task: existing, created: false };
        }

        await insertTask(transaction, task);
        return { task, created: true };
      }),
    );
  }

  public async findById(id: UuidV7): Promise<Result<Task | null, TaskEngineError>> {
    return attempt("read task", "task", async () => {
      const rows = await this.executor.select<TaskDbRow>(
        `SELECT ${TASK_COLUMNS}
         FROM background_tasks
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      return rows[0] === undefined ? null : rehydrateTask(rows[0]);
    });
  }

  public async claimNext(
    command: ClaimNextTaskCommand,
  ): Promise<Result<Task | null, TaskEngineError>> {
    return attempt("claim task", "task", async () =>
      this.executor.transaction(async (transaction) => {
        const rows = await transaction.select<TaskDbRow>(
          `SELECT ${TASK_COLUMNS}
           FROM background_tasks
           WHERE
             status IN ('queued', 'waiting_retry')
             AND run_after <= ?
           ORDER BY priority DESC, run_after ASC, created_at ASC, id ASC
           LIMIT 1`,
          [command.now],
        );
        const row = rows[0];
        if (row === undefined) {
          return null;
        }

        const task = rehydrateTask(row);
        const claimed = task.claim({
          ownerId: command.ownerId,
          leaseToken: command.leaseToken,
          now: command.now,
          leaseExpiresAt: command.leaseExpiresAt,
        });
        if (!claimed.ok) {
          throw claimed.error;
        }
        await updateTask(transaction, claimed.value, task.sequence);
        return claimed.value;
      }),
    );
  }

  public async save(task: Task, expectedSequence: number): Promise<Result<void, TaskEngineError>> {
    return attempt("save task", "task", async () => {
      await updateTask(this.executor, task, expectedSequence);
    });
  }

  public async listExpiredLeases(
    now: IsoUtcTimestamp,
    limit: number,
  ): Promise<Result<readonly Task[], TaskEngineError>> {
    if (!isValidLimit(limit)) {
      return err(invalidLimit());
    }
    return attempt("list expired task leases", "task", async () => {
      const rows = await this.executor.select<TaskDbRow>(
        `SELECT ${TASK_COLUMNS}
         FROM background_tasks
         WHERE status = 'running' AND lease_expires_at <= ?
         ORDER BY lease_expires_at ASC, id ASC
         LIMIT ?`,
        [now, limit],
      );
      return rows.map(rehydrateTask);
    });
  }
}

export class SqliteNotificationRepository implements NotificationRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async createIfAbsent(
    notification: Notification,
  ): Promise<Result<CreateNotificationResult, TaskEngineError>> {
    return attempt("create notification", "notification", async () =>
      this.executor.transaction(async (transaction) => {
        const existing = await findNotificationByDedupeKey(transaction, notification.dedupeKey);
        if (existing !== null) {
          if (!existing.isSameNotificationAs(notification)) {
            throw new TaskEngineError({
              code: "NOTIFICATION_DEDUPE_CONFLICT",
              message: "The notification dedupe key is already bound to a different notification.",
            });
          }
          return { notification: existing, created: false };
        }

        await insertNotification(transaction, notification);
        return { notification, created: true };
      }),
    );
  }

  public async findById(id: UuidV7): Promise<Result<Notification | null, TaskEngineError>> {
    return attempt("read notification", "notification", async () => {
      const rows = await this.executor.select<NotificationDbRow>(
        `SELECT ${NOTIFICATION_COLUMNS}
         FROM notifications
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      return rows[0] === undefined ? null : rehydrateNotification(rows[0]);
    });
  }

  public async findByDedupeKey(
    dedupeKey: NotificationDedupeKey,
  ): Promise<Result<Notification | null, TaskEngineError>> {
    return attempt("read notification", "notification", () =>
      findNotificationByDedupeKey(this.executor, dedupeKey),
    );
  }

  public async save(
    notification: Notification,
    expectedSequence: number,
  ): Promise<Result<void, TaskEngineError>> {
    return attempt("save notification", "notification", async () => {
      await updateNotification(this.executor, notification, expectedSequence);
    });
  }

  public async listDueForExpiration(
    now: IsoUtcTimestamp,
    limit: number,
  ): Promise<Result<readonly Notification[], TaskEngineError>> {
    if (!isValidLimit(limit)) {
      return err(invalidLimit());
    }
    return attempt("list notifications due for expiration", "notification", async () => {
      const rows = await this.executor.select<NotificationDbRow>(
        `SELECT ${NOTIFICATION_COLUMNS}
           FROM notifications
           WHERE
             status IN ('visible', 'read', 'dismissed')
             AND expires_at IS NOT NULL
             AND expires_at <= ?
             AND level <> 'blocking'
             AND requires_resolution = 0
           ORDER BY expires_at ASC, id ASC
           LIMIT ?`,
        [now, limit],
      );
      return rows.map(rehydrateNotification);
    });
  }
}

export interface SqliteTaskRepositories {
  readonly tasks: SqliteTaskRepository;
  readonly notifications: SqliteNotificationRepository;
}

export function createSqliteTaskRepositories(executor: SqlExecutor): SqliteTaskRepositories {
  return {
    tasks: new SqliteTaskRepository(executor),
    notifications: new SqliteNotificationRepository(executor),
  };
}

async function findTaskByIdempotencyKey(
  executor: TransactionExecutor,
  idempotencyKey: string,
): Promise<Task | null> {
  const rows = await executor.select<TaskDbRow>(
    `SELECT ${TASK_COLUMNS}
     FROM background_tasks
     WHERE idempotency_key = ?
     LIMIT 1`,
    [idempotencyKey],
  );
  return rows[0] === undefined ? null : rehydrateTask(rows[0]);
}

async function insertTask(executor: TransactionExecutor, task: Task): Promise<void> {
  const snapshot = task.toSnapshot();
  await executor.execute(
    `INSERT INTO background_tasks (
      ${TASK_COLUMNS}
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )`,
    taskValues(snapshot),
  );
}

async function updateTask(
  executor: TransactionExecutor,
  task: Task,
  expectedSequence: number,
): Promise<void> {
  const snapshot = task.toSnapshot();
  const values = taskValues(snapshot);
  const result = await executor.execute(
    `UPDATE background_tasks
     SET
       task_type = ?,
       idempotency_key = ?,
       metadata_json = ?,
       priority = ?,
       status = ?,
       attempt = ?,
       max_attempts = ?,
       sequence = ?,
       run_after = ?,
       lease_owner_id = ?,
       lease_token = ?,
       lease_expires_at = ?,
       progress_step = ?,
       progress_completed_units = ?,
       progress_total_units = ?,
       progress_updated_at = ?,
       failure_code = ?,
       failure_cause_code = ?,
       failure_retryable = ?,
       failure_actions_json = ?,
       failure_request_id = ?,
       cancel_requested_at = ?,
       created_at = ?,
       updated_at = ?,
       started_at = ?,
       finished_at = ?
     WHERE id = ? AND sequence = ?`,
    [...values.slice(1), snapshot.id, expectedSequence],
  );
  if (result.rowsAffected !== 1) {
    throw new TaskEngineError({
      code: "TASK_SEQUENCE_CONFLICT",
      message: "The task changed before it could be saved.",
      retryable: true,
      actions: ["RETRY"],
    });
  }
}

function taskValues(snapshot: TaskSnapshot): readonly SqlPrimitive[] {
  return [
    snapshot.id,
    snapshot.type,
    snapshot.idempotencyKey,
    JSON.stringify(snapshot.metadata),
    snapshot.priority,
    snapshot.status,
    snapshot.attempt,
    snapshot.maxAttempts,
    snapshot.sequence,
    snapshot.runAfter,
    snapshot.lease?.ownerId ?? null,
    snapshot.lease?.token ?? null,
    snapshot.lease?.expiresAt ?? null,
    snapshot.progress?.step ?? null,
    snapshot.progress?.completedUnits ?? null,
    snapshot.progress?.totalUnits ?? null,
    snapshot.progress?.updatedAt ?? null,
    snapshot.failure?.code ?? null,
    snapshot.failure?.causeCode ?? null,
    snapshot.failure === null ? null : snapshot.failure.retryable ? 1 : 0,
    snapshot.failure === null ? null : JSON.stringify(snapshot.failure.actions),
    snapshot.failure?.requestId ?? null,
    snapshot.cancelRequestedAt,
    snapshot.createdAt,
    snapshot.updatedAt,
    snapshot.startedAt,
    snapshot.finishedAt,
  ];
}

function rehydrateTask(row: TaskDbRow): Task {
  const restored = Task.rehydrate({
    id: row.id as TaskSnapshot["id"],
    type: row.task_type as TaskSnapshot["type"],
    idempotencyKey: row.idempotency_key as TaskSnapshot["idempotencyKey"],
    metadata: parseStoredJson(row.metadata_json, "task metadata") as TaskSnapshot["metadata"],
    priority: row.priority,
    status: row.status as TaskSnapshot["status"],
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    sequence: row.sequence,
    runAfter: row.run_after as TaskSnapshot["runAfter"],
    lease:
      row.lease_owner_id === null || row.lease_token === null || row.lease_expires_at === null
        ? null
        : {
            ownerId: row.lease_owner_id as NonNullable<TaskSnapshot["lease"]>["ownerId"],
            token: row.lease_token as NonNullable<TaskSnapshot["lease"]>["token"],
            expiresAt: row.lease_expires_at as NonNullable<TaskSnapshot["lease"]>["expiresAt"],
          },
    progress:
      row.progress_step === null ||
      row.progress_completed_units === null ||
      row.progress_updated_at === null
        ? null
        : {
            step: row.progress_step,
            completedUnits: row.progress_completed_units,
            totalUnits: row.progress_total_units,
            updatedAt: row.progress_updated_at as NonNullable<
              TaskSnapshot["progress"]
            >["updatedAt"],
          },
    failure:
      row.failure_code === null ||
      row.failure_retryable === null ||
      row.failure_actions_json === null ||
      row.failure_request_id === null
        ? null
        : {
            code: row.failure_code,
            causeCode: row.failure_cause_code,
            retryable: row.failure_retryable === 1,
            actions: parseStoredJson(
              row.failure_actions_json,
              "task failure actions",
            ) as NonNullable<TaskSnapshot["failure"]>["actions"],
            requestId: row.failure_request_id,
          },
    cancelRequestedAt: row.cancel_requested_at as TaskSnapshot["cancelRequestedAt"],
    createdAt: row.created_at as TaskSnapshot["createdAt"],
    updatedAt: row.updated_at as TaskSnapshot["updatedAt"],
    startedAt: row.started_at as TaskSnapshot["startedAt"],
    finishedAt: row.finished_at as TaskSnapshot["finishedAt"],
  });
  if (!restored.ok) {
    throw corruptStoredData("task", restored.error.code);
  }
  return restored.value;
}

async function findNotificationByDedupeKey(
  executor: TransactionExecutor,
  dedupeKey: string,
): Promise<Notification | null> {
  const rows = await executor.select<NotificationDbRow>(
    `SELECT ${NOTIFICATION_COLUMNS}
     FROM notifications
     WHERE dedupe_key = ?
     LIMIT 1`,
    [dedupeKey],
  );
  return rows[0] === undefined ? null : rehydrateNotification(rows[0]);
}

async function insertNotification(
  executor: TransactionExecutor,
  notification: Notification,
): Promise<void> {
  const snapshot = notification.toSnapshot();
  await executor.execute(
    `INSERT INTO notifications (
      ${NOTIFICATION_COLUMNS}
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    notificationValues(snapshot),
  );
}

async function updateNotification(
  executor: TransactionExecutor,
  notification: Notification,
  expectedSequence: number,
): Promise<void> {
  const snapshot = notification.toSnapshot();
  const values = notificationValues(snapshot);
  const result = await executor.execute(
    `UPDATE notifications
     SET
       dedupe_key = ?,
       message_key = ?,
       level = ?,
       severity = ?,
       status = ?,
       route_entity_type = ?,
       route_entity_id = ?,
       metadata_json = ?,
       requires_resolution = ?,
       expires_at = ?,
       sequence = ?,
       created_at = ?,
       updated_at = ?,
       visible_at = ?,
       read_at = ?,
       acted_at = ?,
       dismissed_at = ?,
       expired_at = ?
     WHERE id = ? AND sequence = ?`,
    [...values.slice(1), snapshot.id, expectedSequence],
  );
  if (result.rowsAffected !== 1) {
    throw new TaskEngineError({
      code: "NOTIFICATION_SEQUENCE_CONFLICT",
      message: "The notification changed before it could be saved.",
      retryable: true,
      actions: ["RETRY"],
    });
  }
}

function notificationValues(snapshot: NotificationSnapshot): readonly SqlPrimitive[] {
  return [
    snapshot.id,
    snapshot.dedupeKey,
    snapshot.messageKey,
    snapshot.level,
    snapshot.severity,
    snapshot.status,
    snapshot.route?.entityType ?? null,
    snapshot.route?.entityId ?? null,
    JSON.stringify(snapshot.metadata),
    snapshot.requiresResolution ? 1 : 0,
    snapshot.expiresAt,
    snapshot.sequence,
    snapshot.createdAt,
    snapshot.updatedAt,
    snapshot.visibleAt,
    snapshot.readAt,
    snapshot.actedAt,
    snapshot.dismissedAt,
    snapshot.expiredAt,
  ];
}

function rehydrateNotification(row: NotificationDbRow): Notification {
  const restored = Notification.rehydrate({
    id: row.id as NotificationSnapshot["id"],
    dedupeKey: row.dedupe_key as NotificationSnapshot["dedupeKey"],
    messageKey: row.message_key as NotificationSnapshot["messageKey"],
    level: row.level as NotificationSnapshot["level"],
    severity: row.severity as NotificationSnapshot["severity"],
    status: row.status as NotificationSnapshot["status"],
    route:
      row.route_entity_type === null || row.route_entity_id === null
        ? null
        : {
            entityType: row.route_entity_type,
            entityId: row.route_entity_id as NonNullable<NotificationSnapshot["route"]>["entityId"],
          },
    metadata: parseStoredJson(
      row.metadata_json,
      "notification metadata",
    ) as NotificationSnapshot["metadata"],
    requiresResolution: row.requires_resolution === 1,
    expiresAt: row.expires_at as NotificationSnapshot["expiresAt"],
    sequence: row.sequence,
    createdAt: row.created_at as NotificationSnapshot["createdAt"],
    updatedAt: row.updated_at as NotificationSnapshot["updatedAt"],
    visibleAt: row.visible_at as NotificationSnapshot["visibleAt"],
    readAt: row.read_at as NotificationSnapshot["readAt"],
    actedAt: row.acted_at as NotificationSnapshot["actedAt"],
    dismissedAt: row.dismissed_at as NotificationSnapshot["dismissedAt"],
    expiredAt: row.expired_at as NotificationSnapshot["expiredAt"],
  });
  if (!restored.ok) {
    throw corruptStoredData("notification", restored.error.code);
  }
  return restored.value;
}

async function attempt<Value>(
  operation: string,
  repository: "task" | "notification",
  action: () => Promise<Value>,
): Promise<Result<Value, TaskEngineError>> {
  try {
    return ok(await action());
  } catch (error: unknown) {
    if (error instanceof TaskEngineError) {
      return err(error);
    }
    return err(
      new TaskEngineError({
        code: repository === "task" ? "TASK_REPOSITORY_ERROR" : "NOTIFICATION_REPOSITORY_ERROR",
        message: `Unable to ${operation}.`,
        retryable: true,
        actions: ["RETRY", "EXPORT_DIAGNOSTICS"],
        details: {
          cause: error instanceof Error ? error.name : "UnknownDatabaseError",
        },
      }),
    );
  }
}

function parseStoredJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw corruptStoredData(field, "INVALID_JSON");
  }
}

function corruptStoredData(field: string, validationCode: string): TaskEngineError {
  return new TaskEngineError({
    code: "TASK_REPOSITORY_ERROR",
    message: "Stored local task data did not pass integrity validation.",
    actions: ["EXPORT_DIAGNOSTICS", "CONTACT_SUPPORT"],
    details: { field, validationCode },
  });
}

function isValidLimit(limit: number): boolean {
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 1_000;
}

function invalidLimit(): TaskEngineError {
  return new TaskEngineError({
    code: "TASK_VALIDATION_FAILED",
    message: "Repository list limit must be between 1 and 1000.",
  });
}
