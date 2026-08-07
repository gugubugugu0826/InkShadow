import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiCandidate, type Chapter, type Project } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { EditorPage } from "./editor-page";

describe("simplified editor workspace", () => {
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

  it("changes the single top action when an AI suggestion can be applied to a selection", async () => {
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

    expect(within(toolbar).getByRole("button", { name: "用 AI 建议修改选中内容" })).toBeVisible();
    expect(screen.queryByText("原生模型网关")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 候选")).not.toBeInTheDocument();
  });
});

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
