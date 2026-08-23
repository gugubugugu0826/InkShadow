import { describe, expect, it } from "vitest";

import { NOVEL_AI_TASKS, type ModelHubCapability } from "./model-hub-provider-registry";
import {
  buildModelHubRoutingVisibility,
  capabilityLabel,
  toAiRoutingDiagnosticSummary,
} from "./model-hub-routing-visibility";
import type {
  ModelCapabilityEvidence,
  ModelCatalogEntry,
  ModelProviderConnection,
  NovelTaskRoute,
  RecentAiFailure,
} from "./model-hub-store";

const NOW = "2026-08-09T12:00:00.000Z";

describe("model hub routing visibility", () => {
  it.each([
    ["text_generation", "文本生成"],
    ["reasoning", "推理"],
    ["structured_output", "结构化输出"],
    ["embedding", "向量检索"],
    ["rerank", "结果排序"],
    ["image_generation", "图片生成"],
    ["vision", "图片理解"],
    ["translation", "翻译"],
    ["tool_calling", "工具调用"],
    ["token_counting", "内容额度计数"],
    ["streaming", "流式输出"],
    ["long_context", "长上下文"],
    ["unexpected_capability", "能力未知"],
  ])("shows a safe Chinese label for capability %s", (capability, expected) => {
    expect(capabilityLabel(capability)).toBe(expected);
    expect(capabilityLabel(capability)).not.toMatch(
      /text_generation|reasoning|structured_output|embedding|rerank|image_generation|vision|translation|tool_calling|token_counting|streaming|long_context|unexpected/iu,
    );
  });

  it.each([
    [0, "partial", false],
    [15, "writing_ready", true],
    [16, "writing_ready", true],
    [22, "complete", true],
  ] as const)(
    "projects a real %i/22 route state without inventing tasks",
    (routeCount, expectedState, coreWritingReady) => {
      const capabilities: readonly ModelHubCapability[] =
        routeCount === 22
          ? [
              "text_generation",
              "structured_output",
              "embedding",
              "rerank",
              "image_generation",
              "vision",
              "translation",
            ]
          : routeCount >= 15
            ? ["text_generation", "structured_output"]
            : ["text_generation"];
      const visibility = buildModelHubRoutingVisibility({
        connections: [connection()],
        catalog: [catalog()],
        routes: routes(routeCount),
        capabilityEvidence: capabilities.map((capability, index) =>
          evidence(
            capability,
            index === 0 || capability === "structured_output"
              ? "lightweight_probe"
              : "provider_metadata",
          ),
        ),
        recentAiFailures: [],
        now: NOW,
        validating: false,
        loadFailed: false,
        saveFailed: false,
      });

      expect(visibility.registryTaskCount).toBe(22);
      expect(visibility.tasks.map(({ definition }) => definition.task)).toEqual(NOVEL_AI_TASKS);
      expect(visibility.enabledRouteCount).toBe(routeCount);
      expect(visibility.missingRouteCount).toBe(22 - routeCount);
      expect(visibility.coreWritingReady).toBe(coreWritingReady);
      expect(visibility.state).toBe(expectedState);
    },
  );

  it("keeps probe, provider, preset, user, unknown, failed and unsupported evidence distinct", () => {
    const pastFailure: RecentAiFailure = {
      diagnosticId: "failure-1",
      timestamp: "2026-08-09T09:00:00.000Z",
      providerKind: "deepseek",
      connectionId: "connection-1",
      modelId: "writer-1",
      taskType: "capability_probe",
      stage: "response_normalization",
      normalizedErrorCode: "MODEL_OUTPUT_TRUNCATED",
      retryable: true,
      httpStatus: 200,
      finishReason: "length",
      visibleContentLength: 0,
      reasoningPresent: false,
      stream: false,
      attempt: 1,
      requestedMaxOutputTokens: 64,
      requestId: "request-redacted-by-diagnostic-contract",
    };
    const visibility = buildModelHubRoutingVisibility({
      connections: [connection()],
      catalog: [catalog()],
      routes: [],
      capabilityEvidence: [
        evidence("text_generation", "lightweight_probe", "2026-08-09T10:00:00.000Z"),
        evidence("reasoning", "provider_metadata"),
        evidence("structured_output", "official_preset"),
        evidence("long_context", "user_confirmed"),
        evidence("embedding", "provider_metadata", NOW, "unsupported"),
        evidence("rerank", "provider_metadata", NOW, "unknown"),
      ],
      recentAiFailures: [pastFailure],
      now: NOW,
      validating: false,
      loadFailed: false,
      saveFailed: false,
    });
    const states = Object.fromEntries(
      visibility.models[0]?.capabilities.map(({ capability, state }) => [capability, state]) ?? [],
    );

    expect(states).toMatchObject({
      text_generation: "verified",
      reasoning: "catalog_declared",
      structured_output: "catalog_declared",
      long_context: "user_confirmed",
      embedding: "unsupported",
      rerank: "unknown",
      vision: "unknown",
    });

    const failedVisibility = buildModelHubRoutingVisibility({
      connections: [connection()],
      catalog: [catalog()],
      routes: [],
      capabilityEvidence: [],
      recentAiFailures: [pastFailure],
      now: NOW,
      validating: false,
      loadFailed: false,
      saveFailed: false,
    });
    expect(
      failedVisibility.models[0]?.capabilities.find(
        ({ capability }) => capability === "text_generation",
      ),
    ).toMatchObject({
      state: "failed",
      source: "lightweight_probe",
      failureCode: "MODEL_OUTPUT_TRUNCATED",
    });

    const sameTimestampVisibility = buildModelHubRoutingVisibility({
      connections: [connection()],
      catalog: [catalog()],
      routes: [],
      capabilityEvidence: [evidence("text_generation", "lightweight_probe", pastFailure.timestamp)],
      recentAiFailures: [pastFailure],
      now: NOW,
      validating: false,
      loadFailed: false,
      saveFailed: false,
    });
    expect(
      sameTimestampVisibility.models[0]?.capabilities.find(
        ({ capability }) => capability === "text_generation",
      ),
    ).toMatchObject({
      state: "failed",
      failureCode: "MODEL_OUTPUT_TRUNCATED",
    });

    const ambiguousFailure: RecentAiFailure = {
      ...pastFailure,
      diagnosticId: "ambiguous-provider-result",
      timestamp: "2026-08-09T11:00:00.000Z",
      stage: "transport",
      normalizedErrorCode: "PROVIDER_RESULT_AMBIGUOUS",
      retryable: false,
      httpStatus: null,
      finishReason: null,
    };
    const ambiguousVisibility = buildModelHubRoutingVisibility({
      connections: [connection()],
      catalog: [catalog()],
      routes: [],
      capabilityEvidence: [
        evidence("text_generation", "lightweight_probe", "2026-08-09T10:00:00.000Z"),
      ],
      recentAiFailures: [ambiguousFailure],
      now: NOW,
      validating: false,
      loadFailed: false,
      saveFailed: false,
    });
    expect(
      ambiguousVisibility.models[0]?.capabilities.find(
        ({ capability }) => capability === "text_generation",
      ),
    ).toMatchObject({
      state: "ambiguous",
      source: "lightweight_probe",
      failureCode: "PROVIDER_RESULT_AMBIGUOUS",
    });
  });

  it("summarizes missing capability types and route origins without model identifiers", () => {
    const seededRoutes = routes(16).map((route, index) => ({
      ...route,
      routeOrigin: index === 0 ? ("user" as const) : ("automatic" as const),
    }));
    const visibility = buildModelHubRoutingVisibility({
      connections: [connection()],
      catalog: [catalog()],
      routes: seededRoutes,
      capabilityEvidence: [evidence("text_generation", "lightweight_probe")],
      recentAiFailures: [],
      now: NOW,
      validating: false,
      loadFailed: false,
      saveFailed: false,
    });

    expect(toAiRoutingDiagnosticSummary(visibility)).toEqual({
      registryTaskCount: 22,
      enabledRouteCount: 16,
      missingRouteCount: 6,
      manuallyConfiguredCount: 1,
      automaticallyConfiguredCount: 15,
      coreWritingReady: true,
      missingCapabilities: [
        "structured_output",
        "embedding",
        "rerank",
        "image_generation",
        "vision",
        "translation",
      ],
    });
    expect(JSON.stringify(toAiRoutingDiagnosticSummary(visibility))).not.toContain("writer-1");
    expect(JSON.stringify(toAiRoutingDiagnosticSummary(visibility))).not.toContain("connection-1");
  });

  it("gives save failure precedence over the retained route count", () => {
    const visibility = buildModelHubRoutingVisibility({
      connections: [connection()],
      catalog: [catalog()],
      routes: routes(15),
      capabilityEvidence: [evidence("text_generation", "lightweight_probe")],
      recentAiFailures: [],
      now: NOW,
      validating: false,
      loadFailed: false,
      saveFailed: true,
    });

    expect(visibility.state).toBe("save_failed");
    expect(visibility.enabledRouteCount).toBe(15);
    expect(visibility.coreWritingReady).toBe(true);
  });

  it("projects an exact preflight blocker into the task matrix instead of claiming writing ready", () => {
    const visibility = buildModelHubRoutingVisibility({
      connections: [connection()],
      catalog: [catalog()],
      routes: routes(15),
      capabilityEvidence: [evidence("text_generation", "lightweight_probe")],
      recentAiFailures: [],
      now: NOW,
      validating: false,
      loadFailed: false,
      saveFailed: false,
      exactBlockers: [
        {
          task: "continuation",
          code: "MODEL_HUB_CREDENTIAL_MISSING",
        },
      ],
    });

    expect(visibility.state).toBe("anomaly");
    expect(visibility.coreWritingReady).toBe(false);
    expect(
      visibility.tasks.find(({ definition }) => definition.task === "continuation"),
    ).toMatchObject({
      status: "failed",
      reason: "基础配置检查未通过：接口密钥已删除或不可用。",
    });
  });
});

function connection(): ModelProviderConnection {
  return {
    id: "connection-1",
    providerKind: "deepseek",
    displayName: "Connected model provider",
    protocol: "openai_compatible",
    region: null,
    workspaceId: null,
    endpointId: null,
    baseUrl: "https://example.invalid/v1",
    credentialRef: "keyring:model-hub:connection-1",
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
    lastTestedAt: "2026-08-09T08:00:00.000Z",
    lastCatalogSyncedAt: "2026-08-09T08:00:00.000Z",
    lastErrorCode: null,
    lastErrorSummary: null,
    legacyProviderId: null,
    enabled: true,
    revision: 1,
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z",
  };
}

function catalog(): ModelCatalogEntry {
  return {
    id: "catalog-1",
    connectionId: "connection-1",
    providerModelId: "writer-1",
    displayName: "Writer 1",
    ownedBy: null,
    catalogSource: "provider_api",
    availability: "available",
    lifecycle: "stable",
    inputTokenLimit: null,
    outputTokenLimit: null,
    firstDiscoveredAt: "2026-08-09T08:00:00.000Z",
    lastSeenAt: "2026-08-09T08:00:00.000Z",
    staleAfter: null,
    lastSyncId: "sync-1",
    revision: 1,
  };
}

function routes(count: number): readonly NovelTaskRoute[] {
  return NOVEL_AI_TASKS.slice(0, count).map((task) => ({
    task,
    primaryCatalogEntryId: "catalog-1",
    fallbackCatalogEntryId: null,
    presetId: "automatic-smart",
    parameterPolicy: {},
    maximumCostMicros: null,
    currency: null,
    privacyPolicy: "cloud_allowed",
    failurePolicy: "ask_user",
    routeOrigin: "automatic",
    enabled: true,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }));
}

function evidence(
  capability: ModelHubCapability,
  evidenceSource: ModelCapabilityEvidence["evidenceSource"],
  observedAt = "2026-08-09T10:00:00.000Z",
  verdict: ModelCapabilityEvidence["verdict"] = "supported",
): ModelCapabilityEvidence {
  return {
    id: `evidence-${capability}-${evidenceSource}`,
    catalogEntryId: "catalog-1",
    scanId: "scan-1",
    capability,
    verdict,
    evidenceSource,
    evidenceVersion: "test-v1",
    evidenceSummary: null,
    observedAt,
    expiresAt: null,
  };
}
