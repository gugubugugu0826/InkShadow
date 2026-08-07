import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { DesktopShell } from "./desktop-shell";

const projectId = "019f9f4a-b3c7-7350-9226-000000000210";

function RouteHeading() {
  const location = useLocation();
  const title = location.pathname.endsWith("/outline") ? "规划页面标题" : "项目页面标题";

  return <h1>{title}</h1>;
}

function renderShell(route: string) {
  const runtime = createDevelopmentRuntime(window.localStorage);
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
    expect(within(globalNavigation).getAllByRole("link")).toHaveLength(3);
    expect(within(globalNavigation).getByRole("link", { name: "开始" })).toHaveAttribute(
      "href",
      "/start",
    );
    expect(within(globalNavigation).getByRole("link", { name: "作品库" })).toHaveAttribute(
      "href",
      "/projects",
    );
    expect(within(globalNavigation).getByRole("link", { name: "设置" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(screen.queryByRole("link", { name: "社区模板" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "任务与通知" })).not.toBeInTheDocument();
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
});
