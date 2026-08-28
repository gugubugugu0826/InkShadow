import { ModelCenterError } from "./model-center-store";
import type { ModelProviderKind } from "./model-hub-provider-registry";
import type {
  ModelCatalogEntry,
  ModelHubStore,
  ModelInvocationFact,
  ModelProviderConnection,
  SafeAiFailureMetadata,
} from "./model-hub-store";
import {
  executeAuditedModelHubCapabilityProbe,
  modelHubTextCapabilityProbeFailureMetadata,
} from "./model-hub-text-capability-probe";
import type {
  NativeEmbeddingEndpointConfig,
  NativeEmbeddingGatewayClient,
  NativeEmbeddingInput,
  NativeEmbeddingResult,
} from "./native-embedding-gateway";
import type { NativeModelDispatchScope } from "./native-model-gateway-contract";

export const MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_INPUTS = Object.freeze(["墨影向量能力检查"]);

export const MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_DISPATCH_SCOPE = Object.freeze({
  kind: "non_project",
  reason: "connection_probe",
}) satisfies NativeModelDispatchScope;

export interface ModelHubEmbeddingCapabilityProbeResult {
  readonly dimension: number;
  readonly vectorCount: number;
}

export interface AuditedModelHubEmbeddingCapabilityProbeResult extends ModelHubEmbeddingCapabilityProbeResult {
  readonly invocation: ModelInvocationFact;
}

export interface RunModelHubEmbeddingCapabilityProbeInput {
  readonly gateway: Pick<
    NativeEmbeddingGatewayClient,
    "embed" | "supportsNativeInvocationDispatchLedger"
  >;
  readonly config: NativeEmbeddingEndpointConfig;
  readonly model: string;
  readonly invocationDispatchLedger?: NativeEmbeddingInput["invocationDispatchLedger"];
  readonly onInvocationDispatchAccepted?: NativeEmbeddingInput["onInvocationDispatchAccepted"];
}

export interface ExecuteAuditedModelHubEmbeddingCapabilityProbeInput extends RunModelHubEmbeddingCapabilityProbeInput {
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
}

/**
 * Runs one fixed, non-project embedding probe. Raw input and vectors remain
 * inside this function and are never returned to the caller or written to the
 * invocation ledger.
 */
export async function runModelHubEmbeddingCapabilityProbe(
  input: RunModelHubEmbeddingCapabilityProbeInput,
): Promise<ModelHubEmbeddingCapabilityProbeResult> {
  const embedded = await input.gateway.embed({
    config: Object.freeze({ ...input.config, retryLimit: 0 }),
    model: input.model,
    inputs: MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_INPUTS,
    dispatchScope: MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_DISPATCH_SCOPE,
    ...(input.invocationDispatchLedger === undefined
      ? {}
      : { invocationDispatchLedger: input.invocationDispatchLedger }),
    ...(input.onInvocationDispatchAccepted === undefined
      ? {}
      : { onInvocationDispatchAccepted: input.onInvocationDispatchAccepted }),
  });
  validateEmbeddingProbeResult(
    embedded,
    input.model,
    MODEL_HUB_EMBEDDING_CAPABILITY_PROBE_INPUTS.length,
  );
  return Object.freeze({ dimension: embedded.dimension, vectorCount: embedded.vectorCount });
}

export async function executeAuditedModelHubEmbeddingCapabilityProbe(
  input: ExecuteAuditedModelHubEmbeddingCapabilityProbeInput,
): Promise<AuditedModelHubEmbeddingCapabilityProbeResult> {
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
    runProbe: (boundary) => runModelHubEmbeddingCapabilityProbe({ ...input, ...boundary }),
    observeSuccess: () => ({ usage: null, streamed: false, visibleContentLength: 0 }),
    observeFailure: (cause) =>
      modelHubEmbeddingCapabilityProbeFailureMetadata(cause, input.providerKind),
  });
  return Object.freeze({ ...audited.result, invocation: audited.invocation });
}

function validateEmbeddingProbeResult(
  result: NativeEmbeddingResult,
  expectedModel: string,
  expectedCount: number,
): void {
  if (result.model !== expectedModel) {
    throw probeResultError("MODEL_EMBEDDING_MODEL_MISMATCH", "服务商返回了另一个模型的向量结果。");
  }
  if (
    result.vectorCount !== expectedCount ||
    result.embeddings.length !== expectedCount ||
    expectedCount < 1
  ) {
    throw probeResultError("MODEL_EMBEDDING_COUNT_INVALID", "服务商返回的向量条目数量不正确。");
  }
  if (!Number.isSafeInteger(result.dimension) || result.dimension <= 0) {
    throw probeResultError("MODEL_EMBEDDING_DIMENSION_INVALID", "服务商返回的向量维度无效。");
  }
  for (const vector of result.embeddings) {
    if (vector.length !== result.dimension) {
      throw probeResultError("MODEL_EMBEDDING_DIMENSION_INVALID", "服务商返回的向量维度不一致。");
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw probeResultError("MODEL_EMBEDDING_VALUE_INVALID", "服务商返回的向量含有无效数值。");
    }
    if (vector.every((value) => value === 0)) {
      throw probeResultError("MODEL_EMBEDDING_VALUE_INVALID", "服务商返回了无效的空向量。");
    }
  }
}

export function modelHubEmbeddingCapabilityProbeFailureMetadata(
  cause: unknown,
  providerKind: ModelProviderKind,
): SafeAiFailureMetadata {
  return Object.freeze({
    ...modelHubTextCapabilityProbeFailureMetadata(cause, providerKind),
    visibleContentLength: null,
    reasoningPresent: null,
    stream: false,
    requestedMaxOutputTokens: null,
  });
}

function probeResultError(code: string, message: string): ModelCenterError {
  return new ModelCenterError(code, message, false);
}
