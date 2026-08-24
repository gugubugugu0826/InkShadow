import { useCallback, useEffect, useMemo, useState } from "react";
import type { Outline } from "@inkshadow/story-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  FormField,
  InlineAlert,
  Select,
  Textarea,
} from "@inkshadow/ui";

import type {
  ModelHubStoryPlanningService,
  StoryPlanningDisclosure,
} from "../infrastructure/model-hub-story-planning-service";
import type {
  StoryPlanningCandidate,
  StoryPlanningTask,
} from "../infrastructure/story-planning-candidate-store";
import { listStoryPlanningSelectableItems } from "../infrastructure/story-planning-selective-acceptance";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import {
  recordSafeOperationIncident,
  type SafeOperationStage,
} from "../infrastructure/safe-operation-diagnostics";
import {
  fitCandidateDecisionTextarea,
  handleCandidateDecisionNavigation,
} from "./candidate-decision-navigation";

export interface StoryPlanningPanelProps {
  readonly projectId: string;
  readonly outline: Outline;
  readonly service: Pick<
    ModelHubStoryPlanningService,
    | "listCandidates"
    | "prepareGeneration"
    | "generate"
    | "updateCandidate"
    | "acceptCandidate"
    | "acceptCandidateItems"
    | "rejectCandidate"
  >;
  readonly disabled?: boolean;
  readonly onOutlineChanged: () => void | Promise<void>;
}

interface PlanningPanelMessage {
  readonly title: string;
  readonly message: string;
  readonly supportId?: string;
}

export function StoryPlanningPanel({
  disabled = false,
  onOutlineChanged,
  outline,
  projectId,
  service,
}: StoryPlanningPanelProps) {
  const outlineSnapshot = useMemo(() => outline.toSnapshot(), [outline]);
  const chapters = useMemo(
    () => outlineSnapshot.nodes.filter(({ kind }) => kind === "chapter"),
    [outlineSnapshot],
  );
  const [task, setTask] = useState<StoryPlanningTask>("outline_planning");
  const [targetNodeId, setTargetNodeId] = useState(chapters[0]?.id ?? "");
  const [direction, setDirection] = useState("");
  const [candidates, setCandidates] = useState<readonly StoryPlanningCandidate[]>([]);
  const [editable, setEditable] = useState<Record<string, string>>({});
  const [selectedItems, setSelectedItems] = useState<Record<string, readonly string[]>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<PlanningPanelMessage | null>(null);
  const [notice, setNotice] = useState<PlanningPanelMessage | null>(null);
  const [disclosure, setDisclosure] = useState<StoryPlanningDisclosure | null>(null);
  const resolvedTargetNodeId = chapters.some(({ id }) => id === targetNodeId)
    ? targetNodeId
    : (chapters[0]?.id ?? "");

  const loadCandidates = useCallback(async () => {
    try {
      const loaded = await service.listCandidates(projectId, 20);
      setCandidates(loaded);
      setEditable((current) => {
        const next = { ...current };
        for (const candidate of loaded) {
          next[candidate.id] ??= candidate.editableSynopsis;
        }
        return next;
      });
      setSelectedItems((current) => {
        const next = { ...current };
        for (const candidate of loaded) {
          const intent = candidate.selectiveAcceptanceIntent;
          if (intent !== null && intent !== undefined) {
            next[candidate.id] = intent.selectedItemIds;
          }
        }
        return next;
      });
    } catch (cause: unknown) {
      setError(
        planningFailureMessage(cause, {
          projectId,
          task: "outline_planning",
          stage: "read_local_state",
          fallback: "无法读取以前的规划建议。",
          dispatched: false,
        }),
      );
    }
  }, [projectId, service]);

  useEffect(() => {
    void Promise.resolve().then(loadCandidates);
  }, [loadCandidates]);

  async function generate(): Promise<void> {
    if (disabled || busyAction !== null) {
      return;
    }
    if (task === "scene_breakdown" && resolvedTargetNodeId.length === 0) {
      setError({ title: "还不能拆解场景", message: "请先在大纲中添加并选择一个章节。" });
      return;
    }
    setBusyAction("generate");
    const preparingDisclosure = disclosure === null;
    setError(null);
    setNotice(null);
    try {
      const request = {
        projectId,
        task,
        ...(task === "scene_breakdown" ? { targetNodeId: resolvedTargetNodeId } : {}),
        ...(direction.trim().length === 0 ? {} : { userDirection: direction }),
      } as const;
      if (disclosure === null) {
        setDisclosure(await service.prepareGeneration(request));
        setNotice({
          title: "发送信息已准备好",
          message: "确认前不会向 AI 发送内容。请核对后再继续。",
        });
        return;
      }
      const outcome = await service.generate({
        ...request,
        disclosureFingerprint: disclosure.fingerprint,
        humanConfirmed: true,
      });
      setDisclosure(null);
      if (outcome.status === "skipped") {
        const incident = recordSafeOperationIncident({
          operation: "story_planning",
          stage: "pre_dispatch_check",
          cause: Object.assign(new Error("story planning skipped before dispatch"), {
            code: outcome.code,
          }),
          projectId,
          dispatched: false,
        });
        setNotice({
          title: "本次没有调用 AI",
          message: outcome.message,
          supportId: incident.supportId,
        });
        return;
      }
      setCandidates((current) => Object.freeze([outcome.candidate, ...current]));
      setEditable((current) => ({
        ...current,
        [outcome.candidate.id]: outcome.candidate.editableSynopsis,
      }));
      setNotice({
        title: "已生成待审阅建议",
        message: "正式大纲和正文都没有改变。你可以先编辑，再明确采纳或拒绝。",
      });
    } catch (cause: unknown) {
      setDisclosure(null);
      const dispatched = preparingDisclosure ? false : planningDispatchState(cause);
      const failureStage = preparingDisclosure
        ? "prepare_disclosure"
        : planningFailureStage(cause, dispatched);
      setError(
        planningFailureMessage(cause, {
          projectId,
          task,
          stage: failureStage,
          fallback: "规划建议生成失败；正式大纲和正文没有改变。",
          dispatched,
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function save(candidate: StoryPlanningCandidate): Promise<void> {
    const nextText = editable[candidate.id] ?? candidate.editableSynopsis;
    setBusyAction(`save:${candidate.id}`);
    setError(null);
    try {
      const updated = await service.updateCandidate({
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
        editableSynopsis: nextText,
      });
      replaceCandidate(updated);
      setNotice({ title: "修改已保存", message: "这里只更新建议版本，正式大纲尚未改变。" });
    } catch (cause: unknown) {
      setError(
        planningFailureMessage(cause, {
          projectId,
          task: candidate.task,
          stage: "persist_result",
          fallback: "无法保存这份规划建议。",
          dispatched: false,
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function accept(candidate: StoryPlanningCandidate): Promise<void> {
    setBusyAction(`accept:${candidate.id}`);
    setError(null);
    try {
      const receipt = await service.acceptCandidate({
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
      });
      replaceCandidate(receipt.candidate);
      await onOutlineChanged();
      setNotice({
        title: "建议已采纳",
        message: receipt.recoveredAfterInterruptedRecording
          ? "已恢复上次中断的采纳记录，没有重复改写大纲。"
          : "仅更新了目标节点的简介；正文、人物设定和世界规则都没有被修改。",
      });
    } catch (cause: unknown) {
      setError(
        planningFailureMessage(cause, {
          projectId,
          task: candidate.task,
          stage: "persist_result",
          fallback: "无法安全采纳这份建议。",
          dispatched: false,
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function acceptSelected(candidate: StoryPlanningCandidate): Promise<void> {
    const selectedItemIds = selectedItems[candidate.id] ?? [];
    if (selectedItemIds.length === 0) {
      setError({ title: "还不能采纳", message: "请至少勾选一项要采纳的规划内容。" });
      return;
    }
    setBusyAction(`partial:${candidate.id}`);
    setError(null);
    try {
      const receipt = await service.acceptCandidateItems({
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
        selectedItemIds,
      });
      replaceCandidate(receipt.candidate);
      await onOutlineChanged();
      setNotice({
        title: receipt.idempotent ? "已确认此前的逐项采纳" : "已采纳所选规划条目",
        message: receipt.recoveredAfterInterruptedRecording
          ? "已恢复上次中断的采纳记录，没有重复追加内容。"
          : `已保留原有简介，并追加 ${String(receipt.acceptedItemIds.length)} 项结构化规划内容；未选内容、正文和故事设定均未修改。`,
      });
    } catch (cause: unknown) {
      setError(
        planningFailureMessage(cause, {
          projectId,
          task: candidate.task,
          stage: "persist_result",
          fallback: "无法安全采纳所选规划条目。",
          dispatched: false,
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function reject(candidate: StoryPlanningCandidate): Promise<void> {
    setBusyAction(`reject:${candidate.id}`);
    setError(null);
    try {
      replaceCandidate(
        await service.rejectCandidate({
          candidateId: candidate.id,
          expectedRevision: candidate.revision,
        }),
      );
      setNotice({ title: "建议已拒绝", message: "正式大纲和正文没有改变。" });
    } catch (cause: unknown) {
      setError(
        planningFailureMessage(cause, {
          projectId,
          task: candidate.task,
          stage: "persist_result",
          fallback: "无法记录拒绝结果。",
          dispatched: false,
        }),
      );
    } finally {
      setBusyAction(null);
    }
  }

  function replaceCandidate(next: StoryPlanningCandidate): void {
    setCandidates((current) =>
      Object.freeze(current.map((candidate) => (candidate.id === next.id ? next : candidate))),
    );
    setEditable((current) => ({ ...current, [next.id]: next.editableSynopsis }));
  }

  return (
    <section aria-labelledby="story-planning-assistant-title">
      <Card>
        <CardHeader>
          <div className="card-heading-row">
            <div>
              <CardTitle id="story-planning-assistant-title">AI 剧情规划</CardTitle>
              <p>读取当前大纲、已确认设定和有原文证据的主线事件，只生成待审阅建议。</p>
            </div>
            <Badge tone="info">不会自动改正文</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <FormField label="这次想规划什么" required>
            {(fieldProps) => (
              <Select
                {...fieldProps}
                value={task}
                disabled={disabled || busyAction !== null}
                options={[
                  { value: "outline_planning", label: "规划全书故事方向" },
                  { value: "scene_breakdown", label: "拆解一个章节的场景" },
                ]}
                onChange={(event) => {
                  setTask(event.currentTarget.value as StoryPlanningTask);
                  setDisclosure(null);
                }}
              />
            )}
          </FormField>

          {task === "scene_breakdown" && (
            <FormField label="要拆解的章节" required>
              {(fieldProps) => (
                <Select
                  {...fieldProps}
                  value={resolvedTargetNodeId}
                  placeholder={chapters.length === 0 ? "请先添加章节" : "选择章节"}
                  disabled={disabled || busyAction !== null || chapters.length === 0}
                  options={chapters.map((chapter) => ({
                    value: chapter.id,
                    label: chapter.title,
                  }))}
                  onChange={(event) => {
                    setTargetNodeId(event.currentTarget.value);
                    setDisclosure(null);
                  }}
                />
              )}
            </FormField>
          )}

          <FormField
            label="你希望接下来怎么发展（可选）"
            hint="可以留空，让 AI 依据当前大纲提出方案。"
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                value={direction}
                maxLength={2_000}
                currentLength={direction.length}
                rows={4}
                disabled={disabled || busyAction !== null}
                placeholder="例如：下一卷让男女主因为误会短暂分开，但不要新增超自然设定。"
                onChange={(event) => {
                  setDirection(event.currentTarget.value);
                  setDisclosure(null);
                }}
              />
            )}
          </FormField>

          {disclosure !== null && (
            <InlineAlert
              tone="warning"
              title="确认后会发送 1 次"
              description={`${disclosure.connectionDisplayName} · ${disclosure.modelId}；${disclosure.privacy} 发送内容：${disclosure.sends.join("；")}。自动重试 0 次；${formatPlanningCost(disclosure)}。`}
              onDismiss={() => setDisclosure(null)}
            />
          )}
          <Button
            loading={busyAction === "generate"}
            disabled={
              disabled ||
              busyAction !== null ||
              (task === "scene_breakdown" && chapters.length === 0)
            }
            onClick={() => void generate()}
          >
            {disclosure === null
              ? task === "outline_planning"
                ? "查看故事方向发送信息"
                : "查看场景拆解发送信息"
              : task === "outline_planning"
                ? "确认并生成故事方向建议"
                : "确认并生成场景拆解建议"}
          </Button>
          {disclosure !== null && (
            <Button
              variant="ghost"
              disabled={busyAction !== null}
              onClick={() => setDisclosure(null)}
            >
              取消，不发送
            </Button>
          )}

          {notice !== null && (
            <InlineAlert
              tone="info"
              title={notice.title}
              description={
                <>
                  <span>{notice.message}</span>
                  {notice.supportId !== undefined && <span> 支持编号：{notice.supportId}</span>}
                </>
              }
              onDismiss={() => setNotice(null)}
            />
          )}
          {error !== null && (
            <InlineAlert
              tone="error"
              title={error.title}
              description={
                <>
                  <span>{error.message}</span>
                  {error.supportId !== undefined && <span> 支持编号：{error.supportId}</span>}
                </>
              }
              onDismiss={() => setError(null)}
            />
          )}
        </CardContent>
      </Card>

      {candidates.length > 0 && (
        <div className="outline-volume-list" aria-label="AI 剧情规划建议版本">
          {candidates.map((candidate) => {
            const text = editable[candidate.id] ?? candidate.editableSynopsis;
            const dirty = text !== candidate.editableSynopsis;
            const candidateBusy = busyAction?.endsWith(candidate.id) === true;
            const selectableItems = listStoryPlanningSelectableItems(candidate.payload);
            const selected = selectedItems[candidate.id] ?? [];
            const currentTarget = outlineSnapshot.nodes.find(
              ({ id }) => id === candidate.targetNodeId,
            );
            const hasBaseline =
              candidate.baselineTargetSynopsis !== null &&
              candidate.baselineTargetSynopsis !== undefined;
            const selectiveAcceptanceApplying =
              candidate.status === "review" &&
              candidate.selectiveAcceptanceIntent !== null &&
              candidate.selectiveAcceptanceIntent !== undefined;
            return (
              <Card
                key={candidate.id}
                className={candidate.status === "review" ? "candidate-decision-surface" : undefined}
                aria-label={`${candidate.targetNodeTitle}的规划建议草稿决策`}
              >
                <CardHeader>
                  <div className="card-heading-row">
                    <div>
                      <CardTitle>
                        {candidate.task === "outline_planning" ? "故事方向建议" : "场景拆解建议"}：
                        {candidate.targetNodeTitle}
                      </CardTitle>
                      <p>
                        使用模型 {candidate.modelId}
                        {candidate.usedFallback ? "（备用模型）" : ""} ·
                        本次模型结果已记录，可在模型使用与费用中核对
                      </p>
                    </div>
                    <Badge tone={candidateStatusTone(candidate.status)}>
                      {selectiveAcceptanceApplying
                        ? "正在恢复逐项采纳"
                        : candidateStatusLabel(candidate.status)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent
                  tabIndex={candidate.status === "review" ? 0 : undefined}
                  aria-label={`${candidate.targetNodeTitle}的规划建议草稿内容`}
                  onKeyDown={handleCandidateDecisionNavigation}
                >
                  {selectiveAcceptanceApplying && (
                    <InlineAlert
                      tone="info"
                      title="上次逐项采纳尚未完成"
                      description="系统已锁定同一组规划条目。只能继续恢复这次采纳；在完成前不能编辑、整篇采纳或拒绝，避免正式大纲与建议草稿状态互相冲突。"
                    />
                  )}
                  <p>
                    本次参考 {String(candidate.context.formalFactIds.length)} 条已确认设定（其中
                    {String(candidate.context.lockedFactIds.length)} 条已锁定）、
                    {String(candidate.context.causalEventIds.length)} 个有证据的主线事件。
                    {candidate.context.causalGraphStatus === "unavailable"
                      ? "故事关联资料当前不可用，生成时已明确省略。"
                      : ""}
                  </p>
                  <div className="story-planning-diff" aria-label="当前大纲与规划建议草稿差异">
                    <div>
                      <strong>当前正式简介</strong>
                      <p className="story-planning-diff-text">
                        {currentTarget === undefined || currentTarget.synopsis.length === 0
                          ? "（当前简介为空）"
                          : currentTarget.synopsis}
                      </p>
                    </div>
                    <div>
                      <strong>规划建议草稿中的结构化变更</strong>
                      <p>
                        逐项采纳只会把你勾选的固定条目追加到生成时的简介；不会让 AI
                        重新解析旧文本，未选内容保持原样。
                      </p>
                      {hasBaseline ? (
                        <div className="story-planning-selectable-items">
                          {selectableItems.map((item) => {
                            const accepted = candidate.acceptedItemIds?.includes(item.id) === true;
                            const checked =
                              candidate.status === "accepted"
                                ? accepted
                                : selected.includes(item.id);
                            return (
                              <label
                                key={item.id}
                                className="checkbox-row"
                                htmlFor={`${candidate.id}-${item.id}`}
                                aria-label={`选择${item.label}`}
                              >
                                <input
                                  id={`${candidate.id}-${item.id}`}
                                  type="checkbox"
                                  checked={checked}
                                  disabled={
                                    disabled ||
                                    candidateBusy ||
                                    candidate.status !== "review" ||
                                    selectiveAcceptanceApplying
                                  }
                                  onChange={(event) => {
                                    const isChecked = event.currentTarget.checked;
                                    setSelectedItems((current) => {
                                      const before = current[candidate.id] ?? [];
                                      return {
                                        ...current,
                                        [candidate.id]: isChecked
                                          ? Object.freeze([...before, item.id])
                                          : Object.freeze(before.filter((id) => id !== item.id)),
                                      };
                                    });
                                  }}
                                />
                                <span>
                                  <strong>{item.label}</strong>
                                  <small>{item.detail}</small>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <InlineAlert
                          tone="warning"
                          title="旧版建议不能逐项采纳"
                          description="这份建议没有保存可核验的目标简介基线。请重新生成后使用逐项采纳；仍可在下方编辑、整体采纳或拒绝。"
                        />
                      )}
                    </div>
                  </div>
                  <FormField
                    label={`整体替换“${candidate.targetNodeTitle}”简介的规划建议草稿内容`}
                    hint="这里的手动编辑只用于整体采纳，不会改变上方可勾选的固定条目。采纳前不会触碰正式大纲。"
                  >
                    {(fieldProps) => (
                      <Textarea
                        {...fieldProps}
                        ref={fitCandidateDecisionTextarea}
                        value={text}
                        rows={12}
                        maxLength={20_000}
                        currentLength={text.length}
                        readOnly={candidate.status !== "review" || selectiveAcceptanceApplying}
                        disabled={candidateBusy}
                        onInput={(event) => fitCandidateDecisionTextarea(event.currentTarget)}
                        onChange={(event) => {
                          const nextValue = event.currentTarget.value;
                          setEditable((current) => ({
                            ...current,
                            [candidate.id]: nextValue,
                          }));
                        }}
                      />
                    )}
                  </FormField>
                </CardContent>
                {candidate.status === "review" && (
                  <CardFooter className="candidate-decision-actions">
                    <Button
                      size="lg"
                      variant="secondary"
                      loading={busyAction === `save:${candidate.id}`}
                      disabled={
                        disabled ||
                        busyAction !== null ||
                        selectiveAcceptanceApplying ||
                        !dirty ||
                        text.trim().length === 0
                      }
                      onClick={() => void save(candidate)}
                    >
                      保存对建议的修改
                    </Button>
                    <Button
                      size="lg"
                      variant="secondary"
                      loading={busyAction === `partial:${candidate.id}`}
                      disabled={
                        disabled || busyAction !== null || !hasBaseline || selected.length === 0
                      }
                      onClick={() => void acceptSelected(candidate)}
                    >
                      {selectiveAcceptanceApplying
                        ? "恢复上次逐项采纳"
                        : `采纳已选 ${String(selected.length)} 项并保留当前简介`}
                    </Button>
                    <Button
                      size="lg"
                      loading={busyAction === `accept:${candidate.id}`}
                      disabled={
                        disabled || busyAction !== null || dirty || selectiveAcceptanceApplying
                      }
                      onClick={() => void accept(candidate)}
                    >
                      采纳并替换“{candidate.targetNodeTitle}”的简介
                    </Button>
                    <Button
                      size="lg"
                      variant="ghost"
                      loading={busyAction === `reject:${candidate.id}`}
                      disabled={disabled || busyAction !== null || selectiveAcceptanceApplying}
                      onClick={() => void reject(candidate)}
                    >
                      拒绝这份建议
                    </Button>
                  </CardFooter>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}

function candidateStatusLabel(status: StoryPlanningCandidate["status"]): string {
  switch (status) {
    case "review":
      return "待审阅";
    case "accepted":
      return "已采纳";
    case "rejected":
      return "已拒绝";
  }
}

function candidateStatusTone(
  status: StoryPlanningCandidate["status"],
): "info" | "success" | "neutral" {
  switch (status) {
    case "review":
      return "info";
    case "accepted":
      return "success";
    case "rejected":
      return "neutral";
  }
}

function formatPlanningCost(disclosure: StoryPlanningDisclosure): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null) {
    return "当前无法核定费用上限，AI 服务仍可能收费";
  }
  return `本次费用上限 ${disclosure.estimatedMaximumCostMicros} 微单位 ${disclosure.currency}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    return projectOrdinaryUiError(cause).description;
  }
  return fallback;
}

function planningFailureMessage(
  cause: unknown,
  input: Readonly<{
    projectId: string;
    task: StoryPlanningTask;
    stage: SafeOperationStage;
    fallback: string;
    dispatched: boolean | "unknown";
  }>,
): PlanningPanelMessage {
  const incident = recordSafeOperationIncident({
    operation: "story_planning",
    stage: input.stage,
    cause,
    projectId: input.projectId,
    dispatched: input.dispatched,
  });
  const actionName = input.task === "outline_planning" ? "故事方向" : "场景拆解";
  const code = safeCauseCode(cause);
  if (input.stage === "persist_result" && code === "STORY_PLANNING_RESULT_PERSIST_FAILED") {
    return {
      title: `${actionName}结果尚未保存`,
      message:
        "模型结果已经返回，但待审阅建议没有安全保存。正式大纲和正文没有改变；请先查看模型使用记录，避免重复发送。",
      supportId: incident.supportId,
    };
  }
  if (input.stage === "prepare_disclosure" && code === "MODEL_HUB_STRUCTURED_OUTPUT_NOT_VERIFIED") {
    return {
      title: `${actionName}发送信息尚未准备好`,
      message:
        "准备发送信息时发现所选模型尚未通过规划格式检查。本次没有向模型服务发送内容；请在 AI 模型中完成能力验证后重试。",
      supportId: incident.supportId,
    };
  }
  if (
    input.stage === "prepare_disclosure" &&
    (code === "MODEL_HUB_ROUTE_NOT_CONFIGURED" || code === "MODEL_HUB_ROUTE_NOT_FOUND")
  ) {
    return {
      title: `${actionName}发送信息尚未准备好`,
      message:
        "准备发送信息时没有找到可用的剧情规划模型安排。本次没有向模型服务发送内容；请先选择模型后重试。",
      supportId: incident.supportId,
    };
  }
  if (input.stage === "read_local_state") {
    return {
      title: "以前的规划建议暂时无法读取",
      message: `${errorMessage(cause, input.fallback)} 当前大纲和正文没有改变，请重新读取。`,
      supportId: incident.supportId,
    };
  }
  return {
    title:
      input.stage === "prepare_disclosure"
        ? `${actionName}发送信息尚未准备好`
        : `${actionName}操作尚未完成`,
    message: `${errorMessage(cause, input.fallback)} ${dispatchStateMessage(input.dispatched)}`,
    supportId: incident.supportId,
  };
}

function planningDispatchState(cause: unknown): boolean | "unknown" {
  if (typeof cause !== "object" || cause === null || !("dispatched" in cause)) {
    return "unknown";
  }
  return cause.dispatched === true || cause.dispatched === false ? cause.dispatched : "unknown";
}

function planningFailureStage(cause: unknown, dispatched: boolean | "unknown"): SafeOperationStage {
  if (typeof cause === "object" && cause !== null && "planningStage" in cause) {
    const stage = cause.planningStage;
    if (
      stage === "pre_dispatch_check" ||
      stage === "provider_dispatch" ||
      stage === "persist_result"
    ) {
      return stage;
    }
  }
  return dispatched === false ? "pre_dispatch_check" : "provider_dispatch";
}

function dispatchStateMessage(dispatched: boolean | "unknown"): string {
  if (dispatched === false) return "本次没有向模型服务发送内容。";
  if (dispatched === true) return "内容已经发送，请先查看模型使用记录，避免重复发送。";
  return "是否已经发送暂时无法确认，请先查看模型使用记录，避免重复发送。";
}

function safeCauseCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string"
  ) {
    return cause.code;
  }
  return "UNEXPECTED_OPERATION_FAILURE";
}
