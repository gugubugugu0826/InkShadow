import { describe, expect, it } from "vitest";

import type { ModelInvocationFact } from "./model-hub-store";
import { projectOpeningInvocationDispatchState } from "./opening-invocation-terminal";

describe("opening invocation terminal projection", () => {
  it.each([
    ["timed_out", "transport", "ambiguous"],
    ["failed", "transport", "ambiguous"],
    ["failed", "dispatch", "ambiguous"],
    ["failed", "http_response", "failed"],
    ["failed", "stream_parse", "failed"],
    ["failed", "response_normalization", "failed"],
  ] as const)("projects a post-dispatch %s / %s receipt as %s", (status, stage, expected) => {
    expect(
      projectOpeningInvocationDispatchState(
        fact({
          status,
          errorCode: status === "timed_out" ? "PROVIDER_TIMEOUT" : "PROVIDER_FAILURE",
          failure: failure(stage),
          providerDispatchStartedAt: "2026-08-08T08:00:01.000Z",
        }),
      ),
    ).toBe(expected);
  });

  it("uses the durable boundary for cancellation and pre-dispatch recovery", () => {
    expect(
      projectOpeningInvocationDispatchState(
        fact({
          status: "failed",
          errorCode: "MODEL_HUB_PREFLIGHT_FAILED",
          failure: failure("request_preparation"),
          providerDispatchStartedAt: null,
        }),
      ),
    ).toBe("not_dispatched");
    expect(
      projectOpeningInvocationDispatchState(
        fact({ status: "cancelled", providerDispatchStartedAt: null }),
      ),
    ).toBe("not_dispatched");
    expect(
      projectOpeningInvocationDispatchState(
        fact({
          status: "cancelled",
          providerDispatchStartedAt: "2026-08-08T08:00:01.000Z",
        }),
      ),
    ).toBe("cancelled");
  });
});

function fact(overrides: Partial<ModelInvocationFact>): ModelInvocationFact {
  return Object.freeze({
    id: "opening-invocation",
    task: "book_start_guidance",
    routeTask: "book_start_guidance",
    connectionId: "connection",
    catalogEntryId: "catalog",
    providerKindSnapshot: "openai",
    modelIdSnapshot: "model",
    routeReason: "task_primary",
    status: "failed",
    attempt: 1,
    fallbackFromInvocationId: null,
    privacyPolicy: "cloud_allowed",
    dataDestination: "remote",
    maximumCostMicros: null,
    currency: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    estimatedCostMicros: null,
    errorCode: "PROVIDER_FAILURE",
    errorSummary: "Provider request failed.",
    completion: null,
    failure: failure("transport"),
    providerDispatchStartedAt: "2026-08-08T08:00:01.000Z",
    startedAt: "2026-08-08T08:00:00.000Z",
    completedAt: "2026-08-08T08:00:02.000Z",
    createdAt: "2026-08-08T08:00:00.000Z",
    revision: 3,
    ...overrides,
  });
}

function failure(stage: NonNullable<ModelInvocationFact["failure"]>["stage"]) {
  return Object.freeze({
    requestId: null,
    stage,
    retryable: false,
    httpStatus: null,
    finishReason: null,
    visibleContentLength: null,
    reasoningPresent: null,
    stream: null,
    attempt: 1,
    requestedMaxOutputTokens: 1_200,
  });
}
