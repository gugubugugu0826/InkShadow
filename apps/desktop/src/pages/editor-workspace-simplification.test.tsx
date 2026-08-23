import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiCandidate, type Chapter, type Project } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { saveEditorPreferences } from "../infrastructure/editor-preferences-store";
import { RuntimeProvider } from "../runtime-context";
import { EditorPage } from "./editor-page";

describe("simplified editor workspace", () => {
  it("ignores a previous project's delayed load after the route switches", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const first = await seedProject(runtime);
    const secondProjectResult = await runtime.useCases.createProject.execute({
      name: "Second delayed-load project",
    });
    if (!secondProjectResult.ok) throw secondProjectResult.error;
    const secondChapter = await runtime.useCases.createChapter.execute({
      projectId: secondProjectResult.value.id,
      title: "Second chapter",
      content: "Second project stable content",
    });
    if (!secondChapter.ok) throw secondChapter.error;
    const second = { project: secondProjectResult.value, chapter: secondChapter.value.chapter };
    const originalFindProject = runtime.repositories.projects.findById.bind(
      runtime.repositories.projects,
    );
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(runtime.repositories.projects, "findById").mockImplementation((id) =>
      id === first.project.id
        ? firstGate.then(() => originalFindProject(id))
        : originalFindProject(id),
    );
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={[`/projects/${first.project.id}/chapters/${first.chapter.id}`]}>
        <RuntimeProvider runtime={runtime}>
          <ToastProvider>
            <Link to={`/projects/${second.project.id}/chapters/${second.chapter.id}`}>
              switch project
            </Link>
            <Routes>
              <Route path="/projects/:projectId/chapters/:chapterId" element={<EditorPage />} />
            </Routes>
          </ToastProvider>
        </RuntimeProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: "switch project" }));
    expect(await screen.findByRole("textbox", { name: "章节正文" })).toHaveValue(
      second.chapter.content,
    );
    releaseFirst();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "章节正文" })).toHaveValue(second.chapter.content),
    );
  });

  it("keeps chapters,正文 and the AI assistant in one collapsible workspace", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedProject(runtime);
    const second = await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第二章",
      content: "第二章正文",
    });
    if (!second.ok) {
      throw second.error;
    }
    const user = userEvent.setup();

    renderEditor(runtime, project, chapter);

    const chapterPanel = await screen.findByRole("complementary", { name: "章节" });
    expect(within(chapterPanel).getByRole("link", { name: /第一章/u })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(chapterPanel).getByRole("link", { name: /第二章/u })).toHaveAttribute(
      "href",
      `/projects/${project.id}/chapters/${second.value.chapter.id}`,
    );
    expect(screen.getByRole("textbox", { name: "章节正文" })).toHaveValue("第一章正文");
    expect(screen.getByText("5 / 5000000 字符")).toBeVisible();
    expect(screen.getByRole("complementary", { name: "AI 创作助手" })).toBeVisible();

    const toolbar = document.querySelector(".editor-toolbar");
    if (!(toolbar instanceof HTMLElement)) {
      throw new Error("找不到编辑器顶部操作区");
    }
    expect(within(toolbar).getByRole("button", { name: "继续创作" })).toBeVisible();
    expect(within(toolbar).queryByRole("button", { name: "撤销" })).not.toBeInTheDocument();
    expect(within(toolbar).queryByRole("button", { name: "查找替换" })).not.toBeInTheDocument();

    await user.click(within(chapterPanel).getByRole("button", { name: "收起章节列表" }));
    expect(screen.queryByRole("link", { name: /第一章/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开章节列表" }));
    expect(await screen.findByRole("complementary", { name: "章节" })).toBeVisible();

    const assistant = screen.getByRole("complementary", { name: "AI 创作助手" });
    await user.click(within(assistant).getByRole("button", { name: "收起 AI 创作助手" }));
    expect(screen.queryByRole("heading", { name: "AI 创作助手" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开 AI 创作助手" }));
    expect(await screen.findByRole("heading", { name: "AI 创作助手" })).toBeVisible();
  });

  it("resizes the desktop assistant with pointer capture and the full keyboard contract", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await ensureWritingMode(runtime, "direct");
    const { chapter, project } = await seedProject(runtime);
    const user = userEvent.setup();

    renderEditor(runtime, project, chapter);

    const separator = await screen.findByRole("separator", {
      name: "调整正文与创作助手宽度",
    });
    const writingCanvas = screen.getByRole("region", { name: "章节正文" });
    const assistant = screen.getByRole("complementary", { name: "创作助手" });
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-controls", "editor-ai-assistant-panel");
    expect(separator.previousElementSibling).toBe(writingCanvas);
    expect(separator.nextElementSibling).toBe(assistant);

    const initialWidth = Number(separator.getAttribute("aria-valuenow"));
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", String(initialWidth + 8));
    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "256");
    const workspace = separator.parentElement;
    if (!(workspace instanceof HTMLElement)) {
      throw new Error("找不到编辑器工作区");
    }
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(writingCanvas, "getBoundingClientRect").mockReturnValue(new DOMRect(172, 0, 372, 600));
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuemax", "408");
    expect(separator).toHaveAttribute("aria-valuenow", "408");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "256");

    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(separator, {
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: releasePointerCapture },
      setPointerCapture: { configurable: true, value: setPointerCapture },
    });
    fireEvent.pointerDown(separator, { clientX: 800, pointerId: 7 });
    fireEvent.pointerMove(separator, { clientX: 700, pointerId: 7 });
    fireEvent.pointerUp(separator, { clientX: 700, pointerId: 7 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(separator).toHaveAttribute("aria-valuenow", "356");

    await user.click(within(assistant).getByRole("button", { name: "收起创作助手" }));
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开创作助手" }));
    expect(
      await screen.findByRole("separator", { name: "调整正文与创作助手宽度" }),
    ).toHaveAttribute("aria-valuenow", "356");
  });

  it("uses the drawer breakpoint without exposing the desktop resize separator", async () => {
    const previousMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => createMediaQueryList(query, query === "(max-width: 64rem)")),
    });
    try {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const { chapter, project } = await seedProject(runtime);
      const user = userEvent.setup();

      renderEditor(runtime, project, chapter);

      expect(await screen.findByRole("textbox", { name: "章节正文" })).toBeVisible();
      expect(screen.queryByRole("separator")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "AI 助手" }));
      expect(await screen.findByRole("dialog", { name: "AI 创作助手" })).toBeVisible();
      expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    } finally {
      if (previousMatchMedia === undefined) {
        Reflect.deleteProperty(window, "matchMedia");
      } else {
        Object.defineProperty(window, "matchMedia", previousMatchMedia);
      }
    }
  });

  it("keeps an existing AI suggestion action unambiguous when正文 is selected", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedProject(runtime);
    await createReadySuggestion(runtime, project, chapter, "建议改写内容");

    renderEditor(runtime, project, chapter);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    const toolbar = document.querySelector(".editor-toolbar");
    if (!(toolbar instanceof HTMLElement)) {
      throw new Error("找不到编辑器顶部操作区");
    }
    expect(within(toolbar).getByRole("button", { name: "查看 AI 建议版本" })).toBeVisible();

    editor.setSelectionRange(0, 3);
    fireEvent.select(editor);

    expect(within(toolbar).getByRole("button", { name: "查看 AI 建议版本" })).toBeVisible();
    expect(within(toolbar).queryByRole("button", { name: "修改选中内容" })).not.toBeInTheDocument();
    expect(screen.queryByText("原生模型网关")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 候选")).not.toBeInTheDocument();
  });

  it("offers a focused rewrite instruction for an exact selection in the desktop app", async () => {
    const runtime = createNativeEditorRuntime();
    await ensureWritingMode(runtime, "professional");
    const { chapter, project } = await seedProject(runtime);

    renderEditor(runtime, project, chapter);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    editor.focus();
    editor.setSelectionRange(0, 3);
    fireEvent.select(editor);
    expect(editor).toHaveFocus();

    const toolbar = document.querySelector(".editor-toolbar");
    if (!(toolbar instanceof HTMLElement)) {
      throw new Error("找不到编辑器顶部操作区");
    }
    const rewriteAction = within(toolbar).getByRole("button", { name: "修改选中内容" });
    expect(rewriteAction).toBeVisible();
    const instruction = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "改写选中的 3 个字符",
    });
    expect(instruction).toHaveValue("保持原意，让表达更自然。");
    expect(screen.getByRole("button", { name: "查看选区改写发送信息" })).toBeEnabled();

    let scheduledFocus: FrameRequestCallback | undefined;
    const animationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        scheduledFocus = callback;
        return 1;
      });
    fireEvent.click(rewriteAction);
    expect(animationFrame).toHaveBeenCalledOnce();
    if (scheduledFocus === undefined) {
      throw new Error("选区改写操作没有安排指令输入框聚焦");
    }
    scheduledFocus(0);
    expect(instruction).toHaveFocus();
    animationFrame.mockRestore();
  });

  it("records a durable derived-story task after an explicit manual save", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    if (preference.mode !== "direct") {
      await runtime.writingExperience.switchMode("direct", preference.revision);
    }
    const { chapter, project } = await seedProject(runtime);
    const user = userEvent.setup();

    renderEditor(runtime, project, chapter);

    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    const modeRead = vi.spyOn(runtime.writingExperience, "getOrInitialize");
    modeRead.mockClear();
    fireEvent.change(editor, {
      target: { value: "第一章正文，手动保存后的新内容。", selectionStart: 16 },
    });
    await user.click(await screen.findByRole("button", { name: "保存正文" }));

    await waitFor(async () => {
      const snapshot = await runtime.taskCenter.load();
      const task = snapshot.tasks.find(({ type }) => type === "story.accepted-version.process");
      expect(task?.status).toBe("succeeded");
      expect(task?.metadata).toMatchObject({
        projectId: project.id,
        chapterId: chapter.id,
        source: "manual_save",
        acceptedCharacterCount: 16,
        organizeLocalStoryFacts: true,
      });
    });

    const versions = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(
      versions.ok && versions.value.some((version) => version.toSnapshot().reason === "manual"),
    ).toBe(true);
    const manualVersion = versions.ok
      ? versions.value
          .map((version) => version.toSnapshot())
          .find(({ reason }) => reason === "manual")
      : undefined;
    expect(manualVersion?.organizeLocalStoryFacts).toBe(true);
    expect(modeRead).toHaveBeenCalledTimes(1);
  });

  it("organizes a sentence completed across one-second autosaves without rescanning an old sentence", async () => {
    window.localStorage.clear();
    saveEditorPreferences(window.localStorage, {
      autosaveEnabled: true,
      autosaveDebounceMs: 1_000,
    });
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    if (preference.mode !== "direct") {
      await runtime.writingExperience.switchMode("direct", preference.revision);
    }
    const { chapter, project } = await seedProject(runtime);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;

    renderEditor(runtime, project, chapter);
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });
    const modeRead = vi.spyOn(runtime.writingExperience, "getOrInitialize");
    modeRead.mockClear();
    const timeout = vi.spyOn(window, "setTimeout");
    const partialContent = "林澈来到钟楼。角色：林";
    fireEvent.change(editor, { target: { value: partialContent, selectionStart: 11 } });
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
    timeout.mockRestore();

    const versionsImmediately = await runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    if (!versionsImmediately.ok) throw versionsImmediately.error;
    expect(versionsImmediately.value).toHaveLength(versionsBefore.value.length);

    let firstVersionId: string | null = null;

    await waitFor(
      async () => {
        const versions = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
        if (!versions.ok) throw versions.error;
        const autosaveVersion = versions.value
          .map((version) => version.toSnapshot())
          .find((version) => version.reason === "autosave" && version.content === partialContent);
        expect(autosaveVersion).toBeDefined();
        if (autosaveVersion === undefined) throw new Error("找不到自动保存版本");
        expect(autosaveVersion.organizeLocalStoryFacts).toBe(true);

        firstVersionId = autosaveVersion.id;
        const facts = await runtime.story.facts.listByProjectId(project.id as never);
        if (!facts.ok) throw facts.error;
        const snapshots = facts.value.map((fact) => fact.toSnapshot());
        const organized = snapshots.find(
          (fact) =>
            fact.factType === "scene_tag" &&
            String(fact.source.versionId) === String(autosaveVersion.id),
        );
        expect(organized).toMatchObject({
          factType: "scene_tag",
          contentText: "林澈出现在钟楼",
          origin: "system",
          status: "unconfirmed",
          needsReview: true,
          userConfirmed: false,
          source: {
            kind: "chapter_span",
            chapterId: chapter.id,
            versionId: autosaveVersion.id,
            startOffset: 0,
            endOffset: 7,
            sourceLength: 11,
            excerpt: "林澈来到钟楼。",
          },
        });
        expect(organized?.structuredValue).toMatchObject({
          payload: {
            evidence: {
              immutableVersionId: autosaveVersion.id,
              locator: { kind: "utf16", startOffset: 0, endOffset: 7, sourceLength: 11 },
            },
          },
        });

        const chapterSummary = snapshots.find(
          (fact) =>
            fact.factType === "chapter_summary" &&
            String(fact.source.versionId) === String(autosaveVersion.id),
        );
        expect(chapterSummary).toMatchObject({
          factType: "chapter_summary",
          contentText: "林澈来到钟楼。",
          origin: "system",
          status: "temporary",
          needsReview: false,
          userConfirmed: false,
          source: {
            chapterId: chapter.id,
            versionId: autosaveVersion.id,
            startOffset: 0,
            endOffset: 7,
            sourceLength: 11,
            excerpt: "林澈来到钟楼。",
          },
          structuredValue: {
            payload: {
              sourceProjectId: project.id,
              sourceChapterId: chapter.id,
              sourceVersionId: autosaveVersion.id,
              authorityMode: "plain_non_authoritative",
              citations: [{ startOffset: 0, endOffset: 7, sourceLength: 11 }],
              generation: {
                providerKind: "本地确定性整理",
                modelId: "首尾句抽取摘要第一版",
              },
            },
          },
        });

        const task = (await runtime.taskCenter.load()).tasks.find(
          (candidate) => candidate.metadata.versionId === autosaveVersion.id,
        );
        expect(task).toMatchObject({
          type: "story.accepted-version.process",
          status: "succeeded",
          metadata: {
            projectId: project.id,
            chapterId: chapter.id,
            source: "autosave",
            organizeLocalStoryFacts: true,
          },
        });
      },
      { timeout: 4_500 },
    );
    expect(generate).not.toHaveBeenCalled();

    const completeContent = "林澈来到钟楼。角色：林澈是守塔人。";
    const secondTimeout = vi.spyOn(window, "setTimeout");
    fireEvent.change(editor, { target: { value: completeContent, selectionStart: 17 } });
    expect(secondTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000);
    secondTimeout.mockRestore();

    await waitFor(
      async () => {
        const versions = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
        if (!versions.ok) throw versions.error;
        const completedVersion = versions.value
          .map((version) => version.toSnapshot())
          .find((version) => version.reason === "autosave" && version.content === completeContent);
        expect(completedVersion).toBeDefined();
        if (completedVersion === undefined) throw new Error("找不到分段输入完成后的版本");
        expect(completedVersion.organizeLocalStoryFacts).toBe(true);

        const facts = await runtime.story.facts.listByProjectId(project.id as never);
        if (!facts.ok) throw facts.error;
        const snapshots = facts.value.map((fact) => fact.toSnapshot());
        expect(
          snapshots.filter(({ contentText }) => contentText === "林澈出现在钟楼"),
        ).toHaveLength(1);
        expect(
          snapshots.find(({ contentText }) => contentText === "林澈出现在钟楼")?.source.versionId,
        ).toBe(firstVersionId);
        const character = snapshots.find(({ factType }) => factType === "character_profile");
        expect(character?.source).toMatchObject({
          chapterId: chapter.id,
          versionId: completedVersion.id,
          startOffset: 7,
          endOffset: 17,
          sourceLength: 17,
          excerpt: "角色：林澈是守塔人。",
        });
        expect(character?.structuredValue).toMatchObject({
          payload: {
            evidence: {
              immutableVersionId: completedVersion.id,
              locator: { kind: "utf16", startOffset: 7, endOffset: 17, sourceLength: 17 },
            },
          },
        });
        const task = (await runtime.taskCenter.load()).tasks.find(
          (candidate) => candidate.metadata.versionId === completedVersion.id,
        );
        expect(task?.status).toBe("succeeded");
        expect(task?.metadata.organizeLocalStoryFacts).toBe(true);
      },
      { timeout: 4_500 },
    );
    expect(generate).not.toHaveBeenCalled();
    expect(modeRead).toHaveBeenCalledTimes(2);
  }, 12_000);
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

function createNativeEditorRuntime(): DesktopRuntime {
  const runtime = createDevelopmentRuntime(window.localStorage);
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    generate: () => Promise.reject(new Error("not used")),
    listModels: () => Promise.reject(new Error("not used")),
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    cancelGeneration: () => Promise.resolve(false),
  };
  return Object.freeze({ ...runtime, mode: "tauri", modelGateway });
}

function renderEditor(runtime: DesktopRuntime, project: Project, chapter: Chapter) {
  return render(
    <MemoryRouter initialEntries={[`/projects/${project.id}/chapters/${chapter.id}`]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <Routes>
            <Route path="/projects/:projectId/chapters/:chapterId" element={<EditorPage />} />
          </Routes>
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function createMediaQueryList(query: string, matches: boolean): MediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
}

async function seedProject(runtime: DesktopRuntime): Promise<{
  readonly project: Project;
  readonly chapter: Chapter;
}> {
  const project = await runtime.useCases.createProject.execute({ name: "简化工作区测试" });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "第一章正文",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return { project: project.value, chapter: chapter.value.chapter };
}

async function createReadySuggestion(
  runtime: DesktopRuntime,
  project: Project,
  chapter: Chapter,
  content: string,
): Promise<void> {
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
  const checksum = await runtime.hasher.sha256(content);
  if (!checksum.ok) {
    throw checksum.error;
  }
  const ready = streaming.value.markReady(content, checksum.value, runtime.clock.now());
  if (!ready.ok) {
    throw ready.error;
  }
  const stored = await runtime.repositories.aiCandidates.create(ready.value);
  if (!stored.ok) {
    throw stored.error;
  }
}
