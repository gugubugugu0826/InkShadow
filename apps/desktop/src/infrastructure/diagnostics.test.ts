// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { runGenerationPreflight } from "@inkshadow/ai-core";

import { collectDesktopDiagnosticArtifact, partitionDiagnosticErrorCodes } from "./diagnostics";
import {
  recordSafeGenerationPreflightDiagnostic,
  recordSafeGenerationPreflightFailureDiagnostic,
  recordSafeInvocationRouteDiagnostic,
} from "./generation-preflight-diagnostics";
import { recordSafeGuidedOpeningStatus } from "./guided-opening-diagnostics";
import {
  recordSafeOperationIncident,
  resetSafeOperationDiagnosticsForTests,
} from "./safe-operation-diagnostics";
import {
  ModelHubOperationCoordinator,
  createInitialModelHubPageSnapshot,
} from "./model-hub-page-hydration";
import {
  finishModelHubDiagnosticAction,
  recordModelHubUiSnapshot,
  startModelHubDiagnosticAction,
} from "./model-hub-ui-diagnostics";
import { createDevelopmentRuntime } from "./runtime";

describe("desktop diagnostics", () => {
  afterEach(() => resetSafeOperationDiagnosticsForTests());

  it("exports support-number operation failures without messages, content, or credentials", async () => {
    window.localStorage.clear();
    resetSafeOperationDiagnosticsForTests();
    const runtime = createDevelopmentRuntime(window.localStorage);
    const nested = Object.assign(new Error("sk-secret 正文 C:/private/book.txt"), {
      code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
    });
    const incident = recordSafeOperationIncident({
      operation: "story_planning",
      stage: "prepare_disclosure",
      cause: Object.assign(new Error("private provider message"), {
        code: "MODEL_HUB_STRUCTURED_OUTPUT_NOT_VERIFIED",
        cause: nested,
      }),
      projectId: "019f9f4a-b3c7-7350-9226-000000000001",
      chapterId: "019f9f4a-b3c7-7350-9226-000000000002",
      requestId: "not-a-safe-request-secret",
      dispatched: false,
      occurredAt: "2026-08-23T04:00:00.000Z",
    });

    const artifact = await collectDesktopDiagnosticArtifact(runtime);

    expect(artifact.bundle.schemaVersion).toBe(4);
    expect(artifact.bundle.recentOperationFailures[0]).toMatchObject({
      supportId: incident.supportId,
      operation: "story_planning",
      stage: "prepare_disclosure",
      projectId: "019f9f4a-b3c7-7350-9226-000000000001",
      chapterId: "019f9f4a-b3c7-7350-9226-000000000002",
      requestId: null,
      normalizedErrorCode: "MODEL_HUB_STRUCTURED_OUTPUT_NOT_VERIFIED",
      dispatched: false,
      automaticRetryCount: 0,
    });
    expect(artifact.content).not.toContain("sk-secret");
    expect(artifact.content).not.toContain("private provider message");
    expect(artifact.content).not.toContain("C:/private/book.txt");
    expect(artifact.content).not.toContain("not-a-safe-request-secret");
  });

  it("partitions current and historical errors at the session boundary and deduplicates codes", () => {
    expect(
      partitionDiagnosticErrorCodes(
        "2026-08-10T03:15:00.000Z",
        ["MODEL_OUTPUT_TRUNCATED", "CURRENT_ACTION_FAILED"],
        [
          {
            timestamp: "2026-08-10T03:14:59.999Z",
            normalizedErrorCode: "HISTORICAL_FAILURE",
          },
          {
            timestamp: "2026-08-10T03:15:00.000Z",
            normalizedErrorCode: "MODEL_OUTPUT_TRUNCATED",
          },
          {
            timestamp: "2026-08-10T03:16:00.000Z",
            normalizedErrorCode: "CURRENT_AI_FAILURE",
          },
          {
            timestamp: "2026-08-10T03:14:00.000Z",
            normalizedErrorCode: "HISTORICAL_FAILURE",
          },
        ],
      ),
    ).toEqual({
      currentSessionErrorCodes: [
        "MODEL_OUTPUT_TRUNCATED",
        "CURRENT_ACTION_FAILED",
        "CURRENT_AI_FAILURE",
      ],
      historicalErrorCodes: ["HISTORICAL_FAILURE"],
    });
  });

  it("exports an early continuation route blocker in the current session without content", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    recordSafeInvocationRouteDiagnostic(runtime, {
      taskType: "continuation",
      modelHubRouteFound: true,
      legacyProfileChecked: false,
      legacyProfileSelected: false,
      resolvedConnectionId: null,
      resolvedModelId: null,
      routeSource: "none",
      ready: false,
      blockerCode: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      checkedAt: runtime.clock.now(),
    });
    recordSafeGenerationPreflightFailureDiagnostic(runtime, {
      taskType: "continuation",
      routeFound: true,
      blockerCode: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      checkedAt: runtime.clock.now(),
    });
    recordSafeGuidedOpeningStatus(runtime, {
      inputValidation: "invalid",
      batchId: null,
      batchState: "idle",
      slotStates: [],
      selectedSlot: null,
      plannerMode: "not_started",
      questionCount: 0,
      currentQuestion: null,
      lastError: "CREATIVE_INPUT_INVALID",
    });

    const artifact = await collectDesktopDiagnosticArtifact(runtime);

    expect(artifact.bundle.currentSessionErrorCodes).toContain("MODEL_HUB_CAPABILITY_NOT_VERIFIED");
    expect(artifact.bundle.generationPreflight).toMatchObject({
      taskType: "continuation",
      readiness: "BLOCKED",
      blockerCodes: ["MODEL_HUB_CAPABILITY_NOT_VERIFIED"],
    });
    expect(artifact.bundle.lastRouteResolution).toMatchObject({
      resolverVersion: "continuation-route-resolver@1",
      modelHubRouteFound: true,
      legacyProfileChecked: false,
      routeSource: "none",
      ready: false,
      blockerCode: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
    });
    expect(artifact.bundle.guidedOpeningStatus).toMatchObject({
      inputValidation: "invalid",
      batchState: "idle",
      plannerMode: "not_started",
      lastError: "CREATIVE_INPUT_INVALID",
    });
    expect(artifact.bundle.privacy).toMatchObject({
      projectContentIncluded: false,
      promptContentIncluded: false,
      credentialsIncluded: false,
    });
  });

  it("exports bounded runtime health without project text, prompts, or credentials", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "诊断测试项目" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "敏感章节",
      content: "绝不能进入诊断包的正文标记。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    window.localStorage.setItem("unrelated-secret", "sk-never-include-this-value");
    await runtime.modelCenter.save({
      providerId: "private-provider",
      provider: "open_ai_compatible",
      baseUrl: "https://private.example/v1",
      authentication: "bearer_keyring",
      selectedModel: "proprietary-model-42",
      expectedRevision: null,
    });
    await runtime.modelHub.saveConnection({
      id: "diagnostic-provider",
      providerKind: "custom_openai_compatible",
      displayName: "Diagnostic provider",
      baseUrlOverride: "https://diagnostic.example.test/v1",
      credentialState: "missing",
      authenticationMode: "none",
      expectedRevision: null,
    });
    await runtime.modelHub.syncCatalog({
      syncId: "diagnostic-sync",
      connectionId: "diagnostic-provider",
      source: "manual",
      status: "succeeded",
      models: [{ id: "diagnostic-model", providerModelId: "diagnostic-writer" }],
    });
    await runtime.modelHub.recordCapabilityScan({
      scanId: "diagnostic-failed-probe",
      catalogEntryId: "diagnostic-model",
      scanKind: "lightweight_probe",
      status: "failed",
      evidenceVersion: "writing-probe-v1",
      errorCode: "MODEL_OUTPUT_TRUNCATED",
      errorSummary: "never-export-this-error-summary",
      failure: {
        requestId: "req-diagnostic-probe-0001",
        stage: "response_normalization",
        retryable: false,
        httpStatus: 200,
        finishReason: "length",
        visibleContentLength: 0,
        reasoningPresent: true,
        stream: false,
        attempt: 1,
        requestedMaxOutputTokens: 8,
      },
    });
    const search = await runtime.search.search(project.value.id, "绝不能进入");
    if (!search.ok) {
      throw search.error;
    }
    const preflight = runGenerationPreflight({
      now: runtime.clock.now(),
      migrationReady: true,
      chapterExists: true,
      chapterSaved: true,
      projectWritable: true,
      gatewayAvailable: true,
      networkAvailable: true,
      providerLocation: "remote",
      routeResolved: true,
      profileConfigured: true,
      modelSelected: true,
      credentialConfigured: true,
      connectionStatus: "verified",
      selectedModelAvailable: true,
      inputBytes: 4_000,
      maximumInputBytes: 1_000_000,
      inputTokens: 1_000,
      maximumOutputTokens: 800,
      contextWindowTokens: null,
      tokenizerStatus: "approximate",
      pricing: null,
      budgets: [],
    });
    recordSafeGenerationPreflightDiagnostic(runtime, {
      taskType: "continuation",
      routeFound: true,
      connectionUsable: true,
      capabilityStatus: "supported",
      snapshot: preflight,
    });
    recordSafeInvocationRouteDiagnostic(runtime, {
      taskType: "continuation",
      modelHubRouteFound: true,
      legacyProfileChecked: false,
      legacyProfileSelected: false,
      resolvedConnectionId: "diagnostic-provider",
      resolvedModelId: "diagnostic-writer",
      routeSource: "model_hub",
      ready: true,
      blockerCode: null,
      checkedAt: runtime.clock.now(),
    });
    const operation = new ModelHubOperationCoordinator().begin("load_cached_catalog", {
      providerKind: "custom_openai_compatible",
      connectionId: "ui-diagnostic-connection",
    });
    startModelHubDiagnosticAction(runtime, operation, runtime.clock.now());
    finishModelHubDiagnosticAction(runtime, operation, {
      completedAt: runtime.clock.now(),
      outcome: "succeeded_with_warning",
      storeRefreshed: true,
      errorCode: "MODEL_HUB_CATALOG_REFRESH_FAILED",
      catalogCount: 1,
    });
    recordModelHubUiSnapshot(
      runtime,
      {
        ...createInitialModelHubPageSnapshot(),
        phase: "READY_WITH_WARNINGS",
        providerKind: "custom_openai_compatible",
        selectedConnectionId: "ui-diagnostic-connection",
        credentialStatus: "configured",
        catalogStatus: "cached_warning",
        selectedModelId: "ui-diagnostic-model",
        hydratedAt: runtime.clock.now(),
        snapshotRevision: 7,
      },
      runtime.clock.now(),
    );

    const artifact = await collectDesktopDiagnosticArtifact(runtime);

    expect(artifact.fileName).toMatch(/^墨影-诊断-\d{4}-\d{2}-\d{2}-/u);
    expect(artifact.bundle).toMatchObject({
      schemaVersion: 4,
      summary: {
        appVersion: "0.2.13",
        databaseHealth: "unknown",
        indexHealth: "healthy",
        syncState: "local_only",
        errorCodes: ["MODEL_OUTPUT_TRUNCATED"],
        requestIds: [],
      },
      privacy: {
        projectContentIncluded: false,
        promptContentIncluded: false,
        credentialsIncluded: false,
        uploadedFilesIncluded: false,
      },
      localCloudFoundation: null,
      aiRoutingSummary: {
        registryTaskCount: 22,
        enabledRouteCount: 0,
        missingRouteCount: 22,
        manuallyConfiguredCount: 0,
        automaticallyConfiguredCount: 0,
        coreWritingReady: false,
        missingCapabilities: [
          "text_generation",
          "structured_output",
          "embedding",
          "rerank",
          "image_generation",
          "vision",
          "translation",
        ],
      },
      recentAiRoutingFailures: [],
      modelHubUiSnapshot: {
        pageMounted: true,
        hydrationPhase: "READY_WITH_WARNINGS",
        credentialUiStatus: "configured",
        catalogUiStatus: "cached_warning",
        catalogEntryCountInUi: 0,
        selectedConnectionId: null,
        selectedModelIdInUi: null,
        lastSnapshotRevision: 7,
      },
      recentModelHubActions: [
        {
          action: "load_cached_catalog",
          outcome: "succeeded_with_warning",
          storeRefreshed: true,
          errorCode: "MODEL_HUB_CATALOG_REFRESH_FAILED",
          catalogCount: 1,
        },
      ],
      currentSessionErrorCodes: ["MODEL_HUB_CATALOG_REFRESH_FAILED"],
      recentAiFailures: [
        {
          providerKind: "custom_openai_compatible",
          taskType: "capability_probe",
          normalizedErrorCode: "MODEL_OUTPUT_TRUNCATED",
          stage: "response_normalization",
          retryable: false,
          httpStatus: 200,
          finishReason: "length",
          visibleContentLength: 0,
          reasoningPresent: true,
          stream: false,
          attempt: 1,
          requestedMaxOutputTokens: 8,
        },
      ],
      generationPreflight: {
        taskType: "continuation",
        routeFound: true,
        connectionUsable: true,
        capabilityStatus: "supported",
        pricingStatus: "unavailable",
        contextWindowStatus: "conservative_fallback",
        tokenizerStatus: "approximate",
        estimatedInputTokens: 1_000,
        effectiveContextBudget: 7_000,
        readiness: "READY_WITH_WARNINGS",
        blockerCodes: [],
        warningCodes: [
          "PREFLIGHT_WARNING_PRICING_UNKNOWN",
          "PREFLIGHT_WARNING_CONTEXT_UNKNOWN",
          "PREFLIGHT_WARNING_TOKEN_ESTIMATE_APPROXIMATE",
        ],
        defaultsApplied: [
          "CONSERVATIVE_CONTEXT_WINDOW",
          "CONSERVATIVE_TOKEN_ESTIMATE",
          "PRICING_UNAVAILABLE",
        ],
      },
      lastRouteResolution: {
        taskType: "continuation",
        resolverVersion: "continuation-route-resolver@1",
        modelHubRouteFound: true,
        legacyProfileChecked: false,
        legacyProfileSelected: false,
        resolvedConnectionId: null,
        resolvedModelId: null,
        routeSource: "model_hub",
        ready: true,
        blockerCode: null,
      },
      generationBudget: null,
      contextSelectionSummary: null,
      chapterSummaryStatus: null,
    });
    expect(typeof artifact.bundle.recentAiFailures[0]?.timestamp).toBe("string");
    expect(artifact.content).not.toContain("绝不能进入诊断包的正文标记");
    expect(artifact.content).not.toContain("sk-never-include-this-value");
    expect(artifact.content).not.toContain("敏感章节");
    expect(artifact.content).not.toContain("private-provider");
    expect(artifact.content).not.toContain("private.example");
    expect(artifact.content).not.toContain("proprietary-model-42");
    expect(artifact.content).not.toContain("never-export-this-error-summary");
    expect(JSON.stringify(artifact.bundle.aiRoutingSummary)).not.toContain("diagnostic-provider");
    expect(JSON.stringify(artifact.bundle.aiRoutingSummary)).not.toContain("diagnostic-writer");
    expect(artifact.bundle.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("recentAiRoutingFailures is intentionally empty"),
        expect.stringContaining("chapterSummaryStatus is null"),
      ]),
    );
    expect(artifact.bundle.summary.configuration).toMatchObject({
      indexIntegrated: true,
      indexPersistence: "runtime_rebuild",
      indexedDocumentCount: 4,
      vectorStatus: "disabled",
      legacyModelProfileCount: 1,
      legacyModelProfilesWithSelection: 1,
      modelHubConnectionCount: 1,
      modelHubUsableConnectionCount: 0,
      modelHubCatalogEntryCount: 1,
      modelHubEnabledTaskRouteCount: 0,
      nativeModelGatewayAvailable: false,
      cloudIdentityEnabled: false,
      cloudSyncEnabled: false,
      encryptedSyncStore: "unavailable",
      entitlementCacheTrust: "unverified_only",
      diagnosticSchemaVersion: 4,
    });
    expect(typeof artifact.bundle.currentSessionStartedAt).toBe("string");
    expect(Array.isArray(artifact.bundle.historicalErrorCodes)).toBe(true);
  });

  it("exports only an embedding endpoint origin and drops provider-derived sentinels", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const sentinel = "API_KEY_SUPERSECRET_正文";
    const originalDiagnostics = runtime.search.embeddingDiagnostics.bind(runtime.search);
    Object.defineProperty(runtime.search, "embeddingDiagnostics", {
      configurable: true,
      value: () => ({
        ...originalDiagnostics(),
        providerId: `provider-${sentinel}`,
        model: `model-${sentinel}`,
        endpointUrl: `https://models.example/${sentinel}?token=${sentinel}`,
        queryFailureCode: sentinel,
      }),
    });

    const artifact = await collectDesktopDiagnosticArtifact(runtime);

    expect(artifact.bundle.summary.configuration).toMatchObject({
      embeddingProviderId: null,
      embeddingModel: null,
      embeddingEndpoint: "https://models.example",
    });
    expect(artifact.content).not.toContain(sentinel);
  });
});
