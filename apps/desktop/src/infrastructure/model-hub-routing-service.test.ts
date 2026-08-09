import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import { NodeSqliteExecutor } from "../../../../packages/data/tests/node-sqlite-executor.js";
import { BrowserDevelopmentModelCenterStore } from "./model-center-store";
import { MODEL_HUB_CAPABILITIES, NOVEL_AI_TASKS } from "./model-hub-provider-registry";
import {
  applyAutomaticModelHubRouting,
  loadModelHubRoutingCandidates,
} from "./model-hub-routing-service";
import {
  BrowserDevelopmentModelHubStore,
  TauriModelHubStore,
  type ModelHubStore,
} from "./model-hub-store";
import { BrowserDevelopmentModelRoutingStore } from "./model-routing-store";

const NOW = "2026-08-01T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };

describe("automatic Model Hub routing application", () => {
  it("persists the 16 compatible core routes for text-only evidence without evaluations", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const legacyRouting = new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter);
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    await seedCandidate(modelHub, {
      connectionId: "text-only-provider",
      catalogEntryId: "text-only-catalog",
      modelId: "text-only-model",
      destination: "remote",
      textOnly: true,
    });

    const applied = await applyAutomaticModelHubRouting({
      modelHub,
      legacyRouting,
      legacyReadyModels: [],
      scheme: "smart",
      now: NOW,
    });
    const savedRoutes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => modelHub.findTaskRoute(task)))
    ).filter((route) => route !== null);

    expect(applied.savedNovelTaskCount).toBe(16);
    expect(savedRoutes).toHaveLength(16);
    expect(savedRoutes.map(({ task }) => task)).toEqual(
      expect.arrayContaining([
        "book_start_guidance",
        "prose_generation",
        "continuation",
        "rewrite",
        "content_quality_check",
      ]),
    );
    await expect(modelHub.findTaskRoute("embedding")).resolves.toBeNull();
    await expect(modelHub.findTaskRoute("image_generation")).resolves.toBeNull();

    const reopened = new BrowserDevelopmentModelHubStore(storage, clock);
    const reopenedRoutes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => reopened.findTaskRoute(task)))
    ).filter((route) => route !== null);
    expect(reopenedRoutes).toHaveLength(16);
    await expect(reopened.listCapabilityEvidence("text-only-catalog")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "text_generation",
          verdict: "supported",
        }),
      ]),
    );
  });

  it("persists all text routes in production SQLite without price or evaluation metadata", async () => {
    const executor = new NodeSqliteExecutor(modelHubMigration());
    const modelHub = new TauriModelHubStore(executor, clock);
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const legacyRouting = new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter);
    await seedCandidate(modelHub, {
      connectionId: "sqlite-text-provider",
      catalogEntryId: "sqlite-text-catalog",
      modelId: "sqlite-text-model",
      destination: "remote",
      textOnly: true,
      skipCostPrivacy: true,
    });

    const applied = await applyAutomaticModelHubRouting({
      modelHub,
      legacyRouting,
      legacyReadyModels: [],
      scheme: "smart",
      now: NOW,
    });

    expect(applied.savedNovelTaskCount).toBe(16);
    await expect(modelHub.findTaskRoute("content_quality_check")).resolves.toMatchObject({
      routeOrigin: "automatic",
      primaryCatalogEntryId: "sqlite-text-catalog",
    });
    const reopened = new TauriModelHubStore(executor, clock);
    const reopenedRoutes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => reopened.findTaskRoute(task)))
    ).filter((route) => route !== null);
    expect(reopenedRoutes).toHaveLength(16);
    await executor.close();
  });

  it("uses capability evidence when optional pricing and evaluation projections are unavailable", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const legacyRouting = new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter);
    const underlying = new BrowserDevelopmentModelHubStore(storage, clock);
    await seedCandidate(underlying, {
      connectionId: "optional-metadata-provider",
      catalogEntryId: "optional-metadata-catalog",
      modelId: "optional-metadata-model",
      destination: "remote",
      textOnly: true,
      skipCostPrivacy: true,
    });
    vi.spyOn(underlying, "findCostPrivacyProfile").mockRejectedValue(
      new Error("optional projection unavailable"),
    );
    vi.spyOn(underlying, "listEvaluationResults").mockRejectedValue(
      new Error("optional projection unavailable"),
    );

    const applied = await applyAutomaticModelHubRouting({
      modelHub: underlying,
      legacyRouting,
      legacyReadyModels: [],
      scheme: "smart",
      now: NOW,
    });

    expect(applied.savedNovelTaskCount).toBe(16);
    expect(applied.plan.unroutableTasks).toContain("embedding");
  });

  it("keeps the committed Model Hub plan when the rebuildable legacy projection is unavailable", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const underlyingLegacy = new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter);
    vi.spyOn(underlyingLegacy, "listRoutes").mockRejectedValue(
      new Error("legacy projection unavailable"),
    );
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    await seedCandidate(modelHub, {
      connectionId: "legacy-independent-provider",
      catalogEntryId: "legacy-independent-catalog",
      modelId: "legacy-independent-model",
      destination: "remote",
      textOnly: true,
    });

    const applied = await applyAutomaticModelHubRouting({
      modelHub,
      legacyRouting: underlyingLegacy,
      legacyReadyModels: [],
      scheme: "smart",
      now: NOW,
    });

    expect(applied).toMatchObject({
      savedNovelTaskCount: 16,
      savedLegacyRoleCount: 0,
      legacySyncStatus: "failed",
      legacySyncErrorCode: "MODEL_HUB_LEGACY_SYNC_FAILED",
    });
    await expect(modelHub.findTaskRoute("content_quality_check")).resolves.not.toBeNull();
  });

  it("never offers a retired connection to automatic routing", async () => {
    const storage = new MemoryStorage();
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    await seedCandidate(modelHub, {
      connectionId: "retired-route-provider",
      catalogEntryId: "retired-route-model",
      modelId: "writer-model",
      destination: "local",
    });
    const current = await modelHub.findConnection("retired-route-provider");
    if (current === null) throw new Error("expected seeded connection");
    await modelHub.retireConnection({
      connectionId: current.id,
      expectedRevision: current.revision,
    });

    await expect(loadModelHubRoutingCandidates(modelHub)).resolves.toEqual([]);
  });

  it("clears a legacy role when its selected-model snapshot differs from the catalog model", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const legacyRouting = new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter);
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    await modelCenter.save({
      providerId: "shared-connection",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example.test/v1",
      authentication: "none",
      selectedModel: "stale-legacy-model",
      pricing: null,
      expectedRevision: null,
    });
    await legacyRouting.saveRoute({
      role: "high_quality",
      primaryProviderId: "shared-connection",
      fallbackProviderId: null,
      expectedRevision: null,
    });
    await seedCandidate(modelHub, {
      connectionId: "shared-connection",
      catalogEntryId: "current-catalog",
      modelId: "current-catalog-model",
      destination: "remote",
    });

    const applied = await applyAutomaticModelHubRouting({
      modelHub,
      legacyRouting,
      legacyReadyModels: [{ connectionId: "shared-connection", modelId: "stale-legacy-model" }],
      scheme: "quality",
      now: NOW,
    });

    expect(applied.savedNovelTaskCount).toBe(NOVEL_AI_TASKS.length);
    expect(applied.savedLegacyRoleCount).toBe(0);
    expect(await legacyRouting.findRoute("high_quality")).toBeNull();
    expect(applied.legacy.routes[0]?.primaryModelId).toBe("current-catalog-model");
  });

  it("switches to local privacy fail-closed and replaces prior automatic cloud routes", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const legacyRouting = new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter);
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    for (const profile of [
      {
        providerId: "cloud",
        provider: "open_ai_compatible" as const,
        baseUrl: "https://cloud.example.test/v1",
        selectedModel: "cloud-model",
      },
      {
        providerId: "local",
        provider: "ollama" as const,
        baseUrl: "http://127.0.0.1:11434",
        selectedModel: "local-model",
      },
    ]) {
      await modelCenter.save({
        ...profile,
        authentication: "none",
        pricing: null,
        expectedRevision: null,
      });
    }
    await legacyRouting.saveRoute({
      role: "high_quality",
      primaryProviderId: "cloud",
      fallbackProviderId: null,
      expectedRevision: null,
    });
    await seedCandidate(modelHub, {
      connectionId: "cloud",
      catalogEntryId: "cloud-catalog",
      modelId: "cloud-model",
      destination: "remote",
    });
    await seedCandidate(modelHub, {
      connectionId: "local",
      catalogEntryId: "local-catalog",
      modelId: "local-model",
      destination: "local",
    });
    await modelHub.saveTaskRoute({
      task: "prose_generation",
      primaryCatalogEntryId: "cloud-catalog",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "automatic",
      expectedRevision: null,
    });

    const applied = await applyAutomaticModelHubRouting({
      modelHub,
      legacyRouting,
      legacyReadyModels: [
        { connectionId: "cloud", modelId: "cloud-model" },
        { connectionId: "local", modelId: "local-model" },
      ],
      scheme: "local_privacy",
      now: NOW,
    });
    const routes = (
      await Promise.all(NOVEL_AI_TASKS.map((task) => modelHub.findTaskRoute(task)))
    ).filter((route) => route !== null);

    expect(applied.savedNovelTaskCount).toBe(NOVEL_AI_TASKS.length);
    expect(routes).toHaveLength(NOVEL_AI_TASKS.length);
    expect(
      routes.every(
        ({ primaryCatalogEntryId, fallbackCatalogEntryId, privacyPolicy }) =>
          primaryCatalogEntryId === "local-catalog" &&
          fallbackCatalogEntryId === null &&
          privacyPolicy === "local_only",
      ),
    ).toBe(true);
    expect(
      (await legacyRouting.listRoutes()).every(
        ({ primaryProviderId }) => primaryProviderId === "local",
      ),
    ).toBe(true);
  });

  it("preserves a manual cloud route by refusing an incompatible local-only scheme", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const legacyRouting = new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter);
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    await modelCenter.save({
      providerId: "manual-cloud",
      provider: "open_ai_compatible",
      baseUrl: "https://manual-cloud.example.test/v1",
      authentication: "none",
      selectedModel: "manual-cloud-model",
      pricing: null,
      expectedRevision: null,
    });
    await legacyRouting.saveRoute({
      role: "high_quality",
      primaryProviderId: "manual-cloud",
      fallbackProviderId: null,
      expectedRevision: null,
    });
    await seedCandidate(modelHub, {
      connectionId: "manual-cloud",
      catalogEntryId: "manual-cloud-catalog",
      modelId: "manual-cloud-model",
      destination: "remote",
    });
    await seedCandidate(modelHub, {
      connectionId: "manual-local",
      catalogEntryId: "manual-local-catalog",
      modelId: "manual-local-model",
      destination: "local",
    });
    const manualRoute = await modelHub.saveTaskRoute({
      task: "prose_generation",
      primaryCatalogEntryId: "manual-cloud-catalog",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      routeOrigin: "user",
      expectedRevision: null,
    });

    await expect(
      applyAutomaticModelHubRouting({
        modelHub,
        legacyRouting,
        legacyReadyModels: [],
        scheme: "local_privacy",
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_MANUAL_ROUTE_PRIVACY_CONFLICT" });
    await expect(modelHub.findTaskRoute("prose_generation")).resolves.toEqual(manualRoute);
    await expect(legacyRouting.listRoutes()).resolves.toEqual([]);
  });
});

async function seedCandidate(
  modelHub: ModelHubStore,
  input: Readonly<{
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
    destination: "local" | "remote";
    textOnly?: boolean;
    skipCostPrivacy?: boolean;
  }>,
): Promise<void> {
  const providerKind = input.destination === "local" ? "ollama" : "custom_openai_compatible";
  const connection = await modelHub.saveConnection({
    id: input.connectionId,
    providerKind,
    displayName: input.connectionId,
    baseUrlOverride:
      input.destination === "local"
        ? "http://127.0.0.1:11434"
        : `https://${input.connectionId}.example.test/v1`,
    credentialState: "missing",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  const catalog = await modelHub.syncCatalog({
    syncId: `${input.connectionId}-sync`,
    connectionId: input.connectionId,
    source: "manual",
    status: "succeeded",
    models: [{ id: input.catalogEntryId, providerModelId: input.modelId }],
  });
  const entry = catalog.find(({ id }) => id === input.catalogEntryId);
  if (entry === undefined) {
    throw new Error("test catalog entry was not saved");
  }
  await modelHub.recordCapabilityScan({
    scanId: `${input.connectionId}-capability-scan`,
    catalogEntryId: entry.id,
    scanKind: "user_review",
    status: "succeeded",
    evidenceVersion: "test-v1",
    evidence: (input.textOnly === true ? ["text_generation" as const] : MODEL_HUB_CAPABILITIES).map(
      (capability) => ({
        id: `${input.connectionId}-${capability}`,
        capability,
        verdict: "supported",
        evidenceSource: "user_confirmed",
      }),
    ),
  });
  if (input.skipCostPrivacy !== true) {
    await modelHub.saveCostPrivacyProfile({
      catalogEntryId: entry.id,
      dataDestination: input.destination,
      retentionPolicy: input.destination === "local" ? "none" : "provider_default",
      trainingPolicy: input.destination === "local" ? "not_used" : "unknown",
      evidenceSource: "user_confirmed",
      evidenceVersion: "test-v1",
      expectedRevision: null,
    });
  }
}

function modelHubMigration(): string {
  return [
    "0004_model_profiles.sql",
    "0031_model_hub.sql",
    "0037_model_hub_expert_options.sql",
    "0046_model_hub_zhipu_glm.sql",
    "0051_model_hub_connection_commits.sql",
    "0056_model_hub_failure_diagnostics.sql",
    "0057_model_hub_content_quality_task.sql",
  ]
    .map(readMigration)
    .join("\n");
}

function readMigration(fileName: string): string {
  let workspaceRoot = path.resolve(process.cwd());
  while (!existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(workspaceRoot);
    if (parent === workspaceRoot) {
      throw new Error("InkShadow workspace root could not be located.");
    }
    workspaceRoot = parent;
  }
  return readFileSync(path.join(workspaceRoot, "packages", "data", "migrations", fileName), "utf8");
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
