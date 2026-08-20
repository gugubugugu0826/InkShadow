import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration0067 = readMigration("0067_consistency_investigation_agent.sql");
const migration0068 = readMigration("0068_writing_disclosure_active_grant_limit.sql");
const migration0069 = readMigration("0069_consistency_investigation_invocation_reservation.sql");
const migration = `${migration0067}\n${migration0069}`;
const parents = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE projects (id TEXT PRIMARY KEY);
  CREATE TABLE background_tasks (id TEXT PRIMARY KEY, task_type TEXT NOT NULL, metadata_json TEXT NOT NULL);
  CREATE TABLE model_provider_connections (id TEXT PRIMARY KEY);
  CREATE TABLE model_catalog_entries (id TEXT PRIMARY KEY);
  CREATE TABLE context_compilation_runs (id TEXT PRIMARY KEY);
  CREATE TABLE context_compilation_execution_links (
    trace_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
  );
  CREATE TABLE context_compilation_model_invocation_links (
    trace_id TEXT PRIMARY KEY, model_invocation_id TEXT NOT NULL UNIQUE, linked_at TEXT NOT NULL
  );
  CREATE TABLE model_invocation_facts (
    id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
    error_code TEXT, error_summary TEXT, provider_dispatch_started_at TEXT,
    completed_at TEXT, revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE chapters (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, current_version_id TEXT);
  CREATE TABLE chapter_versions (id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, project_id TEXT NOT NULL);
  CREATE TABLE writing_provider_disclosure_grants (state TEXT NOT NULL);
`;
const NOW = "2026-08-19T00:00:00.000Z";
const PROJECT_ID = "project-reservation";
const RUN_ID = uuid(1);
const TASK_ID = uuid(2);
const GENERATION_ID = uuid(3);
const TRACE_ID = uuid(4);
const STEP_ID = uuid(5);
const INVOCATION_ID = uuid(6);
const TERMINAL_RUN_ID = uuid(7);
const TERMINAL_TASK_ID = uuid(8);
const TERMINAL_GENERATION_ID = uuid(9);
const TERMINAL_STEP_ID = uuid(10);
const TERMINAL_INVOCATION_ID = uuid(11);
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map(async (executor) => executor.close()));
});

describe("consistency investigation invocation reservation migration", () => {
  it("upgrades terminal and active legacy model steps without mutating terminal history", async () => {
    const executor = new NodeSqliteExecutor(`${parents}\n${migration0067}\n${migration0068}`);
    executors.push(executor);
    await seed(executor);
    await executor.execute(
      `INSERT INTO model_invocation_facts (id, task, status, completed_at)
         VALUES (?, 'contradiction_check', 'succeeded', ?)`,
      [TERMINAL_INVOCATION_ID, NOW],
    );
    await executor.execute(
      `INSERT INTO model_invocation_facts (id, task, status)
         VALUES (?, 'contradiction_check', 'running')`,
      [INVOCATION_ID],
    );
    await executor.execute(
      `UPDATE consistency_investigation_steps
         SET status = 'bound', invocation_id = ?, updated_at = ?
         WHERE id = ? AND status = 'reserved'`,
      [INVOCATION_ID, NOW, STEP_ID],
    );
    await seedTerminalStep(executor);

    executor.database.exec(migration0069);

    await expect(
      executor.select(
        `SELECT status, invocation_id AS invocationId,
                  planned_invocation_id AS plannedInvocationId,
                  terminal_cause AS terminalCause, completed_at AS completedAt
           FROM consistency_investigation_steps WHERE id = ?`,
        [TERMINAL_STEP_ID],
      ),
    ).resolves.toEqual([
      {
        status: "succeeded",
        invocationId: TERMINAL_INVOCATION_ID,
        plannedInvocationId: null,
        terminalCause: "MODEL_SUCCEEDED",
        completedAt: NOW,
      },
    ]);
    await expect(
      executor.select(
        `SELECT invocation.id, invocation.status
           FROM consistency_investigation_steps AS step
           INNER JOIN model_invocation_facts AS invocation ON invocation.id = step.invocation_id
           WHERE step.id = ?`,
        [TERMINAL_STEP_ID],
      ),
    ).resolves.toEqual([{ id: TERMINAL_INVOCATION_ID, status: "succeeded" }]);
    await expect(
      executor.select(
        `SELECT status, invocation_id AS invocationId,
                  planned_invocation_id AS plannedInvocationId
           FROM consistency_investigation_steps WHERE id = ?`,
        [STEP_ID],
      ),
    ).resolves.toEqual([
      {
        status: "bound",
        invocationId: INVOCATION_ID,
        plannedInvocationId: INVOCATION_ID,
      },
    ]);
  });

  it("atomically binds the preplanned invocation to its model step and context trace", async () => {
    const executor = new NodeSqliteExecutor(`${parents}\n${migration}`);
    executors.push(executor);
    await seed(executor);

    await executor.execute(
      `UPDATE consistency_investigation_steps
       SET status = 'bound', planned_invocation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'reserved'`,
      [INVOCATION_ID, NOW, STEP_ID],
    );
    await executor.execute(
      `INSERT INTO model_invocation_facts (id, task, status)
       VALUES (?, 'contradiction_check', 'running')`,
      [INVOCATION_ID],
    );

    await expect(
      executor.select(
        `SELECT planned_invocation_id AS plannedInvocationId, invocation_id AS invocationId
         FROM consistency_investigation_steps WHERE id = ?`,
        [STEP_ID],
      ),
    ).resolves.toEqual([{ plannedInvocationId: INVOCATION_ID, invocationId: INVOCATION_ID }]);
    await expect(
      executor.select(
        `SELECT trace_id AS traceId, model_invocation_id AS invocationId
         FROM context_compilation_model_invocation_links`,
      ),
    ).resolves.toEqual([{ traceId: TRACE_ID, invocationId: INVOCATION_ID }]);
  });

  it("rejects an invocation binding that differs from the durable reservation", async () => {
    const executor = new NodeSqliteExecutor(`${parents}\n${migration}`);
    executors.push(executor);
    await seed(executor);
    await executor.execute(
      `UPDATE consistency_investigation_steps
       SET status = 'bound', planned_invocation_id = ?, updated_at = ?
       WHERE id = ? AND status = 'reserved'`,
      [INVOCATION_ID, NOW, STEP_ID],
    );
    await executor.execute(
      `INSERT INTO model_invocation_facts (id, task, status)
       VALUES (?, 'contradiction_check', 'running')`,
      [uuid(7)],
    );

    await expect(
      executor.execute(
        `UPDATE consistency_investigation_steps SET invocation_id = ? WHERE id = ?`,
        [uuid(7), STEP_ID],
      ),
    ).rejects.toThrow(/differs from its reservation/u);
  });
});

async function seed(executor: NodeSqliteExecutor): Promise<void> {
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
  await executor.execute("INSERT INTO context_compilation_runs (id) VALUES (?)", [TRACE_ID]);
  await executor.execute(
    `INSERT INTO context_compilation_execution_links (trace_id, generation_id, created_at)
     VALUES (?, ?, ?)`,
    [TRACE_ID, GENERATION_ID, NOW],
  );
  await executor.execute(
    `INSERT INTO consistency_investigation_runs (
       id, task_id, project_id, restart_of_run_id, idempotency_key,
       request_fingerprint, status, chapter_count, maximum_model_calls,
       maximum_tool_steps, maximum_context_characters, maximum_output_tokens,
       maximum_duration_ms, automatic_retry_count, estimated_input_tokens,
       connection_id, catalog_entry_id, provider_kind_snapshot, model_id_snapshot,
       privacy_fingerprint, context_trace_id, generation_id, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, 'reservation-test', ?, 'planned', 1, 1, 5, 120000,
       4096, 120000, 0, 64, 'connection-1', 'catalog-1', 'fake', 'fake-model',
       ?, ?, ?, ?, ?)`,
    [
      RUN_ID,
      TASK_ID,
      PROJECT_ID,
      "a".repeat(64),
      "b".repeat(64),
      TRACE_ID,
      GENERATION_ID,
      NOW,
      NOW,
    ],
  );
  await executor.execute(
    `INSERT INTO consistency_investigation_steps (
       id, run_id, ordinal, step_kind, tool_name, tool_version, permission,
       input_digest, status, created_at, updated_at
     ) VALUES (?, ?, 6, 'model', 'model_synthesis', '1', 'model_dispatch',
       ?, 'reserved', ?, ?)`,
    [STEP_ID, RUN_ID, "c".repeat(64), NOW, NOW],
  );
}

async function seedTerminalStep(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO background_tasks (id, task_type, metadata_json)
     VALUES (?, 'consistency_investigation', ?)`,
    [
      TERMINAL_TASK_ID,
      JSON.stringify({ operation: "long_form_consistency_investigation", projectId: PROJECT_ID }),
    ],
  );
  await executor.execute(
    `INSERT INTO consistency_investigation_runs (
       id, task_id, project_id, restart_of_run_id, idempotency_key,
       request_fingerprint, status, chapter_count, maximum_model_calls,
       maximum_tool_steps, maximum_context_characters, maximum_output_tokens,
       maximum_duration_ms, automatic_retry_count, estimated_input_tokens,
       connection_id, catalog_entry_id, provider_kind_snapshot, model_id_snapshot,
       privacy_fingerprint, context_trace_id, generation_id, summary,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, NULL, 'terminal-upgrade-test', ?, 'succeeded', 1, 1, 5, 120000,
       4096, 120000, 0, 64, 'connection-1', 'catalog-1', 'fake', 'fake-model',
       ?, NULL, ?, 'No contradictions found.', ?, ?, ?)`,
    [
      TERMINAL_RUN_ID,
      TERMINAL_TASK_ID,
      PROJECT_ID,
      "d".repeat(64),
      "e".repeat(64),
      TERMINAL_GENERATION_ID,
      NOW,
      NOW,
      NOW,
    ],
  );
  await executor.execute(
    `INSERT INTO consistency_investigation_steps (
       id, run_id, ordinal, step_kind, tool_name, tool_version, permission,
       input_digest, status, invocation_id, observation_digest, terminal_cause,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, 6, 'model', 'model_synthesis', '1', 'model_dispatch',
       ?, 'succeeded', ?, ?, 'MODEL_SUCCEEDED', ?, ?, ?)`,
    [
      TERMINAL_STEP_ID,
      TERMINAL_RUN_ID,
      "f".repeat(64),
      TERMINAL_INVOCATION_ID,
      "0".repeat(64),
      NOW,
      NOW,
      NOW,
    ],
  );
}

function readMigration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7000-8000-${sequence.toString().padStart(12, "0")}`;
}
