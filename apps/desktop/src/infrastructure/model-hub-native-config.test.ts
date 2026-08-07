import { describe, expect, it } from "vitest";

import { modelHubNativeEndpointConfig } from "./model-hub-native-config";
import type { ModelProviderConnection } from "./model-hub-store";

const NOW = "2026-08-02T00:00:00.000Z";

describe("Model Hub native endpoint config", () => {
  it("forwards safe custom metadata to discovery, text, embedding and image callers without a secret", () => {
    const config = modelHubNativeEndpointConfig(
      connection({
        providerKind: "custom_openai_compatible",
        authenticationMode: "custom_header_keyring",
        credentialHeaderName: "x-api-key",
        modelDiscoveryPath: "/catalog/models",
        textGenerationPath: "/text/chat",
        embeddingPath: "/vectors/embed",
        requestTimeoutMs: 47_000,
        retryLimit: 2,
      }),
    );

    expect(config).toEqual({
      providerId: "connection-1",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example.test/v1",
      authentication: "custom_header_keyring",
      credentialHeaderName: "x-api-key",
      modelDiscoveryPath: "/catalog/models",
      textGenerationPath: "/text/chat",
      embeddingPath: "/vectors/embed",
      requestTimeoutMs: 47_000,
      retryLimit: 2,
    });
    expect(JSON.stringify(config)).not.toContain("super-secret-header-value");
  });

  it("does not forward path or Header overrides for named provider presets", () => {
    const config = modelHubNativeEndpointConfig(
      connection({
        providerKind: "openai",
        authenticationMode: "bearer_keyring",
        credentialHeaderName: null,
        modelDiscoveryPath: null,
        textGenerationPath: null,
        embeddingPath: null,
      }),
    );

    expect(config).not.toHaveProperty("credentialHeaderName");
    expect(config).not.toHaveProperty("modelDiscoveryPath");
    expect(config).not.toHaveProperty("textGenerationPath");
    expect(config).not.toHaveProperty("embeddingPath");
    expect(config).toMatchObject({
      provider: "open_ai_compatible",
      requestTimeoutMs: 30_000,
      retryLimit: 0,
    });
  });
});

function connection(overrides: Partial<ModelProviderConnection> = {}): ModelProviderConnection {
  return {
    id: "connection-1",
    providerKind: "custom_openai_compatible",
    displayName: "Connection",
    protocol: "openai_compatible",
    region: null,
    workspaceId: null,
    endpointId: null,
    baseUrl: "https://models.example.test/v1",
    credentialRef: "keyring:model-hub:connection-1",
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    credentialHeaderName: null,
    modelDiscoveryPath: null,
    textGenerationPath: null,
    embeddingPath: null,
    requestTimeoutMs: 30_000,
    retryLimit: 0,
    connectionStatus: "ready",
    catalogSyncStatus: "succeeded",
    lastTestedAt: NOW,
    lastCatalogSyncedAt: NOW,
    lastErrorCode: null,
    lastErrorSummary: null,
    legacyProviderId: null,
    enabled: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
