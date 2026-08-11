import { describe, expect, it } from "vitest";

import type { ModelHubCapability } from "./model-hub-provider-registry";
import type { ModelHubModelProjection } from "./model-hub-routing-visibility";
import { recommendConnectedModelsForTask } from "./model-hub-task-recommendation";

describe("connected Model Hub task recommendations", () => {
  it("uses a connected, probed model and does not route from catalog-only evidence", () => {
    const catalogOnly = model("catalog-only", "openai", {
      text_generation: "catalog_declared",
    });
    const verified = model("verified", "deepseek", { text_generation: "verified" });
    expect(
      recommendConnectedModelsForTask("continuation", [catalogOnly, verified]).map(
        ({ model: candidate }) => candidate.catalogEntry.id,
      ),
    ).toEqual(["verified"]);
  });

  it("offers the strict JSON probe before assigning an OpenAI-compatible structured task", () => {
    const deepseek = model("deepseek-text", "deepseek", { text_generation: "verified" });
    expect(recommendConnectedModelsForTask("what_if_simulation", [deepseek])).toMatchObject([
      {
        readiness: "verify_structured_output",
        missingVerificationCapabilities: ["structured_output"],
      },
    ]);
  });

  it("treats provider-declared structured output as a reason to probe, not verified routing evidence", () => {
    const declared = model("declared-json", "deepseek", {
      text_generation: "verified",
      structured_output: "catalog_declared",
    });
    expect(recommendConnectedModelsForTask("what_if_simulation", [declared])).toMatchObject([
      { readiness: "verify_structured_output" },
    ]);
  });

  it.each(["embedding", "rerank", "image_generation", "vision_understanding"] as const)(
    "does not infer %s from a DeepSeek text model",
    (task) => {
      const deepseek = model("deepseek-text", "deepseek", { text_generation: "verified" });
      expect(recommendConnectedModelsForTask(task, [deepseek])).toEqual([]);
    },
  );

  it("does not offer the JSON probe on a protocol that cannot express response_format", () => {
    const ollama = model("ollama-text", "ollama", { text_generation: "verified" });
    expect(recommendConnectedModelsForTask("what_if_simulation", [ollama])).toEqual([]);
  });

  it("requires a fixed translation probe before a verified text model can take translation", () => {
    const deepseek = model("deepseek-text", "deepseek", { text_generation: "verified" });
    expect(recommendConnectedModelsForTask("translation", [deepseek])).toMatchObject([
      {
        readiness: "verify_translation",
        missingVerificationCapabilities: ["translation"],
      },
    ]);
  });
});

function model(
  id: string,
  providerKind: "openai" | "deepseek" | "ollama",
  states: Partial<
    Record<ModelHubCapability, ModelHubModelProjection["capabilities"][number]["state"]>
  >,
): ModelHubModelProjection {
  const now = "2026-08-10T00:00:00.000Z";
  return {
    catalogEntry: {
      id,
      connectionId: `${id}-connection`,
      providerModelId: `${id}-model`,
      displayName: id,
      ownedBy: null,
      catalogSource: "provider_api",
      availability: "available",
      lifecycle: "stable",
      inputTokenLimit: null,
      outputTokenLimit: null,
      firstDiscoveredAt: now,
      lastSeenAt: now,
      staleAfter: null,
      lastSyncId: null,
      revision: 1,
    },
    connection: {
      id: `${id}-connection`,
      providerKind,
      displayName: id,
      protocol: providerKind === "ollama" ? "ollama" : "openai_compatible",
      region: null,
      workspaceId: null,
      endpointId: null,
      baseUrl: providerKind === "ollama" ? "http://127.0.0.1:11434" : "https://example.test",
      credentialRef: "vault-ref",
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
      lastTestedAt: now,
      lastCatalogSyncedAt: now,
      lastErrorCode: null,
      lastErrorSummary: null,
      legacyProviderId: null,
      enabled: true,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    connectionUsable: true,
    capabilities: Object.freeze(
      Object.entries(states).map(([capability, state]) => ({
        capability: capability as ModelHubCapability,
        state,
        source:
          state === "verified" ? ("lightweight_probe" as const) : ("provider_metadata" as const),
        observedAt: now,
        failureCode: null,
      })),
    ),
    lastVerifiedAt: now,
    latestProbeFailureCode: null,
  };
}
