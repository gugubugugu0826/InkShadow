import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  FormalStoryRecord,
  MemoryRecord,
  LegacyMemoryStoryFactPromotionService,
  SqliteFormalStoryRecordRepository,
  SqliteMemoryRecordCreationUnitOfWork,
  SqliteMemoryRecordRepository,
  SqliteStoryFactStore,
  StoryFactApplicationService,
  StoryFact,
  MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES,
  parseUuidV7,
  type StorySqlExecutor,
  type StorySqlPrimitive,
  type StorySqlTransaction,
} from "../src/index.js";
import { ManualClock, SequenceUuidV7Generator, unwrap, uuid } from "./helpers.js";
import { NodeStorySqliteExecutor } from "./node-sqlite-executor.js";

const baseMigration = [
  readFileSync(new URL("../../data/migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0001_story_core.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../../data/migrations/0032_unified_story_facts.sql", import.meta.url),
    "utf8",
  ),
].join("\n");
const aliasResolutionMigration = readFileSync(
  new URL("../../data/migrations/0043_story_fact_entity_alias_resolution.sql", import.meta.url),
  "utf8",
);
const continuousRouteReceiptMigration = readFileSync(
  new URL("../../data/migrations/0052_continuous_story_state_route_receipts.sql", import.meta.url),
  "utf8",
);
const historicalContinuousRouteReceiptMigration = readFileSync(
  new URL(
    "../../data/migrations/0055_continuous_story_state_historical_route_receipts.sql",
    import.meta.url,
  ),
  "utf8",
);
const migration = [
  baseMigration,
  aliasResolutionMigration,
  continuousRouteReceiptMigration,
  historicalContinuousRouteReceiptMigration,
].join("\n");
const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-01T00:01:00.000Z";
const T2 = "2026-08-01T00:02:00.000Z";
const PROJECT_ID = uuid(1);
const ACTOR_ID = uuid(2);
const executors: NodeStorySqliteExecutor[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const executor of executors.splice(0)) {
    executor.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("unified story fact SQLite store", () => {
  it("persists evidence, confirms by CAS, and captures immutable revision history", async () => {
    const executor = createExecutor();
    const store = new SqliteStoryFactStore(executor);
    const original = unwrap(
      StoryFact.create({
        id: uuid(10),
        projectId: PROJECT_ID,
        factType: "character.identity",
        contentText: "林遥是失踪的王女。",
        structuredValue: { character: "林遥", identity: "失踪王女" },
        source: {
          kind: "review_decision",
          reference: `story-review:${uuid(11)}`,
        },
        effectiveAt: "第一卷开始",
        confidence: 0.88,
        status: "unconfirmed",
        origin: "ai_extraction",
        needsReview: true,
        humanConfirmed: false,
        now: T0,
      }),
    );

    expect((await store.create(original)).ok).toBe(true);
    expect(unwrap(await store.listByProjectId(unwrap(parseUuidV7(PROJECT_ID))))).toHaveLength(1);

    const confirmed = unwrap(
      original.confirm({
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        lock: true,
        now: T1,
      }),
    );
    expect((await store.save(confirmed, 1)).ok).toBe(true);

    const stale = await store.save(confirmed, 1);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("STORY_REVISION_CONFLICT");
    }

    const restored = unwrap(await store.findById(confirmed.id));
    expect(restored?.toSnapshot()).toMatchObject({
      status: "formal",
      userConfirmed: true,
      locked: true,
      needsReview: false,
      origin: "ai_extraction",
      revision: 2,
    });
    const revisions = unwrap(await store.listRevisions(confirmed.id));
    expect(revisions.map(({ changeKind }) => changeKind)).toEqual(["created", "confirmed"]);
    expect(revisions[0]?.fact.toSnapshot().source).toEqual(revisions[1]?.fact.toSnapshot().source);

    const deprecated = unwrap(
      confirmed.deprecate({
        humanConfirmed: true,
        expectedRevision: 2,
        now: T2,
      }),
    );
    expect((await store.save(deprecated, 2)).ok).toBe(true);
    expect(
      unwrap(await store.listRevisions(confirmed.id)).map(({ changeKind }) => changeKind),
    ).toEqual(["created", "confirmed", "deprecated"]);

    expect(() =>
      executor.database
        .prepare("UPDATE story_fact_revisions SET change_kind = 'deprecated' WHERE fact_id = ?")
        .run(confirmed.id),
    ).toThrow(/immutable/iu);
  });

  it("checks a chapter citation against the exact immutable source version", async () => {
    const executor = createExecutor();
    const store = new SqliteStoryFactStore(executor);
    const chapterId = uuid(20);
    const versionId = uuid(21);
    const content = "0123成为盟友89";
    seedChapter(executor, chapterId, versionId, content);

    const mismatched = unwrap(
      StoryFact.create({
        id: uuid(22),
        projectId: PROJECT_ID,
        factType: "relationship",
        contentText: "林遥和苏晚成为敌人。",
        source: {
          kind: "chapter_span",
          reference: `chapter-version:${versionId}#4:8`,
          chapterId,
          versionId,
          startOffset: 4,
          endOffset: 8,
          sourceLength: content.length,
          excerpt: "成为敌人",
        },
        confidence: 0.7,
        status: "unconfirmed",
        origin: "ai_extraction",
        needsReview: true,
        humanConfirmed: false,
        now: T0,
      }),
    );
    const rejected = await store.create(mismatched);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.code).toBe("REVIEW_SOURCE_CHANGED");
    }
    expect(executor.database.prepare("SELECT COUNT(*) AS count FROM story_facts").get()).toEqual({
      count: 0,
    });

    const exact = unwrap(
      StoryFact.create({
        ...mismatched.toSnapshot(),
        id: uuid(23),
        structuredValue: mismatched.toSnapshot().structuredValue,
        source: {
          kind: "chapter_span",
          reference: `chapter-version:${versionId}#4:8`,
          chapterId,
          versionId,
          startOffset: 4,
          endOffset: 8,
          sourceLength: content.length,
          excerpt: "成为盟友",
        },
        status: "unconfirmed",
        needsReview: true,
        humanConfirmed: false,
        now: T0,
      }),
    );
    expect((await store.create(exact)).ok).toBe(true);
  });

  it("persists a narrowly governed entity-alias resolution before separate confirmation", async () => {
    const executor = createExecutor();
    const store = new SqliteStoryFactStore(executor);
    const original = unwrap(
      StoryFact.create({
        id: uuid(24),
        projectId: PROJECT_ID,
        factType: "character_state",
        contentText: "林舟回到旧宅。",
        structuredValue: {
          subject: {
            entityKey: "character.linzhou.distinct",
            displayName: "林舟",
            mergeStatus: "ambiguous_confirmed_alias",
            matchedEntityKeys: ["character.linzhou.older", "character.linzhou.younger"],
          },
          attributeKey: "location",
          valueText: "旧宅",
        },
        source: {
          kind: "review_decision",
          reference: `story-review:${uuid(25)}`,
        },
        confidence: 0.82,
        status: "unconfirmed",
        origin: "ai_extraction",
        needsReview: true,
        humanConfirmed: false,
        now: T0,
      }),
    );
    expect((await store.create(original)).ok).toBe(true);

    const resolved = unwrap(
      original.resolveEntityAlias({
        resolution: {
          kind: "existing_entity",
          targetEntityKey: "character.linzhou.younger",
        },
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await store.save(resolved, 1)).ok).toBe(true);

    const reloadedStore = new SqliteStoryFactStore(executor);
    const reloaded = unwrap(await reloadedStore.findById(original.id));
    expect(reloaded?.toSnapshot()).toMatchObject({
      revision: 2,
      status: "unconfirmed",
      needsReview: true,
      structuredValue: {
        subject: {
          entityKey: "character.linzhou.younger",
          displayName: "林舟",
          mergeStatus: "human_resolved_existing_entity",
          matchedEntityKeys: ["character.linzhou.younger"],
        },
      },
    });
    const revisions = unwrap(await store.listRevisions(original.id));
    expect(revisions.map(({ changeKind }) => changeKind)).toEqual([
      "created",
      "governance_updated",
    ]);
    expect(revisions[0]?.fact.toSnapshot().structuredValue).toMatchObject({
      subject: { mergeStatus: "ambiguous_confirmed_alias" },
    });
    expect(revisions[1]?.fact.toSnapshot().structuredValue).toMatchObject({
      subject: { mergeStatus: "human_resolved_existing_entity" },
    });

    const confirmed = unwrap(
      reloaded?.confirm({
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 2,
        now: T2,
      }) ??
        (() => {
          throw new Error("resolved fact was not reloaded");
        })(),
    );
    expect((await reloadedStore.save(confirmed, 2)).ok).toBe(true);
    expect(unwrap(await reloadedStore.findById(original.id))?.toSnapshot()).toMatchObject({
      revision: 3,
      status: "formal",
      structuredValue: {
        subject: { mergeStatus: "human_resolved_existing_entity" },
      },
    });
  });

  it("persists a separate-entity decision and rejects out-of-band JSON rewrites", async () => {
    const executor = createExecutor();
    const store = new SqliteStoryFactStore(executor);
    const original = unwrap(
      StoryFact.create({
        id: uuid(26),
        projectId: PROJECT_ID,
        factType: "character_state",
        contentText: "另一个林舟留在港口。",
        structuredValue: {
          subject: {
            entityKey: "character.linzhou.distinct",
            displayName: "林舟",
            mergeStatus: "ambiguous_confirmed_alias",
            matchedEntityKeys: ["character.linzhou.older", "character.linzhou.younger"],
          },
          attributeKey: "location",
          valueText: "港口",
        },
        source: {
          kind: "review_decision",
          reference: `story-review:${uuid(27)}`,
        },
        confidence: 0.8,
        status: "unconfirmed",
        origin: "ai_extraction",
        needsReview: true,
        humanConfirmed: false,
        now: T0,
      }),
    );
    expect((await store.create(original)).ok).toBe(true);

    const invalidPayload = {
      subject: {
        entityKey: "character.not-in-allowed-matches",
        displayName: "林舟",
        mergeStatus: "human_resolved_existing_entity",
        matchedEntityKeys: ["character.not-in-allowed-matches"],
      },
      attributeKey: "location",
      valueText: "港口",
    };
    expect(() =>
      executor.database
        .prepare(
          `UPDATE story_facts
           SET value_json = ?, revision = 2, updated_at = ?
           WHERE id = ? AND revision = 1`,
        )
        .run(JSON.stringify(invalidPayload), T1, original.id),
    ).toThrow(/entity alias resolution is invalid/iu);
    expect(unwrap(await store.findById(original.id))?.revision).toBe(1);

    const resolved = unwrap(
      original.resolveEntityAlias({
        resolution: { kind: "separate_entity" },
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await store.save(resolved, 1)).ok).toBe(true);
    expect(
      unwrap(await new SqliteStoryFactStore(executor).findById(original.id))?.toSnapshot(),
    ).toMatchObject({
      revision: 2,
      structuredValue: {
        subject: {
          entityKey: "character.linzhou.distinct",
          mergeStatus: "human_resolved_separate_entity",
          matchedEntityKeys: ["character.linzhou.older", "character.linzhou.younger"],
        },
      },
    });

    const competing = unwrap(
      original.resolveEntityAlias({
        resolution: {
          kind: "existing_entity",
          targetEntityKey: "character.linzhou.older",
        },
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    const stale = await store.save(competing, 1);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("STORY_REVISION_CONFLICT");
    }
  });

  it("upgrades an existing ambiguous fact before persisting its author decision", async () => {
    const executor = createExecutor(baseMigration);
    const store = new SqliteStoryFactStore(executor);
    const original = unwrap(
      StoryFact.create({
        id: uuid(28),
        projectId: PROJECT_ID,
        factType: "character_state",
        contentText: "林舟仍在塔顶。",
        structuredValue: {
          subject: {
            entityKey: "character.linzhou.distinct",
            mergeStatus: "ambiguous_confirmed_alias",
            matchedEntityKeys: ["character.linzhou.a", "character.linzhou.b"],
          },
          attributeKey: "location",
          valueText: "塔顶",
        },
        source: {
          kind: "review_decision",
          reference: `story-review:${uuid(29)}`,
        },
        confidence: 0.8,
        status: "unconfirmed",
        origin: "ai_extraction",
        needsReview: true,
        humanConfirmed: false,
        now: T0,
      }),
    );
    expect((await store.create(original)).ok).toBe(true);

    executor.database.exec(aliasResolutionMigration);
    const resolved = unwrap(
      original.resolveEntityAlias({
        resolution: { kind: "existing_entity", targetEntityKey: "character.linzhou.a" },
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await store.save(resolved, 1)).ok).toBe(true);
    expect(
      unwrap(await new SqliteStoryFactStore(executor).findById(original.id))?.toSnapshot(),
    ).toMatchObject({
      revision: 2,
      structuredValue: {
        subject: {
          entityKey: "character.linzhou.a",
          mergeStatus: "human_resolved_existing_entity",
        },
      },
    });
  });

  it("stages legacy formal and memory rows without promoting or mutating them", async () => {
    const executor = createExecutor();
    const facts = new SqliteStoryFactStore(executor);
    const formalRecords = new SqliteFormalStoryRecordRepository(executor);
    const memories = new SqliteMemoryRecordCreationUnitOfWork(executor);
    const formal = unwrap(
      FormalStoryRecord.create({
        id: uuid(30),
        projectId: PROJECT_ID,
        kind: "world_rule",
        recordKey: "world.magic_cost",
        value: { rule: "每次施法都会遗忘一个名字" },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        now: T0,
      }),
    );
    const memory = unwrap(
      MemoryRecord.create({
        id: uuid(31),
        projectId: PROJECT_ID,
        level: "L2",
        content: "林遥只在雨夜称苏晚为队长。",
        source: {
          kind: "session",
          sourceId: uuid(32),
          sourceVersionId: null,
        },
        origin: "user",
        now: T0,
      }),
    );
    expect((await formalRecords.create(formal)).ok).toBe(true);
    expect(
      (await memories.create({ record: memory, expectedAutomaticLearningPolicyRevision: null })).ok,
    ).toBe(true);
    const formalBefore = executor.database
      .prepare("SELECT snapshot_json FROM story_formal_records WHERE id = ?")
      .get(formal.id);
    const memoryBefore = executor.database
      .prepare("SELECT snapshot_json FROM story_memory_records WHERE id = ?")
      .get(memory.id);

    const stagedFormal = unwrap(
      await facts.stageLegacyRecord({
        factId: uuid(33),
        projectId: PROJECT_ID,
        legacyKind: "formal_record",
        legacyId: formal.id,
        now: T1,
      }),
    );
    const stagedMemory = unwrap(
      await facts.stageLegacyRecord({
        factId: uuid(34),
        projectId: PROJECT_ID,
        legacyKind: "memory_record",
        legacyId: memory.id,
        now: T1,
      }),
    );

    for (const receipt of [stagedFormal, stagedMemory]) {
      expect(receipt.created).toBe(true);
      expect(receipt.fact.toSnapshot()).toMatchObject({
        status: "unconfirmed",
        origin: "legacy",
        userConfirmed: false,
        locked: false,
        deprecated: false,
        needsReview: true,
      });
      expect(receipt.link.linkMode).toBe("backfill");
    }
    expect(stagedFormal.fact.toSnapshot()).toMatchObject({
      factType: "world_rule",
      confidence: 0.5,
    });
    expect(stagedMemory.fact.toSnapshot()).toMatchObject({ factType: "memory" });

    const replay = unwrap(
      await facts.stageLegacyRecord({
        factId: uuid(35),
        projectId: PROJECT_ID,
        legacyKind: "formal_record",
        legacyId: formal.id,
        now: T2,
      }),
    );
    expect(replay.created).toBe(false);
    expect(replay.fact.id).toBe(stagedFormal.fact.id);
    expect(
      executor.database
        .prepare("SELECT snapshot_json FROM story_formal_records WHERE id = ?")
        .get(formal.id),
    ).toEqual(formalBefore);
    expect(
      executor.database
        .prepare("SELECT snapshot_json FROM story_memory_records WHERE id = ?")
        .get(memory.id),
    ).toEqual(memoryBefore);

    const links = unwrap(await facts.listLegacyLinks(unwrap(parseUuidV7(PROJECT_ID))));
    expect(links).toHaveLength(2);
    const confirmed = unwrap(
      stagedFormal.fact.confirm({
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        now: T2,
      }),
    );
    expect((await facts.save(confirmed, 1)).ok).toBe(true);
    expect(unwrap(await facts.listLegacyLinks(confirmed.projectId))).toHaveLength(2);
  });

  it("keys legacy backfill idempotency by the exact legacy revision", async () => {
    const executor = createExecutor();
    const facts = new SqliteStoryFactStore(executor);
    const formalRecords = new SqliteFormalStoryRecordRepository(executor);
    const formal = unwrap(
      FormalStoryRecord.create({
        id: uuid(40),
        projectId: PROJECT_ID,
        kind: "character",
        recordKey: "character.hero",
        value: { name: "林遥", status: "失踪" },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        now: T0,
      }),
    );
    expect((await formalRecords.create(formal)).ok).toBe(true);

    const first = unwrap(
      await facts.stageLegacyRecord({
        factId: uuid(41),
        projectId: PROJECT_ID,
        legacyKind: "formal_record",
        legacyId: formal.id,
        now: T1,
      }),
    );
    const changed = unwrap(
      formal.editManually({
        value: { name: "林遥", status: "归队" },
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        now: T2,
      }),
    );
    expect((await formalRecords.save(changed, 1)).ok).toBe(true);
    const second = unwrap(
      await facts.stageLegacyRecord({
        factId: uuid(42),
        projectId: PROJECT_ID,
        legacyKind: "formal_record",
        legacyId: formal.id,
        now: T2,
      }),
    );

    expect(first.link.legacyRevision).toBe(1);
    expect(second.created).toBe(true);
    expect(second.link.legacyRevision).toBe(2);
    expect(second.fact.id).not.toBe(first.fact.id);
    expect(unwrap(await facts.listLegacyLinks(first.fact.projectId))).toHaveLength(2);
  });

  it("explicitly promotes a legacy memory, survives service restart, and exposes duplicate and conflict states", async () => {
    const executor = createExecutor();
    const facts = new SqliteStoryFactStore(executor);
    const memoryCreation = new SqliteMemoryRecordCreationUnitOfWork(executor);
    const memoryRecords = new SqliteMemoryRecordRepository(executor);
    const clock = new ManualClock(T1);
    const ids = new SequenceUuidV7Generator(4_000);
    const factService = new StoryFactApplicationService({ facts, clock, ids });
    const memory = unwrap(
      MemoryRecord.create({
        id: uuid(3_900),
        projectId: PROJECT_ID,
        level: "L4",
        content: "所有预言都必须付出可见代价。",
        source: { kind: "user_rule", sourceId: ACTOR_ID, sourceVersionId: null },
        origin: "user",
        now: T0,
      }),
    );
    expect(
      (
        await memoryCreation.create({
          record: memory,
          expectedAutomaticLearningPolicyRevision: null,
        })
      ).ok,
    ).toBe(true);
    const createPromotion = () =>
      new LegacyMemoryStoryFactPromotionService({
        facts,
        factService,
        memories: memoryRecords,
        ids,
        clock,
      });
    const promotion = createPromotion();
    expect(
      unwrap(await promotion.preview({ projectId: PROJECT_ID, memoryId: memory.id })),
    ).toMatchObject({ status: "available", canConfirm: true, linkedLegacyRevision: null });
    const denied = await promotion.confirm({
      projectId: PROJECT_ID,
      memoryId: memory.id,
      expectedMemoryRevision: 1,
      actorId: ACTOR_ID,
      humanConfirmed: false,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("HUMAN_DECISION_REQUIRED");

    const converted = unwrap(
      await promotion.confirm({
        projectId: PROJECT_ID,
        memoryId: memory.id,
        expectedMemoryRevision: 1,
        actorId: ACTOR_ID,
        humanConfirmed: true,
      }),
    );
    expect(converted).toMatchObject({
      status: "converted",
      memoryRevision: 1,
      fact: { revision: 2 },
      link: { legacyKind: "memory_record", legacyRevision: 1, linkMode: "backfill" },
    });
    if (converted.fact === null) throw new Error("Converted legacy memory lost its StoryFact.");
    expect(converted.fact?.toSnapshot()).toMatchObject({
      factType: "memory",
      contentText: "所有预言都必须付出可见代价。",
      source: {
        kind: "legacy_record",
        reference: `legacy:story_memory_records:${memory.id}:r1`,
      },
      status: "formal",
      origin: "legacy",
      userConfirmed: true,
      locked: true,
      needsReview: false,
      revision: 2,
    });
    expect(unwrap(await memoryRecords.findById(memory.id))?.toSnapshot()).toEqual(
      memory.toSnapshot(),
    );
    expect(unwrap(await facts.listRevisions(converted.fact.id))).toHaveLength(2);

    const restartedPromotion = createPromotion();
    expect(
      unwrap(await restartedPromotion.preview({ projectId: PROJECT_ID, memoryId: memory.id })),
    ).toMatchObject({ status: "converted", canConfirm: false, linkedLegacyRevision: 1 });
    expect(
      unwrap(
        await restartedPromotion.confirm({
          projectId: PROJECT_ID,
          memoryId: memory.id,
          expectedMemoryRevision: 1,
          actorId: ACTOR_ID,
          humanConfirmed: true,
        }),
      ).status,
    ).toBe("duplicate");
    expect(unwrap(await facts.listByProjectId(memory.projectId))).toHaveLength(1);

    clock.set(T2);
    const edited = unwrap(
      memory.edit({
        content: "所有预言都必须由施术者付出可见代价。",
        humanConfirmed: true,
        expectedRevision: 1,
        now: T2,
      }),
    );
    expect((await memoryRecords.save(edited, 1)).ok).toBe(true);
    expect(
      unwrap(await restartedPromotion.preview({ projectId: PROJECT_ID, memoryId: memory.id })),
    ).toMatchObject({
      status: "conflict",
      canConfirm: true,
      requiresConflictConfirmation: true,
      linkedLegacyRevision: 1,
    });
    const blockedConflict = unwrap(
      await restartedPromotion.confirm({
        projectId: PROJECT_ID,
        memoryId: memory.id,
        expectedMemoryRevision: 2,
        actorId: ACTOR_ID,
        humanConfirmed: true,
      }),
    );
    expect(blockedConflict.status).toBe("conflict");
    expect(unwrap(await facts.listByProjectId(memory.projectId))).toHaveLength(1);

    const acceptedConflict = unwrap(
      await restartedPromotion.confirm({
        projectId: PROJECT_ID,
        memoryId: memory.id,
        expectedMemoryRevision: 2,
        actorId: ACTOR_ID,
        humanConfirmed: true,
        acceptConflict: true,
      }),
    );
    expect(acceptedConflict).toMatchObject({
      status: "converted",
      link: { legacyRevision: 2 },
    });
    expect(acceptedConflict.fact?.toSnapshot()).toMatchObject({
      contentText: "所有预言都必须由施术者付出可见代价。",
      status: "formal",
      revision: 2,
    });
    expect(unwrap(await facts.listByProjectId(memory.projectId))).toHaveLength(2);
    expect(unwrap(await facts.listLegacyLinks(memory.projectId))).toHaveLength(2);
    expect(unwrap(await memoryRecords.findById(memory.id))?.toSnapshot()).toEqual(
      edited.toSnapshot(),
    );
  });

  it("atomically fences the current chapter version, relation endpoints, and duplicate submissions", async () => {
    const executor = createExecutor();
    const store = new SqliteStoryFactStore(executor);
    const chapterId = uuid(90);
    const versionId = uuid(91);
    const content = "门被打开。随后门被锁上。";
    seedChapter(executor, chapterId, versionId, content);
    const event = causalFact(uuid(92), chapterId, versionId, content, "门被打开。", {
      schemaVersion: "inkshadow.causal-event-fact.v2",
      eventText: "门被打开",
      resultText: "通道开放",
      narrativeTime: { order: 10, label: "先前" },
      location: { locationId: "door", label: "门口" },
      participantCharacterIds: [],
      informedCharacterIds: [],
      knowledgeGains: [],
      prerequisites: [],
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      foreshadowProgress: [],
    });
    const created = unwrap(
      await store.createWithAuthorityFence(event, {
        chapterId,
        expectedCurrentVersionId: versionId,
      }),
    );
    expect(created.created).toBe(true);

    const retry = causalFact(
      uuid(93),
      chapterId,
      versionId,
      content,
      "门被打开。",
      event.toSnapshot().structuredValue,
    );
    const recovered = unwrap(
      await store.createWithAuthorityFence(retry, {
        chapterId,
        expectedCurrentVersionId: versionId,
      }),
    );
    expect(recovered.created).toBe(false);
    expect(recovered.fact.id).toBe(event.id);

    const unrelatedChapterId = uuid(100);
    const unrelatedVersionId = uuid(101);
    seedChapter(executor, unrelatedChapterId, unrelatedVersionId, content);
    const unrelatedFence = await store.createWithAuthorityFence(
      causalFact(uuid(102), chapterId, versionId, content, "随后门被锁上。", {
        ...(event.toSnapshot().structuredValue as Readonly<Record<string, unknown>>),
        eventText: "门被锁上",
        narrativeTime: { order: 20, label: "随后" },
      }),
      {
        chapterId: unrelatedChapterId,
        expectedCurrentVersionId: unrelatedVersionId,
      },
    );
    expect(unrelatedFence.ok).toBe(false);
    if (!unrelatedFence.ok) {
      expect(unrelatedFence.error.code).toBe("STORY_FACT_SOURCE_FENCE_FAILED");
    }

    const disguisedEvent = await store.createWithAuthorityFence(
      causalFact(
        uuid(108),
        chapterId,
        versionId,
        content,
        "随后门被锁上。",
        event.toSnapshot().structuredValue,
        "world_property",
      ),
      { chapterId, expectedCurrentVersionId: versionId },
    );
    expect(disguisedEvent.ok).toBe(false);
    if (!disguisedEvent.ok) {
      expect(disguisedEvent.error.code).toBe("STORY_VALIDATION_FAILED");
    }

    const secondEvent = causalFact(uuid(103), chapterId, versionId, content, "随后门被锁上。", {
      ...(event.toSnapshot().structuredValue as Readonly<Record<string, unknown>>),
      eventText: "门被锁上",
      narrativeTime: { order: 20, label: "随后" },
    });
    expect(
      unwrap(
        await store.createWithAuthorityFence(secondEvent, {
          chapterId,
          expectedCurrentVersionId: versionId,
        }),
      ).created,
    ).toBe(true);

    const mismatchedRelationFence = await store.createWithAuthorityFence(
      causalFact(
        uuid(104),
        chapterId,
        versionId,
        content,
        content,
        {
          schemaVersion: "inkshadow.causal-relation-fact.v1",
          fromEventId: event.id,
          toEventId: uuid(105),
          kind: "causes",
        },
        "causal_relation",
      ),
      {
        chapterId,
        expectedCurrentVersionId: versionId,
        requiredCausalEventIds: [event.id, secondEvent.id],
      },
    );
    expect(mismatchedRelationFence.ok).toBe(false);
    if (!mismatchedRelationFence.ok) {
      expect(mismatchedRelationFence.error.code).toBe("STORY_FACT_RELATION_ENDPOINT_INVALID");
    }

    const relation = causalFact(
      uuid(94),
      chapterId,
      versionId,
      content,
      content,
      {
        schemaVersion: "inkshadow.causal-relation-fact.v1",
        fromEventId: event.id,
        toEventId: uuid(95),
        kind: "causes",
      },
      "causal_relation",
    );
    const missingEndpoint = await store.createWithAuthorityFence(relation, {
      chapterId,
      expectedCurrentVersionId: versionId,
      requiredCausalEventIds: [event.id, uuid(95)],
    });
    expect(missingEndpoint.ok).toBe(false);
    if (!missingEndpoint.ok) {
      expect(missingEndpoint.error.code).toBe("STORY_FACT_RELATION_ENDPOINT_INVALID");
    }

    const missingCharacter = await store.createWithAuthorityFence(
      causalFact(
        uuid(98),
        chapterId,
        versionId,
        content,
        "门被打开。",
        event.toSnapshot().structuredValue,
      ),
      {
        chapterId,
        expectedCurrentVersionId: versionId,
        requiredCharacterIds: ["character-not-confirmed"],
      },
    );
    expect(missingCharacter.ok).toBe(false);
    if (!missingCharacter.ok) {
      expect(missingCharacter.error.code).toBe("STORY_FACT_CHARACTER_AUTHORITY_INVALID");
    }

    const character = unwrap(
      StoryFact.create({
        id: uuid(106),
        projectId: PROJECT_ID,
        factType: "character_identity",
        contentText: "林夏是已确认人物。",
        structuredValue: {
          subject: {
            kind: "character",
            entityKey: "character-linxia",
            canonicalName: "林夏",
          },
        },
        source: { kind: "user_statement", reference: "character:linxia" },
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        humanConfirmed: true,
        confirmationActorId: ACTOR_ID,
        now: T0,
      }),
    );
    expect((await store.create(character)).ok).toBe(true);
    const characterEvent = causalFact(uuid(107), chapterId, versionId, content, "随后门被锁上。", {
      ...(event.toSnapshot().structuredValue as Readonly<Record<string, unknown>>),
      eventText: "林夏锁上门",
      narrativeTime: { order: 30, label: "稍后" },
      participantCharacterIds: ["character-linxia"],
    });
    const omittedCharacterFence = await store.createWithAuthorityFence(characterEvent, {
      chapterId,
      expectedCurrentVersionId: versionId,
    });
    expect(omittedCharacterFence.ok).toBe(false);
    if (!omittedCharacterFence.ok) {
      expect(omittedCharacterFence.error.code).toBe("STORY_FACT_CHARACTER_AUTHORITY_INVALID");
    }
    expect(
      unwrap(
        await store.createWithAuthorityFence(characterEvent, {
          chapterId,
          expectedCurrentVersionId: versionId,
          requiredCharacterIds: ["character-linxia"],
        }),
      ).created,
    ).toBe(true);

    const duplicateCharacter = unwrap(
      StoryFact.create({
        id: uuid(108),
        projectId: PROJECT_ID,
        factType: "character_identity",
        contentText: "林夏是重复的已确认人物记录。",
        structuredValue: {
          subject: {
            kind: "character",
            entityKey: "character-linxia",
            canonicalName: "林夏",
          },
        },
        source: { kind: "user_statement", reference: "character:linxia:duplicate" },
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        humanConfirmed: true,
        confirmationActorId: ACTOR_ID,
        now: T0,
      }),
    );
    expect((await store.create(duplicateCharacter)).ok).toBe(true);
    const duplicatedCharacterAuthority = await store.createWithAuthorityFence(
      causalFact(uuid(109), chapterId, versionId, content, "随后门被锁上。", {
        ...(event.toSnapshot().structuredValue as Readonly<Record<string, unknown>>),
        eventText: "林夏再次检查门锁",
        narrativeTime: { order: 40, label: "再后来" },
        participantCharacterIds: ["character-linxia"],
      }),
      {
        chapterId,
        expectedCurrentVersionId: versionId,
        requiredCharacterIds: ["character-linxia"],
      },
    );
    expect(duplicatedCharacterAuthority.ok).toBe(false);
    if (!duplicatedCharacterAuthority.ok) {
      expect(duplicatedCharacterAuthority.error.code).toBe(
        "STORY_FACT_CHARACTER_AUTHORITY_INVALID",
      );
    }

    executor.database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, 2, ?, ?, 'manual', NULL, ?)`,
      )
      .run(uuid(96), PROJECT_ID, chapterId, versionId, "新版本正文。", "b".repeat(64), T1);
    executor.database
      .prepare("UPDATE chapters SET current_version_id = ? WHERE id = ?")
      .run(uuid(96), chapterId);
    const stale = await store.createWithAuthorityFence(
      causalFact(uuid(97), chapterId, versionId, content, "随后门被锁上。", {
        ...(event.toSnapshot().structuredValue as Readonly<Record<string, unknown>>),
        eventText: "门被锁上",
        narrativeTime: { order: 20, label: "随后" },
      }),
      { chapterId, expectedCurrentVersionId: versionId },
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STORY_FACT_SOURCE_FENCE_FAILED");
  });

  it("atomically undoes supplemental dispositions, recovers retries, and fails closed on stale authority", async () => {
    const executor = createExecutor();
    const store = new SqliteStoryFactStore(executor);
    const chapterId = uuid(110);
    const versionId = uuid(111);
    const content = "林夏推开了门。";
    seedChapter(executor, chapterId, versionId, content);
    const signature = `v2:${versionId}:${"a".repeat(64)}:0-7`;
    const resolution = supplementalResolutionFact(uuid(112), chapterId, versionId, signature);
    expect(
      unwrap(
        await store.createWithAuthorityFence(resolution, {
          chapterId,
          expectedCurrentVersionId: versionId,
        }),
      ).created,
    ).toBe(true);
    const undoFence = {
      expectedProjectId: PROJECT_ID,
      chapterId,
      expectedCurrentVersionId: versionId,
      findingId: "voice:sqlite-test",
      evidenceSignature: signature,
      expectedRevision: 1,
      now: T1,
    } as const;

    const undone = unwrap(
      await store.deprecateSupplementalResolutionWithAuthorityFence(resolution.id, undoFence),
    );
    expect(undone).toMatchObject({ deprecated: true, fact: { revision: 2 } });
    const retry = unwrap(
      await store.deprecateSupplementalResolutionWithAuthorityFence(resolution.id, undoFence),
    );
    expect(retry).toMatchObject({ deprecated: false, fact: { revision: 2 } });
    expect(unwrap(await store.listRevisions(resolution.id))).toHaveLength(2);

    const active = supplementalResolutionFact(uuid(113), chapterId, versionId, signature);
    unwrap(
      await store.createWithAuthorityFence(active, {
        chapterId,
        expectedCurrentVersionId: versionId,
      }),
    );
    const mismatched = await store.deprecateSupplementalResolutionWithAuthorityFence(active.id, {
      ...undoFence,
      findingId: "voice:forged",
      now: T2,
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.code).toBe("STORY_VALIDATION_FAILED");

    const crossProject = await store.deprecateSupplementalResolutionWithAuthorityFence(active.id, {
      ...undoFence,
      expectedProjectId: uuid(999),
      now: T2,
    });
    expect(crossProject.ok).toBe(false);
    if (!crossProject.ok) expect(crossProject.error.code).toBe("STORY_VALIDATION_FAILED");
    expect(unwrap(await store.findById(active.id))?.toSnapshot()).toMatchObject({
      status: "formal",
      deprecated: false,
      revision: 1,
    });
    expect(unwrap(await store.listRevisions(active.id))).toHaveLength(1);

    const nextVersionId = uuid(114);
    executor.database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, 2, ?, ?, 'manual', NULL, ?)`,
      )
      .run(nextVersionId, PROJECT_ID, chapterId, versionId, "新版本正文。", "b".repeat(64), T2);
    executor.database
      .prepare("UPDATE chapters SET current_version_id = ? WHERE id = ?")
      .run(nextVersionId, chapterId);
    const switched = await store.deprecateSupplementalResolutionWithAuthorityFence(
      active.id,
      undoFence,
    );
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.error.code).toBe("STORY_FACT_SOURCE_FENCE_FAILED");
    expect(unwrap(await store.findById(active.id))?.toSnapshot()).toMatchObject({
      status: "formal",
      deprecated: false,
      revision: 1,
    });

    const currentVersionResolution = supplementalResolutionFact(
      uuid(115),
      chapterId,
      nextVersionId,
      signature,
    );
    expect(
      unwrap(
        await store.createWithAuthorityFence(currentVersionResolution, {
          chapterId,
          expectedCurrentVersionId: nextVersionId,
        }),
      ).created,
    ).toBe(true);
    expect(currentVersionResolution.id).not.toBe(active.id);
    const currentUndo = unwrap(
      await store.deprecateSupplementalResolutionWithAuthorityFence(currentVersionResolution.id, {
        ...undoFence,
        expectedCurrentVersionId: nextVersionId,
        now: T2,
      }),
    );
    expect(currentUndo).toMatchObject({ deprecated: true, fact: { revision: 2 } });
    expect(unwrap(await store.findById(active.id))?.toSnapshot()).toMatchObject({
      status: "formal",
      deprecated: false,
      revision: 1,
    });
  });

  it("holds the BEGIN IMMEDIATE writer lock from authority checks through fact insertion", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "inkshadow-story-fence-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "authority.sqlite");
    const primary = createExecutor(migration, databasePath);
    const competing = new NodeStorySqliteExecutor("", databasePath);
    executors.push(competing);
    competing.database.exec("PRAGMA busy_timeout = 0");
    const chapterId = uuid(4500);
    const versionId = uuid(4501);
    const competingVersionId = uuid(4502);
    const content = "门在雨中被打开。";
    seedChapter(primary, chapterId, versionId, content);
    primary.database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, 2, ?, ?, 'manual', NULL, ?)`,
      )
      .run(
        competingVersionId,
        PROJECT_ID,
        chapterId,
        versionId,
        "门已经关闭。",
        "c".repeat(64),
        T1,
      );
    let competingWriteAttempted = false;
    const interleaving = new InterleavingStoryExecutor(primary, () => {
      competingWriteAttempted = true;
      expect(() =>
        competing.database
          .prepare("UPDATE chapters SET current_version_id = ? WHERE id = ?")
          .run(competingVersionId, chapterId),
      ).toThrow(/busy|locked/iu);
    });
    const store = new SqliteStoryFactStore(interleaving);
    const fact = causalFact(uuid(4503), chapterId, versionId, content, content, {
      schemaVersion: "inkshadow.causal-event-fact.v2",
      eventText: "门被打开",
      resultText: "通道开放",
      narrativeTime: { order: 10, label: "雨夜" },
      location: { locationId: "door", label: "门口" },
      participantCharacterIds: [],
      informedCharacterIds: [],
      knowledgeGains: [],
      prerequisites: [],
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      foreshadowProgress: [],
    });
    expect(
      unwrap(
        await store.createWithAuthorityFence(fact, {
          chapterId,
          expectedCurrentVersionId: versionId,
        }),
      ).created,
    ).toBe(true);
    expect(competingWriteAttempted).toBe(true);

    expect(
      competing.database
        .prepare("UPDATE chapters SET current_version_id = ? WHERE id = ?")
        .run(competingVersionId, chapterId).changes,
    ).toBe(1);
    expect(unwrap(await store.findById(fact.id))?.id).toBe(fact.id);
  }, 30_000);

  it("accepts the full UI character-selection boundary and rejects an oversized authority union", async () => {
    const executor = createExecutor();
    const store = new SqliteStoryFactStore(executor);
    const chapterId = uuid(4000);
    const versionId = uuid(4001);
    const content = "众人在议事厅确认了各自得知的消息。";
    seedChapter(executor, chapterId, versionId, content);
    const participantIds = Array.from({ length: 128 }, (_, index) => `character-p-${index}`);
    const informedIds = Array.from({ length: 128 }, (_, index) => `character-i-${index}`);
    for (const [index, characterId] of [...participantIds, ...informedIds].entries()) {
      const character = unwrap(
        StoryFact.create({
          id: uuid(4100 + index),
          projectId: PROJECT_ID,
          factType: "character_identity",
          contentText: `${characterId} is confirmed.`,
          structuredValue: {
            subject: {
              kind: "character",
              entityKey: characterId,
              canonicalName: characterId,
            },
          },
          source: { kind: "user_statement", reference: `character:${characterId}` },
          confidence: 1,
          status: "formal",
          origin: "user",
          needsReview: false,
          humanConfirmed: true,
          confirmationActorId: ACTOR_ID,
          now: T0,
        }),
      );
      expect((await store.create(character)).ok).toBe(true);
    }
    const baseStructured = {
      schemaVersion: "inkshadow.causal-event-fact.v2",
      eventText: "众人确认消息",
      resultText: "知情边界被记录",
      narrativeTime: { order: 10, label: "议事时" },
      location: { locationId: "council-room", label: "议事厅" },
      participantCharacterIds: participantIds,
      informedCharacterIds: informedIds,
      knowledgeGains: [],
      prerequisites: [],
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      foreshadowProgress: [],
    };
    const exactCharacterIds = [...participantIds, ...informedIds];
    expect(
      unwrap(
        await store.createWithAuthorityFence(
          causalFact(uuid(4400), chapterId, versionId, content, content, baseStructured),
          {
            chapterId,
            expectedCurrentVersionId: versionId,
            requiredCharacterIds: exactCharacterIds,
          },
        ),
      ).created,
    ).toBe(true);

    const oversizedReferences = Array.from(
      { length: MAXIMUM_STORY_FACT_AUTHORITY_REFERENCES + 1 },
      (_, index) => `oversized-${index}`,
    );
    const oversized = await store.createWithAuthorityFence(
      causalFact(uuid(4401), chapterId, versionId, content, content, {
        ...baseStructured,
        eventText: "过多人物被引用",
      }),
      {
        chapterId,
        expectedCurrentVersionId: versionId,
        requiredCharacterIds: oversizedReferences,
      },
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error.code).toBe("STORY_FACT_CHARACTER_AUTHORITY_INVALID");
    }
  });

  it("atomically retires current projections, inserts facts and persists a restart-safe route receipt", async () => {
    const executor = createExecutor();
    const store = new SqliteStoryFactStore(executor);
    const chapterId = uuid(5000);
    const versionId = uuid(5001);
    const content = "ABCD";
    const sourceContentHash = "a".repeat(64);
    const replacementKey =
      "continuous-story-state:character-linyao:relationship_change:other:character-a:relationship:friend";
    const otherReplacementKey =
      "continuous-story-state:character-linyao:relationship_change:other:character-b:relationship:friend";
    seedChapter(executor, chapterId, versionId, content);
    const projection = (id: string, key = replacementKey) =>
      unwrap(
        StoryFact.create({
          id,
          projectId: PROJECT_ID,
          factType: "relationship_change",
          contentText: "林遥的关系发生变化。",
          structuredValue: {
            schemaVersion: "inkshadow.continuous-story-state.v2",
            replacementKey: key,
          },
          source: {
            kind: "chapter_span",
            reference: `continuous-story-state:character_extraction:${versionId}:sha256:${sourceContentHash}`,
            chapterId,
            versionId,
            startOffset: 0,
            endOffset: content.length,
            sourceLength: content.length,
            excerpt: content,
          },
          confidence: 0.9,
          status: "temporary",
          origin: "system",
          needsReview: false,
          humanConfirmed: false,
          now: T0,
        }),
      );
    const oldProjection = projection(uuid(5002));
    const unrelatedProjection = projection(uuid(5005), otherReplacementKey);
    expect((await store.create(oldProjection)).ok).toBe(true);
    expect((await store.create(unrelatedProjection)).ok).toBe(true);
    const route = {
      projectId: PROJECT_ID,
      chapterId,
      versionId,
      task: "character_extraction" as const,
      sourceContentHash,
      providerKind: "ollama",
      modelId: "test-model",
      invocationId: "invocation-5000",
      candidateCount: 1,
      completedAt: T1,
    };

    const failed = await store.commitContinuousStoryStateRoute({
      ...route,
      facts: [{ fact: projection(oldProjection.id), replacementKey }],
    });
    expect(failed.ok).toBe(false);
    expect(unwrap(await store.findById(oldProjection.id))?.toSnapshot()).toMatchObject({
      status: "temporary",
      revision: 1,
    });
    expect(
      unwrap(
        await store.findContinuousStoryStateRouteReceipt({
          projectId: PROJECT_ID,
          chapterId,
          versionId,
          task: "character_extraction",
        }),
      ),
    ).toBeNull();

    const currentProjection = projection(uuid(5003));
    const committed = unwrap(
      await store.commitContinuousStoryStateRoute({
        ...route,
        facts: [{ fact: currentProjection, replacementKey }],
      }),
    );
    expect(committed).toMatchObject({
      alreadyCommitted: false,
      receipt: { createdFactCount: 1, retiredFactCount: 1 },
      retiredFactIds: [oldProjection.id],
    });
    expect(unwrap(await store.findById(oldProjection.id))?.toSnapshot()).toMatchObject({
      status: "deprecated",
      revision: 2,
    });
    expect(unwrap(await store.findById(unrelatedProjection.id))?.toSnapshot()).toMatchObject({
      status: "temporary",
      revision: 1,
    });
    expect(
      unwrap(await store.listRevisions(oldProjection.id)).map(({ changeKind }) => changeKind),
    ).toEqual(["created", "deprecated"]);

    const reloaded = new SqliteStoryFactStore(executor);
    const replay = unwrap(
      await reloaded.commitContinuousStoryStateRoute({
        ...route,
        facts: [{ fact: projection(uuid(5004)), replacementKey }],
      }),
    );
    expect(replay.alreadyCommitted).toBe(true);
    expect(replay.facts).toEqual([]);
    expect(unwrap(await reloaded.listByProjectId(unwrap(parseUuidV7(PROJECT_ID))))).toHaveLength(3);

    const nextVersionId = uuid(5006);
    executor.database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, 2, 'EFGH', ?, 'manual', NULL, ?)`,
      )
      .run(nextVersionId, PROJECT_ID, chapterId, versionId, "b".repeat(64), T2);
    executor.database
      .prepare(
        `UPDATE chapters
         SET content = 'EFGH', current_version_id = ?, revision = 2, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextVersionId, T2, chapterId);
    const staleCommit = await reloaded.commitContinuousStoryStateRoute({
      ...route,
      task: "world_extraction",
      invocationId: "invocation-stale-world",
      candidateCount: 0,
      facts: [],
    });
    expect(staleCommit.ok).toBe(false);
    if (!staleCommit.ok) {
      expect(staleCommit.error.code).toBe("CONTINUOUS_STORY_STATE_ROUTE_SOURCE_CHANGED");
    }
  });
});

function createExecutor(migrationSql = migration, databasePath?: string): NodeStorySqliteExecutor {
  const executor = new NodeStorySqliteExecutor(migrationSql, databasePath);
  executor.database
    .prepare(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, '统一故事状态测试', 'active', 1, 0, ?, ?)`,
    )
    .run(PROJECT_ID, T0, T0);
  executors.push(executor);
  return executor;
}

class InterleavingStoryExecutor implements StorySqlExecutor {
  public constructor(
    private readonly delegate: NodeStorySqliteExecutor,
    private readonly onChapterFenceRead: () => void,
  ) {}

  public select<Row extends object>(
    query: string,
    bindValues?: readonly StorySqlPrimitive[],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, bindValues);
  }

  public execute(
    query: string,
    bindValues?: readonly StorySqlPrimitive[],
  ): ReturnType<StorySqlExecutor["execute"]> {
    return this.delegate.execute(query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: StorySqlTransaction) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction((transaction) => {
      let injected = false;
      return operation({
        select: async <Row extends object>(
          query: string,
          bindValues?: readonly StorySqlPrimitive[],
        ): Promise<Row[]> => {
          const rows = await transaction.select<Row>(query, bindValues);
          if (!injected && /FROM\s+chapters/iu.test(query)) {
            injected = true;
            this.onChapterFenceRead();
          }
          return rows;
        },
        execute: (query, bindValues) => transaction.execute(query, bindValues),
      });
    });
  }
}

function seedChapter(
  executor: NodeStorySqliteExecutor,
  chapterId: string,
  versionId: string,
  content: string,
): void {
  executor.database.exec("BEGIN IMMEDIATE");
  try {
    executor.database
      .prepare(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision,
           current_version_id, created_at, updated_at
         ) VALUES (?, ?, '第一章', ?, 'active', 1, ?, ?, ?)`,
      )
      .run(chapterId, PROJECT_ID, content, versionId, T0, T0);
    executor.database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      )
      .run(versionId, PROJECT_ID, chapterId, content, "a".repeat(64), T0);
    executor.database.exec("COMMIT");
  } catch (error: unknown) {
    executor.database.exec("ROLLBACK");
    throw error;
  }
}

function causalFact(
  id: string,
  chapterId: string,
  versionId: string,
  content: string,
  excerpt: string,
  structuredValue: unknown,
  factType = "causal_event",
): StoryFact {
  const startOffset = content.indexOf(excerpt);
  return unwrap(
    StoryFact.create({
      id,
      projectId: PROJECT_ID,
      factType,
      contentText: "causal fact",
      structuredValue,
      source: {
        kind: "chapter_span",
        reference: `chapter:${chapterId}:version:${versionId}:utf16:${String(startOffset)}-${String(startOffset + excerpt.length)}`,
        chapterId,
        versionId,
        startOffset,
        endOffset: startOffset + excerpt.length,
        sourceLength: content.length,
        excerpt,
      },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: T0,
    }),
  );
}

function supplementalResolutionFact(
  id: string,
  chapterId: string,
  versionId: string,
  evidenceSignature: string,
): StoryFact {
  return unwrap(
    StoryFact.create({
      id,
      projectId: PROJECT_ID,
      factType: "validation_resolution",
      contentText: "用户忽略检查提醒",
      structuredValue: {
        resolutionSchema: "inkshadow.chapter-supplemental-finding-resolution.v1",
        resolutionAction: "ignore",
        resolvedFindingId: "voice:sqlite-test",
        resolvedFindingCategory: "character_voice",
        resolvedChapterId: chapterId,
        resolvedChapterVersionId: versionId,
        evidenceSignature,
      },
      source: {
        kind: "review_decision",
        reference: `chapter-supplemental-finding:${chapterId}:${versionId}:voice:sqlite-test`,
      },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: ACTOR_ID,
      now: T0,
    }),
  );
}
