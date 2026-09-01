export const CONTINUATION_OUTPUT_PROFILE_IDS = ["short", "standard", "long", "custom"] as const;

export type ContinuationOutputProfileId = (typeof CONTINUATION_OUTPUT_PROFILE_IDS)[number];

export const CONTINUATION_DESTINATION_IDS = [
  "complete_scene",
  "next_segment",
  "custom_instruction",
] as const;
export type ContinuationDestinationId = (typeof CONTINUATION_DESTINATION_IDS)[number];

export type TaskThinkingPolicy =
  "disabled_for_visible_prose" | "disabled_for_structured_output" | "provider_default";
export type TaskTruncationPolicy = "preserve_partial_candidate";
export type TaskContinuationPolicy = "resume_without_repetition";

export const TASK_OUTPUT_PROFILE_TASKS = [
  "book_start",
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
  "expand",
  "shorten",
  "import_rewrite",
  "chapter_summary",
  "story_fact_extraction",
  "what_if",
  "validation",
  "multi_agent",
] as const;

export type TaskOutputProfileTask = (typeof TASK_OUTPUT_PROFILE_TASKS)[number];

export interface TaskOutputProfileDefinition {
  readonly task: TaskOutputProfileTask;
  readonly outputKind: "visible_prose" | "plain_summary" | "structured_data" | "review_findings";
  readonly thinkingPolicy: TaskThinkingPolicy;
  readonly truncationPolicy: "preserve_partial_candidate" | "fail_without_promotion";
  /** Whether the production task uses the shared visible-prose prompt and output boundary. */
  readonly implementationStatus: "wired" | "registry_only";
}

export const TASK_OUTPUT_PROFILE_REGISTRY: Readonly<
  Record<TaskOutputProfileTask, TaskOutputProfileDefinition>
> = Object.freeze(
  Object.fromEntries(
    TASK_OUTPUT_PROFILE_TASKS.map((task) => {
      const visibleProse = [
        "book_start",
        "prose_generation",
        "continuation",
        "rewrite",
        "polish",
        "expand",
        "shorten",
        "import_rewrite",
      ].includes(task);
      const outputKind: TaskOutputProfileDefinition["outputKind"] =
        task === "chapter_summary"
          ? "plain_summary"
          : task === "story_fact_extraction" || task === "what_if"
            ? "structured_data"
            : task === "validation" || task === "multi_agent"
              ? "review_findings"
              : "visible_prose";
      return [
        task,
        Object.freeze({
          task,
          outputKind,
          thinkingPolicy: visibleProse
            ? "disabled_for_visible_prose"
            : task === "what_if"
              ? "disabled_for_structured_output"
              : "provider_default",
          truncationPolicy:
            task === "continuation" ? "preserve_partial_candidate" : "fail_without_promotion",
          implementationStatus: visibleProse ? "wired" : "registry_only",
        }),
      ];
    }),
  ) as Record<TaskOutputProfileTask, TaskOutputProfileDefinition>,
);

export interface ContinuationOutputContract {
  readonly taskType: "continuation";
  readonly profile: ContinuationOutputProfileId;
  /** Exact author-specified advanced target; null means the ordinary size preset was used. */
  readonly advancedTargetVisibleCharacters: number | null;
  readonly destination: ContinuationDestinationId;
  readonly customDestinationInstruction: string | null;
  readonly targetUnit: "visible_characters";
  readonly minimumVisibleCharacters: number;
  readonly targetVisibleCharacters: number;
  readonly maximumVisibleCharacters: number;
  readonly estimatedVisibleOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly requestedMaxOutputTokens: number;
  readonly requestedMaxOutputTokensBeforeClamp: number;
  readonly providerOutputLimit: number | null;
  readonly providerLimitClamped: boolean;
  readonly estimateSource: "cjk_conservative";
  readonly thinkingPolicy: TaskThinkingPolicy;
  readonly truncationPolicy: TaskTruncationPolicy;
  readonly continuationPolicy: TaskContinuationPolicy;
}

export interface ResolveContinuationOutputContractInput {
  readonly profile?: ContinuationOutputProfileId;
  readonly customTargetVisibleCharacters?: number | null;
  readonly destination?: ContinuationDestinationId;
  readonly customDestinationInstruction?: string | null;
  readonly providerOutputLimit?: number | null;
}

export const CONTINUATION_OUTPUT_PROFILE_PRESETS: Readonly<
  Record<
    Exclude<ContinuationOutputProfileId, "custom">,
    Readonly<{
      minimumVisibleCharacters: number;
      targetVisibleCharacters: number;
      maximumVisibleCharacters: number;
    }>
  >
> = Object.freeze({
  short: Object.freeze({
    minimumVisibleCharacters: 800,
    targetVisibleCharacters: 1_000,
    maximumVisibleCharacters: 1_200,
  }),
  standard: Object.freeze({
    minimumVisibleCharacters: 1_800,
    targetVisibleCharacters: 2_200,
    maximumVisibleCharacters: 2_500,
  }),
  long: Object.freeze({
    minimumVisibleCharacters: 3_000,
    targetVisibleCharacters: 4_000,
    maximumVisibleCharacters: 5_000,
  }),
});

export const MINIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS = 200;
export const MAXIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS = 12_000;
export const MINIMUM_ADVANCED_RESULT_VISIBLE_CHARACTERS = 160;
export const MAXIMUM_ADVANCED_RESULT_VISIBLE_CHARACTERS = 14_400;
const OUTPUT_TOKEN_ROUNDING = 256;

/**
 * Resolves the author-facing visible-character target into a conservative,
 * model-neutral output reservation. A provider tokenizer can replace this
 * estimate later; callers must never present it as provider billing truth.
 */
export function resolveContinuationOutputContract(
  input: ResolveContinuationOutputContractInput = {},
): ContinuationOutputContract {
  const profile = input.profile ?? "standard";
  if (!(CONTINUATION_OUTPUT_PROFILE_IDS as readonly string[]).includes(profile)) {
    throw new RangeError("Unknown continuation output profile.");
  }
  const hasAdvancedTarget =
    input.customTargetVisibleCharacters !== undefined &&
    input.customTargetVisibleCharacters !== null;
  const range =
    profile === "custom" || hasAdvancedTarget
      ? customRange(input.customTargetVisibleCharacters)
      : CONTINUATION_OUTPUT_PROFILE_PRESETS[profile];
  const destination = input.destination ?? "complete_scene";
  if (!(CONTINUATION_DESTINATION_IDS as readonly string[]).includes(destination)) {
    throw new RangeError("Unknown continuation destination.");
  }
  const customDestinationInstruction = normalizeDestinationInstruction(
    destination,
    input.customDestinationInstruction,
  );
  const estimatedVisibleOutputTokens = Math.ceil(range.targetVisibleCharacters * 1.25);
  const safetyMarginTokens = Math.max(384, Math.ceil(estimatedVisibleOutputTokens * 0.2));
  const requestedMaxOutputTokensBeforeClamp = roundUp(
    estimatedVisibleOutputTokens + safetyMarginTokens,
    OUTPUT_TOKEN_ROUNDING,
  );
  const providerOutputLimit = normalizeOptionalLimit(input.providerOutputLimit);
  const requestedMaxOutputTokens =
    providerOutputLimit === null
      ? requestedMaxOutputTokensBeforeClamp
      : Math.min(requestedMaxOutputTokensBeforeClamp, providerOutputLimit);
  return Object.freeze({
    taskType: "continuation",
    profile,
    advancedTargetVisibleCharacters: hasAdvancedTarget ? range.targetVisibleCharacters : null,
    destination,
    customDestinationInstruction,
    targetUnit: "visible_characters",
    ...range,
    estimatedVisibleOutputTokens,
    safetyMarginTokens,
    requestedMaxOutputTokens,
    requestedMaxOutputTokensBeforeClamp,
    providerOutputLimit,
    providerLimitClamped: requestedMaxOutputTokens < requestedMaxOutputTokensBeforeClamp,
    estimateSource: "cjk_conservative",
    thinkingPolicy: "disabled_for_visible_prose",
    truncationPolicy: "preserve_partial_candidate",
    continuationPolicy: "resume_without_repetition",
  });
}

export const CONTEXT_BUDGET_PROFILE_IDS = ["economy", "standard", "long", "custom"] as const;
export type ContextBudgetProfileId = (typeof CONTEXT_BUDGET_PROFILE_IDS)[number];

export const CONTEXT_BUDGET_PROFILE_LIMITS: Readonly<
  Record<Exclude<ContextBudgetProfileId, "custom">, number>
> = Object.freeze({
  economy: 12_000,
  standard: 32_000,
  long: 64_000,
});

export interface DynamicContextBudget {
  readonly profile: ContextBudgetProfileId;
  readonly modelContextWindow: number | null;
  readonly taskProfileLimit: number;
  readonly outputReserve: number;
  readonly systemOverhead: number;
  readonly safetyMargin: number;
  readonly effectiveInputBudget: number;
  readonly budgetStatus: "available" | "model_window_exhausted";
  readonly modelLimitApplied: boolean;
  readonly source: "model_limit_and_task_profile" | "conservative_unknown_model_fallback";
}

export interface ResolveDynamicContextBudgetInput {
  readonly profile?: ContextBudgetProfileId;
  readonly customLimit?: number | null;
  readonly modelContextWindow?: number | null;
  readonly outputReserve: number;
  readonly systemOverhead?: number;
  readonly safetyMargin?: number;
  /** Conservative input budget, not a total context-window size. */
  readonly unknownModelInputBudget?: number;
}

const MINIMUM_CONTEXT_BUDGET = 1_024;
const MAXIMUM_CONTEXT_BUDGET = 1_000_000;

/**
 * Allocates context after reserving output and protocol overhead. It does not
 * try to fill the result; relevance and authority remain compiler decisions.
 */
export function resolveDynamicContextBudget(
  input: ResolveDynamicContextBudgetInput,
): DynamicContextBudget {
  const profile = input.profile ?? "standard";
  if (!(CONTEXT_BUDGET_PROFILE_IDS as readonly string[]).includes(profile)) {
    throw new RangeError("Unknown context budget profile.");
  }
  const taskProfileLimit =
    profile === "custom"
      ? boundedInteger(input.customLimit, MINIMUM_CONTEXT_BUDGET, MAXIMUM_CONTEXT_BUDGET)
      : CONTEXT_BUDGET_PROFILE_LIMITS[profile];
  const outputReserve = boundedInteger(input.outputReserve, 1, MAXIMUM_CONTEXT_BUDGET);
  const systemOverhead = boundedInteger(input.systemOverhead ?? 2_048, 0, MAXIMUM_CONTEXT_BUDGET);
  const safetyMargin = boundedInteger(input.safetyMargin ?? 2_048, 0, MAXIMUM_CONTEXT_BUDGET);
  const modelContextWindow = normalizeOptionalLimit(input.modelContextWindow);
  const unknownModelInputBudget = boundedInteger(
    input.unknownModelInputBudget ?? CONTEXT_BUDGET_PROFILE_LIMITS.economy,
    MINIMUM_CONTEXT_BUDGET,
    MAXIMUM_CONTEXT_BUDGET,
  );
  const availableFromModel =
    modelContextWindow === null
      ? unknownModelInputBudget
      : Math.max(0, modelContextWindow - outputReserve - systemOverhead - safetyMargin);
  const effectiveInputBudget = Math.min(taskProfileLimit, availableFromModel);
  return Object.freeze({
    profile,
    modelContextWindow,
    taskProfileLimit,
    outputReserve,
    systemOverhead,
    safetyMargin,
    effectiveInputBudget,
    budgetStatus: effectiveInputBudget === 0 ? "model_window_exhausted" : "available",
    modelLimitApplied: effectiveInputBudget < taskProfileLimit,
    source:
      modelContextWindow === null
        ? "conservative_unknown_model_fallback"
        : "model_limit_and_task_profile",
  });
}

function customRange(targetValue: number | null | undefined): Readonly<{
  minimumVisibleCharacters: number;
  targetVisibleCharacters: number;
  maximumVisibleCharacters: number;
}> {
  const targetVisibleCharacters = boundedInteger(
    targetValue,
    MINIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS,
    MAXIMUM_ADVANCED_TARGET_VISIBLE_CHARACTERS,
  );
  return Object.freeze({
    minimumVisibleCharacters: Math.max(
      MINIMUM_ADVANCED_RESULT_VISIBLE_CHARACTERS,
      Math.floor(targetVisibleCharacters * 0.8),
    ),
    targetVisibleCharacters,
    maximumVisibleCharacters: Math.min(
      MAXIMUM_ADVANCED_RESULT_VISIBLE_CHARACTERS,
      Math.ceil(targetVisibleCharacters * 1.2),
    ),
  });
}

function normalizeOptionalLimit(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  return boundedInteger(value, 1, MAXIMUM_CONTEXT_BUDGET);
}

function normalizeDestinationInstruction(
  destination: ContinuationDestinationId,
  value: string | null | undefined,
): string | null {
  if (destination !== "custom_instruction") return null;
  const normalized = value?.normalize("NFKC").trim().replace(/\s+/gu, " ") ?? "";
  if (normalized.length < 1 || normalized.length > 2_000) {
    throw new RangeError("A custom continuation destination must contain 1–2,000 characters.");
  }
  return normalized;
}

function boundedInteger(
  value: number | null | undefined,
  minimum: number,
  maximum: number,
): number {
  if (
    value === null ||
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new RangeError(`Expected an integer between ${String(minimum)} and ${String(maximum)}.`);
  }
  return value;
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}
