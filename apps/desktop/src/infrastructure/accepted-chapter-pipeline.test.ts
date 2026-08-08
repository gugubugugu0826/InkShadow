import { describe, expect, it, vi } from "vitest";

import { BrowserDevelopmentTaskCenterStore } from "./task-center-store";
import {
  ensureAcceptedChapterPipelineTask,
  inspectPipelineOutcomeProgressStep,
  inspectPipelineRetryProgressStep,
  inspectPipelineStageFailureCauseCode,
  pipelineOutcomeProgressStep,
  pipelineRetryProgressStep,
  pipelineStageFailureCauseCode,
  runAcceptedChapterPipeline,
  type AcceptedChapterPipelineRuntime,
} from "./accepted-chapter-pipeline";

const NOW = "2026-08-08T00:00:00.000Z";
const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);

describe("runAcceptedChapterPipeline", () => {
  it("fails closed before enqueueing a task with no enabled stages", async () => {
    const harness = createHarness();
    const input = {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "historical_backfill" as const,
      acceptedCharacterCount: 20,
      runSearch: false,
      runChapterSummary: false,
      runStoryState: false,
      runCausalProjection: false,
    };

    await expect(ensureAcceptedChapterPipelineTask(harness.runtime, input)).rejects.toThrow(
      /at least one stage/u,
    );
    await expect(runAcceptedChapterPipeline(harness.runtime, input)).rejects.toThrow(
      /at least one stage/u,
    );
    expect((await harness.store.load()).tasks).toHaveLength(0);
  });

  it("persists canonical completed, not-applicable, and deferred stage dispositions", () => {
    const step = pipelineOutcomeProgressStep(
      ["search", "causal_projection"],
      ["chapter_summary"],
      ["story_state"],
    );
    expect(step).toBe("pipeline.outcome.v2.search-c.summary-n.state-d.causal-c");
    const inspected = inspectPipelineOutcomeProgressStep(step);
    expect(inspected.kind).toBe("valid");
    if (inspected.kind !== "valid") throw new Error("Expected a valid outcome.");
    expect([...inspected.stages]).toEqual(["search", "causal_projection"]);
    expect([...inspected.notApplicableStages]).toEqual(["chapter_summary"]);
    expect([...inspected.deferredStages]).toEqual(["story_state"]);
    expect(inspectPipelineOutcomeProgressStep("pipeline.outcome.v2.summary-n.search-c")).toEqual({
      kind: "malformed",
    });
    expect(inspectPipelineOutcomeProgressStep("pipeline.outcome.v2.search-c.search-n")).toEqual({
      kind: "malformed",
    });
    expect(inspectPipelineOutcomeProgressStep("pipeline.outcome.v2.search-c.unknown-d")).toEqual({
      kind: "malformed",
    });
    expect(inspectPipelineOutcomeProgressStep("pipeline.outcome.v2.search-c")).toEqual({
      kind: "malformed",
    });
    expect(() => pipelineOutcomeProgressStep(["search"], ["search"])).toThrow(/disjoint/u);

    const retryCause = pipelineStageFailureCauseCode(
      ["causal_projection"],
      ["story_state"],
      ["chapter_summary"],
    );
    const retryStep = pipelineRetryProgressStep(2, retryCause);
    expect(retryStep).toBe("pipeline.retry.v2.a2.f-c.n-t.d-s");
    expect(inspectPipelineRetryProgressStep(retryStep)).toEqual({
      kind: "valid",
      attempt: 2,
      failureCauseCode: retryCause,
    });
    expect(pipelineRetryProgressStep(3, "PIPELINE_STAGES_SEARCH_STATE")).toBe(
      "pipeline.retry.v2.a3.l-rt",
    );
    expect(pipelineRetryProgressStep(1, null)).toBe("pipeline.retry.v2.a1.full");
    expect(inspectPipelineRetryProgressStep("pipeline.retry.v2.a02.l-r")).toEqual({
      kind: "malformed",
    });
    expect(inspectPipelineRetryProgressStep("pipeline.retry.v2.a2.f-c.d-s.n-t")).toEqual({
      kind: "malformed",
    });
  });

  it("accepts only canonical failure-stage masks", () => {
    expect(
      inspectPipelineStageFailureCauseCode("PIPELINE_STAGES_SEARCH_SUMMARY_STATE"),
    ).toMatchObject({ kind: "valid" });
    expect(inspectPipelineStageFailureCauseCode("PIPELINE_STAGES_UNKNOWN")).toEqual({
      kind: "malformed",
    });
    expect(inspectPipelineStageFailureCauseCode("PIPELINE_STAGES")).toEqual({
      kind: "malformed",
    });
    expect(inspectPipelineStageFailureCauseCode("PIPELINE_STAGES_SEARCH_SEARCH")).toEqual({
      kind: "malformed",
    });
    expect(inspectPipelineStageFailureCauseCode("PIPELINE_STAGES_STATE_SUMMARY")).toEqual({
      kind: "malformed",
    });
    const dispositionMask = pipelineStageFailureCauseCode(
      ["story_state"],
      ["chapter_summary"],
      ["causal_projection"],
    );
    expect(dispositionMask).toBe("PIPELINE_V2_F_T_N_S_D_C");
    const inspected = inspectPipelineStageFailureCauseCode(dispositionMask);
    expect(inspected.kind).toBe("valid");
    if (inspected.kind !== "valid") throw new Error("Expected v2 failure evidence.");
    expect([...inspected.stages]).toEqual(["story_state"]);
    expect([...inspected.notApplicableStages]).toEqual(["chapter_summary"]);
    expect([...inspected.deferredStages]).toEqual(["causal_projection"]);
    expect(inspectPipelineStageFailureCauseCode("PIPELINE_V2_F_TR_N_S")).toMatchObject({
      kind: "malformed",
    });
  });
  it("rebuilds every derived source and records a durable successful task", async () => {
    const harness = createHarness();

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "candidate_accept",
      acceptedCharacterCount: 1_234,
    });

    expect(receipt).toMatchObject({
      status: "completed",
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      search: { status: "completed" },
      chapterSummary: { status: "completed" },
      storyState: { status: "completed" },
      causalProjection: { status: "completed" },
      chapterSummaryStatus: "generated",
      storyStateMetrics: {
        detectedCount: 3,
        needsConfirmationCount: 1,
        reversibleCount: 2,
        skippedTaskCount: 0,
      },
    });
    expect(harness.search).toHaveBeenCalledWith(PROJECT_ID);
    expect(harness.summary).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      trigger: "user_rebuild",
    });
    expect(harness.storyState).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
    });
    expect(harness.causal).toHaveBeenCalledWith(PROJECT_ID, "main");

    const taskCenter = await harness.store.load();
    expect(taskCenter.tasks).toHaveLength(1);
    expect(taskCenter.tasks[0]).toMatchObject({
      id: receipt.taskId,
      type: "story.accepted-version.process",
      status: "succeeded",
      progress: {
        step: "pipeline.outcome.search-summary-state-causal",
        completedUnits: 4,
        totalUnits: 4,
      },
      metadata: {
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        acceptedCharacterCount: 1_234,
      },
    });
    expect(taskCenter.notifications[0]).toMatchObject({
      severity: "success",
      route: { entityType: "task", entityId: receipt.taskId },
    });
  });

  it("keeps unavailable ordinary model work recoverable without inventing provider output", async () => {
    const harness = createHarness({
      summary: {
        status: "skipped",
        code: "CHAPTER_SUMMARY_MODEL_UNAVAILABLE",
        message: "No configured model route.",
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        fact: null,
        replacedFactIds: [],
        invocation: null,
      },
      storyState: {
        status: "skipped",
        detectedCount: 0,
        needsConfirmationCount: 0,
        reversibleCount: 0,
        skippedTasks: [{ task: "character_extraction", code: "MODEL_UNAVAILABLE" }],
        providerInvocations: [],
      },
    });

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "candidate_accept",
      acceptedCharacterCount: 20,
    });

    expect(receipt.status).toBe("partially_completed");
    expect(receipt.chapterSummary).toMatchObject({
      status: "skipped",
      code: "CHAPTER_SUMMARY_MODEL_UNAVAILABLE",
    });
    expect(receipt.storyState).toMatchObject({
      status: "skipped",
      code: "STORY_STATE_PROVIDER_UNAVAILABLE",
    });
    expect(receipt.storyStateMetrics?.skippedTaskCount).toBe(1);
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "waiting_retry",
      failure: { causeCode: "PIPELINE_STAGES_SUMMARY_STATE" },
    });
  });

  it.each([
    ["CHAPTER_SUMMARY_EMPTY_CHAPTER", "skipped", "not_applicable", "n"],
    ["CHAPTER_SUMMARY_SOURCE_TOO_LARGE", "skipped", "not_applicable", "n"],
    ["CHAPTER_SUMMARY_AUTOMATION_PAUSED", "skipped", "deferred", "d"],
    ["CHAPTER_SUMMARY_SOURCE_NOT_CURRENT", "skipped", "not_applicable", "n"],
    ["CHAPTER_SUMMARY_PRIVACY_CHANGED", "failed", "not_applicable", "n"],
  ] as const)(
    "settles the permanent summary condition %s without a same-task retry",
    async (code, serviceStatus, expectedStatus, dispositionCode) => {
      const harness = createHarness({
        summary: {
          status: serviceStatus,
          code,
          message: "Summary preflight stopped before provider dispatch.",
          projectId: PROJECT_ID,
          chapterId: CHAPTER_ID,
          versionId: VERSION_ID,
          fact: null,
          replacedFactIds: [],
          invocation: null,
        },
      });

      const receipt = await runAcceptedChapterPipeline(harness.runtime, {
        projectId: PROJECT_ID as never,
        chapterId: CHAPTER_ID as never,
        versionId: VERSION_ID as never,
        source: "historical_backfill",
        acceptedCharacterCount: 20,
      });

      expect(receipt).toMatchObject({
        status: "completed_with_skips",
        chapterSummary: { status: expectedStatus, code },
      });
      expect((await harness.store.load()).tasks[0]).toMatchObject({
        status: "succeeded",
        progress: {
          step: `pipeline.outcome.v2.search-c.summary-${dispositionCode}.state-c.causal-c`,
        },
      });
    },
  );

  it("settles empty story-state extraction as not applicable", async () => {
    const harness = createHarness({
      storyState: {
        status: "skipped",
        detectedCount: 0,
        needsConfirmationCount: 0,
        reversibleCount: 0,
        skippedTasks: [
          { task: "character_extraction", code: "EMPTY_CHAPTER" },
          { task: "world_extraction", code: "EMPTY_CHAPTER" },
        ],
        providerInvocations: [],
      },
    });

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "historical_backfill",
      acceptedCharacterCount: 0,
    });

    expect(receipt.storyState).toMatchObject({
      status: "not_applicable",
      code: "STORY_STATE_EMPTY_CHAPTER",
    });
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "succeeded",
      progress: { step: "pipeline.outcome.v2.search-c.summary-c.state-n.causal-c" },
    });
  });

  it("persists terminal disposition beside another stage's retry scope", async () => {
    const harness = createHarness({
      summary: {
        status: "skipped",
        code: "CHAPTER_SUMMARY_SOURCE_TOO_LARGE",
        message: "The immutable source exceeds the bounded summary contract.",
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        fact: null,
        replacedFactIds: [],
        invocation: null,
      },
      storyState: {
        status: "skipped",
        detectedCount: 0,
        needsConfirmationCount: 0,
        reversibleCount: 0,
        skippedTasks: [{ task: "character_extraction", code: "MODEL_UNAVAILABLE" }],
        providerInvocations: [],
      },
    });

    await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "historical_backfill",
      acceptedCharacterCount: 20,
    });

    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "waiting_retry",
      failure: { causeCode: "PIPELINE_V2_F_T_N_S" },
    });
  });

  it("preserves not-applicable and deferred evidence through manual retries and exhaustion", async () => {
    const sourceNotCurrent = Object.assign(
      new Error("The story-state source is no longer current."),
      {
        details: { reasonCode: "STORY_STATE_SOURCE_NOT_CURRENT" },
      },
    );
    const harness = createHarness({
      summary: {
        status: "skipped",
        code: "CHAPTER_SUMMARY_AUTOMATION_PAUSED",
        message: "Automatic summaries are paused.",
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        fact: null,
        replacedFactIds: [],
        invocation: null,
      },
      storyStateError: sourceNotCurrent,
    });
    harness.causal.mockRejectedValue(new Error("Causal projection is temporarily unavailable."));
    const input = {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "historical_backfill" as const,
      acceptedCharacterCount: 20,
    };
    const expectedCause = pipelineStageFailureCauseCode(
      ["causal_projection"],
      ["story_state"],
      ["chapter_summary"],
    );

    await runAcceptedChapterPipeline(harness.runtime, input);
    for (let retry = 0; retry < 2; retry += 1) {
      const waiting = (await harness.store.load()).tasks[0];
      if (waiting?.failure?.causeCode === null || waiting?.failure?.causeCode === undefined) {
        throw new Error("Expected the retry disposition evidence to remain persisted.");
      }
      const queued = await harness.store.retryTaskNow(waiting.id, {
        expectedSequence: waiting.sequence,
        expectedAttempt: waiting.attempt,
        expectedFailureCauseCode: waiting.failure.causeCode,
        recoveryProgressStep: pipelineRetryProgressStep(waiting.attempt, waiting.failure.causeCode),
      });
      await runAcceptedChapterPipeline(harness.runtime, {
        ...input,
        retryFailureCauseCode: waiting.failure.causeCode,
        retryTaskSequence: queued.sequence,
        retryTaskAttempt: queued.attempt,
      });
    }

    expect(harness.summary).toHaveBeenCalledTimes(1);
    expect(harness.storyState).toHaveBeenCalledTimes(1);
    expect(harness.causal).toHaveBeenCalledTimes(3);
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "failed",
      failure: { code: "TASK_RETRY_EXHAUSTED", causeCode: expectedCause },
    });
  });

  it("rejects stale manual retry evidence after a competing execution changes the task", async () => {
    const harness = createHarness();
    harness.search.mockRejectedValueOnce(new Error("Search failed on the first attempt."));
    const input = {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "candidate_accept" as const,
      acceptedCharacterCount: 20,
    };
    await runAcceptedChapterPipeline(harness.runtime, input);
    const firstFailure = (await harness.store.load()).tasks[0];
    if (
      firstFailure?.failure?.causeCode === null ||
      firstFailure?.failure?.causeCode === undefined
    ) {
      throw new Error("Expected the first retry scope.");
    }
    const queued = await harness.store.retryTaskNow(firstFailure.id, {
      expectedSequence: firstFailure.sequence,
      expectedAttempt: firstFailure.attempt,
      expectedFailureCauseCode: firstFailure.failure.causeCode,
      recoveryProgressStep: pipelineRetryProgressStep(
        firstFailure.attempt,
        firstFailure.failure.causeCode,
      ),
    });

    harness.search.mockRejectedValueOnce(new Error("A competing retry failed later."));
    await runAcceptedChapterPipeline(harness.runtime, {
      ...input,
      retryFailureCauseCode: firstFailure.failure.causeCode,
      retryTaskSequence: queued.sequence,
      retryTaskAttempt: queued.attempt,
    });
    const competed = (await harness.store.load()).tasks[0];
    expect(competed).toMatchObject({
      status: "waiting_retry",
      failure: { causeCode: "PIPELINE_STAGES_SEARCH" },
    });
    const callCounts = {
      search: harness.search.mock.calls.length,
      summary: harness.summary.mock.calls.length,
      storyState: harness.storyState.mock.calls.length,
      causal: harness.causal.mock.calls.length,
    };

    await expect(
      runAcceptedChapterPipeline(harness.runtime, {
        ...input,
        retryFailureCauseCode: firstFailure.failure.causeCode,
        retryTaskSequence: queued.sequence,
        retryTaskAttempt: queued.attempt,
      }),
    ).rejects.toThrow(/retry authority changed/u);
    expect(harness.search).toHaveBeenCalledTimes(callCounts.search);
    expect(harness.summary).toHaveBeenCalledTimes(callCounts.summary);
    expect(harness.storyState).toHaveBeenCalledTimes(callCounts.storyState);
    expect(harness.causal).toHaveBeenCalledTimes(callCounts.causal);
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "waiting_retry",
      failure: { causeCode: "PIPELINE_STAGES_SEARCH" },
    });
  });

  it("does not recreate a missing task from ephemeral manual retry authority", async () => {
    const harness = createHarness();

    await expect(
      runAcceptedChapterPipeline(harness.runtime, {
        projectId: PROJECT_ID as never,
        chapterId: CHAPTER_ID as never,
        versionId: VERSION_ID as never,
        source: "candidate_accept",
        acceptedCharacterCount: 20,
        retryFailureCauseCode: "PIPELINE_STAGES_SEARCH",
        retryTaskSequence: 3,
        retryTaskAttempt: 2,
      }),
    ).rejects.toThrow(/task no longer exists/u);

    expect((await harness.store.load()).tasks).toHaveLength(0);
    expect(harness.search).not.toHaveBeenCalled();
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect(harness.causal).not.toHaveBeenCalled();
  });

  it.each([
    ["STORY_STATE_SOURCE_NOT_CURRENT", "not_applicable", "n"],
    ["STORY_STATE_SOURCE_CHANGED", "not_applicable", "n"],
    ["STORY_STATE_VERSION_NOT_FOUND", "not_applicable", "n"],
  ] as const)(
    "settles story-state preflight condition %s without retrying the same task",
    async (reasonCode, expectedStatus, dispositionCode) => {
      const failure = Object.assign(new Error("Story-state preflight stopped."), {
        details: { reasonCode },
      });
      const harness = createHarness({ storyStateError: failure });

      const receipt = await runAcceptedChapterPipeline(harness.runtime, {
        projectId: PROJECT_ID as never,
        chapterId: CHAPTER_ID as never,
        versionId: VERSION_ID as never,
        source: "historical_backfill",
        acceptedCharacterCount: 20,
      });

      expect(receipt.storyState).toMatchObject({ status: expectedStatus, code: reasonCode });
      expect((await harness.store.load()).tasks[0]).toMatchObject({
        status: "succeeded",
        progress: {
          step: `pipeline.outcome.v2.search-c.summary-c.state-${dispositionCode}.causal-c`,
        },
      });
    },
  );

  it("keeps requested historical model stages recoverable when the provider is unavailable", async () => {
    const harness = createHarness({
      summary: {
        status: "skipped",
        code: "CHAPTER_SUMMARY_MODEL_UNAVAILABLE",
        message: "No configured model route.",
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        fact: null,
        replacedFactIds: [],
        invocation: null,
      },
      storyState: {
        status: "partially_completed",
        detectedCount: 1,
        needsConfirmationCount: 0,
        reversibleCount: 1,
        skippedTasks: [{ task: "world_extraction", code: "MODEL_UNAVAILABLE" }],
        providerInvocations: [],
      },
    });

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "historical_backfill",
      acceptedCharacterCount: 20,
      runSearch: false,
      runChapterSummary: true,
      runStoryState: true,
      runCausalProjection: false,
    });

    expect(receipt.status).toBe("partially_completed");
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "waiting_retry",
      failure: {
        code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
        causeCode: "PIPELINE_STAGES_SUMMARY_STATE",
      },
    });
    expect(harness.search).not.toHaveBeenCalled();
    expect(harness.causal).not.toHaveBeenCalled();
  });

  it("treats already-processed continuous state as durable completion evidence", async () => {
    const harness = createHarness({
      storyState: {
        status: "already_processed",
        detectedCount: 0,
        needsConfirmationCount: 0,
        reversibleCount: 0,
        skippedTasks: [],
        providerInvocations: [],
      },
    });

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "historical_backfill",
      acceptedCharacterCount: 20,
    });

    expect(receipt).toMatchObject({
      status: "completed",
      storyState: {
        status: "completed",
        code: "STORY_STATE_ALREADY_PROCESSED",
      },
    });
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "succeeded",
      progress: { step: "pipeline.outcome.search-summary-state-causal" },
    });
  });

  it("keeps local search and causal projection durable when manual-save model work is disabled", async () => {
    const harness = createHarness();

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "manual_save",
      acceptedCharacterCount: 321,
      runChapterSummary: false,
      runStoryState: false,
    });

    expect(receipt).toMatchObject({
      status: "completed_with_skips",
      search: { status: "completed", code: "SEARCH_INDEX_REBUILT" },
      chapterSummary: {
        status: "skipped",
        code: "CHAPTER_SUMMARY_DISABLED_BY_PREFERENCE",
      },
      storyState: { status: "skipped", code: "STORY_STATE_DISABLED_BY_PREFERENCE" },
      causalProjection: { status: "completed", code: "CAUSAL_PROJECTION_REBUILT" },
    });
    expect(harness.search).toHaveBeenCalledOnce();
    expect(harness.causal).toHaveBeenCalledOnce();
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect((await harness.store.load()).tasks[0]?.metadata).toMatchObject({
      source: "manual_save",
      runChapterSummary: false,
      runStoryState: false,
    });
  });

  it("keeps running independent stages and leaves a retryable task when derived work fails", async () => {
    const harness = createHarness();
    harness.search.mockRejectedValueOnce(new Error("index unavailable"));
    harness.storyState.mockRejectedValueOnce(new Error("extractor unavailable"));

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "candidate_accept",
      acceptedCharacterCount: 99,
    });

    expect(receipt.status).toBe("partially_completed");
    expect(receipt.search).toMatchObject({
      status: "failed",
      code: "SEARCH_INDEX_REBUILD_FAILED",
    });
    expect(receipt.storyState).toMatchObject({
      status: "failed",
      code: "STORY_STATE_UPDATE_FAILED",
    });
    expect(receipt.chapterSummary.status).toBe("completed");
    expect(receipt.causalProjection.status).toBe("completed");
    const task = (await harness.store.load()).tasks[0];
    expect(task).toMatchObject({
      status: "waiting_retry",
      failure: {
        code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
        causeCode: "PIPELINE_STAGES_SEARCH_STATE",
        retryable: true,
        actions: ["RETRY", "OPEN_SETTINGS", "EXPORT_DIAGNOSTICS"],
      },
    });
  });
});

function createHarness(
  overrides: Readonly<{
    summary?: unknown;
    storyState?: unknown;
    storyStateError?: Error;
  }> = {},
) {
  const storage = new MemoryStorage();
  const clock = { now: () => NOW };
  const store = new BrowserDevelopmentTaskCenterStore(storage, clock);
  const search = vi.fn(() =>
    Promise.resolve({
      ok: true as const,
      value: {
        generation: 1,
        mutationStatus: "ready" as const,
        vectorStatus: "disabled" as const,
        documentCount: 1,
        embeddingCount: 0,
        relationCount: 0,
        degradedReasons: [],
      },
    }),
  );
  const summary = vi.fn(() =>
    Promise.resolve(
      (overrides.summary ?? {
        status: "generated",
        code: "CHAPTER_SUMMARY_GENERATED",
        message: "Summary updated.",
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        fact: null,
        replacedFactIds: [],
        invocation: {
          task: "chapter_summary",
          providerKind: "openai",
          modelId: "model-a",
          invocationId: uuid(80),
        },
      }) as never,
    ),
  );
  const storyState = vi.fn(() => {
    if (overrides.storyStateError !== undefined) {
      return Promise.reject(overrides.storyStateError);
    }
    return Promise.resolve(
      (overrides.storyState ?? {
        status: "completed",
        detectedCount: 3,
        needsConfirmationCount: 1,
        reversibleCount: 2,
        skippedTasks: [],
        providerInvocations: [],
      }) as never,
    );
  });
  const causal = vi.fn(() =>
    Promise.resolve({
      projectId: PROJECT_ID,
      branchId: "main",
      eventCount: 2,
      relationCount: 1,
      includedFactIds: [],
      skipped: [],
      graph: {},
    } as never),
  );
  let nextId = 10;
  const runtime: AcceptedChapterPipelineRuntime = {
    taskCenter: store,
    search: { rebuildProject: search },
    story: {
      chapterSummaries: { summarizeSavedVersion: summary },
      continuousState: { extractSavedVersion: storyState },
      causalProjector: { rebuildProject: causal },
    },
    ids: { next: () => uuid(nextId++) as never },
    clock: clock as never,
  };
  return { runtime, store, search, summary, storyState, causal };
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

function uuid(sequence: number): string {
  return `018f0f00-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}
