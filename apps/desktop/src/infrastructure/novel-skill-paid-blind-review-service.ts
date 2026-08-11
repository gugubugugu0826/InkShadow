import {
  NOVEL_SKILL_EVALUATION_METRICS,
  type NovelSkillEvaluationMetric,
} from "@inkshadow/ai-core";

export const NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_COUNT = 192 as const;

export type NovelSkillPaidBlindReviewEmptyScores = Readonly<
  Record<NovelSkillEvaluationMetric, null>
>;

export type NovelSkillPaidBlindReviewScores = Readonly<Record<NovelSkillEvaluationMetric, number>>;

/** The complete and only item projection permitted across the blind UI boundary. */
export interface NovelSkillPaidBlindReviewItem {
  readonly blindItemId: string;
  readonly position: number;
  readonly fixtureTaskContent: string;
  readonly boundaries: readonly string[];
  readonly lockedFacts: readonly string[];
  readonly requestedOutcome: string;
  readonly candidateOutput: string;
  readonly scores: NovelSkillPaidBlindReviewEmptyScores;
}

/**
 * Safe source row produced by the persistence adapter. It deliberately has no
 * observation, cell, arm, model, slot, repetition, cost, receipt or hash field.
 */
export type NovelSkillPaidBlindReviewSourceItem = Omit<NovelSkillPaidBlindReviewItem, "scores">;

export interface SubmitNovelSkillPaidBlindReviewScoresInput {
  readonly blindItemId: string;
  readonly scores: NovelSkillPaidBlindReviewScores;
}

export interface PersistNovelSkillPaidBlindReviewScoresInput extends SubmitNovelSkillPaidBlindReviewScoresInput {
  readonly batchId: string;
}

/** Narrow local persistence port. No provider-facing operation belongs here. */
export interface NovelSkillPaidBlindReviewPort {
  readBatchItems(batchId: string): Promise<readonly NovelSkillPaidBlindReviewSourceItem[]>;
  readNextUnscoredItem(batchId: string): Promise<NovelSkillPaidBlindReviewSourceItem | null>;
  submitBlindScores(input: PersistNovelSkillPaidBlindReviewScoresInput): Promise<void>;
}

export type NovelSkillPaidBlindReviewErrorCode =
  | "NOVEL_SKILL_PAID_BLIND_REVIEW_BATCH_INVALID"
  | "NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_INVALID"
  | "NOVEL_SKILL_PAID_BLIND_REVIEW_SCORES_INVALID";

export class NovelSkillPaidBlindReviewError extends Error {
  public constructor(
    readonly code: NovelSkillPaidBlindReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NovelSkillPaidBlindReviewError";
  }
}

const SAFE_SOURCE_KEYS = [
  "blindItemId",
  "position",
  "fixtureTaskContent",
  "boundaries",
  "lockedFacts",
  "requestedOutcome",
  "candidateOutput",
] as const;
const MAXIMUM_TEXT_CHARACTERS = 2_000_000;
const MAXIMUM_RULE_COUNT = 256;
const MAXIMUM_RULE_CHARACTERS = 16_384;
const BLIND_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/u;
const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{2,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Presentation-safe blind review service. Every returned item is rebuilt from
 * an allowlist and receives a new thirteen-null score sheet, so persistence
 * metadata cannot pass through by structural accident.
 */
export class NovelSkillPaidBlindReviewService {
  private batchItems: readonly NovelSkillPaidBlindReviewItem[] | null = null;

  public constructor(
    private readonly batchId: string,
    private readonly port: NovelSkillPaidBlindReviewPort,
  ) {
    if (!BATCH_ID_PATTERN.test(batchId)) {
      throw blindError(
        "NOVEL_SKILL_PAID_BLIND_REVIEW_BATCH_INVALID",
        "The blind review batch identifier is invalid.",
      );
    }
  }

  public async readBatch(): Promise<readonly NovelSkillPaidBlindReviewItem[]> {
    if (this.batchItems !== null) return this.batchItems;
    const source = await this.port.readBatchItems(this.batchId);
    if (source.length !== NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_COUNT) {
      throw blindError(
        "NOVEL_SKILL_PAID_BLIND_REVIEW_BATCH_INVALID",
        "A blind review batch must contain exactly 192 randomized items.",
      );
    }
    const items = source.map((item) => normalizeItem(item));
    items.sort((left, right) => left.position - right.position);
    assertCompleteRandomizedBatch(items);
    this.batchItems = Object.freeze(items);
    return this.batchItems;
  }

  public async nextItem(): Promise<NovelSkillPaidBlindReviewItem | null> {
    const batch = await this.readBatch();
    const source = await this.port.readNextUnscoredItem(this.batchId);
    if (source === null) return null;
    const item = normalizeItem(source);
    const assigned = batch.find(({ blindItemId }) => blindItemId === item.blindItemId);
    if (assigned === undefined || !sameSafeItem(assigned, item)) {
      throw itemError("The next blind item is outside the frozen randomized batch.");
    }
    return item;
  }

  public async submitScores(input: SubmitNovelSkillPaidBlindReviewScoresInput): Promise<void> {
    assertBlindItemId(input.blindItemId);
    const scores = normalizeSubmittedScores(input.scores);
    const batch = await this.readBatch();
    if (!batch.some(({ blindItemId }) => blindItemId === input.blindItemId)) {
      throw itemError("The scored blind item is outside the frozen randomized batch.");
    }
    await this.port.submitBlindScores(
      Object.freeze({
        batchId: this.batchId,
        blindItemId: input.blindItemId,
        scores,
      }),
    );
  }
}

function sameSafeItem(
  left: NovelSkillPaidBlindReviewItem,
  right: NovelSkillPaidBlindReviewItem,
): boolean {
  return (
    left.blindItemId === right.blindItemId &&
    left.position === right.position &&
    left.fixtureTaskContent === right.fixtureTaskContent &&
    sameStrings(left.boundaries, right.boundaries) &&
    sameStrings(left.lockedFacts, right.lockedFacts) &&
    left.requestedOutcome === right.requestedOutcome &&
    left.candidateOutput === right.candidateOutput
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeItem(source: NovelSkillPaidBlindReviewSourceItem): NovelSkillPaidBlindReviewItem {
  assertSafeSourceKeys(source);
  assertBlindItemId(source.blindItemId);
  if (
    !Number.isSafeInteger(source.position) ||
    source.position < 1 ||
    source.position > NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_COUNT
  ) {
    throw itemError("A blind review item has an invalid randomized position.");
  }
  const fixtureTaskContent = normalizeText(source.fixtureTaskContent, "fixture task content");
  const boundaries = normalizeRules(source.boundaries, "boundaries");
  const lockedFacts = normalizeRules(source.lockedFacts, "locked facts");
  const requestedOutcome = normalizeText(source.requestedOutcome, "requested outcome");
  const candidateOutput = normalizeText(source.candidateOutput, "Candidate output");
  return Object.freeze({
    blindItemId: source.blindItemId,
    position: source.position,
    fixtureTaskContent,
    boundaries,
    lockedFacts,
    requestedOutcome,
    candidateOutput,
    scores: emptyScoreSheet(),
  });
}

function assertSafeSourceKeys(source: NovelSkillPaidBlindReviewSourceItem): void {
  if (!isPlainObject(source)) throw itemError("A blind review item must be a plain object.");
  const actual = Object.keys(source).sort(compareText);
  const expected = [...SAFE_SOURCE_KEYS].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw itemError("A blind review item contains non-blinded persistence metadata.");
  }
}

function assertCompleteRandomizedBatch(items: readonly NovelSkillPaidBlindReviewItem[]): void {
  const ids = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.position !== index + 1 || ids.has(item.blindItemId)) {
      throw blindError(
        "NOVEL_SKILL_PAID_BLIND_REVIEW_BATCH_INVALID",
        "The blind review batch has duplicate or incomplete randomized assignments.",
      );
    }
    ids.add(item.blindItemId);
  }
}

function normalizeSubmittedScores(
  value: NovelSkillPaidBlindReviewScores,
): NovelSkillPaidBlindReviewScores {
  if (!isPlainObject(value)) throw scoresError();
  const actual = Object.keys(value).sort(compareText);
  const expected = [...NOVEL_SKILL_EVALUATION_METRICS].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw scoresError();
  }
  const normalized = {} as Record<NovelSkillEvaluationMetric, number>;
  for (const metric of NOVEL_SKILL_EVALUATION_METRICS) {
    const score = value[metric];
    if (!Number.isFinite(score) || score < 0 || score > 1) throw scoresError();
    normalized[metric] = score;
  }
  return Object.freeze(normalized);
}

function emptyScoreSheet(): NovelSkillPaidBlindReviewEmptyScores {
  const scores = {} as Record<NovelSkillEvaluationMetric, null>;
  for (const metric of NOVEL_SKILL_EVALUATION_METRICS) scores[metric] = null;
  return Object.freeze(scores);
}

function normalizeRules(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_RULE_COUNT) {
    throw itemError(`Blind review ${label} are invalid.`);
  }
  return Object.freeze(
    value.map((item) => {
      if (
        typeof item !== "string" ||
        item.trim().length === 0 ||
        Array.from(item).length > MAXIMUM_RULE_CHARACTERS ||
        CONTROL_CHARACTER_PATTERN.test(item)
      ) {
        throw itemError(`Blind review ${label} are invalid.`);
      }
      return item;
    }),
  );
}

function normalizeText(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Array.from(value).length > MAXIMUM_TEXT_CHARACTERS ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw itemError(`Blind review ${label} is invalid.`);
  }
  return value;
}

function assertBlindItemId(value: string): void {
  if (typeof value !== "string" || !BLIND_ITEM_ID_PATTERN.test(value)) {
    throw itemError("The blind review item identifier is invalid.");
  }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function itemError(message: string): NovelSkillPaidBlindReviewError {
  return blindError("NOVEL_SKILL_PAID_BLIND_REVIEW_ITEM_INVALID", message);
}

function scoresError(): NovelSkillPaidBlindReviewError {
  return blindError(
    "NOVEL_SKILL_PAID_BLIND_REVIEW_SCORES_INVALID",
    "Blind review requires exactly thirteen finite scores between zero and one.",
  );
}

function blindError(
  code: NovelSkillPaidBlindReviewErrorCode,
  message: string,
): NovelSkillPaidBlindReviewError {
  return new NovelSkillPaidBlindReviewError(code, message);
}
