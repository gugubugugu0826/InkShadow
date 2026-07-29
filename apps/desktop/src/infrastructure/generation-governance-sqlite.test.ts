import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { runGenerationPreflight } from "@inkshadow/ai-core";
import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { TauriGenerationGovernanceStore } from "./generation-governance-store";
import { TauriModelCenterStore } from "./model-center-store";
import { TauriTaskCenterStore } from "./task-center-store";

const migration = [
  readMigration("0001_core.sql"),
  readMigration("0002_tasks_notifications.sql"),
  readMigration("0004_model_profiles.sql"),
  readMigration("0005_ai_generation_governance.sql"),
  readMigration("0007_model_routing_usage.sql"),
].join("\n");

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);
const TASK_ID = uuid(4);
const RUN_ID = uuid(5);
const CANDIDATE_ID = uuid(7);
const DEFERRED_TASK_ID = uuid(8);
const DEFERRED_REQUEST_ID = uuid(9);
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };

describe("SQLite generation governance stores", () => {
  it("persists joined model pricing, budgets, task identity, and run provenance", async () => {
    const executor = new NodeSqliteExecutor(migration);
    await seedChapter(executor);
    const models = new TauriModelCenterStore(executor, clock);
    const tasks = new TauriTaskCenterStore(executor, clock);
    const governance = new TauriGenerationGovernanceStore(executor, clock);

    await models.save({
      providerId: "openai",
      provider: "open_ai_compatible",
      baseUrl: "https://api.openai.com/v1",
      authentication: "bearer_keyring",
      selectedModel: "gpt-test",
      pricing: {
        contextWindowTokens: 16_000,
        currency: "USD",
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        cachedInputMicrosPerMillionTokens: null,
        pricingVersion: "2026-07",
        priceUpdatedAt: NOW,
      },
      expectedRevision: null,
    });
    await expect(models.listProfiles()).resolves.toMatchObject([
      {
        selectedModel: "gpt-test",
        pricing: {
          contextWindowTokens: 16_000,
          currency: "USD",
          pricingVersion: "2026-07",
        },
      },
    ]);

    const idempotencyKey = `ai.generate:${CHAPTER_ID}:${VERSION_ID}`;
    await tasks.enqueueTask({
      id: TASK_ID,
      type: "ai.generate",
      idempotencyKey,
      metadata: {
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        operation: "generate",
      },
      priority: 80,
      maxAttempts: 3,
      now: NOW,
    });
    await governance.saveBudgetPolicy({
      scope: "project",
      projectId: PROJECT_ID,
      monthKey: null,
      currency: "USD",
      limitMicros: "10000",
      enforcement: "hard",
      expectedRevision: null,
    });
    const preflight = runGenerationPreflight({
      now: NOW,
      migrationReady: true,
      chapterExists: true,
      chapterSaved: true,
      projectWritable: true,
      gatewayAvailable: true,
      networkAvailable: true,
      providerLocation: "remote",
      profileConfigured: true,
      modelSelected: true,
      credentialConfigured: true,
      connectionStatus: "verified",
      selectedModelAvailable: true,
      inputBytes: 12_000,
      maximumInputBytes: 1_000_000,
      inputTokens: 4_000,
      maximumOutputTokens: 2_000,
      contextWindowTokens: 16_000,
      pricing: {
        currency: "USD",
        pricingVersion: "2026-07",
        updatedAt: NOW,
        inputMicrosPerMillionTokens: 1_000_000n,
        outputMicrosPerMillionTokens: 2_000_000n,
      },
      budgets: [],
    });
    await expect(
      governance.createRun({
        id: RUN_ID,
        taskId: TASK_ID,
        idempotencyKey,
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        baseVersionId: VERSION_ID,
        providerId: "openai",
        modelId: "gpt-test",
        route: {
          role: "high_quality",
          reason: "role_primary",
          fallbackProviderId: "local-ollama",
          fallbackModelId: "qwen-test",
        },
        preflight,
      }),
    ).resolves.toMatchObject({
      created: true,
      run: {
        state: "queued",
        estimatedCostMicros: "8000",
        preflight: { codes: ["READY"] },
        route: {
          role: "high_quality",
          reason: "role_primary",
          fallbackProviderId: "local-ollama",
          fallbackModelId: "qwen-test",
        },
      },
    });
    await expect(governance.getBudgetLimits(PROJECT_ID, "2026-07", "USD")).resolves.toEqual([
      {
        scope: "project",
        limitMicros: 10_000n,
        spentMicros: 8_000n,
        enforcement: "hard",
      },
    ]);

    let run = await governance.findRunById(RUN_ID);
    if (run === null) {
      throw new Error("Expected the generation run.");
    }
    for (const state of ["retrieving", "generating", "validating"] as const) {
      run = await governance.transitionRun({
        runId: RUN_ID,
        expectedRevision: run.revision,
        state,
      });
    }
    await executor.execute(
      `INSERT INTO ai_candidates (
         id, project_id, chapter_id, source, base_version_id, content,
         content_checksum, status, incomplete, created_at, updated_at
       ) VALUES (?, ?, ?, 'generate', ?, 'Candidate', ?, 'ready', 0, ?, ?)`,
      [CANDIDATE_ID, PROJECT_ID, CHAPTER_ID, VERSION_ID, "b".repeat(64), NOW, NOW],
    );
    run = await governance.transitionRun({
      runId: RUN_ID,
      expectedRevision: run.revision,
      state: "candidate_ready",
      candidateId: CANDIDATE_ID,
      addIncurredCost: true,
      attemptUsage: {
        source: "provider_reported",
        inputTokens: 3_900,
        outputTokens: 900,
        cachedInputTokens: 400,
        usagePricedEstimateMicros: "5700",
      },
    });
    await expect(governance.listAttemptUsage(RUN_ID)).resolves.toEqual([
      expect.objectContaining({
        runId: RUN_ID,
        attempt: 1,
        source: "provider_reported",
        inputTokens: 3_900,
        outputTokens: 900,
        cachedInputTokens: 400,
        usagePricedEstimateMicros: "5700",
        pricingVersion: "2026-07",
      }),
    ]);
    await governance.transitionRun({
      runId: RUN_ID,
      expectedRevision: run.revision,
      state: "completed",
    });

    const offlinePreflight = runGenerationPreflight({
      now: NOW,
      migrationReady: true,
      chapterExists: true,
      chapterSaved: true,
      projectWritable: true,
      gatewayAvailable: true,
      networkAvailable: false,
      providerLocation: "remote",
      profileConfigured: true,
      modelSelected: true,
      credentialConfigured: true,
      connectionStatus: "not_checked",
      selectedModelAvailable: true,
      inputBytes: 12_000,
      maximumInputBytes: 1_000_000,
      inputTokens: 4_000,
      maximumOutputTokens: 2_000,
      contextWindowTokens: 16_000,
      pricing: {
        currency: "USD",
        pricingVersion: "2026-07",
        updatedAt: NOW,
        inputMicrosPerMillionTokens: 1_000_000n,
        outputMicrosPerMillionTokens: 2_000_000n,
      },
      budgets: [],
    });
    await tasks.enqueueTask({
      id: DEFERRED_TASK_ID,
      type: "ai.generate.deferred",
      idempotencyKey: `ai.generate.deferred:${CHAPTER_ID}:${VERSION_ID}:high_quality`,
      metadata: {
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        baseVersionId: VERSION_ID,
        providerId: "openai",
        operation: "generate",
      },
      priority: 80,
      maxAttempts: 1,
      runAfter: "9999-12-31T23:59:59.999Z",
      now: NOW,
    });
    const deferred = await governance.createDeferredRequest({
      id: DEFERRED_REQUEST_ID,
      taskId: DEFERRED_TASK_ID,
      idempotencyKey: `ai.generate.deferred:${CHAPTER_ID}:${VERSION_ID}:high_quality`,
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      baseVersionId: VERSION_ID,
      modelRole: "high_quality",
      providerId: "openai",
      modelId: "gpt-test",
      maximumOutputTokens: 2_000,
      preflight: offlinePreflight,
    });
    expect(deferred).toMatchObject({
      created: true,
      request: {
        status: "waiting_network",
        approvedInputTokens: 4_000,
        approvedEstimateMicros: "8000",
      },
    });
    await expect(
      governance.transitionDeferredRequest({
        id: DEFERRED_REQUEST_ID,
        expectedRevision: deferred.request.revision,
        status: "consumed",
        consumedRunId: RUN_ID,
      }),
    ).resolves.toMatchObject({
      status: "consumed",
      consumedRunId: RUN_ID,
    });

    await tasks.publishNotification({
      id: uuid(6),
      dedupeKey: `notification:${TASK_ID}:completed`,
      messageKey: "task.completed",
      level: "inbox",
      severity: "success",
      route: { entityType: "task", entityId: TASK_ID },
      metadata: { taskType: "ai.generate", attempt: 1 },
      requiresResolution: false,
      expiresAt: null,
      now: NOW,
    });
    await expect(tasks.load()).resolves.toMatchObject({
      notifications: [{ messageKey: "task.completed", status: "visible" }],
    });

    const columns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('ai_generation_runs') ORDER BY cid",
    );
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["content", "prompt", "messages", "secret"]),
    );
    const deferredColumns = await executor.select<{ name: string }>(
      "SELECT name FROM pragma_table_info('ai_deferred_generation_requests') ORDER BY cid",
    );
    expect(deferredColumns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["content", "prompt", "messages", "secret"]),
    );
    await executor.close();
  });
});

async function seedChapter(executor: NodeSqliteExecutor): Promise<void> {
  await executor.transaction(async (transaction) => {
    await transaction.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Project', ?, ?)",
      [PROJECT_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, current_version_id, created_at, updated_at
       ) VALUES (?, ?, 'Chapter', '', ?, ?, ?)`,
      [CHAPTER_ID, PROJECT_ID, VERSION_ID, NOW, NOW],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, sequence, content, content_checksum,
         reason, created_at
       ) VALUES (?, ?, ?, 1, '', ?, 'created', ?)`,
      [VERSION_ID, PROJECT_ID, CHAPTER_ID, "a".repeat(64), NOW],
    );
  });
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}
