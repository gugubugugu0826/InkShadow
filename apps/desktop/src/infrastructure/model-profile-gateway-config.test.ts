import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDevelopmentRuntime } from "./runtime";
import {
  clearLegacyModelProfileSelection,
  resolveFinalModelProfileGatewayConfig,
  resolveModelProfileGatewayConfig,
} from "./model-profile-gateway-config";

describe("model profile gateway config", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the logical profile id while resolving the current versioned vault slot", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const profile = await runtime.modelCenter.save({
      providerId: "legacy-openai",
      provider: "open_ai_compatible",
      baseUrl: "https://legacy.example.test/v1",
      authentication: "bearer_keyring",
      selectedModel: "writer-model",
      expectedRevision: null,
    });
    await runtime.modelHub.saveConnection({
      id: profile.providerId,
      providerKind: "openai",
      displayName: "OpenAI",
      credentialRef: "keyring:model-hub:model-key-current",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const getSummary = vi.fn((providerId: string) =>
      Promise.resolve({ configured: providerId === "model-key-current" }),
    );

    await expect(
      resolveModelProfileGatewayConfig(
        { modelHub: runtime.modelHub, credentials: { getSummary } },
        profile,
      ),
    ).resolves.toMatchObject({
      logicalProviderId: profile.providerId,
      source: "model_hub",
      config: { providerId: "model-key-current", authentication: "bearer_keyring" },
    });
    expect(getSummary).toHaveBeenCalledWith("model-key-current");
    expect(getSummary).not.toHaveBeenCalledWith(profile.providerId);
  });

  it("fails closed for a disabled Model Hub connection instead of using a stale legacy key", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const profile = await runtime.modelCenter.save({
      providerId: "disabled-provider",
      provider: "open_ai_compatible",
      baseUrl: "https://legacy.example.test/v1",
      authentication: "bearer_keyring",
      selectedModel: "writer-model",
      expectedRevision: null,
    });
    await runtime.modelHub.saveConnection({
      id: profile.providerId,
      providerKind: "openai",
      displayName: "Disabled",
      credentialRef: null,
      credentialState: "missing",
      authenticationMode: "bearer_keyring",
      enabled: false,
      expectedRevision: null,
    });
    const getSummary = vi.fn(() => Promise.resolve({ configured: true }));

    await expect(
      resolveModelProfileGatewayConfig(
        { modelHub: runtime.modelHub, credentials: { getSummary } },
        profile,
      ),
    ).resolves.toBeNull();
    expect(getSummary).not.toHaveBeenCalled();
  });

  it("accepts an unchanged final identity but rejects a rotated credential slot", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const profile = await runtime.modelCenter.save({
      providerId: "final-dispatch-profile",
      provider: "open_ai_compatible",
      baseUrl: "https://legacy.example.test/v1",
      authentication: "bearer_keyring",
      selectedModel: "writer-model",
      expectedRevision: null,
    });
    const connection = await runtime.modelHub.saveConnection({
      id: profile.providerId,
      providerKind: "openai",
      displayName: "OpenAI",
      credentialRef: "keyring:model-hub:model-key-v1",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const credentials = { getSummary: vi.fn(() => Promise.resolve({ configured: true })) };
    const dependencies = {
      modelCenter: runtime.modelCenter,
      modelHub: runtime.modelHub,
      credentials,
    };
    const initial = await resolveModelProfileGatewayConfig(dependencies, profile);
    if (initial === null) throw new Error("test resolution missing");

    await expect(
      resolveFinalModelProfileGatewayConfig(dependencies, profile, initial),
    ).resolves.toMatchObject({ resolution: { config: { providerId: "model-key-v1" } } });

    await runtime.modelHub.saveConnection({
      id: connection.id,
      providerKind: connection.providerKind,
      displayName: connection.displayName,
      credentialRef: "keyring:model-hub:model-key-v2",
      credentialState: "present",
      authenticationMode: connection.authenticationMode,
      enabled: true,
      expectedRevision: connection.revision,
    });
    await expect(
      resolveFinalModelProfileGatewayConfig(dependencies, profile, initial),
    ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION_CHANGED_BEFORE_DISPATCH" });
  });

  it("clears a legacy selected model idempotently", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const profile = await runtime.modelCenter.save({
      providerId: "clear-selection",
      provider: "open_ai_compatible",
      baseUrl: "https://legacy.example.test/v1",
      authentication: "bearer_keyring",
      selectedModel: "writer-model",
      pricing: {
        contextWindowTokens: 32_000,
        currency: "USD",
        inputMicrosPerMillionTokens: 1,
        outputMicrosPerMillionTokens: 2,
        cachedInputMicrosPerMillionTokens: null,
        pricingVersion: "test",
        priceUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
      expectedRevision: null,
    });

    await clearLegacyModelProfileSelection(runtime.modelCenter, profile.providerId);
    await clearLegacyModelProfileSelection(runtime.modelCenter, profile.providerId);

    await expect(runtime.modelCenter.findByProviderId(profile.providerId)).resolves.toMatchObject({
      selectedModel: null,
      pricing: null,
    });
  });
});
