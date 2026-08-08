import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const coreMigration = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const receiptMigration = readFileSync(
  new URL("../migrations/0052_continuous_story_state_route_receipts.sql", import.meta.url),
  "utf8",
);
const historicalReceiptMigration = readFileSync(
  new URL(
    "../migrations/0055_continuous_story_state_historical_route_receipts.sql",
    import.meta.url,
  ),
  "utf8",
);

const NOW = "2026-08-08T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const HASH = "a".repeat(64);

describe("continuous story-state route receipt migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(coreMigration);
    database.exec(receiptMigration);
    database.exec(historicalReceiptMigration);
    seedCurrentChapter(database);
  });

  afterEach(() => {
    database.close();
  });

  it("binds one immutable receipt to an owned version and exact checksum", () => {
    insertReceipt(database, "character_extraction", HASH);

    expect(() => insertReceipt(database, "character_extraction", HASH)).toThrow(
      /UNIQUE constraint failed/u,
    );
    expect(() =>
      database
        .prepare(
          "UPDATE continuous_story_state_route_receipts SET model_id = 'changed' WHERE project_id = ?",
        )
        .run(PROJECT_ID),
    ).toThrow(/CONTINUOUS_STORY_STATE_ROUTE_RECEIPT_IMMUTABLE/u);
    expect(() => insertReceipt(database, "world_extraction", "b".repeat(64))).toThrow(
      /CONTINUOUS_STORY_STATE_ROUTE_SOURCE_CHANGED/u,
    );
  });

  it("accepts an owned historical version after the chapter advances", () => {
    database
      .prepare(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, reason,
           content, content_checksum, created_at
         ) VALUES (?, ?, ?, ?, 2, 'manual', 'EFGH', ?, ?)`,
      )
      .run(uuid(4), PROJECT_ID, CHAPTER_ID, VERSION_ID, "b".repeat(64), NOW);
    database
      .prepare("UPDATE chapters SET content = 'EFGH', current_version_id = ? WHERE id = ?")
      .run(uuid(4), CHAPTER_ID);

    expect(() => insertReceipt(database, "character_extraction", HASH)).not.toThrow();
    expect(() => insertReceipt(database, "world_extraction", "b".repeat(64))).toThrow(
      /CONTINUOUS_STORY_STATE_ROUTE_SOURCE_CHANGED/u,
    );
  });

  it("does not block project deletion and cascades receipts during clear or restore", () => {
    insertReceipt(database, "character_extraction", HASH);

    expect(() =>
      database.prepare("DELETE FROM projects WHERE id = ?").run(PROJECT_ID),
    ).not.toThrow();
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM continuous_story_state_route_receipts")
      .get() as { readonly count: number };
    expect(row.count).toBe(0);
  });
});

function insertReceipt(
  database: DatabaseSync,
  task: "character_extraction" | "world_extraction",
  sourceContentHash: string,
): void {
  database
    .prepare(
      `INSERT INTO continuous_story_state_route_receipts (
         project_id, chapter_id, version_id, task, source_content_hash,
         provider_kind, model_id, invocation_id, candidate_count,
         created_fact_count, retired_fact_count, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'ollama', 'test-model', ?, 1, 1, 0, ?)`,
    )
    .run(PROJECT_ID, CHAPTER_ID, VERSION_ID, task, sourceContentHash, `invocation-${task}`, NOW);
}

function seedCurrentChapter(database: DatabaseSync): void {
  database.exec("BEGIN");
  database
    .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Ink', ?, ?)")
    .run(PROJECT_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO chapters (
         id, project_id, title, content, current_version_id, created_at, updated_at
       ) VALUES (?, ?, 'Chapter', 'ABCD', ?, ?, ?)`,
    )
    .run(CHAPTER_ID, PROJECT_ID, VERSION_ID, NOW, NOW);
  database
    .prepare(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, sequence, reason, content,
         content_checksum, created_at
       ) VALUES (?, ?, ?, 1, 'created', 'ABCD', ?, ?)`,
    )
    .run(VERSION_ID, PROJECT_ID, CHAPTER_ID, HASH, NOW);
  database.exec("COMMIT");
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}
