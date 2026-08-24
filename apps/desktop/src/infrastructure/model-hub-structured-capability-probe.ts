import { ModelCenterError } from "./model-center-store";
import {
  getModelProviderPreset,
  modelProviderVisibleProsePolicy,
  type ModelProviderKind,
} from "./model-hub-provider-registry";
import type {
  ModelCatalogEntry,
  ModelHubStore,
  ModelInvocationFact,
  ModelProviderConnection,
} from "./model-hub-store";
import { executeAuditedModelHubCapabilityProbe } from "./model-hub-text-capability-probe";
import type {
  NativeModelEndpointConfig,
  NativeModelGatewayClient,
  NativeModelGenerationInput,
  NativeModelGenerationUsage,
  NativeModelMessage,
} from "./runtime";

export const MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS = 512;
export const MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_VERSION = "inkshadow.structured-output-probe.v1";

export const MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MESSAGES = Object.freeze([
  Object.freeze({
    role: "system" as const,
    content:
      "Return one JSON object only. Do not use Markdown or extra prose. The JSON schema is exactly: {schemaVersion: 1, ok: true, label: 'inkshadow' }.",
  }),
  Object.freeze({
    role: "user" as const,
    content:
      'JSON capability check. Return exactly {"schemaVersion":1,"ok":true,"label":"inkshadow"}.',
  }),
]) satisfies readonly NativeModelMessage[];

export interface RunModelHubStructuredCapabilityProbeInput {
  readonly gateway: Pick<
    NativeModelGatewayClient,
    "generate" | "supportsNativeInvocationDispatchLedger"
  >;
  readonly providerKind: ModelProviderKind;
  /** One user-triggered probe maps to exactly one Provider request. */
  readonly generationId: string;
  readonly config: NativeModelEndpointConfig;
  readonly model: string;
  /** Revalidates the exact user-disclosed target immediately before dispatch. */
  readonly assertBeforeProviderDispatch?: () => Promise<void>;
  readonly invocationDispatchLedger?: NativeModelGenerationInput["invocationDispatchLedger"];
  readonly onInvocationDispatchAccepted?: NativeModelGenerationInput["onInvocationDispatchAccepted"];
}

export interface ModelHubStructuredCapabilityProbeResult {
  readonly verificationMethod: "openai_compatible_json_object";
  readonly evidenceVersion: typeof MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_VERSION;
  readonly attempts: 1;
  readonly repaired: false;
  readonly streamed: boolean;
  readonly usage: NativeModelGenerationUsage | null;
  readonly visibleContentLength: number;
}

export interface AuditedModelHubStructuredCapabilityProbeResult extends ModelHubStructuredCapabilityProbeResult {
  readonly invocation: ModelInvocationFact;
}

export interface ExecuteAuditedModelHubStructuredCapabilityProbeInput extends RunModelHubStructuredCapabilityProbeInput {
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
  readonly onProviderDispatchStarted?: (invocation: ModelInvocationFact) => void;
}

export async function executeAuditedModelHubStructuredCapabilityProbe(
  input: ExecuteAuditedModelHubStructuredCapabilityProbeInput,
): Promise<AuditedModelHubStructuredCapabilityProbeResult> {
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
    runProbe: (boundary) =>
      runModelHubStructuredCapabilityProbe({
        gateway: input.gateway,
        providerKind: input.providerKind,
        generationId: input.generationId,
        config: input.config,
        model: input.model,
        ...boundary,
      }),
    observeSuccess: (result) => ({
      usage: result.usage,
      streamed: result.streamed,
      visibleContentLength: result.visibleContentLength,
    }),
  });
  return Object.freeze({ ...audited.result, invocation: audited.invocation });
}

/**
 * Probes an OpenAI-compatible JSON mode without sending project content.
 * Provider success is insufficient: the visible response must also pass the
 * exact local schema. Neither the fixed prompt nor response belongs in stored
 * capability evidence; callers persist only this bounded receipt.
 */
export async function runModelHubStructuredCapabilityProbe(
  input: RunModelHubStructuredCapabilityProbeInput,
): Promise<ModelHubStructuredCapabilityProbeResult> {
  if (getModelProviderPreset(input.providerKind).protocol !== "openai_compatible") {
    throw new ModelCenterError(
      "MODEL_STRUCTURED_OUTPUT_PROBE_UNSUPPORTED",
      "当前供应商协议不能使用 OpenAI-compatible JSON 模式探针。",
    );
  }
  const reasoningMode = modelProviderVisibleProsePolicy(input.providerKind).reasoningMode;
  await input.assertBeforeProviderDispatch?.();
  try {
    const generated = await input.gateway.generate({
      dispatchScope: { kind: "non_project", reason: "connection_probe" },
      generationId: input.generationId,
      config: Object.freeze({ ...input.config, retryLimit: 0 }),
      model: input.model,
      messages: MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MESSAGES,
      maxOutputTokens: MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
      responseFormat: "json_object",
      ...(reasoningMode === null ? {} : { reasoningMode }),
      ...(input.invocationDispatchLedger === undefined
        ? {}
        : { invocationDispatchLedger: input.invocationDispatchLedger }),
      ...(input.onInvocationDispatchAccepted === undefined
        ? {}
        : { onInvocationDispatchAccepted: input.onInvocationDispatchAccepted }),
    });
    assertStructuredProbeResponse(generated.text);
    return Object.freeze({
      verificationMethod: "openai_compatible_json_object",
      evidenceVersion: MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_VERSION,
      attempts: 1,
      repaired: false,
      streamed: generated.streamed === true,
      usage: generated.usage,
      visibleContentLength: Array.from(generated.text).length,
    });
  } catch (cause: unknown) {
    if (!(cause instanceof ModelCenterError) || !cause.code.startsWith("MODEL_STRUCTURED_OUTPUT")) {
      throw cause;
    }
    throw new ModelCenterError(
      "MODEL_STRUCTURED_OUTPUT_PROBE_FAILED",
      "模型没有通过 JSON 结构化输出验证；没有写入能力证据或修改创作任务安排。再次验证需要用户重新触发。",
      isRetryable(cause),
      cause instanceof ModelCenterError ? cause.diagnostics : null,
    );
  }
}

export function assertStructuredProbeResponse(response: string): void {
  if (typeof response !== "string" || response.trim().length === 0) {
    throw probeResponseError("MODEL_STRUCTURED_OUTPUT_EMPTY");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.trim()) as unknown;
  } catch {
    throw probeResponseError("MODEL_STRUCTURED_OUTPUT_INVALID_JSON");
  }
  if (!isRecord(parsed)) throw probeResponseError("MODEL_STRUCTURED_OUTPUT_SCHEMA_MISMATCH");
  const keys = Object.keys(parsed).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "label" ||
    keys[1] !== "ok" ||
    keys[2] !== "schemaVersion" ||
    parsed.schemaVersion !== 1 ||
    parsed.ok !== true ||
    parsed.label !== "inkshadow"
  ) {
    throw probeResponseError("MODEL_STRUCTURED_OUTPUT_SCHEMA_MISMATCH");
  }
}

function probeResponseError(code: string): ModelCenterError {
  return new ModelCenterError(
    code,
    "结构化输出探针响应为空、不是纯 JSON 或不符合固定 schema。",
    true,
  );
}

function isRetryable(cause: unknown): boolean {
  return isRecord(cause) && typeof cause.retryable === "boolean" ? cause.retryable : true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
