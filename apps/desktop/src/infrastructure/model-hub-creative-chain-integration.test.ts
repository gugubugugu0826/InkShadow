import { describe, expect, it, vi } from "vitest";
import { createProjectSeed } from "@inkshadow/domain";

import {
  creativeOpeningTimedOutRequestIds,
  executeCreativeOpeningProviderAction,
  generateCreativeOpening,
  CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS,
  MINIMUM_USABLE_PARTIAL_OPENING_CHARACTERS,
  persistCreativeOpeningCandidate,
  prepareCreativeOpeningProviderAction,
  type CreativeOpeningResult,
  type CreativeOpeningResultPersistenceFence,
  type CreativeOpeningProviderActionInput,
} from "./creative-opening-service";
import { createImportRewriteCandidate } from "./import-rewrite-service";
import type { ModelProviderKind, NovelAiTask } from "./model-hub-provider-registry";
import { MODEL_HUB_AUTOMATIC_ROUTE_GENERATION_VERSION } from "./model-hub-routing-service";
import type { ModelHubStore } from "./model-hub-store";
import type { PreparedNovelSkillInvocation } from "./novel-skill-runtime";
import {
  createSelectionRewriteCandidate,
  prepareSelectionRewrite,
  type SelectionRewriteCandidateInput,
} from "./selection-rewrite-service";
import {
  createConfiguredModelCandidate,
  createDevelopmentRuntime,
  executeGenerationPlan,
  prepareGenerationPlan,
  type CredentialStore,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "./runtime";

describe("real creative chains use Model Hub routes", () => {
  for (const provider of [
    {
      providerKind: "anthropic_claude" as const,
      connectionId: "opening-claude",
      catalogEntryId: "opening-claude-catalog",
      modelId: "opening-claude-model",
      gatewayProvider: "anthropic" as const,
    },
    {
      providerKind: "google_gemini" as const,
      connectionId: "opening-gemini",
      catalogEntryId: "opening-gemini-catalog",
      modelId: "opening-gemini-model",
      gatewayProvider: "gemini" as const,
    },
  ]) {
    it(`routes opening generation exactly through ${provider.providerKind}`, async () => {
      const harness = createNativeHarness();
      await seedModelHubTextRoute(harness.runtime.modelHub, {
        task: "book_start_guidance",
        ...provider,
      });
      harness.generate.mockResolvedValue({ text: "路由生成的小说开头。", usage: null });

      const result = await generateCreativeOpening(harness.runtime, {
        idea: "一个在雨夜收到未来来信的女孩",
        requestId: `request-${provider.connectionId}`,
      });

      expect(result).toMatchObject({
        source: "provider",
        text: "路由生成的小说开头。",
        providerId: provider.connectionId,
        modelId: provider.modelId,
      });
      expect(harness.generate).toHaveBeenCalledOnce();
      expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
        generationId: `request-${provider.connectionId}`,
        config: {
          providerId: provider.connectionId,
          provider: provider.gatewayProvider,
        },
        model: provider.modelId,
      });
      if (provider.providerKind === "anthropic_claude") {
        expect(harness.generate.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
      }
      expect(harness.listModels).not.toHaveBeenCalled();
    });
  }

  it("stops an obsolete automatic opening route before Provider dispatch", async () => {
    const harness = createNativeHarness();
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "obsolete-auto-opening",
      catalogEntryId: "obsolete-auto-opening-catalog",
      modelId: "deepseek-v4-flash-vision-exp",
      routeOrigin: "automatic",
      routeGenerationVersion: "model-hub-evidence-router-v2",
      lifecycle: "unknown",
    });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "一座只在雾里出现的城市。",
        requestId: "obsolete-auto-opening-request",
      }),
    ).rejects.toMatchObject({ code: "CREATIVE_OPENING_AUTOMATIC_ROUTE_OUTDATED" });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("blocks a current automatic experimental vision route but keeps an explicit manual route authoritative", async () => {
    const harness = createNativeHarness();
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "current-auto-visual-opening",
      catalogEntryId: "current-auto-visual-opening-catalog",
      modelId: "deepseek-v4-flash-vision-exp",
      routeOrigin: "automatic",
      routeGenerationVersion: MODEL_HUB_AUTOMATIC_ROUTE_GENERATION_VERSION,
      lifecycle: "unknown",
    });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "一封来自二十年后的旧信。",
        requestId: "current-auto-visual-opening-request",
      }),
    ).rejects.toMatchObject({ code: "CREATIVE_OPENING_AUTOMATIC_VISUAL_ROUTE_UNSUITABLE" });
    expect(harness.generate).not.toHaveBeenCalled();

    const automatic = await harness.runtime.modelHub.findTaskRoute("book_start_guidance");
    if (automatic === null) throw new Error("expected the automatic opening route");
    const manual = await harness.runtime.modelHub.saveTaskRoute({
      task: automatic.task,
      primaryCatalogEntryId: automatic.primaryCatalogEntryId,
      fallbackCatalogEntryId: automatic.fallbackCatalogEntryId,
      presetId: null,
      parameterPolicy: automatic.parameterPolicy,
      maximumCostMicros: automatic.maximumCostMicros,
      currency: automatic.currency,
      privacyPolicy: automatic.privacyPolicy,
      failurePolicy: automatic.failurePolicy,
      routeOrigin: "user",
      enabled: automatic.enabled,
      expectedRevision: automatic.revision,
    });
    harness.generate.mockResolvedValue({ text: "作者明确选择后的开头。", usage: null });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "一封来自二十年后的旧信。",
        requestId: "manual-visual-opening-request",
      }),
    ).resolves.toMatchObject({
      text: "作者明确选择后的开头。",
      providerId: "current-auto-visual-opening",
      modelId: "deepseek-v4-flash-vision-exp",
    });
    expect(harness.generate).toHaveBeenCalledOnce();
    await expect(harness.runtime.modelHub.findTaskRoute("book_start_guidance")).resolves.toEqual(
      manual,
    );
  });

  it("prepares all four bounded opening actions with zero Provider calls and exact disclosures", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-disclosure",
      catalogEntryId: "opening-disclosure-catalog",
      modelId: "opening-disclosure-model",
    });
    const projectContext = { projectId: chapter.projectId, chapterId: chapter.id };
    const actions: readonly CreativeOpeningProviderActionInput[] = [
      {
        actionId: "initial-action",
        kind: "initial_batch",
        idea: "一座只在雨夜出现的旧车站。",
        answers: { tone: "克制" },
        projectContext,
        requestIds: nextOpeningRequestIds(harness.runtime, 3),
      },
      {
        actionId: "replacement-action",
        kind: "replacement_batch",
        idea: "一座只在雨夜出现的旧车站。",
        direction: "让冲突更快出现",
        projectContext,
        requestIds: nextOpeningRequestIds(harness.runtime, 3),
      },
      {
        actionId: "completion-action",
        kind: "complete_partial",
        idea: "一座只在雨夜出现的旧车站。",
        projectContext,
        requestIds: nextOpeningRequestIds(harness.runtime, 1),
        openingAngle: "mystery_clue",
        partialOpening: "雨水沿着废弃站牌往下流，站台尽头忽然亮起一盏灯。",
      },
      {
        actionId: "single-action",
        kind: "regenerate_single",
        idea: "一座只在雨夜出现的旧车站。",
        projectContext,
        requestIds: nextOpeningRequestIds(harness.runtime, 1),
        openingAngle: "relationship_dialogue",
      },
    ];

    const disclosures = await Promise.all(
      actions.map((action) => prepareCreativeOpeningProviderAction(harness.runtime, action)),
    );

    expect(harness.generate).not.toHaveBeenCalled();
    expect(disclosures.map(({ maximumProviderCalls }) => maximumProviderCalls)).toEqual([
      3, 3, 1, 1,
    ]);
    expect(disclosures.map(({ requestCount }) => requestCount)).toEqual([3, 3, 1, 1]);
    expect(disclosures.map(({ automaticRetryCount }) => automaticRetryCount)).toEqual([0, 0, 0, 0]);
    expect(
      disclosures.map(({ perRequestMaximumProviderCalls }) => perRequestMaximumProviderCalls),
    ).toEqual([1, 1, 1, 1]);
    expect(
      disclosures.every(
        ({ connectionDisplayName }) => connectionDisplayName === "opening-disclosure",
      ),
    ).toBe(true);
    expect(disclosures.every(({ modelId }) => modelId === "opening-disclosure-model")).toBe(true);
    expect(disclosures.every(({ dataDestination }) => dataDestination === "remote")).toBe(true);
    expect(
      disclosures.every(({ estimatedMaximumCostMicros }) => estimatedMaximumCostMicros === "0"),
    ).toBe(true);
    expect(disclosures.every(({ currency }) => currency === "USD")).toBe(true);
    expect(disclosures.map(({ calls }) => calls.length)).toEqual([3, 3, 1, 1]);
    expect(new Set(disclosures.map(({ fingerprint }) => fingerprint)).size).toBe(4);
    expect(disclosures.every(({ fingerprint }) => /^[a-f0-9]{64}$/u.test(fingerprint))).toBe(true);
  });

  it("prepares and executes one direct opening with the same request and exactly one call", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-direct-single",
      catalogEntryId: "opening-direct-single-catalog",
      modelId: "opening-direct-single-model",
    });
    const requestId = nextOpeningRequestIds(harness.runtime, 1)[0];
    if (requestId === undefined) throw new Error("expected one direct opening request");
    harness.generate.mockResolvedValue({ text: "只生成一次的开头。", usage: null });
    const action: CreativeOpeningProviderActionInput = {
      actionId: requestId,
      kind: "initial_single",
      idea: "一座城市每天都会遗失同一分钟。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds: [requestId],
      openingAngle: "immediate_action",
    };

    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
    expect(disclosure).toMatchObject({
      requestCount: 1,
      maximumProviderCalls: 1,
      automaticRetryCount: 0,
    });
    expect(harness.generate).not.toHaveBeenCalled();

    const results = await executeCreativeOpeningProviderAction(harness.runtime, {
      ...action,
      humanConfirmed: true,
      disclosureFingerprint: disclosure.fingerprint,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.requestId).toBe(requestId);
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(harness.generate.mock.calls[0]?.[0].generationId).toBe(requestId);
  });

  it("labels the total action cost unknown when exact pricing is unavailable", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-cost-unknown",
      catalogEntryId: "opening-cost-unknown-catalog",
      modelId: "opening-cost-unknown-model",
      pricing: "unknown",
    });

    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, {
      actionId: "unknown-cost-action",
      kind: "initial_batch",
      idea: "海边小镇每年会忘记同一个人。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds: nextOpeningRequestIds(harness.runtime, 3),
    });

    expect(disclosure).toMatchObject({
      maximumProviderCalls: 3,
      automaticRetryCount: 0,
      estimatedMaximumCostMicros: null,
      currency: null,
    });
    expect(
      disclosure.calls.every(
        ({ estimatedMaximumCostMicros }) => estimatedMaximumCostMicros === null,
      ),
    ).toBe(true);
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation and executes only the disclosed 3/3/1/1 call budgets with zero retries", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-confirmed",
      catalogEntryId: "opening-confirmed-catalog",
      modelId: "opening-confirmed-model",
    });
    harness.generate.mockImplementation((input) =>
      Promise.resolve({ text: `开头 ${input.generationId}`, usage: null }),
    );
    const projectContext = { projectId: chapter.projectId, chapterId: chapter.id };
    const actions: readonly CreativeOpeningProviderActionInput[] = [
      {
        actionId: "confirmed-initial",
        kind: "initial_batch",
        idea: "城市里最后一封纸质信来自未来。",
        projectContext,
        requestIds: nextOpeningRequestIds(harness.runtime, 3),
      },
      {
        actionId: "confirmed-replacement",
        kind: "replacement_batch",
        idea: "城市里最后一封纸质信来自未来。",
        direction: "换一批更有行动感的方案",
        projectContext,
        requestIds: nextOpeningRequestIds(harness.runtime, 3),
      },
      {
        actionId: "confirmed-completion",
        kind: "complete_partial",
        idea: "城市里最后一封纸质信来自未来。",
        projectContext,
        requestIds: nextOpeningRequestIds(harness.runtime, 1),
        openingAngle: "mystery_clue",
        partialOpening: "信封上的邮戳比今天晚了整整十年。",
      },
      {
        actionId: "confirmed-single",
        kind: "regenerate_single",
        idea: "城市里最后一封纸质信来自未来。",
        projectContext,
        requestIds: nextOpeningRequestIds(harness.runtime, 1),
        openingAngle: "immediate_action",
      },
    ];

    const firstAction = actions[0];
    if (firstAction === undefined) throw new Error("expected an opening action");
    await expect(
      executeCreativeOpeningProviderAction(harness.runtime, firstAction),
    ).rejects.toMatchObject({
      code: "CREATIVE_OPENING_CONFIRMATION_REQUIRED",
    });
    expect(harness.generate).not.toHaveBeenCalled();

    const results: CreativeOpeningResult[][] = [];
    for (const action of actions) {
      const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
      results.push([
        ...(await executeCreativeOpeningProviderAction(harness.runtime, {
          ...action,
          humanConfirmed: true,
          disclosureFingerprint: disclosure.fingerprint,
        })),
      ]);
    }

    expect(results.map((batch) => batch.length)).toEqual([3, 3, 1, 1]);
    expect(results.flat().map(({ source, noticeCode }) => ({ source, noticeCode }))).toEqual(
      Array.from({ length: 8 }, () => ({ source: "provider", noticeCode: null })),
    );
    expect(harness.generate).toHaveBeenCalledTimes(8);
    expect(
      harness.generate.mock.calls.every(
        ([request]) => request.config.retryLimit === 0 && request.maxOutputTokens === 1_200,
      ),
    ).toBe(true);
  });

  it("keeps all three provider slots independent when one local result callback rejects", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-result-isolation",
      catalogEntryId: "opening-result-isolation-catalog",
      modelId: "opening-result-isolation-model",
    });
    const requestIds = nextOpeningRequestIds(harness.runtime, 3);
    harness.generate.mockImplementation((input) =>
      Promise.resolve({ text: `独立结果 ${input.generationId}`, usage: null }),
    );
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-result-isolation-action",
      kind: "initial_batch",
      idea: "三座灯塔在同一晚收到不同年份的求救信号。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds,
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
    const observedResults: CreativeOpeningResult[] = [];
    const onResult = vi.fn((result: CreativeOpeningResult) => {
      observedResults.push(result);
      if (result.requestId === requestIds[0]) {
        return Promise.reject(new Error("simulated local slot persistence failure"));
      }
      return Promise.resolve();
    });

    await expect(
      executeCreativeOpeningProviderAction(harness.runtime, {
        ...action,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
        onResult,
      }),
    ).rejects.toThrow("simulated local slot persistence failure");

    expect(new Set(observedResults.map(({ requestId }) => requestId))).toEqual(new Set(requestIds));
    expect(onResult).toHaveBeenCalledTimes(3);
    expect(harness.generate).toHaveBeenCalledTimes(3);
    expect(harness.generate.mock.calls.every(([request]) => request.config.retryLimit === 0)).toBe(
      true,
    );
    for (const requestId of requestIds) {
      await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
        task: "book_start_guidance",
        status: "succeeded",
        attempt: 1,
      });
    }
  });
  it("keeps an exact pre-dispatch ledger when confirmed source preparation fails", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-preparation-timeout",
      catalogEntryId: "opening-preparation-timeout-catalog",
      modelId: "opening-preparation-timeout-model",
    });
    const requestId = nextOpeningRequestIds(harness.runtime, 1)[0];
    if (requestId === undefined) throw new Error("expected one opening request");
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-preparation-timeout-action",
      kind: "regenerate_single",
      idea: "一名修表匠发现整座城市停在同一分钟。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds: [requestId],
      openingAngle: "mystery_clue",
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
    const preparationFailure = new Error("simulated confirmed source preparation failure");
    const preparation = vi
      .spyOn(harness.runtime.projectSeeds, "findByProjectId")
      .mockRejectedValue(preparationFailure);
    const onInvocationPrepared = vi.fn();
    const onResult = vi.fn();

    await expect(
      executeCreativeOpeningProviderAction(harness.runtime, {
        ...action,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
        onInvocationPrepared,
        onResult,
      }),
    ).rejects.toMatchObject({
      code: "CREATIVE_OPENING_DISCLOSURE_CHANGED",
      dispatched: false,
    });

    expect(preparation).toHaveBeenCalledOnce();
    expect(harness.generate).not.toHaveBeenCalled();
    expect(onInvocationPrepared).toHaveBeenCalledOnce();
    expect(onInvocationPrepared).toHaveBeenCalledWith(requestId, {
      invocationId: requestId,
      connectionId: "opening-preparation-timeout",
      modelId: "opening-preparation-timeout-model",
    });
    expect(onResult).not.toHaveBeenCalled();
    await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
      id: requestId,
      task: "book_start_guidance",
      status: "failed",
      attempt: 1,
      providerDispatchStartedAt: null,
    });
  });

  it("closes the result persistence fence at 180 seconds and reports the exact timed-out request", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-result-persistence-timeout",
      catalogEntryId: "opening-result-persistence-timeout-catalog",
      modelId: "opening-result-persistence-timeout-model",
    });
    const requestId = nextOpeningRequestIds(harness.runtime, 1)[0];
    if (requestId === undefined) throw new Error("expected one opening request");
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-result-persistence-timeout-action",
      kind: "regenerate_single",
      idea: "一张旧底片显影出尚未发生的告别。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds: [requestId],
      openingAngle: "mystery_clue",
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
    harness.generate.mockResolvedValue({ text: "暗房门缝下漫进雨水。", usage: null });
    const cancelGeneration = vi
      .spyOn(harness.runtime.modelGateway, "cancelGeneration")
      .mockResolvedValue(false);
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const onResult = vi.fn(
      async (result: CreativeOpeningResult, fence: CreativeOpeningResultPersistenceFence) => {
        expect(result.requestId).toBe(requestId);
        expect(fence.isPending()).toBe(true);
        await persistenceGate;
      },
    );

    vi.useFakeTimers();
    try {
      const execution = executeCreativeOpeningProviderAction(harness.runtime, {
        ...action,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
        onResult,
      });
      const terminal = execution.then(
        () => null,
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
      const persistenceFence = onResult.mock.calls[0]?.[1];
      if (persistenceFence === undefined) {
        throw new Error("result persistence callback did not receive its fence");
      }
      expect(persistenceFence.isPending()).toBe(true);

      await vi.advanceTimersByTimeAsync(CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS);
      const cause = await terminal;

      expect(cause).toMatchObject({ code: "MODEL_TIMEOUT" });
      expect(creativeOpeningTimedOutRequestIds(cause)).toEqual([requestId]);
      expect(persistenceFence.isPending()).toBe(false);
      expect(() => persistenceFence.assertPending()).toThrow(
        expect.objectContaining({ code: "MODEL_TIMEOUT" }),
      );
      expect(cancelGeneration).not.toHaveBeenCalled();
      await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
        status: "succeeded",
      });

      releasePersistence();
      await Promise.resolve();
      await Promise.resolve();
      expect(cancelGeneration).not.toHaveBeenCalled();
    } finally {
      releasePersistence();
      vi.useRealTimers();
    }
  });

  it("reports only the two persistence slots that cross 180 seconds while one slot settles", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-mixed-result-timeout",
      catalogEntryId: "opening-mixed-result-timeout-catalog",
      modelId: "opening-mixed-result-timeout-model",
    });
    const requestIds = nextOpeningRequestIds(harness.runtime, 3);
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-mixed-result-timeout-action",
      kind: "initial_batch",
      idea: "三封信分别预告同一座城市的三种结局。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds,
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
    harness.generate.mockImplementation((input) =>
      Promise.resolve({ text: `独立结果 ${input.generationId}`, usage: null }),
    );
    const cancelGeneration = vi
      .spyOn(harness.runtime.modelGateway, "cancelGeneration")
      .mockResolvedValue(false);
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const fences = new Map<string, CreativeOpeningResultPersistenceFence>();
    const onResult = vi.fn(
      async (result: CreativeOpeningResult, fence: CreativeOpeningResultPersistenceFence) => {
        fences.set(result.requestId, fence);
        if (result.requestId !== requestIds[0]) {
          await persistenceGate;
        }
      },
    );

    vi.useFakeTimers();
    try {
      const execution = executeCreativeOpeningProviderAction(harness.runtime, {
        ...action,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
        onResult,
      });
      const terminal = execution.then(
        () => null,
        (cause: unknown) => cause,
      );
      await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(3));

      await vi.advanceTimersByTimeAsync(CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS);
      const cause = await terminal;

      expect(creativeOpeningTimedOutRequestIds(cause)).toEqual(requestIds.slice(1));
      expect(fences.get(requestIds[0] ?? "")?.isPending()).toBe(false);
      expect(fences.get(requestIds[1] ?? "")?.isPending()).toBe(false);
      expect(fences.get(requestIds[2] ?? "")?.isPending()).toBe(false);
      expect(cancelGeneration).not.toHaveBeenCalled();
      for (const requestId of requestIds) {
        await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
          status: "succeeded",
        });
      }
    } finally {
      releasePersistence();
      vi.useRealTimers();
    }
  });

  it("fills the exact slot id for a MODEL_TIMEOUT without a carrier and preserves a carried timeout id", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-mixed-timeout-carrier",
      catalogEntryId: "opening-mixed-timeout-carrier-catalog",
      modelId: "opening-mixed-timeout-carrier-model",
    });
    const requestIds = nextOpeningRequestIds(harness.runtime, 3);
    const missingCarrierId = requestIds[1];
    const carriedId = requestIds[2];
    if (missingCarrierId === undefined || carriedId === undefined) {
      throw new Error("expected three fixed opening request ids");
    }
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-mixed-timeout-carrier-action",
      kind: "initial_batch",
      idea: "三盏灯分别照见同一条街的过去、现在和未来。",
      requestIds,
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
    harness.generate.mockImplementation((input) =>
      Promise.resolve({ text: `独立结果 ${input.generationId}`, usage: null }),
    );
    const cancelGeneration = vi
      .spyOn(harness.runtime.modelGateway, "cancelGeneration")
      .mockResolvedValue(false);
    const onResult = vi.fn((result: CreativeOpeningResult) => {
      if (result.requestId === requestIds[0]) return;
      if (result.requestId === missingCarrierId) {
        throw Object.assign(new Error("simulated timeout without request carrier"), {
          code: "MODEL_TIMEOUT",
        });
      }
      throw Object.assign(new Error("simulated timeout with request carrier"), {
        code: "MODEL_TIMEOUT",
        timedOutRequestIds: Object.freeze([carriedId]),
      });
    });

    const cause = await executeCreativeOpeningProviderAction(harness.runtime, {
      ...action,
      humanConfirmed: true,
      disclosureFingerprint: disclosure.fingerprint,
      onResult,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(cause).toMatchObject({ code: "MODEL_TIMEOUT" });
    expect(creativeOpeningTimedOutRequestIds(cause)).toEqual([missingCarrierId, carriedId]);
    expect(onResult).toHaveBeenCalledTimes(3);
    expect(cancelGeneration).not.toHaveBeenCalled();
    for (const requestId of requestIds) {
      await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
        status: "succeeded",
      });
    }
  });
  it("fails closed when one timed-out slot carries another settled slot id", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-cross-bound-timeout-carrier",
      catalogEntryId: "opening-cross-bound-timeout-carrier-catalog",
      modelId: "opening-cross-bound-timeout-carrier-model",
    });
    const requestIds = nextOpeningRequestIds(harness.runtime, 3);
    const timedOutId = requestIds[1];
    const settledId = requestIds[2];
    if (timedOutId === undefined || settledId === undefined) {
      throw new Error("expected three fixed opening request ids");
    }
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-cross-bound-timeout-carrier-action",
      kind: "initial_batch",
      idea: "三座车站分别保存同一趟列车的三份到站记录。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds,
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
    harness.generate.mockImplementation((input) =>
      Promise.resolve({ text: `独立结果 ${input.generationId}`, usage: null }),
    );
    const cancelGeneration = vi
      .spyOn(harness.runtime.modelGateway, "cancelGeneration")
      .mockResolvedValue(false);
    const onResult = vi.fn((result: CreativeOpeningResult) => {
      if (result.requestId !== timedOutId) return;
      throw Object.assign(new Error("simulated cross-bound timeout carrier"), {
        code: "MODEL_TIMEOUT",
        timedOutRequestIds: Object.freeze([settledId]),
      });
    });

    const cause = await executeCreativeOpeningProviderAction(harness.runtime, {
      ...action,
      humanConfirmed: true,
      disclosureFingerprint: disclosure.fingerprint,
      onResult,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(cause).toMatchObject({
      code: "CREATIVE_OPENING_TIMEOUT_SCOPE_MISMATCH",
    });
    expect(creativeOpeningTimedOutRequestIds(cause)).toEqual([]);
    expect(onResult).toHaveBeenCalledTimes(3);
    expect(cancelGeneration).not.toHaveBeenCalled();
    for (const requestId of requestIds) {
      await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
        status: "succeeded",
      });
    }
  });

  it("bounds the public preparation at 180 seconds without creating invocation facts or retrying", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-public-preparation-timeout",
      catalogEntryId: "opening-public-preparation-timeout-catalog",
      modelId: "opening-public-preparation-timeout-model",
    });
    const requestIds = nextOpeningRequestIds(harness.runtime, 3);
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-public-preparation-timeout-action",
      kind: "initial_batch",
      idea: "三扇门在同一场雨里通往不同年份。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds,
    };
    const originalFind = harness.runtime.projectSeeds.findByProjectId.bind(
      harness.runtime.projectSeeds,
    );
    let releasePreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const preparation = vi
      .spyOn(harness.runtime.projectSeeds, "findByProjectId")
      .mockImplementation(async (projectId) => {
        await preparationGate;
        return originalFind(projectId);
      });
    const cancelGeneration = vi
      .spyOn(harness.runtime.modelGateway, "cancelGeneration")
      .mockResolvedValue(false);

    vi.useFakeTimers();
    try {
      const pending = prepareCreativeOpeningProviderAction(harness.runtime, action);
      const rejection = expect(pending).rejects.toMatchObject({
        code: "MODEL_TIMEOUT",
      });
      await Promise.resolve();
      expect(preparation).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS);
      await rejection;
      await expect(pending).rejects.toThrow("不会自动重试");

      expect(cancelGeneration).not.toHaveBeenCalled();
      expect(harness.generate).not.toHaveBeenCalled();
      for (const requestId of requestIds) {
        await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toBeNull();
      }

      releasePreparation();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.generate).not.toHaveBeenCalled();
      for (const requestId of requestIds) {
        await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toBeNull();
      }
    } finally {
      releasePreparation();
      vi.useRealTimers();
    }
  });

  it("bounds a hanging second invocation reservation and settles a late local row without sending", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-reservation-timeout",
      catalogEntryId: "opening-reservation-timeout-catalog",
      modelId: "opening-reservation-timeout-model",
    });
    const requestIds = nextOpeningRequestIds(harness.runtime, 3);
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-reservation-timeout-action",
      kind: "initial_batch",
      idea: "一座剧院每晚都为尚未出生的观众谢幕。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds,
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
    const originalStartInvocation = harness.runtime.modelHub.startInvocation.bind(
      harness.runtime.modelHub,
    );
    let reservationCount = 0;
    let releaseSecondReservation!: () => void;
    const lateReservation: { value: Promise<unknown> | null } = { value: null };
    vi.spyOn(harness.runtime.modelHub, "startInvocation").mockImplementation((input) => {
      reservationCount += 1;
      if (reservationCount !== 2) return originalStartInvocation(input);
      lateReservation.value = new Promise((resolve, reject) => {
        releaseSecondReservation = () => {
          originalStartInvocation(input).then(resolve, reject);
        };
      });
      return lateReservation.value as ReturnType<ModelHubStore["startInvocation"]>;
    });
    const onInvocationPrepared = vi.fn();

    vi.useFakeTimers();
    const pending = executeCreativeOpeningProviderAction(harness.runtime, {
      ...action,
      humanConfirmed: true,
      disclosureFingerprint: disclosure.fingerprint,
      onInvocationPrepared,
    });
    const rejection = expect(pending).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    try {
      await vi.waitFor(() => expect(reservationCount).toBe(2));
      await vi.advanceTimersByTimeAsync(CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    expect(harness.generate).not.toHaveBeenCalled();
    expect(onInvocationPrepared).toHaveBeenCalledTimes(1);
    await expect(
      harness.runtime.modelHub.findInvocation(requestIds[0] ?? "missing"),
    ).resolves.toMatchObject({
      status: "failed",
      providerDispatchStartedAt: null,
    });
    await expect(
      harness.runtime.modelHub.findInvocation(requestIds[1] ?? "missing"),
    ).resolves.toBeNull();
    await expect(
      harness.runtime.modelHub.findInvocation(requestIds[2] ?? "missing"),
    ).resolves.toBeNull();

    releaseSecondReservation();
    const settledLateReservation = lateReservation.value;
    if (settledLateReservation === null) {
      throw new Error("预留超时测试没有取得较晚完成的本地记录。");
    }
    await settledLateReservation;
    await vi.waitFor(async () => {
      await expect(
        harness.runtime.modelHub.findInvocation(requestIds[1] ?? "missing"),
      ).resolves.toMatchObject({ status: "failed", providerDispatchStartedAt: null });
    });
    expect(onInvocationPrepared).toHaveBeenCalledTimes(1);
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("rejects route, cost and request-source drift against the confirmed fingerprint before dispatch", async () => {
    for (const drift of ["route", "cost", "source"] as const) {
      const harness = createNativeHarness();
      const chapter = await createChapter(harness.runtime, "");
      await seedModelHubTextRoute(harness.runtime.modelHub, {
        task: "book_start_guidance",
        providerKind: "openai",
        connectionId: `opening-${drift}-original`,
        catalogEntryId: `opening-${drift}-original-catalog`,
        modelId: `opening-${drift}-original-model`,
      });
      const action: CreativeOpeningProviderActionInput = {
        actionId: `opening-${drift}-action`,
        kind: "regenerate_single",
        idea: "一名钟表匠发现城市时间每天都会少一分钟。",
        answers: { atmosphere: "安静" },
        projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
        requestIds: nextOpeningRequestIds(harness.runtime, 1),
        openingAngle: "immediate_action",
      };
      const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);
      let executionInput: CreativeOpeningProviderActionInput = action;
      if (drift === "route") {
        await seedModelHubTextRoute(harness.runtime.modelHub, {
          task: "idea_discussion",
          providerKind: "google_gemini",
          connectionId: "opening-route-new",
          catalogEntryId: "opening-route-new-catalog",
          modelId: "opening-route-new-model",
        });
        await changeModelHubRoute(
          harness.runtime.modelHub,
          "book_start_guidance",
          "opening-route-new-catalog",
        );
      } else if (drift === "cost") {
        await changeModelHubPricing(harness.runtime.modelHub, "opening-cost-original-catalog");
      } else {
        executionInput = { ...action, answers: { atmosphere: "明快" } };
      }

      await expect(
        executeCreativeOpeningProviderAction(harness.runtime, {
          ...executionInput,
          humanConfirmed: true,
          disclosureFingerprint: disclosure.fingerprint,
        }),
      ).rejects.toMatchObject({ code: "CREATIVE_OPENING_DISCLOSURE_CHANGED" });
      expect(harness.generate).not.toHaveBeenCalled();
    }
  });

  it("rechecks compiled sources after confirmation and stops at zero Provider calls when they drift", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-source-final",
      catalogEntryId: "opening-source-final-catalog",
      modelId: "opening-source-final-model",
    });
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-source-final-action",
      kind: "regenerate_single",
      idea: "一个没有影子的人来到冬天的港口。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds: nextOpeningRequestIds(harness.runtime, 1),
      openingAngle: "relationship_dialogue",
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);

    await expect(
      executeCreativeOpeningProviderAction(harness.runtime, {
        ...action,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
        onInvocationPrepared: async () => {
          await harness.runtime.projectSeeds.saveForProject(
            chapter.projectId,
            createProjectSeed({
              seedId: harness.runtime.ids.next(),
              journeyKind: "idea",
              premise: "这是确认后才出现的新来源，不能沿用旧披露发送。",
              now: harness.runtime.clock.now(),
            }),
          );
        },
      }),
    ).rejects.toMatchObject({ code: "CREATIVE_OPENING_DISCLOSURE_CHANGED" });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("rechecks privacy after confirmation and blocks a newly private opening before dispatch", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-privacy-final",
      catalogEntryId: "opening-privacy-final-catalog",
      modelId: "opening-privacy-final-model",
    });
    const action: CreativeOpeningProviderActionInput = {
      actionId: "opening-privacy-final-action",
      kind: "complete_partial",
      idea: "一间只在凌晨开门的照相馆。",
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      requestIds: nextOpeningRequestIds(harness.runtime, 1),
      openingAngle: "mystery_clue",
      partialOpening: "快门响过之后，照片里多出了一个没有来过的人。",
    };
    const disclosure = await prepareCreativeOpeningProviderAction(harness.runtime, action);

    await expect(
      executeCreativeOpeningProviderAction(harness.runtime, {
        ...action,
        humanConfirmed: true,
        disclosureFingerprint: disclosure.fingerprint,
        onInvocationPrepared: async () => {
          const changed = await harness.runtime.useCases.setChapterPrivacy.execute({
            chapterId: chapter.id,
            privacyMode: "local_only",
            expectedPrivacyRevision: chapter.privacyRevision,
          });
          if (!changed.ok) throw changed.error;
        },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_CONTEXT_PRIVACY_CHANGED" });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("links the opening trace and rechecks privacy before skill commit, final dispatch, and return", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "ollama",
      connectionId: "traceable-opening",
      catalogEntryId: "traceable-opening-catalog",
      modelId: "traceable-opening-model",
      dataDestination: "local",
    });
    harness.generate.mockResolvedValue({ text: "可追溯的开头正文。", usage: null });
    const compiled = Object.freeze({}) as NonNullable<PreparedNovelSkillInvocation["compiled"]>;
    const preparation: PreparedNovelSkillInvocation = Object.freeze({
      status: "prepared_none_selected",
      notAppliedReason: null,
      availability: Object.freeze({ status: "ready", reason: null }),
      maximumSkillTokens: 1_200,
      usedSkillTokens: 0,
      promptSection: null,
      methods: Object.freeze([]),
      compiled,
    });
    vi.spyOn(harness.runtime.novelSkills, "getReservedTokens").mockResolvedValue(1_200);
    const prepareSkill = vi
      .spyOn(harness.runtime.novelSkills, "prepareInvocation")
      .mockResolvedValue(preparation);
    const commitSkill = vi
      .spyOn(harness.runtime.novelSkills, "commitBeforeDispatch")
      .mockResolvedValue(
        Object.freeze({
          taskType: "book_start_guidance",
          invocationMode: "draft",
          maximumSkillTokens: 1_200,
          usedSkillTokens: 0,
          methods: Object.freeze([]),
          createdAt: harness.runtime.clock.now(),
        }),
      );
    const saveTrace = vi.spyOn(harness.runtime.contextTraces, "save");
    const linkInvocation = vi.spyOn(harness.runtime.contextTraces, "linkModelInvocation");
    const recheckPrivacy = vi.spyOn(
      harness.runtime.projectContextPrivacy,
      "assertCurrentBeforeDispatch",
    );

    const requestId = harness.runtime.ids.next();
    const result = await generateCreativeOpening(harness.runtime, {
      idea: "旧车站在午夜多出一条不存在的站台。",
      requestId,
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
    });

    expect(saveTrace).toHaveBeenCalledOnce();
    expect(linkInvocation).toHaveBeenCalledOnce();
    expect(recheckPrivacy).toHaveBeenCalledTimes(3);
    expect(commitSkill).toHaveBeenCalledOnce();
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(result.noticeCode).toBeNull();
    expect(result).toMatchObject({
      source: "provider",
      providerId: "traceable-opening",
      modelId: "traceable-opening-model",
    });
    expect(typeof result.contextTraceId).toBe("string");
    expect(prepareSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: chapter.projectId,
        taskType: "book_start_guidance",
        invocationMode: "draft",
      }),
    );
    const committed = commitSkill.mock.calls[0]?.[0];
    expect(committed).toMatchObject({
      projectId: chapter.projectId,
      contextTraceId: result.contextTraceId,
      taskType: "book_start_guidance",
      invocationMode: "draft",
      preparation,
    });
    const trace = await harness.runtime.contextTraces.findById(result.contextTraceId ?? "missing");
    expect(trace).toMatchObject({
      id: result.contextTraceId,
      projectId: chapter.projectId,
      chapterId: chapter.id,
      taskType: "book_start_guidance",
      execution: {
        generationId: requestId,
        modelInvocationId: committed?.modelInvocationId,
      },
    });
    expect(saveTrace.mock.invocationCallOrder[0]).toBeLessThan(
      linkInvocation.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(linkInvocation.mock.invocationCallOrder[0]).toBeLessThan(
      recheckPrivacy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(recheckPrivacy.mock.invocationCallOrder[0]).toBeLessThan(
      commitSkill.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(commitSkill.mock.invocationCallOrder[0]).toBeLessThan(
      recheckPrivacy.mock.invocationCallOrder[1] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(recheckPrivacy.mock.invocationCallOrder[1]).toBeLessThan(
      harness.generate.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(harness.generate.mock.invocationCallOrder[0]).toBeLessThan(
      recheckPrivacy.mock.invocationCallOrder[2] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("fails before invocation when opening project context preparation fails", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-context-failure",
      catalogEntryId: "opening-context-failure-catalog",
      modelId: "opening-context-failure-model",
    });
    const requestId = "opening-context-failure-request";
    const preparationFailure = vi
      .spyOn(harness.runtime.projectSeeds, "findByProjectId")
      .mockRejectedValue(
        Object.assign(new Error("simulated project context read failure"), {
          code: "PROJECT_SEED_READ_FAILED",
        }),
      );

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "旧钟楼的影子在午夜指向了不存在的街道。",
        requestId,
        projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_SEED_READ_FAILED" });

    expect(preparationFailure).toHaveBeenCalledOnce();
    expect(harness.generate).not.toHaveBeenCalled();
    await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toBeNull();
  });

  it("records an empty provider response as a failed invocation without a local story", async () => {
    const harness = createNativeHarness();
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-empty-output",
      catalogEntryId: "opening-empty-output-catalog",
      modelId: "opening-empty-output-model",
    });
    const requestId = "opening-empty-output-request";
    harness.generate.mockResolvedValue({ text: "", usage: null });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "一张没有收件人的明信片每天都会换一句话。",
        requestId,
      }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_EMPTY", dispatched: true });

    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
    await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
      status: "failed",
      attempt: 1,
      errorCode: "MODEL_OUTPUT_EMPTY",
    });
  });

  it("keeps a dispatched network interruption pending for review and never retries", async () => {
    const harness = createNativeHarness();
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "openai",
      connectionId: "opening-ambiguous-provider",
      catalogEntryId: "opening-ambiguous-provider-catalog",
      modelId: "opening-ambiguous-provider-model",
    });
    const requestId = "opening-ambiguous-provider-request";
    harness.generate.mockRejectedValue(
      Object.assign(new Error("simulated connection loss after dispatch"), {
        code: "MODEL_NETWORK_INTERRUPTED",
        retryable: true,
      }),
    );

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "最后一班列车驶入了地图上不存在的站台。",
        requestId,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESULT_AMBIGUOUS",
      dispatched: true,
      retryable: false,
    });

    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
    await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
      status: "timed_out",
      attempt: 1,
      errorCode: "PROVIDER_RESULT_AMBIGUOUS",
    });
  });
  it("exposes only a sufficiently visible DeepSeek truncation as an explicit partial opening", async () => {
    const harness = createNativeHarness();
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "deepseek",
      connectionId: "opening-deepseek",
      catalogEntryId: "opening-deepseek-catalog",
      modelId: "deepseek-chat",
    });
    const visible = "可见的小说正文。".repeat(32);
    expect(visible.length).toBeGreaterThanOrEqual(MINIMUM_USABLE_PARTIAL_OPENING_CHARACTERS);
    harness.generate.mockImplementation((input) => {
      input.onDelta?.(visible);
      return Promise.reject(
        Object.assign(new Error("truncated"), { code: "MODEL_OUTPUT_TRUNCATED" }),
      );
    });

    const result = await generateCreativeOpening(harness.runtime, {
      idea: "停电后，只有影子仍在移动。",
      requestId: "deepseek-partial-opening",
    });

    expect(result).toEqual({
      requestId: "deepseek-partial-opening",
      text: visible,
      source: "provider",
      completion: "partial",
      providerId: "opening-deepseek",
      modelId: "deepseek-chat",
      noticeCode: "MODEL_OUTPUT_TRUNCATED",
      contextTraceId: null,
    });
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      reasoningMode: "disabled",
      maxOutputTokens: 1_200,
    });
  });

  it("rejects a short truncated opening without substituting a local story", async () => {
    const harness = createNativeHarness();
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "deepseek",
      connectionId: "opening-deepseek-short",
      catalogEntryId: "opening-deepseek-short-catalog",
      modelId: "deepseek-chat",
    });
    harness.generate.mockImplementation((input) => {
      input.onDelta?.("太短");
      return Promise.reject(
        Object.assign(new Error("truncated"), { code: "MODEL_OUTPUT_TRUNCATED" }),
      );
    });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "停电后，只有影子仍在移动。",
        requestId: "deepseek-short-opening",
      }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_TRUNCATED", dispatched: true });
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
  });

  it("fails closed before a remote provider receives a private opening workspace", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) throw privacy.error;
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "google_gemini",
      connectionId: "remote-private-opening",
      catalogEntryId: "remote-private-opening-catalog",
      modelId: "remote-private-opening-model",
    });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "这段灵感只能在本地处理。",
        requestId: "private-opening-request",
        projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_CHAPTER_LOCAL_ONLY", dispatched: false });
    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
    const versions = await harness.runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versions.ok && versions.value).toHaveLength(1);
  });

  it("discards a provider opening when another window changes the empty base version in flight", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "ollama",
      connectionId: "stale-opening",
      catalogEntryId: "stale-opening-catalog",
      modelId: "stale-opening-model",
      dataDestination: "local",
    });
    harness.generate.mockImplementation(async () => {
      const edited = await harness.runtime.useCases.editChapter.execute({
        chapterId: chapter.id,
        expectedRevision: chapter.revision,
        content: "A different window saved正文 while the opening was generating.",
        cursorOffset: 0,
      });
      if (!edited.ok) throw edited.error;
      const saved = await harness.runtime.useCases.saveChapter.execute({
        chapterId: chapter.id,
        expectedRevision: chapter.revision,
        reason: "manual",
      });
      if (!saved.ok) throw saved.error;
      return { text: "This stale opening must be discarded.", usage: null };
    });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "A station appears only after midnight.",
        requestId: harness.runtime.ids.next(),
        projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
      }),
    ).rejects.toMatchObject({ code: "CREATIVE_OPENING_WORKSPACE_CHANGED" });
    expect(harness.generate).toHaveBeenCalledOnce();
    await expectCandidateCount(harness.runtime, chapter.id, 0);
    const versions = await harness.runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versions.ok && versions.value).toHaveLength(2);
  });

  it("rejects Candidate persistence when an opening trace belongs to an older base version", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "ollama",
      connectionId: "candidate-trace-opening",
      catalogEntryId: "candidate-trace-opening-catalog",
      modelId: "candidate-trace-opening-model",
      dataDestination: "local",
    });
    harness.generate.mockResolvedValue({ text: "A traceable opening.", usage: null });
    const generated = await generateCreativeOpening(harness.runtime, {
      idea: "A locked archive begins answering questions.",
      requestId: harness.runtime.ids.next(),
      projectContext: { projectId: chapter.projectId, chapterId: chapter.id },
    });
    if (generated.contextTraceId === null) throw new Error("expected an opening trace");

    const edited = await harness.runtime.useCases.editChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      content: "正文 now has a newer immutable version.",
      cursorOffset: 0,
    });
    if (!edited.ok) throw edited.error;
    const saved = await harness.runtime.useCases.saveChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;

    const persisted = await persistCreativeOpeningCandidate(
      harness.runtime,
      chapter.id,
      generated.text,
      harness.runtime.ids.next(),
      false,
      generated.contextTraceId,
    );

    expect(persisted.ok).toBe(false);
    if (persisted.ok) throw new Error("expected a stale trace rejection");
    expect(persisted.error).toMatchObject({ code: "CONTEXT_TRACE_UNAVAILABLE" });
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("fails when only a legacy profile exists instead of inventing a local story", async () => {
    const harness = createNativeHarness();
    await seedLegacyProfile(harness.runtime, "legacy-opening", "legacy-opening-model");
    harness.listModels.mockResolvedValue({
      provider: "ollama",
      models: [{ id: "legacy-opening-model", displayName: "Legacy opening" }],
    });
    harness.generate.mockResolvedValue({ text: "旧配置生成的开头。", usage: null });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "一名学徒发现导师留下的密室",
        requestId: "legacy-opening-request",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_ROUTE_NOT_CONFIGURED", dispatched: false });
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("fails all three slots when no governed route exists without legacy calls", async () => {
    const harness = createNativeHarness();
    await seedVersionedModelHubBackedLegacyProfile(harness.runtime, {
      providerId: "versioned-opening",
      credentialProviderId: "model-key-opening-v2",
      selectedModel: "opening-model",
      retryLimit: 3,
    });
    harness.credentialSummary.mockImplementation((providerId: string) =>
      Promise.resolve({
        configured: providerId === "model-key-opening-v2",
        lastFour: providerId === "model-key-opening-v2" ? "2222" : null,
      }),
    );
    harness.listModels.mockResolvedValue({
      provider: "open_ai_compatible",
      models: [{ id: "opening-model", displayName: "Opening model" }],
    });
    harness.generate.mockImplementation((input) =>
      Promise.resolve({ text: `versioned opening ${input.generationId}`, usage: null }),
    );

    const requestIds = [
      "versioned-opening-slot-1",
      "versioned-opening-slot-2",
      "versioned-opening-slot-3",
    ];
    const results = await Promise.allSettled(
      requestIds.map((requestId) =>
        generateCreativeOpening(harness.runtime, {
          idea: "A letter arrives from a forgotten future.",
          requestId,
        }),
      ),
    );

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "fulfilled") throw new Error("缺少任务分工时不得返回本地故事。");
      expect(result.reason).toMatchObject({
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
        dispatched: false,
      });
    }
    expect(harness.credentialSummary).not.toHaveBeenCalled();
    expect(harness.credentialSummary).not.toHaveBeenCalledWith("versioned-opening");
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("never bypasses a failing opening route through a legacy profile", async () => {
    const harness = createNativeHarness();
    await seedLegacyProfile(harness.runtime, "unsafe-opening-legacy", "unsafe-opening-model");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "google_gemini",
      connectionId: "opening-policy-route",
      catalogEntryId: "opening-policy-catalog",
      modelId: "opening-policy-model",
      includeCapability: false,
    });

    await expect(
      generateCreativeOpening(harness.runtime, {
        idea: "被时间遗忘的小镇重新出现",
        requestId: "blocked-opening-request",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED", dispatched: false });
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("routes import rewriting through Model Hub and persists only an isolated candidate", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(
      harness.runtime,
      "原始正文必须保持不变。第二句也属于原文。",
    );
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "rewrite-gemini",
      catalogEntryId: "rewrite-gemini-catalog",
      modelId: "rewrite-gemini-model",
    });
    harness.generate.mockResolvedValue({ text: "这是 AI 建议的改写版本。", usage: null });
    const onBeforeDispatch = vi.fn();

    const result = await createImportRewriteCandidate(harness.runtime, {
      chapterId: chapter.id,
      instructions: ["让对话更自然"],
      mode: "trial",
      onBeforeDispatch,
    });

    expect(result).toMatchObject({
      providerId: "rewrite-gemini",
      modelId: "rewrite-gemini-model",
      rewrittenExcerpt: "这是 AI 建议的改写版本。",
    });
    expect(onBeforeDispatch).toHaveBeenCalledWith({
      requestId: result.requestId,
      providerId: "rewrite-gemini",
      modelId: "rewrite-gemini-model",
    });
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "rewrite-gemini", provider: "gemini" },
      model: "rewrite-gemini-model",
    });
    expect(result.candidate.content).toBe("这是 AI 建议的改写版本。");
    await expectStableChapter(
      harness.runtime,
      chapter.id,
      "原始正文必须保持不变。第二句也属于原文。",
    );
    await expectCandidateCount(harness.runtime, chapter.id, 1);
    expect(harness.listModels).not.toHaveBeenCalled();
  });

  it("fails closed when import rewriting only has a versioned legacy profile", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "Original chapter text remains stable.");
    await seedVersionedModelHubBackedLegacyProfile(harness.runtime, {
      providerId: "versioned-rewrite",
      credentialProviderId: "model-key-rewrite-v3",
      selectedModel: "rewrite-model",
    });
    harness.credentialSummary.mockImplementation((providerId: string) =>
      Promise.resolve({
        configured: providerId === "model-key-rewrite-v3",
        lastFour: providerId === "model-key-rewrite-v3" ? "3333" : null,
      }),
    );
    harness.listModels.mockResolvedValue({
      provider: "open_ai_compatible",
      models: [{ id: "rewrite-model", displayName: "Rewrite model" }],
    });
    harness.generate.mockResolvedValue({ text: "Rewritten candidate text.", usage: null });

    await expect(
      createImportRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        instructions: ["Make the dialogue more natural."],
        mode: "trial",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_ROUTE_NOT_CONFIGURED" });

    expect(harness.credentialSummary).not.toHaveBeenCalled();
    expect(harness.credentialSummary).not.toHaveBeenCalledWith("versioned-rewrite");
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "Original chapter text remains stable.");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("blocks private chapter rewriting before a remote provider receives any text", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(
      harness.runtime,
      "PRIVATE_REWRITE_TEXT_MUST_NEVER_REACH_REMOTE_PROVIDER",
    );
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) {
      throw privacy.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "remote-private-rewrite",
      catalogEntryId: "remote-private-rewrite-catalog",
      modelId: "remote-private-rewrite-model",
    });

    await expect(
      createImportRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        instructions: ["keep private"],
        mode: "trial",
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_CHAPTER_LOCAL_ONLY" });

    expect(harness.generate).not.toHaveBeenCalled();
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("rewrites an exact UTF-16 selection through Model Hub and keeps the fragment isolated until acceptance", async () => {
    const harness = createNativeHarness();
    const source = "开头🙂需要修改的段落。结尾保持不变。";
    const chapter = await createChapter(harness.runtime, source);
    const selectedText = "需要修改的段落。";
    const startUtf16 = source.indexOf(selectedText);
    const endUtf16 = startUtf16 + selectedText.length;
    const selectedHash = await harness.runtime.hasher.sha256(selectedText);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "selection-rewrite-gemini",
      catalogEntryId: "selection-rewrite-gemini-catalog",
      modelId: "selection-rewrite-gemini-model",
    });
    harness.generate.mockResolvedValue({ text: "这一段经过了自然改写。", usage: null });

    const result = await createConfirmedSelectionRewriteCandidate(harness.runtime, {
      chapterId: chapter.id,
      baseVersionId: chapter.currentVersionId,
      selection: {
        startUtf16,
        endUtf16,
        selectedTextSha256: selectedHash.value,
      },
      instruction: "保持原意，让表达更自然",
    });

    const expectedCandidate = source.replace(selectedText, "这一段经过了自然改写。");
    expect(result).toMatchObject({
      providerId: "selection-rewrite-gemini",
      modelId: "selection-rewrite-gemini-model",
      originalSelection: selectedText,
      rewrittenSelection: "这一段经过了自然改写。",
    });
    expect(result.candidate).toMatchObject({
      content: "这一段经过了自然改写。",
      baseVersionId: chapter.currentVersionId,
      status: "ready",
      applicationIntent: {
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16,
        endUtf16,
      },
    });
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "selection-rewrite-gemini", provider: "gemini" },
      model: "selection-rewrite-gemini-model",
    });
    const messages = harness.generate.mock.calls[0]?.[0].messages ?? [];
    expect(messages.map(({ content }) => content).join("\n")).toContain(selectedText);
    expect(messages.map(({ content }) => content).join("\n")).toContain("保持原意，让表达更自然");
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 1);

    const traceSummaries = await harness.runtime.contextTraces.listByProjectId(chapter.projectId);
    expect(traceSummaries[0]).toMatchObject({
      taskType: "rewrite",
      chapterId: chapter.id,
    });
    const trace = await harness.runtime.contextTraces.findById(traceSummaries[0]?.id ?? "missing");
    const traceSource = trace?.entries
      .find(({ layer }) => layer === "current_task")
      ?.sources.find(({ sourceType }) => sourceType === "chapter");
    expect(traceSource).toMatchObject({
      sourceType: "chapter",
      sourceId: chapter.id,
      sourceVersionId: chapter.currentVersionId,
      locator: `utf16:${String(startUtf16)}-${String(endUtf16)}:${String(source.length)}`,
      contentHash: selectedHash.value,
    });
    expect(trace).toMatchObject({
      id: result.contextTraceId,
      execution: {
        generationId: result.requestId,
        generationRunId: null,
      },
      outputCandidateId: result.candidate.id,
    });
    expect(typeof trace?.execution?.modelInvocationId).toBe("string");
    await expect(
      harness.runtime.contextTraces.findByOutputCandidateId(result.candidate.id),
    ).resolves.toMatchObject({ id: result.contextTraceId });

    const accepted = await harness.runtime.useCases.acceptCandidate.execute({
      candidateId: result.candidate.id,
      expectedCandidateRevision: result.candidate.revision,
    });
    if (!accepted.ok) {
      throw accepted.error;
    }
    expect(accepted.value.chapter.content).toBe(expectedCandidate);
    expect(accepted.value.version.toSnapshot()).toMatchObject({
      reason: "candidate_accept",
      sourceCandidateId: result.candidate.id,
    });
  });

  it("rejects a stale selection hash before the rewrite provider receives any text", async () => {
    const harness = createNativeHarness();
    const source = "选中的原文不会被猜测。";
    const chapter = await createChapter(harness.runtime, source);
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "stale-selection-rewrite",
      catalogEntryId: "stale-selection-rewrite-catalog",
      modelId: "stale-selection-rewrite-model",
    });

    await expect(
      createConfirmedSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: "0".repeat(64),
        },
        instruction: "保持原意",
      }),
    ).rejects.toMatchObject({ code: "SELECTION_REWRITE_SOURCE_CHANGED" });

    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("fails closed when the selection rewrite context trace cannot be saved", async () => {
    const harness = createNativeHarness();
    const source = "上下文来源必须先于模型发送保存。";
    const chapter = await createChapter(harness.runtime, source);
    const selectedHash = await harness.runtime.hasher.sha256(source);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "trace-selection-rewrite",
      catalogEntryId: "trace-selection-rewrite-catalog",
      modelId: "trace-selection-rewrite-model",
    });
    vi.spyOn(harness.runtime.contextTraces, "save").mockRejectedValueOnce(
      new Error("trace unavailable"),
    );

    await expect(
      createConfirmedSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: selectedHash.value,
        },
        instruction: "保持原意",
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_UNAVAILABLE" });

    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("keeps a selection rewrite unpersisted when the atomic Candidate/trace commit fails", async () => {
    const harness = createNativeHarness();
    const source = "原子提交失败时稳定正文不能改变。";
    const chapter = await createChapter(harness.runtime, source);
    const selectedHash = await harness.runtime.hasher.sha256(source);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "atomic-selection-rewrite",
      catalogEntryId: "atomic-selection-rewrite-catalog",
      modelId: "atomic-selection-rewrite-model",
    });
    harness.generate.mockResolvedValue({ text: "这段结果不应成为可接受建议。", usage: null });
    const commit = vi
      .spyOn(harness.runtime.contextTraceOutputs, "commit")
      .mockRejectedValueOnce(new Error("simulated atomic commit failure"));

    await expect(
      createConfirmedSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: selectedHash.value,
        },
        instruction: "保持原意",
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_UNAVAILABLE" });

    expect(commit).toHaveBeenCalledOnce();
    const commitInput = commit.mock.calls[0]?.[0];
    expect(typeof commitInput?.traceId).toBe("string");
    expect(commitInput?.candidate.status).toBe("ready");
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("discards a selection rewrite result when the base version changes during provider execution", async () => {
    const harness = createNativeHarness();
    const source = "模型调用期间可能被其他窗口修改。";
    const chapter = await createChapter(harness.runtime, source);
    const selectedHash = await harness.runtime.hasher.sha256(source);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "drift-selection-rewrite",
      catalogEntryId: "drift-selection-rewrite-catalog",
      modelId: "drift-selection-rewrite-model",
    });
    harness.generate.mockImplementation(async () => {
      const edited = await harness.runtime.useCases.editChapter.execute({
        chapterId: chapter.id,
        expectedRevision: chapter.revision,
        content: "其他窗口已保存的新正文。",
        cursorOffset: 0,
      });
      if (!edited.ok) {
        throw edited.error;
      }
      const saved = await harness.runtime.useCases.saveChapter.execute({
        chapterId: chapter.id,
        expectedRevision: chapter.revision,
        reason: "manual",
      });
      if (!saved.ok) {
        throw saved.error;
      }
      return { text: "不应保存的过期改写。", usage: null };
    });

    await expect(
      createConfirmedSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: selectedHash.value,
        },
        instruction: "改写得更自然",
      }),
    ).rejects.toMatchObject({ code: "SELECTION_REWRITE_SOURCE_CHANGED" });

    expect(harness.generate).toHaveBeenCalledOnce();
    await expectStableChapter(harness.runtime, chapter.id, "其他窗口已保存的新正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("blocks private selection rewrite before remote generation or reranking receives text", async () => {
    const harness = createNativeHarness();
    const source = "PRIVATE_SELECTION_REWRITE_MUST_NOT_LEAVE_DEVICE";
    const chapter = await createChapter(harness.runtime, source);
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) {
      throw privacy.error;
    }
    const selectedHash = await harness.runtime.hasher.sha256(source);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "remote-private-selection-rewrite",
      catalogEntryId: "remote-private-selection-rewrite-catalog",
      modelId: "remote-private-selection-rewrite-model",
    });
    const rerankSpy = vi.spyOn(harness.runtime.rerank, "tryRerank");

    await expect(
      createConfirmedSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: selectedHash.value,
        },
        instruction: "keep private",
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_CHAPTER_LOCAL_ONLY" });

    expect(harness.generate).not.toHaveBeenCalled();
    expect(rerankSpy).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("fails closed when rewrite only has a legacy profile", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "等待旧配置改写的原文。");
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) {
      throw privacy.error;
    }
    await seedLegacyProfile(harness.runtime, "legacy-rewrite", "legacy-rewrite-model");
    harness.listModels.mockResolvedValue({
      provider: "ollama",
      models: [{ id: "legacy-rewrite-model", displayName: "Legacy rewrite" }],
    });
    harness.generate.mockResolvedValue({ text: "旧链生成的建议版本。", usage: null });
    const onBeforeDispatch = vi.fn();

    await expect(
      createImportRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        instructions: ["节奏更快"],
        mode: "trial",
        onBeforeDispatch,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_ROUTE_NOT_CONFIGURED" });

    expect(onBeforeDispatch).not.toHaveBeenCalled();
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "等待旧配置改写的原文。");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("never bypasses a failing rewrite route through a legacy profile", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "隐私策略保护的改写原文。");
    await seedLegacyProfile(harness.runtime, "unsafe-rewrite-legacy", "unsafe-rewrite-model");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "rewrite-policy-route",
      catalogEntryId: "rewrite-policy-catalog",
      modelId: "rewrite-policy-model",
      includeCapability: false,
    });

    await expect(
      createImportRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        instructions: ["保持原意"],
        mode: "trial",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED" });
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "隐私策略保护的改写原文。");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("routes editor continuation through Model Hub and persists an isolated candidate", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "编辑器中的稳定正文。");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "anthropic_claude",
      connectionId: "continuation-claude",
      catalogEntryId: "continuation-claude-catalog",
      modelId: "continuation-claude-model",
    });
    harness.generate.mockResolvedValue({ text: "模型续写的新段落。", usage: null });

    const result = await createConfiguredModelCandidate(harness.runtime, chapter.id);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      content: "\n\n模型续写的新段落。",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: {
        providerId: "continuation-claude",
        provider: "anthropic",
      },
      model: "continuation-claude-model",
    });
    expect(harness.generate.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
    const directTrace = await harness.runtime.contextTraces.findByOutputCandidateId(
      result.value.id,
    );
    expect(directTrace).toMatchObject({ outputCandidateId: result.value.id });
    expect(typeof directTrace?.execution?.generationRunId).toBe("string");
    expect(typeof directTrace?.execution?.modelInvocationId).toBe("string");
    await expectStableChapter(harness.runtime, chapter.id, "编辑器中的稳定正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 1);
  });

  it("blocks private editor continuation before a remote provider receives text", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(
      harness.runtime,
      "PRIVATE_CONTINUATION_TEXT_MUST_NEVER_REACH_REMOTE_PROVIDER",
    );
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) {
      throw privacy.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "anthropic_claude",
      connectionId: "remote-private-continuation",
      catalogEntryId: "remote-private-continuation-catalog",
      modelId: "remote-private-continuation-model",
    });

    const result = await createConfiguredModelCandidate(harness.runtime, chapter.id);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PRIVATE_CHAPTER_LOCAL_ONLY" },
    });
    expect(harness.generate).not.toHaveBeenCalled();
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("uses Model Hub in the editor's governed preflight and execution path", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "生成治理链路中的稳定正文。");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "google_gemini",
      connectionId: "governed-continuation",
      catalogEntryId: "governed-continuation-catalog",
      modelId: "governed-continuation-model",
    });
    harness.generate.mockResolvedValue({
      text: "通过治理链路生成的新段落。",
      usage: { inputTokens: 300, outputTokens: 40, cachedInputTokens: null },
    });

    const plan = await prepareGenerationPlan(harness.runtime, chapter.id, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(plan).toMatchObject({
      executionMode: "model_hub",
      providerId: "governed-continuation",
      modelId: "governed-continuation-model",
      routeReason: "model_hub_primary",
      profile: null,
    });
    expect(plan.preflight.canStart).toBe(true);
    expect(plan.contextCompilation?.compiled.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "current_task", included: true }),
        expect.objectContaining({ layer: "recent_events", included: true }),
      ]),
    );
    const result = await executeGenerationPlan(harness.runtime, plan);
    if (!result.ok || result.value.candidate === null) {
      throw result.ok ? new Error("expected a candidate") : result.error;
    }
    expect(result.value.candidate.content).toContain("通过治理链路生成的新段落。");
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "governed-continuation" },
      model: "governed-continuation-model",
    });
    await expect(
      harness.runtime.contextTraces.findByOutputCandidateId(result.value.candidate.id),
    ).resolves.toMatchObject({
      id: plan.contextTraceId,
      execution: {
        generationId: plan.generationId,
        generationRunId: plan.runId,
      },
      outputCandidateId: result.value.candidate.id,
    });
    const governedTrace = await harness.runtime.contextTraces.findByOutputCandidateId(
      result.value.candidate.id,
    );
    expect(typeof governedTrace?.execution?.modelInvocationId).toBe("string");
    expect(harness.listModels).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "生成治理链路中的稳定正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 1);
  });

  it("never bypasses a failing continuation route through a legacy profile", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "不可绕过策略的正文。");
    await seedLegacyProfile(
      harness.runtime,
      "unsafe-continuation-legacy",
      "unsafe-continuation-model",
    );
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "anthropic_claude",
      connectionId: "continuation-policy-route",
      catalogEntryId: "continuation-policy-catalog",
      modelId: "continuation-policy-model",
      includeCapability: false,
    });

    const result = await createConfiguredModelCandidate(harness.runtime, chapter.id);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected continuation policy failure");
    }
    expect(result.error).toMatchObject({ code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED" });
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "不可绕过策略的正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("returns no direct continuation Candidate when its atomic trace commit fails", async () => {
    const harness = createNativeHarness();
    const source = "直接续写的稳定正文。";
    const chapter = await createChapter(harness.runtime, source);
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "google_gemini",
      connectionId: "atomic-direct-continuation",
      catalogEntryId: "atomic-direct-continuation-catalog",
      modelId: "atomic-direct-continuation-model",
    });
    harness.generate.mockResolvedValue({ text: "不应落库的续写结果。", usage: null });
    vi.spyOn(harness.runtime.contextTraceOutputs, "commit").mockRejectedValueOnce(
      new Error("simulated atomic commit failure"),
    );

    const result = await createConfiguredModelCandidate(harness.runtime, chapter.id);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected atomic context-output commit failure");
    }
    expect(result.error).toMatchObject({ code: "CONTEXT_TRACE_UNAVAILABLE" });
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });
});

async function createConfirmedSelectionRewriteCandidate(
  runtime: DesktopRuntime,
  input: Omit<SelectionRewriteCandidateInput, "humanConfirmed" | "disclosureFingerprint">,
) {
  const disclosure = await prepareSelectionRewrite(runtime, input);
  return createSelectionRewriteCandidate(runtime, {
    ...input,
    humanConfirmed: true,
    disclosureFingerprint: disclosure.fingerprint,
  });
}

function nextOpeningRequestIds(runtime: DesktopRuntime, count: number): readonly string[] {
  return Object.freeze(Array.from({ length: count }, () => runtime.ids.next()));
}

function createNativeHarness(): Readonly<{
  runtime: DesktopRuntime;
  generate: ReturnType<typeof vi.fn<NativeModelGatewayClient["generate"]>>;
  listModels: ReturnType<typeof vi.fn<NativeModelGatewayClient["listModels"]>>;
  credentialSummary: ReturnType<typeof vi.fn<CredentialStore["getSummary"]>>;
}> {
  const developmentRuntime = createDevelopmentRuntime(new MemoryStorage());
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  const listModels = vi.fn<NativeModelGatewayClient["listModels"]>();
  const credentialSummary = vi
    .fn<CredentialStore["getSummary"]>()
    .mockResolvedValue({ configured: true, lastFour: "1234" });
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    generate,
    listModels,
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    cancelGeneration: () => Promise.resolve(false),
  };
  return Object.freeze({
    generate,
    listModels,
    credentialSummary,
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
      credentials: {
        getSummary: credentialSummary,
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    },
  });
}

async function seedVersionedModelHubBackedLegacyProfile(
  runtime: DesktopRuntime,
  input: Readonly<{
    providerId: string;
    credentialProviderId: string;
    selectedModel: string;
    retryLimit?: number;
  }>,
): Promise<void> {
  await runtime.modelCenter.save({
    providerId: input.providerId,
    provider: "open_ai_compatible",
    baseUrl: "https://legacy.example/v1",
    authentication: "bearer_keyring",
    selectedModel: input.selectedModel,
    expectedRevision: null,
  });
  await runtime.modelHub.saveConnection({
    id: input.providerId,
    providerKind: "openai",
    displayName: input.providerId,
    credentialRef: `keyring:model-hub:${input.credentialProviderId}`,
    credentialState: "present",
    ...(input.retryLimit === undefined ? {} : { retryLimit: input.retryLimit }),
    expectedRevision: null,
  });
}

async function seedModelHubTextRoute(
  modelHub: ModelHubStore,
  input: Readonly<{
    task: NovelAiTask;
    providerKind: ModelProviderKind;
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
    includeCapability?: boolean;
    dataDestination?: "local" | "remote";
    pricing?: "known_zero" | "unknown";
    routeOrigin?: "automatic" | "user";
    routeGenerationVersion?: string;
    lifecycle?: "stable" | "preview" | "deprecated" | "unknown";
  }>,
): Promise<void> {
  const connection = await modelHub.saveConnection({
    id: input.connectionId,
    providerKind: input.providerKind,
    displayName: input.connectionId,
    credentialRef: `keyring:model-hub:${input.connectionId}`,
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await modelHub.syncCatalog({
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
        staleAfter: "2027-08-02T00:00:00.000Z",
      },
    ],
  });
  if (input.includeCapability !== false) {
    await modelHub.recordCapabilityScan({
      scanId: `${input.connectionId}-scan`,
      catalogEntryId: input.catalogEntryId,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "creative-chain-test-v1",
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
    catalogEntryId: input.catalogEntryId,
    currency: input.pricing === "unknown" ? null : "USD",
    inputMicrosPerMillionTokens: input.pricing === "unknown" ? null : "0",
    outputMicrosPerMillionTokens: input.pricing === "unknown" ? null : "0",
    cachedInputMicrosPerMillionTokens: input.pricing === "unknown" ? null : "0",
    pricingVersion: input.pricing === "unknown" ? null : "creative-chain-zero-cost-v1",
    priceUpdatedAt: input.pricing === "unknown" ? null : "2026-08-01T00:00:00.000Z",
    dataDestination: input.dataDestination ?? "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "creative-chain-test-v1",
    expectedRevision: null,
  });
  const routeOrigin = input.routeOrigin ?? "user";
  if (routeOrigin === "automatic") {
    await modelHub.savePreset({
      id: "automatic-smart",
      scheme: "smart",
      displayName: "智能推荐",
      status: "active",
      privacyPolicy: "cloud_allowed",
      costPriority: "balanced",
      routeGenerationVersion:
        input.routeGenerationVersion ?? MODEL_HUB_AUTOMATIC_ROUTE_GENERATION_VERSION,
      expectedRevision: null,
    });
  }
  await modelHub.saveTaskRoute({
    task: input.task,
    primaryCatalogEntryId: input.catalogEntryId,
    presetId: routeOrigin === "automatic" ? "automatic-smart" : null,
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin,
    expectedRevision: null,
  });
}

async function changeModelHubPricing(
  modelHub: ModelHubStore,
  catalogEntryId: string,
): Promise<void> {
  const current = await modelHub.findCostPrivacyProfile(catalogEntryId);
  if (current === null) throw new Error("expected a cost/privacy profile");
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId,
    currency: "USD",
    inputMicrosPerMillionTokens: "1000000",
    outputMicrosPerMillionTokens: "2000000",
    cachedInputMicrosPerMillionTokens: "500000",
    pricingVersion: "creative-chain-drifted-cost-v2",
    priceUpdatedAt: "2026-08-02T00:00:00.000Z",
    dataDestination: current.dataDestination,
    retentionPolicy: current.retentionPolicy,
    trainingPolicy: current.trainingPolicy,
    evidenceSource: current.evidenceSource,
    evidenceVersion: "creative-chain-drifted-cost-v2",
    expectedRevision: current.revision,
  });
}

async function changeModelHubRoute(
  modelHub: ModelHubStore,
  task: NovelAiTask,
  catalogEntryId: string,
): Promise<void> {
  const current = await modelHub.findTaskRoute(task);
  if (current === null) throw new Error("expected a task route");
  await modelHub.saveTaskRoute({
    task,
    primaryCatalogEntryId: catalogEntryId,
    privacyPolicy: current.privacyPolicy,
    failurePolicy: current.failurePolicy,
    routeOrigin: current.routeOrigin,
    expectedRevision: current.revision,
  });
}

async function seedLegacyProfile(
  runtime: DesktopRuntime,
  providerId: string,
  selectedModel: string,
): Promise<void> {
  await runtime.modelCenter.save({
    providerId,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    authentication: "none",
    selectedModel,
    expectedRevision: null,
  });
}

async function createChapter(runtime: DesktopRuntime, content: string) {
  const project = await runtime.useCases.createProject.execute({ name: "Model Hub 创作链验收" });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content,
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return chapter.value.chapter;
}

async function expectStableChapter(
  runtime: DesktopRuntime,
  chapterId: Parameters<DesktopRuntime["repositories"]["chapters"]["findById"]>[0],
  expectedContent: string,
): Promise<void> {
  const chapter = await runtime.repositories.chapters.findById(chapterId);
  expect(chapter.ok && chapter.value?.content).toBe(expectedContent);
}

async function expectCandidateCount(
  runtime: DesktopRuntime,
  chapterId: Parameters<DesktopRuntime["repositories"]["chapters"]["findById"]>[0],
  expectedCount: number,
): Promise<void> {
  const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapterId);
  expect(candidates.ok && candidates.value).toHaveLength(expectedCount);
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
