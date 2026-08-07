import { describe, expect, it } from "vitest";

import {
  CONTEXT_LAYER_ORDER,
  adaptContextSources,
  compileContext,
  compiledContextToPromptSections,
  estimateContextTokensUtf8Conservative,
  type ContextCandidate,
  type ContextLayer,
  type ContextTokenEstimator,
} from "../src/index.js";

const EXACT_ESTIMATOR: ContextTokenEstimator = {
  source: "custom",
  estimateTokens(text) {
    const count = Number.parseInt(text.split(":", 1)[0] ?? "", 10);
    return count;
  },
};

describe("layered context compiler", () => {
  it("always evaluates the twelve layers in the required order", () => {
    const candidates = [...CONTEXT_LAYER_ORDER]
      .reverse()
      .map((layer, index) => candidate(layer, `entry-${String(index)}`, 1));

    const compiled = compileContext({
      maximumContextTokens: 12,
      candidates,
      tokenEstimator: EXACT_ESTIMATOR,
    });

    expect(compiled.entries.map(({ layer }) => layer)).toEqual(CONTEXT_LAYER_ORDER);
    expect(compiled.entries.map(({ evaluationOrder }) => evaluationOrder)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(compiled.entries[10]).toMatchObject({
      layer: "semantic_retrieval",
      layerOrder: 11,
      estimatedTokens: 1,
      priority: 0,
      relevanceScore: null,
      included: true,
    });
    expect(compiled.entries[11]).toMatchObject({
      layer: "rerank_supplement",
      layerOrder: 12,
    });
    expect(compiled.trace).toMatchObject({
      maximumContextTokens: 12,
      requiredTokens: 2,
      usedTokens: 12,
      remainingTokens: 0,
      discardedTokens: 0,
      tokenEstimateSource: "custom",
    });
    expect(compiled.trace.layers).toHaveLength(12);
  });

  it("fails explicitly when hard rules and the current task exceed the budget", () => {
    const run = () =>
      compileContext({
        maximumContextTokens: 6,
        candidates: [
          candidate("locked_hard_rules", "locked-rule", 4),
          candidate("current_task", "current-task", 3),
          candidate("scene_goal", "scene-goal", 1),
        ],
        tokenEstimator: EXACT_ESTIMATOR,
      });

    expect(run).toThrow(
      expect.objectContaining({
        code: "CONTEXT_REQUIRED_BUDGET_EXCEEDED",
        details: {
          maximumContextTokens: 6,
          requiredTokens: 7,
          overflowTokens: 1,
          requiredEntryIds: ["locked-rule", "current-task"],
        },
      }),
    );
  });

  it("records optional budget discards without blocking a later smaller entry", () => {
    const compiled = compileContext({
      maximumContextTokens: 5,
      candidates: [
        candidate("locked_hard_rules", "rule", 1),
        candidate("current_task", "task", 1),
        candidate("scene_goal", "large-scene-goal", 8),
        candidate("pov_known_information", "pov-fact", 3),
        candidate("semantic_retrieval", "semantic-hit", 1),
      ],
      tokenEstimator: EXACT_ESTIMATOR,
    });

    expect(compiled.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "large-scene-goal",
          included: false,
          discardedReason: "token_budget_exhausted",
          budgetRemainingBefore: 3,
          budgetRemainingAfter: 3,
        }),
        expect.objectContaining({
          id: "pov-fact",
          included: true,
          budgetRemainingBefore: 3,
          budgetRemainingAfter: 0,
        }),
        expect.objectContaining({
          id: "semantic-hit",
          included: false,
          discardedReason: "token_budget_exhausted",
        }),
      ]),
    );
    expect(compiled.trace).toMatchObject({ usedTokens: 5, discardedTokens: 9 });
  });

  it("uses priority and relevance only inside a layer", () => {
    const compiled = compileContext({
      maximumContextTokens: 20,
      candidates: [
        candidate("scene_goal", "low-priority", 1, { priority: 1, relevanceScore: 1 }),
        candidate("current_task", "task", 1, { priority: -1_000 }),
        candidate("scene_goal", "high-priority", 1, { priority: 2, relevanceScore: 0 }),
        candidate("scene_goal", "same-priority-low-score", 1, {
          priority: 2,
          relevanceScore: 0.5,
        }),
        candidate("scene_goal", "same-priority-high-score", 1, {
          priority: 2,
          relevanceScore: 0.9,
        }),
      ],
      tokenEstimator: EXACT_ESTIMATOR,
    });

    expect(compiled.entries.map(({ id }) => id)).toEqual([
      "task",
      "same-priority-high-score",
      "same-priority-low-score",
      "high-priority",
      "low-priority",
    ]);
  });

  it("requires a current task but allows a project with no locked rules", () => {
    expect(() =>
      compileContext({
        maximumContextTokens: 10,
        candidates: [candidate("scene_goal", "scene", 1)],
        tokenEstimator: EXACT_ESTIMATOR,
      }),
    ).toThrow(expect.objectContaining({ code: "CONTEXT_REQUIRED_LAYER_MISSING" }));

    expect(
      compileContext({
        maximumContextTokens: 1,
        candidates: [candidate("current_task", "task", 1)],
        tokenEstimator: EXACT_ESTIMATOR,
      }).entries,
    ).toHaveLength(1);
  });

  it("retains the selection reason and source evidence for every decision", () => {
    const compiled = compileContext({
      maximumContextTokens: 1,
      candidates: [candidate("current_task", "task", 1)],
      tokenEstimator: EXACT_ESTIMATOR,
    });

    expect(compiled.entries[0]).toMatchObject({
      selectionReason: "Relevant current_task context.",
      evidence: [
        {
          sourceType: "other",
          sourceId: "source-task",
          sourceVersionId: "version-task",
          locator: "test:task",
          contentHash: null,
          excerpt: "Evidence for task.",
        },
      ],
    });
  });

  it("rejects duplicate identifiers, missing evidence, controls, and invalid estimates", () => {
    const task = candidate("current_task", "task", 1);
    expect(() =>
      compileContext({
        maximumContextTokens: 10,
        candidates: [task, task],
        tokenEstimator: EXACT_ESTIMATOR,
      }),
    ).toThrow(expect.objectContaining({ code: "CONTEXT_INPUT_INVALID" }));
    expect(() =>
      compileContext({
        maximumContextTokens: 10,
        candidates: [{ ...task, id: "no-evidence", evidence: [] }],
        tokenEstimator: EXACT_ESTIMATOR,
      }),
    ).toThrow(expect.objectContaining({ code: "CONTEXT_INPUT_INVALID" }));
    expect(() =>
      compileContext({
        maximumContextTokens: 10,
        candidates: [{ ...task, id: "unsafe", content: "unsafe\u0000text" }],
        tokenEstimator: EXACT_ESTIMATOR,
      }),
    ).toThrow(expect.objectContaining({ code: "CONTEXT_INPUT_INVALID" }));
    expect(() =>
      compileContext({
        maximumContextTokens: 10,
        candidates: [task],
        tokenEstimator: { source: "custom", estimateTokens: () => 0 },
      }),
    ).toThrow(expect.objectContaining({ code: "CONTEXT_TOKEN_ESTIMATE_INVALID" }));
  });

  it("adapts source records without letting them change their assigned layer", () => {
    const semanticCandidates = adaptContextSources(
      [{ id: "search-1", text: "1:semantic result" }],
      {
        layer: "semantic_retrieval",
        adapt(source) {
          return {
            id: source.id,
            content: source.text,
            selectionReason: "Hybrid search matched the current scene.",
            evidence: [evidence(source.id)],
          };
        },
      },
    );
    const compiled = compileContext({
      maximumContextTokens: 2,
      candidates: [candidate("current_task", "task", 1), ...semanticCandidates],
      tokenEstimator: EXACT_ESTIMATOR,
    });
    const sections = compiledContextToPromptSections(compiled);

    expect(semanticCandidates[0]?.layer).toBe("semantic_retrieval");
    expect(sections).toEqual([
      {
        kind: "user_input",
        text: "1:task",
        sourceId: "source-task",
        inclusion: "required",
      },
      {
        kind: "material",
        text: "1:semantic result",
        sourceId: "source-search-1",
        inclusion: "retrieved",
      },
    ]);
  });

  it("uses a deterministic model-neutral UTF-8 estimate by default", () => {
    expect(estimateContextTokensUtf8Conservative("abc")).toBe(1);
    expect(estimateContextTokensUtf8Conservative("墨")).toBe(1);
    expect(estimateContextTokensUtf8Conservative("😀")).toBe(2);

    const compiled = compileContext({
      maximumContextTokens: 10,
      candidates: [
        {
          ...candidate("current_task", "task", 1),
          content: "墨影",
        },
      ],
    });
    expect(compiled.trace.tokenEstimateSource).toBe("utf8_conservative");
    expect(compiled.entries[0]?.estimatedTokens).toBe(2);
  });

  it("keeps compilation output immutable for downstream trace consumers", () => {
    const compiled = compileContext({
      maximumContextTokens: 1,
      candidates: [candidate("current_task", "task", 1)],
      tokenEstimator: EXACT_ESTIMATOR,
    });

    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.entries)).toBe(true);
    expect(Object.isFrozen(compiled.entries[0]?.evidence)).toBe(true);
    expect(Object.isFrozen(compiled.trace.layers)).toBe(true);
  });
});

function candidate(
  layer: ContextLayer,
  id: string,
  tokens: number,
  overrides: Partial<Pick<ContextCandidate, "priority" | "relevanceScore">> = {},
): ContextCandidate {
  return {
    id,
    layer,
    content: `${String(tokens)}:${id}`,
    selectionReason: `Relevant ${layer} context.`,
    evidence: [evidence(id)],
    ...overrides,
  };
}

function evidence(id: string) {
  return {
    sourceType: "other" as const,
    sourceId: `source-${id}`,
    sourceVersionId: `version-${id}`,
    locator: `test:${id}`,
    contentHash: null,
    excerpt: `Evidence for ${id}.`,
  };
}
