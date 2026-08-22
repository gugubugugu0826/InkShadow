import type {
  ChapterRepository,
  ChapterVersionRepository,
  ContentHasher,
} from "@inkshadow/application";
import { parseUuidV7, type Clock, type UuidV7, type UuidV7Generator } from "@inkshadow/domain";
import type { TaskSnapshot } from "@inkshadow/task-engine";

import {
  ACCEPTED_CHAPTER_PIPELINE_OPERATION,
  ACCEPTED_CHAPTER_PIPELINE_MAXIMUM_STAGE_GENERATION,
  ACCEPTED_CHAPTER_PIPELINE_STAGE_RULE_VERSION,
  ACCEPTED_CHAPTER_PIPELINE_STAGES,
  ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE,
  acceptedChapterPipelineIdempotencyKey,
  acceptedChapterPipelineStageIdempotencyKey,
  ensureAcceptedChapterPipelineTask,
  inspectPipelineOutcomeProgressStep,
  inspectPipelineStageFailureCauseCode,
  type AcceptedChapterPipelineInput,
  type AcceptedChapterPipelineStage,
} from "./accepted-chapter-pipeline";
import type { BrowserChapterSummaryPreferenceStore } from "./chapter-summary-service";
import type { TaskCenterStore } from "./task-center-store";

export const HISTORICAL_CHAPTER_BACKFILL_PLAN_SCHEMA =
  "inkshadow.historical-chapter-backfill-plan.v2" as const;

export interface HistoricalChapterBackfillPlan {
  readonly schemaVersion: typeof HISTORICAL_CHAPTER_BACKFILL_PLAN_SCHEMA;
  readonly projectId: string;
  readonly fingerprint: string;
  readonly activeChapterCount: number;
  readonly eligibleChapterCount: number;
  /** Chapters whose currently required stages are complete or durably scheduled. */
  readonly registeredChapterCount: number;
  /** Unique chapters that need one or more task registrations. */
  readonly willRegisterChapterCount: number;
  /** Actual durable tasks that will be registered; one chapter can need several stages. */
  readonly willRegisterTaskCount: number;
  readonly missingStages: Readonly<{
    readonly search: number;
    readonly chapterSummary: number;
    readonly storyState: number;
    readonly causalProjection: number;
    readonly total: number;
  }>;
  readonly eligibleCharacterCount: number;
  readonly willRegisterCharacterCount: number;
  readonly localOnlyChapterCount: number;
  readonly willRegisterLocalOnlyChapterCount: number;
  readonly excludedEmptyChapterCount: number;
  readonly excludedUnstableChapterCount: number;
  readonly modelStages: Readonly<{
    readonly chapterSummaryEnabled: boolean;
    readonly storyStateEnabled: boolean;
  }>;
  readonly possibleRemoteProviderCallUpperBound: Readonly<{
    readonly chapterSummary: number;
    readonly storyState: number;
    readonly total: number;
  }>;
  /**
   * Selection boundary, not an atomic chapter lock. Every registration is
   * revalidated immediately before enqueue; stage execution independently
   * rejects an old version if the chapter changes in the remaining write gap.
   */
  readonly boundary: "current_stable_versions_only";
}

export interface RegisterHistoricalChapterBackfillInput {
  readonly projectId: string;
  readonly expectedPlanFingerprint: string;
  readonly humanConfirmed: boolean;
}

export interface HistoricalChapterBackfillRegistrationFailure {
  readonly chapterId: string;
  readonly versionId: string;
  readonly stage: AcceptedChapterPipelineStage | "base";
  readonly code: "HISTORICAL_BACKFILL_REGISTRATION_FAILED" | "HISTORICAL_BACKFILL_PLAN_STALE";
  readonly message: string;
}

export interface HistoricalChapterBackfillRegistrationReceipt {
  readonly status: "completed" | "partial" | "stale";
  readonly projectId: string;
  readonly planFingerprint: string;
  readonly attemptedTaskCount: number;
  readonly registeredTaskCount: number;
  readonly createdTaskCount: number;
  readonly alreadyRegisteredTaskCount: number;
  readonly failedTaskCount: number;
  /** Failed and not-yet-attempted tasks remain visible instead of being reported as registered. */
  readonly remainingTaskCount: number;
  readonly failures: readonly HistoricalChapterBackfillRegistrationFailure[];
  readonly modelStages: HistoricalChapterBackfillPlan["modelStages"];
  /** See HistoricalChapterBackfillPlan.boundary for the execution fence. */
  readonly boundary: "current_stable_versions_only";
}

export class HistoricalChapterBackfillError extends Error {
  public constructor(
    readonly code:
      | "HISTORICAL_BACKFILL_PROJECT_INVALID"
      | "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE"
      | "HISTORICAL_BACKFILL_HASH_UNAVAILABLE"
      | "HISTORICAL_BACKFILL_CONFIRMATION_REQUIRED"
      | "HISTORICAL_BACKFILL_PLAN_STALE"
      | "HISTORICAL_BACKFILL_REGISTRATION_FAILED",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HistoricalChapterBackfillError";
  }
}

interface HistoricalChapterBackfillDependencies {
  readonly chapters: Pick<ChapterRepository, "findById" | "listByProjectId">;
  readonly chapterVersions: Pick<ChapterVersionRepository, "findVersionById">;
  readonly taskCenter: TaskCenterStore;
  readonly preferences: Pick<
    BrowserChapterSummaryPreferenceStore,
    "isAutomaticOnManualSaveEnabled" | "isContinuousStoryStateOnManualSaveEnabled"
  >;
  readonly hasher: ContentHasher;
  readonly ids: Pick<UuidV7Generator, "next">;
  readonly clock: Pick<Clock, "now">;
}

interface StableChapterCandidate {
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly versionId: UuidV7;
  readonly chapterRevision: number;
  readonly privacyRevision: number;
  readonly characterCount: number;
  readonly contentChecksum: string;
  readonly organizeLocalStoryFacts: boolean;
  readonly localOnly: boolean;
  readonly taskAuthority: readonly TaskAuthorityFingerprint[];
  readonly missingStages: readonly AcceptedChapterPipelineStage[];
  readonly pending: readonly BackfillRegistrationItem[];
}

interface TaskAuthorityFingerprint {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly status: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly sequence: number;
  readonly runAfter: string | null;
  readonly failureCode: string | null;
  readonly failureCauseCode: string | null;
  readonly progressStep: string | null;
  readonly organizeLocalStoryFacts: unknown;
  readonly runSearch: unknown;
  readonly runChapterSummary: unknown;
  readonly runStoryState: unknown;
  readonly runCausalProjection: unknown;
  readonly pipelineStage: unknown;
  readonly pipelineStageRuleVersion: unknown;
  readonly pipelineStageGeneration: unknown;
}

interface BackfillRegistrationItem {
  readonly chapterId: UuidV7;
  readonly versionId: UuidV7;
  readonly stage: AcceptedChapterPipelineStage | "base";
  readonly idempotencyKey: string;
  readonly chapterRevision: number;
  readonly privacyRevision: number;
  readonly contentChecksum: string;
  readonly input: AcceptedChapterPipelineInput;
}

interface StableRegistrationChapter {
  readonly projectId: UuidV7;
  readonly chapterId: UuidV7;
  readonly versionId: UuidV7;
  readonly characterCount: number;
  readonly chapterRevision: number;
  readonly privacyRevision: number;
  readonly contentChecksum: string;
  readonly organizeLocalStoryFacts: boolean;
}

interface InternalPlan {
  readonly publicPlan: HistoricalChapterBackfillPlan;
  readonly pending: readonly BackfillRegistrationItem[];
}

/**
 * Plans and registers missing accepted-version stages without executing them.
 * The durable worker remains the sole batch executor and still processes at
 * most five historical tasks per run.
 */
export class HistoricalChapterBackfillService {
  public constructor(private readonly dependencies: HistoricalChapterBackfillDependencies) {}

  public async plan(projectId: string): Promise<HistoricalChapterBackfillPlan> {
    return (await this.buildPlan(projectId)).publicPlan;
  }

  public async register(
    input: RegisterHistoricalChapterBackfillInput,
  ): Promise<HistoricalChapterBackfillRegistrationReceipt> {
    if (!input.humanConfirmed) {
      throw new HistoricalChapterBackfillError(
        "HISTORICAL_BACKFILL_CONFIRMATION_REQUIRED",
        "登记现有章节前，需要明确确认只读计划和可能产生的模型费用。",
      );
    }
    const current = await this.buildPlan(input.projectId);
    if (current.publicPlan.fingerprint !== input.expectedPlanFingerprint) {
      throw new HistoricalChapterBackfillError(
        "HISTORICAL_BACKFILL_PLAN_STALE",
        "章节、任务登记或项目模型开关已经变化，请刷新只读计划后再次确认。",
        true,
      );
    }

    let attemptedTaskCount = 0;
    let createdTaskCount = 0;
    let alreadyRegisteredTaskCount = 0;
    const failures: HistoricalChapterBackfillRegistrationFailure[] = [];
    for (const item of current.pending) {
      attemptedTaskCount += 1;
      try {
        const authority = await this.revalidateRegistrationItem(
          item,
          current.publicPlan.modelStages,
        );
        if (authority === "already_covered") {
          alreadyRegisteredTaskCount += 1;
          continue;
        }
        const result = await ensureAcceptedChapterPipelineTask(
          {
            taskCenter: this.dependencies.taskCenter,
            ids: this.dependencies.ids,
            clock: this.dependencies.clock,
          },
          item.input,
        );
        if (result.created) {
          createdTaskCount += 1;
        } else if (taskMatchesPlannedItem(result.task, item)) {
          alreadyRegisteredTaskCount += 1;
        } else {
          throw new Error("幂等键已被不同的章节后台任务占用。");
        }
      } catch (cause: unknown) {
        const raced = await this.dependencies.taskCenter
          .findTaskByIdempotencyKey(item.idempotencyKey)
          .catch(() => null);
        if (raced !== null && taskMatchesPlannedItem(raced, item)) {
          alreadyRegisteredTaskCount += 1;
          continue;
        }
        failures.push(
          Object.freeze({
            chapterId: item.chapterId,
            versionId: item.versionId,
            stage: item.stage,
            code:
              cause instanceof HistoricalChapterBackfillError &&
              cause.code === "HISTORICAL_BACKFILL_PLAN_STALE"
                ? ("HISTORICAL_BACKFILL_PLAN_STALE" as const)
                : ("HISTORICAL_BACKFILL_REGISTRATION_FAILED" as const),
            message:
              cause instanceof Error
                ? cause.message
                : "现有章节后台任务登记失败；正文没有变化，可以刷新计划后重试。",
          }),
        );
        // A storage failure may affect the remaining items too. Return the
        // exact partial receipt instead of losing registrations already made.
        break;
      }
    }

    const registeredTaskCount = createdTaskCount + alreadyRegisteredTaskCount;
    const remainingTaskCount = current.pending.length - registeredTaskCount;
    const stale = failures.some(({ code }) => code === "HISTORICAL_BACKFILL_PLAN_STALE");
    return Object.freeze({
      status:
        failures.length === 0 && remainingTaskCount === 0
          ? "completed"
          : stale && registeredTaskCount === 0
            ? "stale"
            : "partial",
      projectId: current.publicPlan.projectId,
      planFingerprint: current.publicPlan.fingerprint,
      attemptedTaskCount,
      registeredTaskCount,
      createdTaskCount,
      alreadyRegisteredTaskCount,
      failedTaskCount: failures.length,
      remainingTaskCount,
      failures: Object.freeze(failures),
      modelStages: current.publicPlan.modelStages,
      boundary: "current_stable_versions_only" as const,
    });
  }

  private async revalidateRegistrationItem(
    item: BackfillRegistrationItem,
    modelStages: HistoricalChapterBackfillPlan["modelStages"],
  ): Promise<"proceed" | "already_covered"> {
    const summaryEnabled = false;
    const storyStateEnabled = false;
    if (
      summaryEnabled !== modelStages.chapterSummaryEnabled ||
      storyStateEnabled !== modelStages.storyStateEnabled
    ) {
      staleRegistrationPlan("历史回填计划不是纯本地任务，请刷新只读计划。");
    }

    const chapterResult = await this.dependencies.chapters.findById(item.chapterId);
    if (!chapterResult.ok) {
      throw new HistoricalChapterBackfillError(
        "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
        chapterResult.error.message,
        chapterResult.error.retryable,
      );
    }
    const chapter = chapterResult.value?.toSnapshot();
    if (
      chapter?.status !== "active" ||
      chapter.projectId !== item.input.projectId ||
      chapter.revision !== item.chapterRevision ||
      chapter.privacyRevision !== item.privacyRevision ||
      chapter.currentVersionId !== item.versionId ||
      chapter.content.length !== item.input.acceptedCharacterCount
    ) {
      staleRegistrationPlan("章节版本、正文或隐私设置在登记期间发生变化，请刷新只读计划。");
    }
    const versionResult = await this.dependencies.chapterVersions.findVersionById(item.versionId);
    if (!versionResult.ok) {
      throw new HistoricalChapterBackfillError(
        "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
        versionResult.error.message,
        versionResult.error.retryable,
      );
    }
    const version = versionResult.value?.toSnapshot();
    if (
      version?.projectId !== item.input.projectId ||
      version.chapterId !== item.chapterId ||
      version.content !== chapter.content ||
      version.contentChecksum !== item.contentChecksum ||
      version.organizeLocalStoryFacts !== (item.input.organizeLocalStoryFacts === true)
    ) {
      staleRegistrationPlan("不可变章节版本在登记期间无法继续核验，请刷新只读计划。");
    }
    const hashed = await this.dependencies.hasher.sha256(chapter.content);
    if (!hashed.ok) {
      throw new HistoricalChapterBackfillError(
        "HISTORICAL_BACKFILL_HASH_UNAVAILABLE",
        hashed.error.message,
        hashed.error.retryable,
      );
    }
    if (hashed.value !== item.contentChecksum) {
      staleRegistrationPlan("章节正文校验值在登记期间发生变化，请刷新只读计划。");
    }

    const authority: StableRegistrationChapter = {
      projectId: chapter.projectId,
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      characterCount: chapter.content.length,
      chapterRevision: chapter.revision,
      privacyRevision: chapter.privacyRevision,
      contentChecksum: hashed.value,
      organizeLocalStoryFacts: version.organizeLocalStoryFacts,
    };
    const replanned = await this.planChapterTasks(
      authority,
      requestedPipelineStages(summaryEnabled, storyStateEnabled),
      summaryEnabled,
      storyStateEnabled,
    );
    if (replanned.pending.some((candidate) => plannedItemsEqual(candidate, item))) {
      return "proceed";
    }
    const exact = await this.dependencies.taskCenter.findTaskByIdempotencyKey(item.idempotencyKey);
    if (exact !== null && taskMatchesPlannedItem(exact, item)) {
      return "already_covered";
    }
    if (item.stage !== "base" && !replanned.missingStages.includes(item.stage)) {
      return "already_covered";
    }
    staleRegistrationPlan("后台任务权威在登记期间发生变化，请刷新只读计划。");
  }

  private async buildPlan(projectIdValue: string): Promise<InternalPlan> {
    const projectId = parseUuidV7(projectIdValue);
    if (!projectId.ok) {
      throw new HistoricalChapterBackfillError(
        "HISTORICAL_BACKFILL_PROJECT_INVALID",
        "作品编号无效，无法检查现有章节。",
      );
    }
    const loaded = await this.dependencies.chapters.listByProjectId(projectId.value);
    if (!loaded.ok) {
      throw new HistoricalChapterBackfillError(
        "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
        loaded.error.message,
        loaded.error.retryable,
      );
    }

    // Historical recovery is part of the accepted-version background pipeline
    // and therefore local-only. Legacy preferences never authorize sending an
    // existing chapter to a provider.
    const chapterSummaryEnabled = false;
    const storyStateEnabled = false;
    const requestedStages = requestedPipelineStages(chapterSummaryEnabled, storyStateEnabled);
    const active = loaded.value
      .map((chapter) => chapter.toSnapshot())
      .filter((chapter) => chapter.status === "active")
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    let excludedEmptyChapterCount = 0;
    let excludedUnstableChapterCount = 0;
    const eligible: StableChapterCandidate[] = [];
    for (const chapter of active) {
      if (chapter.content.trim().length === 0) {
        excludedEmptyChapterCount += 1;
        continue;
      }
      const version = await this.dependencies.chapterVersions.findVersionById(
        chapter.currentVersionId,
      );
      if (!version.ok) {
        throw new HistoricalChapterBackfillError(
          "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
          version.error.message,
          version.error.retryable,
        );
      }
      const versionSnapshot = version.value?.toSnapshot();
      if (
        versionSnapshot?.id !== chapter.currentVersionId ||
        versionSnapshot.projectId !== chapter.projectId ||
        versionSnapshot.chapterId !== chapter.id ||
        versionSnapshot.content !== chapter.content
      ) {
        excludedUnstableChapterCount += 1;
        continue;
      }
      const contentHash = await this.dependencies.hasher.sha256(versionSnapshot.content);
      if (!contentHash.ok) {
        throw new HistoricalChapterBackfillError(
          "HISTORICAL_BACKFILL_HASH_UNAVAILABLE",
          contentHash.error.message,
          contentHash.error.retryable,
        );
      }
      const reread = await this.dependencies.chapters.findById(chapter.id);
      if (!reread.ok) {
        throw new HistoricalChapterBackfillError(
          "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
          reread.error.message,
          reread.error.retryable,
        );
      }
      const stable = reread.value?.toSnapshot();
      if (
        contentHash.value !== versionSnapshot.contentChecksum ||
        stable?.status !== "active" ||
        stable.revision !== chapter.revision ||
        stable.privacyRevision !== chapter.privacyRevision ||
        stable.currentVersionId !== chapter.currentVersionId ||
        stable.content !== chapter.content
      ) {
        excludedUnstableChapterCount += 1;
        continue;
      }

      const taskPlan = await this.planChapterTasks(
        {
          projectId: chapter.projectId,
          chapterId: chapter.id,
          versionId: chapter.currentVersionId,
          characterCount: chapter.content.length,
          chapterRevision: chapter.revision,
          privacyRevision: chapter.privacyRevision,
          contentChecksum: contentHash.value,
          organizeLocalStoryFacts: versionSnapshot.organizeLocalStoryFacts,
        },
        requestedStages,
        chapterSummaryEnabled,
        storyStateEnabled,
      );
      eligible.push(
        Object.freeze({
          projectId: chapter.projectId,
          chapterId: chapter.id,
          versionId: chapter.currentVersionId,
          chapterRevision: chapter.revision,
          privacyRevision: chapter.privacyRevision,
          characterCount: chapter.content.length,
          contentChecksum: contentHash.value,
          organizeLocalStoryFacts: versionSnapshot.organizeLocalStoryFacts,
          localOnly: chapter.privacyMode === "local_only",
          taskAuthority: taskPlan.taskAuthority,
          missingStages: taskPlan.missingStages,
          pending: taskPlan.pending,
        }),
      );
    }

    const pendingChapters = eligible.filter((chapter) => chapter.pending.length > 0);
    const pending = pendingChapters.flatMap((chapter) => chapter.pending);
    const missingStages = missingStageCounts(eligible);
    const providerCalls = possibleProviderCalls(pendingChapters);
    const fingerprint = await this.fingerprint({
      projectId: projectId.value,
      eligible,
      chapterSummaryEnabled,
      storyStateEnabled,
    });
    const publicPlan: HistoricalChapterBackfillPlan = Object.freeze({
      schemaVersion: HISTORICAL_CHAPTER_BACKFILL_PLAN_SCHEMA,
      projectId: projectId.value,
      fingerprint,
      activeChapterCount: active.length,
      eligibleChapterCount: eligible.length,
      registeredChapterCount: eligible.length - pendingChapters.length,
      willRegisterChapterCount: pendingChapters.length,
      willRegisterTaskCount: pending.length,
      missingStages,
      eligibleCharacterCount: eligible.reduce(
        (total, chapter) => total + chapter.characterCount,
        0,
      ),
      willRegisterCharacterCount: pendingChapters.reduce(
        (total, chapter) => total + chapter.characterCount,
        0,
      ),
      localOnlyChapterCount: eligible.filter(({ localOnly }) => localOnly).length,
      willRegisterLocalOnlyChapterCount: pendingChapters.filter(({ localOnly }) => localOnly)
        .length,
      excludedEmptyChapterCount,
      excludedUnstableChapterCount,
      modelStages: Object.freeze({ chapterSummaryEnabled, storyStateEnabled }),
      possibleRemoteProviderCallUpperBound: providerCalls,
      boundary: "current_stable_versions_only",
    });
    return Object.freeze({ publicPlan, pending: Object.freeze(pending) });
  }

  private async planChapterTasks(
    chapter: StableRegistrationChapter,
    requestedStages: readonly AcceptedChapterPipelineStage[],
    chapterSummaryEnabled: boolean,
    storyStateEnabled: boolean,
  ): Promise<
    Readonly<{
      taskAuthority: readonly TaskAuthorityFingerprint[];
      missingStages: readonly AcceptedChapterPipelineStage[];
      pending: readonly BackfillRegistrationItem[];
    }>
  > {
    const taskAuthority: TaskAuthorityFingerprint[] = [];
    const baseKey = acceptedChapterPipelineIdempotencyKey(chapter.versionId);
    const baseTask = await this.dependencies.taskCenter.findTaskByIdempotencyKey(baseKey);
    if (baseTask === null) {
      return Object.freeze({
        taskAuthority: Object.freeze(taskAuthority),
        missingStages: Object.freeze([...requestedStages]),
        pending: Object.freeze([
          baseRegistrationItem(chapter, chapterSummaryEnabled, storyStateEnabled),
        ]),
      });
    }
    assertTaskChapterAuthority(baseTask, chapter, baseKey);
    assertBaseTaskAuthority(baseTask, chapter.versionId);
    taskAuthority.push(taskAuthorityFingerprint(baseTask));

    const missingStages: AcceptedChapterPipelineStage[] = [];
    const pending: BackfillRegistrationItem[] = [];
    for (const stage of requestedStages) {
      if (taskCoversStage(baseTask, stage)) {
        continue;
      }
      const supplement = await this.inspectStageSupplements(chapter, stage);
      taskAuthority.push(...supplement.taskAuthority);
      if (!supplement.covered) {
        missingStages.push(stage);
        pending.push(stageRegistrationItem(chapter, stage, supplement.nextGeneration));
      }
    }
    return Object.freeze({
      taskAuthority: Object.freeze(taskAuthority),
      missingStages: Object.freeze(missingStages),
      pending: Object.freeze(pending),
    });
  }

  private async inspectStageSupplements(
    chapter: StableRegistrationChapter,
    stage: AcceptedChapterPipelineStage,
  ): Promise<
    Readonly<{
      covered: boolean;
      nextGeneration: number;
      taskAuthority: readonly TaskAuthorityFingerprint[];
    }>
  > {
    const taskAuthority: TaskAuthorityFingerprint[] = [];
    let covered = false;
    for (
      let generation = 1;
      generation <= ACCEPTED_CHAPTER_PIPELINE_MAXIMUM_STAGE_GENERATION;
      generation += 1
    ) {
      const key = acceptedChapterPipelineStageIdempotencyKey(chapter.versionId, stage, generation);
      const task = await this.dependencies.taskCenter.findTaskByIdempotencyKey(key);
      if (task === null) {
        return Object.freeze({
          covered,
          nextGeneration: generation,
          taskAuthority: Object.freeze(taskAuthority),
        });
      }
      assertSupplementAuthority(task, chapter, stage, generation, key);
      taskAuthority.push(taskAuthorityFingerprint(task));
      covered = covered || taskCoversStage(task, stage);
    }
    throw new HistoricalChapterBackfillError(
      "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
      "同一章节阶段的恢复代数超过安全上限，已停止登记以避免覆盖错误任务。",
    );
  }

  private async fingerprint(
    input: Readonly<{
      projectId: string;
      eligible: readonly StableChapterCandidate[];
      chapterSummaryEnabled: boolean;
      storyStateEnabled: boolean;
    }>,
  ): Promise<string> {
    const value = JSON.stringify({
      schemaVersion: HISTORICAL_CHAPTER_BACKFILL_PLAN_SCHEMA,
      stageRuleVersion: ACCEPTED_CHAPTER_PIPELINE_STAGE_RULE_VERSION,
      projectId: input.projectId,
      chapterSummaryEnabled: input.chapterSummaryEnabled,
      storyStateEnabled: input.storyStateEnabled,
      chapters: input.eligible.map((chapter) => ({
        chapterId: chapter.chapterId,
        versionId: chapter.versionId,
        chapterRevision: chapter.chapterRevision,
        privacyRevision: chapter.privacyRevision,
        characterCount: chapter.characterCount,
        contentChecksum: chapter.contentChecksum,
        organizeLocalStoryFacts: chapter.organizeLocalStoryFacts,
        localOnly: chapter.localOnly,
        missingStages: chapter.missingStages,
        pending: chapter.pending.map((item) => ({
          stage: item.stage,
          idempotencyKey: item.idempotencyKey,
        })),
        taskAuthority: chapter.taskAuthority,
      })),
    });
    const hashed = await this.dependencies.hasher.sha256(value);
    if (!hashed.ok) {
      throw new HistoricalChapterBackfillError(
        "HISTORICAL_BACKFILL_HASH_UNAVAILABLE",
        hashed.error.message,
        hashed.error.retryable,
      );
    }
    return `sha256:${hashed.value}`;
  }
}

function requestedPipelineStages(
  chapterSummaryEnabled: boolean,
  storyStateEnabled: boolean,
): readonly AcceptedChapterPipelineStage[] {
  return ACCEPTED_CHAPTER_PIPELINE_STAGES.filter(
    (stage) =>
      (stage !== "chapter_summary" || chapterSummaryEnabled) &&
      (stage !== "story_state" || storyStateEnabled),
  );
}

function baseRegistrationItem(
  chapter: StableRegistrationChapter,
  chapterSummaryEnabled: boolean,
  storyStateEnabled: boolean,
): BackfillRegistrationItem {
  const input: AcceptedChapterPipelineInput = {
    projectId: chapter.projectId,
    chapterId: chapter.chapterId,
    versionId: chapter.versionId,
    source: "historical_backfill",
    acceptedCharacterCount: chapter.characterCount,
    organizeLocalStoryFacts: chapter.organizeLocalStoryFacts,
    runSearch: true,
    runChapterSummary: chapterSummaryEnabled,
    runStoryState: storyStateEnabled,
    runCausalProjection: true,
  };
  return Object.freeze({
    chapterId: chapter.chapterId,
    versionId: chapter.versionId,
    stage: "base",
    idempotencyKey: acceptedChapterPipelineIdempotencyKey(chapter.versionId),
    chapterRevision: chapter.chapterRevision,
    privacyRevision: chapter.privacyRevision,
    contentChecksum: chapter.contentChecksum,
    input: Object.freeze(input),
  });
}

function stageRegistrationItem(
  chapter: StableRegistrationChapter,
  stage: AcceptedChapterPipelineStage,
  generation: number,
): BackfillRegistrationItem {
  const idempotencyKey = acceptedChapterPipelineStageIdempotencyKey(
    chapter.versionId,
    stage,
    generation,
  );
  const input: AcceptedChapterPipelineInput = {
    projectId: chapter.projectId,
    chapterId: chapter.chapterId,
    versionId: chapter.versionId,
    source: "historical_backfill",
    acceptedCharacterCount: chapter.characterCount,
    organizeLocalStoryFacts: chapter.organizeLocalStoryFacts,
    runSearch: stage === "search",
    runChapterSummary: stage === "chapter_summary",
    runStoryState: stage === "story_state",
    runCausalProjection: stage === "causal_projection",
    pipelineIdempotencyKey: idempotencyKey,
    pipelineStage: stage,
    pipelineStageRuleVersion: ACCEPTED_CHAPTER_PIPELINE_STAGE_RULE_VERSION,
    pipelineStageGeneration: generation,
  };
  return Object.freeze({
    chapterId: chapter.chapterId,
    versionId: chapter.versionId,
    stage,
    idempotencyKey,
    chapterRevision: chapter.chapterRevision,
    privacyRevision: chapter.privacyRevision,
    contentChecksum: chapter.contentChecksum,
    input: Object.freeze(input),
  });
}

function taskCoversStage(task: TaskSnapshot, stage: AcceptedChapterPipelineStage): boolean {
  if (!taskIncludesStage(task, stage)) {
    return false;
  }
  if (task.status === "succeeded") {
    const outcome = inspectPipelineOutcomeProgressStep(task.progress?.step ?? null);
    if (outcome.kind === "malformed") {
      invalidTaskAuthority("后台任务的阶段结果证据格式无效，已停止回填。");
    }
    if (outcome.kind === "valid") {
      assertStageSubset(task, outcome.stages, "阶段结果证据");
      assertStageSubset(task, outcome.notApplicableStages, "not-applicable stage evidence");
      assertStageSubset(task, outcome.deferredStages, "deferred stage evidence");
      return outcome.stages.has(stage) || outcome.notApplicableStages.has(stage);
    }
    // Released tasks predate durable outcome evidence. Their local search and
    // causal success can be inferred from the old success contract, but model
    // stages are conservatively treated as missing because a skip also used to
    // end in succeeded.
    return stage === "search" || stage === "causal_projection";
  }
  if (task.status === "queued" || task.status === "running" || task.status === "paused") {
    return true;
  }
  if (task.status === "waiting_retry") {
    validateFailureScope(task);
    return true;
  }
  if (task.status !== "failed") {
    return false;
  }
  const failure = validateFailureScope(task);
  if (failure === null) return false;
  if (failure.dispositionEvidence && failure.deferredStages.has(stage)) return false;
  return !failure.stages.has(stage);
}

function taskIncludesStage(task: TaskSnapshot, stage: AcceptedChapterPipelineStage): boolean {
  const metadataKey = {
    search: "runSearch",
    chapter_summary: "runChapterSummary",
    story_state: "runStoryState",
    causal_projection: "runCausalProjection",
  }[stage] as "runSearch" | "runChapterSummary" | "runStoryState" | "runCausalProjection";
  const value = task.metadata[metadataKey];
  if (value !== undefined && typeof value !== "boolean") {
    invalidTaskAuthority("后台任务的阶段开关格式无效，已停止回填。");
  }
  return value !== false;
}

function taskAuthorityFingerprint(task: TaskSnapshot): TaskAuthorityFingerprint {
  return Object.freeze({
    id: task.id,
    idempotencyKey: task.idempotencyKey,
    status: task.status,
    attempt: task.attempt,
    maxAttempts: task.maxAttempts,
    sequence: task.sequence,
    runAfter: task.runAfter,
    failureCode: task.failure?.code ?? null,
    failureCauseCode: task.failure?.causeCode ?? null,
    progressStep: task.progress?.step ?? null,
    organizeLocalStoryFacts: task.metadata.organizeLocalStoryFacts ?? null,
    runSearch: task.metadata.runSearch ?? null,
    runChapterSummary: task.metadata.runChapterSummary ?? null,
    runStoryState: task.metadata.runStoryState ?? null,
    runCausalProjection: task.metadata.runCausalProjection ?? null,
    pipelineStage: task.metadata.pipelineStage ?? null,
    pipelineStageRuleVersion: task.metadata.pipelineStageRuleVersion ?? null,
    pipelineStageGeneration: task.metadata.pipelineStageGeneration ?? null,
  });
}

function assertTaskChapterAuthority(
  task: TaskSnapshot,
  chapter: Readonly<{
    projectId: UuidV7;
    chapterId: UuidV7;
    versionId: UuidV7;
    organizeLocalStoryFacts: boolean;
  }>,
  idempotencyKey: string,
): void {
  if (
    task.type !== ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE ||
    task.idempotencyKey !== idempotencyKey ||
    task.metadata.operation !== ACCEPTED_CHAPTER_PIPELINE_OPERATION ||
    task.metadata.projectId !== chapter.projectId ||
    task.metadata.chapterId !== chapter.chapterId ||
    task.metadata.versionId !== chapter.versionId ||
    !isAcceptedPipelineSource(task.metadata.source) ||
    typeof task.metadata.acceptedCharacterCount !== "number" ||
    !Number.isSafeInteger(task.metadata.acceptedCharacterCount) ||
    task.metadata.acceptedCharacterCount < 0 ||
    (task.metadata.organizeLocalStoryFacts !== undefined &&
      typeof task.metadata.organizeLocalStoryFacts !== "boolean") ||
    (task.metadata.organizeLocalStoryFacts === true) !== chapter.organizeLocalStoryFacts
  ) {
    throw new HistoricalChapterBackfillError(
      "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
      "已有后台任务的版本标识与章节不一致，已停止回填以避免错误处理正文。",
    );
  }
  for (const stage of ACCEPTED_CHAPTER_PIPELINE_STAGES) {
    taskIncludesStage(task, stage);
  }
  validateFailureScope(task);
  const outcome = inspectPipelineOutcomeProgressStep(task.progress?.step ?? null);
  if (outcome.kind === "malformed") {
    invalidTaskAuthority("后台任务的阶段结果证据格式无效，已停止回填。");
  }
  if (outcome.kind === "valid") {
    assertStageSubset(task, outcome.stages, "阶段结果证据");
    assertStageSubset(task, outcome.notApplicableStages, "not-applicable stage evidence");
    assertStageSubset(task, outcome.deferredStages, "deferred stage evidence");
  }
}

function assertBaseTaskAuthority(task: TaskSnapshot, versionId: string): void {
  if (
    task.idempotencyKey !== acceptedChapterPipelineIdempotencyKey(versionId) ||
    task.metadata.pipelineIdempotencyKey !== undefined ||
    task.metadata.pipelineStage !== undefined ||
    task.metadata.pipelineStageRuleVersion !== undefined ||
    task.metadata.pipelineStageGeneration !== undefined
  ) {
    invalidTaskAuthority("版本任务混入了阶段补充范围，已停止回填。");
  }
}

function assertSupplementAuthority(
  task: TaskSnapshot,
  chapter: Readonly<{
    projectId: UuidV7;
    chapterId: UuidV7;
    versionId: UuidV7;
    organizeLocalStoryFacts: boolean;
  }>,
  stage: AcceptedChapterPipelineStage,
  generation: number,
  idempotencyKey: string,
): void {
  assertTaskChapterAuthority(task, chapter, idempotencyKey);
  if (
    task.metadata.source !== "historical_backfill" ||
    task.metadata.pipelineIdempotencyKey !== idempotencyKey ||
    task.metadata.pipelineStage !== stage ||
    task.metadata.pipelineStageRuleVersion !== ACCEPTED_CHAPTER_PIPELINE_STAGE_RULE_VERSION ||
    task.metadata.pipelineStageGeneration !== generation ||
    !isOneHotTaskStage(task, stage)
  ) {
    throw new HistoricalChapterBackfillError(
      "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
      "阶段恢复任务的规则版本或代数不一致，已停止登记以避免重复执行。",
    );
  }
}

function validateFailureScope(
  task: TaskSnapshot,
): Extract<ReturnType<typeof inspectPipelineStageFailureCauseCode>, { kind: "valid" }> | null {
  const inspected = inspectPipelineStageFailureCauseCode(task.failure?.causeCode ?? null);
  if (inspected.kind === "malformed") {
    invalidTaskAuthority("后台任务的失败阶段掩码无效，已停止回填。");
  }
  if (inspected.kind === "valid") {
    assertStageSubset(task, inspected.stages, "失败阶段掩码");
    assertStageSubset(task, inspected.notApplicableStages, "not-applicable failure evidence");
    assertStageSubset(task, inspected.deferredStages, "deferred failure evidence");
    return inspected;
  }
  return null;
}

function assertStageSubset(
  task: TaskSnapshot,
  stages: ReadonlySet<AcceptedChapterPipelineStage>,
  label: string,
): void {
  if ([...stages].some((stage) => !taskIncludesStage(task, stage))) {
    invalidTaskAuthority(`${label}超出了任务启用阶段，已停止回填。`);
  }
}

function isOneHotTaskStage(task: TaskSnapshot, selected: AcceptedChapterPipelineStage): boolean {
  return ACCEPTED_CHAPTER_PIPELINE_STAGES.every(
    (stage) =>
      (task.metadata[
        {
          search: "runSearch",
          chapter_summary: "runChapterSummary",
          story_state: "runStoryState",
          causal_projection: "runCausalProjection",
        }[stage]
      ] ===
        true) ===
      (stage === selected),
  );
}

function isAcceptedPipelineSource(value: unknown): boolean {
  return (
    value === "candidate_accept" ||
    value === "chapter_import" ||
    value === "autosave" ||
    value === "manual_save" ||
    value === "recovery_save" ||
    value === "version_restore" ||
    value === "historical_backfill"
  );
}

function invalidTaskAuthority(message: string): never {
  throw new HistoricalChapterBackfillError("HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE", message);
}

function matchesPersistedStoryFactResponsibility(value: unknown, expected: unknown): boolean {
  return (
    (value === undefined || typeof value === "boolean") && (value === true) === (expected === true)
  );
}

function taskMatchesPlannedItem(task: TaskSnapshot, item: BackfillRegistrationItem): boolean {
  if (
    task.type !== ACCEPTED_CHAPTER_PIPELINE_TASK_TYPE ||
    task.idempotencyKey !== item.idempotencyKey ||
    task.metadata.operation !== ACCEPTED_CHAPTER_PIPELINE_OPERATION ||
    task.metadata.projectId !== item.input.projectId ||
    task.metadata.chapterId !== item.input.chapterId ||
    task.metadata.versionId !== item.input.versionId ||
    task.metadata.source !== item.input.source ||
    task.metadata.acceptedCharacterCount !== item.input.acceptedCharacterCount ||
    !matchesPersistedStoryFactResponsibility(
      task.metadata.organizeLocalStoryFacts,
      item.input.organizeLocalStoryFacts,
    )
  ) {
    return false;
  }
  return (
    task.metadata.runSearch === item.input.runSearch &&
    task.metadata.runChapterSummary === item.input.runChapterSummary &&
    task.metadata.runStoryState === item.input.runStoryState &&
    task.metadata.runCausalProjection === item.input.runCausalProjection &&
    task.metadata.pipelineIdempotencyKey === item.input.pipelineIdempotencyKey &&
    task.metadata.pipelineStage === item.input.pipelineStage &&
    task.metadata.pipelineStageRuleVersion === item.input.pipelineStageRuleVersion &&
    task.metadata.pipelineStageGeneration === item.input.pipelineStageGeneration
  );
}

function plannedItemsEqual(
  left: BackfillRegistrationItem,
  right: BackfillRegistrationItem,
): boolean {
  return (
    left.idempotencyKey === right.idempotencyKey &&
    left.stage === right.stage &&
    left.chapterId === right.chapterId &&
    left.versionId === right.versionId &&
    left.chapterRevision === right.chapterRevision &&
    left.privacyRevision === right.privacyRevision &&
    left.contentChecksum === right.contentChecksum &&
    left.input.projectId === right.input.projectId &&
    left.input.acceptedCharacterCount === right.input.acceptedCharacterCount &&
    (left.input.organizeLocalStoryFacts === true) ===
      (right.input.organizeLocalStoryFacts === true) &&
    left.input.runSearch === right.input.runSearch &&
    left.input.runChapterSummary === right.input.runChapterSummary &&
    left.input.runStoryState === right.input.runStoryState &&
    left.input.runCausalProjection === right.input.runCausalProjection &&
    left.input.pipelineIdempotencyKey === right.input.pipelineIdempotencyKey &&
    left.input.pipelineStage === right.input.pipelineStage &&
    left.input.pipelineStageRuleVersion === right.input.pipelineStageRuleVersion &&
    left.input.pipelineStageGeneration === right.input.pipelineStageGeneration
  );
}

function staleRegistrationPlan(message: string): never {
  throw new HistoricalChapterBackfillError("HISTORICAL_BACKFILL_PLAN_STALE", message, true);
}

function missingStageCounts(
  eligible: readonly StableChapterCandidate[],
): HistoricalChapterBackfillPlan["missingStages"] {
  const count = (stage: AcceptedChapterPipelineStage): number =>
    eligible.filter((chapter) => chapter.missingStages.includes(stage)).length;
  const search = count("search");
  const chapterSummary = count("chapter_summary");
  const storyState = count("story_state");
  const causalProjection = count("causal_projection");
  return Object.freeze({
    search,
    chapterSummary,
    storyState,
    causalProjection,
    total: search + chapterSummary + storyState + causalProjection,
  });
}

function possibleProviderCalls(
  pendingChapters: readonly StableChapterCandidate[],
): HistoricalChapterBackfillPlan["possibleRemoteProviderCallUpperBound"] {
  let chapterSummary = 0;
  let storyState = 0;
  for (const chapter of pendingChapters) {
    if (chapter.localOnly) {
      continue;
    }
    for (const item of chapter.pending) {
      if (item.input.runChapterSummary === true) {
        chapterSummary += 1;
      }
      if (item.input.runStoryState === true) {
        storyState += 2;
      }
    }
  }
  return Object.freeze({
    chapterSummary,
    storyState,
    total: chapterSummary + storyState,
  });
}
