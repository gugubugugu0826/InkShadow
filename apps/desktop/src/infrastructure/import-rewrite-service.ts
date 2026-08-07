import { AiCandidate, AppError, err, ok, type Result, type UuidV7 } from "@inkshadow/domain";

import { ModelCenterError, type ModelProfile } from "./model-center-store";
import { executeModelHubTextTask, ModelHubExecutionError } from "./model-hub-execution-service";
import type { DesktopRuntime, NativeModelGenerationResult, NativeModelMessage } from "./runtime";

export type ImportRewriteMode = "trial" | "chapter";

export interface ImportRewriteCandidateResult {
  readonly candidate: AiCandidate;
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly originalExcerpt: string;
  readonly rewrittenExcerpt: string;
  readonly excerptStart: number;
  readonly excerptEnd: number;
}

export interface ImportRewriteCandidateInput {
  readonly chapterId: UuidV7;
  readonly instructions: readonly string[];
  readonly mode: ImportRewriteMode;
  readonly onDelta?: (text: string) => void;
  readonly onBeforeDispatch?: (
    request: Readonly<{
      requestId: string;
      providerId: string;
      modelId: string;
    }>,
  ) => void | Promise<void>;
}

/**
 * Calls a configured native model and persists its output as an isolated candidate.
 * It never writes generated text to the stable chapter.
 */
export async function createImportRewriteCandidate(
  runtime: DesktopRuntime,
  input: ImportRewriteCandidateInput,
): Promise<ImportRewriteCandidateResult> {
  const chapterResult = await runtime.repositories.chapters.findById(input.chapterId);
  if (!chapterResult.ok) {
    throw chapterResult.error;
  }
  const chapter = chapterResult.value;
  if (chapter === null) {
    throw new AppError({
      code: "CHAPTER_NOT_FOUND",
      message: "The chapter selected for rewriting no longer exists.",
    });
  }
  const editable = chapter.assertEditable();
  if (!editable.ok) {
    throw editable.error;
  }
  if (chapter.content.trim().length === 0) {
    throw new ModelCenterError(
      "IMPORT_REWRITE_SOURCE_EMPTY",
      "这个章节没有可供试改的正文，请选择含有正文的章节。",
    );
  }
  const instructions = normalizeInstructions(input.instructions);

  const excerpt = selectRepresentativeExcerpt(chapter.content, input.mode);
  const requestId = runtime.ids.next();
  const messages = buildRewriteMessages({
    chapterTitle: chapter.title,
    instructions,
    mode: input.mode,
    source: excerpt.text,
  });
  const inputBytes = new TextEncoder().encode(
    messages.map(({ content }) => content).join("\n"),
  ).length;
  if (inputBytes > 240_000) {
    throw new ModelCenterError(
      "IMPORT_REWRITE_CONTEXT_TOO_LARGE",
      "这个章节超过当前模型调用的安全上下文上限，请先拆分章节后重试。",
    );
  }

  let generated: NativeModelGenerationResult | null = null;
  let selectedProviderId: string | null = null;
  let selectedModelId: string | null = null;
  let modelHubRouteMissing = runtime.mode !== "tauri" || !runtime.modelGateway.available;

  if (!modelHubRouteMissing) {
    try {
      const modelHubResult = await executeModelHubTextTask(runtime, {
        task: "rewrite",
        messages,
        maximumOutputTokens: input.mode === "trial" ? 1_500 : 8_000,
        temperature: 0.65,
        generationId: requestId,
        ...(input.onBeforeDispatch === undefined
          ? {}
          : {
              onBeforeDispatch: ({ connectionId, modelId }) =>
                input.onBeforeDispatch?.({
                  requestId,
                  providerId: connectionId,
                  modelId,
                }),
            }),
        ...(input.onDelta === undefined ? {} : { onDelta: input.onDelta }),
      });
      generated = Object.freeze({ text: modelHubResult.text, usage: modelHubResult.usage });
      selectedProviderId = modelHubResult.connectionId;
      selectedModelId = modelHubResult.modelId;
    } catch (cause: unknown) {
      modelHubRouteMissing =
        cause instanceof ModelHubExecutionError && cause.code === "MODEL_HUB_ROUTE_NOT_CONFIGURED";
      if (!modelHubRouteMissing) {
        throw normalizeProviderError(cause);
      }
    }
  }

  if (modelHubRouteMissing) {
    const profile = await resolveRewriteProfile(runtime);
    await assertProfileReady(runtime, profile);
    selectedProviderId = profile.providerId;
    selectedModelId = requireSelectedModel(profile);
    try {
      await input.onBeforeDispatch?.({
        requestId,
        providerId: selectedProviderId,
        modelId: selectedModelId,
      });
      generated = await runtime.modelGateway.generate({
        generationId: requestId,
        config: {
          providerId: profile.providerId,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          authentication: profile.authentication,
        },
        model: selectedModelId,
        messages,
        maxOutputTokens: input.mode === "trial" ? 1_500 : 8_000,
        temperature: 0.65,
        ...(input.onDelta === undefined ? {} : { onDelta: input.onDelta }),
      });
    } catch (cause: unknown) {
      throw normalizeProviderError(cause);
    }
  }
  if (generated === null || selectedProviderId === null || selectedModelId === null) {
    throw new ModelCenterError(
      "MODEL_GENERATION_FAILED",
      "模型调用没有返回可保存的结果。原文和已有 AI 建议版本均未改变。",
      true,
    );
  }
  const rewrittenExcerpt = normalizeGeneratedText(generated.text);
  if (
    input.mode === "chapter" &&
    excerpt.text.length > 1_000 &&
    rewrittenExcerpt.length < Math.floor(excerpt.text.length * 0.25)
  ) {
    throw new ModelCenterError(
      "MODEL_OUTPUT_SUSPICIOUSLY_SHORT",
      "模型返回的章节明显短于原文，可能被截断。结果没有保存，请减小章节长度或切换长上下文模型。",
      true,
    );
  }
  const candidateContent =
    input.mode === "trial"
      ? `${chapter.content.slice(0, excerpt.start)}${rewrittenExcerpt}${chapter.content.slice(
          excerpt.end,
        )}`
      : rewrittenExcerpt;
  const candidate = await persistCandidate(runtime, {
    chapterId: chapter.id,
    projectId: chapter.projectId,
    baseVersionId: chapter.currentVersionId,
    content: candidateContent,
  });
  return Object.freeze({
    candidate,
    requestId,
    providerId: selectedProviderId,
    modelId: selectedModelId,
    originalExcerpt: excerpt.text,
    rewrittenExcerpt,
    excerptStart: excerpt.start,
    excerptEnd: excerpt.end,
  });
}

async function persistCandidate(
  runtime: DesktopRuntime,
  input: Readonly<{
    chapterId: UuidV7;
    projectId: UuidV7;
    baseVersionId: UuidV7;
    content: string;
  }>,
): Promise<AiCandidate> {
  const streaming = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: input.projectId,
    chapterId: input.chapterId,
    source: "polish",
    baseVersionId: input.baseVersionId,
    now: runtime.clock.now(),
  });
  if (!streaming.ok) {
    throw streaming.error;
  }
  const checksum = await runtime.hasher.sha256(input.content);
  if (!checksum.ok) {
    throw checksum.error;
  }
  const ready = streaming.value.markReady(input.content, checksum.value, runtime.clock.now());
  if (!ready.ok) {
    throw ready.error;
  }
  const saved = await runtime.repositories.aiCandidates.create(ready.value);
  if (!saved.ok) {
    throw saved.error;
  }
  return ready.value;
}

async function resolveRewriteProfile(runtime: DesktopRuntime): Promise<ModelProfile> {
  if (runtime.mode !== "tauri" || !runtime.modelGateway.available) {
    throw new ModelCenterError(
      "MODEL_NOT_CONNECTED",
      "尚未连接可用于改写的模型。请先在设置中连接供应商并选择模型，再返回继续；墨影不会用本地占位文字冒充 AI 结果。",
    );
  }
  const profiles = await runtime.modelCenter.listProfiles();
  const [highQuality, fast] = await Promise.all([
    runtime.modelRouting.findRoute("high_quality").catch(() => null),
    runtime.modelRouting.findRoute("fast").catch(() => null),
  ]);
  for (const route of [highQuality, fast]) {
    if (route === null) {
      continue;
    }
    for (const reference of [
      { providerId: route.primaryProviderId, modelId: route.primaryModelId },
      route.fallbackProviderId === null || route.fallbackModelId === null
        ? null
        : { providerId: route.fallbackProviderId, modelId: route.fallbackModelId },
    ]) {
      if (reference === null) {
        continue;
      }
      const matched = profiles.find(
        ({ providerId, selectedModel }) =>
          providerId === reference.providerId && selectedModel === reference.modelId,
      );
      if (matched !== undefined) {
        return matched;
      }
    }
  }
  const selected = profiles.find(({ selectedModel }) => selectedModel !== null);
  if (selected === undefined) {
    throw new ModelCenterError(
      "MODEL_NOT_CONNECTED",
      "尚未连接可用于改写的模型。请先在设置中连接供应商并选择模型，再返回继续；墨影不会用本地占位文字冒充 AI 结果。",
    );
  }
  return selected;
}

async function assertProfileReady(runtime: DesktopRuntime, profile: ModelProfile): Promise<void> {
  const model = requireSelectedModel(profile);
  if (profile.authentication === "bearer_keyring") {
    const summary = await runtime.credentials.getSummary(profile.providerId);
    if (!summary.configured) {
      throw new ModelCenterError(
        "MODEL_CREDENTIAL_MISSING",
        "供应商连接尚未保存 API Key。请在设置中补充凭据并测试连接。",
      );
    }
  }
  let listed;
  try {
    listed = await runtime.modelGateway.listModels({
      providerId: profile.providerId,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      authentication: profile.authentication,
    });
  } catch (cause: unknown) {
    throw normalizeProviderError(cause);
  }
  if (!listed.models.some(({ id }) => id === model)) {
    throw new ModelCenterError(
      "SELECTED_MODEL_UNAVAILABLE",
      "已选择的模型当前不可用。请在设置中重新同步模型并选择可用模型。",
      true,
    );
  }
}

function buildRewriteMessages(
  input: Readonly<{
    chapterTitle: string;
    instructions: readonly string[];
    mode: ImportRewriteMode;
    source: string;
  }>,
): readonly NativeModelMessage[] {
  const scope =
    input.mode === "trial"
      ? "只改写给出的代表段落。保持事实、人物姓名、事件顺序和信息边界；只输出改写后的段落，不要标题、说明、引号或 Markdown 围栏。"
      : "改写给出的完整章节。保持主要事实、人物姓名、事件顺序和信息边界；只输出完整的改写后正文，不要标题、说明或 Markdown 围栏。";
  return Object.freeze([
    {
      role: "system",
      content: `你是长篇小说改写助手。${scope}不得声称执行了没有证据的作品分析，不得添加与规则冲突的新设定。`,
    },
    {
      role: "user",
      content: [
        `章节：${input.chapterTitle}`,
        `作者确认的改写规则：\n${input.instructions.map((rule, index) => `${String(index + 1)}. ${rule}`).join("\n")}`,
        `待处理原文：\n${input.source}`,
      ].join("\n\n"),
    },
  ]);
}

function selectRepresentativeExcerpt(
  content: string,
  mode: ImportRewriteMode,
): Readonly<{ text: string; start: number; end: number }> {
  if (mode === "chapter") {
    return Object.freeze({ text: content, start: 0, end: content.length });
  }
  const firstVisible = content.search(/\S/u);
  const start = firstVisible < 0 ? 0 : firstVisible;
  const hardEnd = Math.min(content.length, start + 1_600);
  const paragraphBoundary = content.lastIndexOf("\n\n", hardEnd);
  const end = paragraphBoundary > start + 240 ? paragraphBoundary : hardEnd;
  return Object.freeze({ text: content.slice(start, end), start, end });
}

function normalizeInstructions(values: readonly string[]): readonly string[] {
  const normalized = values
    .map((value) => value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
    .slice(0, 30);
  if (normalized.length === 0 || normalized.some((value) => value.length > 1_000)) {
    throw new ModelCenterError(
      "IMPORT_REWRITE_RULES_INVALID",
      "请至少保留一条有效改写规则，并将每条规则控制在 1000 字以内。",
    );
  }
  return Object.freeze(normalized);
}

function normalizeGeneratedText(value: string): string {
  // Preserve authorial full-width punctuation; compatibility normalization would
  // silently turn Chinese prose punctuation into ASCII characters.
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 5_000_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ModelCenterError(
      "MODEL_OUTPUT_INVALID",
      "模型没有返回可安全保存的正文。请重试或切换模型。",
      true,
    );
  }
  return normalized;
}

function requireSelectedModel(profile: ModelProfile): string {
  if (profile.selectedModel === null || profile.selectedModel.trim().length === 0) {
    throw new ModelCenterError(
      "MODEL_NOT_CONNECTED",
      "供应商尚未选择可用于改写的模型。请在设置中完成模型选择。",
    );
  }
  return profile.selectedModel;
}

function normalizeProviderError(cause: unknown): ModelCenterError {
  if (cause instanceof ModelCenterError) {
    return cause;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
  ) {
    return new ModelCenterError(
      cause.code,
      "模型调用失败。原文和已有候选都没有改变，请检查连接后重试。",
      true,
    );
  }
  return new ModelCenterError(
    "MODEL_GENERATION_FAILED",
    "模型调用失败。原文和已有候选都没有改变，请检查连接后重试。",
    true,
  );
}

export function restoreCandidateBaseVersion(
  runtime: DesktopRuntime,
  candidate: AiCandidate,
): Promise<Result<Readonly<{ chapterContent: string }>, AppError | ModelCenterError>> {
  return restoreCandidateBaseVersionInternal(runtime, candidate);
}

async function restoreCandidateBaseVersionInternal(
  runtime: DesktopRuntime,
  candidate: AiCandidate,
): Promise<Result<Readonly<{ chapterContent: string }>, AppError | ModelCenterError>> {
  if (candidate.chapterId === null || candidate.baseVersionId === null) {
    return err(
      new ModelCenterError(
        "IMPORT_REWRITE_BASE_MISSING",
        "这个建议版本缺少原文版本，无法自动恢复。请从版本历史中选择原文。",
      ),
    );
  }
  const chapterResult = await runtime.repositories.chapters.findById(candidate.chapterId);
  if (!chapterResult.ok) {
    return chapterResult;
  }
  if (chapterResult.value === null) {
    return err(
      new AppError({ code: "CHAPTER_NOT_FOUND", message: "The candidate chapter is missing." }),
    );
  }
  const versions = await runtime.repositories.chapterVersions.listByChapterId(candidate.chapterId);
  if (!versions.ok) {
    return versions;
  }
  const acceptedVersion = versions.value.find(
    (version) => version.toSnapshot().sourceCandidateId === candidate.id,
  );
  if (acceptedVersion?.id !== chapterResult.value.currentVersionId) {
    return err(
      new AppError({
        code: "BASE_VERSION_CHANGED",
        message:
          "The chapter changed after this candidate was accepted; automatic restore would overwrite later edits.",
        actions: ["RESOLVE_CONFLICT", "EXPORT_DRAFT"],
      }),
    );
  }
  const restored = await runtime.useCases.restoreChapterVersion.execute({
    chapterId: candidate.chapterId,
    versionId: candidate.baseVersionId,
    expectedRevision: chapterResult.value.revision,
  });
  return restored.ok ? ok({ chapterContent: restored.value.chapter.content }) : restored;
}
