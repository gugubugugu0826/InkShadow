import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { GovernedCreativeExtensionsRoutePage } from "./governed-creative-extensions-route-page";

describe("GovernedCreativeExtensionsRoutePage", () => {
  it("rejects malformed route authority", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    renderRoute(runtime, "/projects/not-a-uuid/chapters/not-a-uuid/extensions");

    expect(await screen.findByText("无法打开创作扩展")).toBeVisible();
    expect(screen.queryByText("EXTENSION_ROUTE_INVALID")).not.toBeInTheDocument();
  });

  it("does not impersonate the production governed runtime in browser development", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "浏览器边界" });
    expect(project.ok).toBe(true);
    if (!project.ok) {
      return;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "正文。",
    });
    expect(chapter.ok).toBe(true);
    if (!chapter.ok) {
      return;
    }

    renderRoute(
      runtime,
      `/projects/${project.value.id}/chapters/${chapter.value.chapter.id}/extensions`,
    );

    expect(await screen.findByText("创作扩展仅在桌面安全运行时可用")).toBeVisible();
    expect(screen.getByText(/不会伪装桌面数据库审计/)).toBeVisible();
  });
});

function renderRoute(runtime: ReturnType<typeof createDevelopmentRuntime>, path: string): void {
  render(
    <RuntimeProvider runtime={runtime}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/projects/:projectId/chapters/:chapterId/extensions"
            element={<GovernedCreativeExtensionsRoutePage />}
          />
        </Routes>
      </MemoryRouter>
    </RuntimeProvider>,
  );
}
