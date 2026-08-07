import { describe, expect, it } from "vitest";

import { StoryFact } from "../src/index.js";
import { unwrap, uuid } from "./helpers.js";

const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-01T00:01:00.000Z";
const T2 = "2026-08-01T00:02:00.000Z";

describe("unified story facts", () => {
  it("never lets an AI inference arrive as a formal fact", () => {
    const directFormal = StoryFact.create({
      id: uuid(1),
      projectId: uuid(2),
      factType: "character.state",
      contentText: "林遥仍然活着。",
      source: {
        kind: "system_derivation",
        reference: "extraction-job:job-1:candidate-1",
      },
      confidence: 0.91,
      status: "formal",
      origin: "ai_extraction",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: uuid(3),
      now: T0,
    });

    expect(directFormal.ok).toBe(false);
    if (!directFormal.ok) {
      expect(directFormal.error.code).toBe("STORY_VALIDATION_FAILED");
    }

    const hiddenReview = StoryFact.create({
      id: uuid(4),
      projectId: uuid(2),
      factType: "character.state",
      contentText: "林遥仍然活着。",
      source: {
        kind: "system_derivation",
        reference: "extraction-job:job-1:candidate-2",
      },
      confidence: 0.91,
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: false,
      humanConfirmed: false,
      now: T0,
    });
    expect(hiddenReview.ok).toBe(false);
  });

  it("promotes an AI fact only through explicit review and keeps the evidence immutable", () => {
    const original = unwrap(
      StoryFact.create({
        id: uuid(10),
        projectId: uuid(11),
        factType: "relationship",
        structuredValue: { from: "林遥", to: "苏晚", relation: "盟友" },
        source: {
          kind: "chapter_span",
          reference: `chapter-version:${uuid(13)}#2:6`,
          chapterId: uuid(12),
          versionId: uuid(13),
          startOffset: 2,
          endOffset: 6,
          sourceLength: 10,
          excerpt: "成为盟友",
        },
        effectiveAt: "第一卷/第三章/雨夜之后",
        confidence: 0.84,
        status: "unconfirmed",
        origin: "ai_extraction",
        needsReview: true,
        humanConfirmed: false,
        now: T0,
      }),
    );

    const refused = original.confirm({
      actorId: uuid(14),
      humanConfirmed: false,
      expectedRevision: 1,
      lock: true,
      now: T1,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("HUMAN_DECISION_REQUIRED");
    }

    const confirmed = unwrap(
      original.confirm({
        actorId: uuid(14),
        humanConfirmed: true,
        expectedRevision: 1,
        lock: true,
        now: T1,
      }),
    );
    expect(confirmed.toSnapshot()).toMatchObject({
      status: "formal",
      origin: "ai_extraction",
      userConfirmed: true,
      locked: true,
      deprecated: false,
      needsReview: false,
      confirmedByActorId: uuid(14),
      revision: 2,
    });
    expect(confirmed.toSnapshot().source).toEqual(original.toSnapshot().source);

    const deprecated = unwrap(
      confirmed.deprecate({
        humanConfirmed: true,
        expectedRevision: 2,
        now: T2,
      }),
    );
    expect(deprecated.toSnapshot()).toMatchObject({
      status: "deprecated",
      userConfirmed: true,
      locked: false,
      deprecated: true,
      needsReview: false,
      revision: 3,
    });
  });

  it("requires complete chapter evidence and a branch identifier for branch facts", () => {
    const incompleteSource = StoryFact.create({
      id: uuid(20),
      projectId: uuid(21),
      factType: "timeline_event",
      contentText: "列车离站。",
      source: {
        kind: "chapter_span",
        reference: "chapter-version:missing",
        chapterId: uuid(22),
        versionId: uuid(23),
        startOffset: 0,
        endOffset: 4,
        sourceLength: 100,
        excerpt: "列车离",
      },
      confidence: 0.8,
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
      humanConfirmed: false,
      now: T0,
    });
    expect(incompleteSource.ok).toBe(false);

    const missingBranch = StoryFact.create({
      id: uuid(24),
      projectId: uuid(21),
      factType: "timeline_event",
      contentText: "列车没有离站。",
      source: {
        kind: "user_statement",
        reference: "user-decision:what-if-1",
      },
      confidence: 1,
      status: "branch",
      origin: "user",
      needsReview: false,
      humanConfirmed: false,
      now: T0,
    });
    expect(missingBranch.ok).toBe(false);
  });

  it("retires only disposable system rebuilds without a forged human decision", () => {
    const rebuildable = unwrap(
      StoryFact.create({
        id: uuid(30),
        projectId: uuid(31),
        factType: "chapter_summary",
        contentText: "A rebuildable summary.",
        source: { kind: "system_derivation", reference: "summary:chapter-1" },
        confidence: 1,
        status: "temporary",
        origin: "system",
        needsReview: false,
        humanConfirmed: false,
        now: T0,
      }),
    );
    const retired = unwrap(
      rebuildable.deprecateRebuildableSystemFact({ expectedRevision: 1, now: T1 }),
    );
    expect(retired.toSnapshot()).toMatchObject({
      status: "deprecated",
      origin: "system",
      userConfirmed: false,
      deprecated: true,
      revision: 2,
    });

    const formal = unwrap(
      StoryFact.create({
        id: uuid(32),
        projectId: uuid(31),
        factType: "chapter_summary",
        contentText: "A user-authored summary.",
        source: { kind: "user_statement", reference: "user:summary" },
        confidence: 1,
        status: "formal",
        origin: "user",
        needsReview: false,
        humanConfirmed: true,
        confirmationActorId: uuid(33),
        now: T0,
      }),
    );
    expect(formal.deprecateRebuildableSystemFact({ expectedRevision: 1, now: T1 })).toMatchObject({
      ok: false,
      error: { code: "STORY_FACT_INVALID_TRANSITION" },
    });
  });
});
