import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import {
  AiCandidate,
  AppError,
  err,
  type AiCandidateApplicationIntent,
  type AiCandidateSource,
  type Chapter,
  type Project,
} from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7 } from "@inkshadow/story-core";
import { ToastProvider } from "@inkshadow/ui";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import {
  EDITOR_PREFERENCES_STORAGE_KEY,
  saveEditorPreferences,
} from "../infrastructure/editor-preferences-store";
import { RuntimeProvider } from "../runtime-context";
import { WRITING_EXPERIENCE_CHANGED_EVENT } from "../hooks/use-writing-experience";

describe("editor candidate route selection", () => {
  it("shows the bounded one-time local organization notice received from direct opening", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    renderEditor(runtime, project, chapter, "", {
      directOpeningOrganization: {
        kind: "direct_opening_local_organization",
        status: "organized",
        organizedCount: 1,
        importantReviewCount: 1,
      },
    });

    expect(await screen.findByText("已整理 1 条；有 1 条重要设定需要你确认。")).toBeVisible();
    expect(screen.queryByText(/direct_opening|LOCAL_|MODEL_/u)).not.toBeInTheDocument();
  });

  it("keeps a direct-mode Candidate isolated until the author explicitly accepts it", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("direct");
    await runtime.writingExperience.authorizeDirectMode(1);
    const { chapter, project } = await seedChapter(runtime);
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "继续写" }));

    await waitFor(async () => {
      const savedCandidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(savedCandidates.ok && savedCandidates.value.length).toBe(1);
    });
    expect(
      screen.queryByText(
        "本机安全检查没有完整通过，本次结果已保留为隔离 Candidate，等待你查看后决定。",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/生成期间.*已保留为隔离 Candidate|正文仍有.*隔离 Candidate/u),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "本次建议不是仅追加到章末的低风险续写，已保留为隔离 Candidate，等待你明确决定。",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "本次结果不完整、已取消或来源不确定，已保留为隔离 Candidate，正文和版本没有改变。",
      ),
    ).not.toBeInTheDocument();
    await waitFor(async () => {
      const savedCandidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(savedCandidates.ok && savedCandidates.value[0]?.status).toBe("ready");
    });
    const beforeAcceptance = await runtime.repositories.chapters.findById(chapter.id);
    expect(beforeAcceptance.ok && beforeAcceptance.value?.content).toBe(chapter.content);
    const versionsWhileReady = await runtime.repositories.chapterVersions.listByChapterId(
      chapter.id,
    );
    expect(versionsWhileReady.ok && versionsWhileReady.value).toHaveLength(
      versionsBefore.value.length,
    );
    await user.click(screen.getByRole("button", { name: "使用这版" }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));
    await waitFor(async () => {
      const savedCandidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(savedCandidates.ok && savedCandidates.value[0]?.status).toBe("accepted");
    });
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    if (!candidates.ok) throw candidates.error;
    expect(candidates.value).toHaveLength(1);
    expect(candidates.value[0]?.status).toBe("accepted");
    const saved = await runtime.repositories.chapters.findById(chapter.id);
    expect(saved.ok && saved.value?.content.length).toBeGreaterThan(chapter.content.length);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(versionsBefore.value.length + 1);
    for (const immutableVersion of versionsBefore.value) {
      expect(
        versionsAfter.value.find((version) => version.id === immutableVersion.id)?.toSnapshot(),
      ).toEqual(immutableVersion.toSnapshot());
    }
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("keeps an unauthorized new-install direct Candidate isolated after the notice is cancelled", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    expect(preference).toMatchObject({
      mode: "direct",
      directLocalOrganizationAuthorizedAt: null,
    });
    const { chapter, project } = await seedChapter(runtime);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "生成示例建议" }));

    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    });
    const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
    expect(savedChapter.ok && savedChapter.value?.content).toBe(chapter.content);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versionsAfter.ok && versionsAfter.value).toHaveLength(versionsBefore.value.length);
    expect(screen.getByRole("button", { name: /比较.*建议/u })).toBeVisible();
  });

  it("requires an exact disclosure before one fake remote call and persists the matching grant", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    expect((await runtime.writingExperience.getOrInitialize()).mode).toBe("direct");
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const generatedText =
      "\n林晚来到旧站台。雨沿着玻璃一层层滑下。林晚把那封没有署名的信重新折好，听见远处列车驶入隧道的回声。她没有立刻追上去，只把日记里新出现的一行字记在掌心，然后沿着灯光最暗的方向继续走。";
    let resolveGeneration!: (
      value: Awaited<ReturnType<NativeModelGatewayClient["generate"]>>,
    ) => void;
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    Object.assign(runtime, {
      mode: "tauri" as const,
      modelGateway: {
        available: true,
        listModels: () =>
          Promise.resolve({
            provider: "open_ai_compatible" as const,
            models: [{ id: "direct-writer", displayName: "Direct writer" }],
          }),
        checkConnection: () => Promise.reject(new Error("not used")),
        embed: () => Promise.reject(new Error("not used")),
        generate,
        cancelGeneration: () => Promise.resolve(true),
      } satisfies NativeModelGatewayClient,
    });
    const { chapter, project } = await seedChapter(runtime);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "继续写" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    expect(
      await within(preflight).findByText(
        /Direct writing remote.*direct-writer.*本次最多调用 1 次，自动重试 0 次/u,
      ),
    ).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /确认并开始|使用安全默认值并开始/u }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await runtime.writingExperience.revokeDirectModeAuthorization(2);
    window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
    resolveGeneration({
      text: generatedText,
      usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
    });

    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await runtime.writingExperience.listActiveDisclosureGrants()).toHaveLength(1);
    const storyProjectId = parseStoryUuidV7(project.id);
    if (!storyProjectId.ok) throw storyProjectId.error;
    await waitFor(async () => {
      const facts = await runtime.story.facts.listByProjectId(storyProjectId.value);
      expect(facts.ok && facts.value).toEqual([]);
    });
  });

  it("requires a fresh exact disclosure before a professional continuation Provider call", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((input) =>
      Promise.resolve({
        text: "\n林晚沿着旧站台继续前行。雨声盖住了远处的脚步，她把信纸收进衣袋，在灯影尽头看见了一扇刚刚打开的门。",
        usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
      }).then((result) => {
        expect(input.config.retryLimit).toBe(0);
        return result;
      }),
    );
    Object.assign(runtime, {
      mode: "tauri" as const,
      modelGateway: {
        available: true,
        listModels: () =>
          Promise.resolve({
            provider: "open_ai_compatible" as const,
            models: [{ id: "direct-writer", displayName: "Direct writer" }],
          }),
        checkConnection: () => Promise.reject(new Error("not used")),
        embed: () => Promise.reject(new Error("not used")),
        generate,
        cancelGeneration: () => Promise.resolve(true),
      } satisfies NativeModelGatewayClient,
    });
    const { chapter, project } = await seedChapter(runtime);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "生成续写建议" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    expect(
      await within(preflight).findByText(
        /Direct writing remote.*direct-writer.*本次最多调用 1 次，自动重试 0 次/u,
      ),
    ).toBeVisible();
    expect(within(preflight).getByText(/当前章节.*故事资料/u)).toBeVisible();
    expect(preflight).not.toHaveTextContent("direct-writing-remote-connection");
    expect(generate).not.toHaveBeenCalled();

    await user.click(within(preflight).getByRole("button", { name: "暂不生成" }));
    expect(generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "生成续写建议" }));
    const confirmedPreflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await user.click(
      within(confirmedPreflight).getByRole("button", {
        name: /确认并开始|使用安全默认值并开始/u,
      }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });

  it("stops a professional continuation before dispatch when the disclosed price changes", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const preference = await runtime.writingExperience.getOrInitialize();
    await runtime.writingExperience.switchMode("professional", preference.revision);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({ text: "不应发送", usage: null }),
    );
    Object.assign(runtime, {
      mode: "tauri" as const,
      modelGateway: {
        available: true,
        listModels: () =>
          Promise.resolve({
            provider: "open_ai_compatible" as const,
            models: [{ id: "direct-writer", displayName: "Direct writer" }],
          }),
        checkConnection: () => Promise.reject(new Error("not used")),
        embed: () => Promise.reject(new Error("not used")),
        generate,
        cancelGeneration: () => Promise.resolve(true),
      } satisfies NativeModelGatewayClient,
    });
    const { chapter, project } = await seedChapter(runtime);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "生成续写建议" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    const pricing = await runtime.modelHub.findCostPrivacyProfile("direct-writing-remote-catalog");
    if (pricing === null) throw new Error("Expected the disclosed pricing profile.");
    await runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: pricing.catalogEntryId,
      currency: pricing.currency,
      inputMicrosPerMillionTokens: pricing.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: "3000000",
      cachedInputMicrosPerMillionTokens: pricing.cachedInputMicrosPerMillionTokens,
      pricingVersion: "direct-writing-test-v2",
      priceUpdatedAt: "2026-08-20T00:00:00.000Z",
      dataDestination: pricing.dataDestination,
      retentionPolicy: pricing.retentionPolicy,
      trainingPolicy: pricing.trainingPolicy,
      evidenceSource: pricing.evidenceSource,
      evidenceVersion: "direct-writing-test-v2",
      evidenceSummary: pricing.evidenceSummary,
      expectedRevision: pricing.revision,
    });

    await user.click(
      within(preflight).getByRole("button", {
        name: /确认并开始|使用安全默认值并开始/u,
      }),
    );
    expect(await screen.findByText("正文和已保存版本没有变化，你可以继续写作。")).toBeVisible();
    expect(generate).not.toHaveBeenCalled();
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    expect(candidates.ok && candidates.value).toEqual([]);
  });

  it("rechecks direct authority before dispatch and makes zero calls after revocation", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve({ text: "不应生成", usage: null }),
    );
    Object.assign(runtime, {
      mode: "tauri" as const,
      modelGateway: {
        available: true,
        listModels: () =>
          Promise.resolve({
            provider: "open_ai_compatible" as const,
            models: [{ id: "direct-writer", displayName: "Direct writer" }],
          }),
        checkConnection: () => Promise.reject(new Error("not used")),
        embed: () => Promise.reject(new Error("not used")),
        generate,
        cancelGeneration: () => Promise.resolve(true),
      } satisfies NativeModelGatewayClient,
    });
    const { chapter, project } = await seedChapter(runtime);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "继续写" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await runtime.writingExperience.revokeDirectModeAuthorization(2);
    window.dispatchEvent(new Event(WRITING_EXPERIENCE_CHANGED_EVENT));
    await user.click(
      within(preflight).getByRole("button", { name: /确认并开始|使用安全默认值并开始/u }),
    );

    await waitFor(() => expect(generate).not.toHaveBeenCalled());
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    expect(candidates.ok && candidates.value).toEqual([]);
    expect(await runtime.writingExperience.listActiveDisclosureGrants()).toHaveLength(0);
  });

  it("keeps a delayed direct Candidate isolated while the author continues editing", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    await seedRemoteContinuationRoute(runtime);
    const generatedText =
      "\n林晚来到旧站台。雨沿着玻璃一层层滑下。林晚把那封没有署名的信重新折好，听见远处列车驶入隧道的回声。她没有立刻追上去，只把日记里新出现的一行字记在掌心，然后沿着灯光最暗的方向继续走。";
    let resolveGeneration!: (
      value: Awaited<ReturnType<NativeModelGatewayClient["generate"]>>,
    ) => void;
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    Object.assign(runtime, {
      mode: "tauri" as const,
      modelGateway: {
        available: true,
        listModels: () =>
          Promise.resolve({
            provider: "open_ai_compatible" as const,
            models: [{ id: "direct-writer", displayName: "Direct writer" }],
          }),
        checkConnection: () => Promise.reject(new Error("not used")),
        embed: () => Promise.reject(new Error("not used")),
        generate,
        cancelGeneration: () => Promise.resolve(true),
      } satisfies NativeModelGatewayClient,
    });
    const { chapter, project } = await seedChapter(runtime);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    saveEditorPreferences(window.localStorage, {
      autosaveEnabled: true,
      autosaveDebounceMs: 5_000,
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);
    window.localStorage.removeItem(EDITOR_PREFERENCES_STORAGE_KEY);

    await user.click(await screen.findByRole("button", { name: "继续写" }));
    const preflight = await screen.findByRole("dialog", { name: "生成前检查" });
    await user.click(
      within(preflight).getByRole("button", { name: /确认并开始|使用安全默认值并开始/u }),
    );
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const editor = screen.getByRole("textbox", { name: "章节正文" });
    await user.click(editor);
    await user.keyboard("{End}作者仍在写");
    expect(editor).toHaveValue(`${chapter.content}作者仍在写`);

    resolveGeneration({
      text: generatedText,
      usage: { inputTokens: 120, outputTokens: 80, cachedInputTokens: null },
    });

    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    });
    expect(
      screen.queryByText(
        "正文仍有尚未完成的本地保存，本次结果已保留为隔离 Candidate，没有自动写入正文。",
      ),
    ).not.toBeInTheDocument();
    expect(accept).not.toHaveBeenCalled();
    expect(editor).toHaveValue(`${chapter.content}作者仍在写`);
    const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
    expect(savedChapter.ok && savedChapter.value?.content).toBe(chapter.content);
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versionsAfter.ok && versionsAfter.value).toHaveLength(versionsBefore.value.length);
  });

  it("does not start a Candidate acceptance transaction after direct generation", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.writingExperience.authorizeDirectMode(1);
    const { chapter, project } = await seedChapter(runtime);
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter);

    await user.click(await screen.findByRole("button", { name: "继续写" }));
    await waitFor(async () => {
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
      expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    });
    const editor = screen.getByRole("textbox", { name: "章节正文" });
    expect(editor).not.toHaveAttribute("readonly");
    expect(editor).toHaveValue(chapter.content);
    expect(accept).not.toHaveBeenCalled();
  });

  it("locks editor input while a manual Candidate acceptance is pending", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const { chapter, project } = await seedChapter(runtime);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const candidate = await createReadyCandidate(runtime, project, chapter, "手动接受的追加正文", {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const executeAcceptance = runtime.useCases.acceptCandidate.execute.bind(
      runtime.useCases.acceptCandidate,
    );
    let releaseAcceptance!: () => void;
    const acceptanceGate = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    let markAcceptanceStarted!: () => void;
    const acceptanceStarted = new Promise<void>((resolve) => {
      markAcceptanceStarted = resolve;
    });
    const accept = vi
      .spyOn(runtime.useCases.acceptCandidate, "execute")
      .mockImplementation(async (input) => {
        markAcceptanceStarted();
        await acceptanceGate;
        return executeAcceptance(input);
      });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    const acceptButton = within(review).getByRole("button", { name: "使用这版" });
    await user.click(acceptButton);
    await acceptanceStarted;
    fireEvent.click(acceptButton);
    expect(accept).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(editor).toHaveAttribute("readonly"));
    expect(review.querySelector(".ink-overlay__footer .ink-button--ai-primary")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(review.querySelector(".ink-overlay__footer")).toBeVisible();
    fireEvent.change(editor, { target: { value: `${chapter.content}不应进入的输入` } });
    expect(editor).toHaveValue(chapter.content);

    releaseAcceptance();
    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    expect(editor).toHaveValue(`${chapter.content}${candidate.content}`);
    expect(providerGenerate).not.toHaveBeenCalled();
    const persistedCandidate = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(persistedCandidate.ok && persistedCandidate.value?.status).toBe("accepted");
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(versionsBefore.value.length + 1);
    const originalVersion = versionsBefore.value[0];
    expect(
      versionsAfter.value.find((version) => version.id === originalVersion?.id)?.toSnapshot(),
    ).toEqual(originalVersion?.toSnapshot());
  });

  it("releases a native acceptance after its atomic commit without waiting for derived work", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    Object.assign(runtime, { mode: "tauri" as const });
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "提交后的本地派生可稍后继续",
      {
        source: "polish",
        applicationIntent: {
          task: "continuation",
          application: "insert_at_cursor",
          payload: "fragment",
          startUtf16: chapter.content.length,
          endUtf16: chapter.content.length,
        },
      },
    );
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const originalFindTask = runtime.taskCenter.findTaskByIdempotencyKey.bind(runtime.taskCenter);
    let markTaskLookupStarted!: () => void;
    const taskLookupStarted = new Promise<void>((resolve) => {
      markTaskLookupStarted = resolve;
    });
    let releaseTaskLookup!: () => void;
    const taskLookupGate = new Promise<void>((resolve) => {
      releaseTaskLookup = resolve;
    });
    vi.spyOn(runtime.taskCenter, "findTaskByIdempotencyKey").mockImplementation(async (key) => {
      markTaskLookupStarted();
      await taskLookupGate;
      return originalFindTask(key);
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));
    await taskLookupStarted;

    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    expect(editor).toHaveValue(`${chapter.content}${candidate.content}`);
    expect(providerGenerate).not.toHaveBeenCalled();
    const accepted = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(accepted.ok && accepted.value?.status).toBe("accepted");
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(versionsBefore.value.length + 1);
    const originalVersion = versionsBefore.value[0];
    expect(
      versionsAfter.value.find((version) => version.id === originalVersion?.id)?.toSnapshot(),
    ).toEqual(originalVersion?.toSnapshot());

    releaseTaskLookup();
  });

  it("keeps the suggestion isolated when a commit receipt cannot be confirmed", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "结果未知时不得再次提交",
      {
        source: "polish",
        applicationIntent: {
          task: "continuation",
          application: "insert_at_cursor",
          payload: "fragment",
          startUtf16: chapter.content.length,
          endUtf16: chapter.content.length,
        },
      },
    );
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    vi.spyOn(runtime.useCases.acceptCandidate, "execute").mockResolvedValue(
      err(
        new AppError({
          code: "REPOSITORY_ERROR",
          message: "private commit phase",
          retryable: false,
          actions: ["EXPORT_DRAFT"],
          details: {
            databaseCode: "SQLITE_COMMIT_OUTCOME_UNKNOWN",
            operation: "private SQL",
            outcome: "unknown",
          },
        }),
      ),
    );
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    const unknownOutcomeNotices = await screen.findAllByText(
      "本机暂时无法确认这次写入是否已经完成。请重新打开当前页面，核对正文、版本和 AI 建议草稿状态；系统不会自动再次提交。",
    );
    expect(unknownOutcomeNotices.length).toBeGreaterThan(0);
    for (const notice of unknownOutcomeNotices) expect(notice).toBeVisible();
    expect(editor).toHaveValue(chapter.content);
    expect(editor).not.toHaveAttribute("readonly");
    expect(providerGenerate).not.toHaveBeenCalled();
    const persistedCandidate = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(persistedCandidate.ok && persistedCandidate.value?.status).toBe("ready");
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versionsAfter.ok && versionsAfter.value).toEqual(versionsBefore.value);
    expect(document.body).not.toHaveTextContent("SQLITE_COMMIT_OUTCOME_UNKNOWN");
    expect(document.body).not.toHaveTextContent("private SQL");
  });

  it("does not dispatch manual Candidate acceptance when the chapter became dirty", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "不得覆盖的建议", {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const accept = vi.spyOn(runtime.useCases.acceptCandidate, "execute");
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    fireEvent.change(editor, { target: { value: `${chapter.content}用户新输入` } });
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    expect(
      await screen.findByText(
        "正文仍有尚未完成的本地保存；这份 AI 建议草稿继续保持隔离，没有写入正文或创建版本。",
      ),
    ).toBeVisible();
    expect(accept).not.toHaveBeenCalled();
    expect(editor).toHaveValue(`${chapter.content}用户新输入`);
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapter.id);
    expect(candidates.ok && candidates.value[0]?.status).toBe("ready");
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    expect(versionsAfter.ok && versionsAfter.value).toHaveLength(versionsBefore.value.length);
  });

  it("locks editor input while a version restore transaction is pending", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const seeded = await seedChapter(runtime);
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: seeded.chapter.id,
      expectedRevision: seeded.chapter.revision,
      content: "当前第二版正文",
      cursorOffset: 7,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: seeded.chapter.id,
      expectedRevision: seeded.chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    const restoreVersion = runtime.useCases.restoreChapterVersion.execute.bind(
      runtime.useCases.restoreChapterVersion,
    );
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let markRestoreStarted!: () => void;
    const restoreStarted = new Promise<void>((resolve) => {
      markRestoreStarted = resolve;
    });
    vi.spyOn(runtime.useCases.restoreChapterVersion, "execute").mockImplementation(
      async (input) => {
        markRestoreStarted();
        await restoreGate;
        return restoreVersion(input);
      },
    );
    const user = userEvent.setup();
    renderEditor(runtime, seeded.project, saved.value.chapter);
    const editor = await screen.findByRole("textbox", { name: "章节正文" });

    await user.click(screen.getByRole("button", { name: "版本历史" }));
    const history = await screen.findByRole("dialog", { name: "版本历史" });
    await user.click(within(history).getByRole("button", { name: "恢复此版本" }));
    const restore = await screen.findByRole("dialog", { name: /恢复版本/u });
    await user.click(within(restore).getByRole("button", { name: "创建恢复版本" }));
    await restoreStarted;
    await waitFor(() => expect(editor).toHaveAttribute("readonly"));
    fireEvent.change(editor, { target: { value: "恢复期间不应进入的输入" } });
    expect(editor).toHaveValue(saved.value.chapter.content);

    releaseRestore();
    await waitFor(() => expect(editor).not.toHaveAttribute("readonly"));
    expect(editor).toHaveValue(seeded.chapter.content);
  });

  it("opens the exact ready UUIDv7 candidate requested by the query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const requested = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "路由明确指定的候选正文",
    );
    await createReadyCandidate(runtime, project, chapter, "不应替代指定候选的其他正文");

    renderEditor(runtime, project, chapter, `?candidate=${requested.id}`);

    expect(await screen.findByText("路由明确指定的候选正文")).toBeVisible();
    expect(screen.queryByText("不应替代指定候选的其他正文")).not.toBeInTheDocument();
  });

  it("keeps a locally generated opening labeled as a local draft after entering the editor", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "本地开头草案", {
      source: "generate",
    });
    const now = runtime.clock.now();
    await runtime.creativeJourneys.create(
      {
        id: candidate.id,
        kind: "idea",
        status: "active",
        currentState: "opening_selected",
        projectId: project.id,
        chapterId: chapter.id,
        candidateId: null,
        revision: 1,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      {
        id: runtime.ids.next(),
        journeyId: candidate.id,
        sequence: 1,
        kind: "idea",
        questionKey: null,
        generationSource: "local_fallback",
        providerId: null,
        modelId: null,
        taskKey: null,
        requestId: null,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
      },
    );
    await runtime.creativeJourneys.update(
      {
        id: candidate.id,
        kind: "idea",
        status: "completed",
        currentState: "candidate_ready",
        projectId: project.id,
        chapterId: chapter.id,
        candidateId: candidate.id,
        revision: 2,
        snapshot: { previewSource: "local_fallback" },
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
      1,
      {
        id: runtime.ids.next(),
        journeyId: candidate.id,
        sequence: 2,
        kind: "keep",
        questionKey: null,
        generationSource: "local_fallback",
        providerId: null,
        modelId: null,
        taskKey: null,
        requestId: null,
        snapshot: { candidateId: candidate.id, previewSource: "local_fallback" },
        createdAt: now,
      },
    );

    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看本地草案版本" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "比较本地草案" }));
    expect(await screen.findByRole("dialog", { name: "比较本地草案与正文" })).toBeVisible();
  });

  it("uses a neutral label when a generate candidate has no trustworthy origin receipt", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "来源记录缺失的候选", {
      source: "generate",
    });

    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看建议版本" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 AI 建议版本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看本地草案版本" })).not.toBeInTheDocument();
  });

  it("does not relabel a generate candidate as AI when its origin receipt cannot be read", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(
      runtime,
      project,
      chapter,
      "来源记录读取失败的候选",
      {
        source: "generate",
      },
    );
    vi.spyOn(runtime.creativeJourneys, "findById").mockRejectedValueOnce(
      new Error("journey unavailable"),
    );

    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    expect(await screen.findByRole("button", { name: "查看建议版本" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "查看 AI 建议版本" })).not.toBeInTheDocument();
  });

  it("shows a visible error and does not fall back for an invalid candidate query", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    await createReadyCandidate(runtime, project, chapter, "不可静默打开的默认候选");

    renderEditor(runtime, project, chapter, "?candidate=not-a-uuid");

    expect(
      await screen.findByText("AI 建议链接无效；未自动打开其他建议。请从深度审稿页重新选择。"),
    ).toBeVisible();
    expect(screen.queryByText("不可静默打开的默认候选")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "还没有 AI 建议版本" })).toBeVisible();
  });

  it("rejects a ready candidate from another chapter without opening the local default", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const otherChapterResult = await runtime.useCases.createChapter.execute({
      projectId: project.id,
      title: "第二章",
      content: "第二章稳定正文",
    });
    if (!otherChapterResult.ok) {
      throw otherChapterResult.error;
    }
    const crossChapter = await createReadyCandidate(
      runtime,
      project,
      otherChapterResult.value.chapter,
      "其他章节候选",
    );
    await createReadyCandidate(runtime, project, chapter, "当前章节默认候选");

    renderEditor(runtime, project, chapter, `?candidate=${crossChapter.id}`);

    expect(
      await screen.findByText(
        "链接指定的 AI 建议不存在、已处理，或不属于当前项目与章节；未自动打开其他建议。",
      ),
    ).toBeVisible();
    expect(screen.queryByText("当前章节默认候选")).not.toBeInTheDocument();
    expect(screen.queryByText("其他章节候选")).not.toBeInTheDocument();
  });

  it("rejects a non-ready candidate and exposes the multi-agent review link only when enabled", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const streaming = AiCandidate.createStreaming({
      id: runtime.ids.next(),
      projectId: project.id,
      chapterId: chapter.id,
      source: "agent",
      baseVersionId: chapter.currentVersionId,
      now: runtime.clock.now(),
    });
    if (!streaming.ok) {
      throw streaming.error;
    }
    const created = await runtime.repositories.aiCandidates.create(streaming.value);
    if (!created.ok) {
      throw created.error;
    }
    Object.assign(runtime, {
      featureFlags: Object.freeze({ ...runtime.featureFlags, multiAgent: true }),
      multiAgentReview: Object.freeze({}),
    });

    renderEditor(runtime, project, chapter, `?candidate=${streaming.value.id}`);

    expect(
      await screen.findByText(
        "链接指定的 AI 建议不存在、已处理，或不属于当前项目与章节；未自动打开其他建议。",
      ),
    ).toBeVisible();
    await userEvent.setup().click(screen.getByText("高级工具"));
    expect(
      screen
        .getAllByRole("link", { name: "深度审稿" })
        .find(
          (link) =>
            link.getAttribute("href") ===
            `/projects/${project.id}/chapters/${chapter.id}/multi-agent-review`,
        ),
    ).toBeVisible();
  });

  it("uses the persisted selection-rewrite anchor instead of the current editor selection", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "新稿", {
      source: "polish",
      applicationIntent: {
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16: 2,
        endUtf16: 4,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: "比较 AI 建议" }));
    const review = await screen.findByRole("dialog", { name: "比较 AI 建议与正文" });
    expect(within(review).getByText(/第 2 到第 4 个字符/u)).toBeVisible();
    await user.click(within(review).getByRole("button", { name: "替换选区并创建版本" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "章节正文" })).toHaveValue("稳定新稿"),
    );
  });

  it("offers the four explicit whole-chapter rewrite outcomes", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "整章改写正文", {
      source: "polish",
      applicationIntent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: "比较 AI 建议" }));
    const review = await screen.findByRole("dialog", { name: "比较 AI 建议与正文" });
    expect(within(review).getByRole("button", { name: "取消" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "替换整章并创建版本" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "追加到章末并创建版本" })).toBeEnabled();
    expect(within(review).getByRole("button", { name: "保存为新草稿" })).toBeEnabled();
  });

  it.each([5_000, 10_681, 20_000, 50_000])(
    "keeps a %i-character continuation complete and reachable through the fixed decision footer",
    async (characterCount) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const { chapter, project } = await seedChapter(runtime);
      const generatedContent = "长".repeat(characterCount);
      const candidate = await createReadyCandidate(runtime, project, chapter, generatedContent, {
        source: "polish",
        applicationIntent: {
          task: "continuation",
          application: "insert_at_cursor",
          payload: "fragment",
          startUtf16: chapter.content.length,
          endUtf16: chapter.content.length,
        },
      });
      const providerGenerate = vi.spyOn(runtime.modelGateway, "generate");
      const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      if (!versionsBefore.ok) {
        throw versionsBefore.error;
      }
      const immutableVersionsBefore = versionsBefore.value.map((version) => version.toSnapshot());
      const user = userEvent.setup();
      renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

      await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
      const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
      expect(within(review).getByRole("textbox")).toHaveValue(generatedContent);
      expect(within(review).getByRole("button", { name: "使用这版" })).toBeVisible();
      expect(within(review).getByRole("button", { name: "放弃" })).toBeVisible();

      await user.click(within(review).getByRole("button", { name: "使用这版" }));

      await waitFor(async () => {
        const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
        expect(savedChapter.ok && savedChapter.value?.content).toBe(
          `${chapter.content}${generatedContent}`,
        );
      });
      const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      if (!versionsAfter.ok) {
        throw versionsAfter.error;
      }
      expect(versionsAfter.value).toHaveLength(immutableVersionsBefore.length + 1);
      for (const immutableVersion of immutableVersionsBefore) {
        expect(
          versionsAfter.value.find((version) => version.id === immutableVersion.id)?.toSnapshot(),
        ).toEqual(immutableVersion);
      }
      expect(providerGenerate).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      characterCount: 10_681,
      expectedContent: (stable: string, candidate: string) =>
        `${stable.slice(0, 2)}${candidate}${stable.slice(4)}`,
      intent: {
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16: 2,
        endUtf16: 4,
      } satisfies AiCandidateApplicationIntent,
      action: "替换选区并创建版本",
    },
    {
      characterCount: 20_000,
      expectedContent: (_stable: string, candidate: string) => candidate,
      intent: {
        task: "whole_chapter_rewrite",
        application: "replace_document",
        payload: "full_document",
        startUtf16: null,
        endUtf16: null,
      } satisfies AiCandidateApplicationIntent,
      action: "替换整章并创建版本",
    },
  ])(
    "applies the complete $characterCount-character $intent.task Candidate through its explicit action",
    async ({ action, characterCount, expectedContent, intent }) => {
      const runtime = createDevelopmentRuntime(window.localStorage);
      const { chapter, project } = await seedChapter(runtime);
      const generatedContent = "候".repeat(characterCount);
      const candidate = await createReadyCandidate(runtime, project, chapter, generatedContent, {
        source: "polish",
        applicationIntent: intent,
      });
      const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      if (!versionsBefore.ok) throw versionsBefore.error;
      const immutableVersionsBefore = versionsBefore.value.map((version) => version.toSnapshot());
      const user = userEvent.setup();
      renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

      await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
      const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
      expect(within(review).getByRole("textbox")).toHaveValue(generatedContent);
      await user.click(within(review).getByRole("button", { name: action }));

      await waitFor(async () => {
        const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
        expect(savedChapter.ok && savedChapter.value?.content).toBe(
          expectedContent(chapter.content, generatedContent),
        );
      });
      const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
      if (!versionsAfter.ok) throw versionsAfter.error;
      expect(versionsAfter.value).toHaveLength(immutableVersionsBefore.length + 1);
      for (const immutableVersion of immutableVersionsBefore) {
        expect(
          versionsAfter.value.find((version) => version.id === immutableVersion.id)?.toSnapshot(),
        ).toEqual(immutableVersion);
      }
    },
  );

  it("accepts an exact 50,000-character author-edited Candidate without changing its base version", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "原".repeat(5_000), {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsBefore.ok) throw versionsBefore.error;
    const immutableVersionsBefore = versionsBefore.value.map((version) => version.toSnapshot());
    const editedContent = "改".repeat(50_000);
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    fireEvent.change(within(review).getByRole("textbox"), { target: { value: editedContent } });
    expect(within(review).getByText("50,000 字符", { exact: true })).toBeVisible();
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    await waitFor(async () => {
      const savedChapter = await runtime.repositories.chapters.findById(chapter.id);
      expect(savedChapter.ok && savedChapter.value?.content).toBe(
        `${chapter.content}${editedContent}`,
      );
    });
    const versionsAfter = await runtime.repositories.chapterVersions.listByChapterId(chapter.id);
    if (!versionsAfter.ok) throw versionsAfter.error;
    expect(versionsAfter.value).toHaveLength(immutableVersionsBefore.length + 1);
    for (const immutableVersion of immutableVersionsBefore) {
      expect(
        versionsAfter.value.find((version) => version.id === immutableVersion.id)?.toSnapshot(),
      ).toEqual(immutableVersion);
    }
  });

  it("keeps a 20,000-character stale Candidate complete behind a bounded three-way conflict", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const generatedContent = "冲".repeat(20_000);
    const candidate = await createReadyCandidate(runtime, project, chapter, generatedContent, {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const changedContent = "当前稳定正文".repeat(1_000).slice(0, 5_000);
    const edited = await runtime.useCases.editChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      content: changedContent,
      cursorOffset: changedContent.length,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: chapter.id,
      expectedRevision: chapter.revision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    const user = userEvent.setup();
    renderEditor(runtime, project, saved.value.chapter, `?candidate=${candidate.id}`);

    const trigger = await screen.findByRole("button", { name: /比较.*建议/u });
    await user.click(trigger);
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    expect(within(review).getByText("正文已在建议生成后变化")).toBeVisible();
    expect(within(review).getByRole("button", { name: "使用这版" })).toBeDisabled();
    expect(within(review).getAllByText(/预览已截断，完整内容仍保留/u)).toHaveLength(2);
    expect(within(review).queryByText(generatedContent)).not.toBeInTheDocument();
    const persisted = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(persisted.ok && persisted.value?.content).toBe(generatedContent);
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe(changedContent);
  });

  it("keeps a failed Candidate decision visible inside the bounded review", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "错".repeat(10_681), {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    await user.click(await screen.findByRole("button", { name: /比较.*建议/u }));
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    const concurrentRevision = await runtime.useCases.reviseCandidate.execute({
      candidateId: candidate.id,
      expectedCandidateRevision: candidate.revision,
      content: "另一个窗口保存的候选修改",
    });
    if (!concurrentRevision.ok) throw concurrentRevision.error;
    await user.click(within(review).getByRole("button", { name: "使用这版" }));

    expect(await within(review).findByText(/比较提示/u)).toBeVisible();
    expect(review.querySelector(".ink-overlay__footer")).toBeVisible();
    expect(review).toBeVisible();
    const stable = await runtime.repositories.chapters.findById(chapter.id);
    expect(stable.ok && stable.value?.content).toBe(chapter.content);
    const persisted = await runtime.repositories.aiCandidates.findById(candidate.id);
    expect(persisted.ok && persisted.value?.status).toBe("ready");
  });

  it("supports bounded keyboard scrolling, focus containment, Escape, and focus return", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const { chapter, project } = await seedChapter(runtime);
    const candidate = await createReadyCandidate(runtime, project, chapter, "键".repeat(5_000), {
      source: "polish",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    const user = userEvent.setup();
    renderEditor(runtime, project, chapter, `?candidate=${candidate.id}`);

    const trigger = await screen.findByRole("button", { name: /比较.*建议/u });
    await user.click(trigger);
    const review = await screen.findByRole("dialog", { name: /比较.*建议与正文/u });
    const scrollControl = within(review).getByRole("button", { name: /浏览.*建议内容/u });
    const scrollContainer = review.querySelector<HTMLElement>(".ink-overlay__content");
    if (scrollContainer === null) throw new Error("Candidate review main scroller is missing.");
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 4_000 },
    });
    await waitFor(() => expect(scrollControl).toHaveFocus());

    fireEvent.keyDown(scrollControl, { key: "PageDown" });
    expect(scrollContainer.scrollTop).toBe(340);
    fireEvent.keyDown(scrollControl, { key: "End" });
    expect(scrollContainer.scrollTop).toBe(4_000);
    fireEvent.keyDown(scrollControl, { key: "Home" });
    expect(scrollContainer.scrollTop).toBe(0);
    fireEvent.keyDown(scrollControl, { key: "PageUp" });
    expect(scrollContainer.scrollTop).toBeLessThanOrEqual(0);

    const lastAction = within(review).getByRole("button", { name: "使用这版" });
    lastAction.focus();
    await user.tab();
    expect(review.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(review.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(review).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

function renderEditor(
  runtime: DesktopRuntime,
  project: Project,
  chapter: Chapter,
  search = "",
  state?: unknown,
): ReturnType<typeof render> {
  const pathname = `/projects/${project.id}/chapters/${chapter.id}${search}`;
  return render(
    <MemoryRouter initialEntries={[state === undefined ? pathname : { pathname, state }]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

async function seedChapter(runtime: DesktopRuntime): Promise<{
  readonly project: Project;
  readonly chapter: Chapter;
}> {
  const project = await runtime.useCases.createProject.execute({ name: "候选路由测试项目" });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "稳定正文",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return { project: project.value, chapter: chapter.value.chapter };
}

async function seedRemoteContinuationRoute(runtime: DesktopRuntime): Promise<void> {
  const connection = await runtime.modelHub.saveConnection({
    id: "direct-writing-remote",
    providerKind: "custom_openai_compatible",
    displayName: "Direct writing remote",
    baseUrlOverride: "https://models.example/v1",
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: null,
  });
  await runtime.modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await runtime.modelHub.syncCatalog({
    syncId: "direct-writing-remote-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "direct-writing-remote-catalog",
        providerModelId: "direct-writer",
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: "2027-08-18T00:00:00.000Z",
      },
    ],
  });
  await runtime.modelHub.recordCapabilityScan({
    scanId: "direct-writing-remote-scan",
    catalogEntryId: "direct-writing-remote-catalog",
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "direct-writing-test-v1",
    evidence: [
      {
        id: "direct-writing-remote-text-evidence",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await runtime.modelHub.saveCostPrivacyProfile({
    catalogEntryId: "direct-writing-remote-catalog",
    currency: "USD",
    inputMicrosPerMillionTokens: "1000000",
    outputMicrosPerMillionTokens: "2000000",
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "direct-writing-test-v1",
    priceUpdatedAt: "2026-08-18T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "direct-writing-test-v1",
    expectedRevision: null,
  });
  await runtime.modelHub.saveTaskRoute({
    task: "continuation",
    primaryCatalogEntryId: "direct-writing-remote-catalog",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

async function createReadyCandidate(
  runtime: DesktopRuntime,
  project: Project,
  chapter: Chapter,
  content: string,
  options: Readonly<{
    source?: AiCandidateSource;
    applicationIntent?: AiCandidateApplicationIntent;
  }> = {},
): Promise<AiCandidate> {
  const streaming = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: project.id,
    chapterId: chapter.id,
    source: options.source ?? "agent",
    baseVersionId: chapter.currentVersionId,
    now: runtime.clock.now(),
    ...(options.applicationIntent === undefined
      ? {}
      : { applicationIntent: options.applicationIntent }),
  });
  if (!streaming.ok) {
    throw streaming.error;
  }
  const checksum = await runtime.hasher.sha256(content);
  if (!checksum.ok) {
    throw checksum.error;
  }
  const ready = streaming.value.markReady(content, checksum.value, runtime.clock.now());
  if (!ready.ok) {
    throw ready.error;
  }
  const created = await runtime.repositories.aiCandidates.create(ready.value);
  if (!created.ok) {
    throw created.error;
  }
  return ready.value;
}
