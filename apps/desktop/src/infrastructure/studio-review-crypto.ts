import {
  CloudReviewCiphertextEnvelopeSchema,
  UuidV7Schema,
  type CloudReviewCiphertextEnvelope,
  type CloudReviewThreadItemType,
} from "@inkshadow/contracts";
import { z } from "zod";

export const STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION = 1;

const MAX_REVIEW_PLAINTEXT_BYTES = 256 * 1024;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const POSITIVE_PORTABLE_INTEGER = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const PROJECT_KEY_VERSION = z.number().int().positive().max(2_147_483_647);
const REVIEW_BODY = z
  .string()
  .trim()
  .min(1)
  .max(64 * 1024);

export const StudioReviewSourceBindingSchema = z
  .object({
    sourceVersionId: UuidV7Schema,
    sourceVersionRevision: POSITIVE_PORTABLE_INTEGER,
    sourceCiphertextSha256: z.string().regex(SHA256_HEX_PATTERN),
  })
  .strict();

export const StudioReviewTextAnchorSchema = z
  .object({
    chapterId: UuidV7Schema,
    startUtf16: z.number().int().min(0).max(100_000_000),
    endUtf16: z.number().int().min(0).max(100_000_000),
    selectedTextSha256: z.string().regex(SHA256_HEX_PATTERN),
  })
  .strict()
  .superRefine((anchor, context) => {
    if (anchor.endUtf16 <= anchor.startUtf16) {
      context.addIssue({
        code: "custom",
        message: "Review anchor end must be greater than its start.",
        path: ["endUtf16"],
      });
    }
  });

export const StudioReviewSuggestionCandidateSchema = z
  .object({
    candidateId: UuidV7Schema,
    baseSourceVersionId: UuidV7Schema,
    baseSourceVersionRevision: POSITIVE_PORTABLE_INTEGER,
    baseSourceCiphertextSha256: z.string().regex(SHA256_HEX_PATTERN),
    replacement: z
      .object({
        chapterId: UuidV7Schema,
        startUtf16: z.number().int().min(0).max(100_000_000),
        endUtf16: z.number().int().min(0).max(100_000_000),
        text: z
          .string()
          .min(1)
          .max(128 * 1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.replacement.endUtf16 <= candidate.replacement.startUtf16) {
      context.addIssue({
        code: "custom",
        message: "Suggestion replacement end must be greater than its start.",
        path: ["replacement", "endUtf16"],
      });
    }
  });

export const StudioReviewSubmissionPayloadSchema = z
  .object({
    schemaVersion: z.literal(STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION),
    kind: z.literal("submission"),
    title: z.string().trim().min(1).max(200),
    note: z.string().max(16 * 1024),
    source: StudioReviewSourceBindingSchema,
  })
  .strict();

const StudioReviewOrdinaryItemPayloadSchema = z
  .object({
    schemaVersion: z.literal(STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION),
    kind: z.enum(["comment", "question", "rewrite_request", "reply"]),
    body: REVIEW_BODY,
    source: StudioReviewSourceBindingSchema,
    anchor: StudioReviewTextAnchorSchema.nullable(),
  })
  .strict();

export const StudioReviewSuggestionPayloadSchema = z
  .object({
    schemaVersion: z.literal(STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION),
    kind: z.literal("suggestion"),
    body: REVIEW_BODY,
    source: StudioReviewSourceBindingSchema,
    anchor: StudioReviewTextAnchorSchema,
    candidate: StudioReviewSuggestionCandidateSchema,
  })
  .strict()
  .superRefine((payload, context) => {
    if (
      payload.candidate.baseSourceVersionId !== payload.source.sourceVersionId ||
      payload.candidate.baseSourceVersionRevision !== payload.source.sourceVersionRevision ||
      payload.candidate.baseSourceCiphertextSha256 !== payload.source.sourceCiphertextSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Suggestion candidate base must equal the encrypted review source.",
        path: ["candidate"],
      });
    }
    if (
      payload.candidate.replacement.chapterId !== payload.anchor.chapterId ||
      payload.candidate.replacement.startUtf16 !== payload.anchor.startUtf16 ||
      payload.candidate.replacement.endUtf16 !== payload.anchor.endUtf16
    ) {
      context.addIssue({
        code: "custom",
        message: "Suggestion replacement must equal its reviewed text anchor.",
        path: ["candidate", "replacement"],
      });
    }
  });

export const StudioReviewThreadItemPayloadSchema = z.union([
  StudioReviewOrdinaryItemPayloadSchema,
  StudioReviewSuggestionPayloadSchema,
]);

export const StudioReviewPlaintextPayloadSchema = z.union([
  StudioReviewSubmissionPayloadSchema,
  StudioReviewThreadItemPayloadSchema,
]);

export const StudioReviewAadSchema = z
  .object({
    schemaVersion: z.literal(STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION),
    purpose: z.literal("inkshadow.studio.review"),
    payloadKind: z.enum([
      "submission",
      "comment",
      "suggestion",
      "question",
      "rewrite_request",
      "reply",
    ]),
    tenantId: UuidV7Schema,
    teamId: UuidV7Schema,
    projectId: UuidV7Schema,
    reviewId: UuidV7Schema,
    threadId: UuidV7Schema.nullable(),
    itemId: UuidV7Schema.nullable(),
    parentItemId: UuidV7Schema.nullable(),
    sourceVersionId: UuidV7Schema,
    sourceVersionRevision: POSITIVE_PORTABLE_INTEGER,
    sourceCiphertextSha256: z.string().regex(SHA256_HEX_PATTERN),
    projectKeyVersion: PROJECT_KEY_VERSION,
  })
  .strict()
  .superRefine((aad, context) => {
    const submission = aad.payloadKind === "submission";
    if (
      submission !== (aad.threadId === null) ||
      submission !== (aad.itemId === null) ||
      (submission && aad.parentItemId !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Submission and thread-item AAD identifiers are inconsistent.",
        path: ["payloadKind"],
      });
    }
    if (aad.payloadKind !== "reply" && aad.parentItemId !== null) {
      context.addIssue({
        code: "custom",
        message: "Only reply AAD may bind a parent item.",
        path: ["parentItemId"],
      });
    }
    if (aad.payloadKind === "reply" && aad.parentItemId === null) {
      context.addIssue({
        code: "custom",
        message: "Reply AAD must bind a parent item.",
        path: ["parentItemId"],
      });
    }
  });

export type StudioReviewSourceBinding = z.infer<typeof StudioReviewSourceBindingSchema>;
export type StudioReviewTextAnchor = z.infer<typeof StudioReviewTextAnchorSchema>;
export type StudioReviewSuggestionCandidate = z.infer<typeof StudioReviewSuggestionCandidateSchema>;
export type StudioReviewSubmissionPayload = z.infer<typeof StudioReviewSubmissionPayloadSchema>;
export type StudioReviewThreadItemPayload = z.infer<typeof StudioReviewThreadItemPayloadSchema>;
export type StudioReviewSuggestionPayload = z.infer<typeof StudioReviewSuggestionPayloadSchema>;
export type StudioReviewPlaintextPayload = z.infer<typeof StudioReviewPlaintextPayloadSchema>;
export type StudioReviewAad = z.infer<typeof StudioReviewAadSchema>;

export interface OpenedStudioReviewProjectKey {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly key: CryptoKey;
}

export type StudioReviewCryptoErrorCode =
  | "REVIEW_CRYPTO_ABORTED"
  | "REVIEW_CRYPTO_KEY_INVALID"
  | "REVIEW_CRYPTO_SCOPE_INVALID"
  | "REVIEW_CIPHERTEXT_CORRUPT"
  | "REVIEW_CIPHERTEXT_HASH_MISMATCH"
  | "REVIEW_PAYLOAD_INVALID"
  | "REVIEW_PAYLOAD_TOO_LARGE";

export class StudioReviewCryptoError extends Error {
  public constructor(
    public readonly code: StudioReviewCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioReviewCryptoError";
  }
}

/**
 * Encrypts and decrypts Studio review payloads without exporting project keys.
 *
 * AAD is canonical JSON and binds every payload to its exact tenant, team,
 * project, review, thread/item, source version, source ciphertext digest and
 * project-key version. Plaintext byte buffers are scrubbed on every path.
 */
export class StudioReviewCrypto {
  public constructor(private readonly cryptoProvider: Crypto = globalThis.crypto) {}

  public async encrypt(
    payloadValue: StudioReviewPlaintextPayload,
    aadValue: StudioReviewAad,
    openedKey: OpenedStudioReviewProjectKey,
    signal?: AbortSignal,
  ): Promise<CloudReviewCiphertextEnvelope> {
    throwIfAborted(signal);
    const payload = parsePayload(payloadValue);
    const aad = parseAad(aadValue);
    requirePayloadMatchesAad(payload, aad);
    requireOpenedKey(openedKey, aad, "encrypt");

    const plaintext = new TextEncoder().encode(canonicalJson(payload));
    const additionalData = new TextEncoder().encode(canonicalJson(aad));
    const nonce = new Uint8Array(12);
    this.cryptoProvider.getRandomValues(nonce);
    let ciphertext: Uint8Array | null = null;

    try {
      if (plaintext.byteLength > MAX_REVIEW_PLAINTEXT_BYTES) {
        throw new StudioReviewCryptoError(
          "REVIEW_PAYLOAD_TOO_LARGE",
          "The encrypted review payload exceeds the local safety bound.",
        );
      }
      const encrypted = await this.cryptoProvider.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
        openedKey.key,
        plaintext,
      );
      throwIfAborted(signal);
      ciphertext = new Uint8Array(encrypted);
      const envelope = {
        algorithm: "AES-256-GCM" as const,
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
        ciphertextSha256: await sha256Hex(this.cryptoProvider, ciphertext),
      };
      const parsed = CloudReviewCiphertextEnvelopeSchema.safeParse(envelope);
      if (!parsed.success) {
        throw new StudioReviewCryptoError(
          "REVIEW_PAYLOAD_TOO_LARGE",
          "The encrypted review envelope exceeds the transport safety bound.",
        );
      }
      throwIfAborted(signal);
      return Object.freeze(parsed.data);
    } catch (error: unknown) {
      if (error instanceof StudioReviewCryptoError || isAbortError(error)) {
        throw error;
      }
      throw new StudioReviewCryptoError(
        "REVIEW_CRYPTO_KEY_INVALID",
        "The project key could not encrypt this review payload.",
      );
    } finally {
      plaintext.fill(0);
      additionalData.fill(0);
      nonce.fill(0);
      ciphertext?.fill(0);
    }
  }

  public async decrypt(
    envelopeValue: CloudReviewCiphertextEnvelope,
    aadValue: StudioReviewAad,
    openedKey: OpenedStudioReviewProjectKey,
    signal?: AbortSignal,
  ): Promise<StudioReviewPlaintextPayload> {
    throwIfAborted(signal);
    const aad = parseAad(aadValue);
    requireOpenedKey(openedKey, aad, "decrypt");
    const parsedEnvelope = CloudReviewCiphertextEnvelopeSchema.safeParse(envelopeValue);
    if (!parsedEnvelope.success) {
      throw corruptCiphertext();
    }
    const nonce = decodeCanonicalBase64Url(parsedEnvelope.data.nonce);
    const ciphertext = decodeCanonicalBase64Url(parsedEnvelope.data.ciphertext);
    const additionalData = new TextEncoder().encode(canonicalJson(aad));
    let plaintext: Uint8Array | null = null;

    try {
      if (nonce.byteLength !== 12 || ciphertext.byteLength < 16) {
        throw corruptCiphertext();
      }
      const ciphertextSha256 = await sha256Hex(this.cryptoProvider, ciphertext);
      if (ciphertextSha256 !== parsedEnvelope.data.ciphertextSha256) {
        throw new StudioReviewCryptoError(
          "REVIEW_CIPHERTEXT_HASH_MISMATCH",
          "The encrypted review payload failed its ciphertext digest check.",
        );
      }
      throwIfAborted(signal);
      const decrypted = await this.cryptoProvider.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
        openedKey.key,
        ciphertext,
      );
      throwIfAborted(signal);
      plaintext = new Uint8Array(decrypted);
      if (plaintext.byteLength > MAX_REVIEW_PLAINTEXT_BYTES) {
        throw new StudioReviewCryptoError(
          "REVIEW_PAYLOAD_TOO_LARGE",
          "The decrypted review payload exceeds the local safety bound.",
        );
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
        ) as unknown;
      } catch {
        throw new StudioReviewCryptoError(
          "REVIEW_PAYLOAD_INVALID",
          "The decrypted review payload is not canonical schema-versioned JSON.",
        );
      }
      const payload = parsePayload(decoded);
      requirePayloadMatchesAad(payload, aad);
      if (canonicalJson(payload) !== new TextDecoder().decode(plaintext)) {
        throw new StudioReviewCryptoError(
          "REVIEW_PAYLOAD_INVALID",
          "The decrypted review payload is not canonically encoded.",
        );
      }
      return payload;
    } catch (error: unknown) {
      if (error instanceof StudioReviewCryptoError || isAbortError(error)) {
        throw error;
      }
      throw corruptCiphertext();
    } finally {
      nonce.fill(0);
      ciphertext.fill(0);
      additionalData.fill(0);
      plaintext?.fill(0);
    }
  }
}

export function createStudioReviewAad(input: {
  readonly payloadKind: "submission" | CloudReviewThreadItemType;
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly reviewId: string;
  readonly threadId: string | null;
  readonly itemId: string | null;
  readonly parentItemId: string | null;
  readonly source: StudioReviewSourceBinding;
  readonly projectKeyVersion: number;
}): StudioReviewAad {
  return parseAad({
    schemaVersion: STUDIO_REVIEW_PAYLOAD_SCHEMA_VERSION,
    purpose: "inkshadow.studio.review",
    payloadKind: input.payloadKind,
    tenantId: input.tenantId,
    teamId: input.teamId,
    projectId: input.projectId,
    reviewId: input.reviewId,
    threadId: input.threadId,
    itemId: input.itemId,
    parentItemId: input.parentItemId,
    sourceVersionId: input.source.sourceVersionId,
    sourceVersionRevision: input.source.sourceVersionRevision,
    sourceCiphertextSha256: input.source.sourceCiphertextSha256,
    projectKeyVersion: input.projectKeyVersion,
  });
}

function parsePayload(value: unknown): StudioReviewPlaintextPayload {
  const parsed = StudioReviewPlaintextPayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new StudioReviewCryptoError(
      "REVIEW_PAYLOAD_INVALID",
      "The review payload does not satisfy the canonical local schema.",
    );
  }
  return deepFreeze(parsed.data);
}

function parseAad(value: unknown): StudioReviewAad {
  const parsed = StudioReviewAadSchema.safeParse(value);
  if (!parsed.success) {
    throw new StudioReviewCryptoError(
      "REVIEW_CRYPTO_SCOPE_INVALID",
      "The review encryption scope is incomplete or inconsistent.",
    );
  }
  return Object.freeze(parsed.data);
}

function requirePayloadMatchesAad(
  payload: StudioReviewPlaintextPayload,
  aad: StudioReviewAad,
): void {
  if (
    payload.kind !== aad.payloadKind ||
    payload.source.sourceVersionId !== aad.sourceVersionId ||
    payload.source.sourceVersionRevision !== aad.sourceVersionRevision ||
    payload.source.sourceCiphertextSha256 !== aad.sourceCiphertextSha256
  ) {
    throw new StudioReviewCryptoError(
      "REVIEW_CRYPTO_SCOPE_INVALID",
      "The review payload does not match its authenticated source scope.",
    );
  }
}

function requireOpenedKey(
  openedKey: OpenedStudioReviewProjectKey,
  aad: StudioReviewAad,
  usage: "decrypt" | "encrypt",
): void {
  if (
    openedKey.projectId !== aad.projectId ||
    openedKey.keyVersion !== aad.projectKeyVersion ||
    !isNonExtractableAes256GcmKey(openedKey.key, usage)
  ) {
    throw new StudioReviewCryptoError(
      "REVIEW_CRYPTO_KEY_INVALID",
      "Review encryption requires the exact non-exportable AES-256-GCM project key.",
    );
  }
}

function isNonExtractableAes256GcmKey(
  value: unknown,
  usage: "decrypt" | "encrypt",
): value is CryptoKey {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const key = value as Record<string, unknown>;
  if (
    key.type !== "secret" ||
    key.extractable !== false ||
    !Array.isArray(key.usages) ||
    !(key.usages as unknown[]).includes(usage)
  ) {
    return false;
  }
  if (typeof key.algorithm !== "object" || key.algorithm === null) {
    return false;
  }
  const algorithm = key.algorithm as Record<string, unknown>;
  return algorithm.name === "AES-GCM" && algorithm.length === 256;
}

async function sha256Hex(cryptoProvider: Crypto, value: Uint8Array): Promise<string> {
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  try {
    const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", owned));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    owned.fill(0);
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCanonicalBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_PATTERN.test(value)) {
    throw corruptCiphertext();
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = globalThis.atob(padded);
  } catch {
    throw corruptCiphertext();
  }
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.codePointAt(index) ?? 0;
  }
  if (encodeBase64Url(decoded) !== value) {
    decoded.fill(0);
    throw corruptCiphertext();
  }
  return decoded;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new StudioReviewCryptoError(
        "REVIEW_PAYLOAD_INVALID",
        "Review canonical JSON contains an invalid number.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new StudioReviewCryptoError(
    "REVIEW_PAYLOAD_INVALID",
    "Review canonical JSON contains an unsupported value.",
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function corruptCiphertext(): StudioReviewCryptoError {
  return new StudioReviewCryptoError(
    "REVIEW_CIPHERTEXT_CORRUPT",
    "The encrypted review payload could not be authenticated.",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The Studio review operation was cancelled.", "AbortError");
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}
