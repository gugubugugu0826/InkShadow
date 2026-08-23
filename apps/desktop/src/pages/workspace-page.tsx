import { useCallback, useEffect, useState } from "react";
import type { Chapter, Project } from "@inkshadow/domain";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
} from "@inkshadow/ui";
import { Link, useParams } from "react-router-dom";
import { parseUuidV7 } from "@inkshadow/domain";

import { useOnlineStatus } from "../hooks/use-online-status";
import { useWritingExperience } from "../hooks/use-writing-experience";
import { normalizeUiError, projectOrdinaryUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";
import {
  calculateWorkspaceInsights,
  countReadyProseCandidates,
  type WorkspaceInsights,
  type WorkspaceVersionMetric,
} from "./workspace-insights";

export function WorkspacePage() {
  const runtime = useRuntime();
  const online = useOnlineStatus();
  const writingExperience = useWritingExperience();
  const professionalMode = writingExperience.preference?.mode === "professional";
  const params = useParams<{ projectId: string }>();
  const parsedProjectId = parseUuidV7(params.projectId ?? "");
  const projectId = parsedProjectId.ok ? parsedProjectId.value : null;
  const [project, setProject] = useState<Project | null>(null);
  const [chapters, setChapters] = useState<readonly Chapter[]>([]);
  const [pageState, setPageState] = useState<"loading" | "ready" | "empty" | "fatal_error">(
    "loading",
  );
  const [loadError, setLoadError] = useState<unknown>(
    parsedProjectId.ok ? null : parsedProjectId.error,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [createLocalOnly, setCreateLocalOnly] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [insights, setInsights] = useState<WorkspaceInsights | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<unknown>(null);
  const [pendingCandidateChapterId, setPendingCandidateChapterId] = useState<string | null>(null);

  const loadInsights = useCallback(
    async (chapterList: readonly Chapter[]): Promise<void> => {
      setInsightsLoading(true);
      setInsightsError(null);
      const rows = await Promise.all(
        chapterList.map(async (chapter) => {
          const [versions, candidates] = await Promise.all([
            runtime.repositories.chapterVersions.listByChapterId(chapter.id),
            runtime.repositories.aiCandidates.listByChapterId(chapter.id),
          ]);
          return { chapter, versions, candidates } as const;
        }),
      );
      const failedRow = rows.find(({ versions, candidates }) => !versions.ok || !candidates.ok);
      if (failedRow !== undefined) {
        setInsightsError(
          !failedRow.versions.ok
            ? failedRow.versions.error
            : !failedRow.candidates.ok
              ? failedRow.candidates.error
              : new Error("工作区统计读取失败"),
        );
        setInsights(null);
        setPendingCandidateChapterId(null);
        setInsightsLoading(false);
        return;
      }

      const versionMetrics: WorkspaceVersionMetric[] = [];
      let readyCandidateCount = 0;
      let firstPendingChapterId: string | null = null;
      for (const row of rows) {
        if (!row.versions.ok || !row.candidates.ok) continue;
        versionMetrics.push(
          ...row.versions.value.map((version) => {
            const snapshot = version.toSnapshot();
            return {
              chapterId: snapshot.chapterId,
              contentLength: snapshot.content.length,
              createdAt: snapshot.createdAt,
            };
          }),
        );
        const chapterReadyCount = countReadyProseCandidates(row.candidates.value);
        readyCandidateCount += chapterReadyCount;
        if (firstPendingChapterId === null && chapterReadyCount > 0) {
          firstPendingChapterId = row.chapter.id;
        }
      }
      setInsights(calculateWorkspaceInsights(versionMetrics, readyCandidateCount));
      setPendingCandidateChapterId(firstPendingChapterId);
      setInsightsLoading(false);
    },
    [runtime],
  );

  const load = useCallback(async () => {
    if (projectId === null) {
      setPageState("fatal_error");
      return;
    }
    setPageState("loading");
    const [projectResult, chapterResult] = await Promise.all([
      runtime.repositories.projects.findById(projectId),
      runtime.repositories.chapters.listByProjectId(projectId),
    ]);
    if (!projectResult.ok || !chapterResult.ok || projectResult.value === null) {
      setLoadError(
        !projectResult.ok
          ? projectResult.error
          : !chapterResult.ok
            ? chapterResult.error
            : new Error("项目不存在"),
      );
      setPageState("fatal_error");
      return;
    }
    setProject(projectResult.value);
    setChapters(chapterResult.value);
    setLoadError(null);
    setPageState(chapterResult.value.length === 0 ? "empty" : "ready");
    void loadInsights(chapterResult.value);
  }, [loadInsights, projectId, runtime]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function createChapter(): Promise<void> {
    if (projectId === null) {
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const result = await runtime.useCases.createChapter.execute({
      projectId,
      title,
      privacyMode: createLocalOnly ? "local_only" : "standard",
    });
    setSubmitting(false);
    if (!result.ok) {
      setFormError(normalizeUiError(result.error).description);
      return;
    }
    setTitle("");
    setCreateLocalOnly(false);
    setCreateOpen(false);
    await load();
  }

  const normalizedError = loadError === null ? null : projectOrdinaryUiError(loadError);
  const normalizedInsightsError =
    insightsError === null ? null : projectOrdinaryUiError(insightsError);
  const readonly = project?.status !== "active";
  const activeChapters = chapters.filter((chapter) => chapter.status === "active");
  const latestChapter = activeChapters.reduce<Chapter | null>((latest, current) => {
    if (latest === null) return current;
    return new Date(current.toSnapshot().updatedAt).getTime() >
      new Date(latest.toSnapshot().updatedAt).getTime()
      ? current
      : latest;
  }, null);
  const totalCharacters = activeChapters.reduce(
    (total, chapter) => total + chapter.content.length,
    0,
  );

  if (writingExperience.preference === null) {
    return (
      <div className="desktop-page" aria-busy={writingExperience.loading}>
        {writingExperience.loading ? (
          <div role="status">正在读取写作方式…</div>
        ) : (
          <ErrorState
            title="暂时无法打开作品"
            description={writingExperience.error ?? "写作方式没有读取成功，请重试。"}
            primaryAction={{ label: "重试", onClick: () => void writingExperience.refresh() }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="desktop-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to="/projects">
            返回项目
          </Link>
          <h1>{project?.name ?? "项目工作区"}</h1>
          <p>选择一章继续写，草稿与版本会自动保存在当前设备。</p>
        </div>
        <div className="settings-actions">
          <Button disabled={readonly} onClick={() => setCreateOpen(true)}>
            新建章节
          </Button>
        </div>
      </header>

      {!online && (
        <InlineAlert
          tone="warning"
          title="当前处于离线状态"
          description={
            professionalMode
              ? "章节和本地草稿仍可编辑；需要联网的模型能力暂不可用。"
              : "章节和本地草稿仍可编辑；需要联网的创作服务暂不可用。"
          }
        />
      )}

      {readonly && project !== null && (
        <InlineAlert
          tone="info"
          title={project.status === "archived" ? "项目已归档" : "项目位于回收站"}
          description="当前工作区保持可读；恢复到可编辑状态后才能创建新章节。"
        />
      )}

      {normalizedInsightsError !== null && (
        <InlineAlert
          tone="warning"
          title="写作统计暂时不可用"
          description={`${normalizedInsightsError.description} 章节和正文仍可正常打开。`}
          action={{
            label: "重试统计",
            onClick: () => void loadInsights(chapters),
          }}
          onDismiss={() => setInsightsError(null)}
        />
      )}

      <PageStateBoundary
        state={pageState}
        preserveContent={false}
        fallbacks={{
          empty: (
            <EmptyState
              title="还没有章节"
              description="创建第一章，开始在本地写作。"
              {...(readonly
                ? {}
                : {
                    primaryAction: {
                      label: "新建章节",
                      onClick: () => setCreateOpen(true),
                    },
                  })}
            />
          ),
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
        {latestChapter !== null && (
          <section className="workspace-resume" aria-labelledby="workspace-resume-title">
            <div>
              <p className="page-heading__eyebrow">上次写到</p>
              <h2 id="workspace-resume-title">{latestChapter.title}</h2>
              <p>
                {latestChapter.content.trim().length === 0
                  ? "这一章还是空白的，可以从第一句话开始。"
                  : `${latestChapter.content.trim().slice(0, 120)}${
                      latestChapter.content.trim().length > 120 ? "…" : ""
                    }`}
              </p>
            </div>
            <Link
              className="button-link workspace-resume__action"
              to={`/projects/${latestChapter.projectId}/chapters/${latestChapter.id}`}
            >
              {readonly ? "继续阅读" : "继续写作"}
            </Link>
          </section>
        )}

        <section className="workspace-insights" aria-label="作品进度">
          <article>
            <span>正文总字数</span>
            <strong>{totalCharacters.toLocaleString("zh-CN")}</strong>
          </article>
          <article>
            <span>今日净变化</span>
            <strong>
              {insightsLoading || insights === null
                ? "—"
                : formatSignedCharacters(insights.todayNetCharacters)}
            </strong>
          </article>
          <article>
            <span>当前连续写作</span>
            <strong>
              {insightsLoading || insights === null
                ? "—"
                : `${String(insights.currentStreakDays)} 天`}
            </strong>
          </article>
          <article>
            <span>待处理生成结果</span>
            <strong>
              {insightsLoading || insights === null
                ? "—"
                : `${String(insights.readyCandidateCount)} 份`}
            </strong>
            {pendingCandidateChapterId !== null && (
              <Link
                className="back-link"
                to={`/projects/${projectId ?? ""}/chapters/${pendingCandidateChapterId}`}
              >
                查看
              </Link>
            )}
          </article>
        </section>

        <section aria-labelledby="chapters-title">
          <div className="section-heading">
            <h2 id="chapters-title">章节</h2>
            <Badge>{chapters.length} 章</Badge>
          </div>
          <div className="chapter-list">
            {chapters.map((chapter, index) => (
              <Card key={chapter.id}>
                <CardHeader>
                  <div className="card-heading-row">
                    <span className="chapter-number">{String(index + 1).padStart(2, "0")}</span>
                    <CardTitle>{chapter.title}</CardTitle>
                    {chapter.isLocalOnly && <Badge tone="success">本地私密</Badge>}
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="chapter-excerpt">
                    {chapter.content.trim().length === 0
                      ? "空白章节"
                      : `${chapter.content.trim().slice(0, 90)}${
                          chapter.content.trim().length > 90 ? "…" : ""
                        }`}
                  </p>
                  <div className="chapter-row-meta">
                    <span>{chapter.content.length} 字符</span>
                    <span>版本 {chapter.revision}</span>
                    <Link
                      className="button-link"
                      to={`/projects/${chapter.projectId}/chapters/${chapter.id}`}
                    >
                      {readonly ? "阅读" : "继续写作"}
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </PageStateBoundary>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open && !submitting) {
            setCreateLocalOnly(false);
          }
        }}
        title="新建章节"
        description={
          professionalMode
            ? "创建时会同时生成首个稳定版本；私密章节会从第一笔事务起阻止云端投影。"
            : "创建时会同时保存第一个稳定版本；私密章节只会在当前设备处理。"
        }
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setCreateOpen(false);
                setCreateLocalOnly(false);
              }}
            >
              取消
            </Button>
            <Button
              loading={submitting}
              disabled={title.trim().length === 0}
              onClick={() => void createChapter()}
            >
              创建章节
            </Button>
          </>
        }
      >
        <FormField label="章节标题" error={formError ?? undefined} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  !submitting &&
                  title.trim().length > 0
                ) {
                  event.preventDefault();
                  void createChapter();
                }
              }}
            />
          )}
        </FormField>
        <label className="private-export-option" htmlFor="workspace-create-private-chapter">
          <input
            id="workspace-create-private-chapter"
            type="checkbox"
            checked={createLocalOnly}
            disabled={submitting}
            onChange={(event) => setCreateLocalOnly(event.currentTarget.checked)}
          />
          <span>
            创建为私密章节
            <small>
              {professionalMode
                ? "正文、摘要、检索、审稿和续写只允许使用已验证的本地模型；未配置本地模型时会安全停止。"
                : "正文和相关资料只允许在当前设备处理；条件不足时会安全停止。"}
            </small>
          </span>
        </label>
      </Dialog>
    </div>
  );
}

function formatSignedCharacters(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("zh-CN")}`;
}
