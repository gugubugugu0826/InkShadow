import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { exportPortableBundle } from "@inkshadow/import-export/core";
import { ToastProvider } from "@inkshadow/ui";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes, StartupOpeningInvocationRecovery } from "./app";
import { EDITOR_VIEW_STATE_STORAGE_KEY } from "./infrastructure/editor-view-state-store";
import { desktopPersistenceLifecycle } from "./infrastructure/persistence-lifecycle";
import { createDevelopmentRuntime, type DesktopRuntime } from "./infrastructure/runtime";
import { RuntimeProvider } from "./runtime-context";

function renderRoute(runtime: DesktopRuntime, route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function createTextFile(name: string, content: string, type: string): File {
  const file = new File([content], name, { type });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: () => Promise.resolve(content),
  });
  return file;
}

function getImportFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="file"][accept*=".docx"][multiple]',
  );
  if (input === null) {
    throw new Error("找不到作品导入文件输入。");
  }
  return input;
}

async function seedChapter(runtime: DesktopRuntime, content = "原始正文。") {
  const project = await runtime.useCases.createProject.execute({ name: "长篇小说" });
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
  return { project: project.value, chapter: chapter.value.chapter };
}

describe("desktop vertical slice", () => {
  it("checks durable opening invocations when the app starts before an opening page is visited", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const listActive = vi.spyOn(runtime.creativeJourneys, "listActive");

    render(
      <RuntimeProvider runtime={runtime}>
        <StartupOpeningInvocationRecovery />
      </RuntimeProvider>,
    );

    await waitFor(() => expect(listActive).toHaveBeenCalledWith("idea"));
  });

  it("keeps direct Studio routes feature-limited without entitlement and sends no team request", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const listTeams = vi.fn();
    Object.assign(runtime, {
      cloudTeams: { listTeams },
      cloudAiUsage: { getSummary: vi.fn(), listEvents: vi.fn() },
    });
    renderRoute(
      runtime,
      "/teams/019f9f4a-b3c7-7350-9226-000000000202/projects/019f9f4a-b3c7-7350-9226-000000000210/reviews",
    );

    expect(
      await screen.findByRole("heading", { name: "团队协作尚未启用", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/本地个人项目与离线编辑不受影响/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回项目" })).toHaveAttribute("href", "/projects");
    expect(screen.queryByRole("link", { name: "团队与权限" })).not.toBeInTheDocument();
    expect(listTeams).not.toHaveBeenCalled();
  });

  it("blocks a direct AI usage route while collaboration is disabled and sends no usage request", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const getSummary = vi.fn();
    const listEvents = vi.fn();
    Object.assign(runtime, {
      cloudAiUsage: { getSummary, listEvents },
    });
    renderRoute(runtime, "/teams/019f9f4a-b3c7-7350-9226-000000000202/usage");

    expect(await screen.findByText("团队协作尚未启用")).toBeInTheDocument();
    expect(screen.getByText(/本地个人项目与离线编辑不受影响/u)).toBeInTheDocument();
    expect(getSummary).not.toHaveBeenCalled();
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("shows a clear not-found page instead of silently redirecting invalid routes", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    renderRoute(runtime, "/this-route-does-not-exist");

    expect(
      await screen.findByRole("heading", { name: "找不到这个页面", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/链接可能已经过期/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回项目" })).toHaveAttribute("href", "/projects");
  });

  it("registers the AI usage route only when team collaboration is explicitly enabled", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "professional");
    const getSummary = vi.fn(() => new Promise(() => undefined));
    const listEvents = vi.fn(() => new Promise(() => undefined));
    Object.assign(runtime, {
      featureFlags: Object.freeze({
        ...runtime.featureFlags,
        cloudIdentity: true,
        teamCollaboration: true,
      }),
      cloudAiUsage: { getSummary, listEvents },
    });
    const teamId = "019f9f4a-b3c7-7350-9226-000000000202";
    renderRoute(runtime, `/teams/${teamId}/usage`);

    expect(
      await screen.findByRole("heading", { name: "智能创作额度、并发与用量" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(getSummary).toHaveBeenCalledWith(teamId, null, expect.any(AbortSignal));
      expect(listEvents).toHaveBeenCalled();
    });
    expect(screen.queryByRole("link", { name: "团队与权限" })).not.toBeInTheDocument();
  });

  it("creates, searches, archives, and lists a project through real use cases", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/projects");

    await screen.findByRole("heading", { name: "项目", level: 1 });
    expect(await screen.findByRole("heading", { name: "还没有作品" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "从想法开始" })).toHaveAttribute(
      "href",
      "/create/idea",
    );
    expect(screen.getByRole("link", { name: "导入已有小说" })).toHaveAttribute(
      "href",
      "/create/import",
    );
    await user.click(screen.getByRole("button", { name: "新建项目" }));
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "星河手记");
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    expect(await screen.findByRole("heading", { name: "星河手记" })).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "搜索项目" }), "星河");
    expect(await screen.findByRole("heading", { name: "星河手记" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "归档" }));
    await user.click(screen.getByRole("tab", { name: "已归档" }));
    expect(await screen.findByRole("heading", { name: "星河手记" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "恢复编辑" }));
    await user.click(screen.getByRole("tab", { name: "进行中" }));
    expect(await screen.findByRole("heading", { name: "星河手记" })).toBeInTheDocument();
  });

  it("does not create a project while Enter is confirming an IME candidate", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/projects");

    await user.click(await screen.findByRole("button", { name: "新建项目" }));
    const input = screen.getByRole("textbox", { name: "项目名称" });
    fireEvent.change(input, { target: { value: "中文项目" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true });

    expect(screen.getByRole("dialog", { name: "新建项目" })).toBeInTheDocument();
    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects.ok && projects.value).toHaveLength(0);
  });

  it("shows an inline limit error and returns focus for a blank project name", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/projects");

    await user.click(await screen.findByRole("button", { name: "新建项目" }));
    const input = screen.getByRole("textbox", { name: "项目名称" });
    await user.type(input, "   ");
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    expect(await screen.findByText("项目名称不能为空，请输入 1 至 120 个字符。")).toBeVisible();
    expect(input).toHaveFocus();
    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects.ok && projects.value).toHaveLength(0);
  });

  it("does not create a chapter while Enter is confirming an IME candidate", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "direct");
    const project = await runtime.useCases.createProject.execute({ name: "中文项目" });
    if (!project.ok) {
      throw project.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}`);

    const emptyStateHeading = await screen.findByRole("heading", { name: "还没有章节" });
    const emptyState = emptyStateHeading.closest(".ink-empty-state");
    if (!(emptyState instanceof HTMLElement)) throw new Error("找不到章节空状态区域。");
    await user.click(within(emptyState).getByRole("button", { name: "新建章节" }));
    const dialog = await screen.findByRole("dialog", { name: "新建章节" });
    const input = within(dialog).getByRole("textbox", { name: "章节标题" });
    fireEvent.change(input, { target: { value: "中文章节" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", isComposing: true });

    expect(dialog).toBeInTheDocument();
    const chapters = await runtime.repositories.chapters.listByProjectId(project.value.id);
    expect(chapters.ok && chapters.value).toHaveLength(0);
  });

  it("shows an inline limit error and returns focus for a blank chapter title", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "direct");
    const project = await runtime.useCases.createProject.execute({ name: "章节名称检查" });
    if (!project.ok) throw project.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}`);

    const emptyStateHeading = await screen.findByRole("heading", { name: "还没有章节" });
    const emptyState = emptyStateHeading.closest(".ink-empty-state");
    if (!(emptyState instanceof HTMLElement)) throw new Error("找不到章节空状态区域。");
    await user.click(within(emptyState).getByRole("button", { name: "新建章节" }));
    const dialog = await screen.findByRole("dialog", { name: "新建章节" });
    const input = within(dialog).getByRole("textbox", { name: "章节标题" });
    await user.type(input, "   ");
    await user.click(within(dialog).getByRole("button", { name: "创建章节" }));

    expect(
      await within(dialog).findByText("章节标题不能为空，请输入 1 至 200 个字符。"),
    ).toBeVisible();
    expect(input).toHaveFocus();
    const chapters = await runtime.repositories.chapters.listByProjectId(project.value.id);
    expect(chapters.ok && chapters.value).toHaveLength(0);
  });

  it("creates a private chapter atomically from the new chapter dialog", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "direct");
    const project = await runtime.useCases.createProject.execute({ name: "私密手稿" });
    if (!project.ok) throw project.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}`);

    const emptyStateHeading = await screen.findByRole("heading", { name: "还没有章节" });
    const emptyState = emptyStateHeading.closest(".ink-empty-state");
    if (!(emptyState instanceof HTMLElement)) throw new Error("找不到章节空状态区域。");
    await user.click(within(emptyState).getByRole("button", { name: "新建章节" }));
    const dialog = await screen.findByRole("dialog", { name: "新建章节" });
    await user.type(within(dialog).getByRole("textbox", { name: "章节标题" }), "未公开的尾声");
    await user.click(within(dialog).getByRole("checkbox", { name: /创建为私密章节/u }));
    await user.click(within(dialog).getByRole("button", { name: "创建章节" }));

    expect(await screen.findByText("本地私密")).toBeVisible();
    const chapters = await runtime.repositories.chapters.listByProjectId(project.value.id);
    expect(chapters.ok && chapters.value[0]?.toSnapshot()).toMatchObject({
      title: "未公开的尾声",
      privacyMode: "local_only",
      privacyRevision: 1,
    });
  });

  it("renames projects, reports visible name conflicts, and persists the result", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const first = await runtime.useCases.createProject.execute({ name: "旧名称" });
    const second = await runtime.useCases.createProject.execute({ name: "已占用名称" });
    if (!first.ok || !second.ok) {
      throw new Error("测试项目创建失败");
    }
    const user = userEvent.setup();
    renderRoute(runtime, "/projects");

    const firstCard = (await screen.findByRole("heading", { name: "旧名称" })).closest(".ink-card");
    if (!(firstCard instanceof HTMLElement)) {
      throw new Error("找不到项目卡片");
    }
    await user.click(within(firstCard).getByRole("button", { name: "重命名" }));
    const nameInput = screen.getByRole("textbox", { name: "项目名称" });
    await user.clear(nameInput);
    await user.type(nameInput, "已占用名称");
    await user.click(screen.getByRole("button", { name: "保存名称" }));
    expect(await screen.findByText("已有同名项目，请换一个名称。")).toBeInTheDocument();

    await user.clear(nameInput);
    await user.type(nameInput, "新名称");
    await user.click(screen.getByRole("button", { name: "保存名称" }));
    expect(await screen.findByRole("heading", { name: "新名称" })).toBeInTheDocument();

    const reopenedRuntime = createDevelopmentRuntime(window.localStorage);
    const persisted = await reopenedRuntime.repositories.projects.findById(first.value.id);
    expect(persisted.ok && persisted.value?.name).toBe("新名称");
  });

  it("persists a recovery draft, debounces autosave, and keeps candidates isolated", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const summarizeSavedVersion = vi.spyOn(runtime.story.chapterSummaries, "summarizeSavedVersion");
    const extractSavedVersion = vi.spyOn(runtime.story.continuousState, "extractSavedVersion");
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole("textbox", { name: "章节正文" });
    expect(editor).toHaveValue("原始正文。");
    await user.click(screen.getByRole("button", { name: "设为私密" }));
    const privacyDialog = await screen.findByRole("dialog", {
      name: "将本章设为私密章节？",
    });
    await user.click(within(privacyDialog).getByRole("button", { name: "确认仅限本地" }));

    fireEvent.change(editor, {
      target: { value: "修改后的正文。", selectionStart: 7 },
    });

    await waitFor(
      async () => {
        const draft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
        expect(draft.ok && draft.value?.content === "修改后的正文。").toBe(true);
      },
      { timeout: 1_200 },
    );

    await waitFor(
      async () => {
        const stable = await runtime.repositories.chapters.findById(chapter.id);
        expect(stable.ok && stable.value?.content === "修改后的正文。").toBe(true);
      },
      { timeout: 3_000 },
    );

    await user.click(screen.getByRole("button", { name: "生成续写建议" }));
    expect(await screen.findByText(/本地演示候选/u)).toBeInTheDocument();
    expect(screen.getByText("尝试上界累计估算")).toBeInTheDocument();
    expect(screen.getByText(/不是供应商实扣金额/u)).toBeInTheDocument();
    expect(editor).toHaveValue("修改后的正文。");
    const stableBeforeAcceptance = await runtime.repositories.chapters.findById(chapter.id);
    expect(
      stableBeforeAcceptance.ok && stableBeforeAcceptance.value?.content === "修改后的正文。",
    ).toBe(true);
    const versionsBeforeAcceptance = await runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    if (!versionsBeforeAcceptance.ok) throw versionsBeforeAcceptance.error;
    const immutableVersionsBeforeAcceptance = versionsBeforeAcceptance.value.map((version) =>
      version.toSnapshot(),
    );
    const rebuildProject = vi
      .spyOn(runtime.search, "rebuildProject")
      .mockRejectedValueOnce(new Error("local search temporarily unavailable"));

    await user.click(screen.getByRole("button", { name: "比较建议" }));
    const candidateReview = await screen.findByRole("dialog", {
      name: "比较建议与正文",
    });
    await user.click(within(candidateReview).getByRole("button", { name: "插入光标并创建版本" }));
    await waitFor(() => {
      expect((editor as HTMLTextAreaElement).value).toContain("暮色沿着窗棂");
    });
    await waitFor(async () => {
      const tasks = await runtime.taskCenter.load();
      const acceptedRefresh = tasks.tasks.find(
        (task) =>
          task.type === "story.accepted-version.process" &&
          task.metadata.projectId === project.id &&
          task.metadata.chapterId === chapter.id &&
          task.metadata.source === "candidate_accept",
      );
      expect(acceptedRefresh).toMatchObject({
        status: "waiting_retry",
        failure: { causeCode: "PIPELINE_STAGES_SEARCH" },
        metadata: {
          runChapterSummary: false,
          runStoryState: false,
        },
      });
    });
    expect(summarizeSavedVersion).not.toHaveBeenCalled();
    expect(extractSavedVersion).not.toHaveBeenCalled();
    expect(rebuildProject).toHaveBeenCalledOnce();
    const versionsAfterAcceptance = await runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    if (!versionsAfterAcceptance.ok) throw versionsAfterAcceptance.error;
    expect(versionsAfterAcceptance.value).toHaveLength(
      immutableVersionsBeforeAcceptance.length + 1,
    );
    for (const immutableVersion of immutableVersionsBeforeAcceptance) {
      expect(
        versionsAfterAcceptance.value
          .find((version) => version.id === immutableVersion.id)
          ?.toSnapshot(),
      ).toEqual(immutableVersion);
    }
    const privateChapterAfterAcceptance = await runtime.repositories.chapters.findById(chapter.id);
    expect(
      privateChapterAfterAcceptance.ok && privateChapterAfterAcceptance.value?.toSnapshot(),
    ).toMatchObject({ privacyMode: "local_only" });
    expect(screen.getByRole("complementary", { name: "AI 创作助手" })).toBeVisible();
    expect(screen.getByRole("button", { name: "生成续写建议" })).toBeEnabled();
  });

  it("keeps the writing canvas primary and opens chapters or the AI assistant on compact screens", async () => {
    const previousMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(max-width: 64rem)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      })),
    });
    let unmount: (() => void) | null = null;

    try {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const { chapter, project } = await seedChapter(runtime);
      const user = userEvent.setup();
      ({ unmount } = renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`));

      const editor = await screen.findByRole("textbox", { name: "章节正文" });
      expect(editor).toBeVisible();
      expect(screen.queryByRole("complementary", { name: "章节列表" })).not.toBeInTheDocument();
      expect(screen.queryByRole("complementary", { name: "AI 创作助手" })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "章节" }));
      const chapterDrawer = await screen.findByRole("dialog", { name: "章节" });
      expect(within(chapterDrawer).getByRole("link", { name: /第一章/u })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "章节" })).toBeNull());

      const assistantTrigger = screen.getByRole("button", { name: "AI 助手" });
      await user.click(assistantTrigger);
      const assistantDialog = await screen.findByRole("dialog", { name: "AI 创作助手" });
      expect(assistantDialog).toBeVisible();
      await waitFor(() => {
        expect(assistantDialog).toContainElement(document.activeElement as HTMLElement);
      });
      const writingCanvas = editor.closest<HTMLElement>(".writing-canvas");
      expect(writingCanvas).toHaveAttribute("aria-hidden", "true");
      expect(writingCanvas?.inert).toBe(true);

      const assistantFocusable = Array.from(
        assistantDialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.tabIndex >= 0);
      const firstAssistantControl = assistantFocusable[0];
      const lastAssistantControl = assistantFocusable.at(-1);
      expect(firstAssistantControl).toBeDefined();
      expect(lastAssistantControl).toBeDefined();
      lastAssistantControl?.focus();
      await user.tab();
      expect(firstAssistantControl).toHaveFocus();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "AI 创作助手" })).toBeNull());
      expect(assistantTrigger).toHaveFocus();
      expect(writingCanvas).not.toHaveAttribute("aria-hidden");
      expect(writingCanvas?.inert).not.toBe(true);
      expect(editor).toBeVisible();
    } finally {
      unmount?.();
      if (previousMatchMedia === undefined) {
        Reflect.deleteProperty(window, "matchMedia");
      } else {
        Object.defineProperty(window, "matchMedia", previousMatchMedia);
      }
    }
  });

  it("makes chapter privacy explicit, persistent, and reversible without changing正文", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "只保存在本机的秘密正文。");
    const user = userEvent.setup();
    const firstView = renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    expect(await screen.findByText("普通章节")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "设为私密" }));
    const localOnlyDialog = await screen.findByRole("dialog", {
      name: "将本章设为私密章节？",
    });
    expect(within(localOnlyDialog).getByText("无法撤回已经完成的外部传输")).toBeVisible();
    await user.click(within(localOnlyDialog).getByRole("button", { name: "确认仅限本地" }));

    expect(await screen.findByText("本地私密")).toBeVisible();
    const privateChapter = await runtime.repositories.chapters.findById(chapter.id);
    expect(privateChapter.ok && privateChapter.value?.toSnapshot()).toMatchObject({
      content: "只保存在本机的秘密正文。",
      privacyMode: "local_only",
      privacyRevision: 2,
    });

    firstView.unmount();
    const reopenedRuntime = createDevelopmentRuntime(window.localStorage);
    renderRoute(reopenedRuntime, `/projects/${project.id}/chapters/${chapter.id}`);
    expect(await screen.findByText("本地私密")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "管理隐私" }));
    const standardDialog = await screen.findByRole("dialog", {
      name: "允许本章使用联网 AI？",
    });
    expect(within(standardDialog).getByText("以后可能离开本机")).toBeVisible();
  });

  it("keeps an edited suggestion isolated until the author explicitly applies it", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "professional");
    const { chapter, project } = await seedChapter(runtime, "原始正文。");
    const user = userEvent.setup();
    const firstView = renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    editor.setSelectionRange(editor.value.length, editor.value.length);
    fireEvent.select(editor);
    await user.click(screen.getByRole("button", { name: "生成续写建议" }));
    await user.click(await screen.findByRole("button", { name: "比较建议" }));

    const review = await screen.findByRole("dialog", { name: "比较建议与正文" });
    const suggestion = within(review).getByRole("textbox", { name: "可编辑的建议" });
    await user.clear(suggestion);
    await user.type(suggestion, "作者修改后的最终建议。");

    expect(within(review).getByText("已由你修改")).toBeVisible();
    expect(within(review).getByText("建议已经修改")).toBeVisible();
    expect(editor).toHaveValue("原始正文。");
    const stableBeforeApply = await runtime.repositories.chapters.findById(chapter.id);
    expect(stableBeforeApply.ok && stableBeforeApply.value?.content).toBe("原始正文。");

    await user.click(within(review).getByRole("button", { name: "保存建议修改" }));
    expect(await within(review).findByText("修改已保存为建议")).toBeVisible();
    const savedCandidate = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    if (!savedCandidate.ok) throw savedCandidate.error;
    const revisedCandidate = savedCandidate.value[0];
    if (revisedCandidate === undefined) throw new Error("找不到修改后保存的建议。");
    expect(revisedCandidate.toSnapshot()).toMatchObject({
      content: "作者修改后的最终建议。",
      status: "ready",
    });
    const intent = revisedCandidate.applicationIntent;
    if (intent.application !== "insert_at_cursor") {
      throw new Error("续写建议没有保留生成时记录的插入位置。");
    }
    const baseContent = "原始正文。";
    const expectedAcceptedContent = `${baseContent.slice(0, intent.startUtf16)}${
      revisedCandidate.content
    }${baseContent.slice(intent.endUtf16)}`;
    expect(editor).toHaveValue("原始正文。");

    firstView.unmount();
    const reopenedRuntime = createDevelopmentRuntime(window.localStorage);
    renderRoute(reopenedRuntime, `/projects/${project.id}/chapters/${chapter.id}`);
    const reopenedEditor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    await user.click(await screen.findByRole("button", { name: "比较建议" }));
    const reopenedReview = await screen.findByRole("dialog", {
      name: "比较建议与正文",
    });
    expect(within(reopenedReview).getByRole("textbox", { name: "可编辑的建议" })).toHaveValue(
      "作者修改后的最终建议。",
    );
    await user.click(within(reopenedReview).getByRole("button", { name: "插入光标并创建版本" }));
    await waitFor(() => expect(reopenedEditor).toHaveValue(expectedAcceptedContent));

    const persistedCandidate = await reopenedRuntime.repositories.aiCandidates.listByChapterId(
      chapter.id,
    );
    expect(persistedCandidate.ok).toBe(true);
    if (persistedCandidate.ok) {
      expect(persistedCandidate.value[0]?.toSnapshot()).toMatchObject({
        content: "作者修改后的最终建议。",
        status: "accepted",
      });
    }
  });

  it("blocks stale candidate acceptance and can preserve the candidate as a new chapter", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "候选生成时的正文。");
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    await user.click(screen.getByRole("button", { name: "生成续写建议" }));
    expect(await screen.findByText(/本地演示候选/u)).toBeInTheDocument();

    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    if (!candidates.ok || candidates.value[0] === undefined) {
      throw new Error("候选生成失败");
    }
    const candidateContent = candidates.value[0].content;
    const candidateIntent = candidates.value[0].applicationIntent;
    if (candidateIntent.application !== "insert_at_cursor") {
      throw new Error("演示续写没有记录插入位置");
    }
    const candidateCopyContent = `${"候选生成时的正文。".slice(0, candidateIntent.startUtf16)}${candidateContent}${"候选生成时的正文。".slice(candidateIntent.endUtf16)}`;

    fireEvent.change(editor, {
      target: { value: "候选生成后继续编辑并保存的正文。", selectionStart: 15 },
    });
    await waitFor(
      async () => {
        const stable = await runtime.repositories.chapters.findById(chapter.id);
        expect(stable.ok && stable.value?.content).toBe("候选生成后继续编辑并保存的正文。");
      },
      { timeout: 3_000 },
    );

    await user.click(screen.getByRole("button", { name: "比较建议" }));
    const candidateReview = await screen.findByRole("dialog", {
      name: "比较建议与正文",
    });
    expect(within(candidateReview).getByText("正文已在建议生成后变化")).toBeVisible();
    expect(
      within(candidateReview).getByRole("button", { name: "插入光标并创建版本" }),
    ).toBeDisabled();

    await user.click(within(candidateReview).getByRole("button", { name: "将建议另存为新章节" }));
    expect(
      await within(candidateReview).findByRole("button", { name: "建议副本已保存" }),
    ).toBeDisabled();

    const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
    if (!chapters.ok) {
      throw chapters.error;
    }
    expect(chapters.value.map((item) => item.content)).toEqual(
      expect.arrayContaining(["候选生成后继续编辑并保存的正文。", candidateCopyContent]),
    );
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe("候选生成后继续编辑并保存的正文。");
  });

  it("restores a historical version by appending a new stable recovery version", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "第一版正文。");
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    fireEvent.change(editor, {
      target: { value: "第二版正文。", selectionStart: 6 },
    });
    await waitFor(
      async () => {
        const stable = await runtime.repositories.chapters.findById(chapter.id);
        expect(stable.ok && stable.value?.content).toBe("第二版正文。");
      },
      { timeout: 3_000 },
    );

    await user.click(screen.getByRole("button", { name: "版本历史" }));
    const versionDrawer = await screen.findByRole("dialog", { name: "版本历史" });
    const firstVersion = within(versionDrawer).getByText("版本 1").closest("li");
    if (!(firstVersion instanceof HTMLElement)) {
      throw new Error("找不到第一版历史记录");
    }
    expect(within(firstVersion).getByText("第一版正文。")).toBeVisible();
    await user.click(within(firstVersion).getByRole("button", { name: /^恢复版本 \d+$/u }));

    const confirmation = await screen.findByRole("dialog", { name: "恢复版本 1" });
    expect(within(confirmation).getByText("这是追加式恢复")).toBeVisible();
    await user.click(within(confirmation).getByRole("button", { name: /^确认恢复版本 \d+$/u }));
    await waitFor(() => {
      expect(editor).toHaveValue("第一版正文。");
    });

    const versions = await runtime.useCases.listChapterVersions.execute(chapter.id);
    if (!versions.ok) {
      throw versions.error;
    }
    expect(versions.value).toHaveLength(3);
    expect(versions.value.map((version) => version.toSnapshot())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sequence: 1, content: "第一版正文。", reason: "created" }),
        expect.objectContaining({ sequence: 2, content: "第二版正文。" }),
        expect.objectContaining({ sequence: 3, content: "第一版正文。", reason: "recovery" }),
      ]),
    );
    await waitFor(async () => {
      const tasks = await runtime.taskCenter.load();
      expect(
        tasks.tasks.some(
          (task) =>
            task.type === "story.accepted-version.process" &&
            task.metadata.projectId === project.id &&
            task.metadata.chapterId === chapter.id &&
            task.metadata.source === "version_restore",
        ),
      ).toBe(true);
    });
    const reopened = createDevelopmentRuntime(window.localStorage);
    const persisted = await reopened.repositories.chapters.findById(chapter.id);
    expect(persisted.ok && persisted.value?.content).toBe("第一版正文。");
  });

  it("commits the latest stable version on blur and before controlled route teardown", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const view = renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });

    fireEvent.change(editor, {
      target: { value: "flush-on-window-blur", selectionStart: 20 },
    });
    window.dispatchEvent(new Event("blur"));
    await waitFor(
      async () => {
        const stable = await runtime.repositories.chapters.findById(chapter.id);
        expect(stable.ok && stable.value?.content).toBe("flush-on-window-blur");
        const draft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
        expect(draft.ok && draft.value).toBeNull();
      },
      { timeout: 3_000 },
    );
    expect(screen.getByText("已保存到本地")).toBeVisible();

    fireEvent.change(editor, {
      target: { value: "flush-on-route-teardown", selectionStart: 23 },
    });
    await expect(desktopPersistenceLifecycle.flush("route-change", 1_000)).resolves.toEqual({
      status: "success",
      flushedHandlerIds: [`editor:${chapter.id}`],
    });
    view.unmount();

    const stableAfterTeardown = await runtime.repositories.chapters.findById(chapter.id);
    expect(stableAfterTeardown.ok && stableAfterTeardown.value?.content).toBe(
      "flush-on-route-teardown",
    );
    const unmountedDraft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
    expect(unmountedDraft.ok && unmountedDraft.value).toBeNull();
  });

  it("commits a newer complete edit made while the persistence queue is draining", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    const originalEdit = runtime.useCases.editChapter.execute.bind(runtime.useCases.editChapter);
    let releaseFirstWrite: (() => void) | undefined;
    let reportFirstWriteStarted: (() => void) | undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWriteStarted = new Promise<void>((resolve) => {
      reportFirstWriteStarted = resolve;
    });
    let firstWrite = true;
    vi.spyOn(runtime.useCases.editChapter, "execute").mockImplementation(async (input) => {
      if (firstWrite) {
        firstWrite = false;
        reportFirstWriteStarted?.();
        await firstWriteGate;
      }
      return originalEdit(input);
    });

    fireEvent.change(editor, {
      target: { value: "first-complete-snapshot", selectionStart: 23 },
    });
    const flushing = desktopPersistenceLifecycle.flush("route-change", 2_000);
    await firstWriteStarted;
    fireEvent.change(editor, {
      target: { value: "newer-complete-snapshot", selectionStart: 23 },
    });
    releaseFirstWrite?.();

    await expect(flushing).resolves.toEqual({
      status: "success",
      flushedHandlerIds: [`editor:${chapter.id}`],
    });
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe("newer-complete-snapshot");
    const draft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
    expect(draft.ok && draft.value).toBeNull();
    await waitFor(() => {
      expect(screen.getByText("已保存到本地")).toBeVisible();
    });
  });

  it("keeps stable text visible until the user explicitly restores a recovery draft", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "stable-before-crash");
    const drafted = await runtime.useCases.editChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      content: "unsaved-recovery-draft",
      cursorOffset: 8,
    });
    if (!drafted.ok) {
      throw drafted.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    expect(editor).toHaveValue("stable-before-crash");
    const dialog = await screen.findByRole("dialog", { name: "发现未完成的本地草稿" });
    expect(within(dialog).getByText("unsaved-recovery-draft")).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "恢复草稿继续编辑" }));
    expect(screen.queryByRole("dialog", { name: "发现未完成的本地草稿" })).not.toBeInTheDocument();
    expect(editor).toHaveValue("unsaved-recovery-draft");
    expect(editor.selectionStart).toBe(8);
  });

  it("can explicitly discard a recovery record without changing stable text", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "stable-kept");
    const drafted = await runtime.useCases.editChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      content: "draft-to-discard",
      cursorOffset: 4,
    });
    if (!drafted.ok) {
      throw drafted.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    const dialog = await screen.findByRole("dialog", { name: "发现未完成的本地草稿" });
    await user.click(within(dialog).getByRole("button", { name: "保留稳定正文" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "发现未完成的本地草稿" }),
      ).not.toBeInTheDocument();
    });

    expect(editor).toHaveValue("stable-kept");
    const remainingDraft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
    expect(remainingDraft.ok && remainingDraft.value).toBeNull();
  });

  it("copies a recovery draft into a new stable chapter before clearing it", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "stable-original");
    const drafted = await runtime.useCases.editChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      content: "draft-preserved-as-copy",
      cursorOffset: 10,
    });
    if (!drafted.ok) {
      throw drafted.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const dialog = await screen.findByRole("dialog", { name: "发现未完成的本地草稿" });
    await user.click(within(dialog).getByRole("button", { name: "草稿另存为新章节" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "发现未完成的本地草稿" }),
      ).not.toBeInTheDocument();
    });

    const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
    if (!chapters.ok) {
      throw chapters.error;
    }
    expect(chapters.value.map((item) => item.content)).toEqual(
      expect.arrayContaining(["stable-original", "draft-preserved-as-copy"]),
    );
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe("stable-original");
    const remainingDraft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
    expect(remainingDraft.ok && remainingDraft.value).toBeNull();
  });

  it("does not persist partial IME composition and saves only after composition ends", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole("textbox", { name: "章节正文" });
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, {
      target: { value: "组合中的拼", selectionStart: 5 },
    });

    await new Promise((resolve) => window.setTimeout(resolve, 1_800));
    const draftDuringComposition = await runtime.repositories.recoveryDrafts.findByChapterId(
      chapter.id,
    );
    const stableDuringComposition = await runtime.repositories.chapters.findById(chapter.id);
    expect(draftDuringComposition.ok && draftDuringComposition.value).toBeNull();
    expect(stableDuringComposition.ok && stableDuringComposition.value?.content).toBe("原始正文。");

    fireEvent.change(editor, {
      target: { value: "组合完成。", selectionStart: 5 },
    });
    fireEvent.compositionEnd(editor);

    await waitFor(
      async () => {
        const draft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
        expect(draft.ok && draft.value?.content).toBe("组合完成。");
      },
      { timeout: 1_200 },
    );
  });

  it("supports bounded undo, redo, literal find/replace, and sanitized plain-text paste", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "甲.*乙 甲.*乙");
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    await user.click(screen.getByText("写作工具与排版"));
    fireEvent.change(editor, {
      target: { value: "甲.*乙 甲.*乙！", selectionStart: 10, selectionEnd: 10 },
    });
    expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(editor).toHaveValue("甲.*乙 甲.*乙");
    await user.click(screen.getByRole("button", { name: "重做" }));
    expect(editor).toHaveValue("甲.*乙 甲.*乙！");

    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    expect(editor).toHaveValue("甲.*乙 甲.*乙");
    fireEvent.keyDown(editor, { key: "z", ctrlKey: true, shiftKey: true });
    expect(editor).toHaveValue("甲.*乙 甲.*乙！");

    fireEvent.keyDown(editor, { key: "f", ctrlKey: true });
    const findInput = await screen.findByRole("searchbox", { name: "查找文字" });
    await user.type(findInput, "甲.*乙");
    await user.click(screen.getByRole("button", { name: "下一处" }));
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(4);

    await user.type(screen.getByRole("textbox", { name: "替换为" }), "岸$1");
    await user.click(screen.getByRole("button", { name: "替换当前" }));
    expect(editor).toHaveValue("岸$1 甲.*乙！");
    await user.click(screen.getByRole("button", { name: "全部替换" }));
    expect(editor).toHaveValue("岸$1 岸$1！");

    editor.setSelectionRange(editor.value.length, editor.value.length);
    fireEvent.select(editor);
    fireEvent.paste(editor, {
      clipboardData: {
        getData: () => "\r\n尾声\u0000\u202E",
      },
    });
    expect(editor).toHaveValue("岸$1 岸$1！\n尾声");
    expect(screen.getByText(/移除不可见的危险控制字符/u)).toBeInTheDocument();
  });

  it("restores UTF-16 selection, scroll, and typography without storing chapter content", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "雾港正文内容");
    const route = `/projects/${project.id}/chapters/${chapter.id}`;
    const user = userEvent.setup();
    const firstRender = renderRoute(runtime, route);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    await user.click(screen.getByText("写作工具与排版"));
    editor.setSelectionRange(2, 5);
    fireEvent.select(editor);
    editor.scrollTop = 180;
    fireEvent.scroll(editor);
    await user.selectOptions(screen.getByLabelText("正文字号"), "20");

    const storedView = window.localStorage.getItem(EDITOR_VIEW_STATE_STORAGE_KEY);
    expect(storedView).not.toBeNull();
    expect(storedView).not.toContain("雾港正文内容");
    firstRender.unmount();

    renderRoute(runtime, route);
    const reopened = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    await waitFor(() => {
      expect(reopened.selectionStart).toBe(2);
      expect(reopened.selectionEnd).toBe(5);
      expect(reopened.scrollTop).toBe(180);
    });
    expect(screen.getByLabelText("正文字号")).toHaveValue("20");
  });

  it("keeps archived chapters read-only while allowing literal search", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "只读正文");
    const archived = await runtime.useCases.archiveProject.execute({ projectId: project.id });
    if (!archived.ok) {
      throw archived.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole("textbox", { name: "章节正文" });
    await user.click(screen.getByText("写作工具与排版"));
    expect(editor).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "查找替换" }));
    await user.type(screen.getByRole("searchbox", { name: "查找文字" }), "正文");
    expect(screen.getByRole("button", { name: "下一处" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "替换当前" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部替换" })).toBeDisabled();
  });

  it("commits a validated multi-file import atomically and opens its first chapter", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "professional");
    const user = userEvent.setup();
    renderRoute(runtime, "/settings");

    await screen.findByRole("button", { name: "浏览选择文件" }, { timeout: 5_000 });
    const fileInput = getImportFileInput();
    await user.upload(fileInput, [
      createTextFile("第一章.md", "# 潮来\n\n雾港的钟声响了。", "text/markdown"),
      createTextFile("第二章.txt", "灯塔守望者推开旧门。", "text/plain"),
    ]);
    expect(await screen.findByText("预检通过，尚未写入项目")).toBeInTheDocument();

    const projectName = screen.getByRole("textbox", { name: "导入为项目名称" });
    await user.clear(projectName);
    await user.type(projectName, "雾港导入稿");
    await user.click(screen.getByRole("button", { name: "确认导入" }));

    expect(await screen.findByText(/已写入 2 个章节/u)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "打开第一章" }));
    expect(await screen.findByRole("heading", { name: "第一章", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "章节正文" })).toHaveValue(
      "# 潮来\n\n雾港的钟声响了。",
    );

    const reopened = createDevelopmentRuntime(window.localStorage);
    const projects = await reopened.useCases.listProjects.execute({
      statuses: ["active"],
    });
    if (!projects.ok) {
      throw projects.error;
    }
    expect(projects.value.map(({ name }) => name)).toEqual(["雾港导入稿"]);
    const importedProject = projects.value[0];
    if (importedProject === undefined) {
      throw new Error("导入项目不存在。");
    }
    const chapters = await reopened.repositories.chapters.listByProjectId(importedProject.id);
    expect(chapters.ok && chapters.value.map(({ title }) => title)).toEqual(["第一章", "第二章"]);
  });

  it("blocks credential-required model setup without rendering a secret field in browser development mode", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "professional");
    const user = userEvent.setup();
    renderRoute(runtime, "/settings#model-center");

    fireEvent.click(await screen.findByRole("button", { name: "连接 AI 服务" }));
    expect(await screen.findByText("浏览器开发模式不接受模型密钥")).toBeInTheDocument();
    expect(screen.queryByLabelText("接口访问密钥")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("model-secret")).toBeNull();
    expect(screen.getByRole("button", { name: "测试连接并发现模型" })).toBeDisabled();
    const saveProfile = screen.getByRole("button", { name: "保存供应商与模型" });
    expect(saveProfile).toBeDisabled();
    expect(screen.queryByText("保存供应商与模型暂不可用")).not.toBeInTheDocument();
    await expect(runtime.modelCenter.listProfiles()).resolves.toEqual([]);
    await expect(runtime.modelHub.listConnections()).resolves.toEqual([]);
    await user.click(screen.getByRole("button", { name: "专家设置" }));
    expect(screen.queryByLabelText("接口访问密钥")).not.toBeInTheDocument();
    expect(saveProfile).toBeDisabled();
    await expect(runtime.modelCenter.listProfiles()).resolves.toEqual([]);
    await expect(runtime.modelHub.listConnections()).resolves.toEqual([]);
    expect(JSON.stringify(window.localStorage)).not.toMatch(
      /api[_-]?key|access[_-]?token|password|secret/iu,
    );
  });

  it("preflights local files and inspects a portable bundle without writing it", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "professional");
    const user = userEvent.setup();
    renderRoute(runtime, "/settings");

    await screen.findByRole("button", { name: "浏览选择文件" }, { timeout: 5_000 });

    const fileInput = getImportFileInput();
    await user.upload(fileInput, [
      createTextFile("章节甲.txt", "纯文本正文", "text/plain"),
      createTextFile("章节乙.md", "# 小节\n\nMarkdown 正文", "text/markdown"),
    ]);
    expect(await screen.findByText("预检通过，尚未写入项目")).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("textbox", { name: "章节标题" })
        .map((input) => input.getAttribute("value")),
    ).toEqual(["章节甲", "章节乙"]);

    const bundle = await exportPortableBundle(
      {
        project: {
          id: runtime.ids.next(),
          title: "Bundle 项目",
          language: "zh-CN",
          createdAt: runtime.clock.now(),
          updatedAt: runtime.clock.now(),
        },
        chapters: [
          {
            id: runtime.ids.next(),
            title: "Bundle 章节",
            order: 0,
            markdown: "Bundle 正文",
          },
        ],
      },
      {
        bundleId: runtime.ids.next(),
        exportedAt: runtime.clock.now(),
        generatorVersion: "0.1.0",
      },
    );
    await user.upload(
      fileInput,
      createTextFile("bundle.inkshadow.json", bundle, "application/json"),
    );
    expect(await screen.findByRole("heading", { name: "Bundle 项目" })).toBeInTheDocument();
    expect(screen.getByText("Bundle 章节")).toBeInTheDocument();
  });

  async function ensureWritingMode(
    runtime: DesktopRuntime,
    mode: "direct" | "professional",
  ): Promise<void> {
    const preference = await runtime.writingExperience.getOrInitialize();
    if (preference.mode !== mode) {
      await runtime.writingExperience.switchMode(mode, preference.revision);
    }
  }
});
