export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const textEncoder = new TextEncoder();

export function utf8Bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8ByteLength(value: string): number {
  return utf8Bytes(value).byteLength;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON does not support non-finite numbers.");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>).sort(
      ([left], [right]) => {
        if (left < right) {
          return -1;
        }
        return left > right ? 1 : 0;
      },
    );
    const serialized = entries.map(([key, nested]) => {
      if (nested === undefined) {
        throw new Error("Canonical JSON does not support undefined values.");
      }
      return `${JSON.stringify(key)}:${canonicalJson(nested)}`;
    });
    return `{${serialized.join(",")}}`;
  }

  throw new Error(`Canonical JSON does not support values of type ${typeof value}.`);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? utf8Bytes(input) : input;
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function checksumEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
