import { useCallback, useEffect, useState } from "react";
import type { Project, ProjectStatus } from "@inkshadow/domain";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@inkshadow/ui";
import { Link } from "react-router-dom";

import { useOnlineStatus } from "../hooks/use-online-status";
import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

const statusLabels: Record<ProjectStatus, string> = {
  active: "进行中",
  archived: "已归档",
  trashed: "回收站",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ProjectsPage() {
  const runtime = useRuntime();
  const online = useOnlineStatus();
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [pageState, setPageState] = useState<"loading" | "ready" | "empty" | "fatal_error">(
    "loading",
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setPageState("loading");
    const result = await runtime.useCases.listProjects.execute({
      statuses: [status],
      search,
    });
    if (!result.ok) {
      setLoadError(result.error);
      setPageState("fatal_error");
      return;
    }
    setProjects(result.value);
    setLoadError(null);
    setPageState(result.value.length === 0 ? "empty" : "ready");
  }, [runtime, search, status]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadProjects();
    }, 180);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [loadProjects]);

  async function createProject(): Promise<void> {
    setSubmitting(true);
    setFormError(null);
    const result = await runtime.useCases.createProject.execute({ name: projectName });
    setSubmitting(false);
    if (!result.ok) {
      setFormError(normalizeUiError(result.error).description);
      return;
    }
    setProjectName("");
    setCreateOpen(false);
    setStatus("active");
    await loadProjects();
  }

  async function runLifecycleAction(
    project: Project,
    action: "archive" | "unarchive" | "trash" | "restore",
  ): Promise<void> {
    setPendingProjectId(project.id);
    const result =
      action === "archive"
        ? await runtime.useCases.archiveProject.execute({ projectId: project.id })
        : action === "unarchive"
          ? await runtime.useCases.unarchiveProject.execute({ projectId: project.id })
          : action === "trash"
            ? await runtime.useCases.trashProject.execute({ projectId: project.id })
            : await runtime.useCases.restoreProject.execute({ projectId: project.id });
    setPendingProjectId(null);
    if (!result.ok) {
      setLoadError(result.error);
      setPageState("fatal_error");
      return;
    }
    await loadProjects();
  }

  function openRenameDialog(project: Project): void {
    setRenameTarget(project);
    setRenameName(project.name);
    setRenameError(null);
  }

  async function renameProject(): Promise<void> {
    if (renameTarget === null) {
      return;
    }
    setRenameSubmitting(true);
    setRenameError(null);
    const result = await runtime.useCases.renameProject.execute({
      projectId: renameTarget.id,
      name: renameName,
    });
    setRenameSubmitting(false);
    if (!result.ok) {
      setRenameError(normalizeUiError(result.error).description);
      return;
    }
    setRenameTarget(null);
    await loadProjects();
  }

  const normalizedLoadError = loadError === null ? null : normalizeUiError(loadError);

  return (
    <div className="desktop-page">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">本地创作空间</p>
          <h1>项目</h1>
          <p>创建、归档和恢复项目。回收站项目保留 30 天。</p>
        </div>
        <div className="page-heading__actions">
          <Link className="button-link" to="/ideation">
            开书构思
          </Link>
          <Button onClick={() => setCreateOpen(true)}>新建项目</Button>
        </div>
      </header>

      {!online && (
        <InlineAlert
          tone="warning"
          title="当前处于离线状态"
          description="项目仍会保存在此设备；需要联网的模型能力暂不可用。"
        />
      )}

      <div className="projects-toolbar">
        <FormField label="搜索项目" optionalLabel="">
          {(fieldProps) => (
            <Input
              {...fieldProps}
              type="search"
              value={search}
              placeholder="输入项目名称"
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          )}
        </FormField>
      </div>

      <Tabs
        value={status}
        defaultValue="active"
        onValueChange={(value) => setStatus(value as ProjectStatus)}
      >
        <TabsList label="项目状态">
          <TabsTrigger value="active">进行中</TabsTrigger>
          <TabsTrigger value="archived">已归档</TabsTrigger>
          <TabsTrigger value="trashed">回收站</TabsTrigger>
        </TabsList>
        {(["active", "archived", "trashed"] as const).map((tabStatus) => (
          <TabsContent key={tabStatus} value={tabStatus}>
            <PageStateBoundary
              state={pageState}
              preserveContent={false}
              fallbacks={{
                empty:
                  status === "active" && search.length === 0 ? (
                    <FirstLaunchState onCreate={() => setCreateOpen(true)} />
                  ) : (
                    <EmptyState
                      kind={search.length > 0 ? "no_results" : "no_data"}
                      title={search.length > 0 ? "没有匹配的项目" : `${statusLabels[status]}为空`}
                      description={
                        search.length > 0
                          ? "尝试缩短搜索词，或切换项目状态。"
                          : "这里暂时没有项目。"
                      }
                    />
                  ),
                fatal_error:
                  normalizedLoadError === null ? undefined : (
                    <ErrorState
                      title={normalizedLoadError.title}
                      description={normalizedLoadError.description}
                      errorCode={normalizedLoadError.code}
                      primaryAction={{ label: "重试", onClick: () => void loadProjects() }}
                    />
                  ),
              }}
            >
              <div className="project-grid">
                {projects.map((project) => {
                  const snapshot = project.toSnapshot();
                  const pending = pendingProjectId === project.id;
                  return (
                    <Card key={project.id}>
                      <CardHeader>
                        <div className="card-heading-row">
                          <CardTitle>{project.name}</CardTitle>
                          <Badge
                            tone={
                              project.status === "active"
                                ? "success"
                                : project.status === "trashed"
                                  ? "danger"
                                  : "neutral"
                            }
                          >
                            {statusLabels[project.status]}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="project-meta">
                          更新于{" "}
                          <time dateTime={snapshot.updatedAt}>
                            {formatDate(snapshot.updatedAt)}
                          </time>
                        </p>
                        {project.retentionUntil !== null && (
                          <p className="project-retention">
                            可恢复至{" "}
                            <time dateTime={project.retentionUntil}>
                              {formatDate(project.retentionUntil)}
                            </time>
                          </p>
                        )}
                      </CardContent>
                      <CardFooter>
                        {project.status !== "trashed" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => openRenameDialog(project)}
                          >
                            重命名
                          </Button>
                        )}
                        {project.status !== "trashed" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={pending}
                            onClick={() => void runLifecycleAction(project, "trash")}
                          >
                            移到回收站
                          </Button>
                        )}
                        {project.status === "active" && (
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={pending}
                            onClick={() => void runLifecycleAction(project, "archive")}
                          >
                            归档
                          </Button>
                        )}
                        {project.status === "archived" && (
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={pending}
                            onClick={() => void runLifecycleAction(project, "unarchive")}
                          >
                            恢复编辑
                          </Button>
                        )}
                        {project.status === "trashed" ? (
                          <Button
                            size="sm"
                            loading={pending}
                            onClick={() => void runLifecycleAction(project, "restore")}
                          >
                            恢复
                          </Button>
                        ) : (
                          <Link className="button-link" to={`/projects/${project.id}`}>
                            打开
                          </Link>
                        )}
                      </CardFooter>
                    </Card>
                  );
                })}
              </div>
            </PageStateBoundary>
          </TabsContent>
        ))}
      </Tabs>

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="新建项目"
        description="项目正文与版本默认只保存在当前设备。"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button loading={submitting} onClick={() => void createProject()}>
              创建项目
            </Button>
          </>
        }
      >
        <FormField label="项目名称" error={formError ?? undefined} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={projectName}
              maxLength={120}
              onChange={(event) => setProjectName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !submitting) {
                  event.preventDefault();
                  void createProject();
                }
              }}
            />
          )}
        </FormField>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renameSubmitting) {
            setRenameTarget(null);
          }
        }}
        title="重命名项目"
        description="名称会立即保存到当前设备；其他项目名称不会受影响。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={renameSubmitting}
              onClick={() => setRenameTarget(null)}
            >
              取消
            </Button>
            <Button
              loading={renameSubmitting}
              disabled={renameName.trim().length === 0}
              onClick={() => void renameProject()}
            >
              保存名称
            </Button>
          </>
        }
      >
        <FormField label="项目名称" error={renameError ?? undefined} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              value={renameName}
              maxLength={120}
              onChange={(event) => setRenameName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && !renameSubmitting) {
                  event.preventDefault();
                  void renameProject();
                }
              }}
            />
          )}
        </FormField>
      </Dialog>
    </div>
  );
}

function FirstLaunchState({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <section className="first-launch" aria-labelledby="first-launch-title">
      <div className="first-launch__heading">
        <Badge tone="success">无需注册</Badge>
        <h2 id="first-launch-title">从本地开始创作</h2>
        <p>项目与正文默认仅保存在此设备；断网也能创建、编辑、恢复和导出。</p>
      </div>
      <div className="first-launch__actions">
        <Card>
          <CardHeader>
            <CardTitle>从构思开始</CardTitle>
          </CardHeader>
          <CardContent>
            <p>通过固定九步完成或明确跳过关键决定，再原子创建项目与开篇骨架。</p>
          </CardContent>
          <CardFooter>
            <Link className="button-link" to="/ideation">
              开书构思
            </Link>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>创建本地项目</CardTitle>
          </CardHeader>
          <CardContent>
            <p>从空白长篇开始，随后可手工建立大纲和第一章。</p>
          </CardContent>
          <CardFooter>
            <Button onClick={onCreate}>创建空白项目</Button>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>导入已有作品</CardTitle>
          </CardHeader>
          <CardContent>
            <p>先安全预检 TXT、Markdown 或 InkShadow Bundle，再一次性写入全部章节。</p>
          </CardContent>
          <CardFooter>
            <Link className="button-link" to="/settings#data-transfer">
              选择文件
            </Link>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>恢复备份</CardTitle>
          </CardHeader>
          <CardContent>
            <p>桌面版会先创建当前数据的回滚副本，再原子恢复 SQLite 备份。</p>
          </CardContent>
          <CardFooter>
            <Link className="button-link" to="/settings#local-maintenance">
              打开恢复工具
            </Link>
          </CardFooter>
        </Card>
      </div>
    </section>
  );
}
