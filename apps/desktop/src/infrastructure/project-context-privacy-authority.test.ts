import type { ChapterRepository, ContentHasher } from "@inkshadow/application";
import {
  Chapter,
  ok,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type IsoUtcTimestamp,
  type UuidV7,
} from "@inkshadow/domain";
import { CryptoContentHasher } from "@inkshadow/platform";
import { describe, expect, it } from "vitest";

import {
  ProjectContextPrivacyAuthority,
  ProjectContextPrivacyError,
} from "./project-context-privacy-authority";

const PROJECT_ID = uuid("019f9f4a-b3c7-7350-9226-000000000001");
const CHAPTER_A = uuid("019f9f4a-b3c7-7350-9226-000000000002");
const CHAPTER_B = uuid("019f9f4a-b3c7-7350-9226-000000000003");
const VERSION_A = uuid("019f9f4a-b3c7-7350-9226-000000000004");
const VERSION_B = uuid("019f9f4a-b3c7-7350-9226-000000000005");
const VERSION_A_NEXT = uuid("019f9f4a-b3c7-7350-9226-000000000006");
const NOW = timestamp("2026-08-08T00:00:00.000Z");
const LATER = timestamp("2026-08-08T00:01:00.000Z");

describe("ProjectContextPrivacyAuthority", () => {
  it("matches the cross-language canonical receipt golden fingerprint", async () => {
    const authority = new ProjectContextPrivacyAuthority(
      {
        listByProjectId: () => Promise.reject(new Error("metadata projection is required")),
        listPrivacyAuthorityByProjectId: () =>
          Promise.resolve(
            ok([
              {
                chapterId: CHAPTER_A,
                currentVersionId: VERSION_A,
                chapterRevision: 2,
                privacyRevision: 3,
                privacyMode: "standard" as const,
                status: "active" as const,
              },
              {
                chapterId: CHAPTER_B,
                currentVersionId: VERSION_B,
                chapterRevision: 7,
                privacyRevision: 8,
                privacyMode: "local_only" as const,
                status: "trashed" as const,
              },
            ]),
          ),
      },
      new CryptoContentHasher(),
    );

    await expect(authority.inspect(PROJECT_ID)).resolves.toMatchObject({
      fingerprint: "753e6be487ad58ca9953b20d3e27a8cbc4c27fcba281cffa557e074040520ee3",
      activeChapterCount: 1,
      retainedChapterCount: 2,
      requiresVerifiedLocal: true,
    });
  });

  it("taints the whole project when a retained trashed chapter is local-only", async () => {
    const active = chapter({ id: CHAPTER_A, versionId: VERSION_A });
    const trashedPrivate = trash(
      chapter({ id: CHAPTER_B, versionId: VERSION_B, privacyMode: "local_only" }),
    );
    const repository = new MutableChapterRepository([trashedPrivate, active]);
    const recordingHasher = new RecordingHasher();
    const authority = new ProjectContextPrivacyAuthority(repository, recordingHasher);

    const receipt = await authority.inspect(PROJECT_ID);

    expect(receipt).toMatchObject({
      activeChapterCount: 1,
      retainedChapterCount: 2,
      requiresVerifiedLocal: true,
    });
    expect(receipt.chapters.map(({ chapterId }) => chapterId)).toEqual([CHAPTER_A, CHAPTER_B]);
    expect(recordingHasher.inputs).toHaveLength(1);
    expect(recordingHasher.inputs[0]).not.toContain("SECRET_BODY_A");
    expect(recordingHasher.inputs[0]).not.toContain("SECRET_TITLE_A");
    expect(recordingHasher.inputs[0]).not.toContain("SECRET_BODY_B");
    expect(() => authority.assertRouteEligible(receipt, false)).toThrow(
      expect.objectContaining({ code: "PRIVATE_CHAPTER_LOCAL_ONLY" }),
    );
    expect(() => authority.assertRouteEligible(receipt, true)).not.toThrow();
  });

  it("uses the metadata-only repository projection without loading chapter正文", async () => {
    let fullChapterRead = false;
    const authority = new ProjectContextPrivacyAuthority(
      {
        listByProjectId: () => {
          fullChapterRead = true;
          return Promise.reject(new Error("full chapter rows must not be loaded"));
        },
        listPrivacyAuthorityByProjectId: () =>
          Promise.resolve(
            ok([
              {
                chapterId: CHAPTER_A,
                currentVersionId: VERSION_A,
                chapterRevision: 1,
                privacyRevision: 1,
                privacyMode: "standard" as const,
                status: "active" as const,
              },
              {
                chapterId: CHAPTER_B,
                currentVersionId: VERSION_B,
                chapterRevision: 2,
                privacyRevision: 3,
                privacyMode: "local_only" as const,
                status: "trashed" as const,
              },
            ]),
          ),
      },
      new CryptoContentHasher(),
    );

    await expect(authority.inspect(PROJECT_ID)).resolves.toMatchObject({
      activeChapterCount: 1,
      retainedChapterCount: 2,
      requiresVerifiedLocal: true,
    });
    expect(fullChapterRead).toBe(false);
  });

  it("rejects add, remove, accepted-version, privacy ABA, and lifecycle changes", async () => {
    const original = chapter({ id: CHAPTER_A, versionId: VERSION_A });
    const repository = new MutableChapterRepository([original]);
    const authority = new ProjectContextPrivacyAuthority(repository, new CryptoContentHasher());

    const beforeAdd = await authority.inspect(PROJECT_ID);
    repository.chapters = [original, chapter({ id: CHAPTER_B, versionId: VERSION_B })];
    await expect(authority.assertCurrentBeforeDispatch(beforeAdd)).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_PRIVACY_CHANGED",
    });

    const beforeRemove = await authority.inspect(PROJECT_ID);
    repository.chapters = [original];
    await expect(authority.assertCurrentBeforeDispatch(beforeRemove)).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_PRIVACY_CHANGED",
    });

    const beforeVersion = await authority.inspect(PROJECT_ID);
    const saved = original.saveContent({
      content: "accepted new body",
      expectedRevision: original.revision,
      newVersionId: VERSION_A_NEXT,
      now: LATER,
    });
    if (!saved.ok) {
      throw saved.error;
    }
    repository.chapters = [saved.value];
    await expect(authority.assertCurrentBeforeDispatch(beforeVersion)).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_PRIVACY_CHANGED",
    });

    const beforePrivacyAba = await authority.inspect(PROJECT_ID);
    const privateChapter = saved.value.changePrivacy({
      privacyMode: "local_only",
      expectedPrivacyRevision: saved.value.privacyRevision,
      now: LATER,
    });
    if (!privateChapter.ok) {
      throw privateChapter.error;
    }
    const standardAgain = privateChapter.value.changePrivacy({
      privacyMode: "standard",
      expectedPrivacyRevision: privateChapter.value.privacyRevision,
      now: LATER,
    });
    if (!standardAgain.ok) {
      throw standardAgain.error;
    }
    repository.chapters = [standardAgain.value];
    await expect(authority.assertCurrentBeforeDispatch(beforePrivacyAba)).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_PRIVACY_CHANGED",
    });

    const beforeTrash = await authority.inspect(PROJECT_ID);
    repository.chapters = [trash(standardAgain.value)];
    await expect(authority.assertCurrentBeforeDispatch(beforeTrash)).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_PRIVACY_CHANGED",
    });
  });

  it("clears project taint only after a local-only row is permanently absent", async () => {
    const privateChapter = chapter({
      id: CHAPTER_A,
      versionId: VERSION_A,
      privacyMode: "local_only",
    });
    const repository = new MutableChapterRepository([privateChapter]);
    const authority = new ProjectContextPrivacyAuthority(repository, new CryptoContentHasher());
    const retained = await authority.inspect(PROJECT_ID);
    expect(retained.requiresVerifiedLocal).toBe(true);

    repository.chapters = [];
    const permanentlyRemoved = await authority.inspect(PROJECT_ID);
    expect(permanentlyRemoved).toMatchObject({
      activeChapterCount: 0,
      retainedChapterCount: 0,
      requiresVerifiedLocal: false,
    });
    await expect(authority.assertCurrentBeforeDispatch(retained)).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_PRIVACY_CHANGED",
    });
  });

  it("fails closed when repository or fingerprint authority is unavailable", async () => {
    const repositoryFailure = new ProjectContextPrivacyAuthority(
      {
        listByProjectId: () => Promise.reject(new Error("database unavailable")),
      },
      new CryptoContentHasher(),
    );
    await expect(repositoryFailure.inspect(PROJECT_ID)).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
      retryable: true,
    });

    const hashFailure = new ProjectContextPrivacyAuthority(new MutableChapterRepository([]), {
      sha256: () => Promise.reject(new Error("hash unavailable")),
    });
    await expect(hashFailure.inspect(PROJECT_ID)).rejects.toMatchObject({
      code: "PROJECT_CONTEXT_PRIVACY_UNAVAILABLE",
      retryable: true,
    });
    await expect(hashFailure.inspect("not-a-project-id")).rejects.toBeInstanceOf(
      ProjectContextPrivacyError,
    );
  });
});

class MutableChapterRepository implements Pick<ChapterRepository, "listByProjectId"> {
  public constructor(public chapters: readonly Chapter[]) {}

  public listByProjectId(projectId: UuidV7) {
    return Promise.resolve(
      ok(this.chapters.filter((candidate) => candidate.projectId === projectId)),
    );
  }
}

class RecordingHasher implements ContentHasher {
  public readonly inputs: string[] = [];
  private readonly delegate = new CryptoContentHasher();

  public sha256(value: string) {
    this.inputs.push(value);
    return this.delegate.sha256(value);
  }
}

function chapter(input: {
  readonly id: UuidV7;
  readonly versionId: UuidV7;
  readonly privacyMode?: "standard" | "local_only";
}): Chapter {
  const created = Chapter.create({
    id: input.id,
    projectId: PROJECT_ID,
    title: input.id === CHAPTER_A ? "SECRET_TITLE_A" : "SECRET_TITLE_B",
    content: input.id === CHAPTER_A ? "SECRET_BODY_A" : "SECRET_BODY_B",
    initialVersionId: input.versionId,
    privacyMode: input.privacyMode ?? "standard",
    now: NOW,
  });
  if (!created.ok) {
    throw created.error;
  }
  return created.value;
}

function trash(value: Chapter): Chapter {
  const rehydrated = Chapter.rehydrate({
    ...value.toSnapshot(),
    status: "trashed",
    trashedAt: LATER,
    updatedAt: LATER,
  });
  if (!rehydrated.ok) {
    throw rehydrated.error;
  }
  return rehydrated.value;
}

function uuid(value: string): UuidV7 {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function timestamp(value: string): IsoUtcTimestamp {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}
