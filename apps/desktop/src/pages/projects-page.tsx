import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectDisplayIdentity } from "@inkshadow/application";
import {
  MAX_PROJECT_NAME_LENGTH,
  parseUuidV7,
  type Project,
  type ProjectStatus,
} from "@inkshadow/domain";
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
  useToast,
} from "@inkshadow/ui";
import { Link } from "react-router-dom";

import { useOnlineStatus } from "../hooks/use-online-status";
import { useWritingExperience } from "../hooks/use-writing-experience";
import type { CreativeJourneyRecord } from "../infrastructure/creative-journey-store";
import { normalizeUiError, projectOrdinaryUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";

const statusLabels: Record<ProjectStatus, string> = {
  active: "进行中",
  archived: "已归档",
  trashed: "回收站",
};

const ALL_PROJECT_STATUSES = ["active", "archived", "trashed"] as const;
const IMPORT_JOURNEY_STORAGE_KEY = "inkshadow.import-rewrite-journey.v2";

interface ImportJourneyLibraryProjection {
  readonly projectId: string;
  readonly projectName: string;
  readonly chapterCount: number;
  readonly analysisCompleted: boolean;
  readonly analysisFinishedJobs: number;
  readonly analysisTotalJobs: number;
  readonly hasRewriteTarget: boolean;
  readonly hasTrial: boolean;
  readonly hasSavedRules: boolean;
}

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
  const writingExperience = useWritingExperience();
  const directMode = writingExperience.preference?.mode === "direct";
  const { toast } = useToast();
  const loadRequestRef = useRef(0);
  const journeyLoadRequestRef = useRef(0);
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const renameNameInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<ProjectStatus>("active");
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [allProjects, setAllProjects] = useState<readonly Project[]>([]);
  const [importJourney, setImportJourney] = useState<ImportJourneyLibraryProjection | null>(() =>
    readImportJourneyProjection(),
  );
  const [pageState, setPageState] = useState<"loading" | "ready" | "empty" | "fatal_error">(
    "loading",
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const [identityByProjectId, setIdentityByProjectId] = useState<
    ReadonlyMap<string, ProjectDisplayIdentity>
  >(new Map());
  const [identityReadFailureCount, setIdentityReadFailureCount] = useState(0);
  const [identityWriteWarning, setIdentityWriteWarning] = useState<string | null>(null);
  const [activeIdeaJourneys, setActiveIdeaJourneys] = useState<readonly CreativeJourneyRecord[]>(
    [],
  );
  const [journeyLoadError, setJourneyLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [trashTarget, setTrashTarget] = useState<Project | null>(null);
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    setPageState("loading");
    const [result, libraryResult] = await Promise.all([
      runtime.useCases.listProjects.execute({
        statuses: [status],
        search,
      }),
      runtime.useCases.listProjects.execute({ statuses: ALL_PROJECT_STATUSES }),
    ]);
    if (requestId !== loadRequestRef.current) {
      return;
    }
    if (!result.ok) {
      setLoadError(result.error);
      setPageState("fatal_error");
      return;
    }
    if (!libraryResult.ok) {
      setLoadError(libraryResult.error);
      setPageState("fatal_error");
      return;
    }
    const identityEntries = await Promise.all(
      libraryResult.value.map(async (project) => {
        try {
          const identityResult =
            await runtime.repositories.projectDisplayIdentities.resolveByProjectId(project.id);
          if (identityResult.ok && identityResult.value !== null) {
            return { project, identity: identityResult.value, failed: false } as const;
          }
        } catch {
          // A damaged optional classification must not block authoritative project content.
        }
        return {
          project,
          identity: legacyAuthorIdentity(project),
          failed: true,
        } as const;
      }),
    );
    if (requestId !== loadRequestRef.current) {
      return;
    }
    const identities = new Map<string, ProjectDisplayIdentity>();
    let failedIdentityReads = 0;
    for (const entry of identityEntries) {
      identities.set(entry.project.id, entry.identity);
      if (entry.failed) failedIdentityReads += 1;
    }
    const visibleProjectIds = new Set(
      identityEntries
        .filter(({ identity }) => identity.displayKind !== "system_evaluation")
        .map(({ project }) => project.id),
    );
    const visibleProjects = result.value.filter((project) => visibleProjectIds.has(project.id));
    const visibleLibrary = libraryResult.value.filter((project) =>
      visibleProjectIds.has(project.id),
    );
    setIdentityByProjectId(identities);
    setIdentityReadFailureCount(failedIdentityReads);
    setProjects(visibleProjects);
    setAllProjects(visibleLibrary);
    setImportJourney(readImportJourneyProjection());
    setLoadError(null);
    setPageState(visibleProjects.length === 0 ? "empty" : "ready");
  }, [runtime, search, status]);

  const loadActiveIdeaJourneys = useCallback(async () => {
    const requestId = journeyLoadRequestRef.current + 1;
    journeyLoadRequestRef.current = requestId;
    try {
      const records = await runtime.creativeJourneys.listActive("idea");
      if (requestId !== journeyLoadRequestRef.current) return;
      setActiveIdeaJourneys(
        records.filter((record) => record.kind === "idea" && record.status === "active"),
      );
      setJourneyLoadError(null);
    } catch {
      if (requestId !== journeyLoadRequestRef.current) return;
      setActiveIdeaJourneys([]);
      setJourneyLoadError("未完成创作暂时无法读取；项目和正文仍可正常打开。");
    }
  }, [runtime]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadProjects();
    }, 180);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [loadProjects]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadActiveIdeaJourneys();
    }, 0);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [loadActiveIdeaJourneys]);

  async function createProject(): Promise<void> {
    if (projectName.trim().length === 0) {
      setFormError(`项目名称不能为空，请输入 1 至 ${String(MAX_PROJECT_NAME_LENGTH)} 个字符。`);
      window.requestAnimationFrame(() => projectNameInputRef.current?.focus());
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const result = await runtime.useCases.createProject.execute({ name: projectName });
    setSubmitting(false);
    if (!result.ok) {
      setFormError(normalizeUiError(result.error).description);
      window.requestAnimationFrame(() => projectNameInputRef.current?.focus());
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
  ): Promise<boolean> {
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
      return false;
    }
    const actionMessages = {
      archive: { title: "项目已归档", description: "项目保持可读，可随时恢复编辑。" },
      unarchive: { title: "项目已恢复编辑", description: "项目已回到进行中列表。" },
      trash: { title: "项目已移到回收站", description: "项目将在回收站保留 30 天。" },
      restore: { title: "项目已恢复", description: "项目已回到进行中列表。" },
    } as const;
    const message = actionMessages[action];
    toast({
      title: message.title,
      description: message.description,
      tone: "success",
      ...(action === "trash"
        ? {
            action: {
              label: "撤销",
              onClick: () => {
                setStatus("active");
                void runLifecycleAction(project, "restore");
              },
            },
          }
        : {}),
    });
    await loadProjects();
    return true;
  }

  async function confirmTrash(): Promise<void> {
    if (trashTarget === null) {
      return;
    }
    const moved = await runLifecycleAction(trashTarget, "trash");
    if (moved) {
      setTrashTarget(null);
    }
  }

  async function archiveInsteadOfTrash(): Promise<void> {
    if (trashTarget?.status !== "active") {
      return;
    }
    const archived = await runLifecycleAction(trashTarget, "archive");
    if (archived) {
      setTrashTarget(null);
    }
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
    if (renameName.trim().length === 0) {
      setRenameError(`项目名称不能为空，请输入 1 至 ${String(MAX_PROJECT_NAME_LENGTH)} 个字符。`);
      window.requestAnimationFrame(() => renameNameInputRef.current?.focus());
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
      window.requestAnimationFrame(() => renameNameInputRef.current?.focus());
      return;
    }
    setRenameTarget(null);
    await loadProjects();
  }

  async function changeProjectClassification(
    project: Project,
    displayKind: "author_work" | "test_work",
  ): Promise<void> {
    setPendingProjectId(project.id);
    setIdentityWriteWarning(null);
    try {
      const result =
        displayKind === "author_work"
          ? await runtime.repositories.projectDisplayIdentities.recordAuthorWork(
              project.id,
              runtime.clock.now(),
            )
          : await runtime.repositories.projectDisplayIdentities.recordTestWork(
              project.id,
              runtime.clock.now(),
            );
      if (!result.ok || result.value.displayKind !== displayKind) {
        setIdentityWriteWarning(
          `《${project.name}》的分类没有更改。项目和正文未受影响，你可以稍后再试。`,
        );
        return;
      }
      toast({
        title: displayKind === "author_work" ? "已移回作者作品" : "已标记为测试作品",
        description:
          displayKind === "author_work"
            ? "作品已回到普通作品列表。"
            : "作品已移到“测试与示例”区域，正文没有改变。",
        tone: "success",
      });
      await loadProjects();
    } catch {
      setIdentityWriteWarning(
        `《${project.name}》的分类没有更改。项目和正文未受影响，你可以稍后再试。`,
      );
    } finally {
      setPendingProjectId(null);
    }
  }

  const normalizedLoadError = loadError === null ? null : projectOrdinaryUiError(loadError);
  const normalizedSearch = search.trim();
  const hasSearch = normalizedSearch.length > 0;
  const authorProjects = projects.filter(
    (project) => identityByProjectId.get(project.id)?.displayKind === "author_work",
  );
  const specialProjects = projects.filter((project) => {
    const displayKind = identityByProjectId.get(project.id)?.displayKind;
    return displayKind === "test_work" || displayKind === "builtin_example";
  });
  const completelyEmpty = !allProjects.some(
    (project) => identityByProjectId.get(project.id)?.displayKind === "author_work",
  );
  const hasArchivedProjects = allProjects.some((project) => project.status === "archived");
  const hasTrashedProjects = allProjects.some((project) => project.status === "trashed");
  const { activeIdeaJourneyByProjectId, conflictedIdeaJourneyProjectCount } = useMemo(() => {
    const result = new Map<string, CreativeJourneyRecord>();
    const conflicts = new Set<string>();
    for (const journey of activeIdeaJourneys) {
      const projectId = resolveActiveIdeaJourneyProjectId(journey, allProjects);
      if (projectId === null || conflicts.has(projectId)) {
        continue;
      }
      if (result.has(projectId)) {
        result.delete(projectId);
        conflicts.add(projectId);
      } else {
        result.set(projectId, journey);
      }
    }
    return Object.freeze({
      activeIdeaJourneyByProjectId: result,
      conflictedIdeaJourneyProjectCount: conflicts.size,
    });
  }, [activeIdeaJourneys, allProjects]);
  const resumableImport =
    importJourney === null
      ? null
      : allProjects.some(
            (project) => project.id === importJourney.projectId && project.status === "active",
          )
        ? importJourney
        : null;

  if (writingExperience.preference === null) {
    return (
      <div className="desktop-page" aria-busy={writingExperience.loading}>
        {writingExperience.loading ? (
          <div role="status">正在读取写作方式…</div>
        ) : (
          <ErrorState
            title="暂时无法打开作品库"
            description={writingExperience.error ?? "写作方式没有读取成功，请重试。"}
            primaryAction={{ label: "重试", onClick: () => void writingExperience.refresh() }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="desktop-page project-library-page">
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
          description={
            directMode
              ? "项目仍会保存在此设备；需要联网的创作服务暂不可用。"
              : "项目仍会保存在此设备；需要联网的模型能力暂不可用。"
          }
        />
      )}

      {journeyLoadError !== null && (
        <InlineAlert
          tone="warning"
          title="未完成创作读取失败"
          description={journeyLoadError}
          action={{ label: "重试", onClick: () => void loadActiveIdeaJourneys() }}
        />
      )}

      {identityReadFailureCount > 0 && (
        <InlineAlert
          tone="warning"
          title="部分作品分类暂时无法读取"
          description={
            String(identityReadFailureCount) +
            " 个作品暂按作者作品显示；项目和正文仍可正常打开。墨影不会根据名称或正文猜测分类。"
          }
          action={{ label: "重新读取分类", onClick: () => void loadProjects() }}
        />
      )}

      {identityWriteWarning !== null && (
        <InlineAlert
          tone="warning"
          title="作品分类尚未更改"
          description={identityWriteWarning}
          action={{ label: "知道了", onClick: () => setIdentityWriteWarning(null) }}
        />
      )}

      {conflictedIdeaJourneyProjectCount > 0 && (
        <InlineAlert
          tone="warning"
          title="未完成创作记录存在冲突"
          description={
            String(conflictedIdeaJourneyProjectCount) +
            " 个作品同时关联了多条未完成创作记录。为保护正文，墨影没有替你选择；现有作品仍可正常打开。"
          }
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
            {tabStatus === status && (
              <>
                {tabStatus === "active" && !hasSearch && resumableImport !== null && (
                  <ImportJourneyState projection={resumableImport} directMode={directMode} />
                )}
                <PageStateBoundary
                  state={pageState}
                  preserveContent={false}
                  fallbacks={{
                    empty:
                      tabStatus === "active" &&
                      status === "active" &&
                      !hasSearch &&
                      completelyEmpty ? (
                        <FirstLaunchState
                          titleId={`first-launch-title-${tabStatus}`}
                          directMode={directMode}
                        />
                      ) : (
                        <EmptyState
                          kind={hasSearch ? "no_results" : "no_data"}
                          title={
                            hasSearch
                              ? `没有与“${normalizedSearch}”匹配的作品`
                              : status === "active"
                                ? "没有进行中的作品"
                                : `${statusLabels[status]}为空`
                          }
                          description={
                            hasSearch
                              ? "检查是否有错别字，或换个名称试试。归档作品不会出现在当前列表中。"
                              : tabStatus === "active"
                                ? hasArchivedProjects
                                  ? "作品已保存在归档中，可以随时恢复编辑。"
                                  : hasTrashedProjects
                                    ? "作品仍在回收站保留 30 天，可以恢复后继续写作。"
                                    : "从一个想法开始，或导入已有小说。"
                                : tabStatus === "archived"
                                  ? "还没有归档项目。可返回进行中的项目继续写作。"
                                  : "回收站为空。可返回进行中的项目，或新建一本书。"
                          }
                          primaryAction={
                            hasSearch
                              ? { label: "清除搜索", onClick: () => setSearch("") }
                              : tabStatus === "active" && hasArchivedProjects
                                ? { label: "查看归档", onClick: () => setStatus("archived") }
                                : tabStatus === "active" && hasTrashedProjects
                                  ? { label: "查看回收站", onClick: () => setStatus("trashed") }
                                  : tabStatus === "archived"
                                    ? { label: "查看进行中", onClick: () => setStatus("active") }
                                    : {
                                        label: "新建项目",
                                        onClick: () => {
                                          setStatus("active");
                                          setCreateOpen(true);
                                        },
                                      }
                          }
                          {...(hasSearch
                            ? {
                                secondaryAction:
                                  status === "archived"
                                    ? { label: "查看进行中", onClick: () => setStatus("active") }
                                    : { label: "查看归档", onClick: () => setStatus("archived") },
                              }
                            : {})}
                        />
                      ),
                    fatal_error:
                      normalizedLoadError === null ? undefined : (
                        <ErrorState
                          title={normalizedLoadError.title}
                          description={normalizedLoadError.description}
                          primaryAction={{ label: "重试", onClick: () => void loadProjects() }}
                        />
                      ),
                  }}
                >
                  <div className="project-library-page__collections">
                    {authorProjects.length > 0 ? (
                      <section
                        className="project-library-page__collection"
                        aria-labelledby={`author-projects-heading-${tabStatus}`}
                      >
                        <div className="project-library-page__collection-heading">
                          <div>
                            <h2 id={`author-projects-heading-${tabStatus}`}>作者作品</h2>
                            <p>这里是你的普通创作，不会按作品名称或正文自动改成测试作品。</p>
                          </div>
                        </div>
                        <div className="project-grid">
                          {authorProjects.map((project) => (
                            <ProjectLibraryCard
                              key={project.id}
                              project={project}
                              identity={
                                identityByProjectId.get(project.id) ?? legacyAuthorIdentity(project)
                              }
                              activeIdeaJourney={
                                activeIdeaJourneyByProjectId.get(project.id) ?? null
                              }
                              pending={pendingProjectId === project.id}
                              onRename={openRenameDialog}
                              onTrash={(target) =>
                                directMode
                                  ? void runLifecycleAction(target, "trash")
                                  : setTrashTarget(target)
                              }
                              onLifecycle={(target, action) =>
                                void runLifecycleAction(target, action)
                              }
                              onClassification={(target, kind) =>
                                void changeProjectClassification(target, kind)
                              }
                            />
                          ))}
                        </div>
                      </section>
                    ) : specialProjects.length > 0 &&
                      tabStatus === "active" &&
                      !hasSearch &&
                      completelyEmpty ? (
                      <FirstLaunchState
                        titleId={`first-launch-with-special-title-${tabStatus}`}
                        directMode={directMode}
                      />
                    ) : null}

                    {specialProjects.length > 0 && (
                      <section
                        className="project-library-page__collection project-library-page__collection--special"
                        aria-labelledby={`special-projects-heading-${tabStatus}`}
                      >
                        <div className="project-library-page__collection-heading">
                          <div>
                            <p className="project-library-page__section-label">单独收纳</p>
                            <h2 id={`special-projects-heading-${tabStatus}`}>测试与示例</h2>
                            <p>测试作品和内置示例不会混入你的普通创作。</p>
                          </div>
                        </div>
                        <div className="project-grid">
                          {specialProjects.map((project) => (
                            <ProjectLibraryCard
                              key={project.id}
                              project={project}
                              identity={
                                identityByProjectId.get(project.id) ?? legacyAuthorIdentity(project)
                              }
                              activeIdeaJourney={
                                activeIdeaJourneyByProjectId.get(project.id) ?? null
                              }
                              pending={pendingProjectId === project.id}
                              onRename={openRenameDialog}
                              onTrash={(target) =>
                                directMode
                                  ? void runLifecycleAction(target, "trash")
                                  : setTrashTarget(target)
                              }
                              onLifecycle={(target, action) =>
                                void runLifecycleAction(target, action)
                              }
                              onClassification={(target, kind) =>
                                void changeProjectClassification(target, kind)
                              }
                            />
                          ))}
                        </div>
                      </section>
                    )}
                  </div>
                </PageStateBoundary>
              </>
            )}
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
            <Button loading={submitting} disabled={submitting} onClick={() => void createProject()}>
              创建项目
            </Button>
          </>
        }
      >
        <FormField label="项目名称" error={formError ?? undefined} required>
          {(fieldProps) => (
            <Input
              {...fieldProps}
              ref={projectNameInputRef}
              value={projectName}
              maxLength={MAX_PROJECT_NAME_LENGTH}
              onChange={(event) => {
                setProjectName(event.currentTarget.value);
                setFormError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && !submitting) {
                  event.preventDefault();
                  void createProject();
                }
              }}
            />
          )}
        </FormField>
      </Dialog>

      <Dialog
        open={!directMode && trashTarget !== null}
        onOpenChange={(open) => {
          if (!open && pendingProjectId === null) {
            setTrashTarget(null);
          }
        }}
        title={trashTarget === null ? "移到回收站？" : `将《${trashTarget.name}》移到回收站？`}
        description="30 天内可以从回收站恢复。你也可以先归档，保留作品并让进行中列表更清爽。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={pendingProjectId !== null}
              onClick={() => setTrashTarget(null)}
            >
              取消
            </Button>
            {trashTarget?.status === "active" && (
              <Button
                variant="secondary"
                loading={pendingProjectId === trashTarget.id}
                onClick={() => void archiveInsteadOfTrash()}
              >
                改为归档
              </Button>
            )}
            <Button
              variant="danger"
              loading={trashTarget !== null && pendingProjectId === trashTarget.id}
              onClick={() => void confirmTrash()}
            >
              移到回收站
            </Button>
          </>
        }
      >
        <p className="project-library-page__trash-note">
          这不是永久删除：正文、版本和 AI 建议会一起保留到恢复期限。取消不会改变任何内容。
        </p>
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
              disabled={renameSubmitting}
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
              ref={renameNameInputRef}
              value={renameName}
              maxLength={MAX_PROJECT_NAME_LENGTH}
              onChange={(event) => {
                setRenameName(event.currentTarget.value);
                setRenameError(null);
              }}
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

interface ProjectLibraryCardProps {
  readonly project: Project;
  readonly identity: ProjectDisplayIdentity;
  readonly activeIdeaJourney: CreativeJourneyRecord | null;
  readonly pending: boolean;
  readonly onRename: (project: Project) => void;
  readonly onTrash: (project: Project) => void;
  readonly onLifecycle: (project: Project, action: "archive" | "unarchive" | "restore") => void;
  readonly onClassification: (project: Project, displayKind: "author_work" | "test_work") => void;
}

function ProjectLibraryCard({
  project,
  identity,
  activeIdeaJourney,
  pending,
  onRename,
  onTrash,
  onLifecycle,
  onClassification,
}: ProjectLibraryCardProps) {
  if (identity.displayKind === "system_evaluation") return null;
  const snapshot = project.toSnapshot();
  const classificationLabel =
    identity.displayKind === "test_work"
      ? "测试作品"
      : identity.displayKind === "builtin_example"
        ? "示例作品"
        : identity.provenance === "legacy_unknown"
          ? "分类待确认"
          : null;

  return (
    <Card>
      <CardHeader>
        <div className="card-heading-row">
          <CardTitle
            className="project-library-page__project-title"
            headingLevel={2}
            title={project.name}
          >
            {project.name}
          </CardTitle>
          <div className="project-library-page__card-badges">
            {classificationLabel !== null && (
              <Badge
                tone={
                  identity.displayKind === "test_work"
                    ? "warning"
                    : identity.provenance === "legacy_unknown"
                      ? "warning"
                      : "neutral"
                }
              >
                {classificationLabel}
              </Badge>
            )}
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
        </div>
      </CardHeader>
      <CardContent>
        <p className="project-meta">
          更新于 <time dateTime={snapshot.updatedAt}>{formatDate(snapshot.updatedAt)}</time>
        </p>
        {project.retentionUntil !== null && (
          <p className="project-retention">
            可恢复至{" "}
            <time dateTime={project.retentionUntil}>{formatDate(project.retentionUntil)}</time>
          </p>
        )}
        {project.status === "active" && activeIdeaJourney !== null && (
          <div className="project-library-page__unfinished-creation">
            <Badge tone="warning">未完成创作</Badge>
            <p>已创建空白作品并保留原始创作过程；继续后仍由你决定使用或放弃结果。</p>
            <p>完成或结束这次创作后即可重命名作品。</p>
          </div>
        )}
      </CardContent>
      <CardFooter>
        {identity.displayKind === "author_work" && (
          <Button
            variant="ghost"
            size="sm"
            loading={pending}
            onClick={() =>
              onClassification(
                project,
                identity.provenance === "legacy_unknown" ? "author_work" : "test_work",
              )
            }
          >
            {identity.provenance === "legacy_unknown" ? "确认是作者作品" : "标记为测试作品"}
          </Button>
        )}
        {identity.displayKind === "test_work" && (
          <Button
            variant="ghost"
            size="sm"
            loading={pending}
            onClick={() => onClassification(project, "author_work")}
          >
            移回作者作品
          </Button>
        )}
        {project.status !== "trashed" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || activeIdeaJourney !== null}
            onClick={() => onRename(project)}
          >
            重命名
          </Button>
        )}
        {project.status !== "trashed" && (
          <Button variant="ghost" size="sm" loading={pending} onClick={() => onTrash(project)}>
            移到回收站
          </Button>
        )}
        {project.status === "active" && (
          <Button
            variant="secondary"
            size="sm"
            loading={pending}
            onClick={() => onLifecycle(project, "archive")}
          >
            归档
          </Button>
        )}
        {project.status === "archived" && (
          <Button
            variant="secondary"
            size="sm"
            loading={pending}
            onClick={() => onLifecycle(project, "unarchive")}
          >
            恢复编辑
          </Button>
        )}
        {project.status === "trashed" ? (
          <Button size="sm" loading={pending} onClick={() => onLifecycle(project, "restore")}>
            恢复
          </Button>
        ) : activeIdeaJourney !== null ? (
          <Link className="button-link" to={`/create/idea?journey=${activeIdeaJourney.id}`}>
            继续未完成创作
          </Link>
        ) : (
          <Link className="button-link" to={`/projects/${project.id}`}>
            打开
          </Link>
        )}
      </CardFooter>
    </Card>
  );
}

function legacyAuthorIdentity(project: Project): ProjectDisplayIdentity {
  return Object.freeze({
    projectId: project.id,
    displayKind: "author_work",
    provenance: "legacy_unknown",
    recordedAt: null,
    revision: null,
  });
}

function FirstLaunchState({
  directMode,
  titleId,
}: {
  readonly directMode: boolean;
  readonly titleId: string;
}) {
  return (
    <section className="first-launch" aria-labelledby={titleId}>
      <div className="first-launch__heading">
        <Badge tone="success">无需注册</Badge>
        <h2 id={titleId}>还没有作品</h2>
        <p>从一个想法开始，或导入已有小说。所有数据只存在这台电脑。</p>
      </div>
      <div className="first-launch__actions">
        <Card>
          <CardHeader>
            <CardTitle>从一个想法开始</CardTitle>
          </CardHeader>
          <CardContent>
            <p>
              {directMode
                ? "只写一句灵感，就可以开始创作并继续修改。"
                : "只写一句灵感，AI 会先给出一段可以继续修改的开头。"}
            </p>
          </CardContent>
          <CardFooter>
            <Link className="button-link" to="/create/idea">
              从想法开始
            </Link>
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>导入已有作品</CardTitle>
          </CardHeader>
          <CardContent>
            <p>先安全保留原作，再分析、试改和逐章确认；不会静默覆盖原文。</p>
          </CardContent>
          <CardFooter>
            <Link className="button-link" to="/create/import">
              导入已有小说
            </Link>
          </CardFooter>
        </Card>
      </div>
    </section>
  );
}

function ImportJourneyState({
  directMode,
  projection,
}: {
  readonly directMode: boolean;
  readonly projection: ImportJourneyLibraryProjection;
}) {
  const analysisLabel = projection.analysisCompleted
    ? "已完成"
    : projection.analysisTotalJobs > 0
      ? `已保存 ${String(projection.analysisFinishedJobs)}/${String(projection.analysisTotalJobs)} 项，待继续`
      : "待开始";
  const finalStepLabel = projection.hasSavedRules
    ? "规则已保存，可继续逐章"
    : projection.hasTrial
      ? directMode
        ? "试改已保存，请设置规则"
        : "试改已保存，待确认规则"
      : projection.hasRewriteTarget
        ? "目标已保存，待试改"
        : "待填写改写目标";

  return (
    <section
      className="project-library-page__import-state"
      aria-labelledby="project-library-import-title"
    >
      <div className="project-library-page__import-heading">
        <div>
          <p className="project-library-page__section-label">可继续的导入流程</p>
          <h2 id="project-library-import-title">《{projection.projectName}》</h2>
          <p>已安全导入 {String(projection.chapterCount)} 个章节，原文保持不变。</p>
        </div>
        <Link className="button-link" to="/create/import">
          继续导入改写
        </Link>
      </div>
      <ol className="project-library-page__import-steps" aria-label="已保存的导入步骤">
        <li data-state="complete">
          <span>1　安全导入原作</span>
          <strong>已完成</strong>
        </li>
        <li data-state={projection.analysisCompleted ? "complete" : "current"}>
          <span>2　分析作品</span>
          <strong>{analysisLabel}</strong>
        </li>
        <li data-state={projection.hasSavedRules ? "complete" : "pending"}>
          <span>3　{directMode ? "试改、设置规则并逐章处理" : "试改、确认规则并逐章处理"}</span>
          <strong>{finalStepLabel}</strong>
        </li>
      </ol>
      <p className="project-library-page__import-limit">
        这里仅显示已经保存在本机的步骤。文件读取和安全解析的实时进度只在导入页显示；离开后不会猜测百分比。
      </p>
    </section>
  );
}

function resolveActiveIdeaJourneyProjectId(
  journey: CreativeJourneyRecord,
  projects: readonly Project[],
): string | null {
  if (journey.projectId !== null) {
    return parseUuidV7(journey.projectId).ok &&
      projects.some((project) => project.id === journey.projectId && project.status === "active")
      ? journey.projectId
      : null;
  }

  const snapshot = journey.snapshot;
  if (snapshot.version !== 1 || !isRecord(snapshot.provisioningPlan)) {
    return null;
  }
  const plan = snapshot.provisioningPlan;
  if (
    typeof plan.projectId !== "string" ||
    !parseUuidV7(plan.projectId).ok ||
    typeof plan.chapterId !== "string" ||
    !parseUuidV7(plan.chapterId).ok ||
    typeof plan.initialVersionId !== "string" ||
    !parseUuidV7(plan.initialVersionId).ok ||
    typeof plan.projectName !== "string" ||
    plan.projectName.length === 0 ||
    plan.projectName.length > 120
  ) {
    return null;
  }

  const plannedProject = projects.find(
    (project) => project.id === plan.projectId && project.status === "active",
  );
  if (plannedProject?.name !== plan.projectName) {
    return null;
  }
  return plan.projectId;
}

function readImportJourneyProjection(): ImportJourneyLibraryProjection | null {
  try {
    const serialized = window.localStorage.getItem(IMPORT_JOURNEY_STORAGE_KEY);
    if (serialized === null) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || !isRecord(parsed.importedWork)) return null;
    const importedWork = parsed.importedWork;
    if (
      typeof importedWork.projectId !== "string" ||
      typeof importedWork.projectName !== "string" ||
      importedWork.projectName.trim().length === 0 ||
      typeof importedWork.chapterCount !== "number" ||
      !Number.isSafeInteger(importedWork.chapterCount) ||
      importedWork.chapterCount < 1
    ) {
      return null;
    }

    const workAnalysis = isRecord(parsed.workAnalysis) ? parsed.workAnalysis : null;
    const jobs = workAnalysis !== null && Array.isArray(workAnalysis.jobs) ? workAnalysis.jobs : [];
    const finishedJobs = jobs.filter(
      (job) => isRecord(job) && (job.status === "ready" || job.status === "skipped"),
    ).length;

    return {
      projectId: importedWork.projectId,
      projectName: importedWork.projectName.trim().slice(0, 120),
      chapterCount: importedWork.chapterCount,
      analysisCompleted:
        workAnalysis !== null &&
        typeof workAnalysis.completedAt === "string" &&
        workAnalysis.completedAt.length > 0,
      analysisFinishedJobs: finishedJobs,
      analysisTotalJobs: jobs.length,
      hasRewriteTarget:
        (typeof parsed.goal === "string" && parsed.goal.trim().length > 0) ||
        (Array.isArray(parsed.selectedPresetIds) && parsed.selectedPresetIds.length > 0),
      hasTrial: isRecord(parsed.trial),
      hasSavedRules: typeof parsed.rulesSavedAt === "string" && parsed.rulesSavedAt.length > 0,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
