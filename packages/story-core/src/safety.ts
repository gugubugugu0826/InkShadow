import { StoryCoreError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { parseUuidV7, type UuidV7 } from "./value-objects.js";

export const MAX_EVIDENCE_EXCERPT_LENGTH = 320;
export const MAX_FORMAL_STRING_LENGTH = 4_000;
export const MAX_MEMORY_TEXT_LENGTH = 1_000;
export const MAX_OUTLINE_TEXT_LENGTH = 4_000;

export type StoryPrimitive = string | number | boolean | null;
export type StoryValue =
  StoryPrimitive | readonly StoryValue[] | Readonly<{ readonly [key: string]: StoryValue }>;

export interface EvidenceRange {
  readonly start: number;
  readonly end: number;
  readonly sourceLength: number;
}

export interface Evidence {
  readonly excerpt: string;
  readonly range: EvidenceRange;
}

const MAX_STORY_VALUE_BYTES = 16_384;
const MAX_STORY_VALUE_DEPTH = 5;
const MAX_COLLECTION_ITEMS = 128;
const SAFE_OBJECT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SECRET_PATTERNS = [
  /\bBearer\s+\S+/iu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|client[_-]?secret|password|private[_-]?key|recovery[_-]?code|secret|token)\s*[:=]\s*\S+/iu,
] as const;
const SECRET_KEY_WORDS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "authtoken",
  "authorization",
  "clientsecret",
  "credential",
  "credentials",
  "encryptionkey",
  "key",
  "password",
  "privatekey",
  "recoverycode",
  "refreshtoken",
  "secret",
  "signingkey",
  "token",
]);

export function createEvidence(input: {
  readonly excerpt: string;
  readonly start: number;
  readonly end: number;
  readonly sourceLength: number;
}): Result<Evidence, StoryCoreError> {
  if (typeof input.excerpt !== "string") {
    return validationError("Evidence excerpt must be text.");
  }
  if (input.excerpt.length === 0 || input.excerpt.length > MAX_EVIDENCE_EXCERPT_LENGTH) {
    return err(
      new StoryCoreError({
        code: "STORY_EVIDENCE_TOO_LONG",
        message: "Evidence must be a short, non-empty excerpt.",
        actions: ["REVIEW_EVIDENCE"],
      }),
    );
  }
  if (
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.end) ||
    !Number.isSafeInteger(input.sourceLength) ||
    input.start < 0 ||
    input.end <= input.start ||
    input.end > input.sourceLength ||
    input.end - input.start !== input.excerpt.length ||
    input.excerpt.length >= input.sourceLength
  ) {
    return err(
      new StoryCoreError({
        code: "STORY_EVIDENCE_RANGE_INVALID",
        message: "Evidence range must exactly identify a strict excerpt of its source.",
        actions: ["REVIEW_EVIDENCE", "OPEN_SOURCE"],
      }),
    );
  }
  if (
    input.excerpt.includes("\u0000") ||
    SECRET_PATTERNS.some((pattern) => pattern.test(input.excerpt))
  ) {
    return sensitiveDataError();
  }
  return ok(
    Object.freeze({
      excerpt: input.excerpt,
      range: Object.freeze({
        start: input.start,
        end: input.end,
        sourceLength: input.sourceLength,
      }),
    }),
  );
}

export function createStoryValue(value: unknown): Result<StoryValue, StoryCoreError> {
  const visited = new WeakSet<object>();
  const parsed = parseStoryValue(value, 0, visited);
  if (!parsed.ok) {
    return parsed;
  }
  if (new TextEncoder().encode(JSON.stringify(parsed.value)).length > MAX_STORY_VALUE_BYTES) {
    return validationError("Formal story value exceeds its storage limit.");
  }
  return parsed;
}

export function storyValuesEqual(left: StoryValue, right: StoryValue): boolean {
  return canonicalStoryValue(left) === canonicalStoryValue(right);
}

export function cloneStoryValue(value: StoryValue): StoryValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneStoryValue));
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, StoryValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = cloneStoryValue(nested);
    }
    return Object.freeze(clone);
  }
  return value;
}

export function validateBoundedText(
  value: string,
  maximumLength: number,
  field: string,
): Result<string, StoryCoreError> {
  if (typeof value !== "string" || !Number.isSafeInteger(maximumLength) || maximumLength < 1) {
    return validationError(`${field} must be bounded text.`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    normalized.includes("\u0000")
  ) {
    return validationError(`${field} exceeds its bounded text contract.`);
  }
  if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return sensitiveDataError();
  }
  return ok(normalized);
}

export function validateSourceIds(input: {
  readonly sourceChapterId: string;
  readonly sourceVersionId: string;
}): Result<
  Readonly<{
    sourceChapterId: UuidV7;
    sourceVersionId: UuidV7;
  }>,
  StoryCoreError
> {
  const chapterId = parseUuidV7(input.sourceChapterId);
  if (!chapterId.ok) {
    return chapterId;
  }
  const versionId = parseUuidV7(input.sourceVersionId);
  if (!versionId.ok) {
    return versionId;
  }
  return ok({
    sourceChapterId: chapterId.value,
    sourceVersionId: versionId.value,
  });
}

function parseStoryValue(
  value: unknown,
  depth: number,
  visited: WeakSet<object>,
): Result<StoryValue, StoryCoreError> {
  if (depth > MAX_STORY_VALUE_DEPTH) {
    return validationError("Formal story value nesting is too deep.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return ok(value);
  }
  if (typeof value === "string") {
    if (value.length > MAX_FORMAL_STRING_LENGTH || value.includes("\u0000")) {
      return validationError("Formal story text is too long.");
    }
    return SECRET_PATTERNS.some((pattern) => pattern.test(value))
      ? sensitiveDataError()
      : ok(value);
  }
  if (typeof value !== "object") {
    return validationError("Formal story value must be JSON-compatible.");
  }
  if (visited.has(value)) {
    return validationError("Formal story value cannot be circular.");
  }
  visited.add(value);

  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) {
      return validationError("Formal story array is too large.");
    }
    const items: StoryValue[] = [];
    for (const item of value) {
      const parsed = parseStoryValue(item, depth + 1, visited);
      if (!parsed.ok) {
        visited.delete(value);
        return parsed;
      }
      items.push(parsed.value);
    }
    visited.delete(value);
    return ok(Object.freeze(items));
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    visited.delete(value);
    return validationError("Formal story object must be a plain object.");
  }
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  if (entries.length > MAX_COLLECTION_ITEMS) {
    visited.delete(value);
    return validationError("Formal story object has too many fields.");
  }
  const object: Record<string, StoryValue> = {};
  for (const [key, nested] of entries) {
    if (!SAFE_OBJECT_KEY_PATTERN.test(key) || isSecretKey(key)) {
      visited.delete(value);
      return sensitiveDataError();
    }
    const parsed = parseStoryValue(nested, depth + 1, visited);
    if (!parsed.ok) {
      visited.delete(value);
      return parsed;
    }
    object[key] = parsed.value;
  }
  visited.delete(value);
  return ok(Object.freeze(object));
}

function canonicalStoryValue(value: StoryValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStoryValue).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const objectValue = value as Readonly<Record<string, StoryValue>>;
    return `{${Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStoryValue(objectValue[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isSecretKey(key: string): boolean {
  const normalized = key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
  return SECRET_KEY_WORDS.has(normalized);
}

function validationError(message: string): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_VALIDATION_FAILED",
      message,
    }),
  );
}

function sensitiveDataError(): Result<never, StoryCoreError> {
  return err(
    new StoryCoreError({
      code: "STORY_SENSITIVE_DATA_REJECTED",
      message: "Story data rejected a credential or secret value.",
      actions: ["REVIEW_EVIDENCE"],
    }),
  );
}
