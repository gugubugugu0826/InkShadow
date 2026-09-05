import type { Clock } from "@inkshadow/domain";

import {
  MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
  MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MESSAGES,
} from "./model-hub-structured-capability-probe";
import {
  MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS,
  MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_MESSAGES,
} from "./model-hub-translation-capability-probe";
import { modelHubFinalDispatchIdentity } from "./model-hub-final-dispatch-guard";
import { isLoopbackModelBaseUrl, type NovelAiTask } from "./model-hub-provider-registry";
import { buildModelHubRoutingVisibility } from "./model-hub-routing-visibility";
import type {
  ModelCatalogEntry,
  ModelCostPrivacyProfile,
  ModelHubStore,
  ModelProviderConnection,
} from "./model-hub-store";
import {
  recommendConnectedModelsForTask,
  type ModelHubTaskRecommendationReadiness,
} from "./model-hub-task-recommendation";
import {
  providerActionFingerprint,
  type ProviderActionDisclosure,
} from "./provider-action-disclosure";

export type ModelHubTaskCapabilityProbeReadiness = Exclude<
  ModelHubTaskRecommendationReadiness,
  "ready"
>;

export interface ModelHubTaskCapabilityProbeDisclosure extends ProviderActionDisclosure {
  readonly task: NovelAiTask;
  readonly readiness: ModelHubTaskCapabilityProbeReadiness;
  readonly maximumOutputTokens: number;
}

export interface PreparedModelHubTaskCapabilityProbe {
  readonly connection: ModelProviderConnection;
  readonly catalogEntry: ModelCatalogEntry;
  readonly costPrivacy: ModelCostPrivacyProfile | null;
  readonly disclosure: ModelHubTaskCapabilityProbeDisclosure;
}

type ProbeDisclosureStore = Pick<
  ModelHubStore,
  | "findConnection"
  | "listCatalog"
  | "findTaskRoute"
  | "listCapabilityEvidence"
  | "findCostPrivacyProfile"
  | "listRecentAiFailures"
>;

export class ModelHubTaskCapabilityProbeDisclosureError extends Error {
  public readonly retryable = true;

  public constructor(
    public readonly code:
      "MODEL_HUB_TASK_PROBE_CONFIRMATION_REQUIRED" | "MODEL_HUB_TASK_PROBE_DISCLOSURE_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "ModelHubTaskCapabilityProbeDisclosureError";
  }
}

export async function prepareModelHubTaskCapabilityProbeDisclosure(
  dependencies: Readonly<{
    modelHub: ProbeDisclosureStore;
    clock: Pick<Clock, "now">;
  }>,
  input: Readonly<{
    task: NovelAiTask;
    connectionId: string;
    catalogEntryId: string;
    readiness: ModelHubTaskCapabilityProbeReadiness;
  }>,
): Promise<PreparedModelHubTaskCapabilityProbe> {
  const [connection, catalog, route, capabilityEvidence, costPrivacy, recentAiFailures] =
    await Promise.all([
      dependencies.modelHub.findConnection(input.connectionId),
      dependencies.modelHub.listCatalog(input.connectionId),
      dependencies.modelHub.findTaskRoute(input.task),
      dependencies.modelHub.listCapabilityEvidence(input.catalogEntryId),
      dependencies.modelHub.findCostPrivacyProfile(input.catalogEntryId),
      dependencies.modelHub.listRecentAiFailures(25),
    ]);
  const catalogEntry = catalog.find(({ id }) => id === input.catalogEntryId) ?? null;
  if (connection === null || catalogEntry?.connectionId !== connection.id || route !== null) {
    throw disclosureChanged();
  }

  const visibility = buildModelHubRoutingVisibility({
    connections: Object.freeze([connection]),
    catalog: Object.freeze([catalogEntry]),
    routes: Object.freeze([]),
    capabilityEvidence,
    recentAiFailures,
    now: String(dependencies.clock.now()),
    validating: false,
    loadFailed: false,
    saveFailed: false,
  });
  const currentRecommendation = recommendConnectedModelsForTask(input.task, visibility.models).find(
    ({ model, readiness }) =>
      model.connection.id === connection.id &&
      model.catalogEntry.id === catalogEntry.id &&
      readiness === input.readiness,
  );
  if (currentRecommendation === undefined) throw disclosureChanged();

  const local = isLoopbackModelBaseUrl(connection.baseUrl);
  const dataDestination = local ? "local" : "remote";
  const messages =
    input.readiness === "verify_structured_output"
      ? MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MESSAGES
      : MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_MESSAGES;
  const maximumOutputTokens =
    input.readiness === "verify_structured_output"
      ? MODEL_HUB_STRUCTURED_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS
      : MODEL_HUB_TRANSLATION_CAPABILITY_PROBE_MAX_OUTPUT_TOKENS;
  const sends = Object.freeze([
    ...messages.map(
      ({ role, content }) => `${role === "system" ? "系统指令" : "固定用户句"}：${content}`,
    ),
    ...(connection.authenticationMode === "none"
      ? []
      : ["身份验证：使用当前连接凭据；凭据不会写入能力检查内容。"]),
  ]);
  const privacy = privacyDisclosure(local, connection.authenticationMode !== "none", costPrivacy);
  const authority = Object.freeze({
    schemaVersion: "inkshadow.model-hub-task-capability-probe-disclosure.v1",
    task: input.task,
    readiness: input.readiness,
    dispatchIdentity: modelHubFinalDispatchIdentity({
      connection,
      catalogEntry,
      ...(costPrivacy === null ? {} : { costPrivacy }),
    }),
    connectionDisplayName: connection.displayName,
    modelId: catalogEntry.providerModelId,
    dataDestination,
    privacy,
    costPrivacy,
    capabilityEvidence,
    recentProbeFailures: recentAiFailures.filter(
      ({ taskType, connectionId, modelId }) =>
        taskType === "capability_probe" &&
        connectionId === connection.id &&
        modelId === catalogEntry.providerModelId,
    ),
    sends,
    maximumOutputTokens,
    maximumProviderCalls: 1,
    automaticRetryCount: 0,
    estimatedMaximumCostMicros: null,
    currency: null,
  });
  const disclosure = Object.freeze({
    task: input.task,
    readiness: input.readiness,
    fingerprint: await providerActionFingerprint(authority),
    connectionDisplayName: connection.displayName,
    modelId: catalogEntry.providerModelId,
    dataDestination,
    privacy,
    sends,
    maximumOutputTokens,
    maximumProviderCalls: 1,
    automaticRetryCount: 0 as const,
    estimatedMaximumCostMicros: null,
    currency: null,
  });
  return Object.freeze({ connection, catalogEntry, costPrivacy, disclosure });
}

export async function assertConfirmedModelHubTaskCapabilityProbeDisclosure(
  dependencies: Readonly<{
    modelHub: ProbeDisclosureStore;
    clock: Pick<Clock, "now">;
  }>,
  input: Readonly<{
    task: NovelAiTask;
    connectionId: string;
    catalogEntryId: string;
    readiness: ModelHubTaskCapabilityProbeReadiness;
    humanConfirmed: boolean;
    disclosedFingerprint: string;
  }>,
): Promise<PreparedModelHubTaskCapabilityProbe> {
  if (!input.humanConfirmed || input.disclosedFingerprint.trim().length === 0) {
    throw new ModelHubTaskCapabilityProbeDisclosureError(
      "MODEL_HUB_TASK_PROBE_CONFIRMATION_REQUIRED",
      "进行模型能力检查前，需要先查看发送说明并明确确认。",
    );
  }
  const current = await prepareModelHubTaskCapabilityProbeDisclosure(dependencies, input);
  if (current.disclosure.fingerprint !== input.disclosedFingerprint) throw disclosureChanged();
  return current;
}

function privacyDisclosure(
  local: boolean,
  usesConnectionCredential: boolean,
  profile: ModelCostPrivacyProfile | null,
): string {
  const actualDestination = local ? "只在本机端点运行" : "发送到所选远程供应商";
  const recordedDestination =
    profile === null ? "尚未确认" : destinationLabel(profile.dataDestination);
  const retention = profile === null ? "尚未确认" : retentionLabel(profile.retentionPolicy);
  const training = profile === null ? "尚未确认" : trainingLabel(profile.trainingPolicy);
  const authentication = usesConnectionCredential
    ? "连接凭据仅用于请求鉴权，不进入消息正文"
    : "当前请求不使用连接凭据";
  return `请求${actualDestination}。供应商资料：数据去向 ${recordedDestination}；数据保留 ${retention}；训练使用 ${training}。固定消息不含作品正文、灵感、设定或项目资料；${authentication}。`;
}

function destinationLabel(value: ModelCostPrivacyProfile["dataDestination"]): string {
  if (value === "local") return "本机";
  if (value === "remote") return "远程";
  return "尚未确认";
}

function retentionLabel(value: ModelCostPrivacyProfile["retentionPolicy"]): string {
  if (value === "none") return "不保留";
  if (value === "temporary") return "临时保留";
  if (value === "provider_default") return "遵循供应商默认政策";
  return "尚未确认";
}

function trainingLabel(value: ModelCostPrivacyProfile["trainingPolicy"]): string {
  if (value === "not_used") return "不用于训练";
  if (value === "opt_out") return "已选择退出训练";
  if (value === "may_be_used") return "可能用于训练";
  if (value === "provider_default") return "遵循供应商默认政策";
  return "尚未确认";
}

function disclosureChanged(): ModelHubTaskCapabilityProbeDisclosureError {
  return new ModelHubTaskCapabilityProbeDisclosureError(
    "MODEL_HUB_TASK_PROBE_DISCLOSURE_CHANGED",
    "连接、模型、创作任务安排、费用或隐私设置已经变化；本次没有发送，请重新查看说明后确认。",
  );
}
