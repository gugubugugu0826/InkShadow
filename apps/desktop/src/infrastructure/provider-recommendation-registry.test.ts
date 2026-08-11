import { describe, expect, it } from "vitest";

import {
  PROVIDER_RECOMMENDATION_REGISTRY_VERSION,
  providerRecommendationsForTask,
} from "./provider-recommendation-registry";

describe("provider recommendation registry", () => {
  it("groups specialized capability gaps without recommending a text-only model", () => {
    expect(
      providerRecommendationsForTask("embedding", "2026-08-10T12:00:00.000Z")[0],
    ).toMatchObject({
      providerKind: "alibaba_qwen",
      capability: "embedding",
      modelFamilies: ["text-embedding-v4"],
      registryVersion: PROVIDER_RECOMMENDATION_REGISTRY_VERSION,
      status: "provider_documented_not_verified",
    });
    expect(
      providerRecommendationsForTask("embedding", "2026-08-10T12:00:00.000Z")[0]?.modelFamilies,
    ).not.toContain("qwen3.7-text-embedding");
    expect(providerRecommendationsForTask("rerank", "2026-08-10T12:00:00.000Z")[0]).toMatchObject({
      providerKind: "alibaba_qwen",
      capability: "rerank",
    });
    expect(
      providerRecommendationsForTask("image_generation", "2026-08-10T12:00:00.000Z")[0],
    ).toMatchObject({
      providerKind: "volcengine_doubao",
      capability: "image_generation",
    });
    expect(providerRecommendationsForTask("embedding", "2026-08-10T12:00:00.000Z")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ providerKind: "deepseek" })]),
    );
  });

  it("does not present stale provider metadata as a current recommendation", () => {
    expect(providerRecommendationsForTask("embedding", "2026-09-10T00:00:00.000Z")).toEqual([]);
  });

  it("leaves ordinary text tasks to connected-model evidence", () => {
    expect(providerRecommendationsForTask("continuation", "2026-08-10T12:00:00.000Z")).toEqual([]);
  });
});
