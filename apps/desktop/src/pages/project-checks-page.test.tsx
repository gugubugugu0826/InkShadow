import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppError, type UuidV7 } from "@inkshadow/domain";
import {
  NARRATIVE_ANALYSIS_COVERAGE_AREAS,
  parseUuidV7 as parseStoryUuid,
  type StoryFact,
} from "@inkshadow/story-core";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import {
  forgetUiRouteDiagnosticsMemoryForTests,
  readSafeUiRouteIncidents,
} from "../infrastructure/ui-route-diagnostics";
import { DEVELOPMENT_WRITING_EXPERIENCE_KEY } from "../infrastructure/writing-experience-store";
import {
  findSupplementalFindingResolution,
  supplementalEvidenceSignature,
  type SupplementalFindingDescriptor,
} from "../infrastructure/chapter-supplemental-finding-verifier";
import type { ChapterSupplementalFindingResolutionSummary } from "../infrastructure/novel-validation-runtime";
import { RuntimeProvider } from "../runtime-context";
import { ProjectChecksPage } from "./project-checks-page";

const CONTENT = "林遥仍然活着。林遥已经死去。";
const REFERENCE_EXCERPT = "林遥仍然活着";
const CURRENT_EXCERPT = "林遥已经死去";

function supplementalResolutionSummary(
  overrides: Pick<
    ChapterSupplementalFindingResolutionSummary,
    "factId" | "chapterVersionId" | "evidenceSignature"
  >,
): ChapterSupplementalFindingResolutionSummary {
  return {
    findingId: "voice:stable-id",
    category: "character_voice",
    action: "ignore",
    factRevision: 1,
    chapterId: "chapter-one",
    decidedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function seedWritingExperience(mode: "direct" | "professional"): void {
  const timestamp = "2026-08-22T00:00:00.000Z";
  window.localStorage.setItem(
    DEVELOPMENT_WRITING_EXPERIENCE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      preference: {
        mode,
        initializationSource: "user",
        directLocalOrganizationAuthorizedAt: mode === "direct" ? timestamp : null,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      grants: {},
      grantAudit: [],
    }),
  );
}

describe("ProjectChecksPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedWritingExperience("professional");
  });

  it("does not describe a missing project as an empty project", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const missingProjectId = "019f9f4a-b3c7-7350-9226-999999999999";
    const findById = vi.spyOn(runtime.repositories.projects, "findById");

    renderPage(runtime, missingProjectId);

    await waitFor(() => expect(findById).toHaveBeenCalledWith(missingProjectId));
    expect(screen.queryByText("还没有可检查的章节")).not.toBeInTheDocument();
    expect(await screen.findByText(/支持编号：UI-/u)).toBeVisible();
  });

  it("records a redacted support incident when project authority cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const projectId = "019f9f4a-b3c7-7350-9226-999999999998";
    const sensitive = "sk-private 正文 C:/Users/writer/private.txt";
    const failure = new AppError({
      code: "REPOSITORY_ERROR",
      message: sensitive,
      retryable: true,
      actions: ["RETRY"],
      details: { stage: "project" },
    });
    vi.spyOn(runtime.repositories.projects, "findById").mockResolvedValue({
      ok: false,
      error: failure,
    });

    renderPage(runtime, projectId);

    const supportNotice = await screen.findByText(/支持编号：UI-/u);
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(supportNotice.textContent)?.[0];
    if (supportId === undefined) throw new Error("检查页没有生成支持编号。");
    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ diagnosticId }) => diagnosticId === supportId,
    );
    expect(incident).toMatchObject({
      componentName: "ProjectChecksPage",
      phase: "data_read",
      errorBoundaryTriggered: false,
      readStage: "project",
      triggerIds: { projectId, chapterId: null, candidateId: null },
    });
    expect(incident?.applicationStack.length).toBeGreaterThan(0);
    expect(incident?.reactComponentStack).toContain("at ProjectChecksPage");
    expect(incident?.reasonCodeChain).toEqual(
      expect.arrayContaining(["PROJECT_AREA_READ_FAILED", "REPOSITORY_ERROR"]),
    );
    expect(JSON.stringify(incident)).not.toContain(sensitive);
    expect(JSON.stringify(window.localStorage)).not.toContain(sensitive);
    forgetUiRouteDiagnosticsMemoryForTests(runtime);
    expect(readSafeUiRouteIncidents(runtime)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticId: supportId,
          componentName: "ProjectChecksPage",
          readStage: "project",
        }),
      ]),
    );
  });

  it("keeps chapters from the newest project when an earlier chapter read finishes last", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = unwrap(
      await runtime.useCases.createProject.execute({ name: "先前检查项目" }),
    );
    const currentProject = unwrap(
      await runtime.useCases.createProject.execute({ name: "当前检查项目" }),
    );
    const firstChapter = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: firstProject.id,
        title: "先前章节",
        content: "先前正文。",
      }),
    );
    const currentChapter = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: currentProject.id,
        title: "当前章节",
        content: "当前正文。",
      }),
    );
    const originalListByProjectId = runtime.repositories.chapters.listByProjectId.bind(
      runtime.repositories.chapters,
    );
    const delayedRead = deferred<Awaited<ReturnType<typeof originalListByProjectId>>>();
    let heldFirstRead = false;
    const listByProjectId = vi
      .spyOn(runtime.repositories.chapters, "listByProjectId")
      .mockImplementation((projectId) => {
        if (projectId === firstProject.id && !heldFirstRead) {
          heldFirstRead = true;
          return delayedRead.promise;
        }
        return originalListByProjectId(projectId);
      });
    const user = userEvent.setup();
    renderNavigablePage(runtime, firstProject.id, currentProject.id);

    await waitFor(() => expect(listByProjectId).toHaveBeenCalledWith(firstProject.id));
    await user.click(screen.getByRole("button", { name: "切换到当前项目" }));
    expect(await screen.findByRole("combobox", { name: "章节" })).toHaveValue(
      currentChapter.chapter.id,
    );

    delayedRead.resolve(await originalListByProjectId(firstProject.id));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "章节" })).toHaveValue(currentChapter.chapter.id),
    );
    expect(screen.getByRole("combobox", { name: "章节" })).not.toHaveValue(firstChapter.chapter.id);
  });

  it("does not apply a late check result after switching projects", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = unwrap(
      await runtime.useCases.createProject.execute({ name: "迟到检查项目" }),
    );
    const currentProject = unwrap(
      await runtime.useCases.createProject.execute({ name: "当前检查项目" }),
    );
    const firstChapter = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: firstProject.id,
        title: "迟到检查章节",
        content: "旧项目的检查内容。",
      }),
    );
    const currentChapter = unwrap(
      await runtime.useCases.createChapter.execute({
        projectId: currentProject.id,
        title: "当前检查章节",
        content: "当前项目的检查内容。",
      }),
    );
    const originalRun = runtime.story.chapterValidationSnapshots.run.bind(
      runtime.story.chapterValidationSnapshots,
    );
    const delayedRun = deferred<Awaited<ReturnType<typeof originalRun>>>();
    const run = vi
      .spyOn(runtime.story.chapterValidationSnapshots, "run")
      .mockImplementation((input, options) =>
        input.projectId === firstProject.id ? delayedRun.promise : originalRun(input, options),
      );
    const user = userEvent.setup();
    renderNavigablePage(runtime, firstProject.id, currentProject.id);

    expect(await screen.findByRole("combobox", { name: "章节" })).toHaveValue(
      firstChapter.chapter.id,
    );
    const checkButton = await screen.findByRole("button", { name: "检查本章" });
    await waitFor(() => expect(checkButton).toBeEnabled());
    await user.click(checkButton);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "切换到当前项目" }));
    expect(await screen.findByRole("combobox", { name: "章节" })).toHaveValue(
      currentChapter.chapter.id,
    );

    delayedRun.resolve(
      await originalRun(
        {
          projectId: firstProject.id,
          chapterId: firstChapter.chapter.id,
        },
        { mode: "rerun" },
      ),
    );

    await waitFor(() => expect(screen.getByText("还没有检查结果")).toBeVisible());
    expect(screen.getByRole("combobox", { name: "章节" })).toHaveValue(currentChapter.chapter.id);
    expect(screen.queryByText("迟到检查章节")).not.toBeInTheDocument();
  });

  it("does not display a supplemental disposition from another immutable version", () => {
    const previousVersionId = "019f9f4a-b3c7-7350-9226-000000000001";
    const currentVersionId = "019f9f4a-b3c7-7350-9226-000000000002";
    const sharedEvidence = {
      contentHash: "a".repeat(64),
      startOffset: 4,
      endOffset: 12,
    } as const;

    expect(
      supplementalEvidenceSignature([{ ...sharedEvidence, sourceVersionId: previousVersionId }]),
    ).not.toBe(
      supplementalEvidenceSignature([{ ...sharedEvidence, sourceVersionId: currentVersionId }]),
    );

    const finding = {
      id: "voice:stable-id",
      category: "character_voice",
      evidence: [
        {
          sourceKind: "chapter",
          sourceId: "chapter-one",
          sourceVersionId: currentVersionId,
          contentHash: sharedEvidence.contentHash,
          locator: "chapter:current:utf16:4-12",
          excerpt: "12345678",
          startOffset: sharedEvidence.startOffset,
          endOffset: sharedEvidence.endOffset,
          sourceLength: 12,
        },
      ],
    } as const satisfies SupplementalFindingDescriptor;
    const evidenceSignature = supplementalEvidenceSignature(finding.evidence);
    const historical = supplementalResolutionSummary({
      factId: "historical-resolution",
      chapterVersionId: previousVersionId,
      evidenceSignature,
    });
    const current = supplementalResolutionSummary({
      factId: "current-resolution",
      chapterVersionId: currentVersionId,
      evidenceSignature,
    });

    expect(
      findSupplementalFindingResolution([historical], finding, currentVersionId),
    ).toBeUndefined();
    expect(
      findSupplementalFindingResolution([historical, current], finding, currentVersionId),
    ).toEqual(current);
    expect(findSupplementalFindingResolution([current], finding, null)).toBeUndefined();
  });

  it("lets the user select a chapter and honestly explains a skipped check", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(false);
    const aiReview = vi.spyOn(fixture.runtime.story.ambiguousReview, "review");
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
    expect(screen.getByRole("heading", { name: "本次实际检查范围" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "因证据不足未检查（10）" })).toBeInTheDocument();
    expect(screen.getByText("普通检查不会向 AI 发送内容")).toBeInTheDocument();
    expect(screen.getByText(/使用页面上方的一致性调查/u)).toBeInTheDocument();
    expect(aiReview).not.toHaveBeenCalled();
  });

  it("keeps direct checks task-focused and hides professional investigation controls", async () => {
    window.localStorage.clear();
    seedWritingExperience("direct");
    const user = userEvent.setup();
    const fixture = await seededRuntime(true);
    renderPage(fixture.runtime, fixture.projectId);

    await user.click(await screen.findByRole("button", { name: "检查本章" }));

    expect(await screen.findByRole("heading", { name: "检查结果" })).toBeVisible();
    expect(screen.queryByText("普通检查不会调用 AI")).not.toBeInTheDocument();
    expect(screen.queryByText("一致性调查")).not.toBeInTheDocument();
    expect(screen.queryByText("高级工具")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "按设定生成修改建议" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(
      /AI|模型|调用|上下文|路由|令牌|追踪|候选|费用|待确认/u,
    );
  });

  it("shows both evidence sources and persists a reversible ignore", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(true);
    const aiReview = vi.spyOn(fixture.runtime.story.ambiguousReview, "review");
    renderPage(fixture.runtime, fixture.projectId);

    await user.click(await screen.findByRole("button", { name: "检查本章" }));
    expect(
      await screen.findByText("1 类实际运行 · 1 项待处理", {}, { timeout: 3_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "已检查（1）" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "因证据不足未检查（9）" })).toBeInTheDocument();
    const heading = await screen.findByRole("heading", { name: "人物生死冲突" });
    const issueCard = heading.closest(".ink-card");
    if (!(issueCard instanceof HTMLElement)) {
      throw new Error("Expected a rendered issue card.");
    }
    expect(within(issueCard).getByText(CURRENT_EXCERPT)).toBeInTheDocument();
    expect(within(issueCard).getByText("林遥在这一时间段仍然存活。")).toBeInTheDocument();
    expect(within(issueCard).getAllByText("查看来源")).toHaveLength(2);
    const storedChapter = unwrap(
      await fixture.runtime.repositories.chapters.findById(fixture.chapterId),
    );
    expect(storedChapter).not.toBeNull();
    expect(document.body).not.toHaveTextContent(
      storedChapter?.currentVersionId ?? "missing-version",
    );
    expect(document.body).not.toHaveTextContent(fixture.referenceFactId ?? "missing-fact");
    expect(within(issueCard).getByRole("button", { name: "忽略" })).toBeEnabled();
    expect(within(issueCard).getByRole("button", { name: "标记为允许" })).toBeEnabled();
    expect(within(issueCard).getByRole("button", { name: "用当前正文更新正式设定" })).toBeEnabled();

    await user.click(within(issueCard).getByRole("button", { name: "忽略" }));
    expect(await screen.findByText("已忽略（可以撤销）")).toBeInTheDocument();
    expect(screen.getByText(/只作用于这条问题和当前章节版本/u)).toBeInTheDocument();
    expect(screen.getByText("本版本处理记录（1）")).toBeInTheDocument();

    const undoButton = screen.getByRole("button", { name: "撤销忽略" });
    await waitFor(() => expect(undoButton).toBeEnabled());
    await user.click(undoButton);
    expect(
      await screen.findByText(/这条问题重新进入待处理状态/u, {}, { timeout: 3_000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "忽略" })).toBeEnabled());
    expect(screen.getByText("已撤销")).toBeInTheDocument();
    expect(aiReview).not.toHaveBeenCalled();
  });

  it("reopens the latest version-bound snapshot and records an explicit rerun", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(true);
    const firstRender = renderPage(fixture.runtime, fixture.projectId);

    await user.click(await screen.findByRole("button", { name: "检查本章" }));
    expect(await screen.findByText(/第 1 次检查/u)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "重新检查" })).toBeEnabled();
    firstRender.unmount();

    const reopenedRuntime = createDevelopmentRuntime(window.localStorage);
    renderPage(reopenedRuntime, fixture.projectId);
    expect(await screen.findByRole("heading", { name: "人物生死冲突" })).toBeInTheDocument();
    expect(screen.getByText(/第 1 次检查/u)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新检查" }));
    expect(await screen.findByText(/第 2 次检查/u)).toBeInTheDocument();
  });

  it("creates an isolated correction Candidate from exact evidence without changing正文", async () => {
    const user = userEvent.setup();
    const fixture = await seededRuntime(true);
    const before = unwrap(
      await fixture.runtime.repositories.chapters.findById(fixture.chapterId),
    )?.content;
    renderPage(fixture.runtime, fixture.projectId);

    await user.click(await screen.findByRole("button", { name: "检查本章" }));
    await user.click(await screen.findByRole("button", { name: "按设定生成修改建议" }));

    expect(await screen.findByRole("heading", { name: "AI 建议目的地" })).toBeInTheDocument();
    const stable = unwrap(await fixture.runtime.repositories.chapters.findById(fixture.chapterId));
    expect(stable?.content).toBe(before);
    const candidates = unwrap(
      await fixture.runtime.repositories.aiCandidates.listByChapterId(fixture.chapterId),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.toSnapshot()).toMatchObject({
      status: "ready",
      source: "polish",
      baseVersionId: stable?.currentVersionId,
    });
    expect(candidates[0]?.content).toContain("林遥在这一时间段仍然存活");
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
    expect(
      await screen.findByRole("heading", { name: "没有发现有证据支持的冲突" }),
    ).toBeInTheDocument();
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

    const disclosure = (await screen.findByText("高级工具")).closest("details");
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
    expect(screen.getByRole("heading", { name: "伏笔线索 1" })).toBeInTheDocument();
    const findingText = screen.getByText(/既未推进剧情，也未改变人物状态/u);
    const finding = findingText.closest(".chapter-check-issue");
    if (!(finding instanceof HTMLElement)) throw new Error("Expected a narrative finding card.");
    expect(within(finding).getByText("建议复核")).toBeInTheDocument();
    expect(within(finding).getByText(`“${CONTENT}”`)).toBeInTheDocument();
    expect(within(finding).getByText("修改建议")).toBeInTheDocument();
    await user.click(within(finding).getByRole("button", { name: "忽略" }));
    expect(await within(finding).findByText("已忽略")).toBeInTheDocument();
    await user.click(within(finding).getByRole("button", { name: "恢复为待处理" }));
    await waitFor(() =>
      expect(within(finding).getByRole("button", { name: "忽略" })).toBeEnabled(),
    );
    expect(screen.queryByText(/(?:质量总分|综合评分)[:：]\s*\d/u)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("plot-main");
    expect(document.body).not.toHaveTextContent("scene-one");
    expect(document.body).not.toHaveTextContent("foreshadow-key");
    expect(document.body).not.toHaveTextContent("character-hero");
    expect(document.body).not.toHaveTextContent("old-house");
    expect(document.body).not.toHaveTextContent(fixture.chapterId);
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
          <Route path="/projects/:projectId/chapters/:chapterId" element={<h1>AI 建议目的地</h1>} />
        </Routes>
      </MemoryRouter>
    </RuntimeProvider>,
  );
}

function renderNavigablePage(
  runtime: DesktopRuntime,
  firstProjectId: string,
  currentProjectId: string,
) {
  return render(
    <RuntimeProvider runtime={runtime}>
      <MemoryRouter initialEntries={[`/projects/${firstProjectId}/checks`]}>
        <RouteSwitch target={`/projects/${currentProjectId}/checks`} />
        <Routes>
          <Route path="/projects/:projectId/checks" element={<ProjectChecksPage />} />
        </Routes>
      </MemoryRouter>
    </RuntimeProvider>,
  );
}

function RouteSwitch({ target }: Readonly<{ target: string }>) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(target)}>
      切换到当前项目
    </button>
  );
}

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve } as const;
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
