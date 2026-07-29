import {
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

import { createDevelopmentRepositories } from "./development-storage";

describe("development localStorage chapter restoration", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("atomically appends recovery versions without overwriting history", async () => {
    const fixture = await createHistory();
    const restored = transition(
      fixture.second.chapter,
      uuid(5),
      fixture.initialVersion.toSnapshot().content,
      atMinute(3),
    );

    expectOk(
      await fixture.repositories.contentCommits.restoreChapterVersion({
        ...restored,
        expectedChapterRevision: 2,
      }),
    );

    const chapter = expectPresent(
      expectOk(await fixture.repositories.chapters.findById(fixture.chapter.id)),
    );
    const versions = expectOk(
      await fixture.repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    expect(chapter.toSnapshot()).toMatchObject({
      content: "First edition",
      revision: 3,
      currentVersionId: restored.version.id,
    });
    expect(versions.map((version) => version.sequence)).toEqual([3, 2, 1]);
    expect(
      expectPresent(
        expectOk(
          await fixture.repositories.chapterVersions.findVersionById(fixture.initialVersion.id),
        ),
      ).toSnapshot(),
    ).toEqual(fixture.initialVersion.toSnapshot());
  });

  it("keeps localStorage unchanged when a recovery commit loses its revision CAS", async () => {
    const fixture = await createHistory();
    const stale = transition(
      fixture.second.chapter,
      uuid(5),
      fixture.initialVersion.toSnapshot().content,
      atMinute(3),
    );
    const serializedBefore = window.localStorage.getItem("inkshadow.development.database.v1");

    const outcome = await fixture.repositories.contentCommits.restoreChapterVersion({
      ...stale,
      expectedChapterRevision: 1,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("VERSION_CONFLICT");
    }
    expect(window.localStorage.getItem("inkshadow.development.database.v1")).toBe(serializedBefore);
    const versions = expectOk(
      await fixture.repositories.chapterVersions.listByChapterId(fixture.chapter.id),
    );
    expect(versions.map((version) => version.sequence)).toEqual([2, 1]);
    expect(
      expectOk(await fixture.repositories.chapterVersions.findVersionById(stale.version.id)),
    ).toBeNull();
  });
});

async function createHistory(): Promise<
  Readonly<{
    repositories: ReturnType<typeof createDevelopmentRepositories>;
    chapter: Chapter;
    initialVersion: ChapterVersion;
    second: Readonly<{ chapter: Chapter; version: ChapterVersion }>;
  }>
> {
  const repositories = createDevelopmentRepositories(window.localStorage);
  const project = expectOk(Project.create({ id: uuid(1), name: "Novel", now: atMinute(0) }));
  expectOk(await repositories.projects.create(project));
  const chapter = expectOk(
    Chapter.create({
      id: uuid(2),
      projectId: project.id,
      title: "Chapter One",
      content: "First edition",
      initialVersionId: uuid(3),
      now: atMinute(0),
    }),
  );
  const initialVersion = version({
    id: uuid(3),
    chapter,
    parentVersionId: null,
    sequence: 1,
    content: chapter.content,
    createdAt: atMinute(0),
  });
  expectOk(
    await repositories.contentCommits.createChapter({
      chapter,
      initialVersion,
    }),
  );
  const second = transition(chapter, uuid(4), "Second edition", atMinute(2));
  expectOk(
    await repositories.contentCommits.restoreChapterVersion({
      ...second,
      expectedChapterRevision: 1,
    }),
  );
  return { repositories, chapter, initialVersion, second };
}

function transition(
  chapter: Chapter,
  versionId: UuidV7,
  content: string,
  now: IsoUtcTimestamp,
): Readonly<{ chapter: Chapter; version: ChapterVersion }> {
  const restored = expectOk(
    chapter.saveContent({
      content,
      expectedRevision: chapter.revision,
      newVersionId: versionId,
      now,
    }),
  );
  return {
    chapter: restored,
    version: version({
      id: versionId,
      chapter,
      parentVersionId: chapter.currentVersionId,
      sequence: restored.revision,
      content,
      createdAt: now,
    }),
  };
}

function version(input: {
  readonly id: UuidV7;
  readonly chapter: Chapter;
  readonly parentVersionId: UuidV7 | null;
  readonly sequence: number;
  readonly content: string;
  readonly createdAt: IsoUtcTimestamp;
}): ChapterVersion {
  return expectOk(
    ChapterVersion.create({
      id: input.id,
      projectId: input.chapter.projectId,
      chapterId: input.chapter.id,
      parentVersionId: input.parentVersionId,
      sequence: input.sequence,
      content: input.content,
      contentChecksum: checksum(),
      reason: input.sequence === 1 ? "created" : "recovery",
      sourceCandidateId: null,
      createdAt: input.createdAt,
    }),
  );
}

function uuid(sequence: number): UuidV7 {
  return expectOk(
    parseUuidV7(`019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`),
  );
}

function atMinute(minute: number): IsoUtcTimestamp {
  return expectOk(parseIsoUtcTimestamp(new Date(Date.UTC(2026, 6, 27, 0, minute)).toISOString()));
}

function checksum(): ContentChecksum {
  return expectOk(parseContentChecksum("a".repeat(64)));
}

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function expectPresent<Value>(value: Value | null): Value {
  if (value === null) {
    throw new Error("Expected persisted data.");
  }
  return value;
}
