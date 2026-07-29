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

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000201";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000202";
const OWNER_ID = "019f9f4a-b3c7-7350-9226-000000000203";
const LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000204";
const UPSERT_OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000205";
const DELETE_OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000206";
const OLD_CHUNK_ID = "019f9f4a-b3c7-7350-9226-000000000207";
const SNAPSHOT_CHUNK_ID = "019f9f4a-b3c7-7350-9226-000000000208";
const OUTBOX_CHUNK_ID = "019f9f4a-b3c7-7350-9226-000000000209";
const OLD_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000210";
const UPSERT_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000211";
const DELETE_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000212";
const OUTBOX_OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000213";
const OLD_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000214";
const SNAPSHOT_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000215";
const OUTBOX_VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000216";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000217";
const SNAPSHOT_ID = "snapshot_2026_epoch_7";
const NEXT_SNAPSHOT_ID = "snapshot_2026_epoch_8";
const SNAPSHOT_REMOTE_CURSOR = "remote_snapshot_head_7";
const SNAPSHOT_EXPIRES_AT = "2026-07-29T00:00:00.000Z";
const NOW = "2026-07-28T00:00:00.000Z";

describe("0013 sync snapshot staging migration", () => {
  it("is repeatable and creates a separate ciphertext-only staging schema", () => {
    const executor = new NodeSqliteExecutor(
      `${migration}\n${readFileSync(
        new URL("../migrations/0013_sync_snapshot_staging.sql", import.meta.url),
        "utf8",
      )}`,
    );
    const tables = executor.database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'sync_snapshot_staging_%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(tables.map(({ name }) => name)).toEqual([
      "sync_snapshot_staging_chunks",
      "sync_snapshot_staging_operation_chunks",
      "sync_snapshot_staging_operations",
      "sync_snapshot_staging_pages",
      "sync_snapshot_staging_sessions",
      "sync_snapshot_staging_tombstones",
    ]);
    const forbidden = tables.flatMap(({ name }) =>
      (
        executor.database.prepare(`PRAGMA table_info(${name})`).all() as {
          name: string;
        }[]
      )
        .map((column) => column.name)
        .filter((column) =>
          [
            "access_token",
            "content",
            "private_key",
            "prompt",
            "raw_project_data_key",
            "recovery_code",
            "refresh_token",
          ].includes(column),
        ),
    );
    expect(forbidden).toEqual([]);
    for (const table of ["sync_snapshot_staging_pages", "sync_snapshot_staging_sessions"]) {
      const columns = executor.database.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        notnull: number;
      }[];
      expect(columns).toContainEqual(
        expect.objectContaining({
          name: "snapshot_signed_remote_cursor",
          notnull: 1,
        }),
      );
      expect(columns).toContainEqual(
        expect.objectContaining({
          name: "snapshot_expires_at",
          notnull: 1,
        }),
      );
    }
    expect(executor.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    executor.database.close();
  });
});

describe("SyncSqliteStore atomic snapshot staging", () => {
  let executor: NodeSqliteExecutor;
  let store: SyncSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    await executor.execute("PRAGMA foreign_keys = ON");
    store = new SyncSqliteStore(executor);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "Snapshot project", NOW, NOW],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("stages exact ordered pages idempotently and atomically replaces the remote baseline", async () => {
    const oldChunk = await createChunk("old baseline", {
      chunkId: OLD_CHUNK_ID,
      objectId: OLD_OBJECT_ID,
      versionId: OLD_VERSION_ID,
    });
    await insertBaselineChunk(executor, oldChunk);
    const oldDelete = createOperation({
      operationId: DELETE_OPERATION_ID,
      deviceSequence: 1,
      objectId: OLD_OBJECT_ID,
      kind: "delete",
    });
    await insertBaselineTombstone(executor, createTombstone(oldDelete));

    const snapshotChunk = await createChunk("new encrypted baseline", {
      chunkId: SNAPSHOT_CHUNK_ID,
      objectId: UPSERT_OBJECT_ID,
      versionId: SNAPSHOT_VERSION_ID,
    });
    const firstOperation = createOperation({
      operationId: UPSERT_OPERATION_ID,
      deviceSequence: 10,
      objectId: UPSERT_OBJECT_ID,
      chunkIds: [SNAPSHOT_CHUNK_ID],
    });
    const firstPage = {
      snapshotId: SNAPSHOT_ID,
      projectId: PROJECT_ID,
      epoch: 7,
      pageIndex: 0,
      resumeCursor: null,
      snapshotSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
      snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
      nextSnapshotCursor: "snapshot_resume_1",
      finalSignedRemoteCursor: null,
      operations: [firstOperation],
      chunks: [{ chunkId: snapshotChunk.chunkId, encrypted: snapshotChunk.encrypted }],
      tombstones: [],
      receivedAt: NOW,
    } as const;
    const stagedFirst = await store.stageSyncSnapshotPage(firstPage);
    expect(stagedFirst).toMatchObject({
      ok: true,
      value: {
        created: true,
        pageIndex: 0,
        snapshot: {
          state: "staging",
          snapshotSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
          snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
          nextPageIndex: 1,
          nextSnapshotCursor: "snapshot_resume_1",
          pagesComplete: false,
          operationCount: 1,
          chunkCount: 1,
        },
      },
    });
    const replayedFirst = await store.stageSyncSnapshotPage({
      ...firstPage,
      receivedAt: "2026-07-28T00:01:00.000Z",
    });
    expect(replayedFirst).toMatchObject({
      ok: true,
      value: { created: false, pageDigest: stagedFirst.ok ? stagedFirst.value.pageDigest : "" },
    });
    expect(
      await store.stageSyncSnapshotPage({
        ...firstPage,
        snapshotSignedRemoteCursor: "remote_snapshot_tampered_head",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(
      await store.stageSyncSnapshotPage({
        ...firstPage,
        snapshotExpiresAt: "2026-07-29T00:01:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(
      await store.stageSyncSnapshotPage({
        ...firstPage,
        nextSnapshotCursor: "snapshot_resume_tampered",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(
      await store.stageSyncSnapshotPage({
        ...firstPage,
        pageIndex: 2,
        resumeCursor: "snapshot_resume_wrong",
        nextSnapshotCursor: "snapshot_resume_3",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { revision: 0, signedRemoteCursor: null },
    });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_incoming_batches"),
    ).resolves.toEqual([{ count: 0 }]);

    expect(
      await store.stageSyncSnapshotPage({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
        pageIndex: 1,
        resumeCursor: "snapshot_resume_1",
        snapshotSignedRemoteCursor: "remote_snapshot_changed_head",
        snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
        nextSnapshotCursor: "snapshot_resume_2",
        finalSignedRemoteCursor: null,
        operations: [firstOperation],
        chunks: [{ chunkId: snapshotChunk.chunkId, encrypted: snapshotChunk.encrypted }],
        tombstones: [],
        receivedAt: "2026-07-28T00:01:30.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_pages",
      ),
    ).resolves.toEqual([{ count: 1 }]);

    const deleteOperation = createOperation({
      operationId: DELETE_OPERATION_ID,
      deviceSequence: 11,
      objectId: DELETE_OBJECT_ID,
      kind: "delete",
    });
    expect(
      await store.stageSyncSnapshotPage({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
        pageIndex: 1,
        resumeCursor: "snapshot_resume_1",
        snapshotSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
        snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
        nextSnapshotCursor: null,
        finalSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
        operations: [deleteOperation],
        chunks: [],
        tombstones: [createTombstone(deleteOperation)],
        receivedAt: "2026-07-28T00:02:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        created: true,
        snapshot: {
          pagesComplete: true,
          snapshotSignedRemoteCursor: SNAPSHOT_REMOTE_CURSOR,
          snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
          nextPageIndex: 2,
          operationCount: 2,
          chunkCount: 1,
          tombstoneCount: 1,
        },
      },
    });
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { revision: 0, signedRemoteCursor: null },
    });

    const committed = await store.commitStagedSyncSnapshot({
      snapshotId: SNAPSHOT_ID,
      projectId: PROJECT_ID,
      epoch: 7,
      now: "2026-07-28T00:03:00.000Z",
    });
    expect(committed).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        operationCount: 2,
        chunkCount: 1,
        tombstoneCount: 1,
        checkpoint: {
          signedRemoteCursor: "remote_snapshot_head_7",
          revision: 1,
        },
      },
    });
    await expect(
      executor.select<{ chunk_id: string }>(
        "SELECT chunk_id FROM sync_ciphertext_chunks WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ chunk_id: SNAPSHOT_CHUNK_ID }]);
    await expect(
      executor.select<{ object_id: string }>(
        "SELECT object_id FROM sync_tombstones WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ object_id: DELETE_OBJECT_ID }]);
    await expect(
      executor.select<{ last_allocated_sequence: number }>(
        `SELECT last_allocated_sequence
         FROM sync_device_sequences
         WHERE project_id = ? AND device_id = ?`,
        [PROJECT_ID, DEVICE_ID],
      ),
    ).resolves.toEqual([{ last_allocated_sequence: 11 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_operations",
      ),
    ).resolves.toEqual([{ count: 2 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_chunks",
      ),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_tombstones",
      ),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_pages",
      ),
    ).resolves.toEqual([{ count: 2 }]);

    expect(
      await store.commitStagedSyncSnapshot({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
        now: "2026-07-28T00:04:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        replayed: true,
        checkpoint: {
          signedRemoteCursor: "remote_snapshot_head_7",
          revision: 1,
          updatedAt: "2026-07-28T00:03:00.000Z",
        },
      },
    });
    expect(
      await store.stageSyncSnapshotPage({
        snapshotId: NEXT_SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 8,
        pageIndex: 0,
        resumeCursor: null,
        snapshotSignedRemoteCursor: "remote_snapshot_head_8",
        snapshotExpiresAt: "2026-07-30T00:00:00.000Z",
        nextSnapshotCursor: null,
        finalSignedRemoteCursor: "remote_snapshot_head_8",
        operations: [],
        chunks: [],
        tombstones: [],
        receivedAt: "2026-07-28T00:05:00.000Z",
      }),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: expect.stringContaining("awaiting plaintext materialization"),
      },
    });
  });

  it("blocks commit on a non-empty outbox and can discard every staged row", async () => {
    const outboxChunk = await createChunk("pending local mutation", {
      chunkId: OUTBOX_CHUNK_ID,
      objectId: OUTBOX_OBJECT_ID,
      versionId: OUTBOX_VERSION_ID,
    });
    expect(
      await store.enqueue({
        operation: createOperation({
          operationId: UPSERT_OPERATION_ID,
          deviceSequence: 1,
          objectId: OUTBOX_OBJECT_ID,
          chunkIds: [OUTBOX_CHUNK_ID],
        }),
        chunks: [outboxChunk],
        now: NOW,
      }),
    ).toMatchObject({ ok: true });
    await stageEmptyFinalSnapshot(store);

    expect(
      await store.commitStagedSyncSnapshot({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
        now: "2026-07-28T00:01:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { revision: 0, signedRemoteCursor: null },
    });
    expect(
      await store.discardStagedSyncSnapshot({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
      }),
    ).toEqual({ ok: true, value: { snapshotId: SNAPSHOT_ID, discarded: true } });
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_snapshot_staging_pages",
      ),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("prunes acknowledged outbox history before replacing its ciphertext baseline", async () => {
    const outboxChunk = await createChunk("acknowledged local mutation", {
      chunkId: OUTBOX_CHUNK_ID,
      objectId: OUTBOX_OBJECT_ID,
      versionId: OUTBOX_VERSION_ID,
    });
    expect(
      await store.enqueue({
        operation: createOperation({
          operationId: UPSERT_OPERATION_ID,
          deviceSequence: 1,
          objectId: OUTBOX_OBJECT_ID,
          chunkIds: [OUTBOX_CHUNK_ID],
        }),
        chunks: [outboxChunk],
        now: NOW,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.claimNextForProject({
        projectId: PROJECT_ID,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_ID,
        now: "2026-07-28T00:00:30.000Z",
        leaseExpiresAt: "2026-07-28T00:01:30.000Z",
      }),
    ).toMatchObject({ ok: true, value: { operation: { operationId: UPSERT_OPERATION_ID } } });
    expect(
      await store.acknowledge(UPSERT_OPERATION_ID, LEASE_ID, "2026-07-28T00:01:00.000Z"),
    ).toEqual({ ok: true, value: undefined });
    await stageEmptyFinalSnapshot(store);

    expect(
      await store.commitStagedSyncSnapshot({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
        now: "2026-07-28T00:03:00.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        checkpoint: { signedRemoteCursor: "remote_snapshot_empty_head", revision: 1 },
      },
    });
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_outbox_operations WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_ciphertext_chunks WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("refuses to commit a complete ciphertext baseline after its signed snapshot expires", async () => {
    await stageEmptyFinalSnapshot(store);

    expect(
      await store.commitStagedSyncSnapshot({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
        now: SNAPSHOT_EXPIRES_AT,
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { revision: 0, signedRemoteCursor: null },
    });
    expect(await store.readStagedSyncSnapshot(PROJECT_ID)).toMatchObject({
      ok: true,
      value: {
        state: "staging",
        pagesComplete: true,
        snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
      },
    });
  });

  it("blocks commit while an incoming conflict remains unresolved", async () => {
    const conflictOperation = createOperation({
      operationId: DELETE_OPERATION_ID,
      deviceSequence: 1,
      objectId: DELETE_OBJECT_ID,
      kind: "delete",
    });
    expect(
      await store.stageIncomingSyncBatch({
        projectId: PROJECT_ID,
        priorSignedRemoteCursor: null,
        response: createPullResponse(
          [conflictOperation],
          [],
          [createTombstone(conflictOperation)],
          "ordinary_remote_cursor_1",
        ),
        receivedAt: NOW,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_ID,
        now: "2026-07-28T00:01:00.000Z",
        leaseExpiresAt: "2026-07-28T00:02:00.000Z",
      }),
    ).toMatchObject({ ok: true, value: { operation: { operationId: DELETE_OPERATION_ID } } });
    expect(
      await store.markIncomingConflict({
        operationId: DELETE_OPERATION_ID,
        leaseToken: LEASE_ID,
        conflictCode: "VERSION_VECTOR_CONFLICT",
        now: "2026-07-28T00:01:30.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });
    await stageEmptyFinalSnapshot(store);

    expect(
      await store.commitStagedSyncSnapshot({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
        now: "2026-07-28T00:03:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { revision: 1, signedRemoteCursor: "ordinary_remote_cursor_1" },
    });
  });

  it("rolls back baseline replacement when the ordinary checkpoint changes mid-snapshot", async () => {
    const oldChunk = await createChunk("baseline survives stale commit", {
      chunkId: OLD_CHUNK_ID,
      objectId: OLD_OBJECT_ID,
      versionId: OLD_VERSION_ID,
    });
    await insertBaselineChunk(executor, oldChunk);
    await stageEmptyFinalSnapshot(store);
    expect(
      await store.compareAndSwapRemoteCheckpoint({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        expectedSignedRemoteCursor: null,
        nextSignedRemoteCursor: "concurrent_remote_cursor",
        now: "2026-07-28T00:02:30.000Z",
      }),
    ).toMatchObject({ ok: true, value: { revision: 1 } });

    expect(
      await store.commitStagedSyncSnapshot({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 7,
        now: "2026-07-28T00:03:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    await expect(
      executor.select<{ chunk_id: string }>(
        "SELECT chunk_id FROM sync_ciphertext_chunks WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ chunk_id: OLD_CHUNK_ID }]);
    expect(await store.readRemoteCheckpoint(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { revision: 1, signedRemoteCursor: "concurrent_remote_cursor" },
    });
    expect(await store.readStagedSyncSnapshot(PROJECT_ID)).toMatchObject({
      ok: true,
      value: { state: "staging", pagesComplete: true },
    });
  });
});

function createOperation(input: {
  readonly operationId: string;
  readonly deviceSequence: number;
  readonly objectId: string;
  readonly kind?: "upsert" | "delete";
  readonly chunkIds?: readonly string[];
}): SyncOperationContract {
  return {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId: input.operationId,
    projectId: PROJECT_ID,
    deviceId: DEVICE_ID,
    deviceSequence: input.deviceSequence,
    objectType: "chapter_version",
    objectId: input.objectId,
    objectGeneration: 1,
    kind: input.kind ?? "upsert",
    vector: { [DEVICE_ID]: input.deviceSequence },
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
    retainUntil: "2027-07-28T00:00:00.000Z",
    acknowledgedDeviceIds: [],
  };
}

function createPullResponse(
  operations: readonly SyncOperationContract[],
  chunks: readonly StoredEncryptedChunk[],
  tombstones: readonly SyncTombstoneContract[],
  nextCursor: string,
): CloudSyncPullResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    operations: [...operations],
    chunks: chunks.map(({ chunkId, encrypted }) => ({ chunkId, encrypted })),
    tombstones: [...tombstones],
    nextCursor,
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

async function insertBaselineChunk(
  executor: NodeSqliteExecutor,
  chunk: StoredEncryptedChunk,
): Promise<void> {
  const encrypted = chunk.encrypted;
  await executor.execute(
    `INSERT INTO sync_ciphertext_chunks (
       chunk_id, project_id, object_type, object_id, version_id, chunk_index,
       key_version, algorithm, nonce, ciphertext, ciphertext_sha256,
       plaintext_bytes, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chunk.chunkId,
      encrypted.aad.projectId,
      encrypted.aad.objectType,
      encrypted.aad.objectId,
      encrypted.aad.versionId,
      encrypted.aad.chunkIndex,
      encrypted.aad.keyVersion,
      encrypted.algorithm,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.ciphertextSha256,
      encrypted.plaintextBytes,
      chunk.createdAt,
    ],
  );
}

async function insertBaselineTombstone(
  executor: NodeSqliteExecutor,
  tombstone: SyncTombstoneContract,
): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_tombstones (
       project_id, object_type, object_id, object_generation, deleted_by_device_id,
       vector_json, deleted_at, retain_until, acknowledged_device_ids_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tombstone.projectId,
      tombstone.objectType,
      tombstone.objectId,
      tombstone.objectGeneration,
      tombstone.deletedByDeviceId,
      JSON.stringify(tombstone.vector),
      tombstone.deletedAt,
      tombstone.retainUntil,
      JSON.stringify(tombstone.acknowledgedDeviceIds),
      NOW,
    ],
  );
}

async function stageEmptyFinalSnapshot(store: SyncSqliteStore): Promise<void> {
  expect(
    await store.stageSyncSnapshotPage({
      snapshotId: SNAPSHOT_ID,
      projectId: PROJECT_ID,
      epoch: 7,
      pageIndex: 0,
      resumeCursor: null,
      snapshotSignedRemoteCursor: "remote_snapshot_empty_head",
      snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
      nextSnapshotCursor: null,
      finalSignedRemoteCursor: "remote_snapshot_empty_head",
      operations: [],
      chunks: [],
      tombstones: [],
      receivedAt: "2026-07-28T00:02:00.000Z",
    }),
  ).toMatchObject({ ok: true, value: { snapshot: { pagesComplete: true } } });
}
