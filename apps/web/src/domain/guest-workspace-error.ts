export const GUEST_WORKSPACE_ERROR_CODES = [
  "WEB_CRYPTO_UNAVAILABLE",
  "WEB_STORAGE_UNAVAILABLE",
  "WEB_STORAGE_FAILED",
  "WEB_STORAGE_QUOTA_EXCEEDED",
  "WEB_PROJECT_ALREADY_EXISTS",
  "WEB_PROJECT_NOT_FOUND",
  "WEB_PROJECT_LOCKED",
  "WEB_REVISION_CONFLICT",
  "WEB_VALIDATION_FAILED",
  "WEB_RECOVERY_MATERIAL_INVALID",
  "WEB_ENVELOPE_INVALID",
  "WEB_ENVELOPE_BINDING_MISMATCH",
  "WEB_ENVELOPE_AUTHENTICATION_FAILED",
  "WEB_UNLOCK_FAILED",
] as const;

export type GuestWorkspaceErrorCode = (typeof GUEST_WORKSPACE_ERROR_CODES)[number];

export class GuestWorkspaceError extends Error {
  public override readonly name = "GuestWorkspaceError";

  public constructor(
    public readonly code: GuestWorkspaceErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
  }
}

export function toGuestWorkspaceError(
  error: unknown,
  code: GuestWorkspaceErrorCode,
  message: string,
  retryable = false,
): GuestWorkspaceError {
  return error instanceof GuestWorkspaceError
    ? error
    : new GuestWorkspaceError(code, message, retryable);
}
