import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0002_tasks_notifications.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0004_model_profiles.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0005_ai_generation_governance.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0007_model_routing_usage.sql", import.meta.url), "utf8"),
].join("\n");

describe("model routing, deferred generation, and usage migration", () => {
  it("is idempotent and creates the four authoritative governance tables", async () => {
    const executor = new NodeSqliteExecutor(`${migration}\n${migration}`);

    const rows = await executor.select<{ name: string }>(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table'
         AND name IN (
           'model_role_routes',
           'ai_generation_route_selections',
           'ai_generation_attempt_usage',
           'ai_deferred_generation_requests'
         )
       ORDER BY name`,
    );

    expect(rows.map(({ name }) => name)).toEqual([
      "ai_deferred_generation_requests",
      "ai_generation_attempt_usage",
      "ai_generation_route_selections",
      "model_role_routes",
    ]);
    await executor.close();
  });

  it("keeps deferred rows content-free and enforces raw usage consistency", async () => {
    const executor = new NodeSqliteExecutor(migration);
    const deferredColumns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('ai_deferred_generation_requests') ORDER BY cid",
    );
    expect(deferredColumns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["content", "prompt", "messages", "secret", "credential"]),
    );

    await expect(
      executor.execute(
        `INSERT INTO ai_generation_attempt_usage (
           run_id, attempt, usage_source, input_tokens, output_tokens,
           cached_input_tokens, usage_priced_estimate_micros, currency,
           pricing_version, price_updated_at, reported_at
         ) VALUES (
           'missing-run', 1, 'provider_unavailable', 1, NULL,
           NULL, NULL, 'USD', 'price-v1', ?, ?
         )`,
        ["2026-07-27T00:00:00.000Z", "2026-07-27T00:00:00.000Z"],
      ),
    ).rejects.toThrow();
    await executor.close();
  });
});
