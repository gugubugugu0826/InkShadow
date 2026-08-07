import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import { BrowserDevelopmentModelCenterStore } from "./model-center-store";
import { bridgeLegacyModelProfilesToModelHub } from "./model-hub-legacy-bridge";
import { BrowserDevelopmentModelHubStore } from "./model-hub-store";
import { BrowserDevelopmentModelRoutingStore } from "./model-routing-store";

const NOW = "2026-08-01T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };

describe("legacy Model Center to Model Hub bridge", () => {
  it("reuses the legacy provider id and keyring lookup without changing legacy routes", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const modelRouting = new BrowserDevelopmentModelRoutingStore(storage, clock, modelCenter);
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    await modelCenter.save({
      providerId: "writer-provider",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example.test/v1",
      authentication: "bearer_keyring",
      selectedModel: "author-model",
      pricing: null,
      expectedRevision: null,
    });
    const legacyRoute = await modelRouting.saveRoute({
      role: "high_quality",
      primaryProviderId: "writer-provider",
      fallbackProviderId: null,
      expectedRevision: null,
    });
    const credentialLookups: string[] = [];
    const credentials = {
      getSummary(providerId: string) {
        credentialLookups.push(providerId);
        return Promise.resolve({ configured: true });
      },
    };

    const first = await bridgeLegacyModelProfilesToModelHub({
      modelCenter,
      modelHub,
      credentials,
      clock,
    });
    const connection = await modelHub.findConnection("writer-provider");
    const catalog = await modelHub.listCatalog("writer-provider");
    const evidence = await modelHub.listCapabilityEvidence(catalog[0]?.id ?? "missing");

    expect(first).toEqual({
      connectionCount: 1,
      catalogEntryCount: 1,
      skippedNonLegacyConnectionCount: 0,
    });
    expect(connection).toEqual(
      expect.objectContaining({
        id: "writer-provider",
        providerKind: "custom_openai_compatible",
        credentialRef: "keyring:legacy-model-profile:writer-provider",
        credentialState: "present",
        legacyProviderId: "writer-provider",
        connectionStatus: "not_tested",
      }),
    );
    expect(catalog).toEqual([
      expect.objectContaining({
        providerModelId: "author-model",
        catalogSource: "legacy",
        availability: "available",
      }),
    ]);
    expect(evidence).toHaveLength(12);
    expect(
      evidence.every(
        ({ verdict, evidenceSource }) => verdict === "unknown" && evidenceSource === "legacy",
      ),
    ).toBe(true);
    expect(await modelRouting.findRoute("high_quality")).toEqual(legacyRoute);
    expect(credentialLookups).toEqual(["writer-provider"]);

    const revision = connection?.revision;
    await bridgeLegacyModelProfilesToModelHub({ modelCenter, modelHub, credentials, clock });
    expect((await modelHub.findConnection("writer-provider"))?.revision).toBe(revision);
    expect(await modelHub.listCatalog("writer-provider")).toHaveLength(1);
    expect(await modelRouting.findRoute("high_quality")).toEqual(legacyRoute);
    expect(credentialLookups).toEqual(["writer-provider"]);
  });

  it("maps Ollama locally but never overwrites an existing non-legacy Model Hub connection", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    await modelCenter.save({
      providerId: "local-writer",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: "installed-model",
      pricing: null,
      expectedRevision: null,
    });
    await modelCenter.save({
      providerId: "already-modern",
      provider: "open_ai_compatible",
      baseUrl: "https://legacy.example.test/v1",
      authentication: "none",
      selectedModel: "legacy-model",
      pricing: null,
      expectedRevision: null,
    });
    await modelHub.saveConnection({
      id: "already-modern",
      providerKind: "deepseek",
      displayName: "Modern connection",
      baseUrlOverride: "https://api.deepseek.com",
      credentialRef: "keyring:model-hub:already-modern",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      expectedRevision: null,
    });

    const result = await bridgeLegacyModelProfilesToModelHub({
      modelCenter,
      modelHub,
      credentials: { getSummary: () => Promise.resolve({ configured: false }) },
      clock,
    });
    const local = await modelHub.findConnection("local-writer");
    const localCatalog = await modelHub.listCatalog("local-writer");
    const localPrivacy = await modelHub.findCostPrivacyProfile(localCatalog[0]?.id ?? "missing");

    expect(result.skippedNonLegacyConnectionCount).toBe(1);
    expect(local?.providerKind).toBe("ollama");
    expect(localPrivacy).toEqual(
      expect.objectContaining({
        dataDestination: "local",
        evidenceSource: "legacy",
      }),
    );
    expect(await modelHub.findConnection("already-modern")).toEqual(
      expect.objectContaining({
        providerKind: "deepseek",
        displayName: "Modern connection",
        credentialRef: "keyring:model-hub:already-modern",
        credentialState: "present",
        authenticationMode: "bearer_keyring",
        legacyProviderId: null,
      }),
    );
  });

  it("never classifies a remote Ollama endpoint as local privacy", async () => {
    const storage = new MemoryStorage();
    const modelCenter = new BrowserDevelopmentModelCenterStore(storage, clock);
    const modelHub = new BrowserDevelopmentModelHubStore(storage, clock);
    await modelCenter.save({
      providerId: "remote-ollama",
      provider: "ollama",
      baseUrl: "https://remote-ollama.example",
      authentication: "none",
      selectedModel: "remote-model",
      pricing: null,
      expectedRevision: null,
    });

    await bridgeLegacyModelProfilesToModelHub({
      modelCenter,
      modelHub,
      credentials: { getSummary: () => Promise.resolve({ configured: false }) },
      clock,
    });
    const catalog = await modelHub.listCatalog("remote-ollama");
    const privacy = await modelHub.findCostPrivacyProfile(catalog[0]?.id ?? "missing");

    expect(privacy).toEqual(
      expect.objectContaining({
        dataDestination: "remote",
        retentionPolicy: "provider_default",
        trainingPolicy: "unknown",
        evidenceSource: "legacy",
      }),
    );
  });
});

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
