import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const core = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const responsibility = readFileSync(
  new URL("../migrations/0074_chapter_version_story_fact_responsibility.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-08-22T00:00:00.000Z";

describe("0074 chapter version story-fact responsibility migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(core);
    database.exec("BEGIN");
    database
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("project-1", "责任迁移", NOW, NOW);
    database
      .prepare(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, current_version_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      )
      .run("chapter-1", "project-1", "第一章", "旧正文", "version-1", NOW, NOW);
    database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
      )
      .run("version-1", "project-1", "chapter-1", "旧正文", "a".repeat(64), NOW);
    database.exec("COMMIT");
  });

  afterEach(() => {
    database.close();
  });

  it("defaults legacy rows to false and keeps every recorded responsibility immutable", () => {
    database.exec(responsibility);

    expect(
      database
        .prepare("SELECT organize_local_story_facts AS value FROM chapter_versions WHERE id = ?")
        .get("version-1"),
    ).toEqual({ value: 0 });

    database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at,
           organize_local_story_facts
         ) VALUES (?, ?, ?, ?, 2, ?, ?, 'manual', NULL, ?, 1)`,
      )
      .run("version-2", "project-1", "chapter-1", "version-1", "直接写作正文", "b".repeat(64), NOW);
    expect(
      database
        .prepare("SELECT organize_local_story_facts AS value FROM chapter_versions WHERE id = ?")
        .get("version-2"),
    ).toEqual({ value: 1 });

    expect(() =>
      database
        .prepare("UPDATE chapter_versions SET organize_local_story_facts = 0 WHERE id = ?")
        .run("version-2"),
    ).toThrow(/CHAPTER_VERSION_STORY_FACT_RESPONSIBILITY_IMMUTABLE/u);
    expect(() =>
      database
        .prepare("UPDATE chapter_versions SET organize_local_story_facts = 1 WHERE id = ?")
        .run("version-1"),
    ).toThrow(/CHAPTER_VERSION_STORY_FACT_RESPONSIBILITY_IMMUTABLE/u);
  });
});
