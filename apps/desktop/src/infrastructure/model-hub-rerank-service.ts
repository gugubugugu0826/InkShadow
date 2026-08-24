import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import { ModelHubExecutionError } from "./model-hub-execution-service";
import {
  assertModelHubFinalDispatchUnchanged,
  modelHubFinalDispatchIdentity,
} from "./model-hub-final-dispatch-guard";
import { modelHubCredentialProviderId } from "./model-hub-native-config";
import { resolveModelCapabilityVerdict } from "./model-hub-router";
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
  NativeRerankGatewayClient,
  NativeRerankResult,
  NativeRerankScore,
} from "./native-rerank-gateway";
import type { NativeModelDispatchScope } from "./native-model-gateway-contract";

export interface ModelHubRerankInput {
  readonly query: string;
  readonly documents: readonly string[];
  readonly topN: number;
  readonly dispatchScope: NativeModelDispatchScope;
  readonly onBeforeDispatch?: (inspection: ModelHubRerankInspection) => void | Promise<void>;
}

export interface ModelHubRerankInspection {
  readonly task: "rerank";
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: "alibaba_qwen";
  readonly modelId: string;
  readonly usedFallback: boolean;
  readonly dataDestination: "remote";
  readonly explicitRemoteContentConsent: true;
  readonly estimatedInputTokens: number;
  readonly estimatedCostMicros: string | null;
  readonly fingerprintMaterial: Readonly<{
    version: "model-hub-qwen-rerank-v1";
    routeRevision: number;
    connectionId: string;
    connectionRevision: number;
    catalogEntryId: string;
    catalogRevision: number;
    costPrivacyRevision: number;
    capabilityEvidence: readonly string[];
  }>;
}

export interface ModelHubRerankExecutionResult {
  readonly rankings: readonly NativeRerankScore[];
  readonly invocation: ModelInvocationFact;
  readonly inspection: ModelHubRerankInspection;
  readonly inputTokens: number;
}

export type ModelHubRerankAttempt =
  | Readonly<{
      status: "applied";
      source: "alibaba_qwen_remote";
      result: ModelHubRerankExecutionResult;
      message: string;
    }>
  | Readonly<{
      status: "skipped";
      source: "local_deterministic_fallback";
      code: string;
      message: string;
    }>;

export interface MergedRerankPosition {
  readonly index: number;
  readonly score: number;
  readonly source: "qwen_remote" | "local";
}

/**
 * Merges a partial provider result with the complete deterministic local order.
 * Invalid/duplicate provider indices are ignored and can therefore never erase
 * the locally retrieved candidates.
 */
export function mergeRemoteRerankWithLocalFallback(
  input: Readonly<{
    documentCount: number;
    remoteRankings: readonly NativeRerankScore[];
    localRankings: readonly Readonly<{ index: number; score: number }>[];
  }>,
): readonly MergedRerankPosition[] {
  const merged: MergedRerankPosition[] = [];
  const seen = new Set<number>();
  const append = (index: number, score: number, source: MergedRerankPosition["source"]): void => {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= input.documentCount ||
      seen.has(index) ||
      !Number.isFinite(score)
    ) {
      return;
    }
    seen.add(index);
    merged.push(Object.freeze({ index, score: Math.max(0, Math.min(1, score)), source }));
  };
  for (const ranking of input.remoteRankings) {
    append(ranking.index, ranking.relevanceScore, "qwen_remote");
  }
  for (const ranking of input.localRankings) {
    append(ranking.index, ranking.score, "local");
  }
  for (let index = 0; index < input.documentCount; index += 1) {
    append(index, 0, "local");
  }
  return Object.freeze(merged);
}

interface ModelHubRerankDependencies {
  readonly modelHub: ModelHubStore;
  readonly gateway: NativeRerankGatewayClient;
  readonly credentials: Readonly<{
    getSummary(providerId: string): Promise<Readonly<{ configured: boolean }>>;
  }>;
  readonly ids: Pick<UuidV7Generator, "next">;
  readonly clock: Clock;
}

interface RerankAccounting {
  readonly estimatedInputTokens: number;
  readonly totalBytes: number;
  readonly documentCount: number;
}

interface ResolvedRerankTarget {
  readonly route: NovelTaskRoute;
  readonly connection: ModelProviderConnection & {
    readonly providerKind: "alibaba_qwen";
  };
  readonly catalogEntry: ModelCatalogEntry;
  readonly costPrivacy: ModelCostPrivacyProfile;
  readonly capabilityEvidence: readonly ModelCapabilityEvidence[];
  readonly baseUrl: string;
  readonly usedFallback: boolean;
  readonly estimatedInputTokens: number;
  readonly estimatedCostMicros: string | null;
  readonly inspection: ModelHubRerankInspection;
}

const MAX_DOCUMENTS = 64;
const MAX_QUERY_BYTES = 16 * 1_024;
const MAX_DOCUMENT_BYTES = 32 * 1_024;
const MAX_TOTAL_BYTES = 256 * 1_024;
const MAX_ESTIMATED_TOKENS = 1_000_000_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const QWEN_RERANK_PROTOCOL = "qwen_open_ai_compatible" as const;

export class ModelHubRerankService {
  public constructor(private readonly dependencies: ModelHubRerankDependencies) {}

  public async inspect(input: ModelHubRerankInput): Promise<ModelHubRerankInspection> {
    return (await resolveRerankTarget(this.dependencies, input)).inspection;
  }

  public async tryRerank(input: ModelHubRerankInput): Promise<ModelHubRerankAttempt> {
    try {
      const result = await this.rerank(input);
      return Object.freeze({
        status: "applied" as const,
        source: "alibaba_qwen_remote" as const,
        result,
        message:
          "已按你在创作任务安排中确认的远程发送设置，使用阿里云百炼 Qwen 对本地召回结果重排。",
      });
    } catch (cause: unknown) {
      const error = normalizeRerankError(cause, false);
      return Object.freeze({
        status: "skipped" as const,
        source: "local_deterministic_fallback" as const,
        code: error.code,
        message: safeSkipMessage(error.code),
      });
    }
  }

  public async rerank(input: ModelHubRerankInput): Promise<ModelHubRerankExecutionResult> {
    const initial = await resolveRerankTarget(this.dependencies, input);
    const expectedDispatchIdentity = modelHubFinalDispatchIdentity({
      route: initial.route,
      connection: initial.connection,
      catalogEntry: initial.catalogEntry,
      costPrivacy: initial.costPrivacy,
    });
    let invocation = await this.dependencies.modelHub.startInvocation({
      id: this.dependencies.ids.next(),
      task: "rerank",
      routeTask: "rerank",
      connectionId: initial.connection.id,
      catalogEntryId: initial.catalogEntry.id,
      providerKindSnapshot: initial.connection.providerKind,
      modelIdSnapshot: initial.catalogEntry.providerModelId,
      routeReason: initial.usedFallback ? "task_fallback" : "task_primary",
      attempt: initial.usedFallback ? 2 : 1,
      privacyPolicy: initial.route.privacyPolicy,
      dataDestination: "remote",
      maximumCostMicros: initial.route.maximumCostMicros,
      currency: initial.route.currency,
    });

    let dispatched = false;
    let nativeResult: NativeRerankResult;
    try {
      const immediatelyBefore = await resolveRerankTarget(this.dependencies, input);
      requireSameFingerprint(initial.inspection, immediatelyBefore.inspection);
      await input.onBeforeDispatch?.(immediatelyBefore.inspection);
      const current = await resolveRerankTarget(this.dependencies, input);
      requireSameFingerprint(initial.inspection, current.inspection);
      assertModelHubFinalDispatchUnchanged(
        expectedDispatchIdentity,
        modelHubFinalDispatchIdentity({
          route: current.route,
          connection: current.connection,
          catalogEntry: current.catalogEntry,
          costPrivacy: current.costPrivacy,
        }),
      );
      dispatched = true;
      nativeResult = await this.dependencies.gateway.rerank({
        config: {
          providerId: modelHubCredentialProviderId(current.connection),
          provider: "open_ai_compatible",
          baseUrl: current.baseUrl,
          authentication: "bearer_keyring",
        },
        protocol: QWEN_RERANK_PROTOCOL,
        model: current.catalogEntry.providerModelId,
        query: input.query,
        documents: input.documents,
        topN: input.topN,
        dispatchScope: input.dispatchScope,
      });
      const immediatelyAfter = await resolveRerankTarget(this.dependencies, input);
      requireSameFingerprint(initial.inspection, immediatelyAfter.inspection);
    } catch (cause: unknown) {
      const error = normalizeRerankError(cause, dispatched);
      await this.dependencies.modelHub
        .finishInvocation({
          id: invocation.id,
          status: "failed",
          errorCode: error.code,
          errorSummary: dispatched
            ? "Remote rerank was discarded after a provider or post-dispatch validation failure."
            : "Remote rerank was blocked before source text left the device.",
          expectedRevision: invocation.revision,
        })
        .catch(() => undefined);
      throw error;
    }

    const inputTokens = nativeResult.inputTokens ?? initial.estimatedInputTokens;
    const estimatedCostMicros = calculateInputCost(initial.costPrivacy, inputTokens);
    try {
      invocation = await this.dependencies.modelHub.finishInvocation({
        id: invocation.id,
        status: "succeeded",
        inputTokens,
        outputTokens: 0,
        cachedInputTokens: null,
        estimatedCostMicros,
        currency: estimatedCostMicros === null ? null : initial.costPrivacy.currency,
        expectedRevision: invocation.revision,
      });
    } catch {
      throw new ModelHubExecutionError(
        "MODEL_HUB_INVOCATION_LEDGER_FAILED",
        "检索排序已经执行，但模型使用记录未能完成。为避免重复费用，本次不会自动重试。",
        true,
        true,
      );
    }

    return Object.freeze({
      rankings: Object.freeze([...nativeResult.rankings]),
      invocation,
      inspection: initial.inspection,
      inputTokens,
    });
  }
}

async function resolveRerankTarget(
  dependencies: ModelHubRerankDependencies,
  input: ModelHubRerankInput,
): Promise<ResolvedRerankTarget> {
  const accounting = validateAndEstimateInput(input);
  if (!dependencies.gateway.available) {
    throw executionError(
      "MODEL_HUB_RERANK_GATEWAY_UNAVAILABLE",
      "当前环境没有可用的原生重排网关。",
    );
  }
  const route = await dependencies.modelHub.findTaskRoute("rerank");
  if (!route?.enabled) {
    throw executionError("MODEL_HUB_RERANK_ROUTE_NOT_CONFIGURED", "尚未配置检索重排任务。");
  }
  if (
    route.routeOrigin !== "user" ||
    route.privacyPolicy !== "cloud_allowed" ||
    route.parameterPolicy.remoteContentConsent !== true
  ) {
    throw executionError(
      "MODEL_HUB_RERANK_REMOTE_CONSENT_REQUIRED",
      "远程重排默认关闭；请在专家模式的检索重排分工中明确允许发送候选片段。",
    );
  }

  let resolved: Omit<ResolvedRerankTarget, "route" | "usedFallback" | "inspection">;
  let usedFallback = false;
  try {
    resolved = await resolveCatalogTarget(
      dependencies,
      route,
      route.primaryCatalogEntryId,
      accounting,
    );
  } catch (primaryCause: unknown) {
    if (route.failurePolicy !== "use_fallback" || route.fallbackCatalogEntryId === null) {
      throw primaryCause;
    }
    resolved = await resolveCatalogTarget(
      dependencies,
      route,
      route.fallbackCatalogEntryId,
      accounting,
    );
    usedFallback = true;
  }

  const capabilityIds = resolved.capabilityEvidence
    .filter(
      ({ capability, verdict, expiresAt }) =>
        capability === "rerank" &&
        verdict === "supported" &&
        (expiresAt === null || expiresAt > dependencies.clock.now()),
    )
    .map(({ id, evidenceVersion }) => `${id}:${evidenceVersion}`)
    .sort();
  const inspection: ModelHubRerankInspection = Object.freeze({
    task: "rerank",
    connectionId: resolved.connection.id,
    catalogEntryId: resolved.catalogEntry.id,
    providerKind: "alibaba_qwen",
    modelId: resolved.catalogEntry.providerModelId,
    usedFallback,
    dataDestination: "remote",
    explicitRemoteContentConsent: true,
    estimatedInputTokens: resolved.estimatedInputTokens,
    estimatedCostMicros: resolved.estimatedCostMicros,
    fingerprintMaterial: Object.freeze({
      version: "model-hub-qwen-rerank-v1" as const,
      routeRevision: route.revision,
      connectionId: resolved.connection.id,
      connectionRevision: resolved.connection.revision,
      catalogEntryId: resolved.catalogEntry.id,
      catalogRevision: resolved.catalogEntry.revision,
      costPrivacyRevision: resolved.costPrivacy.revision,
      capabilityEvidence: Object.freeze(capabilityIds),
    }),
  });
  return Object.freeze({ route, usedFallback, inspection, ...resolved });
}

async function resolveCatalogTarget(
  dependencies: ModelHubRerankDependencies,
  route: NovelTaskRoute,
  catalogEntryId: string,
  accounting: RerankAccounting,
): Promise<Omit<ResolvedRerankTarget, "route" | "usedFallback" | "inspection">> {
  const connections = await dependencies.modelHub.listConnections();
  let connection: ModelProviderConnection | null = null;
  let catalogEntry: ModelCatalogEntry | null = null;
  for (const candidate of connections) {
    const found = (await dependencies.modelHub.listCatalog(candidate.id)).find(
      ({ id }) => id === catalogEntryId,
    );
    if (found !== undefined) {
      connection = candidate;
      catalogEntry = found;
      break;
    }
  }
  if (connection === null || catalogEntry === null) {
    throw executionError(
      "MODEL_HUB_RERANK_TARGET_MISSING",
      "检索重排分工引用的模型已不存在。",
      true,
    );
  }
  if (connection.providerKind !== "alibaba_qwen") {
    throw executionError(
      "MODEL_HUB_RERANK_PROTOCOL_UNSUPPORTED",
      "当前只实现了阿里云百炼 Qwen 的官方文本重排协议。",
    );
  }
  if (connection.connectionStatus !== "ready" || !connection.enabled) {
    throw executionError(
      "MODEL_HUB_RERANK_CONNECTION_NOT_READY",
      "阿里云百炼连接尚未通过测试。",
      true,
    );
  }
  const now = dependencies.clock.now();
  if (
    catalogEntry.availability !== "available" ||
    catalogEntry.lifecycle === "deprecated" ||
    (catalogEntry.staleAfter !== null && catalogEntry.staleAfter <= now)
  ) {
    throw executionError(
      "MODEL_HUB_RERANK_MODEL_UNAVAILABLE",
      "检索重排模型当前不可用或目录已过期。",
      true,
    );
  }
  const capabilityEvidence = await dependencies.modelHub.listCapabilityEvidence(catalogEntry.id);
  if (
    resolveModelCapabilityVerdict({
      catalogEntryId: catalogEntry.id,
      capability: "rerank",
      evidence: capabilityEvidence,
      now,
    }) !== "supported"
  ) {
    throw executionError(
      "MODEL_HUB_RERANK_CAPABILITY_NOT_VERIFIED",
      "该模型没有可用证据证明支持检索重排。",
    );
  }
  const credential = await dependencies.credentials
    .getSummary(modelHubCredentialProviderId(connection))
    .catch(() => ({ configured: false }));
  if (!credential.configured) {
    throw executionError(
      "MODEL_HUB_RERANK_CREDENTIAL_MISSING",
      "阿里云百炼连接缺少可用 API Key。",
      true,
    );
  }
  const costPrivacy = await dependencies.modelHub.findCostPrivacyProfile(catalogEntry.id);
  if (
    costPrivacy?.dataDestination !== "remote" ||
    costPrivacy.evidenceSource === "unknown" ||
    costPrivacy.retentionPolicy === "unknown" ||
    costPrivacy.trainingPolicy === "unknown"
  ) {
    throw executionError(
      "MODEL_HUB_RERANK_PRIVACY_UNVERIFIED",
      "远程数据去向、保留或训练政策尚未确认，未发送候选片段。",
    );
  }

  enforceRouteLimits(route, catalogEntry, accounting);
  const estimatedCostMicros = calculateInputCost(costPrivacy, accounting.estimatedInputTokens);
  enforceCostCeiling(route, costPrivacy, estimatedCostMicros);
  const baseUrl = qwenBeijingRerankBaseUrl(connection);
  return Object.freeze({
    connection: connection as ModelProviderConnection & { readonly providerKind: "alibaba_qwen" },
    catalogEntry,
    costPrivacy,
    capabilityEvidence: Object.freeze([...capabilityEvidence]),
    baseUrl,
    estimatedInputTokens: accounting.estimatedInputTokens,
    estimatedCostMicros,
  });
}

function qwenBeijingRerankBaseUrl(connection: ModelProviderConnection): string {
  if (connection.region !== "china_beijing") {
    throw executionError(
      "MODEL_HUB_RERANK_REGION_UNSUPPORTED",
      "当前真实协议适配只覆盖阿里云百炼北京地域；其他地域不会推断端点。",
    );
  }
  const workspaceId = connection.workspaceId?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,254}$/u.test(workspaceId)) {
    throw executionError(
      "MODEL_HUB_RERANK_WORKSPACE_REQUIRED",
      "北京地域文本重排需要有效的 Workspace ID。",
    );
  }
  return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-api/v1`;
}

function validateAndEstimateInput(input: ModelHubRerankInput): RerankAccounting {
  if (
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(input.query) ||
    !Array.isArray(input.documents) ||
    input.documents.length < 1 ||
    input.documents.length > MAX_DOCUMENTS ||
    !Number.isSafeInteger(input.topN) ||
    input.topN < 1 ||
    input.topN > input.documents.length
  ) {
    throw executionError("MODEL_HUB_RERANK_REQUEST_INVALID", "检索重排输入无效。");
  }
  const encoder = new TextEncoder();
  const queryBytes = encoder.encode(input.query).length;
  if (queryBytes > MAX_QUERY_BYTES) {
    throw executionError("MODEL_HUB_RERANK_REQUEST_INVALID", "检索问题过长。");
  }
  let totalBytes = queryBytes;
  let documentBytes = 0;
  for (const document of input.documents) {
    if (
      typeof document !== "string" ||
      document.length === 0 ||
      CONTROL_CHARACTER_PATTERN.test(document)
    ) {
      throw executionError(
        "MODEL_HUB_RERANK_REQUEST_INVALID",
        "候选资料包含空内容或不支持的控制字符。",
      );
    }
    const bytes = encoder.encode(document).length;
    if (bytes > MAX_DOCUMENT_BYTES) {
      throw executionError("MODEL_HUB_RERANK_REQUEST_INVALID", "单条候选资料过长。");
    }
    documentBytes += bytes;
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw executionError("MODEL_HUB_RERANK_REQUEST_INVALID", "候选资料总量过大。");
    }
  }
  // The official request accounting repeats the query for each document. UTF-8
  // bytes form a conservative local upper estimate without tokenizing content.
  const estimatedInputTokens = queryBytes * input.documents.length + documentBytes + 1_024;
  return Object.freeze({
    estimatedInputTokens,
    totalBytes,
    documentCount: input.documents.length,
  });
}

function enforceRouteLimits(
  route: NovelTaskRoute,
  catalogEntry: ModelCatalogEntry,
  accounting: RerankAccounting,
): void {
  const maximumInputs = optionalPositiveInteger(route.parameterPolicy.maximumInputs, MAX_DOCUMENTS);
  if (maximumInputs !== null && accounting.documentCount > maximumInputs) {
    throw executionError("MODEL_HUB_RERANK_INPUT_LIMIT_EXCEEDED", "候选资料数量超过任务上限。");
  }
  const maximumInputTokens = optionalPositiveInteger(
    route.parameterPolicy.maximumInputTokens,
    MAX_ESTIMATED_TOKENS,
  );
  if (
    (maximumInputTokens !== null && accounting.estimatedInputTokens > maximumInputTokens) ||
    (catalogEntry.inputTokenLimit !== null &&
      accounting.estimatedInputTokens > catalogEntry.inputTokenLimit)
  ) {
    throw executionError(
      "MODEL_HUB_RERANK_INPUT_LIMIT_EXCEEDED",
      "候选资料超过任务或模型输入上限。",
    );
  }
}

function optionalPositiveInteger(value: unknown, maximum: number): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw executionError("MODEL_HUB_RERANK_PARAMETER_POLICY_INVALID", "检索重排参数上限无效。");
  }
  return value as number;
}

function calculateInputCost(profile: ModelCostPrivacyProfile, tokens: number): string | null {
  if (profile.currency === null || profile.inputMicrosPerMillionTokens === null) {
    return null;
  }
  return String(
    (BigInt(tokens) * BigInt(profile.inputMicrosPerMillionTokens) + 999_999n) / 1_000_000n,
  );
}

function enforceCostCeiling(
  route: NovelTaskRoute,
  profile: ModelCostPrivacyProfile,
  estimatedCostMicros: string | null,
): void {
  if (route.maximumCostMicros === null) {
    return;
  }
  if (
    route.currency === null ||
    profile.currency === null ||
    route.currency !== profile.currency ||
    estimatedCostMicros === null
  ) {
    throw executionError("MODEL_HUB_RERANK_COST_UNVERIFIABLE", "计价证据不足，无法确认费用上限。");
  }
  if (BigInt(estimatedCostMicros) > BigInt(route.maximumCostMicros)) {
    throw executionError("MODEL_HUB_RERANK_COST_LIMIT_EXCEEDED", "预计费用超过检索重排任务上限。");
  }
}

function requireSameFingerprint(
  expected: ModelHubRerankInspection,
  actual: ModelHubRerankInspection,
): void {
  if (JSON.stringify(expected.fingerprintMaterial) !== JSON.stringify(actual.fingerprintMaterial)) {
    throw executionError(
      "MODEL_HUB_RERANK_CONFIGURATION_CHANGED",
      "检索排序配置或能力信息在发送期间发生变化，本次结果不会进入写作资料。",
      true,
    );
  }
}

function normalizeRerankError(cause: unknown, dispatched: boolean): ModelHubExecutionError {
  if (cause instanceof ModelHubExecutionError) {
    return new ModelHubExecutionError(
      cause.code,
      cause.message,
      cause.retryable,
      dispatched || cause.dispatched,
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
      dispatched ? "远程检索排序请求失败，已保留本地排序。" : "远程检索排序发送前检查未通过。",
      "retryable" in cause && cause.retryable === true,
      dispatched,
    );
  }
  return executionError(
    dispatched ? "MODEL_HUB_RERANK_PROVIDER_FAILED" : "MODEL_HUB_RERANK_PREFLIGHT_FAILED",
    dispatched ? "远程检索排序请求失败，已保留本地排序。" : "远程检索排序发送前检查未通过。",
    dispatched,
    dispatched,
  );
}

function safeSkipMessage(code: string): string {
  if (code === "MODEL_HUB_RERANK_REMOTE_CONSENT_REQUIRED") {
    return "远程重排未启用；候选片段没有离开本机，继续使用本地确定性复核。";
  }
  if (
    code === "MODEL_HUB_RERANK_REGION_UNSUPPORTED" ||
    code === "MODEL_HUB_RERANK_WORKSPACE_REQUIRED"
  ) {
    return "当前连接不满足已验证的百炼北京地域 Workspace 协议，继续使用本地确定性复核。";
  }
  return `远程重排不可用（${code}），继续使用本地确定性复核。`;
}

function executionError(
  code: string,
  message: string,
  retryable = false,
  dispatched = false,
): ModelHubExecutionError {
  return new ModelHubExecutionError(code, message, retryable, dispatched);
}
