import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUuidV7 } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("StoryOutlinePage", () => {
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
