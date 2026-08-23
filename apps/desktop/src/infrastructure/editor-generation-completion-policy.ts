import type { CandidateQualityGateResult } from "@inkshadow/ai-core";

export type EditorGenerationAction =
  "opening" | "continuation" | "selection_rewrite" | "polish" | "expand" | "shorten";

export type EditorGenerationCompletionDecision =
  | Readonly<{ kind: "review"; notice: string }>
  | Readonly<{
      kind: "keep_isolated";
      reason: "incomplete" | "quality_blocked" | "missing_candidate";
      notice: string;
    }>;

/**
 * This is the single editor policy boundary between direct and professional
 * writing. Generation still persists its complete output in the existing
 * isolated record first. No writing mode may cross into the atomic
 * 正文/version acceptance transaction until the author explicitly chooses to
 * use the visible result.
 */
export function decideEditorGenerationCompletion(input: {
  readonly mode: "direct" | "professional";
  readonly action: EditorGenerationAction;
  readonly candidateReady: boolean;
  readonly incomplete: boolean;
  readonly qualityGateOutcome: CandidateQualityGateResult["outcome"] | null;
}): EditorGenerationCompletionDecision {
  if (!input.candidateReady) {
    return Object.freeze({
      kind: "keep_isolated",
      reason: "missing_candidate",
      notice: "本次没有得到可用结果，正文未改变，请稍后重试。",
    });
  }
  const resultLabel =
    input.action === "opening"
      ? "开头"
      : input.action === "polish"
        ? "润色"
        : input.action === "expand"
          ? "扩写"
          : input.action === "shorten"
            ? "缩写"
            : input.action === "selection_rewrite"
              ? "改写"
              : "续写";
  const safetyNote = input.incomplete
    ? "本次结果尚未完整，"
    : input.qualityGateOutcome === "block"
      ? "本机检查发现需要留意的问题，"
      : "";
  return Object.freeze({
    kind: "review",
    notice:
      input.mode === "direct"
        ? `创作结果已保存并与正文隔离。${safetyNote}请查看后明确选择是否使用这次${resultLabel}。`
        : `建议已生成并保持隔离。${safetyNote}正文和版本没有改变，请查看后决定是否使用。`,
  });
}
