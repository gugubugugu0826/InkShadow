import { CONTRACT_SCHEMA_VERSION, SYNC_PROTOCOL_SCHEMA_VERSION } from "@inkshadow/contracts";
import { parseUuidV7, type UuidV7, type UuidV7Generator } from "@inkshadow/domain";
import {
  AesGcmChunkCipher,
  CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
  MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  decodeContentSyncPayloadChunks,
  reassembleContentSyncPayloadBytes,
  sha256Utf8Content,
  type ChapterVersionContentSyncPayload,
  type ProjectManifestContentSyncPayload,
} from "@inkshadow/sync-core";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  OutgoingContentEncryptionBuilder,
  type BuildOutgoingContentEncryptionInput,
  type BuiltOutgoingContentEncryption,
} from "./outgoing-content-encryption-builder";

const textEncoderRealm = vi.hoisted(() => {
  const originalTextEncoder = globalThis.TextEncoder;
  class RealmSafeTextEncoder extends originalTextEncoder {
    public override encode(input?: string): Uint8Array<ArrayBuffer> {
      const encoded = super.encode(input);
      const owned = new Uint8Array(encoded.byteLength);
      owned.set(encoded);
      return owned;
    }
  }

  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: RealmSafeTextEncoder,
    writable: true,
  });
  return { originalTextEncoder };
});

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const PARENT_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const MANIFEST_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const CHUNK_ID_1 = "019f9f4a-b3c7-7350-9226-000000000008";
const CHUNK_ID_2 = "019f9f4a-b3c7-7350-9226-000000000009";
const CHUNK_ID_3 = "019f9f4a-b3c7-7350-9226-00000000000a";
const CREATED_AT = "2026-07-28T00:00:00.000Z";
const UPDATED_AT = "2026-07-28T00:01:00.000Z";
const LARGE_UNICODE_CONTENT = "墨影🙂".repeat(250_000);

let largeChapterPayload: ChapterVersionContentSyncPayload;

beforeAll(async () => {
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: textEncoderRealm.originalTextEncoder,
    writable: true,
  });
  largeChapterPayload = await chapterPayload(LARGE_UNICODE_CONTENT);
});

describe("OutgoingContentEncryptionBuilder", () => {
  it("builds a ciphertext-only protocol-v2 project manifest operation with exact AAD", async () => {
    const key = await createProjectKey();
    const payload = projectPayload();
    const builder = new OutgoingContentEncryptionBuilder();

    const built = await builder.build(
      projectInput(key, payload, new SequenceChunkIds([CHUNK_ID_1])),
    );
    const decoded = await decryptAndDecode(key, built);

    expect(built.operation).toEqual({
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      operationId: OPERATION_ID,
      projectId: payload.projectId,
      deviceId: DEVICE_ID,
      deviceSequence: 3,
      objectType: payload.objectType,
      objectId: payload.objectId,
      objectGeneration: payload.objectGeneration,
      kind: "upsert",
      vector: { [DEVICE_ID]: 3 },
      encryptedChunkIds: [CHUNK_ID_1],
      createdAt: CREATED_AT,
    });
    expect(built.chunks).toHaveLength(1);
    expect(built.chunks[0]).toMatchObject({
      chunkId: CHUNK_ID_1,
      createdAt: CREATED_AT,
      encrypted: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        algorithm: "AES-256-GCM",
        aad: {
          projectId: payload.projectId,
          objectType: payload.objectType,
          objectId: payload.objectId,
          versionId: MANIFEST_VERSION_ID,
          chunkIndex: 0,
          keyVersion: 4,
        },
      },
    });
    expect(decoded).toEqual(payload);
    expect(built.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(built)).not.toContain(payload.project.name);
    expect(key.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
  });

  it("round-trips a >4 MiB Unicode chapter payload across independently authenticated chunks", async () => {
    const key = await createProjectKey();
    const builder = new OutgoingContentEncryptionBuilder();
    const chunkIds = [CHUNK_ID_1, CHUNK_ID_2, CHUNK_ID_3];

    const built = await builder.build(
      chapterInput(key, largeChapterPayload, new SequenceChunkIds(chunkIds)),
    );
    const cipher = new AesGcmChunkCipher();
    const plaintextChunks = [];
    for (const [index, chunk] of built.chunks.entries()) {
      expect(chunk.encrypted.schemaVersion).toBe(CONTRACT_SCHEMA_VERSION);
      expect(chunk.encrypted.plaintextBytes).toBeLessThanOrEqual(
        MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
      );
      expect(chunk.encrypted.aad).toEqual({
        projectId: largeChapterPayload.projectId,
        objectType: "chapter_version",
        objectId: largeChapterPayload.objectId,
        versionId: largeChapterPayload.versionId,
        chunkIndex: index,
        keyVersion: 4,
      });
      plaintextChunks.push(await cipher.decrypt(key, chunk.encrypted, chunk.encrypted.aad));
    }

    expect(built.chunks.length).toBeGreaterThan(1);
    expect(
      plaintextChunks.reduce((total, plaintext) => total + plaintext.byteLength, 0),
    ).toBeGreaterThan(MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES);
    expect(new Set(built.operation.encryptedChunkIds).size).toBe(built.chunks.length);
    expect(built.payloadSha256).toBe(
      await sha256Bytes(reassembleContentSyncPayloadBytes(plaintextChunks)),
    );
    expect(built.operation).toMatchObject({
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      projectId: largeChapterPayload.projectId,
      objectType: largeChapterPayload.objectType,
      objectId: largeChapterPayload.objectId,
      objectGeneration: largeChapterPayload.objectGeneration,
      encryptedChunkIds: chunkIds.slice(0, built.chunks.length),
    });
    await expect(decodeContentSyncPayloadChunks(plaintextChunks)).resolves.toEqual(
      largeChapterPayload,
    );
  });

  it("rejects extractable and non-256-bit project keys", async () => {
    const builder = new OutgoingContentEncryptionBuilder();
    const extractableKey = await globalThis.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const shortKey = await globalThis.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 128 },
      false,
      ["encrypt", "decrypt"],
    );

    await expect(
      builder.build(
        projectInput(extractableKey, projectPayload(), new SequenceChunkIds([CHUNK_ID_1])),
      ),
    ).rejects.toMatchObject({ code: "SYNC_KEY_INVALID" });
    await expect(
      builder.build(projectInput(shortKey, projectPayload(), new SequenceChunkIds([CHUNK_ID_1]))),
    ).rejects.toMatchObject({ code: "SYNC_KEY_INVALID" });
  });

  it("rejects invalid key versions and device/version-vector divergence", async () => {
    const key = await createProjectKey();
    const builder = new OutgoingContentEncryptionBuilder();
    const valid = projectInput(key, projectPayload(), new SequenceChunkIds([CHUNK_ID_1]));

    await expectSyncFailure(
      builder.build({ ...valid, keyVersion: 0 }),
      "SYNC_VALIDATION_FAILED",
      "keyVersion",
    );
    await expectSyncFailure(
      builder.build({
        ...valid,
        vector: { [DEVICE_ID]: valid.deviceSequence + 1 },
      }),
      "SYNC_VALIDATION_FAILED",
      "vector[deviceId]",
    );
    await expectSyncFailure(
      builder.build({
        ...valid,
        vector: { ["019f9f4a-b3c7-7350-9226-00000000000b"]: 1 },
      }),
      "SYNC_VALIDATION_FAILED",
      "vector[deviceId]",
    );
  });

  it("requires a valid manifest version ID and forbids it for chapter payloads", async () => {
    const key = await createProjectKey();
    const builder = new OutgoingContentEncryptionBuilder();
    const valid = projectInput(key, projectPayload(), new SequenceChunkIds([CHUNK_ID_1]));
    const { manifestVersionId, ...missingManifestVersion } = valid;
    expect(manifestVersionId).toBe(MANIFEST_VERSION_ID);

    await expectSyncFailure(
      builder.build(missingManifestVersion),
      "SYNC_VALIDATION_FAILED",
      "require manifestVersionId",
    );
    await expectSyncFailure(
      builder.build({ ...valid, manifestVersionId: "manifest-latest" }),
      "SYNC_VALIDATION_FAILED",
      "UUIDv7",
    );
    await expectSyncFailure(
      builder.build({
        ...chapterInput(key, await chapterPayload("章节正文"), new SequenceChunkIds([CHUNK_ID_1])),
        manifestVersionId: MANIFEST_VERSION_ID,
      }),
      "SYNC_VALIDATION_FAILED",
      "only valid",
    );
  });

  it("rejects duplicate generated chunk IDs before producing ciphertext", async () => {
    const key = await createProjectKey();
    const builder = new OutgoingContentEncryptionBuilder();

    await expectSyncFailure(
      builder.build(
        chapterInput(key, largeChapterPayload, new ConstantChunkIdGenerator(CHUNK_ID_1)),
      ),
      "SYNC_VALIDATION_FAILED",
      "unique",
    );
  });

  it.each([
    ["operationId", { operationId: "operation-1" }],
    ["deviceId", { deviceId: "device-1", vector: { ["device-1"]: 3 } }],
    ["createdAt", { createdAt: "2026-07-28T10:00:00+10:00" }],
  ] satisfies readonly (readonly [string, Partial<BuildOutgoingContentEncryptionInput>])[])(
    "rejects a non-contract %s",
    async (_field, override) => {
      const key = await createProjectKey();
      const builder = new OutgoingContentEncryptionBuilder();
      const valid = projectInput(key, projectPayload(), new SequenceChunkIds([CHUNK_ID_1]));

      await expect(builder.build({ ...valid, ...override })).rejects.toMatchObject({
        code: "SYNC_VALIDATION_FAILED",
      });
    },
  );

  it("rejects a generated chunk ID that is not UUIDv7", async () => {
    const key = await createProjectKey();
    const builder = new OutgoingContentEncryptionBuilder();

    await expectSyncFailure(
      builder.build(
        projectInput(key, projectPayload(), new UnsafeChunkIdGenerator("chunk-latest")),
      ),
      "SYNC_VALIDATION_FAILED",
      "chunkId[0]",
    );
  });
});

function projectInput(
  key: CryptoKey,
  payload: ProjectManifestContentSyncPayload,
  chunkIdGenerator: Pick<UuidV7Generator, "next">,
): BuildOutgoingContentEncryptionInput {
  return {
    key,
    keyVersion: 4,
    deviceId: DEVICE_ID,
    deviceSequence: 3,
    operationId: OPERATION_ID,
    vector: { [DEVICE_ID]: 3 },
    createdAt: CREATED_AT,
    chunkIdGenerator,
    payload,
    manifestVersionId: MANIFEST_VERSION_ID,
  };
}

function chapterInput(
  key: CryptoKey,
  payload: ChapterVersionContentSyncPayload,
  chunkIdGenerator: Pick<UuidV7Generator, "next">,
): BuildOutgoingContentEncryptionInput {
  return {
    key,
    keyVersion: 4,
    deviceId: DEVICE_ID,
    deviceSequence: 3,
    operationId: OPERATION_ID,
    vector: { [DEVICE_ID]: 3 },
    createdAt: CREATED_AT,
    chunkIdGenerator,
    payload,
  };
}

function projectPayload(): ProjectManifestContentSyncPayload {
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

async function chapterPayload(content: string): Promise<ChapterVersionContentSyncPayload> {
  return {
    schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
    objectType: "chapter_version",
    projectId: PROJECT_ID,
    objectId: CHAPTER_ID,
    versionId: VERSION_ID,
    objectGeneration: 2,
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

async function createProjectKey(): Promise<CryptoKey> {
  return new AesGcmChunkCipher().generateProjectDataKey();
}

async function decryptAndDecode(
  key: CryptoKey,
  built: BuiltOutgoingContentEncryption,
): Promise<ProjectManifestContentSyncPayload | ChapterVersionContentSyncPayload> {
  const cipher = new AesGcmChunkCipher();
  const plaintextChunks = [];
  for (const chunk of built.chunks) {
    plaintextChunks.push(await cipher.decrypt(key, chunk.encrypted, chunk.encrypted.aad));
  }
  return decodeContentSyncPayloadChunks(plaintextChunks);
}

class SequenceChunkIds implements UuidV7Generator {
  private index = 0;

  public constructor(private readonly values: readonly string[]) {}

  public next(): UuidV7 {
    const value = this.values[this.index];
    this.index += 1;
    if (value === undefined) {
      throw new Error("The test chunk ID sequence is exhausted.");
    }
    return requireTestUuid(value);
  }
}

class ConstantChunkIdGenerator implements UuidV7Generator {
  public constructor(private readonly value: string) {}

  public next(): UuidV7 {
    return requireTestUuid(this.value);
  }
}

class UnsafeChunkIdGenerator {
  public constructor(private readonly value: string) {}

  public next(): UuidV7 {
    return this.value as UuidV7;
  }
}

function requireTestUuid(value: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const owned = new Uint8Array(value.byteLength);
  owned.set(value);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", owned));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function expectSyncFailure(
  promise: Promise<unknown>,
  code: string,
  messageFragment: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
  await expect(promise).rejects.toThrow(messageFragment);
}
