import type { NovelSkillInvocationMode, NovelSkillTask } from "./novel-skill.js";
import { NOVEL_SKILL_COMPILER_VERSION } from "./novel-skill-compiler.js";
import { ADDITIONAL_NOVEL_SKILL_EVALUATION_FIXTURES } from "./novel-skill-evaluation-fixtures.js";

export const NOVEL_SKILL_EVALUATION_ARMS = [
  "no_skill",
  "core",
  "core_genre",
  "core_genre_preferences",
] as const;

export const NOVEL_SKILL_EVALUATION_METRICS = [
  "instruction_following",
  "canon_preservation",
  "character_consistency",
  "pov_preservation",
  "causal_progression",
  "scene_function",
  "dialogue_distinction",
  "specificity",
  "repetition_cliche_control",
  "pacing",
  "user_preference",
  "unnecessary_rewrite_avoidance",
  "evidence_completeness",
] as const;

export type NovelSkillEvaluationArm = (typeof NOVEL_SKILL_EVALUATION_ARMS)[number];
export type NovelSkillEvaluationMetric = (typeof NOVEL_SKILL_EVALUATION_METRICS)[number];
export type NovelSkillEvaluationStatus =
  "NOT_EVALUATED" | "EVIDENCE_INCOMPLETE" | "FAILED" | "ELIGIBLE_FOR_REVIEW";

export const NOVEL_SKILL_EVALUATION_COVERAGE_DIMENSIONS = [
  "youth_romance",
  "suspense",
  "fantasy",
  "light_novel",
  "web_novel",
  "literary",
  "multi_character_dialogue",
  "pov",
  "timeline",
  "rule_conflict",
  "continuation",
  "rewrite",
] as const;

export type NovelSkillEvaluationCoverageDimension =
  (typeof NOVEL_SKILL_EVALUATION_COVERAGE_DIMENSIONS)[number];

export interface NovelSkillEvaluationFixture {
  readonly fixtureId: string;
  readonly language: "zh-CN";
  readonly origin: "inkshadow_original";
  readonly taskType: NovelSkillTask;
  readonly invocationMode: NovelSkillInvocationMode;
  readonly genreTags: readonly string[];
  readonly coverageDimensions: readonly NovelSkillEvaluationCoverageDimension[];
  readonly input: string;
  readonly lockedFacts: readonly string[];
  readonly boundaries: readonly string[];
  readonly requestedOutcome: string;
}

export function listNovelSkillEvaluationFixtures(): readonly NovelSkillEvaluationFixture[] {
  return Object.freeze([
    ...NOVEL_SKILL_EVALUATION_FIXTURES,
    ...ADDITIONAL_NOVEL_SKILL_EVALUATION_FIXTURES,
  ]);
}

/**
 * A portable two-model evaluation plan.  This describes work that may be run,
 * but deliberately contains neither provider credentials nor any provider
 * output.  Persistence code stores only fixture metadata and contract hashes.
 */
export interface NovelSkillEvaluationModelSlot {
  readonly slotId: "text_tier_a" | "text_tier_b";
  readonly modelTier: string;
}

export interface NovelSkillEvaluationPlannedCell {
  readonly fixtureId: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly modelSlotId: NovelSkillEvaluationModelSlot["slotId"];
  readonly modelTier: string;
  readonly repetition: number;
}

export interface NovelSkillEvaluationExecutionPlan {
  readonly schemaVersion: 1;
  readonly evaluatorVersion: "novel-skill-ab@1";
  readonly compilerVersion: typeof NOVEL_SKILL_COMPILER_VERSION;
  readonly status: "NOT_EVALUATED";
  readonly modelSlots: readonly NovelSkillEvaluationModelSlot[];
  readonly minimumRepetitionsPerCell: number;
  readonly cells: readonly NovelSkillEvaluationPlannedCell[];
  readonly note: string;
}

export interface NovelSkillEvaluationPlan {
  readonly schemaVersion: 1;
  readonly evaluatorVersion: "novel-skill-ab@1";
  readonly compilerVersion: typeof NOVEL_SKILL_COMPILER_VERSION;
  readonly status: "NOT_EVALUATED";
  readonly arms: readonly NovelSkillEvaluationArm[];
  readonly fixtures: readonly NovelSkillEvaluationFixture[];
  readonly metrics: readonly {
    readonly metric: NovelSkillEvaluationMetric;
    readonly direction: "higher_is_better";
    readonly blocking: boolean;
  }[];
  readonly minimumRepetitionsPerCell: 2;
  readonly note: string;
}

export interface NovelSkillEvaluationObservation {
  readonly observationId: string;
  readonly fixtureId: string;
  readonly arm: NovelSkillEvaluationArm;
  readonly modelSlotId: NovelSkillEvaluationModelSlot["slotId"];
  readonly modelTier: string;
  readonly repetition: number;
  readonly modelInvocationId: string;
  readonly evaluatorVersion: "novel-skill-ab@1";
  readonly completionStatus: "succeeded" | "failed" | "cancelled" | "timed_out";
  readonly visibleContentLength: number;
  readonly finishReason: string | null;
  /** Replayed compiler applicability for this exact fixture and arm. */
  readonly methodApplicability: Readonly<{
    readonly core: boolean;
    readonly genre: boolean;
  }>;
  readonly scores: Readonly<Record<NovelSkillEvaluationMetric, number | null>>;
  readonly latencyMilliseconds: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostMicros: number | null;
}

export interface NovelSkillEvaluationResult {
  readonly status: NovelSkillEvaluationStatus;
  readonly defaultEnablement: "KEEP_DISABLED";
  readonly observationCount: number;
  readonly expectedCellCount: number;
  readonly completedCellCount: number;
  readonly missingCells: readonly string[];
  readonly armMetricMeans: Readonly<
    Partial<
      Record<NovelSkillEvaluationArm, Readonly<Partial<Record<NovelSkillEvaluationMetric, number>>>>
    >
  >;
  readonly modelArmMetricMeans: Readonly<
    Record<
      NovelSkillEvaluationModelSlot["slotId"],
      Readonly<
        Partial<
          Record<
            NovelSkillEvaluationArm,
            Readonly<Partial<Record<NovelSkillEvaluationMetric, number>>>
          >
        >
      >
    >
  >;
  readonly regressions: readonly string[];
  readonly note: string;
}

const METRIC_DEFINITIONS: NovelSkillEvaluationPlan["metrics"] = [
  ...NOVEL_SKILL_EVALUATION_METRICS.map((metric) => ({
    metric,
    direction: "higher_is_better" as const,
    blocking: true,
  })),
];

export function createNovelSkillEvaluationPlan(): NovelSkillEvaluationPlan {
  return Object.freeze({
    schemaVersion: 1,
    evaluatorVersion: "novel-skill-ab@1",
    compilerVersion: NOVEL_SKILL_COMPILER_VERSION,
    status: "NOT_EVALUATED",
    arms: NOVEL_SKILL_EVALUATION_ARMS,
    fixtures: listNovelSkillEvaluationFixtures(),
    metrics: METRIC_DEFINITIONS,
    minimumRepetitionsPerCell: 2,
    note: "No provider outputs have been evaluated. Experimental skills must remain disabled by default.",
  });
}

/**
 * Creates the full A/B matrix: 12 original Chinese contracts × four arms ×
 * two distinct text-model slots × the required repetitions.  It is planning
 * only; callers must still create content-free invocation receipts and obtain
 * a human decision before changing any project binding.
 */
export function createNovelSkillEvaluationExecutionPlan(
  modelSlots: readonly NovelSkillEvaluationModelSlot[],
  minimumRepetitionsPerCell = 2,
): NovelSkillEvaluationExecutionPlan {
  if (
    modelSlots.length !== 2 ||
    new Set(modelSlots.map(({ slotId }) => slotId)).size !== 2 ||
    new Set(modelSlots.map(({ modelTier }) => modelTier)).size !== 2 ||
    modelSlots.some(({ modelTier }) => !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(modelTier)) ||
    !Number.isSafeInteger(minimumRepetitionsPerCell) ||
    minimumRepetitionsPerCell !== 2
  ) {
    throw new Error(
      "Novel skill evaluation requires two distinct portable text-model slots and exactly two repetitions.",
    );
  }
  const orderedSlots = [...modelSlots].sort((left, right) =>
    left.slotId.localeCompare(right.slotId, "en"),
  );
  const cells = listNovelSkillEvaluationFixtures().flatMap(({ fixtureId }) =>
    NOVEL_SKILL_EVALUATION_ARMS.flatMap((arm) =>
      orderedSlots.flatMap((slot) =>
        Array.from({ length: minimumRepetitionsPerCell }, (_, index) =>
          Object.freeze({
            fixtureId,
            arm,
            modelSlotId: slot.slotId,
            modelTier: slot.modelTier,
            repetition: index + 1,
          }),
        ),
      ),
    ),
  );
  return Object.freeze({
    schemaVersion: 1,
    evaluatorVersion: "novel-skill-ab@1",
    compilerVersion: NOVEL_SKILL_COMPILER_VERSION,
    status: "NOT_EVALUATED",
    modelSlots: Object.freeze(orderedSlots.map((slot) => Object.freeze({ ...slot }))),
    minimumRepetitionsPerCell,
    cells: Object.freeze(cells),
    note: "This is an execution plan only. No provider has been called and Novel Skills remain disabled by default.",
  });
}

export function evaluateNovelSkillAbEvidence(
  observations: readonly NovelSkillEvaluationObservation[],
  expectedModelSlots: readonly NovelSkillEvaluationModelSlot[],
): NovelSkillEvaluationResult {
  validateEvaluationInputs(observations, expectedModelSlots);
  const expectedCells = listNovelSkillEvaluationFixtures().flatMap(({ fixtureId }) =>
    NOVEL_SKILL_EVALUATION_ARMS.flatMap((arm) =>
      expectedModelSlots.flatMap(({ slotId }) =>
        [1, 2].map((repetition) => `${fixtureId}/${arm}/${slotId}/${String(repetition)}`),
      ),
    ),
  );
  const completedCells = new Set<string>();
  for (const observation of observations) {
    completedCells.add(
      `${observation.fixtureId}/${observation.arm}/${observation.modelSlotId}/${String(observation.repetition)}`,
    );
  }
  const missingCells = expectedCells.filter((cell) => !completedCells.has(cell));
  const completedCellCount = expectedCells.length - missingCells.length;
  const armMetricMeans = calculateMeans(observations);
  const modelArmMetricMeans = calculateModelMeans(observations, expectedModelSlots);
  const regressions = findRegressions(observations, modelArmMetricMeans, expectedModelSlots);
  const status: NovelSkillEvaluationStatus =
    observations.length === 0
      ? "NOT_EVALUATED"
      : missingCells.length > 0
        ? "EVIDENCE_INCOMPLETE"
        : regressions.length > 0
          ? "FAILED"
          : "ELIGIBLE_FOR_REVIEW";
  return Object.freeze({
    status,
    defaultEnablement: "KEEP_DISABLED",
    observationCount: observations.length,
    expectedCellCount: expectedCells.length,
    completedCellCount,
    missingCells: Object.freeze(missingCells),
    armMetricMeans,
    modelArmMetricMeans,
    regressions: Object.freeze(regressions),
    note:
      status === "ELIGIBLE_FOR_REVIEW"
        ? "Quantitative gates passed, but a product review is still required before changing defaults."
        : "Novel Skills remain experimental and disabled by default.",
  });
}

function calculateMeans(
  observations: readonly NovelSkillEvaluationObservation[],
): NovelSkillEvaluationResult["armMetricMeans"] {
  const result: Partial<
    Record<NovelSkillEvaluationArm, Partial<Record<NovelSkillEvaluationMetric, number>>>
  > = {};
  for (const arm of NOVEL_SKILL_EVALUATION_ARMS) {
    const armObservations = observations.filter((observation) => observation.arm === arm);
    const means: Partial<Record<NovelSkillEvaluationMetric, number>> = {};
    for (const metric of NOVEL_SKILL_EVALUATION_METRICS) {
      const values = armObservations
        .map(({ scores }) => scores[metric])
        .filter((value): value is number => value !== null);
      if (values.length > 0) {
        means[metric] = round(values.reduce((total, value) => total + value, 0) / values.length);
      }
    }
    if (Object.keys(means).length > 0) {
      result[arm] = Object.freeze(means);
    }
  }
  return Object.freeze(result);
}

function calculateModelMeans(
  observations: readonly NovelSkillEvaluationObservation[],
  modelSlots: readonly NovelSkillEvaluationModelSlot[],
): NovelSkillEvaluationResult["modelArmMetricMeans"] {
  return Object.freeze(
    Object.fromEntries(
      modelSlots.map(({ slotId }) => [
        slotId,
        calculateMeans(observations.filter((observation) => observation.modelSlotId === slotId)),
      ]),
    ),
  ) as NovelSkillEvaluationResult["modelArmMetricMeans"];
}

const ARM_BASELINES: readonly [
  Exclude<NovelSkillEvaluationArm, "no_skill">,
  NovelSkillEvaluationArm,
][] = [
  ["core", "no_skill"],
  ["core_genre", "core"],
  ["core_genre_preferences", "core_genre"],
];

function findRegressions(
  observations: readonly NovelSkillEvaluationObservation[],
  modelMeans: NovelSkillEvaluationResult["modelArmMetricMeans"],
  modelSlots: readonly NovelSkillEvaluationModelSlot[],
): string[] {
  void modelMeans;
  const regressions: string[] = [];
  for (const { slotId } of modelSlots) {
    for (const [arm, baselineArm] of ARM_BASELINES) {
      const allCandidateObservations = observations.filter(
        (observation) => observation.modelSlotId === slotId && observation.arm === arm,
      );
      const applicable = allCandidateObservations.filter((observation) =>
        appliesToIncrement(observation, arm),
      );
      const notApplicable = allCandidateObservations.filter(
        (observation) => !appliesToIncrement(observation, arm),
      );
      if (applicable.length === 0) {
        regressions.push(`${slotId}:improvement:${arm}_no_applicable_evidence`);
      }
      for (const [candidateObservations, suffix] of [
        [applicable, ""],
        [notApplicable, "non_applicable_safety"],
      ] as const) {
        if (candidateObservations.length === 0) continue;
        const keys = new Set(
          candidateObservations.map(
            ({ fixtureId, repetition }) => `${fixtureId}/${String(repetition)}`,
          ),
        );
        const baselineObservations = observations.filter(
          (observation) =>
            observation.modelSlotId === slotId &&
            observation.arm === baselineArm &&
            keys.has(`${observation.fixtureId}/${String(observation.repetition)}`),
        );
        evaluateIncrementSafety(
          regressions,
          slotId,
          arm,
          baselineArm,
          baselineObservations,
          candidateObservations,
          suffix,
        );
      }
    }
  }
  return regressions;
}

function appliesToIncrement(
  observation: NovelSkillEvaluationObservation,
  arm: Exclude<NovelSkillEvaluationArm, "no_skill">,
): boolean {
  if (arm === "core") return observation.methodApplicability.core;
  if (arm === "core_genre") return observation.methodApplicability.genre;
  return true;
}

function evaluateIncrementSafety(
  regressions: string[],
  slotId: string,
  arm: Exclude<NovelSkillEvaluationArm, "no_skill">,
  baselineArm: NovelSkillEvaluationArm,
  baselineObservations: readonly NovelSkillEvaluationObservation[],
  candidateObservations: readonly NovelSkillEvaluationObservation[],
  suffix: string,
): void {
  const label = suffix === "" ? `${arm}_below_${baselineArm}` : `${arm}_${suffix}`;
  const guardLabel = suffix === "" ? `${arm}_above_${baselineArm}` : `${arm}_${suffix}`;
  const costLabel = suffix === "" ? arm : `${arm}_${suffix}`;
  for (const { metric, blocking } of METRIC_DEFINITIONS) {
    if (!blocking) continue;
    const baselineValues = baselineObservations
      .map(({ scores }) => scores[metric])
      .filter((value): value is number => value !== null);
    const candidateValues = candidateObservations
      .map(({ scores }) => scores[metric])
      .filter((value): value is number => value !== null);
    if (
      baselineValues.length > 0 &&
      candidateValues.length > 0 &&
      mean(candidateValues) + 0.02 < mean(baselineValues)
    ) {
      regressions.push(`${slotId}:${metric}:${label}`);
    }
  }
  if (suffix === "") {
    const baselineOverall = meanAllScores(baselineObservations);
    const candidateOverall = meanAllScores(candidateObservations);
    if (
      baselineObservations.length !== candidateObservations.length ||
      baselineOverall === null ||
      candidateOverall === null ||
      candidateOverall < baselineOverall + 0.02
    ) {
      regressions.push(`${slotId}:improvement:${arm}_no_demonstrated_improvement`);
    }
    for (const repetition of [1, 2] as const) {
      const baselineRepetition = meanAllScores(
        baselineObservations.filter((observation) => observation.repetition === repetition),
      );
      const candidateRepetition = meanAllScores(
        candidateObservations.filter((observation) => observation.repetition === repetition),
      );
      if (
        baselineRepetition === null ||
        candidateRepetition === null ||
        candidateRepetition <= baselineRepetition
      ) {
        regressions.push(
          `${slotId}:improvement:${arm}_repetition_${String(repetition)}_not_positive`,
        );
      }
    }
  }
  const baselineLatency = mean(
    baselineObservations.map(({ latencyMilliseconds }) => latencyMilliseconds),
  );
  const candidateLatency = mean(
    candidateObservations.map(({ latencyMilliseconds }) => latencyMilliseconds),
  );
  if (candidateLatency > Math.max(baselineLatency * 2, baselineLatency + 5_000)) {
    regressions.push(`${slotId}:latency:${guardLabel}`);
  }
  const baselineCosts = baselineObservations.map(({ estimatedCostMicros }) => estimatedCostMicros);
  const candidateCosts = candidateObservations.map(
    ({ estimatedCostMicros }) => estimatedCostMicros,
  );
  const baselineCost = meanNullable(baselineCosts);
  const candidateCost = meanNullable(candidateCosts);
  if (
    baselineCosts.some((value) => value === null) ||
    candidateCosts.some((value) => value === null) ||
    baselineCost === null ||
    candidateCost === null
  ) {
    regressions.push(`${slotId}:cost:${costLabel}_evidence_missing`);
  } else if (candidateCost > Math.max(baselineCost * 2, baselineCost + 1_000)) {
    regressions.push(`${slotId}:cost:${guardLabel}`);
  }
}

function validateEvaluationInputs(
  observationValues: unknown,
  expectedModelSlotValues: unknown,
): asserts observationValues is readonly NovelSkillEvaluationObservation[] {
  if (!Array.isArray(observationValues) || !Array.isArray(expectedModelSlotValues)) {
    throw new Error("Novel skill evaluation model tiers must be unique portable identifiers.");
  }
  const observations = observationValues as readonly unknown[];
  const expectedModelSlots = expectedModelSlotValues as readonly unknown[];
  if (
    expectedModelSlots.length !== 2 ||
    expectedModelSlots.some(
      (slot) =>
        slot === null ||
        typeof slot !== "object" ||
        !["text_tier_a", "text_tier_b"].includes(
          String((slot as { readonly slotId?: unknown }).slotId),
        ) ||
        typeof (slot as { readonly modelTier?: unknown }).modelTier !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test((slot as { readonly modelTier: string }).modelTier),
    ) ||
    new Set(expectedModelSlots.map((slot) => (slot as { readonly slotId: string }).slotId)).size !==
      2 ||
    new Set(expectedModelSlots.map((slot) => (slot as { readonly modelTier: string }).modelTier))
      .size !== 2
  ) {
    throw new Error("Novel skill evaluation model tiers must be unique portable identifiers.");
  }
  const modelSlots = expectedModelSlots as unknown as readonly NovelSkillEvaluationModelSlot[];
  const fixtureIds = new Set(listNovelSkillEvaluationFixtures().map(({ fixtureId }) => fixtureId));
  const observationIds = new Set<string>();
  const modelInvocationIds = new Set<string>();
  const cellRepetitions = new Set<string>();
  for (const value of observations) {
    assertExactObservationKeys(value);
    const observation = value;
    const cellRepetition = `${observation.fixtureId}/${observation.arm}/${observation.modelSlotId}/${String(observation.repetition)}`;
    if (
      observationIds.has(observation.observationId) ||
      modelInvocationIds.has(observation.modelInvocationId) ||
      cellRepetitions.has(cellRepetition) ||
      !isPortableEvaluationId(observation.observationId) ||
      !isPortableEvaluationId(observation.modelInvocationId) ||
      !fixtureIds.has(observation.fixtureId) ||
      !NOVEL_SKILL_EVALUATION_ARMS.includes(observation.arm) ||
      !modelSlots.some(
        ({ slotId, modelTier }) =>
          observation.modelSlotId === slotId && observation.modelTier === modelTier,
      ) ||
      !Number.isSafeInteger(observation.repetition) ||
      observation.repetition < 1 ||
      observation.repetition > 2 ||
      !isEvaluationVersionSupported(observation.evaluatorVersion) ||
      observation.completionStatus !== "succeeded" ||
      !Number.isSafeInteger(observation.visibleContentLength) ||
      observation.visibleContentLength < 1 ||
      (observation.finishReason !== null &&
        (typeof observation.finishReason !== "string" ||
          !/^[a-z][a-z0-9_.-]{0,63}$/u.test(observation.finishReason) ||
          ["length", "max_tokens", "max_output_tokens"].includes(observation.finishReason))) ||
      !Number.isSafeInteger(observation.latencyMilliseconds) ||
      observation.latencyMilliseconds < 0 ||
      !isNullableNonNegativeInteger(observation.inputTokens) ||
      !isNullableNonNegativeInteger(observation.outputTokens) ||
      !isNullableNonNegativeInteger(observation.estimatedCostMicros)
    ) {
      throw new Error("Novel skill evaluation observation is invalid or not auditable.");
    }
    assertExactScoreKeys(observation.scores);
    for (const metric of NOVEL_SKILL_EVALUATION_METRICS) {
      const value = observation.scores[metric];
      if (value === null || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(
          "Novel skill evaluation requires all thirteen scores between zero and one.",
        );
      }
    }
    observationIds.add(observation.observationId);
    modelInvocationIds.add(observation.modelInvocationId);
    cellRepetitions.add(cellRepetition);
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : mean(present);
}

function meanAllScores(observations: readonly NovelSkillEvaluationObservation[]): number | null {
  if (observations.length === 0) return null;
  const scores = observations.flatMap(({ scores: observationScores }) =>
    NOVEL_SKILL_EVALUATION_METRICS.map((metric) => observationScores[metric]),
  );
  if (scores.some((score) => score === null)) return null;
  return mean(scores as number[]);
}

function assertExactObservationKeys(
  value: unknown,
): asserts value is NovelSkillEvaluationObservation {
  assertExactPlainObjectKeys(
    value,
    [
      "observationId",
      "fixtureId",
      "arm",
      "modelSlotId",
      "modelTier",
      "repetition",
      "modelInvocationId",
      "evaluatorVersion",
      "completionStatus",
      "visibleContentLength",
      "finishReason",
      "methodApplicability",
      "scores",
      "latencyMilliseconds",
      "inputTokens",
      "outputTokens",
      "estimatedCostMicros",
    ],
    "Novel skill evaluation observation",
  );
  assertExactPlainObjectKeys(
    value.methodApplicability,
    ["core", "genre"],
    "Novel skill evaluation method applicability",
  );
  if (
    typeof value.methodApplicability.core !== "boolean" ||
    typeof value.methodApplicability.genre !== "boolean" ||
    (value.arm === "no_skill" &&
      (value.methodApplicability.core || value.methodApplicability.genre)) ||
    (value.arm === "core" && value.methodApplicability.genre)
  ) {
    throw new Error("Novel skill evaluation method applicability is invalid.");
  }
}

function assertExactScoreKeys(
  value: unknown,
): asserts value is Readonly<Record<NovelSkillEvaluationMetric, number | null>> {
  assertExactPlainObjectKeys(value, NOVEL_SKILL_EVALUATION_METRICS, "Evaluation scores");
}

function assertExactPlainObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  ) {
    throw new Error(`${field} must be a plain object.`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} contains missing or unsupported fields.`);
  }
}

function isPortableEvaluationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value);
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isEvaluationVersionSupported(value: unknown): value is "novel-skill-ab@1" {
  return value === "novel-skill-ab@1";
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export const NOVEL_SKILL_EVALUATION_FIXTURES: readonly NovelSkillEvaluationFixture[] = [
  {
    fixtureId: "zh.campus.first_person.continuation",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "continuation",
    invocationMode: "draft",
    // This original campus-romance contract also exercises the light-novel
    // method. Keep the matrix at 12 fixtures while proving every target genre
    // Skill has at least one genuinely applicable cell.
    genreTags: ["campus_romance", "light_novel"],
    coverageDimensions: ["youth_romance", "light_novel", "pov", "continuation"],
    input:
      "我把借来的伞靠在教室后门。周岚不知道伞柄里夹着她上周遗失的车票，我也不准备现在告诉她。走廊尽头传来班主任的脚步声。",
    lockedFacts: ["叙述者知道车票藏在伞柄里", "周岚尚不知道车票位置"],
    boundaries: ["保持第一人称限知", "不得让周岚无来源地知道车票位置"],
    requestedOutcome: "续写一个由班主任到来触发的小冲突，不揭开车票秘密。",
  },
  {
    fixtureId: "zh.mystery.third_limited.pov",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "pov_check",
    invocationMode: "critic",
    genreTags: ["mystery"],
    coverageDimensions: ["suspense", "pov"],
    input:
      "许棠只看见管理员把右手藏到背后。管理员其实握着失窃仓库的备用钥匙，并在心里盘算今晚离城。许棠问他是否受伤。",
    lockedFacts: ["许棠只看见管理员藏起右手", "管理员持有钥匙但未向许棠公开"],
    boundaries: ["区分叙述事实与许棠可知信息", "问题报告必须引用越界句"],
    requestedOutcome: "识别限知视角越界并给出最小修改方向。",
  },
  {
    fixtureId: "zh.fantasy.causal.scene",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "scene_breakdown",
    invocationMode: "collaborator",
    genreTags: ["fantasy"],
    coverageDimensions: ["fantasy"],
    input:
      "城门会在落日后封锁。顾遥的通行印已经碎裂，而药师必须在钟响前见到城外的病人。守门人欠顾遥一次人情，但不能违抗公开命令。",
    lockedFacts: ["通行印已经碎裂", "守门人不能公开违令", "药师必须在钟响前出城"],
    boundaries: ["不能凭空恢复通行印", "解决方案要产生后续代价"],
    requestedOutcome: "拆成目标、阻力、选择和后果明确的一场戏。",
  },
  {
    fixtureId: "zh.web_serial.action_specificity",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "prose_generation",
    invocationMode: "draft",
    genreTags: ["web_serial"],
    coverageDimensions: ["web_novel"],
    input:
      "仓库断电后，沈阔必须在三分钟内找到被转移的账本。追兵已经封住正门，他左手受伤，不能稳定握住重物。",
    lockedFacts: ["剩余时间三分钟", "正门被封", "沈阔左手受伤"],
    boundaries: ["不得突然治愈左手", "不得加入未提供的超自然能力"],
    requestedOutcome: "写一段节奏紧凑、动作空间清楚的搜寻场景。",
  },
  {
    fixtureId: "zh.family.rewrite_scope",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "rewrite",
    invocationMode: "revision",
    genreTags: ["family_drama"],
    coverageDimensions: ["literary", "rewrite"],
    input:
      "父亲把饭盒放在桌上，说自己只是顺路。陈禾知道他坐了两小时公交，却没有拆穿。窗外很冷，屋里也很冷。",
    lockedFacts: ["父亲坐了两小时公交", "陈禾知道但没有拆穿", "父亲声称顺路"],
    boundaries: ["不改变父女关系和事件", "不新增争吵或和解"],
    requestedOutcome: "只减少重复的冷感表达，并保留克制语气。",
  },
  {
    fixtureId: "zh.multiline.continuity",
    language: "zh-CN",
    origin: "inkshadow_original",
    taskType: "contradiction_check",
    invocationMode: "critic",
    genreTags: ["ensemble"],
    coverageDimensions: ["multi_character_dialogue"],
    input:
      "上午九点，姜予在南港登上封闭航班。十点半，北城支线写道姜予亲自把档案交给林昭。两地常规交通至少需要四小时，故事尚未建立瞬移或替身规则。",
    lockedFacts: ["姜予九点在南港登机", "南港到北城至少四小时", "没有瞬移或替身规则"],
    boundaries: ["只报告有证据的时间地点冲突", "不得自行补造交通方式"],
    requestedOutcome: "给出冲突证据、严重度和可选修复方向。",
  },
] as const;
