import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { HistoricalChapterBackfillPlan } from "../infrastructure/historical-chapter-backfill-service";
import { ChapterSummaryPanel } from "./chapter-summary-panel";

const PROJECT_ID = "018f0f00-0000-7000-8000-000000000001";

describe("ChapterSummaryPanel historical backfill", () => {
  it("shows a read-only cost plan and requires an explicit registration action", async () => {
    const user = userEvent.setup();
    const pendingPlan = createPlan();
    const completedPlan = createPlan({
      registeredChapterCount: 4,
      willRegisterChapterCount: 0,
      willRegisterTaskCount: 0,
      missingStages: {
        search: 0,
        chapterSummary: 0,
        storyState: 0,
        causalProjection: 0,
        total: 0,
      },
      willRegisterCharacterCount: 0,
      willRegisterLocalOnlyChapterCount: 0,
      possibleRemoteProviderCallUpperBound: { chapterSummary: 0, storyState: 0, total: 0 },
      fingerprint: "sha256:complete",
    });
    const historicalBackfill = {
      plan: vi.fn().mockResolvedValueOnce(pendingPlan).mockResolvedValueOnce(completedPlan),
      register: vi.fn().mockResolvedValue({
        status: "completed",
        projectId: PROJECT_ID,
        planFingerprint: pendingPlan.fingerprint,
        attemptedTaskCount: 3,
        registeredTaskCount: 3,
        createdTaskCount: 3,
        alreadyRegisteredTaskCount: 0,
        failedTaskCount: 0,
        remainingTaskCount: 0,
        failures: [],
        modelStages: pendingPlan.modelStages,
        boundary: "current_stable_versions_only",
      }),
    };
    render(
      <ChapterSummaryPanel
        projectId={PROJECT_ID}
        service={createSummaryService()}
        continuousState={createContinuousStateService()}
        historicalBackfill={historicalBackfill}
      />,
    );

    await screen.findByText("还没有可生成摘要的章节");
    await user.click(screen.getByText("高级：补齐现有章节的摘要与设定资料"));
    expect(screen.getByText(/后台执行会再次拦截旧任务/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "生成只读计划" }));

    const planRegion = await screen.findByLabelText("现有章节回填只读计划");
    expect(within(planRegion).getByText("3 章")).toBeVisible();
    expect(within(planRegion).getByText("12,345 字符")).toBeVisible();
    expect(within(planRegion).getByText(/合计最多 6 次/)).toBeVisible();
    expect(
      within(planRegion).getByText(/本次待登记 1 个.*计入远程供应商调用上限的次数为 0/),
    ).toBeVisible();
    expect(historicalBackfill.register).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认并登记 3 个后台任务" }));
    await waitFor(() =>
      expect(historicalBackfill.register).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        expectedPlanFingerprint: pendingPlan.fingerprint,
        humanConfirmed: true,
      }),
    );
    expect(await screen.findByText("现有章节任务已登记")).toBeVisible();
    expect(screen.getByRole("button", { name: "当前无需登记" })).toBeDisabled();
  });

  it("does not offer planning or registration in a read-only workspace", async () => {
    const user = userEvent.setup();
    const historicalBackfill = {
      plan: vi.fn().mockResolvedValue(createPlan()),
      register: vi.fn(),
    };
    render(
      <ChapterSummaryPanel
        projectId={PROJECT_ID}
        service={createSummaryService()}
        continuousState={createContinuousStateService()}
        historicalBackfill={historicalBackfill}
        readOnly
      />,
    );

    await screen.findByText("还没有可生成摘要的章节");
    await user.click(screen.getByText("高级：补齐现有章节的摘要与设定资料"));
    expect(screen.getByRole("button", { name: "生成只读计划" })).toBeDisabled();
    expect(historicalBackfill.plan).not.toHaveBeenCalled();
    expect(historicalBackfill.register).not.toHaveBeenCalled();
  });

  it("reports registrations completed before a later item failed instead of claiming none", async () => {
    const user = userEvent.setup();
    const pendingPlan = createPlan({ willRegisterTaskCount: 2 });
    const historicalBackfill = {
      plan: vi
        .fn()
        .mockResolvedValueOnce(pendingPlan)
        .mockRejectedValueOnce(new Error("refresh unavailable")),
      register: vi.fn().mockResolvedValue({
        status: "partial",
        projectId: PROJECT_ID,
        planFingerprint: pendingPlan.fingerprint,
        attemptedTaskCount: 2,
        registeredTaskCount: 1,
        createdTaskCount: 1,
        alreadyRegisteredTaskCount: 0,
        failedTaskCount: 1,
        remainingTaskCount: 1,
        failures: [
          {
            chapterId: PROJECT_ID,
            versionId: PROJECT_ID,
            stage: "story_state",
            code: "HISTORICAL_BACKFILL_REGISTRATION_FAILED",
            message: "disk busy",
          },
        ],
        modelStages: pendingPlan.modelStages,
        boundary: "current_stable_versions_only",
      }),
    };
    render(
      <ChapterSummaryPanel
        projectId={PROJECT_ID}
        service={createSummaryService()}
        continuousState={createContinuousStateService()}
        historicalBackfill={historicalBackfill}
      />,
    );

    await screen.findByText("还没有可生成摘要的章节");
    await user.click(screen.getByText("高级：补齐现有章节的摘要与设定资料"));
    await user.click(screen.getByRole("button", { name: "生成只读计划" }));
    await user.click(screen.getByRole("button", { name: "确认并登记 2 个后台任务" }));

    expect(await screen.findByText("部分现有章节任务已登记")).toBeVisible();
    expect(screen.getByText(/已成功登记 1 个任务.*仍有 1 个任务未登记/)).toBeVisible();
    expect(screen.getByText(/计划刷新失败/)).toBeVisible();
    expect(screen.queryByText("现有章节任务未能登记")).not.toBeInTheDocument();
  });
});

function createSummaryService() {
  return {
    inspectProject: vi.fn().mockResolvedValue({
      automaticOnManualSaveEnabled: false,
      entries: [],
    }),
    setAutomaticOnManualSaveEnabled: vi.fn(),
    summarizeSavedVersion: vi.fn(),
    clearChapterSummary: vi.fn(),
  };
}

function createContinuousStateService() {
  return {
    inspectProject: vi.fn().mockResolvedValue({
      changes: [],
      detectedCount: 0,
      needsConfirmationCount: 0,
      reversibleCount: 0,
      historicalCount: 0,
      invalidEvidenceCount: 0,
    }),
    isAutomaticOnManualSaveEnabled: vi.fn().mockReturnValue(false),
    setAutomaticOnManualSaveEnabled: vi.fn(),
  };
}

function createPlan(
  overrides: Partial<HistoricalChapterBackfillPlan> = {},
): HistoricalChapterBackfillPlan {
  return {
    schemaVersion: "inkshadow.historical-chapter-backfill-plan.v2",
    projectId: PROJECT_ID,
    fingerprint: "sha256:pending",
    activeChapterCount: 5,
    eligibleChapterCount: 4,
    registeredChapterCount: 1,
    willRegisterChapterCount: 3,
    willRegisterTaskCount: 3,
    missingStages: {
      search: 3,
      chapterSummary: 3,
      storyState: 3,
      causalProjection: 3,
      total: 12,
    },
    eligibleCharacterCount: 20_000,
    willRegisterCharacterCount: 12_345,
    localOnlyChapterCount: 1,
    willRegisterLocalOnlyChapterCount: 1,
    excludedEmptyChapterCount: 1,
    excludedUnstableChapterCount: 0,
    modelStages: { chapterSummaryEnabled: true, storyStateEnabled: true },
    possibleRemoteProviderCallUpperBound: { chapterSummary: 2, storyState: 4, total: 6 },
    boundary: "current_stable_versions_only",
    ...overrides,
  };
}
