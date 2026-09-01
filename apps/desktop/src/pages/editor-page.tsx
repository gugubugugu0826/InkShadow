import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  type ProjectDisplayIdentity,
} from "@inkshadow/application";
import {
  MAXIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS,
  MINIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS,
  detectCandidateStableOverlap,
  type CandidateStableOverlapResult,
  type CandidateQualityGateResult,
  type ContinuationOutputContract,
  type ContinuationOutputProfileId,
  type ContextEvidenceSourceType,
  type ContextLayer,
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
import type { AiCandidateListWithIsolation, AiCandidateIsolationIncident } from "@inkshadow/data";
import { AppError, parseUuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7, type Outline } from "@inkshadow/story-core";
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

import { CandidateHistoryPanel } from "../components/candidate-history-panel";
import {
  captureMountedComponentPath,
  useComponentOwnershipPath,
} from "../components/component-ownership-context";

import {
  canDeferGenerationPlan,
  cancelGenerationPlan,
  executeGenerationPlan,
  prepareGenerationPlan,
  saveDeferredGenerationPlan,
  type CandidateStore,
  type PreparedGenerationPlan,
  type RuntimeStory,
} from "../infrastructure/runtime";
import {
  createSelectionRewriteCandidate,
  MAXIMUM_SELECTION_REWRITE_CHARACTERS,
  prepareSelectionRewrite,
  selectionWritingActionFromIntent,
  type SelectionRewriteDisclosure,
} from "../infrastructure/selection-rewrite-service";
import { ModelCenterError } from "../infrastructure/model-center-store";
import { recordSafeOperationIncident } from "../infrastructure/safe-operation-diagnostics";
import {
  beginGenerationNavigationSession,
  currentGenerationNavigationGuard,
  type GenerationNavigationSession,
} from "../infrastructure/generation-navigation-lifecycle";
import type { StoryContextCompilationReceipt } from "../infrastructure/story-context-runtime";
import {
  normalizeUiError,
  projectOrdinaryUiError,
  requiresRuntimeDatabaseReopen,
  UiActionError,
} from "../infrastructure/ui-error";
import { CreativeJourneyStoreError } from "../infrastructure/creative-journey-store";
import { editorCandidateStatusLabel } from "../infrastructure/editor-candidate-status";
import {
  recordEditorReadIncident,
  recoverEditorReadIncidents,
  type EditorReadStage,
  type SafeUiRouteRowReference,
} from "../infrastructure/ui-route-diagnostics";
import type {
  DeferredGenerationRequest,
  GenerationAttemptUsage,
  GenerationBudgetPolicy,
  GenerationRun,
} from "../infrastructure/generation-governance-store";
import {
  createLocalAcceptedVersionPipelineInput,
  createLocalCandidateAcceptancePipelineInput,
  ensureAcceptedChapterPipelineTask,
  runAcceptedChapterPipeline,
  type AcceptedChapterPipelineInput,
} from "../infrastructure/accepted-chapter-pipeline";
import { ensureCurrentSavedVersionStoryFactsForDirectMode } from "../infrastructure/accepted-chapter-fact-preflight";
import { useAppearancePreference } from "../appearance-preference";
import { useOnlineStatus } from "../hooks/use-online-status";
import { useWritingExperience } from "../hooks/use-writing-experience";
import {
  assertContinuationDisclosureMatches,
  prepareContinuationGenerationDisclosure,
  type ContinuationGenerationDisclosure,
} from "../infrastructure/continuation-generation-disclosure";
import {
  continuationConfirmationRemembered,
  rememberContinuationConfirmation,
  type ContinuationConfirmationScope,
} from "../infrastructure/continuation-confirmation-session";
import {
  changedStoryFactOrganizationSpan,
  directStoryFactOrganizerNotice,
  organizeDirectStoryFacts,
  organizeCurrentSavedVersionStoryFacts,
} from "../infrastructure/direct-story-fact-organizer";
import {
  decideEditorGenerationCompletion,
  type EditorGenerationAction,
} from "../infrastructure/editor-generation-completion-policy";
import {
  parseContinuationDirectionOptions,
  type ContinuationDirectionOption,
} from "../infrastructure/continuation-direction-options";
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
import { NovelSkillPanel } from "../components/novel-skill-panel";
import { PreparedNovelSkillReference } from "../components/novel-skill-reference";
import type { NovelSkillProjectState } from "../infrastructure/novel-skill-runtime";
import {
  loadEditorWritingTaskDraft,
  loadOrCreateEditorWritingSessionId,
  sameEditorWritingTaskDraftIdentity,
  saveEditorWritingTaskDraft,
  settleEditorWritingTaskDraft,
  type EditorWritingTask,
  type EditorWritingTaskDraftIdentity,
  type EditorWritingTaskDraftOutcome,
} from "../infrastructure/editor-writing-task-draft-store";
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

type SelectionEditorWritingTask = Exclude<EditorWritingTask, "continuation">;

const selectionWritingActions = Object.freeze([
  Object.freeze({
    action: "selection_rewrite" as const,
    label: "改写",
    instruction: "保留事实、原意和叙事视角，重写选中内容，使表达更清晰自然。",
    requirementPlaceholder: "例如：改成林舟的第一人称。",
  }),
  Object.freeze({
    action: "polish" as const,
    label: "润色",
    instruction: "保持原意、事实和语气，润色选中内容，使文字更自然流畅。",
    requirementPlaceholder: "例如：语言更克制，减少比喻。",
  }),
  Object.freeze({
    action: "expand" as const,
    label: "扩写",
    instruction: "保持既有事实与叙事视角，扩写选中内容的动作、感受和环境细节。",
    requirementPlaceholder: "例如：补充人物动作和现场细节。",
  }),
  Object.freeze({
    action: "shorten" as const,
    label: "缩写",
    instruction:
      "在不改变事实、原意和叙事视角的前提下，缩写选中内容，删除重复和次要表达，保留关键情节与语气。",
    requirementPlaceholder: "例如：保留争执结果，删去重复对话。",
  }),
]) satisfies readonly Readonly<{
  action: SelectionEditorWritingTask;
  label: "改写" | "润色" | "扩写" | "缩写";
  instruction: string;
  requirementPlaceholder: string;
}>[];

const CONTINUATION_REQUIREMENT_PLACEHOLDER = "例如：写到主角发现密信为止。";

function selectionWritingActionDefinition(action: SelectionEditorWritingTask) {
  const definition = selectionWritingActions.find((candidate) => candidate.action === action);
  if (definition === undefined) {
    throw new Error("无法识别当前选区写作任务");
  }
  return definition;
}

function continuationProfileDefaultTarget(profile: ContinuationOutputProfileId): number {
  if (profile === "short") return 1_000;
  if (profile === "long") return 4_000;
  return 2_200;
}

function novelSkillSelectionReasonBrief(reason: string): string {
  const labels: Readonly<Record<string, string>> = {
    not_enabled: "当前项目未启用",
    task_mismatch: "不适用于当前任务",
    context_layer_unavailable: "所需故事资料当前不可用",
    experimental_not_allowed: "当前任务不采用实验性技能",
    precedence_conflict: "与更高优先级技能冲突",
    token_budget_exhausted: "本次可参考篇幅已用完",
    superseded_version: "项目固定使用另一版本",
    archived: "技能已停用",
    selected: "已采用",
  };
  return labels[reason] ?? "本次未采用";
}

const RECOVERY_DRAFT_DEBOUNCE_MS = 350;
const BACKGROUND_FLUSH_TIMEOUT_MS = 3_000;
const COMPACT_EDITOR_MEDIA_QUERY = "(max-width: 64rem)";
const EDITOR_ASSISTANT_DEFAULT_WIDTH_PX = 360;
const EDITOR_ASSISTANT_MIN_WIDTH_PX = 256;
const EDITOR_ASSISTANT_MAX_WIDTH_PX = 560;
const EDITOR_WRITING_MIN_WIDTH_PX = 320;
const EDITOR_ASSISTANT_KEYBOARD_STEP_PX = 8;
const EDITOR_ASSISTANT_KEYBOARD_LARGE_STEP_PX = 32;
const GENERATION_NAVIGATION_SETTLEMENT_TIMEOUT_MS = 15_000;
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
  readonly assistantName: string;
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
  assistantName,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
}: EditorAssistantResizeSeparatorProps) {
  return (
    <div
      className="editor-assistant-resizer"
      role="separator"
      aria-label={`调整正文与${assistantName}宽度`}
      aria-controls="editor-ai-assistant-panel"
      aria-orientation="vertical"
      aria-valuemin={EDITOR_ASSISTANT_MIN_WIDTH_PX}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      aria-valuetext={`${assistantName}宽度 ${String(width)} 像素`}
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

interface DirectGenerationUndo {
  readonly action: EditorGenerationAction;
  readonly baseVersionId: UuidV7;
  readonly appliedVersionId: UuidV7;
  readonly undoLabel: string;
}

interface PreparedContinuationDirections {
  readonly plan: PreparedGenerationPlan;
  readonly disclosure: ContinuationGenerationDisclosure | null;
  readonly authorityRevision: number;
  readonly requirement: string | null;
}

interface EditorWritingTaskDraftSnapshot {
  readonly identity: EditorWritingTaskDraftIdentity;
  readonly requirement: string;
}

interface DirectionFailureNotice {
  readonly title: string;
  readonly description: string;
}

interface LargeDeletionReview {
  readonly routeKey: string;
  readonly chapterId: UuidV7;
  readonly chapterTitle: string;
  readonly baseRevision: number;
  readonly baseVersionId: UuidV7;
  readonly previousCharacterCount: number;
  readonly proposedContent: string;
  readonly cursorOffset: number;
  readonly draftStatus: "saving" | "saved" | "failed";
}

const LARGE_DELETION_MINIMUM_SOURCE_CHARACTERS = 5_000;
const LARGE_DELETION_MINIMUM_REMOVED_CHARACTERS = 3_000;
const LARGE_DELETION_MAXIMUM_REMAINING_RATIO = 0.35;

function requiresLargeDeletionConfirmation(stableContent: string, nextContent: string): boolean {
  const removedCharacters = stableContent.length - nextContent.length;
  return (
    stableContent.length >= LARGE_DELETION_MINIMUM_SOURCE_CHARACTERS &&
    removedCharacters >= LARGE_DELETION_MINIMUM_REMOVED_CHARACTERS &&
    nextContent.length / stableContent.length <= LARGE_DELETION_MAXIMUM_REMAINING_RATIO
  );
}

function chapterVolumeName(outline: Outline | null, chapterTitle: string): string {
  if (outline === null) return "未关联卷";
  const snapshot = outline.toSnapshot();
  const matchingChapters = snapshot.nodes.filter(
    (node) => node.kind === "chapter" && node.title === chapterTitle,
  );
  if (matchingChapters.length !== 1) return "未关联卷";
  const volume = snapshot.nodes.find(
    (node) => node.kind === "volume" && node.id === matchingChapters[0]?.parentId,
  );
  return volume?.title ?? "未关联卷";
}

function versionCharacterDifferenceLabel(targetLength: number, currentLength: number): string {
  const difference = targetLength - currentLength;
  if (difference === 0) return "与当前正文字数相同";
  return `与当前正文相比${difference > 0 ? "多" : "少"} ${Math.abs(difference).toLocaleString("zh-CN")} 字`;
}

function generationActionFromCandidate(
  candidate: AiCandidate,
  versions: readonly ChapterVersion[],
): EditorGenerationAction | null {
  const intent = candidate.applicationIntent;
  if (intent.task === "selection_rewrite") return selectionWritingActionFromIntent(intent);
  if (intent.task !== "continuation") return null;
  const baseVersion =
    candidate.baseVersionId === null
      ? undefined
      : versions.find((version) => version.id === candidate.baseVersionId);
  return (baseVersion?.toSnapshot().content.trim().length ?? 0) === 0 ? "opening" : "continuation";
}

function directGenerationUndoLabel(action: EditorGenerationAction): string {
  if (action === "opening") return "撤销本次开头";
  if (action === "polish") return "撤销本次润色";
  if (action === "expand") return "撤销本次扩写";
  if (action === "shorten") return "撤销本次缩写";
  if (action === "selection_rewrite") return "撤销本次改写";
  return "撤销本次续写";
}

function directGenerationUndoFromCurrentVersion(
  chapter: Chapter,
  versions: readonly ChapterVersion[],
  candidates: readonly AiCandidate[],
): DirectGenerationUndo | null {
  const currentVersion = versions.find((version) => version.id === chapter.currentVersionId);
  if (currentVersion === undefined) return null;
  const sourceCandidateId = currentVersion.toSnapshot().sourceCandidateId;
  if (sourceCandidateId === null) return null;
  const sourceCandidate = candidates.find(
    (item) => item.id === sourceCandidateId && item.status === "accepted",
  );
  if (sourceCandidate?.baseVersionId === null || sourceCandidate?.baseVersionId === undefined) {
    return null;
  }
  const baseVersion = versions.find((version) => version.id === sourceCandidate.baseVersionId);
  if (baseVersion === undefined) return null;
  const action = generationActionFromCandidate(sourceCandidate, versions);
  if (action === null) return null;
  return Object.freeze({
    action,
    baseVersionId: sourceCandidate.baseVersionId,
    appliedVersionId: currentVersion.id,
    undoLabel: directGenerationUndoLabel(action),
  });
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
  | Readonly<{ state: "unavailable"; diagnosticId: string }>
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
      candidate:
        candidates.find((item) => item.purpose === "prose" && item.status === "ready") ?? null,
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
        item.purpose === "prose" &&
        (item.status === "ready" ||
          item.status === "accepted" ||
          item.status === "rejected" ||
          item.status === "expired"),
    ) ?? null;
  return Object.freeze({
    candidate,
    notice:
      candidate === null
        ? "链接指定的生成结果不存在或不属于当前项目与章节；未自动打开其他结果。"
        : null,
  });
}

async function settleIdeaJourneyCandidateDecision(
  runtime: ReturnType<typeof useRuntime>,
  candidateId: UuidV7,
  decision: "accepted" | "rejected",
): Promise<void> {
  let current = await runtime.creativeJourneys.findById(candidateId);
  const finalState = decision === "accepted" ? "candidate_accepted" : "candidate_rejected";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (
      current?.kind !== "idea" ||
      current.candidateId !== candidateId ||
      current.status === "abandoned"
    ) {
      return;
    }
    if (current.status === "completed" && current.currentState === finalState) {
      return;
    }
    const turns = await runtime.creativeJourneys.listTurns(current.id);
    const now = runtime.clock.now();
    const completed = Object.freeze({
      ...current,
      status: "completed" as const,
      currentState: finalState,
      revision: current.revision + 1,
      updatedAt: now,
      completedAt: now,
    });
    try {
      await runtime.creativeJourneys.update(
        completed,
        current.revision,
        Object.freeze({
          id: runtime.ids.next(),
          journeyId: current.id,
          sequence: turns.length + 1,
          kind: "keep" as const,
          questionKey: null,
          generationSource: null,
          providerId: null,
          modelId: null,
          taskKey: null,
          requestId: null,
          snapshot: Object.freeze({ candidateId, decision }),
          createdAt: now,
        }),
      );
      return;
    } catch (cause: unknown) {
      if (
        !(cause instanceof CreativeJourneyStoreError) ||
        cause.code !== "CREATIVE_JOURNEY_REVISION_CONFLICT" ||
        attempt > 0
      ) {
        throw cause;
      }
      current = await runtime.creativeJourneys.findById(candidateId);
    }
  }
}

interface ContinuationDirectionSelection {
  readonly candidate: AiCandidate | null;
  readonly options: readonly ContinuationDirectionOption[];
  readonly candidatesToReject: readonly AiCandidate[];
}

function selectContinuationDirectionCandidate(
  candidates: readonly AiCandidate[],
  chapter: Chapter,
): ContinuationDirectionSelection {
  const readyDirections = candidates.filter(
    (item) => item.purpose === "continuation_directions" && item.status === "ready",
  );
  const selected = readyDirections.find((item) => {
    const snapshot = item.toSnapshot();
    return (
      item.baseVersionId === chapter.currentVersionId &&
      !snapshot.incomplete &&
      parseContinuationDirectionOptions(item.content).ok
    );
  });
  if (selected === undefined) {
    return Object.freeze({
      candidate: null,
      options: Object.freeze([]),
      candidatesToReject: Object.freeze(readyDirections),
    });
  }
  const parsed = parseContinuationDirectionOptions(selected.content);
  if (!parsed.ok) {
    return Object.freeze({
      candidate: null,
      options: Object.freeze([]),
      candidatesToReject: Object.freeze(readyDirections),
    });
  }
  return Object.freeze({
    candidate: selected,
    options: parsed.options,
    candidatesToReject: Object.freeze(readyDirections.filter((item) => item.id !== selected.id)),
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

type EditorRepositoryResult<Value> =
  Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: unknown }>;

type EditorReadOutcome<Value> =
  Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; error: unknown }>;

interface CandidateReadWarning {
  readonly diagnosticId: string;
  readonly isolatedCount: number | null;
}

interface VersionReadWarning {
  readonly diagnosticId: string;
  readonly isolatedCount: number;
}

const EDITOR_AUTHORITY_READ_STAGES: readonly EditorReadStage[] = Object.freeze([
  "project",
  "chapter",
  "chapter_list",
  "recovery_draft",
  "chapter_versions",
]);

async function settleEditorRead<Value>(
  action: () => Promise<EditorRepositoryResult<Value>>,
): Promise<EditorReadOutcome<Value>> {
  try {
    const result = await action();
    return result.ok
      ? Object.freeze({ ok: true as const, value: result.value })
      : Object.freeze({ ok: false as const, error: result.error });
  } catch (cause: unknown) {
    return Object.freeze({ ok: false as const, error: cause });
  }
}

async function readEditorCandidates(
  store: CandidateStore,
  chapterId: UuidV7,
): Promise<EditorRepositoryResult<AiCandidateListWithIsolation>> {
  if (store.listByChapterIdWithIsolation !== undefined) {
    return store.listByChapterIdWithIsolation(chapterId);
  }
  const result = await store.listByChapterId(chapterId);
  return result.ok
    ? Object.freeze({
        ok: true as const,
        value: Object.freeze({
          candidates: result.value,
          isolatedRows: Object.freeze([]),
        }),
      })
    : result;
}

function editorReadDiagnosticCode(stage: EditorReadStage): string {
  if (stage === "ai_candidates") return "LEGACY_CANDIDATE_METADATA_INVALID";
  if (stage === "chapter_versions") return "LEGACY_VERSION_METADATA_INVALID";
  if (stage === "story_governance") return "PROJECT_AREA_READ_FAILED";
  return "EDITOR_AUTHORITY_READ_FAILED";
}
function chapterVersionDiagnosticReference(
  version: Readonly<{ id: string; sequence: number; contentChecksum: string }>,
): SafeUiRouteRowReference {
  return Object.freeze({
    table: "chapter_versions",
    versionId: version.id,
    sequence: version.sequence,
    rowFingerprint: `version-${version.contentChecksum.slice(0, 8).toLowerCase()}`,
  });
}

function editorReadComponentStack(ownershipPath: readonly string[]): string {
  return captureMountedComponentPath(ownershipPath);
}

function withEditorReadRowReference(
  error: UiActionError,
  rowReference: SafeUiRouteRowReference,
): UiActionError {
  Object.defineProperty(error, "details", {
    value: Object.freeze({ rowReference }),
  });
  return error;
}

type ChapterVersionChainEntry = Readonly<{
  id: string;
  parentVersionId: string | null;
  sequence: number;
  contentChecksum: string;
}>;

type ChapterVersionChainAnalysis =
  | Readonly<{
      ok: true;
      isolated: readonly ChapterVersionChainEntry[];
    }>
  | Readonly<{ ok: false; error: UiActionError }>;
const VERSION_CHAIN_READ_FAILURE = "版本历史无法安全读取，已停止写入。";

function invalidChapterVersionChain(
  code: string,
  entry?: ChapterVersionChainEntry,
): ChapterVersionChainAnalysis {
  const error = new UiActionError(code, VERSION_CHAIN_READ_FAILURE);
  return Object.freeze({
    ok: false as const,
    error:
      entry === undefined
        ? error
        : withEditorReadRowReference(error, chapterVersionDiagnosticReference(entry)),
  });
}

function analyzeChapterVersionChain(
  versions: readonly ChapterVersionChainEntry[],
  current: ChapterVersionChainEntry,
  chapterRevision: number,
): ChapterVersionChainAnalysis {
  const byId = new Map<string, ChapterVersionChainEntry>();
  for (const version of versions) {
    if (byId.has(version.id)) {
      return invalidChapterVersionChain("VERSION_ID_DUPLICATED", version);
    }
    byId.set(version.id, version);
  }
  const authorityIds = new Set<string>();
  let expectedSequence = chapterRevision;
  let cursor: ChapterVersionChainEntry = current;
  for (;;) {
    if (authorityIds.has(cursor.id)) {
      return invalidChapterVersionChain("VERSION_PARENT_CHAIN_CYCLE", cursor);
    }
    authorityIds.add(cursor.id);
    if (cursor.sequence !== expectedSequence) {
      return invalidChapterVersionChain("VERSION_SEQUENCE_CHAIN_INVALID", cursor);
    }
    const parentId = cursor.parentVersionId;
    if ((expectedSequence === 1) !== (parentId === null)) {
      return invalidChapterVersionChain("VERSION_PARENT_CHAIN_INVALID", cursor);
    }
    if (parentId === null) break;
    const parent = byId.get(parentId);
    if (parent === undefined) {
      return invalidChapterVersionChain("VERSION_PARENT_MISSING", cursor);
    }
    expectedSequence -= 1;
    cursor = parent;
  }
  return Object.freeze({
    ok: true as const,
    isolated: Object.freeze(versions.filter((version) => !authorityIds.has(version.id))),
  });
}

export function EditorPage() {
  const runtime = useRuntime();
  const editorComponentPath = useComponentOwnershipPath("EditorPage");
  const writingExperience = useWritingExperience();
  const writingModeReady = !writingExperience.loading && writingExperience.preference !== null;
  const directMode = writingExperience.preference?.mode === "direct";
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
  const editorDiagnosticRoute = `${location.pathname}${location.search}`;
  const directOpeningRouteNoticeRef = useRef(readDirectOpeningOrganizationNotice(location.state));
  const routeIdentityRef = useRef(editorRouteKey);
  const currentWritingRouteRef = useRef({ projectId, chapterId, routeKey: editorRouteKey });
  currentWritingRouteRef.current = { projectId, chapterId, routeKey: editorRouteKey };
  const loadOperationRevisionRef = useRef(0);
  const generationOperationRevisionRef = useRef(0);
  const writingModeAuthorityKey =
    writingExperience.preference === null
      ? "loading"
      : `${writingExperience.preference.mode}:${String(writingExperience.preference.revision)}`;
  const writingModeIdentityRef = useRef(writingModeAuthorityKey);
  if (writingModeIdentityRef.current !== writingModeAuthorityKey) {
    writingModeIdentityRef.current = writingModeAuthorityKey;
    generationOperationRevisionRef.current += 1;
  }
  if (routeIdentityRef.current !== editorRouteKey) {
    routeIdentityRef.current = editorRouteKey;
    loadOperationRevisionRef.current += 1;
    generationOperationRevisionRef.current += 1;
  }
  const [project, setProject] = useState<Project | null>(null);
  const [projectDisplayIdentity, setProjectDisplayIdentity] =
    useState<ProjectDisplayIdentity | null>(null);
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
  const [loadDiagnosticId, setLoadDiagnosticId] = useState<string | null>(null);
  const [candidateReadWarning, setCandidateReadWarning] = useState<CandidateReadWarning | null>(
    null,
  );
  const [versionReadWarning, setVersionReadWarning] = useState<VersionReadWarning | null>(null);
  const [candidateRowsRetrying, setCandidateRowsRetrying] = useState(false);
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
  const [volumeName, setVolumeName] = useState("未关联卷");
  const [largeDeletionReview, setLargeDeletionReview] = useState<LargeDeletionReview | null>(null);
  const [largeDeletionDialogOpen, setLargeDeletionDialogOpen] = useState(false);
  const [largeDeletionBusy, setLargeDeletionBusy] = useState(false);
  const [candidate, setCandidate] = useState<AiCandidate | null>(null);
  const [candidateHistory, setCandidateHistory] = useState<readonly AiCandidate[]>([]);
  const [candidatePresentation, setCandidatePresentation] = useState<"ai" | "local" | "unknown">(
    "unknown",
  );
  const [directGenerationUndo, setDirectGenerationUndo] = useState<DirectGenerationUndo | null>(
    null,
  );
  const [directionOptions, setDirectionOptions] = useState<readonly ContinuationDirectionOption[]>(
    [],
  );
  const [directionError, setDirectionError] = useState<DirectionFailureNotice | null>(null);
  const [directionBusy, setDirectionBusy] = useState(false);
  const [preparedDirections, setPreparedDirections] =
    useState<PreparedContinuationDirections | null>(null);
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
  const [candidateOverlapAcknowledged, setCandidateOverlapAcknowledged] = useState(false);
  const [candidateReviewSelection, setCandidateReviewSelection] = useState<EditorSelection>({
    start: 0,
    end: 0,
  });
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [generationPlan, setGenerationPlan] = useState<PreparedGenerationPlan | null>(null);
  const directGenerationRequestIdsRef = useRef(new Set<string>());
  const [continuationDisclosure, setContinuationDisclosure] =
    useState<ContinuationGenerationDisclosure | null>(null);
  const [continuationConfirmationIsRemembered, setContinuationConfirmationIsRemembered] =
    useState(false);
  const [
    rememberContinuationConfirmationForSession,
    setRememberContinuationConfirmationForSession,
  ] = useState(false);
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
  const [activeWritingTask, setActiveWritingTask] = useState<EditorWritingTask>("continuation");
  const [writingRequirement, setWritingRequirement] = useState("");
  const [selectionRewriteBusy, setSelectionRewriteBusy] = useState(false);
  const [selectionRewriteContext, setSelectionRewriteContext] =
    useState<StoryContextCompilationReceipt | null>(null);
  const [selectionRewriteDisclosure, setSelectionRewriteDisclosure] =
    useState<SelectionRewriteDisclosure | null>(null);
  const [lastGenerationAction, setLastGenerationAction] =
    useState<EditorGenerationAction>("continuation");
  const [lastSelectionRewriteInstruction, setLastSelectionRewriteInstruction] =
    useState("保持原意，让表达更自然。");
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
  const [advancedTargetDraft, setAdvancedTargetDraft] = useState("");
  const [advancedTargetError, setAdvancedTargetError] = useState<string | null>(null);
  const [selectionRequestId, setSelectionRequestId] = useState(0);
  const [selectionLength, setSelectionLength] = useState(0);
  const [liveSelection, setLiveSelection] = useState<EditorSelection>({ start: 0, end: 0 });
  const [writingSessionId, setWritingSessionId] = useState<string | null>(null);
  const writingDraftAuthorityRef = useRef("");
  const [novelSkillDrawerOpen, setNovelSkillDrawerOpen] = useState(false);
  const [novelSkillProjectState, setNovelSkillProjectState] =
    useState<NovelSkillProjectState | null>(null);
  const [novelSkillSummaryLoading, setNovelSkillSummaryLoading] = useState(false);
  const [writingDraftPersistenceError, setWritingDraftPersistenceError] = useState<
    "read" | "write" | null
  >(null);
  const [legacyProjectWritingRequirement, setLegacyProjectWritingRequirement] = useState<
    string | null
  >(null);
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
  const [privacyChangeFailure, setPrivacyChangeFailure] = useState<Readonly<{
    description: string;
    supportId: string;
  }> | null>(null);
  const chapterRef = useRef<Chapter | null>(null);
  const authorityWriteBlockedRef = useRef(false);
  const contentRef = useRef("");
  const cursorRef = useRef(0);
  const selectionRef = useRef<EditorSelection>({ start: 0, end: 0 });
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const primaryEditorActionRef = useRef<HTMLButtonElement | null>(null);
  const editorWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const assistantPanelRef = useRef<HTMLElement | null>(null);
  const assistantResizeDragRef = useRef<EditorAssistantResizeDrag | null>(null);
  const writingRequirementRef = useRef<HTMLTextAreaElement | null>(null);
  const writingRequirementValueRef = useRef(writingRequirement);
  writingRequirementValueRef.current = writingRequirement;
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
  const versionRestoreFlightRef = useRef<symbol | null>(null);
  const largeDeletionReviewRef = useRef<LargeDeletionReview | null>(null);
  const largeDeletionFlightRef = useRef<symbol | null>(null);
  const candidateDecisionFenceRef = useRef(false);
  const candidateGenerationFlightRef = useRef<
    "idle" | "preparing" | "awaiting_decision" | "executing" | "deferring"
  >("idle");
  const activeWritingTaskRef = useRef<EditorWritingTask>(activeWritingTask);
  activeWritingTaskRef.current = activeWritingTask;
  const writingSessionIdRef = useRef<string | null>(writingSessionId);
  writingSessionIdRef.current = writingSessionId;
  const generationWritingDraftsRef = useRef(new Map<string, EditorWritingTaskDraftSnapshot>());
  const selectionWritingDraftIdentityRef = useRef<EditorWritingTaskDraftSnapshot | null>(null);
  const currentWritingDraftSnapshotRef = useRef<EditorWritingTaskDraftSnapshot | null>(null);
  const activeGenerationPlanRef = useRef<PreparedGenerationPlan | null>(null);
  const activeGenerationNavigationRef = useRef<{
    readonly id: string;
    readonly session: GenerationNavigationSession;
  } | null>(null);
  const directionCandidateRef = useRef<AiCandidate | null>(null);
  const generationEstimate = generationPlan?.preflight.estimate ?? null;
  const returnedFromAiSettings = searchParams.get("aiSettings") === "returned";

  function publishLargeDeletionReview(review: LargeDeletionReview | null): void {
    largeDeletionReviewRef.current = review;
    setLargeDeletionReview(review);
  }

  function isSameLargeDeletionReview(
    current: LargeDeletionReview | null,
    expected: LargeDeletionReview,
  ): boolean {
    return (
      current?.routeKey === expected.routeKey &&
      current.chapterId === expected.chapterId &&
      current.baseVersionId === expected.baseVersionId &&
      current.proposedContent === expected.proposedContent
    );
  }

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
    candidateGenerationFlightRef.current = "idle";
    const activePlan = activeGenerationPlanRef.current;
    if (
      activePlan !== null &&
      (activePlan.projectId !== projectId || activePlan.chapterId !== chapterId)
    ) {
      void activeGenerationNavigationRef.current?.session.stopAndPreserve().catch(() => undefined);
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
      setDirectionBusy(false);
      setCancelBusy(false);
      setSelectionRewriteBusy(false);
      setSelectionRewriteContext(null);
      setPreparedDirections(null);
      setSelectionRewriteDisclosure(null);
      setContinuationDisclosure(null);
    });
    return () => {
      resetCancelled = true;
      candidateGenerationFlightRef.current = "idle";
      loadOperationRevisionRef.current += 1;
      generationOperationRevisionRef.current += 1;
      void activeGenerationNavigationRef.current?.session.stopAndPreserve().catch(() => undefined);
    };
  }, [chapterId, editorRouteKey, projectId, runtime]);

  useEffect(() => {
    candidateGenerationFlightRef.current = "idle";
    void activeGenerationNavigationRef.current?.session.stopAndPreserve().catch(() => undefined);
    const resetGenerationRevision = generationOperationRevisionRef.current;
    const resetRouteKey = routeIdentityRef.current;
    const resetWritingModeKey = writingModeIdentityRef.current;
    const clearStaleModeState = () => {
      if (
        generationOperationRevisionRef.current !== resetGenerationRevision ||
        routeIdentityRef.current !== resetRouteKey ||
        writingModeIdentityRef.current !== resetWritingModeKey
      ) {
        return;
      }
      setGenerationPlan(null);
      setPreflightOpen(false);
      setContinuationDisclosure(null);
      setPreparedDirections(null);
      setSelectionRewriteDisclosure(null);
      setDirectionBusy(false);
      setSelectionRewriteBusy(false);
    };
    const clearTimer = window.setTimeout(clearStaleModeState, 0);
    return () => {
      window.clearTimeout(clearTimer);
    };
  }, [runtime, writingModeAuthorityKey]);

  function beginGenerationOperation(): Readonly<{ revision: number; routeKey: string }> {
    const revision = generationOperationRevisionRef.current + 1;
    generationOperationRevisionRef.current = revision;
    return Object.freeze({ revision, routeKey: editorRouteKey });
  }

  function blockNewGenerationWhileFragmentNeedsDecision(): boolean {
    const fragment = currentGenerationNavigationGuard()?.unsafeFragment;
    if (fragment?.isPresent() !== true) return false;
    setAssistantOpen(true);
    setEditorNotice("请先复制或明确放弃尚未安全保存的片段，再开始新的生成；正文和版本仍未改变。");
    return true;
  }

  function registerPlanGenerationNavigationGuard(
    plan: PreparedGenerationPlan,
  ): GenerationNavigationSession {
    activeGenerationNavigationRef.current?.session.release();
    const session = beginGenerationNavigationSession({
      id: plan.requestId,
      actionLabel: plan.actionLabel,
      stop: () => cancelGenerationPlan(runtime, plan),
      timeoutMs: GENERATION_NAVIGATION_SETTLEMENT_TIMEOUT_MS,
    });
    activeGenerationPlanRef.current = plan;
    activeGenerationNavigationRef.current = { id: plan.requestId, session };
    return session;
  }

  function stopGenerationForNavigation(plan: PreparedGenerationPlan): Promise<void> {
    const active = activeGenerationNavigationRef.current;
    return active?.id === plan.requestId
      ? active.session.stopAndPreserve()
      : cancelGenerationPlan(runtime, plan).then(() => undefined);
  }

  async function reconcileGenerationNavigationSafety(
    plan: PreparedGenerationPlan,
    cause: unknown,
    receivedVisibleText: string,
  ): Promise<unknown> {
    if (cause === null || receivedVisibleText.trim().length === 0) return null;
    try {
      const [run, task] = await Promise.all([
        runtime.generationGovernance.findRunById(plan.runId),
        runtime.taskCenter.findTaskByIdempotencyKey(plan.idempotencyKey),
      ]);
      if (
        run === null ||
        task === null ||
        run.taskId !== plan.taskId ||
        run.idempotencyKey !== plan.idempotencyKey ||
        !["completed", "cancelled", "failed_final"].includes(run.state) ||
        !["succeeded", "cancelled", "failed"].includes(task.status) ||
        run.candidateId === null
      ) {
        return cause;
      }
      const candidateId = parseUuidV7(run.candidateId);
      if (!candidateId.ok) return cause;
      const loaded = await runtime.repositories.aiCandidates.findById(candidateId.value);
      if (!loaded.ok) return cause;
      const recoveredCandidate = loaded.value;
      if (recoveredCandidate === null) return cause;
      if (
        recoveredCandidate.projectId !== plan.projectId ||
        recoveredCandidate.chapterId !== plan.chapterId ||
        recoveredCandidate.baseVersionId !== plan.baseVersionId
      ) {
        return cause;
      }
      if (recoveredCandidate.purpose !== "continuation_directions") {
        setCandidate(recoveredCandidate);
        setGenerationReceipt(run);
        setGenerationAttemptUsage(await runtime.generationGovernance.listAttemptUsage(plan.runId));
        setEditorNotice(
          "已收到的内容已安全保留为隔离的未完成建议。正文和版本没有改变，你可以查看后再决定是否使用。",
        );
      }
      return null;
    } catch {
      return cause;
    }
  }

  function releaseUnsafeGenerationPreview(): void {
    activeGenerationNavigationRef.current?.session.release();
    activeGenerationNavigationRef.current = null;
    activeGenerationPlanRef.current = null;
    setGenerationPreview("");
  }

  async function copyUnsafeGenerationPreview(): Promise<void> {
    try {
      await window.navigator.clipboard.writeText(generationPreview);
      releaseUnsafeGenerationPreview();
      setEditorNotice("这段未保存内容已复制到剪贴板；现在可以安全离开当前页面。");
    } catch {
      setEditorNotice("复制没有完成。页面仍会保留并保护这段内容，请允许剪贴板访问后重试。");
    }
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
  const recordEditorReadFailure = useCallback(
    function EditorPage(
      readStage: EditorReadStage,
      cause: unknown,
      details: Readonly<{
        rowReferences?: readonly SafeUiRouteRowReference[];
        reasonCodeChain?: readonly string[];
        applicationStack?: readonly string[];
      }> = {},
    ) {
      return recordEditorReadIncident(runtime, {
        route: editorDiagnosticRoute,
        readStage,
        cause,
        timestamp: runtime.clock.now(),
        normalizedErrorCode: editorReadDiagnosticCode(readStage),
        componentStack: editorReadComponentStack(editorComponentPath),
        ...details,
      });
    },
    [editorComponentPath, editorDiagnosticRoute, runtime],
  );

  const reportCandidateReadFailure = useCallback(
    (cause: unknown, isolatedRows: readonly AiCandidateIsolationIncident[] = []) => {
      const incident = recordEditorReadFailure("ai_candidates", cause, {
        rowReferences: isolatedRows.map(({ rowReference }) => rowReference),
        reasonCodeChain: isolatedRows.flatMap(({ reasonCodeChain }) => reasonCodeChain),
        applicationStack: isolatedRows.flatMap(({ applicationStack }) => applicationStack),
      });
      setCandidateReadWarning({
        diagnosticId: incident.diagnosticId,
        isolatedCount: isolatedRows.length === 0 ? null : isolatedRows.length,
      });
      return incident;
    },
    [recordEditorReadFailure],
  );

  const reportVersionReadIsolation = useCallback(
    (isolatedVersions: readonly ChapterVersionChainEntry[]) => {
      const cause = new UiActionError(
        "NON_CURRENT_VERSION_HISTORY_WRITE_BLOCKED",
        "版本分叉，已停止写入。",
      );
      const incident = recordEditorReadFailure("chapter_versions", cause, {
        rowReferences: isolatedVersions.map(chapterVersionDiagnosticReference),
        reasonCodeChain: ["NON_CURRENT_VERSION_HISTORY_WRITE_BLOCKED"],
      });
      setVersionReadWarning({
        diagnosticId: incident.diagnosticId,
        isolatedCount: isolatedVersions.length,
      });
    },
    [recordEditorReadFailure],
  );

  const rejectDirectionCandidateSafely = useCallback(
    async (candidateToReject: AiCandidate | null): Promise<void> => {
      if (
        candidateToReject?.purpose !== "continuation_directions" ||
        candidateToReject.status !== "ready"
      ) {
        return;
      }
      await runtime.useCases.rejectCandidate
        .execute({
          candidateId: candidateToReject.id,
          expectedCandidateRevision: candidateToReject.revision,
        })
        .catch(() => undefined);
    },
    [runtime],
  );

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
      setLiveSelection(selection);
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
    if (!writingModeReady) {
      return;
    }
    const loadRevision = loadOperationRevisionRef.current + 1;
    loadOperationRevisionRef.current = loadRevision;
    const expectedRouteKey = editorRouteKey;
    const isCurrentLoad = (): boolean =>
      loadOperationRevisionRef.current === loadRevision &&
      routeIdentityRef.current === expectedRouteKey;
    const failAuthorityRead = (stage: EditorReadStage, cause: unknown): void => {
      if (!isCurrentLoad()) return;
      clearScheduledPersistence();
      authorityWriteBlockedRef.current = true;
      chapterRef.current = null;
      directionCandidateRef.current = null;
      setProject(null);
      setProjectDisplayIdentity(null);
      setChapter(null);
      setChapters([]);
      setRecoveryDraft(null);
      setVersions([]);
      setCandidate(null);
      setCandidateHistory([]);
      setDirectionOptions([]);
      setDirectGenerationUndo(null);
      setVersionReadWarning(null);
      const incident = recordEditorReadFailure(stage, cause);
      setLoadDiagnosticId(incident.diagnosticId);
      setError(cause);
      setPageState("fatal_error");
    };
    if (chapterId === null || projectId === null) {
      failAuthorityRead(
        "route_identity",
        new UiActionError(
          "EDITOR_ROUTE_IDENTITY_INVALID",
          "页面地址中的项目或章节标识无效。请返回项目列表后重新打开。",
        ),
      );
      return;
    }

    clearScheduledPersistence();
    chapterRef.current = null;
    setLoadDiagnosticId(null);
    setCandidateReadWarning(null);
    setVersionReadWarning(null);
    authorityWriteBlockedRef.current = false;
    setError(null);
    setProjectDisplayIdentity(null);
    const restoredContinuationPreference = loadEditorContinuationPreference(
      window.localStorage,
      projectId,
    );
    setContinuationPreference(restoredContinuationPreference);
    setAdvancedTargetDraft(
      restoredContinuationPreference.customTargetVisibleCharacters?.toString() ?? "",
    );
    setAdvancedTargetError(null);
    setPageState("loading");
    setRecoveryDecisionOpen(false);
    setRecoveryDraft(null);
    setRecoveryCopySaved(false);
    setVersionToRestore(null);
    versionRestoreFlightRef.current = null;
    setVersionRestoreBusy(false);
    editorReplacementFenceRef.current = false;
    setEditorReplacementLocked(false);
    largeDeletionReviewRef.current = null;
    largeDeletionFlightRef.current = null;
    setLargeDeletionReview(null);
    setLargeDeletionDialogOpen(false);
    setLargeDeletionBusy(false);
    setVolumeName("未关联卷");
    setCandidateReviewOpen(false);
    setCandidateDiff(null);
    setCandidateDiffDecisions({});
    setCandidateReviewError(null);
    setCandidateRevisionSaved(false);
    setCandidateReviewConflict(null);
    setCandidateCopySaved(false);
    setCandidate(null);
    setCandidateHistory([]);
    setCandidatePresentation("unknown");
    setSelectionRewriteBusy(false);
    setSelectionRewriteContext(null);
    setDirectGenerationUndo(null);
    setEditorNotice(null);
    setStoryStateUpdate({ state: "idle" });
    const [
      projectResult,
      chapterResult,
      chaptersResult,
      draftResult,
      versionsResult,
      candidatesResult,
      projectDisplayIdentityResult,
    ] = await Promise.all([
      settleEditorRead(() => runtime.repositories.projects.findById(projectId)),
      settleEditorRead(() => runtime.repositories.chapters.findById(chapterId)),
      settleEditorRead(() => runtime.repositories.chapters.listByProjectId(projectId)),
      settleEditorRead(() => runtime.repositories.recoveryDrafts.findByChapterId(chapterId)),
      settleEditorRead(() => runtime.useCases.listChapterVersions.execute(chapterId)),
      settleEditorRead(() => readEditorCandidates(runtime.repositories.aiCandidates, chapterId)),
      settleEditorRead(() =>
        runtime.repositories.projectDisplayIdentities.resolveByProjectId(projectId),
      ),
    ]);

    if (!isCurrentLoad()) {
      return;
    }

    if (!projectResult.ok) {
      failAuthorityRead("project", projectResult.error);
      return;
    }
    if (!chapterResult.ok) {
      failAuthorityRead("chapter", chapterResult.error);
      return;
    }
    if (!chaptersResult.ok) {
      failAuthorityRead("chapter_list", chaptersResult.error);
      return;
    }
    if (!draftResult.ok) {
      failAuthorityRead("recovery_draft", draftResult.error);
      return;
    }
    if (!versionsResult.ok) {
      failAuthorityRead("chapter_versions", versionsResult.error);
      return;
    }
    if (projectResult.value === null) {
      failAuthorityRead(
        "project",
        new UiActionError("PROJECT_NOT_FOUND", "没有找到这个项目。请返回项目列表后重新打开。"),
      );
      return;
    }
    if (chapterResult.value?.projectId !== projectId) {
      failAuthorityRead(
        "chapter",
        new UiActionError("CHAPTER_NOT_FOUND", "没有找到这个章节。请返回章节列表后重新打开。"),
      );
      return;
    }

    const loadedProject = projectResult.value;
    const loadedChapter = chapterResult.value;
    if (!chaptersResult.value.some((item) => item.id === loadedChapter.id)) {
      failAuthorityRead(
        "chapter_list",
        new UiActionError(
          "CHAPTER_NOT_FOUND",
          "章节列表与当前章节不一致。为保护正文，已停止写入。",
        ),
      );
      return;
    }

    const loadedVersions = versionsResult.value;
    const currentVersion = loadedVersions.find(
      (version) => version.id === loadedChapter.currentVersionId,
    );
    if (currentVersion === undefined) {
      failAuthorityRead(
        "chapter_versions",
        new UiActionError("CURRENT_VERSION_MISSING", VERSION_CHAIN_READ_FAILURE),
      );
      return;
    }
    const versionSnapshots = loadedVersions.map((version) => version.toSnapshot());
    const currentVersionSnapshot = currentVersion.toSnapshot();
    const versionChain = analyzeChapterVersionChain(
      versionSnapshots,
      currentVersionSnapshot,
      loadedChapter.revision,
    );
    if (!versionChain.ok) {
      failAuthorityRead("chapter_versions", versionChain.error);
      return;
    }
    if (
      versionSnapshots.some(
        (version) => version.projectId !== projectId || version.chapterId !== chapterId,
      )
    ) {
      failAuthorityRead(
        "chapter_versions",
        new UiActionError(
          "CURRENT_VERSION_SCOPE_MISMATCH",
          "当前正文版本与项目或章节不一致。为保护正文，已停止写入。",
        ),
      );
      return;
    }
    if (currentVersionSnapshot.content !== loadedChapter.content) {
      failAuthorityRead(
        "chapter_versions",
        new UiActionError(
          "CURRENT_VERSION_CONTENT_MISMATCH",
          "当前正文与不会被改动的历史版本不一致。为保护正文，已停止写入。",
        ),
      );
      return;
    }

    for (const version of versionSnapshots) {
      const checksum = await runtime.hasher.sha256(version.content);
      if (!isCurrentLoad()) {
        return;
      }
      if (!checksum.ok) {
        const failure = withEditorReadRowReference(
          new UiActionError(
            "CURRENT_VERSION_CHECKSUM_UNAVAILABLE",
            "暂时无法核对不会被改动的历史版本的内容校验值。为保护正文，已停止写入。",
          ),
          chapterVersionDiagnosticReference(version),
        );
        Object.defineProperty(failure, "cause", { value: checksum.error });
        failAuthorityRead("chapter_versions", failure);
        return;
      }
      if (checksum.value !== version.contentChecksum) {
        failAuthorityRead(
          "chapter_versions",
          withEditorReadRowReference(
            new UiActionError(
              "CURRENT_VERSION_CHECKSUM_MISMATCH",
              "不会被改动的历史版本的内容校验值不一致。为保护正文，已停止写入。",
            ),
            chapterVersionDiagnosticReference(version),
          ),
        );
        return;
      }
    }

    recoverEditorReadIncidents(runtime, {
      projectId,
      chapterId,
      timestamp: runtime.clock.now(),
      readStages: EDITOR_AUTHORITY_READ_STAGES,
    });
    setLoadDiagnosticId(null);
    if (versionChain.isolated.length > 0) {
      authorityWriteBlockedRef.current = true;
      reportVersionReadIsolation(versionChain.isolated);
    } else {
      authorityWriteBlockedRef.current = false;
      setVersionReadWarning(null);
    }

    let loadedCandidates: readonly AiCandidate[] = [];
    if (!candidatesResult.ok) {
      reportCandidateReadFailure(candidatesResult.error);
    } else {
      loadedCandidates = candidatesResult.value.candidates;
      if (candidatesResult.value.isolatedRows.length > 0) {
        reportCandidateReadFailure(
          new UiActionError("LEGACY_CANDIDATE_METADATA_INVALID", "部分生成记录暂时无法安全读取。"),
          candidatesResult.value.isolatedRows,
        );
      } else {
        recoverEditorReadIncidents(runtime, {
          projectId,
          chapterId,
          timestamp: runtime.clock.now(),
          readStages: ["ai_candidates"],
        });
        setCandidateReadWarning(null);
      }
    }

    const draft = draftResult.value;
    const directionSelection = directMode
      ? selectContinuationDirectionCandidate(loadedCandidates, loadedChapter)
      : Object.freeze({
          candidate: null,
          options: Object.freeze([]),
          candidatesToReject: Object.freeze(
            loadedCandidates.filter(
              (item) => item.purpose === "continuation_directions" && item.status === "ready",
            ),
          ),
        });
    const previousDirectionCandidate = directionCandidateRef.current;
    directionCandidateRef.current = directionSelection.candidate;
    setDirectionOptions(directionSelection.options);
    setDirectionError(null);
    const candidatesToReject = [...directionSelection.candidatesToReject];
    if (
      previousDirectionCandidate !== null &&
      previousDirectionCandidate.id !== directionSelection.candidate?.id &&
      !candidatesToReject.some((item) => item.id === previousDirectionCandidate.id)
    ) {
      candidatesToReject.push(previousDirectionCandidate);
    }
    void Promise.all(candidatesToReject.map((item) => rejectDirectionCandidateSafely(item)));
    setProject(loadedProject);
    setProjectDisplayIdentity(
      projectDisplayIdentityResult.ok ? projectDisplayIdentityResult.value : null,
    );
    setChapter(loadedChapter);
    setChapters(chaptersResult.value);
    chapterRef.current = loadedChapter;
    setVersions(loadedVersions);
    const candidateSelection = selectEditorCandidate(
      loadedCandidates,
      requestedCandidateId,
      projectId,
      chapterId,
    );
    setDirectGenerationUndo(
      directMode
        ? directGenerationUndoFromCurrentVersion(loadedChapter, loadedVersions, loadedCandidates)
        : null,
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
        if (journey?.kind === "idea" && journey.candidateId === candidateSelection.candidate.id) {
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
    let journeyRepairNotice: string | null = null;
    if (
      candidateSelection.candidate?.status === "accepted" ||
      candidateSelection.candidate?.status === "rejected"
    ) {
      try {
        await settleIdeaJourneyCandidateDecision(
          runtime,
          candidateSelection.candidate.id,
          candidateSelection.candidate.status,
        );
      } catch {
        journeyRepairNotice =
          "正文和隔离结果状态均已安全保留；未完成创作记录暂时无法结算，下次打开时会继续修复。";
      }
      if (!isCurrentLoad()) return;
    }
    setCandidateHistory(loadedCandidates);
    setCandidate(candidateSelection.candidate);
    const restoredGenerationAction =
      candidateSelection.candidate === null
        ? null
        : generationActionFromCandidate(candidateSelection.candidate, loadedVersions);
    if (restoredGenerationAction !== null) setLastGenerationAction(restoredGenerationAction);
    setCandidatePresentation(presentation);

    const olderRecoveryDraftNotice =
      draft !== null && draft.baseRevision !== loadedChapter.revision
        ? "旧草稿已保留，请选择如何处理。"
        : null;

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
    setRecoveryDecisionOpen(draft !== null && versionChain.isolated.length === 0);
    setSaveState("saved_local");
    const directOpeningRouteNotice = directOpeningRouteNoticeRef.current;
    directOpeningRouteNoticeRef.current = null;
    setEditorNotice(
      olderRecoveryDraftNotice ??
        journeyRepairNotice ??
        candidateSelection.notice ??
        directOpeningRouteNotice,
    );
    setFindStatus(null);
    setError(null);
    setPageState("ready");
    const continuousState = (runtime.story as Partial<RuntimeStory>).continuousState;
    if (continuousState !== undefined) {
      void continuousState
        .inspectProject(projectId)
        .then((dashboard) => {
          if (!isCurrentLoad()) return;
          recoverEditorReadIncidents(runtime, {
            projectId,
            chapterId,
            timestamp: runtime.clock.now(),
            readStages: ["story_governance"],
          });
          setStoryStateUpdate(
            dashboard.detectedCount > 0
              ? {
                  state: "ready",
                  detectedCount: dashboard.detectedCount,
                  needsConfirmationCount: dashboard.needsConfirmationCount,
                  reversibleCount: dashboard.reversibleCount,
                  skippedTaskCount: 0,
                }
              : { state: "idle" },
          );
        })
        .catch((cause: unknown) => {
          if (!isCurrentLoad()) return;
          const incident = recordEditorReadFailure("story_governance", cause, {
            reasonCodeChain: ["REPOSITORY_ERROR"],
          });
          setStoryStateUpdate({ state: "unavailable", diagnosticId: incident.diagnosticId });
        });
    }
  }, [
    chapterId,
    clearScheduledPersistence,
    directMode,
    editorRouteKey,
    projectId,
    recordEditorReadFailure,
    rejectDirectionCandidateSafely,
    reportCandidateReadFailure,
    reportVersionReadIsolation,
    requestedCandidateId,
    resetEditorHistory,
    runtime,
    scheduleSelection,
    writingModeReady,
  ]);

  const retryCandidateRows = useCallback(async (): Promise<void> => {
    if (candidateRowsRetrying || projectId === null || chapterId === null) return;
    const expectedRouteKey = editorRouteKey;
    setCandidateRowsRetrying(true);
    try {
      const result = await settleEditorRead(() =>
        readEditorCandidates(runtime.repositories.aiCandidates, chapterId),
      );
      if (routeIdentityRef.current !== expectedRouteKey) return;
      if (!result.ok) {
        reportCandidateReadFailure(result.error);
        return;
      }
      if (result.value.isolatedRows.length > 0) {
        reportCandidateReadFailure(
          new UiActionError("LEGACY_CANDIDATE_METADATA_INVALID", "部分生成记录暂时无法安全读取。"),
          result.value.isolatedRows,
        );
        return;
      }

      recoverEditorReadIncidents(runtime, {
        projectId,
        chapterId,
        timestamp: runtime.clock.now(),
        readStages: ["ai_candidates"],
      });
      setCandidateReadWarning(null);

      const stableChapter = chapterRef.current;
      if (stableChapter?.id !== chapterId) return;
      const safeCandidates = result.value.candidates;
      const candidateSelection = selectEditorCandidate(
        safeCandidates,
        requestedCandidateId,
        projectId,
        chapterId,
      );
      setCandidateHistory(safeCandidates);
      setCandidate(candidateSelection.candidate);
      const restoredGenerationAction =
        candidateSelection.candidate === null
          ? null
          : generationActionFromCandidate(candidateSelection.candidate, versions);
      if (restoredGenerationAction !== null) setLastGenerationAction(restoredGenerationAction);
      setCandidatePresentation(
        candidateSelection.candidate === null ||
          candidateSelection.candidate.toSnapshot().source === "generate"
          ? "unknown"
          : "ai",
      );
      setDirectGenerationUndo(
        directMode
          ? directGenerationUndoFromCurrentVersion(stableChapter, versions, safeCandidates)
          : null,
      );
      if (candidateSelection.notice !== null) setEditorNotice(candidateSelection.notice);

      if (writingModeReady) {
        const directionSelection = directMode
          ? selectContinuationDirectionCandidate(safeCandidates, stableChapter)
          : Object.freeze({
              candidate: null,
              options: Object.freeze([]),
              candidatesToReject: Object.freeze(
                safeCandidates.filter(
                  (item) => item.purpose === "continuation_directions" && item.status === "ready",
                ),
              ),
            });
        const previousDirectionCandidate = directionCandidateRef.current;
        directionCandidateRef.current = directionSelection.candidate;
        setDirectionOptions(directionSelection.options);
        const candidatesToReject = [...directionSelection.candidatesToReject];
        if (
          previousDirectionCandidate !== null &&
          previousDirectionCandidate.id !== directionSelection.candidate?.id &&
          !candidatesToReject.some((item) => item.id === previousDirectionCandidate.id)
        ) {
          candidatesToReject.push(previousDirectionCandidate);
        }
        void Promise.all(candidatesToReject.map((item) => rejectDirectionCandidateSafely(item)));
      }
    } finally {
      if (routeIdentityRef.current === expectedRouteKey) setCandidateRowsRetrying(false);
    }
  }, [
    candidateRowsRetrying,
    chapterId,
    directMode,
    editorRouteKey,
    projectId,
    rejectDirectionCandidateSafely,
    reportCandidateReadFailure,
    requestedCandidateId,
    runtime,
    versions,
    writingModeReady,
  ]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => {
      loadOperationRevisionRef.current += 1;
      clearScheduledPersistence();
    };
  }, [clearScheduledPersistence, load]);

  const loadNovelSkillSummary = useCallback(async (): Promise<void> => {
    if (pageState !== "ready" || projectId === null) {
      setNovelSkillProjectState(null);
      return;
    }
    const expectedRouteKey = editorRouteKey;
    setNovelSkillSummaryLoading(true);
    try {
      const next = await runtime.novelSkills.listProjectState(projectId);
      if (routeIdentityRef.current === expectedRouteKey) setNovelSkillProjectState(next);
    } catch {
      if (routeIdentityRef.current === expectedRouteKey) setNovelSkillProjectState(null);
    } finally {
      if (routeIdentityRef.current === expectedRouteKey) setNovelSkillSummaryLoading(false);
    }
  }, [editorRouteKey, pageState, projectId, runtime.novelSkills]);

  useEffect(() => {
    void Promise.resolve().then(loadNovelSkillSummary);
  }, [loadNovelSkillSummary]);

  useEffect(() => {
    if (pageState !== "ready" || projectId === null || chapter === null) return undefined;
    const storyProjectId = parseStoryUuidV7(projectId);
    if (!storyProjectId.ok) return undefined;
    const expectedRouteKey = editorRouteKey;
    let active = true;
    void runtime.story.outlines.findByProjectId(storyProjectId.value).then((result) => {
      if (!active || routeIdentityRef.current !== expectedRouteKey) return;
      setVolumeName(result.ok ? chapterVolumeName(result.value, chapter.title) : "未关联卷");
    });
    return () => {
      active = false;
    };
  }, [chapter, editorRouteKey, pageState, projectId, runtime.story.outlines]);

  useEffect(() => {
    const currentDirectionCandidate = directionCandidateRef.current;
    if (currentDirectionCandidate === null) return;
    const remainsCurrent =
      writingModeReady &&
      directMode &&
      chapterId !== null &&
      chapter?.id === chapterId &&
      currentDirectionCandidate.chapterId === chapterId &&
      currentDirectionCandidate.baseVersionId === chapter.currentVersionId &&
      currentDirectionCandidate.status === "ready";
    if (remainsCurrent) return;

    directionCandidateRef.current = null;
    setDirectionOptions([]);
    setDirectionError(null);
    void rejectDirectionCandidateSafely(currentDirectionCandidate);
  }, [
    chapter?.currentVersionId,
    chapter?.id,
    chapterId,
    directMode,
    rejectDirectionCandidateSafely,
    writingModeReady,
  ]);

  useEffect(() => {
    if (readDirectOpeningOrganizationNotice(location.state) === null) return;
    void navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: null },
    );
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  useLayoutEffect(() => {
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

  useLayoutEffect(() => {
    if (pageState !== "ready" || projectId === null || chapterId === null || chapter === null) {
      return;
    }
    const authorityKey = `${projectId}:${chapterId}:${chapter.currentVersionId}`;
    if (writingDraftAuthorityRef.current === authorityKey) return;
    writingDraftAuthorityRef.current = authorityKey;
    const sessionId = loadOrCreateEditorWritingSessionId(
      window.localStorage,
      { projectId, chapterId, versionId: chapter.currentVersionId },
      () => runtime.ids.next(),
    );
    writingSessionIdRef.current = sessionId;
    activeWritingTaskRef.current = "continuation";
    if (sessionId === null) {
      writingRequirementValueRef.current = "";
      void Promise.resolve().then(() => {
        if (writingDraftAuthorityRef.current !== authorityKey) return;
        setWritingSessionId(null);
        if (
          activeWritingTaskRef.current === "continuation" &&
          writingRequirementValueRef.current.length === 0
        ) {
          setActiveWritingTask("continuation");
          setWritingRequirement("");
          setLegacyProjectWritingRequirement(null);
          setWritingDraftPersistenceError("read");
        }
      });
      return;
    }
    const identity = {
      projectId,
      chapterId,
      versionId: chapter.currentVersionId,
      sessionId,
      task: "continuation" as const,
      selection: null,
    };
    const restored = loadEditorWritingTaskDraft(window.localStorage, identity);
    const legacyRequirement =
      loadEditorContinuationPreference(window.localStorage, projectId)
        .customDestinationInstruction ?? "";
    writingRequirementValueRef.current = restored.value;
    const nextLegacyRequirement =
      restored.ok && restored.value.length === 0 && legacyRequirement.trim().length > 0
        ? legacyRequirement
        : null;
    void Promise.resolve().then(() => {
      if (writingDraftAuthorityRef.current !== authorityKey) return;
      setWritingSessionId(sessionId);
      if (
        activeWritingTaskRef.current === "continuation" &&
        writingRequirementValueRef.current === restored.value
      ) {
        setActiveWritingTask("continuation");
        setWritingRequirement(restored.value);
        setLegacyProjectWritingRequirement(nextLegacyRequirement);
        setWritingDraftPersistenceError(restored.ok ? null : "read");
      }
    });
  }, [chapter, chapterId, pageState, projectId, runtime.ids]);

  useLayoutEffect(() => {
    if (
      pageState !== "ready" ||
      projectId === null ||
      chapterId === null ||
      chapter === null ||
      writingSessionId === null ||
      activeWritingTask === "continuation"
    ) {
      return;
    }
    const normalizedSelection = normalizeEditorSelection(liveSelection, content.length);
    if (
      normalizedSelection.start === normalizedSelection.end ||
      content.slice(normalizedSelection.start, normalizedSelection.end).trim().length === 0
    ) {
      activeWritingTaskRef.current = "continuation";
      const restored = loadEditorWritingTaskDraft(window.localStorage, {
        projectId,
        chapterId,
        versionId: chapter.currentVersionId,
        sessionId: writingSessionId,
        task: "continuation",
        selection: null,
      });
      writingRequirementValueRef.current = restored.value;
      let active = true;
      void Promise.resolve().then(() => {
        if (
          !active ||
          activeWritingTaskRef.current !== "continuation" ||
          writingRequirementValueRef.current !== restored.value
        ) {
          return;
        }
        setActiveWritingTask("continuation");
        setWritingRequirement(restored.value);
        setWritingDraftPersistenceError(restored.ok ? null : "read");
      });
      return () => {
        active = false;
      };
    }
    const restored = loadEditorWritingTaskDraft(window.localStorage, {
      projectId,
      chapterId,
      versionId: chapter.currentVersionId,
      sessionId: writingSessionId,
      task: activeWritingTask,
      selection: normalizedSelection,
    });
    writingRequirementValueRef.current = restored.value;
    const expectedWritingTask = activeWritingTask;
    let active = true;
    void Promise.resolve().then(() => {
      if (
        !active ||
        activeWritingTaskRef.current !== expectedWritingTask ||
        writingRequirementValueRef.current !== restored.value
      ) {
        return;
      }
      setWritingRequirement(restored.value);
      setWritingDraftPersistenceError(restored.ok ? null : "read");
    });
    return () => {
      active = false;
    };
  }, [
    activeWritingTask,
    chapter,
    chapterId,
    content,
    liveSelection,
    pageState,
    projectId,
    writingSessionId,
  ]);

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
      if (
        authorityWriteBlockedRef.current ||
        stableChapter === null ||
        snapshot === stableChapter.content
      ) {
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
      if (authorityWriteBlockedRef.current || stableChapter === null) {
        return;
      }
      const organizeLocalStoryFacts =
        (await runtime.writingExperience.getOrInitialize()).mode === "direct";
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
        organizeLocalStoryFacts,
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

      if (saved.value.version === null) {
        return;
      }

      // The durable task source follows the immutable trigger reason so a retry
      // can distinguish automatic and explicit saves without renderer state.
      const savedVersion = saved.value.version.toSnapshot();
      const savedSpan = changedStoryFactOrganizationSpan(
        stableChapter.content,
        savedVersion.content,
      );
      const pipelineInput = createLocalAcceptedVersionPipelineInput({
        projectId: savedVersion.projectId,
        chapterId: savedVersion.chapterId,
        versionId: savedVersion.id,
        source: reason === "autosave" ? "autosave" : "manual_save",
        acceptedCharacterCount: savedVersion.content.length,
        organizeLocalStoryFacts: savedVersion.organizeLocalStoryFacts,
      });

      setStoryStateUpdate({ state: "idle" });

      try {
        // Persist the idempotent recovery task after the immutable version exists.
        // The accepted text version is already immutable. Any later failure can only
        // affect rebuildable story data, never the author's saved text.
        await ensureAcceptedChapterPipelineTask(runtime, pipelineInput);
      } catch (cause: unknown) {
        const message = projectOrdinaryUiError(cause).description;
        setEditorNotice(`正文已安全保存；${message}`);
      }

      const organizeSavedFacts =
        savedSpan === null || !savedVersion.organizeLocalStoryFacts
          ? Promise.resolve()
          : organizeDirectStoryFacts(
              {
                facts: runtime.story.facts,
                factService: runtime.story.factService,
                hasher: runtime.hasher,
                now: () => runtime.clock.now(),
                sourceIsCurrent: async () => {
                  const latest = await runtime.repositories.chapters.findById(
                    savedVersion.chapterId,
                  );
                  if (!latest.ok) throw latest.error;
                  return (
                    latest.value?.projectId === savedVersion.projectId &&
                    latest.value.currentVersionId === savedVersion.id
                  );
                },
              },
              {
                projectId: savedVersion.projectId,
                chapterId: savedVersion.chapterId,
                versionId: savedVersion.id,
                versionCreatedAt: savedVersion.createdAt,
                acceptedText: savedSpan.text,
                acceptedStartOffset: savedSpan.startOffset,
                sourceLength: savedSpan.sourceLength,
                sourceContentHash: savedVersion.contentChecksum,
                currentVersionId: saved.value.chapter.currentVersionId,
                localOnly: saved.value.chapter.isLocalOnly,
              },
            )
              .then((receipt) => {
                setEditorNotice(directStoryFactOrganizerNotice(receipt));
              })
              .catch((cause: unknown) => {
                setEditorNotice("正文和版本已保存；本地设定整理暂未完成，可稍后重新整理。");
                throw cause;
              });
      void organizeSavedFacts
        .then(() => runAcceptedChapterPipeline(runtime, pipelineInput))
        .then((receipt) => {
          if (receipt.status === "partially_completed") {
            setEditorNotice("正文已安全保存；部分本地整理暂未完成，稍后会自动重试。");
          }
        })
        .catch((cause: unknown) => {
          const message = projectOrdinaryUiError(cause).description;
          setEditorNotice(`正文已安全保存；部分本地整理暂未完成：${message}`);
        });
    },
    [loadVersions, runtime],
  );

  const hasPendingPersistence = useCallback((): boolean => {
    const stableChapter = chapterRef.current;
    return (
      composingRef.current ||
      largeDeletionReviewRef.current !== null ||
      editorReplacementFenceRef.current ||
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
      if (largeDeletionReviewRef.current !== null) {
        return Object.freeze({
          status: "blocked",
          code: "LARGE_DELETION_REQUIRES_CONFIRMATION",
          message: "本次修改将删除大量正文；请先确认创建版本，或恢复修改前正文。",
        });
      }
      if (editorReplacementFenceRef.current) {
        return Object.freeze({
          status: "blocked",
          code: "EDITOR_REPLACEMENT_ACTIVE",
          message: "正文版本操作仍在完成，请等待后再切换章节。",
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
      largeDeletionReview !== null ||
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
    largeDeletionReview,
  ]);

  const manualSave = useCallback(async (): Promise<void> => {
    if (authorityWriteBlockedRef.current || project?.status !== "active" || composingRef.current) {
      return;
    }
    if (largeDeletionReviewRef.current !== null) {
      setLargeDeletionDialogOpen(true);
      setEditorNotice("请先确认这次大幅删除；确认前只保留恢复草稿，不会创建正式版本。");
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

  async function persistLargeDeletionDraft(review: LargeDeletionReview): Promise<void> {
    try {
      await enqueue(() => persistDraft(review.proposedContent, review.cursorOffset));
      const current = largeDeletionReviewRef.current;
      if (current === null || !isSameLargeDeletionReview(current, review)) return;
      publishLargeDeletionReview(Object.freeze({ ...current, draftStatus: "saved" }));
      setSaveState("dirty");
    } catch (cause: unknown) {
      const current = largeDeletionReviewRef.current;
      if (current === null || !isSameLargeDeletionReview(current, review)) return;
      publishLargeDeletionReview(Object.freeze({ ...current, draftStatus: "failed" }));
      setError(cause);
      setSaveState("save_failed");
    }
  }

  async function retryLargeDeletionDraft(): Promise<void> {
    const review = largeDeletionReviewRef.current;
    if (review === null || review.draftStatus === "saving") return;
    const next = Object.freeze({ ...review, draftStatus: "saving" as const });
    publishLargeDeletionReview(next);
    setError(null);
    await persistLargeDeletionDraft(next);
  }

  async function confirmLargeDeletion(): Promise<void> {
    const review = largeDeletionReviewRef.current;
    const stableChapter = chapterRef.current;
    if (
      review?.draftStatus !== "saved" ||
      stableChapter === null ||
      largeDeletionFlightRef.current !== null
    ) {
      return;
    }
    if (
      routeIdentityRef.current !== review.routeKey ||
      stableChapter.id !== review.chapterId ||
      stableChapter.revision !== review.baseRevision ||
      stableChapter.currentVersionId !== review.baseVersionId ||
      contentRef.current !== review.proposedContent
    ) {
      setError(
        new UiActionError(
          "LARGE_DELETION_AUTHORITY_CHANGED",
          "章节或稳定版本已经变化。本次大幅删除仍保留在恢复草稿中，请重新读取后再决定。",
        ),
      );
      return;
    }
    const flight = Symbol("large-deletion-confirmation");
    largeDeletionFlightRef.current = flight;
    setLargeDeletionBusy(true);
    setError(null);
    clearScheduledPersistence();
    try {
      await enqueue(() => commitSnapshot(review.proposedContent, review.cursorOffset, "manual"));
      if (
        largeDeletionFlightRef.current === flight &&
        routeIdentityRef.current === review.routeKey &&
        isSameLargeDeletionReview(largeDeletionReviewRef.current, review)
      ) {
        publishLargeDeletionReview(null);
        setLargeDeletionDialogOpen(false);
        setEditorNotice(
          `已确认《${review.chapterTitle}》的大幅删除并创建新的稳定版本；修改前正文仍保留在版本历史中。`,
        );
      }
    } catch {
      // commitSnapshot keeps the exact save error and recovery draft visible.
    } finally {
      if (largeDeletionFlightRef.current === flight) {
        largeDeletionFlightRef.current = null;
        setLargeDeletionBusy(false);
      }
    }
  }

  async function restoreBeforeLargeDeletion(): Promise<void> {
    const review = largeDeletionReviewRef.current;
    const stableChapter = chapterRef.current;
    if (
      review?.draftStatus !== "saved" ||
      stableChapter === null ||
      largeDeletionFlightRef.current !== null
    ) {
      return;
    }
    if (
      routeIdentityRef.current !== review.routeKey ||
      stableChapter.id !== review.chapterId ||
      stableChapter.revision !== review.baseRevision ||
      stableChapter.currentVersionId !== review.baseVersionId
    ) {
      setError(
        new UiActionError(
          "LARGE_DELETION_AUTHORITY_CHANGED",
          "章节或稳定版本已经变化，无法直接恢复。短正文仍保留在恢复草稿中。",
        ),
      );
      return;
    }
    const flight = Symbol("large-deletion-restore");
    largeDeletionFlightRef.current = flight;
    setLargeDeletionBusy(true);
    setError(null);
    try {
      const draft = await runtime.repositories.recoveryDrafts.findByChapterId(stableChapter.id);
      if (!draft.ok) throw draft.error;
      if (
        draft.value?.baseRevision !== review.baseRevision ||
        draft.value.content !== review.proposedContent
      ) {
        throw new UiActionError(
          "RECOVERY_DRAFT_CHANGED",
          "恢复草稿已经变化。为避免删除新的输入，当前没有清理任何内容。",
        );
      }
      const removed = await runtime.repositories.recoveryDrafts.delete(
        stableChapter.id,
        draft.value.id,
      );
      if (!removed.ok) throw removed.error;
      if (
        largeDeletionFlightRef.current !== flight ||
        routeIdentityRef.current !== review.routeKey
      ) {
        return;
      }
      const selection = Object.freeze({
        start: stableChapter.content.length,
        end: stableChapter.content.length,
      });
      contentRef.current = stableChapter.content;
      setContent(stableChapter.content);
      setRecovered(false);
      setSaveState("saved_local");
      publishLargeDeletionReview(null);
      setLargeDeletionDialogOpen(false);
      resetEditorHistory();
      scheduleSelection(selection, true);
      persistEditorView(selection);
      setEditorNotice(`已恢复《${review.chapterTitle}》修改前的稳定正文；版本历史没有改变。`);
    } catch (cause: unknown) {
      setError(cause);
      setSaveState("save_failed");
    } finally {
      if (largeDeletionFlightRef.current === flight) {
        largeDeletionFlightRef.current = null;
        setLargeDeletionBusy(false);
      }
    }
  }

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
    if (authorityWriteBlockedRef.current || draft === null) {
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
    if (authorityWriteBlockedRef.current || draft === null || stableChapter === null) {
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
      authorityWriteBlockedRef.current ||
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

  function stageLargeDeletionProtection(nextContent: string, selection: EditorSelection): void {
    const stableChapter = chapterRef.current;
    if (
      stableChapter === null ||
      largeDeletionReviewRef.current !== null ||
      !requiresLargeDeletionConfirmation(stableChapter.content, nextContent)
    ) {
      return;
    }
    clearScheduledPersistence();
    const review = Object.freeze({
      routeKey: editorRouteKey,
      chapterId: stableChapter.id,
      chapterTitle: stableChapter.title,
      baseRevision: stableChapter.revision,
      baseVersionId: stableChapter.currentVersionId,
      previousCharacterCount: stableChapter.content.length,
      proposedContent: nextContent,
      cursorOffset: Math.min(selection.start, nextContent.length),
      draftStatus: "saving" as const,
    });
    publishLargeDeletionReview(review);
    setLargeDeletionDialogOpen(true);
    setLargeDeletionBusy(false);
    setError(null);
    void persistLargeDeletionDraft(review);
  }

  function markEditorContentDirty(nextContent: string, selection: EditorSelection): void {
    if (editorReplacementFenceRef.current) {
      return;
    }
    stageLargeDeletionProtection(nextContent, selection);
    contentRef.current = nextContent;
    selectionRef.current = selection;
    cursorRef.current = selection.start;
    setSelectionLength(Math.max(0, selection.end - selection.start));
    setLiveSelection(selection);
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
    if (editorReplacementFenceRef.current || largeDeletionReviewRef.current !== null) {
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
    stageLargeDeletionProtection(finalContent, selectionAfter);
    contentRef.current = finalContent;
    selectionRef.current = selectionAfter;
    cursorRef.current = selectionAfter.start;
    setSelectionLength(Math.max(0, selectionAfter.end - selectionAfter.start));
    setLiveSelection(selectionAfter);
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
    setAdvancedTargetDraft(next.customTargetVisibleCharacters?.toString() ?? "");
    setAdvancedTargetError(null);
    if (projectId !== null) {
      saveEditorContinuationPreference(window.localStorage, projectId, next);
    }
  }

  function writingTaskDraftIdentity(
    task: EditorWritingTask,
  ): EditorWritingTaskDraftIdentity | null {
    const stableChapter = chapterRef.current;
    const currentRoute = currentWritingRouteRef.current;
    const currentSessionId = writingSessionIdRef.current;
    if (
      currentRoute.projectId === null ||
      currentRoute.chapterId === null ||
      stableChapter === null ||
      currentSessionId === null ||
      stableChapter.projectId !== currentRoute.projectId ||
      stableChapter.id !== currentRoute.chapterId
    ) {
      return null;
    }
    if (task === "continuation") {
      return Object.freeze({
        projectId: currentRoute.projectId,
        chapterId: currentRoute.chapterId,
        versionId: stableChapter.currentVersionId,
        sessionId: currentSessionId,
        task,
        selection: null,
      });
    }
    const selection = normalizeEditorSelection(selectionRef.current, stableChapter.content.length);
    if (
      selection.start === selection.end ||
      stableChapter.content.slice(selection.start, selection.end).trim().length === 0
    ) {
      return null;
    }
    return Object.freeze({
      projectId: currentRoute.projectId,
      chapterId: currentRoute.chapterId,
      versionId: stableChapter.currentVersionId,
      sessionId: currentSessionId,
      task,
      selection,
    });
  }

  function currentWritingTaskDraftIdentity(): EditorWritingTaskDraftIdentity | null {
    return writingTaskDraftIdentity(activeWritingTaskRef.current);
  }

  function writingTaskDraftSnapshot(
    task: EditorWritingTask,
    requirement: string,
  ): EditorWritingTaskDraftSnapshot | null {
    const identity = writingTaskDraftIdentity(task);
    return identity === null ? null : Object.freeze({ identity, requirement });
  }

  function settleWritingTaskDraft(
    snapshot: EditorWritingTaskDraftSnapshot | null,
    outcome: EditorWritingTaskDraftOutcome,
  ): void {
    if (snapshot === null) return;
    const settled = settleEditorWritingTaskDraft(
      window.localStorage,
      snapshot.identity,
      outcome,
      snapshot.requirement,
    );
    if (!settled) {
      setWritingDraftPersistenceError("write");
      return;
    }
    const currentRoute = currentWritingRouteRef.current;
    const stableChapter = chapterRef.current;
    const currentSelection =
      snapshot.identity.selection === null || stableChapter === null
        ? null
        : normalizeEditorSelection(selectionRef.current, stableChapter.content.length);
    const currentSnapshot = currentWritingDraftSnapshotRef.current;
    const snapshotStillCurrent =
      currentSnapshot !== null &&
      sameEditorWritingTaskDraftIdentity(currentSnapshot.identity, snapshot.identity) &&
      currentSnapshot.requirement === snapshot.requirement &&
      currentRoute.projectId === snapshot.identity.projectId &&
      currentRoute.chapterId === snapshot.identity.chapterId &&
      stableChapter?.currentVersionId === snapshot.identity.versionId &&
      writingSessionIdRef.current === snapshot.identity.sessionId &&
      activeWritingTaskRef.current === snapshot.identity.task &&
      (snapshot.identity.selection === null ||
        (currentSelection !== null &&
          currentSelection.start === snapshot.identity.selection.start &&
          currentSelection.end === snapshot.identity.selection.end));
    if (
      outcome === "in_progress" ||
      outcome === "failed_final" ||
      outcome === "recoverable_failure" ||
      outcome === "result_needs_review" ||
      (!sameEditorWritingTaskDraftIdentity(currentWritingTaskDraftIdentity(), snapshot.identity) &&
        !snapshotStillCurrent) ||
      writingRequirementValueRef.current !== snapshot.requirement
    ) {
      return;
    }
    writingRequirementValueRef.current = "";
    currentWritingDraftSnapshotRef.current = Object.freeze({
      identity: snapshot.identity,
      requirement: "",
    });
    setWritingRequirement("");
    setWritingDraftPersistenceError(null);
  }

  async function generationFailureDraftOutcome(
    plan: PreparedGenerationPlan,
    receivedVisibleText: string,
  ): Promise<EditorWritingTaskDraftOutcome> {
    if (receivedVisibleText.trim().length > 0) return "recoverable_failure";
    try {
      const run = await runtime.generationGovernance.findRunById(plan.runId);
      if (run === null) return "failed_final";
      if (run.state === "completed") return "generation_succeeded";
      if (run.state === "failed_final" || run.state === "cancelled") return "failed_final";
      return "result_needs_review";
    } catch {
      return "result_needs_review";
    }
  }

  function selectionFailureDraftOutcome(
    cause: unknown,
    receivedVisibleText: string,
  ): EditorWritingTaskDraftOutcome {
    if (receivedVisibleText.trim().length > 0) return "recoverable_failure";
    if (cause instanceof AggregateError) return "result_needs_review";
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "PROVIDER_RESULT_AMBIGUOUS"
    ) {
      return "result_needs_review";
    }
    return "failed_final";
  }

  function requirementForWritingTask(task: EditorWritingTask): string {
    const identity = writingTaskDraftIdentity(task);
    if (identity === null) return "";
    if (activeWritingTaskRef.current === task) return writingRequirementValueRef.current;
    const restored = loadEditorWritingTaskDraft(window.localStorage, identity);
    if (!restored.ok) setWritingDraftPersistenceError("read");
    return restored.value;
  }

  function activateWritingTask(task: EditorWritingTask): void {
    const identity = writingTaskDraftIdentity(task);
    if (identity === null) return;
    const restored = loadEditorWritingTaskDraft(window.localStorage, identity);
    currentWritingDraftSnapshotRef.current = Object.freeze({
      identity,
      requirement: restored.value,
    });
    activeWritingTaskRef.current = task;
    setActiveWritingTask(task);
    writingRequirementValueRef.current = restored.value;
    setWritingRequirement(restored.value);
    setWritingDraftPersistenceError(restored.ok ? null : "read");
    setSelectionRewriteDisclosure(null);
    window.requestAnimationFrame(() =>
      writingRequirementRef.current?.focus({ preventScroll: true }),
    );
  }

  function updateWritingRequirement(value: string): void {
    writingRequirementValueRef.current = value;
    setWritingRequirement(value);
    setSelectionRewriteDisclosure(null);
    setPreparedDirections(null);
    const identity = writingTaskDraftIdentity(activeWritingTaskRef.current);
    if (identity === null) return;
    currentWritingDraftSnapshotRef.current = Object.freeze({ identity, requirement: value });
    const saved = saveEditorWritingTaskDraft(window.localStorage, identity, value);
    setWritingDraftPersistenceError(saved ? null : "write");
  }

  function restoreLegacyWritingRequirementForCurrentChapter(): void {
    if (legacyProjectWritingRequirement === null) return;
    const identity = writingTaskDraftIdentity("continuation");
    if (identity === null) {
      setWritingDraftPersistenceError("write");
      return;
    }
    activeWritingTaskRef.current = "continuation";
    setActiveWritingTask("continuation");
    writingRequirementValueRef.current = legacyProjectWritingRequirement;
    setWritingRequirement(legacyProjectWritingRequirement);
    setSelectionRewriteDisclosure(null);
    const saved = saveEditorWritingTaskDraft(
      window.localStorage,
      identity,
      legacyProjectWritingRequirement,
    );
    setWritingDraftPersistenceError(saved ? null : "write");
    if (saved) setLegacyProjectWritingRequirement(null);
    window.requestAnimationFrame(() =>
      writingRequirementRef.current?.focus({ preventScroll: true }),
    );
  }

  async function generateCandidate(
    partialCandidateId: UuidV7 | null = null,
    directDirection: string | null = null,
  ): Promise<void> {
    if (blockNewGenerationWhileFragmentNeedsDecision()) return;
    if (
      continuationPreference.customTargetVisibleCharacters !== null &&
      advancedTargetDraft !== continuationPreference.customTargetVisibleCharacters.toString()
    ) {
      setAdvancedTargetError("请输入 200–12,000 之间的整数；当前输入尚未保存。");
      setEditorNotice("请先修正高级篇幅中的目标字数，再开始创作。");
      return;
    }
    if (
      authorityWriteBlockedRef.current ||
      candidateGenerationFlightRef.current !== "idle" ||
      chapterId === null ||
      saveState === "dirty" ||
      saveState === "saving"
    ) {
      return;
    }
    candidateGenerationFlightRef.current = "preparing";
    const directAtStart = directMode;
    const savedContinuationRequirement = requirementForWritingTask("continuation");
    const writingDraftAtStart = writingTaskDraftSnapshot(
      "continuation",
      savedContinuationRequirement,
    );
    const savedDirectRequirement = directAtStart ? savedContinuationRequirement : "";
    const directRequirement =
      directDirection === null
        ? savedDirectRequirement
        : savedDirectRequirement.trim().length === 0
          ? directDirection
          : `${directDirection}\n作者补充要求：${savedDirectRequirement}`;
    const normalizedDirectDirection =
      directRequirement.trim().length === 0 ? null : directRequirement.normalize("NFC").trim();
    const normalizedCustomDestinationInstruction = savedContinuationRequirement
      .normalize("NFC")
      .trim();
    const professionalDestination =
      normalizedCustomDestinationInstruction.length > 0
        ? "custom_instruction"
        : continuationPreference.profile === "short"
          ? "next_segment"
          : "complete_scene";
    const operation = beginGenerationOperation();
    setLastGenerationAction(
      (chapterRef.current?.content.trim().length ?? 0) === 0 ? "opening" : "continuation",
    );
    setSelectionRewriteContext(null);
    setContinuationDisclosure(null);
    setContinuationConfirmationIsRemembered(false);
    setRememberContinuationConfirmationForSession(false);
    setCandidateBusy(true);
    setGenerationStage("preparing");
    setError(null);
    setGenerationError(null);
    setGenerationReceipt(null);
    setGenerationAttemptUsage([]);
    let preparedDraftRequestId: string | null = null;
    try {
      const plan = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: editorClean,
        networkAvailable: online,
        cursorUtf16: directAtStart
          ? contentRef.current.length
          : normalizeEditorSelection(selectionRef.current, contentRef.current.length).start,
        outputProfile: continuationPreference.profile,
        customTargetVisibleCharacters: continuationPreference.customTargetVisibleCharacters,
        destination: directAtStart
          ? normalizedDirectDirection === null
            ? "complete_scene"
            : "custom_instruction"
          : professionalDestination,
        customDestinationInstruction: directAtStart
          ? normalizedDirectDirection
          : normalizedCustomDestinationInstruction.length > 0
            ? normalizedCustomDestinationInstruction
            : null,
        contextBudgetProfile:
          continuationPreference.profile === "long"
            ? "long"
            : continuationPreference.profile === "short"
              ? "economy"
              : "standard",
        ...(partialCandidateId === null ? {} : { partialCandidateId }),
      });
      if (!isCurrentGenerationOperation(operation)) return;
      setGenerationPlan(plan);
      if (writingDraftAtStart !== null) {
        generationWritingDraftsRef.current.set(plan.requestId, writingDraftAtStart);
        preparedDraftRequestId = plan.requestId;
      }
      if (directAtStart) directGenerationRequestIdsRef.current.add(plan.requestId);
      const continuationActionDisclosure = await prepareContinuationGenerationDisclosure(
        runtime,
        plan,
      );
      if (!isCurrentGenerationOperation(operation)) return;
      setContinuationDisclosure(continuationActionDisclosure);
      const confirmationScope = continuationConfirmationScope(plan, continuationActionDisclosure);
      setContinuationConfirmationIsRemembered(
        confirmationScope !== null &&
          continuationConfirmationRemembered(window.sessionStorage, confirmationScope),
      );
      setRememberContinuationConfirmationForSession(false);
      setDeferredGeneration(plan.deferredRequest);
      await loadBudgetForm(plan, () => isCurrentGenerationOperation(operation));
      if (!isCurrentGenerationOperation(operation)) return;
      if (
        plan.preflight.canStart &&
        !plan.preflight.requiresConfirmation &&
        continuationActionDisclosure === null
      ) {
        candidateGenerationFlightRef.current = "executing";
        await executePreparedGeneration(plan, operation);
      } else {
        candidateGenerationFlightRef.current = "awaiting_decision";
        setPreflightOpen(true);
      }
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) {
        setGenerationError(cause);
        settleWritingTaskDraft(writingDraftAtStart, "failed_final");
        if (preparedDraftRequestId !== null) {
          generationWritingDraftsRef.current.delete(preparedDraftRequestId);
        }
      }
    } finally {
      if (isCurrentGenerationOperation(operation)) setCandidateBusy(false);
      if (
        isCurrentGenerationOperation(operation) &&
        candidateGenerationFlightRef.current === "preparing"
      ) {
        candidateGenerationFlightRef.current = "idle";
      }
    }
  }

  function reportDirectionFailure(
    input: Readonly<{
      stage: "prepare_disclosure" | "pre_dispatch_check" | "provider_dispatch" | "persist_result";
      cause: unknown;
      dispatched: boolean | "unknown";
      description: string;
    }>,
  ): void {
    const currentChapter = chapterRef.current;
    const incident = recordSafeOperationIncident({
      operation: "continuation",
      stage: input.stage,
      cause: input.cause,
      projectId: currentChapter?.projectId ?? projectId,
      chapterId: currentChapter?.id ?? chapterId,
      requestId: preparedDirections?.plan.requestId ?? null,
      dispatched: input.dispatched,
    });
    const stageLabel =
      input.stage === "prepare_disclosure"
        ? "准备发送前说明"
        : input.stage === "pre_dispatch_check"
          ? "确认发送前的最后核对"
          : input.stage === "provider_dispatch"
            ? "等待创作服务返回"
            : "整理已经收到的方向";
    const sendSummary =
      input.dispatched === false
        ? "本次没有发送，自动重试为 0 次。"
        : input.dispatched === true
          ? "本次已经发送 1 次，自动重试为 0 次；请在服务使用记录中核对。"
          : "目前无法确认本次是否已发送，系统不会自动重试；请查看服务使用记录。";
    const title =
      input.stage === "prepare_disclosure" || input.stage === "pre_dispatch_check"
        ? "暂时无法准备方向"
        : input.stage === "provider_dispatch"
          ? "方向生成未完成"
          : "收到的方向暂时无法使用";
    setDirectionError(
      Object.freeze({
        title,
        description: `${input.description} 当前阶段：${stageLabel}。${sendSummary}问题编号（联系支持时提供）：${incident.supportId}。`,
      }),
    );
  }

  async function prepareContinuationDirections(): Promise<void> {
    if (blockNewGenerationWhileFragmentNeedsDecision()) return;
    const stableChapter = chapterRef.current;
    const authorityAtStart = writingExperience.preference;
    if (
      !writingModeReady ||
      authorityAtStart?.mode !== "direct" ||
      stableChapter === null ||
      chapterId === null ||
      stableChapter.id !== chapterId ||
      pageState !== "ready" ||
      !editorClean ||
      contentRef.current !== stableChapter.content ||
      candidateBusy
    ) {
      return;
    }

    const operation = beginGenerationOperation();
    const normalizedRequirement = requirementForWritingTask("continuation")
      .normalize("NFKC")
      .trim();
    setDirectionBusy(true);
    setCandidateBusy(true);
    setDirectionError(null);
    setPreparedDirections(null);
    try {
      const plan = await prepareGenerationPlan(runtime, chapterId, {
        chapterSaved: true,
        networkAvailable: online,
        cursorUtf16: stableChapter.content.length,
        purpose: "continuation_directions",
        customDestinationInstruction:
          normalizedRequirement.length === 0 ? null : normalizedRequirement,
        contextBudgetProfile:
          continuationPreference.profile === "long"
            ? "long"
            : continuationPreference.profile === "short"
              ? "economy"
              : "standard",
      });
      if (!isCurrentGenerationOperation(operation)) return;
      if (!plan.preflight.canStart) {
        reportDirectionFailure({
          stage: "prepare_disclosure",
          cause:
            plan.preflight.blockers[0] ??
            new UiActionError("DIRECTION_PREFLIGHT_BLOCKED", "方向生成前检查未通过。"),
          dispatched: false,
          description:
            "当前创作服务未通过生成前检查，请按页面提示检查负责创作的模型安排、资料范围或隐私设置。",
        });
        return;
      }
      const disclosure = await prepareContinuationGenerationDisclosure(runtime, plan);
      if (!isCurrentGenerationOperation(operation)) return;
      const currentAuthority = await runtime.writingExperience.getOrInitialize();
      if (
        !isCurrentGenerationOperation(operation) ||
        currentAuthority.mode !== "direct" ||
        currentAuthority.revision !== authorityAtStart.revision
      ) {
        setEditorNotice("写作方式已经变化；本次没有调用 AI，请重新查看方向生成信息。");
        return;
      }
      setPreparedDirections(
        Object.freeze({
          plan,
          disclosure,
          authorityRevision: currentAuthority.revision,
          requirement: normalizedRequirement.length === 0 ? null : normalizedRequirement,
        }),
      );
      setEditorNotice("方向生成信息已准备好；明确确认前不会调用 AI。");
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) {
        reportDirectionFailure({
          stage: "prepare_disclosure",
          cause,
          dispatched: false,
          description: "本地资料或发送前说明没有准备完成。你的自定义方向仍保留，可以重试。",
        });
      }
    } finally {
      if (isCurrentGenerationOperation(operation)) {
        setDirectionBusy(false);
        setCandidateBusy(false);
      }
    }
  }

  async function confirmContinuationDirections(): Promise<void> {
    if (blockNewGenerationWhileFragmentNeedsDecision()) return;
    const pending = preparedDirections;
    const stableChapter = chapterRef.current;
    if (
      pending === null ||
      stableChapter === null ||
      chapterId === null ||
      stableChapter.id !== chapterId ||
      !editorClean ||
      contentRef.current !== stableChapter.content ||
      candidateBusy
    ) {
      return;
    }

    const operation = beginGenerationOperation();
    setDirectionBusy(true);
    setCandidateBusy(true);
    setDirectionError(null);
    let executionRequested = false;
    let navigationSettlement: GenerationNavigationSession | null = null;
    let navigationCause: unknown = null;
    let receivedVisibleText = "";
    try {
      const [authorityBeforeDispatch, currentChapterResult] = await Promise.all([
        runtime.writingExperience.getOrInitialize(),
        runtime.repositories.chapters.findById(chapterId),
      ]);
      if (!isCurrentGenerationOperation(operation)) return;
      const currentChapter = currentChapterResult.ok ? currentChapterResult.value : null;
      if (
        authorityBeforeDispatch.mode !== "direct" ||
        authorityBeforeDispatch.revision !== pending.authorityRevision ||
        currentChapter?.currentVersionId !== pending.plan.baseVersionId
      ) {
        setPreparedDirections(null);
        setEditorNotice("写作方式或正文版本已经变化；本次没有调用 AI，请重新查看方向生成信息。");
        return;
      }
      const currentDisclosure = await prepareContinuationGenerationDisclosure(
        runtime,
        pending.plan,
      );
      assertContinuationDisclosureMatches(pending.disclosure, currentDisclosure);
      if (!isCurrentGenerationOperation(operation)) return;

      executionRequested = true;
      navigationSettlement = registerPlanGenerationNavigationGuard(pending.plan);
      const result = await executeGenerationPlan(
        runtime,
        pending.plan,
        (next) => {
          receivedVisibleText = next;
        },
        {
          generationRetryLimit: 0,
        },
      );
      const generatedCandidate = result.ok ? result.value.candidate : null;
      if (!isCurrentGenerationOperation(operation)) {
        await rejectDirectionCandidateSafely(generatedCandidate);
        return;
      }
      if (!result.ok || generatedCandidate === null) {
        navigationCause = result.ok
          ? new UiActionError("DIRECTION_RESULT_MISSING", "创作服务没有返回可用的方向结果。")
          : result.error;
        setPreparedDirections(null);
        reportDirectionFailure({
          stage: "provider_dispatch",
          cause: result.ok
            ? new UiActionError("DIRECTION_RESULT_MISSING", "创作服务没有返回可用的方向结果。")
            : result.error,
          dispatched: "unknown",
          description:
            "创作服务没有完成这组方向。你的自定义方向仍保留，可以先查看服务使用记录，再决定是否重试。",
        });
        return;
      }

      const [authorityAfterGeneration, latestChapterResult] = await Promise.all([
        runtime.writingExperience.getOrInitialize(),
        runtime.repositories.chapters.findById(chapterId),
      ]);
      if (!isCurrentGenerationOperation(operation)) {
        await rejectDirectionCandidateSafely(generatedCandidate);
        return;
      }
      const latestChapter = latestChapterResult.ok ? latestChapterResult.value : null;
      if (
        authorityAfterGeneration.mode !== "direct" ||
        authorityAfterGeneration.revision !== pending.authorityRevision ||
        latestChapter?.currentVersionId !== stableChapter.currentVersionId
      ) {
        await rejectDirectionCandidateSafely(generatedCandidate);
        setPreparedDirections(null);
        return;
      }

      const parsed = parseContinuationDirectionOptions(generatedCandidate.content);
      if (
        generatedCandidate.purpose !== "continuation_directions" ||
        generatedCandidate.status !== "ready" ||
        generatedCandidate.baseVersionId !== stableChapter.currentVersionId ||
        generatedCandidate.toSnapshot().incomplete ||
        !parsed.ok
      ) {
        await rejectDirectionCandidateSafely(generatedCandidate);
        setPreparedDirections(null);
        reportDirectionFailure({
          stage: "persist_result",
          cause: new UiActionError(
            parsed.ok
              ? "DIRECTION_RESULT_SCOPE_MISMATCH"
              : `DIRECTION_RESPONSE_${parsed.reason.toUpperCase()}`,
            "已经收到的内容无法安全整理为三个创作方向。",
          ),
          dispatched: true,
          description: "已经收到的内容无法安全整理为三个创作方向；这份内容不会写入正文。",
        });
        return;
      }

      const previousDirectionCandidate = directionCandidateRef.current;
      directionCandidateRef.current = generatedCandidate;
      setDirectionOptions(parsed.options);
      setPreparedDirections(null);
      setDirectionError(null);
      if (
        previousDirectionCandidate !== null &&
        previousDirectionCandidate.id !== generatedCandidate.id
      ) {
        await rejectDirectionCandidateSafely(previousDirectionCandidate);
      }
    } catch (cause: unknown) {
      if (executionRequested) navigationCause = cause;
      if (isCurrentGenerationOperation(operation)) {
        setPreparedDirections(null);
        reportDirectionFailure({
          stage: executionRequested ? "provider_dispatch" : "pre_dispatch_check",
          cause,
          dispatched: executionRequested ? "unknown" : false,
          description: executionRequested
            ? "方向生成没有完成。请先查看服务使用记录，再决定是否重试。"
            : "正文、写作方式或发送前说明在确认前发生变化，请重新查看后再试。",
        });
      }
    } finally {
      if (navigationSettlement !== null) {
        const safeCause = await reconcileGenerationNavigationSafety(
          pending.plan,
          navigationCause,
          receivedVisibleText,
        );
        navigationSettlement.settle(safeCause);
        if (safeCause === null) {
          if (activeGenerationPlanRef.current === pending.plan) {
            activeGenerationPlanRef.current = null;
          }
          if (activeGenerationNavigationRef.current?.session === navigationSettlement) {
            navigationSettlement.release();
            activeGenerationNavigationRef.current = null;
          }
        }
      }
      if (isCurrentGenerationOperation(operation)) {
        setDirectionBusy(false);
        setCandidateBusy(false);
      }
    }
  }

  async function rewriteSelectedText(
    instructionOverride: string | null = null,
    directAction: EditorGenerationAction = "selection_rewrite",
  ): Promise<void> {
    if (blockNewGenerationWhileFragmentNeedsDecision()) return;
    const stableChapter = chapterRef.current;
    if (
      authorityWriteBlockedRef.current ||
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
          "请先在正文中选择要修改的文字，再从创作助手开始改写。",
          "尚未选择正文",
        ),
      );
      return;
    }
    const authorityAtStart = writingExperience.preference;
    if (authorityAtStart === null) return;
    const operation = beginGenerationOperation();
    const directAtStart = authorityAtStart.mode === "direct";
    const selectionAction: EditorGenerationAction =
      directAction === "polish" || directAction === "expand" || directAction === "shorten"
        ? directAction
        : "selection_rewrite";
    const selectedRequirementDraft = requirementForWritingTask(selectionAction);
    const writingDraftAtStart = writingTaskDraftSnapshot(selectionAction, selectedRequirementDraft);
    selectionWritingDraftIdentityRef.current = writingDraftAtStart;
    const selectedRequirement = selectedRequirementDraft.normalize("NFC").trim();
    const rewriteInstruction =
      instructionOverride ??
      (selectedRequirement.length > 0
        ? selectedRequirement
        : selectionWritingActionDefinition(selectionAction).instruction);

    setLastGenerationAction(selectionAction);
    setLastSelectionRewriteInstruction(rewriteInstruction);
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
    let selectionRequestId: string | null = null;
    let receivedVisibleText = "";
    let candidatePersisted = false;
    let selectionSettlementCause: unknown = null;
    let selectionSession: GenerationNavigationSession | null = null;
    let retainUnsafeSelectionPreview = false;
    let writingDraftOutcome: EditorWritingTaskDraftOutcome = "in_progress";
    const releaseUnsafeSelectionFragment = (): void => {
      if (
        selectionSession !== null &&
        activeGenerationNavigationRef.current?.session === selectionSession
      ) {
        selectionSession.release();
        activeGenerationNavigationRef.current = null;
      }
      if (isCurrentGenerationOperation(operation)) setGenerationPreview("");
    };
    const copyUnsafeSelectionFragment = async (): Promise<void> => {
      await window.navigator.clipboard.writeText(receivedVisibleText);
      releaseUnsafeSelectionFragment();
      if (isCurrentGenerationOperation(operation)) {
        setEditorNotice("这段未保存内容已复制到剪贴板；正文和版本没有变化。");
      }
    };
    try {
      const selectedText = stableChapter.content.slice(selection.start, selection.end);
      const selectedHash = await runtime.hasher.sha256(selectedText);
      if (!selectedHash.ok) {
        throw selectedHash.error;
      }
      if (!isCurrentGenerationOperation(operation)) return;
      let activeDisclosure = selectionRewriteDisclosure;
      if (activeDisclosure === null) {
        activeDisclosure = await prepareSelectionRewrite(runtime, {
          chapterId: stableChapter.id,
          baseVersionId: stableChapter.currentVersionId,
          action: selectionAction,
          selection: {
            startUtf16: selection.start,
            endUtf16: selection.end,
            selectedTextSha256: selectedHash.value,
          },
          instruction: rewriteInstruction,
        });
        if (!isCurrentGenerationOperation(operation)) return;
        setSelectionRewriteDisclosure(activeDisclosure);
        setEditorNotice("发送前说明已准备好；确认前不会调用 AI。请核对后再继续。");
        return;
      }
      const authorityBeforeDispatch = await runtime.writingExperience.getOrInitialize();
      if (
        !isCurrentGenerationOperation(operation) ||
        authorityBeforeDispatch.mode !== authorityAtStart.mode ||
        authorityBeforeDispatch.revision !== authorityAtStart.revision
      ) {
        writingDraftOutcome = "failed_final";
        setSelectionRewriteDisclosure(null);
        setEditorNotice("写作方式已经变化；本次没有调用 AI，请重新查看发送前说明。");
        return;
      }
      const selectionNavigationId = runtime.ids.next();
      activeGenerationNavigationRef.current?.session.release();
      selectionSession = beginGenerationNavigationSession({
        id: selectionNavigationId,
        actionLabel: selectionRewriteActionLabel(selectionAction),
        timeoutMs: GENERATION_NAVIGATION_SETTLEMENT_TIMEOUT_MS,
        stop: async () => {
          if (selectionRequestId !== null) {
            await runtime.modelGateway.cancelGeneration(selectionRequestId).catch(() => false);
          }
        },
        unsafeFragment: {
          isPresent: () =>
            !candidatePersisted &&
            selectionSettlementCause !== null &&
            receivedVisibleText.trim().length > 0,
          copyAndRelease: copyUnsafeSelectionFragment,
          discardAndRelease: releaseUnsafeSelectionFragment,
        },
      });
      activeGenerationNavigationRef.current = {
        id: selectionNavigationId,
        session: selectionSession,
      };
      const assertNotStopped = (): void => {
        if (!selectionSession?.stopRequested()) return;
        throw new ModelCenterError(
          "MODEL_GENERATION_CANCELLED",
          "已在发送前安全停止，本次没有调用模型。",
          true,
        );
      };
      const result = await createSelectionRewriteCandidate(runtime, {
        chapterId: stableChapter.id,
        baseVersionId: stableChapter.currentVersionId,
        action: selectionAction,
        selection: {
          startUtf16: selection.start,
          endUtf16: selection.end,
          selectedTextSha256: selectedHash.value,
        },
        instruction: rewriteInstruction,
        disclosureFingerprint: activeDisclosure.fingerprint,
        humanConfirmed: true,
        onBeforeDispatch: ({ requestId }) => {
          selectionRequestId = requestId;
          assertNotStopped();
        },
        assertBeforeProviderDispatch: assertNotStopped,
        onDelta: (next) => {
          receivedVisibleText = next;
          if (isCurrentGenerationOperation(operation)) setGenerationPreview(next);
        },
      });
      candidatePersisted = true;
      writingDraftOutcome = "generation_succeeded";
      if (!isCurrentGenerationOperation(operation)) return;
      setSelectionRewriteDisclosure(null);
      const previousCandidate = candidate;
      setSelectionRewriteContext(directAtStart ? null : result.contextCompilation);
      if (
        previousCandidate !== null &&
        (previousCandidate.status === "accepted" || previousCandidate.status === "rejected")
      ) {
        await recordWritingFeedbackSafely({
          action: "regenerated",
          candidateId: previousCandidate.id,
        });
      }
      await completeGeneratedCandidate({
        candidate: result.candidate,
        action: selectionAction,
        qualityGateOutcome: null,
        professionalNotice: `已生成 ${String(result.rewrittenSelection.length)} 个字符的${selectionRewriteActionLabel(selectionAction)}建议。正文尚未改变，请先比较再决定是否创建新版本。`,
      });
    } catch (cause: unknown) {
      selectionSettlementCause = cause;
      if (isCurrentGenerationOperation(operation)) {
        writingDraftOutcome = selectionFailureDraftOutcome(cause, receivedVisibleText);
        setSelectionRewriteDisclosure(null);
        setGenerationError(selectionRewriteUiError(cause));
      }
    } finally {
      if (selectionSession !== null) {
        const safeCause =
          candidatePersisted || receivedVisibleText.trim().length === 0
            ? null
            : (selectionSettlementCause ??
              new Error("已收到的内容尚未安全保存，请先复制或明确放弃。"));
        retainUnsafeSelectionPreview = safeCause !== null;
        selectionSession.settle(safeCause);
        if (
          safeCause === null &&
          activeGenerationNavigationRef.current?.session === selectionSession
        ) {
          selectionSession.release();
          activeGenerationNavigationRef.current = null;
        }
      }
      if (isCurrentGenerationOperation(operation)) {
        setSelectionRewriteBusy(false);
        setCandidateBusy(false);
        if (!retainUnsafeSelectionPreview) setGenerationPreview("");
      }
      settleWritingTaskDraft(writingDraftAtStart, writingDraftOutcome);
      if (
        writingDraftOutcome === "generation_succeeded" ||
        writingDraftOutcome === "failed_final" ||
        writingDraftOutcome === "cancelled_before_dispatch"
      ) {
        const currentSelectionDraft = selectionWritingDraftIdentityRef.current;
        if (
          currentSelectionDraft !== null &&
          sameEditorWritingTaskDraftIdentity(
            currentSelectionDraft.identity,
            writingDraftAtStart?.identity ?? null,
          )
        ) {
          selectionWritingDraftIdentityRef.current = null;
        }
      }
    }
  }

  async function completeGeneratedCandidate(input: {
    readonly candidate: AiCandidate | null;
    readonly action: EditorGenerationAction;
    readonly qualityGateOutcome: CandidateQualityGateResult["outcome"] | null;
    readonly professionalNotice: string;
    readonly incomplete?: boolean;
  }): Promise<"review" | "kept"> {
    const candidateSnapshot = input.candidate?.toSnapshot() ?? null;
    let currentMode: "direct" | "professional";
    try {
      currentMode = (await runtime.writingExperience.getOrInitialize()).mode;
    } catch {
      if (input.candidate !== null) setCandidate(input.candidate);
      setEditorNotice(
        "创作结果已安全保留并与正文隔离。当前无法确认写作方式，请查看结果后再决定是否使用。",
      );
      return "review";
    }
    const decision = decideEditorGenerationCompletion({
      mode: currentMode,
      action: input.action,
      candidateReady: input.candidate?.status === "ready",
      incomplete: (candidateSnapshot?.incomplete ?? false) || input.incomplete === true,
      qualityGateOutcome: input.qualityGateOutcome,
    });
    if (decision.kind === "review") {
      if (input.candidate !== null) setCandidate(input.candidate);
      if (input.candidate?.status === "ready") {
        setEditorNotice(currentMode === "direct" ? decision.notice : input.professionalNotice);
      }
      return "review";
    }

    setCandidate(null);
    setEditorNotice(decision.notice);
    return "kept";
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
    const writingDraftAtStart = generationWritingDraftsRef.current.get(plan.requestId) ?? null;
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
          plan.outputContract.advancedTargetVisibleCharacters !== null
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
      generationWritingDraftsRef.current.delete(plan.requestId);
      if (writingDraftAtStart !== null) {
        generationWritingDraftsRef.current.set(refreshed.requestId, writingDraftAtStart);
      }
      if (directPlan) {
        directGenerationRequestIdsRef.current.delete(plan.requestId);
        directGenerationRequestIdsRef.current.add(refreshed.requestId);
      }
      const refreshedContinuationDisclosure = await prepareContinuationGenerationDisclosure(
        runtime,
        refreshed,
      );
      if (!isCurrentGenerationOperation(operation)) return;
      setContinuationDisclosure(refreshedContinuationDisclosure);
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
    if (blockNewGenerationWhileFragmentNeedsDecision()) return;
    const operation = existingOperation ?? beginGenerationOperation();
    if (
      !plan.preflight.canStart ||
      plan.projectId !== projectId ||
      plan.chapterId !== chapterId ||
      !isCurrentGenerationOperation(operation)
    ) {
      return;
    }
    const writingDraftAtStart = generationWritingDraftsRef.current.get(plan.requestId) ?? null;
    setPreflightOpen(false);
    setCandidateBusy(true);
    setGenerationStage("generating");
    setGenerationPreview("");
    setError(null);
    setGenerationError(null);
    const settlement = registerPlanGenerationNavigationGuard(plan);
    let settlementCause: unknown = null;
    let receivedVisibleText = "";
    let writingDraftOutcome: EditorWritingTaskDraftOutcome = "in_progress";
    try {
      const directExecution = directGenerationRequestIdsRef.current.has(plan.requestId);
      const generationAction: EditorGenerationAction =
        plan.modelTask === "prose_generation" ? "opening" : "continuation";
      if (directExecution) {
        const currentAuthority = await runtime.writingExperience.getOrInitialize();
        if (currentAuthority.mode !== "direct") {
          settlementCause = new Error(
            "直接模式授权已经撤销；本次没有调用 AI，正文和版本保持不变。",
          );
          setGenerationError(settlementCause);
          return;
        }
      }
      const result = await executeGenerationPlan(
        runtime,
        plan,
        (next) => {
          receivedVisibleText = next;
          if (isCurrentGenerationOperation(operation)) setGenerationPreview(next);
        },
        { generationRetryLimit: 0 },
      );
      writingDraftOutcome = result.ok
        ? result.value.candidate === null
          ? "failed_final"
          : "generation_succeeded"
        : await generationFailureDraftOutcome(plan, receivedVisibleText);
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
        settlementCause = result.error;
        setGenerationError(result.error);
        return;
      }
      const previousCandidate = candidate;
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
      await completeGeneratedCandidate({
        candidate: result.value.candidate,
        action: generationAction,
        qualityGateOutcome: result.value.qualityGate?.outcome ?? null,
        incomplete: result.value.incomplete,
        professionalNotice:
          result.value.candidate?.toSnapshot().incomplete || result.value.incomplete
            ? "本次结果未完整结束，已保留为隔离的 AI 建议草稿；正文和版本没有改变。"
            : "建议已生成并保持隔离；正文和版本没有改变，请查看后决定是否使用。",
      });
    } catch (cause: unknown) {
      settlementCause = cause;
      if (writingDraftOutcome === "in_progress") {
        writingDraftOutcome = await generationFailureDraftOutcome(plan, receivedVisibleText);
      }
      if (isCurrentGenerationOperation(operation)) setGenerationError(cause);
    } finally {
      const navigationCause = await reconcileGenerationNavigationSafety(
        plan,
        settlementCause,
        receivedVisibleText,
      );
      if (navigationCause === null && activeGenerationPlanRef.current === plan) {
        activeGenerationPlanRef.current = null;
      }
      if (isCurrentGenerationOperation(operation)) {
        directGenerationRequestIdsRef.current.delete(plan.requestId);
        setCandidateBusy(false);
        setCancelBusy(false);
        if (navigationCause === null) setGenerationPreview("");
        setGenerationStage("preparing");
        candidateGenerationFlightRef.current = "idle";
      }
      if (
        navigationCause === null &&
        activeGenerationNavigationRef.current?.session === settlement
      ) {
        settlement.release();
        activeGenerationNavigationRef.current = null;
      }
      settlement.settle(navigationCause);
      settleWritingTaskDraft(writingDraftAtStart, writingDraftOutcome);
      if (
        writingDraftOutcome === "generation_succeeded" ||
        writingDraftOutcome === "failed_final" ||
        writingDraftOutcome === "cancelled_before_dispatch"
      ) {
        generationWritingDraftsRef.current.delete(plan.requestId);
      }
    }
  }

  async function confirmGeneration(): Promise<void> {
    if (blockNewGenerationWhileFragmentNeedsDecision()) return;
    if (generationPlan === null || candidateGenerationFlightRef.current !== "awaiting_decision") {
      return;
    }
    const plan = generationPlan;
    const operation = beginGenerationOperation();
    candidateGenerationFlightRef.current = "executing";
    setDirectDisclosureSaving(true);
    try {
      const currentDisclosure = await prepareContinuationGenerationDisclosure(runtime, plan);
      if (!isCurrentGenerationOperation(operation)) {
        return;
      }
      assertContinuationDisclosureMatches(continuationDisclosure, currentDisclosure);
      setContinuationDisclosure(currentDisclosure);
      const confirmedScope = continuationConfirmationScope(plan, currentDisclosure);
      if (rememberContinuationConfirmationForSession && confirmedScope !== null) {
        rememberContinuationConfirmation(window.sessionStorage, confirmedScope);
      }
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) {
        setGenerationError(cause);
        candidateGenerationFlightRef.current = "awaiting_decision";
      }
      return;
    } finally {
      if (isCurrentGenerationOperation(operation)) {
        setDirectDisclosureSaving(false);
      }
    }
    await executePreparedGeneration(plan, operation);
  }

  function closePreflightAndFocusEditor(): boolean {
    if (candidateGenerationFlightRef.current === "deferring") {
      return false;
    }
    void beginGenerationOperation();
    const selection = normalizeEditorSelection(selectionRef.current, contentRef.current.length);
    persistEditorView(selection);
    if (generationPlan !== null) {
      directGenerationRequestIdsRef.current.delete(generationPlan.requestId);
    }
    setContinuationDisclosure(null);
    setContinuationConfirmationIsRemembered(false);
    setRememberContinuationConfirmationForSession(false);
    setDirectDisclosureSaving(false);
    setPreflightOpen(false);
    candidateGenerationFlightRef.current = "idle";
    window.requestAnimationFrame(() => {
      scheduleSelection(selection, true, scrollTopRef.current);
    });
    return true;
  }

  function cancelPreflightAndFocusEditor(): void {
    const plan = generationPlan;
    const writingDraftAtStart =
      plan === null ? null : (generationWritingDraftsRef.current.get(plan.requestId) ?? null);
    if (closePreflightAndFocusEditor()) {
      settleWritingTaskDraft(writingDraftAtStart, "cancelled_before_dispatch");
      if (plan !== null) generationWritingDraftsRef.current.delete(plan.requestId);
      recordCancelledProviderAction();
    }
  }

  async function saveAndClosePreflight(): Promise<void> {
    if (!editorClean) {
      await manualSave();
    }
    cancelPreflightAndFocusEditor();
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
    if (
      generationPlan === null ||
      candidateGenerationFlightRef.current !== "awaiting_decision" ||
      !canDeferGenerationPlan(generationPlan)
    ) {
      return;
    }
    const operation = beginGenerationOperation();
    const plan = generationPlan;
    candidateGenerationFlightRef.current = "deferring";
    setCandidateBusy(true);
    setError(null);
    try {
      const deferred = await saveDeferredGenerationPlan(runtime, plan);
      if (!isCurrentGenerationOperation(operation)) return;
      setDeferredGeneration(deferred);
      setGenerationPlan(Object.freeze({ ...plan, deferredRequest: deferred }));
      setPreflightOpen(false);
      candidateGenerationFlightRef.current = "idle";
    } catch (cause: unknown) {
      if (isCurrentGenerationOperation(operation)) {
        setError(cause);
        candidateGenerationFlightRef.current = "awaiting_decision";
      }
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
      await stopGenerationForNavigation(activePlan);
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
    setCandidateOverlapAcknowledged(false);
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

  function navigateCandidateReviewTo(target: "start" | "end" | "edit"): void {
    const textarea = candidateReviewTextareaRef.current;
    const scrollContainer =
      textarea?.closest<HTMLElement>(".ink-overlay__content") ??
      document.querySelector<HTMLElement>(".candidate-review-overlay .ink-overlay__content");
    if (scrollContainer === null) return;
    if (target === "start") {
      scrollContainer.scrollTop = 0;
      return;
    }
    if (target === "end") {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      return;
    }
    if (textarea === null) return;
    scrollContainer.scrollTop = Math.max(0, textarea.offsetTop - 24);
    textarea.focus({ preventScroll: true });
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

  function recordCancelledProviderAction(): void {
    const incident = recordSafeOperationIncident({
      operation: "continuation",
      stage: "await_confirmation",
      cause: Object.assign(new Error("provider action cancelled before dispatch"), {
        code: "USER_CANCELLED_BEFORE_DISPATCH",
      }),
      projectId,
      chapterId,
      dispatched: false,
    });
    setEditorNotice(`已取消，本次没有调用 AI。问题编号（联系支持时提供）：${incident.supportId}`);
  }

  function cancelSelectionRewriteDisclosure(): void {
    const writingDraftAtStart = selectionWritingDraftIdentityRef.current;
    setSelectionRewriteDisclosure(null);
    settleWritingTaskDraft(writingDraftAtStart, "cancelled_before_dispatch");
    selectionWritingDraftIdentityRef.current = null;
    recordCancelledProviderAction();
    window.requestAnimationFrame(() =>
      primaryEditorActionRef.current?.focus({ preventScroll: true }),
    );
  }

  async function saveCandidateRevision(): Promise<void> {
    if (authorityWriteBlockedRef.current) {
      return;
    }
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
    completionNotice: string | null = null,
  ): Promise<boolean> {
    const acceptanceContent =
      candidateOverride?.id === candidate?.id && candidateReviewDraft.length > 0
        ? candidateReviewDraft
        : (candidateOverride?.content ?? "");
    const overlapBaseline =
      candidateOverride?.baseVersionId === null || candidateOverride?.baseVersionId === undefined
        ? undefined
        : versions.find((version) => version.id === candidateOverride.baseVersionId);
    const overlap =
      candidateOverride?.applicationIntent.task === "continuation" && overlapBaseline !== undefined
        ? detectCandidateStableOverlap(overlapBaseline.toSnapshot().content, acceptanceContent)
        : null;
    if (
      overlap?.risk === "high" &&
      strategy.kind !== "insert_at_cursor_omitting_exact_prefix" &&
      !candidateOverlapAcknowledged
    ) {
      setCandidateReviewError(
        "这份续写的开头与当前稳定正文大段重合。请先查看本机比较证据，再明确选择保留完整结果或移除经过逐字验证的重复部分。",
      );
      setCandidateReviewOpen(true);
      return false;
    }
    if (
      authorityWriteBlockedRef.current ||
      candidateOverride?.status !== "ready" ||
      candidateDecisionFenceRef.current
    ) {
      return false;
    }
    candidateDecisionFenceRef.current = true;
    if (!beginEditorReplacement()) {
      candidateDecisionFenceRef.current = false;
      setEditorNotice(
        completionNotice === null
          ? "正文仍有尚未完成的本地保存；这份 AI 建议草稿继续保持隔离，没有写入正文或创建版本。"
          : "生成期间正文已发生变化，本次结果未写入，请重试。",
      );
      return false;
    }
    try {
      const organizeLocalStoryFacts = true;
      return await acceptCandidateWhileEditorLocked(
        strategy,
        candidateOverride,
        completionNotice,
        organizeLocalStoryFacts,
      );
    } finally {
      setCandidateBusy(false);
      finishEditorReplacement();
      candidateDecisionFenceRef.current = false;
    }
  }

  async function acceptCandidateWhileEditorLocked(
    strategy: CandidateApplicationStrategy,
    candidateOverride: AiCandidate,
    completionNotice: string | null,
    organizeLocalStoryFacts: boolean,
  ): Promise<boolean> {
    const inferredAcceptedAction = generationActionFromCandidate(candidateOverride, versions);
    const acceptedAction =
      candidateOverride.id === candidate?.id && inferredAcceptedAction === "selection_rewrite"
        ? lastGenerationAction
        : inferredAcceptedAction;
    const editedContent =
      candidateOverride.id === candidate?.id ? candidateReviewDraft : candidateOverride.content;
    setCandidateBusy(true);
    const result = await runtime.useCases.acceptCandidate.execute({
      candidateId: candidateOverride.id,
      expectedCandidateRevision: candidateOverride.revision,
      strategy,
      organizeLocalStoryFacts,
      ...(editedContent === candidateOverride.content ? {} : { editedContent }),
    });
    if (!result.ok) {
      setError(result.error);
      setCandidateReviewError(projectOrdinaryUiError(result.error).description);
      return false;
    }
    let journeySettlementDeferred = false;
    try {
      await settleIdeaJourneyCandidateDecision(runtime, result.value.candidate.id, "accepted");
    } catch {
      journeySettlementDeferred = true;
    }
    const withJourneySettlementNotice = (message: string): string =>
      journeySettlementDeferred
        ? `${message} 未完成创作记录暂时无法结算，下次打开时会继续修复。`
        : message;
    const acceptedVersion = result.value.version.toSnapshot();
    const nextContent = result.value.chapter.content;
    const pipelineInput: AcceptedChapterPipelineInput = createLocalCandidateAcceptancePipelineInput(
      {
        projectId: acceptedVersion.projectId,
        chapterId: acceptedVersion.chapterId,
        versionId: acceptedVersion.id,
        acceptedCharacterCount: nextContent.length,
        organizeLocalStoryFacts,
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
    if (directMode && acceptedAction !== null && candidateOverride.baseVersionId !== null) {
      setDirectGenerationUndo(
        Object.freeze({
          action: acceptedAction,
          baseVersionId: candidateOverride.baseVersionId,
          appliedVersionId: result.value.version.id,
          undoLabel: directGenerationUndoLabel(acceptedAction),
        }),
      );
    }
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
      applicationStrategy:
        strategy.kind === "insert_at_cursor_omitting_exact_prefix"
          ? "insert_at_cursor"
          : strategy.kind,
      acceptedChangeCount,
      rejectedChangeCount,
    });
    if (pipelineRegistrationError !== null) {
      setStoryStateUpdate({ state: "idle" });
      setEditorNotice(
        withJourneySettlementNotice(
          completionNotice === null
            ? `${candidateSuggestionLabel}已安全写入正文和不会被改动的历史版本；后台重建任务暂未登记，正在直接执行本地设定整理：${pipelineRegistrationError}`
            : `${completionNotice} 后台重建任务暂未登记，正在直接执行本地设定整理。`,
        ),
      );
      void loadVersions();
    }
    setStoryStateUpdate({ state: "idle" });
    const organizeAcceptedFacts = organizeLocalStoryFacts
      ? organizeCurrentSavedVersionStoryFacts(
          {
            chapters: runtime.repositories.chapters,
            chapterVersions: runtime.repositories.chapterVersions,
            facts: runtime.story.facts,
            factService: runtime.story.factService,
            hasher: runtime.hasher,
            now: () => runtime.clock.now(),
          },
          pipelineInput,
        ).then((receipt) => {
          const organizationNotice = directStoryFactOrganizerNotice(receipt);
          setEditorNotice(
            withJourneySettlementNotice(
              pipelineRegistrationError === null
                ? organizationNotice
                : `${organizationNotice}；后台重建任务仍可稍后重新登记。`,
            ),
          );
        })
      : Promise.resolve();
    void organizeAcceptedFacts
      .then(() => runAcceptedChapterPipeline(runtime, pipelineInput))
      .then((receipt) => {
        if (receipt.status === "partially_completed") {
          setEditorNotice(
            withJourneySettlementNotice(
              completionNotice === null
                ? `${candidateSuggestionLabel}已安全写入新版本；部分本地整理稍后会自动重试。`
                : `${completionNotice} 后台整理暂未完成，可稍后重试。`,
            ),
          );
        }
      })
      .catch((cause: unknown) => {
        if (completionNotice === null) {
          const message = projectOrdinaryUiError(cause).description;
          setEditorNotice(
            withJourneySettlementNotice(
              `${candidateSuggestionLabel}已安全写入正文和不会被改动的历史版本；部分本地整理稍后会自动重试：${message}`,
            ),
          );
        } else {
          setEditorNotice(
            withJourneySettlementNotice(`${completionNotice} 部分本地整理稍后会自动重试。`),
          );
        }
      });
    setEditorNotice(
      withJourneySettlementNotice(
        completionNotice ??
          (strategy.kind === "apply_changes"
            ? "已按逐项决定创建新的稳定版本；可在本次会话撤销，原稳定版本仍保留在版本历史。"
            : `${candidateSuggestionLabel}已按所选方式写入新的稳定版本；原稳定版本仍保留在版本历史。`),
      ),
    );
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

  async function restoreSelectedVersion(
    selectedOverride: ChapterVersion | null = versionToRestore,
    completionNotice: string | null = null,
  ): Promise<void> {
    const selected = selectedOverride;
    const stableChapter = chapterRef.current;
    if (
      authorityWriteBlockedRef.current ||
      selected === null ||
      stableChapter === null ||
      versionRestoreFlightRef.current !== null ||
      project?.status !== "active" ||
      selected.toSnapshot().content === stableChapter.content
    ) {
      return;
    }
    if (!beginEditorReplacement()) {
      setEditorNotice("正文仍有尚未完成的本地保存；当前没有恢复版本，正文和历史版本均未改变。");
      return;
    }
    const expectedRouteKey = editorRouteKey;
    const selectedSnapshot = selected.toSnapshot();
    const flight = Symbol(`restore-version-${String(selectedSnapshot.sequence)}`);
    versionRestoreFlightRef.current = flight;
    setVersionRestoreBusy(true);
    setError(null);
    try {
      const organizeLocalStoryFacts =
        (await runtime.writingExperience.getOrInitialize()).mode === "direct";
      const result = await runtime.useCases.restoreChapterVersion.execute({
        chapterId: stableChapter.id,
        versionId: selected.id,
        expectedRevision: stableChapter.revision,
        organizeLocalStoryFacts,
      });
      if (
        versionRestoreFlightRef.current !== flight ||
        routeIdentityRef.current !== expectedRouteKey ||
        chapterRef.current?.id !== stableChapter.id
      ) {
        return;
      }
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
      const selectionAfter = Object.freeze({
        start: nextContent.length,
        end: nextContent.length,
      });
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
      setDirectGenerationUndo(null);
      setEditorNotice(
        completionNotice ??
          `已从版本 ${String(selectedSnapshot.sequence)} 创建新的恢复版本；所有历史版本仍保留。`,
      );
      const pipelineInput = createLocalAcceptedVersionPipelineInput({
        projectId: result.value.chapter.projectId,
        chapterId: result.value.chapter.id,
        versionId: result.value.version.id,
        source: "version_restore",
        acceptedCharacterCount: result.value.chapter.content.length,
        organizeLocalStoryFacts: result.value.version.toSnapshot().organizeLocalStoryFacts,
      });
      let backgroundStage: "local_organization" | "task_registration" | "derived_refresh" =
        "local_organization";
      void ensureCurrentSavedVersionStoryFactsForDirectMode(runtime, pipelineInput)
        .then(() => {
          backgroundStage = "task_registration";
          return ensureAcceptedChapterPipelineTask(runtime, pipelineInput);
        })
        .then(() => {
          backgroundStage = "derived_refresh";
          return runAcceptedChapterPipeline(runtime, pipelineInput);
        })
        .catch(() => {
          setEditorNotice(
            backgroundStage === "task_registration"
              ? completionNotice === null
                ? "恢复版本与正文已安全保存；本地设定已整理；后台任务登记失败，可在任务与通知中重试。"
                : `${completionNotice} 本地设定已整理；后台任务登记失败，可在任务与通知中重试。`
              : completionNotice === null
                ? "恢复版本与正文已安全保存；故事资料整理暂未完成，可在任务与通知中重试。"
                : `${completionNotice} 后台整理暂未完成，可稍后重试。`,
          );
        });
      await recordWritingFeedbackSafely({ action: "restored_original", candidateId: null });
      await loadVersions();
    } catch (cause: unknown) {
      if (
        versionRestoreFlightRef.current === flight &&
        routeIdentityRef.current === expectedRouteKey
      ) {
        setError(cause);
      }
    } finally {
      if (versionRestoreFlightRef.current === flight) {
        versionRestoreFlightRef.current = null;
        setVersionRestoreBusy(false);
        finishEditorReplacement();
      }
    }
  }

  async function undoDirectGeneration(): Promise<void> {
    const undo = directGenerationUndo;
    const stableChapter = chapterRef.current;
    if (undo === null || stableChapter === null) return;
    if (
      stableChapter.currentVersionId !== undo.appliedVersionId ||
      contentRef.current !== stableChapter.content ||
      !editorClean
    ) {
      setEditorNotice("正文已有后续修改，请从版本历史恢复到操作前版本。");
      return;
    }
    const baseVersion = versions.find((version) => version.id === undo.baseVersionId) ?? null;
    if (baseVersion === null) {
      setEditorNotice("操作前版本暂时不可用，请重新打开本页后从版本历史恢复。");
      return;
    }
    const actionLabel =
      undo.action === "opening"
        ? "开头"
        : undo.action === "polish"
          ? "润色"
          : undo.action === "expand"
            ? "扩写"
            : undo.action === "shorten"
              ? "缩写"
              : undo.action === "selection_rewrite"
                ? "改写"
                : "续写";
    await restoreSelectedVersion(baseVersion, `已撤销本次${actionLabel}，可在版本历史中恢复。`);
  }

  function updateCandidateHistory(nextCandidate: AiCandidate): void {
    setCandidateHistory((current) => [
      nextCandidate,
      ...current.filter((item) => item.id !== nextCandidate.id),
    ]);
  }

  function viewHistoricalCandidate(nextCandidate: AiCandidate): void {
    if (nextCandidate.projectId !== projectId || nextCandidate.chapterId !== chapterId) {
      setEditorNotice("这份生成结果不属于当前章节，未打开。");
      return;
    }
    setCandidate(nextCandidate);
    const action = generationActionFromCandidate(nextCandidate, versions);
    if (action !== null) setLastGenerationAction(action);
    setCandidatePresentation(nextCandidate.toSnapshot().source === "generate" ? "unknown" : "ai");
    setCandidateReviewOpen(false);
    setCandidateReviewError(null);
    setCandidateRevisionSaved(false);
    setCandidateCopySaved(false);
    setGenerationReceipt(null);
    setGenerationAttemptUsage([]);
    setCandidateQualityGate(null);
    setEditorNotice(
      nextCandidate.status === "ready"
        ? "已打开这份隔离结果；只有你明确使用，才会写入正文。"
        : "已打开只读历史结果；它不会再次写入正文。",
    );
  }

  async function retainCandidate(nextCandidate: AiCandidate): Promise<void> {
    if (authorityWriteBlockedRef.current) {
      return;
    }
    if (nextCandidate.status !== "ready" || candidateDecisionFenceRef.current) {
      return;
    }
    candidateDecisionFenceRef.current = true;
    setCandidateBusy(true);
    try {
      const result = await runtime.useCases.retainCandidate.execute({
        candidateId: nextCandidate.id,
        expectedCandidateRevision: nextCandidate.revision,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      updateCandidateHistory(result.value);
      if (candidate?.id === result.value.id) {
        setCandidate(result.value);
      }
      setError(null);
      setEditorNotice("已继续保留这份结果；它仍在本机等待决定，正文没有变化。");
    } finally {
      setCandidateBusy(false);
      candidateDecisionFenceRef.current = false;
    }
  }

  async function rejectCandidate(
    candidateOverride: AiCandidate | null = candidate,
  ): Promise<boolean> {
    if (
      authorityWriteBlockedRef.current ||
      candidateOverride?.status !== "ready" ||
      candidateDecisionFenceRef.current
    ) {
      return false;
    }
    candidateDecisionFenceRef.current = true;
    setCandidateBusy(true);
    try {
      const result = await runtime.useCases.rejectCandidate.execute({
        candidateId: candidateOverride.id,
        expectedCandidateRevision: candidateOverride.revision,
      });
      if (!result.ok) {
        setError(result.error);
        if (candidateReviewOpen) {
          setCandidateReviewError(projectOrdinaryUiError(result.error).description);
        }
        return false;
      }
      updateCandidateHistory(result.value);
      if (candidate?.id === result.value.id) {
        setCandidate(result.value);
      }
      setCandidateCopySaved(false);
      setError(null);
      let journeySettlementDeferred = false;
      try {
        await settleIdeaJourneyCandidateDecision(runtime, result.value.id, "rejected");
      } catch {
        journeySettlementDeferred = true;
      }
      await recordWritingFeedbackSafely({
        action: "rejected",
        candidateId: result.value.id,
      });
      if (journeySettlementDeferred) {
        setEditorNotice(
          "隔离结果已放弃，稳定正文没有变化；未完成创作记录暂时无法结算，下次打开时会继续修复。",
        );
      }
      return true;
    } finally {
      setCandidateBusy(false);
      candidateDecisionFenceRef.current = false;
    }
  }

  function openChapterPrivacyDialog(target: ChapterPrivacyMode): void {
    setError(null);
    setPrivacyChangeFailure(null);
    setPrivacyChangeTarget(target);
  }

  function recordChapterPrivacyFailure(stableChapter: Chapter, cause: unknown): void {
    const incident = recordSafeOperationIncident({
      operation: "chapter_privacy",
      stage: "persist_result",
      cause,
      projectId: stableChapter.projectId,
      chapterId: stableChapter.id,
      dispatched: false,
      occurredAt: runtime.clock.now(),
    });
    const ordinaryError = projectOrdinaryUiError(cause);
    const privacyDescription =
      cause instanceof AppError && cause.details.databaseCode === "PROJECT_REMOTE_DISPATCH_ACTIVE"
        ? "本作品仍有一次 AI 处理正在发送或等待结束。请先停止该任务，或等它结束后重新读取章节，再重试隐私设置。"
        : ordinaryError.description;
    setPrivacyChangeFailure({
      description: privacyDescription,
      supportId: incident.supportId,
    });
    setError(cause);
  }

  async function confirmChapterPrivacyChange(): Promise<void> {
    const stableChapter = chapterRef.current;
    if (
      authorityWriteBlockedRef.current ||
      stableChapter === null ||
      privacyChangeTarget === null ||
      stableChapter.privacyMode === privacyChangeTarget ||
      project?.status !== "active"
    ) {
      return;
    }

    setPrivacyChangeBusy(true);
    setPrivacyChangeFailure(null);
    setError(null);
    try {
      const result = await runtime.useCases.setChapterPrivacy.execute({
        chapterId: stableChapter.id,
        privacyMode: privacyChangeTarget,
        expectedPrivacyRevision: stableChapter.privacyRevision,
      });
      if (!result.ok) {
        recordChapterPrivacyFailure(stableChapter, result.error);
        return;
      }

      setChapter(result.value.chapter);
      chapterRef.current = result.value.chapter;
      setChapters((current) =>
        current.map((item) => (item.id === result.value.chapter.id ? result.value.chapter : item)),
      );
      setPrivacyChangeTarget(null);
      setPrivacyChangeFailure(null);
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
      recordChapterPrivacyFailure(stableChapter, cause);
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
  const readonly = project?.status !== "active" || versionReadWarning !== null;
  const candidateReady = candidate?.status === "ready";
  const candidateSuggestionLabel = directMode
    ? "创作结果"
    : candidatePresentation === "local"
      ? "本地草案"
      : candidatePresentation === "ai"
        ? "AI 建议"
        : "建议";
  const candidateVersionLabel = `${candidateSuggestionLabel}版本`;
  const candidateActionGap = !directMode && candidatePresentation === "ai" ? " " : "";
  const candidateIncomplete = candidate?.toSnapshot().incomplete ?? false;
  const unsafeGenerationFragmentPending =
    generationPreview.trim().length > 0 &&
    currentGenerationNavigationGuard()?.unsafeFragment?.isPresent() === true;
  const canGenerateCandidate =
    !readonly &&
    !unsafeGenerationFragmentPending &&
    (candidate === null ||
      candidate.status === "accepted" ||
      candidate.status === "rejected" ||
      candidate.status === "expired");
  const continuationTargetDraftValid =
    continuationPreference.customTargetVisibleCharacters === null ||
    advancedTargetDraft === continuationPreference.customTargetVisibleCharacters.toString();
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
  const candidateContinuationCursor =
    candidateIntent?.task === "continuation" ? candidateIntent.startUtf16 : null;
  const candidateIsSelectionRewrite = candidateIntent?.task === "selection_rewrite";
  const candidateIsWholeChapterRewrite = candidateIntent?.task === "whole_chapter_rewrite";
  const candidateAllowsPartialDecisions = candidateIntent?.task === "legacy_full_document";
  const candidateBaseVersion =
    candidate?.baseVersionId === null || candidate?.baseVersionId === undefined
      ? undefined
      : versions.find((version) => version.id === candidate.baseVersionId);
  const candidateStableOverlap: CandidateStableOverlapResult | null =
    candidateIsContinuation && candidateBaseVersion !== undefined && candidateReviewDraftValid
      ? detectCandidateStableOverlap(
          candidateBaseVersion.toSnapshot().content,
          candidateReviewDraft,
        )
      : null;
  const candidateOverlapRequiresAcknowledgement =
    candidateStableOverlap?.risk === "high" && !candidateOverlapAcknowledged;
  const candidateAuthorityApplicationBlocked =
    readonly ||
    (candidate !== null &&
      (candidateBaseVersion === undefined ||
        materializeCandidateDraft(
          candidate,
          candidateBaseVersion.toSnapshot(),
          candidateReviewDraft,
        ) === null));
  const candidateApplicationBlocked =
    candidateAuthorityApplicationBlocked || candidateOverlapRequiresAcknowledgement;
  const candidatePartialDecisionComplete =
    candidateReviewDiffCurrent &&
    candidateDiff !== null &&
    candidateDiff.changes.length > 0 &&
    candidateSelectedDecisions.length === candidateDiff.changes.length &&
    candidateSelectedDecisions.some(({ decision }) => decision === "accept");
  const editorClean =
    saveState === "saved_local" || saveState === "clean" || saveState === "pending_sync";
  const directUndoAvailable =
    directGenerationUndo !== null &&
    chapter?.currentVersionId === directGenerationUndo.appliedVersionId &&
    contentRef.current === chapter.content &&
    editorClean;
  const displayedContextCompilation =
    selectionRewriteContext ?? generationPlan?.contextCompilation ?? null;
  const displayedNovelSkillPreparation =
    selectionRewriteContext === null ? (generationPlan?.novelSkillPreparation ?? null) : null;
  const displayedCandidateHistory =
    candidate?.purpose === "prose" && candidate.status !== "streaming"
      ? [candidate, ...candidateHistory.filter((item) => item.id !== candidate.id)]
      : candidateHistory;
  const savedGenerationAction: EditorGenerationAction =
    (chapter?.content.trim().length ?? 0) === 0 ? "opening" : "continuation";
  const savedGenerationActionLabel =
    savedGenerationAction === "opening" ? "生成开头" : "生成续写建议";
  const inferredCandidateAction =
    candidate === null ? null : generationActionFromCandidate(candidate, versions);
  const displayedCandidateAction =
    inferredCandidateAction === "selection_rewrite"
      ? lastGenerationAction
      : inferredCandidateAction;
  const displayedCandidateActionLabel =
    displayedCandidateAction === "opening"
      ? "开头结果"
      : displayedCandidateAction === "continuation"
        ? "续写建议"
        : displayedCandidateAction === null
          ? null
          : `${selectionRewriteActionLabel(displayedCandidateAction)}结果`;
  const writingCanvasStyle = {
    "--editor-font-size": `${String(typography.fontSize)}px`,
    "--editor-line-height": String(typography.lineHeight),
  } as CSSProperties;
  const editorWorkspaceStyle = {
    "--editor-assistant-width": `${String(assistantPanelWidth)}px`,
  } as CSSProperties;
  if (!writingModeReady) {
    return (
      <div className="editor-page">
        <p role="status">正在读取本机写作方式……</p>
      </div>
    );
  }
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
    return {
      label: savedGenerationActionLabel,
      disabled: candidateBusy || !canGenerateCandidate || !continuationTargetDraftValid,
      run: () => {
        setAssistantOpen(true);
        void generateCandidate();
      },
    };
  })();

  const normalizedLiveSelection = normalizeEditorSelection(liveSelection, content.length);
  const hasValidSelection =
    normalizedLiveSelection.start !== normalizedLiveSelection.end &&
    content.slice(normalizedLiveSelection.start, normalizedLiveSelection.end).trim().length > 0;
  const selectionExceedsLimit = selectionLength > MAXIMUM_SELECTION_REWRITE_CHARACTERS;
  const selectionWritingControls =
    usesNativeModel && canGenerateCandidate && hasValidSelection ? (
      <section className="candidate-content" aria-label="选中文本写作操作">
        <div className="candidate-content__meta">
          <strong>修改选中内容</strong>
          <span>{selectionLength.toLocaleString("zh-CN")} 个字符</span>
        </div>
        {selectionExceedsLimit && (
          <InlineAlert
            tone="warning"
            title="选中内容过长"
            description={
              "每次最多处理 " +
              MAXIMUM_SELECTION_REWRITE_CHARACTERS.toLocaleString("zh-CN") +
              " 个字符，请缩小选区。"
            }
          />
        )}
        {chapter?.isLocalOnly === true && (
          <InlineAlert
            tone="warning"
            title="私密章节仅限本机"
            description="私密章节只在本机处理。没有可用的本地 AI 时，本次生成不会开始。"
          />
        )}
        {selectionRewriteDisclosure === null ? (
          <div className="candidate-actions">
            {selectionWritingActions.map((action) => (
              <Button
                key={action.action}
                variant={activeWritingTask === action.action ? "primary" : "secondary"}
                aria-pressed={activeWritingTask === action.action}
                loading={selectionRewriteBusy && lastGenerationAction === action.action}
                disabled={
                  !editorClean ||
                  candidateBusy ||
                  selectionExceedsLimit ||
                  chapter?.isLocalOnly === true
                }
                onClick={() => activateWritingTask(action.action)}
              >
                {action.label}
              </Button>
            ))}
            <Button
              variant="ghost"
              onClick={() =>
                scheduleSelection({ start: cursorRef.current, end: cursorRef.current }, true)
              }
            >
              取消选区
            </Button>
          </div>
        ) : (
          <>
            <InlineAlert
              tone="warning"
              title={"确认本次" + selectionRewriteActionLabel(lastGenerationAction)}
              onDismiss={cancelSelectionRewriteDisclosure}
              description={`任务：${selectionRewriteActionLabel(lastGenerationAction)}；本次要求：${formatRequirementConfirmationSummary(lastSelectionRewriteInstruction)}；模型：${selectionRewriteDisclosure.connectionDisplayName} · ${selectionRewriteDisclosure.modelId}；资料：当前选中文字和本次要求，${formatPrivateContentSummary(selectionRewriteDisclosure.dataDestination)}；预计发送 1 次、自动重试 0 次，${formatSelectionRewriteCostSummary(selectionRewriteDisclosure)}`}
            />
            <details className="candidate-panel__disclosure-details">
              <summary>查看详情</summary>
              {chapter !== null && (
                <p>
                  作品《{project.name}》 · 章节《{chapter.title}》 · 当前稳定正文{" "}
                  {chapter.content.length.toLocaleString("zh-CN")} 字。
                </p>
              )}
              <p>
                完整本次要求：
                {lastSelectionRewriteInstruction.trim() || "未填写额外要求"}
              </p>
              <p>{selectionRewriteDisclosure.privacy}</p>
              <p>发送内容：{selectionRewriteDisclosure.sends.join("；")}。</p>
              <p>本次最多向模型服务发送 1 次，自动重试 0 次。</p>
              <p>完整结果会先保持隔离，不会自动改写正文；只有你明确使用后才会创建新的正文版本。</p>
              {selectionRewriteDisclosure.estimatedMaximumCostMicros !== null &&
                selectionRewriteDisclosure.currency !== null && (
                  <p>{formatSelectionRewriteCost(selectionRewriteDisclosure)}</p>
                )}
            </details>
            <div className="candidate-actions">
              <Button
                variant="ai-primary"
                loading={selectionRewriteBusy}
                onClick={() =>
                  void rewriteSelectedText(lastSelectionRewriteInstruction, lastGenerationAction)
                }
              >
                确认生成
              </Button>
              <Button
                variant="ghost"
                disabled={selectionRewriteBusy}
                onClick={cancelSelectionRewriteDisclosure}
              >
                取消
              </Button>
            </div>
          </>
        )}
        {directUndoAvailable && (
          <Button
            variant="secondary"
            loading={versionRestoreBusy}
            onClick={() => void undoDirectGeneration()}
          >
            {directGenerationUndo.undoLabel}
          </Button>
        )}
      </section>
    ) : directUndoAvailable ? (
      <Button
        variant="secondary"
        loading={versionRestoreBusy}
        onClick={() => void undoDirectGeneration()}
      >
        {directGenerationUndo.undoLabel}
      </Button>
    ) : null;
  const activeSelectionWritingAction =
    activeWritingTask === "continuation"
      ? null
      : selectionWritingActionDefinition(activeWritingTask);
  const continuationLengthControls = (
    <section className="candidate-content" aria-label="篇幅">
      <FormField label="篇幅" required hint="选择本次推进的体量和自然收束位置；默认使用“中”。">
        {(fieldProps) => (
          <Select
            {...fieldProps}
            value={continuationPreference.profile}
            options={[
              { value: "short", label: "短 · 一小段推进" },
              { value: "standard", label: "中 · 一个完整场景" },
              { value: "long", label: "长 · 一场完整事件或情绪推进" },
            ]}
            disabled={candidateBusy}
            onChange={(event) => {
              const profile = event.currentTarget.value as ContinuationOutputProfileId;
              updateContinuationPreference({
                schemaVersion: 1,
                profile,
                customTargetVisibleCharacters: null,
                destination: profile === "short" ? "next_segment" : "complete_scene",
                customDestinationInstruction: null,
              });
            }}
          />
        )}
      </FormField>
      <details>
        <summary>高级篇幅设置</summary>
        <label className="checkbox-row">
          <input
            type="checkbox"
            aria-label="使用目标字数"
            checked={continuationPreference.customTargetVisibleCharacters !== null}
            disabled={candidateBusy}
            onChange={(event) =>
              updateContinuationPreference({
                ...continuationPreference,
                customTargetVisibleCharacters: event.currentTarget.checked
                  ? continuationProfileDefaultTarget(continuationPreference.profile)
                  : null,
              })
            }
          />
          <span>使用目标字数</span>
        </label>
        {continuationPreference.customTargetVisibleCharacters !== null && (
          <FormField
            label="目标字数，允许约 ±20% 浮动"
            hint="可填写 200–12,000 字；这是柔性目标，实际结果仍受自然收束和模型安全上限保护。"
            error={advancedTargetError ?? undefined}
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="number"
                min={MINIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS}
                max={MAXIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS}
                step={100}
                value={advancedTargetDraft}
                disabled={candidateBusy}
                onChange={(event) => {
                  const raw = event.currentTarget.value;
                  setAdvancedTargetDraft(raw);
                  const value = Number(raw);
                  if (
                    raw.trim().length === 0 ||
                    !Number.isSafeInteger(value) ||
                    value < MINIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS ||
                    value > MAXIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS
                  ) {
                    setAdvancedTargetError("请输入 200–12,000 之间的整数；当前输入尚未保存。");
                    return;
                  }
                  updateContinuationPreference({
                    ...continuationPreference,
                    customTargetVisibleCharacters: value,
                  });
                }}
                onBlur={() => {
                  if (
                    advancedTargetDraft ===
                    continuationPreference.customTargetVisibleCharacters?.toString()
                  ) {
                    return;
                  }
                  setAdvancedTargetDraft(
                    continuationPreference.customTargetVisibleCharacters?.toString() ?? "",
                  );
                  setAdvancedTargetError("输入未保存，已恢复上次有效的目标字数。");
                }}
              />
            )}
          </FormField>
        )}
      </details>
      {continuationPreference.profile === "long" && (
        <p className="candidate-panel__hint" role="status">
          长篇会在一场完整事件或情绪变化形成阶段性结果后收束，并可能需要更长等待时间或更高费用。
        </p>
      )}
    </section>
  );
  const writingRequirementControls = (
    <section className="candidate-content" aria-label="本次写作要求">
      <div className="candidate-content__meta">
        <strong>
          当前任务：{activeSelectionWritingAction?.label ?? savedGenerationActionLabel}
        </strong>
        {activeSelectionWritingAction !== null && (
          <Button variant="ghost" onClick={() => activateWritingTask("continuation")}>
            切换到续写要求
          </Button>
        )}
      </div>
      <FormField
        label="本次要求（可选）"
        optionalLabel=""
        hint="只用于当前作品、章节、正文版本、任务与选区；不会写成正式设定，也不会自动带入其他任务。"
      >
        {(fieldProps) => (
          <Textarea
            {...fieldProps}
            ref={writingRequirementRef}
            value={writingRequirement}
            rows={3}
            maxLength={2_000}
            currentLength={writingRequirement.length}
            disabled={candidateBusy}
            placeholder={
              activeSelectionWritingAction?.requirementPlaceholder ??
              CONTINUATION_REQUIREMENT_PLACEHOLDER
            }
            onChange={(event) => updateWritingRequirement(event.currentTarget.value)}
          />
        )}
      </FormField>
      {writingDraftPersistenceError && (
        <InlineAlert
          tone="warning"
          title={
            writingDraftPersistenceError === "read"
              ? "本次要求草稿无法安全读取"
              : "本次要求暂时无法保留到重启后"
          }
          description={
            writingDraftPersistenceError === "read"
              ? "这份任务草稿的本机记录无法安全解析。原始记录已保留，也不会被当作空要求自动发送；请重新输入本次要求并复制留存，或重启后再试。"
              : "当前输入仍可用于这次生成，但本机无法安全保存这份任务草稿；已有记录不会被覆盖。请复制要求后重试，墨影不会改用其他章节或任务的旧草稿。"
          }
        />
      )}
      {activeWritingTask === "continuation" &&
        writingRequirement.length === 0 &&
        legacyProjectWritingRequirement !== null && (
          <InlineAlert
            tone="info"
            title="发现旧版续写要求"
            description="旧版本按整部作品保存，无法确定它属于哪个章节，因此不会自动用于本次生成。你可以先确认，再把它恢复到当前章节。"
            action={{
              label: "确认用于当前章节",
              onClick: restoreLegacyWritingRequirementForCurrentChapter,
            }}
          />
        )}
      {activeSelectionWritingAction !== null && (
        <>
          <p className="candidate-panel__hint">
            写作技能目前用于续写；本次选区操作只采用当前要求和本次挑选的故事资料。
          </p>
          <Button
            variant="ai-primary"
            loading={selectionRewriteBusy}
            disabled={
              !editorClean ||
              candidateBusy ||
              selectionExceedsLimit ||
              chapter?.isLocalOnly === true ||
              selectionRewriteDisclosure !== null
            }
            onClick={() => void rewriteSelectedText(null, activeSelectionWritingAction.action)}
          >
            查看{activeSelectionWritingAction.label}发送前说明
          </Button>
        </>
      )}
    </section>
  );
  const enabledNovelSkills =
    novelSkillProjectState?.methods.filter((method) => method.enabled && !method.archived) ?? [];
  const preparedNovelSkills = displayedNovelSkillPreparation?.methods ?? [];
  const appliedNovelSkills = preparedNovelSkills.filter(({ included }) => included);
  const omittedNovelSkills = preparedNovelSkills.filter(({ included }) => !included);
  const novelSkillSummary = (
    <section className="candidate-content" aria-label="写作技能摘要">
      <div className="candidate-content__meta">
        <strong>
          {novelSkillSummaryLoading
            ? "正在读取写作技能"
            : `已启用 ${String(enabledNovelSkills.length)} 项${
                enabledNovelSkills.length === 0
                  ? ""
                  : `：${enabledNovelSkills
                      .slice(0, 2)
                      .map(({ displayName }) => displayName)
                      .join("、")}`
              }`}
        </strong>
        <Button variant="ghost" onClick={() => setNovelSkillDrawerOpen(true)}>
          设置
        </Button>
      </div>
      {displayedNovelSkillPreparation === null ? (
        <p className="candidate-panel__hint">发送前准备完成后，这里会显示本次实际采用结果。</p>
      ) : (
        <>
          <p className="candidate-panel__hint">
            本次实际采用：
            {appliedNovelSkills.length === 0
              ? "无"
              : appliedNovelSkills.map(({ displayName }) => displayName).join("、")}
            。
          </p>
          {omittedNovelSkills.length > 0 && (
            <p className="candidate-panel__hint">
              未采用：{omittedNovelSkills[0]?.displayName}（
              {novelSkillSelectionReasonBrief(omittedNovelSkills[0]?.selectionReason ?? "")}）
              {omittedNovelSkills.length > 1
                ? `，另有 ${String(omittedNovelSkills.length - 1)} 项可在“本次参考”查看。`
                : "。"}
            </p>
          )}
        </>
      )}
      <p className="candidate-panel__hint">选区改写、润色、扩写和缩写暂不采用写作技能。</p>
    </section>
  );
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
              description={`${normalizedError.description} 问题编号（联系支持时提供）：${
                loadDiagnosticId ?? "正在生成"
              }。`}
              savedState="已停止正文写入；本地正文、版本和恢复草稿保持原样。"
              primaryAction={
                fatalErrorRequiresRuntimeReopen
                  ? { label: "重新打开并读取正文", onClick: () => window.location.reload() }
                  : { label: "重新读取正文", onClick: () => void load() }
              }
              secondaryAction={{
                label: "前往诊断与备份",
                onClick: () => void navigate("/settings#diagnostics"),
              }}
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
            {project !== null && chapter !== null && (
              <div
                className="editor-toolbar__chapter-identity"
                role="status"
                aria-label="当前写作位置"
                aria-live="polite"
              >
                <span>作品：{project.name}</span>
                <span>卷：{volumeName}</span>
                <span>章节：{chapter.title}</span>
                <strong>{content.length.toLocaleString("zh-CN")} 字</strong>
              </div>
            )}
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
                      openChapterPrivacyDialog(chapter.isLocalOnly ? "standard" : "local_only")
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
                  {directMode ? "创作助手" : "AI 助手"}
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
              onClick={primaryAction.run}
            >
              {primaryAction.label}
            </Button>
          </div>
        </header>

        {projectDisplayIdentity?.displayKind === "builtin_example" && (
          <InlineAlert
            tone="info"
            title="这是示例作品，可随时删除"
            description="你可以在这里体验编辑、版本和 AI 建议流程。需要开始自己的创作时，请从创作首页新建作品。"
          />
        )}

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
            description={`仅保存章节、版本、创作任务安排和费用上界，不保存正文或创作指令。${
              online
                ? "网络已恢复；再次打开生成前检查并确认后才会执行。"
                : "可继续本地编辑，任务会留在任务中心。"
            }`}
          />
        )}
        {readonly && (
          <InlineAlert
            tone="info"
            title={versionReadWarning === null ? "只读模式" : "正文只读"}
            description={
              versionReadWarning === null
                ? "项目已归档或位于回收站，正文保持可读但不会写入。"
                : "版本待恢复，已停止写入。"
            }
          />
        )}
        {recovered && (
          <InlineAlert
            tone="warning"
            title="已恢复未提交草稿"
            description="草稿来自真实本地恢复记录；自动保存完成后会生成稳定版本。"
          />
        )}
        {versionReadWarning !== null && (
          <InlineAlert
            tone="warning"
            title="版本历史需恢复"
            description={`${String(
              versionReadWarning.isolatedCount,
            )} 条分叉版本已保留。问题编号（联系支持时提供）：${versionReadWarning.diagnosticId}`}
            action={{
              label: "诊断与恢复",
              onClick: () => void navigate("/settings#diagnostics"),
            }}
          />
        )}
        {candidateReadWarning !== null && (
          <InlineAlert
            tone="warning"
            title="部分生成记录暂不可用"
            description={`${
              candidateReadWarning.isolatedCount === null
                ? "有生成记录暂时无法安全读取"
                : `${String(candidateReadWarning.isolatedCount)} 条生成记录暂时无法安全读取`
            }；正文和不会被改动的历史版本仍可正常使用。问题编号（联系支持时提供）：${candidateReadWarning.diagnosticId}。`}
            action={{
              label: candidateRowsRetrying ? "正在重新读取" : "重新读取附属资料",
              onClick: () => void retryCandidateRows(),
            }}
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
        {largeDeletionReview !== null && !largeDeletionDialogOpen && (
          <InlineAlert
            tone="warning"
            title="大幅删除尚未确认"
            description={`《${largeDeletionReview.chapterTitle}》将从 ${largeDeletionReview.previousCharacterCount.toLocaleString("zh-CN")} 字缩短为 ${largeDeletionReview.proposedContent.length.toLocaleString("zh-CN")} 字。短正文已保留为恢复草稿，不会自动成为正式版本。`}
            action={{
              label: "重新查看并决定",
              onClick: () => setLargeDeletionDialogOpen(true),
            }}
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
              readOnly={readonly || editorReplacementLocked || largeDeletionReview !== null}
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
                setLiveSelection(selection);
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
              assistantName={directMode ? "创作助手" : "AI 创作助手"}
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
                  <h2 id="candidate-title">{directMode ? "创作助手" : "AI 创作助手"}</h2>
                  <Badge tone="neutral">{directMode ? "直接模式" : "专业模式"}</Badge>
                </div>
                <Button
                  variant="ghost"
                  size="lg"
                  aria-label={
                    compactEditorLayout
                      ? directMode
                        ? "关闭创作助手"
                        : "关闭 AI 创作助手"
                      : directMode
                        ? "收起创作助手"
                        : "收起 AI 创作助手"
                  }
                  aria-expanded={assistantOpen}
                  onClick={() => setAssistantOpen(false)}
                >
                  {compactEditorLayout ? "关闭" : "收起"}
                </Button>
              </div>
              {!directMode && (
                <InlineAlert
                  tone="ai-clarification"
                  title="正文始终由你决定"
                  description={
                    usesNativeModel
                      ? "生成内容会先成为 AI 建议版本；只有你比较并接受后，才会创建新的正文版本。"
                      : "当前使用本机示例帮助检查流程，不会联网；只有你接受后，内容才会进入正文。"
                  }
                />
              )}
              {chapter?.isLocalOnly === true && (
                <section className="candidate-content" aria-label="私密章节本地限制">
                  <InlineAlert
                    tone="warning"
                    title="私密章节仅限本地处理"
                    description="私密章节只在本机处理。没有可用的本地 AI 时，本次生成不会开始。"
                  />
                  <div className="candidate-actions">
                    <Link
                      className="button-link button-link--secondary"
                      to={preflightModelHubLink("model-selection")}
                    >
                      设置本地模型
                    </Link>
                    {!readonly && (
                      <Button
                        variant="secondary"
                        disabled={privacyChangeBusy}
                        onClick={() => openChapterPrivacyDialog("standard")}
                      >
                        恢复普通章节
                      </Button>
                    )}
                  </div>
                </section>
              )}
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
              {!directMode && projectId !== null && (
                <Link className="back-link" to={`/projects/${projectId}/context`}>
                  查看 AI 参考记录
                </Link>
              )}
              {normalizedGenerationError !== null && ordinaryGenerationError !== null && (
                <section className="generation-error-card" role="alert" aria-live="assertive">
                  <div>
                    <Badge tone="danger">生成未完成</Badge>
                    <strong>
                      {directMode ? "本次创作未完成" : normalizedGenerationError.title}
                    </strong>
                  </div>
                  <p>
                    {privateGenerationBlocked
                      ? directMode
                        ? "本章处于私密模式，但目前没有可用且已验证的本地创作服务。本次没有发送正文。"
                        : "私密章节只在本机处理。没有可用的本地 AI 时，本次生成不会开始。"
                      : directMode
                        ? "创作服务未能完整返回结果，请检查服务后重试。"
                        : ordinaryGenerationError.description}
                  </p>
                  <p className="generation-error-card__saved-state">
                    正文和已保存版本没有变化，你可以继续写作。
                  </p>
                  <div className="generation-error-card__actions">
                    <Button
                      variant="ai-primary"
                      loading={candidateBusy}
                      disabled={!editorClean || unsafeGenerationFragmentPending}
                      onClick={() =>
                        void (lastGenerationAction === "selection_rewrite" ||
                        lastGenerationAction === "polish" ||
                        lastGenerationAction === "expand" ||
                        lastGenerationAction === "shorten"
                          ? rewriteSelectedText(
                              lastSelectionRewriteInstruction,
                              lastGenerationAction,
                            )
                          : generateCandidate())
                      }
                    >
                      {lastGenerationAction === "polish"
                        ? "重试润色"
                        : lastGenerationAction === "expand"
                          ? "重试扩写"
                          : lastGenerationAction === "shorten"
                            ? "重试缩写"
                            : lastGenerationAction === "selection_rewrite"
                              ? "重试选区改写"
                              : "重试生成"}
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
                        onClick={() => openChapterPrivacyDialog("standard")}
                      >
                        改用普通模式
                      </Button>
                    )}
                    {usesNativeModel && (
                      <Link className="back-link" to="/settings#model-center">
                        {privateGenerationBlocked
                          ? directMode
                            ? "配置本地创作服务"
                            : "配置本地 AI"
                          : directMode
                            ? "检查创作服务"
                            : "检查 AI 服务"}
                      </Link>
                    )}
                  </div>
                </section>
              )}

              {storyStateUpdate.state === "unavailable" && (
                <InlineAlert
                  tone="warning"
                  title="连续故事状态暂不可用"
                  description={`这项附属资料没有读取成功；正文和不会被改动的历史版本仍可使用，也没有删除任何记录。请稍后重试。问题编号（联系支持时提供）：${storyStateUpdate.diagnosticId}。`}
                />
              )}
              {!directMode && storyStateUpdate.state === "ready" && (
                <InlineAlert
                  tone={storyStateUpdate.needsConfirmationCount > 0 ? "warning" : "info"}
                  title={`识别到 ${String(storyStateUpdate.detectedCount)} 项变化，其中 ${String(storyStateUpdate.needsConfirmationCount)} 项需要确认`}
                  description={
                    storyStateUpdate.skippedTaskCount > 0
                      ? "部分识别因没有可用的创作服务而跳过，没有使用假数据。可先继续写作，或连接服务后再次保存新版本。"
                      : `另有 ${String(storyStateUpdate.reversibleCount)} 项属于可撤销的普通更新。所有变化都保留原文章节、版本和精确引文。`
                  }
                />
              )}
              {!directMode &&
                storyStateUpdate.state === "ready" &&
                storyStateUpdate.detectedCount > 0 && (
                  <Link className="back-link" to={`/projects/${projectId ?? ""}/story`}>
                    查看并处理本章变化
                  </Link>
                )}
              {candidateBusy && directMode && !directionBusy ? (
                <div className="candidate-content" aria-live="polite">
                  <div className="candidate-content__meta">
                    <Badge tone="ai">创作中</Badge>
                  </div>
                  <p>正在完成这次创作。结果会先单独保存，正文不会自动改变。</p>
                </div>
              ) : candidateBusy && usesNativeModel ? (
                selectionRewriteBusy || generationPlan === null ? (
                  <div className="candidate-content" aria-live="polite">
                    <div className="candidate-content__meta">
                      <Badge tone="ai">{selectionRewriteActionLabel(lastGenerationAction)}中</Badge>
                      <span>{generationPreview.length} 字符</span>
                    </div>
                    <pre>
                      {generationPreview ||
                        "正在准备" + selectionRewriteActionLabel(lastGenerationAction) + "建议……"}
                    </pre>
                    <p className="candidate-panel__hint">
                      当前内容尚未写入正式正文，也不会在完成前保存为 AI 建议版本。
                    </p>
                  </div>
                ) : (
                  <GenerationProgressPanel
                    actionLabel={savedGenerationActionLabel}
                    providerLabel={
                      continuationDisclosure?.connectionDisplayName ?? "已确认的 AI 服务"
                    }
                    modelLabel={generationPlan.modelId}
                    reasoningMode={generationPlan.visibleProseReasoningMode}
                    lengthSummary={generationLengthSummary(generationPlan.outputContract)}
                    receivedVisibleCharacters={generationPreview.length}
                    stage={generationStage}
                    preview={generationPreview}
                    cancelBusy={cancelBusy}
                    onStop={() => void cancelActiveGeneration()}
                  />
                )
              ) : generationPreview.length > 0 && generationError !== null ? (
                <div className="candidate-content" role="status">
                  <div className="candidate-content__meta">
                    <Badge tone="warning">尚未安全保存</Badge>
                    <span>{generationPreview.length} 字符</span>
                  </div>
                  <pre>{generationPreview}</pre>
                  <p className="candidate-panel__hint">
                    已收到的片段仍保留在当前页面，尚未写入正文或建议版本。离开保护会继续生效，直到你明确复制或放弃这段内容。
                  </p>
                  <div className="candidate-actions">
                    <Button variant="secondary" onClick={() => void copyUnsafeGenerationPreview()}>
                      复制片段并允许离开
                    </Button>
                    <Button variant="ghost" onClick={releaseUnsafeGenerationPreview}>
                      放弃片段并允许离开
                    </Button>
                  </div>
                </div>
              ) : candidate === null ? (
                <div className="candidate-content">
                  <EmptyState
                    title={directMode ? "还没有创作结果" : "还没有 AI 建议版本"}
                    description={
                      directMode
                        ? "创作完成后会先在这里显示实际结果；只有你查看并明确使用，才会改变正文并创建新版本。"
                        : usesNativeModel
                          ? "保存正文后即可继续创作。若无法生成，请前往设置连接 AI 服务并完成连接测试。"
                          : "保存正文后可生成一份明确标注的本机示例建议，用于体验安全比较流程。"
                    }
                  />
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
                      {editorCandidateStatusLabel(candidate.status)}
                    </Badge>
                    {displayedCandidateActionLabel !== null && (
                      <span>{displayedCandidateActionLabel}</span>
                    )}
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
                  <pre aria-label={candidateReady ? "当前生成结果预览" : "完整历史生成结果"}>
                    {candidateReady ? boundedEditorPreview(candidate.content) : candidate.content}
                  </pre>
                  {candidateReady && candidate.content.length > 4_000 && (
                    <p className="candidate-panel__hint">
                      面板仅显示前 4,000 个字符；完整建议仍保留，可在比较界面逐项处理或另存。
                    </p>
                  )}
                  {candidateReady && (
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
                          ? directMode
                            ? "查看未完成结果"
                            : "保留当前部分并比较"
                          : directMode
                            ? "查看并使用"
                            : "比较建议"}
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
                  {candidate.status === "rejected" && (
                    <InlineAlert
                      tone="info"
                      title={directMode ? "这份创作结果已放弃" : "这份建议已放弃"}
                      description="结果内容仍保留在本机历史中，只读查看不会改变正文或创建版本。"
                    />
                  )}
                  {candidate.status === "rejected" && projectId !== null && chapterId !== null && (
                    <CandidateFeedbackControls
                      busy={candidateBusy || readonly}
                      onSubmit={async ({ feedbackCode, customFeedback }) => {
                        if (authorityWriteBlockedRef.current) {
                          return;
                        }
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
              )}
              <CandidateHistoryPanel
                candidates={displayedCandidateHistory}
                now={runtime.clock.now()}
                selectedCandidateId={candidate?.id ?? null}
                busy={candidateBusy || readonly}
                onView={viewHistoricalCandidate}
                onReject={(historyCandidate) =>
                  rejectCandidate(historyCandidate).then(() => undefined)
                }
                onRetain={retainCandidate}
              />
              {!editorClean && (
                <p className="candidate-panel__hint" role="status">
                  请先保存当前正文，再处理{candidateVersionLabel}。
                </p>
              )}
              {(canGenerateCandidate || candidateIncomplete) && directMode && (
                <section className="candidate-content" aria-label={savedGenerationActionLabel}>
                  {editorClean && !candidateBusy && (
                    <>
                      <p>
                        使用正文上方的“{savedGenerationActionLabel}”开始生成，或先选择创作方向。
                      </p>
                      <div className="candidate-actions">
                        <Button
                          variant="secondary"
                          disabled={preparedDirections !== null}
                          onClick={() => void prepareContinuationDirections()}
                        >
                          选择方向
                        </Button>
                      </div>
                    </>
                  )}
                  <>
                    <section className="candidate-content" aria-label="选择方向">
                      <div className="candidate-content__meta">
                        <strong>选择接下来怎么写</strong>
                      </div>
                      {directionError !== null && (
                        <InlineAlert
                          tone="warning"
                          title={directionError.title}
                          description={directionError.description}
                        />
                      )}
                      {preparedDirections !== null && (
                        <>
                          <InlineAlert
                            tone="warning"
                            title="确认本次方向生成"
                            description={
                              preparedDirections.disclosure === null
                                ? `任务：生成三个创作方向；本次要求：${formatRequirementConfirmationSummary(preparedDirections.requirement)}；模型：本机处理；资料：当前稳定正文和本次要求，私密内容仅在本机处理；预计发送 0 次、自动重试 0 次。`
                                : `任务：生成三个创作方向；本次要求：${formatRequirementConfirmationSummary(preparedDirections.requirement)}；模型：${preparedDirections.disclosure.connectionDisplayName} · ${preparedDirections.disclosure.modelId}；资料：${preparedDirections.disclosure.sentScopeLabel}，${formatPrivateContentSummary(preparedDirections.disclosure.dataDestination)}；预计发送 ${String(preparedDirections.disclosure.maximumProviderCalls)} 次、自动重试 ${String(preparedDirections.disclosure.automaticRetryCount)} 次，${formatProviderActionCostSummary(preparedDirections.disclosure)}`
                            }
                          />
                          <details>
                            <summary>查看详情</summary>
                            {project !== null && chapter !== null && (
                              <p>
                                作品《{project.name}》 · 章节《{chapter.title}》 · 当前稳定正文{" "}
                                {chapter.content.length.toLocaleString("zh-CN")} 字。
                              </p>
                            )}
                            <p>
                              完整本次要求：
                              {preparedDirections.requirement ?? "未填写额外要求"}
                            </p>
                            {preparedDirections.disclosure === null ? (
                              <p>本次只在本机准备三个方向，不会发送给外部服务。</p>
                            ) : (
                              <>
                                <p>{preparedDirections.disclosure.privacy}</p>
                                <p>发送内容：{preparedDirections.disclosure.sends.join("；")}。</p>
                                <p>
                                  本次最多向模型服务发送{" "}
                                  {String(preparedDirections.disclosure.maximumProviderCalls)} 次，
                                  自动重试{" "}
                                  {String(preparedDirections.disclosure.automaticRetryCount)} 次。
                                </p>
                                {preparedDirections.disclosure.estimatedMaximumCostMicros !==
                                  null &&
                                  preparedDirections.disclosure.currency !== null && (
                                    <p>{formatProviderActionCost(preparedDirections.disclosure)}</p>
                                  )}
                              </>
                            )}
                            <p>三个方向只用于作者选择，不会自动写入正文。</p>
                          </details>
                        </>
                      )}
                      {directionOptions.length > 0 && (
                        <div className="candidate-actions" aria-label="三个创作方向">
                          {directionOptions.map((option) => (
                            <Button
                              key={option.id}
                              variant="secondary"
                              aria-label={option.accessibleLabel}
                              disabled={candidateBusy || !editorClean}
                              onClick={() => void generateCandidate(null, option.text)}
                            >
                              {option.label}：{option.displayText}
                            </Button>
                          ))}
                        </div>
                      )}
                      {directionBusy && (
                        <p className="candidate-panel__hint" role="status">
                          正在准备三个方向，当前选项会保留到新方向准备完成。
                        </p>
                      )}
                      {!directionBusy && preparedDirections === null && (
                        <Button
                          disabled={!editorClean}
                          variant="secondary"
                          onClick={() => void prepareContinuationDirections()}
                        >
                          {directionOptions.length > 0 ? "换一组" : "重试"}
                        </Button>
                      )}
                      {!directionBusy && preparedDirections !== null && (
                        <div className="candidate-actions">
                          <Button
                            variant="ai-primary"
                            disabled={!editorClean}
                            onClick={() => void confirmContinuationDirections()}
                          >
                            确认生成
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setPreparedDirections(null);
                              recordCancelledProviderAction();
                              window.requestAnimationFrame(() =>
                                primaryEditorActionRef.current?.focus({ preventScroll: true }),
                              );
                            }}
                          >
                            取消
                          </Button>
                        </div>
                      )}
                    </section>
                  </>
                  {activeWritingTask === "continuation" && continuationLengthControls}
                  {selectionWritingControls}
                  {writingRequirementControls}
                  {novelSkillSummary}
                </section>
              )}
              {(canGenerateCandidate || candidateIncomplete) && !directMode && (
                <>
                  {activeWritingTask === "continuation" && continuationLengthControls}
                  {selectionWritingControls}
                  {writingRequirementControls}
                  {novelSkillSummary}
                  {usesNativeModel && chapter?.isLocalOnly !== true && (
                    <Link className="back-link" to="/settings#model-center">
                      设置 AI 服务
                    </Link>
                  )}
                </>
              )}
              {!directMode &&
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
              aria-label={directMode ? "创作助手" : "AI 创作助手"}
            >
              <Button
                variant="secondary"
                aria-label={directMode ? "展开创作助手" : "展开 AI 创作助手"}
                aria-expanded={assistantOpen}
                onClick={() => setAssistantOpen(true)}
              >
                {directMode ? "创作助手" : "AI 助手"}
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
        open={novelSkillDrawerOpen}
        onOpenChange={(open) => {
          setNovelSkillDrawerOpen(open);
          if (!open) void loadNovelSkillSummary();
        }}
        title="写作技能"
        description="这里与设定页使用同一套项目技能状态；保存后会参与适用的后续续写准备。"
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              setNovelSkillDrawerOpen(false);
              void loadNovelSkillSummary();
            }}
          >
            完成
          </Button>
        }
      >
        {projectId !== null && (
          <NovelSkillPanel
            projectId={projectId}
            runtime={runtime.novelSkills}
            readonly={readonly}
          />
        )}
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
                  <span>{snapshot.content.length.toLocaleString("zh-CN")} 字</span>
                  {chapter !== null && (
                    <span>
                      {versionCharacterDifferenceLabel(
                        snapshot.content.length,
                        chapter.content.length,
                      )}
                    </span>
                  )}
                  <pre className="version-list__preview">
                    {boundedEditorPreview(snapshot.content)}
                  </pre>
                  <Button
                    variant="secondary"
                    disabled={
                      versionRestoreBusy ||
                      !editorClean ||
                      readonly ||
                      chapter?.content === snapshot.content
                    }
                    onClick={() => setVersionToRestore(version)}
                  >
                    {chapter?.currentVersionId === snapshot.id
                      ? `当前版本 ${String(snapshot.sequence)}`
                      : `恢复版本 ${String(snapshot.sequence)}`}
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
                  发送给 AI 的文字量（不是金额）约为{" "}
                  {displayedContextCompilation.compiled.trace.usedTokens.toLocaleString("zh-CN")}/
                  {displayedContextCompilation.compiled.trace.maximumContextTokens.toLocaleString(
                    "zh-CN",
                  )}{" "}
                  个本机估算单位（不是计费回执）。
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
                              <span>
                                发送给 AI 的文字量约 {entry.estimatedTokens.toLocaleString("zh-CN")}{" "}
                                个本机估算单位
                              </span>
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

      {largeDeletionReview !== null && chapter !== null && largeDeletionDialogOpen && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !largeDeletionBusy) {
              setLargeDeletionDialogOpen(false);
              setEditorNotice("大幅删除仍保留为恢复草稿；确认前不会创建正式版本或自动切换章节。");
            }
          }}
          title="本次修改将删除大量正文"
          description="为避免误覆盖，修改后的短正文已先保存为恢复草稿；修改前正文仍保留在当前稳定版本中。"
          footer={
            <>
              <Button
                variant="secondary"
                disabled={largeDeletionBusy}
                onClick={() => {
                  setLargeDeletionDialogOpen(false);
                  setEditorNotice(
                    "大幅删除仍保留为恢复草稿；确认前不会创建正式版本或自动切换章节。",
                  );
                }}
              >
                取消，保留恢复草稿
              </Button>
              <Button
                variant="secondary"
                loading={largeDeletionBusy}
                disabled={largeDeletionReview.draftStatus !== "saved" || largeDeletionBusy}
                onClick={() => void restoreBeforeLargeDeletion()}
              >
                恢复修改前正文
              </Button>
              {largeDeletionReview.draftStatus === "failed" ? (
                <Button
                  loading={largeDeletionBusy}
                  disabled={largeDeletionBusy}
                  onClick={() => void retryLargeDeletionDraft()}
                >
                  重试保存恢复草稿
                </Button>
              ) : (
                <Button
                  loading={largeDeletionBusy || largeDeletionReview.draftStatus === "saving"}
                  disabled={largeDeletionReview.draftStatus !== "saved" || largeDeletionBusy}
                  onClick={() => void confirmLargeDeletion()}
                >
                  确认删除并创建版本
                </Button>
              )}
            </>
          }
        >
          <div className="version-restore-comparison">
            <InlineAlert
              tone="warning"
              title="请核对当前章节"
              description="只有明确确认后，短正文才会创建新的稳定版本；系统不会删除修改前版本。"
            />
            <dl className="generation-receipt">
              <div>
                <dt>作品</dt>
                <dd>作品：{project?.name ?? "未命名作品"}</dd>
              </div>
              <div>
                <dt>章节</dt>
                <dd>章节：{largeDeletionReview.chapterTitle}</dd>
              </div>
              <div>
                <dt>修改前</dt>
                <dd>
                  修改前：{largeDeletionReview.previousCharacterCount.toLocaleString("zh-CN")} 字
                </dd>
              </div>
              <div>
                <dt>修改后</dt>
                <dd>
                  修改后：{largeDeletionReview.proposedContent.length.toLocaleString("zh-CN")} 字
                </dd>
              </div>
            </dl>
            <div>
              <section>
                <h3>修改前的稳定正文</h3>
                <pre>{boundedEditorPreview(chapter.content)}</pre>
              </section>
              <section>
                <h3>等待确认的短正文</h3>
                <pre>{boundedEditorPreview(largeDeletionReview.proposedContent)}</pre>
              </section>
            </div>
          </div>
        </Dialog>
      )}

      {versionToRestore !== null && chapter !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !versionRestoreBusy) {
              setVersionToRestore(null);
            }
          }}
          title={`恢复版本 ${String(versionToRestore.toSnapshot().sequence)}`}
          description="恢复会创建一个新版本，旧历史不会删除。"
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
                disabled={
                  !editorClean || readonly || versionToRestore.toSnapshot().chapterId !== chapter.id
                }
                onClick={() => void restoreSelectedVersion()}
              >
                确认恢复版本 {String(versionToRestore.toSnapshot().sequence)}
              </Button>
            </>
          }
        >
          <div className="version-restore-comparison">
            <InlineAlert
              tone={versionToRestore.toSnapshot().chapterId === chapter.id ? "warning" : "error"}
              title={
                versionToRestore.toSnapshot().chapterId === chapter.id
                  ? `目标章节：《${chapter.title}》`
                  : "目标章节与当前章节不一致"
              }
              description={
                versionToRestore.toSnapshot().chapterId === chapter.id
                  ? "请确认这是你准备恢复的章节。恢复只会追加新版本，不会回写旧记录；若章节在确认前发生变化，版本冲突保护会阻止提交。"
                  : "为保护正文，当前无法确认恢复。请关闭窗口，从目标章节的版本历史重新选择。"
              }
            />
            <dl className="generation-receipt">
              <div>
                <dt>作品</dt>
                <dd>作品：{project?.name ?? "未命名作品"}</dd>
              </div>
              <div>
                <dt>章节</dt>
                <dd>章节：{chapter.title}</dd>
              </div>
              <div>
                <dt>目标版本</dt>
                <dd>目标版本：版本 {String(versionToRestore.toSnapshot().sequence)}</dd>
              </div>
              <div>
                <dt>目标字数</dt>
                <dd>
                  目标字数：
                  {versionToRestore.toSnapshot().content.length.toLocaleString("zh-CN")} 字
                </dd>
              </div>
              <div>
                <dt>当前字数</dt>
                <dd>当前字数：{chapter.content.length.toLocaleString("zh-CN")} 字</dd>
              </div>
            </dl>
            <p>恢复会创建一个新版本，旧历史不会删除。</p>
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
              setPrivacyChangeFailure(null);
            }
          }}
          title={
            privacyChangeTarget === "local_only" ? "将本章设为私密章节？" : "允许本章使用联网 AI？"
          }
          description={
            privacyChangeTarget === "local_only"
              ? "确认后，私密章节只在本机处理。没有可用的本地 AI 时，本次生成不会开始。"
              : "确认后，未来的联网 AI、同步与普通导出可以按你的设置使用本章所需内容。"
          }
          footer={
            <>
              <Button
                variant="secondary"
                disabled={privacyChangeBusy}
                onClick={() => {
                  setPrivacyChangeTarget(null);
                  setPrivacyChangeFailure(null);
                }}
              >
                取消
              </Button>
              <Button
                loading={privacyChangeBusy}
                disabled={project?.status !== "active"}
                onClick={() => void confirmChapterPrivacyChange()}
              >
                {privacyChangeFailure !== null
                  ? privacyChangeTarget === "local_only"
                    ? "重新尝试设为私密"
                    : "重新尝试改为普通章节"
                  : privacyChangeTarget === "local_only"
                    ? "确认仅限本地"
                    : "确认改为普通章节"}
              </Button>
            </>
          }
        >
          <>
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
            {privacyChangeFailure !== null && (
              <InlineAlert
                tone="error"
                title="隐私设置没有保存"
                description={
                  <>
                    <p>{privacyChangeFailure.description}</p>
                    <p>正文和已有版本没有改变。</p>
                    <p>问题编号（联系支持时提供）：{privacyChangeFailure.supportId}</p>
                  </>
                }
                action={{
                  label: "重新读取章节",
                  onClick: () => {
                    setPrivacyChangeTarget(null);
                    setPrivacyChangeFailure(null);
                    void load();
                  },
                }}
              />
            )}
          </>
        </Dialog>
      )}

      {recoveryDraftSnapshot !== null && chapter !== null && (
        <CrashRecoveryDialog
          busy={recoveryDecisionBusy}
          canSaveAsCopy={!readonly && !recoveryCopySaved}
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
        title={directMode ? "查看创作结果与正文" : "比较建议与正文"}
        description={
          directMode
            ? "结果仍与正文隔离；明确点击“使用这版”前不会改变正文或创建版本。"
            : "先把建议改到满意，再逐处决定或选择应用位置；点击创建版本前不会写入正文。"
        }
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
          {project !== null && chapter !== null && (
            <InlineAlert
              tone="info"
              title={`正在处理《${chapter.title}》`}
              description={`作品《${project.name}》 · 当前章节《${chapter.title}》。下面的结果仍与这章正文隔离；只有点击“使用这版”或明确的创建版本操作后才会写入本章。`}
            />
          )}
          <Button
            className="candidate-review-dialog__scroll-control"
            variant="ghost"
            onKeyDown={handleCandidateReviewNavigation}
          >
            浏览{candidateActionGap}
            {candidateSuggestionLabel}内容（PageUp / PageDown / Home / End）
          </Button>
          <nav className="candidate-review-dialog__navigation" aria-label="长内容快速定位">
            <Button variant="secondary" onClick={() => navigateCandidateReviewTo("start")}>
              查看开头
            </Button>
            <Button variant="secondary" onClick={() => navigateCandidateReviewTo("end")}>
              查看结尾
            </Button>
            <Button
              variant="secondary"
              disabled={candidateReviewConflict !== null}
              onClick={() => navigateCandidateReviewTo("edit")}
            >
              返回修改处
            </Button>
          </nav>
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
                disabled={candidateBusy || readonly}
                onChange={(event) => {
                  setCandidateReviewDraft(event.currentTarget.value);
                  setCandidateDiffDecisions({});
                  setCandidateRevisionSaved(false);
                  setCandidateOverlapAcknowledged(false);
                }}
              />
              <div className="candidate-review-dialog__editor-actions">
                <span>{candidateReviewDraft.length.toLocaleString("zh-CN")} 字符</span>
                <Button
                  variant="secondary"
                  loading={candidateBusy}
                  disabled={
                    candidateBusy ||
                    readonly ||
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
                description={`已阻止接受。下面同时保留生成时正文、当前正文和${candidateSuggestionLabel}；请先另存或处理冲突，墨影不会静默覆盖。`}
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
          {candidateStableOverlap?.risk === "high" && candidate !== null && (
            <section
              className="candidate-review-dialog__overlap"
              aria-label="续写与当前正文重合检查"
            >
              <InlineAlert
                tone="warning"
                title={
                  candidateStableOverlap.kind === "exact_prefix"
                    ? "续写开头完整重复了当前正文"
                    : "续写开头与当前正文高度相似"
                }
                description={
                  candidateStableOverlap.kind === "exact_prefix"
                    ? `本机逐字确认，续写开头包含当前稳定正文的完整内容（${candidateStableOverlap.exactPrefixCharacters.toLocaleString("zh-CN")} 字符）。直接使用会造成大段重复；正文目前没有变化。`
                    : `本机比较了开头 ${candidateStableOverlap.comparedCharacters.toLocaleString("zh-CN")} 个字符，相似度约 ${String(Math.round(candidateStableOverlap.similarity * 100))}%。这只是确定性的本地比较，没有再次调用模型，也不会自动裁剪近似内容。`
                }
              />
              {candidateStableOverlap.kind === "exact_prefix" &&
                candidateStableOverlap.removableRangeUtf16 !== null &&
                candidateContinuationCursor !== null &&
                candidateReviewDraft === candidate.content && (
                  <div className="candidate-review-dialog__overlap-comparison">
                    <section>
                      <h3>处理前：完整原始结果</h3>
                      <pre>{boundedEditorPreview(candidateReviewDraft)}</pre>
                    </section>
                    <section>
                      <h3>处理后：只保留新增部分</h3>
                      <pre>
                        {boundedEditorPreview(
                          candidateReviewDraft.slice(
                            0,
                            candidateStableOverlap.removableRangeUtf16.start,
                          ) +
                            candidateReviewDraft.slice(
                              candidateStableOverlap.removableRangeUtf16.end,
                            ),
                        )}
                      </pre>
                    </section>
                    <Button
                      variant="secondary"
                      loading={candidateBusy}
                      disabled={
                        candidateBusy ||
                        candidateReviewConflict !== null ||
                        candidateAuthorityApplicationBlocked
                      }
                      onClick={() =>
                        void acceptCandidate({
                          kind: "insert_at_cursor_omitting_exact_prefix",
                          cursorUtf16: candidateContinuationCursor,
                          omittedCandidateRange: candidateStableOverlap.removableRangeUtf16 ?? {
                            start: 0,
                            end: 0,
                          },
                        })
                      }
                    >
                      移除重复部分后使用并创建版本
                    </Button>
                  </div>
                )}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  aria-label="我已查看重复证据，仍要使用完整结果"
                  checked={candidateOverlapAcknowledged}
                  onChange={(event) => setCandidateOverlapAcknowledged(event.currentTarget.checked)}
                />
                <span>我已查看重复证据，仍要使用完整结果</span>
              </label>
              <p>勾选只确认这一次接受；候选原文和检查证据不会被静默改写。</p>
            </section>
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
          if (!budgetSaving && !directDisclosureSaving && !candidateBusy) {
            if (open) {
              setPreflightOpen(true);
            } else {
              cancelPreflightAndFocusEditor();
            }
          }
        }}
        title={(generationPlan?.actionLabel ?? savedGenerationActionLabel) + "前检查"}
        description="请核对本次使用的模型、故事资料和发送次数；只有点击确认后才会发送。"
        footer={
          generationPlan?.preflight.readiness === "BLOCKED" ? (
            <>
              <Button
                variant="secondary"
                disabled={budgetSaving || directDisclosureSaving || candidateBusy}
                onClick={cancelPreflightAndFocusEditor}
              >
                先自己写
              </Button>
              <Button
                variant="secondary"
                disabled={budgetSaving || directDisclosureSaving || candidateBusy}
                onClick={() => void saveAndClosePreflight()}
              >
                保存并关闭
              </Button>
              {canDeferGenerationPlan(generationPlan) && (
                <Button
                  variant="secondary"
                  loading={candidateBusy}
                  disabled={budgetSaving || directDisclosureSaving || candidateBusy}
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
                disabled={budgetSaving || directDisclosureSaving || candidateBusy}
                onClick={cancelPreflightAndFocusEditor}
              >
                取消
              </Button>
              <Button
                variant="ai-primary"
                loading={directDisclosureSaving}
                disabled={
                  !generationPlan?.preflight.canStart ||
                  budgetSaving ||
                  directDisclosureSaving ||
                  candidateBusy
                }
                onClick={() => void confirmGeneration()}
              >
                确认生成
              </Button>
            </>
          )
        }
      >
        {generationPlan !== null && (
          <div className="generation-preflight">
            {generationPlan.preflight.readiness === "BLOCKED" && (
              <InlineAlert
                tone="error"
                title="当前无法调用 AI"
                description={
                  canDeferGenerationPlan(generationPlan)
                    ? "当前只因网络离线而阻断；可保存不含正文和创作指令的待执行记录，联网后重新检查并确认。"
                    : "请按下列操作修复后重新检查；当前不会调用 AI 服务，但正文仍可编辑和保存。"
                }
              />
            )}

            {continuationDisclosure === null ? (
              generationPlan.executionMode === "local_demo" ? (
                <InlineAlert
                  tone="info"
                  title="本次不会发送到外部 AI 服务"
                  description="这是本机演示流程。完整结果只会保存为隔离的 AI 建议草稿；只有你稍后明确选择使用，才会改变正文并创建不会被改动的历史版本。"
                />
              ) : null
            ) : (
              <InlineAlert
                tone={continuationConfirmationIsRemembered ? "info" : "warning"}
                title={
                  continuationConfirmationIsRemembered ? "已记住本次会话的相同确认" : "发送确认摘要"
                }
                description={`任务：${generationPlan.actionLabel}；本次要求：${formatRequirementConfirmationSummary(generationPlan.outputContract.customDestinationInstruction)}；模型：${continuationDisclosure.connectionDisplayName} · ${continuationDisclosure.modelId}；资料：${continuationDisclosure.sentScopeLabel}，${formatPrivateContentSummary(continuationDisclosure.dataDestination)}；预计发送 ${String(continuationDisclosure.maximumProviderCalls)} 次、自动重试 ${String(continuationDisclosure.automaticRetryCount)} 次，${formatProviderActionCostSummary(continuationDisclosure)}`}
              />
            )}
            <details>
              <summary>查看详情</summary>
              {(displayedContextCompilation !== null ||
                displayedNovelSkillPreparation !== null) && (
                <Button variant="secondary" onClick={() => setContextSourcesOpen(true)}>
                  查看本次参考
                </Button>
              )}
              {continuationDisclosure !== null && (
                <>
                  {project !== null && chapter !== null && (
                    <section
                      className="generation-preflight__confirmation-memory"
                      aria-label="本次写作章节"
                    >
                      <h3>本次写作章节</h3>
                      <p>
                        作品《{project.name}》 · 章节《{chapter.title}》 · 当前稳定正文{" "}
                        {chapter.content.length.toLocaleString("zh-CN")} 字。
                      </p>
                    </section>
                  )}
                  <section
                    className="generation-preflight__confirmation-memory"
                    aria-label="完整发送前说明"
                  >
                    <h3>完整发送前说明</h3>
                    <p>
                      完整本次要求：
                      {generationPlan.outputContract.customDestinationInstruction ??
                        "未填写额外要求"}
                    </p>
                    <p>{continuationDisclosure.privacy}</p>
                    <p>发送内容：{continuationDisclosure.sends.join("；")}。</p>
                    <p>
                      本次最多向模型服务发送 {String(continuationDisclosure.maximumProviderCalls)}{" "}
                      次，自动重试 {String(continuationDisclosure.automaticRetryCount)} 次。
                    </p>
                    <p>
                      这次确认只适用于当前正文版本与本次生成计划；任一项变化都会停止发送并要求重新确认。完整结果只会保存为隔离的
                      {directMode ? "创作结果" : " AI 建议草稿"}
                      ，正文和版本保持不变，直到你明确选择使用。
                    </p>
                    {continuationConfirmationIsRemembered && (
                      <p>当前会话已记住完全相同的发送范围；仍需点击“确认生成”才会发送。</p>
                    )}
                  </section>
                  {!continuationConfirmationIsRemembered && (
                    <section
                      className="generation-preflight__confirmation-memory"
                      aria-label="本次确认方式"
                    >
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          aria-label="在当前会话记住本次确认"
                          checked={rememberContinuationConfirmationForSession}
                          onChange={(event) =>
                            setRememberContinuationConfirmationForSession(
                              event.currentTarget.checked,
                            )
                          }
                        />
                        <span>在当前会话记住本次确认</span>
                      </label>
                      <p>
                        仅限同一作品、章节、正文版本、模型、服务、任务、资料范围和隐私去向；任一项变化都会重新确认。
                      </p>
                    </section>
                  )}
                </>
              )}
              {generationPlan.contextCompilation !== null &&
                generationPlan.contextCompilation.compiled.entries.some(
                  ({ included, layer }) => included && layer === "locked_hard_rules",
                ) && (
                  <section
                    className="generation-preflight__confirmation-memory"
                    aria-labelledby="generation-confirmed-constraints-heading"
                  >
                    <h3 id="generation-confirmed-constraints-heading">本次必须遵守的创作约束</h3>
                    <p>以下内容会随本次任务发送给上方列明的模型服务；未列出的资料不会因此加入。</p>
                    <ul>
                      {generationPlan.contextCompilation.compiled.entries
                        .filter(({ included, layer }) => included && layer === "locked_hard_rules")
                        .map((entry) => (
                          <li key={`confirmed-constraint:${entry.id}`}>
                            <blockquote>{entry.content}</blockquote>
                          </li>
                        ))}
                    </ul>
                  </section>
                )}

              <details>
                <summary>创作任务安排与隐私详情（高级）</summary>
                <InlineAlert
                  tone={generationPlan.routeReason === "role_fallback" ? "warning" : "info"}
                  title={
                    generationPlan.routeReason === "role_fallback"
                      ? "将使用已配置的备用服务"
                      : "本次创作任务安排"
                  }
                  description={`${generationRouteRoleLabel(generationPlan.modelRole)} · ${
                    continuationDisclosure?.connectionDisplayName ??
                    (generationPlan.executionMode === "local_demo"
                      ? "本机演示"
                      : "已确认的 AI 服务")
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
                      发送给 AI 的文字量（不是金额）约为{" "}
                      {generationPlan.contextCompilation.compiled.trace.usedTokens.toLocaleString(
                        "zh-CN",
                      )}
                      /
                      {generationPlan.contextCompilation.compiled.trace.maximumContextTokens.toLocaleString(
                        "zh-CN",
                      )}{" "}
                      个本机估算单位（不是计费回执）；未选资料不会发送给模型。
                    </p>
                    <p>{contextBudgetExplanation(generationPlan.contextCompilation.compiled)}</p>
                    <ul>
                      {generationPlan.contextCompilation.compiled.entries.map((entry) => (
                        <li key={entry.id}>
                          <Badge tone={entry.included ? "info" : "neutral"}>
                            {contextEntryStatusLabel(entry)}
                          </Badge>{" "}
                          <strong>{contextLayerLabel(entry.layer)}</strong>
                          <span>
                            {" "}
                            · 发送给 AI 的文字量约 {entry.estimatedTokens.toLocaleString(
                              "zh-CN",
                            )}{" "}
                            个本机估算单位
                          </span>
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
                {generationPlan.preflight.checks
                  .filter(({ code }) => code !== "PREFLIGHT_WARNING_PRICING_UNKNOWN")
                  .map((check) => (
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
                        <Button variant="secondary" onClick={cancelPreflightAndFocusEditor}>
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
                        <dt>发送给 AI / AI 返回的文字量（不是金额）</dt>
                        <dd>
                          {generationPlan.preflight.inputTokens.toLocaleString("zh-CN")} /{" "}
                          {generationPlan.preflight.maximumOutputTokens.toLocaleString("zh-CN")}{" "}
                          个本机估算单位
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
                              setMonthBudgetEnforcement(
                                event.currentTarget.value as "warn" | "hard",
                              )
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
            </details>
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
    return "服务商未提供费用信息，本次费用暂无法估算。";
  }
  return `本次费用上限 ${disclosure.estimatedMaximumCostMicros} 微单位 ${disclosure.currency}`;
}

function formatSelectionRewriteCostSummary(disclosure: SelectionRewriteDisclosure): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null) {
    return "服务商未提供费用信息，本次费用暂无法估算。";
  }
  return `费用上限：${disclosure.estimatedMaximumCostMicros} 微单位 ${disclosure.currency}。`;
}

function selectionRewriteActionLabel(action: EditorGenerationAction): string {
  if (action === "polish") return "润色";
  if (action === "expand") return "扩写";
  if (action === "shorten") return "缩写";
  return "改写";
}

function formatProviderActionCost(disclosure: ContinuationGenerationDisclosure): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null) {
    return "服务商未提供费用信息，本次费用暂无法估算。";
  }
  return `本次费用上限 ${disclosure.estimatedMaximumCostMicros} 微单位 ${disclosure.currency}`;
}

function formatProviderActionCostSummary(disclosure: ContinuationGenerationDisclosure): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null) {
    return "服务商未提供费用信息，本次费用暂无法估算。";
  }
  return `费用上限：${disclosure.estimatedMaximumCostMicros} 微单位 ${disclosure.currency}。`;
}

function formatPrivateContentSummary(dataDestination: "local" | "remote"): string {
  return dataDestination === "local" ? "私密内容仅在本机处理" : "不包含私密内容";
}

function generationLengthSummary(contract: ContinuationOutputContract): string {
  const sizeLabel = contract.profile === "short" ? "短" : contract.profile === "long" ? "长" : "中";
  if (contract.advancedTargetVisibleCharacters !== null) {
    return `${sizeLabel} · 目标约 ${String(contract.advancedTargetVisibleCharacters)} 字（允许约 ±20% 浮动）`;
  }
  return contract.profile === "short"
    ? "短 · 一小段推进"
    : contract.profile === "long"
      ? "长 · 一场完整事件或情绪推进"
      : "中 · 一个完整场景";
}

function formatRequirementConfirmationSummary(requirement: string | null | undefined): string {
  return requirement?.normalize("NFKC").trim().length ? "已填写要求" : "未填写额外要求";
}

function continuationConfirmationScope(
  plan: PreparedGenerationPlan,
  disclosure: ContinuationGenerationDisclosure | null,
): ContinuationConfirmationScope | null {
  if (disclosure === null || plan.projectId === null || plan.baseVersionId === null) return null;
  return Object.freeze({
    projectId: plan.projectId,
    chapterId: plan.chapterId,
    bodyVersionId: plan.baseVersionId,
    modelId: disclosure.modelId,
    providerDisplayName: disclosure.connectionDisplayName,
    taskType: plan.modelTask,
    storyDataScope: disclosure.sentScopeLabel,
    privacyDestination: disclosure.dataDestination,
    disclosureFingerprint: disclosure.fingerprint,
  });
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
    return "你已在创作任务安排中明确允许远程重排；阿里云百炼 Qwen 将这项资料排到了更相关的位置。";
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
    PREFLIGHT_WARNING_PRICING_UNKNOWN: "费用信息尚未完善",
    PREFLIGHT_WARNING_CONTEXT_UNKNOWN: "未获取精确的资料处理上限，将使用保守长度整理参考内容",
    PREFLIGHT_WARNING_TOKEN_ESTIMATE_APPROXIMATE:
      "发送给 AI 的文字量为本机估算（不是金额），已预留安全余量",
    PREFLIGHT_BLOCKED_NO_ROUTE: "没有可用的正文生成创作任务安排",
    PREFLIGHT_BLOCKED_CREDENTIAL: "AI 服务凭据缺失或不可用",
    PREFLIGHT_BLOCKED_MODEL_UNAVAILABLE: "连接或所选模型确定不可用",
    PREFLIGHT_BLOCKED_PRIVACY: "当前隐私规则不允许使用这项 AI 服务",
    PREFLIGHT_BLOCKED_CONTEXT_OVERFLOW: "精简后仍超过当前可处理的资料长度",
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
    long_context: "长篇资料容量",
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
        : `，其中缓存文字量 ${usage.cachedInputTokens.toLocaleString("zh-CN")}`;
    return `第 ${String(usage.attempt)} 次供应商回执：发送给 AI 的文字量 ${usage.inputTokens.toLocaleString(
      "zh-CN",
    )}${cached}，AI 返回的文字量 ${usage.outputTokens.toLocaleString(
      "zh-CN",
    )}（不是金额）；按价格版本重算 ${formatCostEstimate(
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
        : `，其中缓存文字量 ${usage.cachedInputTokens.toLocaleString("zh-CN")}`;
    return `第 ${String(usage.attempt)} 次供应商回执：发送给 AI 的文字量 ${usage.inputTokens.toLocaleString(
      "zh-CN",
    )}${cached}，AI 返回的文字量 ${usage.outputTokens.toLocaleString(
      "zh-CN",
    )}（不是金额）；服务商没有提供可计算的单价，实际费用请以服务商账单为准。`;
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
