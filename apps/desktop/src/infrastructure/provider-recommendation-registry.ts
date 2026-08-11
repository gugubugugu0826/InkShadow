import type {
  ModelHubCapability,
  ModelProviderKind,
  NovelAiTask,
} from "./model-hub-provider-registry";

export const PROVIDER_RECOMMENDATION_REGISTRY_VERSION = "2026-08-10.v2";

export interface ProviderRecommendation {
  readonly task: NovelAiTask;
  readonly capability: ModelHubCapability;
  readonly providerKind: ModelProviderKind;
  readonly providerLabel: string;
  readonly modelFamilies: readonly string[];
  readonly evidenceUrl: string;
  readonly evidenceUpdatedAt: string;
  readonly evidenceExpiresAt: string;
  readonly registryVersion: string;
  /** A provider document is discovery guidance, never route capability evidence. */
  readonly status: "provider_documented_not_verified";
}

const REGISTRY: readonly ProviderRecommendation[] = Object.freeze([
  recommendation({
    task: "embedding",
    capability: "embedding",
    providerKind: "alibaba_qwen",
    providerLabel: "阿里云百炼",
    modelFamilies: ["text-embedding-v4"],
    evidenceUrl: "https://help.aliyun.com/en/model-studio/embedding",
  }),
  recommendation({
    task: "rerank",
    capability: "rerank",
    providerKind: "alibaba_qwen",
    providerLabel: "阿里云百炼",
    modelFamilies: ["qwen3-rerank"],
    evidenceUrl: "https://help.aliyun.com/en/model-studio/rerank",
  }),
  recommendation({
    task: "image_generation",
    capability: "image_generation",
    providerKind: "volcengine_doubao",
    providerLabel: "火山方舟 / 豆包",
    modelFamilies: ["Seedream 5.0 lite", "Seedream 4.5"],
    evidenceUrl: "https://www.volcengine.com/docs/82379/1829186",
  }),
]);

export function providerRecommendationsForTask(
  task: NovelAiTask,
  now: string,
): readonly ProviderRecommendation[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return Object.freeze([]);
  return Object.freeze(
    REGISTRY.filter((entry) => entry.task === task && Date.parse(entry.evidenceExpiresAt) > nowMs),
  );
}

function recommendation(
  input: Omit<
    ProviderRecommendation,
    "evidenceUpdatedAt" | "evidenceExpiresAt" | "registryVersion" | "status"
  >,
): ProviderRecommendation {
  return Object.freeze({
    ...input,
    modelFamilies: Object.freeze([...input.modelFamilies]),
    evidenceUpdatedAt: "2026-08-10T00:00:00.000Z",
    evidenceExpiresAt: "2026-09-10T00:00:00.000Z",
    registryVersion: PROVIDER_RECOMMENDATION_REGISTRY_VERSION,
    status: "provider_documented_not_verified",
  });
}
