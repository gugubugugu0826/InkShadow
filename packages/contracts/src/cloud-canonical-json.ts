import type { CloudProjectKeyPublishRequest } from "./cloud-api-schemas.js";

export function canonicalCloudJson(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Canonical cloud JSON accepts only finite numbers.");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCloudJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalCloudJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical cloud JSON accepts only JSON-compatible values.");
}

export function canonicalCloudProjectKeyPublication(
  projectId: string,
  keyVersion: number,
  request: CloudProjectKeyPublishRequest,
): string {
  return canonicalCloudJson({ projectId, keyVersion, request });
}

export async function hashCloudProjectKeyPublication(
  projectId: string,
  keyVersion: number,
  request: CloudProjectKeyPublishRequest,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalCloudProjectKeyPublication(projectId, keyVersion, request),
  );
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  try {
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    bytes.fill(0);
    digest.fill(0);
  }
}
