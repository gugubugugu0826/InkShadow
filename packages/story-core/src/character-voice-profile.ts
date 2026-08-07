export const CHARACTER_VOICE_DEVIATION_CATEGORIES = [
  "sentence_length",
  "common_terms",
  "address_habit",
  "emotional_expression",
  "politeness",
  "directness",
  "metaphor_usage",
  "dialect_usage",
  "addressee_voice",
] as const;

export type CharacterVoiceDeviationCategory = (typeof CHARACTER_VOICE_DEVIATION_CATEGORIES)[number];

export type CharacterVoiceMetricKey =
  | "average_sentence_characters"
  | "common_term_rate_per_100_characters"
  | "address_term_rate_per_100_characters"
  | "emotion_marker_rate_per_100_characters"
  | "politeness_score"
  | "politeness_marker_rate_per_100_characters"
  | "directness_score"
  | "directness_marker_rate_per_100_characters"
  | "metaphor_marker_rate_per_100_characters"
  | "dialect_marker_rate_per_100_characters";

export interface CharacterVoiceTextEvidence {
  readonly id: string;
  readonly chapterId: string;
  readonly chapterVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

export interface CharacterDialogueSample {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly characterId: string;
  readonly addresseeCharacterId: string | null;
  readonly text: string;
  readonly typical: boolean;
  /** Missing evidence excludes the sample from authoritative statistics. */
  readonly evidence: CharacterVoiceTextEvidence | null;
}

export interface CharacterVoiceAddressTerms {
  readonly addresseeCharacterId: string;
  readonly terms: readonly string[];
}

/**
 * Literal marker lists are deliberately explicit. This detector never asks a
 * model to guess whether a sentence is polite, direct, metaphorical, or dialect.
 */
export interface CharacterVoiceFeatureCatalog {
  readonly commonTermCandidates: readonly string[];
  readonly emotionMarkers: readonly string[];
  readonly politeMarkers: readonly string[];
  readonly casualMarkers: readonly string[];
  readonly directMarkers: readonly string[];
  readonly indirectMarkers: readonly string[];
  readonly metaphorMarkers: readonly string[];
  readonly dialectMarkers: readonly string[];
  readonly addressTerms: readonly CharacterVoiceAddressTerms[];
}

export interface BuildCharacterVoiceProfileInput {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly characterId: string;
  readonly historicalDialogue: readonly CharacterDialogueSample[];
  readonly featureCatalog: CharacterVoiceFeatureCatalog;
}

export interface CharacterVoiceEvidenceReadiness {
  readonly suppliedSampleCount: number;
  readonly evidenceBackedSampleCount: number;
  readonly evidenceBackedCharacterCount: number;
  readonly minimumSampleCount: number;
  readonly minimumCharacterCount: number;
  readonly status: "ready" | "insufficient_evidence";
  readonly excludedSampleIds: readonly string[];
}

export interface CharacterVoiceMetricBand {
  readonly metricKey: CharacterVoiceMetricKey;
  readonly unit: "characters" | "per_100_characters" | "score_-1_to_1";
  readonly sampleCount: number;
  readonly mean: number;
  readonly standardDeviation: number;
  readonly tolerance: number;
  readonly lowerBound: number;
  readonly upperBound: number;
  readonly historicalEvidence: readonly CharacterVoiceTextEvidence[];
}

export interface CharacterVoiceCommonTerm {
  readonly term: string;
  readonly occurrenceCount: number;
  readonly sampleCount: number;
  readonly ratePerHundredCharacters: number;
  readonly historicalEvidence: readonly CharacterVoiceTextEvidence[];
}

export interface CharacterVoiceContrastStyle {
  readonly positiveMarkers: readonly string[];
  readonly negativeMarkers: readonly string[];
  readonly score: CharacterVoiceMetricBand | null;
  readonly markerRate: CharacterVoiceMetricBand;
}

export interface CharacterVoiceLiteralStyle {
  readonly markers: readonly string[];
  readonly rate: CharacterVoiceMetricBand;
}

export interface CharacterVoiceTypicalQuote {
  readonly sampleId: string;
  readonly text: string;
  readonly addresseeCharacterId: string | null;
  readonly evidence: CharacterVoiceTextEvidence;
}

export interface CharacterVoiceAddresseeVariant {
  readonly addresseeCharacterId: string;
  readonly sampleCount: number;
  readonly characterCount: number;
  readonly preferredAddressTerms: readonly string[];
  readonly addressTermRate: CharacterVoiceMetricBand;
  readonly politenessScore: CharacterVoiceMetricBand | null;
  readonly directnessScore: CharacterVoiceMetricBand | null;
  readonly historicalEvidence: readonly CharacterVoiceTextEvidence[];
}

export interface CharacterVoiceProfile {
  readonly kind: "evidence_backed_character_voice_profile";
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly characterId: string;
  readonly evidenceReadiness: CharacterVoiceEvidenceReadiness;
  readonly featureCatalog: CharacterVoiceFeatureCatalog;
  readonly commonTerms: readonly CharacterVoiceCommonTerm[];
  readonly sentenceLength: CharacterVoiceMetricBand | null;
  readonly commonTermRate: CharacterVoiceMetricBand | null;
  readonly emotionalExpression: CharacterVoiceLiteralStyle | null;
  readonly politeness: CharacterVoiceContrastStyle | null;
  readonly directness: CharacterVoiceContrastStyle | null;
  readonly metaphorUsage: CharacterVoiceLiteralStyle | null;
  readonly dialectUsage: CharacterVoiceLiteralStyle | null;
  readonly typicalQuotes: readonly CharacterVoiceTypicalQuote[];
  readonly addresseeVariants: readonly CharacterVoiceAddresseeVariant[];
}

export interface DetectCharacterVoiceDeviationInput {
  readonly profile: CharacterVoiceProfile;
  readonly currentDialogue: readonly CharacterDialogueSample[];
}

export type CharacterVoiceDeviationSeverity = "warning" | "error";

export interface CharacterVoiceDeviationMetric {
  readonly metricKey: CharacterVoiceMetricKey;
  readonly unit: CharacterVoiceMetricBand["unit"];
  readonly historicalMean: number;
  readonly expectedLowerBound: number;
  readonly expectedUpperBound: number;
  readonly currentValue: number;
  readonly distanceOutsideExpectedRange: number;
  readonly normalizedDeviation: number;
}

export interface CharacterVoiceDeviationIssue {
  readonly id: string;
  readonly detector: "deterministic_statistics";
  readonly category: CharacterVoiceDeviationCategory;
  readonly severity: CharacterVoiceDeviationSeverity;
  readonly characterId: string;
  readonly addresseeCharacterId: string | null;
  readonly metric: CharacterVoiceDeviationMetric;
  readonly observedMarkers: readonly string[];
  readonly expectedMarkers: readonly string[];
  readonly explanation: string;
  readonly currentDialogueEvidence: readonly CharacterVoiceTextEvidence[];
  readonly historicalDialogueEvidence: readonly CharacterVoiceTextEvidence[];
  readonly suggestion: Readonly<{
    readonly summary: string;
    readonly actions: readonly string[];
  }>;
}

export type CharacterVoiceSkippedReason =
  "insufficient_historical_evidence" | "insufficient_current_evidence" | "metric_not_observable";

export interface CharacterVoiceSkippedCheck {
  readonly scope: "profile" | "current_dialogue" | "metric";
  readonly metricKey: CharacterVoiceMetricKey | null;
  readonly addresseeCharacterId: string | null;
  readonly reason: CharacterVoiceSkippedReason;
}

export interface CharacterVoiceDeviationResult {
  readonly issues: readonly CharacterVoiceDeviationIssue[];
  readonly skippedChecks: readonly CharacterVoiceSkippedCheck[];
  readonly capabilities: Readonly<{
    deterministicStatisticalReview: "ready";
    ambiguousSemanticReview: "separate_read_only_ai_review";
    modelInvocation: "not_used";
  }>;
}

export interface AmbiguousCharacterVoiceReviewPort {
  review(
    request: AmbiguousCharacterVoiceReviewRequest,
  ): Promise<readonly AmbiguousCharacterVoiceFinding[]>;
}

export interface AmbiguousCharacterVoiceReviewRequest {
  readonly projectId: string;
  readonly branchId: string;
  readonly characterId: string;
  readonly currentDialogue: readonly CharacterDialogueSample[];
  readonly typicalQuotes: readonly CharacterVoiceTypicalQuote[];
}

export interface AmbiguousCharacterVoiceFinding {
  readonly kind: "model_assisted_unverified";
  readonly summary: string;
  readonly currentDialogueEvidence: readonly CharacterVoiceTextEvidence[];
  readonly historicalDialogueEvidence: readonly CharacterVoiceTextEvidence[];
  readonly requiresHumanReview: true;
}

export type CharacterVoiceInputErrorCode = "CHARACTER_VOICE_INPUT_INVALID";

export class CharacterVoiceInputError extends Error {
  public readonly code: CharacterVoiceInputErrorCode = "CHARACTER_VOICE_INPUT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "CharacterVoiceInputError";
  }
}

const MINIMUM_HISTORICAL_SAMPLES = 5;
const MINIMUM_HISTORICAL_CHARACTERS = 120;
const MINIMUM_CURRENT_CHARACTERS = 24;
const MINIMUM_ADDRESSEE_SAMPLES = 3;
const MINIMUM_ADDRESSEE_CHARACTERS = 60;
const MINIMUM_OBSERVABLE_STYLE_SAMPLES = 3;
const MINIMUM_COMMON_TERM_OCCURRENCES = 2;
const MINIMUM_COMMON_TERM_SAMPLES = 2;
const MAXIMUM_DIALOGUE_SAMPLES = 4_096;
const MAXIMUM_TEXT_CHARACTERS = 200_000;
const MAXIMUM_TOTAL_TEXT_CHARACTERS = 5_000_000;
const MAXIMUM_REFERENCE_CHARACTERS = 512;
const MAXIMUM_MARKERS_PER_GROUP = 256;
const MAXIMUM_MARKER_CHARACTERS = 128;
const MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS = 200_000;
const MAXIMUM_EVIDENCE_SOURCE_CHARACTERS = 5_000_000;
const MAXIMUM_ISSUE_EVIDENCE = 5;
const MAXIMUM_TYPICAL_QUOTES = 5;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const SENTENCE_BOUNDARY_PATTERN = /[.!?。！？…]+/u;
const EXPRESSIVE_PUNCTUATION_PATTERN = /[!?！？…]/gu;

interface QualifiedDialogueSample extends Omit<CharacterDialogueSample, "evidence"> {
  readonly evidence: CharacterVoiceTextEvidence;
  readonly characterCount: number;
}

interface DialogueMetrics {
  readonly averageSentenceCharacters: number;
  readonly characterCount: number;
  readonly commonTermRate: number;
  readonly emotionMarkerRate: number;
  readonly politenessScore: number | null;
  readonly politenessMarkerRate: number;
  readonly directnessScore: number | null;
  readonly directnessMarkerRate: number;
  readonly metaphorMarkerRate: number;
  readonly dialectMarkerRate: number;
}

interface MetricObservation {
  readonly value: number;
  readonly sample: QualifiedDialogueSample;
}

interface ValidatedProfileSource {
  readonly id: string;
  readonly projectId: string;
  readonly branchId: string;
  readonly characterId: string;
  readonly samples: readonly CharacterDialogueSample[];
  readonly qualifiedSamples: readonly QualifiedDialogueSample[];
  readonly featureCatalog: CharacterVoiceFeatureCatalog;
}

interface IssueContext {
  readonly profile: CharacterVoiceProfile;
  readonly currentSamples: readonly QualifiedDialogueSample[];
  readonly issues: CharacterVoiceDeviationIssue[];
  readonly skippedChecks: CharacterVoiceSkippedCheck[];
}

export function buildCharacterVoiceProfile(
  input: BuildCharacterVoiceProfileInput,
): CharacterVoiceProfile {
  const source = validateProfileSource(input);
  const evidenceBackedCharacterCount = sum(
    source.qualifiedSamples.map(({ characterCount }) => characterCount),
  );
  const ready =
    source.qualifiedSamples.length >= MINIMUM_HISTORICAL_SAMPLES &&
    evidenceBackedCharacterCount >= MINIMUM_HISTORICAL_CHARACTERS;
  const readiness = Object.freeze({
    suppliedSampleCount: source.samples.length,
    evidenceBackedSampleCount: source.qualifiedSamples.length,
    evidenceBackedCharacterCount,
    minimumSampleCount: MINIMUM_HISTORICAL_SAMPLES,
    minimumCharacterCount: MINIMUM_HISTORICAL_CHARACTERS,
    status: ready ? ("ready" as const) : ("insufficient_evidence" as const),
    excludedSampleIds: Object.freeze(
      source.samples
        .filter(({ evidence }) => evidence === null)
        .map(({ id }) => id)
        .sort(),
    ),
  });
  if (!ready) {
    return freezeProfile({
      ...source,
      evidenceReadiness: readiness,
      commonTerms: [],
      sentenceLength: null,
      commonTermRate: null,
      emotionalExpression: null,
      politeness: null,
      directness: null,
      metaphorUsage: null,
      dialectUsage: null,
      typicalQuotes: [],
      addresseeVariants: [],
    });
  }

  const commonTerms = buildCommonTerms(
    source.qualifiedSamples,
    source.featureCatalog.commonTermCandidates,
  );
  const selectedCommonTerms = commonTerms.map(({ term }) => term);
  const observations = source.qualifiedSamples.map((sample) => ({
    sample,
    metrics: measureDialogue(sample.text, source.featureCatalog, selectedCommonTerms),
  }));
  const sentenceLength = buildMetricBand(
    "average_sentence_characters",
    "characters",
    observations.map(({ sample, metrics }) => ({
      sample,
      value: metrics.averageSentenceCharacters,
    })),
    2.5,
  );
  const commonTermRate =
    selectedCommonTerms.length === 0
      ? null
      : buildMetricBand(
          "common_term_rate_per_100_characters",
          "per_100_characters",
          observations.map(({ sample, metrics }) => ({
            sample,
            value: metrics.commonTermRate,
          })),
          0.75,
        );
  const emotionalExpression = buildLiteralStyle(
    source.featureCatalog.emotionMarkers,
    "emotion_marker_rate_per_100_characters",
    observations.map(({ sample, metrics }) => ({
      sample,
      value: metrics.emotionMarkerRate,
    })),
  );
  const politeness = buildContrastStyle(
    source.featureCatalog.politeMarkers,
    source.featureCatalog.casualMarkers,
    "politeness_score",
    "politeness_marker_rate_per_100_characters",
    observations.map(({ sample, metrics }) => ({
      sample,
      score: metrics.politenessScore,
      rate: metrics.politenessMarkerRate,
    })),
  );
  const directness = buildContrastStyle(
    source.featureCatalog.directMarkers,
    source.featureCatalog.indirectMarkers,
    "directness_score",
    "directness_marker_rate_per_100_characters",
    observations.map(({ sample, metrics }) => ({
      sample,
      score: metrics.directnessScore,
      rate: metrics.directnessMarkerRate,
    })),
  );
  const metaphorUsage = buildLiteralStyle(
    source.featureCatalog.metaphorMarkers,
    "metaphor_marker_rate_per_100_characters",
    observations.map(({ sample, metrics }) => ({
      sample,
      value: metrics.metaphorMarkerRate,
    })),
  );
  const dialectUsage = buildLiteralStyle(
    source.featureCatalog.dialectMarkers,
    "dialect_marker_rate_per_100_characters",
    observations.map(({ sample, metrics }) => ({
      sample,
      value: metrics.dialectMarkerRate,
    })),
  );

  return freezeProfile({
    ...source,
    evidenceReadiness: readiness,
    commonTerms,
    sentenceLength,
    commonTermRate,
    emotionalExpression,
    politeness,
    directness,
    metaphorUsage,
    dialectUsage,
    typicalQuotes: selectTypicalQuotes(source.qualifiedSamples, sentenceLength.mean),
    addresseeVariants: buildAddresseeVariants(source),
  });
}

export function detectCharacterVoiceDeviation(
  input: DetectCharacterVoiceDeviationInput,
): CharacterVoiceDeviationResult {
  if (!isRecord(input) || !isVoiceProfile(input.profile) || !Array.isArray(input.currentDialogue)) {
    throw invalidInput("A character voice deviation request is invalid.");
  }
  const profile = input.profile;
  const validatedCurrent = validateDialogueSamples(
    input.currentDialogue,
    profile.projectId,
    profile.branchId,
    profile.characterId,
  );
  const qualifiedCurrent = validatedCurrent.filter(
    (sample): sample is QualifiedDialogueSample => sample.evidence !== null,
  );
  const currentCharacterCount = sum(qualifiedCurrent.map(({ characterCount }) => characterCount));
  const context: IssueContext = {
    profile,
    currentSamples: qualifiedCurrent,
    issues: [],
    skippedChecks: [],
  };

  if (profile.evidenceReadiness.status !== "ready") {
    context.skippedChecks.push(
      freezeSkipped("profile", null, null, "insufficient_historical_evidence"),
    );
    return finishResult(context);
  }
  if (qualifiedCurrent.length === 0 || currentCharacterCount < MINIMUM_CURRENT_CHARACTERS) {
    context.skippedChecks.push(
      freezeSkipped("current_dialogue", null, null, "insufficient_current_evidence"),
    );
    return finishResult(context);
  }

  const currentText = qualifiedCurrent.map(({ text }) => text).join("\n");
  const commonTerms = profile.commonTerms.map(({ term }) => term);
  const metrics = measureDialogueSamples(qualifiedCurrent, profile.featureCatalog, commonTerms);
  checkMetric(
    context,
    "sentence_length",
    profile.sentenceLength,
    metrics.averageSentenceCharacters,
    [],
    [],
    null,
  );
  checkMetric(
    context,
    "common_terms",
    profile.commonTermRate,
    metrics.commonTermRate,
    findObservedMarkers(currentText, commonTerms),
    commonTerms,
    null,
  );
  checkMetric(
    context,
    "emotional_expression",
    profile.emotionalExpression?.rate ?? null,
    metrics.emotionMarkerRate,
    findObservedMarkers(currentText, [
      ...profile.featureCatalog.emotionMarkers,
      "!",
      "！",
      "?",
      "？",
      "…",
    ]),
    profile.featureCatalog.emotionMarkers,
    null,
  );
  checkContrastStyle(
    context,
    "politeness",
    profile.politeness,
    metrics.politenessScore,
    metrics.politenessMarkerRate,
    currentText,
    null,
  );
  checkContrastStyle(
    context,
    "directness",
    profile.directness,
    metrics.directnessScore,
    metrics.directnessMarkerRate,
    currentText,
    null,
  );
  checkMetric(
    context,
    "metaphor_usage",
    profile.metaphorUsage?.rate ?? null,
    metrics.metaphorMarkerRate,
    findObservedMarkers(currentText, profile.featureCatalog.metaphorMarkers),
    profile.featureCatalog.metaphorMarkers,
    null,
  );
  checkMetric(
    context,
    "dialect_usage",
    profile.dialectUsage?.rate ?? null,
    metrics.dialectMarkerRate,
    findObservedMarkers(currentText, profile.featureCatalog.dialectMarkers),
    profile.featureCatalog.dialectMarkers,
    null,
  );
  checkAddresseeVariants(context);
  return finishResult(context);
}

function validateProfileSource(input: BuildCharacterVoiceProfileInput): ValidatedProfileSource {
  if (
    !isRecord(input) ||
    !isSafeReference(input.id) ||
    !isSafeReference(input.projectId) ||
    !isSafeReference(input.branchId) ||
    !isSafeReference(input.characterId) ||
    !Array.isArray(input.historicalDialogue)
  ) {
    throw invalidInput("A character voice profile source is invalid.");
  }
  const featureCatalog = validateFeatureCatalog(input.featureCatalog);
  const samples = validateDialogueSamples(
    input.historicalDialogue,
    input.projectId,
    input.branchId,
    input.characterId,
  );
  return Object.freeze({
    id: input.id,
    projectId: input.projectId,
    branchId: input.branchId,
    characterId: input.characterId,
    samples,
    qualifiedSamples: Object.freeze(
      samples.filter((sample): sample is QualifiedDialogueSample => sample.evidence !== null),
    ),
    featureCatalog,
  });
}

function validateFeatureCatalog(value: unknown): CharacterVoiceFeatureCatalog {
  if (!isRecord(value) || !Array.isArray(value.addressTerms)) {
    throw invalidInput("A character voice feature catalog is invalid.");
  }
  const commonTermCandidates = validateMarkerGroup(value.commonTermCandidates, "common terms");
  const emotionMarkers = validateMarkerGroup(value.emotionMarkers, "emotion markers");
  const politeMarkers = validateMarkerGroup(value.politeMarkers, "polite markers");
  const casualMarkers = validateMarkerGroup(value.casualMarkers, "casual markers");
  const directMarkers = validateMarkerGroup(value.directMarkers, "direct markers");
  const indirectMarkers = validateMarkerGroup(value.indirectMarkers, "indirect markers");
  const metaphorMarkers = validateMarkerGroup(value.metaphorMarkers, "metaphor markers");
  const dialectMarkers = validateMarkerGroup(value.dialectMarkers, "dialect markers");
  rejectMarkerOverlap(politeMarkers, casualMarkers, "politeness");
  rejectMarkerOverlap(directMarkers, indirectMarkers, "directness");

  if (value.addressTerms.length > MAXIMUM_MARKERS_PER_GROUP) {
    throw invalidInput("Character voice address groups exceed the supported bound.");
  }
  const addressees = new Set<string>();
  const addressTerms = value.addressTerms.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !isSafeReference(entry.addresseeCharacterId) ||
      addressees.has(entry.addresseeCharacterId)
    ) {
      throw invalidInput("Character voice address groups must identify unique addressees.");
    }
    addressees.add(entry.addresseeCharacterId);
    return Object.freeze({
      addresseeCharacterId: entry.addresseeCharacterId,
      terms: validateMarkerGroup(entry.terms, "address terms"),
    });
  });
  return Object.freeze({
    commonTermCandidates,
    emotionMarkers,
    politeMarkers,
    casualMarkers,
    directMarkers,
    indirectMarkers,
    metaphorMarkers,
    dialectMarkers,
    addressTerms: Object.freeze(addressTerms.sort(compareAddressTerms)),
  });
}

function validateMarkerGroup(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_MARKERS_PER_GROUP) {
    throw invalidInput(`Character voice ${context} are invalid.`);
  }
  const normalized: string[] = [];
  const unique = new Set<string>();
  for (const marker of value) {
    if (
      !isBoundedText(marker, MAXIMUM_MARKER_CHARACTERS) ||
      marker !== marker.trim() ||
      unique.has(normalizeForMatching(marker))
    ) {
      throw invalidInput(`Character voice ${context} must be unique bounded text.`);
    }
    unique.add(normalizeForMatching(marker));
    normalized.push(marker);
  }
  return Object.freeze(normalized.sort((left, right) => left.localeCompare(right)));
}

function rejectMarkerOverlap(
  positive: readonly string[],
  negative: readonly string[],
  context: string,
): void {
  const positiveSet = new Set(positive.map(normalizeForMatching));
  if (negative.some((marker) => positiveSet.has(normalizeForMatching(marker)))) {
    throw invalidInput(`Character voice ${context} marker groups cannot overlap.`);
  }
}

function validateDialogueSamples(
  value: readonly CharacterDialogueSample[],
  projectId: string,
  branchId: string,
  characterId: string,
): readonly (CharacterDialogueSample | QualifiedDialogueSample)[] {
  if (value.length > MAXIMUM_DIALOGUE_SAMPLES) {
    throw invalidInput("Character dialogue samples exceed the supported bound.");
  }
  const ids = new Set<string>();
  let totalCharacters = 0;
  const samples = value.map((sample: unknown) => {
    if (
      !isRecord(sample) ||
      !isSafeReference(sample.id) ||
      ids.has(sample.id) ||
      sample.projectId !== projectId ||
      sample.branchId !== branchId ||
      sample.characterId !== characterId ||
      !isNullableSafeReference(sample.addresseeCharacterId) ||
      !isBoundedText(sample.text, MAXIMUM_TEXT_CHARACTERS) ||
      typeof sample.typical !== "boolean" ||
      (sample.evidence !== null && !isRecord(sample.evidence))
    ) {
      throw invalidInput("A character dialogue sample is invalid or crosses its profile scope.");
    }
    ids.add(sample.id);
    totalCharacters += sample.text.length;
    if (totalCharacters > MAXIMUM_TOTAL_TEXT_CHARACTERS) {
      throw invalidInput("Character dialogue samples exceed the total text bound.");
    }
    if (sample.evidence === null) {
      return Object.freeze({
        id: sample.id,
        projectId: sample.projectId,
        branchId: sample.branchId,
        characterId: sample.characterId,
        addresseeCharacterId: sample.addresseeCharacterId,
        text: sample.text,
        typical: sample.typical,
        evidence: null,
      });
    }
    const evidence = validateEvidence(sample.evidence, sample.text);
    return Object.freeze({
      id: sample.id,
      projectId: sample.projectId,
      branchId: sample.branchId,
      characterId: sample.characterId,
      addresseeCharacterId: sample.addresseeCharacterId,
      text: sample.text,
      typical: sample.typical,
      evidence,
      characterCount: countVisibleCharacters(sample.text),
    });
  });
  return Object.freeze([...samples].sort((left, right) => left.id.localeCompare(right.id)));
}

function validateEvidence(value: unknown, exactText: string): CharacterVoiceTextEvidence {
  if (
    !isRecord(value) ||
    !isSafeReference(value.id) ||
    !isSafeReference(value.chapterId) ||
    !isSafeReference(value.chapterVersionId) ||
    typeof value.contentHash !== "string" ||
    !SHA256_PATTERN.test(value.contentHash) ||
    !isBoundedText(value.locator, 2_000) ||
    !isBoundedText(value.excerpt, MAXIMUM_EVIDENCE_EXCERPT_CHARACTERS) ||
    value.excerpt !== exactText ||
    typeof value.startOffset !== "number" ||
    !Number.isSafeInteger(value.startOffset) ||
    typeof value.endOffset !== "number" ||
    !Number.isSafeInteger(value.endOffset) ||
    typeof value.sourceLength !== "number" ||
    !Number.isSafeInteger(value.sourceLength) ||
    value.startOffset < 0 ||
    value.endOffset <= value.startOffset ||
    value.endOffset > value.sourceLength ||
    value.sourceLength > MAXIMUM_EVIDENCE_SOURCE_CHARACTERS ||
    value.excerpt.length !== value.endOffset - value.startOffset
  ) {
    throw invalidInput("Character voice evidence must exactly cite an immutable dialogue span.");
  }
  return Object.freeze({
    id: value.id,
    chapterId: value.chapterId,
    chapterVersionId: value.chapterVersionId,
    contentHash: value.contentHash,
    locator: value.locator,
    excerpt: value.excerpt,
    startOffset: value.startOffset,
    endOffset: value.endOffset,
    sourceLength: value.sourceLength,
  });
}

function buildCommonTerms(
  samples: readonly QualifiedDialogueSample[],
  candidates: readonly string[],
): readonly CharacterVoiceCommonTerm[] {
  const totalCharacters = sum(samples.map(({ characterCount }) => characterCount));
  const terms: CharacterVoiceCommonTerm[] = [];
  for (const term of candidates) {
    const matchingSamples = samples.filter(({ text }) => countLiteralOccurrences(text, term) > 0);
    const occurrenceCount = sum(
      matchingSamples.map(({ text }) => countLiteralOccurrences(text, term)),
    );
    if (
      occurrenceCount < MINIMUM_COMMON_TERM_OCCURRENCES ||
      matchingSamples.length < MINIMUM_COMMON_TERM_SAMPLES
    ) {
      continue;
    }
    terms.push(
      Object.freeze({
        term,
        occurrenceCount,
        sampleCount: matchingSamples.length,
        ratePerHundredCharacters: roundMetric((occurrenceCount * 100) / totalCharacters),
        historicalEvidence: selectEvidence(matchingSamples),
      }),
    );
  }
  return Object.freeze(
    terms.sort(
      (left, right) =>
        right.ratePerHundredCharacters - left.ratePerHundredCharacters ||
        left.term.localeCompare(right.term),
    ),
  );
}

function buildLiteralStyle(
  markers: readonly string[],
  metricKey: CharacterVoiceMetricKey,
  observations: readonly MetricObservation[],
): CharacterVoiceLiteralStyle | null {
  if (markers.length === 0 && metricKey !== "emotion_marker_rate_per_100_characters") {
    return null;
  }
  return Object.freeze({
    markers,
    rate: buildMetricBand(metricKey, "per_100_characters", observations, 0.75),
  });
}

function buildContrastStyle(
  positiveMarkers: readonly string[],
  negativeMarkers: readonly string[],
  scoreKey: CharacterVoiceMetricKey,
  rateKey: CharacterVoiceMetricKey,
  observations: readonly Readonly<{
    sample: QualifiedDialogueSample;
    score: number | null;
    rate: number;
  }>[],
): CharacterVoiceContrastStyle | null {
  if (positiveMarkers.length === 0 && negativeMarkers.length === 0) {
    return null;
  }
  const scoreObservations = observations.flatMap(({ sample, score }) =>
    score === null ? [] : [{ sample, value: score }],
  );
  return Object.freeze({
    positiveMarkers,
    negativeMarkers,
    score:
      scoreObservations.length < MINIMUM_OBSERVABLE_STYLE_SAMPLES
        ? null
        : buildMetricBand(scoreKey, "score_-1_to_1", scoreObservations, 0.15),
    markerRate: buildMetricBand(
      rateKey,
      "per_100_characters",
      observations.map(({ sample, rate }) => ({ sample, value: rate })),
      0.75,
    ),
  });
}

function buildAddresseeVariants(
  source: ValidatedProfileSource,
): readonly CharacterVoiceAddresseeVariant[] {
  const variants: CharacterVoiceAddresseeVariant[] = [];
  for (const addressGroup of source.featureCatalog.addressTerms) {
    const samples = source.qualifiedSamples.filter(
      ({ addresseeCharacterId }) => addresseeCharacterId === addressGroup.addresseeCharacterId,
    );
    const characterCount = sum(samples.map(({ characterCount: count }) => count));
    if (
      samples.length < MINIMUM_ADDRESSEE_SAMPLES ||
      characterCount < MINIMUM_ADDRESSEE_CHARACTERS
    ) {
      continue;
    }
    const measurements = samples.map((sample) => ({
      sample,
      metrics: measureDialogue(sample.text, source.featureCatalog, []),
      addressRate: literalRate(sample.text, addressGroup.terms),
    }));
    const preferredAddressTerms = addressGroup.terms.filter((term) =>
      samples.some(({ text }) => countLiteralOccurrences(text, term) > 0),
    );
    const politenessObservations = measurements.flatMap(({ sample, metrics }) =>
      metrics.politenessScore === null ? [] : [{ sample, value: metrics.politenessScore }],
    );
    const directnessObservations = measurements.flatMap(({ sample, metrics }) =>
      metrics.directnessScore === null ? [] : [{ sample, value: metrics.directnessScore }],
    );
    variants.push(
      Object.freeze({
        addresseeCharacterId: addressGroup.addresseeCharacterId,
        sampleCount: samples.length,
        characterCount,
        preferredAddressTerms: Object.freeze(preferredAddressTerms),
        addressTermRate: buildMetricBand(
          "address_term_rate_per_100_characters",
          "per_100_characters",
          measurements.map(({ sample, addressRate }) => ({ sample, value: addressRate })),
          0.75,
        ),
        politenessScore:
          politenessObservations.length < MINIMUM_OBSERVABLE_STYLE_SAMPLES
            ? null
            : buildMetricBand("politeness_score", "score_-1_to_1", politenessObservations, 0.15),
        directnessScore:
          directnessObservations.length < MINIMUM_OBSERVABLE_STYLE_SAMPLES
            ? null
            : buildMetricBand("directness_score", "score_-1_to_1", directnessObservations, 0.15),
        historicalEvidence: selectEvidence(samples),
      }),
    );
  }
  return Object.freeze(
    variants.sort((left, right) =>
      left.addresseeCharacterId.localeCompare(right.addresseeCharacterId),
    ),
  );
}

function buildMetricBand(
  metricKey: CharacterVoiceMetricKey,
  unit: CharacterVoiceMetricBand["unit"],
  observations: readonly MetricObservation[],
  toleranceFloor: number,
): CharacterVoiceMetricBand {
  if (observations.length === 0) {
    throw invalidInput("A character voice metric band requires historical observations.");
  }
  const values = observations.map(({ value }) => value);
  const mean = sum(values) / values.length;
  const variance = sum(values.map((value) => (value - mean) ** 2)) / values.length;
  const standardDeviation = Math.sqrt(variance);
  const tolerance = Math.max(standardDeviation, toleranceFloor);
  const naturalMinimum = unit === "score_-1_to_1" ? -1 : 0;
  const naturalMaximum = unit === "score_-1_to_1" ? 1 : Number.POSITIVE_INFINITY;
  return Object.freeze({
    metricKey,
    unit,
    sampleCount: observations.length,
    mean: roundMetric(mean),
    standardDeviation: roundMetric(standardDeviation),
    tolerance: roundMetric(tolerance),
    lowerBound: roundMetric(Math.max(naturalMinimum, mean - tolerance * 2)),
    upperBound: roundMetric(Math.min(naturalMaximum, mean + tolerance * 2)),
    historicalEvidence: selectEvidence(observations.map(({ sample }) => sample)),
  });
}

function selectTypicalQuotes(
  samples: readonly QualifiedDialogueSample[],
  historicalSentenceMean: number,
): readonly CharacterVoiceTypicalQuote[] {
  const sorted = [...samples].sort((left, right) => {
    if (left.typical !== right.typical) {
      return left.typical ? -1 : 1;
    }
    const leftDistance = Math.abs(averageSentenceCharacters(left.text) - historicalSentenceMean);
    const rightDistance = Math.abs(averageSentenceCharacters(right.text) - historicalSentenceMean);
    return leftDistance - rightDistance || left.id.localeCompare(right.id);
  });
  return Object.freeze(
    sorted.slice(0, MAXIMUM_TYPICAL_QUOTES).map((sample) =>
      Object.freeze({
        sampleId: sample.id,
        text: sample.text,
        addresseeCharacterId: sample.addresseeCharacterId,
        evidence: sample.evidence,
      }),
    ),
  );
}

function measureDialogue(
  text: string,
  catalog: CharacterVoiceFeatureCatalog,
  commonTerms: readonly string[],
): DialogueMetrics {
  const politeCount = countMarkers(text, catalog.politeMarkers);
  const casualCount = countMarkers(text, catalog.casualMarkers);
  const directCount = countMarkers(text, catalog.directMarkers);
  const indirectCount = countMarkers(text, catalog.indirectMarkers);
  const characterCount = countVisibleCharacters(text);
  return Object.freeze({
    averageSentenceCharacters: roundMetric(averageSentenceCharacters(text)),
    characterCount,
    commonTermRate: roundMetric(ratePerHundred(countMarkers(text, commonTerms), characterCount)),
    emotionMarkerRate: roundMetric(
      ratePerHundred(
        countMarkers(text, catalog.emotionMarkers) + countExpressivePunctuation(text),
        characterCount,
      ),
    ),
    politenessScore: contrastScore(politeCount, casualCount),
    politenessMarkerRate: roundMetric(ratePerHundred(politeCount + casualCount, characterCount)),
    directnessScore: contrastScore(directCount, indirectCount),
    directnessMarkerRate: roundMetric(ratePerHundred(directCount + indirectCount, characterCount)),
    metaphorMarkerRate: roundMetric(
      ratePerHundred(countMarkers(text, catalog.metaphorMarkers), characterCount),
    ),
    dialectMarkerRate: roundMetric(
      ratePerHundred(countMarkers(text, catalog.dialectMarkers), characterCount),
    ),
  });
}

function measureDialogueSamples(
  samples: readonly QualifiedDialogueSample[],
  catalog: CharacterVoiceFeatureCatalog,
  commonTerms: readonly string[],
): DialogueMetrics {
  const text = samples.map(({ text: sampleText }) => sampleText).join("\n");
  const combined = measureDialogue(text, catalog, commonTerms);
  const sentenceLengths = samples.flatMap(({ text: sampleText }) =>
    sentenceCharacterLengths(sampleText),
  );
  return Object.freeze({
    ...combined,
    averageSentenceCharacters: roundMetric(
      sentenceLengths.length === 0 ? 0 : sum(sentenceLengths) / sentenceLengths.length,
    ),
  });
}

function checkContrastStyle(
  context: IssueContext,
  category: "politeness" | "directness",
  style: CharacterVoiceContrastStyle | null,
  currentScore: number | null,
  currentMarkerRate: number,
  currentText: string,
  addresseeCharacterId: string | null,
): void {
  if (style === null) {
    context.skippedChecks.push(
      freezeSkipped("metric", null, addresseeCharacterId, "metric_not_observable"),
    );
    return;
  }
  const observed = findObservedMarkers(currentText, [
    ...style.positiveMarkers,
    ...style.negativeMarkers,
  ]);
  const expected = [...style.positiveMarkers, ...style.negativeMarkers];
  if (style.score !== null && currentScore !== null) {
    if (
      checkMetric(
        context,
        category,
        style.score,
        currentScore,
        observed,
        expected,
        addresseeCharacterId,
      )
    ) {
      return;
    }
  } else if (style.score !== null) {
    context.skippedChecks.push(
      freezeSkipped("metric", style.score.metricKey, addresseeCharacterId, "metric_not_observable"),
    );
  }
  checkMetric(
    context,
    category,
    style.markerRate,
    currentMarkerRate,
    observed,
    expected,
    addresseeCharacterId,
  );
}

function checkAddresseeVariants(context: IssueContext): void {
  for (const variant of context.profile.addresseeVariants) {
    const samples = context.currentSamples.filter(
      ({ addresseeCharacterId }) => addresseeCharacterId === variant.addresseeCharacterId,
    );
    const characterCount = sum(samples.map(({ characterCount: count }) => count));
    if (characterCount < MINIMUM_CURRENT_CHARACTERS) {
      continue;
    }
    const text = samples.map(({ text: sampleText }) => sampleText).join("\n");
    checkMetric(
      { ...context, currentSamples: samples },
      "address_habit",
      variant.addressTermRate,
      literalRate(text, variant.preferredAddressTerms),
      findObservedMarkers(text, variant.preferredAddressTerms),
      variant.preferredAddressTerms,
      variant.addresseeCharacterId,
      variant.historicalEvidence,
    );
    const measurements = measureDialogueSamples(samples, context.profile.featureCatalog, []);
    if (variant.politenessScore !== null && measurements.politenessScore !== null) {
      checkMetric(
        { ...context, currentSamples: samples },
        "addressee_voice",
        variant.politenessScore,
        measurements.politenessScore,
        findObservedMarkers(text, [
          ...context.profile.featureCatalog.politeMarkers,
          ...context.profile.featureCatalog.casualMarkers,
        ]),
        [
          ...context.profile.featureCatalog.politeMarkers,
          ...context.profile.featureCatalog.casualMarkers,
        ],
        variant.addresseeCharacterId,
        variant.historicalEvidence,
      );
    }
    if (variant.directnessScore !== null && measurements.directnessScore !== null) {
      checkMetric(
        { ...context, currentSamples: samples },
        "addressee_voice",
        variant.directnessScore,
        measurements.directnessScore,
        findObservedMarkers(text, [
          ...context.profile.featureCatalog.directMarkers,
          ...context.profile.featureCatalog.indirectMarkers,
        ]),
        [
          ...context.profile.featureCatalog.directMarkers,
          ...context.profile.featureCatalog.indirectMarkers,
        ],
        variant.addresseeCharacterId,
        variant.historicalEvidence,
      );
    }
  }
}

function checkMetric(
  context: IssueContext,
  category: CharacterVoiceDeviationCategory,
  band: CharacterVoiceMetricBand | null,
  currentValue: number,
  observedMarkers: readonly string[],
  expectedMarkers: readonly string[],
  addresseeCharacterId: string | null,
  historicalEvidenceOverride?: readonly CharacterVoiceTextEvidence[],
): boolean {
  if (band === null) {
    context.skippedChecks.push(
      freezeSkipped("metric", null, addresseeCharacterId, "metric_not_observable"),
    );
    return false;
  }
  if (currentValue >= band.lowerBound && currentValue <= band.upperBound) {
    return false;
  }
  const distance =
    currentValue < band.lowerBound
      ? band.lowerBound - currentValue
      : currentValue - band.upperBound;
  const normalizedDeviation = distance / band.tolerance;
  const severity: CharacterVoiceDeviationSeverity = normalizedDeviation > 2 ? "error" : "warning";
  const metric = Object.freeze({
    metricKey: band.metricKey,
    unit: band.unit,
    historicalMean: band.mean,
    expectedLowerBound: band.lowerBound,
    expectedUpperBound: band.upperBound,
    currentValue: roundMetric(currentValue),
    distanceOutsideExpectedRange: roundMetric(distance),
    normalizedDeviation: roundMetric(normalizedDeviation),
  });
  const suggestion = suggestionFor(category, band, currentValue, expectedMarkers);
  context.issues.push(
    Object.freeze({
      id: `${context.profile.id}:${category}:${addresseeCharacterId ?? "overall"}:${band.metricKey}`,
      detector: "deterministic_statistics",
      category,
      severity,
      characterId: context.profile.characterId,
      addresseeCharacterId,
      metric,
      observedMarkers: Object.freeze([...observedMarkers]),
      expectedMarkers: Object.freeze([...expectedMarkers]),
      explanation: explainDeviation(band, currentValue, addresseeCharacterId),
      currentDialogueEvidence: selectEvidence(context.currentSamples),
      historicalDialogueEvidence: Object.freeze(
        [...(historicalEvidenceOverride ?? band.historicalEvidence)].slice(
          0,
          MAXIMUM_ISSUE_EVIDENCE,
        ),
      ),
      suggestion,
    }),
  );
  return true;
}

function suggestionFor(
  category: CharacterVoiceDeviationCategory,
  band: CharacterVoiceMetricBand,
  currentValue: number,
  expectedMarkers: readonly string[],
): CharacterVoiceDeviationIssue["suggestion"] {
  const direction = currentValue > band.upperBound ? "reduce" : "increase";
  const actions: Record<CharacterVoiceDeviationCategory, readonly string[]> = {
    sentence_length:
      direction === "reduce"
        ? [
            "Split long sentences at natural pauses.",
            "Restore the character's usual concise rhythm.",
          ]
        : [
            "Combine adjacent fragments where meaning remains clear.",
            "Restore the character's usual sentence rhythm.",
          ],
    common_terms: [
      "Compare the passage with the cited historical dialogue.",
      `Review characteristic terms: ${expectedMarkers.join(", ") || "none configured"}.`,
    ],
    address_habit: [
      "Use the established form of address only where the speaker naturally addresses this person.",
      `Review established forms: ${expectedMarkers.join(", ") || "none observed"}.`,
    ],
    emotional_expression: [
      `${capitalize(direction)} explicit emotional markers and expressive punctuation.`,
      "Keep the scene meaning unchanged while matching the historical intensity.",
    ],
    politeness: [
      "Adjust literal polite or casual markers toward the cited historical balance.",
      "Do not change the character's intention solely to match the score.",
    ],
    directness: [
      "Adjust literal direct or indirect markers toward the cited historical balance.",
      "Preserve the dialogue's factual intent.",
    ],
    metaphor_usage: [
      `${capitalize(direction)} explicit metaphor markers.`,
      "Review imagery manually because semantic metaphor detection is unavailable.",
    ],
    dialect_usage: [
      `${capitalize(direction)} configured dialect markers.`,
      "Keep dialect readable and consistent with the cited historical lines.",
    ],
    addressee_voice: [
      "Compare how this character historically speaks to the same addressee.",
      "Adjust address, politeness, or directness without changing plot facts.",
    ],
  };
  return Object.freeze({
    summary: `Bring ${band.metricKey} back toward ${formatNumber(band.lowerBound)}–${formatNumber(band.upperBound)} ${band.unit}.`,
    actions: Object.freeze([...actions[category]]),
  });
}

function explainDeviation(
  band: CharacterVoiceMetricBand,
  currentValue: number,
  addresseeCharacterId: string | null,
): string {
  const scope =
    addresseeCharacterId === null ? "overall dialogue" : `dialogue to ${addresseeCharacterId}`;
  return `${scope} measured ${formatNumber(currentValue)} ${band.unit}; the evidence-backed historical range is ${formatNumber(band.lowerBound)}–${formatNumber(band.upperBound)} from ${String(band.sampleCount)} samples.`;
}

function finishResult(context: IssueContext): CharacterVoiceDeviationResult {
  return Object.freeze({
    issues: Object.freeze(context.issues.sort(compareIssues)),
    skippedChecks: Object.freeze(context.skippedChecks.sort(compareSkippedChecks)),
    capabilities: Object.freeze({
      deterministicStatisticalReview: "ready",
      ambiguousSemanticReview: "separate_read_only_ai_review",
      modelInvocation: "not_used",
    }),
  });
}

function freezeProfile(
  input: Readonly<{
    id: string;
    projectId: string;
    branchId: string;
    characterId: string;
    featureCatalog: CharacterVoiceFeatureCatalog;
    evidenceReadiness: CharacterVoiceEvidenceReadiness;
    commonTerms: readonly CharacterVoiceCommonTerm[];
    sentenceLength: CharacterVoiceMetricBand | null;
    commonTermRate: CharacterVoiceMetricBand | null;
    emotionalExpression: CharacterVoiceLiteralStyle | null;
    politeness: CharacterVoiceContrastStyle | null;
    directness: CharacterVoiceContrastStyle | null;
    metaphorUsage: CharacterVoiceLiteralStyle | null;
    dialectUsage: CharacterVoiceLiteralStyle | null;
    typicalQuotes: readonly CharacterVoiceTypicalQuote[];
    addresseeVariants: readonly CharacterVoiceAddresseeVariant[];
  }>,
): CharacterVoiceProfile {
  return Object.freeze({
    kind: "evidence_backed_character_voice_profile",
    id: input.id,
    projectId: input.projectId,
    branchId: input.branchId,
    characterId: input.characterId,
    evidenceReadiness: input.evidenceReadiness,
    featureCatalog: input.featureCatalog,
    commonTerms: Object.freeze([...input.commonTerms]),
    sentenceLength: input.sentenceLength,
    commonTermRate: input.commonTermRate,
    emotionalExpression: input.emotionalExpression,
    politeness: input.politeness,
    directness: input.directness,
    metaphorUsage: input.metaphorUsage,
    dialectUsage: input.dialectUsage,
    typicalQuotes: Object.freeze([...input.typicalQuotes]),
    addresseeVariants: Object.freeze([...input.addresseeVariants]),
  });
}

function isVoiceProfile(value: unknown): value is CharacterVoiceProfile {
  return (
    isRecord(value) &&
    value.kind === "evidence_backed_character_voice_profile" &&
    isSafeReference(value.id) &&
    isSafeReference(value.projectId) &&
    isSafeReference(value.branchId) &&
    isSafeReference(value.characterId) &&
    isRecord(value.evidenceReadiness) &&
    (value.evidenceReadiness.status === "ready" ||
      value.evidenceReadiness.status === "insufficient_evidence") &&
    isRecord(value.featureCatalog) &&
    Array.isArray(value.commonTerms) &&
    Array.isArray(value.typicalQuotes) &&
    Array.isArray(value.addresseeVariants)
  );
}

function selectEvidence(
  samples: readonly QualifiedDialogueSample[],
): readonly CharacterVoiceTextEvidence[] {
  const evidence = new Map<string, CharacterVoiceTextEvidence>();
  for (const sample of [...samples].sort((left, right) => left.id.localeCompare(right.id))) {
    evidence.set(sample.evidence.id, sample.evidence);
    if (evidence.size >= MAXIMUM_ISSUE_EVIDENCE) {
      break;
    }
  }
  return Object.freeze([...evidence.values()]);
}

function averageSentenceCharacters(text: string): number {
  const sentences = sentenceCharacterLengths(text);
  return sentences.length === 0 ? countVisibleCharacters(text) : sum(sentences) / sentences.length;
}

function sentenceCharacterLengths(text: string): readonly number[] {
  return text
    .split(SENTENCE_BOUNDARY_PATTERN)
    .map((sentence) => countVisibleCharacters(sentence))
    .filter((length) => length > 0);
}

function literalRate(text: string, markers: readonly string[]): number {
  return roundMetric(ratePerHundred(countMarkers(text, markers), countVisibleCharacters(text)));
}

function ratePerHundred(count: number, characterCount: number): number {
  return characterCount === 0 ? 0 : (count * 100) / characterCount;
}

function contrastScore(positiveCount: number, negativeCount: number): number | null {
  const total = positiveCount + negativeCount;
  return total === 0 ? null : roundMetric((positiveCount - negativeCount) / total);
}

function countMarkers(text: string, markers: readonly string[]): number {
  return sum(markers.map((marker) => countLiteralOccurrences(text, marker)));
}

function countExpressivePunctuation(text: string): number {
  return text.match(EXPRESSIVE_PUNCTUATION_PATTERN)?.length ?? 0;
}

function countLiteralOccurrences(text: string, marker: string): number {
  const haystack = normalizeForMatching(text);
  const needle = normalizeForMatching(marker);
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) {
      break;
    }
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function findObservedMarkers(text: string, markers: readonly string[]): readonly string[] {
  return Object.freeze(
    markers.filter((marker, index) => {
      const normalized = normalizeForMatching(marker);
      return (
        countLiteralOccurrences(text, marker) > 0 &&
        markers.findIndex((candidate) => normalizeForMatching(candidate) === normalized) === index
      );
    }),
  );
}

function countVisibleCharacters(text: string): number {
  return Array.from(text.normalize("NFC")).filter((character) => !/\s/u.test(character)).length;
}

function freezeSkipped(
  scope: CharacterVoiceSkippedCheck["scope"],
  metricKey: CharacterVoiceMetricKey | null,
  addresseeCharacterId: string | null,
  reason: CharacterVoiceSkippedReason,
): CharacterVoiceSkippedCheck {
  return Object.freeze({ scope, metricKey, addresseeCharacterId, reason });
}

function compareIssues(
  left: CharacterVoiceDeviationIssue,
  right: CharacterVoiceDeviationIssue,
): number {
  return (
    left.category.localeCompare(right.category) ||
    (left.addresseeCharacterId ?? "").localeCompare(right.addresseeCharacterId ?? "") ||
    left.metric.metricKey.localeCompare(right.metric.metricKey)
  );
}

function compareSkippedChecks(
  left: CharacterVoiceSkippedCheck,
  right: CharacterVoiceSkippedCheck,
): number {
  return (
    left.scope.localeCompare(right.scope) ||
    (left.metricKey ?? "").localeCompare(right.metricKey ?? "") ||
    (left.addresseeCharacterId ?? "").localeCompare(right.addresseeCharacterId ?? "") ||
    left.reason.localeCompare(right.reason)
  );
}

function compareAddressTerms(
  left: CharacterVoiceAddressTerms,
  right: CharacterVoiceAddressTerms,
): number {
  return left.addresseeCharacterId.localeCompare(right.addresseeCharacterId);
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatNumber(value: number): string {
  return roundMetric(value).toFixed(2);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normalizeForMatching(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isBoundedText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isSafeReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_REFERENCE_CHARACTERS &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function isNullableSafeReference(value: unknown): value is string | null {
  return value === null || isSafeReference(value);
}

function invalidInput(message: string): CharacterVoiceInputError {
  return new CharacterVoiceInputError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
