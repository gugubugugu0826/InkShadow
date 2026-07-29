import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { App } from "./app";
import { createDevelopmentRuntime, type DesktopRuntime } from "./infrastructure/runtime";

describe("App router wiring", () => {
  it("uses the data-backed hash router and commits dirty editor text before a real Link route", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const user = userEvent.setup();
    window.location.hash = `#/projects/${project.id}/chapters/${chapter.id}`;
    render(<App runtime={runtime} />);
    const editor = await screen.findByRole<HTMLTextAreaElement>("textbox", {
      name: "章节正文",
    });

    fireEvent.change(editor, {
      target: { value: "真实数据路由切换前的稳定正文", selectionStart: 14 },
    });
    await user.click(screen.getByRole("link", { name: "返回章节" }));

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/projects/${project.id}`);
    });
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe("真实数据路由切换前的稳定正文");
    const draft = await runtime.repositories.recoveryDrafts.findByChapterId(chapter.id);
    expect(draft.ok && draft.value).toBeNull();
  });

  it('preserves the router="none" contract for caller-owned test routers', async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);

    render(
      <MemoryRouter initialEntries={[`/projects/${project.id}/chapters/${chapter.id}`]}>
        <App router="none" runtime={runtime} />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("textbox", {
        name: "章节正文",
      }),
    ).toHaveValue("初始稳定正文");
  });
});

async function seedChapter(runtime: DesktopRuntime) {
  const project = await runtime.useCases.createProject.execute({ name: "路由门禁项目" });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "初始稳定正文",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return { project: project.value, chapter: chapter.value.chapter };
}
