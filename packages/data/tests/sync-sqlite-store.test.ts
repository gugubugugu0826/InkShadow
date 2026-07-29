import { readFileSync } from "node:fs";

import {
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type EncryptedSyncChunkContract,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";
import { AesGcmChunkCipher } from "@inkshadow/sync-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SyncSqliteStore,
  enqueueSyncDeleteOperationInTransaction,
  enqueueSyncOperationInTransaction,
  type StoredEncryptedChunk,
} from "../src/sync-sqlite-store.js";
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
].join("\n");

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const CHUNK_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const OWNER_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000008";
const NEXT_LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000009";
const THIRD_LEASE_ID = "019f9f4a-b3c7-7350-9226-000000000010";
const OTHER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000011";
const TRANSFER_ID = "019f9f4a-b3c7-7350-9226-000000000012";
const NOW = "2026-07-27T00:00:00.000Z";

describe("SyncSqliteStore", () => {
  let executor: NodeSqliteExecutor;
  let store: SyncSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    store = new SyncSqliteStore(executor);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "同步测试", NOW, NOW],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("atomically enqueues ciphertext-only operations and enforces idempotency", async () => {
    const chunk = await createChunk("正文只能以密文进入同步表。");
    const operation = createUpsertOperation([CHUNK_ID]);

    const first = await store.enqueue({ operation, chunks: [chunk], now: NOW });
    const duplicate = await store.enqueue({ operation, chunks: [chunk], now: NOW });
    const record = await store.findOutbox(OPERATION_ID);
    const rawRows = await executor.select<{ ciphertext: string }>(
      "SELECT ciphertext FROM sync_ciphertext_chunks",
    );

    expect(first).toEqual({
      ok: true,
      value: { operationId: OPERATION_ID, created: true },
    });
    expect(duplicate).toEqual({
      ok: true,
      value: { operationId: OPERATION_ID, created: false },
    });
    expect(record).toMatchObject({
      ok: true,
      value: {
        operation: { operationId: OPERATION_ID, encryptedChunkIds: [CHUNK_ID] },
        status: "queued",
        attempt: 0,
      },
    });
    expect(JSON.stringify(rawRows)).not.toContain("正文只能");

    const changedChunk = await createChunk("同一标识不能替换为另一段密文。");
    const conflict = await store.enqueue({
      operation,
      chunks: [changedChunk],
      now: NOW,
    });
    expect(conflict).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("rolls back when ciphertext AAD does not match the operation", async () => {
    const mismatched = await createChunk("密文", {
      objectId: "019f9f4a-b3c7-7350-9226-000000000013",
    });

    const result = await store.enqueue({
      operation: createUpsertOperation([CHUNK_ID]),
      chunks: [mismatched],
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_ciphertext_chunks"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_outbox_operations"),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("lets a caller roll back an atomic outbox enqueue with adjacent projection state", async () => {
    const chunk = await createChunk("atomic ciphertext");
    const input = {
      operation: createUpsertOperation([CHUNK_ID]),
      chunks: [chunk],
      now: NOW,
    };

    await expect(
      executor.transaction(async (transaction) => {
        const enqueued = await enqueueSyncOperationInTransaction(transaction, input);
        if (!enqueued.ok) {
          throw enqueued.error;
        }
        throw new Error("ROLL_BACK_ADJACENT_STATE");
      }),
    ).rejects.toThrow("ROLL_BACK_ADJACENT_STATE");
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_outbox_operations"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_ciphertext_chunks"),
    ).resolves.toEqual([{ count: 0 }]);

    await expect(
      executor.transaction(async (transaction) => {
        const enqueued = await enqueueSyncOperationInTransaction(transaction, input);
        if (!enqueued.ok) {
          throw enqueued.error;
        }
        return enqueued.value;
      }),
    ).resolves.toEqual({ operationId: OPERATION_ID, created: true });
  });

  it("atomically enqueues an exact delete operation and retained tombstone", async () => {
    const operation: SyncOperationContract = {
      ...createUpsertOperation([]),
      deviceSequence: 2,
      objectGeneration: 2,
      kind: "delete",
      vector: { [DEVICE_ID]: 2 },
    };
    const tombstone: SyncTombstoneContract = {
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 2,
      deletedByDeviceId: DEVICE_ID,
      vector: { [DEVICE_ID]: 2 },
      deletedAt: NOW,
      retainUntil: "2027-07-27T00:00:00.000Z",
      acknowledgedDeviceIds: [],
    };

    await expect(
      executor.transaction(async (transaction) => {
        const result = await enqueueSyncDeleteOperationInTransaction(transaction, {
          operation,
          tombstone,
          now: NOW,
        });
        if (!result.ok) {
          throw result.error;
        }
        throw new Error("ROLL_BACK_DELETE_PAIR");
      }),
    ).rejects.toThrow("ROLL_BACK_DELETE_PAIR");
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_outbox_operations"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_tombstones"),
    ).resolves.toEqual([{ count: 0 }]);

    await expect(
      executor.transaction(async (transaction) => {
        const result = await enqueueSyncDeleteOperationInTransaction(transaction, {
          operation,
          tombstone,
          now: NOW,
        });
        if (!result.ok) {
          throw result.error;
        }
        return result.value;
      }),
    ).resolves.toEqual({ operationId: OPERATION_ID, created: true });
    expect(await store.findTombstone(PROJECT_ID, "chapter_version", OBJECT_ID, 2)).toMatchObject({
      ok: true,
      value: { objectGeneration: 2, acknowledgedDeviceIds: [] },
    });

    const mismatched = await executor.transaction((transaction) =>
      enqueueSyncDeleteOperationInTransaction(transaction, {
        operation: { ...operation, operationId: TRANSFER_ID },
        tombstone: { ...tombstone, vector: { [DEVICE_ID]: 3 } },
        now: NOW,
      }),
    );
    expect(mismatched).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  });

  it("rejects an operation whose object type differs from its ciphertext chunk", async () => {
    const mismatched = await createChunk("ciphertext", {
      objectType: "memory",
    });

    const result = await store.enqueue({
      operation: createUpsertOperation([CHUNK_ID]),
      chunks: [mismatched],
      now: NOW,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_ciphertext_chunks"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM sync_outbox_operations"),
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("recovers expired leases, reschedules safely, and rejects stale acknowledgements", async () => {
    const chunk = await createChunk("待同步正文");
    await store.enqueue({
      operation: createUpsertOperation([CHUNK_ID]),
      chunks: [chunk],
      now: NOW,
    });

    const firstClaim = await store.claimNext({
      ownerId: OWNER_ID,
      leaseToken: LEASE_ID,
      now: "2026-07-27T00:01:00.000Z",
      leaseExpiresAt: "2026-07-27T00:02:00.000Z",
    });
    expect(firstClaim).toMatchObject({
      ok: true,
      value: { status: "in_flight", attempt: 1, leaseToken: LEASE_ID },
    });

    const staleAck = await store.acknowledge(
      OPERATION_ID,
      NEXT_LEASE_ID,
      "2026-07-27T00:01:30.000Z",
    );
    expect(staleAck).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    await expect(
      store.claimNext({
        ownerId: OWNER_ID,
        leaseToken: NEXT_LEASE_ID,
        now: "2026-07-27T00:01:30.000Z",
        leaseExpiresAt: "2026-07-27T00:02:30.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(
      await store.acknowledge(OPERATION_ID, LEASE_ID, "2026-07-27T00:02:00.000Z"),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });

    const recovered = await store.claimNext({
      ownerId: OWNER_ID,
      leaseToken: NEXT_LEASE_ID,
      now: "2026-07-27T00:02:00.000Z",
      leaseExpiresAt: "2026-07-27T00:03:00.000Z",
    });
    expect(recovered).toMatchObject({
      ok: true,
      value: { status: "in_flight", attempt: 2, leaseToken: NEXT_LEASE_ID },
    });

    const failed = await store.rescheduleFailure({
      operationId: OPERATION_ID,
      leaseToken: NEXT_LEASE_ID,
      failureCode: "REMOTE_UNAVAILABLE",
      now: "2026-07-27T00:02:30.000Z",
      nextAttemptAt: "2026-07-27T00:04:00.000Z",
    });
    expect(failed).toEqual({ ok: true, value: undefined });
    await expect(store.listRunnable("2026-07-27T00:03:59.000Z")).resolves.toEqual({
      ok: true,
      value: [],
    });

    const thirdClaim = await store.claimNext({
      ownerId: OWNER_ID,
      leaseToken: THIRD_LEASE_ID,
      now: "2026-07-27T00:04:00.000Z",
      leaseExpiresAt: "2026-07-27T00:05:00.000Z",
    });
    expect(thirdClaim).toMatchObject({ ok: true, value: { attempt: 3 } });
    expect(
      await store.acknowledge(OPERATION_ID, THIRD_LEASE_ID, "2026-07-27T00:04:30.000Z"),
    ).toEqual({ ok: true, value: undefined });
    expect(await store.findOutbox(OPERATION_ID)).toMatchObject({
      ok: true,
      value: { status: "acknowledged", attempt: 3, failureCode: null },
    });
  });

  it("parks a permanently rejected outbox head without making it runnable again", async () => {
    const chunk = await createChunk("不可自动重试的同步正文");
    await store.enqueue({
      operation: createUpsertOperation([CHUNK_ID]),
      chunks: [chunk],
      now: NOW,
    });
    await store.claimNext({
      ownerId: OWNER_ID,
      leaseToken: LEASE_ID,
      now: "2026-07-27T00:01:00.000Z",
      leaseExpiresAt: "2026-07-27T00:02:00.000Z",
    });

    expect(
      await store.pauseFailure({
        operationId: OPERATION_ID,
        leaseToken: LEASE_ID,
        failureCode: "SYNC_INVALID_CIPHERTEXT",
        now: "2026-07-27T00:01:30.000Z",
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(await store.findOutbox(OPERATION_ID)).toMatchObject({
      ok: true,
      value: {
        status: "paused",
        nextAttemptAt: null,
        failureCode: "SYNC_INVALID_CIPHERTEXT",
      },
    });
    await expect(store.listRunnable("2027-07-27T00:00:00.000Z")).resolves.toEqual({
      ok: true,
      value: [],
    });
    await expect(
      store.claimNext({
        ownerId: OWNER_ID,
        leaseToken: NEXT_LEASE_ID,
        now: "2027-07-27T00:00:00.000Z",
        leaseExpiresAt: "2027-07-27T00:01:00.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(
      await store.pauseFailure({
        operationId: OPERATION_ID,
        leaseToken: LEASE_ID,
        failureCode: "SYNC_INVALID_CIPHERTEXT",
        now: "2026-07-27T00:01:31.000Z",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
  });

  it("persists observed tombstones and rejects stale generations", async () => {
    const tombstone: SyncTombstoneContract = {
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 2,
      deletedByDeviceId: DEVICE_ID,
      vector: { [DEVICE_ID]: 2 },
      deletedAt: NOW,
      retainUntil: "2027-07-27T00:00:00.000Z",
      acknowledgedDeviceIds: [DEVICE_ID],
    };

    expect(await store.saveTombstone(tombstone, NOW)).toEqual({
      ok: true,
      value: undefined,
    });
    const acknowledged = await store.acknowledgeTombstone({
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 2,
      deviceId: OTHER_DEVICE_ID,
      observedVector: { [DEVICE_ID]: 2 },
      now: "2026-07-27T00:01:00.000Z",
    });
    expect(acknowledged).toMatchObject({
      ok: true,
      value: { acknowledgedDeviceIds: [DEVICE_ID, OTHER_DEVICE_ID] },
    });

    const stale = await store.saveTombstone(
      { ...tombstone, objectGeneration: 1, vector: { [DEVICE_ID]: 1 } },
      "2026-07-27T00:02:00.000Z",
    );
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    expect(await store.findLatestTombstone(PROJECT_ID, "chapter_version", OBJECT_ID)).toMatchObject(
      {
        ok: true,
        value: {
          objectGeneration: 2,
          acknowledgedDeviceIds: [DEVICE_ID, OTHER_DEVICE_ID],
        },
      },
    );
  });

  it("reconstructs transfer progress and validates remote ciphertext receipts", async () => {
    const chunk = await createChunk("可断点续传");
    await store.enqueue({
      operation: createUpsertOperation([CHUNK_ID]),
      chunks: [chunk],
      now: NOW,
    });
    const ciphertextBytes = decodeBase64Url(chunk.encrypted.ciphertext).byteLength;
    const manifest = {
      transferId: TRANSFER_ID,
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      versionId: VERSION_ID,
      chunks: [
        {
          chunkId: CHUNK_ID,
          index: 0,
          ciphertextBytes,
          ciphertextSha256: chunk.encrypted.ciphertextSha256,
        },
      ],
    };

    expect(await store.createTransfer(manifest, NOW)).toMatchObject({
      ok: true,
      value: { created: true, progress: { acknowledgedChunks: 0, complete: false } },
    });
    const mismatch = await store.acknowledgeTransferChunk({
      transferId: TRANSFER_ID,
      chunkId: CHUNK_ID,
      receipt: {
        ciphertextSha256: "0".repeat(64),
        remoteETag: "etag-1",
      },
      now: "2026-07-27T00:01:00.000Z",
    });
    expect(mismatch).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });

    const completed = await store.acknowledgeTransferChunk({
      transferId: TRANSFER_ID,
      chunkId: CHUNK_ID,
      receipt: {
        ciphertextSha256: chunk.encrypted.ciphertextSha256,
        remoteETag: "etag-1",
      },
      now: "2026-07-27T00:02:00.000Z",
    });
    expect(completed).toMatchObject({
      ok: true,
      value: { acknowledgedChunks: 1, complete: true },
    });

    const reloaded = new SyncSqliteStore(executor);
    expect(await reloaded.loadTransfer(TRANSFER_ID)).toMatchObject({
      ok: true,
      value: { acknowledgedChunks: 1, acknowledgedBytes: ciphertextBytes, complete: true },
    });
    expect(await reloaded.createTransfer(manifest, "2026-07-27T00:03:00.000Z")).toMatchObject({
      ok: true,
      value: { created: false, progress: { complete: true } },
    });
    expect(await reloaded.health()).toMatchObject({
      ok: true,
      value: {
        ciphertextChunkCount: 1,
        tombstoneCount: 0,
        outboxByStatus: { queued: 1 },
        transfersByStatus: { completed: 1 },
      },
    });
  });
});

function createUpsertOperation(encryptedChunkIds: readonly string[]): SyncOperationContract {
  return {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId: OPERATION_ID,
    projectId: PROJECT_ID,
    deviceId: DEVICE_ID,
    deviceSequence: 1,
    objectType: "chapter_version",
    objectId: OBJECT_ID,
    objectGeneration: 1,
    kind: "upsert",
    vector: { [DEVICE_ID]: 1 },
    encryptedChunkIds: [...encryptedChunkIds],
    createdAt: NOW,
  };
}

async function createChunk(
  plaintext: string,
  overrides: Partial<{
    readonly projectId: string;
    readonly objectType: "chapter_version" | "memory";
    readonly objectId: string;
    readonly versionId: string;
  }> = {},
): Promise<StoredEncryptedChunk> {
  const cipher = new AesGcmChunkCipher();
  const key = await cipher.generateProjectDataKey();
  const encrypted = await cipher.encrypt(key, new TextEncoder().encode(plaintext), {
    projectId: overrides.projectId ?? PROJECT_ID,
    objectType: overrides.objectType ?? "chapter_version",
    objectId: overrides.objectId ?? OBJECT_ID,
    versionId: overrides.versionId ?? VERSION_ID,
    chunkIndex: 0,
    keyVersion: 1,
  });
  return {
    chunkId: CHUNK_ID,
    encrypted: encrypted as EncryptedSyncChunkContract,
    createdAt: NOW,
  };
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
