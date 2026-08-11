import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import {
  getModelProviderPreset,
  isLoopbackModelBaseUrl,
  modelProviderOfficialMetadataFallback,
  modelProviderTextCapabilityProbePolicy,
  modelProviderVisibleProsePolicy,
  type NovelAiTask,
} from "./model-hub-provider-registry";
import {
  modelHubCredentialProviderId,
  modelHubNativeEndpointConfig,
} from "./model-hub-native-config";
import {
  assertModelHubFinalDispatchUnchanged,
  ModelHubFinalDispatchError,
  modelHubFinalDispatchIdentity,
} from "./model-hub-final-dispatch-guard";
import {
  requiredCapabilitiesForNovelTask,
  resolveModelCapabilityVerdict,
} from "./model-hub-router";
import type {
  ModelCatalogEntry,
  ModelCostPrivacyProfile,
  ModelHubStore,
  ModelInvocationFact,
  ModelProviderConnection,
  NovelTaskRoute,
  ModelFailureStage,
  SafeAiFailureMetadata,
} from "./model-hub-store";
import type {
  NativeModelGatewayClient,
  NativeModelGenerationResult,
  NativeModelMessage,
} from "./runtime";
import type { NativeModelDispatchScope } from "./native-model-gateway-contract";
import { UiActionError } from "./ui-error";

export interface InspectModelHubTextTaskInput {
  readonly task: NovelAiTask;
  readonly messages: readonly NativeModelMessage[];
  readonly maximumOutputTokens: number;
  readonly temperature?: number;
  /** Narrow degradation used by rebuildable summaries; formal extraction keeps task defaults. */
  readonly capabilityPolicy?: "task_default" | "text_generation_only";
  /** Fail closed before dispatch when chapter content must stay on this device. */
  readonly requiredDataDestination?: "local";
}

export interface ExecuteModelHubTextTaskInput extends InspectModelHubTextTaskInput {
  readonly dispatchScope: NativeModelDispatchScope;
  readonly generationId?: string;
  /** Applies a narrow provider-aware reasoning policy at the named task boundary. */
  readonly reasoningPolicy?: "capability_probe" | "visible_prose";
  /** A one-shot recovery override after a reasoning-only truncation. */
  readonly reasoningModeOverride?: "disabled";
  /** Request provider JSON mode only after structured output has evidence. */
  readonly responseFormat?: "json_object";
  readonly onBeforeDispatch?: (
    selection: Readonly<{
      generationId: string;
      invocationId: string;
      connectionId: string;
      catalogEntryId: string;
      modelId: string;
      usedFallback: boolean;
      /** True only for an evidence-backed local model on a loopback endpoint. */
      localOnlyEligible?: boolean;
    }>,
  ) => void | Promise<void>;
  /**
   * Final synchronous cancellation/authorization latch. It runs after every
   * async pre-dispatch check and immediately before the gateway call, so a
   * cancellation raised while onBeforeDispatch is awaiting cannot be lost.
   */
  readonly assertBeforeProviderDispatch?: () => void;
  readonly onDelta?: (accumulatedText: string) => void;
}

export interface ModelHubTextTaskExecutionResult {
  readonly text: string;
  readonly usage: NativeModelGenerationResult["usage"];
  readonly invocation: ModelInvocationFact;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderConnection["providerKind"];
  readonly modelId: string;
  readonly usedFallback: boolean;
  readonly costCeilingExceededAfterDispatch: boolean;
}

export interface ModelHubTextInspectionDependencies {
  readonly modelHub: ModelHubStore;
  readonly modelGateway: Pick<NativeModelGatewayClient, "available">;
  readonly credentials: Readonly<{
    getSummary(providerId: string): Promise<Readonly<{ configured: boolean }>>;
  }>;
  readonly clock: Clock;
}

export interface ModelHubTextExecutionDependencies extends ModelHubTextInspectionDependencies {
  readonly modelGateway: Pick<NativeModelGatewayClient, "available" | "generate">;
  readonly ids: Pick<UuidV7Generator, "next">;
}

export interface ModelHubTextTaskInspection {
  readonly task: ModelHubTextTask;
  readonly configuredPrimaryCatalogEntryId: string;
  readonly configuredFallbackCatalogEntryId: string | null;
  readonly selectionKind: "task_primary" | "task_fallback";
  readonly usedFallback: boolean;
  readonly attempt: 1 | 2;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderConnection["providerKind"];
  readonly modelId: string;
  readonly dataDestination: "local" | "remote";
  readonly privacyPolicy: NovelTaskRoute["privacyPolicy"];
  readonly failurePolicy: NovelTaskRoute["failurePolicy"];
  readonly maximumOutputTokens: number;
  readonly temperature: number | undefined;
  readonly estimatedInputTokens: number;
  readonly estimatedTotalTokens: number;
  readonly inputTokenLimit: number | null;
  readonly outputTokenLimit: number | null;
  readonly tokenLimitEvidence: Readonly<{
    readonly source: "catalog" | "provider_official_docs" | "unknown";
    readonly version: string | null;
    readonly updatedAt: string | null;
    readonly sourceUrl: string | null;
    /** Provider declaration is not an InkShadow runtime capability test. */
    readonly verifiedByInkShadow: boolean;
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
    estimatedMaximumCostMicros: string | null;
    maximumCostMicros: string | null;
    maximumCostCurrency: string | null;
  }>;
}

export class ModelHubExecutionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly dispatched = false,
    public readonly failure: SafeAiFailureMetadata | null = null,
  ) {
    super(message);
    this.name = "ModelHubExecutionError";
  }
}

interface ResolvedTextTarget {
  readonly connection: ModelProviderConnection;
  readonly catalogEntry: ModelCatalogEntry;
  readonly costPrivacy: ModelCostPrivacyProfile;
  readonly dataDestination: "local" | "remote";
  readonly maximumOutputTokens: number;
  readonly temperature: number | undefined;
  readonly estimatedInputTokens: number;
  readonly estimatedMaximumCostMicros: string | null;
  readonly costCurrency: string | null;
  readonly inputTokenLimit: number | null;
  readonly outputTokenLimit: number | null;
  readonly tokenLimitEvidence: ModelHubTextTaskInspection["tokenLimitEvidence"];
}

interface ResolvedTextPlan {
  readonly route: NovelTaskRoute;
  readonly target: ResolvedTextTarget;
  readonly usedFallback: boolean;
  readonly inspection: ModelHubTextTaskInspection;
}

const MAXIMUM_TEXT_MESSAGES = 256;
const MAXIMUM_MESSAGE_CHARACTERS = 2_000_000;
const MAXIMUM_TOTAL_MESSAGE_CHARACTERS = 4_000_000;
const MAXIMUM_OUTPUT_TOKENS = 1_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const MODEL_HUB_TEXT_TASKS = [
  "idea_discussion",
  "book_start_guidance",
  "prose_generation",
  "continuation",
  "rewrite",
  "polish",
  "outline_planning",
  "scene_breakdown",
  "chapter_summary",
  "long_memory_compression",
  "character_extraction",
  "world_extraction",
  "contradiction_check",
  "pov_check",
  "character_voice_check",
  "content_quality_check",
  "what_if_simulation",
  "translation",
] as const satisfies readonly NovelAiTask[];

export type ModelHubTextTask = (typeof MODEL_HUB_TEXT_TASKS)[number];

/**
 * Resolves a text task exactly as execution would, without creating an
 * invocation or sending content to a provider. The returned object contains
 * only non-secret routing, parameter, context and pricing metadata.
 */
export async function inspectModelHubTextTask(
  dependencies: ModelHubTextInspectionDependencies,
  input: InspectModelHubTextTaskInput,
): Promise<ModelHubTextTaskInspection> {
  return (await resolveTextPlan(dependencies, input)).inspection;
}

/**
 * Executes one text task through the exact persisted Model Hub route.
 *
 * The invocation ledger stores only routing, usage, cost and error metadata. It
 * never receives messages or model output. Automatic fallback is deliberately
 * limited to failures discovered before a provider request is dispatched; an
 * ambiguous post-dispatch failure might already have incurred cost.
 */
export async function executeModelHubTextTask(
  dependencies: ModelHubTextExecutionDependencies,
  input: ExecuteModelHubTextTaskInput,
): Promise<ModelHubTextTaskExecutionResult> {
  const { route, target, usedFallback } = await resolveTextPlan(dependencies, input);
  const expectedDispatchIdentity = modelHubFinalDispatchIdentity({
    route,
    connection: target.connection,
    catalogEntry: target.catalogEntry,
    costPrivacy: target.costPrivacy,
  });

  const generationId = input.generationId ?? dependencies.ids.next();
  const invocationId = dependencies.ids.next();
  let invocation = await dependencies.modelHub.startInvocation({
    id: invocationId,
    task: input.task,
    routeTask: route.task,
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
  try {
    await input.onBeforeDispatch?.({
      generationId,
      invocationId: invocation.id,
      connectionId: target.connection.id,
      catalogEntryId: target.catalogEntry.id,
      modelId: target.catalogEntry.providerModelId,
      usedFallback,
      localOnlyEligible:
        target.dataDestination === "local" &&
        target.costPrivacy.evidenceSource !== "unknown" &&
        isLoopbackModelBaseUrl(target.connection.baseUrl),
    });
    const current = await resolveTextPlan(dependencies, input);
    assertModelHubFinalDispatchUnchanged(
      expectedDispatchIdentity,
      modelHubFinalDispatchIdentity({
        route: current.route,
        connection: current.target.connection,
        catalogEntry: current.target.catalogEntry,
        costPrivacy: current.target.costPrivacy,
      }),
    );
    input.assertBeforeProviderDispatch?.();
    dispatched = true;
    const reasoningPolicy =
      input.reasoningPolicy === "capability_probe"
        ? modelProviderTextCapabilityProbePolicy(current.target.connection.providerKind)
        : input.reasoningPolicy === "visible_prose"
          ? modelProviderVisibleProsePolicy(current.target.connection.providerKind)
          : null;
    const generated = await dependencies.modelGateway.generate({
      generationId,
      config: modelHubNativeEndpointConfig(current.target.connection),
      model: current.target.catalogEntry.providerModelId,
      messages: input.messages,
      dispatchScope: input.dispatchScope,
      maxOutputTokens: target.maximumOutputTokens,
      ...(target.temperature === undefined ? {} : { temperature: target.temperature }),
      ...(input.reasoningModeOverride !== undefined
        ? { reasoningMode: input.reasoningModeOverride }
        : reasoningPolicy?.reasoningMode === undefined || reasoningPolicy.reasoningMode === null
          ? {}
          : { reasoningMode: reasoningPolicy.reasoningMode }),
      ...(input.responseFormat === undefined ? {} : { responseFormat: input.responseFormat }),
      ...(input.onDelta === undefined ? {} : { onDelta: input.onDelta }),
    });
    const cost = calculateActualCost(target.costPrivacy, generated.usage);
    const costCeilingExceededAfterDispatch =
      route.maximumCostMicros !== null &&
      cost !== null &&
      BigInt(cost) > BigInt(route.maximumCostMicros);
    invocation = await dependencies.modelHub.finishInvocation({
      id: invocation.id,
      status: "succeeded",
      inputTokens: generated.usage?.inputTokens ?? null,
      outputTokens: generated.usage?.outputTokens ?? null,
      cachedInputTokens: generated.usage?.cachedInputTokens ?? null,
      estimatedCostMicros: cost,
      currency: cost === null ? null : target.costCurrency,
      completion: {
        visibleContentLength: Array.from(generated.text).length,
        stream: generated.streamed ?? null,
      },
      expectedRevision: invocation.revision,
    });
    return Object.freeze({
      text: generated.text,
      usage: generated.usage,
      invocation,
      connectionId: target.connection.id,
      catalogEntryId: target.catalogEntry.id,
      providerKind: target.connection.providerKind,
      modelId: target.catalogEntry.providerModelId,
      usedFallback,
      costCeilingExceededAfterDispatch,
    });
  } catch (cause: unknown) {
    const normalized = dispatched
      ? normalizeDispatchedError(cause)
      : normalizePreDispatchError(cause);
    const status =
      normalized.code === "MODEL_GENERATION_CANCELLED"
        ? "cancelled"
        : normalized.code.includes("TIMEOUT")
          ? "timed_out"
          : "failed";
    const failure =
      status === "failed" || status === "timed_out"
        ? safeExecutionFailureMetadata(
            cause,
            normalized,
            usedFallback ? 2 : 1,
            target.maximumOutputTokens,
            dispatched,
          )
        : null;
    invocation = await dependencies.modelHub.finishInvocation({
      id: invocation.id,
      status,
      ...(status === "failed" || status === "timed_out"
        ? {
            errorCode: normalized.code,
            errorSummary: "模型调用失败；作品正文和已有 AI 建议版本均未改变。",
            failure,
          }
        : {}),
      expectedRevision: invocation.revision,
    });
    void invocation;
    throw new ModelHubExecutionError(
      normalized.code,
      normalized.message,
      normalized.retryable,
      normalized.dispatched,
      failure,
    );
  }
}

async function resolveTextPlan(
  dependencies: ModelHubTextInspectionDependencies,
  input: InspectModelHubTextTaskInput,
): Promise<ResolvedTextPlan> {
  validateTextTaskInput(input);
  if (!dependencies.modelGateway.available) {
    throw executionError(
      "MODEL_HUB_GATEWAY_UNAVAILABLE",
      "当前环境不能调用已连接的模型。请使用桌面版，或稍后重试。",
    );
  }

  const route = await dependencies.modelHub.findTaskRoute(input.task);
  if (!route?.enabled) {
    throw executionError(
      "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      "这项写作任务还没有可用的 AI 分工。请在设置中应用一个方案或手动选择模型。",
    );
  }

  const now = dependencies.clock.now();
  let target: ResolvedTextTarget;
  let usedFallback = false;
  try {
    target = await resolveTextTarget(dependencies, route, route.primaryCatalogEntryId, input, now);
  } catch (cause: unknown) {
    if (route.failurePolicy !== "use_fallback" || route.fallbackCatalogEntryId === null) {
      throw normalizePreDispatchError(cause);
    }
    try {
      target = await resolveTextTarget(
        dependencies,
        route,
        route.fallbackCatalogEntryId,
        input,
        now,
      );
      usedFallback = true;
    } catch {
      throw executionError(
        "MODEL_HUB_PRIMARY_AND_FALLBACK_UNAVAILABLE",
        "主模型和备用模型当前都不满足这项任务。请同步模型、检查能力与隐私设置后重试。",
        true,
      );
    }
  }

  const selectionKind = usedFallback ? "task_fallback" : "task_primary";
  const inspection: ModelHubTextTaskInspection = Object.freeze({
    task: input.task as ModelHubTextTask,
    configuredPrimaryCatalogEntryId: route.primaryCatalogEntryId,
    configuredFallbackCatalogEntryId: route.fallbackCatalogEntryId,
    selectionKind,
    usedFallback,
    attempt: usedFallback ? 2 : 1,
    connectionId: target.connection.id,
    catalogEntryId: target.catalogEntry.id,
    providerKind: target.connection.providerKind,
    modelId: target.catalogEntry.providerModelId,
    dataDestination: target.dataDestination,
    privacyPolicy: route.privacyPolicy,
    failurePolicy: route.failurePolicy,
    maximumOutputTokens: target.maximumOutputTokens,
    temperature: target.temperature,
    estimatedInputTokens: target.estimatedInputTokens,
    estimatedTotalTokens: target.estimatedInputTokens + target.maximumOutputTokens,
    inputTokenLimit: target.inputTokenLimit,
    outputTokenLimit: target.outputTokenLimit,
    tokenLimitEvidence: target.tokenLimitEvidence,
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
      estimatedMaximumCostMicros: target.estimatedMaximumCostMicros,
      maximumCostMicros: route.maximumCostMicros,
      maximumCostCurrency: route.currency,
    }),
  });
  return Object.freeze({ route, target, usedFallback, inspection });
}

async function resolveTextTarget(
  dependencies: ModelHubTextInspectionDependencies,
  route: NovelTaskRoute,
  catalogEntryId: string,
  input: InspectModelHubTextTaskInput,
  now: string,
): Promise<ResolvedTextTarget> {
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
      "任务引用的模型已不存在。请重新同步模型并更新 AI 分工。",
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
      "所选模型已不可用、已弃用或目录信息已过期。请重新同步模型。",
      true,
    );
  }

  const evidence = await dependencies.modelHub.listCapabilityEvidence(catalogEntry.id);
  const requiredCapabilities =
    input.capabilityPolicy === "text_generation_only"
      ? (["text_generation"] as const)
      : requiredCapabilitiesForNovelTask(input.task);
  const missingCapability = requiredCapabilities.find(
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
      "所选模型还没有足够证据证明能完成这项任务。请验证能力或选择其他模型。",
      true,
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
      "所选模型的数据去向尚未确认。请在设置中确认隐私信息后再使用。",
    );
  }
  const dataDestination = costPrivacy.dataDestination;
  if (
    input.requiredDataDestination === "local" &&
    (dataDestination !== "local" ||
      costPrivacy.evidenceSource === "unknown" ||
      !isLoopbackModelBaseUrl(connection.baseUrl))
  ) {
    throw executionError(
      "PRIVATE_CHAPTER_LOCAL_ONLY",
      "私密章节只能由已验证的本地模型处理；本次请求在发送 0 字后停止。",
    );
  }
  if (
    route.privacyPolicy === "local_only" &&
    (dataDestination !== "local" ||
      costPrivacy.evidenceSource === "unknown" ||
      !isLoopbackModelBaseUrl(connection.baseUrl))
  ) {
    throw executionError(
      "MODEL_HUB_PRIVACY_BLOCKED",
      "这项任务仅允许在本机处理，墨影不会把正文发送到云端模型。",
    );
  }

  const officialFallback = modelProviderOfficialMetadataFallback(connection.providerKind, now, {
    baseUrl: connection.baseUrl,
    modelId: catalogEntry.providerModelId,
  });
  const inputTokenLimit =
    catalogEntry.inputTokenLimit ?? officialFallback?.contextWindowTokens ?? null;
  const outputTokenLimit =
    catalogEntry.outputTokenLimit ?? officialFallback?.maximumOutputTokens ?? null;
  const tokenLimitEvidence: ModelHubTextTaskInspection["tokenLimitEvidence"] =
    catalogEntry.inputTokenLimit !== null || catalogEntry.outputTokenLimit !== null
      ? Object.freeze({
          source: "catalog" as const,
          version: null,
          updatedAt: catalogEntry.lastSeenAt,
          sourceUrl: null,
          verifiedByInkShadow: false,
        })
      : officialFallback === null
        ? Object.freeze({
            source: "unknown" as const,
            version: null,
            updatedAt: null,
            sourceUrl: null,
            verifiedByInkShadow: false,
          })
        : Object.freeze({
            source: officialFallback.evidenceSource,
            version: officialFallback.evidenceVersion,
            updatedAt: officialFallback.evidenceUpdatedAt,
            sourceUrl: officialFallback.sourceUrl,
            verifiedByInkShadow: false,
          });
  const requestedPolicy = resolveTextParameterPolicy(route, input, connection);
  const policy = Object.freeze({
    ...requestedPolicy,
    maximumOutputTokens:
      outputTokenLimit === null
        ? requestedPolicy.maximumOutputTokens
        : Math.min(requestedPolicy.maximumOutputTokens, outputTokenLimit),
  });
  const estimatedInputTokens = estimateMessageTokens(input.messages);
  if (
    inputTokenLimit !== null &&
    estimatedInputTokens + policy.maximumOutputTokens > inputTokenLimit
  ) {
    throw executionError(
      "MODEL_HUB_CONTEXT_LIMIT_EXCEEDED",
      "当前内容和预留输出超过所选模型的上下文上限。请缩短内容或切换长上下文模型。",
    );
  }
  const estimatedMaximumCostMicros = calculateMaximumCost(
    costPrivacy,
    estimatedInputTokens,
    policy.maximumOutputTokens,
  );
  if (route.maximumCostMicros !== null) {
    if (
      route.currency === null ||
      costPrivacy.currency === null ||
      route.currency !== costPrivacy.currency ||
      estimatedMaximumCostMicros === null
    ) {
      throw executionError(
        "MODEL_HUB_COST_CEILING_UNVERIFIABLE",
        "当前价格证据不足，无法保证这项任务不超过费用上限。请更新计价信息。",
      );
    }
    if (BigInt(estimatedMaximumCostMicros) > BigInt(route.maximumCostMicros)) {
      throw executionError(
        "MODEL_HUB_COST_CEILING_EXCEEDED",
        "预计最高费用超过这项任务的上限，调用尚未发送。请降低输出长度或更换模型。",
      );
    }
  }

  return Object.freeze({
    connection,
    catalogEntry,
    costPrivacy,
    dataDestination,
    maximumOutputTokens: policy.maximumOutputTokens,
    temperature: policy.temperature,
    estimatedInputTokens,
    estimatedMaximumCostMicros,
    costCurrency: estimatedMaximumCostMicros === null ? null : costPrivacy.currency,
    inputTokenLimit,
    outputTokenLimit,
    tokenLimitEvidence,
  });
}

function resolveTextParameterPolicy(
  route: NovelTaskRoute,
  input: InspectModelHubTextTaskInput,
  connection: ModelProviderConnection,
): Readonly<{ maximumOutputTokens: number; temperature: number | undefined }> {
  const configuredOutput = route.parameterPolicy.maximumOutputTokens;
  const maximumOutputTokens =
    route.routeOrigin === "user" && configuredOutput !== undefined
      ? Math.min(
          input.maximumOutputTokens,
          typeof configuredOutput === "number" ? configuredOutput : Number.NaN,
        )
      : input.maximumOutputTokens;
  if (
    typeof maximumOutputTokens !== "number" ||
    !Number.isSafeInteger(maximumOutputTokens) ||
    maximumOutputTokens < 1 ||
    maximumOutputTokens > MAXIMUM_OUTPUT_TOKENS
  ) {
    throw executionError(
      "MODEL_HUB_PARAMETER_POLICY_INVALID",
      "这项任务保存的输出长度设置无效。请重新保存 AI 分工。",
    );
  }
  const configuredTemperature = route.parameterPolicy.temperature;
  const requestedTemperature =
    configuredTemperature === undefined ? input.temperature : configuredTemperature;
  if (
    requestedTemperature !== undefined &&
    (typeof requestedTemperature !== "number" ||
      !Number.isFinite(requestedTemperature) ||
      requestedTemperature < 0 ||
      requestedTemperature > 2)
  ) {
    throw executionError(
      "MODEL_HUB_PARAMETER_POLICY_INVALID",
      "这项任务保存的生成参数无效。请重新保存 AI 分工。",
    );
  }
  const temperature =
    getModelProviderPreset(connection.providerKind).protocol === "anthropic"
      ? requestedTemperature === 1
        ? 1
        : undefined
      : requestedTemperature;
  return Object.freeze({ maximumOutputTokens, temperature });
}

function validateTextTaskInput(input: InspectModelHubTextTaskInput): void {
  if (
    !(MODEL_HUB_TEXT_TASKS as readonly NovelAiTask[]).includes(input.task) ||
    !isArrayValue(input.messages) ||
    input.messages.length < 1 ||
    input.messages.length > MAXIMUM_TEXT_MESSAGES ||
    !Number.isSafeInteger(input.maximumOutputTokens) ||
    input.maximumOutputTokens < 1 ||
    input.maximumOutputTokens > MAXIMUM_OUTPUT_TOKENS ||
    (input.temperature !== undefined &&
      (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2))
  ) {
    throw executionError("MODEL_HUB_REQUEST_INVALID", "这次模型请求的参数无效。请调整后重试。");
  }
  let totalCharacters = 0;
  for (const message of input.messages) {
    totalCharacters += message.content.length;
    if (
      !["system", "user", "assistant"].includes(message.role) ||
      message.content.trim().length < 1 ||
      message.content.length > MAXIMUM_MESSAGE_CHARACTERS ||
      CONTROL_CHARACTER_PATTERN.test(message.content) ||
      totalCharacters > MAXIMUM_TOTAL_MESSAGE_CHARACTERS
    ) {
      throw executionError("MODEL_HUB_REQUEST_INVALID", "这次模型请求的内容无效或过长。");
    }
  }
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function estimateMessageTokens(messages: readonly NativeModelMessage[]): number {
  const bytes = new TextEncoder().encode(messages.map(({ content }) => content).join("\n")).length;
  // Every input byte is counted as a possible token, then a deliberately large
  // allowance is reserved for provider-specific chat wrappers. This favors
  // rejecting a request over understating a hard pre-dispatch cost ceiling.
  return Math.max(1, bytes + messages.length * 512 + 4_096);
}

function calculateMaximumCost(
  profile: ModelCostPrivacyProfile,
  inputTokens: number,
  outputTokens: number,
): string | null {
  if (
    profile.currency === null ||
    profile.inputMicrosPerMillionTokens === null ||
    profile.outputMicrosPerMillionTokens === null
  ) {
    return null;
  }
  return calculateCostMicros(
    inputTokens,
    outputTokens,
    0,
    profile.inputMicrosPerMillionTokens,
    profile.outputMicrosPerMillionTokens,
    profile.cachedInputMicrosPerMillionTokens,
  );
}

function calculateActualCost(
  profile: ModelCostPrivacyProfile,
  usage: NativeModelGenerationResult["usage"],
): string | null {
  if (
    usage === null ||
    profile.currency === null ||
    profile.inputMicrosPerMillionTokens === null ||
    profile.outputMicrosPerMillionTokens === null
  ) {
    return null;
  }
  return calculateCostMicros(
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens ?? 0,
    profile.inputMicrosPerMillionTokens,
    profile.outputMicrosPerMillionTokens,
    profile.cachedInputMicrosPerMillionTokens,
  );
}

function calculateCostMicros(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  inputRate: string,
  outputRate: string,
  cachedInputRate: string | null,
): string {
  const cached = BigInt(cachedInputTokens);
  const uncached = BigInt(Math.max(0, inputTokens - cachedInputTokens));
  const numerator =
    uncached * BigInt(inputRate) +
    BigInt(outputTokens) * BigInt(outputRate) +
    cached * BigInt(cachedInputRate ?? inputRate);
  return ((numerator + 999_999n) / 1_000_000n).toString();
}

function normalizePreDispatchError(cause: unknown): ModelHubExecutionError {
  if (cause instanceof ModelHubExecutionError) return cause;
  if (cause instanceof ModelHubFinalDispatchError) {
    return executionError(cause.code, cause.message, cause.retryable);
  }
  if (cause instanceof UiActionError) {
    return executionError(cause.code, cause.message, true);
  }
  const code = safePreDispatchCode(cause);
  if (code === "CONTEXT_TRACE_UNAVAILABLE") {
    return executionError(
      "CONTEXT_TRACE_UNAVAILABLE",
      "无法保存本次上下文来源记录，因此没有调用模型。请检查本机存储空间或数据库状态后重试。",
      true,
    );
  }
  if (code === "IMPORT_PENDING_REQUEST_PERSIST_FAILED") {
    return executionError(
      "IMPORT_PENDING_REQUEST_PERSIST_FAILED",
      "模型调用前的本地请求凭据没有保存成功，本次调用已在发送 0 字时停止。",
      true,
    );
  }
  return executionError(
    "MODEL_HUB_PREFLIGHT_FAILED",
    "模型调用前检查没有通过。请检查 AI 分工、模型能力、隐私和费用设置。",
    true,
  );
}

function safePreDispatchCode(cause: unknown): string | null {
  return typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
    ? cause.code
    : null;
}

function normalizeDispatchedError(cause: unknown): ModelHubExecutionError {
  if (cause instanceof ModelHubExecutionError) {
    return new ModelHubExecutionError(
      cause.code,
      cause.message,
      cause.retryable,
      true,
      cause.failure,
    );
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
      "模型调用失败。原文和已有 AI 建议版本都没有改变，请检查连接后重试。",
      "retryable" in cause && cause.retryable === true,
      true,
    );
  }
  return new ModelHubExecutionError(
    "MODEL_HUB_GENERATION_FAILED",
    "模型调用失败。原文和已有 AI 建议版本都没有改变，请检查连接后重试。",
    true,
    true,
  );
}

function safeExecutionFailureMetadata(
  cause: unknown,
  normalized: ModelHubExecutionError,
  attempt: number,
  requestedMaxOutputTokens: number,
  dispatched: boolean,
): SafeAiFailureMetadata {
  const diagnostics = isRecord(cause) && isRecord(cause.diagnostics) ? cause.diagnostics : null;
  const httpStatus = safeFailureInteger(diagnostics?.httpStatus, 100, 599);
  return Object.freeze({
    requestId: safeFailureString(diagnostics?.requestId),
    stage: executionFailureStage(normalized.code, dispatched, httpStatus),
    retryable:
      isRecord(cause) && typeof cause.retryable === "boolean"
        ? cause.retryable
        : normalized.retryable,
    httpStatus,
    finishReason: safeFailureString(diagnostics?.finishReason),
    visibleContentLength: safeFailureInteger(diagnostics?.visibleContentLength, 0, 100_000_000),
    reasoningPresent:
      typeof diagnostics?.reasoningPresent === "boolean" ? diagnostics.reasoningPresent : null,
    stream: typeof diagnostics?.stream === "boolean" ? diagnostics.stream : null,
    attempt,
    requestedMaxOutputTokens,
  });
}

function executionFailureStage(
  code: string,
  dispatched: boolean,
  httpStatus: number | null,
): ModelFailureStage {
  if (!dispatched) return "request_preparation";
  if (httpStatus !== null) return "http_response";
  if (/STREAM|SSE/u.test(code)) return "stream_parse";
  if (/OUTPUT|RESPONSE|MALFORMED|JSON/u.test(code)) return "response_normalization";
  if (code.includes("HTTP")) return "http_response";
  if (/NETWORK|TIMEOUT|DNS|TLS|TRANSPORT/u.test(code)) return "transport";
  return "dispatch";
}

function safeFailureString(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function safeFailureInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : null;
}

function executionError(code: string, message: string, retryable = false): ModelHubExecutionError {
  return new ModelHubExecutionError(code, message, retryable, false);
}
