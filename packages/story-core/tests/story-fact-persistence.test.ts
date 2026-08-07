import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  FormalStoryRecord,
  MemoryRecord,
  SqliteFormalStoryRecordRepository,
  SqliteMemoryRecordCreationUnitOfWork,
  SqliteStoryFactStore,
  StoryFact,
  parseUuidV7,
} from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";
import { NodeStorySqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../../data/migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0001_story_core.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../../data/migrations/0032_unified_story_facts.sql", import.meta.url),
    "utf8",
  ),
].join("\n");
const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-01T00:01:00.000Z";
const T2 = "2026-08-01T00:02:00.000Z";
const PROJECT_ID = uuid(1);
const ACTOR_ID = uuid(2);
const executors: NodeStorySqliteExecutor[] = [];

afterEach(() => {
  for (const executor of executors.splice(0)) {
    executor.close();
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
});

function createExecutor(): NodeStorySqliteExecutor {
  const executor = new NodeStorySqliteExecutor(migration);
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
