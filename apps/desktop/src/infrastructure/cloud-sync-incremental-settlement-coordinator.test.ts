import type {
  ProjectSyncRegistration,
  SyncIncrementalSettlementResult,
  SyncMaterializedCheckpoint,
  TransactionExecutor,
} from "@inkshadow/data";
import { ok, type IsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import {
  CloudSyncIncrementalSettlementCoordinator,
  type CloudSyncIncrementalAtomicAuthority,
  type CloudSyncIncrementalSettlementAuthority,
  type CloudSyncIncrementalSettlementPersistence,
} from "./cloud-sync-incremental-settlement-coordinator";
import type { CloudSyncInitialProjectionSeederPort } from "./cloud-sync-snapshot-materialization-coordinator";

const PROJECT_ID = "019fa104-0000-7000-8000-000000000001";
const ACCOUNT_ID = "019fa104-0000-7000-8000-000000000002";
const DEVICE_ID = "019fa104-0000-7000-8000-000000000003";
const CURSOR = "incremental_cursor_runtime_1";
const NOW = "2026-07-28T04:00:00.000Z";

describe("CloudSyncIncrementalSettlementCoordinator", () => {
  it("is default-off and performs no authority or persistence work", async () => {
    const fixture = createFixture();
    const coordinator = new CloudSyncIncrementalSettlementCoordinator({
      store: fixture.store,
      authority: fixture.authority,
      seeder: fixture.seeder,
      clock: fixture.clock,
      atomicAuthority: fixture.atomicAuthority,
    });

    await expect(coordinator.settleProjectIncremental(input())).resolves.toMatchObject({
      state: "disabled",
      pushAllowed: false,
    });
    expect(fixture.loadRegistration).not.toHaveBeenCalled();
    expect(fixture.settleAtomically).not.toHaveBeenCalled();
  });

  it("atomically advances plaintext state, enables registration, and seeds local history", async () => {
    const fixture = createFixture();
    const coordinator = fixture.coordinator();

    const result = await coordinator.settleProjectIncremental(input());

    expect(result).toMatchObject({
      state: "ready",
      pushAllowed: true,
      checkpointAdvanced: true,
      registrationEnabled: true,
      seededJobs: 2,
      skippedSeedJobs: 1,
      checkpoint: { signedRemoteCursor: CURSOR, revision: 1 },
    });
    expect(fixture.transitionRegistration).toHaveBeenCalledWith(
      fixture.transaction,
      expect.objectContaining({
        projectId: PROJECT_ID,
        expectedAccountId: ACCOUNT_ID,
        expectedDeviceId: DEVICE_ID,
        expectedRevision: 1,
        target: { state: "enabled" },
      }),
    );
    expect(fixture.seed).toHaveBeenCalledWith(
      fixture.transaction,
      expect.objectContaining({ state: "enabled", plaintextBootstrapCompleted: true }),
      NOW,
    );
  });

  it("advances an enabled project without reseeding its local history", async () => {
    const fixture = createFixture({
      registration: registration({
        state: "enabled",
        revision: 4,
        plaintextBootstrapCompleted: true,
        enabledAt: NOW,
      }),
      previousCheckpoint: checkpoint({ revision: 2 }),
      settledCheckpoint: checkpoint({
        downloadedCheckpointRevision: 2,
        revision: 3,
      }),
    });
    const coordinator = fixture.coordinator();

    await expect(
      coordinator.settleProjectIncremental(input({ downloadedCheckpointRevision: 2 })),
    ).resolves.toMatchObject({
      state: "ready",
      pushAllowed: true,
      checkpointAdvanced: true,
      registrationEnabled: true,
      seededJobs: 0,
    });
    expect(fixture.transitionRegistration).not.toHaveBeenCalled();
    expect(fixture.seed).not.toHaveBeenCalled();
  });

  it("maps unresolved incoming plaintext to a fail-closed retryable boundary", async () => {
    const fixture = createFixture({
      settlement: {
        status: "blocked",
        reason: "incoming_pending",
        target: {
          projectId: PROJECT_ID,
          signedRemoteCursor: CURSOR,
          downloadedCheckpointRevision: 1,
          downloadedAt: NOW,
          settledAt: NOW,
        },
        counts: {
          snapshotPendingCount: 0,
          incomingPendingCount: 1,
          incomingPermanentFailureCount: 0,
          incomingAttemptExhaustedCount: 0,
          incomingConflictCount: 0,
          unresolvedContentConflictCount: 0,
        },
        checkpoint: null,
        checkpointAdvanced: false,
      },
    });

    await expect(fixture.coordinator().settleProjectIncremental(input())).resolves.toMatchObject({
      state: "retryable",
      pushAllowed: false,
      failure: {
        category: "retryable",
        code: "SYNC_INCOMING_MATERIALIZATION_PENDING",
      },
    });
    expect(fixture.transitionRegistration).not.toHaveBeenCalled();
    expect(fixture.seed).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "incoming_permanent_failure" as const,
      counts: {
        snapshotPendingCount: 0,
        incomingPendingCount: 0,
        incomingPermanentFailureCount: 1,
        incomingAttemptExhaustedCount: 0,
        incomingConflictCount: 0,
        unresolvedContentConflictCount: 0,
      },
      code: "SYNC_INCOMING_MATERIALIZATION_PERMANENT_FAILURE",
    },
    {
      reason: "incoming_attempt_exhausted" as const,
      counts: {
        snapshotPendingCount: 0,
        incomingPendingCount: 0,
        incomingPermanentFailureCount: 0,
        incomingAttemptExhaustedCount: 1,
        incomingConflictCount: 0,
        unresolvedContentConflictCount: 0,
      },
      code: "SYNC_INCOMING_ATTEMPT_BUDGET_EXHAUSTED",
    },
  ])("maps $reason to a fail-closed permanent pause", async ({ reason, counts, code }) => {
    const fixture = createFixture({
      settlement: {
        status: "blocked",
        reason,
        target: {
          projectId: PROJECT_ID,
          signedRemoteCursor: CURSOR,
          downloadedCheckpointRevision: 1,
          downloadedAt: NOW,
          settledAt: NOW,
        },
        counts,
        checkpoint: null,
        checkpointAdvanced: false,
      },
    });

    await expect(fixture.coordinator().settleProjectIncremental(input())).resolves.toMatchObject({
      state: "permanent_paused",
      pushAllowed: false,
      checkpoint: null,
      failure: { category: "permanent_paused", code },
    });
    expect(fixture.transitionRegistration).not.toHaveBeenCalled();
    expect(fixture.seed).not.toHaveBeenCalled();
  });

  it("rejects a changed signed-in account before touching checkpoint state", async () => {
    const fixture = createFixture();

    await expect(
      fixture
        .coordinator()
        .settleProjectIncremental(
          input({ activeAccountId: "019fa104-0000-7000-8000-000000000099" }),
        ),
    ).resolves.toMatchObject({
      state: "auth_blocked",
      pushAllowed: false,
      failure: { code: "SYNC_SESSION_AUTHORITY_MISMATCH" },
    });
    expect(fixture.loadCheckpoint).not.toHaveBeenCalled();
    expect(fixture.settleAtomically).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent settlement attempts for the same project", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = createFixture({ settlementGate: gate });
    const coordinator = fixture.coordinator();

    const first = coordinator.settleProjectIncremental(input());
    const second = coordinator.settleProjectIncremental(input());
    expect(second).toBe(first);
    release?.();

    await expect(first).resolves.toMatchObject({ state: "ready" });
    expect(fixture.settleAtomically).toHaveBeenCalledOnce();
  });
});

function createFixture(
  options: Readonly<{
    registration?: ProjectSyncRegistration;
    previousCheckpoint?: SyncMaterializedCheckpoint | null;
    settledCheckpoint?: SyncMaterializedCheckpoint;
    settlement?: SyncIncrementalSettlementResult;
    settlementGate?: Promise<void>;
  }> = {},
) {
  const currentRegistration = options.registration ?? registration();
  const previousCheckpoint = options.previousCheckpoint ?? null;
  const settledCheckpoint = options.settledCheckpoint ?? checkpoint();
  const transaction = {} as TransactionExecutor;
  const loadRegistration = vi.fn(() => Promise.resolve(ok(currentRegistration)));
  const loadCheckpoint = vi.fn(() => Promise.resolve(ok(previousCheckpoint)));
  const loadRegistrationInTransaction = vi.fn(() => Promise.resolve(ok(currentRegistration)));
  const enabledRegistration = registration({
    ...currentRegistration,
    state: "enabled",
    revision: currentRegistration.revision + 1,
    plaintextBootstrapCompleted: true,
    enabledAt: NOW,
  });
  const transitionRegistration = vi.fn(() => Promise.resolve(ok(enabledRegistration)));
  const seed = vi.fn(() =>
    Promise.resolve({
      projectId: PROJECT_ID,
      enqueuedJobIds: ["job-1", "job-2"],
      skippedJobIds: ["job-3"],
    }),
  );
  const defaultSettlement: SyncIncrementalSettlementResult = {
    status: "settled",
    reason: "advanced",
    target: {
      projectId: PROJECT_ID,
      signedRemoteCursor: CURSOR,
      downloadedCheckpointRevision: settledCheckpoint.downloadedCheckpointRevision,
      downloadedAt: NOW,
      settledAt: NOW,
    },
    counts: {
      snapshotPendingCount: 0,
      incomingPendingCount: 0,
      incomingPermanentFailureCount: 0,
      incomingAttemptExhaustedCount: 0,
      incomingConflictCount: 0,
      unresolvedContentConflictCount: 0,
    },
    checkpoint: settledCheckpoint,
    checkpointAdvanced: true,
  };
  const settleAtomically = vi.fn(
    async (
      _input: unknown,
      finalizer: (
        transaction: TransactionExecutor,
        context: {
          target: typeof defaultSettlement.target;
          checkpoint: SyncMaterializedCheckpoint;
          checkpointAdvanced: boolean;
        },
      ) => Promise<void> | void,
    ) => {
      await options.settlementGate;
      const settlement = options.settlement ?? defaultSettlement;
      if (settlement.status === "settled") {
        await finalizer(transaction, {
          target: settlement.target,
          checkpoint: settlement.checkpoint,
          checkpointAdvanced: settlement.checkpointAdvanced,
        });
      }
      return ok(settlement);
    },
  );

  const store = { settleAtomically } as unknown as CloudSyncIncrementalSettlementPersistence;
  const authority = {
    loadProjectSyncRegistration: loadRegistration,
    loadMaterializedCheckpoint: loadCheckpoint,
  } as unknown as CloudSyncIncrementalSettlementAuthority;
  const atomicAuthority = {
    loadRegistrationInTransaction,
    transitionRegistrationInTransaction: transitionRegistration,
  } as unknown as CloudSyncIncrementalAtomicAuthority;
  const seeder = {
    seedProjectInTransaction: seed,
  } as unknown as CloudSyncInitialProjectionSeederPort;
  const clock = { now: () => NOW as IsoUtcTimestamp };

  return {
    transaction,
    store,
    authority,
    atomicAuthority,
    seeder,
    clock,
    loadRegistration,
    loadCheckpoint,
    settleAtomically,
    transitionRegistration,
    seed,
    coordinator: () =>
      new CloudSyncIncrementalSettlementCoordinator({
        enabled: true,
        store,
        authority,
        seeder,
        clock,
        atomicAuthority,
      }),
  };
}

function registration(overrides: Partial<ProjectSyncRegistration> = {}): ProjectSyncRegistration {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    state: "enabling",
    consentRevision: 3,
    keyVersion: 7,
    revision: 1,
    plaintextBootstrapCompleted: false,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    enabledAt: null,
    pausedAt: null,
    ...overrides,
  };
}

function checkpoint(
  overrides: Partial<SyncMaterializedCheckpoint> = {},
): SyncMaterializedCheckpoint {
  return {
    projectId: PROJECT_ID,
    signedRemoteCursor: CURSOR,
    downloadedCheckpointRevision: 1,
    revision: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

function input(
  overrides: Partial<{
    projectId: string;
    activeAccountId: string;
    activeDeviceId: string;
    signedRemoteCursor: string;
    downloadedCheckpointRevision: number;
  }> = {},
) {
  return {
    projectId: PROJECT_ID,
    activeAccountId: ACCOUNT_ID,
    activeDeviceId: DEVICE_ID,
    signedRemoteCursor: CURSOR,
    downloadedCheckpointRevision: 1,
    ...overrides,
  };
}
