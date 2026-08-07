import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUuidV7 } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("StoryGovernancePage", () => {
  it("creates a visible unified story fact and keeps lock governance reversible", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "规则之海" });
    if (!project.ok) {
      throw project.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "规则之海", level: 1 });
    const recognitionButton = screen.getByRole("button", { name: "重新识别最近一章" });
    expect(recognitionButton).toBeVisible();
    expect(screen.getByRole("tab", { name: "AI 参考记录" })).toBeVisible();
    await user.click(recognitionButton);
    expect(await screen.findByText("还没有可识别的正文")).toBeVisible();
    const addButton = screen.getAllByRole("button", { name: "添加设定" })[0];
    if (addButton === undefined) {
      throw new Error("找不到添加设定按钮。");
    }
    await user.click(addButton);
    await user.selectOptions(screen.getByRole("combobox", { name: "设定类型" }), "world_rule");
    await user.type(screen.getByRole("textbox", { name: "内容" }), "魔法不能复活死者。");
    await user.selectOptions(
      screen.getByRole("combobox", { name: /^AI 写作时的优先级/ }),
      "locked",
    );
    await user.click(screen.getByRole("button", { name: "确认保存" }));

    const content = await screen.findByText("魔法不能复活死者。");
    const card = content.closest(".ink-card");
    if (!(card instanceof HTMLElement)) {
      throw new Error("找不到故事设定卡片。");
    }
    expect(within(card).getByText("已确认并锁定")).toBeVisible();
    await user.click(within(card).getByRole("button", { name: "取消锁定" }));
    await waitFor(() => expect(within(card).getByText("已确认")).toBeVisible());

    const projectId = parseUuidV7(project.value.id);
    if (!projectId.ok) {
      throw projectId.error;
    }
    const facts = await runtime.story.facts.listByProjectId(projectId.value);
    if (!facts.ok) {
      throw facts.error;
    }
    expect(facts.value.map((fact) => fact.toSnapshot())).toMatchObject([
      {
        factType: "world_rule",
        contentText: "魔法不能复活死者。",
        status: "formal",
        locked: false,
        revision: 2,
      },
    ]);
  });

  it("persists a human-confirmed formal record and governed memory", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "雾港纪事" });
    if (!project.ok) {
      throw project.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    expect(await screen.findByRole("heading", { name: "雾港纪事", level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "旧版设定（高级）" }));
    const createFormalButton = screen.getAllByRole("button", { name: "新建正式设定" })[0];
    if (createFormalButton === undefined) {
      throw new Error("找不到新建正式设定按钮。");
    }
    await user.click(createFormalButton);
    await user.type(screen.getByRole("textbox", { name: "名称" }), "林舟");
    await user.type(screen.getByRole("textbox", { name: "正式描述" }), "不会在公开场合摘下面具。");
    await user.click(screen.getByRole("button", { name: "确认写入正式设定" }));

    expect(await screen.findByRole("heading", { name: "林舟", level: 3 })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "AI 记住的内容" }));
    const createMemoryButton = screen.getAllByRole("button", { name: "添加用户记忆" })[0];
    if (createMemoryButton === undefined) {
      throw new Error("找不到添加用户记忆按钮。");
    }
    await user.click(createMemoryButton);
    await user.selectOptions(screen.getByRole("combobox", { name: "记忆层级" }), "L3");
    await user.type(
      screen.getByRole("textbox", { name: "记忆内容" }),
      "叙事保持克制，不提前解释伏笔。",
    );
    await user.click(screen.getByRole("button", { name: "确认保存" }));

    const memoryCopy = await screen.findByText("叙事保持克制，不提前解释伏笔。");
    const memoryCard = memoryCopy.closest(".ink-card");
    if (!(memoryCard instanceof HTMLElement)) {
      throw new Error("找不到记忆卡片。");
    }
    await user.click(within(memoryCard).getByRole("button", { name: "固定" }));
    await waitFor(() => {
      const refreshedCopy = screen.getByText("叙事保持克制，不提前解释伏笔。");
      const refreshedCard = refreshedCopy.closest(".ink-card");
      expect(refreshedCard).not.toBeNull();
      expect(refreshedCard?.querySelector(".ink-badge--accent")?.textContent).toContain("固定");
    });

    await user.click(screen.getByRole("button", { name: "开启自动学习" }));
    await user.click(screen.getByRole("button", { name: "明确确认" }));
    expect(await screen.findByText("已授权")).toBeInTheDocument();

    const reopened = createDevelopmentRuntime(window.localStorage);
    const storyProjectId = parseUuidV7(project.value.id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const formalRecords = await reopened.story.formalRecords.listByProjectId(storyProjectId.value);
    const memories = await reopened.story.memoryRecords.listByProjectId(storyProjectId.value);
    const policy = await reopened.story.memoryPolicies.findByProjectId(storyProjectId.value);
    if (!formalRecords.ok || !memories.ok || !policy.ok) {
      throw new Error("治理数据没有持久化。");
    }
    expect(formalRecords.value.map((record) => record.toSnapshot().recordKey)).toHaveLength(1);
    expect(memories.value.map((record) => record.toSnapshot().pinned)).toEqual([true]);
    expect(policy.value?.automaticLearningEnabled).toBe(true);
  });

  it("keeps What-if effects in a sandbox and promotes only an outline draft", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "潮汐边界" });
    if (!project.ok) {
      throw project.error;
    }
    const timelineEvent = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "timeline_event",
      recordKey: "timeline_event.gate",
      value: {
        title: "城门开启",
        description: "使者在午夜抵达后，守军开启城门。",
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!timelineEvent.ok) {
      throw timelineEvent.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "潮汐边界", level: 1 });
    await user.click(screen.getByRole("tab", { name: "试演另一条剧情" }));
    const createButton = screen.getAllByRole("button", { name: "新建剧情试演" })[0];
    if (createButton === undefined) {
      throw new Error("找不到新建 What-if 按钮。");
    }
    await user.click(createButton);
    await user.type(
      screen.getByRole("textbox", { name: "假设" }),
      "如果守军拒绝开启城门，会发生什么？",
    );
    await user.click(screen.getByRole("button", { name: "创建沙盒分支" }));

    const branchHeading = await screen.findByRole("heading", {
      name: "如果守军拒绝开启城门，会发生什么？",
      level: 3,
    });
    const branchCard = branchHeading.closest(".ink-card");
    if (!(branchCard instanceof HTMLElement)) {
      throw new Error("找不到 What-if 分支卡片。");
    }
    await user.click(within(branchCard).getByRole("button", { name: "记录模拟结果" }));
    await user.type(
      screen.getByRole("textbox", { name: "影响摘要" }),
      "使者被迫在城外等待，黎明前失去与内应会合的窗口。",
    );
    await user.click(screen.getByRole("button", { name: "保存沙盒结果" }));

    const effect = await screen.findByText("使者被迫在城外等待，黎明前失去与内应会合的窗口。");
    const simulatedCard = effect.closest(".ink-card");
    if (!(simulatedCard instanceof HTMLElement)) {
      throw new Error("找不到已模拟分支卡片。");
    }
    await user.click(within(simulatedCard).getByRole("button", { name: "转为大纲草稿" }));
    expect(await screen.findByRole("heading", { name: "转为大纲草稿" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "明确确认生成草稿" }));
    expect(await screen.findByText("尚未合并")).toBeInTheDocument();

    const storyProjectId = parseUuidV7(project.value.id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const branches = await runtime.story.whatIfBranches.listByProjectId(storyProjectId.value);
    const drafts = await runtime.story.outlineDrafts.listByProjectId(storyProjectId.value);
    if (!branches.ok || !drafts.ok) {
      throw new Error("What-if 数据没有持久化。");
    }
    expect(branches.value.map(({ status }) => status)).toEqual(["promoted_to_outline_draft"]);
    expect(drafts.value).toMatchObject([
      {
        sourceBranchId: branches.value[0]?.id,
        target: "outline_draft",
      },
    ]);
    expect(timelineEvent.value.revision).toBe(1);
    const formalAfter = await runtime.story.formalRecords.findById(timelineEvent.value.id);
    expect(formalAfter.ok && formalAfter.value?.revision).toBe(1);
  });

  it("accepts a version-bound review item atomically into the formal record", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "证据之城" });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "雨夜证词",
      content: "林舟在雨夜摘下面具，向守门人展示旧王室的银色印记。守门人因此放下武器。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    const formalRecord = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "character.linzhou",
      value: {
        title: "林舟",
        description: "从不向任何人展示真实身份。",
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!formalRecord.ok) {
      throw formalRecord.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "证据之城", level: 1 });
    await user.click(screen.getByRole("tab", { name: "待确认变化" }));
    const prepareButton = screen.getAllByRole("button", { name: "准备一项变化" })[0];
    if (prepareButton === undefined) {
      throw new Error("找不到准备审阅候选按钮。");
    }
    await user.click(prepareButton);
    const suggestedDescription = screen.getByRole("textbox", { name: "建议正式描述" });
    await user.clear(suggestedDescription);
    await user.type(suggestedDescription, "会在必要时向可信守门人展示王室印记。");
    await user.click(screen.getByRole("button", { name: "保存为待确认变化" }));

    const reviewHeading = await screen.findByRole("heading", {
      name: "信息提取建议 · 林舟",
      level: 3,
    });
    const reviewCard = reviewHeading.closest(".ink-card");
    if (!(reviewCard instanceof HTMLElement)) {
      throw new Error("找不到审阅候选卡片。");
    }
    await user.click(within(reviewCard).getByRole("button", { name: "接受并写入正式设定" }));
    expect(await screen.findByText("已接受")).toBeInTheDocument();

    const changed = await runtime.story.formalRecords.findById(formalRecord.value.id);
    if (!changed.ok || changed.value === null) {
      throw new Error("正式设定没有保存。");
    }
    expect(changed.value.revision).toBe(2);
    expect(changed.value.currentValue).toMatchObject({
      title: "林舟",
      description: "会在必要时向可信守门人展示王室印记。",
    });
    const items = await runtime.story.extractionItems.listByProjectId(
      parseStoryProjectId(project.value.id),
    );
    if (!items.ok) {
      throw items.error;
    }
    expect(items.value.map(({ status }) => status)).toEqual(["accepted"]);
    expect(chapter.value.chapter.currentVersionId).toBe(
      items.value[0]?.toSnapshot().sourceVersionId,
    );
  });
  it("keeps save-triggered model work off until the project explicitly opts in", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "隐私门测试" });
    if (!project.ok) throw project.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "隐私门测试", level: 1 });
    await user.click(screen.getByRole("tab", { name: /AI.*记录/u }));
    expect(await screen.findByRole("heading", { name: "手动保存后的故事变化识别" })).toBeVisible();
    expect(runtime.story.continuousState.isAutomaticOnManualSaveEnabled(project.value.id)).toBe(
      false,
    );
    expect(runtime.story.chapterSummaries.isAutomaticOnManualSaveEnabled(project.value.id)).toBe(
      false,
    );
    expect(screen.getByText(/完整已保存章节.*人物提取.*世界设定提取/u)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "启用手动保存后识别" }));
    expect(runtime.story.continuousState.isAutomaticOnManualSaveEnabled(project.value.id)).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "暂停自动识别" })).toBeVisible();
    expect(runtime.story.chapterSummaries.isAutomaticOnManualSaveEnabled(project.value.id)).toBe(
      false,
    );
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

function parseStoryProjectId(value: string) {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}
