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
        "确认停用并清除当前项目额外整理的相关资料？本地文字搜索仍会保留，之后的搜索词不会再发送给相关资料模型服务。",
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
          <p className="page-heading__eyebrow">查找相关正文</p>
          <h1>{project?.name === undefined ? "项目搜索" : `搜索 · ${project.name}`}</h1>
          <p>搜索会读取本地已保存的正文和大纲；模型辅助整理只有在你明确开启后才会进行。</p>
        </div>
        <div className="settings-actions">
          <Button
            variant="secondary"
            loading={busy === "rebuild"}
            disabled={busy !== null || projectId === null}
            onClick={() => void rebuildAndRepeat()}
          >
            重新整理本地资料
          </Button>
          <Button
            variant="secondary"
            disabled
            title="使用模型辅助整理相关资料尚未开放；当前搜索只读取本地文字资料。"
          >
            模型辅助整理尚未开放
          </Button>
          <Button
            variant="secondary"
            loading={busy === "disable_vector"}
            disabled={busy !== null || projectId === null || embedding.embeddingCount === 0}
            onClick={() => void disableVectors()}
          >
            停用并清除额外资料
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
          <div className="search-health" aria-label="搜索资料状态">
            <Badge tone={health.mutationStatus === "ready" ? "success" : "warning"}>
              {health.mutationStatus === "ready" ? "本地资料可搜索" : "本地资料已暂停"}
            </Badge>
            <span>{health.documentCount} 段可搜索资料</span>
            <span>文字匹配：可用</span>
            <span>故事关系：可用</span>
            <span>相关资料：{vectorStatusLabel(health.vectorStatus)}</span>
          </div>

          <InlineAlert
            tone={embedding.embeddingCount > 0 ? "warning" : "info"}
            title={`相关资料整理位置：${embeddingDestinationLabel(embedding)}`}
            description={`${
              embedding.reason === null
                ? "额外整理的相关资料与当前正文和大纲保持一致。"
                : `当前情况：${embeddingReasonLabel(embedding.reason)}。`
            } 普通搜索页不会自动联系模型服务；当前搜索只读取本地文字和故事关系资料。${
              embedding.embeddingCount > 0
                ? " 如需移除额外整理的资料，可使用“停用并清除额外资料”。"
                : ""
            }`}
          />

          <AdvancedDiagnostics
            className="search-score-breakdown"
            rows={[
              ["模型标识", embedding.model ?? "未配置"],
              ["服务配置标识", embedding.providerId ?? "未配置"],
              ["内容维度", embedding.dimension ?? "—"],
              ["资料数量", embedding.embeddingCount],
              ["服务地址", embedding.endpointUrl ?? "不可用"],
              ["确认记录标识", embedding.confirmationId ?? "无"],
              ["内部状态", embedding.reason ?? "无"],
            ]}
          />

          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <h2 id="project-search-form-title">搜索项目内容</h2>
            <FormField
              label="搜索词"
              hint="支持中文连续文字和标题；即使没有额外的相关资料模型，也会使用本地文字和故事关系完成搜索。"
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
            title="当前使用本地文字与故事关系搜索"
            description={`本次没有可用的模型辅助资料，结果来自本地文字和故事关系。${embedding.queryFailureCode === null ? "" : " 模型辅助查找未完成，已安全改用本地搜索。"}`}
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
              title="输入线索开始搜索"
              description="搜索资料会从当前已保存章节和故事大纲重新整理，不读取恢复草稿或尚未使用的 AI 生成内容。"
            />
          ) : response.hits.length === 0 ? (
            <EmptyState
              title="没有找到匹配内容"
              description="可以换用更短的词语，或在内容更新后重新整理搜索资料。"
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
            <dt>文字匹配</dt>
            <dd>{formatScore(hit.scores.keyword)}</dd>
          </div>
          <div>
            <dt>内容关联</dt>
            <dd>{formatScore(hit.scores.vector)}</dd>
          </div>
          <div>
            <dt>故事关系</dt>
            <dd>{formatScore(hit.scores.relation)}</dd>
          </div>
          <div>
            <dt>排序规则</dt>
            <dd>{formatScore(hit.scores.rule)}</dd>
          </div>
        </dl>
        <div className="search-result-footer">
          <span>已对应保存版本</span>
          <span>
            找到的词语：
            {hit.evidence.matchedTerms.length === 0
              ? "故事关系或排序规则"
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
    ready: "可用",
    disabled: "未配置",
    rebuild_required: "需要重新整理",
    degraded: "暂时受限",
  };
  return labels[status];
}

function AdvancedDiagnostics({
  className,
  rows,
}: Readonly<{
  className: string;
  rows: readonly (readonly [label: string, value: string | number])[];
}>) {
  return (
    <details>
      <summary>高级诊断详情</summary>
      <dl className={className}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
function embeddingDestinationLabel(diagnostics: ProjectEmbeddingDiagnostics): string {
  if (diagnostics.destination === "local_ollama") {
    return "本机模型服务";
  }
  if (diagnostics.destination === "remote") {
    return "远程模型服务（发送前需再次确认）";
  }
  return "不可用";
}

function embeddingReasonLabel(reason: NonNullable<ProjectEmbeddingDiagnostics["reason"]>): string {
  const labels: Record<NonNullable<ProjectEmbeddingDiagnostics["reason"]>, string> = {
    no_embedding_route: "尚未安排用于查找相关资料的模型服务",
    embedding_profile_missing: "负责查找相关资料的模型设置不完整",
    embedding_route_profile_mismatch: "当前模型安排与已确认的设置不一致",
    native_gateway_unavailable: "浏览器开发模式无法使用本机模型服务",
    vector_store_unavailable: "额外的相关资料暂时不可用",
    vector_index_not_built: "尚未明确整理相关资料",
    embedding_configuration_changed: "模型或服务设置已变化，需要重新整理",
    authoritative_source_changed: "正文或大纲已变化，需要重新整理",
    vector_index_corrupt: "相关资料校验未通过",
    query_embedding_failed: "模型辅助查找未完成，已改用本地搜索",
  };
  return labels[reason];
}

function formatScore(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}
