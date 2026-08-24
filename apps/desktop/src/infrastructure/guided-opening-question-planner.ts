import { parseUuidV7, type ProjectSeed, type ProjectSeedFieldKey } from "@inkshadow/domain";

import {
  executeModelHubTextTask,
  inspectModelHubTextTask,
  ModelHubExecutionError,
} from "./model-hub-execution-service";
import { selectSingleAttemptStrictJsonPolicy } from "./model-execution-policy";
import { getModelProviderPreset } from "./model-hub-provider-registry";
import { recordSafeGenerationErrorCode } from "./generation-preflight-diagnostics";
import { GUIDED_OPENING_QUESTION_CATALOG } from "./guided-opening-question-catalog";
import { resolveModelCapabilityVerdict } from "./model-hub-router";
import {
  projectContextDispatchScope,
  projectContextRequiredDataDestination,
} from "./project-context-privacy-authority";
import type { DesktopRuntime, NativeModelMessage } from "./runtime";

export type GuidedOpeningQuestionSource = "ai" | "deterministic_fallback";

export interface GuidedOpeningQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly purpose: string;
  readonly targetFields: readonly ProjectSeedFieldKey[];
  readonly options: readonly string[];
  readonly allowCustom: boolean;
  readonly reasonForAsking: string;
  readonly source: GuidedOpeningQuestionSource;
  readonly placeholder: string;
}

export interface GuidedOpeningGapAnalysis {
  readonly known: readonly ProjectSeedFieldKey[];
  readonly missing: readonly ProjectSeedFieldKey[];
  readonly ambiguous: readonly ProjectSeedFieldKey[];
  readonly conflicting: readonly ProjectSeedFieldKey[];
  readonly optional: readonly ProjectSeedFieldKey[];
}

export interface GuidedOpeningQuestionPlan {
  readonly version: 1;
  readonly source: GuidedOpeningQuestionSource;
  readonly gaps: GuidedOpeningGapAnalysis;
  readonly questions: readonly GuidedOpeningQuestion[];
  /** Content-free reason explaining why the deterministic path was used. */
  readonly fallbackReasonCode: string | null;
}

export interface GuidedOpeningPlannerInput {
  readonly originalIdea: string;
  readonly selectedOpening: string;
  readonly answers: Readonly<Record<string, string>>;
  readonly projectSeed: ProjectSeed;
  /**
   * A new blank workspace has no authoritative writing-preferences record yet.
   * Preferences are therefore read only from confirmed ProjectSeed/answers;
   * this planner must never invent a parallel preference object.
   */
  readonly projectContext: Readonly<{ projectId: string; chapterId: string }>;
  readonly assertBeforeProviderDispatch?: () => void;
}

const CORE_FIELDS: readonly ProjectSeedFieldKey[] = Object.freeze([
  "currentDirection",
  "characters",
  "conflict",
  "relationships",
  "pov",
  "tone",
  "genre",
  "world",
  "style",
  "boundaries",
]);

const OPTIONAL_FIELDS = new Set<ProjectSeedFieldKey>(["world", "style", "boundaries"]);
const CORE_FIELD_SET = new Set<ProjectSeedFieldKey>(CORE_FIELDS);

const QUESTION_ID_BY_FIELD: Readonly<Record<ProjectSeedFieldKey, string>> = Object.freeze({
  premise: "premise",
  genre: "genre",
  tone: "tone",
  characters: "protagonist",
  relationships: "relationship",
  world: "world",
  conflict: "conflict",
  style: "style",
  pov: "pov",
  boundaries: "boundaries",
  currentDirection: "opening_direction",
  initialOutline: "outline",
  rewriteRules: "rewrite_rules",
});

const BASE_QUESTION_BY_FIELD = new Map<ProjectSeedFieldKey, GuidedOpeningQuestion>(
  GUIDED_OPENING_QUESTION_CATALOG.flatMap((template) => {
    const [field] = template.targetFields;
    return field !== undefined && template.key === QUESTION_ID_BY_FIELD[field]
      ? ([[field, fallbackQuestion(template)]] as const)
      : [];
  }),
);

export function analyzeGuidedOpeningGaps(
  input: Pick<
    GuidedOpeningPlannerInput,
    "originalIdea" | "selectedOpening" | "answers" | "projectSeed"
  >,
): GuidedOpeningGapAnalysis {
  const known = new Set<ProjectSeedFieldKey>();
  const ambiguous = new Set<ProjectSeedFieldKey>();
  const conflicting = new Set<ProjectSeedFieldKey>();
  const optional = new Set<ProjectSeedFieldKey>();

  for (const field of CORE_FIELDS) {
    const seedField = input.projectSeed[field];
    if (seedField.confirmation === "confirmed" && seedField.values.length > 0) {
      known.add(field);
    } else if (seedField.confirmation === "unconfirmed" && seedField.values.length > 0) {
      ambiguous.add(field);
    } else if (seedField.confirmation === "skipped" || OPTIONAL_FIELDS.has(field)) {
      optional.add(field);
    }
  }

  const idea = input.originalIdea.normalize("NFC");
  if (/悬疑|推理|恋爱|言情|科幻|奇幻|都市|历史|轻小说/u.test(idea)) {
    known.add("genre");
    ambiguous.delete("genre");
  }
  if (/温暖|治愈|甜|搞笑|轻松|紧张|压抑|克制|伤感|恐怖/u.test(idea)) {
    known.add("tone");
    ambiguous.delete("tone");
  }

  const opening = input.selectedOpening.normalize("NFC");
  const firstPersonEvidence = /(^|[。！？\n])\s*我(?:们)?[，。！？、\s]/u.test(opening);
  const thirdPersonEvidence = /(^|[。！？\n])\s*(?:他|她|他们|她们)[，。！？、\s]/u.test(opening);
  if (firstPersonEvidence && thirdPersonEvidence) {
    known.delete("pov");
    ambiguous.delete("pov");
    conflicting.add("pov");
  } else if (firstPersonEvidence || thirdPersonEvidence) {
    known.add("pov");
    ambiguous.delete("pov");
  }

  for (const field of CORE_FIELDS) {
    const answerKey = QUESTION_ID_BY_FIELD[field];
    const answer = input.answers[answerKey]?.normalize("NFC").trim() ?? "";
    if (answer.length > 0) {
      known.add(field);
      ambiguous.delete(field);
      conflicting.delete(field);
      optional.delete(field);
    }
  }

  const missing = CORE_FIELDS.filter(
    (field) =>
      !known.has(field) && !ambiguous.has(field) && !conflicting.has(field) && !optional.has(field),
  );
  return Object.freeze({
    known: frozenFields(CORE_FIELDS.filter((field) => known.has(field))),
    missing: frozenFields(missing),
    ambiguous: frozenFields(CORE_FIELDS.filter((field) => ambiguous.has(field))),
    conflicting: frozenFields(CORE_FIELDS.filter((field) => conflicting.has(field))),
    optional: frozenFields(CORE_FIELDS.filter((field) => optional.has(field))),
  });
}

export function createDeterministicGuidedOpeningPlan(
  input: Pick<
    GuidedOpeningPlannerInput,
    "originalIdea" | "selectedOpening" | "answers" | "projectSeed"
  >,
  fallbackReasonCode = "AI_PLANNER_NOT_ATTEMPTED",
): GuidedOpeningQuestionPlan {
  const gaps = analyzeGuidedOpeningGaps(input);
  const actionable = new Set<ProjectSeedFieldKey>([
    ...gaps.conflicting,
    ...gaps.missing,
    ...gaps.ambiguous,
  ]);
  const questions = CORE_FIELDS.filter((field) => actionable.has(field))
    .slice(0, 3)
    .map((field) => BASE_QUESTION_BY_FIELD.get(field))
    .filter((question): question is GuidedOpeningQuestion => question !== undefined);
  return Object.freeze({
    version: 1,
    source: "deterministic_fallback",
    gaps,
    questions: Object.freeze(questions),
    fallbackReasonCode,
  });
}

/**
 * Attempts one bounded, schema-validated question-planner call. Any unavailable
 * route, privacy refusal, provider failure, truncation, or invalid JSON becomes
 * an explicit deterministic fallback and never blocks local project creation.
 */
export async function planGuidedOpeningQuestions(
  runtime: DesktopRuntime,
  input: GuidedOpeningPlannerInput,
): Promise<GuidedOpeningQuestionPlan> {
  const fallback = createDeterministicGuidedOpeningPlan(input);
  if (fallback.questions.length === 0) {
    return Object.freeze({ ...fallback, fallbackReasonCode: "NO_ACTIONABLE_GAPS" });
  }
  try {
    const projectId = parseUuidV7(input.projectContext.projectId);
    const chapterId = parseUuidV7(input.projectContext.chapterId);
    if (!projectId.ok) throw projectId.error;
    if (!chapterId.ok) throw chapterId.error;
    const chapterResult = await runtime.repositories.chapters.findById(chapterId.value);
    if (!chapterResult.ok) throw chapterResult.error;
    const chapter = chapterResult.value;
    if (chapter?.projectId !== projectId.value || chapter.status !== "active") {
      throw plannerError("GUIDED_OPENING_PLANNER_WORKSPACE_CHANGED");
    }
    const receipt = await runtime.projectContextPrivacy.inspect(projectId.value);
    runtime.projectContextPrivacy.assertChapterMatches(receipt, chapter);
    const messages = plannerMessages(input, fallback.gaps);
    const inspection = await inspectModelHubTextTask(runtime, {
      task: "idea_discussion",
      messages,
      maximumOutputTokens: 1_200,
      temperature: 0.2,
      capabilityPolicy: "text_generation_only",
      ...(projectContextRequiredDataDestination(receipt) === undefined
        ? {}
        : { requiredDataDestination: "local" as const }),
    });
    const structuredOutputSupported =
      resolveModelCapabilityVerdict({
        catalogEntryId: inspection.catalogEntryId,
        capability: "structured_output",
        evidence: await runtime.modelHub.listCapabilityEvidence(inspection.catalogEntryId),
        now: runtime.clock.now(),
      }) === "supported";
    const assertStructuredOutputCurrent = async (catalogEntryId: string) => {
      if (!structuredOutputSupported) return;
      const verdict = resolveModelCapabilityVerdict({
        catalogEntryId,
        capability: "structured_output",
        evidence: await runtime.modelHub.listCapabilityEvidence(catalogEntryId),
        now: runtime.clock.now(),
      });
      if (verdict !== "supported") {
        throw new ModelHubExecutionError(
          "MODEL_HUB_STRUCTURED_OUTPUT_NOT_VERIFIED",
          "问题规划发送前无法确认结构化输出能力，本次请求在发送 0 字后停止。",
        );
      }
    };
    const executionPolicy = selectSingleAttemptStrictJsonPolicy({
      structuredOutputVerified: structuredOutputSupported,
      jsonObjectTransportSupported:
        getModelProviderPreset(inspection.providerKind).protocol === "openai_compatible",
    });
    const generated = await executeModelHubTextTask(runtime, {
      task: "idea_discussion",
      dispatchScope: projectContextDispatchScope(receipt),
      messages,
      maximumOutputTokens: 1_200,
      temperature: 0.2,
      executionPolicy,
      reasoningModeOverride: "disabled",
      generationRetryLimitOverride: 0,
      capabilityPolicy: "text_generation_only",
      ...(executionPolicy.transportResponseFormat === "json_object"
        ? { responseFormat: "json_object" as const }
        : {}),
      validateGeneratedText: (text) => {
        parseAiQuestions(text, fallback.gaps);
      },
      ...(projectContextRequiredDataDestination(receipt) === undefined
        ? {}
        : { requiredDataDestination: "local" as const }),
      onBeforeDispatch: async (selection) => {
        if (
          selection.connectionId !== inspection.connectionId ||
          selection.catalogEntryId !== inspection.catalogEntryId ||
          selection.modelId !== inspection.modelId ||
          selection.usedFallback !== inspection.usedFallback
        ) {
          throw new ModelHubExecutionError(
            "MODEL_HUB_PLAN_CHANGED",
            "问题规划发送前创作任务安排发生了变化，请重新整理问题。",
            true,
          );
        }
        await assertStructuredOutputCurrent(selection.catalogEntryId);
        await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(receipt);
        runtime.projectContextPrivacy.assertRouteEligible(
          receipt,
          selection.localOnlyEligible === true,
        );
      },
      onFinalBeforeProviderDispatch: async ({ catalogEntryId, localOnlyEligible }) => {
        await assertStructuredOutputCurrent(catalogEntryId);
        await runtime.projectContextPrivacy.assertCurrentBeforeDispatch(receipt);
        runtime.projectContextPrivacy.assertRouteEligible(receipt, localOnlyEligible === true);
      },
      ...(input.assertBeforeProviderDispatch === undefined
        ? {}
        : { assertBeforeProviderDispatch: input.assertBeforeProviderDispatch }),
    });
    const questions = parseAiQuestions(generated.text, fallback.gaps);
    return Object.freeze({
      version: 1,
      source: "ai",
      gaps: fallback.gaps,
      questions,
      fallbackReasonCode: null,
    });
  } catch (cause: unknown) {
    const fallbackReasonCode = safePlannerFailureCode(cause);
    recordSafeGenerationErrorCode(runtime, fallbackReasonCode);
    return Object.freeze({
      ...fallback,
      fallbackReasonCode,
    });
  }
}

export function questionIdForProjectSeedField(field: ProjectSeedFieldKey): string {
  return QUESTION_ID_BY_FIELD[field];
}

export function parseGuidedOpeningQuestionPlan(value: unknown): GuidedOpeningQuestionPlan | null {
  if (!isRecord(value) || value.version !== 1 || !isPlanSource(value.source)) return null;
  if (!isGapAnalysis(value.gaps) || !Array.isArray(value.questions)) return null;
  if (
    (value.fallbackReasonCode !== null &&
      (typeof value.fallbackReasonCode !== "string" ||
        !/^[A-Z][A-Z0-9_]{2,80}$/u.test(value.fallbackReasonCode))) ||
    (value.source === "ai" && value.fallbackReasonCode !== null)
  ) {
    return null;
  }
  try {
    const allowed = new Set<ProjectSeedFieldKey>([
      ...value.gaps.missing,
      ...value.gaps.ambiguous,
      ...value.gaps.conflicting,
    ]);
    const questions = validateQuestionArray(value.questions, allowed, value.source, true);
    return Object.freeze({
      version: 1,
      source: value.source,
      gaps: freezeGapAnalysis(value.gaps),
      questions,
      fallbackReasonCode: value.fallbackReasonCode,
    });
  } catch {
    return null;
  }
}

function plannerMessages(
  input: GuidedOpeningPlannerInput,
  gaps: GuidedOpeningGapAnalysis,
): readonly NativeModelMessage[] {
  return Object.freeze([
    Object.freeze({
      role: "system" as const,
      content:
        "你是开书问题规划器。只返回 {questions:[...]} JSON，不写解释或正文。最多 3 问；每问只允许 1 个 targetField，且仅含 questionId、question、purpose、targetFields、options、allowCustom、reasonForAsking。只问输入所列缺口，不重复，不把推测当事实。",
    }),
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify(buildGuidedOpeningPlannerPayload(input, gaps)),
    }),
  ]);
}

export function buildGuidedOpeningPlannerPayload(
  input: Pick<
    GuidedOpeningPlannerInput,
    "originalIdea" | "selectedOpening" | "answers" | "projectSeed"
  >,
  gaps = analyzeGuidedOpeningGaps(input),
): Readonly<Record<string, unknown>> {
  const projectSeed = Object.fromEntries(
    (Object.keys(QUESTION_ID_BY_FIELD) as ProjectSeedFieldKey[]).map((field) => [
      field,
      Object.freeze({
        confirmation: input.projectSeed[field].confirmation,
        values: boundedProjectionTexts(input.projectSeed[field].values),
      }),
    ]),
  );
  return Object.freeze({
    originalUserIntent: boundedProjectionText(input.originalIdea, 4_000),
    existingText: boundedProjectionText(input.selectedOpening, 16_000),
    confirmedAnswers: Object.fromEntries(
      Object.entries(input.answers)
        .slice(0, 24)
        .map(([key, value]) => [key, boundedProjectionText(value, 1_000)]),
    ),
    projectSeed,
    characters: projectSeed.characters,
    relationships: projectSeed.relationships,
    worldRules: (projectSeed.world as Readonly<{ values: readonly string[] }>).values,
    writingPreferences: Object.freeze([
      ...new Set([
        ...boundedProjectionTexts(input.projectSeed.style.values),
        ...boundedProjectionTexts(input.projectSeed.rewriteRules.values),
      ]),
    ]),
    knownPov: (projectSeed.pov as Readonly<{ values: readonly string[] }>).values,
    knownGenre: (projectSeed.genre as Readonly<{ values: readonly string[] }>).values,
    openQuestions: Object.freeze([...gaps.conflicting, ...gaps.missing, ...gaps.ambiguous]),
    gaps,
    allowedQuestionIds: Object.fromEntries(
      [...gaps.missing, ...gaps.ambiguous, ...gaps.conflicting].map((field) => [
        field,
        QUESTION_ID_BY_FIELD[field],
      ]),
    ),
  });
}

function parseAiQuestions(
  text: string,
  gaps: GuidedOpeningGapAnalysis,
): readonly GuidedOpeningQuestion[] {
  const parsed: unknown = JSON.parse(text.normalize("NFC").trim());
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["questions"]) ||
    !Array.isArray(parsed.questions)
  ) {
    throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
  }
  const allowed = new Set<ProjectSeedFieldKey>([
    ...gaps.missing,
    ...gaps.ambiguous,
    ...gaps.conflicting,
  ]);
  const questions = validateQuestionArray(parsed.questions, allowed, "ai", false);
  if (allowed.size > 0 && questions.length === 0) {
    throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
  }
  return questions;
}

function validateQuestionArray(
  values: readonly unknown[],
  allowed: ReadonlySet<ProjectSeedFieldKey>,
  source: GuidedOpeningQuestionSource,
  persistedShape: boolean,
): readonly GuidedOpeningQuestion[] {
  if (values.length > 3 || (!persistedShape && values.length === 0)) {
    throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
  }
  const usedIds = new Set<string>();
  const usedFields = new Set<ProjectSeedFieldKey>();
  const questions = values.map((value) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(
        value,
        persistedShape
          ? [
              "questionId",
              "question",
              "purpose",
              "targetFields",
              "options",
              "allowCustom",
              "reasonForAsking",
              "source",
              "placeholder",
            ]
          : [
              "questionId",
              "question",
              "purpose",
              "targetFields",
              "options",
              "allowCustom",
              "reasonForAsking",
            ],
      ) ||
      typeof value.questionId !== "string" ||
      typeof value.question !== "string" ||
      typeof value.purpose !== "string" ||
      !Array.isArray(value.targetFields) ||
      !Array.isArray(value.options) ||
      typeof value.allowCustom !== "boolean" ||
      typeof value.reasonForAsking !== "string" ||
      (persistedShape && (value.source !== source || typeof value.placeholder !== "string"))
    ) {
      throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
    }
    const targetFields = value.targetFields.map(requireProjectSeedFieldKey);
    const primaryTargetField = targetFields[0];
    if (
      primaryTargetField === undefined ||
      targetFields.length !== 1 ||
      targetFields.some((field) => !allowed.has(field) || usedFields.has(field)) ||
      value.questionId !== QUESTION_ID_BY_FIELD[primaryTargetField] ||
      usedIds.has(value.questionId)
    ) {
      throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
    }
    const options = value.options.map((option) => requireSafeText(option, 1, 80));
    if (options.length < 2 || options.length > 5 || new Set(options).size !== options.length) {
      throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
    }
    usedIds.add(value.questionId);
    for (const field of targetFields) usedFields.add(field);
    const base = BASE_QUESTION_BY_FIELD.get(primaryTargetField);
    return Object.freeze({
      questionId: requireSafeIdentifier(value.questionId),
      question: requireSafeText(value.question, 2, 240),
      purpose: requireSafeText(value.purpose, 2, 240),
      targetFields: Object.freeze(targetFields),
      options: Object.freeze(options),
      allowCustom: value.allowCustom,
      reasonForAsking: requireSafeText(value.reasonForAsking, 2, 300),
      source,
      placeholder:
        persistedShape && typeof value.placeholder === "string"
          ? requireSafeText(value.placeholder, 1, 300)
          : (base?.placeholder ?? "用自然语言回答即可。"),
    });
  });
  return Object.freeze(questions);
}

function fallbackQuestion(
  template: (typeof GUIDED_OPENING_QUESTION_CATALOG)[number],
): GuidedOpeningQuestion {
  return Object.freeze({
    questionId: template.key,
    question: template.prompt,
    purpose: template.helper,
    targetFields: template.targetFields,
    options: template.options,
    allowCustom: true,
    reasonForAsking: template.helper,
    source: "deterministic_fallback",
    placeholder: template.placeholder,
  });
}

function frozenFields(values: readonly ProjectSeedFieldKey[]): readonly ProjectSeedFieldKey[] {
  return Object.freeze([...values]);
}

function isGapAnalysis(value: unknown): value is GuidedOpeningGapAnalysis {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["known", "missing", "ambiguous", "conflicting", "optional"])
  ) {
    return false;
  }
  const seen = new Set<ProjectSeedFieldKey>();
  const valid = ["known", "missing", "ambiguous", "conflicting", "optional"].every((key) => {
    const fields = value[key];
    if (!Array.isArray(fields)) return false;
    for (const field of fields) {
      if (!isProjectSeedFieldKey(field) || !CORE_FIELD_SET.has(field) || seen.has(field))
        return false;
      seen.add(field);
    }
    return true;
  });
  return valid && seen.size === CORE_FIELDS.length;
}

function freezeGapAnalysis(value: GuidedOpeningGapAnalysis): GuidedOpeningGapAnalysis {
  return Object.freeze({
    known: frozenFields(value.known),
    missing: frozenFields(value.missing),
    ambiguous: frozenFields(value.ambiguous),
    conflicting: frozenFields(value.conflicting),
    optional: frozenFields(value.optional),
  });
}

function requireProjectSeedFieldKey(value: unknown): ProjectSeedFieldKey {
  if (!isProjectSeedFieldKey(value)) throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
  return value;
}

function isProjectSeedFieldKey(value: unknown): value is ProjectSeedFieldKey {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(QUESTION_ID_BY_FIELD, value)
  );
}

function requireSafeIdentifier(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!/^[a-z][a-z0-9_]{1,63}$/u.test(normalized)) {
    throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
  }
  return normalized;
}

function requireSafeText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string") throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
  const normalized = value.normalize("NFC").replaceAll(/\r\n?/gu, "\n").trim();
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw plannerError("GUIDED_OPENING_PLANNER_SCHEMA_INVALID");
  }
  return normalized;
}

function boundedProjectionTexts(values: readonly string[]): readonly string[] {
  return Object.freeze(
    values
      .slice(0, 4)
      .map((value) => boundedProjectionText(value, 500))
      .filter((value) => value.length > 0),
  );
}

function boundedProjectionText(value: string, maximum: number): string {
  const normalized = value
    .normalize("NFC")
    .replaceAll(/\r\n?/gu, "\n")
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  return normalized.slice(0, maximum);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isPlanSource(value: unknown): value is GuidedOpeningQuestionSource {
  return value === "ai" || value === "deterministic_fallback";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePlannerFailureCode(cause: unknown): string {
  if (
    isRecord(cause) &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
  ) {
    return cause.code;
  }
  return "GUIDED_OPENING_PLANNER_UNAVAILABLE";
}

function plannerError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}
