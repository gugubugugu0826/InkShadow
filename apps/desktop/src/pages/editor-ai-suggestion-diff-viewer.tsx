import { useState } from "react";
import type { CandidateTextDiff } from "@inkshadow/application";
import { Badge, Button, EmptyState } from "@inkshadow/ui";

export type AiSuggestionDiffDecision = "accept" | "reject";

interface AiSuggestionDiffViewerProps {
  readonly decisions: Readonly<Record<string, AiSuggestionDiffDecision | undefined>>;
  readonly diff: CandidateTextDiff;
  readonly disabled?: boolean;
  readonly onDecision: (changeId: string, decision: AiSuggestionDiffDecision) => void;
}

const CHANGES_PER_PAGE = 24;
const CHANGE_TEXT_PREVIEW_LIMIT = 1_200;

function previewChangeText(content: string, emptyLabel: string): string {
  if (content.length === 0) {
    return emptyLabel;
  }
  if (content.length <= CHANGE_TEXT_PREVIEW_LIMIT) {
    return content;
  }
  return `${content.slice(0, CHANGE_TEXT_PREVIEW_LIMIT)}\n…（此处预览已截断）`;
}

export function EditorAiSuggestionDiffViewer({
  decisions,
  diff,
  disabled = false,
  onDecision,
}: AiSuggestionDiffViewerProps) {
  const [pagination, setPagination] = useState<{
    readonly diff: CandidateTextDiff;
    readonly page: number;
  }>(() => ({ diff, page: 0 }));
  const pageCount = Math.max(1, Math.ceil(diff.changes.length / CHANGES_PER_PAGE));
  const requestedPage = pagination.diff === diff ? pagination.page : 0;
  const safePage = Math.min(requestedPage, pageCount - 1);
  const firstChange = safePage * CHANGES_PER_PAGE;
  const visibleChanges = diff.changes.slice(firstChange, firstChange + CHANGES_PER_PAGE);

  if (diff.changes.length === 0) {
    return (
      <EmptyState
        title="AI 建议与正文一致"
        description="没有需要审阅的文字变化；可以拒绝这份建议，或关闭后继续写作。"
      />
    );
  }

  return (
    <div className="candidate-diff-viewer">
      <div className="candidate-diff-viewer__summary">
        <span>共 {diff.changes.length.toLocaleString("zh-CN")} 处变化</span>
        <span>
          第 {safePage + 1}/{pageCount} 页
        </span>
      </div>
      <ol className="candidate-diff-viewer__changes" start={firstChange + 1}>
        {visibleChanges.map((change) => {
          const decision = decisions[change.id];
          return (
            <li key={change.id}>
              <header>
                <strong>变化 {change.id.replace("change-", "")}</strong>
                <Badge>
                  {decision === undefined ? "待决定" : decision === "accept" ? "接受" : "保留原文"}
                </Badge>
              </header>
              <div className="candidate-diff-viewer__comparison">
                <section>
                  <h4>当前正文</h4>
                  <pre>{previewChangeText(change.removedText, "（此处没有原文）")}</pre>
                </section>
                <section>
                  <h4>AI 建议</h4>
                  <pre>{previewChangeText(change.insertedText, "（建议删除此处文字）")}</pre>
                </section>
              </div>
              <div className="candidate-diff-viewer__actions">
                <Button
                  variant="secondary"
                  disabled={disabled}
                  aria-pressed={decision === "reject"}
                  onClick={() => onDecision(change.id, "reject")}
                >
                  保留原文
                </Button>
                <Button
                  disabled={disabled}
                  aria-pressed={decision === "accept"}
                  onClick={() => onDecision(change.id, "accept")}
                >
                  接受此处
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      {pageCount > 1 && (
        <div className="candidate-diff-viewer__pagination" aria-label="AI 建议变化分页">
          <Button
            variant="secondary"
            disabled={disabled || safePage === 0}
            onClick={() => setPagination({ diff, page: Math.max(0, safePage - 1) })}
          >
            上一页
          </Button>
          <Button
            variant="secondary"
            disabled={disabled || safePage >= pageCount - 1}
            onClick={() => setPagination({ diff, page: Math.min(pageCount - 1, safePage + 1) })}
          >
            下一页
          </Button>
        </div>
      )}
    </div>
  );
}
