import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const legacyStoryMigration = readFileSync(
  new URL("../../story-core/migrations/0001_story_core.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../migrations/0032_unified_story_facts.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";

describe("unified story facts migration", () => {
  it("is idempotent, adds the complete store, and never auto-backfills legacy rows", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${legacyStoryMigration}`);
    await insertProject(executor);
    await executor.execute(
      `INSERT INTO story_formal_records (
         id, project_id, kind, record_key, revision, current_version,
         created_at, updated_at, snapshot_json
       ) VALUES (
         'legacy-formal', ?, 'character', 'character.hero', 1, 1, ?, ?, '{}'
       )`,
      [PROJECT_ID, NOW, NOW],
    );

    expect(() => executor.database.exec(`${migration}\n${migration}`)).not.toThrow();
    const tables = await executor.select<{ readonly name: string }>(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table'
         AND name IN ('story_facts', 'story_fact_revisions', 'story_fact_legacy_links')
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "story_fact_legacy_links",
      "story_fact_revisions",
      "story_facts",
    ]);
    expect(
      await executor.select<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM story_facts",
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await executor.select<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM story_formal_records",
      ),
    ).toEqual([{ count: 1 }]);
    await executor.close();
  });

  it("enforces non-user confirmation, lifecycle, branch, and legacy-backfill guards", async () => {
    const executor = new NodeSqliteExecutor(
      `${coreMigration}\n${legacyStoryMigration}\n${migration}`,
    );
    await insertProject(executor);

    await expect(
      insertFact(executor, {
        id: "ai-formal",
        status: "formal",
        origin: "ai_extraction",
        userConfirmed: 1,
        locked: 0,
        deprecated: 0,
        needsReview: 0,
        actorId: "019f9f4a-b3c7-7350-9226-000000000002",
        confirmedAt: NOW,
      }),
    ).rejects.toThrow(/separate confirmation/iu);

    await expect(
      insertFact(executor, {
        id: "branch-without-id",
        status: "branch",
        origin: "user",
        userConfirmed: 0,
        locked: 0,
        deprecated: 0,
        needsReview: 0,
        actorId: null,
        confirmedAt: null,
      }),
    ).rejects.toThrow();

    await insertFact(executor, {
      id: "legacy-staged",
      status: "unconfirmed",
      origin: "legacy",
      userConfirmed: 0,
      locked: 0,
      deprecated: 0,
      needsReview: 1,
      actorId: null,
      confirmedAt: null,
    });
    await executor.execute(
      `INSERT INTO story_fact_legacy_links (
         fact_id, project_id, legacy_kind, legacy_id, legacy_revision,
         link_mode, created_at
       ) VALUES ('legacy-staged', ?, 'formal_record', 'legacy-1', 1, 'backfill', ?)`,
      [PROJECT_ID, NOW],
    );
    await insertFact(executor, {
      id: "legacy-staged-v2",
      status: "unconfirmed",
      origin: "legacy",
      userConfirmed: 0,
      locked: 0,
      deprecated: 0,
      needsReview: 1,
      actorId: null,
      confirmedAt: null,
    });
    await expect(
      executor.execute(
        `INSERT INTO story_fact_legacy_links (
           fact_id, project_id, legacy_kind, legacy_id, legacy_revision,
           link_mode, created_at
         ) VALUES ('legacy-staged-v2', ?, 'formal_record', 'legacy-1', 2, 'backfill', ?)`,
        [PROJECT_ID, NOW],
      ),
    ).resolves.toMatchObject({ rowsAffected: 1 });

    await insertFact(executor, {
      id: "user-unconfirmed",
      status: "unconfirmed",
      origin: "user",
      userConfirmed: 0,
      locked: 0,
      deprecated: 0,
      needsReview: 1,
      actorId: null,
      confirmedAt: null,
    });
    await expect(
      executor.execute(
        `INSERT INTO story_fact_legacy_links (
           fact_id, project_id, legacy_kind, legacy_id, legacy_revision,
           link_mode, created_at
         ) VALUES ('user-unconfirmed', ?, 'formal_record', 'legacy-2', 1, 'backfill', ?)`,
        [PROJECT_ID, NOW],
      ),
    ).rejects.toThrow(/unconfirmed review item/iu);

    await executor.close();
  });
});

async function insertProject(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at
     ) VALUES (?, '统一事实迁移测试', 'active', 1, 0, ?, ?)`,
    [PROJECT_ID, NOW, NOW],
  );
}

async function insertFact(
  executor: NodeSqliteExecutor,
  input: Readonly<{
    id: string;
    status: "formal" | "unconfirmed" | "branch";
    origin: "user" | "ai_extraction" | "legacy";
    userConfirmed: 0 | 1;
    locked: 0 | 1;
    deprecated: 0 | 1;
    needsReview: 0 | 1;
    actorId: string | null;
    confirmedAt: string | null;
  }>,
): Promise<void> {
  await executor.execute(
    `INSERT INTO story_facts (
       id, project_id, fact_type, content_text, value_json,
       source_kind, evidence_reference, source_chapter_id, source_version_id,
       source_start_offset, source_end_offset, source_length, source_excerpt,
       effective_at, invalidated_at, branch_id, confidence, status, origin,
       user_confirmed, locked, deprecated, needs_review,
       confirmed_by_actor_id, confirmed_at, revision, created_at, updated_at
     ) VALUES (
       ?, ?, 'character.state', '林遥仍然活着。', NULL,
       'legacy_record', 'migration-test:evidence', NULL, NULL,
       NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, 0.5, ?, ?,
       ?, ?, ?, ?, ?, ?, 1, ?, ?
     )`,
    [
      input.id,
      PROJECT_ID,
      input.status,
      input.origin,
      input.userConfirmed,
      input.locked,
      input.deprecated,
      input.needsReview,
      input.actorId,
      input.confirmedAt,
      NOW,
      NOW,
    ],
  );
}
