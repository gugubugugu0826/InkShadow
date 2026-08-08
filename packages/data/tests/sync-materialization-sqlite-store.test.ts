import { readFileSync } from "node:fs";

import { type AppError, type Result } from "@inkshadow/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SyncMaterializationSqliteStore,
  advanceSyncMaterializedCheckpointInTransaction,
  completeSyncProjectionJobInTransaction,
  enqueueSyncProjectionJobInTransaction,
  findCurrentSyncMaterializedObjectInTransaction,
  findSyncMaterializedObjectInTransaction,
  registerSyncContentConflictInTransaction,
  transitionProjectSyncRegistrationInTransaction,
  writeSyncMaterializedObjectInTransaction,
  type EnqueueSyncProjectionJobInput,
} from "../src/sync-materialization-sqlite-store.js";
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
    new URL("../migrations/0017_sync_projection_account_authority.sql", import.meta.url),
    "utf8",
  ),
  readFileSync(new URL("../migrations/0038_private_chapters.sql", import.meta.url), "utf8"),
].join("\n");

const PROJECT_ID = "019fa002-2000-7000-8000-000000000001";
const ACCOUNT_ID = "019fa002-2000-7000-8000-000000000002";
const OTHER_ACCOUNT_ID = "019fa002-2000-7000-8000-000000000099";
const DEVICE_ID = "019fa002-2000-7000-8000-000000000003";
const OTHER_DEVICE_ID = "019fa002-2000-7000-8000-000000000004";
const OBJECT_ID = "019fa002-2000-7000-8000-000000000005";
const VERSION_ID = "019fa002-2000-7000-8000-000000000006";
const OPERATION_ID = "019fa002-2000-7000-8000-000000000007";
const JOB_ID = "019fa002-2000-7000-8000-000000000008";
const WORKER_ID = "019fa002-2000-7000-8000-000000000009";
const LEASE_TOKEN = "019fa002-2000-7000-8000-000000000010";
const NOW = "2026-07-28T01:00:00.000Z";
const LATER = "2026-07-28T01:01:00.000Z";
const LEASE_EXPIRES = "2026-07-28T01:05:00.000Z";

describe("SyncMaterializationSqliteStore", () => {
  let executor: NodeSqliteExecutor;
  let store: SyncMaterializationSqliteStore;

  beforeEach(async () => {
    executor = new NodeSqliteExecutor(migration);
    store = new SyncMaterializationSqliteStore(executor);
    await executor.execute(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, 'Materialize', ?, ?)",
      [PROJECT_ID, NOW, NOW],
    );
    await executor.transaction(async (transaction) => {
      await transaction.execute(
        `INSERT INTO chapters (
           id, project_id, title, content, status, revision, privacy_mode,
           privacy_revision, current_version_id, created_at, updated_at, trashed_at
         ) VALUES (?, ?, 'Materialized chapter', '正文', 'active', 1, 'standard',
                   1, ?, ?, ?, NULL)`,
        [OBJECT_ID, PROJECT_ID, VERSION_ID, NOW, NOW],
      );
      await transaction.execute(
        `INSERT INTO chapter_versions (
           id, project_id, chapter_id, parent_version_id, sequence, content,
           content_checksum, reason, source_candidate_id, created_at
         ) VALUES (?, ?, ?, NULL, 1, '正文', ?, 'created', NULL, ?)`,
        [VERSION_ID, PROJECT_ID, OBJECT_ID, "a".repeat(64), NOW],
      );
    });
  });

  afterEach(async () => {
    await executor.close();
  });

  it("treats a missing registration as disabled and opens push only after explicit bootstrap", async () => {
    expect(
      expectOk(
        await store.evaluatePushGate({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 1,
          keyVersion: 1,
        }),
      ),
    ).toEqual({
      allowed: false,
      reason: "disabled",
      registrationRevision: null,
    });

    const enabling = expectOk(
      await store.beginProjectSyncEnable({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        consentRevision: 1,
        keyVersion: 1,
        expectedRevision: null,
        begunAt: NOW,
      }),
    );
    expect(enabling).toMatchObject({ state: "enabling", revision: 1 });
    expect(
      expectOk(
        await store.beginProjectSyncEnable({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 1,
          keyVersion: 1,
          expectedRevision: null,
          begunAt: NOW,
        }),
      ),
    ).toEqual(enabling);
    expect(
      expectOk(
        await store.evaluatePushGate({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 1,
          keyVersion: 1,
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "not_enabled" });

    const bootstrapRequired = expectOk(
      await store.transitionProjectSyncRegistration({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedConsentRevision: 1,
        expectedKeyVersion: 1,
        expectedRevision: 1,
        target: { state: "bootstrap_required" },
        transitionedAt: LATER,
      }),
    );
    expect(bootstrapRequired).toMatchObject({
      state: "bootstrap_required",
      revision: 2,
      plaintextBootstrapCompleted: false,
    });

    const enabledAt = "2026-07-28T01:02:00.000Z";
    const enabled = expectOk(
      await store.transitionProjectSyncRegistration({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedConsentRevision: 1,
        expectedKeyVersion: 1,
        expectedRevision: 2,
        target: { state: "enabled" },
        transitionedAt: enabledAt,
      }),
    );
    expect(enabled).toMatchObject({
      state: "enabled",
      revision: 3,
      plaintextBootstrapCompleted: true,
      enabledAt,
    });
    expect(
      expectOk(
        await store.transitionProjectSyncRegistration({
          projectId: PROJECT_ID,
          expectedAccountId: ACCOUNT_ID,
          expectedDeviceId: DEVICE_ID,
          expectedConsentRevision: 1,
          expectedKeyVersion: 1,
          expectedRevision: 2,
          target: { state: "enabled" },
          transitionedAt: enabledAt,
        }),
      ),
    ).toEqual(enabled);
    expect(
      expectOk(
        await store.evaluatePushGate({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 1,
          keyVersion: 1,
        }),
      ),
    ).toEqual({
      allowed: true,
      reason: "allowed",
      registrationRevision: 3,
    });
    expect(
      expectOk(
        await store.evaluatePushGate({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: OTHER_DEVICE_ID,
          consentRevision: 1,
          keyVersion: 1,
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "device_mismatch" });
    expect(
      expectOk(
        await store.evaluatePushGate({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 2,
          keyVersion: 1,
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "consent_revision_mismatch" });
    expect(
      expectOk(
        await store.evaluatePushGate({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 1,
          keyVersion: 2,
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "key_version_mismatch" });

    expectErrorCode(
      await store.transitionProjectSyncRegistration({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedConsentRevision: 1,
        expectedKeyVersion: 1,
        expectedRevision: 2,
        target: { state: "paused" },
        transitionedAt: "2026-07-28T01:03:00.000Z",
      }),
      "INVALID_STATE_TRANSITION",
    );

    const disabledAt = "2026-07-28T01:04:00.000Z";
    const disabled = expectOk(
      await store.disableProjectSync({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedRevision: 3,
        disabledAt,
      }),
    );
    expect(disabled).toMatchObject({
      state: "disabled",
      revision: 4,
      plaintextBootstrapCompleted: false,
    });
    expect(
      expectOk(
        await store.disableProjectSync({
          projectId: PROJECT_ID,
          expectedAccountId: ACCOUNT_ID,
          expectedDeviceId: DEVICE_ID,
          expectedRevision: 3,
          disabledAt,
        }),
      ),
    ).toEqual(disabled);
    expect(
      expectOk(
        await store.evaluatePushGate({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 1,
          keyVersion: 1,
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "disabled" });
  });

  it.each(["queued", "in_flight", "failed", "paused"] as const)(
    "atomically refuses final enrollment while a %s outbox operation is unacknowledged",
    async (status) => {
      const inFlight = status === "in_flight";
      const retryable = status === "queued" || status === "failed";
      await executor.execute(
        `INSERT INTO sync_outbox_operations (
           operation_id, project_id, device_id, device_sequence, object_type,
           object_id, object_generation, kind, vector_json, status, attempt,
           next_attempt_at, lease_owner_id, lease_token, lease_expires_at,
           failure_code, acknowledged_at, created_at, updated_at
         ) VALUES (?, ?, ?, 1, 'chapter_version', ?, 1, 'delete', ?, ?, ?,
           ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          OPERATION_ID,
          PROJECT_ID,
          DEVICE_ID,
          OBJECT_ID,
          JSON.stringify({ [DEVICE_ID]: 1 }),
          status,
          status === "queued" ? 0 : 1,
          retryable ? LATER : null,
          inFlight ? WORKER_ID : null,
          inFlight ? LEASE_TOKEN : null,
          inFlight ? LEASE_EXPIRES : null,
          status === "failed" || status === "paused" ? "TEST_FAILURE" : null,
          NOW,
          NOW,
        ],
      );

      expectErrorCode(
        await store.beginProjectSyncEnableIfTransportClean({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 1,
          keyVersion: 1,
          expectedRevision: null,
          begunAt: NOW,
        }),
        "INVALID_STATE_TRANSITION",
      );
      expect(expectOk(await store.loadProjectSyncRegistration(PROJECT_ID))).toBeNull();
    },
  );

  it("commits enrollment when only acknowledged outbox history exists", async () => {
    await executor.execute(
      `INSERT INTO sync_outbox_operations (
         operation_id, project_id, device_id, device_sequence, object_type,
         object_id, object_generation, kind, vector_json, status, attempt,
         next_attempt_at, lease_owner_id, lease_token, lease_expires_at,
         failure_code, acknowledged_at, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 'chapter_version', ?, 1, 'delete', ?, 'acknowledged', 1,
         NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      [
        OPERATION_ID,
        PROJECT_ID,
        DEVICE_ID,
        OBJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 1 }),
        LATER,
        NOW,
        LATER,
      ],
    );

    expect(
      expectOk(
        await store.beginProjectSyncEnableIfTransportClean({
          projectId: PROJECT_ID,
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          consentRevision: 1,
          keyVersion: 1,
          expectedRevision: null,
          begunAt: LATER,
        }),
      ),
    ).toMatchObject({ state: "enabling", revision: 1 });
  });

  it("revokes orphaned local transport without inventing a cloud identity", async () => {
    await executor.execute(
      `INSERT INTO sync_outbox_operations (
         operation_id, project_id, device_id, device_sequence, object_type,
         object_id, object_generation, kind, vector_json, status, attempt,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 'chapter_version', ?, 1, 'delete', ?, 'queued', 0, ?, ?, ?)`,
      [
        OPERATION_ID,
        PROJECT_ID,
        DEVICE_ID,
        OBJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 1 }),
        NOW,
        NOW,
        NOW,
      ],
    );

    expectOk(
      await store.disableProjectSync({
        projectId: PROJECT_ID,
        expectedAccountId: null,
        expectedDeviceId: null,
        expectedRevision: null,
        disabledAt: LATER,
      }),
    );
    await expect(
      executor.select<{ status: string; failure_code: string }>(
        "SELECT status, failure_code FROM sync_outbox_operations WHERE operation_id = ?",
        [OPERATION_ID],
      ),
    ).resolves.toEqual([{ status: "paused", failure_code: "SYNC_CONSENT_REVOKED" }]);
  });

  it("lists only durable runnable registrations in stable project order", async () => {
    const registrations = [
      ["019fa002-2000-7000-8000-000000000026", "disabled"],
      ["019fa002-2000-7000-8000-000000000025", "enabled"],
      ["019fa002-2000-7000-8000-000000000024", "error"],
      ["019fa002-2000-7000-8000-000000000023", "bootstrap_required"],
      ["019fa002-2000-7000-8000-000000000022", "paused"],
      ["019fa002-2000-7000-8000-000000000021", "enabling"],
    ] as const;
    for (const [projectId, state] of registrations) {
      await executor.execute(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        [projectId, state, NOW, NOW],
      );
      await executor.execute(
        `INSERT INTO project_sync_registrations (
           project_id, account_id, device_id, state, consent_revision,
           key_version, revision, plaintext_bootstrap_completed,
           last_error_code, created_at, updated_at, enabled_at, paused_at
         ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          ACCOUNT_ID,
          DEVICE_ID,
          state,
          state === "enabled" ? 1 : 0,
          state === "error" ? "TEST_ERROR" : null,
          NOW,
          NOW,
          state === "enabled" ? NOW : null,
          state === "paused" ? NOW : null,
        ],
      );
    }

    expect(expectOk(await store.listRunnableProjectSyncRegistrations())).toMatchObject([
      {
        projectId: "019fa002-2000-7000-8000-000000000021",
        state: "enabling",
      },
      {
        projectId: "019fa002-2000-7000-8000-000000000023",
        state: "bootstrap_required",
      },
      {
        projectId: "019fa002-2000-7000-8000-000000000025",
        state: "enabled",
      },
    ]);
  });

  it("keeps downloaded and materialized checkpoints independent and CAS-bound", async () => {
    await insertDownloadedCheckpoint(executor, "downloaded_one", 1, NOW);
    const first = expectOk(
      await store.advanceMaterializedCheckpoint({
        projectId: PROJECT_ID,
        signedRemoteCursor: "downloaded_one",
        downloadedCheckpointRevision: 1,
        expectedRevision: null,
        updatedAt: NOW,
      }),
    );
    expect(first).toMatchObject({
      signedRemoteCursor: "downloaded_one",
      downloadedCheckpointRevision: 1,
      revision: 1,
    });

    await executor.execute(
      `UPDATE sync_remote_checkpoints
       SET signed_remote_cursor = 'downloaded_two', revision = 2, updated_at = ?
       WHERE project_id = ?`,
      [LATER, PROJECT_ID],
    );
    expect(expectOk(await store.loadMaterializedCheckpoint(PROJECT_ID))).toEqual(first);
    expect(
      expectOk(
        await store.advanceMaterializedCheckpoint({
          projectId: PROJECT_ID,
          signedRemoteCursor: "downloaded_one",
          downloadedCheckpointRevision: 1,
          expectedRevision: null,
          updatedAt: NOW,
        }),
      ),
    ).toEqual(first);
    expectErrorCode(
      await store.advanceMaterializedCheckpoint({
        projectId: PROJECT_ID,
        signedRemoteCursor: "downloaded_one",
        downloadedCheckpointRevision: 1,
        expectedRevision: 1,
        updatedAt: LATER,
      }),
      "INVALID_STATE_TRANSITION",
    );
    expect(
      expectOk(
        await store.advanceMaterializedCheckpoint({
          projectId: PROJECT_ID,
          signedRemoteCursor: "downloaded_two",
          downloadedCheckpointRevision: 2,
          expectedRevision: 1,
          updatedAt: LATER,
        }),
      ),
    ).toMatchObject({
      signedRemoteCursor: "downloaded_two",
      downloadedCheckpointRevision: 2,
      revision: 2,
    });
  });

  it("isolates equal UUIDs across object types and supports caller-owned atomic commits", async () => {
    await insertDownloadedCheckpoint(executor, "atomic_cursor", 1, NOW);
    await executor.execute("CREATE TABLE business_apply_markers (id TEXT PRIMARY KEY NOT NULL)");
    await executor.transaction(async (transaction) => {
      await transaction.execute(
        "INSERT INTO business_apply_markers (id) VALUES ('business-applied')",
      );
      expectOk(
        await writeSyncMaterializedObjectInTransaction(transaction, {
          object: materializedObject("chapter_version", OPERATION_ID),
          expectedSourceOperationId: null,
        }),
      );
      expectOk(
        await writeSyncMaterializedObjectInTransaction(transaction, {
          object: materializedObject("chapter_version", "019fa002-2000-7000-8000-000000000014", 3),
          expectedSourceOperationId: null,
        }),
      );
      expect(
        expectOk(
          await findCurrentSyncMaterializedObjectInTransaction(
            transaction,
            PROJECT_ID,
            "chapter_version",
            OBJECT_ID,
          ),
        ),
      ).toMatchObject({ objectGeneration: 3 });
      expect(
        expectOk(
          await findSyncMaterializedObjectInTransaction(
            transaction,
            PROJECT_ID,
            "chapter_version",
            OBJECT_ID,
            1,
          ),
        ),
      ).toMatchObject({ objectGeneration: 1 });
      expectOk(
        await advanceSyncMaterializedCheckpointInTransaction(transaction, {
          projectId: PROJECT_ID,
          signedRemoteCursor: "atomic_cursor",
          downloadedCheckpointRevision: 1,
          expectedRevision: null,
          updatedAt: NOW,
        }),
      );
    });
    expect(
      expectOk(
        await store.writeMaterializedObject({
          object: materializedObject("memory", "019fa002-2000-7000-8000-000000000011"),
          expectedSourceOperationId: null,
        }),
      ),
    ).toMatchObject({ objectType: "memory", objectId: OBJECT_ID });
    expect(
      expectOk(await store.findMaterializedObject(PROJECT_ID, "chapter_version", OBJECT_ID, 1)),
    ).toMatchObject({ objectType: "chapter_version" });
    expect(
      expectOk(await store.findCurrentMaterializedObject(PROJECT_ID, "chapter_version", OBJECT_ID)),
    ).toMatchObject({ objectType: "chapter_version", objectGeneration: 3 });
    expect(
      expectOk(await store.findMaterializedObject(PROJECT_ID, "memory", OBJECT_ID, 1)),
    ).toMatchObject({ objectType: "memory" });
    await expect(
      executor.select<{ id: string }>("SELECT id FROM business_apply_markers"),
    ).resolves.toEqual([{ id: "business-applied" }]);
  });

  it("keeps projection jobs reference-only, gated, leaseable, retryable, and terminal", async () => {
    const enqueue = projectionJob();
    expectErrorCode(await store.enqueueProjectionJob(enqueue), "INVALID_STATE_TRANSITION");
    await enableSync(store);
    const queued = expectOk(await store.enqueueProjectionJob(enqueue));
    expect(queued).toMatchObject({ status: "queued", attempt: 0, revision: 1 });

    const columns = (
      executor.database.prepare("PRAGMA table_info(sync_projection_jobs)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name);
    expect(columns.some((name) => /content|title|body|plaintext|payload|prompt/iu.test(name))).toBe(
      false,
    );
    const rawRows = await executor.select<Record<string, string | number | null>>(
      "SELECT * FROM sync_projection_jobs",
    );
    expect(JSON.stringify(rawRows)).not.toContain("never persist this chapter body");

    const leased = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leasedAt: LATER,
        leaseExpiresAt: LEASE_EXPIRES,
      }),
    );
    expect(leased).toMatchObject({ status: "leased", attempt: 1, revision: 2 });
    if (leased === null) {
      throw new Error("Expected a leased projection job.");
    }
    const retryAt = "2026-07-28T01:06:00.000Z";
    const retried = expectOk(
      await store.retryProjectionJob({
        jobId: leased.jobId,
        expectedRevision: leased.revision,
        leaseOwnerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        failureCode: "TEMPORARY_ENCRYPTION_FAILURE",
        failedAt: "2026-07-28T01:02:00.000Z",
        nextAttemptAt: retryAt,
      }),
    );
    expect(retried).toMatchObject({ status: "retry_wait", revision: 3 });

    const secondLeaseToken = "019fa002-2000-7000-8000-000000000012";
    const leasedAgain = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: secondLeaseToken,
        leasedAt: retryAt,
        leaseExpiresAt: "2026-07-28T01:10:00.000Z",
      }),
    );
    if (leasedAgain === null) {
      throw new Error("Expected a retried projection job.");
    }
    const completed = expectOk(
      await executor.transaction((transaction) =>
        completeSyncProjectionJobInTransaction(transaction, {
          jobId: leasedAgain.jobId,
          expectedRevision: leasedAgain.revision,
          leaseOwnerId: WORKER_ID,
          leaseToken: secondLeaseToken,
          operationId: "019fa002-2000-7000-8000-000000000013",
          completedAt: "2026-07-28T01:07:00.000Z",
        }),
      ),
    );
    expect(completed).toMatchObject({
      status: "completed",
      attempt: 2,
      revision: 5,
    });
  });

  it("reports true projection idle and backoff only for the current registration authority", async () => {
    await enableSync(store);
    expect(
      expectOk(
        await store.readProjectionBlockingState({
          projectId: PROJECT_ID,
          observedAt: LATER,
        }),
      ),
    ).toEqual({
      projectId: PROJECT_ID,
      authority: {
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        keyVersion: 1,
        consentRevision: 1,
        registrationRevision: 2,
      },
      state: "idle",
    });

    const retryAt = "2026-07-28T01:05:00.000Z";
    expectOk(
      await store.enqueueProjectionJob(
        projectionJob({
          nextAttemptAt: retryAt,
        }),
      ),
    );
    expect(
      expectOk(
        await store.readProjectionBlockingState({
          projectId: PROJECT_ID,
          observedAt: LATER,
        }),
      ),
    ).toMatchObject({
      state: "backoff",
      jobId: JOB_ID,
      attempt: 0,
      nextAttemptAt: retryAt,
      failureCode: null,
    });

    const enabling = expectOk(
      await store.beginProjectSyncEnable({
        projectId: PROJECT_ID,
        accountId: OTHER_ACCOUNT_ID,
        deviceId: DEVICE_ID,
        consentRevision: 1,
        keyVersion: 1,
        expectedRevision: 2,
        begunAt: "2026-07-28T01:02:00.000Z",
      }),
    );
    expectOk(
      await store.transitionProjectSyncRegistration({
        projectId: PROJECT_ID,
        expectedAccountId: OTHER_ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedConsentRevision: 1,
        expectedKeyVersion: 1,
        expectedRevision: enabling.revision,
        target: { state: "enabled" },
        transitionedAt: "2026-07-28T01:03:00.000Z",
      }),
    );

    expect(
      expectOk(
        await store.readProjectionBlockingState({
          projectId: PROJECT_ID,
          observedAt: "2026-07-28T01:04:00.000Z",
        }),
      ),
    ).toEqual({
      projectId: PROJECT_ID,
      authority: {
        accountId: OTHER_ACCOUNT_ID,
        deviceId: DEVICE_ID,
        keyVersion: 1,
        consentRevision: 1,
        registrationRevision: 4,
      },
      state: "idle",
    });
  });

  it("reports permanent and attempt-exhausted projection terminals", async () => {
    await enableSync(store);
    expectOk(await store.enqueueProjectionJob(projectionJob()));
    const leased = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leasedAt: LATER,
        leaseExpiresAt: LEASE_EXPIRES,
      }),
    );
    if (leased === null) {
      throw new Error("Expected a leased projection job.");
    }
    expectOk(
      await store.failProjectionJob({
        jobId: leased.jobId,
        expectedRevision: leased.revision,
        leaseOwnerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        failureCode: "PAYLOAD_REJECTED",
        failedAt: "2026-07-28T01:02:00.000Z",
      }),
    );

    expect(
      expectOk(
        await store.readProjectionBlockingState({
          projectId: PROJECT_ID,
          observedAt: "2026-07-28T01:03:00.000Z",
        }),
      ),
    ).toMatchObject({
      state: "permanent_failure",
      jobId: JOB_ID,
      attempt: 1,
      failureCode: "PAYLOAD_REJECTED",
    });

    await executor.execute("UPDATE sync_projection_jobs SET attempt = 100 WHERE job_id = ?", [
      JOB_ID,
    ]);
    expect(
      expectOk(
        await store.readProjectionBlockingState({
          projectId: PROJECT_ID,
          observedAt: "2026-07-28T01:03:00.000Z",
        }),
      ),
    ).toMatchObject({
      state: "attempt_exhausted",
      jobId: JOB_ID,
      attempt: 100,
      failureCode: "PAYLOAD_REJECTED",
    });
  });

  it("does not call the active hundredth projection attempt exhausted", async () => {
    await enableSync(store);
    expectOk(await store.enqueueProjectionJob(projectionJob()));
    await executor.execute(
      `UPDATE sync_projection_jobs
       SET status = 'retry_wait',
           attempt = 99,
           revision = 2,
           failure_code = 'TEMPORARY_ENCRYPTION_FAILURE'
       WHERE job_id = ?`,
      [JOB_ID],
    );
    const leased = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leasedAt: LATER,
        leaseExpiresAt: LEASE_EXPIRES,
      }),
    );
    expect(leased).toMatchObject({ status: "leased", attempt: 100 });

    expect(
      expectOk(
        await store.readProjectionBlockingState({
          projectId: PROJECT_ID,
          observedAt: "2026-07-28T01:02:00.000Z",
        }),
      ),
    ).toMatchObject({
      state: "blocked",
      jobId: JOB_ID,
      reason: "active_lease",
      blockerJobId: JOB_ID,
      resumeAt: LEASE_EXPIRES,
    });
  });

  it("binds projected outbox uploads to the live account consent and revokes them atomically", async () => {
    await enableSync(store);
    expectOk(await store.enqueueProjectionJob(projectionJob()));
    const leased = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        leasedAt: LATER,
        leaseExpiresAt: LEASE_EXPIRES,
      }),
    );
    if (leased === null) {
      throw new Error("Expected a leased projection job.");
    }
    expectOk(
      await store.completeProjectionJob({
        jobId: leased.jobId,
        expectedRevision: leased.revision,
        leaseOwnerId: WORKER_ID,
        leaseToken: LEASE_TOKEN,
        operationId: OPERATION_ID,
        completedAt: "2026-07-28T01:02:00.000Z",
      }),
    );
    await executor.execute(
      `INSERT INTO sync_outbox_operations (
         operation_id, project_id, device_id, device_sequence, object_type,
         object_id, object_generation, kind, vector_json, status, attempt,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, 2, 'chapter_version', ?, 1, 'upsert', ?, 'queued', 0, ?, ?, ?)`,
      [
        OPERATION_ID,
        PROJECT_ID,
        DEVICE_ID,
        OBJECT_ID,
        JSON.stringify({ [DEVICE_ID]: 2 }),
        LATER,
        LATER,
        LATER,
      ],
    );

    expect(
      expectOk(
        await store.evaluateProjectionOperationPushGate({
          projectId: PROJECT_ID,
          operationId: OPERATION_ID,
          activeAccountId: ACCOUNT_ID,
          activeDeviceId: DEVICE_ID,
        }),
      ),
    ).toEqual({ allowed: true, reason: "allowed", registrationRevision: 2 });
    expect(
      expectOk(
        await store.evaluateProjectionOperationPushGate({
          projectId: PROJECT_ID,
          operationId: OPERATION_ID,
          activeAccountId: OTHER_ACCOUNT_ID,
          activeDeviceId: DEVICE_ID,
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "account_mismatch" });

    const disabledAt = "2026-07-28T01:03:00.000Z";
    expectOk(
      await store.disableProjectSync({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedRevision: 2,
        disabledAt,
      }),
    );
    await expect(
      executor.select<{ status: string; failure_code: string }>(
        "SELECT status, failure_code FROM sync_outbox_operations WHERE operation_id = ?",
        [OPERATION_ID],
      ),
    ).resolves.toEqual([{ status: "paused", failure_code: "SYNC_CONSENT_REVOKED" }]);
    await expect(
      executor.select<{ count: number }>(
        "SELECT count(*) AS count FROM sync_projection_jobs WHERE project_id = ?",
        [PROJECT_ID],
      ),
    ).resolves.toEqual([{ count: 0 }]);
    expect(
      expectOk(
        await store.evaluateProjectionOperationPushGate({
          projectId: PROJECT_ID,
          operationId: OPERATION_ID,
          activeAccountId: ACCOUNT_ID,
          activeDeviceId: DEVICE_ID,
        }),
      ),
    ).toMatchObject({ allowed: false, reason: "not_enabled" });
  });

  it("fences one network push to the exact settled boundary and acknowledges its exact lease", async () => {
    await prepareFencedPush(store, executor);
    let observedTransaction = false;
    const response = {
      acceptedOperations: [{ operationId: OPERATION_ID }],
      remoteCursor: "remote_after_push",
    };

    await expect(
      store.pushProjectionOperationFenced(fencedPushInput(), () => {
        observedTransaction = executor.database.isTransaction;
        return Promise.resolve(response);
      }),
    ).resolves.toEqual({
      status: "pushed",
      response,
      registrationRevision: 2,
    });
    expect(observedTransaction).toBe(true);
    await expect(
      executor.select<{
        status: string;
        lease_token: string | null;
        acknowledged_at: string | null;
      }>(
        `SELECT status, lease_token, acknowledged_at
         FROM sync_outbox_operations
         WHERE operation_id = ?`,
        [OPERATION_ID],
      ),
    ).resolves.toEqual([
      {
        status: "acknowledged",
        lease_token: null,
        acknowledged_at: "2026-07-28T01:02:30.000Z",
      },
    ]);
  });

  it("rechecks chapter privacy at the final network fence", async () => {
    await prepareFencedPush(store, executor);
    const push = vi.fn();
    // Exercise the final fence independently from the cleanup trigger, as if a
    // legacy client left an operation behind during a concurrent privacy flip.
    await executor.execute("DROP TRIGGER private_chapter_transport_cleanup");
    await executor.execute(
      "UPDATE chapters SET privacy_mode = 'local_only', privacy_revision = 2 WHERE id = ?",
      [OBJECT_ID],
    );

    await expect(
      store.pushProjectionOperationFenced(fencedPushInput(), push),
    ).resolves.toMatchObject({ status: "blocked", reason: "chapter_local_only" });
    expect(push).not.toHaveBeenCalled();
  });

  it("does not invoke the network callback when the base or settled checkpoint drifts", async () => {
    await prepareFencedPush(store, executor);
    const push = vi.fn(() =>
      Promise.resolve({
        acceptedOperations: [{ operationId: OPERATION_ID }],
        remoteCursor: "remote_after_push",
      }),
    );

    await expect(
      store.pushProjectionOperationFenced(
        {
          ...fencedPushInput(),
          requestBaseCursor: "different_cursor",
        },
        push,
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "base_cursor_mismatch" });
    expect(push).not.toHaveBeenCalled();

    await executor.execute(
      `UPDATE sync_remote_checkpoints
       SET signed_remote_cursor = 'interleaved_cursor', revision = 2, updated_at = ?
       WHERE project_id = ?`,
      ["2026-07-28T01:02:10.000Z", PROJECT_ID],
    );
    await expect(
      store.pushProjectionOperationFenced(fencedPushInput(), push),
    ).resolves.toMatchObject({ status: "blocked", reason: "remote_checkpoint_mismatch" });
    expect(push).not.toHaveBeenCalled();
  });

  it("blocks snapshot or incremental plaintext work even when checkpoint rows still match", async () => {
    await prepareFencedPush(store, executor);
    await executor.execute(
      `INSERT INTO sync_snapshot_staging_sessions (
         snapshot_id, project_id, epoch, state,
         base_signed_remote_cursor, base_checkpoint_revision, base_checkpoint_updated_at,
         snapshot_signed_remote_cursor, snapshot_expires_at, next_page_index,
         next_snapshot_cursor, pages_complete, final_signed_remote_cursor,
         total_operation_count, total_chunk_count, total_tombstone_count,
         committed_checkpoint_revision, created_at, updated_at, committed_at
       ) VALUES (?, ?, 1, 'staging', 'settled_cursor', 1, ?,
         'snapshot_cursor', ?, 1, 'next_snapshot_page', 0, NULL,
         0, 0, 0, NULL, ?, ?, NULL)`,
      [
        "019fa002-2000-7000-8000-000000000080",
        PROJECT_ID,
        NOW,
        "2026-07-28T02:00:00.000Z",
        NOW,
        NOW,
      ],
    );
    const push = vi.fn();

    await expect(
      store.pushProjectionOperationFenced(fencedPushInput(), push),
    ).resolves.toMatchObject({ status: "blocked", reason: "incremental_work_pending" });
    expect(push).not.toHaveBeenCalled();
  });

  it("rethrows the exact network failure and rolls back fenced acknowledgement", async () => {
    await prepareFencedPush(store, executor);
    const networkFailure = Object.assign(new Error("offline"), {
      name: "CloudClientError",
      code: "CLOUD_NETWORK_UNAVAILABLE",
    });

    await expect(
      store.pushProjectionOperationFenced(fencedPushInput(), () => Promise.reject(networkFailure)),
    ).rejects.toBe(networkFailure);
    await expect(
      executor.select<{ status: string; lease_token: string | null }>(
        "SELECT status, lease_token FROM sync_outbox_operations WHERE operation_id = ?",
        [OPERATION_ID],
      ),
    ).resolves.toEqual([{ status: "in_flight", lease_token: LEASE_TOKEN }]);
  });

  it("retries idempotently when cloud accepted but local acknowledgement did not commit", async () => {
    await prepareFencedPush(store, executor);
    const push = vi
      .fn()
      .mockResolvedValueOnce({
        acceptedOperations: [{ operationId: OPERATION_ID }],
        remoteCursor: "remote_after_accept",
      })
      .mockResolvedValueOnce({
        acceptedOperations: [{ operationId: OPERATION_ID }],
        remoteCursor: "remote_after_duplicate",
      });
    const readAcknowledgedAt = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error("simulated acknowledgement crash");
      })
      .mockReturnValue("2026-07-28T01:02:30.000Z");

    const first = store.pushProjectionOperationFenced(
      { ...fencedPushInput(), readAcknowledgedAt },
      push,
    );
    await expect(first).rejects.toMatchObject({
      code: "REPOSITORY_ERROR",
      retryable: true,
    });
    await expect(
      executor.select<{ status: string; lease_token: string | null }>(
        "SELECT status, lease_token FROM sync_outbox_operations WHERE operation_id = ?",
        [OPERATION_ID],
      ),
    ).resolves.toEqual([{ status: "in_flight", lease_token: LEASE_TOKEN }]);

    await expect(
      store.pushProjectionOperationFenced({ ...fencedPushInput(), readAcknowledgedAt }, push),
    ).resolves.toMatchObject({
      status: "pushed",
      response: { remoteCursor: "remote_after_duplicate" },
    });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("requires the exact live, unexpired outbox claim before invoking the network callback", async () => {
    await prepareFencedPush(store, executor);
    const push = vi.fn();

    await expect(
      store.pushProjectionOperationFenced(
        {
          ...fencedPushInput(),
          leaseToken: "019fa002-2000-7000-8000-000000000082",
        },
        push,
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "outbox_lease_mismatch" });
    await expect(
      store.pushProjectionOperationFenced(
        {
          ...fencedPushInput(),
          authorizedAt: LEASE_EXPIRES,
        },
        push,
      ),
    ).resolves.toMatchObject({ status: "blocked", reason: "outbox_lease_mismatch" });
    expect(push).not.toHaveBeenCalled();
  });

  it("preserves and claims chapter history in source-revision order", async () => {
    await enableSync(store);
    const first = projectionJob();
    const second = projectionJob({
      jobId: "019fa002-2000-7000-8000-000000000030",
      versionId: "019fa002-2000-7000-8000-000000000031",
      sourceRevision: 2,
      createdAt: LATER,
      nextAttemptAt: LATER,
    });
    expectOk(await store.enqueueProjectionJob(first));
    expectOk(await store.enqueueProjectionJob(second));
    await expect(
      executor.select<{ status: string }>(
        "SELECT status FROM sync_projection_jobs WHERE job_id = ?",
        [first.jobId],
      ),
    ).resolves.toEqual([{ status: "queued" }]);

    const firstLease = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: "019fa002-2000-7000-8000-000000000032",
        leasedAt: LATER,
        leaseExpiresAt: LEASE_EXPIRES,
      }),
    );
    expect(firstLease).toMatchObject({ jobId: first.jobId, sourceRevision: 1 });
    if (firstLease === null) {
      throw new Error("Expected the first chapter projection.");
    }
    expectOk(
      await store.retryProjectionJob({
        jobId: firstLease.jobId,
        expectedRevision: firstLease.revision,
        leaseOwnerId: WORKER_ID,
        leaseToken: "019fa002-2000-7000-8000-000000000032",
        failureCode: "TEMPORARY_ENCRYPTION_FAILURE",
        failedAt: "2026-07-28T01:02:00.000Z",
        nextAttemptAt: "2026-07-28T01:06:00.000Z",
      }),
    );
    expect(
      expectOk(
        await store.claimProjectionJob({
          projectId: PROJECT_ID,
          leaseOwnerId: WORKER_ID,
          leaseToken: "019fa002-2000-7000-8000-000000000033",
          leasedAt: "2026-07-28T01:03:00.000Z",
          leaseExpiresAt: "2026-07-28T01:05:00.000Z",
        }),
      ),
    ).toBeNull();

    const firstRetry = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: "019fa002-2000-7000-8000-000000000034",
        leasedAt: "2026-07-28T01:06:00.000Z",
        leaseExpiresAt: "2026-07-28T01:10:00.000Z",
      }),
    );
    if (firstRetry === null) {
      throw new Error("Expected the first chapter projection retry.");
    }
    expectOk(
      await store.completeProjectionJob({
        jobId: firstRetry.jobId,
        expectedRevision: firstRetry.revision,
        leaseOwnerId: WORKER_ID,
        leaseToken: "019fa002-2000-7000-8000-000000000034",
        operationId: "019fa002-2000-7000-8000-000000000035",
        completedAt: "2026-07-28T01:07:00.000Z",
      }),
    );

    expect(
      expectOk(
        await store.claimProjectionJob({
          projectId: PROJECT_ID,
          leaseOwnerId: WORKER_ID,
          leaseToken: "019fa002-2000-7000-8000-000000000036",
          leasedAt: "2026-07-28T01:08:00.000Z",
          leaseExpiresAt: "2026-07-28T01:12:00.000Z",
        }),
      ),
    ).toMatchObject({ jobId: second.jobId, sourceRevision: 2 });
  });

  it("allows only one active projection lease per project device", async () => {
    await enableSync(store);
    const chapter = projectionJob();
    const manifest = projectionJob({
      jobId: "019fa002-2000-7000-8000-000000000037",
      objectType: "project_manifest",
      objectId: PROJECT_ID,
      versionId: PROJECT_ID,
    });
    expectOk(await store.enqueueProjectionJob(chapter));
    expectOk(await store.enqueueProjectionJob(manifest));

    const firstLease = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: "019fa002-2000-7000-8000-000000000038",
        leasedAt: LATER,
        leaseExpiresAt: LEASE_EXPIRES,
      }),
    );
    expect(firstLease).not.toBeNull();
    expect(
      expectOk(
        await store.claimProjectionJob({
          projectId: PROJECT_ID,
          leaseOwnerId: "019fa002-2000-7000-8000-000000000039",
          leaseToken: "019fa002-2000-7000-8000-00000000003a",
          leasedAt: LATER,
          leaseExpiresAt: LEASE_EXPIRES,
        }),
      ),
    ).toBeNull();
  });

  it("claims the manifest before chapters until its current generation is present", async () => {
    await enableSync(store, { manifestPresent: false });
    const chapter = projectionJob();
    const manifest = projectionJob({
      jobId: "019fa002-2000-7000-8000-000000000060",
      objectType: "project_manifest",
      objectId: PROJECT_ID,
      versionId: PROJECT_ID,
    });
    expectOk(await store.enqueueProjectionJob(chapter));
    expectOk(await store.enqueueProjectionJob(manifest));

    const manifestLeaseToken = "019fa002-2000-7000-8000-000000000061";
    const claimedManifest = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: manifestLeaseToken,
        leasedAt: LATER,
        leaseExpiresAt: LEASE_EXPIRES,
      }),
    );
    expect(claimedManifest).toMatchObject({
      jobId: manifest.jobId,
      objectType: "project_manifest",
    });
    if (claimedManifest === null) {
      throw new Error("Expected the project manifest projection.");
    }

    const manifestOperationId = "019fa002-2000-7000-8000-000000000062";
    expectOk(
      await executor.transaction(async (transaction) => {
        expectOk(
          await writeSyncMaterializedObjectInTransaction(transaction, {
            object: {
              projectId: PROJECT_ID,
              objectType: "project_manifest",
              objectId: PROJECT_ID,
              objectGeneration: 1,
              versionId: PROJECT_ID,
              vector: { [DEVICE_ID]: 1 },
              payloadSha256: "d".repeat(64),
              sourceOperationId: manifestOperationId,
              sourceDeviceId: DEVICE_ID,
              sourceDeviceSequence: 1,
              state: "present",
              materializedAt: "2026-07-28T01:02:00.000Z",
            },
            expectedSourceOperationId: null,
          }),
        );
        return completeSyncProjectionJobInTransaction(transaction, {
          jobId: claimedManifest.jobId,
          expectedRevision: claimedManifest.revision,
          leaseOwnerId: WORKER_ID,
          leaseToken: manifestLeaseToken,
          operationId: manifestOperationId,
          completedAt: "2026-07-28T01:02:00.000Z",
        });
      }),
    );

    expect(
      expectOk(
        await store.claimProjectionJob({
          projectId: PROJECT_ID,
          leaseOwnerId: WORKER_ID,
          leaseToken: "019fa002-2000-7000-8000-000000000063",
          leasedAt: "2026-07-28T01:03:00.000Z",
          leaseExpiresAt: "2026-07-28T01:07:00.000Z",
        }),
      ),
    ).toMatchObject({ jobId: chapter.jobId, objectType: "chapter_version" });
  });

  it("does not lease an old projection after the registration switches accounts", async () => {
    await enableSync(store);
    const queued = expectOk(await store.enqueueProjectionJob(projectionJob()));
    expect(queued).toMatchObject({ accountId: ACCOUNT_ID, status: "queued" });

    const enabling = expectOk(
      await store.beginProjectSyncEnable({
        projectId: PROJECT_ID,
        accountId: OTHER_ACCOUNT_ID,
        deviceId: DEVICE_ID,
        consentRevision: 1,
        keyVersion: 1,
        expectedRevision: 2,
        begunAt: "2026-07-28T01:02:00.000Z",
      }),
    );
    expectOk(
      await store.transitionProjectSyncRegistration({
        projectId: PROJECT_ID,
        expectedAccountId: OTHER_ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedConsentRevision: 1,
        expectedKeyVersion: 1,
        expectedRevision: enabling.revision,
        target: { state: "enabled" },
        transitionedAt: "2026-07-28T01:03:00.000Z",
      }),
    );

    expect(
      expectOk(
        await store.claimProjectionJob({
          projectId: PROJECT_ID,
          leaseOwnerId: WORKER_ID,
          leaseToken: "019fa002-2000-7000-8000-000000000098",
          leasedAt: "2026-07-28T01:04:00.000Z",
          leaseExpiresAt: "2026-07-28T01:08:00.000Z",
        }),
      ),
    ).toBeNull();
    await expect(
      executor.select<{ account_id: string; status: string }>(
        "SELECT account_id, status FROM sync_projection_jobs WHERE job_id = ?",
        [JOB_ID],
      ),
    ).resolves.toEqual([{ account_id: ACCOUNT_ID, status: "queued" }]);
  });

  it("blocks later chapter history after a predecessor fails terminally", async () => {
    await enableSync(store);
    const objectId = "019fa002-2000-7000-8000-000000000040";
    const first = projectionJob({
      jobId: "019fa002-2000-7000-8000-000000000041",
      objectId,
      versionId: "019fa002-2000-7000-8000-000000000042",
    });
    const second = projectionJob({
      jobId: "019fa002-2000-7000-8000-000000000043",
      objectId,
      versionId: "019fa002-2000-7000-8000-000000000044",
      sourceRevision: 2,
      createdAt: LATER,
      nextAttemptAt: LATER,
    });
    expectOk(await store.enqueueProjectionJob(first));
    expectOk(await store.enqueueProjectionJob(second));
    const leased = expectOk(
      await store.claimProjectionJob({
        projectId: PROJECT_ID,
        leaseOwnerId: WORKER_ID,
        leaseToken: "019fa002-2000-7000-8000-000000000045",
        leasedAt: LATER,
        leaseExpiresAt: LEASE_EXPIRES,
      }),
    );
    if (leased === null) {
      throw new Error("Expected the first chapter projection.");
    }
    expectOk(
      await store.failProjectionJob({
        jobId: leased.jobId,
        expectedRevision: leased.revision,
        leaseOwnerId: WORKER_ID,
        leaseToken: "019fa002-2000-7000-8000-000000000045",
        failureCode: "PAYLOAD_REJECTED",
        failedAt: "2026-07-28T01:02:00.000Z",
      }),
    );
    expect(
      expectOk(
        await store.claimProjectionJob({
          projectId: PROJECT_ID,
          leaseOwnerId: WORKER_ID,
          leaseToken: "019fa002-2000-7000-8000-000000000046",
          leasedAt: "2026-07-28T01:03:00.000Z",
          leaseExpiresAt: "2026-07-28T01:06:00.000Z",
        }),
      ),
    ).toBeNull();
  });

  it("still coalesces superseded project-manifest projections", async () => {
    await enableSync(store);
    const first = projectionJob({
      jobId: "019fa002-2000-7000-8000-000000000050",
      objectType: "project_manifest",
      objectId: PROJECT_ID,
      versionId: "019fa002-2000-7000-8000-000000000051",
    });
    const second = projectionJob({
      jobId: "019fa002-2000-7000-8000-000000000052",
      objectType: "project_manifest",
      objectId: PROJECT_ID,
      versionId: "019fa002-2000-7000-8000-000000000053",
      sourceRevision: 2,
      createdAt: LATER,
      nextAttemptAt: LATER,
    });
    expectOk(await store.enqueueProjectionJob(first));
    expectOk(await store.enqueueProjectionJob(second));
    await expect(
      executor.select<{ status: string; supersededBy: string }>(
        `SELECT status, superseded_by_job_id AS supersededBy
         FROM sync_projection_jobs
         WHERE job_id = ?`,
        [first.jobId],
      ),
    ).resolves.toEqual([{ status: "superseded", supersededBy: second.jobId }]);
  });

  it("persists only hash references for conflict evidence and resolves by CAS", async () => {
    const conflict = expectOk(
      await executor.transaction((transaction) =>
        registerSyncContentConflictInTransaction(transaction, {
          conflictId: "019fa002-2000-7000-8000-000000000020",
          projectId: PROJECT_ID,
          objectType: "chapter_version",
          objectId: OBJECT_ID,
          objectGeneration: 1,
          localVector: { [DEVICE_ID]: 2 },
          remoteVector: { [OTHER_DEVICE_ID]: 1 },
          remoteOperationId: OPERATION_ID,
          remoteKind: "upsert",
          remotePayloadSha256: "f".repeat(64),
          createdAt: NOW,
        }),
      ),
    );
    expect(conflict).toMatchObject({ status: "unresolved", revision: 1 });
    const secondConflict = expectOk(
      await store.registerContentConflict({
        conflictId: "019fa002-2000-7000-8000-000000000021",
        projectId: PROJECT_ID,
        objectType: "chapter_version",
        objectId: OBJECT_ID,
        objectGeneration: 1,
        localVector: { [DEVICE_ID]: 2 },
        remoteVector: { [OTHER_DEVICE_ID]: 2 },
        remoteOperationId: "019fa002-2000-7000-8000-000000000022",
        remoteKind: "upsert",
        remotePayloadSha256: "e".repeat(64),
        createdAt: LATER,
      }),
    );
    expect(secondConflict).toMatchObject({
      status: "unresolved",
      remoteOperationId: "019fa002-2000-7000-8000-000000000022",
    });
    await expect(
      executor.select<{ count: number }>(
        `SELECT count(*) AS count
         FROM sync_content_conflicts
         WHERE project_id = ? AND object_type = ? AND object_id = ?`,
        [PROJECT_ID, "chapter_version", OBJECT_ID],
      ),
    ).resolves.toEqual([{ count: 2 }]);
    expectErrorCode(
      await store.registerContentConflict({
        conflictId: "019fa002-2000-7000-8000-000000000023",
        projectId: PROJECT_ID,
        objectType: "chapter_version",
        objectId: OBJECT_ID,
        objectGeneration: 1,
        localVector: { [DEVICE_ID]: 2 },
        remoteVector: { [OTHER_DEVICE_ID]: 2 },
        remoteOperationId: secondConflict.remoteOperationId,
        remoteKind: "upsert",
        remotePayloadSha256: "e".repeat(64),
        createdAt: LATER,
      }),
      "INVALID_STATE_TRANSITION",
    );
    const resolved = expectOk(
      await store.resolveContentConflict({
        conflictId: conflict.conflictId,
        expectedRevision: 1,
        resolution: "accept_local",
        resolutionOperationId: null,
        resolvedAt: LATER,
      }),
    );
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: "accept_local",
      revision: 2,
    });
    const columns = (
      executor.database.prepare("PRAGMA table_info(sync_content_conflicts)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name);
    expect(columns.some((name) => /content|title|body|plaintext/iu.test(name))).toBe(false);
  });

  it("enqueues reference jobs inside an existing business transaction without nesting", async () => {
    await enableSync(store);
    const result = await executor.transaction((transaction) =>
      enqueueSyncProjectionJobInTransaction(transaction, projectionJob()),
    );
    expect(expectOk(result)).toMatchObject({ jobId: JOB_ID, status: "queued" });
  });

  it("transitions bootstrap registration inside a caller-owned transaction", async () => {
    expectOk(
      await store.beginProjectSyncEnable({
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        consentRevision: 1,
        keyVersion: 1,
        expectedRevision: null,
        begunAt: NOW,
      }),
    );
    expectOk(
      await store.transitionProjectSyncRegistration({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedConsentRevision: 1,
        expectedKeyVersion: 1,
        expectedRevision: 1,
        target: { state: "bootstrap_required" },
        transitionedAt: LATER,
      }),
    );
    await executor.execute("CREATE TABLE snapshot_finalize_markers (id TEXT PRIMARY KEY NOT NULL)");

    const transitionedAt = "2026-07-28T01:02:00.000Z";
    const registration = await executor.transaction(async (transaction) => {
      await transaction.execute(
        "INSERT INTO snapshot_finalize_markers (id) VALUES ('snapshot-finalized')",
      );
      return expectOk(
        await transitionProjectSyncRegistrationInTransaction(transaction, {
          projectId: PROJECT_ID,
          expectedAccountId: ACCOUNT_ID,
          expectedDeviceId: DEVICE_ID,
          expectedConsentRevision: 1,
          expectedKeyVersion: 1,
          expectedRevision: 2,
          target: { state: "enabled" },
          transitionedAt,
        }),
      );
    });

    expect(registration).toMatchObject({
      state: "enabled",
      revision: 3,
      plaintextBootstrapCompleted: true,
      enabledAt: transitionedAt,
    });
    await expect(
      executor.select<{ id: string }>("SELECT id FROM snapshot_finalize_markers"),
    ).resolves.toEqual([{ id: "snapshot-finalized" }]);
  });
});

function materializedObject(
  objectType: "chapter_version" | "memory",
  operationId: string,
  objectGeneration = 1,
) {
  return {
    projectId: PROJECT_ID,
    objectType,
    objectId: OBJECT_ID,
    objectGeneration,
    versionId: VERSION_ID,
    vector: { [DEVICE_ID]: 1 },
    payloadSha256: "a".repeat(64),
    sourceOperationId: operationId,
    sourceDeviceId: DEVICE_ID,
    sourceDeviceSequence: 1,
    state: "present" as const,
    materializedAt: NOW,
  };
}

function projectionJob(
  overrides: Partial<EnqueueSyncProjectionJobInput> = {},
): EnqueueSyncProjectionJobInput {
  return {
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    objectType: "chapter_version",
    objectId: OBJECT_ID,
    objectGeneration: 1,
    projectionKind: "upsert",
    versionId: VERSION_ID,
    sourceRevision: 1,
    keyVersion: 1,
    consentRevision: 1,
    deviceId: DEVICE_ID,
    createdAt: NOW,
    nextAttemptAt: NOW,
    ...overrides,
  };
}

async function enableSync(
  store: SyncMaterializationSqliteStore,
  options: { readonly manifestPresent?: boolean } = {},
): Promise<void> {
  expectOk(
    await store.beginProjectSyncEnable({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      consentRevision: 1,
      keyVersion: 1,
      expectedRevision: null,
      begunAt: NOW,
    }),
  );
  expectOk(
    await store.transitionProjectSyncRegistration({
      projectId: PROJECT_ID,
      expectedAccountId: ACCOUNT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedConsentRevision: 1,
      expectedKeyVersion: 1,
      expectedRevision: 1,
      target: { state: "enabled" },
      transitionedAt: LATER,
    }),
  );
  if (options.manifestPresent !== false) {
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
          sourceOperationId: "019fa002-2000-7000-8000-000000000097",
          sourceDeviceId: DEVICE_ID,
          sourceDeviceSequence: 1,
          state: "present",
          materializedAt: LATER,
        },
        expectedSourceOperationId: null,
      }),
    );
  }
}

async function prepareFencedPush(
  store: SyncMaterializationSqliteStore,
  executor: NodeSqliteExecutor,
): Promise<void> {
  await enableSync(store);
  await insertDownloadedCheckpoint(executor, "settled_cursor", 1, NOW);
  expectOk(
    await store.advanceMaterializedCheckpoint({
      projectId: PROJECT_ID,
      signedRemoteCursor: "settled_cursor",
      downloadedCheckpointRevision: 1,
      expectedRevision: null,
      updatedAt: NOW,
    }),
  );
  expectOk(await store.enqueueProjectionJob(projectionJob()));
  const leased = expectOk(
    await store.claimProjectionJob({
      projectId: PROJECT_ID,
      leaseOwnerId: WORKER_ID,
      leaseToken: "019fa002-2000-7000-8000-000000000083",
      leasedAt: LATER,
      leaseExpiresAt: LEASE_EXPIRES,
    }),
  );
  if (leased === null) {
    throw new Error("Expected a projection lease.");
  }
  expectOk(
    await store.completeProjectionJob({
      jobId: leased.jobId,
      expectedRevision: leased.revision,
      leaseOwnerId: WORKER_ID,
      leaseToken: "019fa002-2000-7000-8000-000000000083",
      operationId: OPERATION_ID,
      completedAt: "2026-07-28T01:02:00.000Z",
    }),
  );
  await executor.execute(
    `INSERT INTO sync_outbox_operations (
       operation_id, project_id, device_id, device_sequence, object_type,
       object_id, object_generation, kind, vector_json, status, attempt,
       next_attempt_at, lease_owner_id, lease_token, lease_expires_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, 2, 'chapter_version', ?, 1, 'upsert', ?, 'in_flight', 1,
       NULL, ?, ?, ?, ?, ?)`,
    [
      OPERATION_ID,
      PROJECT_ID,
      DEVICE_ID,
      OBJECT_ID,
      JSON.stringify({ [DEVICE_ID]: 2 }),
      WORKER_ID,
      LEASE_TOKEN,
      LEASE_EXPIRES,
      LATER,
      LATER,
    ],
  );
}

function fencedPushInput() {
  return {
    projectId: PROJECT_ID,
    operationId: OPERATION_ID,
    activeAccountId: ACCOUNT_ID,
    activeDeviceId: DEVICE_ID,
    settledSignedRemoteCursor: "settled_cursor",
    settledDownloadedCheckpointRevision: 1,
    settledMaterializedCheckpointRevision: 1,
    requestBaseCursor: "settled_cursor",
    leaseOwnerId: WORKER_ID,
    leaseToken: LEASE_TOKEN,
    authorizedAt: "2026-07-28T01:02:15.000Z",
    readAcknowledgedAt: () => "2026-07-28T01:02:30.000Z",
  };
}

async function insertDownloadedCheckpoint(
  executor: NodeSqliteExecutor,
  cursor: string,
  revision: number,
  updatedAt: string,
): Promise<void> {
  await executor.execute(
    `INSERT INTO sync_remote_checkpoints (
       project_id, signed_remote_cursor, revision, updated_at
     ) VALUES (?, ?, ?, ?)`,
    [PROJECT_ID, cursor, revision, updatedAt],
  );
}

function expectOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function expectErrorCode(result: Result<unknown, AppError>, expectedCode: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe(expectedCode);
  }
}
