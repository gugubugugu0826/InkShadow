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
    const disabled = await development.modelHub.saveTaskRoute({
      task: continuation.task,
      primaryCatalogEntryId: continuation.primaryCatalogEntryId,
      fallbackCatalogEntryId: continuation.fallbackCatalogEntryId,
      presetId: continuation.presetId,
      parameterPolicy: continuation.parameterPolicy,
      maximumCostMicros: continuation.maximumCostMicros,
      currency: continuation.currency,
      privacyPolicy: continuation.privacyPolicy,
      failurePolicy: continuation.failurePolicy,
      routeOrigin: continuation.routeOrigin,
      enabled: false,
      expectedRevision: continuation.revision,
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
});
