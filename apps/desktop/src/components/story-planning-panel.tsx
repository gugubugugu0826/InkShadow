import { useCallback, useEffect, useMemo, useState } from "react";
import type { Outline } from "@inkshadow/story-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FormField,
  InlineAlert,
  Select,
  Textarea,
} from "@inkshadow/ui";

import type { ModelHubStoryPlanningService } from "../infrastructure/model-hub-story-planning-service";
import type {
  StoryPlanningCandidate,
  StoryPlanningTask,
} from "../infrastructure/story-planning-candidate-store";
import { listStoryPlanningSelectableItems } from "../infrastructure/story-planning-selective-acceptance";

export interface StoryPlanningPanelProps {
  readonly projectId: string;
  readonly outline: Outline;
  readonly service: Pick<
    ModelHubStoryPlanningService,
    | "listCandidates"
    | "generate"
    | "updateCandidate"
    | "acceptCandidate"
    | "acceptCandidateItems"
    | "rejectCandidate"
  >;
  readonly disabled?: boolean;
  readonly onOutlineChanged: () => void | Promise<void>;
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Readonly<{ title: string; message: string }> | null>(null);
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
      setError(errorMessage(cause, "无法读取以前的规划建议。"));
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
      setError("请先在大纲中添加并选择一个章节，再拆解场景。");
      return;
    }
    setBusyAction("generate");
    setError(null);
    setNotice(null);
    try {
      const outcome = await service.generate({
        projectId,
        task,
        ...(task === "scene_breakdown" ? { targetNodeId: resolvedTargetNodeId } : {}),
        ...(direction.trim().length === 0 ? {} : { userDirection: direction }),
      });
      if (outcome.status === "skipped") {
        setNotice({ title: "本次没有调用 AI", message: `${outcome.message}（${outcome.code}）` });
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
      setError(errorMessage(cause, "规划建议生成失败；正式大纲和正文没有改变。"));
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
      setError(errorMessage(cause, "无法保存这份规划建议。"));
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
      setError(errorMessage(cause, "无法安全采纳这份建议。"));
    } finally {
      setBusyAction(null);
    }
  }

  async function acceptSelected(candidate: StoryPlanningCandidate): Promise<void> {
    const selectedItemIds = selectedItems[candidate.id] ?? [];
    if (selectedItemIds.length === 0) {
      setError("请至少勾选一项要采纳的规划内容。");
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
      setError(errorMessage(cause, "无法安全采纳所选规划条目。"));
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
      setError(errorMessage(cause, "无法记录拒绝结果。"));
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
                onChange={(event) => setTask(event.currentTarget.value as StoryPlanningTask)}
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
                  onChange={(event) => setTargetNodeId(event.currentTarget.value)}
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
                onChange={(event) => setDirection(event.currentTarget.value)}
              />
            )}
          </FormField>

          <Button
            loading={busyAction === "generate"}
            disabled={
              disabled ||
              busyAction !== null ||
              (task === "scene_breakdown" && chapters.length === 0)
            }
            onClick={() => void generate()}
          >
            {task === "outline_planning" ? "生成故事方向建议" : "生成场景拆解建议"}
          </Button>

          {notice !== null && (
            <InlineAlert
              tone="info"
              title={notice.title}
              description={notice.message}
              onDismiss={() => setNotice(null)}
            />
          )}
          {error !== null && (
            <InlineAlert
              tone="error"
              title="AI 剧情规划未完成"
              description={error}
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
              <Card key={candidate.id}>
                <CardHeader>
                  <div className="card-heading-row">
                    <div>
                      <CardTitle>
                        {candidate.task === "outline_planning" ? "故事方向建议" : "场景拆解建议"}：
                        {candidate.targetNodeTitle}
                      </CardTitle>
                      <p>
                        使用 {candidate.providerKind} / {candidate.modelId}
                        {candidate.usedFallback ? "（备用模型）" : ""} · 调用记录{" "}
                        {candidate.invocationId}
                      </p>
                    </div>
                    <Badge tone={candidateStatusTone(candidate.status)}>
                      {selectiveAcceptanceApplying
                        ? "正在恢复逐项采纳"
                        : candidateStatusLabel(candidate.status)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {selectiveAcceptanceApplying && (
                    <InlineAlert
                      tone="info"
                      title="上次逐项采纳尚未完成"
                      description="系统已锁定同一组规划条目。只能继续恢复这次采纳；在完成前不能编辑、整篇采纳或拒绝，避免正式大纲与候选状态互相冲突。"
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
                  <div className="story-planning-diff" aria-label="当前大纲与候选差异">
                    <div>
                      <strong>当前正式简介</strong>
                      <p className="story-planning-diff-text">
                        {currentTarget === undefined || currentTarget.synopsis.length === 0
                          ? "（当前简介为空）"
                          : currentTarget.synopsis}
                      </p>
                    </div>
                    <div>
                      <strong>候选中的结构化变更</strong>
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
                    label={`整体替换“${candidate.targetNodeTitle}”简介的候选内容`}
                    hint="这里的手动编辑只用于整体采纳，不会改变上方可勾选的固定条目。采纳前不会触碰正式大纲。"
                  >
                    {(fieldProps) => (
                      <Textarea
                        {...fieldProps}
                        value={text}
                        rows={12}
                        maxLength={20_000}
                        currentLength={text.length}
                        readOnly={candidate.status !== "review" || selectiveAcceptanceApplying}
                        disabled={candidateBusy}
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
                  {candidate.status === "review" && (
                    <div className="outline-node-actions">
                      <Button
                        size="sm"
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
                        size="sm"
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
                        size="sm"
                        loading={busyAction === `accept:${candidate.id}`}
                        disabled={
                          disabled || busyAction !== null || dirty || selectiveAcceptanceApplying
                        }
                        onClick={() => void accept(candidate)}
                      >
                        采纳并替换“{candidate.targetNodeTitle}”的简介
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busyAction === `reject:${candidate.id}`}
                        disabled={disabled || busyAction !== null || selectiveAcceptanceApplying}
                        onClick={() => void reject(candidate)}
                      >
                        拒绝这份建议
                      </Button>
                    </div>
                  )}
                </CardContent>
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

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}
