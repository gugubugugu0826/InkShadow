import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEVELOPMENT_DATABASE_KEY } from "../infrastructure/development-storage";
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

async function createProject(
  runtime: DesktopRuntime,
  name: string,
  displayKind?: "author_work" | "test_work" | "builtin_example",
) {
  const result = await runtime.useCases.createProject.execute(
    displayKind === undefined ? { name } : { name, displayKind },
  );
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
  beforeEach(() => {
    window.localStorage.clear();
  });

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
    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects.ok && projects.value).toHaveLength(0);
    expect(await runtime.creativeJourneys.listActive("idea")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "打开恢复工具" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(
      /AI|模型|调用|上下文|路由|令牌|追踪|候选|费用|待确认/u,
    );
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

  it("moves a direct-mode project to the recoverable trash in one click and exposes undo", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.getOrInitialize();
    await createProject(runtime, "纸灯旧梦");
    const user = userEvent.setup();
    renderPage(runtime);

    await screen.findByRole("heading", { name: "纸灯旧梦", level: 2 });
    await user.click(within(projectCard("纸灯旧梦")).getByRole("button", { name: "移到回收站" }));

    expect(screen.queryByRole("dialog", { name: /移到回收站/u })).not.toBeInTheDocument();
    expect(await screen.findByText("项目已移到回收站")).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "纸灯旧梦", level: 2 })).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(await screen.findByRole("heading", { name: "纸灯旧梦", level: 2 })).toBeVisible();
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
  it("links an unfinished project to its exact active idea journey despite a malformed snapshot", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "未完成的钟楼");
    const journeyId = runtime.ids.next();
    const now = runtime.clock.now();
    await runtime.creativeJourneys.create(
      {
        id: journeyId,
        kind: "idea",
        status: "active",
        currentState: "generation_failed",
        projectId: project.id,
        chapterId: null,
        candidateId: null,
        revision: 1,
        snapshot: Object.freeze({ openingSuggestions: "损坏的旧快照" }),
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      {
        id: runtime.ids.next(),
        journeyId,
        sequence: 1,
        kind: "idea",
        questionKey: null,
        generationSource: null,
        providerId: null,
        modelId: null,
        taskKey: null,
        requestId: null,
        snapshot: Object.freeze({}),
        createdAt: now,
      },
    );

    renderPage(runtime);

    await screen.findByRole("heading", { name: "未完成的钟楼", level: 2 });
    const card = projectCard("未完成的钟楼");
    expect(await within(card).findByText("未完成创作")).toBeVisible();
    expect(within(card).getByText(/继续后仍由你决定使用或放弃结果/u)).toBeVisible();
    expect(within(card).getByRole("link", { name: "继续未完成创作" })).toHaveAttribute(
      "href",
      "/create/idea?journey=" + journeyId,
    );
    expect(within(card).getByText("完成或结束这次创作后即可重命名作品。")).toBeVisible();
    expect(within(card).getByRole("button", { name: "重命名" })).toBeDisabled();
  });

  it("recovers a created project from its persisted plan when the journey scope write failed", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const projectId = runtime.ids.next();
    const chapterId = runtime.ids.next();
    const initialVersionId = runtime.ids.next();
    const projectName = "关联保存失败的作品";
    const created = await runtime.useCases.createProject.execute({
      name: projectName,
      plannedId: projectId,
    });
    if (!created.ok) throw created.error;

    const journeyId = runtime.ids.next();
    const now = runtime.clock.now();
    await runtime.creativeJourneys.create(
      {
        id: journeyId,
        kind: "idea",
        status: "active",
        currentState: "creating_chapter",
        projectId: null,
        chapterId: null,
        candidateId: null,
        revision: 1,
        snapshot: Object.freeze({
          version: 1,
          provisioningPlan: Object.freeze({
            projectId,
            chapterId,
            initialVersionId,
            projectName,
          }),
        }),
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      {
        id: runtime.ids.next(),
        journeyId,
        sequence: 1,
        kind: "idea",
        questionKey: null,
        generationSource: null,
        providerId: null,
        modelId: null,
        taskKey: null,
        requestId: null,
        snapshot: Object.freeze({}),
        createdAt: now,
      },
    );

    renderPage(runtime);

    await screen.findByRole("heading", { name: projectName, level: 2 });
    const card = projectCard(projectName);
    expect(await within(card).findByText("未完成创作")).toBeVisible();
    expect(within(card).getByRole("link", { name: "继续未完成创作" })).toHaveAttribute(
      "href",
      "/create/idea?journey=" + journeyId,
    );
  });

  it("stops automatic recovery when two active journeys point at the same project", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "存在冲突的作品");
    const now = runtime.clock.now();
    const journeyIds = [runtime.ids.next(), runtime.ids.next()] as const;
    for (const journeyId of journeyIds) {
      await runtime.creativeJourneys.create(
        {
          id: journeyId,
          kind: "idea",
          status: "active",
          currentState: "generation_failed",
          projectId: project.id,
          chapterId: null,
          candidateId: null,
          revision: 1,
          snapshot: Object.freeze({ openingSuggestions: "损坏的旧快照" }),
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        },
        {
          id: runtime.ids.next(),
          journeyId,
          sequence: 1,
          kind: "idea",
          questionKey: null,
          generationSource: null,
          providerId: null,
          modelId: null,
          taskKey: null,
          requestId: null,
          snapshot: Object.freeze({}),
          createdAt: now,
        },
      );
    }

    renderPage(runtime);

    await screen.findByRole("heading", { name: project.name, level: 2 });
    expect(screen.getByText("未完成创作记录存在冲突")).toBeVisible();
    expect(screen.getByText(/1 个作品同时关联了多条未完成创作记录/u)).toBeVisible();
    const card = projectCard(project.name);
    expect(within(card).queryByText("未完成创作")).not.toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: "继续未完成创作" })).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "打开" })).toHaveAttribute(
      "href",
      "/projects/" + project.id,
    );
  });

  it("keeps the project list usable and offers retry when unfinished journeys cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await createProject(runtime, "仍可打开的作品");
    const listActive = vi
      .spyOn(runtime.creativeJourneys, "listActive")
      .mockRejectedValueOnce(new Error("simulated journey read failure"));
    const user = userEvent.setup();

    renderPage(runtime);

    expect(await screen.findByRole("heading", { name: "仍可打开的作品", level: 2 })).toBeVisible();
    expect(screen.getByText("未完成创作读取失败")).toBeVisible();
    expect(screen.getByRole("link", { name: "打开" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.queryByText("未完成创作读取失败")).not.toBeInTheDocument());
    expect(listActive).toHaveBeenCalledTimes(2);
  });

  it("keeps an ordinarily created unnamed story in the author library without inferring from its name", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await createProject(runtime, "未命名新故事");

    renderPage(runtime);

    const authorSection = await screen.findByRole("region", { name: "作者作品" });
    expect(
      within(authorSection).getByRole("heading", { name: "未命名新故事", level: 2 }),
    ).toBeVisible();
    expect(screen.queryByRole("region", { name: "测试与示例" })).not.toBeInTheDocument();
  });

  it("separates explicit test work and persists reversible author classification", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await createProject(runtime, "作者手稿");
    await createProject(runtime, "回归验证作品", "test_work");
    const user = userEvent.setup();
    const view = renderPage(runtime);

    let authorSection = await screen.findByRole("region", { name: "作者作品" });
    let specialSection = screen.getByRole("region", { name: "测试与示例" });
    expect(
      within(authorSection).getByRole("heading", { name: "作者手稿", level: 2 }),
    ).toBeVisible();
    expect(
      within(specialSection).getByRole("heading", { name: "回归验证作品", level: 2 }),
    ).toBeVisible();

    await user.click(
      within(projectCard("作者手稿")).getByRole("button", { name: "标记为测试作品" }),
    );
    specialSection = await screen.findByRole("region", { name: "测试与示例" });
    expect(
      within(specialSection).getByRole("heading", { name: "作者手稿", level: 2 }),
    ).toBeVisible();

    await user.click(
      within(projectCard("回归验证作品")).getByRole("button", { name: "移回作者作品" }),
    );
    authorSection = await screen.findByRole("region", { name: "作者作品" });
    expect(
      within(authorSection).getByRole("heading", { name: "回归验证作品", level: 2 }),
    ).toBeVisible();

    view.unmount();
    renderPage(createDevelopmentRuntime(window.localStorage));
    expect(
      within(await screen.findByRole("region", { name: "作者作品" })).getByRole("heading", {
        name: "回归验证作品",
        level: 2,
      }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "测试与示例" })).getByRole("heading", {
        name: "作者手稿",
        level: 2,
      }),
    ).toBeVisible();
  });

  it("shows protected examples separately and hides system evaluation projects", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await createProject(runtime, "阅读示例", "builtin_example");
    const systemProject = await createProject(runtime, "系统校验样本");
    rewriteStoredIdentity(systemProject.id, "system_evaluation", "evaluation_project_id");

    renderPage(createDevelopmentRuntime(window.localStorage));

    expect(await screen.findByRole("heading", { name: "还没有作品", level: 2 })).toBeVisible();
    const specialSection = screen.getByRole("region", { name: "测试与示例" });
    const exampleCard = within(specialSection)
      .getByRole("heading", { name: "阅读示例", level: 2 })
      .closest<HTMLElement>(".ink-card");
    if (exampleCard === null) throw new Error("找不到示例作品卡片。");
    expect(within(exampleCard).getByText("示例作品")).toBeVisible();
    expect(
      within(exampleCard).queryByRole("button", { name: /作者作品|测试作品/u }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "系统校验样本" })).not.toBeInTheDocument();
  });

  it("isolates one identity read failure, keeps the project openable, and retries classification", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "仍可阅读的正文");
    const resolveIdentity = vi
      .spyOn(runtime.repositories.projectDisplayIdentities, "resolveByProjectId")
      .mockRejectedValueOnce(new Error("simulated identity read failure"));
    const user = userEvent.setup();

    renderPage(runtime);

    expect(await screen.findByText("部分作品分类暂时无法读取")).toBeVisible();
    const card = projectCard(project.name);
    expect(within(card).getByRole("link", { name: "打开" })).toHaveAttribute(
      "href",
      `/projects/${project.id}`,
    );
    await user.click(screen.getByRole("button", { name: "重新读取分类" }));
    await waitFor(() => {
      expect(screen.queryByText("部分作品分类暂时无法读取")).not.toBeInTheDocument();
    });
    expect(resolveIdentity).toHaveBeenCalledTimes(2);
  });

  it("treats a legacy unknown identity as author work and lets the author confirm it", async () => {
    const initialRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(initialRuntime, "旧版迁入作品");
    removeStoredIdentity(project.id);
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();

    renderPage(runtime);

    const authorSection = await screen.findByRole("region", { name: "作者作品" });
    expect(
      within(authorSection).getByRole("heading", { name: project.name, level: 2 }),
    ).toBeVisible();
    const card = projectCard(project.name);
    await user.click(within(card).getByRole("button", { name: "确认是作者作品" }));
    await waitFor(async () => {
      const identity = await runtime.repositories.projectDisplayIdentities.resolveByProjectId(
        project.id,
      );
      expect(identity.ok && identity.value?.provenance).toBe("explicit_creation");
    });
  });

  it("keeps the author project usable when a classification write fails", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "写入失败仍安全");
    const writeIdentity = vi
      .spyOn(runtime.repositories.projectDisplayIdentities, "recordTestWork")
      .mockRejectedValueOnce(new Error("simulated identity write failure"));
    const user = userEvent.setup();

    renderPage(runtime);

    await screen.findByRole("heading", { name: project.name, level: 2 });
    const card = projectCard(project.name);
    await user.click(within(card).getByRole("button", { name: "标记为测试作品" }));
    expect(await screen.findByText("作品分类尚未更改")).toBeVisible();
    expect(within(projectCard(project.name)).getByRole("link", { name: "打开" })).toHaveAttribute(
      "href",
      `/projects/${project.id}`,
    );
    expect(screen.getByRole("region", { name: "作者作品" })).toContainElement(
      screen.getByRole("heading", { name: project.name, level: 2 }),
    );
    expect(writeIdentity).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["archived", "归档", "查看归档"],
    ["trashed", "回收", "查看回收站"],
  ] as const)(
    "keeps explicit classification in the selected %s status",
    async (targetStatus, label, navigationLabel) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const author = await createProject(runtime, `${label}作者作品`);
      const testWork = await createProject(runtime, `${label}测试作品`, "test_work");
      const example = await createProject(runtime, `${label}示例作品`, "builtin_example");
      const system = await createProject(runtime, `${label}系统样本`);
      for (const project of [author, testWork, example, system]) {
        const result =
          targetStatus === "archived"
            ? await runtime.useCases.archiveProject.execute({ projectId: project.id })
            : await runtime.useCases.trashProject.execute({ projectId: project.id });
        if (!result.ok) throw result.error;
      }
      rewriteStoredIdentity(system.id, "system_evaluation", "evaluation_project_id");
      const user = userEvent.setup();

      renderPage(createDevelopmentRuntime(window.localStorage));
      await user.click(await screen.findByRole("button", { name: navigationLabel }));

      const authorSection = await screen.findByRole("region", { name: "作者作品" });
      const specialSection = screen.getByRole("region", { name: "测试与示例" });
      expect(within(authorSection).getByText(author.name)).toBeVisible();
      expect(within(specialSection).getByText(testWork.name)).toBeVisible();
      expect(within(specialSection).getByText(example.name)).toBeVisible();
      expect(screen.queryByText(system.name)).not.toBeInTheDocument();
    },
  );
});

interface MutableIdentityDatabase {
  projectDisplayIdentities?: {
    projectId: string;
    displayKind: string;
    provenance: string;
    recordedAt: string;
    revision: number;
  }[];
  projectDisplayIdentityRevisions?: {
    projectId: string;
    displayKind: string;
    provenance: string;
    recordedAt: string;
    revision: number;
    previousDisplayKind: string | null;
  }[];
}

function readMutableDatabase(): MutableIdentityDatabase {
  const serialized = window.localStorage.getItem(DEVELOPMENT_DATABASE_KEY);
  if (serialized === null) throw new Error("开发数据库不存在。");
  return JSON.parse(serialized) as MutableIdentityDatabase;
}

function writeMutableDatabase(database: MutableIdentityDatabase): void {
  window.localStorage.setItem(DEVELOPMENT_DATABASE_KEY, JSON.stringify(database));
}

function removeStoredIdentity(projectId: string): void {
  const database = readMutableDatabase();
  if (database.projectDisplayIdentities !== undefined) {
    database.projectDisplayIdentities = database.projectDisplayIdentities.filter(
      (identity) => identity.projectId !== projectId,
    );
  }
  if (database.projectDisplayIdentityRevisions !== undefined) {
    database.projectDisplayIdentityRevisions = database.projectDisplayIdentityRevisions.filter(
      (identity) => identity.projectId !== projectId,
    );
  }
  writeMutableDatabase(database);
}

function rewriteStoredIdentity(
  projectId: string,
  displayKind: "system_evaluation",
  provenance: "evaluation_project_id",
): void {
  const database = readMutableDatabase();
  const identity = database.projectDisplayIdentities?.find((item) => item.projectId === projectId);
  if (identity === undefined) throw new Error("项目分类记录不存在。");
  identity.displayKind = displayKind;
  identity.provenance = provenance;
  const revision = database.projectDisplayIdentityRevisions?.find(
    (item) => item.projectId === projectId,
  );
  if (revision !== undefined) {
    revision.displayKind = displayKind;
    revision.provenance = provenance;
  }
  writeMutableDatabase(database);
}
