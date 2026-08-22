import { CryptoUuidV7Generator, SystemClock } from "@inkshadow/platform";
import { describe, expect, it, vi } from "vitest";

import type {
  ExecuteModelHubTextTaskInput,
  ModelHubTextExecutionDependencies,
  ModelHubTextTaskExecutionResult,
  ModelHubTextTaskInspection,
} from "./model-hub-execution-service";
import { ModelHubLocalEvaluationService } from "./model-hub-local-evaluation-service";
import type { ModelEvaluationResult } from "./model-hub-store";

function inspection(
  overrides: Partial<ModelHubTextTaskInspection> = {},
): ModelHubTextTaskInspection {
  return {
    task: "continuation",
    configuredPrimaryCatalogEntryId: "catalog-1",
    configuredFallbackCatalogEntryId: null,
    selectionKind: "task_primary",
    usedFallback: false,
    attempt: 1,
    connectionId: "connection-1",
    catalogEntryId: "catalog-1",
    providerKind: "openai",
    modelId: "model-1",
    dataDestination: "remote",
    privacyPolicy: "cloud_allowed",
    failurePolicy: "stop",
    maximumOutputTokens: 64,
    temperature: 0,
    estimatedInputTokens: 32,
    estimatedTotalTokens: 96,
    inputTokenLimit: 8_192,
    outputTokenLimit: 4_096,
    tokenLimitEvidence: {
      source: "catalog",
      version: "v1",
      updatedAt: "2026-08-01T00:00:00.000Z",
      sourceUrl: null,
      verifiedByInkShadow: true,
    },
    pricing: {
      currency: "USD",
      inputMicrosPerMillionTokens: "1000000",
      outputMicrosPerMillionTokens: "1000000",
      cachedInputMicrosPerMillionTokens: null,
      pricingVersion: "v1",
      priceUpdatedAt: "2026-08-01T00:00:00.000Z",
      evidenceSource: "user_confirmed",
      evidenceVersion: "v1",
      evidenceUpdatedAt: "2026-08-01T00:00:00.000Z",
      estimatedMaximumCostMicros: "96",
      maximumCostMicros: "500",
      maximumCostCurrency: "USD",
    },
    ...overrides,
  };
}

function execution(text: string, catalogEntryId = "catalog-1"): ModelHubTextTaskExecutionResult {
  return {
    text,
    usage: null,
    invocation: {
      id: "invocation-1",
      task: "capability_probe",
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
      providerDispatchStartedAt: "2026-08-01T00:00:00.000Z",
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

type ExecuteTextStub = (
  dependencies: ModelHubTextExecutionDependencies,
  input: ExecuteModelHubTextTaskInput,
) => Promise<ModelHubTextTaskExecutionResult>;
function harness(
  input: Readonly<{
    executeText?: ReturnType<typeof vi.fn> & ExecuteTextStub;
    inspectText?: ReturnType<typeof vi.fn>;
  }> = {},
) {
  const recorded: ModelEvaluationResult[] = [];
  const executeText =
    input.executeText ??
    vi
      .fn()
      .mockResolvedValueOnce(execution("INKSHADOW_OK"))
      .mockResolvedValueOnce(execution('{"status":"ok","items":["a","b"]}'));
  const inspectText = input.inspectText ?? vi.fn(() => Promise.resolve(inspection()));
  const service = new ModelHubLocalEvaluationService(
    {} as never,
    {
      findConnection: vi.fn(() =>
        Promise.resolve({ id: "connection-1", displayName: "我的写作服务" } as never),
      ),
      recordEvaluationResult: (recordInput) => {
        const result = { ...recordInput } as ModelEvaluationResult;
        recorded.push(result);
        return Promise.resolve(result);
      },
    },
    new CryptoUuidV7Generator(),
    new SystemClock(),
    executeText as ExecuteTextStub,
    inspectText as never,
  );
  return { service, executeText, inspectText, recorded };
}

describe("model hub local evaluation service", () => {
  it("prepares an exact two-call disclosure without calling a provider", async () => {
    const test = harness();
    const disclosure = await test.service.prepare("continuation");

    expect(disclosure).toMatchObject({
      connectionDisplayName: "我的写作服务",
      modelId: "model-1",
      maximumProviderCalls: 2,
      automaticRetryCount: 0,
      estimatedMaximumCostMicros: "192",
      currency: "USD",
    });
    expect(disclosure.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(test.executeText).not.toHaveBeenCalled();
  });

  it("requires confirmation and rejects a stale fingerprint with zero provider calls", async () => {
    const test = harness();
    await expect(
      test.service.evaluate({
        task: "continuation",
        disclosureFingerprint: "stale",
        humanConfirmed: false,
      }),
    ).rejects.toMatchObject({ code: "MODEL_EVALUATION_CONFIRMATION_REQUIRED" });
    await expect(
      test.service.evaluate({
        task: "continuation",
        disclosureFingerprint: "stale",
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "MODEL_EVALUATION_DISCLOSURE_CHANGED" });
    expect(test.executeText).not.toHaveBeenCalled();
  });

  it("records a scoped evaluation after two exact content-free probes", async () => {
    const test = harness();
    const disclosure = await test.service.prepare("continuation");
    const receipt = await test.service.evaluate({
      task: "continuation",
      disclosureFingerprint: disclosure.fingerprint,
      humanConfirmed: true,
    });

    expect(receipt).toMatchObject({
      exactInstructionPassCount: 2,
      sampleCount: 2,
      scope: "basic_instruction_adherence",
    });
    expect(test.recorded[0]).toMatchObject({
      task: "continuation",
      scoreBasisPoints: 10_000,
      sampleCount: 2,
      evaluationSource: "local_evaluation",
    });
    expect(test.executeText).toHaveBeenCalledTimes(2);
    for (const call of test.executeText.mock.calls) {
      expect(call[1]).toMatchObject({
        task: "continuation",
        invocationLedgerTask: "capability_probe",
        maximumOutputTokens: 64,
        reasoningPolicy: "capability_probe",
        dispatchScope: { kind: "non_project", reason: "connection_probe" },
      });
    }
  });

  it("revalidates before the second fixed call and stops after one when cost drifts", async () => {
    let drifted = false;
    let callIndex = 0;
    const inspectText = vi.fn(() =>
      Promise.resolve(
        inspection(
          drifted
            ? { pricing: { ...inspection().pricing, estimatedMaximumCostMicros: "197" } }
            : {},
        ),
      ),
    );
    const executeText = vi.fn(
      async (
        _dependencies: ModelHubTextExecutionDependencies,
        input: ExecuteModelHubTextTaskInput,
      ) => {
        const selected = {
          generationId: "generation-1",
          invocationId: "invocation-1",
          connectionId: "connection-1",
          catalogEntryId: "catalog-1",
          modelId: "model-1",
          usedFallback: false,
          privacyPolicy: inspection().privacyPolicy,
          dataDestination: inspection().dataDestination,
        } as const;
        await input.onBeforeDispatch?.(selected);
        await input.onFinalBeforeProviderDispatch?.(selected);
        callIndex += 1;
        drifted = true;
        return execution(callIndex === 1 ? "INKSHADOW_OK" : '{"status":"ok","items":["a","b"]}');
      },
    );
    const test = harness({ executeText, inspectText });
    const disclosure = await test.service.prepare("continuation");

    await expect(
      test.service.evaluate({
        task: "continuation",
        disclosureFingerprint: disclosure.fingerprint,
        humanConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "MODEL_EVALUATION_DISCLOSURE_CHANGED" });
    expect(executeText).toHaveBeenCalledTimes(1);
    expect(test.recorded).toHaveLength(0);
  });
});
