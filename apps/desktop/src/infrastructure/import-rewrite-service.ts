import { AiCandidate, AppError, err, ok, type Result, type UuidV7 } from "@inkshadow/domain";

import { ModelCenterError } from "./model-center-store";
import { executeModelHubTextTask, ModelHubExecutionError } from "./model-hub-execution-service";
import { SINGLE_ATTEMPT_VISIBLE_PROSE_POLICY } from "./model-execution-policy";
import {
  ProjectContextPrivacyError,
  projectContextRequiredDataDestination,
  projectContextDispatchScope,
} from "./project-context-privacy-authority";
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
 * Calls the explicitly governed Model Hub rewrite route and persists its output
 * as an isolated candidate. Legacy profile/gateway fallback is intentionally
 * forbidden so a missing route always stops before Provider dispatch.
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
  const projectPrivacy = await runtime.projectContextPrivacy.inspect(chapter.projectId);
  runtime.projectContextPrivacy.assertChapterMatches(projectPrivacy, chapter);
  const requiredDataDestination = projectContextRequiredDataDestination(projectPrivacy);

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

  if (runtime.mode !== "tauri" || !runtime.modelGateway.available) {
    throw new ModelCenterError(
      "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      "当前没有可由模型中心验证的改写分工。请求未发送，请先配置模型中心路由。",
    );
  }
  let modelHubResult;
  try {
    modelHubResult = await executeModelHubTextTask(runtime, {
      dispatchScope: projectContextDispatchScope(projectPrivacy),
      task: "rewrite",
      messages,
      maximumOutputTokens: input.mode === "trial" ? 1_500 : 8_000,
      temperature: 0.65,
      generationId: requestId,
      executionPolicy: SINGLE_ATTEMPT_VISIBLE_PROSE_POLICY,
      ...(requiredDataDestination === undefined ? {} : { requiredDataDestination }),
      onBeforeDispatch: async ({ connectionId, modelId, localOnlyEligible }) => {
        await input.onBeforeDispatch?.({
          requestId,
          providerId: connectionId,
          modelId,
        });
        await assertLatestRewriteSource(runtime, chapter);
        try {
          await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(projectPrivacy);
          runtime.projectContextPrivacy.assertRouteEligible(
            projectPrivacy,
            localOnlyEligible === true,
          );
        } catch (cause: unknown) {
          if (cause instanceof ProjectContextPrivacyError) {
            throw new ModelHubExecutionError(cause.code, cause.message, cause.retryable);
          }
          throw cause;
        }
      },
      onFinalBeforeProviderDispatch: async ({ localOnlyEligible }) => {
        await assertLatestRewriteSource(runtime, chapter);
        try {
          await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(projectPrivacy);
          runtime.projectContextPrivacy.assertRouteEligible(
            projectPrivacy,
            localOnlyEligible === true,
          );
        } catch (cause: unknown) {
          if (cause instanceof ProjectContextPrivacyError) {
            throw new ModelHubExecutionError(cause.code, cause.message, cause.retryable);
          }
          throw cause;
        }
      },
      ...(input.onDelta === undefined ? {} : { onDelta: input.onDelta }),
    });
  } catch (cause: unknown) {
    throw normalizeProviderError(cause);
  }
  const generated: NativeModelGenerationResult = Object.freeze({
    text: modelHubResult.text,
    usage: modelHubResult.usage,
  });
  const selectedProviderId = modelHubResult.connectionId;
  const selectedModelId = modelHubResult.modelId;
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

async function assertLatestRewriteSource(
  runtime: DesktopRuntime,
  expected: Readonly<{
    id: UuidV7;
    currentVersionId: UuidV7;
    revision: number;
    privacyRevision: number;
  }>,
): Promise<void> {
  const latest = await runtime.repositories.chapters.findById(expected.id);
  if (!latest.ok) {
    throw latest.error;
  }
  if (latest.value === null) {
    throw new AppError({
      code: "CHAPTER_NOT_FOUND",
      message: "The chapter selected for rewriting no longer exists.",
    });
  }
  if (
    latest.value.status !== "active" ||
    latest.value.currentVersionId !== expected.currentVersionId ||
    latest.value.revision !== expected.revision ||
    latest.value.privacyRevision !== expected.privacyRevision
  ) {
    throw new ModelCenterError(
      "IMPORT_REWRITE_SOURCE_CHANGED",
      "章节版本或隐私设置在 AI 发送前发生了变化；本次改写在发送 0 字后停止。请重新运行。",
      true,
    );
  }
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
    applicationIntent: {
      task: "whole_chapter_rewrite",
      application: "replace_document",
      payload: "full_document",
      startUtf16: null,
      endUtf16: null,
    },
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
  organizeLocalStoryFacts: boolean,
): Promise<
  Result<
    Readonly<{
      chapterContent: string;
      projectId: UuidV7;
      chapterId: UuidV7;
      versionId: UuidV7;
    }>,
    AppError | ModelCenterError
  >
> {
  return restoreCandidateBaseVersionInternal(runtime, candidate, organizeLocalStoryFacts);
}

async function restoreCandidateBaseVersionInternal(
  runtime: DesktopRuntime,
  candidate: AiCandidate,
  organizeLocalStoryFacts: boolean,
): Promise<
  Result<
    Readonly<{
      chapterContent: string;
      projectId: UuidV7;
      chapterId: UuidV7;
      versionId: UuidV7;
    }>,
    AppError | ModelCenterError
  >
> {
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
    organizeLocalStoryFacts,
  });
  return restored.ok
    ? ok({
        chapterContent: restored.value.chapter.content,
        projectId: restored.value.chapter.projectId,
        chapterId: restored.value.chapter.id,
        versionId: restored.value.version.id,
      })
    : restored;
}
