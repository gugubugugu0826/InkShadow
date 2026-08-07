import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSyncRegistration } from "@inkshadow/data";
import type { Project } from "@inkshadow/domain";
import type {
  DevicePublicKeyRecord,
  ProjectKeyBundle,
} from "@inkshadow/data/project-key-sqlite-store";
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
  FormField,
  InlineAlert,
  Input,
  PageStateBoundary,
  Select,
} from "@inkshadow/ui";
import { Link, useNavigate } from "react-router-dom";

import type {
  CloudAccountManagementService,
  CloudAccountManagementSnapshot,
} from "../infrastructure/cloud-account-management-service";
import type { PendingProjectRecoveryDisplay } from "../infrastructure/project-key-lifecycle";
import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";
import { CloudDeletionSecurityCard } from "./cloud-deletion-security-card";

type BusyAction = "device" | "prepare" | "confirm" | "reset" | "enable" | "disable" | null;
type PageState = "loading" | "ready" | "empty" | "fatal_error";
type EnrollmentNotice = Readonly<{
  tone: "info" | "warning";
  title: string;
  description: string;
}>;

export function SyncSecurityPage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const cloudEnrollmentAvailable =
    runtime.mode === "tauri" &&
    runtime.projectSecurity !== null &&
    runtime.cloudFoundation !== null &&
    runtime.cloudSyncEnrollment !== null;
  const [pageState, setPageState] = useState<PageState>("loading");
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [device, setDevice] = useState<DevicePublicKeyRecord | null>(null);
  const [deviceName, setDeviceName] = useState("我的电脑");
  const [bundle, setBundle] = useState<ProjectKeyBundle | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<unknown>(null);
  const [recoveryDisplay, setRecoveryDisplay] = useState<PendingProjectRecoveryDisplay | null>(
    null,
  );
  const [confirmationCode, setConfirmationCode] = useState("");
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [registration, setRegistration] = useState<ProjectSyncRegistration | null>(null);
  const [registrationLoading, setRegistrationLoading] = useState(false);
  const [registrationLoadFailed, setRegistrationLoadFailed] = useState(false);
  const [enableOpen, setEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [syncConsent, setSyncConsent] = useState(false);
  const [enrollmentNotice, setEnrollmentNotice] = useState<EnrollmentNotice | null>(null);
  const selectedProjectRef = useRef("");

  const readBundle = useCallback(
    async (
      projectId: string,
      currentDevice: DevicePublicKeyRecord | null,
    ): Promise<ProjectKeyBundle | null> => {
      if (runtime.cloudFoundation === null || currentDevice === null) {
        if (selectedProjectRef.current === projectId) {
          setBundle(null);
        }
        return null;
      }
      const result = await runtime.cloudFoundation.projectKeys.loadProjectKeyBundle(
        projectId,
        currentDevice.deviceId,
      );
      if (!result.ok) {
        throw result.error;
      }
      if (selectedProjectRef.current === projectId) {
        setBundle(result.value);
      }
      return result.value;
    },
    [runtime],
  );

  const readRegistration = useCallback(
    async (projectId: string): Promise<ProjectSyncRegistration | null> => {
      if (!cloudEnrollmentAvailable) {
        setRegistration(null);
        setRegistrationLoading(false);
        setRegistrationLoadFailed(false);
        return null;
      }
      if (selectedProjectRef.current === projectId) {
        setRegistrationLoading(true);
        setRegistrationLoadFailed(false);
      }
      try {
        const loaded = await runtime.cloudSyncEnrollment.loadProjectRegistration(projectId);
        if (selectedProjectRef.current === projectId) {
          setRegistration(loaded);
          setRegistrationLoadFailed(false);
        }
        return loaded;
      } catch (reason: unknown) {
        if (selectedProjectRef.current === projectId) {
          setRegistration(null);
          setRegistrationLoadFailed(true);
        }
        throw reason;
      } finally {
        if (selectedProjectRef.current === projectId) {
          setRegistrationLoading(false);
        }
      }
    },
    [cloudEnrollmentAvailable, runtime.cloudSyncEnrollment],
  );

  const loadPage = useCallback(async () => {
    setPageState("loading");
    setError(null);
    try {
      const projectResult = await runtime.useCases.listProjects.execute({
        statuses: ["active", "archived"],
        search: "",
      });
      if (!projectResult.ok) {
        throw projectResult.error;
      }
      const loadedProjects = projectResult.value;
      setProjects(loadedProjects);

      let localDevice: DevicePublicKeyRecord | null = null;
      if (runtime.cloudFoundation !== null) {
        const deviceResult = await runtime.cloudFoundation.projectKeys.listLocalDevicePublicKeys();
        if (!deviceResult.ok) {
          throw deviceResult.error;
        }
        localDevice = deviceResult.value[0] ?? null;
      }
      setDevice(localDevice);
      if (localDevice !== null) {
        setDeviceName(localDevice.displayName);
      }

      const firstProjectId = loadedProjects[0]?.id ?? "";
      selectedProjectRef.current = firstProjectId;
      setSelectedProjectId(firstProjectId);
      if (firstProjectId.length > 0) {
        await Promise.all([
          readBundle(firstProjectId, localDevice),
          readRegistration(firstProjectId),
        ]);
      } else {
        setBundle(null);
        setRegistration(null);
      }
      setPageState(loadedProjects.length === 0 ? "empty" : "ready");
    } catch (reason: unknown) {
      setError(reason);
      setPageState("fatal_error");
    }
  }, [readBundle, readRegistration, runtime]);

  useEffect(() => {
    void Promise.resolve().then(loadPage);
  }, [loadPage]);

  async function selectProject(projectId: string): Promise<void> {
    selectedProjectRef.current = projectId;
    setSelectedProjectId(projectId);
    clearRecoveryInput();
    setRegistration(null);
    setRegistrationLoadFailed(false);
    setEnrollmentNotice(null);
    setEnableOpen(false);
    setDisableOpen(false);
    setSyncConsent(false);
    setError(null);
    try {
      await Promise.all([readBundle(projectId, device), readRegistration(projectId)]);
    } catch (reason: unknown) {
      setError(reason);
    }
  }

  async function saveDeviceIdentity(): Promise<void> {
    if (runtime.projectSecurity === null) {
      return;
    }
    setBusy("device");
    setError(null);
    try {
      const saved = await runtime.projectSecurity.ensureLocalDeviceIdentity({
        displayName: deviceName.trim(),
      });
      setDevice(saved);
      setDeviceName(saved.displayName);
      if (selectedProjectId.length > 0) {
        await readBundle(selectedProjectId, saved);
      }
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function prepareProjectKey(): Promise<void> {
    if (runtime.projectSecurity === null || device === null || selectedProjectId.length === 0) {
      return;
    }
    setBusy("prepare");
    setError(null);
    try {
      const pending = await runtime.projectSecurity.prepareInitialProjectKey(
        selectedProjectId,
        device,
      );
      setRecoveryDisplay(pending);
      setConfirmationCode("");
      setRecoverySaved(false);
      setCopied(false);
      await readBundle(selectedProjectId, device);
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function confirmRecovery(): Promise<void> {
    if (
      runtime.projectSecurity === null ||
      device === null ||
      selectedProjectId.length === 0 ||
      !recoverySaved ||
      confirmationCode.trim().length === 0
    ) {
      return;
    }
    setBusy("confirm");
    setError(null);
    try {
      await runtime.projectSecurity.confirmPendingProjectKey(
        selectedProjectId,
        device.deviceId,
        confirmationCode.trim(),
      );
      closeRecoveryDisplay();
      await readBundle(selectedProjectId, device);
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function abandonPendingSetup(): Promise<void> {
    if (runtime.projectSecurity === null || device === null || selectedProjectId.length === 0) {
      return;
    }
    setBusy("reset");
    setError(null);
    try {
      await runtime.projectSecurity.abandonPendingProjectKeySetup(
        selectedProjectId,
        device.deviceId,
      );
      setResetOpen(false);
      closeRecoveryDisplay();
      await readBundle(selectedProjectId, device);
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function copyRecoveryCode(): Promise<void> {
    if (recoveryDisplay === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(recoveryDisplay.recoveryCode);
      setCopied(true);
    } catch (reason: unknown) {
      setError(reason);
    }
  }

  function clearRecoveryInput(): void {
    setConfirmationCode("");
    setRecoverySaved(false);
    setCopied(false);
  }

  function closeRecoveryDisplay(): void {
    setRecoveryDisplay(null);
    clearRecoveryInput();
  }

  async function enableProjectSync(): Promise<void> {
    if (!cloudEnrollmentAvailable || selectedProjectId.length === 0 || !syncConsent) {
      return;
    }
    const projectId = selectedProjectId;
    setBusy("enable");
    setError(null);
    setEnrollmentNotice(null);
    try {
      const result = await runtime.cloudSyncEnrollment.enableProject(projectId);
      if (selectedProjectRef.current !== projectId) {
        return;
      }
      if (result.state === "enabled") {
        setEnrollmentNotice({
          tone: "info",
          title: "云同步已启用",
          description: "该项目已完成显式授权与安全启动，可以在已授权设备之间同步密文。",
        });
      } else if (result.state === "retryable") {
        setEnrollmentNotice({
          tone: "warning",
          title: "暂时无法完成启用",
          description:
            "授权已安全保存，但网络或云服务暂时不可用。请稍后重试，期间不会假装同步已经开启。",
        });
      } else if (result.state === "blocked") {
        setEnrollmentNotice({
          tone: "warning",
          title: "启用需要先处理安全阻塞",
          description: "项目仍保持未完成状态。请检查登录、设备授权、密钥与待处理同步记录后重试。",
        });
      } else {
        setEnrollmentNotice({
          tone: "info",
          title: "云同步没有启用",
          description:
            "操作已取消或当前配置不可用，项目内容同步仍未启用；若安全准备已完成，云端可能保留不含正文的加密密钥封装以便安全续接。",
        });
      }
      setEnableOpen(false);
      setSyncConsent(false);
      await readRegistration(projectId);
    } catch (reason: unknown) {
      setError(reason);
      await readRegistration(projectId).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function disableProjectSync(): Promise<void> {
    if (!cloudEnrollmentAvailable || selectedProjectId.length === 0) {
      return;
    }
    const projectId = selectedProjectId;
    setBusy("disable");
    setError(null);
    setEnrollmentNotice(null);
    try {
      const result = await runtime.cloudSyncEnrollment.disableProject(projectId);
      if (selectedProjectRef.current !== projectId) {
        return;
      }
      setDisableOpen(false);
      setEnrollmentNotice({
        tone: "info",
        title: result.state === "already_disabled" ? "云同步已经关闭" : "云同步已关闭",
        description: "该项目不会再发起新的同步；已有云端密文没有被删除。",
      });
      await readRegistration(projectId);
    } catch (reason: unknown) {
      setError(reason);
      await readRegistration(projectId).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  const normalizedError = error === null ? null : normalizeUiError(error);
  const selectedProject = projects.find(({ id }) => id === selectedProjectId) ?? null;
  const nativeSecurityAvailable =
    runtime.mode === "tauri" &&
    runtime.projectSecurity !== null &&
    runtime.cloudFoundation !== null;
  const activeConfirmedProjectKey =
    bundle?.version.state === "active" &&
    bundle.version.retiredAt === null &&
    bundle.recoveryEnvelope.confirmedAt !== null &&
    bundle.recoveryEnvelope.revokedAt === null;
  const registrationCanEnable = !registrationLoadFailed && registration?.state !== "enabled";
  const registrationCanDisable =
    !registrationLoadFailed && registration !== null && registration.state !== "disabled";

  return (
    <div className="desktop-page sync-security-page">
      <header className="page-heading">
        <div>
          <p className="page-heading__eyebrow">端到端加密</p>
          <h1>同步安全</h1>
          <p>先为设备和单个项目建立密钥；确认恢复码前不会启用任何云同步。</p>
          <Link className="back-link" to="/settings">
            返回设置
          </Link>
        </div>
        <Badge tone="neutral">同步默认关闭</Badge>
      </header>

      {!nativeSecurityAvailable && (
        <InlineAlert
          tone="warning"
          title="需要桌面应用的系统凭据库"
          description="浏览器开发模式不会创建、模拟或保存设备私钥和恢复码。项目与本地编辑仍可正常使用。"
        />
      )}

      {nativeSecurityAvailable && runtime.cloudSyncEnrollment === null && (
        <InlineAlert
          tone="warning"
          title="此版本暂不可使用云同步"
          description="本机仍可准备端到端加密材料，但云同步功能开关或完整原生运行时尚未就绪，不会发起云端请求。"
        />
      )}

      {cloudEnrollmentAvailable && (
        <InlineAlert
          tone="info"
          title="云同步按项目显式授权"
          description="查看或切换项目不会开启同步。每个项目都必须在恢复码确认后，由你单独阅读说明并明确同意。"
        />
      )}

      {runtime.cloudAccount !== null && <CloudAccountSecurityCard service={runtime.cloudAccount} />}

      {runtime.cloudDeletion !== null && (
        <CloudDeletionSecurityCard
          service={runtime.cloudDeletion}
          selectedProject={selectedProject}
        />
      )}

      {normalizedError !== null && (
        <InlineAlert
          tone="error"
          title={normalizedError.title}
          description={`${normalizedError.description}（${normalizedError.code}）`}
        />
      )}

      <PageStateBoundary
        state={pageState}
        preserveContent={false}
        loadingLabel="正在读取本地同步安全状态"
        fallbacks={{
          empty: (
            <EmptyState
              kind="no_data"
              title="还没有可保护的项目"
              description="先创建一个本地项目，再逐项目建立端到端加密密钥。"
              primaryAction={{
                label: "前往项目",
                onClick: () => {
                  void navigate("/projects");
                },
              }}
            />
          ),
          fatal_error:
            normalizedError === null ? undefined : (
              <InlineAlert
                tone="error"
                title="无法读取同步安全状态"
                description={`${normalizedError.description}（${normalizedError.code}）`}
              />
            ),
        }}
      >
        <div className="settings-grid">
          <Card>
            <CardHeader>
              <div className="card-heading-row">
                <div>
                  <CardTitle>本机设备身份</CardTitle>
                  <CardDescription>
                    私钥只保存在操作系统凭据库；数据库只保存公钥、指纹和设备名称。
                  </CardDescription>
                </div>
                <Badge tone={deviceStateTone(device)}>{deviceStateLabel(device)}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="sync-security-stack">
                <FormField
                  label="设备名称"
                  hint="便于以后识别授权设备；不会作为密钥或恢复凭据。"
                  required
                >
                  {(fieldProps) => (
                    <Input
                      {...fieldProps}
                      value={deviceName}
                      minLength={1}
                      maxLength={80}
                      disabled={!nativeSecurityAvailable || busy !== null}
                      onChange={(event) => setDeviceName(event.currentTarget.value)}
                    />
                  )}
                </FormField>
                {device !== null && (
                  <dl className="sync-security-facts">
                    <div>
                      <dt>公钥指纹</dt>
                      <dd>
                        <code>{shortFingerprint(device.publicKeyFingerprint)}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>私钥位置</dt>
                      <dd>操作系统凭据库</dd>
                    </div>
                  </dl>
                )}
                <div className="settings-actions">
                  <Button
                    loading={busy === "device"}
                    disabled={
                      !nativeSecurityAvailable ||
                      busy !== null ||
                      deviceName.trim().length === 0 ||
                      device?.state === "revoked"
                    }
                    onClick={() => void saveDeviceIdentity()}
                  >
                    {device === null ? "创建设备身份" : "验证并保存设备名称"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="settings-card--wide">
            <CardHeader>
              <div className="card-heading-row">
                <div>
                  <CardTitle>逐项目密钥与恢复</CardTitle>
                  <CardDescription>
                    选择只决定当前查看和配置的项目，不会自动选择全部项目或开启同步。
                  </CardDescription>
                </div>
                <Badge tone={projectKeyStateTone(bundle)}>{projectKeyStateLabel(bundle)}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="sync-security-stack">
                <FormField label="项目" required>
                  {(fieldProps) => (
                    <Select
                      {...fieldProps}
                      value={selectedProjectId}
                      options={projects.map((project) => ({
                        value: project.id,
                        label: `${project.name} · ${
                          project.status === "archived" ? "已归档" : "进行中"
                        }`,
                      }))}
                      disabled={busy !== null}
                      onChange={(event) => void selectProject(event.currentTarget.value)}
                    />
                  )}
                </FormField>

                {selectedProject !== null && bundle === null && (
                  <>
                    <InlineAlert
                      tone="info"
                      title="这个项目尚未建立密钥"
                      description="下一步会生成独立的 256 位项目密钥、当前设备加密授权和一次性恢复码。恢复码确认前，密钥保持待确认状态。"
                    />
                    <div className="settings-actions">
                      <Button
                        loading={busy === "prepare"}
                        disabled={
                          !nativeSecurityAvailable || busy !== null || device?.state !== "trusted"
                        }
                        onClick={() => void prepareProjectKey()}
                      >
                        生成项目密钥与恢复码
                      </Button>
                    </div>
                  </>
                )}

                {bundle?.version.state === "pending_confirmation" && (
                  <section className="sync-security-confirmation">
                    <InlineAlert
                      tone="warning"
                      title="恢复码尚未确认"
                      description="只有输入你已保存的恢复码并明确确认后，项目密钥才会激活。若一次性显示窗口已关闭且没有保存，请重置此草案后重新生成。"
                    />
                    <RecoveryConfirmationFields
                      code={confirmationCode}
                      saved={recoverySaved}
                      disabled={busy !== null}
                      onCodeChange={setConfirmationCode}
                      onSavedChange={setRecoverySaved}
                    />
                    <div className="settings-actions">
                      <Button
                        loading={busy === "confirm"}
                        disabled={
                          busy !== null || !recoverySaved || confirmationCode.trim().length === 0
                        }
                        onClick={() => void confirmRecovery()}
                      >
                        验证并激活项目密钥
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy !== null}
                        onClick={() => setResetOpen(true)}
                      >
                        重置未确认草案
                      </Button>
                    </div>
                  </section>
                )}

                {bundle !== null && bundle.version.state !== "pending_confirmation" && (
                  <>
                    <InlineAlert
                      tone="info"
                      title="项目密钥已在本机激活"
                      description="当前设备可以解包项目密钥；恢复码完整值已从界面清除，不能再次查看。云同步是否开启以下方项目授权状态为准。"
                    />
                    <dl className="sync-security-facts">
                      <div>
                        <dt>密钥版本</dt>
                        <dd>{String(bundle.version.keyVersion)}</dd>
                      </div>
                      <div>
                        <dt>恢复确认</dt>
                        <dd>
                          {bundle.recoveryEnvelope.confirmedAt === null
                            ? "未确认"
                            : formatDate(bundle.recoveryEnvelope.confirmedAt)}
                        </dd>
                      </div>
                    </dl>
                  </>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="settings-card--wide">
            <CardHeader>
              <div className="card-heading-row">
                <div>
                  <CardTitle>项目云同步授权</CardTitle>
                  <CardDescription>
                    授权仅应用于当前所选项目；选择项目、查看状态或准备密钥都不会自动开启同步。
                  </CardDescription>
                </div>
                <Badge
                  tone={registrationLoadFailed ? "danger" : projectSyncStateTone(registration)}
                >
                  {registrationLoading
                    ? "正在读取"
                    : registrationLoadFailed
                      ? "状态未知"
                      : projectSyncStateLabel(registration, cloudEnrollmentAvailable)}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="sync-security-stack">
                {!cloudEnrollmentAvailable && (
                  <InlineAlert
                    tone="warning"
                    title="当前环境不可用"
                    description="请在启用了云同步功能的完整桌面应用中登录并授权设备。本页不会在浏览器或功能关闭时调用云服务。"
                  />
                )}

                {cloudEnrollmentAvailable &&
                  registration === null &&
                  !registrationLoading &&
                  !registrationLoadFailed && (
                    <InlineAlert
                      tone="info"
                      title="此项目尚未授权云同步"
                      description="正文、附件和版本尚未获准同步。若此前的启用流程中断，云端可能已保存不含正文的加密密钥封装；再次确认会安全续接。启用仍需要已激活的项目密钥、已确认的恢复码，以及一次明确授权。"
                    />
                  )}

                {cloudEnrollmentAvailable && registrationLoadFailed && (
                  <InlineAlert
                    tone="error"
                    title="无法确认此项目的云同步授权状态"
                    description="本地授权记录读取失败。为避免误报为“完全本地”或重复授权，云同步操作已保持锁定；请重试读取。"
                    action={{
                      label: "重试读取",
                      onClick: () => {
                        setError(null);
                        void readRegistration(selectedProjectId).catch(setError);
                      },
                    }}
                  />
                )}

                {cloudEnrollmentAvailable && registration !== null && (
                  <ProjectSyncRegistrationAlert registration={registration} />
                )}

                {enrollmentNotice !== null && (
                  <InlineAlert
                    tone={enrollmentNotice.tone}
                    title={enrollmentNotice.title}
                    description={enrollmentNotice.description}
                  />
                )}

                {registration !== null && (
                  <dl className="sync-security-facts">
                    <div>
                      <dt>授权版本</dt>
                      <dd>{String(registration.consentRevision)}</dd>
                    </div>
                    <div>
                      <dt>项目密钥版本</dt>
                      <dd>{String(registration.keyVersion)}</dd>
                    </div>
                    <div>
                      <dt>最近更新</dt>
                      <dd>{formatDate(registration.updatedAt)}</dd>
                    </div>
                  </dl>
                )}

                {cloudEnrollmentAvailable && !activeConfirmedProjectKey && (
                  <InlineAlert
                    tone="warning"
                    title="先完成项目密钥与恢复确认"
                    description="只有当前项目密钥处于激活状态且恢复码已经确认，才可以打开云同步授权确认。"
                  />
                )}

                <div className="settings-actions">
                  {registrationCanEnable && (
                    <Button
                      loading={busy === "enable"}
                      disabled={
                        !cloudEnrollmentAvailable ||
                        !activeConfirmedProjectKey ||
                        registrationLoading ||
                        busy !== null
                      }
                      onClick={() => {
                        setSyncConsent(false);
                        setEnableOpen(true);
                      }}
                    >
                      {registration?.state === "enabling" ||
                      registration?.state === "bootstrap_required"
                        ? "继续完成云同步"
                        : registration?.state === "paused" || registration?.state === "error"
                          ? "重试启用云同步"
                          : "启用云同步"}
                    </Button>
                  )}
                  {registrationCanDisable && (
                    <Button
                      variant="secondary"
                      loading={busy === "disable"}
                      disabled={!cloudEnrollmentAvailable || registrationLoading || busy !== null}
                      onClick={() => setDisableOpen(true)}
                    >
                      关闭云同步
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="settings-card--wide">
            <CardHeader>
              <CardTitle>同步范围与后果</CardTitle>
              <CardDescription>
                正式开启前必须同时满足登录、设备授权、项目授权、恢复确认和可用网络。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="privacy-list">
                <li>项目正文和附件在离开设备前按项目密钥加密；中继服务只接收密文与必要元数据。</li>
                <li>账号密码找回不能代替项目恢复码；两条恢复流程严格分离。</li>
                <li>丢失全部已授权设备和恢复码后，任何人（包括墨影运营）都无法恢复项目明文。</li>
                <li>关闭同步只停止新同步；删除云端密文会是独立、明确、可审计的操作。</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </PageStateBoundary>

      <Dialog
        open={enableOpen}
        onOpenChange={(open) => {
          if (!open && busy !== "enable") {
            setEnableOpen(false);
            setSyncConsent(false);
          }
        }}
        title="为此项目启用云同步？"
        description="墨影会先在本机加密正文和附件，再把密文与必要元数据发送到云端中继。此授权只适用于当前项目。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy === "enable"}
              onClick={() => {
                setEnableOpen(false);
                setSyncConsent(false);
              }}
            >
              保持关闭
            </Button>
            <Button
              loading={busy === "enable"}
              disabled={!syncConsent || busy !== null}
              onClick={() => void enableProjectSync()}
            >
              确认启用云同步
            </Button>
          </>
        }
      >
        <div className="sync-security-stack">
          <InlineAlert
            tone="warning"
            title="恢复码是唯一的离线恢复凭据"
            description="账号密码重置不能解密项目。若全部授权设备和恢复码都丢失，包括墨影运营在内的任何人都无法恢复明文。"
          />
          <label className="sync-recovery-acknowledgement">
            <input
              type="checkbox"
              checked={syncConsent}
              disabled={busy !== null}
              onChange={(event) => setSyncConsent(event.currentTarget.checked)}
            />
            <span>
              我明确同意为当前项目启用端到端加密云同步，并理解云端只保存密文、恢复责任由我承担。
            </span>
          </label>
        </div>
      </Dialog>

      <Dialog
        open={disableOpen}
        onOpenChange={(open) => {
          if (!open && busy !== "disable") {
            setDisableOpen(false);
          }
        }}
        title="关闭此项目的云同步？"
        description="关闭后，此设备将停止为当前项目发起新的上传和下载。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy === "disable"}
              onClick={() => setDisableOpen(false)}
            >
              保持开启
            </Button>
            <Button
              variant="danger"
              loading={busy === "disable"}
              onClick={() => void disableProjectSync()}
            >
              确认关闭云同步
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="warning"
          title="云端密文不会被删除"
          description="这是独立的停用操作，只停止新的同步。删除云端密文需要另一个明确、可审计的流程。"
        />
      </Dialog>

      <Dialog
        open={recoveryDisplay !== null}
        onOpenChange={(open) => {
          if (!open && busy !== "confirm") {
            closeRecoveryDisplay();
          }
        }}
        title="保存一次性项目恢复码"
        description="此完整值只显示这一次。墨影不会把它写入数据库、日志、通知、诊断包或云端。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy === "confirm"}
              onClick={closeRecoveryDisplay}
            >
              稍后用已保存的码确认
            </Button>
            <Button
              loading={busy === "confirm"}
              disabled={!recoverySaved || confirmationCode.trim().length === 0 || busy !== null}
              onClick={() => void confirmRecovery()}
            >
              验证并激活
            </Button>
          </>
        }
      >
        {recoveryDisplay !== null && (
          <div className="sync-recovery-dialog">
            <InlineAlert
              tone="warning"
              title="丢失后无法由账号密码找回"
              description="请保存到受保护的密码管理器或离线介质。若关闭窗口前没有保存，只能重置尚未确认的密钥草案并重新生成。"
            />
            <div className="sync-recovery-code" data-sensitive="recovery-code">
              <span>项目恢复码</span>
              <code>{recoveryDisplay.recoveryCode}</code>
            </div>
            <div className="settings-actions">
              <Button
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void copyRecoveryCode()}
              >
                {copied ? "已复制" : "复制恢复码"}
              </Button>
            </div>
            <RecoveryConfirmationFields
              code={confirmationCode}
              saved={recoverySaved}
              disabled={busy !== null}
              onCodeChange={setConfirmationCode}
              onSavedChange={setRecoverySaved}
            />
          </div>
        )}
      </Dialog>

      <Dialog
        open={resetOpen}
        onOpenChange={(open) => {
          if (!open && busy !== "reset") {
            setResetOpen(false);
          }
        }}
        title="重置未确认的密钥草案？"
        description="这只会删除尚未激活的本地密钥授权记录和恢复校验材料；项目正文不受影响，也不会删除任何云端数据。"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy === "reset"}
              onClick={() => setResetOpen(false)}
            >
              保留草案
            </Button>
            <Button
              variant="danger"
              loading={busy === "reset"}
              onClick={() => void abandonPendingSetup()}
            >
              重置并允许重新生成
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="warning"
          title="原恢复码将立即失效"
          description="只有待确认草案可以重置；已激活的项目密钥不会经过这个流程。"
        />
      </Dialog>
    </div>
  );
}

function ProjectSyncRegistrationAlert({
  registration,
}: {
  readonly registration: ProjectSyncRegistration;
}) {
  const content: Record<
    ProjectSyncRegistration["state"],
    Readonly<{
      tone: "error" | "info" | "warning";
      title: string;
      description: string;
    }>
  > = {
    enabled: {
      tone: "info",
      title: "此项目的云同步已启用",
      description: "本机已完成明文投影与安全启动，后续同步只向云端发送密文和必要元数据。",
    },
    enabling: {
      tone: "info",
      title: "正在建立项目同步授权",
      description: "授权已持久保存，但首次安全启动尚未完成。可以稍后重试，不会提前宣称同步已启用。",
    },
    bootstrap_required: {
      tone: "warning",
      title: "等待首次安全同步",
      description: "项目授权与密钥已就绪，但完整的本地明文投影仍需完成后才能上传。",
    },
    paused: {
      tone: "warning",
      title: "此项目的云同步已暂停",
      description: "不会继续推送新内容。处理登录、网络或授权问题后，可通过明确操作重试启用。",
    },
    error: {
      tone: "error",
      title: "此项目的云同步需要处理",
      description: `安全启动没有完成${
        registration.lastErrorCode === null ? "" : `（${registration.lastErrorCode}）`
      }。项目不会被当作已启用，可检查状态后重试。`,
    },
    disabled: {
      tone: "info",
      title: "此项目的云同步已关闭",
      description: "不会发起新的同步；先前已上传的云端密文没有因关闭操作而删除。",
    },
  };
  const current = content[registration.state];
  return (
    <InlineAlert tone={current.tone} title={current.title} description={current.description} />
  );
}

type CloudAccountMutationTarget =
  | Readonly<{
      kind: "device";
      id: string;
      label: string;
      current: boolean;
    }>
  | Readonly<{
      kind: "session";
      id: string;
      label: string;
      current: boolean;
    }>;

function CloudAccountSecurityCard({
  service,
}: {
  readonly service: CloudAccountManagementService;
}) {
  const [snapshot, setSnapshot] = useState<CloudAccountManagementSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [target, setTarget] = useState<CloudAccountMutationTarget | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await service.load());
      setSignedOut(false);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function confirmRevocation(): Promise<void> {
    if (target === null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated =
        target.kind === "device"
          ? await service.revokeDevice(target.id)
          : await service.revokeSession(target.id);
      setSnapshot(updated);
      setSignedOut(updated === null);
      setTarget(null);
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  const normalizedError = error === null ? null : normalizeUiError(error);
  const trustedDevices = snapshot?.devices.filter(({ device }) => device.state === "trusted") ?? [];
  const activeSessions = snapshot?.sessions.filter((session) => session.revokedAt === null) ?? [];

  return (
    <>
      <Card className="settings-card--wide sync-account-card">
        <CardHeader>
          <div className="card-heading-row">
            <div>
              <CardTitle>云账户设备与会话</CardTitle>
              <CardDescription>
                只缓存公开设备、公钥和会话时间元数据；访问与刷新凭据始终留在原生凭据库。
              </CardDescription>
            </div>
            <Badge tone={signedOut ? "neutral" : "success"}>
              {signedOut ? "本机已退出" : "原生会话"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="sync-security-stack">
            {loading && (
              <InlineAlert
                tone="info"
                title="正在核对云账户"
                description="设备和会话会按有界分页读取，并与本机公开元数据核对。"
              />
            )}
            {signedOut && (
              <InlineAlert
                tone="warning"
                title="本机云会话已清除"
                description="本地项目、导出和编辑不受影响；再次使用云能力需要重新登录并确认设备授权。"
              />
            )}
            {normalizedError !== null && (
              <InlineAlert
                tone="error"
                title={normalizedError.title}
                description={`${normalizedError.description}（${normalizedError.code}）`}
              />
            )}
            {snapshot !== null && !loading && (
              <div className="sync-account-columns">
                <section>
                  <div className="sync-account-section-heading">
                    <div>
                      <h3>可信设备</h3>
                      <p>{String(trustedDevices.length)} 台仍有云项目密钥授权</p>
                    </div>
                    <Button variant="secondary" disabled={busy} onClick={() => void load()}>
                      刷新
                    </Button>
                  </div>
                  <ul className="sync-account-list">
                    {trustedDevices.map((device) => {
                      const current = device.device.deviceId === snapshot.currentDeviceId;
                      return (
                        <li key={device.device.deviceId}>
                          <div>
                            <strong>{device.displayName}</strong>
                            <span>
                              {current ? "本机 · " : ""}
                              指纹 {shortFingerprint(device.publicKey.publicKeyFingerprint)}
                            </span>
                          </div>
                          <Button
                            variant="danger"
                            disabled={busy}
                            onClick={() =>
                              setTarget({
                                kind: "device",
                                id: device.device.deviceId,
                                label: device.displayName,
                                current,
                              })
                            }
                          >
                            {current ? "撤销本机" : "撤销设备"}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </section>

                <section>
                  <div className="sync-account-section-heading">
                    <div>
                      <h3>活动会话</h3>
                      <p>{String(activeSessions.length)} 个尚未撤销的登录会话</p>
                    </div>
                  </div>
                  <ul className="sync-account-list">
                    {activeSessions.map((session) => {
                      const current = session.sessionId === snapshot.currentSessionId;
                      const deviceName =
                        snapshot.devices.find(({ device }) => device.deviceId === session.deviceId)
                          ?.displayName ?? "未知设备";
                      return (
                        <li key={session.sessionId}>
                          <div>
                            <strong>
                              {deviceName}
                              {current ? " · 当前" : ""}
                            </strong>
                            <span>
                              签发 {formatDate(session.issuedAt)} · 到期{" "}
                              {formatDate(session.expiresAt)}
                            </span>
                          </div>
                          <Button
                            variant="danger"
                            disabled={busy}
                            onClick={() =>
                              setTarget({
                                kind: "session",
                                id: session.sessionId,
                                label: deviceName,
                                current,
                              })
                            }
                          >
                            {current ? "结束当前会话" : "结束会话"}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setTarget(null);
          }
        }}
        title={target?.kind === "device" ? "撤销这台设备？" : "结束这个云会话？"}
        description={
          target?.kind === "device"
            ? "该设备的活动会话和项目密钥授权会同时失效；重新授权前不能继续同步。"
            : "该会话会立即失效，但不会删除本地项目或云端密文。"
        }
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setTarget(null)}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void confirmRevocation()}>
              {target?.kind === "device" ? "确认撤销设备" : "确认结束会话"}
            </Button>
          </>
        }
      >
        {target !== null && (
          <InlineAlert
            tone="warning"
            title={target.current ? "这会退出当前设备" : target.label}
            description={
              target.current
                ? "操作成功后，原生会话凭据会从本机清除；本地创作和导出仍可继续。"
                : "撤销是单调状态，不能把同一设备或会话标识恢复为可信。"
            }
          />
        )}
      </Dialog>
    </>
  );
}

interface RecoveryConfirmationFieldsProps {
  readonly code: string;
  readonly saved: boolean;
  readonly disabled: boolean;
  readonly onCodeChange: (value: string) => void;
  readonly onSavedChange: (value: boolean) => void;
}

function RecoveryConfirmationFields({
  code,
  disabled,
  onCodeChange,
  onSavedChange,
  saved,
}: RecoveryConfirmationFieldsProps) {
  return (
    <div className="sync-recovery-confirmation-fields">
      <FormField
        label="再次输入已保存的恢复码"
        hint="输入只用于本机原生校验；成功或关闭窗口后会立即从界面状态清除。"
        required
      >
        {(fieldProps) => (
          <Input
            {...fieldProps}
            type="password"
            value={code}
            maxLength={256}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => onCodeChange(event.currentTarget.value)}
          />
        )}
      </FormField>
      <label className="sync-recovery-acknowledgement">
        <input
          type="checkbox"
          checked={saved}
          disabled={disabled}
          onChange={(event) => onSavedChange(event.currentTarget.checked)}
        />
        <span>我已将恢复码保存到安全位置，并理解丢失全部设备和恢复码的后果。</span>
      </label>
    </div>
  );
}

function deviceStateTone(device: DevicePublicKeyRecord | null): "neutral" | "success" | "danger" {
  if (device === null) {
    return "neutral";
  }
  return device.state === "trusted" ? "success" : "danger";
}

function deviceStateLabel(device: DevicePublicKeyRecord | null): string {
  if (device === null) {
    return "尚未创建";
  }
  if (device.state === "credential_missing") {
    return "私钥缺失";
  }
  return device.state === "revoked" ? "已撤销" : "设备可信";
}

function projectKeyStateTone(bundle: ProjectKeyBundle | null): "neutral" | "success" | "warning" {
  if (bundle === null) {
    return "neutral";
  }
  return bundle.version.state === "active" ? "success" : "warning";
}

function projectKeyStateLabel(bundle: ProjectKeyBundle | null): string {
  if (bundle === null) {
    return "未建立";
  }
  const labels: Record<ProjectKeyBundle["version"]["state"], string> = {
    pending_confirmation: "等待恢复确认",
    active: "本机密钥已激活",
    retiring: "正在轮换",
    retired: "已停用",
  };
  return labels[bundle.version.state];
}

function projectSyncStateTone(
  registration: ProjectSyncRegistration | null,
): "danger" | "neutral" | "success" | "warning" {
  if (registration === null || registration.state === "disabled") {
    return "neutral";
  }
  if (registration.state === "enabled") {
    return "success";
  }
  if (registration.state === "error") {
    return "danger";
  }
  return "warning";
}

function projectSyncStateLabel(
  registration: ProjectSyncRegistration | null,
  available: boolean,
): string {
  if (!available) {
    return "不可用";
  }
  if (registration === null) {
    return "未授权";
  }
  const labels: Record<ProjectSyncRegistration["state"], string> = {
    enabled: "已启用",
    enabling: "正在启用",
    bootstrap_required: "等待首次同步",
    paused: "已暂停",
    error: "需要处理",
    disabled: "已关闭",
  };
  return labels[registration.state];
}

function shortFingerprint(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
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
