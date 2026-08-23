import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AiCandidate,
  parseContentChecksum,
  parseIsoUtcTimestamp,
  parseUuidV7,
  type AiCandidatePurpose,
  type AiCandidateStatus,
} from "@inkshadow/domain";

import { CandidateHistoryPanel } from "./candidate-history-panel";

function candidate(input: {
  readonly id: string;
  readonly content: string;
  readonly updatedAt: string;
  readonly status?: AiCandidateStatus;
  readonly purpose?: AiCandidatePurpose;
}): AiCandidate {
  const id = parseUuidV7(input.id);
  const projectId = parseUuidV7("018f0d7a-3b2c-7abc-8def-000000000001");
  const chapterId = parseUuidV7("018f0d7a-3b2c-7abc-8def-000000000002");
  const versionId = parseUuidV7("018f0d7a-3b2c-7abc-8def-000000000003");
  const updatedAt = parseIsoUtcTimestamp(input.updatedAt);
  const checksum = parseContentChecksum("a".repeat(64));
  if (!id.ok || !projectId.ok || !chapterId.ok || !versionId.ok || !updatedAt.ok || !checksum.ok) {
    throw new Error("invalid test fixture");
  }
  const streaming = AiCandidate.createStreaming({
    id: id.value,
    projectId: projectId.value,
    chapterId: chapterId.value,
    source: "generate",
    purpose: input.purpose ?? "prose",
    baseVersionId: versionId.value,
    now: updatedAt.value,
  });
  if (!streaming.ok) throw streaming.error;
  const ready = streaming.value.markReady(input.content, checksum.value, updatedAt.value);
  if (!ready.ok) throw ready.error;
  if (input.status === undefined || input.status === "ready") return ready.value;
  const terminal =
    input.status === "accepted"
      ? ready.value.accept(updatedAt.value)
      : input.status === "rejected"
        ? ready.value.reject(updatedAt.value)
        : ready.value.expire(updatedAt.value);
  if (!terminal.ok) throw terminal.error;
  return terminal.value;
}

describe("CandidateHistoryPanel", () => {
  it("lists every prose result, marks older undecided results, and excludes direction choices", () => {
    const now = parseIsoUtcTimestamp("2026-08-30T00:00:00.000Z");
    if (!now.ok) throw now.error;

    const onView = vi.fn();
    const onReject = vi.fn();
    const onRetain = vi.fn();
    const older = candidate({
      id: "018f0d7a-3b2c-7abc-8def-000000000011",
      content: "较早但仍完整保留的创作结果",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const rejected = candidate({
      id: "018f0d7a-3b2c-7abc-8def-000000000012",
      content: "已经放弃但仍可查看的创作结果",
      updatedAt: "2026-08-20T00:00:00.000Z",
      status: "rejected",
    });
    const directions = candidate({
      id: "018f0d7a-3b2c-7abc-8def-000000000013",
      content: "不应出现在历史里的方向",
      updatedAt: "2026-08-21T00:00:00.000Z",
      purpose: "continuation_directions",
    });

    render(
      <CandidateHistoryPanel
        candidates={[older, rejected, directions]}
        now={now.value}
        selectedCandidateId={rejected.id}
        busy={false}
        onView={onView}
        onReject={onReject}
        onRetain={onRetain}
      />,
    );

    expect(screen.getByText("历史生成结果（2）")).toBeVisible();
    fireEvent.click(screen.getByText("历史生成结果（2）"));
    expect(screen.getByText("较早但仍完整保留的创作结果")).toBeVisible();
    expect(screen.getByText("已经放弃但仍可查看的创作结果")).toBeVisible();
    expect(screen.queryByText("不应出现在历史里的方向")).not.toBeInTheDocument();
    expect(screen.getByText("超过 30 天，仍保留")).toBeVisible();
    expect(screen.getByText("当前查看")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /继续保留/u })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /放弃/u })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "查看第 1 条生成结果" }));
    fireEvent.click(screen.getByRole("button", { name: "继续保留第 2 条生成结果" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃第 2 条生成结果" }));
    expect(onView).toHaveBeenCalledWith(rejected);
    expect(onRetain).toHaveBeenCalledWith(older);
    expect(onReject).toHaveBeenCalledWith(older);
  });
});
