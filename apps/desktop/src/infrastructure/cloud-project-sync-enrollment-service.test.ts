import type {
  BeginProjectSyncEnableInput,
  DisableProjectSyncInput,
  ProjectKeyBundle,
  ProjectSyncRegistration,
} from "@inkshadow/data";
import type { ProjectSyncBlockingState } from "@inkshadow/data/sync-sqlite-store";
import { AppError, err, ok, type Clock } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import {
  CloudSessionCoordinatorError,
  type ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import {
  CloudProjectSyncEnrollmentService,
  type CloudProjectSyncEnrollmentServiceDependencies,
  type CloudProjectSyncKeyPublicationEvidence,
} from "./cloud-project-sync-enrollment-service";
import type { CloudSyncRuntimeResult, CloudSyncRuntimeState } from "./cloud-sync-runtime-service";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OTHER_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const OTHER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const RECOVERY_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const NOW = "2026-07-28T01:00:00.000Z";
const DEVICE_PUBLIC_KEY_FINGERPRINT = "b".repeat(64);

describe("CloudProjectSyncEnrollmentService", () => {
  it("is default-off and touches no session, database, key, publication, or runtime port", async () => {
    const fixture = createFixture({ enabled: false });

    await expect(fixture.service.enableProject("not-even-a-project-id")).resolves.toMatchObject({
      operation: "enable",
      state: "configuration_disabled",
      registration: null,
      runtime: null,
    });
    await expect(fixture.service.disableProject("not-even-a-project-id")).resolves.toMatchObject({
      operation: "disable",
      state: "configuration_disabled",
      registration: null,
    });
    await expect(
      fixture.service.loadProjectRegistration("not-even-a-project-id"),
    ).resolves.toBeNull();
    expect(fixture.runWithSession).not.toHaveBeenCalled();
    expect(fixture.loadRegistration).not.toHaveBeenCalled();
    expect(fixture.readBlockingState).not.toHaveBeenCalled();
    expect(fixture.loadProjectKeyBundle).not.toHaveBeenCalled();
    expect(fixture.ensurePublished).not.toHaveBeenCalled();
    expect(fixture.beginEnableIfTransportClean).not.toHaveBeenCalled();
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("loads the durable project registration without starting enrollment work", async () => {
    const existing = registration("enabled", {
      plaintextBootstrapCompleted: true,
      enabledAt: NOW,
    });
    const fixture = createFixture({ initialRegistration: existing });

    await expect(fixture.service.loadProjectRegistration(PROJECT_ID)).resolves.toEqual(existing);
    expect(fixture.loadRegistration).toHaveBeenCalledTimes(1);
    expect(fixture.runWithSession).not.toHaveBeenCalled();
    expect(fixture.ensurePublished).not.toHaveBeenCalled();
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("enrolls first consent at revision one only after an exact confirmed key is published", async () => {
    const order: string[] = [];
    const fixture = createFixture({ order });

    const result = await fixture.service.enableProject(PROJECT_ID);

    expect(result).toMatchObject({
      operation: "enable",
      projectId: PROJECT_ID,
      state: "enabled",
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      consentRevision: 1,
      keyVersion: 1,
      registration: {
        state: "enabled",
        plaintextBootstrapCompleted: true,
        consentRevision: 1,
      },
      runtime: { state: "completed", phase: "complete", pushAllowed: true },
      failure: null,
    });
    expect(fixture.beginEnableIfTransportClean).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      consentRevision: 1,
      keyVersion: 1,
      expectedRevision: null,
      begunAt: NOW,
    });
    const publicationOptions = (
      fixture.ensurePublished.mock.calls[0] as unknown as readonly [
        unknown,
        Readonly<{ signal?: AbortSignal }>,
      ]
    )[1];
    expect(publicationOptions.signal).toBeInstanceOf(AbortSignal);
    expect(fixture.ensurePublished).toHaveBeenCalledWith(
      {
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        devicePublicKeyFingerprint: DEVICE_PUBLIC_KEY_FINGERPRINT,
        keyVersion: 1,
      },
      { signal: publicationOptions.signal },
    );
    expect(order).toEqual([
      "session",
      "registration_read",
      "transport_audit",
      "key_read",
      "key_publication",
      "registration_begin",
      "runtime_resume",
      "runtime",
      "registration_read",
    ]);
  });

  it("increments consent exactly once when a clean disabled registration is re-enabled", async () => {
    const fixture = createFixture({
      initialRegistration: registration("disabled", {
        consentRevision: 4,
        keyVersion: 1,
        revision: 9,
      }),
      keyBundle: activeBundle(2),
    });

    const result = await fixture.service.enableProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "enabled",
      consentRevision: 5,
      keyVersion: 2,
      registration: { consentRevision: 5, keyVersion: 2 },
    });
    expect(fixture.beginEnableIfTransportClean).toHaveBeenCalledWith(
      expect.objectContaining({
        consentRevision: 5,
        keyVersion: 2,
        expectedRevision: 9,
      }),
    );
  });

  it("fails closed on every unacknowledged old outbox record without clearing audit ciphertext", async () => {
    const fixture = createFixture({
      initialRegistration: registration("disabled", {
        consentRevision: 2,
        revision: 8,
      }),
      blocking: {
        outgoingPendingCount: 1,
        outgoingPausedCount: 2,
        outgoingAttemptExhaustedCount: 1,
      },
      finalTransportDirty: true,
    });

    await expect(fixture.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      name: "CloudProjectSyncEnrollmentError",
      code: "SYNC_ENROLLMENT_UNACKNOWLEDGED_OUTBOX",
      phase: "registration",
      retryable: false,
      details: {
        operation: "SYNC_ENROLLMENT_UNACKNOWLEDGED_OUTBOX",
        unacknowledgedOutboxCount: 3,
      },
    });
    expect(fixture.loadProjectKeyBundle).toHaveBeenCalledTimes(1);
    expect(fixture.ensurePublished).toHaveBeenCalledTimes(1);
    expect(fixture.beginEnableIfTransportClean).toHaveBeenCalledTimes(1);
    expect(fixture.disableProjectSync).not.toHaveBeenCalled();
    expect(fixture.runProject).not.toHaveBeenCalled();
    expect(fixture.getRegistration()).toMatchObject({
      state: "disabled",
      consentRevision: 2,
      revision: 8,
    });
  });

  it("treats the early transport audit as advisory and enforces the post-publication atomic gate", async () => {
    const earlyDirtyButFinallyClean = createFixture({
      initialRegistration: registration("disabled"),
      blocking: { outgoingPendingCount: 1 },
    });
    await expect(
      earlyDirtyButFinallyClean.service.enableProject(PROJECT_ID),
    ).resolves.toMatchObject({
      state: "enabled",
    });

    const racedDirty = createFixture({
      initialRegistration: registration("disabled"),
      finalTransportDirty: true,
    });
    await expect(racedDirty.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_UNACKNOWLEDGED_OUTBOX",
      phase: "registration",
      retryable: false,
    });
    expect(racedDirty.ensurePublished).toHaveBeenCalledTimes(1);
    expect(racedDirty.runProject).not.toHaveBeenCalled();
    expect(racedDirty.getRegistration()).toMatchObject({ state: "disabled" });
  });

  it("does not overwrite a registration owned by another account or device", async () => {
    const accountFixture = createFixture({
      initialRegistration: registration("disabled", { accountId: OTHER_ACCOUNT_ID }),
    });
    await expect(accountFixture.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_ACCOUNT_MISMATCH",
      phase: "authority",
    });
    expect(accountFixture.readBlockingState).not.toHaveBeenCalled();
    expect(accountFixture.beginEnableIfTransportClean).not.toHaveBeenCalled();

    const deviceFixture = createFixture({
      initialRegistration: registration("disabled", { deviceId: OTHER_DEVICE_ID }),
    });
    await expect(deviceFixture.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_DEVICE_MISMATCH",
      phase: "authority",
    });
    expect(deviceFixture.beginEnableIfTransportClean).not.toHaveBeenCalled();
  });

  it("requires an active local key and a confirmed, non-revoked recovery envelope", async () => {
    const missing = createFixture({ keyBundle: null });
    await expect(missing.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_LOCAL_KEY_REQUIRED",
      phase: "project_key",
    });
    expect(missing.ensurePublished).not.toHaveBeenCalled();

    const pending = createFixture({
      keyBundle: {
        ...activeBundle(1),
        recoveryEnvelope: {
          ...activeBundle(1).recoveryEnvelope,
          confirmedAt: null,
        },
      },
    });
    await expect(pending.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_RECOVERY_CONFIRMATION_REQUIRED",
      phase: "project_key",
    });
    expect(pending.beginEnableIfTransportClean).not.toHaveBeenCalled();
  });

  it("rejects mismatched publication evidence before opening registration authority", async () => {
    const fixture = createFixture({
      publicationEvidence: {
        projectId: PROJECT_ID,
        accountId: OTHER_ACCOUNT_ID,
        deviceId: DEVICE_ID,
        devicePublicKeyFingerprint: DEVICE_PUBLIC_KEY_FINGERPRINT,
        keyVersion: 1,
      },
    });

    await expect(fixture.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_KEY_PUBLICATION_MISMATCH",
      phase: "key_publication",
    });
    expect(fixture.beginEnableIfTransportClean).not.toHaveBeenCalled();
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("resumes an in-progress registration without churning consent or registration revision", async () => {
    const initial = registration("enabling", {
      consentRevision: 7,
      revision: 12,
    });
    const fixture = createFixture({ initialRegistration: initial });

    const result = await fixture.service.enableProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "enabled",
      consentRevision: 7,
      registration: { revision: 13 },
    });
    expect(fixture.beginEnableIfTransportClean).not.toHaveBeenCalled();
    expect(fixture.readBlockingState).not.toHaveBeenCalled();
  });

  it("keeps an in-progress registration retryable after an ordinary runtime failure", async () => {
    const initial = registration("enabling", {
      consentRevision: 3,
      revision: 5,
    });
    const fixture = createFixture({
      initialRegistration: initial,
      runtimeState: "offline",
    });

    const result = await fixture.service.enableProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "retryable",
      consentRevision: 3,
      registration: {
        state: "enabling",
        revision: 5,
        plaintextBootstrapCompleted: false,
      },
      runtime: { state: "offline" },
      failure: {
        phase: "runtime",
        code: "NETWORK_OFFLINE",
        retryable: true,
      },
    });
    expect(fixture.beginEnableIfTransportClean).not.toHaveBeenCalled();
    expect(fixture.disableProjectSync).not.toHaveBeenCalled();
  });

  it("never reports a ciphertext-only bootstrap registration as enabled", async () => {
    const fixture = createFixture({
      initialRegistration: registration("enabling"),
      runtimeState: "bootstrap_blocked",
      registrationAfterRuntime: registration("bootstrap_required", { revision: 2 }),
    });

    const result = await fixture.service.enableProject(PROJECT_ID);

    expect(result).toMatchObject({
      state: "blocked",
      registration: {
        state: "bootstrap_required",
        plaintextBootstrapCompleted: false,
      },
      runtime: { state: "bootstrap_blocked" },
    });
    expect(result.state).not.toBe("enabled");
  });

  it("rejects a runtime completed claim unless exact plaintext-enabled authority is persisted", async () => {
    const fixture = createFixture({
      initialRegistration: registration("enabling"),
      runtimeState: "completed",
      registrationAfterRuntime: registration("bootstrap_required", { revision: 2 }),
    });

    await expect(fixture.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_RUNTIME_COMPLETION_UNVERIFIED",
      phase: "verification",
    });
  });

  it("resets paused authority under the same consent but never silently changes its key", async () => {
    const paused = createFixture({
      initialRegistration: registration("paused", {
        consentRevision: 5,
        revision: 7,
        plaintextBootstrapCompleted: true,
        enabledAt: NOW,
        pausedAt: NOW,
      }),
    });

    await paused.service.enableProject(PROJECT_ID);

    expect(paused.beginEnableIfTransportClean).toHaveBeenCalledWith(
      expect.objectContaining({
        consentRevision: 5,
        keyVersion: 1,
        expectedRevision: 7,
      }),
    );

    const changedKey = createFixture({
      initialRegistration: registration("paused", {
        keyVersion: 1,
        pausedAt: NOW,
      }),
      keyBundle: activeBundle(2),
    });
    await expect(changedKey.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_KEY_AUTHORITY_MISMATCH",
      phase: "authority",
    });
    expect(changedKey.beginEnableIfTransportClean).not.toHaveBeenCalled();
  });

  it("disables from persisted identity and revision without a cloud session or cloud deletion", async () => {
    const initial = registration("enabled", {
      consentRevision: 6,
      revision: 11,
      plaintextBootstrapCompleted: true,
      enabledAt: NOW,
    });
    const fixture = createFixture({ initialRegistration: initial });

    const result = await fixture.service.disableProject(PROJECT_ID);

    expect(result).toMatchObject({
      operation: "disable",
      state: "disabled",
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      consentRevision: 6,
      registration: {
        state: "disabled",
        revision: 12,
        plaintextBootstrapCompleted: false,
      },
    });
    expect(fixture.disableProjectSync).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      expectedAccountId: ACCOUNT_ID,
      expectedDeviceId: DEVICE_ID,
      expectedRevision: 11,
      disabledAt: NOW,
    });
    expect(fixture.cancelAndWaitProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(fixture.runWithSession).not.toHaveBeenCalled();
    expect(fixture.ensurePublished).not.toHaveBeenCalled();
    expect(fixture.runProject).not.toHaveBeenCalled();
  });

  it("atomically revokes orphaned local transport even when no registration exists", async () => {
    const fixture = createFixture({ initialRegistration: null });

    await expect(fixture.service.disableProject(PROJECT_ID)).resolves.toMatchObject({
      state: "already_disabled",
      registration: null,
    });
    expect(fixture.disableProjectSync).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      expectedAccountId: null,
      expectedDeviceId: null,
      expectedRevision: null,
      disabledAt: NOW,
    });
    expect(fixture.runWithSession).not.toHaveBeenCalled();
  });

  it("returns aborted before side effects and also closes a mid-flight publication boundary", async () => {
    const early = createFixture();
    const earlyController = new AbortController();
    earlyController.abort();
    await expect(
      early.service.enableProject(PROJECT_ID, { signal: earlyController.signal }),
    ).resolves.toMatchObject({ state: "aborted" });
    expect(early.runWithSession).not.toHaveBeenCalled();

    const publication = deferred<CloudProjectSyncKeyPublicationEvidence>();
    const mid = createFixture({ publicationDeferred: publication });
    const midController = new AbortController();
    const result = mid.service.enableProject(PROJECT_ID, { signal: midController.signal });
    await vi.waitFor(() => expect(mid.ensurePublished).toHaveBeenCalledTimes(1));
    midController.abort();
    publication.resolve(publicationEvidence(1));

    await expect(result).resolves.toMatchObject({
      state: "aborted",
      registration: null,
      runtime: null,
    });
    expect(mid.beginEnableIfTransportClean).not.toHaveBeenCalled();
    expect(mid.runProject).not.toHaveBeenCalled();
  });

  it("shares enable flights while disable preempts and drains the active enable", async () => {
    const runtime = deferred<undefined>();
    const fixture = createFixture({
      initialRegistration: registration("enabling"),
      runtimeDeferred: runtime,
    });

    const first = fixture.service.enableProject(PROJECT_ID);
    const second = fixture.service.enableProject(PROJECT_ID);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(fixture.runProject).toHaveBeenCalledTimes(1));
    const disabled = fixture.service.disableProject(PROJECT_ID);
    expect(fixture.cancelAndWaitProject).toHaveBeenCalledWith(PROJECT_ID);
    await expect(first).resolves.toMatchObject({ state: "aborted" });
    await expect(disabled).resolves.toMatchObject({
      state: "disabled",
      registration: { state: "disabled" },
    });
    expect(fixture.runProject).toHaveBeenCalledTimes(1);
    expect(fixture.disableProjectSync).toHaveBeenCalledTimes(1);
  });

  it("rejects an inexact local disable receipt instead of reporting privacy revocation", async () => {
    const initial = registration("enabled", {
      revision: 11,
      plaintextBootstrapCompleted: true,
      enabledAt: NOW,
    });
    const fixture = createFixture({
      initialRegistration: initial,
      disableResult: registration("disabled", { revision: 99 }),
    });

    await expect(fixture.service.disableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "SYNC_ENROLLMENT_REGISTRATION_INVALID",
      phase: "registration",
      retryable: false,
    });
    expect(fixture.cancelAndWaitProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("preserves terminal cloud-session source code and reason without making it retryable", async () => {
    const fixture = createFixture({
      sessionError: new CloudSessionCoordinatorError(
        "device_revoked",
        "AUTH_DEVICE_REVOKED",
        "device revoked",
      ),
    });

    await expect(fixture.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      code: "AUTH_DEVICE_REVOKED",
      phase: "session",
      retryable: false,
      details: {
        reason: "device_revoked",
        sourceCode: "AUTH_DEVICE_REVOKED",
      },
    });
    expect(fixture.beginEnableIfTransportClean).not.toHaveBeenCalled();
  });

  it("preserves retry metadata when a key publication port fails before registration mutation", async () => {
    const fixture = createFixture({
      publicationError: new AppError({
        code: "REPOSITORY_ERROR",
        message: "publication temporarily unavailable",
        retryable: true,
        actions: ["RETRY"],
      }),
    });

    await expect(fixture.service.enableProject(PROJECT_ID)).rejects.toMatchObject({
      name: "CloudProjectSyncEnrollmentError",
      code: "REPOSITORY_ERROR",
      phase: "key_publication",
      retryable: true,
    });
    expect(fixture.beginEnableIfTransportClean).not.toHaveBeenCalled();
  });
});

interface FixtureOptions {
  readonly enabled?: boolean;
  readonly initialRegistration?: ProjectSyncRegistration | null;
  readonly keyBundle?: ProjectKeyBundle | null;
  readonly blocking?: Partial<ProjectSyncBlockingState>;
  readonly finalTransportDirty?: boolean;
  readonly sessionError?: Error;
  readonly publicationEvidence?: CloudProjectSyncKeyPublicationEvidence;
  readonly publicationError?: Error;
  readonly publicationDeferred?: Deferred<CloudProjectSyncKeyPublicationEvidence>;
  readonly runtimeState?: CloudSyncRuntimeState;
  readonly registrationAfterRuntime?: ProjectSyncRegistration;
  readonly runtimeDeferred?: Deferred<undefined>;
  readonly disableResult?: ProjectSyncRegistration | null;
  readonly order?: string[];
}

function createFixture(options: FixtureOptions = {}) {
  const order = options.order ?? [];
  let currentRegistration =
    "initialRegistration" in options ? (options.initialRegistration ?? null) : null;
  const configuredKeyBundle =
    "keyBundle" in options ? (options.keyBundle ?? null) : activeBundle(1);

  const runWithSession = vi.fn(
    (operation: (status: ConfiguredCloudSessionStatus) => Promise<unknown>) => {
      order.push("session");
      if (options.sessionError !== undefined) {
        throw options.sessionError;
      }
      return operation(configuredSession());
    },
  );
  const loadRegistration = vi.fn(() => {
    order.push("registration_read");
    return Promise.resolve(ok(currentRegistration));
  });
  const beginEnableIfTransportClean = vi.fn((input: BeginProjectSyncEnableInput) => {
    order.push("registration_begin");
    if (options.finalTransportDirty === true) {
      return Promise.resolve(
        err(
          new AppError({
            code: "INVALID_STATE_TRANSITION",
            message: "unacknowledged outbox",
            details: {
              operation: "SYNC_ENROLLMENT_UNACKNOWLEDGED_OUTBOX",
              unacknowledgedOutboxCount:
                (options.blocking?.outgoingPendingCount ?? 0) +
                  (options.blocking?.outgoingPausedCount ?? 0) || 1,
            },
          }),
        ),
      );
    }
    currentRegistration = registration("enabling", {
      accountId: input.accountId,
      deviceId: input.deviceId,
      consentRevision: input.consentRevision,
      keyVersion: input.keyVersion,
      revision: (currentRegistration?.revision ?? 0) + 1,
      createdAt: currentRegistration?.createdAt ?? input.begunAt,
      updatedAt: input.begunAt,
    });
    return Promise.resolve(ok(currentRegistration));
  });
  const disableProjectSync = vi.fn((input: DisableProjectSyncInput) => {
    if ("disableResult" in options) {
      return Promise.resolve(ok(options.disableResult ?? null));
    }
    if (currentRegistration === null) {
      return Promise.resolve(ok(null));
    }
    if (currentRegistration.state === "disabled") {
      return Promise.resolve(ok(currentRegistration));
    }
    currentRegistration = {
      ...currentRegistration,
      state: "disabled",
      revision: currentRegistration.revision + 1,
      plaintextBootstrapCompleted: false,
      lastErrorCode: null,
      updatedAt: input.disabledAt,
      enabledAt: null,
      pausedAt: null,
    };
    return Promise.resolve(ok(currentRegistration));
  });
  const readBlockingState = vi.fn(() => {
    order.push("transport_audit");
    return Promise.resolve(ok(blockingState(options.blocking)));
  });
  const loadProjectKeyBundle = vi.fn(() => {
    order.push("key_read");
    return Promise.resolve(ok(configuredKeyBundle));
  });
  const ensurePublished = vi.fn(() => {
    order.push("key_publication");
    if (options.publicationError !== undefined) {
      return Promise.reject(options.publicationError);
    }
    if (options.publicationDeferred !== undefined) {
      return options.publicationDeferred.promise;
    }
    return Promise.resolve(
      options.publicationEvidence ?? {
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        devicePublicKeyFingerprint: DEVICE_PUBLIC_KEY_FINGERPRINT,
        keyVersion: configuredKeyBundle?.version.keyVersion ?? 1,
      },
    );
  });
  const resumeProject = vi.fn(() => {
    order.push("runtime_resume");
  });
  const cancelAndWaitProject = vi.fn(() => {
    order.push("runtime_cancel");
    return Promise.resolve();
  });
  const runProject = vi.fn(
    async (
      _projectId: string,
      runOptions: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<CloudSyncRuntimeResult> => {
      order.push("runtime");
      if (options.runtimeDeferred !== undefined) {
        await waitForDeferredOrAbort(options.runtimeDeferred, runOptions.signal);
      }
      if (runOptions.signal?.aborted === true) {
        return runtimeResult("aborted", currentRegistration);
      }
      if (options.registrationAfterRuntime !== undefined) {
        currentRegistration = options.registrationAfterRuntime;
      } else if ((options.runtimeState ?? "completed") === "completed") {
        if (currentRegistration === null) {
          throw new Error("registration missing");
        }
        currentRegistration = {
          ...currentRegistration,
          state: "enabled",
          revision: currentRegistration.revision + 1,
          plaintextBootstrapCompleted: true,
          lastErrorCode: null,
          enabledAt: NOW,
          pausedAt: null,
        };
      }
      return runtimeResult(options.runtimeState ?? "completed", currentRegistration);
    },
  );
  const dependencies: CloudProjectSyncEnrollmentServiceDependencies = {
    enabled: options.enabled ?? true,
    session: {
      runWithSession:
        runWithSession as unknown as CloudProjectSyncEnrollmentServiceDependencies["session"]["runWithSession"],
    },
    authority: {
      loadProjectSyncRegistration: loadRegistration,
      beginProjectSyncEnableIfTransportClean: beginEnableIfTransportClean,
      disableProjectSync,
    },
    transportAudit: {
      readProjectSyncBlockingState: readBlockingState,
    },
    keyStore: {
      loadProjectKeyBundle,
    },
    keyPublication: {
      ensurePublished,
    },
    runtime: {
      cancelAndWaitProject,
      resumeProject,
      runProject,
    },
    clock: { now: () => NOW as ReturnType<Clock["now"]> },
  };
  return {
    service: new CloudProjectSyncEnrollmentService(dependencies),
    runWithSession,
    loadRegistration,
    beginEnableIfTransportClean,
    disableProjectSync,
    readBlockingState,
    loadProjectKeyBundle,
    ensurePublished,
    cancelAndWaitProject,
    resumeProject,
    runProject,
    getRegistration: () => currentRegistration,
  };
}

function configuredSession(): ConfiguredCloudSessionStatus {
  return {
    configured: true,
    account: { accountId: ACCOUNT_ID },
    device: {
      device: {
        deviceId: DEVICE_ID,
        publicKeyFingerprint: DEVICE_PUBLIC_KEY_FINGERPRINT,
      },
      publicKey: {
        publicKeyFingerprint: DEVICE_PUBLIC_KEY_FINGERPRINT,
      },
    },
    session: {},
    expiry: {},
  } as unknown as ConfiguredCloudSessionStatus;
}

function publicationEvidence(keyVersion: number): CloudProjectSyncKeyPublicationEvidence {
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    devicePublicKeyFingerprint: DEVICE_PUBLIC_KEY_FINGERPRINT,
    keyVersion,
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
    consentRevision: 1,
    keyVersion: 1,
    revision: 1,
    plaintextBootstrapCompleted: state === "enabled",
    lastErrorCode: state === "error" ? "SYNC_FAILED" : null,
    createdAt: NOW,
    updatedAt: NOW,
    enabledAt: state === "enabled" ? NOW : null,
    pausedAt: state === "paused" ? NOW : null,
    ...overrides,
  };
}

function blockingState(
  overrides: Partial<ProjectSyncBlockingState> = {},
): ProjectSyncBlockingState {
  return {
    projectId: PROJECT_ID,
    incomingConflictCount: 0,
    incomingPendingCount: 0,
    incomingPausedCount: 0,
    incomingAttemptExhaustedCount: 0,
    outgoingPendingCount: 0,
    outgoingPausedCount: 0,
    outgoingAttemptExhaustedCount: 0,
    ...overrides,
  };
}

function activeBundle(keyVersion: number): ProjectKeyBundle {
  return {
    version: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      keyVersion,
      algorithm: "AES-256-GCM",
      state: "active",
      revision: 2,
      createdAt: NOW,
      retiredAt: null,
    },
    deviceEnvelope: {
      schemaVersion: 1,
      algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
      envelopeId: ENVELOPE_ID,
      projectId: PROJECT_ID,
      keyVersion,
      senderDeviceId: DEVICE_ID,
      senderPublicKey: "A".repeat(87),
      senderPublicKeyFingerprint: "a".repeat(64),
      recipientDeviceId: DEVICE_ID,
      recipientPublicKey: "B".repeat(87),
      recipientPublicKeyFingerprint: DEVICE_PUBLIC_KEY_FINGERPRINT,
      encapsulatedKey: "C".repeat(87),
      ciphertext: "D".repeat(64),
      createdAt: NOW,
      revokedAt: null,
    },
    recoveryEnvelope: {
      schemaVersion: 1,
      algorithm: "ARGON2ID-AES256GCM",
      recoveryId: RECOVERY_ID,
      projectId: PROJECT_ID,
      keyVersion,
      kdf: {
        algorithm: "ARGON2ID",
        version: 19,
        memoryKib: 65_536,
        timeCost: 3,
        parallelism: 4,
        outputBytes: 64,
      },
      salt: "E".repeat(22),
      nonce: "F".repeat(16),
      ciphertext: "G".repeat(64),
      verifier: "H".repeat(43),
      createdAt: NOW,
      confirmedAt: NOW,
      revokedAt: null,
    },
  };
}

function runtimeResult(
  state: CloudSyncRuntimeState,
  current: ProjectSyncRegistration | null,
): CloudSyncRuntimeResult {
  const completed = state === "completed";
  return {
    projectId: PROJECT_ID,
    state,
    phase: completed ? "complete" : state === "bootstrap_blocked" ? "bootstrap" : "sync",
    pushAllowed: completed,
    binding:
      current === null
        ? null
        : {
            projectId: current.projectId,
            accountId: current.accountId,
            deviceId: current.deviceId,
            consentRevision: current.consentRevision,
            keyVersion: current.keyVersion,
            registrationRevision: current.revision,
          },
    failure: completed
      ? null
      : {
          phase: state === "bootstrap_blocked" ? "bootstrap" : "sync",
          category: state === "offline" ? "offline" : "bootstrap_blocked",
          code: state === "offline" ? "NETWORK_OFFLINE" : "SYNC_BOOTSTRAP_INCOMPLETE",
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
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: Deferred<Value>["resolve"] = () => undefined;
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitForDeferredOrAbort(
  value: Deferred<undefined>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await value.promise;
    return;
  }
  if (signal.aborted) {
    return;
  }
  let resolveAbort: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const abort = () => resolveAbort();
  signal.addEventListener("abort", abort, { once: true });
  await Promise.race([value.promise, aborted]);
  signal.removeEventListener("abort", abort);
}
