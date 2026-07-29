import { useEffect, useMemo, useState } from "react";

import type { CloudMarketplaceArtifactSummary } from "@inkshadow/contracts/marketplace";

import {
  type MarketplaceRuntime,
  type MarketplaceRuntimeSnapshot,
} from "../infrastructure/marketplace-runtime.js";

import "./marketplace-page.css";

export interface MarketplacePageProps {
  readonly onPublishRequested?: () => void;
  readonly onReportRequested?: (artifact: CloudMarketplaceArtifactSummary) => void;
  readonly runtime: MarketplaceRuntime;
}

const INITIAL_SNAPSHOT: MarketplaceRuntimeSnapshot = {
  catalog: [],
  installed: [],
  remoteState: "idle",
  remoteError: null,
};

export function MarketplacePage({
  onPublishRequested,
  onReportRequested,
  runtime,
}: MarketplacePageProps) {
  const [snapshot, setSnapshot] = useState<MarketplaceRuntimeSnapshot>(INITIAL_SNAPSHOT);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | CloudMarketplaceArtifactSummary["kind"]>("all");
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void runtime.refreshCatalog().then((next) => {
      if (active) {
        setSnapshot(next);
      }
    });
    return () => {
      active = false;
    };
  }, [runtime]);

  const installedIds = useMemo(
    () => new Set(snapshot.installed.map((item) => item.artifact.artifactId)),
    [snapshot.installed],
  );
  const visibleCatalog = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return snapshot.catalog.filter((artifact) => {
      if (kind !== "all" && artifact.kind !== kind) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      return [artifact.title, artifact.summary, artifact.authorDisplayName, ...artifact.tags]
        .join("\n")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [kind, query, snapshot.catalog]);

  async function install(artifact: CloudMarketplaceArtifactSummary): Promise<void> {
    if (artifact.publishedVersionId === null) {
      return;
    }
    setBusyArtifactId(artifact.artifactId);
    setActionError(null);
    try {
      await runtime.install(artifact.artifactId, artifact.publishedVersionId);
      setSnapshot(await runtime.snapshot());
    } catch (error: unknown) {
      setActionError(readableError(error));
    } finally {
      setBusyArtifactId(null);
    }
  }

  async function uninstall(artifactId: string): Promise<void> {
    setBusyArtifactId(artifactId);
    setActionError(null);
    try {
      await runtime.uninstall(artifactId);
      setSnapshot(await runtime.snapshot());
    } catch (error: unknown) {
      setActionError(readableError(error));
    } finally {
      setBusyArtifactId(null);
    }
  }

  return (
    <main className="marketplace-page" aria-labelledby="marketplace-title">
      <header className="marketplace-page__header">
        <div>
          <p className="marketplace-page__eyebrow">社区资源</p>
          <h1 id="marketplace-title">社区市场</h1>
          <p>只安装经过签名和结构校验的模板。已安装副本始终由你在本机管理。</p>
        </div>
        {onPublishRequested === undefined ? null : (
          <button type="button" className="marketplace-page__primary" onClick={onPublishRequested}>
            发布模板
          </button>
        )}
      </header>

      <RemoteStatus snapshot={snapshot} />

      <section aria-labelledby="installed-marketplace-title">
        <div className="marketplace-page__section-heading">
          <div>
            <p className="marketplace-page__eyebrow">本机可用</p>
            <h2 id="installed-marketplace-title">已安装模板</h2>
          </div>
          <span>{snapshot.installed.length} 个</span>
        </div>
        {snapshot.installed.length === 0 ? (
          <p className="marketplace-page__empty">尚未安装社区模板。</p>
        ) : (
          <ul className="marketplace-page__installed-list">
            {snapshot.installed.map((installed) => (
              <li key={installed.artifact.artifactId}>
                <div>
                  <strong>{installed.artifact.title}</strong>
                  <span>
                    版本 {installed.version.semanticVersion} ·{" "}
                    {licenseLabel(installed.artifact.license)}
                  </span>
                  <small>本地副本；市场关闭、离线或源模板下架时仍可使用</small>
                </div>
                <button
                  type="button"
                  disabled={busyArtifactId === installed.artifact.artifactId}
                  onClick={() => {
                    void uninstall(installed.artifact.artifactId);
                  }}
                >
                  卸载本地副本
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="catalog-marketplace-title">
        <div className="marketplace-page__section-heading">
          <div>
            <p className="marketplace-page__eyebrow">在线目录</p>
            <h2 id="catalog-marketplace-title">发现模板</h2>
          </div>
        </div>

        <div className="marketplace-page__filters">
          <label>
            <span>搜索</span>
            <input
              type="search"
              value={query}
              placeholder="标题、作者或标签"
              onChange={(event) => {
                setQuery(event.currentTarget.value);
              }}
            />
          </label>
          <label>
            <span>类别</span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(
                  event.currentTarget.value as "all" | CloudMarketplaceArtifactSummary["kind"],
                );
              }}
            >
              <option value="all">全部</option>
              <option value="story_template">故事模板</option>
              <option value="world_template">世界观模板</option>
              <option value="style_template">风格模板</option>
            </select>
          </label>
        </div>

        {actionError === null ? null : (
          <p className="marketplace-page__action-error" role="alert">
            {actionError}
          </p>
        )}

        {snapshot.remoteState === "loading" || snapshot.remoteState === "idle" ? (
          <p className="marketplace-page__empty" aria-live="polite">
            正在读取社区目录…
          </p>
        ) : snapshot.remoteState !== "ready" ? null : visibleCatalog.length === 0 ? (
          <p className="marketplace-page__empty">没有符合当前筛选条件的模板。</p>
        ) : (
          <ul className="marketplace-page__catalog-grid">
            {visibleCatalog.map((artifact) => {
              const installed = installedIds.has(artifact.artifactId);
              return (
                <li key={artifact.artifactId}>
                  <div className="marketplace-page__card-heading">
                    <span>{kindLabel(artifact.kind)}</span>
                    <span>{licenseLabel(artifact.license)}</span>
                  </div>
                  <h3>{artifact.title}</h3>
                  <p>{artifact.summary}</p>
                  <dl>
                    <div>
                      <dt>作者</dt>
                      <dd>{artifact.authorDisplayName}</dd>
                    </div>
                    <div>
                      <dt>版本</dt>
                      <dd>{artifact.latestVersionNumber}</dd>
                    </div>
                  </dl>
                  <div className="marketplace-page__tags" aria-label="标签">
                    {artifact.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <div className="marketplace-page__card-actions">
                    <button
                      type="button"
                      className="marketplace-page__primary"
                      disabled={
                        artifact.publishedVersionId === null ||
                        busyArtifactId === artifact.artifactId
                      }
                      onClick={() => {
                        void install(artifact);
                      }}
                    >
                      {installed ? "更新本地副本" : "安装"}
                    </button>
                    {onReportRequested === undefined ? null : (
                      <button
                        type="button"
                        onClick={() => {
                          onReportRequested(artifact);
                        }}
                      >
                        举报
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

function RemoteStatus({ snapshot }: { readonly snapshot: MarketplaceRuntimeSnapshot }) {
  switch (snapshot.remoteState) {
    case "disabled":
      return (
        <aside className="marketplace-page__notice" role="status">
          社区市场当前未启用。不会连接市场服务；已安装的本地模板不受影响。
        </aside>
      );
    case "offline":
      return (
        <aside className="marketplace-page__notice" role="status">
          当前离线。在线目录和新安装暂不可用，已安装模板仍可继续使用。
        </aside>
      );
    case "error":
      return (
        <aside className="marketplace-page__notice marketplace-page__notice--error" role="alert">
          {snapshot.remoteError ?? "社区目录暂时不可用。已安装模板不受影响。"}
        </aside>
      );
    case "idle":
    case "loading":
    case "ready":
      return null;
  }
}

function kindLabel(kind: CloudMarketplaceArtifactSummary["kind"]): string {
  switch (kind) {
    case "story_template":
      return "故事模板";
    case "style_template":
      return "风格模板";
    case "world_template":
      return "世界观模板";
  }
}

function licenseLabel(license: CloudMarketplaceArtifactSummary["license"]): string {
  switch (license) {
    case "cc0-1.0":
      return "CC0 1.0";
    case "cc-by-4.0":
      return "CC BY 4.0";
    case "cc-by-sa-4.0":
      return "CC BY-SA 4.0";
    case "inkshadow-community-free-1.0":
      return "墨影社区免费许可";
  }
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "操作未完成，请稍后重试。";
}
