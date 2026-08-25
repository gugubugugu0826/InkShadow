import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const privacyMigration = readFileSync(
  new URL("../migrations/0075_generation_attempt_privacy_snapshot.sql", import.meta.url),
  "utf8",
);
const proseInvocationMigration = readFileSync(
  new URL("../migrations/0078_generation_attempt_prose_invocation.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-25T00:00:00.000Z";
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("0078 generation attempt prose invocation migration", () => {
  it("binds openings and continuations to one exact invocation while rejecting mismatches", async () => {
    const executor = createExecutor();
    executor.database.exec(proseInvocationMigration);

    await seedRunAndInvocation(executor, "opening-run", "opening-invocation", "prose_generation");
    await seedRunAndInvocation(
      executor,
      "continuation-run",
      "continuation-invocation",
      "continuation",
    );
    await seedRunAndInvocation(executor, "privacy-run", "privacy-invocation", "prose_generation");
    await seedRunAndInvocation(executor, "rewrite-run", "rewrite-invocation", "rewrite");

    await expect(
      insertAttempt(executor, "opening-run", "local_preferred", "opening-invocation"),
    ).resolves.toBeDefined();
    await expect(
      insertAttempt(executor, "continuation-run", "local_preferred", "continuation-invocation"),
    ).resolves.toBeDefined();
    await expect(
      insertAttempt(executor, "privacy-run", "cloud_allowed", "privacy-invocation"),
    ).rejects.toThrow(/privacy snapshot is missing or inconsistent/u);
    await expect(
      insertAttempt(executor, "rewrite-run", "local_preferred", "rewrite-invocation"),
    ).rejects.toThrow(/privacy snapshot is missing or inconsistent/u);

    await expect(
      executor.select<{ modelInvocationId: string }>(
        `SELECT model_invocation_id AS modelInvocationId
         FROM ai_generation_attempt_usage ORDER BY run_id`,
      ),
    ).resolves.toEqual([
      { modelInvocationId: "continuation-invocation" },
      { modelInvocationId: "opening-invocation" },
    ]);
    await expect(
      executor.execute(
        `UPDATE ai_generation_attempt_usage
         SET model_invocation_id = 'privacy-invocation'
         WHERE run_id = 'opening-run'`,
      ),
    ).rejects.toThrow(/privacy snapshot is immutable/u);
  });
});

function createExecutor(): NodeSqliteExecutor {
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
    ${privacyMigration}
  `);
  executors.push(executor);
  return executor;
}

async function seedRunAndInvocation(
  executor: NodeSqliteExecutor,
  runId: string,
  invocationId: string,
  task: string,
): Promise<void> {
  await executor.execute("INSERT INTO ai_generation_runs (id) VALUES (?)", [runId]);
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, privacy_policy, data_destination
     ) VALUES (?, ?, 'local_preferred', 'remote')`,
    [invocationId, task],
  );
}

function insertAttempt(
  executor: NodeSqliteExecutor,
  runId: string,
  privacyPolicy: "cloud_allowed" | "local_preferred",
  invocationId: string,
): Promise<unknown> {
  return executor.execute(
    `INSERT INTO ai_generation_attempt_usage (
       run_id, attempt, usage_source, input_tokens, output_tokens,
       cached_input_tokens, usage_priced_estimate_micros, cost_status,
       currency, pricing_version, price_updated_at, reported_at,
       privacy_snapshot_version, privacy_policy, data_destination, model_invocation_id
     ) VALUES (?, 1, 'provider_reported', 10, 4, NULL, '100', 'estimated',
       'USD', 'current', ?, ?, 1, ?, 'remote', ?)`,
    [runId, NOW, NOW, privacyPolicy, invocationId],
  );
}
