import {
  EncryptedSyncChunkContractSchema,
  type EncryptedSyncChunkContract,
} from "@inkshadow/contracts";
import {
  AesGcmChunkCipher,
  SyncCoreError,
  SyncOperation,
  SyncTombstone,
  decodeContentSyncPayload,
  reassembleContentSyncPayloadBytes,
  type ChapterVersionContentSyncPayload,
  type ContentSyncPayload,
  type ProjectManifestContentSyncPayload,
  type SyncOperationSnapshot,
  type SyncTombstoneSnapshot,
  type VersionVector,
} from "@inkshadow/sync-core";

export type HistoricalProjectKeyResolver = (
  projectId: string,
  keyVersion: number,
) => Promise<CryptoKey>;

export interface IncomingContentCiphertextChunk {
  readonly chunkId: string;
  readonly encrypted: EncryptedSyncChunkContract;
}

/**
 * The common ciphertext shape exposed by both a claimed inbox item and a
 * committed snapshot item. Lease and inbox status are deliberately excluded.
 */
export interface IncomingContentCiphertextWork {
  readonly operation: SyncOperationSnapshot;
  readonly chunks: readonly IncomingContentCiphertextChunk[];
  readonly tombstone: SyncTombstoneSnapshot | null;
}

interface PreparedIncomingContentBase {
  readonly projectId: string;
  readonly objectId: string;
  readonly objectGeneration: number;
  readonly vector: VersionVector;
  readonly sourceOperationId: string;
  readonly sourceDeviceId: string;
  readonly sourceDeviceSequence: number;
  /**
   * Binds the prepared plaintext to the complete canonical ciphertext work
   * metadata so the transaction callback can reject prepare/commit swaps.
   */
  readonly operationFingerprint: string;
}

export interface PreparedProjectManifestUpsert extends PreparedIncomingContentBase {
  readonly kind: "upsert";
  readonly objectType: "project_manifest";
  readonly payload: ProjectManifestContentSyncPayload;
  readonly payloadSha256: string;
  readonly keyVersion: number;
  /**
   * The authenticated AAD version identifier is the immutable manifest
   * revision identifier. Project-manifest payloads intentionally do not carry
   * a second mutable version field.
   */
  readonly versionId: string;
  readonly manifestRevisionId: string;
}

export interface PreparedChapterVersionUpsert extends PreparedIncomingContentBase {
  readonly kind: "upsert";
  readonly objectType: "chapter_version";
  readonly payload: ChapterVersionContentSyncPayload;
  readonly payloadSha256: string;
  readonly keyVersion: number;
  readonly versionId: string;
}

export interface PreparedIncomingContentDelete extends PreparedIncomingContentBase {
  readonly kind: "delete";
  readonly objectType: "project_manifest" | "chapter_version";
  readonly tombstone: SyncTombstoneSnapshot;
}

export type PreparedIncomingContentMutation =
  PreparedProjectManifestUpsert | PreparedChapterVersionUpsert | PreparedIncomingContentDelete;

type ContentSyncOperationSnapshot = SyncOperationSnapshot &
  Readonly<{ objectType: "project_manifest" | "chapter_version" }>;

/**
 * Converts claimed ciphertext work into a fully authenticated, canonical
 * plaintext mutation. It has no persistence or logging capability by design.
 */
export class IncomingContentDecryptor {
  private readonly cipher: AesGcmChunkCipher;
  private readonly cryptoProvider: Crypto;

  public constructor(
    private readonly resolveHistoricalProjectKey: HistoricalProjectKeyResolver,
    options: Readonly<{
      cryptoProvider?: Crypto;
      cipher?: AesGcmChunkCipher;
    }> = {},
  ) {
    this.cryptoProvider = options.cryptoProvider ?? globalThis.crypto;
    this.cipher = options.cipher ?? new AesGcmChunkCipher(this.cryptoProvider);
  }

  public async prepare(
    work: IncomingContentCiphertextWork,
  ): Promise<PreparedIncomingContentMutation> {
    const operation = SyncOperation.create(work.operation).toSnapshot();
    assertSupportedContentOperation(operation);
    const operationFingerprint = await fingerprintIncomingContentCiphertextWork(
      work,
      this.cryptoProvider,
    );

    if (operation.kind === "delete") {
      return this.prepareDelete(work, operation, operationFingerprint);
    }
    return this.prepareUpsert(work, operation, operationFingerprint);
  }

  private prepareDelete(
    work: IncomingContentCiphertextWork,
    operation: ContentSyncOperationSnapshot,
    operationFingerprint: string,
  ): PreparedIncomingContentDelete {
    if (operation.encryptedChunkIds.length !== 0 || work.chunks.length !== 0) {
      throw validationError("Incoming content deletes must not carry ciphertext chunks.");
    }
    if (work.tombstone === null) {
      throw validationError("Incoming content deletes require an exact typed tombstone.");
    }
    const tombstone = SyncTombstone.create(work.tombstone).toSnapshot();
    if (!isExactTombstoneForOperation(tombstone, operation)) {
      throw validationError(
        "Incoming content delete tombstone does not exactly match its typed operation.",
      );
    }

    return Object.freeze({
      kind: "delete",
      objectType: operation.objectType,
      projectId: operation.projectId,
      objectId: operation.objectId,
      objectGeneration: operation.objectGeneration,
      vector: Object.freeze({ ...operation.vector }),
      sourceOperationId: operation.operationId,
      sourceDeviceId: operation.deviceId,
      sourceDeviceSequence: operation.deviceSequence,
      operationFingerprint,
      tombstone,
    });
  }

  private async prepareUpsert(
    work: IncomingContentCiphertextWork,
    operation: ContentSyncOperationSnapshot,
    operationFingerprint: string,
  ): Promise<PreparedProjectManifestUpsert | PreparedChapterVersionUpsert> {
    if (work.tombstone !== null) {
      throw validationError("Incoming content upserts must not carry a tombstone.");
    }
    if (work.chunks.length !== operation.encryptedChunkIds.length) {
      throw chunkMetadataError(
        "Incoming ciphertext count does not match the operation chunk manifest.",
      );
    }

    const encryptedChunks = work.chunks.map((stored, index) => {
      if (stored.chunkId !== operation.encryptedChunkIds[index]) {
        throw chunkMetadataError(
          "Incoming ciphertext chunks are not in the operation's authenticated order.",
        );
      }
      const parsed = EncryptedSyncChunkContractSchema.safeParse(stored.encrypted);
      if (!parsed.success) {
        throw chunkMetadataError("Incoming ciphertext metadata is malformed.");
      }
      const { aad } = parsed.data;
      if (
        aad.projectId !== operation.projectId ||
        aad.objectType !== operation.objectType ||
        aad.objectId !== operation.objectId ||
        aad.chunkIndex !== index
      ) {
        throw chunkMetadataError(
          "Incoming ciphertext AAD does not match the operation identity and order.",
        );
      }
      return parsed.data;
    });

    const firstChunk = encryptedChunks[0];
    if (firstChunk === undefined) {
      throw chunkMetadataError("Incoming content upserts require ciphertext.");
    }
    const { keyVersion, versionId } = firstChunk.aad;
    for (const encrypted of encryptedChunks) {
      if (encrypted.aad.keyVersion !== keyVersion || encrypted.aad.versionId !== versionId) {
        throw chunkMetadataError(
          "Incoming content chunks must share one exact key and version identifier.",
        );
      }
    }

    // Resolve only after every unauthenticated metadata field has passed the
    // complete-set preflight, and request the exact historical AAD key version.
    const key = await this.resolveHistoricalProjectKey(operation.projectId, keyVersion);
    const plaintextChunks: Uint8Array[] = [];
    for (const encrypted of encryptedChunks) {
      plaintextChunks.push(await this.cipher.decrypt(key, encrypted, encrypted.aad));
    }
    const canonicalPayloadBytes = reassembleContentSyncPayloadBytes(plaintextChunks);
    const payload = await decodeContentSyncPayload(canonicalPayloadBytes, this.cryptoProvider);
    assertPayloadMatchesOperation(payload, operation, versionId);
    const payloadSha256 = await sha256Hex(canonicalPayloadBytes, this.cryptoProvider);
    const base = {
      kind: "upsert" as const,
      projectId: operation.projectId,
      objectId: operation.objectId,
      objectGeneration: operation.objectGeneration,
      vector: Object.freeze({ ...operation.vector }),
      sourceOperationId: operation.operationId,
      sourceDeviceId: operation.deviceId,
      sourceDeviceSequence: operation.deviceSequence,
      operationFingerprint,
      payloadSha256,
      keyVersion,
      versionId,
    };

    if (payload.objectType === "chapter_version") {
      return Object.freeze({
        ...base,
        objectType: "chapter_version",
        payload,
      });
    }
    return Object.freeze({
      ...base,
      objectType: "project_manifest",
      payload,
      manifestRevisionId: versionId,
    });
  }
}

/**
 * Fingerprints every security-relevant metadata field used to prepare an
 * incoming content mutation. The ciphertext body is represented by its
 * validated transport digest to keep the canonical input bounded.
 */
export async function fingerprintIncomingContentCiphertextWork(
  work: IncomingContentCiphertextWork,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<string> {
  const operation = SyncOperation.create(work.operation).toSnapshot();
  const chunks = work.chunks.map((stored) => {
    if (typeof stored.chunkId !== "string" || stored.chunkId.length === 0) {
      throw chunkMetadataError("Incoming ciphertext chunk identifier is malformed.");
    }
    const parsed = EncryptedSyncChunkContractSchema.safeParse(stored.encrypted);
    if (!parsed.success) {
      throw chunkMetadataError("Incoming ciphertext metadata is malformed.");
    }
    const encrypted = parsed.data;
    return {
      chunkId: stored.chunkId,
      schemaVersion: encrypted.schemaVersion,
      algorithm: encrypted.algorithm,
      nonce: encrypted.nonce,
      ciphertextSha256: encrypted.ciphertextSha256,
      plaintextBytes: encrypted.plaintextBytes,
      aad: {
        projectId: encrypted.aad.projectId,
        objectType: encrypted.aad.objectType,
        objectId: encrypted.aad.objectId,
        versionId: encrypted.aad.versionId,
        chunkIndex: encrypted.aad.chunkIndex,
        keyVersion: encrypted.aad.keyVersion,
      },
    };
  });
  const normalizedTombstone =
    work.tombstone === null ? null : SyncTombstone.create(work.tombstone).toSnapshot();
  const tombstone =
    normalizedTombstone === null
      ? null
      : {
          projectId: normalizedTombstone.projectId,
          objectType: normalizedTombstone.objectType,
          objectId: normalizedTombstone.objectId,
          objectGeneration: normalizedTombstone.objectGeneration,
          deletedByDeviceId: normalizedTombstone.deletedByDeviceId,
          vector: canonicalVectorRecord(normalizedTombstone.vector),
          deletedAt: normalizedTombstone.deletedAt,
          retainUntil: normalizedTombstone.retainUntil,
          acknowledgedDeviceIds: [...normalizedTombstone.acknowledgedDeviceIds],
        };
  const canonicalWork = JSON.stringify({
    domain: "inkshadow/incoming-content-ciphertext-work-fingerprint/v1",
    operation: {
      operationId: operation.operationId,
      projectId: operation.projectId,
      deviceId: operation.deviceId,
      deviceSequence: operation.deviceSequence,
      objectType: operation.objectType,
      objectId: operation.objectId,
      objectGeneration: operation.objectGeneration,
      kind: operation.kind,
      vector: canonicalVectorRecord(operation.vector),
      encryptedChunkIds: [...operation.encryptedChunkIds],
      createdAt: operation.createdAt,
    },
    chunks,
    tombstone,
  });
  return sha256Hex(new TextEncoder().encode(canonicalWork), cryptoProvider);
}

function assertSupportedContentOperation(
  operation: SyncOperationSnapshot,
): asserts operation is ContentSyncOperationSnapshot {
  if (operation.objectType !== "project_manifest" && operation.objectType !== "chapter_version") {
    throw validationError(
      `Incoming object type '${operation.objectType}' has no plaintext content materializer.`,
    );
  }
}

function assertPayloadMatchesOperation(
  payload: ContentSyncPayload,
  operation: SyncOperationSnapshot,
  aadVersionId: string,
): void {
  if (
    payload.projectId !== operation.projectId ||
    payload.objectType !== operation.objectType ||
    payload.objectId !== operation.objectId ||
    payload.objectGeneration !== operation.objectGeneration
  ) {
    throw validationError(
      "Decrypted content payload identity or generation does not match its operation.",
    );
  }
  if (payload.objectType === "chapter_version" && payload.versionId !== aadVersionId) {
    throw validationError(
      "Decrypted chapter version does not match its authenticated AAD version.",
    );
  }
}

function isExactTombstoneForOperation(
  tombstone: SyncTombstoneSnapshot,
  operation: SyncOperationSnapshot,
): boolean {
  return (
    tombstone.projectId === operation.projectId &&
    tombstone.objectType === operation.objectType &&
    tombstone.objectId === operation.objectId &&
    tombstone.objectGeneration === operation.objectGeneration &&
    tombstone.deletedByDeviceId === operation.deviceId &&
    JSON.stringify(canonicalVectorRecord(tombstone.vector)) ===
      JSON.stringify(canonicalVectorRecord(operation.vector))
  );
}

function canonicalVectorRecord(vector: VersionVector): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(vector).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function sha256Hex(bytes: Uint8Array, cryptoProvider: Crypto): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validationError(message: string): SyncCoreError {
  return new SyncCoreError("SYNC_VALIDATION_FAILED", message);
}

function chunkMetadataError(message: string): SyncCoreError {
  return new SyncCoreError("SYNC_CHUNK_METADATA_MISMATCH", message);
}
