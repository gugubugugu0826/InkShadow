import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const migration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0003_sync_access.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0010_sync_inbox.sql", import.meta.url), "utf8"),
  readFileSync(new URL("../migrations/0013_sync_snapshot_staging.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0014_sync_protocol_v2_object_types.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0015_sync_materialization_authority.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const PROJECT_ID = "019fa001-1000-7000-8000-000000000001";
const ACCOUNT_ID = "019fa001-1000-7000-8000-000000000002";
const DEVICE_ID = "019fa001-1000-7000-8000-000000000003";
const NOW = "2026-07-28T00:00:00.000Z";

describe("0015 sync materialization authority migration", () => {
  let executor: NodeSqliteExecutor;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Authority', ?, ?)",
      [PROJECT_ID, NOW, NOW],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("creates consent, materialization, conflict, and reference-only projection tables", () => {
    const tables = (
      executor.database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN (
               'project_sync_registrations',
               'sync_materialized_objects',
               'sync_materialized_checkpoints',
               'sync_content_conflicts',
               'sync_projection_jobs'
             )
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map(({ name }) => name);

    expect(tables).toEqual([
      "project_sync_registrations",
      "sync_content_conflicts",
      "sync_materialized_checkpoints",
      "sync_materialized_objects",
      "sync_projection_jobs",
    ]);
    const projectionColumns = (
      executor.database.prepare("PRAGMA table_info(sync_projection_jobs)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name);
    expect(projectionColumns).toEqual(
      expect.arrayContaining([
        "object_id",
        "version_id",
        "source_revision",
        "key_version",
        "consent_revision",
        "device_id",
      ]),
    );
    expect(projectionColumns).not.toEqual(
      expect.arrayContaining([
        "title",
        "content",
        "body",
        "plaintext",
        "payload",
        "prompt",
        "model_output",
      ]),
    );
    expect(executor.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("enforces registration state, time, bootstrap, and error consistency", async () => {
    await expect(
      executor.execute(
        `INSERT INTO project_sync_registrations (
           project_id, account_id, device_id, state, consent_revision,
           key_version, revision, plaintext_bootstrap_completed,
           last_error_code, created_at, updated_at, enabled_at, paused_at
         ) VALUES (?, ?, ?, 'enabled', 1, 1, 1, 0, NULL, ?, ?, NULL, NULL)`,
        [PROJECT_ID, ACCOUNT_ID, DEVICE_ID, NOW, NOW],
      ),
    ).rejects.toThrow(/CHECK constraint failed/u);

    await executor.execute(
      `INSERT INTO project_sync_registrations (
         project_id, account_id, device_id, state, consent_revision,
         key_version, revision, plaintext_bootstrap_completed,
         last_error_code, created_at, updated_at, enabled_at, paused_at
       ) VALUES (?, ?, ?, 'error', 1, 1, 1, 0, 'BOOTSTRAP_FAILED', ?, ?, NULL, NULL)`,
      [PROJECT_ID, ACCOUNT_ID, DEVICE_ID, NOW, NOW],
    );
    await expect(
      executor.execute(
        `UPDATE project_sync_registrations
         SET state = 'disabled', last_error_code = 'STALE'
         WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });

  it("uses typed materialized identities and strict present/deleted fields", async () => {
    const objectId = "019fa001-1000-7000-8000-000000000010";
    const operationA = "019fa001-1000-7000-8000-000000000011";
    const operationB = "019fa001-1000-7000-8000-000000000012";
    const vector = JSON.stringify({ [DEVICE_ID]: 1 });
    for (const [objectType, operationId] of [
      ["chapter_version", operationA],
      ["memory", operationB],
    ] as const) {
      await executor.execute(
        `INSERT INTO sync_materialized_objects (
           project_id, object_type, object_id, object_generation, version_id,
           vector_json, payload_sha256, source_operation_id, source_device_id,
           source_device_sequence, state, materialized_at
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 1, 'present', ?)`,
        [
          PROJECT_ID,
          objectType,
          objectId,
          objectId,
          vector,
          "a".repeat(64),
          operationId,
          DEVICE_ID,
          NOW,
        ],
      );
    }
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_materialized_objects WHERE object_id = ?",
        [objectId],
      ),
    ).resolves.toEqual([{ count: 2 }]);
    await expect(
      executor.execute(
        `INSERT INTO sync_materialized_objects (
           project_id, object_type, object_id, object_generation, version_id,
           vector_json, payload_sha256, source_operation_id, source_device_id,
           source_device_sequence, state, materialized_at
         ) VALUES (?, 'material', 'bad-delete', 1, 'forbidden', ?, ?, 'bad-op', ?, 1, 'deleted', ?)`,
        [PROJECT_ID, vector, "b".repeat(64), DEVICE_ID, NOW],
      ),
    ).rejects.toThrow(/CHECK constraint failed/u);
  });
});
