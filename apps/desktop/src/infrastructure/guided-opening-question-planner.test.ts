import { deriveIdeaProjectSeed } from "@inkshadow/domain";
import { describe, expect, it } from "vitest";

import {
  buildGuidedOpeningPlannerPayload,
  createDeterministicGuidedOpeningPlan,
  parseGuidedOpeningQuestionPlan,
} from "./guided-opening-question-planner";

function seed(answers: Readonly<Record<string, string>> = {}) {
  return deriveIdeaProjectSeed({
    seedId: "planner-test",
    idea: "一个转学生发现旧校舍每逢下雨就会响起铜铃。",
    answers,
    skippedQuestionKeys: [],
    now: "2026-08-13T00:00:00.000Z",
  });
}

describe("guided opening question planner", () => {
  it("creates at most three deterministic questions only for actionable gaps", () => {
    const plan = createDeterministicGuidedOpeningPlan({
      originalIdea: "一个转学生发现旧校舍每逢下雨就会响起铜铃。",
      selectedOpening: "雨落下来时，她第一次听见了铃声。",
      answers: {},
      projectSeed: seed(),
    });

    expect(plan.source).toBe("deterministic_fallback");
    expect(plan.questions).toHaveLength(3);
    expect(new Set(plan.questions.map(({ questionId }) => questionId)).size).toBe(3);
    expect(
      plan.questions.every(({ targetFields }) =>
        targetFields.every(
          (field) =>
            plan.gaps.missing.includes(field) ||
            plan.gaps.ambiguous.includes(field) ||
            plan.gaps.conflicting.includes(field),
        ),
      ),
    ).toBe(true);
  });

  it("returns zero questions when all core fields are confirmed", () => {
    const answers = {
      opening_direction: "追查铃声来源",
      protagonist: "谨慎敏锐的转学生",
      conflict: "必须在校舍封闭前找到铜铃",
      relationship: "与值日生刚认识",
      pov: "第三人称限知",
      tone: "紧张悬疑",
      genre: "校园悬疑",
      world: "当代沿海小城",
      style: "短句、克制",
      boundaries: "不写超自然定论",
    };
    const plan = createDeterministicGuidedOpeningPlan({
      originalIdea: "一个转学生发现旧校舍每逢下雨就会响起铜铃。",
      selectedOpening: "雨落下来时，她第一次听见了铃声。",
      answers,
      projectSeed: seed(answers),
    });

    expect(plan.questions).toEqual([]);
  });

  it("projects known relationship, world and writing preferences without asking them again", () => {
    const answers = {
      relationship: "刚认识但彼此戒备",
      world: "当代沿海小城",
      style: "短句、克制",
    };
    const projectSeed = seed(answers);
    const input = {
      originalIdea: "一个转学生发现旧校舍每逢下雨就会响起铜铃。",
      selectedOpening: "雨落下来时，她第一次听见了铃声。",
      answers,
      projectSeed,
    };
    const plan = createDeterministicGuidedOpeningPlan(input);
    expect(plan.questions.flatMap(({ targetFields }) => targetFields)).not.toEqual(
      expect.arrayContaining(["relationships", "world", "style"]),
    );

    const payload = buildGuidedOpeningPlannerPayload(input, plan.gaps);
    expect(payload.relationships).toEqual(
      expect.objectContaining({ values: ["刚认识但彼此戒备"] }),
    );
    expect(payload.worldRules).toEqual(["当代沿海小城"]);
    expect(payload.writingPreferences).toEqual(["短句、克制"]);
    expect(payload.openQuestions).toEqual(expect.any(Array));
  });

  it("rejects persisted planner snapshots with duplicate or non-gap questions", () => {
    const plan = createDeterministicGuidedOpeningPlan({
      originalIdea: "一个转学生发现旧校舍每逢下雨就会响起铜铃。",
      selectedOpening: "雨落下来时，她第一次听见了铃声。",
      answers: {},
      projectSeed: seed(),
    });
    const first = plan.questions[0];
    if (first === undefined) throw new Error("expected a deterministic question");
    expect(parseGuidedOpeningQuestionPlan(plan)).not.toBeNull();
    expect(
      parseGuidedOpeningQuestionPlan({
        ...plan,
        questions: [first, first],
      }),
    ).toBeNull();
  });

  it("rejects a question that would attribute one answer to multiple seed fields", () => {
    const plan = createDeterministicGuidedOpeningPlan({
      originalIdea: "一个转学生发现旧校舍每逢下雨就会响起铜铃。",
      selectedOpening: "雨落下来时，她第一次听见了铃声。",
      answers: {},
      projectSeed: seed(),
    });
    const [first, second] = plan.questions;
    if (first === undefined || second?.targetFields[0] === undefined) {
      throw new Error("expected at least two deterministic questions");
    }

    expect(
      parseGuidedOpeningQuestionPlan({
        ...plan,
        questions: [
          {
            ...first,
            targetFields: [first.targetFields[0], second.targetFields[0]],
          },
        ],
      }),
    ).toBeNull();
  });
});
