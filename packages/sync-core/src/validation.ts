import { SyncCoreError } from "./errors.js";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !IDENTIFIER_PATTERN.test(normalized) ||
    normalized === "__proto__" ||
    normalized === "constructor" ||
    normalized === "prototype"
  ) {
    throw new SyncCoreError(
      "SYNC_VALIDATION_FAILED",
      `${field} must be a bounded portable identifier.`,
    );
  }
  return normalized;
}

export function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SyncCoreError("SYNC_VALIDATION_FAILED", `${field} must be a positive safe integer.`);
  }
  return value;
}

export function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SyncCoreError(
      "SYNC_VALIDATION_FAILED",
      `${field} must be a non-negative safe integer.`,
    );
  }
  return value;
}

export function requireIsoTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new SyncCoreError("SYNC_VALIDATION_FAILED", `${field} must be an ISO UTC timestamp.`);
  }
  return value;
}

export function requireSha256(value: string, field: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new SyncCoreError("SYNC_VALIDATION_FAILED", `${field} must be a SHA-256 hex digest.`);
  }
  return normalized;
}

export function compareBytesConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
