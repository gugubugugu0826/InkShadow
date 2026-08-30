import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  InlineAlert,
  Select,
} from "@inkshadow/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ConsistencyInvestigationRuntimePort } from "../infrastructure/consistency-investigation-port";
import type {
  ConsistencyInvestigationDisclosure,
  ConsistencyInvestigationSnapshot,
} from "../infrastructure/consistency-investigation-service";
import { ConsistencyInvestigationError } from "../infrastructure/consistency-investigation-service";
import {
  projectConsistencyInvestigationTaskGraph,
  type InvestigationTaskGraphNode,
} from "../infrastructure/consistency-investigation-task-graph";
import type {
  ConsistencyRepairCandidateDisclosure,
  ConsistencyRepairCandidateResult,
} from "../infrastructure/consistency-repair-candidate-service";
import type {
  ConsistencyInvestigationFinding,
  ConsistencyInvestigationFindingCategory,
  ConsistencyInvestigationFindingSeverity,
  ConsistencyInvestigationRun,
} from "../infrastructure/consistency-investigation-store";
import { normalizeUiError } from "../infrastructure/ui-error";
import { recordSafeOperationIncident } from "../infrastructure/safe-operation-diagnostics";

const STATUS_LABELS: Readonly<Record<ConsistencyInvestigationRun["status"], string>> = {
  planned: "等待确认",
  dispatched: "已发送",
  observing: "正在整理结果",
  verifying: "正在核验证据",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "结果不可用",
  cancelled: "已取消",
  not_dispatched: "未发送",
  ambiguous: "结果不确定",
};
const SEVERITY_LABELS: Readonly<Record<ConsistencyInvestigationFindingSeverity, string>> = {
  info: "提示",
  warning: "建议复核",
  error: "需要处理",
};
const CATEGORY_LABELS: Readonly<Record<ConsistencyInvestigationFindingCategory, string>> = {
  character: "人物",
  location: "地点",
  timeline: "时间线",
  pov: "视角与知情范围",
  world: "世界规则",
  causal: "剧情因果",
  other: "其他",
};
const AUTHORITY_LABELS: Readonly<
  Record<ConsistencyInvestigationFinding["authorityGroup"], string>
> = {
  accepted_body: "已接受正文",
  confirmed_fact: "已确认设定",
  mixed: "正文与设定",
};
const TASK_GRAPH_TOOL_LABELS: Readonly<Record<string, string>> = {
  read_story_memory: "读取当前故事记忆",
  inspect_fact: "核对已确认故事事实",
  search_fts: "检索当前已接受正文",
  inspect_causal: "检查已确认剧情因果",
  validate_evidence: "校验证据当前性",
  model_synthesis: "生成待确认的调查结论",
  verify_findings: "逐项核验调查结论",
};

export function ConsistencyInvestigationPanel({
  projectId,
  runtime,
  onOpenCandidate,
}: {
  readonly projectId: string;
  readonly runtime: ConsistencyInvestigationRuntimePort;
  readonly onOpenCandidate?: (result: ConsistencyRepairCandidateResult) => void | Promise<void>;
}) {
  const [history, setHistory] = useState<readonly ConsistencyInvestigationRun[]>([]);
  const [disclosure, setDisclosure] = useState<ConsistencyInvestigationDisclosure | null>(null);
  const [snapshot, setSnapshot] = useState<ConsistencyInvestigationSnapshot | null>(null);
  const [repairDisclosure, setRepairDisclosure] =
    useState<ConsistencyRepairCandidateDisclosure | null>(null);
  const [repairNotice, setRepairNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    | "prepare"
    | "run"
    | "cancel"
    | "decision"
    | "repair_prepare"
    | "repair_run"
    | "repair_cancel"
    | null
  >(null);
  const [error, setError] = useState<unknown>(null);
  const [errorSupportId, setErrorSupportId] = useState<string | null>(null);
  const disclosureSectionRef = useRef<HTMLElement>(null);
  const [severity, setSeverity] = useState<"all" | ConsistencyInvestigationFindingSeverity>("all");
  const [category, setCategory] = useState<"all" | ConsistencyInvestigationFindingCategory>("all");
  const [authority, setAuthority] = useState<
    "all" | ConsistencyInvestigationFinding["authorityGroup"]
  >("all");

  const refreshHistory = useCallback(async () => {
    setHistory(await runtime.list(projectId));
  }, [projectId, runtime]);

  useEffect(() => {
    if (disclosure !== null) disclosureSectionRef.current?.focus();
  }, [disclosure]);

  const filteredFindings = useMemo(
    () =>
      (snapshot?.findings ?? []).filter(
        (finding) =>
          (severity === "all" || finding.severity === severity) &&
          (category === "all" || finding.category === category) &&
          (authority === "all" || finding.authorityGroup === authority),
      ),
    [authority, category, severity, snapshot],
  );

  async function prepare(): Promise<void> {
    setBusy("prepare");
    setError(null);
    setErrorSupportId(null);
    try {
      const next = await runtime.prepare({
        projectId,
        ...(snapshot === null ? {} : { restartOfRunId: snapshot.run.id }),
      });
      setDisclosure(next);
      setSnapshot(null);
      await refreshHistory();
    } catch (cause: unknown) {
      setError(cause);
      setErrorSupportId(
        recordSafeOperationIncident({
          operation: "consistency_investigation",
          stage: "prepare_disclosure",
          cause,
          projectId,
          dispatched: false,
        }).supportId,
      );
    } finally {
      setBusy(null);
    }
  }

  async function run(): Promise<void> {
    if (disclosure === null) return;
    setBusy("run");
    setError(null);
    try {
      const next = await runtime.run({ runId: disclosure.runId, humanConfirmed: true });
      setSnapshot(next);
      setDisclosure(null);
      await refreshHistory();
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function cancel(): Promise<void> {
    const runId = disclosure?.runId ?? snapshot?.run.id;
    if (runId === undefined) return;
    setBusy("cancel");
    setError(null);
    try {
      setSnapshot(await runtime.cancel(runId));
      setDisclosure(null);
      await refreshHistory();
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function openRun(runId: string): Promise<void> {
    setError(null);
    try {
      setSnapshot(await runtime.get(runId));
      setDisclosure(null);
    } catch (cause: unknown) {
      setError(cause);
    }
  }

  async function decide(
    finding: ConsistencyInvestigationFinding,
    decision: "ignored" | "allowed",
  ): Promise<void> {
    setBusy("decision");
    setError(null);
    try {
      const saved = await runtime.decideFinding({
        findingId: finding.id,
        expectedRevision: finding.revision,
        decision,
      });
      setSnapshot((current) =>
        current === null
          ? current
          : {
              ...current,
              findings: current.findings.map((item) =>
                item.id === saved.id
                  ? {
                      ...item,
                      status: saved.status,
                      revision: saved.revision,
                      decidedAt: saved.decidedAt,
                    }
                  : item,
              ),
            },
      );
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function prepareRepair(
    finding: ConsistencyInvestigationFinding,
    targetChapterId: string,
  ): Promise<void> {
    if (snapshot === null) return;
    setBusy("repair_prepare");
    setError(null);
    setRepairNotice(null);
    try {
      setRepairDisclosure(
        await runtime.prepareRepairCandidate({
          runId: snapshot.run.id,
          findingId: finding.id,
          targetChapterId,
        }),
      );
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function runRepair(): Promise<void> {
    const prepared = repairDisclosure;
    if (prepared === null) return;
    // This confirmation is one-shot in the UI as well as the service. A
    // failure or uncertain result cannot be submitted again accidentally.
    setRepairDisclosure(null);
    setBusy("repair_run");
    setError(null);
    setRepairNotice(null);
    try {
      const result = await runtime.runRepairCandidate({
        taskId: prepared.taskId,
        humanConfirmed: true,
      });
      setRepairNotice(`已生成《${result.chapterTitle}》的隔离修复建议。正文尚未改变。`);
      await onOpenCandidate?.(result);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  async function cancelRepair(): Promise<void> {
    const taskId = repairDisclosure?.taskId;
    if (taskId === undefined) return;
    setRepairDisclosure(null);
    setBusy("repair_cancel");
    setError(null);
    try {
      await runtime.cancelRepairCandidate(taskId);
      setRepairNotice("已取消这次修复建议，正文没有发送或改变。");
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(null);
    }
  }

  const normalizedError =
    error === null
      ? null
      : error instanceof ConsistencyInvestigationError
        ? {
            title: "调查准备未完成",
            description: error.message,
            code: error.code,
          }
        : normalizeUiError(error);
  const active =
    snapshot !== null &&
    ["planned", "dispatched", "observing", "verifying"].includes(snapshot.run.status);

  return (
    <section aria-labelledby="consistency-investigation-heading">
      <div className="section-heading">
        <div>
          <h2 id="consistency-investigation-heading">长篇一致性调查</h2>
          <p>
            按需通读当前已接受正文与已确认设定，输出带精确来源的跨章问题。进入此页不会向模型发送内容。
          </p>
        </div>
        {snapshot !== null && <RunStatusBadge run={snapshot.run} />}
      </div>

      <Card>
        <CardHeader>
          <CardTitle headingLevel={3}>只读深入调查</CardTitle>
          <CardDescription>
            本地检索和核验固定使用 5 个只读步骤；最多向模型服务发送 1 次、自动重试 0
            次。结果不会改写正文或不会被改动的历史版本。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="settings-actions">
            <Button
              variant="ai-primary"
              loading={busy === "prepare"}
              disabled={busy !== null || active || disclosure !== null}
              onClick={() => void prepare()}
            >
              {snapshot === null ? "查看范围与费用" : "开始新的调查"}
            </Button>
            {active && (
              <Button
                variant="secondary"
                loading={busy === "cancel"}
                disabled={busy !== null}
                onClick={() => void cancel()}
              >
                取消调查
              </Button>
            )}
          </div>
          {busy === "prepare" && (
            <p role="status" aria-live="polite">
              正在整理调查范围和费用，请稍候。
            </p>
          )}
        </CardContent>
      </Card>

      {disclosure !== null && (
        <section
          ref={disclosureSectionRef}
          tabIndex={-1}
          aria-labelledby="consistency-disclosure-heading"
        >
          <Card>
            <CardHeader>
              <CardTitle id="consistency-disclosure-heading" headingLevel={3}>
                发送确认摘要
              </CardTitle>
              <CardDescription>只有点击下方确认按钮才会向所选模型服务发送内容。</CardDescription>
            </CardHeader>
            <CardContent>
              <p>
                模型：{disclosure.connectionDisplayName} · {disclosure.modelId}；资料：
                {disclosure.chapterCount} 章已接受正文与已确认设定；预计发送{" "}
                {disclosure.maximumModelCalls} 次；{formatCostSummary(disclosure)}
                ；私密内容：
                {disclosure.includesPrivateContent
                  ? "包含私密章节，只在本机处理"
                  : "不包含私密章节"}
                。
              </p>
              <details className="candidate-panel__disclosure-details">
                <summary>查看详细信息</summary>
                <dl className="settings-definition-list">
                  <div>
                    <dt>提供方与模型</dt>
                    <dd>
                      {disclosure.connectionDisplayName} · {disclosure.modelId}
                    </dd>
                  </div>
                  <div>
                    <dt>发送位置</dt>
                    <dd>{destinationLabel(disclosure.dataDestination)}</dd>
                  </div>
                  <div>
                    <dt>范围</dt>
                    <dd>
                      {disclosure.chapterCount} 章；预计输入约 {disclosure.estimatedInputTokens}{" "}
                      个文字量单位（不是金额）
                    </dd>
                  </div>
                  <div>
                    <dt>发送与重试</dt>
                    <dd>
                      最多 {disclosure.maximumModelCalls} 次；自动重试{" "}
                      {disclosure.automaticRetryCount} 次
                    </dd>
                  </div>
                  <div>
                    <dt>最长等待</dt>
                    <dd>{Math.round(disclosure.maximumDurationMs / 1000)} 秒</dd>
                  </div>
                  <div>
                    <dt>费用上限</dt>
                    <dd>{formatCost(disclosure)}</dd>
                  </div>
                </dl>
                <div className="settings-grid">
                  <div>
                    <h4>会发送</h4>
                    <ul className="privacy-list">
                      {disclosure.sends.map((item) => (
                        <li key={item}>{plainLanguageDisclosure(item)}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4>不会发送</h4>
                    <ul className="privacy-list">
                      {disclosure.doesNotSend.map((item) => (
                        <li key={item}>{plainLanguageDisclosure(item)}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <InlineAlert
                  title="隐私与中断规则"
                  description={plainLanguageDisclosure(
                    `${disclosure.privacy} ${disclosure.interruption}`,
                  )}
                />
              </details>
              <div className="settings-actions">
                <Button
                  variant="ai-primary"
                  loading={busy === "run"}
                  disabled={busy !== null}
                  onClick={() => void run()}
                >
                  确认并开始 1 次调查
                </Button>
                <Button
                  variant="secondary"
                  loading={busy === "cancel"}
                  disabled={busy !== null}
                  onClick={() => void cancel()}
                >
                  不发送并取消
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      )}

      {normalizedError !== null && (
        <div>
          <InlineAlert
            tone="error"
            title={normalizedError.title}
            description={`${normalizedError.description} 正文和不会被改动的历史版本没有改变。${
              errorSupportId === null ? "" : ` 问题编号：${errorSupportId}（联系支持时提供）。`
            }`}
          />
          {errorSupportId !== null && (
            <div className="settings-actions">
              <Button disabled={busy !== null} onClick={() => void prepare()}>
                重新整理范围与费用
              </Button>
            </div>
          )}
        </div>
      )}

      {repairNotice !== null && <InlineAlert title="修复建议" description={repairNotice} />}

      {repairDisclosure !== null && (
        <Card>
          <CardHeader>
            <CardTitle headingLevel={3}>修复建议发送确认摘要</CardTitle>
            <CardDescription>
              这是调查之外的一次独立模型动作。确认前不会向模型发送内容，也不会创建 AI 建议草稿。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p>
              作品章节：《{repairDisclosure.targetChapterTitle}》；模型：
              {repairDisclosure.connectionDisplayName} · {repairDisclosure.modelId}
              ；资料：当前章节正文与调查证据；预计发送 {repairDisclosure.maximumModelCalls} 次；
              {formatCostSummary(repairDisclosure)}
              ；私密内容：
              {repairDisclosure.includesPrivateContent
                ? "包含私密章节，只在本机处理"
                : "不包含私密章节"}
              。
            </p>
            <details className="candidate-panel__disclosure-details">
              <summary>查看详细信息</summary>
              <dl className="settings-definition-list">
                <div>
                  <dt>目标与任务</dt>
                  <dd>
                    《{repairDisclosure.targetChapterTitle}》· {repairDisclosure.taskLabel}
                  </dd>
                </div>
                <div>
                  <dt>提供方与模型</dt>
                  <dd>
                    {repairDisclosure.connectionDisplayName} · {repairDisclosure.modelId}
                  </dd>
                </div>
                <div>
                  <dt>发送位置</dt>
                  <dd>{destinationLabel(repairDisclosure.dataDestination)}</dd>
                </div>
                <div>
                  <dt>范围</dt>
                  <dd>
                    预计发送给 AI 的文字量约 {repairDisclosure.estimatedInputTokens} 个单位；AI
                    返回的文字量上限 {repairDisclosure.maximumOutputTokens} 个单位（这不是金额）
                  </dd>
                </div>
                <div>
                  <dt>发送与重试</dt>
                  <dd>
                    精确 {repairDisclosure.maximumModelCalls} 次；自动重试{" "}
                    {repairDisclosure.automaticRetryCount} 次
                  </dd>
                </div>
                <div>
                  <dt>费用上限</dt>
                  <dd>{formatCost(repairDisclosure)}</dd>
                </div>
              </dl>
              <div className="settings-grid">
                <div>
                  <h4>会发送</h4>
                  <ul className="privacy-list">
                    {repairDisclosure.sends.map((item) => (
                      <li key={item}>{plainLanguageDisclosure(item)}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4>不会发送</h4>
                  <ul className="privacy-list">
                    {repairDisclosure.doesNotSend.map((item) => (
                      <li key={item}>{plainLanguageDisclosure(item)}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <InlineAlert
                title="隐私与中断规则"
                description={plainLanguageDisclosure(
                  `${repairDisclosure.privacy} ${repairDisclosure.interruption}`,
                )}
              />
            </details>
            <div className="settings-actions">
              <Button
                variant="ai-primary"
                loading={busy === "repair_run"}
                disabled={busy !== null}
                onClick={() => void runRepair()}
              >
                确认并生成 1 个隔离修复建议
              </Button>
              <Button
                variant="secondary"
                loading={busy === "repair_cancel"}
                disabled={busy !== null}
                onClick={() => void cancelRepair()}
              >
                不发送并取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {snapshot !== null && (
        <InvestigationResult
          snapshot={snapshot}
          findings={filteredFindings}
          severity={severity}
          category={category}
          authority={authority}
          decisionBusy={busy === "decision"}
          repairBusy={busy === "repair_prepare" || busy === "repair_run"}
          onSeverity={setSeverity}
          onCategory={setCategory}
          onAuthority={setAuthority}
          onDecide={(finding, decision) => void decide(finding, decision)}
          onPrepareRepair={(finding, targetChapterId) =>
            void prepareRepair(finding, targetChapterId)
          }
        />
      )}

      {history.length > 0 && (
        <details>
          <summary>历史调查（{history.length}）</summary>
          <ul className="chapter-check-history">
            {history.map((run) => (
              <li key={run.id}>
                <button
                  className="button-link button-link--secondary"
                  type="button"
                  onClick={() => void openRun(run.id)}
                >
                  {STATUS_LABELS[run.status]} · {formatTimestamp(run.createdAt)} ·{" "}
                  {run.findingCount} 项
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function InvestigationResult({
  snapshot,
  findings,
  severity,
  category,
  authority,
  decisionBusy,
  repairBusy,
  onSeverity,
  onCategory,
  onAuthority,
  onDecide,
  onPrepareRepair,
}: {
  readonly snapshot: ConsistencyInvestigationSnapshot;
  readonly findings: readonly ConsistencyInvestigationFinding[];
  readonly severity: "all" | ConsistencyInvestigationFindingSeverity;
  readonly category: "all" | ConsistencyInvestigationFindingCategory;
  readonly authority: "all" | ConsistencyInvestigationFinding["authorityGroup"];
  readonly decisionBusy: boolean;
  readonly repairBusy: boolean;
  readonly onSeverity: (value: "all" | ConsistencyInvestigationFindingSeverity) => void;
  readonly onCategory: (value: "all" | ConsistencyInvestigationFindingCategory) => void;
  readonly onAuthority: (value: "all" | ConsistencyInvestigationFinding["authorityGroup"]) => void;
  readonly onDecide: (
    finding: ConsistencyInvestigationFinding,
    decision: "ignored" | "allowed",
  ) => void;
  readonly onPrepareRepair: (
    finding: ConsistencyInvestigationFinding,
    targetChapterId: string,
  ) => void;
}) {
  const terminalMessage = statusMessage(snapshot.run);
  return (
    <div className="chapter-check-results">
      <InlineAlert
        tone={terminalMessage.tone}
        title={terminalMessage.title}
        description={terminalMessage.description}
      />
      <InvestigationTaskGraph snapshot={snapshot} />
      {snapshot.run.summary !== null && <p>{snapshot.run.summary}</p>}
      {snapshot.findings.length > 0 && (
        <div className="chapter-check-runner" aria-label="调查结果筛选">
          <Select
            aria-label="严重程度"
            value={severity}
            options={[
              { value: "all", label: "全部严重程度" },
              { value: "error", label: "需要处理" },
              { value: "warning", label: "建议复核" },
              { value: "info", label: "提示" },
            ]}
            onChange={(event) => onSeverity(event.currentTarget.value as typeof severity)}
          />
          <Select
            aria-label="问题类别"
            value={category}
            options={[
              { value: "all", label: "全部类别" },
              ...Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
            ]}
            onChange={(event) => onCategory(event.currentTarget.value as typeof category)}
          />
          <Select
            aria-label="证据权限"
            value={authority}
            options={[
              { value: "all", label: "全部证据权限" },
              ...Object.entries(AUTHORITY_LABELS).map(([value, label]) => ({ value, label })),
            ]}
            onChange={(event) => onAuthority(event.currentTarget.value as typeof authority)}
          />
        </div>
      )}
      {snapshot.findings.length === 0 ? (
        <EmptyState
          title="没有可显示的已核验证据问题"
          description="这只表示本次选择范围内没有形成结论；被省略或证据不足的内容仍然未知。"
        />
      ) : findings.length === 0 ? (
        <EmptyState title="当前筛选没有结果" description="调整严重程度或类别筛选查看其他问题。" />
      ) : (
        findings.map((finding) => (
          <FindingCard
            key={finding.id}
            finding={finding}
            chapterTitles={snapshot.chapterTitles ?? {}}
            disabled={decisionBusy || repairBusy}
            onDecide={(decision) => onDecide(finding, decision)}
            onPrepareRepair={(targetChapterId) => onPrepareRepair(finding, targetChapterId)}
          />
        ))
      )}
    </div>
  );
}

function InvestigationTaskGraph({
  snapshot,
}: {
  readonly snapshot: ConsistencyInvestigationSnapshot;
}) {
  const graph = projectConsistencyInvestigationTaskGraph(snapshot);
  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={3}>只读任务图</CardTitle>
        <CardDescription>
          由本次调查已经保存的步骤重建，只用于说明发生了什么；查看或重启应用都不会触发调用。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {graph.previousAttemptId !== null && (
          <InlineAlert
            title="这是重新开始的一次独立调查"
            description="上一次调查不会被续跑，也不会因为打开此结果而自动重发。"
          />
        )}
        <ol
          className="chapter-check-history consistency-investigation-task-graph"
          aria-label="只读调查任务图"
        >
          {graph.nodes.map((node) => (
            <li key={node.id}>
              <div className="card-heading-row">
                <strong>{taskGraphStageLabel(node)}</strong>
                <Badge tone={taskGraphStatusTone(node.status)}>
                  {taskGraphStatusLabel(node.status)}
                </Badge>
              </div>
              <p>{taskGraphSafeSummary(node)}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function taskGraphStageLabel(node: InvestigationTaskGraphNode): string {
  if (
    node.kind === "result" &&
    ["ambiguous", "failed", "cancelled", "not_dispatched"].includes(node.status)
  ) {
    return "阻断";
  }
  return {
    goal: "目标",
    plan: "计划",
    action: "行动",
    tool: "工具",
    observation: "观察",
    verification: "核验",
    result: "结果",
  }[node.kind];
}

function taskGraphStatusLabel(status: InvestigationTaskGraphNode["status"]): string {
  return {
    planned: "等待确认",
    reserved: "已规划",
    bound: "已绑定",
    dispatched: "已发送",
    observing: "整理中",
    verifying: "核验中",
    succeeded: "已完成",
    partial: "部分完成",
    failed: "结果不可用",
    cancelled: "已取消",
    not_dispatched: "未发送",
    ambiguous: "结果不确定",
  }[status];
}

function taskGraphStatusTone(
  status: InvestigationTaskGraphNode["status"],
): "neutral" | "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "ambiguous" || status === "failed") return "danger";
  if (status === "partial" || status === "not_dispatched" || status === "cancelled")
    return "warning";
  return "neutral";
}

function taskGraphSafeSummary(node: InvestigationTaskGraphNode): string {
  const summary = node.safeSummary;
  if (node.kind === "goal") {
    return `核对 ${safeCount(summary.chapterCount)} 章当前已接受正文与已确认设定的一致性。`;
  }
  if (node.kind === "plan") {
    return `最多 ${safeCount(summary.maximumToolSteps)} 个只读本地步骤，最多向模型服务发送 ${safeCount(summary.maximumModelCalls)} 次，自动重试 ${safeCount(summary.automaticRetryCount)} 次。`;
  }
  if (node.kind === "action") {
    const ordinal = safeCount(summary.ordinal);
    if (summary.permission === "model_dispatch")
      return `第 ${ordinal} 步：执行一次已授权的模型整理。`;
    if (summary.permission === "local_verify") return `第 ${ordinal} 步：在本地逐项核验证据。`;
    return `第 ${ordinal} 步：执行只读本地检查。`;
  }
  if (node.kind === "tool") {
    return `${taskGraphToolLabel(summary.name)}；${taskGraphPermissionLabel(summary.permission)}。`;
  }
  if (node.kind === "observation") return taskGraphObservationSummary(node);
  if (node.kind === "verification") {
    return `形成 ${safeCount(summary.total)} 项结论，其中 ${safeCount(summary.withEvidence)} 项带精确证据；${safeCount(summary.ignored)} 项已忽略，${safeCount(summary.allowed)} 项已标记为有意安排。`;
  }
  return taskGraphResultSummary(node);
}

function taskGraphObservationSummary(node: InvestigationTaskGraphNode): string {
  if (node.status === "ambiguous") return "已越过网络边界，但结果无法确认；不会自动重发。";
  if (node.status === "failed") return "该步骤没有形成可信结果，后续操作已安全终止。";
  if (node.status === "not_dispatched") return "该步骤在发送前终止，没有向模型发送内容。";
  if (node.status === "cancelled") return "该步骤已取消，重启后不会自动续跑。";
  if (node.status === "dispatched") return "已发送一次请求，正在等待可确认的结果。";
  if (node.status === "reserved" || node.status === "bound" || node.status === "planned")
    return "步骤已经规划，但尚未形成观察结果。";
  if (node.safeSummary.hasObservation === true)
    return "已记录内容无关的执行回执；任务图不保存正文片段。";
  return "步骤已完成，任务图没有保存正文内容。";
}

function taskGraphResultSummary(node: InvestigationTaskGraphNode): string {
  const summary = node.safeSummary;
  if (node.status === "ambiguous")
    return "请求可能已经发出，暂时无法确认结果。系统没有自动重发；正文和不会被改动的历史版本没有改变。";
  if (node.status === "failed")
    return "结果未通过格式或本地证据核验；正文和不会被改动的历史版本没有改变。";
  if (node.status === "cancelled") return "调查已取消，未完成步骤不会在重启后自动续跑。";
  if (node.status === "not_dispatched") return "调查在发送前终止，本次没有发送正文。";
  if (node.status === "partial")
    return `部分完成：保留 ${safeCount(summary.findingCount)} 项已核验结论，丢弃 ${safeCount(summary.droppedFindingCount)} 项证据不足的结论。`;
  if (node.status === "succeeded")
    return `调查完成：${safeCount(summary.findingCount)} 项结论已通过当前证据核验。`;
  return "调查仍在进行，尚未形成最终结果。";
}

function taskGraphToolLabel(value: unknown): string {
  return TASK_GRAPH_TOOL_LABELS[typeof value === "string" ? value : ""] ?? "执行受控调查步骤";
}

function taskGraphPermissionLabel(value: unknown): string {
  if (value === "model_dispatch") return "仅限一次已确认发送";
  if (value === "local_verify") return "仅在本地核验";
  return "仅在本地只读访问";
}

function safeCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "0";
}

function FindingCard({
  finding,
  chapterTitles,
  disabled,
  onDecide,
  onPrepareRepair,
}: {
  readonly finding: ConsistencyInvestigationFinding;
  readonly chapterTitles: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onDecide: (decision: "ignored" | "allowed") => void;
  readonly onPrepareRepair: (targetChapterId: string) => void;
}) {
  const repairTargets = uniqueRepairTargets(finding, chapterTitles);
  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle headingLevel={3}>{finding.title}</CardTitle>
            <CardDescription>
              {CATEGORY_LABELS[finding.category]} · {AUTHORITY_LABELS[finding.authorityGroup]} ·{" "}
              {finding.evidence.length} 条精确来源
            </CardDescription>
          </div>
          <Badge
            tone={
              finding.severity === "error"
                ? "danger"
                : finding.severity === "warning"
                  ? "warning"
                  : "neutral"
            }
          >
            {SEVERITY_LABELS[finding.severity]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <p>{finding.explanation}</p>
        <details>
          <summary>查看证据（{finding.evidence.length}）</summary>
          <ul className="privacy-list">
            {finding.evidence.map((evidence, index) => (
              <li key={`${evidence.excerptDigest}:${String(index)}`}>
                <strong>{evidence.sourceKind === "chapter" ? "已接受正文" : "已确认事实"}</strong>
                {evidence.chapterId === null
                  ? ""
                  : ` · 《${chapterTitles[evidence.chapterId] ?? "来源章节"}》`}
                {evidence.immutableVersionId === null ? "" : " · 已接受版本"}
                {evidence.locator.kind === "utf16"
                  ? ` · 位置 ${String(evidence.locator.startOffset)}–${String(evidence.locator.endOffset)}`
                  : " · 已确认来源"}
              </li>
            ))}
          </ul>
        </details>
        {finding.status === "pending" ? (
          <div className="settings-actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onDecide("ignored")}
            >
              忽略
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => onDecide("allowed")}
            >
              标记为有意安排
            </Button>
          </div>
        ) : (
          <Badge tone="neutral">
            {finding.status === "ignored" ? "已忽略" : "已标记为有意安排"}
          </Badge>
        )}
        {finding.status === "pending" && repairTargets.length > 0 && (
          <div className="settings-actions" aria-label="生成隔离修复建议">
            {repairTargets.map(({ chapterId, title }) => (
              <Button
                key={chapterId}
                size="sm"
                variant="secondary"
                disabled={disabled}
                onClick={() => onPrepareRepair(chapterId)}
              >
                查看《{title}》修复范围与费用
              </Button>
            ))}
          </div>
        )}
        {finding.status === "pending" && repairTargets.length === 0 && (
          <p className="text-muted">
            这条结论没有可作为修改目标的当前正文来源，因此不会生成修复建议。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function uniqueRepairTargets(
  finding: ConsistencyInvestigationFinding,
  chapterTitles: Readonly<Record<string, string>>,
): readonly Readonly<{ chapterId: string; title: string }>[] {
  const targets = new Map<string, string>();
  for (const evidence of finding.evidence) {
    if (
      evidence.sourceKind !== "chapter" ||
      evidence.chapterId === null ||
      evidence.immutableVersionId === null ||
      evidence.currentness !== "current"
    ) {
      continue;
    }
    targets.set(evidence.chapterId, chapterTitles[evidence.chapterId] ?? "来源章节");
  }
  return Object.freeze(
    [...targets].map(([chapterId, title]) => Object.freeze({ chapterId, title })),
  );
}

function RunStatusBadge({ run }: { readonly run: ConsistencyInvestigationRun }) {
  const tone =
    run.status === "succeeded"
      ? "success"
      : run.status === "ambiguous" || run.status === "failed"
        ? "danger"
        : run.status === "partial" || run.status === "not_dispatched"
          ? "warning"
          : "neutral";
  return <Badge tone={tone}>{STATUS_LABELS[run.status]}</Badge>;
}

function statusMessage(run: ConsistencyInvestigationRun): Readonly<{
  tone: "info" | "warning" | "error";
  title: string;
  description: string;
}> {
  if (run.status === "ambiguous")
    return {
      tone: "error",
      title: "请求可能已经发出，暂时无法确认结果",
      description:
        "内容已经发送给所选模型服务，但应用无法确认结果。请先查看模型使用记录；正文和版本未改变。",
    };
  if (run.status === "not_dispatched")
    return {
      tone: "warning",
      title: "本次没有发送正文",
      description: "调查在模型发送前终止。可以查看配置后手动开始一次新的调查。",
    };
  if (run.status === "cancelled")
    return {
      tone: "warning",
      title: "调查已取消",
      description: "未完成的步骤已终结，不会在重启后自动发送。",
    };
  if (run.status === "failed")
    return {
      tone: "error",
      title: "模型返回无法形成可信结果",
      description: "已发送请求的记录仍保留，但格式或本地核验失败；正文和版本未改变。",
    };
  if (run.status === "partial")
    return {
      tone: "warning",
      title: "调查部分完成",
      description: `${String(run.findingCount)} 项通过证据核验，另有 ${String(run.droppedFindingCount)} 项因证据不足被丢弃。`,
    };
  if (run.status === "succeeded")
    return {
      tone: "info",
      title: "调查已完成",
      description: `${String(run.findingCount)} 项结论均引用当前已接受正文或已确认事实。`,
    };
  return {
    tone: "info",
    title: "调查进行中",
    description: "每一步都有独立状态；取消或关闭应用不会触发自动重发。",
  };
}

function formatCost(
  disclosure: Readonly<{
    estimatedMaximumCostMicros: string | null;
    currency: string | null;
  }>,
): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null)
    return "服务商没有提供可计算的单价，实际费用请以服务商账单为准。";
  const padded = disclosure.estimatedMaximumCostMicros.padStart(7, "0");
  const whole = padded.slice(0, -6);
  const fraction = padded.slice(-6).replace(/0+$/u, "");
  return `${disclosure.currency} ${whole}${fraction.length === 0 ? "" : `.${fraction}`}（估算上限）`;
}

function formatCostSummary(
  disclosure: Readonly<{
    estimatedMaximumCostMicros: string | null;
    currency: string | null;
  }>,
): string {
  if (disclosure.estimatedMaximumCostMicros === null || disclosure.currency === null) {
    return "费用：暂时无法计算";
  }
  return "费用上限：" + formatCost(disclosure);
}

function destinationLabel(destination: "local" | "remote"): string {
  return destination === "local" ? "仅发送到当前已验证的本机模型" : "发送到所选远程 AI 服务";
}

function plainLanguageDisclosure(value: string): string {
  return value
    .replaceAll("API Key 或", "接口密钥或")
    .replaceAll("API Key、", "接口密钥、")
    .replaceAll("API Key", "接口密钥")
    .replaceAll(/未接受\s+candidates?/giu, "未接受隔离建议")
    .replaceAll(/其他\s+candidates?/giu, "其他隔离建议")
    .replaceAll(/candidates?/giu, "隔离建议")
    .replaceAll(/tokens?/giu, "文字量单位（不是金额）")
    .replaceAll(/invocations?/giu, "模型使用记录")
    .replaceAll(/providers?/giu, "模型服务")
    .replaceAll(/agents?/giu, "智能流程");
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString("zh-CN");
}
