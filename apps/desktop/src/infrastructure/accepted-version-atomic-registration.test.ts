import type { AcceptedVersionTaskRegistration } from "@inkshadow/data";
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
import type { CreateTaskInput } from "@inkshadow/task-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AcceptedChapterPipelineWorker } from "./accepted-chapter-pipeline-worker";
import { createDevelopmentRepositories, DEVELOPMENT_DATABASE_KEY } from "./development-storage";
import { createDevelopmentRuntime } from "./runtime";

describe("accepted-version atomic task registration in browser development", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("rolls back chapter正文, version, and recovery draft when task validation fails", async () => {
    const repositories = createDevelopmentRepositories(window.localStorage, {
      acceptedVersionTaskFactory: (registration) => invalidPipelineTask(registration, 90),
    });
    const fixture = await createFixture(repositories);
    const draft = expectOk(
      RecoveryDraft.create({
        id: uuid(10),
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
        baseRevision: fixture.chapter.revision,
        content: "manual edit that must roll back",
        cursorOffset: 12,
        now: atMinute(2),
      }),
    );
    expectOk(await repositories.recoveryDrafts.upsert(draft));
    const savedChapter = expectOk(
      fixture.chapter.saveContent({
        content: draft.content,
        expectedRevision: fixture.chapter.revision,
        newVersionId: uuid(11),
        now: atMinute(3),
      }),
    );
    const savedVersion = makeVersion({
      id: uuid(11),
      chapter: fixture.chapter,
      parentVersionId: fixture.initialVersion.id,
      sequence: savedChapter.revision,
      content: draft.content,
      reason: "manual",
      organizeLocalStoryFacts: true,
      createdAt: atMinute(3),
    });
    const serializedBefore = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);

    expectErrorCode(
      await repositories.contentCommits.saveChapter({
        chapter: savedChapter,
        version: savedVersion,
        recoveryDraftId: draft.id,
        expectedChapterRevision: fixture.chapter.revision,
      }),
      "REPOSITORY_ERROR",
    );

    expect(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY)).toBe(serializedBefore);
    expect(
      expectPresent(
        expectOk(await repositories.chapters.findById(fixture.chapter.id)),
      ).toSnapshot(),
    ).toEqual(fixture.chapter.toSnapshot());
    expect(
      expectOk(await repositories.chapterVersions.findVersionById(savedVersion.id)),
    ).toBeNull();
    expect(
      expectPresent(
        expectOk(await repositories.recoveryDrafts.findByChapterId(fixture.chapter.id)),
      ).toSnapshot(),
    ).toEqual(draft.toSnapshot());
  });

  it("rolls back Candidate status, chapter正文, and version when task validation fails", async () => {
    const repositories = createDevelopmentRepositories(window.localStorage, {
      acceptedVersionTaskFactory: (registration) => invalidPipelineTask(registration, 91),
    });
    const fixture = await createFixture(repositories);
    const streaming = expectOk(
      AiCandidate.createStreaming({
        id: uuid(12),
        projectId: fixture.project.id,
        chapterId: fixture.chapter.id,
        source: "generate",
        baseVersionId: fixture.initialVersion.id,
        now: atMinute(2),
      }),
    );
    const candidate = expectOk(streaming.markReady("candidate text", checksum(), atMinute(3)));
    expectOk(await repositories.aiCandidates.create(candidate));
    const acceptedCandidate = expectOk(candidate.accept(atMinute(4)));
    const acceptedChapter = expectOk(
      fixture.chapter.saveContent({
        content: candidate.content,
        expectedRevision: fixture.chapter.revision,
        newVersionId: uuid(13),
        now: atMinute(4),
      }),
    );
    const acceptedVersion = makeVersion({
      id: uuid(13),
      chapter: fixture.chapter,
      parentVersionId: fixture.initialVersion.id,
      sequence: acceptedChapter.revision,
      content: candidate.content,
      reason: "candidate_accept",
      sourceCandidateId: candidate.id,
      organizeLocalStoryFacts: true,
      createdAt: atMinute(4),
    });
    const serializedBefore = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);

    expectErrorCode(
      await repositories.contentCommits.acceptCandidate({
        chapter: acceptedChapter,
        version: acceptedVersion,
        candidate: acceptedCandidate,
        expectedChapterRevision: fixture.chapter.revision,
        expectedCandidateStatus: "ready",
        expectedCandidateRevision: candidate.revision,
        organizeLocalStoryFacts: true,
      }),
      "REPOSITORY_ERROR",
    );

    expect(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY)).toBe(serializedBefore);
    expect(
      expectPresent(expectOk(await repositories.aiCandidates.findById(candidate.id))).status,
    ).toBe("ready");
    expect(
      expectPresent(
        expectOk(await repositories.chapters.findById(fixture.chapter.id)),
      ).toSnapshot(),
    ).toEqual(fixture.chapter.toSnapshot());
    expect(
      expectOk(await repositories.chapterVersions.findVersionById(acceptedVersion.id)),
    ).toBeNull();
  });

  it("rolls back a restored version and chapter正文 when task validation fails", async () => {
    const repositories = createDevelopmentRepositories(window.localStorage, {
      acceptedVersionTaskFactory: (registration) => invalidPipelineTask(registration, 92),
    });
    const fixture = await createFixture(repositories);
    const restoredChapter = expectOk(
      fixture.chapter.saveContent({
        content: "restored edition",
        expectedRevision: fixture.chapter.revision,
        newVersionId: uuid(14),
        now: atMinute(3),
      }),
    );
    const restoredVersion = makeVersion({
      id: uuid(14),
      chapter: fixture.chapter,
      parentVersionId: fixture.initialVersion.id,
      sequence: restoredChapter.revision,
      content: restoredChapter.content,
      reason: "recovery",
      organizeLocalStoryFacts: true,
      createdAt: atMinute(3),
    });
    const serializedBefore = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);

    expectErrorCode(
      await repositories.contentCommits.restoreChapterVersion({
        chapter: restoredChapter,
        version: restoredVersion,
        expectedChapterRevision: fixture.chapter.revision,
      }),
      "REPOSITORY_ERROR",
    );

    expect(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY)).toBe(serializedBefore);
    expect(
      expectPresent(
        expectOk(await repositories.chapters.findById(fixture.chapter.id)),
      ).toSnapshot(),
    ).toEqual(fixture.chapter.toSnapshot());
    expect(
      expectOk(await repositories.chapterVersions.findVersionById(restoredVersion.id)),
    ).toBeNull();
  });

  it("rolls back all imported chapters and earlier tasks when a later task is invalid", async () => {
    let registrationCount = 0;
    const repositories = createDevelopmentRepositories(window.localStorage, {
      acceptedVersionTaskFactory: (registration) => {
        registrationCount += 1;
        return pipelineTask(registration, 92 + registrationCount, registrationCount === 2 ? 0 : 3);
      },
    });
    const project = expectOk(Project.create({ id: uuid(20), name: "Import", now: atMinute(0) }));
    const first = importedChapter(project, 21, 22, "One", "first");
    const second = importedChapter(project, 23, 24, "Two", "second");

    expectErrorCode(
      await repositories.projectImports.commitImport({ project, chapters: [first, second] }),
      "REPOSITORY_ERROR",
    );

    expect(registrationCount).toBe(2);
    expect(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY)).toBeNull();
    expect(expectOk(await repositories.projects.findById(project.id))).toBeNull();
    expect(expectOk(await repositories.chapters.listByProjectId(project.id))).toEqual([]);
  });

  it("survives a runtime restart and lets the worker finish the exact queued autosave task", async () => {
    const first = createDevelopmentRuntime(window.localStorage);
    const project = expectOk(await first.useCases.createProject.execute({ name: "Restart" }));
    const created = expectOk(
      await first.useCases.createChapter.execute({
        projectId: project.id,
        title: "Chapter",
        content: "before",
      }),
    );
    expectOk(
      await first.useCases.editChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        content: "after autosave",
        cursorOffset: 14,
      }),
    );
    const saved = expectOk(
      await first.useCases.saveChapter.execute({
        chapterId: created.chapter.id,
        expectedRevision: created.chapter.revision,
        reason: "autosave",
        organizeLocalStoryFacts: false,
      }),
    );
    const savedVersion = expectPresent(saved.version);
    const queued = (await first.taskCenter.load()).tasks.find(
      (task) => task.metadata.versionId === savedVersion.id,
    );
    expect(queued).toMatchObject({
      status: "queued",
      metadata: {
        source: "autosave",
        organizeLocalStoryFacts: false,
        runSearch: true,
        runCausalProjection: true,
      },
    });

    const restarted = createDevelopmentRuntime(window.localStorage);
    const ensureCurrentFacts = vi.fn((): Promise<void> => Promise.resolve());
    const reportError = vi.fn();
    const worker = new AcceptedChapterPipelineWorker(restarted, {
      queuedGraceMilliseconds: 0,
      ensureCurrentFacts,
      reportError,
    });

    await expect(worker.runDueTasksNow()).resolves.toBe(1);

    const completed = (await restarted.taskCenter.load()).tasks.find(
      (task) => task.id === queued?.id,
    );
    expect(completed).toMatchObject({
      status: "succeeded",
      metadata: { source: "autosave", versionId: savedVersion.id },
      progress: { step: "pipeline.outcome.search-causal" },
    });
    expect(ensureCurrentFacts).toHaveBeenCalledOnce();
    expect(reportError).not.toHaveBeenCalled();
  });
});

type DevelopmentRepositories = ReturnType<typeof createDevelopmentRepositories>;

async function createFixture(
  repositories: DevelopmentRepositories,
): Promise<Readonly<{ project: Project; chapter: Chapter; initialVersion: ChapterVersion }>> {
  const project = expectOk(Project.create({ id: uuid(1), name: "Novel", now: atMinute(0) }));
  expectOk(await repositories.projects.create(project));
  const chapter = expectOk(
    Chapter.create({
      id: uuid(2),
      projectId: project.id,
      title: "Chapter",
      content: "stable",
      initialVersionId: uuid(3),
      now: atMinute(0),
    }),
  );
  const initialVersion = makeVersion({
    id: uuid(3),
    chapter,
    parentVersionId: null,
    sequence: 1,
    content: chapter.content,
    reason: "created",
    createdAt: atMinute(0),
  });
  expectOk(await repositories.contentCommits.createChapter({ chapter, initialVersion }));
  return { project, chapter, initialVersion };
}

function importedChapter(
  project: Project,
  chapterSequence: number,
  versionSequence: number,
  title: string,
  content: string,
): Readonly<{ chapter: Chapter; initialVersion: ChapterVersion }> {
  const chapter = expectOk(
    Chapter.create({
      id: uuid(chapterSequence),
      projectId: project.id,
      title,
      content,
      initialVersionId: uuid(versionSequence),
      now: atMinute(0),
    }),
  );
  return {
    chapter,
    initialVersion: makeVersion({
      id: uuid(versionSequence),
      chapter,
      parentVersionId: null,
      sequence: 1,
      content,
      reason: "import",
      createdAt: atMinute(0),
    }),
  };
}

function makeVersion(
  input: Readonly<{
    id: UuidV7;
    chapter: Chapter;
    parentVersionId: UuidV7 | null;
    sequence: number;
    content: string;
    reason: "created" | "manual" | "candidate_accept" | "recovery" | "import";
    sourceCandidateId?: UuidV7 | null;
    organizeLocalStoryFacts?: boolean;
    createdAt: IsoUtcTimestamp;
  }>,
): ChapterVersion {
  return expectOk(
    ChapterVersion.create({
      id: input.id,
      projectId: input.chapter.projectId,
      chapterId: input.chapter.id,
      parentVersionId: input.parentVersionId,
      sequence: input.sequence,
      content: input.content,
      contentChecksum: checksum(),
      reason: input.reason,
      sourceCandidateId: input.sourceCandidateId ?? null,
      organizeLocalStoryFacts: input.organizeLocalStoryFacts ?? false,
      createdAt: input.createdAt,
    }),
  );
}

function invalidPipelineTask(
  registration: AcceptedVersionTaskRegistration,
  idSequence: number,
): CreateTaskInput {
  return pipelineTask(registration, idSequence, 0);
}

function pipelineTask(
  registration: AcceptedVersionTaskRegistration,
  idSequence: number,
  maxAttempts: number,
): CreateTaskInput {
  const version = registration.version.toSnapshot();
  return {
    id: uuid(idSequence),
    type: "story.accepted-version.process",
    idempotencyKey: `story.accepted-version:${version.id}`,
    metadata: {
      projectId: version.projectId,
      chapterId: version.chapterId,
      versionId: version.id,
      source: registration.source,
      acceptedCharacterCount: version.content.length,
      organizeLocalStoryFacts: version.organizeLocalStoryFacts,
      runSearch: true,
      runChapterSummary: false,
      runStoryState: false,
      runCausalProjection: true,
      operation: "rebuild-derived-story-state",
    },
    priority: 75,
    maxAttempts,
    now: version.createdAt,
  };
}

function uuid(sequence: number): UuidV7 {
  return expectOk(
    parseUuidV7(`019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`),
  );
}

function atMinute(minute: number): IsoUtcTimestamp {
  return expectOk(parseIsoUtcTimestamp(new Date(Date.UTC(2026, 7, 22, 0, minute)).toISOString()));
}

function checksum(): ContentChecksum {
  return expectOk(parseContentChecksum("a".repeat(64)));
}

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function expectErrorCode<Value>(result: Result<Value, AppError>, code: AppError["code"]): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

function expectPresent<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) throw new Error("Expected a value.");
  return value;
}
