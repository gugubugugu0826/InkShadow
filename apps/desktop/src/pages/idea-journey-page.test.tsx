import { ToastProvider } from "@inkshadow/ui";
import { parseUuidV7 as parseStoryUuid } from "@inkshadow/story-core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { IdeaJourneyPage } from "./idea-journey-page";

describe("one-sentence idea journey", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates a resumable opening from one sentence and asks only one question", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "我想写一个青春恋爱轻小说。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    expect(
      await screen.findByRole("heading", { name: "先把一个想法写成可以继续的开头" }),
    ).toBeVisible();
    expect(screen.getByText("本地草案")).toBeVisible();
    expect(screen.getByRole("heading", { name: "你想先把这个开头往哪个方向推？" })).toBeVisible();
    expect(screen.getByRole("button", { name: "增加悬念" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "跳过" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保留并继续写" })).toBeEnabled();

    const active = await runtime.creativeJourneys.listActive("idea");
    expect(active).toHaveLength(1);
    expect(active[0]?.currentState).toBe("asking_one_question");
  });

  it("chooses the next useful question from the answer", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一封来自十年后的信改变了女主的暑假。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "增加悬念" }));

    expect(
      await screen.findByRole("heading", { name: "眼前最先需要解决的麻烦是什么？" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "主角和关键人物目前是什么关系？" }),
    ).not.toBeInTheDocument();
  });

  it("removes an earlier answer when the user returns and skips that question", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), "雨会倒流的城市。 ");
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "更甜一点" }));
    expect(screen.queryByText(/更更甜一点/)).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "温暖心动" }));
    await user.click(await screen.findByRole("button", { name: "返回上一问" }));
    await user.click(await screen.findByRole("button", { name: "跳过" }));

    const active = await runtime.creativeJourneys.listActive("idea");
    expect(active).toHaveLength(1);
    expect(active[0]?.snapshot.answers).not.toHaveProperty("tone");
    expect(active[0]?.snapshot.skippedQuestionKeys).toContain("tone");
  });

  it("keeps the opening as a candidate while the stable chapter remains empty", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "失忆少年每天醒来都会收到同一个陌生女孩的留言。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "保留并继续写" }));

    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    const activeProjects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!activeProjects.ok || activeProjects.value[0] === undefined) {
      throw new Error("项目没有创建成功");
    }
    const chapters = await runtime.repositories.chapters.listByProjectId(
      activeProjects.value[0].id,
    );
    if (!chapters.ok || chapters.value[0] === undefined) {
      throw new Error("章节没有创建成功");
    }
    expect(chapters.value[0].content).toBe("");
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidates.ok && candidates.value).toHaveLength(1);
    expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    const journeys = await runtime.creativeJourneys.listActive("idea");
    expect(journeys).toHaveLength(0);
    const storyProjectId = parseStoryUuid(activeProjects.value[0].id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const outline = await runtime.story.outlines.findByProjectId(storyProjectId.value);
    if (!outline.ok) {
      throw outline.error;
    }
    expect(outline.value).not.toBeNull();
    expect(outline.value?.toSnapshot().nodes[0]?.synopsis).toContain("失忆少年");
  });

  it("resumes an unfinished journey after reopening", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const first = renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "城市里的影子会在午夜交换主人的秘密。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("heading", { name: "你想先把这个开头往哪个方向推？" });
    first.unmount();

    renderJourney(createDevelopmentRuntime(window.localStorage));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续这次构思" })).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: "继续这次构思" }));
    expect(
      await screen.findByRole("heading", { name: "你想先把这个开头往哪个方向推？" }),
    ).toBeVisible();
  });
});

function renderJourney(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter initialEntries={["/create/idea"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <Routes>
            <Route path="/create/idea" element={<IdeaJourneyPage />} />
            <Route
              path="/projects/:projectId/chapters/:chapterId"
              element={<p>已进入 AI 建议版本比较</p>}
            />
          </Routes>
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
