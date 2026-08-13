import { describe, expect, it } from "vitest";

import { MODEL_PROVIDER_KINDS, NOVEL_AI_TASKS } from "./model-hub-provider-registry";
import {
  SELECTABLE_MODEL_CATALOG_ENTRIES,
  SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
  mergeConnectedAndSelectableModels,
  projectSelectableModelCatalog,
  selectableModelsForTask,
} from "./selectable-model-catalog-registry";

const CURRENT = "2026-08-13T12:00:00.000Z";

describe("selectable model catalog registry", () => {
  it("contains only supported provider kinds and the reviewed exact model identifiers", () => {
    expect(SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION).toBe("2026-08-13.v1");
    expect(
      SELECTABLE_MODEL_CATALOG_ENTRIES.every(({ providerKind }) =>
        MODEL_PROVIDER_KINDS.includes(providerKind),
      ),
    ).toBe(true);

    const identities = SELECTABLE_MODEL_CATALOG_ENTRIES.map(
      ({ providerKind, modelId }) => `${providerKind}:${modelId ?? "<discovery>"}`,
    );
    expect(identities).toEqual([
      "openai:gpt-5.6-sol",
      "openai:gpt-5.6-terra",
      "openai:gpt-5.6-luna",
      "openai:text-embedding-3-large",
      "openai:text-embedding-3-small",
      "openai:gpt-image-2",
      "deepseek:deepseek-v4-pro",
      "deepseek:deepseek-v4-flash",
      "anthropic_claude:claude-fable-5",
      "anthropic_claude:claude-opus-5",
      "anthropic_claude:claude-sonnet-5",
      "anthropic_claude:claude-haiku-4-5-20251001",
      "google_gemini:gemini-3.6-flash",
      "google_gemini:gemini-3.5-flash",
      "google_gemini:gemini-3.5-flash-lite",
      "google_gemini:gemini-3.1-pro-preview",
      "google_gemini:gemini-embedding-2",
      "google_gemini:gemini-embedding-001",
      "google_gemini:gemini-3.1-flash-lite",
      "google_gemini:gemini-3.1-flash-image",
      "google_gemini:gemini-3.1-flash-lite-image",
      "google_gemini:gemini-3-pro-image",
      "alibaba_qwen:qwen3.8-max",
      "alibaba_qwen:qwen3.7-max",
      "alibaba_qwen:qwen3.7-plus",
      "alibaba_qwen:qwen3.7-flash",
      "alibaba_qwen:qwen3.7-text-embedding",
      "alibaba_qwen:text-embedding-v4",
      "alibaba_qwen:qwen3-vl-embedding",
      "alibaba_qwen:qwen3-rerank",
      "alibaba_qwen:qwen-image-2.0",
      "zhipu_glm:glm-5.2",
      "zhipu_glm:glm-5-turbo",
      "volcengine_doubao:<discovery>",
    ]);
    expect(identities.some((identity) => /kimi|cohere|ollama/iu.test(identity))).toBe(false);
    expect(
      identities.some((identity) => /claude-(fable|opus|sonnet)-5-20260806/u.test(identity)),
    ).toBe(false);
    expect(SELECTABLE_MODEL_CATALOG_ENTRIES.flatMap(({ aliases }) => aliases)).toEqual([
      "claude-haiku-4-5",
    ]);
  });

  it("keeps protocol and connection limitations explicit without inventing a route", () => {
    expect(
      SELECTABLE_MODEL_CATALOG_ENTRIES.find(({ modelId }) => modelId === "gpt-5.6-sol"),
    ).toMatchObject({ appSupport: "routable_after_verification", routable: false });
    expect(JSON.stringify(SELECTABLE_MODEL_CATALOG_ENTRIES)).not.toContain(
      '"appSupport":"supported"',
    );
    const geminiImages = SELECTABLE_MODEL_CATALOG_ENTRIES.filter(
      ({ providerKind, taskCategories }) =>
        providerKind === "google_gemini" && taskCategories.includes("image_generation"),
    );
    expect(geminiImages).toHaveLength(3);
    expect(geminiImages.every(({ appSupport }) => appSupport === "protocol_not_implemented")).toBe(
      true,
    );
    expect(
      SELECTABLE_MODEL_CATALOG_ENTRIES.find(({ modelId }) => modelId === "qwen3.8-max"),
    ).toMatchObject({ appSupport: "special_connection_required", lifecycle: "stable" });
    expect(
      SELECTABLE_MODEL_CATALOG_ENTRIES.find(({ modelId }) => modelId === "qwen-image-2.0"),
    ).toMatchObject({ appSupport: "protocol_not_implemented" });
    expect(
      SELECTABLE_MODEL_CATALOG_ENTRIES.find(
        ({ providerKind }) => providerKind === "volcengine_doubao",
      ),
    ).toMatchObject({ modelId: null, appSupport: "discovery_only" });
    expect([
      ...new Set(
        SELECTABLE_MODEL_CATALOG_ENTRIES.map(
          ({ routable, capabilityEvidence, status }) =>
            `${String(routable)}:${String(capabilityEvidence)}:${status}`,
        ),
      ),
    ]).toEqual(["false:false:provider_documented_not_verified"]);
  });

  it("hides evidence metadata from ordinary projection and exposes it only to experts", () => {
    const ordinary = projectSelectableModelCatalog(CURRENT);
    const expert = projectSelectableModelCatalog(CURRENT, { expert: true });
    expect(ordinary).toHaveLength(expert.length);
    expect(expert[0]?.officialSource.url).toMatch(/^https:\/\//u);
    const serialized = JSON.stringify(ordinary);
    expect(serialized).not.toContain("officialSource");
    expect(serialized).not.toContain("evidenceUrl");
    expect(serialized).not.toContain("updatedAt");
    expect(serialized).not.toContain("expiresAt");
    expect(serialized).not.toContain("https://");
  });

  it("expires official candidates at the TTL boundary instead of presenting stale metadata", () => {
    expect(projectSelectableModelCatalog("2026-09-12T23:59:59.999Z").length).toBeGreaterThan(0);
    expect(projectSelectableModelCatalog("2026-09-13T00:00:00.000Z")).toEqual([]);
    expect(projectSelectableModelCatalog("not-a-timestamp")).toEqual([]);
  });

  it("filters specialized tasks without treating general text models as capability evidence", () => {
    const embedding = selectableModelsForTask("embedding", CURRENT);
    expect(embedding.map(({ modelId }) => modelId)).toEqual([
      "text-embedding-3-large",
      "text-embedding-3-small",
      "gemini-embedding-2",
      "gemini-embedding-001",
      "qwen3.7-text-embedding",
      "text-embedding-v4",
      "qwen3-vl-embedding",
    ]);
    expect(selectableModelsForTask("rerank", CURRENT).map(({ modelId }) => modelId)).toEqual([
      "qwen3-rerank",
    ]);
    expect(
      selectableModelsForTask("continuation", CURRENT).some(({ modelId }) => modelId === null),
    ).toBe(false);
    expect([
      ...new Set(
        embedding.map(
          ({ capabilityEvidence, routable }) => `${String(capabilityEvidence)}:${String(routable)}`,
        ),
      ),
    ]).toEqual(["false:false"]);
  });

  it("offers an honest catalog candidate for every one of the 22 novel tasks", () => {
    expect(NOVEL_AI_TASKS).toHaveLength(22);
    const coverage = NOVEL_AI_TASKS.map((task) => ({
      task,
      candidates: selectableModelsForTask(task, CURRENT),
    }));
    expect(coverage.filter(({ candidates }) => candidates.length === 0)).toEqual([]);

    const translation = coverage.find(({ task }) => task === "translation")?.candidates ?? [];
    expect(translation).toContainEqual(
      expect.objectContaining({
        modelId: "gpt-5.6-sol",
        appSupport: "routable_after_verification",
        capabilityCategories: ["text_generation"],
        routable: false,
        capabilityEvidence: false,
      }),
    );

    const vision = coverage.find(({ task }) => task === "vision_understanding")?.candidates ?? [];
    expect(vision).toEqual([
      expect.objectContaining({
        providerKind: "google_gemini",
        modelId: "gemini-3.1-flash-lite",
        taskCategories: ["vision_understanding"],
        capabilityCategories: ["vision"],
        appSupport: "protocol_not_implemented",
        routable: false,
        capabilityEvidence: false,
      }),
    ]);
  });

  it("places connected catalog rows first and suppresses matching official ids and aliases", () => {
    const selectable = projectSelectableModelCatalog(CURRENT);
    const merged = mergeConnectedAndSelectableModels(
      [
        {
          providerKind: "deepseek",
          entry: connectedCatalog("connected-deepseek", "deepseek-v4-flash"),
        },
        {
          providerKind: "anthropic_claude",
          entry: connectedCatalog("connected-haiku", "claude-haiku-4-5"),
        },
      ],
      selectable,
    );

    expect(merged.slice(0, 2).map(({ source }) => source)).toEqual(["connected", "connected"]);
    expect(
      merged.some(
        ({ source, entry }) =>
          source === "official_candidate" && entry.modelId === "deepseek-v4-flash",
      ),
    ).toBe(false);
    expect(
      merged.some(
        ({ source, entry }) =>
          source === "official_candidate" && entry.modelId === "claude-haiku-4-5-20251001",
      ),
    ).toBe(false);
    expect(
      merged.some(
        ({ source, entry }) =>
          source === "official_candidate" && entry.modelId === "deepseek-v4-pro",
      ),
    ).toBe(true);
  });
});

function connectedCatalog(id: string, providerModelId: string) {
  return Object.freeze({
    id,
    providerModelId,
  });
}
