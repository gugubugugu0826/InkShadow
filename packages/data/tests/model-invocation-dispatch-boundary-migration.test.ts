import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const base = [
  "0004_model_profiles.sql",
  "0031_model_hub.sql",
  "0037_model_hub_expert_options.sql",
  "0046_model_hub_zhipu_glm.sql",
  "0051_model_hub_connection_commits.sql",
  "0056_model_hub_failure_diagnostics.sql",
  "0057_model_hub_content_quality_task.sql",
]
  .map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"))
  .join("\n");
const migration = readFileSync(
  new URL("../migrations/0065_model_invocation_dispatch_boundary.sql", import.meta.url),
  "utf8",
);

describe("model invocation provider dispatch boundary migration", () => {
  it("upgrades an existing ledger without changing its rows and supports restart", async () => {
    const executor = new NodeSqliteExecutor(base);
    await executor.execute(
      `INSERT INTO model_provider_connections (
         id, provider_kind, display_name, protocol, base_url, credential_ref,
         credential_state, authentication_mode, request_timeout_ms, retry_limit,
         connection_status, catalog_sync_status, enabled, revision, created_at, updated_at
       ) VALUES (?, 'openai', 'OpenAI', 'openai_compatible', 'https://api.example.test/v1',
         'keyring:model-hub:test', 'present', 'bearer_keyring', 60000, 0,
         'ready', 'succeeded', 1, 1, ?, ?)`,
      ["connection", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z"],
    );
    await executor.execute(
      `INSERT INTO model_invocation_facts (
         id, task, connection_id, provider_kind_snapshot, model_id_snapshot,
         route_reason, status, attempt, privacy_policy, data_destination,
         started_at, created_at, revision
       ) VALUES ('invocation', 'book_start_guidance', 'connection', 'openai', 'writer',
         'user_override', 'running', 1, 'cloud_allowed', 'remote', ?, ?, 1)`,
      ["2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z"],
    );

    await executor.execute(migration);
    const first = await executor.select<{
      id: string;
      provider_dispatch_started_at: string | null;
      revision: number;
    }>(
      `SELECT id, provider_dispatch_started_at, revision
       FROM model_invocation_facts WHERE id = 'invocation'`,
    );
    expect(first).toEqual([{ id: "invocation", provider_dispatch_started_at: null, revision: 1 }]);
    await executor.execute(
      `UPDATE model_invocation_facts
       SET provider_dispatch_started_at = ?, revision = revision + 1
       WHERE id = 'invocation' AND status = 'running'
         AND provider_dispatch_started_at IS NULL AND revision = 1`,
      ["2026-08-13T00:00:01.000Z"],
    );
    await expect(
      executor.select(
        `SELECT provider_dispatch_started_at, revision
         FROM model_invocation_facts WHERE id = 'invocation'`,
      ),
    ).resolves.toEqual([{ provider_dispatch_started_at: "2026-08-13T00:00:01.000Z", revision: 2 }]);
    await executor.close();
  });
});
