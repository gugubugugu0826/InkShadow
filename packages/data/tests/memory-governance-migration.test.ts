import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const core = readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8");
const story = readFileSync(
  new URL("../../story-core/migrations/0001_story_core.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../migrations/0049_memory_governance_audit.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const RECORD_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const EVENT_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const NOW = "2026-08-08T00:00:00.000Z";

describe("0049 story memory governance audit migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`${core}\n${story}\n${migration}`);
    database
      .prepare("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(PROJECT_ID, "记忆审计项目", NOW, NOW);
    database
      .prepare(
        `INSERT INTO story_memory_records (
           id, project_id, level, origin, status, revision, source_kind, source_id,
           source_version_id, automatic_learning_policy_revision, created_at, updated_at,
           snapshot_json
         ) VALUES (?, ?, 'L2', 'user', 'enabled', 1, 'user_rule', ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(RECORD_ID, PROJECT_ID, RECORD_ID, NOW, NOW, JSON.stringify({ auditFixture: true }));
  });

  afterEach(() => database.close());

  it("is repeatable and stores immutable project-scoped before/after evidence", () => {
    expect(() => database.exec(migration)).not.toThrow();
    database
      .prepare(
        `INSERT INTO story_memory_governance_events (
           id, project_id, operation, target_record_id, affected_record_count,
           resulting_policy_revision, request_json, before_snapshot_json,
           after_snapshot_json, created_at
         ) VALUES (?, ?, 'merge', ?, 2, NULL, ?, ?, ?, ?)`,
      )
      .run(
        EVENT_ID,
        PROJECT_ID,
        RECORD_ID,
        JSON.stringify({ operation: "merge" }),
        JSON.stringify({ records: [{ source: RECORD_ID }] }),
        JSON.stringify({ records: [{ target: RECORD_ID }] }),
        NOW,
      );

    const stored = database
      .prepare(
        `SELECT project_id AS projectId, operation, target_record_id AS targetRecordId
         FROM story_memory_governance_events WHERE id = ?`,
      )
      .get(EVENT_ID);
    expect(stored).toEqual({
      projectId: PROJECT_ID,
      operation: "merge",
      targetRecordId: RECORD_ID,
    });
    expect(() =>
      database
        .prepare("UPDATE story_memory_governance_events SET request_json = '{}' WHERE id = ?")
        .run(EVENT_ID),
    ).toThrow(/immutable/u);
  });

  it("rejects malformed merge audits and missing target records", () => {
    expect(() =>
      database
        .prepare(
          `INSERT INTO story_memory_governance_events (
             id, project_id, operation, target_record_id, affected_record_count,
             resulting_policy_revision, request_json, before_snapshot_json,
             after_snapshot_json, created_at
           ) VALUES (?, ?, 'merge', NULL, 1, NULL, '{}', '{}', '{}', ?)`,
        )
        .run(EVENT_ID, PROJECT_ID, NOW),
    ).toThrow(/CHECK constraint failed/u);

    expect(() =>
      database
        .prepare(
          `INSERT INTO story_memory_governance_events (
             id, project_id, operation, target_record_id, affected_record_count,
             resulting_policy_revision, request_json, before_snapshot_json,
             after_snapshot_json, created_at
           ) VALUES (?, ?, 'merge', ?, 2, NULL, '{}', '{}', '{}', ?)`,
        )
        .run(EVENT_ID, PROJECT_ID, "019f9f4a-b3c7-7350-9226-000000000099", NOW),
    ).toThrow(/FOREIGN KEY constraint failed/u);
  });
});
