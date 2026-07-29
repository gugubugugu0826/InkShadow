import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const syncAccessMigration = readFileSync(
  new URL("../migrations/0003_sync_access.sql", import.meta.url),
  "utf8",
);
const syncInboxMigration = readFileSync(
  new URL("../migrations/0010_sync_inbox.sql", import.meta.url),
  "utf8",
);

const NOW = "2026-07-27T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000004";

describe("0010_sync_inbox SQLite migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(coreMigration);
    database.exec(syncAccessMigration);
    database
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(PROJECT_ID, "同步收件箱", NOW, NOW);
    database
      .prepare(
        `INSERT INTO sync_outbox_operations (
          operation_id,
          project_id,
          device_id,
          device_sequence,
          object_id,
          object_generation,
          kind,
          vector_json,
          status,
          attempt,
          next_attempt_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 7, ?, 1, 'delete', ?, 'queued', 0, ?, ?, ?)`,
      )
      .run(
        OPERATION_ID,
        PROJECT_ID,
        DEVICE_ID,
        OBJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 7 }),
        NOW,
        NOW,
        NOW,
      );
    database.exec(syncInboxMigration);
  });

  afterEach(() => {
    database.close();
  });

  it("is repeatable, creates the durable pull tables, and seeds device sequences", () => {
    expect(() => database.exec(syncInboxMigration)).not.toThrow();

    const tables = database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'sync_remote_checkpoints',
             'sync_device_sequences',
             'sync_incoming_batches',
             'sync_inbox_operations',
             'sync_inbox_operation_chunks'
           )
         ORDER BY name`,
      )
      .all() as { name: string }[];
    const sequence = database
      .prepare(
        `SELECT last_allocated_sequence AS lastSequence, revision
         FROM sync_device_sequences
         WHERE project_id = ? AND device_id = ?`,
      )
      .get(PROJECT_ID, DEVICE_ID);

    expect(tables.map(({ name }) => name)).toEqual([
      "sync_device_sequences",
      "sync_inbox_operation_chunks",
      "sync_inbox_operations",
      "sync_incoming_batches",
      "sync_remote_checkpoints",
    ]);
    expect(sequence).toEqual({ lastSequence: 7, revision: 1 });
  });

  it("stores bounded opaque cursors and rejects impossible inbox lease states", () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_remote_checkpoints (
            project_id,
            signed_remote_cursor,
            revision,
            updated_at
          ) VALUES (?, ?, 1, ?)`,
        )
        .run(PROJECT_ID, "cursor.with.invalid.characters", NOW),
    ).toThrow(/CHECK constraint failed/);

    database
      .prepare(
        `INSERT INTO sync_incoming_batches (
          batch_id,
          project_id,
          prior_signed_remote_cursor,
          next_signed_remote_cursor,
          response_digest,
          request_id,
          has_more,
          operation_count,
          chunk_count,
          tombstone_count,
          received_at
        ) VALUES (?, ?, NULL, ?, ?, ?, 0, 1, 0, 1, ?)`,
      )
      .run("a".repeat(64), PROJECT_ID, "signed_cursor_1", "b".repeat(64), OPERATION_ID, NOW);

    expect(() =>
      database
        .prepare(
          `INSERT INTO sync_inbox_operations (
            operation_id,
            batch_id,
            operation_position,
            project_id,
            device_id,
            device_sequence,
            object_id,
            object_generation,
            kind,
            vector_json,
            operation_created_at,
            status,
            attempt,
            next_attempt_at,
            received_at,
            updated_at
          ) VALUES (?, ?, 0, ?, ?, 8, ?, 1, 'delete', ?, ?, 'applying', 1, NULL, ?, ?)`,
        )
        .run(
          "019f9f4a-b3c7-7350-9226-000000000005",
          "a".repeat(64),
          PROJECT_ID,
          DEVICE_ID,
          OBJECT_ID,
          JSON.stringify({ [DEVICE_ID]: 8 }),
          NOW,
          NOW,
          NOW,
        ),
    ).toThrow(/CHECK constraint failed/);
  });

  it("contains no plaintext, key, credential, or bearer-token columns", () => {
    const tableNames = [
      "sync_remote_checkpoints",
      "sync_device_sequences",
      "sync_incoming_batches",
      "sync_inbox_operations",
      "sync_inbox_operation_chunks",
    ];
    const columnNames = tableNames.flatMap((table) =>
      (
        database.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
        }[]
      ).map(({ name }) => name),
    );

    expect(columnNames).not.toContain("plaintext");
    expect(columnNames).not.toContain("content");
    expect(columnNames).not.toContain("project_key");
    expect(columnNames).not.toContain("private_key");
    expect(columnNames).not.toContain("access_token");
    expect(columnNames).not.toContain("refresh_token");
    expect(columnNames).not.toContain("password");
  });

  it("passes SQLite integrity and foreign-key checks", () => {
    const integrity = database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    const violations = database.prepare("PRAGMA foreign_key_check").all();

    expect(integrity.integrity_check).toBe("ok");
    expect(violations).toEqual([]);
  });
});
