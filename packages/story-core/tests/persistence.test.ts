import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  ExtractionSuggestion,
  FormalStoryRecord,
  MemoryPolicy,
  MemoryRecord,
  Outline,
  STORY_CORE_SQLITE_MIGRATION_0001,
  STORY_CORE_SQLITE_MIGRATION_0002,
  SqliteChapterVersionReader,
  SqliteDeferredReviewReader,
  SqliteFormalStoryRecordRepository,
  SqliteMemoryPolicyRepository,
  SqliteMemoryRecordCreationUnitOfWork,
  SqliteMemoryRecordRepository,
  SqliteOutlineDraftReader,
  SqliteOutlineRepository,
  SqliteReviewDecisionUnitOfWork,
  SqliteReviewItemRepository,
  SqliteWhatIfPromotionUnitOfWork,
  SqliteWhatIfRepository,
  WhatIfBranch,
  parseIsoUtcTimestamp,
} from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";
import { NodeStorySqliteExecutor } from "./node-sqlite-executor.js";

const T0 = "2026-07-27T00:00:00.000Z";
const T1 = "2026-07-27T00:01:00.000Z";
const T2 = "2026-07-27T00:02:00.000Z";
const executors: NodeStorySqliteExecutor[] = [];

afterEach(() => {
  for (const executor of executors.splice(0)) {
    executor.close();
  }
});

describe("story SQLite migration", () => {
  it("matches the native migration file and creates every governed store", () => {
    const nativeSql = readFileSync(
      new URL("../migrations/0001_story_core.sql", import.meta.url),
      "utf8",
    ).trim();
    expect(nativeSql).toBe(STORY_CORE_SQLITE_MIGRATION_0001);
    const nativeMaterialSql = readFileSync(
      new URL("../migrations/0002_materials.sql", import.meta.url),
      "utf8",
    ).trim();
    expect(normalizeSql(nativeMaterialSql)).toBe(normalizeSql(STORY_CORE_SQLITE_MIGRATION_0002));

    const executor = createExecutor();
    const tables = executor.database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'story_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual([
      "story_formal_records",
      "story_material_references",
      "story_materials",
      "story_memory_policies",
      "story_memory_records",
      "story_outline_drafts",
      "story_outlines",
      "story_review_items",
      "story_timeline_state",
      "story_what_if_branches",
    ]);
  });
});

describe("story SQLite repositories", () => {
  it("persists outlines with compare-and-swap and preserves the winning revision", async () => {
    const executor = createExecutor();
    const repository = new SqliteOutlineRepository(executor);
    const original = makeOutline(1);
    expect((await repository.create(original)).ok).toBe(true);

    const firstChange = unwrap(
      original.addNode({
        id: uuid(4),
        kind: "volume",
        parentId: uuid(3),
        title: "第一卷",
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await repository.save(firstChange, 1)).ok).toBe(true);

    const staleChange = unwrap(
      original.addNode({
        id: uuid(5),
        kind: "volume",
        parentId: uuid(3),
        title: "竞态卷",
        expectedRevision: 1,
        now: T1,
      }),
    );
    const stale = await repository.save(staleChange, 1);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("STORY_REVISION_CONFLICT");
    }

    const restored = unwrap(await repository.findByProjectId(original.projectId));
    expect(restored?.revision).toBe(2);
    expect(restored?.findNode(uuid(4))?.title).toBe("第一卷");
    expect(restored?.findNode(uuid(5))).toBeNull();
  });

  it("tracks formal timeline revisions without mixing other formal record kinds", async () => {
    const executor = createExecutor();
    const repository = new SqliteFormalStoryRecordRepository(executor);
    const timelineEvent = makeFormalRecord(10, "timeline_event");
    const character = makeFormalRecord(20, "character");
    expect((await repository.create(timelineEvent)).ok).toBe(true);
    expect((await repository.create(character)).ok).toBe(true);
    expect(
      unwrap(await repository.listByProjectId(timelineEvent.projectId)).map(({ id }) => id),
    ).toEqual([timelineEvent.id]);
    expect(
      unwrap(await repository.listByProjectId(character.projectId)).map(({ id }) => id),
    ).toEqual([character.id]);

    const initialTimeline = unwrap(await repository.load(timelineEvent.projectId));
    expect(initialTimeline.revision).toBe(2);
    expect(initialTimeline.events.map(({ id }) => id)).toEqual([timelineEvent.id]);

    const changed = unwrap(
      timelineEvent.editManually({
        value: { event: "城门关闭", order: 2 },
        actorId: uuid(99),
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await repository.save(changed, 1)).ok).toBe(true);
    expect(unwrap(await repository.load(timelineEvent.projectId)).revision).toBe(3);
  });

  it("commits a review decision and formal version atomically against the source chapter", async () => {
    const executor = createExecutorWithChapters();
    const records = new SqliteFormalStoryRecordRepository(executor);
    const items = new SqliteReviewItemRepository(executor, "extraction");
    const transaction = new SqliteReviewDecisionUnitOfWork(executor, "extraction");
    const sourceVersions = new SqliteChapterVersionReader(executor);
    const record = makeFormalRecord(30, "character");
    const item = makeExtraction(record, 40);
    seedChapter(
      executor,
      item.toSnapshot().sourceChapterId,
      record.projectId,
      item.toSnapshot().sourceVersionId,
    );
    expect((await records.create(record)).ok).toBe(true);
    expect((await items.create(item)).ok).toBe(true);
    expect(
      unwrap(await sourceVersions.findCurrent(item.toSnapshot().sourceChapterId))?.versionId,
    ).toBe(item.toSnapshot().sourceVersionId);

    const decision = unwrap(
      item.decide({
        kind: "accept",
        decisionId: uuid(48),
        actorId: uuid(49),
        humanConfirmed: true,
        expectedRevision: 1,
        expectedRecordRevision: 1,
        now: T1,
      }),
    );
    if (decision.plan === null) {
      throw new Error("Accepted decision must carry a formal change plan.");
    }
    const changedRecord = unwrap(record.applyChangePlan(decision.plan, 1, T1));
    const committed = await transaction.commit({
      item: decision.item,
      expectedItemRevision: 1,
      formalRecord: changedRecord,
      expectedFormalRecordRevision: 1,
      expectedSourceChapterId: item.toSnapshot().sourceChapterId,
      expectedSourceProjectId: record.projectId,
      expectedSourceVersionId: item.toSnapshot().sourceVersionId,
    });

    expect(committed.ok).toBe(true);
    expect(unwrap(await items.findById(item.id))?.status).toBe("accepted");
    expect(unwrap(await items.listByProjectId(record.projectId)).map(({ id }) => id)).toEqual([
      item.id,
    ]);
    expect(unwrap(await records.findById(record.id))?.revision).toBe(2);
  });

  it("rolls back both sides when the cited chapter version changes at commit time", async () => {
    const executor = createExecutorWithChapters();
    const records = new SqliteFormalStoryRecordRepository(executor);
    const items = new SqliteReviewItemRepository(executor, "extraction");
    const transaction = new SqliteReviewDecisionUnitOfWork(executor, "extraction");
    const record = makeFormalRecord(50, "character");
    const item = makeExtraction(record, 60);
    const itemSnapshot = item.toSnapshot();
    seedChapter(
      executor,
      itemSnapshot.sourceChapterId,
      record.projectId,
      itemSnapshot.sourceVersionId,
    );
    expect((await records.create(record)).ok).toBe(true);
    expect((await items.create(item)).ok).toBe(true);

    const decision = unwrap(
      item.decide({
        kind: "accept",
        decisionId: uuid(68),
        actorId: uuid(69),
        humanConfirmed: true,
        expectedRevision: 1,
        expectedRecordRevision: 1,
        now: T1,
      }),
    );
    if (decision.plan === null) {
      throw new Error("Accepted decision must carry a formal change plan.");
    }
    const changedRecord = unwrap(record.applyChangePlan(decision.plan, 1, T1));
    executor.database
      .prepare("UPDATE chapters SET current_version_id = ? WHERE id = ?")
      .run(uuid(70), itemSnapshot.sourceChapterId);

    const committed = await transaction.commit({
      item: decision.item,
      expectedItemRevision: 1,
      formalRecord: changedRecord,
      expectedFormalRecordRevision: 1,
      expectedSourceChapterId: itemSnapshot.sourceChapterId,
      expectedSourceProjectId: record.projectId,
      expectedSourceVersionId: itemSnapshot.sourceVersionId,
    });

    expect(committed.ok).toBe(false);
    if (!committed.ok) {
      expect(committed.error.code).toBe("REVIEW_SOURCE_CHANGED");
    }
    expect(unwrap(await items.findById(item.id))?.status).toBe("pending");
    expect(unwrap(await records.findById(record.id))?.revision).toBe(1);
  });

  it("lists deferred reviews only when their reminder becomes due", async () => {
    const executor = createExecutor();
    const items = new SqliteReviewItemRepository(executor, "extraction");
    const dueReader = new SqliteDeferredReviewReader(executor);
    const item = makeExtraction(makeFormalRecord(80, "character"), 90);
    const deferred = unwrap(
      item.decide({
        kind: "defer",
        decisionId: uuid(98),
        actorId: uuid(99),
        humanConfirmed: true,
        expectedRevision: 1,
        remindAt: T2,
        now: T1,
      }),
    ).item;
    expect((await items.create(deferred)).ok).toBe(true);

    expect(unwrap(await dueReader.listDue(unwrap(parseIsoUtcTimestamp(T1)), 20))).toHaveLength(0);
    expect(unwrap(await dueReader.listDue(unwrap(parseIsoUtcTimestamp(T2)), 20))).toMatchObject([
      { itemId: item.id, itemType: "extraction", deferredUntil: T2 },
    ]);
  });
});

describe("memory and What-if persistence invariants", () => {
  it("uses policy CAS to prevent automatic memory after learning is disabled", async () => {
    const executor = createExecutor();
    const policies = new SqliteMemoryPolicyRepository(executor);
    const records = new SqliteMemoryRecordRepository(executor);
    const creation = new SqliteMemoryRecordCreationUnitOfWork(executor);
    const defaultPolicy = unwrap(MemoryPolicy.create(uuid(100), T0));
    expect(unwrap(await policies.createIfAbsent(defaultPolicy)).created).toBe(true);
    const enabled = unwrap(
      defaultPolicy.setAutomaticLearning({
        enabled: true,
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await policies.save(enabled, 1)).ok).toBe(true);
    const automatic = unwrap(
      MemoryRecord.create({
        id: uuid(101),
        projectId: defaultPolicy.projectId,
        level: "L4",
        content: "自动推断的写作偏好",
        source: { kind: "session", sourceId: uuid(102), sourceVersionId: null },
        origin: "automatic",
        automaticLearningAuthorization: unwrap(enabled.authorizeAutomaticLearning()),
        now: T1,
      }),
    );

    const disabled = unwrap(
      enabled.setAutomaticLearning({
        enabled: false,
        humanConfirmed: true,
        expectedRevision: 2,
        now: T2,
      }),
    );
    expect((await policies.save(disabled, 2)).ok).toBe(true);
    const blocked = await creation.create({
      record: automatic,
      expectedAutomaticLearningPolicyRevision: 2,
    });

    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe("MEMORY_AUTO_LEARNING_DISABLED");
    }
    expect(unwrap(await records.findById(automatic.id))).toBeNull();
  });

  it("persists user memory governance with revision CAS", async () => {
    const executor = createExecutor();
    const records = new SqliteMemoryRecordRepository(executor);
    const creation = new SqliteMemoryRecordCreationUnitOfWork(executor);
    const record = unwrap(
      MemoryRecord.create({
        id: uuid(110),
        projectId: uuid(111),
        level: "L2",
        content: "主角在第三章失去信任。",
        source: {
          kind: "chapter",
          sourceId: uuid(112),
          sourceVersionId: uuid(113),
        },
        origin: "user",
        now: T0,
      }),
    );
    expect(
      (
        await creation.create({
          record,
          expectedAutomaticLearningPolicyRevision: null,
        })
      ).ok,
    ).toBe(true);
    const excluded = unwrap(
      record.exclude({
        humanConfirmed: true,
        expectedRevision: 1,
        now: T1,
      }),
    );
    expect((await records.save(excluded, 1)).ok).toBe(true);
    expect(unwrap(await records.findById(record.id))?.toSnapshot()).toMatchObject({
      status: "enabled",
      excluded: true,
      pinned: false,
      weight: 0,
      revision: 2,
    });
    expect(unwrap(await records.listByProjectId(record.projectId)).map(({ id }) => id)).toEqual([
      record.id,
    ]);
  });

  it("atomically promotes a What-if branch only into an outline draft", async () => {
    const executor = createExecutor();
    const branches = new SqliteWhatIfRepository(executor);
    const promotions = new SqliteWhatIfPromotionUnitOfWork(executor);
    const drafts = new SqliteOutlineDraftReader(executor);
    const branch = makeSimulatedBranch(120);
    expect((await branches.create(branch)).ok).toBe(true);
    const promoted = unwrap(
      branch.promoteToOutlineDraft({
        draftId: uuid(125),
        title: "城门未开分支",
        synopsis: "仅进入大纲草稿，不修改正式时间线。",
        actorId: uuid(126),
        humanConfirmed: true,
        expectedRevision: 2,
        now: T2,
      }),
    );
    expect(
      (
        await promotions.commit({
          branch: promoted.branch,
          expectedBranchRevision: 2,
          draft: promoted.draft,
        })
      ).ok,
    ).toBe(true);

    expect(unwrap(await branches.findById(branch.id))?.status).toBe("promoted_to_outline_draft");
    expect(unwrap(await branches.listByProjectId(branch.projectId)).map(({ id }) => id)).toEqual([
      branch.id,
    ]);
    expect(
      unwrap(await drafts.listByProjectId(branch.projectId)).map(
        ({ sourceBranchId }) => sourceBranchId,
      ),
    ).toEqual([branch.id]);
    const draftCount = executor.database
      .prepare("SELECT COUNT(*) AS count FROM story_outline_drafts")
      .get() as { count: number };
    expect(draftCount.count).toBe(1);
    const timelineWriteSurface = executor.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM story_formal_records
         WHERE kind = 'timeline_event'`,
      )
      .get() as { count: number };
    expect(timelineWriteSurface.count).toBe(0);
  });

  it("rolls back branch promotion when outline draft insertion fails", async () => {
    const executor = createExecutor();
    const branches = new SqliteWhatIfRepository(executor);
    const promotions = new SqliteWhatIfPromotionUnitOfWork(executor);
    const conflictOwner = makeSimulatedBranch(130);
    const target = makeSimulatedBranch(140);
    expect((await branches.create(conflictOwner)).ok).toBe(true);
    expect((await branches.create(target)).ok).toBe(true);
    executor.database
      .prepare(
        `INSERT INTO story_outline_drafts (
           id, source_branch_id, project_id, created_at, snapshot_json
         ) VALUES (?, ?, ?, ?, '{}')`,
      )
      .run(uuid(145), conflictOwner.id, conflictOwner.projectId, T2);
    const promoted = unwrap(
      target.promoteToOutlineDraft({
        draftId: uuid(145),
        title: "冲突草稿",
        synopsis: "该插入必须失败并回滚分支。",
        actorId: uuid(146),
        humanConfirmed: true,
        expectedRevision: 2,
        now: T2,
      }),
    );

    const result = await promotions.commit({
      branch: promoted.branch,
      expectedBranchRevision: 2,
      draft: promoted.draft,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_REPOSITORY_ERROR");
    }
    expect(unwrap(await branches.findById(target.id))?.status).toBe("simulated");
  });
});

function createExecutor(): NodeStorySqliteExecutor {
  const executor = new NodeStorySqliteExecutor(
    `${STORY_CORE_SQLITE_MIGRATION_0001}\n${STORY_CORE_SQLITE_MIGRATION_0002}`,
  );
  executors.push(executor);
  return executor;
}

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/gu, " ").replaceAll(/\(\s+/gu, "(").replaceAll(/\s+\)/gu, ")").trim();
}

function createExecutorWithChapters(): NodeStorySqliteExecutor {
  const executor = createExecutor();
  executor.database.exec(`
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      current_version_id TEXT NOT NULL
    );
  `);
  return executor;
}

function makeOutline(base: number): Outline {
  return unwrap(
    Outline.create({
      projectId: uuid(base),
      bookId: uuid(base + 2),
      title: "长篇大纲",
      now: T0,
    }),
  );
}

function makeFormalRecord(base: number, kind: "character" | "timeline_event"): FormalStoryRecord {
  return unwrap(
    FormalStoryRecord.create({
      id: uuid(base),
      projectId: uuid(base + 1),
      kind,
      recordKey: `${kind}.${String(base)}`,
      value:
        kind === "timeline_event"
          ? { event: "使者抵达", order: 1 }
          : { name: "林", allegiance: "north" },
      actorId: uuid(base + 2),
      humanConfirmed: true,
      now: T0,
    }),
  );
}

function makeExtraction(record: FormalStoryRecord, base: number): ExtractionSuggestion {
  return unwrap(
    ExtractionSuggestion.create({
      id: uuid(base),
      projectId: record.projectId,
      category: "character.state",
      targetRecordId: record.id,
      targetRecordKind: record.kind,
      sourceChapterId: uuid(base + 1),
      sourceVersionId: uuid(base + 2),
      evidence: {
        excerpt: "林转向南方阵营。",
        start: 10,
        end: 18,
        sourceLength: 100,
      },
      confidence: 0.86,
      originalValue: record.currentValue,
      suggestedValue: { name: "林", allegiance: "south" },
      now: T0,
    }),
  );
}

function seedChapter(
  executor: NodeStorySqliteExecutor,
  chapterId: string,
  projectId: string,
  versionId: string,
): void {
  executor.database
    .prepare(
      `INSERT INTO chapters (id, project_id, current_version_id)
       VALUES (?, ?, ?)`,
    )
    .run(chapterId, projectId, versionId);
}

function makeSimulatedBranch(base: number): WhatIfBranch {
  const branch = unwrap(
    WhatIfBranch.create({
      id: uuid(base),
      projectId: uuid(base + 1),
      sourceEventId: uuid(base + 2),
      baseTimelineRevision: 2,
      hypothesis: "如果城门从未打开？",
      now: T0,
    }),
  );
  return unwrap(
    branch.recordSimulation({
      effects: [
        {
          id: uuid(base + 3),
          effectType: "plot.divergence",
          summary: "主角改走山路。",
          impactedRecordIds: [uuid(base + 4)],
          confidence: 0.75,
        },
      ],
      expectedRevision: 1,
      now: T1,
    }),
  );
}
