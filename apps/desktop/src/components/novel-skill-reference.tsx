import { Badge, InlineAlert } from "@inkshadow/ui";
import { MAX_NOVEL_SKILLS_PER_INVOCATION } from "@inkshadow/ai-core";

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
        title="本次未采用写作技能"
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
    <section aria-label="本次采用的写作技能" className="context-history-entry">
      <div className="card-heading-row">
        <div>
          <strong>本次实际采用的写作技能</strong>
          <p className="candidate-panel__hint">
            本次最多参考的写作技能数量：{MAX_NOVEL_SKILLS_PER_INVOCATION} 项；当前实际采用
            {included.length} 项。 发送给 AI 的文字量（不是金额）：约{" "}
            {usedSkillTokens.toLocaleString("zh-CN")}/{maximumSkillTokens.toLocaleString("zh-CN")}。
          </p>
        </div>
        <Badge tone={included.length > 0 ? "warning" : "neutral"}>{included.length} 项采用</Badge>
      </div>
      {included.length === 0 ? (
        <p>本次没有采用写作技能；故事资料和当前任务仍按原有安全规则处理。</p>
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
          <summary>查看本次未采用的写作技能及原因（{discarded.length}）</summary>
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
    return "浏览器演示不会把写作技能加入本次资料，也不会保存采用记录。";
  }
  if (reason === "legacy_route_untraceable") {
    return "当前调用使用旧兼容链，无法建立准确的采用记录，因此写作技能已安全跳过。切换到可追踪的 AI 写作路线后可使用。";
  }
  return "写作技能当前不可用；本次没有把任何技能内容加入发送资料。";
}

function selectionReasonLabel(reason: NovelSkillSelectionView["selectionReason"]): string {
  const labels: Readonly<Record<NovelSkillSelectionView["selectionReason"], string>> = {
    selected: "本次已采用。",
    not_enabled: "当前项目没有启用这项写作技能。",
    manual_not_requested: "这项技能需要作者为本次任务明确选择。",
    task_mismatch: "这项技能不适用于本次任务。",
    mode_mismatch: "这项技能不适用于本次创作方式。",
    genre_mismatch: "当前作品题材与这项技能不匹配。",
    status_blocked: "这项技能当前已停用、归档，或不符合本次可用条件。",
    missing_context: "本次缺少安全采用这项技能所需的故事资料。",
    conflict: "它与本次优先级更高的技能冲突，因此未采用。",
    token_budget_exhausted: "本次最多参考的写作技能数量或可参考文字量已用完，因此未采用。",
  };
  return labels[reason];
}
