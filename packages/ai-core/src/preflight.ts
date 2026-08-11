import {
  estimateGenerationCost,
  evaluateBudget,
  type BudgetDecision,
  type BudgetLimit,
  type CostEstimate,
  type ModelPricing,
} from "./budget.js";

export const GENERATION_PREFLIGHT_CODES = [
  "MIGRATION_REQUIRED",
  "CHAPTER_NOT_FOUND",
  "CHAPTER_UNSAVED",
  "PROJECT_READONLY",
  "MODEL_GATEWAY_UNAVAILABLE",
  "NETWORK_OFFLINE",
  "MODEL_ROUTE_UNRESOLVED",
  "MODEL_PROFILE_MISSING",
  "MODEL_NOT_SELECTED",
  "MODEL_CREDENTIAL_MISSING",
  "MODEL_CONNECTION_FAILED",
  "SELECTED_MODEL_UNAVAILABLE",
  "MODEL_PRICING_MISSING",
  "MODEL_PRICING_STALE",
  "INPUT_TOO_LARGE",
  "CONTEXT_WINDOW_UNKNOWN",
  "CONTEXT_WINDOW_EXCEEDED",
  "CONTEXT_WINDOW_NEAR_LIMIT",
  "BUDGET_WARNING",
  "BUDGET_EXCEEDED",
  "PREFLIGHT_WARNING_PRICING_UNKNOWN",
  "PREFLIGHT_WARNING_CONTEXT_UNKNOWN",
  "PREFLIGHT_WARNING_TOKEN_ESTIMATE_APPROXIMATE",
  "PREFLIGHT_BLOCKED_NO_ROUTE",
  "PREFLIGHT_BLOCKED_CREDENTIAL",
  "PREFLIGHT_BLOCKED_MODEL_UNAVAILABLE",
  "PREFLIGHT_BLOCKED_PRIVACY",
  "PREFLIGHT_BLOCKED_CONTEXT_OVERFLOW",
  "PREFLIGHT_BLOCKED_HARD_BUDGET",
  "READY",
] as const;

export type GenerationPreflightCode = (typeof GENERATION_PREFLIGHT_CODES)[number];
export type GenerationPreflightSeverity = "blocking" | "fix_recommended" | "notice";
export type GenerationProviderLocation = "remote" | "local" | "demo";
export type GenerationPreflightReadiness = "READY" | "READY_WITH_WARNINGS" | "BLOCKED";
export type GenerationPreflightCostStatus = "estimated" | "pricing_unavailable" | "not_applicable";
export type GenerationTokenizerStatus = "exact" | "approximate";

/**
 * The single fallback used when a provider does not publish a context limit.
 * This is a conservative compilation budget, never a claim about the model's
 * real context window.
 */
export const CONSERVATIVE_GENERATION_CONTEXT_POLICY = Object.freeze({
  effectiveContextWindowTokens: 16_384,
  maximumCompiledInputTokens: 7_000,
});

export const GENERATION_PREFLIGHT_ACTIONS = [
  "RUN_MIGRATION",
  "RELOAD_CHAPTER",
  "SAVE_CHAPTER",
  "RESTORE_WRITE_ACCESS",
  "OPEN_MODEL_CENTER",
  "RETRY_CONNECTION",
  "UPDATE_PRICING",
  "REDUCE_CONTEXT",
  "OPEN_BUDGET_SETTINGS",
  "CONTINUE",
] as const;

export type GenerationPreflightAction = (typeof GENERATION_PREFLIGHT_ACTIONS)[number];

export interface GenerationPreflightCheck {
  readonly code: GenerationPreflightCode;
  readonly severity: GenerationPreflightSeverity;
  readonly action: GenerationPreflightAction;
  readonly scope: "data" | "chapter" | "access" | "model" | "network" | "context" | "budget";
}

export interface GenerationPreflightInput {
  readonly now: string;
  readonly migrationReady: boolean;
  readonly chapterExists: boolean;
  readonly chapterSaved: boolean;
  readonly projectWritable: boolean;
  readonly gatewayAvailable: boolean;
  readonly networkAvailable: boolean;
  readonly providerLocation: GenerationProviderLocation;
  readonly routeResolved?: boolean;
  readonly profileConfigured: boolean;
  readonly modelSelected: boolean;
  readonly credentialConfigured: boolean;
  readonly connectionStatus: "verified" | "failed" | "not_checked";
  readonly selectedModelAvailable: boolean;
  readonly inputBytes: number;
  readonly maximumInputBytes: number;
  readonly inputTokens: number;
  readonly maximumOutputTokens: number;
  /** Task-aware input ceiling selected before prompt compilation. Legacy callers omit it. */
  readonly maximumCompiledInputTokens?: number;
  readonly contextWindowTokens: number | null;
  readonly tokenizerStatus?: GenerationTokenizerStatus;
  readonly privacyStatus?: "allowed" | "blocked";
  readonly pricing: ModelPricing | null;
  readonly budgets: readonly BudgetLimit[];
  readonly pricingMaximumAgeMilliseconds?: number;
  readonly contextWarningBasisPoints?: number;
}

export interface GenerationPreflightSnapshot {
  readonly checkedAt: string;
  readonly readiness: GenerationPreflightReadiness;
  readonly canStart: boolean;
  readonly requiresConfirmation: boolean;
  readonly checks: readonly GenerationPreflightCheck[];
  readonly blockers: readonly GenerationPreflightCheck[];
  readonly warnings: readonly GenerationPreflightCheck[];
  readonly defaultsApplied: readonly (
    "CONSERVATIVE_CONTEXT_WINDOW" | "CONSERVATIVE_TOKEN_ESTIMATE" | "PRICING_UNAVAILABLE"
  )[];
  readonly suggestedActions: readonly GenerationPreflightAction[];
  readonly estimate: CostEstimate | null;
  readonly costStatus: GenerationPreflightCostStatus;
  readonly budget: BudgetDecision | null;
  readonly inputTokens: number;
  readonly inputBytes: number;
  readonly maximumOutputTokens: number;
  readonly contextWindowTokens: number | null;
  readonly effectiveContextBudget: number;
  readonly tokenizerStatus: GenerationTokenizerStatus;
  /** Safe task-aware budget facts. Optional for legacy/non-continuation callers. */
  readonly generationBudget?: Readonly<{
    outputProfile: string;
    targetVisibleCharacters: number;
    minimumVisibleCharacters: number;
    maximumVisibleCharacters: number;
    requestedMaximumOutputTokens: number;
    providerOutputLimit: number | null;
    contextProfile: string;
    effectiveInputBudget: number;
    budgetStatus: "available" | "model_window_exhausted";
  }>;
  /** Counts and bounded reason codes only; never prompt or source content. */
  readonly contextSelectionSummary?: Readonly<{
    availableSourceCount: number;
    selectedSourceCount: number;
    deduplicatedSourceCount: number;
    excludedSourceCount: number;
    estimatedSelectedTokens: number;
    effectiveInputBudget: number;
    excludedReasonCounts: readonly Readonly<{ reason: string; count: number }>[];
    missingSourceTypes: readonly string[];
  }>;
}

export class GenerationPreflightInputError extends Error {
  readonly code = "GENERATION_PREFLIGHT_INVALID_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "GenerationPreflightInputError";
  }
}

const DEFAULT_PRICING_MAXIMUM_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_CONTEXT_WARNING_BASIS_POINTS = 9_000;

export function runGenerationPreflight(
  input: GenerationPreflightInput,
): GenerationPreflightSnapshot {
  validateInput(input);
  const checks: GenerationPreflightCheck[] = [];
  const add = (
    code: GenerationPreflightCode,
    severity: GenerationPreflightSeverity,
    action: GenerationPreflightAction,
    scope: GenerationPreflightCheck["scope"],
  ) => {
    checks.push(Object.freeze({ code, severity, action, scope }));
  };

  if (!input.migrationReady) {
    add("MIGRATION_REQUIRED", "blocking", "RUN_MIGRATION", "data");
  }
  if (!input.chapterExists) {
    add("CHAPTER_NOT_FOUND", "blocking", "RELOAD_CHAPTER", "chapter");
  } else if (!input.chapterSaved) {
    add("CHAPTER_UNSAVED", "blocking", "SAVE_CHAPTER", "chapter");
  }
  if (!input.projectWritable) {
    add("PROJECT_READONLY", "blocking", "RESTORE_WRITE_ACCESS", "access");
  }

  if (input.providerLocation !== "demo") {
    if (!input.gatewayAvailable) {
      add("MODEL_GATEWAY_UNAVAILABLE", "blocking", "OPEN_MODEL_CENTER", "model");
    }
    if (input.providerLocation === "remote" && !input.networkAvailable) {
      add("NETWORK_OFFLINE", "blocking", "RETRY_CONNECTION", "network");
    }
    if (input.routeResolved === false) {
      add("PREFLIGHT_BLOCKED_NO_ROUTE", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (!input.profileConfigured) {
      add("MODEL_PROFILE_MISSING", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (!input.modelSelected) {
      add("MODEL_NOT_SELECTED", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (!input.credentialConfigured) {
      add("PREFLIGHT_BLOCKED_CREDENTIAL", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (input.connectionStatus === "failed") {
      add("PREFLIGHT_BLOCKED_MODEL_UNAVAILABLE", "blocking", "RETRY_CONNECTION", "model");
    } else if (!input.selectedModelAvailable) {
      add("PREFLIGHT_BLOCKED_MODEL_UNAVAILABLE", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (input.connectionStatus === "not_checked") {
      add("MODEL_CONNECTION_FAILED", "fix_recommended", "RETRY_CONNECTION", "model");
    }
  }

  let estimate: CostEstimate | null = null;
  let costStatus: GenerationPreflightCostStatus = "estimated";
  let budget: BudgetDecision | null = null;
  if (input.providerLocation === "demo") {
    costStatus = "not_applicable";
    estimate = estimateGenerationCost(
      {
        inputTokens: input.inputTokens,
        outputTokens: input.maximumOutputTokens,
      },
      {
        currency: "USD",
        pricingVersion: "local-demo-zero-cost",
        updatedAt: input.now,
        inputMicrosPerMillionTokens: 0n,
        outputMicrosPerMillionTokens: 0n,
      },
    );
  } else if (input.pricing === null) {
    costStatus = "pricing_unavailable";
    add("PREFLIGHT_WARNING_PRICING_UNKNOWN", "fix_recommended", "UPDATE_PRICING", "model");
  } else {
    estimate = estimateGenerationCost(
      {
        inputTokens: input.inputTokens,
        outputTokens: input.maximumOutputTokens,
      },
      input.pricing,
    );
    const pricingAge = Date.parse(input.now) - Date.parse(input.pricing.updatedAt);
    if (
      pricingAge > (input.pricingMaximumAgeMilliseconds ?? DEFAULT_PRICING_MAXIMUM_AGE_MILLISECONDS)
    ) {
      add("MODEL_PRICING_STALE", "fix_recommended", "UPDATE_PRICING", "model");
    }
  }

  const requestedContextTokens = input.inputTokens + input.maximumOutputTokens;
  if (input.inputBytes > input.maximumInputBytes) {
    add("INPUT_TOO_LARGE", "blocking", "REDUCE_CONTEXT", "context");
  }
  if (input.providerLocation !== "demo" && input.contextWindowTokens === null) {
    add("PREFLIGHT_WARNING_CONTEXT_UNKNOWN", "fix_recommended", "OPEN_MODEL_CENTER", "context");
    if (
      requestedContextTokens > CONSERVATIVE_GENERATION_CONTEXT_POLICY.effectiveContextWindowTokens
    ) {
      add("PREFLIGHT_BLOCKED_CONTEXT_OVERFLOW", "blocking", "REDUCE_CONTEXT", "context");
    }
  } else if (
    input.contextWindowTokens !== null &&
    requestedContextTokens > input.contextWindowTokens
  ) {
    add("PREFLIGHT_BLOCKED_CONTEXT_OVERFLOW", "blocking", "REDUCE_CONTEXT", "context");
  } else if (
    input.contextWindowTokens !== null &&
    requestedContextTokens * 10_000 >=
      input.contextWindowTokens *
        (input.contextWarningBasisPoints ?? DEFAULT_CONTEXT_WARNING_BASIS_POINTS)
  ) {
    add("CONTEXT_WINDOW_NEAR_LIMIT", "fix_recommended", "REDUCE_CONTEXT", "context");
  }

  const tokenizerStatus = input.tokenizerStatus ?? "exact";
  if (input.providerLocation !== "demo" && tokenizerStatus === "approximate") {
    add("PREFLIGHT_WARNING_TOKEN_ESTIMATE_APPROXIMATE", "fix_recommended", "CONTINUE", "context");
  }

  if (input.privacyStatus === "blocked") {
    add("PREFLIGHT_BLOCKED_PRIVACY", "blocking", "OPEN_MODEL_CENTER", "access");
  }

  if (estimate !== null) {
    budget = evaluateBudget(estimate, input.budgets);
    if (budget.level === "blocked") {
      add("PREFLIGHT_BLOCKED_HARD_BUDGET", "blocking", "OPEN_BUDGET_SETTINGS", "budget");
    } else if (budget.level === "warning") {
      add("BUDGET_WARNING", "fix_recommended", "OPEN_BUDGET_SETTINGS", "budget");
    }
  }

  if (checks.length === 0) {
    add("READY", "notice", "CONTINUE", "model");
  }

  const blockers = Object.freeze(checks.filter(({ severity }) => severity === "blocking"));
  const warnings = Object.freeze(checks.filter(({ severity }) => severity === "fix_recommended"));
  const readiness: GenerationPreflightReadiness =
    blockers.length > 0 ? "BLOCKED" : warnings.length > 0 ? "READY_WITH_WARNINGS" : "READY";
  const canStart = readiness !== "BLOCKED";
  const defaultsApplied = Object.freeze([
    ...(input.contextWindowTokens === null && input.providerLocation !== "demo"
      ? (["CONSERVATIVE_CONTEXT_WINDOW"] as const)
      : []),
    ...(tokenizerStatus === "approximate" ? (["CONSERVATIVE_TOKEN_ESTIMATE"] as const) : []),
    ...(costStatus === "pricing_unavailable" ? (["PRICING_UNAVAILABLE"] as const) : []),
  ]);
  const suggestedActions = Object.freeze(
    [...new Set(checks.map(({ action }) => action))].filter((action) => action !== "CONTINUE"),
  );
  const effectiveContextWindow =
    input.contextWindowTokens ??
    CONSERVATIVE_GENERATION_CONTEXT_POLICY.effectiveContextWindowTokens;
  const effectiveContextBudget = Math.min(
    input.maximumCompiledInputTokens ??
      CONSERVATIVE_GENERATION_CONTEXT_POLICY.maximumCompiledInputTokens,
    Math.max(0, effectiveContextWindow - input.maximumOutputTokens),
  );
  return Object.freeze({
    checkedAt: input.now,
    readiness,
    canStart,
    requiresConfirmation: canStart && warnings.length > 0,
    checks: Object.freeze(checks),
    blockers,
    warnings,
    defaultsApplied,
    suggestedActions,
    estimate,
    costStatus,
    budget,
    inputTokens: input.inputTokens,
    inputBytes: input.inputBytes,
    maximumOutputTokens: input.maximumOutputTokens,
    contextWindowTokens: input.contextWindowTokens,
    effectiveContextBudget,
    tokenizerStatus,
  });
}

function validateInput(input: GenerationPreflightInput): void {
  if (!input.now.endsWith("Z") || Number.isNaN(Date.parse(input.now))) {
    throw new GenerationPreflightInputError("now must be a valid ISO 8601 UTC timestamp.");
  }
  assertTokenCount(input.inputTokens, "inputTokens");
  assertTokenCount(input.inputBytes, "inputBytes");
  if (!Number.isSafeInteger(input.maximumInputBytes) || input.maximumInputBytes < 1) {
    throw new GenerationPreflightInputError("maximumInputBytes must be a positive safe integer.");
  }
  assertTokenCount(input.maximumOutputTokens, "maximumOutputTokens");
  if (
    input.maximumCompiledInputTokens !== undefined &&
    (!Number.isSafeInteger(input.maximumCompiledInputTokens) ||
      input.maximumCompiledInputTokens < 1 ||
      input.maximumCompiledInputTokens > 10_000_000)
  ) {
    throw new GenerationPreflightInputError(
      "maximumCompiledInputTokens must be a positive safe integer no greater than 10000000.",
    );
  }
  if (
    input.contextWindowTokens !== null &&
    (!Number.isSafeInteger(input.contextWindowTokens) || input.contextWindowTokens < 1)
  ) {
    throw new GenerationPreflightInputError(
      "contextWindowTokens must be null or a positive safe integer.",
    );
  }
  if (
    input.pricingMaximumAgeMilliseconds !== undefined &&
    (!Number.isSafeInteger(input.pricingMaximumAgeMilliseconds) ||
      input.pricingMaximumAgeMilliseconds < 1)
  ) {
    throw new GenerationPreflightInputError(
      "pricingMaximumAgeMilliseconds must be a positive safe integer.",
    );
  }
  if (
    input.contextWarningBasisPoints !== undefined &&
    (!Number.isInteger(input.contextWarningBasisPoints) ||
      input.contextWarningBasisPoints < 1 ||
      input.contextWarningBasisPoints > 10_000)
  ) {
    throw new GenerationPreflightInputError(
      "contextWarningBasisPoints must be between 1 and 10000.",
    );
  }
}

function assertTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GenerationPreflightInputError(`${name} must be a non-negative safe integer.`);
  }
}
