import type { ProjectSyncRegistration } from "@inkshadow/data";
import { AppError, err, ok } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type { CloudSyncRuntimeResult } from "./cloud-sync-runtime-service";
import { CloudSyncSupervisor, type CloudSyncSupervisorDependencies } from "./cloud-sync-supervisor";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const SECOND_PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const NOW = "2026-07-28T02:00:00.000Z";

describe("CloudSyncSupervisor", () => {
  it("is default-off and performs no registration or runtime work", async () => {
    const fixture = createFixture({ enabled: false });

    await expect(fixture.supervisor.runOnce()).resolves.toEqual({
      state: "disabled",
      registrationCount: 0,
      attemptedProjectCount: 0,
      projectLimitReached: false,
      projectResults: [],
      failure: null,
    });
    fixture.supervisor.start();
    await fixture.supervisor.stop();

    expect(fixture.listRegistrations).not.toHaveBeenCalled();
    expect(fixture.runProject).not.toHaveBeenCalled();
    expect(fixture.wait).not.toHaveBeenCalled();
  });

  it("runs only durable runnable registrations through the complete project runtime", async () => {
    const registrations = [
      registration(PROJECT_ID, "enabled"),
      registration(SECOND_PROJECT_ID, "bootstrap_required"),
    ];
    const fixture = createFixture({ registrations });

    await expect(fixture.supervisor.runOnce()).resolves.toMatchObject({
      state: "completed",
      registrationCount: 2,
      attemptedProjectCount: 2,
      projectResults: [
        { projectId: PROJECT_ID, state: "completed" },
        { projectId: SECOND_PROJECT_ID, state: "completed" },
      ],
    });
    expect(fixture.runProject).toHaveBeenNthCalledWith(1, PROJECT_ID, {});
    expect(fixture.runProject).toHaveBeenNthCalledWith(2, SECOND_PROJECT_ID, {});
  });

  it("shares a concurrent discovery cycle and rejects inconsistent registration evidence", async () => {
    const pending = deferred<readonly ProjectSyncRegistration[]>();
    const fixture = createFixture({ registrationDeferred: pending });

    const first = fixture.supervisor.runOnce();
    const second = fixture.supervisor.runOnce();
    expect(second).toBe(first);
    pending.resolve([registration(PROJECT_ID, "enabled"), registration(PROJECT_ID, "enabling")]);

    await expect(first).resolves.toMatchObject({
      state: "retryable",
      attemptedProjectCount: 0,
      failure: {
        code: "SYNC_SUPERVISOR_CYCLE_FAILED",
        retryable: true,
      },
    });
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("distinguishes transient runtime work from states requiring user attention", async () => {
    const retryable = createFixture({
      runtimeResults: [runtimeResult(PROJECT_ID, "retryable")],
    });
    await expect(retryable.supervisor.runOnce()).resolves.toMatchObject({
      state: "retryable",
      failure: null,
    });

    const blocked = createFixture({
      runtimeResults: [runtimeResult(PROJECT_ID, "permanent_paused")],
    });
    await expect(blocked.supervisor.runOnce()).resolves.toMatchObject({
      state: "attention_required",
      failure: null,
    });
  });

  it("preserves source error codes without starting any project", async () => {
    const fixture = createFixture({
      sourceError: new AppError({
        code: "REPOSITORY_ERROR",
        message: "registration read failed",
        retryable: true,
        actions: ["RETRY"],
      }),
    });

    await expect(fixture.supervisor.runOnce()).resolves.toMatchObject({
      state: "retryable",
      failure: { code: "REPOSITORY_ERROR", retryable: true },
    });
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("stops retry classification for a non-retryable registration source failure", async () => {
    const fixture = createFixture({
      sourceError: new AppError({
        code: "REPOSITORY_ERROR",
        message: "registration evidence is corrupt",
        retryable: false,
        actions: ["CONTACT_SUPPORT"],
      }),
    });

    await expect(fixture.supervisor.runOnce()).resolves.toMatchObject({
      state: "attention_required",
      failure: { code: "REPOSITORY_ERROR", retryable: false },
    });
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("starts one loop and aborts its wait cleanly on shutdown", async () => {
    const onCycle = vi.fn();
    const fixture = createFixture({ registrations: [], onCycle });

    fixture.supervisor.start();
    fixture.supervisor.start();
    await vi.waitFor(() => expect(fixture.wait).toHaveBeenCalledTimes(1));
    expect(fixture.supervisor.isRunning).toBe(true);

    await fixture.supervisor.stop();

    expect(onCycle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "idle", registrationCount: 0 }),
    );
    expect(fixture.listRegistrations).toHaveBeenCalledTimes(1);
    expect(fixture.supervisor.isRunning).toBe(false);
  });

  it("bounds each discovery cycle and rotates fairly across durable projects", async () => {
    const thirdProjectId = "019f9f4a-b3c7-7350-9226-000000000005";
    const fixture = createFixture({
      registrations: [
        registration(PROJECT_ID, "enabled"),
        registration(SECOND_PROJECT_ID, "enabled"),
        registration(thirdProjectId, "enabled"),
      ],
      maximumProjectsPerCycle: 1,
    });

    await expect(fixture.supervisor.runOnce()).resolves.toMatchObject({
      registrationCount: 3,
      attemptedProjectCount: 1,
      projectLimitReached: true,
      projectResults: [{ projectId: PROJECT_ID }],
    });
    await expect(fixture.supervisor.runOnce()).resolves.toMatchObject({
      projectResults: [{ projectId: SECOND_PROJECT_ID }],
    });
    await expect(fixture.supervisor.runOnce()).resolves.toMatchObject({
      projectResults: [{ projectId: thirdProjectId }],
    });
  });

  it("uses bounded exponential backoff for consecutive retryable cycles", async () => {
    const waits: number[] = [];
    const wait = vi.fn((milliseconds: number, signal: AbortSignal) => {
      waits.push(milliseconds);
      if (waits.length < 3) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const fixture = createFixture({
      runtimeResults: [
        runtimeResult(PROJECT_ID, "retryable"),
        runtimeResult(PROJECT_ID, "retryable"),
        runtimeResult(PROJECT_ID, "retryable"),
      ],
      waiter: { wait },
      retryIntervalMs: 250,
      maximumRetryIntervalMs: 750,
    });

    fixture.supervisor.start();
    await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(3));
    await fixture.supervisor.stop();

    expect(waits).toEqual([250, 500, 750]);
  });
});

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly registrations?: readonly ProjectSyncRegistration[];
  readonly registrationDeferred?: Deferred<readonly ProjectSyncRegistration[]>;
  readonly runtimeResults?: readonly CloudSyncRuntimeResult[];
  readonly sourceError?: AppError;
  readonly onCycle?: CloudSyncSupervisorDependencies["onCycle"];
  readonly waiter?: CloudSyncSupervisorDependencies["waiter"];
  readonly retryIntervalMs?: number;
  readonly maximumRetryIntervalMs?: number;
  readonly maximumProjectsPerCycle?: number;
}

function createFixture(options: FixtureOptions = {}) {
  const runtimeResults = [...(options.runtimeResults ?? [])];
  const listRegistrations = vi.fn(async () => {
    if (options.sourceError !== undefined) {
      return err(options.sourceError);
    }
    const registrations =
      options.registrationDeferred === undefined
        ? (options.registrations ?? [registration(PROJECT_ID, "enabled")])
        : await options.registrationDeferred.promise;
    return ok(registrations);
  });
  const runProject = vi.fn((projectId: string) =>
    Promise.resolve(runtimeResults.shift() ?? runtimeResult(projectId, "completed")),
  );
  const configuredWaiter = options.waiter;
  const wait =
    configuredWaiter === undefined
      ? vi.fn(
          (_milliseconds: number, signal: AbortSignal) =>
            new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              signal.addEventListener("abort", () => resolve(), { once: true });
            }),
        )
      : (milliseconds: number, signal: AbortSignal) => configuredWaiter.wait(milliseconds, signal);
  return {
    supervisor: new CloudSyncSupervisor({
      enabled: options.enabled ?? true,
      registrations: { listRunnableProjectSyncRegistrations: listRegistrations },
      runtime: { runProject },
      waiter: { wait },
      intervalMs: 250,
      retryIntervalMs: options.retryIntervalMs ?? 250,
      ...(options.maximumRetryIntervalMs === undefined
        ? {}
        : { maximumRetryIntervalMs: options.maximumRetryIntervalMs }),
      ...(options.maximumProjectsPerCycle === undefined
        ? {}
        : { maximumProjectsPerCycle: options.maximumProjectsPerCycle }),
      ...(options.onCycle === undefined ? {} : { onCycle: options.onCycle }),
    }),
    listRegistrations,
    runProject,
    wait,
  };
}

function registration(
  projectId: string,
  state: "bootstrap_required" | "enabled" | "enabling",
): ProjectSyncRegistration {
  return {
    projectId,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    state,
    consentRevision: 1,
    keyVersion: 1,
    revision: 2,
    plaintextBootstrapCompleted: state === "enabled",
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    enabledAt: state === "enabled" ? NOW : null,
    pausedAt: null,
  };
}

function runtimeResult(
  projectId: string,
  state: "completed" | "permanent_paused" | "retryable",
): CloudSyncRuntimeResult {
  return {
    projectId,
    state,
    phase: state === "completed" ? "complete" : "sync",
    pushAllowed: state === "completed",
    binding: null,
    failure:
      state === "completed"
        ? null
        : {
            phase: "sync",
            category: state === "retryable" ? "retryable" : "permanent_paused",
            code:
              state === "retryable" ? "SYNC_SUPERVISOR_TEST_RETRY" : "SYNC_SUPERVISOR_TEST_PAUSED",
          },
    bootstrap: null,
    snapshotMaterialization: null,
    incrementalIntake: null,
    projection: null,
    projectionSummary: null,
    sync: null,
  };
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
