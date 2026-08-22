import { useId, useMemo, useState } from "react";

import { Badge, Input } from "@inkshadow/ui";

import type { ModelProviderKind } from "../infrastructure/model-hub-provider-registry";
import type {
  SelectableModelAppSupport,
  SelectableModelCatalogPublicEntry,
  SelectableModelLifecycle,
  SelectableModelRegionGroup,
} from "../infrastructure/selectable-model-catalog-registry";

import "./model-hub-selectable-catalog-browser.css";

export type ModelHubSelectableCatalogConnectedAppSupport =
  SelectableModelAppSupport | "verified_in_app" | "verification_required";

export type ModelHubSelectableCatalogConnectedLifecycle = SelectableModelLifecycle | "not_provided";

/**
 * A safe, already-normalized view of an account catalog row. The caller owns
 * endpoint-region classification and capability evidence; this component does
 * not infer either from a provider name.
 */
export interface ModelHubSelectableCatalogConnectedModel {
  readonly catalogEntryId: string;
  readonly providerKind: ModelProviderKind;
  readonly providerModelId: string;
  readonly displayName: string;
  readonly providerLabel?: string;
  readonly connectionLabel?: string;
  readonly regionGroup: SelectableModelRegionGroup;
  readonly tags?: readonly string[];
  readonly lifecycle?: ModelHubSelectableCatalogConnectedLifecycle;
  readonly appSupport?: ModelHubSelectableCatalogConnectedAppSupport;
}

export type ModelHubSelectableCatalogSelection =
  | Readonly<{
      source: "connected";
      model: ModelHubSelectableCatalogConnectedModel;
    }>
  | Readonly<{
      source: "official_candidate";
      model: SelectableModelCatalogPublicEntry;
    }>;

export interface ModelHubSelectableCatalogBrowserProps {
  readonly connectedModels: readonly ModelHubSelectableCatalogConnectedModel[];
  /** Ordinary projection only. Expert evidence is intentionally outside this component. */
  readonly officialCandidates: readonly SelectableModelCatalogPublicEntry[];
  readonly onSelect: (selection: ModelHubSelectableCatalogSelection) => void;
  readonly disabled?: boolean;
  readonly defaultExpanded?: boolean;
  /** `connected:<catalogEntryId>` or `official:<providerKind>:<modelId-or-displayName>`. */
  readonly selectedKey?: string | null;
}

type CatalogBrowserItem =
  | Readonly<{
      key: string;
      source: "connected";
      model: ModelHubSelectableCatalogConnectedModel;
      providerKind: ModelProviderKind;
      modelId: string;
      displayName: string;
      providerLabel: string;
      regionGroup: SelectableModelRegionGroup;
      tags: readonly string[];
      aliases: readonly string[];
      lifecycle: ModelHubSelectableCatalogConnectedLifecycle;
      appSupport: ModelHubSelectableCatalogConnectedAppSupport;
    }>
  | Readonly<{
      key: string;
      source: "official_candidate";
      model: SelectableModelCatalogPublicEntry;
      providerKind: ModelProviderKind;
      modelId: string | null;
      displayName: string;
      providerLabel: string;
      regionGroup: SelectableModelRegionGroup;
      tags: readonly string[];
      aliases: readonly string[];
      lifecycle: SelectableModelLifecycle;
      appSupport: SelectableModelAppSupport;
    }>;

const REGION_GROUPS = Object.freeze([
  Object.freeze({ id: "DOMESTIC" as const, label: "国内" }),
  Object.freeze({ id: "INTERNATIONAL" as const, label: "海外" }),
  Object.freeze({ id: "LOCAL" as const, label: "本地" }),
]);

const PROVIDER_LABELS: Readonly<Record<ModelProviderKind, string>> = Object.freeze({
  openai: "OpenAI",
  deepseek: "DeepSeek",
  zhipu_glm: "智谱 GLM",
  alibaba_qwen: "阿里云百炼 / Qwen",
  volcengine_doubao: "火山方舟 / 豆包",
  google_gemini: "Google Gemini",
  anthropic_claude: "Anthropic Claude",
  ollama: "Ollama",
  custom_openai_compatible: "自定义 OpenAI-compatible",
});

const TAG_LABELS: Readonly<Record<string, string>> = Object.freeze({
  text_generation: "文本生成",
  writing_candidate: "写作候选",
  embedding: "语义向量",
  multimodal_embedding: "多模态向量",
  rerank: "结果排序",
  image_generation: "图像生成",
  provider_discovery: "连接后发现",
});

export function ModelHubSelectableCatalogBrowser({
  connectedModels,
  defaultExpanded = false,
  disabled = false,
  officialCandidates,
  onSelect,
  selectedKey = null,
}: ModelHubSelectableCatalogBrowserProps) {
  const searchId = useId();
  const headingId = useId();
  const resultsId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [query, setQuery] = useState("");

  const allItems = useMemo(
    () => (expanded ? buildCatalogBrowserItems(connectedModels, officialCandidates) : []),
    [connectedModels, expanded, officialCandidates],
  );
  const visibleItems = useMemo(() => {
    const needle = normalizeSearchText(query);
    if (needle === "") return allItems;
    return allItems.filter((item) => searchableText(item).includes(needle));
  }, [allItems, query]);
  const connectedCount = visibleItems.filter(({ source }) => source === "connected").length;

  return (
    <section className="model-catalog-browser" aria-label="可选模型目录">
      <details
        className="model-catalog-browser__disclosure"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary
          className="model-catalog-browser__summary"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setExpanded((current) => !current);
          }}
        >
          <span>
            <strong>浏览全部可选模型</strong>
            <small>按国内、海外和本地分组；展开后再载入列表。</small>
          </span>
          <span aria-hidden="true">{expanded ? "收起" : "展开"}</span>
        </summary>

        {expanded ? (
          <div className="model-catalog-browser__body">
            <header className="model-catalog-browser__header">
              <div>
                <h3 id={headingId}>可选模型目录</h3>
                <p>已连接模型可直接选择；未连接模型会交给连接流程继续处理。</p>
              </div>
              <p id={resultsId} className="model-catalog-browser__result-count" aria-live="polite">
                共 {visibleItems.length} 个结果，其中 {connectedCount} 个已连接
              </p>
            </header>

            <div className="model-catalog-browser__search" role="search">
              <label htmlFor={searchId}>搜索模型、供应商或用途</label>
              <Input
                id={searchId}
                type="search"
                value={query}
                autoComplete="off"
                disabled={disabled}
                aria-describedby={resultsId}
                placeholder="例如 DeepSeek、向量检索、图像生成"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>

            {visibleItems.length === 0 ? (
              <p className="model-catalog-browser__empty">没有匹配的模型，请尝试其他名称或用途。</p>
            ) : (
              <div className="model-catalog-browser__regions">
                {REGION_GROUPS.map((region) => {
                  const regionItems = visibleItems.filter(
                    ({ regionGroup }) => regionGroup === region.id,
                  );
                  if (regionItems.length === 0) return null;
                  const regionHeadingId = `${headingId}-${region.id.toLocaleLowerCase("en-US")}`;
                  return (
                    <section
                      key={region.id}
                      className="model-catalog-browser__region"
                      aria-labelledby={regionHeadingId}
                    >
                      <div className="model-catalog-browser__region-heading">
                        <h4 id={regionHeadingId}>{region.label}</h4>
                        <span>{regionItems.length} 个</span>
                      </div>
                      <ul className="model-catalog-browser__list">
                        {regionItems.map((item) => (
                          <CatalogBrowserRow
                            key={item.key}
                            item={item}
                            disabled={disabled}
                            selected={selectedKey === item.key}
                            onSelect={onSelect}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}
      </details>
    </section>
  );
}

function CatalogBrowserRow({
  disabled,
  item,
  onSelect,
  selected,
}: Readonly<{
  disabled: boolean;
  item: CatalogBrowserItem;
  onSelect: (selection: ModelHubSelectableCatalogSelection) => void;
  selected: boolean;
}>) {
  const connectionLabel = item.source === "connected" ? "已连接" : "未连接";
  const lifecycle = lifecycleLabel(item.lifecycle);
  const support = appSupportLabel(item.appSupport);
  const visibleTags = item.tags.flatMap((tag) => {
    const label = TAG_LABELS[tag];
    return label === undefined ? [] : [label];
  });
  const technicalModelId = item.modelId ?? "由供应商目录发现";

  return (
    <li>
      <button
        type="button"
        className="model-catalog-browser__item"
        data-connected={item.source === "connected" || undefined}
        data-selected={selected || undefined}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={`选择 ${item.displayName}，${item.providerLabel}，${connectionLabel}，${support}，${lifecycle}`}
        onClick={() => {
          onSelect({
            source: item.source,
            model: item.model,
          } as ModelHubSelectableCatalogSelection);
        }}
      >
        <span className="model-catalog-browser__item-heading">
          <span className="model-catalog-browser__item-name">{item.displayName}</span>
          <Badge tone={item.source === "connected" ? "success" : "neutral"}>
            {connectionLabel}
          </Badge>
        </span>
        <span className="model-catalog-browser__model-id">{technicalModelId}</span>
        <span className="model-catalog-browser__provider">
          {item.providerLabel} · {regionLabel(item.regionGroup)}
        </span>
        <span className="model-catalog-browser__status-row">
          <Badge tone={appSupportTone(item.appSupport)}>{support}</Badge>
          <Badge tone={item.lifecycle === "deprecated" ? "warning" : "neutral"}>{lifecycle}</Badge>
        </span>
        {visibleTags.length > 0 ? (
          <span className="model-catalog-browser__tags" aria-label="适用用途">
            {visibleTags.map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function buildCatalogBrowserItems(
  connectedModels: readonly ModelHubSelectableCatalogConnectedModel[],
  officialCandidates: readonly SelectableModelCatalogPublicEntry[],
): readonly CatalogBrowserItem[] {
  const connectedIdentities = new Set(
    connectedModels.map(({ providerKind, providerModelId }) =>
      modelIdentity(providerKind, providerModelId),
    ),
  );
  const connected: CatalogBrowserItem[] = connectedModels.map((model) => ({
    key: `connected:${model.catalogEntryId}`,
    source: "connected",
    model,
    providerKind: model.providerKind,
    modelId: model.providerModelId,
    displayName: model.displayName || model.providerModelId,
    providerLabel: model.providerLabel ?? PROVIDER_LABELS[model.providerKind],
    regionGroup: model.regionGroup,
    tags: model.tags ?? [],
    aliases: [],
    lifecycle: model.lifecycle ?? "not_provided",
    appSupport: model.appSupport ?? "verification_required",
  }));
  const official: CatalogBrowserItem[] = officialCandidates.flatMap((model) => {
    const duplicate =
      model.modelId !== null &&
      [model.modelId, ...model.aliases].some((modelId) =>
        connectedIdentities.has(modelIdentity(model.providerKind, modelId)),
      );
    if (duplicate) return [];
    return [
      {
        key: officialCandidateKey(model),
        source: "official_candidate" as const,
        model,
        providerKind: model.providerKind,
        modelId: model.modelId,
        displayName: model.displayName,
        providerLabel: PROVIDER_LABELS[model.providerKind],
        regionGroup: model.regionGroup,
        tags: model.tags,
        aliases: model.aliases,
        lifecycle: model.lifecycle,
        appSupport: model.appSupport,
      },
    ];
  });

  return [...connected, ...official].sort((left, right) => {
    if (left.regionGroup !== right.regionGroup) {
      return regionOrder(left.regionGroup) - regionOrder(right.regionGroup);
    }
    if (left.source !== right.source) return left.source === "connected" ? -1 : 1;
    return (
      left.displayName.localeCompare(right.displayName, "zh-CN") ||
      (left.modelId ?? "").localeCompare(right.modelId ?? "", "en-US")
    );
  });
}

function searchableText(item: CatalogBrowserItem): string {
  return normalizeSearchText(
    [
      item.displayName,
      item.modelId ?? "",
      item.providerLabel,
      item.providerKind,
      ...item.aliases,
      ...item.tags,
      ...item.tags.flatMap((tag) => TAG_LABELS[tag] ?? []),
      item.source === "connected" ? (item.model.connectionLabel ?? "") : "",
    ].join("\n"),
  );
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function officialCandidateKey(model: SelectableModelCatalogPublicEntry): string {
  return `official:${model.providerKind}:${model.modelId ?? model.displayName}`;
}

function modelIdentity(providerKind: ModelProviderKind, modelId: string): string {
  return `${providerKind}\u0000${modelId.trim().toLocaleLowerCase("en-US")}`;
}

function regionOrder(region: SelectableModelRegionGroup): number {
  return REGION_GROUPS.findIndex(({ id }) => id === region);
}

function regionLabel(region: SelectableModelRegionGroup): string {
  return REGION_GROUPS.find(({ id }) => id === region)?.label ?? region;
}

function lifecycleLabel(lifecycle: ModelHubSelectableCatalogConnectedLifecycle): string {
  const labels: Readonly<Record<ModelHubSelectableCatalogConnectedLifecycle, string>> = {
    stable: "稳定版",
    preview: "预览版",
    deprecated: "已弃用",
    not_provided: "生命周期未提供",
  };
  return labels[lifecycle];
}

function appSupportLabel(appSupport: ModelHubSelectableCatalogConnectedAppSupport): string {
  const labels: Readonly<Record<ModelHubSelectableCatalogConnectedAppSupport, string>> = {
    routable_after_verification: "应用可接入，需验证",
    protocol_not_implemented: "应用暂不支持此协议",
    special_connection_required: "需要专用连接",
    discovery_only: "连接后发现",
    verified_in_app: "已通过应用验证",
    verification_required: "待应用验证",
  };
  return labels[appSupport];
}

function appSupportTone(
  appSupport: ModelHubSelectableCatalogConnectedAppSupport,
): "success" | "warning" | "info" | "neutral" {
  if (appSupport === "verified_in_app") return "success";
  if (appSupport === "protocol_not_implemented") return "warning";
  if (appSupport === "routable_after_verification" || appSupport === "verification_required") {
    return "info";
  }
  return "neutral";
}
