import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

declare const uuidV7Brand: unique symbol;
declare const timestampBrand: unique symbol;
declare const safeIdentifierBrand: unique symbol;

export type UuidV7 = string & { readonly [uuidV7Brand]: "UuidV7" };
export type IsoUtcTimestamp = string & {
  readonly [timestampBrand]: "IsoUtcTimestamp";
};
export type SafeIdentifier = string & {
  readonly [safeIdentifierBrand]: "SafeIdentifier";
};

export interface Clock {
  now(): string;
}

export interface UuidV7Generator {
  next(): string;
}

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_.-]{0,95}$/u;

export function parseUuidV7(value: string): Result<UuidV7, StoryCoreError> {
  if (!UUID_V7_PATTERN.test(value)) {
    return err(
      new StoryCoreError({
        code: "STORY_INVALID_UUID",
        message: "Identifier must be a valid UUIDv7.",
      }),
    );
  }
  return ok(value.toLowerCase() as UuidV7);
}

export function parseIsoUtcTimestamp(value: string): Result<IsoUtcTimestamp, StoryCoreError> {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    return err(
      new StoryCoreError({
        code: "STORY_INVALID_TIMESTAMP",
        message: "Timestamp must be valid ISO 8601 UTC.",
      }),
    );
  }
  return ok(value as IsoUtcTimestamp);
}

export function parseSafeIdentifier(value: string): Result<SafeIdentifier, StoryCoreError> {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    return err(
      new StoryCoreError({
        code: "STORY_VALIDATION_FAILED",
        message: "Identifier must use a stable lowercase key.",
      }),
    );
  }
  return ok(value as SafeIdentifier);
}

export function compareTimestamps(left: IsoUtcTimestamp, right: IsoUtcTimestamp): number {
  return Date.parse(left) - Date.parse(right);
}
