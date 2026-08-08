import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migrations = [
  "0001_core.sql",
  "0035_writing_feedback_learning.sql",
  "0053_writing_feedback_learning_policy_context.sql",
  "0054_writing_feedback_explicit_idempotency.sql",
]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const NOW = "2026-08-09T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const IDEMPOTENCY_KEY = "b".repeat(64);

describe("writing feedback explicit idempotency migration", () => {
  it("allows one explicit feedback event for each project-scoped stable identity", async () => {
    const executor = new NodeSqliteExecutor(migrations);
    await executor.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at
       ) VALUES (?, 'Feedback idempotency', 'active', 1, 0, ?, ?)`,
      [PROJECT_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO writing_feedback_events (
         id, project_id, action, feedback_code, learning_enabled_at_event,
         idempotency_key, created_at
       ) VALUES (?, ?, 'explicit_feedback', 'more_dialogue', 1, ?, ?)`,
      ["019f9f4a-b3c7-7350-9226-000000000002", PROJECT_ID, IDEMPOTENCY_KEY, NOW],
    );

    await expect(
      executor.execute(
        `INSERT INTO writing_feedback_events (
           id, project_id, action, feedback_code, learning_enabled_at_event,
           idempotency_key, created_at
         ) VALUES (?, ?, 'explicit_feedback', 'more_dialogue', 1, ?, ?)`,
        ["019f9f4a-b3c7-7350-9226-000000000003", PROJECT_ID, IDEMPOTENCY_KEY, NOW],
      ),
    ).rejects.toThrow(/unique/iu);
    await executor.close();
  });
});
