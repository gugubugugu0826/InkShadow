import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  AesGcmChunkCipher,
  CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
  sha256Utf8Content,
} from "@inkshadow/sync-core";
import { parseUuidV7, type UuidV7 } from "@inkshadow/domain";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  ContentSyncMaterializer,
  type ContentSyncMaterializationOutcome,
} from "./content-sync-materializer";
import {
  IncomingContentDecryptor,
  type IncomingContentCiphertextWork,
} from "./incoming-content-decryptor";
import { OutgoingContentEncryptionBuilder } from "./outgoing-content-encryption-builder";

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

const migration = [
  readMigration("0001_core.sql"),
  readMigration("0015_sync_materialization_authority.sql"),
  `ALTER TABLE chapters ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'standard'
     CHECK (privacy_mode IN ('standard', 'local_only'));
   ALTER TABLE chapters ADD COLUMN privacy_revision INTEGER NOT NULL DEFAULT 1
     CHECK (privacy_revision >= 1);`,
].join("\n");

const PROJECT_ID = id(1);
const CHAPTER_ID = id(2);
const VERSION_ONE_ID = id(3);
const VERSION_TWO_ID = id(4);
const ALTERNATE_VERSION_ID = id(5);
const DEVICE_ID = id(6);
const OTHER_DEVICE_ID = id(7);
const CREATED_AT = "2026-07-28T01:00:00.000Z";
const VERSION_TWO_AT = "2026-07-28T02:00:00.000Z";
const NOW = "2026-07-28T03:00:00.000Z";
const DELETED_AT = "2026-07-29T01:00:00.000Z";
const RETAIN_UNTIL = "2027-07-30T01:00:00.000Z";

beforeAll(() => {
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: textEncoderRealm.originalTextEncoder,
    writable: true,
  });
});

describe("ContentSyncMaterializer", () => {
  let executor: NodeSqliteExecutor;
  let key: CryptoKey;
  let materializer: ContentSyncMaterializer;
  let fixtureSequence: number;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    key = await new AesGcmChunkCipher().generateProjectDataKey();
    materializer = new ContentSyncMaterializer(
      new IncomingContentDecryptor(() => Promise.resolve(key)),
    );
    fixtureSequence = 100;
  });

  afterEach(async () => {
    await executor.close();
  });

  it("materializes a new project and two ordered immutable chapter versions", async () => {
    const project = await buildUpsertWork(projectPayload(), DEVICE_ID, 1);
    const versionOne = await buildUpsertWork(
      await chapterPayload({
        versionId: VERSION_ONE_ID,
        sequence: 1,
        parentVersionId: null,
        content: "first",
        updatedAt: CREATED_AT,
      }),
      DEVICE_ID,
      1,
    );
    const versionTwo = await buildUpsertWork(
      await chapterPayload({
        versionId: VERSION_TWO_ID,
        sequence: 2,
        parentVersionId: VERSION_ONE_ID,
        content: "second",
        updatedAt: VERSION_TWO_AT,
      }),
      DEVICE_ID,
      2,
    );

    expect((await apply(project)).status).toBe("applied");
    expect((await apply(versionOne)).status).toBe("applied");
    expect((await apply(versionTwo)).status).toBe("applied");

    expect(
      await executor.select<{ name: string; status: string }>(
        "SELECT name, status FROM projects WHERE id = ?",
        [PROJECT_ID],
      ),
    ).toEqual([{ name: "InkShadow Sync", status: "active" }]);
    expect(
      await executor.select<{
        content: string;
        revision: number;
        current_version_id: string;
      }>("SELECT content, revision, current_version_id FROM chapters WHERE id = ?", [CHAPTER_ID]),
    ).toEqual([
      {
        content: "second",
        revision: 2,
        current_version_id: VERSION_TWO_ID,
      },
    ]);
    expect(
      await executor.select<{ id: string; sequence: number }>(
        "SELECT id, sequence FROM chapter_versions WHERE chapter_id = ? ORDER BY sequence",
        [CHAPTER_ID],
      ),
    ).toEqual([
      { id: VERSION_ONE_ID, sequence: 1 },
      { id: VERSION_TWO_ID, sequence: 2 },
    ]);
  });

  it("does not overwrite a local-only chapter with an incoming cloud version", async () => {
    const project = await buildUpsertWork(projectPayload(), DEVICE_ID, 1);
    const versionOne = await buildUpsertWork(
      await chapterPayload({
        versionId: VERSION_ONE_ID,
        sequence: 1,
        parentVersionId: null,
        content: "private local text",
        updatedAt: CREATED_AT,
      }),
      DEVICE_ID,
      1,
    );
    const versionTwo = await buildUpsertWork(
      await chapterPayload({
        versionId: VERSION_TWO_ID,
        sequence: 2,
        parentVersionId: VERSION_ONE_ID,
        content: "remote replacement",
        updatedAt: VERSION_TWO_AT,
      }),
      OTHER_DEVICE_ID,
      1,
    );
    expect((await apply(project)).status).toBe("applied");
    expect((await apply(versionOne)).status).toBe("applied");
    await executor.execute(
      "UPDATE chapters SET privacy_mode = 'local_only', privacy_revision = 2 WHERE id = ?",
      [CHAPTER_ID],
    );

    await expect(apply(versionTwo)).resolves.toMatchObject({
      status: "skipped",
      reason: "local_only",
    });
    await expect(
      executor.select<{ content: string; versionId: string; privacyMode: string }>(
        `SELECT content, current_version_id AS versionId, privacy_mode AS privacyMode
         FROM chapters WHERE id = ?`,
        [CHAPTER_ID],
      ),
    ).resolves.toEqual([
      { content: "private local text", versionId: VERSION_ONE_ID, privacyMode: "local_only" },
    ]);
  });

  it("skips duplicate and causally older operations without regressing the chapter", async () => {
    await apply(await buildUpsertWork(projectPayload(), DEVICE_ID, 1));
    const versionOne = await buildUpsertWork(
      await chapterPayload({
        versionId: VERSION_ONE_ID,
        sequence: 1,
        parentVersionId: null,
        content: "first",
        updatedAt: CREATED_AT,
      }),
      DEVICE_ID,
      1,
    );
    const versionTwo = await buildUpsertWork(
      await chapterPayload({
        versionId: VERSION_TWO_ID,
        sequence: 2,
        parentVersionId: VERSION_ONE_ID,
        content: "second",
        updatedAt: VERSION_TWO_AT,
      }),
      DEVICE_ID,
      2,
    );
    await apply(versionOne);
    await apply(versionTwo);

    expect(await apply(versionTwo)).toMatchObject({
      status: "skipped",
      reason: "duplicate",
    });
    expect(await apply(versionOne)).toMatchObject({
      status: "skipped",
      reason: "causally_older",
    });
    expect(
      await executor.select<{ content: string }>("SELECT content FROM chapters WHERE id = ?", [
        CHAPTER_ID,
      ]),
    ).toEqual([{ content: "second" }]);
  });

  it("durably records concurrent operations without storing remote plaintext", async () => {
    await apply(await buildUpsertWork(projectPayload(), DEVICE_ID, 1));
    await apply(
      await buildUpsertWork(
        await chapterPayload({
          versionId: VERSION_ONE_ID,
          sequence: 1,
          parentVersionId: null,
          content: "local branch",
          updatedAt: CREATED_AT,
        }),
        DEVICE_ID,
        1,
      ),
    );
    const remote = await buildUpsertWork(
      await chapterPayload({
        versionId: ALTERNATE_VERSION_ID,
        sequence: 1,
        parentVersionId: null,
        content: "remote secret branch",
        updatedAt: CREATED_AT,
      }),
      OTHER_DEVICE_ID,
      1,
    );

    const outcome = await apply(remote);

    expect(outcome).toMatchObject({
      status: "conflict",
      conflictId: remote.work.operation.operationId,
    });
    const rows = await executor.select<{
      remote_operation_id: string;
      remote_payload_sha256: string;
      local_vector_json: string;
      remote_vector_json: string;
    }>("SELECT * FROM sync_content_conflicts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      remote_operation_id: remote.work.operation.operationId,
      remote_payload_sha256: remote.payloadSha256,
      local_vector_json: JSON.stringify({ [DEVICE_ID]: 1 }),
      remote_vector_json: JSON.stringify({ [OTHER_DEVICE_ID]: 1 }),
    });
    expect(JSON.stringify(rows)).not.toContain("remote secret branch");
  });

  it("treats equal-vector state or payload divergence as a durable conflict", async () => {
    await apply(await buildUpsertWork(projectPayload(), DEVICE_ID, 1));
    await apply(
      await buildUpsertWork(
        await chapterPayload({
          versionId: VERSION_ONE_ID,
          sequence: 1,
          parentVersionId: null,
          content: "stable",
          updatedAt: CREATED_AT,
        }),
        DEVICE_ID,
        1,
      ),
    );
    const divergent = await buildUpsertWork(
      await chapterPayload({
        versionId: ALTERNATE_VERSION_ID,
        sequence: 1,
        parentVersionId: null,
        content: "same vector, different bytes",
        updatedAt: CREATED_AT,
      }),
      DEVICE_ID,
      1,
    );

    expect(await apply(divergent)).toMatchObject({ status: "conflict" });
    expect(
      await executor.select<{ content: string }>("SELECT content FROM chapters WHERE id = ?", [
        CHAPTER_ID,
      ]),
    ).toEqual([{ content: "stable" }]);
  });

  it("accepts an exact historical version during first bootstrap without moving current chapter", async () => {
    await seedProject();
    const firstPayload = await chapterPayload({
      versionId: VERSION_ONE_ID,
      sequence: 1,
      parentVersionId: null,
      content: "historical",
      updatedAt: CREATED_AT,
    });
    const secondPayload = await chapterPayload({
      versionId: VERSION_TWO_ID,
      sequence: 2,
      parentVersionId: VERSION_ONE_ID,
      content: "current local",
      updatedAt: VERSION_TWO_AT,
    });
    await seedChapterHistory(firstPayload.version, secondPayload);
    const historical = await buildUpsertWork(firstPayload, DEVICE_ID, 1);

    expect(await apply(historical)).toMatchObject({
      status: "skipped",
      reason: "historical_business_match",
    });
    expect(
      await executor.select<{ current_version_id: string; content: string }>(
        "SELECT current_version_id, content FROM chapters WHERE id = ?",
        [CHAPTER_ID],
      ),
    ).toEqual([{ current_version_id: VERSION_TWO_ID, content: "current local" }]);
    expect(
      await executor.select<{ version_id: string }>(
        "SELECT version_id FROM sync_materialized_objects WHERE object_id = ?",
        [CHAPTER_ID],
      ),
    ).toEqual([{ version_id: VERSION_ONE_ID }]);
  });

  it("returns a retry outcome when an immutable parent version has not arrived", async () => {
    await apply(await buildUpsertWork(projectPayload(), DEVICE_ID, 1));
    const second = await buildUpsertWork(
      await chapterPayload({
        versionId: VERSION_TWO_ID,
        sequence: 2,
        parentVersionId: VERSION_ONE_ID,
        content: "second before first",
        updatedAt: VERSION_TWO_AT,
      }),
      DEVICE_ID,
      2,
    );

    expect(await apply(second)).toMatchObject({
      status: "retry",
      code: "SYNC_PARENT_VERSION_MISSING",
      missingId: VERSION_ONE_ID,
    });
    expect(await count("chapters")).toBe(0);
    expect(await count("chapter_versions")).toBe(0);
    expect(await count("sync_materialized_objects")).toBe(1);
  });

  it("logically deletes chapters and projects while retaining rows and immutable history", async () => {
    const project = await buildUpsertWork(projectPayload(), DEVICE_ID, 1);
    await apply(project);
    await executor.execute(
      `INSERT INTO project_sync_registrations (
         project_id, account_id, device_id, state, consent_revision, key_version,
         revision, plaintext_bootstrap_completed, last_error_code, created_at,
         updated_at, enabled_at, paused_at
       ) VALUES (?, ?, ?, 'enabled', 1, 1, 1, 1, NULL, ?, ?, ?, NULL)`,
      [PROJECT_ID, id(80), DEVICE_ID, CREATED_AT, NOW, NOW],
    );
    await apply(
      await buildUpsertWork(
        await chapterPayload({
          versionId: VERSION_ONE_ID,
          sequence: 1,
          parentVersionId: null,
          content: "retained history",
          updatedAt: CREATED_AT,
        }),
        DEVICE_ID,
        1,
      ),
    );

    expect((await apply(buildDeleteWork("chapter_version", CHAPTER_ID, 2))).status).toBe("applied");
    expect(
      await executor.select<{ status: string; trashed_at: string }>(
        "SELECT status, trashed_at FROM chapters WHERE id = ?",
        [CHAPTER_ID],
      ),
    ).toEqual([{ status: "trashed", trashed_at: DELETED_AT }]);
    expect(await count("chapter_versions")).toBe(1);

    expect((await apply(buildDeleteWork("project_manifest", PROJECT_ID, 2))).status).toBe(
      "applied",
    );
    expect(
      await executor.select<{
        status: string;
        deletion_generation: number;
        retention_until: string;
      }>("SELECT status, deletion_generation, retention_until FROM projects WHERE id = ?", [
        PROJECT_ID,
      ]),
    ).toEqual([
      {
        status: "trashed",
        deletion_generation: 1,
        retention_until: RETAIN_UNTIL,
      },
    ]);
    expect(await count("project_sync_registrations")).toBe(1);
    expect(await count("chapters")).toBe(1);
  });

  it("rejects a prepared/exact-work swap before any transaction mutation", async () => {
    const first = await buildUpsertWork(projectPayload(), DEVICE_ID, 1);
    const second = await buildUpsertWork(
      {
        ...projectPayload(),
        project: {
          ...projectPayload().project,
          name: "Swapped ciphertext",
          revision: 2,
          updatedAt: VERSION_TWO_AT,
        },
      },
      DEVICE_ID,
      2,
    );
    const prepared = await materializer.prepare(first.work);

    await expect(
      executor.transaction((transaction) =>
        materializer.applyPrepared(transaction, second.work, prepared, NOW),
      ),
    ).rejects.toMatchObject({ code: "SYNC_TRANSFER_MISMATCH" });
    expect(await count("projects")).toBe(0);
    expect(await count("sync_materialized_objects")).toBe(0);
  });

  it("rolls back business rows when the materialization marker write fails", async () => {
    await apply(await buildUpsertWork(projectPayload(), DEVICE_ID, 1));
    const chapter = await buildUpsertWork(
      await chapterPayload({
        versionId: VERSION_ONE_ID,
        sequence: 1,
        parentVersionId: null,
        content: "must roll back",
        updatedAt: CREATED_AT,
      }),
      DEVICE_ID,
      1,
    );
    await executor.execute(
      `CREATE TRIGGER fail_chapter_marker
       BEFORE INSERT ON sync_materialized_objects
       WHEN NEW.object_type = 'chapter_version'
       BEGIN
         SELECT RAISE(ABORT, 'forced marker failure');
       END`,
    );

    await expect(apply(chapter)).rejects.toThrow();
    expect(await count("chapters")).toBe(0);
    expect(await count("chapter_versions")).toBe(0);
    expect(
      await executor.select<{ object_type: string }>(
        "SELECT object_type FROM sync_materialized_objects",
      ),
    ).toEqual([{ object_type: "project_manifest" }]);
  });

  async function apply(fixture: WorkFixture): Promise<ContentSyncMaterializationOutcome> {
    const prepared = await materializer.prepare(fixture.work);
    return executor.transaction((transaction) =>
      materializer.applyPrepared(transaction, fixture.work, prepared, NOW),
    );
  }

  async function buildUpsertWork(
    payload: ProjectPayload | ChapterPayload,
    deviceId: string,
    deviceSequence: number,
  ): Promise<WorkFixture> {
    const operationId = nextId();
    const manifestVersionId = payload.objectType === "project_manifest" ? nextId() : undefined;
    const built = await new OutgoingContentEncryptionBuilder().build({
      key,
      keyVersion: 1,
      deviceId,
      deviceSequence,
      operationId,
      vector: { [deviceId]: deviceSequence },
      createdAt: NOW,
      chunkIdGenerator: { next: () => asUuid(nextId()) },
      payload,
      ...(manifestVersionId === undefined ? {} : { manifestVersionId }),
    });
    return {
      payloadSha256: built.payloadSha256,
      work: {
        operation: built.operation,
        chunks: built.chunks.map(({ chunkId, encrypted }) => ({ chunkId, encrypted })),
        tombstone: null,
      },
    };
  }

  function buildDeleteWork(
    objectType: "project_manifest" | "chapter_version",
    objectId: string,
    objectGeneration: number,
  ): WorkFixture {
    const operationId = nextId();
    const vector = { [DEVICE_ID]: 3 };
    return {
      payloadSha256: null,
      work: {
        operation: {
          operationId,
          projectId: PROJECT_ID,
          deviceId: DEVICE_ID,
          deviceSequence: 3,
          objectType,
          objectId,
          objectGeneration,
          kind: "delete",
          vector,
          encryptedChunkIds: [],
          createdAt: DELETED_AT,
        },
        chunks: [],
        tombstone: {
          projectId: PROJECT_ID,
          objectType,
          objectId,
          objectGeneration,
          deletedByDeviceId: DEVICE_ID,
          vector,
          deletedAt: DELETED_AT,
          retainUntil: RETAIN_UNTIL,
          acknowledgedDeviceIds: [],
        },
      },
    };
  }

  async function seedProject(): Promise<void> {
    const project = projectPayload().project;
    await executor.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at,
         archived_at, trashed_at, retention_until, status_before_trash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        project.id,
        project.name,
        project.status,
        project.revision,
        project.deletionGeneration,
        project.createdAt,
        project.updatedAt,
        project.archivedAt,
        project.trashedAt,
        project.retentionUntil,
        project.statusBeforeTrash,
      ],
    );
  }

  async function seedChapterHistory(
    first: ChapterPayload["version"],
    secondPayload: ChapterPayload,
  ): Promise<void> {
    const chapter = secondPayload.chapter;
    await executor.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, current_version_id,
           created_at, updated_at, trashed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          chapter.id,
          chapter.projectId,
          chapter.title,
          chapter.content,
          chapter.status,
          chapter.revision,
          chapter.currentVersionId,
          chapter.createdAt,
          chapter.updatedAt,
          chapter.trashedAt,
        ],
      );
      for (const version of [first, secondPayload.version]) {
        await transaction.execute(
          `INSERT INTO chapter_versions (
             id, project_id, chapter_id, parent_version_id, sequence, content,
             content_checksum, reason, source_candidate_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            version.id,
            version.projectId,
            version.chapterId,
            version.parentVersionId,
            version.sequence,
            version.content,
            version.contentChecksum,
            version.reason,
            version.sourceCandidateId,
            version.createdAt,
          ],
        );
      }
    });
  }

  async function count(table: string): Promise<number> {
    const rows = await executor.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
    return rows[0]?.count ?? -1;
  }

  function nextId(): string {
    fixtureSequence += 1;
    return id(fixtureSequence);
  }
});

interface WorkFixture {
  readonly work: IncomingContentCiphertextWork;
  readonly payloadSha256: string | null;
}

type ProjectPayload = ReturnType<typeof projectPayload>;
type ChapterPayload = Awaited<ReturnType<typeof chapterPayload>>;

function projectPayload() {
  return {
    schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
    objectType: "project_manifest" as const,
    projectId: PROJECT_ID,
    objectId: PROJECT_ID,
    objectGeneration: 1,
    project: {
      id: PROJECT_ID,
      name: "InkShadow Sync",
      status: "active" as const,
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

async function chapterPayload(input: {
  readonly versionId: string;
  readonly sequence: number;
  readonly parentVersionId: string | null;
  readonly content: string;
  readonly updatedAt: string;
}) {
  return {
    schemaVersion: CONTENT_SYNC_PAYLOAD_SCHEMA_VERSION,
    objectType: "chapter_version" as const,
    projectId: PROJECT_ID,
    objectId: CHAPTER_ID,
    versionId: input.versionId,
    objectGeneration: 2,
    chapter: {
      id: CHAPTER_ID,
      projectId: PROJECT_ID,
      title: "Chapter One",
      content: input.content,
      status: "active" as const,
      revision: input.sequence,
      currentVersionId: input.versionId,
      createdAt: CREATED_AT,
      updatedAt: input.updatedAt,
      trashedAt: null,
    },
    version: {
      id: input.versionId,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      parentVersionId: input.parentVersionId,
      sequence: input.sequence,
      content: input.content,
      contentChecksum: await sha256Utf8Content(input.content),
      reason: input.sequence === 1 ? ("created" as const) : ("manual" as const),
      sourceCandidateId: null,
      createdAt: input.updatedAt,
    },
  };
}

function id(value: number): string {
  return `019fa100-0000-7000-8000-${String(value).padStart(12, "0")}`;
}

function asUuid(value: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
