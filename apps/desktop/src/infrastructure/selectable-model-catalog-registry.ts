import type {
  ModelHubCapability,
  ModelProviderKind,
  NovelAiTask,
} from "./model-hub-provider-registry";

export const SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION = "2026-08-13.v1";
export const SELECTABLE_MODEL_CATALOG_TTL_DAYS = 31;

export type SelectableModelRegionGroup = "DOMESTIC" | "INTERNATIONAL" | "LOCAL";
export type SelectableModelLifecycle = "stable" | "preview" | "deprecated";
export type SelectableModelAppSupport =
  | "routable_after_verification"
  | "protocol_not_implemented"
  | "special_connection_required"
  | "discovery_only";

export interface SelectableModelOfficialSource {
  readonly kind: "official_provider_documentation";
  readonly title: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

/**
 * Maintained discovery metadata, not a Model Hub catalog row. Entries in this
 * registry can never authorize routing or become capability evidence.
 */
export interface SelectableModelCatalogEntry {
  readonly schemaVersion: "inkshadow.selectable-model-catalog-entry.v1";
  readonly registryVersion: string;
  readonly providerKind: ModelProviderKind;
  /** Null is reserved for a provider family that must be discovered live. */
  readonly modelId: string | null;
  readonly displayName: string;
  readonly regionGroup: SelectableModelRegionGroup;
  readonly taskCategories: readonly NovelAiTask[];
  readonly capabilityCategories: readonly ModelHubCapability[];
  readonly tags: readonly string[];
  readonly connectionRequired: true;
  readonly lifecycle: SelectableModelLifecycle;
  readonly appSupport: SelectableModelAppSupport;
  readonly aliases: readonly string[];
  readonly replacementModelId: string | null;
  readonly status: "provider_documented_not_verified";
  readonly routable: false;
  readonly capabilityEvidence: false;
  readonly officialSource: SelectableModelOfficialSource;
}

export type SelectableModelCatalogPublicEntry = Omit<SelectableModelCatalogEntry, "officialSource">;

export type SelectableModelCatalogExpertEntry = SelectableModelCatalogEntry;
export type SelectableModelCatalogProjection =
  SelectableModelCatalogPublicEntry | SelectableModelCatalogExpertEntry;

export interface SelectableModelConnectedCatalogRow {
  readonly providerModelId: string;
}

export interface ConnectedSelectableModelCatalogEntry<
  ConnectedEntry extends SelectableModelConnectedCatalogRow = SelectableModelConnectedCatalogRow,
> {
  readonly providerKind: ModelProviderKind;
  readonly entry: ConnectedEntry;
}

export type MergedSelectableModelCatalogEntry<
  Projected extends SelectableModelCatalogProjection,
  ConnectedEntry extends SelectableModelConnectedCatalogRow = SelectableModelConnectedCatalogRow,
> =
  | Readonly<{
      source: "connected";
      providerKind: ModelProviderKind;
      entry: ConnectedEntry;
    }>
  | Readonly<{
      source: "official_candidate";
      providerKind: ModelProviderKind;
      entry: Projected;
    }>;

const GENERAL_TEXT_TASKS = Object.freeze([
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
] satisfies readonly NovelAiTask[]);

const TEXT_CAPABILITY = Object.freeze(["text_generation"] satisfies readonly ModelHubCapability[]);
const EMBEDDING_TASK = Object.freeze(["embedding"] satisfies readonly NovelAiTask[]);
const EMBEDDING_CAPABILITY = Object.freeze(["embedding"] satisfies readonly ModelHubCapability[]);
const RERANK_TASK = Object.freeze(["rerank"] satisfies readonly NovelAiTask[]);
const RERANK_CAPABILITY = Object.freeze(["rerank"] satisfies readonly ModelHubCapability[]);
const IMAGE_TASK = Object.freeze(["image_generation"] satisfies readonly NovelAiTask[]);
const IMAGE_CAPABILITY = Object.freeze([
  "image_generation",
] satisfies readonly ModelHubCapability[]);
const VISION_TASK = Object.freeze(["vision_understanding"] satisfies readonly NovelAiTask[]);
const VISION_CAPABILITY = Object.freeze(["vision"] satisfies readonly ModelHubCapability[]);

const SOURCES = Object.freeze({
  openai: source("OpenAI model catalog", "https://developers.openai.com/api/docs/models"),
  deepseek: source(
    "DeepSeek models and pricing",
    "https://api-docs.deepseek.com/quick_start/pricing",
  ),
  anthropic_claude: source(
    "Anthropic models overview",
    "https://platform.claude.com/docs/en/about-claude/models/overview",
  ),
  google_gemini: source("Gemini models", "https://ai.google.dev/gemini-api/docs/models"),
  alibaba_qwen: source(
    "Alibaba Cloud Model Studio model catalog",
    "https://help.aliyun.com/en/model-studio/models",
  ),
  zhipu_glm: source(
    "Zhipu GLM model documentation",
    "https://docs.bigmodel.cn/cn/guide/models/text/glm-5",
  ),
  volcengine_doubao: source(
    "Volcengine Seedream documentation",
    "https://www.volcengine.com/docs/82379/1829186",
  ),
});

export const SELECTABLE_MODEL_CATALOG_ENTRIES: readonly SelectableModelCatalogEntry[] =
  Object.freeze([
    ...textEntries("openai", "INTERNATIONAL", SOURCES.openai, [
      ["gpt-5.6-sol", "GPT-5.6 Sol", "stable"],
      ["gpt-5.6-terra", "GPT-5.6 Terra", "stable"],
      ["gpt-5.6-luna", "GPT-5.6 Luna", "stable"],
    ]),
    specializedEntry({
      providerKind: "openai",
      modelId: "text-embedding-3-large",
      displayName: "text-embedding-3-large",
      regionGroup: "INTERNATIONAL",
      taskCategories: EMBEDDING_TASK,
      capabilityCategories: EMBEDDING_CAPABILITY,
      tags: ["embedding"],
      source: SOURCES.openai,
    }),
    specializedEntry({
      providerKind: "openai",
      modelId: "text-embedding-3-small",
      displayName: "text-embedding-3-small",
      regionGroup: "INTERNATIONAL",
      taskCategories: EMBEDDING_TASK,
      capabilityCategories: EMBEDDING_CAPABILITY,
      tags: ["embedding"],
      source: SOURCES.openai,
    }),
    specializedEntry({
      providerKind: "openai",
      modelId: "gpt-image-2",
      displayName: "GPT Image 2",
      regionGroup: "INTERNATIONAL",
      taskCategories: IMAGE_TASK,
      capabilityCategories: IMAGE_CAPABILITY,
      tags: ["image_generation"],
      source: SOURCES.openai,
    }),
    ...textEntries("deepseek", "DOMESTIC", SOURCES.deepseek, [
      ["deepseek-v4-pro", "DeepSeek V4 Pro", "stable"],
      ["deepseek-v4-flash", "DeepSeek V4 Flash", "stable"],
    ]),
    ...textEntries("anthropic_claude", "INTERNATIONAL", SOURCES.anthropic_claude, [
      ["claude-fable-5", "Claude Fable 5", "stable"],
      ["claude-opus-5", "Claude Opus 5", "stable"],
      ["claude-sonnet-5", "Claude Sonnet 5", "stable"],
    ]),
    textEntry({
      providerKind: "anthropic_claude",
      modelId: "claude-haiku-4-5-20251001",
      displayName: "Claude Haiku 4.5",
      regionGroup: "INTERNATIONAL",
      lifecycle: "stable",
      aliases: ["claude-haiku-4-5"],
      source: SOURCES.anthropic_claude,
    }),
    ...textEntries("google_gemini", "INTERNATIONAL", SOURCES.google_gemini, [
      ["gemini-3.6-flash", "Gemini 3.6 Flash", "stable"],
      ["gemini-3.5-flash", "Gemini 3.5 Flash", "stable"],
      ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", "stable"],
      ["gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", "preview"],
    ]),
    specializedEntry({
      providerKind: "google_gemini",
      modelId: "gemini-embedding-2",
      displayName: "Gemini Embedding 2",
      regionGroup: "INTERNATIONAL",
      taskCategories: EMBEDDING_TASK,
      capabilityCategories: EMBEDDING_CAPABILITY,
      tags: ["embedding"],
      source: SOURCES.google_gemini,
    }),
    specializedEntry({
      providerKind: "google_gemini",
      modelId: "gemini-embedding-001",
      displayName: "Gemini Embedding 001",
      regionGroup: "INTERNATIONAL",
      taskCategories: EMBEDDING_TASK,
      capabilityCategories: EMBEDDING_CAPABILITY,
      tags: ["embedding"],
      source: SOURCES.google_gemini,
    }),
    specializedEntry({
      providerKind: "google_gemini",
      modelId: "gemini-3.1-flash-lite",
      displayName: "Gemini 3.1 Flash-Lite",
      regionGroup: "INTERNATIONAL",
      taskCategories: VISION_TASK,
      capabilityCategories: VISION_CAPABILITY,
      tags: ["vision"],
      appSupport: "protocol_not_implemented",
      source: SOURCES.google_gemini,
    }),
    ...[
      ["gemini-3.1-flash-image", "Gemini 3.1 Flash Image"],
      ["gemini-3.1-flash-lite-image", "Gemini 3.1 Flash-Lite Image"],
      ["gemini-3-pro-image", "Gemini 3 Pro Image"],
    ].map(([modelId, displayName]) =>
      specializedEntry({
        providerKind: "google_gemini",
        modelId: modelId ?? "",
        displayName: displayName ?? "",
        regionGroup: "INTERNATIONAL",
        taskCategories: IMAGE_TASK,
        capabilityCategories: IMAGE_CAPABILITY,
        tags: ["image_generation"],
        appSupport: "protocol_not_implemented",
        source: SOURCES.google_gemini,
      }),
    ),
    textEntry({
      providerKind: "alibaba_qwen",
      modelId: "qwen3.8-max",
      displayName: "Qwen3.8 Max",
      regionGroup: "DOMESTIC",
      lifecycle: "stable",
      appSupport: "special_connection_required",
      source: SOURCES.alibaba_qwen,
    }),
    ...textEntries("alibaba_qwen", "DOMESTIC", SOURCES.alibaba_qwen, [
      ["qwen3.7-max", "Qwen3.7 Max", "stable"],
      ["qwen3.7-plus", "Qwen3.7 Plus", "stable"],
    ]),
    textEntry({
      providerKind: "alibaba_qwen",
      modelId: "qwen3.7-flash",
      displayName: "Qwen3.7 Flash",
      regionGroup: "DOMESTIC",
      lifecycle: "stable",
      appSupport: "special_connection_required",
      source: SOURCES.alibaba_qwen,
    }),
    specializedEntry({
      providerKind: "alibaba_qwen",
      modelId: "qwen3.7-text-embedding",
      displayName: "qwen3.7-text-embedding",
      regionGroup: "DOMESTIC",
      taskCategories: EMBEDDING_TASK,
      capabilityCategories: EMBEDDING_CAPABILITY,
      tags: ["embedding"],
      appSupport: "special_connection_required",
      source: SOURCES.alibaba_qwen,
    }),
    specializedEntry({
      providerKind: "alibaba_qwen",
      modelId: "text-embedding-v4",
      displayName: "text-embedding-v4",
      regionGroup: "DOMESTIC",
      taskCategories: EMBEDDING_TASK,
      capabilityCategories: EMBEDDING_CAPABILITY,
      tags: ["embedding"],
      source: SOURCES.alibaba_qwen,
    }),
    specializedEntry({
      providerKind: "alibaba_qwen",
      modelId: "qwen3-vl-embedding",
      displayName: "qwen3-vl-embedding",
      regionGroup: "DOMESTIC",
      taskCategories: EMBEDDING_TASK,
      capabilityCategories: EMBEDDING_CAPABILITY,
      tags: ["embedding", "multimodal_embedding"],
      source: SOURCES.alibaba_qwen,
    }),
    specializedEntry({
      providerKind: "alibaba_qwen",
      modelId: "qwen3-rerank",
      displayName: "qwen3-rerank",
      regionGroup: "DOMESTIC",
      taskCategories: RERANK_TASK,
      capabilityCategories: RERANK_CAPABILITY,
      tags: ["rerank"],
      source: SOURCES.alibaba_qwen,
    }),
    specializedEntry({
      providerKind: "alibaba_qwen",
      modelId: "qwen-image-2.0",
      displayName: "Qwen Image 2.0",
      regionGroup: "DOMESTIC",
      taskCategories: IMAGE_TASK,
      capabilityCategories: IMAGE_CAPABILITY,
      tags: ["image_generation"],
      appSupport: "protocol_not_implemented",
      source: SOURCES.alibaba_qwen,
    }),
    ...textEntries("zhipu_glm", "DOMESTIC", SOURCES.zhipu_glm, [
      ["glm-5.2", "GLM-5.2", "stable"],
      ["glm-5-turbo", "GLM-5 Turbo", "stable"],
    ]),
    specializedEntry({
      providerKind: "volcengine_doubao",
      modelId: null,
      displayName: "Seedream image models (discover from provider)",
      regionGroup: "DOMESTIC",
      taskCategories: IMAGE_TASK,
      capabilityCategories: IMAGE_CAPABILITY,
      tags: ["image_generation", "provider_discovery"],
      appSupport: "discovery_only",
      source: SOURCES.volcengine_doubao,
    }),
  ]);

export function projectSelectableModelCatalog(
  now: string,
  options: Readonly<{ expert: true }>,
): readonly SelectableModelCatalogExpertEntry[];
export function projectSelectableModelCatalog(
  now: string,
  options?: Readonly<{ expert?: false }>,
): readonly SelectableModelCatalogPublicEntry[];
export function projectSelectableModelCatalog(
  now: string,
  options: Readonly<{ expert?: boolean }> = {},
): readonly SelectableModelCatalogProjection[] {
  const nowMilliseconds = Date.parse(now);
  if (!Number.isFinite(nowMilliseconds)) return Object.freeze([]);
  const current = SELECTABLE_MODEL_CATALOG_ENTRIES.filter(
    ({ officialSource }) => Date.parse(officialSource.expiresAt) > nowMilliseconds,
  );
  if (options.expert === true) return Object.freeze([...current]);
  return Object.freeze(current.map(toPublicProjection));
}

export function selectableModelsForTask(
  task: NovelAiTask,
  now: string,
  options: Readonly<{ expert: true }>,
): readonly SelectableModelCatalogExpertEntry[];
export function selectableModelsForTask(
  task: NovelAiTask,
  now: string,
  options?: Readonly<{ expert?: false }>,
): readonly SelectableModelCatalogPublicEntry[];
export function selectableModelsForTask(
  task: NovelAiTask,
  now: string,
  options: Readonly<{ expert?: boolean }> = {},
): readonly SelectableModelCatalogProjection[] {
  const projected =
    options.expert === true
      ? projectSelectableModelCatalog(now, { expert: true })
      : projectSelectableModelCatalog(now);
  return Object.freeze(projected.filter(({ taskCategories }) => taskCategories.includes(task)));
}

export function mergeConnectedAndSelectableModels<
  Projected extends SelectableModelCatalogProjection,
  ConnectedEntry extends SelectableModelConnectedCatalogRow,
>(
  connected: readonly ConnectedSelectableModelCatalogEntry<ConnectedEntry>[],
  selectable: readonly Projected[],
): readonly MergedSelectableModelCatalogEntry<Projected, ConnectedEntry>[] {
  const connectedIdentities = new Set(
    connected.map(({ providerKind, entry }) =>
      catalogIdentity(providerKind, entry.providerModelId),
    ),
  );
  const connectedRows = connected.map(({ providerKind, entry }) =>
    Object.freeze({ source: "connected" as const, providerKind, entry }),
  );
  const officialRows = selectable.flatMap((entry) => {
    if (
      entry.modelId !== null &&
      [entry.modelId, ...entry.aliases].some((modelId) =>
        connectedIdentities.has(catalogIdentity(entry.providerKind, modelId)),
      )
    ) {
      return [];
    }
    return [
      Object.freeze({
        source: "official_candidate" as const,
        providerKind: entry.providerKind,
        entry,
      }),
    ];
  });
  return Object.freeze([...connectedRows, ...officialRows]);
}

function source(title: string, url: string): SelectableModelOfficialSource {
  return Object.freeze({
    kind: "official_provider_documentation",
    title,
    url,
    updatedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: "2026-09-13T00:00:00.000Z",
  });
}

function textEntries(
  providerKind: ModelProviderKind,
  regionGroup: SelectableModelRegionGroup,
  officialSource: SelectableModelOfficialSource,
  models: readonly (readonly [string, string, SelectableModelLifecycle])[],
): readonly SelectableModelCatalogEntry[] {
  return models.map(([modelId, displayName, lifecycle]) =>
    textEntry({
      providerKind,
      modelId,
      displayName,
      regionGroup,
      lifecycle,
      source: officialSource,
    }),
  );
}

function textEntry(input: {
  readonly providerKind: ModelProviderKind;
  readonly modelId: string;
  readonly displayName: string;
  readonly regionGroup: SelectableModelRegionGroup;
  readonly lifecycle: SelectableModelLifecycle;
  readonly appSupport?: SelectableModelAppSupport;
  readonly aliases?: readonly string[];
  readonly source: SelectableModelOfficialSource;
}): SelectableModelCatalogEntry {
  return entry({
    ...input,
    taskCategories: GENERAL_TEXT_TASKS,
    capabilityCategories: TEXT_CAPABILITY,
    tags: ["text_generation", "writing_candidate", "translation_candidate"],
  });
}

function specializedEntry(input: {
  readonly providerKind: ModelProviderKind;
  readonly modelId: string | null;
  readonly displayName: string;
  readonly regionGroup: SelectableModelRegionGroup;
  readonly taskCategories: readonly NovelAiTask[];
  readonly capabilityCategories: readonly ModelHubCapability[];
  readonly tags: readonly string[];
  readonly lifecycle?: SelectableModelLifecycle;
  readonly appSupport?: SelectableModelAppSupport;
  readonly aliases?: readonly string[];
  readonly source: SelectableModelOfficialSource;
}): SelectableModelCatalogEntry {
  return entry(input);
}

function entry(input: {
  readonly providerKind: ModelProviderKind;
  readonly modelId: string | null;
  readonly displayName: string;
  readonly regionGroup: SelectableModelRegionGroup;
  readonly taskCategories: readonly NovelAiTask[];
  readonly capabilityCategories: readonly ModelHubCapability[];
  readonly tags: readonly string[];
  readonly lifecycle?: SelectableModelLifecycle;
  readonly appSupport?: SelectableModelAppSupport;
  readonly aliases?: readonly string[];
  readonly replacementModelId?: string | null;
  readonly source: SelectableModelOfficialSource;
}): SelectableModelCatalogEntry {
  return Object.freeze({
    schemaVersion: "inkshadow.selectable-model-catalog-entry.v1",
    registryVersion: SELECTABLE_MODEL_CATALOG_REGISTRY_VERSION,
    providerKind: input.providerKind,
    modelId: input.modelId,
    displayName: input.displayName,
    regionGroup: input.regionGroup,
    taskCategories: Object.freeze([...input.taskCategories]),
    capabilityCategories: Object.freeze([...input.capabilityCategories]),
    tags: Object.freeze([...input.tags]),
    connectionRequired: true,
    lifecycle: input.lifecycle ?? "stable",
    appSupport: input.appSupport ?? "routable_after_verification",
    aliases: Object.freeze([...(input.aliases ?? [])]),
    replacementModelId: input.replacementModelId ?? null,
    status: "provider_documented_not_verified",
    routable: false,
    capabilityEvidence: false,
    officialSource: input.source,
  });
}

function toPublicProjection(
  entryValue: SelectableModelCatalogEntry,
): SelectableModelCatalogPublicEntry {
  const { officialSource, ...ordinary } = entryValue;
  void officialSource;
  return Object.freeze(ordinary);
}

function catalogIdentity(providerKind: ModelProviderKind, modelId: string): string {
  return `${providerKind}\u0000${modelId.trim().toLocaleLowerCase("en-US")}`;
}
