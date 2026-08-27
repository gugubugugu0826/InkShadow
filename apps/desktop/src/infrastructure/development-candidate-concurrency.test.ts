import {
  AiCandidate,
  Chapter,
  ChapterVersion,
  Project,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AppError,
  type ContentChecksum,
  type IsoUtcTimestamp,
  type Result,
  type UuidV7,
} from "@inkshadow/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRepositories, DEVELOPMENT_DATABASE_KEY } from "./development-storage";

const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const INITIAL_VERSION_ID = uuid(3);
const CANDIDATE_ID = uuid(4);
const STALE_VERSION_ID = uuid(5);
const NOW = atMinute(0);
const LATER = atMinute(1);

describe("browser development Candidate revision authority", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("rejects stale revise and accept writes from a second repository client", async () => {
    const first = createDevelopmentRepositories(window.localStorage);
    const project = expectOk(Project.create({ id: PROJECT_ID, name: "Race", now: NOW }));
    expectOk(await first.projects.create(project));
    const chapter = expectOk(
      Chapter.create({
        id: CHAPTER_ID,
        projectId: PROJECT_ID,
        title: "Chapter",
        content: "stable",
        initialVersionId: INITIAL_VERSION_ID,
        now: NOW,
      }),
    );
    const initialVersion = createVersion({
      id: INITIAL_VERSION_ID,
      chapter,
      parentVersionId: null,
      sequence: 1,
      content: chapter.content,
      reason: "created",
      candidateId: null,
    });
    expectOk(await first.contentCommits.createChapter({ chapter, initialVersion }));
    const streaming = expectOk(
      AiCandidate.createStreaming({
        id: CANDIDATE_ID,
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        source: "generate",
        baseVersionId: INITIAL_VERSION_ID,
        now: NOW,
      }),
    );
    const candidate = expectOk(streaming.markReady("original", checksum(), NOW));
    expectOk(await first.aiCandidates.create(candidate));

    const second = createDevelopmentRepositories(window.localStorage);
    const firstView = expectPresent(expectOk(await first.aiCandidates.findById(CANDIDATE_ID)));
    const secondView = expectPresent(expectOk(await second.aiCandidates.findById(CANDIDATE_ID)));
    const winner = expectOk(firstView.reviseReadyContent("window A winner", checksum("b"), LATER));
    expectOk(await first.aiCandidates.save(winner, { status: "ready", revision: 1 }));
    const serializedWinner = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);

    const staleRevision = expectOk(
      secondView.reviseReadyContent("window B stale edit", checksum("c"), LATER),
    );
    expectErrorCode(
      await second.aiCandidates.save(staleRevision, { status: "ready", revision: 1 }),
      "VERSION_CONFLICT",
    );
    expect(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY)).toBe(serializedWinner);

    const staleCandidate = expectOk(secondView.accept(LATER));
    const staleChapter = expectOk(
      chapter.saveContent({
        content: secondView.content,
        expectedRevision: 1,
        newVersionId: STALE_VERSION_ID,
        now: LATER,
      }),
    );
    const staleVersion = createVersion({
      id: STALE_VERSION_ID,
      chapter,
      parentVersionId: INITIAL_VERSION_ID,
      sequence: 2,
      content: secondView.content,
      reason: "candidate_accept",
      candidateId: CANDIDATE_ID,
    });
    expectErrorCode(
      await second.contentCommits.acceptCandidate({
        chapter: staleChapter,
        version: staleVersion,
        candidate: staleCandidate,
        expectedChapterRevision: 1,
        expectedCandidateStatus: "ready",
        expectedCandidateRevision: 1,
      }),
      "VERSION_CONFLICT",
    );
    expect(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY)).toBe(serializedWinner);

    const persistedCandidate = expectPresent(
      expectOk(await second.aiCandidates.findById(CANDIDATE_ID)),
    );
    const persistedChapter = expectPresent(expectOk(await second.chapters.findById(CHAPTER_ID)));
    const versions = expectOk(await second.chapterVersions.listByChapterId(CHAPTER_ID));
    expect(persistedCandidate.toSnapshot()).toMatchObject({
      content: "window A winner",
      status: "ready",
      revision: 2,
    });
    expect(persistedChapter.toSnapshot()).toMatchObject({ content: "stable", revision: 1 });
    expect(versions.map((version) => version.sequence)).toEqual([1]);
  });

  it("reloads all four exact selection actions after a browser repository restart", async () => {
    const first = createDevelopmentRepositories(window.localStorage);
    const project = expectOk(Project.create({ id: PROJECT_ID, name: "Selection", now: NOW }));
    expectOk(await first.projects.create(project));
    const chapter = expectOk(
      Chapter.create({
        id: CHAPTER_ID,
        projectId: PROJECT_ID,
        title: "Chapter",
        content: "稳定选区正文",
        initialVersionId: INITIAL_VERSION_ID,
        now: NOW,
      }),
    );
    expectOk(
      await first.contentCommits.createChapter({
        chapter,
        initialVersion: createVersion({
          id: INITIAL_VERSION_ID,
          chapter,
          parentVersionId: null,
          sequence: 1,
          content: chapter.content,
          reason: "created",
          candidateId: null,
        }),
      }),
    );
    const actions = ["selection_rewrite", "polish", "expand", "shorten"] as const;
    for (const [index, selectionAction] of actions.entries()) {
      const streaming = expectOk(
        AiCandidate.createStreaming({
          id: uuid(40 + index),
          projectId: PROJECT_ID,
          chapterId: CHAPTER_ID,
          source: "polish",
          baseVersionId: INITIAL_VERSION_ID,
          now: NOW,
          applicationIntent: {
            task: "selection_rewrite",
            application: "replace_selection",
            payload: "fragment",
            startUtf16: 2,
            endUtf16: 6,
            selectionAction,
          },
        }),
      );
      expectOk(
        await first.aiCandidates.create(expectOk(streaming.markReady("隔离片段", checksum(), NOW))),
      );
    }

    const reopened = createDevelopmentRepositories(window.localStorage);
    for (const [index, selectionAction] of actions.entries()) {
      const candidate = expectPresent(
        expectOk(await reopened.aiCandidates.findById(uuid(40 + index))),
      );
      expect(candidate.applicationIntent).toMatchObject({
        task: "selection_rewrite",
        selectionAction,
      });
    }
  });
});

function createVersion(
  input: Readonly<{
    id: UuidV7;
    chapter: Chapter;
    parentVersionId: UuidV7 | null;
    sequence: number;
    content: string;
    reason: "created" | "candidate_accept";
    candidateId: UuidV7 | null;
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
      sourceCandidateId: input.candidateId,
      createdAt: input.sequence === 1 ? NOW : LATER,
    }),
  );
}

function uuid(sequence: number): UuidV7 {
  return expectOk(parseUuidV7(`019f9f4a-b3c7-7350-9226-${sequence.toString().padStart(12, "0")}`));
}

function atMinute(minute: number): IsoUtcTimestamp {
  return expectOk(parseIsoUtcTimestamp(new Date(Date.UTC(2026, 7, 8, 0, minute)).toISOString()));
}

function checksum(character = "a"): ContentChecksum {
  return expectOk(parseContentChecksum(character.repeat(64)));
}

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) throw result.error;
  return result.value;
}

function expectPresent<Value>(value: Value | null): Value {
  if (value === null) throw new Error("Expected persisted data.");
  return value;
}

function expectErrorCode<Value>(result: Result<Value, AppError>, code: AppError["code"]): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}
