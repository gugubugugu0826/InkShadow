import type { ModelHubCapability, NovelAiTask } from "./model-hub-provider-registry";
import {
  preferredCapabilitiesForNovelTask,
  requiredCapabilitiesForNovelTask,
} from "./model-hub-router";
import type {
  ModelHubCapabilityDisplayState,
  ModelHubModelProjection,
} from "./model-hub-routing-visibility";

export type ModelHubTaskRecommendationReadiness =
  "ready" | "verify_structured_output" | "verify_translation";

export interface ModelHubTaskRecommendation {
  readonly task: NovelAiTask;
  readonly model: ModelHubModelProjection;
  readonly readiness: ModelHubTaskRecommendationReadiness;
  readonly missingVerificationCapabilities: readonly ModelHubCapability[];
  readonly reason: string;
}

const SUPPORTED_STATES = new Set<ModelHubCapabilityDisplayState>(["verified", "user_confirmed"]);

/**
 * Ranks only models already present in the connected catalog. Unknown
 * embedding/rerank/image/vision abilities are never inferred from a model
 * name. Structured output is the sole probeable unknown because InkShadow has
 * a content-free, strict-schema OpenAI-compatible probe for it.
 */
export function recommendConnectedModelsForTask(
  task: NovelAiTask,
  models: readonly ModelHubModelProjection[],
): readonly ModelHubTaskRecommendation[] {
  const required = requiredCapabilitiesForNovelTask(task);
  const preferred = preferredCapabilitiesForNovelTask(task);
  return models
    .flatMap((model): readonly ModelHubTaskRecommendation[] => {
      if (
        !model.connectionUsable ||
        model.catalogEntry.availability !== "available" ||
        model.catalogEntry.lifecycle === "deprecated"
      ) {
        return [];
      }
      const missing = required.filter((capability) => !supports(model, capability));
      if (missing.length === 0) {
        return [
          Object.freeze({
            task,
            model,
            readiness: "ready" as const,
            missingVerificationCapabilities: Object.freeze([]),
            reason: "这台已连接模型具备本任务所需的有效能力证据。",
          }),
        ];
      }
      const canProbeStructuredOutput =
        missing.length === 1 &&
        missing[0] === "structured_output" &&
        model.connection.protocol === "openai_compatible" &&
        supports(model, "text_generation") &&
        (capabilityState(model, "structured_output") === "unknown" ||
          capabilityState(model, "structured_output") === "catalog_declared");
      if (canProbeStructuredOutput) {
        return [
          Object.freeze({
            task,
            model,
            readiness: "verify_structured_output" as const,
            missingVerificationCapabilities: Object.freeze(["structured_output"] as const),
            reason: "这台已连接模型已验证文字生成；还需通过一次不含作品内容的 JSON 探针。",
          }),
        ];
      }
      const canProbeTranslation =
        missing.length === 1 &&
        missing[0] === "translation" &&
        supports(model, "text_generation") &&
        (capabilityState(model, "translation") === "unknown" ||
          capabilityState(model, "translation") === "catalog_declared");
      if (canProbeTranslation) {
        return [
          Object.freeze({
            task,
            model,
            readiness: "verify_translation" as const,
            missingVerificationCapabilities: Object.freeze(["translation"] as const),
            reason: "这台已连接模型已验证文字生成；还需通过一次不含作品内容的固定中英翻译探针。",
          }),
        ];
      }
      return [];
    })
    .sort(
      (left, right) =>
        readinessScore(right.readiness) - readinessScore(left.readiness) ||
        requiredEvidenceScore(right.model, required) -
          requiredEvidenceScore(left.model, required) ||
        preferred.filter((capability) => supports(right.model, capability)).length -
          preferred.filter((capability) => supports(left.model, capability)).length ||
        connectionScore(right.model) - connectionScore(left.model) ||
        (right.model.lastVerifiedAt ?? "").localeCompare(left.model.lastVerifiedAt ?? "") ||
        left.model.catalogEntry.id.localeCompare(right.model.catalogEntry.id),
    );
}

function capabilityState(
  model: ModelHubModelProjection,
  capability: ModelHubCapability,
): ModelHubCapabilityDisplayState {
  return (
    model.capabilities.find((candidate) => candidate.capability === capability)?.state ?? "unknown"
  );
}

function supports(model: ModelHubModelProjection, capability: ModelHubCapability): boolean {
  return SUPPORTED_STATES.has(capabilityState(model, capability));
}

function readinessScore(readiness: ModelHubTaskRecommendationReadiness): number {
  return readiness === "ready" ? 2 : 1;
}

function requiredEvidenceScore(
  model: ModelHubModelProjection,
  required: readonly ModelHubCapability[],
): number {
  return required.reduce(
    (score, capability) => score + evidenceScore(capabilityState(model, capability)),
    0,
  );
}

function evidenceScore(state: ModelHubCapabilityDisplayState): number {
  if (state === "verified") return 4;
  if (state === "user_confirmed") return 3;
  if (state === "catalog_declared") return 2;
  return 0;
}

function connectionScore(model: ModelHubModelProjection): number {
  return model.connection.connectionStatus === "ready" ? 2 : 1;
}
