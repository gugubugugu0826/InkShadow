import type { ContextCandidate } from "@inkshadow/ai-core";

import type { WritingPreference } from "./writing-feedback-store";

const MAXIMUM_PREFERENCES = 24;

/**
 * Adds only visible, enabled preferences as optional supplemental context.
 * They remain below the saved chapter and governed story sources, and their
 * own evidence keeps the final trace auditable.
 */
export function selectWritingPreferenceContextCandidates(
  preferences: readonly WritingPreference[],
): readonly ContextCandidate[] {
  return Object.freeze(
    preferences
      .filter((preference) => preference.deletedAt === null && preference.enabled)
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
      )
      .slice(0, MAXIMUM_PREFERENCES)
      .map((preference, index) => ({
        id: `writing-preference:${preference.id}`,
        layer: "rerank_supplement" as const,
        content: preference.preferenceText,
        selectionReason:
          preference.source === "manual"
            ? "用户手动保存并启用的写作偏好。"
            : `用户重复选择同类反馈后形成的可编辑偏好（${String(preference.evidenceCount)} 次）。`,
        priority: -200 - index,
        evidence: Object.freeze([
          {
            sourceType: "user_input" as const,
            sourceId: preference.id,
            sourceVersionId: String(preference.revision),
            locator: "writing_preference",
            contentHash: null,
            excerpt: preference.preferenceText,
          },
        ]),
      })),
  );
}
