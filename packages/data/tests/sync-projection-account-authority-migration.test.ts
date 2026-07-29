import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "./node-sqlite-executor.js";

const legacyMigration = [
  readFileSync(new URL("../migrations/0001_core.sql", import.meta.url), "utf8"),
  readFileSync(
    new URL("../migrations/0015_sync_materialization_authority.sql", import.meta.url),
    "utf8",
  ),
].join("\n");
const accountAuthorityMigration = readFileSync(
  new URL("../migrations/0017_sync_projection_account_authority.sql", import.meta.url),
  "utf8",
);

const PROJECT_ID = "019fa017-0000-7000-8000-000000000001";
const DEVICE_ID = "019fa017-0000-7000-8000-000000000002";
const QUEUED_JOB_ID = "019fa017-0000-7000-8000-000000000003";
const COMPLETED_JOB_ID = "019fa017-0000-7000-8000-000000000004";
const VERSION_ID = "019fa017-0000-7000-8000-000000000005";
const OPERATION_ID = "019fa017-0000-7000-8000-000000000006";
const NOW = "2026-07-28T00:00:00.000Z";

describe("0017 sync projection account authority migration", () => {
  let executor: NodeSqliteExecutor;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(legacyMigration);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Authority', ?, ?)",
      [PROJECT_ID, NOW, NOW],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("clears every unprovable legacy job without touching authoritative project state", async () => {
    await insertLegacyQueuedJob();
    await insertLegacyCompletedJob();
    await insertMaterializedManifest();

    applyMigrationAtomically();

    expect(
      executor.database.prepare("SELECT * FROM sync_projection_jobs ORDER BY job_id").all(),
    ).toEqual([]);
    expect(
      executor.database
        .prepare(
          `SELECT state, source_operation_id
           FROM sync_materialized_objects
           WHERE project_id = ? AND object_type = 'project_manifest'`,
        )
        .all(PROJECT_ID),
    ).toEqual([{ state: "present", source_operation_id: OPERATION_ID }]);
    expect(
      executor.database.prepare("SELECT name FROM projects WHERE id = ?").all(PROJECT_ID),
    ).toEqual([{ name: "Authority" }]);

    const accountColumn = (
      executor.database.prepare("PRAGMA table_info(sync_projection_jobs)").all() as {
        name: string;
        notnull: number;
      }[]
    ).find(({ name }) => name === "account_id");
    expect(accountColumn).toMatchObject({ name: "account_id", notnull: 1 });
    expect(tableSql("sync_projection_jobs")).toContain(
      "project_id,\n    account_id,\n    object_type",
    );
    expect(
      executor.database
        .prepare(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'index'
             AND name LIKE 'sync_projection_jobs_%_idx'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "sync_projection_jobs_identity_idx" },
      { name: "sync_projection_jobs_lease_token_idx" },
      { name: "sync_projection_jobs_operation_idx" },
      { name: "sync_projection_jobs_runnable_idx" },
    ]);
    expect(executor.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("never attributes an orphaned legacy job to a currently registered account", async () => {
    await insertLegacyQueuedJob();
    await executor.execute(
      `INSERT INTO project_sync_registrations (
         project_id, account_id, device_id, state, consent_revision,
         key_version, revision, plaintext_bootstrap_completed,
         last_error_code, created_at, updated_at, enabled_at, paused_at
       ) VALUES (
         ?, '019fa017-0000-7000-8000-000000000099', ?, 'enabled',
         1, 1, 1, 1, NULL, ?, ?, ?, NULL
       )`,
      [PROJECT_ID, DEVICE_ID, NOW, NOW, NOW],
    );

    applyMigrationAtomically();

    expect(executor.database.prepare("SELECT * FROM sync_projection_jobs").all()).toEqual([]);
  });

  it("rolls the rebuilt schema and cleared rows back when the host migration fails", async () => {
    await insertLegacyQueuedJob();
    await insertLegacyCompletedJob();
    const beforeSql = tableSql("sync_projection_jobs");
    const beforeRows = legacyJobs();

    expect(() =>
      applyMigrationAtomically("SELECT migration_must_rollback FROM deliberately_missing_table;"),
    ).toThrow(/no such table/u);

    expect(tableSql("sync_projection_jobs")).toBe(beforeSql);
    expect(legacyJobs()).toEqual(beforeRows);
    expect(tableColumns("sync_projection_jobs")).not.toContain("account_id");
    expect(
      executor.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'sync_projection_jobs_account_authority_new'",
        )
        .all(),
    ).toEqual([]);
  });

  async function insertLegacyQueuedJob(): Promise<void> {
    await executor.execute(
      `INSERT INTO sync_projection_jobs (
         job_id, project_id, object_type, object_id, object_generation,
         projection_kind, version_id, source_revision, key_version,
         consent_revision, device_id, status, attempt, revision,
         next_attempt_at, lease_owner_id, lease_token, lease_expires_at,
         operation_id, failure_code, superseded_by_job_id, created_at,
         updated_at, terminal_at
       ) VALUES (
         ?, ?, 'chapter_version', ?, 1, 'upsert', ?, 1, 1, 1, ?,
         'queued', 0, 1, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
       )`,
      [QUEUED_JOB_ID, PROJECT_ID, PROJECT_ID, VERSION_ID, DEVICE_ID, NOW, NOW, NOW],
    );
  }

  async function insertLegacyCompletedJob(): Promise<void> {
    await executor.execute(
      `INSERT INTO sync_projection_jobs (
         job_id, project_id, object_type, object_id, object_generation,
         projection_kind, version_id, source_revision, key_version,
         consent_revision, device_id, status, attempt, revision,
         next_attempt_at, lease_owner_id, lease_token, lease_expires_at,
         operation_id, failure_code, superseded_by_job_id, created_at,
         updated_at, terminal_at
       ) VALUES (
         ?, ?, 'project_manifest', ?, 1, 'upsert', ?, 1, 1, 1, ?,
         'completed', 1, 2, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?
       )`,
      [
        COMPLETED_JOB_ID,
        PROJECT_ID,
        PROJECT_ID,
        PROJECT_ID,
        DEVICE_ID,
        OPERATION_ID,
        NOW,
        NOW,
        NOW,
      ],
    );
  }

  async function insertMaterializedManifest(): Promise<void> {
    await executor.execute(
      `INSERT INTO sync_materialized_objects (
         project_id, object_type, object_id, object_generation, version_id,
         vector_json, payload_sha256, source_operation_id, source_device_id,
         source_device_sequence, state, materialized_at
       ) VALUES (?, 'project_manifest', ?, 1, ?, ?, ?, ?, ?, 1, 'present', ?)`,
      [
        PROJECT_ID,
        PROJECT_ID,
        PROJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 1 }),
        "a".repeat(64),
        OPERATION_ID,
        DEVICE_ID,
        NOW,
      ],
    );
  }

  function legacyJobs(): readonly Record<string, unknown>[] {
    return executor.database
      .prepare("SELECT * FROM sync_projection_jobs ORDER BY job_id")
      .all() as Record<string, unknown>[];
  }

  function tableSql(tableName: string): string {
    const row = executor.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { sql: string } | undefined;
    return row?.sql ?? "";
  }

  function tableColumns(tableName: string): readonly string[] {
    return (
      executor.database.prepare(`PRAGMA table_info(${tableName})`).all() as {
        name: string;
      }[]
    ).map(({ name }) => name);
  }

  function applyMigrationAtomically(afterMigrationSql = ""): void {
    executor.database.exec("BEGIN IMMEDIATE");
    try {
      executor.database.exec(accountAuthorityMigration);
      if (afterMigrationSql !== "") {
        executor.database.exec(afterMigrationSql);
      }
      executor.database.exec("COMMIT");
    } catch (cause: unknown) {
      if (executor.database.isTransaction) {
        executor.database.exec("ROLLBACK");
      }
      throw cause;
    }
  }
});
