import { describe, expect, it } from "vitest";

import {
  CandidateSafetyError,
  buildCandidateApplicationPlan,
  type AiCandidate,
} from "../src/index.js";

const candidate: AiCandidate = {
  id: "candidate-1",
  projectId: "project-1",
  chapterId: "chapter-1",
  source: "generate",
  baseVersionId: "version-1",
  content: "候选正文",
  status: "ready",
  createdAt: "2026-07-27T00:00:00.000Z",
};

const validContext = {
  actorId: "actor-1",
  projectId: "project-1",
  chapterId: "chapter-1",
  currentVersionId: "version-1",
  canEdit: true,
  targetLocked: false,
  confirmedByUser: true,
  mode: "create_chapter_version",
} as const;

describe("candidate safety", () => {
  it("returns a plan requiring a recovery point without mutating正文", () => {
    const plan = buildCandidateApplicationPlan(candidate, validContext);

    expect(plan.recoveryPointRequired).toBe(true);
    expect(plan.expectedBaseVersionId).toBe("version-1");
    expect(plan.auditEvent).toBe("ai_candidate.apply_requested");
    expect(candidate.status).toBe("ready");
  });

  it("rejects stale base versions", () => {
    expect(() =>
      buildCandidateApplicationPlan(candidate, {
        ...validContext,
        currentVersionId: "version-2",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "BASE_VERSION_CHANGED",
      }),
    );
  });

  it("rejects application without explicit user confirmation", () => {
    expect(() =>
      buildCandidateApplicationPlan(candidate, {
        ...validContext,
        confirmedByUser: false,
      }),
    ).toThrow(CandidateSafetyError);
  });

  it("requires polish to target a valid selection", () => {
    const polishCandidate: AiCandidate = {
      ...candidate,
      source: "polish",
    };

    expect(() => buildCandidateApplicationPlan(polishCandidate, validContext)).toThrow(
      expect.objectContaining({
        code: "POLISH_MUST_REPLACE_SELECTION",
      }),
    );

    expect(
      buildCandidateApplicationPlan(polishCandidate, {
        ...validContext,
        mode: "replace_selection",
        selection: {
          start: 1,
          end: 3,
        },
      }).selection,
    ).toEqual({
      start: 1,
      end: 3,
    });
  });

  it("does not allow What-if output to modify a formal chapter", () => {
    expect(() =>
      buildCandidateApplicationPlan(
        {
          ...candidate,
          source: "whatif",
        },
        validContext,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CANDIDATE_SOURCE_NOT_APPLICABLE",
      }),
    );
  });
});
