import { CloudClientError, type InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import {
  CONTRACT_SCHEMA_VERSION,
  type CloudSyncPullResponse,
  type EncryptedSyncChunkContract,
} from "@inkshadow/contracts";
import type {
  ClaimedIncomingSyncWork,
  ClaimedSyncOperation,
  ClaimProjectSyncOperationCommand,
} from "@inkshadow/data/sync-sqlite-store";
import {
  ProjectionOperationPushResponseMismatchError,
  type ProjectionOperationPushFenceInput,
  type ProjectionOperationPushFenceResult,
  type ProjectionOperationPushNetworkResponse,
  type TransactionExecutor,
} from "@inkshadow/data";
import { AppError, type Clock, type UuidV7Generator } from "@inkshadow/domain";
import { SyncCoreError } from "@inkshadow/sync-core";
import { describe, expect, it, vi } from "vitest";

import {
  CloudSyncOrchestrator,
  type CloudSyncOrchestratorDependencies,
  type IncomingApplyOutcome,
  type ProjectionOperationPushAuthority,
} from "./cloud-sync-orchestrator";
import {
  CloudSessionCoordinatorError,
  type ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000017";
const OWNER_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OLD_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000016";
const OBJECT_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const VERSION_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const SECOND_OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const THIRD_OPERATION_ID = "019f9f4a-b3c7-7350-9226-000000000008";
const CHUNK_ID = "019f9f4a-b3c7-7350-9226-000000000009";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000010";
const LEASE_IDS = [
  "019f9f4a-b3c7-7350-9226-000000000011",
  "019f9f4a-b3c7-7350-9226-000000000012",
  "019f9f4a-b3c7-7350-9226-000000000013",
  "019f9f4a-b3c7-7350-9226-000000000014",
] as const;
const NOW = "2026-07-27T00:00:00.000Z";

interface TestPreparedIncoming {
  readonly operationId: string;
  readonly fingerprint: string;
}

describe("CloudSyncOrchestrator", () => {
  it("is opt-in and performs no local or cloud work while disabled", async () => {
    const fixture = createFixture({ enabled: false });

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      state: "disabled",
      pull: { pages: 0 },
      outgoing: { boundary: "project_scoped_claim_unavailable" },
    });
    expect(fixture.store.readRemoteCheckpoint).not.toHaveBeenCalled();
    expect(fixture.api.pullSync).not.toHaveBeenCalled();
  });

  it("runs cloud I/O through the native session coordinator and reports a blocked session", async () => {
    const session = {
      runWithSession: vi.fn(() =>
        Promise.reject(
          new CloudSessionCoordinatorError(
            "reauth_required",
            "AUTH_SESSION_REQUIRED",
            "A configured cloud session is required.",
          ),
        ),
      ),
    };
    const fixture = createFixture({ session });

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "auth_blocked",
      failure: { category: "auth_blocked", code: "AUTH_SESSION_REQUIRED" },
    });
    expect(session.runWithSession).toHaveBeenCalledTimes(1);
    expect(fixture.api.pullSync).not.toHaveBeenCalled();
  });

  it("pulls from the signed checkpoint across bounded pages and stages each page atomically", async () => {
    const fixture = createFixture();
    fixture.store.readRemoteCheckpoint.mockResolvedValueOnce(
      success({
        projectId: PROJECT_ID,
        signedRemoteCursor: "signed_cursor_0",
        revision: 3,
        updatedAt: NOW,
      }),
    );
    fixture.api.pullSync
      .mockResolvedValueOnce(pullResponse("signed_cursor_1", true))
      .mockResolvedValueOnce(pullResponse("signed_cursor_2", false));

    const result = await fixture.orchestrator.runProjectCycle(PROJECT_ID);

    expect(fixture.api.pullSync).toHaveBeenNthCalledWith(
      1,
      PROJECT_ID,
      expect.objectContaining({ cursor: "signed_cursor_0", limit: 128 }),
    );
    expect(fixture.api.pullSync).toHaveBeenNthCalledWith(
      2,
      PROJECT_ID,
      expect.objectContaining({ cursor: "signed_cursor_1", limit: 128 }),
    );
    expect(fixture.store.stageIncomingSyncBatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: PROJECT_ID,
        priorSignedRemoteCursor: "signed_cursor_0",
      }),
    );
    expect(fixture.store.stageIncomingSyncBatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: PROJECT_ID,
        priorSignedRemoteCursor: "signed_cursor_1",
      }),
    );
    expect(result).toMatchObject({
      state: "boundary_blocked",
      failure: {
        category: "boundary_blocked",
        code: "PROJECT_SCOPED_OUTBOX_UNAVAILABLE",
      },
      pull: { pages: 2, stagedBatches: 2, pageLimitReached: false },
    });
  });

  it("accepts an exact staged replay without duplicating the batch", async () => {
    const fixture = createFixture();
    fixture.store.readRemoteCheckpoint.mockResolvedValueOnce(
      success({
        projectId: PROJECT_ID,
        signedRemoteCursor: "signed_cursor_replayed",
        revision: 1,
        updatedAt: NOW,
      }),
    );
    fixture.api.pullSync.mockResolvedValueOnce(pullResponse("signed_cursor_replayed", false));
    fixture.store.stageIncomingSyncBatch.mockResolvedValueOnce(
      success({
        batchId: "019f9f4a-b3c7-7350-9226-000000000015",
        created: false,
        operationCount: 0,
        chunkCount: 0,
        tombstoneCount: 0,
        checkpoint: {
          projectId: PROJECT_ID,
          signedRemoteCursor: "signed_cursor_replayed",
          revision: 1,
          updatedAt: NOW,
        },
      }),
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "boundary_blocked",
      pull: { pages: 1, stagedBatches: 0 },
    });
    expect(fixture.store.stageIncomingSyncBatch).toHaveBeenCalledTimes(1);
  });

  it("returns the same in-flight project cycle and sends only one pull", async () => {
    const fixture = createFixture();
    const deferred = createDeferred<CloudSyncPullResponse>();
    fixture.api.pullSync.mockReturnValueOnce(deferred.promise);

    const first = fixture.orchestrator.runProjectCycle(PROJECT_ID);
    const second = fixture.orchestrator.runProjectCycle(PROJECT_ID);

    expect(second).toBe(first);
    deferred.resolve(pullResponse("signed_cursor_1", false));
    await expect(first).resolves.toMatchObject({ state: "boundary_blocked" });
    expect(fixture.api.pullSync).toHaveBeenCalledTimes(1);
  });

  it("honors an already-aborted signal without acquiring local work", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      fixture.orchestrator.runProjectCycle(PROJECT_ID, {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ state: "aborted" });
    expect(fixture.store.readRemoteCheckpoint).not.toHaveBeenCalled();
    expect(fixture.store.claimNextIncoming).not.toHaveBeenCalled();
    expect(fixture.api.pullSync).not.toHaveBeenCalled();
  });

  it("recovers leased incoming work and records applied, conflict, and bounded retry outcomes", async () => {
    const outcomes = new Map<string, IncomingApplyOutcome>([
      [OPERATION_ID, { status: "retry", code: "DECRYPTION_RETRY" }],
      [SECOND_OPERATION_ID, { status: "applied" }],
      [THIRD_OPERATION_ID, { status: "conflict", code: "VERSION_VECTOR_CONFLICT" }],
    ]);
    const fixture = createFixture({
      applyPreparedIncoming: vi.fn((_transaction, work: ClaimedIncomingSyncWork) =>
        Promise.resolve(
          outcomes.get(work.operation.operationId) ??
            ({ status: "applied" } satisfies IncomingApplyOutcome),
        ),
      ),
      limits: {
        retryBaseMs: 1_000,
        retryMaximumMs: 8_000,
        maximumIncomingOperations: 4,
      },
    });
    const pending = [
      { operationId: OPERATION_ID, attempt: 2 },
      { operationId: SECOND_OPERATION_ID, attempt: 1 },
      { operationId: THIRD_OPERATION_ID, attempt: 1 },
    ];
    fixture.store.claimNextIncoming.mockImplementation(
      (command: {
        readonly ownerId: string;
        readonly leaseToken: string;
        readonly leaseExpiresAt: string;
      }) => {
        const next = pending.shift();
        return Promise.resolve(
          success(
            next === undefined
              ? null
              : incomingWork(
                  next.operationId,
                  next.attempt,
                  command.ownerId,
                  command.leaseToken,
                  command.leaseExpiresAt,
                ),
          ),
        );
      },
    );

    const result = await fixture.orchestrator.runProjectCycle(PROJECT_ID);

    expect(result).toMatchObject({
      state: "conflict_blocked",
      failure: {
        category: "conflict_blocked",
        code: "INCOMING_VERSION_CONFLICT_REQUIRES_RESOLUTION",
      },
    });
    expect(result.incoming).toMatchObject({
      claimed: 3,
      applied: 1,
      conflicts: 1,
      retried: 1,
      workLimitReached: false,
    });
    expect(fixture.store.markIncomingFailure).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      leaseToken: LEASE_IDS[0],
      failureCode: "DECRYPTION_RETRY",
      now: NOW,
      nextAttemptAt: "2026-07-27T00:00:02.000Z",
    });
    expect(fixture.store.resolveClaimedIncomingAtomically).toHaveBeenCalledTimes(3);
    const secondApplyCall = vi.mocked(fixture.applyPreparedIncoming).mock.calls[1];
    expect(secondApplyCall?.[0]).toBe(fixture.transaction);
    expect(secondApplyCall?.[1].operation.operationId).toBe(SECOND_OPERATION_ID);
    expect(secondApplyCall?.[2]).toEqual({
      operationId: SECOND_OPERATION_ID,
      fingerprint: `prepared:${SECOND_OPERATION_ID}`,
    });
    expect(secondApplyCall?.[3]).toEqual({ now: NOW });
  });

  it("prepares ciphertext before opening the atomic resolution and maps skipped to applied", async () => {
    const fixture = createFixture({
      applyPreparedIncoming: vi.fn(() => Promise.resolve({ status: "skipped" as const })),
    });
    fixture.store.claimNextIncoming
      .mockResolvedValueOnce(
        success(incomingWork(OPERATION_ID, 1, OWNER_ID, LEASE_IDS[0], "2026-07-27T00:00:30.000Z")),
      )
      .mockResolvedValue(success(null));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      incoming: { claimed: 1, applied: 1, conflicts: 0, retried: 0 },
    });

    const prepareOrder = vi.mocked(fixture.prepareIncoming).mock.invocationCallOrder[0];
    const transactionOrder =
      fixture.store.resolveClaimedIncomingAtomically.mock.invocationCallOrder[0];
    const applyOrder = vi.mocked(fixture.applyPreparedIncoming).mock.invocationCallOrder[0];
    expect(prepareOrder).toBeLessThan(transactionOrder ?? 0);
    expect(transactionOrder).toBeLessThan(applyOrder ?? 0);
    const prepareCall = vi.mocked(fixture.prepareIncoming).mock.calls[0];
    expect(prepareCall?.[0].operation.operationId).toBe(OPERATION_ID);
    expect(prepareCall?.[1]).toEqual({ now: NOW });
  });

  it("leaves an aborted incoming preparation lease unresolved for expiry-based recovery", async () => {
    const controller = new AbortController();
    const fixture = createFixture({
      prepareIncoming: vi.fn(() => {
        controller.abort();
        return Promise.reject(new DOMException("test abort", "AbortError"));
      }),
    });
    fixture.store.claimNextIncoming
      .mockResolvedValueOnce(
        success(incomingWork(OPERATION_ID, 1, OWNER_ID, LEASE_IDS[0], "2026-07-27T00:00:30.000Z")),
      )
      .mockResolvedValue(success(null));

    await expect(
      fixture.orchestrator.runProjectCycle(PROJECT_ID, {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      state: "aborted",
      incoming: { claimed: 1, applied: 0, conflicts: 0, retried: 0 },
    });
    expect(fixture.store.resolveClaimedIncomingAtomically).not.toHaveBeenCalled();
    expect(fixture.store.markIncomingFailure).not.toHaveBeenCalled();
  });

  it("reschedules a temporarily unavailable historical key before opening a transaction", async () => {
    const fixture = createFixture({
      prepareIncoming: vi.fn(() =>
        Promise.reject(
          new AppError({
            code: "INVALID_STATE_TRANSITION",
            message: "The exact historical project key is not available yet.",
            actions: ["OPEN_SETTINGS"],
          }),
        ),
      ),
      limits: { retryBaseMs: 1_000, retryMaximumMs: 8_000 },
    });
    fixture.store.claimNextIncoming
      .mockResolvedValueOnce(
        success(incomingWork(OPERATION_ID, 2, OWNER_ID, LEASE_IDS[0], "2026-07-27T00:00:30.000Z")),
      )
      .mockResolvedValue(success(null));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "retryable",
      incoming: { claimed: 1, applied: 0, conflicts: 0, retried: 1 },
    });
    expect(fixture.store.resolveClaimedIncomingAtomically).not.toHaveBeenCalled();
    expect(fixture.store.markIncomingFailure).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      leaseToken: LEASE_IDS[0],
      failureCode: "INVALID_STATE_TRANSITION",
      now: NOW,
      nextAttemptAt: "2026-07-27T00:00:02.000Z",
    });
  });

  it("permanently pauses malformed authenticated metadata without opening a transaction", async () => {
    const fixture = createFixture({
      prepareIncoming: vi.fn(() =>
        Promise.reject(
          new SyncCoreError(
            "SYNC_CHUNK_METADATA_MISMATCH",
            "The incoming AAD does not match its operation.",
          ),
        ),
      ),
    });
    fixture.store.claimNextIncoming
      .mockResolvedValueOnce(
        success(incomingWork(OPERATION_ID, 1, OWNER_ID, LEASE_IDS[0], "2026-07-27T00:00:30.000Z")),
      )
      .mockResolvedValue(success(null));
    fixture.store.readProjectSyncBlockingState.mockResolvedValueOnce(
      success({
        projectId: PROJECT_ID,
        incomingConflictCount: 0,
        incomingPendingCount: 1,
        incomingPausedCount: 1,
        incomingAttemptExhaustedCount: 0,
        outgoingPendingCount: 0,
        outgoingPausedCount: 0,
        outgoingAttemptExhaustedCount: 0,
      }),
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      failure: { category: "permanent_paused", code: "INCOMING_WORK_PAUSED" },
      incoming: { claimed: 1, applied: 0, conflicts: 0, retried: 0 },
    });
    expect(fixture.store.resolveClaimedIncomingAtomically).not.toHaveBeenCalled();
    expect(fixture.store.markIncomingFailure).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      leaseToken: LEASE_IDS[0],
      failureCode: "SYNC_CHUNK_METADATA_MISMATCH",
      now: NOW,
      nextAttemptAt: null,
    });
  });

  it("permanently pauses a non-retryable local integrity error", async () => {
    const fixture = createFixture({
      prepareIncoming: vi.fn(() =>
        Promise.reject(
          new AppError({
            code: "REPOSITORY_ERROR",
            message: "The persisted ciphertext record is inconsistent.",
            actions: ["CONTACT_SUPPORT"],
            details: { operation: "SYNC_LOCAL_RECORD_INVALID" },
          }),
        ),
      ),
    });
    fixture.store.claimNextIncoming
      .mockResolvedValueOnce(
        success(incomingWork(OPERATION_ID, 1, OWNER_ID, LEASE_IDS[0], "2026-07-27T00:00:30.000Z")),
      )
      .mockResolvedValue(success(null));
    fixture.store.readProjectSyncBlockingState.mockResolvedValueOnce(
      success({
        projectId: PROJECT_ID,
        incomingConflictCount: 0,
        incomingPendingCount: 1,
        incomingPausedCount: 1,
        incomingAttemptExhaustedCount: 0,
        outgoingPendingCount: 0,
        outgoingPausedCount: 0,
        outgoingAttemptExhaustedCount: 0,
      }),
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      incoming: { claimed: 1, applied: 0, conflicts: 0, retried: 0 },
    });
    expect(fixture.store.resolveClaimedIncomingAtomically).not.toHaveBeenCalled();
    expect(fixture.store.markIncomingFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        failureCode: "REPOSITORY_ERROR",
        nextAttemptAt: null,
      }),
    );
  });

  it("rejects a transaction-time ciphertext fingerprint swap without an applied receipt", async () => {
    const fixture = createFixture({
      prepareIncoming: vi.fn((work: ClaimedIncomingSyncWork) =>
        Promise.resolve({
          operationId: work.operation.operationId,
          fingerprint: work.tombstone?.retainUntil ?? "missing",
        }),
      ),
      applyPreparedIncoming: vi.fn(
        (
          _transaction: TransactionExecutor,
          exactWork: ClaimedIncomingSyncWork,
          prepared: TestPreparedIncoming,
        ) => {
          if (prepared.fingerprint !== exactWork.tombstone?.retainUntil) {
            throw new SyncCoreError(
              "SYNC_TRANSFER_MISMATCH",
              "Prepared plaintext does not belong to the exact claimed work.",
            );
          }
          return Promise.resolve({ status: "applied" as const });
        },
      ),
    });
    fixture.store.claimNextIncoming
      .mockResolvedValueOnce(
        success(incomingWork(OPERATION_ID, 1, OWNER_ID, LEASE_IDS[0], "2026-07-27T00:00:30.000Z")),
      )
      .mockResolvedValue(success(null));
    fixture.store.resolveClaimedIncomingAtomically.mockImplementationOnce(
      async (command, apply) => {
        try {
          const exact = incomingWork(
            command.operationId,
            1,
            OWNER_ID,
            command.leaseToken,
            "2026-07-27T00:01:30.000Z",
          );
          const result = await apply(fixture.transaction, {
            ...exact,
            tombstone:
              exact.tombstone === null
                ? null
                : { ...exact.tombstone, retainUntil: "2028-07-27T00:00:00.000Z" },
          });
          return success({
            operationId: command.operationId,
            status: result.status,
            conflictCode: result.status === "conflict" ? result.conflictCode : null,
            replayed: false,
          });
        } catch (cause: unknown) {
          if (cause instanceof AppError) {
            return { ok: false as const, error: cause };
          }
          throw cause;
        }
      },
    );
    fixture.store.readProjectSyncBlockingState.mockResolvedValueOnce(
      success({
        projectId: PROJECT_ID,
        incomingConflictCount: 0,
        incomingPendingCount: 1,
        incomingPausedCount: 1,
        incomingAttemptExhaustedCount: 0,
        outgoingPendingCount: 0,
        outgoingPausedCount: 0,
        outgoingAttemptExhaustedCount: 0,
      }),
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      incoming: { claimed: 1, applied: 0, conflicts: 0, retried: 0 },
    });
    expect(fixture.applyPreparedIncoming).toHaveBeenCalledTimes(1);
    expect(fixture.store.markIncomingFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        failureCode: "SYNC_TRANSFER_MISMATCH",
        nextAttemptAt: null,
      }),
    );
  });

  it("does not report applied when the SQLite resolution transaction fails to commit", async () => {
    const fixture = createFixture({
      limits: { retryBaseMs: 1_000, retryMaximumMs: 8_000 },
    });
    fixture.store.claimNextIncoming
      .mockResolvedValueOnce(
        success(incomingWork(OPERATION_ID, 1, OWNER_ID, LEASE_IDS[0], "2026-07-27T00:00:30.000Z")),
      )
      .mockResolvedValue(success(null));
    fixture.store.resolveClaimedIncomingAtomically.mockImplementationOnce(
      async (command, apply) => {
        const exact = incomingWork(
          command.operationId,
          1,
          OWNER_ID,
          command.leaseToken,
          "2026-07-27T00:01:30.000Z",
        );
        await expect(apply(fixture.transaction, exact)).resolves.toEqual({ status: "applied" });
        return {
          ok: false as const,
          error: new AppError({
            code: "REPOSITORY_ERROR",
            message: "The SQLite commit failed.",
            retryable: true,
            actions: ["RETRY"],
          }),
        };
      },
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "retryable",
      incoming: { claimed: 1, applied: 0, conflicts: 0, retried: 1 },
    });
    expect(fixture.store.markIncomingFailure).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      leaseToken: LEASE_IDS[0],
      failureCode: "REPOSITORY_ERROR",
      now: NOW,
      nextAttemptAt: "2026-07-27T00:00:01.000Z",
    });
  });

  it("reports scheduled incoming work as retryable instead of synchronized", async () => {
    const fixture = createFixture({
      applyPreparedIncoming: vi.fn(() =>
        Promise.resolve({
          status: "retry",
          code: "PROJECT_KEY_TEMPORARILY_UNAVAILABLE",
        } satisfies IncomingApplyOutcome),
      ),
    });
    fixture.store.claimNextIncoming
      .mockResolvedValueOnce(
        success(incomingWork(OPERATION_ID, 1, OWNER_ID, LEASE_IDS[0], "2026-07-27T00:00:30.000Z")),
      )
      .mockResolvedValue(success(null));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "retryable",
      failure: { category: "retryable", code: "SYNC_WORK_REMAINS" },
      incoming: { retried: 1 },
    });
  });

  it("parks durable work that exhausted its retry budget", async () => {
    const fixture = createFixture();
    fixture.store.readProjectSyncBlockingState.mockResolvedValueOnce(
      success({
        projectId: PROJECT_ID,
        incomingConflictCount: 0,
        incomingPendingCount: 1,
        incomingPausedCount: 0,
        incomingAttemptExhaustedCount: 1,
        outgoingPendingCount: 0,
        outgoingPausedCount: 0,
        outgoingAttemptExhaustedCount: 0,
      }),
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      failure: {
        category: "permanent_paused",
        code: "SYNC_ATTEMPT_BUDGET_EXHAUSTED",
      },
    });
  });

  it("reports a fail-closed incoming payload as permanently paused", async () => {
    const fixture = createFixture();
    fixture.store.readProjectSyncBlockingState.mockResolvedValueOnce(
      success({
        projectId: PROJECT_ID,
        incomingConflictCount: 0,
        incomingPendingCount: 1,
        incomingPausedCount: 1,
        incomingAttemptExhaustedCount: 0,
        outgoingPendingCount: 0,
        outgoingPausedCount: 0,
        outgoingAttemptExhaustedCount: 0,
      }),
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      failure: {
        category: "permanent_paused",
        code: "INCOMING_WORK_PAUSED",
      },
    });
  });

  it("never claims outgoing work when plaintext checkpoint settlement is blocked", async () => {
    const projectOutbox = {
      claimNextForProject: vi.fn().mockResolvedValue(success(null)),
    };
    const incrementalSettlement = {
      settleProjectIncremental: vi.fn().mockResolvedValue({
        projectId: PROJECT_ID,
        state: "retryable",
        pushAllowed: false,
        checkpoint: null,
        checkpointAdvanced: false,
        registrationEnabled: false,
        seededJobs: 0,
        skippedSeedJobs: 0,
        failure: {
          category: "retryable",
          code: "SYNC_INCOMING_MATERIALIZATION_PENDING",
        },
      }),
    };
    const fixture = createFixture({
      projectOutbox,
      incrementalSettlement,
    });

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "retryable",
      failure: {
        category: "retryable",
        code: "SYNC_INCOMING_MATERIALIZATION_PENDING",
      },
      outgoing: { claimed: 0, pushed: 0 },
    });
    expect(projectOutbox.claimNextForProject).not.toHaveBeenCalled();
    expect(fixture.api.pushSync).not.toHaveBeenCalled();
  });

  it("does not settle or push from an intermediate pull page", async () => {
    const projectOutbox = {
      claimNextForProject: vi.fn().mockResolvedValue(success(null)),
    };
    const incrementalSettlement = {
      settleProjectIncremental: vi.fn(),
    };
    const fixture = createFixture({
      projectOutbox,
      incrementalSettlement,
      limits: { maximumPullPages: 1 },
    });
    fixture.api.pullSync.mockResolvedValueOnce(pullResponse("signed_cursor_partial", true));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "boundary_blocked",
      failure: {
        category: "boundary_blocked",
        code: "SYNC_INCREMENTAL_PULL_INCOMPLETE",
      },
      pull: { pageLimitReached: true },
      outgoing: { claimed: 0, pushed: 0 },
    });
    expect(incrementalSettlement.settleProjectIncremental).not.toHaveBeenCalled();
    expect(projectOutbox.claimNextForProject).not.toHaveBeenCalled();
  });

  it("replays outgoing ciphertext with attempt-scoped idempotency and acknowledges the exact operation", async () => {
    const claimed = outgoingWork("upsert", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(
            success({
              ...claimed,
              leaseOwnerId: command.ownerId,
              leaseToken: command.leaseToken,
              leaseExpiresAt: command.leaseExpiresAt,
            }),
          ),
        )
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(
            success({
              ...claimed,
              attempt: 2,
              leaseOwnerId: command.ownerId,
              leaseToken: command.leaseToken,
              leaseExpiresAt: command.leaseExpiresAt,
            }),
          ),
        )
        .mockResolvedValue(success(null)),
    };
    const fixture = createFixture({
      projectOutbox,
      limits: {
        retryBaseMs: 1_000,
        retryMaximumMs: 8_000,
        maximumOutgoingOperations: 2,
      },
    });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({
        chunkId: CHUNK_ID,
        encrypted: encryptedChunk(),
        createdAt: NOW,
      }),
    );
    fixture.api.pullSync
      .mockResolvedValueOnce(pullResponse("signed_cursor_before_first_push", false))
      .mockResolvedValueOnce(pullResponse("signed_cursor_before_retry", false));
    fixture.api.pushSync
      .mockRejectedValueOnce(
        new CloudClientError({
          code: "CLOUD_NETWORK_UNAVAILABLE",
          message: "test offline",
          status: null,
          requestId: REQUEST_ID,
          retryable: true,
        }),
      )
      .mockResolvedValueOnce({
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        requestId: REQUEST_ID,
        acceptedOperations: [{ operationId: OPERATION_ID, disposition: "duplicate" }],
        remoteCursor: "signed_cursor_after_push",
        serverTime: NOW,
      });

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "offline",
      outgoing: { claimed: 1, retried: 1, acknowledged: 0 },
    });
    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      outgoing: { claimed: 1, pushed: 1, acknowledged: 1 },
    });

    expect(fixture.api.pushSync).toHaveBeenCalledTimes(2);
    const firstIdempotencyKey = fixture.api.pushSync.mock.calls[0]?.[2]?.idempotencyKey;
    const secondIdempotencyKey = fixture.api.pushSync.mock.calls[1]?.[2]?.idempotencyKey;
    expect(firstIdempotencyKey).toMatch(/^sync\.[0-9a-f]{64}$/u);
    expect(secondIdempotencyKey).toMatch(/^sync\.[0-9a-f]{64}$/u);
    expect(secondIdempotencyKey).not.toBe(firstIdempotencyKey);
    const firstRequest = fixture.api.pushSync.mock.calls[0]?.[1];
    const secondRequest = fixture.api.pushSync.mock.calls[1]?.[1];
    expect(firstRequest?.baseCursor).toBe("signed_cursor_before_first_push");
    expect(secondRequest?.baseCursor).toBe("signed_cursor_before_retry");
    expect(secondRequest?.operations).toEqual(firstRequest?.operations);
    expect(secondRequest?.chunks).toEqual(firstRequest?.chunks);
    expect(secondRequest?.tombstones).toEqual(firstRequest?.tombstones);
    expect(fixture.store.rescheduleFailure).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      leaseToken: LEASE_IDS[1],
      failureCode: "CLOUD_NETWORK_UNAVAILABLE",
      now: NOW,
      nextAttemptAt: "2026-07-27T00:00:01.000Z",
    });
    expect(fencedPushMock(fixture.projectionPushAuthority)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        leaseToken: LEASE_IDS[3],
        requestBaseCursor: "signed_cursor_before_retry",
      }),
      expect.any(Function),
    );
    const serializedRequests = JSON.stringify([
      fixture.api.pushSync.mock.calls[0]?.[1] as unknown,
      fixture.api.pushSync.mock.calls[1]?.[1] as unknown,
    ]);
    expect(serializedRequests).not.toMatch(/accessToken|refreshToken|Authorization|projectKey/u);
    expect(serializedRequests).not.toContain("test offline");
  });

  it("revalidates the active account consent immediately before every push", async () => {
    const claimed = outgoingWork("upsert", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(claimed, command))),
        ),
    };
    const projectionPushAuthority = {
      evaluateProjectionOperationPushGate: vi.fn(),
      pushProjectionOperationFenced: vi.fn().mockResolvedValue({
        status: "blocked",
        reason: "not_enabled",
        registrationRevision: 4,
      }),
    };
    const fixture = createFixture({ projectOutbox, projectionPushAuthority });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      failure: { category: "permanent_paused", code: "SYNC_CONSENT_REVOKED" },
      outgoing: { claimed: 1, pushed: 0, paused: 1 },
    });
    expect(projectionPushAuthority.pushProjectionOperationFenced).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        operationId: OPERATION_ID,
        activeAccountId: ACCOUNT_ID,
        activeDeviceId: DEVICE_ID,
      }),
      expect.any(Function),
    );
    expect(fixture.api.pushSync).not.toHaveBeenCalled();
    expect(fixture.store.pauseFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        failureCode: "SYNC_CONSENT_REVOKED",
      }),
    );
  });

  it("reschedules a claimed operation when the settled boundary drifts before push", async () => {
    const claimed = outgoingWork("upsert", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(claimed, command))),
        ),
    };
    const projectionPushAuthority = {
      evaluateProjectionOperationPushGate: vi.fn(),
      pushProjectionOperationFenced: vi.fn().mockResolvedValue({
        status: "blocked",
        reason: "remote_checkpoint_mismatch",
        registrationRevision: 4,
      }),
    };
    const fixture = createFixture({ projectOutbox, projectionPushAuthority });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "retryable",
      failure: {
        category: "retryable",
        code: "SYNC_PUSH_REMOTE_BOUNDARY_CHANGED",
      },
      outgoing: { claimed: 1, pushed: 0, retried: 1, paused: 0 },
    });
    expect(fixture.api.pushSync).not.toHaveBeenCalled();
    expect(fixture.store.rescheduleFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        failureCode: "SYNC_PUSH_REMOTE_BOUNDARY_CHANGED",
      }),
    );
    expect(fixture.store.pauseFailure).not.toHaveBeenCalled();
  });

  it("rolls back an expired-session push attempt and retries the same idempotent request", async () => {
    const claimed = outgoingWork("upsert", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(claimed, command))),
        )
        .mockResolvedValue(success(null)),
    };
    const session = {
      async runWithSession<Value>(
        operation: (status: ConfiguredCloudSessionStatus) => Promise<Value>,
      ): Promise<Value> {
        try {
          return await operation(configuredSessionStatus());
        } catch (cause: unknown) {
          if (cause instanceof CloudClientError && cause.code === "AUTH_SESSION_EXPIRED") {
            return operation(configuredSessionStatus());
          }
          throw cause;
        }
      },
    };
    const fixture = createFixture({ projectOutbox, session });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );
    fixture.api.pushSync
      .mockRejectedValueOnce(cloudError("AUTH_SESSION_EXPIRED", true))
      .mockResolvedValueOnce(pushResponse("signed_cursor_after_duplicate"));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      outgoing: { claimed: 1, pushed: 1, acknowledged: 1, retried: 0 },
    });
    expect(fixture.api.pushSync).toHaveBeenCalledTimes(2);
    expect(fixture.api.pushSync.mock.calls[0]?.[2]?.idempotencyKey).toBe(
      fixture.api.pushSync.mock.calls[1]?.[2]?.idempotencyKey,
    );
    expect(fencedPushMock(fixture.projectionPushAuthority)).toHaveBeenCalledTimes(2);
  });

  it("keeps every push in one cycle on the fixed settled base cursor", async () => {
    const first = outgoingWork("upsert", 1);
    const second = {
      ...outgoingWork("upsert", 1),
      operation: {
        ...operation(SECOND_OPERATION_ID, "upsert"),
        deviceSequence: 2,
      },
    };
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(first, command))),
        )
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(second, command))),
        )
        .mockResolvedValue(success(null)),
    };
    const fixture = createFixture({ projectOutbox });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );
    fixture.api.pullSync.mockResolvedValueOnce(pullResponse("settled_cycle_cursor", false));
    fixture.api.pushSync
      .mockResolvedValueOnce(pushResponse("server_cursor_after_first"))
      .mockResolvedValueOnce({
        ...pushResponse("server_cursor_after_second"),
        acceptedOperations: [{ operationId: SECOND_OPERATION_ID, disposition: "accepted" }],
      });

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      outgoing: { claimed: 2, pushed: 2, acknowledged: 2 },
    });
    expect(fixture.api.pushSync.mock.calls[0]?.[1].baseCursor).toBe("settled_cycle_cursor");
    expect(fixture.api.pushSync.mock.calls[1]?.[1].baseCursor).toBe("settled_cycle_cursor");
  });

  it("pushes the exact generation-one tombstone even when generation two also exists", async () => {
    const claimed = outgoingWork("delete", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(
            success({
              ...claimed,
              leaseOwnerId: command.ownerId,
              leaseToken: command.leaseToken,
              leaseExpiresAt: command.leaseExpiresAt,
            }),
          ),
        )
        .mockResolvedValue(success(null)),
    };
    const fixture = createFixture({ projectOutbox });
    const generationOne = {
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 1,
      deletedByDeviceId: DEVICE_ID,
      vector: { [DEVICE_ID]: 1 },
      deletedAt: NOW,
      retainUntil: "2027-07-27T00:00:00.000Z",
      acknowledgedDeviceIds: [],
    } as const;
    const generationTwo = {
      ...generationOne,
      objectGeneration: 2,
      vector: { [DEVICE_ID]: 2 },
    } as const;
    fixture.store.findTombstone.mockImplementation(
      (_projectId: string, _objectType: string, _objectId: string, objectGeneration: number) =>
        Promise.resolve(success(objectGeneration === 1 ? generationOne : generationTwo)),
    );
    fixture.api.pushSync.mockResolvedValueOnce({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      requestId: REQUEST_ID,
      acceptedOperations: [{ operationId: OPERATION_ID, disposition: "accepted" }],
      remoteCursor: "signed_cursor_after_delete",
      serverTime: NOW,
    });

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      outgoing: { pushed: 1, acknowledged: 1 },
    });
    expect(fixture.api.pushSync.mock.calls[0]?.[1]).toMatchObject({
      operations: [{ operationId: OPERATION_ID, kind: "delete" }],
      chunks: [],
      tombstones: [
        {
          projectId: PROJECT_ID,
          objectId: OBJECT_ID,
          objectGeneration: 1,
        },
      ],
    });
    expect(fixture.store.findTombstone).toHaveBeenCalledWith(
      PROJECT_ID,
      "chapter_version",
      OBJECT_ID,
      1,
    );
  });

  it("stops the project push immediately when the head device sequence fails", async () => {
    const first = outgoingWork("upsert", 1);
    const second = {
      ...outgoingWork("upsert", 1),
      operation: {
        ...operation(SECOND_OPERATION_ID, "upsert"),
        deviceSequence: 2,
      },
    };
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(first, command))),
        )
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(second, command))),
        ),
    };
    const fixture = createFixture({ projectOutbox });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );
    fixture.api.pushSync.mockRejectedValueOnce(cloudError("SERVICE_UNAVAILABLE", true));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "retryable",
      failure: { category: "retryable", code: "SERVICE_UNAVAILABLE" },
      outgoing: { claimed: 1, retried: 1, pushed: 0 },
    });
    expect(projectOutbox.claimNextForProject).toHaveBeenCalledTimes(1);
    expect(fixture.api.pushSync).toHaveBeenCalledTimes(1);
  });

  it("rejects an outbox claim created by a different authenticated device", async () => {
    const claimed = {
      ...outgoingWork("delete", 1),
      operation: { ...operation(OPERATION_ID, "delete"), deviceId: OLD_DEVICE_ID },
    };
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(claimed, command))),
        ),
    };
    const fixture = createFixture({ projectOutbox });

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      failure: {
        category: "permanent_paused",
        code: "OUTBOX_PROJECT_OR_DEVICE_SCOPE_MISMATCH",
      },
    });
    expect(projectOutbox.claimNextForProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID, deviceId: DEVICE_ID }),
    );
    expect(fixture.api.pushSync).not.toHaveBeenCalled();
    expect(fixture.store.pauseFailure).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      leaseToken: LEASE_IDS[1],
      failureCode: "OUTBOX_PROJECT_SCOPE_MISMATCH",
      now: NOW,
    });
    expect(fixture.store.rescheduleFailure).not.toHaveBeenCalled();
  });

  it("parks a permanent cloud rejection instead of scheduling an infinite retry", async () => {
    const claimed = outgoingWork("upsert", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(claimed, command))),
        ),
    };
    const fixture = createFixture({ projectOutbox });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );
    fixture.api.pushSync.mockRejectedValueOnce(cloudError("SYNC_INVALID_CIPHERTEXT", false));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      failure: {
        category: "permanent_paused",
        code: "SYNC_INVALID_CIPHERTEXT",
      },
      outgoing: { paused: 1, retried: 0 },
    });
    expect(fixture.store.pauseFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID,
        failureCode: "SYNC_INVALID_CIPHERTEXT",
      }),
    );
    expect(fixture.store.rescheduleFailure).not.toHaveBeenCalled();
  });

  it("does not acknowledge a push response for a different operation", async () => {
    const claimed = outgoingWork("upsert", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(claimed, command))),
        ),
    };
    const fixture = createFixture({ projectOutbox });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );
    fixture.api.pushSync.mockResolvedValueOnce({
      ...pushResponse("signed_cursor_mismatched"),
      acceptedOperations: [{ operationId: SECOND_OPERATION_ID, disposition: "accepted" }],
    });

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "permanent_paused",
      failure: {
        category: "permanent_paused",
        code: "SYNC_PUSH_RESPONSE_MISMATCH",
      },
      outgoing: { pushed: 0, acknowledged: 0, paused: 1 },
    });
    expect(fixture.store.pauseFailure).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "SYNC_PUSH_RESPONSE_MISMATCH" }),
    );
  });

  it("derives the same idempotency key when the exact request is reclaimed", async () => {
    const claimed = outgoingWork("upsert", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(claimed, command))),
        )
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease({ ...claimed, attempt: 2 }, command))),
        )
        .mockResolvedValue(success(null)),
    };
    const fixture = createFixture({ projectOutbox });
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );
    fixture.api.pullSync.mockResolvedValue(pullResponse("signed_cursor_stable", false));
    fixture.api.pushSync
      .mockRejectedValueOnce(cloudError("CLOUD_NETWORK_UNAVAILABLE", true))
      .mockResolvedValueOnce(pushResponse("signed_cursor_after_push"));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "offline",
    });
    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
    });

    const firstKey = fixture.api.pushSync.mock.calls[0]?.[2]?.idempotencyKey;
    const secondKey = fixture.api.pushSync.mock.calls[1]?.[2]?.idempotencyKey;
    expect(firstKey).toMatch(/^sync\.[0-9a-f]{64}$/u);
    expect(secondKey).toBe(firstKey);
  });

  it("keeps the default lease safely beyond the native request timeout", async () => {
    const claimed = outgoingWork("upsert", 1);
    const projectOutbox = {
      claimNextForProject: vi
        .fn()
        .mockImplementationOnce((command: ClaimProjectSyncOperationCommand) =>
          Promise.resolve(success(withOutgoingLease(claimed, command))),
        )
        .mockResolvedValue(success(null)),
    };
    const fixture = createFixture({ projectOutbox });
    fixture.clockNow
      .mockReset()
      .mockReturnValue(NOW)
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce("2026-07-27T00:00:01.000Z")
      .mockReturnValueOnce("2026-07-27T00:00:32.000Z");
    fixture.store.getEncryptedChunk.mockResolvedValue(
      success({ chunkId: CHUNK_ID, encrypted: encryptedChunk(), createdAt: NOW }),
    );
    fixture.api.pushSync.mockResolvedValueOnce(pushResponse("signed_cursor_after_slow_push"));

    await expect(fixture.orchestrator.runProjectCycle(PROJECT_ID)).resolves.toMatchObject({
      state: "idle",
      outgoing: { acknowledged: 1 },
    });
    expect(projectOutbox.claimNextForProject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        now: "2026-07-27T00:00:01.000Z",
        leaseExpiresAt: "2026-07-27T00:01:31.000Z",
      }),
    );
    const fenceInput = fencedPushMock(fixture.projectionPushAuthority).mock.calls[0]?.[0] as
      ProjectionOperationPushFenceInput | undefined;
    expect(fenceInput).toMatchObject({
      operationId: OPERATION_ID,
      authorizedAt: "2026-07-27T00:00:32.000Z",
    });
    expect(fenceInput?.readAcknowledgedAt).toEqual(expect.any(Function));
  });

  it("retries a retryable continuous-cycle failure instead of terminating the worker", async () => {
    const fixture = createFixture({
      limits: { retryBaseMs: 100, retryMaximumMs: 100 },
    });
    fixture.api.pullSync
      .mockRejectedValueOnce(cloudError("SERVICE_UNAVAILABLE", true))
      .mockResolvedValueOnce(pullResponse("signed_cursor_recovered", false));
    const controller = new AbortController();
    const states: string[] = [];

    await fixture.orchestrator.runProjectContinuously(PROJECT_ID, {
      signal: controller.signal,
      intervalMs: 250,
      onCycle(result) {
        states.push(result.state);
        if (states.length === 2) {
          controller.abort();
        }
      },
    });

    expect(states).toEqual(["retryable", "boundary_blocked"]);
    expect(fixture.api.pullSync).toHaveBeenCalledTimes(2);
  });

  it("reports an expired cursor as bootstrap-required and stops continuous sync", async () => {
    const fixture = createFixture();
    fixture.api.pullSync.mockRejectedValue(cloudError("SYNC_CURSOR_EXPIRED", true));
    const states: string[] = [];

    await fixture.orchestrator.runProjectContinuously(PROJECT_ID, {
      intervalMs: 250,
      onCycle(result) {
        states.push(result.state);
      },
    });

    expect(states).toEqual(["bootstrap_required"]);
    expect(fixture.api.pullSync).toHaveBeenCalledTimes(1);
  });
});

function createFixture(
  overrides: Partial<
    Pick<
      CloudSyncOrchestratorDependencies<TestPreparedIncoming>,
      | "applyPreparedIncoming"
      | "enabled"
      | "incrementalSettlement"
      | "limits"
      | "prepareIncoming"
      | "projectionPushAuthority"
      | "projectOutbox"
      | "session"
    >
  > = {},
) {
  const transaction = {
    select: vi.fn(),
    execute: vi.fn(),
  } as unknown as TransactionExecutor;
  const store = {
    claimNextIncoming: vi.fn().mockResolvedValue(success(null)),
    findTombstone: vi.fn().mockResolvedValue(success(null)),
    getEncryptedChunk: vi.fn().mockResolvedValue(success(null)),
    markIncomingFailure: vi.fn().mockResolvedValue(success(undefined)),
    pauseFailure: vi.fn().mockResolvedValue(success(undefined)),
    readProjectSyncBlockingState: vi.fn().mockResolvedValue(
      success({
        projectId: PROJECT_ID,
        incomingConflictCount: 0,
        incomingPendingCount: 0,
        incomingPausedCount: 0,
        incomingAttemptExhaustedCount: 0,
        outgoingPendingCount: 0,
        outgoingPausedCount: 0,
        outgoingAttemptExhaustedCount: 0,
      }),
    ),
    readRemoteCheckpoint: vi.fn().mockResolvedValue(
      success({
        projectId: PROJECT_ID,
        signedRemoteCursor: null,
        revision: 0,
        updatedAt: null,
      }),
    ),
    resolveClaimedIncomingAtomically: vi.fn(
      async (
        command: {
          readonly operationId: string;
          readonly leaseToken: string;
          readonly now: string;
        },
        apply: (
          transaction: TransactionExecutor,
          work: ClaimedIncomingSyncWork,
        ) => Promise<
          Readonly<{ status: "applied" }> | Readonly<{ status: "conflict"; conflictCode: string }>
        >,
      ) => {
        try {
          const result = await apply(
            transaction,
            incomingWork(
              command.operationId,
              1,
              OWNER_ID,
              command.leaseToken,
              "2026-07-27T00:01:30.000Z",
            ),
          );
          return success({
            operationId: command.operationId,
            status: result.status,
            conflictCode: result.status === "conflict" ? result.conflictCode : null,
            replayed: false,
          });
        } catch (cause: unknown) {
          if (cause instanceof AppError) {
            return { ok: false as const, error: cause };
          }
          throw cause;
        }
      },
    ),
    rescheduleFailure: vi.fn().mockResolvedValue(success(undefined)),
    stageIncomingSyncBatch: vi.fn(
      (command: {
        readonly projectId: string;
        readonly response: CloudSyncPullResponse;
        readonly receivedAt: string;
      }) =>
        Promise.resolve(
          success({
            batchId: "019f9f4a-b3c7-7350-9226-000000000015",
            created: true,
            operationCount: command.response.operations.length,
            chunkCount: command.response.chunks.length,
            tombstoneCount: command.response.tombstones.length,
            checkpoint: {
              projectId: command.projectId,
              signedRemoteCursor: command.response.nextCursor,
              revision: 1,
              updatedAt: command.receivedAt,
            },
          }),
        ),
    ),
  };
  const api = {
    pullSync: vi
      .fn<InkShadowCloudApiClient["pullSync"]>()
      .mockResolvedValue(pullResponse("signed_cursor_1", false)),
    pushSync: vi.fn<InkShadowCloudApiClient["pushSync"]>(),
  };
  const session =
    overrides.session ??
    ({
      runWithSession: vi.fn(
        (operation: (status: ConfiguredCloudSessionStatus) => Promise<unknown>) =>
          operation(configuredSessionStatus()),
      ),
    } as CloudSyncOrchestratorDependencies<TestPreparedIncoming>["session"]);
  const projectionPushAuthority = overrides.projectionPushAuthority ?? {
    evaluateProjectionOperationPushGate: vi
      .fn()
      .mockResolvedValue(success({ allowed: true, reason: "allowed", registrationRevision: 1 })),
    pushProjectionOperationFenced: vi.fn(
      async (
        input: ProjectionOperationPushFenceInput,
        push: () => Promise<ProjectionOperationPushNetworkResponse>,
      ): Promise<ProjectionOperationPushFenceResult> => {
        const response = await push();
        if (
          response.acceptedOperations.length !== 1 ||
          response.acceptedOperations[0]?.operationId !== input.operationId
        ) {
          throw new ProjectionOperationPushResponseMismatchError();
        }
        return {
          status: "pushed" as const,
          response,
          registrationRevision: 1,
        };
      },
    ),
  };
  const incrementalSettlement = overrides.incrementalSettlement ?? {
    settleProjectIncremental: vi.fn(
      (input: {
        readonly projectId: string;
        readonly signedRemoteCursor: string;
        readonly downloadedCheckpointRevision: number;
      }) =>
        Promise.resolve({
          projectId: input.projectId,
          state: "ready" as const,
          pushAllowed: true,
          checkpoint: {
            projectId: input.projectId,
            signedRemoteCursor: input.signedRemoteCursor,
            downloadedCheckpointRevision: input.downloadedCheckpointRevision,
            revision: 1,
            updatedAt: NOW,
          },
          checkpointAdvanced: true,
          registrationEnabled: true,
          seededJobs: 0,
          skippedSeedJobs: 0,
          failure: null,
        }),
    ),
  };
  const clockNow = vi.fn().mockReturnValue(NOW);
  const clock = { now: clockNow } as unknown as Clock;
  let leaseIndex = 0;
  const ids = {
    next: vi.fn(() => {
      const next = LEASE_IDS[leaseIndex % LEASE_IDS.length];
      leaseIndex += 1;
      if (next === undefined) {
        throw new Error("The deterministic lease fixture is exhausted.");
      }
      return next;
    }),
  } as unknown as UuidV7Generator;
  const prepareIncoming =
    overrides.prepareIncoming ??
    vi.fn((work: ClaimedIncomingSyncWork) =>
      Promise.resolve({
        operationId: work.operation.operationId,
        fingerprint: `prepared:${work.operation.operationId}`,
      }),
    );
  const applyPreparedIncoming =
    overrides.applyPreparedIncoming ??
    vi.fn(
      (
        _transaction: TransactionExecutor,
        work: ClaimedIncomingSyncWork,
        prepared: TestPreparedIncoming,
      ) =>
        Promise.resolve(
          prepared.operationId === work.operation.operationId
            ? ({ status: "applied" } as const)
            : ({ status: "retry", code: "TEST_PREPARED_WORK_MISMATCH" } as const),
        ),
    );
  const orchestrator = new CloudSyncOrchestrator({
    enabled: overrides.enabled ?? true,
    api: api as unknown as InkShadowCloudApiClient,
    session,
    store,
    prepareIncoming,
    applyPreparedIncoming,
    clock,
    ids,
    ownerId: OWNER_ID,
    activeDeviceId: DEVICE_ID,
    projectionPushAuthority,
    incrementalSettlement,
    ...(overrides.projectOutbox === undefined ? {} : { projectOutbox: overrides.projectOutbox }),
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
  });
  return {
    orchestrator,
    store,
    api,
    session,
    projectionPushAuthority,
    incrementalSettlement,
    clock,
    clockNow,
    ids,
    transaction,
    prepareIncoming,
    applyPreparedIncoming,
  };
}

function pullResponse(nextCursor: string, hasMore: boolean): CloudSyncPullResponse {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    operations: [],
    chunks: [],
    tombstones: [],
    nextCursor,
    hasMore,
  };
}

function fencedPushMock(authority: ProjectionOperationPushAuthority): ReturnType<typeof vi.fn> {
  return Reflect.get(authority, "pushProjectionOperationFenced") as ReturnType<typeof vi.fn>;
}

function incomingWork(
  operationId: string,
  attempt: number,
  ownerId: string,
  leaseToken: string,
  leaseExpiresAt: string,
): ClaimedIncomingSyncWork {
  return {
    operation: operation(operationId, "delete"),
    chunks: [],
    tombstone: {
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      objectGeneration: 1,
      deletedByDeviceId: DEVICE_ID,
      vector: { [DEVICE_ID]: 1 },
      deletedAt: NOW,
      retainUntil: "2027-07-27T00:00:00.000Z",
      acknowledgedDeviceIds: [],
    },
    status: "applying",
    attempt,
    nextAttemptAt: null,
    failureCode: null,
    conflictCode: null,
    resolvedAt: null,
    leaseOwnerId: ownerId,
    leaseToken,
    leaseExpiresAt,
  };
}

function outgoingWork(kind: "delete" | "upsert", attempt: number): ClaimedSyncOperation {
  return {
    operation: operation(OPERATION_ID, kind),
    status: "in_flight",
    attempt,
    nextAttemptAt: null,
    failureCode: null,
    acknowledgedAt: null,
    leaseOwnerId: OWNER_ID,
    leaseToken: LEASE_IDS[0],
    leaseExpiresAt: "2026-07-27T00:00:30.000Z",
  };
}

function withOutgoingLease(
  claimed: ClaimedSyncOperation,
  command: ClaimProjectSyncOperationCommand,
): ClaimedSyncOperation {
  return {
    ...claimed,
    leaseOwnerId: command.ownerId,
    leaseToken: command.leaseToken,
    leaseExpiresAt: command.leaseExpiresAt,
  };
}

function cloudError(code: CloudClientError["code"], retryable: boolean): CloudClientError {
  return new CloudClientError({
    code,
    message: "test cloud failure",
    status: null,
    requestId: REQUEST_ID,
    retryable,
  });
}

function pushResponse(remoteCursor: string) {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    requestId: REQUEST_ID,
    acceptedOperations: [{ operationId: OPERATION_ID, disposition: "accepted" as const }],
    remoteCursor,
    serverTime: NOW,
  };
}

function operation(
  operationId: string,
  kind: "delete" | "upsert",
): ClaimedSyncOperation["operation"] {
  return {
    operationId,
    projectId: PROJECT_ID,
    deviceId: DEVICE_ID,
    deviceSequence: 1,
    objectType: "chapter_version",
    objectId: OBJECT_ID,
    objectGeneration: 1,
    kind,
    vector: { [DEVICE_ID]: 1 },
    encryptedChunkIds: kind === "upsert" ? [CHUNK_ID] : [],
    createdAt: NOW,
  };
}

function encryptedChunk(): EncryptedSyncChunkContract {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    algorithm: "AES-256-GCM",
    nonce: "A".repeat(16),
    ciphertext: "B".repeat(32),
    ciphertextSha256: "a".repeat(64),
    plaintextBytes: 16,
    aad: {
      projectId: PROJECT_ID,
      objectType: "chapter_version",
      objectId: OBJECT_ID,
      versionId: VERSION_ID,
      chunkIndex: 0,
      keyVersion: 1,
    },
  };
}

function success<T>(value: T): Readonly<{ ok: true; value: T }> {
  return { ok: true, value };
}

function configuredSessionStatus(): ConfiguredCloudSessionStatus {
  return {
    configured: true,
    account: { accountId: ACCOUNT_ID },
    device: { device: { deviceId: DEVICE_ID } },
    session: {},
    expiry: {},
  } as unknown as ConfiguredCloudSessionStatus;
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}
