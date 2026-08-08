import { describe, expect, it } from "vitest";

import { selectWritingPreferenceContextCandidates } from "./writing-preference-context-adapter";
import type { WritingPreference } from "./writing-feedback-store";

function preference(
  overrides: Partial<WritingPreference> & Pick<WritingPreference, "id" | "preferenceText">,
): WritingPreference {
  return {
    id: overrides.id,
    projectId: "0198929e-845b-7a8a-9f12-1234567890ab",
    preferenceText: overrides.preferenceText,
    source: overrides.source ?? "manual",
    sourceFeedbackCode: overrides.sourceFeedbackCode ?? null,
    sourceFeedbackHash: overrides.sourceFeedbackHash ?? null,
    evidenceCount: overrides.evidenceCount ?? 0,
    enabled: overrides.enabled ?? true,
    revision: overrides.revision ?? 1,
    createdAt: overrides.createdAt ?? "2026-08-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-01T00:00:00.000Z",
    deletedAt: overrides.deletedAt ?? null,
  };
}

describe("writing preference context adapter", () => {
  it("includes only enabled visible preferences as user input evidence", () => {
    const candidates = selectWritingPreferenceContextCandidates([
      preference({
        id: "0198929e-845b-7a8a-9f12-1234567890ac",
        preferenceText: "增加自然对话。",
        source: "feedback_pattern",
        sourceFeedbackCode: "natural_dialogue",
        evidenceCount: 3,
      }),
      preference({
        id: "0198929e-845b-7a8a-9f12-1234567890ad",
        preferenceText: "已停用。",
        enabled: false,
      }),
      preference({
        id: "0198929e-845b-7a8a-9f12-1234567890ae",
        preferenceText: "已删除。",
        deletedAt: "2026-08-01T01:00:00.000Z",
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      layer: "current_task",
      required: false,
    });
    expect(candidates[0]?.content).toContain("增加自然对话");
    expect(candidates[0]?.evidence[0]).toMatchObject({
      sourceType: "user_input",
      locator: "writing_preference",
    });
  });

  it("bounds the context and prefers recently edited preferences", () => {
    const candidates = selectWritingPreferenceContextCandidates(
      Array.from({ length: 30 }, (_, index) =>
        preference({
          id: `0198929e-845b-7a8a-9f12-${String(123456789100 + index).padStart(12, "0")}`,
          preferenceText: `偏好 ${String(index)}`,
          updatedAt: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        }),
      ),
    );

    expect(candidates).toHaveLength(24);
    expect(candidates[0]?.content).toContain("偏好 29");
  });
});
