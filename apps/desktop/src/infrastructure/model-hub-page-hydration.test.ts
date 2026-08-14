import { describe, expect, it, vi } from "vitest";

import {
  ModelHubOperationCoordinator,
  createInitialModelHubPageSnapshot,
  createProviderDraftModelHubPageSnapshot,
  loadAuthoritativeModelHubHydration,
  preserveModelHubPageSnapshotAfterFailure,
} from "./model-hub-page-hydration";
import { createDevelopmentRuntime } from "./runtime";

describe("Model Hub page hydration", () => {
  it("hydrates an existing connection, delayed keyring summary and cached catalog as one snapshot", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    let connection = await runtime.modelHub.saveConnection({
      id: "deepseek-cold-start",
      providerKind: "deepseek",
      displayName: "DeepSeek",
      credentialRef: "keyring:model-hub:deepseek-cold-start",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await runtime.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    await runtime.modelHub.syncCatalog({
      syncId: "deepseek-cold-start-sync",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [
        { id: "deepseek-cold-start-fast", providerModelId: "deepseek-fast" },
        { id: "deepseek-cold-start-quality", providerModelId: "deepseek-quality" },
      ],
    });
    const credential = deferred<Readonly<{ configured: boolean; lastFour: string | null }>>();
    const getSummary = vi.fn(() => credential.promise);
    const phases: string[] = [];
    const hydrationPromise = loadAuthoritativeModelHubHydration({
      modelHub: runtime.modelHub,
      credentials: { getSummary },
      mode: "tauri",
      clock: runtime.clock,
      snapshotRevision: 1,
      lastAction: "bootstrap",
      onPhase: (phase) => phases.push(phase),
    });

    await vi.waitFor(() => expect(getSummary).toHaveBeenCalledWith("deepseek-cold-start"));
    expect(phases).toEqual(["LOADING_CONNECTIONS", "RESTORING_SELECTION", "CHECKING_CREDENTIAL"]);
    credential.resolve({ configured: true, lastFour: "3172" });
    const hydrated = await hydrationPromise;

    expect(hydrated.page).toMatchObject({
      phase: "READY",
      selectedConnectionId: "deepseek-cold-start",
      credentialStatus: "configured",
      catalogStatus: "ready",
      selectedModelId: "deepseek-fast",
      snapshotRevision: 1,
    });
    expect(hydrated.page.catalogEntries).toHaveLength(2);
    expect(phases).toEqual([
      "LOADING_CONNECTIONS",
      "RESTORING_SELECTION",
      "CHECKING_CREDENTIAL",
      "LOADING_CATALOG",
    ]);
  });

  it("keeps keyring read failure distinct from a confirmed missing credential", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.modelHub.saveConnection({
      id: "credential-error",
      providerKind: "deepseek",
      displayName: "DeepSeek",
      credentialRef: "keyring:model-hub:credential-error",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });

    const hydrated = await loadAuthoritativeModelHubHydration({
      modelHub: runtime.modelHub,
      credentials: {
        getSummary: () =>
          Promise.reject(Object.assign(new Error("keyring busy"), { code: "KEYRING_BUSY" })),
      },
      mode: "tauri",
      clock: runtime.clock,
      snapshotRevision: 1,
      lastAction: "bootstrap",
    });

    expect(hydrated.credential).toBeNull();
    expect(hydrated.page).toMatchObject({
      phase: "READY_WITH_WARNINGS",
      credentialStatus: "error",
      errorCode: "KEYRING_BUSY",
    });
  });

  it("keeps an empty Model Hub in the unconfigured state instead of treating it as keyless", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const getSummary = vi.fn();

    const hydrated = await loadAuthoritativeModelHubHydration({
      modelHub: runtime.modelHub,
      credentials: { getSummary },
      mode: "tauri",
      clock: runtime.clock,
      snapshotRevision: 1,
      lastAction: "bootstrap",
    });

    expect(getSummary).not.toHaveBeenCalled();
    expect(hydrated.selectedConnection).toBeNull();
    expect(hydrated.page).toMatchObject({
      phase: "READY",
      selectedConnectionId: null,
      credentialStatus: "missing",
      catalogStatus: "empty",
    });
  });

  it("does not query the keyring or report missing credentials for Ollama", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.modelHub.saveConnection({
      id: "local-ollama",
      providerKind: "ollama",
      displayName: "Ollama",
      credentialRef: null,
      credentialState: "missing",
      authenticationMode: "none",
      enabled: true,
      expectedRevision: null,
    });
    const getSummary = vi.fn();

    const hydrated = await loadAuthoritativeModelHubHydration({
      modelHub: runtime.modelHub,
      credentials: { getSummary },
      mode: "tauri",
      clock: runtime.clock,
      snapshotRevision: 1,
      lastAction: "bootstrap",
    });

    expect(getSummary).not.toHaveBeenCalled();
    expect(hydrated.page.credentialStatus).toBe("not_required");
  });

  it("restores the connection used by the persisted prose route before falling back to the first connection", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    for (const connectionId of ["first-connection", "routed-connection"] as const) {
      await runtime.modelHub.saveConnection({
        id: connectionId,
        providerKind: connectionId === "routed-connection" ? "deepseek" : "openai",
        displayName: connectionId,
        credentialRef: `keyring:model-hub:${connectionId}`,
        credentialState: "present",
        authenticationMode: "bearer_keyring",
        enabled: true,
        expectedRevision: null,
      });
      await runtime.modelHub.syncCatalog({
        syncId: `${connectionId}-sync`,
        connectionId,
        source: "provider_api",
        status: "succeeded",
        models: [
          {
            id: `${connectionId}-catalog`,
            providerModelId: `${connectionId}-model`,
          },
        ],
      });
    }
    await runtime.modelHub.saveTaskRoute({
      task: "prose_generation",
      primaryCatalogEntryId: "routed-connection-catalog",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });
    const getSummary = vi.fn(() => Promise.resolve({ configured: true, lastFour: "3172" }));

    const hydrated = await loadAuthoritativeModelHubHydration({
      modelHub: runtime.modelHub,
      credentials: { getSummary },
      mode: "tauri",
      clock: runtime.clock,
      snapshotRevision: 1,
      lastAction: "bootstrap",
    });

    expect(hydrated.page.selectedConnectionId).toBe("routed-connection");
    expect(hydrated.page.selectedModelId).toBe("routed-connection-model");
    expect(getSummary).toHaveBeenCalledWith("routed-connection");
  });

  it("does not let a disabled prose route drive the restored connection", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    for (const connectionId of ["aaa-first-enabled", "disabled-route-target"] as const) {
      await runtime.modelHub.saveConnection({
        id: connectionId,
        providerKind: connectionId === "disabled-route-target" ? "deepseek" : "openai",
        displayName: connectionId,
        credentialRef: `keyring:model-hub:${connectionId}`,
        credentialState: "present",
        authenticationMode: "bearer_keyring",
        enabled: true,
        expectedRevision: null,
      });
      await runtime.modelHub.syncCatalog({
        syncId: `${connectionId}-sync`,
        connectionId,
        source: "provider_api",
        status: "succeeded",
        models: [
          {
            id: `${connectionId}-catalog`,
            providerModelId: `${connectionId}-model`,
          },
        ],
      });
    }
    const firstEnabled = await runtime.modelHub.findConnection("aaa-first-enabled");
    if (firstEnabled === null) throw new Error("Expected the fallback connection.");
    await runtime.modelHub.recordConnectionTest({
      connectionId: firstEnabled.id,
      status: "ready",
      expectedRevision: firstEnabled.revision,
    });
    await runtime.modelHub.saveTaskRoute({
      task: "prose_generation",
      primaryCatalogEntryId: "disabled-route-target-catalog",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "user",
      enabled: false,
      expectedRevision: null,
    });

    const hydrated = await loadAuthoritativeModelHubHydration({
      modelHub: runtime.modelHub,
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "3172" }),
      },
      mode: "tauri",
      clock: runtime.clock,
      snapshotRevision: 1,
      lastAction: "bootstrap",
    });

    expect(hydrated.page.selectedConnectionId).toBe("aaa-first-enabled");
    expect(hydrated.page.selectedModelId).toBe("aaa-first-enabled-model");
  });

  it("loads an explicitly requested disabled connection for rebind without reading a guessed credential slot", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const active = await runtime.modelHub.saveConnection({
      id: "active-fallback",
      providerKind: "openai",
      displayName: "Active fallback",
      credentialRef: "keyring:model-hub:active-fallback",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const retiredSource = await runtime.modelHub.saveConnection({
      id: "retired-route-target",
      providerKind: "deepseek",
      displayName: "Retired route target",
      credentialRef: "keyring:model-hub:retired-route-target",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    await runtime.modelHub.saveConnection({
      id: "disabled-request-target",
      providerKind: "deepseek",
      displayName: "Disabled request target",
      credentialState: "missing",
      authenticationMode: "bearer_keyring",
      enabled: false,
      expectedRevision: null,
    });
    await runtime.modelHub.syncCatalog({
      syncId: "active-fallback-sync",
      connectionId: active.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "active-fallback-catalog", providerModelId: "active-model" }],
    });
    await runtime.modelHub.syncCatalog({
      syncId: "retired-route-target-sync",
      connectionId: retiredSource.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "retired-route-target-catalog", providerModelId: "retired-model" }],
    });
    await runtime.modelHub.saveTaskRoute({
      task: "prose_generation",
      primaryCatalogEntryId: "retired-route-target-catalog",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });
    const currentRetiredSource = await runtime.modelHub.findConnection(retiredSource.id);
    if (currentRetiredSource === null) throw new Error("Expected the route target connection.");
    await runtime.modelHub.retireConnection({
      connectionId: retiredSource.id,
      expectedRevision: currentRetiredSource.revision,
    });
    const getSummary = vi.fn(() => Promise.resolve({ configured: true, lastFour: "3172" }));

    const hydrated = await loadAuthoritativeModelHubHydration({
      modelHub: runtime.modelHub,
      credentials: { getSummary },
      mode: "tauri",
      clock: runtime.clock,
      requestedConnectionId: "disabled-request-target",
      snapshotRevision: 1,
      lastAction: "bootstrap",
    });

    expect(hydrated.page.connections).toHaveLength(3);
    expect(hydrated.page.selectedConnectionId).toBe("disabled-request-target");
    expect(hydrated.page.selectedModelId).toBeNull();
    expect(hydrated.credential).toEqual({ configured: false, lastFour: null });
    expect(getSummary).not.toHaveBeenCalled();
  });

  it("keeps the cached catalog ready when the system credential status reaches its deadline", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.modelHub.saveConnection({
      id: "credential-timeout",
      providerKind: "deepseek",
      displayName: "DeepSeek timeout",
      credentialRef: "keyring:model-hub:credential-timeout",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    await runtime.modelHub.syncCatalog({
      syncId: "credential-timeout-sync",
      connectionId: "credential-timeout",
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "credential-timeout-model", providerModelId: "deepseek-v4-flash" }],
    });
    const lateCredential = deferred<Readonly<{ configured: boolean; lastFour: string | null }>>();
    const getSummary = vi.fn(() => lateCredential.promise);

    const hydrated = await loadAuthoritativeModelHubHydration({
      modelHub: runtime.modelHub,
      credentials: { getSummary },
      mode: "tauri",
      clock: runtime.clock,
      requestedConnectionId: "credential-timeout",
      snapshotRevision: 1,
      lastAction: "bootstrap",
      credentialTimeoutMs: 0,
    });

    expect(hydrated.page).toMatchObject({
      phase: "READY_WITH_WARNINGS",
      credentialStatus: "error",
      catalogStatus: "ready",
      selectedConnectionId: "credential-timeout",
      selectedModelId: "deepseek-v4-flash",
      errorCode: "MODEL_HUB_CREDENTIAL_STATUS_TIMEOUT",
    });
    expect(hydrated.page.catalogEntries).toHaveLength(1);
    expect(getSummary).toHaveBeenCalledTimes(1);

    lateCredential.resolve({ configured: true, lastFour: "3172" });
    await Promise.resolve();
    expect(hydrated.page.credentialStatus).toBe("error");
    expect(hydrated.page.catalogEntries).toHaveLength(1);
  });

  it("creates a provider draft without carrying credential, catalog, or error state", () => {
    const current = {
      ...createInitialModelHubPageSnapshot(),
      phase: "READY_WITH_WARNINGS" as const,
      providerKind: "ollama" as const,
      selectedConnectionId: "local-ollama",
      credentialStatus: "not_required" as const,
      catalogStatus: "cached_warning" as const,
      catalogEntries: [{ id: "old-catalog" } as never],
      selectedModelId: "old-model",
      capabilityStatus: "ready" as const,
      errorCode: "MODEL_DIRECTORY_UNAVAILABLE",
      hydratedAt: "2026-08-10T00:00:00.000Z",
      snapshotRevision: 4,
    };

    expect(
      createProviderDraftModelHubPageSnapshot(current, {
        providerKind: "deepseek",
        credentialRequired: true,
        hydratedAt: "2026-08-10T00:01:00.000Z",
        snapshotRevision: 5,
      }),
    ).toMatchObject({
      phase: "READY",
      providerKind: "deepseek",
      selectedConnectionId: null,
      credentialStatus: "missing",
      catalogStatus: "empty",
      catalogEntries: [],
      selectedModelId: null,
      capabilityStatus: "empty",
      errorCode: null,
      snapshotRevision: 5,
    });
  });

  it("rejects a slow old target after a newer selection wins", () => {
    const coordinator = new ModelHubOperationCoordinator();
    const oldTarget = coordinator.begin("restore_selection", {
      providerKind: "deepseek",
      connectionId: "old-deepseek",
    });
    const currentTarget = coordinator.begin("restore_selection", {
      providerKind: "ollama",
      connectionId: "current-ollama",
    });

    expect(
      coordinator.isCurrent(currentTarget, {
        providerKind: "ollama",
        connectionId: "current-ollama",
      }),
    ).toBe(true);
    expect(
      coordinator.isCurrent(oldTarget, {
        providerKind: "deepseek",
        connectionId: "old-deepseek",
      }),
    ).toBe(false);
  });

  it("allocates unique operation identities for separate page mounts", () => {
    const firstMount = new ModelHubOperationCoordinator();
    const secondMount = new ModelHubOperationCoordinator();
    const firstBootstrap = firstMount.begin("bootstrap");
    const secondBootstrap = secondMount.begin("bootstrap");

    expect(firstBootstrap.generation).toBe(1);
    expect(secondBootstrap.generation).toBe(1);
    expect(firstBootstrap.operationId).not.toBe(secondBootstrap.operationId);
    expect(firstMount.isCurrent(firstBootstrap)).toBe(true);
    expect(secondMount.isCurrent(secondBootstrap)).toBe(true);
    expect(firstMount.isCurrent(secondBootstrap)).toBe(false);
    expect(secondMount.isCurrent(firstBootstrap)).toBe(false);
  });

  it("deduplicates StrictMode bootstrap mutations while allowing the current generation to apply", async () => {
    const coordinator = new ModelHubOperationCoordinator();
    const bridge = deferred<number>();
    const loader = vi.fn(() => bridge.promise);
    const first = coordinator.runDeduplicated("legacy-bridge", loader);
    const second = coordinator.runDeduplicated("legacy-bridge", loader);

    expect(loader).toHaveBeenCalledTimes(1);
    bridge.resolve(1);
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
  });

  it("cleans up a rejected deduplicated operation without creating a rejected cleanup promise", async () => {
    const coordinator = new ModelHubOperationCoordinator();
    const loader = vi.fn(() => Promise.reject(new Error("bridge failed")));

    await expect(coordinator.runDeduplicated("legacy-bridge", loader)).rejects.toThrow(
      "bridge failed",
    );
    await expect(coordinator.runDeduplicated("legacy-bridge", loader)).rejects.toThrow(
      "bridge failed",
    );
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("preserves a valid cached catalog when a refresh fails", () => {
    const initial = createInitialModelHubPageSnapshot();
    const cached = {
      ...initial,
      phase: "READY" as const,
      hydratedAt: "2026-08-10T00:00:00.000Z",
      catalogStatus: "ready" as const,
      catalogEntries: [
        {
          id: "cached-entry",
        } as never,
      ],
    };

    const failed = preserveModelHubPageSnapshotAfterFailure(cached, {
      action: "discover_models",
      errorCode: "MODEL_DIRECTORY_UNAVAILABLE",
      catalogRefreshFailed: true,
      hydratedAt: "2026-08-10T00:01:00.000Z",
    });

    expect(failed.phase).toBe("READY_WITH_WARNINGS");
    expect(failed.catalogStatus).toBe("cached_warning");
    expect(failed.catalogEntries).toEqual(cached.catalogEntries);
  });

  it("does not turn a connection-load bootstrap failure into a credential failure", () => {
    const current = {
      ...createInitialModelHubPageSnapshot(),
      credentialStatus: "configured" as const,
    };

    const failed = preserveModelHubPageSnapshotAfterFailure(current, {
      action: "bootstrap",
      failedPhase: "LOADING_CONNECTIONS",
      errorCode: "SQLITE_OPERATION_FAILED",
      hydratedAt: "2026-08-10T00:01:00.000Z",
    });

    expect(failed.phase).toBe("ERROR");
    expect(failed.credentialStatus).toBe("configured");
  });
});

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
