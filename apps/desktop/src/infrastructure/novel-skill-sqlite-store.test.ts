import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  compileNovelSkills,
  createCoreNovelSkillDefinitions,
  type CompiledNovelSkills,
  type ProjectNovelSkillBinding,
} from "@inkshadow/ai-core";
import { afterEach, describe, expect } from "vitest";

import {
  NovelSkillSqliteStore,
  type CommitNovelSkillInvocationInput,
} from "./novel-skill-sqlite-store.js";
import {
  fileSqliteIt,
  NodeSqliteExecutor,
} from "../../../../packages/data/tests/node-sqlite-executor.js";

const migration = [
  "0001_core.sql",
  "0004_model_profiles.sql",
  "0005_ai_generation_governance.sql",
  "0007_model_routing_usage.sql",
  "0031_model_hub.sql",
  "0034_context_compilation_trace.sql",
  "0037_model_hub_expert_options.sql",
  "0046_model_hub_zhipu_glm.sql",
  "0047_context_compilation_exact_provenance.sql",
  "0056_model_hub_failure_diagnostics.sql",
  "0057_model_hub_content_quality_task.sql",
  "0059_generation_preflight_cost_status.sql",
  "0060_novel_skill_registry.sql",
]
  .map((file) =>
    readFileSync(path.join(repositoryRoot(), "packages/data/migrations", file), "utf8"),
  )
  .join("\n");

const NOW = "2026-08-10T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const SNAPSHOT_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const MODEL_INVOCATION_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const TRACE_ID = "novel-skill-store-trace";

const openExecutors = new Set<NodeSqliteExecutor>();
const databaseDirectories = new Set<string>();

afterEach(async () => {
  await closeOpenExecutors();
  removeDatabaseDirectories();
});

function repositoryRoot(): string {
  return existsSync(path.join(process.cwd(), "packages/data/migrations"))
    ? process.cwd()
    : path.resolve(process.cwd(), "../..");
}

function createDatabasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "inkshadow-novel-skill-"));
  databaseDirectories.add(directory);
  return path.join(directory, "store.db");
}

function createExecutor(migrationSql: string, databasePath = ":memory:"): NodeSqliteExecutor {
  const executor = new NodeSqliteExecutor(migrationSql, databasePath);
  openExecutors.add(executor);
  return executor;
}

async function closeExecutor(executor: NodeSqliteExecutor): Promise<void> {
  if (!openExecutors.has(executor)) {
    return;
  }
  await executor.close();
  openExecutors.delete(executor);
}

async function closeOpenExecutors(): Promise<void> {
  const executors = [...openExecutors];
  const results = await Promise.allSettled(executors.map((executor) => closeExecutor(executor)));
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(({ reason }) => reason as unknown);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close Novel Skill SQLite test executors.");
  }
}

function removeDatabaseDirectories(): void {
  for (const directory of databaseDirectories) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  databaseDirectories.clear();
}

describe("NovelSkillSqliteStore", () => {
  fileSqliteIt(
    "fails closed before dispatch, persists exact linkage, and survives restart",
    async () => {
      const databasePath = createDatabasePath();
      let executor: NodeSqliteExecutor | undefined;
      let reopened: NodeSqliteExecutor | undefined;
      try {
        executor = createExecutor(migration, databasePath);
        await insertFoundation(executor);
        const store = new NovelSkillSqliteStore(executor);
        const definitions = await createCoreNovelSkillDefinitions();
        const scene = definitions.find(({ skillId }) => skillId === "core.scene_craft");
        expect(scene).toBeDefined();
        if (scene === undefined) {
          throw new Error("scene fixture missing");
        }
        await store.insertDefinition(scene);
        const binding = bindingFor(scene.version);
        await expect(store.saveBinding(binding, 0)).resolves.toMatchObject({ revision: 1 });
        const compiled = await compileNovelSkills({
          projectId: PROJECT_ID,
          taskType: "continuation",
          invocationMode: "draft",
          maximumSkillTokens: 2_000,
          genreTags: [],
          explicitSkillIds: [scene.skillId],
          availableContextLayers: ["current_task", "scene_goal"],
          allowExperimental: true,
          definitions: [scene],
          bindings: [binding],
        });
        const input = invocationInput(compiled);
        let dispatchCount = 0;

        await expect(
          store.snapshotThenDispatch(input, () => {
            dispatchCount += 1;
            return Promise.resolve("dispatched");
          }),
        ).rejects.toMatchObject({ code: "NOVEL_SKILL_TRACE_LINK_MISSING" });
        expect(dispatchCount).toBe(0);
        await expect(
          executor.select<{ readonly count: number }>(
            "SELECT count(*) AS count FROM novel_skill_invocation_snapshots",
          ),
        ).resolves.toEqual([{ count: 0 }]);

        await insertExactModelLink(executor);
        await expect(
          store.snapshotThenDispatch(input, (snapshot) => {
            dispatchCount += 1;
            expect(snapshot.contextTraceId).toBe(TRACE_ID);
            expect(snapshot.modelInvocationId).toBe(MODEL_INVOCATION_ID);
            return Promise.resolve("dispatched");
          }),
        ).resolves.toBe("dispatched");
        expect(dispatchCount).toBe(1);
        await closeExecutor(executor);
        executor = undefined;

        reopened = createExecutor("", databasePath);
        const reopenedStore = new NovelSkillSqliteStore(reopened);
        await expect(reopenedStore.findInvocationSnapshot(SNAPSHOT_ID)).resolves.toMatchObject({
          id: SNAPSHOT_ID,
          contextTraceId: TRACE_ID,
          modelInvocationId: MODEL_INVOCATION_ID,
          selectionHash: compiled.selectionHash,
          items: [{ skillId: scene.skillId, included: true }],
        });
        await expect(
          reopenedStore.findInvocationSnapshotByContextTrace(TRACE_ID),
        ).resolves.toMatchObject({
          id: SNAPSHOT_ID,
          contextTraceId: TRACE_ID,
          items: [{ skillId: scene.skillId, included: true }],
        });
        await expect(
          reopened.execute(
            "UPDATE novel_skill_definitions SET summary = 'mutated' WHERE skill_id = ?",
            [scene.skillId],
          ),
        ).rejects.toThrow(/immutable/iu);
        await expect(
          reopened.execute(
            `INSERT INTO novel_skill_invocation_items (
             snapshot_id, item_order, skill_id, skill_version, definition_hash,
             activation_source, selection_reason, precedence, included,
             discarded_reason, estimated_tokens
           ) VALUES (?, 2, ?, ?, ?, 'explicit', 'selected', 500, 1, NULL, 1)`,
            [SNAPSHOT_ID, scene.skillId, scene.version, "f".repeat(64)],
          ),
        ).rejects.toThrow();
      } finally {
        if (reopened !== undefined) {
          await closeExecutor(reopened);
        }
        if (executor !== undefined) {
          await closeExecutor(executor);
        }
      }
    },
  );

  fileSqliteIt(
    "rejects missing or sensitive replay fields before any snapshot is saved",
    async () => {
      const executor = createExecutor(migration);
      await insertFoundation(executor);
      await insertExactModelLink(executor);
      const store = new NovelSkillSqliteStore(executor);
      const scene = (await createCoreNovelSkillDefinitions()).find(
        ({ skillId }) => skillId === "core.scene_craft",
      );
      if (scene === undefined) {
        throw new Error("scene fixture missing");
      }
      await store.insertDefinition(scene);
      const binding = bindingFor(scene.version);
      await store.saveBinding(binding, 0);
      const compiled = await compileNovelSkills({
        projectId: PROJECT_ID,
        taskType: "continuation",
        invocationMode: "draft",
        maximumSkillTokens: 2_000,
        genreTags: [],
        explicitSkillIds: [scene.skillId],
        availableContextLayers: ["current_task"],
        allowExperimental: true,
        definitions: [scene],
        bindings: [binding],
      });

      for (const field of [
        "schemaVersion",
        "compilerVersion",
        "taskType",
        "invocationMode",
        "maximumSkillTokens",
      ] as const) {
        const configuration = Object.fromEntries(
          Object.entries(compiled.configuration).filter(([key]) => key !== field),
        );
        await expect(insertRawSnapshot(executor, configuration, compiled)).rejects.toThrow(
          /configuration/iu,
        );
      }
      await expect(
        insertRawSnapshot(
          executor,
          { ...compiled.configuration, prompt: "chapter content must never be stored" },
          compiled,
        ),
      ).rejects.toThrow(/content-free|configuration/iu);
      await expect(
        executor.select<{ readonly count: number }>(
          "SELECT count(*) AS count FROM novel_skill_invocation_snapshots",
        ),
      ).resolves.toEqual([{ count: 0 }]);
      await closeExecutor(executor);
    },
  );

  fileSqliteIt(
    "normalizes invalid typed input and stored JSON corruption without dispatching",
    async () => {
      const executor = createExecutor(migration);
      await insertFoundation(executor);
      await insertExactModelLink(executor);
      const store = new NovelSkillSqliteStore(executor);
      const scene = (await createCoreNovelSkillDefinitions()).find(
        ({ skillId }) => skillId === "core.scene_craft",
      );
      if (scene === undefined) {
        throw new Error("scene fixture missing");
      }
      await store.insertDefinition(scene);
      const binding = bindingFor(scene.version);
      await store.saveBinding(binding, 0);
      const compiled = await compileNovelSkills({
        projectId: PROJECT_ID,
        taskType: "continuation",
        invocationMode: "draft",
        maximumSkillTokens: 2_000,
        genreTags: [],
        explicitSkillIds: [scene.skillId],
        availableContextLayers: ["current_task"],
        allowExperimental: true,
        definitions: [scene],
        bindings: [binding],
      });
      const invalidCompiled = {
        ...compiled,
        items: compiled.items.map((item) => ({ ...item, activationSource: "invalid_source" })),
      } as unknown as CompiledNovelSkills;
      let dispatched = false;
      await expect(
        store.snapshotThenDispatch(invocationInput(invalidCompiled), () => {
          dispatched = true;
          return Promise.resolve();
        }),
      ).rejects.toMatchObject({ code: "NOVEL_SKILL_STORE_INVALID" });
      expect(dispatched).toBe(false);

      await store.commitInvocationBeforeDispatch(invocationInput(compiled));
      executor.database.exec("DROP TRIGGER novel_skill_invocation_immutable");
      await executor.execute(
        "UPDATE novel_skill_invocation_snapshots SET configuration_snapshot_json = '{}' WHERE id = ?",
        [SNAPSHOT_ID],
      );
      await expect(store.findInvocationSnapshot(SNAPSHOT_ID)).rejects.toMatchObject({
        code: "NOVEL_SKILL_STORE_CORRUPT",
      });
      await closeExecutor(executor);
    },
  );

  fileSqliteIt(
    "replays immutable definitions and the exact binding revision before dispatch",
    async () => {
      const executor = createExecutor(migration);
      try {
        await insertFoundation(executor);
        await insertExactModelLink(executor);
        const store = new NovelSkillSqliteStore(executor);
        const scene = (await createCoreNovelSkillDefinitions()).find(
          ({ skillId }) => skillId === "core.scene_craft",
        );
        if (scene === undefined) {
          throw new Error("scene fixture missing");
        }
        await expect(store.insertDefinition({ ...scene, skillId: "ab" })).rejects.toMatchObject({
          code: "NOVEL_SKILL_STORE_INVALID",
        });
        await expect(store.findDefinition("ab", "1.0.0")).rejects.toMatchObject({
          code: "NOVEL_SKILL_STORE_INVALID",
        });
        await store.insertDefinition(scene);
        const binding = bindingFor(scene.version);
        await store.saveBinding(binding, 0);
        const compiled = await compileNovelSkills({
          projectId: PROJECT_ID,
          taskType: "continuation",
          invocationMode: "draft",
          maximumSkillTokens: 2_000,
          genreTags: [],
          explicitSkillIds: [scene.skillId],
          availableContextLayers: ["current_task", "scene_goal"],
          allowExperimental: true,
          definitions: [scene],
          bindings: [binding],
        });
        const tampered = {
          ...compiled,
          outputKinds: ["analysis"],
        } as unknown as CompiledNovelSkills;

        await expect(
          store.commitInvocationBeforeDispatch(invocationInput(tampered)),
        ).rejects.toMatchObject({ code: "NOVEL_SKILL_STORE_INVALID" });
        await expect(
          executor.select<{ readonly count: number }>(
            "SELECT count(*) AS count FROM novel_skill_invocation_snapshots",
          ),
        ).resolves.toEqual([{ count: 0 }]);

        await store.saveBinding(
          {
            ...binding,
            enabled: false,
            revision: 2,
            updatedAt: "2026-08-10T00:00:01.000Z",
          },
          1,
        );
        await expect(
          store.commitInvocationBeforeDispatch(invocationInput(compiled)),
        ).rejects.toMatchObject({ code: "NOVEL_SKILL_STORE_INVALID" });
      } finally {
        await closeExecutor(executor);
      }
    },
  );

  fileSqliteIt(
    "recomputes snapshot hash, token totals, counts, and item membership on read",
    async () => {
      const executor = createExecutor(migration);
      try {
        await insertFoundation(executor);
        await insertExactModelLink(executor);
        const store = new NovelSkillSqliteStore(executor);
        const definitions = await createCoreNovelSkillDefinitions();
        const scene = definitions.find(({ skillId }) => skillId === "core.scene_craft");
        const pov = definitions.find(({ skillId }) => skillId === "core.pov_knowledge");
        if (scene === undefined || pov === undefined) {
          throw new Error("definition fixture missing");
        }
        await store.insertDefinition(scene);
        await store.insertDefinition(pov);
        const binding = bindingFor(scene.version);
        await store.saveBinding(binding, 0);
        const compiled = await compileNovelSkills({
          projectId: PROJECT_ID,
          taskType: "continuation",
          invocationMode: "draft",
          maximumSkillTokens: 2_000,
          genreTags: [],
          explicitSkillIds: [scene.skillId],
          availableContextLayers: ["current_task", "scene_goal"],
          allowExperimental: true,
          definitions: [scene],
          bindings: [binding],
        });
        await store.commitInvocationBeforeDispatch(invocationInput(compiled));
        executor.database.exec("DROP TRIGGER novel_skill_invocation_immutable");
        executor.database.exec("DROP TRIGGER novel_skill_invocation_item_immutable");

        await executor.execute(
          "UPDATE novel_skill_invocation_snapshots SET selection_hash = ? WHERE id = ?",
          ["f".repeat(64), SNAPSHOT_ID],
        );
        await expect(store.findInvocationSnapshot(SNAPSHOT_ID)).rejects.toMatchObject({
          code: "NOVEL_SKILL_STORE_CORRUPT",
        });
        await executor.execute(
          "UPDATE novel_skill_invocation_snapshots SET selection_hash = ? WHERE id = ?",
          [compiled.selectionHash, SNAPSHOT_ID],
        );

        await executor.execute(
          "UPDATE novel_skill_invocation_snapshots SET used_skill_tokens = ? WHERE id = ?",
          [compiled.usedSkillTokens + 1, SNAPSHOT_ID],
        );
        await expect(store.findInvocationSnapshot(SNAPSHOT_ID)).rejects.toMatchObject({
          code: "NOVEL_SKILL_STORE_CORRUPT",
        });
        await executor.execute(
          "UPDATE novel_skill_invocation_snapshots SET used_skill_tokens = ? WHERE id = ?",
          [compiled.usedSkillTokens, SNAPSHOT_ID],
        );

        await executor.execute(
          `UPDATE novel_skill_invocation_snapshots
           SET candidate_count = 2, included_count = 1, discarded_count = 1
           WHERE id = ?`,
          [SNAPSHOT_ID],
        );
        await expect(store.findInvocationSnapshot(SNAPSHOT_ID)).rejects.toMatchObject({
          code: "NOVEL_SKILL_STORE_CORRUPT",
        });
        await executor.execute(
          `UPDATE novel_skill_invocation_snapshots
           SET candidate_count = 1, included_count = 1, discarded_count = 0
           WHERE id = ?`,
          [SNAPSHOT_ID],
        );

        await executor.execute(
          `UPDATE novel_skill_invocation_items
           SET skill_id = ?, skill_version = ?, definition_hash = ?
           WHERE snapshot_id = ?`,
          [pov.skillId, pov.version, pov.definitionHash, SNAPSHOT_ID],
        );
        await expect(store.findInvocationSnapshot(SNAPSHOT_ID)).rejects.toMatchObject({
          code: "NOVEL_SKILL_STORE_CORRUPT",
        });
      } finally {
        await closeExecutor(executor);
      }
    },
  );

  fileSqliteIt("rejects bindings for an archived project at the store seam", async () => {
    const executor = createExecutor(migration);
    await insertFoundation(executor);
    const store = new NovelSkillSqliteStore(executor);
    const scene = (await createCoreNovelSkillDefinitions()).find(
      ({ skillId }) => skillId === "core.scene_craft",
    );
    if (scene === undefined) {
      throw new Error("scene fixture missing");
    }
    await store.insertDefinition(scene);
    await executor.execute(
      `UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`,
      [NOW, NOW, PROJECT_ID],
    );

    await expect(store.saveBinding(bindingFor(scene.version), 0)).rejects.toMatchObject({
      code: "NOVEL_SKILL_STORE_INVALID",
    });
    await closeExecutor(executor);
  });
});

function bindingFor(version: string): ProjectNovelSkillBinding {
  return {
    projectId: PROJECT_ID,
    skillId: "core.scene_craft",
    pinnedVersion: version,
    enabled: true,
    activationMode: "manual",
    taskOverrides: {},
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function invocationInput(compiled: CompiledNovelSkills): CommitNovelSkillInvocationInput {
  return {
    snapshotId: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    contextTraceId: TRACE_ID,
    modelInvocationId: MODEL_INVOCATION_ID,
    taskType: "continuation",
    invocationMode: "draft",
    compiled,
    createdAt: NOW,
  };
}

async function insertFoundation(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'Novel Skill store', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [PROJECT_ID, NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO model_provider_connections (
       id, provider_kind, display_name, protocol, base_url,
       credential_state, connection_status, catalog_sync_status, created_at, updated_at
     ) VALUES ('skill-provider', 'openai', 'Skill provider', 'openai_compatible',
               'https://example.test/v1', 'missing', 'not_tested', 'never', ?, ?)`,
    [NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO model_catalog_entries (
       id, connection_id, provider_model_id, display_name, catalog_source,
       availability, lifecycle, first_discovered_at, last_seen_at, last_sync_id
     ) VALUES ('skill-model', 'skill-provider', 'writer', 'Writer', 'manual',
               'available', 'unknown', ?, ?, NULL)`,
    [NOW, NOW],
  );
  await executor.execute(
    `INSERT INTO model_invocation_facts (
       id, task, connection_id, catalog_entry_id, provider_kind_snapshot,
       model_id_snapshot, route_reason, status, attempt, privacy_policy,
       data_destination, created_at
     ) VALUES (?, 'continuation', 'skill-provider', 'skill-model', 'openai',
               'writer', 'user_override', 'queued', 1, 'cloud_allowed', 'remote', ?)`,
    [MODEL_INVOCATION_ID, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_runs (
       id, project_id, chapter_id, task_type, maximum_context_tokens,
       required_tokens, used_tokens, remaining_tokens, discarded_tokens,
       token_estimate_source, candidate_count, included_count, discarded_count,
       created_at
     ) VALUES (?, ?, NULL, 'continuation', 1000, 1, 1, 999, 0,
               'utf8_conservative', 1, 1, 0, ?)`,
    [TRACE_ID, PROJECT_ID, NOW],
  );
  await executor.execute(
    `INSERT INTO context_compilation_entries (
       run_id, candidate_id, layer, selection_reason, included,
       discarded_reason, estimated_tokens, evaluation_order, layer_order,
       priority, relevance_score, required, budget_remaining_before,
       budget_remaining_after
     ) VALUES (?, 'task', 'current_task', 'Current task is always required.',
               1, NULL, 1, 1, 2, 100, 1, 1, 1000, 999)`,
    [TRACE_ID],
  );
  await executor.execute(
    `INSERT INTO context_compilation_execution_links (
       trace_id, generation_id, generation_run_id, created_at
     ) VALUES (?, '019f9f4a-b3c7-7350-9226-000000000103', NULL, ?)`,
    [TRACE_ID, NOW],
  );
}

async function insertExactModelLink(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO context_compilation_model_invocation_links (
       trace_id, model_invocation_id, linked_at
     ) VALUES (?, ?, ?)`,
    [TRACE_ID, MODEL_INVOCATION_ID, NOW],
  );
}

function insertRawSnapshot(
  executor: NodeSqliteExecutor,
  configuration: Readonly<Record<string, unknown>>,
  compiled: CompiledNovelSkills,
) {
  return executor.execute(
    `INSERT INTO novel_skill_invocation_snapshots (
       id, project_id, context_trace_id, model_invocation_id, task_type,
       invocation_mode, compiler_version, maximum_skill_tokens,
       used_skill_tokens, discarded_skill_tokens, candidate_count,
       included_count, discarded_count, selection_hash,
       configuration_snapshot_json, created_at
     ) VALUES (?, ?, ?, ?, 'continuation', 'draft', ?, 2000,
               0, 0, 0, 0, 0, ?, ?, ?)`,
    [
      SNAPSHOT_ID,
      PROJECT_ID,
      TRACE_ID,
      MODEL_INVOCATION_ID,
      compiled.compilerVersion,
      compiled.selectionHash,
      JSON.stringify(configuration),
      NOW,
    ],
  );
}
