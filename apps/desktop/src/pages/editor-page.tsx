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
} from "../infrastructure/runtime";
import { normalizeUiError } from "../infrastructure/ui-error";
import type {
  DeferredGenerationRequest,
  GenerationAttemptUsage,
  GenerationBudgetPolicy,
  GenerationRun,
} from "../infrastructure/generation-governance-store";
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
import {
  CandidateDiffViewer,
  type CandidateDiffDecision,
} from "../components/candidate-diff-viewer";
import { CrashRecoveryDialog } from "../components/crash-recovery-dialog";

const versionReasonLabels: Record<ReturnType<ChapterVersion["toSnapshot"]>["reason"], string> = {
  created: "创建",
  autosave: "自动保存",
  manual: "手动保存",
  candidate_accept: "接受候选",
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

interface CandidateRouteSelection {
  readonly candidate: AiCandidate | null;
  readonly notice: string | null;
}

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
      notice: "候选链接无效；未自动打开其他候选。请从多 Agent 审查页重新选择。",
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
        ? "链接指定的候选不存在、已处理，或不属于当前项目与章节；未自动打开其他候选。"
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
    Readonly<Record<string, CandidateDiffDecision | undefined>>
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
    const [projectResult, chapterResult, draftResult, versionsResult, candidatesResult] =
      await Promise.all([
        runtime.repositories.projects.findById(projectId),
        runtime.repositories.chapters.findById(chapterId),
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
  }, [project?.status, projectId, recoveryCopySaved, recoveryDraft, runtime]);

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
      if (result.value.candidate !== null) {
        setCandidate(result.value.candidate);
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
        "候选所依据的稳定版本已经不可用；为避免覆盖正文，当前不能接受这份候选。",
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
    setEditorNotice(
      strategy.kind === "apply_changes"
        ? "已按逐项决定创建新的稳定版本；可在本次会话撤销，原稳定版本仍保留在版本历史。"
        : "候选已按所选方式写入新的稳定版本；原稳定版本仍保留在版本历史。",
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
    const copyTitle = `${chapter.title.slice(0, 190)}（候选副本）`;
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
    setCandidateCopySaved(true);
    setError(null);
    setEditorNotice(`候选已另存为新章节“${copyTitle}”，当前稳定正文和候选记录均未改变。`);
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
            <SaveStatus
              state={readonly ? "readonly" : saveState}
              {...(readonly || saveState === "saving"
                ? {}
                : { onActivate: () => void manualSave() })}
            />
            <Button variant="secondary" onClick={() => setVersionsOpen(true)}>
              版本历史
            </Button>
            {runtime.featureFlags.multiAgent &&
              runtime.multiAgentReview !== null &&
              projectId !== null &&
              chapterId !== null && (
                <Link
                  className="ink-button ink-button--secondary"
                  to={`/projects/${projectId}/chapters/${chapterId}/multi-agent-review`}
                >
                  多 Agent 审查
                </Link>
              )}
            <Button
              disabled={readonly || saveState === "saving"}
              loading={saveState === "saving"}
              onClick={() => void manualSave()}
            >
              手动保存
            </Button>
          </div>
        </header>

        {!online && (
          <InlineAlert
            tone="info"
            title="当前离线"
            description={
              usesNativeModel
                ? "正文、恢复草稿和版本仍会保存到当前设备；远程模型可能不可用，本机 Ollama 仍可尝试。"
                : "正文、恢复草稿和版本仍会保存到当前设备；本地演示候选不需要联网。"
            }
          />
        )}
        {deferredGeneration !== null && deferredGeneration.status === "waiting_network" && (
          <InlineAlert
            tone={online ? "info" : "warning"}
            title="云模型任务已保存待执行"
            description={`仅保存章节/版本、模型角色和费用上界，不保存正文或 Prompt。${
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

        <div className="editor-workspace">
          <section
            className={`writing-canvas writing-canvas--${typography.measure}`}
            data-surface="light"
            data-font-family={typography.fontFamily}
            style={writingCanvasStyle}
            aria-label="章节正文"
          >
            <Textarea
              ref={editorRef}
              className="writing-textarea"
              aria-label="章节正文"
              value={content}
              readOnly={readonly}
              currentLength={content.length}
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
                scheduleEditorViewPersistence(selection);
              }}
              onScroll={(event) => {
                scrollTopRef.current = event.currentTarget.scrollTop;
                scheduleEditorViewPersistence(selectionRef.current);
              }}
              onChange={handleEditorChange}
            />
          </section>

          <aside className="candidate-panel" aria-labelledby="candidate-title">
            <div className="candidate-panel__header">
              <div>
                <p className="page-heading__eyebrow">AI Candidate</p>
                <h2 id="candidate-title">候选内容</h2>
              </div>
              <Badge tone="ai">{usesNativeModel ? "原生模型网关" : "本地演示生成器"}</Badge>
            </div>
            <InlineAlert
              tone="ai-clarification"
              title={usesNativeModel ? "模型输出仍是候选" : "仅用于本地交互演示"}
              description={
                usesNativeModel
                  ? "保存后的章节内容会发送到模型中心最近配置且已选择模型的端点；流式输出只形成候选，点击“接受候选”前正式正文绝不改变。"
                  : "不会调用模型或消耗密钥；点击“接受候选”前，正式正文绝不改变。"
              }
            />

            {candidateBusy && usesNativeModel ? (
              <div className="candidate-content" aria-live="polite">
                <div className="candidate-content__meta">
                  <Badge tone="ai">生成中</Badge>
                  <span>{generationPreview.length} 字符</span>
                </div>
                <pre>{generationPreview || "正在等待模型返回首段内容……"}</pre>
                <p className="candidate-panel__hint">
                  当前内容尚未写入正式正文，也不会在生成完成前保存为候选。
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
              <EmptyState
                title={candidate?.status === "rejected" ? "候选已拒绝" : "还没有候选"}
                description={
                  usesNativeModel
                    ? "先保存正文，并在模型中心保存端点配置且选择模型，然后生成候选。"
                    : "先保存正文，再创建一个明确标注的本地演示候选。"
                }
              />
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
                    title="未完成候选"
                    description="生成在取消后停止；已收到的部分内容被保留为未完成候选，必须由你明确接受才会进入正文。"
                  />
                )}
                {generationReceipt !== null && (
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
                    <p>
                      供应商回执只证明 token 用量；按回执重算的金额仍为估算，最终以供应商账单为准。
                    </p>
                  </div>
                )}
                <pre>{boundedEditorPreview(candidate.content)}</pre>
                {candidate.content.length > 4_000 && (
                  <p className="candidate-panel__hint">
                    面板仅显示前 4,000 个字符；完整候选仍保留，可在比较界面逐项处理或另存。
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
                      比较并决定
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
                请先保存当前正文，再决定候选。
              </p>
            )}
            {canGenerateCandidate && (
              <>
                {usesNativeModel && (
                  <Link className="back-link" to="/settings#model-center">
                    打开模型中心
                  </Link>
                )}
                <Button
                  variant="ghost"
                  loading={candidateBusy}
                  disabled={!editorClean}
                  onClick={() => void generateCandidate()}
                >
                  {candidate?.status === "accepted"
                    ? "继续生成候选"
                    : candidate?.status === "rejected"
                      ? "创建新候选"
                      : usesNativeModel
                        ? "生成候选"
                        : "创建演示候选"}
                </Button>
              </>
            )}
          </aside>
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
        title="比较候选与稳定正文"
        description="候选不会直接覆盖正文。可以逐处接受或保留原文，也可以把完整候选插入光标、替换选区，或明确覆盖全文。"
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
                title="稳定正文已在候选生成后变化"
                description="已阻止接受。下面同时保留基线、当前正文和候选；请先另存或处理冲突，InkShadow 不会静默覆盖。"
              />
              <div className="candidate-review-dialog__three-way">
                <section>
                  <h3>候选基线</h3>
                  <pre>{boundedEditorPreview(candidateReviewConflict.baselineContent)}</pre>
                </section>
                <section>
                  <h3>当前稳定正文</h3>
                  <pre>{boundedEditorPreview(candidateReviewConflict.currentContent)}</pre>
                </section>
                <section>
                  <h3>候选内容</h3>
                  <pre>{boundedEditorPreview(candidate.content)}</pre>
                </section>
              </div>
              <div className="candidate-review-dialog__conflict-actions">
                <p>
                  可先把完整候选保存成独立章节，从而同时保留当前正文与候选，再决定是否拒绝原候选。
                </p>
                <Button
                  variant="secondary"
                  loading={candidateBusy}
                  disabled={project?.status !== "active" || candidateCopySaved}
                  onClick={() => void saveCandidateAsChapterCopy()}
                >
                  {candidateCopySaved ? "候选副本已保存" : "将候选另存为新章节"}
                </Button>
              </div>
            </>
          )}
          {candidateReviewError !== null && (
            <InlineAlert
              tone={candidateReviewConflict === null ? "warning" : "error"}
              title="候选比较提示"
              description={candidateReviewError}
            />
          )}
          {candidateDiff !== null && (
            <CandidateDiffViewer
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
                  当前选区：{candidateReviewSelection.start}–{candidateReviewSelection.end}
                  （UTF-16）
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
        description="检查结果由当前章节、写入权限、模型配置、上下文、价格版本和预算实时计算；阻断项未解决前不会启动模型或产生任务费用。"
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
                  ? "确认后才会创建并执行可审计任务。重复提交同一检查计划会复用原任务，不会重复调用模型。"
                  : canDeferGenerationPlan(generationPlan)
                    ? "当前只因网络离线而阻断；可保存不含正文和 Prompt 的待执行记录，联网后重新检查并确认。"
                    : "请按下列操作修复后重新检查；当前不会调用模型。"
              }
            />

            <InlineAlert
              tone={generationPlan.routeReason === "role_fallback" ? "warning" : "info"}
              title={
                generationPlan.routeReason === "role_fallback"
                  ? "将使用已配置的备用模型"
                  : "本次模型路由"
              }
              description={`${generationRouteRoleLabel(generationPlan.modelRole)} · ${
                generationPlan.providerId
              } / ${generationPlan.modelId} · ${
                generationPlan.profile?.provider === "ollama"
                  ? "数据仅发送到本机模型端点"
                  : generationPlan.routeReason === "local_demo"
                    ? "内置演示，不外发"
                    : "所列上下文将发送到外部模型供应商"
              }${
                generationPlan.routeFallback === null
                  ? ""
                  : `；配置备用 ${generationPlan.routeFallback.providerId} / ${generationPlan.routeFallback.modelId}`
              }。`}
            />

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
                    check.action === "RETRY_CONNECTION" ||
                    check.action === "REDUCE_CONTEXT" ? (
                    <Link className="back-link" to="/settings#model-center">
                      打开模型中心
                    </Link>
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
                <dl>
                  <div>
                    <dt>输入 / 输出</dt>
                    <dd>
                      {generationPlan.preflight.inputTokens.toLocaleString("zh-CN")} /{" "}
                      {generationPlan.preflight.maximumOutputTokens.toLocaleString("zh-CN")} token
                    </dd>
                  </div>
                  <div>
                    <dt>估算依据</dt>
                    <dd>
                      {generationPlan.tokenEstimateSource === "local_demo"
                        ? "内置演示，不计费"
                        : "UTF-8 字节保守估算"}
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

function preflightCheckLabel(code: string): string {
  const labels: Record<string, string> = {
    MIGRATION_REQUIRED: "本地数据升级尚未完成",
    CHAPTER_NOT_FOUND: "找不到当前章节",
    CHAPTER_UNSAVED: "当前正文尚未稳定保存",
    PROJECT_READONLY: "项目当前为只读",
    MODEL_GATEWAY_UNAVAILABLE: "原生模型网关不可用",
    NETWORK_OFFLINE: "远程模型需要网络连接",
    MODEL_ROUTE_UNRESOLVED: "角色路由没有可核验的精确模型",
    MODEL_PROFILE_MISSING: "尚未保存模型配置",
    MODEL_NOT_SELECTED: "尚未选择模型",
    MODEL_CREDENTIAL_MISSING: "所选模型需要系统凭据库密钥",
    MODEL_CONNECTION_FAILED: "模型目录连接检查未通过",
    SELECTED_MODEL_UNAVAILABLE: "所选模型不在当前端点目录中",
    MODEL_PRICING_MISSING: "缺少模型价格和上下文配置",
    MODEL_PRICING_STALE: "价格信息超过 30 天",
    INPUT_TOO_LARGE: "章节上下文超过原生请求安全上限",
    CONTEXT_WINDOW_UNKNOWN: "模型上下文上限未知",
    CONTEXT_WINDOW_EXCEEDED: "预计上下文超过模型上限",
    CONTEXT_WINDOW_NEAR_LIMIT: "预计上下文接近模型上限",
    BUDGET_WARNING: "预计费用接近或超过预算提醒阈值",
    BUDGET_EXCEEDED: "预计费用超过硬预算",
    READY: "模型、章节、费用与预算均已检查",
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
    embedding: "Embedding",
    validation: "检查",
    translation: "翻译",
    local_private: "本地隐私",
  };
  return labels[role];
}

function formatAttemptUsage(usage: GenerationAttemptUsage): string {
  if (usage.source === "local_demo") {
    return `第 ${String(usage.attempt)} 次：内置演示，不产生供应商 token 或费用。`;
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
    )} token；按价格版本重算 ${formatCostEstimate(
      BigInt(usage.usagePricedEstimateMicros),
      usage.currency,
    )}（估算）。`;
  }
  return `第 ${String(usage.attempt)} 次：供应商未返回可验证 token 回执，保留生成前上界估算。`;
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
    throw new Error("预算金额必须是非负数字，最多保留六位小数。");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))).toString();
}
