import { sanitizeForLogging, type SafeLogObject, type SafeLogValue } from "./redaction.js";
import { createRequestId, isValidRequestId, type RequestIdFactory } from "./request-id.js";

export type HealthState = "healthy" | "degraded" | "unavailable" | "unknown";

export interface DiagnosticSummaryInput {
  readonly appVersion: string;
  readonly platform: string;
  readonly environment: "development" | "test" | "production";
  readonly databaseHealth: HealthState;
  readonly indexHealth: HealthState;
  readonly syncState: string;
  readonly errorCodes: readonly string[];
  readonly taskStateCounts: Readonly<Record<string, number>>;
  readonly requestIds?: readonly string[];
  readonly configuration: Readonly<Record<string, unknown>>;
}

export interface DiagnosticSummary {
  readonly diagnosticId: string;
  readonly generatedAt: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly environment: "development" | "test" | "production";
  readonly databaseHealth: HealthState;
  readonly indexHealth: HealthState;
  readonly syncState: string;
  readonly errorCodes: readonly string[];
  readonly taskStateCounts: Readonly<Record<string, number>>;
  readonly requestIds: readonly string[];
  readonly configuration: SafeLogObject;
}

function isSafeLogObject(value: SafeLogValue): value is SafeLogObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asSafeLogObject(value: SafeLogValue): SafeLogObject {
  if (!isSafeLogObject(value)) {
    throw new Error("Diagnostic configuration must sanitize to an object.");
  }
  return value;
}

function validateTaskCounts(
  counts: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const validated: Record<string, number> = {};
  for (const [state, count] of Object.entries(counts)) {
    if (!/^[a-z][a-z0-9_-]{1,63}$/.test(state)) {
      throw new Error(`Invalid task state name: ${state}`);
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid task count for state: ${state}`);
    }
    validated[state] = count;
  }
  return validated;
}

export function createDiagnosticSummary(
  input: DiagnosticSummaryInput,
  options: {
    readonly clock?: () => Date;
    readonly requestIdFactory?: RequestIdFactory;
  } = {},
): DiagnosticSummary {
  const clock = options.clock ?? (() => new Date());
  const errorCodes = [...new Set(input.errorCodes)]
    .filter((code) => /^[A-Z][A-Z0-9_]{2,127}$/.test(code))
    .sort();
  const requestIds = [...new Set(input.requestIds ?? [])].filter(isValidRequestId);

  return {
    diagnosticId: createRequestId(options.requestIdFactory),
    generatedAt: clock().toISOString(),
    appVersion: input.appVersion,
    platform: input.platform,
    environment: input.environment,
    databaseHealth: input.databaseHealth,
    indexHealth: input.indexHealth,
    syncState: input.syncState,
    errorCodes,
    taskStateCounts: validateTaskCounts(input.taskStateCounts),
    requestIds,
    configuration: asSafeLogObject(sanitizeForLogging(input.configuration)),
  };
}
