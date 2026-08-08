import { CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";
import { StoryFact, ok as storyOk, type StoryFactStore } from "@inkshadow/story-core";
import { describe, expect, it, vi } from "vitest";

import type { CausalEventGraphStore } from "./causal-event-graph-store";
import {
  CAUSAL_WHAT_IF_SCHEMA,
  CausalWhatIfSimulationError,
  CausalWhatIfSimulationService,
  readCausalWhatIfSimulationValue,
  type CausalWhatIfModelPort,
} from "./causal-what-if-simulation-service";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const SOURCE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const IMPACT_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OUTSIDE_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const ACTOR_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const LOCKED_RULE_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const SECOND_LOCKED_RULE_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const NOW = "2026-08-01T00:00:00.000Z";
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

function fakeGraphStore(state: { readonly changed?: () => boolean } = {}): CausalEventGraphStore {
  const currentEvents = () => [
    event(SOURCE_ID, state.changed?.() === true ? "主角把钥匙交给守门人" : "主角拿到钥匙"),
    event(IMPACT_ID, "主角打开密室"),
  ];
  return {
    replace: () => Promise.reject(new Error("not used")),
    append: () => Promise.reject(new Error("not used")),
    loadProjectBranch: () => {
      const events = currentEvents();
      const sourceEvent = events[0];
      if (sourceEvent === undefined) {
        throw new Error("The causal test fixture is missing its source event.");
      }
      return Promise.resolve({
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
      } as never);
    },
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
    const saved: StoryFact[] = [lockedRule(LOCKED_RULE_ID, "密室只能由钥匙或守门人开启。")];
    const model: CausalWhatIfModelPort = {
      simulate: (input) => {
        expect(input.sourceEvent.id).toBe(SOURCE_ID);
        expect(input.impactedEvents.map(({ id }) => id)).toEqual([IMPACT_ID]);
        expect(input.lockedRules).toEqual([
          { id: LOCKED_RULE_ID, content: "密室只能由钥匙或守门人开启。" },
        ]);
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
    expect(saved).toHaveLength(2);
    const savedFact = saved[1];
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
    const value = readCausalWhatIfSimulationValue(savedFact);
    expect(value).toMatchObject({
      schema: CAUSAL_WHAT_IF_SCHEMA,
      lockedRuleCompilation: {
        candidateCount: 1,
        included: [{ id: LOCKED_RULE_ID, revision: 1 }],
        omitted: [],
      },
    });
    expect(value.authorityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(value.lockedRuleCompilation?.included[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
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

  it("blocks the model and records omission reasons when every locked rule cannot fit", async () => {
    const oversizedRule = lockedRule(LOCKED_RULE_ID, "不可违背的世界规则。".repeat(700));
    const simulate = vi.fn<CausalWhatIfModelPort["simulate"]>();
    const service = new CausalWhatIfSimulationService(
      fakeGraphStore(),
      fakeFactStore([oversizedRule]),
      { simulate },
      new CryptoUuidV7Generator(),
      new SystemClock(),
    );

    const error = await service
      .simulate({
        projectId: PROJECT_ID,
        sourceEventId: SOURCE_ID,
        hypothesis: "改变钥匙事件",
      })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(error).toBeInstanceOf(CausalWhatIfSimulationError);
    if (!(error instanceof CausalWhatIfSimulationError)) {
      throw new Error("The oversized locked-rule fixture did not return the governed error.");
    }
    expect(error).toMatchObject({
      code: "CAUSAL_WHAT_IF_LOCKED_RULE_BUDGET_EXCEEDED",
      retryable: false,
    });
    expect(error.lockedRuleCompilation).toMatchObject({
      tokenBudget: 8_000,
      maximumRuleCount: 100,
      candidateCount: 1,
      estimatedIncludedTokens: 0,
      included: [],
      omitted: [{ id: LOCKED_RULE_ID, revision: 1, reason: "token_budget_exceeded" }],
    });
    expect(error.lockedRuleCompilation?.omitted[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(error.lockedRuleCompilation?.omitted[0]?.estimatedTokens).toBeGreaterThan(8_000);
    expect(simulate).not.toHaveBeenCalled();
  });

  it("discards the model result when a locked rule changes while the model is running", async () => {
    const saved: StoryFact[] = [lockedRule(LOCKED_RULE_ID, "密室只能由钥匙开启。")];
    const service = new CausalWhatIfSimulationService(
      fakeGraphStore(),
      fakeFactStore(saved),
      {
        simulate: () => {
          saved.push(lockedRule(SECOND_LOCKED_RULE_ID, "守门人不得离开旧屋。"));
          return Promise.resolve(validModelOutput());
        },
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
      code: "CAUSAL_WHAT_IF_AUTHORITY_CHANGED",
      retryable: true,
    } satisfies Partial<CausalWhatIfSimulationError>);
    expect(
      saved.filter((fact) => fact.toSnapshot().factType === "what_if_simulation"),
    ).toHaveLength(0);
  });

  it("discards the model result when the causal graph changes while the model is running", async () => {
    let changed = false;
    const saved: StoryFact[] = [];
    const service = new CausalWhatIfSimulationService(
      fakeGraphStore({ changed: () => changed }),
      fakeFactStore(saved),
      {
        simulate: () => {
          changed = true;
          return Promise.resolve(validModelOutput());
        },
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
      code: "CAUSAL_WHAT_IF_AUTHORITY_CHANGED",
      retryable: true,
    } satisfies Partial<CausalWhatIfSimulationError>);
    expect(saved).toHaveLength(0);
  });
});

function validModelOutput() {
  return {
    alternateDirection: "主角没有拿到钥匙，需要另寻进入密室的方法。",
    effects: [{ eventId: IMPACT_ID, summary: "密室事件被推迟。", confidence: 0.8 }],
  };
}

function lockedRule(id: string, content: string): StoryFact {
  const result = StoryFact.create({
    id,
    projectId: PROJECT_ID,
    factType: "world_rule",
    contentText: content,
    source: { kind: "user_statement", reference: `test:${id}` },
    confidence: 1,
    status: "formal",
    origin: "user",
    needsReview: false,
    locked: true,
    humanConfirmed: true,
    confirmationActorId: ACTOR_ID,
    now: NOW,
  });
  if (!result.ok) throw result.error;
  return result.value;
}
