import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

const MIGRATION_DIRECTORY = new URL("../migrations/", import.meta.url);
const STORY_MIGRATION_DIRECTORY = new URL("../../story-core/migrations/", import.meta.url);
const V023_SCHEMA_HEAD = "0064_novel_skill_evaluation_predispatch_authority.sql";

describe("released v0.2.3 continuous database upgrade", () => {
  it("applies every forward migration through 0077 without changing authoritative content", () => {
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
    expect(migrations.at(-1)?.name).toBe("0077_project_display_identities.sql");

    const database = new DatabaseSync(":memory:");
    for (const migration of migrations.slice(0, v023HeadIndex + 1)) {
      database.exec(readFileSync(migration.url, "utf8"));
    }

    const content = "长".repeat(40_936);
    const checksum = createHash("sha256").update(content).digest("hex");
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
         ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      )
      .run(
        "019f9f4a-b3c7-7350-9226-000000000232",
        "019f9f4a-b3c7-7350-9226-000000000231",
        "四万字章节",
        content,
        "019f9f4a-b3c7-7350-9226-000000000233",
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
        content,
        checksum,
        "2026-08-23T00:00:00.000Z",
      );
    database.exec("COMMIT");

    const authorityBefore = authorityDigest(database);
    for (const migration of migrations.slice(v023HeadIndex + 1)) {
      database.exec(readFileSync(migration.url, "utf8"));
    }

    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(authorityDigest(database)).toBe(authorityBefore);
    expect(
      database
        .prepare(
          `SELECT organize_local_story_facts AS organizeLocalStoryFacts
           FROM chapter_versions
           WHERE id = ?`,
        )
        .get("019f9f4a-b3c7-7350-9226-000000000233"),
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

function authorityDigest(database: DatabaseSync): string {
  const authority = Object.freeze({
    project: database.prepare("SELECT id, name, status, revision FROM projects ORDER BY id").all(),
    chapter: database
      .prepare(
        `SELECT id, project_id, title, content, revision, current_version_id
         FROM chapters
         ORDER BY id`,
      )
      .all(),
    version: database
      .prepare(
        `SELECT id, project_id, chapter_id, parent_version_id, sequence, content,
                content_checksum, reason, source_candidate_id, created_at
         FROM chapter_versions
         ORDER BY chapter_id, sequence`,
      )
      .all(),
  });
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}
