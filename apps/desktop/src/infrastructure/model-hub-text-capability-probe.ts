import { ModelCenterError } from "./model-center-store";
import {
  isLoopbackModelBaseUrl,
  modelProviderTextCapabilityProbePolicy,
  type ModelProviderKind,
} from "./model-hub-provider-registry";
import type {
  ModelCatalogEntry,
  ModelFailureStage,
  ModelHubStore,
  ModelInvocationFact,
  ModelProviderConnection,
  SafeAiFailureMetadata,
} from "./model-hub-store";
import type {
  NativeModelEndpointConfig,
  NativeModelGatewayClient,
  NativeModelGenerationInput,
  NativeModelGenerationResult,
  NativeModelGenerationUsage,
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

export interface AuditedModelHubTextCapabilityProbeResult extends ModelHubTextCapabilityProbeResult {
  readonly invocation: ModelInvocationFact;
}

export interface RunModelHubTextCapabilityProbeInput {
  readonly gateway: Pick<
    NativeModelGatewayClient,
    "generate" | "supportsNativeInvocationDispatchLedger"
  >;
  readonly providerKind: ModelProviderKind;
  readonly generationId: string;
  readonly config: NativeModelEndpointConfig;
  readonly model: string;
  readonly invocationDispatchLedger?: NativeModelGenerationInput["invocationDispatchLedger"];
  readonly onInvocationDispatchAccepted?: NativeModelGenerationInput["onInvocationDispatchAccepted"];
}

export interface ExecuteAuditedModelHubTextCapabilityProbeInput extends RunModelHubTextCapabilityProbeInput {
  readonly modelHub: Pick<
    ModelHubStore,
    "startInvocation" | "markInvocationDispatched" | "finishInvocation" | "findInvocation"
  >;
  readonly clock: Readonly<{ now(): string }>;
  readonly invocationId: string;
  readonly connection: Pick<
    ModelProviderConnection,
    "id" | "revision" | "providerKind" | "baseUrl"
  >;
  readonly catalogEntry: Pick<ModelCatalogEntry, "id" | "revision" | "providerModelId">;
  /** Last authoritative identity/disclosure fence. It runs before the durable dispatch receipt. */
  readonly assertBeforeProviderDispatch?: () => void | Promise<void>;
  /** Synchronous observation emitted only after the durable dispatch receipt exists. */
  readonly onProviderDispatchStarted?: (invocation: ModelInvocationFact) => void;
}

export interface ExecuteAuditedModelHubCapabilityProbeInput<Result> {
  readonly modelHub: Pick<
    ModelHubStore,
    "startInvocation" | "markInvocationDispatched" | "finishInvocation" | "findInvocation"
  >;
  readonly clock: Readonly<{ now(): string }>;
  readonly providerKind: ModelProviderKind;
  readonly invocationId: string;
  readonly connection: Pick<
    ModelProviderConnection,
    "id" | "revision" | "providerKind" | "baseUrl"
  >;
  readonly catalogEntry: Pick<ModelCatalogEntry, "id" | "revision" | "providerModelId">;
  readonly assertBeforeProviderDispatch?: () => void | Promise<void>;
  readonly onProviderDispatchStarted?: (invocation: ModelInvocationFact) => void;
  readonly supportsNativeInvocationDispatchLedger: boolean;
  readonly runProbe: (boundary: CapabilityProbeNativeDispatchBoundary) => Promise<Result>;
  readonly observeSuccess: (result: Result) => Readonly<{
    usage: NativeModelGenerationUsage | null;
    streamed: boolean;
    visibleContentLength: number;
  }>;
}

type CapabilityProbeNativeDispatchBoundary = Readonly<{
  invocationDispatchLedger?: NativeModelGenerationInput["invocationDispatchLedger"];
  onInvocationDispatchAccepted?: NativeModelGenerationInput["onInvocationDispatchAccepted"];
}>;

export interface AuditedModelHubCapabilityProbeResult<Result> {
  readonly result: Result;
  readonly invocation: ModelInvocationFact;
}

/**
 * A native dispatch receipt can already be durable while the renderer is still
 * validating the invoke handshake. If that local handshake fails, the
 * Provider outcome is unknown even though the authoritative invocation proves
 * dispatch started. Explicit Provider responses remain definite failures.
 */
export function isRecoveredNativeDispatchHandshakeAmbiguous(
  recoveredNativeDispatchReceipt: boolean,
  cancelled: boolean,
  failure: Pick<SafeAiFailureMetadata, "stage" | "httpStatus">,
): boolean {
  const stage = failure.stage ?? "unknown";
  return (
    recoveredNativeDispatchReceipt &&
    !cancelled &&
    (failure.httpStatus ?? null) === null &&
    (stage === "unknown" || stage === "dispatch" || stage === "transport")
  );
}

/**
 * Executes one fixed, content-free text capability probe with the same durable
 * dispatch receipt as writing calls. It never retries and never stores either
 * the fixed probe text or the provider output in the ledger.
 */
export async function executeAuditedModelHubTextCapabilityProbe(
  input: ExecuteAuditedModelHubTextCapabilityProbeInput,
): Promise<AuditedModelHubTextCapabilityProbeResult> {
  const audited = await executeAuditedModelHubCapabilityProbe({
    modelHub: input.modelHub,
    clock: input.clock,
    providerKind: input.providerKind,
    invocationId: input.invocationId,
    connection: input.connection,
    catalogEntry: input.catalogEntry,
    ...(input.assertBeforeProviderDispatch === undefined
      ? {}
      : { assertBeforeProviderDispatch: input.assertBeforeProviderDispatch }),
    ...(input.onProviderDispatchStarted === undefined
      ? {}
      : { onProviderDispatchStarted: input.onProviderDispatchStarted }),
    supportsNativeInvocationDispatchLedger:
      input.gateway.supportsNativeInvocationDispatchLedger === true,
    runProbe: (boundary) => runModelHubTextCapabilityProbe({ ...input, ...boundary }),
    observeSuccess: (result) => ({
      usage: result.usage,
      streamed: result.streamed,
      visibleContentLength: Array.from(result.text).length,
    }),
  });
  return Object.freeze({ ...audited.result, invocation: audited.invocation });
}

/**
 * Shared content-free ledger boundary for every capability probe shape. The
 * caller supplies the fixed probe implementation and only bounded counts are
 * persisted; prompts, responses, endpoints and credentials never enter the
 * invocation row.
 */
export async function executeAuditedModelHubCapabilityProbe<Result>(
  input: ExecuteAuditedModelHubCapabilityProbeInput<Result>,
): Promise<AuditedModelHubCapabilityProbeResult<Result>> {
  const local = isLoopbackModelBaseUrl(input.connection.baseUrl);
  let invocation = await input.modelHub.startInvocation({
    id: input.invocationId,
    task: "capability_probe",
    routeTask: null,
    connectionId: input.connection.id,
    catalogEntryId: input.catalogEntry.id,
    providerKindSnapshot: input.connection.providerKind,
    modelIdSnapshot: input.catalogEntry.providerModelId,
    routeReason: "user_override",
    attempt: 1,
    privacyPolicy: local ? "local_only" : "cloud_allowed",
    dataDestination: local ? "local" : "remote",
    maximumCostMicros: null,
    currency: null,
  });
  let dispatched = false;
  let providerCompleted = false;
  let recoveredNativeDispatchReceipt = false;
  const nativeDispatchLedger = input.supportsNativeInvocationDispatchLedger;
  const nativeReceiptObservation = { postReceiptLocalFailure: false };
  try {
    await input.assertBeforeProviderDispatch?.();
    if (!nativeDispatchLedger) {
      invocation = await input.modelHub.markInvocationDispatched({
        id: invocation.id,
        dispatchedAt: input.clock.now(),
        expectedRevision: invocation.revision,
      });
      dispatched = true;
      input.onProviderDispatchStarted?.(invocation);
    }
    const result = await input.runProbe(
      nativeDispatchLedger
        ? {
            invocationDispatchLedger: {
              invocationId: invocation.id,
              expectedRevision: invocation.revision,
              connectionId: input.connection.id,
              connectionRevision: input.connection.revision,
              catalogEntryId: input.catalogEntry.id,
              catalogEntryRevision: input.catalogEntry.revision,
              providerKindSnapshot: input.connection.providerKind,
              modelIdSnapshot: input.catalogEntry.providerModelId,
            },
            onInvocationDispatchAccepted: (receipt) => {
              invocation = Object.freeze({
                ...invocation,
                providerDispatchStartedAt: receipt.dispatchedAt,
                revision: receipt.revision,
              });
              dispatched = true;
              try {
                input.onProviderDispatchStarted?.(invocation);
              } catch (cause: unknown) {
                nativeReceiptObservation.postReceiptLocalFailure = true;
                throw cause;
              }
            },
          }
        : {},
    );
    providerCompleted = true;
    const observation = input.observeSuccess(result);
    invocation = await input.modelHub.finishInvocation({
      id: invocation.id,
      status: "succeeded",
      inputTokens: observation.usage?.inputTokens ?? null,
      outputTokens: observation.usage?.outputTokens ?? null,
      cachedInputTokens: observation.usage?.cachedInputTokens ?? null,
      estimatedCostMicros: null,
      currency: null,
      completion: {
        visibleContentLength: observation.visibleContentLength,
        stream: observation.streamed,
      },
      expectedRevision: invocation.revision,
    });
    return Object.freeze({ result, invocation });
  } catch (cause: unknown) {
    if (providerCompleted) {
      throw new AggregateError(
        [cause],
        "模型能力验证已经返回，但调用账本未能安全结算；重启后会标记为结果待核对，系统不会自动重发。",
      );
    }
    if (nativeDispatchLedger && !dispatched) {
      try {
        const persisted = await input.modelHub.findInvocation(invocation.id);
        if (
          persisted?.status === "running" &&
          persisted.providerDispatchStartedAt !== null &&
          persisted.revision === invocation.revision + 1
        ) {
          invocation = persisted;
          dispatched = true;
          recoveredNativeDispatchReceipt = true;
        }
      } catch {
        // Startup reconciliation owns an unreadable durable receipt.
      }
    }
    const observed = modelHubTextCapabilityProbeFailureMetadata(cause, input.providerKind);
    const failure: SafeAiFailureMetadata = Object.freeze({
      requestId: observed.requestId ?? null,
      stage: dispatched ? (observed.stage ?? "unknown") : "request_preparation",
      retryable: observed.retryable ?? null,
      httpStatus: observed.httpStatus ?? null,
      finishReason: observed.finishReason ?? null,
      visibleContentLength: observed.visibleContentLength ?? null,
      reasoningPresent: observed.reasoningPresent ?? null,
      stream: observed.stream ?? null,
      attempt: observed.attempt ?? 1,
      requestedMaxOutputTokens: observed.requestedMaxOutputTokens ?? null,
    });
    const cancelled = errorCode(cause) === "MODEL_GENERATION_CANCELLED";
    const ambiguous =
      nativeReceiptObservation.postReceiptLocalFailure ||
      isRecoveredNativeDispatchHandshakeAmbiguous(
        recoveredNativeDispatchReceipt,
        cancelled,
        failure,
      ) ||
      (dispatched && !cancelled && failure.stage === "transport" && failure.httpStatus === null);
    const code = ambiguous
      ? "PROVIDER_RESULT_AMBIGUOUS"
      : dispatched
        ? (errorCode(cause) ?? "MODEL_CAPABILITY_PROBE_FAILED")
        : "CAPABILITY_PROBE_NOT_DISPATCHED";
    try {
      invocation = await input.modelHub.finishInvocation({
        id: invocation.id,
        status: cancelled ? "cancelled" : ambiguous ? "timed_out" : "failed",
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        estimatedCostMicros: null,
        currency: null,
        ...(cancelled
          ? {}
          : {
              errorCode: code,
              errorSummary: ambiguous
                ? "模型能力验证已发送，但连接在收到明确结果前中断；结果未知且不会自动重发。"
                : dispatched
                  ? "模型能力验证没有成功；不会自动重试。"
                  : "模型能力验证在发送前停止；没有发生模型服务调用。",
              failure,
            }),
        expectedRevision: invocation.revision,
      });
    } catch (ledgerCause: unknown) {
      throw new AggregateError(
        [cause, ledgerCause],
        "模型能力验证未能安全结算调用账本；系统不会自动重发。",
      );
    }
    void invocation;
    if (ambiguous) {
      throw new ModelCenterError(
        "PROVIDER_RESULT_AMBIGUOUS",
        "模型能力验证已经发送，但结果无法确认。为避免重复费用，系统不会自动重发。",
        false,
      );
    }
    throw cause;
  }
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
      ...(input.invocationDispatchLedger === undefined
        ? {}
        : { invocationDispatchLedger: input.invocationDispatchLedger }),
      ...(input.onInvocationDispatchAccepted === undefined
        ? {}
        : { onInvocationDispatchAccepted: input.onInvocationDispatchAccepted }),
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
