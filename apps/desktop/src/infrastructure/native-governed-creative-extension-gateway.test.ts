import type { UuidV7, UuidV7Generator } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type { GovernedExtensionGatewayRequest } from "./governed-creative-extensions-runtime";
import type { ModelProfile } from "./model-center-store";
import {
  NativeGovernedCreativeExtensionGateway,
  resolveConfiguredGovernedCreativeExtensionRoute,
} from "./native-governed-creative-extension-gateway";

const NOW = "2026-07-28T10:00:00.000Z";
const UUID = "019fa028-0000-7000-8000-000000000001" as UuidV7;

describe("native governed creative-extension adapter", () => {
  it("resolves a credentialed translation route with immutable pricing and limits", async () => {
    const profile = modelProfile();
    const resolved = await resolveConfiguredGovernedCreativeExtensionRoute("translation", {
      modelRouting: {
        findRoute: vi.fn().mockResolvedValue({
          role: "translation",
          primaryProviderId: profile.providerId,
          primaryModelId: profile.selectedModel,
          fallbackProviderId: null,
          fallbackModelId: null,
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      },
      modelCenter: { findByProviderId: vi.fn().mockResolvedValue(profile) },
      credentials: {
        getSummary: vi.fn().mockResolvedValue({ configured: true, lastFour: "abcd" }),
      },
    });

    expect(resolved).toMatchObject({
      location: "remote",
      providerId: "remote-provider",
      baseUrl: "https://models.example/v1",
      modelId: "translate-1",
      pricing: { priceVersion: "price-1", currency: "USD" },
      limits: { maximumOutputTokens: 4_096, timeoutMs: 300_000 },
    });
  });

  it("fails closed when a routed remote credential is not configured", async () => {
    const profile = modelProfile();
    await expect(
      resolveConfiguredGovernedCreativeExtensionRoute("translation", {
        modelRouting: {
          findRoute: vi.fn().mockResolvedValue({
            role: "translation",
            primaryProviderId: profile.providerId,
            primaryModelId: profile.selectedModel,
            fallbackProviderId: null,
            fallbackModelId: null,
            revision: 1,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        },
        modelCenter: { findByProviderId: vi.fn().mockResolvedValue(profile) },
        credentials: {
          getSummary: vi.fn().mockResolvedValue({ configured: false, lastFour: null }),
        },
      }),
    ).resolves.toBeNull();
  });

  it("sends source authority through the native gateway and maps provider usage", async () => {
    const generate = vi.fn().mockResolvedValue({
      text: '{"schemaVersion":1}',
      usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: 10 },
    });
    const gateway = new NativeGovernedCreativeExtensionGateway(
      {
        available: true,
        generate,
        cancelGeneration: vi.fn().mockResolvedValue(true),
      },
      { next: () => UUID } satisfies UuidV7Generator,
    );

    const result = await gateway.generate(request(), {
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      serializedCandidate: '{"schemaVersion":1}',
      usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: 10 },
    });
    const input = generate.mock.calls[0]?.[0] as {
      readonly messages: readonly { readonly role: string; readonly content: string }[];
      readonly config: { readonly baseUrl: string };
      readonly maxOutputTokens: number;
    };
    expect(input.config.baseUrl).toBe("https://models.example/v1");
    expect(input.maxOutputTokens).toBe(4_096);
    expect(input.messages[0]?.content).toContain("exactly one JSON object");
    expect(input.messages[1]?.content).toContain('"sourceVersionId":"version-1"');
    expect(input.messages[1]?.content).toContain('"checksum":"paragraph-checksum"');
  });

  it("does not invoke a provider for an already-aborted attempt", async () => {
    const generate = vi.fn();
    const gateway = new NativeGovernedCreativeExtensionGateway(
      {
        available: true,
        generate,
        cancelGeneration: vi.fn(),
      },
      { next: () => UUID } satisfies UuidV7Generator,
    );
    const controller = new AbortController();
    controller.abort();

    await expect(gateway.generate(request(), { signal: controller.signal })).rejects.toMatchObject({
      retryable: true,
    });
    expect(generate).not.toHaveBeenCalled();
  });
});

function modelProfile(): ModelProfile {
  return {
    providerId: "remote-provider",
    provider: "open_ai_compatible",
    baseUrl: "https://models.example/v1",
    authentication: "bearer_keyring",
    selectedModel: "translate-1",
    pricing: {
      contextWindowTokens: 32_768,
      currency: "USD",
      inputMicrosPerMillionTokens: 10_000,
      outputMicrosPerMillionTokens: 20_000,
      cachedInputMicrosPerMillionTokens: 5_000,
      pricingVersion: "price-1",
      priceUpdatedAt: NOW,
    },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function request(): GovernedExtensionGatewayRequest {
  return {
    requestFingerprint: "f".repeat(64),
    rangeChecksumAlgorithm: "sha256-utf8-double-newline-v1",
    paragraphAuthorities: [{ index: 0, text: "source paragraph", checksum: "paragraph-checksum" }],
    snapshot: {
      schemaVersion: 1,
      kind: "translation",
      projectId: "project-1",
      chapterId: "chapter-1",
      sourceVersionId: "version-1",
      sourceChecksum: "a".repeat(64),
      sourceText: "source paragraph",
      settings: {
        targetLanguage: { code: "en-US", label: "English (US)" },
        tone: "literary",
        glossaryVersion: "glossary-1",
        glossary: [],
      },
      provider: {
        location: "remote",
        providerId: "remote-provider",
        baseUrl: "https://models.example/v1",
        modelId: "translate-1",
      },
      dataCategories: ["chapter_text", "glossary", "translation_settings"],
      pricing: {
        inputMicrosPerMillionTokens: 10_000,
        outputMicrosPerMillionTokens: 20_000,
        currency: "USD",
        priceVersion: "price-1",
        priceUpdatedAt: NOW,
      },
      limits: {
        maximumInputTokens: 16_000,
        maximumOutputTokens: 4_096,
        timeoutMs: 300_000,
      },
    },
  };
}
