import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = readFileSync(
  new URL("../migrations/0075_generation_attempt_privacy_snapshot.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-22T00:00:00.000Z";
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("0075 generation attempt privacy snapshot migration", () => {
  it("preserves legacy NULL rows and rejects every new attempt without a complete snapshot", async () => {
    const executor = await createLegacyExecutor();

    await expect(
      executor.select<{
        privacy_snapshot_version: number | null;
        privacy_policy: string | null;
        data_destination: string | null;
        model_invocation_id: string | null;
      }>(
        `SELECT privacy_snapshot_version, privacy_policy, data_destination, model_invocation_id
         FROM ai_generation_attempt_usage WHERE run_id = 'legacy-run'`,
      ),
    ).resolves.toEqual([
      {
        privacy_snapshot_version: null,
        privacy_policy: null,
        data_destination: null,
        model_invocation_id: null,
      },
    ]);

    await executor.execute("INSERT INTO ai_generation_runs (id) VALUES ('new-local-run')");
    await expect(
      insertAttempt(executor, "new-local-run", "local_demo", null, null, null, null),
    ).rejects.toThrow(/privacy snapshot is missing or inconsistent/u);
    await expect(
      insertAttempt(executor, "new-local-run", "local_demo", 1, "local_only", "local", null),
    ).resolves.toBeDefined();
  });

  it("binds a Model Hub attempt to the same invocation privacy snapshot and keeps it immutable", async () => {
    const executor = await createLegacyExecutor();
    await executor.execute("INSERT INTO ai_generation_runs (id) VALUES ('new-remote-run')");
    await executor.execute(
      `INSERT INTO model_invocation_facts (
         id, task, privacy_policy, data_destination
       ) VALUES ('invocation-1', 'continuation', 'local_preferred', 'remote')`,
    );

    await expect(
      insertAttempt(
        executor,
        "new-remote-run",
        "provider_reported",
        1,
        "cloud_allowed",
        "remote",
        "invocation-1",
      ),
    ).rejects.toThrow(/privacy snapshot is missing or inconsistent/u);
    await expect(
      insertAttempt(
        executor,
        "new-remote-run",
        "provider_reported",
        1,
        "local_preferred",
        "remote",
        "invocation-1",
      ),
    ).resolves.toBeDefined();
    await expect(
      executor.execute(
        `UPDATE ai_generation_attempt_usage
         SET privacy_policy = 'cloud_allowed'
         WHERE run_id = 'new-remote-run' AND attempt = 1`,
      ),
    ).rejects.toThrow(/privacy snapshot is immutable/u);
  });
});

async function createLegacyExecutor(): Promise<NodeSqliteExecutor> {
  const executor = new NodeSqliteExecutor(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE ai_generation_runs (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE model_invocation_facts (
      id TEXT PRIMARY KEY NOT NULL,
      task TEXT NOT NULL,
      privacy_policy TEXT NOT NULL,
      data_destination TEXT NOT NULL
    );
    CREATE TABLE ai_generation_attempt_usage (
      run_id TEXT NOT NULL REFERENCES ai_generation_runs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      usage_source TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_input_tokens INTEGER,
      usage_priced_estimate_micros TEXT,
      cost_status TEXT NOT NULL,
      currency TEXT NOT NULL,
      pricing_version TEXT NOT NULL,
      price_updated_at TEXT NOT NULL,
      reported_at TEXT NOT NULL,
      PRIMARY KEY (run_id, attempt)
    );
    INSERT INTO ai_generation_runs (id) VALUES ('legacy-run');
    INSERT INTO ai_generation_attempt_usage (
      run_id, attempt, usage_source, input_tokens, output_tokens,
      cached_input_tokens, usage_priced_estimate_micros, cost_status,
      currency, pricing_version, price_updated_at, reported_at
    ) VALUES (
      'legacy-run', 1, 'provider_unavailable', NULL, NULL, NULL, NULL,
      'estimated', 'USD', 'legacy', '${NOW}', '${NOW}'
    );
    ${migration}
  `);
  executors.push(executor);
  return executor;
}

function insertAttempt(
  executor: NodeSqliteExecutor,
  runId: string,
  source: "provider_reported" | "local_demo",
  privacySnapshotVersion: number | null,
  privacyPolicy: "cloud_allowed" | "local_preferred" | "local_only" | null,
  dataDestination: "local" | "remote" | null,
  modelInvocationId: string | null,
): Promise<unknown> {
  return executor.execute(
    `INSERT INTO ai_generation_attempt_usage (
       run_id, attempt, usage_source, input_tokens, output_tokens,
       cached_input_tokens, usage_priced_estimate_micros, cost_status,
       currency, pricing_version, price_updated_at, reported_at,
       privacy_snapshot_version, privacy_policy, data_destination, model_invocation_id
     ) VALUES (?, 1, ?, ?, ?, NULL, ?, 'estimated', 'USD', 'current', ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      source,
      source === "local_demo" ? 0 : 10,
      source === "local_demo" ? 0 : 4,
      source === "local_demo" ? "0" : "100",
      NOW,
      NOW,
      privacySnapshotVersion,
      privacyPolicy,
      dataDestination,
      modelInvocationId,
    ],
  );
}
