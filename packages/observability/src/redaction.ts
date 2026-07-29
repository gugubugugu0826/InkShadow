export type SafeLogPrimitive = string | number | boolean | null;
export type SafeLogValue = SafeLogPrimitive | readonly SafeLogValue[] | SafeLogObject;
export interface SafeLogObject {
  readonly [key: string]: SafeLogValue;
}

export interface RedactionOptions {
  readonly maxDepth?: number;
  readonly maxArrayItems?: number;
  readonly maxStringLength?: number;
}

const PROHIBITED_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "body",
  "chaptercontent",
  "chaptertext",
  "content",
  "cookie",
  "credential",
  "credentials",
  "filecontents",
  "manuscript",
  "manuscripttext",
  "messages",
  "password",
  "plaintext",
  "prompt",
  "rawtext",
  "recoverycode",
  "refreshtoken",
  "secret",
  "systemprompt",
  "token",
  "uploadedfile",
  "userprompt",
]);

const REDACTED_VALUE_KEYS = new Set([
  "datadirectory",
  "devicename",
  "email",
  "emailaddress",
  "filepath",
  "ip",
  "ipaddress",
  "region",
  "username",
]);

function normalizeKey(key: string): string {
  return key.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export class ProhibitedLogFieldError extends Error {
  readonly code = "OBSERVABILITY_PROHIBITED_FIELD";

  constructor(readonly fieldPath: string) {
    super(`Observability payload rejected prohibited field at "${fieldPath}".`);
    this.name = "ProhibitedLogFieldError";
  }
}

export function assertNoProhibitedLogFields(value: unknown): void {
  const visited = new WeakSet<object>();

  const visit = (current: unknown, path: string): void => {
    if (current === null || typeof current !== "object") {
      return;
    }

    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, index) => {
        visit(item, `${path}[${String(index)}]`);
      });
      return;
    }

    for (const [key, nested] of Object.entries(current as Readonly<Record<string, unknown>>)) {
      const nestedPath = path.length === 0 ? key : `${path}.${key}`;
      if (PROHIBITED_KEYS.has(normalizeKey(key))) {
        throw new ProhibitedLogFieldError(nestedPath);
      }
      visit(nested, nestedPath);
    }
  };

  visit(value, "");
}

function redactString(value: string, maxLength: number): string {
  const withoutBearerTokens = value.replaceAll(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
    "Bearer [REDACTED_CREDENTIAL]",
  );
  const withoutKeyLikeValues = withoutBearerTokens.replaceAll(
    /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED_CREDENTIAL]",
  );
  const withoutCredentialParameters = withoutKeyLikeValues.replaceAll(
    /((?:api[_-]?key|token|password|secret)=)[^&\s]+/gi,
    "$1[REDACTED_CREDENTIAL]",
  );
  const withoutEmails = withoutCredentialParameters.replaceAll(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[REDACTED_EMAIL]",
  );

  if (withoutEmails.length <= maxLength) {
    return withoutEmails;
  }
  return `${withoutEmails.slice(0, maxLength)}…[TRUNCATED]`;
}

function sanitizeUrl(value: URL): string {
  return `${value.protocol}//${value.host}${value.pathname}`;
}

export function sanitizeForLogging(value: unknown, options: RedactionOptions = {}): SafeLogValue {
  assertNoProhibitedLogFields(value);

  const maxDepth = options.maxDepth ?? 6;
  const maxArrayItems = options.maxArrayItems ?? 50;
  const maxStringLength = options.maxStringLength ?? 512;
  const visited = new WeakSet<object>();

  const sanitize = (current: unknown, depth: number): SafeLogValue => {
    if (current === null) {
      return null;
    }
    if (typeof current === "string") {
      return redactString(current, maxStringLength);
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : String(current);
    }
    if (typeof current === "boolean") {
      return current;
    }
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (typeof current === "undefined") {
      return "[UNDEFINED]";
    }
    if (typeof current === "function" || typeof current === "symbol") {
      return typeof current === "function" ? "[UNSUPPORTED_FUNCTION]" : "[UNSUPPORTED_SYMBOL]";
    }
    if (depth >= maxDepth) {
      return "[MAX_DEPTH]";
    }
    if (current instanceof Date) {
      return current.toISOString();
    }
    if (current instanceof URL) {
      return sanitizeUrl(current);
    }
    if (current instanceof Error) {
      return {
        name: current.name,
        message: redactString(current.message, maxStringLength),
      };
    }
    if (visited.has(current)) {
      return "[CIRCULAR]";
    }
    visited.add(current);

    if (Array.isArray(current)) {
      const items = current.slice(0, maxArrayItems).map((item) => sanitize(item, depth + 1));
      if (current.length > maxArrayItems) {
        items.push(`[${String(current.length - maxArrayItems)} ITEMS OMITTED]`);
      }
      return items;
    }

    const sanitized: Record<string, SafeLogValue> = {};
    for (const [key, nested] of Object.entries(current as Readonly<Record<string, unknown>>)) {
      sanitized[key] = REDACTED_VALUE_KEYS.has(normalizeKey(key))
        ? "[REDACTED]"
        : sanitize(nested, depth + 1);
    }
    return sanitized;
  };

  return sanitize(value, 0);
}
