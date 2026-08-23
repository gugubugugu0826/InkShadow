import { readFileSync } from "node:fs";

import { Project, parseIsoUtcTimestamp, parseUuidV7 } from "@inkshadow/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteProjectDisplayIdentityRepository,
  SqliteProjectRepository,
} from "../src/sqlite-repositories.js";
import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  `CREATE TABLE novel_skill_evaluation_suites (
     id TEXT PRIMARY KEY NOT NULL,
     evaluation_project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE RESTRICT,
     created_at TEXT NOT NULL
   );`,
  readFileSync(
    new URL("../migrations/0077_project_display_identities.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const AUTHOR_PROJECT_ID = expectOk(parseUuidV7("019fa710-0000-7000-8000-000000000001"));
const EVALUATION_PROJECT_ID = expectOk(parseUuidV7("019fa710-0000-7000-8000-000000000002"));
const MISSING_PROJECT_ID = expectOk(parseUuidV7("019fa710-0000-7000-8000-000000000003"));
const CREATED_AT = expectOk(parseIsoUtcTimestamp("2026-08-23T02:00:00.000Z"));

describe("SQLite project display identity repository", () => {
  let executor: NodeSqliteExecutor;
  let projects: SqliteProjectRepository;
  let identities: SqliteProjectDisplayIdentityRepository;

  beforeEach(() => {
    executor = new NodeSqliteExecutor(migration);
    projects = new SqliteProjectRepository(executor);
    identities = new SqliteProjectDisplayIdentityRepository(executor);
  });

  afterEach(async () => {
    await executor.close();
  });

  it("resolves a missing identity row as an author work with legacy-unknown provenance", async () => {
    await insertLegacyProject(executor, AUTHOR_PROJECT_ID, "旧版作者作品");

    expect(expectOk(await identities.resolveByProjectId(AUTHOR_PROJECT_ID))).toEqual({
      projectId: AUTHOR_PROJECT_ID,
      displayKind: "author_work",
      provenance: "legacy_unknown",
      recordedAt: null,
      revision: null,
    });
    expect(expectOk(await identities.resolveByProjectId(MISSING_PROJECT_ID))).toBeNull();
  });

  it("records explicit author identity idempotently without changing the project", async () => {
    await createProject(projects, AUTHOR_PROJECT_ID, "作者作品");
    const before = expectOk(await projects.findById(AUTHOR_PROJECT_ID))?.toSnapshot();

    const first = expectOk(await identities.recordAuthorWork(AUTHOR_PROJECT_ID, CREATED_AT));
    const second = expectOk(await identities.recordAuthorWork(AUTHOR_PROJECT_ID, CREATED_AT));

    expect(first).toEqual({
      projectId: AUTHOR_PROJECT_ID,
      displayKind: "author_work",
      provenance: "explicit_creation",
      recordedAt: CREATED_AT,
      revision: 1,
    });
    expect(second).toEqual(first);
    expect(expectOk(await projects.findById(AUTHOR_PROJECT_ID))?.toSnapshot()).toEqual(before);
  });

  it("keeps exact evaluation identity authoritative when author recording is attempted", async () => {
    await createProject(projects, EVALUATION_PROJECT_ID, "不是按名称识别", true);
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_suites (id, evaluation_project_id, created_at)
       VALUES (?, ?, ?)`,
      ["019fa710-1000-7000-8000-000000000001", EVALUATION_PROJECT_ID, CREATED_AT],
    );

    expectProtected(await identities.recordAuthorWork(EVALUATION_PROJECT_ID, CREATED_AT));
    expect(expectOk(await identities.resolveByProjectId(EVALUATION_PROJECT_ID))).toEqual({
      projectId: EVALUATION_PROJECT_ID,
      displayKind: "system_evaluation",
      provenance: "evaluation_project_id",
      recordedAt: CREATED_AT,
      revision: 2,
    });
  });
});

async function insertLegacyProject(
  executor: NodeSqliteExecutor,
  id: typeof AUTHOR_PROJECT_ID,
  name: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, ?, 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [id, name, CREATED_AT, CREATED_AT],
  );
}

function expectProtected(result: { ok: true } | { ok: false; error: unknown }): void {
  expect(result).toMatchObject({
    ok: false,
    error: { details: { operation: "PROJECT_DISPLAY_IDENTITY_PROTECTED" } },
  });
}
async function createProject(
  repository: SqliteProjectRepository,
  id: typeof AUTHOR_PROJECT_ID,
  name: string,
  archived = false,
): Promise<void> {
  const created = expectOk(Project.create({ id, name, now: CREATED_AT }));
  const project = archived ? expectOk(created.archive(CREATED_AT)) : created;
  expectOk(await repository.create(project));
}

function expectOk<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected an ok result.");
  return result.value;
}
