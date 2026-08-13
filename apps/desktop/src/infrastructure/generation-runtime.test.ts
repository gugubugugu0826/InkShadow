// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NovelSkillDefinition, ProjectNovelSkillBinding } from "@inkshadow/ai-core";
import { createProjectSeed, parseUuidV7, updateProjectSeedField } from "@inkshadow/domain";

import { ModelCenterError } from "./model-center-store";
import { TauriNovelSkillRuntime, type NovelSkillRuntimePersistence } from "./novel-skill-runtime";
import type {
  CommitNovelSkillInvocationInput,
  NovelSkillInvocationSnapshotRecord,
} from "./novel-skill-sqlite-store";
import {
  canDeferGenerationPlan,
  cancelGenerationPlan,
  createDevelopmentRuntime,
  executeGenerationPlan,
  prepareGenerationPlan,
  saveDeferredGenerationPlan,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "./runtime";

describe("governed generation runtime", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("includes confirmed ProjectSeed guidance in the real continuation context", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) {
      throw new Error("Expected the generated test chapter.");
    }
    const now = runtime.clock.now();
    let seed = createProjectSeed({
      seedId: runtime.ids.next(),
      journeyKind: "idea",
      premise: "在永夜港寻找失踪的姐姐。",
      now,
    });
    seed = updateProjectSeedField(seed, "boundaries", {
      values: ["禁止死者复生。"],
      source: "user_input",
      confirmation: "confirmed",
      origin: "author-boundaries",
      updatedAt: now,
    });
    seed = updateProjectSeedField(seed, "world", {
      values: ["潮雾会吞没无人看守的灯塔。"],
      source: "ai_inference",
      confirmation: "unconfirmed",
      origin: "ai-opening",
      updatedAt: now,
    });
    await runtime.projectSeeds.saveForProject(chapter.value.projectId, seed);

    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const boundaryEntry = plan.contextCompilation?.compiled.entries.find(({ id }) =>
      id.includes(":boundaries:"),
    );
    expect(boundaryEntry).toMatchObject({
      layer: "locked_hard_rules",
      included: true,
      required: true,
    });
    const prompt = plan.messages.map(({ content }) => content).join("\n");
    expect(prompt).toContain("禁止死者复生。");
    expect(prompt).not.toContain("潮雾会吞没无人看守的灯塔");
  });

  it("warns without price metadata and exposes a source-backed estimate after configuration", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    await runtime.modelCenter.save({
      providerId: "local-ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: "writer-model",
      pricing: null,
      expectedRevision: 1,
    });

    const unpriced = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: false,
    });
    expect(unpriced.preflight.readiness).toBe("READY_WITH_WARNINGS");
    expect(unpriced.preflight.canStart).toBe(true);
    expect(unpriced.preflight.estimate).toBeNull();
    expect(unpriced.preflight.checks.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "PREFLIGHT_WARNING_PRICING_UNKNOWN",
        "PREFLIGHT_WARNING_CONTEXT_UNKNOWN",
        "PREFLIGHT_WARNING_TOKEN_ESTIMATE_APPROXIMATE",
      ]),
    );

    await runtime.modelCenter.save({
      providerId: "local-ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: "writer-model",
      pricing: localPricing(),
      expectedRevision: 2,
    });
    const ready = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: false,
    });
    expect(ready.preflight.canStart).toBe(true);
    expect(ready.preflight.estimate).toMatchObject({
      micros: 0n,
      pricingVersion: "local-zero-cost",
    });
    expect(ready.tokenEstimateSource).toBe("utf8_conservative");
  });

  it("charges and invokes the model once when the same prepared request is replayed", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((request) => {
      request.onDelta?.("候选续写。");
      return Promise.resolve(generationResult("候选续写。", 120, 24));
    });
    const { runtime, chapterId } = await createNativeRuntime(generate);
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const first = await executeGenerationPlan(runtime, plan);
    const second = await executeGenerationPlan(runtime, plan);

    expect(first.ok && first.value).toMatchObject({ cancelled: false, reused: false });
    expect(second.ok && second.value).toMatchObject({ cancelled: false, reused: true });
    expect(generate).toHaveBeenCalledTimes(1);
    const run = await runtime.generationGovernance.findRunById(plan.runId);
    expect(run).toMatchObject({
      state: "completed",
      incurredCostMicros: plan.preflight.estimate?.micros.toString(),
      preflight: {
        generationBudget: {
          outputProfile: "standard",
          targetVisibleCharacters: 2_200,
          requestedMaximumOutputTokens: 3_328,
          budgetStatus: "available",
        },
      },
    });
    const contextSummary = run?.preflight.contextSelectionSummary;
    expect(typeof contextSummary?.selectedSourceCount).toBe("number");
    expect(typeof contextSummary?.deduplicatedSourceCount).toBe("number");
    expect(typeof contextSummary?.excludedSourceCount).toBe("number");
    expect(typeof contextSummary?.estimatedSelectedTokens).toBe("number");
    await expect(runtime.generationGovernance.listAttemptUsage(plan.runId)).resolves.toEqual([
      expect.objectContaining({
        source: "provider_reported",
        inputTokens: 120,
        outputTokens: 24,
        usagePricedEstimateMicros: "0",
      }),
    ]);
    const tasks = await runtime.taskCenter.load();
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]).toMatchObject({
      id: plan.taskId,
      status: "succeeded",
      progress: { step: "candidate.finalized", completedUnits: 5 },
    });
    expect(tasks.notifications).toHaveLength(1);
    expect(tasks.notifications[0]).toMatchObject({
      messageKey: "task.completed",
      status: "visible",
      severity: "success",
    });
  });

  it("keeps a bounded Skill-assisted response isolated through reject, reopen, and disable", async () => {
    const boundedOutput =
      "雨线斜落在檐角，林澈把湿透的纸页压在灯下。巷口传来一声短促铜铃，他没有追出去，只把门闩轻轻扣紧。" +
      "桌上的旧地图被风掀起一角，露出背面新添的墨迹：今夜别去钟楼。字迹尚未干透，像有人刚从屋里离开。" +
      "他摸到窗框上的细泥，泥里混着淡白盐粒。城南河道早已封冻，只有北门码头会留下这样的痕迹。" +
      "林澈吹灭灯，把地图折进袖中。门外脚步停了片刻，随后沿石阶退远。他数到十，才从后窗翻进雨幕。" +
      "远处钟声提前响了一下。他贴着墙根向北走，始终没有回头，也没有惊动守夜的人。";
    expect(boundedOutput.length).toBeGreaterThanOrEqual(200);
    expect(boundedOutput.length).toBeLessThanOrEqual(400);
    const generate = vi.fn<NativeModelGatewayClient["generate"]>((request) => {
      expect(request.maxOutputTokens).toBe(768);
      request.onDelta?.(boundedOutput);
      return Promise.resolve(generationResult(boundedOutput, 180, 260));
    });
    const created = await createRemoteRuntime({ generate });
    const experimental = await attachEnabledNovelSkills(created.runtime, created.chapterId);
    const runtime = experimental.runtime;
    await seedModelHubContinuationRoute(runtime);
    const chapterBefore = await runtime.repositories.chapters.findById(created.chapterId);
    const versionsBefore = await runtime.repositories.chapterVersions.listByChapterId(
      created.chapterId,
    );
    if (!chapterBefore.ok || chapterBefore.value === null || !versionsBefore.ok) {
      throw new Error("Expected the stable chapter and its initial version.");
    }

    const plan = await prepareGenerationPlan(runtime, created.chapterId, {
      chapterSaved: true,
      networkAvailable: true,
      outputProfile: "custom",
      customTargetVisibleCharacters: 300,
      destination: "next_segment",
    });
    expect(plan.novelSkillPreparation.status).toBe("prepared_applied");
    expect(
      plan.novelSkillPreparation.methods.find(({ displayName }) => displayName === "场景推进"),
    ).toMatchObject({ displayName: "场景推进", version: "1.0.0", included: true });

    const executed = await executeGenerationPlan(runtime, plan);
    if (!executed.ok || executed.value.candidate === null || plan.contextTraceId === null) {
      throw new Error("Expected one isolated Skill-assisted Candidate and its trace.");
    }
    expect(generate).toHaveBeenCalledTimes(1);
    expect(executed.value.candidate.content).toContain(boundedOutput);
    const chapterAfterGeneration = await runtime.repositories.chapters.findById(created.chapterId);
    const versionsAfterGeneration = await runtime.repositories.chapterVersions.listByChapterId(
      created.chapterId,
    );
    expect(chapterAfterGeneration.ok && chapterAfterGeneration.value?.toSnapshot()).toEqual(
      chapterBefore.value.toSnapshot(),
    );
    expect(
      versionsAfterGeneration.ok
        ? versionsAfterGeneration.value.map((version) => version.toSnapshot())
        : null,
    ).toEqual(versionsBefore.value.map((version) => version.toSnapshot()));
    const invocationBeforeReject = await runtime.novelSkills.findInvocationByContextTrace(
      plan.contextTraceId,
    );
    if (invocationBeforeReject.status !== "found") {
      throw new Error("Expected the Skill invocation receipt by context trace.");
    }
    expect(
      invocationBeforeReject.invocation.methods.find(
        ({ displayName }) => displayName === "场景推进",
      ),
    ).toMatchObject({ displayName: "场景推进", version: "1.0.0", included: true });

    const rejected = await runtime.useCases.rejectCandidate.execute({
      candidateId: executed.value.candidate.id,
      expectedCandidateRevision: executed.value.candidate.revision,
    });
    if (!rejected.ok) throw rejected.error;
    expect(rejected.value.status).toBe("rejected");
    if (plan.projectId === null) throw new Error("Expected a project-bound generation plan.");
    const scene = (await runtime.novelSkills.listProjectState(plan.projectId)).methods.find(
      ({ skillId }) => skillId === "core.scene_craft",
    );
    if (scene === undefined) throw new Error("Expected the enabled scene method.");
    await runtime.novelSkills.setMethodEnabled(plan.projectId, scene.skillId, false);

    const reopenedContentRuntime = createDevelopmentRuntime(window.localStorage);
    const reopenedCandidate = await reopenedContentRuntime.repositories.aiCandidates.findById(
      executed.value.candidate.id,
    );
    const reopenedChapter = await reopenedContentRuntime.repositories.chapters.findById(
      created.chapterId,
    );
    const reopenedVersions =
      await reopenedContentRuntime.repositories.chapterVersions.listByChapterId(created.chapterId);
    expect(reopenedCandidate.ok && reopenedCandidate.value?.toSnapshot()).toMatchObject({
      id: executed.value.candidate.id,
      status: "rejected",
      content: executed.value.candidate.content,
    });
    expect(reopenedChapter.ok && reopenedChapter.value?.toSnapshot()).toEqual(
      chapterBefore.value.toSnapshot(),
    );
    expect(
      reopenedVersions.ok ? reopenedVersions.value.map((version) => version.toSnapshot()) : null,
    ).toEqual(versionsBefore.value.map((version) => version.toSnapshot()));
    expect(generate).toHaveBeenCalledTimes(1);

    const reopenedSkills = new TauriNovelSkillRuntime(experimental.persistence, runtime.clock);
    await reopenedSkills.initialize();
    expect(
      (await reopenedSkills.listProjectState(plan.projectId)).methods.filter(
        ({ enabled }) => enabled,
      ),
    ).toEqual([]);
    const invocationAfterDisable = await reopenedSkills.findInvocationByContextTrace(
      plan.contextTraceId,
    );
    if (invocationAfterDisable.status !== "found") {
      throw new Error("Expected the historical Skill receipt after disable and reopen.");
    }
    expect(
      invocationAfterDisable.invocation.methods.find(
        ({ displayName }) => displayName === "场景推进",
      ),
    ).toMatchObject({ displayName: "场景推进", version: "1.0.0", included: true });
  });

  it("fails closed when the project is archived, trashed, or missing after preflight", async () => {
    const cases = [
      { lifecycle: "archived", expectedCode: "PROJECT_ARCHIVED" },
      { lifecycle: "trashed", expectedCode: "PROJECT_DELETED" },
      { lifecycle: "missing", expectedCode: "PROJECT_NOT_FOUND" },
    ] as const;

    for (const testCase of cases) {
      window.localStorage.clear();
      const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
        Promise.resolve(generationResult("绝不能保存的候选。", 100, 20)),
      );
      const { runtime, chapterId } = await createNativeRuntime(generate);
      const chapterBefore = await runtime.repositories.chapters.findById(chapterId);
      if (!chapterBefore.ok || chapterBefore.value === null) {
        throw new Error("Expected the generated test chapter.");
      }
      const plan = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: true,
        networkAvailable: true,
      });

      let executionRuntime = runtime;
      if (testCase.lifecycle === "archived") {
        const archived = await runtime.useCases.archiveProject.execute({
          projectId: chapterBefore.value.projectId,
        });
        if (!archived.ok) throw archived.error;
      } else if (testCase.lifecycle === "trashed") {
        const trashed = await runtime.useCases.trashProject.execute({
          projectId: chapterBefore.value.projectId,
        });
        if (!trashed.ok) throw trashed.error;
      } else {
        executionRuntime = {
          ...runtime,
          repositories: {
            ...runtime.repositories,
            projects: {
              findById: () => Promise.resolve({ ok: true as const, value: null }),
            } as unknown as DesktopRuntime["repositories"]["projects"],
          },
        };
      }

      const result = await executeGenerationPlan(executionRuntime, plan);
      expect(result).toMatchObject({ ok: false, error: { code: testCase.expectedCode } });
      expect(generate).not.toHaveBeenCalled();
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapterId);
      expect(candidates.ok && candidates.value).toEqual([]);
      const chapterAfter = await runtime.repositories.chapters.findById(chapterId);
      expect(chapterAfter.ok && chapterAfter.value?.content).toBe(chapterBefore.value.content);
      await expect(runtime.taskCenter.load()).resolves.toMatchObject({ tasks: [] });
    }
  });

  it("rechecks project write access immediately before provider dispatch", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve(generationResult("绝不能发送后的候选。", 100, 20)),
    );
    const { runtime, chapterId } = await createNativeRuntime(generate);
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) throw new Error("Expected the test chapter.");
    const activeProject = await runtime.repositories.projects.findById(chapter.value.projectId);
    if (!activeProject.ok || activeProject.value === null) {
      throw new Error("Expected the active test project.");
    }
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    const archived = await runtime.useCases.archiveProject.execute({
      projectId: chapter.value.projectId,
    });
    if (!archived.ok) throw archived.error;
    const findProject = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, value: activeProject.value })
      .mockResolvedValue({ ok: true as const, value: archived.value });
    const executionRuntime: DesktopRuntime = {
      ...runtime,
      repositories: {
        ...runtime.repositories,
        projects: {
          findById: findProject,
        } as unknown as DesktopRuntime["repositories"]["projects"],
      },
    };

    const result = await executeGenerationPlan(executionRuntime, plan);

    expect(result).toMatchObject({ ok: false, error: { code: "PROJECT_ARCHIVED" } });
    expect(findProject).toHaveBeenCalledTimes(2);
    expect(generate).not.toHaveBeenCalled();
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapterId);
    expect(candidates.ok && candidates.value).toEqual([]);
  });

  it("acknowledges cancellation and retains partial output as an incomplete candidate", async () => {
    let rejectGeneration: ((error: ModelCenterError) => void) | null = null;
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(
      (request) =>
        new Promise<Awaited<ReturnType<NativeModelGatewayClient["generate"]>>>(
          (_resolve, reject) => {
            request.onDelta?.("尚未完成的候选");
            rejectGeneration = reject;
          },
        ),
    );
    const cancelGeneration = vi.fn<NativeModelGatewayClient["cancelGeneration"]>(() => {
      rejectGeneration?.(
        new ModelCenterError("MODEL_GENERATION_CANCELLED", "Model generation was cancelled.", true),
      );
      return Promise.resolve(true);
    });
    const { runtime, chapterId } = await createNativeRuntime(generate, cancelGeneration);
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const execution = executeGenerationPlan(runtime, plan);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await expect(cancelGenerationPlan(runtime, plan)).resolves.toBe(true);
    const result = await execution;

    if (!result.ok || result.value.candidate === null) {
      throw new Error("Expected an incomplete candidate.");
    }
    expect(result.value.cancelled).toBe(true);
    expect(result.value.candidate.status).toBe("ready");
    expect(result.value.candidate.toSnapshot().incomplete).toBe(true);
    expect(result.value.candidate.content).toContain("尚未完成的候选");
    await expect(runtime.taskCenter.load()).resolves.toMatchObject({
      tasks: [{ id: plan.taskId, status: "cancelled" }],
      notifications: [{ messageKey: "task.cancelled", status: "visible" }],
    });
    await expect(runtime.generationGovernance.findRunById(plan.runId)).resolves.toMatchObject({
      state: "cancelled",
      candidateId: result.value.candidate.id,
    });
  });

  it("retries one reasoning-only OpenAI-compatible truncation with thinking disabled", async () => {
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockRejectedValueOnce(
        new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "reasoning used the output budget", true, {
          requestId: "reasoning-only-1",
          httpStatus: 200,
          finishReason: "length",
          visibleContentLength: 0,
          reasoningPresent: true,
          stream: true,
          inputTokens: 80,
          outputTokens: 64,
        }),
      )
      .mockResolvedValueOnce(generationResult("关闭推理后的可见续写。", 80, 20));
    const created = await createRemoteRuntime({ generate });
    const experimental = await attachEnabledNovelSkills(created.runtime, created.chapterId);
    const runtime = experimental.runtime;
    const chapterId = created.chapterId;
    await seedModelHubContinuationRoute(runtime);
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    expect(plan.executionMode).toBe("model_hub");

    const result = await executeGenerationPlan(runtime, plan);

    if (!result.ok || result.value.candidate === null) {
      throw new Error("Expected a complete Candidate from the second Model Hub attempt.");
    }
    expect(result.value).toMatchObject({ incomplete: false, cancelled: false });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0]?.[0].reasoningMode).toBeUndefined();
    expect(generate.mock.calls[1]?.[0]).toMatchObject({ reasoningMode: "disabled" });
    expect(generate.mock.calls[1]?.[0].generationId).not.toBe(
      generate.mock.calls[0]?.[0].generationId,
    );
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapterId);
    expect(candidates.ok && candidates.value).toHaveLength(1);
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) throw new Error("Expected the test chapter.");
    const traces = (await runtime.contextTraces.listByProjectId(chapter.value.projectId)).filter(
      ({ execution }) => execution?.generationRunId === plan.runId,
    );
    expect(traces).toHaveLength(2);
    expect(new Set(traces.map(({ id }) => id)).size).toBe(2);
    expect(new Set(traces.map(({ execution }) => execution?.generationId)).size).toBe(2);
    expect(
      new Set(traces.map(({ execution }) => execution?.modelInvocationId).filter(Boolean)).size,
    ).toBe(2);
    expect(experimental.persistence.commits).toHaveLength(2);
    expect(new Set(experimental.persistence.commits.map(({ snapshotId }) => snapshotId)).size).toBe(
      2,
    );
    expect(
      new Set(experimental.persistence.commits.map(({ contextTraceId }) => contextTraceId)).size,
    ).toBe(2);
    expect(
      new Set(experimental.persistence.commits.map(({ modelInvocationId }) => modelInvocationId))
        .size,
    ).toBe(2);
    expect(
      new Set(experimental.persistence.commits.map(({ contextTraceId }) => contextTraceId)),
    ).toEqual(new Set(traces.map(({ id }) => id)));
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outputCandidateId: null }),
        expect.objectContaining({ outputCandidateId: result.value.candidate.id }),
      ]),
    );
  });

  it("fails closed before provider dispatch when an enabled writing method changes after preparation", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve(generationResult("This must never be dispatched.", 80, 20)),
    );
    const created = await createRemoteRuntime({ generate });
    const experimental = await attachEnabledNovelSkills(created.runtime, created.chapterId);
    const runtime = experimental.runtime;
    await seedModelHubContinuationRoute(runtime);
    const plan = await prepareGenerationPlan(runtime, created.chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(plan.executionMode).toBe("model_hub");
    expect(plan.novelSkillPreparation.status).toBe("prepared_applied");
    expect(plan.messages.map(({ content }) => content).join("\n")).toContain("<novel_method>");
    if (plan.projectId === null) {
      throw new Error("Expected the prepared project.");
    }
    const scene = (await runtime.novelSkills.listProjectState(plan.projectId)).methods.find(
      ({ displayName }) => displayName === "场景推进",
    );
    if (scene === undefined) {
      throw new Error("Expected the enabled scene method and project.");
    }
    await runtime.novelSkills.setMethodEnabled(plan.projectId, scene.skillId, false);

    const result = await executeGenerationPlan(runtime, plan);

    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(experimental.persistence.commits).toHaveLength(0);
  });

  it("does not dispatch when cancellation arrives while the Novel Skill snapshot is awaiting commit", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve(
        generationResult("This cancelled request must not leave the device.", 80, 20),
      ),
    );
    const cancelGeneration = vi.fn<NativeModelGatewayClient["cancelGeneration"]>(() =>
      Promise.resolve(false),
    );
    const created = await createRemoteRuntime({ generate, cancelGeneration });
    const experimental = await attachEnabledNovelSkills(created.runtime, created.chapterId);
    const runtime = experimental.runtime;
    await seedModelHubContinuationRoute(runtime);
    const plan = await prepareGenerationPlan(runtime, created.chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    const originalCommit = experimental.persistence.commitInvocationBeforeDispatch.bind(
      experimental.persistence,
    );
    let releaseCommit!: () => void;
    let commitStarted = false;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    vi.spyOn(experimental.persistence, "commitInvocationBeforeDispatch").mockImplementation(
      async (input) => {
        commitStarted = true;
        await commitGate;
        return originalCommit(input);
      },
    );

    const execution = executeGenerationPlan(runtime, plan);
    await vi.waitFor(() => expect(commitStarted).toBe(true));
    await expect(cancelGenerationPlan(runtime, plan)).resolves.toBe(true);
    releaseCommit();
    const result = await execution;

    expect(result).toMatchObject({
      ok: true,
      value: { cancelled: true, candidate: null },
    });
    expect(cancelGeneration).toHaveBeenCalledWith(plan.generationId);
    expect(generate).not.toHaveBeenCalled();
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(created.chapterId);
    expect(candidates.ok && candidates.value).toEqual([]);
  });

  it("does not dispatch when the project is archived while the Novel Skill snapshot is awaiting commit", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve(generationResult("This archived request must not leave the device.", 80, 20)),
    );
    const created = await createRemoteRuntime({ generate });
    const experimental = await attachEnabledNovelSkills(created.runtime, created.chapterId);
    const runtime = experimental.runtime;
    await seedModelHubContinuationRoute(runtime);
    const plan = await prepareGenerationPlan(runtime, created.chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    const originalCommit = experimental.persistence.commitInvocationBeforeDispatch.bind(
      experimental.persistence,
    );
    let releaseCommit!: () => void;
    let commitStarted = false;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    vi.spyOn(experimental.persistence, "commitInvocationBeforeDispatch").mockImplementation(
      async (input) => {
        commitStarted = true;
        await commitGate;
        return originalCommit(input);
      },
    );

    const execution = executeGenerationPlan(runtime, plan);
    await vi.waitFor(() => expect(commitStarted).toBe(true));
    if (plan.projectId === null) throw new Error("Expected a project-bound plan.");
    const projectId = parseProjectId(plan.projectId);
    const archived = await runtime.useCases.archiveProject.execute({ projectId });
    if (!archived.ok) throw archived.error;
    releaseCommit();
    const result = await execution;

    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_HUB_PREFLIGHT_FAILED" } });
    expect(generate).not.toHaveBeenCalled();
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(created.chapterId);
    expect(candidates.ok && candidates.value).toEqual([]);
  });

  it("discards a successful provider response when cancellation wins before Candidate creation", async () => {
    let resolveGeneration!: (value: ReturnType<typeof generationResult>) => void;
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const cancelGeneration = vi.fn<NativeModelGatewayClient["cancelGeneration"]>(() =>
      Promise.resolve(false),
    );
    const { runtime, chapterId } = await createRemoteRuntime({ generate, cancelGeneration });
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const execution = executeGenerationPlan(runtime, plan);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await cancelGenerationPlan(runtime, plan);
    resolveGeneration(generationResult("Late successful response.", 80, 20));
    const result = await execution;

    expect(result).toMatchObject({ ok: true, value: { cancelled: true, candidate: null } });
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapterId);
    expect(candidates.ok && candidates.value).toEqual([]);
  });

  it("rejects a successful provider response after a concurrent accepted-version save", async () => {
    let resolveGeneration!: (value: ReturnType<typeof generationResult>) => void;
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const { runtime, chapterId, chapterRevision } = await createRemoteRuntime({ generate });
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const execution = executeGenerationPlan(runtime, plan);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const edited = await runtime.useCases.editChapter.execute({
      chapterId,
      expectedRevision: chapterRevision,
      content: "A concurrent author save wins over the late provider response.",
      cursorOffset: 20,
    });
    if (!edited.ok) throw edited.error;
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId,
      expectedRevision: chapterRevision,
      reason: "manual",
    });
    if (!saved.ok) throw saved.error;
    resolveGeneration(generationResult("Late stale response.", 80, 20));
    const result = await execution;

    expect(result).toMatchObject({ ok: false, error: { code: "BASE_VERSION_CHANGED" } });
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapterId);
    expect(candidates.ok && candidates.value).toEqual([]);
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    expect(chapter.ok && chapter.value?.content).toBe(
      "A concurrent author save wins over the late provider response.",
    );
  });

  it.each(["archive", "save"] as const)(
    "fails the atomic output commit when a concurrent %s wins after the JS post-check",
    async (mutation) => {
      const created = await createRemoteRuntime();
      const originalCommit = created.runtime.contextTraceOutputs;
      let releaseCommit!: () => void;
      let commitStarted = false;
      const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      const runtime: DesktopRuntime = {
        ...created.runtime,
        contextTraceOutputs: {
          capability: originalCommit.capability,
          commit: async (input) => {
            commitStarted = true;
            await commitGate;
            return originalCommit.commit(input);
          },
        },
      };
      const plan = await prepareGenerationPlan(runtime, created.chapterId, {
        chapterSaved: true,
        networkAvailable: true,
      });

      const execution = executeGenerationPlan(runtime, plan);
      await vi.waitFor(() => expect(commitStarted).toBe(true));
      if (mutation === "archive") {
        if (plan.projectId === null) throw new Error("Expected a project-bound plan.");
        const archived = await runtime.useCases.archiveProject.execute({
          projectId: parseProjectId(plan.projectId),
        });
        if (!archived.ok) throw archived.error;
      } else {
        const edited = await runtime.useCases.editChapter.execute({
          chapterId: created.chapterId,
          expectedRevision: created.chapterRevision,
          content: "A save committed after the provider result and before Candidate commit.",
          cursorOffset: 10,
        });
        if (!edited.ok) throw edited.error;
        const saved = await runtime.useCases.saveChapter.execute({
          chapterId: created.chapterId,
          expectedRevision: created.chapterRevision,
          reason: "manual",
        });
        if (!saved.ok) throw saved.error;
      }
      releaseCommit();
      const result = await execution;

      expect(result).toMatchObject({ ok: false, error: { code: "CONTEXT_TRACE_UNAVAILABLE" } });
      const candidates = await runtime.repositories.aiCandidates.listByChapterId(created.chapterId);
      expect(candidates.ok && candidates.value).toEqual([]);
    },
  );

  it("does not repeat a DeepSeek visible-prose request when thinking was already disabled", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>().mockRejectedValue(
      new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "reasoning-only response", true, {
        requestId: "deepseek-reasoning-only",
        httpStatus: 200,
        finishReason: "length",
        visibleContentLength: 0,
        reasoningPresent: true,
        stream: true,
        inputTokens: 80,
        outputTokens: 64,
      }),
    );
    const { runtime, chapterId } = await createRemoteRuntime({
      generate,
      baseUrl: "https://api.deepseek.com",
    });
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const result = await executeGenerationPlan(runtime, plan);

    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_OUTPUT_TRUNCATED" } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ reasoningMode: "disabled" });
  });

  it("cancels the active reasoning-retry generation id rather than the first attempt", async () => {
    let resolveSecond!: (value: ReturnType<typeof generationResult>) => void;
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockRejectedValueOnce(
        new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "reasoning-only response", true, {
          requestId: "reasoning-cancel-first",
          httpStatus: 200,
          visibleContentLength: 0,
          reasoningPresent: true,
          finishReason: "length",
          stream: true,
          inputTokens: 80,
          outputTokens: 64,
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const cancelGeneration = vi.fn(() => Promise.resolve(true));
    const { runtime, chapterId } = await createRemoteRuntime({ generate, cancelGeneration });
    await seedModelHubContinuationRoute(runtime);
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const execution = executeGenerationPlan(runtime, plan);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    const firstId = generate.mock.calls[0]?.[0].generationId;
    const retryId = generate.mock.calls[1]?.[0].generationId;
    expect(retryId).not.toBe(firstId);
    await cancelGenerationPlan(runtime, plan);
    expect(cancelGeneration).toHaveBeenCalledWith(retryId);
    resolveSecond(generationResult("停止前已返回的正文。", 80, 20));
    await execution;
  });

  it("reuses a persisted retryable run and accumulates the next attempt estimate", async () => {
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockRejectedValueOnce(
        new ModelCenterError("MODEL_TIMEOUT", "Model generation timed out.", true),
      )
      .mockResolvedValueOnce(generationResult("重试后的候选。", 80, 20));
    const { runtime, chapterId } = await createNativeRuntime(generate);
    const current = await runtime.modelCenter.findByProviderId("local-ollama");
    if (current === null) {
      throw new Error("Expected a model profile.");
    }
    await runtime.modelCenter.save({
      providerId: current.providerId,
      provider: current.provider,
      baseUrl: current.baseUrl,
      authentication: current.authentication,
      selectedModel: current.selectedModel,
      pricing: {
        ...localPricing(),
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        pricingVersion: "paid-test",
      },
      expectedRevision: current.revision,
    });
    const firstPlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    const first = await executeGenerationPlan(runtime, firstPlan);
    expect(first.ok).toBe(false);
    await new Promise((resolve) => window.setTimeout(resolve, 1_050));

    const retryPlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    expect(retryPlan.taskId).toBe(firstPlan.taskId);
    expect(retryPlan.runId).toBe(firstPlan.runId);
    expect(retryPlan.idempotencyKey).toBe(firstPlan.idempotencyKey);
    const retry = await executeGenerationPlan(runtime, retryPlan);

    if (!retry.ok) {
      throw retry.error;
    }
    expect(generate).toHaveBeenCalledTimes(2);
    const run = await runtime.generationGovernance.findRunById(firstPlan.runId);
    expect(run).toMatchObject({ state: "completed", attempt: 2 });
    const estimate = firstPlan.preflight.estimate;
    if (estimate === null) {
      throw new Error("Expected a priced generation plan.");
    }
    expect(run?.incurredCostMicros).toBe((estimate.micros * 2n).toString());
    await expect(runtime.generationGovernance.listAttemptUsage(firstPlan.runId)).resolves.toEqual([
      expect.objectContaining({ attempt: 1, source: "provider_unavailable" }),
      expect.objectContaining({
        attempt: 2,
        source: "provider_reported",
        inputTokens: 80,
        outputTokens: 20,
      }),
    ]);
  });

  it("persists an offline cloud request without prompt text and consumes it after fresh confirmation", async () => {
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    const project = await developmentRuntime.useCases.createProject.execute({
      name: "离线待执行测试",
    });
    if (!project.ok) {
      throw project.error;
    }
    const chapter = await developmentRuntime.useCases.createChapter.execute({
      projectId: project.value.id,
      title: "第一章",
      content: "不能写入待执行记录的稳定正文。",
    });
    if (!chapter.ok) {
      throw chapter.error;
    }
    await developmentRuntime.modelCenter.save({
      providerId: "remote-writer",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example/v1",
      authentication: "none",
      selectedModel: "writer-model",
      pricing: {
        ...localPricing(),
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        pricingVersion: "remote-test",
      },
      expectedRevision: null,
    });
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve(generationResult("联网后的候选。", 100, 20)),
    );
    const modelGateway: NativeModelGatewayClient = {
      available: true,
      listModels: () =>
        Promise.resolve({
          provider: "open_ai_compatible",
          models: [{ id: "writer-model", displayName: "Writer model" }],
        }),
      checkConnection: () => Promise.reject(new Error("not used")),
      embed: () => Promise.reject(new Error("not used")),
      generate,
      cancelGeneration: () => Promise.resolve(true),
    };
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
    };

    const offlinePlan = await prepareGenerationPlan(runtime, chapter.value.chapter.id, {
      chapterSaved: true,
      networkAvailable: false,
    });
    expect(offlinePlan.preflight.checks.map(({ code }) => code)).toContain("NETWORK_OFFLINE");
    expect(canDeferGenerationPlan(offlinePlan)).toBe(true);
    const deferred = await saveDeferredGenerationPlan(runtime, offlinePlan);
    expect(deferred).toMatchObject({ status: "waiting_network", modelRole: "high_quality" });
    const serialized = window.localStorage.getItem(
      "inkshadow.development.generation-governance.v1",
    );
    expect(serialized).not.toMatch(/不能写入待执行记录|章节标题|当前正文|prompt|messages/iu);

    const onlinePlan = await prepareGenerationPlan(runtime, chapter.value.chapter.id, {
      chapterSaved: true,
      networkAvailable: true,
    });
    expect(onlinePlan.preflight.canStart).toBe(true);
    expect(onlinePlan.deferredRequest?.id).toBe(deferred.id);
    const executed = await executeGenerationPlan(runtime, onlinePlan);
    if (!executed.ok) {
      throw executed.error;
    }
    expect(generate).toHaveBeenCalledOnce();
    await expect(
      runtime.generationGovernance.findWaitingDeferredRequest(
        chapter.value.chapter.id,
        "high_quality",
      ),
    ).resolves.toBeNull();
    const tasks = await runtime.taskCenter.load();
    expect(tasks.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ai.generate.deferred", status: "cancelled" }),
        expect.objectContaining({ type: "ai.generate", status: "succeeded" }),
      ]),
    );
  });

  it("selects only the exact verified fallback and marks it for explicit confirmation", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    await runtime.modelCenter.save({
      providerId: "remote-primary",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example/v1",
      authentication: "none",
      selectedModel: "missing-primary-model",
      pricing: {
        ...localPricing(),
        pricingVersion: "remote-primary-test",
      },
      expectedRevision: null,
    });
    await runtime.modelRouting.saveRoute({
      role: "high_quality",
      primaryProviderId: "remote-primary",
      fallbackProviderId: "local-ollama",
      expectedRevision: null,
    });

    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(plan).toMatchObject({
      providerId: "local-ollama",
      modelId: "writer-model",
      modelRole: "high_quality",
      routeReason: "role_fallback",
      routeRequiresConfirmation: true,
      routeFallback: {
        providerId: "local-ollama",
        modelId: "writer-model",
      },
    });
    expect(plan.preflight.canStart).toBe(true);
  });

  it("invalidates a deferred request when the stable chapter version changes", async () => {
    const { runtime, chapterId, chapterRevision } = await createRemoteRuntime();
    const offlinePlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: false,
    });
    const deferred = await saveDeferredGenerationPlan(runtime, offlinePlan);

    const edited = await runtime.useCases.editChapter.execute({
      chapterId,
      expectedRevision: chapterRevision,
      content: "Stable content changed after the offline approval.",
      cursorOffset: 50,
    });
    if (!edited.ok) {
      throw edited.error;
    }
    const saved = await runtime.useCases.saveChapter.execute({
      chapterId,
      expectedRevision: chapterRevision,
      reason: "manual",
    });
    if (!saved.ok) {
      throw saved.error;
    }

    const freshPlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(freshPlan.deferredRequest).toBeNull();
    expect(freshPlan.idempotencyKey).not.toBe(`ai.generate.resume:${deferred.id}`);
    await expect(
      runtime.generationGovernance.findWaitingDeferredRequest(chapterId, "high_quality"),
    ).resolves.toBeNull();
    const tasks = await runtime.taskCenter.load();
    expect(tasks.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: deferred.taskId,
          type: "ai.generate.deferred",
          status: "cancelled",
        }),
      ]),
    );
    const serialized = window.localStorage.getItem(
      "inkshadow.development.generation-governance.v1",
    );
    expect(serialized).toContain('"status":"blocked_stale"');
    expect(serialized).not.toContain("Stable content changed after the offline approval.");
  });
});

async function createNativeRuntime(
  generate: NativeModelGatewayClient["generate"] = () =>
    Promise.resolve(generationResult("候选续写。", 100, 20)),
  cancelGeneration: NativeModelGatewayClient["cancelGeneration"] = () => Promise.resolve(true),
): Promise<{ runtime: DesktopRuntime; chapterId: Parameters<typeof prepareGenerationPlan>[1] }> {
  const developmentRuntime = createDevelopmentRuntime(window.localStorage);
  const project = await developmentRuntime.useCases.createProject.execute({
    name: "生成治理测试",
  });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await developmentRuntime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "第一章",
    content: "稳定正文。",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  await developmentRuntime.modelCenter.save({
    providerId: "local-ollama",
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    authentication: "none",
    selectedModel: "writer-model",
    pricing: localPricing(),
    expectedRevision: null,
  });
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    listModels: () =>
      Promise.resolve({
        provider: "ollama",
        models: [{ id: "writer-model", displayName: "Writer model" }],
      }),
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    generate,
    cancelGeneration,
  };
  return {
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
    },
    chapterId: chapter.value.chapter.id,
  };
}

function generationResult(text: string, inputTokens: number, outputTokens: number) {
  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: null,
    },
  } as const;
}

async function createRemoteRuntime(
  options: Readonly<{
    generate?: NativeModelGatewayClient["generate"];
    cancelGeneration?: NativeModelGatewayClient["cancelGeneration"];
    baseUrl?: string;
  }> = {},
): Promise<{
  runtime: DesktopRuntime;
  chapterId: Parameters<typeof prepareGenerationPlan>[1];
  chapterRevision: number;
}> {
  const developmentRuntime = createDevelopmentRuntime(window.localStorage);
  const project = await developmentRuntime.useCases.createProject.execute({
    name: "Deferred request stale-base test",
  });
  if (!project.ok) {
    throw project.error;
  }
  const chapter = await developmentRuntime.useCases.createChapter.execute({
    projectId: project.value.id,
    title: "Chapter one",
    content: "Initial stable content.",
  });
  if (!chapter.ok) {
    throw chapter.error;
  }
  await developmentRuntime.modelCenter.save({
    providerId: "remote-writer",
    provider: "open_ai_compatible",
    baseUrl: options.baseUrl ?? "https://models.example/v1",
    authentication: "none",
    selectedModel: "writer-model",
    pricing: {
      ...localPricing(),
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 2_000_000,
      pricingVersion: "remote-test",
    },
    expectedRevision: null,
  });
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    listModels: () =>
      Promise.resolve({
        provider: "open_ai_compatible",
        models: [{ id: "writer-model", displayName: "Writer model" }],
      }),
    checkConnection: () => Promise.reject(new Error("not used")),
    embed: () => Promise.reject(new Error("not used")),
    generate:
      options.generate ??
      (() => Promise.resolve(generationResult("Freshly generated candidate.", 100, 20))),
    cancelGeneration: options.cancelGeneration ?? (() => Promise.resolve(true)),
  };
  return {
    runtime: {
      ...developmentRuntime,
      mode: "tauri",
      modelGateway,
    },
    chapterId: chapter.value.chapter.id,
    chapterRevision: chapter.value.chapter.revision,
  };
}

async function seedModelHubContinuationRoute(runtime: DesktopRuntime): Promise<void> {
  const connection = await runtime.modelHub.saveConnection({
    id: "reasoning-retry-model-hub",
    providerKind: "custom_openai_compatible",
    displayName: "Reasoning retry Model Hub fixture",
    baseUrlOverride: "https://models.example/v1",
    credentialState: "missing",
    authenticationMode: "none",
    expectedRevision: null,
  });
  await runtime.modelHub.recordConnectionTest({
    connectionId: connection.id,
    status: "ready",
    expectedRevision: connection.revision,
  });
  await runtime.modelHub.syncCatalog({
    syncId: "reasoning-retry-model-hub-sync",
    connectionId: connection.id,
    source: "manual",
    status: "succeeded",
    models: [
      {
        id: "reasoning-retry-model-hub-catalog",
        providerModelId: "writer-model",
        lifecycle: "stable",
        inputTokenLimit: 32_000,
        outputTokenLimit: 8_000,
        staleAfter: "2027-08-10T00:00:00.000Z",
      },
    ],
  });
  await runtime.modelHub.recordCapabilityScan({
    scanId: "reasoning-retry-model-hub-scan",
    catalogEntryId: "reasoning-retry-model-hub-catalog",
    scanKind: "lightweight_probe",
    status: "succeeded",
    evidenceVersion: "generation-runtime-reasoning-retry-v1",
    evidence: [
      {
        id: "reasoning-retry-model-hub-text",
        capability: "text_generation",
        verdict: "supported",
        evidenceSource: "lightweight_probe",
      },
    ],
  });
  await runtime.modelHub.saveCostPrivacyProfile({
    catalogEntryId: "reasoning-retry-model-hub-catalog",
    currency: "USD",
    inputMicrosPerMillionTokens: "1000000",
    outputMicrosPerMillionTokens: "2000000",
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "generation-runtime-reasoning-retry-v1",
    priceUpdatedAt: "2026-08-10T00:00:00.000Z",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "generation-runtime-reasoning-retry-v1",
    expectedRevision: null,
  });
  await runtime.modelHub.saveTaskRoute({
    task: "continuation",
    primaryCatalogEntryId: "reasoning-retry-model-hub-catalog",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    routeOrigin: "user",
    expectedRevision: null,
  });
}

async function attachEnabledNovelSkills(
  runtime: DesktopRuntime,
  chapterId: Parameters<typeof prepareGenerationPlan>[1],
): Promise<{
  readonly runtime: DesktopRuntime;
  readonly persistence: GenerationNovelSkillPersistence;
}> {
  const chapter = await runtime.repositories.chapters.findById(chapterId);
  if (!chapter.ok || chapter.value === null) {
    throw new Error("Expected a chapter before enabling an experimental writing method.");
  }
  const persistence = new GenerationNovelSkillPersistence();
  const novelSkills = new TauriNovelSkillRuntime(persistence, runtime.clock);
  await novelSkills.initialize();
  const state = await novelSkills.listProjectState(chapter.value.projectId);
  const scene = state.methods.find(({ displayName }) => displayName === "场景推进");
  if (scene === undefined) {
    throw new Error("Expected the built-in scene method.");
  }
  await novelSkills.setMethodEnabled(chapter.value.projectId, scene.skillId, true);
  return {
    runtime: { ...runtime, novelSkills },
    persistence,
  };
}

class GenerationNovelSkillPersistence implements NovelSkillRuntimePersistence {
  readonly definitions = new Map<string, NovelSkillDefinition>();
  readonly bindings = new Map<string, ProjectNovelSkillBinding>();
  readonly commits: CommitNovelSkillInvocationInput[] = [];
  readonly snapshots = new Map<string, NovelSkillInvocationSnapshotRecord>();

  public insertDefinition(value: NovelSkillDefinition): Promise<NovelSkillDefinition> {
    this.definitions.set(`${value.skillId}@${value.version}`, value);
    return Promise.resolve(value);
  }

  public listDefinitions(): Promise<readonly NovelSkillDefinition[]> {
    return Promise.resolve([...this.definitions.values()]);
  }

  public listBindings(projectId: string): Promise<readonly ProjectNovelSkillBinding[]> {
    return Promise.resolve(
      [...this.bindings.values()].filter((binding) => binding.projectId === projectId),
    );
  }

  public saveBinding(
    value: ProjectNovelSkillBinding,
    expectedRevision: number,
  ): Promise<ProjectNovelSkillBinding> {
    const key = `${value.projectId}:${value.skillId}`;
    const current = this.bindings.get(key);
    if ((current?.revision ?? 0) !== expectedRevision) {
      return Promise.reject(new Error("Novel Skill test binding revision changed."));
    }
    this.bindings.set(key, value);
    return Promise.resolve(value);
  }

  public async commitInvocationBeforeDispatch(
    input: CommitNovelSkillInvocationInput,
  ): Promise<NovelSkillInvocationSnapshotRecord> {
    const currentBindings = await this.listBindings(input.projectId);
    const actual = currentBindings
      .map((binding) => ({
        skillId: binding.skillId,
        version: binding.pinnedVersion,
        enabled: binding.enabled,
        activationMode: binding.activationMode,
        taskEnabled: binding.taskOverrides[input.taskType]?.enabled ?? null,
        taskInvocationMode: binding.taskOverrides[input.taskType]?.invocationMode ?? null,
        revision: binding.revision,
      }))
      .sort((left, right) => left.skillId.localeCompare(right.skillId, "en"));
    const expected = input.compiled.configuration.bindings
      .map((binding) => ({
        skillId: binding.skillId,
        version: binding.version,
        enabled: binding.enabled,
        activationMode: binding.activationMode,
        taskEnabled: binding.taskEnabled,
        taskInvocationMode: binding.taskInvocationMode,
        revision: binding.revision,
      }))
      .sort((left, right) => left.skillId.localeCompare(right.skillId, "en"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("Novel Skill binding changed before dispatch.");
    }
    this.commits.push(input);
    const snapshot: NovelSkillInvocationSnapshotRecord = Object.freeze({
      id: input.snapshotId,
      projectId: input.projectId,
      contextTraceId: input.contextTraceId,
      modelInvocationId: input.modelInvocationId,
      taskType: input.taskType,
      invocationMode: input.invocationMode,
      compilerVersion: input.compiled.compilerVersion,
      maximumSkillTokens: input.compiled.configuration.maximumSkillTokens,
      usedSkillTokens: input.compiled.usedSkillTokens,
      discardedSkillTokens: input.compiled.discardedSkillTokens,
      selectionHash: input.compiled.selectionHash,
      configuration: input.compiled.configuration,
      items: input.compiled.items,
      createdAt: input.createdAt,
    });
    this.snapshots.set(input.contextTraceId, snapshot);
    return snapshot;
  }

  public findInvocationSnapshotByContextTrace(
    contextTraceId: string,
  ): Promise<NovelSkillInvocationSnapshotRecord | null> {
    return Promise.resolve(this.snapshots.get(contextTraceId) ?? null);
  }
}

function localPricing() {
  return {
    contextWindowTokens: 32_000,
    currency: "USD",
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion: "local-zero-cost",
    priceUpdatedAt: "2026-07-27T00:00:00.000Z",
  } as const;
}

function parseProjectId(value: string) {
  const parsed = parseUuidV7(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}
