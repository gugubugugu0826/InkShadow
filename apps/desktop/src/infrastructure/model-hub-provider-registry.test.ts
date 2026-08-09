import { describe, expect, it } from "vitest";

import {
  MODEL_HUB_CAPABILITIES,
  MODEL_PROVIDER_KINDS,
  NOVEL_AI_TASKS,
  getModelProviderPreset,
  modelProviderVisibleProsePolicy,
  modelProviderTextCapabilityProbePolicy,
  isLoopbackModelBaseUrl,
  listModelProviderPresets,
  normalizeCredentialHeaderName,
  normalizeModelHubApiPath,
  normalizeModelHubRequestTimeoutMs,
  normalizeModelHubRetryLimit,
  resolveProviderBaseUrl,
} from "./model-hub-provider-registry";

describe("Model Hub provider registry", () => {
  it("uses a provider-declared, model-name-independent DeepSeek text probe policy", () => {
    expect(modelProviderTextCapabilityProbePolicy("deepseek")).toEqual({
      maxOutputTokens: 64,
      reasoningMode: "disabled",
    });
    expect(modelProviderTextCapabilityProbePolicy("openai")).toEqual({
      maxOutputTokens: 64,
      reasoningMode: null,
    });
  });

  it("disables reasoning for visible prose only on DeepSeek", () => {
    expect(modelProviderVisibleProsePolicy("deepseek")).toEqual({
      reasoningMode: "disabled",
    });
    for (const provider of MODEL_PROVIDER_KINDS.filter((provider) => provider !== "deepseek")) {
      expect(modelProviderVisibleProsePolicy(provider)).toEqual({ reasoningMode: null });
    }
  });

  it("registers the launch providers without hard-coding a model catalog", () => {
    const presets = listModelProviderPresets();

    expect(presets.map(({ id }) => id)).toEqual(MODEL_PROVIDER_KINDS);
    expect(new Set(presets.map(({ id }) => id)).size).toBe(9);
    expect(JSON.stringify(presets)).not.toMatch(/gpt-\d|claude-\d|gemini-\d|qwen\d|doubao-.*-\d/iu);
    expect(presets.every(({ officialDocsUrl }) => officialDocsUrl.startsWith("https://"))).toBe(
      true,
    );
  });

  it("keeps secrets in the credential vault and advanced fields out of the basic surface", () => {
    for (const preset of listModelProviderPresets()) {
      expect(preset.basicFields.every(({ visibility }) => visibility === "basic")).toBe(true);
      expect(preset.expertFields.every(({ visibility }) => visibility === "expert")).toBe(true);
      for (const field of [...preset.basicFields, ...preset.expertFields]) {
        if (field.input === "secret") {
          expect(field.storage).toBe("credential_vault");
        }
      }
    }

    expect(getModelProviderPreset("openai").basicFields.map(({ key }) => key)).toEqual(["apiKey"]);
    expect(getModelProviderPreset("ollama").basicFields).toEqual([]);
  });

  it("uses explicit capability and novel-task taxonomies", () => {
    expect(MODEL_HUB_CAPABILITIES).toHaveLength(12);
    expect(MODEL_HUB_CAPABILITIES).toContain("structured_output");
    expect(MODEL_HUB_CAPABILITIES).toContain("long_context");
    expect(NOVEL_AI_TASKS).toContain("book_start_guidance");
    expect(NOVEL_AI_TASKS).toContain("character_voice_check");
    expect(NOVEL_AI_TASKS).toContain("content_quality_check");
    expect(NOVEL_AI_TASKS).toContain("vision_understanding");
  });

  it("resolves region-aware Qwen endpoints and validates custom endpoints", () => {
    expect(resolveProviderBaseUrl("zhipu_glm")).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(getModelProviderPreset("zhipu_glm").modelDiscovery).toMatchObject({
      strategy: "preset_and_manual",
      automatic: false,
      path: null,
    });
    expect(resolveProviderBaseUrl("alibaba_qwen", { region: "china_beijing" })).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
    expect(
      resolveProviderBaseUrl("alibaba_qwen", {
        region: "singapore",
        workspaceId: "workspace-123",
      }),
    ).toBe("https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1");
    expect(resolveProviderBaseUrl("alibaba_qwen", { region: "singapore" })).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    );
    expect(() => resolveProviderBaseUrl("alibaba_qwen", { region: "japan_tokyo" })).toThrow(
      expect.objectContaining({ code: "MODEL_PROVIDER_WORKSPACE_REQUIRED" }),
    );
    expect(
      resolveProviderBaseUrl("custom_openai_compatible", {
        baseUrlOverride: "http://127.0.0.1:9000/v1/",
      }),
    ).toBe("http://127.0.0.1:9000/v1");
    expect(() =>
      resolveProviderBaseUrl("custom_openai_compatible", {
        baseUrlOverride: "http://models.example.test/v1",
      }),
    ).toThrow(expect.objectContaining({ code: "MODEL_PROVIDER_ENDPOINT_INSECURE" }));
  });

  it("classifies privacy by the resolved host instead of the provider name", () => {
    expect(isLoopbackModelBaseUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopbackModelBaseUrl("https://localhost:11434/api")).toBe(true);
    expect(isLoopbackModelBaseUrl("https://[::1]:11434")).toBe(true);
    expect(isLoopbackModelBaseUrl("https://remote-ollama.example/v1")).toBe(false);
    expect(isLoopbackModelBaseUrl("not a url")).toBe(false);
  });

  it("declares only the implemented single-Header and custom path controls", () => {
    const customKeys = getModelProviderPreset("custom_openai_compatible").expertFields.map(
      ({ key }) => key,
    );
    expect(customKeys).toEqual([
      "modelDiscoveryPath",
      "textGenerationPath",
      "embeddingPath",
      "authenticationMode",
      "credentialHeaderName",
      "requestTimeoutMs",
      "retryLimit",
    ]);
    expect(JSON.stringify(listModelProviderPresets())).not.toContain("credentialHeaders");
    for (const preset of listModelProviderPresets().filter(
      ({ id }) => id !== "custom_openai_compatible",
    )) {
      expect(preset.expertFields.map(({ key }) => key)).not.toEqual(
        expect.arrayContaining([
          "modelDiscoveryPath",
          "textGenerationPath",
          "embeddingPath",
          "credentialHeaderName",
        ]),
      );
    }
  });

  it("rejects authority, traversal, query, fragment, escape and encoded path bypasses", () => {
    expect(normalizeModelHubApiPath("/tenant/models")).toBe("/tenant/models");
    for (const path of [
      "//attacker.example/models",
      "/models?token=value",
      "/models#fragment",
      "/models\\escape",
      "/models/../admin",
      "/models/./list",
      "/%2e%2e/admin",
      "models",
      "/models\nnext",
    ]) {
      expect(() => normalizeModelHubApiPath(path)).toThrow(
        expect.objectContaining({ code: "MODEL_PROVIDER_API_PATH_INVALID" }),
      );
    }
  });

  it("accepts safe credential names but rejects transport and browser-controlled Headers", () => {
    expect(normalizeCredentialHeaderName("Authorization")).toBe("authorization");
    expect(normalizeCredentialHeaderName("X-API-Key")).toBe("x-api-key");
    for (const name of [
      "Host",
      "Cookie",
      "Content-Length",
      "Connection",
      "Transfer-Encoding",
      "Proxy-Authorization",
      "Sec-Fetch-Site",
      "X-Forwarded-Host",
      "bad header",
      "bad\r\nheader",
    ]) {
      expect(() => normalizeCredentialHeaderName(name)).toThrow();
    }
  });

  it("bounds connection timeouts and idempotent retry counts", () => {
    expect(normalizeModelHubRequestTimeoutMs(undefined)).toBe(30_000);
    expect(normalizeModelHubRequestTimeoutMs(1_000)).toBe(1_000);
    expect(() => normalizeModelHubRequestTimeoutMs(999)).toThrow();
    expect(() => normalizeModelHubRequestTimeoutMs(600_001)).toThrow();
    expect(normalizeModelHubRetryLimit(undefined)).toBe(0);
    expect(normalizeModelHubRetryLimit(3)).toBe(3);
    expect(() => normalizeModelHubRetryLimit(4)).toThrow();
  });
});
