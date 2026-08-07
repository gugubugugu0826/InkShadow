import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent as ReactSyntheticEvent,
} from "react";
import {
  diffCandidateContent,
  type CandidateApplicationStrategy,
  type CandidateTextDiff,
} from "@inkshadow/application";
import type {
  CandidateQualityGateResult,
  ContextEvidenceSourceType,
  ContextLayer,
} from "@inkshadow/ai-core";
import { DEFAULT_USER_SETTINGS } from "@inkshadow/config";
import type {
  AiCandidate,
  Chapter,
  ChapterVersion,
  Project,
  RecoveryDraft,
} from "@inkshadow/domain";
import { parseUuidV7 } from "@inkshadow/domain";
import type { SaveState } from "@inkshadow/contracts/states";
import {
  Badge,
  Button,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
  SaveStatus,
  Select,
  Textarea,
} from "@inkshadow/ui";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  canDeferGenerationPlan,
  cancelGenerationPlan,
  executeGenerationPlan,
  prepareGenerationPlan,
  saveDeferredGenerationPlan,
  type PreparedGenerationPlan,
  type RuntimeStory,
} from "../infrastructure/runtime";
import { normalizeUiError, UiActionError } from "../infrastructure/ui-error";
import type {
  DeferredGenerationRequest,
  GenerationAttemptUsage,
  GenerationBudgetPolicy,
  GenerationRun,
} from "../infrastructure/generation-governance-store";
import {
  shouldRunContinuousStoryStateExtraction,
  type ContinuousStoryStateExtractionReceipt,
} from "../infrastructure/continuous-story-state-extraction";
import {
  shouldRunChapterSummaryAfterSave,
  type ChapterSummaryGenerationReceipt,
} from "../infrastructure/chapter-summary-service";
import { useOnlineStatus } from "../hooks/use-online-status";
import {
  EDITOR_FIND_QUERY_LIMIT,
  EDITOR_REPLACEMENT_LIMIT,
  createEditorEditFromSelectionTransition,
  createEditorEditFromTransition,
  createEditorRangeEdit,
  createEmptyEditorHistory,
  findLiteral,
  normalizeEditorSelection,
  recordEditorEdit,
  redoEditorEdit,
  replaceAllLiteral,
  sanitizePlainTextPaste,
  undoEditorEdit,
  type EditorEdit,
  type EditorHistory,
  type EditorSelection,
} from "../infrastructure/editor-text-operations";
import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  loadEditorView,
  saveEditorTypography,
  saveEditorView,
  type EditorFontFamily,
  type EditorMeasure,
  type EditorTypography,
} from "../infrastructure/editor-view-state-store";
import {
  desktopPersistenceLifecycle,
  SerializedPersistenceQueue,
  type PersistenceFlushHandlerResult,
  type PersistenceFlushOutcome,
} from "../infrastructure/persistence-lifecycle";
import { useRuntime } from "../runtime-context";
import { CrashRecoveryDialog } from "../components/crash-recovery-dialog";
import { CandidateFeedbackControls } from "../components/candidate-feedback-controls";
import {
  EditorAiSuggestionDiffViewer,
  type AiSuggestionDiffDecision,
} from "./editor-ai-suggestion-diff-viewer";

const versionReasonLabels: Record<ReturnType<ChapterVersion["toSnapshot"]>["reason"], string> = {
  created: "创建",
  autosave: "自动保存",
  manual: "手动保存",
  candidate_accept: "接受 AI 建议",
  recovery: "恢复版本",
  import: "导入",
};

const selectionDerivedInputTypes = new Set([
  "deleteByCut",
  "deleteContent",
  "deleteContentBackward",
  "deleteContentForward",
  "insertLineBreak",
  "insertParagraph",
  "insertText",
]);

const RECOVERY_DRAFT_DEBOUNCE_MS = 350;
const AUTOSAVE_DEBOUNCE_MS = DEFAULT_USER_SETTINGS.autosaveDebounceMs;
const BACKGROUND_FLUSH_TIMEOUT_MS = 3_000;

const chapterListPanelStyle: CSSProperties = {
  flex: "0 0 12rem",
  maxHeight: "calc(100vh - 12rem)",
};

const collapsedPanelStyle: CSSProperties = {
  flex: "0 0 auto",
  alignSelf: "flex-start",
  padding: "var(--space-2)",
};

const writingCanvasFlexStyle: CSSProperties = {
  flex: "1 1 28rem",
};

const assistantPanelStyle: CSSProperties = {
  flex: "0 1 18rem",
  maxHeight: "calc(100vh - 12rem)",
};

interface CandidateRouteSelection {
  readonly candidate: AiCandidate | null;
  readonly notice: string | null;
}

type StoryStateUpdateNotice =
  | Readonly<{ state: "idle" | "running" }>
  | Readonly<{
      state: "ready";
      detectedCount: number;
      needsConfirmationCount: number;
      reversibleCount: number;
      skippedTaskCount: number;
    }>
  | Readonly<{ state: "failed"; message: string }>;

type ChapterSummaryNotice =
  | Readonly<{ state: "idle" | "running" }>
  | Readonly<{
      state: "finished";
      status: ChapterSummaryGenerationReceipt["status"];
      message: string;
    }>;

function selectEditorCandidate(
  candidates: readonly AiCandidate[],
  requestedCandidateId: string | null,
  projectId: NonNullable<AiCandidate["chapterId"]>,
  chapterId: NonNullable<AiCandidate["chapterId"]>,
): CandidateRouteSelection {
  if (requestedCandidateId === null) {
    return Object.freeze({
      candidate: candidates[0] ?? null,
      notice: null,
    });
  }

  const parsedCandidateId = parseUuidV7(requestedCandidateId);
  if (!parsedCandidateId.ok) {
    return Object.freeze({
      candidate: null,
      notice: "AI 建议链接无效；未自动打开其他建议。请从深度审稿页重新选择。",
    });
  }

  const candidate =
    candidates.find(
      (item) =>
        item.id === parsedCandidateId.value &&
        item.projectId === projectId &&
        item.chapterId === chapterId &&
        item.status === "ready",
    ) ?? null;
  return Object.freeze({
    candidate,
    notice:
      candidate === null
        ? "链接指定的 AI 建议不存在、已处理，或不属于当前项目与章节；未自动打开其他建议。"
        : null,
  });
}

export function EditorPage() {
  const runtime = useRuntime();
  const online = useOnlineStatus();
  const params = useParams<{ projectId: string; chapterId: string }>();
  const [searchParams] = useSearchParams();
  const requestedCandidateId = searchParams.get("candidate");
  const parsedProjectId = parseUuidV7(params.projectId ?? "");
  const parsedChapterId = parseUuidV7(params.chapterId ?? "");
  const projectId = parsedProjectId.ok ? parsedProjectId.value : null;
  const chapterId = parsedChapterId.ok ? parsedChapterId.value : null;
  const [project, setProject] = useState<Project | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [chapters, setChapters] = useState<readonly Chapter[]>([]);
  const [content, setContent] = useState("");
  const [pageState, setPageState] = useState<"loading" | "ready" | "fatal_error" | "conflict">(
    "loading",
  );
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [error, setError] = useState<unknown>(
    !parsedProjectId.ok
      ? parsedProjectId.error
      : !parsedChapterId.ok
        ? parsedChapterId.error
        : null,
  );
  const [recovered, setRecovered] = useState(false);
  const [recoveryDraft, setRecoveryDraft] = useState<RecoveryDraft | null>(null);
  const [recoveryDecisionOpen, setRecoveryDecisionOpen] = useState(false);
  const [recoveryDecisionBusy, setRecoveryDecisionBusy] = useState(false);
  const [recoveryCopySaved, setRecoveryCopySaved] = useState(false);
  const [versions, setVersions] = useState<readonly ChapterVersion[]>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionToRestore, setVersionToRestore] = useState<ChapterVersion | null>(null);
  const [versionRestoreBusy, setVersionRestoreBusy] = useState(false);
  const [candidate, setCandidate] = useState<AiCandidate | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [candidateReviewOpen, setCandidateReviewOpen] = useState(false);
  const [candidateDiff, setCandidateDiff] = useState<CandidateTextDiff | null>(null);
  const [candidateDiffDecisions, setCandidateDiffDecisions] = useState<
    Readonly<Record<string, AiSuggestionDiffDecision | undefined>>
  >({});
  const [candidateReviewError, setCandidateReviewError] = useState<string | null>(null);
  const [candidateReviewConflict, setCandidateReviewConflict] = useState<{
    readonly baselineContent: string;
    readonly currentContent: string;
  } | null>(null);
  const [candidateCopySaved, setCandidateCopySaved] = useState(false);
  const [candidateReviewSelection, setCandidateReviewSelection] = useState<EditorSelection>({
    start: 0,
    end: 0,
  });
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [generationPlan, setGenerationPlan] = useState<PreparedGenerationPlan | null>(null);
  const [generationReceipt, setGenerationReceipt] = useState<GenerationRun | null>(null);
  const [candidateQualityGate, setCandidateQualityGate] =
    useState<CandidateQualityGateResult | null>(null);
  const [generationAttemptUsage, setGenerationAttemptUsage] = useState<
    readonly GenerationAttemptUsage[]
  >([]);
  const [deferredGeneration, setDeferredGeneration] = useState<DeferredGenerationRequest | null>(
    null,
  );
  const [budgetPolicies, setBudgetPolicies] = useState<readonly GenerationBudgetPolicy[]>([]);
  const [projectBudgetAmount, setProjectBudgetAmount] = useState("");
  const [monthBudgetAmount, setMonthBudgetAmount] = useState("");
  const [projectBudgetEnforcement, setProjectBudgetEnforcement] = useState<"warn" | "hard">("hard");
  const [monthBudgetEnforcement, setMonthBudgetEnforcement] = useState<"warn" | "hard">("warn");
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [generationPreview, setGenerationPreview] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  const [historyAvailability, setHistoryAvailability] = useState({
    canUndo: false,
    canRedo: false,
  });
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replacementText, setReplacementText] = useState("");
  const [findStatus, setFindStatus] = useState<string | null>(null);
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  const [typography, setTypography] = useState<EditorTypography>(DEFAULT_EDITOR_TYPOGRAPHY);
  const [selectionRequestId, setSelectionRequestId] = useState(0);
  const [selectionLength, setSelectionLength] = useState(0);
  const [chapterListOpen, setChapterListOpen] = useState(true);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [storyStateUpdate, setStoryStateUpdate] = useState<StoryStateUpdateNotice>({
    state: "idle",
  });
  const [chapterSummaryUpdate, setChapterSummaryUpdate] = useState<ChapterSummaryNotice>({
    state: "idle",
  });
  const chapterRef = useRef<Chapter | null>(null);
  const contentRef = useRef("");
  const cursorRef = useRef(0);
  const selectionRef = useRef<EditorSelection>({ start: 0, end: 0 });
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const historyRef = useRef<EditorHistory>(createEmptyEditorHistory());
  const compositionBaseRef = useRef<{
    readonly content: string;
    readonly selection: EditorSelection;
  } | null>(null);
  const pendingSelectionRef = useRef<{
    readonly selection: EditorSelection;
    readonly focus: boolean;
    readonly scrollTop: number | null;
  } | null>(null);
  const nativeInputTypeRef = useRef<string | null>(null);
  const scrollTopRef = useRef(0);
  const typographyRef = useRef<EditorTypography>(DEFAULT_EDITOR_TYPOGRAPHY);
  const viewStateTimerRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const draftTimerRef = useRef<number | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const operationQueueRef = useRef(new SerializedPersistenceQueue());
  const flushInFlightRef = useRef<Promise<PersistenceFlushHandlerResult> | null>(null);
  const activeGenerationPlanRef = useRef<PreparedGenerationPlan | null>(null);
  const generationEstimate = generationPlan?.preflight.estimate ?? null;

  const clearScheduledPersistence = useCallback((): void => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const loadVersions = useCallback(async () => {
    if (chapterId === null) {
      return;
    }
    const result = await runtime.useCases.listChapterVersions.execute(chapterId);
    if (result.ok) {
      setVersions(result.value);
    }
  }, [chapterId, runtime]);

  const loadChapters = useCallback(async () => {
    if (projectId === null) {
      return;
    }
    const result = await runtime.repositories.chapters.listByProjectId(projectId);
    if (result.ok) {
      setChapters(result.value);
    }
  }, [projectId, runtime]);

  const syncHistoryAvailability = useCallback((history: EditorHistory): void => {
    setHistoryAvailability({
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
    });
  }, []);

  const resetEditorHistory = useCallback((): void => {
    const emptyHistory = createEmptyEditorHistory();
    historyRef.current = emptyHistory;
    syncHistoryAvailability(emptyHistory);
  }, [syncHistoryAvailability]);

  const scheduleSelection = useCallback(
    (selection: EditorSelection, focus: boolean, scrollTop: number | null = null): void => {
      selectionRef.current = selection;
      cursorRef.current = selection.start;
      setSelectionLength(Math.max(0, selection.end - selection.start));
      pendingSelectionRef.current = Object.freeze({ selection, focus, scrollTop });
      setSelectionRequestId((current) => current + 1);
    },
    [],
  );

  const persistEditorView = useCallback(
    (selection: EditorSelection, typographyOverride?: EditorTypography): void => {
      if (projectId === null || chapterId === null) {
        return;
      }
      saveEditorView(window.localStorage, {
        projectId,
        chapterId,
        selection,
        scrollTop: scrollTopRef.current,
        typography: typographyOverride ?? typographyRef.current,
      });
    },
    [chapterId, projectId],
  );

  const scheduleEditorViewPersistence = useCallback(
    (selection: EditorSelection): void => {
      if (viewStateTimerRef.current !== null) {
        window.clearTimeout(viewStateTimerRef.current);
      }
      viewStateTimerRef.current = window.setTimeout(() => {
        viewStateTimerRef.current = null;
        persistEditorView(selection);
      }, 180);
    },
    [persistEditorView],
  );

  const load = useCallback(async () => {
    if (chapterId === null || projectId === null) {
      setPageState("fatal_error");
      return;
    }

    setPageState("loading");
    setRecoveryDecisionOpen(false);
    setRecoveryDraft(null);
    setRecoveryCopySaved(false);
    setVersionToRestore(null);
    setVersionRestoreBusy(false);
    setCandidateReviewOpen(false);
    setCandidateDiff(null);
    setCandidateDiffDecisions({});
    setCandidateReviewError(null);
    setCandidateReviewConflict(null);
    setCandidateCopySaved(false);
    setEditorNotice(null);
    setStoryStateUpdate({ state: "idle" });
    const [
      projectResult,
      chapterResult,
      chaptersResult,
      draftResult,
      versionsResult,
      candidatesResult,
    ] = await Promise.all([
      runtime.repositories.projects.findById(projectId),
      runtime.repositories.chapters.findById(chapterId),
      runtime.repositories.chapters.listByProjectId(projectId),
      runtime.repositories.recoveryDrafts.findByChapterId(chapterId),
      runtime.useCases.listChapterVersions.execute(chapterId),
      runtime.repositories.aiCandidates.listByChapterId(chapterId),
    ]);

    if (!projectResult.ok) {
      setError(projectResult.error);
      setPageState("fatal_error");
      return;
    }
    if (!chapterResult.ok) {
      setError(chapterResult.error);
      setPageState("fatal_error");
      return;
    }
    if (!chaptersResult.ok) {
      setError(chaptersResult.error);
      setPageState("fatal_error");
      return;
    }
    if (!draftResult.ok) {
      setError(draftResult.error);
      setPageState("fatal_error");
      return;
    }
    if (!versionsResult.ok) {
      setError(versionsResult.error);
      setPageState("fatal_error");
      return;
    }
    if (!candidatesResult.ok) {
      setError(candidatesResult.error);
      setPageState("fatal_error");
      return;
    }
    if (projectResult.value === null || chapterResult.value?.projectId !== projectId) {
      setError(new Error("章节或项目不存在"));
      setPageState("fatal_error");
      return;
    }

    const loadedChapter = chapterResult.value;
    const draft = draftResult.value;
    setProject(projectResult.value);
    setChapter(loadedChapter);
    setChapters(chaptersResult.value);
    chapterRef.current = loadedChapter;
    setVersions(versionsResult.value);
    const candidateSelection = selectEditorCandidate(
      candidatesResult.value,
      requestedCandidateId,
      projectId,
      chapterId,
    );
    setCandidate(candidateSelection.candidate);

    if (draft !== null && draft.baseRevision !== loadedChapter.revision) {
      setContent(loadedChapter.content);
      contentRef.current = loadedChapter.content;
      resetEditorHistory();
      setSaveState("conflict");
      setError(new Error("恢复草稿基于旧版本，已保留稳定正文；请先导出草稿再解决冲突。"));
      setPageState("conflict");
      return;
    }

    const initialContent = loadedChapter.content;
    const loadedView = loadEditorView(
      window.localStorage,
      projectId,
      chapterId,
      initialContent.length,
    );
    const fallbackCursor = 0;
    const restoredSelection =
      loadedView.view?.selection ?? Object.freeze({ start: fallbackCursor, end: fallbackCursor });
    setContent(initialContent);
    contentRef.current = initialContent;
    typographyRef.current = loadedView.typography;
    setTypography(loadedView.typography);
    scrollTopRef.current = loadedView.view?.scrollTop ?? 0;
    scheduleSelection(restoredSelection, false, scrollTopRef.current);
    resetEditorHistory();
    setRecovered(false);
    setRecoveryDraft(draft);
    setRecoveryDecisionOpen(draft !== null);
    setSaveState("saved_local");
    setEditorNotice(candidateSelection.notice);
    setFindStatus(null);
    setError(null);
    setPageState("ready");
    const continuousState = (runtime.story as Partial<RuntimeStory>).continuousState;
    if (continuousState !== undefined) {
      void continuousState
        .inspectProject(projectId)
        .then((dashboard) => {
          if (dashboard.detectedCount > 0) {
            setStoryStateUpdate({
              state: "ready",
              detectedCount: dashboard.detectedCount,
              needsConfirmationCount: dashboard.needsConfirmationCount,
              reversibleCount: dashboard.reversibleCount,
              skippedTaskCount: 0,
            });
          }
        })
        .catch(() => {
          // Story-state review is additive and must never block opening正文.
          globalThis.console.error("[CONTINUOUS_STORY_STATE_DASHBOARD_FAILED]");
        });
    }
  }, [chapterId, projectId, requestedCandidateId, resetEditorHistory, runtime, scheduleSelection]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return clearScheduledPersistence;
  }, [clearScheduledPersistence, load]);

  useEffect(() => {
    if (pageState !== "ready") {
      return;
    }
    const editor = editorRef.current;
    const pending = pendingSelectionRef.current;
    if (editor === null || pending === null) {
      return;
    }
    const selection = normalizeEditorSelection(pending.selection, editor.value.length);
    editor.setSelectionRange(selection.start, selection.end);
    if (pending.scrollTop !== null) {
      editor.scrollTop = pending.scrollTop;
      scrollTopRef.current = editor.scrollTop;
    }
    if (pending.focus) {
      editor.focus({ preventScroll: true });
    }
    pendingSelectionRef.current = null;
  }, [pageState, selectionRequestId]);

  useEffect(() => {
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [findOpen]);

  useEffect(
    () => () => {
      if (viewStateTimerRef.current !== null) {
        window.clearTimeout(viewStateTimerRef.current);
        viewStateTimerRef.current = null;
      }
      persistEditorView(selectionRef.current);
    },
    [persistEditorView],
  );

  const enqueue = useCallback(
    (operation: () => Promise<void>): Promise<void> => operationQueueRef.current.enqueue(operation),
    [],
  );

  const persistDraft = useCallback(
    async (snapshot: string, cursorOffset: number): Promise<void> => {
      const stableChapter = chapterRef.current;
      if (stableChapter === null || snapshot === stableChapter.content) {
        return;
      }
      const result = await runtime.useCases.editChapter.execute({
        chapterId: stableChapter.id,
        expectedRevision: stableChapter.revision,
        content: snapshot,
        cursorOffset: Math.min(cursorOffset, snapshot.length),
      });
      if (!result.ok) {
        setError(result.error);
        setSaveState(result.error.code === "VERSION_CONFLICT" ? "conflict" : "save_failed");
        throw result.error;
      }
      if (contentRef.current === snapshot) {
        setSaveState("dirty");
      }
    },
    [runtime],
  );

  const commitSnapshot = useCallback(
    async (
      snapshot: string,
      cursorOffset: number,
      reason: "autosave" | "manual",
    ): Promise<void> => {
      const stableChapter = chapterRef.current;
      if (stableChapter === null) {
        return;
      }
      if (contentRef.current === snapshot) {
        setSaveState("saving");
      }

      const edited = await runtime.useCases.editChapter.execute({
        chapterId: stableChapter.id,
        expectedRevision: stableChapter.revision,
        content: snapshot,
        cursorOffset: Math.min(cursorOffset, snapshot.length),
      });
      if (!edited.ok) {
        setError(edited.error);
        setSaveState(edited.error.code === "VERSION_CONFLICT" ? "conflict" : "save_failed");
        throw edited.error;
      }

      const saved = await runtime.useCases.saveChapter.execute({
        chapterId: stableChapter.id,
        expectedRevision: stableChapter.revision,
        reason,
      });
      if (!saved.ok) {
        setError(saved.error);
        setSaveState(saved.error.code === "VERSION_CONFLICT" ? "conflict" : "save_failed");
        throw saved.error;
      }

      setChapter(saved.value.chapter);
      chapterRef.current = saved.value.chapter;
      setRecovered(false);
      setError(null);
      setSaveState(contentRef.current === snapshot ? saved.value.saveState : "dirty");
      await loadVersions();
      const continuousState = (runtime.story as Partial<RuntimeStory>).continuousState;
      if (
        shouldRunContinuousStoryStateExtraction(
          reason,
          continuousState?.isAutomaticOnManualSaveEnabled(saved.value.chapter.projectId) ?? false,
        ) &&
        saved.value.version !== null &&
        continuousState !== undefined
      ) {
        const savedVersion = saved.value.version.toSnapshot();
        setStoryStateUpdate({ state: "running" });
        void continuousState
          .extractAfterSave({
            projectId: savedVersion.projectId,
            chapterId: savedVersion.chapterId,
            versionId: savedVersion.id,
            reason,
          })
          .then((receipt: ContinuousStoryStateExtractionReceipt | null) => {
            if (receipt === null) {
              setStoryStateUpdate({ state: "idle" });
              return;
            }
            setStoryStateUpdate({
              state: "ready",
              detectedCount: receipt.detectedCount,
              needsConfirmationCount: receipt.needsConfirmationCount,
              reversibleCount: receipt.reversibleCount,
              skippedTaskCount: receipt.skippedTasks.length,
            });
          })
          .catch((cause: unknown) => {
            setStoryStateUpdate({
              state: "failed",
              message:
                cause instanceof Error
                  ? cause.message
                  : "故事状态识别暂时失败；正文和已有设定均未改变。",
            });
          });
      }
      const chapterSummaries = (runtime.story as Partial<RuntimeStory>).chapterSummaries;
      if (
        saved.value.version !== null &&
        chapterSummaries !== undefined &&
        shouldRunChapterSummaryAfterSave(
          reason,
          chapterSummaries.isAutomaticOnManualSaveEnabled(saved.value.chapter.projectId),
        )
      ) {
        const savedVersion = saved.value.version.toSnapshot();
        setChapterSummaryUpdate({ state: "running" });
        void chapterSummaries
          .summarizeSavedVersion({
            projectId: savedVersion.projectId,
            chapterId: savedVersion.chapterId,
            versionId: savedVersion.id,
            trigger: "manual_save",
          })
          .then((receipt: ChapterSummaryGenerationReceipt) => {
            setChapterSummaryUpdate({
              state: "finished",
              status: receipt.status,
              message: receipt.message,
            });
          })
          .catch((cause: unknown) => {
            setChapterSummaryUpdate({
              state: "finished",
              status: "failed",
              message:
                cause instanceof Error ? cause.message : "章节摘要暂未更新；正文保存不受影响。",
            });
          });
      }
    },
    [loadVersions, runtime],
  );

  const hasPendingPersistence = useCallback((): boolean => {
    const stableChapter = chapterRef.current;
    return (
      composingRef.current ||
      draftTimerRef.current !== null ||
      autosaveTimerRef.current !== null ||
      operationQueueRef.current.hasPendingWork() ||
      (stableChapter !== null &&
        pageState === "ready" &&
        project?.status === "active" &&
        contentRef.current !== stableChapter.content)
    );
  }, [pageState, project?.status]);

  const flushEditorPersistence = useCallback((): Promise<PersistenceFlushHandlerResult> => {
    if (flushInFlightRef.current !== null) {
      return flushInFlightRef.current;
    }

    const cycle = (async (): Promise<PersistenceFlushHandlerResult> => {
      if (composingRef.current) {
        return Object.freeze({
          status: "blocked",
          code: "COMPOSITION_ACTIVE",
          message: "请先完成当前中文输入，再离开编辑器。",
        });
      }

      clearScheduledPersistence();
      let flushed = operationQueueRef.current.hasPendingWork();
      for (;;) {
        const stableChapter = chapterRef.current;
        const snapshot = contentRef.current;
        const cursorOffset = cursorRef.current;
        if (
          stableChapter !== null &&
          pageState === "ready" &&
          project?.status === "active" &&
          snapshot !== stableChapter.content
        ) {
          flushed = true;
          await enqueue(() => persistDraft(snapshot, cursorOffset));

          if (readBooleanRef(composingRef)) {
            return Object.freeze({
              status: "blocked",
              code: "COMPOSITION_ACTIVE",
              message: "请先完成当前中文输入，再离开编辑器。",
            });
          }
          if (contentRef.current !== snapshot) {
            // The recovery write is durable, but the user continued typing
            // while it drained. Persist and commit the newer complete value.
            continue;
          }

          if (chapterRef.current?.content !== snapshot) {
            await enqueue(() => commitSnapshot(snapshot, cursorOffset, "autosave"));
          }
        } else {
          await operationQueueRef.current.drain();
        }

        if (readBooleanRef(composingRef)) {
          return Object.freeze({
            status: "blocked",
            code: "COMPOSITION_ACTIVE",
            message: "请先完成当前中文输入，再离开编辑器。",
          });
        }
        if (
          contentRef.current === snapshot &&
          (chapterRef.current === null ||
            pageState !== "ready" ||
            project?.status !== "active" ||
            chapterRef.current.content === snapshot)
        ) {
          return Object.freeze({ status: "success", flushed });
        }
        // Content or the stable revision changed while the queue was
        // draining. Persist and commit the latest complete snapshot before
        // allowing navigation or window teardown.
      }
    })();
    flushInFlightRef.current = cycle;
    void cycle
      .finally(() => {
        if (flushInFlightRef.current === cycle) {
          flushInFlightRef.current = null;
        }
      })
      .catch(() => {
        // The coordinator observes the original cycle rejection. The
        // bookkeeping continuation must not become an unhandled rejection.
      });
    return cycle;
  }, [
    clearScheduledPersistence,
    commitSnapshot,
    enqueue,
    pageState,
    persistDraft,
    project?.status,
  ]);

  useEffect(() => {
    const stableChapter = chapterRef.current;
    if (
      stableChapter === null ||
      pageState !== "ready" ||
      project?.status !== "active" ||
      isComposing ||
      (content === stableChapter.content && !recovered)
    ) {
      return;
    }

    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    const snapshot = content;
    const cursorOffset = cursorRef.current;
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      void enqueue(() => persistDraft(snapshot, cursorOffset)).catch(() => undefined);
    }, RECOVERY_DRAFT_DEBOUNCE_MS);
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      void enqueue(() => commitSnapshot(snapshot, cursorOffset, "autosave")).catch(() => undefined);
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      clearScheduledPersistence();
    };
  }, [
    clearScheduledPersistence,
    commitSnapshot,
    content,
    enqueue,
    isComposing,
    pageState,
    persistDraft,
    project?.status,
    recovered,
  ]);

  const manualSave = useCallback(async (): Promise<void> => {
    if (project?.status !== "active" || composingRef.current) {
      return;
    }
    clearScheduledPersistence();
    try {
      await enqueue(() => commitSnapshot(contentRef.current, cursorRef.current, "manual"));
    } catch {
      // commitSnapshot has already retained the actionable error and failed
      // save state. Button/key handlers must not create an unhandled promise.
    }
  }, [clearScheduledPersistence, commitSnapshot, enqueue, project?.status]);

  useEffect(() => {
    if (chapterId === null) {
      return;
    }
    return desktopPersistenceLifecycle.register(`editor:${chapterId}`, {
      hasPendingWork: hasPendingPersistence,
      flush: () => flushEditorPersistence(),
    });
  }, [chapterId, flushEditorPersistence, hasPendingPersistence]);

  const reportBackgroundFlushOutcome = useCallback((outcome: PersistenceFlushOutcome): void => {
    if (outcome.status === "blocked") {
      setEditorNotice(outcome.blockers[0]?.message ?? "请先完成当前输入，再离开编辑器。");
      return;
    }
    if (outcome.status === "failed") {
      setError(outcome.failures[0]?.cause ?? new Error("本地恢复草稿保存失败。"));
      setSaveState("save_failed");
      return;
    }
    if (outcome.status === "timeout") {
      setError(
        Object.freeze({
          code: "PERSISTENCE_FLUSH_TIMEOUT",
          message: "本地恢复草稿保存超时；窗口保持打开，请重试保存。",
        }),
      );
      setSaveState("save_failed");
    }
  }, []);

  useEffect(() => {
    const requestBackgroundFlush = (): void => {
      void desktopPersistenceLifecycle
        .flush("background", BACKGROUND_FLUSH_TIMEOUT_MS)
        .then(reportBackgroundFlushOutcome);
    };
    const handleWindowBlur = (): void => {
      requestBackgroundFlush();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        requestBackgroundFlush();
      }
    };

    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [reportBackgroundFlushOutcome]);

  const recoverPendingDraft = useCallback((): void => {
    const draft = recoveryDraft;
    if (draft === null) {
      return;
    }
    const snapshot = draft.toSnapshot();
    const selection = Object.freeze({
      start: Math.min(snapshot.cursorOffset, snapshot.content.length),
      end: Math.min(snapshot.cursorOffset, snapshot.content.length),
    });
    contentRef.current = snapshot.content;
    setContent(snapshot.content);
    setRecovered(true);
    setRecoveryDraft(null);
    setRecoveryDecisionOpen(false);
    setRecoveryCopySaved(false);
    setSaveState("dirty");
    setError(null);
    resetEditorHistory();
    scheduleSelection(selection, true);
    setEditorNotice("已载入恢复草稿；自动保存成功后会生成新的稳定版本。");
  }, [recoveryDraft, resetEditorHistory, scheduleSelection]);

  const keepStableChapter = useCallback(async (): Promise<void> => {
    const draft = recoveryDraft;
    const stableChapter = chapterRef.current;
    if (draft === null || stableChapter === null) {
      return;
    }
    setRecoveryDecisionBusy(true);
    const removed = await runtime.repositories.recoveryDrafts.delete(stableChapter.id, draft.id);
    setRecoveryDecisionBusy(false);
    if (!removed.ok) {
      setError(removed.error);
      setSaveState("save_failed");
      return;
    }
    setRecoveryDraft(null);
    setRecoveryDecisionOpen(false);
    setRecoveryCopySaved(false);
    setRecovered(false);
    setSaveState("saved_local");
    setError(null);
    setEditorNotice("已保留稳定正文，并清理这条恢复草稿。");
  }, [recoveryDraft, runtime]);

  const saveRecoveryDraftAsChapter = useCallback(async (): Promise<void> => {
    const draft = recoveryDraft;
    const stableChapter = chapterRef.current;
    if (
      draft === null ||
      stableChapter === null ||
      projectId === null ||
      project?.status !== "active" ||
      recoveryCopySaved
    ) {
      return;
    }
    setRecoveryDecisionBusy(true);
    const copyTitle = `${stableChapter.title.slice(0, 190)}（恢复副本）`;
    const created = await runtime.useCases.createChapter.execute({
      projectId,
      title: copyTitle,
      content: draft.content,
    });
    if (!created.ok) {
      setRecoveryDecisionBusy(false);
      setError(created.error);
      return;
    }
    await loadChapters();
    setRecoveryCopySaved(true);
    const removed = await runtime.repositories.recoveryDrafts.delete(stableChapter.id, draft.id);
    setRecoveryDecisionBusy(false);
    if (!removed.ok) {
      setError(removed.error);
      setEditorNotice(
        `恢复草稿已安全另存为“${copyTitle}”，但原恢复记录暂未清理；可保留稳定正文后重试清理。`,
      );
      return;
    }
    setRecoveryDraft(null);
    setRecoveryDecisionOpen(false);
    setRecovered(false);
    setSaveState("saved_local");
    setError(null);
    setEditorNotice(`恢复草稿已另存为新章节“${copyTitle}”，当前稳定正文未改变。`);
  }, [loadChapters, project?.status, projectId, recoveryCopySaved, recoveryDraft, runtime]);

  function recordEdit(edit: EditorEdit | null): void {
    if (edit === null) {
      return;
    }
    const nextHistory = recordEditorEdit(historyRef.current, edit);
    historyRef.current = nextHistory;
    syncHistoryAvailability(nextHistory);
  }

  function markEditorContentDirty(nextContent: string, selection: EditorSelection): void {
    contentRef.current = nextContent;
    selectionRef.current = selection;
    cursorRef.current = selection.start;
    setSelectionLength(Math.max(0, selection.end - selection.start));
    setContent(nextContent);
    setRecovered(false);
    setSaveState("dirty");
    scheduleEditorViewPersistence(selection);
  }

  function applyProgrammaticEdit(
    nextContent: string,
    selection: EditorSelection,
    edit: EditorEdit,
  ): void {
    recordEdit(edit);
    markEditorContentDirty(nextContent, selection);
    scheduleSelection(selection, true);
  }

  function applyHistory(direction: "undo" | "redo"): void {
    if (project?.status !== "active" || composingRef.current) {
      return;
    }
    const history = historyRef.current;
    const result =
      direction === "undo"
        ? undoEditorEdit(history, contentRef.current)
        : redoEditorEdit(history, contentRef.current);
    if (result === null) {
      if (history.past.length > 0 || history.future.length > 0) {
        resetEditorHistory();
        setEditorNotice("编辑历史与当前正文不一致，已安全清空；正文没有被改动。");
      }
      return;
    }
    historyRef.current = result.history;
    syncHistoryAvailability(result.history);
    markEditorContentDirty(result.content, result.selection);
    scheduleSelection(result.selection, true);
    setEditorNotice(direction === "undo" ? "已撤销本次会话中的一步编辑。" : "已重做一步编辑。");
  }

  function openFind(): void {
    const selection = normalizeEditorSelection(selectionRef.current, contentRef.current.length);
    const selectedText = contentRef.current.slice(selection.start, selection.end);
    if (selectedText.length > 0 && selectedText.length <= EDITOR_FIND_QUERY_LIMIT) {
      setFindQuery(selectedText);
    }
    setFindStatus(null);
    setFindOpen(true);
  }

  function navigateFind(direction: "next" | "previous"): void {
    if (findQuery.length === 0) {
      setFindStatus("请输入要查找的文字。");
      return;
    }
    const selection = normalizeEditorSelection(selectionRef.current, contentRef.current.length);
    const selectedText = contentRef.current.slice(selection.start, selection.end);
    const fromOffset =
      direction === "next" && selectedText === findQuery ? selection.end : selection.start;
    const match = findLiteral(contentRef.current, findQuery, fromOffset, direction);
    if (match === null) {
      setFindStatus("当前章节没有匹配文字。");
      return;
    }
    const matchSelection = Object.freeze({ start: match.start, end: match.end });
    scheduleSelection(matchSelection, true);
    scheduleEditorViewPersistence(matchSelection);
    setFindStatus(
      `${direction === "next" ? "下一处" : "上一处"}匹配已选中${
        match.wrapped ? "（已从章节另一端继续）" : ""
      }。`,
    );
  }

  function replaceCurrentMatch(): void {
    if (project?.status !== "active" || composingRef.current) {
      return;
    }
    const selection = normalizeEditorSelection(selectionRef.current, contentRef.current.length);
    if (contentRef.current.slice(selection.start, selection.end) !== findQuery) {
      navigateFind("next");
      setFindStatus("已定位到一处匹配；再次点击可替换当前选中内容。");
      return;
    }
    const replacement = createEditorRangeEdit(contentRef.current, selection, replacementText);
    if (replacement === null) {
      setFindStatus("替换后的章节将超过 500 万字符，未执行替换。");
      return;
    }
    applyProgrammaticEdit(replacement.content, replacement.edit.selectionAfter, replacement.edit);
    setFindStatus("已替换当前匹配；可继续查找下一处。");
  }

  function replaceEveryMatch(): void {
    if (project?.status !== "active" || composingRef.current) {
      return;
    }
    const before = contentRef.current;
    const selectionBefore = normalizeEditorSelection(selectionRef.current, before.length);
    const result = replaceAllLiteral(before, findQuery, replacementText);
    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        EMPTY_QUERY: "请输入要替换的文字。",
        QUERY_TOO_LARGE: "查找文字过长，未执行替换。",
        REPLACEMENT_TOO_LARGE: "替换文字过长，未执行替换。",
        TOO_MANY_MATCHES: "匹配超过 10,000 处；请缩小范围后再替换。",
        CONTENT_TOO_LARGE: "替换后的章节将超过 500 万字符，未执行替换。",
      };
      setFindStatus(messages[result.reason]);
      return;
    }
    if (result.replacements === 0) {
      setFindStatus("当前章节没有匹配文字。");
      return;
    }
    const edit = createEditorEditFromTransition(
      before,
      result.content,
      selectionBefore,
      result.selection,
    );
    if (edit === null) {
      return;
    }
    applyProgrammaticEdit(result.content, result.selection, edit);
    setFindStatus(`已按字面量替换 ${String(result.replacements)} 处。`);
  }

  function updateTypography(next: EditorTypography): void {
    typographyRef.current = next;
    setTypography(next);
    saveEditorTypography(window.localStorage, next);
    persistEditorView(selectionRef.current, next);
  }

  function handleEditorBeforeInput(
    event: ReactSyntheticEvent<HTMLTextAreaElement, InputEvent>,
  ): void {
    selectionRef.current = normalizeEditorSelection(
      {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      },
      event.currentTarget.value.length,
    );
    nativeInputTypeRef.current = event.nativeEvent.inputType || null;
  }

  function handleEditorChange(event: ReactChangeEvent<HTMLTextAreaElement>): void {
    const before = contentRef.current;
    const after = event.currentTarget.value;
    const selectionAfter = normalizeEditorSelection(
      {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      },
      after.length,
    );
    if (!composingRef.current) {
      const inputType = nativeInputTypeRef.current;
      const edit =
        inputType !== null && selectionDerivedInputTypes.has(inputType)
          ? createEditorEditFromSelectionTransition(
              before,
              after,
              selectionRef.current,
              selectionAfter,
            )
          : createEditorEditFromTransition(before, after, selectionRef.current, selectionAfter);
      recordEdit(edit);
    }
    nativeInputTypeRef.current = null;
    markEditorContentDirty(after, selectionAfter);
  }

  function handleCompositionStart(event: ReactCompositionEvent<HTMLTextAreaElement>): void {
    const selection = normalizeEditorSelection(
      {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      },
      event.currentTarget.value.length,
    );
    compositionBaseRef.current = Object.freeze({
      content: contentRef.current,
      selection,
    });
    composingRef.current = true;
    setIsComposing(true);
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
    }
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
  }

  function handleCompositionEnd(event: ReactCompositionEvent<HTMLTextAreaElement>): void {
    const finalContent = event.currentTarget.value;
    const selectionAfter = normalizeEditorSelection(
      {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      },
      finalContent.length,
    );
    const base = compositionBaseRef.current;
    if (base !== null) {
      recordEdit(
        createEditorEditFromTransition(base.content, finalContent, base.selection, selectionAfter),
      );
    }
    compositionBaseRef.current = null;
    contentRef.current = finalContent;
    selectionRef.current = selectionAfter;
    cursorRef.current = selectionAfter.start;
    setSelectionLength(Math.max(0, selectionAfter.end - selectionAfter.start));
    setContent(finalContent);
    setRecovered(false);
    setSaveState("dirty");
    composingRef.current = false;
    setIsComposing(false);
    persistEditorView(selectionAfter);
  }

  function handleEditorPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    if (project?.status !== "active") {
      return;
    }
    event.preventDefault();
    const clipboardText = event.clipboardData.getData("text/plain");
    const sanitized = sanitizePlainTextPaste(clipboardText);
    const selection = normalizeEditorSelection(
      {
        start: event.currentTarget.selectionStart,
        end: event.currentTarget.selectionEnd,
      },
      contentRef.current.length,
    );
    const replacement = createEditorRangeEdit(contentRef.current, selection, sanitized);
    if (replacement === null) {
      setEditorNotice("粘贴后的章节将超过 500 万字符，未写入任何内容。");
      return;
    }
    applyProgrammaticEdit(replacement.content, replacement.edit.selectionAfter, replacement.edit);
    setEditorNotice(
      clipboardText === sanitized
        ? "已按纯文本粘贴。"
        : "已按纯文本粘贴，并移除不可见的危险控制字符。",
    );
  }

  function handleEditorKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing || composingRef.current) {
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLocaleLowerCase();
    if (modifier && key === "s") {
      event.preventDefault();
      void manualSave();
      return;
    }
    if (modifier && key === "f") {
      event.preventDefault();
      openFind();
      return;
    }
    if (event.key === "F3") {
      event.preventDefault();
      navigateFind(event.shiftKey ? "previous" : "next");
      return;
    }
    if (modifier && key === "z") {
      event.preventDefault();
      applyHistory(event.shiftKey ? "redo" : "undo");
      return;
    }
    if (modifier && key === "y") {
      event.preventDefault();
      applyHistory("redo");
      return;
    }
    if (event.key === "Escape" && findOpen) {
      event.preventDefault();
      setFindOpen(false);
      setFindStatus(null);
    }
  }

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setFindOpen(false);
      setFindStatus(null);
      editorRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Enter" || event.key === "F3") {
      event.preventDefault();
      navigateFind(event.shiftKey ? "previous" : "next");
    }
  }

  async function generateCandidate(): Promise<void> {
    if (chapterId === null || saveState === "dirty" || saveState === "saving") {
      return;
    }
    setCandidateBusy(true);
    setError(null);
    setGenerationReceipt(null);
    setGenerationAttemptUsage([]);
    try {
      const plan = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: editorClean,
        networkAvailable: online,
      });
      setGenerationPlan(plan);
      setDeferredGeneration(plan.deferredRequest);
      await loadBudgetForm(plan);
      setPreflightOpen(true);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setCandidateBusy(false);
    }
  }

  async function loadBudgetForm(plan: PreparedGenerationPlan): Promise<void> {
    const estimate = plan.preflight.estimate;
    if (plan.projectId === null || estimate === null) {
      setBudgetPolicies([]);
      setProjectBudgetAmount("");
      setMonthBudgetAmount("");
      return;
    }
    const monthKey = plan.preflight.checkedAt.slice(0, 7);
    const policies = await runtime.generationGovernance.listBudgetPolicies(
      plan.projectId,
      monthKey,
      estimate.currency,
    );
    setBudgetPolicies(policies);
    const projectPolicy = policies.find(({ scope }) => scope === "project");
    const monthPolicy = policies.find(({ scope }) => scope === "month");
    setProjectBudgetAmount(
      projectPolicy === undefined ? "" : formatMicrosAmount(projectPolicy.limitMicros),
    );
    setMonthBudgetAmount(
      monthPolicy === undefined ? "" : formatMicrosAmount(monthPolicy.limitMicros),
    );
    setProjectBudgetEnforcement(projectPolicy?.enforcement ?? "hard");
    setMonthBudgetEnforcement(monthPolicy?.enforcement ?? "warn");
  }

  async function saveBudgetsAndRefresh(): Promise<void> {
    if (
      !generationPlan?.projectId ||
      generationPlan.preflight.estimate === null ||
      chapterId === null
    ) {
      return;
    }
    setBudgetSaving(true);
    setError(null);
    try {
      const currency = generationPlan.preflight.estimate.currency;
      const monthKey = generationPlan.preflight.checkedAt.slice(0, 7);
      const projectPolicy = budgetPolicies.find(({ scope }) => scope === "project");
      const monthPolicy = budgetPolicies.find(({ scope }) => scope === "month");
      const writes: Promise<GenerationBudgetPolicy>[] = [];
      if (projectBudgetAmount.trim().length > 0) {
        writes.push(
          runtime.generationGovernance.saveBudgetPolicy({
            scope: "project",
            projectId: generationPlan.projectId,
            monthKey: null,
            currency,
            limitMicros: parseAmountToMicros(projectBudgetAmount),
            enforcement: projectBudgetEnforcement,
            expectedRevision: projectPolicy?.revision ?? null,
          }),
        );
      }
      if (monthBudgetAmount.trim().length > 0) {
        writes.push(
          runtime.generationGovernance.saveBudgetPolicy({
            scope: "month",
            projectId: null,
            monthKey,
            currency,
            limitMicros: parseAmountToMicros(monthBudgetAmount),
            enforcement: monthBudgetEnforcement,
            expectedRevision: monthPolicy?.revision ?? null,
          }),
        );
      }
      await Promise.all(writes);
      const refreshed = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: editorClean,
        networkAvailable: online,
      });
      setGenerationPlan(refreshed);
      await loadBudgetForm(refreshed);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBudgetSaving(false);
    }
  }

  async function confirmGeneration(): Promise<void> {
    if (!generationPlan?.preflight.canStart) {
      return;
    }
    setPreflightOpen(false);
    setCandidateBusy(true);
    setGenerationPreview("");
    setError(null);
    activeGenerationPlanRef.current = generationPlan;
    try {
      const result = await executeGenerationPlan(runtime, generationPlan, setGenerationPreview);
      if (generationPlan.deferredRequest !== null) {
        setDeferredGeneration(
          await runtime.generationGovernance.findWaitingDeferredRequest(
            generationPlan.chapterId,
            generationPlan.modelRole,
          ),
        );
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const previousCandidate = candidate;
      if (result.value.candidate !== null) {
        setCandidate(result.value.candidate);
      }
      setCandidateQualityGate(result.value.qualityGate);
      if (
        projectId !== null &&
        chapterId !== null &&
        result.value.candidate !== null &&
        previousCandidate !== null &&
        (previousCandidate.status === "accepted" || previousCandidate.status === "rejected")
      ) {
        await recordWritingFeedbackSafely({
          action: "regenerated",
          candidateId: previousCandidate.id,
        });
      }
      const [receipt, usage] = await Promise.all([
        runtime.generationGovernance.findRunById(result.value.runId),
        runtime.generationGovernance.listAttemptUsage(result.value.runId),
      ]);
      setGenerationReceipt(receipt);
      setGenerationAttemptUsage(usage);
      setError(null);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      activeGenerationPlanRef.current = null;
      setCandidateBusy(false);
      setCancelBusy(false);
      setGenerationPreview("");
    }
  }

  async function deferGenerationUntilOnline(): Promise<void> {
    if (generationPlan === null || !canDeferGenerationPlan(generationPlan)) {
      return;
    }
    setCandidateBusy(true);
    setError(null);
    try {
      const deferred = await saveDeferredGenerationPlan(runtime, generationPlan);
      setDeferredGeneration(deferred);
      setGenerationPlan(Object.freeze({ ...generationPlan, deferredRequest: deferred }));
      setPreflightOpen(false);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setCandidateBusy(false);
    }
  }

  async function cancelActiveGeneration(): Promise<void> {
    const activePlan = activeGenerationPlanRef.current;
    if (activePlan === null || cancelBusy) {
      return;
    }
    setCancelBusy(true);
    try {
      await cancelGenerationPlan(runtime, activePlan);
    } catch (cause: unknown) {
      setError(cause);
      setCancelBusy(false);
    }
  }

  function openCandidateReview(): void {
    if (candidate?.status !== "ready" || chapter === null) {
      return;
    }
    const baseVersionId = candidate.baseVersionId;
    const baseVersion =
      baseVersionId === null ? undefined : versions.find((version) => version.id === baseVersionId);
    setCandidateReviewSelection(
      normalizeEditorSelection(selectionRef.current, contentRef.current.length),
    );
    setCandidateDiffDecisions({});
    setCandidateReviewError(null);
    setCandidateReviewConflict(null);
    setCandidateCopySaved(false);
    setCandidateDiff(null);
    if (baseVersion === undefined) {
      setCandidateReviewError(
        "AI 建议所依据的稳定版本已经不可用；为避免覆盖正文，当前不能接受这份建议。",
      );
      setCandidateReviewOpen(true);
      return;
    }
    const baseline = baseVersion.toSnapshot();
    const diff = diffCandidateContent(baseline.content, candidate.content);
    if (diff.status === "error") {
      setCandidateReviewError(
        `逐项比较超出安全边界（${diff.error.code}）；仍可选择插入、替换选区或覆盖全文。`,
      );
    } else {
      setCandidateDiff(diff.diff);
    }
    if (
      baseline.id !== chapter.currentVersionId ||
      baseline.sequence !== chapter.revision ||
      baseline.content !== chapter.content
    ) {
      setCandidateReviewConflict({
        baselineContent: baseline.content,
        currentContent: chapter.content,
      });
    }
    setCandidateReviewOpen(true);
  }

  async function acceptCandidate(strategy: CandidateApplicationStrategy): Promise<void> {
    if (candidate?.status !== "ready" || saveState === "dirty" || saveState === "saving") {
      return;
    }
    setCandidateBusy(true);
    const result = await runtime.useCases.acceptCandidate.execute({
      candidateId: candidate.id,
      strategy,
    });
    setCandidateBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCandidate(result.value.candidate);
    setChapter(result.value.chapter);
    chapterRef.current = result.value.chapter;
    const nextContent = result.value.chapter.content;
    const selectionBefore = normalizeEditorSelection(
      selectionRef.current,
      contentRef.current.length,
    );
    const selectionAfter = normalizeEditorSelection(selectionBefore, nextContent.length);
    recordEdit(
      createEditorEditFromTransition(
        contentRef.current,
        nextContent,
        selectionBefore,
        selectionAfter,
      ),
    );
    setContent(nextContent);
    contentRef.current = nextContent;
    scheduleSelection(selectionAfter, true);
    persistEditorView(selectionAfter);
    setSaveState(result.value.saveState);
    setCandidateReviewOpen(false);
    setCandidateDiff(null);
    setCandidateDiffDecisions({});
    setCandidateReviewError(null);
    setCandidateReviewConflict(null);
    setCandidateCopySaved(false);
    setError(null);
    const acceptedChangeCount =
      strategy.kind === "apply_changes"
        ? strategy.decisions.filter(({ decision }) => decision === "accept").length
        : null;
    const rejectedChangeCount =
      strategy.kind === "apply_changes"
        ? strategy.decisions.filter(({ decision }) => decision === "reject").length
        : null;
    await recordWritingFeedbackSafely({
      action:
        strategy.kind === "apply_changes" && (rejectedChangeCount ?? 0) > 0
          ? "partially_accepted"
          : "accepted",
      candidateId: result.value.candidate.id,
      applicationStrategy: strategy.kind,
      acceptedChangeCount,
      rejectedChangeCount,
    });
    setEditorNotice(
      strategy.kind === "apply_changes"
        ? "已按逐项决定创建新的稳定版本；可在本次会话撤销，原稳定版本仍保留在版本历史。"
        : "AI 建议已按所选方式写入新的稳定版本；原稳定版本仍保留在版本历史。",
    );
    await loadVersions();
  }

  async function saveCandidateAsChapterCopy(): Promise<void> {
    if (
      candidate?.status !== "ready" ||
      chapter === null ||
      projectId === null ||
      project?.status !== "active" ||
      candidateCopySaved
    ) {
      return;
    }
    setCandidateBusy(true);
    const copyTitle = `${chapter.title.slice(0, 190)}（AI 建议副本）`;
    const created = await runtime.useCases.createChapter.execute({
      projectId,
      title: copyTitle,
      content: candidate.content,
    });
    setCandidateBusy(false);
    if (!created.ok) {
      setError(created.error);
      return;
    }
    await loadChapters();
    setCandidateCopySaved(true);
    setError(null);
    setEditorNotice(`AI 建议已另存为新章节“${copyTitle}”，当前稳定正文和建议记录均未改变。`);
  }

  async function restoreSelectedVersion(): Promise<void> {
    const selected = versionToRestore;
    const stableChapter = chapterRef.current;
    if (
      selected === null ||
      stableChapter === null ||
      project?.status !== "active" ||
      !editorClean ||
      selected.toSnapshot().content === stableChapter.content
    ) {
      return;
    }
    setVersionRestoreBusy(true);
    setError(null);
    try {
      const result = await runtime.useCases.restoreChapterVersion.execute({
        chapterId: stableChapter.id,
        versionId: selected.id,
        expectedRevision: stableChapter.revision,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const previousContent = contentRef.current;
      const nextContent = result.value.chapter.content;
      const selectionBefore = normalizeEditorSelection(
        selectionRef.current,
        previousContent.length,
      );
      const selectionAfter = normalizeEditorSelection(selectionBefore, nextContent.length);
      recordEdit(
        createEditorEditFromTransition(
          previousContent,
          nextContent,
          selectionBefore,
          selectionAfter,
        ),
      );
      setChapter(result.value.chapter);
      chapterRef.current = result.value.chapter;
      setContent(nextContent);
      contentRef.current = nextContent;
      setRecovered(false);
      setSaveState(result.value.saveState);
      scheduleSelection(selectionAfter, true);
      persistEditorView(selectionAfter);
      setVersionToRestore(null);
      setEditorNotice(
        `已从版本 ${String(selected.toSnapshot().sequence)} 创建新的恢复版本；所有历史版本仍保留。`,
      );
      await recordWritingFeedbackSafely({ action: "restored_original", candidateId: null });
      await loadVersions();
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setVersionRestoreBusy(false);
    }
  }

  async function rejectCandidate(): Promise<void> {
    if (candidate?.status !== "ready") {
      return;
    }
    setCandidateBusy(true);
    const result = await runtime.useCases.rejectCandidate.execute({
      candidateId: candidate.id,
    });
    setCandidateBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCandidate(result.value);
    setCandidateCopySaved(false);
    setError(null);
    await recordWritingFeedbackSafely({
      action: "rejected",
      candidateId: result.value.id,
    });
  }

  async function recordWritingFeedbackSafely(input: {
    readonly action:
      "accepted" | "rejected" | "regenerated" | "partially_accepted" | "restored_original";
    readonly candidateId: string | null;
    readonly applicationStrategy?:
      | "accept_all"
      | "apply_changes"
      | "insert_at_cursor"
      | "replace_selection"
      | "overwrite_document"
      | null;
    readonly acceptedChangeCount?: number | null;
    readonly rejectedChangeCount?: number | null;
  }): Promise<void> {
    if (projectId === null || chapterId === null) return;
    try {
      await runtime.story.writingFeedback.recordAction({
        projectId,
        chapterId,
        candidateId: input.candidateId,
        action: input.action,
        applicationStrategy: input.applicationStrategy ?? null,
        acceptedChangeCount: input.acceptedChangeCount ?? null,
        rejectedChangeCount: input.rejectedChangeCount ?? null,
      });
    } catch {
      // Feedback learning is additive. A ledger failure must never undo an
      // already completed, user-authorized正文 operation.
      globalThis.console.error("[WRITING_FEEDBACK_RECORD_FAILED]");
    }
  }

  const normalizedError = error === null ? null : normalizeUiError(error);
  const readonly = project?.status !== "active";
  const candidateReady = candidate?.status === "ready";
  const canGenerateCandidate =
    candidate === null || candidate.status === "accepted" || candidate.status === "rejected";
  const usesNativeModel = runtime.mode === "tauri";
  const recoveryDraftSnapshot = recoveryDraft?.toSnapshot() ?? null;
  const candidateSelectedDecisions =
    candidateDiff?.changes.flatMap((change) => {
      const decision = candidateDiffDecisions[change.id];
      return decision === undefined ? [] : [{ changeId: change.id, decision }];
    }) ?? [];
  const candidatePartialDecisionComplete =
    candidateDiff !== null &&
    candidateDiff.changes.length > 0 &&
    candidateSelectedDecisions.length === candidateDiff.changes.length &&
    candidateSelectedDecisions.some(({ decision }) => decision === "accept");
  const editorClean =
    saveState === "saved_local" || saveState === "clean" || saveState === "pending_sync";
  const writingCanvasStyle = {
    "--editor-font-size": `${String(typography.fontSize)}px`,
    "--editor-line-height": String(typography.lineHeight),
  } as CSSProperties;
  const primaryAction = (() => {
    if (readonly) {
      return {
        label: "查看版本历史",
        disabled: false,
        run: () => setVersionsOpen(true),
      };
    }
    if (!editorClean) {
      return {
        label: saveState === "saving" ? "正在保存" : "保存正文",
        disabled: saveState === "saving",
        run: () => void manualSave(),
      };
    }
    if (candidateReady) {
      return {
        label: selectionLength > 0 ? "用 AI 建议修改选中内容" : "查看 AI 建议版本",
        disabled: candidateBusy,
        run: () => {
          setAssistantOpen(true);
          openCandidateReview();
        },
      };
    }
    return {
      label: content.trim().length === 0 ? "生成开头" : "继续创作",
      disabled: candidateBusy || !canGenerateCandidate,
      run: () => {
        setAssistantOpen(true);
        void generateCandidate();
      },
    };
  })();

  return (
    <PageStateBoundary
      state={pageState}
      preserveContent={false}
      fallbacks={{
        fatal_error:
          normalizedError === null ? undefined : (
            <ErrorState
              title={normalizedError.title}
              description={normalizedError.description}
              errorCode={normalizedError.code}
              primaryAction={{ label: "重新加载", onClick: () => void load() }}
            />
          ),
        conflict:
          normalizedError === null ? undefined : (
            <ErrorState
              title="恢复草稿需要处理"
              description={normalizedError.description}
              errorCode="BASE_VERSION_CHANGED"
              savedState="稳定正文未被覆盖"
              primaryAction={{ label: "返回章节列表", onClick: () => history.back() }}
            />
          ),
      }}
    >
      <div className="editor-page">
        <header className="editor-toolbar">
          <div className="editor-toolbar__title">
            <Link className="back-link" to={`/projects/${projectId ?? ""}`}>
              返回章节
            </Link>
            <h1>{chapter?.title ?? "写作编辑器"}</h1>
          </div>
          <div className="editor-toolbar__actions">
            <SaveStatus
              state={readonly ? "readonly" : saveState}
              {...(readonly || saveState === "saving"
                ? {}
                : { onActivate: () => void manualSave() })}
            />
            <Button variant="secondary" onClick={() => setVersionsOpen(true)}>
              版本历史
            </Button>
            <Button
              variant={candidateReady ? "ai-primary" : "primary"}
              disabled={primaryAction.disabled}
              loading={candidateBusy || saveState === "saving"}
              onClick={primaryAction.run}
            >
              {primaryAction.label}
            </Button>
          </div>
        </header>

        {!online && (
          <InlineAlert
            tone="info"
            title="当前离线"
            description={
              usesNativeModel
                ? "正文、恢复草稿和版本仍会保存到当前设备；联网 AI 服务可能不可用，本机 AI 服务仍可尝试。"
                : "正文、恢复草稿和版本仍会保存到当前设备；本机示例建议不需要联网。"
            }
          />
        )}
        {deferredGeneration !== null && deferredGeneration.status === "waiting_network" && (
          <InlineAlert
            tone={online ? "info" : "warning"}
            title="联网 AI 任务已保存待执行"
            description={`仅保存章节、版本、AI 分工和费用上界，不保存正文或创作指令。${
              online
                ? "网络已恢复；再次打开生成前检查并确认后才会执行。"
                : "可继续本地编辑，任务会留在任务中心。"
            }`}
          />
        )}
        {readonly && (
          <InlineAlert
            tone="info"
            title="只读模式"
            description="项目已归档或位于回收站，正文保持可读但不会写入。"
          />
        )}
        {recovered && (
          <InlineAlert
            tone="warning"
            title="已恢复未提交草稿"
            description="草稿来自真实本地恢复记录；自动保存完成后会生成稳定版本。"
          />
        )}
        {normalizedError !== null && pageState === "ready" && (
          <InlineAlert
            tone="error"
            title={normalizedError.title}
            description={`${normalizedError.description}（${normalizedError.code}）`}
          />
        )}
        {editorNotice !== null && (
          <InlineAlert
            tone="info"
            title="编辑器提示"
            description={editorNotice}
            onDismiss={() => setEditorNotice(null)}
          />
        )}

        <details>
          <summary>写作工具与排版</summary>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "var(--space-2)",
              margin: "var(--space-2) 0",
            }}
          >
            <Button
              variant="secondary"
              disabled={readonly || !historyAvailability.canUndo}
              onClick={() => applyHistory("undo")}
            >
              撤销
            </Button>
            <Button
              variant="secondary"
              disabled={readonly || !historyAvailability.canRedo}
              onClick={() => applyHistory("redo")}
            >
              重做
            </Button>
            <Button variant="secondary" onClick={openFind}>
              查找替换
            </Button>
          </div>
          <section className="editor-format-toolbar" aria-label="阅读排版">
            <Select
              aria-label="正文字体"
              value={typography.fontFamily}
              options={[
                { value: "serif", label: "衬线字体" },
                { value: "sans", label: "无衬线字体" },
                { value: "mono", label: "等宽字体" },
              ]}
              onChange={(event) =>
                updateTypography({
                  ...typography,
                  fontFamily: event.currentTarget.value as EditorFontFamily,
                })
              }
            />
            <Select
              aria-label="正文字号"
              value={String(typography.fontSize)}
              options={[
                { value: "16", label: "16 px" },
                { value: "17", label: "17 px" },
                { value: "18", label: "18 px" },
                { value: "20", label: "20 px" },
                { value: "22", label: "22 px" },
              ]}
              onChange={(event) =>
                updateTypography({
                  ...typography,
                  fontSize: Number(event.currentTarget.value),
                })
              }
            />
            <Select
              aria-label="正文行距"
              value={String(typography.lineHeight)}
              options={[
                { value: "1.6", label: "紧凑行距" },
                { value: "1.8", label: "标准行距" },
                { value: "1.95", label: "舒展行距" },
                { value: "2.2", label: "宽松行距" },
              ]}
              onChange={(event) =>
                updateTypography({
                  ...typography,
                  lineHeight: Number(event.currentTarget.value),
                })
              }
            />
            <Select
              aria-label="正文版心"
              value={typography.measure}
              options={[
                { value: "narrow", label: "窄版心" },
                { value: "comfortable", label: "标准版心" },
                { value: "wide", label: "宽版心" },
              ]}
              onChange={(event) =>
                updateTypography({
                  ...typography,
                  measure: event.currentTarget.value as EditorMeasure,
                })
              }
            />
            <span>视图偏好仅保存在本机，不包含正文。</span>
          </section>
        </details>

        {findOpen && (
          <section className="editor-find-bar" aria-label="查找和替换">
            <Input
              ref={findInputRef}
              type="search"
              aria-label="查找文字"
              value={findQuery}
              maxLength={EDITOR_FIND_QUERY_LIMIT}
              placeholder="按字面量查找"
              onChange={(event) => {
                setFindQuery(event.currentTarget.value);
                setFindStatus(null);
              }}
              onKeyDown={handleFindKeyDown}
            />
            <Input
              aria-label="替换为"
              value={replacementText}
              maxLength={EDITOR_REPLACEMENT_LIMIT}
              placeholder="替换为（可留空）"
              onChange={(event) => {
                setReplacementText(event.currentTarget.value);
                setFindStatus(null);
              }}
              onKeyDown={handleFindKeyDown}
            />
            <div className="editor-find-bar__actions">
              <Button variant="secondary" onClick={() => navigateFind("previous")}>
                上一处
              </Button>
              <Button variant="secondary" onClick={() => navigateFind("next")}>
                下一处
              </Button>
              <Button
                variant="secondary"
                disabled={readonly || findQuery.length === 0}
                onClick={replaceCurrentMatch}
              >
                替换当前
              </Button>
              <Button
                variant="secondary"
                disabled={readonly || findQuery.length === 0}
                onClick={replaceEveryMatch}
              >
                全部替换
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setFindOpen(false);
                  setFindStatus(null);
                  editorRef.current?.focus({ preventScroll: true });
                }}
              >
                关闭查找
              </Button>
            </div>
            {findStatus !== null && <p role="status">{findStatus}</p>}
          </section>
        )}

        <div
          className="editor-workspace"
          style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch" }}
        >
          {chapterListOpen ? (
            <aside
              className="candidate-panel"
              style={chapterListPanelStyle}
              aria-labelledby="chapter-list-title"
            >
              <div className="candidate-panel__header">
                <div>
                  <p className="page-heading__eyebrow">正文</p>
                  <h2 id="chapter-list-title">章节</h2>
                </div>
                <Button
                  variant="ghost"
                  aria-label="收起章节列表"
                  aria-expanded={chapterListOpen}
                  onClick={() => setChapterListOpen(false)}
                >
                  收起
                </Button>
              </div>
              <nav aria-label="章节列表">
                <ol
                  style={{
                    display: "grid",
                    gap: "var(--space-2)",
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                  }}
                >
                  {chapters.map((item, index) => (
                    <li key={item.id}>
                      <Link
                        className="back-link"
                        aria-current={item.id === chapterId ? "page" : undefined}
                        to={`/projects/${projectId ?? ""}/chapters/${item.id}`}
                      >
                        {String(index + 1).padStart(2, "0")} · {item.title}
                      </Link>
                    </li>
                  ))}
                </ol>
              </nav>
            </aside>
          ) : (
            <aside className="candidate-panel" style={collapsedPanelStyle} aria-label="章节列表">
              <Button
                variant="secondary"
                aria-label="展开章节列表"
                aria-expanded={chapterListOpen}
                onClick={() => setChapterListOpen(true)}
              >
                章节
              </Button>
            </aside>
          )}

          <section
            className={`writing-canvas writing-canvas--${typography.measure}`}
            data-surface="light"
            data-font-family={typography.fontFamily}
            style={{ ...writingCanvasStyle, ...writingCanvasFlexStyle }}
            aria-label="章节正文"
          >
            <Textarea
              ref={editorRef}
              className="writing-textarea"
              aria-label="章节正文"
              value={content}
              readOnly={readonly}
              maxLength={5_000_000}
              onBeforeInput={handleEditorBeforeInput}
              onKeyDown={handleEditorKeyDown}
              onPaste={handleEditorPaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onSelect={(event) => {
                const selection = normalizeEditorSelection(
                  {
                    start: event.currentTarget.selectionStart,
                    end: event.currentTarget.selectionEnd,
                  },
                  event.currentTarget.value.length,
                );
                selectionRef.current = selection;
                cursorRef.current = selection.start;
                setSelectionLength(Math.max(0, selection.end - selection.start));
                scheduleEditorViewPersistence(selection);
              }}
              onScroll={(event) => {
                scrollTopRef.current = event.currentTarget.scrollTop;
                scheduleEditorViewPersistence(selectionRef.current);
              }}
              onChange={handleEditorChange}
            />
          </section>

          {assistantOpen ? (
            <aside
              className="candidate-panel"
              style={assistantPanelStyle}
              aria-labelledby="candidate-title"
            >
              <div className="candidate-panel__header">
                <div>
                  <p className="page-heading__eyebrow">陪伴创作</p>
                  <h2 id="candidate-title">AI 创作助手</h2>
                </div>
                <Button
                  variant="ghost"
                  aria-label="收起 AI 创作助手"
                  aria-expanded={assistantOpen}
                  onClick={() => setAssistantOpen(false)}
                >
                  收起
                </Button>
              </div>
              <InlineAlert
                tone="ai-clarification"
                title="正文始终由你决定"
                description={
                  usesNativeModel
                    ? "生成内容会先成为 AI 建议版本；只有你比较并接受后，才会创建新的正文版本。"
                    : "当前使用本机示例帮助检查流程，不会联网；只有你接受后，内容才会进入正文。"
                }
              />

              {storyStateUpdate.state === "running" && (
                <InlineAlert
                  tone="info"
                  title="正在整理本章变化"
                  description="正文已安全保存。墨影正在后台查找人物、世界、伏笔和剧情线变化；不会自动写成正式设定。"
                />
              )}
              {storyStateUpdate.state === "ready" && (
                <InlineAlert
                  tone={storyStateUpdate.needsConfirmationCount > 0 ? "warning" : "info"}
                  title={`识别到 ${String(storyStateUpdate.detectedCount)} 项变化，其中 ${String(storyStateUpdate.needsConfirmationCount)} 项需要确认`}
                  description={
                    storyStateUpdate.skippedTaskCount > 0
                      ? "部分识别因没有可用的 AI 分工而跳过，没有使用假数据。可先继续写作，或连接模型后再次保存新版本。"
                      : `另有 ${String(storyStateUpdate.reversibleCount)} 项属于可撤销的普通更新。所有变化都保留原文章节、版本和精确引文。`
                  }
                />
              )}
              {storyStateUpdate.state === "ready" && storyStateUpdate.detectedCount > 0 && (
                <Link className="back-link" to={`/projects/${projectId ?? ""}/story`}>
                  查看并处理本章变化
                </Link>
              )}
              {storyStateUpdate.state === "failed" && (
                <InlineAlert
                  tone="warning"
                  title="本章变化暂未整理"
                  description={`${storyStateUpdate.message} 你可以继续写作，正文保存不受影响。`}
                />
              )}
              {chapterSummaryUpdate.state === "running" && (
                <InlineAlert
                  tone="info"
                  title="正在更新章节摘要"
                  description="正文已经安全保存。本次仅因你启用了“手动保存后更新摘要”而调用一次长程记忆压缩；自动保存不会调用模型。"
                />
              )}
              {chapterSummaryUpdate.state === "finished" && (
                <InlineAlert
                  tone={
                    chapterSummaryUpdate.status === "generated" ||
                    chapterSummaryUpdate.status === "already_current"
                      ? "info"
                      : "warning"
                  }
                  title={
                    chapterSummaryUpdate.status === "generated"
                      ? "章节摘要已更新"
                      : chapterSummaryUpdate.status === "already_current"
                        ? "章节摘要已是最新"
                        : chapterSummaryUpdate.status === "skipped"
                          ? "本次未生成章节摘要"
                          : "章节摘要更新失败"
                  }
                  description={`${chapterSummaryUpdate.message} 正文和正式设定均未被修改。`}
                />
              )}

              {candidateBusy && usesNativeModel ? (
                <div className="candidate-content" aria-live="polite">
                  <div className="candidate-content__meta">
                    <Badge tone="ai">生成中</Badge>
                    <span>{generationPreview.length} 字符</span>
                  </div>
                  <pre>{generationPreview || "正在准备第一段建议……"}</pre>
                  <p className="candidate-panel__hint">
                    当前内容尚未写入正式正文，也不会在完成前保存为 AI 建议版本。
                  </p>
                  <Button
                    variant="secondary"
                    loading={cancelBusy}
                    onClick={() => void cancelActiveGeneration()}
                  >
                    取消生成
                  </Button>
                </div>
              ) : candidate === null || candidate.status === "rejected" ? (
                <div className="candidate-content">
                  <EmptyState
                    title={
                      candidate?.status === "rejected" ? "这份建议已拒绝" : "还没有 AI 建议版本"
                    }
                    description={
                      usesNativeModel
                        ? "保存正文后即可继续创作。若无法生成，请前往设置连接 AI 服务并完成连接测试。"
                        : "保存正文后可生成一份明确标注的本机示例建议，用于体验安全比较流程。"
                    }
                  />
                  {candidate?.status === "rejected" && projectId !== null && chapterId !== null && (
                    <CandidateFeedbackControls
                      busy={candidateBusy}
                      onSubmit={async ({ feedbackCode, customFeedback }) => {
                        const outcome = await runtime.story.writingFeedback.recordExplicitFeedback({
                          projectId,
                          chapterId,
                          candidateId: candidate.id,
                          feedbackCode,
                          customFeedback,
                        });
                        if (outcome.learnedPreference !== null) {
                          setEditorNotice(
                            "同类意见已形成一条可见的写作偏好；可在“设定 → 写作偏好”中修改或删除。",
                          );
                        }
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className="candidate-content">
                  <div className="candidate-content__meta">
                    <Badge
                      tone={
                        candidate.status === "accepted"
                          ? "success"
                          : candidate.status === "ready"
                            ? "ai"
                            : "neutral"
                      }
                    >
                      {candidate.status === "accepted"
                        ? "已接受"
                        : candidate.status === "ready"
                          ? "等待决定"
                          : candidate.status}
                    </Badge>
                    <span>{candidate.content.length} 字符</span>
                  </div>
                  {candidate.toSnapshot().incomplete && (
                    <InlineAlert
                      tone="warning"
                      title="建议内容尚未完成"
                      description="生成在取消后停止；已收到的内容仍需由你明确接受，才会进入正文。"
                    />
                  )}
                  {candidateQualityGate?.candidateId === candidate.id &&
                    candidateQualityGate.outcome !== "pass" && (
                      <InlineAlert
                        tone="warning"
                        title={
                          candidateQualityGate.outcome === "block"
                            ? "这份建议存在明显重复"
                            : "建议在接受前仔细比较"
                        }
                        description={
                          candidateQualityGate.outcome === "block"
                            ? "本机规则发现句段重复超过安全阈值。建议重新生成；当前内容仍只是一份隔离的 AI 建议，不会自动进入正文。"
                            : "本机质量关卡发现需要留意的重复迹象。请在比较界面逐项决定。"
                        }
                      />
                    )}
                  {generationReceipt !== null && (
                    <details>
                      <summary>费用与调用记录（高级）</summary>
                      <div className="generation-receipt" aria-label="生成费用记录">
                        <div>
                          <span>尝试上界累计估算</span>
                          <strong>
                            {formatCostEstimate(
                              BigInt(generationReceipt.incurredCostMicros),
                              generationReceipt.currency,
                            )}
                          </strong>
                        </div>
                        <p>
                          共 {generationReceipt.attempt} 次尝试 · {generationReceipt.pricingVersion}
                          。这是预算安全账本，不是供应商实扣金额。
                        </p>
                        {generationAttemptUsage.length > 0 && (
                          <ul>
                            {generationAttemptUsage.map((usage) => (
                              <li key={usage.attempt}>{formatAttemptUsage(usage)}</li>
                            ))}
                          </ul>
                        )}
                        <p>服务回执只证明用量；按回执重算的金额仍为估算，最终以服务账单为准。</p>
                      </div>
                    </details>
                  )}
                  <pre>{boundedEditorPreview(candidate.content)}</pre>
                  {candidate.content.length > 4_000 && (
                    <p className="candidate-panel__hint">
                      面板仅显示前 4,000 个字符；完整建议仍保留，可在比较界面逐项处理或另存。
                    </p>
                  )}
                  {candidateReady && (
                    <div className="candidate-actions">
                      <Button
                        variant="ai-primary"
                        loading={candidateBusy}
                        disabled={!editorClean}
                        onClick={openCandidateReview}
                      >
                        比较 AI 建议
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={candidateBusy}
                        onClick={() => void rejectCandidate()}
                      >
                        拒绝
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {!editorClean && (
                <p className="candidate-panel__hint" role="status">
                  请先保存当前正文，再处理 AI 建议版本。
                </p>
              )}
              {canGenerateCandidate && (
                <>
                  {usesNativeModel && (
                    <Link className="back-link" to="/settings#model-center">
                      设置 AI 服务
                    </Link>
                  )}
                  <Button
                    variant="ghost"
                    loading={candidateBusy}
                    disabled={!editorClean}
                    onClick={() => void generateCandidate()}
                  >
                    {candidate?.status === "accepted"
                      ? "继续创作"
                      : candidate?.status === "rejected"
                        ? "重新生成"
                        : usesNativeModel
                          ? content.trim().length === 0
                            ? "生成开头"
                            : "继续创作"
                          : "生成示例建议"}
                  </Button>
                </>
              )}
              {runtime.featureFlags.multiAgent &&
                runtime.multiAgentReview !== null &&
                projectId !== null &&
                chapterId !== null && (
                  <details>
                    <summary>高级工具</summary>
                    <Link
                      className="back-link"
                      to={`/projects/${projectId}/chapters/${chapterId}/multi-agent-review`}
                    >
                      深度审稿
                    </Link>
                  </details>
                )}
            </aside>
          ) : (
            <aside className="candidate-panel" style={collapsedPanelStyle} aria-label="AI 创作助手">
              <Button
                variant="secondary"
                aria-label="展开 AI 创作助手"
                aria-expanded={assistantOpen}
                onClick={() => setAssistantOpen(true)}
              >
                AI 助手
              </Button>
            </aside>
          )}
        </div>
      </div>

      <Drawer
        open={versionsOpen}
        onOpenChange={setVersionsOpen}
        title="版本历史"
        description="版本按时间倒序展示；恢复会追加一个新的稳定版本，不会改写或删除历史。"
        footer={
          <Button variant="secondary" onClick={() => setVersionsOpen(false)}>
            关闭
          </Button>
        }
      >
        {versions.length === 0 ? (
          <EmptyState title="暂无版本" description="保存正文后会在这里出现稳定版本。" />
        ) : (
          <ol className="version-list">
            {versions.map((version) => {
              const snapshot = version.toSnapshot();
              return (
                <li key={version.id}>
                  <div>
                    <strong>版本 {snapshot.sequence}</strong>
                    <Badge>{versionReasonLabels[snapshot.reason]}</Badge>
                    {chapter?.currentVersionId === snapshot.id && (
                      <Badge tone="success">当前版本</Badge>
                    )}
                  </div>
                  <time dateTime={snapshot.createdAt}>
                    {new Intl.DateTimeFormat("zh-CN", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(snapshot.createdAt))}
                  </time>
                  <span>{snapshot.content.length} 字符</span>
                  <pre className="version-list__preview">
                    {boundedEditorPreview(snapshot.content)}
                  </pre>
                  <Button
                    variant="secondary"
                    disabled={
                      versionRestoreBusy ||
                      !editorClean ||
                      project?.status !== "active" ||
                      chapter?.content === snapshot.content
                    }
                    onClick={() => setVersionToRestore(version)}
                  >
                    {chapter?.currentVersionId === snapshot.id ? "当前稳定版本" : "恢复此版本"}
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
      </Drawer>

      {versionToRestore !== null && chapter !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !versionRestoreBusy) {
              setVersionToRestore(null);
            }
          }}
          title={`恢复版本 ${String(versionToRestore.toSnapshot().sequence)}`}
          description="确认后会把所选内容复制成新的稳定版本；当前版本和所有旧版本都会继续保留。"
          footer={
            <>
              <Button
                variant="secondary"
                disabled={versionRestoreBusy}
                onClick={() => setVersionToRestore(null)}
              >
                取消
              </Button>
              <Button
                loading={versionRestoreBusy}
                disabled={!editorClean || project?.status !== "active"}
                onClick={() => void restoreSelectedVersion()}
              >
                创建恢复版本
              </Button>
            </>
          }
        >
          <div className="version-restore-comparison">
            <InlineAlert
              tone="warning"
              title="这是追加式恢复"
              description="恢复不会回写旧记录。若章节在确认前发生变化，版本冲突保护会阻止提交。"
            />
            <div>
              <section>
                <h3>当前稳定正文</h3>
                <pre>{boundedEditorPreview(chapter.content)}</pre>
              </section>
              <section>
                <h3>将恢复的版本</h3>
                <pre>{boundedEditorPreview(versionToRestore.toSnapshot().content)}</pre>
              </section>
            </div>
          </div>
        </Dialog>
      )}

      {recoveryDraftSnapshot !== null && chapter !== null && (
        <CrashRecoveryDialog
          busy={recoveryDecisionBusy}
          canSaveAsCopy={project?.status === "active" && !recoveryCopySaved}
          draftContent={recoveryDraftSnapshot.content}
          draftUpdatedAt={recoveryDraftSnapshot.updatedAt}
          open={recoveryDecisionOpen}
          stableContent={chapter.content}
          onKeepStable={() => void keepStableChapter()}
          onRecoverDraft={recoverPendingDraft}
          onSaveAsCopy={() => void saveRecoveryDraftAsChapter()}
        />
      )}

      <Dialog
        open={candidateReviewOpen}
        onOpenChange={(open) => {
          if (!candidateBusy) {
            setCandidateReviewOpen(open);
          }
        }}
        title="比较 AI 建议与正文"
        description="AI 建议不会直接覆盖正文。你可以逐处接受或保留原文，也可以插入光标、替换选区，或明确覆盖全文。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={candidateBusy}
              onClick={() => setCandidateReviewOpen(false)}
            >
              暂不处理
            </Button>
            <Button
              variant="ai-primary"
              loading={candidateBusy}
              disabled={candidateReviewConflict !== null || !candidatePartialDecisionComplete}
              onClick={() =>
                void acceptCandidate({
                  kind: "apply_changes",
                  decisions: candidateSelectedDecisions,
                })
              }
            >
              按逐项决定创建版本
            </Button>
          </>
        }
      >
        <div className="candidate-review-dialog">
          {candidateReviewConflict !== null && candidate !== null && (
            <>
              <InlineAlert
                tone="error"
                title="正文已在建议生成后变化"
                description="已阻止接受。下面同时保留生成时正文、当前正文和 AI 建议；请先另存或处理冲突，InkShadow 不会静默覆盖。"
              />
              <div className="candidate-review-dialog__three-way">
                <section>
                  <h3>生成时正文</h3>
                  <pre>{boundedEditorPreview(candidateReviewConflict.baselineContent)}</pre>
                </section>
                <section>
                  <h3>当前稳定正文</h3>
                  <pre>{boundedEditorPreview(candidateReviewConflict.currentContent)}</pre>
                </section>
                <section>
                  <h3>AI 建议</h3>
                  <pre>{boundedEditorPreview(candidate.content)}</pre>
                </section>
              </div>
              <div className="candidate-review-dialog__conflict-actions">
                <p>
                  可先把完整 AI 建议保存成独立章节，从而同时保留当前正文与建议，再决定是否拒绝。
                </p>
                <Button
                  variant="secondary"
                  loading={candidateBusy}
                  disabled={project?.status !== "active" || candidateCopySaved}
                  onClick={() => void saveCandidateAsChapterCopy()}
                >
                  {candidateCopySaved ? "建议副本已保存" : "将建议另存为新章节"}
                </Button>
              </div>
            </>
          )}
          {candidateReviewError !== null && (
            <InlineAlert
              tone={candidateReviewConflict === null ? "warning" : "error"}
              title="AI 建议比较提示"
              description={candidateReviewError}
            />
          )}
          {candidateDiff !== null && (
            <EditorAiSuggestionDiffViewer
              decisions={candidateDiffDecisions}
              diff={candidateDiff}
              disabled={candidateBusy || candidateReviewConflict !== null}
              onDecision={(changeId, decision) =>
                setCandidateDiffDecisions((current) =>
                  Object.freeze({ ...current, [changeId]: decision }),
                )
              }
            />
          )}
          {candidate !== null && (
            <section className="candidate-review-dialog__placement">
              <div>
                <h3>整段应用方式</h3>
                <p>
                  当前选区：第 {candidateReviewSelection.start} 到 {candidateReviewSelection.end}{" "}
                  个字符
                </p>
              </div>
              <div>
                <Button
                  variant="secondary"
                  disabled={candidateBusy || candidateReviewConflict !== null}
                  onClick={() =>
                    void acceptCandidate({
                      kind: "insert_at_cursor",
                      cursorUtf16: candidateReviewSelection.start,
                    })
                  }
                >
                  插入到光标
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    candidateBusy ||
                    candidateReviewConflict !== null ||
                    candidateReviewSelection.start === candidateReviewSelection.end
                  }
                  onClick={() =>
                    void acceptCandidate({
                      kind: "replace_selection",
                      selection: candidateReviewSelection,
                    })
                  }
                >
                  替换当前选区
                </Button>
                <Button
                  disabled={candidateBusy || candidateReviewConflict !== null}
                  onClick={() => void acceptCandidate({ kind: "overwrite_document" })}
                >
                  覆盖全文并创建版本
                </Button>
              </div>
            </section>
          )}
        </div>
      </Dialog>

      <Dialog
        open={preflightOpen}
        onOpenChange={(open) => {
          if (!budgetSaving) {
            setPreflightOpen(open);
          }
        }}
        title="生成前检查"
        description="开始前会检查正文是否已保存、AI 服务是否可用以及预算是否允许；有问题时会告诉你如何解决。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={budgetSaving}
              onClick={() => setPreflightOpen(false)}
            >
              暂不生成
            </Button>
            {generationPlan !== null && canDeferGenerationPlan(generationPlan) && (
              <Button
                variant="secondary"
                loading={candidateBusy}
                disabled={budgetSaving}
                onClick={() => void deferGenerationUntilOnline()}
              >
                保存待执行
              </Button>
            )}
            <Button
              variant="ai-primary"
              disabled={!generationPlan?.preflight.canStart || budgetSaving}
              onClick={() => void confirmGeneration()}
            >
              确认并开始
            </Button>
          </>
        }
      >
        {generationPlan !== null && (
          <div className="generation-preflight">
            <InlineAlert
              tone={generationPlan.preflight.canStart ? "info" : "error"}
              title={
                generationPlan.preflight.canStart
                  ? generationPlan.preflight.requiresConfirmation
                    ? "可以开始，但有建议项"
                    : "检查通过"
                  : "存在阻断项"
              }
              description={
                generationPlan.preflight.canStart
                  ? "确认后才会开始生成。重复确认同一份检查结果会复用原任务，不会重复调用 AI 服务。"
                  : canDeferGenerationPlan(generationPlan)
                    ? "当前只因网络离线而阻断；可保存不含正文和创作指令的待执行记录，联网后重新检查并确认。"
                    : "请按下列操作修复后重新检查；当前不会调用 AI 服务。"
              }
            />

            <details>
              <summary>AI 分工与隐私详情（高级）</summary>
              <InlineAlert
                tone={generationPlan.routeReason === "role_fallback" ? "warning" : "info"}
                title={
                  generationPlan.routeReason === "role_fallback"
                    ? "将使用已配置的备用服务"
                    : "本次 AI 分工"
                }
                description={`${generationRouteRoleLabel(generationPlan.modelRole)} · ${
                  generationPlan.providerId
                } / ${generationPlan.modelId} · ${
                  generationPlan.profile?.provider === "ollama"
                    ? "数据仅发送到本机 AI 服务"
                    : generationPlan.routeReason === "local_demo"
                      ? "内置演示，不外发"
                      : "本次所需内容将发送到外部 AI 服务"
                }${
                  generationPlan.routeFallback === null
                    ? ""
                    : `；备用服务 ${generationPlan.routeFallback.providerId} / ${generationPlan.routeFallback.modelId}`
                }。`}
              />
            </details>

            {generationPlan.contextCompilation !== null && (
              <details>
                <summary>本次会参考哪些故事内容</summary>
                <div className="generation-receipt" aria-label="本次故事资料来源">
                  <div>
                    <span>已选资料</span>
                    <strong>
                      {
                        generationPlan.contextCompilation.compiled.entries.filter(
                          ({ included }) => included,
                        ).length
                      }{" "}
                      项
                    </strong>
                  </div>
                  <p>
                    预计使用{" "}
                    {generationPlan.contextCompilation.compiled.trace.usedTokens.toLocaleString(
                      "zh-CN",
                    )}
                    /
                    {generationPlan.contextCompilation.compiled.trace.maximumContextTokens.toLocaleString(
                      "zh-CN",
                    )}{" "}
                    个上下文用量单位；未选资料不会发送给模型。
                  </p>
                  <ul>
                    {generationPlan.contextCompilation.compiled.entries.map((entry) => (
                      <li key={entry.id}>
                        <Badge tone={entry.included ? "info" : "neutral"}>
                          {entry.included ? "已参考" : "因篇幅未使用"}
                        </Badge>{" "}
                        <strong>{contextLayerLabel(entry.layer)}</strong>
                        <span> · 约 {entry.estimatedTokens.toLocaleString("zh-CN")} 单位</span>
                        <p>{contextSelectionReasonLabel(entry.selectionReason)}</p>
                        {entry.evidence.length > 0 && (
                          <small>
                            来源：
                            {entry.evidence
                              .map(
                                (source) =>
                                  `${contextSourceTypeLabel(source.sourceType)} · ${source.sourceId}`,
                              )
                              .join("；")}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            )}

            <ul className="generation-preflight__checks">
              {generationPlan.preflight.checks.map((check) => (
                <li key={check.code}>
                  <div>
                    <Badge
                      tone={
                        check.severity === "blocking"
                          ? "danger"
                          : check.severity === "fix_recommended"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {preflightSeverityLabel(check.severity)}
                    </Badge>
                    <strong>{preflightCheckLabel(check.code)}</strong>
                  </div>
                  {check.action === "SAVE_CHAPTER" ? (
                    <Button variant="secondary" onClick={() => void manualSave()}>
                      保存章节
                    </Button>
                  ) : check.action === "OPEN_MODEL_CENTER" ||
                    check.action === "UPDATE_PRICING" ||
                    check.action === "RETRY_CONNECTION" ? (
                    <Link className="back-link" to="/settings#model-center">
                      设置 AI 服务
                    </Link>
                  ) : check.action === "REDUCE_CONTEXT" ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPreflightOpen(false);
                        editorRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      返回正文精简内容
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>

            {generationEstimate !== null && (
              <section className="generation-preflight__cost" aria-label="费用估算">
                <div>
                  <span>本次费用上界估算</span>
                  <strong>
                    {formatCostEstimate(generationEstimate.micros, generationEstimate.currency)}
                  </strong>
                </div>
                <details>
                  <summary>用量与计价依据（高级）</summary>
                  <dl>
                    <div>
                      <dt>输入 / 输出上限</dt>
                      <dd>
                        {generationPlan.preflight.inputTokens.toLocaleString("zh-CN")} /{" "}
                        {generationPlan.preflight.maximumOutputTokens.toLocaleString("zh-CN")}{" "}
                        用量单位
                      </dd>
                    </div>
                    <div>
                      <dt>估算依据</dt>
                      <dd>
                        {generationPlan.tokenEstimateSource === "local_demo"
                          ? "内置演示，不计费"
                          : "按文本体积保守估算"}
                      </dd>
                    </div>
                    <div>
                      <dt>价格来源</dt>
                      <dd>
                        {generationEstimate.pricingVersion} ·{" "}
                        {generationEstimate.priceUpdatedAt.slice(0, 10)}
                      </dd>
                    </div>
                  </dl>
                </details>
                {generationPlan.preflight.budget?.alerts.map((alert) => (
                  <InlineAlert
                    key={alert.scope}
                    tone={alert.severity === "blocked" ? "error" : "warning"}
                    title={`${budgetScopeLabel(alert.scope)}预算${
                      alert.severity === "blocked" ? "已阻断" : "接近或超过阈值"
                    }`}
                    description={`预计累计 ${formatCostEstimate(
                      alert.projectedMicros,
                      generationEstimate.currency,
                    )}，预算 ${formatCostEstimate(
                      alert.limitMicros,
                      generationEstimate.currency,
                    )}。`}
                  />
                ))}
              </section>
            )}

            {generationPlan.projectId !== null &&
              generationPlan.preflight.estimate !== null &&
              runtime.mode === "tauri" && (
                <section className="generation-preflight__budgets" aria-label="预算设置">
                  <div>
                    <h3>预算限制</h3>
                    <p>金额按当前计价币种填写；达到 80% 会提醒，硬上限超出时阻断生成。</p>
                  </div>
                  <div className="generation-preflight__budget-grid">
                    <FormField label="项目预算">
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          type="number"
                          min={0}
                          step="0.000001"
                          value={projectBudgetAmount}
                          placeholder="未设置"
                          onChange={(event) => setProjectBudgetAmount(event.currentTarget.value)}
                        />
                      )}
                    </FormField>
                    <FormField label="项目策略">
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={projectBudgetEnforcement}
                          options={[
                            { value: "hard", label: "硬上限" },
                            { value: "warn", label: "仅提醒" },
                          ]}
                          onChange={(event) =>
                            setProjectBudgetEnforcement(
                              event.currentTarget.value as "warn" | "hard",
                            )
                          }
                        />
                      )}
                    </FormField>
                    <FormField label="本月预算">
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          type="number"
                          min={0}
                          step="0.000001"
                          value={monthBudgetAmount}
                          placeholder="未设置"
                          onChange={(event) => setMonthBudgetAmount(event.currentTarget.value)}
                        />
                      )}
                    </FormField>
                    <FormField label="本月策略">
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={monthBudgetEnforcement}
                          options={[
                            { value: "hard", label: "硬上限" },
                            { value: "warn", label: "仅提醒" },
                          ]}
                          onChange={(event) =>
                            setMonthBudgetEnforcement(event.currentTarget.value as "warn" | "hard")
                          }
                        />
                      )}
                    </FormField>
                  </div>
                  <Button
                    variant="secondary"
                    loading={budgetSaving}
                    onClick={() => void saveBudgetsAndRefresh()}
                  >
                    保存预算并重新检查
                  </Button>
                </section>
              )}
          </div>
        )}
      </Dialog>
    </PageStateBoundary>
  );
}

function boundedEditorPreview(content: string): string {
  const previewLimit = 4_000;
  return content.length <= previewLimit
    ? content
    : `${content.slice(0, previewLimit)}\n\n…（预览已截断，完整内容仍保留）`;
}

function preflightSeverityLabel(severity: "blocking" | "fix_recommended" | "notice"): string {
  if (severity === "blocking") {
    return "阻断";
  }
  return severity === "fix_recommended" ? "建议修复" : "提示";
}

function contextLayerLabel(layer: ContextLayer): string {
  const labels: Record<ContextLayer, string> = {
    locked_hard_rules: "已锁定规则",
    current_task: "本次写作任务",
    scene_goal: "当前场景目标",
    pov_known_information: "视角人物已知信息",
    character_current_state: "人物当前状态",
    recent_events: "近期正文与事件",
    related_causal_chain: "相关前因后果",
    unresolved_foreshadowing: "尚未回收的伏笔",
    world_setting: "相关世界设定",
    character_voice_samples: "人物历史说话样例",
    semantic_retrieval: "语义相关资料",
    rerank_supplement: "再次核对后补充的资料",
  };
  return labels[layer];
}

function contextSourceTypeLabel(sourceType: ContextEvidenceSourceType): string {
  const labels: Record<ContextEvidenceSourceType, string> = {
    user_input: "用户输入",
    generation_task: "当前任务",
    scene_plan: "场景计划",
    chapter: "章节版本",
    outline: "故事规划",
    character: "人物设定",
    relationship: "人物关系",
    world: "世界设定",
    timeline_event: "时间线事件",
    causal_event: "因果事件",
    foreshadow: "伏笔",
    story_rule: "故事规则",
    memory: "AI 记住的内容",
    search_document: "本地检索资料",
    rerank_result: "检索复核结果",
    import: "导入原文",
    other: "其他创作资料",
  };
  return labels[sourceType];
}

function contextSelectionReasonLabel(reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes("explicitly requested")) {
    return "这是你本次明确提出的写作任务。";
  }
  if (normalized.includes("locked") || normalized.includes("hard constraint")) {
    return "这是你已确认并锁定的规则，必须优先遵守。";
  }
  if (normalized.includes("current saved chapter")) {
    return "这是与下一段内容直接相连的当前稳定正文。";
  }
  if (normalized.includes("local hybrid index")) {
    return "本地检索发现它与当前情节相关。";
  }
  if (normalized.includes("alibaba qwen") || normalized.includes("qwen remote reranker")) {
    return "你已在 AI 分工中明确允许远程重排；阿里云百炼 Qwen 将这项资料排到了更相关的位置。";
  }
  if (normalized.includes("deterministic evidence reranker")) {
    return "本地证据复核后，它比原始排序中的其他资料更相关。";
  }
  if (normalized.includes("branch-scoped")) {
    return "这是你为当前试演剧情明确填写的分支资料，不会混入主线。";
  }
  if (normalized.includes("non-authoritative aid")) {
    return "这是系统从正文更新的可撤销临时状态，只作参考，不会覆盖正式设定。";
  }
  if (normalized.includes("formal") || normalized.includes("user-confirmed")) {
    return "这是经过你确认的正式故事事实。";
  }
  return "系统根据当前任务、证据可靠性和资料优先级选择。";
}

function preflightCheckLabel(code: string): string {
  const labels: Record<string, string> = {
    MIGRATION_REQUIRED: "本地数据升级尚未完成",
    CHAPTER_NOT_FOUND: "找不到当前章节",
    CHAPTER_UNSAVED: "当前正文尚未稳定保存",
    PROJECT_READONLY: "项目当前为只读",
    MODEL_GATEWAY_UNAVAILABLE: "AI 服务暂时不可用",
    NETWORK_OFFLINE: "联网 AI 服务需要网络连接",
    MODEL_ROUTE_UNRESOLVED: "没有找到可用的 AI 服务",
    MODEL_PROFILE_MISSING: "尚未连接 AI 服务",
    MODEL_NOT_SELECTED: "AI 服务尚未准备好",
    MODEL_CREDENTIAL_MISSING: "需要补充 AI 服务密钥",
    MODEL_CONNECTION_FAILED: "AI 服务连接测试未通过",
    SELECTED_MODEL_UNAVAILABLE: "此前选择的 AI 服务当前不可用",
    MODEL_PRICING_MISSING: "缺少费用与可处理长度信息",
    MODEL_PRICING_STALE: "价格信息超过 30 天",
    INPUT_TOO_LARGE: "本章内容超过单次生成安全上限",
    CONTEXT_WINDOW_UNKNOWN: "无法确认本次可处理的内容长度",
    CONTEXT_WINDOW_EXCEEDED: "本次所需内容超过可处理长度",
    CONTEXT_WINDOW_NEAR_LIMIT: "本次所需内容接近可处理长度上限",
    BUDGET_WARNING: "预计费用接近或超过预算提醒阈值",
    BUDGET_EXCEEDED: "预计费用超过硬预算",
    READY: "AI 服务、章节、费用与预算均已检查",
  };
  return labels[code] ?? code;
}

function budgetScopeLabel(scope: "task" | "project" | "month"): string {
  if (scope === "project") {
    return "项目";
  }
  return scope === "month" ? "本月" : "本次任务";
}

function readBooleanRef(reference: { readonly current: boolean }): boolean {
  return reference.current;
}

function generationRouteRoleLabel(role: PreparedGenerationPlan["modelRole"]): string {
  const labels: Record<PreparedGenerationPlan["modelRole"], string> = {
    fast: "快速",
    high_quality: "高质量",
    long_context: "长上下文",
    embedding: "语义记忆",
    validation: "检查",
    translation: "翻译",
    local_private: "本地隐私",
  };
  return labels[role];
}

function formatAttemptUsage(usage: GenerationAttemptUsage): string {
  if (usage.source === "local_demo") {
    return `第 ${String(usage.attempt)} 次：内置演示，不产生外部服务用量或费用。`;
  }
  if (
    usage.source === "provider_reported" &&
    usage.inputTokens !== null &&
    usage.outputTokens !== null &&
    usage.usagePricedEstimateMicros !== null
  ) {
    const cached =
      usage.cachedInputTokens === null
        ? ""
        : `，其中缓存输入 ${usage.cachedInputTokens.toLocaleString("zh-CN")}`;
    return `第 ${String(usage.attempt)} 次供应商回执：输入 ${usage.inputTokens.toLocaleString(
      "zh-CN",
    )}${cached}，输出 ${usage.outputTokens.toLocaleString(
      "zh-CN",
    )} 用量单位；按价格版本重算 ${formatCostEstimate(
      BigInt(usage.usagePricedEstimateMicros),
      usage.currency,
    )}（估算）。`;
  }
  return `第 ${String(usage.attempt)} 次：外部服务未返回可验证用量回执，保留生成前上界估算。`;
}

function formatCostEstimate(micros: bigint, currency: string): string {
  return `${currency} ${formatMicrosAmount(micros.toString())}`;
}

function formatMicrosAmount(value: string): string {
  const micros = BigInt(value);
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

function parseAmountToMicros(value: string): string {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(normalized)) {
    throw new UiActionError(
      "GENERATION_BUDGET_INVALID",
      "预算金额必须是非负数字，最多保留六位小数。请修改金额后重新保存。",
    );
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();
}
