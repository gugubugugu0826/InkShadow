import { describe, expect, it, vi } from "vitest";

import { ModelCenterError } from "./model-center-store";
import {
  assertStructuredProbeResponse,
  MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
  runModelHubStructuredCapabilityProbe,
} from "./model-hub-structured-capability-probe";
import type { NativeModelEndpointConfig, NativeModelGatewayClient } from "./runtime";

describe("Model Hub structured output capability probe", () => {
  it("uses JSON mode, a real JSON budget and disabled DeepSeek reasoning", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({
        text: '{"schemaVersion":1,"ok":true,"label":"inkshadow"}',
        usage: { inputTokens: 20, outputTokens: 12, cachedInputTokens: null },
        streamed: true,
      }),
    );

    await expect(runModelHubStructuredCapabilityProbe(input(generate))).resolves.toMatchObject({
      attempts: 1,
      repaired: false,
      verificationMethod: "openai_compatible_json_object",
    });
    const dispatched = generate.mock.calls[0]?.[0];
    expect(dispatched?.config.retryLimit).toBe(0);
    expect(dispatched?.responseFormat).toBe("json_object");
    expect(dispatched?.reasoningMode).toBe("disabled");
    expect(dispatched?.maxOutputTokens).toBe(
      MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
    );
    expect(generate.mock.calls[0]?.[0].messages.map(({ content }) => content).join(" ")).toContain(
      "JSON",
    );
  });

  it.each([
    ["", "MODEL_STRUCTURED_OUTPUT_EMPTY"],
    ["```json\n{}\n```", "MODEL_STRUCTURED_OUTPUT_INVALID_JSON"],
    ['{"schemaVersion":1,"ok":true,"label":"wrong"}', "MODEL_STRUCTURED_OUTPUT_SCHEMA_MISMATCH"],
    [
      '{"schemaVersion":1,"ok":true,"label":"inkshadow","extra":1}',
      "MODEL_STRUCTURED_OUTPUT_SCHEMA_MISMATCH",
    ],
  ])("rejects empty, extra prose and schema mismatches", (response, code) => {
    expect(() => assertStructuredProbeResponse(response)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it("fails one invalid response without a hidden repair request", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>().mockResolvedValue({
      text: "not json",
      usage: { inputTokens: 9, outputTokens: 3, cachedInputTokens: null },
      streamed: true,
    });

    await expect(runModelHubStructuredCapabilityProbe(input(generate))).rejects.toMatchObject({
      code: "MODEL_STRUCTURED_OUTPUT_PROBE_FAILED",
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not retry a truncated response", async () => {
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockRejectedValue(new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "length", true));

    await expect(runModelHubStructuredCapabilityProbe(input(generate))).rejects.toMatchObject({
      code: "MODEL_STRUCTURED_OUTPUT_PROBE_FAILED",
      retryable: true,
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("fails closed for a non OpenAI-compatible provider protocol", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>();
    await expect(
      runModelHubStructuredCapabilityProbe({ ...input(generate), providerKind: "ollama" }),
    ).rejects.toMatchObject({ code: "MODEL_STRUCTURED_OUTPUT_PROBE_UNSUPPORTED" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("rechecks the disclosed target before dispatch and makes zero calls when it changed", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>();
    const assertBeforeProviderDispatch = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("MODEL_HUB_TASK_PROBE_DISCLOSURE_CHANGED"));

    await expect(
      runModelHubStructuredCapabilityProbe({
        ...input(generate),
        assertBeforeProviderDispatch,
      }),
    ).rejects.toThrow("MODEL_HUB_TASK_PROBE_DISCLOSURE_CHANGED");
    expect(assertBeforeProviderDispatch).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });
});

function input(generate: NativeModelGatewayClient["generate"]) {
  return {
    gateway: { generate },
    providerKind: "deepseek" as const,
    generationId: "structured-probe-1",
    config: endpoint(),
    model: "deepseek-v4-flash",
  };
}

function endpoint(): NativeModelEndpointConfig {
  return Object.freeze({
    providerId: "probe-provider",
    provider: "open_ai_compatible",
    baseUrl: "https://api.deepseek.com",
    authentication: "none",
  });
}
