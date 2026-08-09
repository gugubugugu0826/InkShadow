import { inspectModelHubTextTask } from "./model-hub-execution-service";
import {
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
  modelHubTextCapabilityProbeFailureMetadata,
  runModelHubTextCapabilityProbe,
} from "./model-hub-text-capability-probe";
import type {
  ModelCatalogEntry,
  ModelHubConnectionCommit,
  ModelProviderConnection,
  NovelTaskRoute,
  SaveModelProviderConnectionInput,
} from "./model-hub-store";
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

export class QuickModelConnectionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = true,
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
      "这条已保存连接属于另一家供应商。请到完整 Model Hub 中检查后再试。",
      false,
    );
  }

  const submittedSecret =
    input.secret !== undefined && input.secret.length > 0 ? input.secret : undefined;
  const manualModelId = resolveManualModelId(input, preset.modelDiscovery.automatic);
  if (submittedSecret !== undefined) validateSecret(submittedSecret);
  let credentialConfigured = false;
  if (preset.credentialRequired) {
    if (submittedSecret === undefined) {
      const credentialProviderId =
        existing === null ? connectionId : modelHubCredentialProviderId(existing);
      const summary = await runtime.credentials.getSummary(credentialProviderId).catch(() => ({
        configured: false,
      }));
      credentialConfigured = summary.configured;
    }
    if (submittedSecret === undefined && !credentialConfigured) {
      throw quickError(
        "QUICK_MODEL_CREDENTIAL_REQUIRED",
        "请填写 API Key。它只会保存到 Windows 凭据管理器，不会写入墨影数据库。",
        false,
      );
    }
  }

  const refreshQuickEndpointMetadata =
    existing !== null && shouldRefreshQuickEndpointMetadata(existing, input);
  const storedEndpoint =
    existing === null || refreshQuickEndpointMetadata
      ? quickEndpointConfig(connectionId, input, submittedSecret !== undefined)
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
  const credentialProviderId =
    submittedSecret === undefined ? null : `quick-key-${runtime.ids.next()}`;
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
    }
    const listed = await inspectQuickEndpoint(runtime, endpoint, input.provider, manualModelId);
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
        "模型目录没有安全保存。请重试；已有项目和正文不会受到影响。",
      );
    }
    if (published.commit !== null) {
      await cleanupPublishedCredential(runtime, published.commit);
    }
    return Object.freeze({
      connection: published.connection,
      catalog: Object.freeze([...availableCatalog]),
      reusedCredential: preset.credentialRequired && submittedSecret === undefined,
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
        "Windows 凭据管理器没有确认待验证凭据已保存。原有 API Key 没有被改动。",
      );
    }
  } catch (cause: unknown) {
    throw cause instanceof QuickModelConnectionError
      ? cause
      : quickError(
          "QUICK_MODEL_STAGING_CREDENTIAL_FAILED",
          "无法准备待验证连接凭据。原有 API Key 没有被改动，请检查 Windows 凭据管理器后重试。",
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
  providerKind: ModelProviderKind,
  manualModelId: string | null,
): Promise<NativeModelListResponse> {
  if (manualModelId !== null) {
    await runModelHubTextCapabilityProbe({
      gateway: runtime.modelGateway,
      providerKind,
      generationId: runtime.ids.next(),
      config: endpoint,
      model: manualModelId,
    });
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
  input: Readonly<{ connectionId: string; catalogEntryId: string }>,
): Promise<QuickBookStartRouteResult> {
  assertDesktopGateway(runtime);
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
  const expectedDispatchIdentity = modelHubFinalDispatchIdentity({ connection, catalogEntry });

  const metadataScanId = runtime.ids.next();
  await runtime.modelHub.recordCapabilityScan({
    scanId: metadataScanId,
    catalogEntryId: catalogEntry.id,
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

  const probeScanId = runtime.ids.next();
  try {
    const currentConnection = await runtime.modelHub.findConnection(connection.id);
    const currentCatalogEntry =
      currentConnection === null
        ? undefined
        : (await runtime.modelHub.listCatalog(currentConnection.id)).find(
            ({ id }) => id === catalogEntry.id,
          );
    if (currentConnection === null || currentCatalogEntry === undefined) {
      throw quickError(
        "QUICK_MODEL_CONFIGURATION_CHANGED",
        "连接或模型在探测前发生变化，请重新选择后重试。",
      );
    }
    assertModelHubFinalDispatchUnchanged(
      expectedDispatchIdentity,
      modelHubFinalDispatchIdentity({
        connection: currentConnection,
        catalogEntry: currentCatalogEntry,
      }),
    );
    const generated = await runModelHubTextCapabilityProbe({
      gateway: runtime.modelGateway,
      providerKind: currentConnection.providerKind,
      generationId: runtime.ids.next(),
      config: modelHubNativeEndpointConfig(currentConnection),
      model: currentCatalogEntry.providerModelId,
    });
    await runtime.modelHub.recordCapabilityScan({
      scanId: probeScanId,
      catalogEntryId: catalogEntry.id,
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
              "固定能力探针已返回可见文字，但响应以输出上限结束；文本生成能力已确认，未保存探针输出。",
            failure: generated.partialFailure,
          }),
    });
  } catch (cause: unknown) {
    const normalized = normalizeQuickError(cause, connection.providerKind);
    await runtime.modelHub
      .recordCapabilityScan({
        scanId: probeScanId,
        catalogEntryId: catalogEntry.id,
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
    await restoreRoute(runtime, previousRoute, route).catch(() => undefined);
    throw normalizeQuickError(cause, connection.providerKind);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MODEL_HUB_READINESS_CHANGED_EVENT));
  }
  return Object.freeze({ connection, catalogEntry, route });
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
  const exact = connections.find(({ id }) => id === input.provider);
  if (exact !== undefined) return exact.id;
  return (
    connections.find(({ providerKind }) => providerKind === input.provider)?.id ?? input.provider
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

function assertDesktopGateway(runtime: DesktopRuntime): void {
  if (runtime.mode !== "tauri") {
    throw quickError(
      "QUICK_MODEL_DESKTOP_REQUIRED",
      "浏览器预览不能保存 API Key 或连接本机模型。你可以先跳过，桌面版中再连接。",
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
      "API Key 格式无效。请重新从供应商控制台复制完整 Key。",
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
        ? "请填写火山方舟控制台中的模型或 Endpoint ID。"
        : "这个供应商不会可靠返回完整模型目录，请填写账号中实际可用的模型 ID。",
      false,
    );
  }
  if (
    normalized !== null &&
    (normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized))
  ) {
    throw quickError(
      "QUICK_MODEL_ID_INVALID",
      "模型或 Endpoint ID 格式无效，请从供应商控制台重新复制。",
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
  if (/AUTH|CREDENTIAL|UNAUTHORIZED|FORBIDDEN|401|403/u.test(code)) {
    return quickError(
      code,
      "认证没有通过。请检查 API Key 是否完整、有效，并确认账号有模型访问权限。",
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
      : "连接或模型检查没有成功。请检查 Key、网络和账号权限后重试。",
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

function quickError(code: string, message: string, retryable = true): QuickModelConnectionError {
  return new QuickModelConnectionError(code, message, retryable);
}
