import {
  StoryCoreError,
  StoryFactApplicationService,
  err,
  ok,
  parseUuidV7,
  storyFactUpdatePolicy,
  type Result,
  type StoryFact,
  type StoryFactListFilter,
  type StoryFactRevision,
  type StoryFactStore,
  type UuidV7,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const PROJECT_ID = uuid(1);
const ACTOR_ID = uuid(2);
const CHAPTER_ID = uuid(3);
const VERSION_ID = uuid(4);
const NOW = "2026-08-01T00:00:00.000Z";

describe("StoryFactApplicationService", () => {
  it("does not report a newly locked rule saved without an authoritative row", async () => {
    const { service, store } = harness();
    store.create = async () => ok(undefined);
    const result = await service.createFormalUserFact({
      projectId: PROJECT_ID,
      factType: "world_rule",
      contentText: "钟摆不得复活死者。",
      actorId: ACTOR_ID,
      humanConfirmed: true,
      lock: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details.reason).toBe("STORY_FACT_READBACK_MISMATCH");
    expect(unwrap(await store.listByProjectId(parse(PROJECT_ID)))).toEqual([]);
  });
  it("does not report a rule locked when persistence acknowledges but does not save it", async () => {
    const { service, store } = harness();
    const original = unwrap(
      await service.createFormalUserFact({
        projectId: PROJECT_ID,
        factType: "world_rule",
        contentText: "钟摆不能逆转生命。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        lock: false,
      }),
    );
    store.save = async () => ok(undefined);
    const changed = await service.setLocked({
      factId: original.id,
      locked: true,
      humanConfirmed: true,
      expectedRevision: original.revision,
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.details.reason).toBe("STORY_FACT_READBACK_MISMATCH");
    expect(unwrap(await store.findById(original.id))?.toSnapshot()).toEqual(original.toSnapshot());
  });
  it("classifies update authority conservatively", () => {
    expect(storyFactUpdatePolicy("chapter_summary")).toBe("rebuildable_automatic");
    expect(storyFactUpdatePolicy("character_state")).toBe("automatic_reversible");
    expect(storyFactUpdatePolicy("character_death")).toBe("human_confirmation_required");
    expect(storyFactUpdatePolicy("future_extension_type")).toBe("human_confirmation_required");
  });

  it("creates a user-confirmed formal fact and can lock it", async () => {
    const { service, store } = harness();
    const created = await service.createFormalUserFact({
      projectId: PROJECT_ID,
      factType: "world_rule",
      contentText: "魔法不能复活死者。",
      actorId: ACTOR_ID,
      humanConfirmed: true,
      lock: true,
    });

    expect(unwrap(created).toSnapshot()).toMatchObject({
      status: "formal",
      origin: "user",
      userConfirmed: true,
      locked: true,
      needsReview: false,
    });
    expect(unwrap(await store.listByProjectId(parse(PROJECT_ID)))).toHaveLength(1);
  });

  it("stages an author statement as a review draft and preserves its source through confirmation", async () => {
    const { service, store } = harness();
    const draft = unwrap(
      await service.stageUserDraftFact({
        projectId: PROJECT_ID,
        factType: "world_rule",
        contentText: "潮门只在月落时开启。",
        actorId: ACTOR_ID,
      }),
    );
    const source = draft.toSnapshot().source;
    expect(draft.toSnapshot()).toMatchObject({
      status: "unconfirmed",
      origin: "user",
      userConfirmed: false,
      needsReview: true,
      locked: false,
      source: {
        kind: "user_statement",
        reference: expect.stringMatching(/^user-statement:draft:/u),
      },
    });
    expect(unwrap(await store.listByProjectId(parse(PROJECT_ID)))).toHaveLength(1);

    const confirmed = unwrap(
      await service.confirm({
        factId: draft.id,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
      }),
    );
    expect(confirmed.toSnapshot()).toMatchObject({
      status: "formal",
      origin: "user",
      userConfirmed: true,
      needsReview: false,
      revision: 2,
      source,
    });
  });

  it("keeps bulk-draft provenance after an author revises and confirms its content", async () => {
    const { service, store } = harness();
    const structuredValue = {
      schemaVersion: "inkshadow.local-bulk-setting-draft.v1",
      batchId: "bulk-batch-1",
      draftId: "local-setting-1-0",
      sourceKind: "local_text",
      sourceText: "雾里的回声令人不安。",
      sourceRange: {
        startOffset: 0,
        endOffset: 11,
        sourceLength: 24,
        unit: "utf16_code_unit",
      },
    };
    const draft = unwrap(
      await service.stageUserDraftFact({
        projectId: PROJECT_ID,
        factType: "world_rule",
        contentText: "雾里的回声令人不安。",
        structuredValue,
        actorId: ACTOR_ID,
      }),
    );
    const source = draft.toSnapshot().source;

    const edited = unwrap(
      await service.editAsUser({
        factId: draft.id,
        contentText: "雾里的回声会引来守潮人。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: draft.revision,
      }),
    );
    expect(edited.toSnapshot()).toMatchObject({
      contentText: "雾里的回声会引来守潮人。",
      structuredValue,
      source,
      status: "formal",
      origin: "user",
      userConfirmed: true,
      needsReview: false,
      revision: 2,
    });
    const reopened = unwrap(await store.findById(parse(draft.id)));
    expect(reopened?.toSnapshot().structuredValue).toEqual(structuredValue);
    expect(
      await service.editAsUser({
        factId: draft.id,
        contentText: "正式结构不能再次按纯文字改写。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: edited.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "STORY_FACT_INVALID_TRANSITION" } });
  });

  it("keeps project-seed provenance after an author revises and confirms a professional draft", async () => {
    const { service, store } = harness();
    const structuredValue = {
      schemaVersion: "inkshadow.professional-setup-fact-draft.v1",
      sourceKind: "project_seed",
      projectSeed: {
        seedId: "professional-seed-1",
        revision: 1,
        journeyKind: "professional",
      },
      field: {
        fieldName: "characters",
        inputKey: "protagonist",
        origin: "professional_setup.protagonist",
      },
      originalInput: "林深、雾语；林深是守潮人",
      sourceSegment: "林深是守潮人",
      derivation: "local_deterministic_split",
    };
    const draft = unwrap(
      await service.stageUserDraftFact({
        projectId: PROJECT_ID,
        factType: "character_identity",
        contentText: "人物身份：林深是守潮人",
        structuredValue,
        actorId: ACTOR_ID,
      }),
    );

    const edited = unwrap(
      await service.editAsUser({
        factId: draft.id,
        contentText: "人物身份：林深是望潮崖守潮人",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: draft.revision,
      }),
    );
    expect(edited.toSnapshot()).toMatchObject({
      contentText: "人物身份：林深是望潮崖守潮人",
      structuredValue,
      status: "formal",
      userConfirmed: true,
      needsReview: false,
      revision: 2,
    });
    const reopened = unwrap(await store.findById(parse(draft.id)));
    expect(reopened?.toSnapshot().structuredValue).toEqual(structuredValue);
  });

  it("rejects plain-text edits for an unknown structured author draft schema", async () => {
    const { service } = harness();
    const draft = unwrap(
      await service.stageUserDraftFact({
        projectId: PROJECT_ID,
        factType: "character_identity",
        contentText: "林深是守潮人。",
        structuredValue: {
          schemaVersion: "inkshadow.semantic-character-profile.v1",
          identity: { name: "林深", role: "守潮人" },
        },
        actorId: ACTOR_ID,
      }),
    );

    expect(
      await service.editAsUser({
        factId: draft.id,
        contentText: "林深是望潮崖守潮人。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: draft.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "STORY_FACT_INVALID_TRANSITION" } });
  });

  it("keeps critical AI extraction unconfirmed until an explicit user decision", async () => {
    const { service } = harness();
    const staged = unwrap(
      await service.stageAutomaticFact({
        projectId: PROJECT_ID,
        factType: "character_death",
        contentText: "林遥在钟楼死亡。",
        source: chapterEvidence("林遥倒在钟楼的地板上，再也没有呼吸。"),
        confidence: 0.93,
        origin: "ai_extraction",
      }),
    );

    expect(staged.updatePolicy).toBe("human_confirmation_required");
    expect(staged.fact.toSnapshot()).toMatchObject({
      status: "unconfirmed",
      userConfirmed: false,
      needsReview: true,
      locked: false,
    });
    const confirmed = unwrap(
      await service.confirm({
        factId: staged.fact.id,
        actorId: ACTOR_ID,
        lock: true,
        humanConfirmed: true,
        expectedRevision: staged.fact.revision,
      }),
    );
    expect(confirmed.toSnapshot()).toMatchObject({
      status: "formal",
      userConfirmed: true,
      needsReview: false,
      locked: true,
      revision: 2,
    });
  });

  it("allows deterministic system state to remain temporary and reversible", async () => {
    const { service } = harness();
    const staged = unwrap(
      await service.stageAutomaticFact({
        projectId: PROJECT_ID,
        factType: "character_state",
        contentText: "林遥左臂受伤。",
        source: chapterEvidence("碎片划过林遥的左臂，血立刻浸透袖口。"),
        confidence: 1,
        origin: "system",
      }),
    );

    expect(staged.updatePolicy).toBe("automatic_reversible");
    expect(staged.fact.toSnapshot()).toMatchObject({
      status: "temporary",
      origin: "system",
      needsReview: false,
      userConfirmed: false,
    });
    const deprecated = unwrap(
      await service.deprecate({
        factId: staged.fact.id,
        humanConfirmed: true,
        expectedRevision: staged.fact.revision,
      }),
    );
    expect(deprecated.toSnapshot()).toMatchObject({ status: "deprecated", revision: 2 });
  });

  it("lets deterministic local extraction require review without pretending to be AI", async () => {
    const { service } = harness();
    const staged = unwrap(
      await service.stageAutomaticFact({
        projectId: PROJECT_ID,
        factType: "character_profile",
        contentText: "周望五十七岁。",
        source: chapterEvidence("周望五十七岁。"),
        confidence: 1,
        origin: "system",
        requireHumanReview: true,
      }),
    );

    expect(staged.updatePolicy).toBe("automatic_reversible");
    expect(staged.fact.toSnapshot()).toMatchObject({
      status: "unconfirmed",
      origin: "system",
      needsReview: true,
      userConfirmed: false,
    });
  });

  it("lets an author revise only a staged structured fact while preserving evidence and revision fences", async () => {
    const { service } = harness();
    const staged = unwrap(
      await service.stageAutomaticFact({
        projectId: PROJECT_ID,
        factType: "character_profile",
        contentText: "周望是钟楼的管理员。",
        structuredValue: {
          schemaVersion: "inkshadow.rebuildable-system-fact.v1",
          payload: { schemaVersion: "inkshadow.direct-local-story-fact.v1" },
        },
        source: directLocalChapterEvidence("周望是钟楼的管理员。"),
        confidence: 1,
        origin: "system",
        requireHumanReview: true,
      }),
    );
    const originalSource = staged.fact.toSnapshot().source;

    const edited = unwrap(
      await service.editStagedAsUser({
        factId: staged.fact.id,
        contentText: "周望担任钟楼管理员。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: staged.fact.revision,
      }),
    );

    expect(edited.toSnapshot()).toMatchObject({
      contentText: "周望担任钟楼管理员。",
      structuredValue: null,
      status: "formal",
      origin: "user",
      userConfirmed: true,
      needsReview: false,
      revision: 2,
      source: originalSource,
    });
    expect(
      await service.editStagedAsUser({
        factId: staged.fact.id,
        contentText: "过期重复修改。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: staged.fact.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "STORY_REVISION_CONFLICT" } });
    expect(
      await service.editStagedAsUser({
        factId: edited.id,
        contentText: "不得再次按待确认草稿修改。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: edited.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "STORY_FACT_INVALID_TRANSITION" } });
  });

  it("rejects staged author edits outside the direct-local v1 review boundary", async () => {
    const { service } = harness();
    const nonLocal = unwrap(
      await service.stageAutomaticFact({
        projectId: PROJECT_ID,
        factType: "character_profile",
        contentText: "周望五十七岁。",
        structuredValue: {
          schemaVersion: "inkshadow.rebuildable-system-fact.v1",
          payload: { schemaVersion: "inkshadow.direct-local-story-fact.v1" },
        },
        source: chapterEvidence("周望五十七岁。"),
        confidence: 1,
        origin: "system",
        requireHumanReview: true,
      }),
    );
    expect(
      await service.editStagedAsUser({
        factId: nonLocal.fact.id,
        contentText: "周望五十八岁。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: nonLocal.fact.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "STORY_FACT_INVALID_TRANSITION" } });

    const direct = unwrap(
      await service.stageAutomaticFact({
        projectId: PROJECT_ID,
        factType: "character_profile",
        contentText: "周望担任钟楼管理员。",
        structuredValue: {
          schemaVersion: "inkshadow.rebuildable-system-fact.v1",
          payload: { schemaVersion: "inkshadow.direct-local-story-fact.v1" },
        },
        source: directLocalChapterEvidence("周望担任钟楼管理员。"),
        confidence: 1,
        origin: "system",
        requireHumanReview: true,
      }),
    );
    const locked = unwrap(
      await service.confirm({
        factId: direct.fact.id,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: direct.fact.revision,
        lock: true,
      }),
    );
    expect(
      await service.editStagedAsUser({
        factId: locked.id,
        contentText: "不得修改已固定设定。",
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: locked.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: "STORY_FACT_INVALID_TRANSITION" } });
  });

  it("fails closed for unknown automatic fact types", async () => {
    const { service } = harness();
    const staged = unwrap(
      await service.stageAutomaticFact({
        projectId: PROJECT_ID,
        factType: "plugin_custom_fact",
        contentText: "扩展推断。",
        source: chapterEvidence("扩展证据文本。"),
        confidence: 0.7,
        origin: "system",
      }),
    );
    expect(staged.updatePolicy).toBe("human_confirmation_required");
    expect(staged.fact.toSnapshot()).toMatchObject({
      status: "unconfirmed",
      needsReview: true,
    });
  });

  it("persists alias resolution through the application service before confirmation", async () => {
    const { service, store } = harness();
    const staged = unwrap(
      await service.stageAutomaticFact({
        projectId: PROJECT_ID,
        factType: "character_identity",
        contentText: "林舟继承了银印。",
        structuredValue: {
          subject: {
            kind: "character",
            entityKey: "character:isolated:1",
            canonicalName: "林舟",
            aliases: [],
            mergeStatus: "ambiguous_confirmed_alias",
            matchedEntityKeys: ["character.linzhou.a", "character.linzhou.b"],
          },
          state: { inherited: "silver-seal" },
        },
        source: chapterEvidence("林舟继承了银印。"),
        confidence: 0.9,
        origin: "ai_extraction",
      }),
    );

    const resolved = unwrap(
      await service.resolveEntityAlias({
        factId: staged.fact.id,
        resolution: { kind: "separate_entity" },
        humanConfirmed: true,
        expectedRevision: staged.fact.revision,
      }),
    );
    expect(resolved.toSnapshot()).toMatchObject({
      revision: 2,
      structuredValue: {
        subject: {
          entityKey: "character:isolated:1",
          mergeStatus: "human_resolved_separate_entity",
        },
      },
    });
    expect(unwrap(await store.findById(parse(staged.fact.id)))?.revision).toBe(2);
  });

  it("replaces and clears only its own rebuildable system projection", async () => {
    const { service, store } = harness();
    const first = unwrap(
      await service.replaceRebuildableSystemFact({
        projectId: PROJECT_ID,
        factType: "chapter_summary",
        replacementKey: `chapter:${CHAPTER_ID}`,
        contentText: "First summary",
        payload: { sourceVersionId: VERSION_ID },
        source: chapterEvidence("First source"),
        confidence: 1,
      }),
    );
    const second = unwrap(
      await service.replaceRebuildableSystemFact({
        projectId: PROJECT_ID,
        factType: "chapter_summary",
        replacementKey: `chapter:${CHAPTER_ID}`,
        contentText: "Second summary",
        payload: { sourceVersionId: uuid(5) },
        source: chapterEvidence("Second source"),
        confidence: 1,
      }),
    );

    expect(second.replacedFactIds).toEqual([first.fact.id]);
    expect(unwrap(await store.findById(parse(first.fact.id)))?.toSnapshot()).toMatchObject({
      status: "deprecated",
      userConfirmed: false,
    });
    expect(second.fact.toSnapshot()).toMatchObject({
      status: "temporary",
      origin: "system",
      userConfirmed: false,
      needsReview: false,
      structuredValue: {
        schemaVersion: "inkshadow.rebuildable-system-fact.v1",
        replacementKey: `chapter:${CHAPTER_ID}`,
      },
    });

    expect(
      unwrap(
        await service.clearRebuildableSystemFacts({
          projectId: PROJECT_ID,
          factType: "chapter_summary",
          replacementKey: `chapter:${CHAPTER_ID}`,
        }),
      ),
    ).toEqual([second.fact.id]);
    expect(unwrap(await store.findById(parse(second.fact.id)))?.toSnapshot().status).toBe(
      "deprecated",
    );
  });

  it("refuses to use the rebuild path for critical or unknown facts", async () => {
    const { service } = harness();
    for (const factType of ["world_rule", "plugin_custom_fact"]) {
      expect(
        await service.replaceRebuildableSystemFact({
          projectId: PROJECT_ID,
          factType,
          replacementKey: "unsafe",
          contentText: "Must remain governed",
          payload: {},
          source: chapterEvidence("Evidence"),
          confidence: 1,
        }),
      ).toMatchObject({ ok: false, error: { code: "STORY_FACT_INVALID_TRANSITION" } });
    }
  });
});

function harness(): { service: StoryFactApplicationService; store: MemoryStoryFactStore } {
  const store = new MemoryStoryFactStore();
  let next = 100;
  return {
    store,
    service: new StoryFactApplicationService({
      facts: store,
      clock: { now: () => NOW },
      ids: { next: () => parse(uuid(next++)) },
    }),
  };
}

function chapterEvidence(excerpt: string) {
  return {
    kind: "chapter_span" as const,
    reference: `chapter:${CHAPTER_ID}:${VERSION_ID}`,
    chapterId: CHAPTER_ID,
    versionId: VERSION_ID,
    startOffset: 0,
    endOffset: excerpt.length,
    sourceLength: excerpt.length + 1,
    excerpt,
  };
}

function directLocalChapterEvidence(excerpt: string) {
  return {
    ...chapterEvidence(excerpt),
    reference: "direct-local:inkshadow.direct-local-story-fact.v1:test",
  };
}

class MemoryStoryFactStore implements StoryFactStore {
  private readonly facts = new Map<UuidV7, StoryFact>();

  public create(fact: StoryFact): Promise<Result<void, StoryCoreError>> {
    if (this.facts.has(fact.id)) {
      return Promise.resolve(err(repositoryError("duplicate")));
    }
    this.facts.set(fact.id, fact);
    return Promise.resolve(ok(undefined));
  }

  public findById(id: UuidV7): Promise<Result<StoryFact | null, StoryCoreError>> {
    return Promise.resolve(ok(this.facts.get(id) ?? null));
  }

  public listByProjectId(
    projectId: UuidV7,
    filter: StoryFactListFilter = {},
  ): Promise<Result<readonly StoryFact[], StoryCoreError>> {
    return Promise.resolve(
      ok(
        [...this.facts.values()].filter((fact) => {
          const snapshot = fact.toSnapshot();
          return (
            snapshot.projectId === projectId &&
            (filter.status === undefined || snapshot.status === filter.status) &&
            (filter.factType === undefined || snapshot.factType === filter.factType) &&
            (filter.branchId === undefined || snapshot.branchId === filter.branchId) &&
            (filter.needsReview === undefined || snapshot.needsReview === filter.needsReview)
          );
        }),
      ),
    );
  }

  public save(fact: StoryFact, expectedRevision: number): Promise<Result<void, StoryCoreError>> {
    const current = this.facts.get(fact.id);
    if (current === undefined || current.revision !== expectedRevision) {
      return Promise.resolve(
        err(
          new StoryCoreError({
            code: "STORY_REVISION_CONFLICT",
            message: "stale",
          }),
        ),
      );
    }
    this.facts.set(fact.id, fact);
    return Promise.resolve(ok(undefined));
  }

  public listRevisions(
    factId: UuidV7,
  ): Promise<Result<readonly StoryFactRevision[], StoryCoreError>> {
    void factId;
    return Promise.resolve(ok([]));
  }
}

function repositoryError(message: string): StoryCoreError {
  return new StoryCoreError({ code: "STORY_REPOSITORY_ERROR", message });
}

function parse(value: string): UuidV7 {
  const result = parseUuidV7(value);
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function unwrap<Value>(result: Result<Value, StoryCoreError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}
