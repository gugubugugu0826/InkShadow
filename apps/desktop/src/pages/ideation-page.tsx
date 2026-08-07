import {
  IDEATION_STEP_KEYS,
  buildLocalIdeationSuggestion,
  type ApplyIdeationChange,
  type FinalizeIdeationResult,
  type IdeationApplicationService,
  type IdeationDraft,
  type IdeationDraftRepository,
  type IdeationStepKey,
  type IdeationStepSnapshot,
  type StoryCoreError,
} from "@inkshadow/story-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { useNavigate } from "react-router-dom";

import { useOnlineStatus } from "../hooks/use-online-status";
import {
  desktopPersistenceLifecycle,
  type PersistenceFlushHandlerResult,
} from "../infrastructure/persistence-lifecycle";
import { useRuntime } from "../runtime-context";

type IdeationServicePort = Pick<
  IdeationApplicationService,
  "apply" | "createGuided" | "createQuick" | "finalize" | "findById"
>;

export interface IdeationPageProps {
  readonly drafts?: IdeationDraftRepository;
  readonly service?: IdeationServicePort;
}

interface QuickForm {
  readonly projectName: string;
  readonly idea: string;
  readonly genre: string;
  readonly targetWords: string;
  readonly protagonistType: string;
  readonly style: string;
}

interface VisibleIdeationError {
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly conflict: boolean;
}

type DraftListState = "loading" | "ready" | "empty" | "error";

const EMPTY_QUICK_FORM: QuickForm = Object.freeze({
  projectName: "",
  idea: "",
  genre: "",
  targetWords: "100000",
  protagonistType: "",
  style: "",
});

const STEP_DETAILS: Record<
  IdeationStepKey,
  Readonly<{ label: string; prompt: string; placeholder: string }>
> = {
  genre: {
    label: "类型与基调",
    prompt: "这本书属于什么类型？它承诺给读者怎样的体验？",
    placeholder: "例如：带现实底色的悬疑幻想，克制而紧张。",
  },
  target_audience: {
    label: "目标读者",
    prompt: "谁最可能持续读下去？他们期待什么，又不喜欢什么？",
    placeholder: "描述核心读者、阅读场景和主要期待。",
  },
  premise: {
    label: "核心创意",
    prompt: "用一段话写清异常、冲突和必须回答的问题。",
    placeholder: "当……发生时，主角必须……否则……",
  },
  protagonist_drive: {
    label: "主角驱动力",
    prompt: "主角真正想要什么？外部目标与内部缺口分别是什么？",
    placeholder: "写明欲望、恐惧、旧伤和不可回避的选择。",
  },
  world_skeleton: {
    label: "世界骨架",
    prompt: "世界依靠哪些公开规则、隐秘规则和代价规则运转？",
    placeholder: "写出区域、组织、资源、能力边界与越界代价。",
  },
  key_characters: {
    label: "关键角色",
    prompt: "哪些角色承担行动、镜像、阻碍和情感后果？",
    placeholder: "列出关键角色及其目标、关系和冲突功能。",
  },
  plot_route: {
    label: "情节路线",
    prompt: "故事从异常到终局，主要升级、转折和代价如何排列？",
    placeholder: "按开端、中段升级、关键转折和终局选择概述。",
  },
  opening_hook: {
    label: "开篇钩子",
    prompt: "第一场景展示什么具体异常，并让主角承担什么责任？",
    placeholder: "描述第一场景的目标、阻碍、变化和章末问题。",
  },
  output_spec: {
    label: "输出规格",
    prompt: "确定目标体量、视角、节奏、章节结构和风格约束。",
    placeholder: "例如：30 万字、有限视角、每章一个主要目标。",
  },
};

export function IdeationPage({
  drafts: providedDrafts,
  service: providedService,
}: IdeationPageProps) {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const drafts = providedDrafts ?? runtime.story.ideationDrafts;
  const service = providedService ?? runtime.story.ideationService;
  const [draftListState, setDraftListState] = useState<DraftListState>("loading");
  const [activeDrafts, setActiveDrafts] = useState<readonly IdeationDraft[]>([]);
  const [currentDraft, setCurrentDraft] = useState<IdeationDraft | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [guidedName, setGuidedName] = useState("");
  const [quickForm, setQuickForm] = useState<QuickForm>(EMPTY_QUICK_FORM);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<VisibleIdeationError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestionVariant, setSuggestionVariant] = useState(0);
  const currentDraftRef = useRef<IdeationDraft | null>(null);
  const currentStepRef = useRef<IdeationStepSnapshot | null>(null);
  const editorValueRef = useRef("");
  const composingRef = useRef(false);
  const ideationOperationRef = useRef<Promise<void> | null>(null);
  const flushInFlightRef = useRef<Promise<PersistenceFlushHandlerResult> | null>(null);

  const loadActiveDrafts = useCallback(async () => {
    setDraftListState("loading");
    const result = await drafts.listActive();
    if (!result.ok) {
      setError(normalizeIdeationError(result.error));
      setDraftListState("error");
      return;
    }
    setActiveDrafts(result.value);
    setDraftListState(result.value.length === 0 ? "empty" : "ready");
  }, [drafts]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadActiveDrafts();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadActiveDrafts]);

  const snapshot = currentDraft?.toSnapshot() ?? null;
  const currentStep = snapshot?.steps.find((step) => step.key === snapshot.currentStep) ?? null;
  const dirty = currentStep !== null && editorValue !== currentStep.value;
  const pendingCount =
    snapshot?.steps.filter((step) => step.state === "pending").length ?? IDEATION_STEP_KEYS.length;

  useEffect(() => {
    currentDraftRef.current = currentDraft;
    currentStepRef.current = currentStep;
    editorValueRef.current = editorValue;
  }, [currentDraft, currentStep, editorValue]);

  const ideationService = service;

  function openDraft(draft: IdeationDraft): void {
    const nextSnapshot = draft.toSnapshot();
    const step =
      nextSnapshot.steps.find((candidate) => candidate.key === nextSnapshot.currentStep) ??
      nextSnapshot.steps[0];
    const nextValue = step?.value ?? "";
    currentDraftRef.current = draft;
    currentStepRef.current = step ?? null;
    editorValueRef.current = nextValue;
    setCurrentDraft(draft);
    setEditorValue(nextValue);
    setSuggestionVariant(0);
    setError(null);
    setNotice(null);
  }

  function updateEditorValue(value: string): void {
    editorValueRef.current = value;
    setEditorValue(value);
  }

  function replaceActiveDraft(draft: IdeationDraft): void {
    setActiveDrafts((current) => {
      const next = [draft, ...current.filter((candidate) => candidate.id !== draft.id)];
      return next.sort((left, right) =>
        right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt),
      );
    });
    setDraftListState("ready");
  }

  async function resumeDraft(draftId: string): Promise<void> {
    if (busy !== null) {
      return;
    }
    setBusy("resume");
    setError(null);
    const result = await ideationService.findById(draftId);
    setBusy(null);
    if (!result.ok) {
      setError(normalizeIdeationError(result.error));
      return;
    }
    if (result.value?.status !== "active") {
      setError({
        code: "IDEATION_DRAFT_NOT_FOUND",
        title: "草稿不可恢复",
        description: "该草稿已不存在或已经完成，请重新读取活跃草稿列表。",
        conflict: false,
      });
      return;
    }
    openDraft(result.value);
  }

  async function createGuided(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy !== null || guidedName.trim().length === 0) {
      return;
    }
    setBusy("create-guided");
    setError(null);
    const result = await ideationService.createGuided({ projectName: guidedName.trim() });
    setBusy(null);
    if (!result.ok) {
      setError(normalizeIdeationError(result.error));
      return;
    }
    setGuidedName("");
    replaceActiveDraft(result.value);
    openDraft(result.value);
  }

  async function createQuick(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy !== null) {
      return;
    }
    const targetWords = Number(quickForm.targetWords);
    if (
      quickForm.projectName.trim().length === 0 ||
      quickForm.idea.trim().length === 0 ||
      quickForm.genre.trim().length === 0 ||
      quickForm.protagonistType.trim().length === 0 ||
      !Number.isSafeInteger(targetWords) ||
      targetWords < 1_000 ||
      targetWords > 20_000_000
    ) {
      setError({
        code: "QUICK_IDEATION_INPUT_INVALID",
        title: "快速开书信息不完整",
        description: "请填写名称、创意、类型、主角类型，并把目标字数设为 1,000–20,000,000。",
        conflict: false,
      });
      return;
    }
    setBusy("create-quick");
    setError(null);
    const result = await ideationService.createQuick({
      projectName: quickForm.projectName.trim(),
      seed: {
        idea: quickForm.idea.trim(),
        genre: quickForm.genre.trim(),
        targetWords,
        protagonistType: quickForm.protagonistType.trim(),
        ...(quickForm.style.trim().length === 0 ? {} : { style: quickForm.style.trim() }),
      },
    });
    setBusy(null);
    if (!result.ok) {
      setError(normalizeIdeationError(result.error));
      return;
    }
    setQuickForm(EMPTY_QUICK_FORM);
    replaceActiveDraft(result.value);
    openDraft(result.value);
  }

  async function applyChange(
    change: ApplyIdeationChange,
    successNotice: string,
  ): Promise<IdeationDraft | null> {
    if (currentDraft === null || busy !== null) {
      return null;
    }
    const observedDraft = currentDraft;
    setBusy(`change:${change.kind}`);
    setError(null);
    setNotice(null);
    const operation = (async (): Promise<IdeationDraft | null> => {
      try {
        const result = await ideationService.apply({
          draftId: observedDraft.id,
          expectedRevision: observedDraft.revision,
          change,
        });
        if (!result.ok) {
          setError(normalizeIdeationError(result.error));
          return null;
        }
        replaceActiveDraft(result.value);
        openDraft(result.value);
        setNotice(successNotice);
        return result.value;
      } catch {
        setError({
          code: "IDEATION_PERSISTENCE_FAILED",
          title: "构思草稿保存失败",
          description: "本次保存未被报告为成功，请保持页面打开并重试。",
          conflict: false,
        });
        return null;
      } finally {
        setBusy(null);
      }
    })();
    const tracked = operation.then(() => undefined);
    ideationOperationRef.current = tracked;
    try {
      return await operation;
    } finally {
      if (ideationOperationRef.current === tracked) {
        ideationOperationRef.current = null;
      }
    }
  }

  async function goToStep(step: IdeationStepKey): Promise<void> {
    if (currentDraft === null || snapshot === null || step === snapshot.currentStep) {
      return;
    }
    if (dirty) {
      setError({
        code: "UNSAVED_IDEATION_TEXT",
        title: "当前文本尚未保存",
        description: "请先保存当前步骤，或恢复为已保存内容，再切换步骤。",
        conflict: false,
      });
      return;
    }
    await applyChange({ kind: "go_to_step", step }, `已切换到“${STEP_DETAILS[step].label}”。`);
  }

  async function saveCurrentStep(): Promise<void> {
    if (currentStep === null || currentStep.locked || editorValue.trim().length === 0) {
      return;
    }
    await applyChange(
      { kind: "update", step: currentStep.key, value: editorValue },
      "当前步骤已显式保存到本地草稿。",
    );
  }

  const flushIdeationPersistence = useCallback((): Promise<PersistenceFlushHandlerResult> => {
    if (flushInFlightRef.current !== null) {
      return flushInFlightRef.current;
    }

    const cycle = (async (): Promise<PersistenceFlushHandlerResult> => {
      if (readBooleanRef(composingRef)) {
        return Object.freeze({
          status: "blocked",
          code: "COMPOSITION_ACTIVE",
          message: "请先完成当前中文输入，再离开构思草稿。",
        });
      }

      let flushed = false;
      const activeOperation = ideationOperationRef.current;
      if (activeOperation !== null) {
        flushed = true;
        await activeOperation;
      }
      if (readBooleanRef(composingRef)) {
        return Object.freeze({
          status: "blocked",
          code: "COMPOSITION_ACTIVE",
          message: "请先完成当前中文输入，再离开构思草稿。",
        });
      }

      const draft = currentDraftRef.current;
      const step = currentStepRef.current;
      const value = editorValueRef.current;
      if (draft === null || step === null || value === step.value) {
        return Object.freeze({ status: "success", flushed });
      }
      if (step.locked || value.trim().length === 0) {
        const message = step.locked
          ? "锁定步骤不能写入未保存文本。"
          : "当前构思步骤为空，无法安全保存。";
        const cause = new Error(message);
        cause.name = "IdeationPersistenceBoundaryError";
        setError({
          code: "IDEATION_FLUSH_BLOCKED",
          title: "构思草稿尚未保存",
          description: message,
          conflict: false,
        });
        throw cause;
      }

      setBusy("change:update");
      let result;
      try {
        result = await ideationService.apply({
          draftId: draft.id,
          expectedRevision: draft.revision,
          change: { kind: "update", step: step.key, value },
        });
      } catch (cause: unknown) {
        setError({
          code: "IDEATION_PERSISTENCE_FAILED",
          title: "构思草稿保存失败",
          description: "本次保存未被报告为成功，请保持页面打开并重试。",
          conflict: false,
        });
        throw cause;
      }
      setBusy(null);
      if (!result.ok) {
        setError(normalizeIdeationError(result.error));
        throw result.error;
      }

      const nextDraft = result.value;
      const nextSnapshot = nextDraft.toSnapshot();
      const nextStep =
        nextSnapshot.steps.find((candidate) => candidate.key === nextSnapshot.currentStep) ??
        nextSnapshot.steps[0] ??
        null;
      const nextValue = nextStep?.value ?? "";
      currentDraftRef.current = nextDraft;
      currentStepRef.current = nextStep;
      editorValueRef.current = nextValue;
      setCurrentDraft(nextDraft);
      setEditorValue(nextValue);
      setActiveDrafts((current) => {
        const next = [nextDraft, ...current.filter((candidate) => candidate.id !== nextDraft.id)];
        return next.sort((left, right) =>
          right.toSnapshot().updatedAt.localeCompare(left.toSnapshot().updatedAt),
        );
      });
      setDraftListState("ready");
      setError(null);
      setNotice("离开前已将当前完整步骤保存到本地构思草稿。");
      return Object.freeze({ status: "success", flushed: true });
    })();
    flushInFlightRef.current = cycle;
    void cycle
      .finally(() => {
        if (flushInFlightRef.current === cycle) {
          flushInFlightRef.current = null;
        }
        setBusy(null);
      })
      .catch(() => {
        // The lifecycle coordinator observes the original failure.
      });
    return cycle;
  }, [ideationService]);

  useEffect(
    () =>
      desktopPersistenceLifecycle.register("ideation:current-step", {
        hasPendingWork: () => {
          const draft = currentDraftRef.current;
          const step = currentStepRef.current;
          return (
            composingRef.current ||
            ideationOperationRef.current !== null ||
            (draft !== null && step !== null && editorValueRef.current !== step.value)
          );
        },
        flush: () => flushIdeationPersistence(),
      }),
    [flushIdeationPersistence],
  );

  async function skipCurrentStep(): Promise<void> {
    if (currentStep === null || currentStep.locked) {
      return;
    }
    if (dirty && !window.confirm("跳过会丢弃当前未保存文本。确认明确跳过此步骤？")) {
      return;
    }
    await applyChange({ kind: "skip", step: currentStep.key }, "当前步骤已明确标记为跳过。");
  }

  async function toggleCurrentLock(): Promise<void> {
    if (currentStep === null || dirty) {
      return;
    }
    await applyChange(
      {
        kind: currentStep.locked ? "unlock" : "lock",
        step: currentStep.key,
      },
      currentStep.locked ? "当前答案已解锁，可以继续编辑。" : "当前答案已锁定。",
    );
  }

  async function generateSuggestion(): Promise<void> {
    if (currentDraft === null || currentStep === null || currentStep.locked || dirty) {
      if (dirty) {
        setError({
          code: "UNSAVED_IDEATION_TEXT",
          title: "当前文本尚未保存",
          description: "请先保存或恢复当前文本，再生成本地建议。",
          conflict: false,
        });
      }
      return;
    }
    const usedVariant = suggestionVariant;
    const suggestion = buildLocalIdeationSuggestion(currentDraft, currentStep.key, usedVariant);
    const updated = await applyChange(
      {
        kind: "offer_suggestion",
        step: currentStep.key,
        content: suggestion.content,
      },
      "已生成一条本地结构建议；尚未修改你的正式答案。",
    );
    if (updated !== null) {
      setSuggestionVariant(usedVariant + 1);
    }
  }

  async function resolveSuggestion(accept: boolean): Promise<void> {
    if (currentStep?.suggestion === null || currentStep?.suggestion === undefined || dirty) {
      return;
    }
    await applyChange(
      {
        kind: accept ? "accept_suggestion" : "reject_suggestion",
        step: currentStep.key,
        suggestionId: currentStep.suggestion.id,
      },
      accept ? "本地建议已由你接受并保存。" : "本地建议已拒绝，正式答案没有变化。",
    );
  }

  async function reloadCurrentDraft(): Promise<void> {
    if (currentDraft === null || busy !== null) {
      return;
    }
    setBusy("reload");
    const result = await ideationService.findById(currentDraft.id);
    setBusy(null);
    if (!result.ok) {
      setError(normalizeIdeationError(result.error));
      return;
    }
    if (result.value?.status !== "active") {
      setError({
        code: "IDEATION_DRAFT_NOT_FOUND",
        title: "草稿无法重新载入",
        description: "草稿已不存在或已完成，请返回草稿列表。",
        conflict: false,
      });
      return;
    }
    replaceActiveDraft(result.value);
    openDraft(result.value);
    setNotice("已显式重新读取最新草稿，未执行静默覆盖。");
  }

  async function finalizeDraft(): Promise<void> {
    if (currentDraft === null || pendingCount > 0 || dirty || busy !== null) {
      return;
    }
    const observedDraft = currentDraft;
    setBusy("finalize");
    setError(null);
    const result = await ideationService.finalize({
      draftId: observedDraft.id,
      expectedRevision: observedDraft.revision,
    });
    setBusy(null);
    if (!result.ok) {
      setError(normalizeIdeationError(result.error));
      return;
    }
    finishNavigation(result.value);
  }

  function finishNavigation(result: FinalizeIdeationResult): void {
    setActiveDrafts((current) => current.filter((draft) => draft.id !== result.draft.id));
    setCurrentDraft(null);
    void navigate(`/projects/${result.projectId}`);
  }

  function returnToDraftList(): void {
    if (dirty) {
      setError({
        code: "UNSAVED_IDEATION_TEXT",
        title: "当前文本尚未保存",
        description: "请先保存，或恢复为已保存内容，再返回草稿列表。",
        conflict: false,
      });
      return;
    }
    setCurrentDraft(null);
    setError(null);
    setNotice(null);
  }

  return (
    <div className="desktop-page ideation-page">
      <IdeationHeading />

      {!online && (
        <InlineAlert
          tone="info"
          title="离线手工构思仍可完整使用"
          description="九步草稿、锁定、跳过和本地结构建议都在当前设备完成；本页面不会等待模型或网络。"
        />
      )}
      {error !== null && (
        <InlineAlert
          tone="error"
          title={`${error.title}（${error.code}）`}
          description={error.description}
          {...(error.conflict && currentDraft !== null
            ? {
                action: {
                  label: "重新读取草稿",
                  onClick: () => void reloadCurrentDraft(),
                },
              }
            : {})}
          onDismiss={() => setError(null)}
          dismissLabel="关闭错误"
        />
      )}
      {notice !== null && (
        <InlineAlert
          tone="info"
          title="构思草稿已更新"
          description={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel="关闭通知"
        />
      )}

      {currentDraft === null || snapshot === null || currentStep === null ? (
        <IdeationLanding
          activeDrafts={activeDrafts}
          draftListState={draftListState}
          busy={busy}
          guidedName={guidedName}
          quickForm={quickForm}
          loadActiveDrafts={() => void loadActiveDrafts()}
          resumeDraft={(draftId) => void resumeDraft(draftId)}
          createGuided={(event) => void createGuided(event)}
          createQuick={(event) => void createQuick(event)}
          setGuidedName={setGuidedName}
          setQuickForm={setQuickForm}
        />
      ) : (
        <IdeationWorkspace
          snapshot={snapshot}
          currentDraft={currentDraft}
          currentStep={currentStep}
          editorValue={editorValue}
          dirty={dirty}
          pendingCount={pendingCount}
          busy={busy}
          onEditorChange={updateEditorValue}
          onEditorCompositionStart={() => {
            composingRef.current = true;
          }}
          onEditorCompositionEnd={(value) => {
            updateEditorValue(value);
            composingRef.current = false;
          }}
          onRestoreSaved={() => updateEditorValue(currentStep.value)}
          onGoToStep={(step) => void goToStep(step)}
          onSave={() => void saveCurrentStep()}
          onSkip={() => void skipCurrentStep()}
          onToggleLock={() => void toggleCurrentLock()}
          onGenerateSuggestion={() => void generateSuggestion()}
          onAcceptSuggestion={() => void resolveSuggestion(true)}
          onRejectSuggestion={() => void resolveSuggestion(false)}
          onFinalize={() => void finalizeDraft()}
          onReturn={returnToDraftList}
        />
      )}
    </div>
  );
}

function IdeationHeading() {
  return (
    <header className="page-heading ideation-page__heading">
      <div>
        <p className="page-heading__eyebrow">本地创作起点</p>
        <h1>开书与构思</h1>
        <p>先做九项可追溯的人类决定，再一次性创建项目、大纲骨架和开篇目标。</p>
      </div>
      <Badge tone="success">离线可用</Badge>
    </header>
  );
}

function IdeationLanding(props: {
  readonly activeDrafts: readonly IdeationDraft[];
  readonly draftListState: DraftListState;
  readonly busy: string | null;
  readonly guidedName: string;
  readonly quickForm: QuickForm;
  readonly loadActiveDrafts: () => void;
  readonly resumeDraft: (draftId: string) => void;
  readonly createGuided: (event: SyntheticEvent<HTMLFormElement>) => void;
  readonly createQuick: (event: SyntheticEvent<HTMLFormElement>) => void;
  readonly setGuidedName: (value: string) => void;
  readonly setQuickForm: (value: QuickForm) => void;
}) {
  const targetWords = Number(props.quickForm.targetWords);
  const quickFormInvalid =
    props.quickForm.projectName.trim().length === 0 ||
    props.quickForm.genre.trim().length === 0 ||
    props.quickForm.protagonistType.trim().length === 0 ||
    props.quickForm.idea.trim().length === 0 ||
    !Number.isSafeInteger(targetWords) ||
    targetWords < 1_000 ||
    targetWords > 20_000_000;

  return (
    <div className="ideation-page__landing">
      <section className="ideation-page__drafts" aria-labelledby="active-ideation-drafts">
        <div className="ideation-page__section-heading">
          <div>
            <h2 id="active-ideation-drafts">活跃构思草稿</h2>
            <p>恢复时会重新读取最新修订，不会用列表快照静默覆盖。</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={props.busy !== null}
            onClick={props.loadActiveDrafts}
          >
            重新读取
          </Button>
        </div>
        <PageStateBoundary
          state={
            props.draftListState === "error"
              ? "fatal_error"
              : props.draftListState === "empty"
                ? "empty"
                : props.draftListState
          }
          preserveContent={false}
          loadingLabel="正在读取本地构思草稿"
          fallbacks={{
            empty: (
              <EmptyState
                title="还没有活跃草稿"
                description="使用引导模式逐步开始，或用快速开书表单预填四个步骤。"
              />
            ),
            fatal_error: (
              <ErrorState
                title="无法读取构思草稿"
                description="本地仓库返回错误；请重试，不会伪造空列表。"
                primaryAction={{ label: "重试", onClick: props.loadActiveDrafts }}
              />
            ),
          }}
        >
          <div className="ideation-page__draft-grid">
            {props.activeDrafts.map((draft) => {
              const snapshot = draft.toSnapshot();
              const resolved = snapshot.steps.filter((step) => step.state !== "pending").length;
              return (
                <Card key={draft.id}>
                  <CardHeader>
                    <div className="card-heading-row">
                      <CardTitle>{snapshot.projectName}</CardTitle>
                      <Badge tone="info">{snapshot.mode === "quick" ? "快速" : "引导"}</Badge>
                    </div>
                    <CardDescription>
                      已决定或跳过 {resolved} / {IDEATION_STEP_KEYS.length} 步
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p className="ideation-page__draft-meta">
                      当前：{STEP_DETAILS[snapshot.currentStep].label} · 修订 {snapshot.revision}
                    </p>
                    <progress
                      max={IDEATION_STEP_KEYS.length}
                      value={resolved}
                      aria-label={`${snapshot.projectName} 构思进度`}
                    />
                  </CardContent>
                  <CardFooter>
                    <Button
                      size="sm"
                      loading={props.busy === "resume"}
                      disabled={props.busy !== null}
                      onClick={() => props.resumeDraft(draft.id)}
                    >
                      恢复草稿
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        </PageStateBoundary>
      </section>

      <div className="ideation-page__creation-grid">
        <Card>
          <CardHeader>
            <CardTitle headingLevel={2}>引导开书</CardTitle>
            <CardDescription>创建一份全空白九步草稿，由你逐项决定或明确跳过。</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="ideation-page__form" onSubmit={props.createGuided}>
              <FormField label="项目名称" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={props.guidedName}
                    required
                    maxLength={120}
                    disabled={props.busy !== null}
                    onChange={(event) => props.setGuidedName(event.currentTarget.value)}
                  />
                )}
              </FormField>
              <Button
                type="submit"
                loading={props.busy === "create-guided"}
                disabled={props.busy !== null || props.guidedName.trim().length === 0}
              >
                开始九步引导
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle headingLevel={2}>快速开书</CardTitle>
            <CardDescription>
              只映射你明确填写的内容；其余步骤仍保持待处理，必须后续完成或跳过。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="ideation-page__form" onSubmit={props.createQuick}>
              <div className="ideation-page__quick-grid">
                <QuickField
                  label="项目名称"
                  value={props.quickForm.projectName}
                  required
                  disabled={props.busy !== null}
                  onChange={(projectName) =>
                    props.setQuickForm({ ...props.quickForm, projectName })
                  }
                />
                <QuickField
                  label="类型"
                  value={props.quickForm.genre}
                  required
                  disabled={props.busy !== null}
                  onChange={(genre) => props.setQuickForm({ ...props.quickForm, genre })}
                />
                <QuickField
                  label="主角类型"
                  value={props.quickForm.protagonistType}
                  required
                  disabled={props.busy !== null}
                  onChange={(protagonistType) =>
                    props.setQuickForm({ ...props.quickForm, protagonistType })
                  }
                />
                <FormField label="目标字数" required>
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      type="number"
                      min={1_000}
                      max={20_000_000}
                      step={1_000}
                      value={props.quickForm.targetWords}
                      required
                      disabled={props.busy !== null}
                      onChange={(event) =>
                        props.setQuickForm({
                          ...props.quickForm,
                          targetWords: event.currentTarget.value,
                        })
                      }
                    />
                  )}
                </FormField>
                <div className="ideation-page__quick-wide">
                  <FormField label="一句话创意" required>
                    {(fieldProps) => (
                      <Textarea
                        {...fieldProps}
                        value={props.quickForm.idea}
                        required
                        maxLength={4_000}
                        currentLength={props.quickForm.idea.length}
                        disabled={props.busy !== null}
                        onChange={(event) =>
                          props.setQuickForm({
                            ...props.quickForm,
                            idea: event.currentTarget.value,
                          })
                        }
                      />
                    )}
                  </FormField>
                </div>
                <div className="ideation-page__quick-wide">
                  <QuickField
                    label="风格"
                    value={props.quickForm.style}
                    disabled={props.busy !== null}
                    onChange={(style) => props.setQuickForm({ ...props.quickForm, style })}
                  />
                </div>
              </div>
              <Button
                type="submit"
                loading={props.busy === "create-quick"}
                disabled={props.busy !== null || quickFormInvalid}
              >
                创建快速草稿
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function QuickField(props: {
  readonly label: string;
  readonly value: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <FormField label={props.label} required={props.required === true}>
      {(fieldProps) => (
        <Input
          {...fieldProps}
          value={props.value}
          required={props.required === true}
          disabled={props.disabled === true}
          maxLength={4_000}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        />
      )}
    </FormField>
  );
}

function IdeationWorkspace(props: {
  readonly snapshot: ReturnType<IdeationDraft["toSnapshot"]>;
  readonly currentDraft: IdeationDraft;
  readonly currentStep: IdeationStepSnapshot;
  readonly editorValue: string;
  readonly dirty: boolean;
  readonly pendingCount: number;
  readonly busy: string | null;
  readonly onEditorChange: (value: string) => void;
  readonly onEditorCompositionStart: () => void;
  readonly onEditorCompositionEnd: (value: string) => void;
  readonly onRestoreSaved: () => void;
  readonly onGoToStep: (step: IdeationStepKey) => void;
  readonly onSave: () => void;
  readonly onSkip: () => void;
  readonly onToggleLock: () => void;
  readonly onGenerateSuggestion: () => void;
  readonly onAcceptSuggestion: () => void;
  readonly onRejectSuggestion: () => void;
  readonly onFinalize: () => void;
  readonly onReturn: () => void;
}) {
  const currentIndex = IDEATION_STEP_KEYS.indexOf(props.snapshot.currentStep);
  const previous = currentIndex > 0 ? IDEATION_STEP_KEYS[currentIndex - 1] : undefined;
  const next =
    currentIndex < IDEATION_STEP_KEYS.length - 1 ? IDEATION_STEP_KEYS[currentIndex + 1] : undefined;
  const resolved = IDEATION_STEP_KEYS.length - props.pendingCount;
  const details = STEP_DETAILS[props.currentStep.key];

  return (
    <div className="ideation-workspace">
      <div className="ideation-workspace__topline">
        <Button variant="ghost" size="sm" onClick={props.onReturn}>
          返回草稿列表
        </Button>
        <div>
          <strong>{props.snapshot.projectName}</strong>
          <span>
            修订 {props.snapshot.revision} · 已处理 {resolved} / {IDEATION_STEP_KEYS.length}
          </span>
        </div>
      </div>

      <nav className="ideation-progress" aria-label="固定九步构思进度">
        <ol>
          {props.snapshot.steps.map((step, index) => (
            <li key={step.key}>
              <button
                type="button"
                data-current={step.key === props.currentStep.key || undefined}
                data-state={step.state}
                disabled={props.busy !== null}
                onClick={() => props.onGoToStep(step.key)}
              >
                <span>{index + 1}</span>
                <strong>{STEP_DETAILS[step.key].label}</strong>
                <small>{stepStateLabel(step)}</small>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div className="ideation-workspace__content">
        <Card className="ideation-step-card">
          <CardHeader>
            <div className="ideation-page__section-heading">
              <div>
                <p className="ideation-step-card__number">
                  第 {currentIndex + 1} / {IDEATION_STEP_KEYS.length} 步
                </p>
                <CardTitle headingLevel={2}>{details.label}</CardTitle>
                <CardDescription>{details.prompt}</CardDescription>
              </div>
              <div className="ideation-step-card__badges">
                <Badge tone={stepTone(props.currentStep)}>
                  {stepStateLabel(props.currentStep)}
                </Badge>
                {props.currentStep.locked && <Badge tone="warning">已锁定</Badge>}
              </div>
            </div>
          </CardHeader>
          <CardContent className="ideation-page__form">
            <FormField
              label="你的决定"
              hint={
                props.currentStep.locked
                  ? "锁定项不可编辑或生成建议；请先显式解锁。"
                  : "平时请显式保存；离开或关闭前会尝试有界保存完整输入，失败时将阻止离开。"
              }
              required={props.currentStep.state !== "skipped"}
            >
              {(fieldProps) => (
                <Textarea
                  {...fieldProps}
                  value={props.editorValue}
                  placeholder={details.placeholder}
                  maxLength={4_000}
                  currentLength={props.editorValue.length}
                  readOnly={props.currentStep.locked}
                  disabled={props.busy !== null}
                  onChange={(event) => props.onEditorChange(event.currentTarget.value)}
                  onCompositionStart={props.onEditorCompositionStart}
                  onCompositionEnd={(event) =>
                    props.onEditorCompositionEnd(event.currentTarget.value)
                  }
                />
              )}
            </FormField>
            {props.dirty && (
              <InlineAlert
                tone="warning"
                title="有未保存文本"
                description="切换步骤和最终创建已阻止。请保存，或恢复为上次保存内容。"
                action={{ label: "恢复已保存内容", onClick: props.onRestoreSaved }}
              />
            )}
            <div className="ideation-step-card__actions">
              <Button
                loading={props.busy === "change:update"}
                disabled={
                  props.busy !== null ||
                  props.currentStep.locked ||
                  props.editorValue.trim().length === 0 ||
                  !props.dirty
                }
                onClick={props.onSave}
              >
                保存当前步骤
              </Button>
              <Button
                variant="secondary"
                loading={props.busy === "change:skip"}
                disabled={props.busy !== null || props.currentStep.locked}
                onClick={props.onSkip}
              >
                明确跳过
              </Button>
              <Button
                variant="ghost"
                loading={props.busy === "change:lock" || props.busy === "change:unlock"}
                disabled={
                  props.busy !== null ||
                  props.dirty ||
                  (!props.currentStep.locked && props.currentStep.state !== "completed")
                }
                onClick={props.onToggleLock}
              >
                {props.currentStep.locked ? "解锁答案" : "锁定答案"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="ideation-suggestion-card">
          <CardHeader>
            <div className="card-heading-row">
              <CardTitle headingLevel={2}>本地结构建议</CardTitle>
              <Badge tone="neutral">未调用模型</Badge>
            </div>
            <CardDescription>
              建议由固定本地模板根据已保存答案生成；不会联网，也不会直接改写正式答案。
            </CardDescription>
          </CardHeader>
          <CardContent className="ideation-page__form">
            {props.currentStep.suggestion === null ? (
              <EmptyState
                title={props.currentStep.locked ? "锁定项不生成建议" : "尚未生成本地建议"}
                description={
                  props.currentStep.locked
                    ? "先显式解锁，才能为该步骤生成新的结构建议。"
                    : "生成后仍需你明确接受或拒绝。"
                }
              />
            ) : (
              <blockquote className="ideation-suggestion-card__content">
                {props.currentStep.suggestion.content}
              </blockquote>
            )}
          </CardContent>
          <CardFooter>
            <Button
              variant="secondary"
              loading={props.busy === "change:offer_suggestion"}
              disabled={props.busy !== null || props.currentStep.locked || props.dirty}
              title={
                props.currentStep.locked
                  ? "锁定项不可生成建议"
                  : props.dirty
                    ? "请先处理未保存文本"
                    : undefined
              }
              onClick={props.onGenerateSuggestion}
            >
              {props.currentStep.suggestion === null ? "生成本地建议" : "再生成"}
            </Button>
            {props.currentStep.suggestion !== null && (
              <>
                <Button
                  loading={props.busy === "change:accept_suggestion"}
                  disabled={props.busy !== null || props.dirty}
                  onClick={props.onAcceptSuggestion}
                >
                  接受并保存
                </Button>
                <Button
                  variant="ghost"
                  loading={props.busy === "change:reject_suggestion"}
                  disabled={props.busy !== null || props.dirty}
                  onClick={props.onRejectSuggestion}
                >
                  拒绝
                </Button>
              </>
            )}
          </CardFooter>
        </Card>
      </div>

      <footer className="ideation-workspace__footer">
        <div className="ideation-workspace__navigation">
          <Button
            variant="secondary"
            disabled={previous === undefined || props.busy !== null}
            onClick={() => previous !== undefined && props.onGoToStep(previous)}
          >
            上一步
          </Button>
          <Button
            variant="secondary"
            disabled={next === undefined || props.busy !== null}
            onClick={() => next !== undefined && props.onGoToStep(next)}
          >
            下一步
          </Button>
        </div>
        <div className="ideation-workspace__finalize">
          <div>
            <strong>原子创建项目</strong>
            <span>
              {props.pendingCount === 0
                ? "九步均已完成或明确跳过，可以创建。"
                : `还有 ${String(props.pendingCount)} 个待处理步骤，创建保持禁用。`}
            </span>
          </div>
          <Button
            loading={props.busy === "finalize"}
            disabled={props.busy !== null || props.pendingCount > 0 || props.dirty}
            onClick={props.onFinalize}
          >
            创建项目并打开
          </Button>
        </div>
      </footer>
    </div>
  );
}

function readBooleanRef(reference: { readonly current: boolean }): boolean {
  return reference.current;
}

function stepStateLabel(step: IdeationStepSnapshot): string {
  if (step.locked) {
    return "已完成 · 锁定";
  }
  switch (step.state) {
    case "pending":
      return "待决定";
    case "completed":
      return "已完成";
    case "skipped":
      return "已跳过";
  }
}

function stepTone(step: IdeationStepSnapshot): "neutral" | "success" | "warning" {
  switch (step.state) {
    case "pending":
      return "warning";
    case "completed":
      return "success";
    case "skipped":
      return "neutral";
  }
}

function normalizeIdeationError(error: StoryCoreError): VisibleIdeationError {
  switch (error.code) {
    case "STORY_REVISION_CONFLICT":
      return {
        code: error.code,
        title: "草稿修订冲突",
        description: "草稿已在其他操作中变化。请显式重新读取并比较，页面不会静默覆盖。",
        conflict: true,
      };
    case "IDEATION_STEP_LOCKED":
      return {
        code: error.code,
        title: "当前步骤已锁定",
        description: "锁定答案不能编辑、跳过或重新生成建议；请先显式解锁。",
        conflict: false,
      };
    case "HUMAN_DECISION_REQUIRED":
      return {
        code: error.code,
        title: "仍有人类决定未完成",
        description: "只有全部步骤完成或明确跳过后，才能原子创建项目。",
        conflict: false,
      };
    case "IDEATION_SUGGESTION_NOT_FOUND":
      return {
        code: error.code,
        title: "建议已不是最新版本",
        description: "请重新读取草稿或再次生成本地建议。",
        conflict: true,
      };
    case "STORY_VALIDATION_FAILED":
      return {
        code: error.code,
        title: "构思内容未通过校验",
        description: "请检查必填内容、长度、目标字数和输入格式。",
        conflict: false,
      };
    case "IDEATION_DRAFT_NOT_FOUND":
      return {
        code: error.code,
        title: "构思草稿不存在",
        description: "草稿可能已在其他窗口完成或移除，请重新读取活跃列表。",
        conflict: false,
      };
    default:
      return {
        code: error.code,
        title: "构思操作未完成",
        description: error.retryable
          ? "本地操作暂时未完成，请重试。"
          : "本地服务拒绝了此状态变化；原始内部错误不会直接显示。",
        conflict: false,
      };
  }
}
