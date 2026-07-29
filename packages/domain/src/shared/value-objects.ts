import { AppError } from "./app-error.js";
import { err, ok, type Result } from "./result.js";

declare const uuidV7Brand: unique symbol;
declare const isoUtcTimestampBrand: unique symbol;
declare const contentChecksumBrand: unique symbol;

export type UuidV7 = string & { readonly [uuidV7Brand]: "UuidV7" };
export type IsoUtcTimestamp = string & {
  readonly [isoUtcTimestampBrand]: "IsoUtcTimestamp";
};
export type ContentChecksum = string & {
  readonly [contentChecksumBrand]: "ContentChecksum";
};

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function parseUuidV7(value: string): Result<UuidV7, AppError> {
  if (!UUID_V7_PATTERN.test(value)) {
    return err(
      new AppError({
        code: "INVALID_UUID",
        message: "Identifier must be a valid UUIDv7.",
        details: { value },
      }),
    );
  }

  return ok(value.toLowerCase() as UuidV7);
}

export function parseIsoUtcTimestamp(value: string): Result<IsoUtcTimestamp, AppError> {
  const parsed = Date.parse(value);
  if (!value.endsWith("Z") || Number.isNaN(parsed)) {
    return err(
      new AppError({
        code: "INVALID_TIMESTAMP",
        message: "Timestamp must be a valid ISO 8601 UTC value.",
      }),
    );
  }

  return ok(value as IsoUtcTimestamp);
}

export function parseContentChecksum(value: string): Result<ContentChecksum, AppError> {
  if (!SHA256_PATTERN.test(value)) {
    return err(
      new AppError({
        code: "INVALID_CHECKSUM",
        message: "Content checksum must be a SHA-256 hex digest.",
      }),
    );
  }

  return ok(value.toLowerCase() as ContentChecksum);
}

export function compareTimestamps(left: IsoUtcTimestamp, right: IsoUtcTimestamp): number {
  return Date.parse(left) - Date.parse(right);
}
