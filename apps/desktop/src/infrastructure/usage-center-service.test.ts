import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { SqliteUsageCenterService, type UsageCenterQuery } from "./usage-center-service";

const MIGRATION = [
  "0001_core.sql",
  "0002_tasks_notifications.sql",
  "0004_model_profiles.sql",
  "0005_ai_generation_governance.sql",
  "0007_model_routing_usage.sql",
  "0031_model_hub.sql",
]
  .map(readMigration)
  .join("\n");

const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const TASK_ID = uuid(4);
const RUN_ID = uuid(5);
const NOW = "2026-08-08T08:00:00.000Z";
const executors: NodeSqliteExecutor[] = [];

afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.close()));
});

describe("SqliteUsageCenterService", () => {
  it("combines the durable ledgers without double-counting continuations", async () => {
    const executor = await createSeededExecutor();
    const service = new SqliteUsageCenterService(executor);

    const snapshot = await service.read(query());

    expect(snapshot.summary).toMatchObject({
      invocationCount: 3,
      successCount: 2,
      failureCount: 1,
      localCount: 1,
      remoteCount: 1,
      destinationUnknownCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      tokenUsageUnknownCount: 2,
      costUnknownCount: 2,
      costTotals: [{ currency: "CNY", micros: "120000", invocationCount: 1 }],
    });
    expect(snapshot.records.map(({ id }) => id)).toEqual([
      "hub:image-call",
      "hub:embedding-call",
      `generation:${RUN_ID}:1`,
    ]);
    expect(snapshot.records).not.toContainEqual(
      expect.objectContaining({ id: "hub:duplicate-continuation" }),
    );
    expect(snapshot.records[0]).toMatchObject({
      task: "image_generation",
      dataDestination: "local",
      privacyPolicy: "local_only",
      costMicros: null,
      costSource: "unknown",
    });
    expect(snapshot.breakdowns.project).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "__unlinked__", label: "未关联作品", invocationCount: 2 }),
        expect.objectContaining({ key: PROJECT_ID, label: "测试长篇", invocationCount: 1 }),
      ]),
    );
    expect(snapshot.breakdowns.task).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "continuation", label: "续写" }),
        expect.objectContaining({ key: "embedding", label: "语义记忆" }),
        expect.objectContaining({ key: "image_generation", label: "生成配图" }),
      ]),
    );
    expect(snapshot.facets.projects).toEqual([{ value: PROJECT_ID, label: "测试长篇" }]);
    expect(snapshot.budgets).toEqual([
      expect.objectContaining({
        scope: "month",
        monthKey: "2026-08",
        currency: "CNY",
        limitMicros: "30000000",
      }),
    ]);
  });

  it("filters by project, task, provider and model while keeping honest facets", async () => {
    const executor = await createSeededExecutor();
    const service = new SqliteUsageCenterService(executor);

    const projectSnapshot = await service.read({ ...query(), projectId: PROJECT_ID });
    expect(projectSnapshot.totalMatchingRecords).toBe(1);
    expect(projectSnapshot.records[0]).toMatchObject({
      projectId: PROJECT_ID,
      task: "continuation",
      providerId: "legacy-provider",
      modelId: "legacy-model",
    });
    expect(projectSnapshot.facets.tasks).toHaveLength(3);
    expect(projectSnapshot.budgets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "month", limitMicros: "30000000" }),
        expect.objectContaining({
          scope: "project",
          projectId: PROJECT_ID,
          limitMicros: "10000000",
        }),
      ]),
    );

    const modelSnapshot = await service.read({
      ...query(),
      task: "image_generation",
      providerId: "ollama-connection",
      modelId: "qwen-local",
    });
    expect(modelSnapshot.records).toHaveLength(1);
    expect(modelSnapshot.summary).toMatchObject({
      invocationCount: 1,
      localCount: 1,
      costUnknownCount: 1,
      costTotals: [],
    });
  });

  it("limits details without truncating the summary", async () => {
    const executor = await createSeededExecutor();
    const service = new SqliteUsageCenterService(executor);

    const snapshot = await service.read({ ...query(), detailLimit: 1 });

    expect(snapshot.summary.invocationCount).toBe(3);
    expect(snapshot.totalMatchingRecords).toBe(3);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.detailsTruncated).toBe(true);
  });

  it("rejects invalid ranges instead of returning misleading aggregates", async () => {
    const executor = await createSeededExecutor();
    const service = new SqliteUsageCenterService(executor);

    await expect(
      service.read({
        ...query(),
        fromInclusive: "2026-08-09T00:00:00.000Z",
        toExclusive: "2026-08-08T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "USAGE_CENTER_INVALID_QUERY",
    });
  });
});

function query(): UsageCenterQuery {
  return {
    fromInclusive: "2026-08-08T00:00:00.000Z",
    toExclusive: "2026-08-09T00:00:00.000Z",
    projectId: null,
    task: null,
    providerId: null,
    modelId: null,
    monthKey: "2026-08",
    timezoneOffsetMinutes: 0,
  };
}

async function createSeededExecutor(): Promise<NodeSqliteExecutor> {
  const executor = new NodeSqliteExecutor(MIGRATION);
  executors.push(executor);
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at
     ) VALUES (?, '测试长篇', 'active', 1, 0, ?, ?)`,
    [PROJECT_ID, NOW, NOW],
  );
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision,
         current_version_id, created_at, updated_at
       ) VALUES (?, ?, '第一章', '正文', 'active', 1, ?, ?, ?)`,
      [CHAPTER_ID, PROJECT_ID, VERSION_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence,
         content, content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, '正文', ?, 'created', NULL, ?)`,
      [VERSION_ID, PROJECT_ID, CHAPTER_ID, "a".repeat(64), NOW],
    );
  });
  await executor.execute(
    `INSERT INTO background_tasks (
       id, task_type, idempotency_key, metadata_json, priority, status,
       attempt, max_attempts, sequence, run_after, created_at, updated_at,
       finished_at
     ) VALUES (?, 'ai.generate', 'usage-test-generation', '{}', 80, 'succeeded',
       1, 1, 1, NULL, ?, ?, ?)`,
    [TASK_ID, NOW, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO model_profiles (
       provider_id, provider, base_url, authentication, selected_model,
       revision, created_at, updated_at
     ) VALUES ('legacy-provider', 'open_ai_compatible', 'https://example.invalid/v1',
       'bearer_keyring', 'legacy-model', 1, ?, ?)`,
    [NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO ai_generation_runs (
       id, task_id, idempotency_key, project_id, chapter_id, base_version_id,
       provider_id, model_id, state, revision, attempt, input_tokens,
       maximum_output_tokens, estimated_cost_micros, incurred_cost_micros,
       currency, pricing_version, price_updated_at, preflight_json,
       completed_at, created_at, updated_at
     ) VALUES (?, ?, 'usage-run-idempotency', ?, ?, ?, 'legacy-provider',
       'legacy-model', 'completed', 2, 1, 100, 200, '130000', '130000',
       'CNY', 'price-2026-08', ?, '{}', ?, ?, ?)`,
    [
      RUN_ID,
      TASK_ID,
      PROJECT_ID,
      CHAPTER_ID,
      VERSION_ID,
      NOW,
      "2026-08-08T08:00:00.000Z",
      "2026-08-08T07:59:00.000Z",
      "2026-08-08T08:00:00.000Z",
    ],
  );
  await executor.execute(
    `INSERT INTO ai_generation_route_selections (
       run_id, role, reason, fallback_provider_id, fallback_model_id, created_at
     ) VALUES (?, 'high_quality', 'legacy_default', NULL, NULL, ?)`,
    [RUN_ID, NOW],
  );
  await executor.execute(
    `INSERT INTO ai_generation_attempt_usage (
       run_id, attempt, usage_source, input_tokens, output_tokens,
       cached_input_tokens, usage_priced_estimate_micros, currency,
       pricing_version, price_updated_at, reported_at
     ) VALUES (?, 1, 'provider_reported', 100, 20, 10, '120000',
       'CNY', 'price-2026-08', ?, '2026-08-08T08:00:00.000Z')`,
    [RUN_ID, NOW],
  );
  await seedConnection(
    executor,
    "openai-connection",
    "openai",
    "OpenAI",
    "openai_compatible",
    "https://api.openai.com/v1",
  );
  await seedConnection(
    executor,
    "ollama-connection",
    "ollama",
    "本机 Ollama",
    "ollama",
    "http://127.0.0.1:11434",
  );
  await seedInvocation(executor, {
    id: "duplicate-continuation",
    task: "continuation",
    connectionId: "openai-connection",
    providerKind: "openai",
    modelId: "cloud-model",
    status: "succeeded",
    privacyPolicy: "cloud_allowed",
    destination: "remote",
    inputTokens: 100,
    outputTokens: 20,
    costMicros: "120000",
    currency: "CNY",
    occurredAt: "2026-08-08T08:00:01.000Z",
    errorCode: null,
  });
  await seedInvocation(executor, {
    id: "embedding-call",
    task: "embedding",
    connectionId: "openai-connection",
    providerKind: "openai",
    modelId: "embedding-model",
    status: "failed",
    privacyPolicy: "cloud_allowed",
    destination: "remote",
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    currency: null,
    occurredAt: "2026-08-08T09:00:00.000Z",
    errorCode: "PROVIDER_TIMEOUT",
  });
  await seedInvocation(executor, {
    id: "image-call",
    task: "image_generation",
    connectionId: "ollama-connection",
    providerKind: "ollama",
    modelId: "qwen-local",
    status: "succeeded",
    privacyPolicy: "local_only",
    destination: "local",
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    currency: null,
    occurredAt: "2026-08-08T10:00:00.000Z",
    errorCode: null,
  });
  await executor.execute(
    `INSERT INTO ai_budget_policies (
       scope_key, scope, project_id, month_key, currency, limit_micros,
       enforcement, revision, created_at, updated_at
     ) VALUES ('month:2026-08:CNY', 'month', NULL, '2026-08', 'CNY',
       '30000000', 'warn', 1, ?, ?)`,
    [NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO ai_budget_policies (
       scope_key, scope, project_id, month_key, currency, limit_micros,
       enforcement, revision, created_at, updated_at
     ) VALUES ('project:test:CNY', 'project', ?, NULL, 'CNY',
       '10000000', 'hard', 1, ?, ?)`,
    [PROJECT_ID, NOW, NOW],
  );
  return executor;
}

async function seedConnection(
  executor: NodeSqliteExecutor,
  id: string,
  providerKind: string,
  displayName: string,
  protocol: string,
  baseUrl: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url,
       credential_ref, credential_state, connection_status,
       catalog_sync_status, enabled, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, 'missing', 'ready', 'never', 1, 1, ?, ?)`,
    [id, providerKind, displayName, protocol, baseUrl, NOW, NOW],
  );
}

async function seedInvocation(
  executor: NodeSqliteExecutor,
  input: Readonly<{
    id: string;
    task: string;
    connectionId: string;
    providerKind: string;
    modelId: string;
    status: "succeeded" | "failed";
    privacyPolicy: "cloud_allowed" | "local_only";
    destination: "local" | "remote";
    inputTokens: number | null;
    outputTokens: number | null;
    costMicros: string | null;
    currency: string | null;
    occurredAt: string;
    errorCode: string | null;
  }>,
): Promise<void> {
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, route_task, connection_id, catalog_entry_id,
       provider_kind_snapshot, model_id_snapshot, route_reason, status,
       attempt, fallback_from_invocation_id, privacy_policy, data_destination,
       maximum_cost_micros, currency, input_tokens, output_tokens,
       cached_input_tokens, estimated_cost_micros, error_code, error_summary,
       started_at, completed_at, created_at, revision
     ) VALUES (?, ?, NULL, ?, NULL, ?, ?, 'task_primary', ?, 1, NULL, ?, ?,
       NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 2)`,
    [
      input.id,
      input.task,
      input.connectionId,
      input.providerKind,
      input.modelId,
      input.status,
      input.privacyPolicy,
      input.destination,
      input.currency,
      input.inputTokens,
      input.outputTokens,
      input.costMicros,
      input.errorCode,
      input.errorCode === null ? null : "供应商请求超时",
      input.occurredAt,
      input.occurredAt,
      input.occurredAt,
    ],
  );
}

function readMigration(name: string): string {
  return readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/data/migrations",
      name,
    ),
    "utf8",
  );
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}
