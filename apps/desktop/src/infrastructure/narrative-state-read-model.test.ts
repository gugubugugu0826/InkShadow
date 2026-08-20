import { createEvidenceRef } from "@inkshadow/ai-core";
import { StoryFact } from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import {
  buildNarrativeStateReadView,
  normalizeStoryMemoryRetrievalScope,
} from "./narrative-state-read-model";

const NOW = "2026-08-20T00:00:00.000Z";

describe("NarrativeState read projection", () => {
  it("is deterministic across rebuild/restart order and hard-filters future and wrong-POV state", () => {
    const current = candidate(10, "character_state", uuid(50), 2);
    const future = candidate(11, "timeline_event", uuid(50), 9);
    const wrongPov = candidate(12, "pov_knowledge", uuid(51), 1);
    const scope = normalizeStoryMemoryRetrievalScope({
      projectId: uuid(1),
      currentBranchId: null,
      currentChapterId: uuid(2),
      currentImmutableVersionId: uuid(3),
      currentPovCharacterId: uuid(50),
      currentStoryOrder: 3,
      taskType: "continuation",
      privacy: "standard",
      authorityRevision: 7,
      destination: "local",
      observedAt: NOW,
    });

    const first = buildNarrativeStateReadView(scope, [future, current, wrongPov]);
    const afterRestart = buildNarrativeStateReadView(scope, [wrongPov, current, future]);

    expect(afterRestart).toEqual(first);
    expect(first.atoms.map(({ id }) => id)).toEqual([uuid(10)]);
    expect(first.omissions).toEqual([
      { sourceId: uuid(11), reason: "future_story_state" },
      { sourceId: uuid(12), reason: "pov_character_mismatch" },
    ]);
    expect(first.insufficientEvidence).toBe(false);
  });

  it("does not guess missing POV or story time from fact content", () => {
    const scope = normalizeStoryMemoryRetrievalScope({
      projectId: uuid(1),
      currentBranchId: null,
      currentChapterId: uuid(2),
      currentImmutableVersionId: uuid(3),
      destination: "local",
      observedAt: NOW,
    });
    const projection = buildNarrativeStateReadView(scope, [
      candidate(10, "pov_knowledge", uuid(50), 2),
    ]);

    expect(projection.insufficientEvidence).toBe(true);
    expect(projection.povCharacterId).toBeNull();
    expect(projection.storyOrder).toBeNull();
    expect(projection.omissions).toEqual(
      expect.arrayContaining([
        { sourceId: null, reason: "pov_scope_missing" },
        { sourceId: null, reason: "story_time_scope_missing" },
      ]),
    );
  });
});

function candidate(id: number, factType: string, characterId: string, storyOrder: number) {
  const fact = expectOk(
    StoryFact.create({
      id: uuid(id),
      projectId: uuid(1),
      factType,
      contentText: `fact-${String(id)}`,
      structuredValue: {
        projection: { pov: { characterId, effectiveRange: { startOrder: storyOrder } } },
      },
      source: { kind: "user_statement", reference: `test:${String(id)}` },
      confidence: 1,
      status: "formal",
      origin: "user",
      needsReview: false,
      humanConfirmed: true,
      confirmationActorId: uuid(99),
      now: NOW,
    }),
  );
  return {
    snapshot: fact.toSnapshot(),
    content: `fact-${String(id)}`,
    evidence: createEvidenceRef({
      projectId: uuid(1),
      chapterId: null,
      immutableVersionId: null,
      sourceKind: "story_fact",
      locator: { kind: "stable", value: `fact:${String(id)}` },
      excerptDigest: "a".repeat(64),
      sourceCreatedAt: NOW,
      observedAt: NOW,
      currentness: "current",
      branchId: null,
      privacy: "standard",
    }),
  };
}

function expectOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("Expected success");
  return result.value;
}

function uuid(seed: number): string {
  return `018f0f00-0000-7000-8000-${seed.toString().padStart(12, "0")}`;
}
