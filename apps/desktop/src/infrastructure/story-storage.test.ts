import {
  FormalStoryRecord,
  IdeationDraft,
  MemoryPolicy,
  MemoryRecord,
  Outline,
  parseIsoUtcTimestamp,
  type Result,
  type StoryCoreError,
  type UuidV7,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import {
  BrowserDevelopmentFormalStoryRecordRepository,
  BrowserDevelopmentIdeationDraftRepository,
  BrowserDevelopmentMemoryPolicyRepository,
  BrowserDevelopmentMemoryGovernanceUnitOfWork,
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
    ).toMatchObject({ schemaVersion: 6 });
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
    ).toMatchObject({ schemaVersion: 6 });
  });
});

describe("BrowserDevelopmentMemoryGovernanceUnitOfWork", () => {
  it("commits a manual merge in one storage write and preserves both source snapshots", async () => {
    const policies = new BrowserDevelopmentMemoryPolicyRepository(window.localStorage);
    const records = new BrowserDevelopmentMemoryRecordRepository(window.localStorage);
    const creation = new BrowserDevelopmentMemoryRecordCreationUnitOfWork(window.localStorage);
    const governance = new BrowserDevelopmentMemoryGovernanceUnitOfWork(window.localStorage);
    const policy = expectOk(MemoryPolicy.create(PROJECT_ID, CREATED_AT));
    expectOk(await policies.createIfAbsent(policy));
    const target = createUserMemory(40, "目标记忆");
    const source = createUserMemory(43, "来源记忆");
    for (const record of [target, source]) {
      expectOk(
        await creation.create({
          record,
          expectedAutomaticLearningPolicyRevision: null,
        }),
      );
    }
    const nextTarget = expectOk(
      target.edit({
        content: "用户编辑后的合并内容",
        humanConfirmed: true,
        expectedRevision: target.revision,
        now: UPDATED_AT,
      }),
    );
    const nextSource = expectOk(
      source.exclude({
        humanConfirmed: true,
        expectedRevision: source.revision,
        now: UPDATED_AT,
      }),
    );
    const operationId = uuid(46);
    const result = expectOk(
      await governance.commit({
        operationId,
        projectId: PROJECT_ID,
        operation: "merge",
        targetRecordId: target.id,
        previousPolicy: null,
        nextPolicy: null,
        records: [
          { role: "merge_target", previous: target, next: nextTarget },
          { role: "merge_source", previous: source, next: nextSource },
        ],
        requestJson: JSON.stringify({ operation: "merge", content: "用户编辑后的合并内容" }),
        now: expectOk(parseIsoUtcTimestamp(UPDATED_AT)),
      }),
    );
    expect(result.idempotentReplay).toBe(false);
    expect(expectOk(await records.findById(target.id))?.toSnapshot().content).toBe(
      "用户编辑后的合并内容",
    );
    expect(expectOk(await records.findById(source.id))?.toSnapshot().excluded).toBe(true);

    const database = JSON.parse(
      window.localStorage.getItem(DEVELOPMENT_STORY_STORE_KEY) ?? "{}",
    ) as {
      memoryGovernanceEvents: Record<
        string,
        { beforeSnapshotJson: string; afterSnapshotJson: string }
      >;
    };
    expect(database.memoryGovernanceEvents[operationId]?.beforeSnapshotJson).toContain(
      target.toSnapshot().source.sourceId,
    );
    expect(database.memoryGovernanceEvents[operationId]?.beforeSnapshotJson).toContain(
      source.toSnapshot().source.sourceId,
    );
  });

  it("leaves the previous database untouched when the single localStorage commit fails", async () => {
    const storage = new ThrowOnceStorage();
    const policies = new BrowserDevelopmentMemoryPolicyRepository(storage);
    const creation = new BrowserDevelopmentMemoryRecordCreationUnitOfWork(storage);
    const governance = new BrowserDevelopmentMemoryGovernanceUnitOfWork(storage);
    const policy = expectOk(MemoryPolicy.create(PROJECT_ID, CREATED_AT));
    expectOk(await policies.createIfAbsent(policy));
    const record = createUserMemory(50, "需要原子忘掉");
    expectOk(await creation.create({ record, expectedAutomaticLearningPolicyRevision: null }));
    const before = storage.getItem(DEVELOPMENT_STORY_STORE_KEY);
    const excluded = expectOk(
      record.exclude({
        humanConfirmed: true,
        expectedRevision: record.revision,
        now: UPDATED_AT,
      }),
    );
    storage.failNextWrite = true;
    const result = await governance.commit({
      operationId: uuid(53),
      projectId: PROJECT_ID,
      operation: "forget_project",
      targetRecordId: null,
      previousPolicy: policy,
      nextPolicy: policy,
      records: [{ role: "forgotten", previous: record, next: excluded }],
      requestJson: JSON.stringify({ operation: "forget_project", records: [record.id] }),
      now: expectOk(parseIsoUtcTimestamp(UPDATED_AT)),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "STORY_REPOSITORY_ERROR" } });
    expect(storage.getItem(DEVELOPMENT_STORY_STORE_KEY)).toBe(before);
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

function createUserMemory(sequence: number, content: string): MemoryRecord {
  return expectOk(
    MemoryRecord.create({
      id: uuid(sequence),
      projectId: PROJECT_ID,
      level: "L2",
      content,
      source: { kind: "user_rule", sourceId: uuid(sequence + 1), sourceVersionId: null },
      origin: "user",
      now: CREATED_AT,
    }),
  );
}

class ThrowOnceStorage implements Storage {
  readonly #values = new Map<string, string>();
  public failNextWrite = false;

  public get length(): number {
    return this.#values.size;
  }

  public clear(): void {
    this.#values.clear();
  }

  public getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.#values.delete(key);
  }

  public setItem(key: string, value: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    }
    this.#values.set(key, value);
  }
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
