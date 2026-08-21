import { ModelCenterError } from "./model-center-store";
import {
  modelProviderTextCapabilityProbePolicy,
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

export const MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION =
  "inkshadow.translation-probe.zh-en.v2";
export const MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS = 64;

export const MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_MESSAGES = Object.freeze([
  Object.freeze({
    role: "system" as const,
    content: "Translate the fixed Chinese sentence to English. Return the translation only.",
  }),
  Object.freeze({ role: "user" as const, content: "雨停了。" }),
]) satisfies readonly NativeModelMessage[];

export interface ModelHubTranslationCapabilityProbeResult {
  readonly evidenceVersion: typeof MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION;
  readonly streamed: boolean;
  readonly usage: NativeModelGenerationUsage | null;
  readonly visibleContentLength: number;
}

export interface AuditedModelHubTranslationCapabilityProbeResult extends ModelHubTranslationCapabilityProbeResult {
  readonly invocation: ModelInvocationFact;
}

export interface ExecuteAuditedModelHubTranslationCapabilityProbeInput {
  readonly gateway: Pick<
    NativeModelGatewayClient,
    "generate" | "supportsNativeInvocationDispatchLedger"
  >;
  readonly providerKind: ModelProviderKind;
  readonly generationId: string;
  readonly config: NativeModelEndpointConfig;
  readonly model: string;
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
  readonly assertBeforeProviderDispatch?: () => void | Promise<void>;
  readonly onProviderDispatchStarted?: (invocation: ModelInvocationFact) => void;
}

export async function executeAuditedModelHubTranslationCapabilityProbe(
  input: ExecuteAuditedModelHubTranslationCapabilityProbeInput,
): Promise<AuditedModelHubTranslationCapabilityProbeResult> {
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
      runModelHubTranslationCapabilityProbe({
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

/** Proves a fixed, content-free translation task; no project text or response is persisted. */
export async function runModelHubTranslationCapabilityProbe(input: {
  readonly gateway: Pick<
    NativeModelGatewayClient,
    "generate" | "supportsNativeInvocationDispatchLedger"
  >;
  readonly providerKind: ModelProviderKind;
  readonly generationId: string;
  readonly config: NativeModelEndpointConfig;
  readonly model: string;
  /** Revalidates the exact user-disclosed target immediately before dispatch. */
  readonly assertBeforeProviderDispatch?: () => Promise<void>;
  readonly invocationDispatchLedger?: NativeModelGenerationInput["invocationDispatchLedger"];
  readonly onInvocationDispatchAccepted?: NativeModelGenerationInput["onInvocationDispatchAccepted"];
}): Promise<ModelHubTranslationCapabilityProbeResult> {
  const policy = modelProviderTextCapabilityProbePolicy(input.providerKind);
  await input.assertBeforeProviderDispatch?.();
  const generated = await input.gateway.generate({
    dispatchScope: { kind: "non_project", reason: "connection_probe" },
    generationId: input.generationId,
    config: Object.freeze({ ...input.config, retryLimit: 0 }),
    model: input.model,
    messages: MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_MESSAGES,
    maxOutputTokens: MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
    ...(policy.reasoningMode === null ? {} : { reasoningMode: policy.reasoningMode }),
    ...(input.invocationDispatchLedger === undefined
      ? {}
      : { invocationDispatchLedger: input.invocationDispatchLedger }),
    ...(input.onInvocationDispatchAccepted === undefined
      ? {}
      : { onInvocationDispatchAccepted: input.onInvocationDispatchAccepted }),
  });
  if (!isAcceptedTranslation(generated.text)) {
    throw new ModelCenterError(
      "MODEL_TRANSLATION_PROBE_FAILED",
      "模型没有通过固定中英翻译验证；没有写入翻译能力证据或修改 AI 分工。",
      true,
    );
  }
  return Object.freeze({
    evidenceVersion: MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_VERSION,
    streamed: generated.streamed === true,
    usage: generated.usage,
    visibleContentLength: Array.from(generated.text).length,
  });
}

function isAcceptedTranslation(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/^["'“”]+|["'“”]+$/gu, "")
    .replace(/[.!]+$/u, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
  return (
    normalized === "the rain stopped" ||
    normalized === "the rain has stopped" ||
    normalized === "it stopped raining" ||
    normalized === "it has stopped raining"
  );
}
