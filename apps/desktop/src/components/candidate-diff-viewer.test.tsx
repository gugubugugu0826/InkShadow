import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CandidateTextDiff } from "@inkshadow/application";

import { CandidateDiffViewer } from "./candidate-diff-viewer";

function diffWithChanges(count: number): CandidateTextDiff {
  return {
    algorithm: "bounded-myers-unicode-scalar-v1",
    offsetEncoding: "utf-16",
    baselineUtf16Units: count,
    candidateUtf16Units: count,
    baselineCodePoints: count,
    candidateCodePoints: count,
    editDistance: count * 2,
    changes: Array.from({ length: count }, (_, index) => ({
      id: `change-${String(index + 1).padStart(6, "0")}`,
      baselineRange: { start: index, end: index + 1 },
      candidateRange: { start: index, end: index + 1 },
      removedText: `原${String(index + 1)}`,
      insertedText: `新${String(index + 1)}`,
      removedCodePoints: 1,
      insertedCodePoints: 1,
    })),
  };
}

describe("CandidateDiffViewer", () => {
  it("records explicit per-change decisions without accepting undecided changes", () => {
    const onDecision = vi.fn();
    render(
      <CandidateDiffViewer decisions={{}} diff={diffWithChanges(2)} onDecision={onDecision} />,
    );

    expect(screen.getByText("共 2 处文字变化")).toBeVisible();
    expect(screen.getByText("第 1 处变化")).toBeVisible();
    expect(screen.getByText("第 2 处变化")).toBeVisible();
    expect(document.body).not.toHaveTextContent("编辑距离");
    expect(document.body).not.toHaveTextContent("change-000001");
    expect(document.body).not.toHaveTextContent("change-000002");
    expect(screen.getAllByText("待决定")).toHaveLength(2);
    const acceptButtons = screen.getAllByRole("button", { name: "接受此处" });
    const rejectButtons = screen.getAllByRole("button", { name: "保留原文" });
    const firstAccept = acceptButtons.at(0);
    const secondReject = rejectButtons.at(1);
    if (firstAccept === undefined || secondReject === undefined) {
      throw new Error("Expected both candidate decisions to be rendered.");
    }
    fireEvent.click(firstAccept);
    fireEvent.click(secondReject);
    expect(onDecision).toHaveBeenNthCalledWith(1, "change-000001", "accept");
    expect(onDecision).toHaveBeenNthCalledWith(2, "change-000002", "reject");
  });

  it("paginates a bounded number of rendered changes", () => {
    render(<CandidateDiffViewer decisions={{}} diff={diffWithChanges(25)} onDecision={vi.fn()} />);

    expect(screen.getByText("第 1/2 页")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "接受此处" })).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(screen.getByText("第 2/2 页")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "接受此处" })).toHaveLength(1);
  });
});
