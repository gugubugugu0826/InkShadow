import { MODEL_ROUTE_ROLES } from "@inkshadow/ai-core";
import { describe, expect, it } from "vitest";

import { MODEL_HUB_CAPABILITIES, NOVEL_AI_TASKS } from "./model-hub-provider-registry";
import {
  buildLegacyCompatibilityPlan,
  buildModelHubRoutingPlan,
  preferredCapabilitiesForNovelTask,
  requiredCapabilitiesForNovelTask,
  resolveModelCapabilityVerdict,
  type ModelHubRoutingCandidate,
} from "./model-hub-router";
import type {
  ModelCapabilityEvidence,
  ModelCatalogEntry,
  ModelCostPrivacyProfile,
  ModelEvaluationResult,
  ModelProviderConnection,
} from "./model-hub-store";

const NOW = "2026-08-01T00:00:00.000Z";

describe("Model Hub evidence router", () => {
  it("routes content-quality review by evidence-backed capabilities", () => {
    expect(requiredCapabilitiesForNovelTask("content_quality_check")).toEqual(["text_generation"]);
    expect(preferredCapabilitiesForNovelTask("content_quality_check")).toEqual([
      "reasoning",
      "structured_output",
      "long_context",
    ]);
    expect(
      buildModelHubRoutingPlan({
        scheme: "smart",
        candidates: [candidate("quality-review", "remote", 9000, "1000000")],
        now: NOW,
        tasks: ["content_quality_check"],
      }).routes[0],
    ).toMatchObject({ task: "content_quality_check" });
  });

  it("builds all 22 novel task routes with distinct primary and fallback models", () => {
    const plan = buildModelHubRoutingPlan({
      scheme: "smart",
      candidates: [
        candidate("first", "remote", 9000, "4000000"),
        candidate("second", "remote", 8000, "1000000"),
      ],
      now: NOW,
    });

    expect(plan.routes).toHaveLength(NOVEL_AI_TASKS.length);
    expect(plan.unroutableTasks).toEqual([]);
    expect(new Set(plan.routes.map(({ task }) => task))).toEqual(new Set(NOVEL_AI_TASKS));
    expect(plan.routes.every(({ fallbackCatalogEntryId }) => fallbackCatalogEntryId !== null)).toBe(
      true,
    );
  });

  it("uses evaluation evidence for quality and cost evidence for economy without name rules", () => {
    const expensiveQuality = candidate("plain-a", "remote", 9600, "9000000", 900);
    const economical = candidate("plain-b", "remote", 8000, "500000", 300);

    const quality = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [economical, expensiveQuality],
      now: NOW,
      tasks: ["prose_generation"],
    });
    const economy = buildModelHubRoutingPlan({
      scheme: "economy",
      candidates: [expensiveQuality, economical],
      now: NOW,
      tasks: ["prose_generation"],
    });
    const smart = buildModelHubRoutingPlan({
      scheme: "smart",
      candidates: [economical, expensiveQuality],
      now: NOW,
      tasks: ["prose_generation", "chapter_summary"],
    });

    expect(quality.routes[0]?.primaryCatalogEntryId).toBe("catalog-plain-a");
    expect(economy.routes[0]?.primaryCatalogEntryId).toBe("catalog-plain-b");
    expect(smart.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task: "prose_generation",
          primaryCatalogEntryId: "catalog-plain-a",
        }),
        expect.objectContaining({
          task: "chapter_summary",
          primaryCatalogEntryId: "catalog-plain-b",
        }),
      ]),
    );
  });

  it("keeps preview vision models out of automatic pure-text opening routes", () => {
    const stableTextBase = candidate("stable-text", "remote", 9000, "1000000", 400, [
      capability("stable-no-vision", "vision", "unsupported", "user_confirmed"),
    ]);
    const previewVisionBase = candidate(
      "deepseek-v4-flash-vision-exp",
      "remote",
      9900,
      "1000000",
      300,
    );
    const stableText: ModelHubRoutingCandidate = {
      ...stableTextBase,
      catalogEntry: { ...stableTextBase.catalogEntry, lifecycle: "stable" },
    };
    const previewVision: ModelHubRoutingCandidate = {
      ...previewVisionBase,
      catalogEntry: { ...previewVisionBase.catalogEntry, lifecycle: "preview" },
    };

    const opening = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [previewVision, stableText],
      now: NOW,
      tasks: ["book_start_guidance"],
    });
    const vision = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [stableText, previewVision],
      now: NOW,
      tasks: ["vision_understanding"],
    });

    expect(opening.routes[0]?.primaryCatalogEntryId).toBe("catalog-stable-text");
    expect(vision.routes[0]?.primaryCatalogEntryId).toBe("catalog-deepseek-v4-flash-vision-exp");
  });

  it("prefers an explicitly text-only peer over a higher-scored vision peer in the same lifecycle", () => {
    const textBase = candidate("same-life-text", "remote", 8_600, "1000000", 500, [
      capability("same-life-text-no-vision", "vision", "unsupported", "lightweight_probe"),
    ]);
    const visionBase = candidate("same-life-vision", "remote", 9_900, "1000000", 200, [
      capability("same-life-vision-supported", "vision", "supported", "lightweight_probe"),
    ]);
    const text: ModelHubRoutingCandidate = {
      ...textBase,
      catalogEntry: { ...textBase.catalogEntry, lifecycle: "stable" },
    };
    const vision: ModelHubRoutingCandidate = {
      ...visionBase,
      catalogEntry: { ...visionBase.catalogEntry, lifecycle: "stable" },
    };

    const opening = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [vision, text],
      now: NOW,
      tasks: ["book_start_guidance"],
    });
    const visualUnderstanding = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [text, vision],
      now: NOW,
      tasks: ["vision_understanding"],
    });

    expect(opening.routes[0]?.primaryCatalogEntryId).toBe("catalog-same-life-text");
    expect(visualUnderstanding.routes[0]?.primaryCatalogEntryId).toBe("catalog-same-life-vision");
  });

  it("does not auto-route pure-text opening to an obvious experimental vision model when evidence is unknown", () => {
    const unknownVision = candidate(
      "deepseek-v4-flash-vision-exp",
      "remote",
      9_900,
      "1000000",
      200,
      [capability("unknown-vision-evidence", "vision", "unknown", "lightweight_probe")],
    );
    const unknownText = candidate("deepseek-chat", "remote", 8_500, "1000000", 500, [
      capability("unknown-text-vision-evidence", "vision", "unknown", "lightweight_probe"),
    ]);

    const opening = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [unknownVision, unknownText],
      now: NOW,
      tasks: ["book_start_guidance"],
    });
    const continuation = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [unknownText, unknownVision],
      now: NOW,
      tasks: ["continuation"],
    });

    expect(opening.routes[0]?.primaryCatalogEntryId).toBe("catalog-deepseek-chat");
    expect(continuation.routes[0]?.primaryCatalogEntryId).toBe(
      "catalog-deepseek-v4-flash-vision-exp",
    );
  });

  it("leaves a pure-text opening unroutable when the only candidate is an experimental vision model", () => {
    const experimentalVision = candidate(
      "deepseek-v4-flash-vision-exp",
      "remote",
      9_900,
      "1000000",
      200,
      [capability("only-vision-evidence", "vision", "unknown", "lightweight_probe")],
    );

    const opening = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [experimentalVision],
      now: NOW,
      tasks: ["book_start_guidance"],
    });
    const image = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [experimentalVision],
      now: NOW,
      tasks: ["image_generation"],
    });

    expect(opening.routes).toEqual([]);
    expect(opening.unroutableTasks).toEqual(["book_start_guidance"]);
    expect(image.routes.map(({ task }) => task)).toEqual(["image_generation"]);
  });

  it("keeps local privacy primary, fallback, and all compatible legacy roles local", () => {
    const cloud = candidate("cloud", "remote", 9900, "1");
    const localA = candidate("local-a", "local", 8500, "0");
    const localB = candidate("local-b", "local", 8200, "0");
    const candidates = [cloud, localA, localB];
    const plan = buildModelHubRoutingPlan({ scheme: "local_privacy", candidates, now: NOW });
    const legacy = buildLegacyCompatibilityPlan(plan, candidates, NOW);

    expect(plan.unroutableTasks).toEqual([]);
    expect(
      plan.routes.every(
        ({ primaryConnectionId, fallbackConnectionId }) =>
          primaryConnectionId.startsWith("local-") &&
          fallbackConnectionId?.startsWith("local-") === true,
      ),
    ).toBe(true);
    expect(legacy.routes).toHaveLength(MODEL_ROUTE_ROLES.length);
    expect(legacy.rolesToClear).toEqual([]);
    expect(
      legacy.routes.every(
        ({ primaryConnectionId, fallbackConnectionId }) =>
          primaryConnectionId.startsWith("local-") &&
          fallbackConnectionId?.startsWith("local-") === true,
      ),
    ).toBe(true);
  });

  it("does not route remote Ollama through the local privacy scheme", () => {
    const remoteOllama = candidate("remote-ollama", "local", 9900, "0", 20, [], {
      providerKind: "ollama",
      protocol: "ollama",
      baseUrl: "https://remote-ollama.example.test",
    });

    const plan = buildModelHubRoutingPlan({
      scheme: "local_privacy",
      candidates: [remoteOllama],
      now: NOW,
      tasks: ["prose_generation"],
    });

    expect(plan.routes).toEqual([]);
    expect(plan.unroutableTasks).toEqual(["prose_generation"]);
  });

  it("clears the legacy local-private role when no evidence-confirmed local model exists", () => {
    const candidates = [candidate("cloud-only", "remote", 9000, "1000000")];
    const plan = buildModelHubRoutingPlan({ scheme: "quality", candidates, now: NOW });
    const legacy = buildLegacyCompatibilityPlan(plan, candidates, NOW);

    expect(legacy.rolesToClear).toContain("local_private");
    expect(legacy.routes.find(({ role }) => role === "local_private")).toBeUndefined();
  });

  it("requires explicit capability evidence and honors newer higher-trust evidence", () => {
    const unsupported = candidate("unsupported", "remote", 9000, "1000000", 400, [
      capability("unsupported", "embedding", "supported", "provider_metadata"),
      capability("unsupported-user", "embedding", "unsupported", "user_confirmed"),
    ]);
    const textOnly = candidate("embedding-name-but-text-only", "remote", 9000, "1000000", 400, [
      capability("text", "text_generation", "supported", "user_confirmed"),
      capability("embedding-unknown", "embedding", "unknown", "user_confirmed"),
    ]);
    const plan = buildModelHubRoutingPlan({
      scheme: "smart",
      candidates: [unsupported, textOnly],
      now: NOW,
      tasks: ["embedding"],
    });

    expect(plan.routes).toEqual([]);
    expect(plan.unroutableTasks).toEqual(["embedding"]);
  });

  it("does not treat a provider declaration as verified structured-output evidence", () => {
    expect(
      resolveModelCapabilityVerdict({
        catalogEntryId: "catalog-structured",
        capability: "structured_output",
        evidence: [
          capability(
            "declared-json",
            "structured_output",
            "supported",
            "provider_metadata",
            "catalog-structured",
          ),
        ],
        now: NOW,
      }),
    ).toBe("unknown");
    expect(
      resolveModelCapabilityVerdict({
        catalogEntryId: "catalog-structured",
        capability: "structured_output",
        evidence: [
          capability(
            "verified-json",
            "structured_output",
            "supported",
            "lightweight_probe",
            "catalog-structured",
          ),
        ],
        now: NOW,
      }),
    ).toBe("supported");
  });

  it("requires verified structured output before routing automatic planning tasks", () => {
    expect(requiredCapabilitiesForNovelTask("outline_planning")).toEqual([
      "text_generation",
      "structured_output",
    ]);
    expect(requiredCapabilitiesForNovelTask("scene_breakdown")).toEqual([
      "text_generation",
      "structured_output",
    ]);

    const declaredOnly = candidate("declared-planning", "remote", 9000, "1000000", 400, [
      capability("declared-planning-text", "text_generation", "supported", "user_confirmed"),
      capability(
        "declared-planning-structured",
        "structured_output",
        "supported",
        "provider_metadata",
      ),
    ]);
    const unverifiedPlan = buildModelHubRoutingPlan({
      scheme: "smart",
      candidates: [declaredOnly],
      now: NOW,
      tasks: ["outline_planning", "scene_breakdown"],
    });

    expect(unverifiedPlan.routes).toEqual([]);
    expect(unverifiedPlan.unroutableTasks).toEqual(["outline_planning", "scene_breakdown"]);

    const verified = candidate("verified-planning", "remote", 9000, "1000000", 400, [
      capability(
        "verified-planning-structured",
        "structured_output",
        "supported",
        "lightweight_probe",
      ),
    ]);
    expect(
      buildModelHubRoutingPlan({
        scheme: "smart",
        candidates: [verified],
        now: NOW,
        tasks: ["outline_planning", "scene_breakdown"],
      }).routes.map(({ task }) => task),
    ).toEqual(["outline_planning", "scene_breakdown"]);
  });

  it("routes 14 ordinary text tasks without treating planning as plain text generation", () => {
    const seeded = candidate("text-only", "remote", 9000, "1000000");
    const textOnly: ModelHubRoutingCandidate = {
      ...seeded,
      capabilities: [
        capability(
          "text-only-probe",
          "text_generation",
          "supported",
          "lightweight_probe",
          seeded.catalogEntry.id,
        ),
      ],
      evaluations: [],
    };

    const plan = buildModelHubRoutingPlan({
      scheme: "smart",
      candidates: [textOnly],
      now: NOW,
    });

    expect(plan.routes.map(({ task }) => task)).toEqual([
      "idea_discussion",
      "book_start_guidance",
      "prose_generation",
      "continuation",
      "rewrite",
      "polish",
      "chapter_summary",
      "long_memory_compression",
      "character_extraction",
      "world_extraction",
      "contradiction_check",
      "pov_check",
      "character_voice_check",
      "content_quality_check",
    ]);
    expect(plan.unroutableTasks).toEqual([
      "outline_planning",
      "scene_breakdown",
      "what_if_simulation",
      "embedding",
      "rerank",
      "image_generation",
      "vision_understanding",
      "translation",
    ]);
  });

  it("never emits a legacy temperature for an Anthropic route", () => {
    const claude = candidate("claude-connection", "remote", 9000, "1000000", 400, [], {
      providerKind: "anthropic_claude",
      protocol: "anthropic",
    });
    const plan = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [claude],
      now: NOW,
      tasks: ["prose_generation"],
    });

    expect(plan.routes[0]?.parameterPolicy).toEqual({});
    expect(plan.routes[0]?.parameterPolicy).not.toHaveProperty("temperature");
  });

  it("fails closed for deprecated and stale catalog entries", () => {
    const deprecated = candidate("deprecated", "remote", 9999, "1");
    const stale = candidate("stale", "remote", 9999, "1");
    const current = candidate("current", "remote", 7000, "1000000");
    const plan = buildModelHubRoutingPlan({
      scheme: "quality",
      candidates: [
        {
          ...deprecated,
          catalogEntry: { ...deprecated.catalogEntry, lifecycle: "deprecated" },
        },
        {
          ...stale,
          catalogEntry: { ...stale.catalogEntry, staleAfter: NOW },
        },
        {
          ...current,
          catalogEntry: {
            ...current.catalogEntry,
            lifecycle: "stable",
            staleAfter: "2026-08-02T00:00:00.000Z",
          },
        },
      ],
      now: NOW,
      tasks: ["prose_generation"],
    });

    expect(plan.routes).toEqual([
      expect.objectContaining({ primaryCatalogEntryId: "catalog-current" }),
    ]);
  });
});

function candidate(
  id: string,
  destination: ModelCostPrivacyProfile["dataDestination"],
  score: number,
  totalCostMicros: string,
  latencyP50Ms = 500,
  capabilityOverrides: readonly ModelCapabilityEvidence[] = [],
  connectionOverrides: Partial<ModelProviderConnection> = {},
): ModelHubRoutingCandidate {
  const connection: ModelProviderConnection = {
    id,
    providerKind: "custom_openai_compatible",
    displayName: id,
    protocol: "openai_compatible",
    region: null,
    workspaceId: null,
    endpointId: null,
    baseUrl: destination === "local" ? "http://127.0.0.1:11434" : `https://${id}.example.test/v1`,
    credentialRef: null,
    credentialState: "missing",
    authenticationMode: "none",
    credentialHeaderName: null,
    modelDiscoveryPath: null,
    textGenerationPath: null,
    embeddingPath: null,
    requestTimeoutMs: 30_000,
    retryLimit: 0,
    connectionStatus: "ready",
    catalogSyncStatus: "succeeded",
    lastTestedAt: NOW,
    lastCatalogSyncedAt: NOW,
    lastErrorCode: null,
    lastErrorSummary: null,
    legacyProviderId: null,
    enabled: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...connectionOverrides,
  };
  const catalogEntry: ModelCatalogEntry = {
    id: `catalog-${id}`,
    connectionId: id,
    providerModelId: `runtime-model-${id}`,
    displayName: id,
    ownedBy: null,
    catalogSource: "provider_api",
    availability: "available",
    lifecycle: "unknown",
    inputTokenLimit: 128_000,
    outputTokenLimit: 16_000,
    firstDiscoveredAt: NOW,
    lastSeenAt: NOW,
    staleAfter: null,
    lastSyncId: `sync-${id}`,
    revision: 1,
  };
  const defaultCapabilities = MODEL_HUB_CAPABILITIES.map((capabilityName) =>
    capability(
      `${id}-${capabilityName}`,
      capabilityName,
      "supported",
      "user_confirmed",
      catalogEntry.id,
    ),
  );
  const overriddenCapabilities = new Set(
    capabilityOverrides.map(({ capability: capabilityName }) => capabilityName),
  );
  const capabilities = [
    ...defaultCapabilities.filter(
      ({ capability: capabilityName }) => !overriddenCapabilities.has(capabilityName),
    ),
    ...capabilityOverrides.map((evidence) => ({ ...evidence, catalogEntryId: catalogEntry.id })),
  ];
  const halfCost = (BigInt(totalCostMicros) / 2n).toString();
  const costPrivacy: ModelCostPrivacyProfile = {
    catalogEntryId: catalogEntry.id,
    currency: "USD",
    inputMicrosPerMillionTokens: halfCost,
    outputMicrosPerMillionTokens: (BigInt(totalCostMicros) - BigInt(halfCost)).toString(),
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "test-v1",
    priceUpdatedAt: NOW,
    dataDestination: destination,
    retentionPolicy: destination === "local" ? "none" : "provider_default",
    trainingPolicy: destination === "local" ? "not_used" : "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "test-v1",
    evidenceSummary: null,
    evidenceUpdatedAt: NOW,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const evaluations: ModelEvaluationResult[] = NOVEL_AI_TASKS.map((task) => ({
    id: `${id}-${task}-evaluation`,
    catalogEntryId: catalogEntry.id,
    task,
    scoreBasisPoints: score,
    latencyP50Ms,
    sampleCount: 50,
    evaluationSource: "local_evaluation",
    evaluationVersion: "test-suite-v1",
    observedAt: NOW,
    expiresAt: null,
  }));
  return { connection, catalogEntry, capabilities, costPrivacy, evaluations };
}

function capability(
  id: string,
  capabilityName: ModelCapabilityEvidence["capability"],
  verdict: ModelCapabilityEvidence["verdict"],
  evidenceSource: ModelCapabilityEvidence["evidenceSource"],
  catalogEntryId = "placeholder",
): ModelCapabilityEvidence {
  return {
    id,
    catalogEntryId,
    scanId: null,
    capability: capabilityName,
    verdict,
    evidenceSource,
    evidenceVersion: "test-v1",
    evidenceSummary: null,
    observedAt: NOW,
    expiresAt: null,
  };
}
