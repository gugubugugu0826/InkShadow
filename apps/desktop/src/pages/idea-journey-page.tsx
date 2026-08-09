import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
  Textarea,
} from "@inkshadow/ui";
import { parseUuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7, type StoryFact } from "@inkshadow/story-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  generateCreativeOpening,
  generateLocalCreativeOpening,
  inspectCreativeOpeningDestination,
  MINIMUM_USABLE_PARTIAL_OPENING_CHARACTERS,
  persistCreativeOpeningCandidate,
  type CreativeOpeningAngle,
  type CreativeOpeningDestination,
  type CreativeOpeningResult,
} from "../infrastructure/creative-opening-service";
import {
  QuickAiConnectionDrawer,
  type QuickAiContinueChoice,
} from "../components/quick-ai-connection-drawer";
import {
  CreativeJourneyStoreError,
  type CreativeJourneyRecord,
  type CreativeJourneyTurnKind,
  type CreativeJourneyTurnRecord,
} from "../infrastructure/creative-journey-store";
import {
  deriveIdeaProjectSeed,
  parseProjectSeed,
  type ProjectSeed,
} from "../infrastructure/project-seed";
import { normalizeUiError, UiActionError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

interface IdeaJourneySnapshotV1 extends Readonly<Record<string, unknown>> {
  readonly version: 1;
  readonly openingMode: "guided" | "self" | "sample";
  readonly idea: string;
  readonly preview: string;
  readonly previewSource: "provider" | "local_fallback" | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly noticeCode: string | null;
  readonly pendingRequestId: string | null;
  readonly openingGenerationMode: "provider" | "local";
  readonly openingSuggestions: readonly IdeaOpeningSuggestionV1[];
  readonly openingResultHistory: readonly IdeaOpeningSuggestionV1[];
  readonly selectedOpeningId: string | null;
  readonly openingBatchId: string | null;
  readonly openingBatchFailureCount: number;
  readonly provisioningPlan: IdeaJourneyProvisioningPlanV1 | null;
  readonly answers: Readonly<Record<string, string>>;
  readonly skippedQuestionKeys: readonly string[];
  readonly questionHistory: readonly string[];
  /** Persisted and append-only, with unique keys and a repository-wide hard cap. */
  readonly questionPlan: readonly string[];
  readonly expectedQuestionTotal: number;
  /** Zero-based cursor; questionPlan.length is the explicit completed state. */
  readonly questionIndex: number;
  /** Unresolved focus pool; every answer or skip must strictly reduce this set. */
  readonly remainingQuestionFocus: readonly string[];
  readonly questionPlanExpansionNotice: string | null;
  readonly currentQuestionKey: string;
  readonly projectName: string;
  readonly storySummary: string;
  readonly summaryCustomized: boolean;
  /** At most one author-requested rewrite is allowed after the finite question plan. */
  readonly guidanceRewriteUsed: boolean;
  readonly projectSeed: ProjectSeed;
}

interface IdeaOpeningSuggestionV1 extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly batchId: string;
  readonly text: string;
  readonly source: "provider" | "local_fallback";
  readonly status: "pending" | "ready" | "partial" | "failed";
  readonly openingAngle: CreativeOpeningAngle | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly noticeCode: string | null;
}

interface PersistedIdeaOpeningSuggestionV1 extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly batchId: string;
  readonly text: string;
  readonly source: "provider" | "local_fallback";
  readonly status: "pending" | "ready" | "partial" | "failed";
  readonly openingAngle?: CreativeOpeningAngle | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly noticeCode: string | null;
}

interface IdeaJourneyProvisioningPlanV1 extends Readonly<Record<string, unknown>> {
  readonly projectId: string;
  readonly chapterId: string;
  readonly initialVersionId: string;
  /** Exact name to create, persisted before the project write. */
  readonly projectName: string | null;
}

interface ProviderOpeningBatchPlan {
  readonly batchId: string;
  readonly requests: readonly Readonly<{
    requestId: string;
    openingAngle: CreativeOpeningAngle;
    replacesOpeningId?: string;
  }>[];
}

interface AbandonedOpeningGeneration {
  readonly snapshot: IdeaJourneySnapshotV1;
  readonly requestIds: readonly string[];
  readonly batchId: string | null;
}

interface JourneyOperation {
  readonly token: number;
  readonly journeyId: string | null;
}

interface BlankWorkspaceAttempt {
  readonly record: CreativeJourneyRecord;
  readonly snapshot: IdeaJourneySnapshotV1;
  readonly initialTurn: CreativeJourneyTurnRecord;
}

interface JourneyQuestion {
  readonly key: string;
  readonly prompt: string;
  readonly helper: string;
  readonly options: readonly string[];
  readonly placeholder: string;
}

const QUESTIONS: readonly JourneyQuestion[] = Object.freeze([
  Object.freeze({
    key: "opening_direction",
    prompt: "你想先把这个开头往哪个方向推？",
    helper: "先调到你愿意继续写的感觉，其他设定可以稍后再补。",
    options: Object.freeze([
      "更甜一点",
      "更搞笑一点",
      "增加悬念",
      "换一种男女主关系",
      "更接近日系轻小说",
    ]),
    placeholder: "也可以直接说：保留情节，但让对话更自然……",
  }),
  Object.freeze({
    key: "tone",
    prompt: "读者看完这一段，你最想让他们留下什么感觉？",
    helper: "这会影响叙述节奏和词语选择，不会锁死后续剧情。",
    options: Object.freeze(["温暖心动", "轻松好笑", "紧张悬疑", "克制伤感"]),
    placeholder: "例如：表面轻松，但隐约让人不安。",
  }),
  Object.freeze({
    key: "protagonist",
    prompt: "这一段主要跟着怎样的主角？",
    helper: "只说当前最重要的一点就够了。",
    options: Object.freeze(["普通但很敏锐", "嘴硬心软", "目标感很强", "隐藏着秘密"]),
    placeholder: "例如：刚转学、很会观察别人，却不擅长表达自己。",
  }),
  Object.freeze({
    key: "relationship",
    prompt: "主角和关键人物目前是什么关系？",
    helper: "关系会先作为可修改方案，不会自动写成永久设定。",
    options: Object.freeze(["刚刚认识", "青梅竹马", "互相看不顺眼", "一方认识另一方"]),
    placeholder: "例如：小时候见过，但只有女主还记得。",
  }),
  Object.freeze({
    key: "conflict",
    prompt: "眼前最先需要解决的麻烦是什么？",
    helper: "先确定能推动下一场景的小冲突，不必现在想完整大纲。",
    options: Object.freeze(["误会正在扩大", "秘密可能暴露", "必须共同完成一件事", "有人突然失踪"]),
    placeholder: "例如：两人被迫在放学前找到丢失的社团钥匙。",
  }),
  Object.freeze({
    key: "pov",
    prompt: "你想离谁的感受最近？",
    helper: "不确定可以跳过，系统会先保持当前写法。",
    options: Object.freeze(["第一人称主角", "第三人称跟随主角", "双主角轮换", "暂时保持当前"]),
    placeholder: "例如：第三人称限知，只写男主能察觉到的事。",
  }),
  Object.freeze({
    key: "style",
    prompt: "有没有一种你希望长期保持的写法？",
    helper: "可以描述喜欢的节奏，不需要懂提示词。",
    options: Object.freeze(["短句和更多对话", "细腻但不过度", "节奏快、少解释", "画面感更强"]),
    placeholder: "例如：减少总结句，让情绪从动作和对话里出来。",
  }),
  Object.freeze({
    key: "boundaries",
    prompt: "目前有什么内容一定不要出现？",
    helper: "这类限制会作为需要优先遵守的写作边界。",
    options: Object.freeze(["不要突然加入超自然设定", "不要强行误会", "不要角色降智", "暂时没有"]),
    placeholder: "例如：不写校园霸凌，不让主角靠巧合解决问题。",
  }),
  Object.freeze({
    key: "direction",
    prompt: "接下来一章最值得推进的是什么？",
    helper: "这是初步方向，进入正文后仍可以随时调整。",
    options: Object.freeze([
      "让两人再次相遇",
      "揭开一个小秘密",
      "制造必须合作的事件",
      "先展示日常关系",
    ]),
    placeholder: "用一句话描述你最想看到的下一步。",
  }),
  Object.freeze({
    key: "genre",
    prompt: "如果给这个故事一个类型标签，你最希望是什么？",
    helper: "只选当前最接近的方向即可，后面仍然可以混合其他类型。",
    options: Object.freeze(["青春恋爱", "悬疑", "科幻", "奇幻", "都市日常"]),
    placeholder: "例如：带一点悬疑的青春恋爱轻小说。",
  }),
  Object.freeze({
    key: "world",
    prompt: "这个故事发生在怎样的地方或时代？",
    helper: "一句最影响人物行动的背景就够了，不需要先写完整世界书。",
    options: Object.freeze(["当代校园", "近未来城市", "架空小镇", "异世界", "先保持现实背景"]),
    placeholder: "例如：一座每到午夜就会停电十分钟的沿海小城。",
  }),
  Object.freeze({
    key: "outline",
    prompt: "目前能确定的第一段故事走向是什么？",
    helper: "这只是可继续修改的初步大纲，不会锁死后续剧情。",
    options: Object.freeze([
      "相遇并被迫合作",
      "发现秘密并开始调查",
      "误会扩大后重新理解对方",
      "先写日常再引出冲突",
    ]),
    placeholder: "例如：两人先找到失踪物品，再发现它与十年前的旧案有关。",
  }),
]);

const QUESTION_BY_KEY = new Map(QUESTIONS.map((question) => [question.key, question]));
const DEFAULT_QUESTION = firstQuestion(QUESTIONS);
const PROVIDER_OPENING_ANGLES: readonly CreativeOpeningAngle[] = Object.freeze([
  "immediate_action",
  "relationship_dialogue",
  "mystery_clue",
]);
const GENERATION_ABANDONED_BY_AUTHOR = "GENERATION_ABANDONED_BY_AUTHOR";
const OPENING_RESULT_RECONCILE_ATTEMPTS = 8;
const DEFAULT_GUIDANCE_QUESTION_PLAN: readonly string[] = Object.freeze([
  "opening_direction",
  "protagonist",
  "conflict",
  "tone",
  "boundaries",
]);
const ALL_GUIDANCE_FOCUS_KEYS: readonly string[] = Object.freeze(QUESTIONS.map(({ key }) => key));
const MAX_GUIDANCE_PLAN_LENGTH = QUESTIONS.length;

function firstQuestion(questions: readonly JourneyQuestion[]): JourneyQuestion {
  const [question] = questions;
  if (question === undefined) {
    throw new Error("开书引导至少需要一个问题。");
  }
  return question;
}

export function IdeaJourneyPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const [listState, setListState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [activeJourneys, setActiveJourneys] = useState<readonly CreativeJourneyRecord[]>([]);
  const [unreadableJourneyCount, setUnreadableJourneyCount] = useState(0);
  const [journey, setJourney] = useState<CreativeJourneyRecord | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  const [idea, setIdea] = useState("");
  const [customAnswer, setCustomAnswer] = useState("");
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [storySummaryDraft, setStorySummaryDraft] = useState("");
  const [busy, setBusy] = useState<"create" | "answer" | "regenerate" | "keep" | null>(null);
  const [streamingPreviews, setStreamingPreviews] = useState<Readonly<Record<string, string>>>({});
  const [requestTimings, setRequestTimings] = useState<
    Readonly<Record<string, Readonly<{ startedAt: number; elapsedMs: number | null }>>>
  >({});
  const [batchProgress, setBatchProgress] = useState<Readonly<{
    completed: number;
    total: number;
  }> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [blankWorkspaceAttempt, setBlankWorkspaceAttempt] = useState<BlankWorkspaceAttempt | null>(
    null,
  );
  const [destination, setDestination] = useState<CreativeOpeningDestination | null>(null);
  const [quickAiOpen, setQuickAiOpen] = useState(false);
  const [openingPreference, setOpeningPreference] = useState<
    "ai" | "self" | "sample" | "local" | null
  >(null);
  const operationSequence = useRef(0);
  const activeOperation = useRef<JourneyOperation | null>(null);
  const resumeLock = useRef<JourneyOperation | null>(null);
  const blankWorkspaceLock = useRef<JourneyOperation | null>(null);
  const listRequestSequence = useRef(0);

  function startRequestTimings(requestIds: readonly string[]): void {
    const startedAt = Date.parse(runtime.clock.now());
    setRequestTimings((current) =>
      Object.freeze({
        ...current,
        ...Object.fromEntries(
          requestIds.map((requestId) => [requestId, Object.freeze({ startedAt, elapsedMs: null })]),
        ),
      }),
    );
  }

  function updateStreamingPreview(requestId: string, text: string): void {
    setStreamingPreviews((current) => Object.freeze({ ...current, [requestId]: text }));
    setRequestTimings((current) => {
      const timing = current[requestId];
      return timing === undefined
        ? current
        : Object.freeze({
            ...current,
            [requestId]: Object.freeze({
              ...timing,
              elapsedMs: Math.max(0, Date.parse(runtime.clock.now()) - timing.startedAt),
            }),
          });
    });
  }

  function finishRequestTiming(requestId: string): void {
    setRequestTimings((current) => {
      const timing = current[requestId];
      return timing === undefined
        ? current
        : Object.freeze({
            ...current,
            [requestId]: Object.freeze({
              ...timing,
              elapsedMs: Math.max(0, Date.parse(runtime.clock.now()) - timing.startedAt),
            }),
          });
    });
  }

  function clearStreamingPreviews(requestIds?: readonly string[]): void {
    if (requestIds === undefined) {
      setStreamingPreviews({});
      return;
    }
    setStreamingPreviews((current) =>
      Object.freeze(
        Object.fromEntries(Object.entries(current).filter(([id]) => !requestIds.includes(id))),
      ),
    );
  }

  function startOperation(journeyId: string | null): JourneyOperation {
    const operation = Object.freeze({ token: operationSequence.current + 1, journeyId });
    operationSequence.current = operation.token;
    activeOperation.current = operation;
    return operation;
  }

  function bindOperation(operation: JourneyOperation, journeyId: string): JourneyOperation | null {
    if (!isCurrentOperation(operation)) {
      return null;
    }
    const bound = Object.freeze({ token: operation.token, journeyId });
    activeOperation.current = bound;
    return bound;
  }

  function isCurrentOperation(operation: JourneyOperation): boolean {
    const current = activeOperation.current;
    return (
      current !== null &&
      current.token === operation.token &&
      current.journeyId === operation.journeyId
    );
  }

  function finishOperation(operation: JourneyOperation): void {
    if (isCurrentOperation(operation)) {
      activeOperation.current = null;
    }
  }

  function assertCurrentOperation(operation: JourneyOperation): void {
    if (!isCurrentOperation(operation)) {
      throw new UiActionError(
        "IDEA_OPERATION_SUPERSEDED",
        "这次操作已经由更新的页面状态接管，旧操作不会继续写入。",
      );
    }
  }

  useEffect(
    () => () => {
      activeOperation.current = null;
      resumeLock.current = null;
      blankWorkspaceLock.current = null;
      listRequestSequence.current += 1;
    },
    [],
  );

  const loadActive = useCallback(async () => {
    const request = listRequestSequence.current + 1;
    listRequestSequence.current = request;
    try {
      const records = await runtime.creativeJourneys.listActive("idea");
      if (listRequestSequence.current !== request) {
        return;
      }
      const readable = records.filter((record) => {
        try {
          readIdeaSnapshot(record.snapshot, record.id);
          return true;
        } catch {
          return false;
        }
      });
      setActiveJourneys(readable);
      setUnreadableJourneyCount(records.length - readable.length);
      setListState(readable.length === 0 ? "empty" : "ready");
      setListError(null);
    } catch (cause: unknown) {
      if (listRequestSequence.current !== request) {
        return;
      }
      setListError(cause);
      setUnreadableJourneyCount(0);
      setListState("error");
    }
  }, [runtime]);

  useEffect(() => {
    void Promise.resolve().then(loadActive);
  }, [loadActive]);

  const refreshDestination = useCallback(async () => {
    try {
      setDestination(await inspectCreativeOpeningDestination(runtime));
    } catch {
      setDestination({ kind: "local" });
    }
  }, [runtime]);

  useEffect(() => {
    let active = true;
    void inspectCreativeOpeningDestination(runtime)
      .then((value) => {
        if (active) {
          setDestination(value);
        }
      })
      .catch(() => {
        if (active) {
          setDestination({ kind: "local" });
        }
      });
    return () => {
      active = false;
    };
  }, [runtime]);

  async function handleQuickAiContinue(choice: QuickAiContinueChoice): Promise<void> {
    if (choice === "self") {
      setOpeningPreference("self");
      return;
    }
    setOpeningPreference(choice === "sample" ? "sample" : "ai");
    if (choice === "ai") {
      await refreshDestination();
    }
  }

  function generateOpening(
    input: Parameters<typeof generateCreativeOpening>[1],
  ): Promise<CreativeOpeningResult> {
    if (openingPreference === "sample" || openingPreference === "local") {
      return Promise.resolve(
        generateLocalCreativeOpening(runtime, {
          idea: input.idea,
          ...(input.direction === undefined ? {} : { direction: input.direction }),
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        }),
      );
    }
    return generateCreativeOpening(runtime, input);
  }

  async function resolveOpeningGenerationMode(
    currentSnapshot: IdeaJourneySnapshotV1 | null = null,
  ): Promise<"provider" | "local"> {
    if (
      openingPreference === "sample" ||
      openingPreference === "local" ||
      openingPreference === "self" ||
      currentSnapshot?.openingMode === "sample" ||
      currentSnapshot?.openingMode === "self"
    ) {
      return "local";
    }
    if (currentSnapshot?.openingGenerationMode === "provider") {
      return "provider";
    }
    const inspected =
      destination ??
      (await inspectCreativeOpeningDestination(runtime).catch(() => ({ kind: "local" as const })));
    setDestination(inspected);
    return inspected.kind === "provider" ? "provider" : "local";
  }

  function createProviderOpeningBatchPlan(): ProviderOpeningBatchPlan {
    return Object.freeze({
      batchId: runtime.ids.next(),
      requests: Object.freeze(
        PROVIDER_OPENING_ANGLES.map((openingAngle) =>
          Object.freeze({ requestId: runtime.ids.next(), openingAngle }),
        ),
      ),
    });
  }

  async function reconcileOpeningResult(
    journeyId: string,
    generated: CreativeOpeningResult,
    input: Readonly<{
      batchId: string;
      openingAngle: CreativeOpeningAngle | null;
      questionKey: string;
      generationMode: "provider" | "local";
      batchPlan: ProviderOpeningBatchPlan | null;
    }>,
  ): Promise<CreativeJourneyRecord> {
    let lastConflict: Error | null = null;
    const suggestion = openingSuggestionFromResult(
      generated,
      input.batchId,
      input.generationMode,
      input.openingAngle,
    );
    for (let attempt = 0; attempt < OPENING_RESULT_RECONCILE_ATTEMPTS; attempt += 1) {
      const [latest, turns] = await Promise.all([
        runtime.creativeJourneys.findById(journeyId),
        runtime.creativeJourneys.listTurns(journeyId),
      ]);
      if (latest === null) {
        throw new UiActionError(
          "IDEA_JOURNEY_NOT_FOUND",
          "这次构思已经不在当前设备上，AI 返回结果无法安全归档。",
        );
      }
      const latestSnapshot = readIdeaSnapshot(latest.snapshot, latest.id);
      const currentSuggestion = latestSnapshot.openingSuggestions.find(
        ({ id, batchId }) => id === generated.requestId && batchId === input.batchId,
      );
      if (currentSuggestion !== undefined && currentSuggestion.status !== "pending") {
        if (sameOpeningSuggestion(currentSuggestion, suggestion)) {
          return latest;
        }
        throw new UiActionError(
          "IDEA_OPENING_REQUEST_RESULT_MISMATCH",
          "同一个 AI 请求返回了不同内容，墨影已停止覆盖并保留先保存的结果。",
        );
      }

      const activeBatchRequest =
        input.batchPlan !== null && currentSuggestion?.status === "pending";
      const activeSingleRequest =
        input.batchPlan === null && latestSnapshot.pendingRequestId === generated.requestId;
      let nextSnapshot: IdeaJourneySnapshotV1;
      let nextState = latest.currentState;
      let resultStatus: "ready" | "partial" | "failed";
      let historicalResult = false;

      if (activeBatchRequest && input.openingAngle !== null) {
        nextSnapshot = applyProviderOpeningResult(
          latestSnapshot,
          input.batchPlan,
          input.openingAngle,
          generated,
        );
        nextState =
          countPendingSuggestions(nextSnapshot, input.batchId) === 0
            ? guidanceStateForSnapshot(nextSnapshot)
            : "generation_pending";
        resultStatus = settledOpeningStatus(suggestion);
      } else if (activeSingleRequest) {
        nextSnapshot = applySingleOpeningResult(latestSnapshot, generated, input.generationMode);
        nextState = guidanceStateForSnapshot(nextSnapshot);
        resultStatus = settledOpeningStatus(suggestion);
      } else {
        historicalResult = true;
        const historicalIndex = latestSnapshot.openingResultHistory.findIndex(
          ({ id }) => id === generated.requestId,
        );
        const existingHistorical = latestSnapshot.openingResultHistory[historicalIndex];
        if (
          existingHistorical !== undefined &&
          sameOpeningSuggestion(existingHistorical, suggestion)
        ) {
          return latest;
        }
        const replacesAbandonment =
          existingHistorical?.status === "failed" &&
          existingHistorical.noticeCode === GENERATION_ABANDONED_BY_AUTHOR &&
          isUsableOpeningSuggestion(suggestion);
        if (existingHistorical !== undefined && !replacesAbandonment) {
          if (
            existingHistorical.noticeCode === GENERATION_ABANDONED_BY_AUTHOR &&
            suggestion.status === "failed"
          ) {
            return latest;
          }
          throw new UiActionError(
            "IDEA_OPENING_REQUEST_RESULT_MISMATCH",
            "同一个 AI 请求已经有一份不同的历史结果，墨影没有覆盖它。",
          );
        }
        const history = [...latestSnapshot.openingResultHistory];
        if (historicalIndex < 0) {
          history.push(suggestion);
        } else {
          history[historicalIndex] = suggestion;
        }
        nextSnapshot = Object.freeze({
          ...latestSnapshot,
          openingResultHistory: Object.freeze(history),
        });
        resultStatus = settledOpeningStatus(suggestion);
      }

      const updated = Object.freeze({
        ...latest,
        currentState: nextState,
        revision: latest.revision + 1,
        snapshot: nextSnapshot,
        updatedAt: runtime.clock.now(),
      });
      try {
        await runtime.creativeJourneys.update(
          updated,
          latest.revision,
          createTurn(runtime, updated, turns.length + 1, "regenerate", input.questionKey, {
            generationSource: generated.source,
            providerId: generated.providerId,
            modelId: generated.modelId,
            requestId: generated.requestId,
            snapshot: {
              batchId: input.batchId,
              openingAngle: input.openingAngle,
              status: resultStatus,
              historicalResult,
            },
          }),
        );
        return updated;
      } catch (cause: unknown) {
        if (!isCreativeJourneyRevisionConflict(cause)) {
          throw cause;
        }
        lastConflict = cause;
      }
    }
    throw (
      lastConflict ??
      new UiActionError(
        "IDEA_OPENING_RESULT_RECONCILE_FAILED",
        "AI 结果返回时构思仍在频繁变化，暂时无法安全归档，请重新读取进度。",
      )
    );
  }

  async function runProviderOpeningBatch(
    operation: JourneyOperation,
    current: CreativeJourneyRecord,
    plan: ProviderOpeningBatchPlan,
    input: Readonly<{
      idea: string;
      direction?: string;
      answers?: Readonly<Record<string, string>>;
    }>,
    questionKey = "opening_direction",
  ): Promise<CreativeJourneyRecord> {
    setBatchProgress({ completed: 0, total: plan.requests.length });
    startRequestTimings(plan.requests.map(({ requestId }) => requestId));
    const settled = await Promise.allSettled(
      plan.requests.map(async (request) => {
        try {
          const generated = await generateCreativeOpening(runtime, {
            ...input,
            requestId: request.requestId,
            openingAngle: request.openingAngle,
            onDelta: (text) => {
              if (isCurrentOperation(operation)) {
                updateStreamingPreview(request.requestId, text);
              }
            },
          });
          const saved = await reconcileOpeningResult(current.id, generated, {
            batchId: plan.batchId,
            openingAngle: request.openingAngle,
            questionKey,
            generationMode: "provider",
            batchPlan: plan,
          });
          if (isCurrentOperation(operation)) {
            setJourney((active) =>
              active?.id !== saved.id || active.revision < saved.revision ? saved : active,
            );
          }
          return saved;
        } finally {
          finishRequestTiming(request.requestId);
          clearStreamingPreviews([request.requestId]);
          if (isCurrentOperation(operation)) {
            setBatchProgress((progress) =>
              progress === null
                ? null
                : Object.freeze({
                    completed: Math.min(progress.total, progress.completed + 1),
                    total: progress.total,
                  }),
            );
          }
        }
      }),
    );
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected !== undefined) {
      throw rejected.reason;
    }
    const latest = await runtime.creativeJourneys.findById(current.id);
    if (latest === null) {
      throw new UiActionError(
        "IDEA_JOURNEY_NOT_FOUND",
        "这次构思已经不在当前设备上，AI 返回结果无法安全归档。",
      );
    }
    return latest;
  }

  const snapshot = useMemo(
    () => (journey === null ? null : readIdeaSnapshot(journey.snapshot, journey.id)),
    [journey],
  );
  const currentQuestion =
    snapshot === null
      ? null
      : (QUESTION_BY_KEY.get(snapshot.currentQuestionKey) ?? DEFAULT_QUESTION);

  async function begin(): Promise<void> {
    const normalizedIdea = idea.normalize("NFC").trim();
    if ((openingPreference !== "self" && normalizedIdea.length < 2) || busy !== null) {
      return;
    }
    if (openingPreference === "self") {
      await createBlankAuthorWorkspace(normalizedIdea);
      return;
    }
    const operation = startOperation(null);
    setBusy("create");
    setError(null);
    const generationMode = await resolveOpeningGenerationMode();
    if (!isCurrentOperation(operation)) {
      return;
    }
    const providerBatchPlan =
      generationMode === "provider" ? createProviderOpeningBatchPlan() : null;
    const now = runtime.clock.now();
    const id = runtime.ids.next();
    const boundOperation = bindOperation(operation, id);
    if (boundOperation === null) {
      return;
    }
    const requestId = providerBatchPlan?.requests[0]?.requestId ?? runtime.ids.next();
    const initialSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
      version: 1,
      openingMode: openingPreference === "sample" ? "sample" : "guided",
      idea: normalizedIdea,
      preview: "",
      previewSource: null,
      providerId: null,
      modelId: null,
      noticeCode: null,
      pendingRequestId: requestId,
      openingGenerationMode: generationMode,
      openingSuggestions:
        providerBatchPlan === null
          ? Object.freeze([])
          : pendingOpeningSuggestions(providerBatchPlan),
      openingResultHistory: Object.freeze([]),
      selectedOpeningId: null,
      openingBatchId: providerBatchPlan?.batchId ?? requestId,
      openingBatchFailureCount: 0,
      provisioningPlan: createJourneyProvisioningPlan(runtime),
      answers: Object.freeze({}),
      skippedQuestionKeys: Object.freeze([]),
      questionHistory: Object.freeze([]),
      questionPlan: DEFAULT_GUIDANCE_QUESTION_PLAN,
      expectedQuestionTotal: DEFAULT_GUIDANCE_QUESTION_PLAN.length,
      questionIndex: 0,
      remainingQuestionFocus: ALL_GUIDANCE_FOCUS_KEYS,
      questionPlanExpansionNotice: null,
      currentQuestionKey: DEFAULT_GUIDANCE_QUESTION_PLAN[0] ?? "opening_direction",
      projectName: deriveProjectName(normalizedIdea),
      storySummary: normalizedIdea,
      summaryCustomized: false,
      guidanceRewriteUsed: false,
      projectSeed: deriveIdeaProjectSeed({
        seedId: `idea:${id}`,
        idea: normalizedIdea,
        answers: {},
        skippedQuestionKeys: [],
        now,
      }),
    });
    const record: CreativeJourneyRecord = Object.freeze({
      id,
      kind: "idea",
      status: "active",
      currentState: "generating_opening",
      projectId: null,
      chapterId: null,
      candidateId: null,
      revision: 1,
      snapshot: initialSnapshot,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const initialTurn = createTurn(runtime, record, 1, "idea", null, {
      userText: normalizedIdea,
      requestId,
      taskKey: "opening_guidance",
      ...(providerBatchPlan === null
        ? {}
        : {
            snapshot: {
              userText: normalizedIdea,
              batchId: providerBatchPlan.batchId,
              requests: providerBatchPlan.requests.map((request) => ({
                ...request,
                status: "pending",
              })),
            },
          }),
    });
    try {
      await runtime.creativeJourneys.create(record, initialTurn);
      if (isCurrentOperation(boundOperation)) {
        setJourney(record);
        setTurnCount(1);
      }
      if (providerBatchPlan === null) {
        startRequestTimings([requestId]);
      }
      const updated =
        providerBatchPlan === null
          ? await persistGeneratedPreview(
              record,
              initialSnapshot,
              await generateOpening({
                idea: normalizedIdea,
                requestId,
                onDelta: (text) => {
                  if (isCurrentOperation(boundOperation)) {
                    updateStreamingPreview(requestId, text);
                  }
                },
              }),
              2,
              "opening_direction",
              generationMode,
            )
          : await runProviderOpeningBatch(boundOperation, record, providerBatchPlan, {
              idea: normalizedIdea,
            });
      if (isCurrentOperation(boundOperation)) {
        setJourney(updated);
        setTurnCount(providerBatchPlan === null ? 2 : 1 + providerBatchPlan.requests.length);
        clearStreamingPreviews();
        setBatchProgress(null);
        setIdea("");
        await loadActive();
      }
      if (providerBatchPlan === null) {
        finishRequestTiming(requestId);
      }
    } catch (cause: unknown) {
      if (isCurrentOperation(boundOperation)) {
        setError(cause);
      }
    } finally {
      if (providerBatchPlan === null) {
        finishRequestTiming(requestId);
        clearStreamingPreviews([requestId]);
      }
      if (isCurrentOperation(boundOperation)) {
        setBatchProgress(null);
        setBusy(null);
      }
      finishOperation(boundOperation);
    }
  }

  function prepareBlankWorkspaceAttempt(normalizedIdea: string): BlankWorkspaceAttempt {
    const now = runtime.clock.now();
    const id = runtime.ids.next();
    const selfSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
      version: 1,
      openingMode: "self",
      idea: normalizedIdea,
      preview: "",
      previewSource: null,
      providerId: null,
      modelId: null,
      noticeCode: null,
      pendingRequestId: null,
      openingGenerationMode: "local",
      openingSuggestions: Object.freeze([]),
      openingResultHistory: Object.freeze([]),
      selectedOpeningId: null,
      openingBatchId: null,
      openingBatchFailureCount: 0,
      provisioningPlan: createJourneyProvisioningPlan(runtime),
      answers: Object.freeze({}),
      skippedQuestionKeys: Object.freeze([]),
      questionHistory: Object.freeze([]),
      questionPlan: DEFAULT_GUIDANCE_QUESTION_PLAN,
      expectedQuestionTotal: DEFAULT_GUIDANCE_QUESTION_PLAN.length,
      questionIndex: 0,
      remainingQuestionFocus: ALL_GUIDANCE_FOCUS_KEYS,
      questionPlanExpansionNotice: null,
      currentQuestionKey: DEFAULT_GUIDANCE_QUESTION_PLAN[0] ?? "opening_direction",
      projectName: deriveProjectName(normalizedIdea),
      storySummary: normalizedIdea,
      summaryCustomized: false,
      guidanceRewriteUsed: false,
      projectSeed: deriveIdeaProjectSeed({
        seedId: `idea-self:${id}`,
        idea: normalizedIdea,
        answers: {},
        skippedQuestionKeys: [],
        now,
      }),
    });
    const record: CreativeJourneyRecord = Object.freeze({
      id,
      kind: "idea",
      status: "active",
      currentState: "creating_project",
      projectId: null,
      chapterId: null,
      candidateId: null,
      revision: 1,
      snapshot: selfSnapshot,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    return Object.freeze({
      record,
      snapshot: selfSnapshot,
      initialTurn: createTurn(runtime, record, 1, "idea", null, {
        userText: normalizedIdea,
        snapshot: { openingMode: "self" },
      }),
    });
  }

  async function restoreBlankWorkspaceAttempt(
    attempt: BlankWorkspaceAttempt,
    operation: JourneyOperation,
  ): Promise<
    Readonly<{
      record: CreativeJourneyRecord;
      snapshot: IdeaJourneySnapshotV1;
      turnCount: number;
    }>
  > {
    assertCurrentOperation(operation);
    const existing = await runtime.creativeJourneys.findById(attempt.record.id);
    assertCurrentOperation(operation);
    if (existing === null) {
      await runtime.creativeJourneys.create(attempt.record, attempt.initialTurn);
      assertCurrentOperation(operation);
      return Object.freeze({ record: attempt.record, snapshot: attempt.snapshot, turnCount: 1 });
    }

    const savedSnapshot = readIdeaSnapshot(existing.snapshot, existing.id);
    const expectedPlan = attempt.snapshot.provisioningPlan;
    const savedPlan = savedSnapshot.provisioningPlan;
    if (
      existing.createdAt !== attempt.record.createdAt ||
      savedSnapshot.openingMode !== "self" ||
      savedSnapshot.idea !== attempt.snapshot.idea ||
      expectedPlan === null ||
      savedPlan === null ||
      !sameProvisioningIdentity(expectedPlan, savedPlan)
    ) {
      throw new UiActionError(
        "IDEA_PROVISIONING_SCOPE_MISMATCH",
        "已保存的空白作品计划与本次重试不一致，系统已停止继续写入以避免产生重复作品。",
      );
    }
    const turns = await runtime.creativeJourneys.listTurns(existing.id);
    assertCurrentOperation(operation);
    if (turns.length === 0) {
      throw new UiActionError(
        "IDEA_JOURNEY_TURN_MISSING",
        "空白作品的创建记录不完整，系统已停止继续写入；现有项目和正文没有被覆盖。",
      );
    }
    return Object.freeze({ record: existing, snapshot: savedSnapshot, turnCount: turns.length });
  }

  async function createBlankAuthorWorkspace(normalizedIdea: string): Promise<void> {
    if (busy !== null || blankWorkspaceLock.current !== null) {
      return;
    }
    const operation = startOperation(null);
    blankWorkspaceLock.current = operation;
    setBusy("create");
    setError(null);
    let boundOperation: JourneyOperation | null = null;
    try {
      const attempt = blankWorkspaceAttempt ?? prepareBlankWorkspaceAttempt(normalizedIdea);
      setBlankWorkspaceAttempt(attempt);
      boundOperation = bindOperation(operation, attempt.record.id);
      if (boundOperation === null) {
        return;
      }
      const restored = await restoreBlankWorkspaceAttempt(attempt, boundOperation);
      if (isCurrentOperation(boundOperation)) {
        setJourney(restored.record);
        setTurnCount(restored.turnCount);
      }
      if (
        restored.record.status === "completed" &&
        restored.record.currentState === "author_workspace_ready"
      ) {
        const plan = restored.snapshot.provisioningPlan;
        if (plan === null) {
          throw new UiActionError(
            "IDEA_PROVISIONING_SCOPE_MISMATCH",
            "已完成的空白作品与原创建计划不一致，系统已停止打开以保护正文。",
          );
        }
        if (
          restored.record.projectId !== plan.projectId ||
          restored.record.chapterId !== plan.chapterId
        ) {
          throw new UiActionError(
            "IDEA_PROVISIONING_SCOPE_MISMATCH",
            "已完成的空白作品与原创建计划不一致，系统已停止打开以保护正文。",
          );
        }
        if (isCurrentOperation(boundOperation)) {
          setBlankWorkspaceAttempt(null);
          setIdea("");
          void navigate(`/projects/${plan.projectId}/chapters/${plan.chapterId}`);
        }
        return;
      }
      if (restored.record.status !== "active") {
        throw new UiActionError(
          "IDEA_PROVISIONING_SCOPE_MISMATCH",
          "这次空白作品创建已经结束，系统不会把新的内容写入旧流程。",
        );
      }
      await continueBlankAuthorWorkspace(
        restored.record,
        restored.snapshot,
        restored.turnCount,
        boundOperation,
      );
    } catch (cause: unknown) {
      const currentOperation = boundOperation ?? operation;
      if (isCurrentOperation(currentOperation)) {
        setJourney(null);
        await loadActive();
        if (isCurrentOperation(currentOperation)) {
          setError(cause);
        }
      }
    } finally {
      if (sameOperationToken(blankWorkspaceLock.current, operation)) {
        blankWorkspaceLock.current = null;
      }
      const currentOperation = boundOperation ?? operation;
      if (isCurrentOperation(currentOperation)) {
        setBusy(null);
      }
      finishOperation(currentOperation);
    }
  }

  async function continueBlankAuthorWorkspace(
    savedRecord: CreativeJourneyRecord,
    savedSnapshot: IdeaJourneySnapshotV1,
    savedTurnCount: number,
    operation: JourneyOperation,
  ): Promise<void> {
    assertCurrentOperation(operation);
    const { current, projectId, chapterId } = await provisionJourneyWorkspace(
      savedRecord,
      savedSnapshot,
      operation,
    );
    assertCurrentOperation(operation);
    const completedAt = runtime.clock.now();
    const completed = Object.freeze({
      ...current,
      status: "completed" as const,
      currentState: "author_workspace_ready",
      revision: current.revision + 1,
      updatedAt: completedAt,
      completedAt,
    });
    await runtime.creativeJourneys.update(
      completed,
      current.revision,
      createTurn(runtime, completed, savedTurnCount + 1, "keep", null, {
        snapshot: { openingMode: "self", chapterId: current.chapterId },
      }),
    );
    if (isCurrentOperation(operation)) {
      setBlankWorkspaceAttempt(null);
      setIdea("");
      void navigate(`/projects/${String(projectId.value)}/chapters/${String(chapterId.value)}`);
    }
  }

  async function resume(record: CreativeJourneyRecord): Promise<void> {
    if (busy !== null || resumeLock.current !== null) {
      return;
    }
    const operation = startOperation(record.id);
    resumeLock.current = operation;
    setBusy("create");
    try {
      const latest = await runtime.creativeJourneys.findById(record.id);
      if (!isCurrentOperation(operation)) {
        return;
      }
      if (latest === null) {
        throw new UiActionError(
          "IDEA_JOURNEY_NOT_FOUND",
          "这次构思已经不在当前设备上，请返回创作首页重新开始。",
        );
      }
      const turns = await runtime.creativeJourneys.listTurns(latest.id);
      if (!isCurrentOperation(operation)) {
        return;
      }
      const loaded = readIdeaSnapshot(latest.snapshot, latest.id);
      if (loaded.openingMode === "self") {
        assertCurrentOperation(operation);
        setOpeningPreference("self");
        setJourney(latest);
        setTurnCount(turns.length);
        await continueBlankAuthorWorkspace(latest, loaded, turns.length, operation);
        return;
      }
      if (isCurrentOperation(operation)) {
        setJourney(latest);
        setTurnCount(turns.length);
        setCustomAnswer(loaded.answers[loaded.currentQuestionKey] ?? "");
        setProjectNameDraft(loaded.projectName);
        setStorySummaryDraft(loaded.storySummary);
        setError(null);
      }
    } catch (cause: unknown) {
      if (isCurrentOperation(operation)) {
        setJourney(null);
        await loadActive();
        if (isCurrentOperation(operation)) {
          setError(cause);
        }
      }
    } finally {
      if (sameOperationToken(resumeLock.current, operation)) {
        resumeLock.current = null;
      }
      if (isCurrentOperation(operation)) {
        setBusy(null);
      }
      finishOperation(operation);
    }
  }

  async function persistGeneratedPreview(
    current: CreativeJourneyRecord,
    currentSnapshot: IdeaJourneySnapshotV1,
    generated: CreativeOpeningResult,
    sequence: number,
    questionKey = "opening_direction",
    generationMode: "provider" | "local" = currentSnapshot.openingGenerationMode,
    nextState = guidanceStateForSnapshot(currentSnapshot),
  ): Promise<CreativeJourneyRecord> {
    const nextSnapshot = applySingleOpeningResult(currentSnapshot, generated, generationMode);
    const now = runtime.clock.now();
    const updated = Object.freeze({
      ...current,
      currentState: nextState,
      revision: current.revision + 1,
      snapshot: nextSnapshot,
      updatedAt: now,
    });
    try {
      await runtime.creativeJourneys.update(
        updated,
        current.revision,
        createTurn(runtime, updated, sequence, "regenerate", questionKey, {
          generationSource: generated.source,
          providerId: generated.providerId,
          modelId: generated.modelId,
          requestId: generated.requestId,
          snapshot: {
            direction: currentSnapshot.answers[questionKey] ?? null,
            status: openingSuggestionFromResult(
              generated,
              generated.requestId,
              generationMode,
              null,
            ).status,
          },
        }),
      );
      return updated;
    } catch (cause: unknown) {
      if (!isCreativeJourneyRevisionConflict(cause)) {
        throw cause;
      }
      return reconcileOpeningResult(current.id, generated, {
        batchId: generated.requestId,
        openingAngle: null,
        questionKey,
        generationMode,
        batchPlan: null,
      });
    }
  }

  async function endPendingGeneration(): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      (busy !== null && busy !== "create" && busy !== "regenerate") ||
      !hasPersistedGenerationPending(snapshot)
    ) {
      return;
    }
    const operation = startOperation(journey.id);
    setBusy("regenerate");
    setError(null);
    let lastConflict: Error | null = null;
    try {
      for (let attempt = 0; attempt < OPENING_RESULT_RECONCILE_ATTEMPTS; attempt += 1) {
        assertCurrentOperation(operation);
        const [latest, turns] = await Promise.all([
          runtime.creativeJourneys.findById(journey.id),
          runtime.creativeJourneys.listTurns(journey.id),
        ]);
        assertCurrentOperation(operation);
        if (latest === null) {
          throw new UiActionError(
            "IDEA_JOURNEY_NOT_FOUND",
            "这次构思已经不在当前设备上，请返回创作首页重新开始。",
          );
        }
        const latestSnapshot = readIdeaSnapshot(latest.snapshot, latest.id);
        const abandonment = abandonPersistedOpeningGeneration(latestSnapshot);
        if (abandonment === null) {
          setJourney(latest);
          setTurnCount(turns.length);
          return;
        }
        const updated = Object.freeze({
          ...latest,
          currentState: guidanceStateForSnapshot(abandonment.snapshot),
          revision: latest.revision + 1,
          snapshot: abandonment.snapshot,
          updatedAt: runtime.clock.now(),
        });
        try {
          await runtime.creativeJourneys.update(
            updated,
            latest.revision,
            createTurn(runtime, updated, turns.length + 1, "regenerate", null, {
              requestId: abandonment.requestIds[0] ?? null,
              taskKey: "opening_guidance",
              snapshot: {
                status: "abandoned",
                requestIds: abandonment.requestIds,
                batchId: abandonment.batchId,
              },
            }),
          );
          if (isCurrentOperation(operation)) {
            setJourney(updated);
            setTurnCount(turns.length + 1);
            clearStreamingPreviews(abandonment.requestIds);
            setBatchProgress(null);
            await Promise.allSettled(
              abandonment.requestIds.map((requestId) =>
                runtime.modelGateway.cancelGeneration(requestId),
              ),
            );
            for (const requestId of abandonment.requestIds) {
              finishRequestTiming(requestId);
            }
            await loadActive();
          }
          return;
        } catch (cause: unknown) {
          if (!isCreativeJourneyRevisionConflict(cause)) {
            throw cause;
          }
          lastConflict = cause;
        }
      }
      throw (
        lastConflict ??
        new UiActionError(
          "IDEA_PENDING_GENERATION_ABANDON_FAILED",
          "未完成请求暂时无法结束，请重新读取进度后再试。",
        )
      );
    } catch (cause: unknown) {
      if (isCurrentOperation(operation)) {
        setError(cause);
        const latest = await runtime.creativeJourneys.findById(journey.id).catch(() => null);
        if (latest !== null && isCurrentOperation(operation)) {
          setJourney(latest);
          const turns = await runtime.creativeJourneys.listTurns(latest.id).catch(() => []);
          if (isCurrentOperation(operation)) {
            setTurnCount(turns.length);
          }
        }
      }
    } finally {
      if (isCurrentOperation(operation)) {
        setBusy(null);
      }
      finishOperation(operation);
    }
  }

  async function answerCurrent(value: string, skip = false): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      currentQuestion === null ||
      busy !== null ||
      hasPersistedGenerationPending(snapshot)
    ) {
      return;
    }
    const normalized = value.normalize("NFC").trim();
    if (!skip && normalized.length === 0) {
      return;
    }
    const operation = startOperation(journey.id);
    setBusy("answer");
    setError(null);
    try {
      const answerDraft: Record<string, string> = { ...snapshot.answers };
      if (skip) {
        Reflect.deleteProperty(answerDraft, currentQuestion.key);
      } else {
        answerDraft[currentQuestion.key] = normalized;
      }
      const answers = Object.freeze(answerDraft);
      const skippedQuestionKeys = skip
        ? Object.freeze([...new Set([...snapshot.skippedQuestionKeys, currentQuestion.key])])
        : Object.freeze(snapshot.skippedQuestionKeys.filter((key) => key !== currentQuestion.key));
      const questionHistory = Object.freeze([
        ...snapshot.questionHistory.filter((key) => key !== currentQuestion.key),
        currentQuestion.key,
      ]);
      const provedProgress = snapshot.remainingQuestionFocus.includes(currentQuestion.key);
      let remainingQuestionFocus = Object.freeze(
        snapshot.remainingQuestionFocus.filter((key) => key !== currentQuestion.key),
      );
      const extension =
        !skip && provedProgress
          ? suggestGuidancePlanExtension(snapshot, currentQuestion.key, normalized)
          : null;
      const questionPlan =
        extension === null
          ? snapshot.questionPlan
          : Object.freeze([...snapshot.questionPlan, extension.key]);
      const nextQuestionIndex = provedProgress
        ? Math.min(questionPlan.length, snapshot.questionIndex + 1)
        : questionPlan.length;
      if (!provedProgress || (nextQuestionIndex >= questionPlan.length && extension === null)) {
        remainingQuestionFocus = Object.freeze([]);
      }
      const nextQuestionKey =
        questionPlan[Math.min(nextQuestionIndex, questionPlan.length - 1)] ?? currentQuestion.key;
      const now = runtime.clock.now();
      const nextSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
        ...snapshot,
        answers,
        skippedQuestionKeys,
        questionHistory,
        questionPlan,
        expectedQuestionTotal: questionPlan.length,
        questionIndex: nextQuestionIndex,
        remainingQuestionFocus,
        questionPlanExpansionNotice:
          extension === null
            ? snapshot.questionPlanExpansionNotice
            : `因为你的回答涉及“${extension.focusLabel}”，问题计划从 ${String(snapshot.expectedQuestionTotal)} 问增加为 ${String(questionPlan.length)} 问。${extension.reason}`,
        currentQuestionKey: nextQuestionKey,
        pendingRequestId: null,
        projectSeed: deriveIdeaProjectSeed({
          seedId: snapshot.projectSeed.seedId,
          idea: snapshot.storySummary,
          answers,
          skippedQuestionKeys,
          now,
          existing: snapshot.projectSeed,
        }),
      });
      const pending = Object.freeze({
        ...journey,
        currentState: guidanceStateForSnapshot(nextSnapshot),
        revision: journey.revision + 1,
        snapshot: nextSnapshot,
        updatedAt: now,
      });
      await runtime.creativeJourneys.update(
        pending,
        journey.revision,
        createTurn(runtime, pending, turnCount + 1, skip ? "skip" : "answer", currentQuestion.key, {
          requestId: null,
          taskKey: null,
          snapshot: skip ? { skipped: true } : { userText: normalized },
        }),
      );
      if (isCurrentOperation(operation)) {
        setJourney(pending);
        setTurnCount(turnCount + 1);
        setCustomAnswer(answers[nextQuestionKey] ?? "");
      }
      if (isCurrentOperation(operation)) {
        await loadActive();
      }
    } catch (cause: unknown) {
      if (isCurrentOperation(operation)) {
        setError(cause);
        const latest = await runtime.creativeJourneys.findById(journey.id).catch(() => null);
        if (latest !== null && isCurrentOperation(operation)) {
          setJourney(latest);
          const turns = await runtime.creativeJourneys.listTurns(latest.id).catch(() => []);
          if (isCurrentOperation(operation)) {
            setTurnCount(turns.length);
          }
        }
      }
    } finally {
      if (isCurrentOperation(operation)) {
        setBusy(null);
      }
      finishOperation(operation);
    }
  }

  async function regenerate(): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      busy !== null ||
      hasPersistedGenerationPending(snapshot)
    ) {
      return;
    }
    const consumesGuidanceRewrite = journey.currentState === "guidance_complete";
    if (consumesGuidanceRewrite && snapshot.guidanceRewriteUsed) {
      return;
    }
    const operation = startOperation(journey.id);
    setBusy("regenerate");
    setError(null);
    let individuallyTrackedRequestId: string | null = null;
    try {
      const direction = snapshot.answers.opening_direction;
      const generationMode = await resolveOpeningGenerationMode(snapshot);
      const providerBatchPlan =
        generationMode === "provider" ? createProviderOpeningBatchPlan() : null;
      const requestId = providerBatchPlan?.requests[0]?.requestId ?? runtime.ids.next();
      const plannedSnapshot: IdeaJourneySnapshotV1 =
        providerBatchPlan === null
          ? Object.freeze({
              ...snapshot,
              pendingRequestId: requestId,
              openingGenerationMode: generationMode,
              openingBatchId: requestId,
            })
          : planProviderOpeningBatch(snapshot, providerBatchPlan);
      const pendingSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
        ...plannedSnapshot,
        guidanceRewriteUsed: snapshot.guidanceRewriteUsed || consumesGuidanceRewrite,
      });
      const pending = Object.freeze({
        ...journey,
        currentState: "generation_pending",
        revision: journey.revision + 1,
        snapshot: pendingSnapshot,
        updatedAt: runtime.clock.now(),
      });
      await runtime.creativeJourneys.update(
        pending,
        journey.revision,
        createTurn(runtime, pending, turnCount + 1, "regenerate", "opening_direction", {
          requestId,
          taskKey: "opening_guidance",
          snapshot:
            providerBatchPlan === null
              ? { started: true }
              : {
                  started: true,
                  batchId: providerBatchPlan.batchId,
                  requests: providerBatchPlan.requests.map((request) => ({
                    ...request,
                    status: "pending",
                  })),
                },
        }),
      );
      if (isCurrentOperation(operation)) {
        setJourney(pending);
        setTurnCount(turnCount + 1);
      }
      if (providerBatchPlan === null) {
        individuallyTrackedRequestId = requestId;
        startRequestTimings([requestId]);
      }
      const updated =
        providerBatchPlan === null
          ? await persistGeneratedPreview(
              pending,
              pendingSnapshot,
              await generateOpening({
                idea: snapshot.idea,
                ...(direction === undefined ? {} : { direction }),
                answers: snapshot.answers,
                requestId,
                onDelta: (text) => {
                  if (isCurrentOperation(operation)) {
                    updateStreamingPreview(requestId, text);
                  }
                },
              }),
              turnCount + 2,
              "opening_direction",
              generationMode,
            )
          : await runProviderOpeningBatch(operation, pending, providerBatchPlan, {
              idea: snapshot.idea,
              ...(direction === undefined ? {} : { direction }),
              answers: snapshot.answers,
            });
      if (isCurrentOperation(operation)) {
        setJourney(updated);
        setTurnCount(
          providerBatchPlan === null
            ? turnCount + 2
            : turnCount + 1 + providerBatchPlan.requests.length,
        );
        clearStreamingPreviews();
        setBatchProgress(null);
        await loadActive();
      }
    } catch (cause: unknown) {
      if (isCurrentOperation(operation)) {
        setError(cause);
        const latest = await runtime.creativeJourneys.findById(journey.id).catch(() => null);
        if (latest !== null && isCurrentOperation(operation)) {
          setJourney(latest);
          const turns = await runtime.creativeJourneys.listTurns(latest.id).catch(() => []);
          if (isCurrentOperation(operation)) {
            setTurnCount(turns.length);
          }
        }
      }
    } finally {
      if (individuallyTrackedRequestId !== null) {
        finishRequestTiming(individuallyTrackedRequestId);
        clearStreamingPreviews([individuallyTrackedRequestId]);
      }
      if (isCurrentOperation(operation)) {
        setBatchProgress(null);
        setBusy(null);
      }
      finishOperation(operation);
    }
  }

  async function retryOpeningSuggestion(
    suggestionId: string,
    mode: "continue" | "regenerate",
  ): Promise<void> {
    if (
      journey === null ||
      snapshot?.openingGenerationMode !== "provider" ||
      busy !== null ||
      hasPersistedGenerationPending(snapshot)
    ) {
      return;
    }
    const targetIndex = snapshot.openingSuggestions.findIndex(({ id }) => id === suggestionId);
    const target = snapshot.openingSuggestions[targetIndex];
    if (
      target === undefined ||
      (mode === "continue" ? target.status !== "partial" : target.status === "pending") ||
      target.openingAngle === null
    ) {
      return;
    }
    const operation = startOperation(journey.id);
    setBusy("regenerate");
    setError(null);
    const requestId = runtime.ids.next();
    const plan: ProviderOpeningBatchPlan = Object.freeze({
      batchId: runtime.ids.next(),
      requests: Object.freeze([
        Object.freeze({
          requestId,
          openingAngle: target.openingAngle,
          replacesOpeningId: target.id,
        }),
      ]),
    });
    try {
      const suggestions = [...snapshot.openingSuggestions];
      const [pendingSuggestion] = pendingOpeningSuggestions(plan);
      if (pendingSuggestion === undefined) {
        throw new UiActionError(
          "IDEA_OPENING_REQUEST_NOT_PLANNED",
          "这个开头方案没有生成安全的重试计划，当前内容未改变。",
        );
      }
      suggestions[targetIndex] = pendingSuggestion;
      const pendingSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
        ...snapshot,
        pendingRequestId: requestId,
        openingSuggestions: Object.freeze(suggestions),
        openingResultHistory: mergeOpeningHistory(snapshot.openingResultHistory, [target]),
        openingBatchId: plan.batchId,
      });
      const pending = Object.freeze({
        ...journey,
        currentState: "generation_pending",
        revision: journey.revision + 1,
        snapshot: pendingSnapshot,
        updatedAt: runtime.clock.now(),
      });
      await runtime.creativeJourneys.update(
        pending,
        journey.revision,
        createTurn(runtime, pending, turnCount + 1, "regenerate", "opening_choice", {
          requestId,
          taskKey: "opening_guidance",
          snapshot: {
            started: true,
            retryMode: mode,
            replacesOpeningId: target.id,
            batchId: plan.batchId,
            openingAngle: target.openingAngle,
          },
        }),
      );
      if (isCurrentOperation(operation)) {
        setJourney(pending);
        setTurnCount(turnCount + 1);
      }
      startRequestTimings([requestId]);
      const generated = await generateCreativeOpening(runtime, {
        idea: snapshot.idea,
        ...(snapshot.answers.opening_direction === undefined
          ? {}
          : { direction: snapshot.answers.opening_direction }),
        answers: snapshot.answers,
        openingAngle: target.openingAngle,
        ...(mode === "continue" ? { partialOpening: target.text } : {}),
        requestId,
        onDelta: (text) => {
          if (isCurrentOperation(operation)) {
            updateStreamingPreview(requestId, text);
          }
        },
      });
      const updated = await reconcileOpeningResult(journey.id, generated, {
        batchId: plan.batchId,
        openingAngle: target.openingAngle,
        questionKey: "opening_choice",
        generationMode: "provider",
        batchPlan: plan,
      });
      if (isCurrentOperation(operation)) {
        const turns = await runtime.creativeJourneys.listTurns(journey.id);
        if (isCurrentOperation(operation)) {
          setJourney(updated);
          setTurnCount(turns.length);
          await loadActive();
        }
      }
    } catch (cause: unknown) {
      if (isCurrentOperation(operation)) {
        setError(cause);
        const latest = await runtime.creativeJourneys.findById(journey.id).catch(() => null);
        if (latest !== null && isCurrentOperation(operation)) {
          setJourney(latest);
        }
      }
    } finally {
      finishRequestTiming(requestId);
      clearStreamingPreviews([requestId]);
      if (isCurrentOperation(operation)) {
        setBusy(null);
      }
      finishOperation(operation);
    }
  }

  async function chooseOpeningSuggestion(suggestionId: string): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      busy !== null ||
      hasPersistedGenerationPending(snapshot)
    ) {
      return;
    }
    const suggestion = snapshot.openingSuggestions.find(
      (candidate) => candidate.id === suggestionId && isUsableOpeningSuggestion(candidate),
    );
    if (suggestion === undefined || snapshot.selectedOpeningId === suggestion.id) {
      return;
    }
    const nextSnapshot = selectOpeningSuggestion(snapshot, suggestion);
    const updated = Object.freeze({
      ...journey,
      revision: journey.revision + 1,
      snapshot: nextSnapshot,
      updatedAt: runtime.clock.now(),
    });
    setError(null);
    try {
      await runtime.creativeJourneys.update(
        updated,
        journey.revision,
        createTurn(runtime, updated, turnCount + 1, "answer", "opening_choice", {
          snapshot: {
            selectedOpeningId: suggestion.id,
            batchId: suggestion.batchId,
            generationSource: suggestion.source,
          },
        }),
      );
      setJourney(updated);
      setTurnCount(turnCount + 1);
      await loadActive();
    } catch (cause: unknown) {
      setError(cause);
    }
  }

  async function goBack(): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      snapshot.questionIndex === 0 ||
      busy !== null ||
      hasPersistedGenerationPending(snapshot)
    ) {
      return;
    }
    const previousIndex = Math.max(0, snapshot.questionIndex - 1);
    const previous = snapshot.questionPlan[previousIndex];
    if (previous === undefined) {
      return;
    }
    const history = snapshot.questionHistory.filter((key) => key !== previous);
    const nextSnapshot = Object.freeze({
      ...snapshot,
      questionHistory: Object.freeze(history),
      questionIndex: previousIndex,
      remainingQuestionFocus: Object.freeze([
        ...new Set([...snapshot.remainingQuestionFocus, previous]),
      ]),
      currentQuestionKey: previous,
      pendingRequestId: null,
    });
    const now = runtime.clock.now();
    const updated = Object.freeze({
      ...journey,
      currentState: "asking_one_question",
      revision: journey.revision + 1,
      snapshot: nextSnapshot,
      updatedAt: now,
    });
    try {
      await runtime.creativeJourneys.update(
        updated,
        journey.revision,
        createTurn(runtime, updated, turnCount + 1, "back", previous, { previous }),
      );
      setJourney(updated);
      setTurnCount((count) => count + 1);
      setCustomAnswer(nextSnapshot.answers[previous] ?? "");
      await loadActive();
    } catch (cause: unknown) {
      setError(cause);
    }
  }

  async function openSummary(): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      snapshot.preview.trim().length === 0 ||
      busy !== null ||
      hasPersistedGenerationPending(snapshot)
    ) {
      return;
    }
    setBusy("keep");
    const updated = Object.freeze({
      ...journey,
      currentState: "reviewing_summary",
      revision: journey.revision + 1,
      updatedAt: runtime.clock.now(),
    });
    setError(null);
    try {
      await runtime.creativeJourneys.update(updated, journey.revision);
      setJourney(updated);
      setProjectNameDraft(snapshot.projectName);
      setStorySummaryDraft(snapshot.storySummary);
      await loadActive();
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function returnToQuestions(): Promise<void> {
    if (journey === null || snapshot === null || busy !== null) {
      return;
    }
    setBusy("answer");
    setError(null);
    try {
      const committed = await persistSummaryDraft(
        journey,
        snapshot,
        guidanceStateForSnapshot(snapshot),
      );
      setJourney(committed.record);
      setProjectNameDraft(committed.snapshot.projectName);
      setStorySummaryDraft(committed.snapshot.storySummary);
      setCustomAnswer(committed.snapshot.answers[committed.snapshot.currentQuestionKey] ?? "");
      await loadActive();
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function persistSummaryDraft(
    current: CreativeJourneyRecord,
    currentSnapshot: IdeaJourneySnapshotV1,
    nextState: string,
  ): Promise<Readonly<{ record: CreativeJourneyRecord; snapshot: IdeaJourneySnapshotV1 }>> {
    const projectName = normalizeSummaryField(projectNameDraft, 120, "书名");
    const storySummary = normalizeSummaryField(storySummaryDraft, 4_000, "故事摘要");
    const summaryCustomized =
      storySummary !== deriveStorySummary(currentSnapshot.idea, currentSnapshot.answers);
    const now = runtime.clock.now();
    const nextSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
      ...currentSnapshot,
      projectName,
      storySummary,
      summaryCustomized,
      projectSeed: deriveIdeaProjectSeed({
        seedId: currentSnapshot.projectSeed.seedId,
        idea: storySummary,
        answers: currentSnapshot.answers,
        skippedQuestionKeys: currentSnapshot.skippedQuestionKeys,
        now,
        existing: currentSnapshot.projectSeed,
      }),
    });
    const updated = Object.freeze({
      ...current,
      currentState: nextState,
      revision: current.revision + 1,
      snapshot: nextSnapshot,
      updatedAt: now,
    });
    await runtime.creativeJourneys.update(updated, current.revision);
    return Object.freeze({ record: updated, snapshot: nextSnapshot });
  }

  async function keepAndContinue(): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      snapshot.preview.trim().length === 0 ||
      busy !== null ||
      hasPersistedGenerationPending(snapshot)
    ) {
      return;
    }
    const operation = startOperation(journey.id);
    setBusy("keep");
    setError(null);
    try {
      const committed = await persistSummaryDraft(journey, snapshot, "creating_project");
      let current = committed.record;
      const projectSnapshot = committed.snapshot;
      const selectedOpening = [
        ...projectSnapshot.openingSuggestions,
        ...projectSnapshot.openingResultHistory,
      ].find(
        (suggestion) =>
          suggestion.id === projectSnapshot.selectedOpeningId &&
          isUsableOpeningSuggestion(suggestion),
      );
      if (selectedOpening?.text !== projectSnapshot.preview) {
        throw new UiActionError(
          "IDEA_OPENING_SELECTION_INVALID",
          "当前开头没有可核对的选择记录，墨影已停止创建以保护正文。请重新选择一个开头。",
        );
      }
      const incompleteCandidate = selectedOpening.status === "partial";
      if (isCurrentOperation(operation)) {
        setJourney(current);
      }
      const provisioned = await provisionJourneyWorkspace(current, projectSnapshot, operation);
      current = provisioned.current;
      const { projectId, chapterId } = provisioned;
      assertCurrentOperation(operation);
      await persistGuidedStorySetup(runtime, projectId.value, projectSnapshot);
      assertCurrentOperation(operation);
      const candidateId = parseUuidV7(current.id);
      if (!candidateId.ok) {
        throw candidateId.error;
      }
      const existingCandidate = await runtime.repositories.aiCandidates.findById(candidateId.value);
      assertCurrentOperation(operation);
      if (!existingCandidate.ok) {
        throw existingCandidate.error;
      }
      let candidate = existingCandidate.value;
      if (candidate === null) {
        assertCurrentOperation(operation);
        const persisted = await persistCreativeOpeningCandidate(
          runtime,
          chapterId.value,
          projectSnapshot.preview,
          candidateId.value,
          incompleteCandidate,
        );
        if (!persisted.ok) {
          throw persisted.error;
        }
        assertCurrentOperation(operation);
        candidate = persisted.value;
      } else if (
        candidate.chapterId !== chapterId.value ||
        candidate.content !== projectSnapshot.preview ||
        candidate.status !== "ready" ||
        candidate.toSnapshot().incomplete !== incompleteCandidate
      ) {
        throw new UiActionError(
          "IDEA_CANDIDATE_SCOPE_MISMATCH",
          "已有 AI 建议版本与当前开书流程不一致，系统已停止写入以保护正文。请从作品库打开项目确认版本后再继续。",
        );
      }
      if (current.candidateId === null) {
        current = await saveScope(current, { candidateId: candidate.id }, operation);
      }
      const now = runtime.clock.now();
      const completed = Object.freeze({
        ...current,
        status: "completed" as const,
        currentState: "candidate_ready",
        candidateId: candidate.id,
        revision: current.revision + 1,
        updatedAt: now,
        completedAt: now,
      });
      assertCurrentOperation(operation);
      await runtime.creativeJourneys.update(
        completed,
        current.revision,
        createTurn(runtime, completed, turnCount + 1, "keep", null, {
          candidateId: candidate.id,
        }),
      );
      if (isCurrentOperation(operation)) {
        void navigate(
          `/projects/${String(projectId.value)}/chapters/${String(chapterId.value)}?candidate=${candidate.id}`,
        );
      }
    } catch (cause: unknown) {
      if (isCurrentOperation(operation)) {
        setError(cause);
        const latest = await runtime.creativeJourneys.findById(journey.id).catch(() => null);
        if (latest !== null && isCurrentOperation(operation)) {
          setJourney(latest);
        }
      }
    } finally {
      if (isCurrentOperation(operation)) {
        setBusy(null);
      }
      finishOperation(operation);
    }
  }

  async function provisionJourneyWorkspace(
    savedRecord: CreativeJourneyRecord,
    savedSnapshot: IdeaJourneySnapshotV1,
    operation: JourneyOperation,
  ): Promise<
    Readonly<{
      current: CreativeJourneyRecord;
      projectId: ReturnType<typeof parseUuidV7> & { ok: true };
      chapterId: ReturnType<typeof parseUuidV7> & { ok: true };
    }>
  > {
    assertCurrentOperation(operation);
    const planned = await ensureProvisioningPlan(savedRecord, savedSnapshot, operation);
    assertCurrentOperation(operation);
    let current = planned.current;
    const projectId = parseUuidV7(planned.plan.projectId);
    const chapterId = parseUuidV7(planned.plan.chapterId);
    const initialVersionId = parseUuidV7(planned.plan.initialVersionId);
    if (!projectId.ok) throw projectId.error;
    if (!chapterId.ok) throw chapterId.error;
    if (!initialVersionId.ok) throw initialVersionId.error;
    if (planned.plan.projectName === null) {
      throw new UiActionError(
        "IDEA_PROVISIONING_NAME_MISSING",
        "作品名称还没有安全保存，当前构思仍保存在本机，请重试。",
      );
    }
    if (current.projectId !== null && current.projectId !== projectId.value) {
      throw new UiActionError(
        "IDEA_PROJECT_SCOPE_MISMATCH",
        "已保存的作品与本次构思计划不一致，系统已停止创建以避免产生重复作品。",
      );
    }
    assertCurrentOperation(operation);
    const project = await runtime.useCases.createProject.execute({
      name: planned.plan.projectName,
      plannedId: projectId.value,
    });
    if (!project.ok) throw project.error;
    if (project.value.id !== projectId.value) {
      throw new UiActionError(
        "IDEA_PROJECT_SCOPE_MISMATCH",
        "作品创建结果与本次构思计划不一致，系统已停止继续写入。",
      );
    }
    assertCurrentOperation(operation);
    if (current.projectId === null) {
      current = await saveScope(current, { projectId: project.value.id }, operation);
    }
    assertCurrentOperation(operation);
    await runtime.projectSeeds.saveForProject(projectId.value, planned.snapshot.projectSeed);
    assertCurrentOperation(operation);

    if (current.chapterId !== null && current.chapterId !== chapterId.value) {
      throw new UiActionError(
        "IDEA_CHAPTER_SCOPE_MISMATCH",
        "已保存的第一章与本次构思计划不一致，系统已停止创建以保护正文。",
      );
    }
    assertCurrentOperation(operation);
    const chapter = await runtime.useCases.createChapter.execute({
      projectId: projectId.value,
      title: "第一章",
      content: "",
      plannedChapterId: chapterId.value,
      plannedInitialVersionId: initialVersionId.value,
    });
    if (!chapter.ok) throw chapter.error;
    if (
      chapter.value.chapter.id !== chapterId.value ||
      chapter.value.version.id !== initialVersionId.value
    ) {
      throw new UiActionError(
        "IDEA_CHAPTER_SCOPE_MISMATCH",
        "第一章创建结果与本次构思计划不一致，系统已停止继续写入。",
      );
    }
    assertCurrentOperation(operation);
    if (current.chapterId === null) {
      current = await saveScope(current, { chapterId: chapter.value.chapter.id }, operation);
    }
    return Object.freeze({ current, projectId, chapterId });
  }

  async function ensureProvisioningPlan(
    savedRecord: CreativeJourneyRecord,
    savedSnapshot: IdeaJourneySnapshotV1,
    operation: JourneyOperation,
  ): Promise<
    Readonly<{
      current: CreativeJourneyRecord;
      snapshot: IdeaJourneySnapshotV1;
      plan: IdeaJourneyProvisioningPlanV1;
    }>
  > {
    assertCurrentOperation(operation);
    const basePlan = savedSnapshot.provisioningPlan ?? createJourneyProvisioningPlan(runtime);
    const parsedProjectId = parseUuidV7(basePlan.projectId);
    if (!parsedProjectId.ok) throw parsedProjectId.error;
    const existing = await runtime.repositories.projects.findById(parsedProjectId.value);
    assertCurrentOperation(operation);
    if (!existing.ok) throw existing.error;
    const projectName =
      existing.value === null
        ? await resolvePlannedProjectName(runtime, savedSnapshot.projectName, basePlan.projectId)
        : basePlan.projectName;
    assertCurrentOperation(operation);
    if (projectName === null) {
      throw new UiActionError(
        "IDEA_PROVISIONING_SCOPE_MISMATCH",
        "计划中的作品已经存在，但缺少可核对的名称，系统已停止恢复以避免采用错误作品。",
      );
    }
    const plan = Object.freeze({ ...basePlan, projectName });
    if (
      savedSnapshot.provisioningPlan !== null &&
      sameProvisioningPlan(savedSnapshot.provisioningPlan, plan)
    ) {
      return Object.freeze({ current: savedRecord, snapshot: savedSnapshot, plan });
    }
    const nextSnapshot = Object.freeze({ ...savedSnapshot, provisioningPlan: plan });
    const updated = Object.freeze({
      ...savedRecord,
      revision: savedRecord.revision + 1,
      snapshot: nextSnapshot,
      updatedAt: runtime.clock.now(),
    });
    assertCurrentOperation(operation);
    await runtime.creativeJourneys.update(updated, savedRecord.revision);
    if (isCurrentOperation(operation)) {
      setJourney(updated);
    }
    return Object.freeze({ current: updated, snapshot: nextSnapshot, plan });
  }

  async function saveScope(
    current: CreativeJourneyRecord,
    scope: Readonly<{ projectId?: string; chapterId?: string; candidateId?: string }>,
    operation: JourneyOperation,
  ): Promise<CreativeJourneyRecord> {
    assertCurrentOperation(operation);
    const updated = Object.freeze({
      ...current,
      currentState:
        scope.candidateId !== undefined
          ? "candidate_ready"
          : scope.chapterId !== undefined
            ? "creating_candidate"
            : "creating_chapter",
      projectId: scope.projectId ?? current.projectId,
      chapterId: scope.chapterId ?? current.chapterId,
      candidateId: scope.candidateId ?? current.candidateId,
      revision: current.revision + 1,
      updatedAt: runtime.clock.now(),
    });
    assertCurrentOperation(operation);
    await runtime.creativeJourneys.update(updated, current.revision);
    if (isCurrentOperation(operation)) {
      setJourney(updated);
    }
    return updated;
  }

  function closeJourney(): void {
    if (busy !== null) {
      return;
    }
    operationSequence.current += 1;
    activeOperation.current = null;
    setJourney(null);
    setTurnCount(0);
    setCustomAnswer("");
    setProjectNameDraft("");
    setStorySummaryDraft("");
    clearStreamingPreviews();
    setRequestTimings({});
    setBatchProgress(null);
    setBusy(null);
    setError(null);
    void loadActive();
  }

  const normalizedError = error === null ? null : normalizeUiError(error);
  const normalizedListError = listError === null ? null : normalizeUiError(listError);
  const quickAiDrawer = (
    <QuickAiConnectionDrawer
      open={quickAiOpen}
      onOpenChange={setQuickAiOpen}
      onSkip={() => setOpeningPreference("local")}
      onContinue={handleQuickAiContinue}
    />
  );

  if (
    journey !== null &&
    snapshot !== null &&
    currentQuestion !== null &&
    isSummaryReviewState(journey.currentState)
  ) {
    const answeredCount = Object.keys(snapshot.answers).length;
    const sourceLabel =
      snapshot.previewSource === "provider"
        ? `${snapshot.providerId ?? "已选供应商"} · ${snapshot.modelId ?? "已选模型"}`
        : "本地草案（未调用云端 AI）";
    return (
      <div className="desktop-page idea-journey idea-journey--summary">
        <header className="page-heading idea-journey__heading">
          <div>
            <button
              className="back-link"
              type="button"
              disabled={busy !== null}
              onClick={() => void returnToQuestions()}
            >
              返回继续调整
            </button>
            <p className="page-heading__eyebrow">创建前确认</p>
            <h1>都准备好了，看一眼全貌</h1>
            <p>书名和故事摘要都能直接改；创建后也可以继续调整。</p>
          </div>
          <Badge tone="success">已有构思在本机</Badge>
        </header>

        {normalizedError !== null && (
          <ErrorState
            title={normalizedError.title}
            description={normalizedError.description}
            errorCode={normalizedError.code}
            savedState="此前已保存的开头、回答和摘要仍在本机"
            primaryAction={{ label: "重试创建", onClick: () => void keepAndContinue() }}
            secondaryAction={{ label: "返回修改", onClick: () => void returnToQuestions() }}
          />
        )}

        <Card className="idea-journey__summary-card">
          <CardHeader>
            <CardTitle headingLevel={2}>确认一下，就开书</CardTitle>
            <p>这里只建立本地项目；开头仍会先进入“AI 建议版本”，不会直接覆盖正文。</p>
          </CardHeader>
          <CardContent>
            <div className="idea-journey__summary-fields">
              <FormField label="书名" hint="稍后仍可在作品中修改。" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={projectNameDraft}
                    maxLength={120}
                    disabled={busy !== null || journey.projectId !== null}
                    onChange={(event) => setProjectNameDraft(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <FormField
                label="故事摘要"
                hint="这是后台继续整理人物、世界和方向时使用的起点。"
                required
              >
                {(fieldProps) => (
                  <Textarea
                    {...fieldProps}
                    value={storySummaryDraft}
                    rows={6}
                    maxLength={4_000}
                    disabled={busy !== null || journey.projectId !== null}
                    onChange={(event) => setStorySummaryDraft(event.currentTarget.value)}
                  />
                )}
              </FormField>
            </div>

            <dl className="idea-journey__summary-list">
              <div>
                <dt>创作方向</dt>
                <dd>
                  {snapshot.answers.direction ??
                    snapshot.answers.opening_direction ??
                    "暂时保持当前开头，进入正文后再决定"}
                </dd>
              </div>
              <div>
                <dt>开头来源</dt>
                <dd>{sourceLabel}</dd>
              </div>
              <div>
                <dt>当前设定</dt>
                <dd>
                  已回答 {answeredCount.toLocaleString("zh-CN")} 项，跳过{" "}
                  {snapshot.skippedQuestionKeys.length.toLocaleString("zh-CN")} 项；都可以继续改
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <InlineAlert
          tone="ai-clarification"
          title="开头和设定都还由你决定"
          description="创建作品只会准备空白第一章和一个待确认的开头建议。你没有明确采用前，正式正文仍为空。"
        />

        <div className="idea-journey__summary-actions">
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void returnToQuestions()}
          >
            返回修改
          </Button>
          <Button
            loading={busy === "keep"}
            disabled={
              busy !== null ||
              projectNameDraft.trim().length === 0 ||
              storySummaryDraft.trim().length === 0
            }
            onClick={() => void keepAndContinue()}
          >
            创建作品，查看 AI 建议
          </Button>
        </div>
      </div>
    );
  }

  if (journey !== null && snapshot !== null && currentQuestion !== null) {
    const providerOpeningMode = snapshot.openingGenerationMode === "provider";
    const readySuggestionCount = snapshot.openingSuggestions.filter(
      ({ status }) => status === "ready",
    ).length;
    const partialSuggestionCount = snapshot.openingSuggestions.filter(
      ({ status }) => status === "partial",
    ).length;
    const usableSuggestionCount = readySuggestionCount + partialSuggestionCount;
    const pendingSuggestionCount = snapshot.openingSuggestions.filter(
      ({ status }) => status === "pending",
    ).length;
    const persistedGenerationPending = hasPersistedGenerationPending(snapshot);
    const guidanceComplete = snapshot.questionIndex >= snapshot.expectedQuestionTotal;
    const questionNumber = Math.min(snapshot.expectedQuestionTotal, snapshot.questionIndex + 1);
    const completedQuestionCount = Math.min(snapshot.questionIndex, snapshot.expectedQuestionTotal);
    const completedQuestionPercentage = Math.round(
      (completedQuestionCount / Math.max(snapshot.expectedQuestionTotal, 1)) * 100,
    );
    const remainingFocusLabels = snapshot.remainingQuestionFocus.map(
      (key) => QUESTION_BY_KEY.get(key)?.prompt ?? key,
    );
    return (
      <div className="desktop-page idea-journey">
        {quickAiDrawer}
        <header className="page-heading idea-journey__heading">
          <div>
            <button
              className="back-link"
              type="button"
              disabled={busy !== null}
              onClick={closeJourney}
            >
              返回创作首页
            </button>
            <p className="page-heading__eyebrow">AI 陪伴开书</p>
            <h1>先把一个想法写成可以继续的开头</h1>
            <p>
              这次问题计划预计 {String(snapshot.expectedQuestionTotal)}
              问，一次只解决一件事；可跳过、返回或随时创建。
            </p>
          </div>
          <Badge tone={readySuggestionCount > 0 ? "success" : "info"}>
            {batchProgress !== null
              ? `已返回 ${String(batchProgress.completed)}/${String(batchProgress.total)}`
              : providerOpeningMode
                ? `${String(usableSuggestionCount)} 个 AI 建议可用`
                : snapshot.preview.length > 0
                  ? "本地草案"
                  : "等待重新生成"}
          </Badge>
        </header>

        {normalizedError !== null && (
          <ErrorState
            title={normalizedError.title}
            description={normalizedError.description}
            errorCode={normalizedError.code}
            primaryAction={{ label: "重新读取", onClick: () => void resume(journey) }}
          />
        )}

        {!providerOpeningMode && snapshot.previewSource === "local_fallback" && (
          <InlineAlert
            tone={snapshot.noticeCode === "MODEL_NOT_CONNECTED" ? "info" : "warning"}
            title={
              snapshot.noticeCode === "MODEL_NOT_CONNECTED"
                ? "还没连接 AI，已先准备本地草案"
                : "AI 这次没连上，已保留本地草案"
            }
            description={creativeFallbackDescription(snapshot.noticeCode)}
            action={{
              label: "连接或检查 AI",
              onClick: () => setQuickAiOpen(true),
            }}
          />
        )}

        {providerOpeningMode && snapshot.openingBatchFailureCount > 0 && (
          <InlineAlert
            tone="warning"
            title={`${String(snapshot.openingBatchFailureCount)} 个 AI 建议没有生成`}
            description={`已成功的建议和上一批可用建议都已保留，没有用本地草案冒充 AI 结果。${providerBatchFailureDescription(snapshot.noticeCode)}`}
            action={{
              label: "检查 AI 连接",
              onClick: () => setQuickAiOpen(true),
            }}
          />
        )}

        {persistedGenerationPending && (
          <div className="idea-journey__pending-recovery">
            <InlineAlert
              tone="warning"
              title={
                pendingSuggestionCount > 0
                  ? `生成仍在进行，${String(pendingSuggestionCount)} 个方案尚未返回`
                  : "这次 AI 修改仍在等待结果"
              }
              description="各方案会独立返回并立即保存在本机。可以结束等待并取消仍在运行的请求；取消后的晚到内容只会进入历史记录，不会覆盖当前选择。"
              action={{
                label: "结束未完成请求",
                onClick: () => void endPendingGeneration(),
              }}
            />
            <Button variant="ghost" onClick={() => void resume(journey)}>
              重新读取进度
            </Button>
          </div>
        )}

        <div className="idea-journey__workspace">
          <Card className="idea-journey__preview">
            <CardHeader>
              <div className="card-heading-row">
                <CardTitle headingLevel={2}>
                  {providerOpeningMode ? "选择一个开头建议" : "开头草案"}
                </CardTitle>
                <span>
                  {providerOpeningMode
                    ? `${String(usableSuggestionCount)}/3 可用${partialSuggestionCount > 0 ? `（${String(partialSuggestionCount)} 个未完整）` : ""}`
                    : `${snapshot.preview.length.toLocaleString("zh-CN")} 字符`}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              {(busy === "regenerate" || busy === "create") && (
                <p className="idea-journey__generation-status" role="status">
                  {batchProgress === null
                    ? "正在准备第一段内容……"
                    : `三个方案正在并行生成，已返回 ${String(batchProgress.completed)}/${String(batchProgress.total)}。`}
                </p>
              )}
              {snapshot.openingSuggestions.length === 0 ? (
                busy === "regenerate" || busy === "create" ? null : (
                  <p role="status">还没有可确认的开头，请手动重新生成。</p>
                )
              ) : (
                <div className="idea-journey__suggestions" aria-label="开头建议列表" role="list">
                  {snapshot.openingSuggestions.map((suggestion, index) => {
                    const selected = snapshot.selectedOpeningId === suggestion.id;
                    const streamingText = streamingPreviews[suggestion.id] ?? "";
                    const timing = requestTimings[suggestion.id];
                    const elapsedMs = timing === undefined ? null : timing.elapsedMs;
                    return (
                      <article
                        className={`idea-journey__suggestion${selected ? " idea-journey__suggestion--selected" : ""}${suggestion.status === "failed" ? " idea-journey__suggestion--failed" : ""}${suggestion.status === "partial" ? " idea-journey__suggestion--partial" : ""}${suggestion.status === "pending" ? " idea-journey__suggestion--pending" : ""}`}
                        key={suggestion.id}
                        role="listitem"
                      >
                        <header className="idea-journey__suggestion-header">
                          <h3>{providerOpeningMode ? `方案 ${String(index + 1)}` : "本地草案"}</h3>
                          <Badge
                            tone={
                              suggestion.status === "failed"
                                ? "warning"
                                : suggestion.status === "pending"
                                  ? "info"
                                  : suggestion.status === "partial"
                                    ? "warning"
                                    : suggestion.source === "provider"
                                      ? "success"
                                      : "info"
                            }
                          >
                            {suggestion.status === "failed"
                              ? "生成失败"
                              : suggestion.status === "pending"
                                ? "等待生成"
                                : suggestion.status === "partial"
                                  ? "AI 未完整"
                                  : suggestion.source === "provider"
                                    ? "AI 已生成"
                                    : "本地生成"}
                          </Badge>
                        </header>
                        {suggestion.status !== "pending" && (
                          <p className="idea-journey__suggestion-metrics">
                            {isUsableOpeningSuggestion(suggestion)
                              ? `${String(suggestion.text.length)} 个可见字符`
                              : "0 个可见字符"}
                            {elapsedMs === null ? "" : ` · 用时 ${formatOpeningElapsed(elapsedMs)}`}
                          </p>
                        )}
                        {suggestion.status === "ready" || suggestion.status === "partial" ? (
                          <div className="idea-journey__manuscript">{suggestion.text}</div>
                        ) : suggestion.status === "pending" ? (
                          <div className="idea-journey__suggestion-failure">
                            <p>
                              已收到 {String(streamingText.length)} 个可见字符
                              {elapsedMs === null
                                ? ""
                                : ` · 已用 ${formatOpeningElapsed(elapsedMs)}`}
                              。这个请求已安全登记，恢复时不会自动重复调用。
                            </p>
                          </div>
                        ) : (
                          <div className="idea-journey__suggestion-failure">
                            <p>这个位置没有可用正文，其他成功方案不受影响。</p>
                            <code>{suggestion.noticeCode ?? "MODEL_GENERATION_FAILED"}</code>
                          </div>
                        )}
                        {suggestion.status === "partial" && (
                          <div className="idea-journey__partial-actions">
                            <InlineAlert
                              tone="warning"
                              title="结尾可能不完整"
                              description="供应商在输出上限处中断。正文足以作为草稿，但不会被标为完整，也不会自动进入正式正文。"
                            />
                            <Button
                              variant="secondary"
                              disabled={busy !== null || persistedGenerationPending}
                              onClick={() => void retryOpeningSuggestion(suggestion.id, "continue")}
                            >
                              继续补全
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={busy !== null || persistedGenerationPending}
                              onClick={() =>
                                void retryOpeningSuggestion(suggestion.id, "regenerate")
                              }
                            >
                              重新生成
                            </Button>
                            <Button
                              variant={selected ? "ghost" : "secondary"}
                              aria-pressed={selected}
                              disabled={busy !== null || persistedGenerationPending || selected}
                              onClick={() => void chooseOpeningSuggestion(suggestion.id)}
                            >
                              {selected ? "已保留为草稿" : "保留为草稿"}
                            </Button>
                          </div>
                        )}
                        {suggestion.status === "failed" && providerOpeningMode && (
                          <Button
                            variant="secondary"
                            disabled={busy !== null || persistedGenerationPending}
                            onClick={() => void retryOpeningSuggestion(suggestion.id, "regenerate")}
                          >
                            重新生成此方案
                          </Button>
                        )}
                        {suggestion.status === "ready" && providerOpeningMode && (
                          <Button
                            variant={selected ? "ghost" : "secondary"}
                            aria-pressed={selected}
                            disabled={busy !== null || persistedGenerationPending || selected}
                            onClick={() => void chooseOpeningSuggestion(suggestion.id)}
                          >
                            {selected ? "已选择" : `选择方案 ${String(index + 1)}`}
                          </Button>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
              {snapshot.openingResultHistory.length > 0 && (
                <section className="idea-journey__result-history" aria-label="较早请求返回的结果">
                  <h3>较早请求返回的结果</h3>
                  <p>这些结果只用于追溯，不会覆盖你当前选择的方案。</p>
                  <div className="idea-journey__suggestions" role="list">
                    {snapshot.openingResultHistory.map((suggestion, index) => (
                      <article
                        className={`idea-journey__suggestion${suggestion.status === "failed" ? " idea-journey__suggestion--failed" : ""}`}
                        key={suggestion.id}
                        role="listitem"
                      >
                        <header className="idea-journey__suggestion-header">
                          <h4>{`历史结果 ${String(index + 1)}`}</h4>
                          <Badge tone={suggestion.status === "ready" ? "info" : "warning"}>
                            {suggestion.status === "ready"
                              ? "已安全归档"
                              : suggestion.status === "partial"
                                ? "未完整草稿已归档"
                                : suggestion.noticeCode === GENERATION_ABANDONED_BY_AUTHOR
                                  ? "已结束等待"
                                  : "未生成正文"}
                          </Badge>
                        </header>
                        {isUsableOpeningSuggestion(suggestion) ? (
                          <div className="idea-journey__manuscript">{suggestion.text}</div>
                        ) : (
                          <div className="idea-journey__suggestion-failure">
                            <p>
                              {suggestion.noticeCode === GENERATION_ABANDONED_BY_AUTHOR
                                ? "你已结束这次未完成请求；恢复流程不会自动重新调用 AI。"
                                : "这次历史请求没有可用正文。"}
                            </p>
                            <code>{suggestion.noticeCode ?? "MODEL_GENERATION_FAILED"}</code>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}
              <div className="idea-journey__preview-actions">
                <Button
                  variant="secondary"
                  loading={busy === "regenerate"}
                  disabled={
                    busy !== null ||
                    persistedGenerationPending ||
                    (guidanceComplete && snapshot.guidanceRewriteUsed)
                  }
                  onClick={() => void regenerate()}
                >
                  {guidanceComplete
                    ? snapshot.guidanceRewriteUsed
                      ? "已完成一次明确重写"
                      : "根据全部回答重写一次"
                    : providerOpeningMode
                      ? "换一批"
                      : "重新生成开头"}
                </Button>
                <Button
                  loading={busy === "keep"}
                  disabled={
                    busy !== null ||
                    persistedGenerationPending ||
                    snapshot.preview.trim().length === 0
                  }
                  onClick={() => void openSummary()}
                >
                  {snapshot.selectedOpeningId !== null &&
                  [...snapshot.openingSuggestions, ...snapshot.openingResultHistory].some(
                    ({ id, status }) => id === snapshot.selectedOpeningId && status === "partial",
                  )
                    ? "使用未完整草稿，确认创建"
                    : "保留开头，确认创建"}
                </Button>
              </div>
              <p className="idea-journey__safety-note">
                每个方案都彼此隔离。只有当前选择的方案会在创建作品后成为“AI
                建议版本”；你在比较界面明确接受前，正式正文保持为空。
              </p>
            </CardContent>
          </Card>

          <Card className="idea-journey__question">
            {guidanceComplete ? (
              <>
                <CardHeader>
                  <p className="page-heading__eyebrow">问题计划已完成</p>
                  <CardTitle headingLevel={2}>已经收集完这次开书需要的核心信息</CardTitle>
                  <p>
                    已走完 {String(snapshot.expectedQuestionTotal)}/
                    {String(snapshot.expectedQuestionTotal)} 问（100%）；剩余重点：无。回答已更新到
                    ProjectSeed；没有自动重写开头，也没有写入正式正文。
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="idea-journey__question-actions">
                    <Button
                      variant="ghost"
                      disabled={busy !== null || persistedGenerationPending}
                      onClick={() => void goBack()}
                    >
                      返回上一问
                    </Button>
                    <Button
                      variant="secondary"
                      loading={busy === "regenerate"}
                      disabled={
                        busy !== null || persistedGenerationPending || snapshot.guidanceRewriteUsed
                      }
                      onClick={() => void regenerate()}
                    >
                      {snapshot.guidanceRewriteUsed ? "已明确重写一次" : "根据回答重写一次"}
                    </Button>
                    <Button
                      loading={busy === "keep"}
                      disabled={
                        busy !== null ||
                        persistedGenerationPending ||
                        snapshot.preview.trim().length === 0
                      }
                      onClick={() => void openSummary()}
                    >
                      直接确认创建
                    </Button>
                  </div>
                </CardContent>
              </>
            ) : (
              <>
                <CardHeader>
                  <p className="page-heading__eyebrow">
                    第 {String(questionNumber)}/{String(snapshot.expectedQuestionTotal)} 问
                  </p>
                  <CardTitle headingLevel={2}>{currentQuestion.prompt}</CardTitle>
                  <p>
                    <strong>本问目的：</strong>
                    {currentQuestion.helper}
                  </p>
                  <div className="idea-journey__question-progress" role="status">
                    <progress max={snapshot.expectedQuestionTotal} value={completedQuestionCount} />
                    <span>
                      已完成 {String(completedQuestionCount)}/
                      {String(snapshot.expectedQuestionTotal)}（
                      {String(completedQuestionPercentage)}%）；剩余重点（含可选扩展，共
                      {String(remainingFocusLabels.length)} 项）：
                      {remainingFocusLabels.slice(0, 3).join("、") || "无"}
                      {remainingFocusLabels.length > 3 ? "……" : ""}
                    </span>
                  </div>
                  {snapshot.questionPlanExpansionNotice !== null && (
                    <InlineAlert
                      tone="info"
                      title="问题计划已按你的新信息扩展"
                      description={snapshot.questionPlanExpansionNotice}
                    />
                  )}
                </CardHeader>
                <CardContent>
                  <div className="idea-journey__options" aria-label="推荐选项">
                    {currentQuestion.options.map((option) => (
                      <Button
                        key={option}
                        variant="secondary"
                        disabled={busy !== null || persistedGenerationPending}
                        onClick={() => void answerCurrent(option)}
                      >
                        {option}
                      </Button>
                    ))}
                  </div>
                  <FormField label="自己回答" hint="自然语言即可，不需要写提示词。">
                    {(fieldProps) => (
                      <Textarea
                        {...fieldProps}
                        value={customAnswer}
                        rows={4}
                        maxLength={1_000}
                        placeholder={currentQuestion.placeholder}
                        disabled={busy !== null || persistedGenerationPending}
                        onChange={(event) => setCustomAnswer(event.currentTarget.value)}
                      />
                    )}
                  </FormField>
                  <div className="idea-journey__question-actions">
                    <Button
                      variant="ghost"
                      disabled={
                        busy !== null || persistedGenerationPending || snapshot.questionIndex === 0
                      }
                      onClick={() => void goBack()}
                    >
                      返回上一问
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy !== null || persistedGenerationPending}
                      onClick={() => void answerCurrent("", true)}
                    >
                      跳过
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={
                        busy !== null ||
                        persistedGenerationPending ||
                        snapshot.preview.trim().length === 0
                      }
                      onClick={() => void openSummary()}
                    >
                      结束引导并创建
                    </Button>
                    <Button
                      loading={busy === "answer"}
                      disabled={
                        busy !== null ||
                        persistedGenerationPending ||
                        customAnswer.trim().length === 0
                      }
                      onClick={() => void answerCurrent(customAnswer)}
                    >
                      采用我的回答
                    </Button>
                  </div>
                </CardContent>
              </>
            )}
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="desktop-page idea-journey idea-journey--landing">
      {quickAiDrawer}
      <header className="page-heading idea-journey__heading">
        <div>
          <Link className="back-link" to="/start">
            返回开始
          </Link>
          <p className="page-heading__eyebrow">从一个想法开始</p>
          <h1>一句话就够了</h1>
          <p>连接 AI 后先得到三种可选开头，再由 AI 每次只问一个真正有用的问题。</p>
        </div>
        <Badge tone="success">无需先填设定</Badge>
      </header>

      {normalizedError !== null && (
        <ErrorState
          title={normalizedError.title}
          description={normalizedError.description}
          errorCode={normalizedError.code}
          {...(blankWorkspaceAttempt === null
            ? {}
            : {
                primaryAction: {
                  label: "重试创建",
                  onClick: () =>
                    void createBlankAuthorWorkspace(blankWorkspaceAttempt.snapshot.idea),
                },
              })}
        />
      )}

      {destination !== null && (
        <InlineAlert
          tone="info"
          title={
            openingPreference === "self"
              ? "自己写：不会调用 AI"
              : destination.kind === "provider"
                ? "已选择一个 AI 模型"
                : "AI 还没连接，也可以开始"
          }
          description={
            openingPreference === "self"
              ? "一句话可以留空；墨影会直接创建本地项目和空白第一章，不会生成 AI 建议版本，也不会向正文填入占位内容。"
              : destination.kind === "provider"
                ? `点击“生成第一段”后会依次生成三种开头方案；每个方案都保留真实来源，只有你选中的方案才能进入后续确认。当前模型：${destination.providerId} · ${destination.modelId}。`
                : "这句话不会发送到网络，墨影会先准备一份明确标注的本地草案；你仍能完成构思并安全创建作品。"
          }
          {...(destination.kind === "local" && openingPreference !== "self"
            ? {
                action: {
                  label: "去连接 AI",
                  onClick: () => setQuickAiOpen(true),
                },
              }
            : {})}
        />
      )}

      <Card className="idea-journey__idea-card">
        <CardHeader>
          <CardTitle headingLevel={2}>你现在想写什么？</CardTitle>
        </CardHeader>
        <CardContent>
          <FormField
            label="一句话灵感"
            hint={
              openingPreference === "self"
                ? "可选；留空也能直接进入空白第一章。"
                : "类型、人物、世界观都可以暂时不确定。"
            }
            required={openingPreference !== "self"}
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={idea}
                rows={5}
                maxLength={4_000}
                placeholder="例如：我想写一个青春恋爱轻小说，男女主因为一本写满预言的旧日记认识。"
                onChange={(event) => setIdea(event.currentTarget.value)}
              />
            )}
          </FormField>
          <Button
            loading={busy === "create"}
            disabled={busy !== null || (openingPreference !== "self" && idea.trim().length < 2)}
            onClick={() => void begin()}
          >
            {openingPreference === "self"
              ? "创建空白作品"
              : openingPreference === "sample"
                ? "先看看示例"
                : "生成第一段"}
          </Button>
          {openingPreference !== "self" && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setOpeningPreference("self");
                void createBlankAuthorWorkspace(idea.normalize("NFC").trim());
              }}
            >
              不输入灵感，直接空白写作
            </Button>
          )}
        </CardContent>
      </Card>

      <section className="idea-journey__resume" aria-labelledby="resume-idea-title">
        <h2 id="resume-idea-title">继续上次构思</h2>
        {unreadableJourneyCount > 0 && (
          <InlineAlert
            tone="warning"
            title="有一条旧构思暂时无法读取"
            description={`${String(unreadableJourneyCount)} 条旧流程数据格式不完整，已单独跳过；现有项目和正文没有受到影响。`}
          />
        )}
        <PageStateBoundary
          state={listState === "error" ? "fatal_error" : listState}
          preserveContent={false}
          fallbacks={{
            empty: (
              <EmptyState
                title="还没有未完成的构思"
                description="输入一句话后，问题、回答和开头草案会自动保存在当前设备。"
              />
            ),
            fatal_error:
              normalizedListError === null ? undefined : (
                <ErrorState
                  title={normalizedListError.title}
                  description={normalizedListError.description}
                  errorCode={normalizedListError.code}
                  primaryAction={{ label: "重试", onClick: () => void loadActive() }}
                />
              ),
          }}
        >
          <div className="idea-journey__resume-list">
            {activeJourneys.map((record) => {
              const saved = readIdeaSnapshot(record.snapshot);
              return (
                <Card key={record.id}>
                  <CardHeader>
                    <CardTitle headingLevel={3}>
                      {saved.idea.slice(0, 48) || saved.projectName}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p>上次保存：{new Date(record.updatedAt).toLocaleString("zh-CN")}</p>
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void resume(record)}
                    >
                      {saved.openingMode === "self" ? "继续创建空白作品" : "继续这次构思"}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </PageStateBoundary>
      </section>
    </div>
  );
}

function readIdeaSnapshot(
  value: Readonly<Record<string, unknown>>,
  journeyId = "legacy",
): IdeaJourneySnapshotV1 {
  if (
    value.version !== 1 ||
    typeof value.idea !== "string" ||
    typeof value.preview !== "string" ||
    (value.previewSource !== null &&
      value.previewSource !== "provider" &&
      value.previewSource !== "local_fallback") ||
    (value.providerId !== null && typeof value.providerId !== "string") ||
    (value.modelId !== null && typeof value.modelId !== "string") ||
    (value.noticeCode !== null && typeof value.noticeCode !== "string") ||
    (value.pendingRequestId !== undefined &&
      value.pendingRequestId !== null &&
      typeof value.pendingRequestId !== "string") ||
    (value.openingGenerationMode !== undefined &&
      value.openingGenerationMode !== "provider" &&
      value.openingGenerationMode !== "local") ||
    (value.openingSuggestions !== undefined &&
      !isOpeningSuggestionArray(value.openingSuggestions)) ||
    (value.openingResultHistory !== undefined &&
      !isOpeningSuggestionArray(value.openingResultHistory)) ||
    (value.selectedOpeningId !== undefined &&
      value.selectedOpeningId !== null &&
      typeof value.selectedOpeningId !== "string") ||
    (value.openingBatchId !== undefined &&
      value.openingBatchId !== null &&
      typeof value.openingBatchId !== "string") ||
    (value.openingBatchFailureCount !== undefined &&
      (!Number.isSafeInteger(value.openingBatchFailureCount) ||
        Number(value.openingBatchFailureCount) < 0)) ||
    (value.provisioningPlan !== undefined &&
      value.provisioningPlan !== null &&
      !isProvisioningPlan(value.provisioningPlan)) ||
    !isStringRecord(value.answers) ||
    !isStringArray(value.skippedQuestionKeys) ||
    !isStringArray(value.questionHistory) ||
    (value.questionPlan !== undefined && !isGuidanceQuestionPlan(value.questionPlan)) ||
    (value.expectedQuestionTotal !== undefined &&
      (!Number.isSafeInteger(value.expectedQuestionTotal) ||
        Number(value.expectedQuestionTotal) < 1 ||
        Number(value.expectedQuestionTotal) > MAX_GUIDANCE_PLAN_LENGTH)) ||
    (value.questionIndex !== undefined &&
      (!Number.isSafeInteger(value.questionIndex) || Number(value.questionIndex) < 0)) ||
    (value.remainingQuestionFocus !== undefined &&
      !isGuidanceFocusList(value.remainingQuestionFocus)) ||
    (value.questionPlanExpansionNotice !== undefined &&
      value.questionPlanExpansionNotice !== null &&
      typeof value.questionPlanExpansionNotice !== "string") ||
    typeof value.currentQuestionKey !== "string" ||
    !QUESTION_BY_KEY.has(value.currentQuestionKey) ||
    (value.projectName !== undefined && typeof value.projectName !== "string") ||
    (value.storySummary !== undefined && typeof value.storySummary !== "string") ||
    (value.summaryCustomized !== undefined && typeof value.summaryCustomized !== "boolean") ||
    (value.guidanceRewriteUsed !== undefined && typeof value.guidanceRewriteUsed !== "boolean") ||
    (value.openingMode !== undefined &&
      value.openingMode !== "guided" &&
      value.openingMode !== "self" &&
      value.openingMode !== "sample")
  ) {
    throw new UiActionError(
      "IDEA_JOURNEY_SNAPSHOT_INVALID",
      "保存的构思流程无法读取；正文和现有项目没有受到影响。请重新开始构思，或从作品库继续已有项目。",
    );
  }
  const openingMode =
    value.openingMode === "self" || value.openingMode === "sample" ? value.openingMode : "guided";
  const openingSuggestions = normalizeOpeningSuggestions(value, journeyId);
  const openingResultHistory =
    value.openingResultHistory === undefined
      ? Object.freeze([])
      : normalizePersistedOpeningSuggestions(value.openingResultHistory);
  const selectedOpening =
    [...openingSuggestions, ...openingResultHistory].find(
      (suggestion) =>
        suggestion.id === value.selectedOpeningId && isUsableOpeningSuggestion(suggestion),
    ) ??
    openingSuggestions.find(({ status }) => status === "ready") ??
    null;
  const questionPlan =
    value.questionPlan === undefined
      ? DEFAULT_GUIDANCE_QUESTION_PLAN
      : Object.freeze([...value.questionPlan]);
  if (
    value.expectedQuestionTotal !== undefined &&
    value.expectedQuestionTotal !== questionPlan.length
  ) {
    throw new UiActionError(
      "IDEA_GUIDANCE_PLAN_INVALID",
      "保存的问题计划总数与实际问题不一致，墨影已停止继续提问以避免循环。",
    );
  }
  const inferredQuestionIndex = Math.min(
    questionPlan.length,
    new Set(value.questionHistory.filter((key) => questionPlan.includes(key))).size,
  );
  const questionIndex =
    typeof value.questionIndex === "number"
      ? Math.min(questionPlan.length, value.questionIndex)
      : inferredQuestionIndex;
  const currentQuestionKey =
    questionPlan[Math.min(questionIndex, questionPlan.length - 1)] ?? "opening_direction";
  const openingGenerationMode =
    value.openingGenerationMode === "provider" || value.openingGenerationMode === "local"
      ? value.openingGenerationMode
      : value.previewSource === "provider" ||
          openingSuggestions.some(({ source }) => source === "provider")
        ? "provider"
        : "local";
  return {
    ...(value as unknown as IdeaJourneySnapshotV1),
    openingMode,
    pendingRequestId: typeof value.pendingRequestId === "string" ? value.pendingRequestId : null,
    openingGenerationMode,
    openingSuggestions,
    openingResultHistory,
    selectedOpeningId: selectedOpening?.id ?? null,
    openingBatchId:
      typeof value.openingBatchId === "string"
        ? value.openingBatchId
        : (selectedOpening?.batchId ?? openingSuggestions[0]?.batchId ?? null),
    openingBatchFailureCount:
      typeof value.openingBatchFailureCount === "number"
        ? value.openingBatchFailureCount
        : openingSuggestions.filter(({ status }) => status === "failed").length,
    provisioningPlan:
      value.provisioningPlan !== undefined && value.provisioningPlan !== null
        ? normalizeProvisioningPlan(value.provisioningPlan)
        : null,
    preview: selectedOpening?.text ?? "",
    previewSource: selectedOpening?.source ?? null,
    providerId: selectedOpening?.providerId ?? null,
    modelId: selectedOpening?.modelId ?? null,
    noticeCode:
      selectedOpening?.noticeCode ??
      (typeof value.noticeCode === "string" ? value.noticeCode : null),
    projectName:
      typeof value.projectName === "string"
        ? normalizeSummaryField(value.projectName, 120, "书名")
        : deriveProjectName(value.idea),
    storySummary:
      typeof value.storySummary === "string"
        ? openingMode === "self" && value.storySummary.trim().length === 0
          ? ""
          : normalizeSummaryField(value.storySummary, 4_000, "故事摘要")
        : deriveStorySummary(value.idea, value.answers),
    summaryCustomized: value.summaryCustomized === true,
    questionPlan,
    expectedQuestionTotal: questionPlan.length,
    questionIndex,
    remainingQuestionFocus:
      value.remainingQuestionFocus === undefined
        ? Object.freeze(
            ALL_GUIDANCE_FOCUS_KEYS.filter(
              (key) => !(value.questionHistory as readonly string[]).includes(key),
            ),
          )
        : Object.freeze([...value.remainingQuestionFocus]),
    questionPlanExpansionNotice:
      typeof value.questionPlanExpansionNotice === "string"
        ? value.questionPlanExpansionNotice
        : null,
    currentQuestionKey,
    guidanceRewriteUsed: value.guidanceRewriteUsed === true,
    projectSeed:
      parseProjectSeed(value.projectSeed) ??
      deriveIdeaProjectSeed({
        seedId: `idea:${journeyId}`,
        idea: value.idea,
        answers: value.answers,
        skippedQuestionKeys: value.skippedQuestionKeys,
        now: "1970-01-01T00:00:00.000Z",
      }),
  };
}

function isOpeningSuggestionArray(
  value: unknown,
): value is readonly PersistedIdeaOpeningSuggestionV1[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const ids = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null) {
      return false;
    }
    const suggestion = candidate as Readonly<Record<string, unknown>>;
    if (
      typeof suggestion.id !== "string" ||
      suggestion.id.length === 0 ||
      ids.has(suggestion.id) ||
      typeof suggestion.batchId !== "string" ||
      suggestion.batchId.length === 0 ||
      typeof suggestion.text !== "string" ||
      (suggestion.source !== "provider" && suggestion.source !== "local_fallback") ||
      (suggestion.status !== "pending" &&
        suggestion.status !== "ready" &&
        suggestion.status !== "partial" &&
        suggestion.status !== "failed") ||
      (suggestion.openingAngle !== undefined &&
        suggestion.openingAngle !== null &&
        !PROVIDER_OPENING_ANGLES.includes(suggestion.openingAngle as CreativeOpeningAngle)) ||
      (suggestion.providerId !== null && typeof suggestion.providerId !== "string") ||
      (suggestion.modelId !== null && typeof suggestion.modelId !== "string") ||
      (suggestion.noticeCode !== null && typeof suggestion.noticeCode !== "string") ||
      ((suggestion.status === "ready" || suggestion.status === "partial") &&
        suggestion.text.trim().length === 0) ||
      ((suggestion.status === "pending" || suggestion.status === "failed") &&
        suggestion.text.length > 0) ||
      (suggestion.status === "partial" &&
        (suggestion.source !== "provider" ||
          suggestion.noticeCode !== "MODEL_OUTPUT_TRUNCATED" ||
          suggestion.text.trim().length < MINIMUM_USABLE_PARTIAL_OPENING_CHARACTERS)) ||
      (suggestion.status === "pending" &&
        (suggestion.source !== "provider" ||
          suggestion.providerId !== null ||
          suggestion.modelId !== null ||
          suggestion.noticeCode !== null))
    ) {
      return false;
    }
    ids.add(suggestion.id);
  }
  return true;
}

function isGuidanceQuestionPlan(value: unknown): value is readonly string[] {
  return isGuidanceFocusList(value) && value.length > 0;
}

function isGuidanceFocusList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_GUIDANCE_PLAN_LENGTH) {
    return false;
  }
  const unique = new Set<string>();
  for (const key of value) {
    if (typeof key !== "string" || !QUESTION_BY_KEY.has(key) || unique.has(key)) {
      return false;
    }
    unique.add(key);
  }
  return true;
}

function isProvisioningPlan(value: unknown): value is IdeaJourneyProvisioningPlanV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const plan = value as Readonly<Record<string, unknown>>;
  return (
    typeof plan.projectId === "string" &&
    parseUuidV7(plan.projectId).ok &&
    typeof plan.chapterId === "string" &&
    parseUuidV7(plan.chapterId).ok &&
    typeof plan.initialVersionId === "string" &&
    parseUuidV7(plan.initialVersionId).ok &&
    (plan.projectName === null || typeof plan.projectName === "string")
  );
}

function normalizeProvisioningPlan(value: unknown): IdeaJourneyProvisioningPlanV1 {
  if (!isProvisioningPlan(value)) {
    throw new UiActionError(
      "IDEA_PROVISIONING_PLAN_INVALID",
      "保存的作品创建计划无法读取；现有正文和项目没有受到影响。",
    );
  }
  return Object.freeze({
    projectId: value.projectId,
    chapterId: value.chapterId,
    initialVersionId: value.initialVersionId,
    projectName:
      value.projectName === null ? null : normalizeSummaryField(value.projectName, 120, "书名"),
  });
}

function hasPersistedGenerationPending(snapshot: IdeaJourneySnapshotV1): boolean {
  return (
    snapshot.pendingRequestId !== null ||
    snapshot.openingSuggestions.some(({ status }) => status === "pending")
  );
}

function abandonPersistedOpeningGeneration(
  snapshot: IdeaJourneySnapshotV1,
): AbandonedOpeningGeneration | null {
  const pendingSuggestions = snapshot.openingSuggestions.filter(
    ({ status }) => status === "pending",
  );
  const requestIds = Object.freeze([
    ...new Set([
      ...pendingSuggestions.map(({ id }) => id),
      ...(snapshot.pendingRequestId === null ? [] : [snapshot.pendingRequestId]),
    ]),
  ]);
  if (requestIds.length === 0) {
    return null;
  }
  const history = [...snapshot.openingResultHistory];
  for (const requestId of requestIds) {
    const pending = pendingSuggestions.find(({ id }) => id === requestId);
    const abandoned = Object.freeze({
      id: requestId,
      batchId: pending?.batchId ?? snapshot.openingBatchId ?? requestId,
      text: "",
      source:
        pending?.source ??
        (snapshot.openingGenerationMode === "provider" ? "provider" : "local_fallback"),
      status: "failed" as const,
      openingAngle: pending?.openingAngle ?? null,
      providerId: null,
      modelId: null,
      noticeCode: GENERATION_ABANDONED_BY_AUTHOR,
    });
    const existingIndex = history.findIndex(({ id }) => id === requestId);
    const existing = history[existingIndex];
    if (existing !== undefined && isUsableOpeningSuggestion(existing)) {
      continue;
    }
    if (existingIndex < 0) {
      history.push(abandoned);
    } else {
      history[existingIndex] = abandoned;
    }
  }
  const suggestions = Object.freeze(
    snapshot.openingSuggestions.filter(({ status }) => status !== "pending"),
  );
  const available = [...suggestions, ...history];
  const selected =
    available.find(
      (suggestion) =>
        suggestion.id === snapshot.selectedOpeningId && isUsableOpeningSuggestion(suggestion),
    ) ??
    suggestions.find(({ status }) => status === "ready") ??
    null;
  const firstFailure = suggestions.find(({ status }) => status === "failed");
  return Object.freeze({
    snapshot: Object.freeze({
      ...snapshot,
      preview: selected?.text ?? "",
      previewSource: selected?.source ?? null,
      providerId: selected?.providerId ?? null,
      modelId: selected?.modelId ?? null,
      noticeCode:
        firstFailure?.noticeCode ?? selected?.noticeCode ?? GENERATION_ABANDONED_BY_AUTHOR,
      pendingRequestId: null,
      openingSuggestions: suggestions,
      openingResultHistory: Object.freeze(history),
      selectedOpeningId: selected?.id ?? null,
      openingBatchFailureCount: suggestions.filter(({ status }) => status === "failed").length,
    }),
    requestIds,
    batchId: snapshot.openingBatchId ?? pendingSuggestions[0]?.batchId ?? null,
  });
}

function isCreativeJourneyRevisionConflict(cause: unknown): cause is CreativeJourneyStoreError {
  return (
    cause instanceof CreativeJourneyStoreError &&
    cause.code === "CREATIVE_JOURNEY_REVISION_CONFLICT"
  );
}

function sameOperationToken(current: JourneyOperation | null, expected: JourneyOperation): boolean {
  return current !== null && current.token === expected.token;
}

function normalizeOpeningSuggestions(
  value: Readonly<Record<string, unknown>>,
  journeyId: string,
): readonly IdeaOpeningSuggestionV1[] {
  if (isOpeningSuggestionArray(value.openingSuggestions)) {
    return normalizePersistedOpeningSuggestions(value.openingSuggestions);
  }
  if (
    typeof value.preview !== "string" ||
    value.preview.trim().length === 0 ||
    (value.previewSource !== "provider" && value.previewSource !== "local_fallback")
  ) {
    return Object.freeze([]);
  }
  const legacyId =
    typeof value.pendingRequestId === "string"
      ? value.pendingRequestId
      : `legacy-opening:${journeyId}`;
  return Object.freeze([
    Object.freeze({
      id: legacyId,
      batchId: `legacy-batch:${journeyId}`,
      text: value.preview,
      source: value.previewSource,
      status: "ready" as const,
      openingAngle: null,
      providerId: typeof value.providerId === "string" ? value.providerId : null,
      modelId: typeof value.modelId === "string" ? value.modelId : null,
      noticeCode: typeof value.noticeCode === "string" ? value.noticeCode : null,
    }),
  ]);
}

function normalizePersistedOpeningSuggestions(value: unknown): readonly IdeaOpeningSuggestionV1[] {
  if (!isOpeningSuggestionArray(value)) {
    throw new UiActionError(
      "IDEA_OPENING_RESULT_HISTORY_INVALID",
      "保存的 AI 开头结果记录无法读取；现有正文和项目没有受到影响。",
    );
  }
  return Object.freeze(
    value.map((suggestion) =>
      Object.freeze({
        ...suggestion,
        openingAngle: suggestion.openingAngle === undefined ? null : suggestion.openingAngle,
      }),
    ),
  );
}

function applySingleOpeningResult(
  snapshot: IdeaJourneySnapshotV1,
  generated: CreativeOpeningResult,
  generationMode: "provider" | "local",
): IdeaJourneySnapshotV1 {
  const suggestion = openingSuggestionFromResult(
    generated,
    generated.requestId,
    generationMode,
    null,
  );
  if (suggestion.status === "failed") {
    const existing = snapshot.openingSuggestions;
    const suggestions = existing.length > 0 ? existing : Object.freeze([suggestion]);
    return Object.freeze({
      ...snapshot,
      pendingRequestId: null,
      openingGenerationMode: generationMode,
      openingSuggestions: suggestions,
      openingResultHistory:
        existing.length > 0
          ? mergeOpeningHistory(snapshot.openingResultHistory, [suggestion])
          : snapshot.openingResultHistory,
      openingBatchId: generated.requestId,
      openingBatchFailureCount:
        existing.length > 0
          ? suggestions.filter(({ status }) => status === "failed").length + 1
          : 1,
      noticeCode: generated.noticeCode,
    });
  }
  if (generationMode === "local") {
    return Object.freeze({
      ...snapshot,
      preview: suggestion.text,
      previewSource: suggestion.source,
      providerId: suggestion.providerId,
      modelId: suggestion.modelId,
      noticeCode: suggestion.noticeCode,
      pendingRequestId: null,
      openingGenerationMode: "local",
      openingSuggestions: Object.freeze([suggestion]),
      selectedOpeningId: suggestion.id,
      openingBatchId: suggestion.batchId,
      openingBatchFailureCount: 0,
    });
  }
  const selectedIndex = snapshot.openingSuggestions.findIndex(
    ({ id }) => id === snapshot.selectedOpeningId,
  );
  const suggestions = [...snapshot.openingSuggestions];
  const replaced = selectedIndex >= 0 ? suggestions[selectedIndex] : suggestions[0];
  if (selectedIndex >= 0) {
    suggestions[selectedIndex] = suggestion;
  } else if (suggestions.length < PROVIDER_OPENING_ANGLES.length) {
    suggestions.push(suggestion);
  } else {
    suggestions[0] = suggestion;
  }
  const history =
    replaced === undefined
      ? snapshot.openingResultHistory
      : mergeOpeningHistory(snapshot.openingResultHistory, [replaced]);
  const previousSelected = [...snapshot.openingSuggestions, ...history].find(
    (candidate) =>
      candidate.id === snapshot.selectedOpeningId && isUsableOpeningSuggestion(candidate),
  );
  const selected = suggestion.status === "ready" ? suggestion : (previousSelected ?? null);
  return Object.freeze({
    ...snapshot,
    preview: selected?.text ?? "",
    previewSource: selected?.source ?? null,
    providerId: selected?.providerId ?? null,
    modelId: selected?.modelId ?? null,
    noticeCode: suggestion.noticeCode ?? selected?.noticeCode ?? null,
    pendingRequestId: null,
    openingGenerationMode: "provider",
    openingSuggestions: Object.freeze(suggestions),
    openingResultHistory: history,
    selectedOpeningId: selected?.id ?? null,
    openingBatchId: suggestion.batchId,
    openingBatchFailureCount: suggestions.filter(({ status }) => status === "failed").length,
  });
}

function pendingOpeningSuggestions(
  plan: ProviderOpeningBatchPlan,
): readonly IdeaOpeningSuggestionV1[] {
  return Object.freeze(
    plan.requests.map(({ requestId, openingAngle }) =>
      Object.freeze({
        id: requestId,
        batchId: plan.batchId,
        text: "",
        source: "provider" as const,
        status: "pending" as const,
        openingAngle,
        providerId: null,
        modelId: null,
        noticeCode: null,
      }),
    ),
  );
}

function planProviderOpeningBatch(
  snapshot: IdeaJourneySnapshotV1,
  plan: ProviderOpeningBatchPlan,
): IdeaJourneySnapshotV1 {
  const history = mergeOpeningHistory(
    snapshot.openingResultHistory,
    snapshot.openingSuggestions.filter(({ status }) => status !== "pending"),
  );
  return Object.freeze({
    ...snapshot,
    pendingRequestId: plan.requests[0]?.requestId ?? null,
    openingGenerationMode: "provider",
    openingSuggestions: pendingOpeningSuggestions(plan),
    openingResultHistory: history,
    openingBatchId: plan.batchId,
    openingBatchFailureCount: 0,
  });
}

function applyProviderOpeningResult(
  snapshot: IdeaJourneySnapshotV1,
  plan: ProviderOpeningBatchPlan,
  openingAngle: CreativeOpeningAngle,
  generated: CreativeOpeningResult,
): IdeaJourneySnapshotV1 {
  const planned = plan.requests.find(({ requestId }) => requestId === generated.requestId);
  if (planned?.openingAngle !== openingAngle) {
    throw new UiActionError(
      "IDEA_OPENING_REQUEST_SCOPE_MISMATCH",
      "AI 返回结果与已保存的开头方案计划不一致，系统已停止写入。",
    );
  }
  const index = snapshot.openingSuggestions.findIndex(
    ({ id, batchId }) => id === generated.requestId && batchId === plan.batchId,
  );
  if (index < 0) {
    throw new UiActionError(
      "IDEA_OPENING_REQUEST_NOT_PLANNED",
      "AI 返回了未登记的开头方案，系统已停止写入。",
    );
  }
  const suggestion = openingSuggestionFromResult(generated, plan.batchId, "provider", openingAngle);
  const existing = snapshot.openingSuggestions[index];
  if (existing === undefined) {
    throw new UiActionError(
      "IDEA_OPENING_REQUEST_NOT_PLANNED",
      "已保存的开头方案位置无法读取，系统已停止写入。",
    );
  }
  if (existing.status !== "pending") {
    if (sameOpeningSuggestion(existing, suggestion)) {
      return snapshot;
    }
    throw new UiActionError(
      "IDEA_OPENING_REQUEST_RESULT_MISMATCH",
      "同一个 AI 请求返回了不同内容，系统已停止覆盖已保存的结果。",
    );
  }

  const updated = [...snapshot.openingSuggestions];
  updated[index] = suggestion;
  const suggestions = Object.freeze(updated);
  const pending = suggestions.filter(({ status }) => status === "pending");
  const failed = suggestions.filter(({ status }) => status === "failed");
  const allAvailable = [...suggestions, ...snapshot.openingResultHistory];
  const replacesSelected = planned.replacesOpeningId === snapshot.selectedOpeningId;
  const selected =
    (replacesSelected && suggestion.status === "ready" ? suggestion : undefined) ??
    allAvailable.find(
      (candidate) =>
        candidate.id === snapshot.selectedOpeningId && isUsableOpeningSuggestion(candidate),
    ) ??
    suggestions.find(({ status }) => status === "ready") ??
    null;
  return Object.freeze({
    ...snapshot,
    preview: selected?.text ?? "",
    previewSource: selected?.source ?? null,
    providerId: selected?.providerId ?? null,
    modelId: selected?.modelId ?? null,
    noticeCode: failed[0]?.noticeCode ?? selected?.noticeCode ?? null,
    pendingRequestId: pending[0]?.id ?? null,
    openingGenerationMode: "provider",
    openingSuggestions: suggestions,
    selectedOpeningId: selected?.id ?? null,
    openingBatchId: plan.batchId,
    openingBatchFailureCount: failed.length,
  });
}

function mergeOpeningHistory(
  existing: readonly IdeaOpeningSuggestionV1[],
  additions: readonly IdeaOpeningSuggestionV1[],
): readonly IdeaOpeningSuggestionV1[] {
  const merged = [...existing];
  for (const addition of additions) {
    const index = merged.findIndex(({ id }) => id === addition.id);
    if (index < 0) {
      merged.push(addition);
    } else {
      const current = merged[index];
      if (current !== undefined && sameOpeningSuggestion(current, addition)) {
        continue;
      }
    }
  }
  return Object.freeze(merged);
}

function countPendingSuggestions(snapshot: IdeaJourneySnapshotV1, batchId: string): number {
  return snapshot.openingSuggestions.filter(
    ({ batchId: suggestionBatchId, status }) =>
      suggestionBatchId === batchId && status === "pending",
  ).length;
}

function isUsableOpeningSuggestion(suggestion: IdeaOpeningSuggestionV1): boolean {
  return suggestion.status === "ready" || suggestion.status === "partial";
}

function settledOpeningStatus(suggestion: IdeaOpeningSuggestionV1): "ready" | "partial" | "failed" {
  return suggestion.status === "pending" ? "failed" : suggestion.status;
}

function guidanceStateForSnapshot(snapshot: IdeaJourneySnapshotV1): string {
  return snapshot.questionIndex >= snapshot.questionPlan.length
    ? "guidance_complete"
    : "asking_one_question";
}

function formatOpeningElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return "不足 1 秒";
  }
  return `${(milliseconds / 1_000).toFixed(1)} 秒`;
}

function sameOpeningSuggestion(
  first: IdeaOpeningSuggestionV1,
  second: IdeaOpeningSuggestionV1,
): boolean {
  return (
    first.id === second.id &&
    first.batchId === second.batchId &&
    first.text === second.text &&
    first.source === second.source &&
    first.status === second.status &&
    first.openingAngle === second.openingAngle &&
    first.providerId === second.providerId &&
    first.modelId === second.modelId &&
    first.noticeCode === second.noticeCode
  );
}

function openingSuggestionFromResult(
  generated: CreativeOpeningResult,
  batchId: string,
  generationMode: "provider" | "local",
  openingAngle: CreativeOpeningAngle | null,
): IdeaOpeningSuggestionV1 {
  const status: IdeaOpeningSuggestionV1["status"] =
    generationMode === "provider" && generated.source !== "provider"
      ? "failed"
      : generated.completion === "partial"
        ? "partial"
        : "ready";
  return Object.freeze({
    id: generated.requestId,
    batchId,
    text: status === "ready" || status === "partial" ? generated.text : "",
    source: generated.source,
    status,
    openingAngle,
    providerId: generated.providerId,
    modelId: generated.modelId,
    noticeCode: generated.noticeCode,
  });
}

function selectOpeningSuggestion(
  snapshot: IdeaJourneySnapshotV1,
  suggestion: IdeaOpeningSuggestionV1,
): IdeaJourneySnapshotV1 {
  return Object.freeze({
    ...snapshot,
    preview: suggestion.text,
    previewSource: suggestion.source,
    providerId: suggestion.providerId,
    modelId: suggestion.modelId,
    noticeCode: snapshot.openingBatchFailureCount > 0 ? snapshot.noticeCode : suggestion.noticeCode,
    selectedOpeningId: suggestion.id,
  });
}

function suggestGuidancePlanExtension(
  snapshot: IdeaJourneySnapshotV1,
  currentQuestionKey: string,
  answer: string,
): Readonly<{ key: string; focusLabel: string; reason: string }> | null {
  if (snapshot.questionPlan.length >= MAX_GUIDANCE_PLAN_LENGTH || answer.length === 0) {
    return null;
  }
  const normalized = answer.normalize("NFC");
  const candidates: readonly Readonly<{ key: string; reason: string }>[] = [
    ...(/视角|第一人称|第三人称/u.test(normalized)
      ? [{ key: "pov", reason: "需要确认叙事距离，避免后续视角漂移。" }]
      : []),
    ...(/关系|感情|恋爱|搭档/u.test(normalized)
      ? [{ key: "relationship", reason: "需要确认人物之间的当前张力。" }]
      : []),
    ...(/世界|时代|城市|校园|科幻|奇幻/u.test(normalized)
      ? [{ key: "world", reason: "需要补充会直接影响人物行动的背景。" }]
      : []),
    ...(currentQuestionKey === "opening_direction"
      ? [{ key: "genre", reason: "开头方向已明确，再确认类型能减少风格误判。" }]
      : []),
    ...(currentQuestionKey === "protagonist"
      ? [{ key: "relationship", reason: "主角轮廓已明确，再确认关键关系能约束互动。" }]
      : []),
    ...(currentQuestionKey === "conflict"
      ? [{ key: "direction", reason: "眼前冲突已明确，再确认下一步推进方向。" }]
      : []),
    ...(currentQuestionKey === "tone"
      ? [{ key: "style", reason: "目标感受已明确，再确认长期写法。" }]
      : []),
    ...(currentQuestionKey === "boundaries"
      ? [{ key: "outline", reason: "内容边界已明确，可以安全确认第一段走向。" }]
      : []),
  ];
  const selected = candidates.find(
    ({ key }) =>
      snapshot.remainingQuestionFocus.includes(key) && !snapshot.questionPlan.includes(key),
  );
  if (selected === undefined) {
    return null;
  }
  return Object.freeze({
    key: selected.key,
    focusLabel: QUESTION_BY_KEY.get(selected.key)?.prompt ?? selected.key,
    reason: selected.reason,
  });
}

function createTurn(
  runtime: ReturnType<typeof useRuntime>,
  journey: CreativeJourneyRecord,
  sequence: number,
  kind: CreativeJourneyTurnKind,
  questionKey: string | null,
  input: Readonly<{
    generationSource?: "provider" | "local_fallback" | null;
    providerId?: string | null;
    modelId?: string | null;
    requestId?: string | null;
    taskKey?: string | null;
    snapshot?: Readonly<Record<string, unknown>>;
    userText?: string;
    skipped?: boolean;
    previous?: string;
    candidateId?: string;
  }>,
): CreativeJourneyTurnRecord {
  return Object.freeze({
    id: runtime.ids.next(),
    journeyId: journey.id,
    sequence,
    kind,
    questionKey,
    generationSource: input.generationSource ?? null,
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    taskKey:
      input.taskKey ??
      (input.generationSource === undefined || input.generationSource === null
        ? null
        : "opening_guidance"),
    requestId: input.requestId ?? null,
    snapshot: Object.freeze(
      input.snapshot ?? {
        ...(input.userText === undefined ? {} : { userText: input.userText }),
        ...(input.skipped === undefined ? {} : { skipped: input.skipped }),
        ...(input.previous === undefined ? {} : { previous: input.previous }),
        ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }),
      },
    ),
    createdAt: runtime.clock.now(),
  });
}

function createJourneyProvisioningPlan(
  runtime: ReturnType<typeof useRuntime>,
): IdeaJourneyProvisioningPlanV1 {
  return Object.freeze({
    projectId: runtime.ids.next(),
    chapterId: runtime.ids.next(),
    initialVersionId: runtime.ids.next(),
    projectName: null,
  });
}

async function resolvePlannedProjectName(
  runtime: ReturnType<typeof useRuntime>,
  projectName: string,
  plannedProjectId: string,
): Promise<string> {
  const baseName = normalizeSummaryField(projectName, 120, "书名");
  const baseExists = await runtime.repositories.projects.nameExists(baseName, null);
  if (!baseExists.ok) throw baseExists.error;
  if (!baseExists.value) {
    return baseName;
  }
  const compactId = plannedProjectId.replaceAll("-", "");
  for (const suffixLength of [8, 12, 16, 24, 32]) {
    const suffix = compactId.slice(-suffixLength);
    const candidate = `${baseName.slice(0, 119 - suffix.length)}-${suffix}`;
    const duplicate = await runtime.repositories.projects.nameExists(candidate, null);
    if (!duplicate.ok) throw duplicate.error;
    if (!duplicate.value) {
      return candidate;
    }
  }
  throw new UiActionError(
    "IDEA_PROJECT_NAME_EXHAUSTED",
    "无法为作品安全确定唯一名称；当前构思仍保存在本机，请修改书名后重试。",
  );
}

function sameProvisioningPlan(
  first: IdeaJourneyProvisioningPlanV1,
  second: IdeaJourneyProvisioningPlanV1,
): boolean {
  return (
    first.projectId === second.projectId &&
    first.chapterId === second.chapterId &&
    first.initialVersionId === second.initialVersionId &&
    first.projectName === second.projectName
  );
}

function sameProvisioningIdentity(
  first: IdeaJourneyProvisioningPlanV1,
  second: IdeaJourneyProvisioningPlanV1,
): boolean {
  return (
    first.projectId === second.projectId &&
    first.chapterId === second.chapterId &&
    first.initialVersionId === second.initialVersionId
  );
}

function deriveProjectName(idea: string): string {
  const normalized = idea
    .normalize("NFC")
    .replaceAll(/[\r\n]+/gu, " ")
    .replaceAll(/^[“”"'「」『』\s]+|[“”"'「」『』\s。！？!?]+$/gu, "")
    .trim();
  return (normalized.length === 0 ? "未命名新故事" : normalized).slice(0, 120);
}

function deriveStorySummary(idea: string, answers: Readonly<Record<string, string>>): string {
  const details = [
    labeledAnswer("故事基调", answers.tone),
    labeledAnswer("类型", answers.genre),
    labeledAnswer("主角", answers.protagonist),
    labeledAnswer("人物关系", answers.relationship),
    labeledAnswer("世界背景", answers.world),
    labeledAnswer("当前冲突", answers.conflict),
    labeledAnswer("创作方向", answers.direction ?? answers.opening_direction),
  ].filter((value): value is string => value !== null);
  return [idea.normalize("NFC").trim(), ...details].filter(Boolean).join("\n").slice(0, 4_000);
}

function normalizeSummaryField(value: string, maximum: number, label: string): string {
  // Author-facing prose keeps compatibility punctuation (for example Chinese commas) intact.
  // Identifiers and model inputs can use stricter canonicalization at their own boundary.
  const normalized = value.normalize("NFC").replaceAll(/\r\n?/gu, "\n").trim();
  if (
    normalized.length < 1 ||
    normalized.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw new UiActionError(
      "IDEA_SUMMARY_INVALID",
      `${label}需要保留可读文字，并控制在 ${String(maximum)} 个字符以内。当前构思仍保存在本机，请修改后再创建。`,
    );
  }
  return normalized;
}

function isSummaryReviewState(state: string): boolean {
  return (
    state === "reviewing_summary" ||
    state === "creating_project" ||
    state === "creating_chapter" ||
    state === "creating_candidate" ||
    state === "candidate_ready"
  );
}

async function persistGuidedStorySetup(
  runtime: ReturnType<typeof useRuntime>,
  projectId: string,
  snapshot: IdeaJourneySnapshotV1,
): Promise<void> {
  const storyProjectId = parseStoryUuidV7(projectId);
  if (!storyProjectId.ok) {
    throw storyProjectId.error;
  }
  const [outline, facts] = await Promise.all([
    runtime.story.outlines.findByProjectId(storyProjectId.value),
    runtime.story.facts.listByProjectId(storyProjectId.value),
  ]);
  if (!outline.ok) {
    throw outline.error;
  }
  if (!facts.ok) {
    throw facts.error;
  }
  if (outline.value === null) {
    const synopsis = [
      snapshot.storySummary,
      labeledAnswer("当前方向", snapshot.answers.opening_direction),
      labeledAnswer("当前冲突", snapshot.answers.conflict),
      labeledAnswer("下一步", snapshot.answers.direction),
    ]
      .filter((value): value is string => value !== null)
      .join("\n")
      .slice(0, 4_000);
    const created = await runtime.story.outlineService.create({
      projectId,
      title: snapshot.projectName,
      synopsis,
    });
    if (!created.ok) {
      throw created.error;
    }
  }
  await createGuidedStoryFactIfMissing(runtime, facts.value, {
    projectId,
    factType: "character_identity",
    contentText: labeledAnswer("主角", snapshot.answers.protagonist) ?? "",
  });
  await createGuidedStoryFactIfMissing(runtime, facts.value, {
    projectId,
    factType: "writing_rule",
    contentText: [
      labeledAnswer("故事基调", snapshot.answers.tone),
      labeledAnswer("叙事视角", snapshot.answers.pov),
      labeledAnswer("写作风格", snapshot.answers.style),
    ]
      .filter((value): value is string => value !== null)
      .join("\n"),
  });
  await createGuidedStoryFactIfMissing(runtime, facts.value, {
    projectId,
    factType: "writing_rule",
    contentText: labeledAnswer("禁止项", snapshot.answers.boundaries) ?? "",
    lock: true,
  });
}

async function createGuidedStoryFactIfMissing(
  runtime: ReturnType<typeof useRuntime>,
  existingFacts: readonly StoryFact[],
  input: Readonly<{
    projectId: string;
    factType: string;
    contentText: string;
    lock?: boolean;
  }>,
): Promise<void> {
  if (input.contentText.length === 0) {
    return;
  }
  if (
    existingFacts.some((fact) => {
      const snapshot = fact.toSnapshot();
      return (
        snapshot.status !== "deprecated" &&
        snapshot.factType === input.factType &&
        snapshot.contentText === input.contentText
      );
    })
  ) {
    return;
  }
  const created = await runtime.story.factService.createFormalUserFact({
    projectId: input.projectId,
    factType: input.factType,
    contentText: input.contentText,
    actorId: runtime.story.actorId,
    lock: input.lock ?? false,
    humanConfirmed: true,
  });
  if (!created.ok) {
    throw created.error;
  }
}

function labeledAnswer(label: string, value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : `${label}：${normalized}`;
}

function creativeFallbackDescription(code: string | null): string {
  switch (code) {
    case "MODEL_CREDENTIAL_MISSING":
      return "已连接的供应商缺少密钥。当前先保留本地草案；前往设置补充密钥并测试连接后，可重新生成。";
    case "SELECTED_MODEL_UNAVAILABLE":
      return "原来选择的模型目前不可用。当前先保留本地草案；前往设置重新同步并选择可用模型后，可重新生成。";
    case "MODEL_INPUT_TOO_LARGE":
      return "本次输入超过模型连接允许的大小。当前先保留本地草案；缩短灵感或已有回答后再试。";
    case "MODEL_GENERATION_FAILED":
      return "模型请求没有成功。当前先保留本地草案；请检查网络、密钥和模型状态后重新生成。";
    default:
      return "你可以立即继续构思。连接并测试 AI 后点击“重新生成开头”，系统会使用已选模型；当前草案不会冒充模型输出。";
  }
}

function providerBatchFailureDescription(code: string | null): string {
  switch (code) {
    case "MODEL_CREDENTIAL_MISSING":
      return "已连接的供应商缺少密钥；请补充密钥并重新测试连接后再换一批。";
    case "SELECTED_MODEL_UNAVAILABLE":
      return "原来选择的模型目前不可用；请重新同步并选择可用模型后再换一批。";
    case "MODEL_INPUT_TOO_LARGE":
      return "本次输入超过模型连接允许的大小；请缩短灵感或已有回答后再试。";
    case "MODEL_OUTPUT_EMPTY":
      return "模型返回了空内容；请换用可生成正文的模型，或稍后再试。";
    default:
      return "请检查网络、密钥、模型状态和任务分工后再换一批。";
  }
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
