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
  "READY",
] as const;

export type GenerationPreflightCode = (typeof GENERATION_PREFLIGHT_CODES)[number];
export type GenerationPreflightSeverity = "blocking" | "fix_recommended" | "notice";
export type GenerationProviderLocation = "remote" | "local" | "demo";

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
  readonly contextWindowTokens: number | null;
  readonly pricing: ModelPricing | null;
  readonly budgets: readonly BudgetLimit[];
  readonly pricingMaximumAgeMilliseconds?: number;
  readonly contextWarningBasisPoints?: number;
}

export interface GenerationPreflightSnapshot {
  readonly checkedAt: string;
  readonly canStart: boolean;
  readonly requiresConfirmation: boolean;
  readonly checks: readonly GenerationPreflightCheck[];
  readonly estimate: CostEstimate | null;
  readonly budget: BudgetDecision | null;
  readonly inputTokens: number;
  readonly inputBytes: number;
  readonly maximumOutputTokens: number;
  readonly contextWindowTokens: number | null;
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
      add("MODEL_ROUTE_UNRESOLVED", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (!input.profileConfigured) {
      add("MODEL_PROFILE_MISSING", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (!input.modelSelected) {
      add("MODEL_NOT_SELECTED", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (!input.credentialConfigured) {
      add("MODEL_CREDENTIAL_MISSING", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (input.connectionStatus === "failed") {
      add("MODEL_CONNECTION_FAILED", "blocking", "RETRY_CONNECTION", "model");
    } else if (!input.selectedModelAvailable) {
      add("SELECTED_MODEL_UNAVAILABLE", "blocking", "OPEN_MODEL_CENTER", "model");
    } else if (input.connectionStatus === "not_checked") {
      add("MODEL_CONNECTION_FAILED", "fix_recommended", "RETRY_CONNECTION", "model");
    }
  }

  let estimate: CostEstimate | null = null;
  let budget: BudgetDecision | null = null;
  if (input.providerLocation === "demo") {
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
    add("MODEL_PRICING_MISSING", "blocking", "UPDATE_PRICING", "model");
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
    add("CONTEXT_WINDOW_UNKNOWN", "fix_recommended", "OPEN_MODEL_CENTER", "context");
  } else if (
    input.contextWindowTokens !== null &&
    requestedContextTokens > input.contextWindowTokens
  ) {
    add("CONTEXT_WINDOW_EXCEEDED", "blocking", "REDUCE_CONTEXT", "context");
  } else if (
    input.contextWindowTokens !== null &&
    requestedContextTokens * 10_000 >=
      input.contextWindowTokens *
        (input.contextWarningBasisPoints ?? DEFAULT_CONTEXT_WARNING_BASIS_POINTS)
  ) {
    add("CONTEXT_WINDOW_NEAR_LIMIT", "fix_recommended", "REDUCE_CONTEXT", "context");
  }

  if (estimate !== null) {
    budget = evaluateBudget(estimate, input.budgets);
    if (budget.level === "blocked") {
      add("BUDGET_EXCEEDED", "blocking", "OPEN_BUDGET_SETTINGS", "budget");
    } else if (budget.level === "warning") {
      add("BUDGET_WARNING", "fix_recommended", "OPEN_BUDGET_SETTINGS", "budget");
    }
  }

  if (checks.length === 0) {
    add("READY", "notice", "CONTINUE", "model");
  }

  const canStart = !checks.some(({ severity }) => severity === "blocking");
  return Object.freeze({
    checkedAt: input.now,
    canStart,
    requiresConfirmation: canStart && checks.some(({ severity }) => severity === "fix_recommended"),
    checks: Object.freeze(checks),
    estimate,
    budget,
    inputTokens: input.inputTokens,
    inputBytes: input.inputBytes,
    maximumOutputTokens: input.maximumOutputTokens,
    contextWindowTokens: input.contextWindowTokens,
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
