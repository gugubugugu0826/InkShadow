import { describe, expect, it } from "vitest";

import {
  ChapterVersion,
  Project,
  ok,
  parseContentChecksum,
  type ContentChecksum,
} from "@inkshadow/domain";

import {
  CreateChapter,
  EditChapter,
  RestoreChapterVersion,
  SaveChapter,
  type ChapterVersionRepository,
} from "../src/index.js";
import {
  CHAPTER_ID,
  DRAFT_ID,
  FixedClock,
  FixedHasher,
  InMemoryCandidateRepository,
  InMemoryContentStore,
  InMemoryProjectRepository,
  NEXT_VERSION_ID,
  NOW,
  PROJECT_ID,
  SequenceIds,
  VERSION_ID,
  uuid,
} from "./fakes.js";

const RESTORED_VERSION_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000008");
const MISSING_VERSION_ID = uuid("018f0d7a-3b2c-7abc-8def-000000000009");
const OTHER_CHAPTER_ID = uuid("018f0d7a-3b2c-7abc-8def-00000000000a");

function checksum(character = "a"): ContentChecksum {
  const parsed = parseContentChecksum(character.repeat(64));
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function activeProject(): Project {
  const project = Project.create({
    id: PROJECT_ID,
    name: "Novel",
    now: NOW,
  });
  if (!project.ok) {
    throw project.error;
  }
  return project.value;
}

async function chapterWithHistory(): Promise<InMemoryContentStore> {
  const projects = new InMemoryProjectRepository();
  projects.seed(activeProject());
  const store = new InMemoryContentStore(new InMemoryCandidateRepository());
  const created = await new CreateChapter(
    projects,
    store,
    new SequenceIds([CHAPTER_ID, VERSION_ID]),
    new FixedClock(),
    new FixedHasher(),
  ).execute({
    projectId: PROJECT_ID,
    title: "Chapter One",
    content: "First edition",
  });
  if (!created.ok) {
    throw created.error;
  }
  const edited = await new EditChapter(
    store,
    store,
    new SequenceIds([DRAFT_ID]),
    new FixedClock(),
  ).execute({
    chapterId: CHAPTER_ID,
    expectedRevision: 1,
    content: "Second edition",
    cursorOffset: 14,
  });
  if (!edited.ok) {
    throw edited.error;
  }
  const saved = await new SaveChapter(
    store,
    store,
    store,
    new SequenceIds([NEXT_VERSION_ID]),
    new FixedClock(),
    new FixedHasher(),
  ).execute({
    chapterId: CHAPTER_ID,
    expectedRevision: 1,
    reason: "manual",
  });
  if (!saved.ok) {
    throw saved.error;
  }
  return store;
}

function restore(
  store: InMemoryContentStore,
  versions: ChapterVersionRepository = store,
): RestoreChapterVersion {
  return new RestoreChapterVersion(
    store,
    versions,
    store,
    new SequenceIds([RESTORED_VERSION_ID]),
    new FixedClock(),
    new FixedHasher(),
  );
}

describe("chapter version restoration", () => {
  it("appends a recovery version while preserving every historical version", async () => {
    const store = await chapterWithHistory();
    store.syncQueued = true;
    const original = await store.findVersionById(VERSION_ID);
    expect(original.ok && original.value?.toSnapshot().content).toBe("First edition");
    expect(original.ok && original.value?.toSnapshot().organizeLocalStoryFacts).toBe(false);

    const outcome = await restore(store).execute({
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      expectedRevision: 2,
      organizeLocalStoryFacts: true,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.value.chapter.toSnapshot()).toMatchObject({
      content: "First edition",
      currentVersionId: RESTORED_VERSION_ID,
      revision: 3,
    });
    expect(outcome.value.version.toSnapshot()).toMatchObject({
      id: RESTORED_VERSION_ID,
      parentVersionId: NEXT_VERSION_ID,
      sequence: 3,
      content: "First edition",
      reason: "recovery",
      sourceCandidateId: null,
      organizeLocalStoryFacts: true,
    });
    expect(outcome.value.restoredFromVersion.toSnapshot()).toEqual(
      original.ok && original.value !== null ? original.value.toSnapshot() : undefined,
    );
    expect(outcome.value.saveState).toBe("pending_sync");

    const versions = await store.listByChapterId(CHAPTER_ID);
    expect(versions.ok && versions.value.map((version) => version.sequence)).toEqual([1, 2, 3]);
    const preservedOriginal = await store.findVersionById(VERSION_ID);
    const preservedSecond = await store.findVersionById(NEXT_VERSION_ID);
    expect(preservedOriginal.ok && preservedOriginal.value?.toSnapshot().content).toBe(
      "First edition",
    );
    expect(preservedSecond.ok && preservedSecond.value?.toSnapshot().content).toBe(
      "Second edition",
    );
  });

  it("rejects a stale expected revision before creating a new version", async () => {
    const store = await chapterWithHistory();

    const outcome = await restore(store).execute({
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      expectedRevision: 1,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("VERSION_CONFLICT");
    }
    const chapter = await store.findById(CHAPTER_ID);
    expect(chapter.ok && chapter.value?.toSnapshot()).toMatchObject({
      content: "Second edition",
      revision: 2,
      currentVersionId: NEXT_VERSION_ID,
    });
    const versions = await store.listByChapterId(CHAPTER_ID);
    expect(versions.ok && versions.value).toHaveLength(2);
  });

  it("fails closed when the selected version checksum is corrupt", async () => {
    const store = await chapterWithHistory();
    const original = await store.findVersionById(VERSION_ID);
    if (!original.ok || original.value === null) {
      throw new Error("Expected the original version.");
    }
    const corrupt = ChapterVersion.create({
      ...original.value.toSnapshot(),
      contentChecksum: checksum("b"),
    });
    if (!corrupt.ok) {
      throw corrupt.error;
    }
    const corruptVersions: ChapterVersionRepository = {
      findVersionById: () => Promise.resolve(ok(corrupt.value)),
      listByChapterId: (chapterId) => store.listByChapterId(chapterId),
    };

    const outcome = await restore(store, corruptVersions).execute({
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      expectedRevision: 2,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("REPOSITORY_ERROR");
      expect(outcome.error.details.reason).toBe("CHAPTER_VERSION_CHECKSUM_MISMATCH");
    }
    const chapter = await store.findById(CHAPTER_ID);
    expect(chapter.ok && chapter.value?.content).toBe("Second edition");
    const versions = await store.listByChapterId(CHAPTER_ID);
    expect(versions.ok && versions.value).toHaveLength(2);
  });

  it("reports a missing selected version without modifying history", async () => {
    const store = await chapterWithHistory();

    const outcome = await restore(store).execute({
      chapterId: CHAPTER_ID,
      versionId: MISSING_VERSION_ID,
      expectedRevision: 2,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("BASE_VERSION_CHANGED");
      expect(outcome.error.details.reason).toBe("CHAPTER_VERSION_NOT_FOUND");
    }
    const versions = await store.listByChapterId(CHAPTER_ID);
    expect(versions.ok && versions.value).toHaveLength(2);
  });

  it("rejects a selected version owned by another chapter", async () => {
    const store = await chapterWithHistory();
    const original = await store.findVersionById(VERSION_ID);
    if (!original.ok || original.value === null) {
      throw new Error("Expected the original version.");
    }
    const foreign = ChapterVersion.create({
      ...original.value.toSnapshot(),
      chapterId: OTHER_CHAPTER_ID,
    });
    if (!foreign.ok) {
      throw foreign.error;
    }
    const foreignVersions: ChapterVersionRepository = {
      findVersionById: () => Promise.resolve(ok(foreign.value)),
      listByChapterId: (chapterId) => store.listByChapterId(chapterId),
    };

    const outcome = await restore(store, foreignVersions).execute({
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      expectedRevision: 2,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("BASE_VERSION_CHANGED");
      expect(outcome.error.details.reason).toBe("CHAPTER_VERSION_OWNERSHIP_MISMATCH");
    }
    const versions = await store.listByChapterId(CHAPTER_ID);
    expect(versions.ok && versions.value).toHaveLength(2);
  });

  it("returns no changes when the selected version is already current", async () => {
    const store = await chapterWithHistory();

    const outcome = await restore(store).execute({
      chapterId: CHAPTER_ID,
      versionId: NEXT_VERSION_ID,
      expectedRevision: 2,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("NO_CHANGES");
    }
    const versions = await store.listByChapterId(CHAPTER_ID);
    expect(versions.ok && versions.value).toHaveLength(2);
  });

  it("rolls back chapter and appended version when the atomic commit fails", async () => {
    const store = await chapterWithHistory();
    store.failNextRestoreCommit = true;

    const outcome = await restore(store).execute({
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      expectedRevision: 2,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("SAVE_FAILED");
    }
    const chapter = await store.findById(CHAPTER_ID);
    expect(chapter.ok && chapter.value?.toSnapshot()).toMatchObject({
      content: "Second edition",
      revision: 2,
      currentVersionId: NEXT_VERSION_ID,
    });
    const versions = await store.listByChapterId(CHAPTER_ID);
    expect(versions.ok && versions.value).toHaveLength(2);
    const failedVersion = await store.findVersionById(RESTORED_VERSION_ID);
    expect(failedVersion.ok && failedVersion.value).toBeNull();
  });
});
