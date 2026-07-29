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
  it("creates and persists a manual book, volume, and chapter workflow", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "雾港纪事" });
    if (!project.ok) {
      throw project.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/outline`);

    expect(await screen.findByRole("heading", { name: "雾港纪事", level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建三层大纲" }));

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
