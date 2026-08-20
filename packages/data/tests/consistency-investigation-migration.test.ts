import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = readFileSync(
  new URL("../migrations/0067_consistency_investigation_agent.sql", import.meta.url),
  "utf8",
);
const parents = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE background_tasks (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL
  );
  CREATE TABLE model_provider_connections (id TEXT PRIMARY KEY);
  CREATE TABLE model_catalog_entries (id TEXT PRIMARY KEY);
  CREATE TABLE context_compilation_runs (id TEXT PRIMARY KEY);
  CREATE TABLE model_invocation_facts (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    provider_dispatch_started_at TEXT
  );
  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    current_version_id TEXT
  );
  CREATE TABLE chapter_versions (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL,
    project_id TEXT NOT NULL
  );
`;

const NOW = "2026-08-18T00:00:00.000Z";
const PROJECT_ID = "project-1";
const RUN_ID = "019f9f4a-b3c7-7000-8000-000000000001";
const TASK_ID = "019f9f4a-b3c7-7000-8000-000000000002";
const GENERATION_ID = "019f9f4a-b3c7-7000-8000-000000000003";
const MODEL_STEP_ID = "019f9f4a-b3c7-7000-8000-000000000004";
const FINDING_ID = "019f9f4a-b3c7-7000-8000-000000000005";

describe("consistency investigation migration", () => {
  it("is restart-safe and persists only content-free coordination columns", async () => {
    const executor = new NodeSqliteExecutor(`${parents}\n${migration}\n${migration}`);
    const tables = await executor.select<{ name: string }>(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name LIKE 'consistency_investigation_%'
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "consistency_investigation_evidence",
      "consistency_investigation_findings",
      "consistency_investigation_runs",
      "consistency_investigation_steps",
    ]);
    const columns = await executor.select<{ name: string }>(
      `SELECT name FROM pragma_table_info('consistency_investigation_evidence')`,
    );
    expect(
      columns.some(({ name }) =>
        /(?:excerpt_text|body|content|prompt|response|credential|api_key|secret)/iu.test(name),
      ),
    ).toBe(false);
    await executor.close();
  });

  it("binds task, exact invocation and current immutable evidence", async () => {
    const executor = new NodeSqliteExecutor(`${parents}\n${migration}`);
    await seedParents(executor);
    await insertRun(executor);
    await executor.execute(
      `INSERT INTO consistency_investigation_steps (
         id, run_id, ordinal, step_kind, tool_name, tool_version, permission,
         input_digest, status, invocation_id, created_at, updated_at
       ) VALUES (?, ?, 6, 'model', 'model_synthesis', '1', 'model_dispatch',
         ?, 'bound', 'invocation-1', ?, ?)`,
      [MODEL_STEP_ID, RUN_ID, "c".repeat(64), NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO consistency_investigation_findings (
         id, run_id, model_step_id, ordinal, severity, authority_group,
         category, title, explanation, status, revision, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 'error', 'accepted_body', 'timeline',
         '时间冲突', '两个已接受版本的时间顺序不一致。', 'pending', 1, ?, ?)`,
      [FINDING_ID, RUN_ID, MODEL_STEP_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO consistency_investigation_evidence (
         finding_id, ordinal, project_id, chapter_id, immutable_version_id,
         source_kind, locator_json, excerpt_digest, source_created_at,
         observed_at, currentness, branch_id, privacy
       ) VALUES (?, 0, ?, 'chapter-1', 'version-1', 'chapter', ?, ?, ?, ?,
         'current', NULL, 'standard')`,
      [
        FINDING_ID,
        PROJECT_ID,
        JSON.stringify({ kind: "utf16", startOffset: 0, endOffset: 4, sourceLength: 4 }),
        "d".repeat(64),
        NOW,
        NOW,
      ],
    );
    await expect(
      executor.execute(
        `INSERT INTO consistency_investigation_evidence (
           finding_id, ordinal, project_id, chapter_id, immutable_version_id,
           source_kind, locator_json, excerpt_digest, source_created_at,
           observed_at, currentness, branch_id, privacy
         ) VALUES (?, 1, ?, 'chapter-1', 'version-old', 'chapter', ?, ?, ?, ?,
           'current', NULL, 'standard')`,
        [
          FINDING_ID,
          PROJECT_ID,
          JSON.stringify({ kind: "utf16", startOffset: 0, endOffset: 4, sourceLength: 4 }),
          "e".repeat(64),
          NOW,
          NOW,
        ],
      ),
    ).rejects.toThrow(/evidence is not current authority/u);
    await expect(
      executor.execute(
        `UPDATE consistency_investigation_evidence
         SET excerpt_digest = ? WHERE finding_id = ? AND ordinal = 0`,
        ["f".repeat(64), FINDING_ID],
      ),
    ).rejects.toThrow(/evidence is immutable/u);
    await executor.close();
  });
});

async function seedParents(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute("INSERT INTO projects (id) VALUES (?)", [PROJECT_ID]);
  await executor.execute(
    `INSERT INTO background_tasks (id, task_type, metadata_json)
     VALUES (?, 'consistency_investigation', ?)`,
    [
      TASK_ID,
      JSON.stringify({ operation: "long_form_consistency_investigation", projectId: PROJECT_ID }),
    ],
  );
  await executor.execute("INSERT INTO model_provider_connections (id) VALUES ('connection-1')");
  await executor.execute("INSERT INTO model_catalog_entries (id) VALUES ('catalog-1')");
  await executor.execute(
    `INSERT INTO model_invocation_facts (id, task, provider_dispatch_started_at)
     VALUES ('invocation-1', 'contradiction_check', NULL)`,
  );
  await executor.execute(
    `INSERT INTO chapters (id, project_id, current_version_id)
     VALUES ('chapter-1', ?, 'version-1')`,
    [PROJECT_ID],
  );
  await executor.execute(
    `INSERT INTO chapter_versions (id, chapter_id, project_id)
     VALUES ('version-1', 'chapter-1', ?), ('version-old', 'chapter-1', ?)`,
    [PROJECT_ID, PROJECT_ID],
  );
}

function insertRun(executor: NodeSqliteExecutor): Promise<unknown> {
  return executor.execute(
    `INSERT INTO consistency_investigation_runs (
       id, task_id, project_id, restart_of_run_id, idempotency_key,
       request_fingerprint, status, chapter_count, maximum_model_calls,
       maximum_tool_steps, maximum_context_characters, maximum_output_tokens,
       maximum_duration_ms, automatic_retry_count, estimated_input_tokens,
       connection_id, catalog_entry_id, provider_kind_snapshot, model_id_snapshot,
       privacy_fingerprint, generation_id, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, 'test-run', ?, 'planned', 1, 1, 5, 120000, 4096,
       120000, 0, 64, 'connection-1', 'catalog-1', 'fake', 'fake-model', ?, ?, ?, ?)`,
    [RUN_ID, TASK_ID, PROJECT_ID, "a".repeat(64), "b".repeat(64), GENERATION_ID, NOW, NOW],
  );
}
