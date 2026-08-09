import { CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";
import { describe, expect, it, vi } from "vitest";

import type { ModelHubTextTaskExecutionResult } from "./model-hub-execution-service";
import { ModelHubLocalEvaluationService } from "./model-hub-local-evaluation-service";
import type { ModelEvaluationResult } from "./model-hub-store";

function execution(text: string, catalogEntryId = "catalog-1"): ModelHubTextTaskExecutionResult {
  return {
    text,
    usage: null,
    invocation: {
      id: "invocation-1",
      task: "continuation",
      routeTask: "continuation",
      connectionId: "connection-1",
      catalogEntryId,
      providerKindSnapshot: "openai",
      modelIdSnapshot: "model-1",
      routeReason: "task_primary",
      attempt: 1,
      fallbackFromInvocationId: null,
      privacyPolicy: "cloud_allowed",
      dataDestination: "remote",
      maximumCostMicros: null,
      currency: null,
      status: "succeeded",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      estimatedCostMicros: null,
      errorCode: null,
      errorSummary: null,
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      revision: 2,
    },
    connectionId: "connection-1",
    catalogEntryId,
    providerKind: "openai",
    modelId: "model-1",
    usedFallback: false,
    costCeilingExceededAfterDispatch: false,
  };
}

describe("model hub local evaluation service", () => {
  it("records a scoped evaluation after two exact content-free probes", async () => {
    const recorded: ModelEvaluationResult[] = [];
    const executeText = vi
      .fn()
      .mockResolvedValueOnce(execution("INKSHADOW_OK"))
      .mockResolvedValueOnce(execution('{"status":"ok","items":["a","b"]}'));
    const service = new ModelHubLocalEvaluationService(
      {} as never,
      {
        recordEvaluationResult: (input) => {
          if (input.observedAt === undefined || input.observedAt === null) {
            throw new Error("The evaluation fixture requires an observation time.");
          }
          const result: ModelEvaluationResult = {
            ...input,
            observedAt: input.observedAt,
            expiresAt: input.expiresAt ?? null,
          };
          recorded.push(result);
          return Promise.resolve(result);
        },
      },
      new CryptoUuidV7Generator(),
      new SystemClock(),
      executeText,
    );

    const receipt = await service.evaluate("continuation");

    expect(receipt).toMatchObject({
      exactInstructionPassCount: 2,
      sampleCount: 2,
      scope: "basic_instruction_adherence",
    });
    expect(recorded[0]).toMatchObject({
      task: "continuation",
      scoreBasisPoints: 10_000,
      sampleCount: 2,
      evaluationSource: "local_evaluation",
    });
    expect(executeText).toHaveBeenCalledTimes(2);
    for (const call of executeText.mock.calls) {
      expect(call[1]).toMatchObject({
        maximumOutputTokens: 64,
        reasoningPolicy: "capability_probe",
        dispatchScope: { kind: "non_project", reason: "connection_probe" },
      });
    }
  });

  it("refuses to combine probes that were routed to different models", async () => {
    const executeText = vi
      .fn()
      .mockResolvedValueOnce(execution("INKSHADOW_OK", "catalog-1"))
      .mockResolvedValueOnce(execution('{"status":"ok","items":["a","b"]}', "catalog-2"));
    const service = new ModelHubLocalEvaluationService(
      {} as never,
      { recordEvaluationResult: vi.fn() },
      new CryptoUuidV7Generator(),
      new SystemClock(),
      executeText,
    );

    await expect(service.evaluate("continuation")).rejects.toMatchObject({
      code: "MODEL_EVALUATION_INCONSISTENT_ROUTE",
    });
  });

  it("does not record a partial evaluation when a probe fails", async () => {
    const recordEvaluationResult = vi.fn();
    const executeText = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("provider unavailable"), {
        code: "MODEL_TIMEOUT",
        retryable: true,
      }),
    );
    const service = new ModelHubLocalEvaluationService(
      {} as never,
      { recordEvaluationResult },
      new CryptoUuidV7Generator(),
      new SystemClock(),
      executeText,
    );

    await expect(service.evaluate("continuation")).rejects.toMatchObject({
      code: "MODEL_EVALUATION_UNAVAILABLE",
      retryable: true,
    });
    expect(recordEvaluationResult).not.toHaveBeenCalled();
    expect(executeText.mock.calls[0]?.[1]).toMatchObject({
      maximumOutputTokens: 64,
      reasoningPolicy: "capability_probe",
    });
  });
});
