import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { ProjectsPage } from "./projects-page";

const IMPORT_JOURNEY_STORAGE_KEY = "inkshadow.import-rewrite-journey.v2";

function renderPage(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter initialEntries={["/projects"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <ProjectsPage />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

async function createProject(runtime: DesktopRuntime, name: string) {
  const result = await runtime.useCases.createProject.execute({ name });
  if (!result.ok) throw result.error;
  return result.value;
}

function projectCard(name: string): HTMLElement {
  const heading = screen.getByRole("heading", { name, level: 2 });
  const card = heading.closest<HTMLElement>(".ink-card");
  if (card === null) throw new Error(`找不到作品卡片：${name}`);
  return card;
}

describe("ProjectsPage library states", () => {
  it("shows only the task-led idea and import entrances for a truly empty library", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    renderPage(runtime);

    expect(await screen.findByRole("heading", { name: "还没有作品", level: 2 })).toBeVisible();
    expect(screen.getByRole("link", { name: "从想法开始" })).toHaveAttribute(
      "href",
      "/create/idea",
    );
    expect(screen.getByRole("link", { name: "导入已有小说" })).toHaveAttribute(
      "href",
      "/create/import",
    );
    expect(screen.queryByRole("link", { name: "打开恢复工具" })).not.toBeInTheDocument();
  });

  it("does not mistake an all-archived library for first launch", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "雾港来信");
    const archived = await runtime.useCases.archiveProject.execute({ projectId: project.id });
    if (!archived.ok) throw archived.error;
    const user = userEvent.setup();
    renderPage(runtime);

    expect(
      await screen.findByRole("heading", { name: "没有进行中的作品", level: 2 }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "还没有作品" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看归档" }));
    expect(await screen.findByRole("heading", { name: "雾港来信", level: 2 })).toBeVisible();
  });

  it("offers clear-search and archived-project paths for a real no-result query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await createProject(runtime, "星河手记");
    const archivedProject = await createProject(runtime, "龙舟旧梦");
    const archived = await runtime.useCases.archiveProject.execute({
      projectId: archivedProject.id,
    });
    if (!archived.ok) throw archived.error;
    const user = userEvent.setup();
    renderPage(runtime);

    await user.type(await screen.findByRole("searchbox", { name: "搜索项目" }), "龙舟");
    expect(
      await screen.findByRole("heading", {
        name: "没有与“龙舟”匹配的作品",
        level: 2,
      }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "清除搜索" })).toBeVisible();
    expect(screen.getByRole("button", { name: "查看归档" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "查看归档" }));
    await user.click(await screen.findByRole("button", { name: "清除搜索" }));
    expect(await screen.findByRole("heading", { name: "龙舟旧梦", level: 2 })).toBeVisible();
  });

  it("requires confirmation, keeps cancel and archive alternatives, and preserves 30-day recovery", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await createProject(runtime, "山海食单");
    await createProject(runtime, "雨夜邮局");
    const user = userEvent.setup();
    renderPage(runtime);

    await screen.findByRole("heading", { name: "山海食单", level: 2 });
    await user.click(within(projectCard("山海食单")).getByRole("button", { name: "移到回收站" }));
    let dialog = screen.getByRole("dialog", { name: "将《山海食单》移到回收站？" });
    expect(within(dialog).getByText(/30 天内可以从回收站恢复/u)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "改为归档" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(
      screen.queryByRole("dialog", { name: "将《山海食单》移到回收站？" }),
    ).not.toBeInTheDocument();

    await user.click(within(projectCard("山海食单")).getByRole("button", { name: "移到回收站" }));
    dialog = screen.getByRole("dialog", { name: "将《山海食单》移到回收站？" });
    await user.click(within(dialog).getByRole("button", { name: "改为归档" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "山海食单", level: 2 })).not.toBeInTheDocument();
    });
    const archivedProjects = await runtime.useCases.listProjects.execute({
      statuses: ["archived"],
    });
    expect(archivedProjects.ok && archivedProjects.value.map(({ name }) => name)).toContain(
      "山海食单",
    );

    await user.click(within(projectCard("雨夜邮局")).getByRole("button", { name: "移到回收站" }));
    dialog = screen.getByRole("dialog", { name: "将《雨夜邮局》移到回收站？" });
    await user.click(within(dialog).getByRole("button", { name: "移到回收站" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "将《雨夜邮局》移到回收站？" }),
      ).not.toBeInTheDocument();
    });

    const trashedProjects = await runtime.useCases.listProjects.execute({
      statuses: ["trashed"],
    });
    expect(trashedProjects.ok && trashedProjects.value).toHaveLength(1);
    if (!trashedProjects.ok || trashedProjects.value[0] === undefined) {
      throw new Error("作品未进入可恢复的回收站。");
    }
    expect(trashedProjects.value[0].retentionUntil).not.toBeNull();

    await user.click(screen.getByRole("tab", { name: "回收站" }));
    expect(await screen.findByRole("heading", { name: "雨夜邮局", level: 2 })).toBeVisible();
    expect(screen.getByText(/可恢复至/u)).toBeVisible();
    await user.click(within(projectCard("雨夜邮局")).getByRole("button", { name: "恢复" }));
    await user.click(screen.getByRole("tab", { name: "进行中" }));
    expect(await screen.findByRole("heading", { name: "雨夜邮局", level: 2 })).toBeVisible();
  });

  it("projects only persisted import checkpoints and explicitly avoids a fabricated percentage", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "旧稿合集");
    window.localStorage.setItem(
      IMPORT_JOURNEY_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        importedWork: {
          projectId: project.id,
          firstChapterId: "019f9f4a-b3c7-7350-9226-000000000201",
          projectName: project.name,
          chapterCount: 4,
        },
        goal: "保留剧情，让对话更自然",
        selectedPresetIds: [],
        trial: null,
        rulesSavedAt: null,
        workAnalysis: {
          completedAt: null,
          jobs: [{ status: "ready" }, { status: "running" }, { status: "pending" }],
        },
      }),
    );
    renderPage(runtime);

    expect(await screen.findByRole("heading", { name: "《旧稿合集》", level: 2 })).toBeVisible();
    const steps = screen.getByRole("list", { name: "已保存的导入步骤" });
    expect(within(steps).getByText("已保存 1/3 项，待继续")).toBeVisible();
    expect(within(steps).getByText("目标已保存，待试改")).toBeVisible();
    expect(screen.getByText(/实时进度只在导入页显示；离开后不会猜测百分比/u)).toBeVisible();
    expect(screen.getByRole("link", { name: "继续导入改写" })).toHaveAttribute(
      "href",
      "/create/import",
    );
  });
});
