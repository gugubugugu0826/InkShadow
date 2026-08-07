import { describe, expect, it, vi } from "vitest";

import { generateCreativeOpening } from "./creative-opening-service";
import { createImportRewriteCandidate } from "./import-rewrite-service";
import type { ModelProviderKind, NovelAiTask } from "./model-hub-provider-registry";
import type { ModelHubStore } from "./model-hub-store";
import {
  createConfiguredModelCandidate,
  createDevelopmentRuntime,
  executeGenerationPlan,
  prepareGenerationPlan,
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

  it("keeps the legacy opening profile working only when no Model Hub route exists", async () => {
    const harness = createNativeHarness();
    await seedLegacyProfile(harness.runtime, "legacy-opening", "legacy-opening-model");
    harness.listModels.mockResolvedValue({
      provider: "ollama",
      models: [{ id: "legacy-opening-model", displayName: "Legacy opening" }],
    });
    harness.generate.mockResolvedValue({ text: "旧配置生成的开头。", usage: null });

    const result = await generateCreativeOpening(harness.runtime, {
      idea: "一名学徒发现导师留下的密室",
      requestId: "legacy-opening-request",
    });

    expect(result).toMatchObject({
      source: "provider",
      providerId: "legacy-opening",
      modelId: "legacy-opening-model",
      text: "旧配置生成的开头。",
    });
    expect(harness.listModels).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "legacy-opening", provider: "ollama" },
      model: "legacy-opening-model",
    });
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

    const result = await generateCreativeOpening(harness.runtime, {
      idea: "被时间遗忘的小镇重新出现",
      requestId: "blocked-opening-request",
    });

    expect(result).toMatchObject({
      source: "local_fallback",
      providerId: null,
      modelId: null,
      noticeCode: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
    });
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

  it("falls back to the legacy rewrite chain only when the route is absent", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "等待旧配置改写的原文。");
    await seedLegacyProfile(harness.runtime, "legacy-rewrite", "legacy-rewrite-model");
    harness.listModels.mockResolvedValue({
      provider: "ollama",
      models: [{ id: "legacy-rewrite-model", displayName: "Legacy rewrite" }],
    });
    harness.generate.mockResolvedValue({ text: "旧链生成的建议版本。", usage: null });
    const onBeforeDispatch = vi.fn();

    const result = await createImportRewriteCandidate(harness.runtime, {
      chapterId: chapter.id,
      instructions: ["节奏更快"],
      mode: "trial",
      onBeforeDispatch,
    });

    expect(result).toMatchObject({
      providerId: "legacy-rewrite",
      modelId: "legacy-rewrite-model",
    });
    expect(onBeforeDispatch).toHaveBeenCalledWith({
      requestId: result.requestId,
      providerId: "legacy-rewrite",
      modelId: "legacy-rewrite-model",
    });
    expect(harness.listModels).toHaveBeenCalledOnce();
    await expectStableChapter(harness.runtime, chapter.id, "等待旧配置改写的原文。");
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
    expect(result.value.content).toBe("编辑器中的稳定正文。\n\n模型续写的新段落。");
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: {
        providerId: "continuation-claude",
        provider: "anthropic",
      },
      model: "continuation-claude-model",
    });
    expect(harness.generate.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
    await expectStableChapter(harness.runtime, chapter.id, "编辑器中的稳定正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 1);
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
});

function createNativeHarness(): Readonly<{
  runtime: DesktopRuntime;
  generate: ReturnType<typeof vi.fn<NativeModelGatewayClient["generate"]>>;
  listModels: ReturnType<typeof vi.fn<NativeModelGatewayClient["listModels"]>>;
}> {
  const developmentRuntime = createDevelopmentRuntime(new MemoryStorage());
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  const listModels = vi.fn<NativeModelGatewayClient["listModels"]>();
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
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
      credentials: {
        getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    },
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
  }>,
): Promise<void> {
  const connection = await modelHub.saveConnection({
    id: input.connectionId,
    providerKind: input.providerKind,
    displayName: input.connectionId,
    credentialRef: `keyring:test:${input.connectionId}`,
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
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: "2026-08-02T00:00:00.000Z",
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
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    cachedInputMicrosPerMillionTokens: "0",
    pricingVersion: "creative-chain-zero-cost-v1",
    priceUpdatedAt: "2026-08-01T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "creative-chain-test-v1",
    expectedRevision: null,
  });
  await modelHub.saveTaskRoute({
    task: input.task,
    primaryCatalogEntryId: input.catalogEntryId,
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
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
