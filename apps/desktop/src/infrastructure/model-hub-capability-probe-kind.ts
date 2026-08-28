import { ModelCenterError } from "./model-center-store";
import type {
  ModelHubCapability,
  ModelProviderKind,
  NovelAiTask,
} from "./model-hub-provider-registry";
import { requiredCapabilitiesForNovelTask } from "./model-hub-router";
import type { ModelCapabilityEvidence } from "./model-hub-store";
import { SELECTABLE_MODEL_CATALOG_ENTRIES } from "./selectable-model-catalog-registry";

export type ModelHubCapabilityProbeKind = "text_generation" | "embedding";

export function recommendModelHubCapabilityProbeKind(
  input: Readonly<{
    providerKind: ModelProviderKind;
    modelId: string;
    capabilityEvidence: readonly Pick<
      ModelCapabilityEvidence,
      "capability" | "verdict" | "expiresAt"
    >[];
    requestedTask: NovelAiTask | null;
    now?: string;
  }>,
): ModelHubCapabilityProbeKind | null {
  const claims = new Set<ModelHubCapabilityProbeKind>();
  const now = input.now === undefined ? null : Date.parse(input.now);
  for (const evidence of input.capabilityEvidence) {
    if (
      evidence.verdict === "supported" &&
      isProbeKind(evidence.capability) &&
      (evidence.expiresAt === null || now === null || Date.parse(evidence.expiresAt) > now)
    ) {
      claims.add(evidence.capability);
    }
  }
  if (input.requestedTask !== null) {
    addProbeClaims(claims, requiredCapabilitiesForNovelTask(input.requestedTask));
  }
  const identity = normalizeIdentity(input.modelId);
  const official = SELECTABLE_MODEL_CATALOG_ENTRIES.find(
    (entry) =>
      entry.providerKind === input.providerKind &&
      entry.modelId !== null &&
      [entry.modelId, ...entry.aliases].some(
        (candidate) => normalizeIdentity(candidate) === identity,
      ),
  );
  if (official !== undefined) addProbeClaims(claims, official.capabilityCategories);
  return claims.size === 1 ? ([...claims][0] ?? null) : null;
}

export function requireModelHubCapabilityProbeKind(
  value: ModelHubCapabilityProbeKind | null | undefined,
): ModelHubCapabilityProbeKind {
  if (value === "text_generation" || value === "embedding") return value;
  throw new ModelCenterError(
    "MODEL_HUB_CAPABILITY_SELECTION_REQUIRED",
    "请先选择要检查文字生成还是语义向量能力。本次没有向模型服务发送内容。",
    false,
  );
}

function addProbeClaims(
  target: Set<ModelHubCapabilityProbeKind>,
  capabilities: readonly ModelHubCapability[],
): void {
  for (const capability of capabilities) {
    if (isProbeKind(capability)) target.add(capability);
  }
}

function isProbeKind(capability: ModelHubCapability): capability is ModelHubCapabilityProbeKind {
  return capability === "text_generation" || capability === "embedding";
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
