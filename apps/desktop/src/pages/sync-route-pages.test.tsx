import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { ProjectSyncRoutePage } from "./project-sync-route-page";
import { SyncConflictResolutionRoutePage } from "./sync-conflict-resolution-route-page";

describe("project sync route boundaries", () => {
  it("does not simulate cloud sync in browser development", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.useCases.createProject.execute({ name: "仅本机" });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    renderRoute(runtime, `/projects/${created.value.id}/sync`, <ProjectSyncRoutePage />);

    expect(await screen.findByText("此构建未启用项目云同步")).toBeVisible();
    expect(screen.getByText(/浏览器开发模式不会伪装云端状态/)).toBeVisible();
  });

  it("keeps conflict handling fail-closed without device key authority", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const created = await runtime.useCases.createProject.execute({ name: "冲突边界" });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    renderRoute(
      runtime,
      `/projects/${created.value.id}/sync/conflicts`,
      <SyncConflictResolutionRoutePage />,
    );

    expect(await screen.findByText("冲突处理运行时不可用")).toBeVisible();
    expect(screen.getByText(/双方版本不会被静默覆盖/)).toBeVisible();
  });

  it("rejects a malformed project authority", () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    renderRoute(runtime, "/projects/not-a-uuid/sync", <ProjectSyncRoutePage />);

    expect(screen.getByText("无法打开项目同步")).toBeVisible();
    expect(screen.getByText("项目标识无效。请返回项目列表并重新选择。")).toBeVisible();
    expect(document.body).not.toHaveTextContent("SYNC_CONTROL_ROUTE_INVALID");
  });

  it("keeps malformed conflict routes free of internal error codes", () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    renderRoute(
      runtime,
      "/projects/not-a-uuid/sync/conflicts",
      <SyncConflictResolutionRoutePage />,
    );

    expect(screen.getByText("无法打开冲突处理")).toBeVisible();
    expect(screen.getByText("项目标识无效。请返回项目列表并重新选择。")).toBeVisible();
    expect(document.body).not.toHaveTextContent("SYNC_CONFLICT_ROUTE_INVALID");
  });
});

function renderRoute(
  runtime: ReturnType<typeof createDevelopmentRuntime>,
  path: string,
  element: ReactNode,
): void {
  render(
    <RuntimeProvider runtime={runtime}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/:projectId/sync/*" element={element} />
        </Routes>
      </MemoryRouter>
    </RuntimeProvider>,
  );
}
