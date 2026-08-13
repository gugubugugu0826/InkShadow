import { beforeEach, describe, expect, it } from "vitest";

import {
  MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY,
  clearModelHubConnectionIntent,
  loadModelHubConnectionIntent,
  saveModelHubConnectionIntent,
} from "./model-hub-connection-intent";

const REGISTRY_VERSION = "provider-official-catalog@2026-08-13";

describe("Model Hub connection intent", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists only a bounded content-free task and exact model selection", () => {
    const saved = saveModelHubConnectionIntent(window.localStorage, {
      task: "continuation",
      providerKind: "deepseek",
      providerModelId: "deepseek-v4-flash",
      catalogRegistryVersion: REGISTRY_VERSION,
      now: "2026-08-13T00:00:00.000Z",
    });

    expect(saved).toMatchObject({
      schemaVersion: 1,
      task: "continuation",
      providerKind: "deepseek",
      providerModelId: "deepseek-v4-flash",
      expiresAt: "2026-08-13T00:30:00.000Z",
    });
    expect(
      loadModelHubConnectionIntent(
        window.localStorage,
        "2026-08-13T00:05:00.000Z",
        REGISTRY_VERSION,
      ),
    ).toEqual(saved);
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).not.toMatch(
      /prompt|chapter|credential|api.?key/iu,
    );
  });

  it("fails closed and removes expired, stale-registry, or malformed intents", () => {
    saveModelHubConnectionIntent(window.localStorage, {
      task: "rerank",
      providerKind: "alibaba_qwen",
      providerModelId: "qwen3-rerank",
      catalogRegistryVersion: REGISTRY_VERSION,
      now: "2026-08-13T00:00:00.000Z",
    });
    expect(
      loadModelHubConnectionIntent(
        window.localStorage,
        "2026-08-13T00:30:00.000Z",
        REGISTRY_VERSION,
      ),
    ).toBeNull();
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(
      MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        task: "continuation",
        providerKind: "deepseek",
        providerModelId: "deepseek-v4-flash",
        catalogRegistryVersion: REGISTRY_VERSION,
        createdAt: "2026-08-13T00:00:00.000Z",
        expiresAt: "2026-08-13T00:30:00.000Z",
        credential: "secret",
      }),
    );
    expect(
      loadModelHubConnectionIntent(
        window.localStorage,
        "2026-08-13T00:01:00.000Z",
        REGISTRY_VERSION,
      ),
    ).toBeNull();

    saveModelHubConnectionIntent(window.localStorage, {
      task: "continuation",
      providerKind: "deepseek",
      providerModelId: "deepseek-v4-flash",
      catalogRegistryVersion: REGISTRY_VERSION,
      now: "2026-08-13T00:00:00.000Z",
    });
    expect(
      loadModelHubConnectionIntent(
        window.localStorage,
        "2026-08-13T00:01:00.000Z",
        "provider-official-catalog@newer",
      ),
    ).toBeNull();
  });

  it("never overwrites storage with invalid identifiers and supports explicit cancellation", () => {
    const saved = saveModelHubConnectionIntent(window.localStorage, {
      task: "continuation",
      providerKind: "deepseek",
      providerModelId: " deepseek-v4-flash",
      catalogRegistryVersion: REGISTRY_VERSION,
      now: "2026-08-13T00:00:00.000Z",
    });
    expect(saved).toBeNull();
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).toBeNull();

    saveModelHubConnectionIntent(window.localStorage, {
      task: "continuation",
      providerKind: "deepseek",
      providerModelId: "deepseek-v4-flash",
      catalogRegistryVersion: REGISTRY_VERSION,
      now: "2026-08-13T00:00:00.000Z",
    });
    clearModelHubConnectionIntent(window.localStorage);
    expect(window.localStorage.getItem(MODEL_HUB_CONNECTION_INTENT_STORAGE_KEY)).toBeNull();
  });
});
