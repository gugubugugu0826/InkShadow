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
import {
  MODEL_EXECUTION_POLICY_VERSION,
  SINGLE_ATTEMPT_AUTO_FALLBACK_CONDITIONS,
  SINGLE_ATTEMPT_STOP_CONDITIONS,
  type ModelExecutionPolicy,
} from "./model-execution-policy";
import { isRecoveredNativeDispatchHandshakeAmbiguous } from "./model-hub-text-capability-probe";
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
  /**
   * Classifies fixed, content-free evaluation calls independently from the
   * writing task whose route is being evaluated.
   */
  readonly invocationLedgerTask?: "capability_probe";
  /** Optional caller-reserved invocation id used to recover an interrupted local workflow. */
  readonly invocationId?: string;
  /**
   * Unified one-attempt execution authority. Callers should pass a named
   * policy; legacy fields below are accepted only when they describe the same
   * policy and are never allowed to widen it.
   */
  readonly executionPolicy: ModelExecutionPolicy;
  /** Applies a narrow provider-aware reasoning policy at the named task boundary. */
  readonly reasoningPolicy?: "capability_probe" | "visible_prose";
  /** A one-shot recovery override after a reasoning-only truncation. */
  readonly reasoningModeOverride?: "disabled";
  /** Narrows Provider POST retry authority without changing connection discovery policy. */
  readonly generationRetryLimitOverride?: 0;
  /** Request provider JSON mode only after structured output has evidence. */
  readonly responseFormat?: "json_object";
  /**
   * Synchronously validates the complete visible provider response before the
   * invocation can be committed as succeeded. Structured callers use this
   * boundary for JSON/schema validation so an HTTP 200 with unusable output is
   * recorded as a response-normalization failure, not a successful call.
   */
  readonly validateGeneratedText?: (text: string) => undefined;
  readonly onBeforeDispatch?: (selection: ModelHubTextDispatchSelection) => void | Promise<void>;
  /**
   * Rechecks mutable project/source/privacy authority after the final async
   * route resolution. This hook must not persist a second trace or repeat an
   * authorization side effect; it exists solely for last-moment fail-closed
   * checks immediately before the synchronous dispatch latch.
   */
  readonly onFinalBeforeProviderDispatch?: (
    selection: ModelHubTextDispatchSelection,
  ) => void | Promise<void>;
  /**
   * Final synchronous cancellation/authorization latch. It runs after every
   * async pre-dispatch check and immediately before the gateway call, so a
   * cancellation raised while onBeforeDispatch is awaiting cannot be lost.
   */
  readonly assertBeforeProviderDispatch?: () => void;
  /** Notification after the durable receipt. It may persist a local journey checkpoint before dispatch continues. */
  readonly onProviderDispatchStarted?: (
    selection: ModelHubTextDispatchSelection,
  ) => void | Promise<void>;
  readonly onDelta?: (accumulatedText: string) => void;
}

export type ModelHubTextDispatchSelection = Readonly<{
  generationId: string;
  invocationId: string;
  connectionId: string;
  catalogEntryId: string;
  modelId: string;
  usedFallback: boolean;
  privacyPolicy: NovelTaskRoute["privacyPolicy"];
  dataDestination: "local" | "remote";
  /** True only for an evidence-backed local model on a loopback endpoint. */
  localOnlyEligible?: boolean;
}>;

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
  readonly modelGateway: Pick<
    NativeModelGatewayClient,
    "available" | "generate" | "supportsNativeInvocationDispatchLedger"
  >;
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
  const executionPolicy = resolveModelExecutionPolicy(input);
  assertInvocationLedgerClassification(input, executionPolicy);
  const { route, target, usedFallback } = await resolveTextPlan(dependencies, input);
  assertExecutionPolicyTransportSupported(executionPolicy, target.connection);
  const expectedDispatchIdentity = modelHubFinalDispatchIdentity({
    route,
    connection: target.connection,
    catalogEntry: target.catalogEntry,
    costPrivacy: target.costPrivacy,
  });

  const generationId = input.generationId ?? dependencies.ids.next();
  const invocationId = input.invocationId ?? dependencies.ids.next();
  let invocation = await dependencies.modelHub.startInvocation({
    id: invocationId,
    task: input.invocationLedgerTask ?? input.task,
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
  let generatedObservation: NativeModelGenerationResult | null = null;
  let generatedCostMicros: string | null = null;
  let successSettlementStarted = false;
  let recoveredNativeDispatchReceipt = false;
  const nativeReceiptObservation = { postReceiptLocalFailure: false };
  const nativeCapabilityDispatchLedger =
    input.invocationLedgerTask === "capability_probe" &&
    dependencies.modelGateway.supportsNativeInvocationDispatchLedger === true;
  try {
    await input.onBeforeDispatch?.({
      generationId,
      invocationId: invocation.id,
      connectionId: target.connection.id,
      catalogEntryId: target.catalogEntry.id,
      modelId: target.catalogEntry.providerModelId,
      usedFallback,
      privacyPolicy: route.privacyPolicy,
      dataDestination: target.dataDestination,
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
    await input.onFinalBeforeProviderDispatch?.({
      generationId,
      invocationId: invocation.id,
      connectionId: current.target.connection.id,
      catalogEntryId: current.target.catalogEntry.id,
      modelId: current.target.catalogEntry.providerModelId,
      usedFallback: current.usedFallback,
      privacyPolicy: current.route.privacyPolicy,
      dataDestination: current.target.dataDestination,
      localOnlyEligible:
        current.target.dataDestination === "local" &&
        current.target.costPrivacy.evidenceSource !== "unknown" &&
        isLoopbackModelBaseUrl(current.target.connection.baseUrl),
    });
    input.assertBeforeProviderDispatch?.();
    const dispatchSelection = Object.freeze({
      generationId,
      invocationId: invocation.id,
      connectionId: current.target.connection.id,
      catalogEntryId: current.target.catalogEntry.id,
      modelId: current.target.catalogEntry.providerModelId,
      usedFallback: current.usedFallback,
      privacyPolicy: current.route.privacyPolicy,
      dataDestination: current.target.dataDestination,
      localOnlyEligible:
        current.target.dataDestination === "local" &&
        current.target.costPrivacy.evidenceSource !== "unknown" &&
        isLoopbackModelBaseUrl(current.target.connection.baseUrl),
    });
    if (!nativeCapabilityDispatchLedger) {
      invocation = await dependencies.modelHub.markInvocationDispatched({
        id: invocation.id,
        dispatchedAt: dependencies.clock.now(),
        expectedRevision: invocation.revision,
      });
      // Legacy/test gateways have no native SQLite boundary. Production
      // capability probes use the atomic native receipt below.
      dispatched = true;
      await input.onProviderDispatchStarted?.(dispatchSelection);
    }
    const reasoningPolicy =
      executionPolicy.reasoningMode === "capability_probe"
        ? modelProviderTextCapabilityProbePolicy(current.target.connection.providerKind)
        : executionPolicy.reasoningMode === "provider_visible_prose"
          ? modelProviderVisibleProsePolicy(current.target.connection.providerKind)
          : null;
    const nativeConfig = modelHubNativeEndpointConfig(current.target.connection);
    const generated = await dependencies.modelGateway.generate({
      generationId,
      config: Object.freeze({ ...nativeConfig, retryLimit: executionPolicy.providerRetryLimit }),
      model: current.target.catalogEntry.providerModelId,
      messages: input.messages,
      dispatchScope: input.dispatchScope,
      maxOutputTokens: target.maximumOutputTokens,
      ...(target.temperature === undefined ? {} : { temperature: target.temperature }),
      ...(executionPolicy.reasoningMode === "disabled" &&
      nativeConfig.provider === "open_ai_compatible"
        ? { reasoningMode: "disabled" as const }
        : reasoningPolicy?.reasoningMode === undefined || reasoningPolicy.reasoningMode === null
          ? {}
          : { reasoningMode: reasoningPolicy.reasoningMode }),
      ...(executionPolicy.transportResponseFormat === "text"
        ? {}
        : { responseFormat: executionPolicy.transportResponseFormat }),
      ...(input.onDelta === undefined ? {} : { onDelta: input.onDelta }),
      ...(nativeCapabilityDispatchLedger
        ? {
            invocationDispatchLedger: {
              invocationId: invocation.id,
              expectedRevision: invocation.revision,
              connectionId: current.target.connection.id,
              connectionRevision: current.target.connection.revision,
              catalogEntryId: current.target.catalogEntry.id,
              catalogEntryRevision: current.target.catalogEntry.revision,
              providerKindSnapshot: current.target.connection.providerKind,
              modelIdSnapshot: current.target.catalogEntry.providerModelId,
            },
            onInvocationDispatchAccepted: async (receipt) => {
              invocation = Object.freeze({
                ...invocation,
                providerDispatchStartedAt: receipt.dispatchedAt,
                revision: receipt.revision,
              });
              dispatched = true;
              try {
                await input.onProviderDispatchStarted?.(dispatchSelection);
              } catch (cause: unknown) {
                nativeReceiptObservation.postReceiptLocalFailure = true;
                throw cause;
              }
            },
          }
        : {}),
    });
    generatedObservation = generated;
    generatedCostMicros = calculateActualCost(target.costPrivacy, generated.usage);
    if (executionPolicy.outputContract === "visible_text" && generated.text.trim().length === 0) {
      throw visibleTextOutputEmptyFailure(generated);
    }
    if (input.validateGeneratedText !== undefined) {
      try {
        const validator = input.validateGeneratedText as (text: string) => unknown;
        const validationResult = validator(generated.text);
        if (validationResult !== undefined) {
          throw Object.assign(new Error("response validator must be synchronous"), {
            code: "MODEL_RESPONSE_VALIDATOR_ASYNC_UNSUPPORTED",
          });
        }
      } catch (cause: unknown) {
        throw responseValidationFailure(cause, generated);
      }
    }
    const cost = generatedCostMicros;
    const costCeilingExceededAfterDispatch =
      route.maximumCostMicros !== null &&
      cost !== null &&
      BigInt(cost) > BigInt(route.maximumCostMicros);
    successSettlementStarted = true;
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
    if (successSettlementStarted) {
      throw new AggregateError(
        [cause],
        "模型服务已经返回，但调用账本未能安全结算；重启后会标记为结果待核对，系统不会自动重发。",
      );
    }
    if (nativeCapabilityDispatchLedger && !dispatched) {
      // If the invoke response was lost after the native atomic write, recover
      // the durable truth before classifying the outcome. Never resend here.
      try {
        const persisted = await dependencies.modelHub.findInvocation(invocation.id);
        if (
          persisted?.status === "running" &&
          persisted.providerDispatchStartedAt !== null &&
          persisted.revision === invocation.revision + 1
        ) {
          invocation = persisted;
          dispatched = true;
          recoveredNativeDispatchReceipt = true;
        }
      } catch {
        // Startup reconciliation owns an unreadable durable receipt.
      }
    }
    const normalized = dispatched
      ? normalizeDispatchedError(cause)
      : normalizePreDispatchError(cause);
    const failureMetadata = safeExecutionFailureMetadata(
      cause,
      normalized,
      usedFallback ? 2 : 1,
      target.maximumOutputTokens,
      dispatched,
    );
    const ambiguous =
      nativeReceiptObservation.postReceiptLocalFailure ||
      isRecoveredNativeDispatchHandshakeAmbiguous(
        recoveredNativeDispatchReceipt,
        normalized.code === "MODEL_GENERATION_CANCELLED",
        failureMetadata,
      ) ||
      isAmbiguousDispatchedTransportFailure(dispatched, normalized, failureMetadata);
    const projected = ambiguous ? ambiguousProviderResult(normalized, failureMetadata) : normalized;
    const status =
      normalized.code === "MODEL_GENERATION_CANCELLED"
        ? "cancelled"
        : ambiguous
          ? "timed_out"
          : "failed";
    const failure = status === "failed" || status === "timed_out" ? failureMetadata : null;
    const observedUsage = generatedObservation?.usage ?? safeFailureUsage(cause);
    const observedCostMicros =
      generatedCostMicros ??
      (observedUsage === null ? null : calculateActualCost(target.costPrivacy, observedUsage));
    invocation = await dependencies.modelHub.finishInvocation({
      id: invocation.id,
      status,
      inputTokens: observedUsage?.inputTokens ?? null,
      outputTokens: observedUsage?.outputTokens ?? null,
      cachedInputTokens: observedUsage?.cachedInputTokens ?? null,
      estimatedCostMicros: observedCostMicros,
      currency: observedCostMicros === null ? null : target.costCurrency,
      ...(status === "failed" || status === "timed_out"
        ? {
            errorCode: projected.code,
            errorSummary: ambiguous
              ? "模型请求已发送，但连接在收到明确结果前中断；结果未知且不会自动重发。"
              : "模型调用失败；作品正文和已有 AI 建议版本均未改变。",
            failure,
          }
        : {}),
      expectedRevision: invocation.revision,
    });
    void invocation;
    throw new ModelHubExecutionError(
      projected.code,
      projected.message,
      projected.retryable,
      projected.dispatched,
      failure,
    );
  }
}

function assertInvocationLedgerClassification(
  input: ExecuteModelHubTextTaskInput,
  policy: ModelExecutionPolicy,
): void {
  if (input.invocationLedgerTask !== "capability_probe") return;
  if (
    input.dispatchScope.kind !== "non_project" ||
    input.dispatchScope.reason !== "connection_probe" ||
    policy.reasoningMode !== "capability_probe"
  ) {
    throw executionError(
      "MODEL_CAPABILITY_PROBE_POLICY_INVALID",
      "模型能力验证必须使用固定的非作品范围与零重试策略。",
    );
  }
}

function assertExecutionPolicyTransportSupported(
  policy: ModelExecutionPolicy,
  connection: ModelProviderConnection,
): void {
  if (
    policy.transportResponseFormat === "json_object" &&
    getModelProviderPreset(connection.providerKind).protocol !== "openai_compatible"
  ) {
    throw executionError(
      "MODEL_EXECUTION_POLICY_TRANSPORT_UNSUPPORTED",
      "所选模型协议不能安全启用 JSON 传输模式；本次请求在发送前停止。",
    );
  }
}

function resolveModelExecutionPolicy(input: ExecuteModelHubTextTaskInput): ModelExecutionPolicy {
  const policy = input.executionPolicy;
  assertModelExecutionPolicy(policy, input);
  return policy;
}

function assertModelExecutionPolicy(
  policy: ModelExecutionPolicy,
  input: ExecuteModelHubTextTaskInput,
): void {
  const policyRecord = policy as unknown as Readonly<Record<string, unknown>>;
  if (
    policyRecord.version !== MODEL_EXECUTION_POLICY_VERSION ||
    policyRecord.primaryRoute !== "configured_task_route" ||
    policyRecord.orderedFallbackRoutes !== "configured_predispatch_only" ||
    policyRecord.requiredCapabilities !== "resolved_task_contract" ||
    policyRecord.privacyDestination !== "authoritative_dispatch_scope" ||
    policyRecord.maximumProviderCalls !== 1 ||
    policyRecord.maximumAttempts !== 1 ||
    policyRecord.automaticRetryCount !== 0 ||
    policyRecord.providerRetryLimit !== 0 ||
    policyRecord.costPolicy !== "authoritative_preflight_or_explicit_unknown" ||
    policyRecord.preDispatchFallback !== "configured_route_only" ||
    policyRecord.postDispatchFallback !== "forbidden" ||
    policyRecord.ambiguousRedispatch !== "forbidden" ||
    !samePolicyList(policy.autoFallbackConditions, SINGLE_ATTEMPT_AUTO_FALLBACK_CONDITIONS) ||
    !samePolicyList(policy.stopConditions, SINGLE_ATTEMPT_STOP_CONDITIONS) ||
    policy.outputValidation !==
      (policy.outputContract === "strict_json"
        ? "strict_json_caller_validator_before_success"
        : "visible_text_contract")
  ) {
    throw executionError(
      "MODEL_EXECUTION_POLICY_UNSAFE",
      "这项 AI 操作的调用边界不安全；本次请求在发送前停止。",
    );
  }
  if (policy.transportResponseFormat === "json_object" && policy.outputContract !== "strict_json") {
    throw executionError(
      "MODEL_EXECUTION_POLICY_OUTPUT_CONFLICT",
      "这项 AI 操作的输出格式合同不一致；本次请求在发送前停止。",
    );
  }
  if (policy.outputContract === "strict_json" && input.validateGeneratedText === undefined) {
    throw executionError(
      "MODEL_EXECUTION_POLICY_VALIDATOR_REQUIRED",
      "这项结构化 AI 操作缺少完整结果校验；本次请求在发送前停止。",
    );
  }
  if (input.validateGeneratedText !== undefined && policy.outputContract !== "strict_json") {
    throw executionError(
      "MODEL_EXECUTION_POLICY_VALIDATOR_CONFLICT",
      "这项 AI 操作的结果校验与输出合同不一致；本次请求在发送前停止。",
    );
  }
  if (
    input.responseFormat !== undefined &&
    input.responseFormat !== policy.transportResponseFormat
  ) {
    throw executionError(
      "MODEL_EXECUTION_POLICY_OUTPUT_CONFLICT",
      "这项 AI 操作的输出格式合同不一致；本次请求在发送前停止。",
    );
  }
  if (input.reasoningModeOverride === "disabled" && policy.reasoningMode !== "disabled") {
    throw executionError(
      "MODEL_EXECUTION_POLICY_REASONING_CONFLICT",
      "这项 AI 操作的推理模式合同不一致；本次请求在发送前停止。",
    );
  }
  if (input.reasoningPolicy === "capability_probe" && policy.reasoningMode !== "capability_probe") {
    throw executionError(
      "MODEL_EXECUTION_POLICY_REASONING_CONFLICT",
      "这项 AI 操作的推理模式合同不一致；本次请求在发送前停止。",
    );
  }
  if (
    input.reasoningPolicy === "visible_prose" &&
    policy.reasoningMode !== "provider_visible_prose"
  ) {
    throw executionError(
      "MODEL_EXECUTION_POLICY_REASONING_CONFLICT",
      "这项 AI 操作的推理模式合同不一致；本次请求在发送前停止。",
    );
  }
}

function samePolicyList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

class ModelHubResponseValidationFailure extends Error {
  public readonly retryable = false;
  public readonly diagnostics: Readonly<{
    visibleContentLength: number;
    reasoningPresent: boolean | null;
    stream: boolean | null;
  }>;

  public constructor(
    public readonly code: string,
    generated: NativeModelGenerationResult,
    options: Readonly<{
      message?: string;
      visibleContentLength?: number;
    }> = {},
  ) {
    super(
      options.message ?? "模型已返回，但结果不符合这项任务要求的完整结构；本次结果不会进入作品。",
    );
    this.name = "ModelHubResponseValidationFailure";
    const visibleContentLength = options.visibleContentLength ?? Array.from(generated.text).length;
    this.diagnostics = Object.freeze({
      visibleContentLength,
      reasoningPresent:
        visibleContentLength === 0 && (generated.usage?.outputTokens ?? 0) > 0 ? true : null,
      stream: generated.streamed ?? null,
    });
  }
}

function visibleTextOutputEmptyFailure(
  generated: NativeModelGenerationResult,
): ModelHubResponseValidationFailure {
  return new ModelHubResponseValidationFailure("MODEL_OUTPUT_EMPTY", generated, {
    message: "模型没有返回可用于写作的可见文字；本次结果不会进入作品，也不会自动重试。",
    visibleContentLength: 0,
  });
}

function responseValidationFailure(
  cause: unknown,
  generated: NativeModelGenerationResult,
): ModelHubResponseValidationFailure {
  const explicitCode = safePreDispatchCode(cause);
  const visibleContentLength = Array.from(generated.text).length;
  const code =
    visibleContentLength === 0
      ? (generated.usage?.outputTokens ?? 0) > 0
        ? "MODEL_STRUCTURED_OUTPUT_REASONING_ONLY"
        : "MODEL_STRUCTURED_OUTPUT_EMPTY"
      : explicitCode !== null && /(?:JSON|OUTPUT|RESPONSE|SCHEMA)/u.test(explicitCode)
        ? explicitCode
        : "MODEL_STRUCTURED_OUTPUT_SCHEMA_MISMATCH";
  return new ModelHubResponseValidationFailure(code, generated);
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
  if (route === null) {
    throw executionError(
      "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      "这项写作任务还没有可用的 AI 分工。请在设置中应用一个方案或手动选择模型。",
    );
  }
  if (!route.enabled) {
    throw executionError(
      "MODEL_HUB_ROUTE_DISABLED",
      "这项写作任务的 AI 分工已被停用。本次请求不会改用旧配置；如需使用 AI，请先重新启用该分工。",
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
  if (/(?:^|_)(?:STREAM|SSE)(?:_|$)/u.test(code)) return "stream_parse";
  if (/OUTPUT|RESPONSE|MALFORMED|JSON/u.test(code)) return "response_normalization";
  if (httpStatus !== null || code.includes("HTTP")) return "http_response";
  if (/NETWORK|TIMEOUT|DNS|TLS|TRANSPORT/u.test(code)) return "transport";
  return "dispatch";
}

function isAmbiguousDispatchedTransportFailure(
  dispatched: boolean,
  normalized: ModelHubExecutionError,
  failure: SafeAiFailureMetadata,
): boolean {
  return (
    dispatched &&
    normalized.code !== "MODEL_GENERATION_CANCELLED" &&
    failure.stage === "transport" &&
    failure.httpStatus === null
  );
}

function ambiguousProviderResult(
  normalized: ModelHubExecutionError,
  failure: SafeAiFailureMetadata,
): ModelHubExecutionError {
  return new ModelHubExecutionError(
    "PROVIDER_RESULT_AMBIGUOUS",
    "模型请求已发送，但连接在收到明确结果前中断。结果可能已在服务端产生；为避免重复费用，本次不会自动重发。",
    false,
    true,
    Object.freeze({ ...failure, retryable: normalized.retryable }),
  );
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

function safeFailureUsage(cause: unknown): NativeModelGenerationResult["usage"] {
  const diagnostics = isRecord(cause) && isRecord(cause.diagnostics) ? cause.diagnostics : null;
  const inputTokens = safeFailureInteger(diagnostics?.inputTokens, 0, 100_000_000);
  const outputTokens = safeFailureInteger(diagnostics?.outputTokens, 0, 100_000_000);
  if (inputTokens === null || outputTokens === null) return null;
  return Object.freeze({ inputTokens, outputTokens, cachedInputTokens: null });
}

function executionError(code: string, message: string, retryable = false): ModelHubExecutionError {
  return new ModelHubExecutionError(code, message, retryable, false);
}
