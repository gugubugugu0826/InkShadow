import { ToastProvider } from "@inkshadow/ui";
import { parseUuidV7 as parseStoryUuid } from "@inkshadow/story-core";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { deriveIdeaProjectSeed, parseProjectSeed } from "../infrastructure/project-seed";
import type {
  CreativeJourneyRecord,
  CreativeJourneyTurnRecord,
} from "../infrastructure/creative-journey-store";
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
    expect(screen.getAllByText("本地草案")[0]).toBeVisible();
    expect(screen.getByRole("heading", { name: "你想先把这个开头往哪个方向推？" })).toBeVisible();
    expect(screen.getByRole("button", { name: "增加悬念" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "跳过" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保留开头，确认创建" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "换一批" })).not.toBeInTheDocument();

    const active = await runtime.creativeJourneys.listActive("idea");
    expect(active).toHaveLength(1);
    expect(active[0]?.currentState).toBe("asking_one_question");
    const seed = parseProjectSeed(active[0]?.snapshot.projectSeed);
    expect(seed?.journeyKind).toBe("idea");
    expect(seed?.genre.values).toEqual(["青春恋爱轻小说"]);
    expect(seed?.genre.source).toBe("user_input");
    expect(seed?.genre.confirmation).toBe("unconfirmed");
    expect(active[0]?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({ source: "local_fallback", status: "ready" }),
    ]);
    expect(active[0]?.snapshot).toMatchObject({
      expectedQuestionTotal: 5,
      questionIndex: 0,
      questionPlan: ["opening_direction", "protagonist", "conflict", "tone", "boundaries"],
    });
  });

  it("persists a finite plan, explains a bounded dynamic extension, and makes progress", async () => {
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
      await screen.findByRole("heading", { name: "这一段主要跟着怎样的主角？" }),
    ).toBeVisible();
    expect(screen.getByText(/第 2\/6 问/u)).toBeVisible();
    expect(screen.getByText(/已完成 1\/6（17%）/u)).toBeVisible();
    expect(screen.getByText("问题计划已按你的新信息扩展")).toBeVisible();
    const active = await runtime.creativeJourneys.listActive("idea");
    expect(active[0]?.snapshot).toMatchObject({
      expectedQuestionTotal: 6,
      questionIndex: 1,
      questionHistory: ["opening_direction"],
    });
    expect(active[0]?.snapshot.questionPlan).toEqual([
      "opening_direction",
      "protagonist",
      "conflict",
      "tone",
      "boundaries",
      "genre",
    ]);
    expect(active[0]?.snapshot.remainingQuestionFocus).not.toContain("opening_direction");
  });

  it("finishes a no-new-information plan and allows exactly one explicit rewrite", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一间永远停在午夜的书店。 ",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    for (let index = 0; index < 5; index += 1) {
      await user.click(await screen.findByRole("button", { name: "跳过" }));
    }
    expect(await screen.findByText("问题计划已完成")).toBeVisible();
    expect(screen.getByText(/已走完 5\/5 问（100%）；剩余重点：无/u)).toBeVisible();
    const beforeRewrite = (await runtime.creativeJourneys.listActive("idea"))[0];
    expect(beforeRewrite?.snapshot).toMatchObject({
      expectedQuestionTotal: 5,
      questionIndex: 5,
      questionHistory: ["opening_direction", "protagonist", "conflict", "tone", "boundaries"],
      skippedQuestionKeys: ["opening_direction", "protagonist", "conflict", "tone", "boundaries"],
      remainingQuestionFocus: [],
      guidanceRewriteUsed: false,
    });

    const rewriteButton = screen.getAllByRole("button", { name: "根据回答重写一次" })[0];
    if (rewriteButton === undefined) throw new Error("完成态没有明确重写入口。 ");
    await user.click(rewriteButton);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "已明确重写一次" })[0]).toBeDisabled();
    });
    const afterRewrite = (await runtime.creativeJourneys.listActive("idea"))[0];
    expect(afterRewrite?.currentState).toBe("guidance_complete");
    expect(afterRewrite?.snapshot.guidanceRewriteUsed).toBe(true);
  });

  it("removes an earlier answer when the user returns and skips that question", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), "雨会倒流的城市。 ");
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "更甜一点" }));
    expect(screen.queryByText(/更更甜一点/)).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "嘴硬心软" }));
    await user.click(await screen.findByRole("button", { name: "返回上一问" }));
    await user.click(await screen.findByRole("button", { name: "跳过" }));

    const active = await runtime.creativeJourneys.listActive("idea");
    expect(active).toHaveLength(1);
    expect(active[0]?.snapshot.answers).not.toHaveProperty("protagonist");
    expect(active[0]?.snapshot.skippedQuestionKeys).toContain("protagonist");
    const seed = parseProjectSeed(active[0]?.snapshot.projectSeed);
    expect(seed?.characters.values).toEqual([]);
    expect(seed?.characters.confirmation).toBe("skipped");
  });

  it("regenerates only on request and lets a returned custom answer replace the earlier value", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), "雨夜车站的陌生来信。 ");
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("heading", { name: "你想先把这个开头往哪个方向推？" });

    const activeBefore = await runtime.creativeJourneys.listActive("idea");
    const journeyId = activeBefore[0]?.id;
    if (journeyId === undefined) throw new Error("没有创建可恢复构思。");
    const turnCountBefore = (await runtime.creativeJourneys.listTurns(journeyId)).length;
    await user.click(screen.getByRole("button", { name: "重新生成开头" }));
    await waitFor(async () => {
      expect((await runtime.creativeJourneys.listTurns(journeyId)).length).toBeGreaterThan(
        turnCountBefore,
      );
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "重新生成开头" })).toBeEnabled());
    const regenerationCount = (await runtime.creativeJourneys.listTurns(journeyId)).filter(
      ({ kind }) => kind === "regenerate",
    ).length;

    const customAnswer = screen.getByRole("textbox", { name: /^自己回答/ });
    await user.type(customAnswer, "保留悬念，但让对话更克制");
    await user.click(screen.getByRole("button", { name: "采用我的回答" }));
    await screen.findByRole("heading", { name: "这一段主要跟着怎样的主角？" });
    await user.click(screen.getByRole("button", { name: "返回上一问" }));
    const returnedAnswer = screen.getByRole("textbox", { name: /^自己回答/ });
    await user.clear(returnedAnswer);
    await user.type(returnedAnswer, "更甜一点，但不要减少悬念");
    await user.click(screen.getByRole("button", { name: "采用我的回答" }));

    const activeAfter = await runtime.creativeJourneys.listActive("idea");
    expect(activeAfter[0]?.snapshot.answers).toMatchObject({
      opening_direction: "更甜一点，但不要减少悬念",
    });
    const seed = parseProjectSeed(activeAfter[0]?.snapshot.projectSeed);
    expect(seed?.currentDirection.values).toEqual(["更甜一点，但不要减少悬念"]);
    const regenerationCountAfterAnswers = (
      await runtime.creativeJourneys.listTurns(journeyId)
    ).filter(({ kind }) => kind === "regenerate").length;
    expect(regenerationCountAfterAnswers).toBe(regenerationCount);
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
    await user.click(await screen.findByRole("button", { name: "保留开头，确认创建" }));

    expect(await screen.findByRole("heading", { name: "都准备好了，看一眼全貌" })).toBeVisible();
    const projectName = screen.getByRole("textbox", { name: /^书名/ });
    const storySummary = screen.getByRole("textbox", { name: /^故事摘要/ });
    await user.clear(projectName);
    await user.type(projectName, "午夜留言");
    await user.clear(storySummary);
    await user.type(storySummary, "失忆少年每天收到陌生女孩留言，并决定追查留言来自何处。");
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    await screen.findByRole("heading", { name: "你想先把这个开头往哪个方向推？" });
    await user.click(screen.getByRole("button", { name: "保留开头，确认创建" }));
    expect(await screen.findByRole("textbox", { name: /^书名/ })).toHaveValue("午夜留言");
    expect(screen.getByRole("textbox", { name: /^故事摘要/ })).toHaveValue(
      "失忆少年每天收到陌生女孩留言，并决定追查留言来自何处。",
    );
    const reviewJourneys = await runtime.creativeJourneys.listActive("idea");
    const reviewJourneyId = reviewJourneys[0]?.id;
    expect(reviewJourneys[0]?.snapshot.storySummary).toBe(
      "失忆少年每天收到陌生女孩留言，并决定追查留言来自何处。",
    );
    await user.click(screen.getByRole("button", { name: "创建作品，查看 AI 建议" }));

    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    const activeProjects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!activeProjects.ok || activeProjects.value[0] === undefined) {
      throw new Error("项目没有创建成功");
    }
    expect(activeProjects.value[0].name).toBe("午夜留言");
    const savedSeed = await runtime.projectSeeds.findByProjectId(activeProjects.value[0].id);
    expect(savedSeed?.seed.premise.values).toEqual([
      "失忆少年每天收到陌生女孩留言，并决定追查留言来自何处。",
    ]);
    if (reviewJourneyId === undefined) {
      throw new Error("创建前摘要没有保存到构思流程。");
    }
    const completedJourney = await runtime.creativeJourneys.findById(reviewJourneyId);
    expect(completedJourney?.snapshot.storySummary).toBe(
      "失忆少年每天收到陌生女孩留言，并决定追查留言来自何处。",
    );
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

  it("keeps guided answers in ProjectSeed without raw aggregate cards or endpoint-free relationship facts", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "两名旧友在停电的小镇重逢。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "更甜一点" }));
    await user.click(await screen.findByRole("button", { name: "嘴硬心软" }));
    for (const heading of [
      "眼前最先需要解决的麻烦是什么？",
      "读者看完这一段，你最想让他们留下什么感觉？",
      "目前有什么内容一定不要出现？",
      "如果给这个故事一个类型标签，你最希望是什么？",
    ]) {
      expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "跳过" }));
    }
    expect(
      await screen.findByRole("heading", { name: "主角和关键人物目前是什么关系？" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "青梅竹马" }));
    expect(await screen.findByText("问题计划已完成")).toBeVisible();
    const completedPlan = (await runtime.creativeJourneys.listActive("idea"))[0];
    const questionPlan = completedPlan?.snapshot.questionPlan as readonly string[] | undefined;
    if (questionPlan === undefined) throw new Error("完成态没有持久化问题计划。 ");
    expect(completedPlan?.currentState).toBe("guidance_complete");
    expect(completedPlan?.snapshot.remainingQuestionFocus).toEqual([]);
    expect(questionPlan.length).toBeLessThanOrEqual(12);
    expect(new Set(questionPlan).size).toBe(questionPlan.length);
    await user.click(screen.getByRole("button", { name: "直接确认创建" }));
    await user.click(await screen.findByRole("button", { name: "创建作品，查看 AI 建议" }));

    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) throw new Error("引导作品没有创建。 ");
    const projectId = parseStoryUuid(projects.value[0].id);
    if (!projectId.ok) throw projectId.error;
    const records = await runtime.story.formalRecords.listByProjectId(projectId.value);
    const facts = await runtime.story.facts.listByProjectId(projectId.value);
    if (!records.ok || !facts.ok) throw new Error("引导设定记录无法读取。 ");
    expect(records.value).toHaveLength(0);
    expect(facts.value.map((fact) => fact.toSnapshot().factType)).toContain("character_identity");
    expect(facts.value.map((fact) => fact.toSnapshot().factType)).not.toContain("relationship");
    const seed = await runtime.projectSeeds.findByProjectId(projects.value[0].id);
    expect(seed?.seed.characters.values).toEqual(["嘴硬心软"]);
    expect(seed?.seed.relationships.values).toEqual(["青梅竹马"]);
  }, 30_000);

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

  it("reopens directly at the saved creation summary", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const first = renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "只有女主能听见废弃电台里的求救声。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "保留开头，确认创建" }));
    await screen.findByRole("heading", { name: "都准备好了，看一眼全貌" });
    first.unmount();

    renderJourney(createDevelopmentRuntime(window.localStorage));
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByRole("heading", { name: "都准备好了，看一眼全貌" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: /^书名/ })).toHaveValue(
      "只有女主能听见废弃电台里的求救声",
    );
  });

  it("explains the no-connection path in place without blocking the journey", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);

    expect(await screen.findByText("AI 还没连接，也可以开始")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "去连接 AI" }));
    expect(screen.getByRole("heading", { name: "连接你的 AI" })).toBeVisible();
    expect(screen.getByText("浏览器预览不能保存凭据")).toBeVisible();
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "先不连接，继续开书" }));
    expect(screen.queryByRole("heading", { name: "连接你的 AI" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "一句话灵感" })).toBeEnabled();
  });

  it("starts a blank local work without requiring an idea or creating AI content", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);

    await user.click(await screen.findByRole("button", { name: "不输入灵感，直接空白写作" }));
    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();

    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) throw new Error("空白作品没有创建。");
    expect(projects.value).toHaveLength(1);
    expect(projects.value[0].name).toBe("未命名新故事");
    const chapters = await runtime.repositories.chapters.listByProjectId(projects.value[0].id);
    if (!chapters.ok || chapters.value[0] === undefined) throw new Error("空白章节没有创建。");
    expect(chapters.value).toHaveLength(1);
    expect(chapters.value[0].content).toBe("");
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidates.ok && candidates.value).toHaveLength(0);
    const seed = await runtime.projectSeeds.findByProjectId(projects.value[0].id);
    expect(seed?.seed.premise.values).toEqual([]);
  });

  it("takes a synchronous lock so one commit-cycle double activation creates one blank workspace", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const createJourney = vi.spyOn(runtime.creativeJourneys, "create");
    renderJourney(runtime);
    const startButton = await screen.findByRole("button", {
      name: "不输入灵感，直接空白写作",
    });

    await act(async () => {
      startButton.click();
      startButton.click();
      await Promise.resolve();
    });

    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    expect(createJourney).toHaveBeenCalledTimes(1);
    const createdJourney = createJourney.mock.calls[0]?.[0];
    if (createdJourney === undefined) throw new Error("空白创作 Journey 没有创建。");
    await expect(runtime.creativeJourneys.findById(createdJourney.id)).resolves.toMatchObject({
      status: "completed",
      currentState: "author_workspace_ready",
    });

    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) throw new Error("空白作品没有创建。");
    expect(projects.value).toHaveLength(1);
    const chapters = await runtime.repositories.chapters.listByProjectId(projects.value[0].id);
    if (!chapters.ok || chapters.value[0] === undefined) throw new Error("空白章节没有创建。");
    expect(chapters.value).toHaveLength(1);
    const versions = await runtime.repositories.chapterVersions.listByChapterId(
      chapters.value[0].id,
    );
    expect(versions.ok && versions.value).toHaveLength(1);
  });

  it("keeps the current idea visible and releases the blank-workspace lock after storage fills", async () => {
    const storage = new FaultInjectingStorage(window.localStorage);
    const runtime = createDevelopmentRuntime(storage);
    const createJourney = vi.spyOn(runtime.creativeJourneys, "create");
    const user = userEvent.setup();
    renderJourney(runtime);
    const idea = "一名邮差发现所有退信都来自明天。";
    const ideaInput = screen.getByRole("textbox", { name: "一句话灵感" });
    await user.type(ideaInput, idea);
    storage.failNextWrite(new DOMException("quota reached", "QuotaExceededError"));

    await user.click(screen.getByRole("button", { name: "不输入灵感，直接空白写作" }));

    expect(await screen.findByText(/本地存储空间不足/u)).toBeVisible();
    expect(screen.getByText(/释放设备或浏览器存储空间/u)).toBeVisible();
    expect(screen.getByText("CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED")).toBeVisible();
    expect(screen.getByRole("textbox", { name: /^一句话灵感/u })).toHaveValue(idea);
    expect(await runtime.creativeJourneys.listActive("idea")).toHaveLength(0);
    const firstAttempt = createJourney.mock.calls[0]?.[0];
    if (firstAttempt === undefined) throw new Error("首次空白作品计划没有创建。 ");

    await user.click(screen.getByRole("button", { name: "重试创建" }));
    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    const retriedAttempt = createJourney.mock.calls[1]?.[0];
    expect(retriedAttempt?.id).toBe(firstAttempt.id);
    expect(retriedAttempt?.snapshot.provisioningPlan).toEqual(
      firstAttempt.snapshot.provisioningPlan,
    );
    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects.ok && projects.value).toHaveLength(1);
  });

  it("keeps a create failure visible when the initial active-list request returns late", async () => {
    const storage = new FaultInjectingStorage(window.localStorage);
    const base = createDevelopmentRuntime(storage);
    const originalListActive = base.creativeJourneys.listActive.bind(base.creativeJourneys);
    let listCallCount = 0;
    let releaseInitialList!: (records: readonly CreativeJourneyRecord[]) => void;
    const initialList = new Promise<readonly CreativeJourneyRecord[]>((resolve) => {
      releaseInitialList = resolve;
    });
    const listActive = vi.fn((...args: Parameters<typeof originalListActive>) => {
      listCallCount += 1;
      return listCallCount === 1 ? initialList : originalListActive(...args);
    });
    const creativeJourneys = {
      findById: base.creativeJourneys.findById.bind(base.creativeJourneys),
      listActive,
      listTurns: base.creativeJourneys.listTurns.bind(base.creativeJourneys),
      create: base.creativeJourneys.create.bind(base.creativeJourneys),
      update: base.creativeJourneys.update.bind(base.creativeJourneys),
    };
    const runtime: DesktopRuntime = Object.freeze({ ...base, creativeJourneys });
    const user = userEvent.setup();
    renderJourney(runtime);
    await waitFor(() => expect(listActive).toHaveBeenCalledTimes(1));
    const idea = "一名邮差发现所有退信都来自明天。";
    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), idea);
    storage.failNextWrite(new DOMException("quota reached", "QuotaExceededError"));

    await user.click(screen.getByRole("button", { name: "不输入灵感，直接空白写作" }));
    expect(await screen.findByText("CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED")).toBeVisible();

    await act(async () => {
      releaseInitialList([]);
      await Promise.resolve();
    });
    expect(screen.getByText("CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED")).toBeVisible();
    expect(screen.getByRole("textbox", { name: /^一句话灵感/u })).toHaveValue(idea);
  });

  it("creates three isolated provider opening suggestions and lets the author choose one", async () => {
    const harness = createTauriIdeaRuntime(false);
    const enableNovelSkill = vi.spyOn(harness.runtime.novelSkills, "setMethodEnabled");
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    const releaseGeneration: (() => void)[] = [];
    harness.generate.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          releaseGeneration.push(() => {
            resolve({ text: `供应商开头 ${input.generationId}`, usage: null });
          });
        }),
    );

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "停电后的校园里，只有女主的影子仍然会移动。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    const projectsBeforeOutput = await harness.runtime.useCases.listProjects.execute({
      statuses: ["active"],
    });
    if (!projectsBeforeOutput.ok || projectsBeforeOutput.value[0] === undefined) {
      throw new Error("AI 返回前没有创建可恢复的空白作品。");
    }
    expect(projectsBeforeOutput.value).toHaveLength(1);
    const project = projectsBeforeOutput.value[0];
    const chaptersBeforeOutput = await harness.runtime.repositories.chapters.listByProjectId(
      project.id,
    );
    if (!chaptersBeforeOutput.ok || chaptersBeforeOutput.value[0] === undefined) {
      throw new Error("AI 返回前没有创建可恢复的第一章。");
    }
    expect(chaptersBeforeOutput.value).toHaveLength(1);
    const chapter = chaptersBeforeOutput.value[0];
    expect(chapter.content).toBe("");
    const versionsBeforeOutput = await harness.runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    expect(versionsBeforeOutput.ok && versionsBeforeOutput.value).toHaveLength(1);
    expect(versionsBeforeOutput.ok && versionsBeforeOutput.value[0]?.id).toBe(
      chapter.currentVersionId,
    );
    const seedBeforeOutput = await harness.runtime.projectSeeds.findByProjectId(project.id);
    expect(seedBeforeOutput?.seed.premise.values).toEqual([
      "停电后的校园里，只有女主的影子仍然会移动。",
    ]);
    const tracesBeforeOutput = await harness.runtime.contextTraces.listByProjectId(project.id);
    expect(tracesBeforeOutput).toHaveLength(3);
    expect(new Set(tracesBeforeOutput.map(({ id }) => id)).size).toBe(3);
    expect(
      tracesBeforeOutput.every(
        ({ taskType, chapterId, execution }) =>
          taskType === "book_start_guidance" &&
          chapterId === chapter.id &&
          execution !== null &&
          execution.modelInvocationId !== null,
      ),
    ).toBe(true);
    expect(new Set(tracesBeforeOutput.map(({ execution }) => execution?.generationId)).size).toBe(
      3,
    );
    expect(
      new Set(tracesBeforeOutput.map(({ execution }) => execution?.modelInvocationId)).size,
    ).toBe(3);
    const candidatesBeforeOutput = await harness.runtime.repositories.aiCandidates.listByChapterId(
      chapter.id,
    );
    expect(candidatesBeforeOutput.ok && candidatesBeforeOutput.value).toHaveLength(0);

    await act(async () => {
      for (const release of releaseGeneration) release();
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { name: "方案 3" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "方案 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "方案 2" })).toBeVisible();
    expect(screen.getAllByText("AI 已生成")).toHaveLength(3);
    expect(screen.getAllByText(/个可见字符 · 用时/u)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled();

    const beforeSelection = await harness.runtime.creativeJourneys.listActive("idea");
    const suggestions = beforeSelection[0]?.snapshot.openingSuggestions;
    expect(suggestions).toHaveLength(3);
    expect(suggestions).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "provider", status: "ready" })]),
    );
    const suggestionTraceIds = (suggestions as readonly Readonly<{ contextTraceId: string }>[]).map(
      ({ contextTraceId }) => contextTraceId,
    );
    expect(new Set(suggestionTraceIds).size).toBe(3);
    expect(new Set(suggestionTraceIds)).toEqual(new Set(tracesBeforeOutput.map(({ id }) => id)));
    const firstSelectedId = beforeSelection[0]?.snapshot.selectedOpeningId;
    const journeyId = beforeSelection[0]?.id;
    if (journeyId === undefined) throw new Error("AI 开书旅程没有保存。");
    const turns = await harness.runtime.creativeJourneys.listTurns(journeyId);
    const generationTurns = turns.filter(({ generationSource }) => generationSource === "provider");
    expect(generationTurns).toHaveLength(3);
    expect(new Set(generationTurns.map(({ requestId }) => requestId)).size).toBe(3);
    expect(generationTurns.every(({ taskKey }) => taskKey === "opening_guidance")).toBe(true);
    await user.click(screen.getByRole("button", { name: "选择方案 2" }));
    const afterSelection = await harness.runtime.creativeJourneys.listActive("idea");
    expect(afterSelection[0]?.snapshot.selectedOpeningId).not.toBe(firstSelectedId);

    const projectsAfterSelection = await harness.runtime.useCases.listProjects.execute({
      statuses: ["active"],
    });
    expect(projectsAfterSelection.ok && projectsAfterSelection.value).toHaveLength(1);
    const chaptersAfterSelection = await harness.runtime.repositories.chapters.listByProjectId(
      project.id,
    );
    expect(chaptersAfterSelection.ok && chaptersAfterSelection.value[0]?.content).toBe("");
    expect(enableNovelSkill).not.toHaveBeenCalled();
  }, 30_000);

  it("does not start a deferred provider slot after the author reopens and ends the pending batch", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();

    const saveTrace = harness.runtime.contextTraces.save.bind(harness.runtime.contextTraces);
    let releaseTraceSaves!: () => void;
    const traceGate = new Promise<void>((resolve) => {
      releaseTraceSaves = resolve;
    });
    let enteredTraceSaves = 0;
    vi.spyOn(harness.runtime.contextTraces, "save").mockImplementation(async (trace) => {
      enteredTraceSaves += 1;
      await traceGate;
      await saveTrace(trace);
    });

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "A lighthouse writes a new name into its log before every storm.",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await waitFor(() => expect(enteredTraceSaves).toBe(3));
    expect(harness.generate).not.toHaveBeenCalled();

    const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
    const pendingProjectId = pending?.projectId;
    if (pendingProjectId === null || pendingProjectId === undefined) {
      throw new Error("deferred opening did not provision its recoverable workspace");
    }
    first.unmount();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
    await waitFor(() => expect(harness.cancelGeneration).toHaveBeenCalledTimes(3));

    releaseTraceSaves();
    let invocationIds: readonly string[] = [];
    await waitFor(async () => {
      const traces = await harness.runtime.contextTraces.listByProjectId(pendingProjectId);
      invocationIds = traces.flatMap(({ execution }) => {
        const invocationId = execution?.modelInvocationId;
        return invocationId === null || invocationId === undefined ? [] : [invocationId];
      });
      expect(invocationIds).toHaveLength(3);
    });
    await waitFor(async () => {
      const invocations = await Promise.all(
        invocationIds.map((invocationId) => harness.runtime.modelHub.findInvocation(invocationId)),
      );
      expect(invocations.every((invocation) => invocation?.status === "failed")).toBe(true);
    });
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("enables experimental opening methods only after explicit opt-in without forging browser receipts", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    const availability = Object.freeze({ status: "ready" as const, reason: null });
    vi.spyOn(harness.runtime.novelSkills, "getAvailability").mockReturnValue(availability);
    const enableNovelSkill = vi
      .spyOn(harness.runtime.novelSkills, "setMethodEnabled")
      .mockResolvedValue(
        Object.freeze({
          availability,
          evaluationStatus: "not_evaluated" as const,
          methods: Object.freeze([]),
        }),
      );
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    await user.click(screen.getByRole("checkbox", { name: /试用仍在评测中的基础写作方法/u }));
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "雨停之后，旧剧场的所有座位都朝向一扇新出现的门。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    expect(await screen.findByRole("heading", { name: "方案 3" })).toBeVisible();
    expect(enableNovelSkill).toHaveBeenCalledTimes(2);
    expect(enableNovelSkill).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "core.scene_craft",
      true,
    );
    expect(enableNovelSkill).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "core.prose_specificity",
      true,
    );
    const active = await harness.runtime.creativeJourneys.listActive("idea");
    expect(active[0]?.snapshot.experimentalNovelSkillsOptIn).toBe(true);
    const projectId = active[0]?.projectId;
    if (projectId === null || projectId === undefined) {
      throw new Error("显式启用测试没有建立空作品。");
    }
    const traces = await harness.runtime.contextTraces.listByProjectId(projectId);
    expect(traces).toHaveLength(3);
    for (const trace of traces) {
      await expect(
        harness.runtime.novelSkills.findInvocationByContextTrace(trace.id),
      ).resolves.toMatchObject({ status: "unavailable", invocation: null });
    }
  }, 30_000);

  it("keeps a sufficiently visible truncated proposal as an explicit incomplete candidate", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    let callIndex = 0;
    const partialText = "雨声压住站台广播，女孩攥着那封没有寄件人的信。".repeat(9);
    harness.generate.mockImplementation((input) => {
      callIndex += 1;
      if (callIndex === 1) {
        input.onDelta?.(partialText);
        return Promise.reject(
          Object.assign(new Error("truncated"), { code: "MODEL_OUTPUT_TRUNCATED" }),
        );
      }
      return Promise.resolve({ text: `完整方案 ${String(callIndex)}`, usage: null });
    });

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "午夜车站里，信件总会比寄信人早到一天。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    expect(await screen.findByText("AI 未完整")).toBeVisible();
    expect(screen.getByText(partialText)).toBeVisible();
    expect(screen.getByRole("button", { name: "继续补全" })).toBeEnabled();
    expect(screen.getAllByRole("button", { name: "重新生成" })[0]).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "保留为草稿" }));
    expect(screen.getByRole("button", { name: "已保留为草稿" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "使用未完整草稿，确认创建" }));
    await user.click(await screen.findByRole("button", { name: "创建作品，查看 AI 建议" }));

    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    const projects = await harness.runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) throw new Error("未完整候选没有项目。 ");
    const chapters = await harness.runtime.repositories.chapters.listByProjectId(
      projects.value[0].id,
    );
    if (!chapters.ok || chapters.value[0] === undefined) throw new Error("未完整候选没有章节。 ");
    expect(chapters.value[0].content).toBe("");
    const candidates = await harness.runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    if (!candidates.ok || candidates.value[0] === undefined) {
      throw new Error("未完整建议没有建立隔离 Candidate。");
    }
    const candidate = candidates.value[0];
    expect(candidate.toSnapshot()).toMatchObject({
      status: "ready",
      incomplete: true,
      content: partialText.normalize("NFKC"),
    });
    const versions = await harness.runtime.repositories.chapterVersions.listByChapterId(
      chapters.value[0].id,
    );
    expect(versions.ok && versions.value).toHaveLength(1);
    const linkedTrace = await harness.runtime.contextTraces.findByOutputCandidateId(candidate.id);
    expect(linkedTrace).toMatchObject({
      projectId: projects.value[0].id,
      chapterId: chapters.value[0].id,
      taskType: "book_start_guidance",
      outputCandidateId: candidate.id,
    });
    expect(typeof linkedTrace?.execution?.modelInvocationId).toBe("string");
  }, 30_000);

  it("continues only the selected partial slot and preserves the other two slots", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    let callIndex = 0;
    const partialText = "夜班电车驶过空站，玻璃上的倒影却留在了月台。".repeat(8);
    const continuationText = "她回头看见倒影抬起手，指向站牌背后新出现的门。";
    harness.generate.mockImplementation((input) => {
      callIndex += 1;
      if (callIndex === 1) {
        input.onDelta?.(partialText);
        return Promise.reject(
          Object.assign(new Error("truncated"), { code: "MODEL_OUTPUT_TRUNCATED" }),
        );
      }
      return Promise.resolve({
        text: callIndex === 4 ? continuationText : `完整方案 ${String(callIndex)}`,
        usage: null,
      });
    });

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "末班电车会把乘客送到他们最不愿回去的地方。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    expect(await screen.findByRole("button", { name: "继续补全" })).toBeEnabled();
    const before = (await harness.runtime.creativeJourneys.listActive("idea"))[0];
    const beforeSuggestions = before?.snapshot.openingSuggestions as
      readonly Readonly<{ id: string; status: string; text: string }>[] | undefined;
    const oldPartial = beforeSuggestions?.find(({ status }) => status === "partial");
    if (before === undefined || beforeSuggestions === undefined || oldPartial === undefined) {
      throw new Error("未完整方案没有先保存到固定槽位。 ");
    }
    const untouchedIds = beforeSuggestions
      .filter(({ id }) => id !== oldPartial.id)
      .map(({ id }) => id);

    await user.click(screen.getByRole("button", { name: "继续补全" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(4));
    expect(await screen.findByText(`${partialText}${continuationText}`)).toBeVisible();

    const after = (await harness.runtime.creativeJourneys.listActive("idea"))[0];
    if (after === undefined) throw new Error("补全后的构思没有保存。 ");
    const afterSuggestions = after.snapshot.openingSuggestions as readonly Readonly<{
      id: string;
      status: string;
      text: string;
    }>[];
    const afterHistory = after.snapshot.openingResultHistory as readonly Readonly<{
      id: string;
      status: string;
      text: string;
    }>[];
    expect(afterSuggestions).toHaveLength(3);
    expect(afterSuggestions.map(({ id }) => id)).toEqual(expect.arrayContaining(untouchedIds));
    expect(afterSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ready",
          text: `${partialText}${continuationText}`,
        }),
      ]),
    );
    expect(afterHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldPartial.id, status: "partial", text: partialText }),
      ]),
    );
    const continuationRequest = harness.generate.mock.calls[3]?.[0];
    expect(continuationRequest?.maxOutputTokens).toBe(1_200);
    expect(continuationRequest?.messages.at(-1)?.content).toContain(partialText);
  }, 30_000);

  it("keeps the previous provider suggestions when a replacement batch fails", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座海岛每逢满月就会忘记一个居民。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("heading", { name: "方案 3" });
    await waitFor(() => expect(screen.getAllByText("AI 已生成")).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());
    const initial = await harness.runtime.creativeJourneys.listActive("idea");
    const initialSuggestions = initial[0]?.snapshot.openingSuggestions;
    const initialSelection = initial[0]?.snapshot.selectedOpeningId;
    const initialPreview = initial[0]?.snapshot.preview;

    harness.generate.mockRejectedValue(
      Object.assign(new Error("provider unavailable"), { code: "MODEL_PROVIDER_UNAVAILABLE" }),
    );
    await user.click(screen.getByRole("button", { name: "换一批" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());

    expect(await screen.findByText("3 个 AI 建议没有生成")).toBeVisible();
    const afterFailure = await harness.runtime.creativeJourneys.listActive("idea");
    expect(afterFailure[0]?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "failed" }),
    ]);
    expect(afterFailure[0]?.snapshot.openingResultHistory).toEqual(initialSuggestions);
    expect(afterFailure[0]?.snapshot.selectedOpeningId).toBe(initialSelection);
    expect(afterFailure[0]?.snapshot.preview).toBe(initialPreview);
    expect(afterFailure[0]?.snapshot.openingBatchFailureCount).toBe(3);
    expect(screen.getAllByText("已安全归档")).toHaveLength(3);
    const projects = await harness.runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) {
      throw new Error("失败批次没有保留可恢复的空作品。");
    }
    expect(projects.value).toHaveLength(1);
    const chapters = await harness.runtime.repositories.chapters.listByProjectId(
      projects.value[0].id,
    );
    if (!chapters.ok || chapters.value[0] === undefined) {
      throw new Error("失败批次没有保留可恢复的第一章。");
    }
    expect(chapters.value[0].content).toBe("");
    const versions = await harness.runtime.repositories.chapterVersions.listByChapterId(
      chapters.value[0].id,
    );
    expect(versions.ok && versions.value).toHaveLength(1);
    const candidates = await harness.runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidates.ok && candidates.value).toHaveLength(0);
    const traces = await harness.runtime.contextTraces.listByProjectId(projects.value[0].id);
    expect(traces).toHaveLength(6);
    expect(new Set(traces.map(({ id }) => id)).size).toBe(6);
  }, 30_000);

  it("persists the provider batch plan, checkpoints an out-of-order result in its fixed slot, and never auto-repeats after resume", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();

    const resolvers = new Map<string, (value: { text: string; usage: null }) => void>();
    harness.generate.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          resolvers.set(input.generationId, resolve);
        }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座山城的路灯会替失踪者记住最后一句话。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));

    const plannedRecords = await harness.runtime.creativeJourneys.listActive("idea");
    const planned = plannedRecords[0];
    if (planned === undefined) throw new Error("AI 开书批次没有先保存。 ");
    const plannedSuggestions = planned.snapshot.openingSuggestions as readonly Readonly<{
      id: string;
      openingAngle: string;
      status: string;
    }>[];
    expect(plannedSuggestions).toHaveLength(3);
    expect(plannedSuggestions.every(({ status }) => status === "pending")).toBe(true);
    expect(new Set(plannedSuggestions.map(({ id }) => id)).size).toBe(3);
    expect(new Set(plannedSuggestions.map(({ openingAngle }) => openingAngle)).size).toBe(3);
    expect(new Set(harness.generate.mock.calls.map(([request]) => request.generationId))).toEqual(
      new Set(plannedSuggestions.map(({ id }) => id)),
    );

    expect(screen.getByRole("button", { name: "返回创作首页" })).toBeDisabled();
    first.unmount();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText(/3 个方案尚未返回/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "换一批" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "增加悬念" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保留开头，确认创建" })).toBeDisabled();

    const thirdRequestId = plannedSuggestions[2]?.id;
    if (thirdRequestId === undefined) throw new Error("第三个固定建议槽没有请求编号。");
    resolvers.get(thirdRequestId)?.({
      text: "这是一段乱序返回但已经完成计费的正文。",
      usage: null,
    });
    await waitFor(async () => {
      const latest = await harness.runtime.creativeJourneys.findById(planned.id);
      const suggestions = latest?.snapshot.openingSuggestions as
        readonly Readonly<{ status: string; text: string }>[] | undefined;
      expect(suggestions?.filter(({ status }) => status === "ready")).toHaveLength(1);
      expect(suggestions?.filter(({ status }) => status === "pending")).toHaveLength(2);
      expect(suggestions?.[2]).toMatchObject({
        status: "ready",
        text: "这是一段乱序返回但已经完成计费的正文。",
      });
    });
    expect(harness.generate).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("这是一段乱序返回但已经完成计费的正文。")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回创作首页" }));
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText("这是一段乱序返回但已经完成计费的正文。")).toBeVisible();
    expect(screen.getByText(/2 个方案尚未返回/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "换一批" })).toBeDisabled();
    expect(harness.generate).toHaveBeenCalledTimes(3);

    const turns = await harness.runtime.creativeJourneys.listTurns(planned.id);
    const resultTurn = turns.find(
      ({ requestId, snapshot }) =>
        requestId === plannedSuggestions[2]?.id && snapshot.status === "ready",
    );
    expect(resultTurn?.snapshot).toMatchObject({
      openingAngle: plannedSuggestions[2]?.openingAngle,
      status: "ready",
    });
    await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
  }, 30_000);

  it("archives an old batch result after the author ends it and generates a replacement batch", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();

    let resolveOldBatch!: (value: { text: string; usage: null }) => void;
    harness.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldBatch = resolve;
        }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "每个冬至，海边小镇都会收到一封没有寄件人的判决书。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    const oldRequestId = harness.generate.mock.calls[0]?.[0].generationId;
    const active = (await harness.runtime.creativeJourneys.listActive("idea"))[0];
    if (active === undefined || oldRequestId === undefined) {
      throw new Error("旧批次没有先保存请求计划。");
    }

    first.unmount();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
    await waitFor(() => expect(harness.cancelGeneration).toHaveBeenCalledWith(oldRequestId));
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "换一批" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(6));
    await screen.findByRole("heading", { name: "方案 3" });
    const replacement = await harness.runtime.creativeJourneys.findById(active.id);
    const replacementSelection = replacement?.snapshot.selectedOpeningId;
    const replacementPreview = replacement?.snapshot.preview;

    resolveOldBatch({ text: "旧批次结束后才返回的已计费正文。", usage: null });
    await waitFor(async () => {
      const latest = await harness.runtime.creativeJourneys.findById(active.id);
      const history = latest?.snapshot.openingResultHistory as
        readonly Readonly<{ id: string; status: string; text: string }>[] | undefined;
      expect(history?.find(({ id }) => id === oldRequestId)).toMatchObject({
        status: "ready",
        text: "旧批次结束后才返回的已计费正文。",
      });
      expect(latest?.snapshot.selectedOpeningId).toBe(replacementSelection);
      expect(latest?.snapshot.preview).toBe(replacementPreview);
    });
    expect(harness.generate).toHaveBeenCalledTimes(6);
    const turns = await harness.runtime.creativeJourneys.listTurns(active.id);
    expect(
      turns.find(
        ({ requestId, snapshot }) =>
          requestId === oldRequestId && snapshot.historicalResult === true,
      )?.snapshot,
    ).toMatchObject({ status: "ready", historicalResult: true });
  }, 30_000);

  it("updates only ProjectSeed on answer and dispatches again only after an explicit request", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一名修表匠发现每块停摆的表都记着不同的明天。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("heading", { name: "方案 3" });
    await waitFor(() => expect(screen.getAllByText("AI 已生成")).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());
    const previewBeforeAnswer = (await harness.runtime.creativeJourneys.listActive("idea"))[0]
      ?.snapshot.preview;
    const generationCountBeforeAnswer = harness.generate.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "增加悬念" }));
    expect(
      await screen.findByRole("heading", { name: "这一段主要跟着怎样的主角？" }),
    ).toBeVisible();
    expect(harness.generate).toHaveBeenCalledTimes(generationCountBeforeAnswer);
    const active = (await harness.runtime.creativeJourneys.listActive("idea"))[0];
    if (active === undefined) throw new Error("回答没有保存到构思流程。 ");
    expect(active.snapshot.pendingRequestId).toBeNull();
    expect(active.snapshot.preview).toBe(previewBeforeAnswer);
    expect(active.currentState).toBe("asking_one_question");
    expect(parseProjectSeed(active.snapshot.projectSeed)?.currentDirection.values).toEqual([
      "增加悬念",
    ]);

    await user.click(screen.getByRole("button", { name: "换一批" }));
    await waitFor(() =>
      expect(harness.generate).toHaveBeenCalledTimes(generationCountBeforeAnswer + 3),
    );
  }, 30_000);

  it("lets a reopened process end an orphaned pending request without calling the provider", async () => {
    const harness = createTauriIdeaRuntime(false);
    const now = harness.runtime.clock.now();
    const journeyId = harness.runtime.ids.next();
    const batchId = harness.runtime.ids.next();
    const readyId = harness.runtime.ids.next();
    const pendingId = harness.runtime.ids.next();
    const record: CreativeJourneyRecord = Object.freeze({
      id: journeyId,
      kind: "idea",
      status: "active",
      currentState: "generation_pending",
      projectId: null,
      chapterId: null,
      candidateId: null,
      revision: 1,
      snapshot: Object.freeze({
        version: 1,
        openingMode: "guided",
        idea: "一座城市会在雨夜忘记一条街。",
        preview: "雨落下来时，地图上先少了一条线。",
        previewSource: "provider",
        providerId: "ollama",
        modelId: "local-novel",
        noticeCode: null,
        pendingRequestId: pendingId,
        openingGenerationMode: "provider",
        openingSuggestions: Object.freeze([
          Object.freeze({
            id: readyId,
            batchId,
            text: "雨落下来时，地图上先少了一条线。",
            source: "provider",
            status: "ready",
            openingAngle: "immediate_action",
            providerId: "ollama",
            modelId: "local-novel",
            noticeCode: null,
          }),
          Object.freeze({
            id: pendingId,
            batchId,
            text: "",
            source: "provider",
            status: "pending",
            openingAngle: "relationship_dialogue",
            providerId: null,
            modelId: null,
            noticeCode: null,
          }),
        ]),
        openingResultHistory: Object.freeze([]),
        selectedOpeningId: readyId,
        openingBatchId: batchId,
        openingBatchFailureCount: 0,
        provisioningPlan: null,
        answers: Object.freeze({}),
        skippedQuestionKeys: Object.freeze([]),
        questionHistory: Object.freeze([]),
        currentQuestionKey: "opening_direction",
        projectName: "雨夜失街",
        storySummary: "一座城市会在雨夜忘记一条街。",
        summaryCustomized: false,
        projectSeed: deriveIdeaProjectSeed({
          seedId: `idea:${journeyId}`,
          idea: "一座城市会在雨夜忘记一条街。",
          answers: {},
          skippedQuestionKeys: [],
          now,
        }),
      }),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    await harness.runtime.creativeJourneys.create(record, {
      id: harness.runtime.ids.next(),
      journeyId,
      sequence: 1,
      kind: "idea",
      questionKey: null,
      generationSource: null,
      providerId: null,
      modelId: null,
      taskKey: "opening_guidance",
      requestId: pendingId,
      snapshot: Object.freeze({ status: "pending", batchId }),
      createdAt: now,
    });

    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText(/1 个方案尚未返回/u)).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
    await waitFor(() => expect(screen.queryByText(/1 个方案尚未返回/u)).not.toBeInTheDocument());
    expect(harness.cancelGeneration).toHaveBeenCalledWith(pendingId);
    expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled();
    expect(screen.getByText("你已结束这次未完成请求；恢复流程不会自动重新调用 AI。")).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();

    const saved = await harness.runtime.creativeJourneys.findById(journeyId);
    expect(saved?.snapshot.pendingRequestId).toBeNull();
    expect(saved?.snapshot.openingResultHistory).toEqual([
      expect.objectContaining({
        id: pendingId,
        status: "failed",
        noticeCode: "GENERATION_ABANDONED_BY_AUTHOR",
      }),
    ]);
    const turns = await harness.runtime.creativeJourneys.listTurns(journeyId);
    expect(turns.at(-1)?.snapshot).toMatchObject({
      status: "abandoned",
      requestIds: [pendingId],
      batchId,
    });
  });

  it("archives a paid result that returns after abandonment without replacing the current choice", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一名邮差每天都收到明天寄来的退信。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("heading", { name: "方案 3" });
    harness.generate.mockClear();

    let resolveAnswer!: (value: { text: string; usage: null }) => void;
    harness.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "换一批" }));
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    const requestId = harness.generate.mock.calls[0]?.[0].generationId;
    const active = (await harness.runtime.creativeJourneys.listActive("idea"))[0];
    if (active === undefined || requestId === undefined) {
      throw new Error("迟到结果测试没有保存待处理请求。");
    }

    first.unmount();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());
    const alternativeChoice = screen.getAllByRole("button", {
      name: /^选择方案 \d+$/u,
    })[0];
    if (alternativeChoice === undefined) throw new Error("没有可切换的已完成建议。");
    await user.click(alternativeChoice);
    const selectedBeforeReturn = await harness.runtime.creativeJourneys.findById(active.id);
    const selectedId = selectedBeforeReturn?.snapshot.selectedOpeningId;
    const selectedPreview = selectedBeforeReturn?.snapshot.preview;

    resolveAnswer({ text: "这是一份结束等待后才返回、已经计费的正文。", usage: null });
    await waitFor(async () => {
      const latest = await harness.runtime.creativeJourneys.findById(active.id);
      const history = latest?.snapshot.openingResultHistory as
        readonly Readonly<{ id: string; status: string; text: string }>[] | undefined;
      expect(history?.find(({ id }) => id === requestId)).toMatchObject({
        status: "ready",
        text: "这是一份结束等待后才返回、已经计费的正文。",
      });
      expect(latest?.snapshot.selectedOpeningId).toBe(selectedId);
      expect(latest?.snapshot.preview).toBe(selectedPreview);
    });
    expect(harness.generate).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole("button", { name: "返回创作首页" }));
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText("较早请求返回的结果")).toBeVisible();
    expect(screen.getByText("这是一份结束等待后才返回、已经计费的正文。")).toBeVisible();
    const reloaded = await harness.runtime.creativeJourneys.findById(active.id);
    expect(reloaded?.snapshot.selectedOpeningId).toBe(selectedId);
    expect(reloaded?.snapshot.preview).toBe(selectedPreview);
  }, 30_000);

  it.each(["project", "chapter"] as const)(
    "recovers the exact planned %s id after a post-create journey checkpoint crash",
    async (failurePoint) => {
      const base = createDevelopmentRuntime(window.localStorage);
      const createJourney = vi.spyOn(base.creativeJourneys, "create");
      const originalUpdate = base.creativeJourneys.update.bind(base.creativeJourneys);
      let failOnce = true;
      const creativeJourneys = {
        findById: base.creativeJourneys.findById.bind(base.creativeJourneys),
        listActive: base.creativeJourneys.listActive.bind(base.creativeJourneys),
        listTurns: base.creativeJourneys.listTurns.bind(base.creativeJourneys),
        create: base.creativeJourneys.create.bind(base.creativeJourneys),
        update: (
          record: CreativeJourneyRecord,
          expectedRevision: number,
          turn?: CreativeJourneyTurnRecord,
        ) => {
          const reachedFailurePoint =
            failurePoint === "project"
              ? record.projectId !== null && record.chapterId === null
              : record.chapterId !== null;
          if (failOnce && reachedFailurePoint) {
            failOnce = false;
            return Promise.reject(new Error(`simulated ${failurePoint} checkpoint crash`));
          }
          return originalUpdate(record, expectedRevision, turn);
        },
      };
      const runtime: DesktopRuntime = Object.freeze({ ...base, creativeJourneys });
      const user = userEvent.setup();
      renderJourney(runtime);

      await user.click(await screen.findByRole("button", { name: "不输入灵感，直接空白写作" }));
      await waitFor(async () => {
        const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
        expect(projects.ok && projects.value).toHaveLength(1);
      });
      const interrupted = (await runtime.creativeJourneys.listActive("idea"))[0];
      if (interrupted === undefined) throw new Error("中断后的空白写作旅程没有保留。 ");
      const plan = interrupted.snapshot.provisioningPlan as Readonly<{
        projectId: string;
        chapterId: string;
        initialVersionId: string;
        projectName: string;
      }>;
      const projectsBefore = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
      if (!projectsBefore.ok || projectsBefore.value[0] === undefined) {
        throw new Error("计划中的作品没有创建。 ");
      }
      expect(projectsBefore.value[0].id).toBe(plan.projectId);
      if (failurePoint === "project") {
        expect(interrupted.projectId).toBeNull();
      } else {
        const chaptersBefore = await runtime.repositories.chapters.listByProjectId(
          projectsBefore.value[0].id,
        );
        expect(chaptersBefore.ok && chaptersBefore.value[0]?.id).toBe(plan.chapterId);
        expect(interrupted.chapterId).toBeNull();
      }

      await user.click(await screen.findByRole("button", { name: "重试创建" }));
      expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
      expect(createJourney).toHaveBeenCalledTimes(1);
      const projectsAfter = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
      expect(projectsAfter.ok && projectsAfter.value).toHaveLength(1);
      if (!projectsAfter.ok || projectsAfter.value[0] === undefined) return;
      const chaptersAfter = await runtime.repositories.chapters.listByProjectId(
        projectsAfter.value[0].id,
      );
      expect(chaptersAfter.ok && chaptersAfter.value).toHaveLength(1);
      expect(chaptersAfter.ok && chaptersAfter.value[0]?.id).toBe(plan.chapterId);
      if (!chaptersAfter.ok || chaptersAfter.value[0] === undefined) {
        throw new Error("计划中的第一章没有恢复。 ");
      }
      const versions = await runtime.repositories.chapterVersions.listByChapterId(
        chaptersAfter.value[0].id,
      );
      expect(versions.ok && versions.value).toHaveLength(1);
      expect(versions.ok && versions.value[0]?.id).toBe(plan.initialVersionId);
    },
  );

  it("takes a synchronous resume lock before the first await so a double activation cannot start two recoveries", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const now = base.clock.now();
    const journeyId = base.ids.next();
    const record: CreativeJourneyRecord = Object.freeze({
      id: journeyId,
      kind: "idea",
      status: "active",
      currentState: "creating_project",
      projectId: null,
      chapterId: null,
      candidateId: null,
      revision: 1,
      snapshot: Object.freeze({
        version: 1,
        openingMode: "self",
        idea: "",
        preview: "",
        previewSource: null,
        providerId: null,
        modelId: null,
        noticeCode: null,
        pendingRequestId: null,
        openingGenerationMode: "local",
        openingSuggestions: Object.freeze([]),
        selectedOpeningId: null,
        openingBatchId: null,
        openingBatchFailureCount: 0,
        provisioningPlan: Object.freeze({
          projectId: base.ids.next(),
          chapterId: base.ids.next(),
          initialVersionId: base.ids.next(),
          projectName: null,
        }),
        answers: Object.freeze({}),
        skippedQuestionKeys: Object.freeze([]),
        questionHistory: Object.freeze([]),
        currentQuestionKey: "opening_direction",
        projectName: "未命名新故事",
        storySummary: "",
        summaryCustomized: false,
        projectSeed: deriveIdeaProjectSeed({
          seedId: `idea-self:${journeyId}`,
          idea: "",
          answers: {},
          skippedQuestionKeys: [],
          now,
        }),
      }),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    await base.creativeJourneys.create(record, {
      id: base.ids.next(),
      journeyId,
      sequence: 1,
      kind: "idea",
      questionKey: null,
      generationSource: null,
      providerId: null,
      modelId: null,
      taskKey: null,
      requestId: null,
      snapshot: Object.freeze({ openingMode: "self" }),
      createdAt: now,
    });

    let releaseFind!: () => void;
    const findById = vi.fn(
      () =>
        new Promise<CreativeJourneyRecord | null>((resolve) => {
          releaseFind = () => resolve(record);
        }),
    );
    const creativeJourneys = {
      findById,
      listActive: base.creativeJourneys.listActive.bind(base.creativeJourneys),
      listTurns: base.creativeJourneys.listTurns.bind(base.creativeJourneys),
      create: base.creativeJourneys.create.bind(base.creativeJourneys),
      update: base.creativeJourneys.update.bind(base.creativeJourneys),
    };
    const runtime: DesktopRuntime = Object.freeze({ ...base, creativeJourneys });
    renderJourney(runtime);
    const resumeButton = await screen.findByRole("button", { name: "继续创建空白作品" });
    await act(async () => {
      resumeButton.click();
      resumeButton.click();
      await Promise.resolve();
    });
    expect(findById).toHaveBeenCalledTimes(1);
    expect(resumeButton).toBeDisabled();

    releaseFind();
    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    const projects = await runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects.ok && projects.value).toHaveLength(1);
    if (!projects.ok || projects.value[0] === undefined) return;
    const chapters = await runtime.repositories.chapters.listByProjectId(projects.value[0].id);
    expect(chapters.ok && chapters.value).toHaveLength(1);
  });

  it("resumes a legacy single-preview snapshot without rejecting or duplicating it", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const now = runtime.clock.now();
    const journeyId = runtime.ids.next();
    const legacySnapshot = Object.freeze({
      version: 1,
      openingMode: "guided",
      idea: "午夜列车只在无人记得的站台停靠。",
      preview: "这是旧版本保存的一段开头。",
      previewSource: "provider",
      providerId: "legacy-provider",
      modelId: "legacy-model",
      noticeCode: null,
      pendingRequestId: null,
      answers: Object.freeze({}),
      skippedQuestionKeys: Object.freeze([]),
      questionHistory: Object.freeze([]),
      currentQuestionKey: "opening_direction",
      projectName: "午夜列车",
      storySummary: "午夜列车只在无人记得的站台停靠。",
      summaryCustomized: false,
      projectSeed: deriveIdeaProjectSeed({
        seedId: `idea:${journeyId}`,
        idea: "午夜列车只在无人记得的站台停靠。",
        answers: {},
        skippedQuestionKeys: [],
        now,
      }),
    });
    const record: CreativeJourneyRecord = Object.freeze({
      id: journeyId,
      kind: "idea",
      status: "active",
      currentState: "asking_one_question",
      projectId: null,
      chapterId: null,
      candidateId: null,
      revision: 1,
      snapshot: legacySnapshot,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const turn: CreativeJourneyTurnRecord = Object.freeze({
      id: runtime.ids.next(),
      journeyId,
      sequence: 1,
      kind: "idea",
      questionKey: null,
      generationSource: null,
      providerId: null,
      modelId: null,
      taskKey: "opening_guidance",
      requestId: null,
      snapshot: Object.freeze({ userText: legacySnapshot.idea }),
      createdAt: now,
    });
    await runtime.creativeJourneys.create(record, turn);
    const user = userEvent.setup();
    renderJourney(runtime);

    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText("这是旧版本保存的一段开头。")).toBeVisible();
    expect(screen.getByText("1/3 可用")).toBeVisible();
    expect(screen.queryByText("有一条旧构思暂时无法读取")).not.toBeInTheDocument();
  });

  it("resumes an interrupted self-writing checkpoint without duplicating the project or creating a candidate", async () => {
    const firstHarness = createTauriIdeaRuntime(true);
    const user = userEvent.setup();
    const first = renderJourney(firstHarness.runtime);
    await screen.findByText("AI 还没连接，也可以开始");
    await user.click(screen.getByRole("button", { name: "去连接 AI" }));
    await user.click(screen.getByRole("radio", { name: /Ollama/u }));
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
    await screen.findByText("连接成功 · 已找到模型");
    await user.click(screen.getByRole("radio", { name: /我自己写/u }));
    await user.click(screen.getByRole("button", { name: "继续" }));

    await user.type(
      screen.getByRole("textbox", { name: /^一句话灵感/u }),
      "一名邮差发现所有退信都来自明天。",
    );
    await user.click(screen.getByRole("button", { name: "创建空白作品" }));
    expect(await screen.findByRole("button", { name: "继续创建空白作品" })).toBeEnabled();
    const firstProjects = await firstHarness.runtime.useCases.listProjects.execute({
      statuses: ["active"],
    });
    expect(firstProjects.ok && firstProjects.value).toHaveLength(1);
    expect(firstHarness.generate).not.toHaveBeenCalled();
    first.unmount();

    const resumedHarness = createTauriIdeaRuntime(false);
    renderJourney(resumedHarness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续创建空白作品" }));
    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();

    const projects = await resumedHarness.runtime.useCases.listProjects.execute({
      statuses: ["active"],
    });
    if (!projects.ok || projects.value[0] === undefined) throw new Error("空白作品没有恢复。");
    expect(projects.value).toHaveLength(1);
    const chapters = await resumedHarness.runtime.repositories.chapters.listByProjectId(
      projects.value[0].id,
    );
    if (!chapters.ok || chapters.value[0] === undefined) throw new Error("空白章节没有恢复。");
    expect(chapters.value).toHaveLength(1);
    expect(chapters.value[0].content).toBe("");
    const candidates = await resumedHarness.runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidates.ok && candidates.value).toHaveLength(0);
    const seed = await resumedHarness.runtime.projectSeeds.findByProjectId(projects.value[0].id);
    expect(seed?.seed.premise.values).toEqual(["一名邮差发现所有退信都来自明天。"]);
    expect(resumedHarness.generate).not.toHaveBeenCalled();
  });
});

function createTauriIdeaRuntime(failSeedOnce: boolean) {
  const base = createDevelopmentRuntime(window.localStorage);
  const generate = vi.fn((input: Parameters<NativeModelGatewayClient["generate"]>[0]) =>
    Promise.resolve({ text: `供应商开头 ${input.generationId}`, usage: null }),
  );
  const cancelGeneration = vi.fn(() => Promise.resolve(true));
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    checkConnection: (config) =>
      Promise.resolve({
        provider: config.provider,
        endpointOrigin: new URL(config.baseUrl).origin,
        modelCount: 1,
        latencyMs: 5,
      }),
    listModels: (config) =>
      Promise.resolve({
        provider: config.provider,
        models: [{ id: "local-novel", displayName: "Local Novel" }],
      }),
    generate,
    cancelGeneration,
    embed: base.modelGateway.embed.bind(base.modelGateway),
    ...(base.modelGateway.rerank === undefined
      ? {}
      : { rerank: base.modelGateway.rerank.bind(base.modelGateway) }),
  };
  let shouldFail = failSeedOnce;
  const projectSeeds = {
    findByProjectId: base.projectSeeds.findByProjectId.bind(base.projectSeeds),
    saveForProject: (
      projectId: string,
      seed: Parameters<typeof base.projectSeeds.saveForProject>[1],
    ) => {
      if (shouldFail) {
        shouldFail = false;
        return Promise.reject(new Error("simulated seed checkpoint failure"));
      }
      return base.projectSeeds.saveForProject(projectId, seed);
    },
  };
  const runtime: DesktopRuntime = Object.freeze({
    ...base,
    mode: "tauri",
    modelGateway,
    projectSeeds,
  });
  return { runtime, generate, cancelGeneration };
}

async function connectOllamaForAiOpening(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText("AI 还没连接，也可以开始");
  await user.click(screen.getByRole("button", { name: "去连接 AI" }));
  await user.click(screen.getByRole("radio", { name: /Ollama/u }));
  await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
  await screen.findByText("连接成功 · 已找到模型");
  await user.click(screen.getByRole("radio", { name: /让 AI 起个头/u }));
  await user.click(screen.getByRole("button", { name: "继续" }));
  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "连接你的 AI" })).not.toBeInTheDocument();
  });
}

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

class FaultInjectingStorage implements Storage {
  private nextWriteError: Error | null = null;

  public constructor(private readonly delegate: Storage) {}

  public get length(): number {
    return this.delegate.length;
  }

  public clear(): void {
    this.delegate.clear();
  }

  public failNextWrite(error: Error): void {
    this.nextWriteError = error;
  }

  public getItem(key: string): string | null {
    return this.delegate.getItem(key);
  }

  public key(index: number): string | null {
    return this.delegate.key(index);
  }

  public removeItem(key: string): void {
    this.delegate.removeItem(key);
  }

  public setItem(key: string, value: string): void {
    if (this.nextWriteError !== null) {
      const error = this.nextWriteError;
      this.nextWriteError = null;
      throw error;
    }
    this.delegate.setItem(key, value);
  }
}
