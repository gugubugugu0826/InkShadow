import { readFileSync } from "node:fs";

import {
  CONTRACT_SCHEMA_VERSION,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type CloudSyncPullResponse,
  type EncryptedSyncChunkContract,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";
import { AesGcmChunkCipher } from "@inkshadow/sync-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SyncSqliteStore, type StoredEncryptedChunk } from "../src/sync-sqlite-store.js";
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
    new URL("../migrations/0018_sync_incremental_terminal_observations.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const OTHER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OWNER_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const OTHER_OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const THIRD_OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000008";
const OTHER_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000009";
const THIRD_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000010";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000011";
const OTHER_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000012";
const CHUNK_ID = "019f9f4a-b3c7-7350-9226-000000000013";
const OTHER_CHUNK_ID = "019f9f4a-b3c7-7350-9226-000000000014";
const THIRD_CHUNK_ID = "019f9f4a-b3c7-7350-9226-000000000015";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000016";
const LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000017";
const NEXT_LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000018";
const THIRD_LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000019";
const FOURTH_LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000020";
const NOW = "2026-07-27T00:00:00.000Z";

describe("SyncSqliteStore incoming cloud persistence", () => {
  let executor: NodeSqliteExecutor;
  let store: SyncSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    store = new SyncSqliteStore(executor);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "云同步收件箱", NOW, NOW],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("allocates monotonic device sequences and uses revision-CAS checkpoints", async () => {
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toEqual({
      ok: true,
      value: {
        projectId: PROJECT_ID,
        signedRemoteCursor: null,
        revision: 0,
        updatedAt: null,
      },
    });
    expect(
      await store.allocateNextDeviceSequence({
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        now: NOW,
      }),
    ).toMatchObject({ ok: true, value: { sequence: 1, revision: 1 } });
    expect(
      await store.allocateNextDeviceSequence({
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        now: "2026-07-27T00:00:01.000Z",
      }),
    ).toMatchObject({ ok: true, value: { sequence: 2, revision: 2 } });

    expect(
      await store.compareAndSwapRemoteCheckpoint({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        expectedSignedRemoteCursor: null,
        nextSignedRemoteCursor: "signed_cursor_1",
        now: NOW,
      }),
    ).toMatchObject({
      ok: true,
      value: { signedRemoteCursor: "signed_cursor_1", revision: 1 },
    });
    expect(
      await store.compareAndSwapRemoteCheckpoint({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        expectedSignedRemoteCursor: null,
        nextSignedRemoteCursor: "signed_cursor_2",
        now: "2026-07-27T00:00:02.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { signedRemoteCursor: "signed_cursor_1", revision: 1 },
    });
    expect(
      await store.compareAndSwapRemoteCheckpoint({
        projectId: PROJECT_ID,
        expectedRevision: 1,
        expectedSignedRemoteCursor: "x".repeat(513),
        nextSignedRemoteCursor: "signed_cursor_2",
        now: "2026-07-27T00:00:02.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("reports durable project conflicts, pending work, pauses, and exhausted attempts", async () => {
    const batchId = "b".repeat(64);
    await executor.execute(
      `INSERT INTO sync_incoming_batches (
         batch_id, project_id, prior_signed_remote_cursor, next_signed_remote_cursor,
         response_digest, request_id, has_more, operation_count, chunk_count,
         tombstone_count, received_at
       ) VALUES (?, ?, NULL, ?, ?, ?, 0, 2, 0, 2, ?)`,
      [batchId, PROJECT_ID, "signed_cursor_blocking", "c".repeat(64), REQUEST_ID, NOW],
    );
    await executor.execute(
      `INSERT INTO sync_inbox_operations (
         operation_id, batch_id, operation_position, project_id, device_id,
         device_sequence, object_type, object_id, object_generation, kind,
         vector_json, operation_created_at, status, attempt, next_attempt_at,
         lease_owner_id, lease_token, lease_expires_at, resolution_token,
         conflict_code, failure_code, received_at, updated_at, resolved_at
       ) VALUES
       (?, ?, 0, ?, ?, 1, 'chapter_version', ?, 1, 'delete', ?, ?,
        'conflict', 1, NULL, NULL, NULL, NULL, ?, 'VERSION_VECTOR_CONFLICT',
        NULL, ?, ?, ?),
       (?, ?, 1, ?, ?, 1, 'memory', ?, 1, 'delete', ?, ?,
        'failed', 100, ?, NULL, NULL, NULL, ?, NULL,
        'DECRYPTION_RETRY_EXHAUSTED', ?, ?, ?)`,
      [
        OPERATION_ID,
        batchId,
        PROJECT_ID,
        DEVICE_ID,
        OBJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 1 }),
        NOW,
        LEASE_ID,
        NOW,
        NOW,
        NOW,
        OTHER_OPERATION_ID,
        batchId,
        PROJECT_ID,
        OTHER_DEVICE_ID,
        OTHER_OBJECT_ID,
        JSON.stringify({ [OTHER_DEVICE_ID]: 1 }),
        NOW,
        "2026-07-27T00:10:00.000Z",
        NEXT_LEASE_ID,
        NOW,
        NOW,
        NOW,
      ],
    );
    await executor.execute(
      `INSERT INTO sync_outbox_operations (
         operation_id, project_id, device_id, device_sequence, object_type,
         object_id, object_generation, kind, vector_json, status, attempt,
         next_attempt_at, lease_owner_id, lease_token, lease_expires_at,
         failure_code, acknowledged_at, created_at, updated_at
       ) VALUES
       (?, ?, ?, 2, 'chapter_version', ?, 1, 'delete', ?, 'paused', 1,
        NULL, NULL, NULL, NULL, 'USER_ATTENTION_REQUIRED', NULL, ?, ?),
       (?, ?, ?, 3, 'memory', ?, 1, 'delete', ?, 'failed', 100,
        ?, NULL, NULL, NULL, 'UPLOAD_RETRY_EXHAUSTED', NULL, ?, ?)`,
      [
        THIRD_OPERATION_ID,
        PROJECT_ID,
        DEVICE_ID,
        THIRD_OBJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 2 }),
        NOW,
        NOW,
        "019f9f4a-b3c7-7350-9226-000000000021",
        PROJECT_ID,
        DEVICE_ID,
        OTHER_OBJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 3 }),
        "2026-07-27T00:10:00.000Z",
        NOW,
        NOW,
      ],
    );

    await expect(store.readProjectSyncBlockingState(PROJECT_ID)).resolves.toEqual({
      ok: true,
      value: {
        projectId: PROJECT_ID,
        incomingConflictCount: 1,
        incomingPendingCount: 1,
        incomingPausedCount: 0,
        incomingAttemptExhaustedCount: 1,
        outgoingPendingCount: 1,
        outgoingPausedCount: 1,
        outgoingAttemptExhaustedCount: 1,
      },
    });
  });

  it("treats repeated empty stable-head pulls as no-ops and rejects cursor stalls with work", async () => {
    expect(
      await store.compareAndSwapRemoteCheckpoint({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        expectedSignedRemoteCursor: null,
        nextSignedRemoteCursor: "signed_cursor_stable",
        now: NOW,
      }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });
    const emptyResponse = createResponse({
      operations: [],
      nextCursor: "signed_cursor_stable",
    });
    const first = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: "signed_cursor_stable",
      response: emptyResponse,
      receivedAt: "2026-07-27T00:01:00.000Z",
    });
    const second = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: "signed_cursor_stable",
      response: emptyResponse,
      receivedAt: "2026-07-27T00:02:00.000Z",
    });
    expect(first).toMatchObject({
      ok: true,
      value: { created: false, operationCount: 0, checkpoint: { revision: 1 } },
    });
    expect(second).toEqual(first);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_incoming_batches"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{
        signed_remote_cursor: string;
        downloaded_checkpoint_revision: number;
        request_id: string;
        observed_at: string;
      }>(
        `SELECT
           signed_remote_cursor,
           downloaded_checkpoint_revision,
           request_id,
           observed_at
         FROM sync_incremental_terminal_observations
         WHERE project_id = ?`,
        [PROJECT_ID],
      ),
    ).resolves.toEqual([
      {
        signed_remote_cursor: "signed_cursor_stable",
        downloaded_checkpoint_revision: 1,
        request_id: REQUEST_ID,
        observed_at: "2026-07-27T00:01:00.000Z",
      },
    ]);
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: {
        signedRemoteCursor: "signed_cursor_stable",
        revision: 1,
        updatedAt: NOW,
      },
    });

    expect(
      await store.stageIncomingSyncBatch({
        projectId: PROJECT_ID,
        priorSignedRemoteCursor: "signed_cursor_stable",
        response: { ...emptyResponse, hasMore: true },
        receivedAt: "2026-07-27T00:03:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const deletion = createOperation({
      operationId: OPERATION_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 1,
      objectId: OBJECT_ID,
      kind: "delete",
    });
    expect(
      await store.stageIncomingSyncBatch({
        projectId: PROJECT_ID,
        priorSignedRemoteCursor: "signed_cursor_stable",
        response: createResponse({
          operations: [deletion],
          tombstones: [createTombstone(deletion)],
          nextCursor: "signed_cursor_stable",
        }),
        receivedAt: "2026-07-27T00:04:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("rejects replay when terminal observation evidence no longer matches the exact response", async () => {
    expect(
      await store.compareAndSwapRemoteCheckpoint({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        expectedSignedRemoteCursor: null,
        nextSignedRemoteCursor: "signed_cursor_terminal",
        now: NOW,
      }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });
    const command = {
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: "signed_cursor_terminal",
      response: createResponse({
        operations: [],
        nextCursor: "signed_cursor_terminal",
      }),
      receivedAt: NOW,
    } as const;
    expect(await store.stageIncomingSyncBatch(command)).toMatchObject({ ok: true });
    await executor.execute(
      `UPDATE sync_incremental_terminal_observations
       SET response_digest = ?
       WHERE project_id = ?`,
      ["b".repeat(64), PROJECT_ID],
    );

    expect(await store.stageIncomingSyncBatch(command)).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
  });

  it("rejects a delete whose tombstone carries a different object type", async () => {
    const deletion = createOperation({
      operationId: OPERATION_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 1,
      objectId: OBJECT_ID,
      kind: "delete",
    });
    const mismatchedTombstone: SyncTombstoneContract = {
      ...createTombstone(deletion),
      objectType: "memory",
    };

    const result = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response: createResponse({
        operations: [deletion],
        tombstones: [mismatchedTombstone],
        nextCursor: "signed_cursor_1",
      }),
      receivedAt: NOW,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_incoming_batches"),
    ).resolves.toEqual([{ count: 0 }]);
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { signedRemoteCursor: null, revision: 0 },
    });
  });

  it("rejects protocol-v1 operations before persisting or advancing the cursor", async () => {
    const operation = createOperation({
      operationId: OPERATION_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 1,
      objectId: OBJECT_ID,
      kind: "delete",
    });
    const protocolV1Operation = {
      ...operation,
      schemaVersion: 1,
    } as unknown as SyncOperationContract;

    const result = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response: createResponse({
        operations: [protocolV1Operation],
        tombstones: [createTombstone(operation)],
        nextCursor: "signed_cursor_1",
      }),
      receivedAt: NOW,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_incoming_batches"),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("rejects protocol-v1 tombstones before persisting or advancing the cursor", async () => {
    const deletion = createOperation({
      operationId: OPERATION_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 1,
      objectId: OBJECT_ID,
      kind: "delete",
    });
    const protocolV1Tombstone = {
      ...createTombstone(deletion),
      schemaVersion: 1,
    } as unknown as SyncTombstoneContract;

    const result = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response: createResponse({
        operations: [deletion],
        tombstones: [protocolV1Tombstone],
        nextCursor: "signed_cursor_1",
      }),
      receivedAt: NOW,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_tombstones"),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("atomically stages complete ciphertext batches and replays the exact batch", async () => {
    const chunk = await createChunk("仅密文进入收件箱", {
      chunkId: CHUNK_ID,
      objectId: OBJECT_ID,
      versionId: VERSION_ID,
    });
    const upsert = createOperation({
      operationId: OPERATION_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 4,
      objectId: OBJECT_ID,
      chunkIds: [CHUNK_ID],
    });
    const deletion = createOperation({
      operationId: OTHER_OPERATION_ID,
      deviceId: OTHER_DEVICE_ID,
      deviceSequence: 2,
      objectId: OTHER_OBJECT_ID,
      kind: "delete",
    });
    const tombstone = createTombstone(deletion);
    const response = createResponse({
      operations: [upsert, deletion],
      chunks: [chunk],
      tombstones: [tombstone],
      nextCursor: "signed_cursor_1",
    });
    expect(await store.enqueue({ operation: upsert, chunks: [chunk], now: NOW })).toMatchObject({
      ok: true,
      value: { created: true },
    });

    const first = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response,
      receivedAt: "2026-07-27T00:01:00.000Z",
    });
    const replay = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response,
      receivedAt: "2026-07-27T00:02:00.000Z",
    });
    const runnable = await store.listIncomingRunnable(PROJECT_ID, "2026-07-27T00:01:00.000Z");
    if (!runnable.ok) {
      throw runnable.error;
    }
    const raw = await executor.select<{ vector_json: string }>(
      "SELECT vector_json FROM sync_inbox_operations ORDER BY operation_id",
    );

    expect(first).toMatchObject({
      ok: true,
      value: {
        created: true,
        operationCount: 2,
        chunkCount: 1,
        tombstoneCount: 1,
        checkpoint: { signedRemoteCursor: "signed_cursor_1", revision: 1 },
      },
    });
    expect(replay).toMatchObject({
      ok: true,
      value: {
        created: false,
        operationCount: 2,
        checkpoint: { signedRemoteCursor: "signed_cursor_1", revision: 1 },
      },
    });
    expect(runnable.value).toMatchObject([
      {
        operation: { operationId: OPERATION_ID },
        chunks: [{ chunkId: CHUNK_ID }],
        tombstone: null,
        status: "received",
      },
      {
        operation: { operationId: OTHER_OPERATION_ID, kind: "delete" },
        chunks: [],
        tombstone: { objectId: OTHER_OBJECT_ID },
        status: "received",
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain("仅密文进入收件箱");
  });

  it("rejects a transport hash mismatch before advancing or persisting the batch", async () => {
    const chunk = await createChunk("摘要不匹配", {
      chunkId: CHUNK_ID,
      objectId: OBJECT_ID,
      versionId: VERSION_ID,
    });
    const tampered: StoredEncryptedChunk = {
      ...chunk,
      encrypted: {
        ...chunk.encrypted,
        ciphertextSha256: "0".repeat(64),
      },
    };
    const result = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response: createResponse({
        operations: [
          createOperation({
            operationId: OPERATION_ID,
            deviceId: DEVICE_ID,
            deviceSequence: 1,
            objectId: OBJECT_ID,
            chunkIds: [CHUNK_ID],
          }),
        ],
        chunks: [tampered],
        nextCursor: "signed_cursor_1",
      }),
      receivedAt: NOW,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { signedRemoteCursor: null, revision: 0 },
    });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_incoming_batches"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_ciphertext_chunks"),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("rolls back every staged row when a persisted device sequence conflicts", async () => {
    const firstChunk = await createChunk("第一批", {
      chunkId: CHUNK_ID,
      objectId: OBJECT_ID,
      versionId: VERSION_ID,
    });
    await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response: createResponse({
        operations: [
          createOperation({
            operationId: OPERATION_ID,
            deviceId: DEVICE_ID,
            deviceSequence: 1,
            objectId: OBJECT_ID,
            chunkIds: [CHUNK_ID],
          }),
        ],
        chunks: [firstChunk],
        nextCursor: "signed_cursor_1",
      }),
      receivedAt: NOW,
    });
    const wrongCursorChunk = await createChunk("过期游标不得写入", {
      chunkId: THIRD_CHUNK_ID,
      objectId: THIRD_OBJECT_ID,
      versionId: OTHER_VERSION_ID,
    });
    const cursorMismatch = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: "signed_cursor_stale",
      response: createResponse({
        operations: [
          createOperation({
            operationId: THIRD_OPERATION_ID,
            deviceId: OTHER_DEVICE_ID,
            deviceSequence: 1,
            objectId: THIRD_OBJECT_ID,
            chunkIds: [THIRD_CHUNK_ID],
          }),
        ],
        chunks: [wrongCursorChunk],
        nextCursor: "signed_cursor_wrong",
      }),
      receivedAt: "2026-07-27T00:00:30.000Z",
    });
    expect(cursorMismatch).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_ciphertext_chunks WHERE chunk_id = ?",
        [THIRD_CHUNK_ID],
      ),
    ).resolves.toEqual([{ count: 0 }]);

    const conflictingChunk = await createChunk("第二批必须整体回滚", {
      chunkId: OTHER_CHUNK_ID,
      objectId: OTHER_OBJECT_ID,
      versionId: OTHER_VERSION_ID,
    });
    const result = await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: "signed_cursor_1",
      response: createResponse({
        operations: [
          createOperation({
            operationId: OTHER_OPERATION_ID,
            deviceId: DEVICE_ID,
            deviceSequence: 1,
            objectId: OTHER_OBJECT_ID,
            chunkIds: [OTHER_CHUNK_ID],
          }),
        ],
        chunks: [conflictingChunk],
        nextCursor: "signed_cursor_2",
      }),
      receivedAt: "2026-07-27T00:01:00.000Z",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "REPOSITORY_ERROR" } });
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { signedRemoteCursor: "signed_cursor_1", revision: 1 },
    });
    await expect(
      executor.select<{ count: number }>(
        `SELECT count(*) AS count
         FROM sync_incoming_batches
         WHERE next_signed_remote_cursor = 'signed_cursor_2'`,
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_ciphertext_chunks WHERE chunk_id = ?",
        [OTHER_CHUNK_ID],
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_inbox_operations WHERE operation_id = ?",
        [OTHER_OPERATION_ID],
      ),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("claims same-batch operations in response order instead of operation-id order", async () => {
    const first = createOperation({
      operationId: OTHER_OPERATION_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 1,
      objectId: OTHER_OBJECT_ID,
      kind: "delete",
    });
    const second = createOperation({
      operationId: OPERATION_ID,
      deviceId: OTHER_DEVICE_ID,
      deviceSequence: 1,
      objectId: OBJECT_ID,
      kind: "delete",
    });
    await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response: createResponse({
        operations: [first, second],
        tombstones: [createTombstone(first), createTombstone(second)],
        nextCursor: "signed_cursor_1",
      }),
      receivedAt: NOW,
    });
    const firstClaim = await store.claimNextIncoming({
      projectId: PROJECT_ID,
      ownerId: OWNER_ID,
      leaseToken: LEASE_ID,
      now: "2026-07-27T00:01:00.000Z",
      leaseExpiresAt: "2026-07-27T00:02:00.000Z",
    });
    expect(firstClaim).toMatchObject({
      ok: true,
      value: { operation: { operationId: OTHER_OPERATION_ID } },
    });
    await store.markIncomingApplied({
      operationId: OTHER_OPERATION_ID,
      leaseToken: LEASE_ID,
      now: "2026-07-27T00:01:30.000Z",
    });
    expect(
      await store.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: NEXT_LEASE_ID,
        now: "2026-07-27T00:01:31.000Z",
        leaseExpiresAt: "2026-07-27T00:02:31.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: { operationId: OPERATION_ID } },
    });
  });

  it("blocks a later incoming device sequence behind retry, lease, and conflict states", async () => {
    const first = createOperation({
      operationId: OPERATION_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 1,
      objectId: OBJECT_ID,
      kind: "delete",
    });
    const second = createOperation({
      operationId: OTHER_OPERATION_ID,
      deviceId: DEVICE_ID,
      deviceSequence: 2,
      objectId: OTHER_OBJECT_ID,
      kind: "delete",
    });
    await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response: createResponse({
        operations: [first, second],
        tombstones: [createTombstone(first), createTombstone(second)],
        nextCursor: "signed_cursor_1",
      }),
      receivedAt: NOW,
    });
    expect(
      await store.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_ID,
        now: "2026-07-27T00:01:00.000Z",
        leaseExpiresAt: "2026-07-27T00:02:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: { operationId: OPERATION_ID, deviceSequence: 1 } },
    });
    await expect(
      store.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: NEXT_LEASE_ID,
        now: "2026-07-27T00:01:30.000Z",
        leaseExpiresAt: "2026-07-27T00:02:30.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await store.markIncomingFailure({
      operationId: OPERATION_ID,
      leaseToken: LEASE_ID,
      failureCode: "DECRYPTION_RETRY",
      now: "2026-07-27T00:01:40.000Z",
      nextAttemptAt: "2026-07-27T00:03:00.000Z",
    });
    await expect(
      store.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: NEXT_LEASE_ID,
        now: "2026-07-27T00:02:30.000Z",
        leaseExpiresAt: "2026-07-27T00:03:30.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(
      await store.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: NEXT_LEASE_ID,
        now: "2026-07-27T00:03:00.000Z",
        leaseExpiresAt: "2026-07-27T00:04:00.000Z",
      }),
    ).toMatchObject({ ok: true, value: { operation: { operationId: OPERATION_ID } } });
    await store.markIncomingConflict({
      operationId: OPERATION_ID,
      leaseToken: NEXT_LEASE_ID,
      conflictCode: "VERSION_VECTOR_CONFLICT",
      now: "2026-07-27T00:03:30.000Z",
    });
    await expect(
      store.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: THIRD_LEASE_ID,
        now: "2026-07-27T00:04:00.000Z",
        leaseExpiresAt: "2026-07-27T00:05:00.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(
      store.listIncomingRunnable(PROJECT_ID, "2026-07-27T00:04:00.000Z"),
    ).resolves.toEqual({ ok: true, value: [] });
  });

  it("recovers an expired crash lease and resolves applied, conflict, and failure idempotently", async () => {
    const firstChunk = await createChunk("崩溃恢复一", {
      chunkId: CHUNK_ID,
      objectId: OBJECT_ID,
      versionId: VERSION_ID,
    });
    const secondChunk = await createChunk("崩溃恢复二", {
      chunkId: THIRD_CHUNK_ID,
      objectId: THIRD_OBJECT_ID,
      versionId: OTHER_VERSION_ID,
    });
    await store.stageIncomingSyncBatch({
      projectId: PROJECT_ID,
      priorSignedRemoteCursor: null,
      response: createResponse({
        operations: [
          createOperation({
            operationId: OPERATION_ID,
            deviceId: DEVICE_ID,
            deviceSequence: 1,
            objectId: OBJECT_ID,
            chunkIds: [CHUNK_ID],
          }),
          createOperation({
            operationId: THIRD_OPERATION_ID,
            deviceId: OTHER_DEVICE_ID,
            deviceSequence: 1,
            objectId: THIRD_OBJECT_ID,
            chunkIds: [THIRD_CHUNK_ID],
          }),
        ],
        chunks: [firstChunk, secondChunk],
        nextCursor: "signed_cursor_1",
      }),
      receivedAt: NOW,
    });

    const firstClaim = await store.claimNextIncoming({
      projectId: PROJECT_ID,
      ownerId: OWNER_ID,
      leaseToken: LEASE_ID,
      now: "2026-07-27T00:01:00.000Z",
      leaseExpiresAt: "2026-07-27T00:02:00.000Z",
    });
    if (!firstClaim.ok) {
      throw firstClaim.error;
    }
    expect(firstClaim).toMatchObject({
      ok: true,
      value: { operation: { operationId: OPERATION_ID }, attempt: 1 },
    });
    const restartedStore = new SyncSqliteStore(executor);
    expect(
      await restartedStore.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: NEXT_LEASE_ID,
        now: "2026-07-27T00:02:00.000Z",
        leaseExpiresAt: "2026-07-27T00:03:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: { operationId: OPERATION_ID }, attempt: 2 },
    });
    expect(
      await restartedStore.markIncomingApplied({
        operationId: OPERATION_ID,
        leaseToken: LEASE_ID,
        now: "2026-07-27T00:02:30.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(
      await restartedStore.markIncomingFailure({
        operationId: OPERATION_ID,
        leaseToken: NEXT_LEASE_ID,
        failureCode: "DECRYPTION_RETRY",
        nextAttemptAt: "2026-07-27T00:04:00.000Z",
        now: "2026-07-27T00:02:30.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await restartedStore.markIncomingFailure({
        operationId: OPERATION_ID,
        leaseToken: NEXT_LEASE_ID,
        failureCode: "DECRYPTION_RETRY",
        nextAttemptAt: "2026-07-27T00:04:00.000Z",
        now: "2026-07-27T00:02:30.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await restartedStore.listIncomingRunnable(PROJECT_ID, "2026-07-27T00:03:59.000Z"),
    ).toMatchObject({
      ok: true,
      value: [{ operation: { operationId: THIRD_OPERATION_ID } }],
    });

    expect(
      await restartedStore.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: THIRD_LEASE_ID,
        now: "2026-07-27T00:03:00.000Z",
        leaseExpiresAt: "2026-07-27T00:03:30.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: { operationId: THIRD_OPERATION_ID }, attempt: 1 },
    });
    expect(
      await restartedStore.markIncomingApplied({
        operationId: THIRD_OPERATION_ID,
        leaseToken: THIRD_LEASE_ID,
        now: "2026-07-27T00:03:15.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await restartedStore.markIncomingApplied({
        operationId: THIRD_OPERATION_ID,
        leaseToken: THIRD_LEASE_ID,
        now: "2026-07-27T00:03:15.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });

    expect(
      await restartedStore.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: FOURTH_LEASE_ID,
        now: "2026-07-27T00:04:00.000Z",
        leaseExpiresAt: "2026-07-27T00:05:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: { operationId: OPERATION_ID }, attempt: 3 },
    });
    expect(
      await restartedStore.markIncomingConflict({
        operationId: OPERATION_ID,
        leaseToken: FOURTH_LEASE_ID,
        conflictCode: "VERSION_VECTOR_CONFLICT",
        now: "2026-07-27T00:04:30.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await restartedStore.markIncomingConflict({
        operationId: OPERATION_ID,
        leaseToken: FOURTH_LEASE_ID,
        conflictCode: "VERSION_VECTOR_CONFLICT",
        now: "2026-07-27T00:04:30.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      await restartedStore.listIncomingRunnable(PROJECT_ID, "2026-07-27T00:06:00.000Z"),
    ).toEqual({
      ok: true,
      value: [],
    });
  });
});

function createOperation(input: {
  readonly operationId: string;
  readonly deviceId: string;
  readonly deviceSequence: number;
  readonly objectId: string;
  readonly kind?: "upsert" | "delete";
  readonly chunkIds?: readonly string[];
}): SyncOperationContract {
  return {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId: input.operationId,
    projectId: PROJECT_ID,
    deviceId: input.deviceId,
    deviceSequence: input.deviceSequence,
    objectType: "chapter_version",
    objectId: input.objectId,
    objectGeneration: 1,
    kind: input.kind ?? "upsert",
    vector: { [input.deviceId]: input.deviceSequence },
    encryptedChunkIds: [...(input.chunkIds ?? [])],
    createdAt: NOW,
  };
}

function createTombstone(operation: SyncOperationContract): SyncTombstoneContract {
  return {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    projectId: operation.projectId,
    objectType: operation.objectType,
    objectId: operation.objectId,
    objectGeneration: operation.objectGeneration,
    deletedByDeviceId: operation.deviceId,
    vector: operation.vector,
    deletedAt: operation.createdAt,
    retainUntil: "2027-07-27T00:00:00.000Z",
    acknowledgedDeviceIds: [],
  };
}

function createResponse(input: {
  readonly operations: readonly SyncOperationContract[];
  readonly chunks?: readonly StoredEncryptedChunk[];
  readonly tombstones?: readonly SyncTombstoneContract[];
  readonly nextCursor: string;
}): CloudSyncPullResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    operations: [...input.operations],
    chunks: (input.chunks ?? []).map(({ chunkId, encrypted }) => ({ chunkId, encrypted })),
    tombstones: [...(input.tombstones ?? [])],
    nextCursor: input.nextCursor,
    hasMore: false,
  };
}

async function createChunk(
  plaintext: string,
  input: {
    readonly chunkId: string;
    readonly objectId: string;
    readonly versionId: string;
  },
): Promise<StoredEncryptedChunk> {
  const cipher = new AesGcmChunkCipher();
  const key = await cipher.generateProjectDataKey();
  const encrypted = await cipher.encrypt(key, new TextEncoder().encode(plaintext), {
    projectId: PROJECT_ID,
    objectType: "chapter_version",
    objectId: input.objectId,
    versionId: input.versionId,
    chunkIndex: 0,
    keyVersion: 1,
  });
  return {
    chunkId: input.chunkId,
    encrypted: encrypted as EncryptedSyncChunkContract,
    createdAt: NOW,
  };
}
