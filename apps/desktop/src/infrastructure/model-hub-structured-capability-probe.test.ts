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
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: "json_object",
        reasoningMode: "disabled",
        maxOutputTokens: MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
      }),
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

  it("repairs one invalid response with the same model and a fresh generation id", async () => {
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockResolvedValueOnce({ text: "not json", usage: null, streamed: true })
      .mockResolvedValueOnce({
        text: ' {"schemaVersion":1,"ok":true,"label":"inkshadow"} ',
        usage: null,
        streamed: true,
      });

    await expect(runModelHubStructuredCapabilityProbe(input(generate))).resolves.toMatchObject({
      attempts: 2,
      repaired: true,
    });
    expect(generate.mock.calls.map(([request]) => request.generationId)).toEqual([
      "structured-probe-1",
      "structured-probe-2",
    ]);
  });

  it("retries one truncated response but never treats partial JSON as verified", async () => {
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockRejectedValueOnce(new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "length", true))
      .mockRejectedValueOnce(new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "length", true));

    await expect(runModelHubStructuredCapabilityProbe(input(generate))).rejects.toMatchObject({
      code: "MODEL_STRUCTURED_OUTPUT_PROBE_FAILED",
      retryable: true,
    });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("fails closed for a non OpenAI-compatible provider protocol", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>();
    await expect(
      runModelHubStructuredCapabilityProbe({ ...input(generate), providerKind: "ollama" }),
    ).rejects.toMatchObject({ code: "MODEL_STRUCTURED_OUTPUT_PROBE_UNSUPPORTED" });
    expect(generate).not.toHaveBeenCalled();
  });
});

function input(generate: NativeModelGatewayClient["generate"]) {
  return {
    gateway: { generate },
    providerKind: "deepseek" as const,
    generationIds: ["structured-probe-1", "structured-probe-2"] as const,
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
