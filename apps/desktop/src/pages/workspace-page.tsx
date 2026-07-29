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
import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

export function WorkspacePage() {
  const runtime = useRuntime();
  const online = useOnlineStatus();
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
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
  }, [projectId, runtime]);

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
    });
    setSubmitting(false);
    if (!result.ok) {
      setFormError(normalizeUiError(result.error).description);
      return;
    }
    setTitle("");
    setCreateOpen(false);
    await load();
  }

  const normalizedError = loadError === null ? null : normalizeUiError(loadError);
  const readonly = project?.status !== "active";

  return (
    <div className="desktop-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to="/projects">
            返回项目
          </Link>
          <h1>{project?.name ?? "项目工作区"}</h1>
          <p>章节正文、恢复草稿和版本均保存在本地持久层。</p>
        </div>
        <div className="settings-actions">
          {projectId !== null && (
            <>
              <Link
                className="button-link button-link--secondary"
                to={`/projects/${projectId}/search`}
              >
                搜索项目
              </Link>
              <Link className="button-link" to={`/projects/${projectId}/outline`}>
                故事大纲
              </Link>
              <Link
                className="button-link button-link--secondary"
                to={`/projects/${projectId}/story`}
              >
                故事治理
              </Link>
              {runtime.featureFlags.graphRag && runtime.storyGraph !== null && (
                <Link
                  className="button-link button-link--secondary"
                  to={`/projects/${projectId}/graph`}
                >
                  故事关系图
                </Link>
              )}
              {runtime.featureFlags.authoritativeExtraction &&
                runtime.authoritativeExtraction !== null && (
                  <Link
                    className="button-link button-link--secondary"
                    to={`/projects/${projectId}/extraction`}
                  >
                    权威事实抽取
                  </Link>
                )}
              <Link
                className="button-link button-link--secondary"
                to={`/projects/${projectId}/materials`}
              >
                素材治理
              </Link>
              {runtime.featureFlags.multiAgent && runtime.multiAgentReview !== null && (
                <Link
                  className="button-link button-link--secondary"
                  to={`/projects/${projectId}/multi-agent-review`}
                >
                  多 Agent 审查
                </Link>
              )}
              {runtime.featureFlags.fineTuning &&
                runtime.fineTuningGovernance?.availability.available === true && (
                  <Link
                    className="button-link button-link--secondary"
                    to={`/projects/${projectId}/fine-tuning`}
                  >
                    微调治理
                  </Link>
                )}
            </>
          )}
          <Button disabled={readonly} onClick={() => setCreateOpen(true)}>
            新建章节
          </Button>
        </div>
      </header>

      {!online && (
        <InlineAlert
          tone="warning"
          title="当前处于离线状态"
          description="章节和本地草稿仍可编辑；需要联网的模型能力暂不可用。"
        />
      )}

      {readonly && project !== null && (
        <InlineAlert
          tone="info"
          title={project.status === "archived" ? "项目已归档" : "项目位于回收站"}
          description="当前工作区保持可读；恢复到可编辑状态后才能创建新章节。"
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
                errorCode={normalizedError.code}
                primaryAction={{ label: "重试", onClick: () => void load() }}
              />
            ),
        }}
      >
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
        onOpenChange={setCreateOpen}
        title="新建章节"
        description="创建时会同时生成首个稳定版本。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button loading={submitting} onClick={() => void createChapter()}>
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
                if (event.key === "Enter" && !submitting) {
                  event.preventDefault();
                  void createChapter();
                }
              }}
            />
          )}
        </FormField>
      </Dialog>
    </div>
  );
}
