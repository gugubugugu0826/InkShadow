import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadAuthoritativeModelHubReadiness } from "./model-hub-authoritative-readiness";
import { inspectModelHubTextTask } from "./model-hub-execution-service";
import { createDevelopmentRuntime, type DesktopRuntime } from "./runtime";

const NOW = "2026-08-13T00:00:00.000Z";
const CORE_TASKS = [
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
  "chapter_summary",
  "long_memory_compression",
  "contradiction_check",
  "pov_check",
  "character_voice_check",
  "content_quality_check",
] as const;

describe("authoritative Model Hub readiness", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reports 10/10 only as content-free base configuration and performs no dispatch", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let connection = await development.modelHub.saveConnection({
      id: "authoritative-ready",
      providerKind: "openai",
      displayName: "Authoritative ready",
      credentialRef: "keyring:model-hub:authoritative-ready",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await development.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    const catalog = await development.modelHub.syncCatalog({
      syncId: "authoritative-ready-sync",
      connectionId: connection.id,
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "authoritative-ready-model",
          providerModelId: "writer",
          lifecycle: "stable",
          inputTokenLimit: 200_000,
          outputTokenLimit: 20_000,
          staleAfter: "2027-08-13T00:00:00.000Z",
        },
      ],
    });
    const model = catalog[0];
    if (model === undefined) throw new Error("Expected the test catalog entry.");
    await development.modelHub.recordCapabilityScan({
      scanId: "authoritative-ready-evidence",
      catalogEntryId: model.id,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "authoritative-readiness-v1",
      evidence: [
        {
          id: "authoritative-ready-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        },
      ],
    });
    await development.modelHub.saveCostPrivacyProfile({
      catalogEntryId: model.id,
      currency: "USD",
      inputMicrosPerMillionTokens: "1000",
      outputMicrosPerMillionTokens: "2000",
      cachedInputMicrosPerMillionTokens: null,
      pricingVersion: "authoritative-readiness-v1",
      priceUpdatedAt: NOW,
      dataDestination: "remote",
      retentionPolicy: "provider_default",
      trainingPolicy: "unknown",
      evidenceSource: "user_confirmed",
      evidenceVersion: "authoritative-readiness-v1",
      expectedRevision: null,
    });
    for (const task of CORE_TASKS) {
      await development.modelHub.saveTaskRoute({
        task,
        primaryCatalogEntryId: model.id,
        fallbackCatalogEntryId: null,
        maximumCostMicros: null,
        currency: null,
        privacyPolicy: "cloud_allowed",
        failurePolicy: "stop",
        routeOrigin: "user",
        expectedRevision: null,
      });
    }
    const generate = vi.fn(() => Promise.reject(new Error("readiness must not dispatch")));
    let credentialConfigured = true;
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      credentials: {
        getSummary: () =>
          Promise.resolve({
            configured: credentialConfigured,
            lastFour: credentialConfigured ? "test" : null,
          }),
        save: () => Promise.reject(new Error("not used")),
        delete: () => Promise.reject(new Error("not used")),
      },
      modelGateway: {
        available: true,
        checkConnection: () => Promise.reject(new Error("not used")),
        listModels: () => Promise.reject(new Error("not used")),
        generate,
        embed: () => Promise.reject(new Error("not used")),
        cancelGeneration: () => Promise.resolve(false),
      },
    };

    await expect(
      inspectModelHubTextTask(runtime, {
        task: "continuation",
        messages: [{ role: "system", content: "Content-free readiness inspection." }],
        maximumOutputTokens: 4_096,
      }),
    ).resolves.toMatchObject({ task: "continuation", modelId: "writer" });
    await expect(loadAuthoritativeModelHubReadiness(runtime)).resolves.toMatchObject({
      state: "fully_ready",
      runnableCoreTaskCount: 10,
      totalCoreTaskCount: 10,
      exactBlockers: [],
      shortLabel: "AI 基础连接可用",
    });

    const refreshedConnection = (await development.modelHub.listConnections()).find(
      ({ id }) => id === connection.id,
    );
    if (refreshedConnection === undefined) throw new Error("Expected the current connection.");
    connection = await development.modelHub.recordConnectionTest({
      connectionId: refreshedConnection.id,
      status: "degraded",
      errorCode: "MODEL_HUB_TEMPORARILY_DEGRADED",
      errorSummary: "Temporary test degradation.",
      expectedRevision: refreshedConnection.revision,
    });
    credentialConfigured = false;
    const degradedCredentialDrift = await loadAuthoritativeModelHubReadiness(runtime);
    expect(degradedCredentialDrift).toMatchObject({
      state: "partially_unavailable",
      routeStatus: "not_sendable",
      needsRecheck: true,
    });
    expect(degradedCredentialDrift.exactBlockers).toContainEqual({
      task: "continuation",
      code: "MODEL_HUB_CREDENTIAL_MISSING",
    });
    credentialConfigured = true;
    connection = await development.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });

    credentialConfigured = false;
    const credentialDrift = await loadAuthoritativeModelHubReadiness(runtime);
    expect(credentialDrift.state).toBe("partially_unavailable");
    expect(credentialDrift.exactBlockers).toContainEqual({
      task: "continuation",
      code: "MODEL_HUB_CREDENTIAL_MISSING",
    });
    credentialConfigured = true;

    const costProfile = await development.modelHub.findCostPrivacyProfile(model.id);
    if (costProfile === null) throw new Error("Expected the cost/privacy profile.");
    const unknownDestination = await development.modelHub.saveCostPrivacyProfile({
      catalogEntryId: model.id,
      currency: costProfile.currency,
      inputMicrosPerMillionTokens: costProfile.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: costProfile.outputMicrosPerMillionTokens,
      cachedInputMicrosPerMillionTokens: costProfile.cachedInputMicrosPerMillionTokens,
      pricingVersion: costProfile.pricingVersion,
      priceUpdatedAt: costProfile.priceUpdatedAt,
      dataDestination: "unknown",
      retentionPolicy: costProfile.retentionPolicy,
      trainingPolicy: costProfile.trainingPolicy,
      evidenceSource: costProfile.evidenceSource,
      evidenceVersion: costProfile.evidenceVersion,
      expectedRevision: costProfile.revision,
    });
    const profileDrift = await loadAuthoritativeModelHubReadiness(runtime);
    expect(profileDrift.state).toBe("partially_unavailable");
    expect(profileDrift.exactBlockers).toContainEqual({
      task: "continuation",
      code: "MODEL_HUB_DATA_DESTINATION_UNKNOWN",
    });
    await development.modelHub.saveCostPrivacyProfile({
      catalogEntryId: model.id,
      currency: unknownDestination.currency,
      inputMicrosPerMillionTokens: unknownDestination.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: unknownDestination.outputMicrosPerMillionTokens,
      cachedInputMicrosPerMillionTokens: unknownDestination.cachedInputMicrosPerMillionTokens,
      pricingVersion: unknownDestination.pricingVersion,
      priceUpdatedAt: unknownDestination.priceUpdatedAt,
      dataDestination: "remote",
      retentionPolicy: unknownDestination.retentionPolicy,
      trainingPolicy: unknownDestination.trainingPolicy,
      evidenceSource: unknownDestination.evidenceSource,
      evidenceVersion: unknownDestination.evidenceVersion,
      expectedRevision: unknownDestination.revision,
    });

    const continuation = await development.modelHub.findTaskRoute("continuation");
    if (continuation === null) throw new Error("Expected the continuation route.");
    const costLimited = await development.modelHub.saveTaskRoute({
      task: continuation.task,
      primaryCatalogEntryId: continuation.primaryCatalogEntryId,
      fallbackCatalogEntryId: continuation.fallbackCatalogEntryId,
      presetId: continuation.presetId,
      parameterPolicy: continuation.parameterPolicy,
      maximumCostMicros: "1",
      currency: "USD",
      privacyPolicy: continuation.privacyPolicy,
      failurePolicy: continuation.failurePolicy,
      routeOrigin: continuation.routeOrigin,
      expectedRevision: continuation.revision,
    });
    const costDrift = await loadAuthoritativeModelHubReadiness(runtime);
    expect(costDrift.state).toBe("partially_unavailable");
    expect(costDrift.exactBlockers).toContainEqual({
      task: "continuation",
      code: "MODEL_HUB_COST_CEILING_EXCEEDED",
    });
    const restoredContinuation = await development.modelHub.saveTaskRoute({
      task: costLimited.task,
      primaryCatalogEntryId: costLimited.primaryCatalogEntryId,
      fallbackCatalogEntryId: costLimited.fallbackCatalogEntryId,
      presetId: costLimited.presetId,
      parameterPolicy: costLimited.parameterPolicy,
      maximumCostMicros: null,
      currency: null,
      privacyPolicy: costLimited.privacyPolicy,
      failurePolicy: costLimited.failurePolicy,
      routeOrigin: costLimited.routeOrigin,
      expectedRevision: costLimited.revision,
    });
    const disabled = await development.modelHub.saveTaskRoute({
      task: restoredContinuation.task,
      primaryCatalogEntryId: restoredContinuation.primaryCatalogEntryId,
      fallbackCatalogEntryId: restoredContinuation.fallbackCatalogEntryId,
      presetId: restoredContinuation.presetId,
      parameterPolicy: restoredContinuation.parameterPolicy,
      maximumCostMicros: restoredContinuation.maximumCostMicros,
      currency: restoredContinuation.currency,
      privacyPolicy: restoredContinuation.privacyPolicy,
      failurePolicy: restoredContinuation.failurePolicy,
      routeOrigin: restoredContinuation.routeOrigin,
      enabled: false,
      expectedRevision: restoredContinuation.revision,
    });
    const routeDrift = await loadAuthoritativeModelHubReadiness(runtime);
    expect(routeDrift.state).toBe("partially_unavailable");
    expect(routeDrift.missingCoreTasks).toContain("continuation");
    await development.modelHub.saveTaskRoute({
      task: disabled.task,
      primaryCatalogEntryId: disabled.primaryCatalogEntryId,
      fallbackCatalogEntryId: disabled.fallbackCatalogEntryId,
      presetId: disabled.presetId,
      parameterPolicy: disabled.parameterPolicy,
      maximumCostMicros: disabled.maximumCostMicros,
      currency: disabled.currency,
      privacyPolicy: disabled.privacyPolicy,
      failurePolicy: disabled.failurePolicy,
      routeOrigin: disabled.routeOrigin,
      enabled: true,
      expectedRevision: disabled.revision,
    });

    await development.modelHub.syncCatalog({
      syncId: "authoritative-ready-drifted-sync",
      connectionId: connection.id,
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: model.id,
          providerModelId: model.providerModelId,
          lifecycle: "deprecated",
          inputTokenLimit: model.inputTokenLimit,
          outputTokenLimit: model.outputTokenLimit,
          staleAfter: model.staleAfter,
        },
      ],
    });
    const catalogDrift = await loadAuthoritativeModelHubReadiness(runtime);
    expect(catalogDrift.state).toBe("partially_unavailable");
    expect(catalogDrift.missingCoreTasks).toContain("continuation");
    expect(generate).not.toHaveBeenCalled();
  });

  it("retains a saved and recently verified connection when its catalog is temporarily unreadable", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let connection = await development.modelHub.saveConnection({
      id: "saved-with-catalog-warning",
      providerKind: "openai",
      displayName: "Saved connection",
      credentialRef: "keyring:model-hub:saved-with-catalog-warning",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await development.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    const generate = vi.fn(() => Promise.reject(new Error("readiness must not dispatch")));
    vi.spyOn(development.modelHub, "listConnections").mockResolvedValue([connection]);
    vi.spyOn(development.modelHub, "listCatalog").mockRejectedValue(
      new Error("catalog is temporarily unavailable"),
    );
    const runtime: DesktopRuntime = {
      ...development,
      modelHub: development.modelHub,
      credentials: {
        ...development.credentials,
        getSummary: () => Promise.resolve({ configured: true, lastFour: "3172" }),
      },
      modelGateway: {
        ...development.modelGateway,
        generate,
      },
    };

    await expect(loadAuthoritativeModelHubReadiness(runtime)).resolves.toMatchObject({
      savedConnectionCount: 1,
      usableConnectionCount: 1,
      credentialStatus: "trusted",
      catalogStatus: "temporarily_unavailable",
      needsRecheck: true,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("isolates an untrusted saved credential reference during the first authoritative load", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    let connection = await development.modelHub.saveConnection({
      id: "saved-with-untrusted-credential-reference",
      providerKind: "openai",
      displayName: "Saved connection with an old credential reference",
      credentialRef: "keyring:model-hub:saved-with-untrusted-credential-reference",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    connection = await development.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    const catalog = await development.modelHub.syncCatalog({
      syncId: "untrusted-reference-sync",
      connectionId: connection.id,
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "untrusted-reference-model",
          providerModelId: "writer",
          lifecycle: "stable",
          inputTokenLimit: 200_000,
          outputTokenLimit: 20_000,
          staleAfter: "2027-08-13T00:00:00.000Z",
        },
      ],
    });
    const model = catalog[0];
    if (model === undefined) throw new Error("Expected the test catalog entry.");
    for (const task of CORE_TASKS) {
      await development.modelHub.saveTaskRoute({
        task,
        primaryCatalogEntryId: model.id,
        fallbackCatalogEntryId: null,
        maximumCostMicros: null,
        currency: null,
        privacyPolicy: "cloud_allowed",
        failurePolicy: "stop",
        routeOrigin: "user",
        expectedRevision: null,
      });
    }
    const untrustedConnection = {
      ...connection,
      credentialRef: "keyring:outside-inkshadow:legacy-secret",
    };
    const listConnections = vi
      .spyOn(development.modelHub, "listConnections")
      .mockResolvedValue([untrustedConnection]);
    const listCatalog = vi.spyOn(development.modelHub, "listCatalog");
    const findTaskRoute = vi.spyOn(development.modelHub, "findTaskRoute");
    const getSummary = vi.fn(() =>
      Promise.reject(new Error("an untrusted reference must not reach credential storage")),
    );
    const generate = vi.fn(() => Promise.reject(new Error("readiness must not dispatch")));
    const runtime: DesktopRuntime = {
      ...development,
      credentials: {
        ...development.credentials,
        getSummary,
      },
      modelGateway: {
        ...development.modelGateway,
        generate,
      },
    };

    const readiness = await loadAuthoritativeModelHubReadiness(runtime);

    expect(readiness).toMatchObject({
      state: "partially_unavailable",
      savedConnectionCount: 1,
      credentialStatus: "untrusted",
      needsRecheck: true,
    });
    expect(readiness.state).not.toBe("connection_failed");
    expect(listConnections).toHaveBeenCalledTimes(1);
    expect(listCatalog).toHaveBeenCalledWith(connection.id);
    expect(findTaskRoute).toHaveBeenCalled();
    expect(getSummary).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("distinguishes missing, unavailable and mixed credential evidence without dispatch", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const first = await development.modelHub.saveConnection({
      id: "credential-boundary-first",
      providerKind: "openai",
      displayName: "Credential boundary first",
      credentialRef: "keyring:model-hub:credential-boundary-first",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const second = await development.modelHub.saveConnection({
      id: "credential-boundary-second",
      providerKind: "openai",
      displayName: "Credential boundary second",
      credentialRef: "keyring:model-hub:credential-boundary-second",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const generate = vi.fn(() => Promise.reject(new Error("readiness must not dispatch")));
    const getSummary =
      vi.fn<(providerId: string) => Promise<{ configured: boolean; lastFour: string | null }>>();
    const runtime: DesktopRuntime = {
      ...development,
      credentials: {
        ...development.credentials,
        getSummary,
      },
      modelGateway: {
        ...development.modelGateway,
        generate,
      },
    };

    getSummary.mockResolvedValue({ configured: false, lastFour: null });
    await expect(loadAuthoritativeModelHubReadiness(runtime)).resolves.toMatchObject({
      savedConnectionCount: 2,
      credentialStatus: "missing",
      needsRecheck: true,
    });

    getSummary.mockRejectedValue(new Error("credential storage temporarily unavailable"));
    await expect(loadAuthoritativeModelHubReadiness(runtime)).resolves.toMatchObject({
      savedConnectionCount: 2,
      credentialStatus: "unavailable",
      needsRecheck: true,
    });

    getSummary.mockImplementation((providerId) =>
      Promise.resolve({
        configured: providerId === first.id,
        lastFour: providerId === first.id ? "1234" : null,
      }),
    );
    await expect(loadAuthoritativeModelHubReadiness(runtime)).resolves.toMatchObject({
      savedConnectionCount: 2,
      credentialStatus: "mixed",
      needsRecheck: true,
    });
    expect(second.id).not.toBe(first.id);
    expect(generate).not.toHaveBeenCalled();
  });
});
