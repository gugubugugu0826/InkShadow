import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UuidV7 } from "@inkshadow/domain";
import {
  NARRATIVE_ANALYSIS_COVERAGE_AREAS,
  parseUuidV7 as parseStoryUuid,
  type StoryFact,
} from "@inkshadow/story-core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { ProjectChecksPage } from "./project-checks-page";

const CONTENT = "林遥仍然活着。林遥已经死去。";
const REFERENCE_EXCERPT = "林遥仍然活着";
const CURRENT_EXCERPT = "林遥已经死去";

describe("ProjectChecksPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("lets the user select a chapter and honestly explains a skipped check", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(false);
    unwrap(
      await fixture.runtime.useCases.createChapter.execute({
        projectId: fixture.projectId,
        title: "第二章",
        content: "另一个章节。",
      }),
    );
    renderPage(fixture.runtime, fixture.projectId);

    const selector = await screen.findByRole("combobox", { name: "章节" });
    expect(selector).toHaveValue(fixture.chapterId);
    expect(within(selector).getAllByRole("option")).toHaveLength(2);
    await user.selectOptions(selector, within(selector).getAllByRole("option")[1] ?? "");
    await user.click(screen.getByRole("button", { name: "检查本章" }));

    expect(await screen.findByText("本章暂时没有足够证据完成检查")).toBeInTheDocument();
    expect(
      screen.getByText("本章还没有带原文位置的明确事实，系统不会从语气或暗示中猜测。"),
    ).toBeInTheDocument();
    expect(screen.getByText("尚无足够证据")).toBeInTheDocument();
    expect(screen.queryByText(/已发现\s*\d+\s*个问题/u)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "确定性检查" })).toBeInTheDocument();
    const aiHeading = await screen.findByRole("heading", { name: "AI 模糊复核" });
    const aiSection = aiHeading.closest("section");
    if (!(aiSection instanceof HTMLElement)) {
      throw new Error("Expected the separate AI review section.");
    }
    expect(within(aiSection).getAllByText("未运行 / 证据不足")).toHaveLength(3);
    expect(within(aiSection).queryByText("已通过")).not.toBeInTheDocument();
    const qualityHeading = screen.getByRole("heading", { name: "AI 内容质量建议" });
    const qualitySection = qualityHeading.closest("section");
    if (!(qualitySection instanceof HTMLElement)) {
      throw new Error("Expected the separate content-quality review section.");
    }
    expect(within(qualitySection).getByText("AI 建议，需要作者判断")).toBeInTheDocument();
    expect(within(qualitySection).getByText("未运行 / 证据不足")).toBeInTheDocument();
    expect(within(qualitySection).queryByText("已通过")).not.toBeInTheDocument();
  });

  it("shows both evidence sources and persists a reversible ignore", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(true);
    renderPage(fixture.runtime, fixture.projectId);

    await user.click(await screen.findByRole("button", { name: "检查本章" }));
    const heading = await screen.findByRole("heading", { name: "人物生死冲突" });
    const issueCard = heading.closest(".ink-card");
    if (!(issueCard instanceof HTMLElement)) {
      throw new Error("Expected a rendered issue card.");
    }
    expect(within(issueCard).getByText(CURRENT_EXCERPT)).toBeInTheDocument();
    expect(within(issueCard).getByText("林遥在这一时间段仍然存活。")).toBeInTheDocument();
    expect(within(issueCard).getAllByText("查看来源")).toHaveLength(2);
    expect(within(issueCard).getByRole("button", { name: "忽略" })).toBeEnabled();
    expect(within(issueCard).getByRole("button", { name: "标记为允许" })).toBeEnabled();
    expect(within(issueCard).getByRole("button", { name: "用当前正文更新正式设定" })).toBeEnabled();

    await user.click(within(issueCard).getByRole("button", { name: "忽略" }));
    expect(await screen.findByText("已忽略（可以撤销）")).toBeInTheDocument();
    expect(screen.getByText(/只作用于这条问题和当前章节版本/u)).toBeInTheDocument();
    expect(screen.getByText("本版本处理记录（1）")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "撤销忽略" }));
    expect(await screen.findByText(/这条问题重新进入待处理状态/u)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "忽略" })).toBeEnabled());
    expect(screen.getByText("已撤销")).toBeInTheDocument();
  });

  it("makes the allow action create a locked, traceable formal rule", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(true);
    renderPage(fixture.runtime, fixture.projectId);

    await user.click(await screen.findByRole("button", { name: "检查本章" }));
    await user.click(
      await screen.findByRole("button", {
        name: "标记为允许",
      }),
    );

    expect(await screen.findByText("已标记为允许，并建立了锁定规则")).toBeInTheDocument();
    expect(screen.getByText("已建立并锁定允许规则；原正文没有改变。")).toBeInTheDocument();
    const facts = await listFacts(fixture.runtime, fixture.projectId);
    expect(
      facts.some((fact) => {
        const snapshot = fact.toSnapshot();
        return (
          snapshot.locked &&
          snapshot.status === "formal" &&
          isRecord(snapshot.structuredValue) &&
          snapshot.structuredValue.resolutionAction === "allow" &&
          snapshot.structuredValue.validationRole === "hard_rule"
        );
      }),
    ).toBe(true);
  });

  it("makes update-setting replace the old formal fact without changing正文", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(true);
    const before = unwrap(
      await fixture.runtime.repositories.chapters.findById(fixture.chapterId),
    )?.toSnapshot();
    renderPage(fixture.runtime, fixture.projectId);

    await user.click(await screen.findByRole("button", { name: "检查本章" }));
    await user.click(
      await screen.findByRole("button", {
        name: "用当前正文更新正式设定",
      }),
    );

    expect(
      await screen.findByText("已创建用户确认的正式事实，并停用被替换设定；原正文没有改变。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "没有发现有证据支持的冲突" })).toBeInTheDocument();
    const after = unwrap(
      await fixture.runtime.repositories.chapters.findById(fixture.chapterId),
    )?.toSnapshot();
    expect(after).toEqual(before);

    const facts = await listFacts(fixture.runtime, fixture.projectId);
    expect(
      facts.some((fact) => {
        const snapshot = fact.toSnapshot();
        return (
          snapshot.status === "formal" &&
          isRecord(snapshot.structuredValue) &&
          snapshot.structuredValue.resolutionAction === "update_setting" &&
          snapshot.structuredValue.validationRole === "reference_fact" &&
          snapshot.structuredValue.value === "dead"
        );
      }),
    ).toBe(true);
    expect(
      facts.some((fact) =>
        fact.id === fixture.referenceFactId ? fact.toSnapshot().deprecated : false,
      ),
    ).toBe(true);
  });

  it("keeps specialist routes behind disclosure and exposes the causal story view", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(false);
    renderPage(fixture.runtime, fixture.projectId);

    const disclosure = screen.getByText("高级工具").closest("details");
    if (!(disclosure instanceof HTMLDetailsElement)) {
      throw new Error("找不到高级工具折叠区域。 ");
    }
    expect(disclosure.open).toBe(false);
    await user.click(within(disclosure).getByText("高级工具"));
    expect(disclosure.open).toBe(true);
    expect(within(disclosure).getByRole("link", { name: "打开查看故事关联" })).toHaveAttribute(
      "href",
      `/projects/${fixture.projectId}/graph`,
    );
  });

  it("shows evidence-backed plotline, foreshadow, and pacing sections without guessing", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(false);
    await seedNarrativeSections(fixture);
    renderPage(fixture.runtime, fixture.projectId);

    await user.click(await screen.findByRole("button", { name: "检查本章" }));

    expect(await screen.findByRole("heading", { name: "多线叙事协调" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "伏笔推进" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "节奏与章节质量" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "找到失踪的钥匙" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "foreshadow-key" })).toBeInTheDocument();
    expect(screen.getByText(/既未推进剧情，也未改变人物状态/u)).toBeInTheDocument();
    expect(screen.queryByText(/质量总分|综合评分/u)).not.toBeInTheDocument();
  });
});

interface SeededRuntime {
  readonly runtime: DesktopRuntime;
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly referenceFactId: string | null;
}

async function seededRuntime(withConflict: boolean): Promise<SeededRuntime> {
  const runtime = createDevelopmentRuntime(window.localStorage);
  const project = unwrap(await runtime.useCases.createProject.execute({ name: "检查测试项目" }));
  const chapter = unwrap(
    await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第一章",
      content: CONTENT,
    }),
  );
  let referenceFactId: string | null = null;
  if (withConflict) {
    const chapterSnapshot = chapter.chapter.toSnapshot();
    const currentStart = CONTENT.indexOf(CURRENT_EXCERPT);
    const referenceStart = CONTENT.indexOf(REFERENCE_EXCERPT);
    unwrap(
      await runtime.story.factService.stageAutomaticFact({
        projectId: project.id,
        factType: "character_life_status",
        contentText: "本章明确写出林遥已经死亡。",
        structuredValue: {
          validationRole: "current_claim",
          subjectId: "character.lin-yao",
          attributeKey: "life_status",
          value: "dead",
          basis: "explicit_text",
          effectiveRange: { startOrder: 10, endOrder: null },
        },
        source: {
          kind: "chapter_span",
          reference: `chapter:${chapterSnapshot.id}:current-death`,
          chapterId: chapterSnapshot.id,
          versionId: chapterSnapshot.currentVersionId,
          startOffset: currentStart,
          endOffset: currentStart + CURRENT_EXCERPT.length,
          sourceLength: CONTENT.length,
          excerpt: CURRENT_EXCERPT,
        },
        confidence: 1,
        origin: "ai_extraction",
      }),
    );
    const reference = unwrap(
      await runtime.story.factService.createFormalUserFact({
        projectId: project.id,
        factType: "character_life_status",
        contentText: "林遥在这一时间段仍然存活。",
        structuredValue: {
          validationRole: "reference_fact",
          subjectId: "character.lin-yao",
          attributeKey: "life_status",
          value: "alive",
          effectiveRange: { startOrder: 1, endOrder: null },
        },
        source: {
          kind: "chapter_span",
          reference: `chapter:${chapterSnapshot.id}:confirmed-alive`,
          chapterId: chapterSnapshot.id,
          versionId: chapterSnapshot.currentVersionId,
          startOffset: referenceStart,
          endOffset: referenceStart + REFERENCE_EXCERPT.length,
          sourceLength: CONTENT.length,
          excerpt: REFERENCE_EXCERPT,
        },
        actorId: runtime.story.actorId,
        humanConfirmed: true,
      }),
    );
    referenceFactId = reference.id;
  }
  return {
    runtime,
    projectId: project.id,
    chapterId: chapter.chapter.id,
    referenceFactId,
  };
}

async function seedNarrativeSections(fixture: SeededRuntime): Promise<void> {
  const chapter = unwrap(
    await fixture.runtime.repositories.chapters.findById(fixture.chapterId),
  )?.toSnapshot();
  if (chapter === undefined) {
    throw new Error("Expected a chapter for narrative analysis.");
  }
  const source = {
    kind: "chapter_span" as const,
    reference: `chapter:${chapter.id}:narrative-test`,
    chapterId: chapter.id,
    versionId: chapter.currentVersionId,
    startOffset: 0,
    endOffset: chapter.content.length,
    sourceLength: chapter.content.length,
    excerpt: chapter.content,
  };
  const createFact = async (value: Readonly<Record<string, unknown>>): Promise<void> => {
    unwrap(
      await fixture.runtime.story.factService.createFormalUserFact({
        projectId: fixture.projectId,
        factType: "narrative_analysis",
        contentText: "用户确认的叙事检查资料。",
        structuredValue: {
          schemaVersion: "inkshadow.narrative-analysis-fact.v1",
          ...value,
        },
        source,
        actorId: fixture.runtime.story.actorId,
        humanConfirmed: true,
      }),
    );
  };
  await createFact({ kind: "chapter", chapterId: chapter.id, order: 1 });
  for (const area of NARRATIVE_ANALYSIS_COVERAGE_AREAS) {
    await createFact({ kind: "coverage", area, complete: true });
  }
  await createFact({ kind: "plotline", plotlineId: "plot-main", goal: "找到失踪的钥匙" });
  await createFact({
    kind: "scene_metric",
    sceneId: "scene-one",
    chapterId: chapter.id,
    sequence: 1,
    goal: "寻找钥匙",
    conflictIntensity: 0.5,
    tension: { start: 0.2, end: 0.4, peak: 0.5 },
    composition: {
      informationRatio: 0.25,
      dialogueRatio: 0.25,
      descriptionRatio: 0.25,
      innerActivityRatio: 0.25,
      measuredUnits: 100,
    },
    plotAdvancement: { advances: false, plotlineIds: [] },
    characterChange: { changes: false, characterIds: [] },
    functionTags: ["search"],
    setupBeatIds: [],
    climax: { isClimax: false, requiredSetupBeatIds: [] },
  });
  const hash = String(unwrap(await fixture.runtime.hasher.sha256(chapter.content)));
  const evidence = {
    id: "event-key:evidence",
    chapterId: chapter.id,
    chapterVersionId: chapter.currentVersionId,
    contentHash: hash,
    locator: `${source.reference}#utf16:0-${String(chapter.content.length)}/${String(chapter.content.length)}`,
    excerpt: chapter.content,
    startOffset: 0,
    endOffset: chapter.content.length,
    sourceLength: chapter.content.length,
  };
  await fixture.runtime.story.causalGraph.replace({
    projectId: fixture.projectId,
    branchId: "main",
    graph: {
      events: [
        {
          id: "event-key",
          projectId: fixture.projectId,
          branchId: "main",
          status: "confirmed",
          participantCharacterIds: ["character-hero"],
          narrativeTime: { order: 1, label: "第一章" },
          location: { locationId: "old-house", label: "旧宅" },
          prerequisites: [],
          eventText: "主角发现钥匙线索。",
          resultText: "钥匙伏笔被埋下。",
          characterStateChanges: [],
          relationshipChanges: [],
          itemChanges: [],
          informedCharacterIds: ["character-hero"],
          foreshadowProgress: [
            {
              id: "foreshadow-key-planted",
              foreshadowId: "foreshadow-key",
              kind: "planted",
              description: "钥匙伏笔被明确埋下。",
              evidence,
            },
          ],
          downstreamEventIds: [],
          evidence,
        },
      ],
      relations: [],
    },
  });
}

function renderPage(runtime: DesktopRuntime, projectId: string) {
  return render(
    <RuntimeProvider runtime={runtime}>
      <MemoryRouter initialEntries={[`/projects/${projectId}/checks`]}>
        <Routes>
          <Route path="/projects/:projectId/checks" element={<ProjectChecksPage />} />
          <Route path="/projects/:projectId" element={<h1>正文目的地</h1>} />
        </Routes>
      </MemoryRouter>
    </RuntimeProvider>,
  );
}

async function listFacts(
  runtime: DesktopRuntime,
  projectId: string,
): Promise<readonly StoryFact[]> {
  const parsed = parseStoryUuid(projectId);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return unwrap(await runtime.story.facts.listByProjectId(parsed.value));
}

function unwrap<Value>(
  result:
    | Readonly<{ readonly ok: true; readonly value: Value }>
    | Readonly<{ readonly ok: false; readonly error: unknown }>,
): Value {
  if (!result.ok) {
    throw result.error instanceof Error ? result.error : new Error(String(result.error));
  }
  return result.value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
