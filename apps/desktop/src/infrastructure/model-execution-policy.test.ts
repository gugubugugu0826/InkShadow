import { describe, expect, it } from "vitest";

import {
  createSingleAttemptModelExecutionPolicy,
  selectSingleAttemptStrictJsonPolicy,
  SINGLE_ATTEMPT_STRICT_JSON_POLICY,
  SINGLE_ATTEMPT_STRICT_JSON_TEXT_TRANSPORT_POLICY,
  SINGLE_ATTEMPT_VISIBLE_PROSE_POLICY,
} from "./model-execution-policy";

describe("ModelExecutionPolicy", () => {
  it("fixes every action to one Provider call with zero automatic retry", () => {
    expect(SINGLE_ATTEMPT_VISIBLE_PROSE_POLICY).toMatchObject({
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
      autoFallbackConditions: ["predispatch_configured_route_resolution"],
      stopConditions: [
        "ambiguous_result",
        "privacy_failure",
        "context_unbound",
        "authority_drift",
        "user_cancelled",
        "budget_exhausted",
        "persistence_failure",
      ],
      outputValidation: "visible_text_contract",
    });
    expect(SINGLE_ATTEMPT_STRICT_JSON_POLICY).toMatchObject({
      outputContract: "strict_json",
      transportResponseFormat: "json_object",
      reasoningMode: "disabled",
      outputValidation: "strict_json_caller_validator_before_success",
    });
  });

  it("rejects JSON transport for a visible-text contract", () => {
    expect(() =>
      createSingleAttemptModelExecutionPolicy({
        outputContract: "visible_text",
        requestJsonMode: true,
        reasoningMode: "disabled",
      }),
    ).toThrow("strict JSON");
  });

  it("enables JSON transport only with both capability evidence and protocol support", () => {
    expect(
      selectSingleAttemptStrictJsonPolicy({
        structuredOutputVerified: true,
        jsonObjectTransportSupported: true,
      }),
    ).toBe(SINGLE_ATTEMPT_STRICT_JSON_POLICY);
    expect(
      selectSingleAttemptStrictJsonPolicy({
        structuredOutputVerified: false,
        jsonObjectTransportSupported: true,
      }),
    ).toBe(SINGLE_ATTEMPT_STRICT_JSON_TEXT_TRANSPORT_POLICY);
    expect(
      selectSingleAttemptStrictJsonPolicy({
        structuredOutputVerified: true,
        jsonObjectTransportSupported: false,
      }),
    ).toBe(SINGLE_ATTEMPT_STRICT_JSON_TEXT_TRANSPORT_POLICY);
  });
});
