import { compileContext, type ContextCandidateDraft, type ContextLayer } from "@inkshadow/ai-core";
import {
  StoryFact,
  type CreateStoryFactInput,
  type Result,
  type StoryCoreError,
  type StoryFactOrigin,
  type StoryFactStatus,
} from "@inkshadow/story-core";
import { describe, expect, it } from "vitest";

import {
  adaptStoryFactContextSource,
  assembleStoryContextCandidates,
  contextLayerForStoryFact,
} from "./story-context-source-adapter";

const NOW = "2026-08-01T00:00:00.000Z";
const LATER = "2026-08-01T00:01:00.000Z";
const PROJECT_ID = uuid(1);
const ACTOR_ID = uuid(2);
const BRANCH_ID = uuid(3);

describe("unified story fact context adapter", () => {
  it("assembles an explicit task, optional scene goal, and reviewed facts into fixed layers", () => {
    const facts = [
      fact(10, "world_rule", { locked: true, contentText: "魔法不能复活死者。" }),
      fact(11, "pov.knowledge", { contentText: "林遥只知道钥匙被人拿走。" }),
      fact(12, "character.state", { contentText: "林遥的左臂受伤。" }),
      fact(13, "timeline_event", { contentText: "列车刚刚离站。" }),
      fact(14, "causal_event", { contentText: "停电导致监控失效。" }),
      fact(15, "foreshadow", { contentText: "旧怀表仍未解释。" }),
      fact(16, "world_setting", { contentText: "城门日落后关闭。" }),
      fact(17, "character.voice", { contentText: "苏晚习惯用短句反问。" }),
      fact(18, "memory", { contentText: "与当前车站场景语义相关。" }),
    ];

    const assembled = assembleStoryContextCandidates({
      projectId: PROJECT_ID,
      currentBranchId: null,
      currentTask: explicit("continue-chapter", "续写本章下一场景。", "generation_task"),
      sceneGoal: explicit("escape-platform", "让主角在不暴露身份的情况下离开站台。", "scene_plan"),
      facts,
    });

    expect(assembled.candidates.map(({ layer }) => layer)).toEqual([
      "current_task",
      "scene_goal",
      "locked_hard_rules",
      "pov_known_information",
      "character_current_state",
      "recent_events",
      "related_causal_chain",
      "unresolved_foreshadowing",
      "world_setting",
      "character_voice_samples",
      "semantic_retrieval",
    ] satisfies ContextLayer[]);
    expect(assembled.includedFactIds).toEqual(facts.map(({ id }) => id));
    expect(assembled.discardedFacts).toEqual([]);

    const compiled = compileContext({
      maximumContextTokens: 100_000,
      candidates: assembled.candidates,
    });
    expect(compiled.entries.every(({ included }) => included)).toBe(true);
    expect(compiled.entries[0]).toMatchObject({
      layer: "locked_hard_rules",
      required: true,
    });
  });

  it("fails closed with a stable audit reason for every non-authoritative fact", () => {
    const unconfirmed = fact(20, "character.state", {
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
    });
    const temporary = fact(21, "character.state", { status: "temporary" });
    const deprecated = unwrap(
      fact(22, "world_rule").deprecate({
        humanConfirmed: true,
        expectedRevision: 1,
        now: LATER,
      }),
    );
    const otherProject = fact(23, "world_setting", { projectId: uuid(99) });
    const unknownType = fact(24, "custom.unreviewed_mapping");
    const otherBranch = fact(25, "timeline_event", {
      status: "branch",
      branchId: uuid(4),
    });
    const aiBranch = fact(26, "timeline_event", {
      status: "branch",
      branchId: BRANCH_ID,
      origin: "ai_extraction",
      needsReview: true,
    });
    const reviewableUserBranch = fact(27, "timeline_event", {
      status: "branch",
      branchId: BRANCH_ID,
      needsReview: true,
    });
    const currentUserBranch = fact(28, "timeline_event", {
      status: "branch",
      branchId: BRANCH_ID,
      contentText: "在这条试演分支中，列车没有离站。",
    });

    const assembled = assembleStoryContextCandidates({
      projectId: PROJECT_ID,
      currentBranchId: BRANCH_ID,
      currentTask: explicit("branch-continuation", "继续当前试演分支。", "generation_task"),
      facts: [
        unconfirmed,
        temporary,
        deprecated,
        otherProject,
        unknownType,
        otherBranch,
        aiBranch,
        reviewableUserBranch,
        currentUserBranch,
      ],
    });

    expect(assembled.includedFactIds).toEqual([currentUserBranch.id]);
    expect(
      Object.fromEntries(assembled.discardedFacts.map(({ factId, reason }) => [factId, reason])),
    ).toEqual({
      [unconfirmed.id]: "unconfirmed",
      [temporary.id]: "temporary",
      [deprecated.id]: "deprecated",
      [otherProject.id]: "project_mismatch",
      [unknownType.id]: "unmapped_fact_type",
      [otherBranch.id]: "other_branch",
      [aiBranch.id]: "branch_not_user_authored",
      [reviewableUserBranch.id]: "needs_review",
    });
    const selectedBranchCandidate = assembled.candidates.at(-1);
    expect(selectedBranchCandidate?.layer).toBe("recent_events");
    expect(selectedBranchCandidate?.content).toContain("不是主线正式事实");
    expect(selectedBranchCandidate?.selectionReason).toContain("branch-scoped");
  });

  it("keeps branch facts out of mainline context even when the user authored them", () => {
    const branchFact = fact(30, "timeline_event", {
      status: "branch",
      branchId: BRANCH_ID,
    });

    const decision = adaptStoryFactContextSource(branchFact, {
      projectId: PROJECT_ID,
      currentBranchId: null,
    });

    expect(decision.included).toBe(false);
    if (decision.included) {
      throw new Error("Expected a branch discard.");
    }
    expect(decision.discard.reason).toBe("no_current_branch");
  });

  it("accepts an AI-origin fact only after explicit user confirmation", () => {
    const proposed = fact(40, "relationship", {
      status: "unconfirmed",
      origin: "ai_extraction",
      needsReview: true,
      contentText: "林遥与苏晚已经成为盟友。",
    });
    const beforeReview = adaptStoryFactContextSource(proposed, {
      projectId: PROJECT_ID,
      currentBranchId: null,
    });
    const confirmed = unwrap(
      proposed.confirm({
        actorId: ACTOR_ID,
        humanConfirmed: true,
        expectedRevision: 1,
        now: LATER,
      }),
    );
    const afterReview = adaptStoryFactContextSource(confirmed, {
      projectId: PROJECT_ID,
      currentBranchId: null,
    });

    expect(beforeReview).toMatchObject({
      included: false,
      discard: { reason: "unconfirmed" },
    });
    expect(afterReview.included).toBe(true);
    if (!afterReview.included) {
      throw new Error("Expected the reviewed fact to be included.");
    }
    expect(afterReview.candidate.layer).toBe("character_current_state");
    expect(afterReview.candidate.selectionReason).toContain("explicit user confirmation");
  });

  it("uses only reviewed automatic temporary state as a reversible, non-authoritative aid", () => {
    const reversibleState = fact(45, "character_state", {
      status: "temporary",
      origin: "system",
      needsReview: false,
      contentText: "林遥的左臂仍然受伤。",
      source: {
        kind: "system_derivation",
        reference: "chapter-state:45",
      },
    });
    const unsafeTemporaryRule = fact(46, "world_rule", {
      status: "temporary",
      origin: "system",
      needsReview: false,
      contentText: "死者可以复活。",
      source: {
        kind: "system_derivation",
        reference: "weak-world-rule:46",
      },
    });

    const accepted = adaptStoryFactContextSource(reversibleState, {
      projectId: PROJECT_ID,
      currentBranchId: null,
    });
    const rejected = adaptStoryFactContextSource(unsafeTemporaryRule, {
      projectId: PROJECT_ID,
      currentBranchId: null,
    });

    expect(accepted.included).toBe(true);
    if (!accepted.included) {
      throw new Error("Expected reversible state to be included.");
    }
    expect(accepted.candidate.layer).toBe("character_current_state");
    expect(accepted.candidate.content).toContain("可撤销的临时状态");
    expect(accepted.candidate.selectionReason).toContain("non-authoritative aid");
    expect(rejected).toMatchObject({ included: false, discard: { reason: "temporary" } });
  });

  it("preserves chapter, version, UTF-16 locator, excerpt, and narrative locators", () => {
    const chapterId = uuid(51);
    const versionId = uuid(52);
    const evidenced = fact(50, "relationship", {
      contentText: "林遥与苏晚成为盟友。",
      structuredValue: { from: "林遥", relation: "盟友", to: "苏晚" },
      effectiveAt: "第一卷/第三章/雨夜之后",
      invalidatedAt: "第一卷/第十章/决裂",
      source: {
        kind: "chapter_span",
        reference: `chapter-version:${versionId}`,
        chapterId,
        versionId,
        startOffset: 2,
        endOffset: 6,
        sourceLength: 10,
        excerpt: "成为盟友",
      },
    });

    const decision = adaptStoryFactContextSource(evidenced, {
      projectId: PROJECT_ID,
      currentBranchId: null,
    });
    expect(decision.included).toBe(true);
    if (!decision.included) {
      throw new Error("Expected an included fact.");
    }
    expect(decision.candidate).toMatchObject({
      id: `story-fact:${evidenced.id}:r1`,
      layer: "character_current_state",
      evidence: [
        {
          sourceType: "chapter",
          sourceId: chapterId,
          sourceVersionId: versionId,
          locator: `chapter-version:${versionId}#utf16:2-6/10`,
          contentHash: null,
          excerpt: "成为盟友",
        },
      ],
    });
    expect(decision.candidate.content).toMatch(
      /生效位置：第一卷\/第三章\/雨夜之后[\s\S]*失效位置：第一卷\/第十章\/决裂/u,
    );
    expect(decision.candidate.content).toContain(
      '结构化值：{"from":"林遥","relation":"盟友","to":"苏晚"}',
    );
  });

  it("treats every explicitly locked formal fact as a required constraint", () => {
    const extensionFact = fact(60, "custom.author_constraint", {
      locked: true,
      contentText: "主角不能使用枪械。",
    });

    expect(contextLayerForStoryFact(extensionFact)).toBe("locked_hard_rules");
    expect(
      adaptStoryFactContextSource(extensionFact, {
        projectId: PROJECT_ID,
        currentBranchId: null,
      }),
    ).toMatchObject({
      included: true,
      candidate: { layer: "locked_hard_rules", priority: 1_000 },
    });
  });

  it("requires an explicit evidenced current task and returns immutable output", () => {
    expect(() =>
      assembleStoryContextCandidates({
        projectId: PROJECT_ID,
        currentBranchId: null,
        currentTask: undefined as never,
        facts: [],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "STORY_CONTEXT_CURRENT_TASK_REQUIRED",
      }),
    );

    const assembled = assembleStoryContextCandidates({
      projectId: PROJECT_ID,
      currentBranchId: null,
      currentTask: explicit("rewrite", "改写所选段落。", "generation_task"),
      facts: [fact(70, "world_setting")],
    });
    expect(Object.isFrozen(assembled)).toBe(true);
    expect(Object.isFrozen(assembled.candidates)).toBe(true);
    expect(Object.isFrozen(assembled.candidates[0]?.evidence)).toBe(true);
    expect(Object.isFrozen(assembled.discardedFacts)).toBe(true);
  });

  it("audits unsafe content or evidence instead of silently rewriting it", () => {
    const unsafeContent = fact(80, "world_setting", {
      contentText: "unsafe\u0001content",
    });
    const unsafeEvidence = fact(81, "world_setting", {
      contentText: "安全正文",
      source: {
        kind: "chapter_span",
        reference: "chapter-version:unsafe-excerpt",
        chapterId: uuid(82),
        versionId: uuid(83),
        startOffset: 0,
        endOffset: 2,
        sourceLength: 3,
        excerpt: "a\u0001",
      },
    });

    expect(
      adaptStoryFactContextSource(unsafeContent, {
        projectId: PROJECT_ID,
        currentBranchId: null,
      }),
    ).toMatchObject({ included: false, discard: { reason: "context_content_invalid" } });
    expect(
      adaptStoryFactContextSource(unsafeEvidence, {
        projectId: PROJECT_ID,
        currentBranchId: null,
      }),
    ).toMatchObject({ included: false, discard: { reason: "context_evidence_invalid" } });
  });

  it("includes only a summary for the verified current chapter version with exact evidence", () => {
    const chapterId = uuid(90);
    const currentVersionId = uuid(91);
    const oldVersionId = uuid(92);
    const contentHash = "a".repeat(64);
    const current = chapterSummaryFact(93, chapterId, currentVersionId, contentHash);
    const old = chapterSummaryFact(94, chapterId, oldVersionId, "b".repeat(64));

    const assembled = assembleStoryContextCandidates({
      projectId: PROJECT_ID,
      currentBranchId: null,
      currentTask: explicit("continue", "Continue the story.", "generation_task"),
      currentChapterVersions: {
        [chapterId]: { versionId: currentVersionId, contentHash },
      },
      facts: [old, current],
    });

    expect(assembled.includedFactIds).toEqual([current.id]);
    expect(assembled.discardedFacts).toContainEqual(
      expect.objectContaining({ factId: old.id, reason: "rebuildable_source_not_current" }),
    );
    expect(assembled.candidates.at(-1)).toMatchObject({
      layer: "recent_events",
      evidence: [
        {
          sourceType: "chapter",
          sourceId: chapterId,
          sourceVersionId: currentVersionId,
          locator: "utf16:0-4/10",
          contentHash,
          excerpt: "ABCD",
        },
      ],
    });
    expect(assembled.candidates.at(-1)?.content).toContain("Current summary");
    expect(assembled.candidates.at(-1)?.content).not.toContain("sourceContentHash");
  });

  it("fails closed without a current-version registry and deterministically deduplicates summaries", () => {
    const chapterId = uuid(95);
    const versionId = uuid(96);
    const contentHash = "c".repeat(64);
    const first = chapterSummaryFact(97, chapterId, versionId, contentHash);
    const second = chapterSummaryFact(98, chapterId, versionId, contentHash);

    expect(
      adaptStoryFactContextSource(first, {
        projectId: PROJECT_ID,
        currentBranchId: null,
      }),
    ).toMatchObject({ included: false, discard: { reason: "rebuildable_source_not_current" } });

    const assembled = assembleStoryContextCandidates({
      projectId: PROJECT_ID,
      currentBranchId: null,
      currentTask: explicit("continue", "Continue the story.", "generation_task"),
      currentChapterVersions: { [chapterId]: { versionId, contentHash } },
      facts: [first, second],
    });
    expect(assembled.includedFactIds).toEqual([second.id]);
    expect(assembled.discardedFacts).toContainEqual(
      expect.objectContaining({ factId: first.id, reason: "superseded_rebuildable_fact" }),
    );
  });
});

interface FactOptions {
  readonly projectId?: string;
  readonly contentText?: string;
  readonly structuredValue?: unknown;
  readonly effectiveAt?: string;
  readonly invalidatedAt?: string;
  readonly source?: CreateStoryFactInput["source"];
  readonly status?: Exclude<StoryFactStatus, "deprecated">;
  readonly origin?: StoryFactOrigin;
  readonly needsReview?: boolean;
  readonly locked?: boolean;
  readonly branchId?: string;
}

function fact(sequence: number, factType: string, options: FactOptions = {}): StoryFact {
  const status = options.status ?? "formal";
  const origin = options.origin ?? "user";
  return unwrap(
    StoryFact.create({
      id: uuid(sequence),
      projectId: options.projectId ?? PROJECT_ID,
      factType,
      contentText: options.contentText ?? `${factType} 的内容。`,
      ...(options.structuredValue === undefined
        ? {}
        : { structuredValue: options.structuredValue }),
      source: options.source ?? {
        kind: "user_statement",
        reference: `user-statement:${String(sequence)}`,
      },
      ...(options.effectiveAt === undefined ? {} : { effectiveAt: options.effectiveAt }),
      ...(options.invalidatedAt === undefined ? {} : { invalidatedAt: options.invalidatedAt }),
      ...(options.branchId === undefined ? {} : { branchId: options.branchId }),
      confidence: 0.9,
      status,
      origin,
      needsReview:
        options.needsReview ??
        (origin === "ai_extraction" || origin === "import" || origin === "legacy"),
      ...(options.locked === undefined ? {} : { locked: options.locked }),
      humanConfirmed: status === "formal",
      ...(status === "formal" ? { confirmationActorId: ACTOR_ID } : {}),
      now: NOW,
    }),
  );
}

function chapterSummaryFact(
  sequence: number,
  chapterId: string,
  versionId: string,
  contentHash: string,
): StoryFact {
  const evidenceId = `chapter:${chapterId}:version:${versionId}:sha256:${contentHash}:utf16:0-4`;
  return unwrap(
    StoryFact.create({
      id: uuid(sequence),
      projectId: PROJECT_ID,
      factType: "chapter_summary",
      contentText: "Current summary",
      structuredValue: {
        schemaVersion: "inkshadow.rebuildable-system-fact.v1",
        replacementKey: `chapter:${chapterId}`,
        payload: {
          schemaVersion: "inkshadow.chapter-summary.v1",
          sourceProjectId: PROJECT_ID,
          sourceChapterId: chapterId,
          sourceVersionId: versionId,
          sourceContentHash: contentHash,
          citations: [{ evidenceId, startOffset: 0, endOffset: 4, sourceLength: 10 }],
          keyEvents: [{ text: "Event", evidenceIds: [evidenceId] }],
          continuityNotes: [{ text: "Note", evidenceIds: [evidenceId] }],
          generation: {
            task: "long_memory_compression",
            providerKind: "ollama",
            modelId: "test-model",
            invocationId: uuid(sequence + 100),
          },
          budget: {
            strategy: "bounded_utf16_segments",
            segmentCharacters: 1800,
            maximumSegments: 48,
            sourceCharacters: 10,
            estimatedInputTokens: 100,
            tokenEstimate: "model_hub_estimate_not_provider_tokenizer",
          },
        },
      },
      source: {
        kind: "chapter_span",
        reference: `chapter-summary:${chapterId}:${versionId}:sha256:${contentHash}`,
        chapterId,
        versionId,
        startOffset: 0,
        endOffset: 4,
        sourceLength: 10,
        excerpt: "ABCD",
      },
      confidence: 1,
      status: "temporary",
      origin: "system",
      needsReview: false,
      humanConfirmed: false,
      now: NOW,
    }),
  );
}

function explicit(
  id: string,
  content: string,
  sourceType: "generation_task" | "scene_plan",
): ContextCandidateDraft {
  return {
    id,
    content,
    selectionReason:
      sourceType === "generation_task"
        ? "The user explicitly requested this task."
        : "The selected scene plan defines this goal.",
    evidence: [
      {
        sourceType,
        sourceId: `${sourceType}-${id}`,
        sourceVersionId: null,
        locator: `${sourceType}:${id}`,
        contentHash: null,
        excerpt: content,
      },
    ],
    priority: 1_000,
  };
}

function unwrap<Value>(result: Result<Value, StoryCoreError>): Value {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function uuid(sequence: number): string {
  return `019f9f4a-b3c7-7350-9226-${sequence.toString(16).padStart(12, "0")}`;
}
