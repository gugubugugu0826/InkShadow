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
import { MAX_ENCRYPTED_PROJECT_IMPORT_BYTES } from "./application/guest-workspace-service";
import { GuestWorkspaceError, type GuestWorkspaceErrorCode } from "./domain/guest-workspace-error";

export interface AppProps {
  readonly service: GuestWorkspaceService;
}

interface VisibleError {
  readonly code: GuestWorkspaceErrorCode;
  readonly message: string;
}

type BusyAction = "create" | "commit" | "import" | "unlock" | "save";

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
  const [riskDeclined, setRiskDeclined] = useState(false);
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
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [visibleError, setVisibleError] = useState<VisibleError | null>(null);
  const [lockConfirmationOpen, setLockConfirmationOpen] = useState(false);
  const [lockGeneration, setLockGeneration] = useState(0);
  const securityEpoch = useRef(0);
  const sessionRef = useRef<GuestProjectSession | null>(null);
  const editorContentRef = useRef("");
  const saveStateRef = useRef<SaveState>("clean");
  const savePromiseRef = useRef<Promise<GuestProjectSession> | null>(null);
  const automaticLockPromiseRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    editorContentRef.current = editorContent;
  }, [editorContent]);

  useEffect(() => {
    saveStateRef.current = saveState;
  }, [saveState]);

  const secureLock = useCallback((): void => {
    securityEpoch.current += 1;
    service.lockAll();
    sessionRef.current = null;
    editorContentRef.current = "";
    saveStateRef.current = "clean";
    setSession(null);
    setEditorContent("");
    setSaveState("clean");
    setPendingCreation(null);
    setRecoveryConfirmed(false);
    setBusyAction(null);
    setVisibleError(null);
    setLockConfirmationOpen(false);
    setLockGeneration((current) => current + 1);
  }, [service]);

  const saveLatestDraft = useCallback(async (): Promise<GuestProjectSession> => {
    if (savePromiseRef.current !== null) {
      await savePromiseRef.current;
    }

    const currentSession = sessionRef.current;
    if (currentSession === null) {
      throw new GuestWorkspaceError("WEB_PROJECT_LOCKED", "项目已经锁定，无需再次保存。");
    }
    const currentContent = editorContentRef.current;
    if (currentContent === currentSession.chapter.content) {
      return currentSession;
    }

    const operationEpoch = securityEpoch.current;
    const savePromise = service.saveChapter({
      projectId: currentSession.project.id,
      expectedRevision: currentSession.chapter.revision,
      content: currentContent,
    });
    savePromiseRef.current = savePromise;
    try {
      const saved = await savePromise;
      if (securityEpoch.current !== operationEpoch) {
        throw new GuestWorkspaceError(
          "WEB_PROJECT_LOCKED",
          "页面已锁定，本次保存没有重新载入正文。",
        );
      }
      sessionRef.current = saved;
      setSession(saved);
      const latestIsSaved = editorContentRef.current === saved.chapter.content;
      saveStateRef.current = latestIsSaved ? "saved_local" : "dirty";
      setSaveState(latestIsSaved ? "saved_local" : "dirty");
      return saved;
    } finally {
      if (savePromiseRef.current === savePromise) {
        savePromiseRef.current = null;
      }
    }
  }, [service]);

  const saveAndSecureLock = useCallback(
    async (automatic: boolean): Promise<void> => {
      if (automaticLockPromiseRef.current !== null) {
        return automaticLockPromiseRef.current;
      }

      const operation = (async (): Promise<void> => {
        const lockedProjectId = sessionRef.current?.project.id ?? null;
        if (lockedProjectId === null) {
          secureLock();
          return;
        }

        const needsSave =
          saveStateRef.current === "dirty" ||
          saveStateRef.current === "saving" ||
          saveStateRef.current === "save_failed";
        if (!needsSave) {
          setSelectedProjectId(lockedProjectId);
          secureLock();
          return;
        }

        setBusyAction("save");
        saveStateRef.current = "saving";
        setSaveState("saving");
        setVisibleError(null);
        let temporaryDraftPreserved = false;
        let temporaryDraftError: VisibleError | null = null;
        if (automatic) {
          const currentSession = sessionRef.current;
          if (currentSession !== null) {
            try {
              await service.preserveTemporaryDraft({
                projectId: currentSession.project.id,
                expectedRevision: currentSession.chapter.revision,
                content: editorContentRef.current,
              });
              temporaryDraftPreserved = true;
            } catch (error) {
              temporaryDraftError = toVisibleError(error);
            }
          }
        }
        try {
          await saveLatestDraft();
          setSelectedProjectId(lockedProjectId);
          secureLock();
          if (!automatic) {
            toast({
              title: "最新修改已保存并锁定",
              description: "正文已加密保存，项目密钥已从当前页面清除。",
              tone: "success",
            });
          }
        } catch (error) {
          const visible = toVisibleError(error);
          if (automatic) {
            secureLock();
            setVisibleError({
              code: visible.code,
              message: temporaryDraftPreserved
                ? `页面已安全锁定。正式保存失败，但未保存修改已写入仅含密文的临时恢复副本；下次使用恢复材料解锁时会自动恢复。失败原因：${visible.message}`
                : `页面已安全锁定；正式保存和临时恢复密文均未能写入，最近修改可能无法恢复。正式保存失败：${visible.message}${
                    temporaryDraftError === null
                      ? ""
                      : `；临时恢复失败：${temporaryDraftError.message}`
                  }`,
            });
          } else {
            saveStateRef.current = "save_failed";
            setSaveState("save_failed");
            setBusyAction(null);
            setVisibleError(visible);
            setLockConfirmationOpen(false);
          }
        }
      })();
      automaticLockPromiseRef.current = operation;
      try {
        await operation;
      } finally {
        if (automaticLockPromiseRef.current === operation) {
          automaticLockPromiseRef.current = null;
        }
      }
    },
    [saveLatestDraft, secureLock, service, toast],
  );

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
        void saveAndSecureLock(true);
      }
    };
    const lockOnPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) {
        secureLock();
      }
    };
    const warnBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (
        saveStateRef.current === "dirty" ||
        saveStateRef.current === "saving" ||
        saveStateRef.current === "save_failed"
      ) {
        event.preventDefault();
      }
    };
    const lockOnPageHide = (): void => {
      void saveAndSecureLock(true);
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    window.addEventListener("pagehide", lockOnPageHide);
    window.addEventListener("pageshow", lockOnPageShow);
    document.addEventListener("visibilitychange", lockOnVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      window.removeEventListener("pagehide", lockOnPageHide);
      window.removeEventListener("pageshow", lockOnPageShow);
      document.removeEventListener("visibilitychange", lockOnVisibilityChange);
      service.lockAll();
    };
  }, [saveAndSecureLock, secureLock, service]);

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
      sessionRef.current = committed;
      editorContentRef.current = committed.chapter.content;
      saveStateRef.current = "saved_local";
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
      const restoredContent = unlocked.recoveredDraft?.content ?? unlocked.chapter.content;
      const restoredTemporaryDraft = unlocked.recoveredDraft !== undefined;
      sessionRef.current = unlocked;
      editorContentRef.current = restoredContent;
      saveStateRef.current = restoredTemporaryDraft ? "dirty" : "clean";
      setSession(unlocked);
      setEditorContent(restoredContent);
      setSaveState(restoredTemporaryDraft ? "dirty" : "clean");
      setSelectedProjectId(projectId);
      toast({
        title: restoredTemporaryDraft ? "已恢复临时加密草稿" : "项目已在当前会话解锁",
        description: restoredTemporaryDraft
          ? "上次自动锁定时未能正式保存的正文已恢复，请尽快保存密文版本。"
          : "刷新或关闭页面后仍需再次提供恢复材料。",
        tone: restoredTemporaryDraft ? "warning" : "success",
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
    if (session === null || (saveState !== "dirty" && saveState !== "save_failed")) {
      return;
    }
    const operationEpoch = securityEpoch.current;
    setBusyAction("save");
    saveStateRef.current = "saving";
    setSaveState("saving");
    setVisibleError(null);
    try {
      const saved = await saveLatestDraft();
      if (securityEpoch.current !== operationEpoch) {
        return;
      }
      await refreshProjects();
      toast({
        title: "密文版本已保存",
        description: `章节版本 ${String(saved.chapter.revision)} 已写入浏览器加密存储。`,
        tone: "success",
      });
    } catch (error) {
      if (securityEpoch.current === operationEpoch) {
        saveStateRef.current = "save_failed";
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
    if (saveState === "dirty" || saveState === "saving" || saveState === "save_failed") {
      setLockConfirmationOpen(true);
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

  async function handleImport(file: File, recoveryMaterial: string): Promise<void> {
    setBusyAction("import");
    setVisibleError(null);
    const operationEpoch = securityEpoch.current;
    try {
      if (file.size === 0 || file.size > MAX_ENCRYPTED_PROJECT_IMPORT_BYTES) {
        throw new GuestWorkspaceError(
          "WEB_VALIDATION_FAILED",
          "请选择不超过 32 MB 的墨影加密副本文件。",
        );
      }
      const payload = await file.text();
      const imported = await service.importEncryptedProject(payload, recoveryMaterial);
      if (securityEpoch.current !== operationEpoch) {
        return;
      }
      sessionRef.current = imported;
      editorContentRef.current = imported.chapter.content;
      saveStateRef.current = "clean";
      setSession(imported);
      setEditorContent(imported.chapter.content);
      setSaveState("clean");
      setSelectedProjectId(imported.project.id);
      await refreshProjects();
      toast({
        title: "加密副本已恢复",
        description: `“${imported.project.name}”已导入当前浏览器并在本次会话解锁。`,
        tone: "success",
      });
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
          <span className="web-product-name">浏览器访客版</span>
        </div>
        <div className="web-session-state" aria-label="会话安全状态">
          <Badge tone="success">密钥仅在内存</Badge>
          <Badge tone="info">独立浏览器工作区</Badge>
        </div>
      </header>

      <main id="web-main" className="web-layout" tabIndex={-1}>
        <section className="web-workspace" aria-labelledby="workspace-title">
          <div className="web-heading">
            <div>
              <p className="web-eyebrow">浏览器本地 · 加密写作</p>
              <h1 id="workspace-title">访客写作工作区</h1>
              <p>
                项目与章节会先在浏览器内加密再保存。项目名、章节标题和正文不会以明文写入浏览器存储。
              </p>
            </div>
          </div>

          <InlineAlert
            tone="warning"
            title="浏览器存储不是桌面备份"
            description="清理站点数据会删除这里的加密副本；共享浏览器配置文件也会共享这份密文。请分别下载加密副本和恢复材料，本站不会保存恢复材料。"
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
                importing={busyAction === "import"}
                unlocking={busyAction === "unlock"}
                onCreate={handleCreate}
                onImport={handleImport}
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
                  editorContentRef.current = content;
                  const nextSaveState = content === session.chapter.content ? "clean" : "dirty";
                  saveStateRef.current = nextSaveState;
                  setEditorContent(content);
                  setSaveState(nextSaveState);
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
        <span>无账号 · 无云请求 · 无遥测 · 不在浏览器常规存储中保存密钥</span>
        <span>刷新后自动回到锁定状态</span>
      </footer>

      <RiskDialog
        open={!riskAccepted && !riskDeclined}
        onAccept={() => {
          setRiskAccepted(true);
        }}
        onDecline={() => {
          secureLock();
          setRiskDeclined(true);
        }}
      />
      <RiskDeclinedDialog
        open={riskDeclined}
        onReview={() => {
          setRiskDeclined(false);
        }}
      />
      <RecoveryMaterialDialog
        key={pendingCreation?.session.project.id ?? "no-pending-project"}
        project={pendingCreation?.session.project ?? null}
        material={pendingCreation?.recoveryMaterial ?? null}
        confirmed={recoveryConfirmed}
        committing={busyAction === "commit"}
        error={pendingCreation === null ? null : visibleError}
        onConfirmedChange={setRecoveryConfirmed}
        onCommit={handleCommitPreparedProject}
      />
      <UnsavedLockDialog
        open={lockConfirmationOpen}
        saving={busyAction === "save"}
        onCancel={() => {
          setLockConfirmationOpen(false);
        }}
        onDiscard={() => {
          const projectId = sessionRef.current?.project.id;
          if (projectId !== undefined) {
            setSelectedProjectId(projectId);
          }
          secureLock();
        }}
        onSaveAndLock={() => {
          void saveAndSecureLock(false);
        }}
      />
    </div>
  );
}

interface LockedWorkspaceProps {
  readonly projects: readonly GuestEncryptedProjectDescriptor[];
  readonly selectedProjectId: UuidV7 | null;
  readonly busy: boolean;
  readonly creating: boolean;
  readonly importing: boolean;
  readonly unlocking: boolean;
  readonly onCreate: (input: {
    projectName: string;
    chapterTitle: string;
    chapterContent: string;
  }) => Promise<void>;
  readonly onImport: (file: File, recoveryMaterial: string) => Promise<void>;
  readonly onSelect: (projectId: UuidV7) => void;
  readonly onUnlock: (projectId: UuidV7, recoveryMaterial: string) => Promise<void>;
  readonly onExport: (projectId: UuidV7) => Promise<void>;
}

function LockedWorkspace({
  busy,
  creating,
  importing,
  onCreate,
  onExport,
  onImport,
  onSelect,
  onUnlock,
  projects,
  selectedProjectId,
  unlocking,
}: LockedWorkspaceProps): ReactNode {
  return (
    <div className="web-locked-grid">
      <div className="web-locked-actions">
        <CreateProjectCard busy={busy} creating={creating} onCreate={onCreate} />
        <ImportProjectCard busy={busy} importing={importing} onImport={onImport} />
      </div>
      <Card className="web-project-list">
        <CardHeader>
          <CardTitle headingLevel={2}>浏览器中的加密项目</CardTitle>
          <CardDescription>锁定时只显示项目标识和加密版本，不读取项目名或正文。</CardDescription>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <EmptyState
              title="还没有加密项目"
              description="你可以创建新项目，或用加密副本和配套恢复材料找回已有项目。"
              headingLevel={3}
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
                        <code className="web-project-id">{project.projectId}</code>
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

interface ImportProjectCardProps {
  readonly busy: boolean;
  readonly importing: boolean;
  readonly onImport: LockedWorkspaceProps["onImport"];
}

function ImportProjectCard({ busy, importing, onImport }: ImportProjectCardProps): ReactNode {
  const [file, setFile] = useState<File | null>(null);
  const [recoveryMaterial, setRecoveryMaterial] = useState("");
  const fileError =
    file !== null && (file.size === 0 || file.size > MAX_ENCRYPTED_PROJECT_IMPORT_BYTES)
      ? "文件必须大于 0 字节且不超过 32 MB。"
      : undefined;
  const canImport =
    file !== null && fileError === undefined && recoveryMaterial.trim().length > 0 && !busy;

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canImport) {
      return;
    }
    void onImport(file, recoveryMaterial.trim());
  }

  return (
    <Card className="web-import-card">
      <CardHeader>
        <CardTitle headingLevel={2}>从加密副本恢复</CardTitle>
        <CardDescription>
          同时提供下载过的加密副本和对应恢复材料。验证成功后才会写入当前浏览器。
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="web-form-stack">
          <FormField
            label="墨影加密副本"
            required
            error={fileError}
            hint="支持由本页面下载的 .encrypted.json 文件，最大 32 MB。"
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                required
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                }}
              />
            )}
          </FormField>
          <FormField
            label="对应的恢复材料"
            required
            hint="只在内存中用于验证和解锁，不会保存在浏览器中。"
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                required
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                value={recoveryMaterial}
                onChange={(event) => {
                  setRecoveryMaterial(event.currentTarget.value);
                }}
                placeholder="粘贴与副本配套的完整恢复材料"
              />
            )}
          </FormField>
        </CardContent>
        <CardFooter>
          <Button
            size="lg"
            type="submit"
            disabled={!canImport}
            loading={importing}
            loadingLabel="正在验证并恢复"
          >
            验证并恢复项目
          </Button>
        </CardFooter>
      </form>
    </Card>
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
  const canCreate =
    isValidVisibleText(projectName, 120) &&
    isValidVisibleText(chapterTitle, 200) &&
    !chapterContent.includes("\u0000") &&
    !busy;

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    void onCreate({ projectName, chapterTitle, chapterContent });
  }

  return (
    <Card className="web-create-card" surface="light">
      <CardHeader>
        <CardTitle headingLevel={2}>创建加密项目</CardTitle>
        <CardDescription>
          浏览器会生成独立的 256 位项目密钥。项目密钥不能导出，只在当前页面会话中使用。
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
                maxLength={120}
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
                maxLength={200}
                value={chapterTitle}
                onChange={(event) => {
                  setChapterTitle(event.currentTarget.value);
                }}
              />
            )}
          </FormField>
          <FormField
            label="首章正文"
            hint="正文先在当前页面内存中编辑，确认恢复材料已另存后才会加密写入浏览器。"
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
            disabled={!canCreate}
            loading={creating}
            loadingLabel="正在生成加密项目"
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
  const canUnlock = material.trim().length > 0 && !busy;

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canUnlock) {
      return;
    }
    void onUnlock(projectId, material.trim());
  }

  return (
    <form className="web-unlock-form" onSubmit={handleSubmit}>
      <FormField
        label="恢复材料"
        required
        hint="只在当前页面会话的内存中使用，不会写入任何浏览器存储。"
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
        disabled={!canUnlock}
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
          <CardTitle headingLevel={2}>{session.project.name}</CardTitle>
          <CardDescription>
            {session.chapter.title} · 版本 {String(session.chapter.revision)}
          </CardDescription>
        </div>
        <SaveStatus state={saveState} />
      </CardHeader>
      <CardContent className="web-editor-content">
        <FormField
          label="章节正文"
          hint="每次保存都会追加一个新的加密版本，旧的加密版本仍保留在浏览器中。"
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
          disabled={saveState !== "dirty" && saveState !== "save_failed"}
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
      detail: "可用：浏览器内完成加密，只将加密版本写入本地",
    },
    {
      name: "加密副本备份与恢复",
      available: true,
      detail: "可用：加密副本可下载并重新导入，恢复材料需分开保管",
    },
    {
      name: "云同步",
      available: false,
      detail: "未连接云服务，不会显示虚假的同步状态",
    },
    {
      name: "团队协作",
      available: false,
      detail: "访客版没有账号、成员和项目权限能力",
    },
    {
      name: "明文外发",
      available: false,
      detail: "访客版不会向任何外部服务发送正文",
    },
    {
      name: "桌面项目文件夹与本地数据库",
      available: false,
      detail: "浏览器访客版不读取、复制或伪装桌面工作区",
    },
  ] as const;

  return (
    <aside className="web-capabilities" aria-labelledby="capability-title">
      <Card>
        <CardHeader>
          <CardTitle id="capability-title" headingLevel={2}>
            能力边界
          </CardTitle>
          <CardDescription>这里只列出浏览器访客版真实具备的能力。</CardDescription>
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
          <CardTitle headingLevel={2}>存储边界</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="web-boundary-list">
            <div>
              <dt>浏览器加密存储</dt>
              <dd>版本化密文、完整性校验信息和加密后的项目密钥</dd>
            </div>
            <div>
              <dt>页面临时内存</dt>
              <dd>不可导出的项目密钥、当前解锁正文和临时恢复材料</dd>
            </div>
            <div>
              <dt>浏览器常规存储</dt>
              <dd>不会使用浏览器常规存储保存密钥、恢复材料、项目或章节</dd>
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
  readonly onDecline: () => void;
}

function RiskDialog({ onAccept, onDecline, open }: RiskDialogProps): ReactNode {
  const acceptButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDecline();
        }
      }}
      initialFocusRef={acceptButtonRef}
      title="进入浏览器访客工作区前"
      description="这是独立的浏览器工作区，不是桌面数据的镜像或副本。"
      footer={
        <div className="web-dialog-actions">
          <Button ref={acceptButtonRef} size="lg" onClick={onAccept}>
            我理解风险，进入工作区
          </Button>
          <Button size="lg" variant="secondary" onClick={onDecline}>
            暂不进入
          </Button>
        </div>
      }
    >
      <ul className="web-risk-list">
        <li>浏览器或你本人清理站点数据后，保存在本机的加密副本会消失。</li>
        <li>同一浏览器配置文件中的其他使用者可看到密文记录；解锁期间页面会显示正文。</li>
        <li>恢复材料只在创建时显示，本站不保存；刷新后必须再次提供才能解锁。</li>
        <li>恢复材料不能单独重建已被清理的密文，请将密文副本与恢复材料分开保管。</li>
        <li>
          切换标签页或离开时会先尝试保存再锁定；如果浏览器来不及完成或写入失败，最近修改可能未保存。
        </li>
      </ul>
    </Dialog>
  );
}

interface RiskDeclinedDialogProps {
  readonly open: boolean;
  readonly onReview: () => void;
}

function RiskDeclinedDialog({ onReview, open }: RiskDeclinedDialogProps): ReactNode {
  return (
    <Dialog
      open={open}
      onOpenChange={() => undefined}
      dismissible={false}
      title="尚未进入工作区"
      description="你没有接受浏览器访客版的风险说明，项目密钥和正文均未载入。"
      footer={
        <Button size="lg" variant="secondary" onClick={onReview}>
          重新查看风险说明
        </Button>
      }
    >
      <p className="web-dialog-copy">可以安全关闭此标签页，或重新阅读说明后再决定是否进入。</p>
    </Dialog>
  );
}

interface UnsavedLockDialogProps {
  readonly open: boolean;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onDiscard: () => void;
  readonly onSaveAndLock: () => void;
}

function UnsavedLockDialog({
  onCancel,
  onDiscard,
  onSaveAndLock,
  open,
  saving,
}: UnsavedLockDialogProps): ReactNode {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) {
          onCancel();
        }
      }}
      dismissible={!saving}
      title="有修改尚未保存"
      description="锁定会清除当前页面中的正文和项目密钥。你可以先保存，也可以明确放弃本次修改。"
      footer={
        <div className="web-dialog-actions">
          <Button size="lg" loading={saving} loadingLabel="正在保存并锁定" onClick={onSaveAndLock}>
            保存并锁定
          </Button>
          <Button size="lg" variant="secondary" disabled={saving} onClick={onCancel}>
            继续编辑
          </Button>
          <Button size="lg" variant="danger" disabled={saving} onClick={onDiscard}>
            放弃修改并锁定
          </Button>
        </div>
      }
    >
      <InlineAlert
        tone="warning"
        title="放弃修改无法撤销"
        description="选择“放弃修改并锁定”后，最近一次成功保存之后的内容不会写入加密副本。"
      />
    </Dialog>
  );
}

interface RecoveryMaterialDialogProps {
  readonly project: GuestProjectSession["project"] | null;
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
  project,
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
      open={material !== null && project !== null}
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
        {project !== null && (
          <dl className="web-recovery-project">
            <div>
              <dt>项目名称</dt>
              <dd>{project.name}</dd>
            </div>
            <div>
              <dt>完整项目标识</dt>
              <dd>
                <code>{project.id}</code>
              </dd>
            </div>
            <div>
              <dt>创建时间</dt>
              <dd>{formatLocalTimestamp(project.toSnapshot().createdAt)}</dd>
            </div>
          </dl>
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
        <Button
          size="lg"
          variant="secondary"
          disabled={project === null || material === null}
          onClick={() => {
            if (project !== null && material !== null) {
              downloadRecoveryMaterial(project, material);
            }
          }}
        >
          下载带项目标识的恢复文件
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
          <span>我已把带项目名称和完整标识的恢复材料保存到浏览器之外，并理解丢失后无法解锁。</span>
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
    message: "操作未完成。项目密钥和正文均未写入浏览器存储，请重试。",
  };
}

function shortProjectId(projectId: UuidV7): string {
  return `${projectId.slice(0, 8)}…${projectId.slice(-4)}`;
}

function downloadEncryptedEnvelope(projectId: UuidV7, payload: string): void {
  downloadBlob(
    `inkshadow-${projectId}.encrypted.json`,
    new Blob([payload], { type: "application/json" }),
  );
}

function downloadRecoveryMaterial(
  project: GuestProjectSession["project"],
  recoveryMaterial: string,
): void {
  const createdAt = project.toSnapshot().createdAt;
  const content = [
    "墨影浏览器访客版恢复材料",
    "",
    `项目名称：${project.name}`,
    `完整项目标识：${project.id}`,
    `创建时间：${createdAt}`,
    `恢复材料：${recoveryMaterial}`,
    "",
    "重要：此文件不能单独恢复项目。请与对应的 .encrypted.json 加密副本分开保管。",
    "任何获得这两份文件的人都可能解锁项目，请勿通过不可信渠道发送。",
  ].join("\n");
  const safeProjectName = sanitizeDownloadName(project.name);
  downloadBlob(
    `inkshadow-${safeProjectName}-${project.id}.recovery.txt`,
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function sanitizeDownloadName(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, 48);
  return normalized.length === 0 ? "project" : normalized;
}

function formatLocalTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timestamp);
}

function isValidVisibleText(value: string, maxLength: number): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    normalized.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
  );
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
