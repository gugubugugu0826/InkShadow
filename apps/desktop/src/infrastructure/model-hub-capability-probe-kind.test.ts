import { describe, expect, it } from "vitest";

import {
  recommendModelHubCapabilityProbeKind,
  requireModelHubCapabilityProbeKind,
} from "./model-hub-capability-probe-kind";

describe("Model Hub capability probe kind", () => {
  it("uses exact official capability metadata instead of guessing from the model name", () => {
    expect(
      recommendModelHubCapabilityProbeKind({
        providerKind: "alibaba_qwen",
        modelId: "text-embedding-v4",
        capabilityEvidence: [],
        requestedTask: null,
      }),
    ).toBe("embedding");
    expect(
      recommendModelHubCapabilityProbeKind({
        providerKind: "deepseek",
        modelId: "deepseek-v4-flash",
        capabilityEvidence: [],
        requestedTask: null,
      }),
    ).toBe("text_generation");
  });

  it("uses task assignment or persisted supported evidence when either is unambiguous", () => {
    expect(
      recommendModelHubCapabilityProbeKind({
        providerKind: "custom_openai_compatible",
        modelId: "account-model",
        capabilityEvidence: [],
        requestedTask: "embedding",
      }),
    ).toBe("embedding");
    expect(
      recommendModelHubCapabilityProbeKind({
        providerKind: "custom_openai_compatible",
        modelId: "account-model",
        capabilityEvidence: [{ capability: "embedding", verdict: "supported", expiresAt: null }],
        requestedTask: null,
      }),
    ).toBe("embedding");
  });

  it("requires an explicit user choice when no trusted capability source exists", () => {
    const recommended = recommendModelHubCapabilityProbeKind({
      providerKind: "custom_openai_compatible",
      modelId: "unknown-account-model",
      capabilityEvidence: [],
      requestedTask: null,
    });

    expect(recommended).toBeNull();
    expect(() => requireModelHubCapabilityProbeKind(recommended)).toThrow(
      expect.objectContaining({ code: "MODEL_HUB_CAPABILITY_SELECTION_REQUIRED" }),
    );
  });
});
