import { parseUuidV7 } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { parseProjectSeed } from "../infrastructure/project-seed";
import { RuntimeProvider } from "../runtime-context";
import {
  PROFESSIONAL_CREATE_RECOVERY_KEY,
  ProfessionalCreatePage,
} from "./professional-create-page";

function renderPage(runtime = createDevelopmentRuntime(window.localStorage)) {
  const view = render(
    <MemoryRouter initialEntries={["/create/professional"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <ProfessionalCreatePage />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
  return { runtime, ...view };
}

describe("professional project creation", () => {
  it("only requires a project name and keeps optional preparation collapsed", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "专业创建", level: 1 })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "项目名称" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "项目名称" })).toBeRequired();
    expect(screen.getByRole("button", { name: "创建项目并准备工作区" })).toBeDisabled();
    for (const label of [
      "故事方向与大纲",
      "人物与世界",
      "视角、风格与禁止项",
      "创作任务安排、上下文与自动检查",
    ]) {
      expect(screen.getByText(label).closest("details")).not.toHaveAttribute("open");
    }
    expect(screen.getByRole("textbox", { name: /^故事方向/ })).not.toBeVisible();
  });

  it("recovers professional inputs through the shared ProjectSeed contract", async () => {
    const first = renderPage();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "雾港来信");
    await user.click(screen.getByText("故事方向与大纲"));
    await user.type(screen.getByRole("textbox", { name: /^故事方向/ }), "追查失踪的邮差");
    await user.click(screen.getByText("人物与世界"));
    await user.type(screen.getByRole("textbox", { name: /^世界背景/ }), "终年有雾的港城");

    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem(PROFESSIONAL_CREATE_RECOVERY_KEY) ?? "{}",
      ) as { projectSeed?: unknown };
      const seed = parseProjectSeed(saved.projectSeed);
      expect(seed?.journeyKind).toBe("professional");
      expect(seed?.currentDirection.values).toEqual(["追查失踪的邮差"]);
      expect(seed?.currentDirection.source).toBe("professional_setup");
      expect(seed?.currentDirection.confirmation).toBe("confirmed");
      expect(seed?.world.values).toEqual(["终年有雾的港城"]);
    });

    first.unmount();
    renderPage(createDevelopmentRuntime(window.localStorage));
    expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue("雾港来信");
    await user.click(screen.getByText("人物与世界"));
    expect(screen.getByRole("textbox", { name: /^世界背景/ })).toHaveValue("终年有雾的港城");
  });

  it("persists a blank first chapter, outline, and human-confirmed setup records", async () => {
    const { runtime } = renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "潮汐尽头的来信");
    await user.click(screen.getByText("故事方向与大纲"));
    await user.type(screen.getByRole("textbox", { name: /^故事方向/ }), "调查旧校舍的传闻");
    await user.type(screen.getByRole("textbox", { name: /^大纲简介/ }), "两位主角共同追查真相");
    await user.click(screen.getByText("人物与世界"));
    await user.type(screen.getByRole("textbox", { name: /^主角/ }), "林舟，沉默的转学生");
    await user.type(screen.getByRole("textbox", { name: /^人物关系/ }), "林舟与夏遥互相试探");
    await user.type(screen.getByRole("textbox", { name: /^世界背景/ }), "现代临海小城");
    await user.click(screen.getByText("视角、风格与禁止项"));
    await user.type(screen.getByRole("textbox", { name: /^POV \/ 叙事视角/ }), "第三人称限知");
    await user.type(screen.getByRole("textbox", { name: /^风格样例或说明/ }), "克制、短句");
    await user.type(screen.getByRole("textbox", { name: /^禁止项/ }), "不新增超自然力量");
    await user.click(screen.getByRole("button", { name: "创建项目并准备工作区" }));

    expect(await screen.findByText("专业项目已准备好")).toBeVisible();
    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) {
      throw new Error("项目没有创建成功。");
    }
    const project = projects.value[0];
    const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
    expect(chapters.ok).toBe(true);
    if (!chapters.ok) {
      throw chapters.error;
    }
    expect(chapters.value).toHaveLength(1);
    const firstChapter = chapters.value[0];
    if (firstChapter === undefined) {
      throw new Error("专业创建没有生成第一章。");
    }
    expect(firstChapter).toMatchObject({ title: "第一章", content: "", status: "active" });

    const storyProjectId = parseUuidV7(project.id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const outline = await runtime.story.outlines.findByProjectId(storyProjectId.value);
    const records = await runtime.story.formalRecords.listByProjectId(storyProjectId.value);
    const facts = await runtime.story.facts.listByProjectId(storyProjectId.value);
    expect(outline.ok && outline.value?.toSnapshot().nodes[0]?.synopsis).toContain(
      "故事方向：调查旧校舍的传闻",
    );
    expect(records.ok).toBe(true);
    if (!records.ok) {
      throw records.error;
    }
    expect(records.value.map((record) => record.toSnapshot().recordKey).sort()).toEqual([
      "professional_setup.character",
      "professional_setup.rules",
    ]);
    expect(records.value.map((record) => record.kind).sort()).toEqual(["character", "world_rule"]);
    expect(records.value.map((record) => record.currentValue)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: "professional_setup", userConfirmed: true }),
      ]),
    );
    expect(
      records.value.every((record) => record.toSnapshot().versions[0]?.reason === "created"),
    ).toBe(true);
    expect(facts.ok).toBe(true);
    if (!facts.ok) {
      throw facts.error;
    }
    expect(facts.value.map((fact) => fact.toSnapshot().factType)).toEqual(
      expect.arrayContaining([
        "character_identity",
        "relationship",
        "world_setting",
        "writing_rule",
      ]),
    );
    expect(
      facts.value.some((fact) =>
        fact.toSnapshot().contentText?.includes("禁止项：不新增超自然力量"),
      ),
    ).toBe(true);
    expect(
      facts.value
        .find((fact) => fact.toSnapshot().contentText?.includes("禁止项：不新增超自然力量"))
        ?.toSnapshot().locked,
    ).toBe(true);

    const chapterVersions = await runtime.useCases.listChapterVersions.execute(firstChapter.id);
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(firstChapter.id);
    expect(chapterVersions.ok && chapterVersions.value).toHaveLength(1);
    expect(candidates.ok && candidates.value).toHaveLength(0);

    const destinations = screen.getByRole("navigation", { name: "进入新项目" });
    expect(within(destinations).getByRole("link", { name: "进入项目正文" })).toHaveAttribute(
      "href",
      `/projects/${project.id}`,
    );
    expect(within(destinations).getByRole("link", { name: "打开规划" })).toHaveAttribute(
      "href",
      `/projects/${project.id}/outline`,
    );
    expect(within(destinations).getByRole("link", { name: "查看设定" })).toHaveAttribute(
      "href",
      `/projects/${project.id}/story`,
    );
    expect(within(destinations).getByRole("link", { name: "配置创作任务安排" })).toHaveAttribute(
      "href",
      "/settings#model-routing",
    );
  });

  it("creates real empty planning even when all optional fields are skipped", async () => {
    const { runtime } = renderPage();
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "空白专业项目");
    await user.click(screen.getByRole("button", { name: "创建项目并准备工作区" }));
    await screen.findByText("专业项目已准备好");

    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) {
      throw new Error("项目没有创建成功。");
    }
    const project = projects.value[0];
    const storyProjectId = parseUuidV7(project.id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const outline = await runtime.story.outlines.findByProjectId(storyProjectId.value);
    const records = await runtime.story.formalRecords.listByProjectId(storyProjectId.value);
    const facts = await runtime.story.facts.listByProjectId(storyProjectId.value);
    expect(outline.ok && outline.value).not.toBeNull();
    expect(records.ok && records.value).toHaveLength(0);
    expect(facts.ok && facts.value).toHaveLength(0);
  });

  it("resumes a partial setup without duplicating the project or first chapter", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const originalCreateChapter = runtime.useCases.createChapter.execute.bind(
      runtime.useCases.createChapter,
    );
    vi.spyOn(runtime.useCases.createChapter, "execute")
      .mockRejectedValueOnce(new Error("模拟章节写入中断"))
      .mockImplementation(originalCreateChapter);
    renderPage(runtime);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "可恢复项目");
    await user.click(screen.getByRole("button", { name: "创建项目并准备工作区" }));
    expect(await screen.findByText("项目已创建，准备工作尚未完成")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "继续完成创建" }));
    expect(await screen.findByText("专业项目已准备好")).toBeVisible();

    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects.ok && projects.value).toHaveLength(1);
    if (!projects.ok || projects.value[0] === undefined) {
      throw new Error("恢复后项目不存在。");
    }
    const chapters = await runtime.repositories.chapters.listByProjectId(projects.value[0].id);
    expect(chapters.ok && chapters.value).toHaveLength(1);
  });

  it("does not overwrite planning or formal settings that changed after a partial failure", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const originalCreateRecord = runtime.story.formalRecordService.create.bind(
      runtime.story.formalRecordService,
    );
    let createRecordAttempts = 0;
    vi.spyOn(runtime.story.formalRecordService, "create").mockImplementation(async (command) => {
      createRecordAttempts += 1;
      if (createRecordAttempts === 2) {
        throw new Error("模拟规则写入中断");
      }
      return originalCreateRecord(command);
    });
    renderPage(runtime);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "安全恢复项目");
    await user.click(screen.getByText("故事方向与大纲"));
    await user.type(screen.getByRole("textbox", { name: /^故事方向/ }), "表单中的故事方向");
    await user.click(screen.getByText("人物与世界"));
    await user.type(screen.getByRole("textbox", { name: /^主角/ }), "表单中的主角");
    await user.type(screen.getByRole("textbox", { name: /^世界背景/ }), "表单中的世界背景");
    await user.click(screen.getByRole("button", { name: "创建项目并准备工作区" }));
    expect(await screen.findByText("项目已创建，准备工作尚未完成")).toBeVisible();

    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) {
      throw new Error("部分失败后项目不存在。");
    }
    const project = projects.value[0];
    const storyProjectId = parseUuidV7(project.id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const outlineBefore = await runtime.story.outlines.findByProjectId(storyProjectId.value);
    if (!outlineBefore.ok || outlineBefore.value === null) {
      throw new Error("部分失败前规划没有持久化。");
    }
    const book = outlineBefore.value.toSnapshot().nodes.find((node) => node.kind === "book");
    if (book === undefined) {
      throw new Error("规划缺少作品节点。");
    }
    const changedOutline = await runtime.story.outlineService.apply({
      projectId: project.id,
      expectedRevision: outlineBefore.value.revision,
      change: {
        kind: "update_synopsis",
        nodeId: book.id,
        synopsis: "用户已在规划页修改的内容",
      },
    });
    if (!changedOutline.ok) {
      throw changedOutline.error;
    }

    const recordsBefore = await runtime.story.formalRecords.listByProjectId(storyProjectId.value);
    if (!recordsBefore.ok) {
      throw recordsBefore.error;
    }
    const character = recordsBefore.value.find(
      (record) => record.toSnapshot().recordKey === "professional_setup.character",
    );
    if (character === undefined) {
      throw new Error("部分失败前人物设定没有持久化。");
    }
    const manualCharacterValue = {
      title: "用户修改的人物设定",
      description: "以项目内修改为准",
      origin: "manual",
      userConfirmed: true,
    };
    const changedCharacter = await runtime.story.formalRecordService.edit({
      recordId: character.id,
      value: manualCharacterValue,
      actorId: runtime.story.actorId,
      humanConfirmed: true,
      expectedRevision: character.revision,
    });
    if (!changedCharacter.ok) {
      throw changedCharacter.error;
    }

    await user.click(screen.getByRole("button", { name: "继续完成创建" }));
    expect(await screen.findByText("专业项目已准备好")).toBeVisible();

    const outlineAfter = await runtime.story.outlines.findByProjectId(storyProjectId.value);
    const recordsAfter = await runtime.story.formalRecords.listByProjectId(storyProjectId.value);
    expect(outlineAfter.ok && outlineAfter.value?.toSnapshot().nodes[0]?.synopsis).toBe(
      "用户已在规划页修改的内容",
    );
    if (!recordsAfter.ok) {
      throw recordsAfter.error;
    }
    expect(
      recordsAfter.value.find(
        (record) => record.toSnapshot().recordKey === "professional_setup.character",
      )?.currentValue,
    ).toEqual(manualCharacterValue);
    expect(recordsAfter.value.map((record) => record.toSnapshot().recordKey).sort()).toEqual([
      "professional_setup.character",
      "professional_setup.rules",
    ]);

    const chapters = await runtime.repositories.chapters.listByProjectId(project.id);
    expect(chapters.ok && chapters.value).toHaveLength(1);
  });

  it("rejects a stale recovery pointer before it can mutate another project", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const existing = await runtime.useCases.createProject.execute({ name: "不会被接管的项目" });
    if (!existing.ok) {
      throw existing.error;
    }
    window.localStorage.setItem(
      PROFESSIONAL_CREATE_RECOVERY_KEY,
      JSON.stringify({
        version: 1,
        projectId: existing.value.id,
        projectCreatedAt: "2000-01-01T00:00:00.000Z",
        draft: {
          projectName: existing.value.name,
          storyDirection: "不应写入",
          outlineSynopsis: "",
          protagonist: "不应写入",
          relationship: "",
          worldBackground: "不应写入",
          pov: "",
          style: "",
          boundaries: "",
        },
      }),
    );
    renderPage(runtime);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "继续完成创建" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未完成创建记录与当前项目不一致");

    const chapters = await runtime.repositories.chapters.listByProjectId(existing.value.id);
    const storyProjectId = parseUuidV7(existing.value.id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const outline = await runtime.story.outlines.findByProjectId(storyProjectId.value);
    const records = await runtime.story.formalRecords.listByProjectId(storyProjectId.value);
    expect(chapters.ok && chapters.value).toHaveLength(0);
    expect(outline.ok && outline.value).toBeNull();
    expect(records.ok && records.value).toHaveLength(0);
  });

  it("shows a useful name conflict and creates no duplicate", async () => {
    const { runtime } = renderPage();
    const first = await runtime.useCases.createProject.execute({ name: "已经存在的故事" });
    if (!first.ok) {
      throw first.error;
    }
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "已经存在的故事");
    await user.click(screen.getByRole("button", { name: "创建项目并准备工作区" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("已有同名项目，请换一个名称。");
    await waitFor(async () => {
      const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
      expect(projects.ok && projects.value).toHaveLength(1);
    });
  });
});
