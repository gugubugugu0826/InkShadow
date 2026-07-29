import { readFileSync } from "node:fs";

import {
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type EncryptedSyncChunkContract,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";
import { type AppError, type Result } from "@inkshadow/domain";
import { AesGcmChunkCipher } from "@inkshadow/sync-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SyncSnapshotMaterializationSqliteStore,
  type SnapshotMaterializationWork,
} from "../src/sync-snapshot-materialization-sqlite-store.js";
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
    new URL("../migrations/0015_sync_materialization_authority.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0016_sync_snapshot_materialization_receipts.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../migrations/0018_sync_incremental_terminal_observations.sql", import.meta.url),
    "utf8",
  ),
].join("\n");

const PROJECT_ID = "019fa101-0000-7000-8000-000000000001";
const DEVICE_ID = "019fa101-0000-7000-8000-000000000002";
const SNAPSHOT_ID = "019fa101-0000-7000-8000-000000000003";
const UPSERT_OPERATION_ID = "019fa101-0000-7000-8000-000000000004";
const DELETE_OPERATION_ID = "019fa101-0000-7000-8000-000000000005";
const UPSERT_OBJECT_ID = "019fa101-0000-7000-8000-000000000006";
const DELETE_OBJECT_ID = "019fa101-0000-7000-8000-000000000007";
const VERSION_ID = "019fa101-0000-7000-8000-000000000008";
const FIRST_CHUNK_ID = "019fa101-0000-7000-8000-000000000009";
const SECOND_CHUNK_ID = "019fa101-0000-7000-8000-000000000010";
const OTHER_DEVICE_ID = "019fa101-0000-7000-8000-000000000011";
const SNAPSHOT_CURSOR = "snapshot_cursor_materialized_1";
const NOW = "2026-07-28T01:00:00.000Z";
const COMMITTED_AT = "2026-07-28T01:02:00.000Z";
const RESOLVED_AT = "2026-07-28T01:03:00.000Z";
const SETTLED_AT = "2026-07-28T01:04:00.000Z";
const EXPIRES_AT = "2026-07-30T01:00:00.000Z";
const EPOCH = 11;

describe("0016 snapshot materialization receipt migration", () => {
  it("stores only strict plaintext-free receipt evidence with composite cascading ownership", () => {
    const executor = new NodeSqliteExecutor(migration);
    executor.database.exec("PRAGMA foreign_keys = ON");
    const columns = executor.database
      .prepare("PRAGMA table_info(sync_snapshot_materialization_receipts)")
      .all() as { name: string }[];
    expect(columns.map(({ name }) => name)).toEqual([
      "snapshot_id",
      "operation_id",
      "operation_fingerprint",
      "outcome",
      "conflict_code",
      "resolved_at",
    ]);
    expect(
      columns
        .map(({ name }) => name)
        .filter((name) =>
          ["content", "payload", "plaintext", "project_key", "title"].some((forbidden) =>
            name.includes(forbidden),
          ),
        ),
    ).toEqual([]);

    const foreignKeys = executor.database
      .prepare("PRAGMA foreign_key_list(sync_snapshot_materialization_receipts)")
      .all() as { table: string; from: string; to: string; on_delete: string }[];
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "sync_snapshot_staging_operations",
          from: "snapshot_id",
          to: "snapshot_id",
          on_delete: "CASCADE",
        }),
        expect.objectContaining({
          table: "sync_snapshot_staging_operations",
          from: "operation_id",
          to: "operation_id",
          on_delete: "CASCADE",
        }),
      ]),
    );
    expect(executor.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    executor.database.close();
  });
});

describe("SyncSnapshotMaterializationSqliteStore", () => {
  let executor: NodeSqliteExecutor;
  let snapshotStore: SyncSqliteStore;
  let store: SyncSnapshotMaterializationSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    await executor.execute("PRAGMA foreign_keys = ON");
    snapshotStore = new SyncSqliteStore(executor);
    store = new SyncSnapshotMaterializationSqliteStore(executor);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "Materialization fixture", NOW, NOW],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("lists pending committed work in exact page and operation order", async () => {
    await stageAndCommitPopulatedSnapshot(snapshotStore);

    const first = expectOk(await store.loadNextPendingWork(identity()));
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      snapshotId: SNAPSHOT_ID,
      projectId: PROJECT_ID,
      epoch: EPOCH,
      operation: {
        operationId: UPSERT_OPERATION_ID,
        projectId: PROJECT_ID,
        objectType: "chapter_version",
        encryptedChunkIds: [FIRST_CHUNK_ID, SECOND_CHUNK_ID],
      },
      tombstone: null,
    });
    expect(first?.operationFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first?.chunks.map(({ chunkId }) => chunkId)).toEqual([FIRST_CHUNK_ID, SECOND_CHUNK_ID]);
    expect(first?.chunks.map(({ encrypted }) => encrypted.aad.chunkIndex)).toEqual([0, 1]);

    const page = expectOk(await store.listPendingWork({ ...identity(), limit: 10 }));
    expect(page.map(({ operation }) => operation.operationId)).toEqual([
      UPSERT_OPERATION_ID,
      DELETE_OPERATION_ID,
    ]);
    expect(page[1]).toMatchObject({
      operation: {
        operationId: DELETE_OPERATION_ID,
        objectType: "chapter_version",
        kind: "delete",
        encryptedChunkIds: [],
      },
      chunks: [],
      tombstone: {
        projectId: PROJECT_ID,
        objectType: "chapter_version",
        objectId: DELETE_OBJECT_ID,
        deletedByDeviceId: DEVICE_ID,
      },
    });
  });

  it("exposes the immutable committed checkpoint target needed for plaintext finalization", async () => {
    expect(expectOk(await store.readCommittedTarget(identity()))).toBeNull();
    await stageAndCommitPopulatedSnapshot(snapshotStore);

    expect(expectOk(await store.readCommittedTarget(identity()))).toEqual({
      snapshotId: SNAPSHOT_ID,
      projectId: PROJECT_ID,
      epoch: EPOCH,
      signedRemoteCursor: SNAPSHOT_CURSOR,
      downloadedCheckpointRevision: 1,
      committedAt: COMMITTED_AT,
    });
  });

  it("rejects malformed or internally inconsistent receipt rows at the SQL boundary", async () => {
    await stageAndCommitPopulatedSnapshot(snapshotStore);
    const values = [
      SNAPSHOT_ID,
      UPSERT_OPERATION_ID,
      "a".repeat(64),
      "applied",
      null,
      RESOLVED_AT,
    ] as const;
    await expect(
      executor.execute(
        `INSERT INTO sync_snapshot_materialization_receipts (
           snapshot_id, operation_id, operation_fingerprint,
           outcome, conflict_code, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [values[0], values[1], "A".repeat(64), values[3], values[4], values[5]],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `INSERT INTO sync_snapshot_materialization_receipts (
           snapshot_id, operation_id, operation_fingerprint,
           outcome, conflict_code, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [values[0], values[1], values[2], "applied", "HAS_CONFLICT", values[5]],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `INSERT INTO sync_snapshot_materialization_receipts (
           snapshot_id, operation_id, operation_fingerprint,
           outcome, conflict_code, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [values[0], values[1], values[2], "conflict", null, values[5]],
      ),
    ).rejects.toThrow();
    await expect(
      executor.execute(
        `INSERT INTO sync_snapshot_materialization_receipts (
           snapshot_id, operation_id, operation_fingerprint,
           outcome, conflict_code, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [values[0], values[1], values[2], values[3], values[4], "not-a-time"],
      ),
    ).rejects.toThrow();
    await expect(countRows(executor, "sync_snapshot_materialization_receipts")).resolves.toBe(0);
  });

  it("rolls back a crashed business callback and never reruns a durable receipt replay", async () => {
    await stageAndCommitPopulatedSnapshot(snapshotStore);
    await executor.execute(
      "CREATE TABLE test_business_markers (operation_id TEXT PRIMARY KEY NOT NULL)",
    );
    const work = requireWork(expectOk(await store.loadNextPendingWork(identity())));
    let callbacks = 0;
    const crashed = await store.resolveWorkAtomically(resolveInput(work), async (transaction) => {
      callbacks += 1;
      await transaction.execute("INSERT INTO test_business_markers (operation_id) VALUES (?)", [
        work.operation.operationId,
      ]);
      throw new Error("simulated process crash");
    });
    expect(crashed).toMatchObject({ ok: false, error: { code: "REPOSITORY_ERROR" } });
    await expect(countRows(executor, "test_business_markers")).resolves.toBe(0);
    await expect(countRows(executor, "sync_snapshot_materialization_receipts")).resolves.toBe(0);

    const resolved = expectOk(
      await store.resolveWorkAtomically(resolveInput(work), async (transaction) => {
        callbacks += 1;
        await transaction.execute("INSERT INTO test_business_markers (operation_id) VALUES (?)", [
          work.operation.operationId,
        ]);
        return { outcome: "applied" };
      }),
    );
    expect(resolved).toMatchObject({
      replayed: false,
      receipt: {
        operationId: UPSERT_OPERATION_ID,
        operationFingerprint: work.operationFingerprint,
        outcome: "applied",
        conflictCode: null,
      },
    });

    const replayed = expectOk(
      await store.resolveWorkAtomically(resolveInput(work), () => {
        callbacks += 1;
        throw new Error("a replay must not invoke the callback");
      }),
    );
    expect(replayed).toEqual({ replayed: true, receipt: resolved.receipt });
    expect(callbacks).toBe(2);
    await expect(countRows(executor, "test_business_markers")).resolves.toBe(1);
    expect(expectOk(await store.readState(identity()))).toEqual({
      ...identity(),
      total: 2,
      resolved: 1,
      conflict: 0,
      remaining: 1,
    });
  });

  it("rejects stale fingerprints and revalidates committed work before receipt replay", async () => {
    await stageAndCommitPopulatedSnapshot(snapshotStore);
    const work = requireWork(expectOk(await store.loadNextPendingWork(identity())));
    let callbacks = 0;
    expect(
      await store.resolveWorkAtomically(
        {
          ...resolveInput(work),
          operationFingerprint: "0".repeat(64),
        },
        () => {
          callbacks += 1;
          return { outcome: "applied" };
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(callbacks).toBe(0);

    expectOk(
      await store.resolveWorkAtomically(resolveInput(work), () => {
        callbacks += 1;
        return { outcome: "applied" };
      }),
    );
    await executor.execute(
      "UPDATE sync_snapshot_staging_operations SET vector_json = ? WHERE operation_id = ?",
      [JSON.stringify({ [DEVICE_ID]: 1, [OTHER_DEVICE_ID]: 1 }), work.operation.operationId],
    );
    expect(
      await store.resolveWorkAtomically(resolveInput(work), () => {
        callbacks += 1;
        return { outcome: "applied" };
      }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(callbacks).toBe(1);
  });

  it("fails closed on ciphertext hash, AAD, order, or typed tombstone tampering", async () => {
    await stageAndCommitPopulatedSnapshot(snapshotStore);
    await executor.execute(
      "UPDATE sync_snapshot_staging_chunks SET ciphertext_sha256 = ? WHERE chunk_id = ?",
      ["0".repeat(64), FIRST_CHUNK_ID],
    );
    expect(await store.loadNextPendingWork(identity())).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_ERROR" },
    });

    await executor.execute(
      "UPDATE sync_snapshot_staging_chunks SET ciphertext_sha256 = (SELECT ciphertext_sha256 FROM sync_ciphertext_chunks WHERE chunk_id = ?) WHERE chunk_id = ?",
      [FIRST_CHUNK_ID, FIRST_CHUNK_ID],
    );
    await executor.execute(
      "UPDATE sync_snapshot_staging_operation_chunks SET position = 3 WHERE chunk_id = ?",
      [SECOND_CHUNK_ID],
    );
    expect(await store.loadNextPendingWork(identity())).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_ERROR" },
    });

    await executor.execute(
      "UPDATE sync_snapshot_staging_operation_chunks SET position = 1 WHERE chunk_id = ?",
      [SECOND_CHUNK_ID],
    );
    await executor.execute(
      "UPDATE sync_snapshot_staging_chunks SET object_type = 'project_manifest' WHERE chunk_id = ?",
      [FIRST_CHUNK_ID],
    );
    expect(await store.loadNextPendingWork(identity())).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_ERROR" },
    });

    await executor.execute(
      "UPDATE sync_snapshot_staging_chunks SET object_type = 'chapter_version' WHERE chunk_id = ?",
      [FIRST_CHUNK_ID],
    );
    await executor.execute(
      "UPDATE sync_snapshot_staging_tombstones SET deleted_by_device_id = ? WHERE object_id = ?",
      [OTHER_DEVICE_ID, DELETE_OBJECT_ID],
    );
    const upsert = requireWork(expectOk(await store.loadNextPendingWork(identity())));
    expectOk(
      await store.resolveWorkAtomically(resolveInput(upsert), () => ({
        outcome: "skipped",
      })),
    );
    expect(await store.loadNextPendingWork(identity())).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_ERROR" },
    });
  });

  it("persists conflicts as progress but refuses to finalize while any conflict remains", async () => {
    await stageAndCommitPopulatedSnapshot(snapshotStore);
    const first = requireWork(expectOk(await store.loadNextPendingWork(identity())));
    expectOk(
      await store.resolveWorkAtomically(resolveInput(first), () => ({
        outcome: "conflict",
        conflictCode: "VERSION_VECTOR_CONCURRENT",
      })),
    );
    const second = requireWork(expectOk(await store.loadNextPendingWork(identity())));
    expectOk(
      await store.resolveWorkAtomically(resolveInput(second), () => ({
        outcome: "applied",
      })),
    );
    await writeExactMaterializedCheckpoint(executor);

    expect(expectOk(await store.readState(identity()))).toEqual({
      ...identity(),
      total: 2,
      resolved: 2,
      conflict: 1,
      remaining: 0,
    });
    expect(await store.finalize(identity())).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    await expect(countRows(executor, "sync_snapshot_staging_sessions")).resolves.toBe(1);
    await expect(countRows(executor, "sync_snapshot_materialization_receipts")).resolves.toBe(2);

    await executor.execute(
      "CREATE TABLE test_conflict_settlements (operation_id TEXT PRIMARY KEY NOT NULL)",
    );
    let settlementCallbacks = 0;
    const settlementInput = {
      ...resolveInput(first),
      expectedConflictCode: "VERSION_VECTOR_CONCURRENT",
      resolvedAt: SETTLED_AT,
    } as const;
    const settled = expectOk(
      await store.settleConflictAtomically(settlementInput, async (transaction) => {
        settlementCallbacks += 1;
        await transaction.execute(
          "INSERT INTO test_conflict_settlements (operation_id) VALUES (?)",
          [first.operation.operationId],
        );
        return { outcome: "skipped" };
      }),
    );
    expect(settled).toMatchObject({
      replayed: false,
      receipt: {
        operationId: first.operation.operationId,
        outcome: "skipped",
        conflictCode: null,
        resolvedAt: SETTLED_AT,
      },
    });
    expectOk(
      await store.settleConflictAtomically(settlementInput, () => {
        settlementCallbacks += 1;
        throw new Error("a settled conflict replay must not invoke its callback");
      }),
    );
    expect(settlementCallbacks).toBe(1);
    await expect(countRows(executor, "test_conflict_settlements")).resolves.toBe(1);
    expect(expectOk(await store.readState(identity()))).toMatchObject({
      resolved: 2,
      conflict: 0,
      remaining: 0,
    });
    expect(expectOk(await store.finalize(identity()))).toMatchObject({
      finalized: true,
    });
  });

  it("finalizes an empty snapshot only after both exact checkpoints and is replay-safe", async () => {
    await stageAndCommitEmptySnapshot(snapshotStore);
    expect(expectOk(await store.readState(identity()))).toEqual({
      ...identity(),
      total: 0,
      resolved: 0,
      conflict: 0,
      remaining: 0,
    });
    expect(await store.finalize(identity())).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    await writeExactMaterializedCheckpoint(executor);
    expect(expectOk(await store.finalize(identity()))).toEqual({
      finalized: true,
      reason: "finalized",
    });
    expect(expectOk(await store.readState(identity()))).toBeNull();
    expect(expectOk(await store.finalize(identity()))).toEqual({
      finalized: false,
      reason: "snapshot_absent",
    });
  });

  it("detects materialized and downloaded checkpoint drift before cascading payload cleanup", async () => {
    await stageAndCommitPopulatedSnapshot(snapshotStore);
    await resolveEveryPendingWork(store);
    await executor.execute(
      `INSERT INTO sync_materialized_checkpoints (
         project_id, signed_remote_cursor, downloaded_checkpoint_revision, revision, updated_at
       ) VALUES (?, ?, 1, 1, ?)`,
      [PROJECT_ID, "wrong_materialized_cursor", RESOLVED_AT],
    );
    expect(await store.finalize(identity())).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    await executor.execute(
      "UPDATE sync_materialized_checkpoints SET signed_remote_cursor = ? WHERE project_id = ?",
      [SNAPSHOT_CURSOR, PROJECT_ID],
    );
    await executor.execute(
      `UPDATE sync_remote_checkpoints
       SET signed_remote_cursor = 'newer_downloaded_cursor', revision = 2
       WHERE project_id = ?`,
      [PROJECT_ID],
    );
    expect(await store.finalize(identity())).toMatchObject({
      ok: false,
      error: { code: "INVALID_STATE_TRANSITION" },
    });
    await expect(countRows(executor, "sync_snapshot_staging_operations")).resolves.toBe(2);
    await expect(countRows(executor, "sync_snapshot_materialization_receipts")).resolves.toBe(2);

    await executor.execute(
      `UPDATE sync_remote_checkpoints
       SET signed_remote_cursor = ?, revision = 1
       WHERE project_id = ?`,
      [SNAPSHOT_CURSOR, PROJECT_ID],
    );
    expect(expectOk(await store.finalize(identity()))).toMatchObject({ finalized: true });
    for (const table of [
      "sync_snapshot_materialization_receipts",
      "sync_snapshot_staging_operation_chunks",
      "sync_snapshot_staging_tombstones",
      "sync_snapshot_staging_operations",
      "sync_snapshot_staging_chunks",
      "sync_snapshot_staging_pages",
      "sync_snapshot_staging_sessions",
    ]) {
      await expect(countRows(executor, table)).resolves.toBe(0);
    }
    await expect(countRows(executor, "sync_ciphertext_chunks")).resolves.toBe(2);
    await expect(countRows(executor, "sync_tombstones")).resolves.toBe(1);
  });

  it("commits the final business transition and staging cleanup in one transaction", async () => {
    await stageAndCommitEmptySnapshot(snapshotStore);
    await writeExactMaterializedCheckpoint(executor);
    await executor.execute(
      "CREATE TABLE test_snapshot_finalizations (snapshot_id TEXT PRIMARY KEY NOT NULL)",
    );

    const crashed = await store.finalizeAtomically(identity(), async (transaction, target) => {
      expect(target).toMatchObject({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        signedRemoteCursor: SNAPSHOT_CURSOR,
        downloadedCheckpointRevision: 1,
      });
      await transaction.execute(
        "INSERT INTO test_snapshot_finalizations (snapshot_id) VALUES (?)",
        [target.snapshotId],
      );
      throw new Error("simulated transition crash");
    });
    expect(crashed).toMatchObject({
      ok: false,
      error: { code: "REPOSITORY_ERROR", retryable: true },
    });
    await expect(countRows(executor, "test_snapshot_finalizations")).resolves.toBe(0);
    await expect(countRows(executor, "sync_snapshot_staging_sessions")).resolves.toBe(1);

    expect(
      expectOk(
        await store.finalizeAtomically(identity(), async (transaction, target) => {
          await transaction.execute(
            "INSERT INTO test_snapshot_finalizations (snapshot_id) VALUES (?)",
            [target.snapshotId],
          );
        }),
      ),
    ).toEqual({ finalized: true, reason: "finalized" });
    await expect(countRows(executor, "test_snapshot_finalizations")).resolves.toBe(1);
    await expect(countRows(executor, "sync_snapshot_staging_sessions")).resolves.toBe(0);
  });
});

function identity() {
  return {
    snapshotId: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    epoch: EPOCH,
  } as const;
}

function resolveInput(work: SnapshotMaterializationWork) {
  return {
    ...identity(),
    operationId: work.operation.operationId,
    operationFingerprint: work.operationFingerprint,
    resolvedAt: RESOLVED_AT,
  } as const;
}

async function stageAndCommitPopulatedSnapshot(store: SyncSqliteStore): Promise<void> {
  const chunks = await createChunks();
  const upsert = createOperation({
    operationId: UPSERT_OPERATION_ID,
    deviceSequence: 1,
    objectId: UPSERT_OBJECT_ID,
    kind: "upsert",
    chunkIds: [FIRST_CHUNK_ID, SECOND_CHUNK_ID],
  });
  const deletion = createOperation({
    operationId: DELETE_OPERATION_ID,
    deviceSequence: 2,
    objectId: DELETE_OBJECT_ID,
    kind: "delete",
    chunkIds: [],
  });
  expectOk(
    await store.stageSyncSnapshotPage({
      ...identity(),
      pageIndex: 0,
      resumeCursor: null,
      snapshotSignedRemoteCursor: SNAPSHOT_CURSOR,
      snapshotExpiresAt: EXPIRES_AT,
      nextSnapshotCursor: null,
      finalSignedRemoteCursor: SNAPSHOT_CURSOR,
      operations: [upsert, deletion],
      chunks: chunks.map(({ chunkId, encrypted }) => ({ chunkId, encrypted })),
      tombstones: [createTombstone(deletion)],
      receivedAt: NOW,
    }),
  );
  expectOk(
    await store.commitStagedSyncSnapshot({
      ...identity(),
      now: COMMITTED_AT,
    }),
  );
}

async function stageAndCommitEmptySnapshot(store: SyncSqliteStore): Promise<void> {
  expectOk(
    await store.stageSyncSnapshotPage({
      ...identity(),
      pageIndex: 0,
      resumeCursor: null,
      snapshotSignedRemoteCursor: SNAPSHOT_CURSOR,
      snapshotExpiresAt: EXPIRES_AT,
      nextSnapshotCursor: null,
      finalSignedRemoteCursor: SNAPSHOT_CURSOR,
      operations: [],
      chunks: [],
      tombstones: [],
      receivedAt: NOW,
    }),
  );
  expectOk(
    await store.commitStagedSyncSnapshot({
      ...identity(),
      now: COMMITTED_AT,
    }),
  );
}

function createOperation(input: {
  readonly operationId: string;
  readonly deviceSequence: number;
  readonly objectId: string;
  readonly kind: "upsert" | "delete";
  readonly chunkIds: readonly string[];
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
    kind: input.kind,
    vector: { [DEVICE_ID]: input.deviceSequence },
    encryptedChunkIds: [...input.chunkIds],
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
    deletedAt: NOW,
    retainUntil: "2027-07-28T01:00:00.000Z",
    acknowledgedDeviceIds: [],
  };
}

async function createChunks(): Promise<readonly StoredEncryptedChunk[]> {
  const cipher = new AesGcmChunkCipher();
  const key = await cipher.generateProjectDataKey();
  const chunks: StoredEncryptedChunk[] = [];
  for (const [index, input] of [
    { chunkId: FIRST_CHUNK_ID, plaintext: "first" },
    { chunkId: SECOND_CHUNK_ID, plaintext: "second" },
  ].entries()) {
    const encrypted = await cipher.encrypt(key, new TextEncoder().encode(input.plaintext), {
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: UPSERT_OBJECT_ID,
      versionId: VERSION_ID,
      chunkIndex: index,
      keyVersion: 1,
    });
    chunks.push({
      chunkId: input.chunkId,
      encrypted: encrypted as EncryptedSyncChunkContract,
      createdAt: NOW,
    });
  }
  return chunks;
}

async function resolveEveryPendingWork(
  store: SyncSnapshotMaterializationSqliteStore,
): Promise<void> {
  while (true) {
    const work = expectOk(await store.loadNextPendingWork(identity()));
    if (work === null) {
      return;
    }
    expectOk(
      await store.resolveWorkAtomically(resolveInput(work), () => ({
        outcome: "applied",
      })),
    );
  }
}

async function writeExactMaterializedCheckpoint(executor: NodeSqliteExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_materialized_checkpoints (
       project_id, signed_remote_cursor, downloaded_checkpoint_revision, revision, updated_at
     ) VALUES (?, ?, 1, 1, ?)`,
    [PROJECT_ID, SNAPSHOT_CURSOR, RESOLVED_AT],
  );
}

async function countRows(executor: NodeSqliteExecutor, table: string): Promise<number> {
  const allowed = new Set([
    "sync_ciphertext_chunks",
    "sync_snapshot_materialization_receipts",
    "sync_snapshot_staging_chunks",
    "sync_snapshot_staging_operation_chunks",
    "sync_snapshot_staging_operations",
    "sync_snapshot_staging_pages",
    "sync_snapshot_staging_sessions",
    "sync_snapshot_staging_tombstones",
    "sync_tombstones",
    "test_business_markers",
    "test_conflict_settlements",
    "test_snapshot_finalizations",
  ]);
  if (!allowed.has(table)) {
    throw new Error("Unexpected test table.");
  }
  const rows = await executor.select<{ count: number }>(`SELECT count(*) AS count FROM ${table}`);
  return rows[0]?.count ?? -1;
}

function requireWork(work: SnapshotMaterializationWork | null): SnapshotMaterializationWork {
  if (work === null) {
    throw new Error("Expected pending snapshot work.");
  }
  return work;
}

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
