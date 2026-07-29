export const CONNECTION_TEST_STEPS = [
  "url",
  "credential",
  "model",
  "generation",
  "streaming",
  "context",
  "embedding",
  "latency",
  "format",
] as const;

export type ConnectionTestStep = (typeof CONNECTION_TEST_STEPS)[number];
export type ConnectionTestStatus = "passed" | "failed" | "skipped";

export interface ConnectionTestStepInput {
  readonly step: ConnectionTestStep;
  readonly status: ConnectionTestStatus;
  readonly durationMs: number;
  readonly errorCode?: string;
}

export interface ConnectionTestStepResult extends ConnectionTestStepInput {
  readonly sequence: number;
}

export interface ConnectionTestReport {
  readonly providerId: string;
  readonly modelId: string;
  readonly endpointOrigin: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly overallStatus: "passed" | "failed";
  readonly steps: readonly ConnectionTestStepResult[];
}

function sanitizeEndpointOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Model endpoints must use HTTP or HTTPS.");
  }
  return url.origin;
}

function validateDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("Connection check durations must be non-negative.");
  }
}

export function createConnectionTestReport(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly endpoint: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly results: readonly ConnectionTestStepInput[];
}): ConnectionTestReport {
  const byStep = new Map<ConnectionTestStep, ConnectionTestStepInput>();

  for (const result of input.results) {
    validateDuration(result.durationMs);
    if (byStep.has(result.step)) {
      throw new Error(`Duplicate connection check step: ${result.step}`);
    }
    byStep.set(result.step, result);
  }

  const steps = CONNECTION_TEST_STEPS.map((step, index): ConnectionTestStepResult => {
    const result = byStep.get(step);
    if (result === undefined) {
      return {
        step,
        sequence: index + 1,
        status: "skipped",
        durationMs: 0,
        errorCode: "MODEL_CHECK_NOT_RUN",
      };
    }
    return {
      ...result,
      sequence: index + 1,
    };
  });

  return {
    providerId: input.providerId,
    modelId: input.modelId,
    endpointOrigin: sanitizeEndpointOrigin(input.endpoint),
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    overallStatus: steps.some((step) => step.status === "failed") ? "failed" : "passed",
    steps,
  };
}
