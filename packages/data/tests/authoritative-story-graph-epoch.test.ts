import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const storyMigration = readFileSync(
  new URL("../../story-core/migrations/0001_story_core.sql", import.meta.url),
  "utf8",
);
const epochMigration = readFileSync(
  new URL("../migrations/0023_authoritative_story_graph_epoch.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const CREATED_AT = "2026-07-28T00:00:00.000Z";

interface EpochRow {
  readonly authority_epoch: number;
}

describe("authoritative Story graph epoch migration", () => {
  it("advances only for projection-relevant Story review transitions", async () => {
    const executor = new NodeSqliteExecutor(
      [coreMigration, storyMigration, epochMigration].join("\n"),
    );
    await insertProject(executor);

    await executor.execute(
      `INSERT INTO story_review_items (
         id, project_id, item_type, status, revision, target_record_id,
         source_chapter_id, source_version_id, deferred_until,
         created_at, updated_at, snapshot_json
       ) VALUES (?, ?, 'extraction', 'pending', 1, ?, ?, ?, NULL, ?, ?, '{}')`,
      [
        "019f9f4a-b3c7-7350-9226-000000000004",
        PROJECT_ID,
        "019f9f4a-b3c7-7350-9226-000000000005",
        CHAPTER_ID,
        VERSION_ID,
        CREATED_AT,
        CREATED_AT,
      ],
    );
    expect(await readEpoch(executor)).toBeNull();

    await executor.execute(
      `UPDATE story_review_items
       SET status = 'accepted', revision = 2, snapshot_json = '{}'
       WHERE project_id = ?`,
      [PROJECT_ID],
    );
    expect(await readEpoch(executor)).toBe(1);

    await executor.execute(
      `UPDATE story_review_items
       SET status = 'rejected', revision = 3, snapshot_json = '{}'
       WHERE project_id = ?`,
      [PROJECT_ID],
    );
    expect(await readEpoch(executor)).toBe(2);

    await executor.execute(
      `UPDATE story_review_items
       SET revision = 4, snapshot_json = '{}'
       WHERE project_id = ?`,
      [PROJECT_ID],
    );
    expect(await readEpoch(executor)).toBe(2);

    await executor.close();
  });

  it("tracks formal, chapter, and current-version changes and survives project cascade", async () => {
    const executor = new NodeSqliteExecutor(
      [coreMigration, storyMigration, epochMigration].join("\n"),
    );
    await insertProject(executor);

    await executor.execute(
      `INSERT INTO story_formal_records (
         id, project_id, kind, record_key, revision, current_version,
         created_at, updated_at, snapshot_json
       ) VALUES (?, ?, 'character', 'hero', 1, 1, ?, ?, '{}')`,
      ["019f9f4a-b3c7-7350-9226-000000000006", PROJECT_ID, CREATED_AT, CREATED_AT],
    );
    expect(await readEpoch(executor)).toBe(1);
    await executor.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation,
         created_at, updated_at
       ) VALUES (?, 'Other project', 'active', 1, 0, ?, ?)`,
      ["019f9f4a-b3c7-7350-9226-000000000099", CREATED_AT, CREATED_AT],
    );
    await expect(
      executor.execute("UPDATE story_formal_records SET project_id = ? WHERE project_id = ?", [
        "019f9f4a-b3c7-7350-9226-000000000099",
        PROJECT_ID,
      ]),
    ).rejects.toThrow(/project_id is immutable/u);
    expect(await readEpoch(executor)).toBe(1);

    await executor.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision,
           current_version_id, created_at, updated_at
         ) VALUES (?, ?, 'One', 'draft', 'active', 1, ?, ?, ?)`,
        [CHAPTER_ID, PROJECT_ID, VERSION_ID, CREATED_AT, CREATED_AT],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence,
           content, content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, 'draft', ?, 'created', NULL, ?)`,
        [VERSION_ID, PROJECT_ID, CHAPTER_ID, "0".repeat(64), CREATED_AT],
      );
    });
    expect(await readEpoch(executor)).toBe(3);

    await executor.execute("UPDATE chapters SET content = 'edited', revision = 2 WHERE id = ?", [
      CHAPTER_ID,
    ]);
    expect(await readEpoch(executor)).toBe(4);

    await executor.execute("DELETE FROM projects WHERE id = ?", [PROJECT_ID]);
    expect(await readEpoch(executor)).toBeNull();
    expect(
      await executor.select<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM chapters WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).toEqual([{ count: 0 }]);

    await executor.close();
  });

  it("is idempotent and fails closed before the epoch exceeds JavaScript precision", async () => {
    const executor = new NodeSqliteExecutor(
      [coreMigration, storyMigration, epochMigration].join("\n"),
    );
    executor.database.exec(epochMigration);
    await insertProject(executor);
    await executor.execute(
      `INSERT INTO authoritative_story_graph_state (project_id, authority_epoch)
       VALUES (?, 9007199254740991)`,
      [PROJECT_ID],
    );

    await expect(
      executor.execute(
        `INSERT INTO story_formal_records (
           id, project_id, kind, record_key, revision, current_version,
           created_at, updated_at, snapshot_json
         ) VALUES (?, ?, 'character', 'hero', 1, 1, ?, ?, '{}')`,
        ["019f9f4a-b3c7-7350-9226-000000000007", PROJECT_ID, CREATED_AT, CREATED_AT],
      ),
    ).rejects.toThrow();
    expect(await readEpoch(executor)).toBe(9_007_199_254_740_991);
    expect(
      await executor.select<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM story_formal_records WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).toEqual([{ count: 0 }]);

    await executor.close();
  });
});

async function insertProject(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation,
       created_at, updated_at
     ) VALUES (?, 'Epoch test', 'active', 1, 0, ?, ?)`,
    [PROJECT_ID, CREATED_AT, CREATED_AT],
  );
}

async function readEpoch(executor: NodeSqliteExecutor): Promise<number | null> {
  const rows = await executor.select<EpochRow>(
    `SELECT authority_epoch
     FROM authoritative_story_graph_state
     WHERE project_id = ?`,
    [PROJECT_ID],
  );
  return rows[0]?.authority_epoch ?? null;
}
