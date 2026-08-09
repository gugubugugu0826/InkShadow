import { parseIsoUtcTimestamp } from "@inkshadow/domain";
import { CryptoUuidV7Generator } from "@inkshadow/platform";
import { describe, expect, it, vi } from "vitest";

import {
  executeModelHubTextTask,
  inspectModelHubTextTask,
  ModelHubExecutionError,
  type ModelHubTextExecutionDependencies,
} from "./model-hub-execution-service";
import { ModelCenterError } from "./model-center-store";
import type { ModelProviderKind, NovelAiTask } from "./model-hub-provider-registry";
import {
  BrowserDevelopmentModelHubStore,
  type ModelCatalogEntry,
  type ModelHubStore,
  type NovelTaskRoute,
} from "./model-hub-store";
import type { NativeModelGatewayClient } from "./runtime";

const NOW = "2026-08-01T00:00:00.000Z";
const parsedNow = parseIsoUtcTimestamp(NOW);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const clock = { now: () => parsedNow.value };
const PRIVATE_INPUT = "PRIVATE_CHAPTER_TEXT_不要写入台账";
const PRIVATE_OUTPUT = "PRIVATE_MODEL_RESPONSE_不要写入台账";

describe("Model Hub text execution service", () => {
  it("inspects the exact primary selection and final policy without invocation or generation side effects", async () => {
    const harness = createHarness();
    await seedTarget(harness.modelHub, {
      connectionId: "inspection-decoy",
      catalogEntryId: "inspection-decoy-catalog",
      modelId: "inspection-decoy-model",
    });
    const target = await seedTarget(harness.modelHub, {
      connectionId: "inspection-claude",
      catalogEntryId: "inspection-claude-catalog",
      modelId: "inspection-claude-model",
      providerKind: "anthropic_claude",
      inputRate: "1000000",
      outputRate: "2000000",
      cachedInputRate: "500000",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "10000",
      currency: "USD",
      parameterPolicy: { maximumOutputTokens: 40, temperature: 0.4 },
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(harness.modelHub, "finishInvocation");
    const expectedInputTokens = conservativeInputTokens(PRIVATE_INPUT);

    const inspection = await inspectModelHubTextTask(harness.dependencies, request());

    expect(inspection).toEqual({
      task: "prose_generation",
      configuredPrimaryCatalogEntryId: "inspection-claude-catalog",
      configuredFallbackCatalogEntryId: null,
      selectionKind: "task_primary",
      usedFallback: false,
      attempt: 1,
      connectionId: "inspection-claude",
      catalogEntryId: "inspection-claude-catalog",
      providerKind: "anthropic_claude",
      modelId: "inspection-claude-model",
      dataDestination: "remote",
      privacyPolicy: "cloud_allowed",
      failurePolicy: "stop",
      maximumOutputTokens: 40,
      temperature: undefined,
      estimatedInputTokens: expectedInputTokens,
      estimatedTotalTokens: expectedInputTokens + 40,
      inputTokenLimit: 200_000,
      outputTokenLimit: 20_000,
      pricing: {
        currency: "USD",
        inputMicrosPerMillionTokens: "1000000",
        outputMicrosPerMillionTokens: "2000000",
        cachedInputMicrosPerMillionTokens: "500000",
        pricingVersion: "execution-test-v1",
        priceUpdatedAt: NOW,
        evidenceSource: "user_confirmed",
        evidenceVersion: "execution-test-v1",
        evidenceUpdatedAt: NOW,
        estimatedMaximumCostMicros: String(expectedInputTokens + 80),
        maximumCostMicros: "10000",
        maximumCostCurrency: "USD",
      },
    });
    expect(harness.credentials.getSummary).toHaveBeenCalledOnce();
    expect(harness.credentials.getSummary).toHaveBeenCalledWith("inspection-claude");
    expect(startInvocation).not.toHaveBeenCalled();
    expect(finishInvocation).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain(PRIVATE_INPUT);
    expect(serialized).not.toContain("https://api.anthropic.com/v1");
    expect(serialized).not.toMatch(/credential|secret|prompt|messages|content/iu);
  });

  it("reports the configured fallback as the actual side-effect-free selection", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {
      connectionId: "inspection-primary-not-ready",
      catalogEntryId: "inspection-primary-catalog",
      modelId: "inspection-primary-model",
      connectionReady: false,
    });
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "inspection-fallback-ready",
      catalogEntryId: "inspection-fallback-catalog",
      modelId: "inspection-fallback-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: primary.id,
      fallbackCatalogEntryId: fallback.id,
      failurePolicy: "use_fallback",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    const inspection = await inspectModelHubTextTask(harness.dependencies, request());

    expect(inspection).toMatchObject({
      configuredPrimaryCatalogEntryId: "inspection-primary-catalog",
      configuredFallbackCatalogEntryId: "inspection-fallback-catalog",
      selectionKind: "task_fallback",
      usedFallback: true,
      attempt: 2,
      connectionId: "inspection-fallback-ready",
      catalogEntryId: "inspection-fallback-catalog",
      modelId: "inspection-fallback-model",
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("uses the same resolved selection and final parameters for inspection and execution", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "shared-resolution",
      catalogEntryId: "shared-resolution-catalog",
      modelId: "shared-resolution-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      parameterPolicy: { maximumOutputTokens: 37, temperature: 0.2 },
    });
    harness.generate.mockResolvedValue({ text: PRIVATE_OUTPUT, usage: null });

    const inspection = await inspectModelHubTextTask(harness.dependencies, request());
    expect(harness.generate).not.toHaveBeenCalled();
    const result = await executeModelHubTextTask(harness.dependencies, request());

    expect(result).toMatchObject({
      connectionId: inspection.connectionId,
      catalogEntryId: inspection.catalogEntryId,
      providerKind: inspection.providerKind,
      modelId: inspection.modelId,
      usedFallback: inspection.usedFallback,
    });
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: inspection.connectionId },
      model: inspection.modelId,
      maxOutputTokens: inspection.maximumOutputTokens,
      temperature: inspection.temperature,
    });
  });

  it("applies visible-prose reasoning suppression only to DeepSeek", async () => {
    for (const providerKind of ["deepseek", "openai"] as const) {
      const harness = createHarness();
      const target = await seedTarget(harness.modelHub, {
        connectionId: `visible-prose-${providerKind}`,
        catalogEntryId: `visible-prose-${providerKind}-catalog`,
        modelId: `visible-prose-${providerKind}-model`,
        providerKind,
      });
      await saveRoute(harness.modelHub, { primaryCatalogEntryId: target.id });
      harness.generate.mockResolvedValue({ text: PRIVATE_OUTPUT, usage: null });

      await executeModelHubTextTask(
        harness.dependencies,
        request({
          generationId: `visible-prose-${providerKind}-generation`,
          reasoningPolicy: "visible_prose",
        }),
      );

      const dispatched = harness.generate.mock.calls[0]?.[0];
      if (providerKind === "deepseek") {
        expect(dispatched).toMatchObject({ reasoningMode: "disabled" });
      } else {
        expect(dispatched).not.toHaveProperty("reasoningMode");
      }
    }
  });

  it("fails closed when the connection is disabled in the final async callback", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "disabled-before-text-dispatch",
      catalogEntryId: "disabled-before-text-dispatch-catalog",
      modelId: "writer-model",
    });
    await saveRoute(harness.modelHub, { primaryCatalogEntryId: target.id });

    await expect(
      executeModelHubTextTask(
        harness.dependencies,
        request({
          onBeforeDispatch: async ({ connectionId }) => {
            await disableConnection(harness.modelHub, connectionId);
          },
        }),
      ),
    ).rejects.toMatchObject({ dispatched: false });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("preserves the exact context-trace pre-dispatch failure without calling the gateway", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "context-trace-before-dispatch",
      catalogEntryId: "context-trace-before-dispatch-catalog",
      modelId: "writer-model",
    });
    await saveRoute(harness.modelHub, { primaryCatalogEntryId: target.id });

    await expect(
      executeModelHubTextTask(
        harness.dependencies,
        request({
          onBeforeDispatch: () =>
            Promise.reject(
              Object.assign(new Error("trace unavailable"), {
                code: "CONTEXT_TRACE_UNAVAILABLE",
              }),
            ),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_UNAVAILABLE", dispatched: false });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("does not propagate an arbitrary duck-typed pre-dispatch code", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "untrusted-code-before-dispatch",
      catalogEntryId: "untrusted-code-before-dispatch-catalog",
      modelId: "writer-model",
    });
    await saveRoute(harness.modelHub, { primaryCatalogEntryId: target.id });

    await expect(
      executeModelHubTextTask(
        harness.dependencies,
        request({
          onBeforeDispatch: () =>
            Promise.reject(
              Object.assign(new Error("forged code"), { code: "FORGED_PROVIDER_SUCCESS" }),
            ),
        }),
      ),
    ).rejects.toMatchObject({ code: "MODEL_HUB_PREFLIGHT_FAILED", dispatched: false });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("fails inspection closed on cost policy without starting an invocation", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "inspection-cost-target",
      catalogEntryId: "inspection-cost-catalog",
      modelId: "inspection-cost-model",
      inputRate: "1000000",
      outputRate: "1000000",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "1",
      currency: "USD",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    await expect(inspectModelHubTextTask(harness.dependencies, request())).rejects.toMatchObject({
      code: "MODEL_HUB_COST_CEILING_EXCEEDED",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("uses the exact catalog connection, credential id, Claude policy, content-free ledger, and actual usage cost", async () => {
    const harness = createHarness();
    await seedTarget(harness.modelHub, {
      connectionId: "decoy-connection",
      catalogEntryId: "decoy-catalog",
      modelId: "decoy-model",
      providerKind: "custom_openai_compatible",
    });
    const target = await seedTarget(harness.modelHub, {
      connectionId: "claude-credential-connection",
      catalogEntryId: "claude-route-catalog",
      modelId: "claude-route-model",
      providerKind: "anthropic_claude",
      inputRate: "1000000",
      outputRate: "2000000",
      cachedInputRate: "500000",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "10000",
      currency: "USD",
      parameterPolicy: { temperature: 0.4 },
    });
    harness.generate.mockResolvedValue({
      text: PRIVATE_OUTPUT,
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 },
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(harness.modelHub, "finishInvocation");

    const result = await executeModelHubTextTask(harness.dependencies, request());

    expect(result).toMatchObject({
      text: PRIVATE_OUTPUT,
      connectionId: "claude-credential-connection",
      catalogEntryId: "claude-route-catalog",
      providerKind: "anthropic_claude",
      modelId: "claude-route-model",
      usedFallback: false,
      costCeilingExceededAfterDispatch: false,
    });
    expect(harness.credentials.getSummary).toHaveBeenCalledWith("claude-credential-connection");
    expect(harness.generate).toHaveBeenCalledOnce();
    const dispatched = harness.generate.mock.calls[0]?.[0];
    expect(dispatched).toMatchObject({
      config: {
        providerId: "claude-credential-connection",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        authentication: "bearer_keyring",
      },
      model: "claude-route-model",
      maxOutputTokens: 20,
      messages: [{ role: "user", content: PRIVATE_INPUT }],
    });
    expect(dispatched).not.toHaveProperty("temperature");
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "claude-credential-connection",
        catalogEntryId: "claude-route-catalog",
        providerKindSnapshot: "anthropic_claude",
        modelIdSnapshot: "claude-route-model",
        routeReason: "task_primary",
      }),
    );
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 4,
        estimatedCostMicros: "18",
        currency: "USD",
      }),
    );
    const ledgerPayload = JSON.stringify({
      start: startInvocation.mock.calls,
      finish: finishInvocation.mock.calls,
      invocation: result.invocation,
    });
    expect(ledgerPayload).not.toContain(PRIVATE_INPUT);
    expect(ledgerPayload).not.toContain(PRIVATE_OUTPUT);
    expect(ledgerPayload).not.toMatch(/"(?:prompt|messages|content|response)"/iu);
  });

  it("rejects non-text task protocols before reading or dispatching a route", async () => {
    const harness = createHarness();
    const findTaskRoute = vi.spyOn(harness.modelHub, "findTaskRoute");

    await expect(
      executeModelHubTextTask(harness.dependencies, request({ task: "embedding" })),
    ).rejects.toMatchObject({
      code: "MODEL_HUB_REQUEST_INVALID",
      dispatched: false,
    });
    expect(findTaskRoute).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("rechecks required capability evidence before dispatch", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "unknown-capability",
      catalogEntryId: "unknown-capability-catalog",
      modelId: "unknown-capability-model",
      includeTextCapability: false,
    });
    await saveRoute(harness.modelHub, { primaryCatalogEntryId: target.id });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    await expect(executeModelHubTextTask(harness.dependencies, request())).rejects.toMatchObject({
      code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("rejects stale and deprecated catalog targets before dispatch", async () => {
    for (const [index, catalogState] of [
      { lifecycle: "deprecated" as const, staleAfter: null },
      { lifecycle: "stable" as const, staleAfter: NOW },
    ].entries()) {
      const harness = createHarness();
      const target = await seedTarget(harness.modelHub, {
        connectionId: `unavailable-${String(index)}`,
        catalogEntryId: `unavailable-catalog-${catalogState.lifecycle}-${catalogState.staleAfter === null ? "none" : "stale"}`,
        modelId: "unavailable-model",
        ...catalogState,
      });
      await saveRoute(harness.modelHub, { primaryCatalogEntryId: target.id });
      const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

      await expect(executeModelHubTextTask(harness.dependencies, request())).rejects.toMatchObject({
        code: "MODEL_HUB_CATALOG_ENTRY_UNAVAILABLE",
        dispatched: false,
      });
      expect(startInvocation).not.toHaveBeenCalled();
      expect(harness.generate).not.toHaveBeenCalled();
    }
  });

  it("rechecks local-only destination and evidence before dispatch", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "privacy-target",
      catalogEntryId: "privacy-target-catalog",
      modelId: "privacy-target-model",
      providerKind: "ollama",
      destination: "local",
    });
    const storedRoute = await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      privacyPolicy: "local_only",
    });
    const storedPrivacy = await harness.modelHub.findCostPrivacyProfile(target.id);
    if (storedPrivacy === null) {
      throw new Error("test privacy profile missing");
    }
    vi.spyOn(harness.modelHub, "findTaskRoute").mockResolvedValue({
      ...storedRoute,
      privacyPolicy: "local_only",
    });
    vi.spyOn(harness.modelHub, "findCostPrivacyProfile").mockResolvedValue({
      ...storedPrivacy,
      dataDestination: "local",
      evidenceSource: "unknown",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    await expect(executeModelHubTextTask(harness.dependencies, request())).rejects.toMatchObject({
      code: "MODEL_HUB_PRIVACY_BLOCKED",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("blocks a private-chapter request on an otherwise cloud-allowed remote route", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "private-remote-target",
      catalogEntryId: "private-remote-catalog",
      modelId: "private-remote-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      privacyPolicy: "cloud_allowed",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    await expect(
      executeModelHubTextTask(harness.dependencies, request({ requiredDataDestination: "local" })),
    ).rejects.toMatchObject({
      code: "PRIVATE_CHAPTER_LOCAL_ONLY",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("uses a verified loopback fallback for a private-chapter request", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {
      connectionId: "private-primary-remote",
      catalogEntryId: "private-primary-remote-catalog",
      modelId: "private-primary-remote-model",
    });
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "private-fallback-local",
      catalogEntryId: "private-fallback-local-catalog",
      modelId: "private-fallback-local-model",
      providerKind: "ollama",
      destination: "local",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: primary.id,
      fallbackCatalogEntryId: fallback.id,
      failurePolicy: "use_fallback",
      privacyPolicy: "cloud_allowed",
    });
    harness.generate.mockResolvedValue({ text: PRIVATE_OUTPUT, usage: null });

    const result = await executeModelHubTextTask(
      harness.dependencies,
      request({ requiredDataDestination: "local" }),
    );

    expect(result).toMatchObject({
      usedFallback: true,
      connectionId: "private-fallback-local",
    });
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0].config.baseUrl).toMatch(
      /^http:\/\/(?:127\.0\.0\.1|localhost)/u,
    );
  });

  it("never treats a remote Ollama endpoint as local-only even with stale local evidence", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "remote-ollama-text",
      catalogEntryId: "remote-ollama-text-catalog",
      modelId: "remote-ollama-text-model",
      providerKind: "ollama",
      baseUrlOverride: "https://remote-ollama.example.test",
      destination: "local",
    });
    const route = await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      privacyPolicy: "cloud_allowed",
    });
    vi.spyOn(harness.modelHub, "findTaskRoute").mockResolvedValue({
      ...route,
      privacyPolicy: "local_only",
    });

    await expect(executeModelHubTextTask(harness.dependencies, request())).rejects.toMatchObject({
      code: "MODEL_HUB_PRIVACY_BLOCKED",
      dispatched: false,
    });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("uses a conservative pre-dispatch estimate to enforce the cost ceiling", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "cost-target",
      catalogEntryId: "cost-target-catalog",
      modelId: "cost-target-model",
      inputRate: "1000000",
      outputRate: "1000000",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "1",
      currency: "USD",
    });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    await expect(executeModelHubTextTask(harness.dependencies, request())).rejects.toMatchObject({
      code: "MODEL_HUB_COST_CEILING_EXCEEDED",
      dispatched: false,
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("switches to a safe fallback only when the primary fails before dispatch", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {
      connectionId: "primary-not-ready",
      catalogEntryId: "primary-not-ready-catalog",
      modelId: "primary-model",
      connectionReady: false,
    });
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "fallback-ready",
      catalogEntryId: "fallback-ready-catalog",
      modelId: "fallback-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: primary.id,
      fallbackCatalogEntryId: fallback.id,
      failurePolicy: "use_fallback",
    });
    harness.generate.mockResolvedValue({ text: PRIVATE_OUTPUT, usage: null });
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");

    const result = await executeModelHubTextTask(harness.dependencies, request());

    expect(result).toMatchObject({
      usedFallback: true,
      connectionId: "fallback-ready",
      catalogEntryId: "fallback-ready-catalog",
      modelId: "fallback-model",
    });
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "fallback-ready" },
      model: "fallback-model",
    });
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        routeReason: "task_fallback",
        attempt: 2,
        connectionId: "fallback-ready",
      }),
    );
  });

  it("does not blindly call the fallback after a dispatched provider failure", async () => {
    const harness = createHarness();
    const primary = await seedTarget(harness.modelHub, {
      connectionId: "dispatched-primary",
      catalogEntryId: "dispatched-primary-catalog",
      modelId: "dispatched-primary-model",
    });
    const fallback = await seedTarget(harness.modelHub, {
      connectionId: "unused-fallback",
      catalogEntryId: "unused-fallback-catalog",
      modelId: "unused-fallback-model",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: primary.id,
      fallbackCatalogEntryId: fallback.id,
      failurePolicy: "use_fallback",
    });
    harness.generate.mockRejectedValue(
      new ModelCenterError("UPSTREAM_TIMEOUT", "private provider failure", true, {
        requestId: "upstream-request-1",
        httpStatus: 504,
        finishReason: "length",
        visibleContentLength: 0,
        reasoningPresent: true,
        stream: true,
        inputTokens: 12,
        outputTokens: 20,
      }),
    );
    const startInvocation = vi.spyOn(harness.modelHub, "startInvocation");
    const finishInvocation = vi.spyOn(harness.modelHub, "finishInvocation");

    let error: unknown;
    try {
      await executeModelHubTextTask(harness.dependencies, request());
    } catch (cause: unknown) {
      error = cause;
    }

    expect(error).toBeInstanceOf(ModelHubExecutionError);
    expect(error).toMatchObject({ code: "UPSTREAM_TIMEOUT", dispatched: true, retryable: true });
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "dispatched-primary" },
      model: "dispatched-primary-model",
    });
    expect(startInvocation).toHaveBeenCalledOnce();
    expect(startInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ routeReason: "task_primary", attempt: 1 }),
    );
    expect(finishInvocation).toHaveBeenCalledOnce();
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "timed_out",
        errorCode: "UPSTREAM_TIMEOUT",
        failure: {
          requestId: "upstream-request-1",
          stage: "http_response",
          retryable: true,
          httpStatus: 504,
          finishReason: "length",
          visibleContentLength: 0,
          reasoningPresent: true,
          stream: true,
          attempt: 1,
          requestedMaxOutputTokens: 20,
        },
      }),
    );
    await expect(harness.modelHub.listRecentAiFailures()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerKind: "custom_openai_compatible",
          connectionId: "dispatched-primary",
          modelId: "dispatched-primary-model",
          normalizedErrorCode: "UPSTREAM_TIMEOUT",
          stage: "http_response",
          requestId: "upstream-request-1",
          requestedMaxOutputTokens: 20,
        }),
      ]),
    );
  });

  it("records actual over-ceiling usage after dispatch without hiding the result", async () => {
    const harness = createHarness();
    const target = await seedTarget(harness.modelHub, {
      connectionId: "actual-cost-target",
      catalogEntryId: "actual-cost-catalog",
      modelId: "actual-cost-model",
      inputRate: "1000000",
      outputRate: "2000000",
    });
    await saveRoute(harness.modelHub, {
      primaryCatalogEntryId: target.id,
      maximumCostMicros: "5000",
      currency: "USD",
    });
    harness.generate.mockResolvedValue({
      text: PRIVATE_OUTPUT,
      usage: { inputTokens: 10_000, outputTokens: 100, cachedInputTokens: null },
    });
    const finishInvocation = vi.spyOn(harness.modelHub, "finishInvocation");

    const result = await executeModelHubTextTask(harness.dependencies, request());

    expect(result.costCeilingExceededAfterDispatch).toBe(true);
    expect(result.invocation).toMatchObject({
      status: "succeeded",
      inputTokens: 10_000,
      outputTokens: 100,
      estimatedCostMicros: "10200",
    });
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        estimatedCostMicros: "10200",
      }),
    );
    expect(harness.generate).toHaveBeenCalledOnce();
  });
});

function createHarness(): Readonly<{
  modelHub: BrowserDevelopmentModelHubStore;
  generate: ReturnType<typeof vi.fn<NativeModelGatewayClient["generate"]>>;
  credentials: Readonly<{
    getSummary: ReturnType<
      typeof vi.fn<(providerId: string) => Promise<Readonly<{ configured: boolean }>>>
    >;
  }>;
  dependencies: ModelHubTextExecutionDependencies;
}> {
  const modelHub = new BrowserDevelopmentModelHubStore(new MemoryStorage(), clock);
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  const credentials = {
    getSummary: vi.fn(() => Promise.resolve({ configured: true })),
  };
  return Object.freeze({
    modelHub,
    generate,
    credentials,
    dependencies: {
      modelHub,
      modelGateway: { available: true, generate },
      credentials,
      clock,
      ids: new CryptoUuidV7Generator(),
    },
  });
}

function request(
  overrides: Partial<Parameters<typeof executeModelHubTextTask>[1]> = {},
): Parameters<typeof executeModelHubTextTask>[1] {
  return {
    task: "prose_generation",
    dispatchScope: { kind: "non_project", reason: "connection_probe" },
    messages: [{ role: "user", content: PRIVATE_INPUT }],
    maximumOutputTokens: 20,
    temperature: 0.6,
    generationId: "test-generation",
    ...overrides,
  };
}

async function seedTarget(
  modelHub: ModelHubStore,
  input: Readonly<{
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
    providerKind?: ModelProviderKind;
    connectionReady?: boolean;
    includeTextCapability?: boolean;
    destination?: "local" | "remote";
    lifecycle?: ModelCatalogEntry["lifecycle"];
    staleAfter?: string | null;
    baseUrlOverride?: string;
    inputRate?: string;
    outputRate?: string;
    cachedInputRate?: string | null;
  }>,
): Promise<ModelCatalogEntry> {
  const providerKind = input.providerKind ?? "custom_openai_compatible";
  const local = input.destination === "local" || providerKind === "ollama";
  const connection = await modelHub.saveConnection({
    id: input.connectionId,
    providerKind,
    displayName: input.connectionId,
    ...(input.baseUrlOverride !== undefined
      ? { baseUrlOverride: input.baseUrlOverride }
      : providerKind === "custom_openai_compatible"
        ? { baseUrlOverride: `https://${input.connectionId}.example.test/v1` }
        : {}),
    credentialRef: local ? null : `keyring:model-hub:${input.connectionId}`,
    credentialState: local ? "missing" : "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: input.connectionReady === false ? "error" : "ready",
    ...(input.connectionReady === false
      ? { errorCode: "TEST_CONNECTION_NOT_READY", errorSummary: "test state" }
      : {}),
    expectedRevision: connection.revision,
  });
  const catalog = await modelHub.syncCatalog({
    syncId: `${input.connectionId}-sync`,
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: input.catalogEntryId,
        providerModelId: input.modelId,
        lifecycle: input.lifecycle ?? "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: input.staleAfter ?? "2026-08-02T00:00:00.000Z",
      },
    ],
  });
  const entry = catalog.find(({ id }) => id === input.catalogEntryId);
  if (entry === undefined) {
    throw new Error("test catalog entry missing");
  }
  if (input.includeTextCapability !== false) {
    await modelHub.recordCapabilityScan({
      scanId: `${input.connectionId}-text-scan`,
      catalogEntryId: entry.id,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "execution-test-v1",
      evidence: [
        {
          id: `${input.connectionId}-text-evidence`,
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        },
      ],
    });
  }
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: entry.id,
    currency: "USD",
    inputMicrosPerMillionTokens: input.inputRate ?? "1000",
    outputMicrosPerMillionTokens: input.outputRate ?? "2000",
    cachedInputMicrosPerMillionTokens: input.cachedInputRate ?? null,
    pricingVersion: "execution-test-v1",
    priceUpdatedAt: NOW,
    dataDestination: local ? "local" : (input.destination ?? "remote"),
    retentionPolicy: local ? "none" : "provider_default",
    trainingPolicy: local ? "not_used" : "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "execution-test-v1",
    expectedRevision: null,
  });
  return entry;
}

async function saveRoute(
  modelHub: ModelHubStore,
  input: Readonly<{
    primaryCatalogEntryId: string;
    fallbackCatalogEntryId?: string | null;
    maximumCostMicros?: string | null;
    currency?: string | null;
    privacyPolicy?: NovelTaskRoute["privacyPolicy"];
    failurePolicy?: NovelTaskRoute["failurePolicy"];
    parameterPolicy?: Readonly<Record<string, unknown>>;
    task?: NovelAiTask;
  }>,
): Promise<NovelTaskRoute> {
  return modelHub.saveTaskRoute({
    task: input.task ?? "prose_generation",
    primaryCatalogEntryId: input.primaryCatalogEntryId,
    fallbackCatalogEntryId: input.fallbackCatalogEntryId ?? null,
    parameterPolicy: input.parameterPolicy ?? {},
    maximumCostMicros: input.maximumCostMicros ?? null,
    currency: input.currency ?? null,
    privacyPolicy: input.privacyPolicy ?? "cloud_allowed",
    failurePolicy:
      input.failurePolicy ??
      (input.fallbackCatalogEntryId === undefined || input.fallbackCatalogEntryId === null
        ? "stop"
        : "use_fallback"),
    routeOrigin: "user",
    expectedRevision: null,
  });
}

async function disableConnection(modelHub: ModelHubStore, connectionId: string): Promise<void> {
  const connection = await modelHub.findConnection(connectionId);
  if (connection === null) throw new Error("test connection missing");
  await modelHub.saveConnection({
    id: connection.id,
    providerKind: connection.providerKind,
    displayName: connection.displayName,
    baseUrlOverride: connection.baseUrl,
    credentialRef: connection.credentialRef,
    credentialState: connection.credentialState,
    authenticationMode: connection.authenticationMode,
    credentialHeaderName: connection.credentialHeaderName,
    modelDiscoveryPath: connection.modelDiscoveryPath,
    textGenerationPath: connection.textGenerationPath,
    embeddingPath: connection.embeddingPath,
    requestTimeoutMs: connection.requestTimeoutMs,
    retryLimit: connection.retryLimit,
    enabled: false,
    expectedRevision: connection.revision,
  });
}

function conservativeInputTokens(content: string): number {
  return new TextEncoder().encode(content).length + 512 + 4_096;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
