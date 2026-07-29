import {
  type AdvanceSyncMaterializedCheckpointInput,
  type FinalizeSnapshotMaterializationResult,
  type ProjectSyncRegistration,
  type ResolveSnapshotMaterializationWorkInput,
  type ResolveSnapshotMaterializationWorkResult,
  type SnapshotMaterializationFinalizer,
  type SnapshotMaterializationIdentity,
  type SnapshotMaterializationReceipt,
  type SnapshotMaterializationResolver,
  type SnapshotMaterializationState,
  type SnapshotMaterializationTarget,
  type SnapshotMaterializationWork,
  type SyncMaterializedCheckpoint,
  type TransactionExecutor,
  type TransitionProjectSyncRegistrationInput,
} from "@inkshadow/data";
import { AppError, err, ok, type Clock, type Result } from "@inkshadow/domain";
import { SyncCoreError } from "@inkshadow/sync-core";
import { describe, expect, it, vi } from "vitest";

import {
  CloudSyncSnapshotMaterializationCoordinator,
  type CloudSyncInitialProjectionSeedResult,
  type CloudSyncSnapshotMaterializationAtomicAuthority,
  type CloudSyncSnapshotMaterializationCoordinatorDependencies,
} from "./cloud-sync-snapshot-materialization-coordinator";
import type { ContentSyncMaterializationOutcome } from "./content-sync-materializer";
import type { PreparedIncomingContentMutation } from "./incoming-content-decryptor";

const PROJECT_ID = "019fa001-0000-7000-8000-000000000001";
const ACCOUNT_ID = "019fa001-0000-7000-8000-000000000002";
const DEVICE_ID = "019fa001-0000-7000-8000-000000000003";
const SNAPSHOT_ID = "019fa001-0000-7000-8000-000000000004";
const FIRST_OPERATION_ID = "019fa001-0000-7000-8000-000000000005";
const SECOND_OPERATION_ID = "019fa001-0000-7000-8000-000000000006";
const FIRST_OBJECT_ID = "019fa001-0000-7000-8000-000000000007";
const SECOND_OBJECT_ID = "019fa001-0000-7000-8000-000000000008";
const NOW = "2026-07-28T02:00:00.000Z";
const COMMITTED_AT = "2026-07-28T01:00:00.000Z";
const CURSOR = "signed_snapshot_cursor";
const OLD_CURSOR = "signed_old_cursor";

describe("CloudSyncSnapshotMaterializationCoordinator", () => {
  it("is disabled by default and performs no persistence or plaintext work", async () => {
    const fixture = createFixture({ enabled: false, works: [work(0)] });

    await expect(
      fixture.coordinator.runProjectSnapshotMaterialization(identity()),
    ).resolves.toMatchObject({
      state: "disabled",
      pushAllowed: false,
      plaintextMaterializationRequired: false,
    });
    expect(fixture.authority.registrationReads).toBe(0);
    expect(fixture.snapshotStore.targetReads).toBe(0);
    expect(fixture.materializer.prepare).not.toHaveBeenCalled();
  });

  it("prepares outside transactions, preserves snapshot order, and records applied and skipped receipts", async () => {
    const fixture = createFixture({
      works: [work(0), work(1)],
      outcomes: [{ status: "applied" }, { status: "skipped" }],
      seedResult: {
        projectId: PROJECT_ID,
        enqueuedJobIds: ["seeded-project", "seeded-history"],
        skippedJobIds: ["existing-history"],
      },
    });

    const result = await fixture.coordinator.runProjectSnapshotMaterialization(identity());

    expect(result).toMatchObject({
      state: "plaintext_bootstrap_completed",
      completion: "finalized",
      pushAllowed: true,
      plaintextMaterializationRequired: false,
      attemptedWorkItems: 2,
      appliedReceipts: 1,
      skippedReceipts: 1,
      seededJobs: 2,
      skippedSeedJobs: 1,
    });
    expect(fixture.materializer.prepareOutsideTransaction).toEqual([true, true]);
    expect(
      fixture.shared.events.filter(
        (event) => event.startsWith("prepare:") || event.startsWith("apply:"),
      ),
    ).toEqual([
      `prepare:${FIRST_OPERATION_ID}`,
      `apply:${FIRST_OPERATION_ID}`,
      `prepare:${SECOND_OPERATION_ID}`,
      `apply:${SECOND_OPERATION_ID}`,
    ]);
    expect([...fixture.snapshotStore.receipts.values()].map((receipt) => receipt.outcome)).toEqual(
      [],
    );
    expect(fixture.snapshotStore.archivedReceiptOutcomes).toEqual(["applied", "skipped"]);
  });

  it("rolls a retry outcome back without writing a receipt", async () => {
    const fixture = createFixture({
      works: [work(0)],
      outcomes: [{ status: "retry", code: "SYNC_PARENT_VERSION_MISSING" }],
    });

    const result = await fixture.coordinator.runProjectSnapshotMaterialization(identity());

    expect(result).toMatchObject({
      state: "retryable",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
      failure: { category: "retryable", code: "SYNC_PARENT_VERSION_MISSING" },
    });
    expect(fixture.snapshotStore.receipts.size).toBe(0);
    expect(fixture.shared.businessMutations).toEqual([]);
    expect(fixture.snapshotStore.target).not.toBeNull();
  });

  it("commits conflict evidence with its receipt and blocks later operations", async () => {
    const fixture = createFixture({
      works: [work(0), work(1)],
      outcomes: [{ status: "conflict" }, { status: "applied" }],
    });

    const result = await fixture.coordinator.runProjectSnapshotMaterialization(identity());

    expect(result).toMatchObject({
      state: "conflict_blocked",
      conflictReceipts: 1,
      attemptedWorkItems: 1,
      failure: { category: "conflict_blocked", code: "SYNC_CONTENT_CONFLICT" },
    });
    expect(fixture.snapshotStore.receipts.get(FIRST_OPERATION_ID)).toMatchObject({
      outcome: "conflict",
      conflictCode: "SYNC_CONTENT_CONFLICT",
    });
    expect(fixture.materializer.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.snapshotStore.target).not.toBeNull();
  });

  it.each([
    [
      "authenticated ciphertext",
      new DOMException("Authentication failed.", "OperationError"),
      "SYNC_CHUNK_INTEGRITY_FAILED",
    ],
    [
      "canonical payload",
      new SyncCoreError("SYNC_VALIDATION_FAILED", "Payload is malformed."),
      "SYNC_VALIDATION_FAILED",
    ],
  ])("durably pauses a permanently damaged %s without a receipt", async (_label, cause, code) => {
    const fixture = createFixture({ works: [work(0)], prepareFailure: cause });

    const result = await fixture.coordinator.runProjectSnapshotMaterialization(identity());

    expect(result).toMatchObject({
      state: "permanent_paused",
      pushAllowed: false,
      plaintextMaterializationRequired: true,
      permanentPausePersisted: true,
      failure: { category: "permanent_paused", code },
    });
    expect(fixture.snapshotStore.receipts.size).toBe(0);
    expect(fixture.shared.registration).toMatchObject({
      state: "error",
      lastErrorCode: code,
      plaintextBootstrapCompleted: false,
    });
  });

  it("atomically finalizes an empty snapshot by checkpointing, enabling, seeding, and cleaning staging", async () => {
    const fixture = createFixture({
      works: [],
      seedResult: {
        projectId: PROJECT_ID,
        enqueuedJobIds: ["project", "chapter-v1", "chapter-v2"],
        skippedJobIds: [],
      },
    });

    const result = await fixture.coordinator.runProjectSnapshotMaterialization(identity());

    expect(result).toMatchObject({
      state: "plaintext_bootstrap_completed",
      completion: "finalized",
      seededJobs: 3,
    });
    expect(fixture.shared.events.filter((event) => event.startsWith("finalize:"))).toEqual([
      "finalize:checkpoint",
      "finalize:registration",
      "finalize:seed",
      "finalize:cleanup",
    ]);
    expect(fixture.shared.checkpoint).toMatchObject({
      signedRemoteCursor: CURSOR,
      downloadedCheckpointRevision: 9,
      revision: 3,
    });
    expect(fixture.shared.registration).toMatchObject({
      state: "enabled",
      plaintextBootstrapCompleted: true,
      revision: 8,
    });
    expect(fixture.shared.seededJobs).toEqual(["project", "chapter-v1", "chapter-v2"]);
    expect(fixture.snapshotStore.target).toBeNull();
  });

  it("rolls every finalizer mutation back after a crash and resumes on the next run", async () => {
    const fixture = createFixture({
      works: [],
      failAfterFinalizerOnce: true,
      seedResult: {
        projectId: PROJECT_ID,
        enqueuedJobIds: ["project"],
        skippedJobIds: [],
      },
    });

    await expect(
      fixture.coordinator.runProjectSnapshotMaterialization(identity()),
    ).resolves.toMatchObject({
      state: "retryable",
      pushAllowed: false,
      failure: { category: "retryable" },
    });
    expect(fixture.shared.registration).toMatchObject({
      state: "bootstrap_required",
      revision: 7,
    });
    expect(fixture.shared.checkpoint).toMatchObject({
      signedRemoteCursor: OLD_CURSOR,
      revision: 2,
    });
    expect(fixture.shared.seededJobs).toEqual([]);
    expect(fixture.snapshotStore.target).not.toBeNull();

    await expect(
      fixture.coordinator.runProjectSnapshotMaterialization(identity()),
    ).resolves.toMatchObject({
      state: "plaintext_bootstrap_completed",
      completion: "finalized",
      pushAllowed: true,
    });
    expect(fixture.snapshotStore.target).toBeNull();
    expect(fixture.shared.seededJobs).toEqual(["project"]);
  });

  it("treats an absent snapshot as idempotently complete only for an enabled plaintext registration", async () => {
    const fixture = createFixture({
      target: null,
      registration: enabledRegistration(),
    });

    await expect(
      fixture.coordinator.runProjectSnapshotMaterialization(identity()),
    ).resolves.toMatchObject({
      state: "plaintext_bootstrap_completed",
      completion: "already_completed",
      pushAllowed: true,
      plaintextMaterializationRequired: false,
    });
    expect(fixture.shared.events).not.toContain("finalize:seed");
  });

  it("fails closed and durably pauses when ciphertext staging is absent before plaintext completion", async () => {
    const fixture = createFixture({ target: null });

    await expect(
      fixture.coordinator.runProjectSnapshotMaterialization(identity()),
    ).resolves.toMatchObject({
      state: "permanent_paused",
      pushAllowed: false,
      permanentPausePersisted: true,
      failure: {
        category: "permanent_paused",
        code: "SYNC_COMMITTED_SNAPSHOT_MISSING",
      },
    });
    expect(fixture.shared.registration).toMatchObject({
      state: "error",
      lastErrorCode: "SYNC_COMMITTED_SNAPSHOT_MISSING",
    });
  });

  it("shares one per-project run while prepare is in flight", async () => {
    const deferred = createDeferred<undefined>();
    const fixture = createFixture({
      works: [work(0)],
      outcomes: [{ status: "applied" }],
      prepareGate: deferred.promise,
    });

    const first = fixture.coordinator.runProjectSnapshotMaterialization(identity());
    const second = fixture.coordinator.runProjectSnapshotMaterialization({
      ...identity(),
      snapshotId: "019fa001-0000-7000-8000-000000000099",
    });

    expect(second).toBe(first);
    await vi.waitFor(() => expect(fixture.materializer.prepare).toHaveBeenCalledTimes(1));
    deferred.resolve(undefined);
    await expect(first).resolves.toMatchObject({ state: "plaintext_bootstrap_completed" });
    expect(fixture.materializer.prepare).toHaveBeenCalledTimes(1);
  });

  it("honors AbortSignal before reads and after transaction-free prepare", async () => {
    const before = createFixture({ works: [work(0)] });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(
      before.coordinator.runProjectSnapshotMaterialization(identity(), {
        signal: alreadyAborted.signal,
      }),
    ).resolves.toMatchObject({ state: "aborted", pushAllowed: false });
    expect(before.authority.registrationReads).toBe(0);

    const during = new AbortController();
    const afterPrepare = createFixture({
      works: [work(0)],
      outcomes: [{ status: "applied" }],
      afterPrepare: () => during.abort(),
    });
    await expect(
      afterPrepare.coordinator.runProjectSnapshotMaterialization(identity(), {
        signal: during.signal,
      }),
    ).resolves.toMatchObject({
      state: "aborted",
      attemptedWorkItems: 1,
    });
    expect(afterPrepare.snapshotStore.receipts.size).toBe(0);
    expect(afterPrepare.materializer.applyPrepared).not.toHaveBeenCalled();
  });

  it("bounds each run without losing receipts and completes on a later run", async () => {
    const fixture = createFixture({
      works: [work(0), work(1)],
      outcomes: [{ status: "applied" }, { status: "skipped" }],
      maximumWorkItems: 1,
    });

    await expect(
      fixture.coordinator.runProjectSnapshotMaterialization(identity()),
    ).resolves.toMatchObject({
      state: "retryable",
      attemptedWorkItems: 1,
      appliedReceipts: 1,
      failure: {
        category: "retryable",
        code: "SYNC_SNAPSHOT_MATERIALIZATION_WORK_LIMIT_REACHED",
      },
    });
    expect(fixture.snapshotStore.receipts.size).toBe(1);

    await expect(
      fixture.coordinator.runProjectSnapshotMaterialization(identity()),
    ).resolves.toMatchObject({
      state: "plaintext_bootstrap_completed",
      attemptedWorkItems: 1,
      skippedReceipts: 1,
      pushAllowed: true,
    });
  });

  it("uses the frozen registration revision as the final CAS and leaves staging recoverable on change", async () => {
    const fixture = createFixture({
      works: [],
      onLoadCheckpoint: (shared) => {
        shared.registration = {
          ...shared.registration,
          revision: shared.registration.revision + 1,
          updatedAt: NOW,
        };
      },
    });

    await expect(
      fixture.coordinator.runProjectSnapshotMaterialization(identity()),
    ).resolves.toMatchObject({
      state: "retryable",
      pushAllowed: false,
      failure: {
        category: "retryable",
        code: "INVALID_STATE_TRANSITION",
      },
    });
    expect(fixture.shared.registration).toMatchObject({
      state: "bootstrap_required",
      revision: 8,
    });
    expect(fixture.shared.checkpoint).toMatchObject({
      signedRemoteCursor: OLD_CURSOR,
      revision: 2,
    });
    expect(fixture.snapshotStore.target).not.toBeNull();
    expect(fixture.shared.seededJobs).toEqual([]);
  });

  it("rejects invalid work limits at construction", () => {
    expect(() => createFixture({ maximumWorkItems: 0 })).toThrow(
      "maximumWorkItems must be between 1 and 4096",
    );
  });
});

interface SharedState {
  registration: ProjectSyncRegistration;
  checkpoint: SyncMaterializedCheckpoint | null;
  seededJobs: string[];
  businessMutations: string[];
  events: string[];
}

interface MaterializerDirective {
  readonly status: "applied" | "conflict" | "retry" | "skipped";
  readonly code?: string;
}

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly works?: readonly SnapshotMaterializationWork[];
  readonly outcomes?: readonly MaterializerDirective[];
  readonly prepareFailure?: Error;
  readonly prepareGate?: Promise<void>;
  readonly afterPrepare?: () => void;
  readonly target?: SnapshotMaterializationTarget | null;
  readonly registration?: ProjectSyncRegistration;
  readonly seedResult?: CloudSyncInitialProjectionSeedResult;
  readonly failAfterFinalizerOnce?: boolean;
  readonly maximumWorkItems?: number;
  readonly onLoadCheckpoint?: (shared: SharedState) => void;
}

function createFixture(options: FixtureOptions = {}) {
  const shared: SharedState = {
    registration: options.registration ?? bootstrapRegistration(),
    checkpoint: {
      projectId: PROJECT_ID,
      signedRemoteCursor: OLD_CURSOR,
      downloadedCheckpointRevision: 3,
      revision: 2,
      updatedAt: COMMITTED_AT,
    },
    seededJobs: [],
    businessMutations: [],
    events: [],
  };
  const snapshotStore = new FakeSnapshotStore(
    shared,
    options.works ?? [],
    options.target === undefined ? target() : options.target,
    options.failAfterFinalizerOnce ?? false,
  );
  const authority = new FakeAuthority(shared, options.onLoadCheckpoint);
  const atomicAuthority = createAtomicAuthority(shared, snapshotStore);
  const materializer = new FakeMaterializer(
    shared,
    snapshotStore,
    options.outcomes ?? [],
    options.prepareFailure,
    options.prepareGate,
    options.afterPrepare,
  );
  const seedResult = options.seedResult ?? {
    projectId: PROJECT_ID,
    enqueuedJobIds: [],
    skippedJobIds: [],
  };
  const seeder = {
    seedProjectInTransaction: vi.fn(
      (
        transaction: TransactionExecutor,
        enabled: ProjectSyncRegistration,
        seededAt: string,
      ): Promise<CloudSyncInitialProjectionSeedResult> => {
        void transaction;
        void seededAt;
        expect(snapshotStore.insideTransaction).toBe(true);
        shared.events.push("finalize:seed");
        if (
          enabled.state !== "enabled" ||
          !enabled.plaintextBootstrapCompleted ||
          shared.registration.revision !== enabled.revision
        ) {
          throw stateError("The enabled registration changed before seed.");
        }
        shared.seededJobs.push(...seedResult.enqueuedJobIds);
        return Promise.resolve(seedResult);
      },
    ),
  };
  const dependencies: CloudSyncSnapshotMaterializationCoordinatorDependencies = {
    enabled: options.enabled ?? true,
    snapshotStore,
    authority,
    materializer,
    seeder,
    clock: fixedClock(),
    atomicAuthority,
    ...(options.maximumWorkItems === undefined
      ? {}
      : { limits: { maximumWorkItems: options.maximumWorkItems } }),
  };
  return {
    shared,
    snapshotStore,
    authority,
    materializer,
    seeder,
    coordinator: new CloudSyncSnapshotMaterializationCoordinator(dependencies),
  };
}

class FakeSnapshotStore {
  public readonly receipts = new Map<string, SnapshotMaterializationReceipt>();
  public readonly archivedReceiptOutcomes: string[] = [];
  public insideTransaction = false;
  public targetReads = 0;
  public target: SnapshotMaterializationTarget | null;
  private failAfterFinalizerOnce: boolean;

  private readonly transaction: TransactionExecutor = {
    select: <Row extends object>(): Promise<Row[]> => Promise.resolve([]),
    execute: () => Promise.resolve({ rowsAffected: 0 }),
  };

  public constructor(
    private readonly shared: SharedState,
    private readonly works: readonly SnapshotMaterializationWork[],
    targetValue: SnapshotMaterializationTarget | null,
    failAfterFinalizerOnce: boolean,
  ) {
    this.target = targetValue;
    this.failAfterFinalizerOnce = failAfterFinalizerOnce;
  }

  public readCommittedTarget(
    identityValue: SnapshotMaterializationIdentity,
  ): Promise<Result<SnapshotMaterializationTarget | null, AppError>> {
    void identityValue;
    this.targetReads += 1;
    return Promise.resolve(ok(this.target));
  }

  public loadNextPendingWork(
    identityValue: SnapshotMaterializationIdentity,
  ): Promise<Result<SnapshotMaterializationWork | null, AppError>> {
    void identityValue;
    this.insideTransaction = true;
    const next =
      this.works.find((candidate) => !this.receipts.has(candidate.operation.operationId)) ?? null;
    this.insideTransaction = false;
    return Promise.resolve(ok(next));
  }

  public async resolveWorkAtomically(
    input: ResolveSnapshotMaterializationWorkInput,
    resolver: SnapshotMaterializationResolver,
  ): Promise<Result<ResolveSnapshotMaterializationWorkResult, AppError>> {
    const workValue = this.works.find(
      (candidate) => candidate.operation.operationId === input.operationId,
    );
    if (workValue === undefined) {
      return err(stateError("Snapshot work is missing."));
    }
    const existing = this.receipts.get(input.operationId);
    if (existing !== undefined) {
      return ok({ replayed: true, receipt: existing });
    }
    const backup = cloneTransactionalState(this.shared);
    this.insideTransaction = true;
    try {
      const decision = await resolver(this.transaction, workValue);
      const receipt: SnapshotMaterializationReceipt = {
        snapshotId: input.snapshotId,
        operationId: input.operationId,
        operationFingerprint: input.operationFingerprint,
        outcome: decision.outcome,
        conflictCode: decision.outcome === "conflict" ? decision.conflictCode : null,
        resolvedAt: input.resolvedAt,
      };
      this.receipts.set(input.operationId, receipt);
      return ok({ replayed: false, receipt });
    } catch (cause: unknown) {
      restoreTransactionalState(this.shared, backup);
      return err(asAppError(cause));
    } finally {
      this.insideTransaction = false;
    }
  }

  public readState(
    identityValue: SnapshotMaterializationIdentity,
  ): Promise<Result<SnapshotMaterializationState | null, AppError>> {
    void identityValue;
    if (this.target === null) {
      return Promise.resolve(ok(null));
    }
    const conflict = [...this.receipts.values()].filter(
      (receipt) => receipt.outcome === "conflict",
    ).length;
    return Promise.resolve(
      ok({
        snapshotId: SNAPSHOT_ID,
        projectId: PROJECT_ID,
        epoch: 4,
        total: this.works.length,
        resolved: this.receipts.size,
        conflict,
        remaining: this.works.length - this.receipts.size,
      }),
    );
  }

  public async finalizeAtomically(
    _identity: SnapshotMaterializationIdentity,
    finalizer: SnapshotMaterializationFinalizer,
  ): Promise<Result<FinalizeSnapshotMaterializationResult, AppError>> {
    if (this.target === null) {
      return ok({ finalized: false, reason: "snapshot_absent" });
    }
    const state = requireOk(await this.readState(identity()));
    if (state === null) {
      return err(stateError("Snapshot state is missing."));
    }
    if (state.remaining !== 0 || state.conflict !== 0) {
      return err(stateError("Snapshot is not ready to finalize."));
    }
    const backup = cloneTransactionalState(this.shared);
    this.insideTransaction = true;
    try {
      await finalizer(this.transaction, this.target);
      if (this.failAfterFinalizerOnce) {
        this.failAfterFinalizerOnce = false;
        throw new AppError({
          code: "REPOSITORY_ERROR",
          message: "Injected finalizer crash.",
          retryable: true,
          actions: ["RETRY"],
        });
      }
      this.shared.events.push("finalize:cleanup");
      this.archivedReceiptOutcomes.push(
        ...[...this.receipts.values()].map((receipt) => receipt.outcome),
      );
      this.target = null;
      this.receipts.clear();
      return ok({ finalized: true, reason: "finalized" });
    } catch (cause: unknown) {
      restoreTransactionalState(this.shared, backup);
      return err(asAppError(cause));
    } finally {
      this.insideTransaction = false;
    }
  }
}

class FakeAuthority {
  public registrationReads = 0;

  public constructor(
    private readonly shared: SharedState,
    private readonly onLoadCheckpoint?: (shared: SharedState) => void,
  ) {}

  public loadProjectSyncRegistration(
    projectId: string,
  ): Promise<Result<ProjectSyncRegistration | null, AppError>> {
    void projectId;
    this.registrationReads += 1;
    return Promise.resolve(ok({ ...this.shared.registration }));
  }

  public loadMaterializedCheckpoint(
    projectId: string,
  ): Promise<Result<SyncMaterializedCheckpoint | null, AppError>> {
    void projectId;
    this.onLoadCheckpoint?.(this.shared);
    return Promise.resolve(
      ok(this.shared.checkpoint === null ? null : { ...this.shared.checkpoint }),
    );
  }

  public transitionProjectSyncRegistration(
    input: TransitionProjectSyncRegistrationInput,
  ): Promise<Result<ProjectSyncRegistration, AppError>> {
    const current = this.shared.registration;
    if (
      current.projectId !== input.projectId ||
      current.accountId !== input.expectedAccountId ||
      current.deviceId !== input.expectedDeviceId ||
      current.consentRevision !== input.expectedConsentRevision ||
      current.keyVersion !== input.expectedKeyVersion ||
      current.revision !== input.expectedRevision ||
      input.target.state !== "error"
    ) {
      return Promise.resolve(err(stateError("Registration pause CAS changed.")));
    }
    this.shared.registration = {
      ...current,
      state: "error",
      revision: current.revision + 1,
      plaintextBootstrapCompleted: false,
      lastErrorCode: input.target.errorCode,
      updatedAt: input.transitionedAt,
      enabledAt: null,
      pausedAt: null,
    };
    return Promise.resolve(ok(this.shared.registration));
  }
}

class FakeMaterializer {
  public readonly prepareOutsideTransaction: boolean[] = [];
  public readonly prepare = vi.fn(
    async (workValue: SnapshotMaterializationWork): Promise<PreparedIncomingContentMutation> => {
      this.shared.events.push(`prepare:${workValue.operation.operationId}`);
      this.prepareOutsideTransaction.push(!this.store.insideTransaction);
      if (this.prepareGate !== undefined) {
        await this.prepareGate;
      }
      if (this.prepareFailure !== undefined) {
        throw this.prepareFailure;
      }
      this.afterPrepare?.();
      return {
        operationFingerprint: workValue.operationFingerprint,
      } as PreparedIncomingContentMutation;
    },
  );

  public readonly applyPrepared = vi.fn(
    (
      transaction: TransactionExecutor,
      exactWork: SnapshotMaterializationWork,
      prepared: PreparedIncomingContentMutation,
      now: string,
    ): Promise<ContentSyncMaterializationOutcome> => {
      void transaction;
      void prepared;
      void now;
      expect(this.store.insideTransaction).toBe(true);
      this.shared.events.push(`apply:${exactWork.operation.operationId}`);
      const directive = this.outcomes.shift() ?? { status: "applied" as const };
      this.shared.businessMutations.push(exactWork.operation.operationId);
      return Promise.resolve(materializationOutcome(exactWork, directive));
    },
  );

  private readonly outcomes: MaterializerDirective[];

  public constructor(
    private readonly shared: SharedState,
    private readonly store: FakeSnapshotStore,
    outcomes: readonly MaterializerDirective[],
    private readonly prepareFailure: Error | undefined,
    private readonly prepareGate: Promise<void> | undefined,
    private readonly afterPrepare: (() => void) | undefined,
  ) {
    this.outcomes = [...outcomes];
  }
}

function createAtomicAuthority(
  shared: SharedState,
  store: FakeSnapshotStore,
): CloudSyncSnapshotMaterializationAtomicAuthority {
  return {
    advanceMaterializedCheckpointInTransaction(
      transaction,
      input: AdvanceSyncMaterializedCheckpointInput,
    ) {
      void transaction;
      expect(store.insideTransaction).toBe(true);
      shared.events.push("finalize:checkpoint");
      const current = shared.checkpoint;
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return Promise.resolve(err(stateError("Checkpoint CAS changed.")));
      }
      shared.checkpoint = {
        projectId: input.projectId,
        signedRemoteCursor: input.signedRemoteCursor,
        downloadedCheckpointRevision: input.downloadedCheckpointRevision,
        revision: (current?.revision ?? 0) + 1,
        updatedAt: input.updatedAt,
      };
      return Promise.resolve(ok(shared.checkpoint));
    },
    transitionRegistrationInTransaction(
      transaction,
      input: TransitionProjectSyncRegistrationInput,
    ) {
      void transaction;
      expect(store.insideTransaction).toBe(true);
      shared.events.push("finalize:registration");
      const current = shared.registration;
      if (
        current.state !== "bootstrap_required" ||
        input.target.state !== "enabled" ||
        current.accountId !== input.expectedAccountId ||
        current.deviceId !== input.expectedDeviceId ||
        current.consentRevision !== input.expectedConsentRevision ||
        current.keyVersion !== input.expectedKeyVersion ||
        current.revision !== input.expectedRevision
      ) {
        return Promise.resolve(err(stateError("Registration enable CAS changed.")));
      }
      shared.registration = {
        ...current,
        state: "enabled",
        revision: current.revision + 1,
        plaintextBootstrapCompleted: true,
        lastErrorCode: null,
        updatedAt: input.transitionedAt,
        enabledAt: input.transitionedAt,
        pausedAt: null,
      };
      return Promise.resolve(ok(shared.registration));
    },
  };
}

function materializationOutcome(
  workValue: SnapshotMaterializationWork,
  directive: MaterializerDirective,
): ContentSyncMaterializationOutcome {
  const base = {
    projectId: workValue.projectId,
    objectType: workValue.operation.objectType,
    objectId: workValue.operation.objectId,
    objectGeneration: workValue.operation.objectGeneration,
    sourceOperationId: workValue.operation.operationId,
  };
  if (directive.status === "retry") {
    return {
      ...base,
      status: "retry",
      code:
        directive.code === "SYNC_PROJECT_MANIFEST_MISSING"
          ? "SYNC_PROJECT_MANIFEST_MISSING"
          : "SYNC_PARENT_VERSION_MISSING",
      missingId: workValue.operation.objectId,
    } as ContentSyncMaterializationOutcome;
  }
  if (directive.status === "conflict") {
    return {
      ...base,
      status: "conflict",
      conflictId: workValue.operation.operationId,
    } as ContentSyncMaterializationOutcome;
  }
  if (directive.status === "skipped") {
    return {
      ...base,
      status: "skipped",
      reason: "duplicate",
      marker: null,
    } as ContentSyncMaterializationOutcome;
  }
  return {
    ...base,
    status: "applied",
    marker: {},
  } as ContentSyncMaterializationOutcome;
}

function work(index: 0 | 1): SnapshotMaterializationWork {
  const operationId = index === 0 ? FIRST_OPERATION_ID : SECOND_OPERATION_ID;
  const objectId = index === 0 ? FIRST_OBJECT_ID : SECOND_OBJECT_ID;
  return {
    snapshotId: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    epoch: 4,
    operationFingerprint: (index === 0 ? "a" : "b").repeat(64),
    operation: {
      operationId,
      projectId: PROJECT_ID,
      deviceId: DEVICE_ID,
      deviceSequence: index + 1,
      objectType: index === 0 ? "project_manifest" : "chapter_version",
      objectId,
      objectGeneration: 1,
      kind: "upsert",
      vector: { [DEVICE_ID]: index + 1 },
      encryptedChunkIds: [],
      createdAt: COMMITTED_AT,
    },
    chunks: [],
    tombstone: null,
  };
}

function target(): SnapshotMaterializationTarget {
  return {
    ...identity(),
    signedRemoteCursor: CURSOR,
    downloadedCheckpointRevision: 9,
    committedAt: COMMITTED_AT,
  };
}

function identity(): SnapshotMaterializationIdentity {
  return {
    snapshotId: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    epoch: 4,
  };
}

function bootstrapRegistration(): ProjectSyncRegistration {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    state: "bootstrap_required",
    consentRevision: 3,
    keyVersion: 2,
    revision: 7,
    plaintextBootstrapCompleted: false,
    lastErrorCode: null,
    createdAt: COMMITTED_AT,
    updatedAt: COMMITTED_AT,
    enabledAt: null,
    pausedAt: null,
  };
}

function enabledRegistration(): ProjectSyncRegistration {
  return {
    ...bootstrapRegistration(),
    state: "enabled",
    revision: 8,
    plaintextBootstrapCompleted: true,
    updatedAt: NOW,
    enabledAt: NOW,
  };
}

function fixedClock(): Clock {
  return {
    now: () => NOW as ReturnType<Clock["now"]>,
  };
}

function stateError(message: string): AppError {
  return new AppError({
    code: "INVALID_STATE_TRANSITION",
    message,
    actions: ["RETRY", "OPEN_SETTINGS"],
  });
}

function asAppError(cause: unknown): AppError {
  return cause instanceof AppError
    ? cause
    : new AppError({
        code: "REPOSITORY_ERROR",
        message: "Injected transaction failure.",
        retryable: true,
        actions: ["RETRY"],
        details: { causeType: cause instanceof Error ? cause.name : "UnknownError" },
      });
}

function requireOk<Value>(result: Result<Value, AppError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function cloneTransactionalState(shared: SharedState): Omit<SharedState, "events"> {
  return {
    registration: { ...shared.registration },
    checkpoint: shared.checkpoint === null ? null : { ...shared.checkpoint },
    seededJobs: [...shared.seededJobs],
    businessMutations: [...shared.businessMutations],
  };
}

function restoreTransactionalState(shared: SharedState, backup: Omit<SharedState, "events">): void {
  shared.registration = backup.registration;
  shared.checkpoint = backup.checkpoint;
  shared.seededJobs = [...backup.seededJobs];
  shared.businessMutations = [...backup.businessMutations];
}

function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
