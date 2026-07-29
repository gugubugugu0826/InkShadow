import type { TaskEngineError } from "./errors.js";
import type { Notification } from "./notification.js";
import type { Result } from "./result.js";
import type { Task } from "./task.js";
import type { IsoUtcTimestamp, NotificationDedupeKey, UuidV7, WorkerId } from "./value-objects.js";

export interface CreateTaskResult {
  readonly task: Task;
  readonly created: boolean;
}

export interface ClaimNextTaskCommand {
  readonly ownerId: WorkerId;
  readonly leaseToken: UuidV7;
  readonly now: IsoUtcTimestamp;
  readonly leaseExpiresAt: IsoUtcTimestamp;
}

export interface TaskRepository {
  /**
   * Atomically inserts by idempotency key or returns the existing task.
   * A reused key with a different request must return TASK_IDEMPOTENCY_CONFLICT.
   */
  createIfAbsent(task: Task): Promise<Result<CreateTaskResult, TaskEngineError>>;

  findById(id: UuidV7): Promise<Result<Task | null, TaskEngineError>>;

  /**
   * Atomically selects one eligible queued/waiting_retry task, acquires its
   * lease, increments sequence, persists it, and returns the claimed entity.
   */
  claimNext(command: ClaimNextTaskCommand): Promise<Result<Task | null, TaskEngineError>>;

  /**
   * Compare-and-swap persistence. Implementations must update only when the
   * stored sequence equals expectedSequence.
   */
  save(task: Task, expectedSequence: number): Promise<Result<void, TaskEngineError>>;

  listExpiredLeases(
    now: IsoUtcTimestamp,
    limit: number,
  ): Promise<Result<readonly Task[], TaskEngineError>>;
}

export interface CreateNotificationResult {
  readonly notification: Notification;
  readonly created: boolean;
}

export interface NotificationRepository {
  /**
   * Atomically inserts by dedupe key or returns the existing notification.
   * A reused key with different semantics must return
   * NOTIFICATION_DEDUPE_CONFLICT.
   */
  createIfAbsent(
    notification: Notification,
  ): Promise<Result<CreateNotificationResult, TaskEngineError>>;

  findById(id: UuidV7): Promise<Result<Notification | null, TaskEngineError>>;

  findByDedupeKey(
    dedupeKey: NotificationDedupeKey,
  ): Promise<Result<Notification | null, TaskEngineError>>;

  save(
    notification: Notification,
    expectedSequence: number,
  ): Promise<Result<void, TaskEngineError>>;

  listDueForExpiration(
    now: IsoUtcTimestamp,
    limit: number,
  ): Promise<Result<readonly Notification[], TaskEngineError>>;
}

export const TASK_LOG_EVENT_TYPES = [
  "task.enqueued",
  "task.deduplicated",
  "task.claimed",
  "task.lease_renewed",
  "task.progressed",
  "task.retry_scheduled",
  "task.succeeded",
  "task.failed",
  "task.cancel_requested",
  "task.cancelled",
  "task.paused",
  "task.resumed",
  "task.lease_recovered",
] as const;

export type TaskLogEventType = (typeof TASK_LOG_EVENT_TYPES)[number];

/**
 * Deliberately closed log envelope: there is no metadata, message, prompt,
 * content, secret, or arbitrary details field.
 */
export interface TaskLogEvent {
  readonly event: TaskLogEventType;
  readonly taskId: UuidV7;
  readonly taskType: string;
  readonly status: string;
  readonly attempt: number;
  readonly sequence: number;
  readonly workerId: WorkerId | null;
  readonly errorCode: string | null;
  readonly at: IsoUtcTimestamp;
}

export interface TaskLogSink {
  write(event: TaskLogEvent): Promise<void>;
}
