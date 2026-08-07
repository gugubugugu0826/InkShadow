import { render, screen, waitFor, within } from "@testing-library/react";
import type { UuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedImport } from "../components/data-transfer-panel";
import type { ModelProfile } from "../infrastructure/model-center-store";
import type { NovelAiTask } from "../infrastructure/model-hub-provider-registry";
import type { ModelHubStore } from "../infrastructure/model-hub-store";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGenerationInput,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import {
  IMPORT_JOURNEY_STORAGE_KEY,
  IMPORT_REWRITE_PENDING_STORAGE_KEY,
  ImportJourneyPage,
} from "./import-journey-page";

describe("ImportJourneyPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("restores the local journey, reports supported local formats, and never fakes AI without a model", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const fixture = await seedImportedWork(runtime, ["门开了。她没有回头，雨声留在走廊尽头。"]);
    writeDraft(fixture.completed, { goal: "保留剧情，让对话更自然" });
    window.localStorage.setItem(
      IMPORT_REWRITE_PENDING_STORAGE_KEY,
      JSON.stringify({
        requestId: fixture.chapterIds[0],
        providerId: "previous-provider",
        modelId: "previous-model",
        chapterId: fixture.chapterIds[0],
        kind: "trial",
        startedAt: new Date().toISOString(),
      }),
    );
    const user = userEvent.setup();
    renderPage(runtime);

    expect(
      screen.getByRole("heading", { name: "导入小说，继续写或改写", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回开始" })).toHaveAttribute("href", "/");
    expect(screen.getByText(/^当前可在本机安全导入.*DOCX、EPUB/)).toBeInTheDocument();
    expect(screen.getByText(/不会自动重复调用或重复计费/)).toBeInTheDocument();
    await screen.findByText("识别到 1 个有效章节。");

    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    expect(await screen.findByText(/MODEL_NOT_CONNECTED/)).toBeInTheDocument();
    const chapter = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(chapter.ok && chapter.value?.content).toBe("门开了。她没有回头，雨声留在走廊尽头。");
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(candidates.ok && candidates.value).toHaveLength(0);
  });

  it("runs resumable evidence-bound work analysis and restores its progress without copying prose into the journey draft", async () => {
    const content = "午夜停电，林夏拉住周远，仓库的监控随即失效。";
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, []);
    const fixture = await seedImportedWork(runtime, [content]);
    const chapterResult = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    if (!chapterResult.ok || chapterResult.value === null) {
      throw new Error("Expected the imported chapter.");
    }
    const chapter = chapterResult.value;
    const outputs = [
      analysisResponse({
        chapterId: chapter.id,
        versionId: chapter.currentVersionId,
        content,
        factType: "core_relationship",
        statement: "林夏试图留住周远。",
        subjects: ["林夏", "周远"],
        relation: "挽留",
      }),
      analysisResponse({
        chapterId: chapter.id,
        versionId: chapter.currentVersionId,
        content,
        factType: "causal_event",
        statement: "午夜停电后仓库监控失效。",
        subjects: [],
        relation: "仓库监控失效",
      }),
    ];
    const configured = withConfiguredModel(base, outputs);
    // The fixture and configured runtime share the same local repositories.
    await seedAnalysisRoutes(configured.modelHub);
    writeDraft(fixture.completed, {});
    const user = userEvent.setup();
    const first = renderPage(configured);
    await screen.findByText("识别到 1 个有效章节。");

    await user.click(screen.getByRole("button", { name: "开始分析作品" }));

    const result = await screen.findByRole("region", { name: "作品分析结果" });
    await waitFor(() => expect(result).toHaveTextContent("共保存 2 条待确认事实"));
    expect(result).toHaveTextContent("人物关系：1 条有原文证据的待确认结果");
    expect(result).toHaveTextContent("已发生事件：1 条有原文证据的待确认结果");
    expect(screen.getByRole("link", { name: "故事设定" })).toHaveAttribute(
      "href",
      `/projects/${fixture.completed.projectId}/story`,
    );
    expect(window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY)).not.toContain(content);

    const storyProjectId = parseStoryUuidV7(fixture.completed.projectId);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const facts = await configured.story.facts.listByProjectId(storyProjectId.value);
    expect(facts.ok && facts.value).toHaveLength(2);
    if (!facts.ok) throw facts.error;
    expect(facts.value.every(({ status }) => status === "unconfirmed")).toBe(true);
    expect(facts.value.every((fact) => fact.toSnapshot().needsReview)).toBe(true);
    expect(facts.value.map((fact) => fact.toSnapshot().source.excerpt)).toEqual([content, content]);
    const stable = await configured.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe(content);

    first.unmount();
    renderPage(configured);
    const restored = await screen.findByRole("region", { name: "作品分析结果" });
    expect(restored).toHaveTextContent("共保存 2 条待确认事实");
    expect(screen.queryByRole("button", { name: "开始分析作品" })).not.toBeInTheDocument();
  });

  it("keeps imported prose intact and offers an explicit skip when analysis routing is unavailable", async () => {
    const content = "原文已经安全导入，不应因分析失败而变化。";
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, []);
    const fixture = await seedImportedWork(runtime, [content]);
    writeDraft(fixture.completed, {});
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");

    await user.click(screen.getByRole("button", { name: "开始分析作品" }));

    expect(
      (await screen.findAllByText(/IMPORT_ANALYSIS_ROUTE_NOT_CONFIGURED/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "前往模型设置" })).toHaveAttribute(
      "href",
      "/settings#model-center",
    );
    await user.click(screen.getByRole("button", { name: "跳过剩余分析" }));
    expect(await screen.findByText(/已跳过剩余深度分析/)).toBeInTheDocument();
    const result = screen.getByRole("region", { name: "作品分析结果" });
    expect(result).toHaveTextContent("跳过 2 项");
    expect(result).toHaveTextContent("共保存 0 条待确认事实");
    const stable = await runtime.repositories.chapters.findById(chapterIdAt(fixture.chapterIds, 0));
    expect(stable.ok && stable.value?.content).toBe(content);
  });

  it("creates a resumable isolated trial candidate, accepts explicitly, and restores the exact base version", async () => {
    const original = "门开了。她没有回头。\n\n雨声沿着窗框落下，走廊里没有第二个人。";
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["门轻轻开了，她仍背对着门。"]);
    const fixture = await seedImportedWork(runtime, [original]);
    writeDraft(fixture.completed, { goal: "保留事件顺序，让动作更克制" });
    const user = userEvent.setup();
    const first = renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");

    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    expect(await screen.findByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
      "门轻轻开了，她仍背对着门。",
    );
    expect(screen.getByRole("list", { name: "试改文字差异" })).toBeInTheDocument();

    const beforeAccept = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(beforeAccept.ok && beforeAccept.value?.content).toBe(original);
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(candidates.ok && candidates.value).toHaveLength(1);
    if (!candidates.ok || candidates.value[0] === undefined) {
      throw new Error("Expected the isolated trial candidate.");
    }
    expect(candidates.value[0].status).toBe("ready");
    expect(candidates.value[0].content).toBe("门轻轻开了，她仍背对着门。");
    expect(window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY)).not.toContain(original);

    first.unmount();
    renderPage(runtime);
    expect(await screen.findByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
      "门轻轻开了，她仍背对着门。",
    );
    await user.click(screen.getByRole("button", { name: "接受试改到正文" }));
    await screen.findByRole("button", { name: "恢复接受前原文" });
    const accepted = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(accepted.ok && accepted.value?.content).toBe("门轻轻开了，她仍背对着门。");

    await user.click(screen.getByRole("button", { name: "恢复接受前原文" }));
    await screen.findByText("已恢复原文");
    const restored = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(restored.ok && restored.value?.content).toBe(original);
    const versions = await runtime.useCases.listChapterVersions.execute(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(versions.ok && versions.value.length).toBe(3);
  });

  it("refuses automatic restore after later edits so recovery cannot overwrite newer writing", async () => {
    const original = "原始段落。";
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["AI 试改段落。　"]);
    const fixture = await seedImportedWork(runtime, [original]);
    writeDraft(fixture.completed, { goal: "优化文笔" });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByRole("region", { name: "代表段落试改结果" });
    await user.click(screen.getByRole("button", { name: "接受试改到正文" }));
    await screen.findByRole("button", { name: "恢复接受前原文" });

    const accepted = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    if (!accepted.ok || accepted.value === null) {
      throw new Error("Expected the accepted chapter.");
    }
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: accepted.value.id,
      expectedRevision: accepted.value.revision,
      content: "作者接受后继续写下的新内容。",
      cursorOffset: 13,
    });
    if (!edited.ok) {
      throw edited.error;
    }
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: accepted.value.id,
      expectedRevision: accepted.value.revision,
      reason: "manual",
    });
    if (!saved.ok) {
      throw saved.error;
    }

    await user.click(screen.getByRole("button", { name: "恢复接受前原文" }));
    expect(await screen.findByText(/BASE_VERSION_CHANGED/)).toBeInTheDocument();
    const afterFailedRestore = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(afterFailedRestore.ok && afterFailedRestore.value?.content).toBe(
      "作者接受后继续写下的新内容。",
    );
  });

  it("forms editable rules and creates independent per-chapter candidates with accept, reject, and retry", async () => {
    const originals = ["第一章原文：雨夜相遇。", "第二章原文：清晨分别。"] as const;
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, [
      "第一章试改：雨夜的相遇更安静。",
      "第一章完整改写：雨夜相遇。",
      "第二章完整改写：清晨分别。",
      "第一章重新改写：雨夜相遇。",
    ]);
    const fixture = await seedImportedWork(runtime, originals);
    writeDraft(fixture.completed, { selectedPresetIds: ["polish"] });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 2 个有效章节。");

    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    expect(await screen.findByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
      "第一章试改：雨夜的相遇更安静。",
    );
    await user.click(screen.getByRole("button", { name: "对话更自然" }));
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    expect(screen.getByRole("textbox", { name: "规则 1" })).toHaveValue(
      "保留主要剧情、已发生事件和人物姓名",
    );
    await user.click(screen.getByRole("button", { name: "保留当前规则" }));
    await user.click(screen.getByRole("button", { name: "开始逐章处理" }));

    const batch = await screen.findByRole("list", { name: "逐章建议版本" });
    await waitFor(() => {
      const rows = within(batch).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toHaveTextContent("建议版本已就绪");
      }
    });
    const firstRow = within(batch).getByText("第 1 章").closest("li");
    const secondRow = within(batch).getByText("第 2 章").closest("li");
    if (firstRow === null || secondRow === null) {
      throw new Error("Expected both chapter candidate rows.");
    }
    expect(within(firstRow).getByRole("link", { name: "查看完整差异" })).toHaveAttribute(
      "href",
      expect.stringContaining("?candidate="),
    );
    const stableBefore = await Promise.all(
      fixture.chapterIds.map((chapterId) => runtime.repositories.chapters.findById(chapterId)),
    );
    expect(stableBefore.map((result) => result.ok && result.value?.content)).toEqual(originals);

    await user.click(within(firstRow).getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(within(firstRow).getByText(/已拒绝/)).toBeInTheDocument());
    await user.click(within(secondRow).getByRole("button", { name: "接受" }));
    await waitFor(() =>
      expect(within(secondRow).getByText(/已接受为新正文版本/)).toBeInTheDocument(),
    );
    const firstStable = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    const secondStable = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 1),
    );
    expect(firstStable.ok && firstStable.value?.content).toBe(originals[0]);
    expect(secondStable.ok && secondStable.value?.content).toBe("第二章完整改写：清晨分别。");

    await user.click(within(firstRow).getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(firstRow).toHaveTextContent("建议版本已就绪"));
    const firstCandidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(
      firstCandidates.ok && firstCandidates.value.filter(({ status }) => status === "ready"),
    ).toHaveLength(2);
    expect(
      firstCandidates.ok && firstCandidates.value.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
  });
});

async function seedImportedWork(
  runtime: DesktopRuntime,
  contents: readonly string[],
): Promise<Readonly<{ completed: CompletedImport; chapterIds: readonly UuidV7[] }>> {
  const project = await runtime.useCases.createProject.execute({ name: "导入测试作品" });
  if (!project.ok) {
    throw project.error;
  }
  const chapterIds: UuidV7[] = [];
  for (const [index, content] of contents.entries()) {
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: `第 ${String(index + 1)} 章`,
      content,
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    chapterIds.push(chapter.value.chapter.id);
  }
  return {
    completed: {
      projectId: project.value.id,
      firstChapterId: chapterIdAt(chapterIds, 0),
      projectName: project.value.name,
      chapterCount: chapterIds.length,
    },
    chapterIds,
  };
}

function writeDraft(
  completed: CompletedImport,
  override: Readonly<{
    goal?: string;
    selectedPresetIds?: readonly string[];
  }>,
): void {
  window.localStorage.setItem(
    IMPORT_JOURNEY_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      goal: override.goal ?? "",
      selectedPresetIds: override.selectedPresetIds ?? [],
      importedWork: completed,
      feedbackPresetIds: [],
      feedbackText: "",
      trial: null,
      rules: [],
      rulesSavedAt: null,
      batchItems: [],
      updatedAt: new Date().toISOString(),
    }),
  );
}

function withConfiguredModel(base: DesktopRuntime, outputs: readonly string[]): DesktopRuntime {
  const queued = [...outputs];
  const profile: ModelProfile = Object.freeze({
    providerId: "test-provider",
    provider: "open_ai_compatible",
    baseUrl: "https://models.example.test/v1",
    authentication: "bearer_keyring",
    selectedModel: "novel-model",
    pricing: null,
    revision: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const gateway: NativeModelGatewayClient = {
    available: true,
    listModels: vi.fn(() =>
      Promise.resolve({
        provider: "open_ai_compatible" as const,
        models: [{ id: "novel-model", displayName: "Novel Model" }],
      }),
    ),
    checkConnection: vi.fn(() =>
      Promise.resolve({
        provider: "open_ai_compatible" as const,
        endpointOrigin: "https://models.example.test",
        modelCount: 1,
        latencyMs: 8,
      }),
    ),
    generate: vi.fn((input: NativeModelGenerationInput) => {
      const text = queued.shift();
      if (text === undefined) {
        return Promise.reject(new Error("TEST_OUTPUT_EXHAUSTED"));
      }
      input.onDelta?.(text);
      return Promise.resolve({ text, usage: null });
    }),
    cancelGeneration: vi.fn(() => Promise.resolve(true)),
    embed: vi.fn(() =>
      Promise.resolve({
        provider: "open_ai_compatible" as const,
        endpointOrigin: "https://models.example.test",
        model: "novel-model",
        dimension: 1,
        vectorCount: 1,
        embeddings: [[1]],
      }),
    ),
  };
  return {
    ...base,
    mode: "tauri",
    modelCenter: {
      listProfiles: () => Promise.resolve([profile]),
      findByProviderId: () => Promise.resolve(profile),
      save: () => Promise.resolve(profile),
    },
    modelGateway: gateway,
    credentials: {
      getSummary: () => Promise.resolve({ configured: true, lastFour: "test" }),
      save: () => Promise.resolve({ configured: true, lastFour: "test" }),
      delete: () => Promise.resolve({ configured: false, lastFour: null }),
    },
  };
}

async function seedAnalysisRoutes(modelHub: ModelHubStore): Promise<void> {
  await seedAnalysisRoute(modelHub, "character_extraction", "character");
  await seedAnalysisRoute(modelHub, "world_extraction", "story");
}

async function seedAnalysisRoute(
  modelHub: ModelHubStore,
  task: Extract<NovelAiTask, "character_extraction" | "world_extraction">,
  prefix: string,
): Promise<void> {
  const connection = await modelHub.saveConnection({
    id: `${prefix}-analysis-connection`,
    providerKind: "google_gemini",
    displayName: `${prefix} analysis`,
    credentialRef: `keyring:test:${prefix}`,
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await modelHub.syncCatalog({
    syncId: `${prefix}-analysis-sync`,
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: `${prefix}-analysis-catalog`,
        providerModelId: `${prefix}-analysis-model`,
        lifecycle: "stable",
        inputTokenLimit: 500_000,
        outputTokenLimit: 20_000,
        staleAfter: "2030-01-01T00:00:00.000Z",
      },
    ],
  });
  await modelHub.recordCapabilityScan({
    scanId: `${prefix}-analysis-scan`,
    catalogEntryId: `${prefix}-analysis-catalog`,
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "import-page-test-v1",
    evidence: [
      {
        id: `${prefix}-analysis-text-evidence`,
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
      {
        id: `${prefix}-analysis-structured-evidence`,
        capability: "structured_output",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: `${prefix}-analysis-catalog`,
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    cachedInputMicrosPerMillionTokens: "0",
    pricingVersion: "zero-cost-v1",
    priceUpdatedAt: "2026-08-01T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "import-page-test-v1",
    expectedRevision: null,
  });
  await modelHub.saveTaskRoute({
    task,
    primaryCatalogEntryId: `${prefix}-analysis-catalog`,
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

function analysisResponse(
  input: Readonly<{
    chapterId: UuidV7;
    versionId: UuidV7;
    content: string;
    factType: string;
    statement: string;
    subjects: readonly string[];
    relation: string | null;
  }>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: {
      chapterId: input.chapterId,
      versionId: input.versionId,
      chunkIndex: 0,
      chunkStart: 0,
      chunkLength: input.content.length,
    },
    findings: [
      {
        factType: input.factType,
        statement: input.statement,
        subjects: input.subjects,
        relation: input.relation,
        confidence: 0.9,
        evidence: {
          startOffset: 0,
          endOffset: input.content.length,
          excerpt: input.content,
        },
      },
    ],
  });
}

function chapterIdAt(chapterIds: readonly UuidV7[], index: number): UuidV7 {
  const chapterId = chapterIds[index];
  if (chapterId === undefined) {
    throw new Error(`Expected chapter ID at index ${String(index)}.`);
  }
  return chapterId;
}

function renderPage(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter>
      <RuntimeProvider runtime={runtime}>
        <ImportJourneyPage />
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
