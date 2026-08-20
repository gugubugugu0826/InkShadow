import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { ok } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import type { ProjectSearchService } from "../infrastructure/project-search";
import type { ProjectEmbeddingDiagnostics } from "../infrastructure/project-search-vector-service";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("ProjectSearchPage", () => {
  it("rebuilds local content, explains capability fallback, and opens the source", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "星港档案" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第七航道",
      content: "领航员在第七航道发现了一枚失效的星图核心。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/search`);

    expect(
      await screen.findByRole("heading", { name: "搜索 · 星港档案", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/^\d+ 个索引片段$/u)).toBeInTheDocument();
    expect(screen.getByText("向量：未配置")).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: /搜索词/u }), "星图核心");
    await user.click(screen.getByRole("button", { name: "搜索" }));

    const resultHeading = await screen.findByRole("heading", { name: "第七航道" });
    const resultCard = resultHeading.closest(".ink-card");
    if (!(resultCard instanceof HTMLElement)) {
      throw new Error("找不到搜索结果卡片。");
    }
    expect(within(resultCard).getByText(/领航员在第七航道/u)).toBeInTheDocument();
    expect(within(resultCard).getByText("关键词")).toBeInTheDocument();
    expect(within(resultCard).getByRole("link", { name: "打开来源" })).toHaveAttribute(
      "href",
      `/projects/${project.value.id}/chapters/${chapter.value.chapter.id}`,
    );
    expect(within(resultCard).getByText("来源版本：已绑定")).toBeVisible();
    expect(resultCard).not.toHaveTextContent(chapter.value.chapter.currentVersionId);
    expect(screen.getByText(/浏览器开发模式不提供真实嵌入能力/u)).toBeInTheDocument();
  });

  it("keeps remote vector rebuild closed and searches without Provider dispatch", async () => {
    const development = createDevelopmentRuntime(window.localStorage);
    const project = await development.useCases.createProject.execute({ name: "远程向量披露" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await development.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "需要被明确授权的稳定正文。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    const diagnostics = remoteDiagnostics();
    const rebuildVectorProject = vi.fn<ProjectSearchService["rebuildVectorProject"]>(() =>
      Promise.resolve(ok(development.search.health())),
    );
    const search: ProjectSearchService = {
      rebuildProject: (projectId) => development.search.rebuildProject(projectId),
      rebuildVectorProject,
      disableVectorProject: (projectId) => development.search.disableVectorProject(projectId),
      inspectEmbedding: () => Promise.resolve(ok(diagnostics)),
      search: (projectId, query, limit) => development.search.search(projectId, query, limit),
      searchFtsOnly: (projectId, query, scope, limit) =>
        development.search.searchFtsOnly(projectId, query, scope, limit),
      health: () => development.search.health(),
      embeddingDiagnostics: () => diagnostics,
      synchronizationDiagnostics: () => development.search.synchronizationDiagnostics(),
    };
    const runtime: DesktopRuntime = {
      ...development,
      mode: "tauri",
      search,
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderRoute(runtime, `/projects/${project.value.id}/search`);

    expect(
      await screen.findByText(/当前版本不会从普通搜索页发起向量重建或查询嵌入/u),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/https:\/\/models\.example\/tenant\/v1\/embeddings/u),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "向量重建尚未开放" })).toBeDisabled();
    expect(rebuildVectorProject).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

function remoteDiagnostics(): ProjectEmbeddingDiagnostics {
  return {
    status: "rebuild_required",
    reason: "vector_index_not_built",
    providerId: "remote-embedding",
    provider: "open_ai_compatible",
    model: "embed-primary",
    dimension: null,
    embeddingCount: 0,
    generation: null,
    destination: "remote",
    endpointOrigin: "https://models.example",
    endpointUrl: "https://models.example/tenant/v1/embeddings",
    confirmationId: "embedding-profile:confirmed-endpoint",
    lastRebuiltAt: null,
    queryFailureCode: null,
  };
}

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
