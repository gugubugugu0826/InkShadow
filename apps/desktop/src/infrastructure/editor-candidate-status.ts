import type { AiCandidate } from "@inkshadow/domain";

const EDITOR_CANDIDATE_STATUS_LABELS = Object.freeze({
  streaming: "生成中",
  ready: "等待决定",
  accepted: "已接受",
  rejected: "已放弃",
  expired: "已失效",
} satisfies Readonly<Record<AiCandidate["status"], string>>);

export function editorCandidateStatusLabel(status: string): string {
  return status in EDITOR_CANDIDATE_STATUS_LABELS
    ? EDITOR_CANDIDATE_STATUS_LABELS[status as AiCandidate["status"]]
    : "状态未知";
}
