import {
  FormalStoryRecord,
  IdeationDraft,
  MemoryPolicy,
  MemoryRecord,
  Outline,
  type Result,
  type StoryCoreError,
  type UuidV7,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import {
  BrowserDevelopmentFormalStoryRecordRepository,
  BrowserDevelopmentIdeationDraftRepository,
  BrowserDevelopmentMemoryPolicyRepository,
  BrowserDevelopmentMemoryRecordCreationUnitOfWork,
  BrowserDevelopmentMemoryRecordRepository,
  BrowserDevelopmentOutlineRepository,
  DEVELOPMENT_STORY_STORE_KEY,
} from "./story-storage";

const PROJECT_ID = uuid(1);
const BOOK_ID = uuid(2);
const FIRST_VOLUME_ID = uuid(3);
const SECOND_VOLUME_ID = uuid(4);
const CREATED_AT = "2026-07-27T00:00:00.000Z";
const UPDATED_AT = "2026-07-27T00:00:01.000Z";

describe("BrowserDevelopmentOutlineRepository", () => {
  it("persists outlines across reopen and rejects a stale compare-and-swap save", async () => {
    const repository = new BrowserDevelopmentOutlineRepository(window.localStorage);
    const outline = createOutline();

    expectOk(await repository.create(outline));
    const firstChange = expectOk(
      outline.addNode({
        id: FIRST_VOLUME_ID,
        kind: "volume",
        parentId: BOOK_ID,
        title: "第一卷",
        expectedRevision: outline.revision,
        now: UPDATED_AT,
      }),
    );
    expectOk(await repository.save(firstChange, outline.revision));

    const reopened = new BrowserDevelopmentOutlineRepository(window.localStorage);
    const loaded = expectOk(await reopened.findByProjectId(PROJECT_ID));
    expect(loaded?.revision).toBe(2);
    expect(loaded?.orderedChildren(BOOK_ID).map(({ title }) => title)).toEqual(["第一卷"]);

    const staleBranch = expectOk(
      outline.addNode({
        id: SECOND_VOLUME_ID,
        kind: "volume",
        parentId: BOOK_ID,
        title: "冲突卷",
        expectedRevision: outline.revision,
        now: UPDATED_AT,
      }),
    );
    const staleSave = await reopened.save(staleBranch, outline.revision);
    expect(staleSave).toMatchObject({
      ok: false,
      error: {
        code: "STORY_REVISION_CONFLICT",
        retryable: true,
      },
    });

    const unchanged = expectOk(await reopened.findByProjectId(PROJECT_ID));
    expect(unchanged?.orderedChildren(BOOK_ID).map(({ title }) => title)).toEqual(["第一卷"]);
  });

  it("returns an explicit repository error for corrupt local data", async () => {
    window.localStorage.setItem(
      DEVELOPMENT_STORY_STORE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        outlines: {
          [PROJECT_ID]: {
            projectId: PROJECT_ID,
            revision: 1,
            nodes: [],
          },
        },
      }),
    );
    const repository = new BrowserDevelopmentOutlineRepository(window.localStorage);

    await expect(repository.findByProjectId(PROJECT_ID)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "STORY_REPOSITORY_ERROR",
      },
    });
  });

  it("persists formal records and governed memory while migrating an outline-only store", async () => {
    const outline = createOutline();
    window.localStorage.setItem(
      DEVELOPMENT_STORY_STORE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        outlines: {
          [PROJECT_ID]: outline.toSnapshot(),
        },
      }),
    );
    const formalRecords = new BrowserDevelopmentFormalStoryRecordRepository(window.localStorage);
    const policies = new BrowserDevelopmentMemoryPolicyRepository(window.localStorage);
    const memories = new BrowserDevelopmentMemoryRecordRepository(window.localStorage);
    const memoryCreation = new BrowserDevelopmentMemoryRecordCreationUnitOfWork(
      window.localStorage,
    );
    const formalRecord = expectOk(
      FormalStoryRecord.create({
        id: uuid(10),
        projectId: PROJECT_ID,
        kind: "character",
        recordKey: "character.hero",
        value: { title: "林舟", description: "不会在公开场合摘下面具。" },
        actorId: uuid(11),
        humanConfirmed: true,
        now: CREATED_AT,
      }),
    );
    expectOk(await formalRecords.create(formalRecord));

    const policy = expectOk(MemoryPolicy.create(PROJECT_ID, CREATED_AT));
    expect(expectOk(await policies.createIfAbsent(policy))).toMatchObject({ created: true });
    const memory = expectOk(
      MemoryRecord.create({
        id: uuid(12),
        projectId: PROJECT_ID,
        level: "L3",
        content: "叙事保持克制，不提前解释伏笔。",
        source: {
          kind: "user_rule",
          sourceId: uuid(11),
          sourceVersionId: null,
        },
        origin: "user",
        now: CREATED_AT,
      }),
    );
    expectOk(
      await memoryCreation.create({
        record: memory,
        expectedAutomaticLearningPolicyRevision: null,
      }),
    );
    const pinned = expectOk(
      memory.pin({
        humanConfirmed: true,
        expectedRevision: 1,
        now: UPDATED_AT,
      }),
    );
    expectOk(await memories.save(pinned, 1));

    const reopenedOutline = new BrowserDevelopmentOutlineRepository(window.localStorage);
    expect(expectOk(await reopenedOutline.findByProjectId(PROJECT_ID))?.revision).toBe(1);
    expect(
      expectOk(await formalRecords.listByProjectId(PROJECT_ID)).map(
        (record) => record.toSnapshot().recordKey,
      ),
    ).toEqual(["character.hero"]);
    expect(
      expectOk(await memories.listByProjectId(PROJECT_ID)).map(
        (record) => record.toSnapshot().pinned,
      ),
    ).toEqual([true]);
    expect(
      JSON.parse(window.localStorage.getItem(DEVELOPMENT_STORY_STORE_KEY) ?? "{}"),
    ).toMatchObject({ schemaVersion: 5 });
  });
});

describe("BrowserDevelopmentIdeationDraftRepository", () => {
  it("persists resumable drafts, orders active work, and rejects stale saves", async () => {
    const repository = new BrowserDevelopmentIdeationDraftRepository(window.localStorage);
    const first = expectOk(
      IdeationDraft.create({
        id: uuid(30),
        mode: "guided",
        projectName: "九步构思",
        now: CREATED_AT,
      }),
    );
    const second = expectOk(
      IdeationDraft.create({
        id: uuid(31),
        mode: "guided",
        projectName: "稍后构思",
        now: CREATED_AT,
      }),
    );
    expectOk(await repository.create(first));
    expectOk(await repository.create(second));

    const edited = expectOk(
      first.updateStep({
        step: "premise",
        value: "一封信让两个时代同时失去一天。",
        expectedRevision: 1,
        now: UPDATED_AT,
      }),
    );
    expectOk(await repository.save(edited, 1));
    expect(expectOk(await repository.listActive()).map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ]);

    const stale = expectOk(
      first.skipStep({
        step: "premise",
        expectedRevision: 1,
        now: UPDATED_AT,
      }),
    );
    await expect(repository.save(stale, 1)).resolves.toMatchObject({
      ok: false,
      error: { code: "STORY_REVISION_CONFLICT" },
    });
    expect(expectOk(await repository.findById(first.id))?.toSnapshot()).toEqual(
      edited.toSnapshot(),
    );
    expect(
      JSON.parse(window.localStorage.getItem(DEVELOPMENT_STORY_STORE_KEY) ?? "{}"),
    ).toMatchObject({ schemaVersion: 5 });
  });
});

function createOutline(): Outline {
  return expectOk(
    Outline.create({
      projectId: PROJECT_ID,
      bookId: BOOK_ID,
      title: "长篇小说",
      synopsis: "三层大纲",
      now: CREATED_AT,
    }),
  );
}

function uuid(sequence: number): UuidV7 {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}` as UuidV7;
}

function expectOk<Value>(result: Result<Value, StoryCoreError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
