import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import {
  SyncIncrementalSettlementSqliteStore,
  SyncMaterializationSqliteStore,
} from "@inkshadow/data";
import { SyncSqliteStore } from "@inkshadow/data/sync-sqlite-store";
import {
  parseUuidV7,
  type Clock,
  type IsoUtcTimestamp,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { CloudSyncIncrementalSettlementCoordinator } from "./cloud-sync-incremental-settlement-coordinator";
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
const REQUEST_ID = id(4);
const CURSOR = "incremental_vertical_cursor_1";
const CREATED_AT = "2026-07-28T04:00:00.000Z";
const DOWNLOADED_AT = "2026-07-28T04:01:00.000Z";
const SETTLED_AT = "2026-07-28T04:02:00.000Z";

describe("incremental plaintext settlement vertical boundary", () => {
  let executor: NodeSqliteExecutor;
  let syncStore: SyncSqliteStore;
  let authority: SyncMaterializationSqliteStore;
  let coordinator: CloudSyncIncrementalSettlementCoordinator;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    await executor.execute("PRAGMA foreign_keys = ON");
    syncStore = new SyncSqliteStore(executor);
    authority = new SyncMaterializationSqliteStore(executor);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Vertical', ?, ?)",
      [PROJECT_ID, CREATED_AT, CREATED_AT],
    );
    expectOk(
      await authority.beginProjectSyncEnable({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        consentRevision: 1,
        keyVersion: 1,
        expectedRevision: null,
        begunAt: CREATED_AT,
      }),
    );
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
          hasMore: false,
        },
        receivedAt: DOWNLOADED_AT,
      }),
    );
    coordinator = new CloudSyncIncrementalSettlementCoordinator({
      enabled: true,
      store: new SyncIncrementalSettlementSqliteStore(executor),
      authority,
      seeder: new CloudSyncInitialProjectionSeeder(new SequentialIds(9_000)),
      clock: { now: () => SETTLED_AT as IsoUtcTimestamp } satisfies Clock,
    });
  });

  afterEach(async () => {
    await executor.close();
  });

  it("commits checkpoint, enabled consent, and manifest seed as one visible state", async () => {
    const result = await coordinator.settleProjectIncremental({
      projectId: PROJECT_ID,
      activeAccountId: ACCOUNT_ID,
      activeDeviceId: DEVICE_ID,
      signedRemoteCursor: CURSOR,
      downloadedCheckpointRevision: 1,
    });

    expect(result).toMatchObject({
      state: "ready",
      pushAllowed: true,
      checkpointAdvanced: true,
      registrationEnabled: true,
      seededJobs: 1,
    });
    expect(expectOk(await authority.loadProjectSyncRegistration(PROJECT_ID))).toMatchObject({
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      state: "enabled",
      plaintextBootstrapCompleted: true,
      revision: 2,
    });
    expect(expectOk(await authority.loadMaterializedCheckpoint(PROJECT_ID))).toMatchObject({
      signedRemoteCursor: CURSOR,
      downloadedCheckpointRevision: 1,
      revision: 1,
    });
    const jobs = await executor.select<{
      account_id: string;
      device_id: string;
      object_type: string;
      object_generation: number;
      status: string;
    }>(
      `SELECT account_id, device_id, object_type, object_generation, status
       FROM sync_projection_jobs`,
    );
    expect(jobs).toEqual([
      {
        account_id: ACCOUNT_ID,
        device_id: DEVICE_ID,
        object_type: "project_manifest",
        object_generation: 1,
        status: "queued",
      },
    ]);
  });

  it("rolls every boundary mutation back when projection seeding fails", async () => {
    executor.database.exec(`
      CREATE TRIGGER fail_incremental_seed
      BEFORE INSERT ON sync_projection_jobs
      BEGIN
        SELECT RAISE(ABORT, 'simulated incremental seed failure');
      END;
    `);

    const result = await coordinator.settleProjectIncremental({
      projectId: PROJECT_ID,
      activeAccountId: ACCOUNT_ID,
      activeDeviceId: DEVICE_ID,
      signedRemoteCursor: CURSOR,
      downloadedCheckpointRevision: 1,
    });

    expect(result).toMatchObject({
      state: "retryable",
      pushAllowed: false,
      checkpoint: null,
    });
    expect(expectOk(await authority.loadMaterializedCheckpoint(PROJECT_ID))).toBeNull();
    expect(expectOk(await authority.loadProjectSyncRegistration(PROJECT_ID))).toMatchObject({
      state: "enabling",
      plaintextBootstrapCompleted: false,
      revision: 1,
    });
    expect(await executor.select("SELECT job_id FROM sync_projection_jobs")).toEqual([]);
  });
});

class SequentialIds implements UuidV7Generator {
  public constructor(private nextValue: number) {}

  public next(): UuidV7 {
    const value = id(this.nextValue);
    this.nextValue += 1;
    return value;
  }
}

function id(value: number): UuidV7 {
  const parsed = parseUuidV7(`019fa105-0000-7000-8000-${value.toString(16).padStart(12, "0")}`);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
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

function readMigration(fileName: string): string {
  const candidates = [
    path.resolve(process.cwd(), "../../packages/data/migrations", fileName),
    path.resolve(process.cwd(), "packages/data/migrations", fileName),
  ];
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (filePath === undefined) {
    throw new Error(`Could not locate ${fileName}.`);
  }
  return readFileSync(filePath, "utf8");
}
