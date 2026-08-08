import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0036_story_planning_candidates.sql", import.meta.url),
  "utf8",
);
const selectiveAcceptanceMigration = readFileSync(
  new URL("../migrations/0041_story_planning_selective_acceptance.sql", import.meta.url),
  "utf8",
);
const selectiveAcceptanceIntentMigration = readFileSync(
  new URL("../migrations/0044_story_planning_selective_acceptance_intent.sql", import.meta.url),
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

  it("adds a verifiable synopsis baseline and bounded selective acceptance receipt", async () => {
    const executor = new NodeSqliteExecutor(
      `${coreMigration}\n${migration}\n${selectiveAcceptanceMigration}`,
    );
    await insertProject(executor);

    await executor.execute(
      `INSERT INTO story_planning_candidates (
         id, project_id, task, target_node_id, target_node_title,
         baseline_outline_revision, baseline_target_synopsis, status, payload_json,
         editable_synopsis, context_json, invocation_id, connection_id, catalog_entry_id,
         provider_kind, model_id, used_fallback, accepted_outline_revision,
         accepted_selection_json, revision, created_at, updated_at, decided_at
       ) VALUES (?, ?, 'outline_planning', ?, '全书', 1, '原始简介', 'accepted', ?, ?, ?, ?, ?, ?,
                 'openai', 'gpt-test', 0, 2, ?, 2, ?, ?, ?)`,
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
        JSON.stringify(["beat:0"]),
        NOW,
        NOW,
        NOW,
      ],
    );
    expect(
      await executor.select(
        `SELECT baseline_target_synopsis AS baselineTargetSynopsis,
                accepted_selection_json AS acceptedSelectionJson
         FROM story_planning_candidates WHERE id = ?`,
        [CANDIDATE_ID],
      ),
    ).toEqual([
      {
        baselineTargetSynopsis: "原始简介",
        acceptedSelectionJson: JSON.stringify(["beat:0"]),
      },
    ]);

    await expect(
      executor.execute(
        `UPDATE story_planning_candidates
         SET accepted_selection_json = '[]'
         WHERE id = ?`,
        [CANDIDATE_ID],
      ),
    ).rejects.toThrow();
    await executor.close();
  });

  it("persists a content-free applying intent before finalizing the selected item receipt", async () => {
    const executor = new NodeSqliteExecutor(
      `${coreMigration}\n${migration}\n${selectiveAcceptanceMigration}\n${selectiveAcceptanceIntentMigration}`,
    );
    await insertProject(executor);
    await executor.execute(
      `INSERT INTO story_planning_candidates (
         id, project_id, task, target_node_id, target_node_title,
         baseline_outline_revision, baseline_target_synopsis, status, payload_json,
         editable_synopsis, context_json, invocation_id, connection_id, catalog_entry_id,
         provider_kind, model_id, used_fallback, revision, created_at, updated_at
       ) VALUES (?, ?, 'outline_planning', ?, '全书', 1, '原始简介', 'review', ?, ?, ?, ?, ?, ?,
                 'openai', 'gpt-test', 0, 1, ?, ?)`,
      [
        CANDIDATE_ID,
        PROJECT_ID,
        "019f9f4a-b3c7-7350-9226-000000000003",
        JSON.stringify({
          schemaVersion: 1,
          task: "outline_planning",
          title: "方向",
          direction: "同行",
          beats: [{ title: "相遇", purpose: "建立冲突", outcome: "决定同行" }],
          constraintsApplied: [],
          openQuestions: [],
        }),
        "待审阅的大纲方向",
        JSON.stringify({ formalFactIds: [], lockedFactIds: [], causalEventIds: [] }),
        "invocation-1",
        "connection-1",
        "catalog-1",
        NOW,
        NOW,
      ],
    );
    const intent = JSON.stringify({
      schemaVersion: 1,
      selectedItemIds: ["beat:0"],
      selectionSha256: "a".repeat(64),
      baselineOutlineRevision: 1,
      baselineSynopsisSha256: "b".repeat(64),
      proposedSynopsisSha256: "c".repeat(64),
      startedAt: NOW,
    });

    await expect(
      executor.execute(
        `UPDATE story_planning_candidates
         SET selective_acceptance_intent_json = ?
         WHERE id = ?`,
        [
          JSON.stringify({
            schemaVersion: 1,
            selectedItemIds: ["beat:0"],
            selectionSha256: "a".repeat(64),
            baselineOutlineRevision: 1,
            baselineSynopsisSha256: "b".repeat(64),
            startedAt: NOW,
          }),
          CANDIDATE_ID,
        ],
      ),
    ).rejects.toThrow();

    await executor.execute(
      `UPDATE story_planning_candidates
       SET selective_acceptance_intent_json = ?, revision = revision + 1
       WHERE id = ? AND status = 'review' AND revision = 1`,
      [intent, CANDIDATE_ID],
    );
    expect(
      await executor.select(
        `SELECT status, revision, selective_acceptance_intent_json AS intentJson
         FROM story_planning_candidates WHERE id = ?`,
        [CANDIDATE_ID],
      ),
    ).toEqual([{ status: "review", revision: 2, intentJson: intent }]);

    await executor.execute(
      `UPDATE story_planning_candidates
       SET status = 'accepted', accepted_outline_revision = 2,
           accepted_selection_json = json_extract(selective_acceptance_intent_json, '$.selectedItemIds'),
           selective_acceptance_intent_json = NULL, revision = revision + 1, decided_at = ?
       WHERE id = ? AND status = 'review' AND revision = 2
         AND selective_acceptance_intent_json = ?`,
      [NOW, CANDIDATE_ID, intent],
    );
    expect(
      await executor.select(
        `SELECT status, revision, accepted_selection_json AS acceptedSelectionJson,
                selective_acceptance_intent_json AS intentJson
         FROM story_planning_candidates WHERE id = ?`,
        [CANDIDATE_ID],
      ),
    ).toEqual([
      {
        status: "accepted",
        revision: 3,
        acceptedSelectionJson: JSON.stringify(["beat:0"]),
        intentJson: null,
      },
    ]);
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
