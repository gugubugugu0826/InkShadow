import { describe, expect, it, vi } from "vitest";

import { ModelCenterError } from "./model-center-store";
import {
  MODEL_HUB_TEXT_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
  runModelHubTextCapabilityProbe,
} from "./model-hub-text-capability-probe";
import { modelProviderTextCapabilityProbePolicy } from "./model-hub-provider-registry";
import type { NativeModelEndpointConfig, NativeModelGatewayClient } from "./runtime";

describe("shared Model Hub text capability probe", () => {
  it("disables DeepSeek reasoning and reserves 64 output tokens", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({ text: "OK", usage: null, streamed: false }),
    );

    await runModelHubTextCapabilityProbe({
      gateway: { generate },
      providerKind: "deepseek",
      generationId: "probe-deepseek",
      config: endpoint(),
      model: "deepseek-v4-flash",
    });

    expect(modelProviderTextCapabilityProbePolicy("deepseek")).toEqual({
      maxOutputTokens: MODEL_HUB_TEXT_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
      reasoningMode: "disabled",
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "只回复：OK" }],
        maxOutputTokens: 64,
        reasoningMode: "disabled",
      }),
    );
  });

  it("does not add a reasoning override for providers without that probe contract", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({ text: "OK", usage: null, streamed: false }),
    );

    await runModelHubTextCapabilityProbe({
      gateway: { generate },
      providerKind: "openai",
      generationId: "probe-openai",
      config: endpoint(),
      model: "writer-model",
    });

    expect(modelProviderTextCapabilityProbePolicy("openai").reasoningMode).toBeNull();
    expect(generate.mock.calls[0]?.[0]).not.toHaveProperty("reasoningMode");
  });

  it("accepts truncated output only when the probe observed visible text", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((input) => {
      input.onDelta?.("OK");
      return Promise.reject(
        new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "truncated", false, {
          requestId: "request-1",
          httpStatus: 200,
          finishReason: "length",
          visibleContentLength: 2,
          reasoningPresent: true,
          stream: true,
          inputTokens: 5,
          outputTokens: 64,
        }),
      );
    });

    await expect(
      runModelHubTextCapabilityProbe({
        gateway: { generate },
        providerKind: "deepseek",
        generationId: "probe-visible-truncation",
        config: endpoint(),
        model: "deepseek-v4-pro",
      }),
    ).resolves.toMatchObject({
      text: "OK",
      acceptedTruncatedOutput: true,
      streamed: true,
    });
  });

  it("fails when reasoning is present but no visible text was emitted", async () => {
    const reasoningOnly = new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "truncated", false, {
      requestId: "request-2",
      httpStatus: 200,
      finishReason: "length",
      visibleContentLength: 0,
      reasoningPresent: true,
      stream: true,
      inputTokens: 5,
      outputTokens: 64,
    });
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.reject(reasoningOnly),
    );

    await expect(
      runModelHubTextCapabilityProbe({
        gateway: { generate },
        providerKind: "deepseek",
        generationId: "probe-reasoning-only",
        config: endpoint(),
        model: "deepseek-v4-flash",
      }),
    ).rejects.toBe(reasoningOnly);
  });

  it("uses only the native streamed marker, not the presence of delta callbacks", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((input) => {
      input.onDelta?.("OK");
      return Promise.resolve({ text: "OK", usage: null, streamed: false });
    });

    const result = await runModelHubTextCapabilityProbe({
      gateway: { generate },
      providerKind: "openai",
      generationId: "probe-non-stream",
      config: endpoint(),
      model: "writer-model",
    });

    expect(result.streamed).toBe(false);
  });
});

function endpoint(): NativeModelEndpointConfig {
  return Object.freeze({
    providerId: "probe-provider",
    provider: "open_ai_compatible",
    baseUrl: "https://api.example.test/v1",
    authentication: "none",
  });
}
