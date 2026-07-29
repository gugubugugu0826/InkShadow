import { createECDH, createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CloudProjectKeyPublishRequestSchema,
  CloudProjectKeyResponseSchema,
  CloudProjectStateResponseSchema,
  CloudSyncPullResponseSchema,
  CloudSyncPushRequestSchema,
  CloudSyncPushResponseSchema,
  CloudSyncSnapshotResponseSchema,
  CONTRACT_SCHEMA_VERSION,
  SYNC_PROTOCOL_SCHEMA_VERSION,
  type CloudDeviceRegistrationInput,
  type CloudProjectKeyPublishRequest,
  type CloudSyncPushRequest,
  type CloudTombstoneAcknowledgementRequest,
  type SyncOperationContract,
} from "@inkshadow/contracts";
import type { Pool } from "pg";

import { PostgresCloudIdentityStore } from "../src/postgres/identity-store.js";
import { runCloudMigrations } from "../src/postgres/migrations.js";
import { createCloudPostgresPool } from "../src/postgres/pool.js";
import { PostgresCloudProjectStore } from "../src/postgres/project-store.js";
import type {
  CloudProjectStore,
  CloudProjectTransaction,
} from "../src/repository/project-store.js";
import { hashUtf8 } from "../src/security/canonical-hash.js";
import { CloudPageCursorCodec } from "../src/security/page-cursor.js";
import { ScryptPasswordHasher } from "../src/security/passwords.js";
import { SyncCursorCodec } from "../src/security/sync-cursor.js";
import { SyncSnapshotCursorCodec } from "../src/security/sync-snapshot-cursor.js";
import { CloudTokenService } from "../src/security/tokens.js";
import { createMonotonicUuidV7Factory } from "../src/security/uuid-v7.js";
import {
  CloudIdentityService,
  type IdentityChallengeDelivery,
  type IdentityChallengeNotifier,
} from "../src/service/identity-service.js";
import { CloudProjectSyncService } from "../src/service/project-sync-service.js";

const databaseUrl = process.env.INKSHADOW_TEST_POSTGRES_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

class ProjectTestNotifier implements IdentityChallengeNotifier {
  public readonly deliveries: IdentityChallengeDelivery[] = [];

  public deliver(delivery: IdentityChallengeDelivery): Promise<void> {
    this.deliveries.push(delivery);
    return Promise.resolve();
  }
}

class SequenceReadGateStore implements CloudProjectStore {
  public readonly firstSequenceReadEntered: Promise<void>;

  private firstSequenceReadResolver!: () => void;
  private releaseFirstSequenceReadResolver!: () => void;
  private readonly releaseFirstSequenceReadPromise: Promise<void>;
  private sequenceReadCount = 0;

  public constructor(private readonly delegate: CloudProjectStore) {
    this.firstSequenceReadEntered = new Promise((resolve) => {
      this.firstSequenceReadResolver = resolve;
    });
    this.releaseFirstSequenceReadPromise = new Promise((resolve) => {
      this.releaseFirstSequenceReadResolver = resolve;
    });
  }

  public releaseFirstSequenceRead(): void {
    this.releaseFirstSequenceReadResolver();
  }

  public transaction<T>(
    operation: (transaction: CloudProjectTransaction) => Promise<T>,
  ): Promise<T> {
    return this.delegate.transaction((transaction) =>
      operation(
        new Proxy(transaction, {
          get: (target, property) => {
            if (property === "findLatestDeviceSequence") {
              return async (tenantId: string, projectId: string, deviceId: string) => {
                const latest = await target.findLatestDeviceSequence(tenantId, projectId, deviceId);
                this.sequenceReadCount += 1;
                if (this.sequenceReadCount === 1) {
                  this.firstSequenceReadResolver();
                  await this.releaseFirstSequenceReadPromise;
                }
                return latest;
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return value;
          },
        }),
      ),
    );
  }
}

describePostgres("PostgreSQL project keys and ciphertext sync", () => {
  let pool: Pool;
  let identityService: CloudIdentityService;
  let projectService: CloudProjectSyncService;
  let notifier: ProjectTestNotifier;
  let uuid: ReturnType<typeof createMonotonicUuidV7Factory>;
  let cursorCodec: SyncCursorCodec;
  const now = new Date("2026-07-27T13:00:00.000Z");

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("INKSHADOW_TEST_POSTGRES_URL is required for this integration suite.");
    }
    pool = createCloudPostgresPool({
      connectionString: databaseUrl,
      applicationName: "inkshadow-cloud-project-sync-test",
      maximumConnections: 4,
      requireTls: false,
    });
    await runCloudMigrations(pool);
    uuid = createMonotonicUuidV7Factory(
      () => now.getTime(),
      (target) => randomBytes(target.length).copy(target),
    );
    notifier = new ProjectTestNotifier();
    identityService = new CloudIdentityService({
      clock: () => now,
      minimumClientVersion: "0.1.0",
      notifier,
      pageCursorCodec: new CloudPageCursorCodec(Buffer.alloc(32, 0x81)),
      passwordHasher: new ScryptPasswordHasher({
        cost: 1_024,
        maximumMemoryBytes: 16 * 1024 * 1024,
      }),
      store: new PostgresCloudIdentityStore(pool),
      tokenService: new CloudTokenService({
        challengeCodeKey: Buffer.alloc(32, 0x82),
        challengeHashKey: Buffer.alloc(32, 0x83),
        sessionTokenKey: Buffer.alloc(32, 0x84),
      }),
      uuid,
    });
    cursorCodec = new SyncCursorCodec(Buffer.alloc(32, 0x85));
    projectService = new CloudProjectSyncService({
      clock: () => now,
      cursorCodec,
      snapshotCursorCodec: new SyncSnapshotCursorCodec(Buffer.alloc(32, 0x86)),
      store: new PostgresCloudProjectStore(pool),
      uuid,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("publishes and rotates envelopes, relays exact ciphertext, and preserves tombstones", async () => {
    const suffix = randomBytes(8).toString("hex");
    const device = createDevice(uuid(), "Sync workstation");
    const grant = await createVerifiedAccount({
      device,
      email: `sync-${suffix}@example.test`,
      identityService,
      notifier,
      password: "test-project-sync-password",
      suffix,
      uuid,
    });
    const principal = await identityService.authenticateAccessToken(grant.tokens.accessToken, {
      requestId: uuid(),
    });
    const recipientDevice = createDevice(uuid(), "Sync recipient");
    await identityService.registerDevice(
      principal,
      {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        device: recipientDevice,
      },
      mutationContext(uuid(), `register-sync-recipient-${suffix}`),
    );
    const projectId = uuid();
    const firstKeyRequest = createProjectKeyRequest({
      device,
      expectedServerRevision: null,
      keyVersion: 1,
      projectId,
      recipientDevices: [device, recipientDevice],
      revision: 1,
      uuid,
    });
    const publishContext = mutationContext(uuid(), `publish-key-${suffix}-0001`);
    const published = await projectService.publishProjectKey(
      principal,
      projectId,
      1,
      firstKeyRequest,
      publishContext,
    );
    expect(CloudProjectKeyResponseSchema.safeParse(published).success).toBe(true);
    expect(published.keySet.serverRevision).toBe(1);
    const publishReplay = await projectService.publishProjectKey(
      principal,
      projectId,
      1,
      firstKeyRequest,
      { ...publishContext, requestId: uuid() },
    );
    expect(publishReplay.keySet).toEqual(published.keySet);
    expect(
      (
        await projectService.getProjectKey(principal, projectId, 1, {
          requestId: uuid(),
        })
      ).keySet.version.state,
    ).toBe("active");

    const firstOperation = createUpsertOperation({
      deviceId: device.deviceId,
      deviceSequence: 1,
      keyVersion: 1,
      projectId,
      uuid,
    });
    const firstPushRequest = CloudSyncPushRequestSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      baseCursor: null,
      operations: [firstOperation.operation],
      chunks: [firstOperation.chunk],
      tombstones: [],
    });
    const unsafeSequence = Number.MAX_SAFE_INTEGER + 1;
    const unsafeFirstPushRequest: CloudSyncPushRequest = {
      ...firstPushRequest,
      operations: firstPushRequest.operations.map((operation) => ({
        ...operation,
        deviceSequence: unsafeSequence,
        vector: { ...operation.vector, [device.deviceId]: unsafeSequence },
      })),
    };
    await expect(
      projectService.pushSync(
        principal,
        projectId,
        unsafeFirstPushRequest,
        mutationContext(uuid(), `sync-unsafe-sequence-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      projectService.pushSync(
        principal,
        projectId,
        {
          ...firstPushRequest,
          chunks: [
            {
              ...firstOperation.chunk,
              encrypted: {
                ...firstOperation.chunk.encrypted,
                aad: {
                  ...firstOperation.chunk.encrypted.aad,
                  objectType: "memory",
                },
              },
            },
          ],
        },
        mutationContext(uuid(), `sync-object-type-mismatch-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "SYNC_INVALID_CIPHERTEXT" });
    const pushContext = mutationContext(uuid(), `sync-push-${suffix}-00001`);
    const pushed = await projectService.pushSync(
      principal,
      projectId,
      firstPushRequest,
      pushContext,
    );
    expect(CloudSyncPushResponseSchema.safeParse(pushed).success).toBe(true);
    expect(pushed.acceptedOperations).toEqual([
      {
        disposition: "accepted",
        operationId: firstOperation.operation.operationId,
      },
    ]);
    const pushedReplay = await projectService.pushSync(principal, projectId, firstPushRequest, {
      ...pushContext,
      requestId: uuid(),
    });
    expect(pushedReplay.remoteCursor).toBe(pushed.remoteCursor);
    expect(pushedReplay.acceptedOperations).toEqual(pushed.acceptedOperations);

    const removedBatch = await pool.query(
      `DELETE FROM cloud_sync_batches
       WHERE batch_id = (
         SELECT result_resource_id
         FROM cloud_idempotency_records
         WHERE operation_id = 'sync.push'
           AND actor_account_id = $1
           AND idempotency_key_hash_sha256 = $2
       )`,
      [principal.accountId, hashUtf8(pushContext.idempotencyKey)],
    );
    expect(removedBatch.rowCount).toBe(1);
    const replayAfterBatchRemoval = await projectService.pushSync(
      principal,
      projectId,
      firstPushRequest,
      {
        ...pushContext,
        requestId: uuid(),
      },
    );
    expect({
      ...replayAfterBatchRemoval,
      requestId: pushed.requestId,
    }).toEqual(pushed);

    const duplicate = await projectService.pushSync(
      principal,
      projectId,
      firstPushRequest,
      mutationContext(uuid(), `sync-duplicate-${suffix}`),
    );
    expect(duplicate.acceptedOperations[0]?.disposition).toBe("duplicate");
    const pulled = await projectService.pullSync(principal, projectId, null, 100, {
      requestId: uuid(),
    });
    expect(CloudSyncPullResponseSchema.safeParse(pulled).success).toBe(true);
    expect(pulled.operations).toEqual([firstOperation.operation]);
    expect(pulled.chunks).toEqual([firstOperation.chunk]);

    const deleteOperation = createDeleteOperation({
      deviceId: device.deviceId,
      deviceSequence: 2,
      projectId,
      uuid,
    });
    const deletePush: CloudSyncPushRequest = CloudSyncPushRequestSchema.parse({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      baseCursor: pushed.remoteCursor,
      operations: [deleteOperation.operation],
      chunks: [],
      tombstones: [deleteOperation.tombstone],
    });
    await expect(
      projectService.pushSync(
        principal,
        projectId,
        {
          ...deletePush,
          tombstones: [{ ...deleteOperation.tombstone, objectType: "memory" }],
        },
        mutationContext(uuid(), `sync-tombstone-type-mismatch-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const deleted = await projectService.pushSync(
      principal,
      projectId,
      deletePush,
      mutationContext(uuid(), `sync-delete-${suffix}-0001`),
    );
    const deletePull = await projectService.pullSync(
      principal,
      projectId,
      pushed.remoteCursor,
      100,
      { requestId: uuid() },
    );
    expect(deletePull.operations).toEqual([deleteOperation.operation]);
    expect(deletePull.tombstones).toEqual([deleteOperation.tombstone]);
    const projectState = await projectService.getProjectState(
      principal,
      projectId,
      pushed.remoteCursor,
      { requestId: uuid() },
    );
    expect(CloudProjectStateResponseSchema.safeParse(projectState).success).toBe(true);
    expect(projectState.project).toMatchObject({
      currentKeyPublication: published.keySet.publication,
      currentKeyVersion: 1,
      projectId,
      serverRevision: 1,
      sync: {
        cursorStatus: "incremental_available",
        headCursor: deleted.remoteCursor,
      },
    });
    await expect(
      projectService.getProjectState(principal, projectId, cursorCodec.encode(0n, uuid()), {
        requestId: uuid(),
      }),
    ).resolves.toMatchObject({
      project: { sync: { cursorStatus: "snapshot_required" } },
    });
    const firstSnapshotPage = await projectService.getSyncSnapshot(principal, projectId, null, 1, {
      requestId: uuid(),
    });
    expect(CloudSyncSnapshotResponseSchema.safeParse(firstSnapshotPage).success).toBe(true);
    expect(firstSnapshotPage).toMatchObject({
      projectId,
      operations: [firstOperation.operation],
      chunks: [firstOperation.chunk],
      tombstones: [],
      resumeCursor: deleted.remoteCursor,
      hasMore: true,
    });
    expect(firstSnapshotPage.nextSnapshotCursor).not.toBeNull();
    const secondSnapshotPage = await projectService.getSyncSnapshot(
      principal,
      projectId,
      firstSnapshotPage.nextSnapshotCursor,
      1,
      { requestId: uuid() },
    );
    expect(CloudSyncSnapshotResponseSchema.safeParse(secondSnapshotPage).success).toBe(true);
    expect(secondSnapshotPage).toMatchObject({
      projectId,
      snapshotId: firstSnapshotPage.snapshotId,
      snapshotExpiresAt: firstSnapshotPage.snapshotExpiresAt,
      operations: [deleteOperation.operation],
      chunks: [],
      tombstones: [deleteOperation.tombstone],
      resumeCursor: deleted.remoteCursor,
      nextSnapshotCursor: null,
      hasMore: false,
    });
    await expect(
      projectService.getSyncSnapshot(principal, projectId, deleted.remoteCursor, 1, {
        requestId: uuid(),
      }),
    ).rejects.toMatchObject({ code: "SYNC_CURSOR_EXPIRED" });
    const memoryDeleteOperation = {
      ...deleteOperation.operation,
      operationId: uuid(),
      deviceSequence: 3,
      objectType: "memory" as const,
      vector: { [device.deviceId]: 3 },
    };
    const memoryDeleteTombstone = {
      ...deleteOperation.tombstone,
      objectType: "memory" as const,
      vector: memoryDeleteOperation.vector,
    };
    await projectService.pushSync(
      principal,
      projectId,
      CloudSyncPushRequestSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        baseCursor: deleted.remoteCursor,
        operations: [memoryDeleteOperation],
        chunks: [],
        tombstones: [memoryDeleteTombstone],
      }),
      mutationContext(uuid(), `sync-second-type-delete-${suffix}`),
    );
    await expect(
      projectService.acknowledgeTombstones(
        principal,
        projectId,
        {
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          acknowledgements: [
            {
              objectType: "attachment",
              objectId: deleteOperation.tombstone.objectId,
              objectGeneration: deleteOperation.tombstone.objectGeneration,
            },
          ],
        },
        mutationContext(uuid(), `sync-wrong-type-ack-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    const acknowledgementRequest: CloudTombstoneAcknowledgementRequest = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      acknowledgements: [
        {
          objectType: deleteOperation.tombstone.objectType,
          objectId: deleteOperation.tombstone.objectId,
          objectGeneration: deleteOperation.tombstone.objectGeneration,
        },
      ],
    };
    const acknowledgementContext = mutationContext(uuid(), `sync-ack-${suffix}-0000001`);
    const acknowledgement = await projectService.acknowledgeTombstones(
      principal,
      projectId,
      acknowledgementRequest,
      acknowledgementContext,
    );
    const acknowledgementReplay = await projectService.acknowledgeTombstones(
      principal,
      projectId,
      acknowledgementRequest,
      { ...acknowledgementContext, requestId: uuid() },
    );
    expect({
      ...acknowledgementReplay,
      requestId: acknowledgement.requestId,
    }).toEqual(acknowledgement);
    const afterAcknowledgement = await projectService.pullSync(principal, projectId, null, 100, {
      requestId: uuid(),
    });
    expect(
      afterAcknowledgement.tombstones.find(
        (tombstone) => tombstone.objectType === deleteOperation.tombstone.objectType,
      )?.acknowledgedDeviceIds,
    ).toContain(device.deviceId);
    expect(
      afterAcknowledgement.tombstones.find(
        (tombstone) => tombstone.objectType === memoryDeleteTombstone.objectType,
      )?.acknowledgedDeviceIds,
    ).toEqual([]);
    const typedAcknowledgements = await pool.query<{ object_type: string }>(
      `SELECT object_type
       FROM sync_tombstone_acknowledgements
       WHERE tenant_id = $1
         AND project_id = $2
         AND object_id = $3
         AND object_generation = $4
         AND device_id = $5
       ORDER BY object_type`,
      [
        principal.accountId,
        projectId,
        deleteOperation.tombstone.objectId,
        deleteOperation.tombstone.objectGeneration,
        device.deviceId,
      ],
    );
    expect(typedAcknowledgements.rows).toEqual([{ object_type: "chapter_version" }]);
    const acceptedSnapshot = await pool.query<{ response_snapshot: unknown }>(
      `SELECT response_snapshot
       FROM cloud_idempotency_records
       WHERE operation_id = 'sync.acknowledgeTombstones'
         AND actor_account_id = $1
         AND idempotency_key_hash_sha256 = $2`,
      [principal.accountId, hashUtf8(acknowledgementContext.idempotencyKey)],
    );
    expect(acceptedSnapshot.rows).toEqual([{ response_snapshot: acknowledgement }]);

    const tamperedChunkId = uuid();
    const tamperedOperation = {
      ...firstOperation.operation,
      operationId: uuid(),
      deviceSequence: 4,
      vector: { [device.deviceId]: 4 },
      encryptedChunkIds: [tamperedChunkId],
    };
    const tamperedChunk = {
      ...firstOperation.chunk,
      chunkId: tamperedChunkId,
      encrypted: {
        ...firstOperation.chunk.encrypted,
        ciphertextSha256: "00".repeat(32),
      },
    };
    await expect(
      projectService.pushSync(
        principal,
        projectId,
        CloudSyncPushRequestSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          baseCursor: null,
          operations: [tamperedOperation],
          chunks: [tamperedChunk],
          tombstones: [],
        }),
        mutationContext(uuid(), `sync-tampered-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "SYNC_INVALID_CIPHERTEXT" });

    const sequenceConflict = createUpsertOperation({
      deviceId: device.deviceId,
      deviceSequence: 1,
      keyVersion: 1,
      projectId,
      uuid,
    });
    await expect(
      projectService.pushSync(
        principal,
        projectId,
        CloudSyncPushRequestSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          baseCursor: deleted.remoteCursor,
          operations: [sequenceConflict.operation],
          chunks: [sequenceConflict.chunk],
          tombstones: [],
        }),
        mutationContext(uuid(), `sync-sequence-${suffix}`),
      ),
    ).rejects.toMatchObject({ code: "SYNC_SEQUENCE_CONFLICT" });
    await expect(
      projectService.pullSync(principal, projectId, cursorCodec.encode(0n, uuid()), 100, {
        requestId: uuid(),
      }),
    ).rejects.toMatchObject({ code: "SYNC_CURSOR_EXPIRED" });

    const secondKeyRequest = createProjectKeyRequest({
      device,
      expectedServerRevision: 1,
      keyVersion: 2,
      projectId,
      recipientDevices: [device, recipientDevice],
      revision: 2,
      uuid,
    });
    const rotated = await projectService.publishProjectKey(
      principal,
      projectId,
      2,
      secondKeyRequest,
      mutationContext(uuid(), `rotate-key-${suffix}-0001`),
    );
    expect(rotated.keySet.serverRevision).toBe(2);
    const retiringKey = await projectService.getProjectKey(principal, projectId, 1, {
      requestId: uuid(),
    });
    expect(retiringKey.keySet.version).toMatchObject({
      state: "retiring",
      revision: 2,
    });
    await expect(
      projectService.getCurrentProjectKey(principal, projectId, {
        requestId: uuid(),
      }),
    ).resolves.toMatchObject({
      keySet: {
        projectId,
        keyVersion: 2,
        serverRevision: 2,
        version: { state: "active" },
      },
    });

    await identityService.revokeDevice(
      principal,
      recipientDevice.deviceId,
      mutationContext(uuid(), `revoke-sync-recipient-${suffix}`),
    );
    const revokedOldKey = await projectService.getProjectKey(principal, projectId, 1, {
      requestId: uuid(),
    });
    expect(
      revokedOldKey.keySet.deviceEnvelopes.find(
        (envelope) => envelope.recipientDeviceId === recipientDevice.deviceId,
      )?.revokedAt,
    ).toBe(now.toISOString());

    const lateReplayRequestId = uuid();
    const latePublishReplay = await projectService.publishProjectKey(
      principal,
      projectId,
      1,
      firstKeyRequest,
      { ...publishContext, requestId: lateReplayRequestId },
    );
    expect(latePublishReplay.requestId).toBe(lateReplayRequestId);
    expect({
      ...latePublishReplay,
      requestId: published.requestId,
    }).toEqual(published);
    expect(latePublishReplay.keySet.version).toMatchObject({
      state: "active",
      revision: 1,
    });
    expect(
      latePublishReplay.keySet.deviceEnvelopes.find(
        (envelope) => envelope.recipientDeviceId === recipientDevice.deviceId,
      )?.revokedAt,
    ).toBeNull();

    const oldKeyOperation = createUpsertOperation({
      deviceId: device.deviceId,
      deviceSequence: 4,
      keyVersion: 1,
      projectId,
      uuid,
    });
    await expect(
      projectService.pushSync(
        principal,
        projectId,
        CloudSyncPushRequestSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          baseCursor: deleted.remoteCursor,
          operations: [oldKeyOperation.operation],
          chunks: [oldKeyOperation.chunk],
          tombstones: [],
        }),
        mutationContext(uuid(), `retiring-key-sync-${suffix}`),
      ),
    ).resolves.toMatchObject({
      acceptedOperations: [{ disposition: "accepted" }],
    });

    await identityService.revokeDevice(
      principal,
      device.deviceId,
      mutationContext(uuid(), `revoke-sync-device-${suffix}`),
    );
    await expect(
      projectService.getProjectKey(principal, projectId, 2, { requestId: uuid() }),
    ).rejects.toMatchObject({ code: "ACCESS_FORBIDDEN" });
  }, 30_000);

  it("caps incremental pull responses at 10,000 chunks without splitting operations or skipping the head", async () => {
    const suffix = randomBytes(8).toString("hex");
    const device = createDevice(uuid(), "Chunk budget workstation");
    const grant = await createVerifiedAccount({
      device,
      email: `sync-budget-${suffix}@example.test`,
      identityService,
      notifier,
      password: "test-sync-chunk-budget-password",
      suffix,
      uuid,
    });
    const principal = await identityService.authenticateAccessToken(grant.tokens.accessToken, {
      requestId: uuid(),
    });
    const projectId = uuid();
    await projectService.publishProjectKey(
      principal,
      projectId,
      1,
      createProjectKeyRequest({
        device,
        expectedServerRevision: null,
        keyVersion: 1,
        projectId,
        revision: 1,
        uuid,
      }),
      mutationContext(uuid(), `publish-budget-key-${suffix}`),
    );

    const seeded = await seedChunkBudgetOperations({
      chunkCounts: [5_000, 5_000, 2],
      deviceId: device.deviceId,
      now,
      pool,
      projectId,
      tenantId: principal.accountId,
      uuid,
    });
    const state = await projectService.getProjectState(principal, projectId, null, {
      requestId: uuid(),
    });
    expect(cursorCodec.decode(state.project.sync.headCursor, projectId)).toBe(
      seeded.remoteSequences[2],
    );

    const firstPage = await projectService.pullSync(principal, projectId, null, 3, {
      requestId: uuid(),
    });
    expect(CloudSyncPullResponseSchema.safeParse(firstPage).success).toBe(true);
    expect(firstPage.operations.map((operation) => operation.operationId)).toEqual(
      seeded.operationIds.slice(0, 2),
    );
    expect(firstPage.chunks).toHaveLength(10_000);
    expect(new Set(firstPage.chunks.map((chunk) => chunk.chunkId)).size).toBe(10_000);
    expect(firstPage.hasMore).toBe(true);
    expect(cursorCodec.decode(firstPage.nextCursor, projectId)).toBe(seeded.remoteSequences[1]);
    expect(
      firstPage.chunks.some((chunk) => chunk.encrypted.aad.objectId === seeded.objectIds[2]),
    ).toBe(false);

    const secondPage = await projectService.pullSync(
      principal,
      projectId,
      firstPage.nextCursor,
      3,
      { requestId: uuid() },
    );
    expect(CloudSyncPullResponseSchema.safeParse(secondPage).success).toBe(true);
    expect(secondPage.operations.map((operation) => operation.operationId)).toEqual([
      seeded.operationIds[2],
    ]);
    expect(secondPage.chunks).toHaveLength(2);
    expect(
      secondPage.chunks.every((chunk) => chunk.encrypted.aad.objectId === seeded.objectIds[2]),
    ).toBe(true);
    expect(secondPage.hasMore).toBe(false);
    expect(cursorCodec.decode(secondPage.nextCursor, projectId)).toBe(seeded.remoteSequences[2]);

    const exhausted = await projectService.pullSync(
      principal,
      projectId,
      secondPage.nextCursor,
      3,
      { requestId: uuid() },
    );
    expect(exhausted).toMatchObject({
      operations: [],
      chunks: [],
      tombstones: [],
      nextCursor: secondPage.nextCursor,
      hasMore: false,
    });
  }, 30_000);

  it("serializes concurrent pushes for one tenant, project, and device", async () => {
    const suffix = randomBytes(8).toString("hex");
    const device = createDevice(uuid(), "Concurrent sync workstation");
    const grant = await createVerifiedAccount({
      device,
      email: `sync-concurrent-${suffix}@example.test`,
      identityService,
      notifier,
      password: "test-concurrent-sync-password",
      suffix,
      uuid,
    });
    const principal = await identityService.authenticateAccessToken(grant.tokens.accessToken, {
      requestId: uuid(),
    });
    const projectId = uuid();
    await projectService.publishProjectKey(
      principal,
      projectId,
      1,
      createProjectKeyRequest({
        device,
        expectedServerRevision: null,
        keyVersion: 1,
        projectId,
        revision: 1,
        uuid,
      }),
      mutationContext(uuid(), `publish-concurrent-key-${suffix}`),
    );

    const gateStore = new SequenceReadGateStore(new PostgresCloudProjectStore(pool));
    const concurrentService = new CloudProjectSyncService({
      clock: () => now,
      cursorCodec,
      snapshotCursorCodec: new SyncSnapshotCursorCodec(Buffer.alloc(32, 0x86)),
      store: gateStore,
      uuid,
    });
    const firstOperation = createUpsertOperation({
      deviceId: device.deviceId,
      deviceSequence: 1,
      keyVersion: 1,
      projectId,
      uuid,
    });
    const competingOperation = createUpsertOperation({
      deviceId: device.deviceId,
      deviceSequence: 1,
      keyVersion: 1,
      projectId,
      uuid,
    });
    const firstPush = concurrentService.pushSync(
      principal,
      projectId,
      CloudSyncPushRequestSchema.parse({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        baseCursor: null,
        operations: [firstOperation.operation],
        chunks: [firstOperation.chunk],
        tombstones: [],
      }),
      mutationContext(uuid(), `concurrent-push-first-${suffix}`),
    );
    await gateStore.firstSequenceReadEntered;
    const competingPush = concurrentService
      .pushSync(
        principal,
        projectId,
        CloudSyncPushRequestSchema.parse({
          schemaVersion: CONTRACT_SCHEMA_VERSION,
          baseCursor: null,
          operations: [competingOperation.operation],
          chunks: [competingOperation.chunk],
          tombstones: [],
        }),
        mutationContext(uuid(), `concurrent-push-second-${suffix}`),
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    let waitingLockObserved = false;
    try {
      waitingLockObserved = await waitForWaitingAdvisoryLock(
        pool,
        "inkshadow-cloud-project-sync-test",
      );
    } finally {
      gateStore.releaseFirstSequenceRead();
    }

    expect(waitingLockObserved).toBe(true);
    await expect(firstPush).resolves.toMatchObject({
      acceptedOperations: [
        {
          disposition: "accepted",
          operationId: firstOperation.operation.operationId,
        },
      ],
    });
    const competingResult = await competingPush;
    expect(competingResult.ok).toBe(false);
    if (competingResult.ok) {
      throw new Error("The competing sequence unexpectedly committed.");
    }
    expect(competingResult.error).toMatchObject({ code: "SYNC_SEQUENCE_CONFLICT" });

    const pulled = await projectService.pullSync(principal, projectId, null, 100, {
      requestId: uuid(),
    });
    expect(pulled.operations).toEqual([firstOperation.operation]);
    expect(pulled.chunks).toEqual([firstOperation.chunk]);
  }, 30_000);
});

async function waitForWaitingAdvisoryLock(pool: Pool, applicationName: string): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM pg_locks AS lock
         JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
         WHERE lock.locktype = 'advisory'
           AND lock.granted = FALSE
           AND activity.application_name = $1
       ) AS waiting`,
      [applicationName],
    );
    if (result.rows[0]?.waiting === true) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function createVerifiedAccount(options: {
  readonly device: CloudDeviceRegistrationInput;
  readonly email: string;
  readonly identityService: CloudIdentityService;
  readonly notifier: ProjectTestNotifier;
  readonly password: string;
  readonly suffix: string;
  readonly uuid: () => string;
}) {
  const challenge = await options.identityService.registerIdentity(
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      email: options.email,
      password: options.password,
    },
    mutationContext(options.uuid(), `project-register-${options.suffix}`),
  );
  const delivery = options.notifier.deliveries.find(
    (candidate) => candidate.challengeId === challenge.challengeId,
  );
  if (delivery === undefined) {
    throw new Error("The project-sync account challenge was not delivered.");
  }
  return options.identityService.verifyEmail(
    {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      challengeId: challenge.challengeId,
      code: delivery.code,
      device: options.device,
    },
    mutationContext(options.uuid(), `project-verify-${options.suffix}`),
  );
}

function createProjectKeyRequest(options: {
  readonly device: CloudDeviceRegistrationInput;
  readonly expectedServerRevision: number | null;
  readonly keyVersion: number;
  readonly projectId: string;
  readonly recipientDevices?: readonly CloudDeviceRegistrationInput[];
  readonly revision: number;
  readonly uuid: () => string;
}): CloudProjectKeyPublishRequest {
  const createdAt = "2026-07-27T13:00:00.000Z";
  return CloudProjectKeyPublishRequestSchema.parse({
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    expectedServerRevision: options.expectedServerRevision,
    version: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      projectId: options.projectId,
      keyVersion: options.keyVersion,
      algorithm: "AES-256-GCM",
      state: "active",
      revision: options.revision,
      createdAt,
      retiredAt: null,
    },
    recoveryEnvelope: {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: "ARGON2ID-AES256GCM",
      recoveryId: options.uuid(),
      projectId: options.projectId,
      keyVersion: options.keyVersion,
      kdf: {
        algorithm: "ARGON2ID",
        version: 19,
        memoryKib: 65_536,
        timeCost: 3,
        parallelism: 4,
        outputBytes: 64,
      },
      salt: randomBytes(16).toString("base64url"),
      nonce: randomBytes(12).toString("base64url"),
      ciphertext: randomBytes(48).toString("base64url"),
      verifier: randomBytes(32).toString("base64url"),
      createdAt,
      confirmedAt: createdAt,
      revokedAt: null,
    },
    deviceEnvelopes: (options.recipientDevices ?? [options.device]).map((recipientDevice) => ({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
      envelopeId: options.uuid(),
      projectId: options.projectId,
      keyVersion: options.keyVersion,
      senderDeviceId: options.device.deviceId,
      senderPublicKey: options.device.publicKey,
      senderPublicKeyFingerprint: options.device.publicKeyFingerprint,
      recipientDeviceId: recipientDevice.deviceId,
      recipientPublicKey: recipientDevice.publicKey,
      recipientPublicKeyFingerprint: recipientDevice.publicKeyFingerprint,
      encapsulatedKey: randomBytes(65).toString("base64url"),
      ciphertext: randomBytes(48).toString("base64url"),
      createdAt,
      revokedAt: null,
    })),
  });
}

function createUpsertOperation(options: {
  readonly deviceId: string;
  readonly deviceSequence: number;
  readonly keyVersion: number;
  readonly projectId: string;
  readonly uuid: () => string;
}) {
  const operationId = options.uuid();
  const chunkId = options.uuid();
  const objectId = options.uuid();
  const ciphertextBytes = randomBytes(128);
  const operation: SyncOperationContract = {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId,
    projectId: options.projectId,
    deviceId: options.deviceId,
    deviceSequence: options.deviceSequence,
    objectType: "chapter_version",
    objectId,
    objectGeneration: 1,
    kind: "upsert",
    vector: { [options.deviceId]: options.deviceSequence },
    encryptedChunkIds: [chunkId],
    createdAt: "2026-07-27T13:00:00.000Z",
  };
  return {
    operation,
    chunk: {
      chunkId,
      encrypted: {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        algorithm: "AES-256-GCM" as const,
        nonce: randomBytes(12).toString("base64url"),
        ciphertext: ciphertextBytes.toString("base64url"),
        ciphertextSha256: createHash("sha256").update(ciphertextBytes).digest("hex"),
        plaintextBytes: 256,
        aad: {
          projectId: options.projectId,
          objectType: "chapter_version" as const,
          objectId,
          versionId: options.uuid(),
          chunkIndex: 0,
          keyVersion: options.keyVersion,
        },
      },
    },
  };
}

function createDeleteOperation(options: {
  readonly deviceId: string;
  readonly deviceSequence: number;
  readonly projectId: string;
  readonly uuid: () => string;
}) {
  const objectId = options.uuid();
  const operation: SyncOperationContract = {
    schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
    operationId: options.uuid(),
    projectId: options.projectId,
    deviceId: options.deviceId,
    deviceSequence: options.deviceSequence,
    objectType: "chapter_version",
    objectId,
    objectGeneration: 2,
    kind: "delete",
    vector: { [options.deviceId]: options.deviceSequence },
    encryptedChunkIds: [],
    createdAt: "2026-07-27T13:00:00.000Z",
  };
  return {
    operation,
    tombstone: {
      schemaVersion: SYNC_PROTOCOL_SCHEMA_VERSION,
      projectId: options.projectId,
      objectType: "chapter_version" as const,
      objectId,
      objectGeneration: 2,
      deletedByDeviceId: options.deviceId,
      vector: operation.vector,
      deletedAt: "2026-07-27T13:00:00.000Z",
      retainUntil: "2027-07-27T13:00:00.000Z",
      acknowledgedDeviceIds: [],
    },
  };
}

async function seedChunkBudgetOperations(options: {
  readonly chunkCounts: readonly number[];
  readonly deviceId: string;
  readonly now: Date;
  readonly pool: Pool;
  readonly projectId: string;
  readonly tenantId: string;
  readonly uuid: () => string;
}): Promise<{
  readonly objectIds: readonly string[];
  readonly operationIds: readonly string[];
  readonly remoteSequences: readonly bigint[];
}> {
  const client = await options.pool.connect();
  const objectIds: string[] = [];
  const operationIds: string[] = [];
  const remoteSequences: bigint[] = [];
  const nonce = Buffer.alloc(12).toString("base64url");
  const ciphertextBytes = Buffer.from([0]);
  const ciphertext = ciphertextBytes.toString("base64url");
  const ciphertextSha256 = createHash("sha256").update(ciphertextBytes).digest("hex");
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('inkshadow.tenant_id', $1, true)", [options.tenantId]);
    for (const [operationIndex, chunkCount] of options.chunkCounts.entries()) {
      const operationId = options.uuid();
      const objectId = options.uuid();
      const versionId = options.uuid();
      const chunkIds = Array.from({ length: chunkCount }, () => options.uuid());
      const deviceSequence = operationIndex + 1;
      const inserted = await client.query<{ remote_sequence: string }>(
        `INSERT INTO sync_operations (
           tenant_id,
           project_id,
           operation_id,
           device_id,
           device_sequence,
           object_type,
           object_id,
           object_generation,
           kind,
           version_vector,
           encrypted_chunk_ids,
           created_at,
           received_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'chapter_version', $6,
           1, 'upsert', $7::jsonb, $8::uuid[], $9, $9
         )
         RETURNING remote_sequence::text`,
        [
          options.tenantId,
          options.projectId,
          operationId,
          options.deviceId,
          deviceSequence,
          objectId,
          JSON.stringify({ [options.deviceId]: deviceSequence }),
          chunkIds,
          options.now,
        ],
      );
      const remoteSequence = inserted.rows[0]?.remote_sequence;
      if (remoteSequence === undefined) {
        throw new Error("The chunk-budget sync operation did not receive a remote sequence.");
      }
      await client.query(
        `INSERT INTO sync_ciphertext_chunks (
           tenant_id,
           project_id,
           chunk_id,
           operation_id,
           algorithm,
           nonce,
           ciphertext,
           ciphertext_sha256,
           plaintext_bytes,
           object_type,
           object_id,
           version_id,
           chunk_index,
           key_version
         )
         SELECT
           $1::uuid,
           $2::uuid,
           chunk.chunk_id,
           $3::uuid,
           'AES-256-GCM',
           $4,
           $5,
           $6,
           1,
           'chapter_version',
           $7::uuid,
           $8::uuid,
           (chunk.ordinality - 1)::integer,
           1
         FROM unnest($9::uuid[]) WITH ORDINALITY AS chunk(chunk_id, ordinality)`,
        [
          options.tenantId,
          options.projectId,
          operationId,
          nonce,
          ciphertext,
          ciphertextSha256,
          objectId,
          versionId,
          chunkIds,
        ],
      );
      operationIds.push(operationId);
      objectIds.push(objectId);
      remoteSequences.push(BigInt(remoteSequence));
    }
    await client.query("COMMIT");
    return { objectIds, operationIds, remoteSequences };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    ciphertextBytes.fill(0);
    client.release();
  }
}

function createDevice(deviceId: string, displayName: string): CloudDeviceRegistrationInput {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey(undefined, "uncompressed");
  return {
    deviceId,
    displayName,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: publicKey.toString("base64url"),
    publicKeyFingerprint: createHash("sha256").update(publicKey).digest("hex"),
    clientVersion: "0.1.0",
  };
}

function mutationContext(requestId: string, idempotencyKey: string) {
  return { requestId, idempotencyKey };
}
