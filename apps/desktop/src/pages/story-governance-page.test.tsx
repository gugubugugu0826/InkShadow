import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { parseUuidV7 } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("StoryGovernancePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates a visible unified story fact and keeps lock governance reversible", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "规则之海" });
    if (!project.ok) {
      throw project.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "规则之海", level: 1 });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "人物",
      "世界与规则",
      "AI 记住的内容",
      "写作偏好",
    ]);
    expect(screen.getByText("还没有人物设定")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "AI 参考记录" })).not.toBeInTheDocument();
    const recognitionButton = screen.getByRole("button", { name: "重新识别最近一章" });
    expect(recognitionButton).toBeVisible();
    await user.click(recognitionButton);
    expect(await screen.findByText("还没有可识别的正文")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "世界与规则" }));
    expect(screen.getByText("还没有世界设定")).toBeVisible();
    const addButton = screen.getAllByRole("button", { name: "添加世界设定" })[0];
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

    const detailButton = await screen.findByRole("button", { name: "查看设定详情" });
    const card = detailButton.closest(".ink-card");
    if (!(card instanceof HTMLElement)) {
      throw new Error("找不到故事设定卡片。");
    }
    expect(within(card).getByText("已记录")).toBeVisible();
    await user.click(within(card).getByRole("button", { name: "查看设定详情" }));
    const detail = screen.getByRole("dialog", { name: "世界硬规则" });
    expect(within(detail).getAllByText("已确认并锁定").length).toBeGreaterThan(0);
    expect(within(detail).getByText("这条记录没有保存可显示的精确原文片段。")).toBeVisible();
    await user.click(within(detail).getByRole("button", { name: "取消锁定" }));
    await waitFor(() => expect(within(detail).getAllByText("已确认").length).toBeGreaterThan(0));

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
    await user.click(screen.getByRole("tab", { name: "世界与规则" }));
    await user.click(screen.getByRole("button", { name: "版本化正式记录" }));
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

    const memoryDetailButton = await screen.findByRole("button", { name: "查看记忆详情" });
    const memoryCard = memoryDetailButton.closest(".ink-card");
    if (!(memoryCard instanceof HTMLElement)) {
      throw new Error("找不到记忆卡片。");
    }
    await user.click(within(memoryCard).getByRole("button", { name: "固定" }));
    await waitFor(() => {
      const refreshedCard = screen
        .getByRole("button", { name: "查看记忆详情" })
        .closest(".ink-card");
      expect(refreshedCard).not.toBeNull();
      expect(refreshedCard?.querySelector(".ink-badge--accent")?.textContent).toContain("固定");
    });

    const refreshedMemoryCard = screen
      .getByRole("button", { name: "查看记忆详情" })
      .closest(".ink-card");
    if (!(refreshedMemoryCard instanceof HTMLElement)) {
      throw new Error("找不到更新后的记忆卡片。");
    }
    await user.click(within(refreshedMemoryCard).getByRole("button", { name: "查看记忆详情" }));
    const memoryDetail = screen.getByRole("dialog", { name: "AI 记住的内容" });
    expect(within(memoryDetail).getByText("记忆只会由你手动合并")).toBeVisible();
    expect(within(memoryDetail).getByText("用户规则")).toBeVisible();
    expect(within(memoryDetail).getByText("启用")).toBeVisible();
    expect(
      within(memoryDetail).getByText("这条记忆只保存了来源对象和版本，没有可显示的精确原文证据。"),
    ).toBeVisible();
    await user.click(within(memoryDetail).getByRole("button", { name: "保留为设定" }));
    expect(screen.getByRole("dialog", { name: "添加故事设定" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "内容" })).toHaveValue(
      "叙事保持克制，不提前解释伏笔。",
    );
    await user.click(screen.getByRole("button", { name: "确认保存" }));

    const memoryAfterSettingCard = screen
      .getByRole("button", { name: "查看记忆详情" })
      .closest(".ink-card");
    if (!(memoryAfterSettingCard instanceof HTMLElement)) {
      throw new Error("找不到保留为设定后的记忆卡片。");
    }
    await user.click(within(memoryAfterSettingCard).getByRole("button", { name: "查看记忆详情" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "AI 记住的内容" })).getByRole("button", {
        name: "忘掉",
      }),
    );
    await waitFor(() => {
      const excludedCard = screen
        .getByRole("button", { name: "查看记忆详情" })
        .closest(".ink-card");
      expect(excludedCard?.querySelector(".ink-badge--danger")?.textContent).toContain("排除");
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
    expect(memories.value.map((record) => record.toSnapshot())).toMatchObject([
      { pinned: false, excluded: true },
    ]);
    const keptFacts = await reopened.story.facts.listByProjectId(storyProjectId.value);
    if (!keptFacts.ok) {
      throw keptFacts.error;
    }
    expect(keptFacts.value.map((fact) => fact.toSnapshot().contentText)).toContain(
      "叙事保持克制，不提前解释伏笔。",
    );
    expect(policy.value?.automaticLearningEnabled).toBe(true);
  }, 15_000);

  it("lets the author select two sources and commits an auditable manual memory merge", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "双月记忆" });
    if (!project.ok) throw project.error;
    const first = await runtime.story.memoryService.createRecord({
      projectId: project.value.id,
      level: "L2",
      content: "姐姐害怕雷雨。",
      source: { kind: "user_rule", sourceId: runtime.story.actorId, sourceVersionId: null },
      origin: "user",
      humanConfirmed: true,
    });
    const second = await runtime.story.memoryService.createRecord({
      projectId: project.value.id,
      level: "L3",
      content: "她会在雷雨时数窗外的灯。",
      source: { kind: "session", sourceId: runtime.story.actorId, sourceVersionId: null },
      origin: "user",
      humanConfirmed: true,
    });
    if (!first.ok || !second.ok) throw new Error("无法准备两条记忆。 ");

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    await screen.findByRole("heading", { name: "双月记忆", level: 1 });
    await user.click(screen.getByRole("tab", { name: "AI 记住的内容" }));
    const mergeButton = screen.getByRole("button", { name: "合并所选 2 条" });
    expect(mergeButton).toBeDisabled();
    const selectors = screen.getAllByRole("button", { name: "选择用于合并" });
    expect(selectors).toHaveLength(2);
    const [firstSelector, secondSelector] = selectors;
    if (firstSelector === undefined || secondSelector === undefined) {
      throw new Error("Expected exactly two memory selectors.");
    }
    await user.click(firstSelector);
    await user.click(secondSelector);
    expect(mergeButton).toBeEnabled();
    await user.click(mergeButton);

    const dialog = screen.getByRole("dialog", { name: "手动合并两条记忆" });
    expect(within(dialog).getByText("姐姐害怕雷雨。")).toBeVisible();
    expect(within(dialog).getByText("她会在雷雨时数窗外的灯。")).toBeVisible();
    const target = within(dialog).getByRole("combobox", { name: "保留的记忆记录" });
    await user.selectOptions(target, second.value.id);
    const content = within(dialog).getByRole("textbox", { name: "合并后的内容" });
    await user.clear(content);
    await user.type(content, "姐姐害怕雷雨，因此会数窗外亮着的灯。 ");
    await user.click(within(dialog).getByRole("button", { name: "确认合并" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "手动合并两条记忆" })).not.toBeInTheDocument(),
    );

    const records = await runtime.story.memoryRecords.listByProjectId(
      parseStoryProjectId(project.value.id),
    );
    if (!records.ok) throw records.error;
    expect(records.value).toHaveLength(2);
    expect(records.value.find(({ id }) => id === first.value.id)?.toSnapshot().excluded).toBe(true);
    expect(records.value.find(({ id }) => id === second.value.id)?.toSnapshot().content).toBe(
      "姐姐害怕雷雨，因此会数窗外亮着的灯。",
    );
    const stored = JSON.parse(
      window.localStorage.getItem("inkshadow.development.story.v1") ?? "{}",
    ) as { memoryGovernanceEvents?: Record<string, unknown> };
    expect(Object.keys(stored.memoryGovernanceEvents ?? {})).toHaveLength(1);
  }, 15_000);

  it("groups a real character entity and governs a pending fact from its evidence drawer", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "银印之城" });
    if (!project.ok) throw project.error;
    const chapterContent = "林舟摘下面具，露出旧王室的银色印记。";
    const evidence = "林舟摘下面具";
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "雨夜相认",
      content: chapterContent,
    });
    if (!chapter.ok) throw chapter.error;
    const formalRecord = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "character.linzhou",
      value: {
        title: "林舟",
        description: "一直隐藏自己的王室血统。",
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!formalRecord.ok) throw formalRecord.error;
    const staged = await runtime.story.factService.stageAutomaticFact({
      projectId: project.value.id,
      factType: "character_identity",
      contentText: "林舟拥有旧王室血统。",
      structuredValue: {
        schemaVersion: "inkshadow.story-subject.v1",
        subject: {
          kind: "character",
          entityKey: "character.linzhou",
          canonicalName: "林舟",
          aliases: ["小舟"],
        },
      },
      source: {
        kind: "chapter_span",
        reference: `chapter:${chapter.value.chapter.id}:identity`,
        chapterId: chapter.value.chapter.id,
        versionId: chapter.value.chapter.currentVersionId,
        startOffset: 0,
        endOffset: evidence.length,
        sourceLength: chapterContent.length,
        excerpt: evidence,
      },
      confidence: 0.93,
      origin: "ai_extraction",
    });
    if (!staged.ok) throw staged.error;

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    expect(await screen.findByRole("heading", { name: "林舟", level: 3 })).toBeVisible();
    expect(screen.getByText("1 项重大变化需要确认")).toBeVisible();
    const characterCard = screen
      .getByRole("heading", { name: "林舟", level: 3 })
      .closest(".ink-card");
    if (!(characterCard instanceof HTMLElement)) {
      throw new Error("找不到聚合后的人物卡片。");
    }
    expect(within(characterCard).getByText("1 项事实")).toBeVisible();
    expect(within(characterCard).getByText("1 条正式记录")).toBeVisible();
    expect(within(characterCard).getByText("别名：小舟")).toBeVisible();
    await user.click(within(characterCard).getByRole("button", { name: "查看人物详情" }));

    const detail = screen.getByRole("dialog", { name: "林舟" });
    expect(within(detail).getByText("雨夜相认")).toBeVisible();
    expect(within(detail).getByText(evidence)).toBeVisible();
    expect(within(detail).getAllByText("需要确认").length).toBeGreaterThan(0);
    await user.click(within(detail).getByRole("button", { name: "确认并保留" }));
    await waitFor(() => expect(within(detail).getAllByText("已确认").length).toBeGreaterThan(0));

    const facts = await runtime.story.facts.listByProjectId(parseStoryProjectId(project.value.id));
    if (!facts.ok) throw facts.error;
    expect(facts.value.map((fact) => fact.toSnapshot())).toMatchObject([
      {
        factType: "character_identity",
        status: "formal",
        userConfirmed: true,
        needsReview: false,
      },
    ]);
  });

  it("rejects a corrupt ambiguity payload and requires a named entity choice before confirmation", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "双舟旧事" });
    if (!project.ok) throw project.error;
    const chapterContent = "林舟接过银印，却没有说明自己是哪一位林舟。";
    const excerpt = "林舟接过银印";
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "银印",
      content: chapterContent,
    });
    if (!chapter.ok) throw chapter.error;
    for (const entity of [
      { key: "character.linzhou.older", name: "长兄林舟" },
      { key: "character.linzhou.younger", name: "次弟林舟" },
    ]) {
      const record = await runtime.story.formalRecordService.create({
        projectId: project.value.id,
        kind: "character",
        recordKey: entity.key,
        value: { title: entity.name, description: "已经由作者确认的人物。" },
        actorId: runtime.story.actorId,
        humanConfirmed: true,
      });
      if (!record.ok) throw record.error;
    }
    const staged = await runtime.story.factService.stageAutomaticFact({
      projectId: project.value.id,
      factType: "character_state",
      contentText: "林舟接过了银印。",
      structuredValue: {
        schemaVersion: "inkshadow.continuous-story-state.v1",
        subject: {
          kind: "character",
          entityKey: "character:isolated:silver-seal",
          canonicalName: "林舟",
          aliases: [],
          mergeStatus: "ambiguous_confirmed_alias",
          matchedEntityKeys: ["character.linzhou.older", "character.linzhou.younger"],
        },
        state: { owns: "silver-seal" },
        projection: { validation: null },
      },
      source: {
        kind: "chapter_span",
        reference: `continuous-story-state:${chapter.value.chapter.id}:ambiguous`,
        chapterId: chapter.value.chapter.id,
        versionId: chapter.value.chapter.currentVersionId,
        startOffset: 0,
        endOffset: excerpt.length,
        sourceLength: chapterContent.length,
        excerpt,
      },
      confidence: 0.86,
      origin: "ai_extraction",
    });
    if (!staged.ok) throw staged.error;
    const malformed = await runtime.story.factService.stageAutomaticFact({
      projectId: project.value.id,
      factType: "character_state",
      contentText: "林舟捡起了断剑。",
      structuredValue: {
        subject: {
          kind: "character",
          entityKey: "character:isolated:broken-sword",
          canonicalName: "林舟",
          mergeStatus: "ambiguous_confirmed_alias",
          matchedEntityKeys: [],
        },
        state: { owns: "broken-sword" },
      },
      source: {
        kind: "chapter_span",
        reference: `continuous-story-state:${chapter.value.chapter.id}:malformed-ambiguous`,
        chapterId: chapter.value.chapter.id,
        versionId: chapter.value.chapter.currentVersionId,
        startOffset: 0,
        endOffset: excerpt.length,
        sourceLength: chapterContent.length,
        excerpt,
      },
      confidence: 0.5,
      origin: "ai_extraction",
    });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) {
      throw new Error("结构损坏的歧义对象不应进入故事事实存储。 ");
    }
    expect(malformed.error).toMatchObject({
      code: "STORY_REPOSITORY_ERROR",
      message: "Story fact already exists or has an invalid initial revision.",
    });

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    await screen.findByRole("heading", { name: "双舟旧事", level: 1 });
    expect(screen.queryByText("林舟捡起了断剑。")).not.toBeInTheDocument();
    const [ambiguousCopy] = await screen.findAllByText("林舟接过了银印。");
    const ambiguousCard = ambiguousCopy?.closest(".ink-card");
    if (!(ambiguousCard instanceof HTMLElement)) {
      throw new Error("找不到歧义对象卡片。");
    }
    await user.click(within(ambiguousCard).getByRole("button", { name: "查看人物详情" }));
    const detail = screen.getByRole("dialog", { name: "林舟" });
    expect(within(detail).getByRole("button", { name: "确认并保留" })).toBeDisabled();
    await user.click(within(detail).getByRole("button", { name: "先辨认这个对象" }));

    const resolutionDialog = screen.getByRole("dialog", { name: "这段原文说的是哪个对象？" });
    const selector = within(resolutionDialog).getByRole("combobox", { name: /原文中的对象/u });
    expect(within(selector).getByRole("option", { name: "已有对象：长兄林舟" })).toBeVisible();
    expect(within(selector).getByRole("option", { name: "已有对象：次弟林舟" })).toBeVisible();
    expect(
      within(selector).getByRole("option", { name: "不是以上对象，保留为新的独立对象" }),
    ).toBeVisible();
    await user.selectOptions(selector, "existing:character.linzhou.older");
    expect(selector).toHaveValue("existing:character.linzhou.older");
    const saveResolution = within(resolutionDialog).getByRole("button", { name: "保存对象选择" });
    expect(saveResolution).toBeEnabled();
    await user.click(saveResolution);
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "这段原文说的是哪个对象？" }),
      ).not.toBeInTheDocument();
    });

    await waitFor(async () => {
      const stored = await runtime.story.facts.findById(staged.value.fact.id);
      expect(stored.ok && stored.value?.toSnapshot()).toMatchObject({
        status: "unconfirmed",
        userConfirmed: false,
        revision: 2,
        structuredValue: {
          subject: {
            entityKey: "character.linzhou.older",
            mergeStatus: "human_resolved_existing_entity",
          },
        },
      });
    });

    const confirmed = await runtime.story.factService.confirm({
      factId: staged.value.fact.id,
      actorId: runtime.story.actorId,
      humanConfirmed: true,
      expectedRevision: 2,
    });
    if (!confirmed.ok) throw confirmed.error;
    expect(confirmed.value.toSnapshot()).toMatchObject({
      status: "formal",
      userConfirmed: true,
      revision: 3,
    });
  });

  it("separates locations, rules, and organizations and shows their saved citation", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "潮汐档案" });
    if (!project.ok) throw project.error;
    const chapterContent = "雾港终年被潮雾覆盖。月潮法则禁止死者复生。巡灯会负责封锁北岸。";
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "北岸见闻",
      content: chapterContent,
    });
    if (!chapter.ok) throw chapter.error;
    const definitions = [
      {
        factType: "location_setting",
        entityKey: "location.fog_harbor",
        name: "雾港",
        content: "雾港终年被潮雾覆盖。",
        excerpt: "雾港终年被潮雾覆盖",
      },
      {
        factType: "world_rule",
        entityKey: "rule.moon_tide",
        name: "月潮法则",
        content: "月潮法则禁止死者复生。",
        excerpt: "月潮法则禁止死者复生",
      },
      {
        factType: "organization_setting",
        entityKey: "organization.lantern_watch",
        name: "巡灯会",
        content: "巡灯会负责封锁北岸。",
        excerpt: "巡灯会负责封锁北岸",
      },
    ] as const;
    for (const definition of definitions) {
      const startOffset = chapterContent.indexOf(definition.excerpt);
      const created = await runtime.story.factService.createFormalUserFact({
        projectId: project.value.id,
        factType: definition.factType,
        contentText: definition.content,
        structuredValue: {
          schemaVersion: "inkshadow.story-subject.v1",
          subject: {
            kind: "world",
            entityKey: definition.entityKey,
            canonicalName: definition.name,
            aliases: [],
          },
        },
        source: {
          kind: "chapter_span",
          reference: `chapter:${chapter.value.chapter.id}:${definition.entityKey}`,
          chapterId: chapter.value.chapter.id,
          versionId: chapter.value.chapter.currentVersionId,
          startOffset,
          endOffset: startOffset + definition.excerpt.length,
          sourceLength: chapterContent.length,
          excerpt: definition.excerpt,
        },
        actorId: runtime.story.actorId,
        humanConfirmed: true,
      });
      if (!created.ok) throw created.error;
    }

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    await screen.findByRole("heading", { name: "潮汐档案", level: 1 });
    await user.click(screen.getByRole("tab", { name: "世界与规则" }));

    expect(screen.getByRole("heading", { name: "地点", level: 3 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "规则", level: 3 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "组织", level: 3 })).toBeVisible();
    const locationCard = screen
      .getByRole("heading", { name: "雾港", level: 3 })
      .closest(".ink-card");
    if (!(locationCard instanceof HTMLElement)) {
      throw new Error("找不到地点设定卡片。");
    }
    await user.click(within(locationCard).getByRole("button", { name: "查看设定详情" }));
    const detail = screen.getByRole("dialog", { name: "雾港" });
    expect(within(detail).getByText("北岸见闻")).toBeVisible();
    expect(within(detail).getByText("雾港终年被潮雾覆盖")).toBeVisible();
    expect(within(detail).getAllByText("已确认").length).toBeGreaterThan(0);
  });

  it("retires free-form What-if creation, preserves old history read-only, and routes to causal simulation", async () => {
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
    const storyProjectId = parseUuidV7(project.value.id);
    if (!storyProjectId.ok) {
      throw storyProjectId.error;
    }
    const timeline = await runtime.story.formalRecords.load(storyProjectId.value);
    if (!timeline.ok) throw timeline.error;
    const branch = await runtime.story.whatIfService.create({
      projectId: storyProjectId.value,
      sourceEventId: timelineEvent.value.id,
      baseTimelineRevision: timeline.value.revision,
      hypothesis: "如果守军拒绝开启城门，会发生什么？",
    });
    if (!branch.ok) throw branch.error;
    const simulated = await runtime.story.whatIfService.recordSimulation({
      branchId: branch.value.id,
      effects: [
        {
          effectType: "story.consequence",
          summary: "使者被迫在城外等待，黎明前失去与内应会合的窗口。",
          impactedRecordIds: [timelineEvent.value.id],
          confidence: 0.8,
        },
      ],
      expectedRevision: branch.value.revision,
    });
    if (!simulated.ok) throw simulated.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "潮汐边界", level: 1 });
    await user.click(screen.getByRole("tab", { name: "世界与规则" }));
    expect(screen.getByRole("button", { name: "因果剧情试演" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "查看旧版试演记录" }));
    expect(await screen.findByRole("heading", { name: "旧版试演记录", level: 2 })).toBeVisible();
    const branchHeading = screen.getByRole("heading", {
      name: "如果守军拒绝开启城门，会发生什么？",
      level: 3,
    });
    const branchCard = branchHeading.closest(".ink-card");
    if (!(branchCard instanceof HTMLElement)) {
      throw new Error("找不到 What-if 分支卡片。");
    }
    expect(within(branchCard).getByText("只读历史")).toBeVisible();
    expect(screen.queryByRole("button", { name: "新建剧情试演" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "记录模拟结果" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "转为大纲草稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "丢弃分支" })).not.toBeInTheDocument();
    const branches = await runtime.story.whatIfBranches.listByProjectId(storyProjectId.value);
    if (!branches.ok) throw branches.error;
    expect(branches.value.map(({ status }) => status)).toEqual(["simulated"]);
    expect(timelineEvent.value.revision).toBe(1);

    await user.click(screen.getByRole("button", { name: "前往因果剧情试演" }));
    expect(
      await screen.findByRole("heading", { name: "故事关联", level: 1 }, { timeout: 10_000 }),
    ).toBeVisible();
  }, 15_000);

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
    await user.click(screen.getByRole("tab", { name: "世界与规则" }));
    await user.click(screen.getByRole("button", { name: "待确认变化" }));
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
    await user.click(screen.getByRole("tab", { name: "AI 记住的内容" }));
    await user.click(screen.getByRole("button", { name: "查看 AI 参考记录" }));
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
