import type { GenerationPreflightSnapshot } from "@inkshadow/ai-core";

export interface SafeGenerationPreflightDiagnostic {
  readonly taskType: string;
  readonly routeFound: boolean;
  readonly connectionUsable: boolean;
  readonly capabilityStatus: "supported" | "unknown" | "unavailable";
  readonly pricingStatus: "available" | "unavailable";
  readonly contextWindowStatus: "known" | "conservative_fallback";
  readonly tokenizerStatus: "exact" | "approximate";
  readonly estimatedInputTokens: number;
  readonly effectiveContextBudget: number;
  readonly readiness: GenerationPreflightSnapshot["readiness"];
  readonly blockerCodes: readonly string[];
  readonly warningCodes: readonly string[];
  readonly defaultsApplied: GenerationPreflightSnapshot["defaultsApplied"];
  readonly checkedAt: string;
}

const latestByRuntime = new WeakMap<object, SafeGenerationPreflightDiagnostic>();

export function recordSafeGenerationPreflightDiagnostic(
  runtime: object,
  input: Readonly<{
    taskType: string;
    routeFound: boolean;
    connectionUsable: boolean;
    capabilityStatus: SafeGenerationPreflightDiagnostic["capabilityStatus"];
    snapshot: GenerationPreflightSnapshot;
  }>,
): SafeGenerationPreflightDiagnostic {
  const diagnostic = Object.freeze({
    taskType: input.taskType,
    routeFound: input.routeFound,
    connectionUsable: input.connectionUsable,
    capabilityStatus: input.capabilityStatus,
    pricingStatus:
      input.snapshot.costStatus === "pricing_unavailable" ? "unavailable" : "available",
    contextWindowStatus:
      input.snapshot.contextWindowTokens === null ? "conservative_fallback" : "known",
    tokenizerStatus: input.snapshot.tokenizerStatus,
    estimatedInputTokens: input.snapshot.inputTokens,
    effectiveContextBudget: input.snapshot.effectiveContextBudget,
    readiness: input.snapshot.readiness,
    blockerCodes: Object.freeze(input.snapshot.blockers.map(({ code }) => code)),
    warningCodes: Object.freeze(input.snapshot.warnings.map(({ code }) => code)),
    defaultsApplied: Object.freeze([...input.snapshot.defaultsApplied]),
    checkedAt: input.snapshot.checkedAt,
  }) satisfies SafeGenerationPreflightDiagnostic;
  latestByRuntime.set(runtime, diagnostic);
  return diagnostic;
}

export function readSafeGenerationPreflightDiagnostic(
  runtime: object,
): SafeGenerationPreflightDiagnostic | null {
  return latestByRuntime.get(runtime) ?? null;
}
