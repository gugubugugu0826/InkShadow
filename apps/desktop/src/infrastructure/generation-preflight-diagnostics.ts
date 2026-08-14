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

export interface SafeInvocationRouteDiagnostic {
  readonly taskType: string;
  readonly resolverVersion: "continuation-route-resolver@1";
  readonly modelHubRouteFound: boolean | null;
  readonly legacyProfileChecked: boolean;
  readonly legacyProfileSelected: boolean;
  readonly resolvedConnectionId: string | null;
  readonly resolvedModelId: string | null;
  readonly routeSource: "model_hub" | "legacy_profile" | "none";
  readonly ready: boolean;
  readonly blockerCode: string | null;
  readonly checkedAt: string;
}

export const GENERATION_PREFLIGHT_CHANGED_EVENT = "inkshadow:generation-preflight-changed" as const;

export interface SafeGenerationPreflightScope {
  readonly projectId: string;
  readonly chapterId: string | null;
}

const latestByRuntime = new WeakMap<object, SafeGenerationPreflightDiagnostic>();
const latestRouteByRuntime = new WeakMap<object, SafeInvocationRouteDiagnostic>();
const currentErrorCodesByRuntime = new WeakMap<object, Set<string>>();
const latestScopedByRuntime = new WeakMap<object, Map<string, SafeGenerationPreflightDiagnostic>>();

export function recordSafeGenerationPreflightDiagnostic(
  runtime: object,
  input: Readonly<{
    taskType: string;
    routeFound: boolean;
    connectionUsable: boolean;
    capabilityStatus: SafeGenerationPreflightDiagnostic["capabilityStatus"];
    snapshot: GenerationPreflightSnapshot;
    scope?: SafeGenerationPreflightScope | undefined;
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
  recordScopedDiagnostic(runtime, input.scope, diagnostic);
  notifyPreflightChanged(runtime);
  return diagnostic;
}

export function readSafeGenerationPreflightDiagnostic(
  runtime: object,
): SafeGenerationPreflightDiagnostic | null {
  return latestByRuntime.get(runtime) ?? null;
}

export function recordSafeGenerationPreflightFailureDiagnostic(
  runtime: object,
  input: Readonly<{
    taskType: string;
    routeFound: boolean;
    blockerCode: string;
    checkedAt: string;
    scope?: SafeGenerationPreflightScope | undefined;
  }>,
): SafeGenerationPreflightDiagnostic {
  const diagnostic = Object.freeze({
    taskType: input.taskType,
    routeFound: input.routeFound,
    connectionUsable: false,
    capabilityStatus: "unavailable" as const,
    pricingStatus: "unavailable" as const,
    contextWindowStatus: "conservative_fallback" as const,
    tokenizerStatus: "approximate" as const,
    estimatedInputTokens: 0,
    effectiveContextBudget: 0,
    readiness: "BLOCKED" as const,
    blockerCodes: Object.freeze([input.blockerCode]),
    warningCodes: Object.freeze([]),
    defaultsApplied: Object.freeze([]),
    checkedAt: input.checkedAt,
  }) satisfies SafeGenerationPreflightDiagnostic;
  latestByRuntime.set(runtime, diagnostic);
  recordScopedDiagnostic(runtime, input.scope, diagnostic);
  recordSafeGenerationErrorCode(runtime, input.blockerCode);
  notifyPreflightChanged(runtime);
  return diagnostic;
}

export function readSafeGenerationPreflightForScope(
  runtime: object,
  scope: SafeGenerationPreflightScope,
): SafeGenerationPreflightDiagnostic | null {
  return latestScopedByRuntime.get(runtime)?.get(preflightScopeKey(scope)) ?? null;
}

export function clearSafeGenerationPreflightScope(runtime: object): void {
  latestScopedByRuntime.delete(runtime);
  notifyPreflightChanged(runtime);
}

export function isGenerationPreflightEventForRuntime(event: Event, runtime: object): boolean {
  if (!(event instanceof CustomEvent)) return false;
  const detail: unknown = event.detail;
  return (
    typeof detail === "object" &&
    detail !== null &&
    "runtime" in detail &&
    detail.runtime === runtime
  );
}

export function recordSafeInvocationRouteDiagnostic(
  runtime: object,
  input: Omit<SafeInvocationRouteDiagnostic, "resolverVersion">,
): SafeInvocationRouteDiagnostic {
  const diagnostic = Object.freeze({
    ...input,
    resolverVersion: "continuation-route-resolver@1" as const,
  }) satisfies SafeInvocationRouteDiagnostic;
  latestRouteByRuntime.set(runtime, diagnostic);
  if (diagnostic.blockerCode !== null) {
    recordSafeGenerationErrorCode(runtime, diagnostic.blockerCode);
  }
  return diagnostic;
}

export function readSafeInvocationRouteDiagnostic(
  runtime: object,
): SafeInvocationRouteDiagnostic | null {
  return latestRouteByRuntime.get(runtime) ?? null;
}

export function recordSafeGenerationErrorCode(runtime: object, code: string): void {
  if (!/^[A-Z][A-Z0-9_]{2,80}$/u.test(code)) return;
  const current = currentErrorCodesByRuntime.get(runtime) ?? new Set<string>();
  current.add(code);
  currentErrorCodesByRuntime.set(runtime, current);
}

export function readSafeGenerationErrorCodes(runtime: object): readonly string[] {
  return Object.freeze([...(currentErrorCodesByRuntime.get(runtime) ?? [])]);
}

function recordScopedDiagnostic(
  runtime: object,
  scope: SafeGenerationPreflightScope | undefined,
  diagnostic: SafeGenerationPreflightDiagnostic,
): void {
  if (scope === undefined) return;
  const scopes =
    latestScopedByRuntime.get(runtime) ?? new Map<string, SafeGenerationPreflightDiagnostic>();
  scopes.set(preflightScopeKey(scope), diagnostic);
  latestScopedByRuntime.set(runtime, scopes);
}

function preflightScopeKey(scope: SafeGenerationPreflightScope): string {
  return `${scope.projectId}\n${scope.chapterId ?? ""}`;
}

function notifyPreflightChanged(runtime: object): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(GENERATION_PREFLIGHT_CHANGED_EVENT, {
      detail: Object.freeze({ runtime }),
    }),
  );
}
