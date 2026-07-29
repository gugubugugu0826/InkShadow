import { createHash } from "node:crypto";

import { canonicalCloudJson } from "@inkshadow/contracts";

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalCloudJson(value), "utf8").digest("hex");
}

export function hashUtf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createIdempotencyScopeHash(options: {
  readonly actorAccountId: string | null;
  readonly idempotencyKey: string;
  readonly operationId: string;
}): string {
  return hashCanonicalJson({
    actorAccountId: options.actorAccountId ?? "anonymous",
    idempotencyKeyHashSha256: hashUtf8(options.idempotencyKey),
    operationId: options.operationId,
  });
}
