import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type HybridSearchHit,
  type HybridSearchResponse,
  type SearchHealth,
} from "@inkshadow/search-core";
import type { Project } from "@inkshadow/domain";
import { parseUuidV7 } from "@inkshadow/domain";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  InlineAlert,
  PageStateBoundary,
} from "@inkshadow/ui";
import { Link, useParams } from "react-router-dom";

import type { ProjectEmbeddingDiagnostics } from "../infrastructure/project-search-vector-service";
import { defaultProjectSearchRetrievalScope } from "../infrastructure/project-search-store";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

export function ProjectSearchPage() {
  const runtime = useRuntime();
  const params = useParams<{ projectId: string }>();
  const parsedProjectId = useMemo(() => parseUuidV7(params.projectId ?? ""), [params.projectId]);
  const projectId = parsedProjectId.ok ? parsedProjectId.value : null;
  const [project, setProject] = useState<Project | null>(null);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<HybridSearchResponse | null>(null);
  const [responseQuery, setResponseQuery] = useState<string | null>(null);
  const searchRequestRef = useRef(0);
  const [health, setHealth] = useState<SearchHealth>(() => runtime.search.health());
  const [embedding, setEmbedding] = useState<ProjectEmbeddingDiagnostics>(() =>
    runtime.search.embeddingDiagnostics(),
  );
  const [pageState, setPageState] = useState<"loading" | "ready" | "fatal_error">("loading");
  const [error, setError] = useState<unknown>(parsedProjectId.ok ? null : parsedProjectId.error);
  const [busy, setBusy] = useState<"rebuild" | "disable_vector" | "search" | null>(null);

  const rebuild = useCallback(async () => {
    if (projectId === null) {
      return false;
    }
    setBusy("rebuild");
    setError(null);
    const result = await runtime.search.rebuildProject(projectId);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setHealth(result.value);
    setEmbedding(runtime.search.embeddingDiagnostics());
    return true;
  }, [projectId, runtime]);

  const load = useCallback(async () => {
    if (projectId === null) {
      setPageState("fatal_error");
      return;
    }
    setPageState("loading");
    const projectResult = await runtime.repositories.projects.findById(projectId);
    if (!projectResult.ok || projectResult.value === null) {
      setError(projectResult.ok ? new Error("项目不存在。") : projectResult.error);
      setPageState("fatal_error");
      return;
    }
    setProject(projectResult.value);
    const rebuilt = await rebuild();
    setPageState(rebuilt ? "ready" : "fatal_error");
  }, [projectId, rebuild, runtime]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function runSearch(): Promise<void> {
    const submittedQuery = query.trim();
    if (projectId === null || submittedQuery.length === 0) {
      return;
    }
    const requestId = searchRequestRef.current + 1;
    searchRequestRef.current = requestId;
    setBusy("search");
    setError(null);
    setResponse(null);
    setResponseQuery(null);
    const result = await runtime.search.searchFtsOnly(
      projectId,
      submittedQuery,
      defaultProjectSearchRetrievalScope(projectId),
      30,
    );
    if (requestId !== searchRequestRef.current) {
      return;
    }
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setResponse(result.value);
    setResponseQuery(submittedQuery);
    setHealth(result.value.health);
    setEmbedding(runtime.search.embeddingDiagnostics());
  }

  async function rebuildAndRepeat(): Promise<void> {
    const rebuilt = await rebuild();
    if (rebuilt && query.trim().length > 0) {
      await runSearch();
    }
  }

  async function disableVectors(): Promise<void> {
    if (projectId === null) {
      return;
    }
    if (
      !window.confirm(
        "确认停用并清除当前项目的持久向量？本地关键词索引会保留，之后的搜索词不会再发送到嵌入端点。",
      )
    ) {
      return;
    }
    setBusy("disable_vector");
    setError(null);
    const result = await runtime.search.disableVectorProject(projectId);
    setBusy(null);
    setEmbedding(runtime.search.embeddingDiagnostics());
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setHealth(result.value);
    setResponse(null);
  }

  const normalizedError = error === null ? null : projectOrdinaryUiError(error);

  return (
    <div className="desktop-page search-page">
      <header className="page-heading">
        <div>
          <Link
            className="back-link"
            to={projectId === null ? "/projects" : `/projects/${projectId}`}
          >
            返回项目
          </Link>
          <p className="page-heading__eyebrow">本地可解释检索</p>
          <h1>{project?.name === undefined ? "项目搜索" : `搜索 · ${project.name}`}</h1>
          <p>关键词索引来自本地稳定内容；向量只有在你明确重建后才会生成并持久保存。</p>
        </div>
        <div className="settings-actions">
          <Button
            variant="secondary"
            loading={busy === "rebuild"}
            disabled={busy !== null || projectId === null}
            onClick={() => void rebuildAndRepeat()}
          >
            重建本地索引
          </Button>
          <Button
            variant="secondary"
            disabled
            title="远程或本机模型向量重建尚未开放；当前搜索固定使用本地关键词索引。"
          >
            向量重建尚未开放
          </Button>
          <Button
            variant="secondary"
            loading={busy === "disable_vector"}
            disabled={busy !== null || projectId === null || embedding.embeddingCount === 0}
            onClick={() => void disableVectors()}
          >
            停用并清除向量
          </Button>
        </div>
      </header>

      <PageStateBoundary
        state={pageState}
        preserveContent={false}
        fallbacks={{
          fatal_error:
            normalizedError === null ? undefined : (
              <ErrorState
                title={normalizedError.title}
                description={normalizedError.description}
                primaryAction={{ label: "重试", onClick: () => void load() }}
              />
            ),
        }}
      >
        <section className="search-console" aria-labelledby="project-search-form-title">
          <div className="search-health" aria-label="索引状态">
            <Badge tone={health.mutationStatus === "ready" ? "success" : "warning"}>
              {health.mutationStatus === "ready" ? "索引可用" : "索引已暂停"}
            </Badge>
            <span>{health.documentCount} 个索引片段</span>
            <span>关键词：就绪</span>
            <span>关系：就绪</span>
            <span>向量：{vectorStatusLabel(health.vectorStatus)}</span>
            <span>模型：{embedding.model ?? "未配置"}</span>
            <span>维度：{embedding.dimension ?? "—"}</span>
            <span>数量：{embedding.embeddingCount}</span>
          </div>

          <InlineAlert
            tone={embedding.embeddingCount > 0 ? "warning" : "info"}
            title={`向量数据去向：${embeddingDestinationLabel(embedding)}`}
            description={`${embedding.endpointUrl ?? "浏览器开发模式不提供真实嵌入能力。"} ${
              embedding.reason === null
                ? "持久向量与当前来源版本、内容哈希完全匹配。"
                : `当前状态：${embeddingReasonLabel(embedding.reason)}。`
            } 当前版本不会从普通搜索页发起向量重建或查询嵌入；搜索固定使用本地关键词索引。已有向量可使用“停用并清除向量”移除。`}
          />

          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <h2 id="project-search-form-title">检索项目内容</h2>
            <FormField
              label="搜索词"
              hint="支持中文连续文本与标题；当前未配置嵌入模型时会明确使用关键词/关系回退。"
              required
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="search"
                  value={query}
                  maxLength={500}
                  placeholder="例如：失落王冠、雾港钟声、角色姓名"
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              )}
            </FormField>
            <Button
              type="submit"
              loading={busy === "search"}
              disabled={busy !== null || query.trim().length === 0}
            >
              搜索
            </Button>
          </form>
          <p role="status" aria-live="polite">
            {busy === "search"
              ? `正在搜索“${query.trim()}”…`
              : responseQuery === null
                ? "尚未执行搜索。"
                : `已完成“${responseQuery}”的搜索。`}
          </p>
        </section>

        {pageState === "ready" && normalizedError !== null && (
          <InlineAlert
            tone="error"
            title={normalizedError.title}
            description={normalizedError.description}
          />
        )}

        {response?.notices.some((notice) => notice.includes("keyword_relation_fallback")) ===
          true && (
          <InlineAlert
            tone="info"
            title="当前使用关键词与关系检索"
            description={`没有为本次查询提供兼容向量；结果不会伪装成语义检索。${embedding.queryFailureCode === null ? "" : " 向量查询未完成，已安全回退到本地关键词与关系检索。"}`}
          />
        )}

        <section aria-labelledby="search-results-title">
          <div className="section-heading">
            <h2 id="search-results-title">结果</h2>
            <Badge>
              {busy === "search"
                ? "搜索中"
                : response === null
                  ? "尚未搜索"
                  : `${String(response.hits.length)} 条`}
            </Badge>
          </div>
          {busy === "search" ? (
            <p className="desktop-route-loading" role="status">
              正在读取最新结果…
            </p>
          ) : response === null ? (
            <EmptyState
              title="输入线索开始检索"
              description="索引会从当前稳定章节和故事大纲重建，不读取恢复草稿或未接受候选。"
            />
          ) : response.hits.length === 0 ? (
            <EmptyState
              title="没有找到匹配内容"
              description="可以换用更短的关键词，或在内容更新后重建索引。"
            />
          ) : (
            <div className="search-results">
              {response.hits.map((hit) => (
                <SearchResultCard key={hit.document.id} hit={hit} projectId={projectId} />
              ))}
            </div>
          )}
        </section>
      </PageStateBoundary>
    </div>
  );
}

function SearchResultCard({
  hit,
  projectId,
}: {
  readonly hit: HybridSearchHit;
  readonly projectId: string | null;
}) {
  const route =
    projectId === null
      ? "/projects"
      : hit.document.sourceType === "chapter"
        ? `/projects/${projectId}/chapters/${hit.document.sourceId}`
        : hit.document.sourceType === "outline"
          ? `/projects/${projectId}/outline`
          : `/projects/${projectId}`;
  const excerpt = createExcerpt(hit.document.text);

  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <Badge tone="info">{sourceTypeLabel(hit.document.sourceType)}</Badge>
            <CardTitle>{hit.document.title}</CardTitle>
          </div>
          <strong className="search-score">{formatScore(hit.scores.total)}</strong>
        </div>
      </CardHeader>
      <CardContent>
        <p className="search-excerpt">{excerpt}</p>
        <dl className="search-score-breakdown">
          <div>
            <dt>关键词</dt>
            <dd>{formatScore(hit.scores.keyword)}</dd>
          </div>
          <div>
            <dt>向量</dt>
            <dd>{formatScore(hit.scores.vector)}</dd>
          </div>
          <div>
            <dt>关系</dt>
            <dd>{formatScore(hit.scores.relation)}</dd>
          </div>
          <div>
            <dt>规则</dt>
            <dd>{formatScore(hit.scores.rule)}</dd>
          </div>
        </dl>
        <div className="search-result-footer">
          <span>来源版本：已绑定</span>
          <span>
            命中词：
            {hit.evidence.matchedTerms.length === 0
              ? "关系/规则"
              : hit.evidence.matchedTerms.join("、")}
          </span>
          <Link className="button-link" to={route}>
            打开来源
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function createExcerpt(text: string): string {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return "该大纲节点只有标题，暂无摘要。";
  }
  return `${normalized.slice(0, 180)}${normalized.length > 180 ? "…" : ""}`;
}

function sourceTypeLabel(sourceType: HybridSearchHit["document"]["sourceType"]): string {
  const labels: Record<HybridSearchHit["document"]["sourceType"], string> = {
    chapter: "章节",
    outline: "大纲",
    character: "角色",
    world: "世界观",
    foreshadow: "伏笔",
    material: "素材",
    memory: "记忆",
  };
  return labels[sourceType];
}

function vectorStatusLabel(status: SearchHealth["vectorStatus"]): string {
  const labels: Record<SearchHealth["vectorStatus"], string> = {
    ready: "就绪",
    disabled: "未配置",
    rebuild_required: "需要重建",
    degraded: "降级",
  };
  return labels[status];
}

function embeddingDestinationLabel(diagnostics: ProjectEmbeddingDiagnostics): string {
  if (diagnostics.destination === "local_ollama") {
    return "本机 Ollama";
  }
  if (diagnostics.destination === "remote") {
    return "远程服务（发送前二次确认）";
  }
  return "不可用";
}

function embeddingReasonLabel(reason: NonNullable<ProjectEmbeddingDiagnostics["reason"]>): string {
  const labels: Record<NonNullable<ProjectEmbeddingDiagnostics["reason"]>, string> = {
    no_embedding_route: "未配置 embedding 主路由",
    embedding_profile_missing: "主路由模型配置缺失",
    embedding_route_profile_mismatch: "主路由与精确模型配置不一致",
    native_gateway_unavailable: "浏览器开发模式不提供原生嵌入",
    vector_store_unavailable: "持久向量存储不可用",
    vector_index_not_built: "尚未明确重建向量",
    embedding_configuration_changed: "模型或端点配置已变化，需要重建",
    authoritative_source_changed: "权威内容版本已变化，需要重建",
    vector_index_corrupt: "持久向量校验失败",
    query_embedding_failed: "查询嵌入失败，已回退",
  };
  return labels[reason];
}

function formatScore(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}
