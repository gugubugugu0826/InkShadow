import { ModelCenterError } from "./model-center-store";
import {
  getModelProviderPreset,
  modelProviderVisibleProsePolicy,
  type ModelProviderKind,
} from "./model-hub-provider-registry";
import type {
  NativeModelEndpointConfig,
  NativeModelGatewayClient,
  NativeModelGenerationUsage,
  NativeModelMessage,
} from "./runtime";

export const MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS = 512;
export const MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_VERSION = "inkshadow.structured-output-probe.v1";

const FIRST_PROBE_MESSAGES = Object.freeze([
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

const REPAIR_PROBE_MESSAGES = Object.freeze([
  ...FIRST_PROBE_MESSAGES,
  Object.freeze({
    role: "user" as const,
    content:
      "The previous response was empty, truncated, or invalid. Repair it now and return only the exact JSON object from the schema.",
  }),
]) satisfies readonly NativeModelMessage[];

export interface RunModelHubStructuredCapabilityProbeInput {
  readonly gateway: Pick<NativeModelGatewayClient, "generate">;
  readonly providerKind: ModelProviderKind;
  readonly generationIds: readonly [string, string];
  readonly config: NativeModelEndpointConfig;
  readonly model: string;
}

export interface ModelHubStructuredCapabilityProbeResult {
  readonly verificationMethod: "openai_compatible_json_object";
  readonly evidenceVersion: typeof MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_VERSION;
  readonly attempts: 1 | 2;
  readonly repaired: boolean;
  readonly streamed: boolean;
  readonly usage: NativeModelGenerationUsage | null;
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
  for (const attempt of [1, 2] as const) {
    const generationId = attempt === 1 ? input.generationIds[0] : input.generationIds[1];
    try {
      const generated = await input.gateway.generate({
        dispatchScope: { kind: "non_project", reason: "connection_probe" },
        generationId,
        config: input.config,
        model: input.model,
        messages: attempt === 1 ? FIRST_PROBE_MESSAGES : REPAIR_PROBE_MESSAGES,
        maxOutputTokens: MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
        responseFormat: "json_object",
        ...(reasoningMode === null ? {} : { reasoningMode }),
      });
      assertStructuredProbeResponse(generated.text);
      return Object.freeze({
        verificationMethod: "openai_compatible_json_object",
        evidenceVersion: MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_VERSION,
        attempts: attempt,
        repaired: attempt === 2,
        streamed: generated.streamed === true,
        usage: generated.usage,
      });
    } catch (cause: unknown) {
      if (attempt === 1 && isRepairableStructuredProbeFailure(cause)) {
        continue;
      }
      throw new ModelCenterError(
        "MODEL_STRUCTURED_OUTPUT_PROBE_FAILED",
        "模型没有通过 JSON 结构化输出验证；没有写入能力证据或修改 AI 分工。",
        isRetryable(cause),
        cause instanceof ModelCenterError ? cause.diagnostics : null,
      );
    }
  }
  throw new ModelCenterError(
    "MODEL_STRUCTURED_OUTPUT_PROBE_FAILED",
    "模型没有通过 JSON 结构化输出验证。",
  );
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

function isRepairableStructuredProbeFailure(cause: unknown): boolean {
  const code = errorCode(cause);
  return (
    code === "MODEL_OUTPUT_TRUNCATED" ||
    code === "MODEL_OUTPUT_EMPTY" ||
    code === "MODEL_STRUCTURED_OUTPUT_EMPTY" ||
    code === "MODEL_STRUCTURED_OUTPUT_INVALID_JSON" ||
    code === "MODEL_STRUCTURED_OUTPUT_SCHEMA_MISMATCH"
  );
}

function errorCode(cause: unknown): string | null {
  return isRecord(cause) && typeof cause.code === "string" ? cause.code : null;
}

function isRetryable(cause: unknown): boolean {
  return isRecord(cause) && typeof cause.retryable === "boolean" ? cause.retryable : true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
