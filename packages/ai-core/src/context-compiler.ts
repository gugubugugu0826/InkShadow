import type { PromptSection } from "./model.js";

export const CONTEXT_LAYER_ORDER = [
  "locked_hard_rules",
  "current_task",
  "scene_goal",
  "pov_known_information",
  "character_current_state",
  "recent_events",
  "related_causal_chain",
  "unresolved_foreshadowing",
  "world_setting",
  "character_voice_samples",
  "semantic_retrieval",
  "rerank_supplement",
] as const;

export type ContextLayer = (typeof CONTEXT_LAYER_ORDER)[number];

export const CONTEXT_EVIDENCE_SOURCE_TYPES = [
  "user_input",
  "generation_task",
  "scene_plan",
  "chapter",
  "outline",
  "character",
  "relationship",
  "world",
  "timeline_event",
  "causal_event",
  "foreshadow",
  "story_rule",
  "memory",
  "search_document",
  "rerank_result",
  "import",
  "other",
] as const;

export type ContextEvidenceSourceType = (typeof CONTEXT_EVIDENCE_SOURCE_TYPES)[number];

export interface ContextEvidenceReference {
  readonly sourceType: ContextEvidenceSourceType;
  readonly sourceId: string;
  readonly sourceVersionId: string | null;
  readonly locator: string | null;
  readonly contentHash: string | null;
  readonly excerpt: string | null;
}

export interface ContextCandidate {
  readonly id: string;
  readonly layer: ContextLayer;
  readonly content: string;
  /** Human-readable and trace-safe explanation of why this item is relevant. */
  readonly selectionReason: string;
  readonly evidence: readonly ContextEvidenceReference[];
  /** Higher values are considered first inside the same layer. */
  readonly priority?: number;
  /** Optional normalized relevance score used only inside the same layer. */
  readonly relevanceScore?: number | null;
  /**
   * Required entries fail closed when they cannot fit. Preferred entries stay
   * optional but are considered after confirmed story context and before
   * low-priority retrieval or writing preferences.
   */
  readonly budgetRetention?: "required" | "preferred";
}

export type ContextCandidateDraft = Omit<ContextCandidate, "layer">;

/**
 * A narrow seam for adapting current memory/search records and future unified
 * story-state records without coupling this pure compiler to persistence.
 */
export interface ContextSourceAdapter<TSource> {
  readonly layer: ContextLayer;
  adapt(source: TSource, sourceIndex: number): ContextCandidateDraft;
}

export interface ContextTokenEstimator {
  readonly source: "utf8_conservative" | "provider_tokenizer" | "custom";
  estimateTokens(text: string): number;
}

export interface ContextCompilationInput {
  /** Budget allocated to context only; output-token reservation happens before this call. */
  readonly maximumContextTokens: number;
  readonly candidates: readonly ContextCandidate[];
  readonly tokenEstimator?: ContextTokenEstimator;
}

export type ContextDiscardReason = "token_budget_exhausted" | "duplicate_source";

export interface CompiledContextEntry {
  readonly id: string;
  readonly layer: ContextLayer;
  readonly layerOrder: number;
  readonly evaluationOrder: number;
  readonly content: string;
  readonly selectionReason: string;
  readonly evidence: readonly ContextEvidenceReference[];
  readonly estimatedTokens: number;
  readonly priority: number;
  readonly relevanceScore: number | null;
  readonly required: boolean;
  readonly included: boolean;
  readonly discardedReason: ContextDiscardReason | null;
  readonly budgetRemainingBefore: number;
  readonly budgetRemainingAfter: number;
}

export interface ContextLayerCompilationTrace {
  readonly layer: ContextLayer;
  readonly layerOrder: number;
  readonly candidateCount: number;
  readonly includedCount: number;
  readonly discardedCount: number;
  readonly estimatedTokens: number;
  readonly includedTokens: number;
}

export interface CompiledContext {
  readonly entries: readonly CompiledContextEntry[];
  readonly trace: Readonly<{
    maximumContextTokens: number;
    requiredTokens: number;
    usedTokens: number;
    remainingTokens: number;
    discardedTokens: number;
    tokenEstimateSource: ContextTokenEstimator["source"];
    layers: readonly ContextLayerCompilationTrace[];
  }>;
}

export type ContextCompilationErrorCode =
  | "CONTEXT_INPUT_INVALID"
  | "CONTEXT_REQUIRED_LAYER_MISSING"
  | "CONTEXT_REQUIRED_BUDGET_EXCEEDED"
  | "CONTEXT_SOURCE_FINGERPRINT_CONFLICT"
  | "CONTEXT_TOKEN_ESTIMATE_INVALID";

export interface ContextCompilationErrorDetails {
  readonly maximumContextTokens?: number;
  readonly requiredTokens?: number;
  readonly overflowTokens?: number;
  readonly requiredEntryIds?: readonly string[];
  readonly conflictingEntryIds?: readonly string[];
}

export class ContextCompilationError extends Error {
  public constructor(
    readonly code: ContextCompilationErrorCode,
    message: string,
    readonly details: ContextCompilationErrorDetails = {},
  ) {
    super(message);
    this.name = "ContextCompilationError";
    Object.freeze(this.details);
  }
}

const REQUIRED_LAYERS = new Set<ContextLayer>(["locked_hard_rules", "current_task"]);
const CONTENT_WRAPPER_DEDUPE_SOURCE_TYPES = new Set<ContextEvidenceSourceType>([
  "user_input",
  "generation_task",
  "scene_plan",
  "memory",
  "search_document",
  "rerank_result",
  "story_rule",
  "other",
]);
const MAXIMUM_CANDIDATES = 4_096;
const MAXIMUM_CONTENT_CHARACTERS = 200_000;
const MAXIMUM_TOTAL_CONTENT_CHARACTERS = 2_000_000;
const MAXIMUM_REASON_CHARACTERS = 2_000;
const MAXIMUM_EVIDENCE_REFERENCES = 32;
const MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS = 20_000;
const MAXIMUM_REFERENCE_CHARACTERS = 2_000;
const MAXIMUM_CONTEXT_TOKENS = 10_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const DEFAULT_TOKEN_ESTIMATOR: ContextTokenEstimator = Object.freeze({
  source: "utf8_conservative",
  estimateTokens: estimateContextTokensUtf8Conservative,
});

interface EvaluatedCandidate {
  readonly candidate: ContextCandidate;
  readonly sourceIndex: number;
  readonly layerOrder: number;
  readonly estimatedTokens: number;
  readonly duplicateOfId: string | null;
}

interface DeduplicatedCandidate {
  readonly candidate: ContextCandidate;
  readonly sourceIndex: number;
  readonly duplicateOfId: string | null;
}

export function estimateContextTokensUtf8Conservative(text: string): number {
  if (typeof text !== "string" || text.length === 0) {
    throw new ContextCompilationError(
      "CONTEXT_TOKEN_ESTIMATE_INVALID",
      "Context token estimation requires non-empty text.",
    );
  }
  return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 3));
}

export function adaptContextSources<TSource>(
  sources: readonly TSource[],
  adapter: ContextSourceAdapter<TSource>,
): readonly ContextCandidate[] {
  if (!isContextLayer(adapter.layer) || sources.length > MAXIMUM_CANDIDATES) {
    throw invalidContextInput("Context source adapter input is invalid.");
  }
  return Object.freeze(
    sources.map((source, sourceIndex) => {
      const draft = adapter.adapt(source, sourceIndex);
      return Object.freeze({
        ...draft,
        layer: adapter.layer,
        evidence: Object.freeze(draft.evidence.map((reference) => Object.freeze({ ...reference }))),
      });
    }),
  );
}

export function compileContext(input: ContextCompilationInput): CompiledContext {
  validateTokenBudget(input.maximumContextTokens);
  const rawCandidates: unknown = input.candidates;
  if (!isUnknownArray(rawCandidates) || rawCandidates.length > MAXIMUM_CANDIDATES) {
    throw invalidContextInput("Context candidate count is invalid.");
  }
  const estimator = validateTokenEstimator(input.tokenEstimator ?? DEFAULT_TOKEN_ESTIMATOR);
  const ids = new Set<string>();
  let totalCharacters = 0;
  const validatedCandidates = rawCandidates.map((candidate, sourceIndex) => {
    const validated = validateCandidate(candidate, ids);
    totalCharacters += validated.content.length;
    if (totalCharacters > MAXIMUM_TOTAL_CONTENT_CHARACTERS) {
      throw invalidContextInput("Combined context candidate content is too large.");
    }
    return Object.freeze({ candidate: validated, sourceIndex });
  });
  const evaluated = deduplicateContextCandidates(validatedCandidates).map(
    ({ candidate, sourceIndex, duplicateOfId }): EvaluatedCandidate => ({
      candidate,
      sourceIndex,
      layerOrder: CONTEXT_LAYER_ORDER.indexOf(candidate.layer) + 1,
      estimatedTokens: estimateCandidateTokens(estimator, candidate.content),
      duplicateOfId,
    }),
  );

  if (
    !evaluated.some(
      ({ candidate, duplicateOfId }) =>
        candidate.layer === "current_task" && duplicateOfId === null,
    )
  ) {
    throw new ContextCompilationError(
      "CONTEXT_REQUIRED_LAYER_MISSING",
      "Context compilation requires a current-task entry.",
    );
  }

  const ordered = evaluated.sort(compareEvaluatedCandidates);
  const required = ordered.filter(
    ({ candidate, duplicateOfId }) => duplicateOfId === null && isRequiredCandidate(candidate),
  );
  const requiredTokens = required.reduce((total, entry) => total + entry.estimatedTokens, 0);
  if (requiredTokens > input.maximumContextTokens) {
    const requiredEntryIds = Object.freeze(required.map(({ candidate }) => candidate.id));
    throw new ContextCompilationError(
      "CONTEXT_REQUIRED_BUDGET_EXCEEDED",
      "Locked hard rules and the current task do not fit in the context budget.",
      {
        maximumContextTokens: input.maximumContextTokens,
        requiredTokens,
        overflowTokens: requiredTokens - input.maximumContextTokens,
        requiredEntryIds,
      },
    );
  }

  let optionalRemaining = input.maximumContextTokens - requiredTokens;
  let requiredRemaining = requiredTokens;
  const entries = ordered.map((entry, evaluationIndex): CompiledContextEntry => {
    const duplicate = entry.duplicateOfId !== null;
    const requiredEntry = !duplicate && isRequiredCandidate(entry.candidate);
    const included = !duplicate && (requiredEntry || entry.estimatedTokens <= optionalRemaining);
    const before = optionalRemaining + requiredRemaining;
    if (included) {
      if (requiredEntry) {
        requiredRemaining -= entry.estimatedTokens;
      } else {
        optionalRemaining -= entry.estimatedTokens;
      }
    }
    return Object.freeze({
      id: entry.candidate.id,
      layer: entry.candidate.layer,
      layerOrder: entry.layerOrder,
      evaluationOrder: evaluationIndex + 1,
      content: entry.candidate.content,
      selectionReason: entry.candidate.selectionReason,
      evidence: entry.candidate.evidence,
      estimatedTokens: entry.estimatedTokens,
      priority: entry.candidate.priority ?? 0,
      relevanceScore: entry.candidate.relevanceScore ?? null,
      required: requiredEntry,
      included,
      discardedReason: included ? null : duplicate ? "duplicate_source" : "token_budget_exhausted",
      budgetRemainingBefore: before,
      budgetRemainingAfter: optionalRemaining + requiredRemaining,
    });
  });

  const remaining = optionalRemaining + requiredRemaining;
  const usedTokens = input.maximumContextTokens - remaining;
  const discardedTokens = entries.reduce(
    (total, entry) => total + (entry.included ? 0 : entry.estimatedTokens),
    0,
  );
  return Object.freeze({
    entries: Object.freeze(entries),
    trace: Object.freeze({
      maximumContextTokens: input.maximumContextTokens,
      requiredTokens,
      usedTokens,
      remainingTokens: remaining,
      discardedTokens,
      tokenEstimateSource: estimator.source,
      layers: buildLayerTraces(entries),
    }),
  });
}

/**
 * Non-breaking bridge to the existing model request contract. Callers retain
 * the full compilation trace alongside these prompt sections.
 */
export function compiledContextToPromptSections(
  compiled: CompiledContext,
): readonly PromptSection[] {
  return Object.freeze(
    compiled.entries
      .filter(({ included }) => included)
      .map((entry) => {
        const sourceId = entry.evidence[0]?.sourceId;
        return Object.freeze({
          kind: promptSectionKind(entry.layer),
          text: entry.content,
          ...(sourceId === undefined ? {} : { sourceId }),
          inclusion: entry.required ? "required" : "retrieved",
        });
      }),
  );
}

function deduplicateContextCandidates(
  input: readonly Readonly<{ candidate: ContextCandidate; sourceIndex: number }>[],
): readonly DeduplicatedCandidate[] {
  assertNoConflictingSourceFingerprints(input);
  const preferenceOrder = [...input].sort(compareDeduplicationPreference);
  const winners: Readonly<{ candidate: ContextCandidate; sourceIndex: number }>[] = [];
  const duplicateWinnerById = new Map<string, string>();

  for (const entry of preferenceOrder) {
    const winnerIndex = winners.findIndex(({ candidate }) =>
      candidatesAreEquivalent(candidate, entry.candidate),
    );
    if (winnerIndex < 0) {
      winners.push(entry);
      continue;
    }
    const winner = winners[winnerIndex];
    if (winner === undefined) continue;
    duplicateWinnerById.set(entry.candidate.id, winner.candidate.id);
    winners[winnerIndex] = Object.freeze({
      ...winner,
      candidate: Object.freeze({
        ...winner.candidate,
        selectionReason:
          `${winner.candidate.selectionReason} Equivalent source evidence was merged.`.slice(
            0,
            MAXIMUM_REASON_CHARACTERS,
          ),
        evidence: mergeEvidence(winner.candidate.evidence, entry.candidate.evidence),
      }),
    });
  }

  const winnerById = new Map(winners.map((entry) => [entry.candidate.id, entry.candidate]));
  return Object.freeze(
    input.map(({ candidate, sourceIndex }) =>
      Object.freeze({
        candidate: winnerById.get(candidate.id) ?? candidate,
        sourceIndex,
        duplicateOfId: duplicateWinnerById.get(candidate.id) ?? null,
      }),
    ),
  );
}

function compareDeduplicationPreference(
  left: Readonly<{ candidate: ContextCandidate; sourceIndex: number }>,
  right: Readonly<{ candidate: ContextCandidate; sourceIndex: number }>,
): number {
  const leftRequired = isRequiredCandidate(left.candidate) ? 1 : 0;
  const rightRequired = isRequiredCandidate(right.candidate) ? 1 : 0;
  if (leftRequired !== rightRequired) return rightRequired - leftRequired;
  const layerDelta = contextSelectionOrder(left.candidate) - contextSelectionOrder(right.candidate);
  if (layerDelta !== 0) return layerDelta;
  const priorityDelta = (right.candidate.priority ?? 0) - (left.candidate.priority ?? 0);
  if (priorityDelta !== 0) return priorityDelta;
  const relevanceDelta =
    (right.candidate.relevanceScore ?? -1) - (left.candidate.relevanceScore ?? -1);
  if (relevanceDelta !== 0) return relevanceDelta;
  return left.sourceIndex - right.sourceIndex;
}

function candidatesAreEquivalent(left: ContextCandidate, right: ContextCandidate): boolean {
  // The generated task skeleton is the structural reason for the invocation.
  // Author requirements use user_input evidence and may merge, but this
  // skeleton must remain present even if a story source repeats its wording.
  if (isGenerationTaskSkeleton(left) || isGenerationTaskSkeleton(right)) return false;
  if (sameCanonicalSourceWithDifferentRevision(left, right)) return false;
  const leftSourceKeys = new Set(canonicalSourceKeys(left));
  if (canonicalSourceKeys(right).some((key) => leftSourceKeys.has(key))) return true;
  return (
    isContentWrapperCandidate(left) &&
    isContentWrapperCandidate(right) &&
    !hasExplicitContentFingerprint(left) &&
    !hasExplicitContentFingerprint(right) &&
    canonicalContextContent(left.content) === canonicalContextContent(right.content)
  );
}

function isGenerationTaskSkeleton(candidate: ContextCandidate): boolean {
  return candidate.evidence.some(({ sourceType }) => sourceType === "generation_task");
}

function isContentWrapperCandidate(candidate: ContextCandidate): boolean {
  return candidate.evidence.every(({ sourceType }) =>
    CONTENT_WRAPPER_DEDUPE_SOURCE_TYPES.has(sourceType),
  );
}

function canonicalSourceKeys(candidate: ContextCandidate): readonly string[] {
  const fallback = canonicalContextContent(candidate.content);
  return candidate.evidence.map(
    ({ sourceId, sourceVersionId, locator, contentHash }) =>
      `${sourceId.trim().toLowerCase()}|${sourceVersionId?.trim().toLowerCase() ?? "-"}|${locator?.trim().toLowerCase() ?? "-"}|${contentHash?.trim().toLowerCase() ?? `content:${fallback}`}`,
  );
}

function assertNoConflictingSourceFingerprints(
  input: readonly Readonly<{ candidate: ContextCandidate; sourceIndex: number }>[],
): void {
  const firstBySourceRevision = new Map<
    string,
    Readonly<{ entryId: string; contentHash: string }>
  >();
  for (const { candidate } of input) {
    for (const reference of candidate.evidence) {
      if (reference.contentHash === null) continue;
      const sourceRevisionAndRange = `${reference.sourceId.trim().toLowerCase()}|${reference.sourceVersionId?.trim().toLowerCase() ?? "-"}|${reference.locator?.trim().toLowerCase() ?? "-"}`;
      const contentHash = reference.contentHash.trim().toLowerCase();
      const first = firstBySourceRevision.get(sourceRevisionAndRange);
      if (first === undefined) {
        firstBySourceRevision.set(sourceRevisionAndRange, {
          entryId: candidate.id,
          contentHash,
        });
        continue;
      }
      if (first.contentHash !== contentHash) {
        throw new ContextCompilationError(
          "CONTEXT_SOURCE_FINGERPRINT_CONFLICT",
          "One source revision has conflicting content fingerprints.",
          { conflictingEntryIds: Object.freeze([first.entryId, candidate.id]) },
        );
      }
    }
  }
}

function hasExplicitContentFingerprint(candidate: ContextCandidate): boolean {
  return candidate.evidence.some(({ contentHash }) => contentHash !== null);
}

function isRequiredCandidate(candidate: ContextCandidate): boolean {
  return candidate.budgetRetention === "required" || REQUIRED_LAYERS.has(candidate.layer);
}

function sameCanonicalSourceWithDifferentRevision(
  left: ContextCandidate,
  right: ContextCandidate,
): boolean {
  return left.evidence.some((leftReference) =>
    right.evidence.some(
      (rightReference) =>
        leftReference.sourceId.trim().toLowerCase() ===
          rightReference.sourceId.trim().toLowerCase() &&
        (leftReference.sourceVersionId?.trim().toLowerCase() ?? null) !==
          (rightReference.sourceVersionId?.trim().toLowerCase() ?? null),
    ),
  );
}

function canonicalContextContent(content: string): string {
  return content
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .replace(/^(?:\[[^\]\r\n]{1,200}\]|【[^】\r\n]{1,200}】)\s*\n+/u, "")
    .replace(/^类型[:：]writing_constraint[ \t]*\n内容[:：]/u, "")
    .replace(/(^|\n)-[ \t]+/gu, "$1")
    .replace(/\s+/gu, " ");
}

function mergeEvidence(
  left: readonly ContextEvidenceReference[],
  right: readonly ContextEvidenceReference[],
): readonly ContextEvidenceReference[] {
  const merged: ContextEvidenceReference[] = [];
  const seen = new Set<string>();
  for (const reference of [...left, ...right]) {
    const key = JSON.stringify(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    if (merged.length < MAXIMUM_EVIDENCE_REFERENCES) merged.push(reference);
  }
  return Object.freeze(merged);
}

function validateCandidate(candidate: unknown, ids: Set<string>): ContextCandidate {
  if (
    !isRecord(candidate) ||
    !isSafeReference(candidate.id, 512) ||
    ids.has(candidate.id) ||
    !isContextLayer(candidate.layer) ||
    !isBoundedContent(candidate.content, MAXIMUM_CONTENT_CHARACTERS) ||
    !isBoundedContent(candidate.selectionReason, MAXIMUM_REASON_CHARACTERS) ||
    !Array.isArray(candidate.evidence) ||
    candidate.evidence.length < 1 ||
    candidate.evidence.length > MAXIMUM_EVIDENCE_REFERENCES ||
    (candidate.priority !== undefined &&
      (typeof candidate.priority !== "number" ||
        !Number.isSafeInteger(candidate.priority) ||
        candidate.priority < -1_000 ||
        candidate.priority > 1_000)) ||
    (candidate.relevanceScore !== undefined &&
      candidate.relevanceScore !== null &&
      (typeof candidate.relevanceScore !== "number" ||
        !Number.isFinite(candidate.relevanceScore) ||
        candidate.relevanceScore < 0 ||
        candidate.relevanceScore > 1)) ||
    (candidate.budgetRetention !== undefined &&
      candidate.budgetRetention !== "required" &&
      candidate.budgetRetention !== "preferred")
  ) {
    throw invalidContextInput("A context candidate is invalid or duplicated.");
  }
  ids.add(candidate.id);
  return Object.freeze({
    id: candidate.id,
    layer: candidate.layer,
    content: candidate.content,
    selectionReason: candidate.selectionReason,
    evidence: Object.freeze(candidate.evidence.map(validateEvidenceReference)),
    ...(candidate.priority === undefined ? {} : { priority: candidate.priority }),
    ...(candidate.relevanceScore === undefined ? {} : { relevanceScore: candidate.relevanceScore }),
    ...(candidate.budgetRetention === undefined
      ? {}
      : { budgetRetention: candidate.budgetRetention }),
  });
}

function validateEvidenceReference(reference: unknown): ContextEvidenceReference {
  if (
    !isRecord(reference) ||
    !isContextEvidenceSourceType(reference.sourceType) ||
    !isSafeReference(reference.sourceId, 512) ||
    !isNullableSafeReference(reference.sourceVersionId, 512) ||
    !isNullableBoundedContent(reference.locator, MAXIMUM_REFERENCE_CHARACTERS) ||
    !isNullableSafeReference(reference.contentHash, 512) ||
    !isNullableBoundedContent(reference.excerpt, MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS)
  ) {
    throw invalidContextInput("A context evidence reference is invalid.");
  }
  return Object.freeze({
    sourceType: reference.sourceType,
    sourceId: reference.sourceId,
    sourceVersionId: reference.sourceVersionId,
    locator: reference.locator,
    contentHash: reference.contentHash,
    excerpt: reference.excerpt,
  });
}

function validateTokenBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_CONTEXT_TOKENS) {
    throw invalidContextInput("The maximum context token budget is invalid.");
  }
}

function validateTokenEstimator(estimator: ContextTokenEstimator): ContextTokenEstimator {
  if (
    !isRecord(estimator) ||
    !["utf8_conservative", "provider_tokenizer", "custom"].includes(estimator.source) ||
    typeof estimator.estimateTokens !== "function"
  ) {
    throw invalidContextInput("The context token estimator is invalid.");
  }
  return estimator;
}

function estimateCandidateTokens(estimator: ContextTokenEstimator, text: string): number {
  let estimate: number;
  try {
    estimate = estimator.estimateTokens(text);
  } catch (cause: unknown) {
    if (cause instanceof ContextCompilationError) {
      throw cause;
    }
    throw new ContextCompilationError(
      "CONTEXT_TOKEN_ESTIMATE_INVALID",
      "The context token estimator failed.",
    );
  }
  if (!Number.isSafeInteger(estimate) || estimate < 1 || estimate > MAXIMUM_CONTEXT_TOKENS) {
    throw new ContextCompilationError(
      "CONTEXT_TOKEN_ESTIMATE_INVALID",
      "The context token estimator returned an invalid count.",
    );
  }
  return estimate;
}

function compareEvaluatedCandidates(left: EvaluatedCandidate, right: EvaluatedCandidate): number {
  const layerDifference =
    contextSelectionOrder(left.candidate) - contextSelectionOrder(right.candidate);
  if (layerDifference !== 0) {
    return layerDifference;
  }
  const priorityDifference = (right.candidate.priority ?? 0) - (left.candidate.priority ?? 0);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }
  const relevanceDifference =
    (right.candidate.relevanceScore ?? 0) - (left.candidate.relevanceScore ?? 0);
  return relevanceDifference === 0 ? left.sourceIndex - right.sourceIndex : relevanceDifference;
}

function contextSelectionOrder(candidate: ContextCandidate): number {
  const layerOrder = CONTEXT_LAYER_ORDER.indexOf(candidate.layer) * 2;
  if (candidate.budgetRetention !== "preferred") return layerOrder;
  return CONTEXT_LAYER_ORDER.indexOf("character_voice_samples") * 2 + 1;
}

function buildLayerTraces(
  entries: readonly CompiledContextEntry[],
): readonly ContextLayerCompilationTrace[] {
  return Object.freeze(
    CONTEXT_LAYER_ORDER.map((layer, layerIndex) => {
      const candidates = entries.filter((entry) => entry.layer === layer);
      const included = candidates.filter((entry) => entry.included);
      return Object.freeze({
        layer,
        layerOrder: layerIndex + 1,
        candidateCount: candidates.length,
        includedCount: included.length,
        discardedCount: candidates.length - included.length,
        estimatedTokens: candidates.reduce((total, entry) => total + entry.estimatedTokens, 0),
        includedTokens: included.reduce((total, entry) => total + entry.estimatedTokens, 0),
      });
    }),
  );
}

function promptSectionKind(layer: ContextLayer): PromptSection["kind"] {
  switch (layer) {
    case "locked_hard_rules":
      return "project_rule";
    case "current_task":
      return "user_input";
    case "scene_goal":
      return "instruction";
    case "pov_known_information":
    case "character_current_state":
    case "character_voice_samples":
      return "character";
    case "recent_events":
    case "related_causal_chain":
      return "chapter";
    case "unresolved_foreshadowing":
      return "foreshadow";
    case "world_setting":
      return "world";
    case "semantic_retrieval":
    case "rerank_supplement":
      return "material";
  }
}

function isContextLayer(value: unknown): value is ContextLayer {
  return CONTEXT_LAYER_ORDER.includes(value as ContextLayer);
}

function isContextEvidenceSourceType(value: unknown): value is ContextEvidenceSourceType {
  return CONTEXT_EVIDENCE_SOURCE_TYPES.includes(value as ContextEvidenceSourceType);
}

function isBoundedContent(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isNullableBoundedContent(value: unknown, maximumLength: number): value is string | null {
  return value === null || isBoundedContent(value, maximumLength);
}

function isSafeReference(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function isNullableSafeReference(value: unknown, maximumLength: number): value is string | null {
  return value === null || isSafeReference(value, maximumLength);
}

function invalidContextInput(message: string): ContextCompilationError {
  return new ContextCompilationError("CONTEXT_INPUT_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
