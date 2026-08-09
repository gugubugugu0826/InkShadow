import { describe, expect, it } from "vitest";
import { runGenerationPreflight } from "@inkshadow/ai-core";

import { collectDesktopDiagnosticArtifact } from "./diagnostics";
import { recordSafeGenerationPreflightDiagnostic } from "./generation-preflight-diagnostics";
import { createDevelopmentRuntime } from "./runtime";

describe("desktop diagnostics", () => {
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

    const artifact = await collectDesktopDiagnosticArtifact(runtime);

    expect(artifact.fileName).toMatch(/^InkShadow-diagnostics-\d{4}-\d{2}-\d{2}-/u);
    expect(artifact.bundle).toMatchObject({
      schemaVersion: 2,
      summary: {
        appVersion: "0.2.1",
        databaseHealth: "unknown",
        indexHealth: "healthy",
        syncState: "local_only",
        errorCodes: ["MODEL_OUTPUT_TRUNCATED"],
        requestIds: ["req-diagnostic-probe-0001"],
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
      recentAiFailures: [
        {
          diagnosticId: "capability_scan:diagnostic-failed-probe",
          providerKind: "custom_openai_compatible",
          connectionId: "diagnostic-provider",
          modelId: "diagnostic-writer",
          taskType: "capability_probe",
          normalizedErrorCode: "MODEL_OUTPUT_TRUNCATED",
          stage: "response_normalization",
          requestId: "req-diagnostic-probe-0001",
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
      ]),
    );
    expect(artifact.bundle.summary.configuration).toMatchObject({
      indexIntegrated: true,
      indexPersistence: "runtime_rebuild",
      indexedDocumentCount: 1,
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
      diagnosticSchemaVersion: 2,
    });
  });
});
