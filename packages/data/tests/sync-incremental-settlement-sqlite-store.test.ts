import { readFileSync } from "node:fs";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import { type AppError, type Result } from "@inkshadow/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncIncrementalSettlementSqliteStore } from "../src/sync-incremental-settlement-sqlite-store.js";
import { SyncMaterializationSqliteStore } from "../src/sync-materialization-sqlite-store.js";
import { SyncSqliteStore } from "../src/sync-sqlite-store.js";
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
  readFileSync(
    new URL("../migrations/0018_sync_incremental_terminal_observations.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const PROJECT_ID = "019fa103-0000-7000-8000-000000000001";
const DEVICE_ID = "019fa103-0000-7000-8000-000000000002";
const OPERATION_ID = "019fa103-0000-7000-8000-000000000003";
const SECOND_OPERATION_ID = "019fa103-0000-7000-8000-000000000007";
const REQUEST_ID = "019fa103-0000-7000-8000-000000000004";
const CONFLICT_ID = "019fa103-0000-7000-8000-000000000005";
const SNAPSHOT_ID = "019fa103-0000-7000-8000-000000000006";
const CURSOR = "incremental_cursor_1";
const DOWNLOADED_AT = "2026-07-28T03:00:00.000Z";
const SETTLED_AT = "2026-07-28T03:01:00.000Z";
const RETRY_AT = "2026-07-28T03:02:00.000Z";

describe("SyncIncrementalSettlementSqliteStore", () => {
  let executor: NodeSqliteExecutor;
  let syncStore: SyncSqliteStore;
  let materializationStore: SyncMaterializationSqliteStore;
  let store: SyncIncrementalSettlementSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    await executor.execute("PRAGMA foreign_keys = ON");
    syncStore = new SyncSqliteStore(executor);
    materializationStore = new SyncMaterializationSqliteStore(executor);
    store = new SyncIncrementalSettlementSqliteStore(executor);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Before', ?, ?)",
      [PROJECT_ID, DOWNLOADED_AT, DOWNLOADED_AT],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("advances the exact terminal pull and commits its finalizer in one transaction", async () => {
    await stagePull(false);

    const result = expectOk(
      await store.settleAtomically(input(null), async (transaction, context) => {
        expect(context.checkpointAdvanced).toBe(true);
        expect(context.target).toMatchObject({
          projectId: PROJECT_ID,
          signedRemoteCursor: CURSOR,
          downloadedCheckpointRevision: 1,
        });
        await transaction.execute("UPDATE projects SET name = 'After' WHERE id = ?", [PROJECT_ID]);
      }),
    );

    expect(result).toMatchObject({
      status: "settled",
      reason: "advanced",
      checkpointAdvanced: true,
      checkpoint: {
        projectId: PROJECT_ID,
        signedRemoteCursor: CURSOR,
        downloadedCheckpointRevision: 1,
        revision: 1,
      },
    });
    expect(await projectName()).toBe("After");
    expect(expectOk(await materializationStore.loadMaterializedCheckpoint(PROJECT_ID))).toEqual(
      result.checkpoint,
    );
  });

  it("replays an exact settlement without inflating checkpoint revision", async () => {
    await stagePull(false);
    const first = expectOk(await store.settleAtomically(input(null)));
    expect(first.status).toBe("settled");
    const finalizer = vi.fn(async () => undefined);

    const replay = expectOk(await store.settleAtomically(input(1), finalizer));

    expect(replay).toMatchObject({
      status: "settled",
      reason: "already_settled",
      checkpointAdvanced: false,
      checkpoint: { revision: 1 },
    });
    expect(finalizer).toHaveBeenCalledOnce();
    expect(
      expectOk(await materializationStore.loadMaterializedCheckpoint(PROJECT_ID)),
    ).toMatchObject({ revision: 1 });
  });

  it("rolls back both checkpoint and finalizer mutations when finalization fails", async () => {
    await stagePull(false);

    const result = await store.settleAtomically(input(null), async (transaction) => {
      await transaction.execute("UPDATE projects SET name = 'Must roll back' WHERE id = ?", [
        PROJECT_ID,
      ]);
      throw new Error("simulated finalizer failure");
    });

    expect(result).toMatchObject({ ok: false, error: { code: "REPOSITORY_ERROR" } });
    expect(await projectName()).toBe("Before");
    expect(expectOk(await materializationStore.loadMaterializedCheckpoint(PROJECT_ID))).toBeNull();
  });

  it("blocks checkpoint advancement while incoming plaintext work remains", async () => {
    await stagePull(false);
    const batchId = await targetBatchId();
    await executor.execute(
      `INSERT INTO sync_inbox_operations (
         operation_id, batch_id, operation_position, project_id, device_id,
         device_sequence, object_type, object_id, object_generation, kind,
         vector_json, operation_created_at, status, attempt, next_attempt_at,
         lease_owner_id, lease_token, lease_expires_at, resolution_token,
         conflict_code, failure_code, received_at, updated_at, resolved_at
       ) VALUES (
         ?, ?, 0, ?, ?, 1, 'project_manifest', ?, 1, 'upsert', ?, ?,
         'received', 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL
       )`,
      [
        OPERATION_ID,
        batchId,
        PROJECT_ID,
        DEVICE_ID,
        PROJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 1 }),
        DOWNLOADED_AT,
        DOWNLOADED_AT,
        DOWNLOADED_AT,
        DOWNLOADED_AT,
      ],
    );
    const finalizer = vi.fn();

    const result = expectOk(await store.settleAtomically(input(null), finalizer));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "incoming_pending",
      checkpoint: null,
      counts: { incomingPendingCount: 1 },
    });
    expect(finalizer).not.toHaveBeenCalled();
    expect(expectOk(await materializationStore.loadMaterializedCheckpoint(PROJECT_ID))).toBeNull();
  });

  it("keeps a scheduled failed inbox operation retryable", async () => {
    await stagePull(false);
    await insertResolvedInboxOperation({
      status: "failed",
      attempt: 3,
      nextAttemptAt: RETRY_AT,
    });

    const result = expectOk(await store.settleAtomically(input(null)));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "incoming_pending",
      checkpoint: null,
      counts: {
        incomingPendingCount: 1,
        incomingPermanentFailureCount: 0,
        incomingAttemptExhaustedCount: 0,
      },
    });
  });

  it("classifies a failed inbox operation without a retry schedule as permanent", async () => {
    await stagePull(false);
    await insertResolvedInboxOperation({
      status: "failed",
      attempt: 3,
      nextAttemptAt: null,
    });

    const result = expectOk(await store.settleAtomically(input(null)));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "incoming_permanent_failure",
      checkpoint: null,
      counts: {
        incomingPendingCount: 0,
        incomingPermanentFailureCount: 1,
        incomingAttemptExhaustedCount: 0,
      },
    });
  });

  it("classifies an inbox operation at the attempt limit as exhausted even if retry is scheduled", async () => {
    await stagePull(false);
    await insertResolvedInboxOperation({
      status: "failed",
      attempt: 100,
      nextAttemptAt: RETRY_AT,
    });

    const result = expectOk(await store.settleAtomically(input(null)));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "incoming_attempt_exhausted",
      checkpoint: null,
      counts: {
        incomingPendingCount: 0,
        incomingPermanentFailureCount: 0,
        incomingAttemptExhaustedCount: 1,
      },
    });
  });

  it("prioritizes incoming conflicts over terminal inbox failures", async () => {
    await stagePull(false);
    await insertResolvedInboxOperation({
      status: "failed",
      attempt: 3,
      nextAttemptAt: null,
    });
    await insertResolvedInboxOperation({
      operationId: SECOND_OPERATION_ID,
      operationPosition: 1,
      deviceSequence: 2,
      status: "conflict",
      attempt: 1,
      nextAttemptAt: null,
    });

    const result = expectOk(await store.settleAtomically(input(null)));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "incoming_conflict",
      checkpoint: null,
      counts: {
        incomingConflictCount: 1,
        incomingPermanentFailureCount: 1,
      },
    });
  });

  it("does not materialize an intermediate cursor while the pull has more pages", async () => {
    await stagePull(true);

    const result = expectOk(await store.settleAtomically(input(null)));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "pull_incomplete",
      checkpoint: null,
    });
  });

  it("settles a has-more page after an exact same-cursor empty terminal observation", async () => {
    await stagePull(true);
    await observeTerminalPull();

    const result = expectOk(await store.settleAtomically(input(null)));

    expect(result).toMatchObject({
      status: "settled",
      reason: "advanced",
      checkpoint: {
        signedRemoteCursor: CURSOR,
        downloadedCheckpointRevision: 1,
        revision: 1,
      },
    });
    await expect(
      executor.select<{ has_more: number }>(
        "SELECT has_more FROM sync_incoming_batches WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ has_more: 1 }]);
  });

  it("records repeated same-cursor terminal observations idempotently", async () => {
    await stagePull(true);
    await observeTerminalPull(DOWNLOADED_AT);
    await observeTerminalPull(SETTLED_AT);

    await expect(
      executor.select<{ count: number; observed_at: string }>(
        `SELECT count(*) AS count, observed_at
         FROM sync_incremental_terminal_observations
         WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ count: 1, observed_at: DOWNLOADED_AT }]);
    expect(expectOk(await store.settleAtomically(input(null)))).toMatchObject({
      status: "settled",
      reason: "advanced",
    });
  });

  it("does not accept terminal observations for a different cursor or checkpoint revision", async () => {
    await stagePull(true);
    await insertTerminalObservation("other_cursor", 1);

    expect(expectOk(await store.settleAtomically(input(null)))).toMatchObject({
      status: "blocked",
      reason: "pull_incomplete",
    });

    await executor.execute(
      "DELETE FROM sync_incremental_terminal_observations WHERE project_id = ?",
      [PROJECT_ID],
    );
    await insertTerminalObservation(CURSOR, 2);
    expect(expectOk(await store.settleAtomically(input(null)))).toMatchObject({
      status: "blocked",
      reason: "pull_incomplete",
    });
  });

  it("blocks an exact cursor while a durable content conflict remains unresolved", async () => {
    await stagePull(false);
    await insertResolvedInboxOperation({
      status: "failed",
      attempt: 3,
      nextAttemptAt: null,
    });
    await executor.execute(
      `INSERT INTO sync_content_conflicts (
         conflict_id, project_id, object_type, object_id, object_generation,
         local_vector_json, remote_vector_json, remote_operation_id, remote_kind,
         remote_payload_sha256, status, resolution, resolution_operation_id,
         revision, created_at, updated_at, resolved_at
       ) VALUES (
         ?, ?, 'project_manifest', ?, 1, ?, ?, ?, 'delete', NULL,
         'unresolved', NULL, NULL, 1, ?, ?, NULL
       )`,
      [
        CONFLICT_ID,
        PROJECT_ID,
        PROJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 1 }),
        JSON.stringify({ [DEVICE_ID]: 2 }),
        OPERATION_ID,
        DOWNLOADED_AT,
        DOWNLOADED_AT,
      ],
    );

    const result = expectOk(await store.settleAtomically(input(null)));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "content_conflict",
      counts: {
        unresolvedContentConflictCount: 1,
        incomingPermanentFailureCount: 1,
      },
      checkpoint: null,
    });
  });

  it("keeps incremental settlement closed while snapshot staging owns the project", async () => {
    await stagePull(false);
    await insertResolvedInboxOperation({
      status: "failed",
      attempt: 100,
      nextAttemptAt: null,
    });
    expectOk(
      await syncStore.stageSyncSnapshotPage({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 1,
        pageIndex: 0,
        resumeCursor: null,
        snapshotExpiresAt: "2026-07-29T03:00:00.000Z",
        snapshotSignedRemoteCursor: "snapshot_high_water_1",
        nextSnapshotCursor: null,
        finalSignedRemoteCursor: "snapshot_high_water_1",
        operations: [],
        chunks: [],
        tombstones: [],
        receivedAt: SETTLED_AT,
      }),
    );

    const result = expectOk(await store.settleAtomically(input(null)));

    expect(result).toMatchObject({
      status: "blocked",
      reason: "snapshot_pending",
      counts: {
        snapshotPendingCount: 1,
        incomingAttemptExhaustedCount: 1,
      },
      checkpoint: null,
    });
  });

  it("fails closed when the caller settles a stale downloaded checkpoint revision", async () => {
    await stagePull(false);

    const result = await store.settleAtomically({
      ...input(null),
      downloadedCheckpointRevision: 2,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
  });

  async function stagePull(hasMore: boolean): Promise<void> {
    expectOk(
      await syncStore.stageIncomingSyncBatch({
        projectId: PROJECT_ID,
        priorSignedRemoteCursor: null,
        response: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          operations: [],
          chunks: [],
          tombstones: [],
          nextCursor: CURSOR,
          hasMore,
        },
        receivedAt: DOWNLOADED_AT,
      }),
    );
  }

  async function observeTerminalPull(receivedAt = SETTLED_AT): Promise<void> {
    expectOk(
      await syncStore.stageIncomingSyncBatch({
        projectId: PROJECT_ID,
        priorSignedRemoteCursor: CURSOR,
        response: {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          requestId: REQUEST_ID,
          operations: [],
          chunks: [],
          tombstones: [],
          nextCursor: CURSOR,
          hasMore: false,
        },
        receivedAt,
      }),
    );
  }

  async function insertTerminalObservation(
    signedRemoteCursor: string,
    downloadedCheckpointRevision: number,
  ): Promise<void> {
    await executor.execute(
      `INSERT INTO sync_incremental_terminal_observations (
         project_id,
         signed_remote_cursor,
         downloaded_checkpoint_revision,
         response_digest,
         request_id,
         observed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        PROJECT_ID,
        signedRemoteCursor,
        downloadedCheckpointRevision,
        "a".repeat(64),
        REQUEST_ID,
        DOWNLOADED_AT,
      ],
    );
  }

  async function insertResolvedInboxOperation(options: {
    readonly operationId?: string;
    readonly operationPosition?: number;
    readonly deviceSequence?: number;
    readonly status: "conflict" | "failed";
    readonly attempt: number;
    readonly nextAttemptAt: string | null;
  }): Promise<void> {
    const batchId = await targetBatchId();
    const operationId = options.operationId ?? OPERATION_ID;
    const statusFields =
      options.status === "conflict"
        ? { conflictCode: "SYNC_CONTENT_CONFLICT", failureCode: null }
        : { conflictCode: null, failureCode: "SYNC_DECRYPT_FAILED" };
    await executor.execute(
      `INSERT INTO sync_inbox_operations (
         operation_id, batch_id, operation_position, project_id, device_id,
         device_sequence, object_type, object_id, object_generation, kind,
         vector_json, operation_created_at, status, attempt, next_attempt_at,
         lease_owner_id, lease_token, lease_expires_at, resolution_token,
         conflict_code, failure_code, received_at, updated_at, resolved_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, 'project_manifest', ?, 1, 'upsert', ?, ?,
         ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?
       )`,
      [
        operationId,
        batchId,
        options.operationPosition ?? 0,
        PROJECT_ID,
        DEVICE_ID,
        options.deviceSequence ?? 1,
        PROJECT_ID,
        JSON.stringify({ [DEVICE_ID]: options.deviceSequence ?? 1 }),
        DOWNLOADED_AT,
        options.status,
        options.attempt,
        options.nextAttemptAt,
        operationId,
        statusFields.conflictCode,
        statusFields.failureCode,
        DOWNLOADED_AT,
        DOWNLOADED_AT,
        DOWNLOADED_AT,
      ],
    );
  }

  function input(expectedMaterializedCheckpointRevision: number | null): {
    projectId: string;
    signedRemoteCursor: string;
    downloadedCheckpointRevision: number;
    expectedMaterializedCheckpointRevision: number | null;
    settledAt: string;
  } {
    return {
      projectId: PROJECT_ID,
      signedRemoteCursor: CURSOR,
      downloadedCheckpointRevision: 1,
      expectedMaterializedCheckpointRevision,
      settledAt: SETTLED_AT,
    };
  }

  async function targetBatchId(): Promise<string> {
    const rows = await executor.select<{ batch_id: string }>(
      "SELECT batch_id FROM sync_incoming_batches WHERE project_id = ?",
      [PROJECT_ID],
    );
    const batchId = rows[0]?.batch_id;
    if (batchId === undefined) {
      throw new Error("Expected a staged incremental batch.");
    }
    return batchId;
  }

  async function projectName(): Promise<string> {
    const rows = await executor.select<{ name: string }>("SELECT name FROM projects WHERE id = ?", [
      PROJECT_ID,
    ]);
    return rows[0]?.name ?? "";
  }
});

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
