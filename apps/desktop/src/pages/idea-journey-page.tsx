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
  PageStateBoundary,
  Textarea,
} from "@inkshadow/ui";
import { parseUuidV7 } from "@inkshadow/domain";
import { parseUuidV7 as parseStoryUuidV7, type StoryFact } from "@inkshadow/story-core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import {
  generateCreativeOpening,
  inspectCreativeOpeningDestination,
  persistCreativeOpeningCandidate,
  type CreativeOpeningDestination,
  type CreativeOpeningResult,
} from "../infrastructure/creative-opening-service";
import type {
  CreativeJourneyRecord,
  CreativeJourneyTurnKind,
  CreativeJourneyTurnRecord,
} from "../infrastructure/creative-journey-store";
import { normalizeUiError, UiActionError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

interface IdeaJourneySnapshotV1 extends Readonly<Record<string, unknown>> {
  readonly version: 1;
  readonly idea: string;
  readonly preview: string;
  readonly previewSource: "provider" | "local_fallback" | null;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly noticeCode: string | null;
  readonly pendingRequestId: string | null;
  readonly answers: Readonly<Record<string, string>>;
  readonly skippedQuestionKeys: readonly string[];
  readonly questionHistory: readonly string[];
  readonly currentQuestionKey: string;
}

interface JourneyQuestion {
  readonly key: string;
  readonly prompt: string;
  readonly helper: string;
  readonly options: readonly string[];
  readonly placeholder: string;
  readonly regeneratePreview: boolean;
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
    regeneratePreview: true,
  }),
  Object.freeze({
    key: "tone",
    prompt: "读者看完这一段，你最想让他们留下什么感觉？",
    helper: "这会影响叙述节奏和词语选择，不会锁死后续剧情。",
    options: Object.freeze(["温暖心动", "轻松好笑", "紧张悬疑", "克制伤感"]),
    placeholder: "例如：表面轻松，但隐约让人不安。",
    regeneratePreview: true,
  }),
  Object.freeze({
    key: "protagonist",
    prompt: "这一段主要跟着怎样的主角？",
    helper: "只说当前最重要的一点就够了。",
    options: Object.freeze(["普通但很敏锐", "嘴硬心软", "目标感很强", "隐藏着秘密"]),
    placeholder: "例如：刚转学、很会观察别人，却不擅长表达自己。",
    regeneratePreview: true,
  }),
  Object.freeze({
    key: "relationship",
    prompt: "主角和关键人物目前是什么关系？",
    helper: "关系会先作为可修改方案，不会自动写成永久设定。",
    options: Object.freeze(["刚刚认识", "青梅竹马", "互相看不顺眼", "一方认识另一方"]),
    placeholder: "例如：小时候见过，但只有女主还记得。",
    regeneratePreview: true,
  }),
  Object.freeze({
    key: "conflict",
    prompt: "眼前最先需要解决的麻烦是什么？",
    helper: "先确定能推动下一场景的小冲突，不必现在想完整大纲。",
    options: Object.freeze(["误会正在扩大", "秘密可能暴露", "必须共同完成一件事", "有人突然失踪"]),
    placeholder: "例如：两人被迫在放学前找到丢失的社团钥匙。",
    regeneratePreview: true,
  }),
  Object.freeze({
    key: "pov",
    prompt: "你想离谁的感受最近？",
    helper: "不确定可以跳过，系统会先保持当前写法。",
    options: Object.freeze(["第一人称主角", "第三人称跟随主角", "双主角轮换", "暂时保持当前"]),
    placeholder: "例如：第三人称限知，只写男主能察觉到的事。",
    regeneratePreview: true,
  }),
  Object.freeze({
    key: "style",
    prompt: "有没有一种你希望长期保持的写法？",
    helper: "可以描述喜欢的节奏，不需要懂提示词。",
    options: Object.freeze(["短句和更多对话", "细腻但不过度", "节奏快、少解释", "画面感更强"]),
    placeholder: "例如：减少总结句，让情绪从动作和对话里出来。",
    regeneratePreview: true,
  }),
  Object.freeze({
    key: "boundaries",
    prompt: "目前有什么内容一定不要出现？",
    helper: "这类限制会作为需要优先遵守的写作边界。",
    options: Object.freeze(["不要突然加入超自然设定", "不要强行误会", "不要角色降智", "暂时没有"]),
    placeholder: "例如：不写校园霸凌，不让主角靠巧合解决问题。",
    regeneratePreview: true,
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
    regeneratePreview: true,
  }),
]);

const QUESTION_BY_KEY = new Map(QUESTIONS.map((question) => [question.key, question]));
const DEFAULT_QUESTION = firstQuestion(QUESTIONS);

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
  const [busy, setBusy] = useState<"create" | "answer" | "regenerate" | "keep" | null>(null);
  const [streamingPreview, setStreamingPreview] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [destination, setDestination] = useState<CreativeOpeningDestination | null>(null);

  const loadActive = useCallback(async () => {
    try {
      const records = await runtime.creativeJourneys.listActive("idea");
      const readable = records.filter((record) => {
        try {
          readIdeaSnapshot(record.snapshot);
          return true;
        } catch {
          return false;
        }
      });
      setActiveJourneys(readable);
      setUnreadableJourneyCount(records.length - readable.length);
      setListState(readable.length === 0 ? "empty" : "ready");
      setError(null);
    } catch (cause: unknown) {
      setError(cause);
      setUnreadableJourneyCount(0);
      setListState("error");
    }
  }, [runtime]);

  useEffect(() => {
    void Promise.resolve().then(loadActive);
  }, [loadActive]);

  useEffect(() => {
    let active = true;
    void inspectCreativeOpeningDestination(runtime).then((value) => {
      if (active) {
        setDestination(value);
      }
    });
    return () => {
      active = false;
    };
  }, [runtime]);

  const snapshot = useMemo(
    () => (journey === null ? null : readIdeaSnapshot(journey.snapshot)),
    [journey],
  );
  const currentQuestion =
    snapshot === null
      ? null
      : (QUESTION_BY_KEY.get(snapshot.currentQuestionKey) ?? DEFAULT_QUESTION);

  async function begin(): Promise<void> {
    const normalizedIdea = idea.normalize("NFKC").trim();
    if (normalizedIdea.length < 2 || busy !== null) {
      return;
    }
    setBusy("create");
    setError(null);
    const now = runtime.clock.now();
    const id = runtime.ids.next();
    const requestId = runtime.ids.next();
    const initialSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
      version: 1,
      idea: normalizedIdea,
      preview: "",
      previewSource: null,
      providerId: null,
      modelId: null,
      noticeCode: null,
      pendingRequestId: requestId,
      answers: Object.freeze({}),
      skippedQuestionKeys: Object.freeze([]),
      questionHistory: Object.freeze([]),
      currentQuestionKey: "opening_direction",
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
    });
    try {
      await runtime.creativeJourneys.create(record, initialTurn);
      setJourney(record);
      setTurnCount(1);
      const generated = await generateCreativeOpening(runtime, {
        idea: normalizedIdea,
        requestId,
        onDelta: setStreamingPreview,
      });
      const updated = await persistGeneratedPreview(record, initialSnapshot, generated, 2);
      setJourney(updated);
      setTurnCount(2);
      setStreamingPreview("");
      setIdea("");
      await loadActive();
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function resume(record: CreativeJourneyRecord): Promise<void> {
    try {
      const turns = await runtime.creativeJourneys.listTurns(record.id);
      const loaded = readIdeaSnapshot(record.snapshot);
      setJourney(record);
      setTurnCount(turns.length);
      setCustomAnswer(loaded.answers[loaded.currentQuestionKey] ?? "");
      setError(null);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function persistGeneratedPreview(
    current: CreativeJourneyRecord,
    currentSnapshot: IdeaJourneySnapshotV1,
    generated: CreativeOpeningResult,
    sequence: number,
    questionKey = "opening_direction",
  ): Promise<CreativeJourneyRecord> {
    const nextSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
      ...currentSnapshot,
      preview: generated.text,
      previewSource: generated.source,
      providerId: generated.providerId,
      modelId: generated.modelId,
      noticeCode: generated.noticeCode,
      pendingRequestId: null,
    });
    const now = runtime.clock.now();
    const updated = Object.freeze({
      ...current,
      currentState: "asking_one_question",
      revision: current.revision + 1,
      snapshot: nextSnapshot,
      updatedAt: now,
    });
    await runtime.creativeJourneys.update(
      updated,
      current.revision,
      createTurn(runtime, updated, sequence, "regenerate", questionKey, {
        generationSource: generated.source,
        providerId: generated.providerId,
        modelId: generated.modelId,
        requestId: generated.requestId,
        snapshot: { direction: currentSnapshot.answers[questionKey] ?? null },
      }),
    );
    return updated;
  }

  async function answerCurrent(value: string, skip = false): Promise<void> {
    if (journey === null || snapshot === null || currentQuestion === null || busy !== null) {
      return;
    }
    const normalized = value.normalize("NFKC").trim();
    if (!skip && normalized.length === 0) {
      return;
    }
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
      const nextQuestionKey = selectNextQuestionKey(answers, skippedQuestionKeys, questionHistory);
      const requestId = !skip && currentQuestion.regeneratePreview ? runtime.ids.next() : null;
      const nextSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
        ...snapshot,
        answers,
        skippedQuestionKeys,
        questionHistory,
        currentQuestionKey: nextQuestionKey,
        pendingRequestId: requestId,
      });
      const now = runtime.clock.now();
      const pending = Object.freeze({
        ...journey,
        currentState: requestId === null ? "asking_one_question" : "generation_pending",
        revision: journey.revision + 1,
        snapshot: nextSnapshot,
        updatedAt: now,
      });
      await runtime.creativeJourneys.update(
        pending,
        journey.revision,
        createTurn(runtime, pending, turnCount + 1, skip ? "skip" : "answer", currentQuestion.key, {
          requestId,
          taskKey: requestId === null ? null : "opening_guidance",
          snapshot: skip ? { skipped: true } : { userText: normalized },
        }),
      );
      setJourney(pending);
      setTurnCount(turnCount + 1);
      setCustomAnswer(answers[nextQuestionKey] ?? "");
      if (requestId !== null) {
        setBusy("regenerate");
        const generated = await generateCreativeOpening(runtime, {
          idea: snapshot.idea,
          direction: normalized,
          answers,
          requestId,
          onDelta: setStreamingPreview,
        });
        const updated = await persistGeneratedPreview(
          pending,
          nextSnapshot,
          generated,
          turnCount + 2,
          currentQuestion.key,
        );
        setJourney(updated);
        setTurnCount(turnCount + 2);
      }
      setStreamingPreview("");
      await loadActive();
    } catch (cause: unknown) {
      setError(cause);
      const latest = await runtime.creativeJourneys.findById(journey.id).catch(() => null);
      if (latest !== null) {
        setJourney(latest);
        const turns = await runtime.creativeJourneys.listTurns(latest.id).catch(() => []);
        setTurnCount(turns.length);
      }
    } finally {
      setBusy(null);
    }
  }

  async function regenerate(): Promise<void> {
    if (journey === null || snapshot === null || busy !== null) {
      return;
    }
    setBusy("regenerate");
    setError(null);
    try {
      const direction = snapshot.answers.opening_direction;
      const requestId = runtime.ids.next();
      const pendingSnapshot: IdeaJourneySnapshotV1 = Object.freeze({
        ...snapshot,
        pendingRequestId: requestId,
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
          snapshot: { started: true },
        }),
      );
      setJourney(pending);
      setTurnCount(turnCount + 1);
      const generated = await generateCreativeOpening(runtime, {
        idea: snapshot.idea,
        ...(direction === undefined ? {} : { direction }),
        answers: snapshot.answers,
        requestId,
        onDelta: setStreamingPreview,
      });
      const updated = await persistGeneratedPreview(
        pending,
        pendingSnapshot,
        generated,
        turnCount + 2,
      );
      setJourney(updated);
      setTurnCount(turnCount + 2);
      setStreamingPreview("");
      await loadActive();
    } catch (cause: unknown) {
      setError(cause);
      const latest = await runtime.creativeJourneys.findById(journey.id).catch(() => null);
      if (latest !== null) {
        setJourney(latest);
        const turns = await runtime.creativeJourneys.listTurns(latest.id).catch(() => []);
        setTurnCount(turns.length);
      }
    } finally {
      setBusy(null);
    }
  }

  async function goBack(): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      snapshot.questionHistory.length === 0 ||
      busy !== null
    ) {
      return;
    }
    const history = [...snapshot.questionHistory];
    const previous = history.pop();
    if (previous === undefined) {
      return;
    }
    const nextSnapshot = Object.freeze({
      ...snapshot,
      questionHistory: Object.freeze(history),
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

  async function keepAndContinue(): Promise<void> {
    if (
      journey === null ||
      snapshot === null ||
      snapshot.preview.trim().length === 0 ||
      busy !== null
    ) {
      return;
    }
    setBusy("keep");
    setError(null);
    try {
      let current = journey;
      if (current.projectId === null) {
        const project = await createJourneyProject(runtime, snapshot.idea);
        current = await saveScope(current, { projectId: project.id });
      }
      if (current.projectId === null) {
        throw new UiActionError(
          "IDEA_PROJECT_RESULT_MISSING",
          "项目没有成功准备完成。当前构思仍保存在本机，请返回作品库确认后重试。",
        );
      }
      const projectId = parseUuidV7(current.projectId);
      if (!projectId.ok) {
        throw projectId.error;
      }
      if (current.chapterId === null) {
        const chapterResult = await runtime.useCases.createChapter.execute({
          projectId: projectId.value,
          title: "第一章",
          content: "",
        });
        if (!chapterResult.ok) {
          throw chapterResult.error;
        }
        current = await saveScope(current, { chapterId: chapterResult.value.chapter.id });
      }
      if (current.chapterId === null) {
        throw new UiActionError(
          "IDEA_CHAPTER_RESULT_MISSING",
          "第一章没有成功准备完成。当前构思仍保存在本机，请重试或从作品库打开项目。",
        );
      }
      const chapterId = parseUuidV7(current.chapterId);
      if (!chapterId.ok) {
        throw chapterId.error;
      }
      await persistGuidedStorySetup(runtime, projectId.value, snapshot);
      const candidateId = parseUuidV7(current.id);
      if (!candidateId.ok) {
        throw candidateId.error;
      }
      const existingCandidate = await runtime.repositories.aiCandidates.findById(candidateId.value);
      if (!existingCandidate.ok) {
        throw existingCandidate.error;
      }
      let candidate = existingCandidate.value;
      if (candidate === null) {
        const persisted = await persistCreativeOpeningCandidate(
          runtime,
          chapterId.value,
          snapshot.preview,
          candidateId.value,
        );
        if (!persisted.ok) {
          throw persisted.error;
        }
        candidate = persisted.value;
      } else if (
        candidate.chapterId !== chapterId.value ||
        candidate.content !== snapshot.preview ||
        candidate.status !== "ready"
      ) {
        throw new UiActionError(
          "IDEA_CANDIDATE_SCOPE_MISMATCH",
          "已有 AI 建议版本与当前开书流程不一致，系统已停止写入以保护正文。请从作品库打开项目确认版本后再继续。",
        );
      }
      if (current.candidateId === null) {
        current = await saveScope(current, { candidateId: candidate.id });
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
      await runtime.creativeJourneys.update(
        completed,
        current.revision,
        createTurn(runtime, completed, turnCount + 1, "keep", null, {
          candidateId: candidate.id,
        }),
      );
      void navigate(
        `/projects/${String(projectId.value)}/chapters/${String(chapterId.value)}?candidate=${candidate.id}`,
      );
    } catch (cause: unknown) {
      setError(cause);
      const latest = await runtime.creativeJourneys.findById(journey.id).catch(() => null);
      if (latest !== null) {
        setJourney(latest);
      }
    } finally {
      setBusy(null);
    }
  }

  async function saveScope(
    current: CreativeJourneyRecord,
    scope: Readonly<{ projectId?: string; chapterId?: string; candidateId?: string }>,
  ): Promise<CreativeJourneyRecord> {
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
    await runtime.creativeJourneys.update(updated, current.revision);
    setJourney(updated);
    return updated;
  }

  function closeJourney(): void {
    setJourney(null);
    setTurnCount(0);
    setCustomAnswer("");
    setStreamingPreview("");
    setError(null);
  }

  const normalizedError = error === null ? null : normalizeUiError(error);

  if (journey !== null && snapshot !== null && currentQuestion !== null) {
    const preview = streamingPreview.length > 0 ? streamingPreview : snapshot.preview;
    return (
      <div className="desktop-page idea-journey">
        <header className="page-heading idea-journey__heading">
          <div>
            <button className="back-link" type="button" onClick={closeJourney}>
              返回创作首页
            </button>
            <p className="page-heading__eyebrow">AI 陪伴开书</p>
            <h1>先把一个想法写成可以继续的开头</h1>
            <p>一次只解决一个问题。你可以选择、自己回答、跳过、返回或随时保留。</p>
          </div>
          <Badge tone={snapshot.previewSource === "provider" ? "success" : "info"}>
            {snapshot.preview.length === 0
              ? "等待重新生成"
              : snapshot.previewSource === "provider"
                ? "AI 已生成"
                : "本地草案"}
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

        {snapshot.previewSource === "local_fallback" && (
          <InlineAlert
            tone="info"
            title="已先准备一份不联网的开头草案"
            description={creativeFallbackDescription(snapshot.noticeCode)}
          />
        )}

        {snapshot.preview.length === 0 && snapshot.pendingRequestId !== null && (
          <InlineAlert
            tone="warning"
            title="上次生成没有留下可确认的结果"
            description="为避免恢复时重复产生一次可能收费的请求，墨影没有自动重试。你可以检查连接后手动点击“重新生成开头”。"
          />
        )}

        <div className="idea-journey__workspace">
          <Card className="idea-journey__preview">
            <CardHeader>
              <div className="card-heading-row">
                <CardTitle headingLevel={2}>开头建议</CardTitle>
                <span>{preview.length.toLocaleString("zh-CN")} 字符</span>
              </div>
            </CardHeader>
            <CardContent>
              {preview.length === 0 ? (
                <p role="status">
                  {busy === "regenerate" || busy === "create"
                    ? "正在准备第一段内容……"
                    : "还没有可确认的开头，请手动重新生成。"}
                </p>
              ) : (
                <div className="idea-journey__manuscript">{preview}</div>
              )}
              <div className="idea-journey__preview-actions">
                <Button
                  variant="secondary"
                  loading={busy === "regenerate"}
                  disabled={busy !== null}
                  onClick={() => void regenerate()}
                >
                  重新生成开头
                </Button>
                <Button
                  loading={busy === "keep"}
                  disabled={busy !== null || preview.trim().length === 0}
                  onClick={() => void keepAndContinue()}
                >
                  保留并继续写
                </Button>
              </div>
              <p className="idea-journey__safety-note">
                保留后会先成为“AI 建议版本”，只有你在比较界面明确接受，才会进入正式正文。
              </p>
            </CardContent>
          </Card>

          <Card className="idea-journey__question">
            <CardHeader>
              <p className="page-heading__eyebrow">现在只决定这一件事</p>
              <CardTitle headingLevel={2}>{currentQuestion.prompt}</CardTitle>
              <p>{currentQuestion.helper}</p>
            </CardHeader>
            <CardContent>
              <div className="idea-journey__options" aria-label="推荐选项">
                {currentQuestion.options.map((option) => (
                  <Button
                    key={option}
                    variant="secondary"
                    disabled={busy !== null}
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
                    onChange={(event) => setCustomAnswer(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <div className="idea-journey__question-actions">
                <Button
                  variant="ghost"
                  disabled={busy !== null || snapshot.questionHistory.length === 0}
                  onClick={() => void goBack()}
                >
                  返回上一问
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void answerCurrent("", true)}
                >
                  跳过
                </Button>
                <Button
                  loading={busy === "answer"}
                  disabled={busy !== null || customAnswer.trim().length === 0}
                  onClick={() => void answerCurrent(customAnswer)}
                >
                  采用我的回答
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="desktop-page idea-journey idea-journey--landing">
      <header className="page-heading idea-journey__heading">
        <div>
          <Link className="back-link" to="/start">
            返回开始
          </Link>
          <p className="page-heading__eyebrow">从一个想法开始</p>
          <h1>一句话就够了</h1>
          <p>先得到一段可以继续修改的开头，再由 AI 每次只问一个真正有用的问题。</p>
        </div>
        <Badge tone="success">无需先填设定</Badge>
      </header>

      {normalizedError !== null && (
        <ErrorState
          title={normalizedError.title}
          description={normalizedError.description}
          errorCode={normalizedError.code}
          primaryAction={{ label: "重试", onClick: () => void loadActive() }}
        />
      )}

      {destination !== null && (
        <InlineAlert
          tone="info"
          title={destination.kind === "provider" ? "将使用已连接的 AI" : "当前将先生成本地草案"}
          description={
            destination.kind === "provider"
              ? `点击“生成第一段”后，这句话会发送给 ${destination.providerId} 的 ${destination.modelId} 模型。正文仍需你确认后才会写入项目。`
              : "尚未连接可用模型，因此不会把这句话发送到网络；你仍可先体验完整构思流程。"
          }
        />
      )}

      <Card className="idea-journey__idea-card">
        <CardHeader>
          <CardTitle headingLevel={2}>你现在想写什么？</CardTitle>
        </CardHeader>
        <CardContent>
          <FormField label="一句话灵感" hint="类型、人物、世界观都可以暂时不确定。" required>
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
            disabled={busy !== null || idea.trim().length < 2}
            onClick={() => void begin()}
          >
            生成第一段
          </Button>
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
              normalizedError === null ? undefined : (
                <ErrorState
                  title={normalizedError.title}
                  description={normalizedError.description}
                  errorCode={normalizedError.code}
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
                    <CardTitle headingLevel={3}>{saved.idea.slice(0, 48)}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p>上次保存：{new Date(record.updatedAt).toLocaleString("zh-CN")}</p>
                    <Button variant="secondary" onClick={() => void resume(record)}>
                      继续这次构思
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

function readIdeaSnapshot(value: Readonly<Record<string, unknown>>): IdeaJourneySnapshotV1 {
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
    !isStringRecord(value.answers) ||
    !isStringArray(value.skippedQuestionKeys) ||
    !isStringArray(value.questionHistory) ||
    typeof value.currentQuestionKey !== "string" ||
    !QUESTION_BY_KEY.has(value.currentQuestionKey)
  ) {
    throw new UiActionError(
      "IDEA_JOURNEY_SNAPSHOT_INVALID",
      "保存的构思流程无法读取；正文和现有项目没有受到影响。请重新开始构思，或从作品库继续已有项目。",
    );
  }
  return {
    ...(value as unknown as IdeaJourneySnapshotV1),
    pendingRequestId: typeof value.pendingRequestId === "string" ? value.pendingRequestId : null,
  };
}

function selectNextQuestionKey(
  answers: Readonly<Record<string, string>>,
  skipped: readonly string[],
  history: readonly string[],
): string {
  const resolved = new Set([...Object.keys(answers), ...skipped]);
  const openingDirection = answers.opening_direction ?? "";
  const preferred = [
    ...(openingDirection.includes("关系") ? ["relationship"] : []),
    ...(openingDirection.includes("悬念") ? ["conflict"] : []),
    "tone",
    "protagonist",
    "relationship",
    "conflict",
    "pov",
    "style",
    "boundaries",
    "direction",
    "opening_direction",
  ];
  return preferred.find((key) => !resolved.has(key)) ?? history.at(-1) ?? "direction";
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

async function createJourneyProject(
  runtime: ReturnType<typeof useRuntime>,
  idea: string,
): Promise<{ readonly id: string }> {
  const baseName = deriveProjectName(idea);
  const first = await runtime.useCases.createProject.execute({ name: baseName });
  if (first.ok) {
    return first.value;
  }
  if (first.error.code !== "PROJECT_NAME_CONFLICT") {
    throw first.error;
  }
  const suffix = runtime.ids.next().slice(-4);
  const second = await runtime.useCases.createProject.execute({
    name: `${baseName.slice(0, 113)}-${suffix}`,
  });
  if (!second.ok) {
    throw second.error;
  }
  return second.value;
}

function deriveProjectName(idea: string): string {
  const normalized = idea
    .normalize("NFKC")
    .replaceAll(/[\r\n]+/gu, " ")
    .replaceAll(/^[“”"'「」『』\s]+|[“”"'「」『』\s。！？!?]+$/gu, "")
    .trim();
  return (normalized.length === 0 ? "未命名新故事" : normalized).slice(0, 120);
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
  const [outline, records, facts] = await Promise.all([
    runtime.story.outlines.findByProjectId(storyProjectId.value),
    runtime.story.formalRecords.listByProjectId(storyProjectId.value),
    runtime.story.facts.listByProjectId(storyProjectId.value),
  ]);
  if (!outline.ok) {
    throw outline.error;
  }
  if (!records.ok) {
    throw records.error;
  }
  if (!facts.ok) {
    throw facts.error;
  }
  if (outline.value === null) {
    const synopsis = [
      snapshot.idea,
      labeledAnswer("当前方向", snapshot.answers.opening_direction),
      labeledAnswer("当前冲突", snapshot.answers.conflict),
      labeledAnswer("下一步", snapshot.answers.direction),
    ]
      .filter((value): value is string => value !== null)
      .join("\n")
      .slice(0, 4_000);
    const created = await runtime.story.outlineService.create({
      projectId,
      title: deriveProjectName(snapshot.idea),
      synopsis,
    });
    if (!created.ok) {
      throw created.error;
    }
  }
  const existingKeys = new Set<string>(
    records.value.map((record) => String(record.toSnapshot().recordKey)),
  );
  const characterValues = compactAnswers(snapshot.answers, ["protagonist", "relationship"]);
  if (Object.keys(characterValues).length > 0 && !existingKeys.has("guided_opening.characters")) {
    const created = await runtime.story.formalRecordService.create({
      projectId,
      kind: "character",
      recordKey: "guided_opening.characters",
      value: { ...characterValues, origin: "guided_opening", userConfirmed: true },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
    });
    if (!created.ok) {
      throw created.error;
    }
  }
  const writingRules = compactAnswers(snapshot.answers, ["tone", "pov", "style", "boundaries"]);
  if (Object.keys(writingRules).length > 0 && !existingKeys.has("guided_opening.rules")) {
    const created = await runtime.story.formalRecordService.create({
      projectId,
      kind: "world_rule",
      recordKey: "guided_opening.rules",
      value: { ...writingRules, origin: "guided_opening", userConfirmed: true },
      actorId: runtime.story.actorId,
      humanConfirmed: true,
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
    factType: "relationship",
    contentText: labeledAnswer("人物关系", snapshot.answers.relationship) ?? "",
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

function compactAnswers(
  answers: Readonly<Record<string, string>>,
  keys: readonly string[],
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      keys.flatMap((key) => {
        const value = answers[key]?.trim();
        return value === undefined || value.length === 0 ? [] : [[key, value]];
      }),
    ),
  );
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
