import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStorySettingsTemplate, serializeStorySettings } from "@inkshadow/import-export/core";
import { parseUuidV7, StoryCoreError, StoryFact } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { readSafeUiRouteIncidents } from "../infrastructure/ui-route-diagnostics";
import { DEVELOPMENT_WRITING_EXPERIENCE_KEY } from "../infrastructure/writing-experience-store";
import type {
  StorySettingsImportCommand,
  StorySettingsImportReceipt,
} from "../infrastructure/story-settings-import-service";
import { RuntimeProvider } from "../runtime-context";

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

describe("StoryGovernancePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    seedWritingExperience("professional");
  });

  it("keeps the newest project visible when an earlier project read finishes last", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = await runtime.useCases.createProject.execute({ name: "先前设定" });
    const currentProject = await runtime.useCases.createProject.execute({ name: "当前设定" });
    if (!firstProject.ok) throw firstProject.error;
    if (!currentProject.ok) throw currentProject.error;
    const originalFindById = runtime.repositories.projects.findById.bind(
      runtime.repositories.projects,
    );
    const delayedRead = deferred<Awaited<ReturnType<typeof originalFindById>>>();
    let heldFirstRead = false;
    const findById = vi
      .spyOn(runtime.repositories.projects, "findById")
      .mockImplementation((projectId) => {
        if (projectId === firstProject.value.id && !heldFirstRead) {
          heldFirstRead = true;
          return delayedRead.promise;
        }
        return originalFindById(projectId);
      });
    const user = userEvent.setup();
    renderNavigableRoute(
      runtime,
      `/projects/${firstProject.value.id}/story`,
      `/projects/${currentProject.value.id}/story`,
    );

    await waitFor(() => expect(findById).toHaveBeenCalledWith(firstProject.value.id));
    await user.click(screen.getByRole("button", { name: "切换到当前项目" }));
    expect(await screen.findByRole("heading", { name: "当前设定", level: 1 })).toBeInTheDocument();

    delayedRead.resolve(await originalFindById(firstProject.value.id));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "当前设定", level: 1 })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: "先前设定", level: 1 })).not.toBeInTheDocument();
  });

  it("keeps an unfinished bulk batch with its project during fast project navigation", async () => {
    window.localStorage.clear();
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const firstProject = await runtime.useCases.createProject.execute({ name: "甲项目批量草稿" });
    const secondProject = await runtime.useCases.createProject.execute({ name: "乙项目空白设定" });
    if (!firstProject.ok) throw firstProject.error;
    if (!secondProject.ok) throw secondProject.error;
    const user = userEvent.setup();
    renderNavigableRoute(
      runtime,
      `/projects/${firstProject.value.id}/story`,
      `/projects/${secondProject.value.id}/story`,
    );

    await screen.findByRole("heading", { name: "甲项目批量草稿", level: 1 });
    await user.click(await screen.findByRole("button", { name: "批量整理设定" }));
    const firstDrawer = screen.getByRole("dialog", { name: "批量整理设定" });
    await user.type(
      within(firstDrawer).getByRole("textbox", { name: "粘贴多条设定" }),
      "林深是调查记者。故事发生在旧城。",
    );
    await user.click(within(firstDrawer).getByRole("button", { name: "拆分为待确认项" }));
    await waitFor(async () => {
      expect(
        await runtime.authorRecovery.find(firstProject.value.id, "bulk_story_settings"),
      ).not.toBeNull();
    });
    const delayedWrite = deferred<Awaited<ReturnType<typeof runtime.authorRecovery.save>>>();
    const recoverySave = vi
      .spyOn(runtime.authorRecovery, "save")
      .mockImplementationOnce(() => delayedWrite.promise);
    await user.type(
      within(firstDrawer).getByRole("textbox", { name: "第 1 条设定内容" }),
      "（作者补充）",
    );
    await waitFor(() => expect(recoverySave).toHaveBeenCalledTimes(1));
    await user.click(within(firstDrawer).getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "切换到当前项目" }));
    await screen.findByRole("heading", { name: "乙项目空白设定", level: 1 });
    await act(async () => {
      delayedWrite.reject(new Error("甲项目恢复写入晚到失败"));
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "批量整理设定" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "继续未完成的批量整理" })).toBeNull();
    expect(screen.queryByText(/恢复记录暂不可用/u)).toBeNull();
    expect(
      await runtime.authorRecovery.find(secondProject.value.id, "bulk_story_settings"),
    ).toBeNull();
    const firstAfterFailure = await runtime.authorRecovery.find(
      firstProject.value.id,
      "bulk_story_settings",
    );
    expect(firstAfterFailure?.projectId).toBe(firstProject.value.id);
    expect(firstAfterFailure?.payloadJson).toContain("作者补充");
    recoverySave.mockRestore();
    await user.click(await screen.findByRole("button", { name: "批量整理设定" }));
    expect(
      within(screen.getByRole("dialog", { name: "批量整理设定" })).getByRole("textbox", {
        name: "粘贴多条设定",
      }),
    ).toHaveValue("");
  });

  it("shows a redacted support number when story settings authority cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "诊断设定" });
    if (!project.ok) throw project.error;
    const sensitive = "sk-private 正文 C:/Users/writer/story-settings.txt";
    vi.spyOn(runtime.story.facts, "listByProjectId").mockResolvedValue({
      ok: false,
      error: new StoryCoreError({
        code: "STORY_REPOSITORY_ERROR",
        message: sensitive,
        retryable: true,
        actions: ["RETRY"],
      }),
    });

    renderRoute(runtime, `/projects/${project.value.id}/story`);

    const notice = await screen.findByText(/问题编号：UI-.*联系支持时提供/u);
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(notice.textContent)?.[0];
    if (supportId === undefined) throw new Error("设定页没有支持编号。");
    const incident = readSafeUiRouteIncidents(runtime).find(
      ({ diagnosticId }) => diagnosticId === supportId,
    );
    expect(incident).toMatchObject({
      diagnosticId: supportId,
      componentName: "StoryGovernancePage",
      readStage: "story_governance",
    });
    expect(incident?.reasonCodeChain).toContain("REPOSITORY_ERROR");
    expect(JSON.stringify(window.localStorage)).not.toContain(sensitive);
  });

  it("keeps authoritative settings readable when an optional derived record cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "附属资料隔离项目" });
    if (!project.ok) throw project.error;
    vi.spyOn(runtime.story.legacyMemoryPromotion, "previewProject").mockResolvedValue({
      ok: false,
      error: new StoryCoreError({
        code: "STORY_REPOSITORY_ERROR",
        message: "一条旧记忆整理记录无法读取",
        retryable: true,
        actions: ["RETRY"],
      }),
    });
    vi.spyOn(runtime.story.whatIfBranches, "listByProjectId").mockResolvedValue({
      ok: false,
      error: new StoryCoreError({
        code: "STORY_REPOSITORY_ERROR",
        message: "一条旧版试演记录无法读取",
        retryable: true,
        actions: ["RETRY"],
      }),
    });
    vi.spyOn(runtime.story.extractionItems, "listByProjectId").mockResolvedValue({
      ok: false,
      error: new StoryCoreError({
        code: "STORY_REPOSITORY_ERROR",
        message: "一条待确认设定无法读取",
        retryable: true,
        actions: ["RETRY"],
      }),
    });
    vi.spyOn(runtime.story.continuousState, "inspectProject").mockRejectedValue(
      new Error("连续故事状态记录无法读取"),
    );

    renderRoute(runtime, `/projects/${project.value.id}/story`);

    expect(
      await screen.findByRole("heading", { name: "附属资料隔离项目", level: 1 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("部分附属资料暂不可用", { exact: true })).toBeVisible();
    expect(
      screen.getByText(
        /以下附属资料没有读取成功：旧记忆整理、旧版试演记录、待确认设定、连续故事状态/u,
      ),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(/假设分支|待确认提取/u);
    const supportNotice = screen.getByText(/问题编号：UI-.*联系支持时提供/u);
    const supportId = /UI-[0-9]{14}-[0-9]{3,}/u.exec(supportNotice.textContent)?.[0];
    if (supportId === undefined) throw new Error("附属资料隔离没有生成支持编号。");
    expect(readSafeUiRouteIncidents(runtime)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticId: supportId,
          componentName: "StoryGovernancePage",
          readStage: "story_governance",
          recovered: false,
        }),
      ]),
    );
  });

  it("shows only ordinary fact evidence and safe fact actions in direct mode", async () => {
    window.localStorage.clear();
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "灯塔手记" });
    if (!project.ok) throw project.error;
    const parsedProjectId = parseUuidV7(project.value.id);
    if (!parsedProjectId.ok) throw parsedProjectId.error;
    const localEvidence = "周望五十七岁。";
    const sourceChapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "钟楼旧事",
      content: localEvidence,
    });
    if (!sourceChapter.ok) throw sourceChapter.error;
    const created = await runtime.story.factService.createFormalUserFact({
      projectId: parsedProjectId.value,
      factType: "world_rule",
      contentText: "灯塔 每晚只能亮一次。",
      actorId: runtime.story.actorId,
      lock: false,
      humanConfirmed: true,
    });
    if (!created.ok) throw created.error;
    const unconfirmed = await runtime.story.factService.stageAutomaticFact({
      projectId: parsedProjectId.value,
      factType: "world_rule",
      contentText: "这条待确认内容不能出现在直接模式。",
      source: {
        kind: "system_derivation",
        reference: "direct-mode-test:unconfirmed",
      },
      confidence: 0.7,
      origin: "ai_extraction",
    });
    if (!unconfirmed.ok) throw unconfirmed.error;
    const temporary = await runtime.story.factService.stageAutomaticFact({
      projectId: parsedProjectId.value,
      factType: "character_state",
      contentText: "这条试写资料不能出现在直接模式。",
      source: {
        kind: "system_derivation",
        reference: "direct-mode-test:temporary",
      },
      confidence: 1,
      origin: "system",
    });
    if (!temporary.ok) throw temporary.error;
    const localDraft = await runtime.story.factService.stageAutomaticFact({
      projectId: parsedProjectId.value,
      factType: "character_profile",
      contentText: localEvidence,
      structuredValue: {
        schemaVersion: "inkshadow.rebuildable-system-fact.v1",
        payload: { schemaVersion: "inkshadow.direct-local-story-fact.v1" },
      },
      source: {
        kind: "chapter_span",
        reference: "direct-local:inkshadow.direct-local-story-fact.v1:test",
        chapterId: sourceChapter.value.chapter.id,
        versionId: sourceChapter.value.chapter.currentVersionId,
        startOffset: 0,
        endOffset: localEvidence.length,
        sourceLength: localEvidence.length,
        excerpt: localEvidence,
      },
      confidence: 1,
      origin: "system",
      requireHumanReview: true,
    });
    if (!localDraft.ok) throw localDraft.error;
    const user = userEvent.setup();
    const view = renderRoute(runtime, "/projects/" + project.value.id + "/story");

    const currentSectionBefore = (
      await screen.findByRole("heading", { name: "当前设定", level: 2 })
    ).closest("section");
    if (!(currentSectionBefore instanceof HTMLElement)) {
      throw new Error("找不到当前设定区域。");
    }
    expect(within(currentSectionBefore).getByText("灯塔 每晚只能亮一次。")).toBeVisible();
    expect(within(currentSectionBefore).getByText("查看原文依据")).toBeVisible();
    const storyMain = screen.getByRole("main", { name: "设定" });
    expect(storyMain).not.toHaveTextContent(/AI|模型|调用|上下文|路由|令牌|追踪|候选|费用/u);
    expect(screen.queryByText("这条待确认内容不能出现在直接模式。")).toBeNull();
    expect(screen.queryByText("这条试写资料不能出现在直接模式。")).toBeNull();
    const pendingSection = screen
      .getByRole("heading", { name: "待确认设定", level: 2 })
      .closest("section");
    if (!(pendingSection instanceof HTMLElement)) throw new Error("找不到待确认设定区域。");
    expect(within(pendingSection).getAllByText(localEvidence)).toHaveLength(1);
    const pendingEvidenceButton = within(pendingSection).getByRole("button", {
      name: "查看原文依据",
    });
    expect(pendingEvidenceButton.tagName).toBe("BUTTON");
    expect(pendingEvidenceButton).toHaveAttribute("aria-expanded", "false");
    const pendingEvidenceRegionId = pendingEvidenceButton.getAttribute("aria-controls");
    expect(pendingEvidenceRegionId).toBeTruthy();
    expect(document.getElementById(pendingEvidenceRegionId ?? "")).toBeNull();

    await user.click(pendingEvidenceButton);
    expect(pendingEvidenceButton).toHaveAttribute("aria-expanded", "true");
    expect(pendingEvidenceButton).toHaveAccessibleName("收起原文依据");
    expect(pendingEvidenceButton).toHaveFocus();
    const pendingEvidenceRegion = within(pendingSection).getByRole("region", {
      name: "原文依据",
    });
    expect(pendingEvidenceRegion).toHaveAttribute("id", pendingEvidenceRegionId);
    expect(pendingEvidenceRegion).toHaveAttribute("aria-label", "原文依据");
    expect(within(pendingSection).getAllByText(localEvidence)).toHaveLength(2);
    expect(within(pendingSection).getByText("来源章节")).toBeVisible();
    expect(within(pendingSection).getByText("《钟楼旧事》")).toBeVisible();
    expect(within(pendingSection).getByText("保存版本")).toBeVisible();
    expect(within(pendingSection).getByText("第 1 个不会被改动的历史版本")).toBeVisible();
    expect(pendingSection).not.toHaveTextContent(
      String(sourceChapter.value.chapter.currentVersionId),
    );
    expect(within(pendingSection).getByText("字符范围")).toBeVisible();
    expect(within(pendingSection).getByText("第 1 至 7 个字符")).toBeVisible();

    await user.keyboard("{Enter}");
    expect(pendingEvidenceButton).toHaveAttribute("aria-expanded", "false");
    expect(pendingEvidenceButton).toHaveAccessibleName("查看原文依据");
    expect(pendingEvidenceButton).toHaveFocus();
    expect(document.getElementById(pendingEvidenceRegionId ?? "")).toBeNull();
    await user.pointer([
      { keys: "[TouchA>]", target: pendingEvidenceButton },
      { keys: "[/TouchA]", target: pendingEvidenceButton },
    ]);
    expect(pendingEvidenceButton).toHaveAttribute("aria-expanded", "true");
    expect(pendingEvidenceButton).toHaveAccessibleName("收起原文依据");
    expect(pendingEvidenceButton).toHaveFocus();
    pendingEvidenceButton.blur();
    expect(pendingEvidenceButton).not.toHaveFocus();
    act(() => pendingEvidenceButton.click());
    expect(pendingEvidenceButton).toHaveAttribute("aria-expanded", "false");
    expect(pendingEvidenceButton).toHaveAccessibleName("查看原文依据");
    expect(pendingEvidenceButton).toHaveFocus();
    act(() => pendingEvidenceButton.click());
    expect(pendingEvidenceButton).toHaveAttribute("aria-expanded", "true");
    expect(pendingEvidenceButton).toHaveFocus();
    expect(within(pendingSection).getByRole("button", { name: "确认并保留" })).toBeEnabled();
    expect(within(pendingSection).getByRole("button", { name: "修改" })).toBeEnabled();
    expect(within(pendingSection).getByRole("button", { name: "放弃" })).toBeEnabled();

    await user.click(within(pendingSection).getByRole("button", { name: "修改" }));
    const pendingEditDialog = screen.getByRole("dialog", { name: "修改设定" });
    const pendingEditInput = within(pendingEditDialog).getByRole("textbox", {
      name: "设定内容",
    });
    expect(
      within(pendingEditDialog).getByText(
        "保存修改会同时确认这条内容，并把它加入正式设定；原始来源和每个旧版本都会保留。",
      ),
    ).toBeVisible();
    await user.clear(pendingEditInput);
    await user.type(pendingEditInput, "周望五十八岁。");
    await user.click(within(pendingEditDialog).getByRole("button", { name: "保存修改并确认" }));
    expect(await within(currentSectionBefore).findByText("周望五十八岁。")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "待确认设定", level: 2 })).toBeNull();
    const editedLocalDraft = await runtime.story.facts.findById(localDraft.value.fact.id);
    if (!editedLocalDraft.ok || editedLocalDraft.value === null) {
      throw new Error("找不到人工修改后的本地设定。");
    }
    expect(editedLocalDraft.value.toSnapshot()).toMatchObject({
      contentText: "周望五十八岁。",
      structuredValue: null,
      status: "formal",
      origin: "user",
      source: localDraft.value.fact.toSnapshot().source,
      revision: 2,
    });
    expect(await runtime.story.facts.listRevisions(localDraft.value.fact.id)).toMatchObject({
      ok: true,
      value: [{ fact: { revision: 1 } }, { fact: { revision: 2 } }],
    });
    const originalFactCard = within(currentSectionBefore)
      .getByText("灯塔 每晚只能亮一次。")
      .closest(".ink-card");
    if (!(originalFactCard instanceof HTMLElement)) {
      throw new Error("找不到原有设定卡片。");
    }

    const formalEvidenceButton = within(originalFactCard).getByRole("button", {
      name: "查看原文依据",
    });
    expect(formalEvidenceButton.tagName).toBe("BUTTON");
    expect(formalEvidenceButton).toHaveAttribute("aria-expanded", "false");
    formalEvidenceButton.focus();
    await user.keyboard(" ");
    expect(formalEvidenceButton).toHaveAttribute("aria-expanded", "true");
    expect(formalEvidenceButton).toHaveAccessibleName("收起原文依据");
    expect(formalEvidenceButton).toHaveFocus();
    expect(within(originalFactCard).getByRole("region", { name: "原文依据" })).toBeVisible();
    await user.pointer([
      { keys: "[TouchA>]", target: formalEvidenceButton },
      { keys: "[/TouchA]", target: formalEvidenceButton },
    ]);
    expect(formalEvidenceButton).toHaveAttribute("aria-expanded", "false");
    expect(formalEvidenceButton).toHaveAccessibleName("查看原文依据");
    expect(formalEvidenceButton).toHaveFocus();
    formalEvidenceButton.blur();
    act(() => formalEvidenceButton.click());
    expect(formalEvidenceButton).toHaveAttribute("aria-expanded", "true");
    expect(formalEvidenceButton).toHaveFocus();

    await user.click(within(originalFactCard).getByRole("button", { name: "固定" }));
    expect(await within(originalFactCard).findByRole("button", { name: "取消固定" })).toBeVisible();
    expect(within(originalFactCard).getByRole("button", { name: "修改" })).toBeDisabled();
    await user.click(within(originalFactCard).getByRole("button", { name: "取消固定" }));

    await user.click(within(originalFactCard).getByRole("button", { name: "修改" }));
    const editDialog = screen.getByRole("dialog", { name: "修改设定" });
    const editInput = within(editDialog).getByRole("textbox", { name: "设定内容" });
    await user.clear(editInput);
    await user.type(editInput, "灯塔 每晚最多亮两次。");
    await user.click(within(editDialog).getByRole("button", { name: "保存修改" }));
    expect(await screen.findByText("灯塔 每晚最多亮两次。")).toBeVisible();

    await user.click(within(originalFactCard).getByRole("button", { name: "历史版本" }));
    const historyDialog = screen.getByRole("dialog", { name: "历史版本" });
    const firstRevisionCard = within(historyDialog)
      .getByRole("heading", { name: "第 1 版" })
      .closest(".ink-card");
    if (!(firstRevisionCard instanceof HTMLElement)) throw new Error("找不到第一版设定。");
    await user.click(within(firstRevisionCard).getByRole("button", { name: "恢复这个版本" }));
    expect(await screen.findByText("灯塔 每晚只能亮一次。")).toBeVisible();

    await user.click(within(originalFactCard).getByRole("button", { name: "删除（保留记录）" }));
    const deletedSection = (
      await screen.findByRole("heading", {
        name: "已删除的设定",
        level: 2,
      })
    ).closest("section");
    if (!(deletedSection instanceof HTMLElement)) throw new Error("找不到已删除设定区域。");
    await user.click(within(deletedSection).getByRole("button", { name: "恢复" }));
    const currentSection = screen
      .getByRole("heading", { name: "当前设定", level: 2 })
      .closest("section");
    if (!(currentSection instanceof HTMLElement)) throw new Error("找不到当前设定区域。");
    expect(await within(currentSection).findByText("灯塔 每晚只能亮一次。")).toBeVisible();

    await user.click(within(currentSection).getByRole("button", { name: "添加设定" }));
    const createDialog = screen.getByRole("dialog", { name: "添加设定" });
    await user.selectOptions(
      within(createDialog).getByRole("combobox", { name: "设定类型" }),
      "world_rule",
    );
    await user.type(
      within(createDialog).getByRole("textbox", { name: "内容" }),
      "灯塔   每晚只能亮一次。",
    );
    await user.click(within(createDialog).getByRole("button", { name: "保存设定" }));

    const mergeButton = (await screen.findAllByRole("button", { name: "合并重复项" }))[0];
    if (mergeButton === undefined) throw new Error("找不到合并重复项入口。");
    await user.click(mergeButton);
    const mergeDialog = screen.getByRole("dialog", { name: "合并重复项" });
    await user.click(within(mergeDialog).getByRole("button", { name: "确认合并" }));
    await waitFor(() =>
      expect(within(currentSection).getAllByText("灯塔 每晚只能亮一次。")).toHaveLength(1),
    );

    view.unmount();
    renderRoute(runtime, "/projects/" + project.value.id + "/story");
    const reopenedCurrentSection = (
      await screen.findByRole("heading", {
        name: "当前设定",
        level: 2,
      })
    ).closest("section");
    if (!(reopenedCurrentSection instanceof HTMLElement)) {
      throw new Error("重开后找不到当前设定区域。");
    }
    expect(within(reopenedCurrentSection).getAllByText("灯塔 每晚只能亮一次。")).toHaveLength(1);
  });

  it("shows professional setup drafts and preserves explicit confirm, edit, and discard decisions", async () => {
    window.localStorage.clear();
    seedWritingExperience("professional");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const project = await runtime.useCases.createProject.execute({ name: "专业创作设定" });
    if (!project.ok) throw project.error;
    const projectId = parseUuidV7(project.value.id);
    if (!projectId.ok) throw projectId.error;
    const drafts = await Promise.all([
      runtime.story.factService.stageUserDraftFact({
        projectId: projectId.value,
        factType: "character_profile",
        contentText: "主角：林舟，沉默的转学生",
        actorId: runtime.story.actorId,
      }),
      runtime.story.factService.stageUserDraftFact({
        projectId: projectId.value,
        factType: "core_relationship",
        contentText: "人物关系：林舟与夏遥互相试探",
        structuredValue: {
          schemaVersion: "inkshadow.professional-setup-fact-draft.v1",
          sourceKind: "project_seed",
          projectSeed: {
            seedId: "professional-seed-source-test",
            revision: 1,
            journeyKind: "professional",
          },
          field: {
            fieldName: "relationships",
            inputKey: "relationships",
            origin: "professional_setup.relationships",
          },
          originalInput: "林舟与夏遥互相试探；两人都在调查旧港失踪案",
          sourceSegment: "林舟与夏遥互相试探",
          derivation: "local_deterministic_split",
        },
        actorId: runtime.story.actorId,
      }),
      runtime.story.factService.stageUserDraftFact({
        projectId: projectId.value,
        factType: "world_rule",
        contentText: "世界背景：现代临海小城",
        actorId: runtime.story.actorId,
      }),
    ]);
    for (const draft of drafts) if (!draft.ok) throw draft.error;

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    const pendingSection = (
      await screen.findByRole("heading", { name: "专业创作待确认设定", level: 2 })
    ).closest("section");
    if (!(pendingSection instanceof HTMLElement)) throw new Error("找不到待确认设定区域。");
    expect(within(pendingSection).getAllByText(/来自专业创作输入，等待你的决定/u)).toHaveLength(3);
    const characterCard = within(pendingSection)
      .getByText("主角：林舟，沉默的转学生")
      .closest(".ink-card");
    if (!(characterCard instanceof HTMLElement)) throw new Error("找不到人物待确认卡片。");
    const sourceButton = within(characterCard).getByRole("button", { name: "查看输入来源" });
    await user.click(sourceButton);
    expect(sourceButton).toHaveAttribute("aria-expanded", "true");
    expect(within(characterCard).getByText("专业创作表单")).toBeVisible();
    expect(within(characterCard).queryByText(/来源章节|保存版本|字符范围/u)).toBeNull();
    await user.click(within(characterCard).getByRole("button", { name: "确认并保留" }));
    await waitFor(() => {
      const remaining = screen
        .getByRole("heading", { name: "专业创作待确认设定", level: 2 })
        .closest("section");
      expect(remaining).not.toHaveTextContent("主角：林舟，沉默的转学生");
    });

    const pendingAfterCharacter = screen
      .getByRole("heading", { name: "专业创作待确认设定", level: 2 })
      .closest("section");
    if (!(pendingAfterCharacter instanceof HTMLElement)) {
      throw new Error("人物确认后找不到其余待确认设定。");
    }
    await waitFor(() => {
      const currentPendingSection = screen
        .getByRole("heading", { name: "专业创作待确认设定", level: 2 })
        .closest("section");
      if (!(currentPendingSection instanceof HTMLElement)) {
        throw new Error("找不到当前待确认设定区域。");
      }
      const currentRelationshipCard = within(currentPendingSection)
        .getByText("人物关系：林舟与夏遥互相试探")
        .closest(".ink-card");
      if (!(currentRelationshipCard instanceof HTMLElement)) {
        throw new Error("找不到关系待确认卡片。");
      }
      expect(within(currentRelationshipCard).getByRole("button", { name: "修改" })).toBeEnabled();
    });
    const currentPendingSection = screen
      .getByRole("heading", { name: "专业创作待确认设定", level: 2 })
      .closest("section");
    if (!(currentPendingSection instanceof HTMLElement)) {
      throw new Error("找不到当前待确认设定区域。");
    }
    const currentRelationshipCard = within(currentPendingSection)
      .getByText("人物关系：林舟与夏遥互相试探")
      .closest(".ink-card");
    if (!(currentRelationshipCard instanceof HTMLElement)) {
      throw new Error("找不到关系待确认卡片。");
    }
    await user.click(within(currentRelationshipCard).getByRole("button", { name: "修改" }));
    const editDialog = await screen.findByRole("dialog", { name: "修改设定" });
    const editInput = within(editDialog).getByRole("textbox", { name: "设定内容" });
    await user.clear(editInput);
    await user.type(editInput, "人物关系：林舟与夏遥是共同调查者");
    await user.click(within(editDialog).getByRole("button", { name: "保存修改并确认" }));
    await waitFor(() => expect(editDialog).not.toBeInTheDocument());
    await waitFor(() => {
      const remaining = screen
        .getByRole("heading", { name: "专业创作待确认设定", level: 2 })
        .closest("section");
      expect(remaining).not.toHaveTextContent("人物关系：林舟与夏遥互相试探");
    });
    await user.click(screen.getByRole("tab", { name: "世界与规则" }));
    await user.click(await screen.findByRole("button", { name: "查看全部故事事实" }));
    const formalSection = (
      await screen.findByRole("heading", { name: "当前故事设定", level: 2 })
    ).closest("section");
    if (!(formalSection instanceof HTMLElement)) throw new Error("找不到专业创建正式设定区。");
    const confirmedRelationshipCard = within(formalSection)
      .getByText("人物关系：林舟与夏遥是共同调查者")
      .closest(".ink-card");
    if (!(confirmedRelationshipCard instanceof HTMLElement)) {
      throw new Error("找不到修改确认后的专业创建设定。");
    }
    await user.click(
      within(confirmedRelationshipCard).getByRole("button", { name: "查看原文依据" }),
    );
    const professionalEvidence = within(confirmedRelationshipCard).getByRole("region", {
      name: "原文依据",
    });
    expect(within(professionalEvidence).getByText("林舟与夏遥互相试探")).toBeVisible();
    expect(
      within(professionalEvidence).getByText("林舟与夏遥互相试探；两人都在调查旧港失踪案"),
    ).toBeVisible();

    const pendingAfterRelationship = screen
      .getByRole("heading", { name: "专业创作待确认设定", level: 2 })
      .closest("section");
    if (!(pendingAfterRelationship instanceof HTMLElement)) {
      throw new Error("关系确认后找不到其余待确认设定。");
    }
    const worldCard = within(pendingAfterRelationship)
      .getByText("世界背景：现代临海小城")
      .closest(".ink-card");
    if (!(worldCard instanceof HTMLElement)) throw new Error("找不到世界待确认卡片。");
    const discardButton = within(worldCard).getByRole("button", { name: "放弃" });
    await waitFor(() => expect(discardButton).toBeEnabled());
    await user.click(discardButton);
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "专业创作待确认设定", level: 2 })).toBeNull(),
    );

    const persisted = await runtime.story.facts.listByProjectId(projectId.value);
    if (!persisted.ok) throw persisted.error;
    expect(
      persisted.value.map((fact) => ({
        status: fact.toSnapshot().status,
        content: fact.toSnapshot().contentText,
        source: fact.toSnapshot().source.kind,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          status: "formal",
          content: "主角：林舟，沉默的转学生",
          source: "user_statement",
        },
        {
          status: "formal",
          content: "人物关系：林舟与夏遥是共同调查者",
          source: "user_statement",
        },
        {
          status: "deprecated",
          content: "世界背景：现代临海小城",
          source: "user_statement",
        },
      ]),
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("shows every retained immutable正文 citation for one governed setting", async () => {
    window.localStorage.clear();
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "多处原文依据" });
    if (!project.ok) throw project.error;
    const content = "周望是钟楼管理员。后来，周望五十七岁。";
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "钟楼旧事",
      content,
    });
    if (!chapter.ok) throw chapter.error;
    const parsedProjectId = parseUuidV7(project.value.id);
    if (!parsedProjectId.ok) throw parsedProjectId.error;
    const firstExcerpt = "周望是钟楼管理员。";
    const secondExcerpt = "周望五十七岁。";
    const staged = await runtime.story.factService.stageAutomaticFact({
      projectId: parsedProjectId.value,
      factType: "character_profile",
      contentText: "周望是钟楼管理员",
      structuredValue: {
        schemaVersion: "inkshadow.rebuildable-system-fact.v1",
        payload: {
          schemaVersion: "inkshadow.direct-local-story-fact.v1",
          kind: "explicit_narrative_character_profile",
          character: "周望",
          detail: "钟楼管理员",
        },
      },
      source: {
        kind: "chapter_span",
        reference: "direct-local:inkshadow.direct-local-story-fact.v1:first",
        chapterId: chapter.value.chapter.id,
        versionId: chapter.value.chapter.currentVersionId,
        startOffset: 0,
        endOffset: firstExcerpt.length,
        sourceLength: content.length,
        excerpt: firstExcerpt,
      },
      confidence: 1,
      origin: "system",
      requireHumanReview: true,
    });
    if (!staged.ok) throw staged.error;
    if (runtime.story.facts.listEvidenceByFactId === undefined) {
      throw new Error("故事事实存储没有多证据读取能力。");
    }
    vi.spyOn(runtime.story.facts, "listEvidenceByFactId").mockResolvedValue({
      ok: true,
      value: [
        {
          factId: staged.value.fact.id,
          projectId: project.value.id,
          reference: "direct-local:inkshadow.direct-local-story-fact.v1:first",
          chapterId: chapter.value.chapter.id,
          versionId: chapter.value.chapter.currentVersionId,
          startOffset: 0,
          endOffset: firstExcerpt.length,
          sourceLength: content.length,
          excerpt: firstExcerpt,
          recordedAt: "2026-08-27T00:00:00.000Z",
        },
        {
          factId: staged.value.fact.id,
          projectId: project.value.id,
          reference: "direct-local:inkshadow.direct-local-story-fact.v1:second",
          chapterId: chapter.value.chapter.id,
          versionId: chapter.value.chapter.currentVersionId,
          startOffset: content.indexOf(secondExcerpt),
          endOffset: content.indexOf(secondExcerpt) + secondExcerpt.length,
          sourceLength: content.length,
          excerpt: secondExcerpt,
          recordedAt: "2026-08-27T00:01:00.000Z",
        },
      ],
    });

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    const pendingSection = (
      await screen.findByRole("heading", { name: "待确认设定", level: 2 })
    ).closest("section");
    if (!(pendingSection instanceof HTMLElement)) throw new Error("找不到待确认设定区域。");
    await user.click(within(pendingSection).getByRole("button", { name: "查看原文依据" }));

    const evidenceRegion = within(pendingSection).getByRole("region", { name: "原文依据" });
    expect(within(evidenceRegion).getByText("共 2 处原文依据")).toBeVisible();
    expect(within(evidenceRegion).getByText("原文依据 1")).toBeVisible();
    expect(within(evidenceRegion).getByText("原文依据 2")).toBeVisible();
    expect(within(evidenceRegion).getByText(firstExcerpt)).toBeVisible();
    expect(within(evidenceRegion).getByText(secondExcerpt)).toBeVisible();
    expect(within(evidenceRegion).getAllByText("《钟楼旧事》")).toHaveLength(2);
  });

  it("shows one auditable item for historical duplicate pending local facts", async () => {
    window.localStorage.clear();
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "历史重复设定" });
    if (!project.ok) throw project.error;
    const parsedProjectId = parseUuidV7(project.value.id);
    if (!parsedProjectId.ok) throw parsedProjectId.error;
    const content = "那是我父亲留下的坐标。";
    const sourceChapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content,
    });
    if (!sourceChapter.ok) throw sourceChapter.error;
    const reference = "direct-local:inkshadow.direct-local-story-fact.v1:historical-duplicate";
    const createHistoricalFact = () =>
      StoryFact.create({
        id: runtime.ids.next(),
        projectId: project.value.id,
        factType: "character_profile",
        contentText: content,
        structuredValue: {
          schemaVersion: "inkshadow.rebuildable-system-fact.v1",
          payload: { schemaVersion: "inkshadow.direct-local-story-fact.v1" },
        },
        source: {
          kind: "chapter_span",
          reference,
          chapterId: sourceChapter.value.chapter.id,
          versionId: sourceChapter.value.chapter.currentVersionId,
          startOffset: 0,
          endOffset: content.length,
          sourceLength: content.length,
          excerpt: content,
        },
        confidence: 1,
        status: "unconfirmed",
        origin: "system",
        needsReview: true,
        humanConfirmed: false,
        now: runtime.clock.now(),
      });
    const first = createHistoricalFact();
    const second = createHistoricalFact();
    if (!first.ok) throw first.error;
    if (!second.ok) throw second.error;
    const firstSaved = await runtime.story.facts.create(first.value);
    const secondSaved = await runtime.story.facts.create(second.value);
    if (!firstSaved.ok) throw firstSaved.error;
    if (!secondSaved.ok) throw secondSaved.error;

    renderRoute(runtime, "/projects/" + project.value.id + "/story");

    const pendingSection = (
      await screen.findByRole("heading", { name: "待确认设定", level: 2 })
    ).closest("section");
    if (!(pendingSection instanceof HTMLElement)) throw new Error("找不到待确认设定区域。");
    expect(within(pendingSection).getAllByText(content)).toHaveLength(1);
    expect(within(pendingSection).getAllByRole("button", { name: "查看原文依据" })).toHaveLength(1);
    expect(screen.getByText("已隔离重复的待确认设定", { exact: true })).toBeVisible();
    expect(screen.getByText(/1 条历史重复记录/u)).toBeVisible();
    const persisted = await runtime.story.facts.listByProjectId(parsedProjectId.value);
    if (!persisted.ok) throw persisted.error;
    expect(persisted.value).toHaveLength(2);
  });

  it.each(["确认并保留", "修改", "放弃"] as const)(
    "keeps a historical duplicate pending fact hidden after %s and reopening the page",
    async (decision) => {
      window.localStorage.clear();
      seedWritingExperience("direct");
      const runtime = createDevelopmentRuntime(window.localStorage);
      const project = await runtime.useCases.createProject.execute({
        name: `历史重复设定-${decision}`,
      });
      if (!project.ok) throw project.error;
      const parsedProjectId = parseUuidV7(project.value.id);
      if (!parsedProjectId.ok) throw parsedProjectId.error;
      const content = "周望是钟楼的管理员。";
      const editedContent = "周望担任钟楼管理员。";
      const sourceChapter = await runtime.useCases.createChapter.execute({
        projectId: project.value.id,
        title: "钟楼旧事",
        content,
      });
      if (!sourceChapter.ok) throw sourceChapter.error;
      const createHistoricalFact = () =>
        StoryFact.create({
          id: runtime.ids.next(),
          projectId: project.value.id,
          factType: "character_profile",
          contentText: content,
          structuredValue: {
            schemaVersion: "inkshadow.rebuildable-system-fact.v1",
            payload: { schemaVersion: "inkshadow.direct-local-story-fact.v1" },
          },
          source: {
            kind: "chapter_span",
            reference: "direct-local:inkshadow.direct-local-story-fact.v1:decided-duplicate",
            chapterId: sourceChapter.value.chapter.id,
            versionId: sourceChapter.value.chapter.currentVersionId,
            startOffset: 0,
            endOffset: content.length,
            sourceLength: content.length,
            excerpt: content,
          },
          confidence: 1,
          status: "unconfirmed",
          origin: "system",
          needsReview: true,
          humanConfirmed: false,
          now: runtime.clock.now(),
        });
      const first = createHistoricalFact();
      const second = createHistoricalFact();
      if (!first.ok) throw first.error;
      if (!second.ok) throw second.error;
      const firstSaved = await runtime.story.facts.create(first.value);
      const secondSaved = await runtime.story.facts.create(second.value);
      if (!firstSaved.ok) throw firstSaved.error;
      if (!secondSaved.ok) throw secondSaved.error;

      const user = userEvent.setup();
      const view = renderRoute(runtime, `/projects/${project.value.id}/story`);
      const pendingSection = (
        await screen.findByRole("heading", { name: "待确认设定", level: 2 })
      ).closest("section");
      if (!(pendingSection instanceof HTMLElement)) throw new Error("找不到待确认设定区域。");
      expect(within(pendingSection).getAllByText(content)).toHaveLength(1);

      if (decision === "修改") {
        await user.click(within(pendingSection).getByRole("button", { name: "修改" }));
        const dialog = screen.getByRole("dialog", { name: "修改设定" });
        const input = within(dialog).getByRole("textbox", { name: "设定内容" });
        await user.clear(input);
        await user.type(input, editedContent);
        await user.click(within(dialog).getByRole("button", { name: "保存修改并确认" }));
      } else {
        await user.click(within(pendingSection).getByRole("button", { name: decision }));
      }

      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: "待确认设定", level: 2 })).toBeNull(),
      );
      const decidedStatus = decision === "放弃" ? "deprecated" : "formal";
      const afterDecision = await runtime.story.facts.listByProjectId(parsedProjectId.value);
      if (!afterDecision.ok) throw afterDecision.error;
      const afterDecisionSnapshots = afterDecision.value.map((fact) => fact.toSnapshot());
      expect(afterDecisionSnapshots.filter(({ status }) => status === "unconfirmed")).toHaveLength(
        1,
      );
      const decidedSnapshots = afterDecisionSnapshots.filter(
        ({ status }) => status === decidedStatus,
      );
      expect(decidedSnapshots).toHaveLength(1);
      expect(decidedSnapshots[0]).toMatchObject({
        needsReview: false,
        revision: 2,
        userConfirmed: decision !== "放弃",
      });

      view.unmount();
      const reopenedRuntime = createDevelopmentRuntime(window.localStorage);
      renderRoute(reopenedRuntime, `/projects/${project.value.id}/story`);
      expect(
        await screen.findByRole("heading", { name: `历史重复设定-${decision}`, level: 1 }),
      ).toBeVisible();
      expect(screen.queryByRole("heading", { name: "待确认设定", level: 2 })).toBeNull();
      expect(screen.getByText("已隔离重复的待确认设定", { exact: true })).toBeVisible();
      expect(screen.getByText(/1 条历史重复记录/u)).toBeVisible();
      if (decision === "修改") {
        expect(screen.getByText(editedContent)).toBeVisible();
        expect(screen.queryByText(content)).toBeNull();
      } else if (decision === "确认并保留") {
        expect(screen.getAllByText(content)).toHaveLength(1);
      } else {
        expect(screen.queryByText(content)).toBeNull();
      }
    },
  );

  it("keeps structured facts out of plain-text edits and duplicate merging in direct mode", async () => {
    window.localStorage.clear();
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "潮门因果录" });
    if (!project.ok) throw project.error;
    const parsedProjectId = parseUuidV7(project.value.id);
    if (!parsedProjectId.ok) throw parsedProjectId.error;
    const first = await runtime.story.factService.createFormalUserFact({
      projectId: parsedProjectId.value,
      factType: "timeline_event",
      contentText: "银铃响起，潮门打开。",
      structuredValue: {
        schemaVersion: "inkshadow.causal-event-fact.v2",
        eventId: "event.silver-bell",
        causeEventIds: ["event.pull-rope"],
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!first.ok) throw first.error;
    const second = await runtime.story.factService.createFormalUserFact({
      projectId: parsedProjectId.value,
      factType: "timeline_event",
      contentText: "银铃响起，潮门打开。",
      structuredValue: {
        schemaVersion: "inkshadow.causal-event-fact.v2",
        eventId: "event.tide-gate",
        causeEventIds: ["event.moonset"],
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!second.ok) throw second.error;

    const user = userEvent.setup();
    renderRoute(runtime, "/projects/" + project.value.id + "/story");
    const factTexts = await screen.findAllByText("银铃响起，潮门打开。");
    expect(factTexts).toHaveLength(2);
    const factCards = factTexts.map((text) => text.closest(".ink-card"));
    if (factCards.some((card) => !(card instanceof HTMLElement))) {
      throw new Error("找不到结构化设定卡片。");
    }
    for (const card of factCards as HTMLElement[]) {
      expect(
        within(card).getByText(
          "结构化设定暂不支持直接改文字。你仍可查看原文依据、固定，或删除后恢复。",
        ),
      ).toBeVisible();
      expect(within(card).getByRole("button", { name: "修改" })).toBeDisabled();
      expect(within(card).queryByRole("button", { name: "合并重复项" })).toBeNull();
      expect(within(card).getByText("查看原文依据")).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "合并重复项" })).toBeNull();

    const firstCard = factCards[0];
    if (!(firstCard instanceof HTMLElement)) throw new Error("找不到第一条结构化设定。");
    await user.click(within(firstCard).getByRole("button", { name: "固定" }));
    expect(await within(firstCard).findByRole("button", { name: "取消固定" })).toBeVisible();
    await user.click(within(firstCard).getByRole("button", { name: "删除（保留记录）" }));
    const deletedSection = (
      await screen.findByRole("heading", { name: "已删除的设定", level: 2 })
    ).closest("section");
    if (!(deletedSection instanceof HTMLElement)) throw new Error("找不到已删除设定区域。");
    await user.click(within(deletedSection).getByRole("button", { name: "恢复" }));

    const [restoredFirst, restoredSecond] = await Promise.all([
      runtime.story.facts.findById(first.value.id),
      runtime.story.facts.findById(second.value.id),
    ]);
    if (
      !restoredFirst.ok ||
      restoredFirst.value === null ||
      !restoredSecond.ok ||
      restoredSecond.value === null
    ) {
      throw new Error("结构化设定没有完整恢复。");
    }
    const restoredSnapshots = [restoredFirst.value.toSnapshot(), restoredSecond.value.toSnapshot()];
    expect(restoredSnapshots[0]?.structuredValue).toEqual(first.value.toSnapshot().structuredValue);
    expect(restoredSnapshots[0]?.source).toEqual(first.value.toSnapshot().source);
    expect(restoredSnapshots[1]?.structuredValue).toEqual(
      second.value.toSnapshot().structuredValue,
    );
    expect(restoredSnapshots[1]?.source).toEqual(second.value.toSnapshot().source);
    expect(restoredSnapshots.map(({ revision }) => revision).sort()).toEqual([1, 4]);
    expect(restoredSnapshots.find(({ revision }) => revision === 4)).toMatchObject({
      status: "formal",
      deprecated: false,
      locked: false,
      userConfirmed: true,
    });
    expect(await screen.findAllByText("银铃响起，潮门打开。")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "合并重复项" })).toBeNull();
  });

  it("creates a visible unified story fact and keeps lock governance reversible", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "规则之海" });
    if (!project.ok) {
      throw project.error;
    }
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "规则之海", level: 1 }, { timeout: 5_000 });
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "人物",
      "世界与规则",
      "AI 记住的内容",
      "写作偏好",
    ]);
    expect(screen.getByText("还没有人物设定")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "AI 参考记录" })).not.toBeInTheDocument();
    const recognitionButton = screen.getByRole("button", {
      name: "重新识别最近一章（暂不可用）",
    });
    expect(recognitionButton).toBeVisible();
    expect(recognitionButton).toBeDisabled();
    expect(screen.getByText("逐章云端识别暂不可用")).toBeVisible();
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

  it("does not render raw structured values when a fact has no display text", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "结构化设定" });
    if (!project.ok) throw project.error;
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "雾港的钟声响了三次。",
    });
    if (!chapter.ok) throw chapter.error;
    const rawSchemaMarker = "RAW_STRUCTURED_SCHEMA_MUST_NOT_RENDER";
    const staged = await runtime.story.factService.stageAutomaticFact({
      projectId: project.value.id,
      factType: "world_setting",
      contentText: null,
      structuredValue: {
        schemaVersion: rawSchemaMarker,
        internalSourceId: "019f9f4a-b3c7-7350-9226-raw-source",
      },
      source: {
        kind: "chapter_span",
        reference: `chapter:${chapter.value.chapter.id}:structured-only`,
        chapterId: chapter.value.chapter.id,
        versionId: chapter.value.chapter.currentVersionId,
        startOffset: 0,
        endOffset: chapter.value.chapter.content.length,
        sourceLength: chapter.value.chapter.content.length,
        excerpt: chapter.value.chapter.content,
      },
      confidence: 0.8,
      origin: "ai_extraction",
    });
    if (!staged.ok) throw staged.error;
    const rawLegacyRecordKey = "world-rule.raw-internal-record-key-must-not-render";
    const legacyRecord = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "world_rule",
      recordKey: rawLegacyRecordKey,
      value: {
        schemaVersion: rawSchemaMarker,
        internalSourceId: "019f9f4a-b3c7-7350-9226-raw-formal-source",
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!legacyRecord.ok) throw legacyRecord.error;

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    await screen.findByRole("heading", { name: "结构化设定", level: 1 });
    await user.click(screen.getByRole("tab", { name: "世界与规则" }));
    await user.click(await screen.findByRole("button", { name: "查看全部故事事实" }));

    expect(
      await screen.findAllByText("这条设定已按结构化字段保存；当前没有可显示的文字说明。"),
    ).not.toHaveLength(0);
    expect(document.body).not.toHaveTextContent(rawSchemaMarker);
    expect(document.body).not.toHaveTextContent(rawLegacyRecordKey);
    expect(document.body).not.toHaveTextContent(chapter.value.chapter.currentVersionId);
    expect(
      screen.getAllByText(
        "这条较早保存的设定暂时无法完整显示，原始内容仍已保留。请使用“整理这条设定”补充名称和说明。",
      ).length,
    ).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent(/旧结构化设定|内部字段|人工表单/u);
    await user.click(screen.getByRole("button", { name: "返回世界与规则" }));
    await user.click(screen.getByRole("button", { name: "版本化正式记录" }));
    expect(screen.getByRole("button", { name: "整理这条设定" })).toBeVisible();
  });

  it("persists a human-confirmed formal record and governed memory", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerDispatch = vi.spyOn(runtime.modelGateway, "generate");
    const invocationStart = vi.spyOn(runtime.modelHub, "startInvocation");
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
    expect(memoryDetail).not.toHaveTextContent(runtime.story.actorId);
    expect(within(memoryDetail).getByText("用户规则")).toBeVisible();
    expect(within(memoryDetail).getByText("启用")).toBeVisible();
    expect(
      within(memoryDetail).getByText("这条记忆只保存了来源对象和版本，没有可显示的精确原文证据。"),
    ).toBeVisible();
    await user.click(within(memoryDetail).getByRole("button", { name: "保留为设定" }));
    const promotionDialog = screen.getByRole("dialog", { name: "保留为正式设定" });
    expect(within(promotionDialog).getByText("尚未转换")).toBeVisible();
    expect(within(promotionDialog).getByText("叙事保持克制，不提前解释伏笔。")).toBeVisible();
    const storyProjectId = parseUuidV7(project.value.id);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const beforeConfirmation = await runtime.story.facts.listByProjectId(storyProjectId.value);
    if (!beforeConfirmation.ok) throw beforeConfirmation.error;
    expect(beforeConfirmation.value).toHaveLength(0);
    await user.click(within(promotionDialog).getByRole("button", { name: "确认保留为正式设定" }));
    expect(await within(promotionDialog).findByText("已转换")).toBeVisible();
    await user.click(within(promotionDialog).getByRole("button", { name: "完成" }));
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(invocationStart).not.toHaveBeenCalled();

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
    const keptSnapshots = keptFacts.value.map((fact) => fact.toSnapshot());
    expect(keptSnapshots).toMatchObject([
      {
        factType: "memory",
        contentText: "叙事保持克制，不提前解释伏笔。",
        source: {
          kind: "legacy_record",
        },
        status: "formal",
        origin: "legacy",
        userConfirmed: true,
        revision: 2,
      },
    ]);
    expect(keptSnapshots[0]?.source.reference).toMatch(/legacy:story_memory_records:.*:r2/u);
    expect(
      await reopened.story.legacyMemoryPromotion.previewProject(storyProjectId.value),
    ).toMatchObject({ ok: true, value: [{ status: "duplicate", canConfirm: false }] });
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
    const characterDetailButton = within(characterCard).getByRole("button", {
      name: "查看人物详情",
    });
    expect(characterDetailButton.tagName).toBe("BUTTON");
    expect(characterDetailButton).toHaveAttribute("aria-expanded", "false");
    const characterDetailId = characterDetailButton.getAttribute("aria-controls");
    expect(characterDetailId).toBeTruthy();

    await user.click(characterDetailButton);

    let detail = screen.getByRole("dialog", { name: "林舟" });
    expect(characterDetailButton).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(characterDetailId ?? "")).toBeInTheDocument();
    expect(within(detail).getByText("雨夜相认")).toBeVisible();
    expect(within(detail).getByText(evidence)).toBeVisible();
    expect(within(detail).getAllByText("需要确认").length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(detail).not.toBeInTheDocument());
    expect(characterDetailButton).toHaveAttribute("aria-expanded", "false");
    expect(characterDetailButton).toHaveFocus();

    await user.keyboard("{Enter}");
    detail = screen.getByRole("dialog", { name: "林舟" });
    const closeButton = within(detail).getAllByRole("button", { name: "关闭" }).at(-1);
    expect(closeButton).toBeDefined();
    if (closeButton === undefined) throw new Error("expected the detail close button");
    await user.click(closeButton);
    await waitFor(() => expect(detail).not.toBeInTheDocument());
    expect(characterDetailButton).toHaveFocus();

    await user.keyboard(" ");
    detail = screen.getByRole("dialog", { name: "林舟" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(detail).not.toBeInTheDocument());
    await user.pointer([
      { keys: "[TouchA>]", target: characterDetailButton },
      { keys: "[/TouchA]", target: characterDetailButton },
    ]);
    detail = screen.getByRole("dialog", { name: "林舟" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(detail).not.toBeInTheDocument());

    characterDetailButton.blur();
    act(() => characterDetailButton.click());
    detail = screen.getByRole("dialog", { name: "林舟" });
    expect(characterDetailButton).toHaveFocus();
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

  it("reads a legacy structured character completely and preserves extension fields when edited", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "旧人物兼容测试" });
    if (!project.ok) throw project.error;
    const formalRecord = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "character.linshen.legacy",
      value: {
        schemaVersion: "inkshadow.character.v2",
        name: "林深",
        aliases: ["深哥", "守潮人"],
        role: "主角",
        traits: ["沉稳", "敏锐"],
        description: "守望潮汐与旧城。",
        knownInformation: ["煤球会说话", "潮门会在午夜开启"],
        extension: { source: "legacy-import", retained: true },
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!formalRecord.ok) throw formalRecord.error;

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    const heading = await screen.findByRole("heading", { name: "林深", level: 3 });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("找不到旧人物卡片。");
    expect(within(card).getByText("别名：深哥、守潮人")).toBeVisible();
    expect(card).toHaveTextContent("角色：主角");
    expect(card).toHaveTextContent("守望潮汐与旧城。");
    expect(card).toHaveTextContent("特质：沉稳、敏锐");
    expect(card).toHaveTextContent("已知信息：煤球会说话、潮门会在午夜开启");

    await user.click(within(card).getByRole("button", { name: "查看人物详情" }));
    const detail = screen.getByRole("dialog", { name: "林深" });
    await user.click(within(detail).getByRole("button", { name: "编辑正式记录" }));
    const editor = screen.getByRole("dialog", { name: "编辑正式设定" });
    const name = within(editor).getByRole("textbox", { name: "名称" });
    const description = within(editor).getByRole("textbox", { name: "正式描述" });
    expect(name).toHaveValue("林深");
    expect(description).toHaveValue("守望潮汐与旧城。");
    await user.clear(name);
    await user.type(name, "林深舟");
    await user.clear(description);
    await user.type(description, "守望潮汐与旧城，并记录每次潮门开启。");
    await user.click(within(editor).getByRole("button", { name: "确认写入正式设定" }));

    const stored = await runtime.story.formalRecords.findById(formalRecord.value.id);
    if (!stored.ok || stored.value === null) throw new Error("编辑后的旧人物没有保存。");
    expect(stored.value.currentValue).toEqual({
      schemaVersion: "inkshadow.character.v2",
      name: "林深舟",
      aliases: ["深哥", "守潮人"],
      role: "主角",
      traits: ["沉稳", "敏锐"],
      description: "守望潮汐与旧城，并记录每次潮门开启。",
      knownInformation: ["煤球会说话", "潮门会在午夜开启"],
      extension: { source: "legacy-import", retained: true },
    });
  });

  it("reads and edits nested legacy character profiles without replacing their original shape", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "嵌套旧人物兼容测试" });
    if (!project.ok) throw project.error;
    const formalRecord = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "character.shenyan.legacy-profile",
      value: {
        schemaVersion: "inkshadow.character.v1",
        profile: {
          name: "沈砚",
          aliases: ["阿砚", "旧港记录员"],
          identity: "潮汐档案保管人",
          role: "主要人物",
          traits: ["谨慎", "执着"],
          description: "负责保管旧港失踪案卷宗。",
          knownInformation: ["潮门开启时间", "失踪案编号"],
          legacyProfileExtension: { color: "blue" },
        },
        extension: { source: "v0.2.3-upgrade", retained: true },
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!formalRecord.ok) throw formalRecord.error;

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    const heading = await screen.findByRole("heading", { name: "沈砚", level: 3 });
    const card = heading.closest(".ink-card");
    if (!(card instanceof HTMLElement)) throw new Error("找不到嵌套旧人物卡片。");
    expect(card).toHaveTextContent("别名：阿砚、旧港记录员");
    expect(card).toHaveTextContent("身份：潮汐档案保管人");
    expect(card).toHaveTextContent("角色：主要人物");
    expect(card).toHaveTextContent("特质：谨慎、执着");
    expect(card).toHaveTextContent("已知信息：潮门开启时间、失踪案编号");

    await user.click(within(card).getByRole("button", { name: "查看人物详情" }));
    const detail = screen.getByRole("dialog", { name: "沈砚" });
    await user.click(within(detail).getByRole("button", { name: "编辑正式记录" }));
    const editor = screen.getByRole("dialog", { name: "编辑正式设定" });
    const name = within(editor).getByRole("textbox", { name: "名称" });
    const description = within(editor).getByRole("textbox", { name: "正式描述" });
    await user.clear(name);
    await user.type(name, "沈砚舟");
    await user.clear(description);
    await user.type(description, "负责保管旧港全部失踪案卷宗。");
    await user.click(within(editor).getByRole("button", { name: "确认写入正式设定" }));

    const stored = await runtime.story.formalRecords.findById(formalRecord.value.id);
    if (!stored.ok || stored.value === null) throw new Error("嵌套旧人物编辑结果没有保存。");
    expect(stored.value.currentValue).toEqual({
      schemaVersion: "inkshadow.character.v1",
      profile: {
        name: "沈砚舟",
        aliases: ["阿砚", "旧港记录员"],
        identity: "潮汐档案保管人",
        role: "主要人物",
        traits: ["谨慎", "执着"],
        description: "负责保管旧港全部失踪案卷宗。",
        knownInformation: ["潮门开启时间", "失踪案编号"],
        legacyProfileExtension: { color: "blue" },
      },
      extension: { source: "v0.2.3-upgrade", retained: true },
    });
  });

  it("reads and safely edits minimal structured characters without materializing display summaries", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "最小旧人物兼容" });
    if (!project.ok) throw project.error;
    const roleOnly = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "character.zhou-wang.minimal",
      value: { name: "周望", role: "钟楼管理员" },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!roleOnly.ok) throw roleOnly.error;
    const hiddenExtensionMarker = "MINIMAL_CHARACTER_EXTENSION_MUST_NOT_RENDER";
    const extensionOnly = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "character.zhao-bo.minimal",
      value: {
        name: "赵伯",
        extension: { internalMarker: hiddenExtensionMarker, retained: true },
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!extensionOnly.ok) throw extensionOnly.error;

    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);
    const roleHeading = await screen.findByRole("heading", { name: "周望", level: 3 });
    const roleCard = roleHeading.closest(".ink-card");
    if (!(roleCard instanceof HTMLElement)) throw new Error("找不到最小角色人物卡片。");
    expect(within(roleCard).getByText("角色：钟楼管理员")).toBeVisible();
    const extensionHeading = screen.getByRole("heading", { name: "赵伯", level: 3 });
    const extensionCard = extensionHeading.closest(".ink-card");
    if (!(extensionCard instanceof HTMLElement)) throw new Error("找不到扩展字段人物卡片。");
    expect(
      within(extensionCard).getByText("这条人物设定已按结构化字段保存，尚未补充可显示的说明。"),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(hiddenExtensionMarker);
    expect(document.body).not.toHaveTextContent("[object Object]");

    await user.click(within(roleCard).getByRole("button", { name: "查看人物详情" }));
    const roleDetail = screen.getByRole("dialog", { name: "周望" });
    await user.click(within(roleDetail).getByRole("button", { name: "编辑正式记录" }));
    const roleEditor = screen.getByRole("dialog", { name: "编辑正式设定" });
    expect(within(roleEditor).getByRole("textbox", { name: "名称" })).toHaveValue("周望");
    const roleDescription = within(roleEditor).getByRole("textbox", { name: "正式描述" });
    expect(roleDescription).toHaveValue("");
    expect(within(roleEditor).getByRole("button", { name: "确认写入正式设定" })).toBeDisabled();
    await user.type(roleDescription, "守护旧城钟楼。");
    await user.click(within(roleEditor).getByRole("button", { name: "确认写入正式设定" }));

    const storedRole = await runtime.story.formalRecords.findById(roleOnly.value.id);
    if (!storedRole.ok || storedRole.value === null) throw new Error("最小角色人物没有保存。");
    expect(storedRole.value.currentValue).toEqual({
      name: "周望",
      role: "钟楼管理员",
      description: "守护旧城钟楼。",
    });

    const refreshedRoleDetail = await screen.findByRole("dialog", { name: "周望" });
    const closeRoleDetail = within(refreshedRoleDetail)
      .getAllByRole("button", { name: "关闭" })
      .at(-1);
    if (closeRoleDetail === undefined) throw new Error("找不到最小角色人物详情关闭按钮。");
    await user.click(closeRoleDetail);
    await waitFor(() => expect(refreshedRoleDetail).not.toBeInTheDocument());

    const refreshedExtensionHeading = await screen.findByRole("heading", {
      name: "赵伯",
      level: 3,
    });
    const refreshedExtensionCard = refreshedExtensionHeading.closest(".ink-card");
    if (!(refreshedExtensionCard instanceof HTMLElement)) {
      throw new Error("更新后找不到扩展字段人物卡片。");
    }
    await user.click(within(refreshedExtensionCard).getByRole("button", { name: "查看人物详情" }));
    const extensionDetail = screen.getByRole("dialog", { name: "赵伯" });
    await user.click(within(extensionDetail).getByRole("button", { name: "编辑正式记录" }));
    const extensionEditor = screen.getByRole("dialog", { name: "编辑正式设定" });
    expect(within(extensionEditor).getByRole("textbox", { name: "名称" })).toHaveValue("赵伯");
    const extensionDescription = within(extensionEditor).getByRole("textbox", {
      name: "正式描述",
    });
    expect(extensionDescription).toHaveValue("");
    await user.type(extensionDescription, "住在钟楼旁，熟悉旧城街巷。");
    await user.click(within(extensionEditor).getByRole("button", { name: "确认写入正式设定" }));

    const storedExtension = await runtime.story.formalRecords.findById(extensionOnly.value.id);
    if (!storedExtension.ok || storedExtension.value === null) {
      throw new Error("扩展字段人物没有保存。");
    }
    expect(storedExtension.value.currentValue).toEqual({
      name: "赵伯",
      description: "住在钟楼旁，熟悉旧城街巷。",
      extension: { internalMarker: hiddenExtensionMarker, retained: true },
    });
    expect(document.body).not.toHaveTextContent(hiddenExtensionMarker);
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
    expect(screen.getByRole("button", { name: "故事关联" })).toBeVisible();
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

    await user.click(screen.getByRole("button", { name: "前往故事关联" }));
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
  it("retires legacy save-triggered model preferences and keeps cloud recognition unavailable", async () => {
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
    expect(screen.getByText("逐章云端识别暂不可用")).toBeVisible();
    expect(screen.queryByText(/完整正文.*最多两次模型服务调用/u)).not.toBeInTheDocument();
    const explanationToggle = screen.getByRole("button", { name: "查看停用原因" });
    expect(explanationToggle).toHaveAttribute("aria-expanded", "false");
    const explanationId = explanationToggle.getAttribute("aria-controls");
    expect(explanationId).toBeTruthy();
    explanationToggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "收起停用原因" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(document.getElementById(explanationId ?? "")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "停用原因" })).toHaveTextContent(
      /完整正文.*最多两次模型服务调用/u,
    );
    expect(screen.getByRole("button", { name: "收起停用原因" })).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "查看停用原因" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("region", { name: "停用原因" })).not.toBeInTheDocument();
    expect(runtime.story.continuousState.isAutomaticOnManualSaveEnabled(project.value.id)).toBe(
      false,
    );
    expect(runtime.story.chapterSummaries.isAutomaticOnManualSaveEnabled(project.value.id)).toBe(
      false,
    );
  });

  it("turns ordinary language into a two-ended candidate without silently saving suggestions", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "白话设定测试" });
    if (!project.ok) throw project.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "白话设定测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "用一句话添加设定" }));
    const dialog = screen.getByRole("dialog", { name: "用一句话添加设定" });
    await user.type(
      within(dialog).getByRole("textbox", { name: /^描述人物、关系或规则/u }),
      "顾顾和丹丹是情侣关系，在初中就认识了。",
    );
    await user.click(within(dialog).getByRole("button", { name: "整理为待确认设定" }));

    expect(within(dialog).getByRole("heading", { name: "待确认的结构化设定" })).toBeVisible();
    expect(within(dialog).getByText("顾顾")).toBeVisible();
    expect(within(dialog).getByText("丹丹")).toBeVisible();
    expect(within(dialog).getByText("情侣")).toBeVisible();
    expect(within(dialog).getByText("初中")).toBeVisible();
    expect(within(dialog).getByText("本地整理建议（不会自动写入）")).toBeVisible();
    expect(
      within(dialog).queryByText(/guided_opening|fromCharacterRef|toCharacterRef/u),
    ).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "确认并保存" }));
    expect(await screen.findByText("当前预览环境不写入本地数据库")).toBeVisible();
    const records = await runtime.story.formalRecords.listByProjectId(
      parseStoryProjectId(project.value.id),
    );
    if (!records.ok) throw records.error;
    expect(records.value).toHaveLength(0);
  });

  it("stages a locally parsed batch with editable evidence-bound drafts and no model call", async () => {
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerDispatch = vi.spyOn(runtime.modelGateway, "generate");
    const invocationStart = vi.spyOn(runtime.modelHub, "startInvocation");
    const stageDraft = vi.spyOn(runtime.story.factService, "stageUserDraftFact");
    const project = await runtime.useCases.createProject.execute({ name: "批量设定闭环" });
    if (!project.ok) throw project.error;
    const source =
      "林深是调查记者。林深和煤球是互相信任的搭档。故事发生在常年停电的旧城。雾里的回声令人不安。写作时避免全知视角。";
    const sourceSentences = [
      "林深是调查记者。",
      "林深和煤球是互相信任的搭档。",
      "故事发生在常年停电的旧城。",
      "雾里的回声令人不安。",
      "写作时避免全知视角。",
    ] as const;
    const user = userEvent.setup();
    const view = renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "批量设定闭环", level: 1 });
    await user.click(await screen.findByRole("button", { name: "批量整理设定" }));
    const drawer = screen.getByRole("dialog", { name: "批量整理设定" });
    await user.type(within(drawer).getByRole("textbox", { name: "粘贴多条设定" }), source);
    await user.click(within(drawer).getByRole("button", { name: "拆分为待确认项" }));

    const draftGroups = within(drawer).getAllByRole("group", { name: /第 \d+ 条设定/u });
    expect(draftGroups).toHaveLength(5);
    const [firstDraft, secondDraft, thirdDraft, fourthDraft, fifthDraft] = draftGroups;
    if (
      firstDraft === undefined ||
      secondDraft === undefined ||
      thirdDraft === undefined ||
      fourthDraft === undefined ||
      fifthDraft === undefined
    ) {
      throw new Error("批量设定没有完整拆分为五条审阅项。");
    }
    expect(
      within(firstDraft).getByText(sourceSentences[0], { selector: "blockquote" }),
    ).toBeVisible();
    expect(
      within(firstDraft).getByText(`原文位置：第 1 至 ${String(sourceSentences[0].length)} 个字符`),
    ).toBeVisible();
    expect(within(firstDraft).getByRole("combobox", { name: "第 1 条设定类型" })).toHaveValue(
      "character_identity",
    );
    expect(within(secondDraft).getByRole("combobox", { name: "第 2 条设定类型" })).toHaveValue(
      "relationship",
    );
    expect(within(thirdDraft).getByRole("combobox", { name: "第 3 条设定类型" })).toHaveValue(
      "location",
    );
    const unknownType = within(fourthDraft).getByRole("combobox", {
      name: "第 4 条设定类型",
    });
    expect(unknownType).toHaveValue("");
    expect(within(fourthDraft).getByText("需要选择设定类型")).toBeVisible();
    const save = within(drawer).getByRole("button", { name: "保存为待确认设定" });
    expect(save).toBeDisabled();

    const relationshipContent = within(secondDraft).getByRole("textbox", {
      name: "第 2 条设定内容",
    });
    await user.clear(relationshipContent);
    await user.type(relationshipContent, "林深与煤球是彼此托付秘密的搭档。");
    await user.selectOptions(unknownType, "world_rule");
    await user.click(within(fifthDraft).getByRole("button", { name: "放弃第 5 条" }));
    expect(within(fifthDraft).getByText("本次不保存")).toBeVisible();
    expect(save).toBeEnabled();
    await user.click(save);

    expect(await screen.findByText("4 条设定已保存为待确认内容")).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "批量整理设定" })).not.toBeInTheDocument(),
    );
    const facts = await runtime.story.facts.listByProjectId(parseStoryProjectId(project.value.id));
    if (!facts.ok) throw facts.error;
    const snapshots = facts.value.map((fact) => fact.toSnapshot());
    expect(stageDraft).toHaveBeenCalledTimes(4);
    expect(snapshots).toHaveLength(4);
    expect(
      snapshots.every(
        ({ status, needsReview, userConfirmed, locked }) =>
          status === "unconfirmed" && needsReview && !userConfirmed && !locked,
      ),
    ).toBe(true);
    expect(snapshots.map(({ factType }) => factType).sort()).toEqual(
      ["character_identity", "relationship", "location", "world_rule"].sort(),
    );
    expect(snapshots.map(({ contentText }) => contentText).sort()).toEqual(
      [
        sourceSentences[0],
        "林深与煤球是彼此托付秘密的搭档。",
        sourceSentences[2],
        sourceSentences[3],
      ].sort(),
    );
    const identitySnapshot = snapshots.find(
      ({ contentText }) => contentText === sourceSentences[0],
    );
    expect(identitySnapshot?.structuredValue).toMatchObject({
      schemaVersion: "inkshadow.local-bulk-setting-draft.v1",
      sourceKind: "local_text",
      sourceText: sourceSentences[0],
      sourceRange: {
        startOffset: 0,
        endOffset: sourceSentences[0].length,
        sourceLength: source.length,
        unit: "utf16_code_unit",
      },
      originalCategory: "character_identity",
      selectedCategory: "character_identity",
    });
    const unknownStart = source.indexOf(sourceSentences[3]);
    const unknownSnapshot = snapshots.find(({ contentText }) => contentText === sourceSentences[3]);
    expect(unknownSnapshot?.structuredValue).toMatchObject({
      sourceText: sourceSentences[3],
      sourceRange: {
        startOffset: unknownStart,
        endOffset: unknownStart + sourceSentences[3].length,
        sourceLength: source.length,
      },
      originalCategory: null,
      selectedCategory: "world_rule",
    });
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(invocationStart).not.toHaveBeenCalled();

    const pendingSection = (
      await screen.findByRole("heading", { name: "待确认设定", level: 2 })
    ).closest("section");
    if (!(pendingSection instanceof HTMLElement)) throw new Error("找不到批量待确认区。");
    expect(within(pendingSection).getAllByRole("button", { name: "确认并保留" })).toHaveLength(4);
    expect(within(pendingSection).getAllByRole("button", { name: "修改" })).toHaveLength(4);
    expect(within(pendingSection).getAllByRole("button", { name: "放弃" })).toHaveLength(4);
    const firstPendingCard = within(pendingSection)
      .getByText(sourceSentences[0])
      .closest(".ink-card");
    if (!(firstPendingCard instanceof HTMLElement)) throw new Error("找不到第一条批量待确认卡片。");
    await user.click(within(firstPendingCard).getByRole("button", { name: "查看原文依据" }));
    const evidence = within(firstPendingCard).getByRole("region", { name: "原文依据" });
    expect(within(evidence).getByText(sourceSentences[0])).toBeVisible();
    expect(
      within(evidence).getByText(`第 1 至 ${String(sourceSentences[0].length)} 个字符`),
    ).toBeVisible();

    await user.click(within(firstPendingCard).getByRole("button", { name: "修改" }));
    const editDialog = screen.getByRole("dialog", { name: "修改设定" });
    const editInput = within(editDialog).getByRole("textbox", { name: "设定内容" });
    await user.clear(editInput);
    await user.type(editInput, "林深是旧城调查记者。");
    await user.click(within(editDialog).getByRole("button", { name: "保存修改并确认" }));
    await waitFor(() => expect(editDialog).not.toBeInTheDocument());
    const currentSection = (
      await screen.findByRole("heading", { name: "当前设定", level: 2 })
    ).closest("section");
    if (!(currentSection instanceof HTMLElement)) throw new Error("找不到修改后的当前设定区。");
    const confirmedCard = (await within(currentSection).findByText("林深是旧城调查记者。")).closest(
      ".ink-card",
    );
    if (!(confirmedCard instanceof HTMLElement)) throw new Error("找不到修改确认后的批量设定。");
    await user.click(within(confirmedCard).getByRole("button", { name: "查看原文依据" }));
    const confirmedEvidence = within(confirmedCard).getByRole("region", { name: "原文依据" });
    expect(within(confirmedEvidence).getByText(sourceSentences[0])).toBeVisible();
    expect(
      within(confirmedEvidence).getByText(`第 1 至 ${String(sourceSentences[0].length)} 个字符`),
    ).toBeVisible();

    view.unmount();
    const reopenedRuntime = createDevelopmentRuntime(window.localStorage);
    renderRoute(reopenedRuntime, `/projects/${project.value.id}/story`);
    const reopenedCurrentSection = (
      await screen.findByRole("heading", { name: "当前设定", level: 2 })
    ).closest("section");
    if (!(reopenedCurrentSection instanceof HTMLElement)) {
      throw new Error("重开后找不到当前设定区。");
    }
    const reopenedCard = within(reopenedCurrentSection)
      .getByText("林深是旧城调查记者。")
      .closest(".ink-card");
    if (!(reopenedCard instanceof HTMLElement)) throw new Error("重开后找不到批量设定。");
    await user.click(within(reopenedCard).getByRole("button", { name: "查看原文依据" }));
    expect(within(reopenedCard).getByRole("region", { name: "原文依据" })).toHaveTextContent(
      sourceSentences[0],
    );
  });

  it("retries only the unsaved remainder after a partial local batch failure", async () => {
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerDispatch = vi.spyOn(runtime.modelGateway, "generate");
    const invocationStart = vi.spyOn(runtime.modelHub, "startInvocation");
    const originalStage = runtime.story.factService.stageUserDraftFact.bind(
      runtime.story.factService,
    );
    const stageDraft = vi
      .spyOn(runtime.story.factService, "stageUserDraftFact")
      .mockImplementation(originalStage)
      .mockImplementationOnce(originalStage)
      .mockRejectedValueOnce(new Error("测试中的第二条本地写入失败"));
    const project = await runtime.useCases.createProject.execute({ name: "批量设定安全重试" });
    if (!project.ok) throw project.error;
    const source = "林深是调查记者。故事发生在常年停电的旧城。";
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "批量设定安全重试", level: 1 });
    await user.click(await screen.findByRole("button", { name: "批量整理设定" }));
    const drawer = screen.getByRole("dialog", { name: "批量整理设定" });
    await user.type(within(drawer).getByRole("textbox", { name: "粘贴多条设定" }), source);
    await user.click(within(drawer).getByRole("button", { name: "拆分为待确认项" }));
    const save = within(drawer).getByRole("button", { name: "保存为待确认设定" });
    await user.click(save);

    expect(await within(drawer).findByText(/1 条已安全保存，其余内容仍留在这里/u)).toBeVisible();
    expect(stageDraft).toHaveBeenCalledTimes(2);
    const afterFailure = await runtime.story.facts.listByProjectId(
      parseStoryProjectId(project.value.id),
    );
    if (!afterFailure.ok) throw afterFailure.error;
    expect(afterFailure.value).toHaveLength(1);
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);

    expect(await screen.findByText("2 条设定已保存为待确认内容")).toBeVisible();
    expect(stageDraft).toHaveBeenCalledTimes(3);
    const afterRetry = await runtime.story.facts.listByProjectId(
      parseStoryProjectId(project.value.id),
    );
    if (!afterRetry.ok) throw afterRetry.error;
    expect(afterRetry.value).toHaveLength(2);
    expect(
      afterRetry.value
        .map((fact) => fact.toSnapshot())
        .every(
          ({ status, needsReview, userConfirmed }) =>
            status === "unconfirmed" && needsReview && !userConfirmed,
        ),
    ).toBe(true);
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(invocationStart).not.toHaveBeenCalled();
  });

  it("recovers one persistent bulk batch after a committed write returns an error and restart", async () => {
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "批量设定重启恢复" });
    if (!project.ok) throw project.error;
    const storyProjectId = parseStoryProjectId(project.value.id);
    const source = "林深是调查记者。故事发生在常年停电的旧城。";
    const originalStage = runtime.story.factService.stageUserDraftFact.bind(
      runtime.story.factService,
    );
    const firstStage = vi
      .spyOn(runtime.story.factService, "stageUserDraftFact")
      .mockImplementationOnce(async (command) => {
        const committed = await originalStage(command);
        if (!committed.ok) return committed;
        throw new Error("测试中的提交响应在数据库落盘后中断");
      });
    const originalList = runtime.story.facts.listByProjectId.bind(runtime.story.facts);
    const firstRender = renderRoute(runtime, `/projects/${project.value.id}/story`);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "批量设定重启恢复", level: 1 });
    await user.click(await screen.findByRole("button", { name: "批量整理设定" }));
    const drawer = screen.getByRole("dialog", { name: "批量整理设定" });
    await user.type(within(drawer).getByRole("textbox", { name: "粘贴多条设定" }), source);
    await user.click(within(drawer).getByRole("button", { name: "拆分为待确认项" }));
    const firstList = vi
      .spyOn(runtime.story.facts, "listByProjectId")
      .mockImplementationOnce(originalList)
      .mockRejectedValueOnce(new Error("测试中的提交后核对也暂时不可用"));
    await user.click(within(drawer).getByRole("button", { name: "保存为待确认设定" }));
    expect(
      await within(drawer).findByText(
        /其余内容仍留在这里|保存操作的结果暂时无法确认|没有写入任何设定/u,
      ),
    ).toBeVisible();
    expect(firstStage).toHaveBeenCalledTimes(1);
    firstList.mockRestore();
    firstStage.mockRestore();
    const committedBeforeRestart = await originalList(storyProjectId);
    if (!committedBeforeRestart.ok) throw committedBeforeRestart.error;
    expect(committedBeforeRestart.value).toHaveLength(1);

    firstRender.unmount();
    const reopenedRuntime = createDevelopmentRuntime(window.localStorage);
    const reopenedStage = vi.spyOn(reopenedRuntime.story.factService, "stageUserDraftFact");
    renderRoute(reopenedRuntime, `/projects/${project.value.id}/story`);
    await screen.findByRole("heading", { name: "批量设定重启恢复", level: 1 });
    const resume = await screen.findByRole("button", { name: "继续未完成的批量整理" });
    await user.click(resume);
    const recoveredDrawer = screen.getByRole("dialog", { name: "批量整理设定" });
    expect(within(recoveredDrawer).getByRole("textbox", { name: "粘贴多条设定" })).toHaveValue(
      source,
    );
    const retry = within(recoveredDrawer).getByRole("button", { name: "保存为待确认设定" });
    await user.dblClick(retry);

    expect(await screen.findByText("2 条设定已保存为待确认内容")).toBeVisible();
    expect(reopenedStage).toHaveBeenCalledTimes(1);
    const afterRestart = await reopenedRuntime.story.facts.listByProjectId(storyProjectId);
    if (!afterRestart.ok) throw afterRestart.error;
    expect(afterRestart.value).toHaveLength(2);
    const identities = afterRestart.value.map((fact) => {
      const structured = fact.toSnapshot().structuredValue;
      if (structured === null || typeof structured !== "object" || Array.isArray(structured)) {
        throw new Error("恢复后的批量事实缺少持久身份。");
      }
      const identity = structured as Readonly<Record<string, unknown>>;
      if (
        identity.projectId !== project.value.id ||
        typeof identity.batchId !== "string" ||
        typeof identity.draftId !== "string"
      ) {
        throw new Error("恢复后的批量事实缺少项目、批次或草稿身份。");
      }
      return { batchId: identity.batchId, draftId: identity.draftId };
    });
    expect(new Set(identities.map(({ batchId, draftId }) => `${batchId}:${draftId}`)).size).toBe(2);
    expect(new Set(identities.map(({ batchId }) => batchId)).size).toBe(1);
    expect(screen.queryByRole("button", { name: "继续未完成的批量整理" })).toBeNull();
  });

  it("preserves an unreadable bulk recovery record and blocks accidental overwrite", async () => {
    seedWritingExperience("direct");
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "损坏恢复记录保护" });
    if (!project.ok) throw project.error;
    const unreadableRecovery =
      '{"schemaVersion":"inkshadow.future-bulk-recovery.v9","source":"不得丢失的作者原始输入"}';
    const preserved = await runtime.authorRecovery.save({
      projectId: project.value.id,
      kind: "bulk_story_settings",
      schemaVersion: "inkshadow.future-bulk-recovery.v9",
      payloadJson: unreadableRecovery,
      expectedRevision: null,
      now: "2026-08-28T00:00:00.000Z",
    });
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "损坏恢复记录保护", level: 1 });
    expect(await runtime.authorRecovery.find(project.value.id, "bulk_story_settings")).toEqual(
      preserved,
    );
    const inspect = await screen.findByRole("button", { name: "查看无法恢复的批量记录" });
    await user.click(inspect);
    const drawer = screen.getByRole("dialog", { name: "批量整理设定" });
    expect(within(drawer).getByText("本地批次恢复记录暂不可用")).toBeVisible();
    expect(within(drawer).getByText(/原记录已原样保留，没有被删除或覆盖/u)).toBeVisible();
    expect(within(drawer).getByRole("textbox", { name: "粘贴多条设定" })).toBeDisabled();
    expect(within(drawer).getByRole("button", { name: "拆分为待确认项" })).toBeDisabled();
    expect(await runtime.authorRecovery.find(project.value.id, "bulk_story_settings")).toEqual(
      preserved,
    );
  });

  it("hands an unparsed sentence to one prefilled local form and restores focus without cloud work", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerDispatch = vi.spyOn(runtime.modelGateway, "generate");
    const invocationStart = vi.spyOn(runtime.modelHub, "startInvocation");
    const factWrite = vi.spyOn(runtime.story.factService, "createFormalUserFact");
    const project = await runtime.useCases.createProject.execute({ name: "手动表单转交测试" });
    if (!project.ok) throw project.error;
    const storyProjectId = parseStoryProjectId(project.value.id);
    const sourceText = "林舟左腕藏着三枚月纹石，  银环逢雨发热。";
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "手动表单转交测试", level: 1 });
    const sourceTrigger = screen.getByRole("button", { name: "用一句话添加设定" });
    await user.click(sourceTrigger);
    const sourceDrawer = screen.getByRole("dialog", { name: "用一句话添加设定" });
    const sourceInput = within(sourceDrawer).getByRole("textbox", {
      name: /^描述人物、关系或规则/u,
    });
    await user.type(sourceInput, sourceText);
    await user.click(within(sourceDrawer).getByRole("button", { name: "整理为待确认设定" }));
    const typeError = within(sourceDrawer).getByText("需要你选择设定类型");
    expect(typeError).toBeVisible();
    await waitFor(() => expect(sourceInput).toHaveFocus());
    expect(sourceInput).toHaveAttribute("aria-invalid", "true");
    const describedBy = sourceInput.getAttribute("aria-describedby")?.split(/\s+/u) ?? [];
    expect(describedBy).not.toHaveLength(0);
    const field = sourceInput.closest(".ink-form-field");
    expect(field).not.toBeNull();
    expect(
      describedBy.some((id) => {
        const description = sourceDrawer.querySelector(`#${CSS.escape(id)}`);
        return description !== null && field?.contains(description) === true;
      }),
    ).toBe(true);
    await user.click(within(sourceDrawer).getByRole("button", { name: "打开手动表单" }));

    const manualDialog = await screen.findByRole("dialog", { name: "添加故事设定" });
    expect(screen.queryByRole("dialog", { name: "用一句话添加设定" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(manualDialog).getByRole("combobox", { name: "设定类型" })).toHaveValue(
      "character_identity",
    );
    const content = within(manualDialog).getByRole("textbox", { name: "内容" });
    expect(content).toHaveValue(sourceText);
    await waitFor(() => expect(content).toHaveFocus());

    await user.click(within(manualDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "添加故事设定" })).not.toBeInTheDocument();
      expect(sourceTrigger).toHaveFocus();
    });
    const factsAfterCancel = await runtime.story.facts.listByProjectId(storyProjectId);
    if (!factsAfterCancel.ok) throw factsAfterCancel.error;
    expect(factsAfterCancel.value).toHaveLength(0);
    expect(factWrite).not.toHaveBeenCalled();
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(invocationStart).not.toHaveBeenCalled();

    await user.click(sourceTrigger);
    const reopenedSourceDrawer = screen.getByRole("dialog", { name: "用一句话添加设定" });
    expect(
      within(reopenedSourceDrawer).getByRole("textbox", {
        name: /^描述人物、关系或规则/u,
      }),
    ).toHaveValue(sourceText);
    await user.click(
      within(reopenedSourceDrawer).getByRole("button", { name: "整理为待确认设定" }),
    );
    await user.click(within(reopenedSourceDrawer).getByRole("button", { name: "打开手动表单" }));
    const reopenedManualDialog = await screen.findByRole("dialog", { name: "添加故事设定" });
    await user.click(within(reopenedManualDialog).getByRole("button", { name: "确认保存" }));

    const restoredSourceTrigger = await screen.findByRole("button", {
      name: "用一句话添加设定",
    });
    await waitFor(() => expect(restoredSourceTrigger).toHaveFocus());
    const factsAfterSave = await runtime.story.facts.listByProjectId(storyProjectId);
    if (!factsAfterSave.ok) throw factsAfterSave.error;
    expect(factsAfterSave.value.map((fact) => fact.toSnapshot())).toMatchObject([
      {
        factType: "character_identity",
        contentText: sourceText,
        status: "formal",
        userConfirmed: true,
      },
    ]);
    expect(factWrite).toHaveBeenCalledTimes(1);
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(invocationStart).not.toHaveBeenCalled();
  });

  it("opens import teaching before file selection and blocks commit until dry-run is complete", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "设定导入测试" });
    if (!project.ok) throw project.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "设定导入测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "导入或导出" }));
    const dialog = screen.getByRole("dialog", { name: "导入与导出故事设定" });
    expect(within(dialog).getByRole("heading", { name: "选择要处理的内容" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "选择墨影设定文件" })).toBeNull();
    expect(within(dialog).getByText(/文件先做完整预检.*正式写入使用单一事务/u)).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "4选择文件" }));
    expect(within(dialog).getByRole("button", { name: "选择墨影设定文件" })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "7确认导入" }));
    expect(within(dialog).getByText("尚未预检")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认并原子导入" })).toBeDisabled();
    expect(within(dialog).getByText("当前预览环境无法提交")).toBeVisible();
  });

  it("requires an explicit resolution for an imported world rule with an existing title", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "规则冲突测试" });
    if (!project.ok) throw project.error;
    const existing = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "world_rule",
      recordKey: "world-rule.memory-cost",
      value: {
        title: "魔法的记忆代价",
        rule: "旧规则由作者确认。",
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!existing.ok) throw existing.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "规则冲突测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "导入或导出" }));
    const dialog = screen.getByRole("dialog", { name: "导入与导出故事设定" });
    await user.click(within(dialog).getByRole("button", { name: "3模板与示例" }));
    await user.click(within(dialog).getByRole("button", { name: "查看并预检示例" }));
    expect(within(dialog).getByText("需确认 1 项")).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "6解决冲突" }));
    const resolution = within(dialog).getByRole("combobox", {
      name: /^世界规则“魔法的记忆代价”已存在/u,
    });
    expect(within(dialog).getByText("1 项冲突尚未决定")).toBeVisible();
    await user.selectOptions(resolution, "merge");
    expect(within(dialog).queryByText("1 项冲突尚未决定")).toBeNull();
  });

  it("invalidates a previous dry run before rejecting a new invalid or unreadable file", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "候选失效测试" });
    if (!project.ok) throw project.error;
    const user = userEvent.setup({ applyAccept: false });
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "候选失效测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "导入或导出" }));
    const dialog = screen.getByRole("dialog", { name: "导入与导出故事设定" });
    await user.click(within(dialog).getByRole("button", { name: "4选择文件" }));
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept=".json"]',
    );
    if (fileInput === null) throw new Error("找不到故事设定导入文件输入。");

    await user.upload(
      fileInput,
      readableFile("valid-settings.json", serializeStorySettings(createStorySettingsTemplate())),
    );
    await user.click(within(dialog).getByRole("button", { name: "5校验与预览" }));
    expect(await within(dialog).findByText("可导入 5 项")).toBeVisible();

    await user.upload(
      fileInput,
      readableFile(
        "unknown-content.json",
        JSON.stringify({
          ...createStorySettingsTemplate(),
          hidden_internal_field: "不应显示内部字段名",
        }),
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "5校验与预览" }));
    expect(await within(dialog).findByText("未识别内容")).toBeVisible();
    expect(within(dialog).getByText(/发现当前版本不认识的内容/u)).toBeVisible();
    expect(dialog).not.toHaveTextContent(/hidden_internal_field|UNKNOWN_FIELD|\$\./u);

    await user.upload(fileInput, readableFile("not-settings.txt", "not settings"));
    expect(await screen.findByText("只接受墨影设定文件")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "7确认导入" }));
    expect(within(dialog).getByText("尚未预检")).toBeVisible();
    expect(within(dialog).queryByText("可导入 5 项")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "确认并原子导入" })).toBeDisabled();

    await user.upload(
      fileInput,
      readableFile(
        "valid-settings-again.json",
        serializeStorySettings(createStorySettingsTemplate()),
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "5校验与预览" }));
    expect(await within(dialog).findByText("可导入 5 项")).toBeVisible();

    const unreadable = new File(["{}"], "unreadable-settings.json", {
      type: "application/json",
    });
    Object.defineProperty(unreadable, "text", {
      configurable: true,
      value: () => Promise.reject(new Error("read failed")),
    });
    await user.upload(fileInput, unreadable);
    expect(await screen.findByText("无法读取设定文件")).toBeVisible();
    expect(within(dialog).getByText("尚未预检")).toBeVisible();
    expect(within(dialog).queryByText("可导入 5 项")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "7确认导入" }));
    expect(within(dialog).getByRole("button", { name: "确认并原子导入" })).toBeDisabled();
  });

  it("clears the file input so a corrected file at the same path can be selected again", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "同路径重选测试" });
    if (!project.ok) throw project.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "同路径重选测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "导入或导出" }));
    const dialog = screen.getByRole("dialog", { name: "导入与导出故事设定" });
    await user.click(within(dialog).getByRole("button", { name: "4选择文件" }));
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept=".json"]',
    );
    if (fileInput === null) throw new Error("找不到故事设定导入文件输入。");
    const content = serializeStorySettings(createStorySettingsTemplate());
    const file = readableFile("same-settings.json", content);
    const read = vi.spyOn(file, "text");

    await user.upload(fileInput, file);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(fileInput.value).toBe("");
    await user.upload(fileInput, file);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(fileInput.value).toBe("");
    await user.click(within(dialog).getByRole("button", { name: "5校验与预览" }));
    expect(await within(dialog).findByText("可导入 5 项")).toBeVisible();
  });

  it("reuses one operation id when a confirmed import is retried after a transient failure", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await baseRuntime.useCases.createProject.execute({ name: "导入幂等重试" });
    if (!project.ok) throw project.error;
    const committed = mockReceipt(project.value.id, "019f9f4a-b3c7-7350-9226-000000001901");
    const importSpy = vi
      .fn<(command: StorySettingsImportCommand) => Promise<StorySettingsImportReceipt>>()
      .mockRejectedValueOnce(new Error("临时写入失败，请重试"))
      .mockResolvedValueOnce(committed);
    const runtime = {
      ...baseRuntime,
      storySettingsImport: {
        import: importSpy,
        undo: vi.fn(),
        listRecentReceipts: vi.fn().mockResolvedValue([]),
        findLegacyRepairRelationship: vi.fn().mockResolvedValue(null),
      },
    } as unknown as DesktopRuntime;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "导入幂等重试", level: 1 });
    await user.click(screen.getByRole("button", { name: "导入或导出" }));
    const dialog = screen.getByRole("dialog", { name: "导入与导出故事设定" });
    await user.click(within(dialog).getByRole("button", { name: "4选择文件" }));
    const fileInput = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept=".json"]',
    );
    if (fileInput === null) throw new Error("找不到故事设定导入文件输入。");
    await user.upload(
      fileInput,
      readableFile("retry-settings.json", serializeStorySettings(createStorySettingsTemplate())),
    );
    await user.click(within(dialog).getByRole("button", { name: "7确认导入" }));
    const confirm = within(dialog).getByRole("button", { name: "确认并原子导入" });
    await user.click(confirm);
    expect(await screen.findByText("操作未完成")).toBeVisible();
    await user.click(confirm);
    expect(await screen.findByText("故事设定已导入")).toBeVisible();

    expect(importSpy).toHaveBeenCalledTimes(2);
    expect(importSpy.mock.calls[0]?.[0].operationId).toBe(importSpy.mock.calls[1]?.[0].operationId);
  });

  it("reloads the latest committed receipt after remount and can undo it safely", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await baseRuntime.useCases.createProject.execute({ name: "收据恢复测试" });
    if (!project.ok) throw project.error;
    const committed = mockReceipt(project.value.id, "019f9f4a-b3c7-7350-9226-000000001902");
    const undone = {
      ...committed,
      status: "undone" as const,
      undoneAt: "2026-08-09T00:01:00.000Z",
    };
    const listRecentReceipts = vi.fn().mockResolvedValue([committed]);
    const undo = vi.fn().mockResolvedValue(undone);
    const runtime = {
      ...baseRuntime,
      storySettingsImport: {
        import: vi.fn(),
        undo,
        listRecentReceipts,
        findLegacyRepairRelationship: vi.fn().mockResolvedValue(null),
      },
    } as unknown as DesktopRuntime;
    const user = userEvent.setup();
    const first = renderRoute(runtime, `/projects/${project.value.id}/story`);
    await screen.findByRole("heading", { name: "收据恢复测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "导入或导出" }));
    await waitFor(() => expect(listRecentReceipts).toHaveBeenCalledTimes(1));
    first.unmount();

    renderRoute(runtime, `/projects/${project.value.id}/story`);
    await screen.findByRole("heading", { name: "收据恢复测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "导入或导出" }));
    const dialog = screen.getByRole("dialog", { name: "导入与导出故事设定" });
    await waitFor(() => expect(listRecentReceipts).toHaveBeenCalledTimes(2));
    await user.click(within(dialog).getByRole("button", { name: "7确认导入" }));
    expect(await within(dialog).findByText("导入已完成")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "撤销本次导入" }));
    expect(await screen.findByText("本次导入已撤销")).toBeVisible();
    expect(undo).toHaveBeenCalledWith(
      expect.objectContaining({ receiptId: committed.id, projectId: project.value.id }),
    );
  });

  it("shows an actionable error instead of leaking a rejected export", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "设定导出异常" });
    if (!project.ok) throw project.error;
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => {
        throw new Error("无法创建下载地址");
      },
    });
    try {
      const user = userEvent.setup();
      renderRoute(runtime, `/projects/${project.value.id}/story`);
      await screen.findByRole("heading", { name: "设定导出异常", level: 1 });
      await user.click(screen.getByRole("button", { name: "导入或导出" }));
      const dialog = screen.getByRole("dialog", { name: "导入与导出故事设定" });
      await user.click(within(dialog).getByRole("button", { name: "导出全部故事设定" }));
      expect(await screen.findByText("故事设定没有导出")).toBeVisible();
      expect(screen.getByText(/没有产生可下载的半成品.*检查设定后重试/u)).toBeVisible();
    } finally {
      restoreUrlProperty("createObjectURL", originalCreate);
    }
  });

  it("keeps legacy tone and boundaries when normalizing an old guided-opening rule", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "旧规则整理测试" });
    if (!project.ok) throw project.error;
    const legacy = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "world_rule",
      recordKey: "guided_opening.rules",
      value: {
        writingRules: "保持第三人称限知",
        tone: "克制温柔",
        boundaries: ["不写人物死亡", "不增加超自然设定"],
      },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!legacy.ok) throw legacy.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "旧规则整理测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "整理 1 条旧记录" }));
    const dialog = screen.getByRole("dialog", { name: "整理旧版开书设定" });
    expect(within(dialog).getByText("旧版开书写作约定仍使用早期保存格式。")).toBeVisible();
    expect(dialog).not.toHaveTextContent(/guided_opening|schemaVersion|world_rule/u);
    await user.click(within(dialog).getByRole("button", { name: "确认整理" }));
    expect(await screen.findByText("旧记录已整理为可读设定")).toBeVisible();

    const stored = await runtime.story.formalRecords.findById(legacy.value.id);
    if (!stored.ok || stored.value === null) throw new Error("找不到整理后的旧规则。");
    expect(stored.value.currentValue).toMatchObject({
      schemaVersion: "inkshadow.world-rule-setting.v1",
      tone: "克制温柔",
      boundaries: ["不写人物死亡", "不增加超自然设定"],
    });
    expect(JSON.stringify(stored.value.currentValue)).toContain("保持第三人称限知");
    expect(JSON.stringify(stored.value.currentValue)).toContain("克制温柔");
  });

  it("keeps an incomplete relationship visible after normalizing the mixed character card", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await runtime.useCases.createProject.execute({ name: "旧关系独立整理测试" });
    if (!project.ok) throw project.error;
    const legacy = await runtime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "guided_opening.characters",
      value: { protagonist: "普通但敏锐", relationship: "青梅竹马" },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!legacy.ok) throw legacy.error;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "旧关系独立整理测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "整理 2 条旧记录" }));
    const dialog = screen.getByRole("dialog", { name: "整理旧版开书设定" });
    await user.click(within(dialog).getByRole("button", { name: "确认整理" }));
    expect(await within(dialog).findByText(/旧记录只保存了关系类型“青梅竹马”/u)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "补全后确认" })).toBeEnabled();
  });

  it("retries only legacy finalization after the new relationship was already saved", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await baseRuntime.useCases.createProject.execute({ name: "旧关系收尾重试" });
    if (!project.ok) throw project.error;
    const legacy = await baseRuntime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "guided_opening.characters",
      value: {
        schemaVersion: "inkshadow.character-setting.v1",
        name: "林舟",
        aliases: [],
        traits: [],
        knownInformation: [],
        legacyRelationship: "青梅竹马",
      },
      actorId: baseRuntime.story.actorId,
      humanConfirmed: true,
    });
    if (!legacy.ok) throw legacy.error;
    const relationshipFactId = "019f9f4a-b3c7-7350-9226-000000000991";
    const importSpy = vi.fn().mockResolvedValue({
      id: "019f9f4a-b3c7-7350-9226-000000000992",
      projectId: project.value.id,
      sourceSha256: "a".repeat(64),
      status: "committed",
      importedCount: 3,
      skippedCount: 0,
      createdRecordIds: [],
      updatedRecordFences: [],
      createdFactIds: [relationshipFactId],
      createdMemoryIds: [],
      createdAt: "2026-08-09T00:00:00.000Z",
      undoneAt: null,
      idempotentReplay: false,
    });
    const findExisting = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ relationshipFactId, expectedSourceRevision: legacy.value.revision });
    const editSpy = vi
      .spyOn(baseRuntime.story.formalRecordService, "edit")
      .mockResolvedValueOnce({ ok: false, error: new Error("injected stale CAS") } as never);
    const runtime = {
      ...baseRuntime,
      storySettingsImport: {
        import: importSpy,
        undo: vi.fn(),
        listRecentReceipts: vi.fn().mockResolvedValue([]),
        findLegacyRepairRelationship: findExisting,
      },
    } as unknown as DesktopRuntime;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "旧关系收尾重试", level: 1 });
    await user.click(screen.getByRole("button", { name: "整理 1 条旧记录" }));
    const repairDialog = screen.getByRole("dialog", { name: "整理旧版开书设定" });
    await user.click(within(repairDialog).getByRole("button", { name: "补全后确认" }));
    const editor = screen.getByRole("dialog", { name: "补全旧版人物关系" });
    await user.type(
      within(editor).getByRole("textbox", { name: /^描述人物、关系或规则/u }),
      "林舟和顾顾是青梅竹马关系。",
    );
    await user.click(within(editor).getByRole("button", { name: "整理为待确认设定" }));
    const save = within(editor).getByRole("button", { name: "保存新关系并完成迁移" });
    await user.click(save);
    expect(await screen.findByText("新关系已保存，旧提示仍保留")).toBeVisible();
    expect(importSpy).toHaveBeenCalledTimes(1);

    await user.click(save);
    expect(await screen.findByText("旧关系迁移已完成")).toBeVisible();
    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(findExisting).toHaveBeenCalledTimes(2);
    expect(editSpy).toHaveBeenCalledTimes(2);
    const stored = await baseRuntime.story.formalRecords.findById(legacy.value.id);
    if (!stored.ok || stored.value === null) throw new Error("找不到收尾后的旧记录。");
    expect(stored.value.currentValue).toMatchObject({
      legacyRelationshipMigration: {
        relationshipFactId,
        supersedesSourceId: legacy.value.id,
      },
    });
    expect(stored.value.currentValue).not.toHaveProperty("legacyRelationship");
  });

  it("requires a second confirmation before finalizing an existing relationship against a newer legacy revision", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await baseRuntime.useCases.createProject.execute({ name: "旧关系跨重启收尾" });
    if (!project.ok) throw project.error;
    const legacy = await baseRuntime.story.formalRecordService.create({
      projectId: project.value.id,
      kind: "character",
      recordKey: "guided_opening.characters",
      value: {
        schemaVersion: "inkshadow.character-setting.v1",
        name: "林舟",
        aliases: [],
        traits: [],
        knownInformation: [],
        legacyRelationship: "青梅竹马",
      },
      actorId: baseRuntime.story.actorId,
      humanConfirmed: true,
    });
    if (!legacy.ok) throw legacy.error;
    const revised = await baseRuntime.story.formalRecordService.edit({
      recordId: legacy.value.id,
      value: {
        schemaVersion: "inkshadow.character-setting.v1",
        name: "林舟",
        aliases: [],
        traits: [],
        knownInformation: [],
        legacyRelationship: "青梅竹马",
        shortDescription: "作者在迁移间隙补充的说明",
      },
      actorId: baseRuntime.story.actorId,
      humanConfirmed: true,
      expectedRevision: legacy.value.revision,
    });
    if (!revised.ok) throw revised.error;
    const current = await baseRuntime.story.formalRecords.findById(legacy.value.id);
    if (!current.ok || current.value === null) throw new Error("找不到修订后的旧关系来源。");

    const relationshipFactId = "019f9f4a-b3c7-7350-9226-000000000993";
    const importSpy = vi.fn();
    const editSpy = vi.spyOn(baseRuntime.story.formalRecordService, "edit");
    const runtime = {
      ...baseRuntime,
      storySettingsImport: {
        import: importSpy,
        undo: vi.fn(),
        listRecentReceipts: vi.fn().mockResolvedValue([]),
        findLegacyRepairRelationship: vi.fn().mockResolvedValue({
          relationshipFactId,
          expectedSourceRevision: legacy.value.revision,
        }),
      },
    } as unknown as DesktopRuntime;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "旧关系跨重启收尾", level: 1 });
    await user.click(screen.getByRole("button", { name: "整理 1 条旧记录" }));
    const repairDialog = screen.getByRole("dialog", { name: "整理旧版开书设定" });
    await user.click(within(repairDialog).getByRole("button", { name: "补全后确认" }));
    const editor = screen.getByRole("dialog", { name: "补全旧版人物关系" });
    await user.type(
      within(editor).getByRole("textbox", { name: /^描述人物、关系或规则/u }),
      "林舟和顾顾是青梅竹马关系。",
    );
    await user.click(within(editor).getByRole("button", { name: "整理为待确认设定" }));
    await user.click(within(editor).getByRole("button", { name: "保存新关系并完成迁移" }));

    expect(await screen.findByText("旧来源已变化，需要再次确认")).toBeVisible();
    expect(importSpy).not.toHaveBeenCalled();
    expect(editSpy).not.toHaveBeenCalled();

    await user.click(within(editor).getByRole("button", { name: "确认按当前版本完成迁移" }));
    expect(await screen.findByText("旧关系迁移已完成")).toBeVisible();
    expect(importSpy).not.toHaveBeenCalled();
    expect(editSpy).toHaveBeenCalledTimes(1);
    expect(editSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: legacy.value.id,
        expectedRevision: current.value.revision,
      }),
    );
  });

  it("disables Story Settings commit in an archived project even when a service exists", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await baseRuntime.useCases.createProject.execute({ name: "只读导入测试" });
    if (!project.ok) throw project.error;
    const archived = await baseRuntime.useCases.archiveProject.execute({
      projectId: project.value.id,
    });
    if (!archived.ok) throw archived.error;
    const importSpy = vi.fn();
    const committed = mockReceipt(project.value.id, "019f9f4a-b3c7-7350-9226-000000001903");
    const runtime = {
      ...baseRuntime,
      storySettingsImport: {
        import: importSpy,
        undo: vi.fn(),
        listRecentReceipts: vi.fn().mockResolvedValue([committed]),
        findLegacyRepairRelationship: vi.fn().mockResolvedValue(null),
      },
    } as unknown as DesktopRuntime;
    const user = userEvent.setup();
    renderRoute(runtime, `/projects/${project.value.id}/story`);

    await screen.findByRole("heading", { name: "只读导入测试", level: 1 });
    await user.click(screen.getByRole("button", { name: "导入或导出" }));
    const dialog = screen.getByRole("dialog", { name: "导入与导出故事设定" });
    await user.click(within(dialog).getByRole("button", { name: "7确认导入" }));
    expect(await within(dialog).findByRole("button", { name: "撤销本次导入" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "3模板与示例" }));
    await user.click(within(dialog).getByRole("button", { name: "查看并预检示例" }));
    await user.click(within(dialog).getByRole("button", { name: "7确认导入" }));
    const confirm = within(dialog).getByRole("button", { name: "确认并原子导入" });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(importSpy).not.toHaveBeenCalled();
  });
});

function readableFile(name: string, content: string): File {
  const file = new File([content], name, { type: "application/json" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: () => Promise.resolve(content),
  });
  return file;
}

function mockReceipt(projectId: string, id: string): StorySettingsImportReceipt {
  return Object.freeze({
    id,
    projectId,
    sourceSha256: "a".repeat(64),
    status: "committed" as const,
    importedCount: 5,
    skippedCount: 0,
    createdRecordIds: [],
    updatedRecordFences: [],
    createdFactIds: [],
    createdMemoryIds: [],
    createdAt: "2026-08-09T00:00:00.000Z",
    undoneAt: null,
    idempotentReplay: false,
  });
}

function restoreUrlProperty(
  property: "createObjectURL",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(URL, property);
    return;
  }
  Object.defineProperty(URL, property, descriptor);
}

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

function renderNavigableRoute(runtime: DesktopRuntime, route: string, target: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <RouteSwitch target={target} />
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
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
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject } as const;
}

function parseStoryProjectId(value: string) {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return parsed.value;
}
