import { render, screen, waitFor, within } from "@testing-library/react";
import { AiCandidate, type UuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompletedImport } from "../components/data-transfer-panel";
import type { ModelProfile } from "../infrastructure/model-center-store";
import type { NovelAiTask } from "../infrastructure/model-hub-provider-registry";
import type { ModelHubStore } from "../infrastructure/model-hub-store";
import { parseProjectSeed } from "../infrastructure/project-seed";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGenerationInput,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import {
  IMPORT_JOURNEY_STORAGE_KEY,
  IMPORT_REWRITE_PENDING_STORAGE_KEY,
  ImportJourneyPage,
} from "./import-journey-page";

describe("ImportJourneyPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("restores the local journey, reports supported local formats, and never fakes AI without a model", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const fixture = await seedImportedWork(runtime, ["门开了。她没有回头，雨声留在走廊尽头。"]);
    writeDraft(fixture.completed, { goal: "保留剧情，让对话更自然" });
    window.localStorage.setItem(
      IMPORT_REWRITE_PENDING_STORAGE_KEY,
      JSON.stringify({
        requestId: fixture.chapterIds[0],
        providerId: "previous-provider",
        modelId: "previous-model",
        chapterId: fixture.chapterIds[0],
        kind: "trial",
        startedAt: new Date().toISOString(),
      }),
    );
    const user = userEvent.setup();
    renderPage(runtime);

    expect(
      screen.getByRole("heading", { name: "导入小说，继续写或改写", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回开始" })).toHaveAttribute("href", "/");
    expect(screen.getByText(/^当前可在本机安全导入.*DOCX、EPUB/)).toBeInTheDocument();
    expect(screen.getByText(/不会自动重复调用或重复计费/)).toBeInTheDocument();
    await screen.findByText("识别到 1 个有效章节。");
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY) ?? "{}") as {
        projectSeed?: unknown;
      };
      const seed = parseProjectSeed(saved.projectSeed);
      expect(seed?.journeyKind).toBe("import");
      expect(seed?.premise.values).toEqual([fixture.completed.projectName]);
      expect(seed?.premise.source).toBe("imported_text");
      expect(seed?.currentDirection.values).toEqual(["保留剧情，让对话更自然"]);
      expect(seed?.currentDirection.confirmation).toBe("confirmed");
    });

    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    expect(await screen.findByText(/MODEL_NOT_CONNECTED/)).toBeInTheDocument();
    const chapter = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(chapter.ok && chapter.value?.content).toBe("门开了。她没有回头，雨声留在走廊尽头。");
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(candidates.ok && candidates.value).toHaveLength(0);
  });

  it("runs resumable evidence-bound work analysis and restores its progress without copying prose into the journey draft", async () => {
    const content = "午夜停电，林夏拉住周远，仓库的监控随即失效。";
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, []);
    const fixture = await seedImportedWork(runtime, [content]);
    const chapterResult = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    if (!chapterResult.ok || chapterResult.value === null) {
      throw new Error("Expected the imported chapter.");
    }
    const chapter = chapterResult.value;
    const outputs = [
      analysisResponse({
        chapterId: chapter.id,
        versionId: chapter.currentVersionId,
        content,
        factType: "core_relationship",
        statement: "林夏试图留住周远。",
        subjects: ["林夏", "周远"],
        relation: "挽留",
      }),
      analysisResponse({
        chapterId: chapter.id,
        versionId: chapter.currentVersionId,
        content,
        factType: "causal_event",
        statement: "午夜停电后仓库监控失效。",
        subjects: [],
        relation: "仓库监控失效",
      }),
    ];
    const configured = withConfiguredModel(base, outputs);
    // The fixture and configured runtime share the same local repositories.
    await seedAnalysisRoutes(configured.modelHub);
    writeDraft(fixture.completed, {});
    const user = userEvent.setup();
    const first = renderPage(configured);
    await screen.findByText("识别到 1 个有效章节。");

    await user.click(screen.getByRole("button", { name: "开始分析作品" }));

    const result = await screen.findByRole("region", { name: "作品分析结果" });
    await waitFor(() => expect(result).toHaveTextContent("共保存 2 条待确认事实"));
    expect(result).toHaveTextContent("人物关系：1 条有原文证据的待确认结果");
    expect(result).toHaveTextContent("已发生事件：1 条有原文证据的待确认结果");
    expect(screen.getByRole("link", { name: "故事设定" })).toHaveAttribute(
      "href",
      `/projects/${fixture.completed.projectId}/story`,
    );
    expect(window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY)).not.toContain(content);

    const storyProjectId = parseStoryUuidV7(fixture.completed.projectId);
    if (!storyProjectId.ok) throw storyProjectId.error;
    const facts = await configured.story.facts.listByProjectId(storyProjectId.value);
    expect(facts.ok && facts.value).toHaveLength(2);
    if (!facts.ok) throw facts.error;
    expect(facts.value.every(({ status }) => status === "unconfirmed")).toBe(true);
    expect(facts.value.every((fact) => fact.toSnapshot().needsReview)).toBe(true);
    expect(facts.value.map((fact) => fact.toSnapshot().source.excerpt)).toEqual([content, content]);
    const stable = await configured.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe(content);

    first.unmount();
    renderPage(configured);
    const restored = await screen.findByRole("region", { name: "作品分析结果" });
    expect(restored).toHaveTextContent("共保存 2 条待确认事实");
    expect(screen.queryByRole("button", { name: "开始分析作品" })).not.toBeInTheDocument();
  });

  it("keeps imported prose intact and offers an explicit skip when analysis routing is unavailable", async () => {
    const content = "原文已经安全导入，不应因分析失败而变化。";
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, []);
    const fixture = await seedImportedWork(runtime, [content]);
    writeDraft(fixture.completed, {});
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");

    await user.click(screen.getByRole("button", { name: "开始分析作品" }));

    expect(
      (await screen.findAllByText(/IMPORT_ANALYSIS_ROUTE_NOT_CONFIGURED/)).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "前往模型设置" })).toHaveAttribute(
      "href",
      "/settings#model-center",
    );
    await user.click(screen.getByRole("button", { name: "跳过剩余分析" }));
    expect(await screen.findByText(/已跳过剩余深度分析/)).toBeInTheDocument();
    const result = screen.getByRole("region", { name: "作品分析结果" });
    expect(result).toHaveTextContent("跳过 2 项");
    expect(result).toHaveTextContent("共保存 0 条待确认事实");
    const stable = await runtime.repositories.chapters.findById(chapterIdAt(fixture.chapterIds, 0));
    expect(stable.ok && stable.value?.content).toBe(content);
  });

  it("creates a resumable isolated trial candidate, accepts explicitly, and restores the exact base version", async () => {
    const original = "门开了。她没有回头。\n\n雨声沿着窗框落下，走廊里没有第二个人。";
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["门轻轻开了，她仍背对着门。"]);
    const fixture = await seedImportedWork(runtime, [original]);
    writeDraft(fixture.completed, { goal: "保留事件顺序，让动作更克制" });
    const user = userEvent.setup();
    const first = renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");

    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    expect(await screen.findByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
      "门轻轻开了，她仍背对着门。",
    );
    expect(screen.getByRole("list", { name: "试改文字差异" })).toBeInTheDocument();

    const beforeAccept = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(beforeAccept.ok && beforeAccept.value?.content).toBe(original);
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(candidates.ok && candidates.value).toHaveLength(1);
    if (!candidates.ok || candidates.value[0] === undefined) {
      throw new Error("Expected the isolated trial candidate.");
    }
    expect(candidates.value[0].status).toBe("ready");
    expect(candidates.value[0].content).toBe("门轻轻开了，她仍背对着门。");
    expect(window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY)).not.toContain(original);

    first.unmount();
    renderPage(runtime);
    expect(await screen.findByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
      "门轻轻开了，她仍背对着门。",
    );
    await user.click(screen.getByRole("button", { name: "接受试改到正文" }));
    await screen.findByRole("button", { name: "恢复接受前原文" });
    const accepted = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(accepted.ok && accepted.value?.content).toBe("门轻轻开了，她仍背对着门。");
    await waitFor(async () => {
      const tasks = await runtime.taskCenter.load();
      expect(
        tasks.tasks.some(
          (task) =>
            task.type === "story.accepted-version.process" &&
            task.metadata.source === "chapter_import",
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "恢复接受前原文" }));
    await screen.findByText("已恢复原文");
    const restored = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(restored.ok && restored.value?.content).toBe(original);
    const versions = await runtime.useCases.listChapterVersions.execute(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(versions.ok && versions.value.length).toBe(3);
    await waitFor(async () => {
      const tasks = await runtime.taskCenter.load();
      expect(
        tasks.tasks.some(
          (task) =>
            task.type === "story.accepted-version.process" &&
            task.metadata.source === "version_restore",
        ),
      ).toBe(true);
    });
  });

  it("refuses automatic restore after later edits so recovery cannot overwrite newer writing", async () => {
    const original = "原始段落。";
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["AI 试改段落。　"]);
    const fixture = await seedImportedWork(runtime, [original]);
    writeDraft(fixture.completed, { goal: "优化文笔" });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByRole("region", { name: "代表段落试改结果" });
    await user.click(screen.getByRole("button", { name: "接受试改到正文" }));
    await screen.findByRole("button", { name: "恢复接受前原文" });

    const accepted = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    if (!accepted.ok || accepted.value === null) {
      throw new Error("Expected the accepted chapter.");
    }
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: accepted.value.id,
      expectedRevision: accepted.value.revision,
      content: "作者接受后继续写下的新内容。",
      cursorOffset: 13,
    });
    if (!edited.ok) {
      throw edited.error;
    }
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: accepted.value.id,
      expectedRevision: accepted.value.revision,
      reason: "manual",
    });
    if (!saved.ok) {
      throw saved.error;
    }

    await user.click(screen.getByRole("button", { name: "恢复接受前原文" }));
    expect(await screen.findByText(/BASE_VERSION_CHANGED/)).toBeInTheDocument();
    const afterFailedRestore = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(afterFailedRestore.ok && afterFailedRestore.value?.content).toBe(
      "作者接受后继续写下的新内容。",
    );
  });

  it("forms editable rules and creates independent per-chapter candidates with accept, reject, and retry", async () => {
    const originals = ["第一章原文：雨夜相遇。", "第二章原文：清晨分别。"] as const;
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, [
      "第一章试改：雨夜的相遇更安静。",
      "第一章完整改写：雨夜相遇。",
      "第二章完整改写：清晨分别。",
      "第一章重新改写：雨夜相遇。",
    ]);
    const fixture = await seedImportedWork(runtime, originals);
    writeDraft(fixture.completed, { selectedPresetIds: ["polish"] });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 2 个有效章节。");

    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    expect(await screen.findByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
      "第一章试改：雨夜的相遇更安静。",
    );
    await user.click(screen.getByRole("button", { name: "对话更自然" }));
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    expect(screen.getByRole("textbox", { name: "规则 1" })).toHaveValue(
      "保留主要剧情、已发生事件和人物姓名",
    );
    await user.click(screen.getByRole("button", { name: "保留当前规则" }));
    await user.click(screen.getByRole("button", { name: "开始逐章处理" }));

    const batch = await screen.findByRole("list", { name: "逐章建议版本" });
    await waitFor(() => {
      const rows = within(batch).getAllByRole("listitem");
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toHaveTextContent("建议版本已就绪");
      }
    });
    const firstRow = within(batch).getByText("第 1 章").closest("li");
    const secondRow = within(batch).getByText("第 2 章").closest("li");
    if (firstRow === null || secondRow === null) {
      throw new Error("Expected both chapter candidate rows.");
    }
    expect(within(firstRow).getByRole("link", { name: "查看完整差异" })).toHaveAttribute(
      "href",
      expect.stringContaining("?candidate="),
    );
    const stableBefore = await Promise.all(
      fixture.chapterIds.map((chapterId) => runtime.repositories.chapters.findById(chapterId)),
    );
    expect(stableBefore.map((result) => result.ok && result.value?.content)).toEqual(originals);

    await user.click(within(firstRow).getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(within(firstRow).getByText(/已拒绝/)).toBeInTheDocument());
    await user.click(within(secondRow).getByRole("button", { name: "接受" }));
    await waitFor(() =>
      expect(within(secondRow).getByText(/已接受为新正文版本/)).toBeInTheDocument(),
    );
    const firstStable = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    const secondStable = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 1),
    );
    expect(firstStable.ok && firstStable.value?.content).toBe(originals[0]);
    expect(secondStable.ok && secondStable.value?.content).toBe("第二章完整改写：清晨分别。");

    await user.click(within(firstRow).getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(firstRow).toHaveTextContent("建议版本已就绪"));
    const firstCandidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapterIdAt(fixture.chapterIds, 0),
    );
    expect(
      firstCandidates.ok && firstCandidates.value.filter(({ status }) => status === "ready"),
    ).toHaveLength(2);
    expect(
      firstCandidates.ok && firstCandidates.value.filter(({ status }) => status === "rejected"),
    ).toHaveLength(1);
  });

  it("keeps formed rules visible and shows a retryable error when feedback preference saving fails", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["代表段落试改。"]);
    const fixture = await seedImportedWork(runtime, ["导入作品原文。"]);
    writeDraft(fixture.completed, { goal: "优化文笔" });
    const recordFeedback = vi.spyOn(runtime.story.writingFeedback, "recordExplicitFeedback");
    recordFeedback.mockRejectedValueOnce(new Error("feedback storage unavailable"));
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByText("代表段落试改。");
    await user.click(screen.getByRole("button", { name: "对话更自然" }));
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));

    expect(await screen.findByText("规则已形成，但反馈偏好尚未保存")).toBeInTheDocument();
    expect(screen.getByText(/请再次点击.*重试/u)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "规则 1" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    expect(await screen.findByText(/试改反馈也已安全保存/u)).toBeInTheDocument();
    expect(screen.queryByText("规则已形成，但反馈偏好尚未保存")).not.toBeInTheDocument();
    expect(recordFeedback).toHaveBeenCalledTimes(2);
  });

  it("stops accept-all after an accepted Candidate checkpoint cannot be persisted", async () => {
    const originals = ["第一章原文。", "第二章原文。"] as const;
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["准备规则的试改。", "第一章建议。", "第二章建议。"]);
    const fixture = await seedImportedWork(runtime, originals);
    writeDraft(fixture.completed, { selectedPresetIds: ["polish"] });
    const user = userEvent.setup();
    const mounted = renderPage(runtime);
    await screen.findByText("识别到 2 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByText("准备规则的试改。");
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    await user.click(screen.getByRole("button", { name: "保留当前规则" }));
    await user.click(screen.getByRole("button", { name: "开始逐章处理" }));
    const batch = await screen.findByRole("list", { name: "逐章建议版本" });
    await waitFor(() => {
      const items = within(batch).getAllByRole("listitem");
      expect(items).toHaveLength(2);
      expect(items[0]).toHaveTextContent("建议版本已就绪");
      expect(items[1]).toHaveTextContent("建议版本已就绪");
    });
    const before = readStoredJourney();
    const firstPointer = before.batchItems[0];
    const secondPointer = before.batchItems[1];
    if (
      firstPointer?.candidateId === null ||
      firstPointer === undefined ||
      secondPointer?.candidateId === null ||
      secondPointer === undefined
    ) {
      throw new Error("Expected two durable batch Candidate pointers.");
    }
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === IMPORT_JOURNEY_STORAGE_KEY) {
        const candidate = JSON.parse(value) as StoredJourneyDraft;
        if (candidate.batchItems[0]?.status === "accepted") {
          throw new DOMException("quota blocked", "QuotaExceededError");
        }
      }
      nativeSetItem(key, value);
    });
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");

    try {
      await user.click(screen.getByRole("button", { name: "接受全部就绪建议" }));
      expect(await screen.findByText(/IMPORT_JOURNEY_PERSIST_FAILED/)).toBeInTheDocument();
      expect(accept).toHaveBeenCalledTimes(1);
      const currentRows = within(batch).getAllByRole("listitem");
      expect(currentRows[0]).toHaveTextContent("已接受为新正文版本");
      expect(currentRows[1]).toHaveTextContent("建议版本已就绪");

      const firstCandidate = await runtime.repositories.aiCandidates.findById(
        firstPointer.candidateId as UuidV7,
      );
      const secondCandidate = await runtime.repositories.aiCandidates.findById(
        secondPointer.candidateId as UuidV7,
      );
      expect(firstCandidate.ok && firstCandidate.value).toMatchObject({
        status: "accepted",
        revision: 2,
      });
      expect(secondCandidate.ok && secondCandidate.value).toMatchObject({
        status: "ready",
        revision: 1,
      });
      const firstChapter = await runtime.repositories.chapters.findById(
        chapterIdAt(fixture.chapterIds, 0),
      );
      const secondChapter = await runtime.repositories.chapters.findById(
        chapterIdAt(fixture.chapterIds, 1),
      );
      expect(firstChapter.ok && firstChapter.value?.content).toBe("第一章建议。");
      expect(secondChapter.ok && secondChapter.value?.content).toBe(originals[1]);

      const durable = readStoredJourney();
      expect(durable.batchItems[0]).toMatchObject({
        candidateId: firstPointer.candidateId,
        candidateRevision: firstPointer.candidateRevision,
        status: "ready",
      });
      expect(durable.batchItems[1]).toMatchObject({
        candidateId: secondPointer.candidateId,
        candidateRevision: secondPointer.candidateRevision,
        status: "ready",
      });
    } finally {
      setItem.mockRestore();
    }

    mounted.unmount();
    renderPage(runtime);
    const recovered = await screen.findByRole("list", { name: "逐章建议版本" });
    const recoveredLinks = within(recovered).getAllByRole("link", { name: "查看完整差异" });
    expect(recoveredLinks[0]).toHaveAttribute(
      "href",
      expect.stringContaining(firstPointer.candidateId),
    );
    expect(recoveredLinks[1]).toHaveAttribute(
      "href",
      expect.stringContaining(secondPointer.candidateId),
    );
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("stops accept-all on the first concurrent Candidate revision and leaves later正文 untouched", async () => {
    const originals = ["第一章原文。", "第二章原文。"] as const;
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["准备规则的试改。", "第一章建议。", "第二章建议。"]);
    const fixture = await seedImportedWork(runtime, originals);
    writeDraft(fixture.completed, { selectedPresetIds: ["polish"] });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 2 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByText("准备规则的试改。");
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    await user.click(screen.getByRole("button", { name: "保留当前规则" }));
    await user.click(screen.getByRole("button", { name: "开始逐章处理" }));
    const batch = await screen.findByRole("list", { name: "逐章建议版本" });
    await waitFor(() => {
      const rows = within(batch).getAllByRole("listitem");
      expect(rows[0]).toHaveTextContent("建议版本已就绪");
      expect(rows[1]).toHaveTextContent("建议版本已就绪");
    });
    const before = readStoredJourney();
    const first = before.batchItems[0];
    const second = before.batchItems[1];
    if (
      first?.candidateId === null ||
      first?.candidateRevision === null ||
      first === undefined ||
      second?.candidateId === null ||
      second === undefined
    ) {
      throw new Error("Expected two durable ready Candidate pointers.");
    }
    const revised = await runtime.useCases.reviseCandidate.execute({
      candidateId: first.candidateId as UuidV7,
      expectedCandidateRevision: first.candidateRevision,
      content: "另一窗口修改后的第一章建议。",
    });
    if (!revised.ok) throw revised.error;
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const secondVersionsBefore = await runtime.repositories.chapterVersions.listByChapterId(
      chapterIdAt(fixture.chapterIds, 1),
    );
    if (!secondVersionsBefore.ok) throw secondVersionsBefore.error;

    await user.click(screen.getByRole("button", { name: "接受全部就绪建议" }));

    expect(await screen.findByText(/已接受 0 项，停在第 1 项/u)).toBeInTheDocument();
    expect(accept).toHaveBeenCalledTimes(1);
    const rows = within(batch).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("处理失败，原文未变");
    expect(rows[1]).toHaveTextContent("建议版本已就绪");
    const secondCandidate = await runtime.repositories.aiCandidates.findById(
      second.candidateId as UuidV7,
    );
    expect(secondCandidate.ok && secondCandidate.value).toMatchObject({
      status: "ready",
      revision: second.candidateRevision,
    });
    const secondChapter = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 1),
    );
    expect(secondChapter.ok && secondChapter.value?.content).toBe(originals[1]);
    const secondVersionsAfter = await runtime.repositories.chapterVersions.listByChapterId(
      chapterIdAt(fixture.chapterIds, 1),
    );
    expect(secondVersionsAfter.ok && secondVersionsAfter.value).toHaveLength(
      secondVersionsBefore.value.length,
    );
  });

  it("stops accept-all before later items when the first ready pointer has no revision", async () => {
    const originals = ["第一章原文。", "第二章原文。"] as const;
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["准备规则的试改。", "第一章建议。", "第二章建议。"]);
    const fixture = await seedImportedWork(runtime, originals);
    writeDraft(fixture.completed, { selectedPresetIds: ["polish"] });
    const user = userEvent.setup();
    const mounted = renderPage(runtime);
    await screen.findByText("识别到 2 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByText("准备规则的试改。");
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    await user.click(screen.getByRole("button", { name: "保留当前规则" }));
    await user.click(screen.getByRole("button", { name: "开始逐章处理" }));
    await waitFor(() => {
      const rows = within(screen.getByRole("list", { name: "逐章建议版本" })).getAllByRole(
        "listitem",
      );
      expect(rows[0]).toHaveTextContent("建议版本已就绪");
      expect(rows[1]).toHaveTextContent("建议版本已就绪");
    });
    const serialized = window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY);
    if (serialized === null) throw new Error("Expected a durable import journey.");
    const stored = JSON.parse(serialized) as Readonly<{
      batchItems: readonly Readonly<Record<string, unknown>>[];
    }> &
      Readonly<Record<string, unknown>>;
    window.localStorage.setItem(
      IMPORT_JOURNEY_STORAGE_KEY,
      JSON.stringify({
        ...stored,
        batchItems: stored.batchItems.map((item, index) =>
          index === 0 ? { ...item, candidateRevision: null } : item,
        ),
      }),
    );
    const second = readStoredJourney().batchItems[1];
    if (second?.candidateId === null || second === undefined) {
      throw new Error("Expected the second durable Candidate pointer.");
    }
    mounted.unmount();
    renderPage(runtime);
    const recoveredBatch = await screen.findByRole("list", { name: "逐章建议版本" });
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const secondVersionsBefore = await runtime.repositories.chapterVersions.listByChapterId(
      chapterIdAt(fixture.chapterIds, 1),
    );
    if (!secondVersionsBefore.ok) throw secondVersionsBefore.error;

    await user.click(screen.getByRole("button", { name: "接受全部就绪建议" }));

    expect(await screen.findByText(/已接受 0 项，停在第 1 项/u)).toBeInTheDocument();
    expect(accept).not.toHaveBeenCalled();
    const rows = within(recoveredBatch).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("处理失败，原文未变");
    expect(rows[1]).toHaveTextContent("建议版本已就绪");
    const secondCandidate = await runtime.repositories.aiCandidates.findById(
      second.candidateId as UuidV7,
    );
    expect(secondCandidate.ok && secondCandidate.value).toMatchObject({
      status: "ready",
      revision: second.candidateRevision,
    });
    const secondChapter = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 1),
    );
    expect(secondChapter.ok && secondChapter.value?.content).toBe(originals[1]);
    const secondVersionsAfter = await runtime.repositories.chapterVersions.listByChapterId(
      chapterIdAt(fixture.chapterIds, 1),
    );
    expect(secondVersionsAfter.ok && secondVersionsAfter.value).toHaveLength(
      secondVersionsBefore.value.length,
    );
  });

  it("blocks legacy batch regeneration before dispatch when the shown Candidate revision is missing", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["不应被调用"]);
    const fixture = await seedImportedWork(runtime, ["旧版批次正文。"]);
    const chapterResult = await runtime.repositories.chapters.findById(
      chapterIdAt(fixture.chapterIds, 0),
    );
    if (!chapterResult.ok || chapterResult.value === null) throw new Error("Expected chapter.");
    const chapter = chapterResult.value;
    const now = runtime.clock.now();
    const streaming = AiCandidate.createStreaming({
      id: runtime.ids.next(),
      projectId: chapter.projectId,
      chapterId: chapter.id,
      source: "polish",
      baseVersionId: chapter.currentVersionId,
      now,
      applicationIntent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      },
    });
    if (!streaming.ok) throw streaming.error;
    const checksum = await runtime.hasher.sha256("旧版待处理建议。");
    if (!checksum.ok) throw checksum.error;
    const ready = streaming.value.markReady("旧版待处理建议。", checksum.value, now);
    if (!ready.ok) throw ready.error;
    const created = await runtime.repositories.aiCandidates.create(ready.value);
    if (!created.ok) throw created.error;
    const savedAt = new Date().toISOString();
    window.localStorage.setItem(
      IMPORT_JOURNEY_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        goal: "保留剧情，优化文笔",
        selectedPresetIds: ["polish"],
        importedWork: fixture.completed,
        feedbackPresetIds: [],
        feedbackText: "",
        trial: null,
        rules: [{ id: "legacy-rule", text: "保留剧情，优化文笔", enabled: true }],
        rulesSavedAt: savedAt,
        batchItems: [
          {
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            candidateId: ready.value.id,
            status: "ready",
            providerId: "legacy-provider",
            modelId: "legacy-model",
            errorCode: null,
          },
        ],
        workAnalysis: null,
        updatedAt: savedAt,
      }),
    );

    const user = userEvent.setup();
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    renderPage(runtime);
    const batch = await screen.findByRole("list", { name: "逐章建议版本" });
    await user.click(within(batch).getByRole("button", { name: "重新生成" }));
    expect(await screen.findAllByText(/CANDIDATE_REVISION_MISSING/)).not.toHaveLength(0);
    expect(generate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重新逐章生成" }));
    expect(generate).not.toHaveBeenCalled();
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    expect(candidates.ok && candidates.value).toHaveLength(1);
  });

  it("stops paid batch dispatch and keeps the generated Candidate visible when revision persistence fails", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["第一章已生成但修订号无法落盘。"]);
    const fixture = await seedImportedWork(runtime, ["第一章原文。", "第二章原文。"]);
    const savedAt = new Date().toISOString();
    window.localStorage.setItem(
      IMPORT_JOURNEY_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        goal: "保留剧情，优化文笔",
        selectedPresetIds: ["polish"],
        importedWork: fixture.completed,
        feedbackPresetIds: [],
        feedbackText: "",
        trial: null,
        rules: [{ id: "persist-rule", text: "保留剧情，优化文笔", enabled: true }],
        rulesSavedAt: savedAt,
        batchItems: [],
        workAnalysis: null,
        updatedAt: savedAt,
      }),
    );
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 2 个有效章节。");
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    generate.mockClear();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (
        key === IMPORT_JOURNEY_STORAGE_KEY &&
        value.includes('"candidateRevision":1') &&
        value.includes('"status":"ready"')
      ) {
        throw new DOMException("quota blocked", "QuotaExceededError");
      }
      nativeSetItem(key, value);
    });

    try {
      await user.click(screen.getByRole("button", { name: "开始逐章处理" }));
      expect(await screen.findByText(/IMPORT_JOURNEY_PERSIST_FAILED/)).toBeInTheDocument();
      expect(generate).toHaveBeenCalledTimes(1);
      const batch = await screen.findByRole("list", { name: "逐章建议版本" });
      const firstRow = within(batch).getByText("第 1 章").closest("li");
      if (firstRow === null) throw new Error("Expected first batch row.");
      expect(firstRow).toHaveTextContent("建议版本已就绪");
      expect(within(firstRow).getByRole("link", { name: "查看完整差异" })).toBeInTheDocument();
      const firstCandidates = await runtime.repositories.aiCandidates.listByChapterId(
        chapterIdAt(fixture.chapterIds, 0),
      );
      const secondCandidates = await runtime.repositories.aiCandidates.listByChapterId(
        chapterIdAt(fixture.chapterIds, 1),
      );
      expect(firstCandidates.ok && firstCandidates.value).toHaveLength(1);
      expect(secondCandidates.ok && secondCandidates.value).toHaveLength(0);
      expect(window.localStorage.getItem(IMPORT_REWRITE_PENDING_STORAGE_KEY)).not.toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("stops before a provider call when the synchronous pending receipt cannot be persisted", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["不应发送到供应商。"]);
    const fixture = await seedImportedWork(runtime, ["待试改原文。"]);
    writeDraft(fixture.completed, { goal: "优化文笔" });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === IMPORT_REWRITE_PENDING_STORAGE_KEY) {
        throw new DOMException("quota blocked", "QuotaExceededError");
      }
      nativeSetItem(key, value);
    });

    try {
      await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
      expect(
        (await screen.findAllByText(/IMPORT_PENDING_REQUEST_PERSIST_FAILED/)).length,
      ).toBeGreaterThan(0);
      expect(generate).not.toHaveBeenCalled();
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(
        chapterIdAt(fixture.chapterIds, 0),
      );
      expect(candidates.ok && candidates.value).toHaveLength(0);
    } finally {
      setItem.mockRestore();
    }
  });

  it("shows pending cleanup failure without hiding the provider error", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, []);
    const fixture = await seedImportedWork(runtime, ["等待失败结果的原文。"]);
    writeDraft(fixture.completed, { goal: "优化文笔" });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    const nativeRemoveItem = Storage.prototype.removeItem.bind(window.localStorage);
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key: string,
    ): void {
      if (key === IMPORT_REWRITE_PENDING_STORAGE_KEY) {
        throw new DOMException("remove blocked", "QuotaExceededError");
      }
      nativeRemoveItem(key);
    });

    try {
      await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
      expect((await screen.findAllByText(/MODEL_GENERATION_FAILED/)).length).toBeGreaterThan(0);
      expect(
        (await screen.findAllByText(/IMPORT_PENDING_REQUEST_CLEAR_FAILED/)).length,
      ).toBeGreaterThan(0);
      expect(screen.getByText(/不会自动重复调用或重复计费/)).toBeInTheDocument();
      expect(window.localStorage.getItem(IMPORT_REWRITE_PENDING_STORAGE_KEY)).not.toBeNull();
    } finally {
      removeItem.mockRestore();
    }
  });

  it("stops whole-batch dispatch at the first chapter when its pending receipt cannot be persisted", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["准备规则用试改。"]);
    await seedAnalysisRoute(runtime.modelHub, "rewrite", "rewrite");
    const fixture = await seedImportedWork(runtime, ["第一章原文。", "第二章原文。"]);
    writeDraft(fixture.completed, { selectedPresetIds: ["polish"] });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 2 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByText("准备规则用试改。");
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    await user.click(screen.getByRole("button", { name: "保留当前规则" }));
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    generate.mockClear();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === IMPORT_REWRITE_PENDING_STORAGE_KEY) {
        throw new DOMException("quota blocked", "QuotaExceededError");
      }
      nativeSetItem(key, value);
    });

    try {
      await user.click(screen.getByRole("button", { name: "开始逐章处理" }));
      expect(
        (await screen.findAllByText(/IMPORT_PENDING_REQUEST_PERSIST_FAILED/)).length,
      ).toBeGreaterThan(0);
      expect(generate).not.toHaveBeenCalled();
      const stored = readStoredJourney();
      expect(stored.batchItems[0]?.status).toBe("error");
      expect(stored.batchItems[1]?.status).toBe("queued");
      const firstCandidates = await runtime.repositories.aiCandidates.listByChapterId(
        chapterIdAt(fixture.chapterIds, 0),
      );
      const secondCandidates = await runtime.repositories.aiCandidates.listByChapterId(
        chapterIdAt(fixture.chapterIds, 1),
      );
      // Only the earlier trial Candidate exists; no whole-chapter provider call was made.
      expect(firstCandidates.ok && firstCandidates.value).toHaveLength(1);
      expect(secondCandidates.ok && secondCandidates.value).toHaveLength(0);
    } finally {
      setItem.mockRestore();
    }
  });

  it("keeps an initial trial Candidate visible and its pending receipt when pointer persistence fails", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["已生成但指针暂时无法落盘的试改。"]);
    const fixture = await seedImportedWork(runtime, ["初始试改原文。"]);
    writeDraft(fixture.completed, { goal: "优化文笔" });
    const user = userEvent.setup();
    const first = renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (
        key === IMPORT_JOURNEY_STORAGE_KEY &&
        value.includes('"trial":{') &&
        value.includes('"candidateRevision":1')
      ) {
        throw new DOMException("quota blocked", "QuotaExceededError");
      }
      nativeSetItem(key, value);
    });

    try {
      await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
      expect(await screen.findByText(/IMPORT_JOURNEY_PERSIST_FAILED/)).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
        "已生成但指针暂时无法落盘的试改。",
      );
      expect(window.localStorage.getItem(IMPORT_REWRITE_PENDING_STORAGE_KEY)).not.toBeNull();
      const stored = readStoredJourney();
      expect(stored.trial).toBeNull();
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(
        chapterIdAt(fixture.chapterIds, 0),
      );
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    } finally {
      setItem.mockRestore();
    }

    first.unmount();
    renderPage(runtime);
    expect(await screen.findByText(/不会自动重复调用或重复计费/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "代表段落试改结果" })).not.toBeInTheDocument();
  });

  it("does not reject the prior trial when a regenerated trial pointer hits QuotaExceeded", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["第一份试改。", "第二份试改。"]);
    const fixture = await seedImportedWork(runtime, ["试改重生成原文。"]);
    writeDraft(fixture.completed, { goal: "优化文笔" });
    const user = userEvent.setup();
    const first = renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByText("第一份试改。");
    const before = readStoredJourney();
    if (before.trial === null) throw new Error("Expected the first trial pointer.");
    const firstCandidateId = before.trial.candidateId;
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === IMPORT_JOURNEY_STORAGE_KEY) {
        const candidate = JSON.parse(value) as StoredJourneyDraft;
        if (candidate.trial !== null && candidate.trial.candidateId !== firstCandidateId) {
          throw new DOMException("quota blocked", "QuotaExceededError");
        }
      }
      nativeSetItem(key, value);
    });

    try {
      await user.click(screen.getByRole("button", { name: "重新生成试改" }));
      expect(await screen.findByText(/IMPORT_JOURNEY_PERSIST_FAILED/)).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "代表段落试改结果" })).toHaveTextContent(
        "第二份试改。",
      );
      expect(readStoredJourney().trial?.candidateId).toBe(firstCandidateId);
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(
        chapterIdAt(fixture.chapterIds, 0),
      );
      if (!candidates.ok) throw candidates.error;
      expect(candidates.value.find(({ id }) => id === firstCandidateId)?.status).toBe("ready");
      expect(candidates.value.filter(({ status }) => status === "ready")).toHaveLength(2);
      expect(window.localStorage.getItem(IMPORT_REWRITE_PENDING_STORAGE_KEY)).not.toBeNull();
    } finally {
      setItem.mockRestore();
    }

    first.unmount();
    renderPage(runtime);
    expect(await screen.findByText("第一份试改。")).toBeInTheDocument();
    expect(screen.getByText(/不会自动重复调用或重复计费/)).toBeInTheDocument();
  });

  it("keeps the prior single-batch pointer when regenerated pointer persistence fails", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["试改。", "第一份整章建议。", "第二份整章建议。"]);
    const fixture = await seedImportedWork(runtime, ["逐章重生成原文。"]);
    writeDraft(fixture.completed, { selectedPresetIds: ["polish"] });
    const user = userEvent.setup();
    const first = renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByText("试改。");
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    await user.click(screen.getByRole("button", { name: "保留当前规则" }));
    await user.click(screen.getByRole("button", { name: "开始逐章处理" }));
    const batch = await screen.findByRole("list", { name: "逐章建议版本" });
    await waitFor(() => expect(batch).toHaveTextContent("建议版本已就绪"));
    const before = readStoredJourney();
    const firstItem = before.batchItems[0];
    if (firstItem?.candidateId === null || firstItem === undefined) {
      throw new Error("Expected the first batch pointer.");
    }
    const firstCandidateId = firstItem.candidateId;
    const nativeSetItem = Storage.prototype.setItem.bind(window.localStorage);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ): void {
      if (key === IMPORT_JOURNEY_STORAGE_KEY) {
        const candidate = JSON.parse(value) as StoredJourneyDraft;
        if (candidate.batchItems[0]?.candidateId !== firstCandidateId) {
          throw new DOMException("quota blocked", "QuotaExceededError");
        }
      }
      nativeSetItem(key, value);
    });

    try {
      await user.click(within(batch).getByRole("button", { name: "重新生成" }));
      expect(await screen.findByText(/IMPORT_JOURNEY_PERSIST_FAILED/)).toBeInTheDocument();
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(
        chapterIdAt(fixture.chapterIds, 0),
      );
      if (!candidates.ok) throw candidates.error;
      expect(candidates.value.find(({ id }) => id === firstCandidateId)?.status).toBe("ready");
      expect(candidates.value.filter(({ status }) => status === "ready")).toHaveLength(3);
      expect(readStoredJourney().batchItems[0]?.candidateId).toBe(firstCandidateId);
      expect(window.localStorage.getItem(IMPORT_REWRITE_PENDING_STORAGE_KEY)).not.toBeNull();
    } finally {
      setItem.mockRestore();
    }

    first.unmount();
    renderPage(runtime);
    const restoredBatch = await screen.findByRole("list", { name: "逐章建议版本" });
    expect(within(restoredBatch).getByRole("link", { name: "查看完整差异" })).toHaveAttribute(
      "href",
      expect.stringContaining(firstCandidateId),
    );
  });

  it("re-reads and restores the exact prior pointer when whole-batch cleanup sees a concurrent revision", async () => {
    const base = createDevelopmentRuntime(window.localStorage);
    const runtime = withConfiguredModel(base, ["试改。", "第一份整章建议。"]);
    const fixture = await seedImportedWork(runtime, ["并发重生成原文。"]);
    writeDraft(fixture.completed, { selectedPresetIds: ["polish"] });
    const user = userEvent.setup();
    renderPage(runtime);
    await screen.findByText("识别到 1 个有效章节。");
    await user.click(screen.getByRole("button", { name: "生成代表段落试改" }));
    await screen.findByText("试改。");
    await user.click(screen.getByRole("button", { name: "按当前目标和反馈形成规则" }));
    await user.click(screen.getByRole("button", { name: "保留当前规则" }));
    await user.click(screen.getByRole("button", { name: "开始逐章处理" }));
    const batch = await screen.findByRole("list", { name: "逐章建议版本" });
    await waitFor(() => expect(batch).toHaveTextContent("建议版本已就绪"));
    const before = readStoredJourney();
    const prior = before.batchItems[0];
    if (prior === undefined) {
      throw new Error("Expected an authoritative prior batch pointer.");
    }
    const priorCandidateId = prior.candidateId;
    const priorCandidateRevision = prior.candidateRevision;
    if (priorCandidateId === null || priorCandidateRevision === null) {
      throw new Error("Expected an authoritative prior batch pointer.");
    }
    const generate = vi.spyOn(runtime.modelGateway, "generate");
    generate.mockImplementationOnce(async (input) => {
      const revised = await runtime.useCases.reviseCandidate.execute({
        candidateId: priorCandidateId as UuidV7,
        expectedCandidateRevision: priorCandidateRevision,
        content: "另一窗口修订后的旧建议。",
      });
      if (!revised.ok) throw revised.error;
      input.onDelta?.("并发期间生成的新建议。");
      return { text: "并发期间生成的新建议。", usage: null };
    });

    await user.click(screen.getByRole("button", { name: "重新逐章生成" }));
    expect((await screen.findAllByText(/VERSION_CONFLICT/)).length).toBeGreaterThan(0);
    const recovered = readStoredJourney().batchItems[0];
    expect(recovered?.candidateId).toBe(priorCandidateId);
    expect(recovered?.candidateRevision).toBe(2);
    expect(recovered?.status).toBe("error");
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(
      chapterIdAt(fixture.chapterIds, 0),
    );
    if (!candidates.ok) throw candidates.error;
    expect(candidates.value.find(({ id }) => id === priorCandidateId)?.status).toBe("ready");
    expect(candidates.value.find(({ id }) => id !== priorCandidateId)?.status).toBe("rejected");
    expect(within(batch).getByRole("link", { name: "查看完整差异" })).toHaveAttribute(
      "href",
      expect.stringContaining(priorCandidateId),
    );
  });
});

interface StoredJourneyDraft {
  readonly trial: Readonly<{
    readonly candidateId: string;
    readonly candidateRevision: number | null;
  }> | null;
  readonly batchItems: readonly Readonly<{
    readonly candidateId: string | null;
    readonly candidateRevision: number | null;
    readonly status: string;
  }>[];
}

function readStoredJourney(): StoredJourneyDraft {
  const serialized = window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY);
  if (serialized === null) throw new Error("Expected an import journey draft.");
  return JSON.parse(serialized) as StoredJourneyDraft;
}

async function seedImportedWork(
  runtime: DesktopRuntime,
  contents: readonly string[],
): Promise<Readonly<{ completed: CompletedImport; chapterIds: readonly UuidV7[] }>> {
  const project = await runtime.useCases.createProject.execute({ name: "导入测试作品" });
  if (!project.ok) {
    throw project.error;
  }
  const chapterIds: UuidV7[] = [];
  for (const [index, content] of contents.entries()) {
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: `第 ${String(index + 1)} 章`,
      content,
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    chapterIds.push(chapter.value.chapter.id);
  }
  return {
    completed: {
      projectId: project.value.id,
      firstChapterId: chapterIdAt(chapterIds, 0),
      projectName: project.value.name,
      chapterCount: chapterIds.length,
    },
    chapterIds,
  };
}

function writeDraft(
  completed: CompletedImport,
  override: Readonly<{
    goal?: string;
    selectedPresetIds?: readonly string[];
  }>,
): void {
  window.localStorage.setItem(
    IMPORT_JOURNEY_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      goal: override.goal ?? "",
      selectedPresetIds: override.selectedPresetIds ?? [],
      importedWork: completed,
      feedbackPresetIds: [],
      feedbackText: "",
      trial: null,
      rules: [],
      rulesSavedAt: null,
      batchItems: [],
      updatedAt: new Date().toISOString(),
    }),
  );
}

function withConfiguredModel(base: DesktopRuntime, outputs: readonly string[]): DesktopRuntime {
  const queued = [...outputs];
  const profile: ModelProfile = Object.freeze({
    providerId: "test-provider",
    provider: "open_ai_compatible",
    baseUrl: "https://models.example.test/v1",
    authentication: "bearer_keyring",
    selectedModel: "novel-model",
    pricing: null,
    revision: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const gateway: NativeModelGatewayClient = {
    available: true,
    listModels: vi.fn(() =>
      Promise.resolve({
        provider: "open_ai_compatible" as const,
        models: [{ id: "novel-model", displayName: "Novel Model" }],
      }),
    ),
    checkConnection: vi.fn(() =>
      Promise.resolve({
        provider: "open_ai_compatible" as const,
        endpointOrigin: "https://models.example.test",
        modelCount: 1,
        latencyMs: 8,
      }),
    ),
    generate: vi.fn((input: NativeModelGenerationInput) => {
      const text = queued.shift();
      if (text === undefined) {
        return Promise.reject(new Error("TEST_OUTPUT_EXHAUSTED"));
      }
      input.onDelta?.(text);
      return Promise.resolve({ text, usage: null });
    }),
    cancelGeneration: vi.fn(() => Promise.resolve(true)),
    embed: vi.fn(() =>
      Promise.resolve({
        provider: "open_ai_compatible" as const,
        endpointOrigin: "https://models.example.test",
        model: "novel-model",
        dimension: 1,
        vectorCount: 1,
        embeddings: [[1]],
      }),
    ),
  };
  return {
    ...base,
    mode: "tauri",
    modelCenter: {
      listProfiles: () => Promise.resolve([profile]),
      findByProviderId: () => Promise.resolve(profile),
      save: () => Promise.resolve(profile),
    },
    modelGateway: gateway,
    credentials: {
      getSummary: () => Promise.resolve({ configured: true, lastFour: "test" }),
      save: () => Promise.resolve({ configured: true, lastFour: "test" }),
      delete: () => Promise.resolve({ configured: false, lastFour: null }),
    },
  };
}

async function seedAnalysisRoutes(modelHub: ModelHubStore): Promise<void> {
  await seedAnalysisRoute(modelHub, "character_extraction", "character");
  await seedAnalysisRoute(modelHub, "world_extraction", "story");
}

async function seedAnalysisRoute(
  modelHub: ModelHubStore,
  task: Extract<NovelAiTask, "character_extraction" | "world_extraction" | "rewrite">,
  prefix: string,
): Promise<void> {
  const connection = await modelHub.saveConnection({
    id: `${prefix}-analysis-connection`,
    providerKind: "google_gemini",
    displayName: `${prefix} analysis`,
    credentialRef: `keyring:model-hub:${prefix}`,
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await modelHub.syncCatalog({
    syncId: `${prefix}-analysis-sync`,
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: `${prefix}-analysis-catalog`,
        providerModelId: `${prefix}-analysis-model`,
        lifecycle: "stable",
        inputTokenLimit: 500_000,
        outputTokenLimit: 20_000,
        staleAfter: "2030-01-01T00:00:00.000Z",
      },
    ],
  });
  await modelHub.recordCapabilityScan({
    scanId: `${prefix}-analysis-scan`,
    catalogEntryId: `${prefix}-analysis-catalog`,
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "import-page-test-v1",
    evidence: [
      {
        id: `${prefix}-analysis-text-evidence`,
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
      {
        id: `${prefix}-analysis-structured-evidence`,
        capability: "structured_output",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: `${prefix}-analysis-catalog`,
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    cachedInputMicrosPerMillionTokens: "0",
    pricingVersion: "zero-cost-v1",
    priceUpdatedAt: "2026-08-01T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "import-page-test-v1",
    expectedRevision: null,
  });
  await modelHub.saveTaskRoute({
    task,
    primaryCatalogEntryId: `${prefix}-analysis-catalog`,
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

function analysisResponse(
  input: Readonly<{
    chapterId: UuidV7;
    versionId: UuidV7;
    content: string;
    factType: string;
    statement: string;
    subjects: readonly string[];
    relation: string | null;
  }>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    source: {
      chapterId: input.chapterId,
      versionId: input.versionId,
      chunkIndex: 0,
      chunkStart: 0,
      chunkLength: input.content.length,
    },
    findings: [
      {
        factType: input.factType,
        statement: input.statement,
        subjects: input.subjects,
        relation: input.relation,
        confidence: 0.9,
        evidence: {
          startOffset: 0,
          endOffset: input.content.length,
          excerpt: input.content,
        },
      },
    ],
  });
}

function chapterIdAt(chapterIds: readonly UuidV7[], index: number): UuidV7 {
  const chapterId = chapterIds[index];
  if (chapterId === undefined) {
    throw new Error(`Expected chapter ID at index ${String(index)}.`);
  }
  return chapterId;
}

function renderPage(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter>
      <RuntimeProvider runtime={runtime}>
        <ImportJourneyPage />
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
