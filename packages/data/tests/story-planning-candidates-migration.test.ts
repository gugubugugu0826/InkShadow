import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0036_story_planning_candidates.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CANDIDATE_ID = "019f9f4a-b3c7-7350-9226-000000000002";

describe("story planning candidates migration", () => {
  it("is idempotent and keeps generated plans in a review-only table", async () => {
    const executor = new NodeSqliteExecutor(coreMigration);
    await insertProject(executor);
    expect(() => executor.database.exec(`${migration}\n${migration}`)).not.toThrow();

    await executor.execute(
      `INSERT INTO story_planning_candidates (
         id, project_id, task, target_node_id, target_node_title,
         baseline_outline_revision, status, payload_json, editable_synopsis,
         context_json, invocation_id, connection_id, catalog_entry_id,
         provider_kind, model_id, used_fallback, revision, created_at, updated_at
       ) VALUES (?, ?, 'outline_planning', ?, '全书', 1, 'review', ?, ?, ?, ?, ?, ?,
                 'openai', 'gpt-test', 0, 1, ?, ?)`,
      [
        CANDIDATE_ID,
        PROJECT_ID,
        "019f9f4a-b3c7-7350-9226-000000000003",
        JSON.stringify({ schemaVersion: 1, task: "outline_planning" }),
        "待审阅的大纲方向",
        JSON.stringify({ formalFactIds: [], lockedFactIds: [], causalEventIds: [] }),
        "invocation-1",
        "connection-1",
        "catalog-1",
        NOW,
        NOW,
      ],
    );

    const rows = await executor.select<{
      readonly status: string;
      readonly synopsis: string;
      readonly invocationId: string;
    }>(
      `SELECT status, editable_synopsis AS synopsis, invocation_id AS invocationId
       FROM story_planning_candidates WHERE id = ?`,
      [CANDIDATE_ID],
    );
    expect(rows).toEqual([
      {
        status: "review",
        synopsis: "待审阅的大纲方向",
        invocationId: "invocation-1",
      },
    ]);
    await executor.close();
  });

  it("rejects a fake accepted state without a recorded outline revision", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
    await insertProject(executor);

    await expect(
      executor.execute(
        `INSERT INTO story_planning_candidates (
           id, project_id, task, target_node_id, target_node_title,
           baseline_outline_revision, status, payload_json, editable_synopsis,
           context_json, invocation_id, connection_id, catalog_entry_id,
           provider_kind, model_id, used_fallback, revision, created_at, updated_at, decided_at
         ) VALUES (?, ?, 'outline_planning', ?, '全书', 1, 'accepted', ?, ?, ?, ?, ?, ?,
                   'openai', 'gpt-test', 0, 1, ?, ?, ?)`,
        [
          CANDIDATE_ID,
          PROJECT_ID,
          "019f9f4a-b3c7-7350-9226-000000000003",
          JSON.stringify({ schemaVersion: 1, task: "outline_planning" }),
          "不能伪造采纳",
          JSON.stringify({ formalFactIds: [], lockedFactIds: [], causalEventIds: [] }),
          "invocation-1",
          "connection-1",
          "catalog-1",
          NOW,
          NOW,
          NOW,
        ],
      ),
    ).rejects.toThrow();
    await executor.close();
  });
});

async function insertProject(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at
     ) VALUES (?, '规划候选测试', 'active', 1, 0, ?, ?)`,
    [PROJECT_ID, NOW, NOW],
  );
}
