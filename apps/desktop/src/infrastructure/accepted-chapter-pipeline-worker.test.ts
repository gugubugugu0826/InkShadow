import { describe, expect, it, vi } from "vitest";

import {
  pipelineRetryProgressStep,
  runAcceptedChapterPipeline,
  type AcceptedChapterPipelineRuntime,
} from "./accepted-chapter-pipeline";
import { AcceptedChapterPipelineWorker, retryInput } from "./accepted-chapter-pipeline-worker";
import {
  BrowserDevelopmentTaskCenterStore,
  DEVELOPMENT_TASK_CENTER_KEY,
} from "./task-center-store";

const NOW = "2026-08-08T00:00:00.000Z";
const PROJECT_ID = uuid(1);
const CHAPTER_ID = uuid(2);
const VERSION_ID = uuid(3);

describe("AcceptedChapterPipelineWorker", () => {
  it("runs a due persisted retry and completes the same scheduled attempt", async () => {
    const harness = createHarness();
    harness.search.mockRejectedValueOnce(new Error("index temporarily unavailable"));
    await runAcceptedChapterPipeline(harness.runtime, acceptedInput());
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "waiting_retry",
      attempt: 2,
    });

    harness.setNow("2026-08-08T00:00:06.000Z");
    const worker = new AcceptedChapterPipelineWorker(harness.runtime);

    await expect(worker.runDueTasksNow()).resolves.toBe(1);
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "succeeded",
      attempt: 2,
      progress: {
        step: "pipeline.outcome.search-causal",
        completedUnits: 4,
        totalUnits: 4,
      },
    });
    expect(harness.search).toHaveBeenCalledTimes(2);
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect(harness.causal).toHaveBeenCalledTimes(1);
  });

  it("retires a legacy provider-only queued task without dispatch", async () => {
    const harness = createHarness();
    const supplementalKey = `story.accepted-version:${VERSION_ID}:backfill:v2:summary:1`;
    await harness.store.enqueueTask({
      id: uuid(20),
      type: "story.accepted-version.process",
      idempotencyKey: supplementalKey,
      metadata: {
        ...pipelineMetadata(),
        source: "historical_backfill",
        runSearch: false,
        runChapterSummary: true,
        runStoryState: false,
        runCausalProjection: false,
        pipelineIdempotencyKey: supplementalKey,
        pipelineStage: "chapter_summary",
        pipelineStageRuleVersion: 2,
        pipelineStageGeneration: 1,
      },
      priority: 75,
      maxAttempts: 3,
      now: NOW,
    });

    const worker = new AcceptedChapterPipelineWorker(harness.runtime, {
      queuedGraceMilliseconds: 0,
    });
    await expect(worker.runDueTasksNow()).resolves.toBe(1);

    expect(harness.search).not.toHaveBeenCalled();
    expect(harness.causal).not.toHaveBeenCalled();
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "cancelled",
    });
  });

  it("recovers an atomic local retry after restart without provider dispatch", async () => {
    const harness = createHarness();
    harness.causal.mockRejectedValueOnce(new Error("Causal projection is unavailable."));
    await runAcceptedChapterPipeline(harness.runtime, {
      ...acceptedInput(),
      source: "historical_backfill",
      runChapterSummary: true,
      runStoryState: true,
    });
    const waiting = (await harness.store.load()).tasks[0];
    if (waiting?.failure === null || waiting?.failure === undefined) {
      throw new Error("Expected a retryable mixed-disposition task.");
    }
    const queued = await harness.store.retryTaskNow(waiting.id, {
      expectedSequence: waiting.sequence,
      expectedAttempt: waiting.attempt,
      expectedFailureCauseCode: waiting.failure.causeCode,
      recoveryProgressStep: pipelineRetryProgressStep(waiting.attempt, waiting.failure.causeCode),
    });
    expect(retryInput(queued)).toMatchObject({
      retryTaskSequence: queued.sequence,
      retryTaskAttempt: queued.attempt,
      retryFailureCauseCode: waiting.failure.causeCode,
    });

    harness.setNow("2026-08-08T00:00:31.000Z");
    const restartedWorker = new AcceptedChapterPipelineWorker(harness.runtime);
    await expect(restartedWorker.runDueTasksNow()).resolves.toBe(1);

    expect(harness.search).toHaveBeenCalledTimes(1);
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect(harness.causal).toHaveBeenCalledTimes(2);
    expect((await harness.store.load()).tasks[0]).toMatchObject({
      status: "succeeded",
      progress: { step: "pipeline.outcome.search-causal" },
    });
  });

  it("recovers legacy queued Candidate retries without replaying provider stages", async () => {
    const harness = createHarness();
    harness.search.mockRejectedValueOnce(new Error("Search failed before the legacy retry."));
    await runAcceptedChapterPipeline(harness.runtime, acceptedInput());
    const waiting = (await harness.store.load()).tasks[0];
    if (waiting === undefined) {
      throw new Error("Expected a retryable legacy task.");
    }

    const legacyQueued = await harness.store.retryTaskNow(waiting.id);
    expect(legacyQueued.progress).toBeNull();
    expect(retryInput(legacyQueued)?.retryTaskSequence).toBeUndefined();

    harness.setNow("2026-08-08T00:00:31.000Z");
    const restartedWorker = new AcceptedChapterPipelineWorker(harness.runtime);
    await expect(restartedWorker.runDueTasksNow()).resolves.toBe(1);

    expect(harness.search).toHaveBeenCalledTimes(2);
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
    expect(harness.causal).toHaveBeenCalledTimes(2);
    expect((await harness.store.load()).tasks[0]?.status).toBe("succeeded");
  });

  it("fails closed on a damaged persisted retry scope before running any stage", async () => {
    const harness = createHarness();
    harness.search.mockRejectedValueOnce(new Error("Search failed."));
    await runAcceptedChapterPipeline(harness.runtime, acceptedInput());
    const waiting = (await harness.store.load()).tasks[0];
    if (waiting?.failure === null || waiting?.failure === undefined) {
      throw new Error("Expected a retryable task.");
    }
    await harness.store.retryTaskNow(waiting.id, {
      expectedSequence: waiting.sequence,
      expectedAttempt: waiting.attempt,
      expectedFailureCauseCode: waiting.failure.causeCode,
      recoveryProgressStep: pipelineRetryProgressStep(waiting.attempt, waiting.failure.causeCode),
    });
    const serialized = harness.storage.getItem(DEVELOPMENT_TASK_CENTER_KEY);
    if (serialized === null) throw new Error("Expected persisted task-center state.");
    const database = JSON.parse(serialized) as { tasks: { progress: { step: string } }[] };
    const persisted = database.tasks[0];
    if (persisted === undefined) throw new Error("Expected a persisted retry task.");
    persisted.progress.step = "pipeline.retry.v2.a2.f-x";
    harness.storage.setItem(DEVELOPMENT_TASK_CENTER_KEY, JSON.stringify(database));
    const callsBeforeRecovery = {
      search: harness.search.mock.calls.length,
      summary: harness.summary.mock.calls.length,
      storyState: harness.storyState.mock.calls.length,
      causal: harness.causal.mock.calls.length,
    };

    harness.setNow("2026-08-08T00:00:31.000Z");
    const reportError = vi.fn();
    const restartedWorker = new AcceptedChapterPipelineWorker(harness.runtime, { reportError });
    await expect(restartedWorker.runDueTasksNow()).resolves.toBe(0);
    expect(reportError).toHaveBeenCalledOnce();
    expect(harness.search).toHaveBeenCalledTimes(callsBeforeRecovery.search);
    expect(harness.summary).toHaveBeenCalledTimes(callsBeforeRecovery.summary);
    expect(harness.storyState).toHaveBeenCalledTimes(callsBeforeRecovery.storyState);
    expect(harness.causal).toHaveBeenCalledTimes(callsBeforeRecovery.causal);
  });

  it("recovers a queued Candidate task with legacy model flags without provider work", async () => {
    const harness = createHarness();
    await harness.store.enqueueTask({
      id: uuid(30),
      type: "story.accepted-version.process",
      idempotencyKey: `story.accepted-version:${VERSION_ID}`,
      metadata: {
        ...pipelineMetadata(),
        runChapterSummary: true,
        runStoryState: true,
      },
      priority: 75,
      maxAttempts: 3,
      now: NOW,
    });
    const worker = new AcceptedChapterPipelineWorker(harness.runtime, {
      queuedGraceMilliseconds: 30_000,
    });

    await expect(worker.runDueTasksNow()).resolves.toBe(0);
    harness.setNow("2026-08-08T00:00:31.000Z");
    await expect(worker.runDueTasksNow()).resolves.toBe(1);
    expect((await harness.store.load()).tasks[0]?.status).toBe("succeeded");
    expect(harness.search).toHaveBeenCalledOnce();
    expect(harness.causal).toHaveBeenCalledOnce();
    expect(harness.summary).not.toHaveBeenCalled();
    expect(harness.storyState).not.toHaveBeenCalled();
  });

  it("recovers an old due pipeline task hidden behind more than 200 newer UI rows", async () => {
    const harness = createHarness();
    const durableTask = {
      id: uuid(50),
      type: "story.accepted-version.process",
      idempotencyKey: `story.accepted-version:${VERSION_ID}`,
      metadata: pipelineMetadata(),
      priority: 75,
      maxAttempts: 3,
      now: "2026-08-08T00:00:01.000Z",
    } as const;
    await harness.store.enqueueTask(durableTask);
    for (let index = 0; index < 205; index += 1) {
      await harness.store.enqueueTask({
        id: uuid(2_000 + index),
        type: "story.accepted-version.process",
        idempotencyKey: `story.accepted-version:malformed-${String(index).padStart(4, "0")}`,
        metadata: { operation: "rebuild-derived-story-state" },
        priority: 75,
        maxAttempts: 1,
        now: NOW,
      });
    }
    for (let index = 0; index < 205; index += 1) {
      await harness.store.enqueueTask({
        id: uuid(1_000 + index),
        type: "maintenance.unrelated",
        idempotencyKey: `maintenance.unrelated:${String(index).padStart(4, "0")}`,
        metadata: { operation: "unrelated" },
        priority: 50,
        maxAttempts: 1,
        now: "2026-08-08T00:00:10.000Z",
      });
    }
    const uiSnapshot = await harness.store.load();
    expect(uiSnapshot.tasks).toHaveLength(200);
    expect(uiSnapshot.tasks.some(({ id }) => id === durableTask.id)).toBe(false);

    harness.setNow("2026-08-08T00:00:31.000Z");
    const reportError = vi.fn();
    const worker = new AcceptedChapterPipelineWorker(harness.runtime, { reportError });

    await expect(worker.runDueTasksNow()).resolves.toBe(1);
    await expect(
      harness.store.enqueueTask({ ...durableTask, id: uuid(51) }),
    ).resolves.toMatchObject({
      created: false,
      task: { id: durableTask.id, status: "succeeded" },
    });
    expect(harness.search).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(205);
    await expect(worker.runDueTasksNow()).resolves.toBe(0);
    expect(reportError).toHaveBeenCalledTimes(205);
  });

  it("coalesces overlapping polls and rejects incomplete persisted metadata", async () => {
    const harness = createHarness();
    await harness.store.enqueueTask({
      id: uuid(40),
      type: "story.accepted-version.process",
      idempotencyKey: `story.accepted-version:${VERSION_ID}`,
      metadata: pipelineMetadata(),
      priority: 75,
      maxAttempts: 3,
      now: NOW,
    });
    const release = deferred<undefined>();
    harness.search.mockImplementationOnce(async () => {
      await release.promise;
      return searchReceipt();
    });
    const worker = new AcceptedChapterPipelineWorker(harness.runtime, {
      queuedGraceMilliseconds: 0,
    });

    const first = worker.runDueTasksNow();
    const second = worker.runDueTasksNow();
    expect(second).toBe(first);
    release.resolve(undefined);
    await expect(first).resolves.toBe(1);
    expect(harness.search).toHaveBeenCalledTimes(1);

    const completed = (await harness.store.load()).tasks[0];
    if (completed === undefined) {
      throw new Error("Expected the completed task to remain persisted.");
    }
    expect(
      retryInput({
        ...completed,
        status: "queued",
        runAfter: completed.createdAt,
        finishedAt: null,
        metadata: { projectId: PROJECT_ID },
      }),
    ).toBeNull();
  });

  it("normalizes legacy manual-save provider flags to false during recovery", async () => {
    const harness = createHarness();
    await harness.store.enqueueTask({
      id: uuid(60),
      type: "story.accepted-version.process",
      idempotencyKey: `story.accepted-version:${VERSION_ID}`,
      metadata: {
        ...pipelineMetadata(),
        source: "manual_save",
        runChapterSummary: false,
        runStoryState: true,
      },
      priority: 75,
      maxAttempts: 3,
      now: NOW,
    });
    const task = (await harness.store.load()).tasks[0];
    if (task === undefined) {
      throw new Error("Expected the persisted manual-save task.");
    }

    expect(retryInput(task)).toMatchObject({
      source: "manual_save",
      runChapterSummary: false,
      runStoryState: false,
    });
    expect(
      retryInput({ ...task, metadata: { ...task.metadata, runStoryState: "yes" } }),
    ).toBeNull();
    expect(
      retryInput({
        ...task,
        metadata: {
          ...task.metadata,
          runSearch: false,
          runChapterSummary: false,
          runStoryState: false,
          runCausalProjection: false,
        },
      }),
    ).toBeNull();
  });

  it("rejects a retired provider-only supplemental identity before dispatch", async () => {
    const harness = createHarness();
    const supplementalKey = `story.accepted-version:${VERSION_ID}:backfill:v2:summary:1`;
    await harness.store.enqueueTask({
      id: uuid(65),
      type: "story.accepted-version.process",
      idempotencyKey: supplementalKey,
      metadata: {
        ...pipelineMetadata(),
        source: "historical_backfill",
        runSearch: false,
        runChapterSummary: true,
        runStoryState: false,
        runCausalProjection: false,
        pipelineIdempotencyKey: supplementalKey,
        pipelineStage: "chapter_summary",
        pipelineStageRuleVersion: 2,
        pipelineStageGeneration: 1,
      },
      priority: 75,
      maxAttempts: 3,
      now: NOW,
    });
    const task = (await harness.store.load()).tasks[0];
    if (task === undefined) throw new Error("Expected supplemental task.");

    expect(retryInput(task)).toBeNull();
    expect(
      retryInput({
        ...task,
        metadata: { ...task.metadata, pipelineIdempotencyKey: `${supplementalKey}-other` },
      }),
    ).toBeNull();
    expect(
      retryInput({
        ...task,
        metadata: { ...task.metadata, source: "candidate_accept" },
      }),
    ).toBeNull();
    expect(
      retryInput({
        ...task,
        metadata: { ...task.metadata, runSearch: true },
      }),
    ).toBeNull();
    expect(
      retryInput({
        ...task,
        failure: {
          code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
          causeCode: "PIPELINE_STAGES_SEARCH_SEARCH",
          retryable: true,
          actions: ["RETRY"],
          requestId: "request-malformed-mask",
        },
      }),
    ).toBeNull();
    expect(
      retryInput({
        ...task,
        failure: {
          code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
          causeCode: "PIPELINE_STAGES_SEARCH",
          retryable: true,
          actions: ["RETRY"],
          requestId: "request-scope-mismatch",
        },
      }),
    ).toBeNull();
    expect(
      retryInput({
        ...task,
        progress: {
          step: "pipeline.outcome.v2.summary-n.summary-d",
          completedUnits: 4,
          totalUnits: 4,
          updatedAt: task.updatedAt,
        },
      }),
    ).toBeNull();
    expect(
      retryInput({
        ...task,
        progress: {
          step: "pipeline.outcome.v2.search-n",
          completedUnits: 4,
          totalUnits: 4,
          updatedAt: task.updatedAt,
        },
      }),
    ).toBeNull();
    expect(
      retryInput({
        ...task,
        progress: {
          step: "pipeline.outcome.v2.summary-n",
          completedUnits: 4,
          totalUnits: 4,
          updatedAt: task.updatedAt,
        },
      }),
    ).toBeNull();
  });

  it("limits historical backfill recovery to five chapters per worker run", async () => {
    const harness = createHarness();
    for (let index = 0; index < 7; index += 1) {
      const chapterId = uuid(100 + index);
      const versionId = uuid(200 + index);
      await harness.store.enqueueTask({
        id: uuid(300 + index),
        type: "story.accepted-version.process",
        idempotencyKey: `story.accepted-version:${versionId}`,
        metadata: {
          projectId: PROJECT_ID,
          chapterId,
          versionId,
          source: "historical_backfill",
          acceptedCharacterCount: 500 + index,
          runChapterSummary: true,
          runStoryState: false,
          operation: "rebuild-derived-story-state",
        },
        priority: 75,
        maxAttempts: 3,
        now: NOW,
      });
    }
    const worker = new AcceptedChapterPipelineWorker(harness.runtime, {
      queuedGraceMilliseconds: 0,
    });

    await expect(worker.runDueTasksNow()).resolves.toBe(5);
    expect(harness.search).toHaveBeenCalledTimes(5);
    expect(
      (await harness.store.load()).tasks.filter(({ status }) => status === "queued"),
    ).toHaveLength(2);

    await expect(worker.runDueTasksNow()).resolves.toBe(2);
    expect(harness.search).toHaveBeenCalledTimes(7);
    expect((await harness.store.load()).tasks.every(({ status }) => status === "succeeded")).toBe(
      true,
    );
  });
});

function createHarness() {
  const storage = new MemoryStorage();
  let now = NOW;
  const clock = { now: () => now };
  const store = new BrowserDevelopmentTaskCenterStore(storage, clock);
  const search = vi.fn(() => Promise.resolve(searchReceipt()));
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
      invocation: null,
    } as never),
  );
  const storyState = vi.fn(() =>
    Promise.resolve({
      status: "completed",
      detectedCount: 2,
      needsConfirmationCount: 1,
      reversibleCount: 1,
      skippedTasks: [],
      providerInvocations: [],
    } as never),
  );
  const causal = vi.fn(() =>
    Promise.resolve({
      projectId: PROJECT_ID,
      branchId: "main",
      eventCount: 1,
      relationCount: 0,
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
  return {
    runtime,
    store,
    search,
    summary,
    storyState,
    causal,
    storage,
    setNow: (value: string) => {
      now = value;
    },
  };
}

function acceptedInput() {
  return {
    projectId: PROJECT_ID as never,
    chapterId: CHAPTER_ID as never,
    versionId: VERSION_ID as never,
    source: "candidate_accept" as const,
    acceptedCharacterCount: 128,
  };
}

function pipelineMetadata() {
  return {
    projectId: PROJECT_ID,
    chapterId: CHAPTER_ID,
    versionId: VERSION_ID,
    source: "candidate_accept",
    acceptedCharacterCount: 128,
    operation: "rebuild-derived-story-state",
  };
}

function searchReceipt() {
  return {
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
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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
