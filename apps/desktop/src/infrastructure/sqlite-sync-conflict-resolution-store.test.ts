import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { SyncMaterializationSqliteStore } from "@inkshadow/data";
import { sha256Utf8Content } from "@inkshadow/sync-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { SqliteSyncConflictResolutionStore } from "./sqlite-sync-conflict-resolution-store";
import type { CommitSyncChapterConflictResolutionInput } from "./sync-conflict-resolution-coordinator";

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
const CHAPTER_ID = id(2);
const LOCAL_VERSION_ID = id(3);
const ACCOUNT_ID = id(4);
const LOCAL_DEVICE_ID = id(5);
const REMOTE_DEVICE_ID = id(6);
const REMOTE_OPERATION_ID = id(7);
const MARKER_OPERATION_ID = id(8);
const STABLE_VERSION_ID = id(9);
const PROJECTION_JOB_ID = id(10);
const KEPT_CHAPTER_ID = id(11);
const KEPT_VERSION_ID = id(12);
const KEPT_JOB_ID = id(13);
const NOW = "2026-07-28T05:00:00.000Z";
const LATER = "2026-07-28T05:01:00.000Z";
const BATCH_ID = "a".repeat(64);
const LOCAL_CONTENT = "本地稳定正文";
const REMOTE_CONTENT = "远端稳定正文";
const RESOLVED_CONTENT = "人工确认正文";

describe("SqliteSyncConflictResolutionStore", () => {
  let executor: NodeSqliteExecutor;
  let authority: SyncMaterializationSqliteStore;
  let store: SqliteSyncConflictResolutionStore;
  let localChecksum: string;
  let remoteChecksum: string;
  let resolvedChecksum: string;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    authority = new SyncMaterializationSqliteStore(executor);
    store = new SqliteSyncConflictResolutionStore({
      executor,
      syncStore: {
        loadIncomingWork: vi.fn(() => Promise.reject(new Error("not used by commit tests"))),
      },
      materializer: {
        prepare: vi.fn(() => Promise.reject(new Error("not used by commit tests"))),
      },
    });
    localChecksum = await sha256Utf8Content(LOCAL_CONTENT);
    remoteChecksum = await sha256Utf8Content(REMOTE_CONTENT);
    resolvedChecksum = await sha256Utf8Content(RESOLVED_CONTENT);
    await seedConflict();
  });

  afterEach(async () => {
    await executor.close();
  });

  it("atomically appends a stable version, queues its projection, and releases the inbox", async () => {
    await expect(store.commitChapterResolution(commitInput())).resolves.toEqual({
      conflictId: REMOTE_OPERATION_ID,
      action: "manual_merge",
      stableVersionId: STABLE_VERSION_ID,
      projectionJobId: PROJECTION_JOB_ID,
      keptRemoteChapterId: null,
      keptRemoteVersionId: null,
      replayed: false,
    });

    expect(
      await executor.select<{
        title: string;
        content: string;
        revision: number;
        current_version_id: string;
      }>("SELECT title, content, revision, current_version_id FROM chapters WHERE id = ?", [
        CHAPTER_ID,
      ]),
    ).toEqual([
      {
        title: "人工确认章",
        content: RESOLVED_CONTENT,
        revision: 2,
        current_version_id: STABLE_VERSION_ID,
      },
    ]);
    expect(
      await executor.select<{
        id: string;
        parent_version_id: string;
        sequence: number;
        reason: string;
      }>(
        `SELECT id, parent_version_id, sequence, reason
         FROM chapter_versions
         WHERE id = ?`,
        [STABLE_VERSION_ID],
      ),
    ).toEqual([
      {
        id: STABLE_VERSION_ID,
        parent_version_id: LOCAL_VERSION_ID,
        sequence: 2,
        reason: "manual",
      },
    ]);
    expect(
      await executor.select<{
        status: string;
        conflict_code: string | null;
      }>("SELECT status, conflict_code FROM sync_inbox_operations WHERE operation_id = ?", [
        REMOTE_OPERATION_ID,
      ]),
    ).toEqual([{ status: "applied", conflict_code: null }]);
    expect(
      await executor.select<{
        status: string;
        resolution: string;
        resolution_operation_id: string;
      }>(
        `SELECT status, resolution, resolution_operation_id
         FROM sync_content_conflicts
         WHERE conflict_id = ?`,
        [REMOTE_OPERATION_ID],
      ),
    ).toEqual([
      {
        status: "resolved",
        resolution: "merged",
        resolution_operation_id: PROJECTION_JOB_ID,
      },
    ]);
    expect(
      await executor.select<{
        status: string;
        version_id: string;
        object_generation: number;
      }>(
        `SELECT status, version_id, object_generation
         FROM sync_projection_jobs
         WHERE job_id = ?`,
        [PROJECTION_JOB_ID],
      ),
    ).toEqual([
      {
        status: "queued",
        version_id: STABLE_VERSION_ID,
        object_generation: 1,
      },
    ]);
  });

  it("rolls back every mutation when the reviewed local branch is stale", async () => {
    const stale = {
      ...commitInput(),
      expectedLocalContentChecksum: "f".repeat(64),
    };

    await expect(store.commitChapterResolution(stale)).rejects.toMatchObject({
      code: "SYNC_CONFLICT_REVIEW_STALE",
    });

    expect(
      await executor.select<{ revision: number; current_version_id: string }>(
        "SELECT revision, current_version_id FROM chapters WHERE id = ?",
        [CHAPTER_ID],
      ),
    ).toEqual([{ revision: 1, current_version_id: LOCAL_VERSION_ID }]);
    expect(
      await executor.select<{ count: number }>(
        "SELECT COUNT(*) AS count FROM chapter_versions WHERE id = ?",
        [STABLE_VERSION_ID],
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await executor.select<{ status: string }>(
        "SELECT status FROM sync_content_conflicts WHERE conflict_id = ?",
        [REMOTE_OPERATION_ID],
      ),
    ).toEqual([{ status: "unresolved" }]);
    expect(
      await executor.select<{ status: string }>(
        "SELECT status FROM sync_inbox_operations WHERE operation_id = ?",
        [REMOTE_OPERATION_ID],
      ),
    ).toEqual([{ status: "conflict" }]);
  });

  it("keeps both branches as independent stable chapters and projection jobs", async () => {
    const input: CommitSyncChapterConflictResolutionInput = {
      ...commitInput(),
      action: "keep_both",
      selectedTitle: "本地章",
      selectedContent: LOCAL_CONTENT,
      selectedContentChecksum: localChecksum,
      keptRemoteChapterId: KEPT_CHAPTER_ID,
      keptRemoteVersionId: KEPT_VERSION_ID,
      keptRemoteProjectionJobId: KEPT_JOB_ID,
      keptRemoteTitle: "远端章",
      keptRemoteContent: REMOTE_CONTENT,
      keptRemoteContentChecksum: remoteChecksum,
    };

    await expect(store.commitChapterResolution(input)).resolves.toMatchObject({
      action: "keep_both",
      keptRemoteChapterId: KEPT_CHAPTER_ID,
      keptRemoteVersionId: KEPT_VERSION_ID,
    });

    expect(
      await executor.select<{
        id: string;
        title: string;
        content: string;
        current_version_id: string;
      }>(
        `SELECT id, title, content, current_version_id
         FROM chapters
         ORDER BY id`,
      ),
    ).toEqual([
      {
        id: CHAPTER_ID,
        title: "本地章",
        content: LOCAL_CONTENT,
        current_version_id: STABLE_VERSION_ID,
      },
      {
        id: KEPT_CHAPTER_ID,
        title: "远端章（冲突副本）",
        content: REMOTE_CONTENT,
        current_version_id: KEPT_VERSION_ID,
      },
    ]);
    expect(
      await executor.select<{ job_id: string; object_id: string }>(
        `SELECT job_id, object_id
         FROM sync_projection_jobs
         ORDER BY job_id`,
      ),
    ).toEqual([
      { job_id: PROJECTION_JOB_ID, object_id: CHAPTER_ID },
      { job_id: KEPT_JOB_ID, object_id: KEPT_CHAPTER_ID },
    ]);
  });

  async function seedConflict(): Promise<void> {
    await executor.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO projects (
           id, name, status, revision, deletion_generation, created_at, updated_at,
           archived_at, trashed_at, retention_until, status_before_trash
         ) VALUES (?, 'Conflict', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
        [PROJECT_ID, NOW, NOW],
      );
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, current_version_id,
           created_at, updated_at, trashed_at
         ) VALUES (?, ?, '本地章', ?, 'active', 1, ?, ?, ?, NULL)`,
        [CHAPTER_ID, PROJECT_ID, LOCAL_CONTENT, LOCAL_VERSION_ID, NOW, NOW],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'created', NULL, ?)`,
        [LOCAL_VERSION_ID, PROJECT_ID, CHAPTER_ID, LOCAL_CONTENT, localChecksum, NOW],
      );
      await transaction.execute(
        `INSERT INTO sync_incoming_batches (
           batch_id, project_id, prior_signed_remote_cursor,
           next_signed_remote_cursor, response_digest, request_id, has_more,
           operation_count, chunk_count, tombstone_count, received_at
         ) VALUES (?, ?, NULL, 'cursor_1', ?, 'request-1', 0, 1, 0, 0, ?)`,
        [BATCH_ID, PROJECT_ID, "b".repeat(64), NOW],
      );
      await transaction.execute(
        `INSERT INTO sync_inbox_operations (
           operation_id, batch_id, operation_position, project_id, device_id,
           device_sequence, object_id, object_generation, kind, vector_json,
           operation_created_at, status, attempt, next_attempt_at,
           lease_owner_id, lease_token, lease_expires_at, resolution_token,
           conflict_code, failure_code, received_at, updated_at, resolved_at,
           object_type
         ) VALUES (
           ?, ?, 0, ?, ?, 1, ?, 1, 'upsert', ?, ?,
           'conflict', 1, NULL, NULL, NULL, NULL, ?,
           'SYNC_CONTENT_CONFLICT', NULL, ?, ?, ?, 'chapter_version'
         )`,
        [
          REMOTE_OPERATION_ID,
          BATCH_ID,
          PROJECT_ID,
          REMOTE_DEVICE_ID,
          CHAPTER_ID,
          JSON.stringify({ [REMOTE_DEVICE_ID]: 1 }),
          NOW,
          id(100),
          NOW,
          NOW,
          NOW,
        ],
      );
    });
    expectOk(
      await authority.beginProjectSyncEnable({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: LOCAL_DEVICE_ID,
        consentRevision: 1,
        keyVersion: 1,
        expectedRevision: null,
        begunAt: NOW,
      }),
    );
    expectOk(
      await authority.transitionProjectSyncRegistration({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: LOCAL_DEVICE_ID,
        expectedConsentRevision: 1,
        expectedKeyVersion: 1,
        expectedRevision: 1,
        target: { state: "enabled" },
        transitionedAt: NOW,
      }),
    );
    expectOk(
      await authority.writeMaterializedObject({
        object: {
          projectId: PROJECT_ID,
          objectType: "chapter_version",
          objectId: CHAPTER_ID,
          objectGeneration: 1,
          versionId: LOCAL_VERSION_ID,
          vector: { [LOCAL_DEVICE_ID]: 1 },
          payloadSha256: "c".repeat(64),
          sourceOperationId: MARKER_OPERATION_ID,
          sourceDeviceId: LOCAL_DEVICE_ID,
          sourceDeviceSequence: 1,
          state: "present",
          materializedAt: NOW,
        },
        expectedSourceOperationId: null,
      }),
    );
    expectOk(
      await authority.registerContentConflict({
        conflictId: REMOTE_OPERATION_ID,
        projectId: PROJECT_ID,
        objectType: "chapter_version",
        objectId: CHAPTER_ID,
        objectGeneration: 1,
        localVector: { [LOCAL_DEVICE_ID]: 1 },
        remoteVector: { [REMOTE_DEVICE_ID]: 1 },
        remoteOperationId: REMOTE_OPERATION_ID,
        remoteKind: "upsert",
        remotePayloadSha256: "d".repeat(64),
        createdAt: NOW,
      }),
    );
  }

  function commitInput(): CommitSyncChapterConflictResolutionInput {
    return {
      conflictId: REMOTE_OPERATION_ID,
      expectedConflictRevision: 1,
      expectedRemoteOperationId: REMOTE_OPERATION_ID,
      expectedRemotePayloadSha256: "d".repeat(64),
      expectedLocalVersionId: LOCAL_VERSION_ID,
      expectedLocalRevision: 1,
      expectedLocalContentChecksum: localChecksum,
      action: "manual_merge",
      selectedTitle: "人工确认章",
      selectedContent: RESOLVED_CONTENT,
      selectedContentChecksum: resolvedChecksum,
      stableVersionId: STABLE_VERSION_ID,
      projectionJobId: PROJECTION_JOB_ID,
      keptRemoteChapterId: null,
      keptRemoteVersionId: null,
      keptRemoteProjectionJobId: null,
      keptRemoteTitle: null,
      keptRemoteContent: null,
      keptRemoteContentChecksum: null,
      confirmedAt: LATER,
    };
  }
});

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

function id(value: number): string {
  return `019fa302-2000-7000-8000-${value.toString().padStart(12, "0")}`;
}

function expectOk<Value>(result: {
  readonly ok: boolean;
  readonly value?: Value;
  readonly error?: unknown;
}): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value as Value;
}
