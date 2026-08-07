import { parseUuidV7, type AiCandidate, type Chapter, type UuidV7 } from "@inkshadow/domain";
import { diffCandidateContent } from "@inkshadow/application";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FormField,
  InlineAlert,
  Input,
  Textarea,
} from "@inkshadow/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { DataTransferPanel, type CompletedImport } from "../components/data-transfer-panel";
import {
  createImportRewriteCandidate,
  restoreCandidateBaseVersion,
  type ImportRewriteCandidateResult,
} from "../infrastructure/import-rewrite-service";
import {
  analyzeImportedChapter,
  IMPORT_WORK_ANALYSIS_FACT_TYPES,
  IMPORT_WORK_ANALYSIS_STAGES,
  type ImportWorkAnalysisFactType,
  type ImportWorkAnalysisStage,
} from "../infrastructure/import-work-analysis-service";
import {
  normalizeUiError,
  UiActionError,
  type NormalizedUiError,
} from "../infrastructure/ui-error";
import type { WritingFeedbackCode } from "../infrastructure/writing-feedback-store";
import { useRuntime } from "../runtime-context";

export const IMPORT_JOURNEY_STORAGE_KEY = "inkshadow.import-rewrite-journey.v2";
export const IMPORT_REWRITE_PENDING_STORAGE_KEY = "inkshadow.import-rewrite-pending.v1";

const REWRITE_PRESETS = [
  { id: "polish", label: "保留剧情，优化文笔" },
  { id: "light-novel", label: "改成青春恋爱轻小说" },
  { id: "first-person", label: "改成第一人称" },
  { id: "remove-ai-tone", label: "删除明显的 AI 味" },
  { id: "more-dialogue", label: "增加人物对话" },
  { id: "less-description", label: "减少环境描写" },
  { id: "continue", label: "续写下一章" },
] as const;

const FEEDBACK_PRESETS = [
  { id: "change-smaller", label: "改动太大" },
  { id: "change-larger", label: "改动太小" },
  { id: "natural-dialogue", label: "对话更自然" },
  { id: "restrained-description", label: "描写更克制" },
  { id: "faster-pace", label: "节奏更快" },
  { id: "keep-style", label: "保留当前风格" },
] as const;

type RewritePresetId = (typeof REWRITE_PRESETS)[number]["id"];
type FeedbackPresetId = (typeof FEEDBACK_PRESETS)[number]["id"];
const FEEDBACK_CODE_BY_PRESET: Readonly<Record<FeedbackPresetId, WritingFeedbackCode>> = {
  "change-smaller": "smaller_changes",
  "change-larger": "larger_changes",
  "natural-dialogue": "natural_dialogue",
  "restrained-description": "less_environment_description",
  "faster-pace": "faster_pacing",
  "keep-style": "preserve_style",
};
type BatchStatus =
  "queued" | "generating" | "ready" | "accepted" | "rejected" | "restored" | "error";

interface RewriteRuleDraft {
  readonly id: string;
  readonly text: string;
  readonly enabled: boolean;
}

interface TrialPointer {
  readonly candidateId: UuidV7;
  readonly chapterId: UuidV7;
  readonly excerptStart: number;
  readonly excerptEnd: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly requestId: string;
  readonly restoredAt: string | null;
}

interface BatchItemDraft {
  readonly chapterId: UuidV7;
  readonly chapterTitle: string;
  readonly candidateId: UuidV7 | null;
  readonly status: BatchStatus;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly errorCode: string | null;
}

interface PendingRewriteRequest {
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly chapterId: UuidV7;
  readonly kind: "trial" | "chapter" | "analysis_character" | "analysis_story";
  readonly startedAt: string;
}

class ImportJourneyError extends Error {
  override name = "ImportJourneyError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type WorkAnalysisJobStatus = "pending" | "running" | "ready" | "error" | "skipped";

interface WorkAnalysisJobDraft {
  readonly chapterId: UuidV7;
  readonly chapterTitle: string;
  readonly sourceVersionId: UuidV7;
  readonly stage: ImportWorkAnalysisStage;
  readonly status: WorkAnalysisJobStatus;
  readonly factCount: number;
  readonly criticalFactCount: number;
  readonly factTypeCounts: Readonly<Partial<Record<ImportWorkAnalysisFactType, number>>>;
  readonly requestCount: number;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly errorCode: string | null;
}

interface WorkAnalysisDraft {
  readonly version: 1;
  readonly projectId: UuidV7;
  readonly jobs: readonly WorkAnalysisJobDraft[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface ImportJourneyDraft {
  readonly version: 2;
  readonly goal: string;
  readonly selectedPresetIds: readonly RewritePresetId[];
  readonly importedWork: CompletedImport | null;
  readonly feedbackPresetIds: readonly FeedbackPresetId[];
  readonly feedbackText: string;
  readonly trial: TrialPointer | null;
  readonly rules: readonly RewriteRuleDraft[];
  readonly rulesSavedAt: string | null;
  readonly batchItems: readonly BatchItemDraft[];
  readonly workAnalysis: WorkAnalysisDraft | null;
  readonly updatedAt: string;
}

interface BasicWorkAnalysis {
  readonly chapterCount: number;
  readonly characterCount: number;
  readonly chapters: readonly Chapter[];
  readonly representativeChapter: Chapter | null;
  readonly representativeExcerpt: string;
}

type AnalysisState =
  | Readonly<{ status: "idle" | "loading" }>
  | Readonly<{ status: "ready"; value: BasicWorkAnalysis }>
  | Readonly<{ status: "error"; description: string }>;

type TrialViewState =
  | Readonly<{ status: "idle" | "loading" }>
  | Readonly<{
      status: "ready";
      candidate: AiCandidate;
      originalExcerpt: string;
      rewrittenExcerpt: string;
    }>
  | Readonly<{ status: "error"; error: NormalizedUiError }>;

const EMPTY_DRAFT: ImportJourneyDraft = Object.freeze({
  version: 2,
  goal: "",
  selectedPresetIds: [],
  importedWork: null,
  feedbackPresetIds: [],
  feedbackText: "",
  trial: null,
  rules: [],
  rulesSavedAt: null,
  batchItems: [],
  workAnalysis: null,
  updatedAt: "",
});

export function ImportJourneyPage() {
  const runtime = useRuntime();
  const [draft, setDraft] = useState<ImportJourneyDraft>(() => readJourneyDraft());
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: "idle" });
  const [trialView, setTrialView] = useState<TrialViewState>({ status: "idle" });
  const [operation, setOperation] = useState<
    "idle" | "analysis" | "trial" | "trial-decision" | "batch" | "batch-decision"
  >("idle");
  const [operationError, setOperationError] = useState<NormalizedUiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<PendingRewriteRequest | null>(() =>
    readPendingRequest(),
  );
  const recordedExplicitFeedback = useRef(new Set<string>());

  useEffect(() => {
    writeJourneyDraft(draft);
  }, [draft]);

  useEffect(() => {
    const importedWork = draft.importedWork;
    let active = true;
    if (importedWork === null) {
      queueMicrotask(() => {
        if (active) setAnalysis({ status: "idle" });
      });
      return () => {
        active = false;
      };
    }
    queueMicrotask(() => {
      if (active) setAnalysis({ status: "loading" });
    });
    void runtime.repositories.chapters.listByProjectId(importedWork.projectId).then((result) => {
      if (!active) {
        return;
      }
      if (!result.ok) {
        setAnalysis({ status: "error", description: normalizeUiError(result.error).description });
        return;
      }
      const chapters = result.value.filter(({ status }) => status === "active");
      const representativeChapter =
        chapters.find(({ content }) => content.trim().length > 0) ?? null;
      setAnalysis({
        status: "ready",
        value: {
          chapterCount: chapters.length,
          characterCount: chapters.reduce(
            (total, chapter) => total + Array.from(chapter.content).length,
            0,
          ),
          chapters,
          representativeChapter,
          representativeExcerpt: representativeChapter?.content.trim().slice(0, 600) ?? "",
        },
      });
    });
    return () => {
      active = false;
    };
  }, [draft.importedWork, runtime.repositories.chapters]);

  useEffect(() => {
    const pointer = draft.trial;
    let active = true;
    if (pointer === null) {
      queueMicrotask(() => {
        if (active) setTrialView({ status: "idle" });
      });
      return () => {
        active = false;
      };
    }
    queueMicrotask(() => {
      if (active) setTrialView({ status: "loading" });
    });
    void loadTrialView(runtime, pointer).then((result) => {
      if (!active) {
        return;
      }
      setTrialView(result);
    });
    return () => {
      active = false;
    };
  }, [draft.trial, runtime]);

  const activeRules = draft.rules
    .filter(({ enabled, text }) => enabled && text.trim().length > 0)
    .map(({ text }) => text.trim());
  const targetInstructions = buildTargetInstructions(draft);
  const workAnalysisSummary = useMemo(
    () => summarizeWorkAnalysis(draft.workAnalysis),
    [draft.workAnalysis],
  );
  const trialDiff = useMemo(
    () =>
      trialView.status === "ready"
        ? diffCandidateContent(trialView.originalExcerpt, trialView.rewrittenExcerpt)
        : null,
    [trialView],
  );
  const canGenerateTrial =
    analysis.status === "ready" &&
    analysis.value.representativeChapter !== null &&
    targetInstructions.length > 0 &&
    operation === "idle";
  const canStartBatch =
    analysis.status === "ready" &&
    analysis.value.chapters.length > 0 &&
    draft.rulesSavedAt !== null &&
    activeRules.length > 0 &&
    operation === "idle";
  const canAnalyzeWork =
    analysis.status === "ready" &&
    analysis.value.chapters.some(({ content }) => content.trim().length > 0) &&
    operation === "idle";

  function patchDraft(patch: Partial<ImportJourneyDraft>): void {
    setDraft((current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }));
  }

  function updateGoal(goal: string): void {
    patchDraft({ goal: goal.slice(0, 4_000), rulesSavedAt: null });
  }

  function togglePreset(id: RewritePresetId): void {
    setDraft((current) => ({
      ...current,
      selectedPresetIds: current.selectedPresetIds.includes(id)
        ? current.selectedPresetIds.filter((currentId) => currentId !== id)
        : [...current.selectedPresetIds, id],
      rulesSavedAt: null,
      updatedAt: new Date().toISOString(),
    }));
  }

  function toggleFeedback(id: FeedbackPresetId): void {
    setDraft((current) => ({
      ...current,
      feedbackPresetIds: current.feedbackPresetIds.includes(id)
        ? current.feedbackPresetIds.filter((currentId) => currentId !== id)
        : [...current.feedbackPresetIds, id],
      rulesSavedAt: null,
      updatedAt: new Date().toISOString(),
    }));
  }

  async function recordImportAction(input: {
    readonly chapterId: string | null;
    readonly candidateId: string | null;
    readonly action: "accepted" | "rejected" | "regenerated" | "restored_original";
  }): Promise<void> {
    const importedWork = draft.importedWork;
    if (importedWork === null) return;
    try {
      await runtime.story.writingFeedback.recordAction({
        projectId: importedWork.projectId,
        chapterId: input.chapterId,
        candidateId: input.candidateId,
        action: input.action,
        applicationStrategy: input.action === "accepted" ? "accept_all" : null,
      });
    } catch {
      globalThis.console.error("[IMPORT_WRITING_FEEDBACK_RECORD_FAILED]");
    }
  }

  async function recordTrialFeedbackSelections(): Promise<void> {
    const importedWork = draft.importedWork;
    if (importedWork === null || trialView.status !== "ready") return;
    for (const presetId of draft.feedbackPresetIds) {
      const key = `${trialView.candidate.id}:preset:${presetId}`;
      if (recordedExplicitFeedback.current.has(key)) continue;
      try {
        await runtime.story.writingFeedback.recordExplicitFeedback({
          projectId: importedWork.projectId,
          chapterId: trialView.candidate.chapterId,
          candidateId: trialView.candidate.id,
          feedbackCode: FEEDBACK_CODE_BY_PRESET[presetId],
        });
        recordedExplicitFeedback.current.add(key);
      } catch {
        globalThis.console.error("[IMPORT_EXPLICIT_FEEDBACK_RECORD_FAILED]");
      }
    }
    const customFeedback = draft.feedbackText.trim();
    const customKey = `${trialView.candidate.id}:custom:${customFeedback}`;
    if (customFeedback.length > 0 && !recordedExplicitFeedback.current.has(customKey)) {
      try {
        await runtime.story.writingFeedback.recordExplicitFeedback({
          projectId: importedWork.projectId,
          chapterId: trialView.candidate.chapterId,
          candidateId: trialView.candidate.id,
          customFeedback,
        });
        recordedExplicitFeedback.current.add(customKey);
      } catch {
        globalThis.console.error("[IMPORT_EXPLICIT_FEEDBACK_RECORD_FAILED]");
      }
    }
  }

  function rememberImport(completedImport: CompletedImport): void {
    setDraft({
      ...EMPTY_DRAFT,
      importedWork: completedImport,
      updatedAt: new Date().toISOString(),
    });
    setOperationError(null);
    setNotice("原作已安全导入。接下来先确认目标，再对代表段落进行一次真实试改。");
  }

  function rememberPendingRequest(
    kind: PendingRewriteRequest["kind"],
    chapterId: UuidV7,
    request: Readonly<{ requestId: string; providerId: string; modelId: string }>,
  ): void {
    const pending: PendingRewriteRequest = {
      ...request,
      chapterId,
      kind,
      startedAt: new Date().toISOString(),
    };
    writePendingRequest(pending);
    setPendingRequest(pending);
  }

  function clearPendingRequest(): void {
    writePendingRequest(null);
    setPendingRequest(null);
  }

  async function runWorkAnalysis(includeSkipped = false): Promise<void> {
    if (!canAnalyzeWork || draft.importedWork === null) {
      return;
    }
    const now = new Date().toISOString();
    const prepared = reconcileWorkAnalysisDraft(
      draft.workAnalysis,
      draft.importedWork.projectId,
      analysis.value.chapters,
      now,
    );
    let workingJobs = prepared.jobs.map((job) =>
      includeSkipped && job.status === "skipped" ? { ...job, status: "pending" as const } : job,
    );

    function commitJobs(completedAt: string | null = null): void {
      const nextAnalysis: WorkAnalysisDraft = {
        ...prepared,
        jobs: Object.freeze([...workingJobs]),
        updatedAt: new Date().toISOString(),
        completedAt,
      };
      setDraft((current) => ({
        ...current,
        workAnalysis: nextAnalysis,
        updatedAt: nextAnalysis.updatedAt,
      }));
    }

    commitJobs();
    setOperation("analysis");
    setOperationError(null);
    setNotice(null);
    let stoppedByError = false;
    for (const job of workingJobs) {
      if (job.status !== "pending" && job.status !== "error") {
        continue;
      }
      const chapter = analysis.value.chapters.find(({ id }) => id === job.chapterId);
      if (chapter?.currentVersionId !== job.sourceVersionId) {
        const error = normalizeUiError({
          code: "IMPORT_ANALYSIS_SOURCE_CHANGED",
          message:
            "章节在分析开始前发生了变化。请重新点击继续分析，墨影会基于最新正式版本创建新的待确认结果。",
        });
        workingJobs = updateWorkAnalysisJob(workingJobs, job, {
          status: "error",
          errorCode: error.code,
        });
        commitJobs();
        setOperationError(error);
        stoppedByError = true;
        break;
      }
      workingJobs = updateWorkAnalysisJob(workingJobs, job, {
        status: "running",
        errorCode: null,
      });
      commitJobs();
      try {
        const result = await analyzeImportedChapter(runtime, {
          projectId: draft.importedWork.projectId,
          chapter,
          chapterIndex: analysis.value.chapters.findIndex(({ id }) => id === chapter.id),
          stage: job.stage,
          onBeforeDispatch: (request) =>
            rememberPendingRequest(
              request.stage === "character" ? "analysis_character" : "analysis_story",
              job.chapterId,
              request,
            ),
        });
        const firstSelection = result.selections[0] ?? null;
        const selectionChanged = result.selections.some(
          ({ providerId, modelId }) =>
            firstSelection !== null &&
            (providerId !== firstSelection.providerId || modelId !== firstSelection.modelId),
        );
        workingJobs = updateWorkAnalysisJob(workingJobs, job, {
          status: "ready",
          factCount: result.factIds.length,
          criticalFactCount: result.criticalFactCount,
          factTypeCounts: result.factTypeCounts,
          requestCount: result.requestCount,
          providerId:
            firstSelection === null
              ? null
              : selectionChanged
                ? "多个已验证连接"
                : firstSelection.providerId,
          modelId:
            firstSelection === null
              ? null
              : selectionChanged
                ? "多个已验证模型"
                : firstSelection.modelId,
          errorCode: null,
        });
        commitJobs();
      } catch (cause: unknown) {
        const error = normalizeUiError(cause);
        workingJobs = updateWorkAnalysisJob(workingJobs, job, {
          status: "error",
          errorCode: error.code,
        });
        commitJobs();
        setOperationError(error);
        stoppedByError = true;
        break;
      } finally {
        clearPendingRequest();
      }
    }
    const completed = workingJobs.every(({ status }) => status === "ready" || status === "skipped");
    commitJobs(completed ? new Date().toISOString() : null);
    setOperation("idle");
    if (completed) {
      setNotice("作品分析已结束。AI 提取内容均以带原文证据的待确认事实保存；原文没有改变。");
    } else if (!stoppedByError) {
      setNotice("当前可执行的作品分析项已经处理完成。原文没有改变。");
    }
  }

  function skipAnalysisJob(job: WorkAnalysisJobDraft): void {
    setDraft((current) => {
      if (current.workAnalysis === null) return current;
      const jobs = current.workAnalysis.jobs.map((candidate) =>
        sameWorkAnalysisJob(candidate, job)
          ? { ...candidate, status: "skipped" as const, errorCode: null }
          : candidate,
      );
      const completed = jobs.every(({ status }) => status === "ready" || status === "skipped");
      const updatedAt = new Date().toISOString();
      return {
        ...current,
        workAnalysis: {
          ...current.workAnalysis,
          jobs,
          updatedAt,
          completedAt: completed ? updatedAt : null,
        },
        updatedAt,
      };
    });
    setOperationError(null);
    setNotice("已跳过这一项；原文和已经保存的待确认事实都没有被删除。可以继续分析其余内容。");
  }

  function skipRemainingAnalysis(): void {
    setDraft((current) => {
      if (current.workAnalysis === null) return current;
      const jobs = current.workAnalysis.jobs.map((job) =>
        job.status === "pending" || job.status === "error"
          ? { ...job, status: "skipped" as const, errorCode: null }
          : job,
      );
      const updatedAt = new Date().toISOString();
      return {
        ...current,
        workAnalysis: {
          ...current.workAnalysis,
          jobs,
          updatedAt,
          completedAt: updatedAt,
        },
        updatedAt,
      };
    });
    setOperationError(null);
    setNotice("已跳过剩余深度分析，可以直接描述改写或续写目标；导入原文保持不变。");
  }

  async function generateTrial(): Promise<void> {
    if (!canGenerateTrial) {
      return;
    }
    const chapter = analysis.value.representativeChapter;
    const previous = trialView.status === "ready" ? trialView.candidate : null;
    setOperation("trial");
    setOperationError(null);
    setNotice(null);
    try {
      const generated = await createImportRewriteCandidate(runtime, {
        chapterId: chapter.id,
        instructions: targetInstructions,
        mode: "trial",
        onBeforeDispatch: (request) => rememberPendingRequest("trial", chapter.id, request),
      });
      if (previous?.status === "ready") {
        const rejected = await runtime.useCases.rejectCandidate.execute({
          candidateId: previous.id,
        });
        if (!rejected.ok) {
          await runtime.useCases.rejectCandidate.execute({ candidateId: generated.candidate.id });
          throw rejected.error;
        }
        await recordImportAction({
          chapterId: chapter.id,
          candidateId: previous.id,
          action: "regenerated",
        });
      }
      const pointer = trialPointerFromResult(generated);
      setDraft((current) => ({
        ...current,
        trial: pointer,
        rulesSavedAt: null,
        batchItems: [],
        updatedAt: new Date().toISOString(),
      }));
      setTrialView({
        status: "ready",
        candidate: generated.candidate,
        originalExcerpt: generated.originalExcerpt,
        rewrittenExcerpt: generated.rewrittenExcerpt,
      });
      setNotice("代表段落试改已保存为独立 AI 建议版本，原文尚未改变。");
    } catch (cause: unknown) {
      setOperationError(normalizeUiError(cause));
    } finally {
      clearPendingRequest();
      setOperation("idle");
    }
  }

  async function decideTrial(decision: "accept" | "reject" | "restore"): Promise<void> {
    if (trialView.status !== "ready" || operation !== "idle") {
      return;
    }
    setOperation("trial-decision");
    setOperationError(null);
    try {
      if (decision === "accept") {
        const result = await runtime.useCases.acceptCandidate.execute({
          candidateId: trialView.candidate.id,
          strategy: { kind: "accept_all" },
        });
        if (!result.ok) {
          throw result.error;
        }
        setTrialView((current) =>
          current.status === "ready" ? { ...current, candidate: result.value.candidate } : current,
        );
        await recordImportAction({
          chapterId: trialView.candidate.chapterId,
          candidateId: result.value.candidate.id,
          action: "accepted",
        });
        setNotice("试改已作为新的稳定版本写入；接受前的原文仍保留在版本历史中，可随时恢复。");
      } else if (decision === "reject") {
        const result = await runtime.useCases.rejectCandidate.execute({
          candidateId: trialView.candidate.id,
        });
        if (!result.ok) {
          throw result.error;
        }
        setTrialView((current) =>
          current.status === "ready" ? { ...current, candidate: result.value } : current,
        );
        await recordImportAction({
          chapterId: trialView.candidate.chapterId,
          candidateId: result.value.id,
          action: "rejected",
        });
        setNotice("试改建议已拒绝，原文没有改变。你可以调整目标后重新生成。");
      } else {
        const restored = await restoreCandidateBaseVersion(runtime, trialView.candidate);
        if (!restored.ok) {
          throw restored.error;
        }
        patchDraft({
          trial:
            draft.trial === null ? null : { ...draft.trial, restoredAt: new Date().toISOString() },
        });
        await recordImportAction({
          chapterId: trialView.candidate.chapterId,
          candidateId: trialView.candidate.id,
          action: "restored_original",
        });
        setNotice("已从试改所依据的版本创建恢复版本；原文和全部历史版本都仍然保留。");
      }
    } catch (cause: unknown) {
      setOperationError(normalizeUiError(cause));
    } finally {
      setOperation("idle");
    }
  }

  function formRules(): void {
    const rules = compileEditableRules(draft);
    patchDraft({ rules, rulesSavedAt: null, batchItems: [] });
    void recordTrialFeedbackSelections();
    setNotice("已把目标和试改反馈整理为可编辑规则。请检查后再保留规则。");
  }

  function updateRule(id: string, text: string): void {
    patchDraft({
      rules: draft.rules.map((rule) => (rule.id === id ? { ...rule, text } : rule)),
      rulesSavedAt: null,
    });
  }

  function toggleRule(id: string): void {
    patchDraft({
      rules: draft.rules.map((rule) =>
        rule.id === id ? { ...rule, enabled: !rule.enabled } : rule,
      ),
      rulesSavedAt: null,
    });
  }

  function removeRule(id: string): void {
    patchDraft({ rules: draft.rules.filter((rule) => rule.id !== id), rulesSavedAt: null });
  }

  function addRule(): void {
    patchDraft({
      rules: [
        ...draft.rules,
        {
          id: `custom-${String(Date.now())}-${String(draft.rules.length)}`,
          text: "",
          enabled: true,
        },
      ],
      rulesSavedAt: null,
    });
  }

  function saveRules(): void {
    if (activeRules.length === 0) {
      setOperationError({
        title: "无法保留规则",
        description: "请至少启用并填写一条改写规则。",
        code: "IMPORT_REWRITE_RULES_EMPTY",
      });
      return;
    }
    patchDraft({ rulesSavedAt: new Date().toISOString(), batchItems: [] });
    setOperationError(null);
    setNotice("规则已保留在本机。逐章处理只会创建独立建议版本，不会批量覆盖原文。");
  }

  async function generateBatch(): Promise<void> {
    if (!canStartBatch) {
      return;
    }
    const chapters = analysis.value.chapters.filter(({ content }) => content.trim().length > 0);
    const previousCandidateByChapter = new Map(
      draft.batchItems.flatMap(({ chapterId, candidateId, status }) =>
        candidateId !== null && status === "ready" ? [[chapterId, candidateId] as const] : [],
      ),
    );
    const initial = chapters.map<BatchItemDraft>((chapter) => ({
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      candidateId: null,
      status: "queued",
      providerId: null,
      modelId: null,
      errorCode: null,
    }));
    patchDraft({ batchItems: initial });
    setOperation("batch");
    setOperationError(null);
    setNotice(null);
    for (const chapter of chapters) {
      updateBatchItem(chapter.id, { status: "generating", errorCode: null });
      try {
        const generated = await createImportRewriteCandidate(runtime, {
          chapterId: chapter.id,
          instructions: activeRules,
          mode: "chapter",
          onBeforeDispatch: (request) => rememberPendingRequest("chapter", chapter.id, request),
        });
        const previousCandidateId = previousCandidateByChapter.get(chapter.id);
        if (previousCandidateId !== undefined && previousCandidateId !== generated.candidate.id) {
          const rejected = await runtime.useCases.rejectCandidate.execute({
            candidateId: previousCandidateId,
          });
          if (!rejected.ok) {
            await runtime.useCases.rejectCandidate.execute({
              candidateId: generated.candidate.id,
            });
            throw rejected.error;
          }
          await recordImportAction({
            chapterId: chapter.id,
            candidateId: previousCandidateId,
            action: "regenerated",
          });
        }
        updateBatchItem(chapter.id, {
          candidateId: generated.candidate.id,
          status: "ready",
          providerId: generated.providerId,
          modelId: generated.modelId,
          errorCode: null,
        });
      } catch (cause: unknown) {
        const error = normalizeUiError(cause);
        updateBatchItem(chapter.id, { status: "error", errorCode: error.code });
      }
    }
    clearPendingRequest();
    setOperation("idle");
    setNotice(
      "逐章处理已结束。成功的章节都有各自的 AI 建议版本；失败章节的原文没有改变，可单独重试。",
    );
  }

  function updateBatchItem(
    chapterId: UuidV7,
    patch: Partial<Omit<BatchItemDraft, "chapterId" | "chapterTitle">>,
  ): void {
    setDraft((current) => ({
      ...current,
      batchItems: current.batchItems.map((item) =>
        item.chapterId === chapterId ? { ...item, ...patch } : item,
      ),
      updatedAt: new Date().toISOString(),
    }));
  }

  async function decideBatchItem(
    item: BatchItemDraft,
    decision: "accept" | "reject" | "restore" | "regenerate",
  ): Promise<void> {
    if (operation !== "idle") {
      return;
    }
    setOperation("batch-decision");
    setOperationError(null);
    try {
      if (decision === "regenerate") {
        const previous =
          item.candidateId === null
            ? null
            : await runtime.repositories.aiCandidates.findById(item.candidateId);
        if (previous !== null && !previous.ok) {
          throw previous.error;
        }
        const generated = await createImportRewriteCandidate(runtime, {
          chapterId: item.chapterId,
          instructions: activeRules,
          mode: "chapter",
          onBeforeDispatch: (request) => rememberPendingRequest("chapter", item.chapterId, request),
        });
        if (previous?.value?.status === "ready") {
          const rejected = await runtime.useCases.rejectCandidate.execute({
            candidateId: previous.value.id,
          });
          if (!rejected.ok) {
            await runtime.useCases.rejectCandidate.execute({
              candidateId: generated.candidate.id,
            });
            throw rejected.error;
          }
          await recordImportAction({
            chapterId: item.chapterId,
            candidateId: previous.value.id,
            action: "regenerated",
          });
        }
        updateBatchItem(item.chapterId, {
          candidateId: generated.candidate.id,
          status: "ready",
          providerId: generated.providerId,
          modelId: generated.modelId,
          errorCode: null,
        });
        return;
      }
      if (item.candidateId === null) {
        throw new ImportJourneyError("CANDIDATE_NOT_FOUND", "找不到这个章节的建议版本。");
      }
      const found = await runtime.repositories.aiCandidates.findById(item.candidateId);
      if (!found.ok) {
        throw found.error;
      }
      if (found.value === null) {
        throw new ImportJourneyError("CANDIDATE_NOT_FOUND", "找不到这个章节的建议版本。");
      }
      if (decision === "accept") {
        const accepted = await runtime.useCases.acceptCandidate.execute({
          candidateId: found.value.id,
          strategy: { kind: "accept_all" },
        });
        if (!accepted.ok) {
          throw accepted.error;
        }
        updateBatchItem(item.chapterId, { status: "accepted", errorCode: null });
        await recordImportAction({
          chapterId: item.chapterId,
          candidateId: accepted.value.candidate.id,
          action: "accepted",
        });
      } else if (decision === "reject") {
        const rejected = await runtime.useCases.rejectCandidate.execute({
          candidateId: found.value.id,
        });
        if (!rejected.ok) {
          throw rejected.error;
        }
        updateBatchItem(item.chapterId, { status: "rejected", errorCode: null });
        await recordImportAction({
          chapterId: item.chapterId,
          candidateId: rejected.value.id,
          action: "rejected",
        });
      } else {
        const restored = await restoreCandidateBaseVersion(runtime, found.value);
        if (!restored.ok) {
          throw restored.error;
        }
        updateBatchItem(item.chapterId, { status: "restored", errorCode: null });
        await recordImportAction({
          chapterId: item.chapterId,
          candidateId: found.value.id,
          action: "restored_original",
        });
      }
    } catch (cause: unknown) {
      const error = normalizeUiError(cause);
      updateBatchItem(item.chapterId, { status: "error", errorCode: error.code });
      setOperationError(error);
    } finally {
      clearPendingRequest();
      setOperation("idle");
    }
  }

  async function acceptAllReady(): Promise<void> {
    if (operation !== "idle") {
      return;
    }
    const readyItems = draft.batchItems.filter(
      ({ status, candidateId }) => status === "ready" && candidateId !== null,
    );
    setOperation("batch-decision");
    setOperationError(null);
    for (const item of readyItems) {
      if (item.candidateId === null) {
        continue;
      }
      const accepted = await runtime.useCases.acceptCandidate.execute({
        candidateId: item.candidateId,
        strategy: { kind: "accept_all" },
      });
      updateBatchItem(item.chapterId, {
        status: accepted.ok ? "accepted" : "error",
        errorCode: accepted.ok ? null : accepted.error.code,
      });
      if (accepted.ok) {
        await recordImportAction({
          chapterId: item.chapterId,
          candidateId: accepted.value.candidate.id,
          action: "accepted",
        });
      }
    }
    setOperation("idle");
    setNotice("全部就绪建议已逐章处理；每次接受都创建独立稳定版本，失败章节保持原文。");
  }

  return (
    <div className="desktop-page settings-page">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">从已有作品继续</p>
          <h1>导入小说，继续写或改写</h1>
          <p>先保留原作，再分析、试改和确认规则；不会一上来批量改完整本。</p>
        </div>
        <div className="settings-actions">
          <Badge tone="success">原文受保护</Badge>
          <Link className="ink-button ink-button--secondary ink-button--sm" to="/">
            返回开始
          </Link>
        </div>
      </header>

      <InlineAlert
        tone="info"
        title="原文永远不会被 AI 静默覆盖"
        description="导入会创建本地项目和首个正式版本。后续每章改写都先成为独立 AI 建议版本；只有你明确接受才会创建新的正文版本，历史原文始终保留。"
      />
      <InlineAlert
        tone="info"
        title="当前格式支持范围"
        description="当前可在本机安全导入 TXT、Markdown、HTML、DOCX、EPUB 和可提取文字的 PDF；扫描版 PDF 仍需先完成 OCR。"
      />

      <nav className="import-journey-steps" aria-label="导入改写五步">
        <ol>
          <JourneyStep
            number={1}
            title="安全导入"
            description="本机预检、净化并原子写入原作"
            state={draft.importedWork === null ? "current" : "complete"}
          />
          <JourneyStep
            number={2}
            title="分析作品"
            description="读取真实章节，并按证据提取人物、设定与剧情"
            state={
              draft.workAnalysis !== null && draft.workAnalysis.completedAt !== null
                ? "complete"
                : draft.importedWork === null
                  ? "pending"
                  : "current"
            }
          />
          <JourneyStep
            number={3}
            title="描述目标"
            description="自然语言或常用选项，可随时修改"
            state={
              targetInstructions.length > 0
                ? "complete"
                : analysis.status === "ready"
                  ? "current"
                  : "pending"
            }
          />
          <JourneyStep
            number={4}
            title="代表段落试改"
            description="比较原文、建议版本和差异，再给反馈"
            state={
              trialView.status === "ready"
                ? "complete"
                : targetInstructions.length > 0
                  ? "current"
                  : "pending"
            }
          />
          <JourneyStep
            number={5}
            title="确认规则后逐章"
            description="每章独立建议，可接受、拒绝、重试和恢复"
            state={draft.rulesSavedAt !== null ? "current" : "pending"}
          />
        </ol>
      </nav>

      {notice !== null && <InlineAlert tone="info" title="进度已更新" description={notice} />}
      {operationError !== null && (
        <InlineAlert
          tone="error"
          title={operationError.title}
          description={
            <span>
              {operationError.description}（{operationError.code}）{" "}
              {(operationError.code.includes("MODEL") ||
                operationError.code === "IMPORT_ANALYSIS_ROUTE_NOT_CONFIGURED" ||
                operationError.code === "IMPORT_ANALYSIS_STRUCTURED_OUTPUT_UNVERIFIED") && (
                <Link to="/settings#model-center">前往模型设置</Link>
              )}
            </span>
          }
        />
      )}
      {pendingRequest !== null && operation === "idle" && (
        <InlineAlert
          tone="warning"
          title="上次模型调用可能在中断前已发送"
          description={`请求 ${pendingRequest.requestId} 曾发送到 ${pendingRequest.providerId} / ${pendingRequest.modelId}。墨影不会自动重复调用或重复计费；请先查看供应商记录，再手动重试。`}
        />
      )}

      {draft.importedWork !== null && (
        <InlineAlert
          tone="info"
          title="上次流程已保留"
          description={`${draft.importedWork.projectName} 已安全导入 ${String(draft.importedWork.chapterCount)} 个章节，可以从当前步骤继续。`}
        />
      )}

      <DataTransferPanel mode="import-only" onImportComplete={rememberImport} />

      <Card>
        <CardHeader>
          <div className="card-heading-row">
            <div>
              <CardTitle headingLevel={2}>第 2 步：分析作品</CardTitle>
              <CardDescription>
                章节结构来自本地文件；人物、关系、世界、时间线和剧情只保存带精确原文证据的 AI
                待确认结果。
              </CardDescription>
            </div>
            <Badge
              tone={
                draft.workAnalysis !== null && draft.workAnalysis.completedAt !== null
                  ? "success"
                  : "neutral"
              }
            >
              {operation === "analysis"
                ? "正在分析"
                : draft.workAnalysis !== null && draft.workAnalysis.completedAt !== null
                  ? "分析已结束"
                  : analysisLabel(analysis)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {analysis.status === "ready" ? (
            <>
              <ul className="privacy-list">
                <li>识别到 {String(analysis.value.chapterCount)} 个有效章节。</li>
                <li>正文约 {String(analysis.value.characterCount)} 个字符。</li>
                <li>已从含有正文的章节中选择代表文本；流程草稿只保存引用标识，不复制原文全文。</li>
              </ul>
              {analysis.value.representativeChapter !== null && (
                <details>
                  <summary>查看代表文本：{analysis.value.representativeChapter.title}</summary>
                  <p>{analysis.value.representativeExcerpt}</p>
                </details>
              )}
              <InlineAlert
                tone="info"
                title="分析结果不会直接变成正式设定"
                description="墨影会通过已配置的 AI 分工分两遍读取每个章节，并严格核对章节版本、原文位置和结构格式。模型推测不会被接受；人物身份、核心关系、世界规则、重要事件等都会进入待确认。"
              />
              <div className="settings-actions">
                <Button
                  disabled={
                    !canAnalyzeWork ||
                    (draft.workAnalysis !== null && workAnalysisSummary.remainingJobs === 0)
                  }
                  onClick={() => void runWorkAnalysis()}
                >
                  {operation === "analysis"
                    ? `正在分析 ${String(workAnalysisSummary.finishedJobs)}/${String(workAnalysisSummary.totalJobs)}…`
                    : draft.workAnalysis === null
                      ? "开始分析作品"
                      : workAnalysisSummary.remainingJobs > 0
                        ? "继续或重试分析"
                        : "作品分析已结束"}
                </Button>
                {workAnalysisSummary.remainingJobs > 0 && operation === "idle" && (
                  <Button variant="secondary" onClick={skipRemainingAnalysis}>
                    跳过剩余分析
                  </Button>
                )}
                {workAnalysisSummary.skippedJobs > 0 && operation === "idle" && (
                  <Button variant="secondary" onClick={() => void runWorkAnalysis(true)}>
                    重新分析已跳过项
                  </Button>
                )}
              </div>
              {draft.workAnalysis === null ? (
                <p className="maintenance-note">
                  分析是可选步骤。未配置模型时可以跳过并直接描述目标；原文已经安全保存在本地。
                </p>
              ) : (
                <section aria-label="作品分析结果">
                  <p className="maintenance-note" aria-live="polite">
                    已完成 {String(workAnalysisSummary.readyJobs)} 项，跳过{" "}
                    {String(workAnalysisSummary.skippedJobs)} 项，剩余{" "}
                    {String(workAnalysisSummary.remainingJobs)} 项；共保存{" "}
                    {String(workAnalysisSummary.factCount)} 条待确认事实，其中{" "}
                    {String(workAnalysisSummary.criticalFactCount)} 条属于关键事实。
                  </p>
                  <ul className="privacy-list" aria-label="作品分析分类统计">
                    {workAnalysisSummary.categories.map(({ key, label, count }) => (
                      <li key={key}>
                        {label}：{String(count)} 条有原文证据的待确认结果
                      </li>
                    ))}
                  </ul>
                  {workAnalysisSummary.models.length > 0 && (
                    <details>
                      <summary>查看本次使用的模型</summary>
                      <ul>
                        {workAnalysisSummary.models.map((model) => (
                          <li key={model}>{model}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {workAnalysisSummary.problemJobs.length > 0 && (
                    <div>
                      <h3>需要处理的分析项</h3>
                      <ul aria-label="失败的作品分析项">
                        {workAnalysisSummary.problemJobs.map((job) => (
                          <li key={workAnalysisJobKey(job)}>
                            <span>
                              {job.chapterTitle} · {analysisStageLabel(job.stage)}：
                              {job.errorCode ?? "等待继续"}
                            </span>{" "}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={operation !== "idle"}
                              onClick={() => skipAnalysisJob(job)}
                            >
                              跳过这一项
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {workAnalysisSummary.factCount > 0 && draft.importedWork !== null && (
                    <InlineAlert
                      tone="warning"
                      title={`有 ${String(workAnalysisSummary.factCount)} 条内容等待确认`}
                      description={
                        <span>
                          这些结果仍是临时判断，不会约束正文。可前往{" "}
                          <Link to={`/projects/${draft.importedWork.projectId}/story`}>
                            故事设定
                          </Link>{" "}
                          查看证据、确认、锁定或废弃。
                        </span>
                      }
                    />
                  )}
                  {draft.workAnalysis.completedAt !== null &&
                    workAnalysisSummary.factCount === 0 && (
                      <InlineAlert
                        tone="info"
                        title="作品分析已结束"
                        description="模型没有返回通过证据校验的事实，或你选择跳过了全部分析项。原文仍然完整，可以直接进入下一步。"
                      />
                    )}
                </section>
              )}
            </>
          ) : analysis.status === "error" ? (
            <InlineAlert
              tone="error"
              title="无法读取刚导入的作品"
              description={`${analysis.description}。原作仍已安全保存，可返回项目查看后重试。`}
            />
          ) : (
            <InlineAlert
              tone="info"
              title={analysis.status === "loading" ? "正在读取作品结构" : "等待安全导入"}
              description={
                analysis.status === "loading"
                  ? "正在从本地项目读取章节数量和代表文本。"
                  : "完成第 1 步后会自动进行本地结构分析。"
              }
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle headingLevel={2}>第 3 步：你希望怎样处理？</CardTitle>
          <CardDescription>
            可以直接描述，也可以组合常用方向；内容会自动保存在本机。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FormField
            label="你想怎样处理这部作品？"
            hint="例如：保留剧情和人物姓名，把对话写得更自然，减少总结式结尾。"
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={draft.goal}
                maxLength={4_000}
                currentLength={draft.goal.length}
                onChange={(event) => updateGoal(event.currentTarget.value)}
              />
            )}
          </FormField>
          <div className="settings-actions" aria-label="常用改写目标">
            {REWRITE_PRESETS.map(({ id, label }) => {
              const selected = draft.selectedPresetIds.includes(id);
              return (
                <Button
                  key={id}
                  size="sm"
                  variant={selected ? "ai-primary" : "secondary"}
                  aria-pressed={selected}
                  onClick={() => togglePreset(id)}
                >
                  {label}
                </Button>
              );
            })}
          </div>
          <p className="maintenance-note" aria-live="polite">
            {draft.updatedAt.length > 0
              ? "改写目标已自动保存在本机，可关闭页面后继续。"
              : "至少写一句目标或选择一个常用方向后即可试改。"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle headingLevel={2}>第 4 步：先试改代表段落</CardTitle>
          <CardDescription>
            真实调用已连接模型，并把结果保存为独立建议版本；未连接模型时不会生成占位内容。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="settings-actions">
            <Button disabled={!canGenerateTrial} onClick={() => void generateTrial()}>
              {operation === "trial"
                ? "正在生成试改…"
                : trialView.status === "ready"
                  ? "重新生成试改"
                  : "生成代表段落试改"}
            </Button>
          </div>
          {!canGenerateTrial && trialView.status !== "ready" && (
            <p className="maintenance-note">{trialBlockedReason(draft, analysis, operation)}</p>
          )}
          {trialView.status === "loading" && (
            <InlineAlert
              tone="info"
              title="正在恢复试改"
              description="正在从本地建议版本和历史原文恢复比较视图。"
            />
          )}
          {trialView.status === "error" && (
            <InlineAlert
              tone="error"
              title={trialView.error.title}
              description={`${trialView.error.description}（${trialView.error.code}）`}
            />
          )}
          {trialView.status === "ready" && (
            <section aria-label="代表段落试改结果">
              <div className="card-heading-row">
                <h3>原文与 AI 建议版本</h3>
                <Badge tone={trialView.candidate.status === "ready" ? "success" : "neutral"}>
                  {candidateStatusLabel(trialView.candidate.status)}
                </Badge>
              </div>
              {draft.trial !== null && (
                <p className="maintenance-note">
                  本次调用：{draft.trial.providerId} / {draft.trial.modelId}；请求{" "}
                  {draft.trial.requestId}
                </p>
              )}
              <h4>原文</h4>
              <pre style={{ whiteSpace: "pre-wrap" }}>{trialView.originalExcerpt}</pre>
              <h4>AI 建议版本</h4>
              <pre style={{ whiteSpace: "pre-wrap" }}>{trialView.rewrittenExcerpt}</pre>
              <details>
                <summary>差异对比</summary>
                <p>
                  原文 {String(Array.from(trialView.originalExcerpt).length)} 字符，建议版本{" "}
                  {String(Array.from(trialView.rewrittenExcerpt).length)}{" "}
                  字符。这里只替换代表段落，章节其余内容保持原样。
                </p>
                {trialDiff?.status === "ready" ? (
                  <ol aria-label="试改文字差异">
                    {trialDiff.diff.changes.slice(0, 20).map((change) => (
                      <li key={change.id}>
                        <p>
                          <strong>删除：</strong>
                          {change.removedText.length === 0 ? "（无）" : change.removedText}
                        </p>
                        <p>
                          <strong>加入：</strong>
                          {change.insertedText.length === 0 ? "（无）" : change.insertedText}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>差异过于复杂，建议前往章节编辑器查看完整比较后再接受。</p>
                )}
              </details>
              <div className="settings-actions">
                {trialView.candidate.status === "ready" && (
                  <Button
                    disabled={operation !== "idle"}
                    onClick={() => void decideTrial("accept")}
                  >
                    接受试改到正文
                  </Button>
                )}
                {trialView.candidate.status === "ready" && (
                  <Button
                    variant="secondary"
                    disabled={operation !== "idle"}
                    onClick={() => void decideTrial("reject")}
                  >
                    拒绝试改
                  </Button>
                )}
                {trialView.candidate.status === "accepted" && draft.trial?.restoredAt === null && (
                  <Button
                    variant="secondary"
                    disabled={operation !== "idle"}
                    onClick={() => void decideTrial("restore")}
                  >
                    恢复接受前原文
                  </Button>
                )}
              </div>
              {Boolean(draft.trial?.restoredAt) && (
                <InlineAlert
                  tone="info"
                  title="已恢复原文"
                  description="恢复以新版本完成，AI 建议版本与历史版本均未删除。"
                />
              )}

              <h3>告诉墨影下一版怎样调整</h3>
              <div className="settings-actions" aria-label="试改反馈">
                {FEEDBACK_PRESETS.map(({ id, label }) => {
                  const selected = draft.feedbackPresetIds.includes(id);
                  return (
                    <Button
                      key={id}
                      size="sm"
                      variant={selected ? "ai-primary" : "secondary"}
                      aria-pressed={selected}
                      onClick={() => toggleFeedback(id)}
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
              <FormField label="自定义反馈" hint="例如：保留第一句，但让人物的反应更克制。">
                {(fieldProps) => (
                  <Textarea
                    {...fieldProps}
                    value={draft.feedbackText}
                    maxLength={2_000}
                    currentLength={draft.feedbackText.length}
                    onChange={(event) =>
                      patchDraft({
                        feedbackText: event.currentTarget.value.slice(0, 2_000),
                        rulesSavedAt: null,
                      })
                    }
                  />
                )}
              </FormField>
              <Button variant="secondary" onClick={formRules}>
                按当前目标和反馈形成规则
              </Button>
            </section>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle headingLevel={2}>第 5 步：确认规则后逐章处理</CardTitle>
          <CardDescription>规则可编辑、停用或删除；每个章节只生成自己的建议版本。</CardDescription>
        </CardHeader>
        <CardContent>
          {draft.rules.length === 0 ? (
            <p>完成一次代表段落试改后，使用反馈形成可编辑规则。</p>
          ) : (
            <div aria-label="可编辑改写规则">
              {draft.rules.map((rule, index) => (
                <div key={rule.id} className="settings-actions">
                  <input
                    type="checkbox"
                    aria-label={`启用规则 ${String(index + 1)}`}
                    checked={rule.enabled}
                    onChange={() => toggleRule(rule.id)}
                  />
                  <Input
                    aria-label={`规则 ${String(index + 1)}`}
                    value={rule.text}
                    maxLength={1_000}
                    onChange={(event) => updateRule(rule.id, event.currentTarget.value)}
                  />
                  <Button size="sm" variant="ghost" onClick={() => removeRule(rule.id)}>
                    删除
                  </Button>
                </div>
              ))}
              <div className="settings-actions">
                <Button size="sm" variant="secondary" onClick={addRule}>
                  添加规则
                </Button>
                <Button size="sm" onClick={saveRules}>
                  保留当前规则
                </Button>
                {draft.rulesSavedAt !== null && <Badge tone="success">规则已保留</Badge>}
              </div>
            </div>
          )}

          {draft.rulesSavedAt !== null && (
            <>
              <InlineAlert
                tone="info"
                title="批量前安全确认"
                description="开始后按章节逐个调用模型和创建建议版本；不会自动接受，单章失败也不会改动其他章节原文。"
              />
              <div className="settings-actions">
                <Button disabled={!canStartBatch} onClick={() => void generateBatch()}>
                  {operation === "batch"
                    ? "正在逐章生成…"
                    : draft.batchItems.length > 0
                      ? "重新逐章生成"
                      : "开始逐章处理"}
                </Button>
                {draft.batchItems.some(({ status }) => status === "ready") && (
                  <Button
                    variant="secondary"
                    disabled={operation !== "idle"}
                    onClick={() => void acceptAllReady()}
                  >
                    接受全部就绪建议
                  </Button>
                )}
              </div>
            </>
          )}

          {draft.batchItems.length > 0 && (
            <ul className="privacy-list" aria-label="逐章建议版本">
              {draft.batchItems.map((item) => (
                <li key={item.chapterId}>
                  <strong>{item.chapterTitle}</strong>：{batchStatusLabel(item)}
                  {item.providerId !== null && item.modelId !== null && (
                    <span>
                      ；{item.providerId} / {item.modelId}
                    </span>
                  )}
                  {item.errorCode !== null && <span>（{item.errorCode}）</span>}
                  {item.candidateId !== null && (
                    <div className="settings-actions">
                      {draft.importedWork !== null && (
                        <Link
                          to={`/projects/${draft.importedWork.projectId}/chapters/${item.chapterId}?candidate=${item.candidateId}`}
                        >
                          查看完整差异
                        </Link>
                      )}
                      {item.status === "ready" && (
                        <Button
                          size="sm"
                          disabled={operation !== "idle"}
                          onClick={() => void decideBatchItem(item, "accept")}
                        >
                          接受
                        </Button>
                      )}
                      {item.status === "ready" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={operation !== "idle"}
                          onClick={() => void decideBatchItem(item, "reject")}
                        >
                          拒绝
                        </Button>
                      )}
                      {item.status === "accepted" && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={operation !== "idle"}
                          onClick={() => void decideBatchItem(item, "restore")}
                        >
                          恢复原文
                        </Button>
                      )}
                    </div>
                  )}
                  {(item.status === "ready" ||
                    item.status === "rejected" ||
                    item.status === "error") && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={operation !== "idle"}
                      onClick={() => void decideBatchItem(item, "regenerate")}
                    >
                      重新生成
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function JourneyStep(props: {
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly state: "complete" | "current" | "pending";
}) {
  return (
    <li data-state={props.state}>
      <strong>
        {String(props.number)}. {props.title}
      </strong>{" "}
      <span>{props.description}</span>{" "}
      <Badge tone={props.state === "complete" ? "success" : "neutral"}>
        {props.state === "complete" ? "已完成" : props.state === "current" ? "当前" : "稍后"}
      </Badge>
    </li>
  );
}

function analysisLabel(analysis: AnalysisState): string {
  if (analysis.status === "ready") return "基础分析完成";
  if (analysis.status === "loading") return "正在分析";
  if (analysis.status === "error") return "读取失败";
  return "等待导入";
}

function buildTargetInstructions(draft: ImportJourneyDraft): readonly string[] {
  return [
    ...REWRITE_PRESETS.filter(({ id }) => draft.selectedPresetIds.includes(id)).map(
      ({ label }) => label,
    ),
    ...(draft.goal.trim().length === 0 ? [] : [draft.goal.trim()]),
  ];
}

function trialBlockedReason(
  draft: ImportJourneyDraft,
  analysis: AnalysisState,
  operation: string,
): string {
  if (draft.importedWork === null) return "请先完成第 1 步的安全导入。";
  if (analysis.status !== "ready") return "请等待本地结构分析完成。";
  if (analysis.value.representativeChapter === null)
    return "导入作品没有含正文的章节，无法选择代表段落。";
  if (buildTargetInstructions(draft).length === 0) return "请先写一句处理目标或选择一个常用方向。";
  if (operation !== "idle") return "当前操作完成后即可继续。";
  return "可以生成试改。";
}

function trialPointerFromResult(result: ImportRewriteCandidateResult): TrialPointer {
  const chapterId = result.candidate.chapterId;
  if (chapterId === null) {
    throw new UiActionError(
      "IMPORT_TRIAL_CHAPTER_MISSING",
      "这份试改建议没有关联到章节，系统已停止应用以保护原文。请重新选择代表段落并生成试改。",
    );
  }
  return Object.freeze({
    candidateId: result.candidate.id,
    chapterId,
    excerptStart: result.excerptStart,
    excerptEnd: result.excerptEnd,
    providerId: result.providerId,
    modelId: result.modelId,
    requestId: result.requestId,
    restoredAt: null,
  });
}

async function loadTrialView(
  runtime: ReturnType<typeof useRuntime>,
  pointer: TrialPointer,
): Promise<TrialViewState> {
  try {
    const candidateResult = await runtime.repositories.aiCandidates.findById(pointer.candidateId);
    if (!candidateResult.ok) throw candidateResult.error;
    const candidate = candidateResult.value;
    if (candidate?.chapterId !== pointer.chapterId || candidate.baseVersionId === null)
      throw new ImportJourneyError("CANDIDATE_NOT_FOUND", "找不到已保存的试改建议。");
    const baseResult = await runtime.repositories.chapterVersions.findVersionById(
      candidate.baseVersionId,
    );
    if (!baseResult.ok) throw baseResult.error;
    if (baseResult.value === null)
      throw new ImportJourneyError("BASE_VERSION_CHANGED", "试改所依据的原文版本已不可用。");
    const original = baseResult.value.toSnapshot().content;
    if (
      pointer.excerptStart < 0 ||
      pointer.excerptEnd < pointer.excerptStart ||
      pointer.excerptEnd > original.length
    )
      throw new ImportJourneyError("IMPORT_TRIAL_POINTER_INVALID", "试改比较范围无效。");
    const suffixLength = original.length - pointer.excerptEnd;
    const rewrittenEnd = candidate.content.length - suffixLength;
    if (rewrittenEnd < pointer.excerptStart)
      throw new ImportJourneyError("IMPORT_TRIAL_POINTER_INVALID", "试改建议与原文范围不匹配。");
    return {
      status: "ready",
      candidate,
      originalExcerpt: original.slice(pointer.excerptStart, pointer.excerptEnd),
      rewrittenExcerpt: candidate.content.slice(pointer.excerptStart, rewrittenEnd),
    };
  } catch (cause: unknown) {
    return { status: "error", error: normalizeUiError(cause) };
  }
}

function compileEditableRules(draft: ImportJourneyDraft): readonly RewriteRuleDraft[] {
  const feedbackMap: Record<FeedbackPresetId, string> = {
    "change-smaller": "控制改动幅度，优先保留原句结构和原有信息",
    "change-larger": "在不改变主要剧情的前提下，提高语言与节奏的改写幅度",
    "natural-dialogue": "让人物对话更自然，并符合人物之间的关系",
    "restrained-description": "减少堆叠修饰和过度环境描写，表达更克制",
    "faster-pace": "压缩重复信息和停滞段落，让场景推进更快",
    "keep-style": "保留原作已经形成的叙述风格和用词习惯",
  };
  const texts = [
    "保留主要剧情、已发生事件和人物姓名",
    "不增加原文没有依据的新世界规则或超自然设定",
    ...buildTargetInstructions(draft),
    ...draft.feedbackPresetIds.map((id) => feedbackMap[id]),
    ...(draft.feedbackText.trim().length === 0 ? [] : [draft.feedbackText.trim()]),
  ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  return texts.map((text, index) => ({ id: `rule-${String(index + 1)}`, text, enabled: true }));
}

function candidateStatusLabel(status: AiCandidate["status"]): string {
  const labels: Record<AiCandidate["status"], string> = {
    streaming: "生成中",
    ready: "等待决定",
    accepted: "已接受",
    rejected: "已拒绝",
    expired: "已失效",
  };
  return labels[status];
}

function batchStatusLabel(item: BatchItemDraft): string {
  const labels: Record<BatchStatus, string> = {
    queued: "等待生成",
    generating: "正在生成",
    ready: "建议版本已就绪",
    accepted: "已接受为新正文版本",
    rejected: "已拒绝，原文未变",
    restored: "已恢复接受前原文",
    error: "处理失败，原文未变",
  };
  return labels[item.status];
}

function readJourneyDraft(): ImportJourneyDraft {
  try {
    const serialized = window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY);
    if (serialized === null) return EMPTY_DRAFT;
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null) return EMPTY_DRAFT;
    const candidate = parsed as Partial<ImportJourneyDraft>;
    const knownPresetIds = new Set<RewritePresetId>(REWRITE_PRESETS.map(({ id }) => id));
    const knownFeedbackIds = new Set<FeedbackPresetId>(FEEDBACK_PRESETS.map(({ id }) => id));
    return {
      version: 2,
      goal: typeof candidate.goal === "string" ? candidate.goal.slice(0, 4_000) : "",
      selectedPresetIds: filterKnownIds(candidate.selectedPresetIds, knownPresetIds),
      importedWork: isCompletedImport(candidate.importedWork) ? candidate.importedWork : null,
      feedbackPresetIds: filterKnownIds(candidate.feedbackPresetIds, knownFeedbackIds),
      feedbackText:
        typeof candidate.feedbackText === "string" ? candidate.feedbackText.slice(0, 2_000) : "",
      trial: parseTrialPointer(candidate.trial),
      rules: parseRules(candidate.rules),
      rulesSavedAt: isIsoTimestamp(candidate.rulesSavedAt) ? candidate.rulesSavedAt : null,
      batchItems: parseBatchItems(candidate.batchItems),
      workAnalysis: parseWorkAnalysisDraft(candidate.workAnalysis),
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : "",
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeJourneyDraft(draft: ImportJourneyDraft): void {
  try {
    window.localStorage.setItem(IMPORT_JOURNEY_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    /* The form remains usable when local storage is unavailable. */
  }
}

function readPendingRequest(): PendingRewriteRequest | null {
  try {
    const serialized = window.localStorage.getItem(IMPORT_REWRITE_PENDING_STORAGE_KEY);
    if (serialized === null) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Partial<PendingRewriteRequest>;
    const chapterId =
      typeof candidate.chapterId === "string" ? parseUuidV7(candidate.chapterId) : null;
    if (
      chapterId?.ok !== true ||
      typeof candidate.requestId !== "string" ||
      typeof candidate.providerId !== "string" ||
      typeof candidate.modelId !== "string" ||
      (candidate.kind !== "trial" &&
        candidate.kind !== "chapter" &&
        candidate.kind !== "analysis_character" &&
        candidate.kind !== "analysis_story") ||
      !isIsoTimestamp(candidate.startedAt)
    ) {
      return null;
    }
    return {
      requestId: candidate.requestId,
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      chapterId: chapterId.value,
      kind: candidate.kind,
      startedAt: candidate.startedAt,
    };
  } catch {
    return null;
  }
}

function writePendingRequest(pending: PendingRewriteRequest | null): void {
  try {
    if (pending === null) {
      window.localStorage.removeItem(IMPORT_REWRITE_PENDING_STORAGE_KEY);
    } else {
      window.localStorage.setItem(IMPORT_REWRITE_PENDING_STORAGE_KEY, JSON.stringify(pending));
    }
  } catch {
    // A blocked storage write never changes the stable chapter or triggers an automatic retry.
  }
}

function isCompletedImport(value: unknown): value is CompletedImport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CompletedImport>;
  return (
    typeof candidate.projectId === "string" &&
    parseUuidV7(candidate.projectId).ok &&
    typeof candidate.firstChapterId === "string" &&
    parseUuidV7(candidate.firstChapterId).ok &&
    typeof candidate.projectName === "string" &&
    candidate.projectName.length > 0 &&
    typeof candidate.chapterCount === "number" &&
    Number.isInteger(candidate.chapterCount) &&
    candidate.chapterCount > 0
  );
}

function filterKnownIds<T extends string>(value: unknown, known: ReadonlySet<T>): readonly T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => typeof item === "string" && known.has(item as T))
    : [];
}

function parseTrialPointer(value: unknown): TrialPointer | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<TrialPointer>;
  const candidateId = typeof item.candidateId === "string" ? parseUuidV7(item.candidateId) : null;
  const chapterId = typeof item.chapterId === "string" ? parseUuidV7(item.chapterId) : null;
  if (
    candidateId?.ok !== true ||
    chapterId?.ok !== true ||
    !isNonNegativeSafeInteger(item.excerptStart) ||
    !isNonNegativeSafeInteger(item.excerptEnd) ||
    item.excerptEnd < item.excerptStart ||
    typeof item.providerId !== "string" ||
    typeof item.modelId !== "string" ||
    typeof item.requestId !== "string"
  )
    return null;
  return {
    candidateId: candidateId.value,
    chapterId: chapterId.value,
    excerptStart: item.excerptStart,
    excerptEnd: item.excerptEnd,
    providerId: item.providerId,
    modelId: item.modelId,
    requestId: item.requestId,
    restoredAt: isIsoTimestamp(item.restoredAt) ? item.restoredAt : null,
  };
}

function parseRules(value: unknown): readonly RewriteRuleDraft[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item, index) => {
      if (typeof item !== "object" || item === null) return [];
      const rule = item as Partial<RewriteRuleDraft>;
      if (
        typeof rule.text !== "string" ||
        rule.text.length > 1_000 ||
        typeof rule.enabled !== "boolean"
      )
        return [];
      return [
        {
          id:
            typeof rule.id === "string" && rule.id.length <= 100
              ? rule.id
              : `restored-${String(index)}`,
          text: rule.text,
          enabled: rule.enabled,
        },
      ];
    })
    .slice(0, 30);
}

function parseBatchItems(value: unknown): readonly BatchItemDraft[] {
  if (!Array.isArray(value)) return [];
  const statuses = new Set<BatchStatus>([
    "queued",
    "generating",
    "ready",
    "accepted",
    "rejected",
    "restored",
    "error",
  ]);
  return value
    .flatMap((raw) => {
      if (typeof raw !== "object" || raw === null) return [];
      const item = raw as Partial<BatchItemDraft>;
      const chapterId = typeof item.chapterId === "string" ? parseUuidV7(item.chapterId) : null;
      const candidateId =
        typeof item.candidateId === "string" ? parseUuidV7(item.candidateId) : null;
      if (
        chapterId?.ok !== true ||
        typeof item.chapterTitle !== "string" ||
        typeof item.status !== "string" ||
        !statuses.has(item.status)
      )
        return [];
      const status =
        item.status === "queued" || item.status === "generating" ? "error" : item.status;
      return [
        {
          chapterId: chapterId.value,
          chapterTitle: item.chapterTitle.slice(0, 200),
          candidateId: candidateId?.ok === true ? candidateId.value : null,
          status,
          providerId: typeof item.providerId === "string" ? item.providerId : null,
          modelId: typeof item.modelId === "string" ? item.modelId : null,
          errorCode:
            status === "error"
              ? typeof item.errorCode === "string"
                ? item.errorCode
                : "IMPORT_REWRITE_INTERRUPTED"
              : null,
        },
      ];
    })
    .slice(0, 10_000);
}

function reconcileWorkAnalysisDraft(
  existing: WorkAnalysisDraft | null,
  projectId: UuidV7,
  chapters: readonly Chapter[],
  now: string,
): WorkAnalysisDraft {
  const reusable = new Map(
    existing?.projectId === projectId
      ? existing.jobs.map((job) => [workAnalysisJobKey(job), job] as const)
      : [],
  );
  const jobs = chapters
    .filter(({ status, content }) => status === "active" && content.trim().length > 0)
    .flatMap((chapter) =>
      IMPORT_WORK_ANALYSIS_STAGES.map((stage) => {
        const key = `${chapter.id}:${chapter.currentVersionId}:${stage}`;
        const previous = reusable.get(key);
        return (
          previous ??
          Object.freeze({
            chapterId: chapter.id,
            chapterTitle: chapter.title,
            sourceVersionId: chapter.currentVersionId,
            stage,
            status: "pending" as const,
            factCount: 0,
            criticalFactCount: 0,
            factTypeCounts: Object.freeze({}),
            requestCount: 0,
            providerId: null,
            modelId: null,
            errorCode: null,
          })
        );
      }),
    );
  const completed = jobs.every(({ status }) => status === "ready" || status === "skipped");
  return Object.freeze({
    version: 1,
    projectId,
    jobs: Object.freeze(jobs),
    startedAt: existing?.projectId === projectId ? existing.startedAt : now,
    updatedAt: now,
    completedAt: completed ? (existing?.completedAt ?? now) : null,
  });
}

function updateWorkAnalysisJob(
  jobs: readonly WorkAnalysisJobDraft[],
  target: WorkAnalysisJobDraft,
  patch: Partial<
    Pick<
      WorkAnalysisJobDraft,
      | "status"
      | "factCount"
      | "criticalFactCount"
      | "factTypeCounts"
      | "requestCount"
      | "providerId"
      | "modelId"
      | "errorCode"
    >
  >,
): WorkAnalysisJobDraft[] {
  return jobs.map((job) => (sameWorkAnalysisJob(job, target) ? { ...job, ...patch } : job));
}

function sameWorkAnalysisJob(left: WorkAnalysisJobDraft, right: WorkAnalysisJobDraft): boolean {
  return workAnalysisJobKey(left) === workAnalysisJobKey(right);
}

function workAnalysisJobKey(job: WorkAnalysisJobDraft): string {
  return `${job.chapterId}:${job.sourceVersionId}:${job.stage}`;
}

function parseWorkAnalysisDraft(value: unknown): WorkAnalysisDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<WorkAnalysisDraft>;
  const projectId =
    typeof candidate.projectId === "string" ? parseUuidV7(candidate.projectId) : null;
  if (candidate.version !== 1 || projectId?.ok !== true || !Array.isArray(candidate.jobs)) {
    return null;
  }
  const seen = new Set<string>();
  const jobs = candidate.jobs.flatMap((value): readonly WorkAnalysisJobDraft[] => {
    if (typeof value !== "object" || value === null) return [];
    const job = value as Partial<WorkAnalysisJobDraft>;
    const chapterId = typeof job.chapterId === "string" ? parseUuidV7(job.chapterId) : null;
    const sourceVersionId =
      typeof job.sourceVersionId === "string" ? parseUuidV7(job.sourceVersionId) : null;
    if (
      chapterId?.ok !== true ||
      sourceVersionId?.ok !== true ||
      typeof job.chapterTitle !== "string" ||
      job.chapterTitle.length < 1 ||
      job.chapterTitle.length > 200 ||
      !isImportWorkAnalysisStage(job.stage) ||
      !isWorkAnalysisJobStatus(job.status) ||
      !isNonNegativeSafeInteger(job.factCount) ||
      !isNonNegativeSafeInteger(job.criticalFactCount) ||
      !isNonNegativeSafeInteger(job.requestCount)
    ) {
      return [];
    }
    const restored: WorkAnalysisJobDraft = {
      chapterId: chapterId.value,
      chapterTitle: job.chapterTitle,
      sourceVersionId: sourceVersionId.value,
      stage: job.stage,
      status: job.status === "running" ? "error" : job.status,
      factCount: job.factCount,
      criticalFactCount: job.criticalFactCount,
      factTypeCounts: parseWorkAnalysisFactCounts(job.factTypeCounts),
      requestCount: job.requestCount,
      providerId: typeof job.providerId === "string" ? job.providerId.slice(0, 300) : null,
      modelId: typeof job.modelId === "string" ? job.modelId.slice(0, 300) : null,
      errorCode:
        job.status === "running"
          ? "IMPORT_ANALYSIS_INTERRUPTED"
          : typeof job.errorCode === "string"
            ? job.errorCode.slice(0, 100)
            : null,
    };
    const key = workAnalysisJobKey(restored);
    if (seen.has(key)) return [];
    seen.add(key);
    return [Object.freeze(restored)];
  });
  if (jobs.length > 20_000) return null;
  const completed = jobs.every(({ status }) => status === "ready" || status === "skipped");
  return Object.freeze({
    version: 1,
    projectId: projectId.value,
    jobs: Object.freeze(jobs),
    startedAt: isIsoTimestamp(candidate.startedAt)
      ? candidate.startedAt
      : new Date(0).toISOString(),
    updatedAt: isIsoTimestamp(candidate.updatedAt)
      ? candidate.updatedAt
      : new Date(0).toISOString(),
    completedAt: completed && isIsoTimestamp(candidate.completedAt) ? candidate.completedAt : null,
  });
}

function parseWorkAnalysisFactCounts(
  value: unknown,
): Readonly<Partial<Record<ImportWorkAnalysisFactType, number>>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({});
  }
  const counts: Partial<Record<ImportWorkAnalysisFactType, number>> = {};
  for (const factType of Object.keys(value)) {
    if (!(IMPORT_WORK_ANALYSIS_FACT_TYPES as readonly string[]).includes(factType)) continue;
    const count = (value as Record<string, unknown>)[factType];
    if (isNonNegativeSafeInteger(count)) {
      counts[factType as ImportWorkAnalysisFactType] = count;
    }
  }
  return Object.freeze(counts);
}

interface WorkAnalysisSummary {
  readonly totalJobs: number;
  readonly readyJobs: number;
  readonly skippedJobs: number;
  readonly remainingJobs: number;
  readonly finishedJobs: number;
  readonly factCount: number;
  readonly criticalFactCount: number;
  readonly categories: readonly Readonly<{ key: string; label: string; count: number }>[];
  readonly models: readonly string[];
  readonly problemJobs: readonly WorkAnalysisJobDraft[];
}

const WORK_ANALYSIS_CATEGORIES: readonly Readonly<{
  key: string;
  label: string;
  factTypes: readonly ImportWorkAnalysisFactType[];
}>[] = Object.freeze([
  {
    key: "character",
    label: "人物",
    factTypes: ["character_identity", "character_death", "character_state"],
  },
  {
    key: "relationship",
    label: "人物关系",
    factTypes: ["core_relationship", "relationship_change"],
  },
  {
    key: "world",
    label: "世界设定",
    factTypes: ["world_rule", "world_setting", "key_item_ownership", "major_ability_change"],
  },
  {
    key: "timeline",
    label: "时间线",
    factTypes: ["timeline_event", "major_timeline_change"],
  },
  { key: "pov", label: "叙事视角", factTypes: ["narrative_pov"] },
  { key: "style", label: "写作风格", factTypes: ["writing_style"] },
  { key: "event", label: "已发生事件", factTypes: ["causal_event"] },
  { key: "foreshadow", label: "伏笔", factTypes: ["foreshadow", "foreshadow_status"] },
  { key: "plot", label: "当前剧情状态", factTypes: ["current_plot_state"] },
  { key: "summary", label: "章节摘要", factTypes: ["chapter_summary"] },
]);

function summarizeWorkAnalysis(value: WorkAnalysisDraft | null): WorkAnalysisSummary {
  const jobs = value?.jobs ?? [];
  const counts: Partial<Record<ImportWorkAnalysisFactType, number>> = {};
  for (const job of jobs) {
    for (const [factType, count] of Object.entries(job.factTypeCounts)) {
      if ((IMPORT_WORK_ANALYSIS_FACT_TYPES as readonly string[]).includes(factType)) {
        const typed = factType as ImportWorkAnalysisFactType;
        counts[typed] = (counts[typed] ?? 0) + count;
      }
    }
  }
  const readyJobs = jobs.filter(({ status }) => status === "ready").length;
  const skippedJobs = jobs.filter(({ status }) => status === "skipped").length;
  const models = new Set(
    jobs.flatMap(({ providerId, modelId }) =>
      providerId === null || modelId === null ? [] : [`${providerId} / ${modelId}`],
    ),
  );
  return Object.freeze({
    totalJobs: jobs.length,
    readyJobs,
    skippedJobs,
    remainingJobs: jobs.length - readyJobs - skippedJobs,
    finishedJobs: readyJobs + skippedJobs,
    factCount: jobs.reduce((total, job) => total + job.factCount, 0),
    criticalFactCount: jobs.reduce((total, job) => total + job.criticalFactCount, 0),
    categories: Object.freeze(
      WORK_ANALYSIS_CATEGORIES.map(({ key, label, factTypes }) =>
        Object.freeze({
          key,
          label,
          count: factTypes.reduce((total, factType) => total + (counts[factType] ?? 0), 0),
        }),
      ),
    ),
    models: Object.freeze([...models].sort()),
    problemJobs: Object.freeze(jobs.filter(({ status }) => status === "error")),
  });
}

function analysisStageLabel(stage: ImportWorkAnalysisStage): string {
  return stage === "character" ? "人物、关系与叙事" : "世界、事件与剧情";
}

function isImportWorkAnalysisStage(value: unknown): value is ImportWorkAnalysisStage {
  return value === "character" || value === "story";
}

function isWorkAnalysisJobStatus(value: unknown): value is WorkAnalysisJobStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "ready" ||
    value === "error" ||
    value === "skipped"
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}
