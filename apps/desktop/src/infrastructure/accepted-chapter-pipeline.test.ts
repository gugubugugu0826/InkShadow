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
  it("keeps Candidate acceptance local-only even when model stages are requested", async () => {
    const harness = createHarness();

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "candidate_accept",
      acceptedCharacterCount: 1_234,
      runChapterSummary: true,
      runStoryState: true,
    });

    expect(receipt).toMatchObject({
      status: "completed",
      projectId: PROJECT_ID,
      chapterId: CHAPTER_ID,
      versionId: VERSION_ID,
      search: { status: "completed" },
      chapterSummary: {
        status: "skipped",
        code: "CHAPTER_SUMMARY_REQUIRES_EXPLICIT_OPT_IN",
      },
      storyState: {
        status: "skipped",
        code: "STORY_STATE_REQUIRES_EXPLICIT_OPT_IN",
      },
      causalProjection: { status: "completed" },
      chapterSummaryStatus: null,
      storyStateMetrics: null,
    });
    expect(harness.search).toHaveBeenCalledWith(PROJECT_ID);
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect(harness.causal).toHaveBeenCalledWith(PROJECT_ID, "main");

    const taskCenter = await harness.store.load();
    expect(taskCenter.tasks).toHaveLength(1);
    expect(taskCenter.tasks[0]).toMatchObject({
      id: receipt.taskId,
      type: "story.accepted-version.process",
      status: "succeeded",
      progress: {
        step: "pipeline.outcome.search-causal",
        completedUnits: 4,
        totalUnits: 4,
      },
      metadata: {
        projectId: PROJECT_ID,
        chapterId: CHAPTER_ID,
        versionId: VERSION_ID,
        acceptedCharacterCount: 1_234,
        runChapterSummary: false,
        runStoryState: false,
      },
    });
    expect(taskCenter.notifications[0]).toMatchObject({
      severity: "success",
      route: { entityType: "task", entityId: receipt.taskId },
    });
  });

  it("deduplicates the Candidate local refresh without creating a second dispatch path", async () => {
    const harness = createHarness();
    const input = {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "candidate_accept" as const,
      acceptedCharacterCount: 88,
      runChapterSummary: true,
      runStoryState: true,
    };

    await expect(runAcceptedChapterPipeline(harness.runtime, input)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(runAcceptedChapterPipeline(harness.runtime, input)).resolves.toMatchObject({
      status: "already_scheduled",
    });

    expect(harness.search).toHaveBeenCalledOnce();
    expect(harness.causal).toHaveBeenCalledOnce();
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect((await harness.store.load()).tasks).toHaveLength(1);
  });

  it.each(["manual_save", "chapter_import", "version_restore", "historical_backfill"] as const)(
    "keeps %s local-only even when legacy flags request provider work",
    async (source) => {
      const harness = createHarness();

      const receipt = await runAcceptedChapterPipeline(harness.runtime, {
        projectId: PROJECT_ID as never,
        chapterId: CHAPTER_ID as never,
        versionId: VERSION_ID as never,
        source,
        acceptedCharacterCount: 20,
        runChapterSummary: true,
        runStoryState: true,
      });

      expect(receipt).toMatchObject({
        status: "completed",
        chapterSummary: {
          status: "skipped",
          code: "CHAPTER_SUMMARY_REQUIRES_SEPARATE_AUTHORIZATION",
        },
        storyState: {
          status: "skipped",
          code: "STORY_STATE_REQUIRES_SEPARATE_AUTHORIZATION",
        },
      });
      expect(harness.summary).not.toHaveBeenCalled();
      expect(harness.storyState).not.toHaveBeenCalled();
      expect((await harness.store.load()).tasks[0]?.metadata).toMatchObject({
        source,
        runChapterSummary: false,
        runStoryState: false,
      });
    },
  );

  it("retries only failed local work and never promotes legacy provider scope", async () => {
    const harness = createHarness();
    harness.causal.mockRejectedValue(new Error("Causal projection is temporarily unavailable."));
    const input = {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "manual_save" as const,
      acceptedCharacterCount: 20,
      runChapterSummary: true,
      runStoryState: true,
    };

    await runAcceptedChapterPipeline(harness.runtime, input);
    for (let retry = 0; retry < 2; retry += 1) {
      const waiting = (await harness.store.load()).tasks[0];
      if (waiting?.failure?.causeCode === null || waiting?.failure?.causeCode === undefined) {
        throw new Error("Expected a retryable local failure.");
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

    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect(harness.causal).toHaveBeenCalledTimes(3);
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "failed",
      failure: { code: "TASK_RETRY_EXHAUSTED", causeCode: "PIPELINE_STAGES_CAUSAL" },
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

  it("rejects a provider-only pipeline request before enqueue or dispatch", async () => {
    const harness = createHarness();
    const input = {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "historical_backfill" as const,
      acceptedCharacterCount: 20,
      runSearch: false,
      runChapterSummary: true,
      runStoryState: true,
      runCausalProjection: false,
    };

    await expect(runAcceptedChapterPipeline(harness.runtime, input)).rejects.toThrow(
      /at least one stage/u,
    );
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect((await harness.store.load()).tasks).toHaveLength(0);
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
      status: "completed",
      search: { status: "completed", code: "SEARCH_INDEX_REBUILT" },
      chapterSummary: {
        status: "skipped",
        code: "CHAPTER_SUMMARY_REQUIRES_SEPARATE_AUTHORIZATION",
      },
      storyState: {
        status: "skipped",
        code: "STORY_STATE_REQUIRES_SEPARATE_AUTHORIZATION",
      },
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

  it("keeps the accepted version safe when a local derived stage fails", async () => {
    const harness = createHarness();
    harness.search.mockRejectedValueOnce(new Error("index unavailable"));

    const receipt = await runAcceptedChapterPipeline(harness.runtime, {
      projectId: PROJECT_ID as never,
      chapterId: CHAPTER_ID as never,
      versionId: VERSION_ID as never,
      source: "candidate_accept",
      acceptedCharacterCount: 99,
      organizeLocalStoryFacts: true,
    });

    expect(receipt.status).toBe("partially_completed");
    expect(receipt.search).toMatchObject({
      status: "failed",
      code: "SEARCH_INDEX_REBUILD_FAILED",
    });
    expect(receipt.storyState).toMatchObject({
      status: "skipped",
      code: "STORY_STATE_REQUIRES_EXPLICIT_OPT_IN",
    });
    expect(receipt.chapterSummary).toMatchObject({
      status: "skipped",
      code: "CHAPTER_SUMMARY_REQUIRES_EXPLICIT_OPT_IN",
    });
    expect(receipt.causalProjection.status).toBe("completed");
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    const task = (await harness.store.load()).tasks[0];
    expect(task).toMatchObject({
      status: "waiting_retry",
      metadata: { organizeLocalStoryFacts: true },
      failure: {
        code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
        causeCode: "PIPELINE_STAGES_SEARCH",
        retryable: true,
        actions: ["RETRY", "OPEN_SETTINGS", "EXPORT_DIAGNOSTICS"],
      },
    });
  });
});

function createHarness() {
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
    Promise.resolve({
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
    } as never),
  );
  const storyState = vi.fn(() =>
    Promise.resolve({
      status: "completed",
      detectedCount: 3,
      needsConfirmationCount: 1,
      reversibleCount: 2,
      skippedTasks: [],
      providerInvocations: [],
    } as never),
  );
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
