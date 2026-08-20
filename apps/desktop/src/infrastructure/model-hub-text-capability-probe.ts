import { ModelCenterError } from "./model-center-store";
import {
  modelProviderTextCapabilityProbePolicy,
  type ModelProviderKind,
} from "./model-hub-provider-registry";
import type { ModelFailureStage, SafeAiFailureMetadata } from "./model-hub-store";
import type {
  NativeModelEndpointConfig,
  NativeModelGatewayClient,
  NativeModelGenerationResult,
  NativeModelMessage,
} from "./runtime";
import type { NativeModelDispatchScope } from "./native-model-gateway-contract";

export const MODEL_HUB_TEXT_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS =
  modelProviderTextCapabilityProbePolicy("openai").maxOutputTokens;

export const MODEL_HUB_TEXT_CAPABILITY_PROBE_MESSAGES = Object.freeze([
  Object.freeze({ role: "user" as const, content: "只回复：OK" }),
]) satisfies readonly NativeModelMessage[];

export const MODEL_HUB_TEXT_CAPABILITY_PROBE_DISPATCH_SCOPE = Object.freeze({
  kind: "non_project",
  reason: "connection_probe",
}) satisfies NativeModelDispatchScope;

export interface ModelHubTextCapabilityProbeResult extends NativeModelGenerationResult {
  /** True only when a probe accepted already-visible text from a truncated native response. */
  readonly acceptedTruncatedOutput: boolean;
  /** Authoritative native transport observation, never inferred from receiving a delta callback. */
  readonly streamed: boolean;
  /** Present only when visible text made a truncated probe a truthful partial success. */
  readonly partialFailure: SafeAiFailureMetadata | null;
}

export interface RunModelHubTextCapabilityProbeInput {
  readonly gateway: Pick<NativeModelGatewayClient, "generate">;
  readonly providerKind: ModelProviderKind;
  readonly generationId: string;
  readonly config: NativeModelEndpointConfig;
  readonly model: string;
}

/**
 * Proves only that a model can emit visible text. The returned text is intended
 * for an in-memory truth check and must not be persisted as capability evidence.
 * Provider policy is resolved by the registry, so DeepSeek disables reasoning
 * and receives the shared 64-token probe budget without model-name guessing.
 *
 * Native generation correctly rejects truncated creative output. This narrow
 * probe boundary may still accept text that was already visibly emitted before
 * `MODEL_OUTPUT_TRUNCATED`, because the probe is not user content and does not
 * claim that the answer is complete. No production generation path uses this
 * exception.
 */
export async function runModelHubTextCapabilityProbe(
  input: RunModelHubTextCapabilityProbeInput,
): Promise<ModelHubTextCapabilityProbeResult> {
  const policy = modelProviderTextCapabilityProbePolicy(input.providerKind);
  let visibleText = "";
  try {
    const generated = await input.gateway.generate({
      dispatchScope: MODEL_HUB_TEXT_CAPABILITY_PROBE_DISPATCH_SCOPE,
      generationId: input.generationId,
      config: input.config,
      model: input.model,
      messages: MODEL_HUB_TEXT_CAPABILITY_PROBE_MESSAGES,
      maxOutputTokens: policy.maxOutputTokens,
      ...(policy.reasoningMode === null ? {} : { reasoningMode: policy.reasoningMode }),
      onDelta: (accumulatedText) => {
        visibleText = accumulatedText;
      },
    });
    const text = generated.text.trim().length > 0 ? generated.text : visibleText;
    if (text.trim().length === 0) {
      throw new ModelCenterError(
        "MODEL_OUTPUT_EMPTY",
        "The capability probe completed without visible text.",
      );
    }
    return Object.freeze({
      text,
      usage: generated.usage,
      streamed: generated.streamed === true,
      acceptedTruncatedOutput: false,
      partialFailure: null,
    });
  } catch (cause: unknown) {
    if (errorCode(cause) !== "MODEL_OUTPUT_TRUNCATED" || visibleText.trim().length === 0) {
      throw cause;
    }
    return Object.freeze({
      text: visibleText,
      usage: null,
      streamed: nativeStreamObservation(cause) === true,
      acceptedTruncatedOutput: true,
      partialFailure: modelHubTextCapabilityProbeFailureMetadata(cause, input.providerKind),
    });
  }
}

export function modelHubTextCapabilityProbeFailureMetadata(
  cause: unknown,
  providerKind: ModelProviderKind,
): SafeAiFailureMetadata {
  const diagnostics = isRecord(cause) && isRecord(cause.diagnostics) ? cause.diagnostics : null;
  return Object.freeze({
    requestId: safeString(diagnostics?.requestId),
    stage: failureStage(errorCode(cause)),
    retryable: isRecord(cause) && typeof cause.retryable === "boolean" ? cause.retryable : null,
    httpStatus: safeInteger(diagnostics?.httpStatus, 100, 599),
    finishReason: safeString(diagnostics?.finishReason),
    visibleContentLength: safeInteger(diagnostics?.visibleContentLength, 0, 100_000_000),
    reasoningPresent:
      typeof diagnostics?.reasoningPresent === "boolean" ? diagnostics.reasoningPresent : null,
    stream: typeof diagnostics?.stream === "boolean" ? diagnostics.stream : null,
    attempt: 1,
    requestedMaxOutputTokens: modelProviderTextCapabilityProbePolicy(providerKind).maxOutputTokens,
  });
}

function errorCode(cause: unknown): string | null {
  return isRecord(cause) && typeof cause.code === "string" ? cause.code : null;
}

function nativeStreamObservation(cause: unknown): boolean | null {
  if (!isRecord(cause) || !isRecord(cause.diagnostics)) return null;
  return typeof cause.diagnostics.stream === "boolean" ? cause.diagnostics.stream : null;
}

function failureStage(code: string | null): ModelFailureStage {
  if (code === null) return "unknown";
  if (/STREAM|SSE/u.test(code)) return "stream_parse";
  if (/OUTPUT|RESPONSE|MALFORMED|JSON/u.test(code)) return "response_normalization";
  if (code.includes("HTTP")) return "http_response";
  if (/NETWORK|TIMEOUT|DNS|TLS|TRANSPORT/u.test(code)) return "transport";
  return "unknown";
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 ? value : null;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
