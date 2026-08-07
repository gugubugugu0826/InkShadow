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
