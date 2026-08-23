import { render, screen } from "@testing-library/react";
import { AiCandidate, type UuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedImport } from "../components/data-transfer-panel";
import { createImportRewriteCandidate } from "../infrastructure/import-rewrite-service";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import {
  IMPORT_JOURNEY_STORAGE_KEY,
  IMPORT_REWRITE_PENDING_STORAGE_KEY,
  ImportJourneyPage,
} from "./import-journey-page";

describe("ImportJourneyPage safe Provider boundary", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps local import available while every legacy batch Provider entry is closed", async () => {
    const fixture = await seededRuntime();
    const generate = vi.spyOn(fixture.runtime.modelGateway, "generate");
    writeDraft(fixture.completed, fixture.chapterId);
    renderPage(fixture.runtime);

    expect(await screen.findByText("识别到 1 个有效章节。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批量 AI 分析暂不可用" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "生成代表段落试改" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始逐章处理" })).toBeDisabled();
    expect(screen.getByText("批量 AI 作品分析已安全关闭")).toBeInTheDocument();
    expect(screen.getByText("新的逐章改写已安全关闭")).toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();

    const chapter = await fixture.runtime.repositories.chapters.findById(fixture.chapterId);
    expect(chapter.ok && chapter.value?.content).toBe("门开了。她没有回头。");
  });

  it("does not turn a click on a disabled legacy action into a fake call count or Provider call", async () => {
    const fixture = await seededRuntime();
    const generate = vi.spyOn(fixture.runtime.modelGateway, "generate");
    writeDraft(fixture.completed, fixture.chapterId);
    renderPage(fixture.runtime);
    await screen.findByText("识别到 1 个有效章节。");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await user.click(screen.getByRole("button", { name: "开始逐章处理" }));

    expect(generate).not.toHaveBeenCalled();
    expect(screen.queryByText(/预计.*次调用/u)).not.toBeInTheDocument();
    expect(screen.getByText(/无法提供完整的调用与费用确认/u)).toBeInTheDocument();
  });

  it("hides raw connection and request identifiers from the ordinary recovery notice", async () => {
    const fixture = await seededRuntime();
    writeDraft(fixture.completed, fixture.chapterId);
    window.localStorage.setItem(
      IMPORT_REWRITE_PENDING_STORAGE_KEY,
      JSON.stringify({
        requestId: "request-secret-123",
        providerId: "connection-secret-456",
        modelId: "model-secret-789",
        chapterId: fixture.chapterId,
        kind: "trial",
        startedAt: "2026-08-20T00:00:00.000Z",
      }),
    );
    renderPage(fixture.runtime);

    expect(await screen.findByText("上次模型调用可能在中断前已发送")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("request-secret-123");
    expect(document.body).not.toHaveTextContent("connection-secret-456");
    expect(document.body).not.toHaveTextContent("model-secret-789");
  });

  it("fails closed with zero gateway calls when only a legacy profile exists", async () => {
    const fixture = await seededRuntime();
    const generate = vi.spyOn(fixture.runtime.modelGateway, "generate");

    await expect(
      createImportRewriteCandidate(fixture.runtime, {
        chapterId: fixture.chapterId,
        instructions: ["保持事件顺序，只调整语气。"],
        mode: "trial",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_ROUTE_NOT_CONFIGURED" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps accepted正文 safe in professional mode when local fact organization fails", async () => {
    const fixture = await seededRuntime();
    const preference = await fixture.runtime.writingExperience.getOrInitialize();
    await fixture.runtime.writingExperience.switchMode("professional", preference.revision);
    const generate = vi.spyOn(fixture.runtime.modelGateway, "generate");
    const chapter = await fixture.runtime.repositories.chapters.findById(fixture.chapterId);
    if (!chapter.ok || chapter.value === null) throw new Error("Expected the imported chapter.");
    const streaming = AiCandidate.createStreaming({
      id: fixture.runtime.ids.next(),
      projectId: chapter.value.projectId,
      chapterId: chapter.value.id,
      source: "polish",
      baseVersionId: chapter.value.currentVersionId,
      now: fixture.runtime.clock.now(),
      applicationIntent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      },
    });
    if (!streaming.ok) throw streaming.error;
    const rewritten = "门轻轻开了，她仍背对着门。";
    const checksum = await fixture.runtime.hasher.sha256(rewritten);
    if (!checksum.ok) throw checksum.error;
    const created = streaming.value.markReady(
      rewritten,
      checksum.value,
      fixture.runtime.clock.now(),
    );
    if (!created.ok) throw created.error;
    const stored = await fixture.runtime.repositories.aiCandidates.create(created.value);
    if (!stored.ok) throw stored.error;
    writeDraft(fixture.completed, fixture.chapterId, {
      candidateId: created.value.id,
      candidateRevision: created.value.revision,
      chapterId: fixture.chapterId,
      excerptStart: 0,
      excerptEnd: "门开了。她没有回头。".length,
      providerId: "historical-provider",
      modelId: "historical-model",
      requestId: "historical-request",
      restoredAt: null,
    });
    renderPage(fixture.runtime);
    expect(await screen.findByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
      created.value.content,
    );
    vi.spyOn(fixture.runtime.story.facts, "listByProjectId").mockRejectedValue(
      new Error("CURRENT_VERSION_FACTS_UNAVAILABLE"),
    );
    const startTask = vi.spyOn(fixture.runtime.taskCenter, "startTask");
    const search = vi.spyOn(fixture.runtime.search, "rebuildProject");
    const summary = vi.spyOn(fixture.runtime.story.chapterSummaries, "summarizeSavedVersion");
    const storyState = vi.spyOn(fixture.runtime.story.continuousState, "extractSavedVersion");
    const causal = vi.spyOn(fixture.runtime.story.causalProjector, "rebuildProject");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "接受试改到正文" }));
    expect(
      await screen.findByText("正文和版本已安全保存；故事资料整理暂未完成，可在任务与通知中重试。"),
    ).toBeInTheDocument();

    const acceptedChapter = await fixture.runtime.repositories.chapters.findById(fixture.chapterId);
    expect(acceptedChapter.ok && acceptedChapter.value?.content).toBe(created.value.content);
    const versions = await fixture.runtime.useCases.listChapterVersions.execute(fixture.chapterId);
    expect(versions.ok && versions.value).toHaveLength(2);
    const storedCandidate = await fixture.runtime.repositories.aiCandidates.findById(
      created.value.id,
    );
    expect(storedCandidate.ok && storedCandidate.value?.status).toBe("accepted");
    expect(generate).not.toHaveBeenCalled();
    const queuedTask = (await fixture.runtime.taskCenter.load()).tasks.find(
      (task) => task.status === "queued",
    );
    expect(queuedTask?.metadata).toMatchObject({ organizeLocalStoryFacts: true });
    expect(startTask).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
    expect(storyState).not.toHaveBeenCalled();
    expect(causal).not.toHaveBeenCalled();
  });

  it("still organizes the accepted direct-mode version when background task registration fails", async () => {
    const fixture = await seededRuntime();
    const chapter = await fixture.runtime.repositories.chapters.findById(fixture.chapterId);
    if (!chapter.ok || chapter.value === null) throw new Error("Expected the imported chapter.");
    const streaming = AiCandidate.createStreaming({
      id: fixture.runtime.ids.next(),
      projectId: chapter.value.projectId,
      chapterId: chapter.value.id,
      source: "polish",
      baseVersionId: chapter.value.currentVersionId,
      now: fixture.runtime.clock.now(),
      applicationIntent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      },
    });
    if (!streaming.ok) throw streaming.error;
    const rewritten = "周望是钟楼的管理员。钟楼在旧城。";
    const checksum = await fixture.runtime.hasher.sha256(rewritten);
    if (!checksum.ok) throw checksum.error;
    const ready = streaming.value.markReady(rewritten, checksum.value, fixture.runtime.clock.now());
    if (!ready.ok) throw ready.error;
    const stored = await fixture.runtime.repositories.aiCandidates.create(ready.value);
    if (!stored.ok) throw stored.error;
    writeDraft(fixture.completed, fixture.chapterId, {
      candidateId: ready.value.id,
      candidateRevision: ready.value.revision,
      chapterId: fixture.chapterId,
      excerptStart: 0,
      excerptEnd: chapter.value.content.length,
      providerId: "historical-provider",
      modelId: "historical-model",
      requestId: "historical-request",
      restoredAt: null,
    });
    vi.spyOn(fixture.runtime.taskCenter, "findTaskByIdempotencyKey").mockRejectedValue(
      new Error("TASK_REGISTRATION_UNAVAILABLE"),
    );
    const stageAutomaticFactWithAuthorityFence = vi.spyOn(
      fixture.runtime.story.factService,
      "stageAutomaticFactWithAuthorityFence",
    );

    renderPage(fixture.runtime);
    expect(await screen.findByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
      rewritten,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "接受试改到正文" }));

    expect(
      await screen.findByText(
        "正文和版本已安全保存；本地设定已整理；后台任务登记失败，可在任务与通知中重试。",
      ),
    ).toBeVisible();
    expect(stageAutomaticFactWithAuthorityFence).toHaveBeenCalled();
    const projectId = parseStoryUuidV7(chapter.value.projectId);
    if (!projectId.ok) throw projectId.error;
    const facts = await fixture.runtime.story.facts.listByProjectId(projectId.value);
    if (!facts.ok) throw facts.error;
    expect(facts.value.map((fact) => fact.toSnapshot().contentText)).toContain(
      "周望是钟楼的管理员。",
    );
  });
});

async function seededRuntime(): Promise<
  Readonly<{
    runtime: DesktopRuntime;
    completed: CompletedImport;
    chapterId: UuidV7;
  }>
> {
  const base = createDevelopmentRuntime(window.localStorage);
  await base.writingExperience.getOrInitialize();
  const gateway = {
    ...base.modelGateway,
    available: true as const,
    generate: vi.fn(() => Promise.resolve({ text: "不应生成", usage: null })),
  };
  const runtime: DesktopRuntime = {
    ...base,
    mode: "tauri",
    modelGateway: gateway,
    modelCenter: {
      ...base.modelCenter,
      listProfiles: () =>
        Promise.resolve([
          {
            providerId: "legacy-provider",
            provider: "open_ai_compatible" as const,
            baseUrl: "https://legacy.example.test/v1",
            authentication: "bearer_keyring" as const,
            selectedModel: "legacy-model",
            pricing: null,
            revision: 1,
            createdAt: "2026-08-20T00:00:00.000Z",
            updatedAt: "2026-08-20T00:00:00.000Z",
          },
        ]),
    },
  };
  const project = await runtime.useCases.createProject.execute({ name: "导入测试作品" });
  if (!project.ok) throw project.error;
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "门开了。她没有回头。",
  });
  if (!chapter.ok) throw chapter.error;
  return {
    runtime,
    chapterId: chapter.value.chapter.id,
    completed: {
      projectId: project.value.id,
      firstChapterId: chapter.value.chapter.id,
      projectName: project.value.name,
      chapterCount: 1,
    },
  };
}

function writeDraft(
  completed: CompletedImport,
  chapterId: UuidV7,
  trial: Readonly<{
    candidateId: UuidV7;
    candidateRevision: number;
    chapterId: UuidV7;
    excerptStart: number;
    excerptEnd: number;
    providerId: string;
    modelId: string;
    requestId: string;
    restoredAt: string | null;
  }> | null = null,
): void {
  window.localStorage.setItem(
    IMPORT_JOURNEY_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      goal: "保持事件顺序，让动作更克制",
      selectedPresetIds: [],
      importedWork: completed,
      feedbackPresetIds: [],
      feedbackText: "",
      trial,
      rules: [{ id: "rule-1", text: "保持事件顺序，让动作更克制", enabled: true }],
      rulesSavedAt: "2026-08-20T00:00:00.000Z",
      batchItems: [],
      workAnalysis: null,
      projectSeed: null,
      updatedAt: "2026-08-20T00:00:00.000Z",
      chapterId,
    }),
  );
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
