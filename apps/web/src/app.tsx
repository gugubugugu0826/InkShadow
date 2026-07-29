import type { SaveState } from "@inkshadow/contracts";
import type { UuidV7 } from "@inkshadow/domain";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
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
  SaveStatus,
  Textarea,
  ToastProvider,
  useToast,
} from "@inkshadow/ui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import type {
  CreateEncryptedGuestProjectOutcome,
  GuestWorkspaceService,
  GuestEncryptedProjectDescriptor,
  GuestProjectSession,
} from "./application/guest-workspace-service";
import { GuestWorkspaceError, type GuestWorkspaceErrorCode } from "./domain/guest-workspace-error";

export interface AppProps {
  readonly service: GuestWorkspaceService;
}

interface VisibleError {
  readonly code: GuestWorkspaceErrorCode;
  readonly message: string;
}

export function App({ service }: AppProps): ReactNode {
  return (
    <ToastProvider>
      <GuestWorkspaceApp service={service} />
    </ToastProvider>
  );
}

function GuestWorkspaceApp({ service }: AppProps): ReactNode {
  const { toast } = useToast();
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [pageState, setPageState] = useState<"loading" | "ready" | "fatal_error">("loading");
  const [projects, setProjects] = useState<readonly GuestEncryptedProjectDescriptor[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<UuidV7 | null>(null);
  const [session, setSession] = useState<GuestProjectSession | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [pendingCreation, setPendingCreation] = useState<CreateEncryptedGuestProjectOutcome | null>(
    null,
  );
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [busyAction, setBusyAction] = useState<"create" | "commit" | "unlock" | "save" | null>(
    null,
  );
  const [visibleError, setVisibleError] = useState<VisibleError | null>(null);
  const [lockGeneration, setLockGeneration] = useState(0);
  const securityEpoch = useRef(0);

  const secureLock = useCallback((): void => {
    securityEpoch.current += 1;
    service.lockAll();
    setSession(null);
    setEditorContent("");
    setSaveState("clean");
    setPendingCreation(null);
    setRecoveryConfirmed(false);
    setBusyAction(null);
    setVisibleError(null);
    setLockGeneration((current) => current + 1);
  }, [service]);

  const refreshProjects = useCallback(async (): Promise<void> => {
    try {
      const available = await service.listEncryptedProjects();
      setProjects(available);
      setSelectedProjectId((current) => current ?? available[0]?.projectId ?? null);
      setPageState("ready");
    } catch (error) {
      secureLock();
      setVisibleError(toVisibleError(error));
      setPageState("fatal_error");
    }
  }, [secureLock, service]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshProjects();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [refreshProjects]);

  useEffect(() => {
    const lockOnVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        secureLock();
      }
    };
    const lockOnPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        secureLock();
      }
    };
    window.addEventListener("pagehide", secureLock);
    window.addEventListener("pageshow", lockOnPageShow);
    document.addEventListener("visibilitychange", lockOnVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", secureLock);
      window.removeEventListener("pageshow", lockOnPageShow);
      document.removeEventListener("visibilitychange", lockOnVisibilityChange);
      service.lockAll();
    };
  }, [secureLock, service]);

  async function handleCreate(input: {
    projectName: string;
    chapterTitle: string;
    chapterContent: string;
  }): Promise<void> {
    const operationEpoch = securityEpoch.current;
    setBusyAction("create");
    setVisibleError(null);
    try {
      const prepared = await service.prepareEncryptedProject(input);
      if (securityEpoch.current !== operationEpoch) {
        return;
      }
      setPendingCreation(prepared);
      setRecoveryConfirmed(false);
    } catch (error) {
      if (securityEpoch.current === operationEpoch) {
        setVisibleError(toVisibleError(error));
      }
    } finally {
      if (securityEpoch.current === operationEpoch) {
        setBusyAction(null);
      }
    }
  }

  async function handleCommitPreparedProject(): Promise<void> {
    if (pendingCreation === null || !recoveryConfirmed) {
      return;
    }
    const operationEpoch = securityEpoch.current;
    setBusyAction("commit");
    setVisibleError(null);
    try {
      const committed = await service.commitPreparedProject(pendingCreation.session.project.id);
      if (securityEpoch.current !== operationEpoch) {
        return;
      }
      setSession(committed);
      setEditorContent(committed.chapter.content);
      setSaveState("saved_local");
      setSelectedProjectId(committed.project.id);
      setPendingCreation(null);
      setRecoveryConfirmed(false);
      await refreshProjects();
    } catch (error) {
      if (securityEpoch.current === operationEpoch) {
        setVisibleError(toVisibleError(error));
      }
    } finally {
      if (securityEpoch.current === operationEpoch) {
        setBusyAction(null);
      }
    }
  }

  async function handleUnlock(projectId: UuidV7, material: string): Promise<void> {
    const operationEpoch = securityEpoch.current;
    setBusyAction("unlock");
    setVisibleError(null);
    try {
      const unlocked = await service.unlockProject(projectId, material);
      if (securityEpoch.current !== operationEpoch) {
        return;
      }
      setSession(unlocked);
      setEditorContent(unlocked.chapter.content);
      setSaveState("clean");
      setSelectedProjectId(projectId);
      toast({
        title: "项目已在当前会话解锁",
        description: "刷新或关闭页面后仍需再次提供恢复材料。",
        tone: "success",
      });
    } catch (error) {
      if (securityEpoch.current === operationEpoch) {
        setSession(null);
        setEditorContent("");
        setVisibleError(toVisibleError(error));
      }
    } finally {
      if (securityEpoch.current === operationEpoch) {
        setBusyAction(null);
      }
    }
  }

  async function handleSave(): Promise<void> {
    if (session === null || saveState !== "dirty") {
      return;
    }
    const operationEpoch = securityEpoch.current;
    setBusyAction("save");
    setSaveState("saving");
    setVisibleError(null);
    try {
      const saved = await service.saveChapter({
        projectId: session.project.id,
        expectedRevision: session.chapter.revision,
        content: editorContent,
      });
      if (securityEpoch.current !== operationEpoch) {
        return;
      }
      setSession(saved);
      setSaveState("saved_local");
      await refreshProjects();
      toast({
        title: "密文版本已保存",
        description: `章节版本 ${String(saved.chapter.revision)} 已写入浏览器 IndexedDB。`,
        tone: "success",
      });
    } catch (error) {
      if (securityEpoch.current === operationEpoch) {
        setSaveState("save_failed");
        setVisibleError(toVisibleError(error));
      }
    } finally {
      if (securityEpoch.current === operationEpoch) {
        setBusyAction(null);
      }
    }
  }

  function handleLock(): void {
    if (session === null) {
      return;
    }
    setSelectedProjectId(session.project.id);
    secureLock();
  }

  async function handleExport(projectId: UuidV7): Promise<void> {
    setVisibleError(null);
    try {
      const payload = await service.exportEncryptedProject(projectId);
      downloadEncryptedEnvelope(projectId, payload);
      toast({
        title: "加密副本已交给浏览器下载",
        description: "副本不含明文，也不含恢复材料；恢复材料必须分开保管。",
        tone: "info",
      });
    } catch (error) {
      setVisibleError(toVisibleError(error));
    }
  }

  const fatalFallback =
    visibleError === null ? undefined : (
      <ErrorState
        title="浏览器加密工作区不可用"
        description={visibleError.message}
        errorCode={visibleError.code}
        savedState="未写入明文或不完整项目"
        primaryAction={{
          label: "重试",
          onClick: () => {
            setPageState("loading");
            void refreshProjects();
          },
        }}
      />
    );

  return (
    <div className="web-app" data-surface="dark">
      <a className="web-skip-link" href="#web-main">
        跳到主要内容
      </a>
      <header className="web-topbar">
        <div>
          <span className="web-wordmark">墨影 InkShadow</span>
          <span className="web-product-name">Web Guest</span>
        </div>
        <div className="web-session-state" aria-label="会话安全状态">
          <Badge tone="success">密钥仅在内存</Badge>
          <Badge tone="info">独立 Web 客户端</Badge>
        </div>
      </header>

      <main id="web-main" className="web-layout" tabIndex={-1}>
        <section className="web-workspace" aria-labelledby="workspace-title">
          <div className="web-heading">
            <div>
              <p className="web-eyebrow">浏览器本地 · 加密纵切</p>
              <h1 id="workspace-title">Guest 写作工作区</h1>
              <p>
                项目与章节在浏览器内加密后再保存。项目名、章节标题和正文不会以明文进入 IndexedDB。
              </p>
            </div>
          </div>

          <InlineAlert
            tone="warning"
            title="浏览器存储不是桌面备份"
            description="清理站点数据会删除这里的密文副本；共享浏览器配置文件也会共享这份密文。恢复材料不会被本站保存。"
          />

          {visibleError !== null && pageState !== "fatal_error" && (
            <InlineAlert
              tone="error"
              title={`操作未完成 · ${visibleError.code}`}
              description={visibleError.message}
            />
          )}

          <PageStateBoundary
            state={pageState}
            loadingLabel="正在检查浏览器密文项目…"
            fallbacks={{
              fatal_error: fatalFallback,
            }}
          >
            {session === null ? (
              <LockedWorkspace
                key={`locked-${String(lockGeneration)}`}
                projects={projects}
                selectedProjectId={selectedProjectId}
                busy={busyAction !== null}
                creating={busyAction === "create"}
                unlocking={busyAction === "unlock"}
                onCreate={handleCreate}
                onSelect={setSelectedProjectId}
                onUnlock={handleUnlock}
                onExport={handleExport}
              />
            ) : (
              <UnlockedEditor
                session={session}
                content={editorContent}
                saveState={saveState}
                saving={busyAction === "save"}
                onContentChange={(content) => {
                  setEditorContent(content);
                  setSaveState(content === session.chapter.content ? "clean" : "dirty");
                }}
                onSave={handleSave}
                onLock={handleLock}
                onExport={handleExport}
              />
            )}
          </PageStateBoundary>
        </section>

        <CapabilityPanel />
      </main>

      <footer className="web-footer">
        <span>无账号 · 无云请求 · 无遥测 · 无 Web Storage 密钥</span>
        <span>刷新后自动回到锁定状态</span>
      </footer>

      <RiskDialog
        open={!riskAccepted}
        onAccept={() => {
          setRiskAccepted(true);
        }}
      />
      <RecoveryMaterialDialog
        key={pendingCreation?.session.project.id ?? "no-pending-project"}
        material={pendingCreation?.recoveryMaterial ?? null}
        confirmed={recoveryConfirmed}
        committing={busyAction === "commit"}
        error={pendingCreation === null ? null : visibleError}
        onConfirmedChange={setRecoveryConfirmed}
        onCommit={handleCommitPreparedProject}
      />
    </div>
  );
}

interface LockedWorkspaceProps {
  readonly projects: readonly GuestEncryptedProjectDescriptor[];
  readonly selectedProjectId: UuidV7 | null;
  readonly busy: boolean;
  readonly creating: boolean;
  readonly unlocking: boolean;
  readonly onCreate: (input: {
    projectName: string;
    chapterTitle: string;
    chapterContent: string;
  }) => Promise<void>;
  readonly onSelect: (projectId: UuidV7) => void;
  readonly onUnlock: (projectId: UuidV7, recoveryMaterial: string) => Promise<void>;
  readonly onExport: (projectId: UuidV7) => Promise<void>;
}

function LockedWorkspace({
  busy,
  creating,
  onCreate,
  onExport,
  onSelect,
  onUnlock,
  projects,
  selectedProjectId,
  unlocking,
}: LockedWorkspaceProps): ReactNode {
  return (
    <div className="web-locked-grid">
      <CreateProjectCard busy={busy} creating={creating} onCreate={onCreate} />
      <Card className="web-project-list">
        <CardHeader>
          <CardTitle>浏览器中的加密项目</CardTitle>
          <CardDescription>
            锁定列表只显示密文 envelope 的标识和版本，不读取项目名或正文。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <EmptyState
              title="还没有加密项目"
              description="创建后，IndexedDB 只会收到版本化密文和恢复 envelope。"
            />
          ) : (
            <div className="web-project-cards">
              {projects.map((project) => {
                const selected = selectedProjectId === project.projectId;
                return (
                  <article
                    key={project.projectId}
                    className="web-encrypted-project"
                    data-selected={selected || undefined}
                  >
                    <div className="web-encrypted-project__summary">
                      <div>
                        <strong>加密项目 · {shortProjectId(project.projectId)}</strong>
                        <span>
                          密钥版本 {String(project.keyVersion)} · 章节密文版本{" "}
                          {String(project.chapterVersion)}
                        </span>
                      </div>
                      <Badge tone="warning">已锁定</Badge>
                    </div>
                    {!selected ? (
                      <Button
                        size="lg"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          onSelect(project.projectId);
                        }}
                      >
                        选择并解锁
                      </Button>
                    ) : (
                      <UnlockForm
                        busy={busy}
                        projectId={project.projectId}
                        unlocking={unlocking}
                        onUnlock={onUnlock}
                      />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        void onExport(project.projectId);
                      }}
                    >
                      下载密文副本
                    </Button>
                  </article>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface CreateProjectCardProps {
  readonly busy: boolean;
  readonly creating: boolean;
  readonly onCreate: LockedWorkspaceProps["onCreate"];
}

function CreateProjectCard({ busy, creating, onCreate }: CreateProjectCardProps): ReactNode {
  const [projectName, setProjectName] = useState("");
  const [chapterTitle, setChapterTitle] = useState("第一章");
  const [chapterContent, setChapterContent] = useState("");

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onCreate({ projectName, chapterTitle, chapterContent });
  }

  return (
    <Card className="web-create-card" surface="light">
      <CardHeader>
        <CardTitle>创建加密项目</CardTitle>
        <CardDescription>
          浏览器会生成独立 256-bit 项目密钥；密钥导入后不可导出，仅当前内存会话可用。
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="web-form-stack">
          <FormField label="项目名称" required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                required
                autoComplete="off"
                value={projectName}
                onChange={(event) => {
                  setProjectName(event.currentTarget.value);
                }}
                placeholder="例如：雾港来信"
              />
            )}
          </FormField>
          <FormField label="首章标题" required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                required
                autoComplete="off"
                value={chapterTitle}
                onChange={(event) => {
                  setChapterTitle(event.currentTarget.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label="首章正文"
            hint="正文先在当前页面内存中编辑，提交时加密后才进入 IndexedDB。"
          >
            {(fieldProps) => (
              <Textarea
                {...fieldProps}
                autoComplete="off"
                value={chapterContent}
                currentLength={chapterContent.length}
                onChange={(event) => {
                  setChapterContent(event.currentTarget.value);
                }}
                rows={8}
                placeholder="从这里开始写…"
              />
            )}
          </FormField>
        </CardContent>
        <CardFooter>
          <Button
            size="lg"
            type="submit"
            disabled={busy}
            loading={creating}
            loadingLabel="正在加密并保存"
          >
            创建加密项目
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

interface UnlockFormProps {
  readonly busy: boolean;
  readonly projectId: UuidV7;
  readonly unlocking: boolean;
  readonly onUnlock: LockedWorkspaceProps["onUnlock"];
}

function UnlockForm({ busy, onUnlock, projectId, unlocking }: UnlockFormProps): ReactNode {
  const [material, setMaterial] = useState("");

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    void onUnlock(projectId, material);
  }

  return (
    <form className="web-unlock-form" onSubmit={handleSubmit}>
      <FormField
        label="恢复材料"
        required
        hint="只在当前内存会话使用；不会写入 localStorage、sessionStorage 或 IndexedDB。"
      >
        {(fieldProps) => (
          <Input
            {...fieldProps}
            required
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={material}
            onChange={(event) => {
              setMaterial(event.currentTarget.value);
            }}
            placeholder="粘贴完整恢复材料"
          />
        )}
      </FormField>
      <Button
        size="lg"
        type="submit"
        disabled={busy}
        loading={unlocking}
        loadingLabel="正在验证密文"
      >
        仅本次会话解锁
      </Button>
    </form>
  );
}

interface UnlockedEditorProps {
  readonly session: GuestProjectSession;
  readonly content: string;
  readonly saveState: SaveState;
  readonly saving: boolean;
  readonly onContentChange: (content: string) => void;
  readonly onSave: () => Promise<void>;
  readonly onLock: () => void;
  readonly onExport: (projectId: UuidV7) => Promise<void>;
}

function UnlockedEditor({
  content,
  onContentChange,
  onExport,
  onLock,
  onSave,
  saveState,
  saving,
  session,
}: UnlockedEditorProps): ReactNode {
  return (
    <Card className="web-editor-card" surface="light">
      <CardHeader className="web-editor-header">
        <div>
          <p className="web-eyebrow">当前会话已解锁</p>
          <CardTitle>{session.project.name}</CardTitle>
          <CardDescription>
            {session.chapter.title} · 版本 {String(session.chapter.revision)}
          </CardDescription>
        </div>
        <SaveStatus state={saveState} />
      </CardHeader>
      <CardContent className="web-editor-content">
        <FormField
          label="章节正文"
          hint="保存会追加新的 AES-256-GCM 密文版本；旧密文版本保留在浏览器中。"
        >
          {(fieldProps) => (
            <Textarea
              {...fieldProps}
              className="web-editor-textarea"
              autoComplete="off"
              value={content}
              currentLength={content.length}
              onChange={(event) => {
                onContentChange(event.currentTarget.value);
              }}
              rows={20}
            />
          )}
        </FormField>
      </CardContent>
      <CardFooter className="web-editor-actions">
        <Button
          size="lg"
          onClick={() => {
            void onSave();
          }}
          disabled={saveState !== "dirty"}
          loading={saving}
          loadingLabel="正在生成密文版本"
        >
          保存密文版本
        </Button>
        <Button size="lg" variant="secondary" onClick={onLock}>
          立即锁定
        </Button>
        <Button
          size="lg"
          variant="ghost"
          onClick={() => {
            void onExport(session.project.id);
          }}
        >
          下载密文副本
        </Button>
      </CardFooter>
    </Card>
  );
}

function CapabilityPanel(): ReactNode {
  const capabilities = [
    {
      name: "浏览器加密写作",
      available: true,
      detail: "可用：WebCrypto + IndexedDB 密文版本",
    },
    {
      name: "加密副本下载",
      available: true,
      detail: "可用：只下载密文 envelope，不含恢复材料",
    },
    {
      name: "云同步",
      available: false,
      detail: "未连接云 API；不会伪装已同步",
    },
    {
      name: "团队协作",
      available: false,
      detail: "Guest 无身份、成员或项目授权 envelope",
    },
    {
      name: "明文外发",
      available: false,
      detail: "此纵切不向任何外部服务发送正文",
    },
    {
      name: "桌面项目文件夹 / SQLite",
      available: false,
      detail: "Web 不读取、镜像或伪装桌面工作区",
    },
  ] as const;

  return (
    <aside className="web-capabilities" aria-labelledby="capability-title">
      <Card>
        <CardHeader>
          <CardTitle id="capability-title">能力边界</CardTitle>
          <CardDescription>只呈现当前 Web 纵切真实具备的能力。</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="web-capability-list">
            {capabilities.map((capability) => (
              <li key={capability.name}>
                <div>
                  <strong>{capability.name}</strong>
                  <span>{capability.detail}</span>
                </div>
                <Badge tone={capability.available ? "success" : "neutral"}>
                  {capability.available ? "可用" : "不可用"}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>存储边界</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="web-boundary-list">
            <div>
              <dt>IndexedDB</dt>
              <dd>版本化密文、nonce、AAD 绑定元数据、恢复 key envelope</dd>
            </div>
            <div>
              <dt>页面内存</dt>
              <dd>不可导出的 CryptoKey、当前解锁正文、临时恢复材料</dd>
            </div>
            <div>
              <dt>Web Storage</dt>
              <dd>不使用 localStorage 或 sessionStorage 保存密钥、恢复材料、项目或章节</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </aside>
  );
}

interface RiskDialogProps {
  readonly open: boolean;
  readonly onAccept: () => void;
}

function RiskDialog({ onAccept, open }: RiskDialogProps): ReactNode {
  return (
    <Dialog
      open={open}
      onOpenChange={() => undefined}
      dismissible={false}
      title="进入浏览器 Guest 工作区前"
      description="这是独立 Web 客户端，不是桌面数据的镜像或从库。"
      footer={
        <Button size="lg" onClick={onAccept}>
          我理解风险，进入工作区
        </Button>
      }
    >
      <ul className="web-risk-list">
        <li>浏览器或你本人清理站点数据后，IndexedDB 中的密文副本会消失。</li>
        <li>同一浏览器配置文件中的其他使用者可看到密文记录；解锁期间页面会显示正文。</li>
        <li>恢复材料只在创建时显示，本站不保存；刷新后必须再次提供才能解锁。</li>
        <li>恢复材料不能单独重建已被清理的密文，请将密文副本与恢复材料分开保管。</li>
      </ul>
    </Dialog>
  );
}

interface RecoveryMaterialDialogProps {
  readonly material: string | null;
  readonly confirmed: boolean;
  readonly committing: boolean;
  readonly error: VisibleError | null;
  readonly onConfirmedChange: (confirmed: boolean) => void;
  readonly onCommit: () => Promise<void>;
}

function RecoveryMaterialDialog({
  committing,
  confirmed,
  error,
  material,
  onConfirmedChange,
  onCommit,
}: RecoveryMaterialDialogProps): ReactNode {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");

  async function copyMaterial(): Promise<void> {
    const clipboard = browserClipboard();
    if (material === null || clipboard === null) {
      setCopyState("manual");
      return;
    }
    try {
      await clipboard.writeText(material);
      setCopyState("copied");
    } catch {
      setCopyState("manual");
    }
  }

  return (
    <Dialog
      open={material !== null}
      onOpenChange={() => undefined}
      dismissible={false}
      title="现在保存恢复材料"
      description="它只存在于当前页面内存中；确认另存后，浏览器才会提交项目密文。"
      footer={
        <Button
          size="lg"
          disabled={!confirmed || committing}
          loading={committing}
          loadingLabel="正在提交项目密文"
          onClick={() => {
            void onCommit();
          }}
        >
          我已另存，保存密文项目
        </Button>
      }
    >
      <div className="web-recovery-stack">
        {error !== null && (
          <InlineAlert
            tone="error"
            title={`项目密文尚未提交 · ${error.code}`}
            description={error.message}
          />
        )}
        <output
          className="web-recovery-material"
          aria-label="项目恢复材料"
          data-testid="recovery-material"
        >
          {material}
        </output>
        <Button
          size="lg"
          variant="secondary"
          onClick={() => {
            void copyMaterial();
          }}
        >
          复制恢复材料
        </Button>
        {copyState !== "idle" && (
          <p role="status">
            {copyState === "copied"
              ? "已复制。请粘贴到浏览器之外的安全位置。"
              : "浏览器未允许复制，请手动选择并保存上方内容。"}
          </p>
        )}
        <label className="web-confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={committing}
            onChange={(event) => {
              onConfirmedChange(event.currentTarget.checked);
            }}
          />
          <span>我已把恢复材料保存到浏览器之外，并理解丢失后无法解锁。</span>
        </label>
      </div>
    </Dialog>
  );
}

function toVisibleError(error: unknown): VisibleError {
  if (error instanceof GuestWorkspaceError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "WEB_STORAGE_FAILED",
    message: "操作未完成。项目密钥和正文均未写入 Web Storage；请重试。",
  };
}

function shortProjectId(projectId: UuidV7): string {
  return `${projectId.slice(0, 8)}…${projectId.slice(-4)}`;
}

function downloadEncryptedEnvelope(projectId: UuidV7, payload: string): void {
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `inkshadow-${projectId}.encrypted.json`;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function browserClipboard(): Clipboard | null {
  const candidate: unknown = Reflect.get(navigator, "clipboard");
  return typeof candidate === "object" &&
    candidate !== null &&
    "writeText" in candidate &&
    typeof candidate.writeText === "function"
    ? (candidate as Clipboard)
    : null;
}
