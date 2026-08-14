import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AcceptCandidateCommit } from "@inkshadow/application";
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
} from "@inkshadow/domain";
import {
  Task,
  createTaskFailure,
  parseUuidV7 as parseTaskUuidV7,
  type CreateTaskInput,
} from "@inkshadow/task-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteRepositories, type SqliteRepositories } from "../src/sqlite-repositories.js";
import { SqliteTaskRepository } from "../src/task-sqlite-repositories.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0002_tasks_notifications.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0048_candidate_application_intents.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0050_candidate_revision_authority.sql", import.meta.url),
    "utf8",
  ),
  `ALTER TABLE chapters ADD COLUMN privacy_mode TEXT NOT NULL DEFAULT 'standard'
     CHECK (privacy_mode IN ('standard', 'local_only'));
   ALTER TABLE chapters ADD COLUMN privacy_revision INTEGER NOT NULL DEFAULT 1
     CHECK (privacy_revision >= 1);`,
].join("\n");

describe("SQLite repositories with node:sqlite", () => {
  let executor: NodeSqliteExecutor;
  let repositories: SqliteRepositories;

  beforeEach(() => {
    executor = new NodeSqliteExecutor(migration);
    repositories = createSqliteRepositories(executor);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("enforces visible project-name uniqueness through trash and restore", async () => {
    const original = makeProject(1, "InkShadow", 0);
    expectOk(await repositories.projects.create(original));

    const duplicate = makeProject(2, "inkshadow", 1);
    expectErrorCode(await repositories.projects.create(duplicate), "PROJECT_NAME_CONFLICT");

    const archived = expectOk(original.archive(atMinute(2)));
    expectOk(await repositories.projects.save(archived, 1));
    const trashed = expectOk(
      archived.trash({
        now: atMinute(3),
        retentionUntil: atMinute(120),
      }),
    );
    expectOk(await repositories.projects.save(trashed, 2));

    expectOk(await repositories.projects.create(duplicate));

    const restored = expectOk(trashed.restore(atMinute(4)));
    expectErrorCode(await repositories.projects.save(restored, 3), "PROJECT_NAME_CONFLICT");

    const stillTrashed = expectPresent(expectOk(await repositories.projects.findById(original.id)));
    expect(stillTrashed.toSnapshot()).toMatchObject({
      status: "trashed",
      revision: 3,
      deletionGeneration: 1,
    });

    const duplicateInTrash = expectOk(
      duplicate.trash({
        now: atMinute(5),
        retentionUntil: atMinute(120),
      }),
    );
    expectOk(await repositories.projects.save(duplicateInTrash, 1));
    expectOk(await repositories.projects.save(restored, 3));

    const persisted = expectPresent(expectOk(await repositories.projects.findById(original.id)));
    expect(persisted.toSnapshot()).toMatchObject({
      name: "InkShadow",
      status: "archived",
      revision: 4,
      deletionGeneration: 2,
      archivedAt: atMinute(2),
      trashedAt: null,
      retentionUntil: null,
      statusBeforeTrash: null,
    });
    expect(expectOk(await repositories.projects.nameExists("INKSHADOW", null))).toBe(true);
  });

  it("rejects stale project saves with optimistic concurrency", async () => {
    const project = makeProject(1, "初始项目", 0);
    expectOk(await repositories.projects.create(project));

    const firstWriter = expectOk(project.rename("第一位作者", atMinute(1)));
    const staleWriter = expectOk(project.rename("第二位作者", atMinute(2)));

    expectOk(await repositories.projects.save(firstWriter, 1));
    expectErrorCode(await repositories.projects.save(staleWriter, 1), "VERSION_CONFLICT");

    const persisted = expectPresent(expectOk(await repositories.projects.findById(project.id)));
    expect(persisted.toSnapshot()).toMatchObject({
      name: "第一位作者",
      revision: 2,
      updatedAt: atMinute(1),
    });
  });

  it("creates a chapter and its initial version in one transaction", async () => {
    const fixture = await createChapterFixture();

    const chapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const versions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );

    expect(chapter.toSnapshot()).toEqual(fixture.chapter.toSnapshot());
    expect(chapter.toSnapshot()).toMatchObject({
      privacyMode: "standard",
      privacyRevision: 1,
    });
    expect(versions.map((version) => version.toSnapshot())).toEqual([
      fixture.initialVersion.toSnapshot(),
    ]);
    expect(executor.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("loads project privacy authority without selecting chapter正文", async () => {
    const fixture = await createChapterFixture();
    executor.database
      .prepare(
        `UPDATE chapters
         SET privacy_mode = 'local_only', privacy_revision = 2
         WHERE id = ?`,
      )
      .run(fixture.chapter.id);

    const snapshots = expectOk(
      await repositories.chapters.listPrivacyAuthorityByProjectId(fixture.project.id),
    );

    expect(snapshots).toEqual([
      {
        chapterId: fixture.chapter.id,
        currentVersionId: fixture.initialVersion.id,
        chapterRevision: 1,
        privacyRevision: 2,
        privacyMode: "local_only",
        status: "active",
      },
    ]);
    expect(Object.hasOwn(snapshots[0] ?? {}, "content")).toBe(false);
    expect(JSON.stringify(snapshots)).not.toContain(fixture.chapter.content);
  });

  it("rolls back chapter creation when the initial version cannot commit", async () => {
    const project = makeProject(1, "原子创建", 0);
    expectOk(await repositories.projects.create(project));

    const chapterId = uuid(10);
    const initialVersionId = uuid(11);
    const chapter = expectOk(
      Chapter.create({
        id: chapterId,
        projectId: project.id,
        title: "第一章",
        content: "初始正文",
        initialVersionId,
        now: atMinute(1),
      }),
    );
    const versionForAnotherChapter = makeVersion({
      id: initialVersionId,
      projectId: project.id,
      chapterId: uuid(99),
      parentVersionId: null,
      sequence: 1,
      content: "初始正文",
      reason: "created",
      sourceCandidateId: null,
      createdAt: atMinute(1),
    });

    expectErrorCode(
      await repositories.contentCommits.createChapter({
        chapter,
        initialVersion: versionForAnotherChapter,
      }),
      "REPOSITORY_ERROR",
    );

    const chapterCount = executor.database
      .prepare("SELECT count(*) AS count FROM chapters")
      .get() as { count: number };
    const versionCount = executor.database
      .prepare("SELECT count(*) AS count FROM chapter_versions")
      .get() as { count: number };
    expect(chapterCount.count).toBe(0);
    expect(versionCount.count).toBe(0);
  });

  it("upserts one recovery draft per chapter", async () => {
    const fixture = await createChapterFixture();
    const draft = expectOk(
      RecoveryDraft.create({
        id: uuid(20),
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
        baseRevision: fixture.chapter.revision,
        content: "尚未保存",
        cursorOffset: 4,
        now: atMinute(2),
      }),
    );
    expectOk(await repositories.recoveryDrafts.upsert(draft));

    const updated = expectOk(draft.update("尚未保存的正文", "尚未保存的正文".length, atMinute(3)));
    expectOk(await repositories.recoveryDrafts.upsert(updated));

    const persisted = expectPresent(
      expectOk(await repositories.recoveryDrafts.findByChapterId(fixture.chapter.id)),
    );
    expect(persisted.toSnapshot()).toEqual(updated.toSnapshot());

    const count = executor.database
      .prepare("SELECT count(*) AS count FROM recovery_drafts WHERE chapter_id = ?")
      .get(fixture.chapter.id) as { count: number };
    expect(count.count).toBe(1);
  });

  it("persists a domain-valid UTF-16 recovery cursor", async () => {
    const fixture = await createChapterFixture();
    const content = "初稿🙂";
    const draft = expectOk(
      RecoveryDraft.create({
        id: uuid(20),
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
        baseRevision: fixture.chapter.revision,
        content,
        cursorOffset: content.length,
        now: atMinute(2),
      }),
    );

    expectOk(await repositories.recoveryDrafts.upsert(draft));
    const persisted = expectPresent(
      expectOk(await repositories.recoveryDrafts.findByChapterId(fixture.chapter.id)),
    );
    expect(persisted.toSnapshot().cursorOffset).toBe(content.length);
  });

  it("atomically saves a chapter version and deletes its recovery draft", async () => {
    const fixture = await createChapterFixture();
    const draft = expectOk(
      RecoveryDraft.create({
        id: uuid(20),
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
        baseRevision: fixture.chapter.revision,
        content: "第二版正文",
        cursorOffset: 5,
        now: atMinute(2),
      }),
    );
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
    const version = makeVersion({
      id: versionId,
      projectId: fixture.project.id,
      chapterId: fixture.chapter.id,
      parentVersionId: fixture.initialVersion.id,
      sequence: 2,
      content: draft.content,
      reason: "manual",
      sourceCandidateId: null,
      createdAt: atMinute(3),
    });

    expectOk(
      await repositories.contentCommits.saveChapter({
        chapter: savedChapter,
        version,
        recoveryDraftId: draft.id,
        expectedChapterRevision: 1,
      }),
    );

    const persistedChapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const versions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    const persistedDraft = expectOk(
      await repositories.recoveryDrafts.findByChapterId(fixture.chapter.id),
    );
    expect(persistedChapter.toSnapshot()).toMatchObject({
      content: "第二版正文",
      revision: 2,
      currentVersionId: versionId,
    });
    expect(versions.map((item) => item.sequence)).toEqual([2, 1]);
    expect(persistedDraft).toBeNull();
  });

  it("rolls back the version and chapter update when final draft deletion fails", async () => {
    const fixture = await createChapterFixture();
    const draft = expectOk(
      RecoveryDraft.create({
        id: uuid(20),
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
        baseRevision: fixture.chapter.revision,
        content: "不能部分提交",
        cursorOffset: 6,
        now: atMinute(2),
      }),
    );
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
    const version = makeVersion({
      id: versionId,
      projectId: fixture.project.id,
      chapterId: fixture.chapter.id,
      parentVersionId: fixture.initialVersion.id,
      sequence: 2,
      content: draft.content,
      reason: "manual",
      sourceCandidateId: null,
      createdAt: atMinute(3),
    });

    expectErrorCode(
      await repositories.contentCommits.saveChapter({
        chapter: savedChapter,
        version,
        recoveryDraftId: uuid(999),
        expectedChapterRevision: 1,
      }),
      "RECOVERY_DRAFT_NOT_FOUND",
    );

    const persistedChapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const versions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    const persistedDraft = expectPresent(
      expectOk(await repositories.recoveryDrafts.findByChapterId(fixture.chapter.id)),
    );
    expect(persistedChapter.toSnapshot()).toEqual(fixture.chapter.toSnapshot());
    expect(versions.map((item) => item.sequence)).toEqual([1]);
    expect(persistedDraft.toSnapshot()).toEqual(draft.toSnapshot());
  });

  it("restores by appending a recovery version and keeps all older versions readable", async () => {
    const fixture = await createChapterFixture();
    const second = makeRecoveryTransition(
      fixture.chapter,
      uuid(12),
      "Current edition",
      atMinute(2),
    );
    expectOk(
      await repositories.contentCommits.restoreChapterVersion({
        ...second,
        expectedChapterRevision: 1,
      }),
    );
    const restored = makeRecoveryTransition(
      second.chapter,
      uuid(13),
      fixture.initialVersion.toSnapshot().content,
      atMinute(3),
    );

    expectOk(
      await repositories.contentCommits.restoreChapterVersion({
        ...restored,
        expectedChapterRevision: 2,
      }),
    );

    const persistedChapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const versions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    expect(persistedChapter.toSnapshot()).toMatchObject({
      content: fixture.initialVersion.toSnapshot().content,
      revision: 3,
      currentVersionId: restored.version.id,
    });
    expect(versions.map((version) => version.sequence)).toEqual([3, 2, 1]);
    expect(
      expectPresent(
        expectOk(await repositories.chapterVersions.findVersionById(fixture.initialVersion.id)),
      ).toSnapshot(),
    ).toEqual(fixture.initialVersion.toSnapshot());
    expect(
      expectPresent(
        expectOk(await repositories.chapterVersions.findVersionById(second.version.id)),
      ).toSnapshot().content,
    ).toBe("Current edition");
  });

  it("rolls an inserted recovery version back when the chapter CAS is stale", async () => {
    const fixture = await createChapterFixture();
    const second = makeRecoveryTransition(
      fixture.chapter,
      uuid(12),
      "Current edition",
      atMinute(2),
    );
    expectOk(
      await repositories.contentCommits.restoreChapterVersion({
        ...second,
        expectedChapterRevision: 1,
      }),
    );
    const stale = makeRecoveryTransition(
      second.chapter,
      uuid(13),
      fixture.initialVersion.toSnapshot().content,
      atMinute(3),
    );

    expectErrorCode(
      await repositories.contentCommits.restoreChapterVersion({
        ...stale,
        expectedChapterRevision: 1,
      }),
      "VERSION_CONFLICT",
    );

    const persistedChapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const versions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    expect(persistedChapter.toSnapshot()).toEqual(second.chapter.toSnapshot());
    expect(versions.map((version) => version.sequence)).toEqual([2, 1]);
    expect(
      expectOk(await repositories.chapterVersions.findVersionById(stale.version.id)),
    ).toBeNull();
  });

  it("rolls an inserted recovery version back after a mid-transaction storage failure", async () => {
    const fixture = await createChapterFixture();
    const transition = makeRecoveryTransition(
      fixture.chapter,
      uuid(12),
      "Restored edition",
      atMinute(2),
    );
    executor.database.exec(`
      CREATE TRIGGER fail_chapter_restore
      BEFORE UPDATE ON chapters
      BEGIN
        SELECT RAISE(ABORT, 'injected restore failure');
      END;
    `);

    expectErrorCode(
      await repositories.contentCommits.restoreChapterVersion({
        ...transition,
        expectedChapterRevision: 1,
      }),
      "REPOSITORY_ERROR",
    );

    const persistedChapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const versions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    expect(persistedChapter.toSnapshot()).toEqual(fixture.chapter.toSnapshot());
    expect(versions.map((version) => version.sequence)).toEqual([1]);
    expect(
      expectOk(await repositories.chapterVersions.findVersionById(transition.version.id)),
    ).toBeNull();
  });

  it("keeps a ready AI candidate isolated until acceptance, then commits all state", async () => {
    const fixture = await createChapterFixture();
    const candidate = makeReadyCandidate(fixture, 30, "候选正文");
    expectOk(await repositories.aiCandidates.create(candidate));

    const beforeAcceptance = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    expect(beforeAcceptance.toSnapshot()).toEqual(fixture.chapter.toSnapshot());
    expect(
      expectPresent(expectOk(await repositories.aiCandidates.findById(candidate.id))).status,
    ).toBe("ready");

    const acceptedCandidate = expectOk(candidate.accept(atMinute(4)));
    const versionId = uuid(12);
    const acceptedChapter = expectOk(
      fixture.chapter.saveContent({
        content: candidate.content,
        expectedRevision: 1,
        newVersionId: versionId,
        now: atMinute(4),
      }),
    );
    const acceptedVersion = makeVersion({
      id: versionId,
      projectId: fixture.project.id,
      chapterId: fixture.chapter.id,
      parentVersionId: fixture.initialVersion.id,
      sequence: 2,
      content: candidate.content,
      reason: "candidate_accept",
      sourceCandidateId: candidate.id,
      createdAt: atMinute(4),
    });

    expectOk(
      await repositories.contentCommits.acceptCandidate({
        chapter: acceptedChapter,
        version: acceptedVersion,
        candidate: acceptedCandidate,
        expectedChapterRevision: 1,
        expectedCandidateStatus: "ready",
        expectedCandidateRevision: candidate.revision,
      }),
    );

    const persistedChapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const persistedCandidate = expectPresent(
      expectOk(await repositories.aiCandidates.findById(candidate.id)),
    );
    const versions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    expect(persistedChapter.toSnapshot()).toMatchObject({
      content: "候选正文",
      revision: 2,
      currentVersionId: versionId,
    });
    expect(persistedCandidate.toSnapshot()).toMatchObject({
      status: "accepted",
      decidedAt: atMinute(4),
    });
    expect(versions[0]?.toSnapshot()).toMatchObject({
      reason: "candidate_accept",
      sourceCandidateId: candidate.id,
    });
  });

  it("reloads revised fragment content and its exact task anchor without changing正文", async () => {
    const fixture = await createChapterFixture();
    const streaming = expectOk(
      AiCandidate.createStreaming({
        id: uuid(31),
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
        source: "generate",
        baseVersionId: fixture.initialVersion.id,
        now: atMinute(2),
        applicationIntent: {
          task: "continuation",
          application: "insert_at_cursor",
          payload: "fragment",
          startUtf16: fixture.chapter.content.length,
          endUtf16: fixture.chapter.content.length,
        },
      }),
    );
    const ready = expectOk(streaming.markReady("最初片段", checksum("最初片段"), atMinute(3)));
    expectOk(await repositories.aiCandidates.create(ready));
    const revised = expectOk(
      ready.reviseReadyContent("作者保存的片段", checksum("作者保存的片段"), atMinute(4)),
    );
    expectOk(
      await repositories.aiCandidates.save(revised, {
        status: "ready",
        revision: ready.revision,
      }),
    );

    const reopenedRepositories = createSqliteRepositories(executor);
    const reloaded = expectPresent(
      expectOk(await reopenedRepositories.aiCandidates.findById(revised.id)),
    );
    expect(reloaded.toSnapshot()).toMatchObject({
      content: "作者保存的片段",
      status: "ready",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: fixture.chapter.content.length,
        endUtf16: fixture.chapter.content.length,
      },
    });
    expect(
      expectPresent(expectOk(await reopenedRepositories.chapters.findById(fixture.chapter.id)))
        .content,
    ).toBe(fixture.chapter.content);
    expect(
      expectOk(await reopenedRepositories.chapterVersions.listByChapterId(fixture.chapter.id)),
    ).toHaveLength(1);
  });

  it("commits the accepted version and its recovery task atomically before returning", async () => {
    const taskId = uuid(90);
    repositories = createSqliteRepositories(executor, {
      acceptedCandidateTaskFactory: (commit) => acceptedPipelineTask(taskId, commit),
    });
    const fixture = await createChapterFixture();
    const candidate = makeReadyCandidate(fixture, 91, "accepted text with durable recovery");
    expectOk(await repositories.aiCandidates.create(candidate));
    const commit = acceptedCandidateCommit(fixture, candidate, 92, atMinute(4));

    expectOk(await repositories.contentCommits.acceptCandidate(commit));

    // This is the state a new process observes if the renderer exits as soon as
    // acceptCandidate returns: both the immutable text and the queued task exist.
    const persistedVersion = expectPresent(
      expectOk(await repositories.chapterVersions.findVersionById(commit.version.id)),
    );
    expect(persistedVersion.toSnapshot()).toMatchObject({
      reason: "candidate_accept",
      sourceCandidateId: candidate.id,
    });
    const persistedVersions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    expect(persistedVersions).toHaveLength(2);
    expect(
      persistedVersions.find((version) => version.id === fixture.initialVersion.id)?.toSnapshot(),
    ).toEqual(fixture.initialVersion.toSnapshot());
    const taskRepository = new SqliteTaskRepository(executor);
    const parsedTaskId = parseTaskUuidV7(taskId);
    if (!parsedTaskId.ok) {
      throw parsedTaskId.error;
    }
    const loadedTask = await taskRepository.findById(parsedTaskId.value);
    if (!loadedTask.ok) {
      throw loadedTask.error;
    }
    const taskEntity = expectPresent(loadedTask.value);
    expect(taskEntity.toSnapshot()).toMatchObject({
      id: taskId,
      idempotencyKey: `story.accepted-version:${commit.version.id}`,
      type: "story.accepted-version.process",
      status: "queued",
      metadata: {
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
        versionId: commit.version.id,
        source: "candidate_accept",
        acceptedCharacterCount: commit.version.toSnapshot().content.length,
        runChapterSummary: false,
        runStoryState: false,
        operation: "rebuild-derived-story-state",
      },
    });

    const duplicateTask = Task.create(acceptedPipelineTask(uuid(93), commit));
    if (!duplicateTask.ok) {
      throw duplicateTask.error;
    }
    const duplicate = await taskRepository.createIfAbsent(duplicateTask.value);
    if (!duplicate.ok) {
      throw duplicate.error;
    }
    expect(duplicate.value.created).toBe(false);
    expect(String(duplicate.value.task.id)).toBe(taskId);

    const conflictingVersion = commit.version.toSnapshot();
    const conflictingTask = Task.create({
      ...acceptedPipelineTask(uuid(94), commit),
      metadata: {
        projectId: conflictingVersion.projectId,
        chapterId: conflictingVersion.chapterId,
        versionId: conflictingVersion.id,
        source: "candidate_accept",
        acceptedCharacterCount: conflictingVersion.content.length + 1,
        operation: "rebuild-derived-story-state",
      },
    });
    if (!conflictingTask.ok) {
      throw conflictingTask.error;
    }
    const conflict = await taskRepository.createIfAbsent(conflictingTask.value);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) {
      throw new Error("Expected strict task idempotency to reject different metadata.");
    }
    expect(conflict.error.code).toBe("TASK_IDEMPOTENCY_CONFLICT");

    const claimed = taskEntity.claim({
      ownerId: "test.accepted-version",
      leaseToken: uuid(98),
      now: atMinute(5),
      leaseExpiresAt: atMinute(6),
    });
    if (!claimed.ok) {
      throw claimed.error;
    }
    const savedClaim = await taskRepository.save(claimed.value, taskEntity.sequence);
    if (!savedClaim.ok) {
      throw savedClaim.error;
    }
    const failure = createTaskFailure({
      code: "DERIVED_STORY_REBUILD_FAILED",
      causeCode: "SEARCH_INDEX_FAILED",
      retryable: false,
      actions: ["CONTACT_SUPPORT"],
      requestId: "request:accepted-version-failure",
    });
    if (!failure.ok) {
      throw failure.error;
    }
    const failed = claimed.value.recordFailure({
      leaseToken: uuid(98),
      failure: failure.value,
      now: atMinute(5),
      retryAt: null,
    });
    if (!failed.ok) {
      throw failed.error;
    }
    const savedFailure = await taskRepository.save(failed.value, claimed.value.sequence);
    if (!savedFailure.ok) {
      throw savedFailure.error;
    }
    const chapterAfterTaskFailure = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    expect(chapterAfterTaskFailure.toSnapshot()).toEqual(commit.chapter.toSnapshot());
    expect(
      expectPresent(expectOk(await repositories.aiCandidates.findById(candidate.id))).status,
    ).toBe("accepted");
  });

  it("rolls back Candidate acceptance when its durable task cannot be registered", async () => {
    const collidingTaskId = uuid(95);
    repositories = createSqliteRepositories(executor, {
      acceptedCandidateTaskFactory: (commit) => acceptedPipelineTask(collidingTaskId, commit),
    });
    const fixture = await createChapterFixture();
    const candidate = makeReadyCandidate(fixture, 96, "candidate remains retryable");
    expectOk(await repositories.aiCandidates.create(candidate));
    const commit = acceptedCandidateCommit(fixture, candidate, 97, atMinute(4));
    const unrelated = Task.create({
      id: collidingTaskId,
      type: "test.unrelated",
      idempotencyKey: "test.unrelated:durable-task-id-collision",
      metadata: { operation: "unrelated" },
      priority: 1,
      maxAttempts: 1,
      now: atMinute(3),
    });
    if (!unrelated.ok) {
      throw unrelated.error;
    }
    const taskRepository = new SqliteTaskRepository(executor);
    const seeded = await taskRepository.createIfAbsent(unrelated.value);
    if (!seeded.ok) {
      throw seeded.error;
    }

    expectErrorCode(await repositories.contentCommits.acceptCandidate(commit), "REPOSITORY_ERROR");

    const persistedChapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const persistedCandidate = expectPresent(
      expectOk(await repositories.aiCandidates.findById(candidate.id)),
    );
    expect(persistedChapter.toSnapshot()).toEqual(fixture.chapter.toSnapshot());
    expect(persistedCandidate.status).toBe("ready");
    expect(
      expectOk(await repositories.chapterVersions.findVersionById(commit.version.id)),
    ).toBeNull();
  });

  it("rolls back candidate acceptance when the candidate decision races", async () => {
    const fixture = await createChapterFixture();
    const candidate = makeReadyCandidate(fixture, 30, "发生竞争的正文");
    expectOk(await repositories.aiCandidates.create(candidate));

    const rejectedCandidate = expectOk(candidate.reject(atMinute(4)));
    expectOk(
      await repositories.aiCandidates.save(rejectedCandidate, {
        status: "ready",
        revision: candidate.revision,
      }),
    );

    const acceptedCandidate = expectOk(candidate.accept(atMinute(5)));
    const versionId = uuid(12);
    const acceptedChapter = expectOk(
      fixture.chapter.saveContent({
        content: candidate.content,
        expectedRevision: 1,
        newVersionId: versionId,
        now: atMinute(5),
      }),
    );
    const acceptedVersion = makeVersion({
      id: versionId,
      projectId: fixture.project.id,
      chapterId: fixture.chapter.id,
      parentVersionId: fixture.initialVersion.id,
      sequence: 2,
      content: candidate.content,
      reason: "candidate_accept",
      sourceCandidateId: candidate.id,
      createdAt: atMinute(5),
    });

    expectErrorCode(
      await repositories.contentCommits.acceptCandidate({
        chapter: acceptedChapter,
        version: acceptedVersion,
        candidate: acceptedCandidate,
        expectedChapterRevision: 1,
        expectedCandidateStatus: "ready",
        expectedCandidateRevision: candidate.revision,
      }),
      "CANDIDATE_ALREADY_DECIDED",
    );

    const persistedChapter = expectPresent(
      expectOk(await repositories.chapters.findById(fixture.chapter.id)),
    );
    const persistedCandidate = expectPresent(
      expectOk(await repositories.aiCandidates.findById(candidate.id)),
    );
    const versions = expectOk(
      await repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    expect(persistedChapter.toSnapshot()).toEqual(fixture.chapter.toSnapshot());
    expect(persistedCandidate.status).toBe("rejected");
    expect(versions.map((item) => item.sequence)).toEqual([1]);
  });

  it("atomically imports a project with every initial chapter version", async () => {
    const project = makeProject(100, "原子导入", 0);
    const first = makeImportedChapter(project, 101, 102, "第一章", "开篇");
    const second = makeImportedChapter(project, 103, 104, "第二章", "后续");

    expectOk(
      await repositories.projectImports.commitImport({
        project,
        chapters: [first, second],
      }),
    );

    const persistedProject = expectPresent(
      expectOk(await repositories.projects.findById(project.id)),
    );
    const chapters = expectOk(await repositories.chapters.listByProjectId(project.id));
    const firstVersions = expectOk(
      await repositories.chapterVersions.listByChapterId(first.chapter.id),
    );
    expect(persistedProject.name).toBe("原子导入");
    expect(chapters.map(({ title }) => title)).toEqual(["第一章", "第二章"]);
    expect(firstVersions[0]?.toSnapshot()).toMatchObject({
      reason: "import",
      content: "开篇",
    });
  });

  it("rolls back every import row when a later chapter insert fails", async () => {
    const project = makeProject(200, "回滚导入", 0);
    const first = makeImportedChapter(project, 201, 202, "第一章", "开篇");
    const second = makeImportedChapter(project, 203, 202, "第二章", "重复版本标识");

    expectErrorCode(
      await repositories.projectImports.commitImport({
        project,
        chapters: [first, second],
      }),
      "REPOSITORY_ERROR",
    );

    expect(expectOk(await repositories.projects.findById(project.id))).toBeNull();
    expect(expectOk(await repositories.chapters.listByProjectId(project.id))).toEqual([]);
  });

  async function createChapterFixture(): Promise<{
    project: Project;
    chapter: Chapter;
    initialVersion: ChapterVersion;
  }> {
    const project = makeProject(1, "章节项目", 0);
    expectOk(await repositories.projects.create(project));

    const chapterId = uuid(10);
    const initialVersionId = uuid(11);
    const chapter = expectOk(
      Chapter.create({
        id: chapterId,
        projectId: project.id,
        title: "第一章",
        content: "初始正文",
        initialVersionId,
        now: atMinute(1),
      }),
    );
    const initialVersion = makeVersion({
      id: initialVersionId,
      projectId: project.id,
      chapterId,
      parentVersionId: null,
      sequence: 1,
      content: chapter.content,
      reason: "created",
      sourceCandidateId: null,
      createdAt: atMinute(1),
    });
    expectOk(
      await repositories.contentCommits.createChapter({
        chapter,
        initialVersion,
      }),
    );
    return { project, chapter, initialVersion };
  }
});

interface ChapterFixtureSnapshot {
  readonly project: Project;
  readonly chapter: Chapter;
  readonly initialVersion: ChapterVersion;
}

function acceptedCandidateCommit(
  fixture: ChapterFixtureSnapshot,
  candidate: AiCandidate,
  versionSequence: number,
  now: IsoUtcTimestamp,
): AcceptCandidateCommit {
  const acceptedCandidate = expectOk(candidate.accept(now));
  const versionId = uuid(versionSequence);
  const chapter = expectOk(
    fixture.chapter.saveContent({
      content: candidate.content,
      expectedRevision: fixture.chapter.revision,
      newVersionId: versionId,
      now,
    }),
  );
  const version = makeVersion({
    id: versionId,
    projectId: fixture.project.id,
    chapterId: fixture.chapter.id,
    parentVersionId: fixture.initialVersion.id,
    sequence: chapter.revision,
    content: candidate.content,
    reason: "candidate_accept",
    sourceCandidateId: candidate.id,
    createdAt: now,
  });
  return {
    chapter,
    version,
    candidate: acceptedCandidate,
    expectedChapterRevision: fixture.chapter.revision,
    expectedCandidateStatus: "ready",
    expectedCandidateRevision: candidate.revision,
  };
}

function acceptedPipelineTask(taskId: UuidV7, commit: AcceptCandidateCommit): CreateTaskInput {
  const version = commit.version.toSnapshot();
  return {
    id: taskId,
    type: "story.accepted-version.process",
    idempotencyKey: `story.accepted-version:${version.id}`,
    metadata: {
      projectId: version.projectId,
      chapterId: version.chapterId,
      versionId: version.id,
      source: "candidate_accept",
      acceptedCharacterCount: version.content.length,
      runChapterSummary: false,
      runStoryState: false,
      operation: "rebuild-derived-story-state",
    },
    priority: 75,
    maxAttempts: 3,
    now: version.createdAt,
  };
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

function makeVersion(input: {
  id: UuidV7;
  projectId: UuidV7;
  chapterId: UuidV7;
  parentVersionId: UuidV7 | null;
  sequence: number;
  content: string;
  reason: "created" | "autosave" | "manual" | "candidate_accept" | "recovery" | "import";
  sourceCandidateId: UuidV7 | null;
  createdAt: IsoUtcTimestamp;
}): ChapterVersion {
  return expectOk(
    ChapterVersion.create({
      ...input,
      contentChecksum: checksum(input.content),
    }),
  );
}

function makeImportedChapter(
  project: Project,
  chapterSequence: number,
  versionSequence: number,
  title: string,
  content: string,
): { readonly chapter: Chapter; readonly initialVersion: ChapterVersion } {
  const chapterId = uuid(chapterSequence);
  const versionId = uuid(versionSequence);
  const chapter = expectOk(
    Chapter.create({
      id: chapterId,
      projectId: project.id,
      title,
      content,
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
      reason: "import",
      sourceCandidateId: null,
      createdAt: atMinute(1),
    }),
  };
}

function makeReadyCandidate(
  fixture: {
    project: Project;
    chapter: Chapter;
    initialVersion: ChapterVersion;
  },
  idSequence: number,
  content: string,
): AiCandidate {
  const streaming = expectOk(
    AiCandidate.createStreaming({
      id: uuid(idSequence),
      projectId: fixture.project.id,
      chapterId: fixture.chapter.id,
      source: "generate",
      baseVersionId: fixture.initialVersion.id,
      now: atMinute(2),
    }),
  );
  return expectOk(streaming.markReady(content, checksum(content), atMinute(3)));
}

function makeRecoveryTransition(
  chapter: Chapter,
  versionId: UuidV7,
  content: string,
  now: IsoUtcTimestamp,
): Readonly<{ chapter: Chapter; version: ChapterVersion }> {
  const restoredChapter = expectOk(
    chapter.saveContent({
      content,
      expectedRevision: chapter.revision,
      newVersionId: versionId,
      now,
    }),
  );
  return {
    chapter: restoredChapter,
    version: makeVersion({
      id: versionId,
      projectId: chapter.projectId,
      chapterId: chapter.id,
      parentVersionId: chapter.currentVersionId,
      sequence: restoredChapter.revision,
      content,
      reason: "recovery",
      sourceCandidateId: null,
      createdAt: now,
    }),
  };
}

function uuid(sequence: number): UuidV7 {
  const tail = sequence.toString(16).padStart(12, "0");
  return expectOk(parseUuidV7(`019f9f4a-b3c7-7350-9226-${tail}`));
}

function atMinute(minute: number): IsoUtcTimestamp {
  return expectOk(parseIsoUtcTimestamp(new Date(Date.UTC(2026, 6, 27, 0, minute)).toISOString()));
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
    throw new Error("Expected a persisted value.");
  }
  return value;
}
