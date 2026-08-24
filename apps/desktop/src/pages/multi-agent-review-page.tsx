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
  FormField,
  InlineAlert,
  Input,
  Select,
  Textarea,
} from "@inkshadow/ui";
import type {
  MultiAgentReviewConclusion,
  MultiAgentReviewSession,
  PersistedMultiAgentReviewMode,
  PersistedMultiAgentReviewRole,
} from "@inkshadow/data";
import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";

import {
  MULTI_AGENT_LOCAL_ROLES,
  type MultiAgentReviewRuntime,
  type StartMultiAgentReviewInput,
} from "../infrastructure/multi-agent-review-runtime";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import { handleCandidateDecisionNavigation } from "../components/candidate-decision-navigation";

import "./multi-agent-review-page.css";

export type MultiAgentReviewPageRuntime = Pick<
  MultiAgentReviewRuntime,
  | "acceptOutlineCandidate"
  | "cancelReview"
  | "exportHistory"
  | "expireCandidate"
  | "listHistory"
  | "rejectCandidate"
  | "restartReview"
  | "runReview"
  | "startReview"
>;

export interface MultiAgentReviewPageProps {
  readonly runtime: MultiAgentReviewPageRuntime | null;
  readonly projectId: string;
  readonly chapterId?: string | null;
  readonly featureEnabled: boolean;
  readonly onOpenChapterCandidate?: (candidateId: string, chapterId: string | null) => void;
  readonly onExportHistory?: (filename: string, content: string) => void;
}

const MODE_OPTIONS = [
  { value: "brainstorm", label: "头脑风暴" },
  { value: "outline_review", label: "大纲审查" },
  { value: "character_review", label: "角色审查" },
  { value: "world_review", label: "世界观审查" },
  { value: "commercial_review", label: "商业性审查" },
  { value: "plot_planning", label: "剧情规划" },
] as const;

const ROLE_LABELS: Record<PersistedMultiAgentReviewRole, string> = {
  planner: "规划者",
  drafter: "执笔者",
  critic: "批评者",
  continuity_reviewer: "连续性审校",
  editor: "编辑",
};

const STATUS_META = {
  idle: { icon: "○", label: "待开始", tone: "neutral" },
  running: { icon: "●", label: "运行中", tone: "ai" },
  completed: { icon: "✓", label: "已完成", tone: "success" },
  candidate_ready: { icon: "✓", label: "候选已就绪", tone: "success" },
  needs_input: { icon: "?", label: "需要输入", tone: "warning" },
  failed: { icon: "!", label: "失败", tone: "danger" },
  paused: { icon: "Ⅱ", label: "已暂停", tone: "warning" },
  cancelled: { icon: "×", label: "已停止", tone: "neutral" },
} as const;

const CONCLUSION_LABELS = {
  must_change: "必须修改",
  suggested_change: "建议修改",
  optional_enhancement: "可选增强",
  disputed_opinion: "争议意见",
  convertible_task: "可转任务",
} as const;

const TASK_PRIORITY_LABELS = {
  p0: "立即处理",
  p1: "高优先级",
  p2: "普通优先级",
  p3: "低优先级",
} as const;

const DEFAULT_ROLES = new Set<PersistedMultiAgentReviewRole>(["planner", "critic", "editor"]);

export function MultiAgentReviewPage({
  runtime,
  projectId,
  chapterId = null,
  featureEnabled,
  onOpenChapterCandidate,
  onExportHistory,
}: MultiAgentReviewPageProps) {
  const [history, setHistory] = useState<readonly MultiAgentReviewSession[]>([]);
  const [selected, setSelected] = useState<MultiAgentReviewSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"start" | "stop" | "restart" | "candidate" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [mode, setMode] = useState<PersistedMultiAgentReviewMode>("outline_review");
  const [targetKind, setTargetKind] = useState<"chapter" | "outline">(
    chapterId === null ? "outline" : "chapter",
  );
  const [rounds, setRounds] = useState(2);
  const [roles, setRoles] = useState<ReadonlySet<PersistedMultiAgentReviewRole>>(DEFAULT_ROLES);
  const [request, setRequest] = useState("");
  const operation = useRef<AbortController | null>(null);

  const loadHistory = useCallback(async () => {
    await Promise.resolve();
    if (runtime === null) {
      setHistory([]);
      setSelected(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailure(null);
    try {
      const sessions = await runtime.listHistory(projectId, 50);
      setHistory(sessions);
      setSelected((current) => {
        if (current !== null) {
          return sessions.find(({ id }) => id === current.id) ?? sessions[0] ?? null;
        }
        return sessions[0] ?? null;
      });
    } catch (error: unknown) {
      setFailure(publicErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [projectId, runtime]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        void loadHistory();
      }
    });
    return () => {
      active = false;
      operation.current?.abort();
    };
  }, [loadHistory]);

  const usage = useMemo(() => summarizeUsage(selected), [selected]);
  const needsInputQuestion = useMemo(() => readNeedsInputQuestion(selected), [selected]);

  async function start(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      runtime === null ||
      !featureEnabled ||
      request.trim().length === 0 ||
      request.length > 8_000 ||
      roles.size === 0 ||
      (targetKind === "chapter" && chapterId === null)
    ) {
      return;
    }
    operation.current?.abort();
    const abort = new AbortController();
    operation.current = abort;
    setBusy("start");
    setFailure(null);
    try {
      const input: StartMultiAgentReviewInput = {
        projectId,
        mode,
        target:
          targetKind === "chapter"
            ? { kind: "chapter", chapterId: chapterId ?? "" }
            : { kind: "outline" },
        userRequest: request.trim(),
        roles: MULTI_AGENT_LOCAL_ROLES.filter((role) => roles.has(role)),
        maximumRounds: rounds,
        limits: {
          maximumInputTokens: 120_000,
          maximumOutputTokens: 32_000,
          maximumCostMicros: 10_000_000,
          maximumDurationMs: 15 * 60 * 1_000,
          currency: "USD",
        },
        execution: "local",
      };
      let session = await runtime.startReview(input);
      setSelected(session);
      setHistory((current) => [session, ...current.filter(({ id }) => id !== session.id)]);
      session = await runtime.runReview(session.id, {
        signal: abort.signal,
        onUpdate: (updated) => {
          setSelected(updated);
          setHistory((current) =>
            current.map((entry) => (entry.id === updated.id ? updated : entry)),
          );
        },
      });
      setSelected(session);
      setHistory((current) => current.map((entry) => (entry.id === session.id ? session : entry)));
    } catch (error: unknown) {
      if (!abort.signal.aborted) {
        setFailure(publicErrorMessage(error));
      }
    } finally {
      if (operation.current === abort) {
        operation.current = null;
        setBusy(null);
      }
    }
  }

  async function stop(): Promise<void> {
    if (runtime === null || selected === null) {
      return;
    }
    const active = operation.current;
    operation.current = null;
    active?.abort();
    setBusy("stop");
    setFailure(null);
    try {
      const session = await runtime.cancelReview(selected.id);
      replaceSession(session);
    } catch (error: unknown) {
      setFailure(publicErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function restart(): Promise<void> {
    if (runtime === null || selected === null || !featureEnabled) {
      return;
    }
    const abort = new AbortController();
    operation.current = abort;
    setBusy("restart");
    setFailure(null);
    try {
      const restarted = await runtime.restartReview(selected.id);
      setHistory((current) => [restarted, ...current]);
      setSelected(restarted);
      const completed = await runtime.runReview(restarted.id, {
        signal: abort.signal,
        onUpdate: replaceSession,
      });
      replaceSession(completed);
    } catch (error: unknown) {
      if (!abort.signal.aborted) {
        setFailure(publicErrorMessage(error));
      }
    } finally {
      if (operation.current === abort) {
        operation.current = null;
        setBusy(null);
      }
    }
  }

  async function decideCandidate(decision: "accept" | "reject" | "expire"): Promise<void> {
    if (runtime === null || selected?.candidate === null || selected === null || !featureEnabled) {
      return;
    }
    setBusy("candidate");
    setFailure(null);
    try {
      if (decision === "accept") {
        if (selected.candidate.targetKind === "chapter") {
          const chapterCandidateId = selected.candidate.chapterCandidateId;
          if (chapterCandidateId !== null) {
            onOpenChapterCandidate?.(chapterCandidateId, selected.chapterId);
          }
          return;
        }
        await runtime.acceptOutlineCandidate(selected.candidate.id, selected.candidate.revision);
      } else if (decision === "reject") {
        await runtime.rejectCandidate(selected.candidate.id, selected.candidate.revision);
      } else {
        await runtime.expireCandidate(selected.candidate.id, selected.candidate.revision);
      }
      await loadHistory();
    } catch (error: unknown) {
      setFailure(publicErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function replaceSession(session: MultiAgentReviewSession): void {
    setSelected(session);
    setHistory((current) => current.map((entry) => (entry.id === session.id ? session : entry)));
  }

  function exportSelected(): void {
    if (runtime === null || selected === null) {
      return;
    }
    const content = runtime.exportHistory(selected);
    const filename = `inkshadow-multi-agent-${selected.id}.json`;
    if (onExportHistory !== undefined) {
      onExportHistory(filename, content);
      return;
    }
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function toggleRole(role: PersistedMultiAgentReviewRole): void {
    setRoles((current) => {
      const next = new Set(current);
      if (next.has(role)) {
        next.delete(role);
      } else {
        next.add(role);
      }
      return next;
    });
  }

  return (
    <div className="multi-agent-page">
      <header className="multi-agent-page__header">
        <div>
          <p className="multi-agent-page__eyebrow">本地 AI 协作工作台</p>
          <h1>多智能体审查</h1>
          <p>多个本地模型角色按固定轮次讨论，只保存公开结论、来源凭据与隔离候选。</p>
        </div>
        <div className="multi-agent-page__header-actions">
          <Badge tone="info" leadingIcon="⌂">
            仅本机执行
          </Badge>
          <Button variant="secondary" onClick={exportSelected} disabled={selected === null}>
            导出公开历史
          </Button>
        </div>
      </header>

      {!featureEnabled && (
        <InlineAlert
          tone="warning"
          title="多智能体创建功能当前关闭"
          description="你仍可只读查看并导出既有本地历史。团队云执行尚未接入明确的额度上限与占用记录，因此不会在此页面启用。"
        />
      )}
      {featureEnabled && (
        <InlineAlert
          title="本地能力，不使用团队云额度"
          description="本页只使用本机已配置的模型线路。实际内容额度与费用必须由模型服务回报；缺失用量时会失败关闭。"
        />
      )}
      {failure !== null && (
        <InlineAlert
          tone="error"
          title="多智能体操作未完成"
          description={failure}
          onDismiss={() => setFailure(null)}
        />
      )}

      <div className="multi-agent-page__layout">
        <aside className="multi-agent-history" aria-label="审查历史">
          <div className="multi-agent-section-heading">
            <div>
              <h2>历史</h2>
              <span>{history.length} 次本地审查</span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void loadHistory()}>
              刷新
            </Button>
          </div>
          {loading ? (
            <p role="status">正在加载公开历史…</p>
          ) : history.length === 0 ? (
            <EmptyState
              title="还没有审查历史"
              description={
                featureEnabled
                  ? "在右侧设置角色与轮次后开始第一次本地审查。"
                  : "此项目当前没有可供只读查看的多智能体历史。"
              }
              icon="◎"
            />
          ) : (
            <div className="multi-agent-history__list">
              {history.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="multi-agent-history__item"
                  data-selected={selected?.id === session.id || undefined}
                  aria-pressed={selected?.id === session.id}
                  onClick={() => setSelected(session)}
                >
                  <StatusBadge status={session.status} />
                  <strong>{modeLabel(session.mode)}</strong>
                  <span>
                    {session.turns.length}/{session.limits.maximumTurns} 轮次 ·{" "}
                    {formatDate(session.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="multi-agent-page__content">
          {selected === null ? (
            <EmptyState
              title="选择或创建一场审查"
              description="审查过程、公开结论、来源和候选会显示在这里。"
              icon="✦"
            />
          ) : (
            <>
              <Card className="multi-agent-overview">
                <CardHeader>
                  <div className="multi-agent-overview__title">
                    <div>
                      <CardTitle>{modeLabel(selected.mode)}</CardTitle>
                      <CardDescription>{selected.userRequest}</CardDescription>
                    </div>
                    <StatusBadge status={selected.status} />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="multi-agent-metrics">
                    <Metric
                      label="轮次"
                      value={`${String(selected.turns.length)}/${String(
                        selected.limits.maximumTurns,
                      )}`}
                    />
                    <Metric
                      label="输入内容额度"
                      value={usage.unknown ? "部分未知" : formatNumber(usage.inputTokens)}
                    />
                    <Metric
                      label="输出内容额度"
                      value={usage.unknown ? "部分未知" : formatNumber(usage.outputTokens)}
                    />
                    <Metric
                      label="已计费用"
                      value={
                        usage.unknown
                          ? "不可核算"
                          : formatCost(usage.costMicros, selected.limits.currency)
                      }
                    />
                  </div>
                  <div className="multi-agent-overview__actions">
                    {selected.status === "running" && featureEnabled && (
                      <Button
                        variant="danger"
                        onClick={() => void stop()}
                        loading={busy === "stop"}
                        disabled={busy === "stop"}
                      >
                        停止审查
                      </Button>
                    )}
                    {["paused", "failed", "cancelled"].includes(selected.status) &&
                      featureEnabled && (
                        <Button
                          variant="ai-primary"
                          onClick={() => void restart()}
                          loading={busy === "restart"}
                        >
                          重新开始
                        </Button>
                      )}
                  </div>
                  {selected.status === "needs_input" && (
                    <InlineAlert
                      tone="warning"
                      title="模型需要补充信息"
                      description={
                        needsInputQuestion ??
                        "这场审查已停止在需要输入状态。请用下方输入框创建一场新的审查。"
                      }
                      {...(featureEnabled
                        ? {
                            action: {
                              label: "填写回答并新建审查",
                              onClick: () => setRequest(`${selected.userRequest}\n\n补充回答：`),
                            },
                          }
                        : {})}
                    />
                  )}
                </CardContent>
              </Card>

              <section aria-labelledby="participants-title">
                <div className="multi-agent-section-heading">
                  <div>
                    <h2 id="participants-title">参与角色与模型</h2>
                    <span>模型快照在审查开始时固定</span>
                  </div>
                </div>
                <div className="multi-agent-participants">
                  {selected.participants.map((participant) => (
                    <Card key={participant.participantId}>
                      <CardHeader>
                        <CardTitle>{ROLE_LABELS[participant.role]}</CardTitle>
                        <CardDescription>
                          {participant.providerId} · {participant.modelId}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <StatusBadge status={participant.status} />
                        <p>
                          上下文 {formatNumber(participant.contextWindowTokens)} · 价格版本{" "}
                          {participant.pricingVersion}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>

              <section aria-labelledby="turns-title">
                <div className="multi-agent-section-heading">
                  <div>
                    <h2 id="turns-title">公开讨论</h2>
                    <span>不保存系统提示词或隐藏推理</span>
                  </div>
                </div>
                {selected.turns.length === 0 ? (
                  <EmptyState
                    title="等待第一个公开回合"
                    description="模型输出通过严格结构校验后才会出现在这里。"
                    icon="…"
                  />
                ) : (
                  <ol className="multi-agent-turns">
                    {selected.turns.map((turn) => (
                      <li key={turn.id}>
                        <Card>
                          <CardHeader>
                            <div className="multi-agent-overview__title">
                              <div>
                                <CardTitle>回合 {turn.sequence}</CardTitle>
                                <CardDescription>
                                  {participantLabel(selected, turn.participantId)}
                                </CardDescription>
                              </div>
                              <StatusBadge status={turn.status} />
                            </div>
                          </CardHeader>
                          <CardContent>
                            {turn.publicMessage !== null && <p>{turn.publicMessage}</p>}
                            {turn.errorCode !== null && (
                              <InlineAlert
                                tone="error"
                                title="回合失败"
                                description={
                                  projectOrdinaryUiError({ code: turn.errorCode }).description
                                }
                              />
                            )}
                            <ConclusionList conclusions={turn.conclusions} />
                            <p className="multi-agent-turn__usage">
                              用量：
                              {turn.usageSource === "provider_reported"
                                ? `${formatNumber(turn.inputTokens ?? 0)} 输入 / ${formatNumber(
                                    turn.outputTokens ?? 0,
                                  )} 输出 / ${formatCost(
                                    turn.costMicros ?? 0,
                                    selected.limits.currency,
                                  )}`
                                : "提供方未返回，不进行估算"}
                            </p>
                          </CardContent>
                        </Card>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {selected.candidate !== null && (
                <Card
                  className={`multi-agent-candidate${
                    selected.candidate.status === "ready" ? " candidate-decision-surface" : ""
                  }`}
                  aria-label="多智能体审稿候选决策"
                >
                  <CardHeader>
                    <div className="multi-agent-overview__title">
                      <div>
                        <CardTitle>隔离候选</CardTitle>
                        <CardDescription>
                          候选不会直接覆盖正文或大纲；必须显式接受。
                        </CardDescription>
                      </div>
                      <Badge
                        tone={
                          selected.candidate.status === "accepted"
                            ? "success"
                            : selected.candidate.status === "ready"
                              ? "ai"
                              : "neutral"
                        }
                      >
                        {candidateStatusLabel(selected.candidate.status)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent
                    tabIndex={selected.candidate.status === "ready" ? 0 : undefined}
                    aria-label="多智能体审稿候选内容"
                    onKeyDown={handleCandidateDecisionNavigation}
                  >
                    <CandidatePreview payloadJson={selected.candidate.payloadJson} />
                  </CardContent>
                  {selected.candidate.status === "ready" && featureEnabled && (
                    <CardFooter className="candidate-decision-actions">
                      <Button
                        size="lg"
                        variant="ai-primary"
                        loading={busy === "candidate"}
                        disabled={
                          busy !== null ||
                          (selected.candidate.targetKind === "chapter" &&
                            onOpenChapterCandidate === undefined)
                        }
                        onClick={() => void decideCandidate("accept")}
                      >
                        {selected.candidate.targetKind === "chapter"
                          ? "在编辑器中查看候选"
                          : "应用大纲候选"}
                      </Button>
                      <Button
                        size="lg"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() => void decideCandidate("reject")}
                      >
                        拒绝候选
                      </Button>
                      <Button
                        size="lg"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void decideCandidate("expire")}
                      >
                        标记失效
                      </Button>
                    </CardFooter>
                  )}
                </Card>
              )}
            </>
          )}

          {featureEnabled && runtime !== null && (
            <form className="multi-agent-composer" onSubmit={(event) => void start(event)}>
              <div className="multi-agent-composer__grid">
                <FormField label="审查模式" required>
                  {(props) => (
                    <Select
                      {...props}
                      value={mode}
                      options={MODE_OPTIONS}
                      onChange={(event) =>
                        setMode(event.target.value as PersistedMultiAgentReviewMode)
                      }
                    />
                  )}
                </FormField>
                <FormField label="目标" required>
                  {(props) => (
                    <Select
                      {...props}
                      value={targetKind}
                      options={[
                        {
                          value: "chapter",
                          label: "当前章节",
                          disabled: chapterId === null,
                        },
                        { value: "outline", label: "项目大纲" },
                      ]}
                      onChange={(event) =>
                        setTargetKind(event.target.value as "chapter" | "outline")
                      }
                    />
                  )}
                </FormField>
                <FormField label="轮数" hint="每个已选角色每轮发言一次">
                  {(props) => (
                    <Input
                      {...props}
                      type="number"
                      min={1}
                      max={16}
                      value={rounds}
                      onChange={(event) => setRounds(Number(event.target.value))}
                    />
                  )}
                </FormField>
              </div>
              <fieldset className="multi-agent-role-picker">
                <legend>参与角色</legend>
                {MULTI_AGENT_LOCAL_ROLES.map((role) => (
                  <label key={role}>
                    <input
                      type="checkbox"
                      checked={roles.has(role)}
                      onChange={() => toggleRole(role)}
                    />
                    <span>{ROLE_LABELS[role]}</span>
                  </label>
                ))}
              </fieldset>
              <FormField
                label="审查目标"
                required
                hint="描述需要讨论的问题；不会把密钥、隐藏提示词或隐藏推理写入历史。"
                error={request.length > 8_000 ? "审查目标不能超过 8,000 个字符。" : undefined}
              >
                {(props) => (
                  <Textarea
                    {...props}
                    rows={3}
                    maxLength={8_000}
                    currentLength={request.length}
                    value={request}
                    placeholder="例如：检查第二幕动机是否充分，并给出可应用的大纲修改。"
                    onChange={(event) => setRequest(event.target.value)}
                  />
                )}
              </FormField>
              <div className="multi-agent-composer__footer">
                <span>团队云执行：关闭 · 本地预算上限：US$10.00</span>
                <Button
                  type="submit"
                  variant="ai-primary"
                  loading={busy === "start"}
                  disabled={
                    busy !== null ||
                    request.trim().length === 0 ||
                    request.length > 8_000 ||
                    roles.size === 0 ||
                    !Number.isSafeInteger(rounds) ||
                    rounds < 1 ||
                    rounds > 16
                  }
                >
                  开始本地审查
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  readonly status:
    | MultiAgentReviewSession["status"]
    | MultiAgentReviewSession["participants"][number]["status"]
    | MultiAgentReviewSession["turns"][number]["status"];
}) {
  const normalized =
    status === "working"
      ? "running"
      : status === "done"
        ? "completed"
        : status === "error"
          ? "failed"
          : status;
  const meta = STATUS_META[normalized];
  return (
    <Badge tone={meta.tone} leadingIcon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

function ConclusionList({
  conclusions,
}: {
  readonly conclusions: readonly MultiAgentReviewConclusion[];
}) {
  if (conclusions.length === 0) {
    return null;
  }
  return (
    <div className="multi-agent-conclusions">
      {conclusions.map((conclusion) => (
        <article key={conclusion.id}>
          <div className="multi-agent-conclusions__title">
            <Badge tone={conclusionTone(conclusion.category)}>
              {CONCLUSION_LABELS[conclusion.category]}
            </Badge>
            <h4>{conclusion.title}</h4>
          </div>
          <p>{conclusion.explanation}</p>
          {conclusion.evidence.length > 0 && (
            <ul>
              {conclusion.evidence.map((evidence, index) => (
                <li key={`${conclusion.id}-evidence-${String(index)}`}>{evidence}</li>
              ))}
            </ul>
          )}
          {conclusion.sourceReferences.length > 0 && (
            <div className="multi-agent-citations" aria-label="来源">
              {conclusion.sourceReferences.map((reference, index) => (
                <span
                  key={`${conclusion.id}-source-${String(index)}`}
                  title={`来源类型：${sourceReferenceKindLabel(reference.kind)}；来源记录：${
                    reference.sourceId
                  }；来源修订：${String(reference.sourceRevision)}`}
                >
                  〔{reference.authoritativeLabel ?? reference.modelLabel}〕
                  {reference.authoritativeLabel !== null &&
                    reference.authoritativeLabel !== reference.modelLabel &&
                    ` 模型标注：${reference.modelLabel}`}
                </span>
              ))}
            </div>
          )}
          {conclusion.taskProposal !== null && (
            <p className="multi-agent-task-proposal">
              可转任务 · {TASK_PRIORITY_LABELS[conclusion.taskProposal.priority]} ·{" "}
              {conclusion.taskProposal.title}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}

function CandidatePreview({ payloadJson }: { readonly payloadJson: string }) {
  const payload = parseCandidatePreviewPayload(payloadJson);
  if (payload === null) {
    return <InlineAlert tone="error" title="候选数据损坏" />;
  }
  if (payload.kind === "chapter_content") {
    return <pre>{payload.content}</pre>;
  }
  return (
    <ul>
      {payload.changes.map((change) => (
        <li key={change.nodeId}>
          <strong>{change.title ?? change.nodeId}</strong>
          {change.synopsis !== null && <p>{change.synopsis}</p>}
        </li>
      ))}
    </ul>
  );
}

type CandidatePreviewPayload =
  | { readonly kind: "chapter_content"; readonly content: string }
  | {
      readonly kind: "outline_patch";
      readonly changes: readonly {
        readonly nodeId: string;
        readonly title: string | null;
        readonly synopsis: string | null;
      }[];
    };

function parseCandidatePreviewPayload(payloadJson: string): CandidatePreviewPayload | null {
  try {
    return JSON.parse(payloadJson) as CandidatePreviewPayload;
  } catch {
    return null;
  }
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function summarizeUsage(session: MultiAgentReviewSession | null) {
  if (session === null) {
    return { inputTokens: 0, outputTokens: 0, costMicros: 0, unknown: false };
  }
  return session.turns.reduce(
    (total, turn) => ({
      inputTokens: total.inputTokens + (turn.inputTokens ?? 0),
      outputTokens: total.outputTokens + (turn.outputTokens ?? 0),
      costMicros: total.costMicros + (turn.costMicros ?? 0),
      unknown:
        total.unknown || (turn.status !== "working" && turn.usageSource !== "provider_reported"),
    }),
    { inputTokens: 0, outputTokens: 0, costMicros: 0, unknown: false },
  );
}

function participantLabel(session: MultiAgentReviewSession, participantId: string): string {
  const participant = session.participants.find((entry) => entry.participantId === participantId);
  return participant === undefined
    ? participantId
    : `${ROLE_LABELS[participant.role]} · ${participant.modelId}`;
}

function modeLabel(mode: PersistedMultiAgentReviewMode): string {
  return MODE_OPTIONS.find(({ value }) => value === mode)?.label ?? mode;
}

function conclusionTone(category: MultiAgentReviewConclusion["category"]) {
  switch (category) {
    case "must_change":
      return "danger" as const;
    case "suggested_change":
      return "warning" as const;
    case "convertible_task":
      return "info" as const;
    case "optional_enhancement":
      return "success" as const;
    case "disputed_opinion":
      return "neutral" as const;
  }
}

function sourceReferenceKindLabel(
  kind: MultiAgentReviewConclusion["sourceReferences"][number]["kind"],
): string {
  return {
    chapter: "章节",
    outline_node: "大纲节点",
    material: "项目素材",
    project_rule: "项目规则",
    turn: "审查轮次",
  }[kind];
}

function candidateStatusLabel(
  status: NonNullable<MultiAgentReviewSession["candidate"]>["status"],
): string {
  return {
    ready: "待决定",
    accepted: "已接受",
    rejected: "已拒绝",
    expired: "已失效",
  }[status];
}

function formatCost(micros: number, currency: string): string {
  return `${currency} ${(micros / 1_000_000).toFixed(4)}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function publicErrorMessage(error: unknown): string {
  return projectOrdinaryUiError(error).description;
}

function readNeedsInputQuestion(session: MultiAgentReviewSession | null): string | null {
  const responseJson = session?.turns.at(-1)?.responseJson;
  if (responseJson === null || responseJson === undefined) {
    return null;
  }
  try {
    const response = JSON.parse(responseJson) as {
      readonly needsInput?: { readonly question?: unknown } | null;
    };
    return typeof response.needsInput?.question === "string" ? response.needsInput.question : null;
  } catch {
    return null;
  }
}
