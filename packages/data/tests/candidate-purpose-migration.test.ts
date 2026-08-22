import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const beforePurposeMigration = [
  "0001_core.sql",
  "0048_candidate_application_intents.sql",
  "0050_candidate_revision_authority.sql",
]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const purposeMigration = readFileSync(
  new URL("../migrations/0072_ai_candidate_purpose.sql", import.meta.url),
  "utf8",
);

describe("AI candidate purpose migration", () => {
  it("backfills prose and blocks every database path that could accept directions", async () => {
    const executor = new NodeSqliteExecutor(beforePurposeMigration);
    try {
      await seedChapter(executor);
      await executor.execute(
        `INSERT INTO ai_candidates (
           id, project_id, chapter_id, source, base_version_id, content,
           content_checksum, status, revision, incomplete, created_at, updated_at,
           decided_at, task_intent, application_mode, payload_kind,
           anchor_start_utf16, anchor_end_utf16
         ) VALUES (?, ?, ?, 'generate', ?, '旧候选', ?, 'ready', 1, 0, ?, ?, NULL,
                   'continuation', 'insert_at_cursor', 'fragment', 4, 4)`,
        [candidateId(1), PROJECT_ID, CHAPTER_ID, VERSION_ID, CHECKSUM, NOW, NOW],
      );

      executor.database.exec(purposeMigration);

      await expect(
        executor.select<{ purpose: string }>("SELECT purpose FROM ai_candidates WHERE id = ?", [
          candidateId(1),
        ]),
      ).resolves.toEqual([{ purpose: "prose" }]);

      await executor.execute(
        `INSERT INTO ai_candidates (
           id, project_id, chapter_id, source, purpose, base_version_id, content,
           content_checksum, status, revision, incomplete, created_at, updated_at,
           decided_at, task_intent, application_mode, payload_kind,
           anchor_start_utf16, anchor_end_utf16
         ) VALUES (?, ?, ?, 'generate', 'continuation_directions', ?, ?, ?, 'ready', 1, 0,
                   ?, ?, NULL, 'continuation', 'insert_at_cursor', 'fragment', 4, 4)`,
        [candidateId(2), PROJECT_ID, CHAPTER_ID, VERSION_ID, DIRECTIONS, CHECKSUM, NOW, NOW],
      );

      await expect(
        executor.execute(
          "UPDATE ai_candidates SET status = 'accepted', decided_at = ? WHERE id = ?",
          [NOW, candidateId(2)],
        ),
      ).rejects.toThrow(/continuation directions cannot be accepted/u);
      await expect(
        executor.execute("UPDATE ai_candidates SET purpose = 'prose' WHERE id = ?", [
          candidateId(2),
        ]),
      ).rejects.toThrow(/purpose is immutable/u);
      await executor.execute(
        "UPDATE ai_candidates SET status = 'rejected', decided_at = ? WHERE id = ?",
        [NOW, candidateId(2)],
      );
      await expect(
        executor.select<{ status: string; purpose: string }>(
          "SELECT status, purpose FROM ai_candidates WHERE id = ?",
          [candidateId(2)],
        ),
      ).resolves.toEqual([{ status: "rejected", purpose: "continuation_directions" }]);
    } finally {
      await executor.close();
    }
  });
});

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-100000000001";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-100000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-100000000003";
const NOW = "2026-08-22T00:00:00.000Z";
const CHECKSUM = "a".repeat(64);
const DIRECTIONS = "方向一：进入钟楼调查\n方向二：收到姐姐警告\n方向三：与对手暂时合作";

function candidateId(index: number): string {
  return `019f9f4a-b3c7-7350-9226-10000000000${String(index + 3)}`;
}

async function seedChapter(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    "INSERT INTO projects (id, name, status, revision, deletion_generation, created_at, updated_at) VALUES (?, '迁移测试', 'active', 1, 0, ?, ?)",
    [PROJECT_ID, NOW, NOW],
  );
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      "INSERT INTO chapters (id, project_id, title, content, status, revision, current_version_id, created_at, updated_at) VALUES (?, ?, '第一章', '正文', 'active', 1, ?, ?, ?)",
      [CHAPTER_ID, PROJECT_ID, VERSION_ID, NOW, NOW],
    );
    await transaction.execute(
      "INSERT INTO chapter_versions (id, project_id, chapter_id, parent_version_id, sequence, content, content_checksum, reason, source_candidate_id, created_at) VALUES (?, ?, ?, NULL, 1, '正文', ?, 'manual', NULL, ?)",
      [VERSION_ID, PROJECT_ID, CHAPTER_ID, CHECKSUM, NOW],
    );
  });
}
