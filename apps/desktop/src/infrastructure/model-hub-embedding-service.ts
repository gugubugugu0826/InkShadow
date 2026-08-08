import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import {
  getModelProviderPreset,
  isLoopbackModelBaseUrl,
  type ModelHubAuthenticationMode,
} from "./model-hub-provider-registry";
import { ModelHubExecutionError } from "./model-hub-execution-service";
import {
  assertModelHubFinalDispatchUnchanged,
  ModelHubFinalDispatchError,
  modelHubFinalDispatchIdentity,
} from "./model-hub-final-dispatch-guard";
import {
  modelHubCredentialProviderId,
  modelHubNativeEndpointConfig,
} from "./model-hub-native-config";
import {
  requiredCapabilitiesForNovelTask,
  resolveModelCapabilityVerdict,
} from "./model-hub-router";
import type {
  ModelCapabilityEvidence,
  ModelCatalogEntry,
  ModelCostPrivacyProfile,
  ModelHubStore,
  ModelInvocationFact,
  ModelProviderConnection,
  NovelTaskRoute,
} from "./model-hub-store";
import type {
  NativeEmbeddingGatewayClient,
  NativeEmbeddingResult,
} from "./native-embedding-gateway";
import type { NativeGatewayProviderKind } from "./native-model-gateway-contract";
import type { NativeModelDispatchScope } from "./native-model-gateway-contract";

export interface InspectModelHubEmbeddingTaskInput {
  readonly inputs: readonly string[];
}

export interface ExecuteModelHubEmbeddingTaskInput extends InspectModelHubEmbeddingTaskInput {
  readonly dispatchScope: NativeModelDispatchScope;
  readonly onBeforeDispatch?: (
    selection: Readonly<{
      invocationId: string;
      connectionId: string;
      catalogEntryId: string;
      modelId: string;
      inputCount: number;
      estimatedInputTokens: number;
      usedFallback: boolean;
      localOnlyEligible: boolean;
      fingerprintMaterial: ModelHubEmbeddingTaskInspection["fingerprintMaterial"];
    }>,
  ) => void | Promise<void>;
}

export interface ModelHubEmbeddingTaskExecutionResult extends NativeEmbeddingResult {
  readonly invocation: ModelInvocationFact;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderConnection["providerKind"];
  readonly modelId: string;
  readonly usedFallback: boolean;
  readonly estimatedInputTokens: number;
  readonly estimatedCostMicros: string | null;
}

export interface ModelHubEmbeddingInspectionDependencies {
  readonly modelHub: ModelHubStore;
  readonly modelGateway: Pick<NativeEmbeddingGatewayClient, "available">;
  readonly credentials: Readonly<{
    getSummary(providerId: string): Promise<Readonly<{ configured: boolean }>>;
  }>;
  readonly clock: Clock;
}

export interface ModelHubEmbeddingExecutionDependencies extends ModelHubEmbeddingInspectionDependencies {
  readonly modelGateway: Pick<NativeEmbeddingGatewayClient, "available" | "embed">;
  readonly ids: Pick<UuidV7Generator, "next">;
}

export interface ModelHubEmbeddingTaskInspection {
  readonly task: "embedding";
  readonly routeRevision: number;
  readonly configuredPrimaryCatalogEntryId: string;
  readonly configuredFallbackCatalogEntryId: string | null;
  readonly selectionKind: "task_primary" | "task_fallback";
  readonly usedFallback: boolean;
  readonly attempt: 1 | 2;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderConnection["providerKind"];
  readonly providerProtocol: ModelProviderConnection["protocol"];
  readonly gatewayProvider: NativeGatewayProviderKind;
  readonly modelId: string;
  readonly dataDestination: "local" | "remote";
  readonly privacyPolicy: NovelTaskRoute["privacyPolicy"];
  readonly failurePolicy: NovelTaskRoute["failurePolicy"];
  readonly capability: Readonly<{
    required: readonly ["embedding"];
    verdict: "supported";
    evidence: readonly Readonly<{
      id: string;
      verdict: ModelCapabilityEvidence["verdict"];
      evidenceSource: ModelCapabilityEvidence["evidenceSource"];
      evidenceVersion: string;
      observedAt: string;
      expiresAt: string | null;
    }>[];
  }>;
  readonly privacy: Readonly<{
    dataDestination: ModelCostPrivacyProfile["dataDestination"];
    retentionPolicy: ModelCostPrivacyProfile["retentionPolicy"];
    trainingPolicy: ModelCostPrivacyProfile["trainingPolicy"];
    evidenceSource: ModelCostPrivacyProfile["evidenceSource"];
    evidenceVersion: string | null;
    evidenceUpdatedAt: string;
  }>;
  readonly fingerprintMaterial: Readonly<{
    version: "model-hub-embedding-v1";
    routeRevision: number;
    connectionId: string;
    connectionRevision: number;
    catalogEntryId: string;
    catalogRevision: number;
    providerKind: ModelProviderConnection["providerKind"];
    providerProtocol: ModelProviderConnection["protocol"];
    gatewayProvider: NativeGatewayProviderKind;
    authenticationMode: ModelHubAuthenticationMode;
    modelId: string;
    dataDestination: "local" | "remote";
    costPrivacyRevision: number;
    privacyEvidenceSource: ModelCostPrivacyProfile["evidenceSource"];
    privacyEvidenceVersion: string | null;
  }>;
  readonly input: Readonly<{
    inputCount: number;
    totalInputBytes: number;
    maximumBatchSize: number;
    maximumItemBytes: number;
    maximumTotalBytes: number;
    routeMaximumInputs: number | null;
    routeMaximumInputTokens: number | null;
    catalogInputTokenLimit: number | null;
    estimatedInputTokens: number;
    maximumEstimatedItemTokens: number;
  }>;
  readonly pricing: Readonly<{
    currency: string | null;
    inputMicrosPerMillionTokens: string | null;
    outputMicrosPerMillionTokens: string | null;
    cachedInputMicrosPerMillionTokens: string | null;
    pricingVersion: string | null;
    priceUpdatedAt: string | null;
    evidenceSource: ModelCostPrivacyProfile["evidenceSource"];
    evidenceVersion: string | null;
    evidenceUpdatedAt: string;
    estimatedCostMicros: string | null;
    maximumCostMicros: string | null;
    maximumCostCurrency: string | null;
  }>;
}

interface ResolvedEmbeddingTarget {
  readonly connection: ModelProviderConnection;
  readonly catalogEntry: ModelCatalogEntry;
  readonly costPrivacy: ModelCostPrivacyProfile;
  readonly dataDestination: "local" | "remote";
  readonly estimatedInputTokens: number;
  readonly estimatedCostMicros: string | null;
  readonly costCurrency: string | null;
  readonly capabilityEvidence: readonly ModelCapabilityEvidence[];
  readonly routeMaximumInputs: number | null;
  readonly routeMaximumInputTokens: number | null;
}

interface EmbeddingInputAccounting {
  readonly itemByteLengths: readonly number[];
  readonly itemTokenEstimates: readonly number[];
  readonly totalBytes: number;
  readonly totalEstimatedTokens: number;
}

interface ResolvedEmbeddingPlan {
  readonly route: NovelTaskRoute;
  readonly target: ResolvedEmbeddingTarget;
  readonly usedFallback: boolean;
  readonly inspection: ModelHubEmbeddingTaskInspection;
}

const EMBEDDING_TASK = "embedding" as const;
const MAXIMUM_EMBEDDING_BATCH = 64;
const MAXIMUM_EMBEDDING_ITEM_BYTES = 64 * 1_024;
const MAXIMUM_EMBEDDING_INPUT_BYTES = 512 * 1_024;
const MAXIMUM_ESTIMATED_INPUT_TOKENS = 1_000_000_000;
const EMBEDDING_ITEM_TOKEN_ALLOWANCE = 64;
const EMBEDDING_REQUEST_TOKEN_ALLOWANCE = 1_024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Resolves the exact embedding route without starting the invocation ledger or
 * sending source text to a provider. The result contains only non-secret
 * routing, evidence, limit, pricing and configuration-fingerprint metadata.
 */
export async function inspectModelHubEmbeddingTask(
  dependencies: ModelHubEmbeddingInspectionDependencies,
  input: InspectModelHubEmbeddingTaskInput,
): Promise<ModelHubEmbeddingTaskInspection> {
  return (await resolveEmbeddingPlan(dependencies, input)).inspection;
}

/**
 * Executes the exact Model Hub `embedding` route through the native gateway.
 *
 * The gateway contract does not expose provider token usage, so this service
 * uses a deliberately conservative, locally calculated input-token estimate
 * for both the hard pre-dispatch cost check and invocation accounting. Raw
 * inputs and returned vectors are never passed to the invocation ledger.
 */
export async function executeModelHubEmbeddingTask(
  dependencies: ModelHubEmbeddingExecutionDependencies,
  input: ExecuteModelHubEmbeddingTaskInput,
): Promise<ModelHubEmbeddingTaskExecutionResult> {
  const { route, target, usedFallback, inspection } = await resolveEmbeddingPlan(
    dependencies,
    input,
  );
  const expectedDispatchIdentity = modelHubFinalDispatchIdentity({
    route,
    connection: target.connection,
    catalogEntry: target.catalogEntry,
    costPrivacy: target.costPrivacy,
  });

  let invocation = await dependencies.modelHub.startInvocation({
    id: dependencies.ids.next(),
    task: EMBEDDING_TASK,
    routeTask: EMBEDDING_TASK,
    connectionId: target.connection.id,
    catalogEntryId: target.catalogEntry.id,
    providerKindSnapshot: target.connection.providerKind,
    modelIdSnapshot: target.catalogEntry.providerModelId,
    routeReason: usedFallback ? "task_fallback" : "task_primary",
    attempt: usedFallback ? 2 : 1,
    privacyPolicy: route.privacyPolicy,
    dataDestination: target.dataDestination,
    maximumCostMicros: route.maximumCostMicros,
    currency: route.currency,
  });

  let dispatched = false;
  let embedded: NativeEmbeddingResult;
  try {
    await input.onBeforeDispatch?.({
      invocationId: invocation.id,
      connectionId: target.connection.id,
      catalogEntryId: target.catalogEntry.id,
      modelId: target.catalogEntry.providerModelId,
      inputCount: input.inputs.length,
      estimatedInputTokens: target.estimatedInputTokens,
      usedFallback,
      localOnlyEligible:
        target.dataDestination === "local" &&
        target.costPrivacy.evidenceSource !== "unknown" &&
        isLoopbackModelBaseUrl(target.connection.baseUrl),
      fingerprintMaterial: inspection.fingerprintMaterial,
    });
    const current = await resolveEmbeddingPlan(dependencies, input);
    assertModelHubFinalDispatchUnchanged(
      expectedDispatchIdentity,
      modelHubFinalDispatchIdentity({
        route: current.route,
        connection: current.target.connection,
        catalogEntry: current.target.catalogEntry,
        costPrivacy: current.target.costPrivacy,
      }),
    );
    dispatched = true;
    embedded = await dependencies.modelGateway.embed({
      config: modelHubNativeEndpointConfig(current.target.connection),
      model: current.target.catalogEntry.providerModelId,
      inputs: input.inputs,
      dispatchScope: input.dispatchScope,
    });
  } catch (cause: unknown) {
    const normalized = dispatched
      ? normalizeDispatchedError(cause)
      : normalizePreDispatchError(cause);
    await dependencies.modelHub
      .finishInvocation({
        id: invocation.id,
        status: "failed",
        errorCode: normalized.code,
        errorSummary: dispatched
          ? "Embedding provider request failed; source text and stored vectors were not changed."
          : "Embedding request was blocked before provider dispatch.",
        expectedRevision: invocation.revision,
      })
      .catch(() => undefined);
    throw normalized;
  }

  try {
    invocation = await dependencies.modelHub.finishInvocation({
      id: invocation.id,
      status: "succeeded",
      inputTokens: target.estimatedInputTokens,
      outputTokens: 0,
      cachedInputTokens: null,
      estimatedCostMicros: target.estimatedCostMicros,
      currency: target.costCurrency,
      expectedRevision: invocation.revision,
    });
  } catch {
    throw new ModelHubExecutionError(
      "MODEL_HUB_INVOCATION_LEDGER_FAILED",
      "Embedding 已执行，但调用记录未能完成。为避免重复费用，本次不会自动重试。",
      true,
      true,
    );
  }

  return Object.freeze({
    ...embedded,
    invocation,
    connectionId: target.connection.id,
    catalogEntryId: target.catalogEntry.id,
    providerKind: target.connection.providerKind,
    modelId: target.catalogEntry.providerModelId,
    usedFallback,
    estimatedInputTokens: target.estimatedInputTokens,
    estimatedCostMicros: target.estimatedCostMicros,
  });
}

async function resolveEmbeddingPlan(
  dependencies: ModelHubEmbeddingInspectionDependencies,
  input: InspectModelHubEmbeddingTaskInput,
): Promise<ResolvedEmbeddingPlan> {
  const inputAccounting = validateAndEstimateInputs(input.inputs);
  if (!dependencies.modelGateway.available) {
    throw executionError(
      "MODEL_HUB_GATEWAY_UNAVAILABLE",
      "当前环境不能调用已连接的模型。请使用桌面版，或稍后重试。",
    );
  }

  const route = await dependencies.modelHub.findTaskRoute(EMBEDDING_TASK);
  if (!route?.enabled) {
    throw executionError(
      "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      "语义记忆尚未配置可用的模型。请在 AI 分工中选择支持 Embedding 的模型。",
    );
  }

  const now = dependencies.clock.now();
  let target: ResolvedEmbeddingTarget;
  let usedFallback = false;
  try {
    target = await resolveEmbeddingTarget(
      dependencies,
      route,
      route.primaryCatalogEntryId,
      inputAccounting,
      now,
    );
  } catch (cause: unknown) {
    if (route.failurePolicy !== "use_fallback" || route.fallbackCatalogEntryId === null) {
      throw normalizePreDispatchError(cause);
    }
    try {
      target = await resolveEmbeddingTarget(
        dependencies,
        route,
        route.fallbackCatalogEntryId,
        inputAccounting,
        now,
      );
      usedFallback = true;
    } catch {
      throw executionError(
        "MODEL_HUB_PRIMARY_AND_FALLBACK_UNAVAILABLE",
        "主模型和备用模型当前都不能安全执行语义记忆任务。请同步模型并检查能力、隐私和费用设置。",
        true,
      );
    }
  }

  const gatewayProvider = gatewayProviderKind(target.connection);
  const authenticationMode = target.connection.authenticationMode;
  const inspection: ModelHubEmbeddingTaskInspection = Object.freeze({
    task: EMBEDDING_TASK,
    routeRevision: route.revision,
    configuredPrimaryCatalogEntryId: route.primaryCatalogEntryId,
    configuredFallbackCatalogEntryId: route.fallbackCatalogEntryId,
    selectionKind: usedFallback ? "task_fallback" : "task_primary",
    usedFallback,
    attempt: usedFallback ? 2 : 1,
    connectionId: target.connection.id,
    catalogEntryId: target.catalogEntry.id,
    providerKind: target.connection.providerKind,
    providerProtocol: target.connection.protocol,
    gatewayProvider,
    modelId: target.catalogEntry.providerModelId,
    dataDestination: target.dataDestination,
    privacyPolicy: route.privacyPolicy,
    failurePolicy: route.failurePolicy,
    capability: Object.freeze({
      required: Object.freeze([EMBEDDING_TASK] as const),
      verdict: "supported",
      evidence: Object.freeze(
        target.capabilityEvidence
          .filter(
            ({ capability, expiresAt }) =>
              capability === EMBEDDING_TASK && (expiresAt === null || expiresAt > now),
          )
          .map(({ id, verdict, evidenceSource, evidenceVersion, observedAt, expiresAt }) =>
            Object.freeze({ id, verdict, evidenceSource, evidenceVersion, observedAt, expiresAt }),
          ),
      ),
    }),
    privacy: Object.freeze({
      dataDestination: target.costPrivacy.dataDestination,
      retentionPolicy: target.costPrivacy.retentionPolicy,
      trainingPolicy: target.costPrivacy.trainingPolicy,
      evidenceSource: target.costPrivacy.evidenceSource,
      evidenceVersion: target.costPrivacy.evidenceVersion,
      evidenceUpdatedAt: target.costPrivacy.evidenceUpdatedAt,
    }),
    fingerprintMaterial: Object.freeze({
      version: "model-hub-embedding-v1",
      routeRevision: route.revision,
      connectionId: target.connection.id,
      connectionRevision: target.connection.revision,
      catalogEntryId: target.catalogEntry.id,
      catalogRevision: target.catalogEntry.revision,
      providerKind: target.connection.providerKind,
      providerProtocol: target.connection.protocol,
      gatewayProvider,
      authenticationMode,
      modelId: target.catalogEntry.providerModelId,
      dataDestination: target.dataDestination,
      costPrivacyRevision: target.costPrivacy.revision,
      privacyEvidenceSource: target.costPrivacy.evidenceSource,
      privacyEvidenceVersion: target.costPrivacy.evidenceVersion,
    }),
    input: Object.freeze({
      inputCount: inputAccounting.itemByteLengths.length,
      totalInputBytes: inputAccounting.totalBytes,
      maximumBatchSize: MAXIMUM_EMBEDDING_BATCH,
      maximumItemBytes: MAXIMUM_EMBEDDING_ITEM_BYTES,
      maximumTotalBytes: MAXIMUM_EMBEDDING_INPUT_BYTES,
      routeMaximumInputs: target.routeMaximumInputs,
      routeMaximumInputTokens: target.routeMaximumInputTokens,
      catalogInputTokenLimit: target.catalogEntry.inputTokenLimit,
      estimatedInputTokens: target.estimatedInputTokens,
      maximumEstimatedItemTokens: Math.max(...inputAccounting.itemTokenEstimates),
    }),
    pricing: Object.freeze({
      currency: target.costPrivacy.currency,
      inputMicrosPerMillionTokens: target.costPrivacy.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens: target.costPrivacy.outputMicrosPerMillionTokens,
      cachedInputMicrosPerMillionTokens: target.costPrivacy.cachedInputMicrosPerMillionTokens,
      pricingVersion: target.costPrivacy.pricingVersion,
      priceUpdatedAt: target.costPrivacy.priceUpdatedAt,
      evidenceSource: target.costPrivacy.evidenceSource,
      evidenceVersion: target.costPrivacy.evidenceVersion,
      evidenceUpdatedAt: target.costPrivacy.evidenceUpdatedAt,
      estimatedCostMicros: target.estimatedCostMicros,
      maximumCostMicros: route.maximumCostMicros,
      maximumCostCurrency: route.currency,
    }),
  });
  return Object.freeze({ route, target, usedFallback, inspection });
}

async function resolveEmbeddingTarget(
  dependencies: ModelHubEmbeddingInspectionDependencies,
  route: NovelTaskRoute,
  catalogEntryId: string,
  inputAccounting: EmbeddingInputAccounting,
  now: string,
): Promise<ResolvedEmbeddingTarget> {
  const connections = await dependencies.modelHub.listConnections();
  let catalogEntry: ModelCatalogEntry | null = null;
  let connection: ModelProviderConnection | null = null;
  for (const candidateConnection of connections) {
    const candidate = (await dependencies.modelHub.listCatalog(candidateConnection.id)).find(
      ({ id }) => id === catalogEntryId,
    );
    if (candidate !== undefined) {
      catalogEntry = candidate;
      connection = candidateConnection;
      break;
    }
  }
  if (connection === null || catalogEntry?.connectionId !== connection.id) {
    throw executionError(
      "MODEL_HUB_ROUTE_TARGET_MISSING",
      "语义记忆任务引用的模型已不存在。请重新同步模型并更新 AI 分工。",
      true,
    );
  }
  if (
    !connection.enabled ||
    (connection.connectionStatus !== "ready" && connection.connectionStatus !== "degraded")
  ) {
    throw executionError(
      "MODEL_HUB_CONNECTION_NOT_READY",
      "所选供应商连接当前不可用。请先测试连接。",
      true,
    );
  }
  if (
    catalogEntry.availability !== "available" ||
    catalogEntry.lifecycle === "deprecated" ||
    (catalogEntry.staleAfter !== null && catalogEntry.staleAfter <= now)
  ) {
    throw executionError(
      "MODEL_HUB_CATALOG_ENTRY_UNAVAILABLE",
      "所选 Embedding 模型已不可用、已弃用或目录信息已过期。请重新同步模型。",
      true,
    );
  }

  const evidence = await dependencies.modelHub.listCapabilityEvidence(catalogEntry.id);
  const missingCapability = requiredCapabilitiesForNovelTask(EMBEDDING_TASK).find(
    (capability) =>
      resolveModelCapabilityVerdict({
        catalogEntryId: catalogEntry.id,
        capability,
        evidence,
        now,
      }) !== "supported",
  );
  if (missingCapability !== undefined) {
    throw executionError(
      "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      "所选模型还没有足够证据证明支持 Embedding。请验证能力或选择其他模型。",
      true,
    );
  }
  if (getModelProviderPreset(connection.providerKind).protocol === "anthropic") {
    throw executionError(
      "MODEL_HUB_EMBEDDING_PROTOCOL_UNSUPPORTED",
      "当前原生网关不能通过 Anthropic 协议执行 Embedding。请选择其他已验证模型。",
    );
  }

  const preset = getModelProviderPreset(connection.providerKind);
  if (preset.credentialRequired || connection.credentialState === "present") {
    const summary = await dependencies.credentials
      .getSummary(modelHubCredentialProviderId(connection))
      .catch(() => ({
        configured: false,
      }));
    if (!summary.configured) {
      throw executionError(
        "MODEL_HUB_CREDENTIAL_MISSING",
        "所选供应商缺少可用凭据。请在设置中重新保存 API Key。",
        true,
      );
    }
  }

  const costPrivacy = await dependencies.modelHub.findCostPrivacyProfile(catalogEntry.id);
  if (costPrivacy === null || costPrivacy.dataDestination === "unknown") {
    throw executionError(
      "MODEL_HUB_DATA_DESTINATION_UNKNOWN",
      "所选模型的数据去向尚未确认。请确认隐私信息后再使用。",
    );
  }
  const dataDestination = costPrivacy.dataDestination;
  if (
    route.privacyPolicy === "local_only" &&
    (dataDestination !== "local" ||
      costPrivacy.evidenceSource === "unknown" ||
      !isLoopbackModelBaseUrl(connection.baseUrl))
  ) {
    throw executionError(
      "MODEL_HUB_PRIVACY_BLOCKED",
      "这项任务仅允许本机处理，InkShadow 不会把正文发送到云端模型。",
    );
  }

  const routeMaximumInputs = optionalPositivePolicyInteger(
    route.parameterPolicy.maximumInputs,
    MAXIMUM_EMBEDDING_BATCH,
  );
  if (
    routeMaximumInputs !== null &&
    inputAccounting.itemTokenEstimates.length > routeMaximumInputs
  ) {
    throw executionError(
      "MODEL_HUB_INPUT_LIMIT_EXCEEDED",
      "本次 Embedding 输入数量超过任务设置的上限。请缩小批次后重试。",
    );
  }
  const routeMaximumInputTokens = optionalPositivePolicyInteger(
    route.parameterPolicy.maximumInputTokens,
    MAXIMUM_ESTIMATED_INPUT_TOKENS,
  );
  if (
    routeMaximumInputTokens !== null &&
    inputAccounting.totalEstimatedTokens > routeMaximumInputTokens
  ) {
    throw executionError(
      "MODEL_HUB_INPUT_LIMIT_EXCEEDED",
      "本次 Embedding 内容超过任务设置的 Token 上限。请缩短内容或拆分批次。",
    );
  }
  const catalogInputTokenLimit = catalogEntry.inputTokenLimit;
  if (
    catalogInputTokenLimit !== null &&
    inputAccounting.itemTokenEstimates.some(
      (estimatedTokens) => estimatedTokens > catalogInputTokenLimit,
    )
  ) {
    throw executionError(
      "MODEL_HUB_CONTEXT_LIMIT_EXCEEDED",
      "至少一项内容超过所选 Embedding 模型的输入上限。请拆分内容或切换模型。",
    );
  }

  const estimatedCostMicros = calculateEmbeddingCost(
    costPrivacy,
    inputAccounting.totalEstimatedTokens,
  );
  if (route.maximumCostMicros !== null) {
    if (
      route.currency === null ||
      costPrivacy.currency === null ||
      route.currency !== costPrivacy.currency ||
      estimatedCostMicros === null
    ) {
      throw executionError(
        "MODEL_HUB_COST_CEILING_UNVERIFIABLE",
        "当前价格证据不足，无法保证语义记忆任务不超过费用上限。请更新计价信息。",
      );
    }
    if (BigInt(estimatedCostMicros) > BigInt(route.maximumCostMicros)) {
      throw executionError(
        "MODEL_HUB_COST_CEILING_EXCEEDED",
        "预计最高费用超过语义记忆任务的上限，请缩小批次或更换模型。",
      );
    }
  }

  return Object.freeze({
    connection,
    catalogEntry,
    costPrivacy,
    dataDestination,
    estimatedInputTokens: inputAccounting.totalEstimatedTokens,
    estimatedCostMicros,
    costCurrency: estimatedCostMicros === null ? null : costPrivacy.currency,
    capabilityEvidence: Object.freeze([...evidence]),
    routeMaximumInputs,
    routeMaximumInputTokens,
  });
}

function validateAndEstimateInputs(inputs: readonly string[]): EmbeddingInputAccounting {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAXIMUM_EMBEDDING_BATCH) {
    throw executionError(
      "MODEL_HUB_REQUEST_INVALID",
      "Embedding 输入数量无效。请至少提供一项内容，并缩小过大的批次。",
    );
  }
  const encoder = new TextEncoder();
  const itemByteLengths: number[] = [];
  const itemTokenEstimates: number[] = [];
  let totalBytes = 0;
  let totalEstimatedTokens = EMBEDDING_REQUEST_TOKEN_ALLOWANCE;
  for (const value of inputs) {
    if (typeof value !== "string" || value.length < 1 || CONTROL_CHARACTER_PATTERN.test(value)) {
      throw executionError(
        "MODEL_HUB_REQUEST_INVALID",
        "Embedding 输入包含空内容或不支持的控制字符。",
      );
    }
    const bytes = encoder.encode(value).length;
    if (bytes > MAXIMUM_EMBEDDING_ITEM_BYTES) {
      throw executionError("MODEL_HUB_REQUEST_INVALID", "单项 Embedding 内容过长。请先拆分内容。");
    }
    totalBytes += bytes;
    if (totalBytes > MAXIMUM_EMBEDDING_INPUT_BYTES) {
      throw executionError(
        "MODEL_HUB_REQUEST_INVALID",
        "Embedding 批次内容过长。请缩小批次后重试。",
      );
    }
    itemByteLengths.push(bytes);
    const estimatedTokens = Math.max(1, bytes + EMBEDDING_ITEM_TOKEN_ALLOWANCE);
    itemTokenEstimates.push(estimatedTokens);
    totalEstimatedTokens += estimatedTokens;
  }
  return Object.freeze({
    itemByteLengths: Object.freeze(itemByteLengths),
    itemTokenEstimates: Object.freeze(itemTokenEstimates),
    totalBytes,
    totalEstimatedTokens,
  });
}

function optionalPositivePolicyInteger(value: unknown, maximum: number): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw executionError(
      "MODEL_HUB_PARAMETER_POLICY_INVALID",
      "语义记忆任务保存的输入限制无效。请重新保存 AI 分工。",
    );
  }
  return value as number;
}

function calculateEmbeddingCost(
  profile: ModelCostPrivacyProfile,
  inputTokens: number,
): string | null {
  if (profile.currency === null || profile.inputMicrosPerMillionTokens === null) {
    return null;
  }
  const numerator = BigInt(inputTokens) * BigInt(profile.inputMicrosPerMillionTokens);
  return ((numerator + 999_999n) / 1_000_000n).toString();
}

function gatewayProviderKind(connection: ModelProviderConnection): NativeGatewayProviderKind {
  const protocol = getModelProviderPreset(connection.providerKind).protocol;
  return protocol === "openai_compatible" ? "open_ai_compatible" : protocol;
}

function normalizePreDispatchError(cause: unknown): ModelHubExecutionError {
  return cause instanceof ModelHubExecutionError
    ? cause
    : cause instanceof ModelHubFinalDispatchError
      ? executionError(cause.code, cause.message, cause.retryable)
      : executionError(
          "MODEL_HUB_PREFLIGHT_FAILED",
          "Embedding 调用前检查没有通过。请检查 AI 分工、模型能力、隐私和费用设置。",
          true,
        );
}

function normalizeDispatchedError(cause: unknown): ModelHubExecutionError {
  if (cause instanceof ModelHubExecutionError) {
    return new ModelHubExecutionError(cause.code, cause.message, cause.retryable, true);
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
  ) {
    return new ModelHubExecutionError(
      cause.code,
      "Embedding 模型调用失败。正文和已保存向量都没有改变，请检查连接后重试。",
      "retryable" in cause && cause.retryable === true,
      true,
    );
  }
  return new ModelHubExecutionError(
    "MODEL_HUB_EMBEDDING_FAILED",
    "Embedding 模型调用失败。正文和已保存向量都没有改变，请检查连接后重试。",
    true,
    true,
  );
}

function executionError(code: string, message: string, retryable = false): ModelHubExecutionError {
  return new ModelHubExecutionError(code, message, retryable, false);
}
