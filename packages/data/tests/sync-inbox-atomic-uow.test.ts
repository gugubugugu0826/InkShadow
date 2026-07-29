import { readFileSync } from "node:fs";

import {
  CONTRACT_SCHEMA_VERSION,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type CloudSyncPullResponse,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
].join("\n");

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-100000000001";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-100000000002";
const OWNER_ID = "019f9f4a-b3c7-7350-9226-100000000003";
const FIRST_OPERATION_ID = "019f9f4a-b3c7-7350-9226-100000000004";
const SECOND_OPERATION_ID = "019f9f4a-b3c7-7350-9226-100000000005";
const FIRST_OBJECT_ID = "019f9f4a-b3c7-7350-9226-100000000006";
const SECOND_OBJECT_ID = "019f9f4a-b3c7-7350-9226-100000000007";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-100000000008";
const LEASE_ID = "019f9f4a-b3c7-7350-9226-100000000009";
const NEXT_LEASE_ID = "019f9f4a-b3c7-7350-9226-100000000010";
const WRONG_LEASE_ID = "019f9f4a-b3c7-7350-9226-100000000011";
const NOW = "2026-07-27T00:00:00.000Z";

describe("SyncSqliteStore atomic incoming application", () => {
  let executor: NodeSqliteExecutor;
  let store: SyncSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    store = new SyncSqliteStore(executor);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "原子入站", NOW, NOW],
    );
    await executor.execute(
      `CREATE TABLE incoming_apply_sentinel (
         operation_id TEXT PRIMARY KEY,
         materialized_value TEXT NOT NULL
       )`,
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("commits the business mutation and applied marker together and replays without reapplying", async () => {
    await stageDeletes(store, [deletion(FIRST_OPERATION_ID, FIRST_OBJECT_ID, 1)]);
    const claim = await claimIncoming(store, LEASE_ID);
    if (!claim.ok || claim.value === null) {
      throw new Error("Expected incoming work to be claimed.");
    }
    const command = {
      operationId: claim.value.operation.operationId,
      leaseToken: claim.value.leaseToken,
      now: "2026-07-27T00:01:30.000Z",
    };

    const first = await store.resolveClaimedIncomingAtomically(
      command,
      async (transaction, work) => {
        await transaction.execute(
          "INSERT INTO incoming_apply_sentinel (operation_id, materialized_value) VALUES (?, ?)",
          [work.operation.operationId, "materialized"],
        );
        return { status: "applied" };
      },
    );
    const replayCallback = vi.fn(async () => ({ status: "applied" as const }));
    const replay = await store.resolveClaimedIncomingAtomically(command, replayCallback);

    expect(first).toEqual({
      ok: true,
      value: {
        operationId: FIRST_OPERATION_ID,
        status: "applied",
        conflictCode: null,
        replayed: false,
      },
    });
    expect(replay).toEqual({
      ok: true,
      value: {
        operationId: FIRST_OPERATION_ID,
        status: "applied",
        conflictCode: null,
        replayed: true,
      },
    });
    expect(replayCallback).not.toHaveBeenCalled();
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM incoming_apply_sentinel"),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(readInboxStatus(executor, FIRST_OPERATION_ID)).resolves.toEqual([
      { status: "applied", resolution_token: LEASE_ID },
    ]);
  });

  it("rolls back the business mutation when the callback fails and permits expiry recovery", async () => {
    await stageDeletes(store, [deletion(FIRST_OPERATION_ID, FIRST_OBJECT_ID, 1)]);
    const firstClaim = await claimIncoming(store, LEASE_ID);
    if (!firstClaim.ok || firstClaim.value === null) {
      throw new Error("Expected incoming work to be claimed.");
    }
    const failed = await store.resolveClaimedIncomingAtomically(
      {
        operationId: FIRST_OPERATION_ID,
        leaseToken: LEASE_ID,
        now: "2026-07-27T00:01:30.000Z",
      },
      async (transaction) => {
        await transaction.execute(
          "INSERT INTO incoming_apply_sentinel (operation_id, materialized_value) VALUES (?, ?)",
          [FIRST_OPERATION_ID, "must roll back"],
        );
        throw new Error("simulated process failure");
      },
    );

    expect(failed).toMatchObject({ ok: false, error: { code: "REPOSITORY_ERROR" } });
    await expect(
      executor.select<{ count: number }>("SELECT count(*) AS count FROM incoming_apply_sentinel"),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(readInboxStatus(executor, FIRST_OPERATION_ID)).resolves.toEqual([
      { status: "applying", resolution_token: null },
    ]);

    const recovered = await store.claimNextIncoming({
      projectId: PROJECT_ID,
      ownerId: OWNER_ID,
      leaseToken: NEXT_LEASE_ID,
      now: "2026-07-27T00:03:00.000Z",
      leaseExpiresAt: "2026-07-27T00:05:00.000Z",
    });
    expect(recovered).toMatchObject({
      ok: true,
      value: { operation: { operationId: FIRST_OPERATION_ID }, attempt: 2 },
    });
    expect(
      await store.resolveClaimedIncomingAtomically(
        {
          operationId: FIRST_OPERATION_ID,
          leaseToken: NEXT_LEASE_ID,
          now: "2026-07-27T00:04:00.000Z",
        },
        async (transaction) => {
          await transaction.execute(
            "INSERT INTO incoming_apply_sentinel (operation_id, materialized_value) VALUES (?, ?)",
            [FIRST_OPERATION_ID, "recovered once"],
          );
          return { status: "applied" };
        },
      ),
    ).toMatchObject({ ok: true, value: { status: "applied", replayed: false } });
  });

  it("commits conflict evidence atomically and keeps the causal successor blocked", async () => {
    await stageDeletes(store, [
      deletion(FIRST_OPERATION_ID, FIRST_OBJECT_ID, 1),
      deletion(SECOND_OPERATION_ID, SECOND_OBJECT_ID, 2),
    ]);
    const firstClaim = await claimIncoming(store, LEASE_ID);
    if (!firstClaim.ok || firstClaim.value === null) {
      throw new Error("Expected incoming work to be claimed.");
    }
    const resolved = await store.resolveClaimedIncomingAtomically(
      {
        operationId: FIRST_OPERATION_ID,
        leaseToken: LEASE_ID,
        now: "2026-07-27T00:01:30.000Z",
      },
      async (transaction, work) => {
        await transaction.execute(
          "INSERT INTO incoming_apply_sentinel (operation_id, materialized_value) VALUES (?, ?)",
          [work.operation.operationId, "conflict candidate"],
        );
        return { status: "conflict", conflictCode: "VERSION_VECTOR_CONFLICT" };
      },
    );

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        status: "conflict",
        conflictCode: "VERSION_VECTOR_CONFLICT",
        replayed: false,
      },
    });
    expect(
      await store.claimNextIncoming({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        leaseToken: NEXT_LEASE_ID,
        now: "2026-07-27T00:03:00.000Z",
        leaseExpiresAt: "2026-07-27T00:05:00.000Z",
      }),
    ).toEqual({ ok: true, value: null });
    await expect(readInboxStatus(executor, FIRST_OPERATION_ID)).resolves.toEqual([
      { status: "conflict", resolution_token: LEASE_ID },
    ]);
  });

  it("does not invoke the callback for a wrong token or an expired lease", async () => {
    await stageDeletes(store, [deletion(FIRST_OPERATION_ID, FIRST_OBJECT_ID, 1)]);
    const claim = await claimIncoming(store, LEASE_ID);
    if (!claim.ok || claim.value === null) {
      throw new Error("Expected incoming work to be claimed.");
    }
    const callback = vi.fn(async () => ({ status: "applied" as const }));

    expect(
      await store.resolveClaimedIncomingAtomically(
        {
          operationId: FIRST_OPERATION_ID,
          leaseToken: WRONG_LEASE_ID,
          now: "2026-07-27T00:01:30.000Z",
        },
        callback,
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(
      await store.resolveClaimedIncomingAtomically(
        {
          operationId: FIRST_OPERATION_ID,
          leaseToken: LEASE_ID,
          now: "2026-07-27T00:02:00.000Z",
        },
        callback,
      ),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    expect(callback).not.toHaveBeenCalled();
  });
});

async function claimIncoming(store: SyncSqliteStore, leaseToken: string) {
  return store.claimNextIncoming({
    projectId: PROJECT_ID,
    ownerId: OWNER_ID,
    leaseToken,
    now: "2026-07-27T00:01:00.000Z",
    leaseExpiresAt: "2026-07-27T00:02:00.000Z",
  });
}

async function stageDeletes(
  store: SyncSqliteStore,
  operations: readonly SyncOperationContract[],
): Promise<void> {
  const response: CloudSyncPullResponse = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    operations: [...operations],
    chunks: [],
    tombstones: operations.map(tombstone),
    nextCursor: "signed_atomic_cursor",
    hasMore: false,
  };
  const staged = await store.stageIncomingSyncBatch({
    projectId: PROJECT_ID,
    priorSignedRemoteCursor: null,
    response,
    receivedAt: NOW,
  });
  if (!staged.ok) {
    throw staged.error;
  }
}

function deletion(
  operationId: string,
  objectId: string,
  deviceSequence: number,
): SyncOperationContract {
  return {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId,
    projectId: PROJECT_ID,
    deviceId: DEVICE_ID,
    deviceSequence,
    objectType: "chapter_version",
    objectId,
    objectGeneration: 1,
    kind: "delete",
    vector: { [DEVICE_ID]: deviceSequence },
    encryptedChunkIds: [],
    createdAt: NOW,
  };
}

function tombstone(operation: SyncOperationContract): SyncTombstoneContract {
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

function readInboxStatus(executor: NodeSqliteExecutor, operationId: string) {
  return executor.select<{ status: string; resolution_token: string | null }>(
    `SELECT status, resolution_token
     FROM sync_inbox_operations
     WHERE operation_id = ?`,
    [operationId],
  );
}
