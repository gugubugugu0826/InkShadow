import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { DesktopShell } from "./desktop-shell";

const projectId = "019f9f4a-b3c7-7350-9226-000000000210";

function RouteHeading() {
  const location = useLocation();
  const title = location.pathname.endsWith("/outline") ? "规划页面标题" : "项目页面标题";

  return (
    <>
      <h1>{title}</h1>
      <output data-testid="current-route">{location.pathname}</output>
    </>
  );
}

function renderShell(
  route: string,
  runtime: DesktopRuntime = createDevelopmentRuntime(window.localStorage),
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <DesktopShell>
          <RouteHeading />
        </DesktopShell>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

describe("DesktopShell", () => {
  it("shows only the four plain-language project areas on project subpages", () => {
    renderShell(`/projects/${projectId}/chapters/chapter-id`);

    const projectNavigation = screen.getByRole("group", { name: "当前项目" });
    const projectLinks = within(projectNavigation).getAllByRole("link");
    const bodyLink = within(projectNavigation).getByRole("link", { name: "正文" });
    expect(projectLinks).toHaveLength(4);
    expect(bodyLink).toHaveAttribute("href", `/projects/${projectId}`);
    expect(bodyLink).toHaveAttribute("aria-current", "page");
    expect(within(projectNavigation).getByRole("link", { name: "规划" })).toHaveAttribute(
      "href",
      `/projects/${projectId}/outline`,
    );
    expect(within(projectNavigation).getByRole("link", { name: "设定" })).toHaveAttribute(
      "href",
      `/projects/${projectId}/story`,
    );
    expect(within(projectNavigation).getByRole("link", { name: "检查" })).toHaveAttribute(
      "href",
      `/projects/${projectId}/checks`,
    );
    expect(screen.queryByRole("link", { name: "项目搜索" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "故事关系图" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "多智能体审查" })).not.toBeInTheDocument();

    const globalNavigation = screen.getByLabelText("全局导航");
    expect(within(globalNavigation).getAllByRole("link")).toHaveLength(2);
    expect(within(globalNavigation).getByRole("link", { name: "创作首页" })).toHaveAttribute(
      "href",
      "/start",
    );
    expect(within(globalNavigation).getByRole("link", { name: "作品库" })).toHaveAttribute(
      "href",
      "/projects",
    );
    const toolNavigation = screen.getByLabelText("工具导航");
    expect(within(toolNavigation).getAllByRole("link")).toHaveLength(4);
    expect(within(toolNavigation).getByRole("link", { name: "任务与通知" })).toHaveAttribute(
      "href",
      "/tasks",
    );
    expect(within(toolNavigation).getByRole("link", { name: "调用与费用" })).toHaveAttribute(
      "href",
      "/usage",
    );
    expect(within(toolNavigation).getByRole("link", { name: "Model Hub" })).toHaveAttribute(
      "href",
      "/settings#model-center",
    );
    expect(within(toolNavigation).getByRole("link", { name: "设置" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByRole("link", { name: "社区模板" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "团队与权限" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导航" })).toHaveAttribute(
      "aria-controls",
      "desktop-primary-navigation",
    );
  });

  it("updates the document title and moves focus to the new route heading", async () => {
    const user = userEvent.setup();
    renderShell(`/projects/${projectId}`);
    expect(document.title).toBe("正文 · InkShadow 墨影");

    await user.click(screen.getByRole("link", { name: "规划" }));

    await waitFor(() => {
      expect(document.title).toBe("规划 · InkShadow 墨影");
      expect(screen.getByRole("heading", { name: "规划页面标题" })).toHaveFocus();
    });
  });

  it("distinguishes Model Hub from general settings when the hash route is active", () => {
    renderShell("/settings#model-center");

    expect(document.title).toBe("Model Hub · InkShadow 墨影");
    expect(screen.getByRole("link", { name: "Model Hub" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "设置" })).not.toHaveAttribute("aria-current");
  });

  it("keeps direct legacy tools under the check area without exposing extra navigation", () => {
    renderShell(`/projects/${projectId}/graph`);

    const projectNavigation = screen.getByRole("group", { name: "当前项目" });
    expect(within(projectNavigation).getAllByRole("link")).toHaveLength(4);
    expect(within(projectNavigation).getByRole("link", { name: "检查" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("link", { name: "故事关系图" })).not.toBeInTheDocument();
  });

  it("lets desktop users collapse and restore the navigation rail", async () => {
    const user = userEvent.setup();
    const rendered = renderShell(`/projects/${projectId}`);
    const shell = rendered.container.querySelector(".ink-app-shell");

    await user.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(shell).toHaveAttribute("data-navigation-collapsed", "true");
    expect(screen.getByRole("link", { name: "作品库" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "正文" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "规划" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设定" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "检查" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(shell).not.toHaveAttribute("data-navigation-collapsed");
  });

  it("maps team review routes and exposes live network status", () => {
    renderShell(`/teams/team-id/projects/${projectId}/reviews`);

    expect(document.title).toBe("团队内容审阅 · InkShadow 墨影");
    const networkStatus = screen.getByText("网络可用");
    expect(networkStatus).toHaveAttribute("role", "status");
    expect(networkStatus).toHaveAttribute("aria-live", "polite");
    expect(networkStatus).toHaveAttribute("aria-atomic", "true");
  });

  it("opens Ctrl+K, filters commands, navigates and returns focus on Escape", async () => {
    const user = userEvent.setup();
    renderShell(`/projects/${projectId}`);
    const trigger = screen.getByRole("button", { name: "搜索页面与命令" });

    trigger.focus();
    await user.keyboard("{Control>}k{/Control}");
    const search = screen.getByRole("searchbox", { name: "搜索命令" });
    await waitFor(() => {
      expect(search).toHaveFocus();
    });
    await user.keyboard("任务");
    expect(search).toHaveAttribute("aria-activedescendant", "command-tasks");
    expect(screen.getByRole("button", { name: /任务与通知/u })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("current-route")).toHaveTextContent("/tasks");
    });
    expect(screen.queryByRole("dialog", { name: "快速前往" })).not.toBeInTheDocument();

    trigger.focus();
    await user.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("searchbox", { name: "搜索命令" })).toHaveFocus();
    });
    expect(screen.getByRole("searchbox", { name: "搜索命令" })).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("searches real chapters and people alongside writing, AI and export commands", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const projectResult = await runtime.useCases.createProject.execute({ name: "命令搜索作品" });
    if (!projectResult.ok) throw projectResult.error;
    const project = projectResult.value;
    const chapterResult = await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "唯一灯塔章节",
      content: "林遥走进灯塔。",
    });
    if (!chapterResult.ok) throw chapterResult.error;
    const chapter = chapterResult.value.chapter;
    const factResult = await runtime.story.factService.createFormalUserFact({
      projectId: project.id,
      factType: "character_identity",
      contentText: "林遥",
      structuredValue: { name: "林遥", subjectKind: "character" },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!factResult.ok) throw factResult.error;

    const user = userEvent.setup();
    renderShell(`/projects/${project.id}`, runtime);
    const trigger = screen.getByRole("button", { name: "搜索页面与命令" });

    await user.click(trigger);
    let search = screen.getByRole("searchbox", { name: "搜索命令" });
    await user.type(search, "唯一灯塔");
    const chapterCommand = await screen.findByRole("button", { name: /章节：唯一灯塔章节/u });
    expect(chapterCommand).toHaveTextContent("写作");
    await user.click(chapterCommand);
    await waitFor(() => {
      expect(screen.getByTestId("current-route")).toHaveTextContent(
        `/projects/${project.id}/chapters/${chapter.id}`,
      );
    });

    await user.click(trigger);
    search = screen.getByRole("searchbox", { name: "搜索命令" });
    await user.type(search, "林遥");
    const characterCommand = await screen.findByRole("button", { name: /人物：林遥/u });
    await user.click(characterCommand);
    await waitFor(() => {
      expect(screen.getByTestId("current-route")).toHaveTextContent(
        `/projects/${project.id}/story`,
      );
    });

    await user.click(trigger);
    search = screen.getByRole("searchbox", { name: "搜索命令" });
    expect(screen.getByRole("button", { name: /生成小说配图/u })).toBeInTheDocument();
    await user.type(search, "PDF");
    expect(screen.getByRole("button", { name: /导出作品/u })).toHaveTextContent("导出");
  });
});
