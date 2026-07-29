import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { exportPortableBundle } from "@inkshadow/import-export";
import { ToastProvider } from "@inkshadow/ui";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "./app";
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

    expect(await screen.findByText("团队协作尚未启用")).toBeInTheDocument();
    expect(screen.getByText(/本地个人项目与离线编辑不受影响/u)).toBeInTheDocument();
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

  it("registers the AI usage route only when team collaboration is explicitly enabled", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
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

    expect(await screen.findByRole("heading", { name: "AI 额度、并发与用量" })).toBeInTheDocument();
    await waitFor(() => {
      expect(getSummary).toHaveBeenCalledWith(teamId, null, expect.any(AbortSignal));
      expect(listEvents).toHaveBeenCalled();
    });
    expect(screen.getByRole("link", { name: "团队与权限" })).toBeInTheDocument();
  });

  it("creates, searches, archives, and lists a project through real use cases", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/projects");

    await screen.findByRole("heading", { name: "项目", level: 1 });
    expect(await screen.findByRole("heading", { name: "从本地开始创作" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "选择文件" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开恢复工具" })).toBeInTheDocument();
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
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole("textbox", { name: "章节正文" });
    expect(editor).toHaveValue("原始正文。");

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

    await user.click(screen.getByRole("button", { name: "创建演示候选" }));
    expect(await screen.findByRole("heading", { name: "生成前检查" })).toBeInTheDocument();
    expect(screen.getByText("本次费用上界估算")).toBeInTheDocument();
    expect(screen.getByText(/local-demo-zero-cost/u)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "确认并开始" }));
    expect(await screen.findByText(/本地演示候选/u)).toBeInTheDocument();
    expect(screen.getByText("尝试上界累计估算")).toBeInTheDocument();
    expect(screen.getByText(/不是供应商实扣金额/u)).toBeInTheDocument();
    expect(editor).toHaveValue("修改后的正文。");
    const stableBeforeAcceptance = await runtime.repositories.chapters.findById(chapter.id);
    expect(
      stableBeforeAcceptance.ok && stableBeforeAcceptance.value?.content === "修改后的正文。",
    ).toBe(true);

    await user.click(screen.getByRole("button", { name: "比较并决定" }));
    const candidateReview = await screen.findByRole("dialog", {
      name: "比较候选与稳定正文",
    });
    await user.click(within(candidateReview).getByRole("button", { name: "覆盖全文并创建版本" }));
    await waitFor(() => {
      expect((editor as HTMLTextAreaElement).value).toContain("暮色沿着窗棂");
    });
    expect(screen.getByRole("button", { name: "继续生成候选" })).toBeEnabled();
  });

  it("blocks stale candidate acceptance and can preserve the candidate as a new chapter", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime, "候选生成时的正文。");
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.id}/chapters/${chapter.id}`);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    await user.click(screen.getByRole("button", { name: "创建演示候选" }));
    await user.click(await screen.findByRole("button", { name: "确认并开始" }));
    expect(await screen.findByText(/本地演示候选/u)).toBeInTheDocument();

    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    if (!candidates.ok || candidates.value[0] === undefined) {
      throw new Error("候选生成失败");
    }
    const candidateContent = candidates.value[0].content;

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

    await user.click(screen.getByRole("button", { name: "比较并决定" }));
    const candidateReview = await screen.findByRole("dialog", {
      name: "比较候选与稳定正文",
    });
    expect(within(candidateReview).getByText("稳定正文已在候选生成后变化")).toBeVisible();
    expect(
      within(candidateReview).getByRole("button", { name: "覆盖全文并创建版本" }),
    ).toBeDisabled();

    await user.click(within(candidateReview).getByRole("button", { name: "将候选另存为新章节" }));
    expect(
      await within(candidateReview).findByRole("button", { name: "候选副本已保存" }),
    ).toBeDisabled();

    const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
    if (!chapters.ok) {
      throw chapters.error;
    }
    expect(chapters.value.map((item) => item.content)).toEqual(
      expect.arrayContaining(["候选生成后继续编辑并保存的正文。", candidateContent]),
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
    await user.click(within(firstVersion).getByRole("button", { name: "恢复此版本" }));

    const confirmation = await screen.findByRole("dialog", { name: "恢复版本 1" });
    expect(within(confirmation).getByText("这是追加式恢复")).toBeVisible();
    await user.click(within(confirmation).getByRole("button", { name: "创建恢复版本" }));
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
    const user = userEvent.setup();
    renderRoute(runtime, "/settings");

    await screen.findByRole("button", { name: "浏览选择文件" });
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

  it("never accepts or renders a model secret field in browser development mode", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderRoute(runtime, "/settings");

    expect(await screen.findByText("浏览器开发模式不接受模型密钥")).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "SQLite 一致性检查与文件备份仅在 Tauri 桌面应用中可用。浏览器开发数据保存在 localStorage。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建一致性备份" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("model-secret")).toBeNull();
    expect(screen.getByRole("button", { name: "检查连接并读取模型" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存非敏感配置" }));
    expect(await screen.findByText("配置修订 1")).toBeInTheDocument();
    await expect(runtime.modelCenter.listProfiles()).resolves.toMatchObject([
      {
        providerId: "openai",
        provider: "open_ai_compatible",
        selectedModel: null,
      },
    ]);
    await user.type(screen.getByRole("textbox", { name: /^模型标识/u }), "gpt-test");
    await user.type(screen.getByRole("spinbutton", { name: "上下文窗口（token）" }), "32000");
    await user.type(screen.getByRole("spinbutton", { name: "输入价 / 百万 token" }), "1");
    await user.type(screen.getByRole("spinbutton", { name: "输出价 / 百万 token" }), "2");
    await user.type(screen.getByRole("textbox", { name: "价格版本" }), "test-2026-07");
    fireEvent.change(screen.getByLabelText("价格更新时间"), {
      target: { value: "2026-07-27" },
    });
    await user.click(screen.getByRole("button", { name: "保存非敏感配置" }));
    await expect(runtime.modelCenter.listProfiles()).resolves.toMatchObject([
      {
        selectedModel: "gpt-test",
        pricing: {
          contextWindowTokens: 32_000,
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 2_000_000,
          pricingVersion: "test-2026-07",
        },
      },
    ]);
    expect(JSON.stringify(window.localStorage)).not.toMatch(
      /api[_-]?key|access[_-]?token|password|secret/iu,
    );

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
});
