// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NovelSkillDefinition, ProjectNovelSkillBinding } from "@inkshadow/ai-core";
import { createProjectSeed, ok, parseUuidV7, updateProjectSeedField } from "@inkshadow/domain";
import type { HybridSearchHit } from "@inkshadow/search-core";

import { ModelCenterError } from "./model-center-store";
import {
  readSafeGenerationErrorCodes,
  readSafeGenerationPreflightForScope,
  readSafeGenerationPreflightDiagnostic,
  readSafeInvocationRouteDiagnostic,
} from "./generation-preflight-diagnostics";
import { TauriNovelSkillRuntime, type NovelSkillRuntimePersistence } from "./novel-skill-runtime";
import type {
  CommitNovelSkillInvocationInput,
  NovelSkillInvocationSnapshotRecord,
} from "./novel-skill-sqlite-store";
import {
  canDeferGenerationPlan,
  cancelGenerationPlan,
  compileChapterStoryContext,
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
    const rerank = vi.spyOn(runtime.rerank, "tryRerank");
    const hybridSearch = vi.spyOn(runtime.search, "search");
    const ftsOnlySearch = vi.spyOn(runtime.search, "searchFtsOnly");
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
    expect(rerank).not.toHaveBeenCalled();
    expect(hybridSearch).not.toHaveBeenCalled();
    expect(ftsOnlySearch).toHaveBeenCalledWith(
      chapter.value.projectId,
      expect.any(String),
      expect.objectContaining({
        projectId: chapter.value.projectId,
        taskType: "continuation",
        privacy: "standard_only",
        currentness: "current",
        branchId: null,
        povCharacterId: null,
        maximumStoryOrder: expect.any(Number) as number,
      }),
      32,
    );
    expect(plan.contextCompilation?.retrievalTrace).toMatchObject({
      hardFilters: [
        "project",
        "canon",
        "current_version",
        "active_chapter",
        "branch",
        "privacy",
        "currentness",
        "story_time",
        "pov",
        "task_type",
      ],
      scopeOmissions: [],
      versionMode: "per_source_current",
      vectorStatus: "optional_not_needed",
      remoteRerankStatus: "optional_skipped",
    });
  });

  it("runs fact, alias, time and location queries through content-free scoped traces only", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) {
      throw new Error("Expected the generated test chapter.");
    }
    const generated = vi.spyOn(runtime.modelGateway, "generate");
    const embedded = vi.spyOn(runtime.modelGateway, "embed");
    const hybridSearch = vi.spyOn(runtime.search, "search");
    const remoteRerank = vi.spyOn(runtime.rerank, "tryRerank");
    const plannedHits = [
      retrievalHit(
        "fact-plan",
        "FACT_PLAN_EVIDENCE",
        chapter.value.projectId,
        chapter.value.currentVersionId,
        {},
      ),
      retrievalHit(
        "alias-plan",
        "ALIAS_PLAN_EVIDENCE",
        chapter.value.projectId,
        chapter.value.currentVersionId,
        {},
      ),
      retrievalHit(
        "time-plan",
        "TIME_PLAN_EVIDENCE",
        chapter.value.projectId,
        chapter.value.currentVersionId,
        {},
      ),
      retrievalHit(
        "location-plan",
        "LOCATION_PLAN_EVIDENCE",
        chapter.value.projectId,
        chapter.value.currentVersionId,
        {},
      ),
    ];
    let callIndex = 0;
    const ftsOnlySearch = vi.spyOn(runtime.search, "searchFtsOnly").mockImplementation(() => {
      const hit = plannedHits[callIndex++];
      if (hit === undefined) throw new Error("The bounded query plan exceeded its fixture.");
      return Promise.resolve(scopedFtsResponse(runtime, [hit]));
    });
    const sourceQuestion = "林晚又名阿晚，翌日清晨在北塔门口交出铜钥匙。";

    const compiled = await compileChapterStoryContext(runtime, chapter.value, {
      currentTask: continuationContextTask(chapter.value.currentVersionId, "trace-task"),
      retrievalQuery: sourceQuestion,
      maximumContextTokens: 20_000,
    });

    expect(ftsOnlySearch).toHaveBeenCalledTimes(4);
    expect(ftsOnlySearch.mock.calls.every(([, query]) => query.length <= 80)).toBe(true);
    expect(compiled.retrievalTrace.queryTrace).toEqual([
      expect.objectContaining({
        sourceId: "trace-task",
        sourceType: "current_task",
        queryType: "fact",
        stage: "initial",
        resultCount: 1,
        eligibleResultCount: 1,
        fusionWeight: 1,
        omissionReason: null,
        recoveryReason: null,
      }),
      expect.objectContaining({ queryType: "alias", fusionWeight: 0.9 }),
      expect.objectContaining({ queryType: "time", fusionWeight: 0.75 }),
      expect.objectContaining({ queryType: "location", fusionWeight: 0.75 }),
    ]);
    expect(compiled.retrievalTrace.recoveryOutcome).toBe("not_needed");
    expect(compiled.retrievalTrace.uniqueQueryCount).toBe(4);
    expect(
      compiled.retrievalTrace.queryTrace.every(
        ({ appliedFilterCategories, scopeTrace }) =>
          [
            "project",
            "canon",
            "current_version",
            "active_chapter",
            "branch",
            "privacy",
            "currentness",
            "story_time",
            "pov",
            "task_type",
          ].every((filter) => appliedFilterCategories.includes(filter)) &&
          scopeTrace?.taskType === "continuation",
      ),
    ).toBe(true);
    const serializedTrace = JSON.stringify(compiled.retrievalTrace.queryTrace);
    expect(serializedTrace).not.toContain(sourceQuestion);
    expect(serializedTrace).not.toMatch(/林晚|阿晚|北塔|铜钥匙/u);
    expect(Object.keys(compiled.retrievalTrace.queryTrace[0] ?? {})).not.toEqual(
      expect.arrayContaining(["query", "sourceQuestion"]),
    );
    expect(compiled.retrievalTrace.includedDocumentIds).toEqual(
      expect.arrayContaining(plannedHits.map(({ document }) => document.id)),
    );
    expect(generated).not.toHaveBeenCalled();
    expect(embedded).not.toHaveBeenCalled();
    expect(hybridSearch).not.toHaveBeenCalled();
    expect(remoteRerank).not.toHaveBeenCalled();
  });

  it("records a deterministic fallback query without persisting its text", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) {
      throw new Error("Expected the generated test chapter.");
    }
    const ftsOnlySearch = vi
      .spyOn(runtime.search, "searchFtsOnly")
      .mockResolvedValue(
        scopedFtsResponse(runtime, [
          retrievalHit(
            "fallback-one",
            "FALLBACK_ONE",
            chapter.value.projectId,
            chapter.value.currentVersionId,
            {},
          ),
          retrievalHit(
            "fallback-two",
            "FALLBACK_TWO",
            chapter.value.projectId,
            chapter.value.currentVersionId,
            {},
          ),
        ]),
      );

    const compiled = await compileChapterStoryContext(runtime, chapter.value, {
      currentTask: continuationContextTask(chapter.value.currentVersionId, "fallback-task"),
      retrievalQuery: "……",
      maximumContextTokens: 20_000,
    });

    expect(ftsOnlySearch).toHaveBeenCalledWith(
      chapter.value.projectId,
      "人物 时间 地点 关系",
      expect.objectContaining({ taskType: "continuation" }),
      32,
    );
    expect(compiled.retrievalTrace.queryTrace).toEqual([
      expect.objectContaining({
        sourceId: "fallback-task",
        sourceType: "current_task",
        queryType: "fallback",
        stage: "initial",
        fusionWeight: 0.5,
      }),
    ]);
    expect(JSON.stringify(compiled.retrievalTrace.queryTrace)).not.toContain("人物 时间 地点 关系");
    expect(compiled.retrievalTrace.recoveryOutcome).toBe("not_needed");
    expect(compiled.retrievalTrace.uniqueQueryCount).toBe(1);
  });

  it("expands K then performs bounded FTS rewrite and multi-query recovery", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) {
      throw new Error("Expected the generated test chapter.");
    }
    const currentChapter = chapter.value;
    let callIndex = 0;
    vi.spyOn(runtime.search, "searchFtsOnly").mockImplementation(() => {
      const currentCall = callIndex++;
      const hits =
        currentCall === 2
          ? [
              retrievalHit(
                "rewrite-recovery",
                "REWRITE_RECOVERY_EVIDENCE",
                currentChapter.projectId,
                currentChapter.currentVersionId,
                {},
              ),
            ]
          : currentCall === 3
            ? [
                retrievalHit(
                  "multi-query-recovery",
                  "MULTI_QUERY_RECOVERY_EVIDENCE",
                  currentChapter.projectId,
                  currentChapter.currentVersionId,
                  {},
                ),
              ]
            : [];
      return Promise.resolve(scopedFtsResponse(runtime, hits));
    });

    const compiled = await compileChapterStoryContext(runtime, currentChapter, {
      currentTask: continuationContextTask(currentChapter.currentVersionId, "recovery-task"),
      retrievalQuery:
        "林晚追查那枚消失已久的青铜钥匙背后的隐秘线索；周野核对旧港仓库遗留多年的航行记录与签章",
      maximumContextTokens: 20_000,
    });

    expect(compiled.retrievalTrace.queryTrace.map(({ stage }) => stage)).toEqual([
      "initial",
      "expand_k",
      "recovery",
      "recovery",
    ]);
    expect(compiled.retrievalTrace.queryTrace.map(({ recoveryReason }) => recoveryReason)).toEqual([
      null,
      "expand_k",
      "fts_rewrite",
      "bounded_multi_query",
    ]);
    expect(compiled.retrievalTrace.queryTrace.map(({ omissionReason }) => omissionReason)).toEqual([
      "no_match",
      "no_match",
      null,
      null,
    ]);
    expect(compiled.retrievalTrace.queryTrace.map(({ limit }) => limit)).toEqual([32, 64, 32, 32]);
    expect(compiled.retrievalTrace.queryTrace.map(({ queryPlanId }) => queryPlanId)).toEqual([
      "local-query-1",
      "local-query-1",
      "local-query-2",
      "local-query-3",
    ]);
    expect(compiled.retrievalTrace.uniqueQueryCount).toBe(3);
    expect(compiled.retrievalTrace.uniqueQueryCount).toBeLessThanOrEqual(4);
    expect(compiled.retrievalTrace.recoveryOutcome).toBe("recovered");
    expect(compiled.retrievalTrace.notices).not.toContain(
      "continuation_evidence_insufficient_after_bounded_local_recovery",
    );
  });

  it("keeps stale, future, private, branch and POV search hits out of the final request", async () => {
    const { runtime, chapterId } = await createNativeRuntime();
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) {
      throw new Error("Expected the generated test chapter.");
    }
    const safeText = "SAFE_CURRENT_CANON_EVIDENCE";
    const unsafeTexts = [
      "STALE_EVIDENCE",
      "FUTURE_EVIDENCE",
      "PRIVATE_REMOTE_EVIDENCE",
      "WRONG_BRANCH_EVIDENCE",
      "WRONG_POV_EVIDENCE",
      "REBUILDABLE_EVIDENCE",
    ] as const;
    const hits = [
      retrievalHit("safe", safeText, chapter.value.projectId, chapter.value.currentVersionId, {}),
      retrievalHit(
        "stale",
        unsafeTexts[0],
        chapter.value.projectId,
        chapter.value.currentVersionId,
        {
          currentness: "stale",
        },
      ),
      retrievalHit(
        "future",
        unsafeTexts[1],
        chapter.value.projectId,
        chapter.value.currentVersionId,
        { storyOrder: 99 },
      ),
      retrievalHit(
        "private",
        unsafeTexts[2],
        chapter.value.projectId,
        chapter.value.currentVersionId,
        {
          privacy: "local_only",
        },
      ),
      retrievalHit(
        "branch",
        unsafeTexts[3],
        chapter.value.projectId,
        chapter.value.currentVersionId,
        {
          branchId: "what-if",
        },
      ),
      retrievalHit("pov", unsafeTexts[4], chapter.value.projectId, chapter.value.currentVersionId, {
        povCharacterId: "other-character",
      }),
      retrievalHit(
        "rebuildable",
        unsafeTexts[5],
        chapter.value.projectId,
        chapter.value.currentVersionId,
        {
          authority: "rebuildable",
        },
      ),
    ];
    vi.spyOn(runtime.search, "searchFtsOnly").mockResolvedValue(
      ok({
        hits,
        retrievalScopeTrace: {
          taskType: "continuation",
          omittedHardFilters: [],
          authorityNeutralOmissions: ["branch", "pov"],
          versionMode: "per_source_current",
        },
        health: runtime.search.health(),
        capabilities: { keyword: "ready", vector: "disabled", relation: "ready" },
        notices: [],
      }),
    );

    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    const prompt = plan.messages.map(({ content }) => content).join("\n");
    expect(prompt).toContain(safeText);
    for (const unsafeText of unsafeTexts) {
      expect(prompt).not.toContain(unsafeText);
    }
    expect(plan.contextCompilation?.retrievalTrace.omissions.map(({ reason }) => reason)).toEqual(
      expect.arrayContaining([
        "stale_version",
        "future_knowledge",
        "privacy_scope_mismatch",
        "branch_mismatch",
        "pov_mismatch",
        "non_canon_authority",
      ]),
    );
    const retrievalTrace = plan.contextCompilation?.retrievalTrace;
    expect(retrievalTrace?.recoveryOutcome).toBe("evidence_insufficient");
    expect(retrievalTrace?.uniqueQueryCount).toBe(1);
    expect(retrievalTrace?.queryTrace[0]).toMatchObject({
      queryPlanId: "local-query-1",
      stage: "initial",
      omissionReason: null,
    });
    expect(retrievalTrace?.queryTrace[1]).toMatchObject({
      queryPlanId: "local-query-1",
      stage: "expand_k",
      recoveryReason: "expand_k",
    });
    expect(retrievalTrace?.notices).toContain(
      "continuation_evidence_insufficient_after_bounded_local_recovery",
    );
  });

  it("warns without price metadata and exposes a source-backed estimate after configuration", async () => {
    const { runtime, chapterId } = await createRemoteRuntime({ seedModelHubRoute: false });
    await seedModelHubContinuationRoute(runtime, {
      pricing: "unknown",
      knownTokenLimits: false,
    });

    const unpriced = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
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

    const unknownPricing = await runtime.modelHub.findCostPrivacyProfile(
      "reasoning-retry-model-hub-catalog",
    );
    if (unknownPricing === null) throw new Error("Expected the unpriced Model Hub fixture.");
    await runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: unknownPricing.catalogEntryId,
      currency: "USD",
      inputMicrosPerMillionTokens: "1000000",
      outputMicrosPerMillionTokens: "2000000",
      cachedInputMicrosPerMillionTokens: "0",
      pricingVersion: "configured-remote-test",
      priceUpdatedAt: "2026-08-10T00:00:00.000Z",
      dataDestination: unknownPricing.dataDestination,
      retentionPolicy: unknownPricing.retentionPolicy,
      trainingPolicy: unknownPricing.trainingPolicy,
      evidenceSource: unknownPricing.evidenceSource,
      evidenceVersion: unknownPricing.evidenceVersion,
      expectedRevision: unknownPricing.revision,
    });
    const ready = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    expect(ready.preflight.canStart).toBe(true);
    expect(ready.preflight.estimate).toMatchObject({
      pricingVersion: "configured-remote-test",
    });
    expect(ready.preflight.estimate?.micros).toBeGreaterThan(0n);
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
    const created = await createRemoteRuntime({ generate, seedModelHubRoute: false });
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

    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_HUB_PREFLIGHT_FAILED" } });
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

  it("does not hide a second Provider call behind reasoning-only truncation", async () => {
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
    const created = await createRemoteRuntime({ generate, seedModelHubRoute: false });
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

    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_OUTPUT_TRUNCATED" } });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
    expect(generate.mock.calls[0]?.[0].reasoningMode).toBeUndefined();
    const candidates = await runtime.repositories.aiCandidates.listByChapterId(chapterId);
    expect(candidates.ok && candidates.value).toHaveLength(0);
    const chapter = await runtime.repositories.chapters.findById(chapterId);
    if (!chapter.ok || chapter.value === null) throw new Error("Expected the test chapter.");
    const traces = (await runtime.contextTraces.listByProjectId(chapter.value.projectId)).filter(
      ({ execution }) => execution?.generationRunId === plan.runId,
    );
    expect(traces).toHaveLength(1);
    expect(new Set(traces.map(({ id }) => id)).size).toBe(1);
    expect(new Set(traces.map(({ execution }) => execution?.generationId)).size).toBe(1);
    expect(
      new Set(traces.map(({ execution }) => execution?.modelInvocationId).filter(Boolean)).size,
    ).toBe(1);
    expect(experimental.persistence.commits).toHaveLength(1);
    expect(new Set(experimental.persistence.commits.map(({ snapshotId }) => snapshotId)).size).toBe(
      1,
    );
    expect(
      new Set(experimental.persistence.commits.map(({ contextTraceId }) => contextTraceId)).size,
    ).toBe(1);
    expect(
      new Set(experimental.persistence.commits.map(({ modelInvocationId }) => modelInvocationId))
        .size,
    ).toBe(1);
    expect(
      new Set(experimental.persistence.commits.map(({ contextTraceId }) => contextTraceId)),
    ).toEqual(new Set(traces.map(({ id }) => id)));
    expect(traces).toEqual([expect.objectContaining({ outputCandidateId: null })]);
  });

  it("executes a direct continuation once with zero retries despite connection retry settings", async () => {
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockRejectedValueOnce(
        new ModelCenterError("MODEL_OUTPUT_TRUNCATED", "reasoning used the output budget", true, {
          requestId: "direct-zero-retry",
          httpStatus: 200,
          finishReason: "length",
          visibleContentLength: 0,
          reasoningPresent: true,
          stream: true,
          inputTokens: 80,
          outputTokens: 64,
        }),
      )
      .mockResolvedValueOnce(generationResult("不应自动发起的第二次调用。", 80, 20));
    const { runtime, chapterId } = await createRemoteRuntime({
      generate,
      seedModelHubRoute: false,
    });
    await seedModelHubContinuationRoute(runtime, { retryLimit: 3 });
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const result = await executeGenerationPlan(runtime, plan, undefined, {
      generationRetryLimit: 0,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_OUTPUT_TRUNCATED" } });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
  });

  it("uses a valid Model Hub continuation route without consulting an unselected legacy profile", async () => {
    const created = await createRemoteRuntime({ seedModelHubRoute: false });
    const legacy = await created.runtime.modelCenter.findByProviderId("remote-writer");
    if (legacy === null) throw new Error("Expected the compatibility profile.");
    await created.runtime.modelCenter.save({
      providerId: legacy.providerId,
      provider: legacy.provider,
      baseUrl: legacy.baseUrl,
      authentication: legacy.authentication,
      selectedModel: null,
      pricing: null,
      expectedRevision: legacy.revision,
    });
    await seedModelHubContinuationRoute(created.runtime);
    const legacyRead = vi
      .spyOn(created.runtime.modelCenter, "listProfiles")
      .mockRejectedValue(new Error("legacy profiles must not gate Model Hub continuation"));

    const plan = await prepareGenerationPlan(created.runtime, created.chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(plan).toMatchObject({
      executionMode: "model_hub",
      providerId: "reasoning-retry-model-hub",
      modelId: "writer-model",
      profile: null,
    });
    expect(plan.preflight.canStart).toBe(true);
    expect(legacyRead).not.toHaveBeenCalled();
    expect(readSafeInvocationRouteDiagnostic(created.runtime)).toMatchObject({
      modelHubRouteFound: true,
      legacyProfileChecked: false,
      routeSource: "model_hub",
      ready: true,
      blockerCode: null,
    });
  });

  it("uses the full-input fallback as the frozen continuation target", async () => {
    const created = await createRemoteRuntime({ seedModelHubRoute: false });
    await seedModelHubContinuationRoute(created.runtime, {
      primaryInputTokenLimit: 3_400,
      includeFallback: true,
    });

    const plan = await prepareGenerationPlan(created.runtime, created.chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    expect(plan).toMatchObject({
      executionMode: "model_hub",
      providerId: "reasoning-retry-fallback-model-hub",
      modelId: "fallback-writer-model",
      routeReason: "model_hub_fallback",
      routeRequiresConfirmation: true,
    });
    expect(readSafeInvocationRouteDiagnostic(created.runtime)).toMatchObject({
      resolvedConnectionId: "reasoning-retry-fallback-model-hub",
      resolvedModelId: "fallback-writer-model",
      routeSource: "model_hub",
      ready: true,
    });
  });

  it("fails closed on an invalid existing Model Hub route and records the early preflight blocker", async () => {
    const created = await createRemoteRuntime({ seedModelHubRoute: false });
    await seedModelHubContinuationRoute(created.runtime);
    await created.runtime.modelHub.syncCatalog({
      syncId: "invalid-existing-continuation-route-sync",
      connectionId: "reasoning-retry-model-hub",
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "reasoning-retry-model-hub-catalog",
          providerModelId: "writer-model",
          lifecycle: "deprecated",
          inputTokenLimit: 32_000,
          outputTokenLimit: 8_000,
        },
      ],
    });
    const legacyRead = vi
      .spyOn(created.runtime.modelCenter, "listProfiles")
      .mockRejectedValue(new Error("invalid Model Hub routes must not fall back to legacy"));
    const startInvocation = vi.spyOn(created.runtime.modelHub, "startInvocation");
    const createCandidate = vi.spyOn(created.runtime.repositories.aiCandidates, "create");
    const createRun = vi.spyOn(created.runtime.generationGovernance, "createRun");

    await expect(
      prepareGenerationPlan(created.runtime, created.chapterId, {
        chapterSaved: true,
        networkAvailable: true,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_CATALOG_ENTRY_UNAVAILABLE" });

    expect(legacyRead).not.toHaveBeenCalled();
    expect(readSafeInvocationRouteDiagnostic(created.runtime)).toMatchObject({
      modelHubRouteFound: true,
      legacyProfileChecked: false,
      routeSource: "none",
      ready: false,
      blockerCode: "MODEL_HUB_CATALOG_ENTRY_UNAVAILABLE",
    });
    expect(readSafeGenerationPreflightDiagnostic(created.runtime)).toMatchObject({
      taskType: "continuation",
      routeFound: true,
      readiness: "BLOCKED",
      blockerCodes: ["MODEL_HUB_CATALOG_ENTRY_UNAVAILABLE"],
    });
    expect(readSafeGenerationErrorCodes(created.runtime)).toContain(
      "MODEL_HUB_CATALOG_ENTRY_UNAVAILABLE",
    );
    const chapter = await created.runtime.repositories.chapters.findById(created.chapterId);
    if (!chapter.ok || chapter.value === null) throw new Error("Expected the test chapter.");
    expect(
      readSafeGenerationPreflightForScope(created.runtime, {
        projectId: chapter.value.projectId,
        chapterId: chapter.value.id,
      }),
    ).toMatchObject({
      readiness: "BLOCKED",
      blockerCodes: ["MODEL_HUB_CATALOG_ENTRY_UNAVAILABLE"],
    });
    expect(startInvocation).not.toHaveBeenCalled();
    expect(createCandidate).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("does not bypass an explicitly disabled Model Hub route through the legacy profile", async () => {
    const created = await createRemoteRuntime({ seedModelHubRoute: false });
    await seedModelHubContinuationRoute(created.runtime);
    const route = await created.runtime.modelHub.findTaskRoute("continuation");
    if (route === null) throw new Error("Expected the continuation route.");
    await created.runtime.modelHub.saveTaskRoute({
      task: route.task,
      primaryCatalogEntryId: route.primaryCatalogEntryId,
      fallbackCatalogEntryId: route.fallbackCatalogEntryId,
      presetId: route.presetId,
      parameterPolicy: route.parameterPolicy,
      maximumCostMicros: route.maximumCostMicros,
      currency: route.currency,
      privacyPolicy: route.privacyPolicy,
      failurePolicy: route.failurePolicy,
      routeOrigin: route.routeOrigin,
      enabled: false,
      expectedRevision: route.revision,
    });
    const legacyRead = vi.spyOn(created.runtime.modelCenter, "listProfiles");

    await expect(
      prepareGenerationPlan(created.runtime, created.chapterId, {
        chapterSaved: true,
        networkAvailable: true,
      }),
    ).rejects.toMatchObject({ code: "MODEL_HUB_ROUTE_DISABLED" });

    expect(legacyRead).not.toHaveBeenCalled();
    expect(readSafeInvocationRouteDiagnostic(created.runtime)).toMatchObject({
      modelHubRouteFound: true,
      legacyProfileChecked: false,
      routeSource: "none",
      ready: false,
      blockerCode: "MODEL_HUB_ROUTE_DISABLED",
    });
  });

  it("publishes a scoped private-chapter blocker without creating billable or candidate state", async () => {
    const created = await createRemoteRuntime({ seedModelHubRoute: false });
    const chapter = await created.runtime.repositories.chapters.findById(created.chapterId);
    if (!chapter.ok || chapter.value === null) throw new Error("Expected the test chapter.");
    const privateChapter = await created.runtime.useCases.setChapterPrivacy.execute({
      chapterId: chapter.value.id,
      privacyMode: "local_only",
      expectedPrivacyRevision: chapter.value.privacyRevision,
    });
    if (!privateChapter.ok) throw privateChapter.error;
    await seedModelHubContinuationRoute(created.runtime);
    const generate = vi.spyOn(created.runtime.modelGateway, "generate");
    const startInvocation = vi.spyOn(created.runtime.modelHub, "startInvocation");
    const createCandidate = vi.spyOn(created.runtime.repositories.aiCandidates, "create");
    const createRun = vi.spyOn(created.runtime.generationGovernance, "createRun");

    await expect(
      prepareGenerationPlan(created.runtime, created.chapterId, {
        chapterSaved: true,
        networkAvailable: true,
      }),
    ).rejects.toMatchObject({ code: "PRIVATE_CHAPTER_LOCAL_ONLY" });

    expect(
      readSafeGenerationPreflightForScope(created.runtime, {
        projectId: privateChapter.value.chapter.projectId,
        chapterId: privateChapter.value.chapter.id,
      }),
    ).toMatchObject({
      taskType: "continuation",
      readiness: "BLOCKED",
      blockerCodes: ["PRIVATE_CHAPTER_LOCAL_ONLY"],
    });
    expect(generate).not.toHaveBeenCalled();
    expect(startInvocation).not.toHaveBeenCalled();
    expect(createCandidate).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("fails closed before provider dispatch when an enabled writing method changes after preparation", async () => {
    const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
      Promise.resolve(generationResult("This must never be dispatched.", 80, 20)),
    );
    const created = await createRemoteRuntime({ generate, seedModelHubRoute: false });
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
    const created = await createRemoteRuntime({
      generate,
      cancelGeneration,
      seedModelHubRoute: false,
    });
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
    const created = await createRemoteRuntime({ generate, seedModelHubRoute: false });
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
    const { runtime, chapterId } = await createRemoteRuntime({
      generate,
      cancelGeneration,
    });
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

  it("does not create a phantom retry generation after reasoning-only truncation", async () => {
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
      .mockResolvedValueOnce(generationResult("不应自动发起的第二次调用。", 80, 20));
    const cancelGeneration = vi.fn(() => Promise.resolve(true));
    const { runtime, chapterId } = await createRemoteRuntime({
      generate,
      cancelGeneration,
      seedModelHubRoute: false,
    });
    await seedModelHubContinuationRoute(runtime);
    const plan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });

    const result = await executeGenerationPlan(runtime, plan);

    expect(result).toMatchObject({ ok: false, error: { code: "MODEL_OUTPUT_TRUNCATED" } });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
    await expect(cancelGenerationPlan(runtime, plan)).resolves.toBe(true);
    expect(cancelGeneration).toHaveBeenCalledOnce();
    expect(cancelGeneration).toHaveBeenCalledWith(plan.generationId);
  });

  it("does not reuse an ambiguously failed Provider action as an automatic retry", async () => {
    const generate = vi
      .fn<NativeModelGatewayClient["generate"]>()
      .mockRejectedValueOnce(
        new ModelCenterError("MODEL_TIMEOUT", "Model generation timed out.", true),
      )
      .mockResolvedValueOnce(generationResult("重试后的候选。", 80, 20));
    const { runtime, chapterId } = await createNativeRuntime(generate);
    const currentPricing = await runtime.modelHub.findCostPrivacyProfile(
      "reasoning-retry-model-hub-catalog",
    );
    if (currentPricing === null) throw new Error("Expected Model Hub pricing evidence.");
    await runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: currentPricing.catalogEntryId,
      currency: "USD",
      inputMicrosPerMillionTokens: "1000000",
      outputMicrosPerMillionTokens: "2000000",
      cachedInputMicrosPerMillionTokens: "0",
      pricingVersion: "paid-model-hub-test",
      priceUpdatedAt: "2026-08-10T00:00:00.000Z",
      dataDestination: currentPricing.dataDestination,
      retentionPolicy: currentPricing.retentionPolicy,
      trainingPolicy: currentPricing.trainingPolicy,
      evidenceSource: currentPricing.evidenceSource,
      evidenceVersion: currentPricing.evidenceVersion,
      expectedRevision: currentPricing.revision,
    });
    const firstPlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    const first = await executeGenerationPlan(runtime, firstPlan);
    expect(first.ok).toBe(false);
    const firstRun = await runtime.generationGovernance.findRunById(firstPlan.runId);
    expect(firstRun).toMatchObject({
      state: "failed_final",
      attempt: 1,
      providerId: firstPlan.providerId,
      modelId: firstPlan.modelId,
      pricingVersion: "paid-model-hub-test",
      estimatedCostMicros: firstPlan.preflight.estimate?.micros.toString(),
    });

    const nextPlan = await prepareGenerationPlan(runtime, chapterId, {
      chapterSaved: true,
      networkAvailable: true,
    });
    expect(nextPlan.preflight.estimate).toEqual(firstPlan.preflight.estimate);
    expect(nextPlan.taskId).not.toBe(firstPlan.taskId);
    expect(nextPlan.runId).not.toBe(firstPlan.runId);
    expect(nextPlan.idempotencyKey).not.toBe(firstPlan.idempotencyKey);
    const next = await executeGenerationPlan(runtime, nextPlan);

    if (!next.ok) {
      throw next.error;
    }
    expect(generate).toHaveBeenCalledTimes(2);
    await expect(runtime.generationGovernance.findRunById(firstPlan.runId)).resolves.toMatchObject({
      state: "failed_final",
      attempt: 1,
    });
    const nextRun = await runtime.generationGovernance.findRunById(nextPlan.runId);
    expect(nextRun).toMatchObject({ state: "completed", attempt: 1 });
    const estimate = firstPlan.preflight.estimate;
    if (estimate === null) {
      throw new Error("Expected a priced generation plan.");
    }
    expect(firstRun?.incurredCostMicros).toBe(estimate.micros.toString());
    expect(nextRun?.incurredCostMicros).toBe(estimate.micros.toString());
    await expect(runtime.generationGovernance.listAttemptUsage(firstPlan.runId)).resolves.toEqual([
      expect.objectContaining({ attempt: 1, source: "provider_unavailable" }),
    ]);
    await expect(runtime.generationGovernance.listAttemptUsage(nextPlan.runId)).resolves.toEqual([
      expect.objectContaining({
        attempt: 1,
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
    await seedModelHubContinuationRoute(runtime);

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

  it("does not bypass the frozen Model Hub target through a legacy role fallback", async () => {
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
      executionMode: "model_hub",
      providerId: "reasoning-retry-model-hub",
      modelId: "writer-model",
      modelRole: "high_quality",
      routeReason: "model_hub_primary",
      routeRequiresConfirmation: false,
      routeFallback: null,
      profile: null,
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
  const runtime: DesktopRuntime = {
    ...developmentRuntime,
    mode: "tauri",
    modelGateway,
  };
  await seedModelHubContinuationRoute(runtime, {
    providerKind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    dataDestination: "local",
    pricing: "local_zero",
  });
  return {
    runtime,
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
    seedModelHubRoute?: boolean;
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
  const usesFixtureCredential = options.baseUrl === "https://api.deepseek.com";
  const runtime: DesktopRuntime = {
    ...developmentRuntime,
    mode: "tauri",
    modelGateway,
    ...(usesFixtureCredential
      ? {
          credentials: {
            getSummary: () => Promise.resolve({ configured: true, lastFour: "test" }),
            save: () => Promise.resolve({ configured: true, lastFour: "test" }),
            delete: () => Promise.resolve({ configured: false, lastFour: null }),
          },
        }
      : {}),
  };
  if (options.seedModelHubRoute !== false) {
    const baseUrl = options.baseUrl ?? "https://models.example/v1";
    await seedModelHubContinuationRoute(runtime, {
      providerKind:
        baseUrl === "https://api.deepseek.com" ? "deepseek" : "custom_openai_compatible",
      baseUrl,
      dataDestination: "remote",
      pricing: "remote_test",
    });
  }
  return {
    runtime,
    chapterId: chapter.value.chapter.id,
    chapterRevision: chapter.value.chapter.revision,
  };
}

async function seedModelHubContinuationRoute(
  runtime: DesktopRuntime,
  options: Readonly<{
    primaryInputTokenLimit?: number;
    includeFallback?: boolean;
    retryLimit?: number;
    providerKind?: "ollama" | "deepseek" | "custom_openai_compatible";
    baseUrl?: string;
    dataDestination?: "local" | "remote";
    pricing?: "local_zero" | "remote_test" | "unknown";
    knownTokenLimits?: boolean;
  }> = {},
): Promise<void> {
  const providerKind = options.providerKind ?? "custom_openai_compatible";
  const connectionId = "reasoning-retry-model-hub";
  const usesCredential = providerKind === "deepseek";
  const connection = await runtime.modelHub.saveConnection({
    id: connectionId,
    providerKind,
    displayName: "Reasoning retry Model Hub fixture",
    baseUrlOverride: options.baseUrl ?? "https://models.example/v1",
    credentialState: usesCredential ? "present" : "missing",
    authenticationMode: usesCredential ? "bearer_keyring" : "none",
    ...(usesCredential ? { credentialRef: `keyring:model-hub:${connectionId}` } : {}),
    ...(options.retryLimit === undefined ? {} : { retryLimit: options.retryLimit }),
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
        inputTokenLimit:
          options.knownTokenLimits === false ? null : (options.primaryInputTokenLimit ?? 32_000),
        outputTokenLimit: options.knownTokenLimits === false ? null : 8_000,
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
  const pricing = options.pricing ?? "remote_test";
  await runtime.modelHub.saveCostPrivacyProfile({
    catalogEntryId: "reasoning-retry-model-hub-catalog",
    currency: pricing === "unknown" ? null : "USD",
    inputMicrosPerMillionTokens:
      pricing === "unknown" ? null : pricing === "local_zero" ? "0" : "1000000",
    outputMicrosPerMillionTokens:
      pricing === "unknown" ? null : pricing === "local_zero" ? "0" : "2000000",
    cachedInputMicrosPerMillionTokens: pricing === "unknown" ? null : "0",
    pricingVersion: pricing === "unknown" ? null : `generation-runtime-${pricing}-v1`,
    priceUpdatedAt: pricing === "unknown" ? null : "2026-08-10T00:00:00.000Z",
    dataDestination: options.dataDestination ?? "remote",
    retentionPolicy: options.dataDestination === "local" ? "none" : "provider_default",
    trainingPolicy: options.dataDestination === "local" ? "not_used" : "unknown",
    evidenceSource: "user_confirmed",
    evidenceVersion: "generation-runtime-reasoning-retry-v1",
    expectedRevision: null,
  });
  if (options.includeFallback === true) {
    const fallback = await runtime.modelHub.saveConnection({
      id: "reasoning-retry-fallback-model-hub",
      providerKind: "custom_openai_compatible",
      displayName: "Reasoning retry fallback Model Hub fixture",
      baseUrlOverride: "https://fallback-models.example/v1",
      credentialState: "missing",
      authenticationMode: "none",
      expectedRevision: null,
    });
    await runtime.modelHub.recordConnectionTest({
      connectionId: fallback.id,
      status: "ready",
      expectedRevision: fallback.revision,
    });
    await runtime.modelHub.syncCatalog({
      syncId: "reasoning-retry-fallback-model-hub-sync",
      connectionId: fallback.id,
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "reasoning-retry-fallback-model-hub-catalog",
          providerModelId: "fallback-writer-model",
          lifecycle: "stable",
          inputTokenLimit: 32_000,
          outputTokenLimit: 8_000,
          staleAfter: "2027-08-10T00:00:00.000Z",
        },
      ],
    });
    await runtime.modelHub.recordCapabilityScan({
      scanId: "reasoning-retry-fallback-model-hub-scan",
      catalogEntryId: "reasoning-retry-fallback-model-hub-catalog",
      scanKind: "lightweight_probe",
      status: "succeeded",
      evidenceVersion: "generation-runtime-reasoning-retry-fallback-v1",
      evidence: [
        {
          id: "reasoning-retry-fallback-model-hub-text",
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
        },
      ],
    });
    await runtime.modelHub.saveCostPrivacyProfile({
      catalogEntryId: "reasoning-retry-fallback-model-hub-catalog",
      currency: "USD",
      inputMicrosPerMillionTokens: "1000000",
      outputMicrosPerMillionTokens: "2000000",
      cachedInputMicrosPerMillionTokens: null,
      pricingVersion: "generation-runtime-reasoning-retry-fallback-v1",
      priceUpdatedAt: "2026-08-10T00:00:00.000Z",
      dataDestination: "remote",
      retentionPolicy: "provider_default",
      trainingPolicy: "unknown",
      evidenceSource: "user_confirmed",
      evidenceVersion: "generation-runtime-reasoning-retry-fallback-v1",
      expectedRevision: null,
    });
  }
  await runtime.modelHub.saveTaskRoute({
    task: "continuation",
    primaryCatalogEntryId: "reasoning-retry-model-hub-catalog",
    fallbackCatalogEntryId:
      options.includeFallback === true ? "reasoning-retry-fallback-model-hub-catalog" : null,
    privacyPolicy: "cloud_allowed",
    failurePolicy: options.includeFallback === true ? "use_fallback" : "stop",
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

function retrievalHit(
  id: string,
  text: string,
  projectId: string,
  sourceVersionId: string,
  documentOverrides: Partial<HybridSearchHit["document"]>,
): HybridSearchHit {
  return Object.freeze({
    document: Object.freeze({
      id: `retrieval-${id}`,
      projectId,
      sourceType: "memory" as const,
      sourceId: `fact-${id}`,
      sourceVersionId,
      title: `Evidence ${id}`,
      text,
      contentHash: "a".repeat(64),
      updatedAt: "2026-08-20T00:00:00.000Z",
      chunkKind: "story_fact_evidence" as const,
      parentDocumentId: null,
      utf16Start: 0,
      utf16End: text.length,
      sourceLength: text.length,
      sceneId: null,
      eventId: null,
      characterIds: Object.freeze([]),
      locationIds: Object.freeze([]),
      storyTime: null,
      branchId: null,
      povCharacterId: null,
      storyOrder: 1,
      authority: "confirmed_fact" as const,
      privacy: "standard" as const,
      currentness: "current" as const,
      omittedScopeFields: Object.freeze([]),
      ...documentOverrides,
    }),
    scores: Object.freeze({ keyword: 1, vector: 0, relation: 0, rule: 0, total: 1 }),
    evidence: Object.freeze({
      matchedTerms: Object.freeze([id]),
      relationIds: Object.freeze([]),
      sourceVersionId,
      contentHash: "a".repeat(64),
    }),
  });
}

function scopedFtsResponse(runtime: DesktopRuntime, hits: readonly HybridSearchHit[]) {
  return ok({
    hits: Object.freeze([...hits]),
    retrievalScopeTrace: Object.freeze({
      taskType: "continuation" as const,
      omittedHardFilters: Object.freeze([]),
      authorityNeutralOmissions: Object.freeze([]),
      versionMode: "per_source_current" as const,
    }),
    health: runtime.search.health(),
    capabilities: Object.freeze({
      keyword: "ready" as const,
      vector: "disabled" as const,
      relation: "ready" as const,
    }),
    notices: Object.freeze([]),
  });
}

function continuationContextTask(sourceVersionId: string, id: string) {
  return Object.freeze({
    id,
    content: "Continue the current accepted chapter without changing confirmed canon.",
    selectionReason: "The test explicitly requests a governed continuation context.",
    evidence: Object.freeze([
      Object.freeze({
        sourceType: "generation_task" as const,
        sourceId: id,
        sourceVersionId,
        locator: null,
        contentHash: null,
        excerpt: null,
      }),
    ]),
    priority: 1_000,
  });
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
