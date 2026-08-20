export const MODEL_EXECUTION_POLICY_VERSION = 1 as const;

export type ModelExecutionOutputContract = "visible_text" | "strict_json";
export type ModelExecutionReasoningMode =
  "provider_default" | "provider_visible_prose" | "capability_probe" | "disabled";

export const SINGLE_ATTEMPT_AUTO_FALLBACK_CONDITIONS = Object.freeze([
  "predispatch_configured_route_resolution",
] as const);

export const SINGLE_ATTEMPT_STOP_CONDITIONS = Object.freeze([
  "ambiguous_result",
  "privacy_failure",
  "context_unbound",
  "authority_drift",
  "user_cancelled",
  "budget_exhausted",
  "persistence_failure",
] as const);

/**
 * One bounded Provider action. The policy deliberately has no multi-attempt
 * form: a future second call needs its own invocation, disclosure, budget and
 * explicit user action instead of being hidden inside this request.
 */
export interface ModelExecutionPolicy {
  readonly version: typeof MODEL_EXECUTION_POLICY_VERSION;
  /** The authoritative task route supplies the primary and optional fallback. */
  readonly primaryRoute: "configured_task_route";
  readonly orderedFallbackRoutes: "configured_predispatch_only";
  readonly requiredCapabilities: "resolved_task_contract";
  readonly privacyDestination: "authoritative_dispatch_scope";
  readonly maximumProviderCalls: 1;
  readonly maximumAttempts: 1;
  readonly automaticRetryCount: 0;
  readonly providerRetryLimit: 0;
  readonly costPolicy: "authoritative_preflight_or_explicit_unknown";
  readonly preDispatchFallback: "configured_route_only";
  readonly postDispatchFallback: "forbidden";
  readonly ambiguousRedispatch: "forbidden";
  readonly autoFallbackConditions: typeof SINGLE_ATTEMPT_AUTO_FALLBACK_CONDITIONS;
  readonly stopConditions: typeof SINGLE_ATTEMPT_STOP_CONDITIONS;
  readonly outputContract: ModelExecutionOutputContract;
  readonly outputValidation:
    "visible_text_contract" | "strict_json_caller_validator_before_success";
  readonly transportResponseFormat: "text" | "json_object";
  readonly reasoningMode: ModelExecutionReasoningMode;
}

export type StrictJsonModelExecutionPolicy = ModelExecutionPolicy &
  Readonly<{
    outputContract: "strict_json";
    transportResponseFormat: "json_object";
    reasoningMode: "disabled";
  }>;

export function createSingleAttemptModelExecutionPolicy(input: {
  readonly outputContract: ModelExecutionOutputContract;
  readonly requestJsonMode?: boolean;
  readonly reasoningMode: ModelExecutionReasoningMode;
}): ModelExecutionPolicy {
  if (input.requestJsonMode === true && input.outputContract !== "strict_json") {
    throw new Error("JSON transport mode requires the strict JSON output contract.");
  }
  return Object.freeze({
    version: MODEL_EXECUTION_POLICY_VERSION,
    primaryRoute: "configured_task_route",
    orderedFallbackRoutes: "configured_predispatch_only",
    requiredCapabilities: "resolved_task_contract",
    privacyDestination: "authoritative_dispatch_scope",
    maximumProviderCalls: 1,
    maximumAttempts: 1,
    automaticRetryCount: 0,
    providerRetryLimit: 0,
    costPolicy: "authoritative_preflight_or_explicit_unknown",
    preDispatchFallback: "configured_route_only",
    postDispatchFallback: "forbidden",
    ambiguousRedispatch: "forbidden",
    autoFallbackConditions: SINGLE_ATTEMPT_AUTO_FALLBACK_CONDITIONS,
    stopConditions: SINGLE_ATTEMPT_STOP_CONDITIONS,
    outputContract: input.outputContract,
    outputValidation:
      input.outputContract === "strict_json"
        ? "strict_json_caller_validator_before_success"
        : "visible_text_contract",
    transportResponseFormat: input.requestJsonMode === true ? "json_object" : "text",
    reasoningMode: input.reasoningMode,
  });
}

export const SINGLE_ATTEMPT_VISIBLE_PROSE_POLICY = createSingleAttemptModelExecutionPolicy({
  outputContract: "visible_text",
  reasoningMode: "provider_visible_prose",
});

export const SINGLE_ATTEMPT_PROVIDER_DEFAULT_TEXT_POLICY = createSingleAttemptModelExecutionPolicy({
  outputContract: "visible_text",
  reasoningMode: "provider_default",
});

export const SINGLE_ATTEMPT_CAPABILITY_PROBE_POLICY = createSingleAttemptModelExecutionPolicy({
  outputContract: "visible_text",
  reasoningMode: "capability_probe",
});

export const SINGLE_ATTEMPT_DISABLED_REASONING_TEXT_POLICY =
  createSingleAttemptModelExecutionPolicy({
    outputContract: "visible_text",
    reasoningMode: "disabled",
  });

export const SINGLE_ATTEMPT_STRICT_JSON_POLICY: StrictJsonModelExecutionPolicy =
  createSingleAttemptModelExecutionPolicy({
    outputContract: "strict_json",
    requestJsonMode: true,
    reasoningMode: "disabled",
  }) as StrictJsonModelExecutionPolicy;

export const SINGLE_ATTEMPT_STRICT_JSON_TEXT_TRANSPORT_POLICY =
  createSingleAttemptModelExecutionPolicy({
    outputContract: "strict_json",
    reasoningMode: "disabled",
  });

/**
 * JSON transport is an optimization, not proof that a response satisfies the
 * caller schema. Enable it only when both the exact model capability and the
 * native protocol have been verified; every other structured caller keeps the
 * same strict local validator over ordinary text transport.
 */
export function selectSingleAttemptStrictJsonPolicy(input: {
  readonly structuredOutputVerified: boolean;
  readonly jsonObjectTransportSupported: boolean;
}): ModelExecutionPolicy {
  return input.structuredOutputVerified && input.jsonObjectTransportSupported
    ? SINGLE_ATTEMPT_STRICT_JSON_POLICY
    : SINGLE_ATTEMPT_STRICT_JSON_TEXT_TRANSPORT_POLICY;
}
