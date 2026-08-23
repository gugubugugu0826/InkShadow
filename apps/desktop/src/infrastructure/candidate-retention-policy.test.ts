import { describe, expect, it } from "vitest";

import {
  AiCandidate,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AiCandidatePurpose,
  type AiCandidateStatus,
  type IsoUtcTimestamp,
} from "@inkshadow/domain";

import {
  AI_CANDIDATE_ATTENTION_AFTER_MS,
  buildCandidateHistory,
  candidateNeedsAttention,
} from "./candidate-retention-policy";

function timestamp(value: string): IsoUtcTimestamp {
  const parsed = parseIsoUtcTimestamp(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function candidate(input: {
  readonly id: string;
  readonly updatedAt: string;
  readonly status?: AiCandidateStatus;
  readonly purpose?: AiCandidatePurpose;
}): AiCandidate {
  const id = parseUuidV7(input.id);
  const projectId = parseUuidV7("018f0d7a-3b2c-7abc-8def-000000000001");
  const chapterId = parseUuidV7("018f0d7a-3b2c-7abc-8def-000000000002");
  const versionId = parseUuidV7("018f0d7a-3b2c-7abc-8def-000000000003");
  const checksum = parseContentChecksum("a".repeat(64));
  if (!id.ok || !projectId.ok || !chapterId.ok || !versionId.ok || !checksum.ok) {
    throw new Error("invalid test fixture");
  }
  const updatedAt = timestamp(input.updatedAt);
  const streaming = AiCandidate.createStreaming({
    id: id.value,
    projectId: projectId.value,
    chapterId: chapterId.value,
    source: "generate",
    purpose: input.purpose ?? "prose",
    baseVersionId: versionId.value,
    now: updatedAt,
  });
  if (!streaming.ok) throw streaming.error;
  const ready = streaming.value.markReady(`结果-${input.id.slice(-1)}`, checksum.value, updatedAt);
  if (!ready.ok) throw ready.error;
  if (input.status === undefined || input.status === "ready") return ready.value;
  const decided =
    input.status === "accepted"
      ? ready.value.accept(updatedAt)
      : input.status === "rejected"
        ? ready.value.reject(updatedAt)
        : input.status === "expired"
          ? ready.value.expire(updatedAt)
          : null;
  if (!decided?.ok) throw new Error("invalid candidate status fixture");
  return decided.value;
}

describe("candidate retention policy", () => {
  const now = timestamp("2026-08-30T00:00:00.000Z");

  it("starts the reminder exactly 30 days after the most recent author-visible update", () => {
    const justBefore = candidate({
      id: "018f0d7a-3b2c-7abc-8def-000000000011",
      updatedAt: "2026-07-31T00:00:00.001Z",
    });
    const exactBoundary = candidate({
      id: "018f0d7a-3b2c-7abc-8def-000000000012",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    expect(AI_CANDIDATE_ATTENTION_AFTER_MS).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(candidateNeedsAttention(justBefore, now)).toBe(false);
    expect(candidateNeedsAttention(exactBoundary, now)).toBe(true);
  });

  it("never marks decided results or continuation directions as waiting too long", () => {
    for (const status of ["accepted", "rejected", "expired"] as const) {
      expect(
        candidateNeedsAttention(
          candidate({
            id: `018f0d7a-3b2c-7abc-8def-0000000000${String(status.length + 20)}`,
            updatedAt: "2026-01-01T00:00:00.000Z",
            status,
          }),
          now,
        ),
      ).toBe(false);
    }
    expect(
      candidateNeedsAttention(
        candidate({
          id: "018f0d7a-3b2c-7abc-8def-000000000031",
          updatedAt: "2026-01-01T00:00:00.000Z",
          purpose: "continuation_directions",
        }),
        now,
      ),
    ).toBe(false);
  });

  it("builds a newest-first history without mutating or counting direction choices", () => {
    const older = candidate({
      id: "018f0d7a-3b2c-7abc-8def-000000000041",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const newest = candidate({
      id: "018f0d7a-3b2c-7abc-8def-000000000042",
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
    const directions = candidate({
      id: "018f0d7a-3b2c-7abc-8def-000000000043",
      updatedAt: "2026-08-30T00:00:00.000Z",
      purpose: "continuation_directions",
    });
    const before = older.toSnapshot();

    const history = buildCandidateHistory([older, directions, newest], now);

    expect(history.map((entry) => entry.candidate.id)).toEqual([newest.id, older.id]);
    expect(history.map((entry) => entry.needsAttention)).toEqual([false, true]);
    expect(older.toSnapshot()).toEqual(before);
  });
});
