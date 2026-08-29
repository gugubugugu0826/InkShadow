import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Chapter, Project } from "@inkshadow/domain";
import { parseUuidV7 as parseDomainUuid } from "@inkshadow/domain";
import {
  type Outline,
  type OutlineNodeSnapshot,
  parseUuidV7 as parseStoryUuid,
} from "@inkshadow/story-core";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
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
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  captureMountedComponentPath,
  useComponentOwnershipPath,
} from "../components/component-ownership-context";
import { StoryPlanningPanel } from "../components/story-planning-panel";
import type { ChapterSummaryDashboardEntry } from "../infrastructure/chapter-summary-service";
import {
  recordProjectAreaReadIncident,
  recoverUiRouteIncident,
  type ProjectAreaReadStage,
} from "../infrastructure/ui-route-diagnostics";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

interface AddTarget {
  readonly kind: "volume" | "chapter";
  readonly parentId: string;
}

function summaryStateLabel(state: ChapterSummaryDashboardEntry["state"] | undefined): string {
  switch (state) {
    case "current":
      return "摘要已更新";
    case "stale":
      return "摘要待更新";
    case "invalid":
      return "摘要不可用";
    case "missing":
    case undefined:
      return "尚无摘要";
  }
}

function summaryStateTone(
  state: ChapterSummaryDashboardEntry["state"] | undefined,
): "success" | "warning" | "danger" | "neutral" {
  return state === "current"
    ? "success"
    : state === "stale"
      ? "warning"
      : state === "invalid"
        ? "danger"
        : "neutral";
}

export function StoryOutlinePage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const params = useParams<{ projectId: string }>();
  const projectIdParameter = params.projectId ?? "";
  const diagnosticRoute = `/projects/${projectIdParameter}/outline`;
  const componentOwnershipPath = useComponentOwnershipPath("StoryOutlinePage");
  const domainProjectId = useMemo(() => parseDomainUuid(projectIdParameter), [projectIdParameter]);
  const storyProjectId = useMemo(() => parseStoryUuid(projectIdParameter), [projectIdParameter]);
  const identifierError = !domainProjectId.ok
    ? domainProjectId.error
    : !storyProjectId.ok
      ? storyProjectId.error
      : null;
  const [project, setProject] = useState<Project | null>(null);
  const [writtenChapters, setWrittenChapters] = useState<readonly Chapter[]>([]);
  const [chapterSummaries, setChapterSummaries] = useState<readonly ChapterSummaryDashboardEntry[]>(
    [],
  );
  const [outline, setOutline] = useState<Outline | null>(null);
  const [pageState, setPageState] = useState<"loading" | "ready" | "empty" | "fatal_error">(
    "loading",
  );
  const [error, setError] = useState<unknown>(identifierError);
  const [busy, setBusy] = useState(false);
  const [addTarget, setAddTarget] = useState<AddTarget | null>(null);
  const [editingNode, setEditingNode] = useState<OutlineNodeSnapshot | null>(null);
  const [title, setTitle] = useState("");
  const loadSequence = useRef(0);
  const routeIdentityRef = useRef(diagnosticRoute);
  const operationSequence = useRef(0);
  useLayoutEffect(() => {
    routeIdentityRef.current = diagnosticRoute;
    operationSequence.current += 1;
    return () => {
      routeIdentityRef.current = "";
      operationSequence.current += 1;
    };
  }, [diagnosticRoute]);
  const activeLoadIncident = useRef<Readonly<{ id: string; route: string }> | null>(null);
  const [loadSupportId, setLoadSupportId] = useState<string | null>(null);
  const [derivedReadWarning, setDerivedReadWarning] = useState<Readonly<{
    section: string;
    supportId: string;
  }> | null>(null);

  const recordLoadFailure = useCallback(
    (readStage: ProjectAreaReadStage, cause: unknown, reasonCodeChain: readonly string[]) => {
      const incident = recordProjectAreaReadIncident(runtime, {
        route: diagnosticRoute,
        readStage,
        cause,
        timestamp: runtime.clock.now(),
        componentName: "StoryOutlinePage",
        reasonCodeChain,
        componentStack: captureMountedComponentPath(componentOwnershipPath),
      });
      activeLoadIncident.current = { id: incident.diagnosticId, route: diagnosticRoute };
      setLoadSupportId(incident.diagnosticId);
      return incident.diagnosticId;
    },
    [componentOwnershipPath, diagnosticRoute, runtime],
  );

  const load = useCallback(async () => {
    const expectedRoute = diagnosticRoute;
    if (routeIdentityRef.current !== expectedRoute) return;
    const requestSequence = loadSequence.current + 1;
    loadSequence.current = requestSequence;
    setLoadSupportId(null);
    if (!domainProjectId.ok || !storyProjectId.ok) {
      const cause = identifierError ?? new Error("项目编号不可用");
      recordLoadFailure("route_identity", cause, ["INVALID_UUID"]);
      setProject(null);
      setWrittenChapters([]);
      setChapterSummaries([]);
      setOutline(null);
      setError(cause);
      setPageState("fatal_error");
      return;
    }
    setPageState("loading");
    const [projectResult, outlineResult, chapterResult, summaryDashboard] = await Promise.all([
      runtime.repositories.projects.findById(domainProjectId.value),
      runtime.story.outlines.findByProjectId(storyProjectId.value),
      runtime.repositories.chapters.listByProjectId(domainProjectId.value),
      runtime.story.chapterSummaries.inspectProject(projectIdParameter).then(
        (dashboard) => Object.freeze({ ok: true as const, dashboard }),
        (cause: unknown) => Object.freeze({ ok: false as const, cause }),
      ),
    ]);
    if (loadSequence.current !== requestSequence || routeIdentityRef.current !== expectedRoute)
      return;
    if (!projectResult.ok) {
      recordLoadFailure("project", projectResult.error, ["REPOSITORY_ERROR"]);
      setError(projectResult.error);
      setPageState("fatal_error");
      return;
    }
    if (projectResult.value === null) {
      const cause = Object.assign(new Error("项目不存在"), { code: "PROJECT_NOT_FOUND" });
      recordLoadFailure("project", cause, ["PROJECT_NOT_FOUND"]);
      setError(cause);
      setPageState("fatal_error");
      return;
    }
    if (!outlineResult.ok) {
      recordLoadFailure("outline", outlineResult.error, ["REPOSITORY_ERROR"]);
      setError(outlineResult.error);
      setPageState("fatal_error");
      return;
    }
    if (!chapterResult.ok) {
      recordLoadFailure("chapter_list", chapterResult.error, ["REPOSITORY_ERROR"]);
      setError(chapterResult.error);
      setPageState("fatal_error");
      return;
    }
    setProject(projectResult.value);
    setWrittenChapters(chapterResult.value.filter(({ status }) => status === "active"));
    setChapterSummaries(
      summaryDashboard.ok ? summaryDashboard.dashboard.entries : Object.freeze([]),
    );
    setOutline(outlineResult.value);
    if (activeLoadIncident.current?.route === diagnosticRoute) {
      recoverUiRouteIncident(runtime, activeLoadIncident.current.id, runtime.clock.now());
      activeLoadIncident.current = null;
    }
    setError(null);
    if (summaryDashboard.ok) {
      setDerivedReadWarning(null);
    } else {
      const supportId = recordLoadFailure("outline", summaryDashboard.cause, ["REPOSITORY_ERROR"]);
      setDerivedReadWarning({
        section: "章节摘要",
        supportId,
      });
    }
    setPageState(outlineResult.value === null ? "empty" : "ready");
  }, [
    diagnosticRoute,
    domainProjectId,
    identifierError,
    projectIdParameter,
    recordLoadFailure,
    runtime,
    storyProjectId,
  ]);

  useEffect(() => {
    void Promise.resolve().then(load);
    return () => {
      loadSequence.current += 1;
      operationSequence.current += 1;
    };
  }, [load]);

  const snapshot = outline?.toSnapshot() ?? null;
  const book = snapshot?.nodes.find((node) => node.kind === "book") ?? null;
  const volumes = useMemo(
    () => (outline === null || book === null ? [] : outline.orderedChildren(book.id)),
    [book, outline],
  );
  const firstEditableVolume = volumes.find((volume) => !volume.locked) ?? null;
  const readonly = project?.status !== "active";
  const normalizedError = error === null ? null : projectOrdinaryUiError(error);
  const currentOutline = outline;
  function beginOperation(): Readonly<{ route: string; sequence: number }> {
    const sequence = operationSequence.current + 1;
    operationSequence.current = sequence;
    return Object.freeze({ route: diagnosticRoute, sequence });
  }

  function isCurrentOperation(operation: Readonly<{ route: string; sequence: number }>): boolean {
    return (
      routeIdentityRef.current === operation.route &&
      operationSequence.current === operation.sequence
    );
  }

  async function createOutline(): Promise<void> {
    if (project === null || busy) {
      return;
    }
    setBusy(true);
    const operation = beginOperation();
    const result = await runtime.story.outlineService.create({
      projectId: project.id,
      title: project.name,
      synopsis: "在这里把长篇拆分为卷与章节；不使用 AI 也可完整编辑。",
    });
    if (!isCurrentOperation(operation)) return;
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOutline(result.value);
    setPageState("ready");
  }

  async function applyChange(
    change: Parameters<typeof runtime.story.outlineService.apply>[0]["change"],
  ): Promise<boolean> {
    if (outline === null || project === null || readonly) {
      return false;
    }
    setBusy(true);
    const operation = beginOperation();
    const result = await runtime.story.outlineService.apply({
      projectId: project.id,
      expectedRevision: outline.revision,
      change,
    });
    if (!isCurrentOperation(operation)) return false;
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setOutline(result.value);
    setError(null);
    return true;
  }

  async function submitAdd(): Promise<void> {
    if (addTarget === null) {
      return;
    }
    const completed = await applyChange({
      kind: "add",
      nodeKind: addTarget.kind,
      parentId: addTarget.parentId,
      title,
    });
    if (completed) {
      setAddTarget(null);
      setTitle("");
    }
  }

  async function submitRename(): Promise<void> {
    if (editingNode === null) {
      return;
    }
    const completed = await applyChange({
      kind: "rename",
      nodeId: editingNode.id,
      title,
    });
    if (completed) {
      setEditingNode(null);
      setTitle("");
    }
  }

  function openAdd(target: AddTarget): void {
    setTitle("");
    setAddTarget(target);
  }

  function openRename(node: OutlineNodeSnapshot): void {
    setTitle(node.title);
    setEditingNode(node);
  }

  return (
    <div className="desktop-page story-outline-page">
      <header className="page-heading">
        <div>
          <Link className="back-link" to={`/projects/${params.projectId ?? ""}`}>
            返回工作区
          </Link>
          <h1>{project?.name ?? "故事大纲"}</h1>
          <p>稳定三层结构：书 → 卷 → 章。锁定节点后不会被误改或重排。</p>
        </div>
        <div className="story-outline-summary">
          {outline !== null && <Badge>修订 {String(outline.revision)}</Badge>}
          {outline !== null && book !== null && (
            <Button
              disabled={readonly || busy || book.locked}
              onClick={() =>
                openAdd({
                  kind: "volume",
                  parentId: book.id,
                })
              }
            >
              新增卷
            </Button>
          )}
        </div>
      </header>

      {runtime.mode === "browser-development" && (
        <InlineAlert
          tone="warning"
          title="浏览器开发模式"
          description="此处仅使用浏览器调试存储验证交互；桌面发行版使用同一领域规则和本地数据库事务。"
        />
      )}

      {derivedReadWarning !== null && (
        <InlineAlert
          tone="warning"
          title="章节摘要暂不可用"
          description={`${derivedReadWarning.section}没有读取成功；正文和大纲仍可使用，也没有删除任何记录。问题编号：${derivedReadWarning.supportId}（联系支持时提供）。`}
        />
      )}

      {readonly && project !== null && (
        <InlineAlert
          tone="info"
          title={project.status === "archived" ? "项目已归档" : "项目位于回收站"}
          description="大纲保持可读，恢复项目后才能修改。"
        />
      )}

      {normalizedError !== null && pageState !== "fatal_error" && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={normalizedError.description}
          onDismiss={() => setError(null)}
        />
      )}

      {project !== null && (
        <section className="written-chapter-plan" aria-labelledby="written-chapter-plan-title">
          <div className="section-heading">
            <div>
              <h2 id="written-chapter-plan-title">已经写下的章节</h2>
              <p>这里来自真实正文；大纲节点只是规划，不会删除或覆盖已经写好的章节。</p>
            </div>
            <Badge>{writtenChapters.length.toLocaleString("zh-CN")} 章</Badge>
          </div>
          {writtenChapters.length === 0 ? (
            <EmptyState
              title="还没有正文章节"
              description="大纲是可选的。你可以先回到正文创建第一章，也可以继续在这里规划。"
              secondaryAction={{
                label: "去写正文",
                onClick: () => {
                  void navigate(`/projects/${projectIdParameter}`);
                },
              }}
            />
          ) : (
            <ol className="written-chapter-plan__list">
              {writtenChapters.map((chapter, index) => {
                const summary = chapterSummaries.find((entry) => entry.chapterId === chapter.id);
                return (
                  <li key={chapter.id}>
                    <span className="chapter-number">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <Link
                        className="back-link"
                        to={`/projects/${projectIdParameter}/chapters/${chapter.id}`}
                      >
                        {chapter.title}
                      </Link>
                      <p>
                        {summary?.summary ??
                          (chapter.content.trim().length === 0
                            ? "正文还是空白，可以直接开始写。"
                            : "还没有可用的一句话摘要；不会用猜测内容代替。")}
                      </p>
                    </div>
                    <Badge tone={summaryStateTone(summary?.state)}>
                      {summaryStateLabel(summary?.state)}
                    </Badge>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}

      <PageStateBoundary
        state={pageState}
        preserveContent={false}
        fallbacks={{
          empty: (
            <EmptyState
              title="还没有故事大纲"
              description="可以先列一个简单结构，也可以暂时跳过，直接去写第一章。大纲不是开始创作的前置条件。"
              {...(readonly
                ? {}
                : {
                    primaryAction: {
                      label: busy ? "正在创建…" : "先列简单大纲",
                      onClick: () => void createOutline(),
                    },
                    secondaryAction: {
                      label: "暂时跳过，去写正文",
                      onClick: () => {
                        void navigate(`/projects/${projectIdParameter}`);
                      },
                    },
                  })}
            />
          ),
          fatal_error:
            normalizedError === null ? undefined : (
              <ErrorState
                title={normalizedError.title}
                description={`${normalizedError.description}${
                  loadSupportId === null ? "" : ` 问题编号：${loadSupportId}（联系支持时提供）。`
                }`}
                primaryAction={{ label: "重试", onClick: () => void load() }}
              />
            ),
        }}
      >
        {book !== null && currentOutline !== null && project !== null && (
          <>
            <StoryPlanningPanel
              projectId={project.id}
              outline={currentOutline}
              service={runtime.story.storyPlanning}
              disabled={readonly || busy}
              {...(book.locked
                ? {}
                : { onCreateVolume: () => openAdd({ kind: "volume", parentId: book.id }) })}
              {...(firstEditableVolume === null
                ? {}
                : {
                    onAddChapter: () =>
                      openAdd({ kind: "chapter", parentId: firstEditableVolume.id }),
                  })}
              onOutlineChanged={load}
            />
            <section aria-labelledby="outline-structure-title">
              <div className="section-heading">
                <div>
                  <h2 id="outline-structure-title">{book.title}</h2>
                  {book.synopsis.length > 0 && <p>{book.synopsis}</p>}
                </div>
                <Badge tone={book.locked ? "warning" : "success"}>
                  {book.locked ? "全书结构已锁定" : "可编辑"}
                </Badge>
              </div>

              {volumes.length === 0 ? (
                <EmptyState
                  title="还没有卷"
                  description="可以先添加第一卷安排章节，也可以继续写正文，稍后再回来规划。"
                  {...(readonly || book.locked
                    ? {}
                    : {
                        primaryAction: {
                          label: "新增卷",
                          onClick: () => openAdd({ kind: "volume", parentId: book.id }),
                        },
                        secondaryAction: {
                          label: "去写正文",
                          onClick: () => {
                            void navigate(`/projects/${projectIdParameter}`);
                          },
                        },
                      })}
                />
              ) : (
                <div className="outline-volume-list">
                  {volumes.map((volume, volumeIndex) => (
                    <OutlineVolumeCard
                      key={volume.id}
                      outline={currentOutline}
                      volume={volume}
                      index={volumeIndex}
                      total={volumes.length}
                      readonly={readonly || busy || book.locked}
                      onAddChapter={() => openAdd({ kind: "chapter", parentId: volume.id })}
                      onRename={openRename}
                      onMove={(newIndex) =>
                        void applyChange({ kind: "move", nodeId: volume.id, newIndex })
                      }
                      onToggleLock={() =>
                        void applyChange({
                          kind: volume.locked ? "unlock" : "lock",
                          nodeId: volume.id,
                        })
                      }
                      onChapterMove={(nodeId, newIndex) =>
                        void applyChange({ kind: "move", nodeId, newIndex })
                      }
                      onChapterToggleLock={(chapter) =>
                        void applyChange({
                          kind: chapter.locked ? "unlock" : "lock",
                          nodeId: chapter.id,
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </PageStateBoundary>

      <Dialog
        open={addTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAddTarget(null);
          }
        }}
        title={addTarget?.kind === "chapter" ? "新增章节节点" : "新增卷"}
        description="这里只规划结构；正式正文仍在写作编辑器中保存。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddTarget(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={title.trim().length === 0}
              onClick={() => void submitAdd()}
            >
              添加
            </Button>
          </>
        }
      >
        <FormField label={addTarget?.kind === "chapter" ? "章节标题" : "卷标题"} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          )}
        </FormField>
      </Dialog>

      <Dialog
        open={editingNode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingNode(null);
          }
        }}
        title="重命名大纲节点"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditingNode(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={title.trim().length === 0}
              onClick={() => void submitRename()}
            >
              保存
            </Button>
          </>
        }
      >
        <FormField label="节点标题" required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          )}
        </FormField>
      </Dialog>
    </div>
  );
}

interface OutlineVolumeCardProps {
  readonly outline: Outline;
  readonly volume: OutlineNodeSnapshot;
  readonly index: number;
  readonly total: number;
  readonly readonly: boolean;
  readonly onAddChapter: () => void;
  readonly onRename: (node: OutlineNodeSnapshot) => void;
  readonly onMove: (newIndex: number) => void;
  readonly onToggleLock: () => void;
  readonly onChapterMove: (nodeId: string, newIndex: number) => void;
  readonly onChapterToggleLock: (chapter: OutlineNodeSnapshot) => void;
}

function OutlineVolumeCard({
  index,
  onAddChapter,
  onChapterMove,
  onChapterToggleLock,
  onMove,
  onRename,
  onToggleLock,
  outline,
  readonly,
  total,
  volume,
}: OutlineVolumeCardProps) {
  const chapters = outline.orderedChildren(volume.id);
  const controlsDisabled = readonly || volume.locked;
  return (
    <Card className="outline-volume-card">
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle>
              第 {String(index + 1)} 卷 · {volume.title}
            </CardTitle>
            <CardDescription>
              {String(chapters.length)} 个章节节点 · {volume.locked ? "已锁定" : "可编辑"}
            </CardDescription>
          </div>
          <Badge tone={volume.locked ? "warning" : "neutral"}>
            {volume.locked ? "锁定" : "草稿"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="outline-node-actions">
          <Button size="sm" variant="secondary" disabled={controlsDisabled} onClick={onAddChapter}>
            添加章节
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={controlsDisabled}
            onClick={() => onRename(volume)}
          >
            重命名
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={controlsDisabled || index === 0}
            onClick={() => onMove(index - 1)}
          >
            上移
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={controlsDisabled || index === total - 1}
            onClick={() => onMove(index + 1)}
          >
            下移
          </Button>
          <Button size="sm" variant="ghost" disabled={readonly} onClick={onToggleLock}>
            {volume.locked ? "解锁" : "锁定"}
          </Button>
        </div>
        <p className="outline-lock-explanation">锁定后不会被意外移动或重命名。</p>

        {chapters.length === 0 ? (
          <p className="outline-empty-chapters">本卷还没有章节节点。</p>
        ) : (
          <ol className="outline-chapter-list">
            {chapters.map((chapter, chapterIndex) => (
              <li key={chapter.id}>
                <div>
                  <span className="chapter-number">
                    {String(chapterIndex + 1).padStart(2, "0")}
                  </span>
                  <strong>{chapter.title}</strong>
                </div>
                <div className="outline-chapter-actions">
                  <Badge tone={chapter.locked ? "warning" : "neutral"}>
                    {chapter.locked ? "锁定" : "计划"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={controlsDisabled || chapter.locked}
                    onClick={() => onRename(chapter)}
                  >
                    重命名
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={controlsDisabled || chapter.locked || chapterIndex === 0}
                    onClick={() => onChapterMove(chapter.id, chapterIndex - 1)}
                  >
                    上移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={
                      controlsDisabled || chapter.locked || chapterIndex === chapters.length - 1
                    }
                    onClick={() => onChapterMove(chapter.id, chapterIndex + 1)}
                  >
                    下移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={readonly || volume.locked}
                    onClick={() => onChapterToggleLock(chapter)}
                  >
                    {chapter.locked ? "解锁" : "锁定"}
                  </Button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
