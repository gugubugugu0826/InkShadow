import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { BrowserDevelopmentModelCenterStore } from "./model-center-store";
import { MODEL_HUB_CAPABILITIES, NOVEL_AI_TASKS } from "./model-hub-provider-registry";
import {
  applyAutomaticModelHubRouting,
  loadModelHubRoutingCandidates,
} from "./model-hub-routing-service";
import { BrowserDevelopmentModelHubStore, type ModelHubStore } from "./model-hub-store";
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

  it("switches to local privacy fail-closed and removes every prior cloud route", async () => {
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
      routeOrigin: "user",
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
});

async function seedCandidate(
  modelHub: ModelHubStore,
  input: Readonly<{
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
    destination: "local" | "remote";
    textOnly?: boolean;
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
