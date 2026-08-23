import { ToastProvider } from "@inkshadow/ui";
import { parseUuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuid } from "@inkshadow/story-core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { readSafeGuidedOpeningStatus } from "../infrastructure/guided-opening-diagnostics";
import { CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS } from "../infrastructure/creative-opening-service";
import { readOpeningJourneyRun } from "../infrastructure/opening-journey-run";
import { recoverOrphanedOpeningInvocationsAtStartup } from "../infrastructure/opening-startup-recovery";
import { deriveIdeaProjectSeed, parseProjectSeed } from "../infrastructure/project-seed";
import type {
  CreativeJourneyRecord,
  CreativeJourneyTurnRecord,
} from "../infrastructure/creative-journey-store";
import { RuntimeProvider } from "../runtime-context";
import { IdeaJourneyPage } from "./idea-journey-page";

const DIRECT_OPENING_WITH_LOCAL_FACTS =
  "林澈来到钟楼。周野的真实身份是守门人。暮色顺着旧城的屋脊缓慢落下，坏掉多年的铜钟忽然响了一声。林澈没有回头，只把口袋里的怀表握得更紧，沿着旋梯继续向上。";
const ASYNC_UI_TIMEOUT = Object.freeze({ timeout: 15_000 });

describe("one-sentence idea journey", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The established suite exercises the professional flow. Direct-mode
    // cases below explicitly remove this upgrade signal before creating the runtime.
    window.localStorage.setItem("inkshadow.professional-create-recovery.v1", "{}");
  });

  it("creates a resumable local opening and asks only bounded gap-driven questions", async () => {
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
    expect(screen.getByRole("button", { name: "选择这个开头" })).toBeEnabled();
    expect(
      screen.queryByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保留开头，确认创建" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "选择这个开头" }));
    expect(
      await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "增加一个悬念" })).toBeEnabled();
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
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
    expect(active[0]?.snapshot).toMatchObject({
      expectedQuestionTotal: 3,
      questionIndex: 0,
      questionPlan: ["opening_direction", "protagonist", "conflict"],
    });
  });

  it("persists one bounded dynamic plan without appending surprise questions", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一封来自十年后的信改变了女主的暑假。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    await user.click(await screen.findByRole("button", { name: "增加一个悬念" }));

    expect(
      await screen.findByRole("heading", {
        name: "为了继续写下去，主角当前最重要的特征是什么？",
      }),
    ).toBeVisible();
    expect(screen.getByText(/第 2\/3 问/u)).toBeVisible();
    expect(screen.getByText(/已完成 1\/3（33%）/u)).toBeVisible();
    expect(screen.queryByText("问题计划已按你的新信息扩展")).not.toBeInTheDocument();
    const active = await runtime.creativeJourneys.listActive("idea");
    expect(active[0]?.snapshot).toMatchObject({
      expectedQuestionTotal: 3,
      questionIndex: 1,
      questionHistory: ["opening_direction"],
    });
    expect(active[0]?.snapshot.questionPlan).toEqual([
      "opening_direction",
      "protagonist",
      "conflict",
    ]);
    expect(active[0]?.snapshot.remainingQuestionFocus).not.toContain("opening_direction");
  });

  it("finishes a no-new-information plan and requires reselecting exactly one explicit rewrite", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一间永远停在午夜的书店。 ",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    for (let index = 0; index < 3; index += 1) {
      await user.click(await screen.findByRole("button", { name: "跳过" }));
    }
    expect(await screen.findByText("问题计划已完成")).toBeVisible();
    expect(screen.getByText(/已走完 3\/3 问（100%）；剩余重点：无/u)).toBeVisible();
    const beforeRewrite = (await runtime.creativeJourneys.listActive("idea"))[0];
    expect(beforeRewrite?.snapshot).toMatchObject({
      expectedQuestionTotal: 3,
      questionIndex: 3,
      questionHistory: ["opening_direction", "protagonist", "conflict"],
      skippedQuestionKeys: ["opening_direction", "protagonist", "conflict"],
      remainingQuestionFocus: [],
      guidanceRewriteUsed: false,
    });

    const rewriteButton = screen.getAllByRole("button", { name: "根据回答重写一次" })[0];
    if (rewriteButton === undefined) throw new Error("完成态没有明确重写入口。 ");
    await user.click(rewriteButton);
    const afterRegeneration = (await runtime.creativeJourneys.listActive("idea"))[0];
    expect(afterRegeneration?.snapshot.selectedOpeningId).toBeNull();
    expect(afterRegeneration?.snapshot.questionPlanner).toBeNull();
    expect(screen.queryByText("问题计划已完成")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "直接确认创建" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    for (let index = 0; index < 3; index += 1) {
      await user.click(await screen.findByRole("button", { name: "跳过" }));
    }
    expect(await screen.findByText("问题计划已完成")).toBeVisible();
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "已明确重写一次" })[0]).toBeDisabled();
    });
    const afterRewrite = (await runtime.creativeJourneys.listActive("idea"))[0];
    expect(afterRewrite?.currentState).toBe("guidance_complete");
    expect(afterRewrite?.snapshot.guidanceRewriteUsed).toBe(true);
    expect(afterRewrite?.snapshot.questionPlan).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "直接确认创建" }));
    expect(await screen.findByRole("heading", { name: "都准备好了，看一眼全貌" })).toBeVisible();
  });

  it("opens the creation summary immediately when the selected opening has zero actionable gaps", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const first = renderJourney(runtime);
    const idea = "一个转学生发现旧校舍每逢下雨就会响起铜铃。";
    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), idea);
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("button", { name: "选择这个开头" });
    const [active] = await runtime.creativeJourneys.listActive("idea");
    if (active === undefined) throw new Error("零问题测试没有保存本地草案。");
    const answers = Object.freeze({
      opening_direction: "追查铃声来源",
      protagonist: "谨慎敏锐的转学生",
      conflict: "必须在校舍封闭前找到铜铃",
      relationship: "与值日生刚认识",
      pov: "第三人称限知",
      tone: "紧张悬疑",
      genre: "校园悬疑",
      world: "当代沿海小城",
      style: "短句、克制",
      boundaries: "不写超自然定论",
    });
    first.unmount();
    const seeded: CreativeJourneyRecord = Object.freeze({
      ...active,
      revision: active.revision + 1,
      snapshot: Object.freeze({
        ...active.snapshot,
        answers,
        projectSeed: deriveIdeaProjectSeed({
          seedId: `idea:${active.id}`,
          idea,
          answers,
          skippedQuestionKeys: [],
          now: runtime.clock.now(),
        }),
      }),
      updatedAt: runtime.clock.now(),
    });
    await runtime.creativeJourneys.update(seeded, active.revision);

    renderJourney(runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    expect(await screen.findByText("问题计划已完成")).toBeVisible();
    const [planned] = await runtime.creativeJourneys.listActive("idea");
    expect(planned?.currentState).toBe("guidance_complete");
    expect(planned?.snapshot.questionPlanner).toMatchObject({
      source: "deterministic_fallback",
      questions: [],
    });
    expect(screen.queryByRole("heading", { level: 2, name: /什么/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "直接确认创建" }));
    expect(await screen.findByRole("heading", { name: "都准备好了，看一眼全貌" })).toBeVisible();
  });

  it("removes an earlier answer when the user returns and skips that question", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), "雨会倒流的城市。 ");
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    await user.click(await screen.findByRole("button", { name: "增加一个悬念" }));
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
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" });

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
    expect(
      screen.queryByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" });
    const regenerationCount = (await runtime.creativeJourneys.listTurns(journeyId)).filter(
      ({ kind }) => kind === "regenerate",
    ).length;

    const customAnswer = screen.getByRole("textbox", { name: /^自己回答/ });
    await user.type(customAnswer, "保留悬念，但让对话更克制");
    await user.click(screen.getByRole("button", { name: "采用我的回答" }));
    await screen.findByRole("heading", {
      name: "为了继续写下去，主角当前最重要的特征是什么？",
    });
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
    const first = renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "失忆少年每天醒来都会收到同一个陌生女孩的留言。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    await user.click(await screen.findByRole("button", { name: "保留开头，确认创建" }));

    expect(await screen.findByRole("heading", { name: "都准备好了，看一眼全貌" })).toBeVisible();
    const projectName = screen.getByRole("textbox", { name: /^书名/ });
    const storySummary = screen.getByRole("textbox", { name: /^故事摘要/ });
    await user.clear(projectName);
    await user.type(projectName, "午夜留言");
    await user.clear(storySummary);
    await user.type(storySummary, "失忆少年每天收到陌生女孩留言，并决定追查留言来自何处。");
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" });
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
    await user.click(screen.getByRole("button", { name: "创建作品，查看本地草案" }));

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
    expect(journeys).toHaveLength(1);
    expect(journeys[0]).toMatchObject({
      status: "active",
      currentState: "candidate_ready",
      candidateId: candidates.ok ? candidates.value[0]?.id : undefined,
    });
    if (!candidates.ok || candidates.value[0] === undefined || journeys[0] === undefined) {
      throw new Error("候选建议没有保持在可恢复状态。");
    }
    const readyCandidate = candidates.value[0];
    const readyJourney = journeys[0];
    const readyTurnCount = (await runtime.creativeJourneys.listTurns(reviewJourneyId)).length;
    first.unmount();
    renderJourney(runtime, `/create/idea?journey=${reviewJourneyId}`);
    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    expect((await runtime.creativeJourneys.findById(reviewJourneyId))?.revision).toBe(
      readyJourney.revision,
    );
    expect(await runtime.creativeJourneys.listTurns(reviewJourneyId)).toHaveLength(readyTurnCount);
    const reopenedChapter = await runtime.repositories.chapters.findById(chapters.value[0].id);
    expect(reopenedChapter.ok && reopenedChapter.value?.content).toBe("");
    const reopenedCandidate = await runtime.repositories.aiCandidates.findById(readyCandidate.id);
    expect(reopenedCandidate.ok && reopenedCandidate.value?.status).toBe("ready");

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

  it.each(["accepted", "rejected", "expired"] as const)(
    "repairs an accepted or rejected candidate_ready journey and rejects an $status candidate exactly",
    async (status) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const user = userEvent.setup();
      const first = renderJourney(runtime);
      await user.type(
        screen.getByRole("textbox", { name: "一句话灵感" }),
        "一封来自明天的信让邮差改变了今天的路线。",
      );
      await user.click(screen.getByRole("button", { name: "生成第一段" }));
      await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
      await user.click(await screen.findByRole("button", { name: "保留开头，确认创建" }));
      await screen.findByRole("heading", { name: "都准备好了，看一眼全貌" });
      await user.click(screen.getByRole("button", { name: "创建作品，查看本地草案" }));
      expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();

      const [candidateReadyJourney] = await runtime.creativeJourneys.listActive("idea");
      if (
        candidateReadyJourney?.projectId === null ||
        candidateReadyJourney?.projectId === undefined ||
        candidateReadyJourney.chapterId === null
      ) {
        throw new Error("候选建议旅程没有保存准确的项目和章节范围。");
      }
      const projectId = parseUuidV7(candidateReadyJourney.projectId);
      if (!projectId.ok) throw projectId.error;
      const chapters = await runtime.repositories.chapters.listByProjectId(projectId.value);
      if (!chapters.ok || chapters.value[0] === undefined) throw new Error("候选章节不存在。");
      const chapter = chapters.value[0];
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      if (!candidates.ok || candidates.value[0] === undefined) throw new Error("候选建议不存在。");
      const candidate = candidates.value[0];
      if (status === "accepted") {
        const decision = await runtime.useCases.acceptCandidate.execute({
          candidateId: candidate.id,
          expectedCandidateRevision: candidate.revision,
        });
        if (!decision.ok) throw decision.error;
      } else if (status === "rejected") {
        const decision = await runtime.useCases.rejectCandidate.execute({
          candidateId: candidate.id,
          expectedCandidateRevision: candidate.revision,
        });
        if (!decision.ok) throw decision.error;
      } else {
        const expired = candidate.expire(runtime.clock.now());
        if (!expired.ok) throw expired.error;
        const saved = await runtime.repositories.aiCandidates.save(expired.value, {
          status: "ready",
          revision: candidate.revision,
        });
        if (!saved.ok) throw saved.error;
      }
      const revisionBeforeRepair = candidateReadyJourney.revision;
      const turnCountBeforeRepair = (
        await runtime.creativeJourneys.listTurns(candidateReadyJourney.id)
      ).length;

      first.unmount();
      renderJourney(runtime, `/create/idea?journey=${candidateReadyJourney.id}`);
      if (status === "expired") {
        expect(
          await screen.findByText(
            "已有 AI 建议版本与当前开书流程不一致，系统已停止写入以保护正文。请从作品库打开项目确认版本后再继续。",
          ),
        ).toBeVisible();
        expect(await runtime.creativeJourneys.findById(candidateReadyJourney.id)).toMatchObject({
          status: "active",
          currentState: "candidate_ready",
          revision: revisionBeforeRepair,
        });
        expect(await runtime.creativeJourneys.listTurns(candidateReadyJourney.id)).toHaveLength(
          turnCountBeforeRepair,
        );
        const expiredCandidate = await runtime.repositories.aiCandidates.findById(candidate.id);
        expect(expiredCandidate.ok && expiredCandidate.value?.status).toBe("expired");
        const unchangedChapter = await runtime.repositories.chapters.findById(chapter.id);
        expect(unchangedChapter.ok && unchangedChapter.value?.content).toBe("");
        const unchangedVersions = await runtime.repositories.chapterVersions.listByChapterId(
          chapter.id,
        );
        expect(unchangedVersions.ok && unchangedVersions.value).toHaveLength(1);
        return;
      }
      expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
      await waitFor(async () => {
        expect(await runtime.creativeJourneys.findById(candidateReadyJourney.id)).toMatchObject({
          status: "completed",
          currentState: status === "accepted" ? "candidate_accepted" : "candidate_rejected",
          revision: revisionBeforeRepair + 1,
        });
      });
      expect(await runtime.creativeJourneys.listTurns(candidateReadyJourney.id)).toHaveLength(
        turnCountBeforeRepair + 1,
      );
      const settledChapter = await runtime.repositories.chapters.findById(chapter.id);
      expect(settledChapter.ok && settledChapter.value?.content).toBe(
        status === "accepted" ? candidate.content : "",
      );
      const versions = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      expect(versions.ok && versions.value).toHaveLength(status === "accepted" ? 2 : 1);
    },
  );

  it("keeps guided answers in ProjectSeed without raw aggregate cards or endpoint-free relationship facts", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    renderJourney(runtime);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "两名旧友在停电的小镇重逢。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    await user.click(await screen.findByRole("button", { name: "增加一个悬念" }));
    await user.click(await screen.findByRole("button", { name: "嘴硬心软" }));
    expect(
      await screen.findByRole("heading", { name: "眼前最先需要解决的麻烦是什么？" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "跳过" }));
    expect(await screen.findByText("问题计划已完成")).toBeVisible();
    const completedPlan = (await runtime.creativeJourneys.listActive("idea"))[0];
    const questionPlan = completedPlan?.snapshot.questionPlan as readonly string[] | undefined;
    if (questionPlan === undefined) throw new Error("完成态没有持久化问题计划。 ");
    expect(completedPlan?.currentState).toBe("guidance_complete");
    expect(completedPlan?.snapshot.remainingQuestionFocus).toEqual([]);
    expect(questionPlan.length).toBeLessThanOrEqual(12);
    expect(new Set(questionPlan).size).toBe(questionPlan.length);
    await user.click(screen.getByRole("button", { name: "直接确认创建" }));
    await user.click(await screen.findByRole("button", { name: "创建作品，查看本地草案" }));

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
    expect(seed?.seed.relationships.values).toEqual([]);
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
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
    await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" });
    first.unmount();

    renderJourney(createDevelopmentRuntime(window.localStorage));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续这次构思" })).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: "继续这次构思" }));
    expect(
      await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).toBeVisible();
  });

  it("switches exact journey queries without retaining or opening the wrong journey", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const first = renderJourneyWithRouteDriver(runtime);
    const ideaA = "甲旅程只讲一座会遗失街道的城市。";
    const ideaB = "乙旅程只讲一列驶向明天的夜车。";

    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), ideaA);
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("button", { name: "选择这个开头" });
    const journeyA = (await runtime.creativeJourneys.listActive("idea")).find(
      ({ snapshot }) => snapshot.idea === ideaA,
    );
    if (journeyA === undefined) throw new Error("甲旅程没有保存。");
    await user.click(screen.getByRole("button", { name: "返回创作首页" }));

    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), ideaB);
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("button", { name: "选择这个开头" });
    const journeyB = (await runtime.creativeJourneys.listActive("idea")).find(
      ({ snapshot }) => snapshot.idea === ideaB,
    );
    if (journeyB === undefined) throw new Error("乙旅程没有保存。");
    first.navigate(`/create/idea?journey=${journeyA.id}`);
    await waitFor(() => {
      const suggestions = screen.getByRole("list", { name: "开头建议列表" });
      expect(within(suggestions).getByText(/甲旅程只讲一座会遗失街道的城市/u)).toBeVisible();
      expect(
        within(suggestions).queryByText(/乙旅程只讲一列驶向明天的夜车/u),
      ).not.toBeInTheDocument();
    });

    first.navigate(`/create/idea?journey=${journeyB.id}`);
    await waitFor(() => {
      const suggestions = screen.getByRole("list", { name: "开头建议列表" });
      expect(within(suggestions).getByText(/乙旅程只讲一列驶向明天的夜车/u)).toBeVisible();
      expect(
        within(suggestions).queryByText(/甲旅程只讲一座会遗失街道的城市/u),
      ).not.toBeInTheDocument();
    });

    first.navigate("/create/idea?journey=不是有效编号");
    expect(
      await screen.findByText("这个未完成创作入口无效；墨影没有打开其他作品。请从作品库重新选择。"),
    ).toBeVisible();
    expect(screen.queryByRole("list", { name: "开头建议列表" })).not.toBeInTheDocument();
    first.view.unmount();

    const second = renderJourneyWithRouteDriver(runtime, `/create/idea?journey=${journeyA.id}`);
    await waitFor(() => {
      expect(
        within(screen.getByRole("list", { name: "开头建议列表" })).getByText(
          /甲旅程只讲一座会遗失街道的城市/u,
        ),
      ).toBeVisible();
    });
    second.navigate("/create/idea");
    expect(await screen.findByRole("heading", { name: "继续上次构思" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "返回创作首页" })).not.toBeInTheDocument();
  }, 30_000);
  it("attempts a failing automatic resume only once for the same exact route and revision", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    const first = renderJourney(base);
    const idea = "一名钟表匠发现每次停摆都会抹去一段共同记忆。";
    await user.type(screen.getByRole("textbox", { name: "一句话灵感" }), idea);
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await screen.findByRole("button", { name: "选择这个开头" });
    const [saved] = await base.creativeJourneys.listActive("idea");
    if (saved === undefined) throw new Error("持续读取失败测试没有保存旅程。");
    first.unmount();

    const persistentReadFailure = Object.assign(new Error("raw persistent journey read failure"), {
      code: "CREATIVE_JOURNEY_READ_FAILED",
    });
    const findById = vi.fn(async (journeyId: string) => {
      if (journeyId === saved.id) throw persistentReadFailure;
      return base.creativeJourneys.findById(journeyId);
    });
    const listActive = vi.fn(base.creativeJourneys.listActive.bind(base.creativeJourneys));
    const creativeJourneys = {
      findById,
      listActive,
      listTurns: base.creativeJourneys.listTurns.bind(base.creativeJourneys),
      create: base.creativeJourneys.create.bind(base.creativeJourneys),
      update: base.creativeJourneys.update.bind(base.creativeJourneys),
    };
    const runtime: DesktopRuntime = Object.freeze({ ...base, creativeJourneys });
    const route = renderJourneyWithRouteDriver(runtime, `/create/idea?journey=${saved.id}`);

    expect(await screen.findByRole("button", { name: "重试读取" })).toBeEnabled();
    await waitFor(() => expect(listActive).toHaveBeenCalledTimes(2));
    expect(findById).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("raw persistent journey read failure")).not.toBeInTheDocument();

    route.navigate(`/create/idea?journey=${saved.id}`);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(findById).toHaveBeenCalledTimes(1);
    route.view.unmount();
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
    await user.click(await screen.findByRole("button", { name: "选择这个开头" }));
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

  it("keeps the explicit local sample and its question plan off the configured provider", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await screen.findByText("AI 还没连接，也可以开始");
    await user.click(screen.getByRole("button", { name: "去连接 AI" }));
    await user.click(screen.getByRole("radio", { name: /Ollama/u }));
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
    await screen.findByText("连接成功 · 已找到模型");
    await user.click(screen.getByRole("radio", { name: /先看看示例/u }));
    await user.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "连接你的 AI" })).not.toBeInTheDocument();
    });
    harness.generate.mockClear();

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一场大雾让小镇所有人忘记了昨天。",
    );
    await user.click(screen.getByRole("button", { name: "先看看示例" }));
    expect(await screen.findByRole("button", { name: "选择这个开头" })).toBeEnabled();
    expect(harness.generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "选择这个开头" }));
    expect(
      await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();
    const [active] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(active?.snapshot).toMatchObject({
      openingMode: "sample",
      previewSource: "local_fallback",
      questionPlanner: {
        source: "deterministic_fallback",
        fallbackReasonCode: "LOCAL_ONLY_OPENING",
      },
    });
  }, 30_000);

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
    expect(screen.queryByText("CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED")).not.toBeInTheDocument();
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
    expect(await screen.findByText(/本地存储空间不足/u)).toBeVisible();
    expect(screen.queryByText("CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED")).not.toBeInTheDocument();

    await act(async () => {
      releaseInitialList([]);
      await Promise.resolve();
    });
    expect(screen.queryByText("CREATIVE_JOURNEY_STORAGE_QUOTA_EXCEEDED")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^一句话灵感/u })).toHaveValue(idea);
  });

  it("discloses the exact opening action and cancellation makes zero provider calls", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "潮汐退去后，海滩上出现了一座写着明日日期的车站。",
    );

    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    const dialog = await screen.findByRole("dialog", { name: "生成首批三个开头" });
    expect(harness.generate).not.toHaveBeenCalled();
    expect(within(dialog).getByText("Ollama")).toBeVisible();
    expect(within(dialog).getByText("local-novel")).toBeVisible();
    expect(within(dialog).getByText("当前已验证的本机模型")).toBeVisible();
    expect(within(dialog).getByText("本动作调用上限").parentElement).toHaveTextContent(
      /最多\s*3\s*次；\s*每个请求最多\s*1\s*次/u,
    );
    expect(within(dialog).getByText("0 次")).toBeVisible();
    expect(within(dialog).getByText("费用暂无法核对（当前连接未提供精确价格）")).toBeVisible();
    expect(within(dialog).getByText("本次开头资料只发送给当前已验证的本机模型。")).toBeVisible();
    expect(within(dialog).getByText(/一句话灵感（/u)).toBeVisible();
    expect(within(dialog).getByText(/3 个独立开头请求及其固定创作角度/u)).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "取消，不调用 AI" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("确认前安全终止")).toHaveLength(3));
    expect(screen.getByText("确认前离开，未确认的生成批次已安全终止")).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();
    const [active] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(active?.snapshot.openingSuggestions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "pending" })]),
    );
  }, 30_000);

  it("creates three isolated provider opening suggestions and lets the author choose one", async () => {
    const harness = createTauriIdeaRuntime(false);
    const enableNovelSkill = vi.spyOn(harness.runtime.novelSkills, "setMethodEnabled");
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    await setSingleConnectionRetryLimit(harness.runtime, 3);
    expect(await screen.findByText(/并行发起 3 次独立模型调用，供应商可能分别计费/u)).toBeVisible();
    expect(screen.getByText(/本操作不自动重试/u)).toBeVisible();
    expect(screen.getByText(/当前模型：Ollama · local-novel/u)).toBeVisible();
    expect(screen.queryByText(/当前模型：019/u)).not.toBeInTheDocument();
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
    await confirmOpeningProviderAction(user, 3);

    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    expect(harness.generate.mock.calls.every((call) => call[0].config.retryLimit === 0)).toBe(true);
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
    await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(3));
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
    expect(firstSelectedId).toBeNull();
    expect(screen.queryByRole("button", { name: "保留开头，确认创建" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).not.toBeInTheDocument();
    const turns = await harness.runtime.creativeJourneys.listTurns(journeyId);
    const generationTurns = turns.filter(({ generationSource }) => generationSource === "provider");
    expect(generationTurns).toHaveLength(3);
    expect(new Set(generationTurns.map(({ requestId }) => requestId)).size).toBe(3);
    expect(generationTurns.every(({ taskKey }) => taskKey === "opening_guidance")).toBe(true);
    await user.click(screen.getByRole("button", { name: "选择方案 2" }));
    expect(
      await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).toBeVisible();
    const afterSelection = await harness.runtime.creativeJourneys.listActive("idea");
    expect(afterSelection[0]?.snapshot.selectedOpeningId).not.toBe(firstSelectedId);
    expect(harness.generate).toHaveBeenCalledTimes(3);

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

  it("uses one confirmed call and keeps the opening isolated until the author decides", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const preference = await harness.runtime.writingExperience.getOrInitialize();
    expect(preference.mode).toBe("direct");
    expect(preference.directLocalOrganizationAuthorizedAt).not.toBeNull();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);

    await startDirectOpeningWithoutConnection(user, "一名修表匠发现整座城市每天都会遗失同一分钟。");
    expect(harness.generate).not.toHaveBeenCalled();
    first.unmount();
    renderJourney(harness.runtime);
    expect(await screen.findByText(/这项写作任务还没有可用的 AI 分工/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "稍后重试" })).toBeEnabled();
    expect(harness.generate).not.toHaveBeenCalled();

    await connectOllamaAfterDirectOpeningFailure(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation(() =>
      Promise.resolve({ text: DIRECT_OPENING_WITH_LOCAL_FACTS, usage: null }),
    );
    await retryDirectOpening(user);

    await waitFor(() => expect(screen.getByRole("button", { name: "查看生成结果" })).toBeEnabled());
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用推荐方案" })).not.toBeInTheDocument();
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/第 1\//u)).not.toBeInTheDocument();
    const projects = await harness.runtime.useCases.listProjects.execute({
      statuses: ["active"],
    });
    if (!projects.ok || projects.value[0] === undefined) {
      throw new Error("直接模式没有预建可恢复的空白作品。");
    }
    const chapters = await harness.runtime.repositories.chapters.listByProjectId(
      projects.value[0].id,
    );
    if (!chapters.ok || chapters.value[0] === undefined) {
      throw new Error("直接模式没有预建可恢复的空白章节。");
    }
    expect(chapters.value[0].content).toBe("");
    const initialVersions = await harness.runtime.repositories.chapterVersions.listByChapterId(
      chapters.value[0].id,
    );
    expect(initialVersions.ok && initialVersions.value).toHaveLength(1);
    const candidatesBeforeViewing = await harness.runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidatesBeforeViewing.ok && candidatesBeforeViewing.value).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "查看生成结果" }));

    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    expect(harness.generate).toHaveBeenCalledTimes(1);
    const stableChapter = await harness.runtime.repositories.chapters.findById(
      chapters.value[0].id,
    );
    expect(stableChapter.ok && stableChapter.value?.content).toBe("");
    const versions = await harness.runtime.repositories.chapterVersions.listByChapterId(
      chapters.value[0].id,
    );
    expect(versions.ok && versions.value).toHaveLength(1);
    const candidates = await harness.runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidates.ok && candidates.value).toHaveLength(1);
    expect(candidates.ok && candidates.value[0]?.content).toBe(DIRECT_OPENING_WITH_LOCAL_FACTS);
    expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    const [activeJourney] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(activeJourney).toMatchObject({
      status: "active",
      currentState: "candidate_ready",
      candidateId: candidates.ok ? candidates.value[0]?.id : undefined,
    });
  }, 30_000);

  it("starts in direct mode without calling a model before the author acts", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const preference = await harness.runtime.writingExperience.getOrInitialize();
    expect(preference.mode).toBe("direct");
    expect(preference.directLocalOrganizationAuthorizedAt).not.toBeNull();
    renderJourney(harness.runtime);

    expect(await screen.findByRole("button", { name: "开始创作" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "一句话" })).toHaveValue("");
    expect(screen.queryByRole("button", { name: "生成第一段" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用推荐方案" })).not.toBeInTheDocument();
    expect(harness.generate).not.toHaveBeenCalled();
    const projects = await harness.runtime.useCases.listProjects.execute({ statuses: ["active"] });
    expect(projects.ok && projects.value).toHaveLength(0);
  });

  it("shows the direct-mode waiting stage, elapsed time, timeout rule, and support id", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const preference = await harness.runtime.writingExperience.getOrInitialize();
    expect(preference.mode).toBe("direct");
    const user = userEvent.setup();
    const view = renderJourney(harness.runtime);
    await startDirectOpeningWithoutConnection(user, "一座旧钟楼会在午夜倒数失踪者的名字。");
    await connectOllamaAfterDirectOpeningFailure(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation(() => new Promise(() => undefined));

    await retryDirectOpening(user);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/创作仍在进行，1 个结果尚未返回/u)).toBeVisible();
    const [active] = await harness.runtime.creativeJourneys.listActive("idea");
    const run = readOpeningJourneyRun(active?.snapshot.openingRun);
    if (run === null) throw new Error("直接模式等待没有保存运行支持编号。");
    const waitingDescription = screen.getByText(/当前阶段：.+；已等待 .+总等待超过 3 分钟/u);
    expect(waitingDescription).toHaveTextContent(`支持编号：${run.supportId}`);
    view.unmount();
  }, 30_000);

  it("shows a support id when creation fails from the saved summary", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一封来自明天的信让邮差改变了今天的路线。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    await user.click(await screen.findByRole("button", { name: "选择方案 1" }));
    for (let index = 0; index < 12 && screen.queryByText("问题计划已完成") === null; index += 1) {
      await user.click(await screen.findByRole("button", { name: "跳过" }));
    }
    expect(await screen.findByText("问题计划已完成")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "直接确认创建" }));
    expect(await screen.findByRole("heading", { name: "都准备好了，看一眼全貌" })).toBeVisible();
    const [reviewJourney] = await harness.runtime.creativeJourneys.listActive("idea");
    if (reviewJourney === undefined) throw new Error("创建前摘要没有保存本地旅程。");
    const run = readOpeningJourneyRun(reviewJourney.snapshot.openingRun);
    if (run === null) throw new Error("供应商开头没有保存支持编号。");
    vi.spyOn(harness.runtime.useCases.renameProject, "execute").mockRejectedValueOnce(
      Object.assign(new Error("private create failure"), {
        code: "IDEA_PROJECT_CREATE_FAILED",
      }),
    );

    await user.click(screen.getByRole("button", { name: "创建作品，查看 AI 建议" }));

    const supportNotice = await screen.findByText(`支持编号：${run.supportId}`);
    expect(supportNotice).toBeVisible();
    expect(screen.queryByText(/private create failure/u)).not.toBeInTheDocument();
  }, 30_000);

  it("reopens the ready isolated result without another call or automatic acceptance", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const preference = await harness.runtime.writingExperience.getOrInitialize();
    await harness.runtime.writingExperience.authorizeDirectMode(preference.revision);
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await startDirectOpeningWithoutConnection(user, "一名修表匠发现整座城市每天都会遗失同一分钟。");
    expect(harness.generate).not.toHaveBeenCalled();
    await connectOllamaAfterDirectOpeningFailure(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation(() =>
      Promise.resolve({ text: DIRECT_OPENING_WITH_LOCAL_FACTS, usage: null }),
    );
    await retryDirectOpening(user);
    await waitFor(() => expect(screen.getByRole("button", { name: "查看生成结果" })).toBeEnabled());
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看生成结果" }));
    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    expect(harness.generate).toHaveBeenCalledTimes(1);
    const [readyJourney] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(readyJourney?.currentState).toBe("candidate_ready");
    first.unmount();

    renderJourney(harness.runtime);
    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    expect(harness.generate).toHaveBeenCalledTimes(1);
    const projects = await harness.runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) throw new Error("恢复后作品不存在。");
    const chapters = await harness.runtime.repositories.chapters.listByProjectId(
      projects.value[0].id,
    );
    expect(chapters.ok && chapters.value[0]?.content).toBe("");
    if (!chapters.ok || chapters.value[0] === undefined) return;
    const versions = await harness.runtime.repositories.chapterVersions.listByChapterId(
      chapters.value[0].id,
    );
    expect(versions.ok && versions.value).toHaveLength(1);
    const candidates = await harness.runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    expect(await harness.runtime.creativeJourneys.listActive("idea")).toHaveLength(1);
  }, 30_000);

  it("keeps questions, recommendations, and professional controls out of direct mode", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const preference = await harness.runtime.writingExperience.getOrInitialize();
    expect(preference.mode).toBe("direct");
    expect(preference.directLocalOrganizationAuthorizedAt).not.toBeNull();
    const user = userEvent.setup();
    renderJourney(harness.runtime);

    expect(await screen.findByRole("button", { name: "开始创作" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "专业设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再补充几个问题" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();

    await startDirectOpeningWithoutConnection(user, "月球邮局收到一封寄给尚未出生之人的信。");
    expect(harness.generate).not.toHaveBeenCalled();
    await connectOllamaAfterDirectOpeningFailure(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation(() =>
      Promise.resolve({ text: DIRECT_OPENING_WITH_LOCAL_FACTS, usage: null }),
    );
    await retryDirectOpening(user);

    await waitFor(() => expect(screen.getByRole("button", { name: "查看生成结果" })).toBeEnabled());
    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "专业设置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "再补充几个问题" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();
    const [active] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(active?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({ status: "ready" }),
    ]);
    expect(active?.snapshot.selectedOpeningId).toBeNull();
  }, 30_000);

  it("settles one partial direct-mode slot without recommending or creating a candidate", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const preference = await harness.runtime.writingExperience.getOrInitialize();
    expect(preference.mode).toBe("direct");
    expect(preference.directLocalOrganizationAuthorizedAt).not.toBeNull();
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await startDirectOpeningWithoutConnection(user, "一艘空渡轮每晚都会准时靠岸。");
    expect(harness.generate).not.toHaveBeenCalled();
    await connectOllamaAfterDirectOpeningFailure(user);
    harness.generate.mockClear();
    const partialText = "雾里的渡轮响了三次汽笛，甲板上却没有乘客。".repeat(9);
    harness.generate.mockImplementation((input) => {
      input.onDelta?.(partialText);
      return Promise.reject(
        Object.assign(new Error("truncated"), { code: "MODEL_OUTPUT_TRUNCATED" }),
      );
    });
    await retryDirectOpening(user);

    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "稍后重试" })).toBeEnabled());
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用推荐方案" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保留为草稿" })).not.toBeInTheDocument();
    const [active] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(active?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({ status: "partial", text: partialText }),
    ]);

    const projects = await harness.runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) {
      throw new Error("直接模式没有预建空白作品。");
    }
    const chapters = await harness.runtime.repositories.chapters.listByProjectId(
      projects.value[0].id,
    );
    if (!chapters.ok || chapters.value[0] === undefined) {
      throw new Error("直接模式没有预建空白章节。");
    }
    expect(chapters.value[0].content).toBe("");
    const candidates = await harness.runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidates.ok && candidates.value).toHaveLength(0);
  }, 30_000);

  it("starts one stable direct request, never recommends it, and enters the chapter explicitly", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const preference = await harness.runtime.writingExperience.getOrInitialize();
    expect(preference.mode).toBe("direct");
    expect(preference.directLocalOrganizationAuthorizedAt).not.toBeNull();
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await startDirectOpeningWithoutConnection(user, "凌晨四点，整条街的门牌号同时少了一位数。");
    expect(harness.generate).not.toHaveBeenCalled();
    await connectOllamaAfterDirectOpeningFailure(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation(() =>
      Promise.resolve({ text: DIRECT_OPENING_WITH_LOCAL_FACTS, usage: null }),
    );
    await retryDirectOpening(user);

    await waitFor(() => expect(screen.getByRole("button", { name: "查看生成结果" })).toBeEnabled());
    expect(harness.generate).toHaveBeenCalledTimes(1);
    const requestIds = harness.generate.mock.calls.map(([input]) => input.generationId);
    expect(requestIds).toHaveLength(1);
    const [beforeRestart] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(beforeRestart?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({
        id: requestIds[0],
        source: "provider",
        status: "ready",
      }),
    ]);
    expect(beforeRestart?.snapshot.selectedOpeningId).toBeNull();
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用推荐方案" })).not.toBeInTheDocument();
    await expect(
      harness.runtime.modelHub.findInvocation(requestIds[0] ?? "missing"),
    ).resolves.toMatchObject({
      status: "succeeded",
      attempt: 1,
    });
    first.unmount();

    renderJourney(harness.runtime);
    await waitFor(() => expect(screen.getByRole("button", { name: "查看生成结果" })).toBeEnabled());
    expect(harness.generate).toHaveBeenCalledTimes(1);
    const [afterRestart] = await harness.runtime.creativeJourneys.listActive("idea");
    const afterRestartSuggestions = afterRestart?.snapshot.openingSuggestions as
      readonly Readonly<{ id: string }>[] | undefined;
    expect(afterRestartSuggestions?.map(({ id }) => id)).toEqual(requestIds);
    expect(screen.queryByText("推荐")).not.toBeInTheDocument();

    const projects = await harness.runtime.useCases.listProjects.execute({ statuses: ["active"] });
    if (!projects.ok || projects.value[0] === undefined) {
      throw new Error("直接模式恢复时没有保留空白作品。");
    }
    const chapters = await harness.runtime.repositories.chapters.listByProjectId(
      projects.value[0].id,
    );
    if (!chapters.ok || chapters.value[0] === undefined) {
      throw new Error("直接模式恢复时没有保留空白章节。");
    }
    expect(chapters.value[0].content).toBe("");
    const candidatesBeforeEntry = await harness.runtime.repositories.aiCandidates.listByChapterId(
      chapters.value[0].id,
    );
    expect(candidatesBeforeEntry.ok && candidatesBeforeEntry.value).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "查看生成结果" }));
    expect(await screen.findByText("已进入 AI 建议版本比较")).toBeVisible();
    expect(harness.generate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("keeps all terminal slots authoritative when the first provider result cannot be persisted", async () => {
    const harness = createTauriIdeaRuntime(false);
    const originalUpdate = harness.runtime.creativeJourneys.update.bind(
      harness.runtime.creativeJourneys,
    );
    let failFirstReadyCheckpoint = true;
    let failedReadyCheckpointCount = 0;
    const creativeJourneys = {
      findById: harness.runtime.creativeJourneys.findById.bind(harness.runtime.creativeJourneys),
      listActive: harness.runtime.creativeJourneys.listActive.bind(
        harness.runtime.creativeJourneys,
      ),
      listTurns: harness.runtime.creativeJourneys.listTurns.bind(harness.runtime.creativeJourneys),
      create: harness.runtime.creativeJourneys.create.bind(harness.runtime.creativeJourneys),
      update: (
        record: CreativeJourneyRecord,
        expectedRevision: number,
        turn?: CreativeJourneyTurnRecord,
      ) => {
        const suggestions = record.snapshot.openingSuggestions;
        if (
          failFirstReadyCheckpoint &&
          Array.isArray(suggestions) &&
          suggestions.some(
            (suggestion: unknown) =>
              typeof suggestion === "object" &&
              suggestion !== null &&
              (suggestion as Readonly<Record<string, unknown>>).status === "ready",
          )
        ) {
          failFirstReadyCheckpoint = false;
          failedReadyCheckpointCount += 1;
          return Promise.reject(new Error("simulated isolated slot persistence failure"));
        }
        return originalUpdate(record, expectedRevision, turn);
      },
    };
    const runtime: DesktopRuntime = Object.freeze({ ...harness.runtime, creativeJourneys });
    const resolvers = new Map<string, (value: { text: string; usage: null }) => void>();
    const user = userEvent.setup();
    const first = renderJourney(runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          resolvers.set(input.generationId, resolve);
        }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "三条河流在同一夜改道，分别通向三座失踪的城。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    const requestIds = harness.generate.mock.calls.map(([input]) => input.generationId);
    expect(new Set(requestIds).size).toBe(3);
    const planned = (await runtime.creativeJourneys.listActive("idea"))[0];
    const plannedSuggestions = planned?.snapshot.openingSuggestions as
      readonly Readonly<{ id: string; slotNumber: number }>[] | undefined;
    const slotRequestIds = [...(plannedSuggestions ?? [])]
      .sort((left, right) => left.slotNumber - right.slotNumber)
      .map(({ id }) => id);
    expect(new Set(slotRequestIds)).toEqual(new Set(requestIds));

    const firstResolver = resolvers.get(slotRequestIds[0] ?? "missing");
    const secondResolver = resolvers.get(slotRequestIds[1] ?? "missing");
    const thirdResolver = resolvers.get(slotRequestIds[2] ?? "missing");
    if (
      firstResolver === undefined ||
      secondResolver === undefined ||
      thirdResolver === undefined
    ) {
      throw new Error("三方案没有保留独立的返回入口。");
    }
    await act(async () => {
      firstResolver({ text: "第一槽真实返回但首次本地保存失败。", usage: null });
      await Promise.resolve();
    });
    await waitFor(() => expect(failedReadyCheckpointCount).toBe(1));
    await act(async () => {
      secondResolver({ text: "第二槽在第一槽本地失败后仍然成功。", usage: null });
      await Promise.resolve();
    });
    await act(async () => {
      thirdResolver({ text: "第三槽也在同一批次独立完成。", usage: null });
      await Promise.resolve();
    });
    expect(await screen.findByText("第二槽在第一槽本地失败后仍然成功。")).toBeVisible();
    expect(await screen.findByText("第三槽也在同一批次独立完成。")).toBeVisible();
    await waitFor(() => expect(screen.getByText("结果待核对")).toBeVisible());
    expect(screen.getAllByText("已完成")).toHaveLength(2);
    expect(harness.generate).toHaveBeenCalledTimes(3);
    const beforeRestart = (await runtime.creativeJourneys.listActive("idea"))[0];
    expect(beforeRestart?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({
        id: slotRequestIds[0],
        status: "failed",
        dispatchState: "ambiguous",
        noticeCode: "OPENING_RESULT_NOT_PERSISTED",
      }),
      expect.objectContaining({
        id: slotRequestIds[1],
        status: "ready",
        dispatchState: "succeeded",
      }),
      expect.objectContaining({
        id: slotRequestIds[2],
        status: "ready",
        dispatchState: "succeeded",
      }),
    ]);

    first.unmount();
    renderJourney(runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await waitFor(() => expect(screen.getByText("结果待核对")).toBeVisible());
    expect(screen.getAllByText("已完成")).toHaveLength(2);
    expect(screen.queryByText("明确失败")).not.toBeInTheDocument();
    expect(screen.getByText("第二槽在第一槽本地失败后仍然成功。")).toBeVisible();
    expect(screen.getByText("第三槽也在同一批次独立完成。")).toBeVisible();
    expect(harness.generate).toHaveBeenCalledTimes(3);
    await expect(
      runtime.modelHub.findInvocation(slotRequestIds[0] ?? "missing"),
    ).resolves.toMatchObject({ status: "succeeded", attempt: 1 });
    await expect(
      runtime.modelHub.findInvocation(slotRequestIds[1] ?? "missing"),
    ).resolves.toMatchObject({ status: "succeeded", attempt: 1 });
    await expect(
      runtime.modelHub.findInvocation(slotRequestIds[2] ?? "missing"),
    ).resolves.toMatchObject({ status: "succeeded", attempt: 1 });
  }, 30_000);

  it("keeps a running opening whose success ledger settlement failed pending without redispatch", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    const originalFinishInvocation = harness.runtime.modelHub.finishInvocation.bind(
      harness.runtime.modelHub,
    );
    let rejectFirstSuccessSettlement = true;
    const finishInvocation = vi
      .spyOn(harness.runtime.modelHub, "finishInvocation")
      .mockImplementation((input) => {
        if (rejectFirstSuccessSettlement && input.status === "succeeded") {
          rejectFirstSuccessSettlement = false;
          return Promise.reject(new Error("simulated opening success settlement failure"));
        }
        return originalFinishInvocation(input);
      });
    harness.generate.mockImplementation((input) =>
      Promise.resolve({ text: `已返回开头 ${input.generationId}`, usage: null }),
    );
    const listActive = harness.runtime.creativeJourneys.listActive.bind(
      harness.runtime.creativeJourneys,
    );
    const pageRefresh = vi
      .spyOn(harness.runtime.creativeJourneys, "listActive")
      .mockImplementation(() => new Promise(() => undefined));

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "三封寄往未来的信在同一天退回。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    let unresolvedId = "";
    await waitFor(async () => {
      const [stored] = await listActive("idea");
      const suggestions = stored?.snapshot.openingSuggestions as
        | readonly Readonly<{
            providerInvocationId: string | null;
            status: string;
            dispatchState: string;
          }>[]
        | undefined;
      const unresolved = suggestions?.find(
        ({ status, dispatchState }) => status === "failed" && dispatchState === "dispatched",
      );
      expect(unresolved?.providerInvocationId).toBeTruthy();
      unresolvedId = unresolved?.providerInvocationId ?? "";
    });
    expect(unresolvedId).not.toBe("");
    const unresolvedInvocation = await harness.runtime.modelHub.findInvocation(unresolvedId);
    expect(unresolvedInvocation).toMatchObject({
      status: "running",
    });
    expect(typeof unresolvedInvocation?.providerDispatchStartedAt).toBe("string");
    expect(
      finishInvocation.mock.calls.filter(
        ([input]) => input.id === unresolvedId && input.status === "succeeded",
      ),
    ).toHaveLength(1);
    first.unmount();
    pageRefresh.mockRestore();

    await expect(recoverOrphanedOpeningInvocationsAtStartup(harness.runtime)).resolves.toEqual({
      inspectedJourneyCount: 1,
      inspectedInvocationCount: 1,
      terminalizedInvocationCount: 0,
      failedInvocationCount: 0,
    });
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await waitFor(() => expect(screen.getByText("这次 AI 修改仍在等待结果")).toBeVisible());
    expect(screen.getAllByText("已完成")).toHaveLength(2);
    expect(harness.generate).toHaveBeenCalledTimes(3);
    await expect(harness.runtime.modelHub.findInvocation(unresolvedId)).resolves.toMatchObject({
      status: "running",
      errorCode: null,
    });
    const [recovered] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(recovered?.snapshot.openingSuggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerInvocationId: unresolvedId,
          status: "failed",
          dispatchState: "dispatched",
        }),
      ]),
    );
  }, 30_000);

  it("settles synchronous per-slot failures and requires explicit selection of the one usable result", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    let callIndex = 0;
    harness.generate.mockImplementation((input) => {
      callIndex += 1;
      if (callIndex === 1) {
        return Promise.resolve({ text: `唯一可用方案 ${input.generationId}`, usage: null });
      }
      throw Object.assign(new Error("synchronous provider failure"), {
        code: "MODEL_PROVIDER_UNAVAILABLE",
        diagnostics: Object.freeze({ httpStatus: 503 }),
      });
    });

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "旧电影院只会为失踪的人放映下一场电影。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await confirmOpeningProviderAction(user, 3);

    await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText("明确失败")).toHaveLength(2));
    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    if (settled === undefined) throw new Error("部分成功批次没有保存。");
    const settledSuggestions = settled.snapshot.openingSuggestions as readonly Readonly<{
      id: string;
      status: string;
    }>[];
    expect(settledSuggestions.filter(({ status }) => status === "ready")).toHaveLength(1);
    expect(settledSuggestions.filter(({ status }) => status === "failed")).toHaveLength(2);
    expect(settled.snapshot.openingSuggestions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "pending" })]),
    );
    expect(settled.snapshot.selectedOpeningId).toBeNull();
    expect(settled.snapshot.questionPlanner).toBeNull();
    expect(screen.queryByRole("button", { name: "保留开头，确认创建" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      const diagnostic = readSafeGuidedOpeningStatus(harness.runtime);
      expect(diagnostic).toMatchObject({
        inputValidation: "valid",
        batchState: "settled",
        selectedSlot: null,
        plannerMode: "not_started",
        questionCount: 0,
        currentQuestion: null,
        lastError: "MODEL_PROVIDER_UNAVAILABLE",
      });
      expect(diagnostic?.slotStates.filter((status) => status === "ready")).toHaveLength(1);
      expect(diagnostic?.slotStates.filter((status) => status === "failed")).toHaveLength(2);
    });

    const readyIndex = settledSuggestions.findIndex(({ status }) => status === "ready");
    expect(readyIndex).toBeGreaterThanOrEqual(0);
    await user.click(screen.getByRole("button", { name: `选择方案 ${String(readyIndex + 1)}` }));
    expect(
      await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).toBeVisible();
    const [selected] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(selected?.snapshot.selectedOpeningId).toBe(settledSuggestions[readyIndex]?.id);
    await waitFor(() => {
      expect(readSafeGuidedOpeningStatus(harness.runtime)).toMatchObject({
        batchState: "settled",
        selectedSlot: `slot_${String(readyIndex + 1)}`,
        plannerMode: "deterministic_fallback",
        questionCount: 3,
        currentQuestion: "opening_direction",
      });
    });
  }, 30_000);

  it("settles a batch when every provider slot throws without inventing a choice or question", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    harness.generate.mockImplementation(() => {
      throw Object.assign(new Error("synchronous provider failure"), {
        code: "MODEL_PROVIDER_UNAVAILABLE",
        diagnostics: Object.freeze({ httpStatus: 503 }),
      });
    });

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "暴雨夜，整座城市的钟都停在同一秒。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await confirmOpeningProviderAction(user, 3);

    await waitFor(() => expect(screen.getAllByText("明确失败")).toHaveLength(3));
    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    if (settled === undefined) throw new Error("全失败批次没有保存终态。");
    const suggestions = settled.snapshot.openingSuggestions as readonly Readonly<{
      status: string;
    }>[];
    expect(suggestions.map(({ status }) => status)).toEqual(["failed", "failed", "failed"]);
    expect(settled.currentState).not.toBe("generation_pending");
    expect(settled.snapshot.selectedOpeningId).toBeNull();
    expect(settled.snapshot.questionPlanner).toBeNull();
    expect(screen.queryByRole("button", { name: /^选择方案/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保留开头，确认创建" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(readSafeGuidedOpeningStatus(harness.runtime)).toMatchObject({
        batchState: "settled",
        slotStates: ["failed", "failed", "failed"],
        selectedSlot: null,
        plannerMode: "not_started",
        questionCount: 0,
        currentQuestion: null,
        lastError: "MODEL_PROVIDER_UNAVAILABLE",
      });
    });
  }, 30_000);

  it("settles all three planned slots as not sent when disclosure preparation fails", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    const preparationFailure = vi
      .spyOn(harness.runtime.modelHub, "findTaskRoute")
      .mockRejectedValueOnce(
        Object.assign(new Error("raw provider preparation detail"), {
          code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
        }),
      );

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "三张空白车票分别印着昨天、今天和明天。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));

    await waitFor(() => expect(screen.getAllByText("未发送")).toHaveLength(3), ASYNC_UI_TIMEOUT);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("raw provider preparation detail")).not.toBeInTheDocument();
    expect(harness.generate).not.toHaveBeenCalled();
    expect(preparationFailure).toHaveBeenCalledOnce();
    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(settled?.currentState).not.toBe("generation_pending");
    expect(settled?.snapshot.pendingRequestId).toBeNull();
    expect(settled?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({
        status: "failed",
        dispatchState: "not_dispatched",
      }),
      expect.objectContaining({
        status: "failed",
        dispatchState: "not_dispatched",
      }),
      expect.objectContaining({
        status: "failed",
        dispatchState: "not_dispatched",
      }),
    ]);
    const suggestions = settled?.snapshot.openingSuggestions as
      readonly Readonly<{ id: string; providerInvocationId: string | null }>[] | undefined;
    for (const suggestion of suggestions ?? []) {
      expect(suggestion.providerInvocationId).toBe(suggestion.id);
      await expect(harness.runtime.modelHub.findInvocation(suggestion.id)).resolves.toBeNull();
    }
  }, 30_000);

  it("settles a direct-mode retry as not sent when disclosure preparation fails", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await startDirectOpeningWithoutConnection(user, "一扇只在凌晨出现的门通往空无一人的车站。");
    await connectOllamaAfterDirectOpeningFailure(user);
    harness.generate.mockClear();
    vi.spyOn(harness.runtime.modelHub, "findTaskRoute").mockRejectedValueOnce(
      Object.assign(new Error("raw direct preparation detail"), {
        code: "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      }),
    );

    await user.click(screen.getByRole("button", { name: "稍后重试" }));
    await waitFor(async () => {
      const [latest] = await harness.runtime.creativeJourneys.listActive("idea");
      expect(latest?.snapshot.pendingRequestId).toBeNull();
    }, ASYNC_UI_TIMEOUT);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("raw direct preparation detail")).not.toBeInTheDocument();
    expect(harness.generate).not.toHaveBeenCalled();
    const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(settled?.currentState).not.toBe("generation_pending");
    expect(settled?.snapshot.pendingRequestId).toBeNull();
    expect(settled?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({
        status: "failed",
        dispatchState: "not_dispatched",
      }),
    ]);
    const suggestions = settled?.snapshot.openingSuggestions as
      readonly Readonly<{ id: string; providerInvocationId: string | null }>[] | undefined;
    const [suggestion] = suggestions ?? [];
    if (suggestion === undefined) throw new Error("直接模式没有保存失败位置。");
    expect(suggestion.providerInvocationId).toBe(suggestion.id);
    await expect(harness.runtime.modelHub.findInvocation(suggestion.id)).resolves.toBeNull();
  }, 30_000);

  it("terminalizes only the exact dispatched batch after 180 seconds without retrying", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    await setSingleConnectionRetryLimit(harness.runtime, 3);
    harness.generate.mockClear();
    harness.cancelGeneration.mockClear();
    harness.generate.mockImplementation(() => new Promise<never>(() => undefined));

    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "三名守夜人同时听见一座不存在的钟楼报时。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    const dialog = await screen.findByRole("dialog");
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const slotTimeoutCallbacks: (() => void)[] = [];
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      if (
        timeout === CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS &&
        typeof handler === "function"
      ) {
        slotTimeoutCallbacks.push(handler as () => void);
        return realSetTimeout(() => undefined, timeout);
      }
      return realSetTimeout(handler, timeout);
    }) as typeof globalThis.setTimeout);

    try {
      await user.click(within(dialog).getByRole("button", { name: "确认并发起最多 3 次调用" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
      expect(slotTimeoutCallbacks).toHaveLength(3);
      expect(
        harness.generate.mock.calls.every(([request]) => request.config.retryLimit === 0),
      ).toBe(true);

      const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
      const pendingSuggestions = pending?.snapshot.openingSuggestions as
        readonly Readonly<{ id: string; status: string }>[] | undefined;
      const requestIds = pendingSuggestions?.map(({ id }) => id) ?? [];
      expect(requestIds).toHaveLength(3);
      expect(pending?.currentState).toBe("generation_pending");
      expect(pendingSuggestions?.map(({ status }) => status)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      for (const requestId of requestIds) {
        const invocation = await harness.runtime.modelHub.findInvocation(requestId);
        expect(invocation).toMatchObject({
          id: requestId,
          task: "book_start_guidance",
          status: "running",
        });
        expect(typeof invocation?.providerDispatchStartedAt).toBe("string");
      }

      await act(async () => {
        for (const timeout of slotTimeoutCallbacks) timeout();
        await Promise.resolve();
      });

      await waitFor(async () => {
        const [settled] = await harness.runtime.creativeJourneys.listActive("idea");
        expect(settled?.currentState).not.toBe("generation_pending");
        expect(settled?.snapshot.pendingRequestId).toBeNull();
        const suggestions = settled?.snapshot.openingSuggestions as
          | readonly Readonly<{
              id: string;
              status: string;
              dispatchState: string;
              noticeCode: string | null;
            }>[]
          | undefined;
        expect(
          suggestions?.map(({ id, status, dispatchState, noticeCode }) => ({
            id,
            status,
            dispatchState,
            noticeCode,
          })),
        ).toEqual(
          requestIds.map((id) => ({
            id,
            status: "failed",
            dispatchState: "ambiguous",
            noticeCode: "MODEL_TIMEOUT",
          })),
        );
      }, ASYNC_UI_TIMEOUT);
      expect(
        await screen.findByText(
          "模型在 180 秒内没有返回，本次操作已停止且不会自动重试。正文和已有建议没有改变，可稍后明确重试。",
          undefined,
          ASYNC_UI_TIMEOUT,
        ),
      ).toBeVisible();
      await waitFor(() => expect(harness.cancelGeneration).toHaveBeenCalledTimes(3));
      for (const requestId of requestIds) {
        expect(harness.cancelGeneration).toHaveBeenCalledWith(requestId);
      }
      expect(harness.generate).toHaveBeenCalledTimes(3);
      for (const requestId of requestIds) {
        await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
          status: "timed_out",
          errorCode: "MODEL_TIMEOUT",
        });
      }
    } finally {
      timeoutSpy.mockRestore();
    }
  }, 30_000);

  it.each([
    { label: "先提交结果再跨过超时", commitBeforeTimeout: true },
    { label: "先超时收口再尝试提交结果", commitBeforeTimeout: false },
  ] as const)(
    "keeps a provider result unusable when $label",
    async ({ commitBeforeTimeout }) => {
      window.localStorage.clear();
      const harness = createTauriIdeaRuntime(false);
      const user = userEvent.setup();
      renderJourney(harness.runtime);
      await startDirectOpeningWithoutConnection(user, "一间旧照相馆会在底片上留下尚未发生的告别。");
      await connectOllamaAfterDirectOpeningFailure(user);
      harness.generate.mockClear();
      harness.cancelGeneration.mockClear();
      harness.generate.mockResolvedValue({
        text: "雨水沿着暗房门缝漫进来时，底片上的人影刚刚转过身。",
        usage: null,
      });

      const originalUpdate = harness.runtime.creativeJourneys.update.bind(
        harness.runtime.creativeJourneys,
      );
      let staleReadyWrite: Readonly<{
        record: CreativeJourneyRecord;
        expectedRevision: number;
      }> | null = null;
      let interceptedReadySave = false;
      const updateSpy = vi
        .spyOn(harness.runtime.creativeJourneys, "update")
        .mockImplementation(async (record, expectedRevision, turn) => {
          const suggestions = record.snapshot.openingSuggestions as
            readonly Readonly<{ id: string; status: string }>[] | undefined;
          const savedSuggestion = suggestions?.find(
            ({ status }) => status === "ready" || status === "partial",
          );
          if (savedSuggestion === undefined || interceptedReadySave) {
            return originalUpdate(record, expectedRevision, turn);
          }
          interceptedReadySave = true;
          staleReadyWrite = Object.freeze({ record, expectedRevision });
          if (commitBeforeTimeout) {
            await originalUpdate(record, expectedRevision, turn);
          }
          throw Object.assign(new Error("simulated result persistence timeout"), {
            code: "MODEL_TIMEOUT",
            timedOutRequestIds: Object.freeze([savedSuggestion.id]),
          });
        });

      await user.click(screen.getByRole("button", { name: "稍后重试" }));
      const dialog = await screen.findByRole("dialog", undefined, ASYNC_UI_TIMEOUT);
      try {
        await user.click(within(dialog).getByRole("button", { name: "确认并发起最多 1 次调用" }));
        await waitFor(() => expect(harness.generate).toHaveBeenCalledOnce(), ASYNC_UI_TIMEOUT);
        const requestId = harness.generate.mock.calls[0]?.[0].generationId;
        if (requestId === undefined) throw new Error("竞态测试没有取得单槽请求编号。");

        await waitFor(async () => {
          const [latest] = await harness.runtime.creativeJourneys.listActive("idea");
          const current = latest?.snapshot.openingSuggestions as
            | readonly Readonly<{
                id: string;
                status: string;
                text: string;
                noticeCode: string | null;
              }>[]
            | undefined;
          expect(current?.find(({ id }) => id === requestId)).toMatchObject({
            status: "failed",
            text: "",
            noticeCode: "MODEL_TIMEOUT",
          });
        }, ASYNC_UI_TIMEOUT);
        const staleWrite = staleReadyWrite as Readonly<{
          record: CreativeJourneyRecord;
          expectedRevision: number;
        }> | null;
        if (staleWrite === null) throw new Error("竞态测试没有截获准备写入的供应商结果。");
        if (!commitBeforeTimeout) {
          await expect(
            originalUpdate(staleWrite.record, staleWrite.expectedRevision),
          ).rejects.toMatchObject({
            code: "CREATIVE_JOURNEY_REVISION_CONFLICT",
          });
        }
        await waitFor(async () => {
          const [latest] = await harness.runtime.creativeJourneys.listActive("idea");
          const current = latest?.snapshot.openingSuggestions as
            readonly Readonly<{ id: string; status: string; text: string }>[] | undefined;
          const history = latest?.snapshot.openingResultHistory as
            readonly Readonly<{ id: string; status: string; text: string }>[] | undefined;
          expect(
            [...(current ?? []), ...(history ?? [])].filter(
              ({ id, status, text }) =>
                id === requestId &&
                (status === "ready" || status === "partial" || text.trim().length > 0),
            ),
          ).toHaveLength(0);
          expect(latest?.snapshot).toMatchObject({
            preview: "",
            previewSource: null,
            providerId: null,
            modelId: null,
            selectedOpeningId: null,
            pendingRequestId: null,
          });
        }, ASYNC_UI_TIMEOUT);
        expect(harness.cancelGeneration).not.toHaveBeenCalled();
        await expect(harness.runtime.modelHub.findInvocation(requestId)).resolves.toMatchObject({
          status: "succeeded",
        });
      } finally {
        updateSpy.mockRestore();
      }
    },
    30_000,
  );

  it("does not enter timeout recovery when a slot carries a different timeout request id", async () => {
    window.localStorage.clear();
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await startDirectOpeningWithoutConnection(user, "一间旧档案室会把每次失踪改写成另一人的回忆。");
    await connectOllamaAfterDirectOpeningFailure(user);
    harness.generate.mockClear();
    harness.cancelGeneration.mockClear();
    harness.generate.mockResolvedValue({
      text: "档案柜自行滑开时，最上层那份失踪记录写着他的名字。",
      usage: null,
    });

    const foreignRequestId = harness.runtime.ids.next();
    const originalUpdate = harness.runtime.creativeJourneys.update.bind(
      harness.runtime.creativeJourneys,
    );
    const evidence: {
      baselineJourney: CreativeJourneyRecord | null;
      baselineTurns: readonly CreativeJourneyTurnRecord[] | null;
      finishCallCount: number;
      carrierRejected: boolean;
      postScopeUpdateCount: number;
    } = {
      baselineJourney: null,
      baselineTurns: null,
      finishCallCount: 0,
      carrierRejected: false,
      postScopeUpdateCount: 0,
    };
    const finishInvocationSpy = vi.spyOn(harness.runtime.modelHub, "finishInvocation");
    const updateSpy = vi
      .spyOn(harness.runtime.creativeJourneys, "update")
      .mockImplementation(async (record, expectedRevision, turn) => {
        if (evidence.carrierRejected) {
          evidence.postScopeUpdateCount += 1;
          return originalUpdate(record, expectedRevision, turn);
        }
        const suggestions = record.snapshot.openingSuggestions as
          readonly Readonly<{ id: string; status: string }>[] | undefined;
        const newlyUsable = suggestions?.find(
          ({ status }) => status === "ready" || status === "partial",
        );
        if (newlyUsable === undefined) {
          return originalUpdate(record, expectedRevision, turn);
        }
        evidence.baselineJourney = await harness.runtime.creativeJourneys.findById(record.id);
        evidence.baselineTurns = await harness.runtime.creativeJourneys.listTurns(record.id);
        evidence.finishCallCount = finishInvocationSpy.mock.calls.length;
        evidence.carrierRejected = true;
        throw Object.assign(new Error("simulated cross-bound timeout carrier"), {
          code: "MODEL_TIMEOUT",
          timedOutRequestIds: Object.freeze([foreignRequestId]),
        });
      });

    try {
      await retryDirectOpening(user);
      await waitFor(() => {
        expect(evidence.carrierRejected).toBe(true);
        expect(screen.getByRole("button", { name: "结束未完成请求" })).toBeEnabled();
      }, ASYNC_UI_TIMEOUT);
      expect(evidence.postScopeUpdateCount).toBe(0);
      expect(harness.cancelGeneration).not.toHaveBeenCalled();
      expect(finishInvocationSpy.mock.calls).toHaveLength(evidence.finishCallCount);
      if (evidence.baselineJourney === null || evidence.baselineTurns === null) {
        throw new Error("范围错误测试没有保存副作用基线。");
      }
      await expect(
        harness.runtime.creativeJourneys.findById(evidence.baselineJourney.id),
      ).resolves.toEqual(evidence.baselineJourney);
      await expect(
        harness.runtime.creativeJourneys.listTurns(evidence.baselineJourney.id),
      ).resolves.toEqual(evidence.baselineTurns);
    } finally {
      updateSpy.mockRestore();
      finishInvocationSpy.mockRestore();
    }
  }, 30_000);

  it("preserves one settled slot and cancels only the dispatched running timeout when the other timeout has no invocation", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    harness.cancelGeneration.mockClear();
    harness.generate.mockImplementation((input) =>
      Promise.resolve({ text: `保留的供应商结果 ${input.generationId}`, usage: null }),
    );

    const originalUpdate = harness.runtime.creativeJourneys.update.bind(
      harness.runtime.creativeJourneys,
    );
    const originalFindJourney = harness.runtime.creativeJourneys.findById.bind(
      harness.runtime.creativeJourneys,
    );
    const timedOutIds = new Set<string>();
    const runningRequestIds = new Set<string>();
    const missingRequestIds = new Set<string>();
    const updateSpy = vi
      .spyOn(harness.runtime.creativeJourneys, "update")
      .mockImplementation(async (record, expectedRevision, turn) => {
        const before = await originalFindJourney(record.id);
        const beforeSuggestions = before?.snapshot.openingSuggestions as
          readonly Readonly<{ id: string; status: string }>[] | undefined;
        const nextSuggestions = record.snapshot.openingSuggestions as
          readonly Readonly<{ id: string; slotNumber: number; status: string }>[] | undefined;
        const newlyUsable = nextSuggestions?.find((suggestion) => {
          const previous = beforeSuggestions?.find(({ id }) => id === suggestion.id);
          return (
            (suggestion.status === "ready" || suggestion.status === "partial") &&
            previous?.status !== "ready" &&
            previous?.status !== "partial"
          );
        });
        if (newlyUsable === undefined || newlyUsable.slotNumber === 1) {
          return originalUpdate(record, expectedRevision, turn);
        }
        timedOutIds.add(newlyUsable.id);
        if (newlyUsable.slotNumber === 2) {
          runningRequestIds.add(newlyUsable.id);
        } else {
          missingRequestIds.add(newlyUsable.id);
        }
        throw Object.assign(new Error("simulated per-slot persistence timeout"), {
          code: "MODEL_TIMEOUT",
          timedOutRequestIds: Object.freeze([newlyUsable.id]),
        });
      });

    const originalFindInvocation = harness.runtime.modelHub.findInvocation.bind(
      harness.runtime.modelHub,
    );
    let runningWasFinished = false;
    const findInvocationSpy = vi
      .spyOn(harness.runtime.modelHub, "findInvocation")
      .mockImplementation(async (requestId) => {
        const fact = await originalFindInvocation(requestId);
        if (missingRequestIds.has(requestId)) {
          return null;
        }
        if (!runningRequestIds.has(requestId) || fact === null) {
          return fact;
        }
        return Object.freeze({
          ...fact,
          status: runningWasFinished ? ("timed_out" as const) : ("running" as const),
          inputTokens: runningWasFinished ? fact.inputTokens : null,
          outputTokens: runningWasFinished ? fact.outputTokens : null,
          cachedInputTokens: runningWasFinished ? fact.cachedInputTokens : null,
          estimatedCostMicros: runningWasFinished ? fact.estimatedCostMicros : null,
          errorCode: runningWasFinished ? "MODEL_TIMEOUT" : null,
          errorSummary: runningWasFinished ? "simulated exact timeout terminal" : null,
          completion: null,
          completedAt: runningWasFinished ? harness.runtime.clock.now() : null,
          revision: runningWasFinished ? fact.revision + 1 : fact.revision,
        });
      });
    const originalFinishInvocation = harness.runtime.modelHub.finishInvocation.bind(
      harness.runtime.modelHub,
    );
    const finishInvocationSpy = vi
      .spyOn(harness.runtime.modelHub, "finishInvocation")
      .mockImplementation(async (input) => {
        if (!runningRequestIds.has(input.id)) {
          return originalFinishInvocation(input);
        }
        const fact = await originalFindInvocation(input.id);
        if (fact === null) throw new Error("运行中超时位置缺少调用事实。");
        runningWasFinished = true;
        return Object.freeze({
          ...fact,
          status: "timed_out" as const,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          estimatedCostMicros: null,
          errorCode: "MODEL_TIMEOUT",
          errorSummary: "simulated exact timeout terminal",
          completion: null,
          completedAt: harness.runtime.clock.now(),
          revision: fact.revision + 1,
        });
      });

    try {
      await user.type(
        screen.getByRole("textbox", { name: "一句话灵感" }),
        "三封信在同一场暴雨里抵达，却只有一封写着真实的明天。",
      );
      await user.click(screen.getByRole("button", { name: "生成第一段" }));
      await confirmOpeningProviderAction(user, 3);
      await waitFor(() => expect(timedOutIds.size).toBe(2), ASYNC_UI_TIMEOUT);
      await waitFor(
        () => expect(harness.cancelGeneration).toHaveBeenCalledOnce(),
        ASYNC_UI_TIMEOUT,
      );
      const runningRequestId = [...runningRequestIds][0];
      const missingRequestId = [...missingRequestIds][0];
      if (runningRequestId === undefined || missingRequestId === undefined) {
        throw new Error("混合超时测试没有取得两个精确超时编号。");
      }
      expect(harness.cancelGeneration).toHaveBeenCalledWith(runningRequestId);
      expect(harness.cancelGeneration).not.toHaveBeenCalledWith(missingRequestId);
      expect(
        finishInvocationSpy.mock.calls.filter(
          ([input]) => input.status === "timed_out" && input.id === runningRequestId,
        ),
      ).toHaveLength(1);

      const [latest] = await harness.runtime.creativeJourneys.listActive("idea");
      const suggestions = latest?.snapshot.openingSuggestions as
        | readonly Readonly<{
            id: string;
            slotNumber: number;
            status: string;
            text: string;
            noticeCode: string | null;
          }>[]
        | undefined;
      expect(suggestions?.find(({ slotNumber }) => slotNumber === 1)).toMatchObject({
        status: "ready",
        noticeCode: null,
      });
      expect(suggestions?.find(({ slotNumber }) => slotNumber === 1)?.text).not.toBe("");
      for (const requestId of timedOutIds) {
        expect(suggestions?.find(({ id }) => id === requestId)).toMatchObject({
          status: "failed",
          text: "",
          noticeCode: "MODEL_TIMEOUT",
        });
      }
    } finally {
      finishInvocationSpy.mockRestore();
      findInvocationSpy.mockRestore();
      updateSpy.mockRestore();
    }
  }, 30_000);

  it.each(["terminal_fact_reread_is_running", "journey_timeout_update_fails"] as const)(
    "does not cancel after timeout recovery when %s",
    async (failurePoint) => {
      window.localStorage.clear();
      const harness = createTauriIdeaRuntime(false);
      const user = userEvent.setup();
      renderJourney(harness.runtime);
      await startDirectOpeningWithoutConnection(user, "一座废弃钟楼会在暴雨里倒数尚未发生的失踪。");
      await connectOllamaAfterDirectOpeningFailure(user);
      harness.generate.mockClear();
      harness.cancelGeneration.mockClear();
      harness.generate.mockResolvedValue({
        text: "第一声钟响落下时，街口所有影子同时转向了北方。",
        usage: null,
      });

      const originalUpdate = harness.runtime.creativeJourneys.update.bind(
        harness.runtime.creativeJourneys,
      );
      const timedOutRequestIds = new Set<string>();
      let recoveryUpdateAttempts = 0;
      const updateSpy = vi
        .spyOn(harness.runtime.creativeJourneys, "update")
        .mockImplementation(async (record, expectedRevision, turn) => {
          const suggestions = record.snapshot.openingSuggestions as
            | readonly Readonly<{
                id: string;
                status: string;
                noticeCode: string | null;
              }>[]
            | undefined;
          const newlyReady = suggestions?.find(
            ({ status }) => status === "ready" || status === "partial",
          );
          if (timedOutRequestIds.size === 0 && newlyReady !== undefined) {
            timedOutRequestIds.add(newlyReady.id);
            throw Object.assign(new Error("simulated result persistence timeout"), {
              code: "MODEL_TIMEOUT",
              timedOutRequestIds: Object.freeze([newlyReady.id]),
            });
          }
          const timedOutSuggestion = suggestions?.find(
            ({ id, status, noticeCode }) =>
              timedOutRequestIds.has(id) && status === "failed" && noticeCode === "MODEL_TIMEOUT",
          );
          if (timedOutSuggestion !== undefined) {
            recoveryUpdateAttempts += 1;
            if (failurePoint === "journey_timeout_update_fails") {
              throw Object.assign(new Error("simulated timeout journey update failure"), {
                code: "CREATIVE_JOURNEY_WRITE_FAILED",
              });
            }
          }
          return originalUpdate(record, expectedRevision, turn);
        });

      const originalFindInvocation = harness.runtime.modelHub.findInvocation.bind(
        harness.runtime.modelHub,
      );
      let recoveryFinishReturned = false;
      let postFinishReadCount = 0;
      const findInvocationSpy = vi
        .spyOn(harness.runtime.modelHub, "findInvocation")
        .mockImplementation(async (requestId) => {
          const fact = await originalFindInvocation(requestId);
          if (!timedOutRequestIds.has(requestId) || fact === null) {
            return fact;
          }
          if (recoveryFinishReturned) postFinishReadCount += 1;
          const remainsRunning =
            !recoveryFinishReturned || failurePoint === "terminal_fact_reread_is_running";
          return Object.freeze({
            ...fact,
            status: remainsRunning ? ("running" as const) : ("timed_out" as const),
            inputTokens: remainsRunning ? null : fact.inputTokens,
            outputTokens: remainsRunning ? null : fact.outputTokens,
            cachedInputTokens: remainsRunning ? null : fact.cachedInputTokens,
            estimatedCostMicros: remainsRunning ? null : fact.estimatedCostMicros,
            errorCode: remainsRunning ? null : "MODEL_TIMEOUT",
            errorSummary: remainsRunning ? null : "simulated exact timeout terminal",
            completion: null,
            completedAt: remainsRunning ? null : harness.runtime.clock.now(),
            revision: remainsRunning ? fact.revision : fact.revision + 1,
          });
        });
      const originalFinishInvocation = harness.runtime.modelHub.finishInvocation.bind(
        harness.runtime.modelHub,
      );
      const finishInvocationSpy = vi
        .spyOn(harness.runtime.modelHub, "finishInvocation")
        .mockImplementation(async (input) => {
          if (!timedOutRequestIds.has(input.id)) {
            return originalFinishInvocation(input);
          }
          const fact = await originalFindInvocation(input.id);
          if (fact === null) throw new Error("超时重核测试缺少调用事实。");
          recoveryFinishReturned = true;
          return Object.freeze({
            ...fact,
            status: "timed_out" as const,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            estimatedCostMicros: null,
            errorCode: "MODEL_TIMEOUT",
            errorSummary: "simulated exact timeout terminal",
            completion: null,
            completedAt: harness.runtime.clock.now(),
            revision: fact.revision + 1,
          });
        });

      try {
        await retryDirectOpening(user);
        await waitFor(() => expect(recoveryUpdateAttempts).toBe(1), ASYNC_UI_TIMEOUT);
        await waitFor(
          () =>
            expect(
              finishInvocationSpy.mock.calls.filter(
                ([input]) => input.status === "timed_out" && timedOutRequestIds.has(input.id),
              ),
            ).toHaveLength(1),
          ASYNC_UI_TIMEOUT,
        );
        expect(harness.cancelGeneration).not.toHaveBeenCalled();
        const timedOutRequestId = [...timedOutRequestIds][0];
        if (timedOutRequestId === undefined) throw new Error("超时重核测试没有请求编号。");

        const [latest] = await harness.runtime.creativeJourneys.listActive("idea");
        const suggestion = (
          latest?.snapshot.openingSuggestions as
            | readonly Readonly<{
                id: string;
                status: string;
                text: string;
                noticeCode: string | null;
              }>[]
            | undefined
        )?.find(({ id }) => id === timedOutRequestId);
        if (failurePoint === "terminal_fact_reread_is_running") {
          expect(postFinishReadCount).toBeGreaterThan(0);
          expect(suggestion).toMatchObject({
            status: "failed",
            text: "",
            noticeCode: "MODEL_TIMEOUT",
          });
          await expect(
            harness.runtime.modelHub.findInvocation(timedOutRequestId),
          ).resolves.toMatchObject({ status: "running" });
        } else {
          expect(suggestion).toMatchObject({ status: "pending", text: "" });
        }
      } finally {
        finishInvocationSpy.mockRestore();
        findInvocationSpy.mockRestore();
        updateSpy.mockRestore();
      }
    },
    30_000,
  );

  it.each(["persisted_provider_invocation", "returned_invocation_fact"] as const)(
    "fails the whole timeout batch before terminal effects when %s is cross-bound",
    async (corruption) => {
      const harness = createTauriIdeaRuntime(false);
      const user = userEvent.setup();
      renderJourney(harness.runtime);
      await connectOllamaForAiOpening(user);
      harness.generate.mockClear();
      harness.cancelGeneration.mockClear();
      harness.generate.mockImplementation(() => new Promise<never>(() => undefined));

      await user.type(
        screen.getByRole("textbox", { name: "一句话灵感" }),
        "三条互不相识的街道在午夜交换了各自的门牌。",
      );
      await user.click(screen.getByRole("button", { name: "生成第一段" }));
      const dialog = await screen.findByRole("dialog");
      const realSetTimeout = globalThis.setTimeout.bind(globalThis);
      const slotTimeoutCallbacks: (() => void)[] = [];
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
      ) => {
        if (
          timeout === CREATIVE_OPENING_SLOT_SETTLEMENT_TIMEOUT_MS &&
          typeof handler === "function"
        ) {
          slotTimeoutCallbacks.push(handler as () => void);
          return realSetTimeout(() => undefined, timeout);
        }
        return realSetTimeout(handler, timeout);
      }) as typeof globalThis.setTimeout);

      try {
        await user.click(within(dialog).getByRole("button", { name: "确认并发起最多 3 次调用" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
        expect(slotTimeoutCallbacks).toHaveLength(3);

        const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
        if (pending === undefined) throw new Error("串绑超时测试没有保存待处理旅程。");
        const suggestions = pending.snapshot.openingSuggestions as readonly Readonly<{
          id: string;
          providerInvocationId: string | null;
          status: string;
        }>[];
        const requestIds = suggestions.map(({ id }) => id);
        expect(requestIds).toHaveLength(3);
        const firstRequestId = requestIds[0];
        const secondRequestId = requestIds[1];
        if (firstRequestId === undefined || secondRequestId === undefined) {
          throw new Error("串绑超时测试缺少固定请求编号。");
        }

        if (corruption === "persisted_provider_invocation") {
          const corrupted: CreativeJourneyRecord = Object.freeze({
            ...pending,
            revision: pending.revision + 1,
            snapshot: Object.freeze({
              ...pending.snapshot,
              openingSuggestions: Object.freeze(
                suggestions.map((suggestion, index) =>
                  index === 0
                    ? Object.freeze({
                        ...suggestion,
                        providerInvocationId: secondRequestId,
                      })
                    : suggestion,
                ),
              ),
            }),
            updatedAt: harness.runtime.clock.now(),
          });
          await harness.runtime.creativeJourneys.update(corrupted, pending.revision);
        }

        const storedBeforeFailure = await harness.runtime.creativeJourneys.findById(pending.id);
        if (storedBeforeFailure === null) throw new Error("串绑超时测试的旅程意外消失。");
        const turnsBeforeFailure = await harness.runtime.creativeJourneys.listTurns(pending.id);
        const originalFindInvocation = harness.runtime.modelHub.findInvocation.bind(
          harness.runtime.modelHub,
        );
        const factsBeforeFailure = await Promise.all(
          requestIds.map((requestId) => originalFindInvocation(requestId)),
        );
        if (factsBeforeFailure.some((fact) => fact === null)) {
          throw new Error("串绑超时测试缺少运行中的调用记录。");
        }
        const secondFact = factsBeforeFailure[1];
        if (secondFact === null || secondFact === undefined) {
          throw new Error("串绑超时测试缺少第二条调用记录。");
        }

        const findInvocationSpy = vi
          .spyOn(harness.runtime.modelHub, "findInvocation")
          .mockImplementation(async (requestId) => {
            if (corruption === "returned_invocation_fact" && requestId === firstRequestId) {
              return secondFact;
            }
            return originalFindInvocation(requestId);
          });
        const finishInvocationSpy = vi.spyOn(harness.runtime.modelHub, "finishInvocation");
        const updateJourneySpy = vi.spyOn(harness.runtime.creativeJourneys, "update");
        harness.cancelGeneration.mockClear();

        try {
          await act(async () => {
            for (const timeout of slotTimeoutCallbacks) timeout();
            await Promise.resolve();
          });
          expect(
            await screen.findByText(
              "模型在 180 秒内没有返回，本次操作已停止且不会自动重试。正文和已有建议没有改变，可稍后明确重试。",
              undefined,
              ASYNC_UI_TIMEOUT,
            ),
          ).toBeVisible();

          expect(finishInvocationSpy).not.toHaveBeenCalled();
          expect(harness.cancelGeneration).not.toHaveBeenCalled();
          expect(updateJourneySpy).not.toHaveBeenCalled();
          const storedAfterFailure = await harness.runtime.creativeJourneys.findById(pending.id);
          expect(storedAfterFailure).toEqual(storedBeforeFailure);
          expect(await harness.runtime.creativeJourneys.listTurns(pending.id)).toEqual(
            turnsBeforeFailure,
          );
          const factsAfterFailure = await Promise.all(
            requestIds.map((requestId) => originalFindInvocation(requestId)),
          );
          expect(factsAfterFailure).toEqual(factsBeforeFailure);
          expect(factsAfterFailure.every((fact) => fact?.status === "running")).toBe(true);
        } finally {
          updateJourneySpy.mockRestore();
          finishInvocationSpy.mockRestore();
          findInvocationSpy.mockRestore();
        }
      } finally {
        timeoutSpy.mockRestore();
      }
    },
    30_000,
  );

  it("recovers an old selected snapshot with no planner locally without a second provider dispatch", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "凌晨三点，废弃泳池里浮起一张明天的报纸。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(3));

    const [active] = await harness.runtime.creativeJourneys.listActive("idea");
    if (active === undefined) throw new Error("旧规划恢复测试没有旅程。");
    const suggestions = active.snapshot.openingSuggestions as readonly Readonly<{
      id: string;
      status: string;
    }>[];
    const selected = suggestions.find(({ status }) => status === "ready");
    if (selected === undefined) throw new Error("旧规划恢复测试没有可选开头。");
    first.unmount();
    const legacyPlanningRecord: CreativeJourneyRecord = Object.freeze({
      ...active,
      currentState: "planning_questions",
      revision: active.revision + 1,
      snapshot: Object.freeze({
        ...active.snapshot,
        selectedOpeningId: selected.id,
        questionPlanner: undefined,
        questionPlan: undefined,
        expectedQuestionTotal: undefined,
        questionIndex: undefined,
        remainingQuestionFocus: undefined,
        currentQuestionKey: undefined,
      }),
      updatedAt: harness.runtime.clock.now(),
    });
    await harness.runtime.creativeJourneys.update(legacyPlanningRecord, active.revision);
    const providerCallsBeforeResume = harness.generate.mock.calls.length;

    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(
      await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).toBeVisible();
    expect(harness.generate).toHaveBeenCalledTimes(providerCallsBeforeResume);
    const recovered = await harness.runtime.creativeJourneys.findById(active.id);
    expect(recovered?.currentState).toBe("asking_one_question");
    expect(recovered?.snapshot.questionPlanner).toMatchObject({
      source: "deterministic_fallback",
      fallbackReasonCode: "PLANNER_RECOVERED_LOCALLY",
    });
    expect(recovered?.snapshot.pendingRequestId).toBeNull();
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
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(enteredTraceSaves).toBe(3));
    expect(harness.generate).not.toHaveBeenCalled();

    const [pending] = await harness.runtime.creativeJourneys.listActive("idea");
    if (pending === undefined) throw new Error("deferred opening was not saved");
    const pendingProjectId = pending.projectId;
    if (pendingProjectId === null) {
      throw new Error("deferred opening did not provision its recoverable workspace");
    }
    first.unmount();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await waitFor(() => expect(screen.getByText(/生成仍在进行，3 个方案尚未返回/u)).toBeVisible());
    expect(harness.cancelGeneration).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
    await waitFor(() => expect(screen.getAllByText("未发送")).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "结束未完成请求" })).not.toBeInTheDocument();
    expect(harness.cancelGeneration).toHaveBeenCalledTimes(3);

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
      expect(invocations.every((invocation) => invocation?.status === "cancelled")).toBe(true);
    });
    const ended = await harness.runtime.creativeJourneys.findById(pending.id);
    expect(ended?.snapshot.selectedOpeningId).toBeNull();
    expect(ended?.snapshot.questionPlanner).toBeNull();
    expect(ended?.snapshot.openingSuggestions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "pending" })]),
    );
    const endedRun = readOpeningJourneyRun(ended?.snapshot.openingRun);
    expect(endedRun).toMatchObject({ stage: "failed", autoRetryCount: 0 });
    const endedTask = (await harness.runtime.taskCenter.load()).tasks.find(
      ({ id }) => id === endedRun?.taskId,
    );
    expect(endedTask).toMatchObject({
      status: "failed",
      maxAttempts: 1,
      failure: {
        retryable: false,
        requestId: endedRun?.supportId,
      },
    });
    expect(screen.queryByRole("button", { name: "保留开头，确认创建" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).not.toBeInTheDocument();
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
    await confirmOpeningProviderAction(user, 3);

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
    let traces: Awaited<ReturnType<typeof harness.runtime.contextTraces.listByProjectId>> = [];
    await waitFor(async () => {
      traces = await harness.runtime.contextTraces.listByProjectId(projectId);
      expect(traces).toHaveLength(3);
    });
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
    await confirmOpeningProviderAction(user, 3);

    expect(await screen.findByText("AI 未完整")).toBeVisible();
    expect(screen.getByText(partialText)).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "继续补全" })).toBeEnabled();
      expect(screen.getAllByRole("button", { name: "重新生成" })[0]).toBeEnabled();
    });
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
      content: partialText,
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
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(screen.getByRole("button", { name: "继续补全" })).toBeEnabled());
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
    await confirmOpeningProviderAction(user, 1);
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

  it("requires a new one-call confirmation when regenerating a single proposal", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    harness.generate.mockClear();
    let callIndex = 0;
    const partialText = "雾中的灯塔每隔一分钟就把同一个名字投向海面。".repeat(8);
    harness.generate.mockImplementation((input) => {
      callIndex += 1;
      if (callIndex === 1) {
        input.onDelta?.(partialText);
        return Promise.reject(
          Object.assign(new Error("truncated"), { code: "MODEL_OUTPUT_TRUNCATED" }),
        );
      }
      return Promise.resolve({ text: `重生方案 ${String(callIndex)}`, usage: null });
    });
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一座灯塔每天只照亮一个不存在于地图上的岛。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(
      () => expect(screen.getByRole("button", { name: "重新生成" })).toBeEnabled(),
      ASYNC_UI_TIMEOUT,
    );
    expect(harness.generate).toHaveBeenCalledTimes(3);

    await user.click(screen.getByRole("button", { name: "重新生成" }));
    const regenerateDialog = await screen.findByRole("dialog", { name: "重新生成这个方案" });
    expect(within(regenerateDialog).getByText("本动作调用上限").parentElement).toHaveTextContent(
      /最多\s*1\s*次；\s*每个请求最多\s*1\s*次/u,
    );
    expect(harness.generate).toHaveBeenCalledTimes(3);
    await confirmOpeningProviderAction(user, 1);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(4), ASYNC_UI_TIMEOUT);
    expect(await screen.findByText("重生方案 4", undefined, ASYNC_UI_TIMEOUT)).toBeVisible();
    const [active] = await harness.runtime.creativeJourneys.listActive("idea");
    expect(active?.snapshot.openingSuggestions).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ready", text: "重生方案 4" })]),
    );
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
    await confirmOpeningProviderAction(user, 3);
    await screen.findByRole("heading", { name: "方案 3" });
    await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(3), ASYNC_UI_TIMEOUT);
    await waitFor(
      () => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled(),
      ASYNC_UI_TIMEOUT,
    );
    const initial = await harness.runtime.creativeJourneys.listActive("idea");
    const initialSuggestions = initial[0]?.snapshot.openingSuggestions;
    const initialSelection = initial[0]?.snapshot.selectedOpeningId;
    const initialPreview = initial[0]?.snapshot.preview;

    harness.generate.mockRejectedValue(
      Object.assign(new Error("provider unavailable"), { code: "MODEL_PROVIDER_UNAVAILABLE" }),
    );
    await user.click(screen.getByRole("button", { name: "换一批" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(
      () => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled(),
      ASYNC_UI_TIMEOUT,
    );

    expect(
      await screen.findByText("3 个 AI 建议没有生成", undefined, ASYNC_UI_TIMEOUT),
    ).toBeVisible();
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

  it.each([
    { label: "returns true", cancelOutcome: true },
    { label: "returns false", cancelOutcome: false },
    { label: "throws", cancelOutcome: "throw" },
  ] as const)(
    "persists the provider batch plan and never auto-repeats when local cancellation $label",
    async ({ cancelOutcome }) => {
      const harness = createTauriIdeaRuntime(false);
      harness.cancelGeneration.mockImplementation(() =>
        cancelOutcome === "throw"
          ? Promise.reject(new Error("controlled local cancellation failure"))
          : Promise.resolve(cancelOutcome),
      );
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
      await confirmOpeningProviderAction(user, 3);
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
      await waitFor(() =>
        expect(screen.getByText(/生成仍在进行，3 个方案尚未返回/u)).toBeVisible(),
      );
      expect(screen.getAllByText("等待生成")).toHaveLength(3);
      expect(screen.getByRole("button", { name: "换一批" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "增加一个悬念" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "保留开头，确认创建" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
      await waitFor(() => expect(screen.getAllByText("结果待核对")).toHaveLength(3));
      await waitFor(() => expect(harness.cancelGeneration).toHaveBeenCalledTimes(3));
      for (const { id } of plannedSuggestions) {
        expect(harness.cancelGeneration).toHaveBeenCalledWith(id);
        const invocation = await harness.runtime.modelHub.findInvocation(id);
        expect(invocation).toMatchObject({
          status: "failed",
          attempt: 1,
          errorCode: "OPENING_DISPATCH_AMBIGUOUS",
        });
        expect(typeof invocation?.providerDispatchStartedAt).toBe("string");
      }
      expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled();
      const turnsAfterAuthorEnd = await harness.runtime.creativeJourneys.listTurns(planned.id);
      expect(turnsAfterAuthorEnd.at(-1)).toMatchObject({
        kind: "regenerate",
        requestId: null,
        snapshot: { status: "author_ended" },
      });
      const endedRecord = await harness.runtime.creativeJourneys.findById(planned.id);
      const endedRun = readOpeningJourneyRun(endedRecord?.snapshot.openingRun);
      if (endedRun === null) throw new Error("作者结束后没有保留开书运行终态。");
      expect(endedRun).toMatchObject({
        stage: "result_pending",
        failureCode: "OPENING_RESULT_PENDING_REVIEW",
        autoRetryCount: 0,
      });
      expect(endedRun.supportId).toBe(endedRun.batchId);
      expect(screen.getAllByText(new RegExp(endedRun.supportId, "u")).length).toBeGreaterThan(0);
      const endedTask = (await harness.runtime.taskCenter.load()).tasks.find(
        ({ id }) => id === endedRun.taskId,
      );
      expect(endedTask).toMatchObject({
        status: "failed",
        maxAttempts: 1,
        failure: {
          code: "OPENING_RESULT_PENDING_REVIEW",
          retryable: false,
          requestId: endedRun.supportId,
        },
      });

      const thirdRequestId = plannedSuggestions[2]?.id;
      if (thirdRequestId === undefined) throw new Error("第三个固定建议槽没有请求编号。");
      await act(async () => {
        resolvers.get(thirdRequestId)?.({
          text: "这是一段乱序返回但已经完成计费的正文。",
          usage: null,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      await waitFor(async () => {
        const turns = await harness.runtime.creativeJourneys.listTurns(planned.id);
        expect(turns).toEqual(turnsAfterAuthorEnd);
        const latest = await harness.runtime.creativeJourneys.findById(planned.id);
        const suggestions = latest?.snapshot.openingSuggestions as
          readonly Readonly<{ status: string; text: string; dispatchState: string }>[] | undefined;
        expect(suggestions?.filter(({ status }) => status === "ready")).toHaveLength(0);
        expect(
          suggestions?.filter(({ dispatchState }) => dispatchState === "ambiguous"),
        ).toHaveLength(3);
        expect(suggestions?.[2]).toMatchObject({
          status: "failed",
          text: "",
          dispatchState: "ambiguous",
        });
      });
      expect(harness.generate).toHaveBeenCalledTimes(3);
      expect(screen.queryByText("这是一段乱序返回但已经完成计费的正文。")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "返回创作首页" }));
      await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
      expect(screen.queryByText("这是一段乱序返回但已经完成计费的正文。")).not.toBeInTheDocument();
      expect(screen.getAllByText("结果待核对")).toHaveLength(3);
      expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled();
      expect(harness.generate).toHaveBeenCalledTimes(3);
      expect(harness.cancelGeneration).toHaveBeenCalledTimes(3);

      const turns = await harness.runtime.creativeJourneys.listTurns(planned.id);
      expect(turns).toEqual(turnsAfterAuthorEnd);
      expect(turns.at(-1)?.snapshot.status).toBe("author_ended");

      await user.click(screen.getByRole("button", { name: "换一批" }));
      await confirmOpeningProviderAction(user, 3);
      await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(6));
      const history = screen.getByRole("region", { name: "较早请求返回的结果" });
      expect(within(history).getAllByText("结果待核对")).toHaveLength(3);
      expect(
        within(history).getAllByText("调用已经越过网络边界，但结果无法确认；系统不会自动重发。"),
      ).toHaveLength(3);
    },
    30_000,
  );

  it("archives an interrupted old batch slot before replacement and ignores its late completion", async () => {
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
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    const oldRequestId = harness.generate.mock.calls[0]?.[0].generationId;
    const active = (await harness.runtime.creativeJourneys.listActive("idea"))[0];
    if (active === undefined || oldRequestId === undefined) {
      throw new Error("旧批次没有先保存请求计划。");
    }

    first.unmount();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await waitFor(() => expect(screen.getByText(/生成仍在进行，1 个方案尚未返回/u)).toBeVisible());
    expect(harness.cancelGeneration).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
    await waitFor(() => expect(screen.getByText("结果待核对")).toBeVisible());
    expect(harness.cancelGeneration).toHaveBeenCalledOnce();
    expect(harness.cancelGeneration).toHaveBeenCalledWith(oldRequestId);
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "换一批" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(6));
    await screen.findByRole("heading", { name: "方案 3" });
    const replacement = await harness.runtime.creativeJourneys.findById(active.id);
    const replacementSelection = replacement?.snapshot.selectedOpeningId;
    const replacementPreview = replacement?.snapshot.preview;

    await act(async () => {
      resolveOldBatch({ text: "旧批次结束后才返回的已计费正文。", usage: null });
      await Promise.resolve();
    });
    await waitFor(async () => {
      const latest = await harness.runtime.creativeJourneys.findById(active.id);
      const history = latest?.snapshot.openingResultHistory as
        | readonly Readonly<{
            id: string;
            status: string;
            text: string;
            dispatchState: string;
          }>[]
        | undefined;
      expect(history?.find(({ id }) => id === oldRequestId)).toMatchObject({
        status: "failed",
        text: "",
        dispatchState: "ambiguous",
      });
      expect(latest?.snapshot.selectedOpeningId).toBe(replacementSelection);
      expect(latest?.snapshot.preview).toBe(replacementPreview);
    });
    expect(harness.generate).toHaveBeenCalledTimes(6);
    expect(screen.queryByText("旧批次结束后才返回的已计费正文。")).not.toBeInTheDocument();
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
    await confirmOpeningProviderAction(user, 3);
    await screen.findByRole("heading", { name: "方案 3" });
    await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "增加一个悬念" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "选择方案 1" }));
    expect(
      await screen.findByRole("heading", { name: "你最想让这个开头接下来发生什么？" }),
    ).toBeVisible();
    const previewBeforeAnswer = (await harness.runtime.creativeJourneys.listActive("idea"))[0]
      ?.snapshot.preview;
    const generationCountBeforeAnswer = harness.generate.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "增加一个悬念" }));
    expect(
      await screen.findByRole("heading", {
        name: "为了继续写下去，主角当前最重要的特征是什么？",
      }),
    ).toBeVisible();
    expect(harness.generate).toHaveBeenCalledTimes(generationCountBeforeAnswer);
    const active = (await harness.runtime.creativeJourneys.listActive("idea"))[0];
    if (active === undefined) throw new Error("回答没有保存到构思流程。 ");
    expect(active.snapshot.pendingRequestId).toBeNull();
    expect(active.snapshot.preview).toBe(previewBeforeAnswer);
    expect(active.currentState).toBe("asking_one_question");
    expect(parseProjectSeed(active.snapshot.projectSeed)?.currentDirection.values).toEqual([
      "增加一个悬念",
    ]);

    await user.click(screen.getByRole("button", { name: "换一批" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() =>
      expect(harness.generate).toHaveBeenCalledTimes(generationCountBeforeAnswer + 3),
    );
  }, 30_000);

  it.each(["reserved", "bound", "dispatched"] as const)(
    "reopens an orphaned opening at the %s crash point without redispatch or guessing an active terminal state",
    async (crashPoint) => {
      const harness = createTauriIdeaRuntime(false);
      const user = userEvent.setup();
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
      await harness.runtime.modelHub.saveConnection({
        id: "recovery-ollama",
        providerKind: "ollama",
        displayName: "Recovery Ollama",
        credentialState: "missing",
        expectedRevision: null,
      });
      let invocation =
        crashPoint === "reserved"
          ? null
          : await harness.runtime.modelHub.startInvocation({
              id: pendingId,
              task: "book_start_guidance",
              connectionId: "recovery-ollama",
              providerKindSnapshot: "ollama",
              modelIdSnapshot: "local-novel",
              routeReason: "user_override",
              attempt: 1,
              privacyPolicy: "cloud_allowed",
              dataDestination: "local",
            });
      if (crashPoint === "dispatched" && invocation !== null) {
        invocation = await harness.runtime.modelHub.markInvocationDispatched({
          id: invocation.id,
          dispatchedAt: now,
          expectedRevision: invocation.revision,
        });
      }
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

      const startupRecovery = await recoverOrphanedOpeningInvocationsAtStartup(harness.runtime);
      expect(startupRecovery).toEqual({
        inspectedJourneyCount: 1,
        inspectedInvocationCount: 1,
        terminalizedInvocationCount: 0,
        failedInvocationCount: 0,
      });
      renderJourney(harness.runtime);
      const exactHeading = await screen.findByRole("heading", {
        name: "一座城市会在雨夜忘记一条街。",
        level: 3,
      });
      const exactCard = exactHeading.closest(".ink-card");
      if (!(exactCard instanceof HTMLElement)) throw new Error("没有找到准确的未完成构思卡片。");
      await user.click(within(exactCard).getByRole("button", { name: "继续这次构思" }));
      await waitFor(async () => {
        const saved = await harness.runtime.creativeJourneys.findById(journeyId);
        expect(saved?.snapshot.pendingRequestId).toBe(crashPoint === "reserved" ? null : pendingId);
      });
      expect(harness.generate).not.toHaveBeenCalled();
      expect(harness.cancelGeneration).not.toHaveBeenCalled();
      const recovered = await harness.runtime.creativeJourneys.findById(journeyId);
      expect(recovered?.snapshot.pendingRequestId).toBe(
        crashPoint === "reserved" ? null : pendingId,
      );
      expect(recovered?.snapshot.openingSuggestions).toHaveLength(2);
      if (crashPoint === "reserved") {
        expect(recovered?.snapshot.openingSuggestions).toEqual([
          expect.objectContaining({ id: readyId, status: "ready", slotNumber: 1 }),
          expect.objectContaining({
            id: pendingId,
            status: "failed",
            slotNumber: 2,
            dispatchState: "not_dispatched",
            noticeCode: "OPENING_NOT_DISPATCHED",
          }),
        ]);
      } else {
        expect(recovered?.snapshot.openingSuggestions).toEqual([
          expect.objectContaining({ id: readyId, status: "ready" }),
          expect.objectContaining({ id: pendingId, status: "pending" }),
        ]);
      }
      const recoveredInvocation = await harness.runtime.modelHub.findInvocation(pendingId);
      if (crashPoint === "reserved") {
        expect(recoveredInvocation).toBeNull();
      } else {
        expect(recoveredInvocation).toMatchObject({
          status: "running",
          errorCode: null,
          providerDispatchStartedAt: crashPoint === "dispatched" ? now : null,
        });
      }
      const turns = await harness.runtime.creativeJourneys.listTurns(journeyId);
      if (crashPoint === "reserved") {
        const recoverySnapshot = turns.at(-1)?.snapshot;
        expect(recoverySnapshot?.status).toBe("interrupted_recovered");
        expect(recoverySnapshot?.slots).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: pendingId,
              slotNumber: 2,
              dispatchState: "not_dispatched",
              noticeCode: "OPENING_NOT_DISPATCHED",
            }),
          ]),
        );
      } else {
        expect(turns).toHaveLength(1);
        expect(turns[0]?.snapshot.status).toBe("pending");
      }
    },
  );

  it("recovers terminal slots while leaving a running slot pending without reordering or redispatch", async () => {
    const harness = createTauriIdeaRuntime(false);
    const now = harness.runtime.clock.now();
    const journeyId = harness.runtime.ids.next();
    const batchId = harness.runtime.ids.next();
    const readyId = harness.runtime.ids.next();
    const cancelledId = harness.runtime.ids.next();
    const ambiguousId = harness.runtime.ids.next();
    await harness.runtime.modelHub.saveConnection({
      id: "mixed-recovery-ollama",
      providerKind: "ollama",
      displayName: "Mixed Recovery Ollama",
      credentialState: "missing",
      expectedRevision: null,
    });
    const startInvocation = async (id: string) => {
      const queued = await harness.runtime.modelHub.startInvocation({
        id,
        task: "book_start_guidance",
        connectionId: "mixed-recovery-ollama",
        providerKindSnapshot: "ollama",
        modelIdSnapshot: "local-novel",
        routeReason: "user_override",
        attempt: 1,
        privacyPolicy: "cloud_allowed",
        dataDestination: "local",
      });
      return harness.runtime.modelHub.markInvocationDispatched({
        id,
        dispatchedAt: now,
        expectedRevision: queued.revision,
      });
    };
    const cancelledInvocation = await startInvocation(cancelledId);
    await harness.runtime.modelHub.finishInvocation({
      id: cancelledId,
      status: "cancelled",
      expectedRevision: cancelledInvocation.revision,
    });
    await startInvocation(ambiguousId);
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
        idea: "雨夜里，三封信分别停在门前。",
        preview: "第一封信已经被拆开。",
        previewSource: "provider",
        providerId: "mixed-recovery-ollama",
        modelId: "local-novel",
        noticeCode: null,
        pendingRequestId: ambiguousId,
        openingGenerationMode: "provider",
        openingSuggestions: Object.freeze([
          Object.freeze({
            id: readyId,
            batchId,
            slotNumber: 1,
            text: "第一封信已经被拆开。",
            source: "provider",
            status: "ready",
            openingAngle: "immediate_action",
            providerId: "mixed-recovery-ollama",
            modelId: "local-novel",
            noticeCode: null,
            contextTraceId: null,
            providerInvocationId: null,
            dispatchState: "succeeded",
          }),
          Object.freeze({
            id: cancelledId,
            batchId,
            slotNumber: 2,
            text: "",
            source: "provider",
            status: "pending",
            openingAngle: "relationship_dialogue",
            providerId: "mixed-recovery-ollama",
            modelId: "local-novel",
            noticeCode: null,
            contextTraceId: null,
            providerInvocationId: cancelledId,
            dispatchState: "dispatched",
          }),
          Object.freeze({
            id: ambiguousId,
            batchId,
            slotNumber: 3,
            text: "",
            source: "provider",
            status: "pending",
            openingAngle: "mystery_clue",
            providerId: "mixed-recovery-ollama",
            modelId: "local-novel",
            noticeCode: null,
            contextTraceId: null,
            providerInvocationId: ambiguousId,
            dispatchState: "dispatched",
          }),
        ]),
        openingResultHistory: Object.freeze([]),
        selectedOpeningId: null,
        openingBatchId: batchId,
        openingBatchFailureCount: 0,
        provisioningPlan: null,
        answers: Object.freeze({}),
        skippedQuestionKeys: Object.freeze([]),
        questionHistory: Object.freeze([]),
        currentQuestionKey: null,
        projectName: "雨夜三封信",
        storySummary: "雨夜里，三封信分别停在门前。",
        summaryCustomized: false,
        projectSeed: deriveIdeaProjectSeed({
          seedId: `idea:${journeyId}`,
          idea: "雨夜里，三封信分别停在门前。",
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
      requestId: ambiguousId,
      snapshot: Object.freeze({ status: "pending", batchId }),
      createdAt: now,
    });

    const user = userEvent.setup();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await waitFor(() => expect(screen.getByText("已完成")).toBeVisible());
    expect(screen.getByText("已取消")).toBeVisible();
    expect(screen.getByText("等待生成")).toBeVisible();
    expect(screen.getByRole("heading", { name: "方案 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "方案 2" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "方案 3" })).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();
    expect(harness.cancelGeneration).not.toHaveBeenCalled();
    const recovered = await harness.runtime.creativeJourneys.findById(journeyId);
    expect(recovered?.snapshot.openingSuggestions).toEqual([
      expect.objectContaining({ id: readyId, slotNumber: 1, dispatchState: "succeeded" }),
      expect.objectContaining({ id: cancelledId, slotNumber: 2, dispatchState: "cancelled" }),
      expect.objectContaining({
        id: ambiguousId,
        slotNumber: 3,
        status: "pending",
        dispatchState: "dispatched",
      }),
    ]);
    expect(recovered?.snapshot.pendingRequestId).toBe(ambiguousId);
    expect((await harness.runtime.modelHub.findInvocation(ambiguousId))?.status).toBe("running");
  });

  it("keeps a late paid result pending review after the author ends waiting and replaces the batch", async () => {
    const harness = createTauriIdeaRuntime(false);
    const user = userEvent.setup();
    const first = renderJourney(harness.runtime);
    await connectOllamaForAiOpening(user);
    await user.type(
      screen.getByRole("textbox", { name: "一句话灵感" }),
      "一名邮差每天都收到明天寄来的退信。",
    );
    await user.click(screen.getByRole("button", { name: "生成第一段" }));
    await confirmOpeningProviderAction(user, 3);
    await screen.findByRole("heading", { name: "方案 3" });
    await waitFor(() => expect(screen.getAllByText("已完成")).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());
    harness.generate.mockClear();

    let resolveAnswer!: (value: { text: string; usage: null }) => void;
    harness.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAnswer = resolve;
        }),
    );
    await user.click(screen.getByRole("button", { name: "换一批" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(3));
    const requestId = harness.generate.mock.calls[0]?.[0].generationId;
    const active = (await harness.runtime.creativeJourneys.listActive("idea"))[0];
    if (active === undefined || requestId === undefined) {
      throw new Error("迟到结果测试没有保存待处理请求。");
    }

    first.unmount();
    renderJourney(harness.runtime);
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    await waitFor(() => expect(screen.getByText(/生成仍在进行，1 个方案尚未返回/u)).toBeVisible());
    expect(harness.cancelGeneration).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "结束未完成请求" }));
    await waitFor(() => expect(screen.getByText("结果待核对")).toBeVisible());
    expect(harness.cancelGeneration).toHaveBeenCalledTimes(1);
    expect(harness.cancelGeneration).toHaveBeenCalledWith(requestId);
    await waitFor(() => expect(screen.getByRole("button", { name: "换一批" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "换一批" }));
    await confirmOpeningProviderAction(user, 3);
    await waitFor(() => expect(harness.generate).toHaveBeenCalledTimes(6));
    const alternativeChoice = screen.getAllByRole("button", {
      name: /^选择方案 \d+$/u,
    })[0];
    if (alternativeChoice === undefined) throw new Error("没有可切换的已完成建议。");
    await user.click(alternativeChoice);
    const selectedBeforeReturn = await harness.runtime.creativeJourneys.findById(active.id);
    const selectedId = selectedBeforeReturn?.snapshot.selectedOpeningId;
    const selectedPreview = selectedBeforeReturn?.snapshot.preview;

    await act(async () => {
      resolveAnswer({ text: "这是一份结束等待后才返回、已经计费的正文。", usage: null });
      await Promise.resolve();
    });
    await waitFor(async () => {
      const latest = await harness.runtime.creativeJourneys.findById(active.id);
      const history = latest?.snapshot.openingResultHistory as
        | readonly Readonly<{
            id: string;
            status: string;
            text: string;
            dispatchState: string;
          }>[]
        | undefined;
      expect(history?.find(({ id }) => id === requestId)).toMatchObject({
        status: "failed",
        text: "",
        dispatchState: "ambiguous",
      });
      expect(latest?.snapshot.selectedOpeningId).toBe(selectedId);
      expect(latest?.snapshot.preview).toBe(selectedPreview);
    });
    expect(harness.generate).toHaveBeenCalledTimes(6);

    await user.click(screen.getByRole("button", { name: "返回创作首页" }));
    await user.click(await screen.findByRole("button", { name: "继续这次构思" }));
    expect(await screen.findByText("较早请求返回的结果")).toBeVisible();
    expect(
      screen.queryByText("这是一份结束等待后才返回、已经计费的正文。"),
    ).not.toBeInTheDocument();
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
    Promise.resolve({
      text: input.messages.at(-1)?.content.includes("只回复：OK")
        ? "OK"
        : `供应商开头 ${input.generationId}`,
      usage: null,
    }),
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

async function startDirectOpeningWithoutConnection(
  user: ReturnType<typeof userEvent.setup>,
  idea: string,
): Promise<void> {
  expect(await screen.findByRole("button", { name: "开始创作" })).toBeVisible();
  await user.type(screen.getByRole("textbox", { name: "一句话" }), idea);
  await user.click(screen.getByRole("button", { name: "开始创作" }));
  expect(await screen.findByText(/这项写作任务还没有可用的 AI 分工/u)).toBeVisible();
  expect(screen.getByRole("button", { name: "去连接" })).toBeEnabled();
}

async function connectOllamaAfterDirectOpeningFailure(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole("button", { name: "去连接" }));
  expect(await screen.findByRole("heading", { name: "连接你的 AI" })).toBeVisible();
  await user.click(screen.getByRole("radio", { name: /Ollama/u }));
  await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
  await screen.findByText("连接成功 · 已找到模型");
  await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
  await user.click(screen.getByRole("button", { name: "确认 1 次固定验证并继续" }));
  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "连接你的 AI" })).not.toBeInTheDocument();
  });
  expect(screen.getByRole("button", { name: "稍后重试" })).toBeEnabled();
}

async function retryDirectOpening(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "稍后重试" }));
  await confirmOpeningProviderAction(user, 1);
}

async function connectOllamaForAiOpening(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText("AI 还没连接，也可以开始");
  await user.click(screen.getByRole("button", { name: "去连接 AI" }));
  await user.click(screen.getByRole("radio", { name: /Ollama/u }));
  await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
  await screen.findByText("连接成功 · 已找到模型");
  await user.click(screen.getByRole("radio", { name: /让 AI 起个头/u }));
  await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
  await user.click(screen.getByRole("button", { name: "确认 1 次固定验证并继续" }));
  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "连接你的 AI" })).not.toBeInTheDocument();
  });
}

async function confirmOpeningProviderAction(
  user: ReturnType<typeof userEvent.setup>,
  maximumProviderCalls: 1 | 3,
): Promise<void> {
  const dialog = await screen.findByRole("dialog", undefined, { timeout: 10_000 });
  await user.click(
    within(dialog).getByRole("button", {
      name: `确认并发起最多 ${String(maximumProviderCalls)} 次调用`,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), {
    timeout: 5_000,
  });
}

async function setSingleConnectionRetryLimit(
  runtime: DesktopRuntime,
  retryLimit: number,
): Promise<void> {
  const connections = await runtime.modelHub.listConnections();
  const connection = connections[0];
  if (connection === undefined || connections.length !== 1) {
    throw new Error("测试需要恰好一个已连接的模型供应商。");
  }
  const saved = await runtime.modelHub.saveConnection({
    id: connection.id,
    providerKind: connection.providerKind,
    displayName: connection.displayName,
    region: connection.region,
    workspaceId: connection.workspaceId,
    endpointId: connection.endpointId,
    baseUrlOverride: connection.baseUrl,
    credentialRef: connection.credentialRef,
    credentialState: connection.credentialState,
    authenticationMode: connection.authenticationMode,
    credentialHeaderName: connection.credentialHeaderName,
    modelDiscoveryPath: connection.modelDiscoveryPath,
    textGenerationPath: connection.textGenerationPath,
    embeddingPath: connection.embeddingPath,
    requestTimeoutMs: connection.requestTimeoutMs,
    retryLimit,
    legacyProviderId: connection.legacyProviderId,
    enabled: connection.enabled,
    expectedRevision: connection.revision,
  });
  expect(saved.retryLimit).toBe(retryLimit);
}

function renderJourneyWithRouteDriver(runtime: DesktopRuntime, initialEntry = "/create/idea") {
  let navigateRoute: ((path: string) => void) | null = null;

  function RouteDriver() {
    const navigate = useNavigate();
    useEffect(() => {
      navigateRoute = (path) => {
        void navigate(path);
      };
      return () => {
        navigateRoute = null;
      };
    }, [navigate]);
    return null;
  }

  const view = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <RouteDriver />
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <Routes>
            <Route path="/create/idea" element={<IdeaJourneyPage />} />
          </Routes>
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
  return Object.freeze({
    view,
    navigate(path: string): void {
      const navigate = navigateRoute;
      if (navigate === null) throw new Error("测试路由尚未准备完成。");
      act(() => {
        navigate(path);
      });
    },
  });
}

function renderJourney(runtime: DesktopRuntime, initialEntry = "/create/idea") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <Routes>
            <Route path="/create/idea" element={<IdeaJourneyPage />} />
            <Route
              path="/projects/:projectId/chapters/:chapterId"
              element={<IdeaJourneyDestinationProbe />}
            />
          </Routes>
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function IdeaJourneyDestinationProbe() {
  const state = useLocation().state as Readonly<{
    directOpeningOrganization?: Readonly<{
      status?: string;
      organizedCount?: number;
      importantReviewCount?: number;
    }>;
  }> | null;
  const organization = state?.directOpeningOrganization;
  const notice =
    organization?.status === "failed"
      ? "正文和版本已保存；本地设定整理暂未完成，可稍后重新整理。"
      : organization?.status === "organized" &&
          typeof organization.organizedCount === "number" &&
          typeof organization.importantReviewCount === "number"
        ? organization.importantReviewCount > 0
          ? `已整理 ${String(organization.organizedCount)} 条；有 ${String(organization.importantReviewCount)} 条重要设定需要你确认。`
          : `已整理 ${String(organization.organizedCount)} 条`
        : null;
  return (
    <>
      <p>已进入 AI 建议版本比较</p>
      {notice === null ? null : <p>{notice}</p>}
    </>
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
