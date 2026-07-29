export const APP_ERROR_CODES = [
  "VALIDATION_FAILED",
  "INVALID_UUID",
  "INVALID_TIMESTAMP",
  "INVALID_CHECKSUM",
  "INVALID_STATE_TRANSITION",
  "PROJECT_NOT_FOUND",
  "PROJECT_DELETED",
  "PROJECT_ARCHIVED",
  "PROJECT_NAME_CONFLICT",
  "PROJECT_RETENTION_EXPIRED",
  "CHAPTER_NOT_FOUND",
  "CHAPTER_DELETED",
  "VERSION_CONFLICT",
  "BASE_VERSION_CHANGED",
  "RECOVERY_DRAFT_NOT_FOUND",
  "CANDIDATE_NOT_FOUND",
  "CANDIDATE_NOT_READY",
  "CANDIDATE_ALREADY_DECIDED",
  "CANDIDATE_TARGET_MISSING",
  "READONLY_RESOURCE",
  "SAVE_FAILED",
  "REPOSITORY_ERROR",
  "NO_CHANGES",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export const ERROR_ACTIONS = [
  "RETRY",
  "RENAME",
  "USE_LOCAL",
  "EXPORT_DRAFT",
  "RESTORE",
  "OPEN_SETTINGS",
  "SWITCH_MODEL",
  "REDUCE_CONTEXT",
  "RESOLVE_CONFLICT",
  "REQUEST_ACCESS",
  "REAUTHENTICATE",
  "UPGRADE_CLIENT",
  "CONTACT_SUPPORT",
] as const;

export type ErrorAction = (typeof ERROR_ACTIONS)[number];

export interface AppErrorOptions {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly retryable?: boolean;
  readonly actions?: readonly ErrorAction[];
  readonly details?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  override name = "AppError";

  readonly code: AppErrorCode;
  readonly retryable: boolean;
  readonly actions: readonly ErrorAction[];
  readonly details: Readonly<Record<string, unknown>>;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.actions = Object.freeze([...(options.actions ?? [])]);
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}
