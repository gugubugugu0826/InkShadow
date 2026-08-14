import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import {
  AiCandidate,
  type AiCandidateApplicationIntent,
  type AiCandidateSource,
  type Chapter,
  type Project,
} from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("editor candidate route selection", () => {
  it("opens the exact ready UUIDv7 candidate requested by the query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const requested = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "路由明确指定的候选正文",
    );
    await createReadyCandidate(runtime, project, chapter, "不应替代指定候选的其他正文");

    renderEditor(runtime, project, chapter, `?candidate=${requested.id}`);

    expect(await screen.findByText("路由明确指定的候选正文")).toBeVisible();
    expect(screen.queryByText("不应替代指定候选的其他正文")).not.toBeInTheDocument();
  });

  it("keeps a locally generated opening labeled as a local draft after entering the editor", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "本地开头草案", {
      source: "generate",
    });
    const now = runtime.clock.now();
    await runtime.creativeJourneys.create(
      {
        id: candidate.id,
        kind: "idea",
        status: "active",
        currentState: "opening_selected",
        projectId: project.id,
        chapterId: chapter.id,
        candidateId: null,
        revision: 1,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      {
        id: runtime.ids.next(),
        journeyId: candidate.id,
        sequence: 1,
        kind: "idea",
        questionKey: null,
        generationSource: "local_fallback",
        providerId: null,
        modelId: null,
        taskKey: null,
        requestId: null,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
      },
    );
    await runtime.creativeJourneys.update(
      {
        id: candidate.id,
        kind: "idea",
        status: "completed",
        currentState: "candidate_ready",
        projectId: project.id,
        chapterId: chapter.id,
        candidateId: candidate.id,
        revision: 2,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
      1,
      {
        id: runtime.ids.next(),
        journeyId: candidate.id,
        sequence: 2,
        kind: "keep",
        questionKey: null,
        generationSource: "local_fallback",
        providerId: null,
        modelId: null,
        taskKey: null,
        requestId: null,
        snapshot: { candidateId: candidate.id, previewSource: "local_fallback" },
        createdAt: now,
      },
    );

    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看本地草案版本" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "比较本地草案" }));
    expect(await screen.findByRole("dialog", { name: "比较本地草案与正文" })).toBeVisible();
  });

  it("uses a neutral label when a generate candidate has no trustworthy origin receipt", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "来源记录缺失的候选", {
      source: "generate",
    });

    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看建议版本" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 AI 建议版本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看本地草案版本" })).not.toBeInTheDocument();
  });

  it("does not relabel a generate candidate as AI when its origin receipt cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "来源记录读取失败的候选",
      {
        source: "generate",
      },
    );
    vi.spyOn(runtime.creativeJourneys, "findById").mockRejectedValueOnce(
      new Error("journey unavailable"),
    );

    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看建议版本" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 AI 建议版本" })).not.toBeInTheDocument();
  });

  it("shows a visible error and does not fall back for an invalid candidate query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    await createReadyCandidate(runtime, project, chapter, "不可静默打开的默认候选");

    renderEditor(runtime, project, chapter, "?candidate=not-a-uuid");

    expect(
      await screen.findByText("AI 建议链接无效；未自动打开其他建议。请从深度审稿页重新选择。"),
    ).toBeVisible();
    expect(screen.queryByText("不可静默打开的默认候选")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "还没有 AI 建议版本" })).toBeVisible();
  });

  it("rejects a ready candidate from another chapter without opening the local default", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const otherChapterResult = await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第二章",
      content: "第二章稳定正文",
    });
    if (!otherChapterResult.ok) {
      throw otherChapterResult.error;
    }
    const crossChapter = await createReadyCandidate(
      runtime,
      project,
      otherChapterResult.value.chapter,
      "其他章节候选",
    );
    await createReadyCandidate(runtime, project, chapter, "当前章节默认候选");

    renderEditor(runtime, project, chapter, `?candidate=${crossChapter.id}`);

    expect(
      await screen.findByText(
        "链接指定的 AI 建议不存在、已处理，或不属于当前项目与章节；未自动打开其他建议。",
      ),
    ).toBeVisible();
    expect(screen.queryByText("当前章节默认候选")).not.toBeInTheDocument();
    expect(screen.queryByText("其他章节候选")).not.toBeInTheDocument();
  });

  it("rejects a non-ready candidate and exposes the multi-agent review link only when enabled", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const streaming = AiCandidate.createStreaming({
      id: runtime.ids.next(),
      projectId: project.id,
      chapterId: chapter.id,
      source: "agent",
      baseVersionId: chapter.currentVersionId,
      now: runtime.clock.now(),
    });
    if (!streaming.ok) {
      throw streaming.error;
    }
    const created = await runtime.repositories.aiCandidates.create(streaming.value);
    if (!created.ok) {
      throw created.error;
    }
    Object.assign(runtime, {
      featureFlags: Object.freeze({ ...runtime.featureFlags, multiAgent: true }),
      multiAgentReview: Object.freeze({}),
    });

    renderEditor(runtime, project, chapter, `?candidate=${streaming.value.id}`);

    expect(
      await screen.findByText(
        "链接指定的 AI 建议不存在、已处理，或不属于当前项目与章节；未自动打开其他建议。",
      ),
    ).toBeVisible();
    await userEvent.setup().click(screen.getByText("高级工具"));
    expect(
      screen
        .getAllByRole("link", { name: "深度审稿" })
        .find(
          (link) =>
            link.getAttribute("href") ===
            `/projects/${project.id}/chapters/${chapter.id}/multi-agent-review`,
        ),
    ).toBeVisible();
  });

  it("uses the persisted selection-rewrite anchor instead of the current editor selection", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "新稿", {
      source: "polish",
      applicationIntent: {
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16: 2,
        endUtf16: 4,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: "比较 AI 建议" }));
    const review = await screen.findByRole("dialog", { name: "比较 AI 建议与正文" });
    expect(within(review).getByText(/第 2 到第 4 个字符/u)).toBeVisible();
    await user.click(within(review).getByRole("button", { name: "替换选区并创建版本" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "章节正文" })).toHaveValue("稳定新稿"),
    );
  });

  it("offers the four explicit whole-chapter rewrite outcomes", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "整章改写正文", {
      source: "polish",
      applicationIntent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: "比较 AI 建议" }));
    const review = await screen.findByRole("dialog", { name: "比较 AI 建议与正文" });
    expect(within(review).getByRole("button", { name: "取消" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "替换整章并创建版本" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "追加到章末并创建版本" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "保存为新草稿" })).toBeEnabled();
  });
});

function renderEditor(
  runtime: DesktopRuntime,
  project: Project,
  chapter: Chapter,
  search = "",
): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/projects/${project.id}/chapters/${chapter.id}${search}`]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

async function seedChapter(runtime: DesktopRuntime): Promise<{
  readonly project: Project;
  readonly chapter: Chapter;
}> {
  const project = await runtime.useCases.createProject.execute({ name: "候选路由测试项目" });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "稳定正文",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return { project: project.value, chapter: chapter.value.chapter };
}

async function createReadyCandidate(
  runtime: DesktopRuntime,
  project: Project,
  chapter: Chapter,
  content: string,
  options: Readonly<{
    source?: AiCandidateSource;
    applicationIntent?: AiCandidateApplicationIntent;
  }> = {},
): Promise<AiCandidate> {
  const streaming = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: project.id,
    chapterId: chapter.id,
    source: options.source ?? "agent",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
    ...(options.applicationIntent === undefined
      ? {}
      : { applicationIntent: options.applicationIntent }),
  });
  if (!streaming.ok) {
    throw streaming.error;
  }
  const checksum = await runtime.hasher.sha256(content);
  if (!checksum.ok) {
    throw checksum.error;
  }
  const ready = streaming.value.markReady(content, checksum.value, runtime.clock.now());
  if (!ready.ok) {
    throw ready.error;
  }
  const created = await runtime.repositories.aiCandidates.create(ready.value);
  if (!created.ok) {
    throw created.error;
  }
  return ready.value;
}
