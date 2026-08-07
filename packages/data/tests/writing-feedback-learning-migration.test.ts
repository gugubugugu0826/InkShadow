import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0035_writing_feedback_learning.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const OTHER_PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000004";

describe("writing feedback learning migration", () => {
  it("is idempotent and records content-free actions plus visible preferences", async () => {
    const executor = new NodeSqliteExecutor(coreMigration);
    await insertProject(executor, PROJECT_ID, "反馈测试");
    expect(() => executor.database.exec(`${migration}\n${migration}`)).not.toThrow();

    await executor.execute(
      `INSERT INTO writing_feedback_events (
         id, project_id, action, feedback_code, created_at
       ) VALUES (?, ?, 'explicit_feedback', 'more_dialogue', ?)`,
      ["019f9f4a-b3c7-7350-9226-000000000005", PROJECT_ID, NOW],
    );
    await executor.execute(
      `INSERT INTO writing_preferences (
         id, project_id, preference_text, source, source_feedback_code,
         evidence_count, enabled, revision, created_at, updated_at
       ) VALUES (?, ?, ?, 'feedback_pattern', 'more_dialogue', 2, 1, 1, ?, ?)`,
      [
        "019f9f4a-b3c7-7350-9226-000000000006",
        PROJECT_ID,
        "增加自然对话，让人物关系通过交流推进。",
        NOW,
        NOW,
      ],
    );

    expect(
      await executor.select<{ readonly preferenceText: string; readonly enabled: number }>(
        `SELECT preference_text AS preferenceText, enabled
         FROM writing_preferences WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).toEqual([{ preferenceText: "增加自然对话，让人物关系通过交流推进。", enabled: 1 }]);
    expect(
      await executor.select<{ readonly changeKind: string }>(
        `SELECT change_kind AS changeKind FROM writing_preference_revisions
         WHERE preference_id = ?`,
        ["019f9f4a-b3c7-7350-9226-000000000006"],
      ),
    ).toEqual([{ changeKind: "created" }]);

    const eventColumns = await executor.select<{ readonly name: string }>(
      "PRAGMA table_info(writing_feedback_events)",
    );
    expect(eventColumns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["chapter_content", "candidate_content", "prompt", "response"]),
    );
    await executor.close();
  });

  it("rejects cross-project chapter evidence and mutable events", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
    await insertProject(executor, PROJECT_ID, "项目一");
    await insertProject(executor, OTHER_PROJECT_ID, "项目二");
    await insertChapter(executor, OTHER_PROJECT_ID);

    await expect(
      executor.execute(
        `INSERT INTO writing_feedback_events (
           id, project_id, chapter_id, action, created_at
         ) VALUES (?, ?, ?, 'accepted', ?)`,
        ["019f9f4a-b3c7-7350-9226-000000000007", PROJECT_ID, CHAPTER_ID, NOW],
      ),
    ).rejects.toThrow(/another project/iu);

    await executor.execute(
      `INSERT INTO writing_feedback_events (
         id, project_id, action, created_at
       ) VALUES (?, ?, 'accepted', ?)`,
      ["019f9f4a-b3c7-7350-9226-000000000008", PROJECT_ID, NOW],
    );
    await expect(
      executor.execute("UPDATE writing_feedback_events SET action = 'rejected' WHERE id = ?", [
        "019f9f4a-b3c7-7350-9226-000000000008",
      ]),
    ).rejects.toThrow(/immutable/iu);
    await executor.close();
  });
});

async function insertProject(
  executor: NodeSqliteExecutor,
  projectId: string,
  name: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at
     ) VALUES (?, ?, 'active', 1, 0, ?, ?)`,
    [projectId, name, NOW, NOW],
  );
}

async function insertChapter(executor: NodeSqliteExecutor, projectId: string): Promise<void> {
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision,
         current_version_id, created_at, updated_at
       ) VALUES (?, ?, '第一章', '', 'active', 1, ?, ?, ?)`,
      [CHAPTER_ID, projectId, VERSION_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence,
         content, content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, '', ?, 'created', NULL, ?)`,
      [VERSION_ID, projectId, CHAPTER_ID, "0".repeat(64), NOW],
    );
  });
}
