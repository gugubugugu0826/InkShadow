import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const feedbackMigration = readFileSync(
  new URL("../migrations/0035_writing_feedback_learning.sql", import.meta.url),
  "utf8",
);
const policyContextMigration = readFileSync(
  new URL("../migrations/0053_writing_feedback_learning_policy_context.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const HASH = "a".repeat(64);

describe("writing feedback event-time learning migration", () => {
  it("fails historical events closed and supports unique custom feedback clusters", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${feedbackMigration}`);
    await executor.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, '反馈边界', 'active', 1, 0, ?, ?)`,
      [PROJECT_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO writing_feedback_events (
         id, project_id, action, custom_feedback, created_at
       ) VALUES (?, ?, 'explicit_feedback', '暂停期间的意见', ?)`,
      ["019f9f4a-b3c7-7350-9226-000000000002", PROJECT_ID, NOW],
    );

    executor.database.exec(policyContextMigration);

    expect(
      await executor.select<{
        readonly learningEnabledAtEvent: number;
        readonly customFeedbackNormalizedHash: string | null;
      }>(
        `SELECT learning_enabled_at_event AS learningEnabledAtEvent,
                custom_feedback_normalized_hash AS customFeedbackNormalizedHash
         FROM writing_feedback_events WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).toEqual([{ learningEnabledAtEvent: 0, customFeedbackNormalizedHash: null }]);

    await executor.execute(
      `INSERT INTO writing_preferences (
         id, project_id, preference_text, source, source_feedback_code,
         source_feedback_hash, evidence_count, enabled, revision, created_at, updated_at
       ) VALUES (?, ?, '减少总结式结尾', 'manual', NULL, ?, 2, 1, 1, ?, ?)`,
      ["019f9f4a-b3c7-7350-9226-000000000003", PROJECT_ID, HASH, NOW, NOW],
    );
    await expect(
      executor.execute(
        `INSERT INTO writing_preferences (
           id, project_id, preference_text, source, source_feedback_code,
           source_feedback_hash, evidence_count, enabled, revision, created_at, updated_at
         ) VALUES (?, ?, '重复簇', 'manual', NULL, ?, 2, 1, 1, ?, ?)`,
        ["019f9f4a-b3c7-7350-9226-000000000004", PROJECT_ID, HASH, NOW, NOW],
      ),
    ).rejects.toThrow(/unique/iu);
    await executor.close();
  });
});
