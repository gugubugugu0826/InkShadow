import { AiCandidate, type UuidV7 } from "@inkshadow/domain";

import type { ChapterValidationUiEvidence } from "./novel-validation-runtime";
import type { DesktopRuntime } from "./runtime";
import { UiActionError } from "./ui-error";

export interface EvidenceCorrectionCandidateInput {
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly expectedChapterVersionId: UuidV7;
  readonly evidence: ChapterValidationUiEvidence;
  readonly replacement: string;
}

/**
 * Creates an isolated, author-reviewable Candidate from exact validation
 * evidence. It never updates the chapter or resolves the validation issue.
 */
export async function createEvidenceCorrectionCandidate(
  runtime: DesktopRuntime,
  input: EvidenceCorrectionCandidateInput,
): Promise<AiCandidate> {
  const loaded = await runtime.repositories.chapters.findById(input.chapterId);
  if (!loaded.ok) throw loaded.error;
  const chapter = loaded.value;
  if (chapter?.projectId !== input.projectId) {
    throw correctionError("CHAPTER_NOT_FOUND", "找不到这条问题对应的当前章节。", ["重新加载章节"]);
  }
  if (chapter.status !== "active") {
    throw correctionError("CHAPTER_READ_ONLY", "当前章节不可编辑，不能创建修改建议。", [
      "恢复项目",
    ]);
  }
  if (
    chapter.currentVersionId !== input.expectedChapterVersionId ||
    input.evidence.sourceKind !== "chapter" ||
    input.evidence.sourceId !== input.chapterId ||
    input.evidence.sourceVersionId !== input.expectedChapterVersionId
  ) {
    throw correctionError(
      "BASE_VERSION_CHANGED",
      "正文或证据版本已经变化。请重新检查本章后再创建修改建议。",
      ["重新检查本章"],
    );
  }

  const { startOffset, endOffset, excerpt, sourceLength } = input.evidence;
  if (
    !Number.isInteger(startOffset) ||
    !Number.isInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > chapter.content.length ||
    sourceLength !== chapter.content.length ||
    chapter.content.slice(startOffset, endOffset) !== excerpt
  ) {
    throw correctionError(
      "EVIDENCE_MISMATCH",
      "原文位置已经不能精确对应当前正文。请重新检查，墨影不会猜测替换位置。",
      ["重新检查本章"],
    );
  }
  const currentChecksum = await runtime.hasher.sha256(chapter.content);
  if (!currentChecksum.ok) throw currentChecksum.error;
  if (currentChecksum.value !== input.evidence.contentHash) {
    throw correctionError(
      "EVIDENCE_HASH_MISMATCH",
      "原文完整性校验不一致。请重新检查本章后再试。",
      ["重新检查本章"],
    );
  }

  const replacement = input.replacement.normalize("NFKC").trim();
  if (replacement.length === 0) {
    throw correctionError(
      "VALIDATION_FAILED",
      "这条问题没有足够明确的替换内容，不能自动生成修改建议。",
      ["手动修改"],
    );
  }
  const nextContent = `${chapter.content.slice(0, startOffset)}${replacement}${chapter.content.slice(endOffset)}`;
  if (nextContent === chapter.content) {
    throw correctionError("NO_CHANGES", "建议内容与当前正文相同，不需要创建新建议。", ["手动修改"]);
  }

  const now = runtime.clock.now();
  const streaming = AiCandidate.createStreaming({
    id: runtime.ids.next(),
    projectId: input.projectId,
    chapterId: input.chapterId,
    source: "polish",
    baseVersionId: input.expectedChapterVersionId,
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
  const checksum = await runtime.hasher.sha256(nextContent);
  if (!checksum.ok) throw checksum.error;
  const ready = streaming.value.markReady(nextContent, checksum.value, now);
  if (!ready.ok) throw ready.error;
  const persisted = await runtime.repositories.aiCandidates.create(ready.value);
  if (!persisted.ok) throw persisted.error;
  return ready.value;
}

function correctionError(code: string, message: string, actions: readonly string[]): UiActionError {
  return new UiActionError(
    code,
    `${message}${actions.length === 0 ? "" : ` 可尝试：${actions.join("、")}。`}`,
    "无法创建修改建议",
  );
}
