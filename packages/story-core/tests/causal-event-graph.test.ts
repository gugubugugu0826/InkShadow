import { describe, expect, it } from "vitest";

import {
  CAUSAL_EVENT_RELATION_KINDS,
  CausalEventGraph,
  type CausalEventGraphInput,
  type CausalEventNode,
  type CausalEventRelation,
  type CausalEventRelationKind,
  type CausalTextEvidence,
} from "../src/causal-event-graph.js";

const HASH = "a".repeat(64);
const PROJECT_ID = "project-one";

describe("evidence-backed causal event graph", () => {
  it("models the complete event state and every required relation kind", () => {
    const graph = CausalEventGraph.create(fullRelationGraph());

    expect(graph.relations.map(({ kind }) => kind).sort()).toEqual(
      [...CAUSAL_EVENT_RELATION_KINDS].sort(),
    );
    expect(graph.events.find(({ id }) => id === "event-a")).toMatchObject({
      status: "confirmed",
      participantCharacterIds: ["character-hero", "character-guide"],
      narrativeTime: { order: 1, label: "First night" },
      location: { locationId: "old-gate", label: "Old city gate" },
      prerequisites: [
        {
          kind: "state",
          referenceId: "state-gate-open",
          description: "The gate must be open.",
        },
      ],
      eventText: "The hero enters the old city.",
      resultText: "The hidden guide notices the hero.",
      characterStateChanges: [
        {
          characterId: "character-hero",
          attributeKey: "location",
          beforeValue: "outside",
          afterValue: "inside",
        },
      ],
      relationshipChanges: [
        {
          fromCharacterId: "character-guide",
          toCharacterId: "character-hero",
          relationshipKey: "trust",
          beforeValue: 0,
          afterValue: 1,
        },
      ],
      itemChanges: [
        {
          itemId: "sealed-letter",
          kind: "acquired",
          fromCharacterId: null,
          toCharacterId: "character-hero",
        },
      ],
      informedCharacterIds: ["character-hero", "character-guide"],
      foreshadowProgress: [
        {
          foreshadowId: "missing-prince",
          kind: "planted",
          description: "The seal matches the vanished royal family.",
        },
      ],
      downstreamEventIds: ["event-b", "event-c", "event-d", "event-e"],
      evidence: {
        id: "evidence-event-event-a",
        chapterId: "chapter-event-event-a",
        chapterVersionId: "version-event-event-a",
      },
    });
    expect(Object.isFrozen(graph.events)).toBe(true);
    expect(Object.isFrozen(graph.events[0]?.characterStateChanges)).toBe(true);
  });

  it("traverses only evidence-backed impact edges and blocks causal cycles", () => {
    const graph = CausalEventGraph.create(cyclicChainGraph());
    const result = graph.traceImpacts({
      projectId: PROJECT_ID,
      branchId: "main",
      changedEventIds: ["event-a"],
    });

    expect(result.impactedEvents.map(({ eventId, depth }) => ({ eventId, depth }))).toEqual([
      { eventId: "event-b", depth: 1 },
      { eventId: "event-c", depth: 2 },
      { eventId: "event-d", depth: 3 },
      { eventId: "event-e", depth: 4 },
    ]);
    expect(result.impactedEvents[3]).toMatchObject({
      pathEventIds: ["event-a", "event-b", "event-c", "event-d", "event-e"],
      pathRelationIds: ["relation-ab", "relation-bc", "relation-cd", "relation-de"],
      reasons: [
        {
          relationId: "relation-de",
          kind: "reveals",
          fromEventId: "event-d",
          toEventId: "event-e",
        },
      ],
    });
    expect(result.cycleEdgesSkipped).toEqual([
      { relationId: "relation-eb", fromEventId: "event-e", toEventId: "event-b" },
    ]);
    expect(result.impactedEvents.some(({ eventId }) => eventId === "event-a")).toBe(false);
    expect(result.capabilities).toEqual({
      deterministicImpactTraversal: "ready",
      alternatePlotGeneration: "available_via_governed_service",
      uiIntegration: "available_via_governed_service",
    });
  });

  it("does not infer impact from temporal order alone", () => {
    const graph = CausalEventGraph.create({
      events: [event("event-a", 1, []), event("event-b", 2, [])],
      relations: [relation("temporal-only", "event-a", "event-b", "before")],
    });

    expect(
      graph.traceImpacts({
        projectId: PROJECT_ID,
        branchId: "main",
        changedEventIds: ["event-a"],
      }).impactedEvents,
    ).toEqual([]);
  });

  it("isolates branches and rejects cross-branch relations and trace seeds", () => {
    const main = event("event-main", 1, [], "main");
    const alternate = event("event-alternate", 1, [], "alternate");
    const isolated = CausalEventGraph.create({ events: [main, alternate], relations: [] });

    expect(() =>
      isolated.traceImpacts({
        projectId: PROJECT_ID,
        branchId: "main",
        changedEventIds: ["event-alternate"],
      }),
    ).toThrow(expect.objectContaining({ code: "CAUSAL_EVENT_GRAPH_INPUT_INVALID" }));
    expect(() =>
      isolated.traceImpacts({
        projectId: "another-project",
        branchId: "main",
        changedEventIds: ["event-main"],
      }),
    ).toThrow(/requested project and branch/iu);
    expect(() =>
      CausalEventGraph.create({
        events: [main, alternate],
        relations: [
          {
            ...relation("cross-branch", "event-main", "event-alternate", "causes"),
            branchId: "main",
          },
        ],
      }),
    ).toThrow(/cannot cross a project or story branch/iu);
  });

  it("requires exact evidence for events, changes, prerequisites, and relations", () => {
    const valid = cyclicChainGraph();
    const first = valid.events[0];
    const firstRelation = valid.relations[0];
    if (first === undefined || firstRelation === undefined) {
      throw new Error("Expected graph fixtures.");
    }

    expect(() =>
      CausalEventGraph.create({
        ...valid,
        events: [{ ...first, evidence: undefined }, ...valid.events.slice(1)],
      } as unknown as CausalEventGraphInput),
    ).toThrow(/exact immutable chapter-version span/iu);
    expect(() =>
      CausalEventGraph.create({
        ...valid,
        relations: [
          { ...firstRelation, evidence: { ...firstRelation.evidence, contentHash: "bad" } },
          ...valid.relations.slice(1),
        ],
      }),
    ).toThrow(/exact immutable chapter-version span/iu);

    const rich = fullRelationGraph();
    const richFirst = rich.events[0];
    if (richFirst === undefined) {
      throw new Error("Expected a rich event fixture.");
    }
    const prerequisite = richFirst.prerequisites[0];
    if (prerequisite === undefined) {
      throw new Error("Expected a prerequisite fixture.");
    }
    expect(() =>
      CausalEventGraph.create({
        ...rich,
        events: [
          {
            ...richFirst,
            prerequisites: [
              {
                ...prerequisite,
                evidence: { ...prerequisite.evidence, endOffset: 1 },
              },
            ],
          },
          ...rich.events.slice(1),
        ],
      }),
    ).toThrow(/exact immutable chapter-version span/iu);
  });

  it("requires declared impacts and event prerequisites to match explicit relations", () => {
    expect(() =>
      CausalEventGraph.create({
        events: [event("event-a", 1, []), event("event-b", 2, [])],
        relations: [relation("undeclared", "event-a", "event-b", "causes")],
      }),
    ).toThrow(/must be declared/iu);

    const dependent: CausalEventNode = {
      ...event("event-b", 2, []),
      prerequisites: [
        {
          id: "prerequisite-event-a",
          kind: "event",
          referenceId: "event-a",
          description: "Event A must happen first.",
          evidence: evidence("prerequisite-event-a"),
        },
      ],
    };
    expect(() =>
      CausalEventGraph.create({
        events: [event("event-a", 1, []), dependent],
        relations: [],
      }),
    ).toThrow(/incoming impact relation/iu);
  });

  it("bounds deterministic traversal without inventing replacement plot text", () => {
    const graph = CausalEventGraph.create(cyclicChainGraph());
    const depthBound = graph.traceImpacts({
      projectId: PROJECT_ID,
      branchId: "main",
      changedEventIds: ["event-a"],
      maximumDepth: 2,
    });
    expect(depthBound.impactedEvents.map(({ eventId }) => eventId)).toEqual(["event-b", "event-c"]);
    expect(depthBound).toMatchObject({
      truncated: true,
      truncationReasons: ["maximum_depth"],
    });

    const countBound = graph.traceImpacts({
      projectId: PROJECT_ID,
      branchId: "main",
      changedEventIds: ["event-a"],
      maximumImpactedEvents: 2,
    });
    expect(countBound.impactedEvents).toHaveLength(2);
    expect(countBound.truncationReasons).toContain("maximum_impacted_events");
    expect(JSON.stringify(countBound)).not.toMatch(/replacement|continuation|generatedText/iu);
  });

  it("returns the same ordered graph and trace for reversed input", () => {
    const input = cyclicChainGraph();
    const forward = CausalEventGraph.create(input);
    const reversed = CausalEventGraph.create({
      events: [...input.events].reverse(),
      relations: [...input.relations].reverse(),
    });

    expect(reversed.events).toEqual(forward.events);
    expect(reversed.relations).toEqual(forward.relations);
    expect(
      reversed.traceImpacts({
        projectId: PROJECT_ID,
        branchId: "main",
        changedEventIds: ["event-a"],
      }),
    ).toEqual(
      forward.traceImpacts({
        projectId: PROJECT_ID,
        branchId: "main",
        changedEventIds: ["event-a"],
      }),
    );
  });
});

function fullRelationGraph(): CausalEventGraphInput {
  const events = [
    richEventA(),
    event("event-b", 2, ["event-c", "event-e"]),
    event("event-c", 3, ["event-d"]),
    event("event-d", 4, ["event-e"]),
    event("event-e", 5, []),
  ];
  const relations: readonly CausalEventRelation[] = [
    relation("causes", "event-a", "event-b", "causes"),
    relation("depends", "event-a", "event-c", "depends_on"),
    relation("prevents", "event-a", "event-d", "prevents"),
    relation("reveals", "event-a", "event-e", "reveals"),
    relation("misleads", "event-b", "event-c", "misleads"),
    relation("before", "event-b", "event-d", "before"),
    relation("changes", "event-b", "event-e", "changes_state"),
    relation("information", "event-c", "event-d", "gains_information"),
    relation("item", "event-d", "event-e", "loses_item"),
  ];
  return { events, relations };
}

function cyclicChainGraph(): CausalEventGraphInput {
  return {
    events: [
      event("event-a", 1, ["event-b"]),
      event("event-b", 2, ["event-c"]),
      event("event-c", 3, ["event-d"]),
      event("event-d", 4, ["event-e"]),
      event("event-e", 5, ["event-b"]),
    ],
    relations: [
      relation("ab", "event-a", "event-b", "causes"),
      relation("ae-time", "event-a", "event-e", "before"),
      relation("bc", "event-b", "event-c", "depends_on"),
      relation("cd", "event-c", "event-d", "changes_state"),
      relation("de", "event-d", "event-e", "reveals"),
      relation("eb", "event-e", "event-b", "misleads"),
    ],
  };
}

function richEventA(): CausalEventNode {
  return {
    ...event("event-a", 1, ["event-b", "event-c", "event-d", "event-e"]),
    participantCharacterIds: ["character-hero", "character-guide"],
    narrativeTime: { order: 1, label: "First night" },
    location: { locationId: "old-gate", label: "Old city gate" },
    prerequisites: [
      {
        id: "prerequisite-gate",
        kind: "state",
        referenceId: "state-gate-open",
        description: "The gate must be open.",
        evidence: evidence("prerequisite-gate"),
      },
    ],
    eventText: "The hero enters the old city.",
    resultText: "The hidden guide notices the hero.",
    characterStateChanges: [
      {
        id: "character-change-location",
        characterId: "character-hero",
        attributeKey: "location",
        beforeValue: "outside",
        afterValue: "inside",
        evidence: evidence("character-change-location"),
      },
    ],
    relationshipChanges: [
      {
        id: "relationship-change-trust",
        fromCharacterId: "character-guide",
        toCharacterId: "character-hero",
        relationshipKey: "trust",
        beforeValue: 0,
        afterValue: 1,
        evidence: evidence("relationship-change-trust"),
      },
    ],
    itemChanges: [
      {
        id: "item-change-letter",
        itemId: "sealed-letter",
        kind: "acquired",
        fromCharacterId: null,
        toCharacterId: "character-hero",
        evidence: evidence("item-change-letter"),
      },
    ],
    informedCharacterIds: ["character-hero", "character-guide"],
    foreshadowProgress: [
      {
        id: "foreshadow-change-seal",
        foreshadowId: "missing-prince",
        kind: "planted",
        description: "The seal matches the vanished royal family.",
        evidence: evidence("foreshadow-change-seal"),
      },
    ],
  };
}

function event(
  id: string,
  order: number,
  downstreamEventIds: readonly string[],
  branchId = "main",
): CausalEventNode {
  return {
    id,
    projectId: PROJECT_ID,
    branchId,
    status: "confirmed",
    participantCharacterIds: [],
    narrativeTime: { order, label: `Story order ${String(order)}` },
    location: { locationId: `location-${id}`, label: `Location ${id}` },
    prerequisites: [],
    eventText: `Event ${id} occurs.`,
    resultText: `Event ${id} has a result.`,
    characterStateChanges: [],
    relationshipChanges: [],
    itemChanges: [],
    informedCharacterIds: [],
    foreshadowProgress: [],
    downstreamEventIds,
    evidence: evidence(`event-${id}`),
  };
}

function relation(
  id: string,
  fromEventId: string,
  toEventId: string,
  kind: CausalEventRelationKind,
): CausalEventRelation {
  return {
    id: `relation-${id}`,
    projectId: PROJECT_ID,
    branchId: "main",
    fromEventId,
    toEventId,
    kind,
    evidence: evidence(`relation-${id}`),
  };
}

function evidence(id: string): CausalTextEvidence {
  const excerpt = `Evidence ${id}`;
  return {
    id: `evidence-${id}`,
    chapterId: `chapter-${id}`,
    chapterVersionId: `version-${id}`,
    contentHash: HASH,
    locator: `paragraph:${id}`,
    excerpt,
    startOffset: 0,
    endOffset: excerpt.length,
    sourceLength: excerpt.length,
  };
}
