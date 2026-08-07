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

export type ContextDiscardReason = "token_budget_exhausted";

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
  | "CONTEXT_TOKEN_ESTIMATE_INVALID";

export interface ContextCompilationErrorDetails {
  readonly maximumContextTokens?: number;
  readonly requiredTokens?: number;
  readonly overflowTokens?: number;
  readonly requiredEntryIds?: readonly string[];
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
  const evaluated = rawCandidates.map((candidate, sourceIndex): EvaluatedCandidate => {
    const validated = validateCandidate(candidate, ids);
    totalCharacters += validated.content.length;
    if (totalCharacters > MAXIMUM_TOTAL_CONTENT_CHARACTERS) {
      throw invalidContextInput("Combined context candidate content is too large.");
    }
    return {
      candidate: validated,
      sourceIndex,
      layerOrder: CONTEXT_LAYER_ORDER.indexOf(validated.layer) + 1,
      estimatedTokens: estimateCandidateTokens(estimator, validated.content),
    };
  });

  if (!evaluated.some(({ candidate }) => candidate.layer === "current_task")) {
    throw new ContextCompilationError(
      "CONTEXT_REQUIRED_LAYER_MISSING",
      "Context compilation requires a current-task entry.",
    );
  }

  const ordered = evaluated.sort(compareEvaluatedCandidates);
  const required = ordered.filter(({ candidate }) => REQUIRED_LAYERS.has(candidate.layer));
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

  let remaining = input.maximumContextTokens;
  const entries = ordered.map((entry, evaluationIndex): CompiledContextEntry => {
    const requiredEntry = REQUIRED_LAYERS.has(entry.candidate.layer);
    const included = requiredEntry || entry.estimatedTokens <= remaining;
    const before = remaining;
    if (included) {
      remaining -= entry.estimatedTokens;
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
      discardedReason: included ? null : "token_budget_exhausted",
      budgetRemainingBefore: before,
      budgetRemainingAfter: remaining,
    });
  });

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
        candidate.relevanceScore > 1))
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
  if (left.layerOrder !== right.layerOrder) {
    return left.layerOrder - right.layerOrder;
  }
  const priorityDifference = (right.candidate.priority ?? 0) - (left.candidate.priority ?? 0);
  if (priorityDifference !== 0) {
    return priorityDifference;
  }
  const relevanceDifference =
    (right.candidate.relevanceScore ?? 0) - (left.candidate.relevanceScore ?? 0);
  return relevanceDifference === 0 ? left.sourceIndex - right.sourceIndex : relevanceDifference;
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
