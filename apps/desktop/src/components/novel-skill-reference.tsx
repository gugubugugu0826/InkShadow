import { Badge, InlineAlert } from "@inkshadow/ui";

import type {
  NovelSkillInvocationView,
  NovelSkillNotAppliedReason,
  NovelSkillSelectionView,
  PreparedNovelSkillInvocation,
} from "../infrastructure/novel-skill-runtime";

export function PreparedNovelSkillReference({
  preparation,
}: Readonly<{ preparation: PreparedNovelSkillInvocation }>) {
  if (preparation.status === "not_applied") {
    return (
      <InlineAlert
        tone="info"
        title="本次未应用写作方法"
        description={notAppliedDescription(preparation.notAppliedReason)}
      />
    );
  }
  return (
    <NovelSkillReferenceList
      methods={preparation.methods}
      maximumSkillTokens={preparation.maximumSkillTokens}
      usedSkillTokens={preparation.usedSkillTokens}
    />
  );
}

export function NovelSkillInvocationReference({
  invocation,
}: Readonly<{ invocation: NovelSkillInvocationView }>) {
  return (
    <NovelSkillReferenceList
      methods={invocation.methods}
      maximumSkillTokens={invocation.maximumSkillTokens}
      usedSkillTokens={invocation.usedSkillTokens}
    />
  );
}

function NovelSkillReferenceList({
  methods,
  maximumSkillTokens,
  usedSkillTokens,
}: Readonly<{
  methods: readonly NovelSkillSelectionView[];
  maximumSkillTokens: number;
  usedSkillTokens: number;
}>) {
  const included = methods.filter((method) => method.included);
  const discarded = methods.filter((method) => !method.included);
  return (
    <section aria-label="本次采用的写作方法" className="context-history-entry">
      <div className="card-heading-row">
        <div>
          <strong>本次采用的写作方法</strong>
          <p className="candidate-panel__hint">
            保守估算约 {usedSkillTokens.toLocaleString("zh-CN")}/
            {maximumSkillTokens.toLocaleString("zh-CN")} 个方法预算单位（不是模型服务计费内容额度）
          </p>
        </div>
        <Badge tone={included.length > 0 ? "warning" : "neutral"}>{included.length} 项采用</Badge>
      </div>
      {included.length === 0 ? (
        <p>本次没有采用实验性写作方法；故事资料和当前任务仍按原有安全链处理。</p>
      ) : (
        <ul>
          {included.map((method) => (
            <li key={`${method.displayName}@${method.version}`}>
              <strong>{method.displayName}</strong> · 版本 {method.version}
              <p>{method.summary}</p>
              <Badge tone="success">已采用</Badge>
            </li>
          ))}
        </ul>
      )}
      {discarded.length > 0 && (
        <details>
          <summary>查看未采用的方法（{discarded.length}）</summary>
          <ul>
            {discarded.map((method) => (
              <li key={`${method.displayName}@${method.version}`}>
                <strong>{method.displayName}</strong> · 版本 {method.version}
                <p>{selectionReasonLabel(method.selectionReason)}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function notAppliedDescription(reason: NovelSkillNotAppliedReason | null): string {
  if (reason === "browser_demo") {
    return "浏览器演示不会把实验性方法加入提示词，也不会生成写作方法收据。";
  }
  if (reason === "legacy_route_untraceable") {
    return "当前调用使用旧兼容链，无法建立精确的模型调用收据，因此写作方法已安全跳过。切换到模型中心任务分工后可使用。";
  }
  return "写作方法运行时当前不可用；本次没有把任何实验性方法加入提示词。";
}

function selectionReasonLabel(reason: NovelSkillSelectionView["selectionReason"]): string {
  const labels: Readonly<Record<NovelSkillSelectionView["selectionReason"], string>> = {
    selected: "本次已采用。",
    not_enabled: "作者没有开启这项实验性方法。",
    manual_not_requested: "这项手动方法没有被指定用于本次任务。",
    task_mismatch: "这项方法不适用于本次任务。",
    mode_mismatch: "这项方法不适用于本次创作方式。",
    genre_mismatch: "当前作品题材与这项方法不匹配。",
    status_blocked: "这项方法仍处于默认关闭的实验状态。",
    missing_context: "本次缺少安全应用这项方法所需的故事资料。",
    conflict: "它与本次优先级更高的方法冲突，因此未采用。",
    token_budget_exhausted: "独立方法预算不足，因此未发送给模型。",
  };
  return labels[reason];
}
