import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppError } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { readSafeUiRouteIncidents } from "../infrastructure/ui-route-diagnostics";
import { DEVELOPMENT_WRITING_EXPERIENCE_KEY } from "../infrastructure/writing-experience-store";
import { RuntimeProvider } from "../runtime-context";

describe("WorkspacePage route authority", () => {
  beforeEach(() => {
    window.localStorage.clear();
    const timestamp = "2026-08-24T00:00:00.000Z";
    window.localStorage.setItem(
      DEVELOPMENT_WRITING_EXPERIENCE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        preference: {
          mode: "professional",
          initializationSource: "user",
          directLocalOrganizationAuthorizedAt: null,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        grants: {},
        grantAudit: [],
      }),
    );
  });

  it("keeps the newest project visible when an earlier project read finishes last", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = await runtime.useCases.createProject.execute({ name: "先前工作区" });
    const currentProject = await runtime.useCases.createProject.execute({ name: "当前工作区" });
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
      `/projects/${firstProject.value.id}`,
      `/projects/${currentProject.value.id}`,
    );

    await waitFor(() => expect(findById).toHaveBeenCalledWith(firstProject.value.id));
    await user.click(screen.getByRole("button", { name: "切换到当前项目" }));
    expect(
      await screen.findByRole("heading", { name: "当前工作区", level: 1 }),
    ).toBeInTheDocument();

    delayedRead.resolve(await originalFindById(firstProject.value.id));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "当前工作区", level: 1 })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "先前工作区", level: 1 })).not.toBeInTheDocument();
  });

  it("does not apply a late chapter creation after switching projects", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = await runtime.useCases.createProject.execute({ name: "迟到章节项目" });
    const currentProject = await runtime.useCases.createProject.execute({ name: "当前空工作区" });
    if (!firstProject.ok) throw firstProject.error;
    if (!currentProject.ok) throw currentProject.error;
    const originalCreate = runtime.useCases.createChapter.execute.bind(
      runtime.useCases.createChapter,
    );
    const delayedCreate = deferred<Awaited<ReturnType<typeof originalCreate>>>();
    const create = vi
      .spyOn(runtime.useCases.createChapter, "execute")
      .mockImplementation((input) =>
        input.projectId === firstProject.value.id ? delayedCreate.promise : originalCreate(input),
      );
    const user = userEvent.setup();
    renderNavigableRoute(
      runtime,
      `/projects/${firstProject.value.id}`,
      `/projects/${currentProject.value.id}`,
    );

    expect(
      await screen.findByRole("heading", { name: "迟到章节项目", level: 1 }),
    ).toBeInTheDocument();
    const newChapterButton = screen.getAllByRole("button", { name: "新建章节" })[0];
    if (newChapterButton === undefined) throw new Error("找不到新建章节按钮。");
    await user.click(newChapterButton);
    await user.type(screen.getByRole("textbox", { name: "章节标题" }), "迟到的第一章");
    await user.click(screen.getByRole("button", { name: "创建章节" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    await user.click(screen.getByText("切换到当前项目", { selector: "button" }));
    expect(
      await screen.findByRole("heading", { name: "当前空工作区", level: 1 }),
    ).toBeInTheDocument();

    delayedCreate.resolve(
      await originalCreate({
        projectId: firstProject.value.id,
        title: "迟到的第一章",
        privacyMode: "standard",
      }),
    );

    await waitFor(() => expect(screen.getByText("还没有章节")).toBeVisible());
    expect(screen.queryByText("迟到的第一章")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "当前空工作区", level: 1 })).toBeVisible();
  });
  it("shows a redacted support number when project authority cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "诊断工作区" });
    if (!project.ok) throw project.error;
    const sensitive = "sk-private 正文 C:/Users/writer/workspace.txt";
    vi.spyOn(runtime.repositories.projects, "findById").mockResolvedValue({
      ok: false,
      error: new AppError({
        code: "REPOSITORY_ERROR",
        message: sensitive,
        retryable: true,
        actions: ["RETRY"],
      }),
    });

    renderRoute(runtime, `/projects/${project.value.id}`);

    const notice = await screen.findByText(/问题编号（联系支持时提供）：UI-/u);
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(notice.textContent)?.[0];
    if (supportId === undefined) throw new Error("工作区没有问题编号。");
    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ diagnosticId }) => diagnosticId === supportId,
    );
    expect(incident).toMatchObject({
      diagnosticId: supportId,
      componentName: "WorkspacePage",
      readStage: "project",
    });
    expect(incident?.reasonCodeChain).toContain("REPOSITORY_ERROR");
    expect(JSON.stringify(window.localStorage)).not.toContain(sensitive);
  });

  it("names the exact destination chapter for every continue-writing action in a 100k project", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "十万字三章节作品" });
    if (!project.ok) throw project.error;
    for (const [title, character] of [
      ["潮声", "潮"],
      ["雨夜", "雨"],
      ["天明", "明"],
    ] as const) {
      const chapter = await runtime.useCases.createChapter.execute({
        projectId: project.value.id,
        title,
        content: character.repeat(34_000),
      });
      if (!chapter.ok) throw chapter.error;
    }

    renderRoute(runtime, `/projects/${project.value.id}`);

    expect(await screen.findByText("102,000")).toBeVisible();
    expect(screen.getByRole("link", { name: "继续写第 1 章《潮声》" })).toBeVisible();
    expect(screen.getByRole("link", { name: "继续写第 2 章《雨夜》" })).toBeVisible();
    expect(screen.getAllByRole("link", { name: "继续写第 3 章《天明》" })).toHaveLength(2);
  });
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
