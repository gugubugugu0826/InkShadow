import { describe, expect, it, vi } from "vitest";

import { generateCreativeOpening } from "./creative-opening-service";
import { createImportRewriteCandidate } from "./import-rewrite-service";
import type { ModelProviderKind, NovelAiTask } from "./model-hub-provider-registry";
import type { ModelHubStore } from "./model-hub-store";
import { createSelectionRewriteCandidate } from "./selection-rewrite-service";
import {
  createConfiguredModelCandidate,
  createDevelopmentRuntime,
  executeGenerationPlan,
  prepareGenerationPlan,
  type CredentialStore,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "./runtime";

describe("real creative chains use Model Hub routes", () => {
  for (const provider of [
    {
      providerKind: "anthropic_claude" as const,
      connectionId: "opening-claude",
      catalogEntryId: "opening-claude-catalog",
      modelId: "opening-claude-model",
      gatewayProvider: "anthropic" as const,
    },
    {
      providerKind: "google_gemini" as const,
      connectionId: "opening-gemini",
      catalogEntryId: "opening-gemini-catalog",
      modelId: "opening-gemini-model",
      gatewayProvider: "gemini" as const,
    },
  ]) {
    it(`routes opening generation exactly through ${provider.providerKind}`, async () => {
      const harness = createNativeHarness();
      await seedModelHubTextRoute(harness.runtime.modelHub, {
        task: "book_start_guidance",
        ...provider,
      });
      harness.generate.mockResolvedValue({ text: "路由生成的小说开头。", usage: null });

      const result = await generateCreativeOpening(harness.runtime, {
        idea: "一个在雨夜收到未来来信的女孩",
        requestId: `request-${provider.connectionId}`,
      });

      expect(result).toMatchObject({
        source: "provider",
        text: "路由生成的小说开头。",
        providerId: provider.connectionId,
        modelId: provider.modelId,
      });
      expect(harness.generate).toHaveBeenCalledOnce();
      expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
        generationId: `request-${provider.connectionId}`,
        config: {
          providerId: provider.connectionId,
          provider: provider.gatewayProvider,
        },
        model: provider.modelId,
      });
      if (provider.providerKind === "anthropic_claude") {
        expect(harness.generate.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
      }
      expect(harness.listModels).not.toHaveBeenCalled();
    });
  }

  it("keeps the legacy opening profile working only when no Model Hub route exists", async () => {
    const harness = createNativeHarness();
    await seedLegacyProfile(harness.runtime, "legacy-opening", "legacy-opening-model");
    harness.listModels.mockResolvedValue({
      provider: "ollama",
      models: [{ id: "legacy-opening-model", displayName: "Legacy opening" }],
    });
    harness.generate.mockResolvedValue({ text: "旧配置生成的开头。", usage: null });

    const result = await generateCreativeOpening(harness.runtime, {
      idea: "一名学徒发现导师留下的密室",
      requestId: "legacy-opening-request",
    });

    expect(result).toMatchObject({
      source: "provider",
      providerId: "legacy-opening",
      modelId: "legacy-opening-model",
      text: "旧配置生成的开头。",
    });
    expect(harness.listModels).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "legacy-opening", provider: "ollama" },
      model: "legacy-opening-model",
    });
  });

  it("dispatches a fallback opening through the current versioned Model Hub credential slot", async () => {
    const harness = createNativeHarness();
    await seedVersionedModelHubBackedLegacyProfile(harness.runtime, {
      providerId: "versioned-opening",
      credentialProviderId: "model-key-opening-v2",
      selectedModel: "opening-model",
    });
    harness.credentialSummary.mockImplementation((providerId: string) =>
      Promise.resolve({
        configured: providerId === "model-key-opening-v2",
        lastFour: providerId === "model-key-opening-v2" ? "2222" : null,
      }),
    );
    harness.listModels.mockResolvedValue({
      provider: "open_ai_compatible",
      models: [{ id: "opening-model", displayName: "Opening model" }],
    });
    harness.generate.mockResolvedValue({ text: "versioned opening", usage: null });

    const result = await generateCreativeOpening(harness.runtime, {
      idea: "A letter arrives from a forgotten future.",
      requestId: "versioned-opening-request",
    });

    expect(result).toMatchObject({
      source: "provider",
      providerId: "versioned-opening",
      modelId: "opening-model",
      text: "versioned opening",
    });
    expect(harness.credentialSummary).toHaveBeenCalledWith("model-key-opening-v2");
    expect(harness.credentialSummary).not.toHaveBeenCalledWith("versioned-opening");
    expect(harness.listModels.mock.calls[0]?.[0]).toMatchObject({
      providerId: "model-key-opening-v2",
    });
    expect(harness.generate.mock.calls[0]?.[0].config).toMatchObject({
      providerId: "model-key-opening-v2",
    });
  });

  it("never bypasses a failing opening route through a legacy profile", async () => {
    const harness = createNativeHarness();
    await seedLegacyProfile(harness.runtime, "unsafe-opening-legacy", "unsafe-opening-model");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "book_start_guidance",
      providerKind: "google_gemini",
      connectionId: "opening-policy-route",
      catalogEntryId: "opening-policy-catalog",
      modelId: "opening-policy-model",
      includeCapability: false,
    });

    const result = await generateCreativeOpening(harness.runtime, {
      idea: "被时间遗忘的小镇重新出现",
      requestId: "blocked-opening-request",
    });

    expect(result).toMatchObject({
      source: "local_fallback",
      providerId: null,
      modelId: null,
      noticeCode: "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
    });
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("routes import rewriting through Model Hub and persists only an isolated candidate", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(
      harness.runtime,
      "原始正文必须保持不变。第二句也属于原文。",
    );
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "rewrite-gemini",
      catalogEntryId: "rewrite-gemini-catalog",
      modelId: "rewrite-gemini-model",
    });
    harness.generate.mockResolvedValue({ text: "这是 AI 建议的改写版本。", usage: null });
    const onBeforeDispatch = vi.fn();

    const result = await createImportRewriteCandidate(harness.runtime, {
      chapterId: chapter.id,
      instructions: ["让对话更自然"],
      mode: "trial",
      onBeforeDispatch,
    });

    expect(result).toMatchObject({
      providerId: "rewrite-gemini",
      modelId: "rewrite-gemini-model",
      rewrittenExcerpt: "这是 AI 建议的改写版本。",
    });
    expect(onBeforeDispatch).toHaveBeenCalledWith({
      requestId: result.requestId,
      providerId: "rewrite-gemini",
      modelId: "rewrite-gemini-model",
    });
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "rewrite-gemini", provider: "gemini" },
      model: "rewrite-gemini-model",
    });
    expect(result.candidate.content).toBe("这是 AI 建议的改写版本。");
    await expectStableChapter(
      harness.runtime,
      chapter.id,
      "原始正文必须保持不变。第二句也属于原文。",
    );
    await expectCandidateCount(harness.runtime, chapter.id, 1);
    expect(harness.listModels).not.toHaveBeenCalled();
  });

  it("dispatches fallback import rewriting through the current versioned credential slot", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "Original chapter text remains stable.");
    await seedVersionedModelHubBackedLegacyProfile(harness.runtime, {
      providerId: "versioned-rewrite",
      credentialProviderId: "model-key-rewrite-v3",
      selectedModel: "rewrite-model",
    });
    harness.credentialSummary.mockImplementation((providerId: string) =>
      Promise.resolve({
        configured: providerId === "model-key-rewrite-v3",
        lastFour: providerId === "model-key-rewrite-v3" ? "3333" : null,
      }),
    );
    harness.listModels.mockResolvedValue({
      provider: "open_ai_compatible",
      models: [{ id: "rewrite-model", displayName: "Rewrite model" }],
    });
    harness.generate.mockResolvedValue({ text: "Rewritten candidate text.", usage: null });

    const result = await createImportRewriteCandidate(harness.runtime, {
      chapterId: chapter.id,
      instructions: ["Make the dialogue more natural."],
      mode: "trial",
    });

    expect(result).toMatchObject({
      providerId: "versioned-rewrite",
      modelId: "rewrite-model",
      rewrittenExcerpt: "Rewritten candidate text.",
    });
    expect(harness.credentialSummary).toHaveBeenCalledWith("model-key-rewrite-v3");
    expect(harness.credentialSummary).not.toHaveBeenCalledWith("versioned-rewrite");
    expect(harness.listModels.mock.calls[0]?.[0]).toMatchObject({
      providerId: "model-key-rewrite-v3",
    });
    expect(harness.generate.mock.calls[0]?.[0].config).toMatchObject({
      providerId: "model-key-rewrite-v3",
    });
    await expectStableChapter(harness.runtime, chapter.id, "Original chapter text remains stable.");
    await expectCandidateCount(harness.runtime, chapter.id, 1);
  });

  it("blocks private chapter rewriting before a remote provider receives any text", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(
      harness.runtime,
      "PRIVATE_REWRITE_TEXT_MUST_NEVER_REACH_REMOTE_PROVIDER",
    );
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) {
      throw privacy.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "remote-private-rewrite",
      catalogEntryId: "remote-private-rewrite-catalog",
      modelId: "remote-private-rewrite-model",
    });

    await expect(
      createImportRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        instructions: ["keep private"],
        mode: "trial",
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_CHAPTER_LOCAL_ONLY" });

    expect(harness.generate).not.toHaveBeenCalled();
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("rewrites an exact UTF-16 selection through Model Hub and keeps the fragment isolated until acceptance", async () => {
    const harness = createNativeHarness();
    const source = "开头🙂需要修改的段落。结尾保持不变。";
    const chapter = await createChapter(harness.runtime, source);
    const selectedText = "需要修改的段落。";
    const startUtf16 = source.indexOf(selectedText);
    const endUtf16 = startUtf16 + selectedText.length;
    const selectedHash = await harness.runtime.hasher.sha256(selectedText);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "selection-rewrite-gemini",
      catalogEntryId: "selection-rewrite-gemini-catalog",
      modelId: "selection-rewrite-gemini-model",
    });
    harness.generate.mockResolvedValue({ text: "这一段经过了自然改写。", usage: null });

    const result = await createSelectionRewriteCandidate(harness.runtime, {
      chapterId: chapter.id,
      baseVersionId: chapter.currentVersionId,
      selection: {
        startUtf16,
        endUtf16,
        selectedTextSha256: selectedHash.value,
      },
      instruction: "保持原意，让表达更自然",
    });

    const expectedCandidate = source.replace(selectedText, "这一段经过了自然改写。");
    expect(result).toMatchObject({
      providerId: "selection-rewrite-gemini",
      modelId: "selection-rewrite-gemini-model",
      originalSelection: selectedText,
      rewrittenSelection: "这一段经过了自然改写。",
    });
    expect(result.candidate).toMatchObject({
      content: "这一段经过了自然改写。",
      baseVersionId: chapter.currentVersionId,
      status: "ready",
      applicationIntent: {
        task: "selection_rewrite",
        application: "replace_selection",
        payload: "fragment",
        startUtf16,
        endUtf16,
      },
    });
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "selection-rewrite-gemini", provider: "gemini" },
      model: "selection-rewrite-gemini-model",
    });
    const messages = harness.generate.mock.calls[0]?.[0].messages ?? [];
    expect(messages.map(({ content }) => content).join("\n")).toContain(selectedText);
    expect(messages.map(({ content }) => content).join("\n")).toContain("保持原意，让表达更自然");
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 1);

    const traceSummaries = await harness.runtime.contextTraces.listByProjectId(chapter.projectId);
    expect(traceSummaries[0]).toMatchObject({
      taskType: "rewrite",
      chapterId: chapter.id,
    });
    const trace = await harness.runtime.contextTraces.findById(traceSummaries[0]?.id ?? "missing");
    const traceSource = trace?.entries
      .find(({ layer }) => layer === "current_task")
      ?.sources.find(({ sourceType }) => sourceType === "chapter");
    expect(traceSource).toMatchObject({
      sourceType: "chapter",
      sourceId: chapter.id,
      sourceVersionId: chapter.currentVersionId,
      locator: `utf16:${String(startUtf16)}-${String(endUtf16)}:${String(source.length)}`,
      contentHash: selectedHash.value,
    });
    expect(trace).toMatchObject({
      id: result.contextTraceId,
      execution: {
        generationId: result.requestId,
        generationRunId: null,
      },
      outputCandidateId: result.candidate.id,
    });
    expect(typeof trace?.execution?.modelInvocationId).toBe("string");
    await expect(
      harness.runtime.contextTraces.findByOutputCandidateId(result.candidate.id),
    ).resolves.toMatchObject({ id: result.contextTraceId });

    const accepted = await harness.runtime.useCases.acceptCandidate.execute({
      candidateId: result.candidate.id,
      expectedCandidateRevision: result.candidate.revision,
    });
    if (!accepted.ok) {
      throw accepted.error;
    }
    expect(accepted.value.chapter.content).toBe(expectedCandidate);
    expect(accepted.value.version.toSnapshot()).toMatchObject({
      reason: "candidate_accept",
      sourceCandidateId: result.candidate.id,
    });
  });

  it("rejects a stale selection hash before the rewrite provider receives any text", async () => {
    const harness = createNativeHarness();
    const source = "选中的原文不会被猜测。";
    const chapter = await createChapter(harness.runtime, source);
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "stale-selection-rewrite",
      catalogEntryId: "stale-selection-rewrite-catalog",
      modelId: "stale-selection-rewrite-model",
    });

    await expect(
      createSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: "0".repeat(64),
        },
        instruction: "保持原意",
      }),
    ).rejects.toMatchObject({ code: "SELECTION_REWRITE_SOURCE_CHANGED" });

    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("fails closed when the selection rewrite context trace cannot be saved", async () => {
    const harness = createNativeHarness();
    const source = "上下文来源必须先于模型发送保存。";
    const chapter = await createChapter(harness.runtime, source);
    const selectedHash = await harness.runtime.hasher.sha256(source);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "trace-selection-rewrite",
      catalogEntryId: "trace-selection-rewrite-catalog",
      modelId: "trace-selection-rewrite-model",
    });
    vi.spyOn(harness.runtime.contextTraces, "save").mockRejectedValueOnce(
      new Error("trace unavailable"),
    );

    await expect(
      createSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: selectedHash.value,
        },
        instruction: "保持原意",
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_UNAVAILABLE" });

    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("keeps a selection rewrite unpersisted when the atomic Candidate/trace commit fails", async () => {
    const harness = createNativeHarness();
    const source = "原子提交失败时稳定正文不能改变。";
    const chapter = await createChapter(harness.runtime, source);
    const selectedHash = await harness.runtime.hasher.sha256(source);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "atomic-selection-rewrite",
      catalogEntryId: "atomic-selection-rewrite-catalog",
      modelId: "atomic-selection-rewrite-model",
    });
    harness.generate.mockResolvedValue({ text: "这段结果不应成为可接受建议。", usage: null });
    const commit = vi
      .spyOn(harness.runtime.contextTraceOutputs, "commit")
      .mockRejectedValueOnce(new Error("simulated atomic commit failure"));

    await expect(
      createSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: selectedHash.value,
        },
        instruction: "保持原意",
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_TRACE_UNAVAILABLE" });

    expect(commit).toHaveBeenCalledOnce();
    const commitInput = commit.mock.calls[0]?.[0];
    expect(typeof commitInput?.traceId).toBe("string");
    expect(commitInput?.candidate.status).toBe("ready");
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("discards a selection rewrite result when the base version changes during provider execution", async () => {
    const harness = createNativeHarness();
    const source = "模型调用期间可能被其他窗口修改。";
    const chapter = await createChapter(harness.runtime, source);
    const selectedHash = await harness.runtime.hasher.sha256(source);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "drift-selection-rewrite",
      catalogEntryId: "drift-selection-rewrite-catalog",
      modelId: "drift-selection-rewrite-model",
    });
    harness.generate.mockImplementation(async () => {
      const edited = await harness.runtime.useCases.editChapter.execute({
        chapterId: chapter.id,
        expectedRevision: chapter.revision,
        content: "其他窗口已保存的新正文。",
        cursorOffset: 0,
      });
      if (!edited.ok) {
        throw edited.error;
      }
      const saved = await harness.runtime.useCases.saveChapter.execute({
        chapterId: chapter.id,
        expectedRevision: chapter.revision,
        reason: "manual",
      });
      if (!saved.ok) {
        throw saved.error;
      }
      return { text: "不应保存的过期改写。", usage: null };
    });

    await expect(
      createSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: selectedHash.value,
        },
        instruction: "改写得更自然",
      }),
    ).rejects.toMatchObject({ code: "SELECTION_REWRITE_SOURCE_CHANGED" });

    expect(harness.generate).toHaveBeenCalledOnce();
    await expectStableChapter(harness.runtime, chapter.id, "其他窗口已保存的新正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("blocks private selection rewrite before remote generation or reranking receives text", async () => {
    const harness = createNativeHarness();
    const source = "PRIVATE_SELECTION_REWRITE_MUST_NOT_LEAVE_DEVICE";
    const chapter = await createChapter(harness.runtime, source);
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) {
      throw privacy.error;
    }
    const selectedHash = await harness.runtime.hasher.sha256(source);
    if (!selectedHash.ok) {
      throw selectedHash.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "remote-private-selection-rewrite",
      catalogEntryId: "remote-private-selection-rewrite-catalog",
      modelId: "remote-private-selection-rewrite-model",
    });
    const rerankSpy = vi.spyOn(harness.runtime.rerank, "tryRerank");

    await expect(
      createSelectionRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        baseVersionId: chapter.currentVersionId,
        selection: {
          startUtf16: 0,
          endUtf16: source.length,
          selectedTextSha256: selectedHash.value,
        },
        instruction: "keep private",
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_CHAPTER_LOCAL_ONLY" });

    expect(harness.generate).not.toHaveBeenCalled();
    expect(rerankSpy).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("falls back to the legacy rewrite chain only when the route is absent", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "等待旧配置改写的原文。");
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) {
      throw privacy.error;
    }
    await seedLegacyProfile(harness.runtime, "legacy-rewrite", "legacy-rewrite-model");
    harness.listModels.mockResolvedValue({
      provider: "ollama",
      models: [{ id: "legacy-rewrite-model", displayName: "Legacy rewrite" }],
    });
    harness.generate.mockResolvedValue({ text: "旧链生成的建议版本。", usage: null });
    const onBeforeDispatch = vi.fn();

    const result = await createImportRewriteCandidate(harness.runtime, {
      chapterId: chapter.id,
      instructions: ["节奏更快"],
      mode: "trial",
      onBeforeDispatch,
    });

    expect(result).toMatchObject({
      providerId: "legacy-rewrite",
      modelId: "legacy-rewrite-model",
    });
    expect(onBeforeDispatch).toHaveBeenCalledWith({
      requestId: result.requestId,
      providerId: "legacy-rewrite",
      modelId: "legacy-rewrite-model",
    });
    expect(harness.listModels).toHaveBeenCalledOnce();
    await expectStableChapter(harness.runtime, chapter.id, "等待旧配置改写的原文。");
  });

  it("never bypasses a failing rewrite route through a legacy profile", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "隐私策略保护的改写原文。");
    await seedLegacyProfile(harness.runtime, "unsafe-rewrite-legacy", "unsafe-rewrite-model");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "rewrite",
      providerKind: "google_gemini",
      connectionId: "rewrite-policy-route",
      catalogEntryId: "rewrite-policy-catalog",
      modelId: "rewrite-policy-model",
      includeCapability: false,
    });

    await expect(
      createImportRewriteCandidate(harness.runtime, {
        chapterId: chapter.id,
        instructions: ["保持原意"],
        mode: "trial",
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED" });
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "隐私策略保护的改写原文。");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("routes editor continuation through Model Hub and persists an isolated candidate", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "编辑器中的稳定正文。");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "anthropic_claude",
      connectionId: "continuation-claude",
      catalogEntryId: "continuation-claude-catalog",
      modelId: "continuation-claude-model",
    });
    harness.generate.mockResolvedValue({ text: "模型续写的新段落。", usage: null });

    const result = await createConfiguredModelCandidate(harness.runtime, chapter.id);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value).toMatchObject({
      content: "\n\n模型续写的新段落。",
      applicationIntent: {
        task: "continuation",
        application: "insert_at_cursor",
        payload: "fragment",
        startUtf16: chapter.content.length,
        endUtf16: chapter.content.length,
      },
    });
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: {
        providerId: "continuation-claude",
        provider: "anthropic",
      },
      model: "continuation-claude-model",
    });
    expect(harness.generate.mock.calls[0]?.[0]).not.toHaveProperty("temperature");
    await expect(
      harness.runtime.contextTraces.findByOutputCandidateId(result.value.id),
    ).resolves.toMatchObject({
      execution: {
        generationRunId: null,
      },
      outputCandidateId: result.value.id,
    });
    const directTrace = await harness.runtime.contextTraces.findByOutputCandidateId(
      result.value.id,
    );
    expect(typeof directTrace?.execution?.modelInvocationId).toBe("string");
    await expectStableChapter(harness.runtime, chapter.id, "编辑器中的稳定正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 1);
  });

  it("blocks private editor continuation before a remote provider receives text", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(
      harness.runtime,
      "PRIVATE_CONTINUATION_TEXT_MUST_NEVER_REACH_REMOTE_PROVIDER",
    );
    const privacy = await harness.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.privacyRevision,
    });
    if (!privacy.ok) {
      throw privacy.error;
    }
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "anthropic_claude",
      connectionId: "remote-private-continuation",
      catalogEntryId: "remote-private-continuation-catalog",
      modelId: "remote-private-continuation-model",
    });

    const result = await createConfiguredModelCandidate(harness.runtime, chapter.id);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "PRIVATE_CHAPTER_LOCAL_ONLY" },
    });
    expect(harness.generate).not.toHaveBeenCalled();
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("uses Model Hub in the editor's governed preflight and execution path", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "生成治理链路中的稳定正文。");
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "google_gemini",
      connectionId: "governed-continuation",
      catalogEntryId: "governed-continuation-catalog",
      modelId: "governed-continuation-model",
    });
    harness.generate.mockResolvedValue({
      text: "通过治理链路生成的新段落。",
      usage: { inputTokens: 300, outputTokens: 40, cachedInputTokens: null },
    });

    const plan = await prepareGenerationPlan(harness.runtime, chapter.id, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(plan).toMatchObject({
      executionMode: "model_hub",
      providerId: "governed-continuation",
      modelId: "governed-continuation-model",
      routeReason: "model_hub_primary",
      profile: null,
    });
    expect(plan.preflight.canStart).toBe(true);
    expect(plan.contextCompilation?.compiled.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "current_task", included: true }),
        expect.objectContaining({ layer: "recent_events", included: true }),
      ]),
    );
    const result = await executeGenerationPlan(harness.runtime, plan);
    if (!result.ok || result.value.candidate === null) {
      throw result.ok ? new Error("expected a candidate") : result.error;
    }
    expect(result.value.candidate.content).toContain("通过治理链路生成的新段落。");
    expect(harness.generate).toHaveBeenCalledOnce();
    expect(harness.generate.mock.calls[0]?.[0]).toMatchObject({
      config: { providerId: "governed-continuation" },
      model: "governed-continuation-model",
    });
    await expect(
      harness.runtime.contextTraces.findByOutputCandidateId(result.value.candidate.id),
    ).resolves.toMatchObject({
      id: plan.contextTraceId,
      execution: {
        generationId: plan.generationId,
        generationRunId: plan.runId,
      },
      outputCandidateId: result.value.candidate.id,
    });
    const governedTrace = await harness.runtime.contextTraces.findByOutputCandidateId(
      result.value.candidate.id,
    );
    expect(typeof governedTrace?.execution?.modelInvocationId).toBe("string");
    expect(harness.listModels).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "生成治理链路中的稳定正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 1);
  });

  it("never bypasses a failing continuation route through a legacy profile", async () => {
    const harness = createNativeHarness();
    const chapter = await createChapter(harness.runtime, "不可绕过策略的正文。");
    await seedLegacyProfile(
      harness.runtime,
      "unsafe-continuation-legacy",
      "unsafe-continuation-model",
    );
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "anthropic_claude",
      connectionId: "continuation-policy-route",
      catalogEntryId: "continuation-policy-catalog",
      modelId: "continuation-policy-model",
      includeCapability: false,
    });

    const result = await createConfiguredModelCandidate(harness.runtime, chapter.id);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected continuation policy failure");
    }
    expect(result.error).toMatchObject({ code: "MODEL_HUB_CAPABILITY_NOT_VERIFIED" });
    expect(harness.listModels).not.toHaveBeenCalled();
    expect(harness.generate).not.toHaveBeenCalled();
    await expectStableChapter(harness.runtime, chapter.id, "不可绕过策略的正文。");
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });

  it("returns no direct continuation Candidate when its atomic trace commit fails", async () => {
    const harness = createNativeHarness();
    const source = "直接续写的稳定正文。";
    const chapter = await createChapter(harness.runtime, source);
    await seedModelHubTextRoute(harness.runtime.modelHub, {
      task: "continuation",
      providerKind: "google_gemini",
      connectionId: "atomic-direct-continuation",
      catalogEntryId: "atomic-direct-continuation-catalog",
      modelId: "atomic-direct-continuation-model",
    });
    harness.generate.mockResolvedValue({ text: "不应落库的续写结果。", usage: null });
    vi.spyOn(harness.runtime.contextTraceOutputs, "commit").mockRejectedValueOnce(
      new Error("simulated atomic commit failure"),
    );

    const result = await createConfiguredModelCandidate(harness.runtime, chapter.id);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected atomic context-output commit failure");
    }
    expect(result.error).toMatchObject({ code: "CONTEXT_TRACE_UNAVAILABLE" });
    await expectStableChapter(harness.runtime, chapter.id, source);
    await expectCandidateCount(harness.runtime, chapter.id, 0);
  });
});

function createNativeHarness(): Readonly<{
  runtime: DesktopRuntime;
  generate: ReturnType<typeof vi.fn<NativeModelGatewayClient["generate"]>>;
  listModels: ReturnType<typeof vi.fn<NativeModelGatewayClient["listModels"]>>;
  credentialSummary: ReturnType<typeof vi.fn<CredentialStore["getSummary"]>>;
}> {
  const developmentRuntime = createDevelopmentRuntime(new MemoryStorage());
  const generate = vi.fn<NativeModelGatewayClient["generate"]>();
  const listModels = vi.fn<NativeModelGatewayClient["listModels"]>();
  const credentialSummary = vi
    .fn<CredentialStore["getSummary"]>()
    .mockResolvedValue({ configured: true, lastFour: "1234" });
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    generate,
    listModels,
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    cancelGeneration: () => Promise.resolve(false),
  };
  return Object.freeze({
    generate,
    listModels,
    credentialSummary,
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
      credentials: {
        getSummary: credentialSummary,
        save: () => Promise.resolve({ configured: true, lastFour: "1234" }),
        delete: () => Promise.resolve({ configured: false, lastFour: null }),
      },
    },
  });
}

async function seedVersionedModelHubBackedLegacyProfile(
  runtime: DesktopRuntime,
  input: Readonly<{
    providerId: string;
    credentialProviderId: string;
    selectedModel: string;
  }>,
): Promise<void> {
  await runtime.modelCenter.save({
    providerId: input.providerId,
    provider: "open_ai_compatible",
    baseUrl: "https://legacy.example/v1",
    authentication: "bearer_keyring",
    selectedModel: input.selectedModel,
    expectedRevision: null,
  });
  await runtime.modelHub.saveConnection({
    id: input.providerId,
    providerKind: "openai",
    displayName: input.providerId,
    credentialRef: `keyring:model-hub:${input.credentialProviderId}`,
    credentialState: "present",
    expectedRevision: null,
  });
}

async function seedModelHubTextRoute(
  modelHub: ModelHubStore,
  input: Readonly<{
    task: NovelAiTask;
    providerKind: ModelProviderKind;
    connectionId: string;
    catalogEntryId: string;
    modelId: string;
    includeCapability?: boolean;
  }>,
): Promise<void> {
  const connection = await modelHub.saveConnection({
    id: input.connectionId,
    providerKind: input.providerKind,
    displayName: input.connectionId,
    credentialRef: `keyring:model-hub:${input.connectionId}`,
    credentialState: "present",
    expectedRevision: null,
  });
  await modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await modelHub.syncCatalog({
    syncId: `${input.connectionId}-sync`,
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: input.catalogEntryId,
        providerModelId: input.modelId,
        lifecycle: "stable",
        inputTokenLimit: 200_000,
        outputTokenLimit: 20_000,
        staleAfter: "2027-08-02T00:00:00.000Z",
      },
    ],
  });
  if (input.includeCapability !== false) {
    await modelHub.recordCapabilityScan({
      scanId: `${input.connectionId}-scan`,
      catalogEntryId: input.catalogEntryId,
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "creative-chain-test-v1",
      evidence: [
        {
          id: `${input.connectionId}-text-evidence`,
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        },
      ],
    });
  }
  await modelHub.saveCostPrivacyProfile({
    catalogEntryId: input.catalogEntryId,
    currency: "USD",
    inputMicrosPerMillionTokens: "0",
    outputMicrosPerMillionTokens: "0",
    cachedInputMicrosPerMillionTokens: "0",
    pricingVersion: "creative-chain-zero-cost-v1",
    priceUpdatedAt: "2026-08-01T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "creative-chain-test-v1",
    expectedRevision: null,
  });
  await modelHub.saveTaskRoute({
    task: input.task,
    primaryCatalogEntryId: input.catalogEntryId,
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

async function seedLegacyProfile(
  runtime: DesktopRuntime,
  providerId: string,
  selectedModel: string,
): Promise<void> {
  await runtime.modelCenter.save({
    providerId,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    authentication: "none",
    selectedModel,
    expectedRevision: null,
  });
}

async function createChapter(runtime: DesktopRuntime, content: string) {
  const project = await runtime.useCases.createProject.execute({ name: "Model Hub 创作链验收" });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await runtime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content,
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  return chapter.value.chapter;
}

async function expectStableChapter(
  runtime: DesktopRuntime,
  chapterId: Parameters<DesktopRuntime["repositories"]["chapters"]["findById"]>[0],
  expectedContent: string,
): Promise<void> {
  const chapter = await runtime.repositories.chapters.findById(chapterId);
  expect(chapter.ok && chapter.value?.content).toBe(expectedContent);
}

async function expectCandidateCount(
  runtime: DesktopRuntime,
  chapterId: Parameters<DesktopRuntime["repositories"]["chapters"]["findById"]>[0],
  expectedCount: number,
): Promise<void> {
  const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapterId);
  expect(candidates.ok && candidates.value).toHaveLength(expectedCount);
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  public get length(): number {
    return this.values.size;
  }

  public clear(): void {
    this.values.clear();
  }

  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  public removeItem(key: string): void {
    this.values.delete(key);
  }

  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
