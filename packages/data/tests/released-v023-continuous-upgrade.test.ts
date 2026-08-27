import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createProjectSeed } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

const MIGRATION_DIRECTORY = new URL("../migrations/", import.meta.url);
const STORY_MIGRATION_DIRECTORY = new URL("../../story-core/migrations/", import.meta.url);
const V023_SCHEMA_HEAD = "0064_novel_skill_evaluation_predispatch_authority.sql";
const PROTECTED_TABLES = [
  "projects",
  "chapters",
  "chapter_versions",
  "recovery_drafts",
  "project_seeds",
  "story_facts",
  "ai_candidates",
  "background_tasks",
  "ai_generation_runs",
] as const;
type ProtectedTable = (typeof PROTECTED_TABLES)[number];
type ProtectedColumns = Readonly<Record<ProtectedTable, readonly string[]>>;

describe("released v0.2.3 continuous database upgrade", () => {
  it("applies every forward migration through 0080 without changing authoritative content", () => {
    const dataMigrationNames = readdirSync(MIGRATION_DIRECTORY)
      .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
      .sort();
    const migrations = [
      ...dataMigrationNames.slice(0, 2).map(dataMigration),
      storyMigration("0001_story_core.sql"),
      ...dataMigrationNames.slice(2, 4).map(dataMigration),
      storyMigration("0002_materials.sql"),
      ...dataMigrationNames.slice(4, 20).map(dataMigration),
      storyMigration("0003_ideation.sql"),
      ...dataMigrationNames.slice(20).map(dataMigration),
    ];
    const v023HeadIndex = migrations.findIndex(({ name }) => name === V023_SCHEMA_HEAD);
    expect(v023HeadIndex).toBeGreaterThanOrEqual(0);
    expect(migrations.at(-1)?.name).toBe("0080_candidate_selection_action.sql");

    const database = new DatabaseSync(":memory:");
    for (const migration of migrations.slice(0, v023HeadIndex + 1)) {
      database.exec(readFileSync(migration.url, "utf8"));
    }

    const content = "长".repeat(40_936);
    const checksum = createHash("sha256").update(content).digest("hex");
    const previousContent = content.slice(0, -1);
    const previousChecksum = createHash("sha256").update(previousContent).digest("hex");
    const candidateContent = "雨停之后，旧城钟摆突然倒转。";
    const candidateChecksum = createHash("sha256").update(candidateContent).digest("hex");
    const projectSeed = createProjectSeed({
      seedId: "professional:v023-continuous-upgrade",
      journeyKind: "professional",
      now: "2026-08-23T00:00:00.000Z",
      premise: "守钟人发现旧城钟摆在雨夜倒转。",
      premiseSource: "professional_setup",
    });
    database.exec("BEGIN");
    database
      .prepare(
        `INSERT INTO projects (id, name, status, revision, deletion_generation, created_at, updated_at)
         VALUES (?, ?, 'active', 1, 0, ?, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000231",
        "v0.2.3 连续升级长篇",
        "2026-08-23T00:00:00.000Z",
        "2026-08-23T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, current_version_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', 2, ?, ?, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000232",
        "019f9f4a-b3c7-7350-9226-000000000231",
        "四万字章节",
        content,
        "019f9f4a-b3c7-7350-9226-000000000234",
        "2026-08-23T00:00:00.000Z",
        "2026-08-23T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000233",
        "019f9f4a-b3c7-7350-9226-000000000231",
        "019f9f4a-b3c7-7350-9226-000000000232",
        previousContent,
        previousChecksum,
        "2026-08-23T00:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, 2, ?, ?, 'manual', NULL, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000234",
        "019f9f4a-b3c7-7350-9226-000000000231",
        "019f9f4a-b3c7-7350-9226-000000000232",
        "019f9f4a-b3c7-7350-9226-000000000233",
        content,
        checksum,
        "2026-08-23T00:01:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO recovery_drafts (
           id, project_id, chapter_id, base_revision, content, cursor_offset, created_at, updated_at
         ) VALUES (?, ?, ?, 2, ?, ?, ?, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000235",
        "019f9f4a-b3c7-7350-9226-000000000231",
        "019f9f4a-b3c7-7350-9226-000000000232",
        `${content}本地恢复尾句。`,
        content.length,
        "2026-08-23T00:02:00.000Z",
        "2026-08-23T00:02:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO ai_candidates (
           id, project_id, chapter_id, source, base_version_id, content, content_checksum,
           status, incomplete, created_at, updated_at, decided_at
         ) VALUES (?, ?, ?, 'generate', ?, ?, ?, 'ready', 0, ?, ?, NULL)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000236",
        "019f9f4a-b3c7-7350-9226-000000000231",
        "019f9f4a-b3c7-7350-9226-000000000232",
        "019f9f4a-b3c7-7350-9226-000000000234",
        candidateContent,
        candidateChecksum,
        "2026-08-23T00:03:00.000Z",
        "2026-08-23T00:03:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO background_tasks (
           id, task_type, idempotency_key, metadata_json, priority, status,
           attempt, max_attempts, sequence, created_at, updated_at, started_at, finished_at
         ) VALUES (?, 'ai.generate', ?, ?, 50, 'succeeded', 1, 1, 1, ?, ?, ?, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000237",
        "v023-generate-task-000000000237",
        JSON.stringify({
          projectId: "019f9f4a-b3c7-7350-9226-000000000231",
          chapterId: "019f9f4a-b3c7-7350-9226-000000000232",
          candidateId: "019f9f4a-b3c7-7350-9226-000000000236",
        }),
        "2026-08-23T00:03:00.000Z",
        "2026-08-23T00:03:30.000Z",
        "2026-08-23T00:03:00.000Z",
        "2026-08-23T00:03:30.000Z",
      );
    database
      .prepare(
        `INSERT INTO ai_generation_runs (
           id, task_id, idempotency_key, project_id, chapter_id, base_version_id,
           provider_id, model_id, state, revision, attempt, input_tokens,
           maximum_output_tokens, estimated_cost_micros, incurred_cost_micros,
           currency, pricing_version, price_updated_at, preflight_json,
           candidate_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'legacy-provider', 'legacy-text-model',
           'candidate_ready', 1, 1, 270, 2048, '100', '100', 'CNY', 'v023', ?, ?, ?, ?, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000238",
        "019f9f4a-b3c7-7350-9226-000000000237",
        "v023-generation-run-000000000238",
        "019f9f4a-b3c7-7350-9226-000000000231",
        "019f9f4a-b3c7-7350-9226-000000000232",
        "019f9f4a-b3c7-7350-9226-000000000234",
        "2026-08-23T00:00:00.000Z",
        JSON.stringify({
          dataScope: ["chapter_current_version"],
          privacyDestination: "legacy-provider",
        }),
        "019f9f4a-b3c7-7350-9226-000000000236",
        "2026-08-23T00:03:00.000Z",
        "2026-08-23T00:03:30.000Z",
      );
    database
      .prepare(
        `INSERT INTO project_seeds (
           project_id, seed_id, journey_kind, schema_version, payload_json,
           revision, created_at, updated_at
         ) VALUES (?, ?, ?, 1, ?, 1, ?, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000231",
        projectSeed.seedId,
        projectSeed.journeyKind,
        JSON.stringify(projectSeed),
        projectSeed.createdAt,
        projectSeed.updatedAt,
      );
    database
      .prepare(
        `INSERT INTO story_facts (
           id, project_id, fact_type, content_text, value_json, source_kind,
           evidence_reference, source_chapter_id, source_version_id,
           source_start_offset, source_end_offset, source_length, source_excerpt,
           effective_at, invalidated_at, branch_id, confidence, status, origin,
           user_confirmed, locked, deprecated, needs_review, confirmed_by_actor_id,
           confirmed_at, revision, created_at, updated_at
         ) VALUES (?, ?, 'world_rule', ?, NULL, 'user_statement', ?,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           1, 'formal', 'user', 1, 1, 0, 0, 'local-author', ?, 1, ?, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000239",
        "019f9f4a-b3c7-7350-9226-000000000231",
        "旧城钟摆只能在雨夜倒转。",
        "user-statement:v023-world-rule",
        "2026-08-23T00:04:00.000Z",
        "2026-08-23T00:04:00.000Z",
        "2026-08-23T00:04:00.000Z",
      );
    database.exec("COMMIT");

    const protectedColumns = captureProtectedColumns(database);
    const summaryBefore = protectedDataSummary(database, protectedColumns);
    expect(summaryBefore).toMatchObject({
      projects: { rowCount: 1 },
      chapters: { rowCount: 1 },
      chapter_versions: { rowCount: 2 },
      recovery_drafts: { rowCount: 1 },
      project_seeds: { rowCount: 1 },
      story_facts: { rowCount: 1 },
      ai_candidates: { rowCount: 1 },
      background_tasks: { rowCount: 1 },
      ai_generation_runs: { rowCount: 1 },
    });
    for (const migration of migrations.slice(v023HeadIndex + 1)) {
      database.exec(readFileSync(migration.url, "utf8"));
    }

    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(protectedDataSummary(database, protectedColumns)).toEqual(summaryBefore);
    expect(
      database
        .prepare(
          `SELECT organize_local_story_facts AS organizeLocalStoryFacts
           FROM chapter_versions
           WHERE id = ?`,
        )
        .get("019f9f4a-b3c7-7350-9226-000000000234"),
    ).toEqual({ organizeLocalStoryFacts: 0 });

    database.close();
  });
});

function dataMigration(name: string): Readonly<{ name: string; url: URL }> {
  return Object.freeze({ name, url: new URL(name, MIGRATION_DIRECTORY) });
}

function storyMigration(name: string): Readonly<{ name: string; url: URL }> {
  return Object.freeze({ name, url: new URL(name, STORY_MIGRATION_DIRECTORY) });
}

function captureProtectedColumns(database: DatabaseSync): ProtectedColumns {
  return Object.fromEntries(
    PROTECTED_TABLES.map((table) => {
      const columns = database
        .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all()
        .map((row) => {
          const name = (row as Readonly<Record<string, unknown>>).name;
          if (typeof name !== "string") throw new Error(`无法读取 ${table} 的字段。`);
          return name;
        });
      return [table, Object.freeze(columns)] as const;
    }),
  ) as ProtectedColumns;
}

function protectedDataSummary(database: DatabaseSync, columns: ProtectedColumns) {
  return Object.freeze(
    Object.fromEntries(
      PROTECTED_TABLES.map((table) => {
        const tableColumns = columns[table];
        const projection = tableColumns.map(quoteIdentifier).join(", ");
        const orderColumn = tableColumns[0];
        if (orderColumn === undefined) throw new Error(`${table} 没有可读取字段。`);
        const rows = database
          .prepare(
            `SELECT ${projection} FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier(orderColumn)}`,
          )
          .all();
        return [
          table,
          Object.freeze({
            rowCount: rows.length,
            sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
          }),
        ] as const;
      }),
    ),
  ) as Readonly<Record<ProtectedTable, Readonly<{ rowCount: number; sha256: string }>>>;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
