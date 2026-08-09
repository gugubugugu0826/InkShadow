import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "./runtime";
import { DEVELOPMENT_MODEL_HUB_KEY } from "./model-hub-store";

describe("Model Hub runtime wiring", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("exposes a resumable browser store for connections, catalogs, evidence, and presets", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const connection = await runtime.modelHub.saveConnection({
      id: "browser-local",
      providerKind: "ollama",
      displayName: "本机 Ollama",
      credentialState: "missing",
      expectedRevision: null,
    });
    const tested = await runtime.modelHub.recordConnectionTest({
      connectionId: connection.id,
      status: "ready",
      expectedRevision: connection.revision,
    });
    expect(tested).toMatchObject({ connectionStatus: "ready", revision: 2 });

    await runtime.modelHub.syncCatalog({
      syncId: "browser-sync",
      connectionId: connection.id,
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "browser-model", providerModelId: "installed-at-runtime" }],
    });
    await runtime.modelHub.recordCapabilityScan({
      scanId: "browser-scan",
      catalogEntryId: "browser-model",
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "probe-v1",
      evidence: [
        {
          id: "browser-evidence",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        },
      ],
    });
    await runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: "browser-model",
      dataDestination: "local",
      retentionPolicy: "none",
      trainingPolicy: "not_used",
      evidenceSource: "user_confirmed",
      evidenceVersion: "local-confirmation-v1",
      expectedRevision: null,
    });
    await runtime.modelHub.recordEvaluationResult({
      id: "browser-model-prose-v1",
      catalogEntryId: "browser-model",
      task: "prose_generation",
      scoreBasisPoints: 8100,
      latencyP50Ms: 640,
      sampleCount: 20,
      evaluationSource: "local_evaluation",
      evaluationVersion: "browser-suite-v1",
    });
    await runtime.modelHub.saveTaskRoute({
      task: "content_quality_check",
      primaryCatalogEntryId: "browser-model",
      privacyPolicy: "local_only",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });
    await runtime.modelHub.savePreset({
      id: "browser-private",
      scheme: "local_privacy",
      displayName: "本地隐私",
      status: "active",
      privacyPolicy: "local_only",
      costPriority: "quality_first",
      routeGenerationVersion: "router-v1",
      expectedRevision: null,
    });
    await runtime.close();

    const reopened = createDevelopmentRuntime(window.localStorage);
    await expect(reopened.modelHub.findConnection(connection.id)).resolves.toMatchObject({
      connectionStatus: "ready",
      catalogSyncStatus: "succeeded",
      revision: 3,
    });
    await expect(reopened.modelHub.listCatalog(connection.id)).resolves.toMatchObject([
      { id: "browser-model", providerModelId: "installed-at-runtime", availability: "available" },
    ]);
    await expect(reopened.modelHub.listCatalogSyncs(connection.id)).resolves.toMatchObject([
      { id: "browser-sync", status: "succeeded", discoveredModelCount: 1 },
    ]);
    await expect(reopened.modelHub.listCapabilityEvidence("browser-model")).resolves.toMatchObject([
      { capability: "text_generation", verdict: "supported" },
    ]);
    await expect(reopened.modelHub.findCostPrivacyProfile("browser-model")).resolves.toMatchObject({
      dataDestination: "local",
      retentionPolicy: "none",
      trainingPolicy: "not_used",
    });
    await expect(
      reopened.modelHub.listEvaluationResults("browser-model", "prose_generation"),
    ).resolves.toMatchObject([
      {
        id: "browser-model-prose-v1",
        scoreBasisPoints: 8100,
        latencyP50Ms: 640,
        sampleCount: 20,
      },
    ]);
    await expect(reopened.modelHub.findTaskRoute("content_quality_check")).resolves.toMatchObject({
      task: "content_quality_check",
      primaryCatalogEntryId: "browser-model",
      privacyPolicy: "local_only",
    });
    await expect(reopened.modelHub.findActivePreset()).resolves.toMatchObject({
      id: "browser-private",
      scheme: "local_privacy",
    });

    const serialized = window.localStorage.getItem(DEVELOPMENT_MODEL_HUB_KEY) ?? "";
    expect(serialized).not.toMatch(/api[_-]?key|password|bearer\s+|sk-[a-z0-9]/iu);
    await reopened.close();
  });

  it("upgrades the previous browser schema without losing Model Hub metadata", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.modelHub.saveConnection({
      id: "upgrade-local",
      providerKind: "ollama",
      displayName: "Upgrade fixture",
      credentialState: "missing",
      expectedRevision: null,
    });
    const originalCatalog = await runtime.modelHub.syncCatalog({
      syncId: "upgrade-sync",
      connectionId: "upgrade-local",
      source: "provider_api",
      status: "succeeded",
      models: [{ id: "upgrade-model", providerModelId: "upgrade-runtime-model" }],
    });
    const originalPrivacy = await runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: "upgrade-model",
      dataDestination: "local",
      retentionPolicy: "none",
      trainingPolicy: "not_used",
      evidenceSource: "user_confirmed",
      expectedRevision: null,
    });
    const originalConnection = await runtime.modelHub.findConnection("upgrade-local");
    if (originalConnection === null) {
      throw new Error("The Model Hub upgrade fixture connection was not persisted.");
    }
    await runtime.close();

    const serialized = window.localStorage.getItem(DEVELOPMENT_MODEL_HUB_KEY);
    if (serialized === null) {
      throw new Error("The Model Hub browser fixture was not persisted.");
    }
    const previousDatabase = JSON.parse(serialized) as {
      schemaVersion: number;
      state: Record<string, unknown>;
    };
    previousDatabase.schemaVersion = 2;
    const currentScans = previousDatabase.state.capabilityScans as
      Record<string, unknown> | undefined;
    previousDatabase.state.capabilityScanIds = Object.fromEntries(
      Object.keys(currentScans ?? {}).map((scanId) => [scanId, true]),
    );
    delete previousDatabase.state.capabilityScans;
    delete previousDatabase.state.evaluationResults;
    window.localStorage.setItem(DEVELOPMENT_MODEL_HUB_KEY, JSON.stringify(previousDatabase));

    const upgraded = createDevelopmentRuntime(window.localStorage);
    await expect(upgraded.modelHub.findConnection("upgrade-local")).resolves.toEqual(
      originalConnection,
    );
    await expect(upgraded.modelHub.listCatalog("upgrade-local")).resolves.toEqual(originalCatalog);
    await expect(upgraded.modelHub.findCostPrivacyProfile("upgrade-model")).resolves.toEqual(
      originalPrivacy,
    );
    await expect(upgraded.modelHub.listEvaluationResults("upgrade-model")).resolves.toEqual([]);
    await upgraded.modelHub.recordEvaluationResult({
      id: "upgrade-evaluation",
      catalogEntryId: "upgrade-model",
      task: "prose_generation",
      scoreBasisPoints: 8000,
      latencyP50Ms: 500,
      sampleCount: 10,
      evaluationSource: "local_evaluation",
      evaluationVersion: "upgrade-suite-v1",
    });
    expect(
      JSON.parse(window.localStorage.getItem(DEVELOPMENT_MODEL_HUB_KEY) ?? "{}"),
    ).toMatchObject({ schemaVersion: 6 });
    await upgraded.close();
  });
});
