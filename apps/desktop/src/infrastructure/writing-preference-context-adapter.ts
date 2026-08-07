import type { ContextCandidateDraft } from "@inkshadow/ai-core";

import type { WritingPreference } from "./writing-feedback-store";

const MAXIMUM_PREFERENCES = 24;

/**
 * Adds only visible, enabled preferences to the generation task layer. The
 * text is clearly delimited as user-authored data and is never interpreted as
 * a hidden system policy.
 */
export function selectWritingPreferenceContextCandidates(
  preferences: readonly WritingPreference[],
): readonly ContextCandidateDraft[] {
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
        layer: "current_task" as const,
        content: ["【用户可见的写作偏好】", preference.preferenceText, "【写作偏好结束】"].join(
          "\n",
        ),
        selectionReason:
          preference.source === "manual"
            ? "用户手动保存并启用的写作偏好。"
            : `用户重复选择同类反馈后形成的可编辑偏好（${String(preference.evidenceCount)} 次）。`,
        priority: 780 - index,
        required: false,
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
