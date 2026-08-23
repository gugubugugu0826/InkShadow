import { readFileSync } from "node:fs";

import { Project, parseIsoUtcTimestamp, parseUuidV7 } from "@inkshadow/domain";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteProjectRepository } from "../src/sqlite-repositories.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const displayIdentityMigration = readFileSync(
  new URL("../migrations/0077_project_display_identities.sql", import.meta.url),
  "utf8",
);
const createdAt = expectOk(parseIsoUtcTimestamp("2026-08-23T05:00:00.000Z"));
const executors: NodeSqliteExecutor[] = [];

const currentIdentityTable = `
  CREATE TABLE project_display_identities (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    display_kind TEXT NOT NULL,
    provenance TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const revisionIdentityTable = `
  CREATE TABLE project_display_identity_revisions (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    previous_display_kind TEXT,
    display_kind TEXT NOT NULL,
    provenance TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (project_id, revision)
  );
`;

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("project creation display-identity schema authority", () => {
  it("keeps legacy compatibility when none of the three identity schema components exists", async () => {
    const executor = createExecutor("");
    const projectId = uuid("019fa740-0000-7000-8000-000000000001");

    expectOk(await createProject(executor, projectId));

    await expect(projectCount(executor, projectId)).resolves.toBe(1);
  });

  it("fails closed and rolls back the project when only the current identity table exists", async () => {
    const executor = createExecutor(currentIdentityTable);
    const projectId = uuid("019fa740-0000-7000-8000-000000000002");

    expectIncompleteSchema(await createProject(executor, projectId));

    await expect(projectCount(executor, projectId)).resolves.toBe(0);
  });

  it("fails closed and rolls back the project when both tables exist without the revision trigger", async () => {
    const executor = createExecutor(currentIdentityTable + revisionIdentityTable);
    const projectId = uuid("019fa740-0000-7000-8000-000000000003");

    expectIncompleteSchema(await createProject(executor, projectId));

    await expect(projectCount(executor, projectId)).resolves.toBe(0);
    await expect(
      executor.select<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM project_display_identities",
      ),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("creates the current identity and revision history together under the complete 0077 schema", async () => {
    const executor = createExecutor(`
      CREATE TABLE novel_skill_evaluation_suites (
        id TEXT PRIMARY KEY NOT NULL,
        evaluation_project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL
      );
      ${displayIdentityMigration}
    `);
    const projectId = uuid("019fa740-0000-7000-8000-000000000004");

    expectOk(await createProject(executor, projectId));

    await expect(
      executor.select<{
        readonly displayKind: string;
        readonly provenance: string;
        readonly revision: number;
      }>(
        `SELECT display_kind AS displayKind, provenance, revision
         FROM project_display_identities WHERE project_id = ?`,
        [projectId],
      ),
    ).resolves.toEqual([
      { displayKind: "author_work", provenance: "explicit_creation", revision: 1 },
    ]);
    await expect(
      executor.select<{
        readonly displayKind: string;
        readonly provenance: string;
        readonly revision: number;
      }>(
        `SELECT display_kind AS displayKind, provenance, revision
         FROM project_display_identity_revisions WHERE project_id = ?`,
        [projectId],
      ),
    ).resolves.toEqual([
      { displayKind: "author_work", provenance: "explicit_creation", revision: 1 },
    ]);
  });
});

function createExecutor(extraSchema: string): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(coreMigration + extraSchema);
  executors.push(executor);
  return executor;
}

async function createProject(executor: NodeSqliteExecutor, projectId: ReturnType<typeof uuid>) {
  const project = expectOk(
    Project.create({ id: projectId, name: "架构完整性测试", now: createdAt }),
  );
  return new SqliteProjectRepository(executor).create(project);
}

async function projectCount(executor: NodeSqliteExecutor, projectId: ReturnType<typeof uuid>) {
  const rows = await executor.select<{ readonly count: number }>(
    "SELECT COUNT(*) AS count FROM projects WHERE id = ?",
    [projectId],
  );
  return rows[0]?.count ?? 0;
}

function expectIncompleteSchema(result: { ok: true } | { ok: false; error: unknown }): void {
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "REPOSITORY_ERROR",
      details: { operation: "PROJECT_DISPLAY_IDENTITY_SCHEMA_INCOMPLETE" },
    },
  });
}

function uuid(value: string) {
  return expectOk(parseUuidV7(value));
}

function expectOk<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected an ok result.");
  return result.value;
}
