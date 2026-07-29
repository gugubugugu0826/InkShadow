import { describe, expect, it } from "vitest";
import { parseIsoUtcTimestamp, type Clock } from "@inkshadow/domain";

import {
  BrowserDevelopmentModelCenterStore,
  DEVELOPMENT_MODEL_CENTER_KEY,
} from "./model-center-store";

const now = parseIsoUtcTimestamp("2026-07-27T00:00:00.000Z");
if (!now.ok) {
  throw now.error;
}
const clock: Clock = {
  now: () => now.value,
};

describe("BrowserDevelopmentModelCenterStore", () => {
  it("persists only non-secret profile metadata with revision CAS", async () => {
    const store = new BrowserDevelopmentModelCenterStore(window.localStorage, clock);
    const created = await store.save({
      providerId: "openai",
      provider: "open_ai_compatible",
      baseUrl: "https://api.openai.com/v1",
      authentication: "bearer_keyring",
      selectedModel: null,
      expectedRevision: null,
    });
    expect(created).toMatchObject({ revision: 1, selectedModel: null });

    const selected = await store.save({
      providerId: "openai",
      provider: "open_ai_compatible",
      baseUrl: "https://api.openai.com/v1",
      authentication: "bearer_keyring",
      selectedModel: "gpt-test",
      pricing: {
        contextWindowTokens: 32_000,
        currency: "USD",
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        cachedInputMicrosPerMillionTokens: 500_000,
        pricingVersion: "2026-07",
        priceUpdatedAt: "2026-07-27T00:00:00.000Z",
      },
      expectedRevision: 1,
    });
    expect(selected).toMatchObject({
      revision: 2,
      selectedModel: "gpt-test",
      pricing: {
        contextWindowTokens: 32_000,
        currency: "USD",
        pricingVersion: "2026-07",
      },
    });

    const reopened = new BrowserDevelopmentModelCenterStore(window.localStorage, clock);
    await expect(reopened.listProfiles()).resolves.toMatchObject([
      {
        providerId: "openai",
        selectedModel: "gpt-test",
        revision: 2,
        pricing: {
          contextWindowTokens: 32_000,
          currency: "USD",
        },
      },
    ]);
    await expect(
      reopened.save({
        providerId: "openai",
        provider: "open_ai_compatible",
        baseUrl: "https://api.openai.com/v1",
        authentication: "bearer_keyring",
        selectedModel: "stale",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "MODEL_PROFILE_REVISION_CONFLICT" });

    const serialized = window.localStorage.getItem(DEVELOPMENT_MODEL_CENTER_KEY) ?? "";
    expect(serialized).not.toMatch(/api[_-]?key|access[_-]?token|password|secret/iu);
    expect(JSON.parse(serialized)).toMatchObject({ schemaVersion: 2 });
  });

  it("migrates version-one profiles without inventing pricing", async () => {
    window.localStorage.setItem(
      DEVELOPMENT_MODEL_CENTER_KEY,
      JSON.stringify({
        schemaVersion: 1,
        profiles: {
          "ollama-local": {
            providerId: "ollama-local",
            provider: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            authentication: "none",
            selectedModel: "local-test",
            revision: 1,
            createdAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
        },
      }),
    );

    const store = new BrowserDevelopmentModelCenterStore(window.localStorage, clock);
    await expect(store.listProfiles()).resolves.toMatchObject([
      { providerId: "ollama-local", pricing: null },
    ]);
  });

  it("rejects remote plaintext HTTP and credential-bearing endpoint URLs", async () => {
    const store = new BrowserDevelopmentModelCenterStore(window.localStorage, clock);
    await expect(
      store.save({
        providerId: "remote",
        provider: "open_ai_compatible",
        baseUrl: "http://models.example/v1",
        authentication: "none",
        selectedModel: null,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_ENDPOINT_INVALID" });
    await expect(
      store.save({
        providerId: "embedded",
        provider: "open_ai_compatible",
        baseUrl: "https://user:password@models.example/v1",
        authentication: "none",
        selectedModel: null,
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: "MODEL_ENDPOINT_INVALID" });

    await expect(
      store.save({
        providerId: "ollama-local",
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        authentication: "none",
        selectedModel: null,
        expectedRevision: null,
      }),
    ).resolves.toMatchObject({ provider: "ollama" });
  });
});
