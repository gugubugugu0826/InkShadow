import { ToastProvider } from "@inkshadow/ui";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  saveEditorView,
} from "../infrastructure/editor-view-state-store";
import { RuntimeProvider } from "../runtime-context";
import { StartPage } from "./start-page";

function renderStartPage(runtime = createDevelopmentRuntime(window.localStorage)) {
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <Routes>
            <Route path="/start" element={<StartPage />} />
            <Route
              path="/projects/:projectId/chapters/:chapterId"
              element={<p>示例正文已打开</p>}
            />
          </Routes>
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

describe("local-first start page", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("gives a new local user one plain-language creation action", async () => {
    renderStartPage();

    expect(await screen.findByRole("heading", { name: "开始写你的故事", level: 1 })).toBeVisible();
    expect(screen.getByRole("link", { name: "开始创作" })).toHaveAttribute("href", "/create/idea");
    expect(screen.queryByText("直接模式")).not.toBeInTheDocument();
    expect(screen.queryByText("专业模式")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".start-page__entry")).toHaveLength(0);
  });

  it("keeps an empty direct-mode home free of technical creation choices", async () => {
    renderStartPage();

    await screen.findByRole("link", { name: "开始创作" });
    expect(screen.queryByRole("heading", { name: "回到刚才停下的地方" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /导入小说/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /专业/u })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".start-page__entry")).toHaveLength(0);
  });

  it("does not require a first-use confirmation or call a model from the home page", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    renderStartPage(runtime);

    await screen.findByRole("link", { name: "开始创作" });
    expect(
      screen.queryByRole("dialog", { name: "启用直接模式前，请确认一次" }),
    ).not.toBeInTheDocument();
    expect(await runtime.writingExperience.getOrInitialize()).toMatchObject({
      mode: "direct",
    });
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("keeps the three established creation paths in professional mode", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    renderStartPage(runtime);

    expect(await screen.findByRole("link", { name: /从一个想法开始/ })).toHaveAttribute(
      "href",
      "/create/idea",
    );
    expect(screen.getByRole("link", { name: /导入小说，继续写或改写/ })).toHaveAttribute(
      "href",
      "/create/import",
    );
    expect(screen.getByRole("link", { name: /专业创建/ })).toHaveAttribute(
      "href",
      "/create/professional",
    );
    expect(document.querySelectorAll(".start-page__entry")).toHaveLength(3);
  });

  it("continues the real most recently edited chapter and reports its saved cursor", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "海边电台" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第三章 潮声",
      content: "潮水退去以后，她在礁石间找到那台仍在播放的收音机。",
    });
    if (!chapter.ok) throw chapter.error;
    saveEditorView(window.localStorage, {
      projectId: project.value.id,
      chapterId: chapter.value.chapter.id,
      selection: { start: 8, end: 8 },
      scrollTop: 240,
      typography: DEFAULT_EDITOR_TYPOGRAPHY,
      updatedAt: 2_000_000_000_000,
    });

    renderStartPage(runtime);

    expect(await screen.findByRole("heading", { name: "回到刚才停下的地方" })).toBeVisible();
    expect(screen.getByText("海边电台")).toBeVisible();
    expect(screen.getByText("第三章 潮声")).toBeVisible();
    expect(screen.getByText("第 8 个字符后")).toBeVisible();
    expect(screen.getByRole("link", { name: "继续写" })).toHaveAttribute(
      "href",
      `/projects/${project.value.id}/chapters/${chapter.value.chapter.id}`,
    );
  });

  it("keeps only the library as a secondary action in direct mode", async () => {
    renderStartPage();

    expect(await screen.findByRole("link", { name: "浏览作品库" })).toHaveAttribute(
      "href",
      "/projects",
    );
    expect(screen.queryByRole("link", { name: "恢复备份" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "体验示例作品" })).not.toBeInTheDocument();
  });

  it("keeps the real example project available in professional mode", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    const user = userEvent.setup();
    renderStartPage(runtime);

    await user.click(screen.getByRole("button", { name: "体验示例作品" }));

    expect(await screen.findByText("示例正文已打开")).toBeVisible();
    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects.ok && projects.value.some(({ name }) => name === "墨影示例：雨夜来信")).toBe(
      true,
    );
    if (!projects.ok) {
      throw projects.error;
    }
    const example = projects.value.find(({ name }) => name === "墨影示例：雨夜来信");
    if (example === undefined) {
      throw new Error("示例项目没有创建成功");
    }
    const chapters = await runtime.repositories.chapters.listByProjectId(example.id);
    expect(chapters.ok && chapters.value[0]?.content).toContain("不要在今晚十点以后");
  });

  it("keeps cloud account concepts out of the default local-first home", () => {
    renderStartPage();

    expect(screen.queryByRole("link", { name: "登录已有云账户" })).not.toBeInTheDocument();
  });
});
