import { readFileSync } from "node:fs";

import { deriveIdeaProjectSeed, parseProjectSeed } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const journeyMigration = readFileSync(
  new URL("../migrations/0030_creative_journeys.sql", import.meta.url),
  "utf8",
);
const projectSeedMigration = readFileSync(
  new URL("../migrations/0039_project_seeds.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "019fa600-0000-7000-8000-000000000001";
const INVALID_PROJECT_ID = "019fa600-0000-7000-8000-000000000002";
const CREATED_AT = "2026-08-08T00:00:00.000Z";

describe("project seeds migration", () => {
  it("creates the project-owned table and backfills the newest valid legacy journey seed", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${journeyMigration}`);
    await insertProject(executor, PROJECT_ID, "迁移作品");
    await insertProject(executor, INVALID_PROJECT_ID, "无效旧数据");

    const older = deriveIdeaProjectSeed({
      seedId: "idea:legacy-older",
      idea: "旧方向",
      answers: { tone: "克制" },
      skippedQuestionKeys: [],
      now: CREATED_AT,
    });
    const newest = deriveIdeaProjectSeed({
      seedId: "idea:legacy-newest",
      idea: "一名邮差替亡者送出最后一封信。",
      answers: { tone: "温暖", pov: "第三人称限知" },
      skippedQuestionKeys: [],
      now: "2026-08-08T00:05:00.000Z",
    });
    await insertJourney(
      executor,
      "019fa600-0000-7000-8000-000000000011",
      PROJECT_ID,
      older,
      older.updatedAt,
    );
    await insertJourney(
      executor,
      "019fa600-0000-7000-8000-000000000012",
      PROJECT_ID,
      newest,
      newest.updatedAt,
    );
    await executor.execute(
      `INSERT INTO creative_journeys (
         id, kind, status, current_state, project_id, chapter_id, candidate_id,
         revision, snapshot_json, created_at, updated_at, completed_at
       ) VALUES (?, 'idea', 'active', 'asking_one_question', ?, NULL, NULL,
         1, ?, ?, ?, NULL)`,
      [
        "019fa600-0000-7000-8000-000000000013",
        INVALID_PROJECT_ID,
        JSON.stringify({ projectSeed: { version: 1, seedId: "partial" } }),
        CREATED_AT,
        CREATED_AT,
      ],
    );

    executor.database.exec(projectSeedMigration);
    executor.database.exec(projectSeedMigration);

    const columns = await executor.select<{ readonly name: string }>(
      "SELECT name FROM pragma_table_info('project_seeds') ORDER BY cid",
    );
    expect(columns.map(({ name }) => name)).toEqual([
      "project_id",
      "seed_id",
      "journey_kind",
      "schema_version",
      "payload_json",
      "revision",
      "created_at",
      "updated_at",
    ]);
    const rows = await executor.select<{
      readonly projectId: string;
      readonly payloadJson: string;
      readonly revision: number;
    }>(
      `SELECT project_id AS projectId, payload_json AS payloadJson, revision
       FROM project_seeds ORDER BY project_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: PROJECT_ID, revision: 1 });
    expect(parseProjectSeed(JSON.parse(rows[0]?.payloadJson ?? "null"))).toEqual(newest);

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
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, ?, 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [projectId, name, CREATED_AT, CREATED_AT],
  );
}

async function insertJourney(
  executor: NodeSqliteExecutor,
  journeyId: string,
  projectId: string,
  seed: ReturnType<typeof deriveIdeaProjectSeed>,
  updatedAt: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO creative_journeys (
       id, kind, status, current_state, project_id, chapter_id, candidate_id,
       revision, snapshot_json, created_at, updated_at, completed_at
     ) VALUES (?, 'idea', 'active', 'asking_one_question', ?, NULL, NULL,
       1, ?, ?, ?, NULL)`,
    [journeyId, projectId, JSON.stringify({ projectSeed: seed }), seed.createdAt, updatedAt],
  );
}
