import { describe, expect, it, vi } from "vitest";
import { createProjectSeed, updateProjectSeedField } from "@inkshadow/domain";

import { ModelCenterError } from "./model-center-store";
import {
  canDeferGenerationPlan,
  cancelGenerationPlan,
  createDevelopmentRuntime,
  executeGenerationPlan,
  prepareGenerationPlan,
  saveDeferredGenerationPlan,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "./runtime";

describe("governed generation runtime", () => {
  it("includes confirmed ProjectSeed guidance in the real continuation context", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) {
      throw new Error("Expected the generated test chapter.");
    }
    const now = runtime.clock.now();
    let seed = createProjectSeed({
      seedId: runtime.ids.next(),
      journeyKind: "idea",
      premise: "在永夜港寻找失踪的姐姐。",
      now,
    });
    seed = updateProjectSeedField(seed, "boundaries", {
      values: ["禁止死者复生。"],
      source: "user_input",
      confirmation: "confirmed",
      origin: "author-boundaries",
      updatedAt: now,
    });
    seed = updateProjectSeedField(seed, "world", {
      values: ["潮雾会吞没无人看守的灯塔。"],
      source: "ai_inference",
      confirmation: "unconfirmed",
      origin: "ai-opening",
      updatedAt: now,
    });
    await runtime.projectSeeds.saveForProject(chapter.value.projectId, seed);

    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const boundaryEntry = plan.contextCompilation?.compiled.entries.find(({ id }) =>
      id.includes(":boundaries:"),
    );
    expect(boundaryEntry).toMatchObject({
      layer: "locked_hard_rules",
      included: true,
      required: true,
    });
    const prompt = plan.messages.map(({ content }) => content).join("\n");
    expect(prompt).toContain("禁止死者复生。");
    expect(prompt).not.toContain("潮雾会吞没无人看守的灯塔");
  });

  it("blocks missing price metadata and exposes a source-backed estimate after configuration", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    await runtime.modelCenter.save({
      providerId: "local-ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: "writer-model",
      pricing: null,
      expectedRevision: 1,
    });

    const blocked = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: false,
    });
    expect(blocked.preflight.canStart).toBe(false);
    expect(blocked.preflight.checks.map(({ code }) => code)).toContain("MODEL_PRICING_MISSING");

    await runtime.modelCenter.save({
      providerId: "local-ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: "writer-model",
      pricing: localPricing(),
      expectedRevision: 2,
    });
    const ready = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: false,
    });
    expect(ready.preflight.canStart).toBe(true);
    expect(ready.preflight.estimate).toMatchObject({
      micros: 0n,
      pricingVersion: "local-zero-cost",
    });
    expect(ready.tokenEstimateSource).toBe("utf8_conservative");
  });

  it("charges and invokes the model once when the same prepared request is replayed", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((request) => {
      request.onDelta?.("候选续写。");
      return Promise.resolve(generationResult("候选续写。", 120, 24));
    });
    const { runtime, chapterId } = await createNativeRuntime(generate);
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const first = await executeGenerationPlan(runtime, plan);
    const second = await executeGenerationPlan(runtime, plan);

    expect(first.ok && first.value).toMatchObject({ cancelled: false, reused: false });
    expect(second.ok && second.value).toMatchObject({ cancelled: false, reused: true });
    expect(generate).toHaveBeenCalledTimes(1);
    const run = await runtime.generationGovernance.findRunById(plan.runId);
    expect(run).toMatchObject({
      state: "completed",
      incurredCostMicros: plan.preflight.estimate?.micros.toString(),
    });
    await expect(runtime.generationGovernance.listAttemptUsage(plan.runId)).resolves.toEqual([
      expect.objectContaining({
        source: "provider_reported",
        inputTokens: 120,
        outputTokens: 24,
        usagePricedEstimateMicros: "0",
      }),
    ]);
    const tasks = await runtime.taskCenter.load();
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]).toMatchObject({
      id: plan.taskId,
      status: "succeeded",
      progress: { step: "candidate.finalized", completedUnits: 5 },
    });
    expect(tasks.notifications).toHaveLength(1);
    expect(tasks.notifications[0]).toMatchObject({
      messageKey: "task.completed",
      status: "visible",
      severity: "success",
    });
  });

  it("acknowledges cancellation and retains partial output as an incomplete candidate", async () => {
    let rejectGeneration: ((error: ModelCenterError) => void) | null = null;
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(
      (request) =>
        new Promise<Awaited<ReturnType<NativeModelGatewayClient["generate"]>>>(
          (_resolve, reject) => {
            request.onDelta?.("尚未完成的候选");
            rejectGeneration = reject;
          },
        ),
    );
    const cancelGeneration = vi.fn<NativeModelGatewayClient["cancelGeneration"]>(() => {
      rejectGeneration?.(
        new ModelCenterError("MODEL_GENERATION_CANCELLED", "Model generation was cancelled.", true),
      );
      return Promise.resolve(true);
    });
    const { runtime, chapterId } = await createNativeRuntime(generate, cancelGeneration);
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const execution = executeGenerationPlan(runtime, plan);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await expect(cancelGenerationPlan(runtime, plan)).resolves.toBe(true);
    const result = await execution;

    if (!result.ok || result.value.candidate === null) {
      throw new Error("Expected an incomplete candidate.");
    }
    expect(result.value.cancelled).toBe(true);
    expect(result.value.candidate.status).toBe("ready");
    expect(result.value.candidate.toSnapshot().incomplete).toBe(true);
    expect(result.value.candidate.content).toContain("尚未完成的候选");
    await expect(runtime.taskCenter.load()).resolves.toMatchObject({
      tasks: [{ id: plan.taskId, status: "cancelled" }],
      notifications: [{ messageKey: "task.cancelled", status: "visible" }],
    });
    await expect(runtime.generationGovernance.findRunById(plan.runId)).resolves.toMatchObject({
      state: "cancelled",
      candidateId: result.value.candidate.id,
    });
  });

  it("reuses a persisted retryable run and accumulates the next attempt estimate", async () => {
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockRejectedValueOnce(
        new ModelCenterError("MODEL_TIMEOUT", "Model generation timed out.", true),
      )
      .mockResolvedValueOnce(generationResult("重试后的候选。", 80, 20));
    const { runtime, chapterId } = await createNativeRuntime(generate);
    const current = await runtime.modelCenter.findByProviderId("local-ollama");
    if (current === null) {
      throw new Error("Expected a model profile.");
    }
    await runtime.modelCenter.save({
      providerId: current.providerId,
      provider: current.provider,
      baseUrl: current.baseUrl,
      authentication: current.authentication,
      selectedModel: current.selectedModel,
      pricing: {
        ...localPricing(),
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        pricingVersion: "paid-test",
      },
      expectedRevision: current.revision,
    });
    const firstPlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    const first = await executeGenerationPlan(runtime, firstPlan);
    expect(first.ok).toBe(false);
    await new Promise((resolve) => window.setTimeout(resolve, 1_050));

    const retryPlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    expect(retryPlan.taskId).toBe(firstPlan.taskId);
    expect(retryPlan.runId).toBe(firstPlan.runId);
    expect(retryPlan.idempotencyKey).toBe(firstPlan.idempotencyKey);
    const retry = await executeGenerationPlan(runtime, retryPlan);

    if (!retry.ok) {
      throw retry.error;
    }
    expect(generate).toHaveBeenCalledTimes(2);
    const run = await runtime.generationGovernance.findRunById(firstPlan.runId);
    expect(run).toMatchObject({ state: "completed", attempt: 2 });
    const estimate = firstPlan.preflight.estimate;
    if (estimate === null) {
      throw new Error("Expected a priced generation plan.");
    }
    expect(run?.incurredCostMicros).toBe((estimate.micros * 2n).toString());
    await expect(runtime.generationGovernance.listAttemptUsage(firstPlan.runId)).resolves.toEqual([
      expect.objectContaining({ attempt: 1, source: "provider_unavailable" }),
      expect.objectContaining({
        attempt: 2,
        source: "provider_reported",
        inputTokens: 80,
        outputTokens: 20,
      }),
    ]);
  });

  it("persists an offline cloud request without prompt text and consumes it after fresh confirmation", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await developmentRuntime.useCases.createProject.execute({
      name: "离线待执行测试",
    });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await developmentRuntime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "不能写入待执行记录的稳定正文。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    await developmentRuntime.modelCenter.save({
      providerId: "remote-writer",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example/v1",
      authentication: "none",
      selectedModel: "writer-model",
      pricing: {
        ...localPricing(),
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        pricingVersion: "remote-test",
      },
      expectedRevision: null,
    });
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve(generationResult("联网后的候选。", 100, 20)),
    );
    const modelGateway: NativeModelGatewayClient = {
      available: true,
      listModels: () =>
        Promise.resolve({
          provider: "open_ai_compatible",
          models: [{ id: "writer-model", displayName: "Writer model" }],
        }),
      checkConnection: () => Promise.reject(new Error("not used")),
      embed: () => Promise.reject(new Error("not used")),
      generate,
      cancelGeneration: () => Promise.resolve(true),
    };
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
    };

    const offlinePlan = await prepareGenerationPlan(runtime, chapter.value.chapter.id, {
      chapterSaved: true,
      networkAvailable: false,
    });
    expect(offlinePlan.preflight.checks.map(({ code }) => code)).toContain("NETWORK_OFFLINE");
    expect(canDeferGenerationPlan(offlinePlan)).toBe(true);
    const deferred = await saveDeferredGenerationPlan(runtime, offlinePlan);
    expect(deferred).toMatchObject({ status: "waiting_network", modelRole: "high_quality" });
    const serialized = window.localStorage.getItem(
      "inkshadow.development.generation-governance.v1",
    );
    expect(serialized).not.toMatch(/不能写入待执行记录|章节标题|当前正文|prompt|messages/iu);

    const onlinePlan = await prepareGenerationPlan(runtime, chapter.value.chapter.id, {
      chapterSaved: true,
      networkAvailable: true,
    });
    expect(onlinePlan.preflight.canStart).toBe(true);
    expect(onlinePlan.deferredRequest?.id).toBe(deferred.id);
    const executed = await executeGenerationPlan(runtime, onlinePlan);
    if (!executed.ok) {
      throw executed.error;
    }
    expect(generate).toHaveBeenCalledOnce();
    await expect(
      runtime.generationGovernance.findWaitingDeferredRequest(
        chapter.value.chapter.id,
        "high_quality",
      ),
    ).resolves.toBeNull();
    const tasks = await runtime.taskCenter.load();
    expect(tasks.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ai.generate.deferred", status: "cancelled" }),
        expect.objectContaining({ type: "ai.generate", status: "succeeded" }),
      ]),
    );
  });

  it("selects only the exact verified fallback and marks it for explicit confirmation", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    await runtime.modelCenter.save({
      providerId: "remote-primary",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example/v1",
      authentication: "none",
      selectedModel: "missing-primary-model",
      pricing: {
        ...localPricing(),
        pricingVersion: "remote-primary-test",
      },
      expectedRevision: null,
    });
    await runtime.modelRouting.saveRoute({
      role: "high_quality",
      primaryProviderId: "remote-primary",
      fallbackProviderId: "local-ollama",
      expectedRevision: null,
    });

    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(plan).toMatchObject({
      providerId: "local-ollama",
      modelId: "writer-model",
      modelRole: "high_quality",
      routeReason: "role_fallback",
      routeRequiresConfirmation: true,
      routeFallback: {
        providerId: "local-ollama",
        modelId: "writer-model",
      },
    });
    expect(plan.preflight.canStart).toBe(true);
  });

  it("invalidates a deferred request when the stable chapter version changes", async () => {
    const { runtime, chapterId, chapterRevision } = await createRemoteRuntime();
    const offlinePlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: false,
    });
    const deferred = await saveDeferredGenerationPlan(runtime, offlinePlan);

    const edited = await runtime.useCases.editChapter.execute({
      chapterId,
      expectedRevision: chapterRevision,
      content: "Stable content changed after the offline approval.",
      cursorOffset: 50,
    });
    if (!edited.ok) {
      throw edited.error;
    }
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId,
      expectedRevision: chapterRevision,
      reason: "manual",
    });
    if (!saved.ok) {
      throw saved.error;
    }

    const freshPlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(freshPlan.deferredRequest).toBeNull();
    expect(freshPlan.idempotencyKey).not.toBe(`ai.generate.resume:${deferred.id}`);
    await expect(
      runtime.generationGovernance.findWaitingDeferredRequest(chapterId, "high_quality"),
    ).resolves.toBeNull();
    const tasks = await runtime.taskCenter.load();
    expect(tasks.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: deferred.taskId,
          type: "ai.generate.deferred",
          status: "cancelled",
        }),
      ]),
    );
    const serialized = window.localStorage.getItem(
      "inkshadow.development.generation-governance.v1",
    );
    expect(serialized).toContain('"status":"blocked_stale"');
    expect(serialized).not.toContain("Stable content changed after the offline approval.");
  });
});

async function createNativeRuntime(
  generate: NativeModelGatewayClient["generate"] = () =>
    Promise.resolve(generationResult("候选续写。", 100, 20)),
  cancelGeneration: NativeModelGatewayClient["cancelGeneration"] = () => Promise.resolve(true),
): Promise<{ runtime: DesktopRuntime; chapterId: Parameters<typeof prepareGenerationPlan>[1] }> {
  const developmentRuntime = createDevelopmentRuntime(window.localStorage);
  const project = await developmentRuntime.useCases.createProject.execute({
    name: "生成治理测试",
  });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await developmentRuntime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "稳定正文。",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  await developmentRuntime.modelCenter.save({
    providerId: "local-ollama",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    authentication: "none",
    selectedModel: "writer-model",
    pricing: localPricing(),
    expectedRevision: null,
  });
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    listModels: () =>
      Promise.resolve({
        provider: "ollama",
        models: [{ id: "writer-model", displayName: "Writer model" }],
      }),
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    generate,
    cancelGeneration,
  };
  return {
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
    },
    chapterId: chapter.value.chapter.id,
  };
}

function generationResult(text: string, inputTokens: number, outputTokens: number) {
  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: null,
    },
  } as const;
}

async function createRemoteRuntime(): Promise<{
  runtime: DesktopRuntime;
  chapterId: Parameters<typeof prepareGenerationPlan>[1];
  chapterRevision: number;
}> {
  const developmentRuntime = createDevelopmentRuntime(window.localStorage);
  const project = await developmentRuntime.useCases.createProject.execute({
    name: "Deferred request stale-base test",
  });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await developmentRuntime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "Chapter one",
    content: "Initial stable content.",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  await developmentRuntime.modelCenter.save({
    providerId: "remote-writer",
    provider: "open_ai_compatible",
    baseUrl: "https://models.example/v1",
    authentication: "none",
    selectedModel: "writer-model",
    pricing: {
      ...localPricing(),
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 2_000_000,
      pricingVersion: "remote-test",
    },
    expectedRevision: null,
  });
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    listModels: () =>
      Promise.resolve({
        provider: "open_ai_compatible",
        models: [{ id: "writer-model", displayName: "Writer model" }],
      }),
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    generate: () => Promise.resolve(generationResult("Freshly generated candidate.", 100, 20)),
    cancelGeneration: () => Promise.resolve(true),
  };
  return {
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
    },
    chapterId: chapter.value.chapter.id,
    chapterRevision: chapter.value.chapter.revision,
  };
}

function localPricing() {
  return {
    contextWindowTokens: 32_000,
    currency: "USD",
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "local-zero-cost",
    priceUpdatedAt: "2026-07-27T00:00:00.000Z",
  } as const;
}
