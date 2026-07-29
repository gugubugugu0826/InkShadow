import { SyncCoreError } from "./errors.js";
import {
  compareBytesConstantTime,
  requireIdentifier,
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireSha256,
} from "./validation.js";

export const MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BITS = 128;

export const SYNC_OBJECT_TYPES = [
  "project_manifest",
  "chapter_version",
  "story_record",
  "outline",
  "memory",
  "material",
  "attachment",
] as const;

export type SyncObjectType = (typeof SYNC_OBJECT_TYPES)[number];

export interface SyncChunkAad {
  readonly projectId: string;
  readonly objectType: SyncObjectType;
  readonly objectId: string;
  readonly versionId: string;
  readonly chunkIndex: number;
  readonly keyVersion: number;
}

export interface EncryptedSyncChunk {
  readonly schemaVersion: 1;
  readonly algorithm: "AES-256-GCM";
  readonly nonce: string;
  readonly ciphertext: string;
  readonly ciphertextSha256: string;
  readonly plaintextBytes: number;
  readonly aad: SyncChunkAad;
}

export class AesGcmChunkCipher {
  public constructor(private readonly cryptoProvider: Crypto = globalThis.crypto) {}

  public generateProjectDataKey(): Promise<CryptoKey> {
    return this.cryptoProvider.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  public async importProjectDataKey(rawKey: Uint8Array): Promise<CryptoKey> {
    if (rawKey.byteLength !== 32) {
      throw new SyncCoreError("SYNC_KEY_INVALID", "A project data key must contain 256 bits.");
    }
    return this.cryptoProvider.subtle.importKey(
      "raw",
      ownedBytes(rawKey),
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  public async encrypt(
    key: CryptoKey,
    plaintextValue: Uint8Array,
    aadValue: SyncChunkAad,
  ): Promise<EncryptedSyncChunk> {
    validateKey(key, "encrypt");
    const plaintext = ownedBytes(plaintextValue);
    if (plaintext.byteLength > MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES) {
      throw new SyncCoreError(
        "SYNC_CHUNK_TOO_LARGE",
        `Plaintext chunk exceeds ${String(MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES)} bytes.`,
      );
    }
    const aad = normalizeChunkAad(aadValue);
    const additionalData = new TextEncoder().encode(canonicalizeChunkAad(aad));
    const nonce = this.cryptoProvider.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
    const encrypted = await this.cryptoProvider.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData,
        tagLength: AES_GCM_TAG_BITS,
      },
      key,
      plaintext,
    );
    const ciphertext = new Uint8Array(encrypted);
    return Object.freeze({
      schemaVersion: 1,
      algorithm: "AES-256-GCM",
      nonce: encodeBase64Url(nonce),
      ciphertext: encodeBase64Url(ciphertext),
      ciphertextSha256: await sha256Hex(this.cryptoProvider, ciphertext),
      plaintextBytes: plaintext.byteLength,
      aad,
    });
  }

  public async decrypt(
    key: CryptoKey,
    encryptedValue: EncryptedSyncChunk,
    expectedAadValue: SyncChunkAad,
  ): Promise<Uint8Array> {
    validateKey(key, "decrypt");
    const encrypted = validateEncryptedChunk(encryptedValue);
    const expectedAad = normalizeChunkAad(expectedAadValue);
    if (canonicalizeChunkAad(encrypted.aad) !== canonicalizeChunkAad(expectedAad)) {
      throw new SyncCoreError(
        "SYNC_CHUNK_METADATA_MISMATCH",
        "Encrypted chunk metadata does not match the requested object.",
      );
    }
    const ciphertext = decodeBase64Url(encrypted.ciphertext);
    const transportHash = await sha256Hex(this.cryptoProvider, ciphertext);
    if (!compareBytesConstantTime(transportHash, encrypted.ciphertextSha256)) {
      throw new SyncCoreError(
        "SYNC_CHUNK_INTEGRITY_FAILED",
        "Encrypted chunk transport checksum does not match.",
      );
    }

    try {
      const decrypted = await this.cryptoProvider.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decodeBase64Url(encrypted.nonce),
          additionalData: new TextEncoder().encode(canonicalizeChunkAad(encrypted.aad)),
          tagLength: AES_GCM_TAG_BITS,
        },
        key,
        ciphertext,
      );
      const plaintext = new Uint8Array(decrypted);
      if (plaintext.byteLength !== encrypted.plaintextBytes) {
        throw new SyncCoreError(
          "SYNC_CHUNK_INTEGRITY_FAILED",
          "Decrypted chunk size does not match its authenticated metadata.",
        );
      }
      return plaintext;
    } catch (cause: unknown) {
      if (cause instanceof SyncCoreError) {
        throw cause;
      }
      throw new SyncCoreError(
        "SYNC_CHUNK_INTEGRITY_FAILED",
        "Encrypted chunk authentication failed.",
      );
    }
  }
}

export function canonicalizeChunkAad(aadValue: SyncChunkAad): string {
  const aad = normalizeChunkAad(aadValue);
  return [
    "inkshadow-sync-v1",
    aad.projectId,
    aad.objectType,
    aad.objectId,
    aad.versionId,
    String(aad.chunkIndex),
    String(aad.keyVersion),
  ].join("|");
}

function normalizeChunkAad(value: SyncChunkAad): SyncChunkAad {
  if (!SYNC_OBJECT_TYPES.includes(value.objectType)) {
    throw new SyncCoreError("SYNC_VALIDATION_FAILED", "Sync object type is unsupported.");
  }
  return Object.freeze({
    projectId: requireIdentifier(value.projectId, "projectId"),
    objectType: value.objectType,
    objectId: requireIdentifier(value.objectId, "objectId"),
    versionId: requireIdentifier(value.versionId, "versionId"),
    chunkIndex: requireNonNegativeInteger(value.chunkIndex, "chunkIndex"),
    keyVersion: requirePositiveInteger(value.keyVersion, "keyVersion"),
  });
}

function validateEncryptedChunk(value: unknown): EncryptedSyncChunk {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.algorithm !== "AES-256-GCM" ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.ciphertextSha256 !== "string" ||
    typeof value.plaintextBytes !== "number" ||
    !isSyncChunkAad(value.aad)
  ) {
    throw new SyncCoreError("SYNC_CHUNK_METADATA_MISMATCH", "Chunk format is unsupported.");
  }
  const nonce = decodeBase64Url(value.nonce);
  const ciphertext = decodeBase64Url(value.ciphertext);
  if (
    nonce.byteLength !== AES_GCM_NONCE_BYTES ||
    ciphertext.byteLength < AES_GCM_TAG_BITS / 8 ||
    !Number.isSafeInteger(value.plaintextBytes) ||
    value.plaintextBytes < 0 ||
    value.plaintextBytes > MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES
  ) {
    throw new SyncCoreError("SYNC_CHUNK_METADATA_MISMATCH", "Chunk sizes are invalid.");
  }
  return {
    schemaVersion: 1,
    algorithm: "AES-256-GCM",
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    ciphertextSha256: requireSha256(value.ciphertextSha256, "ciphertextSha256"),
    plaintextBytes: value.plaintextBytes,
    aad: normalizeChunkAad(value.aad),
  };
}

function isSyncChunkAad(value: unknown): value is SyncChunkAad {
  return (
    isRecord(value) &&
    typeof value.projectId === "string" &&
    typeof value.objectType === "string" &&
    SYNC_OBJECT_TYPES.includes(value.objectType as SyncObjectType) &&
    typeof value.objectId === "string" &&
    typeof value.versionId === "string" &&
    typeof value.chunkIndex === "number" &&
    typeof value.keyVersion === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateKey(key: CryptoKey, usage: KeyUsage): void {
  if (key.type !== "secret" || key.algorithm.name !== "AES-GCM" || !key.usages.includes(usage)) {
    throw new SyncCoreError("SYNC_KEY_INVALID", `Key cannot be used for ${usage}.`);
  }
  if ("length" in key.algorithm && key.algorithm.length !== 256) {
    throw new SyncCoreError("SYNC_KEY_INVALID", "Project data key must use AES-256.");
  }
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new SyncCoreError("SYNC_CHUNK_METADATA_MISMATCH", "Chunk base64url is invalid.");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new SyncCoreError("SYNC_CHUNK_METADATA_MISMATCH", "Chunk base64url is invalid.");
  }
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index);
  }
  return decoded;
}

async function sha256Hex(cryptoProvider: Crypto, value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", ownedBytes(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
