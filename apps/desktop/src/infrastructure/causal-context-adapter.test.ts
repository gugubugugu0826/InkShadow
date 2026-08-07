import { describe, expect, it } from "vitest";

import {
  CausalEventGraph,
  type CausalEventNode,
  type CausalEventRelation,
  type CausalTextEvidence,
} from "@inkshadow/story-core";

import { selectCausalContextCandidates } from "./causal-context-adapter";

const evidence: CausalTextEvidence = Object.freeze({
  id: "evidence-one",
  chapterId: "chapter-one",
  chapterVersionId: "version-one",
  contentHash: "a".repeat(64),
  locator: "utf16:0-3/3",
  excerpt: "门开。",
  startOffset: 0,
  endOffset: 3,
  sourceLength: 3,
});

function event(id: string, order: number, text: string): CausalEventNode {
  return {
    id,
    projectId: "project-one",
    branchId: "main",
    status: "confirmed",
    participantCharacterIds: ["林夏"],
    narrativeTime: { order, label: `第 ${String(order)} 幕` },
    location: { locationId: "school", label: "旧校舍" },
    prerequisites: [],
    eventText: text,
    resultText: `${text}之后留下后果`,
    characterStateChanges: [],
    relationshipChanges: [],
    itemChanges: [],
    informedCharacterIds: ["林夏"],
    foreshadowProgress: [],
    downstreamEventIds: id === "event-one" ? ["event-two"] : [],
    evidence: { ...evidence, id: `evidence-${id}` },
  };
}

const relation: CausalEventRelation = {
  id: "relation-one",
  projectId: "project-one",
  branchId: "main",
  fromEventId: "event-one",
  toEventId: "event-two",
  kind: "causes",
  evidence: { ...evidence, id: "evidence-relation" },
};

describe("causal context adapter", () => {
  it("selects relevant confirmed events and retains causal evidence", () => {
    const graph = CausalEventGraph.create({
      events: [event("event-one", 1, "林夏打开旧校舍的门"), event("event-two", 2, "钟声响起")],
      relations: [relation],
    });

    const candidates = selectCausalContextCandidates({
      graph,
      query: "继续写林夏打开旧校舍后的场景",
      maximumEvents: 2,
    });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ id: "causal-event:event-one" });
    expect(candidates[0]?.content).toContain("event-one causes event-two");
    expect(candidates[0]?.evidence[0]).toMatchObject({
      sourceType: "causal_event",
      sourceVersionId: "version-one",
      contentHash: "a".repeat(64),
    });
  });

  it("returns an empty immutable selection for an empty graph", () => {
    const graph = CausalEventGraph.create({ events: [], relations: [] });
    const candidates = selectCausalContextCandidates({ graph, query: "继续写" });
    expect(candidates).toEqual([]);
    expect(Object.isFrozen(candidates)).toBe(true);
  });

  it("rejects an invalid event limit instead of silently widening context", () => {
    const graph = CausalEventGraph.create({
      events: [event("event-two", 1, "开门")],
      relations: [],
    });
    expect(() =>
      selectCausalContextCandidates({ graph, query: "继续写", maximumEvents: -1 }),
    ).toThrow("non-negative integer");
  });
});
