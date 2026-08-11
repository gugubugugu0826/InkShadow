import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0060_novel_skill_registry.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-10T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";

describe("novel skill registry migration", () => {
  it("upgrades an existing project database, is idempotent, and creates four content-safe tables", async () => {
    const executor = new NodeSqliteExecutor(coreMigration);
    await insertProject(executor);

    expect(() => executor.database.exec(`${migration}\n${migration}`)).not.toThrow();
    const tables = await executor.select<{ readonly name: string; readonly sql: string }>(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'table' AND name IN (
         'novel_skill_definitions',
         'project_novel_skill_bindings',
         'novel_skill_invocation_snapshots',
         'novel_skill_invocation_items'
       ) ORDER BY name`,
    );

    expect(tables.map(({ name }) => name)).toEqual([
      "novel_skill_definitions",
      "novel_skill_invocation_items",
      "novel_skill_invocation_snapshots",
      "project_novel_skill_bindings",
    ]);
    const snapshotSql = tables.find(({ name }) => name === "novel_skill_invocation_snapshots")?.sql;
    expect(snapshotSql).not.toMatch(
      /credential|chapter_text|story_fact|prompt|response|reasoning/iu,
    );
    await executor.close();
  });

  it("enforces canonical semver, exact owner/kind pairs, active defaults, and the 22-task vocabulary", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
    await insertProject(executor);

    await expect(insertDefinition(executor, { skillId: "core.valid" })).resolves.toMatchObject({
      rowsAffected: 1,
    });
    await expect(insertDefinition(executor, { skillId: "ab" })).rejects.toThrow();
    await expect(insertDefinition(executor, { skillId: "a".repeat(96) })).resolves.toMatchObject({
      rowsAffected: 1,
    });
    await expect(
      insertDefinition(executor, { skillId: "core.leading_zero", version: "01.0.0" }),
    ).rejects.toThrow(/version or task coverage/iu);
    await expect(
      insertDefinition(executor, { skillId: "core.user_owned", ownerScope: "user", kind: "core" }),
    ).rejects.toThrow();
    await expect(
      insertDefinition(executor, {
        skillId: "core.draft_default",
        status: "draft",
        defaultEnabled: 1,
      }),
    ).rejects.toThrow();
    await expect(
      insertDefinition(executor, {
        skillId: "core.unknown_task",
        taskTypes: ["continuation", "unknown_task"],
      }),
    ).rejects.toThrow(/version or task coverage/iu);
    await expect(
      insertDefinition(executor, {
        skillId: "core.duplicate_task",
        taskTypes: ["continuation", "continuation"],
      }),
    ).rejects.toThrow(/version or task coverage/iu);

    await executor.close();
  });

  it("allows only useful scalar task overrides and refuses archived projects", async () => {
    const executor = new NodeSqliteExecutor(`${coreMigration}\n${migration}`);
    await insertProject(executor);
    await insertDefinition(executor, { skillId: "core.binding" });

    await expect(
      insertBinding(executor, {
        taskOverrides: { continuation: { enabled: true, invocationMode: "draft" } },
      }),
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await executor.execute("DELETE FROM project_novel_skill_bindings");
    await expect(
      insertBinding(executor, {
        taskOverrides: { continuation: { enabled: null, invocationMode: null } },
      }),
    ).rejects.toThrow(/bounded scalar fields/iu);
    await expect(
      insertBinding(executor, {
        taskOverrides: { continuation: { enabled: true, prompt: "do not persist" } },
      }),
    ).rejects.toThrow(/bounded scalar fields/iu);
    await expect(
      insertBindingJson(executor, '{"continuation":{"enabled":true,"enabled":false}}'),
    ).rejects.toThrow(/bounded scalar fields/iu);
    await expect(
      insertBinding(executor, {
        taskOverrides: { unknown_task: { enabled: true, invocationMode: "draft" } },
      }),
    ).rejects.toThrow(/known tasks/iu);

    await executor.execute(
      `UPDATE projects SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`,
      [NOW, NOW, PROJECT_ID],
    );
    await expect(insertBinding(executor, { taskOverrides: {} })).rejects.toThrow(
      /active project/iu,
    );
    await executor.close();
  });
});

async function insertProject(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'Novel Skill migration', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [PROJECT_ID, NOW, NOW],
  );
}

function insertDefinition(
  executor: NodeSqliteExecutor,
  options: {
    readonly skillId: string;
    readonly version?: string;
    readonly ownerScope?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly defaultEnabled?: number;
    readonly taskTypes?: readonly string[];
  },
) {
  return executor.execute(
    `INSERT INTO novel_skill_definitions (
       skill_id, version, display_name, summary, kind, owner_scope, status,
       default_enabled, precedence, task_types_json, activation_json,
       context_requirements_json, instructions_json, output_contract_json,
       validation_json, definition_hash, provenance_url, provenance_commit,
       provenance_license, created_at
     ) VALUES (?, ?, 'Test method', 'Original migration fixture', ?, ?, ?, ?, 500,
               ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    [
      options.skillId,
      options.version ?? "1.0.0",
      options.kind ?? "core",
      options.ownerScope ?? "builtin",
      options.status ?? "active",
      options.defaultEnabled ?? 0,
      JSON.stringify(options.taskTypes ?? ["continuation"]),
      JSON.stringify({ allowedModes: ["draft"], genreTags: [], exclusiveGroup: null }),
      JSON.stringify({ requiredLayers: ["current_task"], optionalLayers: [] }),
      JSON.stringify({ rules: [{ ruleId: "test.rule", text: "Original rule." }] }),
      JSON.stringify({ kind: "prose", rules: [] }),
      JSON.stringify({
        rules: [{ ruleId: "test.check", text: "Original check.", evidenceRequired: false }],
      }),
      "a".repeat(64),
      NOW,
    ],
  );
}

function insertBinding(
  executor: NodeSqliteExecutor,
  options: { readonly taskOverrides: Readonly<Record<string, unknown>> },
) {
  return insertBindingJson(executor, JSON.stringify(options.taskOverrides));
}

function insertBindingJson(executor: NodeSqliteExecutor, taskOverridesJson: string) {
  return executor.execute(
    `INSERT INTO project_novel_skill_bindings (
       project_id, skill_id, pinned_version, enabled, activation_mode,
       task_overrides_json, revision, created_at, updated_at
     ) VALUES (?, 'core.binding', '1.0.0', 1, 'smart', ?, 1, ?, ?)`,
    [PROJECT_ID, taskOverridesJson, NOW, NOW],
  );
}
