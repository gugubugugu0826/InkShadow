export const ACCESS_ERROR_CODES = [
  "ACCESS_VALIDATION_FAILED",
  "ACCESS_LICENSE_FORMAT_INVALID",
  "ACCESS_LICENSE_SIGNATURE_INVALID",
  "ACCESS_LICENSE_KEY_UNKNOWN",
  "ACCESS_LICENSE_DEVICE_MISMATCH",
  "ACCESS_LICENSE_NOT_YET_VALID",
] as const;

export type AccessErrorCode = (typeof ACCESS_ERROR_CODES)[number];

export class AccessCoreError extends Error {
  public override readonly name = "AccessCoreError";

  public constructor(
    public readonly code: AccessErrorCode,
    message: string,
  ) {
    super(message);
  }
}
