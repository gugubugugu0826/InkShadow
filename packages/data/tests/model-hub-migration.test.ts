import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const baseMigration = [
  readFileSync(new URL("../migrations/0004_model_profiles.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0031_model_hub.sql", import.meta.url), "utf8"),
].join("\n");
const expertMigration = readFileSync(
  new URL("../migrations/0037_model_hub_expert_options.sql", import.meta.url),
  "utf8",
);
const zhipuGlmMigration = readFileSync(
  new URL("../migrations/0046_model_hub_zhipu_glm.sql", import.meta.url),
  "utf8",
);
const migration = `${baseMigration}\n${expertMigration}\n${zhipuGlmMigration}`;

const NOW = "2026-08-01T00:00:00.000Z";

describe("Model Hub migration", () => {
  it("is idempotent and creates the complete non-secret foundation", async () => {
    const executor = new NodeSqliteExecutor(
      `${baseMigration}\n${baseMigration}\n${expertMigration}`,
    );
    const tables = await executor.select<{ name: string }>(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table'
         AND name IN (
           'model_provider_connections',
           'model_catalog_syncs',
           'model_catalog_entries',
           'model_capability_scans',
           'model_capability_evidence',
           'model_cost_privacy_profiles',
           'model_evaluation_results',
           'model_hub_presets',
           'novel_task_routes',
           'model_invocation_facts'
         )
       ORDER BY name`,
    );

    expect(tables.map(({ name }) => name)).toEqual([
      "model_capability_evidence",
      "model_capability_scans",
      "model_catalog_entries",
      "model_catalog_syncs",
      "model_cost_privacy_profiles",
      "model_evaluation_results",
      "model_hub_presets",
      "model_invocation_facts",
      "model_provider_connections",
      "novel_task_routes",
    ]);

    const connectionColumns = await columnNames(executor, "model_provider_connections");
    expect(connectionColumns).toEqual(
      expect.arrayContaining([
        "authentication_mode",
        "credential_header_name",
        "model_discovery_path",
        "text_generation_path",
        "embedding_path",
        "request_timeout_ms",
        "retry_limit",
      ]),
    );
    const invocationColumns = await columnNames(executor, "model_invocation_facts");
    const costPrivacyColumns = await columnNames(executor, "model_cost_privacy_profiles");
    const evaluationColumns = await columnNames(executor, "model_evaluation_results");
    for (const columns of [
      connectionColumns,
      invocationColumns,
      costPrivacyColumns,
      evaluationColumns,
    ]) {
      expect(columns.join(" ")).not.toMatch(/api_key|password|access_token|bearer|secret/iu);
    }
    expect(invocationColumns).not.toEqual(
      expect.arrayContaining(["prompt", "messages", "chapter_text", "response", "content"]),
    );
    expect(evaluationColumns).not.toEqual(
      expect.arrayContaining(["prompt", "sample_text", "sample_content", "response", "content"]),
    );

    await executor.close();
  });

  it("upgrades old connections without changing their effective credential behavior", async () => {
    const executor = new NodeSqliteExecutor(baseMigration);
    await insertConnection(
      executor,
      "old-cloud",
      "openai",
      "Old cloud",
      "https://api.openai.com/v1",
    );
    await insertConnection(executor, "old-local", "ollama", "Old local", "http://127.0.0.1:11434");
    executor.database.exec(expertMigration);

    await expect(
      executor.select<{
        id: string;
        authenticationMode: string;
        enabled: number;
        requestTimeoutMs: number;
        retryLimit: number;
      }>(
        `SELECT id, authentication_mode AS authenticationMode, enabled,
                request_timeout_ms AS requestTimeoutMs, retry_limit AS retryLimit
         FROM model_provider_connections ORDER BY id`,
      ),
    ).resolves.toEqual([
      {
        id: "old-cloud",
        authenticationMode: "bearer_keyring",
        enabled: 0,
        requestTimeoutMs: 30_000,
        retryLimit: 0,
      },
      {
        id: "old-local",
        authenticationMode: "none",
        enabled: 1,
        requestTimeoutMs: 30_000,
        retryLimit: 0,
      },
    ]);
    await executor.close();
  });

  it("adds zhipu_glm without losing published connections or dependent catalog rows", async () => {
    const executor = new NodeSqliteExecutor(`${baseMigration}\n${expertMigration}`);
    await insertConnection(
      executor,
      "published-cloud",
      "openai",
      "Published cloud",
      "https://api.openai.com/v1",
    );
    await executor.execute(
      `INSERT INTO model_catalog_syncs (
         id, connection_id, source, status, discovered_model_count,
         next_page_token_present, started_at, completed_at
       ) VALUES ('published-sync', 'published-cloud', 'provider_api',
                 'succeeded', 1, 0, ?, ?)`,
      [NOW, NOW],
    );
    await insertCatalogEntry(
      executor,
      "published-model",
      "published-cloud",
      "published-model-id",
      "published-sync",
    );

    await expect(
      insertConnection(
        executor,
        "glm-before-migration",
        "zhipu_glm",
        "GLM before migration",
        "https://open.bigmodel.cn/api/paas/v4",
      ),
    ).rejects.toThrow();

    executor.database.exec(zhipuGlmMigration);
    await insertConnection(
      executor,
      "glm-after-migration",
      "zhipu_glm",
      "Zhipu GLM",
      "https://open.bigmodel.cn/api/paas/v4",
    );

    await expect(
      executor.select<{ id: string; providerKind: string }>(
        `SELECT id, provider_kind AS providerKind
         FROM model_provider_connections
         ORDER BY id`,
      ),
    ).resolves.toEqual([
      { id: "glm-after-migration", providerKind: "zhipu_glm" },
      { id: "published-cloud", providerKind: "openai" },
    ]);
    await expect(
      executor.select<{ id: string; connectionId: string }>(
        `SELECT id, connection_id AS connectionId
         FROM model_catalog_entries`,
      ),
    ).resolves.toEqual([{ id: "published-model", connectionId: "published-cloud" }]);
    await expect(executor.select<{ table: string }>("PRAGMA foreign_key_check")).resolves.toEqual(
      [],
    );
    await expect(
      executor.select<{ integrity_check: string }>("PRAGMA integrity_check"),
    ).resolves.toEqual([{ integrity_check: "ok" }]);
    await expect(
      insertConnection(
        executor,
        "unknown-after-migration",
        "unknown_provider",
        "Unknown",
        "https://example.test/v1",
      ),
    ).rejects.toThrow();

    await executor.close();
  });

  it("persists dynamic catalogs, evidence, task routing, and content-free invocation facts", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await insertConnection(executor, "cloud", "openai", "remote", "https://api.example.test/v1");
    await insertConnection(executor, "local", "ollama", "local", "http://127.0.0.1:11434");

    await executor.execute(
      `INSERT INTO model_catalog_syncs (
         id, connection_id, source, status, discovered_model_count,
         next_page_token_present, started_at, completed_at
       ) VALUES ('sync-cloud', 'cloud', 'provider_api', 'succeeded', 2, 0, ?, ?)`,
      [NOW, NOW],
    );
    await insertCatalogEntry(executor, "model-cloud-a", "cloud", "runtime-model-a", "sync-cloud");
    await insertCatalogEntry(executor, "model-cloud-b", "cloud", "runtime-model-b", "sync-cloud");
    await insertCatalogEntry(executor, "model-local", "local", "installed-local-model", null);

    await executor.execute(
      `INSERT INTO model_cost_privacy_profiles (
         catalog_entry_id, currency, input_micros_per_million_tokens,
         output_micros_per_million_tokens, pricing_version, price_updated_at,
         data_destination, retention_policy, training_policy, evidence_source,
         evidence_version, evidence_updated_at, created_at, updated_at
       ) VALUES (
         'model-cloud-a', 'USD', '1000000', '3000000', 'pricing-v1', ?,
         'remote', 'provider_default', 'opt_out', 'provider_policy',
         'policy-v1', ?, ?, ?
       )`,
      [NOW, NOW, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO model_evaluation_results (
         id, catalog_entry_id, task, score_basis_points, latency_p50_ms,
         sample_count, evaluation_source, evaluation_version, observed_at, expires_at
       ) VALUES (
         'evaluation-a', 'model-cloud-a', 'prose_generation', 8750, 820,
         48, 'local_evaluation', 'novel-suite-v1', ?, '2026-09-01T00:00:00.000Z'
       )`,
      [NOW],
    );

    await executor.execute(
      `INSERT INTO model_capability_scans (
         id, catalog_entry_id, scan_kind, status, evidence_version,
         supported_count, unsupported_count, unknown_count,
         requested_at, started_at, completed_at
       ) VALUES (
         'scan-a', 'model-cloud-a', 'provider_metadata', 'succeeded',
         'provider-response-v1', 1, 0, 11, ?, ?, ?
       )`,
      [NOW, NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO model_capability_evidence (
         id, catalog_entry_id, scan_id, capability, verdict,
         evidence_source, evidence_version, observed_at
       ) VALUES (
         'evidence-a', 'model-cloud-a', 'scan-a', 'text_generation',
         'supported', 'provider_metadata', 'provider-response-v1', ?
       )`,
      [NOW],
    );

    await executor.execute(
      `INSERT INTO model_hub_presets (
         id, scheme, display_name, status, privacy_policy, cost_priority,
         route_generation_version, created_at, updated_at
       ) VALUES (
         'preset-smart', 'smart', '智能推荐', 'active', 'cloud_allowed',
         'balanced', 'router-v1', ?, ?
       )`,
      [NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO novel_task_routes (
         task, primary_catalog_entry_id, fallback_catalog_entry_id, preset_id,
         parameter_policy_json, maximum_cost_micros, currency, privacy_policy,
         failure_policy, route_origin, created_at, updated_at
       ) VALUES (
         'prose_generation', 'model-cloud-a', 'model-cloud-b', 'preset-smart',
         '{"temperature":0.7}', '2000000', 'USD', 'cloud_allowed',
         'use_fallback', 'automatic', ?, ?
       )`,
      [NOW, NOW],
    );
    await executor.execute(
      `INSERT INTO model_invocation_facts (
         id, task, route_task, connection_id, catalog_entry_id,
         provider_kind_snapshot, model_id_snapshot, route_reason, status,
         attempt, privacy_policy, data_destination, maximum_cost_micros,
         currency, input_tokens, output_tokens, cached_input_tokens,
         estimated_cost_micros, started_at, completed_at, created_at
       ) VALUES (
         'call-a', 'prose_generation', 'prose_generation', 'cloud', 'model-cloud-a',
         'openai', 'runtime-model-a', 'task_primary', 'succeeded', 1,
         'cloud_allowed', 'remote', '2000000', 'USD', 100, 200, 10,
         '1500000', ?, ?, ?
       )`,
      [NOW, NOW, NOW],
    );

    const route = await executor.select<{
      task: string;
      model_id: string;
      verdict: string;
      score_basis_points: number;
      data_destination: string;
      invocation_count: number;
    }>(
      `SELECT
         route.task,
         catalog.provider_model_id AS model_id,
         evidence.verdict,
         evaluation.score_basis_points,
         cost_privacy.data_destination,
         COUNT(invocation.id) AS invocation_count
       FROM novel_task_routes AS route
       JOIN model_catalog_entries AS catalog
         ON catalog.id = route.primary_catalog_entry_id
       JOIN model_capability_evidence AS evidence
         ON evidence.catalog_entry_id = catalog.id
       JOIN model_evaluation_results AS evaluation
         ON evaluation.catalog_entry_id = catalog.id
        AND evaluation.task = route.task
       JOIN model_cost_privacy_profiles AS cost_privacy
         ON cost_privacy.catalog_entry_id = catalog.id
       LEFT JOIN model_invocation_facts AS invocation
         ON invocation.route_task = route.task
       GROUP BY route.task, catalog.provider_model_id, evidence.verdict,
                evaluation.score_basis_points, cost_privacy.data_destination`,
    );
    expect(route).toEqual([
      {
        task: "prose_generation",
        model_id: "runtime-model-a",
        verdict: "supported",
        score_basis_points: 8750,
        data_destination: "remote",
        invocation_count: 1,
      },
    ]);

    await expect(
      executor.execute(
        `INSERT INTO novel_task_routes (
           task, primary_catalog_entry_id, fallback_catalog_entry_id,
           parameter_policy_json, privacy_policy, failure_policy, route_origin,
           created_at, updated_at
         ) VALUES (
           'translation', 'model-cloud-a', 'model-cloud-a', '{}',
           'cloud_allowed', 'use_fallback', 'user', ?, ?
         )`,
        [NOW, NOW],
      ),
    ).rejects.toThrow();

    await expect(
      executor.execute(
        `INSERT INTO model_evaluation_results (
           id, catalog_entry_id, task, score_basis_points, latency_p50_ms,
           sample_count, evaluation_source, evaluation_version, observed_at
         ) VALUES (
           'invalid-evaluation', 'model-cloud-a', 'rewrite', 10001, 100,
           1, 'local_evaluation', 'invalid-v1', ?
         )`,
        [NOW],
      ),
    ).rejects.toThrow();

    await expect(
      executor.execute(
        `INSERT INTO model_invocation_facts (
           id, task, connection_id, provider_kind_snapshot, model_id_snapshot,
           route_reason, status, attempt, privacy_policy, data_destination,
           started_at, completed_at, created_at
         ) VALUES (
           'privacy-leak', 'embedding', 'local', 'ollama', 'installed-local-model',
           'user_override', 'succeeded', 1, 'local_only', 'remote', ?, ?, ?
         )`,
        [NOW, NOW, NOW],
      ),
    ).rejects.toThrow();

    await executor.execute(
      `INSERT INTO model_cost_privacy_profiles (
         catalog_entry_id, data_destination, retention_policy, training_policy,
         evidence_source, evidence_version, evidence_updated_at, created_at, updated_at
       ) VALUES (
         'model-local', 'local', 'none', 'not_used', 'user_confirmed',
         'local-policy-v1', ?, ?, ?
       )`,
      [NOW, NOW, NOW],
    );
    await expect(
      executor.execute(
        `INSERT INTO novel_task_routes (
           task, primary_catalog_entry_id, parameter_policy_json,
           privacy_policy, failure_policy, route_origin, created_at, updated_at
         ) VALUES (
           'translation', 'model-cloud-a', '{}', 'local_only', 'stop', 'user', ?, ?
         )`,
        [NOW, NOW],
      ),
    ).rejects.toThrow(/local-only route requires evidence-confirmed local models/iu);
    await expect(
      executor.execute(
        `INSERT INTO novel_task_routes (
           task, primary_catalog_entry_id, parameter_policy_json,
           privacy_policy, failure_policy, route_origin, created_at, updated_at
         ) VALUES (
           'embedding', 'model-local', '{}', 'local_only', 'stop', 'user', ?, ?
         )`,
        [NOW, NOW],
      ),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await expect(
      executor.execute(
        `INSERT INTO novel_task_routes (
           task, primary_catalog_entry_id, parameter_policy_json,
           privacy_policy, failure_policy, route_origin, created_at, updated_at
         ) VALUES (
           'rerank', 'model-cloud-a', '{}', 'cloud_allowed', 'use_fallback', 'user', ?, ?
         )`,
        [NOW, NOW],
      ),
    ).rejects.toThrow();

    await executor.close();
  });
});

async function columnNames(
  executor: NodeSqliteExecutor,
  table: string,
): Promise<readonly string[]> {
  const rows = await executor.select<{ name: string }>(
    `SELECT name FROM pragma_table_info('${table}') ORDER BY cid`,
  );
  return rows.map(({ name }) => name);
}

async function insertConnection(
  executor: NodeSqliteExecutor,
  id: string,
  providerKind: string,
  displayName: string,
  baseUrl: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url,
       credential_state, connection_status, catalog_sync_status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'missing', 'not_tested', 'never', ?, ?)`,
    [
      id,
      providerKind,
      displayName,
      providerKind === "ollama" ? "ollama" : "openai_compatible",
      baseUrl,
      NOW,
      NOW,
    ],
  );
}

async function insertCatalogEntry(
  executor: NodeSqliteExecutor,
  id: string,
  connectionId: string,
  modelId: string,
  syncId: string | null,
): Promise<void> {
  await executor.execute(
    `INSERT INTO model_catalog_entries (
       id, connection_id, provider_model_id, display_name, catalog_source,
       availability, lifecycle, first_discovered_at, last_seen_at, last_sync_id
     ) VALUES (?, ?, ?, ?, ?, 'available', 'unknown', ?, ?, ?)`,
    [
      id,
      connectionId,
      modelId,
      modelId,
      syncId === null ? "manual" : "provider_api",
      NOW,
      NOW,
      syncId,
    ],
  );
}
