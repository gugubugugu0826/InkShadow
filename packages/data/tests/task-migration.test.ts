import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const taskMigration = readFileSync(
  new URL("../migrations/0002_tasks_notifications.sql", import.meta.url),
  "utf8",
);

describe("0002_tasks_notifications SQLite migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(coreMigration);
    database.exec(taskMigration);
  });

  afterEach(() => {
    database.close();
  });

  it("is repeatable and creates task recovery indexes", () => {
    expect(() => database.exec(taskMigration)).not.toThrow();

    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('background_tasks', 'notifications')
         ORDER BY name`,
      )
      .all() as { name: string }[];
    const indexes = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'index'
           AND name LIKE 'background_tasks_%'
            OR name LIKE 'notifications_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];

    expect(tables.map(({ name }) => name)).toEqual(["background_tasks", "notifications"]);
    expect(indexes.map(({ name }) => name)).toEqual([
      "background_tasks_expired_lease_idx",
      "background_tasks_runnable_idx",
      "notifications_expiration_idx",
      "notifications_status_updated_idx",
    ]);
  });

  it("rejects impossible persisted task and notification states", () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO background_tasks (
            id,
            task_type,
            idempotency_key,
            metadata_json,
            priority,
            status,
            attempt,
            max_attempts,
            sequence,
            run_after,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "task-invalid",
          "backup",
          "backup:project:invalid",
          "{}",
          10,
          "running",
          1,
          3,
          1,
          "2026-07-27T00:00:00.000Z",
          "2026-07-27T00:00:00.000Z",
          "2026-07-27T00:00:00.000Z",
        ),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      database
        .prepare(
          `INSERT INTO notifications (
            id,
            dedupe_key,
            message_key,
            level,
            severity,
            status,
            metadata_json,
            requires_resolution,
            expires_at,
            sequence,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "notification-invalid",
          "notification:invalid",
          "task.failed",
          "blocking",
          "error",
          "created",
          "{}",
          1,
          "2026-07-28T00:00:00.000Z",
          1,
          "2026-07-27T00:00:00.000Z",
          "2026-07-27T00:00:00.000Z",
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("passes SQLite integrity checks", () => {
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    const violations = database.prepare("PRAGMA foreign_key_check").all();

    expect(integrity.integrity_check).toBe("ok");
    expect(violations).toEqual([]);
  });
});
