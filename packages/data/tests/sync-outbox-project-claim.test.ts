import { readFileSync } from "node:fs";

import {
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type SyncOperationContract,
  type SyncTombstoneContract,
} from "@inkshadow/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

const PROJECT_A = "019f9f4a-b3c7-7350-9226-100000000001";
const PROJECT_B = "019f9f4a-b3c7-7350-9226-100000000002";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-100000000003";
const OTHER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-100000000005";
const OWNER_ID = "019f9f4a-b3c7-7350-9226-100000000004";
const OPERATION_A1 = "019f9f4a-b3c7-7350-9226-100000000101";
const OPERATION_A2 = "019f9f4a-b3c7-7350-9226-100000000102";
const OPERATION_A3 = "019f9f4a-b3c7-7350-9226-100000000103";
const OPERATION_B1 = "019f9f4a-b3c7-7350-9226-100000000001";
const OBJECT_A1 = "019f9f4a-b3c7-7350-9226-100000000201";
const OBJECT_A2 = "019f9f4a-b3c7-7350-9226-100000000202";
const OBJECT_A3 = "019f9f4a-b3c7-7350-9226-100000000203";
const OBJECT_B1 = "019f9f4a-b3c7-7350-9226-100000000204";
const LEASE_1 = "019f9f4a-b3c7-7350-9226-100000000301";
const LEASE_2 = "019f9f4a-b3c7-7350-9226-100000000302";
const LEASE_3 = "019f9f4a-b3c7-7350-9226-100000000303";
const NOW = "2026-07-27T00:00:00.000Z";

describe("SyncSqliteStore project-scoped outbox claims", () => {
  let executor: NodeSqliteExecutor;
  let store: SyncSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    store = new SyncSqliteStore(executor);
    await executor.execute(
      `INSERT INTO projects (id, name, created_at, updated_at)
       VALUES (?, 'Project A', ?, ?), (?, 'Project B', ?, ?)`,
      [PROJECT_A, NOW, NOW, PROJECT_B, NOW, NOW],
    );
  });

  afterEach(async () => {
    await executor.close();
  });

  it("claims one deterministically ordered operation at a time without crossing projects", async () => {
    await enqueueDelete(store, PROJECT_B, OPERATION_B1, OBJECT_B1, 1);
    await enqueueDelete(store, PROJECT_A, OPERATION_A2, OBJECT_A2, 1, OTHER_DEVICE_ID);
    await enqueueDelete(store, PROJECT_A, OPERATION_A1, OBJECT_A1, 1);

    const first = await store.claimNextForProject({
      projectId: PROJECT_A,
      deviceId: DEVICE_ID,
      ownerId: OWNER_ID,
      leaseToken: LEASE_1,
      now: "2026-07-27T00:00:01.000Z",
      leaseExpiresAt: "2026-07-27T00:01:01.000Z",
    });
    expect(first).toMatchObject({
      ok: true,
      value: {
        operation: { operationId: OPERATION_A1, projectId: PROJECT_A },
        status: "in_flight",
        attempt: 1,
        leaseToken: LEASE_1,
      },
    });
    await expect(
      executor.select<{ project_id: string; status: string }>(
        `SELECT project_id, status
         FROM sync_outbox_operations
         WHERE status = 'in_flight'
         ORDER BY operation_id`,
      ),
    ).resolves.toEqual([{ project_id: PROJECT_A, status: "in_flight" }]);

    const second = await store.claimNextForProject({
      projectId: PROJECT_A,
      deviceId: OTHER_DEVICE_ID,
      ownerId: OWNER_ID,
      leaseToken: LEASE_2,
      now: "2026-07-27T00:00:02.000Z",
      leaseExpiresAt: "2026-07-27T00:01:02.000Z",
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        operation: { operationId: OPERATION_A2, projectId: PROJECT_A },
        attempt: 1,
      },
    });
    await expect(
      store.claimNextForProject({
        projectId: PROJECT_A,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_3,
        now: "2026-07-27T00:00:03.000Z",
        leaseExpiresAt: "2026-07-27T00:01:03.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });

    const otherProject = await store.claimNextForProject({
      projectId: PROJECT_B,
      deviceId: DEVICE_ID,
      ownerId: OWNER_ID,
      leaseToken: LEASE_3,
      now: "2026-07-27T00:00:03.000Z",
      leaseExpiresAt: "2026-07-27T00:01:03.000Z",
    });
    expect(otherProject).toMatchObject({
      ok: true,
      value: { operation: { operationId: OPERATION_B1, projectId: PROJECT_B } },
    });
    expect(JSON.stringify([first, second, otherProject])).not.toMatch(
      /plaintext|projectKey|accessToken|refreshToken|Authorization/u,
    );
  });

  it("recovers an expired project lease with a new attempt and preserves token fencing", async () => {
    await enqueueDelete(store, PROJECT_A, OPERATION_A1, OBJECT_A1, 1);
    expect(
      await store.claimNextForProject({
        projectId: PROJECT_A,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_1,
        now: "2026-07-27T00:00:01.000Z",
        leaseExpiresAt: "2026-07-27T00:01:00.000Z",
      }),
    ).toMatchObject({ ok: true, value: { attempt: 1, leaseToken: LEASE_1 } });

    await expect(
      store.claimNextForProject({
        projectId: PROJECT_A,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_2,
        now: "2026-07-27T00:00:59.000Z",
        leaseExpiresAt: "2026-07-27T00:01:59.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    expect(
      await store.claimNextForProject({
        projectId: PROJECT_A,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_2,
        now: "2026-07-27T00:01:00.000Z",
        leaseExpiresAt: "2026-07-27T00:02:00.000Z",
      }),
    ).toMatchObject({ ok: true, value: { attempt: 2, leaseToken: LEASE_2 } });
    expect(
      await store.acknowledge(OPERATION_A1, LEASE_1, "2026-07-27T00:01:30.000Z"),
    ).toMatchObject({ ok: false, error: { code: "INVALID_STATE_TRANSITION" } });
    await expect(
      store.rescheduleFailure({
        operationId: OPERATION_A1,
        leaseToken: LEASE_2,
        failureCode: "REMOTE_UNAVAILABLE",
        now: "2026-07-27T00:01:30.000Z",
        nextAttemptAt: "2026-07-27T00:03:00.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
  });

  it("blocks later device sequences until the head operation is acknowledged", async () => {
    await enqueueDelete(store, PROJECT_A, OPERATION_A1, OBJECT_A1, 1);
    await enqueueDelete(store, PROJECT_A, OPERATION_A2, OBJECT_A2, 2);
    expect(
      await store.claimNextForProject({
        projectId: PROJECT_A,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_1,
        now: "2026-07-27T00:00:01.000Z",
        leaseExpiresAt: "2026-07-27T00:01:01.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: { operationId: OPERATION_A1, deviceSequence: 1 } },
    });
    await expect(
      store.claimNextForProject({
        projectId: PROJECT_A,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_2,
        now: "2026-07-27T00:00:02.000Z",
        leaseExpiresAt: "2026-07-27T00:01:02.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(
      store.acknowledge(OPERATION_A1, LEASE_1, "2026-07-27T00:00:03.000Z"),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(
      await store.claimNextForProject({
        projectId: PROJECT_A,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_2,
        now: "2026-07-27T00:00:04.000Z",
        leaseExpiresAt: "2026-07-27T00:01:04.000Z",
      }),
    ).toMatchObject({
      ok: true,
      value: { operation: { operationId: OPERATION_A2, deviceSequence: 2 } },
    });
  });

  it("does not skip a delayed, paused, or exhausted device-sequence head", async () => {
    await enqueueDelete(store, PROJECT_A, OPERATION_A1, OBJECT_A1, 1);
    await enqueueDelete(store, PROJECT_A, OPERATION_A2, OBJECT_A2, 2);
    await executor.execute(
      `UPDATE sync_outbox_operations
       SET status = 'failed', next_attempt_at = '2026-07-27T00:10:00.000Z'
       WHERE operation_id = ?`,
      [OPERATION_A1],
    );
    await expect(claimProjectAt(store, LEASE_1, "2026-07-27T00:01:00.000Z")).resolves.toEqual({
      ok: true,
      value: null,
    });

    await executor.execute(
      `UPDATE sync_outbox_operations
       SET status = 'paused', next_attempt_at = NULL
       WHERE operation_id = ?`,
      [OPERATION_A1],
    );
    await expect(claimProjectAt(store, LEASE_2, "2026-07-27T00:02:00.000Z")).resolves.toEqual({
      ok: true,
      value: null,
    });

    await executor.execute(
      `UPDATE sync_outbox_operations
       SET status = 'failed', attempt = 100, next_attempt_at = ?
       WHERE operation_id = ?`,
      [NOW, OPERATION_A1],
    );
    await expect(claimProjectAt(store, LEASE_3, "2026-07-27T00:03:00.000Z")).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(store.findOutbox(OPERATION_A2)).resolves.toMatchObject({
      ok: true,
      value: { status: "queued", attempt: 0 },
    });
  });

  it("never claims a single operation at the hard attempt limit", async () => {
    await enqueueDelete(store, PROJECT_A, OPERATION_A3, OBJECT_A3, 1);
    await executor.execute(
      `UPDATE sync_outbox_operations
       SET status = 'failed', attempt = 100, failure_code = 'RETRY_EXHAUSTED'
       WHERE operation_id = ?`,
      [OPERATION_A3],
    );

    await expect(
      store.claimNextForProject({
        projectId: PROJECT_A,
        deviceId: DEVICE_ID,
        ownerId: OWNER_ID,
        leaseToken: LEASE_1,
        now: "2026-07-27T00:01:00.000Z",
        leaseExpiresAt: "2026-07-27T00:02:00.000Z",
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await expect(store.findOutbox(OPERATION_A3)).resolves.toMatchObject({
      ok: true,
      value: { status: "failed", attempt: 100 },
    });
  });

  it("reads an exact tombstone generation without substituting the latest one", async () => {
    const first = tombstone(1, NOW);
    const second = tombstone(2, "2026-07-27T00:01:00.000Z");
    await expect(store.saveTombstone(first, NOW)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(store.saveTombstone(second, "2026-07-27T00:01:00.000Z")).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    await expect(
      store.findTombstone(PROJECT_A, "chapter_version", OBJECT_A1, 1),
    ).resolves.toMatchObject({
      ok: true,
      value: { objectGeneration: 1, deletedAt: NOW },
    });
    await expect(
      store.findTombstone(PROJECT_A, "chapter_version", OBJECT_A1, 2),
    ).resolves.toMatchObject({
      ok: true,
      value: { objectGeneration: 2, deletedAt: "2026-07-27T00:01:00.000Z" },
    });
    await expect(store.findTombstone(PROJECT_A, "chapter_version", OBJECT_A1, 3)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });
});

async function enqueueDelete(
  store: SyncSqliteStore,
  projectId: string,
  operationId: string,
  objectId: string,
  deviceSequence: number,
  deviceId = DEVICE_ID,
): Promise<void> {
  const operation: SyncOperationContract = {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId,
    projectId,
    deviceId,
    deviceSequence,
    objectType: "chapter_version",
    objectId,
    objectGeneration: 1,
    kind: "delete",
    vector: { [deviceId]: deviceSequence },
    encryptedChunkIds: [],
    createdAt: NOW,
  };
  await expect(store.enqueue({ operation, chunks: [], now: NOW })).resolves.toEqual({
    ok: true,
    value: { operationId, created: true },
  });
}

function claimProjectAt(store: SyncSqliteStore, leaseToken: string, now: string) {
  return store.claimNextForProject({
    projectId: PROJECT_A,
    deviceId: DEVICE_ID,
    ownerId: OWNER_ID,
    leaseToken,
    now,
    leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
  });
}

function tombstone(objectGeneration: number, deletedAt: string): SyncTombstoneContract {
  return {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    projectId: PROJECT_A,
    objectType: "chapter_version",
    objectId: OBJECT_A1,
    objectGeneration,
    deletedByDeviceId: DEVICE_ID,
    vector: { [DEVICE_ID]: objectGeneration },
    deletedAt,
    retainUntil: "2027-07-28T00:00:00.000Z",
    acknowledgedDeviceIds: [],
  };
}
