import { parseUuidV7 } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      "视角、风格与创作约束",
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
      expect(seed?.world.confirmation).toBe("unconfirmed");
    });

    first.unmount();
    renderPage(createDevelopmentRuntime(window.localStorage));
    expect(screen.getByRole("textbox", { name: "项目名称" })).toHaveValue("雾港来信");
    await user.click(screen.getByText("人物与世界"));
    expect(screen.getByRole("textbox", { name: /^世界背景/ })).toHaveValue("终年有雾的港城");
  });

  it("persists the complete setup while staging narrative settings and keeping writing constraints separate", async () => {
    const { runtime } = renderPage();
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "潮汐尽头的来信");
    await user.click(screen.getByText("故事方向与大纲"));
    await user.type(screen.getByRole("textbox", { name: /^故事方向/ }), "调查旧校舍的传闻");
    await user.type(screen.getByRole("textbox", { name: /^大纲简介/ }), "两位主角共同追查真相");
    await user.click(screen.getByText("人物与世界"));
    await user.type(screen.getByRole("textbox", { name: /^主角/ }), "林舟，沉默的转学生");
    await user.type(screen.getByRole("textbox", { name: /^人物关系/ }), "林舟与夏遥互相试探");
    await user.type(screen.getByRole("textbox", { name: /^世界背景/ }), "现代临海小城");
    await user.click(screen.getByText("视角、风格与创作约束"));
    await user.type(screen.getByRole("textbox", { name: /^叙事视角/ }), "第三人称限知");
    await user.type(screen.getByRole("textbox", { name: /^风格样例或说明/ }), "克制、短句");
    await user.type(screen.getByRole("textbox", { name: /^禁止项/ }), "不新增超自然力量");
    await user.type(screen.getByRole("textbox", { name: /^其他创作约束/ }), "每章保持单一视角");
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
    expect(records.value).toHaveLength(0);
    expect(facts.ok).toBe(true);
    if (!facts.ok) {
      throw facts.error;
    }
    const factSnapshots = facts.value.map((fact) => fact.toSnapshot());
    expect(
      factSnapshots
        .filter(({ status }) => status === "unconfirmed")
        .map(({ factType }) => factType)
        .sort(),
    ).toEqual(["character_profile", "core_relationship", "world_rule"]);
    expect(
      factSnapshots
        .filter(({ status }) => status === "formal")
        .map(({ factType }) => factType)
        .sort(),
    ).toEqual(["writing_constraint"]);
    const writingDashboard = await runtime.story.writingFeedback.loadDashboard(project.id);
    expect(writingDashboard.preferences.map(({ preferenceText }) => preferenceText).sort()).toEqual(
      ["写作风格：克制、短句", "叙事视角：第三人称限知"],
    );
    expect(
      facts.value.some((fact) =>
        fact
          .toSnapshot()
          .contentText?.includes("禁止项：不新增超自然力量\n其他创作约束：每章保持单一视角"),
      ),
    ).toBe(true);
    expect(
      facts.value
        .find((fact) => fact.toSnapshot().contentText?.includes("其他创作约束：每章保持单一视角"))
        ?.toSnapshot().locked,
    ).toBe(true);
    expect(
      facts.value.some(
        (fact) =>
          fact.toSnapshot().factType === "relationship" ||
          fact.toSnapshot().contentText?.includes("人物关系：不新增超自然力量"),
      ),
    ).toBe(false);

    const savedSeed = await runtime.projectSeeds.findByProjectId(project.id);
    expect(savedSeed?.seed).toMatchObject({
      journeyKind: "professional",
      currentDirection: { values: ["调查旧校舍的传闻"], confirmation: "confirmed" },
      initialOutline: { values: ["两位主角共同追查真相"], confirmation: "confirmed" },
      characters: { values: ["林舟，沉默的转学生"], confirmation: "unconfirmed" },
      relationships: { values: ["林舟与夏遥互相试探"], confirmation: "unconfirmed" },
      world: { values: ["现代临海小城"], confirmation: "unconfirmed" },
      pov: { values: ["第三人称限知"], confirmation: "confirmed" },
      style: { values: ["克制、短句"], confirmation: "confirmed" },
      boundaries: {
        values: ["禁止项：不新增超自然力量", "其他创作约束：每章保持单一视角"],
        confirmation: "confirmed",
      },
    });
    expect(generate).not.toHaveBeenCalled();

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

  it.each([
    {
      name: "只填人物",
      section: "人物与世界",
      values: [[/^主角/u, "周望，旧城守钟人"]] as const,
      factTypes: ["unconfirmed:character_profile"],
      preferences: [],
      direction: null,
    },
    {
      name: "只填世界观",
      section: "人物与世界",
      values: [[/^世界背景/u, "旧城每逢潮汐便会停电"]] as const,
      factTypes: ["unconfirmed:world_rule"],
      preferences: [],
      direction: null,
    },
    {
      name: "只填故事方向",
      section: "故事方向与大纲",
      values: [[/^故事方向/u, "追查钟摆倒转的原因"]] as const,
      factTypes: [],
      preferences: [],
      direction: "追查钟摆倒转的原因",
    },
    {
      name: "只填视角文风和禁止项",
      section: "视角、风格与创作约束",
      values: [
        [/^叙事视角/u, "第三人称限知"],
        [/^风格样例或说明/u, "克制写实"],
        [/^禁止项/u, "不新增超自然力量"],
      ] as const,
      factTypes: ["formal:writing_constraint"],
      preferences: ["写作风格：克制写实", "叙事视角：第三人称限知"],
      direction: null,
    },
  ])(
    "按正确语义持久化$name",
    async ({ direction, factTypes, name, preferences, section, values }) => {
      window.localStorage.clear();
      const view = renderPage();
      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox", { name: "项目名称" }), `组合测试-${name}`);
      await user.click(screen.getByText(section));
      for (const [label, value] of values) {
        fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
      }
      await user.click(screen.getByRole("button", { name: "创建项目并准备工作区" }));
      await screen.findByText("专业项目已准备好");

      const projects = await view.runtime.useCases.listProjects.execute({ statuses: ["active"] });
      if (!projects.ok || projects.value[0] === undefined) throw new Error("组合测试项目未创建。");
      const project = projects.value[0];
      const storyProjectId = parseUuidV7(project.id);
      if (!storyProjectId.ok) throw storyProjectId.error;
      const facts = await view.runtime.story.facts.listByProjectId(storyProjectId.value);
      if (!facts.ok) throw facts.error;
      expect(
        facts.value
          .map((fact) => `${fact.toSnapshot().status}:${fact.toSnapshot().factType}`)
          .sort(),
      ).toEqual([...factTypes].sort());
      const dashboard = await view.runtime.story.writingFeedback.loadDashboard(project.id);
      expect(dashboard.preferences.map(({ preferenceText }) => preferenceText).sort()).toEqual(
        [...preferences].sort(),
      );
      const seed = await view.runtime.projectSeeds.findByProjectId(project.id);
      expect(seed?.seed.currentDirection.values).toEqual(direction === null ? [] : [direction]);
      const outline = await view.runtime.story.outlines.findByProjectId(storyProjectId.value);
      expect(outline.ok && outline.value).not.toBeNull();
      view.unmount();
    },
  );

  it("preserves special punctuation, emoji and long professional inputs without semantic drift", async () => {
    window.localStorage.clear();
    const { runtime } = renderPage();
    const user = userEvent.setup();
    const pov = "「第一人称·周望🙂」；".repeat(55);
    const style = "“冷峻”——短句；保留停顿……🙂".repeat(90);
    const boundaries = "不得把‘坐标’改成魔法提示；".repeat(70);
    const otherConstraints = "每章只允许一个视角；日期必须写全称。".repeat(45);
    fireEvent.change(screen.getByRole("textbox", { name: "项目名称" }), {
      target: { value: "长文本与特殊标点" },
    });
    await user.click(screen.getByText("视角、风格与创作约束"));
    fireEvent.change(screen.getByRole("textbox", { name: /^叙事视角/u }), {
      target: { value: pov },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^风格样例或说明/u }), {
      target: { value: style },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^禁止项/u }), {
      target: { value: boundaries },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /^其他创作约束/u }), {
      target: { value: otherConstraints },
    });
    await user.click(screen.getByRole("button", { name: "创建项目并准备工作区" }));
    await screen.findByText("专业项目已准备好");

    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) throw new Error("长文本项目未创建。");
    const project = projects.value[0];
    const seed = await runtime.projectSeeds.findByProjectId(project.id);
    expect(seed?.seed.pov.values).toEqual([pov]);
    expect(seed?.seed.style.values).toEqual([style]);
    expect(seed?.seed.boundaries.values).toEqual([
      `禁止项：${boundaries}`,
      `其他创作约束：${otherConstraints}`,
    ]);
    const dashboard = await runtime.story.writingFeedback.loadDashboard(project.id);
    expect(dashboard.preferences.length).toBeGreaterThan(2);
    expect(dashboard.preferences.every(({ preferenceText }) => preferenceText.length <= 500)).toBe(
      true,
    );
    expect(dashboard.preferences.some(({ preferenceText }) => preferenceText.includes("🙂"))).toBe(
      true,
    );
    expect(dashboard.preferences.every(({ preferenceText }) => !preferenceText.includes("�"))).toBe(
      true,
    );
    const storyProjectId = parseUuidV7(project.id);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const facts = await runtime.story.facts.listByProjectId(storyProjectId.value);
    if (!facts.ok) throw facts.error;
    const constraint = facts.value.find(
      (fact) => fact.toSnapshot().factType === "writing_constraint",
    );
    expect(constraint?.toSnapshot()).toMatchObject({ status: "formal", locked: true });
    expect(constraint?.toSnapshot().contentText).toBe(
      `禁止项：${boundaries}\n其他创作约束：${otherConstraints}`,
    );
    expect(facts.value.some((fact) => fact.toSnapshot().factType === "relationship")).toBe(false);
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

  it("recovers after restart without overwriting planning or losing later context", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const originalEnsurePreference = runtime.story.writingFeedback.ensureManualPreference.bind(
      runtime.story.writingFeedback,
    );
    vi.spyOn(runtime.story.writingFeedback, "ensureManualPreference")
      .mockRejectedValueOnce(new Error("模拟写作偏好写入中断"))
      .mockImplementation(originalEnsurePreference);
    const first = renderPage(runtime);
    const user = userEvent.setup();

    await user.type(screen.getByRole("textbox", { name: "项目名称" }), "安全恢复项目");
    await user.click(screen.getByText("故事方向与大纲"));
    await user.type(screen.getByRole("textbox", { name: /^故事方向/ }), "表单中的故事方向");
    await user.click(screen.getByText("人物与世界"));
    await user.type(screen.getByRole("textbox", { name: /^主角/ }), "表单中的主角");
    await user.type(screen.getByRole("textbox", { name: /^世界背景/ }), "表单中的世界背景");
    await user.click(screen.getByText("视角、风格与创作约束"));
    await user.type(screen.getByRole("textbox", { name: /^风格样例或说明/ }), "克制叙述");
    await user.type(screen.getByRole("textbox", { name: /^禁止项/ }), "禁止替换主角身份");
    await user.type(screen.getByRole("textbox", { name: /^其他创作约束/ }), "所有日期写全称");
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

    first.unmount();
    const resumedRuntime = createDevelopmentRuntime(window.localStorage);
    renderPage(resumedRuntime);
    await user.click(screen.getByRole("button", { name: "继续完成创建" }));
    expect(await screen.findByText("专业项目已准备好")).toBeVisible();

    const outlineAfter = await resumedRuntime.story.outlines.findByProjectId(storyProjectId.value);
    expect(outlineAfter.ok && outlineAfter.value?.toSnapshot().nodes[0]?.synopsis).toBe(
      "用户已在规划页修改的内容",
    );
    const savedSeed = await resumedRuntime.projectSeeds.findByProjectId(project.id);
    expect(savedSeed?.seed.characters).toMatchObject({
      values: ["表单中的主角"],
      confirmation: "unconfirmed",
    });
    expect(savedSeed?.seed.world).toMatchObject({
      values: ["表单中的世界背景"],
      confirmation: "unconfirmed",
    });
    expect(savedSeed?.seed.style.values).toEqual(["克制叙述"]);
    expect(savedSeed?.seed.boundaries.values).toEqual([
      "禁止项：禁止替换主角身份",
      "其他创作约束：所有日期写全称",
    ]);
    const factsAfter = await resumedRuntime.story.facts.listByProjectId(storyProjectId.value);
    expect(
      factsAfter.ok &&
        factsAfter.value
          .map((fact) => `${fact.toSnapshot().status}:${fact.toSnapshot().factType}`)
          .sort(),
    ).toEqual([
      "formal:writing_constraint",
      "unconfirmed:character_profile",
      "unconfirmed:world_rule",
    ]);
    const writingDashboard = await resumedRuntime.story.writingFeedback.loadDashboard(project.id);
    expect(writingDashboard.preferences.map(({ preferenceText }) => preferenceText)).toEqual([
      "写作风格：克制叙述",
    ]);

    const chapters = await resumedRuntime.repositories.chapters.listByProjectId(project.id);
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
