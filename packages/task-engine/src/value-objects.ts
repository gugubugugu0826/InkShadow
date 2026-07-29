import { TaskEngineError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

declare const uuidV7Brand: unique symbol;
declare const isoUtcTimestampBrand: unique symbol;
declare const idempotencyKeyBrand: unique symbol;
declare const notificationDedupeKeyBrand: unique symbol;
declare const taskTypeBrand: unique symbol;
declare const workerIdBrand: unique symbol;
declare const messageKeyBrand: unique symbol;

export type UuidV7 = string & { readonly [uuidV7Brand]: "UuidV7" };
export type IsoUtcTimestamp = string & {
  readonly [isoUtcTimestampBrand]: "IsoUtcTimestamp";
};
export type IdempotencyKey = string & {
  readonly [idempotencyKeyBrand]: "IdempotencyKey";
};
export type NotificationDedupeKey = string & {
  readonly [notificationDedupeKeyBrand]: "NotificationDedupeKey";
};
export type TaskType = string & { readonly [taskTypeBrand]: "TaskType" };
export type WorkerId = string & { readonly [workerIdBrand]: "WorkerId" };
export type MessageKey = string & {
  readonly [messageKeyBrand]: "MessageKey";
};

export interface Clock {
  now(): string;
}

export interface UuidV7Generator {
  next(): string;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,199}$/u;
const TASK_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/u;

export function parseUuidV7(value: string): Result<UuidV7, TaskEngineError> {
  if (!UUID_V7_PATTERN.test(value)) {
    return err(
      new TaskEngineError({
        code: "TASK_INVALID_UUID",
        message: "Identifier must be a valid UUIDv7.",
      }),
    );
  }
  return ok(value.toLowerCase() as UuidV7);
}

export function parseIsoUtcTimestamp(value: string): Result<IsoUtcTimestamp, TaskEngineError> {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    return err(
      new TaskEngineError({
        code: "TASK_INVALID_TIMESTAMP",
        message: "Timestamp must be a valid ISO 8601 UTC value.",
      }),
    );
  }
  return ok(value as IsoUtcTimestamp);
}

export function parseIdempotencyKey(value: string): Result<IdempotencyKey, TaskEngineError> {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    return err(
      new TaskEngineError({
        code: "TASK_INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency key must be 8-200 safe, non-whitespace characters.",
      }),
    );
  }
  return ok(value as IdempotencyKey);
}

export function parseNotificationDedupeKey(
  value: string,
): Result<NotificationDedupeKey, TaskEngineError> {
  const parsed = parseIdempotencyKey(value);
  return parsed.ok ? ok(parsed.value as string as NotificationDedupeKey) : parsed;
}

export function parseTaskType(value: string): Result<TaskType, TaskEngineError> {
  if (!TASK_TYPE_PATTERN.test(value)) {
    return err(
      new TaskEngineError({
        code: "TASK_VALIDATION_FAILED",
        message: "Task type must be a stable lowercase identifier.",
      }),
    );
  }
  return ok(value as TaskType);
}

export function parseWorkerId(value: string): Result<WorkerId, TaskEngineError> {
  if (!WORKER_ID_PATTERN.test(value)) {
    return err(
      new TaskEngineError({
        code: "TASK_VALIDATION_FAILED",
        message: "Worker identifier is invalid.",
      }),
    );
  }
  return ok(value as WorkerId);
}

export function parseMessageKey(value: string): Result<MessageKey, TaskEngineError> {
  if (!MESSAGE_KEY_PATTERN.test(value)) {
    return err(
      new TaskEngineError({
        code: "TASK_VALIDATION_FAILED",
        message: "Notification message key is invalid.",
      }),
    );
  }
  return ok(value as MessageKey);
}

export function addMilliseconds(
  timestamp: IsoUtcTimestamp,
  milliseconds: number,
): Result<IsoUtcTimestamp, TaskEngineError> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return err(
      new TaskEngineError({
        code: "TASK_VALIDATION_FAILED",
        message: "Duration must be a positive safe integer.",
      }),
    );
  }
  return parseIsoUtcTimestamp(new Date(Date.parse(timestamp) + milliseconds).toISOString());
}

export function compareTimestamps(left: IsoUtcTimestamp, right: IsoUtcTimestamp): number {
  return Date.parse(left) - Date.parse(right);
}
