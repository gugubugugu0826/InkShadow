import {
  EncryptedSyncChunkContractSchema,
  IsoUtcTimestampSchema,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  SyncOperationContractSchema,
  UuidV7Schema,
  VersionVectorSchema,
  type EncryptedSyncChunkContract,
  type SyncOperationContract,
} from "@inkshadow/contracts";
import type { StoredEncryptedChunk } from "@inkshadow/data/sync-sqlite-store";
import type { UuidV7Generator } from "@inkshadow/domain";
import {
  AesGcmChunkCipher,
  MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  SyncCoreError,
  encodeContentSyncPayloadChunks,
  parseContentSyncPayload,
  reassembleContentSyncPayloadBytes,
  type ContentSyncPayload,
  type VersionVector,
} from "@inkshadow/sync-core";

export interface BuildOutgoingContentEncryptionInput {
  readonly key: CryptoKey;
  readonly keyVersion: number;
  readonly deviceId: string;
  readonly deviceSequence: number;
  readonly operationId: string;
  readonly vector: VersionVector;
  readonly createdAt: string;
  readonly chunkIdGenerator: Pick<UuidV7Generator, "next">;
  readonly payload: ContentSyncPayload;
  /**
   * A fresh, bounded UUIDv7 identifying this exact manifest revision in AAD.
   * Chapter payloads already carry their immutable version identifier and must
   * not supply this field.
   */
  readonly manifestVersionId?: string;
}

export interface BuiltOutgoingContentEncryption {
  readonly operation: SyncOperationContract;
  readonly chunks: readonly StoredEncryptedChunk[];
  /** SHA-256 over the exact canonical plaintext payload bytes. */
  readonly payloadSha256: string;
}

/**
 * Converts one complete, canonical content payload into the ciphertext-only
 * shape accepted by SyncSqliteStore.enqueue.
 *
 * The builder never exports the project key and never returns or logs encoded
 * plaintext. Owned plaintext chunks are scrubbed after encryption, including
 * failure paths.
 */
export class OutgoingContentEncryptionBuilder {
  private readonly cipher: AesGcmChunkCipher;

  public constructor(private readonly cryptoProvider: Crypto = globalThis.crypto) {
    this.cipher = new AesGcmChunkCipher(cryptoProvider);
  }

  public async build(
    input: BuildOutgoingContentEncryptionInput,
  ): Promise<BuiltOutgoingContentEncryption> {
    assertProjectDataKey(input.key);
    const keyVersion = requirePositiveSafeInteger(input.keyVersion, "keyVersion");
    const deviceId = requireUuidV7(input.deviceId, "deviceId");
    const deviceSequence = requirePositiveSafeInteger(input.deviceSequence, "deviceSequence");
    const operationId = requireUuidV7(input.operationId, "operationId");
    const vector = normalizeUuidVersionVector(input.vector);
    const createdAt = requireCanonicalIsoUtcTimestamp(input.createdAt, "createdAt");

    if (vector[deviceId] !== deviceSequence) {
      throw validationError("vector[deviceId] must equal deviceSequence.");
    }
    const chunkIdGenerator = requireChunkIdGenerator(input.chunkIdGenerator);

    const payload = await parseContentSyncPayload(input.payload, this.cryptoProvider);
    const aadVersionId = resolveAadVersionId(payload, input.manifestVersionId);
    const plaintextChunks = await encodeContentSyncPayloadChunks(
      payload,
      MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
      this.cryptoProvider,
    );

    try {
      const payloadSha256 = await sha256CanonicalPayload(this.cryptoProvider, plaintextChunks);
      const chunkIds = plaintextChunks.map((_chunk, index) =>
        requireUuidV7(chunkIdGenerator.next(), `chunkId[${String(index)}]`),
      );
      if (new Set(chunkIds).size !== chunkIds.length) {
        throw validationError("Generated chunk identifiers must be unique.");
      }

      const chunks: StoredEncryptedChunk[] = [];
      for (let index = 0; index < plaintextChunks.length; index += 1) {
        const plaintext = plaintextChunks[index];
        const chunkId = chunkIds[index];
        if (plaintext === undefined || chunkId === undefined) {
          throw validationError("Content chunk construction became inconsistent.");
        }
        const encrypted = assertEncryptedChunkContract(
          await this.cipher.encrypt(input.key, plaintext, {
            projectId: payload.projectId,
            objectType: payload.objectType,
            objectId: payload.objectId,
            versionId: aadVersionId,
            chunkIndex: index,
            keyVersion,
          }),
        );
        chunks.push(
          Object.freeze({
            chunkId,
            encrypted,
            createdAt,
          }),
        );
      }

      const operation = assertOperationContract({
        schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
        operationId,
        projectId: payload.projectId,
        deviceId,
        deviceSequence,
        objectType: payload.objectType,
        objectId: payload.objectId,
        objectGeneration: payload.objectGeneration,
        kind: "upsert",
        vector,
        encryptedChunkIds: chunkIds,
        createdAt,
      });

      return Object.freeze({
        operation,
        chunks: Object.freeze(chunks),
        payloadSha256,
      });
    } finally {
      for (const plaintext of plaintextChunks) {
        plaintext.fill(0);
      }
    }
  }
}

async function sha256CanonicalPayload(
  cryptoProvider: Crypto,
  plaintextChunks: readonly Uint8Array[],
): Promise<string> {
  const canonicalBytes = reassembleContentSyncPayloadBytes(
    plaintextChunks,
    MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  );
  const digestInput = ownedBytes(canonicalBytes);
  try {
    const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", digestInput));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    digestInput.fill(0);
    canonicalBytes.fill(0);
  }
}

function resolveAadVersionId(
  payload: ContentSyncPayload,
  manifestVersionIdValue: string | undefined,
): string {
  if (payload.objectType === "chapter_version") {
    if (manifestVersionIdValue !== undefined) {
      throw validationError("manifestVersionId is only valid for project_manifest payloads.");
    }
    return payload.versionId;
  }
  if (manifestVersionIdValue === undefined) {
    throw validationError("project_manifest payloads require manifestVersionId.");
  }
  return requireUuidV7(manifestVersionIdValue, "manifestVersionId");
}

function assertProjectDataKey(keyValue: unknown): asserts keyValue is CryptoKey {
  if (typeof keyValue !== "object" || keyValue === null) {
    throw invalidProjectDataKeyError();
  }
  const key = keyValue as Record<string, unknown>;
  if (
    key.type !== "secret" ||
    key.extractable !== false ||
    !isAes256GcmAlgorithm(key.algorithm) ||
    !hasEncryptUsage(key.usages)
  ) {
    throw invalidProjectDataKeyError();
  }
}

function isAes256GcmAlgorithm(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const algorithm = value as Record<string, unknown>;
  return algorithm.name === "AES-GCM" && algorithm.length === 256;
}

function hasEncryptUsage(value: unknown): boolean {
  return Array.isArray(value) && (value as unknown[]).includes("encrypt");
}

function invalidProjectDataKeyError(): SyncCoreError {
  return new SyncCoreError(
    "SYNC_KEY_INVALID",
    "The opened project key must be a non-extractable AES-256-GCM key usable for encryption.",
  );
}

function requireChunkIdGenerator(value: unknown): Readonly<{ next(): unknown }> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("next" in value) ||
    typeof value.next !== "function"
  ) {
    throw validationError("chunkIdGenerator must provide next().");
  }
  return value as Readonly<{ next(): unknown }>;
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function requireUuidV7(value: unknown, field: string): string {
  const parsed = UuidV7Schema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be a bounded UUIDv7 identifier.`);
  }
  return parsed.data.toLowerCase();
}

function requireCanonicalIsoUtcTimestamp(value: unknown, field: string): string {
  const parsed = IsoUtcTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError(`${field} must be an ISO UTC timestamp.`);
  }
  const milliseconds = Date.parse(parsed.data);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed.data) {
    throw validationError(`${field} must use the canonical ISO UTC representation.`);
  }
  return parsed.data;
}

function normalizeUuidVersionVector(value: VersionVector): VersionVector {
  const parsed = VersionVectorSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError("vector must contain at most 1,024 UUIDv7 device counters.");
  }

  const normalized: Record<string, number> = {};
  for (const [deviceIdValue, counterValue] of Object.entries(parsed.data)) {
    const deviceId = requireUuidV7(deviceIdValue, "vector deviceId");
    if (Object.hasOwn(normalized, deviceId)) {
      throw validationError("vector must not contain case-aliased device identifiers.");
    }
    normalized[deviceId] = requirePositiveSafeInteger(counterValue, `vector[${deviceId}]`);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function assertEncryptedChunkContract(value: unknown): EncryptedSyncChunkContract {
  const parsed = EncryptedSyncChunkContractSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError("The encrypted chunk does not satisfy the transport contract.");
  }
  Object.freeze(parsed.data.aad);
  return Object.freeze(parsed.data);
}

function assertOperationContract(value: unknown): SyncOperationContract {
  const parsed = SyncOperationContractSchema.safeParse(value);
  if (!parsed.success) {
    throw validationError("The outgoing operation does not satisfy sync protocol v2.");
  }
  Object.freeze(parsed.data.vector);
  Object.freeze(parsed.data.encryptedChunkIds);
  return Object.freeze(parsed.data);
}

function validationError(message: string): SyncCoreError {
  return new SyncCoreError("SYNC_VALIDATION_FAILED", message);
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}
