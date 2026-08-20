import { describe, expect, it, vi } from "vitest";

import {
  MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION,
  runModelHubTranslationCapabilityProbe,
} from "./model-hub-translation-capability-probe";
import type { NativeModelGatewayClient } from "./runtime";

describe("Model Hub translation capability probe", () => {
  it("sends only fixed non-project text and accepts a strict local translation", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>().mockResolvedValue({
      text: "The rain has stopped.",
      usage: { inputTokens: 20, outputTokens: 6, cachedInputTokens: null },
      streamed: false,
    });
    const result = await runModelHubTranslationCapabilityProbe({
      gateway: { generate },
      providerKind: "deepseek",
      generationId: "019fa000-0000-7000-8000-000000000001",
      config: {
        providerId: "translation-probe",
        provider: "open_ai_compatible",
        baseUrl: "https://api.deepseek.com",
        authentication: "none",
        requestTimeoutMs: 30_000,
        retryLimit: 3,
      },
      model: "current-text-model",
    });

    expect(result.evidenceVersion).toBe(MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION);
    const request = generate.mock.calls[0]?.[0];
    expect(request?.dispatchScope).toEqual({ kind: "non_project", reason: "connection_probe" });
    expect(request?.reasoningMode).toBe("disabled");
    expect(request?.config.retryLimit).toBe(0);
    expect(request?.maxOutputTokens).toBe(64);
    expect(request?.messages[0]?.content).toContain("fixed Chinese sentence");
    expect(request?.messages[1]).toEqual({ role: "user", content: "雨停了。" });
  });

  it("rechecks the disclosed target before dispatch and makes zero calls when it changed", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>();
    const assertBeforeProviderDispatch = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("MODEL_HUB_TASK_PROBE_DISCLOSURE_CHANGED"));

    await expect(
      runModelHubTranslationCapabilityProbe({
        gateway: { generate },
        providerKind: "openai",
        generationId: "019fa000-0000-7000-8000-000000000005",
        config: {
          providerId: "translation-probe",
          provider: "open_ai_compatible",
          baseUrl: "https://api.openai.com/v1",
          authentication: "none",
          requestTimeoutMs: 30_000,
          retryLimit: 4,
        },
        model: "current-text-model",
        assertBeforeProviderDispatch,
      }),
    ).rejects.toThrow("MODEL_HUB_TASK_PROBE_DISCLOSURE_CHANGED");
    expect(assertBeforeProviderDispatch).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not promote an unrelated visible-text answer", async () => {
    await expect(
      runModelHubTranslationCapabilityProbe({
        gateway: {
          generate: () =>
            Promise.resolve({
              text: "OK",
              usage: null,
              streamed: false,
            }),
        },
        providerKind: "openai",
        generationId: "019fa000-0000-7000-8000-000000000002",
        config: {
          providerId: "translation-probe",
          provider: "open_ai_compatible",
          baseUrl: "https://api.openai.com/v1",
          authentication: "none",
          requestTimeoutMs: 30_000,
          retryLimit: 0,
        },
        model: "current-text-model",
      }),
    ).rejects.toMatchObject({ code: "MODEL_TRANSLATION_PROBE_FAILED" });
  });

  it.each(["It stopped raining.", "It has stopped raining!"])(
    "accepts the equivalent fixed translation %s without returning the response",
    async (text) => {
      const result = await runModelHubTranslationCapabilityProbe({
        gateway: {
          generate: () =>
            Promise.resolve({
              text,
              usage: null,
              streamed: false,
            }),
        },
        providerKind: "openai",
        generationId: "019fa000-0000-7000-8000-000000000003",
        config: {
          providerId: "translation-probe",
          provider: "open_ai_compatible",
          baseUrl: "https://api.openai.com/v1",
          authentication: "none",
          requestTimeoutMs: 30_000,
          retryLimit: 0,
        },
        model: "current-text-model",
      });

      expect(result).toEqual({
        evidenceVersion: MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION,
        streamed: false,
        usage: null,
      });
      expect(result).not.toHaveProperty("text");
    },
  );

  it.each(["It stopped.", "It stopped raining yesterday.", "The rain will stop."])(
    "rejects the non-equivalent or over-broad translation %s",
    async (text) => {
      await expect(
        runModelHubTranslationCapabilityProbe({
          gateway: {
            generate: () =>
              Promise.resolve({
                text,
                usage: null,
                streamed: false,
              }),
          },
          providerKind: "openai",
          generationId: "019fa000-0000-7000-8000-000000000004",
          config: {
            providerId: "translation-probe",
            provider: "open_ai_compatible",
            baseUrl: "https://api.openai.com/v1",
            authentication: "none",
            requestTimeoutMs: 30_000,
            retryLimit: 0,
          },
          model: "current-text-model",
        }),
      ).rejects.toMatchObject({ code: "MODEL_TRANSLATION_PROBE_FAILED" });
    },
  );
});
