import type { InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import type { SqlExecutor } from "@inkshadow/data";
import type { ProjectKeySqliteStore } from "@inkshadow/data/project-key-sqlite-store";
import type { SyncSqliteStore } from "@inkshadow/data/sync-sqlite-store";
import type { Clock, UuidV7Generator } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type { CloudProjectKeyCoordinator } from "./cloud-project-key-coordinator";
import type { CloudSessionCoordinator } from "./cloud-session-coordinator";
import {
  CheckpointAwareCloudProjectKeyPublisher,
  createCloudProjectSyncEnrollmentService,
  createCloudSyncRuntimeService,
  createCloudSyncSupervisor,
  type CloudSyncEnrollmentWiringDependencies,
  type CloudSyncRuntimeWiringDependencies,
  type CloudSyncSupervisorWiringDependencies,
} from "./cloud-sync-runtime-wiring";
import type { CloudSyncRuntimeService } from "./cloud-sync-runtime-service";
import type { ProjectKeyLifecycleService } from "./project-key-lifecycle";
import { createDevelopmentRuntime, recoverOptionalMultiAgentReviewAtStartup } from "./runtime";

describe("desktop cloud gates", () => {
  it("keeps the core local runtime usable when optional multi-Agent recovery degrades", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const diagnostic = vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);

    const recovery = await recoverOptionalMultiAgentReviewAtStartup({
      recoverInterruptedReviews: vi.fn().mockRejectedValue(new Error("damaged history")),
    });
    const project = await runtime.useCases.createProject.execute({
      name: "Recovery isolation",
    });

    expect(recovery).toEqual({
      state: "degraded",
      recoveredSessionCount: 0,
      errorCode: "MULTI_AGENT_STARTUP_RECOVERY_FAILED",
    });
    expect(project.ok).toBe(true);
    expect(diagnostic).toHaveBeenCalledWith(
      "[MULTI_AGENT_STARTUP_RECOVERY_FAILED] Optional review recovery was degraded.",
    );
    diagnostic.mockRestore();
    await runtime.close();
  });

  it("keeps cloud identity and synchronization disabled in the default local runtime", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);

    expect(runtime.featureFlags.cloudIdentity).toBe(false);
    expect(runtime.featureFlags.cloudSync).toBe(false);
    expect("cloudSessionVault" in runtime).toBe(false);
    expect(runtime.cloudFoundation).toBeNull();
    expect(runtime.cloudIdentity).toBeNull();
    expect(runtime.cloudSession).toBeNull();
    expect(runtime.cloudTeams).toBeNull();
    expect(runtime.cloudAiUsage).toBeNull();
    expect(runtime.cloudAccount).toBeNull();
    expect(runtime.cloudTeamProjectKeys).toBeNull();
    expect(runtime.cloudProjectKeys).toBeNull();
    expect(runtime.cloudSync).toBeNull();
    expect(runtime.cloudSyncEnrollment).toBeNull();
    expect(runtime.cloudSyncSupervisor).toBeNull();

    await runtime.close();
  });

  it("does not allocate any protocol-v2 component while cloud sync is disabled", () => {
    const next = vi.fn();
    const dependencies = createCompleteWiringDependencies(next);

    const cloudSync = createCloudSyncRuntimeService({
      ...dependencies,
      enabled: false,
    });

    expect(cloudSync).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps the protocol-v2 runtime null outside Tauri even with complete dependencies", () => {
    const next = vi.fn();
    const dependencies = createCompleteWiringDependencies(next);

    const cloudSync = createCloudSyncRuntimeService({
      ...dependencies,
      mode: "browser-development",
    });

    expect(cloudSync).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when any required native cloud dependency is unavailable", () => {
    const next = vi.fn();
    const dependencies = createCompleteWiringDependencies(next);

    const cloudSync = createCloudSyncRuntimeService({
      ...dependencies,
      cloudProjectKeys: null,
    });

    expect(cloudSync).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it("constructs one enabled runtime and allocates stable worker identities only when complete", () => {
    const next = vi
      .fn()
      .mockReturnValueOnce("018f0000-0000-7000-8000-000000000001")
      .mockReturnValueOnce("018f0000-0000-7000-8000-000000000002");

    const cloudSync = createCloudSyncRuntimeService(createCompleteWiringDependencies(next));

    expect(cloudSync).not.toBeNull();
    expect(cloudSync?.isEnabled).toBe(true);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("keeps project enrollment unavailable without the complete opted-in runtime", () => {
    const dependencies = createCompleteEnrollmentDependencies();

    expect(
      createCloudProjectSyncEnrollmentService({
        ...dependencies,
        cloudSync: null,
      }),
    ).toBeNull();
    expect(
      createCloudProjectSyncEnrollmentService({
        ...dependencies,
        enabled: false,
      }),
    ).toBeNull();
  });

  it("constructs the explicit project enrollment boundary only when native sync is complete", () => {
    const enrollment = createCloudProjectSyncEnrollmentService(
      createCompleteEnrollmentDependencies(),
    );

    expect(enrollment).not.toBeNull();
    expect(enrollment?.isEnabled).toBe(true);
  });

  it("passes and verifies the complete frozen authority at the key-publication wiring boundary", async () => {
    const authority = {
      projectId: "019f9f4a-b3c7-7350-9226-000000000001",
      accountId: "019f9f4a-b3c7-7350-9226-000000000002",
      deviceId: "019f9f4a-b3c7-7350-9226-000000000003",
      devicePublicKeyFingerprint: "a".repeat(64),
      keyVersion: 1,
    };
    const ensureProjectKeyPublished = vi.fn().mockResolvedValue(authority);
    const publisher = new CheckpointAwareCloudProjectKeyPublisher({
      ensureProjectKeyPublished,
    });

    await expect(publisher.ensurePublished(authority)).resolves.toEqual(authority);
    expect(ensureProjectKeyPublished).toHaveBeenCalledWith(authority, {});
  });

  it("rejects publication evidence that changes any frozen principal field", async () => {
    const authority = {
      projectId: "019f9f4a-b3c7-7350-9226-000000000001",
      accountId: "019f9f4a-b3c7-7350-9226-000000000002",
      deviceId: "019f9f4a-b3c7-7350-9226-000000000003",
      devicePublicKeyFingerprint: "a".repeat(64),
      keyVersion: 1,
    };
    const publisher = new CheckpointAwareCloudProjectKeyPublisher({
      ensureProjectKeyPublished: vi.fn().mockResolvedValue({
        ...authority,
        devicePublicKeyFingerprint: "b".repeat(64),
      }),
    });

    await expect(publisher.ensurePublished(authority)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: {
        reasonCode: "SYNC_ENROLLMENT_KEY_PUBLICATION_RESULT_MISMATCH",
      },
    });
  });

  it("keeps the continuous supervisor behind the complete native sync boundary", () => {
    const dependencies = createCompleteSupervisorDependencies();

    expect(createCloudSyncSupervisor({ ...dependencies, enabled: false })).toBeNull();
    expect(createCloudSyncSupervisor({ ...dependencies, mode: "browser-development" })).toBeNull();
    expect(createCloudSyncSupervisor({ ...dependencies, cloudSync: null })).toBeNull();

    const supervisor = createCloudSyncSupervisor(dependencies);
    expect(supervisor).not.toBeNull();
    expect(supervisor?.isEnabled).toBe(true);
    expect(supervisor?.isRunning).toBe(false);
  });
});

function createCompleteWiringDependencies(
  next: ReturnType<typeof vi.fn>,
): CloudSyncRuntimeWiringDependencies {
  const executor: SqlExecutor = {
    select: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
  return {
    mode: "tauri",
    enabled: true,
    executor,
    syncStore: {} as SyncSqliteStore,
    api: {} as InkShadowCloudApiClient,
    session: {} as CloudSessionCoordinator,
    projectSecurity: {} as ProjectKeyLifecycleService,
    cloudProjectKeys: {} as CloudProjectKeyCoordinator,
    ids: { next } as UuidV7Generator,
    clock: {
      now: () => "2026-07-28T00:00:00.000Z",
    } as Clock,
  };
}

function createCompleteEnrollmentDependencies(): CloudSyncEnrollmentWiringDependencies {
  const executor: SqlExecutor = {
    select: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  };
  return {
    mode: "tauri",
    enabled: true,
    executor,
    syncStore: {} as SyncSqliteStore,
    projectKeyStore: {} as ProjectKeySqliteStore,
    session: {} as CloudSessionCoordinator,
    cloudProjectKeys: {} as CloudProjectKeyCoordinator,
    cloudSync: {} as CloudSyncRuntimeService,
    clock: {
      now: () => "2026-07-28T00:00:00.000Z",
    } as Clock,
  };
}

function createCompleteSupervisorDependencies(): CloudSyncSupervisorWiringDependencies {
  return {
    mode: "tauri",
    enabled: true,
    executor: {
      select: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
      close: vi.fn(),
    },
    cloudSync: {} as CloudSyncRuntimeService,
  };
}
