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

const AUTHOR_PROJECT_ID = mustUuid("019fa730-0000-7000-8000-000000000001");
const EXAMPLE_PROJECT_ID = mustUuid("019fa730-0000-7000-8000-000000000002");
const EVALUATION_PROJECT_ID = mustUuid("019fa730-0000-7000-8000-000000000003");
const CREATED_AT = mustTimestamp("2026-08-23T04:00:00.000Z");
const TESTED_AT = mustTimestamp("2026-08-23T04:01:00.000Z");
const RESTORED_AT = mustTimestamp("2026-08-23T04:02:00.000Z");

describe("SQLite project display identity classifications", () => {
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

  it("switches author and test work explicitly, idempotently, and with an audit trail", async () => {
    await createProject(projects, AUTHOR_PROJECT_ID, "不按名称判断");

    expectOk(await identities.recordAuthorWork(AUTHOR_PROJECT_ID, CREATED_AT));
    expect(expectOk(await identities.recordTestWork(AUTHOR_PROJECT_ID, TESTED_AT))).toMatchObject({
      displayKind: "test_work",
      provenance: "explicit_test",
      recordedAt: TESTED_AT,
      revision: 2,
    });
    expect(expectOk(await identities.recordTestWork(AUTHOR_PROJECT_ID, RESTORED_AT))).toMatchObject(
      {
        displayKind: "test_work",
        recordedAt: TESTED_AT,
        revision: 2,
      },
    );
    expect(
      expectOk(await identities.recordAuthorWork(AUTHOR_PROJECT_ID, RESTORED_AT)),
    ).toMatchObject({
      displayKind: "author_work",
      provenance: "explicit_creation",
      recordedAt: RESTORED_AT,
      revision: 3,
    });
    expect(expectOk(await identities.listRevisions(AUTHOR_PROJECT_ID))).toEqual([
      {
        projectId: AUTHOR_PROJECT_ID,
        revision: 1,
        previousDisplayKind: null,
        displayKind: "author_work",
        provenance: "explicit_creation",
        recordedAt: CREATED_AT,
      },
      {
        projectId: AUTHOR_PROJECT_ID,
        revision: 2,
        previousDisplayKind: "author_work",
        displayKind: "test_work",
        provenance: "explicit_test",
        recordedAt: TESTED_AT,
      },
      {
        projectId: AUTHOR_PROJECT_ID,
        revision: 3,
        previousDisplayKind: "test_work",
        displayKind: "author_work",
        provenance: "explicit_creation",
        recordedAt: RESTORED_AT,
      },
    ]);
  });

  it("records a built-in example only at creation and protects it from author/test switches", async () => {
    await createProject(projects, EXAMPLE_PROJECT_ID, "示例作品", false, "builtin_example");

    expect(
      expectOk(await identities.recordBuiltinExampleOnCreation(EXAMPLE_PROJECT_ID, CREATED_AT)),
    ).toMatchObject({
      displayKind: "builtin_example",
      provenance: "builtin_example",
      revision: 1,
    });
    expectOk(await identities.recordBuiltinExampleOnCreation(EXAMPLE_PROJECT_ID, TESTED_AT));
    expectProtected(await identities.recordTestWork(EXAMPLE_PROJECT_ID, TESTED_AT));
    expectProtected(await identities.recordAuthorWork(EXAMPLE_PROJECT_ID, RESTORED_AT));

    expect(expectOk(await identities.resolveByProjectId(EXAMPLE_PROJECT_ID))).toMatchObject({
      displayKind: "builtin_example",
      provenance: "builtin_example",
      recordedAt: CREATED_AT,
      revision: 1,
    });
    expect(expectOk(await identities.listRevisions(EXAMPLE_PROJECT_ID))).toHaveLength(1);
  });

  it("never lets explicit recording overwrite an exact system evaluation identity", async () => {
    await createProject(projects, EVALUATION_PROJECT_ID, "普通名字", true);
    await executor.execute(
      `INSERT INTO novel_skill_evaluation_suites (id, evaluation_project_id, created_at)
       VALUES (?, ?, ?)`,
      ["019fa730-1000-7000-8000-000000000001", EVALUATION_PROJECT_ID, CREATED_AT],
    );

    expectProtected(
      await identities.recordBuiltinExampleOnCreation(EVALUATION_PROJECT_ID, TESTED_AT),
    );
    expectProtected(await identities.recordTestWork(EVALUATION_PROJECT_ID, TESTED_AT));
    expectProtected(await identities.recordAuthorWork(EVALUATION_PROJECT_ID, RESTORED_AT));

    expect(expectOk(await identities.resolveByProjectId(EVALUATION_PROJECT_ID))).toMatchObject({
      displayKind: "system_evaluation",
      provenance: "evaluation_project_id",
      recordedAt: CREATED_AT,
      revision: 2,
    });
    expect(expectOk(await identities.listRevisions(EVALUATION_PROJECT_ID))).toHaveLength(2);
  });

  it("rejects every mismatched persistent kind/provenance pair", async () => {
    await createProject(projects, AUTHOR_PROJECT_ID, "约束测试");
    const mismatches = [
      ["author_work", "explicit_test"],
      ["test_work", "explicit_creation"],
      ["builtin_example", "evaluation_project_id"],
      ["system_evaluation", "builtin_example"],
    ] as const;
    for (const [displayKind, provenance] of mismatches) {
      await expect(
        executor.execute(
          `INSERT INTO project_display_identities (
             project_id, display_kind, provenance, revision, created_at, updated_at
           ) VALUES (?, ?, ?, 1, ?, ?)`,
          [AUTHOR_PROJECT_ID, displayKind, provenance, CREATED_AT, CREATED_AT],
        ),
      ).rejects.toThrow();
    }
  });
});

async function createProject(
  repository: SqliteProjectRepository,
  id: typeof AUTHOR_PROJECT_ID,
  name: string,
  archived = false,
  displayKind?: "author_work" | "test_work" | "builtin_example",
): Promise<void> {
  const created = expectOk(Project.create({ id, name, now: CREATED_AT }));
  expectOk(
    await repository.create(
      archived ? expectOk(created.archive(CREATED_AT)) : created,
      displayKind,
    ),
  );
}

function expectProtected(result: { ok: true } | { ok: false; error: unknown }): void {
  expect(result).toMatchObject({
    ok: false,
    error: { details: { operation: "PROJECT_DISPLAY_IDENTITY_PROTECTED" } },
  });
}

function mustUuid(value: string) {
  return expectOk(parseUuidV7(value));
}

function mustTimestamp(value: string) {
  return expectOk(parseIsoUtcTimestamp(value));
}

function expectOk<Value>(result: { ok: true; value: Value } | { ok: false }): Value {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected an ok result.");
  return result.value;
}
