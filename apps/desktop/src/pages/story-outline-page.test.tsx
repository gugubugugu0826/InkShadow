import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUuidV7 } from "@inkshadow/story-core";
import { StoryCoreError } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { readSafeUiRouteIncidents } from "../infrastructure/ui-route-diagnostics";
import { RuntimeProvider } from "../runtime-context";

describe("StoryOutlinePage", () => {
  it("keeps the newest project visible when an earlier project read finishes last", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = await runtime.useCases.createProject.execute({ name: "先前项目" });
    const currentProject = await runtime.useCases.createProject.execute({ name: "当前项目" });
    if (!firstProject.ok) throw firstProject.error;
    if (!currentProject.ok) throw currentProject.error;
    const originalFindById = runtime.repositories.projects.findById.bind(
      runtime.repositories.projects,
    );
    const delayedRead = deferred<Awaited<ReturnType<typeof originalFindById>>>();
    let heldFirstRead = false;
    const findById = vi
      .spyOn(runtime.repositories.projects, "findById")
      .mockImplementation((projectId) => {
        if (projectId === firstProject.value.id && !heldFirstRead) {
          heldFirstRead = true;
          return delayedRead.promise;
        }
        return originalFindById(projectId);
      });
    const user = userEvent.setup();
    renderNavigableRoute(
      runtime,
      `/projects/${firstProject.value.id}/outline`,
      `/projects/${currentProject.value.id}/outline`,
    );

    await waitFor(() => expect(findById).toHaveBeenCalledWith(firstProject.value.id));
    await user.click(screen.getByRole("button", { name: "切换到当前项目" }));
    expect(await screen.findByRole("heading", { name: "当前项目", level: 1 })).toBeInTheDocument();

    delayedRead.resolve(await originalFindById(firstProject.value.id));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "当前项目", level: 1 })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "先前项目", level: 1 })).not.toBeInTheDocument();
  });

  it("does not apply a late outline creation after switching projects", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = await runtime.useCases.createProject.execute({ name: "迟到大纲项目" });
    const currentProject = await runtime.useCases.createProject.execute({ name: "当前空大纲项目" });
    if (!firstProject.ok) throw firstProject.error;
    if (!currentProject.ok) throw currentProject.error;
    const originalCreate = runtime.story.outlineService.create.bind(runtime.story.outlineService);
    const delayedCreate = deferred<Awaited<ReturnType<typeof originalCreate>>>();
    const create = vi
      .spyOn(runtime.story.outlineService, "create")
      .mockImplementation((input) =>
        input.projectId === firstProject.value.id ? delayedCreate.promise : originalCreate(input),
      );
    const user = userEvent.setup();
    renderNavigableRoute(
      runtime,
      `/projects/${firstProject.value.id}/outline`,
      `/projects/${currentProject.value.id}/outline`,
    );

    expect(
      await screen.findByRole("heading", { name: "迟到大纲项目", level: 1 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "先列简单大纲" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "切换到当前项目" }));
    expect(
      await screen.findByRole("heading", { name: "当前空大纲项目", level: 1 }),
    ).toBeInTheDocument();

    delayedCreate.resolve(
      await originalCreate({
        projectId: firstProject.value.id,
        title: firstProject.value.name,
        synopsis: "在这里把长篇拆分为卷与章节；不使用 AI 也可完整编辑。",
      }),
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "先列简单大纲" })).toBeVisible());
    expect(
      screen.queryByRole("heading", { name: "迟到大纲项目", level: 2 }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "当前空大纲项目", level: 1 })).toBeVisible();
  });

  it("shows a redacted support number when outline authority cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "诊断规划" });
    if (!project.ok) throw project.error;
    const sensitive = "sk-private 正文 C:/Users/writer/outline.txt";
    vi.spyOn(runtime.story.outlines, "findByProjectId").mockResolvedValue({
      ok: false,
      error: new StoryCoreError({
        code: "STORY_REPOSITORY_ERROR",
        message: sensitive,
        retryable: true,
        actions: ["RETRY"],
      }),
    });

    renderRoute(runtime, `/projects/${project.value.id}/outline`);

    const notice = await screen.findByText(/问题编号：UI-.*联系支持时提供/u);
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(notice.textContent)?.[0];
    if (supportId === undefined) throw new Error("规划页没有支持编号。");
    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ diagnosticId }) => diagnosticId === supportId,
    );
    expect(incident).toMatchObject({
      diagnosticId: supportId,
      componentName: "StoryOutlinePage",
      readStage: "outline",
    });
    expect(incident?.reasonCodeChain).toContain("REPOSITORY_ERROR");
    expect(JSON.stringify(window.localStorage)).not.toContain(sensitive);
  });

  it("keeps正文 planning available and records a redacted support id when chapter summaries fail", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "摘要隔离项目" });
    if (!project.ok) throw project.error;
    const created = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章 雾中来信",
      content: "不会进入诊断的正文内容。",
    });
    if (!created.ok) throw created.error;
    const sensitive = "sk-private 正文 C:/Users/writer/chapter-summary.txt";
    vi.spyOn(runtime.story.chapterSummaries, "inspectProject").mockRejectedValue(
      new Error(sensitive),
    );

    renderRoute(runtime, `/projects/${project.value.id}/outline`);

    expect(
      await screen.findByRole("heading", { name: "摘要隔离项目", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "第一章 雾中来信" })).toHaveAttribute(
      "href",
      `/projects/${project.value.id}/chapters/${created.value.chapter.id}`,
    );
    expect(await screen.findByText("章节摘要暂不可用")).toBeVisible();
    const supportNotice = screen.getByText(/问题编号：UI-.*联系支持时提供/u);
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(supportNotice.textContent)?.[0];
    if (supportId === undefined) throw new Error("章节摘要隔离没有生成支持编号。");
    expect(readSafeUiRouteIncidents(runtime)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticId: supportId,
          componentName: "StoryOutlinePage",
          readStage: "outline",
          recovered: false,
        }),
      ]),
    );
    expect(JSON.stringify(window.localStorage)).not.toContain(sensitive);
  });
  it("shows real written chapters separately from optional planning nodes", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "已写正文" });
    if (!project.ok) throw project.error;
    const created = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章 雨夜",
      content: "雨夜里，主角收到一封没有署名的信。",
    });
    if (!created.ok) throw created.error;
    renderRoute(runtime, `/projects/${project.value.id}/outline`);

    expect(
      await screen.findByRole("heading", { name: "已经写下的章节", level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "第一章 雨夜" })).toHaveAttribute(
      "href",
      `/projects/${project.value.id}/chapters/${created.value.chapter.id}`,
    );
    expect(screen.getByText("还没有可用的一句话摘要；不会用猜测内容代替。")).toBeVisible();
    expect(screen.getByText(/大纲节点只是规划，不会删除或覆盖已经写好的章节/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "暂时跳过，去写正文" })).toBeVisible();
  });

  it("creates and persists a manual book, volume, and chapter workflow", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "雾港纪事" });
    if (!project.ok) {
      throw project.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/outline`);

    expect(await screen.findByRole("heading", { name: "雾港纪事", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂时跳过，去写正文" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "先列简单大纲" }));

    expect(await screen.findByRole("heading", { name: "雾港纪事", level: 2 })).toBeInTheDocument();
    const addVolumeButton = screen.getAllByRole("button", { name: "新增卷" })[0];
    if (addVolumeButton === undefined) {
      throw new Error("找不到新增卷按钮。");
    }
    await user.click(addVolumeButton);
    await user.type(screen.getByRole("textbox", { name: "卷标题" }), "第一卷");
    await user.click(screen.getByRole("button", { name: "添加" }));

    const volumeHeading = await screen.findByRole("heading", {
      name: "第 1 卷 · 第一卷",
    });
    const volumeCard = volumeHeading.closest(".ink-card");
    if (!(volumeCard instanceof HTMLElement)) {
      throw new Error("找不到卷卡片。");
    }
    await user.click(within(volumeCard).getByRole("button", { name: "添加章节" }));
    await user.type(screen.getByRole("textbox", { name: "章节标题" }), "潮声入夜");
    await user.click(screen.getByRole("button", { name: "添加" }));

    expect(await within(volumeCard).findByText("潮声入夜")).toBeInTheDocument();

    const reopened = createDevelopmentRuntime(window.localStorage);
    const storyProjectId = parseUuidV7(project.value.id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const persisted = await reopened.story.outlines.findByProjectId(storyProjectId.value);
    if (!persisted.ok || persisted.value === null) {
      throw new Error("大纲没有持久化。");
    }
    const book = persisted.value.orderedChildren(null)[0];
    if (book === undefined) {
      throw new Error("大纲缺少书节点。");
    }
    const volumes = persisted.value.orderedChildren(book.id);
    const chapters = persisted.value.orderedChildren(volumes[0]?.id ?? "");
    expect(volumes.map(({ title }) => title)).toEqual(["第一卷"]);
    expect(chapters.map(({ title }) => title)).toEqual(["潮声入夜"]);
  }, 15_000);
});

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

function renderNavigableRoute(runtime: DesktopRuntime, route: string, target: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <RouteSwitch target={target} />
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function RouteSwitch({ target }: Readonly<{ target: string }>) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(target)}>
      切换到当前项目
    </button>
  );
}

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve } as const;
}
