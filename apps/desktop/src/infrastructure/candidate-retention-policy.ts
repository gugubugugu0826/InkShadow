import type { AiCandidate, IsoUtcTimestamp } from "@inkshadow/domain";

export const AI_CANDIDATE_ATTENTION_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

export interface CandidateHistoryEntry {
  readonly candidate: AiCandidate;
  readonly needsAttention: boolean;
}

export function candidateNeedsAttention(candidate: AiCandidate, now: IsoUtcTimestamp): boolean {
  if (candidate.purpose !== "prose" || candidate.status !== "ready") {
    return false;
  }
  const updatedAt = Date.parse(candidate.toSnapshot().updatedAt);
  const currentTime = Date.parse(now);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(currentTime)) {
    return false;
  }
  return currentTime - updatedAt >= AI_CANDIDATE_ATTENTION_AFTER_MS;
}

export function buildCandidateHistory(
  candidates: readonly AiCandidate[],
  now: IsoUtcTimestamp,
): readonly CandidateHistoryEntry[] {
  return Object.freeze(
    candidates
      .filter((candidate) => candidate.purpose === "prose" && candidate.status !== "streaming")
      .map((candidate) =>
        Object.freeze({
          candidate,
          needsAttention: candidateNeedsAttention(candidate, now),
        }),
      )
      .sort((left, right) => {
        const updatedOrder =
          Date.parse(right.candidate.toSnapshot().updatedAt) -
          Date.parse(left.candidate.toSnapshot().updatedAt);
        if (updatedOrder !== 0) {
          return updatedOrder;
        }
        return right.candidate.id.localeCompare(left.candidate.id);
      }),
  );
}
