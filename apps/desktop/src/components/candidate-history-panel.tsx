import { useState } from "react";
import { Badge, Button } from "@inkshadow/ui";
import type { AiCandidate, IsoUtcTimestamp, UuidV7 } from "@inkshadow/domain";

import {
  buildCandidateHistory,
  type CandidateHistoryEntry,
} from "../infrastructure/candidate-retention-policy";
import { editorCandidateStatusLabel } from "../infrastructure/editor-candidate-status";

export interface CandidateHistoryPanelProps {
  readonly candidates: readonly AiCandidate[];
  readonly now: IsoUtcTimestamp;
  readonly selectedCandidateId: UuidV7 | null;
  readonly busy: boolean;
  readonly onView: (candidate: AiCandidate) => void;
  readonly onReject: (candidate: AiCandidate) => void | Promise<void>;
  readonly onRetain: (candidate: AiCandidate) => void | Promise<void>;
}

function boundedPreview(content: string): string {
  const normalized = content.trim().replace(/\s+/gu, " ");
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 80)}…`;
}

function formatUpdatedAt(candidate: AiCandidate): string {
  const value = new Date(candidate.toSnapshot().updatedAt);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function CandidateHistoryRow({
  entry,
  index,
  selected,
  busy,
  onView,
  onReject,
  onRetain,
}: Readonly<{
  entry: CandidateHistoryEntry;
  index: number;
  selected: boolean;
  busy: boolean;
  onView: CandidateHistoryPanelProps["onView"];
  onReject: CandidateHistoryPanelProps["onReject"];
  onRetain: CandidateHistoryPanelProps["onRetain"];
}>) {
  const position = index + 1;
  const { candidate, needsAttention } = entry;
  return (
    <li className="candidate-history__item">
      <div className="candidate-history__meta">
        <Badge tone={candidate.status === "accepted" ? "success" : "neutral"}>
          {editorCandidateStatusLabel(candidate.status)}
        </Badge>
        {selected && <Badge tone="ai">当前查看</Badge>}
        {needsAttention && <Badge tone="warning">超过 30 天，仍保留</Badge>}
        <span>{formatUpdatedAt(candidate)}</span>
        <span>{candidate.content.length.toLocaleString("zh-CN")} 字符</span>
      </div>
      <p>{boundedPreview(candidate.content)}</p>
      <div className="candidate-actions">
        <Button
          variant="secondary"
          disabled={busy}
          aria-label={`查看第 ${String(position)} 条生成结果`}
          onClick={() => onView(candidate)}
        >
          查看
        </Button>
        {needsAttention && (
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={`继续保留第 ${String(position)} 条生成结果`}
            onClick={() => void onRetain(candidate)}
          >
            继续保留
          </Button>
        )}
        {candidate.status === "ready" && (
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={`放弃第 ${String(position)} 条生成结果`}
            onClick={() => void onReject(candidate)}
          >
            放弃
          </Button>
        )}
      </div>
    </li>
  );
}

export function CandidateHistoryPanel({
  candidates,
  now,
  selectedCandidateId,
  busy,
  onView,
  onReject,
  onRetain,
}: CandidateHistoryPanelProps) {
  const [open, setOpen] = useState(false);
  const history = buildCandidateHistory(candidates, now);
  if (history.length === 0) {
    return null;
  }
  return (
    <details className="candidate-history" open={open}>
      <summary
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        历史生成结果（{history.length.toLocaleString("zh-CN")}）
      </summary>
      {open && (
        <>
          <p className="candidate-panel__hint">
            长期未处理只会显示提醒，不会自动接受、放弃或删除；结果会一直保留在本机。
          </p>
          <ol>
            {history.map((entry, index) => (
              <CandidateHistoryRow
                key={entry.candidate.id}
                entry={entry}
                index={index}
                selected={entry.candidate.id === selectedCandidateId}
                busy={busy}
                onView={onView}
                onReject={onReject}
                onRetain={onRetain}
              />
            ))}
          </ol>
        </>
      )}
    </details>
  );
}
