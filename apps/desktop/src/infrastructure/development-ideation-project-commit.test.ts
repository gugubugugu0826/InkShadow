import {
  Project,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7 as parseDomainUuid,
  type UuidV7 as DomainUuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import {
  IDEATION_STEP_KEYS,
  IdeationDraft,
  parseUuidV7 as parseStoryUuid,
  type IdeationStepKey,
  type ProjectSeed,
  type Result,
  type StoryCoreError,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_DATABASE_KEY,
  DEVELOPMENT_IDEATION_JOURNAL_KEY,
  DEVELOPMENT_STORY_STORE_KEY,
} from "./development-atomic-journal";
import { BrowserDevelopmentIdeationProjectCommitUnitOfWork } from "./development-ideation-project-commit";
import { createDevelopmentRepositories } from "./development-storage";
import {
  BrowserDevelopmentFormalStoryRecordRepository,
  BrowserDevelopmentIdeationDraftRepository,
  BrowserDevelopmentOutlineRepository,
} from "./story-storage";

const CREATED_AT = requireTimestamp("2026-07-27T00:00:00.000Z");
const FINALIZED_AT = requireTimestamp("2026-07-27T00:00:01.000Z");
const EMPTY_SHA256 = requireChecksum(
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);
const SECRET = "test-secret-must-not-enter-a-journal";

describe("BrowserDevelopmentIdeationProjectCommitUnitOfWork", () => {
  it("persists the complete ideation project and only succeeds after clearing the journal", async () => {
    const prepared = await prepareDraft(window.localStorage, 10, 100);
    const committer = createCommitter(window.localStorage, 200);

    expect(await committer.commit(prepared.input)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(window.localStorage.getItem(DEVELOPMENT_IDEATION_JOURNAL_KEY)).toBeNull();

    const development = createDevelopmentRepositories(window.localStorage);
    const storedProject = expectOk(
      await development.projects.findById(domainUuidValue(prepared.input.projectId)),
    );
    expect(storedProject?.name).toBe("雾港来信");
    const chapters = expectOk(
      await development.chapters.listByProjectId(domainUuidValue(prepared.input.projectId)),
    );
    expect(chapters.map(({ title, content }) => ({ title, content }))).toEqual([
      { title: "第一章", content: "" },
    ]);
    const firstChapter = chapters[0];
    if (firstChapter === undefined) {
      throw new Error("The atomic commit did not create its first chapter.");
    }
    const versions = expectOk(await development.chapterVersions.listByChapterId(firstChapter.id));
    expect(
      versions.map((version) => {
        const snapshot = version.toSnapshot();
        return {
          reason: snapshot.reason,
          contentChecksum: snapshot.contentChecksum,
          sequence: snapshot.sequence,
        };
      }),
    ).toEqual([{ reason: "created", contentChecksum: EMPTY_SHA256, sequence: 1 }]);

    const outline = expectOk(
      await new BrowserDevelopmentOutlineRepository(window.localStorage).findByProjectId(
        prepared.input.projectId,
      ),
    );
    expect(outline?.toSnapshot().nodes).toHaveLength(3);
    const records = expectOk(
      await new BrowserDevelopmentFormalStoryRecordRepository(window.localStorage).listByProjectId(
        prepared.input.projectId,
      ),
    );
    expect(
      records.map((record) => {
        const snapshot = record.toSnapshot();
        return {
          kind: snapshot.kind,
          recordKey: snapshot.recordKey,
        };
      }),
    ).toEqual([
      {
        kind: "character",
        recordKey: "ideation.key_characters",
      },
      {
        kind: "world_rule",
        recordKey: "ideation.world_skeleton",
      },
    ]);
    const finalized = expectOk(
      await new BrowserDevelopmentIdeationDraftRepository(window.localStorage).findById(
        prepared.active.id,
      ),
    );
    expect(finalized?.toSnapshot()).toEqual(prepared.input.draft.toSnapshot());

    const developmentRaw = parseObject(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY));
    expect(developmentRaw).toMatchObject({
      schemaVersion: 2,
      projectDisplayIdentities: [
        {
          projectId: prepared.input.projectId,
          displayKind: "author_work",
          provenance: "explicit_creation",
          recordedAt: FINALIZED_AT,
          revision: 1,
        },
      ],
      projectDisplayIdentityRevisions: [
        {
          projectId: prepared.input.projectId,
          previousDisplayKind: null,
          displayKind: "author_work",
          provenance: "explicit_creation",
          recordedAt: FINALIZED_AT,
          revision: 1,
        },
      ],
      auditEvents: [
        {
          projectId: prepared.input.projectId,
          entityType: "project",
          entityId: prepared.input.projectId,
          action: "create_from_ideation",
          metadata: { source: "ideation", mode: "guided" },
          createdAt: FINALIZED_AT,
        },
      ],
    });
  });

  it("keeps both stores byte-for-byte unchanged when the prepared-journal write exceeds quota", async () => {
    const prepared = await prepareDraft(window.localStorage, 20, 110);
    const before = captureStores(window.localStorage);
    const storage = new SelectiveFailureStorage(
      window.localStorage,
      ({ key }) => key === DEVELOPMENT_IDEATION_JOURNAL_KEY,
      "QuotaExceededError",
    );

    await expect(createCommitter(storage, 300).commit(prepared.input)).resolves.toMatchObject({
      ok: false,
      error: { code: "STORY_REPOSITORY_ERROR" },
    });
    expect(captureStores(window.localStorage)).toEqual(before);
  });

  it("rolls back byte-for-byte when the second setItem fails", async () => {
    const prepared = await prepareDraft(window.localStorage, 30, 120);
    const before = captureStores(window.localStorage);
    const storage = new SelectiveFailureStorage(
      window.localStorage,
      ({ setItemCall }) => setItemCall === 2,
    );

    await expect(createCommitter(storage, 400).commit(prepared.input)).resolves.toMatchObject({
      ok: false,
      error: { code: "STORY_REPOSITORY_ERROR" },
    });
    expect(captureStores(window.localStorage)).toEqual(before);
  });

  it("rolls back the first data store byte-for-byte when the story-store write fails", async () => {
    const prepared = await prepareDraft(window.localStorage, 40, 130);
    const existing = requireProject(
      Project.create({
        id: domainUuid(131),
        name: "已存在项目",
        now: CREATED_AT,
      }),
    );
    expectOk(await createDevelopmentRepositories(window.localStorage).projects.create(existing));
    const before = captureStores(window.localStorage);
    const storage = new SelectiveFailureStorage(
      window.localStorage,
      ({ key }) => key === DEVELOPMENT_STORY_STORE_KEY,
    );

    await expect(createCommitter(storage, 500).commit(prepared.input)).resolves.toMatchObject({
      ok: false,
      error: { code: "STORY_REPOSITORY_ERROR" },
    });
    expect(captureStores(window.localStorage)).toEqual(before);
  });

  it("does not report success when clearing the prepared journal fails", async () => {
    const prepared = await prepareDraft(window.localStorage, 45, 135);
    const before = captureStores(window.localStorage);
    const storage = new FailOnceOnJournalClearStorage(window.localStorage);

    await expect(createCommitter(storage, 550).commit(prepared.input)).resolves.toMatchObject({
      ok: false,
      error: { code: "STORY_REPOSITORY_ERROR" },
    });
    expect(captureStores(window.localStorage)).toEqual(before);
  });

  it.each([
    ["development repository", 50, 140, 600] as const,
    ["story repository", 51, 141, 620] as const,
  ])(
    "recovers before the first %s read after restart",
    async (firstReader, draftId, projectId, idStart) => {
      const prepared = await prepareDraft(window.localStorage, draftId, projectId);
      const before = captureStores(window.localStorage);
      const crashedStorage = new CrashDuringStoryWriteStorage(window.localStorage);

      await expect(
        createCommitter(crashedStorage, idStart).commit(prepared.input),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "STORY_REPOSITORY_ERROR" },
      });
      expect(window.localStorage.getItem(DEVELOPMENT_IDEATION_JOURNAL_KEY)).not.toBeNull();
      expect(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY)).not.toBe(before.development);
      expect(window.localStorage.getItem(DEVELOPMENT_STORY_STORE_KEY)).toBe(before.story);

      if (firstReader === "development repository") {
        expect(
          expectOk(
            await createDevelopmentRepositories(window.localStorage).projects.findById(
              domainUuidValue(prepared.input.projectId),
            ),
          ),
        ).toBeNull();
      }
      const reopenedDrafts = new BrowserDevelopmentIdeationDraftRepository(window.localStorage);
      const active = expectOk(await reopenedDrafts.findById(prepared.active.id));
      expect(active?.toSnapshot()).toEqual(prepared.active.toSnapshot());
      expect(captureStores(window.localStorage)).toEqual(before);
    },
  );

  it("fails closed without writing when a journal target is outside the strict allowlist", async () => {
    const prepared = await prepareDraft(window.localStorage, 60, 150);
    const crashedStorage = new CrashDuringStoryWriteStorage(window.localStorage);
    await createCommitter(crashedStorage, 700).commit(prepared.input);
    const serialized = window.localStorage.getItem(DEVELOPMENT_IDEATION_JOURNAL_KEY);
    const journal = parseObject(serialized);
    const targets = journal.targets as Record<string, unknown>[];
    if (targets[0] === undefined) {
      throw new Error("Prepared journal did not contain its first target.");
    }
    targets[0].key = "inkshadow.unrelated.secret-store.v1";
    window.localStorage.setItem(DEVELOPMENT_IDEATION_JOURNAL_KEY, JSON.stringify(journal));
    const beforeRead = captureStores(window.localStorage);

    await expect(
      createDevelopmentRepositories(window.localStorage).projects.findById(
        domainUuidValue(prepared.input.projectId),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_ERROR" },
    });
    await expect(
      new BrowserDevelopmentIdeationDraftRepository(window.localStorage).findById(
        prepared.active.id,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "STORY_REPOSITORY_ERROR" },
    });
    expect(captureStores(window.localStorage)).toEqual(beforeRead);
  });

  it("fails closed when journaled target data no longer matches any authorized state", async () => {
    const prepared = await prepareDraft(window.localStorage, 70, 160);
    const crashedStorage = new CrashDuringStoryWriteStorage(window.localStorage);
    await createCommitter(crashedStorage, 800).commit(prepared.input);
    const development = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
    if (development === null) {
      throw new Error("Expected a partially written development store.");
    }
    window.localStorage.setItem(DEVELOPMENT_DATABASE_KEY, `${development} `);
    const beforeRead = captureStores(window.localStorage);

    await expect(
      new BrowserDevelopmentIdeationDraftRepository(window.localStorage).findById(
        prepared.active.id,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "STORY_REPOSITORY_ERROR" },
    });
    expect(captureStores(window.localStorage)).toEqual(beforeRead);
  });

  it.each([
    ["stale draft CAS", "stale" as const],
    ["visible duplicate project name", "name" as const],
    ["duplicate generated entity ID", "id" as const],
  ])("rejects %s without changing a byte", async (_label, scenario) => {
    const prepared = await prepareDraft(window.localStorage, 80, 170);
    let idStart = 900;
    if (scenario === "stale") {
      const changed = expectOk(
        prepared.active.goToStep({
          step: "genre",
          expectedRevision: prepared.active.revision,
          now: FINALIZED_AT,
        }),
      );
      expectOk(
        await new BrowserDevelopmentIdeationDraftRepository(window.localStorage).save(
          changed,
          prepared.active.revision,
        ),
      );
    } else if (scenario === "name") {
      expectOk(
        await createDevelopmentRepositories(window.localStorage).projects.create(
          requireProject(
            Project.create({
              id: domainUuid(171),
              name: "雾港来信",
              now: CREATED_AT,
            }),
          ),
        ),
      );
    } else {
      idStart = 1_000;
      window.localStorage.setItem(
        DEVELOPMENT_DATABASE_KEY,
        JSON.stringify({
          schemaVersion: 2,
          projects: [],
          chapters: [{ id: domainUuid(idStart) }],
          versions: [],
          drafts: [],
          candidates: [],
          auditEvents: [],
        }),
      );
    }
    const before = captureStores(window.localStorage);

    const result = await createCommitter(window.localStorage, idStart).commit(prepared.input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        scenario === "name"
          ? "STORY_VALIDATION_FAILED"
          : scenario === "stale"
            ? "STORY_REVISION_CONFLICT"
            : "STORY_REPOSITORY_ERROR",
      );
    }
    expect(captureStores(window.localStorage)).toEqual(before);
  });

  it("does not copy token-like ideation content into the journal or audit event", async () => {
    const capturedJournals: string[] = [];
    const storage = new CapturingStorage(window.localStorage, (key, value) => {
      if (key === DEVELOPMENT_IDEATION_JOURNAL_KEY) {
        capturedJournals.push(value);
      }
    });
    const prepared = await prepareDraft(storage, 90, 180);
    window.localStorage.setItem(
      DEVELOPMENT_DATABASE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        projects: [],
        chapters: [],
        versions: [],
        drafts: [{ recoveryCanary: SECRET }],
        candidates: [],
        auditEvents: [],
      }),
    );

    expect((await createCommitter(storage, 1_100).commit(prepared.input)).ok).toBe(true);
    expect(capturedJournals).toHaveLength(1);
    expect(capturedJournals[0]).not.toContain(SECRET);
    const development = parseObject(window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY));
    expect(JSON.stringify(development.auditEvents)).not.toContain(SECRET);
  });
});

function createCommitter(
  storage: Storage,
  idStart: number,
): BrowserDevelopmentIdeationProjectCommitUnitOfWork {
  return new BrowserDevelopmentIdeationProjectCommitUnitOfWork(
    storage,
    new SequenceIds(idStart),
    { now: () => FINALIZED_AT },
    { sha256: () => Promise.resolve({ ok: true, value: EMPTY_SHA256 }) },
  );
}

async function prepareDraft(
  storage: Storage,
  draftSequence: number,
  projectSequence: number,
  overrides: Partial<Record<IdeationStepKey, string>> = {},
): Promise<
  Readonly<{
    active: IdeationDraft;
    input: Readonly<{
      draft: IdeationDraft;
      expectedDraftRevision: number;
      projectId: StoryUuidV7;
      seed: ProjectSeed;
    }>;
  }>
> {
  let active = requireDraft(
    IdeationDraft.create({
      id: storyUuid(draftSequence),
      mode: "guided",
      projectName: "雾港来信",
      now: CREATED_AT,
    }),
  );
  const values: Record<IdeationStepKey, string> = {
    genre: "悬疑幻想",
    target_audience: "偏好成长与谜题的成年读者",
    premise: "失忆邮差每天收到未来寄来的信。",
    protagonist_drive: "找回被自己主动删去的七年记忆",
    world_skeleton: "潮汐决定城市哪些街区能够被看见。",
    key_characters: "邮差林舟、钟表匠阿遥、未来的寄信人",
    plot_route: "追查来信—发现删忆交易—决定是否恢复真相",
    opening_hook: "第一封信准确预告了一桩尚未发生的失踪案。",
    output_spec: "目标 320,000 字；克制、带黑色幽默",
    ...overrides,
  };
  for (const step of IDEATION_STEP_KEYS) {
    active = requireDraft(
      active.updateStep({
        step,
        value: values[step],
        expectedRevision: active.revision,
        now: CREATED_AT,
      }),
    );
  }
  const seed = expectOk(active.buildProjectSeed());
  const projectId = storyUuid(projectSequence);
  const finalized = requireDraft(active.finalize(projectId, active.revision, FINALIZED_AT));
  expectOk(await new BrowserDevelopmentIdeationDraftRepository(storage).create(active));
  return Object.freeze({
    active,
    input: Object.freeze({
      draft: finalized,
      expectedDraftRevision: active.revision,
      projectId,
      seed,
    }),
  });
}

function captureStores(storage: Storage): Readonly<{
  development: string | null;
  story: string | null;
  journal: string | null;
}> {
  return Object.freeze({
    development: storage.getItem(DEVELOPMENT_DATABASE_KEY),
    story: storage.getItem(DEVELOPMENT_STORY_STORE_KEY),
    journal: storage.getItem(DEVELOPMENT_IDEATION_JOURNAL_KEY),
  });
}

function parseObject(serialized: string | null): Record<string, unknown> {
  if (serialized === null) {
    throw new Error("Expected persisted JSON.");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a persisted JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requireDraft(result: Result<IdeationDraft, StoryCoreError>): IdeationDraft {
  return expectOk(result);
}

function requireProject(result: ReturnType<typeof Project.create>): Project {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function expectOk<Value, ErrorType extends Error>(result: Result<Value, ErrorType>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function storyUuid(sequence: number): StoryUuidV7 {
  const result = parseStoryUuid(
    `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`,
  );
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function domainUuid(sequence: number): DomainUuidV7 {
  const result = parseDomainUuid(storyUuid(sequence));
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function domainUuidValue(value: string): DomainUuidV7 {
  const result = parseDomainUuid(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function requireTimestamp(value: string): ReturnType<typeof requireTimestampValue> {
  return requireTimestampValue(parseIsoUtcTimestamp(value));
}

function requireTimestampValue(result: ReturnType<typeof parseIsoUtcTimestamp>) {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function requireChecksum(value: string) {
  const result = parseContentChecksum(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

class SequenceIds implements UuidV7Generator {
  private sequence: number;

  public constructor(start: number) {
    this.sequence = start;
  }

  public next(): DomainUuidV7 {
    const value = domainUuid(this.sequence);
    this.sequence += 1;
    return value;
  }
}

interface MutationContext {
  readonly key: string;
  readonly value: string;
  readonly setItemCall: number;
}

class CapturingStorage implements Storage {
  public constructor(
    protected readonly delegate: Storage,
    private readonly onSetItem: (key: string, value: string) => void,
  ) {}

  public get length(): number {
    return this.delegate.length;
  }

  public clear(): void {
    this.delegate.clear();
  }

  public getItem(key: string): string | null {
    return this.delegate.getItem(key);
  }

  public key(index: number): string | null {
    return this.delegate.key(index);
  }

  public removeItem(key: string): void {
    this.delegate.removeItem(key);
  }

  public setItem(key: string, value: string): void {
    this.onSetItem(key, value);
    this.delegate.setItem(key, value);
  }
}

class SelectiveFailureStorage extends CapturingStorage {
  private setItemCalls = 0;
  private failed = false;

  public constructor(
    delegate: Storage,
    private readonly shouldFail: (context: MutationContext) => boolean,
    private readonly errorName = "InjectedStorageError",
  ) {
    super(delegate, () => undefined);
  }

  public override setItem(key: string, value: string): void {
    this.setItemCalls += 1;
    if (
      !this.failed &&
      this.shouldFail({
        key,
        value,
        setItemCall: this.setItemCalls,
      })
    ) {
      this.failed = true;
      throw new DOMException("Injected storage write failure.", this.errorName);
    }
    this.delegate.setItem(key, value);
  }
}

class CrashDuringStoryWriteStorage extends CapturingStorage {
  private mutationsUnavailable = false;

  public constructor(delegate: Storage) {
    super(delegate, () => undefined);
  }

  public override setItem(key: string, value: string): void {
    if (this.mutationsUnavailable) {
      throw new DOMException("Storage process is unavailable.", "InvalidStateError");
    }
    if (key === DEVELOPMENT_STORY_STORE_KEY) {
      this.mutationsUnavailable = true;
      throw new DOMException("Simulated process loss.", "InvalidStateError");
    }
    this.delegate.setItem(key, value);
  }

  public override removeItem(key: string): void {
    if (this.mutationsUnavailable) {
      throw new DOMException("Storage process is unavailable.", "InvalidStateError");
    }
    this.delegate.removeItem(key);
  }
}

class FailOnceOnJournalClearStorage extends CapturingStorage {
  private failed = false;

  public constructor(delegate: Storage) {
    super(delegate, () => undefined);
  }

  public override removeItem(key: string): void {
    if (!this.failed && key === DEVELOPMENT_IDEATION_JOURNAL_KEY) {
      this.failed = true;
      throw new DOMException("Injected journal clear failure.", "InvalidStateError");
    }
    this.delegate.removeItem(key);
  }
}
