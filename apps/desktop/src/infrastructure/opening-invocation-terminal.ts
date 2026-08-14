import type { ModelInvocationFact } from "./model-hub-store";

export type OpeningInvocationDispatchState =
  "planned" | "dispatched" | "succeeded" | "failed" | "cancelled" | "ambiguous" | "not_dispatched";

const CONFIRMED_PROVIDER_RESPONSE_STAGES = Object.freeze([
  "http_response",
  "stream_parse",
  "response_normalization",
] as const);

/**
 * Projects the durable invocation receipt into the opening slot lifecycle.
 * Transport/dispatch uncertainty after the network boundary is deliberately
 * ambiguous; an affirmative HTTP/stream/normalization response is failed.
 */
export function projectOpeningInvocationDispatchState(
  invocation: ModelInvocationFact,
): OpeningInvocationDispatchState {
  switch (invocation.status) {
    case "queued":
    case "running":
      return invocation.providerDispatchStartedAt === null ? "planned" : "dispatched";
    case "succeeded":
      return "succeeded";
    case "cancelled":
      return invocation.providerDispatchStartedAt === null ? "not_dispatched" : "cancelled";
    case "timed_out":
      return invocation.providerDispatchStartedAt === null ? "not_dispatched" : "ambiguous";
    case "failed":
      if (invocation.providerDispatchStartedAt === null) return "not_dispatched";
      if (invocation.errorCode === "OPENING_DISPATCH_AMBIGUOUS") return "ambiguous";
      return invocation.failure?.stage !== null &&
        invocation.failure?.stage !== undefined &&
        CONFIRMED_PROVIDER_RESPONSE_STAGES.includes(
          invocation.failure.stage as (typeof CONFIRMED_PROVIDER_RESPONSE_STAGES)[number],
        )
        ? "failed"
        : "ambiguous";
  }
}

/**
 * SQLite projection of the same durable opening-invocation rules above.
 * The original provider error code remains untouched for diagnostics.
 */
export const OPENING_INVOCATION_USAGE_STATUS_SQL = `CASE
      WHEN invocation.task = 'book_start_guidance'
        AND invocation.status = 'cancelled'
        AND invocation.provider_dispatch_started_at IS NULL
      THEN 'not_dispatched'
      WHEN invocation.task = 'book_start_guidance'
        AND invocation.status = 'cancelled'
      THEN 'cancelled'
      WHEN invocation.task = 'book_start_guidance'
        AND invocation.status = 'timed_out'
        AND invocation.provider_dispatch_started_at IS NULL
      THEN 'not_dispatched'
      WHEN invocation.task = 'book_start_guidance'
        AND invocation.status = 'timed_out'
      THEN 'ambiguous'
      WHEN invocation.task = 'book_start_guidance'
        AND invocation.status = 'failed'
        AND invocation.provider_dispatch_started_at IS NULL
      THEN 'not_dispatched'
      WHEN invocation.task = 'book_start_guidance'
        AND invocation.status = 'failed'
        AND (
          invocation.error_code = 'OPENING_DISPATCH_AMBIGUOUS'
          OR invocation.failure_stage IS NULL
          OR invocation.failure_stage NOT IN (
            'http_response', 'stream_parse', 'response_normalization'
          )
        )
      THEN 'ambiguous'
      WHEN invocation.task = 'book_start_guidance'
        AND invocation.status = 'failed'
      THEN 'failed'
      WHEN invocation.error_code = 'OPENING_DISPATCH_AMBIGUOUS' THEN 'ambiguous'
      WHEN invocation.error_code = 'OPENING_NOT_DISPATCHED' THEN 'not_dispatched'
      WHEN invocation.status = 'succeeded' THEN 'succeeded'
      WHEN invocation.status IN ('failed', 'timed_out') THEN 'failed'
      WHEN invocation.status = 'cancelled' THEN 'cancelled'
      WHEN invocation.status = 'running' THEN 'running'
      ELSE 'queued'
    END`;
