export const MODEL_PROVIDER_KINDS = [
  "openai",
  "deepseek",
  "zhipu_glm",
  "alibaba_qwen",
  "volcengine_doubao",
  "google_gemini",
  "anthropic_claude",
  "ollama",
  "custom_openai_compatible",
] as const;

export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

export const MODEL_HUB_CAPABILITIES = [
  "text_generation",
  "reasoning",
  "structured_output",
  "embedding",
  "rerank",
  "image_generation",
  "vision",
  "translation",
  "tool_calling",
  "token_counting",
  "streaming",
  "long_context",
] as const;

export type ModelHubCapability = (typeof MODEL_HUB_CAPABILITIES)[number];

export const NOVEL_AI_TASKS = [
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
  "embedding",
  "rerank",
  "image_generation",
  "vision_understanding",
  "translation",
] as const;

export type NovelAiTask = (typeof NOVEL_AI_TASKS)[number];

export const MODEL_HUB_SCHEMES = [
  "smart",
  "quality",
  "economy",
  "local_privacy",
  "custom",
] as const;

export type ModelHubScheme = (typeof MODEL_HUB_SCHEMES)[number];

export type ModelProviderProtocol = "openai_compatible" | "anthropic" | "gemini" | "ollama";
export type ModelHubAuthenticationMode = "none" | "bearer_keyring" | "custom_header_keyring";
export type ProviderFieldVisibility = "basic" | "expert";
export type ProviderFieldStorage = "metadata" | "credential_vault";
export type ProviderFieldInput = "text" | "secret" | "url" | "select" | "toggle" | "number";

export interface ProviderFieldCondition {
  readonly field: string;
  readonly equals?: string;
  readonly oneOf?: readonly string[];
}

export interface ProviderFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface ProviderFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly input: ProviderFieldInput;
  readonly required: boolean;
  readonly visibility: ProviderFieldVisibility;
  readonly storage: ProviderFieldStorage;
  readonly placeholder?: string;
  readonly options?: readonly ProviderFieldOption[];
  readonly condition?: ProviderFieldCondition;
}

export type ModelDiscoveryStrategy =
  "openai_models" | "anthropic_models" | "gemini_models" | "ollama_tags" | "preset_and_manual";

export interface ProviderModelDiscovery {
  readonly strategy: ModelDiscoveryStrategy;
  readonly method: "GET";
  readonly path: string | null;
  readonly automatic: boolean;
  readonly capabilityMetadata: boolean;
}

export interface ModelProviderPreset {
  readonly id: ModelProviderKind;
  readonly displayName: string;
  readonly shortDescription: string;
  readonly protocol: ModelProviderProtocol;
  readonly credentialRequired: boolean;
  readonly defaultBaseUrl: string | null;
  readonly basicFields: readonly ProviderFieldDefinition[];
  readonly expertFields: readonly ProviderFieldDefinition[];
  readonly modelDiscovery: ProviderModelDiscovery;
  /** Provider-supported controls used only by the fixed, content-free text probe. */
  readonly textCapabilityProbe?: Readonly<{
    readonly reasoningMode: "disabled";
  }>;
  /** Provider-supported controls for tasks whose output is author-visible prose. */
  readonly visibleProse?: Readonly<{
    readonly reasoningMode: "disabled";
  }>;
  readonly officialDocsUrl: string;
}

export interface ModelProviderTextCapabilityProbePolicy {
  readonly maxOutputTokens: 64;
  readonly reasoningMode: "disabled" | null;
}

export interface ModelProviderVisibleProsePolicy {
  readonly reasoningMode: "disabled" | null;
}

export interface ProviderEndpointMetadata {
  readonly region?: string | null | undefined;
  readonly workspaceId?: string | null | undefined;
  readonly baseUrlOverride?: string | null | undefined;
}

const API_KEY_FIELD: ProviderFieldDefinition = Object.freeze({
  key: "apiKey",
  label: "API Key",
  description: "只保存在系统凭据库，不写入 InkShadow 数据库或日志。",
  input: "secret",
  required: true,
  visibility: "basic",
  storage: "credential_vault",
  placeholder: "输入供应商提供的 API Key",
});

const BASE_URL_OVERRIDE_FIELD: ProviderFieldDefinition = Object.freeze({
  key: "baseUrlOverride",
  label: "Base URL",
  description: "仅在代理、私有网关或供应商端点发生变化时覆盖默认值。",
  input: "url",
  required: false,
  visibility: "expert",
  storage: "metadata",
});

const REQUEST_TIMEOUT_FIELD: ProviderFieldDefinition = Object.freeze({
  key: "requestTimeoutMs",
  label: "请求超时",
  description: "连接级超时上限；小说任务仍可使用各自的任务预设。",
  input: "number",
  required: false,
  visibility: "expert",
  storage: "metadata",
  placeholder: "30000",
});

const RETRY_LIMIT_FIELD: ProviderFieldDefinition = Object.freeze({
  key: "retryLimit",
  label: "重试次数",
  description: "只重试连接测试和模型目录读取；生成、Embedding、Rerank 与图片不会自动重试。",
  input: "number",
  required: false,
  visibility: "expert",
  storage: "metadata",
  placeholder: "0",
});

const CUSTOM_AUTHENTICATION_FIELD: ProviderFieldDefinition = Object.freeze({
  key: "authenticationMode",
  label: "认证方式",
  description: "可选择无认证、Bearer，或一个自定义认证 Header；凭据值始终只保存在系统凭据库。",
  input: "select",
  required: false,
  visibility: "expert",
  storage: "metadata",
  options: [
    { value: "none", label: "无认证" },
    { value: "bearer_keyring", label: "Bearer（系统凭据库）" },
    { value: "custom_header_keyring", label: "单一自定义认证 Header（系统凭据库）" },
  ],
});

const CUSTOM_CREDENTIAL_HEADER_NAME_FIELD: ProviderFieldDefinition = Object.freeze({
  key: "credentialHeaderName",
  label: "认证 Header 名称",
  description: "只保存 Header 名称；Header 值使用上方同一份系统凭据，不会写入数据库或日志。",
  input: "text",
  required: false,
  visibility: "expert",
  storage: "metadata",
  placeholder: "x-api-key",
  condition: { field: "authenticationMode", equals: "custom_header_keyring" },
});

const STANDARD_EXPERT_FIELDS = Object.freeze([
  BASE_URL_OVERRIDE_FIELD,
  REQUEST_TIMEOUT_FIELD,
  RETRY_LIMIT_FIELD,
]);

const QWEN_REGIONS = Object.freeze([
  { value: "china_beijing", label: "中国（北京）" },
  { value: "singapore", label: "新加坡" },
  { value: "japan_tokyo", label: "日本（东京）" },
  { value: "germany_frankfurt", label: "德国（法兰克福）" },
  { value: "us_virginia", label: "美国（弗吉尼亚）" },
] satisfies readonly ProviderFieldOption[]);

const PROVIDER_PRESETS: readonly ModelProviderPreset[] = Object.freeze([
  freezePreset({
    id: "openai",
    displayName: "OpenAI",
    shortDescription: "使用 OpenAI 官方 API，连接后自动同步当前账号可用模型。",
    protocol: "openai_compatible",
    credentialRequired: true,
    defaultBaseUrl: "https://api.openai.com/v1",
    basicFields: [API_KEY_FIELD],
    expertFields: [
      {
        key: "organizationId",
        label: "Organization ID",
        description: "只有账号明确要求指定组织时才填写。",
        input: "text",
        required: false,
        visibility: "expert",
        storage: "metadata",
      },
      {
        key: "projectId",
        label: "Project ID",
        description: "只有需要固定到某个 OpenAI 项目时才填写。",
        input: "text",
        required: false,
        visibility: "expert",
        storage: "metadata",
      },
      ...STANDARD_EXPERT_FIELDS,
    ],
    modelDiscovery: {
      strategy: "openai_models",
      method: "GET",
      path: "/models",
      automatic: true,
      capabilityMetadata: false,
    },
    officialDocsUrl: "https://developers.openai.com/api/reference/resources/models/methods/list",
  }),
  freezePreset({
    id: "deepseek",
    displayName: "DeepSeek",
    shortDescription: "使用 DeepSeek 官方 API，通过模型目录同步当前可用模型。",
    protocol: "openai_compatible",
    credentialRequired: true,
    defaultBaseUrl: "https://api.deepseek.com",
    basicFields: [API_KEY_FIELD],
    expertFields: STANDARD_EXPERT_FIELDS,
    modelDiscovery: {
      strategy: "openai_models",
      method: "GET",
      path: "/models",
      automatic: true,
      capabilityMetadata: false,
    },
    textCapabilityProbe: { reasoningMode: "disabled" },
    visibleProse: { reasoningMode: "disabled" },
    officialDocsUrl: "https://api-docs.deepseek.com/api/list-models/",
  }),
  freezePreset({
    id: "zhipu_glm",
    displayName: "智谱 GLM",
    shortDescription:
      "使用智谱开放平台的 OpenAI 兼容接口；模型由用户从账户当前可用目录中选择，不在客户端写死。",
    protocol: "openai_compatible",
    credentialRequired: true,
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    basicFields: [API_KEY_FIELD],
    expertFields: STANDARD_EXPERT_FIELDS,
    modelDiscovery: {
      strategy: "preset_and_manual",
      method: "GET",
      path: null,
      automatic: false,
      capabilityMetadata: false,
    },
    officialDocsUrl: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
  }),
  freezePreset({
    id: "alibaba_qwen",
    displayName: "阿里云百炼 / Qwen",
    shortDescription: "按地域连接百炼；模型目录以供应商目录、预设证据和用户选择共同确认。",
    protocol: "openai_compatible",
    credentialRequired: true,
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    basicFields: [
      API_KEY_FIELD,
      {
        key: "region",
        label: "地域",
        description: "API Key、可用模型和计费会因地域不同而变化。",
        input: "select",
        required: true,
        visibility: "basic",
        storage: "metadata",
        options: QWEN_REGIONS,
      },
      {
        key: "workspaceId",
        label: "Workspace ID",
        description: "新加坡可选；日本和德国地域必须填写。填写后使用对应 Workspace 的专属端点。",
        input: "text",
        required: false,
        visibility: "basic",
        storage: "metadata",
        condition: { field: "region", oneOf: ["singapore", "japan_tokyo", "germany_frankfurt"] },
      },
    ],
    expertFields: STANDARD_EXPERT_FIELDS,
    modelDiscovery: {
      strategy: "preset_and_manual",
      method: "GET",
      path: null,
      automatic: false,
      capabilityMetadata: false,
    },
    officialDocsUrl: "https://help.aliyun.com/en/model-studio/what-is-model-studio",
  }),
  freezePreset({
    id: "volcengine_doubao",
    displayName: "火山方舟 / 豆包",
    shortDescription: "连接火山方舟在线推理端点；不将某个豆包模型永久绑定到小说任务。",
    protocol: "openai_compatible",
    credentialRequired: true,
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    basicFields: [
      API_KEY_FIELD,
      {
        key: "endpointId",
        label: "Endpoint ID",
        description: "只有已创建专属推理接入点时才填写。",
        input: "text",
        required: false,
        visibility: "basic",
        storage: "metadata",
      },
    ],
    expertFields: STANDARD_EXPERT_FIELDS,
    modelDiscovery: {
      strategy: "preset_and_manual",
      method: "GET",
      path: null,
      automatic: false,
      capabilityMetadata: false,
    },
    officialDocsUrl: "https://www.volcengine.com/docs/82379",
  }),
  freezePreset({
    id: "google_gemini",
    displayName: "Google Gemini",
    shortDescription: "使用 Gemini API，并读取模型目录提供的支持方法和上下文元数据。",
    protocol: "gemini",
    credentialRequired: true,
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    basicFields: [API_KEY_FIELD],
    expertFields: STANDARD_EXPERT_FIELDS,
    modelDiscovery: {
      strategy: "gemini_models",
      method: "GET",
      path: "/models",
      automatic: true,
      capabilityMetadata: true,
    },
    officialDocsUrl: "https://ai.google.dev/api/models",
  }),
  freezePreset({
    id: "anthropic_claude",
    displayName: "Anthropic Claude",
    shortDescription: "使用 Claude API，通过模型列表获取当前账号可用模型。",
    protocol: "anthropic",
    credentialRequired: true,
    defaultBaseUrl: "https://api.anthropic.com/v1",
    basicFields: [API_KEY_FIELD],
    expertFields: [
      {
        key: "apiVersion",
        label: "Anthropic API 版本",
        description: "默认由供应商预设维护，只有兼容性排查时才覆盖。",
        input: "text",
        required: false,
        visibility: "expert",
        storage: "metadata",
      },
      ...STANDARD_EXPERT_FIELDS,
    ],
    modelDiscovery: {
      strategy: "anthropic_models",
      method: "GET",
      path: "/models",
      automatic: true,
      capabilityMetadata: false,
    },
    officialDocsUrl: "https://platform.claude.com/docs/en/api/models/list",
  }),
  freezePreset({
    id: "ollama",
    displayName: "Ollama",
    shortDescription: "默认仅连接本机 Ollama，模型目录来自本地安装结果。",
    protocol: "ollama",
    credentialRequired: false,
    defaultBaseUrl: "http://127.0.0.1:11434",
    basicFields: [],
    expertFields: [BASE_URL_OVERRIDE_FIELD, REQUEST_TIMEOUT_FIELD],
    modelDiscovery: {
      strategy: "ollama_tags",
      method: "GET",
      path: "/api/tags",
      automatic: true,
      capabilityMetadata: false,
    },
    officialDocsUrl: "https://docs.ollama.com/api/tags",
  }),
  freezePreset({
    id: "custom_openai_compatible",
    displayName: "自定义 OpenAI-compatible",
    shortDescription: "连接自建网关或兼容服务；所有高级连接项都由用户明确控制。",
    protocol: "openai_compatible",
    credentialRequired: false,
    defaultBaseUrl: null,
    basicFields: [
      {
        key: "baseUrlOverride",
        label: "Base URL",
        description: "兼容服务公开的 HTTPS 根地址；本机地址可以使用 HTTP。",
        input: "url",
        required: true,
        visibility: "basic",
        storage: "metadata",
      },
      {
        ...API_KEY_FIELD,
        required: false,
        description: "如果服务需要认证，此值只保存在系统凭据库。",
      },
    ],
    expertFields: [
      {
        key: "modelDiscoveryPath",
        label: "模型列表路径",
        description: "默认尝试 /models；留空时允许手动添加模型。",
        input: "text",
        required: false,
        visibility: "expert",
        storage: "metadata",
        placeholder: "/models",
      },
      {
        key: "textGenerationPath",
        label: "文本生成路径",
        description: "默认 /chat/completions；只支持绝对 API 路径。",
        input: "text",
        required: false,
        visibility: "expert",
        storage: "metadata",
        placeholder: "/chat/completions",
      },
      {
        key: "embeddingPath",
        label: "Embedding 路径",
        description: "默认 /embeddings；只支持绝对 API 路径。",
        input: "text",
        required: false,
        visibility: "expert",
        storage: "metadata",
        placeholder: "/embeddings",
      },
      CUSTOM_AUTHENTICATION_FIELD,
      CUSTOM_CREDENTIAL_HEADER_NAME_FIELD,
      REQUEST_TIMEOUT_FIELD,
      RETRY_LIMIT_FIELD,
    ],
    modelDiscovery: {
      strategy: "openai_models",
      method: "GET",
      path: "/models",
      automatic: true,
      capabilityMetadata: false,
    },
    officialDocsUrl: "https://developers.openai.com/api/reference/resources/models/methods/list",
  }),
]);

const PRESET_BY_ID = new Map(PROVIDER_PRESETS.map((preset) => [preset.id, preset]));

export function listModelProviderPresets(): readonly ModelProviderPreset[] {
  return PROVIDER_PRESETS;
}

export function getModelProviderPreset(provider: ModelProviderKind): ModelProviderPreset {
  const preset = PRESET_BY_ID.get(provider);
  if (preset === undefined) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_UNKNOWN",
      `Unknown Model Hub provider: ${provider}`,
    );
  }
  return preset;
}

export function modelProviderTextCapabilityProbePolicy(
  provider: ModelProviderKind,
): ModelProviderTextCapabilityProbePolicy {
  return Object.freeze({
    maxOutputTokens: 64,
    reasoningMode: getModelProviderPreset(provider).textCapabilityProbe?.reasoningMode ?? null,
  });
}

export function modelProviderVisibleProsePolicy(
  provider: ModelProviderKind,
): ModelProviderVisibleProsePolicy {
  return Object.freeze({
    reasoningMode: getModelProviderPreset(provider).visibleProse?.reasoningMode ?? null,
  });
}

export function isModelProviderKind(value: unknown): value is ModelProviderKind {
  return typeof value === "string" && (MODEL_PROVIDER_KINDS as readonly string[]).includes(value);
}

export function isModelHubCapability(value: unknown): value is ModelHubCapability {
  return typeof value === "string" && (MODEL_HUB_CAPABILITIES as readonly string[]).includes(value);
}

export function isNovelAiTask(value: unknown): value is NovelAiTask {
  return typeof value === "string" && (NOVEL_AI_TASKS as readonly string[]).includes(value);
}

/** Privacy classification must follow the resolved endpoint, never the provider label. */
export function isLoopbackModelBaseUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

export function resolveProviderBaseUrl(
  provider: ModelProviderKind,
  metadata: ProviderEndpointMetadata = {},
): string {
  const override = normalizeOptional(metadata.baseUrlOverride);
  if (override !== null) {
    return validateBaseUrl(
      override,
      provider === "ollama" || provider === "custom_openai_compatible",
    );
  }

  if (provider !== "alibaba_qwen") {
    const fallback = getModelProviderPreset(provider).defaultBaseUrl;
    if (fallback === null) {
      throw new ModelProviderRegistryError(
        "MODEL_PROVIDER_ENDPOINT_REQUIRED",
        "A base URL is required for a custom OpenAI-compatible provider.",
      );
    }
    return fallback;
  }

  const region = normalizeOptional(metadata.region) ?? "china_beijing";
  const workspaceId = normalizeOptional(metadata.workspaceId);
  switch (region) {
    case "china_beijing":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    case "us_virginia":
      return "https://dashscope-us.aliyuncs.com/compatible-mode/v1";
    case "singapore":
      return workspaceId === null
        ? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        : workspaceEndpoint(workspaceId, "ap-southeast-1");
    case "japan_tokyo":
      return workspaceEndpoint(workspaceId, "ap-northeast-1");
    case "germany_frankfurt":
      return workspaceEndpoint(workspaceId, "eu-central-1");
    default:
      throw new ModelProviderRegistryError(
        "MODEL_PROVIDER_REGION_INVALID",
        "The selected Alibaba Cloud Model Studio region is not supported by this preset version.",
      );
  }
}

export class ModelProviderRegistryError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelProviderRegistryError";
  }
}

export const MODEL_HUB_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MODEL_HUB_MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MODEL_HUB_MAX_REQUEST_TIMEOUT_MS = 600_000;
export const MODEL_HUB_MAX_RETRY_LIMIT = 3;

const HTTP_HEADER_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const FORBIDDEN_CREDENTIAL_HEADER_NAMES = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "expect",
  "forwarded",
  "host",
  "keep-alive",
  "origin",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "via",
]);

/** Validates an OpenAI-compatible API path without ever resolving an authority or query. */
export function normalizeModelHubApiPath(
  value: string | null | undefined,
  fieldLabel = "API path",
): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (
    value !== value.trim() ||
    value.length > 1_024 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.includes("%") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_API_PATH_INVALID",
      `${fieldLabel} must be an absolute path without an authority, query, fragment, escape, or traversal segment.`,
    );
  }
  return value;
}

/** Only the non-secret name is returned; a credential value is never accepted here. */
export function normalizeCredentialHeaderName(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value !== value.trim() || value.length > 128 || !HTTP_HEADER_TOKEN_PATTERN.test(value)) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_CREDENTIAL_HEADER_INVALID",
      "The credential Header name is invalid.",
    );
  }
  const normalized = value.toLowerCase();
  if (
    FORBIDDEN_CREDENTIAL_HEADER_NAMES.has(normalized) ||
    normalized.startsWith("proxy-") ||
    normalized.startsWith("sec-") ||
    normalized.startsWith("x-forwarded-")
  ) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_CREDENTIAL_HEADER_FORBIDDEN",
      "That Header name cannot be used for model authentication.",
    );
  }
  return normalized;
}

export function normalizeModelHubRequestTimeoutMs(value: number | undefined): number {
  const normalized = value ?? MODEL_HUB_DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < MODEL_HUB_MIN_REQUEST_TIMEOUT_MS ||
    normalized > MODEL_HUB_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_TIMEOUT_INVALID",
      `Request timeout must be between ${String(MODEL_HUB_MIN_REQUEST_TIMEOUT_MS)} and ${String(MODEL_HUB_MAX_REQUEST_TIMEOUT_MS)} milliseconds.`,
    );
  }
  return normalized;
}

export function normalizeModelHubRetryLimit(value: number | undefined): number {
  const normalized = value ?? 0;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > MODEL_HUB_MAX_RETRY_LIMIT
  ) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_RETRY_LIMIT_INVALID",
      `Retry limit must be between 0 and ${String(MODEL_HUB_MAX_RETRY_LIMIT)}.`,
    );
  }
  return normalized;
}

function freezePreset(preset: ModelProviderPreset): ModelProviderPreset {
  return Object.freeze({
    ...preset,
    basicFields: Object.freeze(preset.basicFields.map((field) => Object.freeze({ ...field }))),
    expertFields: Object.freeze(preset.expertFields.map((field) => Object.freeze({ ...field }))),
    modelDiscovery: Object.freeze({ ...preset.modelDiscovery }),
    ...(preset.textCapabilityProbe === undefined
      ? {}
      : { textCapabilityProbe: Object.freeze({ ...preset.textCapabilityProbe }) }),
  });
}

function workspaceEndpoint(workspaceId: string | null, regionCode: string): string {
  if (workspaceId === null || !/^[A-Za-z0-9][A-Za-z0-9-]{0,254}$/.test(workspaceId)) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_WORKSPACE_REQUIRED",
      "A valid Workspace ID is required for the selected Alibaba Cloud Model Studio region.",
    );
  }
  return `https://${workspaceId}.${regionCode}.maas.aliyuncs.com/compatible-mode/v1`;
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim() === "") {
    return null;
  }
  return value.trim();
}

function validateBaseUrl(value: string, localHttpAllowed: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_ENDPOINT_INVALID",
      "The provider base URL is invalid.",
    );
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_ENDPOINT_INVALID",
      "The provider base URL cannot contain credentials, query parameters, or fragments.",
    );
  }
  const local = isLoopbackModelBaseUrl(parsed.toString());
  if (parsed.protocol !== "https:" && !(localHttpAllowed && local && parsed.protocol === "http:")) {
    throw new ModelProviderRegistryError(
      "MODEL_PROVIDER_ENDPOINT_INSECURE",
      "Remote provider endpoints must use HTTPS; HTTP is allowed only for a local service.",
    );
  }
  return parsed.toString().replace(/\/$/u, "");
}
