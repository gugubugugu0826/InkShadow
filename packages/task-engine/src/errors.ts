import { err, ok, type Result } from "./result.js";

export const TASK_ENGINE_ERROR_CODES = [
  "TASK_VALIDATION_FAILED",
  "TASK_INVALID_UUID",
  "TASK_INVALID_TIMESTAMP",
  "TASK_INVALID_IDEMPOTENCY_KEY",
  "TASK_SENSITIVE_DATA_REJECTED",
  "TASK_NOT_FOUND",
  "TASK_INVALID_TRANSITION",
  "TASK_NOT_RUNNABLE",
  "TASK_SEQUENCE_CONFLICT",
  "TASK_IDEMPOTENCY_CONFLICT",
  "TASK_LEASE_MISMATCH",
  "TASK_LEASE_EXPIRED",
  "TASK_CANCEL_REQUESTED",
  "TASK_REPOSITORY_ERROR",
  "NOTIFICATION_NOT_FOUND",
  "NOTIFICATION_INVALID_TRANSITION",
  "NOTIFICATION_SEQUENCE_CONFLICT",
  "NOTIFICATION_DEDUPE_CONFLICT",
  "NOTIFICATION_REPOSITORY_ERROR",
] as const;

export type TaskEngineErrorCode = (typeof TASK_ENGINE_ERROR_CODES)[number];

export const NEXT_STEP_ACTIONS = [
  "RETRY",
  "CANCEL_TASK",
  "RESUME_TASK",
  "OPEN_SETTINGS",
  "REAUTHENTICATE",
  "SWITCH_MODEL",
  "REDUCE_CONTEXT",
  "REQUEST_ACCESS",
  "EXPORT_DIAGNOSTICS",
  "CONTACT_SUPPORT",
] as const;

export type NextStepAction = (typeof NEXT_STEP_ACTIONS)[number];

export type SafeErrorDetails = Readonly<Record<string, string | number | boolean | null>>;

export interface TaskEngineErrorOptions {
  readonly code: TaskEngineErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly actions?: readonly NextStepAction[];
  readonly details?: SafeErrorDetails;
}

export class TaskEngineError extends Error {
  public override name = "TaskEngineError";

  public readonly code: TaskEngineErrorCode;
  public readonly retryable: boolean;
  public readonly actions: readonly NextStepAction[];
  public readonly details: SafeErrorDetails;

  public constructor(options: TaskEngineErrorOptions) {
    super(options.message);
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.actions = Object.freeze([...(options.actions ?? [])]);
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export interface TaskFailure {
  readonly code: string;
  readonly causeCode: string | null;
  readonly retryable: boolean;
  readonly actions: readonly NextStepAction[];
  readonly requestId: string;
}

export interface TaskFailureInput {
  readonly code: string;
  readonly retryable: boolean;
  readonly actions: readonly NextStepAction[];
  readonly requestId: string;
  readonly causeCode?: string | null;
}

const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{7,199}$/u;

export function createTaskFailure(input: TaskFailureInput): Result<TaskFailure, TaskEngineError> {
  if (
    !FAILURE_CODE_PATTERN.test(input.code) ||
    (input.causeCode !== undefined &&
      input.causeCode !== null &&
      !FAILURE_CODE_PATTERN.test(input.causeCode)) ||
    !REQUEST_ID_PATTERN.test(input.requestId) ||
    input.actions.length > NEXT_STEP_ACTIONS.length ||
    input.actions.some((action) => !NEXT_STEP_ACTIONS.includes(action))
  ) {
    return err(
      new TaskEngineError({
        code: "TASK_VALIDATION_FAILED",
        message: "Task failure data is not a valid safe error contract.",
      }),
    );
  }

  return ok(
    Object.freeze({
      code: input.code,
      causeCode: input.causeCode ?? null,
      retryable: input.retryable,
      actions: Object.freeze([...new Set(input.actions)]),
      requestId: input.requestId,
    }),
  );
}

export function retryExhaustedFailure(failure: TaskFailure): TaskFailure {
  return Object.freeze({
    code: "TASK_RETRY_EXHAUSTED",
    // Preserve the most specific safe cause (for example a stage mask) so a
    // later supplemental recovery can avoid repeating work that succeeded.
    causeCode: failure.causeCode ?? failure.code,
    retryable: false,
    actions: Object.freeze(failure.actions.filter((action) => action !== "RETRY")),
    requestId: failure.requestId,
  });
}
