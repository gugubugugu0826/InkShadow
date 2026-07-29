import { describe, expect, it } from "vitest";

import {
  CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
  MAX_CHAPTER_CONTENT_LENGTH,
  MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES,
  decodeContentSyncPayload,
  decodeContentSyncPayloadChunks,
  encodeContentSyncPayload,
  encodeContentSyncPayloadChunks,
  parseContentSyncPayload,
  reassembleContentSyncPayloadBytes,
  sha256Utf8Content,
  splitContentSyncPayloadBytes,
  type ChapterVersionContentSyncPayload,
  type ProjectManifestContentSyncPayload,
} from "../src/index.js";

const PROJECT_ID = "01890f47-38b1-7a52-8f1d-6df984cc6411";
const CHAPTER_ID = "01890f47-38b1-7a52-8f1d-6df984cc6412";
const VERSION_ID = "01890f47-38b1-7a52-8f1d-6df984cc6413";
const PARENT_VERSION_ID = "01890f47-38b1-7a52-8f1d-6df984cc6414";
const CANDIDATE_ID = "01890f47-38b1-7a52-8f1d-6df984cc6415";
const CREATED_AT = "2026-07-27T01:02:03.000Z";
const UPDATED_AT = "2026-07-27T02:03:04.000Z";

describe("content sync payload", () => {
  it("round-trips a complete project manifest with deterministic canonical JSON", async () => {
    const payload = projectPayload();
    const differentlyOrdered = {
      project: {
        statusBeforeTrash: payload.project.statusBeforeTrash,
        retentionUntil: payload.project.retentionUntil,
        trashedAt: payload.project.trashedAt,
        archivedAt: payload.project.archivedAt,
        updatedAt: payload.project.updatedAt,
        createdAt: payload.project.createdAt,
        deletionGeneration: payload.project.deletionGeneration,
        revision: payload.project.revision,
        status: payload.project.status,
        name: payload.project.name,
        id: payload.project.id,
      },
      objectGeneration: payload.objectGeneration,
      objectId: payload.objectId,
      projectId: payload.projectId,
      objectType: payload.objectType,
      schemaVersion: payload.schemaVersion,
    };

    const encoded = await encodeContentSyncPayload(payload);
    const reorderedEncoded = await encodeContentSyncPayload(differentlyOrdered);
    const decoded = await decodeContentSyncPayload(encoded);

    expect(reorderedEncoded).toEqual(encoded);
    expect(new TextDecoder().decode(encoded)).toBe(
      `{"schemaVersion":1,"objectType":"project_manifest","projectId":"${PROJECT_ID}",` +
        `"objectId":"${PROJECT_ID}","objectGeneration":1,"project":{"id":"${PROJECT_ID}",` +
        `"name":"墨影长篇","status":"active","revision":1,"deletionGeneration":0,` +
        `"createdAt":"${CREATED_AT}","updatedAt":"${CREATED_AT}","archivedAt":null,` +
        `"trashedAt":null,"retentionUntil":null,"statusBeforeTrash":null}}`,
    );
    expect(decoded).toEqual(payload);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(decoded.objectType).toBe("project_manifest");
    if (decoded.objectType === "project_manifest") {
      expect(Object.isFrozen(decoded.project)).toBe(true);
    }
  });

  it("round-trips the complete chapter projection and immutable current version", async () => {
    const payload = await chapterPayload("第一幕\n雨落在旧城。");
    const encoded = await encodeContentSyncPayload(payload);

    await expect(decodeContentSyncPayload(encoded)).resolves.toEqual(payload);
    expect(payload.objectId).toBe(payload.chapter.id);
    expect(payload.versionId).toBe(payload.version.id);
    expect(payload.objectGeneration).toBe(7);
  });

  it("rejects a tampered UTF-8 content checksum", async () => {
    const payload = await chapterPayload("checksum target");

    await expect(
      parseContentSyncPayload({
        ...payload,
        version: {
          ...payload.version,
          contentChecksum: "0".repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      code: "SYNC_VALIDATION_FAILED",
      message: expect.stringContaining("checksum"),
    });
  });

  it("rejects unknown or missing fields, wrong types, NUL, and non-canonical JSON", async () => {
    const payload = await chapterPayload("strict");

    await expect(parseContentSyncPayload({ ...payload, unexpected: true })).rejects.toMatchObject({
      code: "SYNC_VALIDATION_FAILED",
    });
    await expect(
      parseContentSyncPayload({
        ...payload,
        chapter: { ...payload.chapter, unexpected: true },
      }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });
    const withoutVersionId: Record<string, unknown> = { ...payload };
    Reflect.deleteProperty(withoutVersionId, "versionId");
    await expect(parseContentSyncPayload(withoutVersionId)).rejects.toMatchObject({
      code: "SYNC_VALIDATION_FAILED",
    });
    await expect(
      parseContentSyncPayload({ ...payload, objectGeneration: "7" }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });
    await expect(
      parseContentSyncPayload({
        ...payload,
        chapter: { ...payload.chapter, content: "unsafe\u0000content" },
        version: { ...payload.version, content: "unsafe\u0000content" },
      }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });
    await expect(
      decodeContentSyncPayload(
        new TextEncoder().encode(
          ` ${new TextDecoder().decode(await encodeContentSyncPayload(payload))}`,
        ),
      ),
    ).rejects.toMatchObject({
      code: "SYNC_VALIDATION_FAILED",
      message: expect.stringContaining("canonical"),
    });
  });

  it("rejects identifier, generation, revision, sequence, content, and timestamp divergence", async () => {
    const payload = await chapterPayload("coherent");
    const cases: unknown[] = [
      { ...payload, projectId: "01890f47-38b1-7a52-8f1d-6df984cc6499" },
      { ...payload, objectId: PROJECT_ID },
      { ...payload, versionId: PARENT_VERSION_ID },
      { ...payload, objectGeneration: 0 },
      {
        ...payload,
        chapter: { ...payload.chapter, currentVersionId: PARENT_VERSION_ID },
      },
      {
        ...payload,
        chapter: { ...payload.chapter, content: "different" },
      },
      {
        ...payload,
        chapter: { ...payload.chapter, revision: payload.chapter.revision + 1 },
      },
      {
        ...payload,
        version: { ...payload.version, parentVersionId: null },
      },
      {
        ...payload,
        version: {
          ...payload.version,
          createdAt: "2026-07-27T03:03:04.000Z",
        },
      },
    ];

    for (const invalid of cases) {
      await expect(parseContentSyncPayload(invalid)).rejects.toMatchObject({
        code: "SYNC_VALIDATION_FAILED",
      });
    }
  });

  it("enforces project and chapter lifecycle combinations", async () => {
    const activeProject = projectPayload();
    await expect(
      parseContentSyncPayload({
        ...activeProject,
        project: { ...activeProject.project, archivedAt: UPDATED_AT },
      }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });

    const trashedProject: ProjectManifestContentSyncPayload = {
      ...activeProject,
      objectGeneration: 2,
      project: {
        ...activeProject.project,
        status: "trashed",
        revision: 2,
        deletionGeneration: 1,
        updatedAt: UPDATED_AT,
        trashedAt: UPDATED_AT,
        retentionUntil: "2026-08-26T02:03:04.000Z",
        statusBeforeTrash: "active",
      },
    };
    await expect(parseContentSyncPayload(trashedProject)).resolves.toEqual(trashedProject);
    await expect(
      parseContentSyncPayload({ ...trashedProject, objectGeneration: 3 }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });
    await expect(
      parseContentSyncPayload({
        ...trashedProject,
        project: { ...trashedProject.project, deletionGeneration: 2 },
      }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });

    const chapter = await chapterPayload("lifecycle");
    await expect(
      parseContentSyncPayload({
        ...chapter,
        chapter: { ...chapter.chapter, status: "trashed", trashedAt: null },
      }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });
  });

  it("enforces candidate provenance and initial-version parent rules", async () => {
    const initial = await initialChapterPayload("initial");
    await expect(parseContentSyncPayload(initial)).resolves.toEqual(initial);
    await expect(
      parseContentSyncPayload({
        ...initial,
        version: { ...initial.version, parentVersionId: PARENT_VERSION_ID },
      }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });

    const candidate = await chapterPayload("candidate");
    await expect(
      parseContentSyncPayload({
        ...candidate,
        version: {
          ...candidate.version,
          reason: "candidate_accept",
          sourceCandidateId: null,
        },
      }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });
    await expect(
      parseContentSyncPayload({
        ...candidate,
        version: {
          ...candidate.version,
          reason: "manual",
          sourceCandidateId: CANDIDATE_ID,
        },
      }),
    ).rejects.toMatchObject({ code: "SYNC_VALIDATION_FAILED" });
  });

  it("splits on UTF-8 byte boundaries and exactly reassembles multibyte Unicode", async () => {
    const payload = await chapterPayload("墨🙂影e\u0301".repeat(40));
    const encoded = await encodeContentSyncPayload(payload);
    const chunks = splitContentSyncPayloadBytes(encoded, 17);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.byteLength <= 17)).toBe(true);
    for (const chunk of chunks) {
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(chunk)).not.toThrow();
    }
    expect(reassembleContentSyncPayloadBytes(chunks, 17)).toEqual(encoded);
    await expect(decodeContentSyncPayloadChunks(chunks, 17)).resolves.toEqual(payload);
  });

  it("supports exactly 5,000,000 multibyte characters and multiple 4 MiB chunks", async () => {
    const content = "墨".repeat(MAX_CHAPTER_CONTENT_LENGTH);
    const payload = await chapterPayload(content);
    const chunks = await encodeContentSyncPayloadChunks(payload);

    expect(content.length).toBe(5_000_000);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.byteLength <= MAX_ENCRYPTED_CHUNK_PLAINTEXT_BYTES)).toBe(
      true,
    );
    const reassembled = reassembleContentSyncPayloadBytes(chunks);
    await expect(decodeContentSyncPayload(reassembled)).resolves.toEqual(payload);
  }, 30_000);

  it("rejects content above the 5,000,000-character limit", async () => {
    const content = "a".repeat(MAX_CHAPTER_CONTENT_LENGTH + 1);
    const checksum = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const checksumHex = [...new Uint8Array(checksum)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const payload = await chapterPayload("bounded");

    await expect(
      parseContentSyncPayload({
        ...payload,
        chapter: { ...payload.chapter, content },
        version: { ...payload.version, content, contentChecksum: checksumHex },
      }),
    ).rejects.toMatchObject({
      code: "SYNC_VALIDATION_FAILED",
      message: expect.stringContaining("size"),
    });
  });
});

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

async function initialChapterPayload(content: string): Promise<ChapterVersionContentSyncPayload> {
  const payload = await chapterPayload(content);
  return {
    ...payload,
    chapter: {
      ...payload.chapter,
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    version: {
      ...payload.version,
      parentVersionId: null,
      sequence: 1,
      reason: "created",
      createdAt: CREATED_AT,
    },
  };
}
