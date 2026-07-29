import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  InkShadowCloudApiClient,
  type CloudTransport,
  type CloudTransportRequest,
  type CloudTransportResponse,
} from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  CloudSyncPushRequestSchema,
  type CloudProjectKeySet,
  type CloudSyncPullResponse,
  type CloudSyncPushRequest,
  type CloudSyncPushResponse,
} from "@inkshadow/contracts";
import {
  SyncIncrementalSettlementSqliteStore,
  SyncMaterializationSqliteStore,
} from "@inkshadow/data";
import {
  ProjectKeySqliteStore,
  type DevicePublicKeyRecord,
} from "@inkshadow/data/project-key-sqlite-store";
import { SyncSqliteStore } from "@inkshadow/data/sync-sqlite-store";
import {
  parseIsoUtcTimestamp,
  parseUuidV7,
  type Clock,
  type IsoUtcTimestamp,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import { sha256Utf8Content } from "@inkshadow/sync-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { CloudSyncIncrementalSettlementCoordinator } from "./cloud-sync-incremental-settlement-coordinator";
import { CloudSyncInitialProjectionSeeder } from "./cloud-sync-initial-projection-seeder";
import { CloudSyncOrchestrator, type IncomingApplyOutcome } from "./cloud-sync-orchestrator";
import {
  CloudSessionCoordinatorError,
  type ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import { ContentSyncMaterializer } from "./content-sync-materializer";
import {
  IncomingContentDecryptor,
  type PreparedIncomingContentMutation,
} from "./incoming-content-decryptor";
import { OutgoingContentProjectionWorker } from "./outgoing-content-projection-worker";
import { ProjectKeyLifecycleService } from "./project-key-lifecycle";
import {
  type AcceptCurrentDeviceTeamProjectKeyEnvelopeInput,
  type CreateRecoveryKitInput,
  type DeviceIdentityStatus,
  type DeviceIdentitySummary,
  type NativeDeviceProjectKeyEnvelope,
  type NativeRecoveryProjectKeyEnvelope,
  type NativeTeamProjectKeyEnvelope,
  type NativeTeamProjectKeyReceiptCommit,
  type NativeTeamProjectKeyReceiptRemoval,
  type NativeTeamProjectKeyReceiptStatus,
  type ProjectDataKeyMaterial,
  type ProjectKeyVault,
  type RewrapProjectDataKeyForTeamRecipientsInput,
  type RecoveryKit,
  type RecoveryVerification,
  type TeamProjectKeyReceiptAccessInput,
  type WrapProjectDataKeyInput,
} from "./project-key-vault";

vi.hoisted(() => {
  const OriginalTextEncoder = globalThis.TextEncoder;
  class RealmSafeTextEncoder extends OriginalTextEncoder {
    public override encode(input?: string): Uint8Array<ArrayBuffer> {
      const encoded = super.encode(input);
      const owned = new Uint8Array(encoded.byteLength);
      owned.set(encoded);
      return owned;
    }
  }
  Object.defineProperty(globalThis, "TextEncoder", {
    configurable: true,
    value: RealmSafeTextEncoder,
    writable: true,
  });
});

const migration = [
  "0001_core.sql",
  "0003_sync_access.sql",
  "0008_project_key_lifecycle.sql",
  "0009_device_identity_names.sql",
  "0010_sync_inbox.sql",
  "0011_cloud_project_key_checkpoints.sql",
  "0012_cloud_project_key_publications.sql",
  "0013_sync_snapshot_staging.sql",
  "0014_sync_protocol_v2_object_types.sql",
  "0015_sync_materialization_authority.sql",
  "0016_sync_snapshot_materialization_receipts.sql",
  "0017_sync_projection_account_authority.sql",
  "0018_sync_incremental_terminal_observations.sql",
]
  .map(readMigration)
  .join("\n");

const PROJECT_ID = id(1);
const CHAPTER_ID = id(2);
const VERSION_ID = id(3);
const ACCOUNT_ID = id(4);
const DEVICE_A_ID = id(5);
const DEVICE_B_ID = id(6);
const PROJECTION_JOB_ID = id(7);
const DEVICE_A_WORKER_ID = id(8);
const DEVICE_A_OWNER_ID = id(9);
const DEVICE_B_WORKER_ID = id(10);
const DEVICE_B_OWNER_ID = id(11);
const DEVICE_A_SESSION_ID = id(12);
const DEVICE_B_SESSION_ID = id(13);
const MANIFEST_SOURCE_OPERATION_ID = id(14);
const DEVICE_A_KEY_ENVELOPE_ID = id(15);
const RECOVERY_ENVELOPE_ID = id(16);
const DEVICE_B_KEY_ENVELOPE_ID = id(17);
const CREATED_AT = timestamp("2026-07-28T01:00:00.000Z");
const NOW = timestamp("2026-07-28T02:00:00.000Z");
const SECRET_TITLE = "Device A private chapter";
const SECRET_CONTENT = "Only the two enrolled devices may read this manuscript edit.";
const RECOVERY_CODE = "inkshadow-dual-device-recovery-code";
const KEY_VERSION = 1;

interface DeviceHarness {
  readonly executor: NodeSqliteExecutor;
  readonly keyStore: ProjectKeySqliteStore;
  readonly keyLifecycle: ProjectKeyLifecycleService;
  readonly deviceRecord: DevicePublicKeyRecord;
  readonly syncStore: SyncSqliteStore;
  readonly authority: SyncMaterializationSqliteStore;
  readonly session: TestCloudSession;
  readonly clock: MutableClock;
  readonly worker: OutgoingContentProjectionWorker;
  readonly orchestrator: CloudSyncOrchestrator<PreparedIncomingContentMutation>;
  readonly disabledOrchestrator: CloudSyncOrchestrator<PreparedIncomingContentMutation>;
}

describe("protocol-v2 dual-device ciphertext integration", () => {
  let cloud: InMemoryCiphertextCloud;
  let nativeVaultBackend: MemoryNativeProjectKeyVaultBackend;
  let projectKeyMaterial: ProjectDataKeyMaterial;
  let cloudProjectKeySet: CloudProjectKeySet;
  let deviceA: DeviceHarness;
  let deviceB: DeviceHarness;

  beforeEach(async () => {
    cloud = new InMemoryCiphertextCloud();
    projectKeyMaterial = await createProjectKeyMaterial();
    nativeVaultBackend = new MemoryNativeProjectKeyVaultBackend(projectKeyMaterial);
    deviceA = await createDeviceHarness({
      cloud,
      deviceId: DEVICE_A_ID,
      sessionId: DEVICE_A_SESSION_ID,
      workerId: DEVICE_A_WORKER_ID,
      ownerId: DEVICE_A_OWNER_ID,
      ids: new SequentialIds(1_000),
      requestIds: new SequentialIds(3_000),
      keyIds: new ListedIds([
        DEVICE_A_ID,
        DEVICE_A_KEY_ENVELOPE_ID,
        RECOVERY_ENVELOPE_ID,
        DEVICE_B_KEY_ENVELOPE_ID,
      ]),
      vault: nativeVaultBackend.bind(DEVICE_A_ID, "A", "a"),
    });
    deviceB = await createDeviceHarness({
      cloud,
      deviceId: DEVICE_B_ID,
      sessionId: DEVICE_B_SESSION_ID,
      workerId: DEVICE_B_WORKER_ID,
      ownerId: DEVICE_B_OWNER_ID,
      ids: new SequentialIds(2_000),
      requestIds: new SequentialIds(4_000),
      keyIds: new ListedIds([DEVICE_B_ID]),
      vault: nativeVaultBackend.bind(DEVICE_B_ID, "B", "b"),
    });
    cloudProjectKeySet = await authorizeProjectKeyForBothDevices(deviceA, deviceB);
    await seedDeviceAEdit(deviceA);
  });

  afterEach(async () => {
    await Promise.all([deviceA.executor.close(), deviceB.executor.close()]);
  });

  it("moves a private edit A -> ciphertext cloud -> B with retry and duplicate safety", async () => {
    const [openedByA, openedByB] = await Promise.all([
      deviceA.keyLifecycle.openProjectDataKeyForDevice(PROJECT_ID, DEVICE_A_ID, KEY_VERSION),
      deviceB.keyLifecycle.openProjectDataKeyForDevice(PROJECT_ID, DEVICE_B_ID, KEY_VERSION),
    ]);
    expect(openedByA.projectKeyFingerprint).toBe(projectKeyMaterial.projectKeyFingerprint);
    expect(openedByB.projectKeyFingerprint).toBe(projectKeyMaterial.projectKeyFingerprint);
    expect(openedByA.key).not.toBe(openedByB.key);
    expect(openedByA.key.extractable).toBe(false);
    expect(openedByB.key.extractable).toBe(false);
    expect(
      cloudProjectKeySet.deviceEnvelopes.map(({ recipientDeviceId }) => recipientDeviceId),
    ).toEqual([DEVICE_A_ID, DEVICE_B_ID].sort());
    expect(
      expectOk(await deviceB.keyStore.loadProjectKeyBundle(PROJECT_ID, DEVICE_B_ID, KEY_VERSION)),
    ).toMatchObject({
      version: { state: "active", keyVersion: KEY_VERSION },
      deviceEnvelope: {
        recipientDeviceId: DEVICE_B_ID,
        recipientPublicKey: deviceB.deviceRecord.publicKey,
      },
    });

    await expect(deviceA.worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "completed",
      projectId: PROJECT_ID,
      jobId: PROJECTION_JOB_ID,
      objectType: "chapter_version",
    });

    expect(await readOutboxState(deviceA)).toEqual([{ attempt: 0, status: "queued" }]);
    expect(await readChapter(deviceB)).toEqual([]);

    cloud.failNextPushBeforeCommit();
    await expect(deviceA.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "offline",
      outgoing: {
        claimed: 1,
        pushed: 0,
        acknowledged: 0,
        retried: 1,
      },
    });
    expect(cloud.committedOperationCount).toBe(0);
    expect(await readOutboxState(deviceA)).toEqual([{ attempt: 1, status: "failed" }]);

    deviceA.clock.advance(2_000);
    await expect(deviceA.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      outgoing: {
        claimed: 1,
        pushed: 1,
        acknowledged: 1,
        retried: 0,
      },
    });

    expect(cloud.pushIdempotencyKeys).toHaveLength(2);
    expect(cloud.pushIdempotencyKeys[0]).toMatch(/^sync\.[0-9a-f]{64}$/u);
    expect(cloud.pushIdempotencyKeys[1]).toBe(cloud.pushIdempotencyKeys[0]);
    expect(cloud.observedPushBodies[1]).toEqual(cloud.observedPushBodies[0]);
    expect(cloud.committedOperationCount).toBe(1);
    expect(await readOutboxState(deviceA)).toEqual([{ attempt: 2, status: "acknowledged" }]);

    const serverView = JSON.stringify(cloud.observedPushBodies);
    expect(serverView).not.toContain(SECRET_TITLE);
    expect(serverView).not.toContain(SECRET_CONTENT);
    expect(serverView).not.toContain(projectKeyMaterial.rawProjectDataKey);
    expect(serverView).not.toContain(RECOVERY_CODE);
    expect(serverView).not.toMatch(/rawProjectDataKey|projectKeyFingerprint|recoveryCode/u);
    expect(cloud.observedPushBodies[1]).toMatchObject({
      operations: [
        {
          projectId: PROJECT_ID,
          deviceId: DEVICE_A_ID,
          objectType: "chapter_version",
          kind: "upsert",
        },
      ],
      chunks: [
        {
          encrypted: {
            algorithm: "AES-256-GCM",
            aad: {
              projectId: PROJECT_ID,
              objectId: CHAPTER_ID,
              keyVersion: KEY_VERSION,
            },
          },
        },
      ],
    });

    await expect(deviceB.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      pull: { operations: 1 },
      incoming: { claimed: 1, applied: 1, conflicts: 0, retried: 0 },
      outgoing: { claimed: 0 },
    });
    expect(await readChapter(deviceB)).toEqual([
      {
        title: SECRET_TITLE,
        content: SECRET_CONTENT,
        revision: 1,
        current_version_id: VERSION_ID,
      },
    ]);

    const replay = cloud.firstDataPull;
    if (replay === null) {
      throw new Error("Expected the cloud to retain a ciphertext pull response.");
    }
    const replayReceipt = expectOk(
      await deviceB.syncStore.stageIncomingSyncBatch({
        projectId: PROJECT_ID,
        priorSignedRemoteCursor: null,
        response: replay,
        receivedAt: deviceB.clock.now(),
      }),
    );
    expect(replayReceipt).toMatchObject({
      created: false,
      operationCount: 1,
      chunkCount: replay.chunks.length,
    });

    deviceB.clock.advance(1_000);
    await expect(deviceB.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      incoming: { claimed: 0, applied: 0, conflicts: 0 },
    });
    expect(
      await deviceB.executor.select<{ status: string; count: number }>(
        `SELECT status, count(*) AS count
         FROM sync_inbox_operations
         GROUP BY status`,
      ),
    ).toEqual([{ status: "applied", count: 1 }]);
    expect(
      await deviceB.executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM chapter_versions WHERE chapter_id = ?",
        [CHAPTER_ID],
      ),
    ).toEqual([{ count: 1 }]);
    expect(cloud.committedOperationCount).toBe(1);
  });

  it("reconciles an unknown push result through pull and operation-level deduplication", async () => {
    await expect(deviceA.worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "completed",
    });

    cloud.failNextPushAfterCommit();
    await expect(deviceA.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "offline",
      outgoing: {
        claimed: 1,
        pushed: 0,
        acknowledged: 0,
        retried: 1,
      },
    });
    expect(cloud.committedOperationCount).toBe(1);
    expect(await readOutboxState(deviceA)).toEqual([{ attempt: 1, status: "failed" }]);

    deviceA.clock.advance(2_000);
    await expect(deviceA.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      pull: { operations: 1 },
      outgoing: {
        claimed: 1,
        pushed: 1,
        acknowledged: 1,
        retried: 0,
      },
    });

    expect(cloud.pushIdempotencyKeys).toHaveLength(2);
    expect(cloud.pushIdempotencyKeys[1]).not.toBe(cloud.pushIdempotencyKeys[0]);
    expect(cloud.observedPushBodies[0]?.baseCursor).toBe("cursor_0");
    expect(cloud.observedPushBodies[1]?.baseCursor).toBe("cursor_1");
    expect(cloud.observedPushBodies[1]?.operations).toEqual(
      cloud.observedPushBodies[0]?.operations,
    );
    expect(cloud.observedPushBodies[1]?.chunks).toEqual(cloud.observedPushBodies[0]?.chunks);
    expect(cloud.operationDispositions).toEqual([["accepted"], ["duplicate"]]);
    expect(cloud.committedOperationCount).toBe(1);
    expect(await readOutboxState(deviceA)).toEqual([{ attempt: 2, status: "acknowledged" }]);
  });

  it("fails closed on a revoked device before cloud I/O or local outbox mutation", async () => {
    await expect(deviceA.worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "completed",
    });
    deviceA.session.revoke();

    await expect(deviceA.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "auth_blocked",
      failure: {
        category: "auth_blocked",
        code: "AUTH_DEVICE_REVOKED",
      },
      pull: { pages: 0 },
      outgoing: { claimed: 0, pushed: 0, acknowledged: 0 },
    });

    expect(cloud.requestCount).toBe(0);
    expect(cloud.committedOperationCount).toBe(0);
    expect(await readOutboxState(deviceA)).toEqual([{ attempt: 0, status: "queued" }]);
    expect(await readChapter(deviceB)).toEqual([]);
  });

  it("performs no cloud or persistence work when disabled or already cancelled", async () => {
    await expect(deviceA.worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "completed",
    });
    const before = await readSyncPersistenceState(deviceA);

    await expect(deviceA.disabledOrchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "disabled",
      pull: { pages: 0 },
      incoming: { claimed: 0 },
      outgoing: { claimed: 0 },
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      deviceA.orchestrator.runProjectCycle(PROJECT_ID, {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      state: "aborted",
      pull: { pages: 0 },
      incoming: { claimed: 0 },
      outgoing: { claimed: 0 },
    });

    expect(cloud.requestCount).toBe(0);
    expect(await readSyncPersistenceState(deviceA)).toEqual(before);
    expect(await readChapter(deviceB)).toEqual([]);
  });
});

async function createDeviceHarness(input: {
  readonly cloud: InMemoryCiphertextCloud;
  readonly deviceId: UuidV7;
  readonly sessionId: UuidV7;
  readonly workerId: UuidV7;
  readonly ownerId: UuidV7;
  readonly ids: UuidV7Generator;
  readonly requestIds: UuidV7Generator;
  readonly keyIds: UuidV7Generator;
  readonly vault: ProjectKeyVault;
}): Promise<DeviceHarness> {
  const executor = new NodeSqliteExecutor(migration);
  await executor.execute("PRAGMA foreign_keys = ON");
  await executor.execute(
    `INSERT INTO projects (
       id, name, status, revision, deletion_generation, created_at, updated_at,
       archived_at, trashed_at, retention_until, status_before_trash
     ) VALUES (?, 'Dual Device Project', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
    [PROJECT_ID, CREATED_AT, CREATED_AT],
  );
  await executor.execute(
    `INSERT INTO cloud_account_snapshots (
       account_id, schema_version, state, revision, verified_at,
       deletion_scheduled_for, created_at, updated_at
     ) VALUES (?, 1, 'active', 1, ?, NULL, ?, ?)`,
    [ACCOUNT_ID, CREATED_AT, CREATED_AT, CREATED_AT],
  );

  const clock = new MutableClock(NOW);
  const keyStore = new ProjectKeySqliteStore(executor);
  const keyLifecycle = new ProjectKeyLifecycleService(input.vault, keyStore, input.keyIds, clock);
  const deviceRecord = await keyLifecycle.ensureLocalDeviceIdentity({
    accountId: ACCOUNT_ID,
    displayName: input.deviceId === DEVICE_A_ID ? "Device A" : "Device B",
  });
  if (deviceRecord.deviceId !== input.deviceId) {
    throw new Error("The native vault created a different local device identity.");
  }

  const authority = new SyncMaterializationSqliteStore(executor);
  expectOk(
    await authority.beginProjectSyncEnable({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      deviceId: input.deviceId,
      consentRevision: 1,
      keyVersion: KEY_VERSION,
      expectedRevision: null,
      begunAt: CREATED_AT,
    }),
  );
  expectOk(
    await authority.transitionProjectSyncRegistration({
      projectId: PROJECT_ID,
      expectedAccountId: ACCOUNT_ID,
      expectedDeviceId: input.deviceId,
      expectedConsentRevision: 1,
      expectedKeyVersion: KEY_VERSION,
      expectedRevision: 1,
      target: { state: "enabled" },
      transitionedAt: CREATED_AT,
    }),
  );

  const syncStore = new SyncSqliteStore(executor);
  const session = new TestCloudSession(configuredSession(input.deviceId, input.sessionId));
  const api = new InkShadowCloudApiClient({
    transport: input.cloud,
    requestIdFactory: () => input.requestIds.next(),
  });
  const worker = new OutgoingContentProjectionWorker({
    executor,
    projectKeys: keyLifecycle,
    ids: input.ids,
    clock,
    workerId: input.workerId,
    leaseMilliseconds: 60_000,
    retryDelayMilliseconds: () => 1_000,
  });
  const materializer = new ContentSyncMaterializer(
    new IncomingContentDecryptor(async (projectId, keyVersion) => {
      const opened = await keyLifecycle.openProjectDataKeyForDevice(
        projectId,
        input.deviceId,
        keyVersion,
      );
      return opened.key;
    }),
  );
  const incrementalSettlement = new CloudSyncIncrementalSettlementCoordinator({
    enabled: true,
    store: new SyncIncrementalSettlementSqliteStore(executor),
    authority,
    seeder: new CloudSyncInitialProjectionSeeder(input.ids),
    clock,
  });
  const createOrchestrator = (
    enabled: boolean,
  ): CloudSyncOrchestrator<PreparedIncomingContentMutation> =>
    new CloudSyncOrchestrator<PreparedIncomingContentMutation>({
      enabled,
      api,
      session,
      store: syncStore,
      prepareIncoming: (work) => materializer.prepare(work),
      applyPreparedIncoming: async (transaction, exactWork, prepared, context) =>
        toIncomingApplyOutcome(
          await materializer.applyPrepared(transaction, exactWork, prepared, context.now),
        ),
      clock,
      ids: input.ids,
      ownerId: input.ownerId,
      activeDeviceId: input.deviceId,
      projectionPushAuthority: authority,
      incrementalSettlement,
      projectOutbox: syncStore,
      limits: {
        maximumPullPages: 4,
        maximumIncomingOperations: 8,
        maximumOutgoingOperations: 4,
        retryBaseMs: 1_000,
        retryMaximumMs: 1_000,
      },
    });
  return {
    executor,
    keyStore,
    keyLifecycle,
    deviceRecord,
    syncStore,
    authority,
    session,
    clock,
    worker,
    orchestrator: createOrchestrator(true),
    disabledOrchestrator: createOrchestrator(false),
  };
}

async function seedDeviceAEdit(device: DeviceHarness): Promise<void> {
  const checksum = await sha256Utf8Content(SECRET_CONTENT);
  await device.executor.transaction(async (transaction) => {
    await transaction.execute(
      `INSERT INTO chapters (
         id, project_id, title, content, status, revision, current_version_id,
         created_at, updated_at, trashed_at
       ) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?, NULL)`,
      [CHAPTER_ID, PROJECT_ID, SECRET_TITLE, SECRET_CONTENT, VERSION_ID, CREATED_AT, CREATED_AT],
    );
    await transaction.execute(
      `INSERT INTO chapter_versions (
         id, project_id, chapter_id, parent_version_id, sequence, content,
         content_checksum, reason, source_candidate_id, created_at
       ) VALUES (?, ?, ?, NULL, 1, ?, ?, 'manual', NULL, ?)`,
      [VERSION_ID, PROJECT_ID, CHAPTER_ID, SECRET_CONTENT, checksum, CREATED_AT],
    );
    await transaction.execute(
      `INSERT INTO sync_device_sequences (
         project_id, device_id, last_allocated_sequence, revision, updated_at
       ) VALUES (?, ?, 1, 1, ?)`,
      [PROJECT_ID, DEVICE_A_ID, CREATED_AT],
    );
  });
  expectOk(
    await device.authority.writeMaterializedObject({
      object: {
        projectId: PROJECT_ID,
        objectType: "project_manifest",
        objectId: PROJECT_ID,
        objectGeneration: 1,
        versionId: PROJECT_ID,
        vector: { [DEVICE_A_ID]: 1 },
        payloadSha256: "e".repeat(64),
        sourceOperationId: MANIFEST_SOURCE_OPERATION_ID,
        sourceDeviceId: DEVICE_A_ID,
        sourceDeviceSequence: 1,
        state: "present",
        materializedAt: CREATED_AT,
      },
      expectedSourceOperationId: null,
    }),
  );
  expectOk(
    await device.authority.enqueueProjectionJob({
      jobId: PROJECTION_JOB_ID,
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      objectType: "chapter_version",
      objectId: CHAPTER_ID,
      objectGeneration: 1,
      projectionKind: "upsert",
      versionId: VERSION_ID,
      sourceRevision: 1,
      keyVersion: KEY_VERSION,
      consentRevision: 1,
      deviceId: DEVICE_A_ID,
      createdAt: CREATED_AT,
      nextAttemptAt: NOW,
    }),
  );
}

async function authorizeProjectKeyForBothDevices(
  deviceA: DeviceHarness,
  deviceB: DeviceHarness,
): Promise<CloudProjectKeySet> {
  expectOk(await deviceA.keyStore.saveDevicePublicKey(asRemoteDeviceRecord(deviceB.deviceRecord)));
  expectOk(await deviceB.keyStore.saveDevicePublicKey(asRemoteDeviceRecord(deviceA.deviceRecord)));

  const pending = await deviceA.keyLifecycle.prepareInitialProjectKey(
    PROJECT_ID,
    deviceA.deviceRecord,
  );
  expect(pending.recoveryCode).toBe(RECOVERY_CODE);
  const activeBundle = await deviceA.keyLifecycle.confirmPendingProjectKey(
    PROJECT_ID,
    DEVICE_A_ID,
    pending.recoveryCode,
  );
  const deviceEnvelopes = await deviceA.keyLifecycle.createDeviceEnvelopesForExistingKey(
    PROJECT_ID,
    deviceA.deviceRecord,
    [deviceA.deviceRecord, deviceB.deviceRecord],
    KEY_VERSION,
  );
  const deviceBEnvelope = deviceEnvelopes.find(
    ({ recipientDeviceId }) => recipientDeviceId === DEVICE_B_ID,
  );
  if (deviceBEnvelope === undefined) {
    throw new Error("Device A did not create a project-key envelope for device B.");
  }
  expectOk(await deviceA.keyStore.saveDeviceEnvelope(deviceBEnvelope));

  const keySet: CloudProjectKeySet = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    projectId: PROJECT_ID,
    keyVersion: KEY_VERSION,
    serverRevision: 1,
    publication: {
      projectId: PROJECT_ID,
      keyVersion: KEY_VERSION,
      serverRevision: 1,
      publicationRequestSha256: "f".repeat(64),
      publishedAt: NOW,
    },
    version: activeBundle.version,
    recoveryEnvelope: activeBundle.recoveryEnvelope,
    deviceEnvelopes: [...deviceEnvelopes],
    updatedAt: NOW,
  };
  expectOk(
    await deviceB.keyStore.saveCloudProjectKeySet({
      keySet,
      makeCurrent: true,
    }),
  );
  return keySet;
}

function asRemoteDeviceRecord(record: DevicePublicKeyRecord): DevicePublicKeyRecord {
  return {
    ...record,
    displayName: `${record.displayName} (remote)`,
    keyOrigin: "remote_registered",
  };
}

function toIncomingApplyOutcome(
  outcome: Awaited<ReturnType<ContentSyncMaterializer["applyPrepared"]>>,
): IncomingApplyOutcome {
  switch (outcome.status) {
    case "applied":
    case "skipped":
      return { status: outcome.status };
    case "conflict":
      return { status: "conflict", code: "SYNC_CONTENT_CONFLICT" };
    case "retry":
      return { status: "retry", code: outcome.code };
  }
}

async function readOutboxState(
  device: DeviceHarness,
): Promise<readonly { attempt: number; status: string }[]> {
  return device.executor.select<{ attempt: number; status: string }>(
    "SELECT attempt, status FROM sync_outbox_operations ORDER BY operation_id",
  );
}

async function readSyncPersistenceState(device: DeviceHarness): Promise<unknown> {
  const [registrations, remoteCheckpoints, materializedCheckpoints, inbox, outbox, projectionJobs] =
    await Promise.all([
      device.executor.select<Record<string, unknown>>(
        "SELECT * FROM project_sync_registrations ORDER BY project_id",
      ),
      device.executor.select<Record<string, unknown>>(
        "SELECT * FROM sync_remote_checkpoints ORDER BY project_id",
      ),
      device.executor.select<Record<string, unknown>>(
        "SELECT * FROM sync_materialized_checkpoints ORDER BY project_id",
      ),
      device.executor.select<Record<string, unknown>>(
        "SELECT * FROM sync_inbox_operations ORDER BY operation_id",
      ),
      device.executor.select<Record<string, unknown>>(
        "SELECT * FROM sync_outbox_operations ORDER BY operation_id",
      ),
      device.executor.select<Record<string, unknown>>(
        "SELECT * FROM sync_projection_jobs ORDER BY job_id",
      ),
    ]);
  return {
    registrations,
    remoteCheckpoints,
    materializedCheckpoints,
    inbox,
    outbox,
    projectionJobs,
  };
}

async function readChapter(device: DeviceHarness): Promise<
  readonly {
    title: string;
    content: string;
    revision: number;
    current_version_id: string;
  }[]
> {
  return device.executor.select<{
    title: string;
    content: string;
    revision: number;
    current_version_id: string;
  }>(
    `SELECT title, content, revision, current_version_id
     FROM chapters
     WHERE id = ?`,
    [CHAPTER_ID],
  );
}

class TestCloudSession {
  private revoked = false;

  public constructor(private readonly status: ConfiguredCloudSessionStatus) {}

  public revoke(): void {
    this.revoked = true;
  }

  public runWithSession<Value>(
    operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<Value> {
    if (options.signal?.aborted === true) {
      return Promise.reject(new DOMException("The sync cycle was aborted.", "AbortError"));
    }
    if (this.revoked) {
      return Promise.reject(
        new CloudSessionCoordinatorError(
          "device_revoked",
          "AUTH_DEVICE_REVOKED",
          "The device was revoked before cloud synchronization.",
        ),
      );
    }
    return operation(this.status);
  }
}

class InMemoryCiphertextCloud implements CloudTransport {
  public readonly handlesSessionAuthentication = true;
  public readonly observedPushBodies: CloudSyncPushRequest[] = [];
  public readonly pushIdempotencyKeys: string[] = [];
  public readonly operationDispositions: (readonly ("accepted" | "duplicate")[])[] = [];
  public firstDataPull: CloudSyncPullResponse | null = null;

  private readonly committed: CloudSyncPushRequest[] = [];
  private readonly responsesByIdempotencyKey = new Map<
    string,
    {
      readonly requestBody: string;
      readonly response: CloudSyncPushResponse;
    }
  >();
  private failPushBeforeCommit = false;
  private failPushAfterCommit = false;
  private requests = 0;

  public get requestCount(): number {
    return this.requests;
  }

  public get committedOperationCount(): number {
    return this.committed.reduce((count, request) => count + request.operations.length, 0);
  }

  public failNextPushBeforeCommit(): void {
    this.failPushBeforeCommit = true;
  }

  public failNextPushAfterCommit(): void {
    this.failPushAfterCommit = true;
  }

  public send(request: CloudTransportRequest): Promise<CloudTransportResponse> {
    this.requests += 1;
    if (request.signal?.aborted === true) {
      return Promise.reject(new DOMException("The cloud request was aborted.", "AbortError"));
    }
    const url = new URL(request.path, "https://inkshadow.test");
    const projectId = readProjectId(url.pathname);
    if (projectId !== PROJECT_ID) {
      throw new Error("The in-memory cloud received a request for another project.");
    }
    if (request.method === "GET" && url.pathname.endsWith("/sync/pull")) {
      return Promise.resolve(this.pull(request, url));
    }
    if (request.method === "POST" && url.pathname.endsWith("/sync/push")) {
      return this.push(request);
    }
    throw new Error(`Unexpected cloud route: ${request.method} ${url.pathname}`);
  }

  private pull(request: CloudTransportRequest, url: URL): CloudTransportResponse {
    const requestId = requireRequestHeader(request, "X-Request-Id");
    const cursor = url.searchParams.get("cursor");
    const start = parseCursor(cursor);
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const selected = this.committed.slice(start, start + limit);
    const nextIndex = start + selected.length;
    const advances = nextIndex > start || cursor === null;
    const response: CloudSyncPullResponse = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId,
      operations: selected.flatMap((entry) => entry.operations),
      chunks: selected.flatMap((entry) => entry.chunks),
      tombstones: selected.flatMap((entry) => entry.tombstones),
      nextCursor: cursorFor(advances ? nextIndex : start),
      hasMore: advances,
    };
    if (response.operations.length > 0 && this.firstDataPull === null) {
      this.firstDataPull = structuredClone(response);
    }
    return successResponse(requestId, response);
  }

  private push(request: CloudTransportRequest): Promise<CloudTransportResponse> {
    const requestId = requireRequestHeader(request, "X-Request-Id");
    const idempotencyKey = requireRequestHeader(request, "Idempotency-Key");
    const body = CloudSyncPushRequestSchema.parse(request.body);
    this.observedPushBodies.push(structuredClone(body));
    this.pushIdempotencyKeys.push(idempotencyKey);
    if (this.failPushBeforeCommit) {
      this.failPushBeforeCommit = false;
      return Promise.reject(new Error("simulated offline transport before durable cloud commit"));
    }

    const replay = this.responsesByIdempotencyKey.get(idempotencyKey);
    if (replay !== undefined) {
      if (replay.requestBody !== JSON.stringify(body)) {
        return Promise.reject(
          new Error("An idempotency key was reused with a different push body."),
        );
      }
      return Promise.resolve(successResponse(requestId, { ...replay.response, requestId }));
    }
    const knownOperationIds = new Set(
      this.committed.flatMap((entry) => entry.operations.map(({ operationId }) => operationId)),
    );
    const dispositions = body.operations.map(({ operationId }) => ({
      operationId,
      disposition: knownOperationIds.has(operationId)
        ? ("duplicate" as const)
        : ("accepted" as const),
    }));
    this.operationDispositions.push(dispositions.map(({ disposition }) => disposition));
    if (dispositions.some(({ disposition }) => disposition === "accepted")) {
      this.committed.push(structuredClone(body));
    }
    const response: CloudSyncPushResponse = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId,
      acceptedOperations: dispositions,
      remoteCursor: cursorFor(this.committed.length),
      serverTime: NOW,
    };
    this.responsesByIdempotencyKey.set(idempotencyKey, {
      requestBody: JSON.stringify(body),
      response,
    });
    if (this.failPushAfterCommit) {
      this.failPushAfterCommit = false;
      return Promise.reject(new Error("simulated offline transport after durable cloud commit"));
    }
    return Promise.resolve(successResponse(requestId, response));
  }
}

class MemoryNativeProjectKeyVaultBackend {
  private readonly identities = new Map<string, DeviceIdentitySummary>();
  private readonly deviceEnvelopes = new Map<
    string,
    {
      readonly envelope: NativeDeviceProjectKeyEnvelope;
      readonly material: ProjectDataKeyMaterial;
    }
  >();
  private readonly recoveryEnvelopes = new Map<
    string,
    {
      readonly envelope: NativeRecoveryProjectKeyEnvelope;
      readonly material: ProjectDataKeyMaterial;
      readonly recoveryCode: string;
    }
  >();

  public constructor(private readonly material: ProjectDataKeyMaterial) {}

  public bind(
    deviceId: UuidV7,
    publicKeyCharacter: string,
    fingerprintCharacter: string,
  ): ProjectKeyVault {
    return new BoundMemoryNativeProjectKeyVault(
      this,
      deviceId,
      publicKeyCharacter,
      fingerprintCharacter,
    );
  }

  public createIdentity(
    expectedDeviceId: string,
    requestedDeviceId: string,
    publicKeyCharacter: string,
    fingerprintCharacter: string,
  ): DeviceIdentitySummary {
    if (requestedDeviceId !== expectedDeviceId) {
      throw new Error("The native vault was asked to create a different device identity.");
    }
    const identity: DeviceIdentitySummary = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      deviceId: requestedDeviceId,
      algorithm: "DHKEM-P256-HKDF-SHA256",
      publicKey: publicKeyCharacter.repeat(87),
      publicKeyFingerprint: fingerprintCharacter.repeat(64),
      privateKeyStorage: "os_credential_store",
    };
    this.identities.set(requestedDeviceId, identity);
    return structuredClone(identity);
  }

  public identityStatus(expectedDeviceId: string, requestedDeviceId: string): DeviceIdentityStatus {
    if (requestedDeviceId !== expectedDeviceId) {
      throw new Error("The native vault was asked to inspect a different device identity.");
    }
    const identity = this.identities.get(requestedDeviceId) ?? null;
    return {
      configured: identity !== null,
      identity: identity === null ? null : structuredClone(identity),
    };
  }

  public generateProjectDataKey(): ProjectDataKeyMaterial {
    return structuredClone(this.material);
  }

  public wrapProjectDataKeyForDevice(
    localDeviceId: string,
    input: WrapProjectDataKeyInput,
  ): NativeDeviceProjectKeyEnvelope {
    if (
      input.senderDeviceId !== localDeviceId ||
      input.rawProjectDataKey !== this.material.rawProjectDataKey
    ) {
      throw new Error("The native vault refused a project key outside the local sender authority.");
    }
    const sender = this.requireIdentity(localDeviceId);
    const recipient = this.requireIdentity(input.recipientDeviceId);
    if (
      input.recipientPublicKey !== recipient.publicKey ||
      input.recipientPublicKeyFingerprint !== recipient.publicKeyFingerprint
    ) {
      throw new Error("The project-key envelope recipient identity does not match.");
    }
    const envelope: NativeDeviceProjectKeyEnvelope = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
      envelopeId: input.envelopeId,
      projectId: input.projectId,
      keyVersion: input.keyVersion,
      senderDeviceId: sender.deviceId,
      senderPublicKey: sender.publicKey,
      senderPublicKeyFingerprint: sender.publicKeyFingerprint,
      recipientDeviceId: recipient.deviceId,
      recipientPublicKey: recipient.publicKey,
      recipientPublicKeyFingerprint: recipient.publicKeyFingerprint,
      encapsulatedKey: "K".repeat(87),
      ciphertext: "C".repeat(64),
    };
    this.deviceEnvelopes.set(envelope.envelopeId, {
      envelope: structuredClone(envelope),
      material: structuredClone(this.material),
    });
    return envelope;
  }

  public unwrapProjectDataKeyForDevice(
    localDeviceId: string,
    envelope: NativeDeviceProjectKeyEnvelope,
  ): ProjectDataKeyMaterial {
    const identity = this.requireIdentity(localDeviceId);
    const stored = this.deviceEnvelopes.get(envelope.envelopeId);
    if (
      stored === undefined ||
      envelope.recipientDeviceId !== localDeviceId ||
      envelope.recipientPublicKey !== identity.publicKey ||
      envelope.recipientPublicKeyFingerprint !== identity.publicKeyFingerprint ||
      JSON.stringify(envelope) !== JSON.stringify(stored.envelope)
    ) {
      throw new Error("The native vault refused an envelope for another device authority.");
    }
    return structuredClone(stored.material);
  }

  public createProjectRecoveryKit(
    localDeviceId: string,
    input: CreateRecoveryKitInput,
  ): RecoveryKit {
    this.requireIdentity(localDeviceId);
    if (input.rawProjectDataKey !== this.material.rawProjectDataKey) {
      throw new Error("The native vault refused recovery material for another project key.");
    }
    const envelope: NativeRecoveryProjectKeyEnvelope = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: "ARGON2ID-AES256GCM",
      recoveryId: input.recoveryId,
      projectId: input.projectId,
      keyVersion: input.keyVersion,
      kdf: {
        algorithm: "ARGON2ID",
        version: 19,
        memoryKib: 65_536,
        timeCost: 3,
        parallelism: 4,
        outputBytes: 64,
      },
      salt: "S".repeat(22),
      nonce: "N".repeat(16),
      ciphertext: "R".repeat(64),
      verifier: "V".repeat(43),
    };
    this.recoveryEnvelopes.set(input.recoveryId, {
      envelope: structuredClone(envelope),
      material: structuredClone(this.material),
      recoveryCode: RECOVERY_CODE,
    });
    return { recoveryCode: RECOVERY_CODE, envelope };
  }

  public verifyProjectRecoveryKit(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): RecoveryVerification {
    const stored = this.requireRecoveryEnvelope(recoveryCode, envelope);
    return {
      valid: true,
      projectKeyFingerprint: stored.material.projectKeyFingerprint,
    };
  }

  public recoverProjectDataKey(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): ProjectDataKeyMaterial {
    return structuredClone(this.requireRecoveryEnvelope(recoveryCode, envelope).material);
  }

  private requireIdentity(deviceId: string): DeviceIdentitySummary {
    const identity = this.identities.get(deviceId);
    if (identity === undefined) {
      throw new Error("The native vault does not contain the requested device identity.");
    }
    return identity;
  }

  private requireRecoveryEnvelope(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): {
    readonly envelope: NativeRecoveryProjectKeyEnvelope;
    readonly material: ProjectDataKeyMaterial;
    readonly recoveryCode: string;
  } {
    const stored = this.recoveryEnvelopes.get(envelope.recoveryId);
    if (
      stored?.recoveryCode !== recoveryCode ||
      JSON.stringify(envelope) !== JSON.stringify(stored.envelope)
    ) {
      throw new Error("The native vault refused invalid project recovery material.");
    }
    return stored;
  }
}

class BoundMemoryNativeProjectKeyVault implements ProjectKeyVault {
  public readonly available = true;

  public constructor(
    private readonly backend: MemoryNativeProjectKeyVaultBackend,
    private readonly deviceId: UuidV7,
    private readonly publicKeyCharacter: string,
    private readonly fingerprintCharacter: string,
  ) {}

  public createDeviceIdentity(deviceId: string): Promise<DeviceIdentitySummary> {
    return Promise.resolve(
      this.backend.createIdentity(
        this.deviceId,
        deviceId,
        this.publicKeyCharacter,
        this.fingerprintCharacter,
      ),
    );
  }

  public getDeviceIdentityStatus(deviceId: string): Promise<DeviceIdentityStatus> {
    return Promise.resolve(this.backend.identityStatus(this.deviceId, deviceId));
  }

  public generateProjectDataKey(): Promise<ProjectDataKeyMaterial> {
    return Promise.resolve(this.backend.generateProjectDataKey());
  }

  public wrapProjectDataKeyForDevice(
    input: WrapProjectDataKeyInput,
  ): Promise<NativeDeviceProjectKeyEnvelope> {
    return Promise.resolve(this.backend.wrapProjectDataKeyForDevice(this.deviceId, input));
  }

  public unwrapProjectDataKeyForDevice(
    envelope: NativeDeviceProjectKeyEnvelope,
  ): Promise<ProjectDataKeyMaterial> {
    return Promise.resolve(this.backend.unwrapProjectDataKeyForDevice(this.deviceId, envelope));
  }

  public rewrapProjectDataKeyForTeamRecipients(
    input: RewrapProjectDataKeyForTeamRecipientsInput,
  ): Promise<readonly NativeTeamProjectKeyEnvelope[]> {
    const material = this.backend.unwrapProjectDataKeyForDevice(
      this.deviceId,
      input.sourceEnvelope,
    );
    return Promise.resolve(
      input.recipients.map((recipient) => {
        const wrapped = this.backend.wrapProjectDataKeyForDevice(this.deviceId, {
          envelopeId: recipient.envelopeId,
          projectId: input.projectId,
          keyVersion: input.keyVersion,
          senderDeviceId: input.senderDeviceId,
          recipientDeviceId: recipient.recipientDeviceId,
          recipientPublicKey: recipient.recipientPublicKey,
          recipientPublicKeyFingerprint: recipient.recipientPublicKeyFingerprint,
          rawProjectDataKey: material.rawProjectDataKey,
        });
        return {
          ...wrapped,
          envelopeKind: "team_project_member_device" as const,
          teamId: input.teamId,
          membershipId: recipient.membershipId,
          membershipRevision: recipient.membershipRevision,
          assignmentId: recipient.assignmentId,
          assignmentRevision: recipient.assignmentRevision,
        };
      }),
    );
  }

  public acceptCurrentDeviceTeamProjectKeyEnvelopeFromCloud(
    input: AcceptCurrentDeviceTeamProjectKeyEnvelopeInput,
  ): Promise<NativeTeamProjectKeyReceiptCommit> {
    void input;
    return Promise.reject(new Error("This local dual-device fixture has no cloud team envelope."));
  }

  public inspectStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<NativeTeamProjectKeyReceiptStatus> {
    void input;
    return Promise.reject(new Error("This local dual-device fixture has no cloud team receipt."));
  }

  public openStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<ProjectDataKeyMaterial> {
    void input;
    return Promise.reject(new Error("This local dual-device fixture has no cloud team receipt."));
  }

  public removeStoredTeamProjectKeyReceipt(
    input: TeamProjectKeyReceiptAccessInput,
  ): Promise<NativeTeamProjectKeyReceiptRemoval> {
    void input;
    return Promise.reject(new Error("This local dual-device fixture has no cloud team receipt."));
  }

  public createProjectRecoveryKit(input: CreateRecoveryKitInput): Promise<RecoveryKit> {
    return Promise.resolve(this.backend.createProjectRecoveryKit(this.deviceId, input));
  }

  public verifyProjectRecoveryKit(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): Promise<RecoveryVerification> {
    return Promise.resolve(this.backend.verifyProjectRecoveryKit(recoveryCode, envelope));
  }

  public recoverProjectDataKey(
    recoveryCode: string,
    envelope: NativeRecoveryProjectKeyEnvelope,
  ): Promise<ProjectDataKeyMaterial> {
    return Promise.resolve(this.backend.recoverProjectDataKey(recoveryCode, envelope));
  }
}

class MutableClock implements Clock {
  public constructor(private timestamp: IsoUtcTimestamp) {}

  public now(): IsoUtcTimestamp {
    return this.timestamp;
  }

  public advance(milliseconds: number): void {
    this.timestamp = timestamp(new Date(Date.parse(this.timestamp) + milliseconds).toISOString());
  }
}

class SequentialIds implements UuidV7Generator {
  public constructor(private nextValue: number) {}

  public next(): UuidV7 {
    const value = id(this.nextValue);
    this.nextValue += 1;
    return value;
  }
}

class ListedIds implements UuidV7Generator {
  private index = 0;

  public constructor(private readonly values: readonly UuidV7[]) {}

  public next(): UuidV7 {
    const value = this.values[this.index];
    if (value === undefined) {
      throw new Error("The project-key fixture exhausted its deterministic UUIDs.");
    }
    this.index += 1;
    return value;
  }
}

function configuredSession(deviceId: UuidV7, sessionId: UuidV7): ConfiguredCloudSessionStatus {
  const fingerprint = deviceId === DEVICE_A_ID ? "a".repeat(64) : "b".repeat(64);
  const publicKey = deviceId === DEVICE_A_ID ? "A".repeat(87) : "B".repeat(87);
  return {
    configured: true,
    account: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      accountId: ACCOUNT_ID,
      state: "active",
      revision: 1,
      verifiedAt: CREATED_AT,
      deletionScheduledFor: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    device: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      device: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId,
        accountId: ACCOUNT_ID,
        state: "trusted",
        publicKeyFingerprint: fingerprint,
        createdAt: CREATED_AT,
        revokedAt: null,
      },
      publicKey: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        deviceId,
        accountId: ACCOUNT_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256",
        publicKey,
        publicKeyFingerprint: fingerprint,
        createdAt: CREATED_AT,
        revokedAt: null,
      },
      displayName: deviceId === DEVICE_A_ID ? "Device A" : "Device B",
      revision: 1,
    },
    session: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      sessionId,
      accountId: ACCOUNT_ID,
      deviceId,
      clientVersion: "0.1.0",
      minimumClientVersion: "0.1.0",
      issuedAt: CREATED_AT,
      expiresAt: timestamp("2026-08-28T01:00:00.000Z"),
      revokedAt: null,
    },
    expiry: {
      accessExpiresAt: timestamp("2026-07-28T03:00:00.000Z"),
      refreshExpiresAt: timestamp("2026-08-28T01:00:00.000Z"),
    },
  };
}

function successResponse(requestId: string, body: unknown): CloudTransportResponse {
  return {
    status: 200,
    headers: { "x-request-id": requestId },
    body,
  };
}

function requireRequestHeader(request: CloudTransportRequest, name: string): string {
  const value = request.headers[name];
  if (value === undefined) {
    throw new Error(`The cloud request omitted ${name}.`);
  }
  return value;
}

function readProjectId(pathname: string): string {
  const match = /^\/v1\/projects\/([^/]+)\/sync\/(?:pull|push)$/u.exec(pathname);
  if (match?.[1] === undefined) {
    throw new Error(`Unexpected cloud sync path: ${pathname}`);
  }
  return decodeURIComponent(match[1]);
}

function cursorFor(index: number): string {
  return `cursor_${String(index)}`;
}

function parseCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  const match = /^cursor_(\d+)$/u.exec(cursor);
  const value = Number(match?.[1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid in-memory cloud cursor: ${cursor}`);
  }
  return value;
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

function id(value: number): UuidV7 {
  const parsed = parseUuidV7(`019fa128-0000-7000-8000-${value.toString(16).padStart(12, "0")}`);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

function timestamp(value: string): IsoUtcTimestamp {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}

async function createProjectKeyMaterial(): Promise<ProjectDataKeyMaterial> {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  try {
    return {
      rawProjectDataKey: encodeBase64Url(bytes),
      projectKeyFingerprint: await sha256Hex(bytes),
    };
  } finally {
    bytes.fill(0);
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    owned.fill(0);
  }
}

function readMigration(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), "../../packages/data/migrations", name),
    path.resolve(process.cwd(), "packages/data/migrations", name),
  ];
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (filePath === undefined) {
    throw new Error(`Could not locate ${name}.`);
  }
  return readFileSync(filePath, "utf8");
}
