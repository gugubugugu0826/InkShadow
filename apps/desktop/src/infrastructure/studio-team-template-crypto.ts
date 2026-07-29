import {
  CloudTeamTemplateAadSchema,
  CloudTeamTemplateCiphertextEnvelopeSchema,
  UuidV7Schema,
  type CloudTeamTemplateAad,
  type CloudTeamTemplateCiphertextEnvelope,
} from "@inkshadow/contracts";
import { z } from "zod";

export const STUDIO_TEAM_TEMPLATE_PAYLOAD_SCHEMA_VERSION = 1;

const MAX_TEMPLATE_PLAINTEXT_BYTES = 256 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const POSITIVE_PORTABLE_INTEGER = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const StudioTeamTemplateSettingSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u),
    value: z.union([z.string().max(16 * 1024), z.number(), z.boolean()]),
  })
  .strict();

const StudioTeamTemplatePromptReferenceSchema = z
  .object({
    registryId: UuidV7Schema,
    revision: POSITIVE_PORTABLE_INTEGER,
  })
  .strict();

const StudioTeamTemplatePromptRuleSchema = z
  .object({
    ruleId: UuidV7Schema,
    label: z.string().trim().min(1).max(160),
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024),
  })
  .strict();

const StudioTeamTemplateChecklistItemSchema = z
  .object({
    itemId: UuidV7Schema,
    label: z.string().trim().min(1).max(500),
    required: z.boolean(),
  })
  .strict();

export const StudioTeamTemplatePayloadSchema = z
  .object({
    schemaVersion: z.literal(STUDIO_TEAM_TEMPLATE_PAYLOAD_SCHEMA_VERSION),
    kind: z.literal("team_template"),
    title: z.string().trim().min(1).max(120),
    projectSettings: z.array(StudioTeamTemplateSettingSchema).max(64),
    promptRegistryRefs: z.array(StudioTeamTemplatePromptReferenceSchema).max(64),
    promptRules: z.array(StudioTeamTemplatePromptRuleSchema).max(64),
    reviewChecklist: z.array(StudioTeamTemplateChecklistItemSchema).max(100),
  })
  .strict()
  .superRefine((payload, context) => {
    requireUnique(
      payload.projectSettings.map((entry) => entry.key),
      "project setting",
      context,
      ["projectSettings"],
    );
    requireUnique(
      payload.promptRegistryRefs.map((entry) => entry.registryId),
      "prompt registry reference",
      context,
      ["promptRegistryRefs"],
    );
    requireUnique(
      payload.promptRules.map((entry) => entry.ruleId),
      "prompt rule",
      context,
      ["promptRules"],
    );
    requireUnique(
      payload.reviewChecklist.map((entry) => entry.itemId),
      "review checklist item",
      context,
      ["reviewChecklist"],
    );
  });

export type StudioTeamTemplatePayload = z.infer<typeof StudioTeamTemplatePayloadSchema>;

export interface OpenedStudioTeamTemplateProjectKey {
  readonly projectId: string;
  readonly keyVersion: number;
  readonly key: CryptoKey;
}

export type StudioTeamTemplateCryptoErrorCode =
  | "TEAM_TEMPLATE_CRYPTO_ABORTED"
  | "TEAM_TEMPLATE_CRYPTO_KEY_INVALID"
  | "TEAM_TEMPLATE_CRYPTO_SCOPE_INVALID"
  | "TEAM_TEMPLATE_CIPHERTEXT_CORRUPT"
  | "TEAM_TEMPLATE_CIPHERTEXT_HASH_MISMATCH"
  | "TEAM_TEMPLATE_PAYLOAD_INVALID"
  | "TEAM_TEMPLATE_PAYLOAD_TOO_LARGE";

export class StudioTeamTemplateCryptoError extends Error {
  public constructor(
    public readonly code: StudioTeamTemplateCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioTeamTemplateCryptoError";
  }
}

/**
 * Real local WebCrypto boundary for project-DEK encrypted team templates.
 * Project keys must be non-extractable AES-256-GCM CryptoKeys and are never
 * serialized, logged, stored in SQLite or passed to the cloud client.
 */
export class StudioTeamTemplateCrypto {
  public constructor(private readonly cryptoProvider: Crypto = globalThis.crypto) {}

  public async encrypt(
    payloadValue: StudioTeamTemplatePayload,
    aadValue: CloudTeamTemplateAad,
    openedKey: OpenedStudioTeamTemplateProjectKey,
    signal?: AbortSignal,
  ): Promise<CloudTeamTemplateCiphertextEnvelope> {
    throwIfAborted(signal);
    const payload = parsePayload(payloadValue);
    const aad = parseAad(aadValue);
    requireOpenedKey(openedKey, aad, "encrypt");
    const plaintext = new TextEncoder().encode(canonicalJson(payload));
    const additionalData = new TextEncoder().encode(canonicalJson(aad));
    const nonce = new Uint8Array(12);
    this.cryptoProvider.getRandomValues(nonce);
    let ciphertext: Uint8Array | null = null;
    try {
      if (plaintext.byteLength > MAX_TEMPLATE_PLAINTEXT_BYTES) {
        throw new StudioTeamTemplateCryptoError(
          "TEAM_TEMPLATE_PAYLOAD_TOO_LARGE",
          "The encrypted team-template payload exceeds the local safety bound.",
        );
      }
      const encrypted = await this.cryptoProvider.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
        openedKey.key,
        plaintext,
      );
      throwIfAborted(signal);
      ciphertext = new Uint8Array(encrypted);
      const envelope = CloudTeamTemplateCiphertextEnvelopeSchema.safeParse({
        aad,
        algorithm: "AES-256-GCM",
        ciphertext: encodeBase64Url(ciphertext),
        ciphertextSha256: await sha256Hex(this.cryptoProvider, ciphertext),
        nonce: encodeBase64Url(nonce),
      });
      if (!envelope.success) {
        throw new StudioTeamTemplateCryptoError(
          "TEAM_TEMPLATE_PAYLOAD_TOO_LARGE",
          "The encrypted team-template envelope exceeds the transport safety bound.",
        );
      }
      return deepFreeze(envelope.data);
    } catch (error: unknown) {
      if (error instanceof StudioTeamTemplateCryptoError || isAbortError(error)) {
        throw error;
      }
      throw new StudioTeamTemplateCryptoError(
        "TEAM_TEMPLATE_CRYPTO_KEY_INVALID",
        "The project key could not encrypt this team template.",
      );
    } finally {
      plaintext.fill(0);
      additionalData.fill(0);
      nonce.fill(0);
      ciphertext?.fill(0);
    }
  }

  public async decrypt(
    envelopeValue: CloudTeamTemplateCiphertextEnvelope,
    openedKey: OpenedStudioTeamTemplateProjectKey,
    signal?: AbortSignal,
  ): Promise<StudioTeamTemplatePayload> {
    throwIfAborted(signal);
    const parsedEnvelope = CloudTeamTemplateCiphertextEnvelopeSchema.safeParse(envelopeValue);
    if (!parsedEnvelope.success) {
      throw corruptCiphertext();
    }
    const envelope = parsedEnvelope.data;
    const aad = parseAad(envelope.aad);
    requireOpenedKey(openedKey, aad, "decrypt");
    const nonce = decodeCanonicalBase64Url(envelope.nonce);
    const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext);
    const additionalData = new TextEncoder().encode(canonicalJson(aad));
    let plaintext: Uint8Array | null = null;
    try {
      if (
        nonce.byteLength !== 12 ||
        ciphertext.byteLength < 16 ||
        ciphertext.byteLength > MAX_TEMPLATE_PLAINTEXT_BYTES + 16
      ) {
        throw corruptCiphertext();
      }
      if ((await sha256Hex(this.cryptoProvider, ciphertext)) !== envelope.ciphertextSha256) {
        throw new StudioTeamTemplateCryptoError(
          "TEAM_TEMPLATE_CIPHERTEXT_HASH_MISMATCH",
          "The encrypted team-template payload failed its ciphertext digest check.",
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
      if (plaintext.byteLength > MAX_TEMPLATE_PLAINTEXT_BYTES) {
        throw new StudioTeamTemplateCryptoError(
          "TEAM_TEMPLATE_PAYLOAD_TOO_LARGE",
          "The decrypted team-template payload exceeds the local safety bound.",
        );
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
        ) as unknown;
      } catch {
        throw new StudioTeamTemplateCryptoError(
          "TEAM_TEMPLATE_PAYLOAD_INVALID",
          "The decrypted team template is not canonical schema-versioned JSON.",
        );
      }
      const payload = parsePayload(decoded);
      if (canonicalJson(payload) !== new TextDecoder().decode(plaintext)) {
        throw new StudioTeamTemplateCryptoError(
          "TEAM_TEMPLATE_PAYLOAD_INVALID",
          "The decrypted team template is not canonically encoded.",
        );
      }
      return payload;
    } catch (error: unknown) {
      if (error instanceof StudioTeamTemplateCryptoError || isAbortError(error)) {
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

  public async digestPayload(payloadValue: StudioTeamTemplatePayload): Promise<string> {
    const payload = parsePayload(payloadValue);
    const bytes = new TextEncoder().encode(canonicalJson(payload));
    try {
      return await sha256Hex(this.cryptoProvider, bytes);
    } finally {
      bytes.fill(0);
    }
  }
}

export function createStudioTeamTemplateAad(input: {
  readonly tenantId: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly templateId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly projectKeyVersion: number;
}): CloudTeamTemplateAad {
  return parseAad({
    schemaVersion: STUDIO_TEAM_TEMPLATE_PAYLOAD_SCHEMA_VERSION,
    purpose: "inkshadow.studio.team-template",
    ...input,
  });
}

function parsePayload(value: unknown): StudioTeamTemplatePayload {
  const parsed = StudioTeamTemplatePayloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new StudioTeamTemplateCryptoError(
      "TEAM_TEMPLATE_PAYLOAD_INVALID",
      "The team-template payload does not satisfy the canonical local schema.",
    );
  }
  return deepFreeze(parsed.data);
}

function parseAad(value: unknown): CloudTeamTemplateAad {
  const parsed = CloudTeamTemplateAadSchema.safeParse(value);
  if (!parsed.success) {
    throw new StudioTeamTemplateCryptoError(
      "TEAM_TEMPLATE_CRYPTO_SCOPE_INVALID",
      "The team-template encryption scope is incomplete or inconsistent.",
    );
  }
  return Object.freeze(parsed.data);
}

function requireOpenedKey(
  openedKey: OpenedStudioTeamTemplateProjectKey,
  aad: CloudTeamTemplateAad,
  usage: "decrypt" | "encrypt",
): void {
  if (
    openedKey.projectId !== aad.projectId ||
    openedKey.keyVersion !== aad.projectKeyVersion ||
    !isNonExtractableAes256GcmKey(openedKey.key, usage)
  ) {
    throw new StudioTeamTemplateCryptoError(
      "TEAM_TEMPLATE_CRYPTO_KEY_INVALID",
      "Team-template encryption requires the exact non-exportable AES-256-GCM project key.",
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
      throw new StudioTeamTemplateCryptoError(
        "TEAM_TEMPLATE_PAYLOAD_INVALID",
        "Team-template canonical JSON contains an invalid number.",
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
  throw new StudioTeamTemplateCryptoError(
    "TEAM_TEMPLATE_PAYLOAD_INVALID",
    "Team-template canonical JSON contains an unsupported value.",
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

function requireUnique(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      message: `A team template cannot repeat a ${label}`,
      path,
    });
  }
}

function corruptCiphertext(): StudioTeamTemplateCryptoError {
  return new StudioTeamTemplateCryptoError(
    "TEAM_TEMPLATE_CIPHERTEXT_CORRUPT",
    "The encrypted team-template payload could not be authenticated.",
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The Studio team-template operation was cancelled.", "AbortError");
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}
