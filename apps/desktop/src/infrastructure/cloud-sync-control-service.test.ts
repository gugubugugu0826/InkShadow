import type { ProjectSyncRegistration } from "@inkshadow/data";
import { AppError, err, ok, parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type { CloudProjectSyncEnableResult } from "./cloud-project-sync-enrollment-service";
import {
  CloudSyncControlService,
  type CloudSyncControlServiceDependencies,
} from "./cloud-sync-control-service";
import type { CloudSyncRuntimeResult, CloudSyncRuntimeState } from "./cloud-sync-runtime-service";

const PROJECT_ID = "019fa102-2000-7000-8000-000000000001";
const ACCOUNT_ID = "019fa102-2000-7000-8000-000000000002";
const DEVICE_ID = "019fa102-2000-7000-8000-000000000003";
const NOW = "2026-07-28T03:00:00.000Z";
const NOW_INSTANT = expectDomain(parseIsoUtcTimestamp(NOW));

describe("CloudSyncControlService", () => {
  it("is fail-closed by default and never blocks local work", async () => {
    const fixture = createFixture({ enabled: false });

    await expect(fixture.service.inspectProject(PROJECT_ID)).resolves.toEqual({
      projectId: PROJECT_ID,
      state: "disabled",
      registrationRevision: null,
      lastErrorCode: null,
      retryable: false,
      canPause: false,
      canResume: false,
      canRetry: false,
      localWorkAvailable: true,
    });
    await fixture.service.runProject(PROJECT_ID);

    expect(fixture.loadRegistration).not.toHaveBeenCalled();
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("shares an in-flight run and exposes syncing then synced without content metadata", async () => {
    const pending = deferred<CloudSyncRuntimeResult>();
    const onStateChange = vi.fn();
    const fixture = createFixture({
      runtimePromise: pending.promise,
      onStateChange,
    });

    const first = fixture.service.runProject(PROJECT_ID);
    const second = fixture.service.runProject(PROJECT_ID);
    expect(second).toBe(first);
    await vi.waitFor(() =>
      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({ state: "syncing", localWorkAvailable: true }),
      ),
    );

    pending.resolve(runtimeResult("completed"));
    await expect(first).resolves.toMatchObject({
      state: "synced",
      registrationRevision: 4,
      lastErrorCode: null,
    });
    expect(fixture.runProject).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onStateChange.mock.calls)).not.toContain("access_token");
    expect(JSON.stringify(onStateChange.mock.calls)).not.toContain("chapter body");
  });

  it("establishes the runtime privacy fence before durably pausing the registration", async () => {
    const order: string[] = [];
    const fixture = createFixture({
      registration: registration("error", {
        lastErrorCode: "SYNC_KEY_ENVELOPE_MISSING",
      }),
      onCancel: () => order.push("cancel"),
      onTransition: () => order.push("persist"),
    });

    await expect(fixture.service.pauseProject(PROJECT_ID)).resolves.toMatchObject({
      state: "paused",
      registrationRevision: 5,
      canResume: true,
      localWorkAvailable: true,
    });

    expect(order).toEqual(["cancel", "persist"]);
    expect(fixture.transitionRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        expectedRevision: 4,
        target: { state: "paused" },
      }),
    );
  });

  it("resumes paused authority only through the complete enrollment boundary", async () => {
    const paused = registration("paused");
    const enabled = registration("enabled", { revision: 7 });
    const fixture = createFixture({
      registration: paused,
      enableResult: enrollmentResult(enabled, runtimeResult("completed")),
    });

    await expect(fixture.service.resumeProject(PROJECT_ID)).resolves.toMatchObject({
      state: "synced",
      registrationRevision: 7,
    });

    expect(fixture.enableProject).toHaveBeenCalledWith(PROJECT_ID, {});
    expect(fixture.resumeRuntime).not.toHaveBeenCalled();
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it.each([
    ["offline", "CLOUD_NETWORK_UNAVAILABLE", "offline", true],
    ["retryable", "SYNC_TRANSIENT_FAILURE", "retry_wait", true],
    ["auth_blocked", "AUTH_SESSION_EXPIRED", "reauth_required", false],
    ["key_blocked", "SYNC_PROJECT_KEY_ENVELOPE_REQUIRED", "key_error", false],
    ["conflict_blocked", "SYNC_CONTENT_CONFLICT", "conflict", false],
    ["permanent_paused", "SYNC_QUOTA_EXCEEDED", "quota_exceeded", false],
    ["permanent_paused", "SYNC_DEVICE_REVOKED", "device_revoked", false],
    ["permanent_paused", "SYNC_PROTOCOL_VERSION_INCOMPATIBLE", "version_incompatible", false],
  ] as const)(
    "maps %s/%s to an actionable user state",
    async (runtimeState, code, expectedState, retryable) => {
      const fixture = createFixture({
        runtimeResult: runtimeResult(runtimeState, code),
      });

      await expect(fixture.service.runProject(PROJECT_ID)).resolves.toMatchObject({
        state: expectedState,
        lastErrorCode: code,
        retryable,
        localWorkAvailable: true,
      });
    },
  );

  it("does not retry an unresolved conflict until the user resolves it", async () => {
    const fixture = createFixture({
      runtimeResult: runtimeResult("conflict_blocked", "SYNC_CONTENT_CONFLICT"),
    });

    await fixture.service.runProject(PROJECT_ID);
    fixture.runProject.mockClear();
    await expect(fixture.service.retryProject(PROJECT_ID)).resolves.toMatchObject({
      state: "conflict",
      canRetry: false,
    });
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("surfaces registration read failures without turning them into cloud work", async () => {
    const fixture = createFixture({
      sourceError: new AppError({
        code: "REPOSITORY_ERROR",
        message: "read failed",
        retryable: true,
        actions: ["RETRY"],
      }),
    });

    await expect(fixture.service.runProject(PROJECT_ID)).rejects.toMatchObject({
      code: "REPOSITORY_ERROR",
    });
    expect(fixture.runProject).not.toHaveBeenCalled();
  });
});

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly registration?: ProjectSyncRegistration;
  readonly runtimeResult?: CloudSyncRuntimeResult;
  readonly runtimePromise?: Promise<CloudSyncRuntimeResult>;
  readonly enableResult?: CloudProjectSyncEnableResult;
  readonly sourceError?: AppError;
  readonly onCancel?: () => void;
  readonly onTransition?: () => void;
  readonly onStateChange?: CloudSyncControlServiceDependencies["onStateChange"];
}

function createFixture(options: FixtureOptions = {}) {
  let current = options.registration ?? registration("enabled");
  const loadRegistration = vi.fn(() =>
    Promise.resolve(options.sourceError === undefined ? ok(current) : err(options.sourceError)),
  );
  const transitionRegistration = vi.fn(
    (
      input: Parameters<
        CloudSyncControlServiceDependencies["authority"]["transitionProjectSyncRegistration"]
      >[0],
    ) => {
      options.onTransition?.();
      current = {
        ...current,
        state: input.target.state,
        revision: current.revision + 1,
        lastErrorCode: input.target.state === "error" ? input.target.errorCode : null,
        updatedAt: input.transitionedAt,
        pausedAt: input.target.state === "paused" ? input.transitionedAt : null,
      };
      return Promise.resolve(ok(current));
    },
  );
  const cancelAndWaitProject = vi.fn(() => {
    options.onCancel?.();
    return Promise.resolve();
  });
  const resumeRuntime = vi.fn();
  const runProject = vi.fn(
    () =>
      options.runtimePromise ??
      Promise.resolve(options.runtimeResult ?? runtimeResult("completed")),
  );
  const enableProject = vi.fn(() =>
    Promise.resolve(
      options.enableResult ??
        enrollmentResult(registration("enabled", { revision: 5 }), runtimeResult("completed")),
    ),
  );
  return {
    service: new CloudSyncControlService({
      enabled: options.enabled ?? true,
      authority: {
        loadProjectSyncRegistration: loadRegistration,
        transitionProjectSyncRegistration: transitionRegistration,
      },
      runtime: {
        cancelAndWaitProject,
        resumeProject: resumeRuntime,
        runProject,
      },
      enrollment: { enableProject },
      clock: { now: () => NOW_INSTANT },
      ...(options.onStateChange === undefined ? {} : { onStateChange: options.onStateChange }),
    }),
    loadRegistration,
    transitionRegistration,
    cancelAndWaitProject,
    resumeRuntime,
    runProject,
    enableProject,
  };
}

function registration(
  state: ProjectSyncRegistration["state"],
  overrides: Partial<ProjectSyncRegistration> = {},
): ProjectSyncRegistration {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    state,
    consentRevision: 2,
    keyVersion: 1,
    revision: 4,
    plaintextBootstrapCompleted: state === "enabled" || state === "paused" || state === "error",
    lastErrorCode: state === "error" ? "SYNC_TEST_ERROR" : null,
    createdAt: NOW,
    updatedAt: NOW,
    enabledAt: state === "enabled" ? NOW : null,
    pausedAt: state === "paused" ? NOW : null,
    ...overrides,
  };
}

function runtimeResult(
  state: CloudSyncRuntimeState,
  code = "SYNC_TEST_FAILURE",
): CloudSyncRuntimeResult {
  const completed = state === "completed";
  return {
    projectId: PROJECT_ID,
    state,
    phase: completed ? "complete" : "sync",
    pushAllowed: completed,
    binding: null,
    failure: completed
      ? null
      : {
          phase: "sync",
          category:
            state === "offline" ||
            state === "retryable" ||
            state === "conflict_blocked" ||
            state === "auth_blocked" ||
            state === "key_blocked" ||
            state === "permanent_paused"
              ? state
              : "configuration_error",
          code,
        },
    bootstrap: null,
    snapshotMaterialization: null,
    incrementalIntake: null,
    projection: null,
    projectionSummary: null,
    sync: null,
  };
}

function enrollmentResult(
  enrolled: ProjectSyncRegistration,
  runtime: CloudSyncRuntimeResult,
): CloudProjectSyncEnableResult {
  return {
    operation: "enable",
    projectId: PROJECT_ID,
    state: "enabled",
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    consentRevision: enrolled.consentRevision,
    keyVersion: enrolled.keyVersion,
    registration: enrolled,
    runtime,
    failure: null,
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

function expectDomain<Value>(
  result: Readonly<{ ok: true; value: Value } | { ok: false; error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
