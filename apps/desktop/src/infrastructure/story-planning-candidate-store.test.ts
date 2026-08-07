import { describe, expect, it } from "vitest";

import {
  BrowserDevelopmentStoryPlanningCandidateStore,
  type StoryPlanningCandidate,
} from "./story-planning-candidate-store";

const NOW = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-01T00:01:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const CANDIDATE_ID = "019f9f4a-b3c7-7350-9226-000000000002";

describe("story planning candidate store", () => {
  it("persists editable review content without changing the immutable model payload", async () => {
    const storage = new MemoryStorage();
    const first = new BrowserDevelopmentStoryPlanningCandidateStore(storage);
    await first.create(candidate());

    const updated = await first.updateEditableSynopsis({
      candidateId: CANDIDATE_ID,
      expectedRevision: 1,
      editableSynopsis: "作者修改后的可采纳方向",
      now: LATER,
    });
    expect(updated).toMatchObject({
      status: "review",
      revision: 2,
      editableSynopsis: "作者修改后的可采纳方向",
      payload: { direction: "模型原始建议" },
    });

    const reopened = new BrowserDevelopmentStoryPlanningCandidateStore(storage);
    expect(await reopened.listByProjectId(PROJECT_ID)).toEqual([updated]);
  });

  it("records one terminal decision and rejects stale repeat decisions", async () => {
    const store = new BrowserDevelopmentStoryPlanningCandidateStore(new MemoryStorage());
    await store.create(candidate());

    const rejected = await store.decide({
      candidateId: CANDIDATE_ID,
      expectedRevision: 1,
      decision: "rejected",
      acceptedOutlineRevision: null,
      now: LATER,
    });
    expect(rejected).toMatchObject({ status: "rejected", revision: 2, decidedAt: LATER });

    await expect(
      store.decide({
        candidateId: CANDIDATE_ID,
        expectedRevision: 1,
        decision: "accepted",
        acceptedOutlineRevision: 2,
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_CANDIDATE_CONFLICT" });
  });
});

function candidate(): StoryPlanningCandidate {
  return {
    id: CANDIDATE_ID,
    projectId: PROJECT_ID,
    task: "outline_planning",
    targetNodeId: "019f9f4a-b3c7-7350-9226-000000000003",
    targetNodeTitle: "规划候选测试",
    baselineOutlineRevision: 1,
    status: "review",
    payload: {
      schemaVersion: 1,
      task: "outline_planning",
      title: "第一卷方向",
      direction: "模型原始建议",
      beats: [{ title: "相遇", purpose: "建立冲突", outcome: "决定同行" }],
      constraintsApplied: ["不新增超自然设定"],
      openQuestions: [],
    },
    editableSynopsis: "模型原始建议",
    context: {
      formalFactIds: [],
      lockedFactIds: [],
      causalEventIds: [],
      causalGraphStatus: "empty",
    },
    invocationId: "invocation-1",
    connectionId: "connection-1",
    catalogEntryId: "catalog-1",
    providerKind: "openai",
    modelId: "gpt-test",
    usedFallback: false,
    acceptedOutlineRevision: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    decidedAt: null,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  public get length(): number {
    return this.values.size;
  }
  public clear(): void {
    this.values.clear();
  }
  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  public removeItem(key: string): void {
    this.values.delete(key);
  }
  public setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
