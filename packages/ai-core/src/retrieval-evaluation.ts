export interface RetrievalEvaluationInput {
  readonly rankedIds: readonly string[];
  readonly relevantIds: readonly string[];
  readonly limit: number;
  readonly authoritativeIds?: readonly string[];
  readonly staleIds?: readonly string[];
  readonly rejectedCandidateIds?: readonly string[];
  readonly privateIds?: readonly string[];
}

export interface RetrievalEvaluationResult {
  readonly evaluatedAtK: number;
  readonly returnedCount: number;
  readonly relevantCount: number;
  readonly relevantReturnedCount: number;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly meanReciprocalRank: number;
  readonly normalizedDiscountedCumulativeGain: number;
  readonly hitRate: number;
  readonly authorityPrecision: number;
  readonly staleHitRate: number;
  readonly rejectedCandidateContaminationRate: number;
  readonly privateLeakageCount: number;
}

export type RetrievalEvaluationErrorCode =
  | "RETRIEVAL_EVALUATION_LIMIT_INVALID"
  | "RETRIEVAL_EVALUATION_INPUT_INVALID"
  | "RETRIEVAL_EVALUATION_DUPLICATE_RANK";

export class RetrievalEvaluationError extends Error {
  public constructor(
    readonly code: RetrievalEvaluationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RetrievalEvaluationError";
  }
}

const MAXIMUM_IDENTIFIERS = 10_000;
const MAXIMUM_LIMIT = 1_000;
const MAXIMUM_IDENTIFIER_CHARACTERS = 512;

/**
 * Pure, deterministic ranking evaluation. It records no content and performs
 * no model, vector-service, or network work.
 */
export function evaluateRetrievalRanking(
  input: RetrievalEvaluationInput,
): RetrievalEvaluationResult {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAXIMUM_LIMIT) {
    throw new RetrievalEvaluationError(
      "RETRIEVAL_EVALUATION_LIMIT_INVALID",
      `Retrieval evaluation K must be between 1 and ${String(MAXIMUM_LIMIT)}.`,
    );
  }
  const rankedIds = validateIds(input.rankedIds, "rankedIds", true);
  const relevant = new Set(validateIds(input.relevantIds, "relevantIds", false));
  const authoritative = new Set(
    validateIds(input.authoritativeIds ?? input.relevantIds, "authoritativeIds", false),
  );
  const stale = new Set(validateIds(input.staleIds ?? [], "staleIds", false));
  const rejected = new Set(
    validateIds(input.rejectedCandidateIds ?? [], "rejectedCandidateIds", false),
  );
  const privateIds = new Set(validateIds(input.privateIds ?? [], "privateIds", false));
  const selected = rankedIds.slice(0, input.limit);
  const relevantRanks = selected.flatMap((id, index) => (relevant.has(id) ? [index + 1] : []));
  const relevantReturnedCount = relevantRanks.length;
  const returnedCount = selected.length;
  const dcg = relevantRanks.reduce((total, rank) => total + 1 / Math.log2(rank + 1), 0);
  const idealCount = Math.min(input.limit, relevant.size);
  const idealDcg = Array.from(
    { length: idealCount },
    (_, index) => 1 / Math.log2(index + 2),
  ).reduce((total, value) => total + value, 0);

  return Object.freeze({
    evaluatedAtK: input.limit,
    returnedCount,
    relevantCount: relevant.size,
    relevantReturnedCount,
    recallAtK: ratio(relevantReturnedCount, relevant.size),
    precisionAtK: ratio(relevantReturnedCount, returnedCount),
    meanReciprocalRank: relevantRanks[0] === undefined ? 0 : round(1 / relevantRanks[0]),
    normalizedDiscountedCumulativeGain: idealDcg === 0 ? 0 : round(dcg / idealDcg),
    hitRate: relevantReturnedCount > 0 ? 1 : 0,
    authorityPrecision: ratio(selected.filter((id) => authoritative.has(id)).length, returnedCount),
    staleHitRate: ratio(selected.filter((id) => stale.has(id)).length, returnedCount),
    rejectedCandidateContaminationRate: ratio(
      selected.filter((id) => rejected.has(id)).length,
      returnedCount,
    ),
    privateLeakageCount: selected.filter((id) => privateIds.has(id)).length,
  });
}

function validateIds(value: unknown, field: string, rejectDuplicates: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_IDENTIFIERS) {
    throw new RetrievalEvaluationError(
      "RETRIEVAL_EVALUATION_INPUT_INVALID",
      `${field} exceeds the bounded evaluation contract.`,
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of value) {
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > MAXIMUM_IDENTIFIER_CHARACTERS ||
      id !== id.trim() ||
      /[\u0000-\u001f\u007f]/u.test(id)
    ) {
      throw new RetrievalEvaluationError(
        "RETRIEVAL_EVALUATION_INPUT_INVALID",
        `${field} contains an invalid identifier.`,
      );
    }
    if (seen.has(id)) {
      if (rejectDuplicates) {
        throw new RetrievalEvaluationError(
          "RETRIEVAL_EVALUATION_DUPLICATE_RANK",
          "A ranked result cannot contain the same identity twice.",
        );
      }
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return Object.freeze(ids);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
