export const CANDIDATE_QUALITY_METRICS = [
  "consistency",
  "repetition",
  "structure",
  "cost",
] as const;

export type CandidateQualityMetric = (typeof CANDIDATE_QUALITY_METRICS)[number];
export type CandidateQualityEvidenceSource =
  "deterministic_rule" | "model_review" | "human_review" | "provider_receipt";

export interface CandidateQualityObservation {
  readonly metric: CandidateQualityMetric;
  readonly score: number;
  readonly source: CandidateQualityEvidenceSource;
  readonly evidenceIds: readonly string[];
  readonly measuredAt: string;
}

export interface CandidateQualityThreshold {
  readonly metric: CandidateQualityMetric;
  readonly minimumScore: number;
  readonly weight: number;
  readonly required: boolean;
  readonly allowedSources: readonly CandidateQualityEvidenceSource[];
}

export interface CandidateQualityPolicy {
  readonly policyId: string;
  readonly version: number;
  readonly minimumOverallScore: number;
  readonly thresholds: readonly CandidateQualityThreshold[];
}

export interface CandidateQualityGateInput {
  readonly candidateId: string;
  readonly promptTrace: {
    readonly promptId: string;
    readonly promptVersion: number;
    readonly promptContentHashSha256: string;
  };
  readonly observations: readonly CandidateQualityObservation[];
  readonly policy: CandidateQualityPolicy;
}

export interface CandidateQualityMetricResult {
  readonly metric: CandidateQualityMetric;
  readonly status: "passed" | "failed" | "missing";
  readonly score: number | null;
  readonly minimumScore: number;
  readonly source: CandidateQualityEvidenceSource | null;
  readonly evidenceIds: readonly string[];
  readonly required: boolean;
}

export interface CandidateQualityGateResult {
  readonly candidateId: string;
  readonly outcome: "pass" | "warn" | "block";
  readonly overallScore: number | null;
  readonly results: readonly CandidateQualityMetricResult[];
  readonly blockingCodes: readonly string[];
  readonly warningCodes: readonly string[];
  readonly trace: {
    readonly policyId: string;
    readonly policyVersion: number;
    readonly promptId: string;
    readonly promptVersion: number;
    readonly promptContentHashSha256: string;
  };
}

export interface CandidateStableOverlapResult {
  readonly kind: "none" | "exact_prefix" | "high_similarity_prefix";
  readonly risk: "none" | "high";
  readonly comparedCharacters: number;
  readonly exactPrefixCharacters: number;
  readonly similarity: number;
  readonly removablePrefixUtf16: number | null;
  readonly removableRangeUtf16: Readonly<{ readonly start: number; readonly end: number }> | null;
}

export type CandidateQualityErrorCode =
  | "QUALITY_INPUT_INVALID"
  | "QUALITY_POLICY_INVALID"
  | "QUALITY_OBSERVATION_DUPLICATE"
  | "QUALITY_OBSERVATION_INVALID";

export class CandidateQualityError extends Error {
  public constructor(
    readonly code: CandidateQualityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CandidateQualityError";
  }
}

const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export function evaluateCandidateQuality(
  input: CandidateQualityGateInput,
): CandidateQualityGateResult {
  validateGateInput(input);
  const observations = new Map<CandidateQualityMetric, CandidateQualityObservation>();
  for (const observation of input.observations) {
    validateObservation(observation);
    if (observations.has(observation.metric)) {
      fail(
        "QUALITY_OBSERVATION_DUPLICATE",
        `Quality metric '${observation.metric}' has more than one observation.`,
      );
    }
    observations.set(observation.metric, observation);
  }

  const results: CandidateQualityMetricResult[] = [];
  const blockingCodes: string[] = [];
  const warningCodes: string[] = [];
  let weightedScore = 0;
  let observedWeight = 0;

  for (const threshold of input.policy.thresholds) {
    const observation = observations.get(threshold.metric);
    if (observation === undefined || !threshold.allowedSources.includes(observation.source)) {
      results.push({
        metric: threshold.metric,
        status: "missing",
        score: null,
        minimumScore: threshold.minimumScore,
        source: null,
        evidenceIds: [],
        required: threshold.required,
      });
      (threshold.required ? blockingCodes : warningCodes).push(
        `quality.${threshold.metric}.missing`,
      );
      continue;
    }

    const passed = observation.score >= threshold.minimumScore;
    results.push({
      metric: threshold.metric,
      status: passed ? "passed" : "failed",
      score: observation.score,
      minimumScore: threshold.minimumScore,
      source: observation.source,
      evidenceIds: [...observation.evidenceIds],
      required: threshold.required,
    });
    weightedScore += observation.score * threshold.weight;
    observedWeight += threshold.weight;
    if (!passed) {
      (threshold.required ? blockingCodes : warningCodes).push(
        `quality.${threshold.metric}.below_threshold`,
      );
    }
  }

  const overallScore =
    observedWeight === 0 ? null : roundQualityScore(weightedScore / observedWeight);
  if (overallScore === null || overallScore < input.policy.minimumOverallScore) {
    blockingCodes.push("quality.overall.below_threshold");
  }

  return {
    candidateId: input.candidateId,
    outcome: blockingCodes.length > 0 ? "block" : warningCodes.length > 0 ? "warn" : "pass",
    overallScore,
    results,
    blockingCodes,
    warningCodes,
    trace: {
      policyId: input.policy.policyId,
      policyVersion: input.policy.version,
      promptId: input.promptTrace.promptId,
      promptVersion: input.promptTrace.promptVersion,
      promptContentHashSha256: input.promptTrace.promptContentHashSha256,
    },
  };
}

export function scoreCandidateRepetition(
  text: string,
  minimumSegmentCharacters = 12,
  measuredAt = new Date().toISOString(),
): CandidateQualityObservation {
  if (
    text.length < 1 ||
    text.length > 1_000_000 ||
    !Number.isSafeInteger(minimumSegmentCharacters) ||
    minimumSegmentCharacters < 4 ||
    minimumSegmentCharacters > 10_000 ||
    !Number.isFinite(Date.parse(measuredAt))
  ) {
    fail("QUALITY_INPUT_INVALID", "Repetition scoring input is invalid.");
  }
  const segments = text
    .split(/[\n。！？!?]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= minimumSegmentCharacters);
  const normalized = segments.map((segment) =>
    segment.normalize("NFKC").replaceAll(/\s+/gu, "").toLocaleLowerCase("zh-CN"),
  );
  const frequencies = new Map<string, number>();
  for (const segment of normalized) {
    frequencies.set(segment, (frequencies.get(segment) ?? 0) + 1);
  }
  const duplicateCount = [...frequencies.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const score = normalized.length === 0 ? 1 : 1 - duplicateCount / normalized.length;
  return {
    metric: "repetition",
    score: roundQualityScore(score),
    source: "deterministic_rule",
    evidenceIds:
      duplicateCount === 0 ? ["repetition:none"] : [`repetition:${String(duplicateCount)}`],
    measuredAt,
  };
}

const MINIMUM_CROSS_TEXT_OVERLAP_CHARACTERS = 240;
const MINIMUM_STABLE_PREFIX_COVERAGE = 0.6;
const HIGH_SIMILARITY_THRESHOLD = 0.88;
const MAXIMUM_OVERLAP_COMPARISON_CHARACTERS = 100_000;
const OVERLAP_SHINGLE_CHARACTERS = 5;

/**
 * Compares a continuation with the immutable正文 it was generated from. The
 * check is local, deterministic, linear in the bounded comparison size, and
 * never changes the Candidate. Only a literal full正文 prefix is declared safe
 * to remove; approximate matches deliberately expose no automatic trim range.
 */
export function detectCandidateStableOverlap(
  stableContent: string,
  candidateContent: string,
): CandidateStableOverlapResult {
  const leadingWhitespace = /^\s*/u.exec(candidateContent)?.[0].length ?? 0;
  const candidateAfterWhitespace = candidateContent.slice(leadingWhitespace);
  const normalizedStable = normalizeOverlapText(stableContent).slice(
    0,
    MAXIMUM_OVERLAP_COMPARISON_CHARACTERS,
  );
  const normalizedCandidate = normalizeOverlapText(candidateAfterWhitespace).slice(
    0,
    MAXIMUM_OVERLAP_COMPARISON_CHARACTERS,
  );
  const comparedCharacters = Math.min(normalizedStable.length, normalizedCandidate.length);
  const requiredCoverageBase = Math.min(
    normalizedStable.length,
    MAXIMUM_OVERLAP_COMPARISON_CHARACTERS,
  );
  const stableCoverage = requiredCoverageBase === 0 ? 0 : comparedCharacters / requiredCoverageBase;

  if (
    normalizedStable.length >= MINIMUM_CROSS_TEXT_OVERLAP_CHARACTERS &&
    candidateAfterWhitespace.startsWith(stableContent)
  ) {
    const removableEnd = leadingWhitespace + stableContent.length;
    const hasUsableRemainder = candidateContent.slice(removableEnd).trim().length > 0;
    return Object.freeze({
      kind: "exact_prefix",
      risk: "high",
      comparedCharacters: normalizedStable.length,
      exactPrefixCharacters: stableContent.length,
      similarity: 1,
      removablePrefixUtf16: hasUsableRemainder ? removableEnd : null,
      removableRangeUtf16: hasUsableRemainder
        ? Object.freeze({ start: leadingWhitespace, end: removableEnd })
        : null,
    });
  }

  if (
    comparedCharacters < MINIMUM_CROSS_TEXT_OVERLAP_CHARACTERS ||
    stableCoverage < MINIMUM_STABLE_PREFIX_COVERAGE
  ) {
    return noStableOverlap(comparedCharacters);
  }

  const stablePrefix = normalizedStable.slice(0, comparedCharacters);
  const candidatePrefix = normalizedCandidate.slice(0, comparedCharacters);
  const exactPrefixCharacters = commonPrefixLength(stablePrefix, candidatePrefix);
  const similarity = roundQualityScore(
    shingleDiceSimilarity(stablePrefix, candidatePrefix, OVERLAP_SHINGLE_CHARACTERS),
  );
  if (similarity < HIGH_SIMILARITY_THRESHOLD) {
    return noStableOverlap(comparedCharacters, exactPrefixCharacters, similarity);
  }
  return Object.freeze({
    kind: "high_similarity_prefix",
    risk: "high",
    comparedCharacters,
    exactPrefixCharacters,
    similarity,
    removablePrefixUtf16: null,
    removableRangeUtf16: null,
  });
}

function normalizeOverlapText(text: string): string {
  return text.normalize("NFKC").replaceAll(/\s+/gu, "").toLocaleLowerCase("zh-CN");
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function shingleDiceSimilarity(left: string, right: string, width: number): number {
  if (left === right) return 1;
  if (left.length < width || right.length < width) return 0;
  const leftCounts = new Map<string, number>();
  for (let index = 0; index <= left.length - width; index += 1) {
    const shingle = left.slice(index, index + width);
    leftCounts.set(shingle, (leftCounts.get(shingle) ?? 0) + 1);
  }
  let intersection = 0;
  for (let index = 0; index <= right.length - width; index += 1) {
    const shingle = right.slice(index, index + width);
    const available = leftCounts.get(shingle) ?? 0;
    if (available > 0) {
      intersection += 1;
      leftCounts.set(shingle, available - 1);
    }
  }
  const leftTotal = left.length - width + 1;
  const rightTotal = right.length - width + 1;
  return (2 * intersection) / (leftTotal + rightTotal);
}

function noStableOverlap(
  comparedCharacters: number,
  exactPrefixCharacters = 0,
  similarity = 0,
): CandidateStableOverlapResult {
  return Object.freeze({
    kind: "none",
    risk: "none",
    comparedCharacters,
    exactPrefixCharacters,
    similarity: roundQualityScore(similarity),
    removablePrefixUtf16: null,
    removableRangeUtf16: null,
  });
}

function validateGateInput(input: CandidateQualityGateInput): void {
  if (
    !IDENTIFIER_PATTERN.test(input.candidateId) ||
    !IDENTIFIER_PATTERN.test(input.promptTrace.promptId) ||
    !Number.isSafeInteger(input.promptTrace.promptVersion) ||
    input.promptTrace.promptVersion < 1 ||
    !SHA256_PATTERN.test(input.promptTrace.promptContentHashSha256)
  ) {
    fail("QUALITY_INPUT_INVALID", "Candidate or prompt quality trace is invalid.");
  }
  validatePolicy(input.policy);
}

function validatePolicy(policy: CandidateQualityPolicy): void {
  if (
    !IDENTIFIER_PATTERN.test(policy.policyId) ||
    !Number.isSafeInteger(policy.version) ||
    policy.version < 1 ||
    !isScore(policy.minimumOverallScore) ||
    policy.thresholds.length < 1 ||
    policy.thresholds.length > CANDIDATE_QUALITY_METRICS.length
  ) {
    fail("QUALITY_POLICY_INVALID", "Candidate quality policy metadata is invalid.");
  }
  const metrics = new Set<CandidateQualityMetric>();
  let totalWeight = 0;
  for (const threshold of policy.thresholds) {
    if (
      !CANDIDATE_QUALITY_METRICS.includes(threshold.metric) ||
      metrics.has(threshold.metric) ||
      !isScore(threshold.minimumScore) ||
      !Number.isFinite(threshold.weight) ||
      threshold.weight <= 0 ||
      threshold.weight > 1 ||
      threshold.allowedSources.length < 1 ||
      new Set(threshold.allowedSources).size !== threshold.allowedSources.length ||
      threshold.allowedSources.some(
        (source) =>
          !["deterministic_rule", "model_review", "human_review", "provider_receipt"].includes(
            source,
          ),
      )
    ) {
      fail("QUALITY_POLICY_INVALID", "Candidate quality thresholds are invalid.");
    }
    metrics.add(threshold.metric);
    totalWeight += threshold.weight;
  }
  if (Math.abs(totalWeight - 1) > 0.000_001) {
    fail("QUALITY_POLICY_INVALID", "Candidate quality threshold weights must sum to one.");
  }
}

function validateObservation(observation: CandidateQualityObservation): void {
  if (
    !CANDIDATE_QUALITY_METRICS.includes(observation.metric) ||
    !isScore(observation.score) ||
    !["deterministic_rule", "model_review", "human_review", "provider_receipt"].includes(
      observation.source,
    ) ||
    observation.evidenceIds.length < 1 ||
    observation.evidenceIds.length > 1_000 ||
    new Set(observation.evidenceIds).size !== observation.evidenceIds.length ||
    observation.evidenceIds.some((id) => !EVIDENCE_ID_PATTERN.test(id)) ||
    !Number.isFinite(Date.parse(observation.measuredAt))
  ) {
    fail("QUALITY_OBSERVATION_INVALID", "Candidate quality observation is invalid.");
  }
}

function isScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function roundQualityScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function fail(code: CandidateQualityErrorCode, message: string): never {
  throw new CandidateQualityError(code, message);
}
