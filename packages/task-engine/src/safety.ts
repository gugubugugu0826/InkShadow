import { TaskEngineError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export type MetadataPrimitive = string | number | boolean | null;
export type MetadataValue = MetadataPrimitive | readonly MetadataPrimitive[];
export type SafeMetadata = Readonly<Record<string, MetadataValue>>;

const MAX_METADATA_KEYS = 64;
const MAX_METADATA_BYTES = 8_192;
const MAX_ARRAY_ITEMS = 32;
const MAX_STRING_LENGTH = 256;
const SAFE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_STRING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,255}$/u;

const PROHIBITED_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "body",
  "chaptercontent",
  "chaptertext",
  "content",
  "credential",
  "credentials",
  "filecontents",
  "manuscript",
  "manuscripttext",
  "messages",
  "password",
  "payload",
  "plaintext",
  "prompt",
  "rawtext",
  "recoverycode",
  "refreshtoken",
  "requestbody",
  "responsebody",
  "secret",
  "systemprompt",
  "text",
  "token",
  "uploadedfile",
  "userprompt",
]);

const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+\S+/iu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/iu,
] as const;

const PROHIBITED_KEY_WORDS = new Set([
  "body",
  "content",
  "credential",
  "credentials",
  "filecontents",
  "manuscript",
  "message",
  "messages",
  "password",
  "payload",
  "plaintext",
  "prompt",
  "rawtext",
  "recoverycode",
  "secret",
  "text",
  "token",
]);

export function createSafeMetadata(value: unknown): Result<SafeMetadata, TaskEngineError> {
  if (!isPlainObject(value)) {
    return invalidMetadata();
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_KEYS) {
    return invalidMetadata();
  }

  const safe: Record<string, MetadataValue> = {};
  for (const [key, candidate] of entries) {
    if (!SAFE_KEY_PATTERN.test(key) || isProhibitedKey(key)) {
      return sensitiveMetadata(key);
    }

    const parsed = parseMetadataValue(candidate, key);
    if (!parsed.ok) {
      return parsed;
    }
    safe[key] = parsed.value;
  }

  if (new TextEncoder().encode(JSON.stringify(safe)).length > MAX_METADATA_BYTES) {
    return invalidMetadata();
  }
  return ok(Object.freeze(safe));
}

export function cloneSafeMetadata(metadata: SafeMetadata): SafeMetadata {
  const clone: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    clone[key] = isMetadataArray(value) ? Object.freeze(Array.from(value)) : value;
  }
  return Object.freeze(clone);
}

export function safeMetadataEquals(left: SafeMetadata, right: SafeMetadata): boolean {
  return canonicalMetadata(left) === canonicalMetadata(right);
}

function canonicalMetadata(metadata: SafeMetadata): string {
  const ordered: Record<string, MetadataValue> = {};
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }
  return JSON.stringify(ordered);
}

function isMetadataArray(value: MetadataValue): value is readonly MetadataPrimitive[] {
  return Array.isArray(value);
}

function parseMetadataValue(value: unknown, key: string): Result<MetadataValue, TaskEngineError> {
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      return invalidMetadata();
    }
    const parsedItems: MetadataPrimitive[] = [];
    for (const item of value) {
      const parsed = parsePrimitive(item, key);
      if (!parsed.ok) {
        return parsed;
      }
      parsedItems.push(parsed.value);
    }
    return ok(Object.freeze(parsedItems));
  }
  return parsePrimitive(value, key);
}

function parsePrimitive(value: unknown, key: string): Result<MetadataPrimitive, TaskEngineError> {
  if (value === null || typeof value === "boolean") {
    return ok(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? ok(value) : invalidMetadata();
  }
  if (typeof value !== "string") {
    return invalidMetadata();
  }
  if (
    value.length > MAX_STRING_LENGTH ||
    !SAFE_STRING_PATTERN.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    return sensitiveMetadata(key);
  }
  return ok(value);
}

function normalizeKey(key: string): string {
  return key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isProhibitedKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (PROHIBITED_KEYS.has(normalized)) {
    return true;
  }
  const words = key
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  return words.some((word) => PROHIBITED_KEY_WORDS.has(word));
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function invalidMetadata(): Result<never, TaskEngineError> {
  return err(
    new TaskEngineError({
      code: "TASK_VALIDATION_FAILED",
      message: "Task metadata must use the bounded safe metadata contract.",
    }),
  );
}

function sensitiveMetadata(field: string): Result<never, TaskEngineError> {
  return err(
    new TaskEngineError({
      code: "TASK_SENSITIVE_DATA_REJECTED",
      message: "Sensitive or user-authored content is forbidden in metadata.",
      details: { field },
    }),
  );
}
