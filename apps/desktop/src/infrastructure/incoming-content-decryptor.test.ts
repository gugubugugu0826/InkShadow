import {
  AesGcmChunkCipher,
  CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
  encodeContentSyncPayload,
  sha256Utf8Content,
  splitContentSyncPayloadBytes,
  type ChapterVersionContentSyncPayload,
  type ContentSyncPayload,
  type ProjectManifestContentSyncPayload,
  type SyncObjectType,
  type SyncOperationSnapshot,
  type SyncTombstoneSnapshot,
} from "@inkshadow/sync-core";
import { describe, expect, it, vi } from "vitest";

import {
  IncomingContentDecryptor,
  fingerprintIncomingContentCiphertextWork,
  type HistoricalProjectKeyResolver,
  type IncomingContentCiphertextChunk,
  type IncomingContentCiphertextWork,
} from "./incoming-content-decryptor";

const PROJECT_ID = "01890f47-38b1-7a52-8f1d-6df984cc6411";
const OTHER_PROJECT_ID = "01890f47-38b1-7a52-8f1d-6df984cc6410";
const CHAPTER_ID = "01890f47-38b1-7a52-8f1d-6df984cc6412";
const VERSION_ID = "01890f47-38b1-7a52-8f1d-6df984cc6413";
const OTHER_VERSION_ID = "01890f47-38b1-7a52-8f1d-6df984cc6414";
const PARENT_VERSION_ID = "01890f47-38b1-7a52-8f1d-6df984cc6415";
const DEVICE_ID = "01890f47-38b1-7a52-8f1d-6df984cc6416";
const OPERATION_ID = "01890f47-38b1-7a52-8f1d-6df984cc6417";
const CREATED_AT = "2026-07-28T01:02:03.000Z";
const UPDATED_AT = "2026-07-28T02:03:04.000Z";
const KEY_VERSION = 7;

describe("IncomingContentDecryptor", () => {
  it("authenticates and decodes real multi-chunk Unicode chapter ciphertext", async () => {
    const payload = await chapterPayload("墨影在雨夜里醒来。🌧️ 这是跨设备的正文。".repeat(40));
    const fixture = await createUpsertFixture(payload, { maxChunkBytes: 97 });
    const resolver = vi.fn<HistoricalProjectKeyResolver>().mockResolvedValue(fixture.key);
    const decryptor = new IncomingContentDecryptor(resolver);

    const prepared = await decryptor.prepare(fixture.work);

    expect(fixture.work.chunks.length).toBeGreaterThan(1);
    expect(prepared).toMatchObject({
      kind: "upsert",
      objectType: "chapter_version",
      projectId: PROJECT_ID,
      objectId: CHAPTER_ID,
      objectGeneration: payload.objectGeneration,
      sourceOperationId: OPERATION_ID,
      sourceDeviceId: DEVICE_ID,
      sourceDeviceSequence: 3,
      keyVersion: KEY_VERSION,
      versionId: VERSION_ID,
      payload,
    });
    expect(prepared.operationFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(prepared.operationFingerprint).toBe(
      await fingerprintIncomingContentCiphertextWork(fixture.work),
    );
    expect(prepared.kind === "upsert" ? prepared.payloadSha256 : null).toBe(
      await sha256Hex(fixture.canonicalPayload),
    );
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith(PROJECT_ID, KEY_VERSION);
  });

  it("binds every operation, chunk, digest, and AAD metadata field", async () => {
    const fixture = await createUpsertFixture(await chapterPayload("prepare and commit binding"));
    const original = await fingerprintIncomingContentCiphertextWork(fixture.work);
    const first = requiredChunk(fixture.work, 0);
    const alternateNonce = flipFirstCharacter(first.encrypted.nonce);
    const alternateDigest = flipSha256(first.encrypted.ciphertextSha256);
    const variants: IncomingContentCiphertextWork[] = [
      {
        ...fixture.work,
        operation: {
          ...fixture.work.operation,
          createdAt: UPDATED_AT,
        },
      },
      {
        ...fixture.work,
        chunks: [
          {
            ...first,
            chunkId: OTHER_VERSION_ID,
          },
          ...fixture.work.chunks.slice(1),
        ],
      },
      {
        ...fixture.work,
        chunks: [
          {
            ...first,
            encrypted: {
              ...first.encrypted,
              nonce: alternateNonce,
            },
          },
          ...fixture.work.chunks.slice(1),
        ],
      },
      {
        ...fixture.work,
        chunks: [
          {
            ...first,
            encrypted: {
              ...first.encrypted,
              ciphertextSha256: alternateDigest,
            },
          },
          ...fixture.work.chunks.slice(1),
        ],
      },
      {
        ...fixture.work,
        chunks: [
          {
            ...first,
            encrypted: {
              ...first.encrypted,
              plaintextBytes: first.encrypted.plaintextBytes + 1,
            },
          },
          ...fixture.work.chunks.slice(1),
        ],
      },
      {
        ...fixture.work,
        chunks: [
          {
            ...first,
            encrypted: {
              ...first.encrypted,
              aad: {
                ...first.encrypted.aad,
                versionId: OTHER_VERSION_ID,
              },
            },
          },
          ...fixture.work.chunks.slice(1),
        ],
      },
    ];

    expect(await fingerprintIncomingContentCiphertextWork(fixture.work)).toBe(original);
    for (const variant of variants) {
      expect(await fingerprintIncomingContentCiphertextWork(variant)).not.toBe(original);
    }
  });

  it("preserves the authenticated project-manifest revision identifier", async () => {
    const payload = projectManifestPayload();
    const fixture = await createUpsertFixture(payload, {
      aadVersionId: OTHER_VERSION_ID,
    });
    const decryptor = new IncomingContentDecryptor(() => Promise.resolve(fixture.key));

    const prepared = await decryptor.prepare(fixture.work);

    expect(prepared).toMatchObject({
      kind: "upsert",
      objectType: "project_manifest",
      payload,
      keyVersion: KEY_VERSION,
      versionId: OTHER_VERSION_ID,
      manifestRevisionId: OTHER_VERSION_ID,
    });
  });

  it("fails authentication when the resolver returns the wrong historical key", async () => {
    const fixture = await createUpsertFixture(await chapterPayload("wrong key"));
    const wrongKey = await new AesGcmChunkCipher().generateProjectDataKey();
    const decryptor = new IncomingContentDecryptor(() => Promise.resolve(wrongKey));

    await expectSyncFailure(decryptor.prepare(fixture.work), "SYNC_CHUNK_INTEGRITY_FAILED");
  });

  it("rejects AAD identity tampering before opening a historical key", async () => {
    const fixture = await createUpsertFixture(await chapterPayload("AAD identity"));
    const resolver = vi.fn<HistoricalProjectKeyResolver>().mockResolvedValue(fixture.key);
    const first = requiredChunk(fixture.work, 0);
    const tampered: IncomingContentCiphertextWork = {
      ...fixture.work,
      chunks: [
        {
          ...first,
          encrypted: {
            ...first.encrypted,
            aad: {
              ...first.encrypted.aad,
              projectId: OTHER_PROJECT_ID,
            },
          },
        },
        ...fixture.work.chunks.slice(1),
      ],
    };

    await expectSyncFailure(
      new IncomingContentDecryptor(resolver).prepare(tampered),
      "SYNC_CHUNK_METADATA_MISMATCH",
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects ciphertext reordered against encryptedChunkIds", async () => {
    const fixture = await createUpsertFixture(await chapterPayload("顺序不可交换。".repeat(30)), {
      maxChunkBytes: 64,
    });
    const resolver = vi.fn<HistoricalProjectKeyResolver>().mockResolvedValue(fixture.key);
    const reordered: IncomingContentCiphertextWork = {
      ...fixture.work,
      chunks: [
        requiredChunk(fixture.work, 1),
        requiredChunk(fixture.work, 0),
        ...fixture.work.chunks.slice(2),
      ],
    };

    await expectSyncFailure(
      new IncomingContentDecryptor(resolver).prepare(reordered),
      "SYNC_CHUNK_METADATA_MISMATCH",
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects a canonical payload whose content object type differs from the operation", async () => {
    const payload = projectManifestPayload();
    const fixture = await createUpsertFixture(payload, {
      operationObjectType: "chapter_version",
      aadObjectType: "chapter_version",
    });

    await expectSyncFailure(
      new IncomingContentDecryptor(() => Promise.resolve(fixture.key)).prepare(fixture.work),
      "SYNC_VALIDATION_FAILED",
      "identity or generation",
    );
  });

  it("rejects payload generation tampering after successful decryption", async () => {
    const payload = await chapterPayload("generation");
    const fixture = await createUpsertFixture(payload, {
      operationGeneration: payload.objectGeneration + 1,
    });

    await expectSyncFailure(
      new IncomingContentDecryptor(() => Promise.resolve(fixture.key)).prepare(fixture.work),
      "SYNC_VALIDATION_FAILED",
      "identity or generation",
    );
  });

  it("rejects a chapter payload version that differs from authenticated AAD", async () => {
    const fixture = await createUpsertFixture(await chapterPayload("version"), {
      aadVersionId: OTHER_VERSION_ID,
    });

    await expectSyncFailure(
      new IncomingContentDecryptor(() => Promise.resolve(fixture.key)).prepare(fixture.work),
      "SYNC_VALIDATION_FAILED",
      "AAD version",
    );
  });

  it("requires an exact typed tombstone for delete work", async () => {
    const missing = createDeleteWork("chapter_version", null);
    const mismatched = createDeleteWork("chapter_version", {
      ...deleteTombstone("chapter_version"),
      objectType: "project_manifest",
    });
    const resolver = vi.fn<HistoricalProjectKeyResolver>();
    const decryptor = new IncomingContentDecryptor(resolver);

    await expectSyncFailure(
      decryptor.prepare(missing),
      "SYNC_VALIDATION_FAILED",
      "exact typed tombstone",
    );
    await expectSyncFailure(
      decryptor.prepare(mismatched),
      "SYNC_VALIDATION_FAILED",
      "exactly match",
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("prepares a typed delete without resolving or opening any key", async () => {
    const tombstone = deleteTombstone("chapter_version");
    const work = createDeleteWork("chapter_version", tombstone);
    const resolver = vi.fn<HistoricalProjectKeyResolver>();

    const prepared = await new IncomingContentDecryptor(resolver).prepare(work);

    expect(prepared).toMatchObject({
      kind: "delete",
      objectType: "chapter_version",
      projectId: PROJECT_ID,
      objectId: CHAPTER_ID,
      objectGeneration: 7,
      vector: { [DEVICE_ID]: 3 },
      sourceOperationId: OPERATION_ID,
      sourceDeviceId: DEVICE_ID,
      sourceDeviceSequence: 3,
      tombstone,
    });
    expect(prepared.operationFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(prepared.operationFingerprint).toBe(
      await fingerprintIncomingContentCiphertextWork(work),
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it("binds the complete normalized delete tombstone into the work fingerprint", async () => {
    const work = createDeleteWork("chapter_version", deleteTombstone("chapter_version"));
    const original = await fingerprintIncomingContentCiphertextWork(work);
    const tombstone = work.tombstone;
    if (tombstone === null) {
      throw new Error("Delete test work must carry a tombstone.");
    }
    const changed: IncomingContentCiphertextWork = {
      ...work,
      tombstone: {
        ...tombstone,
        acknowledgedDeviceIds: [OTHER_PROJECT_ID],
      },
    };

    expect(await fingerprintIncomingContentCiphertextWork(changed)).not.toBe(original);
  });

  it("fails closed for sync object types without a plaintext content materializer", async () => {
    const resolver = vi.fn<HistoricalProjectKeyResolver>();
    const work = createDeleteWork("story_record", deleteTombstone("story_record"));

    await expectSyncFailure(
      new IncomingContentDecryptor(resolver).prepare(work),
      "SYNC_VALIDATION_FAILED",
      "no plaintext content materializer",
    );
    expect(resolver).not.toHaveBeenCalled();
  });
});

async function createUpsertFixture(
  payload: ContentSyncPayload,
  options: Readonly<{
    maxChunkBytes?: number;
    aadVersionId?: string;
    aadObjectType?: SyncObjectType;
    operationObjectType?: SyncObjectType;
    operationGeneration?: number;
  }> = {},
): Promise<{
  readonly work: IncomingContentCiphertextWork;
  readonly key: CryptoKey;
  readonly canonicalPayload: Uint8Array;
}> {
  const cipher = new AesGcmChunkCipher();
  const key = await cipher.generateProjectDataKey();
  const encodedPayload = await encodeContentSyncPayload(payload);
  const canonicalPayload = new Uint8Array(encodedPayload.byteLength);
  canonicalPayload.set(encodedPayload);
  const plaintextChunks = splitContentSyncPayloadBytes(canonicalPayload, options.maxChunkBytes);
  const aadObjectType = options.aadObjectType ?? payload.objectType;
  const operationObjectType = options.operationObjectType ?? payload.objectType;
  const versionId =
    options.aadVersionId ??
    (payload.objectType === "chapter_version" ? payload.versionId : VERSION_ID);
  const chunks: IncomingContentCiphertextChunk[] = [];
  const chunkIds: string[] = [];
  for (const [index, plaintext] of plaintextChunks.entries()) {
    const chunkId = chunkIdAt(index);
    chunkIds.push(chunkId);
    chunks.push({
      chunkId,
      encrypted: await cipher.encrypt(key, plaintext, {
        projectId: payload.projectId,
        objectType: aadObjectType,
        objectId: payload.objectId,
        versionId,
        chunkIndex: index,
        keyVersion: KEY_VERSION,
      }),
    });
  }

  return {
    key,
    canonicalPayload,
    work: claimedWork(
      {
        operationId: OPERATION_ID,
        projectId: payload.projectId,
        deviceId: DEVICE_ID,
        deviceSequence: 3,
        objectType: operationObjectType,
        objectId: payload.objectId,
        objectGeneration: options.operationGeneration ?? payload.objectGeneration,
        kind: "upsert",
        vector: { [DEVICE_ID]: 3 },
        encryptedChunkIds: chunkIds,
        createdAt: CREATED_AT,
      },
      chunks,
      null,
    ),
  };
}

function createDeleteWork(
  objectType: SyncObjectType,
  tombstone: SyncTombstoneSnapshot | null,
): IncomingContentCiphertextWork {
  return claimedWork(
    {
      operationId: OPERATION_ID,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 3,
      objectType,
      objectId: CHAPTER_ID,
      objectGeneration: 7,
      kind: "delete",
      vector: { [DEVICE_ID]: 3 },
      encryptedChunkIds: [],
      createdAt: CREATED_AT,
    },
    [],
    tombstone,
  );
}

function claimedWork(
  operation: SyncOperationSnapshot,
  chunks: readonly IncomingContentCiphertextChunk[],
  tombstone: SyncTombstoneSnapshot | null,
): IncomingContentCiphertextWork {
  return {
    operation,
    chunks,
    tombstone,
  };
}

function deleteTombstone(objectType: SyncObjectType): SyncTombstoneSnapshot {
  return {
    projectId: PROJECT_ID,
    objectType,
    objectId: CHAPTER_ID,
    objectGeneration: 7,
    deletedByDeviceId: DEVICE_ID,
    vector: { [DEVICE_ID]: 3 },
    deletedAt: CREATED_AT,
    retainUntil: "2027-07-29T01:02:03.000Z",
    acknowledgedDeviceIds: [],
  };
}

async function chapterPayload(content: string): Promise<ChapterVersionContentSyncPayload> {
  return {
    schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
    objectType: "chapter_version",
    projectId: PROJECT_ID,
    objectId: CHAPTER_ID,
    versionId: VERSION_ID,
    objectGeneration: 7,
    chapter: {
      id: CHAPTER_ID,
      projectId: PROJECT_ID,
      title: "第一章",
      content,
      status: "active",
      revision: 2,
      currentVersionId: VERSION_ID,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      trashedAt: null,
    },
    version: {
      id: VERSION_ID,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      parentVersionId: PARENT_VERSION_ID,
      sequence: 2,
      content,
      contentChecksum: await sha256Utf8Content(content),
      reason: "manual",
      sourceCandidateId: null,
      createdAt: UPDATED_AT,
    },
  };
}

function projectManifestPayload(): ProjectManifestContentSyncPayload {
  return {
    schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
    objectType: "project_manifest",
    projectId: PROJECT_ID,
    objectId: PROJECT_ID,
    objectGeneration: 1,
    project: {
      id: PROJECT_ID,
      name: "墨影长篇",
      status: "active",
      revision: 1,
      deletionGeneration: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      archivedAt: null,
      trashedAt: null,
      retentionUntil: null,
      statusBeforeTrash: null,
    },
  };
}

function requiredChunk(
  work: IncomingContentCiphertextWork,
  index: number,
): IncomingContentCiphertextChunk {
  const chunk = work.chunks[index];
  if (chunk === undefined) {
    throw new Error(`Missing test chunk ${String(index)}.`);
  }
  return chunk;
}

function chunkIdAt(index: number): string {
  return `01890f47-38b1-7a52-8f1d-${(0x700 + index).toString(16).padStart(12, "0")}`;
}

function flipFirstCharacter(value: string): string {
  const first = value[0];
  if (first === undefined) {
    throw new Error("Test metadata must not be empty.");
  }
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}

function flipSha256(value: string): string {
  const first = value[0];
  if (first === undefined) {
    throw new Error("Test digest must not be empty.");
  }
  return `${first === "a" ? "b" : "a"}${value.slice(1)}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectSyncFailure(
  promise: Promise<unknown>,
  code: string,
  messageFragment?: string,
): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error)) {
      throw error;
    }
    expect(error.code).toBe(code);
    if (messageFragment !== undefined) {
      expect(error.message).toContain(messageFragment);
    }
    return;
  }
  throw new Error(`Expected sync failure '${code}'.`);
}
