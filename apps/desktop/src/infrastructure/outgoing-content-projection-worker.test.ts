import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CONTRACT_SCHEMA_VERSION } from "@inkshadow/contracts";
import {
  SyncMaterializationSqliteStore,
  type ExecuteResult,
  type SqlExecutor,
  type SqlPrimitive,
  type TransactionExecutor,
} from "@inkshadow/data";
import {
  parseIsoUtcTimestamp,
  parseUuidV7,
  type Clock,
  type IsoUtcTimestamp,
  type UuidV7,
  type UuidV7Generator,
} from "@inkshadow/domain";
import {
  AesGcmChunkCipher,
  decodeContentSyncPayloadChunks,
  sha256Utf8Content,
  type ContentSyncPayload,
  type EncryptedSyncChunk,
} from "@inkshadow/sync-core";
import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import {
  OutgoingContentProjectionWorker,
  type ProjectionProjectKeyOpener,
} from "./outgoing-content-projection-worker";

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
  readMigration("0001_core.sql"),
  readMigration("0003_sync_access.sql"),
  readMigration("0010_sync_inbox.sql"),
  readMigration("0013_sync_snapshot_staging.sql"),
  readMigration("0014_sync_protocol_v2_object_types.sql"),
  readMigration("0015_sync_materialization_authority.sql"),
  readMigration("0017_sync_projection_account_authority.sql"),
].join("\n");

const PROJECT_ID = id(1);
const CHAPTER_ID = id(2);
const VERSION_ONE_ID = id(3);
const VERSION_TWO_ID = id(4);
const DEVICE_ID = id(5);
const ACCOUNT_ID = id(6);
const WORKER_ID = id(7);
const OTHER_ACCOUNT_ID = id(8);
const PROJECT_JOB_ID = id(10);
const VERSION_ONE_JOB_ID = id(11);
const VERSION_TWO_JOB_ID = id(12);
const PROJECT_RESTORE_JOB_ID = id(13);
const CREATED_AT = "2026-07-28T01:00:00.000Z";
const VERSION_TWO_AT = "2026-07-28T02:00:00.000Z";
const NOW = "2026-07-28T03:00:00.000Z";
const KEY_VERSION = 7;

describe("OutgoingContentProjectionWorker", () => {
  let base: NodeSqliteExecutor;
  let executor: SwitchableExecutor;
  let store: SyncMaterializationSqliteStore;
  let key: CryptoKey;
  let clock: MutableClock;
  let ids: SequentialIds;
  let keyOpener: ProjectionProjectKeyOpener;
  let openExactKey: MockedFunction<ProjectionProjectKeyOpener["openProjectDataKeyForDevice"]>;
  let worker: OutgoingContentProjectionWorker;

  beforeEach(async () => {
    base = new NodeSqliteExecutor(migration);
    executor = new SwitchableExecutor(base);
    store = new SyncMaterializationSqliteStore(executor);
    key = await new AesGcmChunkCipher().generateProjectDataKey();
    clock = new MutableClock(NOW);
    ids = new SequentialIds(1_000);
    openExactKey = vi.fn<ProjectionProjectKeyOpener["openProjectDataKeyForDevice"]>(
      (_projectId: string, _deviceId: string, keyVersion: number) =>
        Promise.resolve({ projectId: PROJECT_ID, keyVersion, key }),
    );
    keyOpener = { openProjectDataKeyForDevice: openExactKey };
    worker = createWorker();
    await insertProject();
    await enableSync();
  });

  afterEach(async () => {
    await base.close();
  });

  it("reports true idle when the current projection authority has no unfinished work", async () => {
    await expect(worker.runOnce(PROJECT_ID)).resolves.toEqual({
      status: "idle",
      projectId: PROJECT_ID,
    });
  });

  it("projects a strict encrypted project manifest with a fresh authenticated version", async () => {
    await enqueueProjectJob();

    const outcome = await worker.runOnce(PROJECT_ID);
    expect(outcome).toMatchObject({
      status: "completed",
      projectId: PROJECT_ID,
      jobId: PROJECT_JOB_ID,
      objectType: "project_manifest",
      sourceRevision: 1,
      deviceSequence: 1,
    });
    expect(openExactKey).toHaveBeenCalledWith(PROJECT_ID, DEVICE_ID, KEY_VERSION);

    const operationId = requireCompletedOperationId(outcome);
    const payload = await decryptOperation(operationId);
    expect(payload).toEqual({
      schemaVersion: 1,
      objectType: "project_manifest",
      projectId: PROJECT_ID,
      objectId: PROJECT_ID,
      objectGeneration: 1,
      project: {
        id: PROJECT_ID,
        name: "InkShadow Sync",
        status: "active",
        revision: 1,
        deletionGeneration: 0,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
        trashedAt: null,
        retentionUntil: null,
        statusBeforeTrash: null,
      },
    });
    expect(
      await executor.select<{ version_id: string; key_version: number }>(
        "SELECT version_id, key_version FROM sync_ciphertext_chunks",
      ),
    ).toEqual([{ version_id: PROJECT_JOB_ID, key_version: KEY_VERSION }]);
    expect(
      await executor.select<{ status: string; operation_id: string }>(
        "SELECT status, operation_id FROM sync_projection_jobs WHERE job_id = ?",
        [PROJECT_JOB_ID],
      ),
    ).toEqual([{ status: "completed", operation_id: operationId }]);
  });

  it("projects project trash as an even-generation tombstone and restore as the next odd upsert", async () => {
    await insertPresentManifestMarker();
    await executor.execute(
      `UPDATE projects
       SET status = 'trashed', revision = 2, deletion_generation = 1,
           updated_at = ?, trashed_at = ?, retention_until = ?,
           status_before_trash = 'active'
       WHERE id = ?`,
      [NOW, NOW, "2026-08-27T03:00:00.000Z", PROJECT_ID],
    );
    expectOk(
      await store.enqueueProjectionJob({
        jobId: PROJECT_JOB_ID,
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        objectType: "project_manifest",
        objectId: PROJECT_ID,
        objectGeneration: 2,
        projectionKind: "delete",
        versionId: null,
        sourceRevision: 2,
        keyVersion: KEY_VERSION,
        consentRevision: 1,
        deviceId: DEVICE_ID,
        createdAt: NOW,
        nextAttemptAt: NOW,
      }),
    );

    const deleted = await worker.runOnce(PROJECT_ID);
    expect(deleted).toMatchObject({
      status: "completed",
      jobId: PROJECT_JOB_ID,
      objectType: "project_manifest",
      deviceSequence: 2,
    });
    expect(openExactKey).not.toHaveBeenCalled();
    const deleteOperationId = requireCompletedOperationId(deleted);
    await expect(
      executor.select<{
        kind: string;
        object_generation: number;
        encrypted_chunks: number;
      }>(
        `SELECT operation.kind, operation.object_generation,
                count(link.chunk_id) AS encrypted_chunks
         FROM sync_outbox_operations AS operation
         LEFT JOIN sync_operation_chunks AS link
           ON link.operation_id = operation.operation_id
         WHERE operation.operation_id = ?
         GROUP BY operation.operation_id`,
        [deleteOperationId],
      ),
    ).resolves.toEqual([{ kind: "delete", object_generation: 2, encrypted_chunks: 0 }]);
    await expect(
      executor.select<{
        object_generation: number;
        deleted_at: string;
        retain_until: string;
        acknowledged_device_ids_json: string;
      }>(
        `SELECT object_generation, deleted_at, retain_until, acknowledged_device_ids_json
         FROM sync_tombstones
         WHERE project_id = ? AND object_type = 'project_manifest' AND object_id = ?`,
        [PROJECT_ID, PROJECT_ID],
      ),
    ).resolves.toEqual([
      {
        object_generation: 2,
        deleted_at: NOW,
        retain_until: "2027-07-28T03:00:00.000Z",
        acknowledged_device_ids_json: "[]",
      },
    ]);
    expect(
      await store.findCurrentMaterializedObject(PROJECT_ID, "project_manifest", PROJECT_ID),
    ).toMatchObject({ ok: true, value: { state: "deleted", objectGeneration: 2 } });

    const restoredAt = "2026-07-28T04:00:00.000Z";
    await executor.execute(
      `UPDATE projects
       SET status = 'active', revision = 3, deletion_generation = 2,
           updated_at = ?, trashed_at = NULL, retention_until = NULL,
           status_before_trash = NULL
       WHERE id = ?`,
      [restoredAt, PROJECT_ID],
    );
    expectOk(
      await store.enqueueProjectionJob({
        jobId: PROJECT_RESTORE_JOB_ID,
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        objectType: "project_manifest",
        objectId: PROJECT_ID,
        objectGeneration: 3,
        projectionKind: "upsert",
        versionId: PROJECT_ID,
        sourceRevision: 3,
        keyVersion: KEY_VERSION,
        consentRevision: 1,
        deviceId: DEVICE_ID,
        createdAt: restoredAt,
        nextAttemptAt: restoredAt,
      }),
    );
    clock.value = restoredAt;

    const restored = await worker.runOnce(PROJECT_ID);
    expect(restored).toMatchObject({
      status: "completed",
      jobId: PROJECT_RESTORE_JOB_ID,
      deviceSequence: 3,
    });
    expect(openExactKey).toHaveBeenCalledTimes(1);
    const restoredPayload = await decryptOperation(requireCompletedOperationId(restored));
    expect(restoredPayload).toMatchObject({
      objectType: "project_manifest",
      objectGeneration: 3,
      project: {
        status: "active",
        revision: 3,
        deletionGeneration: 2,
      },
    });
  });

  it("preserves chapter v1 and v2 as ordered encrypted operations without coalescing history", async () => {
    await insertChapterHistory();
    await insertPresentManifestMarker();
    await enqueueChapterJob(VERSION_ONE_JOB_ID, VERSION_ONE_ID, 1, CREATED_AT);
    await enqueueChapterJob(VERSION_TWO_JOB_ID, VERSION_TWO_ID, 2, VERSION_TWO_AT);

    const first = await worker.runOnce(PROJECT_ID);
    const second = await worker.runOnce(PROJECT_ID);
    expect(first).toMatchObject({
      status: "completed",
      jobId: VERSION_ONE_JOB_ID,
      sourceRevision: 1,
      deviceSequence: 1,
    });
    expect(second).toMatchObject({
      status: "completed",
      jobId: VERSION_TWO_JOB_ID,
      sourceRevision: 2,
      deviceSequence: 2,
    });

    const firstPayload = await decryptOperation(requireCompletedOperationId(first));
    const secondPayload = await decryptOperation(requireCompletedOperationId(second));
    expect(firstPayload.objectType).toBe("chapter_version");
    expect(secondPayload.objectType).toBe("chapter_version");
    if (
      firstPayload.objectType !== "chapter_version" ||
      secondPayload.objectType !== "chapter_version"
    ) {
      throw new Error("Expected chapter payloads.");
    }
    expect(firstPayload.version).toMatchObject({
      id: VERSION_ONE_ID,
      sequence: 1,
      content: "first",
    });
    expect(firstPayload.chapter).toMatchObject({
      currentVersionId: VERSION_ONE_ID,
      revision: 1,
      content: "first",
      title: "Chapter One",
    });
    expect(secondPayload.version).toMatchObject({
      id: VERSION_TWO_ID,
      sequence: 2,
      content: "second",
    });
    expect(
      await executor.select<{ source_revision: number; status: string }>(
        `SELECT source_revision, status
         FROM sync_projection_jobs
         WHERE object_type = 'chapter_version'
         ORDER BY source_revision`,
      ),
    ).toEqual([
      { source_revision: 1, status: "completed" },
      { source_revision: 2, status: "completed" },
    ]);
    expect(
      await executor.select<{ device_sequence: number }>(
        "SELECT device_sequence FROM sync_outbox_operations ORDER BY device_sequence",
      ),
    ).toEqual([{ device_sequence: 1 }, { device_sequence: 2 }]);
  });

  it("makes a human conflict-resolution projection causally dominate both branches", async () => {
    const remoteDeviceId = id(901);
    const remoteOperationId = id(902);
    const markerOperationId = id(903);
    await insertChapterHistory();
    await insertPresentManifestMarker();
    expectOk(
      await store.writeMaterializedObject({
        object: {
          projectId: PROJECT_ID,
          objectType: "chapter_version",
          objectId: CHAPTER_ID,
          objectGeneration: 1,
          versionId: VERSION_ONE_ID,
          vector: { [DEVICE_ID]: 1 },
          payloadSha256: "a".repeat(64),
          sourceOperationId: markerOperationId,
          sourceDeviceId: DEVICE_ID,
          sourceDeviceSequence: 1,
          state: "present",
          materializedAt: CREATED_AT,
        },
        expectedSourceOperationId: null,
      }),
    );
    const conflict = expectOk(
      await store.registerContentConflict({
        conflictId: remoteOperationId,
        projectId: PROJECT_ID,
        objectType: "chapter_version",
        objectId: CHAPTER_ID,
        objectGeneration: 1,
        localVector: { [DEVICE_ID]: 1 },
        remoteVector: { [remoteDeviceId]: 7 },
        remoteOperationId,
        remoteKind: "upsert",
        remotePayloadSha256: "b".repeat(64),
        createdAt: VERSION_TWO_AT,
      }),
    );
    expectOk(
      await store.resolveContentConflict({
        conflictId: conflict.conflictId,
        expectedRevision: conflict.revision,
        resolution: "merged",
        resolutionOperationId: VERSION_TWO_JOB_ID,
        resolvedAt: NOW,
      }),
    );
    await enqueueChapterJob(VERSION_TWO_JOB_ID, VERSION_TWO_ID, 2, VERSION_TWO_AT);

    await expect(worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "completed",
      jobId: VERSION_TWO_JOB_ID,
      deviceSequence: 2,
    });
    const rows = await executor.select<{ vector_json: string }>(
      "SELECT vector_json FROM sync_outbox_operations",
    );
    expect(JSON.parse(rows[0]?.vector_json ?? "{}")).toEqual({
      [DEVICE_ID]: 2,
      [remoteDeviceId]: 7,
    });
  });

  it("rolls back ciphertext and marker when atomic job completion fails", async () => {
    await enqueueProjectJob();
    executor.failNextProjectionCompletion = true;

    const outcome = await worker.runOnce(PROJECT_ID);
    expect(outcome).toMatchObject({
      status: "retry_scheduled",
      jobId: PROJECT_JOB_ID,
      failureCode: "SYNC_PROJECTION_LOCAL_STORE_ERROR",
    });
    expect(await countRows("sync_outbox_operations")).toBe(0);
    expect(await countRows("sync_ciphertext_chunks")).toBe(0);
    expect(await countRows("sync_materialized_objects")).toBe(0);
    expect(
      await executor.select<{ status: string; operation_id: string | null }>(
        "SELECT status, operation_id FROM sync_projection_jobs WHERE job_id = ?",
        [PROJECT_JOB_ID],
      ),
    ).toEqual([{ status: "retry_wait", operation_id: null }]);
    expect(
      await executor.select<{ last_allocated_sequence: number }>(
        "SELECT last_allocated_sequence FROM sync_device_sequences",
      ),
    ).toEqual([{ last_allocated_sequence: 1 }]);

    await expect(worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "backoff",
      projectId: PROJECT_ID,
      jobId: PROJECT_JOB_ID,
      attempt: 1,
      failureCode: "SYNC_PROJECTION_LOCAL_STORE_ERROR",
      nextAttemptAt: "2026-07-28T03:00:05.000Z",
    });
  });

  it("permanently fails when the exact source changes during encryption", async () => {
    await enqueueProjectJob();
    openExactKey = vi.fn<ProjectionProjectKeyOpener["openProjectDataKeyForDevice"]>(
      async (_projectId: string, _deviceId: string, keyVersion: number) => {
        await executor.execute(
          "UPDATE projects SET name = ?, revision = 2, updated_at = ? WHERE id = ?",
          ["Changed during projection", NOW, PROJECT_ID],
        );
        return { projectId: PROJECT_ID, keyVersion, key };
      },
    );
    keyOpener = { openProjectDataKeyForDevice: openExactKey };
    worker = createWorker();

    const changed = await worker.runOnce(PROJECT_ID);
    expect(changed).toMatchObject({
      status: "failed",
      failureCode: "SYNC_PROJECTION_SOURCE_STALE",
    });
    expect(await countRows("sync_outbox_operations")).toBe(0);
    await expect(worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "permanent_failure",
      projectId: PROJECT_ID,
      jobId: PROJECT_JOB_ID,
      attempt: 1,
      failureCode: "SYNC_PROJECTION_SOURCE_STALE",
    });
  });

  it("fails closed if the key opener returns a different historical key version", async () => {
    await enqueueProjectJob();
    openExactKey = vi.fn<ProjectionProjectKeyOpener["openProjectDataKeyForDevice"]>(() =>
      Promise.resolve({ projectId: PROJECT_ID, keyVersion: KEY_VERSION + 1, key }),
    );
    keyOpener = { openProjectDataKeyForDevice: openExactKey };
    worker = createWorker();

    const outcome = await worker.runOnce(PROJECT_ID);
    expect(openExactKey).toHaveBeenCalledWith(PROJECT_ID, DEVICE_ID, KEY_VERSION);
    expect(outcome).toMatchObject({
      status: "failed",
      failureCode: "SYNC_PROJECT_KEY_VERSION_MISMATCH",
    });
    expect(await countRows("sync_outbox_operations")).toBe(0);
  });

  it("surfaces exhausted projection attempts instead of reporting idle", async () => {
    await enqueueProjectJob();
    await executor.execute(
      `UPDATE sync_projection_jobs
       SET status = 'retry_wait',
           attempt = 100,
           revision = 2,
           failure_code = 'TEMPORARY_ENCRYPTION_FAILURE'
       WHERE job_id = ?`,
      [PROJECT_JOB_ID],
    );

    await expect(worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "attempt_exhausted",
      projectId: PROJECT_ID,
      jobId: PROJECT_JOB_ID,
      attempt: 100,
      failureCode: "ATTEMPT_LIMIT_EXCEEDED",
    });
    expect(openExactKey).not.toHaveBeenCalled();
  });

  it("surfaces a missing manifest prerequisite as a blocked projection", async () => {
    await insertChapterHistory();
    await enqueueChapterJob(VERSION_ONE_JOB_ID, VERSION_ONE_ID, 1, CREATED_AT);

    await expect(worker.runOnce(PROJECT_ID)).resolves.toMatchObject({
      status: "blocked",
      projectId: PROJECT_ID,
      jobId: VERSION_ONE_JOB_ID,
      reason: "project_manifest_missing",
      blockerJobId: null,
      resumeAt: null,
    });
    expect(openExactKey).not.toHaveBeenCalled();
  });

  it("cannot complete a leased job after authority switches to another account", async () => {
    await enqueueProjectJob();
    openExactKey = vi.fn<ProjectionProjectKeyOpener["openProjectDataKeyForDevice"]>(
      async (_projectId: string, _deviceId: string, keyVersion: number) => {
        const enabling = expectOk(
          await store.beginProjectSyncEnable({
            projectId: PROJECT_ID,
            accountId: OTHER_ACCOUNT_ID,
            deviceId: DEVICE_ID,
            consentRevision: 1,
            keyVersion: KEY_VERSION,
            expectedRevision: 2,
            begunAt: NOW,
          }),
        );
        expectOk(
          await store.transitionProjectSyncRegistration({
            projectId: PROJECT_ID,
            expectedAccountId: OTHER_ACCOUNT_ID,
            expectedDeviceId: DEVICE_ID,
            expectedConsentRevision: 1,
            expectedKeyVersion: KEY_VERSION,
            expectedRevision: enabling.revision,
            target: { state: "enabled" },
            transitionedAt: NOW,
          }),
        );
        return { projectId: PROJECT_ID, keyVersion, key };
      },
    );
    keyOpener = { openProjectDataKeyForDevice: openExactKey };
    worker = createWorker();

    const outcome = await worker.runOnce(PROJECT_ID);

    expect(outcome).toMatchObject({
      status: "failed",
      jobId: PROJECT_JOB_ID,
      failureCode: "SYNC_REGISTRATION_AUTHORITY_CHANGED",
    });
    expect(await countRows("sync_outbox_operations")).toBe(0);
    expect(await countRows("sync_ciphertext_chunks")).toBe(0);
    expect(await countRows("sync_materialized_objects")).toBe(0);
    expect(
      await executor.select<{ account_id: string; status: string }>(
        "SELECT account_id, status FROM sync_projection_jobs WHERE job_id = ?",
        [PROJECT_JOB_ID],
      ),
    ).toEqual([{ account_id: ACCOUNT_ID, status: "failed" }]);
  });

  it("recovers an expired projection lease before completing the job", async () => {
    await enqueueProjectJob();
    const abandoned = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: id(800),
        leaseToken: id(801),
        leasedAt: NOW,
        leaseExpiresAt: "2026-07-28T03:00:01.000Z",
      }),
    );
    expect(abandoned?.attempt).toBe(1);

    clock.value = "2026-07-28T03:00:02.000Z";
    const outcome = await worker.runOnce(PROJECT_ID);
    expect(outcome).toMatchObject({ status: "completed", jobId: PROJECT_JOB_ID });
    expect(
      await executor.select<{ attempt: number; status: string }>(
        "SELECT attempt, status FROM sync_projection_jobs WHERE job_id = ?",
        [PROJECT_JOB_ID],
      ),
    ).toEqual([{ attempt: 2, status: "completed" }]);
  });

  function createWorker(): OutgoingContentProjectionWorker {
    return new OutgoingContentProjectionWorker({
      executor,
      projectKeys: keyOpener,
      ids,
      clock,
      workerId: WORKER_ID,
      leaseMilliseconds: 60_000,
      retryDelayMilliseconds: () => 5_000,
    });
  }

  async function insertProject(): Promise<void> {
    await executor.execute(
      `INSERT INTO projects (
         id, name, status, revision, deletion_generation, created_at, updated_at,
         archived_at, trashed_at, retention_until, status_before_trash
       ) VALUES (?, 'InkShadow Sync', 'active', 1, 0, ?, ?, NULL, NULL, NULL, NULL)`,
      [PROJECT_ID, CREATED_AT, CREATED_AT],
    );
  }

  async function enableSync(): Promise<void> {
    expectOk(
      await store.beginProjectSyncEnable({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        consentRevision: 1,
        keyVersion: KEY_VERSION,
        expectedRevision: null,
        begunAt: CREATED_AT,
      }),
    );
    expectOk(
      await store.transitionProjectSyncRegistration({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedConsentRevision: 1,
        expectedKeyVersion: KEY_VERSION,
        expectedRevision: 1,
        target: { state: "enabled" },
        transitionedAt: CREATED_AT,
      }),
    );
  }

  async function enqueueProjectJob(): Promise<void> {
    expectOk(
      await store.enqueueProjectionJob({
        jobId: PROJECT_JOB_ID,
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        objectType: "project_manifest",
        objectId: PROJECT_ID,
        objectGeneration: 1,
        projectionKind: "upsert",
        versionId: PROJECT_ID,
        sourceRevision: 1,
        keyVersion: KEY_VERSION,
        consentRevision: 1,
        deviceId: DEVICE_ID,
        createdAt: CREATED_AT,
        nextAttemptAt: NOW,
      }),
    );
  }

  async function insertChapterHistory(): Promise<void> {
    const checksumOne = await sha256Utf8Content("first");
    const checksumTwo = await sha256Utf8Content("second");
    await executor.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, current_version_id,
           created_at, updated_at, trashed_at
         ) VALUES (?, ?, 'Chapter One', 'second', 'active', 2, ?, ?, ?, NULL)`,
        [CHAPTER_ID, PROJECT_ID, VERSION_TWO_ID, CREATED_AT, VERSION_TWO_AT],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, 'first', ?, 'created', NULL, ?)`,
        [VERSION_ONE_ID, PROJECT_ID, CHAPTER_ID, checksumOne, CREATED_AT],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, ?, 2, 'second', ?, 'manual', NULL, ?)`,
        [VERSION_TWO_ID, PROJECT_ID, CHAPTER_ID, VERSION_ONE_ID, checksumTwo, VERSION_TWO_AT],
      );
    });
  }

  async function insertPresentManifestMarker(): Promise<void> {
    expectOk(
      await store.writeMaterializedObject({
        object: {
          projectId: PROJECT_ID,
          objectType: "project_manifest",
          objectId: PROJECT_ID,
          objectGeneration: 1,
          versionId: PROJECT_ID,
          vector: { [DEVICE_ID]: 1 },
          payloadSha256: "e".repeat(64),
          sourceOperationId: id(900),
          sourceDeviceId: DEVICE_ID,
          sourceDeviceSequence: 1,
          state: "present",
          materializedAt: CREATED_AT,
        },
        expectedSourceOperationId: null,
      }),
    );
  }

  async function enqueueChapterJob(
    jobId: string,
    versionId: string,
    sourceRevision: number,
    createdAt: string,
  ): Promise<void> {
    expectOk(
      await store.enqueueProjectionJob({
        jobId,
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        objectType: "chapter_version",
        objectId: CHAPTER_ID,
        objectGeneration: 1,
        projectionKind: "upsert",
        versionId,
        sourceRevision,
        keyVersion: KEY_VERSION,
        consentRevision: 1,
        deviceId: DEVICE_ID,
        createdAt,
        nextAttemptAt: NOW,
      }),
    );
  }

  async function decryptOperation(operationId: string): Promise<ContentSyncPayload> {
    const rows = await executor.select<StoredChunkRow>(
      `SELECT chunk.project_id, chunk.object_type, chunk.object_id, chunk.version_id,
              chunk.chunk_index, chunk.key_version, chunk.algorithm, chunk.nonce,
              chunk.ciphertext, chunk.ciphertext_sha256, chunk.plaintext_bytes
       FROM sync_operation_chunks AS link
       JOIN sync_ciphertext_chunks AS chunk ON chunk.chunk_id = link.chunk_id
       WHERE link.operation_id = ?
       ORDER BY link.position`,
      [operationId],
    );
    const cipher = new AesGcmChunkCipher();
    const plaintext: Uint8Array[] = [];
    for (const row of rows) {
      const encrypted: EncryptedSyncChunk = {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        algorithm: requireAlgorithm(row.algorithm),
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        ciphertextSha256: row.ciphertext_sha256,
        plaintextBytes: row.plaintext_bytes,
        aad: {
          projectId: row.project_id,
          objectType: requireContentObjectType(row.object_type),
          objectId: row.object_id,
          versionId: row.version_id,
          chunkIndex: row.chunk_index,
          keyVersion: row.key_version,
        },
      };
      plaintext.push(await cipher.decrypt(key, encrypted, encrypted.aad));
    }
    return decodeContentSyncPayloadChunks(plaintext);
  }

  async function countRows(table: string): Promise<number> {
    const allowed = new Set([
      "sync_outbox_operations",
      "sync_ciphertext_chunks",
      "sync_materialized_objects",
    ]);
    if (!allowed.has(table)) {
      throw new Error("Unsupported test table.");
    }
    const rows = await executor.select<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
    return rows[0]?.count ?? -1;
  }
});

interface StoredChunkRow {
  readonly project_id: string;
  readonly object_type: string;
  readonly object_id: string;
  readonly version_id: string;
  readonly chunk_index: number;
  readonly key_version: number;
  readonly algorithm: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly ciphertext_sha256: string;
  readonly plaintext_bytes: number;
}

class MutableClock implements Pick<Clock, "now"> {
  public constructor(public value: string) {}

  public now(): IsoUtcTimestamp {
    return expectOk(parseIsoUtcTimestamp(this.value));
  }
}

class SequentialIds implements Pick<UuidV7Generator, "next"> {
  public constructor(private nextValue: number) {}

  public next(): UuidV7 {
    const value = expectOk(parseUuidV7(id(this.nextValue)));
    this.nextValue += 1;
    return value;
  }
}

class SwitchableExecutor implements SqlExecutor {
  public failNextProjectionCompletion = false;

  public constructor(private readonly delegate: NodeSqliteExecutor) {}

  public select<Row extends object>(
    query: string,
    bindValues: readonly SqlPrimitive[] = [],
  ): Promise<Row[]> {
    return this.delegate.select<Row>(query, bindValues);
  }

  public execute(query: string, bindValues: readonly SqlPrimitive[] = []): Promise<ExecuteResult> {
    return this.executeAgainst(this.delegate, query, bindValues);
  }

  public transaction<Value>(
    operation: (transaction: TransactionExecutor) => Promise<Value>,
  ): Promise<Value> {
    return this.delegate.transaction((transaction) =>
      operation({
        select: <Row extends object>(query: string, bindValues: readonly SqlPrimitive[] = []) =>
          transaction.select<Row>(query, bindValues),
        execute: (query: string, bindValues: readonly SqlPrimitive[] = []) =>
          this.executeAgainst(transaction, query, bindValues),
      }),
    );
  }

  public close(): Promise<void> {
    return this.delegate.close();
  }

  private executeAgainst(
    executor: TransactionExecutor,
    query: string,
    bindValues: readonly SqlPrimitive[],
  ): Promise<ExecuteResult> {
    if (
      this.failNextProjectionCompletion &&
      query.includes("UPDATE sync_projection_jobs") &&
      query.includes("status = 'completed'")
    ) {
      this.failNextProjectionCompletion = false;
      throw new Error("Simulated crash before projection completion.");
    }
    return executor.execute(query, bindValues);
  }
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

function requireCompletedOperationId(
  outcome: Awaited<ReturnType<OutgoingContentProjectionWorker["runOnce"]>>,
): string {
  if (outcome.status !== "completed") {
    throw new Error("Projection did not complete.");
  }
  return outcome.operationId;
}

function requireAlgorithm(value: string): "AES-256-GCM" {
  if (value !== "AES-256-GCM") {
    throw new Error("Unexpected stored algorithm.");
  }
  return value;
}

function requireContentObjectType(value: string): "project_manifest" | "chapter_version" {
  if (value !== "project_manifest" && value !== "chapter_version") {
    throw new Error("Unexpected stored content object type.");
  }
  return value;
}

function id(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString(16).padStart(12, "0")}`;
}

function readMigration(name: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", name), "utf8");
}
