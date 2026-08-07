import type {
  ContextCandidate,
  ContextCandidateDraft,
  ContextEvidenceReference,
  ContextEvidenceSourceType,
  ContextLayer,
} from "@inkshadow/ai-core";
import type {
  StoryFact,
  StoryFactOrigin,
  StoryFactSnapshot,
  StoryFactStatus,
  StoryValue,
} from "@inkshadow/story-core";
import { storyFactUpdatePolicy } from "@inkshadow/story-core";

import { parseStoredChapterSummaryPayload } from "./chapter-summary-service";

export const STORY_CONTEXT_FACT_DISCARD_REASONS = [
  "project_mismatch",
  "unconfirmed",
  "temporary",
  "deprecated",
  "no_current_branch",
  "other_branch",
  "branch_not_user_authored",
  "needs_review",
  "formal_not_user_confirmed",
  "unmapped_fact_type",
  "context_content_invalid",
  "context_evidence_invalid",
  "rebuildable_metadata_invalid",
  "rebuildable_source_not_current",
  "superseded_rebuildable_fact",
] as const;

export type StoryContextFactDiscardReason = (typeof STORY_CONTEXT_FACT_DISCARD_REASONS)[number];

export interface StoryContextFactScope {
  readonly projectId: string;
  /** Null means the main timeline; branch facts are then excluded. */
  readonly currentBranchId: string | null;
  /**
   * Verified immutable current-version registry. Rebuildable chapter summaries
   * fail closed when this registry is absent or does not match both version and
   * checksum.
   */
  readonly currentChapterVersions?: Readonly<
    Record<string, Readonly<{ versionId: string; contentHash: string }>>
  >;
}

export interface StoryContextFactDiscard {
  readonly factId: string;
  readonly revision: number;
  readonly factType: string;
  readonly status: StoryFactStatus;
  readonly origin: StoryFactOrigin;
  readonly reason: StoryContextFactDiscardReason;
  readonly explanation: string;
}

export type StoryContextFactDecision =
  | Readonly<{
      readonly included: true;
      readonly candidate: ContextCandidate;
    }>
  | Readonly<{
      readonly included: false;
      readonly discard: StoryContextFactDiscard;
    }>;

export interface AssembleStoryContextCandidatesInput extends StoryContextFactScope {
  /**
   * The caller must describe the operation being performed. It cannot be
   * inferred from a story fact, memory hit, or model output.
   */
  readonly currentTask: ContextCandidateDraft;
  /** A scene plan is optional because not every task operates on a scene. */
  readonly sceneGoal?: ContextCandidateDraft | null;
  readonly facts: readonly StoryFact[];
}

export interface AssembledStoryContextCandidates {
  readonly candidates: readonly ContextCandidate[];
  readonly includedFactIds: readonly string[];
  readonly discardedFacts: readonly StoryContextFactDiscard[];
}

export type StoryContextSourceAdapterErrorCode = "STORY_CONTEXT_CURRENT_TASK_REQUIRED";

export class StoryContextSourceAdapterError extends Error {
  public constructor(
    readonly code: StoryContextSourceAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoryContextSourceAdapterError";
  }
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MAXIMUM_CONTEXT_CONTENT_CHARACTERS = 200_000;
const MAXIMUM_EVIDENCE_LOCATOR_CHARACTERS = 2_000;
const MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS = 20_000;

const FACT_TYPE_TO_LAYER = new Map<string, ContextLayer>([
  ["scene_goal", "scene_goal"],
  ["scene.goal", "scene_goal"],
  ["pov_knowledge", "pov_known_information"],
  ["pov.knowledge", "pov_known_information"],
  ["pov_known_information", "pov_known_information"],
  ["pov.known_information", "pov_known_information"],
  ["character_knowledge", "pov_known_information"],
  ["character.knowledge", "pov_known_information"],
  ["character", "character_current_state"],
  ["character_state", "character_current_state"],
  ["character.state", "character_current_state"],
  ["relationship_change", "character_current_state"],
  ["character_identity", "character_current_state"],
  ["character.identity", "character_current_state"],
  ["relationship", "character_current_state"],
  ["character_relationship", "character_current_state"],
  ["character.relationship", "character_current_state"],
  ["timeline_event", "recent_events"],
  ["timeline.event", "recent_events"],
  ["recent_event", "recent_events"],
  ["recent.event", "recent_events"],
  ["event", "recent_events"],
  ["event_category", "recent_events"],
  ["scene_tag", "recent_events"],
  ["chapter_summary", "recent_events"],
  ["causal_event", "related_causal_chain"],
  ["causal.event", "related_causal_chain"],
  ["causal_chain", "related_causal_chain"],
  ["causal.chain", "related_causal_chain"],
  ["foreshadow", "unresolved_foreshadowing"],
  ["unresolved_foreshadowing", "unresolved_foreshadowing"],
  ["foreshadow.unresolved", "unresolved_foreshadowing"],
  ["world", "world_setting"],
  ["world_setting", "world_setting"],
  ["world.setting", "world_setting"],
  ["story_setting", "world_setting"],
  ["story.setting", "world_setting"],
  ["world_rule", "world_setting"],
  ["world.rule", "world_setting"],
  ["story_rule", "world_setting"],
  ["story.rule", "world_setting"],
  ["hard_rule", "world_setting"],
  ["hard.rule", "world_setting"],
  ["writing_rule", "world_setting"],
  ["writing.rule", "world_setting"],
  ["character_voice", "character_voice_samples"],
  ["character.voice", "character_voice_samples"],
  ["voice_sample", "character_voice_samples"],
  ["voice.sample", "character_voice_samples"],
  ["dialogue_sample", "character_voice_samples"],
  ["dialogue.sample", "character_voice_samples"],
  ["memory", "semantic_retrieval"],
  ["semantic_memory", "semantic_retrieval"],
  ["memory.semantic", "semantic_retrieval"],
  ["weak_inference", "semantic_retrieval"],
]);

/**
 * Builds auditable candidates without reading persistence or changing story
 * state. Runtime retrieval, token budgeting, and prompt emission stay outside
 * this adapter.
 */
export function assembleStoryContextCandidates(
  input: AssembleStoryContextCandidatesInput,
): AssembledStoryContextCandidates {
  assertExplicitCurrentTask(input.currentTask);

  const candidates: ContextCandidate[] = [
    cloneExplicitCandidate("current_task", input.currentTask),
  ];
  if (input.sceneGoal !== undefined && input.sceneGoal !== null) {
    candidates.push(cloneExplicitCandidate("scene_goal", input.sceneGoal));
  }

  const includedFactIds: string[] = [];
  const discardedFacts: StoryContextFactDiscard[] = [];
  const summaryWinners = selectChapterSummaryWinners(input.facts, input);
  for (const fact of input.facts) {
    const decision = adaptStoryFactContextSource(fact, input);
    if (decision.included) {
      const payload = parseStoredChapterSummaryPayload(fact);
      if (
        fact.toSnapshot().factType === "chapter_summary" &&
        payload !== null &&
        summaryWinners.get(payload.sourceChapterId) !== fact.id
      ) {
        discardedFacts.push(discarded(fact.toSnapshot(), "superseded_rebuildable_fact").discard);
        continue;
      }
      candidates.push(decision.candidate);
      includedFactIds.push(fact.id);
    } else {
      discardedFacts.push(decision.discard);
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    includedFactIds: Object.freeze(includedFactIds),
    discardedFacts: Object.freeze(discardedFacts),
  });
}

/**
 * Applies the authority and branch gate before mapping a single fact. An AI,
 * import, legacy, or system branch inference can never pass this gate merely
 * because its branch matches the active branch.
 */
export function adaptStoryFactContextSource(
  fact: StoryFact,
  scope: StoryContextFactScope,
): StoryContextFactDecision {
  const snapshot = fact.toSnapshot();
  const authority = resolveFactAuthority(fact, scope);
  if (!authority.included) {
    return authority;
  }

  const layer = contextLayerForStoryFactSnapshot(snapshot);
  if (layer === null) {
    return discarded(snapshot, "unmapped_fact_type");
  }
  const content = renderFactContent(fact, snapshot, authority.authority);
  if (!isContextContent(content)) {
    return discarded(snapshot, "context_content_invalid");
  }
  const evidence = createFactEvidence(fact, snapshot, layer);
  if (evidence.length === 0 || !evidence.every(isContextEvidenceSafe)) {
    return discarded(snapshot, "context_evidence_invalid");
  }

  return Object.freeze({
    included: true,
    candidate: Object.freeze({
      id: `story-fact:${snapshot.id}:r${String(snapshot.revision)}`,
      layer,
      content,
      selectionReason: selectionReason(snapshot, authority.authority, layer),
      evidence: Object.freeze(evidence.map((reference) => Object.freeze(reference))),
      priority: snapshot.locked ? 1_000 : Math.round(snapshot.confidence * 100),
      relevanceScore: snapshot.confidence,
    }),
  });
}

export function contextLayerForStoryFact(fact: StoryFact): ContextLayer | null {
  return contextLayerForStoryFactSnapshot(fact.toSnapshot());
}

function contextLayerForStoryFactSnapshot(snapshot: StoryFactSnapshot): ContextLayer | null {
  // Locking is an explicit governance action and makes the fact a required
  // constraint, regardless of its extensible fact type.
  if (snapshot.locked) {
    return "locked_hard_rules";
  }
  return FACT_TYPE_TO_LAYER.get(snapshot.factType) ?? null;
}

type IncludedAuthority = "formal" | "current_user_branch" | "automatic_reversible";

type AuthorityDecision =
  | Readonly<{ readonly included: true; readonly authority: IncludedAuthority }>
  | Readonly<{ readonly included: false; readonly discard: StoryContextFactDiscard }>;

function resolveFactAuthority(fact: StoryFact, scope: StoryContextFactScope): AuthorityDecision {
  const snapshot = fact.toSnapshot();
  if (snapshot.projectId !== scope.projectId) {
    return discarded(snapshot, "project_mismatch");
  }
  if (snapshot.status === "deprecated" || snapshot.deprecated) {
    return discarded(snapshot, "deprecated");
  }
  if (snapshot.status === "unconfirmed") {
    return discarded(snapshot, "unconfirmed");
  }
  if (snapshot.status === "temporary") {
    if (snapshot.factType === "chapter_summary" && snapshot.origin === "system") {
      const payload = parseStoredChapterSummaryPayload(fact);
      if (payload === null) {
        return discarded(snapshot, "rebuildable_metadata_invalid");
      }
      if (
        payload.sourceProjectId !== snapshot.projectId ||
        snapshot.source.kind !== "chapter_span" ||
        snapshot.source.chapterId !== payload.sourceChapterId ||
        snapshot.source.versionId !== payload.sourceVersionId
      ) {
        return discarded(snapshot, "rebuildable_metadata_invalid");
      }
      const current = scope.currentChapterVersions?.[payload.sourceChapterId];
      if (current === undefined) {
        return discarded(snapshot, "rebuildable_source_not_current");
      }
      if (
        current.versionId !== payload.sourceVersionId ||
        current.contentHash !== payload.sourceContentHash
      ) {
        return discarded(snapshot, "rebuildable_source_not_current");
      }
    }
    const policy = storyFactUpdatePolicy(snapshot.factType);
    if (
      snapshot.origin === "system" &&
      !snapshot.needsReview &&
      policy !== "human_confirmation_required"
    ) {
      return Object.freeze({ included: true, authority: "automatic_reversible" });
    }
    return discarded(snapshot, "temporary");
  }
  if (snapshot.status === "branch") {
    if (scope.currentBranchId === null) {
      return discarded(snapshot, "no_current_branch");
    }
    if (snapshot.branchId !== scope.currentBranchId) {
      return discarded(snapshot, "other_branch");
    }
    if (snapshot.origin !== "user") {
      return discarded(snapshot, "branch_not_user_authored");
    }
    if (snapshot.needsReview) {
      return discarded(snapshot, "needs_review");
    }
    return Object.freeze({ included: true, authority: "current_user_branch" });
  }
  if (!snapshot.userConfirmed) {
    return discarded(snapshot, "formal_not_user_confirmed");
  }
  if (snapshot.needsReview) {
    return discarded(snapshot, "needs_review");
  }
  return Object.freeze({ included: true, authority: "formal" });
}

function cloneExplicitCandidate(
  layer: "current_task" | "scene_goal",
  source: ContextCandidateDraft,
): ContextCandidate {
  return Object.freeze({
    ...source,
    layer,
    evidence: Object.freeze(source.evidence.map((reference) => Object.freeze({ ...reference }))),
  });
}

function assertExplicitCurrentTask(
  source: ContextCandidateDraft | null | undefined,
): asserts source is ContextCandidateDraft {
  if (
    typeof source !== "object" ||
    source === null ||
    typeof source.id !== "string" ||
    source.id.trim().length === 0 ||
    typeof source.content !== "string" ||
    source.content.trim().length === 0 ||
    !Array.isArray(source.evidence) ||
    source.evidence.length === 0
  ) {
    throw new StoryContextSourceAdapterError(
      "STORY_CONTEXT_CURRENT_TASK_REQUIRED",
      "Story context assembly requires an explicit current task with source evidence.",
    );
  }
}

function renderFactContent(
  fact: StoryFact,
  snapshot: StoryFactSnapshot,
  authority: IncludedAuthority,
): string {
  if (snapshot.factType === "chapter_summary") {
    const payload = parseStoredChapterSummaryPayload(fact);
    if (payload === null || snapshot.contentText === null) {
      return "";
    }
    return [
      "[系统生成、可撤销的当前版本章节摘要；不是正式故事设定]",
      `摘要：${snapshot.contentText}`,
      ...(payload.keyEvents.length === 0
        ? []
        : ["关键事件：", ...payload.keyEvents.map(({ text }) => `- ${text}`)]),
      ...(payload.continuityNotes.length === 0
        ? []
        : ["连续性提示：", ...payload.continuityNotes.map(({ text }) => `- ${text}`)]),
    ].join("\n");
  }
  const authorityLabel = snapshot.locked
    ? "已确认并锁定的规则"
    : authority === "formal"
      ? "用户已确认的正式事实"
      : authority === "current_user_branch"
        ? "当前分支的用户事实（不是主线正式事实）"
        : "系统自动更新、可撤销的临时状态（不是硬规则）";
  const lines = [`[${authorityLabel}]`, `类型：${snapshot.factType}`];
  if (snapshot.contentText !== null) {
    lines.push(`内容：${snapshot.contentText}`);
  }
  if (snapshot.structuredValue !== null) {
    lines.push(`结构化值：${canonicalStoryValue(snapshot.structuredValue)}`);
  }
  if (snapshot.effectiveAt !== null) {
    lines.push(`生效位置：${snapshot.effectiveAt}`);
  }
  if (snapshot.invalidatedAt !== null) {
    lines.push(`失效位置：${snapshot.invalidatedAt}`);
  }
  if (authority === "current_user_branch" && snapshot.branchId !== null) {
    lines.push(`仅适用分支：${snapshot.branchId}`);
  }
  return lines.join("\n");
}

function canonicalStoryValue(value: StoryValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStoryValue).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Readonly<Record<string, StoryValue>>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStoryValue(object[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createFactEvidence(
  fact: StoryFact,
  snapshot: StoryFactSnapshot,
  layer: ContextLayer,
): readonly ContextEvidenceReference[] {
  if (snapshot.factType === "chapter_summary") {
    const payload = parseStoredChapterSummaryPayload(fact);
    if (payload === null) {
      return Object.freeze([]);
    }
    return Object.freeze(
      payload.citations.map((citation) =>
        Object.freeze({
          sourceType: "chapter" as const,
          sourceId: payload.sourceChapterId,
          sourceVersionId: payload.sourceVersionId,
          locator: `utf16:${String(citation.startOffset)}-${String(citation.endOffset)}/${String(citation.sourceLength)}`,
          contentHash: payload.sourceContentHash,
          excerpt:
            snapshot.source.startOffset === citation.startOffset &&
            snapshot.source.endOffset === citation.endOffset
              ? snapshot.source.excerpt
              : null,
        }),
      ),
    );
  }
  const source = snapshot.source;
  const chapterLocator =
    source.kind === "chapter_span" &&
    source.startOffset !== null &&
    source.endOffset !== null &&
    source.sourceLength !== null
      ? `${source.reference}#utf16:${String(source.startOffset)}-${String(source.endOffset)}/${String(source.sourceLength)}`
      : source.reference;
  return [
    {
      sourceType: evidenceSourceType(snapshot, layer),
      sourceId: source.chapterId ?? snapshot.id,
      sourceVersionId: source.versionId,
      locator: chapterLocator,
      contentHash: null,
      excerpt: source.excerpt,
    },
  ];
}

function evidenceSourceType(
  snapshot: StoryFactSnapshot,
  layer: ContextLayer,
): ContextEvidenceSourceType {
  switch (snapshot.source.kind) {
    case "chapter_span":
      return "chapter";
    case "import_source":
      return "import";
    case "user_statement":
      return "user_input";
    case "legacy_record":
    case "review_decision":
    case "system_derivation":
      return sourceTypeForLayer(layer, snapshot.factType);
  }
}

function sourceTypeForLayer(
  layer: ContextLayer,
  factType: StoryFactSnapshot["factType"],
): ContextEvidenceSourceType {
  switch (layer) {
    case "locked_hard_rules":
      return "story_rule";
    case "current_task":
      return "generation_task";
    case "scene_goal":
      return "scene_plan";
    case "pov_known_information":
    case "character_voice_samples":
      return "character";
    case "character_current_state":
      return factType.includes("relationship") ? "relationship" : "character";
    case "recent_events":
      return "timeline_event";
    case "related_causal_chain":
      return "causal_event";
    case "unresolved_foreshadowing":
      return "foreshadow";
    case "world_setting":
      return "world";
    case "semantic_retrieval":
      return "memory";
    case "rerank_supplement":
      return "rerank_result";
  }
}

function selectionReason(
  snapshot: StoryFactSnapshot,
  authority: IncludedAuthority,
  layer: ContextLayer,
): string {
  if (snapshot.locked) {
    return "The user confirmed and locked this fact, so it is a required hard constraint.";
  }
  if (authority === "current_user_branch") {
    return `The user authored this fact for the selected branch; it remains branch-scoped in ${layer}.`;
  }
  if (authority === "automatic_reversible") {
    return `This system-derived ${snapshot.factType} fact is explicitly reversible and remains a non-authoritative aid in ${layer}.`;
  }
  const reviewedOrigin = snapshot.origin === "user" ? "user-authored" : `${snapshot.origin}-origin`;
  return `This ${reviewedOrigin} fact is formal only after explicit user confirmation and maps to ${layer}.`;
}

function discarded(
  snapshot: StoryFactSnapshot,
  reason: StoryContextFactDiscardReason,
): Readonly<{ readonly included: false; readonly discard: StoryContextFactDiscard }> {
  return Object.freeze({
    included: false,
    discard: Object.freeze({
      factId: snapshot.id,
      revision: snapshot.revision,
      factType: snapshot.factType,
      status: snapshot.status,
      origin: snapshot.origin,
      reason,
      explanation: discardExplanation(reason),
    }),
  });
}

function discardExplanation(reason: StoryContextFactDiscardReason): string {
  switch (reason) {
    case "project_mismatch":
      return "The fact belongs to another project.";
    case "unconfirmed":
      return "The fact has not been explicitly confirmed by the user.";
    case "temporary":
      return "Temporary facts are not authoritative generation context.";
    case "deprecated":
      return "Deprecated facts must never be sent as active context.";
    case "no_current_branch":
      return "A branch fact cannot enter main-timeline context.";
    case "other_branch":
      return "The fact belongs to a different story branch.";
    case "branch_not_user_authored":
      return "Only an explicit user-authored fact may enter the selected branch context.";
    case "needs_review":
      return "The fact remains in the review queue.";
    case "formal_not_user_confirmed":
      return "A formal marker without explicit user confirmation is rejected fail-closed.";
    case "unmapped_fact_type":
      return "The extensible fact type has no reviewed context-layer mapping.";
    case "context_content_invalid":
      return "The fact cannot be represented within the context compiler content contract.";
    case "context_evidence_invalid":
      return "The source evidence cannot be represented without losing its locator or excerpt.";
    case "rebuildable_metadata_invalid":
      return "The rebuildable summary metadata is incomplete or disagrees with its source fact.";
    case "rebuildable_source_not_current":
      return "The rebuildable summary does not match the chapter's verified current version and checksum.";
    case "superseded_rebuildable_fact":
      return "A newer valid rebuildable summary for the same chapter was selected.";
  }
}

function selectChapterSummaryWinners(
  facts: readonly StoryFact[],
  scope: StoryContextFactScope,
): ReadonlyMap<string, string> {
  const winners = new Map<string, StoryFact>();
  for (const fact of facts) {
    const snapshot = fact.toSnapshot();
    if (snapshot.factType !== "chapter_summary") {
      continue;
    }
    const authority = resolveFactAuthority(fact, scope);
    const payload = authority.included ? parseStoredChapterSummaryPayload(fact) : null;
    if (payload === null) {
      continue;
    }
    const current = winners.get(payload.sourceChapterId);
    if (
      current === undefined ||
      snapshot.updatedAt > current.toSnapshot().updatedAt ||
      (snapshot.updatedAt === current.toSnapshot().updatedAt && fact.id > current.id)
    ) {
      winners.set(payload.sourceChapterId, fact);
    }
  }
  return new Map([...winners].map(([chapterId, fact]) => [chapterId, fact.id]));
}

function isContextContent(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= MAXIMUM_CONTEXT_CONTENT_CHARACTERS &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isContextEvidenceSafe(reference: ContextEvidenceReference): boolean {
  return (
    reference.locator !== null &&
    reference.locator.trim().length > 0 &&
    reference.locator.length <= MAXIMUM_EVIDENCE_LOCATOR_CHARACTERS &&
    !CONTROL_CHARACTER_PATTERN.test(reference.locator) &&
    (reference.excerpt === null ||
      (reference.excerpt.trim().length > 0 &&
        reference.excerpt.length <= MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS &&
        !CONTROL_CHARACTER_PATTERN.test(reference.excerpt)))
  );
}
