import { useEffect, useRef, useState, type Ref } from "react";

import type { CloudDeletionJournal } from "@inkshadow/data";
import type { Project } from "@inkshadow/domain";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  FormField,
  InlineAlert,
  Input,
} from "@inkshadow/ui";

import {
  type CloudDeletionLifecycleService,
  matchesAccountDeletionConfirmation,
  matchesProjectDeletionConfirmation,
} from "../infrastructure/cloud-deletion-lifecycle-service";

type DeletionDialog =
  | "account_cancel"
  | "account_lookup"
  | "account_request"
  | "project_cancel"
  | "project_request"
  | null;

export function CloudDeletionSecurityCard({
  selectedProject,
  service,
}: {
  readonly selectedProject: Project | null;
  readonly service: CloudDeletionLifecycleService;
}) {
  const [projectJournal, setProjectJournal] = useState<CloudDeletionJournal | null>(null);
  const [accountJournal, setAccountJournal] = useState<CloudDeletionJournal | null>(null);
  const [dialog, setDialog] = useState<DeletionDialog>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectConfirmation, setProjectConfirmation] = useState("");
  const [projectPassword, setProjectPassword] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountConfirmation, setAccountConfirmation] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const projectConfirmationRef = useRef<HTMLInputElement>(null);
  const accountEmailRef = useRef<HTMLInputElement>(null);
  const accountPasswordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void Promise.resolve()
      .then(() => {
        if (!current) {
          return null;
        }
        setLoading(true);
        setErrorCode(null);
        return Promise.all([
          selectedProject === null
            ? Promise.resolve(null)
            : service.findProject(selectedProject.id),
          service.listRecoverable(),
        ]);
      })
      .then((result) => {
        if (result === null) {
          return;
        }
        const [project, recoverable] = result;
        if (!current) {
          return;
        }
        setProjectJournal(project);
        const account =
          recoverable.filter(({ targetKind }) => targetKind === "account").at(-1) ?? null;
        setAccountJournal(account);
        if (account?.accountEmail !== null && account?.accountEmail !== undefined) {
          setAccountEmail(account.accountEmail);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setErrorCode(safeErrorCode(cause));
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [selectedProject, service]);

  function closeDialog(): void {
    if (busy) {
      return;
    }
    setDialog(null);
    clearSecretsAndConfirmations();
  }

  function clearSecretsAndConfirmations(): void {
    setProjectPassword("");
    setProjectConfirmation("");
    setAccountPassword("");
    setAccountConfirmation("");
  }

  async function requestProjectDeletion(): Promise<void> {
    if (
      selectedProject === null ||
      !matchesProjectDeletionConfirmation(selectedProject.name, projectConfirmation)
    ) {
      return;
    }
    const password = projectPassword;
    setBusy(true);
    setErrorCode(null);
    setNotice(null);
    try {
      const result = await service.requestProjectDeletion({
        projectId: selectedProject.id,
        password,
        clearPassword: () => setProjectPassword(""),
      });
      setProjectJournal(result.journal);
      setDialog(null);
      setProjectConfirmation("");
      setNotice("项目云端删除已进入宽限期；本机项目、正文和导出均未删除。");
    } catch (cause: unknown) {
      setErrorCode(safeErrorCode(cause));
    } finally {
      setProjectPassword("");
      setBusy(false);
    }
  }

  async function refreshProjectDeletion(): Promise<void> {
    if (selectedProject === null) {
      return;
    }
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await service.refreshProjectDeletion(selectedProject.id);
      setProjectJournal(result.journal);
    } catch (cause: unknown) {
      setErrorCode(safeErrorCode(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancelProjectDeletion(): Promise<void> {
    if (projectJournal === null) {
      return;
    }
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await service.cancelProjectDeletion(projectJournal.journalId);
      setProjectJournal(result.journal);
      setDialog(null);
      setNotice("项目云端删除已取消；本机项目始终未受影响。");
    } catch (cause: unknown) {
      setErrorCode(safeErrorCode(cause));
    } finally {
      setBusy(false);
    }
  }

  async function requestAccountDeletion(): Promise<void> {
    if (!matchesAccountDeletionConfirmation(accountEmail, accountConfirmation)) {
      return;
    }
    const password = accountPassword;
    setBusy(true);
    setErrorCode(null);
    setNotice(null);
    try {
      const result = await service.requestAccountDeletion({
        email: accountEmail,
        password,
        clearPassword: () => setAccountPassword(""),
      });
      setAccountJournal(result.journal);
      setAccountEmail(result.journal.accountEmail ?? "");
      setDialog(null);
      setAccountConfirmation("");
      setNotice("账户删除已进入宽限期，本机云会话已清除；本地项目仍可离线打开和导出。");
    } catch (cause: unknown) {
      setErrorCode(safeErrorCode(cause));
    } finally {
      setAccountPassword("");
      setBusy(false);
    }
  }

  async function lookupAccountDeletion(): Promise<void> {
    if (accountJournal === null) {
      return;
    }
    const password = accountPassword;
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await service.lookupAccountDeletion({
        journalId: accountJournal.journalId,
        email: accountEmail,
        password,
        clearPassword: () => setAccountPassword(""),
      });
      setAccountJournal(result.journal);
      setDialog(null);
    } catch (cause: unknown) {
      setErrorCode(safeErrorCode(cause));
    } finally {
      setAccountPassword("");
      setBusy(false);
    }
  }

  async function cancelAccountDeletion(): Promise<void> {
    if (accountJournal === null) {
      return;
    }
    const password = accountPassword;
    setBusy(true);
    setErrorCode(null);
    try {
      const result = await service.cancelAccountDeletion({
        journalId: accountJournal.journalId,
        email: accountEmail,
        password,
        clearPassword: () => setAccountPassword(""),
      });
      setAccountJournal(result.journal);
      setDialog(null);
      setNotice("账户删除已取消；需要重新登录才能继续使用云能力。");
    } catch (cause: unknown) {
      setErrorCode(safeErrorCode(cause));
    } finally {
      setAccountPassword("");
      setBusy(false);
    }
  }

  const projectReceipt = projectJournal?.latestReceipt?.deletionRequest ?? null;
  const accountReceipt = accountJournal?.latestReceipt?.deletionRequest ?? null;
  const hasPendingAccountSubmission =
    accountReceipt === null &&
    accountJournal?.activeMutation?.requestType === "submission" &&
    ["prepared", "retryable_error"].includes(accountJournal.activeMutation.state);
  const projectConfirmationValid =
    selectedProject !== null &&
    matchesProjectDeletionConfirmation(selectedProject.name, projectConfirmation);
  const accountConfirmationValid = matchesAccountDeletionConfirmation(
    accountEmail,
    accountConfirmation,
  );

  return (
    <>
      <Card
        className="settings-card--wide sync-account-card"
        data-testid="cloud-deletion-security-card"
      >
        <CardHeader>
          <div className="card-heading-row">
            <div>
              <CardTitle>永久删除云端数据（L3）</CardTitle>
              <CardDescription>
                这是独立于“关闭云同步”和“删除本地项目”的高风险流程，所有提交都有持久化回执和可审计宽限期。
              </CardDescription>
            </div>
            <Badge tone="danger">不可逆边界</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="sync-security-stack">
            <InlineAlert
              tone="warning"
              title="先进入 30 日宽限期，再跨越不可逆提交点"
              description="宽限期内可以取消。服务端开始 commit 后，密文、密钥封装和访问记录会分阶段清除，不能恢复；项目云端删除不会删除本机项目。"
            />
            {loading && (
              <InlineAlert
                tone="info"
                title="正在读取删除回执"
                description="危险操作保持锁定，直到本地持久化状态读取完成。"
              />
            )}
            {errorCode !== null && (
              <InlineAlert
                tone="error"
                title="云端删除操作未完成"
                description={`未保存密码或服务器错误详情；请根据安全错误码重试。（${errorCode}）`}
              />
            )}
            {notice !== null && (
              <InlineAlert tone="info" title="删除生命周期已更新" description={notice} />
            )}

            <section className="sync-deletion-section" aria-labelledby="project-cloud-deletion">
              <div className="sync-account-section-heading">
                <div>
                  <h3 id="project-cloud-deletion">当前项目的云端副本</h3>
                  <p>
                    {selectedProject === null
                      ? "选择一个项目后可查看其云端删除状态。"
                      : `“${selectedProject.name}”的本地正文不会被此操作删除。`}
                  </p>
                </div>
                <Badge tone={deletionTone(projectReceipt?.state)}>
                  {deletionStateLabel(projectReceipt?.state)}
                </Badge>
              </div>
              {projectJournal?.latestReceipt === null && projectJournal.activeMutation !== null && (
                <InlineAlert
                  tone="warning"
                  title="发现未完成的项目删除提交"
                  description="重新输入密码后会复用原 confirmation ID、请求摘要和幂等键，不会创建第二个删除计划。"
                />
              )}
              {projectJournal !== null && projectReceipt !== null && (
                <DeletionReceiptFacts journal={projectJournal} />
              )}
              <div className="settings-actions">
                {projectReceipt === null || projectReceipt.state === "cancelled" ? (
                  <Button
                    variant="danger"
                    disabled={loading || busy || selectedProject === null}
                    onClick={() => {
                      clearSecretsAndConfirmations();
                      setDialog("project_request");
                    }}
                  >
                    {(projectJournal?.activeMutation ?? null) !== null
                      ? "继续提交已保存的项目删除请求"
                      : "永久删除此项目的云端数据"}
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busy || selectedProject === null}
                      onClick={() => void refreshProjectDeletion()}
                    >
                      查询项目删除状态
                    </Button>
                    {projectReceipt.canCancel && (
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => setDialog("project_cancel")}
                      >
                        在宽限期内取消
                      </Button>
                    )}
                  </>
                )}
              </div>
            </section>

            <section className="sync-deletion-section" aria-labelledby="account-cloud-deletion">
              <div className="sync-account-section-heading">
                <div>
                  <h3 id="account-cloud-deletion">整个云账户</h3>
                  <p>
                    影响全部个人云项目、设备和会话；团队项目不会随账户删除，但团队访问会在最终清理时撤销。本机数据库不会自动清空。
                  </p>
                </div>
                <Badge tone={deletionTone(accountReceipt?.state)}>
                  {deletionStateLabel(accountReceipt?.state)}
                </Badge>
              </div>
              {accountJournal?.latestReceipt === null && accountJournal.activeMutation !== null && (
                <InlineAlert
                  tone="warning"
                  title="发现未完成的账户删除提交"
                  description="本机已保存原 confirmation ID、请求摘要和幂等键；若云会话已失效，可直接用邮箱和密码恢复服务端回执。密码不会从本机恢复或持久化。"
                />
              )}
              {accountJournal !== null && accountReceipt !== null && (
                <DeletionReceiptFacts journal={accountJournal} />
              )}
              <div className="settings-actions">
                {accountReceipt === null || accountReceipt.state === "cancelled" ? (
                  <>
                    <Button
                      variant="danger"
                      disabled={loading || busy}
                      onClick={() => {
                        clearSecretsAndConfirmations();
                        setDialog("account_request");
                      }}
                    >
                      {(accountJournal?.activeMutation ?? null) !== null
                        ? "继续提交已保存的账户删除请求"
                        : "申请永久删除云账户"}
                    </Button>
                    {hasPendingAccountSubmission && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setAccountPassword("");
                          setDialog("account_lookup");
                        }}
                      >
                        使用邮箱和密码恢复删除回执
                      </Button>
                    )}
                  </>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        setAccountPassword("");
                        setDialog("account_lookup");
                      }}
                    >
                      使用邮箱和密码查询
                    </Button>
                    {accountReceipt.canCancel && (
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => {
                          setAccountPassword("");
                          setDialog("account_cancel");
                        }}
                      >
                        在宽限期内取消账户删除
                      </Button>
                    )}
                  </>
                )}
              </div>
            </section>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={dialog === "project_request"}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        initialFocusRef={projectConfirmationRef}
        title="永久删除此项目的云端数据？"
        description="先进入 30 日宽限期；宽限期结束且服务端开始 commit 后无法撤销。关闭云同步或删除本地项目都不会代替此操作。"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={closeDialog}>
              保留云端数据
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!projectConfirmationValid || projectPassword.length < 12 || busy}
              onClick={() => void requestProjectDeletion()}
            >
              进入 30 日删除宽限期
            </Button>
          </>
        }
      >
        <div className="sync-security-stack">
          <InlineAlert
            tone="warning"
            title="本地项目不会删除"
            description="只删除当前项目的云端密文、密钥封装和同步元数据。本机项目仍可编辑和导出。"
          />
          <FormField
            label={`精确输入项目名“${selectedProject?.name ?? ""}”`}
            hint="前后空格、大小写和标点都必须完全一致。"
            required
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                ref={projectConfirmationRef}
                value={projectConfirmation}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setProjectConfirmation(event.currentTarget.value)}
              />
            )}
          </FormField>
          <PasswordField value={projectPassword} disabled={busy} onChange={setProjectPassword} />
        </div>
      </Dialog>

      <Dialog
        open={dialog === "project_cancel"}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        title="取消项目云端删除？"
        description="只有服务端尚未开始不可逆 commit 时才会成功。"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={closeDialog}>
              保持删除计划
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={busy || projectReceipt?.canCancel !== true}
              onClick={() => void cancelProjectDeletion()}
            >
              确认取消删除
            </Button>
          </>
        }
      >
        <InlineAlert
          tone="info"
          title="取消不会重新开启云同步"
          description="取消只终止删除计划；项目云同步授权仍保持原来的独立状态。"
        />
      </Dialog>

      <Dialog
        open={dialog === "account_request"}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        initialFocusRef={accountEmailRef}
        title="永久删除整个云账户？"
        description="账户会立即退出所有云会话，并进入 30 日宽限期；本地项目不会自动删除。"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={closeDialog}>
              保留云账户
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!accountConfirmationValid || accountPassword.length < 12 || busy}
              onClick={() => void requestAccountDeletion()}
            >
              退出会话并进入删除宽限期
            </Button>
          </>
        }
      >
        <div className="sync-security-stack">
          <InlineAlert
            tone="warning"
            title="影响个人云项目、设备和会话"
            description="团队项目不会被删除；团队访问会在最终清理时撤销。若仍是团队唯一 Owner，或个人云项目仍分配给其他团队成员，必须先完成转移或解除分配。宽限期后将跨越不可逆 commit 点，请先完成需要的本地导出。"
          />
          <FormField label="云账户邮箱" required>
            {(fieldProps) => (
              <Input
                {...fieldProps}
                ref={accountEmailRef}
                type="email"
                value={accountEmail}
                autoComplete="username"
                disabled={busy}
                onChange={(event) => setAccountEmail(event.currentTarget.value)}
              />
            )}
          </FormField>
          <FormField
            label="再次精确输入规范化邮箱"
            hint="请使用全小写邮箱；它必须与上方账户邮箱规范化后的值完全一致。"
            required
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                value={accountConfirmation}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setAccountConfirmation(event.currentTarget.value)}
              />
            )}
          </FormField>
          <PasswordField value={accountPassword} disabled={busy} onChange={setAccountPassword} />
        </div>
      </Dialog>

      <Dialog
        open={dialog === "account_lookup" || dialog === "account_cancel"}
        onOpenChange={(open) => {
          if (!open) {
            closeDialog();
          }
        }}
        initialFocusRef={accountPasswordRef}
        title={dialog === "account_cancel" ? "取消账户删除？" : "查询账户删除状态"}
        description="账户提交删除后没有有效云会话；此恢复流程直接使用邮箱、密码和本机保存的删除证明（请求编号或确认号）。"
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={closeDialog}>
              返回
            </Button>
            <Button
              variant={dialog === "account_cancel" ? "danger" : "primary"}
              loading={busy}
              disabled={accountPassword.length < 12 || busy}
              onClick={() =>
                void (dialog === "account_cancel"
                  ? cancelAccountDeletion()
                  : lookupAccountDeletion())
              }
            >
              {dialog === "account_cancel" ? "确认取消账户删除" : "查询状态"}
            </Button>
          </>
        }
      >
        <div className="sync-security-stack">
          <dl className="sync-security-facts">
            <div>
              <dt>账户邮箱</dt>
              <dd>{accountJournal?.accountEmail ?? "不可用"}</dd>
            </div>
            <div>
              <dt>删除证明</dt>
              <dd>
                <code>
                  {accountJournal?.deletionRequestId ??
                    (accountJournal?.activeMutation?.confirmationId === null ||
                    accountJournal?.activeMutation?.confirmationId === undefined
                      ? "不可用"
                      : "已安全保存确认号")}
                </code>
              </dd>
            </div>
          </dl>
          <PasswordField
            inputRef={accountPasswordRef}
            value={accountPassword}
            disabled={busy}
            onChange={setAccountPassword}
          />
        </div>
      </Dialog>
    </>
  );
}

function PasswordField({
  disabled,
  inputRef,
  onChange,
  value,
}: {
  readonly disabled: boolean;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <FormField
      label="当前云账户密码"
      hint="密码只进入原生凭据请求边界；不会写入数据库、日志、回执或诊断包。"
      required
    >
      {(fieldProps) => (
        <Input
          {...fieldProps}
          ref={inputRef}
          type="password"
          value={value}
          minLength={12}
          maxLength={256}
          autoComplete="current-password"
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
    </FormField>
  );
}

function DeletionReceiptFacts({ journal }: { readonly journal: CloudDeletionJournal }) {
  const receipt = journal.latestReceipt?.deletionRequest;
  if (receipt === undefined) {
    return null;
  }
  return (
    <>
      <dl className="sync-security-facts">
        <div>
          <dt>删除状态</dt>
          <dd>{deletionStateLabel(receipt.state)}</dd>
        </div>
        <div>
          <dt>当前阶段</dt>
          <dd>{receipt.phase}</dd>
        </div>
        <div>
          <dt>宽限期截止</dt>
          <dd>{formatDate(receipt.cancellableUntil)}</dd>
        </div>
        <div>
          <dt>不可逆 commit</dt>
          <dd>
            {receipt.commitStartedAt === null ? "尚未开始" : formatDate(receipt.commitStartedAt)}
          </dd>
        </div>
        <div>
          <dt>影响项目</dt>
          <dd>{String(receipt.impactSummary.projectCount)}</dd>
        </div>
        <div>
          <dt>密文操作 / 分块</dt>
          <dd>
            {String(receipt.impactSummary.syncOperationCount)} /{" "}
            {String(receipt.impactSummary.encryptedChunkCount)}
          </dd>
        </div>
        <div>
          <dt>密钥封装</dt>
          <dd>{String(receipt.impactSummary.keyEnvelopeCount)}</dd>
        </div>
        <div>
          <dt>设备 / 会话</dt>
          <dd>
            {String(receipt.impactSummary.deviceCount)} /{" "}
            {String(receipt.impactSummary.sessionCount)}
          </dd>
        </div>
      </dl>
      {!receipt.canCancel && receipt.state !== "cancelled" && (
        <InlineAlert
          tone="warning"
          title="已跨越不可逆提交点"
          description="服务端已经开始删除或等待备份保留期结束，不能再取消。"
        />
      )}
    </>
  );
}

function deletionStateLabel(state: string | undefined): string {
  switch (state) {
    case "grace_period":
      return "宽限期";
    case "blocked":
      return "等待解除阻挡";
    case "purging":
      return "不可逆删除中";
    case "backup_retention":
      return "等待备份保留期";
    case "purged":
      return "已永久删除";
    case "cancelled":
      return "已取消";
    default:
      return "尚未申请";
  }
}

function deletionTone(state: string | undefined): "danger" | "neutral" | "success" | "warning" {
  switch (state) {
    case "grace_period":
    case "blocked":
      return "warning";
    case "purging":
    case "backup_retention":
      return "danger";
    case "purged":
    case "cancelled":
      return "success";
    default:
      return "neutral";
  }
}

function safeErrorCode(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    /^[A-Z0-9_]{3,80}$/u.test(cause.code)
  ) {
    return cause.code;
  }
  return "CLOUD_DELETION_UNEXPECTED";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
