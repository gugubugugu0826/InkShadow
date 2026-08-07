import { CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";
import { type StoryFact, ok as storyOk, type StoryFactStore } from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import type { CausalEventGraphStore } from "./causal-event-graph-store";
import {
  CAUSAL_WHAT_IF_SCHEMA,
  type CausalWhatIfSimulationError,
  CausalWhatIfSimulationService,
  readCausalWhatIfSimulationValue,
  type CausalWhatIfModelPort,
} from "./causal-what-if-simulation-service";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const SOURCE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const IMPACT_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OUTSIDE_ID = "019f9f4a-b3c7-7350-9226-000000000004";
function event(id: string, text: string) {
  return {
    id,
    projectId: PROJECT_ID,
    branchId: "main",
    status: "confirmed" as const,
    participantCharacterIds: ["hero"],
    narrativeTime: {
      order: id === SOURCE_ID ? 1 : 2,
      label: id === SOURCE_ID ? "第一天" : "第二天",
    },
    location: { locationId: "room", label: "旧屋" },
    prerequisites: [],
    eventText: text,
    resultText: `${text}的结果`,
    characterStateChanges: [],
    relationshipChanges: [],
    itemChanges: [],
    informedCharacterIds: ["hero"],
    foreshadowProgress: [],
    downstreamEventIds: id === SOURCE_ID ? [IMPACT_ID] : [],
    evidence: {
      id: `${id}:evidence`,
      chapterId: "019f9f4a-b3c7-7350-9226-000000000020",
      chapterVersionId: "019f9f4a-b3c7-7350-9226-000000000021",
      contentHash: "a".repeat(64),
      locator: "chapter:0-4",
      excerpt: "原文证据",
      startOffset: 0,
      endOffset: 4,
      sourceLength: 4,
    },
  };
}

function fakeGraphStore(): CausalEventGraphStore {
  const events = [event(SOURCE_ID, "主角拿到钥匙"), event(IMPACT_ID, "主角打开密室")];
  const sourceEvent = events[0];
  if (sourceEvent === undefined) {
    throw new Error("The causal test fixture is missing its source event.");
  }
  return {
    replace: () => Promise.reject(new Error("not used")),
    append: () => Promise.reject(new Error("not used")),
    loadProjectBranch: () =>
      Promise.resolve({
        events,
        relations: [
          {
            id: "019f9f4a-b3c7-7350-9226-000000000030",
            projectId: PROJECT_ID,
            branchId: "main",
            fromEventId: SOURCE_ID,
            toEventId: IMPACT_ID,
            kind: "causes",
            evidence: sourceEvent.evidence,
          },
        ],
      } as never),
    traceImpacts: () =>
      Promise.resolve({
        projectId: PROJECT_ID,
        branchId: "main",
        changedEventIds: [SOURCE_ID],
        impactedEvents: [
          {
            eventId: IMPACT_ID,
            depth: 1,
            pathEventIds: [SOURCE_ID, IMPACT_ID],
            pathRelationIds: ["019f9f4a-b3c7-7350-9226-000000000030"],
            reasons: [],
          },
        ],
        cycleEdgesSkipped: [],
        truncated: false,
        truncationReasons: [],
        capabilities: {
          deterministicImpactTraversal: "ready",
          alternatePlotGeneration: "available_via_governed_service",
          uiIntegration: "available_via_governed_service",
        },
      }),
  };
}

function fakeFactStore(saved: StoryFact[]): StoryFactStore {
  return {
    create: (fact) => {
      saved.push(fact);
      return Promise.resolve(storyOk(undefined));
    },
    findById: () => Promise.resolve(storyOk(null)),
    listByProjectId: (_projectId, filter) =>
      Promise.resolve(
        storyOk(
          saved.filter((fact) => {
            const snapshot = fact.toSnapshot();
            return (
              (filter?.status === undefined || snapshot.status === filter.status) &&
              (filter?.factType === undefined || snapshot.factType === filter.factType)
            );
          }),
        ),
      ),
    save: () => Promise.resolve(storyOk(undefined)),
    listRevisions: () => Promise.resolve(storyOk([])),
  };
}

describe("causal what-if simulation service", () => {
  it("uses deterministic impact scope and persists only an isolated branch fact", async () => {
    const saved: StoryFact[] = [];
    const model: CausalWhatIfModelPort = {
      simulate: (input) => {
        expect(input.sourceEvent.id).toBe(SOURCE_ID);
        expect(input.impactedEvents.map(({ id }) => id)).toEqual([IMPACT_ID]);
        return Promise.resolve({
          alternateDirection: "如果主角没有拿到钥匙，他需要先赢得守门人的信任。",
          effects: [
            {
              eventId: IMPACT_ID,
              summary: "密室事件将推迟，并改为由守门人主动揭示入口。",
              confidence: 0.8,
            },
          ],
        });
      },
    };
    const service = new CausalWhatIfSimulationService(
      fakeGraphStore(),
      fakeFactStore(saved),
      model,
      new CryptoUuidV7Generator(),
      new SystemClock(),
    );

    const receipt = await service.simulate({
      projectId: PROJECT_ID,
      sourceEventId: SOURCE_ID,
      hypothesis: "如果主角没有拿到钥匙？",
    });

    expect(receipt.deterministicImpactCount).toBe(1);
    expect(saved).toHaveLength(1);
    const savedFact = saved[0];
    if (savedFact === undefined) {
      throw new Error("The simulation did not persist its branch fact.");
    }
    const snapshot = savedFact.toSnapshot();
    expect(snapshot).toMatchObject({
      factType: "what_if_simulation",
      status: "branch",
      userConfirmed: false,
      branchId: receipt.branchId,
    });
    expect(readCausalWhatIfSimulationValue(savedFact).schema).toBe(CAUSAL_WHAT_IF_SCHEMA);
  });

  it("rejects model effects outside the deterministic causal scope", async () => {
    const service = new CausalWhatIfSimulationService(
      fakeGraphStore(),
      fakeFactStore([]),
      {
        simulate: () =>
          Promise.resolve({
            alternateDirection: "模型尝试引入不相关事件。",
            effects: [{ eventId: OUTSIDE_ID, summary: "越界影响", confidence: 0.5 }],
          }),
      },
      new CryptoUuidV7Generator(),
      new SystemClock(),
    );

    await expect(
      service.simulate({
        projectId: PROJECT_ID,
        sourceEventId: SOURCE_ID,
        hypothesis: "改变钥匙事件",
      }),
    ).rejects.toMatchObject({
      code: "CAUSAL_WHAT_IF_MODEL_INVALID",
    } satisfies Partial<CausalWhatIfSimulationError>);
  });
});
