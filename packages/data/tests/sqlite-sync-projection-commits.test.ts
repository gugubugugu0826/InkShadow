import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  AiCandidate,
  Chapter,
  ChapterVersion,
  Project,
  RecoveryDraft,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AppError,
  type ContentChecksum,
  type IsoUtcTimestamp,
  type Result,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteRepositories, type SqliteRepositories } from "../src/sqlite-repositories.js";
import {
  SyncMaterializationSqliteStore,
  type SyncProjectionJob,
} from "../src/sync-materialization-sqlite-store.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0015_sync_materialization_authority.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0017_sync_projection_account_authority.sql", import.meta.url),
    "utf8",
  ),
  `ALTER TABLE chapters ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'standard'
     CHECK (privacy_mode IN ('standard', 'local_only'));
   ALTER TABLE chapters ADD COLUMN privacy_revision INTEGER NOT NULL DEFAULT 1
     CHECK (privacy_revision >= 1);`,
  readFileSync(
    new URL("../migrations/0048_candidate_application_intents.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0050_candidate_revision_authority.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const ACCOUNT_ID = uuid(900);
const DEVICE_ID = uuid(901);
const WORKER_ID = uuid(902);

describe("SQLite business commits project durable sync jobs atomically", () => {
  let executor: NodeSqliteExecutor;
  let ids: SequenceUuidV7Generator;
  let repositories: SqliteRepositories;
  let syncStore: SyncMaterializationSqliteStore;

  beforeEach(() => {
    executor = new NodeSqliteExecutor(migration);
    ids = new SequenceUuidV7Generator();
    repositories = createSqliteRepositories(executor, {
      syncProjectionIds: ids,
    });
    syncStore = new SyncMaterializationSqliteStore(executor);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("keeps explicitly disabled projects local and does not allocate a cloud job id", async () => {
    const project = makeProject(1, "Local only", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "disabled");

    const fixture = makeChapter(project, 10, 11, "Local plaintext");
    const receipt = expectOk(
      await repositories.contentCommits.createChapter({
        chapter: fixture.chapter,
        initialVersion: fixture.initialVersion,
      }),
    );

    expect(receipt).toEqual({ syncQueued: false });
    expect(ids.calls).toBe(0);
    expect(projectionRows()).toEqual([]);
  });

  it("never allocates a projection job for a local-only chapter", async () => {
    const project = makeProject(1, "Private chapter", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "enabled");
    const fixture = makeChapter(project, 10, 11, "Local plaintext", "local_only");

    const receipt = expectOk(
      await repositories.contentCommits.createChapter({
        chapter: fixture.chapter,
        initialVersion: fixture.initialVersion,
      }),
    );

    expect(receipt).toEqual({ syncQueued: false });
    expect(ids.calls).toBe(0);
    expect(projectionRows()).toEqual([]);
  });

  it("enqueues an enabled chapter creation as a reference-only generation-one job", async () => {
    const project = makeProject(1, "Synced", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "enabled");
    const fixture = makeChapter(project, 10, 11, "Sensitive chapter body");

    const receipt = expectOk(
      await repositories.contentCommits.createChapter({
        chapter: fixture.chapter,
        initialVersion: fixture.initialVersion,
      }),
    );
    const [job] = projectionRows();

    expect(receipt).toEqual({ syncQueued: true });
    expect(job).toMatchObject({
      job_id: uuid(10_000),
      project_id: project.id,
      object_type: "chapter_version",
      object_id: fixture.chapter.id,
      object_generation: 1,
      projection_kind: "upsert",
      version_id: fixture.initialVersion.id,
      source_revision: 1,
      key_version: 7,
      consent_revision: 3,
      device_id: DEVICE_ID,
      status: "queued",
      created_at: atMinute(1),
      next_attempt_at: atMinute(1),
    });
    expect(JSON.stringify(job)).not.toContain(fixture.chapter.title);
    expect(JSON.stringify(job)).not.toContain(fixture.chapter.content);
  });

  it("preserves v1 and v2 jobs and leases the chapter versions in sequence", async () => {
    const project = makeProject(1, "Ordered", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "enabled");
    const fixture = makeChapter(project, 10, 11, "Version one");
    expectOk(
      await repositories.contentCommits.createChapter({
        chapter: fixture.chapter,
        initialVersion: fixture.initialVersion,
      }),
    );

    const draft = makeDraft(project, fixture.chapter, 20, "Version two", 2);
    expectOk(await repositories.recoveryDrafts.upsert(draft));
    const versionId = uuid(12);
    const savedChapter = expectOk(
      fixture.chapter.saveContent({
        content: draft.content,
        expectedRevision: 1,
        newVersionId: versionId,
        now: atMinute(3),
      }),
    );
    const secondVersion = makeVersion({
      id: versionId,
      projectId: project.id,
      chapterId: fixture.chapter.id,
      parentVersionId: fixture.initialVersion.id,
      sequence: 2,
      content: draft.content,
      reason: "manual",
      sourceCandidateId: null,
      createdAt: atMinute(3),
    });
    const receipt = expectOk(
      await repositories.contentCommits.saveChapter({
        chapter: savedChapter,
        version: secondVersion,
        recoveryDraftId: draft.id,
        expectedChapterRevision: 1,
      }),
    );

    expect(receipt).toEqual({ syncQueued: true });
    expect(
      projectionRows().map(({ version_id, source_revision, status }) => ({
        versionId: version_id,
        sourceRevision: source_revision,
        status,
      })),
    ).toEqual([
      { versionId: fixture.initialVersion.id, sourceRevision: 1, status: "queued" },
      { versionId: secondVersion.id, sourceRevision: 2, status: "queued" },
    ]);

    const firstLease = expectPresent(
      expectOk(
        await syncStore.claimProjectionJob({
          projectId: project.id,
          leaseOwnerId: WORKER_ID,
          leaseToken: uuid(910),
          leasedAt: atMinute(10),
          leaseExpiresAt: atMinute(20),
        }),
      ),
    );
    expect(firstLease.versionId).toBe(fixture.initialVersion.id);

    expect(
      expectOk(
        await syncStore.claimProjectionJob({
          projectId: project.id,
          leaseOwnerId: WORKER_ID,
          leaseToken: uuid(911),
          leasedAt: atMinute(11),
          leaseExpiresAt: atMinute(20),
        }),
      ),
    ).toBeNull();

    expectOk(
      await syncStore.completeProjectionJob({
        jobId: firstLease.jobId,
        expectedRevision: firstLease.revision,
        leaseOwnerId: WORKER_ID,
        leaseToken: expectPresent(firstLease.leaseToken),
        operationId: uuid(920),
        completedAt: atMinute(12),
      }),
    );
    const secondLease = expectPresent(
      expectOk(
        await syncStore.claimProjectionJob({
          projectId: project.id,
          leaseOwnerId: WORKER_ID,
          leaseToken: uuid(912),
          leasedAt: atMinute(13),
          leaseExpiresAt: atMinute(20),
        }),
      ),
    );
    expect(secondLease.versionId).toBe(secondVersion.id);
  });

  it("queues a restored recovery version in the same atomic chapter commit", async () => {
    const project = makeProject(1, "Recovery", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "enabled");
    const fixture = makeChapter(project, 10, 11, "Version one");
    expectOk(
      await repositories.contentCommits.createChapter({
        chapter: fixture.chapter,
        initialVersion: fixture.initialVersion,
      }),
    );
    const versionId = uuid(12);
    const restoredChapter = expectOk(
      fixture.chapter.saveContent({
        content: "Recovered historical content",
        expectedRevision: 1,
        newVersionId: versionId,
        now: atMinute(3),
      }),
    );
    const restoredVersion = makeVersion({
      id: versionId,
      projectId: project.id,
      chapterId: fixture.chapter.id,
      parentVersionId: fixture.initialVersion.id,
      sequence: 2,
      content: restoredChapter.content,
      reason: "recovery",
      sourceCandidateId: null,
      createdAt: atMinute(3),
    });

    const receipt = expectOk(
      await repositories.contentCommits.restoreChapterVersion({
        chapter: restoredChapter,
        version: restoredVersion,
        expectedChapterRevision: 1,
      }),
    );

    expect(receipt).toEqual({ syncQueued: true });
    expect(
      projectionRows().map(({ version_id, source_revision }) => ({
        versionId: version_id,
        sourceRevision: source_revision,
      })),
    ).toEqual([
      { versionId: fixture.initialVersion.id, sourceRevision: 1 },
      { versionId: restoredVersion.id, sourceRevision: 2 },
    ]);
  });

  it("queues candidate acceptance against the generation after a deleted marker", async () => {
    const project = makeProject(1, "Candidate", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "enabled");
    const fixture = makeChapter(project, 10, 11, "Version one");
    expectOk(
      await repositories.contentCommits.createChapter({
        chapter: fixture.chapter,
        initialVersion: fixture.initialVersion,
      }),
    );
    expectOk(
      await syncStore.writeMaterializedObject({
        object: {
          projectId: project.id,
          objectType: "chapter_version",
          objectId: fixture.chapter.id,
          objectGeneration: 2,
          versionId: null,
          vector: { [DEVICE_ID]: 2 },
          payloadSha256: null,
          sourceOperationId: uuid(930),
          sourceDeviceId: DEVICE_ID,
          sourceDeviceSequence: 2,
          state: "deleted",
          materializedAt: atMinute(3),
        },
        expectedSourceOperationId: null,
      }),
    );

    const readyCandidate = makeReadyCandidate(project, fixture.chapter, fixture.initialVersion, 30);
    expectOk(await repositories.aiCandidates.create(readyCandidate));
    const acceptedCandidate = expectOk(readyCandidate.accept(atMinute(5)));
    const acceptedVersionId = uuid(12);
    const acceptedChapter = expectOk(
      fixture.chapter.saveContent({
        content: readyCandidate.content,
        expectedRevision: 1,
        newVersionId: acceptedVersionId,
        now: atMinute(5),
      }),
    );
    const acceptedVersion = makeVersion({
      id: acceptedVersionId,
      projectId: project.id,
      chapterId: fixture.chapter.id,
      parentVersionId: fixture.initialVersion.id,
      sequence: 2,
      content: readyCandidate.content,
      reason: "candidate_accept",
      sourceCandidateId: readyCandidate.id,
      createdAt: atMinute(5),
    });

    const receipt = expectOk(
      await repositories.contentCommits.acceptCandidate({
        chapter: acceptedChapter,
        version: acceptedVersion,
        candidate: acceptedCandidate,
        expectedChapterRevision: 1,
        expectedCandidateStatus: "ready",
        expectedCandidateRevision: readyCandidate.revision,
      }),
    );
    const acceptedJob = projectionRows().find(
      ({ version_id }) => version_id === acceptedVersion.id,
    );

    expect(receipt).toEqual({ syncQueued: true });
    expect(acceptedJob).toMatchObject({
      object_id: fixture.chapter.id,
      object_generation: 3,
      version_id: acceptedVersion.id,
      source_revision: 2,
      created_at: atMinute(5),
      next_attempt_at: atMinute(5),
    });
  });

  it("enqueues an enabled project rename with manifest identity and lifecycle generation", async () => {
    const project = makeProject(1, "Before rename", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "enabled");
    const renamed = expectOk(project.rename("After rename", atMinute(2)));

    expectOk(await repositories.projects.save(renamed, 1));
    expect(projectionRows()).toEqual([
      expect.objectContaining({
        project_id: project.id,
        object_type: "project_manifest",
        object_id: project.id,
        object_generation: 1,
        projection_kind: "upsert",
        version_id: project.id,
        source_revision: 2,
        created_at: atMinute(2),
        next_attempt_at: atMinute(2),
      }),
    ]);
  });

  it("queues an even-generation tombstone for project trash and a new odd upsert on restore", async () => {
    const project = makeProject(1, "Lifecycle sync", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "enabled");
    const trashed = expectOk(
      project.trash({
        now: atMinute(2),
        retentionUntil: atMinute(30),
      }),
    );

    expectOk(await repositories.projects.save(trashed, 1));
    expect(projectionRows()).toEqual([
      expect.objectContaining({
        project_id: project.id,
        object_type: "project_manifest",
        object_generation: 2,
        projection_kind: "delete",
        version_id: null,
        source_revision: 2,
      }),
    ]);

    const restored = expectOk(trashed.restore(atMinute(3)));
    expectOk(await repositories.projects.save(restored, 2));
    expect(projectionRows()).toEqual([
      expect.objectContaining({
        object_generation: 2,
        projection_kind: "delete",
        status: "queued",
      }),
      expect.objectContaining({
        object_generation: 3,
        projection_kind: "upsert",
        version_id: project.id,
        source_revision: 3,
        status: "queued",
      }),
    ]);
  });

  it("rolls back chapter creation and project rename when durable enqueue fails", async () => {
    const project = makeProject(1, "Before failure", 0);
    expectOk(await repositories.projects.create(project));
    await seedRegistration(project.id, "enabled");
    executor.database.exec(`
      CREATE TRIGGER reject_sync_projection_job
      BEFORE INSERT ON sync_projection_jobs
      BEGIN
        SELECT RAISE(ABORT, 'injected projection failure');
      END;
    `);

    const fixture = makeChapter(project, 10, 11, "Must roll back");
    expectErrorCode(
      await repositories.contentCommits.createChapter({
        chapter: fixture.chapter,
        initialVersion: fixture.initialVersion,
      }),
      "REPOSITORY_ERROR",
    );
    expect(countRows("chapters")).toBe(0);
    expect(countRows("chapter_versions")).toBe(0);

    const renamed = expectOk(project.rename("Should not persist", atMinute(2)));
    expectErrorCode(await repositories.projects.save(renamed, 1), "REPOSITORY_ERROR");
    expect(expectPresent(expectOk(await repositories.projects.findById(project.id))).name).toBe(
      project.name,
    );
    expect(projectionRows()).toEqual([]);
  });

  async function seedRegistration(projectId: UuidV7, state: "enabled" | "disabled"): Promise<void> {
    const enabled = state === "enabled";
    await executor.execute(
      `INSERT INTO project_sync_registrations (
         project_id,
         account_id,
         device_id,
         state,
         consent_revision,
         key_version,
         revision,
         plaintext_bootstrap_completed,
         created_at,
         updated_at,
         enabled_at
       ) VALUES (?, ?, ?, ?, 3, 7, 1, ?, ?, ?, ?)`,
      [
        projectId,
        ACCOUNT_ID,
        DEVICE_ID,
        state,
        enabled ? 1 : 0,
        atMinute(0),
        atMinute(0),
        enabled ? atMinute(0) : null,
      ],
    );
    if (enabled) {
      await executor.execute(
        `INSERT INTO sync_materialized_objects (
           project_id, object_type, object_id, object_generation, version_id,
           vector_json, payload_sha256, source_operation_id, source_device_id,
           source_device_sequence, state, materialized_at
         ) VALUES (?, 'project_manifest', ?, 1, ?, ?, ?, ?, ?, 1, 'present', ?)`,
        [
          projectId,
          projectId,
          projectId,
          JSON.stringify({ [DEVICE_ID]: 1 }),
          "f".repeat(64),
          uuid(990),
          DEVICE_ID,
          atMinute(0),
        ],
      );
    }
  }

  function projectionRows(): ProjectionJobRow[] {
    return executor.database
      .prepare(
        `SELECT
           job_id,
           project_id,
           object_type,
           object_id,
           object_generation,
           projection_kind,
           version_id,
           source_revision,
           key_version,
           consent_revision,
           device_id,
           status,
           created_at,
           next_attempt_at
         FROM sync_projection_jobs
         ORDER BY source_revision, created_at, job_id`,
      )
      .all() as unknown as ProjectionJobRow[];
  }

  function countRows(table: "chapters" | "chapter_versions"): number {
    const row = executor.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }
});

interface ProjectionJobRow {
  readonly job_id: string;
  readonly project_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly projection_kind: string;
  readonly version_id: string | null;
  readonly source_revision: number;
  readonly key_version: number;
  readonly consent_revision: number;
  readonly device_id: string;
  readonly status: SyncProjectionJob["status"];
  readonly created_at: string;
  readonly next_attempt_at: string | null;
}

class SequenceUuidV7Generator implements UuidV7Generator {
  public calls = 0;

  public next(): UuidV7 {
    const id = uuid(10_000 + this.calls);
    this.calls += 1;
    return id;
  }
}

function makeProject(idSequence: number, name: string, minute: number): Project {
  return expectOk(
    Project.create({
      id: uuid(idSequence),
      name,
      now: atMinute(minute),
    }),
  );
}

function makeChapter(
  project: Project,
  chapterIdSequence: number,
  versionIdSequence: number,
  content: string,
  privacyMode: "standard" | "local_only" = "standard",
): { readonly chapter: Chapter; readonly initialVersion: ChapterVersion } {
  const chapterId = uuid(chapterIdSequence);
  const versionId = uuid(versionIdSequence);
  const chapter = expectOk(
    Chapter.create({
      id: chapterId,
      projectId: project.id,
      title: "Chapter title",
      content,
      privacyMode,
      initialVersionId: versionId,
      now: atMinute(1),
    }),
  );
  return {
    chapter,
    initialVersion: makeVersion({
      id: versionId,
      projectId: project.id,
      chapterId,
      parentVersionId: null,
      sequence: 1,
      content,
      reason: "created",
      sourceCandidateId: null,
      createdAt: atMinute(1),
    }),
  };
}

function makeVersion(input: {
  readonly id: UuidV7;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly parentVersionId: UuidV7 | null;
  readonly sequence: number;
  readonly content: string;
  readonly reason: "created" | "manual" | "candidate_accept" | "recovery";
  readonly sourceCandidateId: UuidV7 | null;
  readonly createdAt: IsoUtcTimestamp;
}): ChapterVersion {
  return expectOk(
    ChapterVersion.create({
      ...input,
      contentChecksum: checksum(input.content),
    }),
  );
}

function makeDraft(
  project: Project,
  chapter: Chapter,
  idSequence: number,
  content: string,
  minute: number,
): RecoveryDraft {
  return expectOk(
    RecoveryDraft.create({
      id: uuid(idSequence),
      projectId: project.id,
      chapterId: chapter.id,
      baseRevision: chapter.revision,
      content,
      cursorOffset: content.length,
      now: atMinute(minute),
    }),
  );
}

function makeReadyCandidate(
  project: Project,
  chapter: Chapter,
  initialVersion: ChapterVersion,
  idSequence: number,
): AiCandidate {
  const streaming = expectOk(
    AiCandidate.createStreaming({
      id: uuid(idSequence),
      projectId: project.id,
      chapterId: chapter.id,
      source: "generate",
      baseVersionId: initialVersion.id,
      now: atMinute(3),
    }),
  );
  const content = "Accepted candidate text";
  return expectOk(streaming.markReady(content, checksum(content), atMinute(4)));
}

function uuid(sequence: number): UuidV7 {
  const tail = sequence.toString(16).padStart(12, "0");
  return expectOk(parseUuidV7(`019fa003-2000-7000-8000-${tail}`));
}

function atMinute(minute: number): IsoUtcTimestamp {
  return expectOk(parseIsoUtcTimestamp(new Date(Date.UTC(2026, 6, 28, 1, minute)).toISOString()));
}

function checksum(content: string): ContentChecksum {
  return expectOk(parseContentChecksum(createHash("sha256").update(content, "utf8").digest("hex")));
}

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function expectErrorCode(result: Result<unknown, AppError>, expectedCode: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected ${expectedCode}, but the operation succeeded.`);
  }
  expect(result.error.code).toBe(expectedCode);
}

function expectPresent<Value>(value: Value | null): Value {
  expect(value).not.toBeNull();
  if (value === null) {
    throw new Error("Expected a value.");
  }
  return value;
}
