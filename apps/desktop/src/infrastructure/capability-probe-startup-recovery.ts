import type { ModelHubStore, ModelInvocationFact } from "./model-hub-store";

export interface CapabilityProbeStartupRecoveryReceipt {
  readonly inspectedInvocationCount: number;
  readonly notDispatchedCount: number;
  readonly ambiguousCount: number;
  readonly failedRecoveryCount: number;
}

/**
 * Terminalizes capability probes left running by process loss. A durable
 * dispatch receipt means the provider result is unknown; its absence proves no
 * provider call crossed the boundary. Recovery never invokes the gateway and
 * is safe to run repeatedly.
 */
export async function recoverOrphanedCapabilityProbeInvocationsAtStartup(
  modelHub: Pick<ModelHubStore, "listRunningInvocations" | "findInvocation" | "finishInvocation">,
): Promise<CapabilityProbeStartupRecoveryReceipt> {
  const running = await modelHub.listRunningInvocations("capability_probe");
  let notDispatchedCount = 0;
  let ambiguousCount = 0;
  let failedRecoveryCount = 0;

  for (const pending of running) {
    const dispatched = pending.providerDispatchStartedAt !== null;
    try {
      const terminal = await finishRecoveredCapabilityProbe(modelHub, pending, dispatched);
      if (terminal.status === "running" || terminal.status === "queued") {
        failedRecoveryCount += 1;
      } else if (dispatched) {
        ambiguousCount += 1;
      } else {
        notDispatchedCount += 1;
      }
    } catch {
      failedRecoveryCount += 1;
    }
  }

  return Object.freeze({
    inspectedInvocationCount: running.length,
    notDispatchedCount,
    ambiguousCount,
    failedRecoveryCount,
  });
}

async function finishRecoveredCapabilityProbe(
  modelHub: Pick<ModelHubStore, "findInvocation" | "finishInvocation">,
  pending: ModelInvocationFact,
  dispatched: boolean,
): Promise<ModelInvocationFact> {
  try {
    return await modelHub.finishInvocation({
      id: pending.id,
      status: dispatched ? "timed_out" : "failed",
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      estimatedCostMicros: null,
      currency: null,
      errorCode: dispatched ? "PROVIDER_RESULT_AMBIGUOUS" : "CAPABILITY_PROBE_NOT_DISPATCHED",
      errorSummary: dispatched
        ? "模型能力验证已发送，但应用在收到明确结果前退出；结果待核对且不会自动重发。"
        : "模型能力验证在发送前被应用退出中断；没有发生模型服务调用。",
      failure: {
        requestId: null,
        stage: dispatched ? "transport" : "request_preparation",
        retryable: false,
        httpStatus: null,
        finishReason: null,
        visibleContentLength: null,
        reasoningPresent: null,
        stream: null,
        attempt: pending.attempt,
        requestedMaxOutputTokens: null,
      },
      expectedRevision: pending.revision,
    });
  } catch (cause: unknown) {
    const current = await modelHub.findInvocation(pending.id);
    if (current === null || current.status === "running" || current.status === "queued") {
      throw cause;
    }
    return current;
  }
}
