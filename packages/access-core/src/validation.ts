import { AccessCoreError } from "./errors.js";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

export function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !IDENTIFIER_PATTERN.test(normalized) ||
    normalized === "__proto__" ||
    normalized === "constructor" ||
    normalized === "prototype"
  ) {
    throw new AccessCoreError(
      "ACCESS_VALIDATION_FAILED",
      `${field} must be a bounded portable identifier.`,
    );
  }
  return normalized;
}

export function requireIsoTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new AccessCoreError("ACCESS_VALIDATION_FAILED", `${field} must be an ISO UTC timestamp.`);
  }
  return value;
}

export function uniqueSortedIdentifiers(
  values: readonly string[],
  field: string,
  maximum = 256,
): readonly string[] {
  if (values.length > maximum) {
    throw new AccessCoreError("ACCESS_VALIDATION_FAILED", `${field} exceeds its supported size.`);
  }
  const normalized = values.map((value) => requireIdentifier(value, field)).sort();
  if (new Set(normalized).size !== normalized.length) {
    throw new AccessCoreError(
      "ACCESS_VALIDATION_FAILED",
      `${field} must contain unique identifiers.`,
    );
  }
  return Object.freeze(normalized);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
