import { describe, expect, it } from "vitest";

import { decideEditorGenerationCompletion } from "./editor-generation-completion-policy";

describe("editor generation completion policy", () => {
  it.each(["opening", "continuation", "selection_rewrite", "polish", "expand", "shorten"] as const)(
    "keeps a complete direct %s result visible and isolated",
    (action) => {
      const decision = decideEditorGenerationCompletion({
        mode: "direct",
        action,
        candidateReady: true,
        incomplete: false,
        qualityGateOutcome: "pass",
      });
      expect(decision.kind).toBe("review");
      expect(decision.notice).toMatch(/创作结果已保存并与正文隔离.*明确选择/u);
    },
  );

  it("names a shortened result while keeping it isolated", () => {
    const decision = decideEditorGenerationCompletion({
      mode: "direct",
      action: "shorten",
      candidateReady: true,
      incomplete: false,
      qualityGateOutcome: "pass",
    });

    expect(decision).toMatchObject({ kind: "review" });
    expect(decision.notice).toContain("这次缩写");
  });

  it("does not invent a result when generation produced no Candidate", () => {
    expect(
      decideEditorGenerationCompletion({
        mode: "direct",
        action: "continuation",
        candidateReady: false,
        incomplete: false,
        qualityGateOutcome: null,
      }),
    ).toMatchObject({ kind: "keep_isolated", reason: "missing_candidate" });
  });

  it.each([
    [true, "本次结果尚未完整"],
    [false, "本机检查发现需要留意的问题"],
  ] as const)(
    "keeps a risky direct result visible for an explicit decision",
    (incomplete, notice) => {
      const decision = decideEditorGenerationCompletion({
        mode: "direct",
        action: "continuation",
        candidateReady: true,
        incomplete,
        qualityGateOutcome: incomplete ? "pass" : "block",
      });
      expect(decision.kind).toBe("review");
      expect(decision.notice).toContain(notice);
    },
  );

  it("always sends a professional result to the existing review flow", () => {
    const decision = decideEditorGenerationCompletion({
      mode: "professional",
      action: "continuation",
      candidateReady: true,
      incomplete: false,
      qualityGateOutcome: "pass",
    });
    expect(decision.kind).toBe("review");
    expect(decision.notice).toContain("保持隔离");
  });
});
