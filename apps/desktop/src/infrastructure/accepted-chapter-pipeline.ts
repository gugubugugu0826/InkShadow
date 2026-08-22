import type { Clock, UuidV7, UuidV7Generator } from "@inkshadow/domain";
import type { CreateTaskInput } from "@inkshadow/task-engine";

import type {
  ChapterSummaryGenerationReceipt,
  ChapterSummaryService,
} from "./chapter-summary-service";
import type {
  ContinuousStoryStateExtractionReceipt,
  ContinuousStoryStateExtractionService,
} from "./continuous-story-state-extraction";
import type {
  CausalStoryFactProjectionReceipt,
  CausalStoryFactProjector,
} from "./causal-story-fact-projector";
import type { ProjectSearchService } from "./project-search";
import type { CreateTaskSnapshotResult, TaskCenterStore } from "./task-center-store";

export const ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE = "story.accepted-version.process";
export const ACCEPTED_CHAPTER_PIPELINE_OPERATION = "rebuild-derived-story-state";
export const ACCEPTED_CHAPTER_FACT_PREFLIGHT_FAILURE_CAUSE_CODE =
  "CURRENT_SAVED_VERSION_FACTS_UNAVAILABLE";
export const ACCEPTED_CHAPTER_PIPELINE_STAGE_RULE_VERSION = 2;
export const ACCEPTED_CHAPTER_PIPELINE_MAXIMUM_STAGE_GENERATION = 100;
const PIPELINE_STEPS = 4;

export const ACCEPTED_CHAPTER_PIPELINE_STAGES = [
  "search",
  "chapter_summary",
  "story_state",
  "causal_projection",
] as const;

export type AcceptedChapterPipelineStage = (typeof ACCEPTED_CHAPTER_PIPELINE_STAGES)[number];

export type AcceptedChapterPipelineSource =
  | "candidate_accept"
  | "chapter_import"
  | "autosave"
  | "manual_save"
  | "recovery_save"
  | "version_restore"
  | "historical_backfill";

export interface AcceptedChapterPipelineInput {
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly versionId: UuidV7;
  readonly source: AcceptedChapterPipelineSource;
  readonly acceptedCharacterCount: number;
  /**
   * Acceptance/save-time responsibility for organizing local story facts.
   * Missing values from older persisted tasks are normalized to false.
   */
  readonly organizeLocalStoryFacts?: boolean;
  /**
   * Legacy compatibility fields. Durable accepted-version work is a local-only
   * commit follower for every source, so these values are always normalized to
   * false before registration, execution, retry, or startup recovery.
   */
  readonly runChapterSummary?: boolean;
  readonly runStoryState?: boolean;
  /** Stage switches used by deterministic historical-recovery supplements. */
  readonly runSearch?: boolean;
  readonly runCausalProjection?: boolean;
  /** Supplemental recovery tasks keep their own durable identity. */
  readonly pipelineIdempotencyKey?: string;
  readonly pipelineStage?: AcceptedChapterPipelineStage;
  readonly pipelineStageRuleVersion?: number;
  readonly pipelineStageGeneration?: number;
  /** Ephemeral retry scope captured before retryTaskNow clears task.failure. */
  readonly retryFailureCauseCode?: string;
  /**
   * Exact queued snapshot returned by retryTaskNow. These fields bind the
   * ephemeral failure scope to the same attempt before any stage can run.
   */
  readonly retryTaskSequence?: number;
  readonly retryTaskAttempt?: number;
}

type LocalAcceptedVersionPipelineIdentity = Pick<
  AcceptedChapterPipelineInput,
  "projectId" | "chapterId" | "versionId" | "acceptedCharacterCount" | "organizeLocalStoryFacts"
> &
  Readonly<{
    source: Exclude<AcceptedChapterPipelineSource, "historical_backfill">;
  }>;

type LocalCandidateAcceptancePipelineIdentity = Omit<
  LocalAcceptedVersionPipelineIdentity,
  "source"
>;

/**
 * Every accepted正文 commit is a local boundary. It may refresh rebuildable
 * local projections, but it must never inherit a model-backed stage merely
 * because a provider is configured. Cloud enrichment, if offered, needs a
 * separate user-authorized operation and durable identity.
 */
export function createLocalAcceptedVersionPipelineInput(
  input: LocalAcceptedVersionPipelineIdentity,
): AcceptedChapterPipelineInput {
  return Object.freeze({
    ...input,
    organizeLocalStoryFacts: input.organizeLocalStoryFacts ?? false,
    runSearch: true,
    runChapterSummary: false,
    runStoryState: false,
    runCausalProjection: true,
  });
}

export function createLocalCandidateAcceptancePipelineInput(
  input: LocalCandidateAcceptancePipelineIdentity,
): AcceptedChapterPipelineInput {
  return createLocalAcceptedVersionPipelineInput({
    ...input,
    source: "candidate_accept",
  });
}

export type AcceptedChapterPipelineStageStatus =
  | "completed"
  | "partially_completed"
  | "skipped"
  | "not_applicable"
  | "deferred"
  | "failed"
  | "not_run";

export interface AcceptedChapterPipelineStageReceipt {
  readonly status: AcceptedChapterPipelineStageStatus;
  readonly code: string;
  readonly message: string;
}

export interface AcceptedChapterPipelineReceipt {
  readonly status:
    "completed" | "completed_with_skips" | "partially_completed" | "already_scheduled";
  readonly taskId: string;
  readonly projectId: string;
  readonly chapterId: string;
  readonly versionId: string;
  readonly search: AcceptedChapterPipelineStageReceipt;
  readonly chapterSummary: AcceptedChapterPipelineStageReceipt;
  readonly storyState: AcceptedChapterPipelineStageReceipt;
  readonly causalProjection: AcceptedChapterPipelineStageReceipt;
  readonly chapterSummaryStatus: ChapterSummaryGenerationReceipt["status"] | null;
  readonly storyStateMetrics: Readonly<{
    readonly detectedCount: number;
    readonly needsConfirmationCount: number;
    readonly reversibleCount: number;
    readonly skippedTaskCount: number;
  }> | null;
}

export interface AcceptedChapterPipelineRuntime {
  readonly taskCenter: TaskCenterStore;
  readonly search: Pick<ProjectSearchService, "rebuildProject">;
  readonly story: Readonly<{
    chapterSummaries: Pick<ChapterSummaryService, "summarizeSavedVersion">;
    continuousState: Pick<ContinuousStoryStateExtractionService, "extractSavedVersion">;
    causalProjector: Pick<CausalStoryFactProjector, "rebuildProject">;
  }>;
  readonly ids: Pick<UuidV7Generator, "next">;
  readonly clock: Pick<Clock, "now">;
}

/**
 * Runs the rebuildable work that follows a successful accepted-text commit.
 *
 * The caller must invoke this only after the immutable chapter version has been
 * committed. Every stage is deliberately best-effort: a failed model, index,
 * or projector never rolls back or mutates the accepted正文 version.
 */
export async function runAcceptedChapterPipeline(
  runtime: AcceptedChapterPipelineRuntime,
  input: AcceptedChapterPipelineInput,
): Promise<AcceptedChapterPipelineReceipt> {
  if (input.runChapterSummary !== false || input.runStoryState !== false) {
    return runAcceptedChapterPipeline(runtime, {
      ...input,
      runChapterSummary: false,
      runStoryState: false,
    });
  }
  const enabledStages = enabledPipelineStages(input);
  if (enabledStages.size === 0) {
    throw new Error("An accepted chapter pipeline task must enable at least one stage.");
  }
  assertManualRetryInputShape(input);
  const requestId = runtime.ids.next();
  const leaseToken = runtime.ids.next();
  const enqueued =
    input.retryTaskSequence === undefined
      ? await ensureAcceptedChapterPipelineTask(runtime, input)
      : await loadManualRetryTask(runtime, input);
  assertManualRetryAuthority(input, enqueued);

  if (
    !enqueued.created &&
    !isRunnable(enqueued.task.status, enqueued.task.runAfter, runtime.clock.now())
  ) {
    return notRunReceipt(enqueued.task.id, input);
  }

  const stableTaskId = enqueued.task.id;
  const retryScope = inspectPipelineStageFailureCauseCode(
    input.retryFailureCauseCode ??
      (enqueued.task.failure?.causeCode === ACCEPTED_CHAPTER_FACT_PREFLIGHT_FAILURE_CAUSE_CODE
        ? null
        : enqueued.task.failure?.causeCode) ??
      null,
  );
  if (retryScope.kind === "malformed") {
    throw new Error("Accepted chapter pipeline task has a malformed failure stage scope.");
  }
  if (
    retryScope.kind === "valid" &&
    [...retryScope.stages, ...retryScope.notApplicableStages, ...retryScope.deferredStages].some(
      (stage) => isLocalPipelineStage(stage) && !enabledStages.has(stage),
    )
  ) {
    throw new Error("Accepted chapter pipeline failure scope exceeds the task's enabled stages.");
  }
  const retryStages =
    retryScope.kind === "valid"
      ? new Set([...retryScope.stages].filter((stageName) => enabledStages.has(stageName)))
      : null;
  const shouldRun = (pipelineStage: AcceptedChapterPipelineStage, enabled = true): boolean =>
    enabled && (retryStages === null || retryStages.has(pipelineStage));
  const leaseExpiresAt = new Date(Date.parse(runtime.clock.now()) + 15 * 60 * 1_000).toISOString();
  await runtime.taskCenter.startTask(
    stableTaskId,
    "desktop.accepted-version",
    leaseToken,
    leaseExpiresAt,
  );

  let search = notRunStage();
  let chapterSummary = notRunStage();
  let storyState = notRunStage();
  let causalProjection = notRunStage();
  let chapterSummaryStatus: ChapterSummaryGenerationReceipt["status"] | null = null;
  let storyStateMetrics: AcceptedChapterPipelineReceipt["storyStateMetrics"] = null;

  if (shouldRun("search", input.runSearch !== false)) {
    try {
      const rebuilt = await runtime.search.rebuildProject(input.projectId);
      search = rebuilt.ok
        ? stage("completed", "SEARCH_INDEX_REBUILT", "本地搜索索引已更新。")
        : stage("failed", rebuilt.error.code, "本地搜索索引暂未更新，可稍后重试。");
    } catch (cause: unknown) {
      search = failedStage("SEARCH_INDEX_REBUILD_FAILED", cause);
    }
  } else {
    search = skippedStageForDisabledOrPriorAttempt(
      input.runSearch === false,
      "SEARCH_DISABLED_FOR_SUPPLEMENT",
    );
  }
  await reportProgress(runtime.taskCenter, stableTaskId, leaseToken, "search.rebuilt", 1);

  if (!shouldRun("chapter_summary", providerStageEnabled(input, "chapter_summary"))) {
    chapterSummary = stage(
      "skipped",
      input.source === "candidate_accept"
        ? "CHAPTER_SUMMARY_REQUIRES_EXPLICIT_OPT_IN"
        : "CHAPTER_SUMMARY_REQUIRES_SEPARATE_AUTHORIZATION",
      input.source === "candidate_accept"
        ? "接受建议只更新本地正文、版本和本地派生状态；未向模型发送正文。"
        : "正文提交、恢复和后台整理只运行本地派生；章节摘要未向模型发送正文。",
    );
  } else {
    try {
      const receipt = await runtime.story.chapterSummaries.summarizeSavedVersion({
        projectId: input.projectId,
        chapterId: input.chapterId,
        versionId: input.versionId,
        trigger:
          input.source === "manual_save"
            ? "manual_save"
            : input.source === "historical_backfill"
              ? "historical_backfill"
              : "user_rebuild",
      });
      chapterSummaryStatus = receipt.status;
      chapterSummary = fromSummaryReceipt(receipt);
    } catch (cause: unknown) {
      chapterSummary = failedStage("CHAPTER_SUMMARY_UPDATE_FAILED", cause);
    }
  }
  await reportProgress(runtime.taskCenter, stableTaskId, leaseToken, "summary.updated", 2);

  if (!shouldRun("story_state", providerStageEnabled(input, "story_state"))) {
    storyState = stage(
      "skipped",
      input.source === "candidate_accept"
        ? "STORY_STATE_REQUIRES_EXPLICIT_OPT_IN"
        : "STORY_STATE_REQUIRES_SEPARATE_AUTHORIZATION",
      input.source === "candidate_accept"
        ? "接受建议不会自动调用模型提取故事设定；本地搜索与故事关联仍会更新。"
        : "正文提交、恢复和后台整理不会调用模型提取故事设定；本地搜索与故事关联仍会更新。",
    );
  } else {
    try {
      const receipt = await runtime.story.continuousState.extractSavedVersion({
        projectId: input.projectId,
        chapterId: input.chapterId,
        versionId: input.versionId,
      });
      storyStateMetrics = {
        detectedCount: receipt.detectedCount,
        needsConfirmationCount: receipt.needsConfirmationCount,
        reversibleCount: receipt.reversibleCount,
        skippedTaskCount: receipt.skippedTasks.length,
      };
      storyState = fromStoryStateReceipt(receipt);
    } catch (cause: unknown) {
      storyState = failedStoryStateStage(cause);
    }
  }
  await reportProgress(runtime.taskCenter, stableTaskId, leaseToken, "story-state.updated", 3);

  if (shouldRun("causal_projection", input.runCausalProjection !== false)) {
    try {
      const receipt = await runtime.story.causalProjector.rebuildProject(input.projectId, "main");
      causalProjection = fromCausalReceipt(receipt);
    } catch (cause: unknown) {
      causalProjection = failedStage("CAUSAL_PROJECTION_UPDATE_FAILED", cause);
    }
  } else {
    causalProjection = skippedStageForDisabledOrPriorAttempt(
      input.runCausalProjection === false,
      "CAUSAL_PROJECTION_DISABLED_FOR_SUPPLEMENT",
    );
  }
  await reportProgress(runtime.taskCenter, stableTaskId, leaseToken, "causal.projected", 4);

  const receipt = buildReceipt(stableTaskId, input, {
    search,
    chapterSummary,
    storyState,
    causalProjection,
    chapterSummaryStatus,
    storyStateMetrics,
  });
  const failedStages = recoverableFailureStages(input, receipt);
  const hasFailure = failedStages.length > 0;
  const disposition = pipelineStageDispositions(
    input,
    receipt,
    retryStages,
    retryScope.kind === "valid" ? retryScope : null,
  );

  if (hasFailure) {
    await runtime.taskCenter.failTask(
      stableTaskId,
      leaseToken,
      {
        code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
        causeCode: pipelineStageFailureCauseCode(
          failedStages,
          disposition.notApplicableStages,
          disposition.deferredStages,
        ),
        retryable: true,
        actions: ["RETRY", "OPEN_SETTINGS", "EXPORT_DIAGNOSTICS"],
        requestId,
      },
      new Date(Date.parse(runtime.clock.now()) + 5_000).toISOString(),
    );
  } else {
    await reportProgress(
      runtime.taskCenter,
      stableTaskId,
      leaseToken,
      pipelineOutcomeProgressStep(
        disposition.completedStages,
        disposition.notApplicableStages,
        disposition.deferredStages,
      ),
      PIPELINE_STEPS,
    );
    await runtime.taskCenter.completeTask(stableTaskId, leaseToken);
  }

  await publishPipelineNotification(runtime, receipt).catch(() => undefined);
  return receipt;
}

function assertManualRetryInputShape(input: AcceptedChapterPipelineInput): void {
  const hasFailureScope = input.retryFailureCauseCode !== undefined;
  const hasSequence = input.retryTaskSequence !== undefined;
  const hasAttempt = input.retryTaskAttempt !== undefined;
  if (
    hasSequence !== hasAttempt ||
    (hasFailureScope && !hasSequence) ||
    (hasSequence &&
      (!Number.isSafeInteger(input.retryTaskSequence) ||
        (input.retryTaskSequence ?? -1) < 0 ||
        !Number.isSafeInteger(input.retryTaskAttempt) ||
        (input.retryTaskAttempt ?? 0) < 1))
  ) {
    throw new Error("Accepted chapter pipeline manual retry authority is incomplete.");
  }
}

async function loadManualRetryTask(
  runtime: Pick<AcceptedChapterPipelineRuntime, "taskCenter">,
  input: AcceptedChapterPipelineInput,
): Promise<CreateTaskSnapshotResult> {
  const idempotencyKey =
    input.pipelineIdempotencyKey ?? acceptedChapterPipelineIdempotencyKey(input.versionId);
  const task = await runtime.taskCenter.findTaskByIdempotencyKey(idempotencyKey);
  if (task === null) {
    throw new Error("Accepted chapter pipeline manual retry task no longer exists.");
  }
  if (
    task.type !== ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE ||
    task.idempotencyKey !== idempotencyKey ||
    task.metadata.operation !== ACCEPTED_CHAPTER_PIPELINE_OPERATION ||
    task.metadata.projectId !== input.projectId ||
    task.metadata.chapterId !== input.chapterId ||
    task.metadata.versionId !== input.versionId ||
    task.metadata.source !== input.source ||
    task.metadata.acceptedCharacterCount !== input.acceptedCharacterCount ||
    !matchesOrganizeLocalStoryFacts(
      task.metadata.organizeLocalStoryFacts,
      input.organizeLocalStoryFacts,
    ) ||
    task.metadata.runSearch !== input.runSearch ||
    !isLegacyProviderStageFlag(task.metadata.runChapterSummary) ||
    input.runChapterSummary !== false ||
    !isLegacyProviderStageFlag(task.metadata.runStoryState) ||
    input.runStoryState !== false ||
    task.metadata.runCausalProjection !== input.runCausalProjection ||
    task.metadata.pipelineIdempotencyKey !== input.pipelineIdempotencyKey ||
    task.metadata.pipelineStage !== input.pipelineStage ||
    task.metadata.pipelineStageRuleVersion !== input.pipelineStageRuleVersion ||
    task.metadata.pipelineStageGeneration !== input.pipelineStageGeneration
  ) {
    throw new Error("Accepted chapter pipeline manual retry task authority is invalid.");
  }
  return Object.freeze({ task, created: false });
}

function assertManualRetryAuthority(
  input: AcceptedChapterPipelineInput,
  enqueued: CreateTaskSnapshotResult,
): void {
  if (input.retryTaskSequence === undefined) {
    return;
  }
  const retryProgress = inspectPipelineRetryProgressStep(enqueued.task.progress?.step ?? null);
  if (
    enqueued.created ||
    enqueued.task.status !== "queued" ||
    enqueued.task.failure !== null ||
    enqueued.task.sequence !== input.retryTaskSequence ||
    enqueued.task.attempt !== input.retryTaskAttempt ||
    retryProgress.kind !== "valid" ||
    retryProgress.attempt !== input.retryTaskAttempt ||
    normalizeFactPreflightRetryCause(retryProgress.failureCauseCode) !==
      (input.retryFailureCauseCode ?? null)
  ) {
    throw new Error("Accepted chapter pipeline manual retry authority changed before execution.");
  }
}

export function ensureAcceptedChapterPipelineTask(
  runtime: Pick<AcceptedChapterPipelineRuntime, "taskCenter" | "ids" | "clock">,
  input: AcceptedChapterPipelineInput,
): Promise<CreateTaskSnapshotResult> {
  return ensureAcceptedChapterPipelineTaskInternal(runtime, input);
}

async function ensureAcceptedChapterPipelineTaskInternal(
  runtime: Pick<AcceptedChapterPipelineRuntime, "taskCenter" | "ids" | "clock">,
  input: AcceptedChapterPipelineInput,
): Promise<CreateTaskSnapshotResult> {
  if (enabledPipelineStages(input).size === 0) {
    throw new Error("An accepted chapter pipeline task must enable at least one stage.");
  }
  const idempotencyKey =
    input.pipelineIdempotencyKey ?? acceptedChapterPipelineIdempotencyKey(input.versionId);
  const existing = await runtime.taskCenter.findTaskByIdempotencyKey(idempotencyKey);
  if (existing !== null) {
    if (!matchesLocalAcceptedChapterTask(existing, input, idempotencyKey)) {
      throw new Error("The accepted-version local refresh task authority is invalid.");
    }
    return Object.freeze({ task: existing, created: false });
  }
  return runtime.taskCenter.enqueueTask(
    createAcceptedChapterPipelineTaskInput(runtime.ids.next(), runtime.clock.now(), input),
  );
}

function matchesLocalAcceptedChapterTask(
  task: Awaited<ReturnType<TaskCenterStore["findTaskByIdempotencyKey"]>>,
  input: AcceptedChapterPipelineInput,
  idempotencyKey: string,
): boolean {
  if (task === null) return false;
  return (
    task.type === ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE &&
    task.idempotencyKey === idempotencyKey &&
    task.metadata.operation === ACCEPTED_CHAPTER_PIPELINE_OPERATION &&
    task.metadata.projectId === input.projectId &&
    task.metadata.chapterId === input.chapterId &&
    task.metadata.versionId === input.versionId &&
    task.metadata.source === input.source &&
    task.metadata.acceptedCharacterCount === input.acceptedCharacterCount &&
    matchesOrganizeLocalStoryFacts(
      task.metadata.organizeLocalStoryFacts,
      input.organizeLocalStoryFacts,
    ) &&
    (task.metadata.runSearch !== false) === (input.runSearch !== false) &&
    (task.metadata.runCausalProjection !== false) === (input.runCausalProjection !== false) &&
    isLegacyProviderStageFlag(task.metadata.runChapterSummary) &&
    isLegacyProviderStageFlag(task.metadata.runStoryState) &&
    task.metadata.pipelineIdempotencyKey === input.pipelineIdempotencyKey &&
    task.metadata.pipelineStage === input.pipelineStage &&
    task.metadata.pipelineStageRuleVersion === input.pipelineStageRuleVersion &&
    task.metadata.pipelineStageGeneration === input.pipelineStageGeneration
  );
}

/**
 * Builds the canonical durable task request for one immutable accepted version.
 * SQLite Candidate commits use this same builder inside their transaction, so
 * the foreground ensure call can only deduplicate the exact same request.
 */
export function createAcceptedChapterPipelineTaskInput(
  taskId: string,
  now: string,
  input: AcceptedChapterPipelineInput,
): CreateTaskInput {
  return {
    id: taskId,
    type: ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE,
    idempotencyKey:
      input.pipelineIdempotencyKey ?? acceptedChapterPipelineIdempotencyKey(input.versionId),
    metadata: {
      projectId: input.projectId,
      chapterId: input.chapterId,
      versionId: input.versionId,
      source: input.source,
      acceptedCharacterCount: input.acceptedCharacterCount,
      organizeLocalStoryFacts: input.organizeLocalStoryFacts === true,
      runChapterSummary: false,
      runStoryState: false,
      ...(input.runSearch === undefined ? {} : { runSearch: input.runSearch }),
      ...(input.runCausalProjection === undefined
        ? {}
        : { runCausalProjection: input.runCausalProjection }),
      ...(input.pipelineIdempotencyKey === undefined
        ? {}
        : { pipelineIdempotencyKey: input.pipelineIdempotencyKey }),
      ...(input.pipelineStage === undefined ? {} : { pipelineStage: input.pipelineStage }),
      ...(input.pipelineStageRuleVersion === undefined
        ? {}
        : { pipelineStageRuleVersion: input.pipelineStageRuleVersion }),
      ...(input.pipelineStageGeneration === undefined
        ? {}
        : { pipelineStageGeneration: input.pipelineStageGeneration }),
      operation: ACCEPTED_CHAPTER_PIPELINE_OPERATION,
    },
    priority: 75,
    maxAttempts: 3,
    now,
  };
}

export function acceptedChapterPipelineIdempotencyKey(versionId: string): string {
  return `story.accepted-version:${versionId}`;
}

export function acceptedChapterPipelineStageIdempotencyKey(
  versionId: string,
  pipelineStage: AcceptedChapterPipelineStage,
  generation: number,
): string {
  const stageKey = PIPELINE_STAGE_CODE[pipelineStage].toLowerCase();
  return `story.accepted-version:${versionId}:backfill:v${String(ACCEPTED_CHAPTER_PIPELINE_STAGE_RULE_VERSION)}:${stageKey}:${String(generation)}`;
}

export function pipelineStageFailureCauseCode(
  stages: readonly AcceptedChapterPipelineStage[],
  notApplicableStages: readonly AcceptedChapterPipelineStage[] = [],
  deferredStages: readonly AcceptedChapterPipelineStage[] = [],
): string {
  const failed = canonicalOutcomeStages(stages);
  const notApplicable = canonicalOutcomeStages(notApplicableStages);
  const deferred = canonicalOutcomeStages(deferredStages);
  const allStages = [...failed, ...notApplicable, ...deferred];
  if (failed.length === 0 || new Set(allStages).size !== allStages.length) {
    throw new Error("A pipeline failure mask must contain unique, disjoint stage dispositions.");
  }
  if (notApplicable.length > 0 || deferred.length > 0) {
    return `PIPELINE_V2_F_${compactStageCodes(failed)}${
      notApplicable.length === 0 ? "" : `_N_${compactStageCodes(notApplicable)}`
    }${deferred.length === 0 ? "" : `_D_${compactStageCodes(deferred)}`}`;
  }
  return `PIPELINE_STAGES_${failed.map((stageName) => PIPELINE_STAGE_CODE[stageName]).join("_")}`;
}

export type PipelineStageScopeInspection =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{
      kind: "valid";
      stages: ReadonlySet<AcceptedChapterPipelineStage>;
      notApplicableStages: ReadonlySet<AcceptedChapterPipelineStage>;
      deferredStages: ReadonlySet<AcceptedChapterPipelineStage>;
      dispositionEvidence: boolean;
    }>;

export function inspectPipelineStageFailureCauseCode(
  causeCode: string | null,
): PipelineStageScopeInspection {
  if (causeCode?.startsWith("PIPELINE_V2")) {
    const match = /^PIPELINE_V2_F_([RSTC]+)(?:_N_([RSTC]+))?(?:_D_([RSTC]+))?$/u.exec(causeCode);
    if (match === null) return Object.freeze({ kind: "malformed" });
    const failedCodes = match[1];
    if (failedCodes === undefined) return Object.freeze({ kind: "malformed" });
    const failed = parseCompactStageCodes(failedCodes);
    const notApplicable =
      match[2] === undefined
        ? new Set<AcceptedChapterPipelineStage>()
        : parseCompactStageCodes(match[2]);
    const deferred =
      match[3] === undefined
        ? new Set<AcceptedChapterPipelineStage>()
        : parseCompactStageCodes(match[3]);
    if (
      failed === null ||
      notApplicable === null ||
      deferred === null ||
      pipelineStageFailureCauseCode([...failed], [...notApplicable], [...deferred]) !== causeCode
    ) {
      return Object.freeze({ kind: "malformed" });
    }
    return Object.freeze({
      kind: "valid",
      stages: failed,
      notApplicableStages: notApplicable,
      deferredStages: deferred,
      dispositionEvidence: true,
    });
  }
  if (!causeCode?.startsWith("PIPELINE_STAGES")) {
    return Object.freeze({ kind: "absent" });
  }
  if (!causeCode.startsWith("PIPELINE_STAGES_")) {
    return Object.freeze({ kind: "malformed" });
  }
  const parsed = parseCanonicalStageCodes(causeCode.slice("PIPELINE_STAGES_".length), "upper");
  if (parsed === null || pipelineStageFailureCauseCode([...parsed]) !== causeCode) {
    return Object.freeze({ kind: "malformed" });
  }
  return Object.freeze({
    kind: "valid",
    stages: parsed,
    notApplicableStages: new Set<AcceptedChapterPipelineStage>(),
    deferredStages: new Set<AcceptedChapterPipelineStage>(),
    dispositionEvidence: false,
  });
}

export function failedPipelineStages(
  causeCode: string | null,
): ReadonlySet<AcceptedChapterPipelineStage> | null {
  const inspected = inspectPipelineStageFailureCauseCode(causeCode);
  return inspected.kind === "valid" ? inspected.stages : null;
}

export type PipelineRetryProgressInspection =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{ kind: "valid"; attempt: number; failureCauseCode: string | null }>;

export function pipelineRetryProgressStep(attempt: number, causeCode: string | null): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) {
    throw new Error("A pipeline retry marker requires a valid task attempt.");
  }
  const inspected = inspectPipelineStageFailureCauseCode(causeCode);
  if (inspected.kind === "malformed") {
    throw new Error("A pipeline retry marker cannot persist a malformed failure scope.");
  }
  const prefix = `pipeline.retry.v2.a${String(attempt)}.`;
  if (inspected.kind === "absent") {
    return `${prefix}full`;
  }
  if (!inspected.dispositionEvidence) {
    return `${prefix}l-${compactStageCodes([...inspected.stages]).toLowerCase()}`;
  }
  return `${prefix}f-${compactStageCodes([...inspected.stages]).toLowerCase()}${
    inspected.notApplicableStages.size === 0
      ? ""
      : `.n-${compactStageCodes([...inspected.notApplicableStages]).toLowerCase()}`
  }${
    inspected.deferredStages.size === 0
      ? ""
      : `.d-${compactStageCodes([...inspected.deferredStages]).toLowerCase()}`
  }`;
}

export function inspectPipelineRetryProgressStep(
  step: string | null,
): PipelineRetryProgressInspection {
  if (!step?.startsWith("pipeline.retry")) {
    return Object.freeze({ kind: "absent" });
  }
  const match =
    /^pipeline\.retry\.v2\.a([1-9][0-9]{0,2})\.(full|l-([rstc]+)|f-([rstc]+)(?:\.n-([rstc]+))?(?:\.d-([rstc]+))?)$/u.exec(
      step,
    );
  if (match === null) {
    return Object.freeze({ kind: "malformed" });
  }
  const attemptValue = match[1];
  if (attemptValue === undefined) {
    return Object.freeze({ kind: "malformed" });
  }
  const attempt = Number(attemptValue);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) {
    return Object.freeze({ kind: "malformed" });
  }
  let failureCauseCode: string | null = null;
  try {
    if (match[2] !== "full") {
      const legacy = match[3];
      const failed = parseRetryCompactStageCodes(legacy ?? match[4] ?? "");
      const notApplicable = parseRetryCompactStageCodes(match[5] ?? "", true);
      const deferred = parseRetryCompactStageCodes(match[6] ?? "", true);
      if (failed === null || notApplicable === null || deferred === null) {
        return Object.freeze({ kind: "malformed" });
      }
      failureCauseCode =
        legacy === undefined
          ? pipelineStageFailureCauseCode([...failed], [...notApplicable], [...deferred])
          : pipelineStageFailureCauseCode([...failed]);
    }
  } catch {
    return Object.freeze({ kind: "malformed" });
  }
  if (pipelineRetryProgressStep(attempt, failureCauseCode) !== step) {
    return Object.freeze({ kind: "malformed" });
  }
  return Object.freeze({ kind: "valid", attempt, failureCauseCode });
}

export type PipelineOutcomeInspection =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "malformed" }>
  | Readonly<{
      kind: "valid";
      stages: ReadonlySet<AcceptedChapterPipelineStage>;
      notApplicableStages: ReadonlySet<AcceptedChapterPipelineStage>;
      deferredStages: ReadonlySet<AcceptedChapterPipelineStage>;
    }>;

export function pipelineOutcomeProgressStep(
  stages: readonly AcceptedChapterPipelineStage[],
  notApplicableStages: readonly AcceptedChapterPipelineStage[] = [],
  deferredStages: readonly AcceptedChapterPipelineStage[] = [],
): string {
  const completed = canonicalOutcomeStages(stages);
  const notApplicable = canonicalOutcomeStages(notApplicableStages);
  const deferred = canonicalOutcomeStages(deferredStages);
  const allStages = [...completed, ...notApplicable, ...deferred];
  if (allStages.length === 0 || new Set(allStages).size !== allStages.length) {
    throw new Error("A pipeline outcome must contain unique, disjoint stage dispositions.");
  }
  if (notApplicable.length === 0 && deferred.length === 0) {
    return `pipeline.outcome.${completed
      .map((stageName) => PIPELINE_STAGE_CODE[stageName].toLowerCase())
      .join("-")}`;
  }
  const dispositionByStage = new Map<AcceptedChapterPipelineStage, "c" | "n" | "d">([
    ...completed.map((stageName) => [stageName, "c"] as const),
    ...notApplicable.map((stageName) => [stageName, "n"] as const),
    ...deferred.map((stageName) => [stageName, "d"] as const),
  ]);
  return `pipeline.outcome.v2.${ACCEPTED_CHAPTER_PIPELINE_STAGES.filter((stageName) =>
    dispositionByStage.has(stageName),
  )
    .map(
      (stageName) =>
        `${PIPELINE_STAGE_CODE[stageName].toLowerCase()}-${String(dispositionByStage.get(stageName))}`,
    )
    .join(".")}`;
}

export function inspectPipelineOutcomeProgressStep(step: string | null): PipelineOutcomeInspection {
  if (!step?.startsWith("pipeline.outcome")) {
    return Object.freeze({ kind: "absent" });
  }
  if (step.startsWith("pipeline.outcome.v2.")) {
    const parsed = parsePipelineOutcomeV2(step.slice("pipeline.outcome.v2.".length));
    if (
      parsed === null ||
      pipelineOutcomeProgressStep(
        [...parsed.stages],
        [...parsed.notApplicableStages],
        [...parsed.deferredStages],
      ) !== step
    ) {
      return Object.freeze({ kind: "malformed" });
    }
    return Object.freeze({ kind: "valid", ...parsed });
  }
  if (!step.startsWith("pipeline.outcome.")) {
    return Object.freeze({ kind: "malformed" });
  }
  const parsed = parseCanonicalStageCodes(step.slice("pipeline.outcome.".length), "lower");
  if (parsed === null || pipelineOutcomeProgressStep([...parsed]) !== step) {
    return Object.freeze({ kind: "malformed" });
  }
  return Object.freeze({
    kind: "valid",
    stages: parsed,
    notApplicableStages: new Set<AcceptedChapterPipelineStage>(),
    deferredStages: new Set<AcceptedChapterPipelineStage>(),
  });
}

const PIPELINE_STAGE_CODE: Readonly<Record<AcceptedChapterPipelineStage, string>> = Object.freeze({
  search: "SEARCH",
  chapter_summary: "SUMMARY",
  story_state: "STATE",
  causal_projection: "CAUSAL",
});
const PIPELINE_STAGE_COMPACT_CODE: Readonly<Record<AcceptedChapterPipelineStage, string>> =
  Object.freeze({ search: "R", chapter_summary: "S", story_state: "T", causal_projection: "C" });

function compactStageCodes(stages: readonly AcceptedChapterPipelineStage[]): string {
  return stages.map((stageName) => PIPELINE_STAGE_COMPACT_CODE[stageName]).join("");
}

function parseCompactStageCodes(value: string): ReadonlySet<AcceptedChapterPipelineStage> | null {
  const stages: AcceptedChapterPipelineStage[] = [];
  for (const token of value) {
    const stage = ACCEPTED_CHAPTER_PIPELINE_STAGES.find(
      (candidate) => PIPELINE_STAGE_COMPACT_CODE[candidate] === token,
    );
    if (stage === undefined || stages.includes(stage)) return null;
    stages.push(stage);
  }
  const canonical = ACCEPTED_CHAPTER_PIPELINE_STAGES.filter((stage) => stages.includes(stage));
  return canonical.length === stages.length ? new Set(canonical) : null;
}

function parseRetryCompactStageCodes(
  value: string,
  allowEmpty = false,
): ReadonlySet<AcceptedChapterPipelineStage> | null {
  if (value.length === 0) {
    return allowEmpty ? new Set<AcceptedChapterPipelineStage>() : null;
  }
  return parseCompactStageCodes(value.toUpperCase());
}

function canonicalOutcomeStages(
  stages: readonly AcceptedChapterPipelineStage[],
): readonly AcceptedChapterPipelineStage[] {
  const ordered = ACCEPTED_CHAPTER_PIPELINE_STAGES.filter((stageName) =>
    stages.includes(stageName),
  );
  if (ordered.length !== stages.length || new Set(stages).size !== stages.length) {
    throw new Error("A pipeline outcome must contain only unique known stages.");
  }
  return ordered;
}

function parsePipelineOutcomeV2(value: string): Readonly<{
  stages: ReadonlySet<AcceptedChapterPipelineStage>;
  notApplicableStages: ReadonlySet<AcceptedChapterPipelineStage>;
  deferredStages: ReadonlySet<AcceptedChapterPipelineStage>;
}> | null {
  const tokens = value.split(".");
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return null;
  }
  const completed: AcceptedChapterPipelineStage[] = [];
  const notApplicable: AcceptedChapterPipelineStage[] = [];
  const deferred: AcceptedChapterPipelineStage[] = [];
  const seen = new Set<AcceptedChapterPipelineStage>();
  for (const token of tokens) {
    const match = /^([a-z]+)-(c|n|d)$/u.exec(token);
    if (match === null) {
      return null;
    }
    const stage = ACCEPTED_CHAPTER_PIPELINE_STAGES.find(
      (candidate) => PIPELINE_STAGE_CODE[candidate].toLowerCase() === match[1],
    );
    if (stage === undefined || seen.has(stage)) {
      return null;
    }
    seen.add(stage);
    if (match[2] === "c") completed.push(stage);
    else if (match[2] === "n") notApplicable.push(stage);
    else deferred.push(stage);
  }
  return Object.freeze({
    stages: new Set(completed),
    notApplicableStages: new Set(notApplicable),
    deferredStages: new Set(deferred),
  });
}

function parseCanonicalStageCodes(
  value: string,
  casing: "upper" | "lower",
): ReadonlySet<AcceptedChapterPipelineStage> | null {
  const separator = casing === "upper" ? "_" : "-";
  const tokens = value.split(separator);
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    return null;
  }
  const stages: AcceptedChapterPipelineStage[] = [];
  for (const token of tokens) {
    const stage = ACCEPTED_CHAPTER_PIPELINE_STAGES.find(
      (candidate) =>
        (casing === "upper"
          ? PIPELINE_STAGE_CODE[candidate]
          : PIPELINE_STAGE_CODE[candidate].toLowerCase()) === token,
    );
    if (stage === undefined || stages.includes(stage)) {
      return null;
    }
    stages.push(stage);
  }
  const canonical = ACCEPTED_CHAPTER_PIPELINE_STAGES.filter((stage) => stages.includes(stage));
  return canonical.length === stages.length ? new Set(canonical) : null;
}

function isRunnable(status: string, runAfter: string | null, now: string): boolean {
  return (
    status === "queued" ||
    (status === "waiting_retry" && runAfter !== null && Date.parse(runAfter) <= Date.parse(now))
  );
}

async function reportProgress(
  taskCenter: TaskCenterStore,
  taskId: string,
  leaseToken: string,
  step: string,
  completedUnits: number,
): Promise<void> {
  await taskCenter
    .reportTaskProgress(taskId, leaseToken, step, completedUnits, PIPELINE_STEPS)
    .catch(() => undefined);
}

function fromSummaryReceipt(
  receipt: ChapterSummaryGenerationReceipt,
): AcceptedChapterPipelineStageReceipt {
  if (receipt.status === "generated" || receipt.status === "already_current") {
    return stage("completed", receipt.code, receipt.message);
  }
  if (
    receipt.code === "CHAPTER_SUMMARY_EMPTY_CHAPTER" ||
    receipt.code === "CHAPTER_SUMMARY_SOURCE_TOO_LARGE" ||
    receipt.code === "CHAPTER_SUMMARY_SOURCE_NOT_CURRENT" ||
    receipt.code === "CHAPTER_SUMMARY_PRIVACY_CHANGED"
  ) {
    return stage("not_applicable", receipt.code, receipt.message);
  }
  if (receipt.code === "CHAPTER_SUMMARY_AUTOMATION_PAUSED") {
    return stage("deferred", receipt.code, receipt.message);
  }
  if (receipt.status === "failed") {
    return stage("failed", receipt.code, receipt.message);
  }
  return stage("skipped", receipt.code, receipt.message);
}

function fromStoryStateReceipt(
  receipt: ContinuousStoryStateExtractionReceipt,
): AcceptedChapterPipelineStageReceipt {
  if (receipt.status === "completed" || receipt.status === "already_processed") {
    return stage(
      "completed",
      receipt.status === "already_processed"
        ? "STORY_STATE_ALREADY_PROCESSED"
        : "STORY_STATE_UPDATED",
      receipt.status === "already_processed"
        ? "这个版本的故事设定已经处理过。"
        : "故事设定候选已从当前版本更新。",
    );
  }
  if (receipt.status === "partially_completed") {
    return stage(
      "partially_completed",
      "STORY_STATE_PARTIALLY_UPDATED",
      "部分故事设定候选已更新，其余能力当前不可用。",
    );
  }
  if (
    receipt.skippedTasks.length > 0 &&
    receipt.skippedTasks.every(({ code }) => code === "EMPTY_CHAPTER")
  ) {
    return stage(
      "not_applicable",
      "STORY_STATE_EMPTY_CHAPTER",
      "The empty chapter has no story state to extract.",
    );
  }
  return stage(
    "skipped",
    "STORY_STATE_PROVIDER_UNAVAILABLE",
    "尚未连接可用模型，正文已保留，故事设定提取已跳过。",
  );
}

function failedStoryStateStage(cause: unknown): AcceptedChapterPipelineStageReceipt {
  const reasonCode = storyStateFailureReasonCode(cause);
  if (reasonCode === "STORY_STATE_VERSION_NOT_FOUND") {
    return stage(
      "not_applicable",
      reasonCode,
      cause instanceof Error ? cause.message : "The saved version no longer exists.",
    );
  }
  if (
    reasonCode === "STORY_STATE_SOURCE_NOT_CURRENT" ||
    reasonCode === "STORY_STATE_SOURCE_CHANGED"
  ) {
    return stage(
      "not_applicable",
      reasonCode,
      cause instanceof Error ? cause.message : "The source changed before story-state extraction.",
    );
  }
  return failedStage("STORY_STATE_UPDATE_FAILED", cause);
}

function storyStateFailureReasonCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("details" in cause)) {
    return null;
  }
  const details = (cause as Readonly<{ details?: unknown }>).details;
  if (typeof details !== "object" || details === null || !("reasonCode" in details)) {
    return null;
  }
  const reasonCode = (details as Readonly<{ reasonCode?: unknown }>).reasonCode;
  return typeof reasonCode === "string" ? reasonCode : null;
}

function fromCausalReceipt(
  receipt: CausalStoryFactProjectionReceipt,
): AcceptedChapterPipelineStageReceipt {
  return stage(
    "completed",
    "CAUSAL_PROJECTION_REBUILT",
    `故事关联已重建：${String(receipt.eventCount)} 个事件，${String(receipt.relationCount)} 条关系。`,
  );
}

function failedStage(code: string, cause: unknown): AcceptedChapterPipelineStageReceipt {
  return stage(
    "failed",
    code,
    cause instanceof Error ? cause.message : "后台更新失败，可在任务中心重试。",
  );
}

function stage(
  status: AcceptedChapterPipelineStageStatus,
  code: string,
  message: string,
): AcceptedChapterPipelineStageReceipt {
  return { status, code, message };
}

function notRunStage(): AcceptedChapterPipelineStageReceipt {
  return stage("not_run", "NOT_RUN", "尚未执行。");
}

function skippedStageForDisabledOrPriorAttempt(
  explicitlyDisabled: boolean,
  disabledCode: string,
): AcceptedChapterPipelineStageReceipt {
  return stage(
    "skipped",
    explicitlyDisabled ? disabledCode : "PIPELINE_STAGE_COMPLETED_IN_PRIOR_ATTEMPT",
    explicitlyDisabled
      ? "This stage is outside the scope of the supplemental task."
      : "This stage already completed in an earlier attempt and was not repeated.",
  );
}

function enabledPipelineStages(
  input: AcceptedChapterPipelineInput,
): ReadonlySet<AcceptedChapterPipelineStage> {
  return new Set(
    ACCEPTED_CHAPTER_PIPELINE_STAGES.filter((stageName) => {
      switch (stageName) {
        case "search":
          return input.runSearch !== false;
        case "chapter_summary":
          return providerStageEnabled(input, "chapter_summary");
        case "story_state":
          return providerStageEnabled(input, "story_state");
        case "causal_projection":
          return input.runCausalProjection !== false;
      }
    }),
  );
}

function providerStageEnabled(
  input: AcceptedChapterPipelineInput,
  stageName: "chapter_summary" | "story_state",
): boolean {
  void input;
  void stageName;
  return false;
}

function isLocalPipelineStage(stage: AcceptedChapterPipelineStage): boolean {
  return stage === "search" || stage === "causal_projection";
}

function normalizeFactPreflightRetryCause(causeCode: string | null): string | null {
  return causeCode === ACCEPTED_CHAPTER_FACT_PREFLIGHT_FAILURE_CAUSE_CODE ? null : causeCode;
}

function matchesOrganizeLocalStoryFacts(
  persisted: unknown,
  requested: boolean | undefined,
): boolean {
  return (
    (persisted === true && requested === true) ||
    ((persisted === false || persisted === undefined) && requested !== true)
  );
}

function isLegacyProviderStageFlag(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function pipelineStageDispositions(
  input: AcceptedChapterPipelineInput,
  receipt: AcceptedChapterPipelineReceipt,
  retryStages: ReadonlySet<AcceptedChapterPipelineStage> | null,
  retryDisposition: Extract<PipelineStageScopeInspection, { kind: "valid" }> | null,
): Readonly<{
  completedStages: readonly AcceptedChapterPipelineStage[];
  notApplicableStages: readonly AcceptedChapterPipelineStage[];
  deferredStages: readonly AcceptedChapterPipelineStage[];
}> {
  const receipts: Readonly<
    Record<AcceptedChapterPipelineStage, AcceptedChapterPipelineStageReceipt>
  > = {
    search: receipt.search,
    chapter_summary: receipt.chapterSummary,
    story_state: receipt.storyState,
    causal_projection: receipt.causalProjection,
  };
  const enabled = enabledPipelineStages(input);
  const completedStages = ACCEPTED_CHAPTER_PIPELINE_STAGES.filter(
    (stageName) =>
      enabled.has(stageName) &&
      (receipts[stageName].status === "completed" ||
        (retryStages !== null && !retryStages.has(stageName))),
  );
  const notApplicableStages = ACCEPTED_CHAPTER_PIPELINE_STAGES.filter(
    (stageName) =>
      enabled.has(stageName) &&
      (receipts[stageName].status === "not_applicable" ||
        (retryStages !== null &&
          !retryStages.has(stageName) &&
          retryDisposition?.notApplicableStages.has(stageName) === true)),
  );
  const deferredStages = ACCEPTED_CHAPTER_PIPELINE_STAGES.filter(
    (stageName) =>
      enabled.has(stageName) &&
      (receipts[stageName].status === "deferred" ||
        (retryStages !== null &&
          !retryStages.has(stageName) &&
          retryDisposition?.deferredStages.has(stageName) === true)),
  );
  const terminalStages = new Set([...notApplicableStages, ...deferredStages]);
  return Object.freeze({
    completedStages: Object.freeze(completedStages.filter((stage) => !terminalStages.has(stage))),
    notApplicableStages: Object.freeze(notApplicableStages),
    deferredStages: Object.freeze(deferredStages),
  });
}

function recoverableFailureStages(
  input: AcceptedChapterPipelineInput,
  receipt: AcceptedChapterPipelineReceipt,
): readonly AcceptedChapterPipelineStage[] {
  const stages: AcceptedChapterPipelineStage[] = [];
  const addIfFailed = (
    stageName: AcceptedChapterPipelineStage,
    stageReceipt: AcceptedChapterPipelineStageReceipt,
    requested: boolean,
    modelStage = false,
  ): void => {
    if (
      requested &&
      (stageReceipt.status === "failed" ||
        stageReceipt.status === "partially_completed" ||
        (modelStage &&
          stageReceipt.status === "skipped" &&
          !stageReceipt.code.endsWith("_COMPLETED_IN_PRIOR_ATTEMPT")))
    ) {
      stages.push(stageName);
    }
  };
  addIfFailed("search", receipt.search, input.runSearch !== false);
  addIfFailed(
    "chapter_summary",
    receipt.chapterSummary,
    providerStageEnabled(input, "chapter_summary"),
    true,
  );
  addIfFailed("story_state", receipt.storyState, providerStageEnabled(input, "story_state"), true);
  addIfFailed("causal_projection", receipt.causalProjection, input.runCausalProjection !== false);
  return Object.freeze(stages);
}

function buildReceipt(
  taskId: string,
  input: AcceptedChapterPipelineInput,
  stages: Readonly<{
    search: AcceptedChapterPipelineStageReceipt;
    chapterSummary: AcceptedChapterPipelineStageReceipt;
    storyState: AcceptedChapterPipelineStageReceipt;
    causalProjection: AcceptedChapterPipelineStageReceipt;
    chapterSummaryStatus: ChapterSummaryGenerationReceipt["status"] | null;
    storyStateMetrics: AcceptedChapterPipelineReceipt["storyStateMetrics"];
  }>,
): AcceptedChapterPipelineReceipt {
  const values = [
    ...(input.runSearch === false ? [] : [stages.search]),
    ...(providerStageEnabled(input, "chapter_summary") ? [stages.chapterSummary] : []),
    ...(providerStageEnabled(input, "story_state") ? [stages.storyState] : []),
    ...(input.runCausalProjection === false ? [] : [stages.causalProjection]),
  ];
  const requestedModelStageIncomplete =
    (providerStageEnabled(input, "chapter_summary") &&
      stages.chapterSummary.status === "skipped" &&
      !stages.chapterSummary.code.endsWith("_COMPLETED_IN_PRIOR_ATTEMPT")) ||
    (providerStageEnabled(input, "story_state") &&
      stages.storyState.status === "skipped" &&
      !stages.storyState.code.endsWith("_COMPLETED_IN_PRIOR_ATTEMPT"));
  const status =
    values.some(({ status: value }) => value === "failed" || value === "partially_completed") ||
    requestedModelStageIncomplete
      ? "partially_completed"
      : values.some(
            ({ status: value }) =>
              value === "skipped" || value === "not_applicable" || value === "deferred",
          )
        ? "completed_with_skips"
        : "completed";
  return {
    status,
    taskId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    versionId: input.versionId,
    ...stages,
  };
}

function notRunReceipt(
  taskId: string,
  input: AcceptedChapterPipelineInput,
): AcceptedChapterPipelineReceipt {
  return {
    status: "already_scheduled",
    taskId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    versionId: input.versionId,
    search: notRunStage(),
    chapterSummary: notRunStage(),
    storyState: notRunStage(),
    causalProjection: notRunStage(),
    chapterSummaryStatus: null,
    storyStateMetrics: null,
  };
}

async function publishPipelineNotification(
  runtime: AcceptedChapterPipelineRuntime,
  receipt: AcceptedChapterPipelineReceipt,
): Promise<void> {
  const failureCodes = [
    receipt.search,
    receipt.chapterSummary,
    receipt.storyState,
    receipt.causalProjection,
  ]
    .filter(({ status }) => status === "failed")
    .map(({ code }) => code);
  await runtime.taskCenter.publishNotification({
    id: runtime.ids.next(),
    dedupeKey: `notification:${receipt.taskId}:${receipt.status}`,
    messageKey: `story.accepted-version.${receipt.status}`,
    level: "inbox",
    severity:
      receipt.status === "completed"
        ? "success"
        : receipt.status === "partially_completed"
          ? "warning"
          : "info",
    route: { entityType: "task", entityId: receipt.taskId },
    metadata: {
      taskType: ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE,
      projectId: receipt.projectId,
      chapterId: receipt.chapterId,
      versionId: receipt.versionId,
      pipelineStatus: receipt.status,
      failureCodes,
      ...(receipt.storyStateMetrics === null
        ? {}
        : {
            detectedCount: receipt.storyStateMetrics.detectedCount,
            needsConfirmationCount: receipt.storyStateMetrics.needsConfirmationCount,
          }),
    },
    requiresResolution: false,
    expiresAt: null,
    now: runtime.clock.now(),
  });
}
