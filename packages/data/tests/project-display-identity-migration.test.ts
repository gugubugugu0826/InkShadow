import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const displayIdentityMigration = readFileSync(
  new URL("../migrations/0077_project_display_identities.sql", import.meta.url),
  "utf8",
);

const AUTHOR_PROJECT_ID = "019fa700-0000-7000-8000-000000000001";
const NAMED_LIKE_TEST_ID = "019fa700-0000-7000-8000-000000000002";
const EVALUATION_PROJECT_ID = "019fa700-0000-7000-8000-000000000003";
const LATE_EVALUATION_PROJECT_ID = "019fa700-0000-7000-8000-000000000004";
const CREATED_AT = "2026-08-23T01:00:00.000Z";
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("0077 project display identities migration", () => {
  it("backfills only exact evaluation_project_id references and never guesses from names", async () => {
    const executor = createExecutor();
    await insertProject(executor, AUTHOR_PROJECT_ID, "作者的长篇故事", "active");
    await insertProject(executor, NAMED_LIKE_TEST_ID, "系统评测项目", "archived");
    await insertProject(executor, EVALUATION_PROJECT_ID, "普通名字", "archived");
    await insertEvaluationSuite(
      executor,
      "019fa700-1000-7000-8000-000000000001",
      EVALUATION_PROJECT_ID,
    );

    executor.database.exec(displayIdentityMigration);
    executor.database.exec(displayIdentityMigration);

    await expect(
      executor.select<{
        projectId: string;
        displayKind: string;
        provenance: string;
      }>(
        `SELECT project_id AS projectId, display_kind AS displayKind, provenance
         FROM project_display_identities ORDER BY project_id`,
      ),
    ).resolves.toEqual([
      {
        projectId: EVALUATION_PROJECT_ID,
        displayKind: "system_evaluation",
        provenance: "evaluation_project_id",
      },
    ]);
  });

  it("tracks evaluation suites inserted after migration and cannot forge evaluation identity", async () => {
    const executor = createExecutor();
    await insertProject(executor, LATE_EVALUATION_PROJECT_ID, "后续评测", "archived");
    executor.database.exec(displayIdentityMigration);

    await insertEvaluationSuite(
      executor,
      "019fa700-1000-7000-8000-000000000002",
      LATE_EVALUATION_PROJECT_ID,
    );

    await expect(
      executor.select<{ displayKind: string; provenance: string }>(
        `SELECT display_kind AS displayKind, provenance
         FROM project_display_identities WHERE project_id = ?`,
        [LATE_EVALUATION_PROJECT_ID],
      ),
    ).resolves.toEqual([{ displayKind: "system_evaluation", provenance: "evaluation_project_id" }]);

    await insertProject(executor, AUTHOR_PROJECT_ID, "普通作品", "active");
    await expect(
      executor.execute(
        `INSERT INTO project_display_identities (
           project_id, display_kind, provenance, created_at, updated_at
         ) VALUES (?, 'system_evaluation', 'evaluation_project_id', ?, ?)`,
        [AUTHOR_PROJECT_ID, CREATED_AT, CREATED_AT],
      ),
    ).rejects.toThrow(/exact evaluation project reference/u);
  });
});

function createExecutor(): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(`
    ${coreMigration}
    CREATE TABLE novel_skill_evaluation_suites (
      id TEXT PRIMARY KEY NOT NULL,
      evaluation_project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    );
  `);
  executors.push(executor);
  return executor;
}

async function insertProject(
  executor: NodeSqliteExecutor,
  projectId: string,
  name: string,
  status: "active" | "archived",
): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, ?, ?, 1, 0, ?, ?, ?, NULL, NULL, NULL)`,
    [projectId, name, status, CREATED_AT, CREATED_AT, status === "archived" ? CREATED_AT : null],
  );
}

async function insertEvaluationSuite(
  executor: NodeSqliteExecutor,
  suiteId: string,
  projectId: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO novel_skill_evaluation_suites (id, evaluation_project_id, created_at)
     VALUES (?, ?, ?)`,
    [suiteId, projectId, CREATED_AT],
  );
}
