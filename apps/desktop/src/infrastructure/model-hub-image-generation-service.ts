import type { Clock, UuidV7Generator } from "@inkshadow/domain";

import { getModelProviderPreset, isLoopbackModelBaseUrl } from "./model-hub-provider-registry";
import { ModelHubExecutionError } from "./model-hub-execution-service";
import {
  assertModelHubFinalDispatchUnchanged,
  ModelHubFinalDispatchError,
  modelHubFinalDispatchIdentity,
} from "./model-hub-final-dispatch-guard";
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
  NativeImageDestinationReceipt,
  NativeImageFileReceipt,
  NativeImageGenerationGateway,
} from "./native-image-generation-gateway";
import {
  modelHubCredentialProviderId,
  modelHubNativeEndpointConfig,
} from "./model-hub-native-config";

const IMAGE_TASK = "image_generation" as const;
const MAXIMUM_PROMPT_CHARACTERS = 1_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface ModelHubImageGenerationDependencies {
  readonly modelHub: ModelHubStore;
  readonly imageGateway: NativeImageGenerationGateway;
  readonly credentials: Readonly<{
    getSummary(
      providerId: string,
    ): Promise<Readonly<{ configured: boolean; lastFour?: string | null }>>;
  }>;
  readonly ids: Pick<UuidV7Generator, "next">;
  readonly clock: Clock;
}

export interface ModelHubImageGenerationInspection {
  readonly task: "image_generation";
  readonly connectionId: string;
  readonly connectionDisplayName: string;
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderConnection["providerKind"];
  readonly modelId: string;
  readonly dataDestination: "local" | "remote";
  readonly retentionPolicy: ModelCostPrivacyProfile["retentionPolicy"];
  readonly trainingPolicy: ModelCostPrivacyProfile["trainingPolicy"];
  readonly privacyEvidenceSource: ModelCostPrivacyProfile["evidenceSource"];
  readonly capabilityEvidence: readonly Readonly<{
    id: string;
    source: ModelCapabilityEvidence["evidenceSource"];
    version: string;
    observedAt: string;
    expiresAt: string | null;
  }>[];
  readonly pricingNotice: "per_image_price_not_modeled";
  readonly maximumPromptCharacters: number;
  readonly outputFormat: "png";
  readonly usedFallback: boolean;
  /**
   * Immutable confirmation identity for the exact route, model, credential
   * slot, privacy policy, data destination and cost policy shown to the user.
   */
  readonly confirmationFingerprint: string;
}

export interface GenerateModelHubImageInput {
  readonly prompt: string;
  readonly destination: NativeImageDestinationReceipt;
  readonly acknowledgedCostAndPrivacy: boolean;
  readonly expectedConfirmationFingerprint: string;
}

export interface ModelHubImageGenerationReceipt {
  readonly file: NativeImageFileReceipt;
  readonly invocation: ModelInvocationFact;
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderConnection["providerKind"];
  readonly modelId: string;
  readonly usedFallback: boolean;
}

interface ResolvedImageTarget {
  readonly connection: ModelProviderConnection;
  readonly catalogEntry: ModelCatalogEntry;
  readonly privacy: ModelCostPrivacyProfile;
  readonly evidence: readonly ModelCapabilityEvidence[];
  readonly credentialIdentity: Readonly<{
    providerId: string;
    configured: boolean;
    lastFour: string | null;
  }>;
}

interface ResolvedImagePlan {
  readonly route: NovelTaskRoute;
  readonly target: ResolvedImageTarget;
  readonly usedFallback: boolean;
}

export class ModelHubImageGenerationService {
  public constructor(private readonly dependencies: ModelHubImageGenerationDependencies) {}

  public async inspect(prompt?: string): Promise<ModelHubImageGenerationInspection> {
    const plan = await resolvePlan(this.dependencies);
    return createInspectionFromPlan(
      plan,
      this.dependencies.clock.now(),
      prompt === undefined ? null : validatePrompt(prompt),
    );
  }

  public chooseDestination(): Promise<NativeImageDestinationReceipt | null> {
    if (!this.dependencies.imageGateway.available) {
      throw executionError("MODEL_HUB_GATEWAY_UNAVAILABLE", "图片生成与本地保存只在桌面版可用。");
    }
    return this.dependencies.imageGateway.chooseDestination();
  }

  public async generate(
    input: GenerateModelHubImageInput,
  ): Promise<ModelHubImageGenerationReceipt> {
    const prompt = validatePrompt(input.prompt);
    if (!input.acknowledgedCostAndPrivacy) {
      throw executionError(
        "MODEL_HUB_IMAGE_CONSENT_REQUIRED",
        "请先确认图片提示会发送到所选模型，并可能产生供应商费用。",
      );
    }
    validateDestinationReceipt(input.destination);
    const expectedConfirmationFingerprint = validateConfirmationFingerprint(
      input.expectedConfirmationFingerprint,
    );
    const { route, target, usedFallback } = await resolvePlan(this.dependencies);
    await assertImageConfirmationMatches(
      expectedConfirmationFingerprint,
      {
        route,
        target,
        usedFallback,
      },
      prompt,
    );
    const expectedDispatchIdentity = modelHubFinalDispatchIdentity({
      route,
      connection: target.connection,
      catalogEntry: target.catalogEntry,
      costPrivacy: target.privacy,
    });

    let invocation = await this.dependencies.modelHub.startInvocation({
      id: this.dependencies.ids.next(),
      task: IMAGE_TASK,
      routeTask: IMAGE_TASK,
      connectionId: target.connection.id,
      catalogEntryId: target.catalogEntry.id,
      providerKindSnapshot: target.connection.providerKind,
      modelIdSnapshot: target.catalogEntry.providerModelId,
      routeReason: usedFallback ? "task_fallback" : "task_primary",
      attempt: usedFallback ? 2 : 1,
      privacyPolicy: route.privacyPolicy,
      dataDestination: target.privacy.dataDestination as "local" | "remote",
      maximumCostMicros: null,
      currency: null,
    });

    let generated: NativeImageFileReceipt;
    let dispatched = false;
    try {
      const current = await resolvePlan(this.dependencies);
      assertModelHubFinalDispatchUnchanged(
        expectedDispatchIdentity,
        modelHubFinalDispatchIdentity({
          route: current.route,
          connection: current.target.connection,
          catalogEntry: current.target.catalogEntry,
          costPrivacy: current.target.privacy,
        }),
      );
      await assertImageConfirmationMatches(expectedConfirmationFingerprint, current, prompt);
      invocation = await this.dependencies.modelHub.markInvocationDispatched({
        id: invocation.id,
        dispatchedAt: this.dependencies.clock.now(),
        expectedRevision: invocation.revision,
      });
      // The durable receipt is the restart boundary: once present, this exact
      // image action must never be automatically sent a second time.
      dispatched = true;
      generated = await this.dependencies.imageGateway.generateToFile({
        destinationTicket: input.destination.ticket,
        config: modelHubNativeEndpointConfig(current.target.connection),
        model: current.target.catalogEntry.providerModelId,
        prompt,
      });
    } catch (cause: unknown) {
      const error = dispatched ? normalizeDispatchedError(cause) : normalizePreDispatchError(cause);
      const ambiguous = dispatched && isAmbiguousTransportFailure(cause, error);
      const projected = ambiguous ? ambiguousImageResult() : error;
      await this.dependencies.modelHub
        .finishInvocation({
          id: invocation.id,
          status: ambiguous ? "timed_out" : "failed",
          errorCode: projected.code,
          errorSummary: ambiguous
            ? "图片请求已发送，但连接在收到明确结果前中断；不会自动重发。"
            : "图片生成或本地保存失败；正文、设定和已有图片均未改变。",
          expectedRevision: invocation.revision,
        })
        .catch(() => undefined);
      throw projected;
    }

    try {
      invocation = await this.dependencies.modelHub.finishInvocation({
        id: invocation.id,
        status: "succeeded",
        inputTokens: generated.usage?.inputTokens ?? null,
        outputTokens: generated.usage?.outputTokens ?? null,
        cachedInputTokens: generated.usage?.cachedInputTokens ?? null,
        estimatedCostMicros: null,
        currency: null,
        expectedRevision: invocation.revision,
      });
    } catch {
      throw new ModelHubExecutionError(
        "MODEL_HUB_INVOCATION_LEDGER_FAILED",
        `图片已保存为 ${generated.fileName}，但模型使用记录未能完成。为避免重复费用，本次不会自动重试。`,
        true,
        true,
      );
    }

    return Object.freeze({
      file: generated,
      invocation,
      connectionId: target.connection.id,
      catalogEntryId: target.catalogEntry.id,
      providerKind: target.connection.providerKind,
      modelId: target.catalogEntry.providerModelId,
      usedFallback,
    });
  }
}

async function resolvePlan(
  dependencies: ModelHubImageGenerationDependencies,
): Promise<ResolvedImagePlan> {
  if (!dependencies.imageGateway.available) {
    throw executionError("MODEL_HUB_GATEWAY_UNAVAILABLE", "图片生成与本地保存只在桌面版可用。");
  }
  const route = await dependencies.modelHub.findTaskRoute(IMAGE_TASK);
  if (!route?.enabled) {
    throw executionError(
      "MODEL_HUB_ROUTE_NOT_CONFIGURED",
      "还没有为图片生成分配模型。请先在创作任务安排中选择经过能力确认的图片模型。",
    );
  }
  if (route.maximumCostMicros !== null || route.currency !== null) {
    throw executionError(
      "MODEL_HUB_COST_CEILING_UNVERIFIABLE",
      "当前版本还不能用统一账本验证每张图片的价格上限。请移除该硬上限，并在生成前查看供应商价格。",
    );
  }

  const now = dependencies.clock.now();
  try {
    return Object.freeze({
      route,
      target: await resolveTarget(dependencies, route, route.primaryCatalogEntryId, now),
      usedFallback: false,
    });
  } catch (cause: unknown) {
    if (route.failurePolicy !== "use_fallback" || route.fallbackCatalogEntryId === null) {
      throw normalizePreDispatchError(cause);
    }
    try {
      return Object.freeze({
        route,
        target: await resolveTarget(dependencies, route, route.fallbackCatalogEntryId, now),
        usedFallback: true,
      });
    } catch {
      throw executionError(
        "MODEL_HUB_PRIMARY_AND_FALLBACK_UNAVAILABLE",
        "主模型和备用模型都不能安全生成图片。请重新同步模型并检查能力、连接和隐私信息。",
        true,
      );
    }
  }
}

async function resolveTarget(
  dependencies: ModelHubImageGenerationDependencies,
  route: NovelTaskRoute,
  catalogEntryId: string,
  now: string,
): Promise<ResolvedImageTarget> {
  let connection: ModelProviderConnection | null = null;
  let catalogEntry: ModelCatalogEntry | null = null;
  for (const candidateConnection of await dependencies.modelHub.listConnections()) {
    const candidate = (await dependencies.modelHub.listCatalog(candidateConnection.id)).find(
      ({ id }) => id === catalogEntryId,
    );
    if (candidate !== undefined) {
      connection = candidateConnection;
      catalogEntry = candidate;
      break;
    }
  }
  if (connection === null || catalogEntry === null) {
    throw executionError(
      "MODEL_HUB_ROUTE_TARGET_MISSING",
      "图片任务引用的模型已不存在。请重新同步模型并更新创作任务安排。",
      true,
    );
  }
  if (
    !connection.enabled ||
    (connection.connectionStatus !== "ready" && connection.connectionStatus !== "degraded")
  ) {
    throw executionError(
      "MODEL_HUB_CONNECTION_NOT_READY",
      "图片模型的供应商连接当前不可用。请先测试连接。",
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
      "图片模型已不可用、已弃用或目录信息过期。请重新同步模型。",
      true,
    );
  }
  const evidence = await dependencies.modelHub.listCapabilityEvidence(catalogEntry.id);
  if (
    resolveModelCapabilityVerdict({
      catalogEntryId: catalogEntry.id,
      capability: IMAGE_TASK,
      evidence,
      now,
    }) !== "supported"
  ) {
    throw executionError(
      "MODEL_HUB_CAPABILITY_NOT_VERIFIED",
      "所选模型没有足够证据证明支持图片生成。请先确认能力或换用其他模型。",
      true,
    );
  }
  if (getModelProviderPreset(connection.providerKind).protocol !== "openai_compatible") {
    throw executionError(
      "MODEL_HUB_IMAGE_PROTOCOL_UNSUPPORTED",
      "当前图片闭环只支持实现 OpenAI 图片接口的连接。其他协议不会被伪装成可用。",
    );
  }
  const preset = getModelProviderPreset(connection.providerKind);
  const credentialProviderId = modelHubCredentialProviderId(connection);
  const credentialSummary = await dependencies.credentials
    .getSummary(credentialProviderId)
    .catch(() => ({ configured: false, lastFour: null }));
  if (
    (preset.credentialRequired || connection.credentialState === "present") &&
    !credentialSummary.configured
  ) {
    throw executionError(
      "MODEL_HUB_CREDENTIAL_MISSING",
      "图片模型缺少可用凭据。请在设置中重新保存 API Key。",
      true,
    );
  }
  const privacy = await dependencies.modelHub.findCostPrivacyProfile(catalogEntry.id);
  if (
    privacy === null ||
    privacy.dataDestination === "unknown" ||
    privacy.evidenceSource === "unknown"
  ) {
    throw executionError(
      "MODEL_HUB_DATA_DESTINATION_UNKNOWN",
      "图片提示的数据去向还没有可靠记录。请先在模型设置中确认隐私信息。",
    );
  }
  if (
    route.privacyPolicy === "local_only" &&
    (privacy.dataDestination !== "local" || !isLoopbackModelBaseUrl(connection.baseUrl))
  ) {
    throw executionError(
      "MODEL_HUB_PRIVACY_BLOCKED",
      "图片任务只允许本机处理，墨影不会把提示发送到云端模型。",
    );
  }
  return Object.freeze({
    connection,
    catalogEntry,
    privacy,
    evidence: Object.freeze([...evidence]),
    credentialIdentity: Object.freeze({
      providerId: credentialProviderId,
      configured: credentialSummary.configured,
      lastFour: typeof credentialSummary.lastFour === "string" ? credentialSummary.lastFour : null,
    }),
  });
}

async function createInspectionFromPlan(
  plan: ResolvedImagePlan,
  now: string,
  confirmedPrompt: string | null,
): Promise<ModelHubImageGenerationInspection> {
  const { target } = plan;
  return Object.freeze({
    task: IMAGE_TASK,
    connectionId: target.connection.id,
    connectionDisplayName: target.connection.displayName,
    catalogEntryId: target.catalogEntry.id,
    providerKind: target.connection.providerKind,
    modelId: target.catalogEntry.providerModelId,
    dataDestination: target.privacy.dataDestination as "local" | "remote",
    retentionPolicy: target.privacy.retentionPolicy,
    trainingPolicy: target.privacy.trainingPolicy,
    privacyEvidenceSource: target.privacy.evidenceSource,
    capabilityEvidence: Object.freeze(
      target.evidence
        .filter(
          ({ capability, verdict, expiresAt }) =>
            capability === IMAGE_TASK &&
            verdict === "supported" &&
            (expiresAt === null || expiresAt > now),
        )
        .map(({ id, evidenceSource, evidenceVersion, observedAt, expiresAt }) =>
          Object.freeze({
            id,
            source: evidenceSource,
            version: evidenceVersion,
            observedAt,
            expiresAt,
          }),
        ),
    ),
    pricingNotice: "per_image_price_not_modeled",
    maximumPromptCharacters: MAXIMUM_PROMPT_CHARACTERS,
    outputFormat: "png",
    usedFallback: plan.usedFallback,
    confirmationFingerprint: await imageConfirmationFingerprint(plan, confirmedPrompt),
  });
}

async function assertImageConfirmationMatches(
  expected: string,
  current: ResolvedImagePlan,
  confirmedPrompt: string,
): Promise<void> {
  if ((await imageConfirmationFingerprint(current, confirmedPrompt)) !== expected) {
    throw executionError(
      "MODEL_HUB_IMAGE_CONFIRMATION_STALE",
      "图片模型、连接、凭据、数据去向、隐私或费用规则已发生变化。请重新检查并再次确认后生成。",
      true,
    );
  }
}

async function imageConfirmationFingerprint(
  plan: ResolvedImagePlan,
  confirmedPrompt: string | null,
): Promise<string> {
  const { route, target } = plan;
  const canonical = JSON.stringify({
    version: 1,
    task: IMAGE_TASK,
    dispatchIdentity: modelHubFinalDispatchIdentity({
      route,
      connection: target.connection,
      catalogEntry: target.catalogEntry,
      costPrivacy: target.privacy,
    }),
    usedFallback: plan.usedFallback,
    maximumCostMicros: route.maximumCostMicros,
    currency: route.currency,
    routeOrigin: route.routeOrigin,
    presetId: route.presetId,
    parameterPolicy: route.parameterPolicy,
    dataDestination: target.privacy.dataDestination,
    retentionPolicy: target.privacy.retentionPolicy,
    trainingPolicy: target.privacy.trainingPolicy,
    privacyEvidenceSource: target.privacy.evidenceSource,
    privacyEvidenceVersion: target.privacy.evidenceVersion,
    privacyRevision: target.privacy.revision,
    credentialIdentity: target.credentialIdentity,
    capabilityEvidence: [...target.evidence]
      .filter(({ capability, verdict }) => capability === IMAGE_TASK && verdict === "supported")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, evidenceSource, evidenceVersion, observedAt, expiresAt }) => ({
        id,
        evidenceSource,
        evidenceVersion,
        observedAt,
        expiresAt,
      })),
    outputFormat: "png",
    pricingNotice: "per_image_price_not_modeled",
    confirmedPrompt,
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function validateConfirmationFingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw executionError(
      "MODEL_HUB_IMAGE_CONFIRMATION_STALE",
      "生成确认已失效。请重新检查图片模型、费用与数据去向后再次确认。",
      true,
    );
  }
  return value;
}

function validatePrompt(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAXIMUM_PROMPT_CHARACTERS ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw executionError(
      "MODEL_HUB_REQUEST_INVALID",
      "图片描述不能为空、不能包含控制字符，并且最多 1000 个字符。",
    );
  }
  return normalized;
}

function validateDestinationReceipt(value: NativeImageDestinationReceipt): void {
  if (
    !/^[a-f0-9]{64}$/iu.test(value.ticket) ||
    value.fileName.length < 5 ||
    value.fileName.length > 255 ||
    !value.fileName.toLowerCase().endsWith(".png") ||
    value.fileName.includes("/") ||
    value.fileName.includes("\\")
  ) {
    throw executionError(
      "MODEL_IMAGE_DESTINATION_INVALID",
      "保存位置凭据无效或已经过期，请重新选择 PNG 文件。",
    );
  }
}

function normalizePreDispatchError(cause: unknown): ModelHubExecutionError {
  return cause instanceof ModelHubExecutionError
    ? cause
    : cause instanceof ModelHubFinalDispatchError
      ? executionError(cause.code, cause.message, cause.retryable)
      : executionError(
          "MODEL_HUB_PREFLIGHT_FAILED",
          "图片生成前检查没有通过。请检查创作任务安排、能力、连接和隐私信息。",
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
      cause instanceof Error
        ? cause.message
        : "图片生成或保存失败，正文、设定和已有图片都没有改变。",
      "retryable" in cause && cause.retryable === true,
      true,
    );
  }
  return new ModelHubExecutionError(
    "MODEL_HUB_IMAGE_GENERATION_FAILED",
    "图片生成或保存失败，正文、设定和已有图片都没有改变。",
    true,
    true,
  );
}

function isAmbiguousTransportFailure(cause: unknown, normalized: ModelHubExecutionError): boolean {
  const diagnostics = isRecord(cause) && isRecord(cause.diagnostics) ? cause.diagnostics : null;
  const httpStatus =
    diagnostics !== null &&
    typeof diagnostics.httpStatus === "number" &&
    Number.isSafeInteger(diagnostics.httpStatus)
      ? diagnostics.httpStatus
      : null;
  return (
    httpStatus === null && /(?:NETWORK|TIMEOUT|DNS|TLS|TRANSPORT|DISCONNECT)/u.test(normalized.code)
  );
}

function ambiguousImageResult(): ModelHubExecutionError {
  return new ModelHubExecutionError(
    "PROVIDER_RESULT_AMBIGUOUS",
    "图片请求已发送，但连接在收到明确结果前中断。结果可能已由服务端生成；为避免重复费用，本次不会自动重发。",
    false,
    true,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function executionError(code: string, message: string, retryable = false): ModelHubExecutionError {
  return new ModelHubExecutionError(code, message, retryable, false);
}
