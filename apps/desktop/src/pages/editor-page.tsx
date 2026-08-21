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
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent as ReactSyntheticEvent,
} from "react";
import {
  diffCandidateContent,
  planCandidateApplication,
  type CandidateApplicationStrategy,
  type CandidateTextDiff,
} from "@inkshadow/application";
import type {
  CandidateQualityGateResult,
  ContinuationDestinationId,
  ContinuationOutputProfileId,
  ContextEvidenceSourceType,
  ContextLayer,
} from "@inkshadow/ai-core";
import type {
  AiCandidate,
  Chapter,
  ChapterPrivacyMode,
  ChapterVersion,
  Project,
  RecoveryDraft,
  UuidV7,
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
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";

import "../components/candidate-decision.css";

import {
  canDeferGenerationPlan,
  cancelGenerationPlan,
  executeGenerationPlan,
  prepareGenerationPlan,
  saveDeferredGenerationPlan,
  type PreparedGenerationPlan,
  type RuntimeStory,
} from "../infrastructure/runtime";
import {
  createSelectionRewriteCandidate,
  MAXIMUM_SELECTION_REWRITE_CHARACTERS,
  prepareSelectionRewrite,
  type SelectionRewriteDisclosure,
} from "../infrastructure/selection-rewrite-service";
import type { StoryContextCompilationReceipt } from "../infrastructure/story-context-runtime";
import {
  normalizeUiError,
  projectOrdinaryUiError,
  requiresRuntimeDatabaseReopen,
  UiActionError,
} from "../infrastructure/ui-error";
import type {
  DeferredGenerationRequest,
  GenerationAttemptUsage,
  GenerationBudgetPolicy,
  GenerationRun,
} from "../infrastructure/generation-governance-store";
import {
  createLocalCandidateAcceptancePipelineInput,
  ensureAcceptedChapterPipelineTask,
  runAcceptedChapterPipeline,
  type AcceptedChapterPipelineInput,
} from "../infrastructure/accepted-chapter-pipeline";
import { useAppearancePreference } from "../appearance-preference";
import { useOnlineStatus } from "../hooks/use-online-status";
import { useWritingExperience } from "../hooks/use-writing-experience";
import {
  disclosureGrantMatches,
  projectDirectWritingDisclosure,
  type DirectWritingDisclosure,
} from "../infrastructure/direct-writing-disclosure";
import {
  assertContinuationDisclosureMatches,
  prepareContinuationGenerationDisclosure,
  type ContinuationGenerationDisclosure,
} from "../infrastructure/continuation-generation-disclosure";
import {
  directStoryFactOrganizerNotice,
  organizeDirectStoryFacts,
} from "../infrastructure/direct-story-fact-organizer";
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
  EDITOR_TYPOGRAPHY_CHANGED_EVENT,
  loadEditorTypography,
  loadEditorView,
  saveEditorTypography,
  saveEditorView,
  type EditorFontFamily,
  type EditorMeasure,
  type EditorTypography,
} from "../infrastructure/editor-view-state-store";
import {
  DEFAULT_EDITOR_CONTINUATION_PREFERENCE,
  loadEditorContinuationPreference,
  saveEditorContinuationPreference,
  type EditorContinuationPreference,
} from "../infrastructure/editor-continuation-preference";
import {
  EDITOR_PREFERENCES_CHANGED_EVENT,
  EDITOR_PREFERENCES_STORAGE_KEY,
  loadEditorPreferences,
} from "../infrastructure/editor-preferences-store";
import {
  desktopPersistenceLifecycle,
  SerializedPersistenceQueue,
  type PersistenceFlushHandlerResult,
  type PersistenceFlushOutcome,
} from "../infrastructure/persistence-lifecycle";
import { useRuntime } from "../runtime-context";
import { CrashRecoveryDialog } from "../components/crash-recovery-dialog";
import {
  GenerationProgressPanel,
  type GenerationProgressStage,
} from "../components/generation-progress-panel";
import { CandidateFeedbackControls } from "../components/candidate-feedback-controls";
import { PreparedNovelSkillReference } from "../components/novel-skill-reference";
import {
  EditorAiSuggestionDiffViewer,
  type AiSuggestionDiffDecision,
} from "./editor-ai-suggestion-diff-viewer";

const versionReasonLabels: Record<ReturnType<ChapterVersion["toSnapshot"]>["reason"], string> = {
  created: "创建",
  autosave: "自动保存",
  manual: "手动保存",
  candidate_accept: "接受建议",
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
const BACKGROUND_FLUSH_TIMEOUT_MS = 3_000;
const COMPACT_EDITOR_MEDIA_QUERY = "(max-width: 64rem)";
const EDITOR_ASSISTANT_DEFAULT_WIDTH_PX = 360;
const EDITOR_ASSISTANT_MIN_WIDTH_PX = 256;
const EDITOR_ASSISTANT_MAX_WIDTH_PX = 560;
const EDITOR_WRITING_MIN_WIDTH_PX = 320;
const EDITOR_ASSISTANT_KEYBOARD_STEP_PX = 8;
const EDITOR_ASSISTANT_KEYBOARD_LARGE_STEP_PX = 32;
const COMPACT_ASSISTANT_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function compactAssistantFocusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(COMPACT_ASSISTANT_FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hidden &&
      !element.inert &&
      element.getAttribute("aria-hidden") !== "true",
  );
}

const collapsedPanelStyle: CSSProperties = {
  alignSelf: "flex-start",
  padding: "var(--space-2)",
};

interface EditorAssistantResizeBounds {
  readonly min: number;
  readonly max: number;
}

interface EditorAssistantResizeDrag {
  readonly pointerId: number;
  readonly startClientX: number;
  readonly startWidth: number;
}

function clampEditorAssistantWidth(width: number, bounds: EditorAssistantResizeBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(width)));
}

function initialEditorAssistantWidth(): number {
  const viewportWidth = typeof window === "undefined" ? 0 : window.innerWidth;
  const preferredWidth =
    viewportWidth > 0 ? viewportWidth * 0.24 : EDITOR_ASSISTANT_DEFAULT_WIDTH_PX;
  return clampEditorAssistantWidth(preferredWidth, {
    min: EDITOR_ASSISTANT_MIN_WIDTH_PX,
    max: EDITOR_ASSISTANT_DEFAULT_WIDTH_PX,
  });
}

interface EditorAssistantResizeSeparatorProps {
  readonly width: number;
  readonly maxWidth: number;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

/*
 * A focusable separator with aria-valuenow is an interactive WAI-ARIA separator.
 * jsx-a11y currently classifies every separator as static, so keep this exception
 * local to the one standards-based resize control.
 */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
function EditorAssistantResizeSeparator({
  width,
  maxWidth,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
}: EditorAssistantResizeSeparatorProps) {
  return (
    <div
      className="editor-assistant-resizer"
      role="separator"
      aria-label="调整正文与 AI 创作助手宽度"
      aria-controls="editor-ai-assistant-panel"
      aria-orientation="vertical"
      aria-valuemin={EDITOR_ASSISTANT_MIN_WIDTH_PX}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      aria-valuetext={`AI 创作助手宽度 ${String(width)} 像素`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
    />
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */

interface CandidateRouteSelection {
  readonly candidate: AiCandidate | null;
  readonly notice: string | null;
}

function candidateDefaultStrategy(candidate: AiCandidate): CandidateApplicationStrategy {
  const intent = candidate.applicationIntent;
  if (intent.task === "legacy_full_document") {
    return { kind: "accept_all" };
  }
  switch (intent.application) {
    case "insert_at_cursor":
      return { kind: "insert_at_cursor", cursorUtf16: intent.startUtf16 };
    case "replace_selection":
      return {
        kind: "replace_selection",
        selection: { start: intent.startUtf16, end: intent.endUtf16 },
      };
    case "replace_document":
      return { kind: "overwrite_document" };
  }
}

function materializeCandidateDraft(
  candidate: AiCandidate,
  baseline: ReturnType<ChapterVersion["toSnapshot"]>,
  draft: string,
): string | null {
  const planned = planCandidateApplication({
    baseline: {
      revision: baseline.sequence,
      contentDigest: baseline.contentChecksum,
      content: baseline.content,
    },
    current: {
      revision: baseline.sequence,
      contentDigest: baseline.contentChecksum,
      content: baseline.content,
    },
    candidateContent: draft,
    strategy: candidateDefaultStrategy(candidate),
  });
  return planned.status === "ready" ? planned.plan.resultContent : null;
}

interface CompactEditorLayout {
  readonly compact: boolean;
  readonly revision: number;
}

function useCompactEditorLayout(): CompactEditorLayout {
  const [layout, setLayout] = useState<CompactEditorLayout>(() => ({
    compact:
      typeof window.matchMedia === "function"
        ? window.matchMedia(COMPACT_EDITOR_MEDIA_QUERY).matches
        : false,
    revision: 0,
  }));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(COMPACT_EDITOR_MEDIA_QUERY);
    const update = (): void => {
      setLayout((current) =>
        current.compact === query.matches
          ? current
          : Object.freeze({ compact: query.matches, revision: current.revision + 1 }),
      );
    };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return layout;
}

type StoryStateUpdateNotice =
  | Readonly<{ state: "idle" }>
  | Readonly<{
      state: "ready";
      detectedCount: number;
      needsConfirmationCount: number;
      reversibleCount: number;
      skippedTaskCount: number;
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

function readDirectOpeningOrganizationNotice(state: unknown): string | null {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const organization = (state as Readonly<Record<string, unknown>>).directOpeningOrganization;
  if (typeof organization !== "object" || organization === null || Array.isArray(organization)) {
    return null;
  }
  const value = organization as Readonly<Record<string, unknown>>;
  if (value.kind !== "direct_opening_local_organization") return null;
  if (value.status === "failed") {
    return "正文和版本已保存；本地设定整理暂未完成，可稍后重新整理。";
  }
  if (value.status !== "organized") return null;
  const organizedCount = readBoundedOrganizationCount(value.organizedCount);
  const importantReviewCount = readBoundedOrganizationCount(value.importantReviewCount);
  if (organizedCount === null || importantReviewCount === null) return null;
  return directStoryFactOrganizerNotice({
    organizedCount,
    importantReviewCount,
    alreadyOrganizedCount: 0,
    sourceWasCurrent: true,
  });
}

function readBoundedOrganizationCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 128
    ? value
    : null;
}

function acceptedTextDelta(
  before: string,
  after: string,
): Readonly<{ text: string; startOffset: number; sourceLength: number }> {
  let startOffset = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (startOffset < sharedLength && before[startOffset] === after[startOffset]) {
    startOffset += 1;
  }
  let sharedSuffixLength = 0;
  while (
    sharedSuffixLength < before.length - startOffset &&
    sharedSuffixLength < after.length - startOffset &&
    before[before.length - 1 - sharedSuffixLength] === after[after.length - 1 - sharedSuffixLength]
  ) {
    sharedSuffixLength += 1;
  }
  return Object.freeze({
    text: after.slice(startOffset, after.length - sharedSuffixLength),
    startOffset,
    sourceLength: after.length,
  });
}

export function EditorPage() {
  const runtime = useRuntime();
  const writingExperience = useWritingExperience();
  const directModeAuthorized =
    writingExperience.preference?.mode === "direct" &&
    writingExperience.preference.directLocalOrganizationAuthorizedAt !== null;
  const { resolvedSurface } = useAppearancePreference();
  const online = useOnlineStatus();
  const { compact: compactEditorLayout, revision: editorLayoutRevision } = useCompactEditorLayout();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ projectId: string; chapterId: string }>();
  const [searchParams] = useSearchParams();
  const requestedCandidateId = searchParams.get("candidate");
  const parsedProjectId = parseUuidV7(params.projectId ?? "");
  const parsedChapterId = parseUuidV7(params.chapterId ?? "");
  const projectId = parsedProjectId.ok ? parsedProjectId.value : null;
  const chapterId = parsedChapterId.ok ? parsedChapterId.value : null;
  const editorRouteKey = `${params.projectId ?? ""}/${params.chapterId ?? ""}`;
  const directOpeningRouteNoticeRef = useRef(readDirectOpeningOrganizationNotice(location.state));
  const routeIdentityRef = useRef(editorRouteKey);
  const loadOperationRevisionRef = useRef(0);
  const generationOperationRevisionRef = useRef(0);
  if (routeIdentityRef.current !== editorRouteKey) {
    routeIdentityRef.current = editorRouteKey;
    loadOperationRevisionRef.current += 1;
    generationOperationRevisionRef.current += 1;
  }
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
  const [contextSourcesOpen, setContextSourcesOpen] = useState(false);
  const [versionToRestore, setVersionToRestore] = useState<ChapterVersion | null>(null);
  const [versionRestoreBusy, setVersionRestoreBusy] = useState(false);
  const [candidate, setCandidate] = useState<AiCandidate | null>(null);
  const [candidatePresentation, setCandidatePresentation] = useState<"ai" | "local" | "unknown">(
    "unknown",
  );
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [editorReplacementLocked, setEditorReplacementLocked] = useState(false);
  const [candidateReviewOpen, setCandidateReviewOpen] = useState(false);
  const candidateReviewTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [candidateDiff, setCandidateDiff] = useState<CandidateTextDiff | null>(null);
  const [candidateReviewDraft, setCandidateReviewDraft] = useState("");
  const [candidateReviewComparedContent, setCandidateReviewComparedContent] = useState("");
  const [candidateDiffDecisions, setCandidateDiffDecisions] = useState<
    Readonly<Record<string, AiSuggestionDiffDecision | undefined>>
  >({});
  const [candidateReviewError, setCandidateReviewError] = useState<string | null>(null);
  const [candidateRevisionSaved, setCandidateRevisionSaved] = useState(false);
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
  const directGenerationRequestIdsRef = useRef(new Set<string>());
  const [directGenerationRequestId, setDirectGenerationRequestId] = useState<string | null>(null);
  const [directDisclosure, setDirectDisclosure] = useState<DirectWritingDisclosure | null>(null);
  const [continuationDisclosure, setContinuationDisclosure] =
    useState<ContinuationGenerationDisclosure | null>(null);
  const [directDisclosureSaving, setDirectDisclosureSaving] = useState(false);
  const [generationError, setGenerationError] = useState<unknown>(null);
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
  const [generationStage, setGenerationStage] = useState<GenerationProgressStage>("preparing");
  const [selectionRewriteInstruction, setSelectionRewriteInstruction] =
    useState("保持原意，让表达更自然。");
  const [selectionRewriteBusy, setSelectionRewriteBusy] = useState(false);
  const [selectionRewriteContext, setSelectionRewriteContext] =
    useState<StoryContextCompilationReceipt | null>(null);
  const [selectionRewriteDisclosure, setSelectionRewriteDisclosure] =
    useState<SelectionRewriteDisclosure | null>(null);
  const [lastGenerationAction, setLastGenerationAction] = useState<
    "continuation" | "selection_rewrite"
  >("continuation");
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
  const [editorPreferences, setEditorPreferences] = useState(() =>
    loadEditorPreferences(window.localStorage),
  );
  const [continuationPreference, setContinuationPreference] =
    useState<EditorContinuationPreference>(DEFAULT_EDITOR_CONTINUATION_PREFERENCE);
  const [selectionRequestId, setSelectionRequestId] = useState(0);
  const [selectionLength, setSelectionLength] = useState(0);
  const [chapterListOpen, setChapterListOpen] = useState(true);
  const [chapterDrawerState, setChapterDrawerState] = useState(() => ({
    open: false,
    layoutRevision: editorLayoutRevision,
  }));
  const [assistantState, setAssistantState] = useState(() => ({
    open: !compactEditorLayout,
    layoutRevision: editorLayoutRevision,
  }));
  const [assistantPanelWidth, setAssistantPanelWidth] = useState(initialEditorAssistantWidth);
  const [assistantPanelMaxWidth, setAssistantPanelMaxWidth] = useState(
    EDITOR_ASSISTANT_MAX_WIDTH_PX,
  );
  const chapterDrawerOpen =
    chapterDrawerState.open && chapterDrawerState.layoutRevision === editorLayoutRevision;
  const assistantOpen =
    assistantState.open && assistantState.layoutRevision === editorLayoutRevision;
  const setChapterDrawerOpen = useCallback(
    (open: boolean): void =>
      setChapterDrawerState(Object.freeze({ open, layoutRevision: editorLayoutRevision })),
    [editorLayoutRevision],
  );
  const setAssistantOpen = useCallback(
    (open: boolean): void =>
      setAssistantState(Object.freeze({ open, layoutRevision: editorLayoutRevision })),
    [editorLayoutRevision],
  );
  const [storyStateUpdate, setStoryStateUpdate] = useState<StoryStateUpdateNotice>({
    state: "idle",
  });
  const [privacyChangeTarget, setPrivacyChangeTarget] = useState<ChapterPrivacyMode | null>(null);
  const [privacyChangeBusy, setPrivacyChangeBusy] = useState(false);
  const chapterRef = useRef<Chapter | null>(null);
  const contentRef = useRef("");
  const cursorRef = useRef(0);
  const selectionRef = useRef<EditorSelection>({ start: 0, end: 0 });
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const primaryEditorActionRef = useRef<HTMLButtonElement | null>(null);
  const editorWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const assistantPanelRef = useRef<HTMLElement | null>(null);
  const assistantResizeDragRef = useRef<EditorAssistantResizeDrag | null>(null);
  const selectionRewriteInstructionRef = useRef<HTMLTextAreaElement | null>(null);
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
  const editorReplacementFenceRef = useRef(false);
  const activeGenerationPlanRef = useRef<PreparedGenerationPlan | null>(null);
  const generationEstimate = generationPlan?.preflight.estimate ?? null;
  const returnedFromAiSettings = searchParams.get("aiSettings") === "returned";

  const measureAssistantResizeBounds = useCallback((): EditorAssistantResizeBounds => {
    const workspace = editorWorkspaceRef.current;
    if (workspace === null) {
      return {
        min: EDITOR_ASSISTANT_MIN_WIDTH_PX,
        max: EDITOR_ASSISTANT_MAX_WIDTH_PX,
      };
    }

    const workspaceRect = workspace.getBoundingClientRect();
    const writingCanvas = workspace.querySelector<HTMLElement>(".writing-canvas");
    const writingRect = writingCanvas?.getBoundingClientRect();
    if (workspaceRect.width <= 0 || writingRect === undefined) {
      return {
        min: EDITOR_ASSISTANT_MIN_WIDTH_PX,
        max: EDITOR_ASSISTANT_MAX_WIDTH_PX,
      };
    }

    const parsedColumnGap = Number.parseFloat(window.getComputedStyle(workspace).columnGap);
    const columnGap = Number.isFinite(parsedColumnGap) ? parsedColumnGap : 0;
    const writingOffset = Math.max(0, writingRect.left - workspaceRect.left);
    const availableWidth = Math.floor(
      workspaceRect.width - writingOffset - EDITOR_WRITING_MIN_WIDTH_PX - columnGap,
    );
    return {
      min: EDITOR_ASSISTANT_MIN_WIDTH_PX,
      max: Math.max(
        EDITOR_ASSISTANT_MIN_WIDTH_PX,
        Math.min(EDITOR_ASSISTANT_MAX_WIDTH_PX, availableWidth),
      ),
    };
  }, []);

  function handleAssistantResizePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const bounds = measureAssistantResizeBounds();
    setAssistantPanelMaxWidth(bounds.max);
    const startWidth = clampEditorAssistantWidth(assistantPanelWidth, bounds);
    setAssistantPanelWidth(startWidth);
    assistantResizeDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
  }

  function handleAssistantResizePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = assistantResizeDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;

    const bounds = measureAssistantResizeBounds();
    setAssistantPanelMaxWidth(bounds.max);
    setAssistantPanelWidth(
      clampEditorAssistantWidth(drag.startWidth + drag.startClientX - event.clientX, bounds),
    );
  }

  function finishAssistantResizePointerDrag(event: ReactPointerEvent<HTMLDivElement>): void {
    if (assistantResizeDragRef.current?.pointerId !== event.pointerId) return;

    assistantResizeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleAssistantResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const bounds = measureAssistantResizeBounds();
    const step = event.shiftKey
      ? EDITOR_ASSISTANT_KEYBOARD_LARGE_STEP_PX
      : EDITOR_ASSISTANT_KEYBOARD_STEP_PX;
    let requestedWidth: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        requestedWidth = assistantPanelWidth + step;
        break;
      case "ArrowRight":
        requestedWidth = assistantPanelWidth - step;
        break;
      case "Home":
        requestedWidth = bounds.min;
        break;
      case "End":
        requestedWidth = bounds.max;
        break;
      default:
        return;
    }
    event.preventDefault();
    setAssistantPanelMaxWidth(bounds.max);
    setAssistantPanelWidth(clampEditorAssistantWidth(requestedWidth, bounds));
  }

  useEffect(() => {
    let resetCancelled = false;
    const activePlan = activeGenerationPlanRef.current;
    activeGenerationPlanRef.current = null;
    if (
      activePlan !== null &&
      (activePlan.projectId !== projectId || activePlan.chapterId !== chapterId)
    ) {
      void cancelGenerationPlan(runtime, activePlan).catch(() => undefined);
    }
    queueMicrotask(() => {
      if (resetCancelled) return;
      setGenerationPlan(null);
      setPreflightOpen(false);
      setContextSourcesOpen(false);
      setGenerationError(null);
      setGenerationReceipt(null);
      setGenerationAttemptUsage([]);
      setDeferredGeneration(null);
      setCandidateQualityGate(null);
      setGenerationPreview("");
      setGenerationStage("preparing");
      setCandidateBusy(false);
      setCancelBusy(false);
      setSelectionRewriteBusy(false);
      setSelectionRewriteContext(null);
    });
    return () => {
      resetCancelled = true;
      loadOperationRevisionRef.current += 1;
      generationOperationRevisionRef.current += 1;
      const pendingPlan = activeGenerationPlanRef.current;
      activeGenerationPlanRef.current = null;
      if (pendingPlan !== null) {
        void cancelGenerationPlan(runtime, pendingPlan).catch(() => undefined);
      }
    };
  }, [chapterId, editorRouteKey, projectId, runtime]);

  function beginGenerationOperation(): Readonly<{ revision: number; routeKey: string }> {
    const revision = generationOperationRevisionRef.current + 1;
    generationOperationRevisionRef.current = revision;
    return Object.freeze({ revision, routeKey: editorRouteKey });
  }

  function isCurrentGenerationOperation(
    operation: Readonly<{
      revision: number;
      routeKey: string;
    }>,
  ): boolean {
    return (
      generationOperationRevisionRef.current === operation.revision &&
      routeIdentityRef.current === operation.routeKey
    );
  }

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
    const expectedRouteKey = editorRouteKey;
    const result = await runtime.useCases.listChapterVersions.execute(chapterId);
    if (routeIdentityRef.current === expectedRouteKey && result.ok) {
      setVersions(result.value);
    }
  }, [chapterId, editorRouteKey, runtime]);

  const loadChapters = useCallback(async () => {
    if (projectId === null) {
      return;
    }
    const expectedRouteKey = editorRouteKey;
    const result = await runtime.repositories.chapters.listByProjectId(projectId);
    if (routeIdentityRef.current === expectedRouteKey && result.ok) {
      setChapters(result.value);
    }
  }, [editorRouteKey, projectId, runtime]);

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
      setSelectionRewriteDisclosure(null);
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
    const loadRevision = loadOperationRevisionRef.current + 1;
    loadOperationRevisionRef.current = loadRevision;
    const expectedRouteKey = editorRouteKey;
    const isCurrentLoad = (): boolean =>
      loadOperationRevisionRef.current === loadRevision &&
      routeIdentityRef.current === expectedRouteKey;
    if (chapterId === null || projectId === null) {
      if (isCurrentLoad()) setPageState("fatal_error");
      return;
    }

    setContinuationPreference(loadEditorContinuationPreference(window.localStorage, projectId));
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
    setCandidateRevisionSaved(false);
    setCandidateReviewConflict(null);
    setCandidateCopySaved(false);
    setCandidate(null);
    setCandidatePresentation("unknown");
    setSelectionRewriteBusy(false);
    setSelectionRewriteContext(null);
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

    if (!isCurrentLoad()) {
      return;
    }

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
    let presentation: "ai" | "local" | "unknown" =
      candidateSelection.candidate === null
        ? "unknown"
        : candidateSelection.candidate.toSnapshot().source === "generate"
          ? "unknown"
          : "ai";
    if (candidateSelection.candidate?.toSnapshot().source === "generate") {
      try {
        const [journey, trace] = await Promise.all([
          runtime.creativeJourneys.findById(candidateSelection.candidate.id),
          runtime.contextTraces.findByOutputCandidateId(candidateSelection.candidate.id),
        ]);
        if (!isCurrentLoad()) return;
        if (
          journey?.kind === "idea" &&
          journey.status === "completed" &&
          journey.candidateId === candidateSelection.candidate.id
        ) {
          presentation =
            journey.snapshot.previewSource === "local_fallback"
              ? trace === null
                ? "local"
                : "unknown"
              : journey.snapshot.previewSource === "provider"
                ? "ai"
                : "unknown";
        } else if (trace !== null) {
          presentation = "ai";
        }
      } catch {
        presentation = "unknown";
      }
    }
    setCandidate(candidateSelection.candidate);
    setCandidatePresentation(presentation);

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
    const directOpeningRouteNotice = directOpeningRouteNoticeRef.current;
    directOpeningRouteNoticeRef.current = null;
    setEditorNotice(candidateSelection.notice ?? directOpeningRouteNotice);
    setFindStatus(null);
    setError(null);
    setPageState("ready");
    const continuousState = (runtime.story as Partial<RuntimeStory>).continuousState;
    if (continuousState !== undefined) {
      void continuousState
        .inspectProject(projectId)
        .then((dashboard) => {
          if (isCurrentLoad() && dashboard.detectedCount > 0) {
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
          if (!isCurrentLoad()) return;
          // Story-state review is additive and must never block opening正文.
          globalThis.console.error("[CONTINUOUS_STORY_STATE_DASHBOARD_FAILED]");
        });
    }
  }, [
    chapterId,
    editorRouteKey,
    projectId,
    requestedCandidateId,
    resetEditorHistory,
    runtime,
    scheduleSelection,
  ]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => {
      loadOperationRevisionRef.current += 1;
      clearScheduledPersistence();
    };
  }, [clearScheduledPersistence, load]);

  useEffect(() => {
    if (readDirectOpeningOrganizationNotice(location.state) === null) return;
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

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
    if (!returnedFromAiSettings || pageState !== "ready") {
      return;
    }
    const timeout = window.setTimeout(() => {
      scheduleSelection(selectionRef.current, true, scrollTopRef.current);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [pageState, returnedFromAiSettings, scheduleSelection]);

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

      if (reason !== "manual" || saved.value.version === null) {
        return;
      }

      // Legacy project preferences are not authorization to send正文. A manual
      // save always registers only the local accepted-version refresh.
      const savedVersion = saved.value.version.toSnapshot();
      const pipelineInput: AcceptedChapterPipelineInput = {
        projectId: savedVersion.projectId,
        chapterId: savedVersion.chapterId,
        versionId: savedVersion.id,
        source: "manual_save",
        acceptedCharacterCount: snapshot.length,
        runChapterSummary: false,
        runStoryState: false,
      };

      setStoryStateUpdate({ state: "idle" });

      try {
        // Persist the idempotent recovery task before returning from the save.
        // The accepted text version is already immutable. Any later failure can only
        // affect rebuildable story data, never the author's saved text.
        await ensureAcceptedChapterPipelineTask(runtime, pipelineInput);
      } catch (cause: unknown) {
        const message = projectOrdinaryUiError(cause).description;
        setEditorNotice(`正文已安全保存；${message}`);
        return;
      }

      void runAcceptedChapterPipeline(runtime, pipelineInput)
        .then((receipt) => {
          if (receipt.status === "partially_completed") {
            setEditorNotice("正文已安全保存；部分本地搜索或故事关联暂未更新，可在任务中心重试。");
          }
        })
        .catch((cause: unknown) => {
          const message = projectOrdinaryUiError(cause).description;
          setEditorNotice(`正文已安全保存；本地派生暂未完成：${message}`);
        });
    },
    [loadVersions, runtime],
  );

  const hasPendingPersistence = useCallback((): boolean => {
    const stableChapter = chapterRef.current;
    return (
      composingRef.current ||
      draftTimerRef.current !== null ||
      autosaveTimerRef.current !== null ||
      flushInFlightRef.current !== null ||
      operationQueueRef.current.hasPendingWork() ||
      (stableChapter !== null &&
        pageState === "ready" &&
        project?.status === "active" &&
        contentRef.current !== stableChapter.content)
    );
  }, [pageState, project?.status]);

  const editorPersistenceSettled = useCallback((): boolean => {
    const stableChapter = chapterRef.current;
    return (
      stableChapter !== null &&
      contentRef.current === stableChapter.content &&
      !hasPendingPersistence()
    );
  }, [hasPendingPersistence]);

  const beginEditorReplacement = useCallback((): boolean => {
    if (editorReplacementFenceRef.current || !editorPersistenceSettled()) {
      return false;
    }
    editorReplacementFenceRef.current = true;
    setEditorReplacementLocked(true);
    return true;
  }, [editorPersistenceSettled]);

  const finishEditorReplacement = useCallback((): void => {
    editorReplacementFenceRef.current = false;
    setEditorReplacementLocked(false);
  }, []);

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
    const reloadPreferences = (): void => {
      setEditorPreferences(loadEditorPreferences(window.localStorage));
    };
    const reloadTypography = (): void => {
      const next = loadEditorTypography(window.localStorage);
      typographyRef.current = next;
      setTypography(next);
    };
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === EDITOR_PREFERENCES_STORAGE_KEY) reloadPreferences();
    };
    window.addEventListener(EDITOR_PREFERENCES_CHANGED_EVENT, reloadPreferences);
    window.addEventListener(EDITOR_TYPOGRAPHY_CHANGED_EVENT, reloadTypography);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(EDITOR_PREFERENCES_CHANGED_EVENT, reloadPreferences);
      window.removeEventListener(EDITOR_TYPOGRAPHY_CHANGED_EVENT, reloadTypography);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    if (!compactEditorLayout || !assistantOpen) return undefined;
    const panel = assistantPanelRef.current;
    if (panel === null) return undefined;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    const backgroundState: {
      readonly element: HTMLElement;
      readonly inert: boolean;
      readonly ariaHidden: string | null;
    }[] = [];
    let current: HTMLElement = panel;
    while (current.parentElement !== null && current !== document.body) {
      const parent = current.parentElement;
      Array.from(parent.children).forEach((sibling) => {
        if (
          sibling instanceof HTMLElement &&
          sibling !== current &&
          !sibling.classList.contains("editor-assistant-backdrop")
        ) {
          backgroundState.push({
            element: sibling,
            inert: sibling.inert,
            ariaHidden: sibling.getAttribute("aria-hidden"),
          });
          sibling.inert = true;
          sibling.setAttribute("aria-hidden", "true");
        }
      });
      current = parent;
    }
    document.body.style.overflow = "hidden";
    (compactAssistantFocusableElements(panel)[0] ?? panel).focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent): void => {
      const nestedDialog = document.querySelector<HTMLElement>('.ink-overlay [role="dialog"]');
      if (nestedDialog !== null) return;

      if (event.key === "Escape") {
        event.preventDefault();
        setAssistantOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = compactAssistantFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last?.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      backgroundState.forEach(({ ariaHidden, element, inert }) => {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", ariaHidden);
        }
      });
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [assistantOpen, compactEditorLayout, setAssistantOpen]);

  useEffect(() => {
    if (compactEditorLayout || !assistantOpen) {
      assistantResizeDragRef.current = null;
      return undefined;
    }

    const updateBounds = (): void => {
      const bounds = measureAssistantResizeBounds();
      setAssistantPanelMaxWidth(bounds.max);
      setAssistantPanelWidth((current) => clampEditorAssistantWidth(current, bounds));
    };
    updateBounds();
    window.addEventListener("resize", updateBounds);
    const resizeObserver =
      typeof ResizeObserver === "function" && editorWorkspaceRef.current !== null
        ? new ResizeObserver(updateBounds)
        : null;
    if (resizeObserver !== null && editorWorkspaceRef.current !== null) {
      resizeObserver.observe(editorWorkspaceRef.current);
    }
    return () => {
      window.removeEventListener("resize", updateBounds);
      resizeObserver?.disconnect();
    };
  }, [
    assistantOpen,
    chapterListOpen,
    compactEditorLayout,
    measureAssistantResizeBounds,
    pageState,
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
    if (editorPreferences.autosaveEnabled) {
      autosaveTimerRef.current = window.setTimeout(() => {
        autosaveTimerRef.current = null;
        void enqueue(() => commitSnapshot(snapshot, cursorOffset, "autosave")).catch(
          () => undefined,
        );
      }, editorPreferences.autosaveDebounceMs);
    }

    return () => {
      clearScheduledPersistence();
    };
  }, [
    clearScheduledPersistence,
    commitSnapshot,
    content,
    editorPreferences,
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

  useEffect(() => {
    if (!candidateReviewOpen) {
      return;
    }
    let frame = 0;
    let settleFrame = 0;
    const fitTextarea = (): void => {
      const textarea = candidateReviewTextareaRef.current;
      if (textarea === null) {
        return;
      }
      textarea.style.height = "auto";
      if (textarea.scrollHeight > 0) {
        const computed = window.getComputedStyle(textarea);
        const borderHeight =
          computed.boxSizing === "border-box"
            ? Number.parseFloat(computed.borderTopWidth) +
              Number.parseFloat(computed.borderBottomWidth)
            : 0;
        textarea.style.height = `${String(Math.ceil(textarea.scrollHeight + borderHeight + 4))}px`;
      }
    };
    const scheduleFit = (): void => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
      frame = window.requestAnimationFrame(() => {
        fitTextarea();
        settleFrame = window.requestAnimationFrame(fitTextarea);
      });
    };
    scheduleFit();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleFit();
          });
    const reviewScroller = candidateReviewTextareaRef.current?.closest(".ink-overlay__content");
    if (reviewScroller instanceof HTMLElement) resizeObserver?.observe(reviewScroller);
    window.addEventListener("resize", scheduleFit);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleFit);
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(settleFrame);
    };
  }, [candidateReviewDraft, candidateReviewOpen]);

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
      privacyMode: stableChapter.privacyMode,
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
    if (editorReplacementFenceRef.current) {
      return;
    }
    contentRef.current = nextContent;
    selectionRef.current = selection;
    cursorRef.current = selection.start;
    setSelectionLength(Math.max(0, selection.end - selection.start));
    setSelectionRewriteDisclosure(null);
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
    if (editorReplacementFenceRef.current) {
      event.preventDefault();
      return;
    }
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
    if (editorReplacementFenceRef.current) {
      event.currentTarget.value = contentRef.current;
      return;
    }
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
    if (editorReplacementFenceRef.current) {
      event.preventDefault();
      return;
    }
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
    if (editorReplacementFenceRef.current) {
      compositionBaseRef.current = null;
      composingRef.current = false;
      setIsComposing(false);
      event.currentTarget.value = contentRef.current;
      return;
    }
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
    setSelectionRewriteDisclosure(null);
    setContent(finalContent);
    setRecovered(false);
    setSaveState("dirty");
    composingRef.current = false;
    setIsComposing(false);
    persistEditorView(selectionAfter);
  }

  function handleEditorPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    if (project?.status !== "active" || editorReplacementFenceRef.current) {
      if (editorReplacementFenceRef.current) event.preventDefault();
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

  function updateContinuationPreference(next: EditorContinuationPreference): void {
    setContinuationPreference(next);
    if (projectId !== null) {
      saveEditorContinuationPreference(window.localStorage, projectId, next);
    }
  }

  async function generateCandidate(partialCandidateId: UuidV7 | null = null): Promise<void> {
    if (chapterId === null || saveState === "dirty" || saveState === "saving") {
      return;
    }
    const directAtStart = directModeAuthorized;
    const operation = beginGenerationOperation();
    setLastGenerationAction("continuation");
    setSelectionRewriteContext(null);
    setContinuationDisclosure(null);
    setDirectDisclosure(null);
    setCandidateBusy(true);
    setGenerationStage("preparing");
    setError(null);
    setGenerationError(null);
    setGenerationReceipt(null);
    setGenerationAttemptUsage([]);
    try {
      const plan = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: editorClean,
        networkAvailable: online,
        cursorUtf16: directAtStart
          ? contentRef.current.length
          : normalizeEditorSelection(selectionRef.current, contentRef.current.length).start,
        outputProfile: directAtStart ? "standard" : continuationPreference.profile,
        customTargetVisibleCharacters: directAtStart
          ? null
          : continuationPreference.customTargetVisibleCharacters,
        destination: directAtStart ? "complete_scene" : continuationPreference.destination,
        customDestinationInstruction: directAtStart
          ? null
          : continuationPreference.customDestinationInstruction,
        contextBudgetProfile: directAtStart
          ? "standard"
          : continuationPreference.profile === "long"
            ? "long"
            : continuationPreference.profile === "short"
              ? "economy"
              : "standard",
        ...(partialCandidateId === null ? {} : { partialCandidateId }),
      });
      if (!isCurrentGenerationOperation(operation)) return;
      setGenerationPlan(plan);
      if (directAtStart) directGenerationRequestIdsRef.current.add(plan.requestId);
      setDirectGenerationRequestId(directAtStart ? plan.requestId : null);
      const continuationActionDisclosure = await prepareContinuationGenerationDisclosure(
        runtime,
        plan,
      );
      const disclosure = directAtStart ? await projectDirectWritingDisclosure(runtime, plan) : null;
      if (!isCurrentGenerationOperation(operation)) return;
      setContinuationDisclosure(continuationActionDisclosure);
      setDirectDisclosure(disclosure);
      setDeferredGeneration(plan.deferredRequest);
      await loadBudgetForm(plan, () => isCurrentGenerationOperation(operation));
      if (!isCurrentGenerationOperation(operation)) return;
      const grant =
        disclosure === null
          ? null
          : await runtime.writingExperience.findDisclosureGrant(disclosure.input.fingerprint);
      if (!isCurrentGenerationOperation(operation)) return;
      const providerAuthorityReady =
        continuationActionDisclosure === null ||
        (directAtStart && disclosure !== null && disclosureGrantMatches(disclosure, grant));
      if (
        plan.preflight.canStart &&
        !plan.preflight.requiresConfirmation &&
        providerAuthorityReady
      ) {
        await executePreparedGeneration(plan, operation);
      } else {
        setPreflightOpen(true);
      }
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) setGenerationError(cause);
    } finally {
      if (isCurrentGenerationOperation(operation)) setCandidateBusy(false);
    }
  }

  async function rewriteSelectedText(): Promise<void> {
    const stableChapter = chapterRef.current;
    if (
      stableChapter === null ||
      runtime.mode !== "tauri" ||
      !editorClean ||
      candidateBusy ||
      !canGenerateCandidate ||
      contentRef.current !== stableChapter.content
    ) {
      return;
    }
    const selection = normalizeEditorSelection(selectionRef.current, stableChapter.content.length);
    if (selection.start === selection.end) {
      setGenerationError(
        new UiActionError(
          "SELECTION_REWRITE_RANGE_INVALID",
          "请先在正文中选择要修改的文字，再从 AI 创作助手开始改写。",
          "尚未选择正文",
        ),
      );
      return;
    }
    const operation = beginGenerationOperation();

    setLastGenerationAction("selection_rewrite");
    setSelectionRewriteBusy(true);
    setCandidateBusy(true);
    setGenerationPlan(null);
    setSelectionRewriteContext(null);
    setGenerationPreview("");
    setGenerationReceipt(null);
    setGenerationAttemptUsage([]);
    setCandidateQualityGate(null);
    setError(null);
    setGenerationError(null);
    try {
      const selectedText = stableChapter.content.slice(selection.start, selection.end);
      const selectedHash = await runtime.hasher.sha256(selectedText);
      if (!selectedHash.ok) {
        throw selectedHash.error;
      }
      if (!isCurrentGenerationOperation(operation)) return;
      if (selectionRewriteDisclosure === null) {
        const disclosure = await prepareSelectionRewrite(runtime, {
          chapterId: stableChapter.id,
          baseVersionId: stableChapter.currentVersionId,
          selection: {
            startUtf16: selection.start,
            endUtf16: selection.end,
            selectedTextSha256: selectedHash.value,
          },
          instruction: selectionRewriteInstruction,
        });
        if (!isCurrentGenerationOperation(operation)) return;
        setSelectionRewriteDisclosure(disclosure);
        setEditorNotice("发送信息已准备好；确认前不会调用 AI。请核对后再继续。");
        return;
      }
      const result = await createSelectionRewriteCandidate(runtime, {
        chapterId: stableChapter.id,
        baseVersionId: stableChapter.currentVersionId,
        selection: {
          startUtf16: selection.start,
          endUtf16: selection.end,
          selectedTextSha256: selectedHash.value,
        },
        instruction: selectionRewriteInstruction,
        disclosureFingerprint: selectionRewriteDisclosure.fingerprint,
        humanConfirmed: true,
        onDelta: (next) => {
          if (isCurrentGenerationOperation(operation)) setGenerationPreview(next);
        },
      });
      if (!isCurrentGenerationOperation(operation)) return;
      setSelectionRewriteDisclosure(null);
      const previousCandidate = candidate;
      setCandidate(result.candidate);
      setSelectionRewriteContext(result.contextCompilation);
      setEditorNotice(
        `已生成 ${String(result.rewrittenSelection.length)} 个字符的选区改写建议。正文尚未改变，请先比较再决定是否创建新版本。`,
      );
      if (
        previousCandidate !== null &&
        (previousCandidate.status === "accepted" || previousCandidate.status === "rejected")
      ) {
        await recordWritingFeedbackSafely({
          action: "regenerated",
          candidateId: previousCandidate.id,
        });
      }
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) {
        setSelectionRewriteDisclosure(null);
        setGenerationError(selectionRewriteUiError(cause));
      }
    } finally {
      if (isCurrentGenerationOperation(operation)) {
        setSelectionRewriteBusy(false);
        setCandidateBusy(false);
        setGenerationPreview("");
      }
    }
  }

  async function loadBudgetForm(
    plan: PreparedGenerationPlan,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (!isCurrent()) return;
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
    if (!isCurrent()) return;
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
    const estimate = generationPlan?.preflight.estimate ?? null;
    if (!generationPlan?.projectId || estimate === null || chapterId === null) {
      return;
    }
    const operation = beginGenerationOperation();
    const plan = generationPlan;
    const directPlan = directGenerationRequestIdsRef.current.has(plan.requestId);
    setBudgetSaving(true);
    setError(null);
    try {
      const currency = estimate.currency;
      const monthKey = plan.preflight.checkedAt.slice(0, 7);
      const projectPolicy = budgetPolicies.find(({ scope }) => scope === "project");
      const monthPolicy = budgetPolicies.find(({ scope }) => scope === "month");
      const writes: Promise<GenerationBudgetPolicy>[] = [];
      if (projectBudgetAmount.trim().length > 0) {
        writes.push(
          runtime.generationGovernance.saveBudgetPolicy({
            scope: "project",
            projectId: plan.projectId,
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
      if (!isCurrentGenerationOperation(operation)) return;
      const refreshed = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: editorClean,
        networkAvailable: online,
        cursorUtf16: plan.applicationCursorUtf16,
        outputProfile: plan.outputContract.profile,
        customTargetVisibleCharacters:
          plan.outputContract.profile === "custom"
            ? plan.outputContract.targetVisibleCharacters
            : null,
        destination: plan.outputContract.destination,
        customDestinationInstruction: plan.outputContract.customDestinationInstruction,
        contextBudgetProfile: plan.contextBudget.profile,
        customContextBudget:
          plan.contextBudget.profile === "custom" ? plan.contextBudget.taskProfileLimit : null,
        ...(plan.partialCandidateId === null
          ? {}
          : { partialCandidateId: plan.partialCandidateId }),
      });
      if (!isCurrentGenerationOperation(operation)) return;
      setGenerationPlan(refreshed);
      if (directPlan) {
        directGenerationRequestIdsRef.current.delete(plan.requestId);
        directGenerationRequestIdsRef.current.add(refreshed.requestId);
        setDirectGenerationRequestId(refreshed.requestId);
      }
      const refreshedContinuationDisclosure = await prepareContinuationGenerationDisclosure(
        runtime,
        refreshed,
      );
      if (!isCurrentGenerationOperation(operation)) return;
      setContinuationDisclosure(refreshedContinuationDisclosure);
      setDirectDisclosure(
        directPlan ? await projectDirectWritingDisclosure(runtime, refreshed) : null,
      );
      if (!isCurrentGenerationOperation(operation)) return;
      await loadBudgetForm(refreshed, () => isCurrentGenerationOperation(operation));
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) setError(cause);
    } finally {
      if (isCurrentGenerationOperation(operation)) setBudgetSaving(false);
    }
  }

  async function executePreparedGeneration(
    plan: PreparedGenerationPlan,
    existingOperation?: Readonly<{ revision: number; routeKey: string }>,
  ): Promise<void> {
    const operation = existingOperation ?? beginGenerationOperation();
    if (
      !plan.preflight.canStart ||
      plan.projectId !== projectId ||
      plan.chapterId !== chapterId ||
      !isCurrentGenerationOperation(operation)
    ) {
      return;
    }
    setPreflightOpen(false);
    setCandidateBusy(true);
    setGenerationStage("generating");
    setGenerationPreview("");
    setError(null);
    setGenerationError(null);
    activeGenerationPlanRef.current = plan;
    try {
      const directExecution = directGenerationRequestIdsRef.current.has(plan.requestId);
      if (directExecution) {
        const currentAuthority = await runtime.writingExperience.getOrInitialize();
        if (
          currentAuthority.mode !== "direct" ||
          currentAuthority.directLocalOrganizationAuthorizedAt === null
        ) {
          setGenerationError(
            new Error("直接模式授权已经撤销；本次没有调用 AI，正文和版本保持不变。"),
          );
          return;
        }
      }
      const result = await executeGenerationPlan(
        runtime,
        plan,
        (next) => {
          if (isCurrentGenerationOperation(operation)) setGenerationPreview(next);
        },
        { generationRetryLimit: 0 },
      );
      if (!isCurrentGenerationOperation(operation)) return;
      setGenerationStage("finalizing");
      if (plan.deferredRequest !== null) {
        const deferred = await runtime.generationGovernance.findWaitingDeferredRequest(
          plan.chapterId,
          plan.modelRole,
        );
        if (!isCurrentGenerationOperation(operation)) return;
        setDeferredGeneration(deferred);
      }
      if (!result.ok) {
        setGenerationError(result.error);
        return;
      }
      const previousCandidate = candidate;
      if (result.value.candidate !== null) setCandidate(result.value.candidate);
      setCandidateQualityGate(result.value.qualityGate);
      if (
        projectId !== null &&
        result.value.candidate !== null &&
        previousCandidate !== null &&
        (previousCandidate.status === "accepted" || previousCandidate.status === "rejected")
      ) {
        await recordWritingFeedbackSafely({
          action: "regenerated",
          candidateId: previousCandidate.id,
        });
        if (!isCurrentGenerationOperation(operation)) return;
      }
      const [receipt, usage] = await Promise.all([
        runtime.generationGovernance.findRunById(result.value.runId),
        runtime.generationGovernance.listAttemptUsage(result.value.runId),
      ]);
      if (!isCurrentGenerationOperation(operation)) return;
      setGenerationReceipt(receipt);
      setGenerationAttemptUsage(usage);
      setError(null);
      setGenerationError(null);
      if (result.value.candidate?.status === "ready") {
        setEditorNotice(
          result.value.candidate.toSnapshot().incomplete || result.value.incomplete
            ? "本次结果未完整结束，已保留为隔离的 AI 建议草稿；正文和版本没有改变。"
            : "建议已生成并保持隔离；正文和版本没有改变，请查看后决定是否使用。",
        );
      }
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) setGenerationError(cause);
    } finally {
      if (activeGenerationPlanRef.current === plan) {
        activeGenerationPlanRef.current = null;
      }
      if (isCurrentGenerationOperation(operation)) {
        directGenerationRequestIdsRef.current.delete(plan.requestId);
        setDirectGenerationRequestId((current) => (current === plan.requestId ? null : current));
        setCandidateBusy(false);
        setCancelBusy(false);
        setGenerationPreview("");
        setGenerationStage("preparing");
      }
    }
  }

  async function confirmGeneration(): Promise<void> {
    if (generationPlan === null) {
      return;
    }
    const plan = generationPlan;
    setDirectDisclosureSaving(true);
    try {
      const currentDisclosure = await prepareContinuationGenerationDisclosure(runtime, plan);
      assertContinuationDisclosureMatches(continuationDisclosure, currentDisclosure);
      setContinuationDisclosure(currentDisclosure);
    } catch (cause: unknown) {
      setGenerationError(cause);
      return;
    } finally {
      setDirectDisclosureSaving(false);
    }
    if (directGenerationRequestIdsRef.current.has(plan.requestId)) {
      setDirectDisclosureSaving(true);
      try {
        const currentAuthority = await runtime.writingExperience.getOrInitialize();
        if (
          currentAuthority.mode !== "direct" ||
          currentAuthority.directLocalOrganizationAuthorizedAt === null
        ) {
          setGenerationError(
            new Error("直接模式授权已经撤销；本次没有调用 AI，正文和版本保持不变。"),
          );
          return;
        }
        const disclosure = await projectDirectWritingDisclosure(runtime, plan);
        setDirectDisclosure(disclosure);
        if (disclosure !== null) {
          const existing = await runtime.writingExperience.findDisclosureGrant(
            disclosure.input.fingerprint,
          );
          if (!disclosureGrantMatches(disclosure, existing)) {
            await runtime.writingExperience.recordDisclosureGrant(disclosure.input);
          }
        }
      } catch (cause: unknown) {
        setGenerationError(cause);
        return;
      } finally {
        setDirectDisclosureSaving(false);
      }
    }
    await executePreparedGeneration(plan);
  }

  function closePreflightAndFocusEditor(): void {
    const selection = normalizeEditorSelection(selectionRef.current, contentRef.current.length);
    persistEditorView(selection);
    if (generationPlan !== null) {
      directGenerationRequestIdsRef.current.delete(generationPlan.requestId);
    }
    setDirectGenerationRequestId(null);
    setDirectDisclosure(null);
    setContinuationDisclosure(null);
    setPreflightOpen(false);
    window.requestAnimationFrame(() => {
      scheduleSelection(selection, true, scrollTopRef.current);
    });
  }

  async function saveAndClosePreflight(): Promise<void> {
    if (!editorClean) {
      await manualSave();
    }
    closePreflightAndFocusEditor();
  }

  function preflightModelHubLink(
    targetSection: "provider-connection" | "model-selection" | "model-pricing",
  ): string {
    if (projectId === null || chapterId === null) {
      return "/settings#model-center";
    }
    const returnRoute = `/projects/${projectId}/chapters/${chapterId}?aiSettings=returned`;
    const query = new URLSearchParams({
      connectionId: generationPlan?.providerId ?? "",
      modelId: generationPlan?.modelId ?? "",
      targetSection,
      returnRoute,
    });
    return `/settings?${query.toString()}#model-center`;
  }

  async function deferGenerationUntilOnline(): Promise<void> {
    if (generationPlan === null || !canDeferGenerationPlan(generationPlan)) {
      return;
    }
    const operation = beginGenerationOperation();
    const plan = generationPlan;
    setCandidateBusy(true);
    setError(null);
    try {
      const deferred = await saveDeferredGenerationPlan(runtime, plan);
      if (!isCurrentGenerationOperation(operation)) return;
      setDeferredGeneration(deferred);
      setGenerationPlan(Object.freeze({ ...plan, deferredRequest: deferred }));
      setPreflightOpen(false);
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) setError(cause);
    } finally {
      if (isCurrentGenerationOperation(operation)) setCandidateBusy(false);
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
      setGenerationError(cause);
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
    setCandidateRevisionSaved(false);
    setCandidateReviewConflict(null);
    setCandidateCopySaved(false);
    setCandidateDiff(null);
    setCandidateReviewDraft(candidate.content);
    setCandidateReviewComparedContent(candidate.content);
    if (baseVersion === undefined) {
      setCandidateReviewError(
        `${candidateSuggestionLabel}所依据的稳定版本已经不可用；为避免覆盖正文，当前不能接受这份建议。`,
      );
      setCandidateReviewOpen(true);
      return;
    }
    const baseline = baseVersion.toSnapshot();
    const materialized = materializeCandidateDraft(candidate, baseline, candidate.content);
    if (materialized === null) {
      setCandidateReviewError(
        `${candidateSuggestionLabel}的应用位置已失效；为避免改错位置，当前不能接受这份建议。`,
      );
      setCandidateReviewOpen(true);
      return;
    }
    const diff = diffCandidateContent(baseline.content, materialized);
    if (diff.status === "error") {
      setCandidateReviewError(projectOrdinaryUiError(diff.error).description);
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

  function handleCandidateReviewNavigation(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const scrollContainer = event.currentTarget.closest(".ink-overlay__content");
    if (!scrollContainer?.classList.contains("ink-overlay__content")) {
      return;
    }
    const pageDistance = Math.max(1, Math.floor(scrollContainer.clientHeight * 0.85));
    if (event.key === "PageDown") {
      event.preventDefault();
      scrollContainer.scrollTop += pageDistance;
    } else if (event.key === "PageUp") {
      event.preventDefault();
      scrollContainer.scrollTop -= pageDistance;
    } else if (event.key === "Home") {
      event.preventDefault();
      scrollContainer.scrollTop = 0;
    } else if (event.key === "End") {
      event.preventDefault();
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }

  function dismissCandidateReview(): void {
    setCandidateReviewOpen(false);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLElement &&
          activeElement !== document.body &&
          activeElement.isConnected
        ) {
          return;
        }
        primaryEditorActionRef.current?.focus({ preventScroll: true });
      });
    });
  }

  function compareEditedCandidate(): void {
    if (candidate?.status !== "ready" || chapter === null) return;
    const baseVersion =
      candidate.baseVersionId === null
        ? undefined
        : versions.find((version) => version.id === candidate.baseVersionId);
    if (baseVersion === undefined) {
      setCandidateDiff(null);
      setCandidateReviewError(
        `${candidateSuggestionLabel}所依据的稳定版本已经不可用；为避免覆盖正文，当前不能接受这份建议。`,
      );
      return;
    }
    const baseline = baseVersion.toSnapshot();
    const materialized = materializeCandidateDraft(candidate, baseline, candidateReviewDraft);
    if (materialized === null) {
      setCandidateDiff(null);
      setCandidateReviewError(
        `${candidateSuggestionLabel}的应用位置已失效；为避免改错位置，当前不能接受这份建议。`,
      );
      return;
    }
    const diff = diffCandidateContent(baseline.content, materialized);
    setCandidateDiffDecisions({});
    setCandidateReviewComparedContent(candidateReviewDraft);
    if (diff.status === "error") {
      setCandidateDiff(null);
      setCandidateReviewError(projectOrdinaryUiError(diff.error).description);
      return;
    }
    setCandidateReviewError(null);
    setCandidateDiff(diff.diff);
  }

  async function saveCandidateRevision(): Promise<void> {
    if (
      candidate?.status !== "ready" ||
      !candidateReviewDraftValid ||
      candidateReviewDraft === candidate.content
    ) {
      return;
    }
    setCandidateBusy(true);
    setError(null);
    const result = await runtime.useCases.reviseCandidate.execute({
      candidateId: candidate.id,
      expectedCandidateRevision: candidate.revision,
      content: candidateReviewDraft,
    });
    setCandidateBusy(false);
    if (!result.ok) {
      setError(result.error);
      setCandidateReviewError(projectOrdinaryUiError(result.error).description);
      return;
    }
    setCandidate(result.value);
    setCandidateReviewError(null);
    setCandidateRevisionSaved(true);
    setEditorNotice(
      `建议修改已保存在本机，仍是隔离的${candidateSuggestionLabel}；稳定正文没有改变。`,
    );
  }

  async function acceptCandidate(
    strategy: CandidateApplicationStrategy,
    candidateOverride: AiCandidate | null = candidate,
  ): Promise<boolean> {
    if (candidateOverride?.status !== "ready") {
      return false;
    }
    if (!beginEditorReplacement()) {
      setEditorNotice(
        "正文仍有尚未完成的本地保存；这份 AI 建议草稿继续保持隔离，没有写入正文或创建版本。",
      );
      return false;
    }
    try {
      return await acceptCandidateWhileEditorLocked(strategy, candidateOverride);
    } finally {
      setCandidateBusy(false);
      finishEditorReplacement();
    }
  }

  async function acceptCandidateWhileEditorLocked(
    strategy: CandidateApplicationStrategy,
    candidateOverride: AiCandidate,
  ): Promise<boolean> {
    const editedContent =
      candidateOverride.id === candidate?.id ? candidateReviewDraft : candidateOverride.content;
    const contentBeforeAcceptance = contentRef.current;
    setCandidateBusy(true);
    const result = await runtime.useCases.acceptCandidate.execute({
      candidateId: candidateOverride.id,
      expectedCandidateRevision: candidateOverride.revision,
      strategy,
      ...(editedContent === candidateOverride.content ? {} : { editedContent }),
    });
    if (!result.ok) {
      setError(result.error);
      setCandidateReviewError(projectOrdinaryUiError(result.error).description);
      return false;
    }
    const acceptedVersion = result.value.version.toSnapshot();
    const nextContent = result.value.chapter.content;
    const acceptedDelta = acceptedTextDelta(contentBeforeAcceptance, nextContent);
    const pipelineInput: AcceptedChapterPipelineInput = createLocalCandidateAcceptancePipelineInput(
      {
        projectId: acceptedVersion.projectId,
        chapterId: acceptedVersion.chapterId,
        versionId: acceptedVersion.id,
        acceptedCharacterCount: nextContent.length,
      },
    );
    let pipelineRegistrationError: string | null = null;
    if (runtime.mode !== "tauri") {
      try {
        // Browser development has no SQLite commit hook, so it registers the
        // same idempotent task here. Tauri already created this task inside the
        // acceptance transaction and must not make the foreground wait for a
        // second database round trip after the正文 commit has returned.
        await ensureAcceptedChapterPipelineTask(runtime, pipelineInput);
      } catch (cause: unknown) {
        pipelineRegistrationError = projectOrdinaryUiError(cause).description;
      }
    }
    setCandidate(result.value.candidate);
    setChapter(result.value.chapter);
    chapterRef.current = result.value.chapter;
    setVersions((current) =>
      current.some((version) => version.id === result.value.version.id)
        ? current
        : [...current, result.value.version],
    );
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
    setCandidateReviewDraft("");
    setCandidateReviewComparedContent("");
    setCandidateDiffDecisions({});
    setCandidateReviewError(null);
    setCandidateRevisionSaved(false);
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
    void recordWritingFeedbackSafely({
      action:
        strategy.kind === "apply_changes" && (rejectedChangeCount ?? 0) > 0
          ? "partially_accepted"
          : "accepted",
      candidateId: result.value.candidate.id,
      applicationStrategy: strategy.kind,
      acceptedChangeCount,
      rejectedChangeCount,
    });
    if (pipelineRegistrationError !== null) {
      setStoryStateUpdate({ state: "idle" });
      setEditorNotice(
        `${candidateSuggestionLabel}已安全写入正文和不可变版本；本地搜索与故事关联任务登记失败：${pipelineRegistrationError}`,
      );
      void loadVersions();
      return true;
    }
    setStoryStateUpdate({ state: "idle" });
    void runAcceptedChapterPipeline(runtime, pipelineInput)
      .then((receipt) => {
        if (receipt.status === "partially_completed") {
          setEditorNotice(
            `${candidateSuggestionLabel}已安全写入新版本；部分本地搜索或故事关联暂未更新，可在任务中心重试。`,
          );
        }
      })
      .catch((cause: unknown) => {
        const message = projectOrdinaryUiError(cause).description;
        setEditorNotice(
          `${candidateSuggestionLabel}已安全写入正文和不可变版本；本地派生暂未完成：${message}`,
        );
      });
    setEditorNotice(
      strategy.kind === "apply_changes"
        ? "已按逐项决定创建新的稳定版本；可在本次会话撤销，原稳定版本仍保留在版本历史。"
        : `${candidateSuggestionLabel}已按所选方式写入新的稳定版本；原稳定版本仍保留在版本历史。`,
    );
    if (
      candidateOverride.toSnapshot().source === "generate" &&
      !candidateOverride.toSnapshot().incomplete &&
      acceptedDelta.text.length > 0
    ) {
      void runtime.writingExperience
        .getOrInitialize()
        .then((preference) => {
          if (
            preference.mode !== "direct" ||
            preference.directLocalOrganizationAuthorizedAt === null
          ) {
            return null;
          }
          return organizeDirectStoryFacts(
            {
              facts: runtime.story.facts,
              factService: runtime.story.factService,
              hasher: runtime.hasher,
              now: () => runtime.clock.now(),
            },
            {
              projectId: acceptedVersion.projectId,
              chapterId: acceptedVersion.chapterId,
              versionId: acceptedVersion.id,
              versionCreatedAt: acceptedVersion.createdAt,
              acceptedText: acceptedDelta.text,
              acceptedStartOffset: acceptedDelta.startOffset,
              sourceLength: acceptedDelta.sourceLength,
              currentVersionId: result.value.chapter.currentVersionId,
              localOnly: result.value.chapter.isLocalOnly,
            },
          );
        })
        .then((receipt) => {
          if (receipt !== null) setEditorNotice(directStoryFactOrganizerNotice(receipt));
        })
        .catch(() => {
          setEditorNotice("正文和版本已保存；本地设定整理暂未完成，可稍后重新整理。");
        });
    }
    void loadVersions();
    return true;
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
    const copyTitle = `${chapter.title.slice(0, 190)}（${candidateSuggestionLabel}副本）`;
    const baseVersion =
      candidate.baseVersionId === null
        ? undefined
        : versions.find((version) => version.id === candidate.baseVersionId);
    const copyContent =
      baseVersion === undefined
        ? null
        : materializeCandidateDraft(
            candidate,
            baseVersion.toSnapshot(),
            candidateReviewDraft || candidate.content,
          );
    if (copyContent === null) {
      setCandidateBusy(false);
      const message = `${candidateSuggestionLabel}的原始应用位置已失效，无法安全另存完整草稿。`;
      setCandidateReviewError(message);
      setError(new Error(message));
      return;
    }
    const created = await runtime.useCases.createChapter.execute({
      projectId,
      title: copyTitle,
      content: copyContent,
      privacyMode: chapter.privacyMode,
    });
    setCandidateBusy(false);
    if (!created.ok) {
      setError(created.error);
      setCandidateReviewError(projectOrdinaryUiError(created.error).description);
      return;
    }
    await loadChapters();
    setCandidateCopySaved(true);
    setError(null);
    setEditorNotice(
      `${candidateSuggestionLabel}已另存为新章节“${copyTitle}”，当前稳定正文和建议记录均未改变。`,
    );
  }

  async function restoreSelectedVersion(): Promise<void> {
    const selected = versionToRestore;
    const stableChapter = chapterRef.current;
    if (
      selected === null ||
      stableChapter === null ||
      project?.status !== "active" ||
      selected.toSnapshot().content === stableChapter.content
    ) {
      return;
    }
    if (!beginEditorReplacement()) {
      setEditorNotice("正文仍有尚未完成的本地保存；当前没有恢复版本，正文和历史版本均未改变。");
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
      void runAcceptedChapterPipeline(runtime, {
        projectId: result.value.chapter.projectId,
        chapterId: result.value.chapter.id,
        versionId: result.value.version.id,
        source: "version_restore",
        acceptedCharacterCount: result.value.chapter.content.length,
        runChapterSummary: false,
        runStoryState: false,
      }).catch(() => {
        setEditorNotice("恢复版本与正文已安全保存；故事资料整理暂未完成，可在任务与通知中重试。");
      });
      await recordWritingFeedbackSafely({ action: "restored_original", candidateId: null });
      await loadVersions();
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setVersionRestoreBusy(false);
      finishEditorReplacement();
    }
  }

  async function rejectCandidate(): Promise<boolean> {
    if (candidate?.status !== "ready") {
      return false;
    }
    setCandidateBusy(true);
    const result = await runtime.useCases.rejectCandidate.execute({
      candidateId: candidate.id,
      expectedCandidateRevision: candidate.revision,
    });
    setCandidateBusy(false);
    if (!result.ok) {
      setError(result.error);
      if (candidateReviewOpen) {
        setCandidateReviewError(projectOrdinaryUiError(result.error).description);
      }
      return false;
    }
    setCandidate(result.value);
    setCandidateCopySaved(false);
    setError(null);
    await recordWritingFeedbackSafely({
      action: "rejected",
      candidateId: result.value.id,
    });
    return true;
  }

  async function confirmChapterPrivacyChange(): Promise<void> {
    const stableChapter = chapterRef.current;
    if (
      stableChapter === null ||
      privacyChangeTarget === null ||
      stableChapter.privacyMode === privacyChangeTarget ||
      project?.status !== "active"
    ) {
      return;
    }

    setPrivacyChangeBusy(true);
    setError(null);
    try {
      const result = await runtime.useCases.setChapterPrivacy.execute({
        chapterId: stableChapter.id,
        privacyMode: privacyChangeTarget,
        expectedPrivacyRevision: stableChapter.privacyRevision,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }

      setChapter(result.value.chapter);
      chapterRef.current = result.value.chapter;
      setChapters((current) =>
        current.map((item) => (item.id === result.value.chapter.id ? result.value.chapter : item)),
      );
      setPrivacyChangeTarget(null);
      setGenerationError(null);
      if (result.value.chapter.isLocalOnly) {
        const historicalCloudMessage =
          result.value.acknowledgedCloudEvidenceCount > 0
            ? `本地仍保留 ${String(result.value.acknowledgedCloudEvidenceCount)} 条已完成云端传输证据；它不能换算成云端副本数量，这些历史传输也不会被本次切换撤回。`
            : "当前本地记录没有找到已确认的云端副本证据，但这不代表本章从未上传。";
        setEditorNotice(
          `本章现已设为私密章节；阻止了 ${String(result.value.blockedProjectionCount)} 条待处理投影，并移除了 ${String(result.value.removedOutboxOperationCount)} 条尚未发出的同步任务。今后的 AI 处理只允许使用已验证的本地模型。${historicalCloudMessage}`,
        );
      } else {
        setEditorNotice(
          "本章已恢复为普通章节；今后的联网 AI、同步与导出可按你的设置使用必要内容。已有正文和版本没有变化。",
        );
      }
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setPrivacyChangeBusy(false);
    }
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

  const normalizedError = error === null ? null : projectOrdinaryUiError(error);
  const fatalErrorRequiresRuntimeReopen = requiresRuntimeDatabaseReopen(error);
  const normalizedGenerationError =
    generationError === null ? null : normalizeUiError(generationError);
  const ordinaryGenerationError =
    generationError === null ? null : projectOrdinaryUiError(generationError);
  const privateGenerationBlocked = normalizedGenerationError?.code === "PRIVATE_CHAPTER_LOCAL_ONLY";
  const readonly = project?.status !== "active";
  const candidateReady = candidate?.status === "ready";
  const candidateSuggestionLabel =
    candidatePresentation === "local"
      ? "本地草案"
      : candidatePresentation === "ai"
        ? "AI 建议"
        : "建议";
  const candidateVersionLabel = `${candidateSuggestionLabel}版本`;
  const candidateActionGap = candidatePresentation === "ai" ? " " : "";
  const candidateIncomplete = candidate?.toSnapshot().incomplete ?? false;
  const canGenerateCandidate =
    candidate === null || candidate.status === "accepted" || candidate.status === "rejected";
  const usesNativeModel = runtime.mode === "tauri";
  const recoveryDraftSnapshot = recoveryDraft?.toSnapshot() ?? null;
  const candidateSelectedDecisions =
    candidateDiff?.changes.flatMap((change) => {
      const decision = candidateDiffDecisions[change.id];
      return decision === undefined ? [] : [{ changeId: change.id, decision }];
    }) ?? [];
  const candidateReviewDiffCurrent = candidateReviewDraft === candidateReviewComparedContent;
  const candidateReviewDraftValid = candidateReviewDraft.length > 0;
  const candidateIntent = candidate?.applicationIntent ?? null;
  const candidateIsContinuation = candidateIntent?.task === "continuation";
  const candidateIsSelectionRewrite = candidateIntent?.task === "selection_rewrite";
  const candidateIsWholeChapterRewrite = candidateIntent?.task === "whole_chapter_rewrite";
  const candidateAllowsPartialDecisions = candidateIntent?.task === "legacy_full_document";
  const candidateBaseVersion =
    candidate?.baseVersionId === null || candidate?.baseVersionId === undefined
      ? undefined
      : versions.find((version) => version.id === candidate.baseVersionId);
  const candidateApplicationBlocked =
    candidate !== null &&
    (candidateBaseVersion === undefined ||
      materializeCandidateDraft(
        candidate,
        candidateBaseVersion.toSnapshot(),
        candidateReviewDraft,
      ) === null);
  const candidatePartialDecisionComplete =
    candidateReviewDiffCurrent &&
    candidateDiff !== null &&
    candidateDiff.changes.length > 0 &&
    candidateSelectedDecisions.length === candidateDiff.changes.length &&
    candidateSelectedDecisions.some(({ decision }) => decision === "accept");
  const editorClean =
    saveState === "saved_local" || saveState === "clean" || saveState === "pending_sync";
  const displayedContextCompilation =
    selectionRewriteContext ?? generationPlan?.contextCompilation ?? null;
  const displayedNovelSkillPreparation =
    selectionRewriteContext === null ? (generationPlan?.novelSkillPreparation ?? null) : null;
  const writingCanvasStyle = {
    "--editor-font-size": `${String(typography.fontSize)}px`,
    "--editor-line-height": String(typography.lineHeight),
  } as CSSProperties;
  const editorWorkspaceStyle = {
    "--editor-assistant-width": `${String(assistantPanelWidth)}px`,
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
        label: `查看${candidateActionGap}${candidateVersionLabel}`,
        disabled: candidateBusy,
        run: () => {
          setAssistantOpen(true);
          openCandidateReview();
        },
      };
    }
    if (usesNativeModel && selectionLength > 0 && canGenerateCandidate) {
      return {
        label: "修改选中内容",
        disabled: candidateBusy,
        run: () => {
          setAssistantOpen(true);
          window.requestAnimationFrame(() => {
            selectionRewriteInstructionRef.current?.focus({ preventScroll: true });
          });
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
      className="editor-page-boundary"
      state={pageState}
      preserveContent={false}
      fallbacks={{
        fatal_error:
          normalizedError === null ? undefined : (
            <ErrorState
              title={normalizedError.title}
              description={normalizedError.description}
              primaryAction={
                fatalErrorRequiresRuntimeReopen
                  ? { label: "重新打开当前页面", onClick: () => window.location.reload() }
                  : { label: "重新加载", onClick: () => void load() }
              }
            />
          ),
        conflict:
          normalizedError === null ? undefined : (
            <ErrorState
              title="恢复草稿需要处理"
              description={normalizedError.description}
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
            {chapter !== null && (
              <div className="editor-toolbar__privacy">
                <Badge tone={chapter.isLocalOnly ? "success" : "neutral"}>
                  {chapter.isLocalOnly ? "本地私密" : "普通章节"}
                </Badge>
                {!readonly && (
                  <Button
                    variant="ghost"
                    disabled={privacyChangeBusy}
                    onClick={() =>
                      setPrivacyChangeTarget(chapter.isLocalOnly ? "standard" : "local_only")
                    }
                  >
                    {chapter.isLocalOnly ? "管理隐私" : "设为私密"}
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="editor-toolbar__actions">
            {compactEditorLayout && (
              <>
                <Button
                  variant="secondary"
                  aria-expanded={chapterDrawerOpen}
                  onClick={() => {
                    setAssistantOpen(false);
                    setChapterDrawerOpen(true);
                  }}
                >
                  章节
                </Button>
                <Button
                  variant="secondary"
                  aria-expanded={assistantOpen}
                  onClick={() => {
                    setChapterDrawerOpen(false);
                    setAssistantOpen(true);
                  }}
                >
                  AI 助手
                </Button>
              </>
            )}
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
              ref={primaryEditorActionRef}
              variant={candidateReady ? "ai-primary" : "primary"}
              disabled={primaryAction.disabled}
              loading={candidateBusy || saveState === "saving"}
              onMouseDown={(event) => {
                if (primaryAction.label === "修改选中内容") {
                  event.preventDefault();
                }
              }}
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
            description={normalizedError.description}
          />
        )}
        {returnedFromAiSettings && (
          <InlineAlert
            tone="info"
            title="已返回原章节"
            description="正文、滚动位置和光标已从本地视图记录恢复；你可以继续手写，或再次打开生成前检查。"
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
                { value: "1.75", label: "舒适行距" },
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
          ref={editorWorkspaceRef}
          className="editor-workspace"
          style={editorWorkspaceStyle}
          data-chapter-panel={
            compactEditorLayout ? "drawer" : chapterListOpen ? "open" : "collapsed"
          }
          data-assistant-panel={
            compactEditorLayout ? "drawer" : assistantOpen ? "open" : "collapsed"
          }
        >
          {!compactEditorLayout &&
            (chapterListOpen ? (
              <aside
                className="candidate-panel candidate-panel--chapters"
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
                          className="back-link editor-chapter-link"
                          aria-current={item.id === chapterId ? "page" : undefined}
                          to={`/projects/${projectId ?? ""}/chapters/${item.id}`}
                        >
                          <span>
                            {String(index + 1).padStart(2, "0")} · {item.title}
                          </span>
                          {item.isLocalOnly && <Badge tone="success">私密</Badge>}
                        </Link>
                      </li>
                    ))}
                  </ol>
                </nav>
              </aside>
            ) : (
              <aside
                className="candidate-panel candidate-panel--collapsed"
                style={collapsedPanelStyle}
                aria-label="章节列表"
              >
                <Button
                  variant="secondary"
                  aria-label="展开章节列表"
                  aria-expanded={chapterListOpen}
                  onClick={() => setChapterListOpen(true)}
                >
                  章节
                </Button>
              </aside>
            ))}

          <section
            className={`writing-canvas writing-canvas--${typography.measure}`}
            data-surface={resolvedSurface}
            data-font-family={typography.fontFamily}
            style={writingCanvasStyle}
            aria-label="章节正文"
          >
            <Textarea
              ref={editorRef}
              className="writing-textarea"
              aria-label="章节正文"
              value={content}
              currentLength={content.length}
              readOnly={readonly || editorReplacementLocked}
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
                setSelectionRewriteDisclosure(null);
                scheduleEditorViewPersistence(selection);
              }}
              onScroll={(event) => {
                scrollTopRef.current = event.currentTarget.scrollTop;
                scheduleEditorViewPersistence(selectionRef.current);
              }}
              onChange={handleEditorChange}
            />
          </section>

          {!compactEditorLayout && assistantOpen && (
            <EditorAssistantResizeSeparator
              width={assistantPanelWidth}
              maxWidth={assistantPanelMaxWidth}
              onKeyDown={handleAssistantResizeKeyDown}
              onPointerDown={handleAssistantResizePointerDown}
              onPointerMove={handleAssistantResizePointerMove}
              onPointerEnd={finishAssistantResizePointerDrag}
            />
          )}

          {compactEditorLayout && assistantOpen && (
            <button
              type="button"
              className="editor-assistant-backdrop"
              aria-hidden="true"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setAssistantOpen(false)}
            />
          )}
          {assistantOpen ? (
            <aside
              id="editor-ai-assistant-panel"
              ref={assistantPanelRef}
              className={`candidate-panel candidate-panel--assistant${compactEditorLayout ? " candidate-panel--assistant-overlay" : ""}`}
              aria-labelledby="candidate-title"
              role={compactEditorLayout ? "dialog" : undefined}
              aria-modal={compactEditorLayout ? true : undefined}
              tabIndex={compactEditorLayout ? -1 : undefined}
            >
              <div className="candidate-panel__header">
                <div>
                  <p className="page-heading__eyebrow">陪伴创作</p>
                  <h2 id="candidate-title">AI 创作助手</h2>
                  <Badge tone="neutral">{directModeAuthorized ? "直接模式" : "专业模式"}</Badge>
                </div>
                <Button
                  variant="ghost"
                  size="lg"
                  aria-label={compactEditorLayout ? "关闭 AI 创作助手" : "收起 AI 创作助手"}
                  aria-expanded={assistantOpen}
                  onClick={() => setAssistantOpen(false)}
                >
                  {compactEditorLayout ? "关闭" : "收起"}
                </Button>
              </div>
              <InlineAlert
                tone="ai-clarification"
                title="正文始终由你决定"
                description={
                  directModeAuthorized
                    ? "续写会先保存为隔离的 AI 建议草稿；只有你明确选择使用后，才会接到本章末尾并创建不可变版本。本地整理授权不会代替这次确认。"
                    : usesNativeModel
                      ? "生成内容会先成为 AI 建议版本；只有你比较并接受后，才会创建新的正文版本。"
                      : "当前使用本机示例帮助检查流程，不会联网；只有你接受后，内容才会进入正文。"
                }
              />
              {(displayedContextCompilation !== null ||
                displayedNovelSkillPreparation !== null) && (
                <button
                  type="button"
                  className="context-sources-trigger"
                  onClick={() => setContextSourcesOpen(true)}
                >
                  <span>
                    <strong>本次参考</strong>
                    <small>查看 AI 为什么选用这些故事资料</small>
                  </span>
                  <Badge tone="info">
                    {(displayedContextCompilation?.compiled.entries.filter(
                      ({ included }) => included,
                    ).length ?? 0) +
                      (displayedNovelSkillPreparation?.methods.filter(({ included }) => included)
                        .length ?? 0)}{" "}
                    项
                  </Badge>
                </button>
              )}
              {projectId !== null && (
                <Link className="back-link" to={`/projects/${projectId}/context`}>
                  查看 AI 参考记录
                </Link>
              )}
              {normalizedGenerationError !== null && ordinaryGenerationError !== null && (
                <section className="generation-error-card" role="alert" aria-live="assertive">
                  <div>
                    <Badge tone="danger">生成未完成</Badge>
                    <strong>{normalizedGenerationError.title}</strong>
                  </div>
                  <p>
                    {privateGenerationBlocked
                      ? "本章处于私密模式，但目前没有可用且已验证的本地模型。本次请求在发送 0 字后停止。"
                      : ordinaryGenerationError.description}
                  </p>
                  <p className="generation-error-card__saved-state">
                    正文和已保存版本没有变化，你可以继续写作。
                  </p>
                  <div className="generation-error-card__actions">
                    <Button
                      variant="ai-primary"
                      loading={candidateBusy}
                      disabled={!editorClean}
                      onClick={() =>
                        void (lastGenerationAction === "selection_rewrite"
                          ? rewriteSelectedText()
                          : generateCandidate())
                      }
                    >
                      {lastGenerationAction === "selection_rewrite" ? "重试选区改写" : "重试生成"}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setGenerationError(null);
                        editorRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      继续写作
                    </Button>
                    {privateGenerationBlocked && (
                      <Button
                        variant="secondary"
                        onClick={() => setPrivacyChangeTarget("standard")}
                      >
                        改用普通模式
                      </Button>
                    )}
                    {usesNativeModel && (
                      <Link className="back-link" to="/settings#model-center">
                        {privateGenerationBlocked ? "配置本地 AI" : "检查 AI 服务"}
                      </Link>
                    )}
                  </div>
                </section>
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
              {candidateBusy && usesNativeModel ? (
                selectionRewriteBusy || generationPlan === null ? (
                  <div className="candidate-content" aria-live="polite">
                    <div className="candidate-content__meta">
                      <Badge tone="ai">改写中</Badge>
                      <span>{generationPreview.length} 字符</span>
                    </div>
                    <pre>{generationPreview || "正在准备选区改写建议……"}</pre>
                    <p className="candidate-panel__hint">
                      当前内容尚未写入正式正文，也不会在完成前保存为 AI 建议版本。
                    </p>
                  </div>
                ) : (
                  <GenerationProgressPanel
                    providerLabel={
                      continuationDisclosure?.connectionDisplayName ?? "已确认的 AI 服务"
                    }
                    modelLabel={generationPlan.modelId}
                    reasoningMode={generationPlan.visibleProseReasoningMode}
                    minimumVisibleCharacters={
                      generationPlan.outputContract.minimumVisibleCharacters
                    }
                    maximumVisibleCharacters={
                      generationPlan.outputContract.maximumVisibleCharacters
                    }
                    receivedVisibleCharacters={generationPreview.length}
                    stage={generationStage}
                    preview={generationPreview}
                    cancelBusy={cancelBusy}
                    onStop={() => void cancelActiveGeneration()}
                  />
                )
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
                          idempotencyKey: `editor-candidate:${candidate.id}:${feedbackCode ?? "none"}:${customFeedback?.normalize("NFKC").trim().replace(/\s+/gu, " ") ?? "none"}`,
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
                      title={`本次已保留 ${candidate.content.trim().length.toLocaleString("zh-CN")} 字，结尾尚未完成`}
                      description="模型提前停止或生成被取消；所有已收到的可见正文都保留在这份隔离建议中。你可以调整本次长度后继续补全、保留当前部分并比较、重新生成或换模型；正文没有变化。"
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
                            ? `本机规则发现句段重复超过安全阈值。建议重新生成；当前内容仍只是一份隔离的${candidateSuggestionLabel}，不会自动进入正文。`
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
                  {candidateReady && directModeAuthorized && (
                    <div className="candidate-actions">
                      <Button
                        variant="ai-primary"
                        loading={candidateBusy}
                        disabled={!editorClean}
                        onClick={openCandidateReview}
                      >
                        使用这版
                      </Button>
                      <Button
                        variant="secondary"
                        loading={candidateBusy}
                        onClick={() => void rejectCandidate()}
                      >
                        放弃
                      </Button>
                      {candidateIncomplete && (
                        <details>
                          <summary>更多选项</summary>
                          <div className="candidate-actions">
                            <Button
                              variant="secondary"
                              loading={candidateBusy}
                              disabled={!editorClean}
                              onClick={() => void generateCandidate(candidate.id)}
                            >
                              继续补全
                            </Button>
                            <Button
                              variant="secondary"
                              loading={candidateBusy}
                              disabled={!editorClean}
                              onClick={() => void generateCandidate()}
                            >
                              重新生成
                            </Button>
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                  {candidateReady && !directModeAuthorized && (
                    <div className="candidate-actions">
                      {candidateIncomplete && (
                        <Button
                          variant="ai-primary"
                          loading={candidateBusy}
                          disabled={!editorClean}
                          onClick={() => void generateCandidate(candidate.id)}
                        >
                          继续补全
                        </Button>
                      )}
                      <Button
                        variant={candidateIncomplete ? "secondary" : "ai-primary"}
                        loading={candidateBusy}
                        disabled={!editorClean}
                        onClick={openCandidateReview}
                      >
                        {candidateIncomplete
                          ? "保留当前部分并比较"
                          : `比较${candidateActionGap}${candidateSuggestionLabel}`}
                      </Button>
                      {candidateIncomplete && (
                        <Button
                          variant="secondary"
                          loading={candidateBusy}
                          disabled={!editorClean}
                          onClick={() => void generateCandidate()}
                        >
                          重新生成
                        </Button>
                      )}
                      {candidateIncomplete && usesNativeModel && (
                        <Link
                          className="button-link button-link--secondary"
                          to={preflightModelHubLink("model-selection")}
                        >
                          换模型
                        </Link>
                      )}
                      <Button
                        variant="secondary"
                        disabled={candidateBusy}
                        onClick={() => void rejectCandidate()}
                      >
                        放弃
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {!editorClean && (
                <p className="candidate-panel__hint" role="status">
                  请先保存当前正文，再处理{candidateVersionLabel}。
                </p>
              )}
              {(canGenerateCandidate || candidateIncomplete) && directModeAuthorized && (
                <section className="candidate-content" aria-label="直接续写">
                  <p>
                    生成完成后会先保存为隔离的 AI
                    建议草稿；正文和版本保持不变，直到你查看并明确选择使用。
                  </p>
                  <Button
                    variant="ai-primary"
                    loading={candidateBusy}
                    disabled={!editorClean}
                    onClick={() => void generateCandidate()}
                  >
                    继续写
                  </Button>
                  {usesNativeModel && (
                    <Link className="back-link" to="/settings#model-center">
                      设置 AI 服务
                    </Link>
                  )}
                </section>
              )}
              {(canGenerateCandidate || candidateIncomplete) && !directModeAuthorized && (
                <>
                  <section className="candidate-content" aria-label="续写长度">
                    <FormField
                      label="本次续写长度"
                      hint="这是本设备对当前作品的编辑器偏好；每次生成前都可更改，不会写成故事设定。"
                    >
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={continuationPreference.profile}
                          options={[
                            { value: "short", label: "短 · 约 1,000 字" },
                            { value: "standard", label: "标准 · 约 2,200 字" },
                            { value: "long", label: "长 · 约 4,000 字" },
                            { value: "custom", label: "自定义" },
                          ]}
                          disabled={candidateBusy}
                          onChange={(event) => {
                            const profile = event.currentTarget
                              .value as ContinuationOutputProfileId;
                            updateContinuationPreference({
                              schemaVersion: 1,
                              profile,
                              customTargetVisibleCharacters:
                                profile === "custom"
                                  ? (continuationPreference.customTargetVisibleCharacters ?? 2_200)
                                  : null,
                              destination: continuationPreference.destination,
                              customDestinationInstruction:
                                continuationPreference.customDestinationInstruction,
                            });
                          }}
                        />
                      )}
                    </FormField>
                    {continuationPreference.profile === "custom" && (
                      <FormField label="目标字数" hint="可填写 200–12,000 字。">
                        {(fieldProps) => (
                          <Input
                            {...fieldProps}
                            type="number"
                            min={200}
                            max={12_000}
                            step={100}
                            value={continuationPreference.customTargetVisibleCharacters ?? 2_200}
                            disabled={candidateBusy}
                            onChange={(event) => {
                              const value = Number(event.currentTarget.value);
                              if (!Number.isSafeInteger(value) || value < 200 || value > 12_000) {
                                return;
                              }
                              updateContinuationPreference({
                                schemaVersion: 1,
                                profile: "custom",
                                customTargetVisibleCharacters: value,
                                destination: continuationPreference.destination,
                                customDestinationInstruction:
                                  continuationPreference.customDestinationInstruction,
                              });
                            }}
                          />
                        )}
                      </FormField>
                    )}
                    {continuationPreference.profile === "long" && (
                      <p className="candidate-panel__hint" role="status">
                        长篇续写通常需要更长等待时间，并可能产生更高的模型费用；正式发送前仍会按模型上限、预算和隐私策略预检。
                      </p>
                    )}
                    <FormField
                      label="写到哪里"
                      hint="用于约束本次续写的收束位置；会进入本次任务指令，不会自动写成故事设定。"
                    >
                      {(fieldProps) => (
                        <Select
                          {...fieldProps}
                          value={continuationPreference.destination}
                          options={[
                            { value: "complete_scene", label: "推进一个完整场景" },
                            { value: "next_segment", label: "只写下一小段" },
                            { value: "custom_instruction", label: "按我的要求" },
                          ]}
                          disabled={candidateBusy}
                          onChange={(event) => {
                            const destination = event.currentTarget
                              .value as ContinuationDestinationId;
                            updateContinuationPreference({
                              ...continuationPreference,
                              destination,
                              customDestinationInstruction:
                                destination === "custom_instruction"
                                  ? continuationPreference.customDestinationInstruction
                                  : null,
                            });
                          }}
                        />
                      )}
                    </FormField>
                    {continuationPreference.destination === "custom_instruction" && (
                      <FormField
                        label="本次写作要求"
                        hint="例如：写到主角发现密信为止。最多 2,000 字。"
                        required
                      >
                        {(fieldProps) => (
                          <Textarea
                            {...fieldProps}
                            value={continuationPreference.customDestinationInstruction ?? ""}
                            currentLength={
                              continuationPreference.customDestinationInstruction?.length ?? 0
                            }
                            rows={3}
                            maxLength={2_000}
                            disabled={candidateBusy}
                            onChange={(event) =>
                              updateContinuationPreference({
                                ...continuationPreference,
                                customDestinationInstruction: event.currentTarget.value,
                              })
                            }
                          />
                        )}
                      </FormField>
                    )}
                  </section>
                  {usesNativeModel && selectionLength > 0 && (
                    <section className="candidate-content" aria-label="修改选中内容">
                      <FormField
                        label={`改写选中的 ${selectionLength.toLocaleString("zh-CN")} 个字符`}
                        hint={
                          selectionLength > MAXIMUM_SELECTION_REWRITE_CHARACTERS
                            ? `选区最多支持 ${MAXIMUM_SELECTION_REWRITE_CHARACTERS.toLocaleString("zh-CN")} 个字符，请缩小选区。`
                            : "只改写当前选区；前后正文会原样保留。结果先进入 AI 建议版本。"
                        }
                        required
                      >
                        {(fieldProps) => (
                          <Textarea
                            {...fieldProps}
                            ref={selectionRewriteInstructionRef}
                            value={selectionRewriteInstruction}
                            rows={3}
                            maxLength={2_000}
                            currentLength={selectionRewriteInstruction.length}
                            disabled={candidateBusy}
                            placeholder="例如：保留原意，让对话更自然"
                            onChange={(event) => {
                              setSelectionRewriteInstruction(event.currentTarget.value);
                              setSelectionRewriteDisclosure(null);
                            }}
                          />
                        )}
                      </FormField>
                      {selectionRewriteDisclosure !== null && (
                        <InlineAlert
                          tone="warning"
                          title="确认后会调用 1 次"
                          description={`${selectionRewriteDisclosure.connectionDisplayName} · ${selectionRewriteDisclosure.modelId}；${selectionRewriteDisclosure.privacy} 发送内容：${selectionRewriteDisclosure.sends.join("；")}。自动重试 0 次；${formatSelectionRewriteCost(selectionRewriteDisclosure)}。`}
                          onDismiss={() => setSelectionRewriteDisclosure(null)}
                        />
                      )}
                      <Button
                        variant="ai-primary"
                        loading={selectionRewriteBusy}
                        disabled={
                          !editorClean ||
                          candidateBusy ||
                          selectionRewriteInstruction.trim().length === 0 ||
                          selectionLength > MAXIMUM_SELECTION_REWRITE_CHARACTERS
                        }
                        onClick={() => void rewriteSelectedText()}
                      >
                        {selectionRewriteDisclosure === null
                          ? "查看选区改写发送信息"
                          : "确认并生成选区改写建议"}
                      </Button>
                      {selectionRewriteDisclosure !== null && (
                        <Button
                          variant="ghost"
                          disabled={selectionRewriteBusy}
                          onClick={() => setSelectionRewriteDisclosure(null)}
                        >
                          取消，不调用
                        </Button>
                      )}
                    </section>
                  )}
                  {usesNativeModel && (
                    <Link className="back-link" to="/settings#model-center">
                      设置 AI 服务
                    </Link>
                  )}
                  <Button
                    variant="ghost"
                    loading={candidateBusy}
                    disabled={
                      !editorClean ||
                      (continuationPreference.destination === "custom_instruction" &&
                        (continuationPreference.customDestinationInstruction?.trim().length ??
                          0) === 0)
                    }
                    onClick={() => void generateCandidate()}
                  >
                    {candidate?.status === "accepted"
                      ? "生成续写建议"
                      : candidate?.status === "rejected"
                        ? "重新生成"
                        : usesNativeModel
                          ? content.trim().length === 0
                            ? "生成开头"
                            : "生成续写建议"
                          : "生成示例建议"}
                  </Button>
                </>
              )}
              {!directModeAuthorized &&
                runtime.featureFlags.multiAgent &&
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
          ) : !compactEditorLayout ? (
            <aside
              className="candidate-panel candidate-panel--collapsed"
              style={collapsedPanelStyle}
              aria-label="AI 创作助手"
            >
              <Button
                variant="secondary"
                aria-label="展开 AI 创作助手"
                aria-expanded={assistantOpen}
                onClick={() => setAssistantOpen(true)}
              >
                AI 助手
              </Button>
            </aside>
          ) : null}
        </div>
      </div>

      <Drawer
        side="left"
        open={compactEditorLayout && chapterDrawerOpen}
        onOpenChange={setChapterDrawerOpen}
        title="章节"
        description="选择章节后会回到正文；未保存的修改会先完成安全保存。"
        footer={
          <Button variant="secondary" onClick={() => setChapterDrawerOpen(false)}>
            关闭
          </Button>
        }
      >
        <nav aria-label="章节抽屉">
          <ol className="compact-chapter-list">
            {chapters.map((item, index) => (
              <li key={item.id}>
                <Link
                  className="back-link editor-chapter-link"
                  aria-current={item.id === chapterId ? "page" : undefined}
                  to={`/projects/${projectId ?? ""}/chapters/${item.id}`}
                  onClick={() => setChapterDrawerOpen(false)}
                >
                  <span>
                    {String(index + 1).padStart(2, "0")} · {item.title}
                  </span>
                  {item.isLocalOnly && <Badge tone="success">私密</Badge>}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      </Drawer>

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

      <Drawer
        open={contextSourcesOpen}
        onOpenChange={setContextSourcesOpen}
        title="本次参考"
        description="这里只展示本次生成实际选择或因篇幅舍弃的资料。未选中的内容不会发送给 AI。"
        footer={
          <Button variant="secondary" onClick={() => setContextSourcesOpen(false)}>
            关闭
          </Button>
        }
      >
        <>
          {displayedNovelSkillPreparation !== null && (
            <PreparedNovelSkillReference preparation={displayedNovelSkillPreparation} />
          )}
          {displayedContextCompilation === null ? (
            <EmptyState
              title="暂无故事资料记录"
              description="浏览器演示不会生成正式参考收据；在桌面版完成一次真实创作后，这里会显示实际采用的设定、事件与章节资料。"
            />
          ) : (
            <div className="context-sources" aria-label="本次故事资料来源">
              <div className="context-sources__summary">
                <div>
                  <span>实际参考</span>
                  <strong>
                    {
                      displayedContextCompilation.compiled.entries.filter(
                        ({ included }) => included,
                      ).length
                    }{" "}
                    项
                  </strong>
                </div>
                <p>
                  预计使用{" "}
                  {displayedContextCompilation.compiled.trace.usedTokens.toLocaleString("zh-CN")}/
                  {displayedContextCompilation.compiled.trace.maximumContextTokens.toLocaleString(
                    "zh-CN",
                  )}{" "}
                  个输入 token（本机保守估算，不是计费回执）。
                </p>
                <p>{contextBudgetExplanation(displayedContextCompilation.compiled)}</p>
              </div>
              <div className="context-sources__groups">
                {groupContextEntriesByLayer(displayedContextCompilation.compiled.entries).map(
                  ({ layer, entries }) => (
                    <section key={layer} aria-labelledby={`context-group-${layer}`}>
                      <h3 id={`context-group-${layer}`}>{contextLayerLabel(layer)}</h3>
                      <ol className="context-sources__list">
                        {entries.map((entry) => (
                          <li key={entry.id} data-included={entry.included ? "true" : "false"}>
                            <div className="context-sources__item-heading">
                              <Badge tone={entry.included ? "info" : "neutral"}>
                                {contextEntryStatusLabel(entry)}
                              </Badge>
                              <span>约 {entry.estimatedTokens.toLocaleString("zh-CN")} token</span>
                            </div>
                            <p>{contextSelectionReasonLabel(entry)}</p>
                            <p className="candidate-panel__hint">
                              {contextEntryExcerpt(entry.content)}
                            </p>
                            {entry.evidence.length > 0 ? (
                              <ul className="context-sources__evidence">
                                {uniqueContextSourceTypes(entry.evidence).map((sourceType) => (
                                  <li key={sourceType}>
                                    <span>{contextSourceTypeLabel(sourceType)}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <small>由当前写作任务直接提供，没有额外资料来源。</small>
                            )}
                          </li>
                        ))}
                      </ol>
                    </section>
                  ),
                )}
              </div>
            </div>
          )}
        </>
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

      {privacyChangeTarget !== null && chapter !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !privacyChangeBusy) {
              setPrivacyChangeTarget(null);
            }
          }}
          title={
            privacyChangeTarget === "local_only" ? "将本章设为私密章节？" : "允许本章使用联网 AI？"
          }
          description={
            privacyChangeTarget === "local_only"
              ? "确认后，本章正文、摘要、检索、审稿和续写只允许使用已验证的本地模型；没有可用本地模型时会安全停止。"
              : "确认后，未来的联网 AI、同步与普通导出可以按你的设置使用本章所需内容。"
          }
          footer={
            <>
              <Button
                variant="secondary"
                disabled={privacyChangeBusy}
                onClick={() => setPrivacyChangeTarget(null)}
              >
                取消
              </Button>
              <Button
                loading={privacyChangeBusy}
                disabled={project?.status !== "active"}
                onClick={() => void confirmChapterPrivacyChange()}
              >
                {privacyChangeTarget === "local_only" ? "确认仅限本地" : "确认改为普通章节"}
              </Button>
            </>
          }
        >
          {privacyChangeTarget === "local_only" ? (
            <InlineAlert
              tone="warning"
              title="无法撤回已经完成的外部传输"
              description="墨影会从现在起阻止新的云端发送，并清理尚未发出的同步任务；如果本章过去已经传到供应商或确认写入远端，当前版本无法替你从对方系统中删除。"
            />
          ) : (
            <InlineAlert
              tone="warning"
              title="以后可能离开本机"
              description="改为普通章节不会立刻发送正文，但后续使用联网 AI、同步或勾选包含私密内容导出时，完成任务所需的内容可能离开本机。"
            />
          )}
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
        className="candidate-review-overlay"
        open={candidateReviewOpen}
        onOpenChange={(open) => {
          if (!candidateBusy) {
            if (open) {
              setCandidateReviewOpen(true);
            } else {
              dismissCandidateReview();
            }
          }
        }}
        title={`比较${candidateActionGap}${candidateSuggestionLabel}与正文`}
        description="先把建议改到满意，再逐处决定或选择应用位置；点击创建版本前不会写入正文。"
        footer={
          <>
            <Button
              size="lg"
              variant="secondary"
              disabled={candidateBusy}
              onClick={dismissCandidateReview}
            >
              取消
            </Button>
            <Button
              size="lg"
              variant="secondary"
              loading={candidateBusy}
              disabled={candidateBusy || candidate?.status !== "ready"}
              onClick={() => {
                void rejectCandidate().then((rejected) => {
                  if (rejected) {
                    setCandidateReviewOpen(false);
                  }
                });
              }}
            >
              放弃
            </Button>
            {candidateAllowsPartialDecisions && (
              <Button
                size="lg"
                variant="ai-primary"
                loading={candidateBusy}
                disabled={
                  candidateReviewConflict !== null ||
                  candidateApplicationBlocked ||
                  !candidateReviewDraftValid ||
                  !candidatePartialDecisionComplete
                }
                onClick={() =>
                  void acceptCandidate({
                    kind: "apply_changes",
                    decisions: candidateSelectedDecisions,
                  })
                }
              >
                按逐项决定创建版本
              </Button>
            )}
            <Button
              size="lg"
              variant="ai-primary"
              loading={candidateBusy}
              disabled={
                candidate === null ||
                candidateBusy ||
                candidateReviewConflict !== null ||
                candidateApplicationBlocked ||
                !candidateReviewDraftValid
              }
              onClick={() => {
                if (candidate !== null) {
                  void acceptCandidate(candidateDefaultStrategy(candidate));
                }
              }}
            >
              使用这版
            </Button>
          </>
        }
      >
        <div
          className="candidate-review-dialog"
          role="region"
          aria-label={`${candidateSuggestionLabel}审阅内容`}
        >
          <Button
            className="candidate-review-dialog__scroll-control"
            variant="ghost"
            onKeyDown={handleCandidateReviewNavigation}
          >
            浏览{candidateActionGap}
            {candidateSuggestionLabel}内容（PageUp / PageDown / Home / End）
          </Button>
          {candidate !== null && candidateReviewConflict === null && (
            <section className="candidate-review-dialog__editor">
              <div className="candidate-review-dialog__editor-heading">
                <div>
                  <h3>
                    可编辑的{candidateActionGap}
                    {candidateSuggestionLabel}
                  </h3>
                  <p>这里是临时建议草稿；采用前不会写进正文或创建正式版本。</p>
                </div>
                <Badge
                  tone={
                    candidateRevisionSaved || candidateReviewDraft !== candidate.content
                      ? "ai"
                      : "neutral"
                  }
                >
                  {candidateRevisionSaved
                    ? "修改已保存为建议"
                    : candidateReviewDraft === candidate.content
                      ? "原始建议"
                      : "已由你修改"}
                </Badge>
              </div>
              <Textarea
                ref={candidateReviewTextareaRef}
                aria-label={`可编辑的${candidateActionGap}${candidateSuggestionLabel}`}
                value={candidateReviewDraft}
                maxLength={5_000_000}
                rows={10}
                disabled={candidateBusy}
                onChange={(event) => {
                  setCandidateReviewDraft(event.currentTarget.value);
                  setCandidateDiffDecisions({});
                  setCandidateRevisionSaved(false);
                }}
              />
              <div className="candidate-review-dialog__editor-actions">
                <span>{candidateReviewDraft.length.toLocaleString("zh-CN")} 字符</span>
                <Button
                  variant="secondary"
                  loading={candidateBusy}
                  disabled={
                    candidateBusy ||
                    !candidateReviewDraftValid ||
                    candidateReviewDraft === candidate.content
                  }
                  onClick={() => void saveCandidateRevision()}
                >
                  保存建议修改
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    candidateBusy || !candidateReviewDraftValid || candidateReviewDiffCurrent
                  }
                  onClick={compareEditedCandidate}
                >
                  重新比较差异
                </Button>
              </div>
              {!candidateReviewDiffCurrent && (
                <InlineAlert
                  tone="info"
                  title="建议已经修改"
                  description="整段应用可以直接继续；若要逐处接受，请先重新比较差异。"
                />
              )}
            </section>
          )}
          {candidateReviewConflict !== null && candidate !== null && (
            <>
              <InlineAlert
                tone="error"
                title="正文已在建议生成后变化"
                description={`已阻止接受。下面同时保留生成时正文、当前正文和${candidateSuggestionLabel}；请先另存或处理冲突，InkShadow 不会静默覆盖。`}
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
                  <h3>{candidateSuggestionLabel}</h3>
                  <pre>{boundedEditorPreview(candidate.content)}</pre>
                </section>
              </div>
              <div className="candidate-review-dialog__conflict-actions">
                <p>
                  可先把完整{candidateSuggestionLabel}
                  保存成独立章节，从而同时保留当前正文与建议，再决定是否拒绝。
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
              title={`${candidateSuggestionLabel}比较提示`}
              description={candidateReviewError}
            />
          )}
          {candidateDiff !== null && candidateReviewDiffCurrent && (
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
                <h3>{candidateIsWholeChapterRewrite ? "整章改写处理方式" : "应用建议"}</h3>
                {candidateIsContinuation && (
                  <p>
                    这份建议只包含续写片段，将插入生成时记录的第 {candidateIntent.startUtf16}
                    个字符处；不会重复插入原正文。
                  </p>
                )}
                {candidateIsSelectionRewrite && (
                  <p>
                    这份建议只会替换生成时记录的第 {candidateIntent.startUtf16} 到第{" "}
                    {candidateIntent.endUtf16} 个字符；选区之外的正文保持不变。
                  </p>
                )}
                {candidateIsWholeChapterRewrite && (
                  <p>可替换整章、追加到章末或另存为新草稿；取消不会改变正文。</p>
                )}
                {!candidateIsContinuation &&
                  !candidateIsSelectionRewrite &&
                  !candidateIsWholeChapterRewrite && (
                    <p>
                      当前选区：第 {candidateReviewSelection.start} 到{" "}
                      {candidateReviewSelection.end} 个字符
                    </p>
                  )}
              </div>
              <div>
                {candidateIsContinuation && (
                  <Button
                    loading={candidateBusy}
                    disabled={
                      candidateBusy ||
                      candidateReviewConflict !== null ||
                      candidateApplicationBlocked ||
                      !candidateReviewDraftValid
                    }
                    onClick={() => void acceptCandidate(candidateDefaultStrategy(candidate))}
                  >
                    {candidateReviewDraft === candidate.content
                      ? "插入光标并创建版本"
                      : "编辑后插入光标并创建版本"}
                  </Button>
                )}
                {candidateIsSelectionRewrite && (
                  <Button
                    loading={candidateBusy}
                    disabled={
                      candidateBusy ||
                      candidateReviewConflict !== null ||
                      candidateApplicationBlocked ||
                      !candidateReviewDraftValid
                    }
                    onClick={() => void acceptCandidate(candidateDefaultStrategy(candidate))}
                  >
                    {candidateReviewDraft === candidate.content
                      ? "替换选区并创建版本"
                      : "编辑后替换选区并创建版本"}
                  </Button>
                )}
                {candidateIsWholeChapterRewrite && (
                  <>
                    <Button
                      variant="secondary"
                      disabled={
                        candidateBusy ||
                        candidateReviewConflict !== null ||
                        candidateApplicationBlocked ||
                        !candidateReviewDraftValid
                      }
                      onClick={() =>
                        void acceptCandidate({
                          kind: "insert_at_cursor",
                          cursorUtf16: chapter?.content.length ?? 0,
                        })
                      }
                    >
                      追加到章末并创建版本
                    </Button>
                    <Button
                      variant="secondary"
                      loading={candidateBusy}
                      disabled={project?.status !== "active" || candidateCopySaved}
                      onClick={() => void saveCandidateAsChapterCopy()}
                    >
                      {candidateCopySaved ? "新草稿已保存" : "保存为新草稿"}
                    </Button>
                    <Button
                      disabled={
                        candidateBusy ||
                        candidateReviewConflict !== null ||
                        candidateApplicationBlocked ||
                        !candidateReviewDraftValid
                      }
                      onClick={() => void acceptCandidate({ kind: "overwrite_document" })}
                    >
                      替换整章并创建版本
                    </Button>
                  </>
                )}
                {!candidateIsContinuation &&
                  !candidateIsSelectionRewrite &&
                  !candidateIsWholeChapterRewrite && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={
                          candidateBusy ||
                          candidateReviewConflict !== null ||
                          candidateApplicationBlocked ||
                          !candidateReviewDraftValid
                        }
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
                          candidateApplicationBlocked ||
                          !candidateReviewDraftValid ||
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
                        disabled={
                          candidateBusy ||
                          candidateReviewConflict !== null ||
                          candidateApplicationBlocked ||
                          !candidateReviewDraftValid
                        }
                        onClick={() => void acceptCandidate({ kind: "overwrite_document" })}
                      >
                        覆盖全文并创建版本
                      </Button>
                    </>
                  )}
              </div>
            </section>
          )}
        </div>
      </Dialog>

      <Dialog
        open={preflightOpen}
        onOpenChange={(open) => {
          if (!budgetSaving && !directDisclosureSaving) {
            setPreflightOpen(open);
          }
        }}
        title="生成前检查"
        description="开始前会检查正文是否已保存、AI 服务是否可用以及预算是否允许；有问题时会告诉你如何解决。"
        footer={
          generationPlan?.preflight.readiness === "BLOCKED" ? (
            <>
              <Button
                variant="secondary"
                disabled={budgetSaving}
                onClick={closePreflightAndFocusEditor}
              >
                先自己写
              </Button>
              <Button
                variant="secondary"
                disabled={budgetSaving}
                onClick={() => void saveAndClosePreflight()}
              >
                保存并关闭
              </Button>
              {canDeferGenerationPlan(generationPlan) && (
                <Button
                  variant="secondary"
                  loading={candidateBusy}
                  disabled={budgetSaving}
                  onClick={() => void deferGenerationUntilOnline()}
                >
                  保存待执行
                </Button>
              )}
              <Link
                className="button-link"
                to={preflightModelHubLink("provider-connection")}
                onClick={() => persistEditorView(selectionRef.current)}
              >
                修复 AI 设置
              </Link>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={budgetSaving}
                onClick={closePreflightAndFocusEditor}
              >
                暂不生成
              </Button>
              {generationPlan?.preflight.readiness === "READY_WITH_WARNINGS" && (
                <Link
                  className="button-link button-link--secondary"
                  to={preflightModelHubLink("model-pricing")}
                  onClick={() => persistEditorView(selectionRef.current)}
                >
                  去完善模型信息
                </Link>
              )}
              <Button
                variant="ai-primary"
                loading={directDisclosureSaving}
                disabled={
                  !generationPlan?.preflight.canStart || budgetSaving || directDisclosureSaving
                }
                onClick={() => void confirmGeneration()}
              >
                {generationPlan?.preflight.readiness === "READY_WITH_WARNINGS"
                  ? "使用安全默认值并开始"
                  : "确认并开始"}
              </Button>
            </>
          )
        }
      >
        {generationPlan !== null && (
          <div className="generation-preflight">
            <InlineAlert
              tone={
                generationPlan.preflight.readiness === "BLOCKED"
                  ? "error"
                  : generationPlan.preflight.readiness === "READY_WITH_WARNINGS"
                    ? "warning"
                    : "info"
              }
              title={
                generationPlan.preflight.readiness === "BLOCKED"
                  ? "当前无法调用 AI"
                  : generationPlan.preflight.readiness === "READY_WITH_WARNINGS"
                    ? `可以开始生成，但有 ${String(generationPlan.preflight.warnings.length)} 项提示`
                    : "检查通过"
              }
              description={
                generationPlan.preflight.readiness !== "BLOCKED"
                  ? generationPlan.preflight.readiness === "READY_WITH_WARNINGS"
                    ? "这些提示不会阻止生成；墨影会使用已列出的安全默认值。供应商仍可能按实际调用计费。"
                    : "确认后才会开始生成。重复确认同一份检查结果会复用原任务，不会重复调用 AI 服务。"
                  : canDeferGenerationPlan(generationPlan)
                    ? "当前只因网络离线而阻断；可保存不含正文和创作指令的待执行记录，联网后重新检查并确认。"
                    : "请按下列操作修复后重新检查；当前不会调用 AI 服务，但正文仍可编辑和保存。"
              }
            />

            {continuationDisclosure === null ? (
              generationPlan.executionMode === "local_demo" ? (
                <InlineAlert
                  tone="info"
                  title="本次不会发送到外部 AI 服务"
                  description="这是本机演示流程。完整结果只会保存为隔离的 AI 建议草稿；只有你稍后明确选择使用，才会改变正文并创建不可变版本。"
                />
              ) : null
            ) : (
              <InlineAlert
                tone="warning"
                title="确认本次模型服务调用"
                description={`${continuationDisclosure.connectionDisplayName} · ${continuationDisclosure.modelId}；${continuationDisclosure.privacy} 发送内容：${continuationDisclosure.sends.join("；")}。本次最多调用 ${String(continuationDisclosure.maximumProviderCalls)} 次，自动重试 ${String(continuationDisclosure.automaticRetryCount)} 次；${formatProviderActionCost(continuationDisclosure)}。${generationPlan.requestId === directGenerationRequestId && directDisclosure !== null ? "相同模型服务、精确模型、发送范围、调用上限、费用状态和隐私策略不变时，可复用这项本机授权；任一项变化都会再次询问。" : "这次确认只适用于当前正文版本与本次生成计划；任一项变化都会停止发送并要求重新确认。"}完整结果只会保存为隔离的 AI 建议草稿，正文和版本保持不变，直到你明确选择使用。`}
              />
            )}

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
                  continuationDisclosure?.connectionDisplayName ??
                  (generationPlan.executionMode === "local_demo" ? "本机演示" : "已确认的 AI 服务")
                } / ${generationPlan.modelId} · ${
                  generationPlan.profile?.provider === "ollama" ||
                  generationPlan.modelHubInspection?.dataDestination === "local"
                    ? "数据仅发送到本机 AI 服务"
                    : generationPlan.routeReason === "local_demo"
                      ? "内置演示，不外发"
                      : "本次所需内容将发送到外部 AI 服务"
                }${
                  generationPlan.routeFallback === null
                    ? ""
                    : "；已配置备用模型，实际调用对象以上方确认信息为准"
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
                    个输入 token（本机保守估算，不是计费回执）；未选资料不会发送给模型。
                  </p>
                  <p>{contextBudgetExplanation(generationPlan.contextCompilation.compiled)}</p>
                  <ul>
                    {generationPlan.contextCompilation.compiled.entries.map((entry) => (
                      <li key={entry.id}>
                        <Badge tone={entry.included ? "info" : "neutral"}>
                          {contextEntryStatusLabel(entry)}
                        </Badge>{" "}
                        <strong>{contextLayerLabel(entry.layer)}</strong>
                        <span> · 约 {entry.estimatedTokens.toLocaleString("zh-CN")} token</span>
                        <p>{contextSelectionReasonLabel(entry)}</p>
                        {entry.evidence.length > 0 && (
                          <small>
                            来源：
                            {uniqueContextSourceTypes(entry.evidence)
                              .map(contextSourceTypeLabel)
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
                    <Link
                      className="back-link"
                      to={preflightModelHubLink(
                        check.action === "UPDATE_PRICING"
                          ? "model-pricing"
                          : check.action === "RETRY_CONNECTION"
                            ? "provider-connection"
                            : "model-selection",
                      )}
                      onClick={() => persistEditorView(selectionRef.current)}
                    >
                      设置 AI 服务
                    </Link>
                  ) : check.action === "REDUCE_CONTEXT" ? (
                    <Button variant="secondary" onClick={closePreflightAndFocusEditor}>
                      返回正文精简内容
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>

            {generationPlan.preflight.costStatus === "pricing_unavailable" && (
              <section className="generation-preflight__cost" aria-label="费用估算">
                <div>
                  <span>预计费用</span>
                  <strong>暂时无法计算</strong>
                </div>
                <p>
                  当前模型价格未配置；这不会阻止本次生成，但供应商仍可能正常计费。生成后会保留供应商返回的用量，金额标记为
                  pricing_unavailable，不伪造零费用。
                </p>
              </section>
            )}

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

function selectionRewriteUiError(cause: unknown): unknown {
  if (cause instanceof UiActionError) {
    return cause;
  }
  if (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^(?:SELECTION_REWRITE|PRIVATE_CHAPTER|STORY_CONTEXT|CONTEXT_TRACE|MODEL_)[A-Z0-9_]*$/u.test(
      cause.code,
    )
  ) {
    return new UiActionError(
      cause.code,
      projectOrdinaryUiError(cause).description,
      "选区改写未完成",
    );
  }
  return cause;
}

function formatSelectionRewriteCost(disclosure: SelectionRewriteDisclosure): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null) {
    return "当前无法核定费用上限，AI 服务仍可能收费";
  }
  return `本次费用上限 ${disclosure.estimatedMaximumCostMicros} 微单位 ${disclosure.currency}`;
}

function formatProviderActionCost(disclosure: ContinuationGenerationDisclosure): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null) {
    return "当前无法核定费用上限，AI 服务仍可能收费";
  }
  return `本次费用上限 ${disclosure.estimatedMaximumCostMicros} 微单位 ${disclosure.currency}`;
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
  return severity === "fix_recommended" ? "提示" : "已检查";
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

type ContextCompilationEntry = StoryContextCompilationReceipt["compiled"]["entries"][number];

function groupContextEntriesByLayer(
  entries: readonly ContextCompilationEntry[],
): readonly { layer: ContextLayer; entries: readonly ContextCompilationEntry[] }[] {
  const groups: { layer: ContextLayer; entries: ContextCompilationEntry[] }[] = [];
  const groupByLayer = new Map<ContextLayer, ContextCompilationEntry[]>();
  for (const entry of entries) {
    const existing = groupByLayer.get(entry.layer);
    if (existing !== undefined) {
      existing.push(entry);
      continue;
    }
    const groupedEntries = [entry];
    groupByLayer.set(entry.layer, groupedEntries);
    groups.push({ layer: entry.layer, entries: groupedEntries });
  }
  return groups;
}

function contextSelectionReasonLabel(entry: ContextCompilationEntry): string {
  const reason = entry.selectionReason;
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
  const layerReasons: Record<ContextLayer, string> = {
    locked_hard_rules: "这是当前作品已经锁定的规则，本次创作必须优先遵守。",
    current_task: "这是你为本次生成明确提出的写作任务。",
    scene_goal: "这是当前场景需要推进的目标，用来约束下一段内容的方向。",
    pov_known_information: "这是当前视角人物此刻知道或不知道的信息，用来避免视角越界。",
    character_current_state: "这是相关人物在当前时间点的状态，用来保持行为和关系连续。",
    recent_events: "这是紧邻当前写作位置发生的事件，用来衔接下一段正文。",
    related_causal_chain: "这是会直接影响当前情节的前因后果，用来保持事件推进合理。",
    unresolved_foreshadowing: "这是尚未回收的伏笔，用来避免遗忘或过早揭示。",
    world_setting: "这是当前情节涉及的世界设定，用来避免违反既有背景。",
    character_voice_samples: "这是相关人物过去的说话样例，用来保持人物口吻一致。",
    semantic_retrieval: "本地检索发现这项资料与当前情节相关，因此作为补充参考。",
    rerank_supplement: "检索结果复核后，这项资料与当前任务的相关性更高，因此作为补充参考。",
  };
  const sourceTypes = uniqueContextSourceTypes(entry.evidence);
  if (sourceTypes.length === 0) {
    return layerReasons[entry.layer];
  }
  return `${layerReasons[entry.layer]} 来源：${sourceTypes
    .map(contextSourceTypeLabel)
    .join("、")}。`;
}

function contextEntryStatusLabel(
  entry: StoryContextCompilationReceipt["compiled"]["entries"][number],
): string {
  if (entry.included) return "已参考";
  if (entry.discardedReason === "duplicate_source") return "已合并，未重复发送";
  if (entry.discardedReason === "token_budget_exhausted") return "篇幅预算未使用";
  return "未使用";
}

function contextEntryExcerpt(content: string): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "这项资料没有可展示的文字摘要。";
  return normalized.length <= 140 ? normalized : `${normalized.slice(0, 140)}…`;
}

function uniqueContextSourceTypes(
  evidence: StoryContextCompilationReceipt["compiled"]["entries"][number]["evidence"],
): readonly ContextEvidenceSourceType[] {
  return [...new Set(evidence.map(({ sourceType }) => sourceType))];
}

function contextBudgetExplanation(compiled: StoryContextCompilationReceipt["compiled"]): string {
  const duplicateCount = compiled.entries.filter(
    ({ discardedReason }) => discardedReason === "duplicate_source",
  ).length;
  const budgetDiscardCount = compiled.entries.filter(
    ({ discardedReason }) => discardedReason === "token_budget_exhausted",
  ).length;
  const parts: string[] = [];
  if (budgetDiscardCount > 0) {
    parts.push(`${String(budgetDiscardCount)} 项较低优先级资料因本次输入预算未发送`);
  } else {
    parts.push("没有更多需要为本次任务补充的高相关资料");
  }
  if (duplicateCount > 0) {
    parts.push(`${String(duplicateCount)} 项重复资料已合并证据且不会重复发送`);
  }
  return `${parts.join("；")}。剩余预算不会为了凑满而加入无关内容。`;
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
    PREFLIGHT_WARNING_PRICING_UNKNOWN: "该模型尚未填写价格，暂时无法估算费用",
    PREFLIGHT_WARNING_CONTEXT_UNKNOWN: "未获取精确上下文上限，将使用保守长度整理参考内容",
    PREFLIGHT_WARNING_TOKEN_ESTIMATE_APPROXIMATE: "当前 Token 数为估算值，已预留安全余量",
    PREFLIGHT_BLOCKED_NO_ROUTE: "没有可用的正文生成 AI 分工",
    PREFLIGHT_BLOCKED_CREDENTIAL: "AI 服务凭据缺失或不可用",
    PREFLIGHT_BLOCKED_MODEL_UNAVAILABLE: "连接或所选模型确定不可用",
    PREFLIGHT_BLOCKED_PRIVACY: "当前隐私规则不允许使用这项 AI 服务",
    PREFLIGHT_BLOCKED_CONTEXT_OVERFLOW: "精简后仍超过当前可处理的上下文长度",
    PREFLIGHT_BLOCKED_HARD_BUDGET: "预计费用超过你主动设置的硬预算",
    READY: "AI 服务、章节、费用与预算均已检查",
  };
  return labels[code] ?? "其他安全检查";
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
  if (
    usage.source === "provider_reported_unpriced" &&
    usage.inputTokens !== null &&
    usage.outputTokens !== null
  ) {
    const cached =
      usage.cachedInputTokens === null
        ? ""
        : `，其中缓存输入 ${usage.cachedInputTokens.toLocaleString("zh-CN")}`;
    return `第 ${String(usage.attempt)} 次供应商回执：输入 ${usage.inputTokens.toLocaleString(
      "zh-CN",
    )}${cached}，输出 ${usage.outputTokens.toLocaleString(
      "zh-CN",
    )} 个用量单位；价格未配置，因此金额标记为 pricing_unavailable。`;
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
