import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  InlineAlert,
} from "@inkshadow/ui";

import type {
  ContextCompilationTrace,
  ContextCompilationTraceStore,
  ContextCompilationTraceSummary,
} from "../infrastructure/context-compilation-trace-store";
import { normalizeUiError, UiActionError } from "../infrastructure/ui-error";

export interface ContextHistoryPanelProps {
  readonly projectId: string;
  readonly store: ContextCompilationTraceStore;
}

export function ContextHistoryPanel({ projectId, store }: ContextHistoryPanelProps) {
  const [summaries, setSummaries] = useState<readonly ContextCompilationTraceSummary[]>([]);
  const [selected, setSelected] = useState<ContextCompilationTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSummaries(await store.listByProjectId(projectId, 50));
      setError(null);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [projectId, store]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setSelected(null);
        void load();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function inspect(id: string): Promise<void> {
    setDetailLoading(true);
    try {
      const trace = await store.findById(id);
      if (trace?.projectId !== projectId) {
        throw new UiActionError(
          "CONTEXT_TRACE_NOT_FOUND",
          "这条上下文记录已不存在，请刷新列表后重试。",
        );
      }
      setSelected(trace);
      setError(null);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setDetailLoading(false);
    }
  }

  const normalizedError = error === null ? null : normalizeUiError(error);

  return (
    <section aria-labelledby="context-history-title" className="context-history-panel">
      <div className="section-heading">
        <div>
          <h2 id="context-history-title">AI 本次参考了什么</h2>
          <p>查看每次创作采用和舍弃的资料、来源与预算。记录不保存正文、提示词或模型回复。</p>
        </div>
        <Button size="sm" variant="secondary" disabled={loading} onClick={() => void load()}>
          刷新记录
        </Button>
      </div>

      {normalizedError !== null && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={`${normalizedError.description} 正文和已有 AI 建议版本均未改变。`}
          action={{ label: "重试", onClick: () => void load() }}
          onDismiss={() => setError(null)}
        />
      )}

      {loading && summaries.length === 0 ? (
        <p role="status">正在读取上下文记录…</p>
      ) : summaries.length === 0 ? (
        <EmptyState
          title="还没有上下文记录"
          description="第一次使用“继续创作”等 AI 功能后，这里会显示 AI 采用了哪些设定，以及哪些资料因为预算或相关性被舍弃。"
        />
      ) : (
        <div className="story-governance-grid">
          {summaries.map((summary) => (
            <Card key={summary.id}>
              <CardHeader>
                <div className="card-heading-row">
                  <CardTitle>{taskLabel(summary.taskType)}</CardTitle>
                  <Badge tone={summary.discardedCount > 0 ? "warning" : "success"}>
                    {summary.includedCount} 项采用
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p>
                  预算使用 {summary.usedTokens.toLocaleString("zh-CN")}/
                  {summary.maximumContextTokens.toLocaleString("zh-CN")}；舍弃{" "}
                  {summary.discardedCount}
                  项。
                </p>
                <p className="candidate-panel__hint">
                  {formatTimestamp(summary.createdAt)} ·{" "}
                  {tokenSourceLabel(summary.tokenEstimateSource)}
                </p>
                {summary.outputCandidateId !== null && (
                  <p>
                    <Badge tone="ai">已精确关联 AI 建议版本</Badge>
                  </p>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  loading={detailLoading && selected?.id !== summary.id}
                  disabled={detailLoading}
                  onClick={() => void inspect(summary.id)}
                >
                  查看采用与舍弃原因
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {selected !== null && (
        <Card>
          <CardHeader>
            <div className="card-heading-row">
              <div>
                <CardTitle>本次资料选择明细</CardTitle>
                <p>{formatTimestamp(selected.createdAt)}，按实际评估顺序排列。</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                收起
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {selected.outputCandidateId !== null && (
              <InlineAlert
                tone="info"
                title="这条记录与 AI 建议版本精确关联"
                description={`建议版本标识：${selected.outputCandidateId}`}
              />
            )}
            <div className="story-governance-grid">
              {selected.entries.map((entry) => (
                <article className="context-history-entry" key={entry.contextCandidateId}>
                  <div className="card-heading-row">
                    <strong>{layerLabel(entry.layer)}</strong>
                    <Badge tone={entry.included ? "success" : "neutral"}>
                      {entry.included ? "已采用" : "未采用"}
                    </Badge>
                  </div>
                  <p>
                    {entry.included ? entry.selectionReason : discardLabel(entry.discardedReason)}
                  </p>
                  <p className="candidate-panel__hint">
                    估算 {entry.estimatedTokens.toLocaleString("zh-CN")} 个用量单位；处理前剩余
                    {entry.budgetRemainingBefore.toLocaleString("zh-CN")}，处理后剩余
                    {entry.budgetRemainingAfter.toLocaleString("zh-CN")}。
                  </p>
                  <details>
                    <summary>查看来源标识（{entry.sources.length}）</summary>
                    <ul>
                      {entry.sources.map((source, index) => (
                        <li key={`${entry.contextCandidateId}-${String(index)}`}>
                          {sourceTypeLabel(source.sourceType)} · {source.sourceId}
                          {source.sourceVersionId === null
                            ? ""
                            : ` · 版本 ${source.sourceVersionId}`}
                          {source.locator === null ? "" : ` · ${source.locator}`}
                        </li>
                      ))}
                    </ul>
                  </details>
                </article>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function taskLabel(taskType: string): string {
  const labels: Readonly<Record<string, string>> = {
    continuation: "继续创作",
    direct_continuation: "继续创作",
    rewrite: "改写",
    outline_planning: "规划故事",
    scene_breakdown: "拆分场景",
  };
  return labels[taskType] ?? "AI 创作";
}

function layerLabel(layer: ContextCompilationTrace["entries"][number]["layer"]): string {
  const labels: Readonly<Record<typeof layer, string>> = {
    locked_hard_rules: "锁定的故事规则",
    current_task: "当前创作任务",
    scene_goal: "当前场景目标",
    pov_known_information: "视角人物知道的内容",
    character_current_state: "人物当前状态",
    recent_events: "最近事件",
    related_causal_chain: "相关事件链",
    unresolved_foreshadowing: "未回收伏笔",
    world_setting: "相关世界设定",
    character_voice_samples: "人物说话样例",
    semantic_retrieval: "语义记忆",
    rerank_supplement: "再次核对后的补充资料",
  };
  return labels[layer];
}

function sourceTypeLabel(
  sourceType: ContextCompilationTrace["entries"][number]["sources"][number]["sourceType"],
): string {
  const labels: Readonly<Record<typeof sourceType, string>> = {
    user_input: "用户输入",
    generation_task: "当前任务",
    scene_plan: "场景计划",
    chapter: "章节版本",
    outline: "故事规划",
    character: "人物设定",
    relationship: "人物关系",
    world: "世界设定",
    timeline_event: "时间线事件",
    causal_event: "故事事件",
    foreshadow: "伏笔",
    story_rule: "故事规则",
    memory: "AI 记住的内容",
    search_document: "语义记忆",
    rerank_result: "资料复核",
    import: "导入内容",
    other: "其他已确认资料",
  };
  return labels[sourceType];
}

function discardLabel(reason: string | null): string {
  const labels: Readonly<Record<string, string>> = {
    token_budget_exhausted: "本次上下文预算不足，未发送给模型。",
  };
  return reason === null ? "本次未采用。" : (labels[reason] ?? `未采用：${reason}`);
}

function tokenSourceLabel(source: ContextCompilationTraceSummary["tokenEstimateSource"]): string {
  if (source === "provider_tokenizer") return "供应商精确计数";
  if (source === "custom") return "自定义计数器";
  return "本机保守估算";
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
