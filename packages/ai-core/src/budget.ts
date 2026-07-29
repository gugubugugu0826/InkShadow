export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

export interface ModelPricing {
  readonly currency: string;
  readonly pricingVersion: string;
  readonly updatedAt: string;
  readonly inputMicrosPerMillionTokens: bigint;
  readonly outputMicrosPerMillionTokens: bigint;
  readonly cachedInputMicrosPerMillionTokens?: bigint;
}

export interface CostEstimate {
  readonly estimated: true;
  readonly currency: string;
  readonly micros: bigint;
  readonly inputMicros: bigint;
  readonly outputMicros: bigint;
  readonly pricingVersion: string;
  readonly priceUpdatedAt: string;
  readonly usage: TokenUsage;
}

export type BudgetScope = "task" | "project" | "month";
export type BudgetEnforcement = "warn" | "hard";

export interface BudgetLimit {
  readonly scope: BudgetScope;
  readonly limitMicros: bigint;
  readonly spentMicros: bigint;
  readonly enforcement: BudgetEnforcement;
}

export interface BudgetAlert {
  readonly scope: BudgetScope;
  readonly severity: "warning" | "blocked";
  readonly projectedMicros: bigint;
  readonly limitMicros: bigint;
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly level: "ok" | "warning" | "blocked";
  readonly currency: string;
  readonly estimateMicros: bigint;
  readonly alerts: readonly BudgetAlert[];
}

export class BudgetInputError extends Error {
  readonly code = "BUDGET_INVALID_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "BudgetInputError";
  }
}

function assertTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BudgetInputError(`${name} must be a non-negative safe integer.`);
  }
}

function assertNonNegativeMicros(value: bigint, name: string): void {
  if (value < 0n) {
    throw new BudgetInputError(`${name} must not be negative.`);
  }
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return value === 0n ? 0n : (value + divisor - 1n) / divisor;
}

export function estimateGenerationCost(usage: TokenUsage, pricing: ModelPricing): CostEstimate {
  assertTokenCount(usage.inputTokens, "inputTokens");
  assertTokenCount(usage.outputTokens, "outputTokens");
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  assertTokenCount(cachedInputTokens, "cachedInputTokens");
  if (cachedInputTokens > usage.inputTokens) {
    throw new BudgetInputError("cachedInputTokens cannot exceed inputTokens.");
  }

  assertNonNegativeMicros(pricing.inputMicrosPerMillionTokens, "input pricing");
  assertNonNegativeMicros(pricing.outputMicrosPerMillionTokens, "output pricing");
  if (pricing.cachedInputMicrosPerMillionTokens !== undefined) {
    assertNonNegativeMicros(pricing.cachedInputMicrosPerMillionTokens, "cached input pricing");
  }
  if (!/^[A-Z]{3}$/.test(pricing.currency)) {
    throw new BudgetInputError("currency must be a three-letter ISO code.");
  }

  const uncachedInputTokens = usage.inputTokens - cachedInputTokens;
  const inputMicros = ceilDivide(
    BigInt(uncachedInputTokens) * pricing.inputMicrosPerMillionTokens,
    1_000_000n,
  );
  const cachedInputMicros = ceilDivide(
    BigInt(cachedInputTokens) *
      (pricing.cachedInputMicrosPerMillionTokens ?? pricing.inputMicrosPerMillionTokens),
    1_000_000n,
  );
  const outputMicros = ceilDivide(
    BigInt(usage.outputTokens) * pricing.outputMicrosPerMillionTokens,
    1_000_000n,
  );

  return {
    estimated: true,
    currency: pricing.currency,
    micros: inputMicros + cachedInputMicros + outputMicros,
    inputMicros: inputMicros + cachedInputMicros,
    outputMicros,
    pricingVersion: pricing.pricingVersion,
    priceUpdatedAt: pricing.updatedAt,
    usage,
  };
}

export function evaluateBudget(
  estimate: Pick<CostEstimate, "currency" | "micros">,
  limits: readonly BudgetLimit[],
  warningThresholdBasisPoints = 8_000,
): BudgetDecision {
  if (
    !Number.isInteger(warningThresholdBasisPoints) ||
    warningThresholdBasisPoints < 1 ||
    warningThresholdBasisPoints > 10_000
  ) {
    throw new BudgetInputError("warningThresholdBasisPoints must be between 1 and 10000.");
  }
  assertNonNegativeMicros(estimate.micros, "estimate");

  const seenScopes = new Set<BudgetScope>();
  const alerts: BudgetAlert[] = [];

  for (const limit of limits) {
    if (seenScopes.has(limit.scope)) {
      throw new BudgetInputError(`Duplicate budget scope: ${limit.scope}`);
    }
    seenScopes.add(limit.scope);
    assertNonNegativeMicros(limit.limitMicros, `${limit.scope} limit`);
    assertNonNegativeMicros(limit.spentMicros, `${limit.scope} spend`);

    const projectedMicros = limit.spentMicros + estimate.micros;
    if (projectedMicros > limit.limitMicros) {
      alerts.push({
        scope: limit.scope,
        severity: limit.enforcement === "hard" ? "blocked" : "warning",
        projectedMicros,
        limitMicros: limit.limitMicros,
      });
      continue;
    }

    const thresholdReached =
      limit.limitMicros === 0n ||
      projectedMicros * 10_000n >= limit.limitMicros * BigInt(warningThresholdBasisPoints);
    if (thresholdReached) {
      alerts.push({
        scope: limit.scope,
        severity: "warning",
        projectedMicros,
        limitMicros: limit.limitMicros,
      });
    }
  }

  const blocked = alerts.some((alert) => alert.severity === "blocked");
  return {
    allowed: !blocked,
    level: blocked ? "blocked" : alerts.length > 0 ? "warning" : "ok",
    currency: estimate.currency,
    estimateMicros: estimate.micros,
    alerts,
  };
}
