import { describe, expect, it } from "vitest";

import {
  CANDIDATE_DIFF_ALGORITHM,
  CANDIDATE_DIFF_HARD_LIMITS,
  diffCandidateContent,
  planCandidateApplication,
  type CandidateChangeDecision,
  type CandidateMergeSnapshot,
} from "../src/index.js";

function snapshot(
  content: string,
  revision = 7,
  contentDigest = "sha256:baseline",
): CandidateMergeSnapshot {
  return { revision, contentDigest, content };
}

function shortUnicodeSamples(): string[] {
  const alphabet = ["a", "b", "😀"];
  const samples = [""];
  let layer = [""];
  for (let length = 1; length <= 3; length += 1) {
    layer = layer.flatMap((prefix) => alphabet.map((token) => `${prefix}${token}`));
    samples.push(...layer);
  }
  return samples;
}

function insertDeleteDistance(baseline: string, candidate: string): number {
  const baselineTokens = Array.from(baseline);
  const candidateTokens = Array.from(candidate);
  let previous = candidateTokens.map((_, index) => index + 1);
  previous.unshift(0);

  for (let baselineIndex = 1; baselineIndex <= baselineTokens.length; baselineIndex += 1) {
    const current = [baselineIndex];
    for (let candidateIndex = 1; candidateIndex <= candidateTokens.length; candidateIndex += 1) {
      const deletion = (previous[candidateIndex] ?? Number.POSITIVE_INFINITY) + 1;
      const insertion = (current[candidateIndex - 1] ?? Number.POSITIVE_INFINITY) + 1;
      const equality =
        baselineTokens[baselineIndex - 1] === candidateTokens[candidateIndex - 1]
          ? (previous[candidateIndex - 1] ?? Number.POSITIVE_INFINITY)
          : Number.POSITIVE_INFINITY;
      current.push(Math.min(deletion, insertion, equality));
    }
    previous = current;
  }
  return previous[candidateTokens.length] ?? Number.POSITIVE_INFINITY;
}

describe("candidate content diff", () => {
  it("produces deterministic Unicode-scalar changes with UTF-16 ranges", () => {
    const baseline = "甲😀乙\n尾";
    const candidate = "甲😀新乙\n末尾";

    const first = diffCandidateContent(baseline, candidate);
    const second = diffCandidateContent(baseline, candidate);

    expect(first).toEqual(second);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") {
      return;
    }
    expect(first.diff).toMatchObject({
      algorithm: CANDIDATE_DIFF_ALGORITHM,
      offsetEncoding: "utf-16",
      baselineUtf16Units: 6,
      candidateUtf16Units: 8,
      baselineCodePoints: 5,
      candidateCodePoints: 7,
      editDistance: 2,
    });
    expect(first.diff.changes).toEqual([
      {
        id: "change-000001",
        baselineRange: { start: 3, end: 3 },
        candidateRange: { start: 3, end: 4 },
        removedText: "",
        insertedText: "新",
        removedCodePoints: 0,
        insertedCodePoints: 1,
      },
      {
        id: "change-000002",
        baselineRange: { start: 5, end: 5 },
        candidateRange: { start: 6, end: 7 },
        removedText: "",
        insertedText: "末",
        removedCodePoints: 0,
        insertedCodePoints: 1,
      },
    ]);
  });

  it("handles empty inputs and reports a scalar edit distance", () => {
    const inserted = diffCandidateContent("", "😀文");
    expect(inserted.status).toBe("ready");
    if (inserted.status !== "ready") {
      return;
    }
    expect(inserted.diff.editDistance).toBe(2);
    expect(inserted.diff.changes).toEqual([
      expect.objectContaining({
        baselineRange: { start: 0, end: 0 },
        candidateRange: { start: 0, end: 3 },
        insertedText: "😀文",
        insertedCodePoints: 2,
      }),
    ]);

    const unchanged = diffCandidateContent("", "");
    expect(unchanged.status === "ready" && unchanged.diff.changes).toEqual([]);
  });

  it("coalesces a replacement while keeping separated edits independently actionable", () => {
    const outcome = diffCandidateContent("one cat two.", "one dog two!");
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") {
      return;
    }
    expect(outcome.diff.changes).toHaveLength(2);
    expect(outcome.diff.changes[0]).toMatchObject({
      removedText: "cat",
      insertedText: "dog",
    });
    expect(outcome.diff.changes[1]).toMatchObject({
      removedText: ".",
      insertedText: "!",
    });
  });

  it("rejects malformed UTF-16 and null bytes before diffing", () => {
    const malformed = diffCandidateContent(`a${String.fromCharCode(0xd800)}b`, "safe");
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error.code).toBe("INVALID_UNICODE");
      expect(malformed.error.context.offsetUtf16).toBe(1);
    }

    const withNull = diffCandidateContent("a\u0000b", "safe");
    expect(withNull.status).toBe("error");
    if (withNull.status === "error") {
      expect(withNull.error.code).toBe("INVALID_CONTENT");
    }
  });

  it("enforces text, edit-distance, work, change, and hard configuration limits", () => {
    const textLimit = diffCandidateContent("abcd", "x", {
      maxTextUtf16Units: 3,
    });
    expect(textLimit.status === "error" && textLimit.error.code).toBe("TEXT_LIMIT_EXCEEDED");

    const codePointLimit = diffCandidateContent("ab", "cd", {
      maxTotalCodePoints: 3,
    });
    expect(codePointLimit.status === "error" && codePointLimit.error.code).toBe(
      "TEXT_LIMIT_EXCEEDED",
    );

    const editLimit = diffCandidateContent("abcd", "wxyz", {
      maxEditDistance: 2,
    });
    expect(editLimit.status === "error" && editLimit.error.code).toBe(
      "DIFF_COMPLEXITY_LIMIT_EXCEEDED",
    );

    const workLimit = diffCandidateContent("abcdef", "uvwxyz", {
      maxEditDistance: 12,
      maxWorkUnits: 1,
    });
    expect(workLimit.status === "error" && workLimit.error.code).toBe(
      "DIFF_COMPLEXITY_LIMIT_EXCEEDED",
    );

    const traceLimit = diffCandidateContent("abcdef", "uvwxyz", {
      maxEditDistance: 12,
      maxTraceCells: 1,
    });
    expect(traceLimit.status === "error" && traceLimit.error.code).toBe(
      "DIFF_COMPLEXITY_LIMIT_EXCEEDED",
    );

    const changeLimit = diffCandidateContent("abc", "aXbYc", {
      maxChanges: 1,
    });
    expect(changeLimit.status === "error" && changeLimit.error.code).toBe("CHANGE_LIMIT_EXCEEDED");

    const invalidLimit = diffCandidateContent("a", "b", {
      maxEditDistance: CANDIDATE_DIFF_HARD_LIMITS.maxEditDistance + 1,
    });
    expect(invalidLimit.status === "error" && invalidLimit.error.code).toBe("INVALID_LIMITS");
  });

  it("reconstructs every short repeated-character and emoji pair with a minimal script", () => {
    const samples = shortUnicodeSamples();
    for (const baseline of samples) {
      for (const candidate of samples) {
        const diff = diffCandidateContent(baseline, candidate);
        expect(diff.status).toBe("ready");
        if (diff.status !== "ready") {
          continue;
        }
        expect(diff.diff.editDistance).toBe(insertDeleteDistance(baseline, candidate));

        const planned = planCandidateApplication({
          baseline: snapshot(baseline),
          current: snapshot(baseline),
          candidateContent: candidate,
          strategy: {
            kind: "apply_changes",
            decisions: diff.diff.changes.map((change) => ({
              changeId: change.id,
              decision: "accept",
            })),
          },
        });
        expect(planned.status).toBe("ready");
        if (planned.status === "ready") {
          expect(planned.plan.resultContent).toBe(candidate);
        }
      }
    }
  });
});

describe("candidate application planning", () => {
  it("plans whole-candidate acceptance without mutating the stable text", () => {
    const stable = "Stable 😀 text";
    const outcome = planCandidateApplication({
      baseline: snapshot(stable),
      current: snapshot(stable),
      candidateContent: "Candidate text",
      strategy: { kind: "accept_all" },
    });

    expect(stable).toBe("Stable 😀 text");
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") {
      return;
    }
    expect(outcome.plan).toMatchObject({
      strategy: "accept_all",
      editOffsetEncoding: "utf-16",
      editOrder: "descending",
      resultContent: "Candidate text",
      diff: null,
    });
    expect(outcome.plan.edits).toEqual([
      {
        range: { start: 0, end: stable.length },
        replacement: "Candidate text",
        sourceChangeId: null,
      },
    ]);
  });

  it("accepts and rejects individual changes with descending, directly applicable edits", () => {
    const baseline = "one cat two.";
    const candidate = "one dog two!";
    const diff = diffCandidateContent(baseline, candidate);
    expect(diff.status).toBe("ready");
    if (diff.status !== "ready") {
      return;
    }
    const decisions: CandidateChangeDecision[] = diff.diff.changes.map((change) => ({
      changeId: change.id,
      decision: change.insertedText === "dog" ? "accept" : "reject",
    }));

    const outcome = planCandidateApplication({
      baseline: snapshot(baseline),
      current: snapshot(baseline),
      candidateContent: candidate,
      strategy: { kind: "apply_changes", decisions },
    });

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") {
      return;
    }
    expect(outcome.plan.resultContent).toBe("one dog two.");
    expect(outcome.plan.acceptedChangeIds).toEqual(["change-000001"]);
    expect(outcome.plan.rejectedChangeIds).toEqual(["change-000002"]);
    expect(outcome.plan.edits).toEqual([
      {
        range: { start: 4, end: 7 },
        replacement: "dog",
        sourceChangeId: "change-000001",
      },
    ]);
  });

  it("orders multiple accepted edits from the end of the document", () => {
    const baseline = "abc";
    const candidate = "aXbYc";
    const diff = diffCandidateContent(baseline, candidate);
    expect(diff.status).toBe("ready");
    if (diff.status !== "ready") {
      return;
    }

    const outcome = planCandidateApplication({
      baseline: snapshot(baseline),
      current: snapshot(baseline),
      candidateContent: candidate,
      strategy: {
        kind: "apply_changes",
        decisions: diff.diff.changes.map((change) => ({
          changeId: change.id,
          decision: "accept",
        })),
      },
    });

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") {
      return;
    }
    expect(outcome.plan.resultContent).toBe(candidate);
    expect(outcome.plan.edits.map((edit) => edit.range.start)).toEqual([2, 1]);
  });

  it("requires exactly one explicit decision for every change", () => {
    const baseline = "abc";
    const candidate = "aXbYc";
    const diff = diffCandidateContent(baseline, candidate);
    expect(diff.status).toBe("ready");
    if (diff.status !== "ready") {
      return;
    }

    const missing = planCandidateApplication({
      baseline: snapshot(baseline),
      current: snapshot(baseline),
      candidateContent: candidate,
      strategy: {
        kind: "apply_changes",
        decisions: [{ changeId: diff.diff.changes[0]?.id ?? "", decision: "accept" }],
      },
    });
    expect(missing.status === "error" && missing.error.code).toBe("INVALID_CHANGE_DECISIONS");

    const duplicateId = diff.diff.changes[0]?.id ?? "";
    const duplicate = planCandidateApplication({
      baseline: snapshot(baseline),
      current: snapshot(baseline),
      candidateContent: candidate,
      strategy: {
        kind: "apply_changes",
        decisions: [
          { changeId: duplicateId, decision: "accept" },
          { changeId: duplicateId, decision: "reject" },
        ],
      },
    });
    expect(duplicate.status === "error" && duplicate.error.code).toBe("INVALID_CHANGE_DECISIONS");
  });

  it("inserts at a cursor and replaces a selection without splitting surrogate pairs", () => {
    const stable = "A😀B";
    const inserted = planCandidateApplication({
      baseline: snapshot(stable),
      current: snapshot(stable),
      candidateContent: "中",
      strategy: { kind: "insert_at_cursor", cursorUtf16: 3 },
    });
    expect(inserted.status === "ready" && inserted.plan.resultContent).toBe("A😀中B");

    const replaced = planCandidateApplication({
      baseline: snapshot(stable),
      current: snapshot(stable),
      candidateContent: "X",
      strategy: { kind: "replace_selection", selection: { start: 1, end: 3 } },
    });
    expect(replaced.status === "ready" && replaced.plan.resultContent).toBe("AXB");

    const splitEmoji = planCandidateApplication({
      baseline: snapshot(stable),
      current: snapshot(stable),
      candidateContent: "X",
      strategy: { kind: "insert_at_cursor", cursorUtf16: 2 },
    });
    expect(splitEmoji.status === "error" && splitEmoji.error.code).toBe("INVALID_SELECTION");
  });

  it("returns an explicit three-way conflict when revision and digest changed", () => {
    const outcome = planCandidateApplication({
      baseline: snapshot("base", 7, "sha256:base"),
      current: snapshot("local edit", 8, "sha256:local"),
      candidateContent: "candidate edit",
      strategy: { kind: "overwrite_document" },
    });

    expect(outcome.status).toBe("conflict");
    if (outcome.status !== "conflict") {
      return;
    }
    expect(outcome.conflict).toEqual({
      kind: "baseline_changed",
      revisionChanged: true,
      contentDigestChanged: true,
      baseline: snapshot("base", 7, "sha256:base"),
      current: snapshot("local edit", 8, "sha256:local"),
      candidateContent: "candidate edit",
    });
  });

  it("detects a digest-only baseline change even when the revision is unchanged", () => {
    const outcome = planCandidateApplication({
      baseline: snapshot("base", 7, "sha256:base"),
      current: snapshot("local edit", 7, "sha256:local"),
      candidateContent: "candidate edit",
      strategy: { kind: "accept_all" },
    });

    expect(outcome.status).toBe("conflict");
    if (outcome.status === "conflict") {
      expect(outcome.conflict.revisionChanged).toBe(false);
      expect(outcome.conflict.contentDigestChanged).toBe(true);
    }
  });

  it("rejects inconsistent snapshots that reuse one identity for different content", () => {
    const outcome = planCandidateApplication({
      baseline: snapshot("base"),
      current: snapshot("different"),
      candidateContent: "candidate",
      strategy: { kind: "accept_all" },
    });

    expect(outcome.status === "error" && outcome.error.code).toBe("SNAPSHOT_IDENTITY_MISMATCH");
  });

  it("rejects invalid snapshot metadata and planned outputs beyond the hard bound", () => {
    const invalidSnapshot = planCandidateApplication({
      baseline: snapshot("base", 0),
      current: snapshot("base", 0),
      candidateContent: "candidate",
      strategy: { kind: "accept_all" },
    });
    expect(invalidSnapshot.status === "error" && invalidSnapshot.error.code).toBe(
      "INVALID_SNAPSHOT",
    );

    const outputLimit = planCandidateApplication({
      baseline: snapshot("abc"),
      current: snapshot("abc"),
      candidateContent: "defg",
      strategy: { kind: "accept_all" },
      limits: { maxOutputUtf16Units: 3 },
    });
    expect(outputLimit.status === "error" && outputLimit.error.code).toBe("OUTPUT_LIMIT_EXCEEDED");
  });

  it("returns a no-op plan for identical content and for rejecting every change", () => {
    const identical = planCandidateApplication({
      baseline: snapshot("same"),
      current: snapshot("same"),
      candidateContent: "same",
      strategy: { kind: "overwrite_document" },
    });
    expect(identical.status === "ready" && identical.plan.edits).toEqual([]);

    const diff = diffCandidateContent("abc", "axc");
    expect(diff.status).toBe("ready");
    if (diff.status !== "ready") {
      return;
    }
    const rejected = planCandidateApplication({
      baseline: snapshot("abc"),
      current: snapshot("abc"),
      candidateContent: "axc",
      strategy: {
        kind: "apply_changes",
        decisions: diff.diff.changes.map((change) => ({
          changeId: change.id,
          decision: "reject",
        })),
      },
    });
    expect(rejected.status).toBe("ready");
    if (rejected.status === "ready") {
      expect(rejected.plan.resultContent).toBe("abc");
      expect(rejected.plan.edits).toEqual([]);
    }
  });
});
