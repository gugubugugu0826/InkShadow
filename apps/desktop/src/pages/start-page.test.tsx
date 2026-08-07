import { ToastProvider } from "@inkshadow/ui";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
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

  it("presents the three creation paths with one recommended starting point", () => {
    renderStartPage();

    expect(
      screen.getByRole("heading", { name: "一句想法，也能开始一部长篇", level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /从一个想法开始/ })).toHaveAttribute(
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
    expect(screen.getByText("推荐首次使用")).toBeVisible();
  });

  it("keeps the library and backup recovery available as secondary actions", () => {
    renderStartPage();

    expect(screen.getByRole("link", { name: "打开最近创作与作品库" })).toHaveAttribute(
      "href",
      "/projects",
    );
    expect(screen.getByRole("link", { name: "从备份恢复" })).toHaveAttribute(
      "href",
      "/settings#data-transfer",
    );
    expect(screen.getByRole("heading", { name: "作品留在你的设备", level: 2 })).toBeVisible();
  });

  it("creates a real local example project and opens its stable chapter", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
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

  it("does not expose a dead login link when cloud identity is disabled", () => {
    renderStartPage();

    expect(screen.getByText("云账户可稍后连接，本地创作功能保持完整。")).toBeVisible();
    expect(screen.queryByRole("link", { name: "登录已有云账户" })).not.toBeInTheDocument();
  });

  it("does not expose a dead login link after cloud identity fails closed", () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const runtime = {
      ...baseRuntime,
      mode: "tauri",
      featureFlags: {
        ...baseRuntime.featureFlags,
        cloudIdentity: true,
      },
      cloudIdentity: {
        available: false,
      },
    } as unknown as DesktopRuntime;

    renderStartPage(runtime);

    expect(screen.getByText("云账户可稍后连接，本地创作功能保持完整。")).toBeVisible();
    expect(screen.queryByRole("link", { name: "登录已有云账户" })).not.toBeInTheDocument();
  });

  it("only offers cloud login when the runtime confirms that it is available", () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const runtime = {
      ...baseRuntime,
      featureFlags: {
        ...baseRuntime.featureFlags,
        cloudIdentity: true,
      },
      cloudIdentity: {
        available: true,
      },
    } as unknown as DesktopRuntime;

    renderStartPage(runtime);

    expect(screen.getByRole("link", { name: "登录已有云账户" })).toHaveAttribute(
      "href",
      "/auth/login",
    );
  });
});
