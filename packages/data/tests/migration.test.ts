import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");

const NOW = "2026-07-27T00:00:00.000Z";

describe("0001_core SQLite migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(migration);
  });

  afterEach(() => {
    database.close();
  });

  it("is repeatable and creates the complete first writing slice", () => {
    expect(() => database.exec(migration)).not.toThrow();

    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const indexes = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];

    expect(tables.map(({ name }) => name)).toEqual([
      "ai_candidates",
      "chapter_versions",
      "chapters",
      "local_audit_events",
      "projects",
      "recovery_drafts",
    ]);
    expect(indexes.map(({ name }) => name)).toEqual([
      "ai_candidates_chapter_status_idx",
      "chapter_versions_chapter_idx",
      "chapters_project_updated_idx",
      "local_audit_events_entity_idx",
      "projects_status_updated_idx",
      "projects_visible_name_unique",
    ]);
  });

  it("enables foreign keys and passes SQLite integrity checks", () => {
    const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    const violations = database.prepare("PRAGMA foreign_key_check").all();

    expect(foreignKeys.foreign_keys).toBe(1);
    expect(integrity.integrity_check).toBe("ok");
    expect(violations).toEqual([]);
  });

  it("enforces project and foreign-key constraints", () => {
    const insertProject = database.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );

    expect(() => insertProject.run("project-invalid", "   ", NOW, NOW)).toThrow(
      /CHECK constraint failed/,
    );

    expect(() =>
      database
        .prepare(
          `INSERT INTO ai_candidates (
            id,
            project_id,
            source,
            content,
            status,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("candidate-orphan", "missing-project", "generate", "", "streaming", NOW, NOW),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("requires terminal candidates to retain content, checksum, and decision time", () => {
    database
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("project-1", "青云志", NOW, NOW);

    expect(() =>
      database
        .prepare(
          `INSERT INTO ai_candidates (
            id,
            project_id,
            source,
            content,
            content_checksum,
            status,
            created_at,
            updated_at,
            decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "candidate-1",
          "project-1",
          "generate",
          "候选正文",
          "a".repeat(64),
          "accepted",
          NOW,
          NOW,
          null,
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("can roll back a failed multi-statement migration-level write", () => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const insertProject = database.prepare(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      insertProject.run("project-1", "青云志", NOW, NOW);
      insertProject.run("project-2", "", NOW, NOW);
      database.exec("COMMIT");
    } catch {
      database.exec("ROLLBACK");
    }

    const count = database.prepare("SELECT count(*) AS count FROM projects").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });
});
