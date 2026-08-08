import { parseUuidV7 } from "@inkshadow/domain";
import type { TaskSnapshot } from "@inkshadow/task-engine";

import {
  ACCEPTED_CHAPTER_PIPELINE_MAXIMUM_STAGE_GENERATION,
  ACCEPTED_CHAPTER_PIPELINE_STAGE_RULE_VERSION,
  ACCEPTED_CHAPTER_PIPELINE_STAGES,
  ACCEPTED_CHAPTER_PIPELINE_OPERATION,
  ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE,
  acceptedChapterPipelineIdempotencyKey,
  acceptedChapterPipelineStageIdempotencyKey,
  inspectPipelineOutcomeProgressStep,
  inspectPipelineRetryProgressStep,
  inspectPipelineStageFailureCauseCode,
  runAcceptedChapterPipeline,
  type AcceptedChapterPipelineInput,
  type AcceptedChapterPipelineRuntime,
} from "./accepted-chapter-pipeline";
import type { DueTaskCursor } from "./task-center-store";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_QUEUED_GRACE_MS = 30_000;
const DUE_TASK_PAGE_LIMIT = 200;
const MAX_DUE_TASKS_SCANNED_PER_RUN = 1_000;
const MAX_DUE_TASKS_PROCESSED_PER_RUN = 200;
const MAX_REPORTED_INVALID_TASKS = 500;
const DEFAULT_MAXIMUM_HISTORICAL_BACKFILL_TASKS_PER_RUN = 5;

export interface AcceptedChapterPipelineWorkerOptions {
  readonly pollIntervalMilliseconds?: number;
  readonly queuedGraceMilliseconds?: number;
  readonly maximumHistoricalBackfillTasksPerRun?: number;
  readonly reportError?: (cause: unknown) => void;
}

/**
 * Recovers accepted-version derived work after a crash and executes scheduled
 * retries. Freshly enqueued tasks receive a grace window so the foreground
 * accept flow remains their first owner and does not race the worker.
 */
export class AcceptedChapterPipelineWorker {
  private readonly pollIntervalMilliseconds: number;
  private readonly queuedGraceMilliseconds: number;
  private readonly reportError: (cause: unknown) => void;
  private readonly maximumHistoricalBackfillTasksPerRun: number;
  private timer: ReturnType<typeof globalThis.setInterval> | null = null;
  private activeRun: Promise<number> | null = null;
  private dueTaskCursor: DueTaskCursor | null = null;
  private readonly reportedInvalidTaskIds = new Set<string>();

  public constructor(
    private readonly runtime: AcceptedChapterPipelineRuntime,
    options: AcceptedChapterPipelineWorkerOptions = {},
  ) {
    this.pollIntervalMilliseconds = positiveInteger(
      options.pollIntervalMilliseconds,
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.queuedGraceMilliseconds = nonNegativeInteger(
      options.queuedGraceMilliseconds,
      DEFAULT_QUEUED_GRACE_MS,
    );
    this.maximumHistoricalBackfillTasksPerRun = positiveInteger(
      options.maximumHistoricalBackfillTasksPerRun,
      DEFAULT_MAXIMUM_HISTORICAL_BACKFILL_TASKS_PER_RUN,
    );
    this.reportError = options.reportError ?? (() => undefined);
  }

  public start(): void {
    if (this.timer !== null) {
      return;
    }
    void this.runDueTasksNow().catch(this.reportError);
    this.timer = globalThis.setInterval(() => {
      void this.runDueTasksNow().catch(this.reportError);
    }, this.pollIntervalMilliseconds);
  }

  public async stop(): Promise<void> {
    if (this.timer !== null) {
      globalThis.clearInterval(this.timer);
      this.timer = null;
    }
    await this.activeRun?.catch(() => undefined);
  }

  public runDueTasksNow(): Promise<number> {
    if (this.activeRun !== null) {
      return this.activeRun;
    }
    const run = this.processDueTasks();
    this.activeRun = run;
    const clear = (): void => {
      if (this.activeRun === run) {
        this.activeRun = null;
      }
    };
    void run.then(clear, clear);
    return run;
  }

  private async processDueTasks(): Promise<number> {
    const now = this.runtime.clock.now();
    const nowMilliseconds = Date.parse(now);
    if (!Number.isFinite(nowMilliseconds)) {
      return 0;
    }
    let processedCount = 0;
    let historicalBackfillProcessedCount = 0;
    let scannedCount = 0;
    const queuedUpdatedAtOrBefore = new Date(
      nowMilliseconds - this.queuedGraceMilliseconds,
    ).toISOString();
    while (
      scannedCount < MAX_DUE_TASKS_SCANNED_PER_RUN &&
      processedCount < MAX_DUE_TASKS_PROCESSED_PER_RUN
    ) {
      const pageLimit = Math.min(DUE_TASK_PAGE_LIMIT, MAX_DUE_TASKS_SCANNED_PER_RUN - scannedCount);
      const tasks = await this.runtime.taskCenter.listDueTasks({
        taskType: ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE,
        metadataOperation: ACCEPTED_CHAPTER_PIPELINE_OPERATION,
        now,
        queuedUpdatedAtOrBefore,
        after: this.dueTaskCursor,
        limit: pageLimit,
      });
      if (tasks.length === 0) {
        this.dueTaskCursor = null;
        break;
      }

      let consumedPage = 0;
      for (const task of tasks) {
        consumedPage += 1;
        scannedCount += 1;
        const nextCursor = cursorAfter(task);
        const input = retryInput(task);
        if (input === null) {
          this.dueTaskCursor = nextCursor;
          this.reportInvalidTaskOnce(task.id);
          continue;
        }
        if (!isDue(task, now, this.queuedGraceMilliseconds)) {
          this.dueTaskCursor = nextCursor;
          continue;
        }
        if (
          input.source === "historical_backfill" &&
          historicalBackfillProcessedCount >= this.maximumHistoricalBackfillTasksPerRun
        ) {
          // Restart from the oldest remaining due task on the next poll. This
          // deliberately bounds possible model dispatches from a bulk backfill.
          this.dueTaskCursor = null;
          return processedCount;
        }
        this.dueTaskCursor = nextCursor;
        processedCount += 1;
        if (input.source === "historical_backfill") {
          historicalBackfillProcessedCount += 1;
        }
        try {
          await runAcceptedChapterPipeline(this.runtime, input);
        } catch (cause: unknown) {
          // A task remains durable and can be retried manually. One corrupt or
          // racing item must not prevent other independent tasks from running.
          this.reportError(cause);
        }
        if (processedCount >= MAX_DUE_TASKS_PROCESSED_PER_RUN) {
          break;
        }
      }
      if (consumedPage === tasks.length && tasks.length < pageLimit) {
        this.dueTaskCursor = null;
        break;
      }
    }
    return processedCount;
  }

  private reportInvalidTaskOnce(taskId: string): void {
    if (this.reportedInvalidTaskIds.has(taskId)) {
      return;
    }
    if (this.reportedInvalidTaskIds.size >= MAX_REPORTED_INVALID_TASKS) {
      const oldest = this.reportedInvalidTaskIds.values().next().value;
      if (oldest !== undefined) {
        this.reportedInvalidTaskIds.delete(oldest);
      }
    }
    this.reportedInvalidTaskIds.add(taskId);
    this.reportError(new Error(`Accepted chapter recovery task ${taskId} has invalid metadata.`));
  }
}

export function retryInput(task: TaskSnapshot): AcceptedChapterPipelineInput | null {
  if (
    task.type !== "story.accepted-version.process" ||
    (task.status !== "queued" && task.status !== "waiting_retry") ||
    task.metadata.operation !== "rebuild-derived-story-state"
  ) {
    return null;
  }
  const projectId = parseMetadataUuid(task.metadata.projectId);
  const chapterId = parseMetadataUuid(task.metadata.chapterId);
  const versionId = parseMetadataUuid(task.metadata.versionId);
  const source = task.metadata.source;
  const acceptedCharacterCount = task.metadata.acceptedCharacterCount;
  if (
    projectId === null ||
    chapterId === null ||
    versionId === null ||
    (source !== "candidate_accept" &&
      source !== "chapter_import" &&
      source !== "manual_save" &&
      source !== "version_restore" &&
      source !== "historical_backfill") ||
    typeof acceptedCharacterCount !== "number" ||
    !Number.isSafeInteger(acceptedCharacterCount) ||
    acceptedCharacterCount < 0
  ) {
    return null;
  }
  const runChapterSummary = optionalBoolean(task.metadata.runChapterSummary);
  const runStoryState = optionalBoolean(task.metadata.runStoryState);
  const runSearch = optionalBoolean(task.metadata.runSearch);
  const runCausalProjection = optionalBoolean(task.metadata.runCausalProjection);
  const pipelineIdempotencyKey = optionalString(task.metadata.pipelineIdempotencyKey);
  const pipelineStage = optionalPipelineStage(task.metadata.pipelineStage);
  const pipelineStageRuleVersion = optionalPositiveInteger(task.metadata.pipelineStageRuleVersion);
  const pipelineStageGeneration = optionalPositiveInteger(task.metadata.pipelineStageGeneration);
  const hasSupplementMetadata =
    pipelineIdempotencyKey !== undefined ||
    pipelineStage !== undefined ||
    pipelineStageRuleVersion !== undefined ||
    pipelineStageGeneration !== undefined;
  if (
    runChapterSummary === null ||
    runStoryState === null ||
    runSearch === null ||
    runCausalProjection === null ||
    pipelineIdempotencyKey === null ||
    pipelineStage === null ||
    pipelineStageRuleVersion === null ||
    pipelineStageGeneration === null ||
    (hasSupplementMetadata &&
      (source !== "historical_backfill" ||
        pipelineIdempotencyKey !== task.idempotencyKey ||
        pipelineStage === undefined ||
        pipelineStageRuleVersion !== ACCEPTED_CHAPTER_PIPELINE_STAGE_RULE_VERSION ||
        pipelineStageGeneration === undefined ||
        pipelineStageGeneration > ACCEPTED_CHAPTER_PIPELINE_MAXIMUM_STAGE_GENERATION ||
        task.idempotencyKey !==
          acceptedChapterPipelineStageIdempotencyKey(
            versionId,
            pipelineStage,
            pipelineStageGeneration,
          ) ||
        !isOneHotSupplement(
          pipelineStage,
          runSearch,
          runChapterSummary,
          runStoryState,
          runCausalProjection,
        ))) ||
    (!hasSupplementMetadata &&
      task.idempotencyKey !== acceptedChapterPipelineIdempotencyKey(versionId))
  ) {
    return null;
  }
  const enabledStages = new Set(
    ACCEPTED_CHAPTER_PIPELINE_STAGES.filter((stage) =>
      stageEnabled(stage, runSearch, runChapterSummary, runStoryState, runCausalProjection),
    ),
  );
  const failureScope = inspectPipelineStageFailureCauseCode(task.failure?.causeCode ?? null);
  const retryProgress = inspectPipelineRetryProgressStep(task.progress?.step ?? null);
  const outcome = inspectPipelineOutcomeProgressStep(task.progress?.step ?? null);
  const persistedRetryScope =
    retryProgress.kind === "valid"
      ? inspectPipelineStageFailureCauseCode(retryProgress.failureCauseCode)
      : null;
  if (
    enabledStages.size === 0 ||
    failureScope.kind === "malformed" ||
    (failureScope.kind === "valid" &&
      [
        ...failureScope.stages,
        ...failureScope.notApplicableStages,
        ...failureScope.deferredStages,
      ].some((stage) => !enabledStages.has(stage))) ||
    retryProgress.kind === "malformed" ||
    (retryProgress.kind === "valid" &&
      (task.status !== "queued" ||
        task.failure !== null ||
        task.attempt !== retryProgress.attempt ||
        persistedRetryScope?.kind === "malformed" ||
        (persistedRetryScope?.kind === "valid" &&
          [
            ...persistedRetryScope.stages,
            ...persistedRetryScope.notApplicableStages,
            ...persistedRetryScope.deferredStages,
          ].some((stage) => !enabledStages.has(stage))))) ||
    outcome.kind === "malformed" ||
    (outcome.kind === "valid" &&
      [...outcome.stages, ...outcome.notApplicableStages, ...outcome.deferredStages].some(
        (stage) => !enabledStages.has(stage),
      ))
  ) {
    return null;
  }
  return {
    projectId,
    chapterId,
    versionId,
    source,
    acceptedCharacterCount,
    ...(runChapterSummary === undefined ? {} : { runChapterSummary }),
    ...(runStoryState === undefined ? {} : { runStoryState }),
    ...(runSearch === undefined ? {} : { runSearch }),
    ...(runCausalProjection === undefined ? {} : { runCausalProjection }),
    ...(pipelineIdempotencyKey === undefined ? {} : { pipelineIdempotencyKey }),
    ...(pipelineStage === undefined ? {} : { pipelineStage }),
    ...(pipelineStageRuleVersion === undefined ? {} : { pipelineStageRuleVersion }),
    ...(pipelineStageGeneration === undefined ? {} : { pipelineStageGeneration }),
    ...(retryProgress.kind !== "valid"
      ? {}
      : {
          retryTaskSequence: task.sequence,
          retryTaskAttempt: task.attempt,
          ...(retryProgress.failureCauseCode === null
            ? {}
            : { retryFailureCauseCode: retryProgress.failureCauseCode }),
        }),
  };
}

function isOneHotSupplement(
  pipelineStage: NonNullable<AcceptedChapterPipelineInput["pipelineStage"]>,
  runSearch: boolean | undefined,
  runChapterSummary: boolean | undefined,
  runStoryState: boolean | undefined,
  runCausalProjection: boolean | undefined,
): boolean {
  return (
    runSearch !== undefined &&
    runChapterSummary !== undefined &&
    runStoryState !== undefined &&
    runCausalProjection !== undefined &&
    ACCEPTED_CHAPTER_PIPELINE_STAGES.every(
      (stage) =>
        stageEnabled(stage, runSearch, runChapterSummary, runStoryState, runCausalProjection) ===
        (stage === pipelineStage),
    )
  );
}

function stageEnabled(
  stage: (typeof ACCEPTED_CHAPTER_PIPELINE_STAGES)[number],
  runSearch: boolean | undefined,
  runChapterSummary: boolean | undefined,
  runStoryState: boolean | undefined,
  runCausalProjection: boolean | undefined,
): boolean {
  switch (stage) {
    case "search":
      return runSearch !== false;
    case "chapter_summary":
      return runChapterSummary !== false;
    case "story_state":
      return runStoryState !== false;
    case "causal_projection":
      return runCausalProjection !== false;
  }
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  return value === undefined || typeof value === "boolean" ? value : null;
}

function optionalString(value: unknown): string | undefined | null {
  return value === undefined || typeof value === "string" ? value : null;
}

function optionalPositiveInteger(value: unknown): number | undefined | null {
  return value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    ? value
    : null;
}

function optionalPipelineStage(
  value: unknown,
): AcceptedChapterPipelineInput["pipelineStage"] | null {
  return value === undefined ||
    (typeof value === "string" &&
      ACCEPTED_CHAPTER_PIPELINE_STAGES.includes(
        value as (typeof ACCEPTED_CHAPTER_PIPELINE_STAGES)[number],
      ))
    ? (value as AcceptedChapterPipelineInput["pipelineStage"])
    : null;
}

function isDue(task: TaskSnapshot, now: string, queuedGraceMilliseconds: number): boolean {
  if (task.runAfter === null) {
    return false;
  }
  const nowMilliseconds = Date.parse(now);
  const runAfterMilliseconds = Date.parse(task.runAfter);
  if (
    !Number.isFinite(nowMilliseconds) ||
    !Number.isFinite(runAfterMilliseconds) ||
    runAfterMilliseconds > nowMilliseconds
  ) {
    return false;
  }
  if (task.status === "waiting_retry") {
    return task.failure?.retryable === true && task.failure.actions.includes("RETRY");
  }
  const updatedMilliseconds = Date.parse(task.updatedAt);
  return (
    Number.isFinite(updatedMilliseconds) &&
    nowMilliseconds - updatedMilliseconds >= queuedGraceMilliseconds
  );
}

function cursorAfter(task: TaskSnapshot): DueTaskCursor {
  if (task.runAfter === null) {
    throw new Error("A due task must have a scheduled run time.");
  }
  return { runAfter: task.runAfter, createdAt: task.createdAt, id: task.id };
}

function parseMetadataUuid(value: unknown): AcceptedChapterPipelineInput["projectId"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = parseUuidV7(value);
  return parsed.ok ? parsed.value : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
