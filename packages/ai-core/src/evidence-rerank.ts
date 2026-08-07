import {
  CONTEXT_EVIDENCE_SOURCE_TYPES,
  type ContextEvidenceSourceType,
} from "./context-compiler.js";

export const LOCAL_EVIDENCE_RERANK_ALGORITHM = "local_evidence_v1" as const;
/**
 * This pure scorer never performs network I/O. A provider-backed reranker is
 * composed by the desktop runtime after local recall and before its
 * deterministic fallback is merged.
 */
export const REMOTE_MODEL_RERANK_ADAPTER_STATUS = "delegated_to_runtime" as const;

export const LOCAL_EVIDENCE_RERANK_WEIGHTS = Object.freeze({
  termCoverage: 0.35,
  phraseMatch: 0.25,
  retrievalScore: 0.25,
  governance: 0.15,
});

export interface EvidenceRerankSource {
  readonly sourceType: ContextEvidenceSourceType;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly locator: string;
  readonly contentHash: string;
}

export interface EvidenceRerankCandidate {
  readonly id: string;
  readonly text: string;
  readonly retrievalScore: number;
  readonly importance?: number;
  readonly pinned?: boolean;
  readonly evidence: EvidenceRerankSource;
}

export interface EvidenceRerankInput {
  readonly query: string;
  readonly candidates: readonly EvidenceRerankCandidate[];
  readonly limit?: number;
}

export interface EvidenceRerankWeightedScores {
  readonly termCoverage: number;
  readonly phraseMatch: number;
  readonly retrievalScore: number;
  readonly governance: number;
}

export interface EvidenceRerankScoreBreakdown {
  readonly termCoverage: number;
  readonly phraseMatch: number;
  readonly retrievalScore: number;
  readonly importance: number;
  readonly pinnedBoost: number;
  readonly governance: number;
  readonly weighted: EvidenceRerankWeightedScores;
  readonly total: number;
}

export interface EvidenceRerankCandidateSnapshot {
  readonly id: string;
  readonly text: string;
  readonly retrievalScore: number;
  readonly importance: number;
  readonly pinned: boolean;
  readonly evidence: EvidenceRerankSource;
}

export interface EvidenceRerankHit {
  readonly rank: number;
  readonly candidate: EvidenceRerankCandidateSnapshot;
  readonly scores: EvidenceRerankScoreBreakdown;
  readonly matchedTerms: readonly string[];
  readonly selectionReason: string;
}

export interface EvidenceRerankResult {
  readonly algorithm: typeof LOCAL_EVIDENCE_RERANK_ALGORITHM;
  readonly execution: "local_deterministic";
  readonly remoteModelAdapter: typeof REMOTE_MODEL_RERANK_ADAPTER_STATUS;
  readonly normalizedQuery: string;
  readonly queryTerms: readonly string[];
  readonly evaluatedCandidateCount: number;
  readonly returnedCandidateCount: number;
  readonly omittedCandidateIds: readonly string[];
  readonly ranked: readonly EvidenceRerankHit[];
}

export type EvidenceRerankErrorCode =
  | "RERANK_QUERY_INVALID"
  | "RERANK_LIMIT_INVALID"
  | "RERANK_CANDIDATE_LIMIT_EXCEEDED"
  | "RERANK_CANDIDATE_INVALID"
  | "RERANK_EVIDENCE_REQUIRED"
  | "RERANK_DUPLICATE_CANDIDATE"
  | "RERANK_CONTENT_LIMIT_EXCEEDED";

export class EvidenceRerankError extends Error {
  public constructor(
    readonly code: EvidenceRerankErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceRerankError";
  }
}

const MAXIMUM_QUERY_CHARACTERS = 500;
const MAXIMUM_CANDIDATES = 512;
const MAXIMUM_RESULT_LIMIT = 100;
const DEFAULT_RESULT_LIMIT = 20;
const MAXIMUM_CANDIDATE_CHARACTERS = 200_000;
const MAXIMUM_TOTAL_CANDIDATE_CHARACTERS = 2_000_000;
const MAXIMUM_IDENTIFIER_CHARACTERS = 512;
const MAXIMUM_LOCATOR_CHARACTERS = 2_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

interface ScoredCandidate {
  readonly sourceIndex: number;
  readonly candidate: EvidenceRerankCandidateSnapshot;
  readonly scores: EvidenceRerankScoreBreakdown;
  readonly matchedTerms: readonly string[];
  readonly selectionReason: string;
}

/**
 * Pure local reranking. It does not call a provider, inspect a model name, or
 * infer that a text-generation model has rerank capability.
 */
export function rerankWithLocalEvidence(input: EvidenceRerankInput): EvidenceRerankResult {
  const normalizedQuery = validateQuery(input.query);
  const queryTerms = tokenize(normalizedQuery);
  if (queryTerms.length === 0) {
    fail("RERANK_QUERY_INVALID", "The rerank query does not contain a searchable term.");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length > MAXIMUM_CANDIDATES) {
    fail(
      "RERANK_CANDIDATE_LIMIT_EXCEEDED",
      `Local rerank accepts at most ${String(MAXIMUM_CANDIDATES)} candidates.`,
    );
  }
  const limit = validateLimit(input.limit ?? DEFAULT_RESULT_LIMIT);
  const candidateIds = new Set<string>();
  let totalCharacters = 0;
  const scored = input.candidates.map((candidate, sourceIndex): ScoredCandidate => {
    const validated = validateCandidate(candidate, candidateIds);
    totalCharacters += validated.text.length;
    if (totalCharacters > MAXIMUM_TOTAL_CANDIDATE_CHARACTERS) {
      fail(
        "RERANK_CONTENT_LIMIT_EXCEEDED",
        "Combined local rerank candidate text exceeds its bounded input contract.",
      );
    }
    return scoreCandidate(validated, sourceIndex, normalizedQuery, queryTerms);
  });
  scored.sort(compareScoredCandidates);
  const selected = scored.slice(0, Math.min(limit, scored.length));
  const ranked = selected.map((candidate, index): EvidenceRerankHit =>
    Object.freeze({
      rank: index + 1,
      candidate: candidate.candidate,
      scores: candidate.scores,
      matchedTerms: candidate.matchedTerms,
      selectionReason: candidate.selectionReason,
    }),
  );

  return Object.freeze({
    algorithm: LOCAL_EVIDENCE_RERANK_ALGORITHM,
    execution: "local_deterministic",
    remoteModelAdapter: REMOTE_MODEL_RERANK_ADAPTER_STATUS,
    normalizedQuery,
    queryTerms: Object.freeze(queryTerms),
    evaluatedCandidateCount: scored.length,
    returnedCandidateCount: ranked.length,
    omittedCandidateIds: Object.freeze(
      scored.slice(selected.length).map(({ candidate }) => candidate.id),
    ),
    ranked: Object.freeze(ranked),
  });
}

function validateQuery(value: unknown): string {
  if (typeof value !== "string") {
    fail("RERANK_QUERY_INVALID", "The local rerank query must be text.");
  }
  const normalized = normalizeText(value);
  if (
    normalized.length < 1 ||
    normalized.length > MAXIMUM_QUERY_CHARACTERS ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    fail("RERANK_QUERY_INVALID", "The local rerank query is empty, unsafe, or too long.");
  }
  return normalized;
}

function validateLimit(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAXIMUM_RESULT_LIMIT
  ) {
    fail(
      "RERANK_LIMIT_INVALID",
      `The local rerank result limit must be between 1 and ${String(MAXIMUM_RESULT_LIMIT)}.`,
    );
  }
  return value as number;
}

function validateCandidate(
  value: unknown,
  candidateIds: Set<string>,
): EvidenceRerankCandidateSnapshot {
  if (
    !isRecord(value) ||
    !isSafeReference(value.id) ||
    typeof value.text !== "string" ||
    value.text.trim().length < 1 ||
    value.text.length > MAXIMUM_CANDIDATE_CHARACTERS ||
    CONTROL_CHARACTER_PATTERN.test(value.text) ||
    !isNormalizedScore(value.retrievalScore) ||
    (value.importance !== undefined && !isNormalizedScore(value.importance)) ||
    (value.pinned !== undefined && typeof value.pinned !== "boolean")
  ) {
    fail(
      "RERANK_CANDIDATE_INVALID",
      "A local rerank candidate has invalid identity, text, score, or governance signals.",
    );
  }
  if (candidateIds.has(value.id)) {
    fail("RERANK_DUPLICATE_CANDIDATE", "Local rerank candidate identifiers must be unique.");
  }
  candidateIds.add(value.id);
  const evidence = validateEvidence(value.evidence);
  return Object.freeze({
    id: value.id,
    text: value.text,
    retrievalScore: value.retrievalScore,
    importance: value.importance ?? 0,
    pinned: value.pinned ?? false,
    evidence,
  });
}

function validateEvidence(value: unknown): EvidenceRerankSource {
  if (
    !isRecord(value) ||
    typeof value.sourceType !== "string" ||
    !CONTEXT_EVIDENCE_SOURCE_TYPES.includes(value.sourceType as ContextEvidenceSourceType) ||
    !isSafeReference(value.sourceId) ||
    !isSafeReference(value.sourceVersionId) ||
    typeof value.locator !== "string" ||
    value.locator.trim().length < 1 ||
    value.locator.length > MAXIMUM_LOCATOR_CHARACTERS ||
    CONTROL_CHARACTER_PATTERN.test(value.locator) ||
    typeof value.contentHash !== "string" ||
    !SHA256_PATTERN.test(value.contentHash)
  ) {
    fail(
      "RERANK_EVIDENCE_REQUIRED",
      "Every local rerank candidate requires source, version, locator, and SHA-256 evidence.",
    );
  }
  return Object.freeze({
    sourceType: value.sourceType as ContextEvidenceSourceType,
    sourceId: value.sourceId,
    sourceVersionId: value.sourceVersionId,
    locator: value.locator,
    contentHash: value.contentHash,
  });
}

function scoreCandidate(
  candidate: EvidenceRerankCandidateSnapshot,
  sourceIndex: number,
  normalizedQuery: string,
  queryTerms: readonly string[],
): ScoredCandidate {
  const normalizedCandidate = normalizeText(candidate.text);
  const matchedTerms = queryTerms.filter((term) => normalizedCandidate.includes(term));
  const termCoverage = matchedTerms.length / queryTerms.length;
  const phraseMatch = normalizedCandidate.includes(normalizedQuery) ? 1 : 0;
  const pinnedBoost = candidate.pinned ? 0.3 : 0;
  const governance = clamp01(candidate.importance * 0.7 + pinnedBoost);
  const weighted = Object.freeze({
    termCoverage: roundScore(termCoverage * LOCAL_EVIDENCE_RERANK_WEIGHTS.termCoverage),
    phraseMatch: roundScore(phraseMatch * LOCAL_EVIDENCE_RERANK_WEIGHTS.phraseMatch),
    retrievalScore: roundScore(
      candidate.retrievalScore * LOCAL_EVIDENCE_RERANK_WEIGHTS.retrievalScore,
    ),
    governance: roundScore(governance * LOCAL_EVIDENCE_RERANK_WEIGHTS.governance),
  });
  const scores = Object.freeze({
    termCoverage: roundScore(termCoverage),
    phraseMatch,
    retrievalScore: candidate.retrievalScore,
    importance: candidate.importance,
    pinnedBoost,
    governance: roundScore(governance),
    weighted,
    total: roundScore(
      weighted.termCoverage + weighted.phraseMatch + weighted.retrievalScore + weighted.governance,
    ),
  });
  return Object.freeze({
    sourceIndex,
    candidate,
    scores,
    matchedTerms: Object.freeze(matchedTerms),
    selectionReason: buildSelectionReason(
      candidate,
      scores,
      matchedTerms.length,
      queryTerms.length,
    ),
  });
}

function buildSelectionReason(
  candidate: EvidenceRerankCandidateSnapshot,
  scores: EvidenceRerankScoreBreakdown,
  matchedTermCount: number,
  queryTermCount: number,
): string {
  return [
    `Matched ${String(matchedTermCount)}/${String(queryTermCount)} query terms`,
    scores.phraseMatch === 1 ? "exact normalized phrase matched" : "no exact phrase match",
    `retrieval=${scores.retrievalScore.toFixed(6)}`,
    `importance=${scores.importance.toFixed(6)}`,
    candidate.pinned ? "user-pinned" : "not pinned",
    `total=${scores.total.toFixed(6)}`,
  ].join("; ");
}

function compareScoredCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  return (
    right.scores.total - left.scores.total ||
    right.scores.termCoverage - left.scores.termCoverage ||
    right.scores.phraseMatch - left.scores.phraseMatch ||
    right.scores.retrievalScore - left.scores.retrievalScore ||
    Number(right.candidate.pinned) - Number(left.candidate.pinned) ||
    right.scores.importance - left.scores.importance ||
    compareReferences(left.candidate.id, right.candidate.id) ||
    compareReferences(left.candidate.evidence.sourceId, right.candidate.evidence.sourceId) ||
    left.sourceIndex - right.sourceIndex
  );
}

function compareReferences(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tokenize(normalized: string): string[] {
  const tokens = new Set<string>();
  for (const segment of normalized.split(/[\p{P}\p{S}\s]+/u)) {
    const characters = Array.from(segment);
    if (characters.length === 0) {
      continue;
    }
    if (characters.length <= 2) {
      tokens.add(segment);
      continue;
    }
    for (let index = 0; index <= characters.length - 3; index += 1) {
      tokens.add(characters.slice(index, index + 3).join(""));
    }
  }
  return [...tokens];
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replaceAll(/\s+/gu, " ").trim();
}

function isSafeReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAXIMUM_IDENTIFIER_CHARACTERS &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function isNormalizedScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function fail(code: EvidenceRerankErrorCode, message: string): never {
  throw new EvidenceRerankError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
