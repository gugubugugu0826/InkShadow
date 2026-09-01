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

  it("deduplicates the same fact across rule, memory and search while merging evidence", () => {
    const sharedContent = "林知夏不能离开校园。";
    const compiled = compileContext({
      maximumContextTokens: 20,
      candidates: [
        candidate("current_task", "task", 1),
        sourceCandidate("locked_hard_rules", "rule", sharedContent, "story_rule", "rule-1", "v1"),
        sourceCandidate(
          "character_current_state",
          "memory",
          sharedContent,
          "memory",
          "memory-1",
          "v1",
        ),
        sourceCandidate(
          "semantic_retrieval",
          "search",
          `[命中资料]\n${sharedContent}`,
          "search_document",
          "search-1",
          "v1",
        ),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    expect(compiled.entries.find(({ id }) => id === "rule")).toMatchObject({
      included: true,
      evidence: expect.arrayContaining([
        expect.objectContaining({ sourceType: "story_rule" }),
        expect.objectContaining({ sourceType: "memory" }),
        expect.objectContaining({ sourceType: "search_document" }),
      ]),
    });
    expect(
      compiled.entries.filter(({ discardedReason }) => discardedReason === "duplicate_source"),
    ).toHaveLength(2);
    expect(
      compiledContextToPromptSections(compiled).filter(({ text }) => text.includes(sharedContent)),
    ).toHaveLength(1);
  });

  it("deduplicates a professional constraint carried by both ProjectSeed and a locked fact", () => {
    const seedContent =
      "[用户已确认的作者明确禁止项]\n- 禁止项：不新增超自然力量\n- 其他创作约束：每章保持单一视角";
    const factContent =
      "[已确认并锁定的规则]\n类型：writing_constraint\n内容：禁止项：不新增超自然力量\n其他创作约束：每章保持单一视角";
    const compiled = compileContext({
      maximumContextTokens: 20,
      candidates: [
        candidate("current_task", "task", 1),
        sourceCandidate(
          "locked_hard_rules",
          "seed-constraint",
          seedContent,
          "story_rule",
          "project-1",
          "seed-r1",
        ),
        sourceCandidate(
          "locked_hard_rules",
          "fact-constraint",
          factContent,
          "story_rule",
          "fact-1",
          null,
        ),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    const included = compiled.entries.filter(
      ({ included, layer }) => included && layer === "locked_hard_rules",
    );
    expect(included).toHaveLength(1);
    expect(included[0]?.evidence).toHaveLength(2);
    expect(
      compiledContextToPromptSections(compiled).filter(({ text }) =>
        text.includes("不新增超自然力量"),
      ),
    ).toHaveLength(1);
  });

  it("keeps the task skeleton while merging a repeated author requirement into the higher authority", () => {
    const sharedContent = "继续写出雨夜重逢后的第一场对话。";
    const compiled = compileContext({
      maximumContextTokens: 10,
      candidates: [
        sourceCandidate(
          "current_task",
          "task-skeleton",
          "续写当前已保存章节，并保持事实连续。",
          "generation_task",
          "task-1",
          "v1",
        ),
        sourceCandidate(
          "current_task",
          "author-requirement",
          sharedContent,
          "user_input",
          "request-1",
          "v1",
        ),
        sourceCandidate("locked_hard_rules", "rule", sharedContent, "story_rule", "rule-1", "v1"),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    expect(compiled.entries.find(({ id }) => id === "task-skeleton")).toMatchObject({
      included: true,
      required: true,
      discardedReason: null,
    });
    expect(compiled.entries.find(({ id }) => id === "rule")).toMatchObject({
      included: true,
      required: true,
      discardedReason: null,
      evidence: expect.arrayContaining([
        expect.objectContaining({ sourceType: "story_rule" }),
        expect.objectContaining({ sourceType: "user_input" }),
      ]),
    });
    expect(compiled.entries.find(({ id }) => id === "author-requirement")).toMatchObject({
      included: false,
      required: false,
      discardedReason: "duplicate_source",
    });
  });

  it("never removes the structural generation task when a story source repeats it", () => {
    const sharedContent = "续写当前已保存章节，并保持事实连续。";
    const compiled = compileContext({
      maximumContextTokens: 10,
      candidates: [
        sourceCandidate(
          "current_task",
          "task-skeleton",
          sharedContent,
          "generation_task",
          "task-1",
          "v1",
        ),
        sourceCandidate(
          "locked_hard_rules",
          "coincidental-rule",
          sharedContent,
          "story_rule",
          "rule-1",
          "v1",
        ),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    expect(compiled.entries.find(({ id }) => id === "task-skeleton")).toMatchObject({
      included: true,
      required: true,
      discardedReason: null,
    });
    expect(compiled.entries.find(({ id }) => id === "coincidental-rule")).toMatchObject({
      included: true,
      required: true,
      discardedReason: null,
    });
  });

  it("keeps identical dialogue samples owned by different characters", () => {
    const compiled = compileContext({
      maximumContextTokens: 10,
      candidates: [
        candidate("current_task", "task", 1),
        sourceCandidate(
          "character_voice_samples",
          "voice-a",
          "我知道。",
          "character",
          "character-a",
          "v1",
        ),
        sourceCandidate(
          "character_voice_samples",
          "voice-b",
          "我知道。",
          "character",
          "character-b",
          "v1",
        ),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    expect(
      compiled.entries
        .filter(({ id }) => id.startsWith("voice-"))
        .every(({ included, discardedReason }) => included && discardedReason === null),
    ).toBe(true);
  });

  it("keeps distinct revisions from the same source even when their text is unchanged", () => {
    const compiled = compileContext({
      maximumContextTokens: 10,
      candidates: [
        candidate("current_task", "task", 1),
        sourceCandidate("recent_events", "revision-1", "同一事件", "chapter", "chapter-1", "v1"),
        sourceCandidate("recent_events", "revision-2", "同一事件", "chapter", "chapter-1", "v2"),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    expect(
      compiled.entries
        .filter(({ id }) => id.startsWith("revision-"))
        .every(({ included }) => included),
    ).toBe(true);
  });

  it("deduplicates one source revision and content fingerprint across adapter source types", () => {
    const sharedHash = "a".repeat(64);
    const compiled = compileContext({
      maximumContextTokens: 10,
      candidates: [
        candidate("current_task", "task", 1),
        hashedSourceCandidate(
          "recent_events",
          "accepted-chapter",
          "[当前章节]\n钟声在雨里停了。",
          "chapter",
          "chapter-1",
          "version-7",
          sharedHash,
        ),
        hashedSourceCandidate(
          "semantic_retrieval",
          "retrieved-chapter",
          "[检索命中]\n钟声在雨里停了。",
          "search_document",
          "chapter-1",
          "version-7",
          sharedHash,
        ),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    expect(compiled.entries.find(({ id }) => id === "accepted-chapter")).toMatchObject({
      included: true,
      evidence: expect.arrayContaining([
        expect.objectContaining({ sourceType: "chapter" }),
        expect.objectContaining({ sourceType: "search_document" }),
      ]),
    });
    expect(compiled.entries.find(({ id }) => id === "retrieved-chapter")).toMatchObject({
      included: false,
      discardedReason: "duplicate_source",
    });
  });

  it("fails closed on conflicting content fingerprints for the same source revision", () => {
    expect(() =>
      compileContext({
        maximumContextTokens: 10,
        candidates: [
          candidate("current_task", "task", 1),
          hashedSourceCandidate(
            "recent_events",
            "source-a",
            "同一显示文字",
            "chapter",
            "chapter-1",
            "version-7",
            "a".repeat(64),
          ),
          hashedSourceCandidate(
            "semantic_retrieval",
            "source-b",
            "同一显示文字",
            "search_document",
            "chapter-1",
            "version-7",
            "b".repeat(64),
          ),
        ],
        tokenEstimator: { source: "custom", estimateTokens: () => 1 },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "CONTEXT_SOURCE_FINGERPRINT_CONFLICT",
        details: { conflictingEntryIds: ["source-a", "source-b"] },
      }),
    );
  });

  it("keeps separately located spans from one source revision independently traceable", () => {
    const compiled = compileContext({
      maximumContextTokens: 10,
      candidates: [
        candidate("current_task", "task", 1),
        hashedSourceCandidate(
          "locked_hard_rules",
          "locked-span",
          "周望必须守住钟楼。",
          "story_rule",
          "chapter-1",
          "version-7",
          "a".repeat(64),
          "utf16:0-9/100",
        ),
        hashedSourceCandidate(
          "recent_events",
          "latest-tail",
          "钟摆倒转后，周望奔向塔顶。",
          "chapter",
          "chapter-1",
          "version-7",
          "b".repeat(64),
          "utf16:70-100/100",
        ),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    expect(compiled.entries.find(({ id }) => id === "locked-span")?.included).toBe(true);
    expect(compiled.entries.find(({ id }) => id === "latest-tail")?.included).toBe(true);
  });

  it("reserves budget for explicitly protected authoritative prose before optional material", () => {
    const compiled = compileContext({
      maximumContextTokens: 6,
      candidates: [
        candidate("current_task", "task", 1),
        candidate("scene_goal", "optional-scene", 4),
        {
          ...candidate("recent_events", "latest-prose", 3),
          budgetRetention: "required" as const,
        },
        candidate("semantic_retrieval", "old-summary", 1),
      ],
      tokenEstimator: EXACT_ESTIMATOR,
    });

    expect(compiled.entries.find(({ id }) => id === "latest-prose")).toMatchObject({
      included: true,
      required: true,
      discardedReason: null,
    });
    expect(compiled.entries.find(({ id }) => id === "optional-scene")).toMatchObject({
      included: false,
      discardedReason: "token_budget_exhausted",
    });
    expect(compiled.trace).toMatchObject({ requiredTokens: 4, usedTokens: 5 });
  });

  it("places a preferred writing method after confirmed story context but before low-priority retrieval and preferences", () => {
    const compiled = compileContext({
      maximumContextTokens: 4,
      candidates: [
        candidate("current_task", "task", 1),
        candidate("recent_events", "latest-prose", 1),
        {
          ...candidate("rerank_supplement", "writing-method", 1),
          budgetRetention: "preferred" as const,
        },
        candidate("semantic_retrieval", "old-summary", 2),
        candidate("rerank_supplement", "writing-preference", 1),
      ],
      tokenEstimator: EXACT_ESTIMATOR,
    });

    expect(compiled.entries.map(({ id }) => id)).toEqual([
      "task",
      "latest-prose",
      "writing-method",
      "old-summary",
      "writing-preference",
    ]);
    expect(compiled.entries.find(({ id }) => id === "writing-method")).toMatchObject({
      included: true,
      required: false,
    });
    expect(compiled.entries.find(({ id }) => id === "old-summary")).toMatchObject({
      included: false,
      discardedReason: "token_budget_exhausted",
    });
  });

  it("falls back to canonical content when source hashes are unavailable", () => {
    const compiled = compileContext({
      maximumContextTokens: 10,
      candidates: [
        candidate("current_task", "task", 1),
        sourceCandidate("world_setting", "plain", "夜间禁止鸣笛。", "world", "world-1", "v1"),
        sourceCandidate(
          "semantic_retrieval",
          "wrapped",
          "【世界设定】\n夜间禁止鸣笛。",
          "world",
          "world-1",
          "v1",
        ),
      ],
      tokenEstimator: { source: "custom", estimateTokens: () => 1 },
    });

    expect(compiled.entries.find(({ id }) => id === "plain")?.included).toBe(true);
    expect(compiled.entries.find(({ id }) => id === "wrapped")?.discardedReason).toBe(
      "duplicate_source",
    );
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

function sourceCandidate(
  layer: ContextLayer,
  id: string,
  content: string,
  sourceType: ContextCandidate["evidence"][number]["sourceType"],
  sourceId: string,
  sourceVersionId: string | null,
): ContextCandidate {
  return {
    id,
    layer,
    content,
    selectionReason: `Relevant ${layer} context.`,
    evidence: [
      {
        sourceType,
        sourceId,
        sourceVersionId,
        locator: null,
        contentHash: null,
        excerpt: null,
      },
    ],
  };
}

function hashedSourceCandidate(
  layer: ContextLayer,
  id: string,
  content: string,
  sourceType: ContextCandidate["evidence"][number]["sourceType"],
  sourceId: string,
  sourceVersionId: string | null,
  contentHash: string,
  locator: string | null = null,
): ContextCandidate {
  return {
    ...sourceCandidate(layer, id, content, sourceType, sourceId, sourceVersionId),
    evidence: [
      {
        sourceType,
        sourceId,
        sourceVersionId,
        locator,
        contentHash,
        excerpt: null,
      },
    ],
  };
}
