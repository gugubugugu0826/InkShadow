import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0002_tasks_notifications.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0004_model_profiles.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0005_ai_generation_governance.sql", import.meta.url), "utf8"),
].join("\n");

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const TASK_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const RUN_ID = "019f9f4a-b3c7-7350-9226-000000000005";

describe("AI generation governance migration", () => {
  it("creates repeatable pricing, budget, and content-free run ledgers", async () => {
    const executor = new NodeSqliteExecutor(`${migration}\n${migration}`);
    const tables = await executor.select<{ name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('model_pricing_profiles', 'ai_budget_policies', 'ai_generation_runs')
       ORDER BY name`,
    );
    expect(tables.map(({ name }) => name)).toEqual([
      "ai_budget_policies",
      "ai_generation_runs",
      "model_pricing_profiles",
    ]);

    const runColumns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('ai_generation_runs') ORDER BY cid",
    );
    expect(runColumns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["content", "prompt", "messages", "credential", "secret"]),
    );
    await executor.close();
  });

  it("enforces pricing, scope, lifecycle, and foreign-key invariants", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedGenerationParents(executor);
    await executor.execute(
      `INSERT INTO model_pricing_profiles (
         provider_id, model_id, context_window_tokens, currency,
         input_micros_per_million_tokens, output_micros_per_million_tokens,
         cached_input_micros_per_million_tokens, pricing_version,
         price_updated_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      ["openai", "gpt-test", 16_000, "USD", 1_000_000, 2_000_000, "2026-07", NOW, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO ai_budget_policies (
         scope_key, scope, project_id, month_key, currency, limit_micros,
         enforcement, revision, created_at, updated_at
       ) VALUES (?, 'project', ?, NULL, 'USD', '100000', 'hard', 1, ?, ?)`,
      [`project:${PROJECT_ID}`, PROJECT_ID, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO ai_generation_runs (
         id, task_id, idempotency_key, project_id, chapter_id, base_version_id,
         provider_id, model_id, state, input_tokens, maximum_output_tokens,
         estimated_cost_micros, currency, pricing_version, price_updated_at,
         preflight_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        RUN_ID,
        TASK_ID,
        `ai.generate:${CHAPTER_ID}:${VERSION_ID}`,
        PROJECT_ID,
        CHAPTER_ID,
        VERSION_ID,
        "openai",
        "gpt-test",
        4_000,
        2_000,
        "8000",
        "USD",
        "2026-07",
        NOW,
        JSON.stringify({ codes: ["READY"], checkedAt: NOW }),
        NOW,
        NOW,
      ],
    );

    await expect(
      executor.execute(
        `UPDATE ai_generation_runs
         SET state = 'completed', completed_at = NULL
         WHERE id = ?`,
        [RUN_ID],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `UPDATE ai_generation_runs
         SET preflight_json = '{"content":"private chapter"}'
         WHERE id = ?`,
        [RUN_ID],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `INSERT INTO ai_budget_policies (
           scope_key, scope, project_id, month_key, currency, limit_micros,
           enforcement, revision, created_at, updated_at
         ) VALUES ('month:bad', 'month', ?, NULL, 'USD', '1', 'warn', 1, ?, ?)`,
        [PROJECT_ID, NOW, NOW],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `UPDATE model_pricing_profiles SET currency = 'usd'
         WHERE provider_id = 'openai' AND model_id = 'gpt-test'`,
      ),
    ).rejects.toThrow();
    await executor.close();
  });
});

async function seedGenerationParents(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute("BEGIN IMMEDIATE");
  await executor.execute(
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Project', ?, ?)",
    [PROJECT_ID, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO chapters (
       id, project_id, title, content, current_version_id,
       created_at, updated_at
     ) VALUES (?, ?, 'Chapter', '', ?, ?, ?)`,
    [CHAPTER_ID, PROJECT_ID, VERSION_ID, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO chapter_versions (
       id, project_id, chapter_id, sequence, reason, content,
       content_checksum, created_at
     ) VALUES (?, ?, ?, 1, 'created', '', ?, ?)`,
    [VERSION_ID, PROJECT_ID, CHAPTER_ID, "a".repeat(64), NOW],
  );
  await executor.execute(
    `INSERT INTO background_tasks (
       id, task_type, idempotency_key, metadata_json, priority, status,
       attempt, max_attempts, sequence, run_after, created_at, updated_at
     ) VALUES (?, 'ai.generate', ?, '{}', 50, 'queued', 1, 3, 1, ?, ?, ?)`,
    [TASK_ID, `ai.generate:${CHAPTER_ID}:${VERSION_ID}`, NOW, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO model_profiles (
       provider_id, provider, base_url, authentication, selected_model,
       revision, created_at, updated_at
    ) VALUES ('openai', 'open_ai_compatible', 'https://api.openai.com/v1',
       'bearer_keyring', 'gpt-test', 1, ?, ?)`,
    [NOW, NOW],
  );
  await executor.execute("COMMIT");
}
