import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0030_creative_journeys.sql", import.meta.url),
  "utf8",
);

describe("creative journeys migration", () => {
  it("creates resumable, non-secret journeys and ordered turns", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}\n${migration}`);
    const journeyColumns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('creative_journeys') ORDER BY cid",
    );
    const turnColumns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('creative_journey_turns') ORDER BY cid",
    );

    expect(journeyColumns.map(({ name }) => name)).toEqual([
      "id",
      "kind",
      "status",
      "current_state",
      "project_id",
      "chapter_id",
      "candidate_id",
      "revision",
      "snapshot_json",
      "created_at",
      "updated_at",
      "completed_at",
    ]);
    expect(turnColumns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["api_key", "secret", "prompt", "response_body"]),
    );

    await executor.execute(
      `INSERT INTO creative_journeys (
         id, kind, status, current_state, project_id, chapter_id, candidate_id,
         revision, snapshot_json, created_at, updated_at, completed_at
       ) VALUES (?, 'idea', 'active', 'opening_preview', NULL, NULL, NULL, 1, '{}', ?, ?, NULL)`,
      [
        "019f9f4a-b3c7-7350-9226-000000000401",
        "2026-08-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ],
    );
    await executor.execute(
      `INSERT INTO creative_journey_turns (
         id, journey_id, sequence, turn_kind, question_key, generation_source,
         provider_id, model_id, task_key, request_id, snapshot_json, created_at
       ) VALUES (?, ?, 1, 'idea', NULL, 'local_fallback', NULL, NULL,
         'opening_guidance', ?, '{"inputLength":12}', ?)`,
      [
        "019f9f4a-b3c7-7350-9226-000000000402",
        "019f9f4a-b3c7-7350-9226-000000000401",
        "019f9f4a-b3c7-7350-9226-000000000403",
        "2026-08-01T00:00:00.000Z",
      ],
    );

    await expect(
      executor.execute(
        `INSERT INTO creative_journey_turns (
           id, journey_id, sequence, turn_kind, snapshot_json, created_at
         ) VALUES (?, ?, 1, 'answer', '{}', ?)`,
        [
          "019f9f4a-b3c7-7350-9226-000000000404",
          "019f9f4a-b3c7-7350-9226-000000000401",
          "2026-08-01T00:00:01.000Z",
        ],
      ),
    ).rejects.toThrow();
    await executor.close();
  });
});
