import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import type {
  NovelSkillInvocationLookup,
  NovelSkillRuntimePort,
} from "../infrastructure/novel-skill-runtime";
import { normalizeUiError, UiActionError } from "../infrastructure/ui-error";
import { NovelSkillInvocationReference } from "./novel-skill-reference";

export interface ContextHistoryPanelProps {
  readonly projectId: string;
  readonly store: ContextCompilationTraceStore;
  readonly novelSkills: Pick<NovelSkillRuntimePort, "findInvocationByContextTrace">;
}

export function ContextHistoryPanel({ projectId, store, novelSkills }: ContextHistoryPanelProps) {
  const operationRevision = useRef(0);
  const projectIdentity = useRef(projectId);
  const [summaries, setSummaries] = useState<readonly ContextCompilationTraceSummary[]>([]);
  const [selected, setSelected] = useState<ContextCompilationTrace | null>(null);
  const [selectedNovelSkills, setSelectedNovelSkills] = useState<NovelSkillInvocationLookup | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useLayoutEffect(() => {
    if (projectIdentity.current !== projectId) {
      projectIdentity.current = projectId;
      operationRevision.current += 1;
    }
  }, [projectId]);

  const load = useCallback(async () => {
    const revision = operationRevision.current + 1;
    operationRevision.current = revision;
    const expectedProjectId = projectId;
    const isCurrent = (): boolean =>
      operationRevision.current === revision && projectIdentity.current === expectedProjectId;
    setLoading(true);
    setDetailLoading(false);
    setSelected(null);
    setSelectedNovelSkills(null);
    try {
      const next = await store.listByProjectId(projectId, 50);
      if (isCurrent()) {
        setSummaries(next);
        setError(null);
      }
    } catch (cause: unknown) {
      if (isCurrent()) setError(cause);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [projectId, store]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setSelected(null);
        setSelectedNovelSkills(null);
        setDetailLoading(false);
        void load();
      }
    });
    return () => {
      cancelled = true;
      operationRevision.current += 1;
    };
  }, [load]);

  async function inspect(id: string): Promise<void> {
    const revision = operationRevision.current + 1;
    operationRevision.current = revision;
    const expectedProjectId = projectId;
    const isCurrent = (): boolean =>
      operationRevision.current === revision && projectIdentity.current === expectedProjectId;
    setDetailLoading(true);
    try {
      const [trace, skillLookup] = await Promise.all([
        store.findById(id),
        loadNovelSkillLookup(novelSkills, id),
      ]);
      if (!isCurrent()) return;
      if (trace?.projectId !== expectedProjectId) {
        throw new UiActionError(
          "CONTEXT_TRACE_NOT_FOUND",
          "这条上下文记录已不存在，请刷新列表后重试。",
        );
      }
      setSelected(trace);
      setSelectedNovelSkills(skillLookup);
      setError(null);
    } catch (cause: unknown) {
      if (isCurrent()) setError(cause);
    } finally {
      if (isCurrent()) setDetailLoading(false);
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
                  估算输入内容额度 {summary.usedTokens.toLocaleString("zh-CN")}/
                  {summary.maximumContextTokens.toLocaleString("zh-CN")}；未发送{" "}
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
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelected(null);
                  setSelectedNovelSkills(null);
                }}
              >
                收起
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {selected.outputCandidateId !== null && (
              <InlineAlert
                tone="info"
                title="这条记录与 AI 建议版本精确关联"
                description="你可以回到对应章节查看、比较或处理这份建议；普通界面不会显示内部标识。"
              />
            )}
            {selectedNovelSkills?.status === "found" && (
              <NovelSkillInvocationReference invocation={selectedNovelSkills.invocation} />
            )}
            {selectedNovelSkills?.status === "not_found" && (
              <InlineAlert
                tone="info"
                title="这次没有可追溯的写作方法收据"
                description="这可能是启用写作方法之前生成的旧记录，或使用了无法建立精确调用链的兼容路线；不会把它误报为已采用。"
              />
            )}
            {selectedNovelSkills?.status === "unavailable" && (
              <InlineAlert
                tone="info"
                title="本环境不提供写作方法收据"
                description={
                  selectedNovelSkills.availability.reason ??
                  "写作方法记录当前不可用；故事资料记录仍可正常查看。"
                }
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
                    {entry.included
                      ? adoptionReasonLabel(entry.selectionReason)
                      : discardLabel(entry.discardedReason)}
                  </p>
                  <p>
                    <strong>资料：</strong>
                    {humanReadableSourceTitle(entry)}
                  </p>
                  <p className="candidate-panel__hint">
                    为保护作品内容，历史记录只保存来源类别、选择原因与预算，不保存正文摘录。
                  </p>
                  <p className="candidate-panel__hint">
                    估算 {entry.estimatedTokens.toLocaleString("zh-CN")} 个输入内容额度；处理前剩余
                    {entry.budgetRemainingBefore.toLocaleString("zh-CN")}，处理后剩余
                    {entry.budgetRemainingAfter.toLocaleString("zh-CN")}。
                  </p>
                  <details>
                    <summary>查看来源类别（{uniqueSourceTypes(entry.sources).length}）</summary>
                    <ul>
                      {uniqueSourceTypes(entry.sources).map((sourceType) => (
                        <li key={`${entry.contextCandidateId}-${sourceType}`}>
                          {sourceTypeLabel(sourceType)}
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

async function loadNovelSkillLookup(
  novelSkills: Pick<NovelSkillRuntimePort, "findInvocationByContextTrace">,
  contextTraceId: string,
): Promise<NovelSkillInvocationLookup> {
  try {
    return await novelSkills.findInvocationByContextTrace(contextTraceId);
  } catch {
    return Object.freeze({
      status: "unavailable",
      availability: Object.freeze({
        status: "degraded",
        reason:
          "这次写作方法收据暂时无法读取；故事资料记录仍可正常查看，也不会把未知状态误报为已采用。",
      }),
      invocation: null,
    });
  }
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

function adoptionReasonLabel(reason: string): string {
  const normalized = reason.trim();
  const mergedSuffix = "Equivalent source evidence was merged.";
  if (normalized.endsWith(mergedSuffix)) {
    const base = normalized.slice(0, -mergedSuffix.length).trim();
    const baseLabel = base.length === 0 ? "本次创作采用了这项资料。" : adoptionReasonLabel(base);
    return `${baseLabel} 同一内容的其他来源依据已合并保留。`;
  }
  if (/explicitly selected this exact saved range/iu.test(normalized)) {
    return "作者明确选中了这段已保存正文，并为本次处理给出了要求。";
  }
  if (/requested an opening for the empty chapter/iu.test(normalized)) {
    return "作者明确要求为当前空白章节生成开头。";
  }
  if (/requested a continuation of the current chapter/iu.test(normalized)) {
    return "作者明确要求继续创作当前章节。";
  }
  if (/requested this exact opening proposal/iu.test(normalized)) {
    return "作者明确选择了这份开篇方案作为本次创作依据。";
  }
  if (/^The author explicitly requested\b/iu.test(normalized)) {
    return "作者明确要求本次创作采用这项资料。";
  }
  if (/confirmed these prohibitions/iu.test(normalized)) {
    return "作者已明确确认这些禁止项；它们是本次创作必须遵守的约束。";
  }
  const seedField = /confirmed this ([a-zA-Z]+) creation input/iu.exec(normalized)?.[1];
  if (seedField !== undefined) {
    const labels: Readonly<Record<string, string>> = {
      premise: "创作起点",
      genre: "小说类型",
      tone: "故事基调",
      characters: "人物资料",
      relationships: "人物关系",
      world: "世界背景",
      conflict: "核心冲突",
      style: "写作风格",
      pov: "叙事视角",
      currentDirection: "当前剧情方向",
      initialOutline: "初步大纲",
      rewriteRules: "改写规则",
    };
    return `作者已确认这项${labels[seedField] ?? "创建资料"}；采用时仍可追溯到项目创作种子。`;
  }
  if (/confirmed and locked this fact/iu.test(normalized)) {
    return "作者已确认并锁定这项设定，因此本次创作必须遵守。";
  }
  if (/authored this fact for the selected branch/iu.test(normalized)) {
    return "这项设定由作者为当前选定分支填写，只在该分支的资料范围内采用。";
  }
  if (/system-derived .* explicitly reversible/iu.test(normalized)) {
    return "这项本地整理资料可以撤销，仅作为辅助资料采用，不会成为作者确认的正式设定。";
  }
  if (/fact is formal only after explicit user confirmation/iu.test(normalized)) {
    return "这项设定已经作者明确确认，并按其资料类别用于本次创作。";
  }
  if (/current saved chapter is the immediate continuity source/iu.test(normalized)) {
    return "当前已保存章节是保持前后连续的直接依据。";
  }
  if (/most recent saved chapter tail is the immediate continuity source/iu.test(normalized)) {
    return "采用当前章节最近的已保存内容以保持连续；较早正文未纳入本次资料。";
  }
  if (/local FTS\/keyword baseline found/iu.test(normalized)) {
    return "本地关键词检索在当前已接受资料中找到与任务相关的内容。";
  }
  if (/optional local vector index supplemented/iu.test(normalized)) {
    return "本地语义索引补充了与任务相关的当前已接受资料。";
  }
  if (/local deterministic evidence reranker/iu.test(normalized)) {
    return "本地证据排序认为这项当前资料与任务相关，因此作为补充采用。";
  }
  if (/explicit Alibaba Qwen remote reranker/iu.test(normalized)) {
    return "经作者另行授权的远程资料复核选择了这项补充资料。";
  }
  if (/local read model requested a governed projection/iu.test(normalized)) {
    return "本地故事资料视图按当前任务的治理范围提供了这项资料。";
  }
  if (/bounded causal-neighbor recovery/iu.test(normalized)) {
    return "本地因果关系补充了与当前任务直接相邻的已确认事件。";
  }
  if (/scoped local retrieval step/iu.test(normalized)) {
    return "本地资料检索在当前项目、版本与隐私范围内选择了这项资料。";
  }
  if (/StoryMemoryReadModel/iu.test(normalized)) {
    return "本地故事记忆视图按当前资料范围提供了这项只读参考。";
  }
  if (/^[^A-Za-z_]+$/u.test(normalized) && /[\u3400-\u9fff]/u.test(normalized)) {
    return normalized;
  }
  return "本次创作按当前任务与资料范围采用了这项资料。";
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
    duplicate_source: "内容与更高优先级资料重复；证据已合并，没有重复发送。",
  };
  return reason === null ? "本次未采用。" : (labels[reason] ?? "因其他安全规则未采用。");
}

function uniqueSourceTypes(
  sources: ContextCompilationTrace["entries"][number]["sources"],
): readonly ContextCompilationTrace["entries"][number]["sources"][number]["sourceType"][] {
  return [...new Set(sources.map(({ sourceType }) => sourceType))];
}

function humanReadableSourceTitle(entry: ContextCompilationTrace["entries"][number]): string {
  const sourceLabels = uniqueSourceTypes(entry.sources).map(sourceTypeLabel);
  if (sourceLabels.length === 0) return layerLabel(entry.layer);
  return `${layerLabel(entry.layer)} · ${sourceLabels.join("、")}`;
}

function tokenSourceLabel(source: ContextCompilationTraceSummary["tokenEstimateSource"]): string {
  if (source === "provider_tokenizer") return "模型服务精确计数";
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
