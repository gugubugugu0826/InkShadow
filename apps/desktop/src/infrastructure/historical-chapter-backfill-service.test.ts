import { StoryFact } from "@inkshadow/story-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptedChapterPipelineIdempotencyKey,
  acceptedChapterPipelineStageIdempotencyKey,
  ensureAcceptedChapterPipelineTask,
  pipelineOutcomeProgressStep,
  pipelineStageFailureCauseCode,
  runAcceptedChapterPipeline,
} from "./accepted-chapter-pipeline";
import { CAUSAL_EVENT_FACT_SCHEMA } from "./causal-story-fact-projector";
import type { HistoricalChapterBackfillError } from "./historical-chapter-backfill-service";
import { createDevelopmentRuntime, type DesktopRuntime } from "./runtime";

describe("HistoricalChapterBackfillService", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("previews without writes and registers only missing current-version tasks after confirmation", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "旧稿派生资料回填");
    const publicContent = "第一章的公开正文，用于核验当前不可变版本。";
    const privateContent = "第二章是只留在本机的私密正文。";
    const publicChapter = await createChapter(runtime, project.id, "第一章", publicContent);
    const privateChapter = await createChapter(
      runtime,
      project.id,
      "第二章",
      privateContent,
      "local_only",
    );
    await createChapter(runtime, project.id, "空白章", "   ");

    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    runtime.story.continuousState.setAutomaticOnManualSaveEnabled(project.id, true);
    await ensureAcceptedChapterPipelineTask(runtime, {
      projectId: publicChapter.projectId,
      chapterId: publicChapter.id,
      versionId: publicChapter.currentVersionId,
      source: "manual_save",
      acceptedCharacterCount: publicContent.length,
      runChapterSummary: true,
      runStoryState: true,
    });

    const service = runtime.story.historicalBackfill;
    const taskCountBeforePlan = (await runtime.taskCenter.load()).tasks.length;
    const plan = await service.plan(project.id);

    expect(plan).toMatchObject({
      activeChapterCount: 3,
      eligibleChapterCount: 2,
      registeredChapterCount: 1,
      willRegisterChapterCount: 1,
      eligibleCharacterCount: publicContent.length + privateContent.length,
      willRegisterCharacterCount: privateContent.length,
      localOnlyChapterCount: 1,
      willRegisterLocalOnlyChapterCount: 1,
      excludedEmptyChapterCount: 1,
      excludedUnstableChapterCount: 0,
      modelStages: { chapterSummaryEnabled: false, storyStateEnabled: false },
      possibleRemoteProviderCallUpperBound: { chapterSummary: 0, storyState: 0, total: 0 },
      boundary: "current_stable_versions_only",
    });
    expect((await runtime.taskCenter.load()).tasks).toHaveLength(taskCountBeforePlan);

    await expect(
      service.register({
        projectId: project.id,
        expectedPlanFingerprint: plan.fingerprint,
        humanConfirmed: false,
      }),
    ).rejects.toMatchObject({
      code: "HISTORICAL_BACKFILL_CONFIRMATION_REQUIRED",
    } satisfies Partial<HistoricalChapterBackfillError>);

    const receipt = await service.register({
      projectId: project.id,
      expectedPlanFingerprint: plan.fingerprint,
      humanConfirmed: true,
    });
    expect(receipt).toMatchObject({
      createdTaskCount: 1,
      alreadyRegisteredTaskCount: 0,
      boundary: "current_stable_versions_only",
    });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineIdempotencyKey(publicChapter.currentVersionId),
      ),
    ).resolves.toMatchObject({
      metadata: {
        projectId: project.id,
        chapterId: publicChapter.id,
        versionId: publicChapter.currentVersionId,
        source: "manual_save",
        runChapterSummary: false,
        runStoryState: false,
      },
    });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineIdempotencyKey(privateChapter.currentVersionId),
      ),
    ).resolves.toMatchObject({
      metadata: {
        projectId: project.id,
        chapterId: privateChapter.id,
        versionId: privateChapter.currentVersionId,
        source: "historical_backfill",
        runChapterSummary: false,
        runStoryState: false,
      },
    });

    const completedPlan = await service.plan(project.id);
    expect(completedPlan).toMatchObject({
      registeredChapterCount: 2,
      willRegisterChapterCount: 0,
      willRegisterCharacterCount: 0,
      possibleRemoteProviderCallUpperBound: { chapterSummary: 0, storyState: 0, total: 0 },
    });
    await expect(
      service.register({
        projectId: project.id,
        expectedPlanFingerprint: completedPlan.fingerprint,
        humanConfirmed: true,
      }),
    ).resolves.toMatchObject({ createdTaskCount: 0, alreadyRegisteredTaskCount: 0 });
  });

  it("invalidates a stale plan and backfills only the latest stable version, not prior history", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "只补当前版本");
    const initial = await createChapter(
      runtime,
      project.id,
      "第一章",
      "最初保存的正文。",
      "standard",
    );
    const initialVersionId = initial.currentVersionId;
    const service = runtime.story.historicalBackfill;
    const stalePlan = await service.plan(project.id);

    const edited = await runtime.useCases.editChapter.execute({
      chapterId: initial.id,
      expectedRevision: initial.revision,
      content: "作者后来确认并保存的新正文。",
      cursorOffset: 14,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId: initial.id,
      expectedRevision: initial.revision,
      reason: "manual",
    });
    if (!saved.ok || saved.value.version === null) {
      throw new Error("Expected a new immutable chapter version.");
    }

    await expect(
      service.register({
        projectId: project.id,
        expectedPlanFingerprint: stalePlan.fingerprint,
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "HISTORICAL_BACKFILL_PLAN_STALE" });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineIdempotencyKey(initialVersionId),
      ),
    ).resolves.toBeNull();

    const currentPlan = await service.plan(project.id);
    const receipt = await service.register({
      projectId: project.id,
      expectedPlanFingerprint: currentPlan.fingerprint,
      humanConfirmed: true,
    });
    expect(receipt.createdTaskCount).toBe(1);
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineIdempotencyKey(saved.value.version.id),
      ),
    ).resolves.toMatchObject({
      metadata: {
        versionId: saved.value.version.id,
        source: "historical_backfill",
      },
    });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineIdempotencyKey(initialVersionId),
      ),
    ).resolves.toBeNull();
  });

  it("treats legacy ordinary local success as covering the local backfill", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "旧成功不冒充模型完成证据");
    const chapter = await createChapter(
      runtime,
      project.id,
      "第一章",
      "旧任务对应的稳定正文。",
      "standard",
    );
    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    runtime.story.continuousState.setAutomaticOnManualSaveEnabled(project.id, true);
    await ensureAcceptedChapterPipelineTask(runtime, {
      projectId: chapter.projectId,
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      source: "candidate_accept",
      acceptedCharacterCount: chapter.content.length,
    });
    await completeTaskByKey(
      runtime,
      acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      650,
    );

    await expect(runtime.story.historicalBackfill.plan(project.id)).resolves.toMatchObject({
      registeredChapterCount: 1,
      willRegisterChapterCount: 0,
      willRegisterTaskCount: 0,
      missingStages: {
        search: 0,
        chapterSummary: 0,
        storyState: 0,
        causalProjection: 0,
        total: 0,
      },
    });
  });

  it("accepts a canonical persisted outcome as proof that successful stages are complete", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "规范结果证据避免重复");
    const chapter = await createChapter(
      runtime,
      project.id,
      "第一章",
      "具有阶段结果证据的正文。",
      "standard",
    );
    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    runtime.story.continuousState.setAutomaticOnManualSaveEnabled(project.id, true);
    await ensureAcceptedChapterPipelineTask(runtime, {
      projectId: chapter.projectId,
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      source: "historical_backfill",
      acceptedCharacterCount: chapter.content.length,
    });
    await completeTaskByKey(
      runtime,
      acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      675,
      ["search", "causal_projection"],
    );

    await expect(runtime.story.historicalBackfill.plan(project.id)).resolves.toMatchObject({
      registeredChapterCount: 1,
      willRegisterChapterCount: 0,
      willRegisterTaskCount: 0,
      missingStages: { total: 0 },
    });
  });

  it("treats a persisted local not-applicable stage as terminal for the bound version", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "Terminal not-applicable stage");
    const chapter = await createChapter(
      runtime,
      project.id,
      "Chapter one",
      "Stable accepted text whose summary is permanently inapplicable.",
    );
    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    await ensureAcceptedChapterPipelineTask(runtime, {
      projectId: chapter.projectId,
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      source: "historical_backfill",
      acceptedCharacterCount: chapter.content.length,
      runChapterSummary: false,
      runStoryState: false,
    });
    await completeTaskByKey(
      runtime,
      acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      680,
      ["search"],
      ["causal_projection"],
    );

    await expect(runtime.story.historicalBackfill.plan(project.id)).resolves.toMatchObject({
      registeredChapterCount: 1,
      willRegisterChapterCount: 0,
      willRegisterTaskCount: 0,
      missingStages: { causalProjection: 0, total: 0 },
    });
  });

  it("requires explicit backfill confirmation before restoring a deferred local stage", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "Deferred policy stage");
    const chapter = await createChapter(
      runtime,
      project.id,
      "Chapter one",
      "Stable accepted text saved while automatic summaries were paused.",
    );
    await ensureAcceptedChapterPipelineTask(runtime, {
      projectId: chapter.projectId,
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      source: "manual_save",
      acceptedCharacterCount: chapter.content.length,
      runChapterSummary: false,
      runStoryState: false,
    });
    await completeTaskByKey(
      runtime,
      acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      685,
      ["search"],
      [],
      ["causal_projection"],
    );
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      ),
    ).resolves.toMatchObject({ status: "succeeded", attempt: 1 });

    const plan = await runtime.story.historicalBackfill.plan(project.id);
    expect(plan).toMatchObject({
      willRegisterChapterCount: 1,
      willRegisterTaskCount: 1,
      missingStages: { causalProjection: 1, total: 1 },
    });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineStageIdempotencyKey(
          chapter.currentVersionId,
          "causal_projection",
          1,
        ),
      ),
    ).resolves.toBeNull();

    await runtime.story.historicalBackfill.register({
      projectId: project.id,
      expectedPlanFingerprint: plan.fingerprint,
      humanConfirmed: true,
    });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineStageIdempotencyKey(
          chapter.currentVersionId,
          "causal_projection",
          1,
        ),
      ),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("fails closed when an active task has a non-boolean stage switch", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "损坏阶段开关失败关闭");
    const chapter = await createChapter(
      runtime,
      project.id,
      "第一章",
      "不能被损坏任务遮蔽的正文。",
      "standard",
    );
    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    await runtime.taskCenter.enqueueTask({
      id: uuid(690),
      type: "story.accepted-version.process",
      idempotencyKey: acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      metadata: {
        projectId: project.id,
        chapterId: chapter.id,
        versionId: chapter.currentVersionId,
        source: "candidate_accept",
        acceptedCharacterCount: chapter.content.length,
        runChapterSummary: "yes",
        operation: "rebuild-derived-story-state",
      },
      priority: 75,
      maxAttempts: 3,
      now: runtime.clock.now(),
    });

    await expect(runtime.story.historicalBackfill.plan(project.id)).rejects.toMatchObject({
      code: "HISTORICAL_BACKFILL_STORAGE_UNAVAILABLE",
    });
  });

  it("ignores legacy automatic model preferences after local stages complete", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "补齐后来开启的阶段");
    const chapter = await createChapter(
      runtime,
      project.id,
      "第一章",
      "已经确认保存的正文。",
      "standard",
    );
    const service = runtime.story.historicalBackfill;

    const disabledPlan = await service.plan(project.id);
    await service.register({
      projectId: project.id,
      expectedPlanFingerprint: disabledPlan.fingerprint,
      humanConfirmed: true,
    });
    await completeTaskByKey(
      runtime,
      acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      700,
    );

    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    runtime.story.continuousState.setAutomaticOnManualSaveEnabled(project.id, true);
    const enabledPlan = await service.plan(project.id);
    expect(enabledPlan).toMatchObject({
      registeredChapterCount: 1,
      willRegisterChapterCount: 0,
      willRegisterTaskCount: 0,
      missingStages: {
        search: 0,
        chapterSummary: 0,
        storyState: 0,
        causalProjection: 0,
        total: 0,
      },
      modelStages: { chapterSummaryEnabled: false, storyStateEnabled: false },
      possibleRemoteProviderCallUpperBound: { chapterSummary: 0, storyState: 0, total: 0 },
    });

    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineStageIdempotencyKey(chapter.currentVersionId, "chapter_summary", 1),
      ),
    ).resolves.toBeNull();
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineStageIdempotencyKey(chapter.currentVersionId, "search", 1),
      ),
    ).resolves.toBeNull();
    await expect(service.plan(project.id)).resolves.toMatchObject({
      registeredChapterCount: 1,
      willRegisterTaskCount: 0,
    });
  });

  it("recovers only a permanently failed local stage and advances its generation", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "失败阶段按代恢复");
    const chapter = await createChapter(
      runtime,
      project.id,
      "第一章",
      "用于阶段恢复的稳定正文。",
      "standard",
    );
    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    runtime.story.continuousState.setAutomaticOnManualSaveEnabled(project.id, true);
    const service = runtime.story.historicalBackfill;
    const initialPlan = await service.plan(project.id);
    await service.register({
      projectId: project.id,
      expectedPlanFingerprint: initialPlan.fingerprint,
      humanConfirmed: true,
    });
    const baseKey = acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId);
    await failTaskPermanently(runtime, baseKey, ["causal_projection"], 800);

    const retryPlan = await service.plan(project.id);
    expect(retryPlan).toMatchObject({
      willRegisterChapterCount: 1,
      willRegisterTaskCount: 1,
      missingStages: {
        search: 0,
        chapterSummary: 0,
        storyState: 0,
        causalProjection: 1,
        total: 1,
      },
    });
    await service.register({
      projectId: project.id,
      expectedPlanFingerprint: retryPlan.fingerprint,
      humanConfirmed: true,
    });
    const generationOneKey = acceptedChapterPipelineStageIdempotencyKey(
      chapter.currentVersionId,
      "causal_projection",
      1,
    );
    await failTaskPermanently(runtime, generationOneKey, ["causal_projection"], 900);

    const generationTwoPlan = await service.plan(project.id);
    expect(generationTwoPlan).toMatchObject({ willRegisterTaskCount: 1 });
    await service.register({
      projectId: project.id,
      expectedPlanFingerprint: generationTwoPlan.fingerprint,
      humanConfirmed: true,
    });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineStageIdempotencyKey(
          chapter.currentVersionId,
          "causal_projection",
          2,
        ),
      ),
    ).resolves.toMatchObject({
      status: "queued",
      metadata: { pipelineStageGeneration: 2, pipelineStage: "causal_projection" },
    });
  });

  it("keeps a deferred local stage missing when another local stage exhausts retries", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "Deferred plus exhausted failure");
    const chapter = await createChapter(
      runtime,
      project.id,
      "Chapter one",
      "A stable version with one deferred and one failed model stage.",
    );
    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    runtime.story.continuousState.setAutomaticOnManualSaveEnabled(project.id, true);
    await ensureAcceptedChapterPipelineTask(runtime, {
      projectId: chapter.projectId,
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      source: "manual_save",
      acceptedCharacterCount: chapter.content.length,
      runChapterSummary: false,
      runStoryState: false,
    });
    await failTaskPermanently(
      runtime,
      acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      ["causal_projection"],
      950,
      [],
      ["search"],
    );

    await expect(runtime.story.historicalBackfill.plan(project.id)).resolves.toMatchObject({
      willRegisterChapterCount: 1,
      willRegisterTaskCount: 2,
      missingStages: {
        search: 1,
        chapterSummary: 0,
        storyState: 0,
        causalProjection: 1,
        total: 2,
      },
    });
  });

  it("returns an accurate partial receipt when registration fails after earlier items succeeded", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "中途失败保留准确回执");
    const chapter = await createChapter(
      runtime,
      project.id,
      "第一章",
      "不可被登记失败影响的正文。",
      "standard",
    );
    const service = runtime.story.historicalBackfill;
    const basePlan = await service.plan(project.id);
    await service.register({
      projectId: project.id,
      expectedPlanFingerprint: basePlan.fingerprint,
      humanConfirmed: true,
    });
    await failTaskPermanently(
      runtime,
      acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      ["search", "causal_projection"],
      1_000,
    );
    const supplementalPlan = await service.plan(project.id);
    expect(supplementalPlan.willRegisterTaskCount).toBe(2);

    const originalEnqueue = runtime.taskCenter.enqueueTask.bind(runtime.taskCenter);
    const enqueue = vi.spyOn(runtime.taskCenter, "enqueueTask");
    enqueue.mockImplementationOnce(originalEnqueue).mockRejectedValueOnce(new Error("disk busy"));
    const receipt = await service.register({
      projectId: project.id,
      expectedPlanFingerprint: supplementalPlan.fingerprint,
      humanConfirmed: true,
    });

    expect(receipt).toMatchObject({
      status: "partial",
      attemptedTaskCount: 2,
      registeredTaskCount: 1,
      createdTaskCount: 1,
      alreadyRegisteredTaskCount: 0,
      failedTaskCount: 1,
      remainingTaskCount: 1,
      failures: [{ stage: "causal_projection", code: "HISTORICAL_BACKFILL_REGISTRATION_FAILED" }],
    });
    expect(await runtime.repositories.chapters.findById(chapter.id)).toMatchObject({
      ok: true,
      value: { content: "不可被登记失败影响的正文。" },
    });
    enqueue.mockRestore();
    await expect(service.plan(project.id)).resolves.toMatchObject({
      willRegisterChapterCount: 1,
      willRegisterTaskCount: 1,
      missingStages: { search: 0, causalProjection: 1, total: 1 },
    });
  });

  it("rechecks chapter privacy before every item and stops with an accurate stale partial receipt", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "逐条登记复核权威");
    const chapter = await createChapter(
      runtime,
      project.id,
      "第一章",
      "登记期间隐私会改变的正文。",
      "standard",
    );
    const service = runtime.story.historicalBackfill;
    const basePlan = await service.plan(project.id);
    await service.register({
      projectId: project.id,
      expectedPlanFingerprint: basePlan.fingerprint,
      humanConfirmed: true,
    });
    await failTaskPermanently(
      runtime,
      acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      ["search", "causal_projection"],
      1_100,
    );
    const supplementalPlan = await service.plan(project.id);
    expect(supplementalPlan.willRegisterTaskCount).toBe(2);

    const originalEnqueue = runtime.taskCenter.enqueueTask.bind(runtime.taskCenter);
    let enqueueCount = 0;
    const enqueue = vi.spyOn(runtime.taskCenter, "enqueueTask");
    enqueue.mockImplementation(async (taskInput) => {
      const result = await originalEnqueue(taskInput);
      enqueueCount += 1;
      if (enqueueCount === 1) {
        const changed = await runtime.useCases.setChapterPrivacy.execute({
          chapterId: chapter.id,
          privacyMode: "local_only",
          expectedPrivacyRevision: chapter.privacyRevision,
        });
        if (!changed.ok) throw changed.error;
      }
      return result;
    });

    const receipt = await service.register({
      projectId: project.id,
      expectedPlanFingerprint: supplementalPlan.fingerprint,
      humanConfirmed: true,
    });
    expect(receipt).toMatchObject({
      status: "partial",
      attemptedTaskCount: 2,
      registeredTaskCount: 1,
      createdTaskCount: 1,
      failedTaskCount: 1,
      remainingTaskCount: 1,
      failures: [{ code: "HISTORICAL_BACKFILL_PLAN_STALE", stage: "causal_projection" }],
    });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineStageIdempotencyKey(
          chapter.currentVersionId,
          "causal_projection",
          1,
        ),
      ),
    ).resolves.toBeNull();
    enqueue.mockRestore();
  });

  it("fails closed at execution when a chapter changes after the last registration check", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const project = await createProject(runtime, "Registration race execution fence");
    const originalContent =
      "The immutable accepted version carries the obsoletequartzmarker for the old plan.";
    const currentContent =
      "The author saved a newer accepted version with the currentcedarmarker during registration.";
    const chapter = await createChapter(
      runtime,
      project.id,
      "Chapter one",
      originalContent,
      "standard",
    );
    runtime.story.chapterSummaries.setAutomaticOnManualSaveEnabled(project.id, true);
    runtime.story.continuousState.setAutomaticOnManualSaveEnabled(project.id, true);
    const service = runtime.story.historicalBackfill;
    const plan = await service.plan(project.id);
    expect(plan.willRegisterTaskCount).toBe(1);

    const originalEnqueue = runtime.taskCenter.enqueueTask.bind(runtime.taskCenter);
    const enqueue = vi.spyOn(runtime.taskCenter, "enqueueTask");
    enqueue.mockImplementation(async (taskInput) => {
      if (enqueue.mock.calls.length === 1) {
        const edited = await runtime.useCases.editChapter.execute({
          chapterId: chapter.id,
          expectedRevision: chapter.revision,
          content: currentContent,
          cursorOffset: currentContent.length,
        });
        if (!edited.ok) throw edited.error;
        const saved = await runtime.useCases.saveChapter.execute({
          chapterId: chapter.id,
          expectedRevision: chapter.revision,
          reason: "manual",
        });
        if (!saved.ok || saved.value.version === null) {
          throw new Error("Expected the racing save to create a new immutable version.");
        }
      }
      return originalEnqueue(taskInput);
    });

    const receipt = await service.register({
      projectId: project.id,
      expectedPlanFingerprint: plan.fingerprint,
      humanConfirmed: true,
    });
    expect(receipt).toMatchObject({
      status: "completed",
      createdTaskCount: 1,
      boundary: "current_stable_versions_only",
    });
    const racedChapter = await runtime.repositories.chapters.findById(chapter.id);
    if (!racedChapter.ok || racedChapter.value === null) {
      throw new Error("Expected the racing save to leave a current chapter.");
    }
    const racedVersionId = racedChapter.value.currentVersionId;
    expect(racedVersionId).not.toBe(chapter.currentVersionId);

    const causalAuthority = await persistCausalAuthorityFacts(runtime, {
      projectId: project.id,
      chapterId: chapter.id,
      oldVersionId: chapter.currentVersionId,
      oldContent: originalContent,
      currentVersionId: racedVersionId,
      currentContent,
    });

    const generate = vi.spyOn(runtime.modelGateway, "generate");
    const originalCausalRebuild = runtime.story.causalProjector.rebuildProject.bind(
      runtime.story.causalProjector,
    );
    const causalReceipts: Awaited<ReturnType<typeof originalCausalRebuild>>[] = [];
    const causalRebuild = vi
      .spyOn(runtime.story.causalProjector, "rebuildProject")
      .mockImplementation(async (projectId, branchId) => {
        const projected = await originalCausalRebuild(projectId, branchId);
        causalReceipts.push(projected);
        return projected;
      });
    const pipeline = await runAcceptedChapterPipeline(runtime, {
      projectId: project.id,
      chapterId: chapter.id,
      versionId: chapter.currentVersionId,
      source: "historical_backfill",
      acceptedCharacterCount: originalContent.length,
      runSearch: true,
      runChapterSummary: true,
      runStoryState: true,
      runCausalProjection: true,
    });
    expect(pipeline.status).toBe("completed");
    expect(pipeline.chapterSummary).toMatchObject({
      status: "skipped",
      code: "CHAPTER_SUMMARY_REQUIRES_SEPARATE_AUTHORIZATION",
    });
    expect(pipeline.storyState).toMatchObject({
      status: "skipped",
      code: "STORY_STATE_REQUIRES_SEPARATE_AUTHORIZATION",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(causalRebuild).toHaveBeenCalledWith(project.id, "main");
    const causalReceipt = causalReceipts[0];
    if (causalReceipt === undefined) throw new Error("Expected causal projection evidence.");
    expect(causalReceipt.includedFactIds).toEqual([causalAuthority.currentFactId]);
    expect(causalReceipt.includedFactIds).not.toContain(causalAuthority.oldFactId);
    expect(causalReceipt.skipped).toEqual([
      expect.objectContaining({ factId: causalAuthority.oldFactId, reason: "not_confirmed" }),
    ]);

    const staleSearch = await runtime.search.search(project.id, "obsoletequartzmarker");
    const currentSearch = await runtime.search.search(project.id, "currentcedarmarker");
    expect(
      staleSearch.ok &&
        staleSearch.value.hits.every(
          ({ document }) =>
            document.sourceVersionId !== chapter.currentVersionId &&
            !document.text.includes("obsoletequartzmarker"),
        ),
    ).toBe(true);
    expect(
      currentSearch.ok &&
        currentSearch.value.hits.some(
          ({ document }) =>
            document.sourceVersionId === racedVersionId &&
            document.text.includes("currentcedarmarker"),
        ),
    ).toBe(true);

    const current = await runtime.repositories.chapters.findById(chapter.id);
    if (!current.ok || current.value === null) {
      throw new Error("Expected the current chapter to remain available.");
    }
    expect(current.value.toSnapshot()).toMatchObject({
      currentVersionId: racedVersionId,
      content: currentContent,
    });
    const immutableOriginal = await runtime.repositories.chapterVersions.findVersionById(
      chapter.currentVersionId,
    );
    if (!immutableOriginal.ok || immutableOriginal.value === null) {
      throw new Error("Expected the original immutable version to remain available.");
    }
    expect(immutableOriginal.value.toSnapshot().content).toBe(originalContent);
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineIdempotencyKey(chapter.currentVersionId),
      ),
    ).resolves.toMatchObject({
      status: "succeeded",
      progress: { step: "pipeline.outcome.search-causal" },
    });
    await expect(
      runtime.taskCenter.findTaskByIdempotencyKey(
        acceptedChapterPipelineStageIdempotencyKey(chapter.currentVersionId, "chapter_summary", 1),
      ),
    ).resolves.toBeNull();
    causalRebuild.mockRestore();
    generate.mockRestore();
    enqueue.mockRestore();
  });
});

async function createProject(runtime: DesktopRuntime, name: string) {
  const result = await runtime.useCases.createProject.execute({ name });
  if (!result.ok) throw result.error;
  return result.value;
}

async function createChapter(
  runtime: DesktopRuntime,
  projectId: Parameters<DesktopRuntime["useCases"]["createChapter"]["execute"]>[0]["projectId"],
  title: string,
  content: string,
  privacyMode: "standard" | "local_only" = "standard",
) {
  const result = await runtime.useCases.createChapter.execute({
    projectId,
    title,
    content,
    privacyMode,
  });
  if (!result.ok) throw result.error;
  return result.value.chapter;
}

async function persistCausalAuthorityFacts(
  runtime: DesktopRuntime,
  input: Readonly<{
    projectId: string;
    chapterId: string;
    oldVersionId: string;
    oldContent: string;
    currentVersionId: string;
    currentContent: string;
  }>,
) {
  const oldFactId = uuid(1_400);
  const currentFactId = uuid(1_401);
  const oldFact = createCausalAuthorityFact(runtime, {
    id: oldFactId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    versionId: input.oldVersionId,
    content: input.oldContent,
    eventId: "registration-race-old-event",
  });
  const createdOld = await runtime.story.facts.create(oldFact);
  if (!createdOld.ok) throw createdOld.error;
  const deprecatedOld = oldFact.deprecate({
    humanConfirmed: true,
    expectedRevision: oldFact.revision,
    now: runtime.clock.now(),
  });
  if (!deprecatedOld.ok) throw deprecatedOld.error;
  const savedOld = await runtime.story.facts.save(deprecatedOld.value, oldFact.revision);
  if (!savedOld.ok) throw savedOld.error;

  const currentFact = createCausalAuthorityFact(runtime, {
    id: currentFactId,
    projectId: input.projectId,
    chapterId: input.chapterId,
    versionId: input.currentVersionId,
    content: input.currentContent,
    eventId: "registration-race-current-event",
  });
  const createdCurrent = await runtime.story.facts.create(currentFact);
  if (!createdCurrent.ok) throw createdCurrent.error;
  return { oldFactId, currentFactId };
}

function createCausalAuthorityFact(
  runtime: DesktopRuntime,
  input: Readonly<{
    id: string;
    projectId: string;
    chapterId: string;
    versionId: string;
    content: string;
    eventId: string;
  }>,
) {
  const created = StoryFact.create({
    id: input.id,
    projectId: input.projectId,
    factType: "causal_event",
    contentText: input.eventId,
    structuredValue: {
      schemaVersion: CAUSAL_EVENT_FACT_SCHEMA,
      eventId: input.eventId,
      participantCharacterIds: [],
      narrativeTime: { order: 1, label: "registration race" },
      location: { locationId: "editor", label: "Editor" },
      eventText: input.eventId,
      resultText: "The accepted version changed.",
      informedCharacterIds: [],
      prerequisites: [],
      characterStateChanges: [],
      relationshipChanges: [],
      itemChanges: [],
      foreshadowProgress: [],
      downstreamEventIds: [],
    },
    source: {
      kind: "chapter_span",
      reference: `chapter:${input.chapterId}`,
      chapterId: input.chapterId,
      versionId: input.versionId,
      startOffset: 0,
      endOffset: input.content.length,
      sourceLength: input.content.length,
      excerpt: input.content,
    },
    confidence: 1,
    status: "formal",
    origin: "user",
    needsReview: false,
    humanConfirmed: true,
    confirmationActorId: runtime.story.actorId,
    now: runtime.clock.now(),
  });
  if (!created.ok) throw created.error;
  return created.value;
}

async function completeTaskByKey(
  runtime: DesktopRuntime,
  key: string,
  sequence: number,
  completedStages?: Parameters<typeof pipelineOutcomeProgressStep>[0],
  notApplicableStages: Parameters<typeof pipelineOutcomeProgressStep>[1] = [],
  deferredStages: Parameters<typeof pipelineOutcomeProgressStep>[2] = [],
) {
  const task = await runtime.taskCenter.findTaskByIdempotencyKey(key);
  if (task === null) throw new Error(`Missing task ${key}`);
  const leaseToken = uuid(sequence);
  await runtime.taskCenter.startTask(
    task.id,
    "desktop.test",
    leaseToken,
    new Date(Date.now() + 60_000).toISOString(),
  );
  if (completedStages !== undefined) {
    await runtime.taskCenter.reportTaskProgress(
      task.id,
      leaseToken,
      pipelineOutcomeProgressStep(completedStages, notApplicableStages, deferredStages),
      4,
      4,
    );
  }
  await runtime.taskCenter.completeTask(task.id, leaseToken);
}

async function failTaskPermanently(
  runtime: DesktopRuntime,
  key: string,
  stages: Parameters<typeof pipelineStageFailureCauseCode>[0],
  sequence: number,
  notApplicableStages: Parameters<typeof pipelineStageFailureCauseCode>[1] = [],
  deferredStages: Parameters<typeof pipelineStageFailureCauseCode>[2] = [],
) {
  const task = await runtime.taskCenter.findTaskByIdempotencyKey(key);
  if (task === null) throw new Error(`Missing task ${key}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      await runtime.taskCenter.retryTaskNow(task.id);
    }
    const leaseToken = uuid(sequence + attempt);
    await runtime.taskCenter.startTask(
      task.id,
      "desktop.test",
      leaseToken,
      new Date(Date.now() + 60_000).toISOString(),
    );
    await runtime.taskCenter.failTask(
      task.id,
      leaseToken,
      {
        code: "ACCEPTED_VERSION_PIPELINE_PARTIAL",
        causeCode: pipelineStageFailureCauseCode(stages, notApplicableStages, deferredStages),
        retryable: true,
        actions: ["RETRY"],
        requestId: `request-${String(sequence)}-${String(attempt)}`,
      },
      new Date(Date.now() + 1_000).toISOString(),
    );
  }
  await expect(runtime.taskCenter.findTaskByIdempotencyKey(key)).resolves.toMatchObject({
    status: "failed",
    failure: {
      code: "TASK_RETRY_EXHAUSTED",
      causeCode: pipelineStageFailureCauseCode(stages, notApplicableStages, deferredStages),
    },
  });
}

function uuid(sequence: number): string {
  return `018f0f00-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
}
