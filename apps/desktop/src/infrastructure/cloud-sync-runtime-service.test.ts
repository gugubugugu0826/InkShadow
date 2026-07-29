import type { ProjectSyncRegistration } from "@inkshadow/data";
import type {
  SyncRemoteCheckpoint,
  SyncSnapshotStagingSummary,
} from "@inkshadow/data/sync-sqlite-store";
import { ok, type Clock } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type { CloudSyncBootstrapResult } from "./cloud-sync-bootstrap-coordinator";
import type { CloudSyncCycleResult } from "./cloud-sync-orchestrator";
import type { CloudSyncSnapshotMaterializationResult } from "./cloud-sync-snapshot-materialization-coordinator";
import {
  CloudSessionCoordinatorError,
  type ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import {
  CloudSyncRuntimeService,
  type CloudSyncRuntimeServiceDependencies,
} from "./cloud-sync-runtime-service";
import type { OutgoingContentProjectionWorkerOutcome } from "./outgoing-content-projection-worker";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OTHER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const SNAPSHOT_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const JOB_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const NOW = "2026-07-28T00:00:00.000Z";

describe("CloudSyncRuntimeService", () => {
  it("is default-off and touches no session, database, key, or network port", async () => {
    const fixture = createFixture({ enabled: false });

    await expect(fixture.service.runProject(PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      state: "disabled",
      phase: "configuration",
      pushAllowed: false,
      binding: null,
      failure: null,
    });
    expect(fixture.session.ensureReady).not.toHaveBeenCalled();
    expect(fixture.authority.loadProjectSyncRegistration).not.toHaveBeenCalled();
    expect(fixture.projectKeys.openProjectDataKeyForDevice).not.toHaveBeenCalled();
    expect(fixture.bootstrap.runProjectBootstrap).not.toHaveBeenCalled();
    expect(fixture.projectionWorker.runOnce).not.toHaveBeenCalled();
  });

  it("runs incremental intake and settlement before projection and a bound push cycle", async () => {
    const order: string[] = [];
    const fixture = createFixture({ order });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      projectId: PROJECT_ID,
      state: "completed",
      phase: "complete",
      pushAllowed: true,
      binding: {
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        consentRevision: 7,
        keyVersion: 3,
        registrationRevision: 2,
      },
      incrementalIntake: { state: "idle" },
      projection: { status: "idle" },
      projectionSummary: {
        workerRuns: 1,
        completedJobs: 0,
        reachedIdle: true,
        workLimitReached: false,
      },
      sync: { state: "idle" },
      failure: null,
    });
    expect(fixture.orchestrators.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        registrationRevision: 1,
      }),
    );
    expect(fixture.orchestrators.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        registrationRevision: 2,
      }),
    );
    expect(order).toEqual([
      "session",
      "authority",
      "key",
      "bootstrap",
      "orchestrator_factory",
      "sync_intake",
      "session",
      "authority",
      "key",
      "projection",
      "orchestrator_factory",
      "sync",
    ]);
  });

  it("moves an exact registration into bootstrap_required and materializes a committed snapshot", async () => {
    const fixture = createFixture({
      bootstrapResult: bootstrapResult("ciphertext_baseline_committed"),
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "completed",
      pushAllowed: true,
      bootstrap: {
        state: "ciphertext_baseline_committed",
        pushAllowed: false,
        plaintextMaterializationRequired: true,
      },
      snapshotMaterialization: {
        state: "plaintext_bootstrap_completed",
        pushAllowed: true,
      },
      incrementalIntake: null,
    });
    expect(fixture.authority.transitionProjectSyncRegistration).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      expectedAccountId: ACCOUNT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedConsentRevision: 7,
      expectedKeyVersion: 3,
      expectedRevision: 1,
      target: { state: "bootstrap_required" },
      transitionedAt: NOW,
    });
    const materializationOptions = (
      fixture.snapshotMaterializer.runProjectSnapshotMaterialization.mock
        .calls[0] as unknown as readonly [unknown, Readonly<{ signal?: AbortSignal }>]
    )[1];
    expect(materializationOptions.signal).toBeInstanceOf(AbortSignal);
    expect(fixture.snapshotMaterializer.runProjectSnapshotMaterialization).toHaveBeenCalledWith(
      { snapshotId: SNAPSHOT_ID, projectId: PROJECT_ID, epoch: 4 },
      { signal: materializationOptions.signal },
    );
    expect(fixture.orchestrators.create).toHaveBeenCalledTimes(1);
  });

  it("never opens projection or push from an incremental ciphertext result alone", async () => {
    const fixture = createFixture({
      intakeResult: cycleResult("retryable", "SYNC_INCREMENTAL_SETTLEMENT_RETRY"),
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "retryable",
      phase: "incremental_intake",
      pushAllowed: false,
      bootstrap: {
        state: "incremental_available",
        pushAllowed: true,
      },
      incrementalIntake: {
        state: "retryable",
      },
      failure: {
        category: "retryable",
        code: "SYNC_INCREMENTAL_SETTLEMENT_RETRY",
      },
    });
    expect(fixture.projectionWorker.runOnce).not.toHaveBeenCalled();
    expect(fixture.orchestrators.create).toHaveBeenCalledTimes(1);
  });

  it("keeps push closed when an enabled project's plaintext settlement is retryable", async () => {
    const fixture = createFixture({
      registration: enabledRegistration(),
      cycleResult: cycleResult("retryable", "SYNC_INCOMING_MATERIALIZATION_PENDING"),
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "retryable",
      phase: "sync",
      pushAllowed: false,
      incrementalIntake: null,
      sync: {
        state: "retryable",
        failure: {
          category: "retryable",
          code: "SYNC_INCOMING_MATERIALIZATION_PENDING",
        },
        outgoing: {
          claimed: 0,
          pushed: 0,
        },
      },
    });
  });

  it("keeps push closed when snapshot plaintext work remains retryable", async () => {
    const fixture = createFixture({
      bootstrapResult: bootstrapResult("ciphertext_baseline_committed"),
      materializationResult: snapshotMaterializationResult("retryable"),
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "retryable",
      phase: "snapshot_materialization",
      pushAllowed: false,
      failure: {
        category: "retryable",
        code: "SYNC_SNAPSHOT_WORK_RETRY",
      },
    });
    expect(fixture.projectionWorker.runOnce).not.toHaveBeenCalled();
    expect(fixture.orchestrators.create).not.toHaveBeenCalled();
  });

  it("rejects an intake cycle that reports success without enabling plaintext authority", async () => {
    const fixture = createFixture({
      settleDuringIntake: false,
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "authority_blocked",
      phase: "authority",
      pushAllowed: false,
      failure: {
        category: "authority_blocked",
        code: "SYNC_PLAINTEXT_AUTHORITY_NOT_ENABLED",
      },
    });
    expect(fixture.projectionWorker.runOnce).not.toHaveBeenCalled();
  });

  it("binds the project to the current account and device before any key or cloud work", async () => {
    const fixture = createFixture({
      registration: enablingRegistration({ accountId: "019f9f4a-b3c7-7350-9226-000000000099" }),
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "authority_blocked",
      phase: "authority",
      pushAllowed: false,
      failure: {
        category: "authority_blocked",
        code: "SYNC_ACCOUNT_AUTHORITY_MISMATCH",
      },
    });
    expect(fixture.projectKeys.openProjectDataKeyForDevice).not.toHaveBeenCalled();
    expect(fixture.bootstrap.runProjectBootstrap).not.toHaveBeenCalled();
  });

  it("fails closed when the key opener returns another project key version", async () => {
    const fixture = createFixture();
    fixture.projectKeys.openProjectDataKeyForDevice.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      keyVersion: 4,
      key: {} as CryptoKey,
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "key_blocked",
      phase: "key",
      pushAllowed: false,
      failure: {
        category: "key_blocked",
        code: "SYNC_PROJECT_KEY_AUTHORITY_MISMATCH",
      },
    });
    expect(fixture.bootstrap.runProjectBootstrap).not.toHaveBeenCalled();
  });

  it("rechecks the session and refuses projection if the device changes during bootstrap", async () => {
    const fixture = createFixture();
    fixture.session.ensureReady
      .mockResolvedValueOnce(configuredSession())
      .mockResolvedValueOnce(configuredSession(OTHER_DEVICE_ID));

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "authority_blocked",
      phase: "authority",
      pushAllowed: false,
      failure: {
        code: "SYNC_SESSION_AUTHORITY_CHANGED",
      },
    });
    expect(fixture.projectionWorker.runOnce).not.toHaveBeenCalled();
    expect(fixture.orchestrators.create).toHaveBeenCalledTimes(1);
  });

  it("uses one promise for concurrent runs of the same project", async () => {
    const deferred = createDeferred<CloudSyncBootstrapResult>();
    const fixture = createFixture();
    fixture.bootstrap.runProjectBootstrap.mockReturnValueOnce(deferred.promise);

    const first = fixture.service.runProject(PROJECT_ID);
    const second = fixture.service.runProject(PROJECT_ID);

    expect(first).toBe(second);
    await vi.waitFor(() => {
      expect(fixture.bootstrap.runProjectBootstrap).toHaveBeenCalledTimes(1);
    });
    deferred.resolve(bootstrapResult("incremental_available"));
    await expect(first).resolves.toMatchObject({ state: "completed" });
    expect(fixture.projectionWorker.runOnce).toHaveBeenCalledTimes(1);
    expect(fixture.cycle).toHaveBeenCalledTimes(2);
  });

  it("keeps a synchronous admission fence closed from cancellation through local disable", async () => {
    const deferred = createDeferred<CloudSyncBootstrapResult>();
    const fixture = createFixture();
    fixture.bootstrap.runProjectBootstrap.mockReturnValueOnce(deferred.promise);

    const active = fixture.service.runProject(PROJECT_ID);
    await vi.waitFor(() => {
      expect(fixture.bootstrap.runProjectBootstrap).toHaveBeenCalledTimes(1);
    });
    let cancellationSettled = false;
    const cancellation = fixture.service.cancelAndWaitProject(PROJECT_ID).then(() => {
      cancellationSettled = true;
    });
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);

    deferred.resolve(bootstrapResult("incremental_available"));
    await expect(active).resolves.toMatchObject({ state: "aborted", pushAllowed: false });
    await cancellation;
    expect(cancellationSettled).toBe(true);

    await expect(fixture.service.runProject(PROJECT_ID)).resolves.toMatchObject({
      state: "aborted",
      phase: "configuration",
      pushAllowed: false,
    });
    expect(fixture.bootstrap.runProjectBootstrap).toHaveBeenCalledTimes(1);

    fixture.service.resumeProject(PROJECT_ID);
    await expect(fixture.service.runProject(PROJECT_ID)).resolves.toMatchObject({
      state: "completed",
    });
    expect(fixture.bootstrap.runProjectBootstrap).toHaveBeenCalledTimes(2);
  });

  it("uses the bootstrap boundary callback to reject a frozen registration after disable", async () => {
    const fixture = createFixture();
    fixture.bootstrap.runProjectBootstrap.mockImplementationOnce(async (_projectId, options) => {
      fixture.setRegistration({
        ...enablingRegistration(),
        state: "disabled",
        plaintextBootstrapCompleted: false,
        enabledAt: null,
      });
      await options?.assertAuthority?.();
      return bootstrapResult("incremental_available");
    });

    await expect(fixture.service.runProject(PROJECT_ID)).resolves.toMatchObject({
      state: "authority_blocked",
      phase: "bootstrap",
      pushAllowed: false,
      failure: { code: "SYNC_REGISTRATION_AUTHORITY_CHANGED" },
    });
    expect(fixture.projectionWorker.runOnce).not.toHaveBeenCalled();
  });

  it("honors abort before work and between bootstrap and settlement", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const early = createFixture();

    await expect(
      early.service.runProject(PROJECT_ID, { signal: alreadyAborted.signal }),
    ).resolves.toMatchObject({
      state: "aborted",
      phase: "configuration",
      pushAllowed: false,
    });
    expect(early.session.ensureReady).not.toHaveBeenCalled();

    const controller = new AbortController();
    const between = createFixture();
    between.bootstrap.runProjectBootstrap.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(bootstrapResult("incremental_available"));
    });

    await expect(
      between.service.runProject(PROJECT_ID, { signal: controller.signal }),
    ).resolves.toMatchObject({
      state: "aborted",
      phase: "bootstrap",
      pushAllowed: false,
    });
    expect(between.orchestrators.create).not.toHaveBeenCalled();
    expect(between.projectionWorker.runOnce).not.toHaveBeenCalled();
  });

  it("does not start the network cycle when cancellation arrives during projection", async () => {
    const controller = new AbortController();
    const fixture = createFixture();
    fixture.projectionWorker.runOnce.mockImplementationOnce((projectId) => {
      controller.abort();
      return Promise.resolve({ status: "idle", projectId } as const);
    });

    const result = await fixture.service.runProject(PROJECT_ID, {
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      state: "aborted",
      phase: "projection",
      pushAllowed: false,
      projection: { status: "idle" },
    });
    expect(fixture.orchestrators.create).toHaveBeenCalledTimes(1);
    expect(fixture.cycle).toHaveBeenCalledTimes(1);
  });

  it("runs the sync cycle after a projection retry and reports the pending projection", async () => {
    const order: string[] = [];
    const fixture = createFixture({
      order,
      projectionResult: {
        status: "retry_scheduled",
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        failureCode: "SYNC_KEY_TEMPORARILY_UNAVAILABLE",
        nextAttemptAt: "2026-07-28T00:00:05.000Z",
      },
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "retryable",
      phase: "projection",
      pushAllowed: false,
      failure: {
        category: "retryable",
        code: "SYNC_KEY_TEMPORARILY_UNAVAILABLE",
      },
      sync: { state: "idle" },
    });
    expect(order.indexOf("projection")).toBeLessThan(order.indexOf("sync"));
  });

  it("drains completed projection jobs until the worker proves idle", async () => {
    const fixture = createFixture({
      projectionResults: [
        completedProjection(1),
        completedProjection(2),
        { status: "idle", projectId: PROJECT_ID },
      ],
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "completed",
      pushAllowed: true,
      projection: { status: "idle" },
      projectionSummary: {
        workerRuns: 3,
        completedJobs: 2,
        reachedIdle: true,
        workLimitReached: false,
      },
      sync: { state: "idle" },
    });
    expect(fixture.projectionWorker.runOnce).toHaveBeenCalledTimes(3);
  });

  it("does not report completion when the bounded projection drain reaches its limit", async () => {
    const fixture = createFixture({
      maximumProjectionJobs: 2,
      projectionResults: [
        completedProjection(1),
        completedProjection(2),
        { status: "idle", projectId: PROJECT_ID },
      ],
    });

    const result = await fixture.service.runProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "retryable",
      phase: "projection",
      pushAllowed: false,
      projectionSummary: {
        workerRuns: 2,
        completedJobs: 2,
        reachedIdle: false,
        workLimitReached: true,
      },
      failure: {
        category: "retryable",
        code: "SYNC_PROJECTION_WORK_LIMIT_REACHED",
      },
      sync: { state: "idle" },
    });
    expect(fixture.projectionWorker.runOnce).toHaveBeenCalledTimes(2);
  });

  it("maps a terminal session failure without exposing a push boundary", async () => {
    const fixture = createFixture();
    fixture.session.ensureReady.mockRejectedValueOnce(
      new CloudSessionCoordinatorError(
        "reauth_required",
        "AUTH_SESSION_REQUIRED",
        "Sign in again.",
      ),
    );

    await expect(fixture.service.runProject(PROJECT_ID)).resolves.toMatchObject({
      state: "auth_blocked",
      phase: "session",
      pushAllowed: false,
      failure: {
        category: "auth_blocked",
        code: "AUTH_SESSION_REQUIRED",
      },
    });
  });
});

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly registration?: ProjectSyncRegistration;
  readonly bootstrapResult?: CloudSyncBootstrapResult;
  readonly materializationResult?: CloudSyncSnapshotMaterializationResult;
  readonly projectionResult?: OutgoingContentProjectionWorkerOutcome;
  readonly projectionResults?: readonly OutgoingContentProjectionWorkerOutcome[];
  readonly intakeResult?: CloudSyncCycleResult;
  readonly cycleResult?: CloudSyncCycleResult;
  readonly settleDuringIntake?: boolean;
  readonly maximumProjectionJobs?: number;
  readonly order?: string[];
}

function createFixture(options: FixtureOptions = {}) {
  const order = options.order ?? [];
  let currentRegistration = options.registration ?? enablingRegistration();
  const projectionResults = [...(options.projectionResults ?? [])];

  const session = {
    ensureReady: vi.fn(() => {
      order.push("session");
      return Promise.resolve(configuredSession());
    }),
  };
  const authority = {
    loadProjectSyncRegistration: vi.fn(() => {
      order.push("authority");
      return Promise.resolve(ok(currentRegistration));
    }),
    transitionProjectSyncRegistration: vi.fn(() => {
      currentRegistration = bootstrapRegistration({
        revision: currentRegistration.revision + 1,
      });
      return Promise.resolve(ok(currentRegistration));
    }),
  };
  const projectKeys = {
    openProjectDataKeyForDevice: vi.fn(() => {
      order.push("key");
      return Promise.resolve({
        projectId: PROJECT_ID,
        keyVersion: 3,
        key: {} as CryptoKey,
      });
    }),
  };
  const bootstrap = {
    runProjectBootstrap: vi.fn<
      CloudSyncRuntimeServiceDependencies["bootstrap"]["runProjectBootstrap"]
    >(() => {
      order.push("bootstrap");
      return Promise.resolve(options.bootstrapResult ?? bootstrapResult("incremental_available"));
    }),
  };
  const snapshotLocator = {
    readStagedSyncSnapshot: vi.fn(() => Promise.resolve(ok(committedSnapshot()))),
  };
  const materializationResult =
    options.materializationResult ?? snapshotMaterializationResult("plaintext_bootstrap_completed");
  const snapshotMaterializer = {
    runProjectSnapshotMaterialization: vi.fn(() => {
      order.push("materialize");
      if (materializationResult.state === "plaintext_bootstrap_completed") {
        currentRegistration = enabledRegistration({
          revision: currentRegistration.revision + 1,
        });
      }
      return Promise.resolve(materializationResult);
    }),
  };
  const runProjection = vi.fn<
    (projectId: string) => Promise<OutgoingContentProjectionWorkerOutcome>
  >((projectId) => {
    order.push("projection");
    return Promise.resolve(
      projectionResults.shift() ??
        options.projectionResult ??
        ({ status: "idle", projectId } as const),
    );
  });
  const projectionWorker = {
    runOnce: runProjection,
  };
  const cycle = vi.fn((): Promise<CloudSyncCycleResult> => {
    if (currentRegistration.state !== "enabled") {
      order.push("sync_intake");
      const intake = options.intakeResult ?? cycleResult("idle");
      if (intake.state === "idle" && options.settleDuringIntake !== false) {
        currentRegistration = enabledRegistration({
          revision: currentRegistration.revision + 1,
        });
      }
      return Promise.resolve(intake);
    }
    order.push("sync");
    return Promise.resolve(options.cycleResult ?? cycleResult("idle"));
  });
  const orchestrators = {
    create: vi.fn(() => {
      order.push("orchestrator_factory");
      return { runProjectCycle: cycle };
    }),
  };
  const dependencies: CloudSyncRuntimeServiceDependencies = {
    enabled: options.enabled ?? true,
    session,
    authority,
    projectKeys,
    bootstrap,
    snapshotLocator,
    snapshotMaterializer,
    projectionWorker,
    orchestrators,
    clock: { now: () => NOW as ReturnType<Clock["now"]> },
    ...(options.maximumProjectionJobs === undefined
      ? {}
      : { limits: { maximumProjectionJobs: options.maximumProjectionJobs } }),
  };
  return {
    service: new CloudSyncRuntimeService(dependencies),
    session,
    authority,
    projectKeys,
    bootstrap,
    snapshotLocator,
    snapshotMaterializer,
    projectionWorker,
    orchestrators,
    cycle,
    setRegistration: (registration: ProjectSyncRegistration) => {
      currentRegistration = registration;
    },
  };
}

function configuredSession(deviceId = DEVICE_ID): ConfiguredCloudSessionStatus {
  return {
    configured: true,
    account: { accountId: ACCOUNT_ID },
    device: { device: { deviceId } },
    session: {},
    expiry: {},
  } as unknown as ConfiguredCloudSessionStatus;
}

function enablingRegistration(
  overrides: Partial<ProjectSyncRegistration> = {},
): ProjectSyncRegistration {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    state: "enabling",
    consentRevision: 7,
    keyVersion: 3,
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

function bootstrapRegistration(
  overrides: Partial<ProjectSyncRegistration> = {},
): ProjectSyncRegistration {
  return {
    ...enablingRegistration(),
    state: "bootstrap_required",
    ...overrides,
  };
}

function enabledRegistration(
  overrides: Partial<ProjectSyncRegistration> = {},
): ProjectSyncRegistration {
  return {
    ...enablingRegistration(),
    state: "enabled",
    revision: 2,
    plaintextBootstrapCompleted: true,
    enabledAt: NOW,
    ...overrides,
  };
}

const CHECKPOINT: SyncRemoteCheckpoint = {
  projectId: PROJECT_ID,
  signedRemoteCursor: "signed.cursor",
  revision: 9,
  updatedAt: NOW,
};

function bootstrapResult(
  state: "ciphertext_baseline_committed" | "incremental_available",
): CloudSyncBootstrapResult {
  return {
    projectId: PROJECT_ID,
    state,
    pushAllowed: state === "incremental_available",
    plaintextMaterializationRequired: state === "ciphertext_baseline_committed",
    pagesFetched: state === "ciphertext_baseline_committed" ? 1 : 0,
    restarts: 0,
    checkpoint: CHECKPOINT,
    failure: null,
  };
}

function committedSnapshot(): SyncSnapshotStagingSummary {
  return {
    snapshotId: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    epoch: 4,
    state: "committed",
    baseCheckpoint: {
      ...CHECKPOINT,
      signedRemoteCursor: "signed.base",
      revision: 8,
    },
    snapshotSignedRemoteCursor: "signed.cursor",
    snapshotExpiresAt: "2026-07-28T01:00:00.000Z",
    nextPageIndex: 1,
    nextSnapshotCursor: null,
    pagesComplete: true,
    finalSignedRemoteCursor: "signed.cursor",
    operationCount: 2,
    chunkCount: 2,
    tombstoneCount: 0,
    committedCheckpointRevision: CHECKPOINT.revision,
    createdAt: NOW,
    updatedAt: NOW,
    committedAt: NOW,
  };
}

function snapshotMaterializationResult(
  state: "plaintext_bootstrap_completed" | "retryable",
): CloudSyncSnapshotMaterializationResult {
  return {
    snapshotId: SNAPSHOT_ID,
    projectId: PROJECT_ID,
    epoch: 4,
    state,
    pushAllowed: state === "plaintext_bootstrap_completed",
    plaintextMaterializationRequired: state !== "plaintext_bootstrap_completed",
    completion: state === "plaintext_bootstrap_completed" ? "finalized" : null,
    attemptedWorkItems: 2,
    appliedReceipts: state === "plaintext_bootstrap_completed" ? 2 : 1,
    skippedReceipts: 0,
    conflictReceipts: 0,
    seededJobs: state === "plaintext_bootstrap_completed" ? 2 : 0,
    skippedSeedJobs: 0,
    permanentPausePersisted: false,
    failure:
      state === "retryable" ? { category: "retryable", code: "SYNC_SNAPSHOT_WORK_RETRY" } : null,
  };
}

function completedProjection(index: number): OutgoingContentProjectionWorkerOutcome {
  return {
    status: "completed",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    operationId: SNAPSHOT_ID,
    objectType: "chapter_version",
    sourceRevision: index,
    deviceSequence: index,
  };
}

function cycleResult(
  state: "idle" | "retryable",
  failureCode = "SYNC_CYCLE_RETRY",
): CloudSyncCycleResult {
  return {
    projectId: PROJECT_ID,
    state,
    failure:
      state === "idle"
        ? null
        : {
            category: "retryable",
            code: failureCode,
          },
    pull: {
      pages: 0,
      stagedBatches: 0,
      operations: 0,
      chunks: 0,
      tombstones: 0,
      pageLimitReached: false,
    },
    incoming: {
      claimed: 0,
      applied: 0,
      conflicts: 0,
      retried: 0,
      workLimitReached: false,
    },
    outgoing: {
      boundary: "ready",
      claimed: 0,
      pushed: 0,
      acknowledged: 0,
      retried: 0,
      paused: 0,
      workLimitReached: false,
    },
  };
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}
