import { inspectModelHubTextTask } from "./model-hub-execution-service";
import {
  ModelHubFinalDispatchError,
  assertModelHubFinalDispatchUnchanged,
  modelHubFinalDispatchIdentity,
} from "./model-hub-final-dispatch-guard";
import { recoverModelHubCredentialCommitForConnection } from "./model-hub-credential-commit-recovery";
import {
  ModelHubCredentialReferenceError,
  modelHubCredentialProviderId,
  modelHubCredentialRef,
  modelHubNativeEndpointConfig,
} from "./model-hub-native-config";
import {
  MODEL_HUB_CAPABILITIES,
  getModelProviderPreset,
  isLoopbackModelBaseUrl,
  resolveProviderBaseUrl,
  type ModelProviderKind,
} from "./model-hub-provider-registry";
import { MODEL_HUB_READINESS_CHANGED_EVENT } from "./model-hub-readiness";
import {
  executeAuditedModelHubTextCapabilityProbe,
  modelHubCapabilityProbeSupportId,
  modelHubTextCapabilityProbeFailureMetadata,
} from "./model-hub-text-capability-probe";
import {
  recommendModelHubCapabilityProbeKind,
  type ModelHubCapabilityProbeKind,
} from "./model-hub-capability-probe-kind";
import {
  isAutomaticPureTextOpeningCandidateEligible,
  resolveModelCapabilityVerdict,
} from "./model-hub-router";
import {
  isRetiredModelProviderConnection,
  type ModelCatalogEntry,
  type ModelInvocationFact,
  type ModelHubConnectionCommit,
  type ModelProviderConnection,
  type NovelTaskRoute,
  type SaveModelProviderConnectionInput,
} from "./model-hub-store";
import {
  providerActionFingerprint,
  type ProviderActionDisclosure,
} from "./provider-action-disclosure";
import type { DesktopRuntime, NativeModelEndpointConfig, NativeModelListResponse } from "./runtime";

export const QUICK_MODEL_PROVIDERS = [
  "deepseek",
  "openai",
  "alibaba_qwen",
  "volcengine_doubao",
  "ollama",
  "zhipu_glm",
  "custom_openai_compatible",
] as const;

export type QuickModelProvider = (typeof QUICK_MODEL_PROVIDERS)[number];

export interface QuickModelConnectionInput {
  readonly provider: QuickModelProvider;
  readonly connectionId?: string;
  readonly secret?: string;
  readonly region?: string;
  readonly workspaceId?: string;
  readonly endpointId?: string;
  readonly baseUrlOverride?: string;
  readonly manualModelId?: string;
  readonly discoveredCredentialId?: string;
}

export interface QuickModelConnectionResult {
  readonly connection: ModelProviderConnection;
  readonly catalog: readonly ModelCatalogEntry[];
  readonly reusedCredential: boolean;
}

export interface QuickBookStartRouteResult {
  readonly connection: ModelProviderConnection;
  readonly catalogEntry: ModelCatalogEntry;
  readonly route: NovelTaskRoute;
}

export interface QuickBookStartProbeDisclosure extends ProviderActionDisclosure {
  readonly invocationId: string;
  readonly targetSnapshot: Readonly<{
    connection: ModelProviderConnection;
    catalogEntry: ModelCatalogEntry;
  }>;
  readonly probeKind: "fixed_content_free_text_capability";
  readonly maximumOutputTokens: 64;
}

export interface ConfigureQuickBookStartRouteInput {
  readonly connectionId: string;
  readonly catalogEntryId: string;
  readonly targetSnapshot: Readonly<{
    connection: ModelProviderConnection;
    catalogEntry: ModelCatalogEntry;
  }>;
  readonly invocationId: string;
  readonly humanConfirmed: boolean;
  readonly disclosureFingerprint: string;
}

export type QuickModelConnectionFailureStage =
  "connection" | "probe_preparation" | "probe_dispatch" | "probe_result";

export class QuickModelConnectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = true,
    public readonly supportId: string | null = null,
    public readonly failureStage: QuickModelConnectionFailureStage | null = null,
    public readonly providerDispatchCount: 0 | 1 | "unknown" = "unknown",
  ) {
    super(message);
    this.name = "QuickModelConnectionError";
  }
}

/**
 * Writes a newly entered key to an isolated, journalled vault slot, proves the
 * real endpoint, then atomically publishes connection metadata and catalog.
 * The previous ready connection remains untouched until that SQLite commit.
 */
export async function connectQuickModelProvider(
  runtime: DesktopRuntime,
  input: QuickModelConnectionInput,
): Promise<QuickModelConnectionResult> {
  assertDesktopGateway(runtime);
  const preset = getModelProviderPreset(input.provider);
  const connectionId = await resolveConnectionId(runtime, input);
  await recoverConnectionCommit(runtime, connectionId);
  const existing = await runtime.modelHub.findConnection(connectionId);
  if (existing !== null && existing.providerKind !== input.provider) {
    throw quickError(
      "QUICK_MODEL_CONNECTION_CONFLICT",
      "这条已保存连接属于另一家供应商。请到模型中心检查后再试。",
      false,
    );
  }

  const submittedSecret =
    input.secret !== undefined && input.secret.length > 0 ? input.secret : undefined;
  const discoveredCredentialId =
    input.discoveredCredentialId !== undefined && input.discoveredCredentialId.trim().length > 0
      ? input.discoveredCredentialId.trim()
      : undefined;
  if (submittedSecret !== undefined && discoveredCredentialId !== undefined) {
    throw quickError(
      "QUICK_MODEL_CREDENTIAL_CHOICE_CONFLICT",
      "请只选择一种接口密钥：使用本机已保存密钥，或输入新的替换密钥。",
      false,
    );
  }
  const manualModelId = resolveManualModelId(input, preset.modelDiscovery.automatic);
  if (submittedSecret !== undefined) validateSecret(submittedSecret);
  let credentialConfigured = false;
  if (preset.credentialRequired) {
    if (submittedSecret === undefined && discoveredCredentialId === undefined) {
      const credentialProviderId =
        existing === null ? connectionId : modelHubCredentialProviderId(existing);
      const summary = await runtime.credentials.getSummary(credentialProviderId).catch(() => ({
        configured: false,
      }));
      credentialConfigured = summary.configured;
    }
    if (
      submittedSecret === undefined &&
      discoveredCredentialId === undefined &&
      !credentialConfigured
    ) {
      throw quickError(
        "QUICK_MODEL_CREDENTIAL_REQUIRED",
        "请填写接口密钥。它只会保存到 Windows 凭据管理器，不会写入墨影数据库。",
        false,
      );
    }
  }

  const hasPreparedCredential =
    submittedSecret !== undefined || discoveredCredentialId !== undefined;
  const refreshQuickEndpointMetadata =
    existing !== null && shouldRefreshQuickEndpointMetadata(existing, input);
  const storedEndpoint =
    existing === null || refreshQuickEndpointMetadata
      ? quickEndpointConfig(connectionId, input, hasPreparedCredential)
      : modelHubNativeEndpointConfig(
          submittedSecret === undefined
            ? existing
            : {
                ...existing,
                credentialRef: modelHubCredentialRef(connectionId),
                credentialState: "present",
              },
        );
  const commitId = runtime.ids.next();
  const credentialProviderId = hasPreparedCredential ? `quick-key-${runtime.ids.next()}` : null;
  const endpoint = Object.freeze({
    ...storedEndpoint,
    providerId: credentialProviderId ?? storedEndpoint.providerId,
  });
  await runtime.modelHub.prepareConnectionCommit({
    id: commitId,
    connectionId,
    credentialProviderId,
  });
  try {
    if (submittedSecret !== undefined && credentialProviderId !== null) {
      await savePreparedCredential(runtime, credentialProviderId, submittedSecret);
      credentialConfigured = true;
    } else if (discoveredCredentialId !== undefined && credentialProviderId !== null) {
      await reusePreparedCredential(runtime, discoveredCredentialId, credentialProviderId);
      credentialConfigured = true;
    }
    const listed = await inspectQuickEndpoint(runtime, endpoint, manualModelId);
    if (listed.models.length === 0) {
      throw quickError(
        "QUICK_MODEL_CATALOG_EMPTY",
        input.provider === "ollama"
          ? "已连接到 Ollama，但没有找到已安装模型。请先在 Ollama 中安装一个文本模型。"
          : "供应商连接成功，但当前账号没有返回可用模型。请检查账号权限或模型访问范围。",
      );
    }
    const syncId = runtime.ids.next();
    const nextCredentialRef =
      credentialProviderId === null
        ? (existing?.credentialRef ??
          (credentialConfigured ? modelHubCredentialRef(connectionId) : null))
        : modelHubCredentialRef(credentialProviderId);
    const cleanupCredentialProviderId = resolveSupersededCredentialProviderId(
      existing,
      credentialProviderId,
    );
    const published = await runtime.modelHub.publishConnectionCommit({
      id: commitId,
      credentialProviderId,
      cleanupCredentialProviderId,
      connection: connectionCommitInput({
        connectionId,
        input,
        existing,
        presetDisplayName: preset.displayName,
        storedEndpoint,
        credentialConfigured,
        credentialRef: nextCredentialRef,
      }),
      catalog: {
        syncId,
        connectionId,
        source: manualModelId === null ? "provider_api" : "manual",
        status: "succeeded",
        models: listed.models.map((model) => ({
          id: runtime.ids.next(),
          providerModelId: model.id,
          displayName: model.displayName,
        })),
      },
    });
    const availableCatalog = published.catalog.filter(
      ({ availability, lastSyncId }) => availability === "available" && lastSyncId === syncId,
    );
    if (availableCatalog.length === 0) {
      throw quickError(
        "QUICK_MODEL_CATALOG_NOT_SAVED",
        "可用模型列表没有安全保存。请重试；已有项目和正文不会受到影响。",
      );
    }
    if (published.commit !== null) {
      await cleanupPublishedCredential(runtime, published.commit);
    }
    return Object.freeze({
      connection: published.connection,
      catalog: Object.freeze([...availableCatalog]),
      reusedCredential:
        discoveredCredentialId !== undefined ||
        (preset.credentialRequired && submittedSecret === undefined),
    });
  } catch (cause: unknown) {
    const cleanupFailure = await cleanupPreparedConnectionCommit(runtime, connectionId, commitId);
    if (cleanupFailure !== null) throw cleanupFailure;
    throw normalizeQuickError(cause, input.provider);
  }
}

function shouldRefreshQuickEndpointMetadata(
  existing: ModelProviderConnection,
  input: QuickModelConnectionInput,
): boolean {
  if (input.provider === "custom_openai_compatible" && existing.id === input.connectionId) {
    return true;
  }
  if (input.provider === "alibaba_qwen") {
    return input.region !== undefined || input.workspaceId !== undefined;
  }
  if (input.provider === "volcengine_doubao") {
    return input.endpointId !== undefined;
  }
  return input.baseUrlOverride !== undefined;
}

function connectionCommitInput(
  options: Readonly<{
    connectionId: string;
    input: QuickModelConnectionInput;
    existing: ModelProviderConnection | null;
    presetDisplayName: string;
    storedEndpoint: NativeModelEndpointConfig;
    credentialConfigured: boolean;
    credentialRef: string | null;
  }>,
): SaveModelProviderConnectionInput {
  const refresh =
    options.existing !== null &&
    shouldRefreshQuickEndpointMetadata(options.existing, options.input);
  const source = options.existing;
  return Object.freeze({
    id: options.connectionId,
    providerKind: options.input.provider,
    displayName: source?.displayName ?? options.presetDisplayName,
    region:
      source === null || refresh ? normalizeOptionalMetadata(options.input.region) : source.region,
    workspaceId:
      source === null || refresh
        ? normalizeOptionalMetadata(options.input.workspaceId)
        : source.workspaceId,
    endpointId:
      source === null || refresh
        ? normalizeOptionalMetadata(options.input.endpointId)
        : source.endpointId,
    baseUrlOverride: options.storedEndpoint.baseUrl,
    credentialRef: options.credentialRef,
    credentialState: options.credentialConfigured ? "present" : "missing",
    authenticationMode:
      source?.authenticationMode ?? (options.credentialConfigured ? "bearer_keyring" : "none"),
    credentialHeaderName: source?.credentialHeaderName ?? null,
    modelDiscoveryPath: source?.modelDiscoveryPath ?? null,
    textGenerationPath: source?.textGenerationPath ?? null,
    embeddingPath: source?.embeddingPath ?? null,
    requestTimeoutMs: source?.requestTimeoutMs ?? 30_000,
    retryLimit: source?.retryLimit ?? 0,
    legacyProviderId: source?.legacyProviderId ?? null,
    enabled: true,
    expectedRevision: source?.revision ?? null,
  });
}

function resolveSupersededCredentialProviderId(
  existing: ModelProviderConnection | null,
  credentialProviderId: string | null,
): string | null {
  if (
    credentialProviderId === null ||
    existing === null ||
    existing.authenticationMode === "none" ||
    existing.credentialRef === null
  ) {
    return null;
  }
  try {
    const previous = modelHubCredentialProviderId(existing);
    return previous === credentialProviderId ? null : previous;
  } catch (cause: unknown) {
    if (cause instanceof ModelHubCredentialReferenceError) {
      // A newly verified owned slot may repair a historical malformed ref, but
      // the unknown ref must never be interpreted as a vault identifier.
      return null;
    }
    throw cause;
  }
}

async function savePreparedCredential(
  runtime: DesktopRuntime,
  credentialProviderId: string,
  secret: string,
): Promise<void> {
  try {
    const summary = await runtime.credentials.save(credentialProviderId, secret);
    if (!summary.configured) {
      throw quickError(
        "QUICK_MODEL_STAGING_CREDENTIAL_FAILED",
        "Windows 凭据管理器没有确认待验证凭据已保存。原有接口密钥没有被改动。",
      );
    }
  } catch (cause: unknown) {
    throw cause instanceof QuickModelConnectionError
      ? cause
      : quickError(
          "QUICK_MODEL_STAGING_CREDENTIAL_FAILED",
          "无法准备待验证连接凭据。原有接口密钥没有被改动，请检查 Windows 凭据管理器后重试。",
        );
  }
}

async function reusePreparedCredential(
  runtime: DesktopRuntime,
  discoveryId: string,
  credentialProviderId: string,
): Promise<void> {
  if (runtime.credentials.reuseDiscovered === undefined) {
    throw quickError(
      "QUICK_MODEL_DISCOVERED_CREDENTIAL_UNAVAILABLE",
      "当前桌面环境无法安全复用这条本机密钥，请重新检查本机密钥或输入替换密钥。",
    );
  }
  try {
    const summary = await runtime.credentials.reuseDiscovered(discoveryId, credentialProviderId);
    if (!summary.configured) {
      throw quickError(
        "QUICK_MODEL_DISCOVERED_CREDENTIAL_NOT_COPIED",
        "Windows 凭据管理器没有确认本机密钥已准备完成，原有密钥没有被改动。",
      );
    }
  } catch (cause: unknown) {
    throw cause instanceof QuickModelConnectionError
      ? cause
      : quickError(
          "QUICK_MODEL_DISCOVERED_CREDENTIAL_NOT_COPIED",
          "无法安全准备所选本机密钥，原有密钥没有被改动。请重新检查后再试。",
        );
  }
}

async function recoverConnectionCommit(
  runtime: DesktopRuntime,
  connectionId: string,
): Promise<void> {
  if (!(await recoverModelHubCredentialCommitForConnection(runtime, connectionId))) {
    throw quickError(
      "QUICK_MODEL_CONNECTION_RECOVERY_PENDING",
      "上一次连接操作仍有凭据需要安全清理。当前已发布连接不会失效；请检查 Windows 凭据管理器后重试。",
    );
  }
}

async function cleanupPreparedConnectionCommit(
  runtime: DesktopRuntime,
  connectionId: string,
  commitId: string,
): Promise<QuickModelConnectionError | null> {
  const commit = await runtime.modelHub.findConnectionCommit(connectionId).catch(() => null);
  if (commit?.id !== commitId || commit.phase !== "prepared") return null;
  return (await recoverModelHubCredentialCommitForConnection(runtime, connectionId))
    ? null
    : quickError(
        "QUICK_MODEL_STAGING_CLEANUP_FAILED",
        "待验证凭据没有成功清理。正式连接仍保持原状；请重试，墨影会继续完成安全清理。",
        false,
      );
}

async function cleanupPublishedCredential(
  runtime: DesktopRuntime,
  commit: ModelHubConnectionCommit,
): Promise<void> {
  await recoverModelHubCredentialCommitForConnection(runtime, commit.connectionId).catch(
    () => false,
  );
}

async function inspectQuickEndpoint(
  runtime: DesktopRuntime,
  endpoint: NativeModelEndpointConfig,
  manualModelId: string | null,
): Promise<NativeModelListResponse> {
  if (manualModelId !== null) {
    await runtime.modelGateway.checkConnection(endpoint);
    return Object.freeze({
      provider: endpoint.provider,
      models: Object.freeze([Object.freeze({ id: manualModelId, displayName: manualModelId })]),
    });
  }
  const [, listed] = await Promise.all([
    runtime.modelGateway.checkConnection(endpoint),
    runtime.modelGateway.listModels(endpoint),
  ]);
  return listed;
}

/**
 * Resolves the exact non-secret target for the fixed capability probe without
 * dispatching a model request or changing Model Hub state.
 */
export async function inspectQuickBookStartRouteProbe(
  runtime: DesktopRuntime,
  input: Readonly<{ connectionId: string; catalogEntryId: string }>,
): Promise<QuickBookStartProbeDisclosure> {
  assertDesktopGateway(runtime);
  const target = await readQuickBookStartTarget(runtime, input);
  await assertQuickBookStartTextCapability(runtime, target);
  const disclosure = await quickBookStartProbeDisclosure(
    target.connection,
    target.catalogEntry,
    runtime.ids.next(),
  );
  return Object.freeze({ ...disclosure, targetSnapshot: target });
}

/**
 * Uses the persisted opening route as the cross-entry authority. Without a
 * route, automatic selection excludes a visibly experimental visual model;
 * an author can still choose any available model explicitly afterwards.
 */
export async function selectQuickBookStartCatalogEntry(
  runtime: DesktopRuntime,
  result: QuickModelConnectionResult,
): Promise<ModelCatalogEntry | null> {
  const available = await listQuickBookStartTextCatalogEntries(runtime, result);
  const route = await runtime.modelHub.findTaskRoute("book_start_guidance");
  const routed =
    route?.enabled === true
      ? available.find(({ id }) => id === route.primaryCatalogEntryId)
      : undefined;
  if (routed !== undefined) return routed;

  const capabilities = await Promise.all(
    available.map((entry) => runtime.modelHub.listCapabilityEvidence(entry.id)),
  );
  const now = runtime.clock.now();
  return (
    available.find((entry, index) =>
      isAutomaticPureTextOpeningCandidateEligible(
        { catalogEntry: entry, capabilities: capabilities[index] ?? [] },
        now,
      ),
    ) ?? null
  );
}

/**
 * Returns only catalog entries whose text-generation purpose is supported by
 * current capability evidence or exact maintained provider metadata. Unknown
 * and vector-only targets remain connected in Model Hub but cannot enter the
 * quick pure-text opening flow.
 */
export async function listQuickBookStartTextCatalogEntries(
  runtime: DesktopRuntime,
  result: QuickModelConnectionResult,
): Promise<readonly ModelCatalogEntry[]> {
  const available = result.catalog.filter(
    ({ availability, lifecycle }) => availability === "available" && lifecycle !== "deprecated",
  );
  const kinds = await Promise.all(
    available.map((catalogEntry) =>
      resolveQuickBookStartCapabilityKind(runtime, result.connection, catalogEntry),
    ),
  );
  return Object.freeze(
    available.filter((_catalogEntry, index) => kinds[index] === "text_generation"),
  );
}

function quickEndpointConfig(
  providerId: string,
  input: QuickModelConnectionInput,
  hasSubmittedSecret: boolean,
): NativeModelEndpointConfig {
  const preset = getModelProviderPreset(input.provider);
  const protocol = preset.protocol;
  const authentication =
    input.provider === "ollama"
      ? "none"
      : preset.credentialRequired || hasSubmittedSecret
        ? "bearer_keyring"
        : "none";
  return Object.freeze({
    providerId,
    provider: protocol === "openai_compatible" ? "open_ai_compatible" : protocol,
    baseUrl: resolveProviderBaseUrl(input.provider, {
      region: input.region,
      workspaceId: input.workspaceId,
      baseUrlOverride: input.baseUrlOverride,
    }),
    authentication,
    requestTimeoutMs: 30_000,
    retryLimit: 0,
  });
}

/**
 * Proves text generation with a fixed, content-free probe before routing the
 * book-start task. No author text is dispatched by this setup operation.
 */
export async function configureQuickBookStartRoute(
  runtime: DesktopRuntime,
  input: ConfigureQuickBookStartRouteInput,
): Promise<QuickBookStartRouteResult> {
  assertDesktopGateway(runtime);
  if (!input.humanConfirmed || input.disclosureFingerprint.length === 0) {
    throw quickError(
      "QUICK_MODEL_PROBE_CONFIRMATION_REQUIRED",
      "请先查看这次固定验证的模型、发送范围、调用次数和费用说明，再明确确认。",
      false,
    );
  }
  const { connection, catalogEntry } = input.targetSnapshot;
  await assertQuickBookStartTextCapability(runtime, input.targetSnapshot);
  const disclosure = await quickBookStartProbeDisclosure(
    connection,
    catalogEntry,
    input.invocationId,
  );
  if (disclosure.fingerprint !== input.disclosureFingerprint) {
    throw quickError(
      "QUICK_MODEL_PROBE_DISCLOSURE_CHANGED",
      "连接、模型或验证范围已经变化。墨影没有发送请求，请重新查看说明后确认。",
    );
  }
  const expectedDispatchIdentity = modelHubFinalDispatchIdentity({ connection, catalogEntry });
  const probeScanId = runtime.ids.next();
  const probeInvocationId = input.invocationId;
  try {
    const generated = await executeAuditedModelHubTextCapabilityProbe({
      gateway: runtime.modelGateway,
      modelHub: runtime.modelHub,
      clock: runtime.clock,
      providerKind: connection.providerKind,
      generationId: runtime.ids.next(),
      invocationId: probeInvocationId,
      connection,
      catalogEntry,
      config: Object.freeze({ ...modelHubNativeEndpointConfig(connection), retryLimit: 0 }),
      model: catalogEntry.providerModelId,
      assertBeforeProviderDispatch: async () => {
        const finalTarget = await assertCurrentQuickBookStartTarget(
          runtime,
          input,
          expectedDispatchIdentity,
        );
        await runtime.modelHub.recordCapabilityScan({
          scanId: runtime.ids.next(),
          catalogEntryId: finalTarget.catalogEntry.id,
          scanKind: "provider_metadata",
          status: "succeeded",
          evidenceVersion: "quick-provider-catalog-v1",
          evidence: MODEL_HUB_CAPABILITIES.map((capability) => ({
            id: runtime.ids.next(),
            capability,
            verdict: "unknown",
            evidenceSource: "provider_metadata",
            evidenceSummary: "供应商目录没有返回可验证的能力结论。",
          })),
        });
        await assertCurrentQuickBookStartTarget(runtime, input, expectedDispatchIdentity);
      },
    });
    await runtime.modelHub.recordCapabilityScan({
      scanId: probeScanId,
      catalogEntryId: catalogEntry.id,
      modelInvocationId: generated.invocation.id,
      scanKind: "lightweight_probe",
      status: generated.acceptedTruncatedOutput ? "partial" : "succeeded",
      evidenceVersion: "quick-text-probe-v1",
      evidence: [
        {
          id: runtime.ids.next(),
          capability: "text_generation",
          verdict: "supported",
          evidenceSource: "lightweight_probe",
          evidenceSummary: "固定短文本探测成功；未保存探测输入或模型输出。",
        },
        ...(generated.streamed
          ? [
              {
                id: runtime.ids.next(),
                capability: "streaming" as const,
                verdict: "supported" as const,
                evidenceSource: "lightweight_probe" as const,
                evidenceSummary: "固定短文本探测观察到流式增量；未保存增量内容。",
              },
            ]
          : []),
      ],
      ...(generated.partialFailure === null
        ? {}
        : {
            errorCode: "MODEL_OUTPUT_TRUNCATED",
            errorSummary:
              "模型能力检查已返回可见文字，但响应达到输出上限；文字生成能力已确认，未保存检查输出。",
            failure: generated.partialFailure,
          }),
    });
  } catch (cause: unknown) {
    const probeInvocation = await runtime.modelHub
      .findInvocation(probeInvocationId)
      .catch(() => null);
    const normalized = normalizeQuickProbeError(
      cause,
      connection.providerKind,
      probeInvocation,
      probeInvocationId,
      runtime.clock.now(),
    );
    if (
      probeInvocation !== null &&
      (probeInvocation.status === "queued" || probeInvocation.status === "running")
    ) {
      throw normalized;
    }
    if (
      normalized.code === "PROVIDER_RESULT_AMBIGUOUS" ||
      (probeInvocation?.task === "capability_probe" &&
        probeInvocation.status === "timed_out" &&
        probeInvocation.providerDispatchStartedAt !== null)
    ) {
      // A dispatch receipt proves that the Provider may already have completed
      // the fixed probe. Keep the invocation as the sole durable fact so the
      // ordinary capability view can say “结果待核对”; a failed scan would
      // incorrectly turn this into a definite capability failure.
      throw normalized;
    }
    await runtime.modelHub
      .recordCapabilityScan({
        scanId: probeScanId,
        catalogEntryId: catalogEntry.id,
        ...(probeInvocation === null ? {} : { modelInvocationId: probeInvocation.id }),
        scanKind: "lightweight_probe",
        status: "failed",
        evidenceVersion: "quick-text-probe-v1",
        errorCode: normalized.code,
        errorSummary: normalized.message,
        failure: modelHubTextCapabilityProbeFailureMetadata(cause, connection.providerKind),
      })
      .catch(() => undefined);
    throw normalized;
  }

  const local = isLoopbackModelBaseUrl(connection.baseUrl);
  const existingPrivacy = await runtime.modelHub.findCostPrivacyProfile(catalogEntry.id);
  await runtime.modelHub.saveCostPrivacyProfile({
    catalogEntryId: catalogEntry.id,
    dataDestination: local ? "local" : "remote",
    retentionPolicy: local ? "none" : "provider_default",
    trainingPolicy: local ? "not_used" : "unknown",
    evidenceSource: "official_preset",
    evidenceVersion: "quick-connection-v1",
    evidenceSummary: local
      ? "官方 Ollama 预设使用本机回环地址，内容在本机处理。"
      : "官方预设只确认连接目标是供应商云端；留存与训练政策未知，请查看供应商当前政策。",
    expectedRevision: existingPrivacy?.revision ?? null,
  });

  const previousRoute = await runtime.modelHub.findTaskRoute("book_start_guidance");
  const route = await runtime.modelHub.saveTaskRoute({
    task: "book_start_guidance",
    primaryCatalogEntryId: catalogEntry.id,
    fallbackCatalogEntryId: null,
    presetId: null,
    parameterPolicy: Object.freeze({ maximumOutputTokens: 1_200, temperature: 0.85 }),
    maximumCostMicros: null,
    currency: null,
    privacyPolicy: local ? "local_only" : "cloud_allowed",
    failurePolicy: local ? "stop" : "ask_user",
    routeOrigin: "user",
    enabled: true,
    expectedRevision: previousRoute?.revision ?? null,
  });
  try {
    await inspectModelHubTextTask(runtime, {
      task: "book_start_guidance",
      messages: [{ role: "user", content: "连接就绪检查" }],
      maximumOutputTokens: 1_200,
      temperature: 0.85,
    });
  } catch (cause: unknown) {
    try {
      await restoreRoute(runtime, previousRoute, route);
    } catch {
      const authoritativeRoute = await runtime.modelHub
        .findTaskRoute("book_start_guidance")
        .catch(() => undefined);
      if (
        authoritativeRoute === undefined ||
        !routeMatchesExpectedState(authoritativeRoute, previousRoute)
      ) {
        throw quickError(
          "QUICK_MODEL_ROUTE_STATE_REQUIRES_REVIEW",
          "固定验证已经完成，但开书模型设置未能恢复到验证前状态。请先到模型中心核对当前设置；系统不会自动再次验证。",
          false,
        );
      }
    }
    throw normalizeQuickError(cause, connection.providerKind);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MODEL_HUB_READINESS_CHANGED_EVENT));
  }
  return Object.freeze({ connection, catalogEntry, route });
}

async function assertCurrentQuickBookStartTarget(
  runtime: DesktopRuntime,
  input: Readonly<{ connectionId: string; catalogEntryId: string }>,
  expectedIdentity: ReturnType<typeof modelHubFinalDispatchIdentity>,
): Promise<Readonly<{ connection: ModelProviderConnection; catalogEntry: ModelCatalogEntry }>> {
  let current: Awaited<ReturnType<typeof readQuickBookStartTarget>>;
  try {
    current = await readQuickBookStartTarget(runtime, input);
  } catch {
    throw new ModelHubFinalDispatchError();
  }
  assertModelHubFinalDispatchUnchanged(expectedIdentity, modelHubFinalDispatchIdentity(current));
  await assertQuickBookStartTextCapability(runtime, current);
  return current;
}

async function assertQuickBookStartTextCapability(
  runtime: DesktopRuntime,
  target: Readonly<{ connection: ModelProviderConnection; catalogEntry: ModelCatalogEntry }>,
): Promise<void> {
  const kind = await resolveQuickBookStartCapabilityKind(
    runtime,
    target.connection,
    target.catalogEntry,
  );
  if (kind === "text_generation") return;
  const supportId = modelHubCapabilityProbeSupportId({
    id: runtime.ids.next(),
    startedAt: runtime.clock.now(),
  });
  if (kind === "embedding") {
    throw new QuickModelConnectionError(
      "QUICK_MODEL_TEXT_CAPABILITY_MISMATCH",
      "所选模型用于查找相关故事资料，不能作为文字开书模型。本次没有向模型服务发送内容，请选择已确认支持文字生成的模型。",
      false,
      supportId,
      "probe_preparation",
      0,
    );
  }
  throw new QuickModelConnectionError(
    "QUICK_MODEL_TEXT_CAPABILITY_UNKNOWN",
    "所选模型的文字生成能力尚未确认。本次没有向模型服务发送内容，请先到完整模型中心核对能力。",
    false,
    supportId,
    "probe_preparation",
    0,
  );
}

async function resolveQuickBookStartCapabilityKind(
  runtime: DesktopRuntime,
  connection: ModelProviderConnection,
  catalogEntry: ModelCatalogEntry,
): Promise<ModelHubCapabilityProbeKind | null> {
  const evidence = await runtime.modelHub.listCapabilityEvidence(catalogEntry.id);
  const now = runtime.clock.now();
  const textVerdict = resolveModelCapabilityVerdict({
    catalogEntryId: catalogEntry.id,
    capability: "text_generation",
    evidence,
    now,
  });
  if (textVerdict === "unsupported") return null;
  return recommendModelHubCapabilityProbeKind({
    providerKind: connection.providerKind,
    modelId: catalogEntry.providerModelId,
    capabilityEvidence: evidence,
    requestedTask: null,
    now,
  });
}

async function readQuickBookStartTarget(
  runtime: DesktopRuntime,
  input: Readonly<{ connectionId: string; catalogEntryId: string }>,
): Promise<Readonly<{ connection: ModelProviderConnection; catalogEntry: ModelCatalogEntry }>> {
  const connection = await runtime.modelHub.findConnection(input.connectionId);
  if (
    connection === null ||
    !connection.enabled ||
    (connection.connectionStatus !== "ready" && connection.connectionStatus !== "degraded")
  ) {
    throw quickError(
      "QUICK_MODEL_CONNECTION_NOT_READY",
      "这条连接还没有通过验证。请重新测试连接后再选择模型。",
    );
  }
  const catalogEntry = (await runtime.modelHub.listCatalog(connection.id)).find(
    ({ id }) => id === input.catalogEntryId,
  );
  if (catalogEntry?.availability !== "available" || catalogEntry.lifecycle === "deprecated") {
    throw quickError(
      "QUICK_MODEL_NOT_AVAILABLE",
      "所选模型已不在当前可用目录中。请重新连接并选择其他模型。",
    );
  }
  return Object.freeze({ connection, catalogEntry });
}

async function quickBookStartProbeDisclosure(
  connection: ModelProviderConnection,
  catalogEntry: ModelCatalogEntry,
  invocationId: string,
): Promise<Omit<QuickBookStartProbeDisclosure, "targetSnapshot">> {
  const local = isLoopbackModelBaseUrl(connection.baseUrl);
  const authority = Object.freeze({
    schemaVersion: "quick-book-start-probe-disclosure-v2",
    invocationId,
    dispatchIdentity: modelHubFinalDispatchIdentity({ connection, catalogEntry }),
    task: "book_start_guidance_capability_probe",
    probeKind: "fixed_content_free_text_capability",
    maximumOutputTokens: 64,
    maximumProviderCalls: 1,
    automaticRetryCount: 0,
    dataDestination: local ? "local" : "remote",
    estimatedMaximumCostMicros: null,
    currency: null,
  });
  return Object.freeze({
    fingerprint: await providerActionFingerprint(authority),
    invocationId,
    connectionDisplayName: connection.displayName,
    modelId: catalogEntry.providerModelId,
    dataDestination: local ? "local" : "remote",
    privacy: local
      ? "固定验证只发给这台电脑上的模型，不发送作品正文或灵感。"
      : "固定验证会发到所选供应商；不包含作品正文、灵感、设定或凭据。供应商留存与训练政策以其当前条款为准。",
    sends: Object.freeze(["固定短句“只回复：OK”", "AI 最多返回 64 个文字量单位（不是金额）"]),
    maximumProviderCalls: 1,
    automaticRetryCount: 0,
    estimatedMaximumCostMicros: null,
    currency: null,
    probeKind: "fixed_content_free_text_capability",
    maximumOutputTokens: 64,
  });
}

async function resolveConnectionId(
  runtime: DesktopRuntime,
  input: QuickModelConnectionInput,
): Promise<string> {
  if (input.provider === "custom_openai_compatible") {
    const requested = input.connectionId?.trim();
    if (requested === undefined || requested.length === 0 || requested.length > 128) {
      throw quickError(
        "QUICK_MODEL_CONNECTION_ID_REQUIRED",
        "自定义连接缺少独立标识。请关闭连接面板后重新打开再试。",
        false,
      );
    }
    return requested;
  }
  const connections = await runtime.modelHub.listConnections();
  const reusable = connections.filter(
    (connection) =>
      connection.providerKind === input.provider && !isRetiredModelProviderConnection(connection),
  );
  const exact = reusable.find(({ id }) => id === input.provider);
  if (exact !== undefined) return exact.id;
  const requested = input.connectionId?.trim();
  if (requested !== undefined && requested.length > 0) {
    const selected = reusable.find(({ id }) => id === requested);
    if (selected !== undefined) return selected.id;
    throw quickError(
      "QUICK_MODEL_CONNECTION_SELECTION_INVALID",
      "所选连接已变化或不属于当前供应商。没有读取、替换或删除任何接口密钥，请重新选择。",
      false,
    );
  }
  if (reusable.length === 1) return reusable[0]?.id ?? input.provider;
  if (reusable.length > 1) {
    throw quickError(
      "QUICK_MODEL_CONNECTION_SELECTION_REQUIRED",
      "发现多条属于同一供应商的连接，无法安全判断要使用哪一条。没有读取、替换或删除任何接口密钥，请到模型中心明确选择。",
      false,
    );
  }
  const occupied = new Set(connections.map(({ id }) => id));
  if (!occupied.has(input.provider)) return input.provider;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${input.provider}-${String(suffix)}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw quickError(
    "QUICK_MODEL_CONNECTION_ID_EXHAUSTED",
    "无法为新的供应商连接分配本地标识。请到模型中心检查已退役连接。",
    false,
  );
}

async function restoreRoute(
  runtime: DesktopRuntime,
  previous: NovelTaskRoute | null,
  current: NovelTaskRoute,
): Promise<void> {
  if (previous === null) {
    await runtime.modelHub.deleteTaskRoute(current.task, current.revision);
    return;
  }
  await runtime.modelHub.saveTaskRoute({
    task: previous.task,
    primaryCatalogEntryId: previous.primaryCatalogEntryId,
    fallbackCatalogEntryId: previous.fallbackCatalogEntryId,
    presetId: previous.presetId,
    parameterPolicy: previous.parameterPolicy,
    maximumCostMicros: previous.maximumCostMicros,
    currency: previous.currency,
    privacyPolicy: previous.privacyPolicy,
    failurePolicy: previous.failurePolicy,
    routeOrigin: previous.routeOrigin,
    enabled: previous.enabled,
    expectedRevision: current.revision,
  });
}
function routeMatchesExpectedState(
  actual: NovelTaskRoute | null,
  expected: NovelTaskRoute | null,
): boolean {
  const snapshot = (route: NovelTaskRoute | null) =>
    route === null
      ? null
      : JSON.stringify([
          route.task,
          route.primaryCatalogEntryId,
          route.fallbackCatalogEntryId,
          route.presetId,
          route.parameterPolicy,
          route.maximumCostMicros,
          route.currency,
          route.privacyPolicy,
          route.failurePolicy,
          route.routeOrigin,
          route.enabled,
        ]);
  return snapshot(actual) === snapshot(expected);
}

function assertDesktopGateway(runtime: DesktopRuntime): void {
  if (runtime.mode !== "tauri") {
    throw quickError(
      "QUICK_MODEL_DESKTOP_REQUIRED",
      "浏览器预览不能保存接口密钥或连接本机模型。你可以先跳过，桌面版中再连接。",
      false,
    );
  }
  if (!runtime.modelGateway.available) {
    throw quickError(
      "QUICK_MODEL_GATEWAY_UNAVAILABLE",
      "当前桌面环境无法访问模型连接服务。请重新启动墨影后重试。",
    );
  }
}

function validateSecret(secret: string): void {
  if (
    secret.trim().length === 0 ||
    secret.length > 16_384 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(secret)
  ) {
    throw quickError(
      "QUICK_MODEL_CREDENTIAL_INVALID",
      "接口密钥格式无效。请重新从模型服务控制台复制完整密钥。",
      false,
    );
  }
}

function resolveManualModelId(
  input: QuickModelConnectionInput,
  automaticDiscovery: boolean,
): string | null {
  const normalized = normalizeOptionalMetadata(input.manualModelId);
  if (!automaticDiscovery && normalized === null) {
    throw quickError(
      "QUICK_MODEL_ID_REQUIRED",
      input.provider === "volcengine_doubao"
        ? "请填写火山方舟控制台中的模型名称或接入点编号。"
        : "这个服务不会完整列出模型，请填写账号中实际可用的模型名称或编号。",
      false,
    );
  }
  if (
    normalized !== null &&
    (normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized))
  ) {
    throw quickError(
      "QUICK_MODEL_ID_INVALID",
      "模型名称或接入点编号格式无效，请从模型服务控制台重新复制。",
      false,
    );
  }
  return normalized;
}

function normalizeOptionalMetadata(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizeQuickError(
  cause: unknown,
  provider: ModelProviderKind,
): QuickModelConnectionError {
  if (cause instanceof QuickModelConnectionError) return cause;
  const code = safeCauseCode(cause);
  if (code === "PROVIDER_RESULT_AMBIGUOUS") {
    return quickError(
      code,
      "模型能力验证已经发送，但结果无法确认。为避免重复费用，系统不会自动重发。",
      false,
    );
  }
  if (/AUTH|CREDENTIAL|UNAUTHORIZED|FORBIDDEN|401|403/u.test(code)) {
    return quickError(
      code,
      "认证没有通过。请检查接口密钥是否完整、有效，并确认账号有模型访问权限。",
      false,
    );
  }
  if (/TIMEOUT|NETWORK|CONNECT|DNS|OFFLINE/u.test(code)) {
    return quickError(
      code,
      provider === "ollama"
        ? "没有连接到本机 Ollama。请先启动 Ollama 服务，然后重试。"
        : "没有连接到供应商。请检查网络或稍后重试。",
    );
  }
  return quickError(
    code,
    provider === "ollama"
      ? "Ollama 连接或模型检查没有成功。请确认服务已启动并安装了文本模型。"
      : "连接检查未完成。请核对所选模型服务、接口密钥和账号访问权限后再试。",
  );
}

function safeCauseCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/u.test(cause.code)
  ) {
    return cause.code;
  }
  return "QUICK_MODEL_CONNECTION_FAILED";
}

function normalizeQuickProbeError(
  cause: unknown,
  provider: ModelProviderKind,
  invocation: ModelInvocationFact | null,
  plannedInvocationId: string,
  occurredAt: string,
): QuickModelConnectionError {
  const normalized = normalizeQuickError(cause, provider);
  const dispatched = invocation !== null && invocation.providerDispatchStartedAt !== null;
  const supportId = modelHubCapabilityProbeSupportId({
    id: invocation?.id ?? plannedInvocationId,
    startedAt: invocation?.startedAt ?? occurredAt,
  });
  const ambiguous =
    normalized.code === "PROVIDER_RESULT_AMBIGUOUS" ||
    (dispatched &&
      (invocation.status === "timed_out" ||
        invocation.status === "running" ||
        invocation.status === "queued" ||
        invocation.status === "succeeded"));
  if (!dispatched) {
    return new QuickModelConnectionError(
      normalized.code,
      "模型能力检查在本机准备时停止，没有向模型服务发送内容，也不会自动重试；连接和可用模型列表仍然保留。",
      normalized.retryable,
      supportId,
      "probe_preparation",
      0,
    );
  }
  if (ambiguous) {
    return new QuickModelConnectionError(
      "PROVIDER_RESULT_AMBIGUOUS",
      "模型能力检查已向模型服务发送测试内容，但结果无法确认。本次最多发送一次，也不会自动重试。",
      false,
      supportId,
      "probe_result",
      1,
    );
  }
  return new QuickModelConnectionError(
    normalized.code,
    normalized.message + " 本次模型能力检查已发送一次，不会自动重试。",
    normalized.retryable,
    supportId,
    "probe_dispatch",
    1,
  );
}

function quickError(code: string, message: string, retryable = true): QuickModelConnectionError {
  return new QuickModelConnectionError(code, message, retryable);
}
