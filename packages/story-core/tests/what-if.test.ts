import { describe, expect, it } from "vitest";
import {
  FormalStoryRecord,
  StoryCoreError,
  WhatIfApplicationService,
  WhatIfBranch,
  err,
  ok,
  type FormalTimelineReader,
  type WhatIfPromotionUnitOfWork,
  type WhatIfRepository,
} from "../src/index.js";
import { ManualClock, SequenceUuidV7Generator, unwrap, uuid } from "./helpers.js";

describe("What-if sandbox", () => {
  it("compares effects without exposing a formal timeline commit", () => {
    const projectId = uuid(1);
    const event = createTimelineEvent(projectId);
    const originalEventSnapshot = event.toSnapshot();
    const branch = unwrap(
      WhatIfBranch.create({
        id: uuid(10),
        projectId,
        sourceEventId: event.id,
        baseTimelineRevision: 7,
        hypothesis: "What if the envoy never arrived?",
        now: "2026-07-27T00:00:00.000Z",
      }),
    );

    const premature = branch.compareToFormalTimeline(7, [event]);
    expect(premature.ok).toBe(false);
    if (!premature.ok) {
      expect(premature.error.code).toBe("WHAT_IF_INVALID_TRANSITION");
    }

    const simulated = unwrap(
      branch.recordSimulation({
        effects: [
          {
            id: uuid(11),
            effectType: "character.reaction",
            summary: "Lin travels south instead.",
            impactedRecordIds: [uuid(12)],
            confidence: 0.66,
          },
        ],
        expectedRevision: 1,
        now: "2026-07-27T00:01:00.000Z",
      }),
    );
    const comparison = unwrap(simulated.compareToFormalTimeline(7, [event]));
    expect(comparison).toMatchObject({
      branchId: uuid(10),
      baseTimelineRevision: 7,
      formalTimelineRevision: 7,
      sandbox: true,
      canCommitFormalTimeline: false,
    });
    expect(comparison.formalEventIds).toEqual([event.id]);
    expect(event.toSnapshot()).toEqual(originalEventSnapshot);

    const formalCommit = simulated.requestFormalTimelineCommit();
    expect(formalCommit.ok).toBe(false);
    if (!formalCommit.ok) {
      expect(formalCommit.error.code).toBe("WHAT_IF_FORMAL_COMMIT_FORBIDDEN");
    }
  });

  it("can only promote a simulated result to an outline draft", () => {
    const projectId = uuid(20);
    const event = createTimelineEvent(projectId, 21);
    const simulated = unwrap(
      unwrap(
        WhatIfBranch.create({
          id: uuid(22),
          projectId,
          sourceEventId: event.id,
          baseTimelineRevision: 3,
          hypothesis: "What if the gate remains closed?",
          now: "2026-07-27T00:00:00.000Z",
        }),
      ).recordSimulation({
        effects: [
          {
            id: uuid(23),
            effectType: "plot.divergence",
            summary: "The party searches for another route.",
            impactedRecordIds: [event.id],
            confidence: 0.74,
          },
        ],
        expectedRevision: 1,
        now: "2026-07-27T00:01:00.000Z",
      }),
    );

    const refused = simulated.promoteToOutlineDraft({
      draftId: uuid(24),
      title: "Closed gate branch",
      synopsis: "A bounded outline-only alternative.",
      actorId: uuid(25),
      humanConfirmed: false,
      expectedRevision: 2,
      now: "2026-07-27T00:02:00.000Z",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("HUMAN_DECISION_REQUIRED");
    }
    expect(simulated.status).toBe("simulated");

    const promoted = unwrap(
      simulated.promoteToOutlineDraft({
        draftId: uuid(24),
        title: "Closed gate branch",
        synopsis: "A bounded outline-only alternative.",
        actorId: uuid(25),
        humanConfirmed: true,
        expectedRevision: 2,
        now: "2026-07-27T00:02:00.000Z",
      }),
    );
    expect(promoted.branch.status).toBe("promoted_to_outline_draft");
    expect(promoted.draft).toMatchObject({
      id: uuid(24),
      sourceBranchId: uuid(22),
      projectId,
      target: "outline_draft",
    });
    expect(promoted.draft).not.toHaveProperty("timelineEvents");
  });

  it("does not persist branch promotion when the atomic draft insert fails", async () => {
    const projectId = uuid(40);
    const event = createTimelineEvent(projectId, 41);
    const storedBranch = unwrap(
      unwrap(
        WhatIfBranch.create({
          id: uuid(42),
          projectId,
          sourceEventId: event.id,
          baseTimelineRevision: 5,
          hypothesis: "What if the bridge collapses?",
          now: "2026-07-27T00:00:00.000Z",
        }),
      ).recordSimulation({
        effects: [
          {
            id: uuid(43),
            effectType: "plot.divergence",
            summary: "The party remains on the eastern bank.",
            impactedRecordIds: [event.id],
            confidence: 0.7,
          },
        ],
        expectedRevision: 1,
        now: "2026-07-27T00:01:00.000Z",
      }),
    );
    let persistedBranch = storedBranch;
    let promotionAttempts = 0;
    const branches: WhatIfRepository = {
      create: (branch) => {
        persistedBranch = branch;
        return Promise.resolve(ok(undefined));
      },
      findById: (id) => Promise.resolve(ok(id === persistedBranch.id ? persistedBranch : null)),
      save: (branch, expectedRevision) => {
        if (persistedBranch.revision !== expectedRevision) {
          return Promise.resolve(
            err(
              new StoryCoreError({
                code: "STORY_REVISION_CONFLICT",
                message: "What-if branch changed.",
              }),
            ),
          );
        }
        persistedBranch = branch;
        return Promise.resolve(ok(undefined));
      },
    };
    const timeline: FormalTimelineReader = {
      load: () =>
        Promise.resolve(
          ok({
            projectId: event.projectId,
            revision: 5,
            events: [event],
          }),
        ),
    };
    const promotions: WhatIfPromotionUnitOfWork = {
      commit: () => {
        promotionAttempts += 1;
        return Promise.resolve(
          err(
            new StoryCoreError({
              code: "STORY_REPOSITORY_ERROR",
              message: "Outline draft insert failed.",
              retryable: true,
              actions: ["RETRY"],
            }),
          ),
        );
      },
    };
    const service = new WhatIfApplicationService({
      branches,
      timeline,
      promotions,
      clock: new ManualClock("2026-07-27T00:02:00.000Z"),
      ids: new SequenceUuidV7Generator(3_000),
    });

    const result = await service.promoteToOutlineDraft({
      branchId: storedBranch.id,
      title: "Collapsed bridge",
      synopsis: "An outline-only alternate route.",
      actorId: uuid(44),
      humanConfirmed: true,
      expectedRevision: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STORY_REPOSITORY_ERROR");
    }
    expect(persistedBranch.status).toBe("simulated");
    expect(promotionAttempts).toBe(1);
  });
});

function createTimelineEvent(projectId: string, base = 2): FormalStoryRecord {
  return unwrap(
    FormalStoryRecord.create({
      id: uuid(base),
      projectId,
      kind: "timeline_event",
      recordKey: `timeline.event-${String(base)}`,
      value: {
        title: "Envoy arrives",
        sequence: 1,
      },
      actorId: uuid(base + 1),
      humanConfirmed: true,
      now: "2026-07-27T00:00:00.000Z",
    }),
  );
}
