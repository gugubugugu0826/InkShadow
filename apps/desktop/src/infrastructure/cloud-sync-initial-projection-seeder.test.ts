import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  loadProjectSyncRegistrationInTransaction,
  transitionProjectSyncRegistrationInTransaction,
  type ProjectSyncRegistration,
} from "@inkshadow/data";
import { parseUuidV7, type UuidV7, type UuidV7Generator } from "@inkshadow/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { CloudSyncInitialProjectionSeeder } from "./cloud-sync-initial-projection-seeder";

const migration = [
  readMigration("0001_core.sql"),
  readMigration("0003_sync_access.sql"),
  readMigration("0010_sync_inbox.sql"),
  readMigration("0013_sync_snapshot_staging.sql"),
  readMigration("0014_sync_protocol_v2_object_types.sql"),
  readMigration("0015_sync_materialization_authority.sql"),
  readMigration("0017_sync_projection_account_authority.sql"),
].join("\n");

const PROJECT_ID = id(1);
const ACCOUNT_ID = id(2);
const DEVICE_ID = id(3);
const OTHER_ACCOUNT_ID = id(4);
const EARLY_CHAPTER_ID = id(20);
const EARLY_VERSION_ONE_ID = id(21);
const EARLY_VERSION_TWO_ID = id(22);
const LATE_CHAPTER_ID = id(10);
const LATE_VERSION_ONE_ID = id(11);
const REMOTE_OPERATION_ID = id(30);
const CREATED_AT = "2026-07-28T00:00:00.000Z";
const EARLY_AT = "2026-07-28T00:10:00.000Z";
const EARLY_V2_AT = "2026-07-28T00:20:00.000Z";
const LATE_AT = "2026-07-28T00:30:00.000Z";
const SEEDED_AT = "2026-07-28T01:00:00.000Z";

describe("CloudSyncInitialProjectionSeeder", () => {
  let executor: NodeSqliteExecutor;
  let ids: SequentialIds;
  let seeder: CloudSyncInitialProjectionSeeder;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    ids = new SequentialIds(9_000);
    seeder = new CloudSyncInitialProjectionSeeder(ids);
    await insertProject();
    await insertEnablingRegistration();
  });

  afterEach(async () => {
    await executor.close();
  });

  it("seeds the manifest and active chapter history without reviving trashed chapters", async () => {
    await insertChapterHistory();

    const result = await enableAndSeed();
    expect(result.enqueuedJobIds).toEqual([id(9_000), id(9_001), id(9_002)]);
    expect(result.skippedJobIds).toEqual([]);

    const rows = await projectionRows();
    expect(
      rows.map((row) => ({
        jobId: row.job_id,
        objectType: row.object_type,
        objectId: row.object_id,
        versionId: row.version_id,
        sourceRevision: row.source_revision,
      })),
    ).toEqual([
      {
        jobId: id(9_000),
        objectType: "project_manifest",
        objectId: PROJECT_ID,
        versionId: PROJECT_ID,
        sourceRevision: 1,
      },
      {
        jobId: id(9_001),
        objectType: "chapter_version",
        objectId: EARLY_CHAPTER_ID,
        versionId: EARLY_VERSION_ONE_ID,
        sourceRevision: 1,
      },
      {
        jobId: id(9_002),
        objectType: "chapter_version",
        objectId: EARLY_CHAPTER_ID,
        versionId: EARLY_VERSION_TWO_ID,
        sourceRevision: 2,
      },
    ]);
    expect(rows.every((row) => row.created_at === SEEDED_AT)).toBe(true);
    expect(rows.every((row) => row.next_attempt_at === SEEDED_AT)).toBe(true);
    expect(rows.every((row) => row.account_id === ACCOUNT_ID)).toBe(true);
    expect(rows.every((row) => row.key_version === 7 && row.consent_revision === 3)).toBe(true);
  });

  it("starts a locally retained chapter after a remote tombstone at the next generation", async () => {
    await insertChapterHistory({ includeLateChapter: false, projectDeletionGeneration: 2 });
    await executor.execute(
      `INSERT INTO sync_materialized_objects (
         project_id, object_type, object_id, object_generation, version_id,
         vector_json, payload_sha256, source_operation_id, source_device_id,
         source_device_sequence, state, materialized_at
       ) VALUES (?, 'chapter_version', ?, 4, NULL, ?, NULL, ?, ?, 1, 'deleted', ?)`,
      [
        PROJECT_ID,
        EARLY_CHAPTER_ID,
        JSON.stringify({ [DEVICE_ID]: 1 }),
        REMOTE_OPERATION_ID,
        DEVICE_ID,
        CREATED_AT,
      ],
    );

    await enableAndSeed();
    const rows = await projectionRows();
    expect(rows.map((row) => [row.object_type, row.object_generation])).toEqual([
      ["project_manifest", 3],
      ["chapter_version", 5],
      ["chapter_version", 5],
    ]);
  });

  it("does not resurrect a project whose exact remote tombstone was materialized", async () => {
    await executor.execute(
      `UPDATE projects
       SET status = 'trashed', revision = 2, deletion_generation = 1,
           updated_at = ?, trashed_at = ?, retention_until = ?,
           status_before_trash = 'active'
       WHERE id = ?`,
      [SEEDED_AT, SEEDED_AT, "2026-08-27T01:00:00.000Z", PROJECT_ID],
    );
    await executor.execute(
      `INSERT INTO sync_materialized_objects (
         project_id, object_type, object_id, object_generation, version_id,
         vector_json, payload_sha256, source_operation_id, source_device_id,
         source_device_sequence, state, materialized_at
       ) VALUES (?, 'project_manifest', ?, 2, NULL, ?, NULL, ?, ?, 2, 'deleted', ?)`,
      [
        PROJECT_ID,
        PROJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 2 }),
        REMOTE_OPERATION_ID,
        DEVICE_ID,
        SEEDED_AT,
      ],
    );

    await expect(enableAndSeed()).resolves.toEqual({
      projectId: PROJECT_ID,
      enqueuedJobIds: [],
      skippedJobIds: [],
    });
    expect(await projectionRows()).toEqual([]);
  });

  it("fails closed when a locally trashed project has no authoritative remote tombstone", async () => {
    await executor.execute(
      `UPDATE projects
       SET status = 'trashed', revision = 2, deletion_generation = 1,
           updated_at = ?, trashed_at = ?, retention_until = ?,
           status_before_trash = 'active'
       WHERE id = ?`,
      [SEEDED_AT, SEEDED_AT, "2026-08-27T01:00:00.000Z", PROJECT_ID],
    );

    await expect(enableAndSeed()).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(await projectionRows()).toEqual([]);
    expect(await requireRegistration()).toMatchObject({ state: "enabling", revision: 1 });
  });

  it("replays an identical seed without allocating IDs or duplicating jobs", async () => {
    await insertChapterHistory({ includeLateChapter: false });
    const first = await enableAndSeed();
    const callsAfterFirstSeed = ids.calls;
    const registration = await requireRegistration();

    const replay = await executor.transaction((transaction) =>
      seeder.seedProjectInTransaction(transaction, registration, "2026-07-28T02:00:00.000Z"),
    );

    expect(replay.enqueuedJobIds).toEqual([]);
    expect(replay.skippedJobIds).toEqual(first.enqueuedJobIds);
    expect(ids.calls).toBe(callsAfterFirstSeed);
    expect(await projectionRows()).toHaveLength(3);
  });

  it("rejects an existing source identity with different key authority", async () => {
    await insertChapterHistory({ includeLateChapter: false });
    await enableAndSeed();
    await executor.execute(
      "UPDATE sync_projection_jobs SET key_version = 6 WHERE object_type = 'project_manifest'",
    );
    const registration = await requireRegistration();

    await expect(
      executor.transaction((transaction) =>
        seeder.seedProjectInTransaction(transaction, registration, SEEDED_AT),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(ids.calls).toBe(3);
    expect(await projectionRows()).toHaveLength(3);
  });

  it("seeds fresh authority instead of replaying a prior account's jobs", async () => {
    await insertChapterHistory({ includeLateChapter: false });
    await enableAndSeed();
    await executor.execute(
      `UPDATE project_sync_registrations
       SET account_id = ?, revision = revision + 1, updated_at = ?
       WHERE project_id = ?`,
      [OTHER_ACCOUNT_ID, "2026-07-28T02:00:00.000Z", PROJECT_ID],
    );
    const registration = await requireRegistration();

    const reseeded = await executor.transaction((transaction) =>
      seeder.seedProjectInTransaction(transaction, registration, "2026-07-28T02:00:00.000Z"),
    );

    expect(reseeded.enqueuedJobIds).toEqual([id(9_003), id(9_004), id(9_005)]);
    expect(reseeded.skippedJobIds).toEqual([]);
    expect(ids.calls).toBe(6);
    const rows = await projectionRows();
    expect(
      rows
        .filter(({ account_id }) => account_id === ACCOUNT_ID)
        .every(({ status }) => status === "superseded"),
    ).toBe(true);
    expect(
      rows
        .filter(({ account_id }) => account_id === OTHER_ACCOUNT_ID)
        .every(({ status }) => status === "queued"),
    ).toBe(true);
  });

  it("fails before writing when the registration has not been enabled", async () => {
    const registration = await requireRegistration();

    await expect(
      executor.transaction(async (transaction) => {
        await transaction.execute("UPDATE projects SET name = 'Transient' WHERE id = ?", [
          PROJECT_ID,
        ]);
        return seeder.seedProjectInTransaction(transaction, registration, SEEDED_AT);
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

    expect(await projectName()).toBe("Initial Seed");
    expect(await projectionRows()).toEqual([]);
  });

  it("rolls back registration enablement and earlier jobs when any enqueue fails", async () => {
    await insertChapterHistory({ includeLateChapter: false });
    executor.database.exec(`
      CREATE TRIGGER fail_chapter_projection_seed
      BEFORE INSERT ON sync_projection_jobs
      WHEN NEW.object_type = 'chapter_version'
      BEGIN
        SELECT RAISE(ABORT, 'simulated projection enqueue failure');
      END;
    `);

    await expect(enableAndSeed()).rejects.toMatchObject({ code: "REPOSITORY_ERROR" });
    const registration = await requireRegistration();
    expect(registration).toMatchObject({
      state: "enabling",
      revision: 1,
      plaintextBootstrapCompleted: false,
    });
    expect(await projectionRows()).toEqual([]);
  });

  async function enableAndSeed() {
    return executor.transaction(async (transaction) => {
      const enabled = requireResult(
        await transitionProjectSyncRegistrationInTransaction(transaction, {
          projectId: PROJECT_ID,
          expectedAccountId: ACCOUNT_ID,
          expectedDeviceId: DEVICE_ID,
          expectedConsentRevision: 3,
          expectedKeyVersion: 7,
          expectedRevision: 1,
          target: { state: "enabled" },
          transitionedAt: SEEDED_AT,
        }),
      );
      return seeder.seedProjectInTransaction(transaction, enabled, SEEDED_AT);
    });
  }

  async function insertProject(): Promise<void> {
    await executor.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at,
         archived_at, trashed_at, retention_until, status_before_trash
       ) VALUES (?, 'Initial Seed', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
      [PROJECT_ID, CREATED_AT, CREATED_AT],
    );
  }

  async function insertEnablingRegistration(): Promise<void> {
    await executor.execute(
      `INSERT INTO project_sync_registrations (
         project_id, account_id, device_id, state, consent_revision, key_version,
         revision, plaintext_bootstrap_completed, last_error_code, created_at,
         updated_at, enabled_at, paused_at
       ) VALUES (?, ?, ?, 'enabling', 3, 7, 1, 0, NULL, ?, ?, NULL, NULL)`,
      [PROJECT_ID, ACCOUNT_ID, DEVICE_ID, CREATED_AT, CREATED_AT],
    );
  }

  async function insertChapterHistory(
    options: {
      readonly includeLateChapter?: boolean;
      readonly projectDeletionGeneration?: number;
    } = {},
  ): Promise<void> {
    if (options.projectDeletionGeneration !== undefined) {
      await executor.execute("UPDATE projects SET deletion_generation = ? WHERE id = ?", [
        options.projectDeletionGeneration,
        PROJECT_ID,
      ]);
    }
    await executor.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, current_version_id,
           created_at, updated_at, trashed_at
         ) VALUES (?, ?, 'Early', 'second', 'active', 2, ?, ?, ?, NULL)`,
        [EARLY_CHAPTER_ID, PROJECT_ID, EARLY_VERSION_TWO_ID, EARLY_AT, EARLY_V2_AT],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, 'first', ?, 'created', NULL, ?)`,
        [EARLY_VERSION_ONE_ID, PROJECT_ID, EARLY_CHAPTER_ID, "a".repeat(64), EARLY_AT],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, 2, 'second', ?, 'manual', NULL, ?)`,
        [
          EARLY_VERSION_TWO_ID,
          PROJECT_ID,
          EARLY_CHAPTER_ID,
          EARLY_VERSION_ONE_ID,
          "b".repeat(64),
          EARLY_V2_AT,
        ],
      );

      if (options.includeLateChapter !== false) {
        await transaction.execute(
          `INSERT INTO chapters (
             id, project_id, title, content, status, revision, current_version_id,
             created_at, updated_at, trashed_at
           ) VALUES (?, ?, 'Soft deleted', 'retained', 'trashed', 1, ?, ?, ?, ?)`,
          [LATE_CHAPTER_ID, PROJECT_ID, LATE_VERSION_ONE_ID, LATE_AT, LATE_AT, LATE_AT],
        );
        await transaction.execute(
          `INSERT INTO chapter_versions (
             id, project_id, chapter_id, parent_version_id, sequence, content,
             content_checksum, reason, source_candidate_id, created_at
           ) VALUES (?, ?, ?, NULL, 1, 'retained', ?, 'created', NULL, ?)`,
          [LATE_VERSION_ONE_ID, PROJECT_ID, LATE_CHAPTER_ID, "c".repeat(64), LATE_AT],
        );
      }
    });
  }

  async function requireRegistration(): Promise<ProjectSyncRegistration> {
    const registration = requireResult(
      await loadProjectSyncRegistrationInTransaction(executor, PROJECT_ID),
    );
    if (registration === null) {
      throw new Error("Expected a project sync registration.");
    }
    return registration;
  }

  async function projectionRows(): Promise<readonly ProjectionJobRow[]> {
    return executor.select<ProjectionJobRow>(
      `SELECT job_id, object_type, object_id, object_generation, version_id,
              source_revision, account_id, key_version, consent_revision, device_id, status,
              created_at, next_attempt_at
       FROM sync_projection_jobs
       ORDER BY created_at, job_id`,
    );
  }

  async function projectName(): Promise<string> {
    const rows = await executor.select<{ name: string }>("SELECT name FROM projects WHERE id = ?", [
      PROJECT_ID,
    ]);
    return rows[0]?.name ?? "";
  }
});

interface ProjectionJobRow {
  readonly job_id: string;
  readonly account_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly object_generation: number;
  readonly version_id: string | null;
  readonly source_revision: number;
  readonly key_version: number;
  readonly consent_revision: number;
  readonly device_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly next_attempt_at: string;
}

class SequentialIds implements Pick<UuidV7Generator, "next"> {
  public calls = 0;

  public constructor(private nextValue: number) {}

  public next(): UuidV7 {
    const value = requireResult(parseUuidV7(id(this.nextValue)));
    this.nextValue += 1;
    this.calls += 1;
    return value;
  }
}

function requireResult<Value>(result: {
  readonly ok: boolean;
  readonly value?: Value;
  readonly error?: unknown;
}): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value as Value;
}

function id(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString(16).padStart(12, "0")}`;
}

function readMigration(name: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", name), "utf8");
}
