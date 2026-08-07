export const NARRATIVE_ANALYSIS_COVERAGE_AREAS = [
  "plotline_characters",
  "plotline_dependencies",
  "plotline_progress",
  "convergence_plans",
  "character_presence",
  "foreshadow_progress",
  "scene_metrics",
] as const;

export type NarrativeAnalysisCoverageArea = (typeof NARRATIVE_ANALYSIS_COVERAGE_AREAS)[number];

export const NARRATIVE_EVIDENCE_SOURCE_KINDS = [
  "chapter",
  "chapter_version",
  "story_fact",
  "causal_event",
  "outline",
  "timeline",
  "scene_metric",
  "foreshadow",
  "import",
] as const;

export type NarrativeEvidenceSourceKind = (typeof NARRATIVE_EVIDENCE_SOURCE_KINDS)[number];

export interface NarrativeEvidenceReference {
  readonly sourceKind: NarrativeEvidenceSourceKind;
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly contentHash: string;
  readonly locator: string;
  readonly excerpt: string;
  /** Exact JavaScript UTF-16 offsets into the immutable source version. */
  readonly startOffset: number;
  readonly endOffset: number;
  readonly sourceLength: number;
}

export interface NarrativeSupportedValue<Value> {
  readonly value: Value;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativeCoverageAssertion {
  /** `false` makes completeness-dependent checks return `skipped`. */
  readonly complete: boolean;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export type NarrativeAnalysisCoverage = Readonly<
  Record<NarrativeAnalysisCoverageArea, NarrativeCoverageAssertion>
>;

export interface NarrativeAnalysisPolicy {
  readonly plotlineStaleAfterChapters: number;
  readonly foreshadowStaleAfterChapters: number;
  readonly upcomingConvergenceWithinChapters: number;
  readonly repeatedFunctionLookbackChapters: number;
  readonly minimumRepeatedFunctionOccurrences: number;
  readonly buildupLookbackChapters: number;
  readonly pacingSimilarityTolerance: number;
  readonly minimumSimilarPacingChapters: number;
  readonly tensionFlatTolerance: number;
}

export interface NarrativeChapterFact {
  readonly id: string;
  readonly order: number;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativePlotline {
  readonly id: string;
  readonly goal: NarrativeSupportedValue<string> | null;
}

export interface NarrativePlotlineCharacter {
  readonly id: string;
  readonly plotlineId: string;
  readonly characterId: string;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export type NarrativeDependencyStatus = "pending" | "satisfied" | "blocked";

export interface NarrativePlotlineDependency {
  readonly id: string;
  readonly fromPlotlineId: string;
  readonly toPlotlineId: string;
  readonly status: NarrativeDependencyStatus;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativePlotlineProgress {
  readonly id: string;
  readonly plotlineId: string;
  readonly chapterId: string;
  /** Explicit order inside the chapter; identifiers are never narrative order. */
  readonly sequence: number;
  readonly eventId: string;
  readonly summary: string;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export type NarrativeConvergenceStatus = "planned" | "reached" | "cancelled";

export interface NarrativeConvergencePlan {
  readonly id: string;
  readonly plotlineIds: readonly string[];
  readonly targetChapterOrder: number;
  readonly status: NarrativeConvergenceStatus;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativeStoryTimeRange {
  /** Inclusive structured story-time coordinates. */
  readonly start: number;
  readonly end: number;
}

export interface NarrativeCharacterPresence {
  readonly id: string;
  readonly characterId: string;
  readonly plotlineId: string;
  readonly chapterId: string;
  readonly storyTime: NarrativeStoryTimeRange;
  readonly locationId: string;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativeForeshadow {
  readonly id: string;
}

export type NarrativeForeshadowProgressKind =
  "planted" | "advanced" | "revealed" | "resolved" | "misdirected";

export interface NarrativeForeshadowProgress {
  readonly id: string;
  readonly foreshadowId: string;
  readonly chapterId: string;
  /** Explicit order inside the chapter; identifiers are never narrative order. */
  readonly sequence: number;
  readonly kind: NarrativeForeshadowProgressKind;
  readonly description: string;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativeTensionMeasurement {
  readonly start: number;
  readonly end: number;
  readonly peak: number;
}

export interface NarrativeCompositionMeasurement {
  readonly informationRatio: number;
  readonly dialogueRatio: number;
  readonly descriptionRatio: number;
  readonly innerActivityRatio: number;
  /** Number of explicitly classified source units used as the aggregation weight. */
  readonly measuredUnits: number;
}

export interface NarrativePlotAdvancementMeasurement {
  readonly advances: boolean;
  readonly plotlineIds: readonly string[];
}

export interface NarrativeCharacterChangeMeasurement {
  readonly changes: boolean;
  readonly characterIds: readonly string[];
}

export interface NarrativeClimaxMeasurement {
  readonly isClimax: boolean;
  /** Explicit setup contracts, not inferred themes. */
  readonly requiredSetupBeatIds: readonly string[];
}

export interface NarrativeSceneMetrics {
  readonly id: string;
  readonly chapterId: string;
  readonly sequence: number;
  readonly evidence: readonly NarrativeEvidenceReference[];
  readonly goal: NarrativeSupportedValue<string> | null;
  readonly conflictIntensity: NarrativeSupportedValue<number> | null;
  readonly tension: NarrativeSupportedValue<NarrativeTensionMeasurement> | null;
  readonly composition: NarrativeSupportedValue<NarrativeCompositionMeasurement> | null;
  readonly plotAdvancement: NarrativeSupportedValue<NarrativePlotAdvancementMeasurement> | null;
  readonly characterChange: NarrativeSupportedValue<NarrativeCharacterChangeMeasurement> | null;
  readonly functionTags: NarrativeSupportedValue<readonly string[]> | null;
  readonly setupBeatIds: NarrativeSupportedValue<readonly string[]> | null;
  readonly climax: NarrativeSupportedValue<NarrativeClimaxMeasurement> | null;
}

export interface NarrativeAnalysisInput {
  readonly projectId: string;
  readonly branchId: string;
  readonly analysisChapterId: string;
  readonly policy: NarrativeAnalysisPolicy;
  readonly coverage: NarrativeAnalysisCoverage;
  readonly chapters: readonly NarrativeChapterFact[];
  readonly plotlines: readonly NarrativePlotline[];
  readonly plotlineCharacters: readonly NarrativePlotlineCharacter[];
  readonly plotlineDependencies: readonly NarrativePlotlineDependency[];
  readonly plotlineProgress: readonly NarrativePlotlineProgress[];
  readonly convergencePlans: readonly NarrativeConvergencePlan[];
  readonly characterPresences: readonly NarrativeCharacterPresence[];
  readonly foreshadows: readonly NarrativeForeshadow[];
  readonly foreshadowProgress: readonly NarrativeForeshadowProgress[];
  readonly scenes: readonly NarrativeSceneMetrics[];
}

export const NARRATIVE_ANALYSIS_SKIP_REASONS = [
  "coverage_incomplete",
  "coverage_missing_evidence",
  "structured_value_missing",
  "source_evidence_missing",
  "analysis_chapter_missing_evidence",
  "chapter_evidence_missing",
  "scene_metrics_incomplete",
  "insufficient_consecutive_chapters",
] as const;

export type NarrativeAnalysisSkipReason = (typeof NARRATIVE_ANALYSIS_SKIP_REASONS)[number];

export interface NarrativeAnalyzedField<Value> {
  readonly status: "analyzed";
  readonly value: Value;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativeSkippedField {
  readonly status: "skipped";
  readonly reason: NarrativeAnalysisSkipReason;
}

export type NarrativeAnalysisField<Value> = NarrativeAnalyzedField<Value> | NarrativeSkippedField;

export interface NarrativeSkippedCheck {
  readonly scope: "plotline" | "foreshadow" | "scene" | "chapter" | "global";
  readonly scopeId: string;
  readonly check: string;
  readonly reason: NarrativeAnalysisSkipReason;
}

export interface NarrativePlotlineStagnation {
  readonly state: "active" | "stagnant" | "not_started";
  readonly chaptersSinceProgress: number | null;
  readonly threshold: number;
}

export interface NarrativePlotlineAnalysis {
  readonly plotlineId: string;
  readonly goal: NarrativeAnalysisField<string>;
  readonly characterIds: NarrativeAnalysisField<readonly string[]>;
  readonly dependencies: NarrativeAnalysisField<readonly NarrativePlotlineDependency[]>;
  readonly latestProgress: NarrativeAnalysisField<NarrativePlotlineProgress | null>;
  readonly stagnation: NarrativeAnalysisField<NarrativePlotlineStagnation>;
  readonly upcomingConvergences: NarrativeAnalysisField<readonly NarrativeConvergencePlan[]>;
}

export type NarrativeForeshadowState = "not_started" | "active" | "revealed" | "resolved";

export interface NarrativeForeshadowSequenceIssue {
  readonly kind: "missing_plant" | "duplicate_plant" | "progress_after_resolution";
  readonly progressId: string;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativeForeshadowAnalysisValue {
  readonly state: NarrativeForeshadowState;
  readonly latestProgress: NarrativeForeshadowProgress | null;
  readonly chaptersSinceProgress: number | null;
  readonly stagnant: boolean;
  readonly threshold: number;
  readonly history: readonly NarrativeForeshadowProgress[];
  readonly sequenceIssues: readonly NarrativeForeshadowSequenceIssue[];
}

export interface NarrativeForeshadowAnalysis {
  readonly foreshadowId: string;
  readonly progress: NarrativeAnalysisField<NarrativeForeshadowAnalysisValue>;
}

export type NarrativeTensionTrend = "rising" | "falling" | "flat";

export interface NarrativeTensionAnalysis extends NarrativeTensionMeasurement {
  readonly change: number;
  readonly trend: NarrativeTensionTrend;
  readonly flatTolerance: number;
}

export interface NarrativeSceneAnalysis {
  readonly sceneId: string;
  readonly chapterId: string;
  readonly sequence: number;
  readonly goal: NarrativeAnalysisField<string>;
  readonly conflictIntensity: NarrativeAnalysisField<number>;
  readonly tension: NarrativeAnalysisField<NarrativeTensionAnalysis>;
  readonly composition: NarrativeAnalysisField<NarrativeCompositionMeasurement>;
  readonly plotAdvancement: NarrativeAnalysisField<NarrativePlotAdvancementMeasurement>;
  readonly characterChange: NarrativeAnalysisField<NarrativeCharacterChangeMeasurement>;
}

export interface NarrativeChapterConflictAnalysis {
  readonly weightedMean: number;
  readonly measuredUnits: number;
  readonly contributingSceneIds: readonly string[];
}

export interface NarrativeChapterTensionAnalysis {
  readonly start: number;
  readonly end: number;
  readonly peak: number;
  readonly change: number;
  readonly trend: NarrativeTensionTrend;
  readonly flatTolerance: number;
}

export interface NarrativeChapterAnalysis {
  readonly chapterId: string;
  readonly order: number;
  readonly sceneIds: readonly string[];
  readonly conflict: NarrativeAnalysisField<NarrativeChapterConflictAnalysis>;
  readonly tension: NarrativeAnalysisField<NarrativeChapterTensionAnalysis>;
  readonly composition: NarrativeAnalysisField<NarrativeCompositionMeasurement>;
  readonly advancesPlot: NarrativeAnalysisField<NarrativePlotAdvancementMeasurement>;
  readonly changesCharacters: NarrativeAnalysisField<NarrativeCharacterChangeMeasurement>;
}

export interface NarrativeTimeLocationConflict {
  readonly id: string;
  readonly characterId: string;
  readonly plotlineIds: readonly [string, string];
  readonly presenceIds: readonly [string, string];
  readonly locationIds: readonly [string, string];
  readonly overlappingStoryTime: NarrativeStoryTimeRange;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativeRepeatedFunctionFinding {
  readonly functionTags: readonly string[];
  readonly sceneIds: readonly string[];
  readonly chapterIds: readonly string[];
  readonly occurrenceCount: number;
  readonly lookbackChapters: number;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativeBuildupCheck {
  readonly climaxSceneId: string;
  readonly status: "satisfied" | "missing_required_setup";
  readonly foundSetupBeatIds: readonly string[];
  readonly missingSetupBeatIds: readonly string[];
  readonly lookbackChapters: number;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export interface NarrativePacingDelta {
  readonly fromChapterId: string;
  readonly toChapterId: string;
  readonly conflictIntensity: number;
  readonly tensionStart: number;
  readonly tensionEnd: number;
  readonly tensionPeak: number;
  readonly informationRatio: number;
  readonly dialogueRatio: number;
  readonly descriptionRatio: number;
  readonly innerActivityRatio: number;
}

export interface NarrativeSimilarPacingRun {
  readonly chapterIds: readonly string[];
  readonly deltas: readonly NarrativePacingDelta[];
  readonly tolerance: number;
  readonly evidence: readonly NarrativeEvidenceReference[];
}

export type NarrativeQualityFinding =
  | Readonly<{
      kind: "scene_changes_neither_plot_nor_character";
      sceneId: string;
      evidence: readonly NarrativeEvidenceReference[];
    }>
  | Readonly<{
      kind: "repeated_scene_function";
      sceneIds: readonly string[];
      evidence: readonly NarrativeEvidenceReference[];
    }>
  | Readonly<{
      kind: "climax_missing_required_setup";
      sceneId: string;
      missingSetupBeatIds: readonly string[];
      evidence: readonly NarrativeEvidenceReference[];
    }>
  | Readonly<{
      kind: "consecutive_chapters_have_similar_pacing";
      chapterIds: readonly string[];
      evidence: readonly NarrativeEvidenceReference[];
    }>;

export interface NarrativeAnalysisResult {
  readonly plotlines: readonly NarrativePlotlineAnalysis[];
  readonly foreshadows: readonly NarrativeForeshadowAnalysis[];
  readonly scenes: readonly NarrativeSceneAnalysis[];
  readonly chapters: readonly NarrativeChapterAnalysis[];
  readonly timeLocationConflicts: NarrativeAnalysisField<readonly NarrativeTimeLocationConflict[]>;
  readonly repeatedFunctions: NarrativeAnalysisField<readonly NarrativeRepeatedFunctionFinding[]>;
  readonly buildupChecks: NarrativeAnalysisField<readonly NarrativeBuildupCheck[]>;
  readonly similarPacingRuns: NarrativeAnalysisField<readonly NarrativeSimilarPacingRun[]>;
  readonly qualityFindings: readonly NarrativeQualityFinding[];
  readonly skippedChecks: readonly NarrativeSkippedCheck[];
  readonly capabilities: Readonly<{
    deterministicNarrativeCoordination: "ready";
    deterministicPacingAnalysis: "ready";
    semanticQualityJudgement: "separate_read_only_ai_review";
  }>;
}

export type NarrativeAnalysisInputErrorCode = "NARRATIVE_ANALYSIS_INPUT_INVALID";

export class NarrativeAnalysisInputError extends Error {
  public readonly code: NarrativeAnalysisInputErrorCode = "NARRATIVE_ANALYSIS_INPUT_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "NarrativeAnalysisInputError";
  }
}

const MAXIMUM_RECORDS = 16_384;
const MAXIMUM_EVIDENCE = 32;
const MAXIMUM_TEXT = 200_000;
const MAXIMUM_REFERENCE = 2_000;
const MAXIMUM_SOURCE_LENGTH = 5_000_000;
const MAXIMUM_ORDER = 1_000_000_000_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const RATIO_TOLERANCE = 1e-6;

interface ValidatedInput extends NarrativeAnalysisInput {
  readonly chaptersById: ReadonlyMap<string, NarrativeChapterFact>;
  readonly plotlineIds: ReadonlySet<string>;
  readonly foreshadowIds: ReadonlySet<string>;
  readonly analysisChapter: NarrativeChapterFact;
}

interface AnalysisContext {
  readonly skipped: NarrativeSkippedCheck[];
  readonly input: ValidatedInput;
}

export function analyzeNovelNarrative(inputValue: NarrativeAnalysisInput): NarrativeAnalysisResult {
  const input = validateInput(inputValue);
  const context: AnalysisContext = { input, skipped: [] };
  const sceneAnalyses = analyzeScenes(context);
  const chapterAnalyses = analyzeChapters(context, sceneAnalyses);
  const timeLocationConflicts = analyzeTimeLocationConflicts(context);
  const repeatedFunctions = analyzeRepeatedFunctions(context);
  const buildupChecks = analyzeBuildup(context);
  const similarPacingRuns = analyzeSimilarPacing(context, chapterAnalyses);
  const qualityFindings = collectQualityFindings(
    sceneAnalyses,
    repeatedFunctions,
    buildupChecks,
    similarPacingRuns,
  );

  return Object.freeze({
    plotlines: Object.freeze(
      [...input.plotlines]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((plotline) => analyzePlotline(context, plotline)),
    ),
    foreshadows: Object.freeze(
      [...input.foreshadows]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((foreshadow) => analyzeForeshadow(context, foreshadow)),
    ),
    scenes: sceneAnalyses,
    chapters: chapterAnalyses,
    timeLocationConflicts,
    repeatedFunctions,
    buildupChecks,
    similarPacingRuns,
    qualityFindings,
    skippedChecks: Object.freeze([...context.skipped].sort(compareSkipped)),
    capabilities: Object.freeze({
      deterministicNarrativeCoordination: "ready",
      deterministicPacingAnalysis: "ready",
      semanticQualityJudgement: "separate_read_only_ai_review",
    }),
  });
}

function analyzePlotline(
  context: AnalysisContext,
  plotline: NarrativePlotline,
): NarrativePlotlineAnalysis {
  const { input } = context;
  const characters = input.plotlineCharacters.filter(
    ({ plotlineId }) => plotlineId === plotline.id,
  );
  const dependencies = input.plotlineDependencies.filter(
    ({ fromPlotlineId }) => fromPlotlineId === plotline.id,
  );
  const progress = input.plotlineProgress
    .filter(({ plotlineId }) => plotlineId === plotline.id)
    .sort((left, right) => compareChapterBound(left, right, input.chaptersById));
  const latest = progress.at(-1);
  const convergence = input.convergencePlans
    .filter(
      (plan) =>
        plan.plotlineIds.includes(plotline.id) &&
        plan.status === "planned" &&
        plan.targetChapterOrder >= input.analysisChapter.order &&
        plan.targetChapterOrder <=
          input.analysisChapter.order + input.policy.upcomingConvergenceWithinChapters,
    )
    .sort(
      (left, right) =>
        left.targetChapterOrder - right.targetChapterOrder || left.id.localeCompare(right.id),
    );

  const goal = supportedField(
    context,
    "plotline",
    plotline.id,
    "goal",
    plotline.goal,
    (value) => value,
  );
  const characterIds = coveredCollectionField(
    context,
    "plotline",
    plotline.id,
    "characters",
    "plotline_characters",
    characters,
    (item) => item.evidence,
    () => Object.freeze([...new Set(characters.map(({ characterId }) => characterId))].sort()),
  );
  const dependencyField = coveredCollectionField(
    context,
    "plotline",
    plotline.id,
    "dependencies",
    "plotline_dependencies",
    dependencies,
    (item) => item.evidence,
    () => Object.freeze(dependencies.map(copyDependency).sort(compareDependencies)),
  );
  const latestProgress = coveredCollectionField(
    context,
    "plotline",
    plotline.id,
    "latest_progress",
    "plotline_progress",
    progress,
    (item) => item.evidence,
    () => (latest === undefined ? null : copyProgress(latest)),
  );
  const stagnation = analyzePlotlineStagnation(context, plotline.id, progress);
  const upcomingConvergences = coveredCollectionField(
    context,
    "plotline",
    plotline.id,
    "upcoming_convergences",
    "convergence_plans",
    input.convergencePlans.filter((plan) => plan.plotlineIds.includes(plotline.id)),
    (item) => item.evidence,
    () => Object.freeze(convergence.map(copyConvergence)),
  );

  return Object.freeze({
    plotlineId: plotline.id,
    goal,
    characterIds,
    dependencies: dependencyField,
    latestProgress,
    stagnation,
    upcomingConvergences,
  });
}

function analyzePlotlineStagnation(
  context: AnalysisContext,
  plotlineId: string,
  progress: readonly NarrativePlotlineProgress[],
): NarrativeAnalysisField<NarrativePlotlineStagnation> {
  const readiness = coverageReadiness(context.input, "plotline_progress");
  if (readiness !== null) {
    return skip(context, "plotline", plotlineId, "stagnation", readiness);
  }
  if (context.input.analysisChapter.evidence.length === 0) {
    return skip(context, "plotline", plotlineId, "stagnation", "analysis_chapter_missing_evidence");
  }
  if (progress.some(({ evidence }) => evidence.length === 0)) {
    return skip(context, "plotline", plotlineId, "stagnation", "source_evidence_missing");
  }
  const latest = progress.at(-1);
  const chaptersSinceProgress =
    latest === undefined
      ? null
      : context.input.analysisChapter.order - requireChapter(context.input, latest.chapterId).order;
  const state =
    chaptersSinceProgress === null
      ? "not_started"
      : chaptersSinceProgress >= context.input.policy.plotlineStaleAfterChapters
        ? "stagnant"
        : "active";
  return analyzed(
    Object.freeze({
      state,
      chaptersSinceProgress,
      threshold: context.input.policy.plotlineStaleAfterChapters,
    }),
    mergeEvidence(
      context.input.coverage.plotline_progress.evidence,
      context.input.analysisChapter.evidence,
      latest?.evidence ?? [],
    ),
  );
}

function analyzeForeshadow(
  context: AnalysisContext,
  foreshadow: NarrativeForeshadow,
): NarrativeForeshadowAnalysis {
  const readiness = coverageReadiness(context.input, "foreshadow_progress");
  if (readiness !== null) {
    return Object.freeze({
      foreshadowId: foreshadow.id,
      progress: skip(context, "foreshadow", foreshadow.id, "progress", readiness),
    });
  }
  const history = context.input.foreshadowProgress
    .filter(({ foreshadowId }) => foreshadowId === foreshadow.id)
    .sort((left, right) => compareChapterBound(left, right, context.input.chaptersById));
  if (history.some(({ evidence }) => evidence.length === 0)) {
    return Object.freeze({
      foreshadowId: foreshadow.id,
      progress: skip(context, "foreshadow", foreshadow.id, "progress", "source_evidence_missing"),
    });
  }
  if (context.input.analysisChapter.evidence.length === 0) {
    return Object.freeze({
      foreshadowId: foreshadow.id,
      progress: skip(
        context,
        "foreshadow",
        foreshadow.id,
        "progress",
        "analysis_chapter_missing_evidence",
      ),
    });
  }
  const latest = history.at(-1);
  const state = foreshadowState(history);
  const chaptersSinceProgress =
    latest === undefined
      ? null
      : context.input.analysisChapter.order - requireChapter(context.input, latest.chapterId).order;
  const stagnant =
    (state === "active" || state === "revealed") &&
    chaptersSinceProgress !== null &&
    chaptersSinceProgress >= context.input.policy.foreshadowStaleAfterChapters;
  const sequenceIssues = analyzeForeshadowSequence(history);
  return Object.freeze({
    foreshadowId: foreshadow.id,
    progress: analyzed(
      Object.freeze({
        state,
        latestProgress: latest === undefined ? null : copyForeshadowProgress(latest),
        chaptersSinceProgress,
        stagnant,
        threshold: context.input.policy.foreshadowStaleAfterChapters,
        history: Object.freeze(history.map(copyForeshadowProgress)),
        sequenceIssues,
      }),
      mergeEvidence(
        context.input.coverage.foreshadow_progress.evidence,
        context.input.analysisChapter.evidence,
        ...history.map(({ evidence }) => evidence),
      ),
    ),
  });
}

function analyzeForeshadowSequence(
  history: readonly NarrativeForeshadowProgress[],
): readonly NarrativeForeshadowSequenceIssue[] {
  const issues: NarrativeForeshadowSequenceIssue[] = [];
  let planted = false;
  let resolved = false;
  for (const progress of history) {
    if (!planted && progress.kind !== "planted") {
      issues.push(
        Object.freeze({
          kind: "missing_plant",
          progressId: progress.id,
          evidence: freezeEvidence(progress.evidence),
        }),
      );
    }
    if (planted && progress.kind === "planted") {
      issues.push(
        Object.freeze({
          kind: "duplicate_plant",
          progressId: progress.id,
          evidence: freezeEvidence(progress.evidence),
        }),
      );
    }
    if (resolved) {
      issues.push(
        Object.freeze({
          kind: "progress_after_resolution",
          progressId: progress.id,
          evidence: freezeEvidence(progress.evidence),
        }),
      );
    }
    planted ||= progress.kind === "planted";
    resolved ||= progress.kind === "resolved";
  }
  return Object.freeze(issues);
}

function analyzeScenes(context: AnalysisContext): readonly NarrativeSceneAnalysis[] {
  return Object.freeze(
    [...context.input.scenes].sort(compareScenes(context.input.chaptersById)).map((scene) => {
      const chapterEvidence = requireChapter(context.input, scene.chapterId).evidence;
      const baseEvidence = mergeEvidence(scene.evidence, chapterEvidence);
      const baseEvidenceMissing = scene.evidence.length === 0 || chapterEvidence.length === 0;
      return Object.freeze({
        sceneId: scene.id,
        chapterId: scene.chapterId,
        sequence: scene.sequence,
        goal: supportedField(
          context,
          "scene",
          scene.id,
          "goal",
          scene.goal,
          (value) => value,
          baseEvidence,
          baseEvidenceMissing,
        ),
        conflictIntensity: supportedField(
          context,
          "scene",
          scene.id,
          "conflict_intensity",
          scene.conflictIntensity,
          (value) => value,
          baseEvidence,
          baseEvidenceMissing,
        ),
        tension: supportedField(
          context,
          "scene",
          scene.id,
          "tension",
          scene.tension,
          (value) => tensionAnalysis(value, context.input.policy.tensionFlatTolerance),
          baseEvidence,
          baseEvidenceMissing,
        ),
        composition: supportedField(
          context,
          "scene",
          scene.id,
          "composition",
          scene.composition,
          copyComposition,
          baseEvidence,
          baseEvidenceMissing,
        ),
        plotAdvancement: supportedField(
          context,
          "scene",
          scene.id,
          "plot_advancement",
          scene.plotAdvancement,
          copyPlotAdvancement,
          baseEvidence,
          baseEvidenceMissing,
        ),
        characterChange: supportedField(
          context,
          "scene",
          scene.id,
          "character_change",
          scene.characterChange,
          copyCharacterChange,
          baseEvidence,
          baseEvidenceMissing,
        ),
      });
    }),
  );
}

function analyzeChapters(
  context: AnalysisContext,
  scenes: readonly NarrativeSceneAnalysis[],
): readonly NarrativeChapterAnalysis[] {
  const sourceById = new Map(context.input.scenes.map((scene) => [scene.id, scene]));
  return Object.freeze(
    [...context.input.chapters]
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
      .map((chapter) => {
        const chapterScenes = scenes.filter(({ chapterId }) => chapterId === chapter.id);
        const sourceScenes = chapterScenes.map(({ sceneId }) => {
          const source = sourceById.get(sceneId);
          if (source === undefined) {
            throw invalidInput("A scene analysis lost its structured source metrics.");
          }
          return source;
        });
        return Object.freeze({
          chapterId: chapter.id,
          order: chapter.order,
          sceneIds: Object.freeze(chapterScenes.map(({ sceneId }) => sceneId)),
          conflict: aggregateChapterConflict(context, chapter, sourceScenes),
          tension: aggregateChapterTension(context, chapter, sourceScenes),
          composition: aggregateChapterComposition(context, chapter, sourceScenes),
          advancesPlot: aggregateChapterPlotAdvancement(context, chapter, sourceScenes),
          changesCharacters: aggregateChapterCharacterChanges(context, chapter, sourceScenes),
        });
      }),
  );
}

function aggregateChapterConflict(
  context: AnalysisContext,
  chapter: NarrativeChapterFact,
  scenes: readonly NarrativeSceneMetrics[],
): NarrativeAnalysisField<NarrativeChapterConflictAnalysis> {
  const readiness = chapterMetricReadiness(context, chapter, scenes, [
    "conflictIntensity",
    "composition",
  ]);
  if (readiness !== null) {
    return skip(context, "chapter", chapter.id, "conflict", readiness);
  }
  const measuredUnits = scenes.reduce(
    (total, scene) => total + requireSupported(scene.composition).value.measuredUnits,
    0,
  );
  const weightedMean =
    scenes.reduce(
      (total, scene) =>
        total +
        requireSupported(scene.conflictIntensity).value *
          requireSupported(scene.composition).value.measuredUnits,
      0,
    ) / measuredUnits;
  return analyzed(
    Object.freeze({
      weightedMean,
      measuredUnits,
      contributingSceneIds: Object.freeze(scenes.map(({ id }) => id)),
    }),
    chapterMetricEvidence(chapter, scenes, ["conflictIntensity", "composition"]),
  );
}

function aggregateChapterTension(
  context: AnalysisContext,
  chapter: NarrativeChapterFact,
  scenes: readonly NarrativeSceneMetrics[],
): NarrativeAnalysisField<NarrativeChapterTensionAnalysis> {
  const readiness = chapterMetricReadiness(context, chapter, scenes, ["tension"]);
  if (readiness !== null) {
    return skip(context, "chapter", chapter.id, "tension", readiness);
  }
  const first = requireSupported(scenes[0]?.tension ?? null).value;
  const last = requireSupported(scenes.at(-1)?.tension ?? null).value;
  const peak = Math.max(...scenes.map((scene) => requireSupported(scene.tension).value.peak));
  const analysis = tensionAnalysis(
    { start: first.start, end: last.end, peak },
    context.input.policy.tensionFlatTolerance,
  );
  return analyzed(analysis, chapterMetricEvidence(chapter, scenes, ["tension"]));
}

function aggregateChapterComposition(
  context: AnalysisContext,
  chapter: NarrativeChapterFact,
  scenes: readonly NarrativeSceneMetrics[],
): NarrativeAnalysisField<NarrativeCompositionMeasurement> {
  const readiness = chapterMetricReadiness(context, chapter, scenes, ["composition"]);
  if (readiness !== null) {
    return skip(context, "chapter", chapter.id, "composition", readiness);
  }
  const values = scenes.map((scene) => requireSupported(scene.composition).value);
  const measuredUnits = values.reduce((total, value) => total + value.measuredUnits, 0);
  const weighted = (read: (value: NarrativeCompositionMeasurement) => number): number =>
    values.reduce((total, value) => total + read(value) * value.measuredUnits, 0) / measuredUnits;
  return analyzed(
    Object.freeze({
      informationRatio: weighted((value) => value.informationRatio),
      dialogueRatio: weighted((value) => value.dialogueRatio),
      descriptionRatio: weighted((value) => value.descriptionRatio),
      innerActivityRatio: weighted((value) => value.innerActivityRatio),
      measuredUnits,
    }),
    chapterMetricEvidence(chapter, scenes, ["composition"]),
  );
}

function aggregateChapterPlotAdvancement(
  context: AnalysisContext,
  chapter: NarrativeChapterFact,
  scenes: readonly NarrativeSceneMetrics[],
): NarrativeAnalysisField<NarrativePlotAdvancementMeasurement> {
  const readiness = chapterMetricReadiness(context, chapter, scenes, ["plotAdvancement"]);
  if (readiness !== null) {
    return skip(context, "chapter", chapter.id, "plot_advancement", readiness);
  }
  const values = scenes.map((scene) => requireSupported(scene.plotAdvancement).value);
  return analyzed(
    Object.freeze({
      advances: values.some(({ advances }) => advances),
      plotlineIds: Object.freeze(
        [...new Set(values.flatMap(({ plotlineIds }) => plotlineIds))].sort(),
      ),
    }),
    chapterMetricEvidence(chapter, scenes, ["plotAdvancement"]),
  );
}

function aggregateChapterCharacterChanges(
  context: AnalysisContext,
  chapter: NarrativeChapterFact,
  scenes: readonly NarrativeSceneMetrics[],
): NarrativeAnalysisField<NarrativeCharacterChangeMeasurement> {
  const readiness = chapterMetricReadiness(context, chapter, scenes, ["characterChange"]);
  if (readiness !== null) {
    return skip(context, "chapter", chapter.id, "character_change", readiness);
  }
  const values = scenes.map((scene) => requireSupported(scene.characterChange).value);
  return analyzed(
    Object.freeze({
      changes: values.some(({ changes }) => changes),
      characterIds: Object.freeze(
        [...new Set(values.flatMap(({ characterIds }) => characterIds))].sort(),
      ),
    }),
    chapterMetricEvidence(chapter, scenes, ["characterChange"]),
  );
}

type SceneMetricKey =
  "conflictIntensity" | "tension" | "composition" | "plotAdvancement" | "characterChange";

function chapterMetricReadiness(
  context: AnalysisContext,
  chapter: NarrativeChapterFact,
  scenes: readonly NarrativeSceneMetrics[],
  keys: readonly SceneMetricKey[],
): NarrativeAnalysisSkipReason | null {
  const coverage = coverageReadiness(context.input, "scene_metrics");
  if (coverage !== null) {
    return coverage;
  }
  if (chapter.evidence.length === 0) {
    return "chapter_evidence_missing";
  }
  if (scenes.length === 0 || scenes.some(({ evidence }) => evidence.length === 0)) {
    return "scene_metrics_incomplete";
  }
  for (const scene of scenes) {
    for (const key of keys) {
      const supported = scene[key];
      if (supported === null) {
        return "scene_metrics_incomplete";
      }
      if (supported.evidence.length === 0) {
        return "source_evidence_missing";
      }
    }
  }
  return null;
}

function chapterMetricEvidence(
  chapter: NarrativeChapterFact,
  scenes: readonly NarrativeSceneMetrics[],
  keys: readonly SceneMetricKey[],
): readonly NarrativeEvidenceReference[] {
  return mergeEvidence(
    chapter.evidence,
    ...scenes.map(({ evidence }) => evidence),
    ...scenes.flatMap((scene) =>
      keys.map((key) => {
        const supported = scene[key];
        if (supported === null) {
          throw invalidInput("A required structured scene metric is missing.");
        }
        return supported.evidence;
      }),
    ),
  );
}

function analyzeTimeLocationConflicts(
  context: AnalysisContext,
): NarrativeAnalysisField<readonly NarrativeTimeLocationConflict[]> {
  const readiness = coveredGlobalReadiness(
    context,
    "time_location_conflicts",
    "character_presence",
    context.input.characterPresences.map(({ evidence }) => evidence),
  );
  if (readiness !== null) {
    return readiness;
  }
  const presences = [...context.input.characterPresences].sort(
    (left, right) =>
      left.characterId.localeCompare(right.characterId) ||
      left.storyTime.start - right.storyTime.start ||
      left.id.localeCompare(right.id),
  );
  const conflicts: NarrativeTimeLocationConflict[] = [];
  for (let leftIndex = 0; leftIndex < presences.length; leftIndex += 1) {
    const left = presences[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < presences.length; rightIndex += 1) {
      const right = presences[rightIndex];
      if (right?.characterId !== left.characterId) {
        break;
      }
      const overlap = intersectStoryTime(left.storyTime, right.storyTime);
      if (overlap === null || left.locationId === right.locationId) {
        continue;
      }
      conflicts.push(
        Object.freeze({
          id: `time-location:${left.id}:${right.id}`,
          characterId: left.characterId,
          plotlineIds: Object.freeze([left.plotlineId, right.plotlineId] as const),
          presenceIds: Object.freeze([left.id, right.id] as const),
          locationIds: Object.freeze([left.locationId, right.locationId] as const),
          overlappingStoryTime: Object.freeze(overlap),
          evidence: mergeEvidence(left.evidence, right.evidence),
        }),
      );
    }
  }
  return analyzed(
    Object.freeze(conflicts),
    mergeEvidence(
      context.input.coverage.character_presence.evidence,
      ...presences.map(({ evidence }) => evidence),
    ),
  );
}

function analyzeRepeatedFunctions(
  context: AnalysisContext,
): NarrativeAnalysisField<readonly NarrativeRepeatedFunctionFinding[]> {
  const readiness = sceneAuxiliaryReadiness(context, "repeated_functions", "functionTags");
  if (readiness !== null) {
    return readiness;
  }
  const scenes = [...context.input.scenes].sort(compareScenes(context.input.chaptersById));
  const grouped = new Map<string, NarrativeSceneMetrics[]>();
  for (const scene of scenes) {
    const tags = [...requireSupported(scene.functionTags).value].sort();
    if (tags.length === 0) {
      continue;
    }
    const signature = tags.join("\u0000");
    const group = grouped.get(signature) ?? [];
    group.push(scene);
    grouped.set(signature, group);
  }
  const findings: NarrativeRepeatedFunctionFinding[] = [];
  for (const [signature, group] of grouped) {
    const window = largestChapterWindow(
      group,
      context.input.chaptersById,
      context.input.policy.repeatedFunctionLookbackChapters,
    );
    if (window.length < context.input.policy.minimumRepeatedFunctionOccurrences) {
      continue;
    }
    findings.push(
      Object.freeze({
        functionTags: Object.freeze(signature.split("\u0000")),
        sceneIds: Object.freeze(window.map(({ id }) => id)),
        chapterIds: Object.freeze([...new Set(window.map(({ chapterId }) => chapterId))]),
        occurrenceCount: window.length,
        lookbackChapters: context.input.policy.repeatedFunctionLookbackChapters,
        evidence: mergeEvidence(
          ...window.flatMap((scene) => [
            scene.evidence,
            requireSupported(scene.functionTags).evidence,
          ]),
        ),
      }),
    );
  }
  return analyzed(
    Object.freeze(
      findings.sort((left, right) =>
        (left.sceneIds[0] ?? "").localeCompare(right.sceneIds[0] ?? ""),
      ),
    ),
    mergeEvidence(
      context.input.coverage.scene_metrics.evidence,
      ...scenes.flatMap((scene) => [scene.evidence, requireSupported(scene.functionTags).evidence]),
    ),
  );
}

function analyzeBuildup(
  context: AnalysisContext,
): NarrativeAnalysisField<readonly NarrativeBuildupCheck[]> {
  const climaxReadiness = sceneAuxiliaryReadiness(context, "buildup", "climax");
  if (climaxReadiness !== null) {
    return climaxReadiness;
  }
  const setupReadiness = sceneAuxiliaryReadiness(context, "buildup", "setupBeatIds");
  if (setupReadiness !== null) {
    return setupReadiness;
  }
  const scenes = [...context.input.scenes].sort(compareScenes(context.input.chaptersById));
  const checks: NarrativeBuildupCheck[] = [];
  for (const climaxScene of scenes) {
    const climax = requireSupported(climaxScene.climax);
    if (!climax.value.isClimax) {
      continue;
    }
    const climaxChapter = requireChapter(context.input, climaxScene.chapterId);
    const eligible = scenes.filter((scene) => {
      const chapter = requireChapter(context.input, scene.chapterId);
      return (
        (chapter.order < climaxChapter.order ||
          (chapter.order === climaxChapter.order && scene.sequence < climaxScene.sequence)) &&
        climaxChapter.order - chapter.order < context.input.policy.buildupLookbackChapters
      );
    });
    const setupEvidence = new Map<string, readonly NarrativeEvidenceReference[]>();
    for (const scene of eligible) {
      const setup = requireSupported(scene.setupBeatIds);
      for (const id of setup.value) {
        setupEvidence.set(id, mergeEvidence(scene.evidence, setup.evidence));
      }
    }
    const found = climax.value.requiredSetupBeatIds.filter((id) => setupEvidence.has(id)).sort();
    const missing = climax.value.requiredSetupBeatIds.filter((id) => !setupEvidence.has(id)).sort();
    checks.push(
      Object.freeze({
        climaxSceneId: climaxScene.id,
        status: missing.length === 0 ? "satisfied" : "missing_required_setup",
        foundSetupBeatIds: Object.freeze(found),
        missingSetupBeatIds: Object.freeze(missing),
        lookbackChapters: context.input.policy.buildupLookbackChapters,
        evidence: mergeEvidence(
          context.input.coverage.scene_metrics.evidence,
          climaxScene.evidence,
          climax.evidence,
          ...found.map((id) => setupEvidence.get(id) ?? []),
        ),
      }),
    );
  }
  return analyzed(
    Object.freeze(checks),
    mergeEvidence(
      context.input.coverage.scene_metrics.evidence,
      ...scenes.flatMap((scene) => [
        scene.evidence,
        requireSupported(scene.climax).evidence,
        requireSupported(scene.setupBeatIds).evidence,
      ]),
    ),
  );
}

function analyzeSimilarPacing(
  context: AnalysisContext,
  chapters: readonly NarrativeChapterAnalysis[],
): NarrativeAnalysisField<readonly NarrativeSimilarPacingRun[]> {
  const readiness = coverageReadiness(context.input, "scene_metrics");
  if (readiness !== null) {
    return skip(context, "global", "narrative", "similar_pacing", readiness);
  }
  if (chapters.length < context.input.policy.minimumSimilarPacingChapters) {
    return skip(
      context,
      "global",
      "narrative",
      "similar_pacing",
      "insufficient_consecutive_chapters",
    );
  }
  if (chapters.some((chapter) => !chapterHasPacingVector(chapter))) {
    return skip(context, "global", "narrative", "similar_pacing", "scene_metrics_incomplete");
  }
  const firstChapter = chapters[0];
  if (firstChapter === undefined) {
    throw invalidInput("Similar pacing analysis requires at least one chapter.");
  }
  const runs: NarrativeSimilarPacingRun[] = [];
  let run: NarrativeChapterAnalysis[] = [firstChapter];
  let deltas: NarrativePacingDelta[] = [];
  const flush = (): void => {
    if (run.length >= context.input.policy.minimumSimilarPacingChapters) {
      runs.push(
        Object.freeze({
          chapterIds: Object.freeze(run.map(({ chapterId }) => chapterId)),
          deltas: Object.freeze([...deltas]),
          tolerance: context.input.policy.pacingSimilarityTolerance,
          evidence: mergeEvidence(
            context.input.coverage.scene_metrics.evidence,
            ...run.flatMap(chapterAnalysisEvidence),
          ),
        }),
      );
    }
  };
  for (let index = 1; index < chapters.length; index += 1) {
    const previous = chapters[index - 1];
    const current = chapters[index];
    if (previous === undefined || current === undefined) {
      throw invalidInput("Consecutive pacing analysis entered an invalid chapter state.");
    }
    const delta = pacingDelta(previous, current);
    const consecutive = current.order === previous.order + 1;
    if (consecutive && pacingDeltaWithin(delta, context.input.policy.pacingSimilarityTolerance)) {
      run.push(current);
      deltas.push(delta);
    } else {
      flush();
      run = [current];
      deltas = [];
    }
  }
  flush();
  return analyzed(
    Object.freeze(runs),
    mergeEvidence(
      context.input.coverage.scene_metrics.evidence,
      ...chapters.flatMap(chapterAnalysisEvidence),
    ),
  );
}

function collectQualityFindings(
  scenes: readonly NarrativeSceneAnalysis[],
  repeated: NarrativeAnalysisField<readonly NarrativeRepeatedFunctionFinding[]>,
  buildup: NarrativeAnalysisField<readonly NarrativeBuildupCheck[]>,
  pacing: NarrativeAnalysisField<readonly NarrativeSimilarPacingRun[]>,
): readonly NarrativeQualityFinding[] {
  const findings: NarrativeQualityFinding[] = [];
  for (const scene of scenes) {
    if (
      scene.plotAdvancement.status === "analyzed" &&
      scene.characterChange.status === "analyzed" &&
      !scene.plotAdvancement.value.advances &&
      !scene.characterChange.value.changes
    ) {
      findings.push(
        Object.freeze({
          kind: "scene_changes_neither_plot_nor_character",
          sceneId: scene.sceneId,
          evidence: mergeEvidence(scene.plotAdvancement.evidence, scene.characterChange.evidence),
        }),
      );
    }
  }
  if (repeated.status === "analyzed") {
    repeated.value.forEach((finding) =>
      findings.push(
        Object.freeze({
          kind: "repeated_scene_function",
          sceneIds: finding.sceneIds,
          evidence: finding.evidence,
        }),
      ),
    );
  }
  if (buildup.status === "analyzed") {
    buildup.value
      .filter(({ status }) => status === "missing_required_setup")
      .forEach((check) =>
        findings.push(
          Object.freeze({
            kind: "climax_missing_required_setup",
            sceneId: check.climaxSceneId,
            missingSetupBeatIds: check.missingSetupBeatIds,
            evidence: check.evidence,
          }),
        ),
      );
  }
  if (pacing.status === "analyzed") {
    pacing.value.forEach((run) =>
      findings.push(
        Object.freeze({
          kind: "consecutive_chapters_have_similar_pacing",
          chapterIds: run.chapterIds,
          evidence: run.evidence,
        }),
      ),
    );
  }
  return Object.freeze(findings.sort(compareQualityFindings));
}

function supportedField<Input, Output>(
  context: AnalysisContext,
  scope: NarrativeSkippedCheck["scope"],
  scopeId: string,
  check: string,
  supported: NarrativeSupportedValue<Input> | null,
  project: (value: Input) => Output,
  baseEvidence: readonly NarrativeEvidenceReference[] = [],
  baseEvidenceMissing = false,
): NarrativeAnalysisField<Output> {
  if (supported === null) {
    return skip(context, scope, scopeId, check, "structured_value_missing");
  }
  if (supported.evidence.length === 0 || baseEvidenceMissing) {
    return skip(context, scope, scopeId, check, "source_evidence_missing");
  }
  return analyzed(project(supported.value), mergeEvidence(baseEvidence, supported.evidence));
}

function coveredCollectionField<Item, Output>(
  context: AnalysisContext,
  scope: NarrativeSkippedCheck["scope"],
  scopeId: string,
  check: string,
  area: NarrativeAnalysisCoverageArea,
  items: readonly Item[],
  evidenceOf: (item: Item) => readonly NarrativeEvidenceReference[],
  project: () => Output,
): NarrativeAnalysisField<Output> {
  const readiness = coverageReadiness(context.input, area);
  if (readiness !== null) {
    return skip(context, scope, scopeId, check, readiness);
  }
  if (items.some((item) => evidenceOf(item).length === 0)) {
    return skip(context, scope, scopeId, check, "source_evidence_missing");
  }
  return analyzed(
    project(),
    mergeEvidence(context.input.coverage[area].evidence, ...items.map((item) => evidenceOf(item))),
  );
}

function coveredGlobalReadiness(
  context: AnalysisContext,
  check: string,
  area: NarrativeAnalysisCoverageArea,
  evidence: readonly (readonly NarrativeEvidenceReference[])[],
): NarrativeSkippedField | null {
  const readiness = coverageReadiness(context.input, area);
  if (readiness !== null) {
    return skip(context, "global", "narrative", check, readiness);
  }
  if (evidence.some((references) => references.length === 0)) {
    return skip(context, "global", "narrative", check, "source_evidence_missing");
  }
  return null;
}

function sceneAuxiliaryReadiness(
  context: AnalysisContext,
  check: string,
  key: "functionTags" | "setupBeatIds" | "climax",
): NarrativeSkippedField | null {
  const global = coveredGlobalReadiness(
    context,
    check,
    "scene_metrics",
    context.input.scenes.map(({ evidence }) => evidence),
  );
  if (global !== null) {
    return global;
  }
  if (context.input.scenes.some((scene) => scene[key] === null)) {
    return skip(context, "global", "narrative", check, "structured_value_missing");
  }
  if (context.input.scenes.some((scene) => scene[key]?.evidence.length === 0)) {
    return skip(context, "global", "narrative", check, "source_evidence_missing");
  }
  return null;
}

function coverageReadiness(
  input: NarrativeAnalysisInput,
  area: NarrativeAnalysisCoverageArea,
): NarrativeAnalysisSkipReason | null {
  const assertion = input.coverage[area];
  if (assertion.evidence.length === 0) {
    return "coverage_missing_evidence";
  }
  return assertion.complete ? null : "coverage_incomplete";
}

function analyzed<Value>(
  value: Value,
  evidence: readonly NarrativeEvidenceReference[],
): NarrativeAnalyzedField<Value> {
  return Object.freeze({ status: "analyzed", value, evidence: freezeEvidence(evidence) });
}

function skip(
  context: AnalysisContext,
  scope: NarrativeSkippedCheck["scope"],
  scopeId: string,
  check: string,
  reason: NarrativeAnalysisSkipReason,
): NarrativeSkippedField {
  context.skipped.push(Object.freeze({ scope, scopeId, check, reason }));
  return Object.freeze({ status: "skipped", reason });
}

function tensionAnalysis(
  value: NarrativeTensionMeasurement,
  flatTolerance: number,
): NarrativeTensionAnalysis {
  const change = value.end - value.start;
  const trend: NarrativeTensionTrend =
    Math.abs(change) <= flatTolerance ? "flat" : change > 0 ? "rising" : "falling";
  return Object.freeze({ ...value, change, trend, flatTolerance });
}

function foreshadowState(
  history: readonly NarrativeForeshadowProgress[],
): NarrativeForeshadowState {
  if (history.length === 0) {
    return "not_started";
  }
  if (history.some(({ kind }) => kind === "resolved")) {
    return "resolved";
  }
  return history.some(({ kind }) => kind === "revealed") ? "revealed" : "active";
}

function intersectStoryTime(
  left: NarrativeStoryTimeRange,
  right: NarrativeStoryTimeRange,
): NarrativeStoryTimeRange | null {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  return start <= end ? { start, end } : null;
}

function largestChapterWindow(
  scenes: readonly NarrativeSceneMetrics[],
  chaptersById: ReadonlyMap<string, NarrativeChapterFact>,
  lookback: number,
): readonly NarrativeSceneMetrics[] {
  let best: readonly NarrativeSceneMetrics[] = [];
  let start = 0;
  for (let end = 0; end < scenes.length; end += 1) {
    const endScene = scenes[end];
    if (endScene === undefined) {
      throw invalidInput("Repeated-function analysis entered an invalid scene state.");
    }
    const endOrder = requireChapterFromMap(chaptersById, endScene.chapterId).order;
    while (start < end) {
      const startScene = scenes[start];
      if (startScene === undefined) {
        throw invalidInput("Repeated-function analysis entered an invalid scene state.");
      }
      if (endOrder - requireChapterFromMap(chaptersById, startScene.chapterId).order < lookback) {
        break;
      }
      start += 1;
    }
    const candidate = scenes.slice(start, end + 1);
    if (candidate.length > best.length) {
      best = candidate;
    }
  }
  return best;
}

function chapterHasPacingVector(chapter: NarrativeChapterAnalysis): boolean {
  return (
    chapter.conflict.status === "analyzed" &&
    chapter.tension.status === "analyzed" &&
    chapter.composition.status === "analyzed"
  );
}

function pacingDelta(
  from: NarrativeChapterAnalysis,
  to: NarrativeChapterAnalysis,
): NarrativePacingDelta {
  if (!chapterHasPacingVector(from) || !chapterHasPacingVector(to)) {
    throw invalidInput("A pacing delta requires complete chapter metrics.");
  }
  const fromConflict = requireAnalyzed(from.conflict).value;
  const toConflict = requireAnalyzed(to.conflict).value;
  const fromTension = requireAnalyzed(from.tension).value;
  const toTension = requireAnalyzed(to.tension).value;
  const fromComposition = requireAnalyzed(from.composition).value;
  const toComposition = requireAnalyzed(to.composition).value;
  return Object.freeze({
    fromChapterId: from.chapterId,
    toChapterId: to.chapterId,
    conflictIntensity: Math.abs(toConflict.weightedMean - fromConflict.weightedMean),
    tensionStart: Math.abs(toTension.start - fromTension.start),
    tensionEnd: Math.abs(toTension.end - fromTension.end),
    tensionPeak: Math.abs(toTension.peak - fromTension.peak),
    informationRatio: Math.abs(toComposition.informationRatio - fromComposition.informationRatio),
    dialogueRatio: Math.abs(toComposition.dialogueRatio - fromComposition.dialogueRatio),
    descriptionRatio: Math.abs(toComposition.descriptionRatio - fromComposition.descriptionRatio),
    innerActivityRatio: Math.abs(
      toComposition.innerActivityRatio - fromComposition.innerActivityRatio,
    ),
  });
}

function pacingDeltaWithin(delta: NarrativePacingDelta, tolerance: number): boolean {
  return [
    delta.conflictIntensity,
    delta.tensionStart,
    delta.tensionEnd,
    delta.tensionPeak,
    delta.informationRatio,
    delta.dialogueRatio,
    delta.descriptionRatio,
    delta.innerActivityRatio,
  ].every((value) => value <= tolerance);
}

function chapterAnalysisEvidence(
  chapter: NarrativeChapterAnalysis,
): readonly (readonly NarrativeEvidenceReference[])[] {
  const evidence: (readonly NarrativeEvidenceReference[])[] = [];
  for (const field of [chapter.conflict, chapter.tension, chapter.composition]) {
    if (field.status === "analyzed") {
      evidence.push(field.evidence);
    }
  }
  return evidence;
}

function validateInput(value: NarrativeAnalysisInput): ValidatedInput {
  if (!isRecord(value)) {
    throw invalidInput("Narrative analysis input must be a structured object.");
  }
  validateReference(value.projectId, "project id");
  validateReference(value.branchId, "branch id");
  validateReference(value.analysisChapterId, "analysis chapter id");
  validatePolicy(value.policy);
  validateCoverage(value.coverage);
  const collections = [
    value.chapters,
    value.plotlines,
    value.plotlineCharacters,
    value.plotlineDependencies,
    value.plotlineProgress,
    value.convergencePlans,
    value.characterPresences,
    value.foreshadows,
    value.foreshadowProgress,
    value.scenes,
  ];
  if (
    collections.some(
      (collection) => !Array.isArray(collection) || collection.length > MAXIMUM_RECORDS,
    )
  ) {
    throw invalidInput("Narrative analysis collection bounds are invalid.");
  }

  const chapterIds = new Set<string>();
  const chapterOrders = new Set<number>();
  value.chapters.forEach((chapter) => {
    validateId(chapter, chapterIds, "chapter");
    validateOrder(chapter.order, "chapter order");
    if (chapterOrders.has(chapter.order)) {
      throw invalidInput("Chapter order must be unique.");
    }
    chapterOrders.add(chapter.order);
    validateEvidenceCollection(chapter.evidence);
  });
  const chaptersById = new Map(value.chapters.map((chapter) => [chapter.id, chapter]));
  const analysisChapter = chaptersById.get(value.analysisChapterId);
  if (analysisChapter === undefined) {
    throw invalidInput("The analysis chapter must exist in the chapter facts.");
  }
  if (value.chapters.some(({ order }) => order > analysisChapter.order)) {
    throw invalidInput("The analysis chapter must be the latest observed chapter.");
  }

  const plotlineIds = new Set<string>();
  value.plotlines.forEach((plotline) => {
    validateId(plotline, plotlineIds, "plotline");
    validateOptionalSupportedText(plotline.goal);
  });
  const associationIds = new Set<string>();
  const associationKeys = new Set<string>();
  value.plotlineCharacters.forEach((association) => {
    validateId(association, associationIds, "plotline character");
    requireSetReference(plotlineIds, association.plotlineId, "plotline character plotline");
    validateReference(association.characterId, "plotline character");
    registerSignature(associationKeys, `${association.plotlineId}\u0000${association.characterId}`);
    validateEvidenceCollection(association.evidence);
  });
  const dependencyIds = new Set<string>();
  const dependencyKeys = new Set<string>();
  value.plotlineDependencies.forEach((dependency) => {
    validateId(dependency, dependencyIds, "plotline dependency");
    requireSetReference(plotlineIds, dependency.fromPlotlineId, "dependency source");
    requireSetReference(plotlineIds, dependency.toPlotlineId, "dependency target");
    if (
      dependency.fromPlotlineId === dependency.toPlotlineId ||
      !["pending", "satisfied", "blocked"].includes(dependency.status)
    ) {
      throw invalidInput("A plotline dependency is invalid.");
    }
    registerSignature(
      dependencyKeys,
      `${dependency.fromPlotlineId}\u0000${dependency.toPlotlineId}`,
    );
    validateEvidenceCollection(dependency.evidence);
  });
  const progressIds = new Set<string>();
  const progressOrders = new Set<string>();
  value.plotlineProgress.forEach((progress) => {
    validateId(progress, progressIds, "plotline progress");
    requireSetReference(plotlineIds, progress.plotlineId, "progress plotline");
    requireSetReference(chapterIds, progress.chapterId, "progress chapter");
    validateSequence(progress.sequence, "plotline progress sequence");
    registerSignature(
      progressOrders,
      `${progress.plotlineId}\u0000${progress.chapterId}\u0000${String(progress.sequence)}`,
    );
    validateReference(progress.eventId, "progress event");
    validateText(progress.summary, "progress summary");
    validateEvidenceCollection(progress.evidence);
    if (requireChapterFromMap(chaptersById, progress.chapterId).order > analysisChapter.order) {
      throw invalidInput("Observed plotline progress cannot occur after the analysis chapter.");
    }
  });

  const convergenceIds = new Set<string>();
  value.convergencePlans.forEach((plan) => {
    validateId(plan, convergenceIds, "convergence plan");
    validateUniqueReferences(plan.plotlineIds, 2, "convergence plotlines").forEach((id) =>
      requireSetReference(plotlineIds, id, "convergence plotline"),
    );
    validateOrder(plan.targetChapterOrder, "convergence target order");
    if (!["planned", "reached", "cancelled"].includes(plan.status)) {
      throw invalidInput("A convergence plan status is invalid.");
    }
    validateEvidenceCollection(plan.evidence);
  });

  const presenceIds = new Set<string>();
  value.characterPresences.forEach((presence) => {
    validateId(presence, presenceIds, "character presence");
    validateReference(presence.characterId, "presence character");
    requireSetReference(plotlineIds, presence.plotlineId, "presence plotline");
    requireSetReference(chapterIds, presence.chapterId, "presence chapter");
    validateReference(presence.locationId, "presence location");
    if (
      !isRecord(presence.storyTime) ||
      !isSafeInteger(presence.storyTime.start) ||
      !isSafeInteger(presence.storyTime.end) ||
      presence.storyTime.start > presence.storyTime.end ||
      Math.abs(presence.storyTime.start) > MAXIMUM_ORDER ||
      Math.abs(presence.storyTime.end) > MAXIMUM_ORDER
    ) {
      throw invalidInput("A character presence story-time range is invalid.");
    }
    validateEvidenceCollection(presence.evidence);
  });

  const foreshadowIds = new Set<string>();
  value.foreshadows.forEach((foreshadow) => validateId(foreshadow, foreshadowIds, "foreshadow"));
  const foreshadowProgressIds = new Set<string>();
  const foreshadowProgressOrders = new Set<string>();
  value.foreshadowProgress.forEach((progress) => {
    validateId(progress, foreshadowProgressIds, "foreshadow progress");
    requireSetReference(foreshadowIds, progress.foreshadowId, "foreshadow progress thread");
    requireSetReference(chapterIds, progress.chapterId, "foreshadow progress chapter");
    validateSequence(progress.sequence, "foreshadow progress sequence");
    registerSignature(
      foreshadowProgressOrders,
      `${progress.foreshadowId}\u0000${progress.chapterId}\u0000${String(progress.sequence)}`,
    );
    if (!["planted", "advanced", "revealed", "resolved", "misdirected"].includes(progress.kind)) {
      throw invalidInput("A foreshadow progress kind is invalid.");
    }
    validateText(progress.description, "foreshadow progress description");
    validateEvidenceCollection(progress.evidence);
    if (requireChapterFromMap(chaptersById, progress.chapterId).order > analysisChapter.order) {
      throw invalidInput("Observed foreshadow progress cannot occur after the analysis chapter.");
    }
  });

  const sceneIds = new Set<string>();
  const sceneOrders = new Set<string>();
  value.scenes.forEach((scene) => {
    validateId(scene, sceneIds, "scene");
    requireSetReference(chapterIds, scene.chapterId, "scene chapter");
    validateSequence(scene.sequence, "scene sequence");
    registerSignature(sceneOrders, `${scene.chapterId}\u0000${String(scene.sequence)}`);
    validateEvidenceCollection(scene.evidence);
    validateScene(scene, plotlineIds);
  });

  return {
    ...value,
    chaptersById,
    plotlineIds,
    foreshadowIds,
    analysisChapter,
  };
}

function validateScene(scene: NarrativeSceneMetrics, plotlineIds: ReadonlySet<string>): void {
  validateOptionalSupportedText(scene.goal);
  validateOptionalSupported(scene.conflictIntensity, (value) => {
    if (!isUnitInterval(value)) {
      throw invalidInput("Scene conflict intensity must be an explicit unit-interval metric.");
    }
  });
  validateOptionalSupported(scene.tension, (value) => {
    if (
      !isRecord(value) ||
      !isUnitInterval(value.start) ||
      !isUnitInterval(value.end) ||
      !isUnitInterval(value.peak) ||
      value.peak < value.start ||
      value.peak < value.end
    ) {
      throw invalidInput("Scene tension metrics are invalid.");
    }
  });
  validateOptionalSupported(scene.composition, (value) => {
    if (!isRecord(value)) {
      throw invalidInput("Scene composition must be a structured metric.");
    }
    const ratios = [
      value.informationRatio,
      value.dialogueRatio,
      value.descriptionRatio,
      value.innerActivityRatio,
    ];
    if (
      ratios.some((ratio) => !isUnitInterval(ratio)) ||
      Math.abs(ratios.reduce((total, ratio) => total + ratio, 0) - 1) > RATIO_TOLERANCE ||
      !isSafeInteger(value.measuredUnits) ||
      value.measuredUnits < 1 ||
      value.measuredUnits > MAXIMUM_SOURCE_LENGTH
    ) {
      throw invalidInput("Scene composition must be an explicit complete ratio measurement.");
    }
  });
  validateOptionalSupported(scene.plotAdvancement, (value) => {
    if (!isRecord(value)) {
      throw invalidInput("Plot advancement must be a structured metric.");
    }
    const ids = validateUniqueReferences(value.plotlineIds, 0, "advanced plotlines");
    ids.forEach((id) => requireSetReference(plotlineIds, id, "advanced plotline"));
    if (value.advances !== ids.length > 0) {
      throw invalidInput("Plot advancement must agree with its explicit plotline identifiers.");
    }
  });
  validateOptionalSupported(scene.characterChange, (value) => {
    if (!isRecord(value)) {
      throw invalidInput("Character change must be a structured metric.");
    }
    const ids = validateUniqueReferences(value.characterIds, 0, "changed characters");
    if (value.changes !== ids.length > 0) {
      throw invalidInput("Character change must agree with its explicit character identifiers.");
    }
  });
  validateOptionalSupported(scene.functionTags, (value) => {
    validateUniqueReferences(value, 0, "scene function tags");
  });
  validateOptionalSupported(scene.setupBeatIds, (value) => {
    validateUniqueReferences(value, 0, "scene setup beats");
  });
  validateOptionalSupported(scene.climax, (value) => {
    if (!isRecord(value)) {
      throw invalidInput("Climax measurement must be structured.");
    }
    const ids = validateUniqueReferences(value.requiredSetupBeatIds, 0, "required setup beats");
    if (!value.isClimax && ids.length > 0) {
      throw invalidInput("A non-climax scene cannot require climax setup beats.");
    }
  });
}

function validatePolicy(value: NarrativeAnalysisPolicy): void {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.plotlineStaleAfterChapters) ||
    !isPositiveInteger(value.foreshadowStaleAfterChapters) ||
    !isPositiveInteger(value.upcomingConvergenceWithinChapters) ||
    !isPositiveInteger(value.repeatedFunctionLookbackChapters) ||
    !isSafeInteger(value.minimumRepeatedFunctionOccurrences) ||
    value.minimumRepeatedFunctionOccurrences < 2 ||
    !isPositiveInteger(value.buildupLookbackChapters) ||
    !isUnitInterval(value.pacingSimilarityTolerance) ||
    !isSafeInteger(value.minimumSimilarPacingChapters) ||
    value.minimumSimilarPacingChapters < 2 ||
    !isUnitInterval(value.tensionFlatTolerance)
  ) {
    throw invalidInput("Narrative analysis policy must provide explicit bounded thresholds.");
  }
}

function validateCoverage(value: NarrativeAnalysisCoverage): void {
  if (!isRecord(value)) {
    throw invalidInput("Narrative analysis coverage is invalid.");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== NARRATIVE_ANALYSIS_COVERAGE_AREAS.length ||
    keys.some((key, index) => key !== [...NARRATIVE_ANALYSIS_COVERAGE_AREAS].sort()[index])
  ) {
    throw invalidInput("Narrative analysis coverage must declare every coverage area.");
  }
  for (const area of NARRATIVE_ANALYSIS_COVERAGE_AREAS) {
    const assertion = value[area];
    if (!isRecord(assertion) || typeof assertion.complete !== "boolean") {
      throw invalidInput("A narrative coverage assertion is invalid.");
    }
    validateEvidenceCollection(assertion.evidence);
  }
}

function validateOptionalSupportedText(value: NarrativeSupportedValue<string> | null): void {
  validateOptionalSupported(value, (text) => validateText(text, "supported narrative text"));
}

function validateOptionalSupported<Value>(
  supported: NarrativeSupportedValue<Value> | null,
  validateValue: (value: Value) => void,
): void {
  if (supported === null) {
    return;
  }
  if (!isRecord(supported) || !("value" in supported)) {
    throw invalidInput("A supported narrative value is invalid.");
  }
  validateValue(supported.value);
  validateEvidenceCollection(supported.evidence);
}

function validateEvidenceCollection(value: readonly NarrativeEvidenceReference[]): void {
  if (!Array.isArray(value) || value.length > MAXIMUM_EVIDENCE) {
    throw invalidInput("Narrative evidence collection bounds are invalid.");
  }
  const ids = new Set<string>();
  for (const candidate of value as readonly unknown[]) {
    if (!isNarrativeEvidence(candidate)) {
      throw invalidInput("Narrative evidence must identify an exact immutable source span.");
    }
    const key = evidenceKey(candidate);
    if (ids.has(key)) {
      throw invalidInput("Narrative evidence references cannot be duplicated.");
    }
    ids.add(key);
  }
}

function isNarrativeEvidence(value: unknown): value is NarrativeEvidenceReference {
  if (!isRecord(value) || typeof value.sourceKind !== "string") {
    return false;
  }
  return (
    NARRATIVE_EVIDENCE_SOURCE_KINDS.includes(value.sourceKind as NarrativeEvidenceSourceKind) &&
    isSafeReference(value.sourceId) &&
    isSafeReference(value.sourceVersionId) &&
    typeof value.contentHash === "string" &&
    SHA256_PATTERN.test(value.contentHash) &&
    isBoundedText(value.locator, MAXIMUM_REFERENCE) &&
    isBoundedText(value.excerpt, 20_000) &&
    isSafeInteger(value.startOffset) &&
    isSafeInteger(value.endOffset) &&
    isSafeInteger(value.sourceLength) &&
    value.startOffset >= 0 &&
    value.endOffset > value.startOffset &&
    value.endOffset <= value.sourceLength &&
    value.sourceLength <= MAXIMUM_SOURCE_LENGTH &&
    value.excerpt.length === value.endOffset - value.startOffset
  );
}

function validateId(
  value: unknown,
  ids: Set<string>,
  kind: string,
): asserts value is { id: string } {
  if (!isRecord(value) || !isSafeReference(value.id) || ids.has(value.id)) {
    throw invalidInput(`A ${kind} identifier is invalid or duplicated.`);
  }
  ids.add(value.id);
}

function validateReference(value: unknown, field: string): asserts value is string {
  if (!isSafeReference(value)) {
    throw invalidInput(`The ${field} is invalid.`);
  }
}

function requireSetReference(ids: ReadonlySet<string>, value: unknown, field: string): void {
  validateReference(value, field);
  if (!ids.has(value)) {
    throw invalidInput(`The ${field} does not reference a known record.`);
  }
}

function validateUniqueReferences(
  value: readonly string[],
  minimum: number,
  field: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAXIMUM_RECORDS) {
    throw invalidInput(`The ${field} collection bounds are invalid.`);
  }
  const unique = new Set<string>();
  const references: string[] = [];
  for (const id of value as readonly unknown[]) {
    validateReference(id, field);
    if (unique.has(id)) {
      throw invalidInput(`The ${field} cannot contain duplicates.`);
    }
    unique.add(id);
    references.push(id);
  }
  return Object.freeze(references);
}

function registerSignature(signatures: Set<string>, signature: string): void {
  if (signatures.has(signature)) {
    throw invalidInput("A narrative fact signature cannot be duplicated.");
  }
  signatures.add(signature);
}

function validateText(value: unknown, field: string): asserts value is string {
  if (!isBoundedText(value, MAXIMUM_TEXT)) {
    throw invalidInput(`The ${field} is invalid.`);
  }
}

function validateOrder(value: unknown, field: string): void {
  if (!isSafeInteger(value) || value < 0 || value > MAXIMUM_ORDER) {
    throw invalidInput(`The ${field} is invalid.`);
  }
}

function validateSequence(value: unknown, field: string): void {
  if (!isSafeInteger(value) || value < 1 || value > MAXIMUM_RECORDS) {
    throw invalidInput(`The ${field} is invalid.`);
  }
}

function copyDependency(value: NarrativePlotlineDependency): NarrativePlotlineDependency {
  return Object.freeze({ ...value, evidence: freezeEvidence(value.evidence) });
}

function copyProgress(value: NarrativePlotlineProgress): NarrativePlotlineProgress {
  return Object.freeze({ ...value, evidence: freezeEvidence(value.evidence) });
}

function copyConvergence(value: NarrativeConvergencePlan): NarrativeConvergencePlan {
  return Object.freeze({
    ...value,
    plotlineIds: Object.freeze([...value.plotlineIds]),
    evidence: freezeEvidence(value.evidence),
  });
}

function copyForeshadowProgress(value: NarrativeForeshadowProgress): NarrativeForeshadowProgress {
  return Object.freeze({ ...value, evidence: freezeEvidence(value.evidence) });
}

function copyComposition(value: NarrativeCompositionMeasurement): NarrativeCompositionMeasurement {
  return Object.freeze({ ...value });
}

function copyPlotAdvancement(
  value: NarrativePlotAdvancementMeasurement,
): NarrativePlotAdvancementMeasurement {
  return Object.freeze({ ...value, plotlineIds: Object.freeze([...value.plotlineIds].sort()) });
}

function copyCharacterChange(
  value: NarrativeCharacterChangeMeasurement,
): NarrativeCharacterChangeMeasurement {
  return Object.freeze({ ...value, characterIds: Object.freeze([...value.characterIds].sort()) });
}

function copyEvidence(value: NarrativeEvidenceReference): NarrativeEvidenceReference {
  return Object.freeze({ ...value });
}

function freezeEvidence(
  value: readonly NarrativeEvidenceReference[],
): readonly NarrativeEvidenceReference[] {
  return Object.freeze(value.map(copyEvidence));
}

function mergeEvidence(
  ...collections: readonly (readonly NarrativeEvidenceReference[])[]
): readonly NarrativeEvidenceReference[] {
  const merged = new Map<string, NarrativeEvidenceReference>();
  collections.flat().forEach((evidence) => merged.set(evidenceKey(evidence), evidence));
  return Object.freeze(
    [...merged.values()]
      .sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)))
      .map(copyEvidence),
  );
}

function evidenceKey(value: NarrativeEvidenceReference): string {
  return `${value.sourceKind}\u0000${value.sourceId}\u0000${value.sourceVersionId}\u0000${value.locator}\u0000${String(value.startOffset)}\u0000${String(value.endOffset)}`;
}

function compareChapterBound(
  left: { readonly id: string; readonly chapterId: string; readonly sequence: number },
  right: { readonly id: string; readonly chapterId: string; readonly sequence: number },
  chaptersById: ReadonlyMap<string, NarrativeChapterFact>,
): number {
  return (
    requireChapterFromMap(chaptersById, left.chapterId).order -
      requireChapterFromMap(chaptersById, right.chapterId).order ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id)
  );
}

function compareScenes(
  chaptersById: ReadonlyMap<string, NarrativeChapterFact>,
): (left: NarrativeSceneMetrics, right: NarrativeSceneMetrics) => number {
  return (left, right) =>
    requireChapterFromMap(chaptersById, left.chapterId).order -
      requireChapterFromMap(chaptersById, right.chapterId).order ||
    left.sequence - right.sequence ||
    left.id.localeCompare(right.id);
}

function compareDependencies(
  left: NarrativePlotlineDependency,
  right: NarrativePlotlineDependency,
): number {
  return left.toPlotlineId.localeCompare(right.toPlotlineId) || left.id.localeCompare(right.id);
}

function compareSkipped(left: NarrativeSkippedCheck, right: NarrativeSkippedCheck): number {
  return (
    left.scope.localeCompare(right.scope) ||
    left.scopeId.localeCompare(right.scopeId) ||
    left.check.localeCompare(right.check) ||
    left.reason.localeCompare(right.reason)
  );
}

function compareQualityFindings(
  left: NarrativeQualityFinding,
  right: NarrativeQualityFinding,
): number {
  return (
    left.kind.localeCompare(right.kind) || JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function requireChapter(input: ValidatedInput, chapterId: string): NarrativeChapterFact {
  return requireChapterFromMap(input.chaptersById, chapterId);
}

function requireChapterFromMap(
  chaptersById: ReadonlyMap<string, NarrativeChapterFact>,
  chapterId: string,
): NarrativeChapterFact {
  const chapter = chaptersById.get(chapterId);
  if (chapter === undefined) {
    throw invalidInput("A narrative fact references an unknown chapter.");
  }
  return chapter;
}

function requireSupported<Value>(
  value: NarrativeSupportedValue<Value> | null,
): NarrativeSupportedValue<Value> {
  if (value === null) {
    throw invalidInput("A required structured scene metric is missing.");
  }
  return value;
}

function requireAnalyzed<Value>(
  value: NarrativeAnalysisField<Value>,
): NarrativeAnalyzedField<Value> {
  if (value.status !== "analyzed") {
    throw invalidInput("A required analyzed narrative field is unavailable.");
  }
  return value;
}

function isSafeReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_REFERENCE &&
    value === value.trim() &&
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !CONTROL_PATTERN.test(value)
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 1 && value <= MAXIMUM_RECORDS;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): NarrativeAnalysisInputError {
  return new NarrativeAnalysisInputError(message);
}
