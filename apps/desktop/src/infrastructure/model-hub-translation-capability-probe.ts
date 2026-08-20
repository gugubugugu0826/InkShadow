import { ModelCenterError } from "./model-center-store";
import {
  modelProviderTextCapabilityProbePolicy,
  type ModelProviderKind,
} from "./model-hub-provider-registry";
import type {
  NativeModelEndpointConfig,
  NativeModelGatewayClient,
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
}

/** Proves a fixed, content-free translation task; no project text or response is persisted. */
export async function runModelHubTranslationCapabilityProbe(input: {
  readonly gateway: Pick<NativeModelGatewayClient, "generate">;
  readonly providerKind: ModelProviderKind;
  readonly generationId: string;
  readonly config: NativeModelEndpointConfig;
  readonly model: string;
  /** Revalidates the exact user-disclosed target immediately before dispatch. */
  readonly assertBeforeProviderDispatch?: () => Promise<void>;
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
