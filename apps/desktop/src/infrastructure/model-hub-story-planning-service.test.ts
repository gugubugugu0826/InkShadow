import { parseIsoUtcTimestamp, type UuidV7 as DomainUuidV7 } from "@inkshadow/domain";
import {
  CausalEventGraph,
  Outline,
  OutlineApplicationService,
  StoryCoreError,
  err,
  ok,
  type OutlineRepository,
  type StoryFactStore,
  type UuidV7 as StoryUuidV7,
} from "@inkshadow/story-core";
import { describe, expect, it, vi } from "vitest";

import { ModelHubStoryPlanningService } from "./model-hub-story-planning-service";
import type {
  ExecuteModelHubTextTaskInput,
  ModelHubTextExecutionDependencies,
} from "./model-hub-execution-service";
import type {
  ModelCapabilityEvidence,
  ModelHubStore,
  ModelInvocationFact,
} from "./model-hub-store";
import { BrowserDevelopmentStoryPlanningCandidateStore } from "./story-planning-candidate-store";

const NOW_TEXT = "2026-08-01T00:00:00.000Z";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const BOOK_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const VOLUME_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const CHAPTER_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const FORMAL_FACT_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const UNCONFIRMED_FACT_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const parsedNow = parseIsoUtcTimestamp(NOW_TEXT);
if (!parsedNow.ok) {
  throw parsedNow.error;
}
const NOW = parsedNow.value;

describe("Model Hub story planning service", () => {
  it("creates an outline review candidate from only authoritative context, then applies one explicit synopsis update", async () => {
    const harness = createHarness(outlineResponse());
    const before = harness.repository.current?.toSnapshot();

    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
      userDirection: "让误会在第一卷结尾解开。",
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    expect(harness.repository.current?.toSnapshot()).toEqual(before);
    expect(outcome.candidate).toMatchObject({
      task: "outline_planning",
      targetNodeId: BOOK_ID,
      status: "review",
      invocationId: "invocation-outline",
      providerKind: "openai",
      modelId: "planning-model",
      context: {
        formalFactIds: [FORMAL_FACT_ID],
        lockedFactIds: [FORMAL_FACT_ID],
        causalEventIds: ["event-confirmed"],
        causalGraphStatus: "available",
      },
    });
    const executedCall = harness.executeText.mock.calls[0];
    if (executedCall === undefined) {
      throw new Error("expected model execution");
    }
    const sent = JSON.stringify(executedCall[1].messages);
    expect(sent).toContain("用户确认：主角不会杀人");
    expect(sent).toContain("车站重逢");
    expect(sent).not.toContain("未确认：主角其实是王子");

    const accepted = await harness.service.acceptCandidate({
      candidateId: outcome.candidate.id,
      expectedRevision: outcome.candidate.revision,
    });
    expect(accepted.candidate.status).toBe("accepted");
    expect(
      harness.repository.current?.toSnapshot().nodes.find(({ id }) => id === BOOK_ID)?.synopsis,
    ).toContain("故事方向：两人从误会走向共同选择");
  });

  it("supports scene breakdown as a chapter-only candidate and never changes chapter prose", async () => {
    const harness = createHarness(sceneResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "scene_breakdown",
      targetNodeId: CHAPTER_ID,
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") {
      throw new Error("expected scene candidate");
    }
    expect(outcome.candidate).toMatchObject({
      task: "scene_breakdown",
      targetNodeId: CHAPTER_ID,
      status: "review",
    });
    expect(outcome.candidate.editableSynopsis).toContain("场景安排：");

    await harness.service.acceptCandidate({
      candidateId: outcome.candidate.id,
      expectedRevision: 1,
    });
    expect(
      harness.repository.current?.toSnapshot().nodes.find(({ id }) => id === CHAPTER_ID)?.synopsis,
    ).toContain("章节目标：让两人在暴雨中暂时合作");
  });

  it("appends only selected immutable rows while preserving the exact baseline synopsis", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }

    const receipt = await harness.service.acceptCandidateItems({
      candidateId: outcome.candidate.id,
      expectedRevision: outcome.candidate.revision,
      selectedItemIds: ["question:0", "beat:0"],
    });

    const synopsis = harness.repository.current
      ?.toSnapshot()
      .nodes.find(({ id }) => id === BOOK_ID)?.synopsis;
    expect(synopsis).toBe(
      "原始故事方向\n\n已采纳的 AI 规划条目：\n1. 暂时同行\n目标：建立合作\n结果：发现共同目标\n\n待作者决定：幕后人是谁",
    );
    expect(synopsis).not.toContain("误会揭开");
    expect(synopsis).not.toContain("两人从误会走向共同选择");
    expect(receipt.acceptedItemIds).toEqual(["beat:0", "question:0"]);
    expect(receipt.candidate.acceptedItemIds).toEqual(["beat:0", "question:0"]);
    expect(receipt.outlineRevision).toBe(outcome.candidate.baselineOutlineRevision + 1);
  });

  it("rejects an empty selection without changing the outline or candidate", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const before = harness.repository.current?.toSnapshot();

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: 1,
        selectedItemIds: [],
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_SELECTION_EMPTY" });
    expect(harness.repository.current?.toSnapshot()).toEqual(before);
    expect(await harness.candidates.findById(outcome.candidate.id)).toMatchObject({
      status: "review",
      revision: 1,
    });
  });

  it("makes a repeated identical selective acceptance idempotent", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const input = {
      candidateId: outcome.candidate.id,
      expectedRevision: outcome.candidate.revision,
      selectedItemIds: ["beat:0"],
    } as const;
    const first = await harness.service.acceptCandidateItems(input);
    const afterFirst = harness.repository.current?.toSnapshot();
    const second = await harness.service.acceptCandidateItems(input);

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.outlineRevision).toBe(first.outlineRevision);
    expect(harness.repository.current?.toSnapshot()).toEqual(afterFirst);
    expect(
      harness.repository.current?.toSnapshot().nodes.find(({ id }) => id === BOOK_ID)?.synopsis,
    ).toMatch(/已采纳的 AI 规划条目：/gu);
  });

  it("reserves selective acceptance before concurrent reject or edit can win", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const intentStored = deferred<undefined>();
    const continueAcceptance = deferred<undefined>();
    const originalBegin = harness.candidates.beginSelectiveAcceptance.bind(harness.candidates);
    vi.spyOn(harness.candidates, "beginSelectiveAcceptance").mockImplementationOnce(
      async (input) => {
        const applying = await originalBegin(input);
        intentStored.resolve(undefined);
        await continueAcceptance.promise;
        return applying;
      },
    );

    const accepting = harness.service.acceptCandidateItems({
      candidateId: outcome.candidate.id,
      expectedRevision: 1,
      selectedItemIds: ["beat:0"],
    });
    await intentStored.promise;
    await expect(
      harness.service.rejectCandidate({
        candidateId: outcome.candidate.id,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_CANDIDATE_CONFLICT" });
    await expect(
      harness.service.updateCandidate({
        candidateId: outcome.candidate.id,
        expectedRevision: 2,
        editableSynopsis: "不应覆盖正在采纳的建议",
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_CANDIDATE_CONFLICT" });
    continueAcceptance.resolve(undefined);

    await expect(accepting).resolves.toMatchObject({
      idempotent: false,
      candidate: { status: "accepted", acceptedItemIds: ["beat:0"] },
    });
  });

  it("makes two concurrent identical selective accepts converge on one outline write", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const input = {
      candidateId: outcome.candidate.id,
      expectedRevision: 1,
      selectedItemIds: ["beat:0"],
    } as const;

    const receipts = await Promise.all([
      harness.service.acceptCandidateItems(input),
      harness.service.acceptCandidateItems(input),
    ]);

    expect(receipts.filter(({ idempotent }) => !idempotent)).toHaveLength(1);
    expect(receipts.filter(({ idempotent }) => idempotent)).toHaveLength(1);
    expect(harness.repository.current?.revision).toBe(
      outcome.candidate.baselineOutlineRevision + 1,
    );
  });

  it("does not touch the outline when persisting the applying intent fails", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const before = harness.repository.current?.toSnapshot();
    vi.spyOn(harness.candidates, "beginSelectiveAcceptance").mockRejectedValueOnce(
      new Error("intent write interrupted"),
    );

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: 1,
        selectedItemIds: ["beat:0"],
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_TARGET_CHANGED" });
    expect(harness.repository.current?.toSnapshot()).toEqual(before);
    expect(await harness.candidates.findById(outcome.candidate.id)).toMatchObject({
      status: "review",
      revision: 1,
      selectiveAcceptanceIntent: null,
    });
  });

  it("keeps an applying intent after a definite pre-commit outline failure and can retry", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    vi.spyOn(harness.outlineService, "apply").mockResolvedValueOnce(
      err(new StoryCoreError({ code: "STORY_REPOSITORY_ERROR", message: "write failed" })),
    );

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: 1,
        selectedItemIds: ["beat:0"],
      }),
    ).rejects.toMatchObject({ code: "STORY_REPOSITORY_ERROR" });
    expect(await harness.candidates.findById(outcome.candidate.id)).toMatchObject({
      status: "review",
      revision: 2,
      selectiveAcceptanceIntent: { selectedItemIds: ["beat:0"] },
    });

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: 1,
        selectedItemIds: ["beat:0"],
      }),
    ).resolves.toMatchObject({ candidate: { status: "accepted" } });
  });

  it("keeps reject and edit locked between one failed apply and an identical concurrent commit", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const firstApplyEntered = deferred<undefined>();
    const releaseFirstFailure = deferred<undefined>();
    const secondApplyEntered = deferred<undefined>();
    const releaseSecondCommit = deferred<undefined>();
    const originalApply = harness.outlineService.apply.bind(harness.outlineService);
    let applyAttempt = 0;
    vi.spyOn(harness.outlineService, "apply").mockImplementation(async (input) => {
      applyAttempt += 1;
      if (applyAttempt === 1) {
        firstApplyEntered.resolve(undefined);
        await releaseFirstFailure.promise;
        return err(
          new StoryCoreError({ code: "STORY_REPOSITORY_ERROR", message: "first write failed" }),
        );
      }
      secondApplyEntered.resolve(undefined);
      await releaseSecondCommit.promise;
      return originalApply(input);
    });
    const acceptanceInput = {
      candidateId: outcome.candidate.id,
      expectedRevision: 1,
      selectedItemIds: ["beat:0"],
    } as const;

    const firstAcceptance = harness.service.acceptCandidateItems(acceptanceInput);
    await firstApplyEntered.promise;
    const secondAcceptance = harness.service.acceptCandidateItems(acceptanceInput);
    await secondApplyEntered.promise;
    releaseFirstFailure.resolve(undefined);
    await expect(firstAcceptance).rejects.toMatchObject({ code: "STORY_REPOSITORY_ERROR" });

    await expect(
      harness.service.rejectCandidate({
        candidateId: outcome.candidate.id,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_CANDIDATE_CONFLICT" });
    await expect(
      harness.service.updateCandidate({
        candidateId: outcome.candidate.id,
        expectedRevision: 2,
        editableSynopsis: "不能插入并发采纳之间",
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_CANDIDATE_CONFLICT" });
    expect(await harness.candidates.findById(outcome.candidate.id)).toMatchObject({
      status: "review",
      revision: 2,
      selectiveAcceptanceIntent: { selectedItemIds: ["beat:0"] },
    });

    releaseSecondCommit.resolve(undefined);
    await expect(secondAcceptance).resolves.toMatchObject({
      candidate: { status: "accepted", acceptedItemIds: ["beat:0"] },
    });
    expect(harness.repository.current?.revision).toBe(
      outcome.candidate.baselineOutlineRevision + 1,
    );
  });

  it("recovers when the outline commit succeeds but its result is reported as failed", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const originalApply = harness.outlineService.apply.bind(harness.outlineService);
    vi.spyOn(harness.outlineService, "apply").mockImplementationOnce(async (input) => {
      const committed = await originalApply(input);
      if (!committed.ok) {
        return committed;
      }
      return err(new StoryCoreError({ code: "STORY_REPOSITORY_ERROR", message: "lost receipt" }));
    });

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: 1,
        selectedItemIds: ["beat:0"],
      }),
    ).resolves.toMatchObject({
      recoveredAfterInterruptedRecording: true,
      candidate: { status: "accepted" },
    });
  });

  it("keeps the applying intent after finalize interruption and completes it on retry", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    vi.spyOn(harness.candidates, "finalizeSelectiveAcceptance").mockRejectedValueOnce(
      new Error("final receipt interrupted"),
    );

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: 1,
        selectedItemIds: ["beat:0"],
      }),
    ).rejects.toMatchObject({
      code: "STORY_PLANNING_ACCEPTANCE_RECORD_FAILED",
      outlineAlreadyUpdated: true,
    });
    expect(await harness.candidates.findById(outcome.candidate.id)).toMatchObject({
      status: "review",
      revision: 2,
      selectiveAcceptanceIntent: { selectedItemIds: ["beat:0"] },
    });

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: 1,
        selectedItemIds: ["beat:0"],
      }),
    ).resolves.toMatchObject({
      recoveredAfterInterruptedRecording: true,
      candidate: { status: "accepted" },
    });
  });

  it("recognizes a finalize that committed before its caller observed an error", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const originalFinalize = harness.candidates.finalizeSelectiveAcceptance.bind(
      harness.candidates,
    );
    vi.spyOn(harness.candidates, "finalizeSelectiveAcceptance").mockImplementationOnce(
      async (input) => {
        await originalFinalize(input);
        throw new Error("lost final receipt");
      },
    );

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: 1,
        selectedItemIds: ["beat:0"],
      }),
    ).resolves.toMatchObject({
      idempotent: true,
      candidate: { status: "accepted", acceptedItemIds: ["beat:0"] },
    });
  });

  it("reports a skipped result before dispatch when structured output is not verified", async () => {
    const harness = createHarness(outlineResponse(), { structuredOutput: false });
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      code: "MODEL_HUB_STRUCTURED_OUTPUT_NOT_VERIFIED",
    });
    expect(harness.executeText).not.toHaveBeenCalled();
    expect(await harness.candidates.listByProjectId(PROJECT_ID)).toEqual([]);
  });

  it("stops before provider dispatch when structured output evidence is revoked at the final latch", async () => {
    const harness = createHarness(outlineResponse(), {
      structuredOutputRevokedBeforeFinal: true,
    });
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      code: "MODEL_HUB_STRUCTURED_OUTPUT_NOT_VERIFIED",
    });
    expect(harness.listCapabilityEvidence).toHaveBeenCalledTimes(3);
    expect(await harness.candidates.listByProjectId(PROJECT_ID)).toEqual([]);
  });

  it("rejects non-JSON model output and leaves the authoritative outline untouched", async () => {
    const harness = createHarness("```json\n{}\n```");
    const before = harness.repository.current?.toSnapshot();

    await expect(
      harness.service.generate({ projectId: PROJECT_ID, task: "outline_planning" }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_RESPONSE_INVALID" });
    expect(harness.repository.current?.toSnapshot()).toEqual(before);
    expect(await harness.candidates.listByProjectId(PROJECT_ID)).toEqual([]);
  });

  it("blocks acceptance after any unrelated outline revision instead of overwriting newer work", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const changed = await harness.outlineService.apply({
      projectId: PROJECT_ID,
      expectedRevision: outcome.candidate.baselineOutlineRevision,
      change: { kind: "rename", nodeId: VOLUME_ID, title: "作者的新卷名" },
    });
    if (!changed.ok) {
      throw changed.error;
    }

    await expect(
      harness.service.acceptCandidate({
        candidateId: outcome.candidate.id,
        expectedRevision: outcome.candidate.revision,
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_TARGET_CHANGED" });
    expect(
      harness.repository.current?.toSnapshot().nodes.find(({ id }) => id === BOOK_ID)?.synopsis,
    ).toBe("原始故事方向");
  });

  it("blocks selective acceptance after an unrelated outline revision", async () => {
    const harness = createHarness(outlineResponse());
    const outcome = await harness.service.generate({
      projectId: PROJECT_ID,
      task: "outline_planning",
    });
    if (outcome.status !== "completed") {
      throw new Error("expected planning candidate");
    }
    const changed = await harness.outlineService.apply({
      projectId: PROJECT_ID,
      expectedRevision: outcome.candidate.baselineOutlineRevision,
      change: { kind: "rename", nodeId: VOLUME_ID, title: "作者的新卷名" },
    });
    if (!changed.ok) {
      throw changed.error;
    }

    await expect(
      harness.service.acceptCandidateItems({
        candidateId: outcome.candidate.id,
        expectedRevision: outcome.candidate.revision,
        selectedItemIds: ["beat:0"],
      }),
    ).rejects.toMatchObject({ code: "STORY_PLANNING_TARGET_CHANGED" });
    expect(
      harness.repository.current?.toSnapshot().nodes.find(({ id }) => id === BOOK_ID)?.synopsis,
    ).toBe("原始故事方向");
  });
});

function createHarness(
  responseText: string,
  options: Readonly<{
    structuredOutput?: boolean;
    structuredOutputRevokedBeforeFinal?: boolean;
  }> = {},
) {
  const responseTask = responseText.includes('"scene_breakdown"')
    ? ("scene_breakdown" as const)
    : ("outline_planning" as const);
  const repository = new MemoryOutlineRepository(createOutline());
  const ids = new SequenceIds(100);
  const clock = { now: () => NOW };
  const outlineService = new OutlineApplicationService({ outlines: repository, ids, clock });
  const candidates = new BrowserDevelopmentStoryPlanningCandidateStore(new MemoryStorage());
  const executeText = vi.fn(
    async (
      _dependencies: ModelHubTextExecutionDependencies,
      _input: ExecuteModelHubTextTaskInput,
    ) => {
      void _dependencies;
      const selected = inspection();
      const selection = {
        generationId: "generation-planning",
        invocationId: "invocation-outline",
        connectionId: selected.connectionId,
        catalogEntryId: selected.catalogEntryId,
        modelId: selected.modelId,
        usedFallback: selected.usedFallback,
        localOnlyEligible: false,
      } as const;
      await _input.onBeforeDispatch?.(selection);
      await _input.onFinalBeforeProviderDispatch?.(selection);
      return {
        text: responseText,
        usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: null },
        invocation: invocation(responseTask),
        connectionId: "connection-planning",
        catalogEntryId: "catalog-planning",
        providerKind: "openai" as const,
        modelId: "planning-model",
        usedFallback: false,
        costCeilingExceededAfterDispatch: false,
      };
    },
  );
  const capabilityEvidence = options.structuredOutput === false ? [] : [structuredEvidence()];
  let evidenceReadCount = 0;
  const listCapabilityEvidence = vi.fn(() => {
    evidenceReadCount += 1;
    return Promise.resolve(
      options.structuredOutputRevokedBeforeFinal === true && evidenceReadCount >= 3
        ? []
        : capabilityEvidence,
    );
  });
  const modelHub = {
    listCapabilityEvidence,
  } as unknown as ModelHubStore;
  const service = new ModelHubStoryPlanningService({
    modelHub,
    modelGateway: { available: true, generate: vi.fn() },
    credentials: { getSummary: vi.fn(() => Promise.resolve({ configured: true })) },
    ids,
    clock,
    facts: factsStore(),
    causalGraph: {
      loadProjectBranch: vi.fn(() => Promise.resolve(verifiedGraph())),
    },
    outlines: repository,
    outlineService,
    candidates,
    inspectText: vi.fn(() => Promise.resolve(inspection())),
    executeText,
    projectContextPrivacy: standardProjectPrivacyAuthority(),
  });
  return {
    service,
    repository,
    outlineService,
    candidates,
    executeText,
    listCapabilityEvidence,
  };
}

function standardProjectPrivacyAuthority() {
  return {
    inspect: vi.fn((projectId: string) =>
      Promise.resolve({
        schemaVersion: 1 as const,
        projectId,
        fingerprint: `privacy:${projectId}`,
        activeChapterCount: 0,
        retainedChapterCount: 0,
        requiresVerifiedLocal: false,
        chapters: [] as const,
      }),
    ),
    assertCurrentBeforeDispatch: vi.fn(() => Promise.resolve()),
    assertRouteEligible: vi.fn(),
  };
}

function createOutline(): Outline {
  const created = Outline.create({
    projectId: PROJECT_ID,
    bookId: BOOK_ID,
    title: "雨夜车站",
    synopsis: "原始故事方向",
    now: NOW_TEXT,
  });
  if (!created.ok) {
    throw created.error;
  }
  const withVolume = created.value.addNode({
    id: VOLUME_ID,
    kind: "volume",
    parentId: BOOK_ID,
    title: "第一卷",
    expectedRevision: 1,
    now: NOW_TEXT,
  });
  if (!withVolume.ok) {
    throw withVolume.error;
  }
  const withChapter = withVolume.value.addNode({
    id: CHAPTER_ID,
    kind: "chapter",
    parentId: VOLUME_ID,
    title: "暴雨重逢",
    synopsis: "原始章节计划",
    expectedRevision: 2,
    now: NOW_TEXT,
  });
  if (!withChapter.ok) {
    throw withChapter.error;
  }
  return withChapter.value;
}

class MemoryOutlineRepository implements OutlineRepository {
  public constructor(public current: Outline | null) {}

  public create(outline: Outline) {
    if (this.current !== null) {
      return Promise.resolve(
        err(new StoryCoreError({ code: "STORY_REPOSITORY_ERROR", message: "already exists" })),
      );
    }
    this.current = outline;
    return Promise.resolve(ok(undefined));
  }

  public findByProjectId() {
    return Promise.resolve(ok(this.current));
  }

  public save(outline: Outline, expectedRevision: number) {
    if (this.current?.revision !== expectedRevision) {
      return Promise.resolve(
        err(new StoryCoreError({ code: "STORY_REVISION_CONFLICT", message: "stale" })),
      );
    }
    this.current = outline;
    return Promise.resolve(ok(undefined));
  }
}

function factsStore(): StoryFactStore {
  const formalSnapshot = {
    id: FORMAL_FACT_ID,
    projectId: PROJECT_ID,
    factType: "story.rule",
    contentText: "用户确认：主角不会杀人",
    structuredValue: null,
    source: {
      kind: "user_statement",
      reference: "user:rule",
      chapterId: null,
      versionId: null,
      startOffset: null,
      endOffset: null,
      sourceLength: null,
      excerpt: null,
    },
    effectiveAt: null,
    invalidatedAt: null,
    branchId: null,
    confidence: 1,
    status: "formal",
    origin: "user",
    userConfirmed: true,
    locked: true,
    deprecated: false,
    needsReview: false,
    confirmedByActorId: FORMAL_FACT_ID,
    confirmedAt: NOW_TEXT,
    revision: 1,
    createdAt: NOW_TEXT,
    updatedAt: NOW_TEXT,
  } as const;
  const unconfirmedSnapshot = {
    ...formalSnapshot,
    id: UNCONFIRMED_FACT_ID,
    contentText: "未确认：主角其实是王子",
    status: "unconfirmed",
    origin: "ai_extraction",
    userConfirmed: false,
    locked: false,
    needsReview: true,
    confirmedByActorId: null,
    confirmedAt: null,
  } as const;
  return {
    listByProjectId: vi.fn(() =>
      Promise.resolve(
        ok([
          { toSnapshot: () => formalSnapshot },
          { toSnapshot: () => unconfirmedSnapshot },
        ] as never),
      ),
    ),
  } as unknown as StoryFactStore;
}

function verifiedGraph(): CausalEventGraph {
  const excerpt = "两人在车站重逢";
  return CausalEventGraph.create({
    events: [
      {
        id: "event-confirmed",
        projectId: PROJECT_ID,
        branchId: "main",
        status: "confirmed",
        participantCharacterIds: ["hero", "heroine"],
        narrativeTime: { order: 1, label: "第一章雨夜" },
        location: { locationId: "station", label: "旧车站" },
        prerequisites: [],
        eventText: "车站重逢",
        resultText: "两人决定暂时同行",
        characterStateChanges: [],
        relationshipChanges: [],
        itemChanges: [],
        informedCharacterIds: ["hero", "heroine"],
        foreshadowProgress: [],
        downstreamEventIds: [],
        evidence: {
          id: "evidence-event",
          chapterId: CHAPTER_ID,
          chapterVersionId: "019f9f4a-b3c7-7350-9226-000000000007",
          contentHash: "a".repeat(64),
          locator: "paragraph:1",
          excerpt,
          startOffset: 0,
          endOffset: excerpt.length,
          sourceLength: excerpt.length,
        },
      },
    ],
    relations: [],
  });
}

function inspection() {
  return {
    task: "outline_planning" as const,
    configuredPrimaryCatalogEntryId: "catalog-planning",
    configuredFallbackCatalogEntryId: null,
    selectionKind: "task_primary" as const,
    usedFallback: false,
    attempt: 1 as const,
    connectionId: "connection-planning",
    catalogEntryId: "catalog-planning",
    providerKind: "openai" as const,
    modelId: "planning-model",
    dataDestination: "remote" as const,
    privacyPolicy: "cloud_allowed" as const,
    failurePolicy: "stop" as const,
    maximumOutputTokens: 3_000,
    temperature: 0.65,
    estimatedInputTokens: 1_000,
    estimatedTotalTokens: 4_000,
    inputTokenLimit: 128_000,
    outputTokenLimit: 8_000,
    tokenLimitEvidence: {
      source: "catalog" as const,
      version: "test-catalog-v1",
      updatedAt: NOW_TEXT,
      sourceUrl: null,
      verifiedByInkShadow: true,
    },
    pricing: {
      currency: null,
      inputMicrosPerMillionTokens: null,
      outputMicrosPerMillionTokens: null,
      cachedInputMicrosPerMillionTokens: null,
      pricingVersion: null,
      priceUpdatedAt: null,
      evidenceSource: "user_confirmed" as const,
      evidenceVersion: "v1",
      evidenceUpdatedAt: NOW_TEXT,
      estimatedMaximumCostMicros: null,
      maximumCostMicros: null,
      maximumCostCurrency: null,
    },
  };
}

function structuredEvidence(): ModelCapabilityEvidence {
  return {
    id: "structured-evidence",
    catalogEntryId: "catalog-planning",
    scanId: null,
    capability: "structured_output",
    verdict: "supported",
    evidenceSource: "user_confirmed",
    evidenceVersion: "v1",
    evidenceSummary: "user verified",
    observedAt: NOW_TEXT,
    expiresAt: null,
  };
}

function invocation(
  task: "outline_planning" | "scene_breakdown" = "outline_planning",
): ModelInvocationFact {
  return {
    id: "invocation-outline",
    task,
    routeTask: task,
    connectionId: "connection-planning",
    catalogEntryId: "catalog-planning",
    providerKindSnapshot: "openai",
    modelIdSnapshot: "planning-model",
    routeReason: "task_primary",
    status: "succeeded",
    attempt: 1,
    fallbackFromInvocationId: null,
    privacyPolicy: "cloud_allowed",
    dataDestination: "remote",
    maximumCostMicros: null,
    currency: null,
    inputTokens: 100,
    outputTokens: 200,
    cachedInputTokens: null,
    estimatedCostMicros: null,
    errorCode: null,
    errorSummary: null,
    providerDispatchStartedAt: NOW_TEXT,
    startedAt: NOW_TEXT,
    completedAt: NOW_TEXT,
    createdAt: NOW_TEXT,
    revision: 3,
  };
}

function outlineResponse(): string {
  return JSON.stringify({
    schemaVersion: 1,
    task: "outline_planning",
    title: "雨夜之后",
    direction: "两人从误会走向共同选择",
    beats: [
      { title: "暂时同行", purpose: "建立合作", outcome: "发现共同目标" },
      { title: "误会揭开", purpose: "回收关系冲突", outcome: "决定继续同行" },
    ],
    constraintsApplied: ["主角不会杀人"],
    openQuestions: ["幕后人是谁"],
  });
}

function sceneResponse(): string {
  return JSON.stringify({
    schemaVersion: 1,
    task: "scene_breakdown",
    chapterTitle: "暴雨重逢",
    chapterGoal: "让两人在暴雨中暂时合作",
    scenes: [
      {
        title: "站台争执",
        goal: "交代重逢",
        conflict: "双方都不信任对方",
        outcome: "被迫共同避险",
      },
    ],
    continuityChecks: ["不要违反主角不会杀人的规则"],
  });
}

class SequenceIds {
  public constructor(private nextValue: number) {}
  public next(): DomainUuidV7 & StoryUuidV7 {
    const value = `019f9f4a-b3c7-7350-9226-${this.nextValue.toString(16).padStart(12, "0")}`;
    this.nextValue += 1;
    return value as DomainUuidV7 & StoryUuidV7;
  }
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
