import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  InlineAlert,
} from "@inkshadow/ui";

import type {
  SecureUpdateConfiguration,
  SecureUpdaterPort,
  SignedUpdateCheck,
  StagedUpdateReceipt,
} from "../infrastructure/secure-updater";
import { projectOrdinaryUiError } from "../infrastructure/ui-error";

export interface SecureUpdateCardProps {
  readonly updater: SecureUpdaterPort | undefined;
  readonly online: boolean;
}

export function SecureUpdateCard({ updater, online }: SecureUpdateCardProps) {
  const [configuration, setConfiguration] = useState<SecureUpdateConfiguration | null>(null);
  const [plan, setPlan] = useState<SignedUpdateCheck | null>(null);
  const [receipt, setReceipt] = useState<StagedUpdateReceipt | null>(null);
  const [busy, setBusy] = useState<"loading" | "checking" | "staging" | null>("loading");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (updater === undefined) {
        if (active) {
          setConfiguration({
            enabled: false,
            currentVersion: "unknown",
            channel: "stable",
            disabledReason: "UPDATE_RUNTIME_UNAVAILABLE",
            executesInstaller: false,
          });
          setBusy(null);
        }
        return;
      }
      try {
        const inspected = await updater.inspectConfiguration();
        if (active) {
          setConfiguration(inspected);
          setError(null);
        }
      } catch (reason: unknown) {
        if (active) {
          setError(reason);
        }
      } finally {
        if (active) {
          setBusy(null);
        }
      }
    });
    return () => {
      active = false;
    };
  }, [updater]);

  const check = async (): Promise<void> => {
    if (updater === undefined) {
      return;
    }
    setBusy("checking");
    setError(null);
    setPlan(null);
    setReceipt(null);
    try {
      setPlan(await updater.check());
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  };

  const stage = async (): Promise<void> => {
    const planId = plan?.planId ?? null;
    if (updater === undefined || planId === null) {
      return;
    }
    setBusy("staging");
    setError(null);
    try {
      setReceipt(await updater.stage(planId));
    } catch (reason: unknown) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  };

  const normalizedError = error === null ? null : projectOrdinaryUiError(error);
  const enabled = configuration?.enabled === true;
  const currentVersionLabel =
    configuration === null || configuration.currentVersion === "unknown"
      ? "无法确认"
      : configuration.currentVersion;

  return (
    <Card id="secure-updates" className="settings-card--wide">
      <CardHeader>
        <div className="card-heading-row">
          <div>
            <CardTitle headingLevel={2}>安全更新</CardTitle>
            <CardDescription>
              仅接受内置公钥签名、未过期且同源的更新清单；下载后再次核对大小与 SHA-256。
            </CardDescription>
          </div>
          <Badge tone={enabled ? "info" : "neutral"}>
            {busy === "loading" ? "正在检查配置" : enabled ? "签名通道已固定" : "发行通道未启用"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="maintenance-settings" aria-live="polite">
          {normalizedError !== null && (
            <InlineAlert
              tone="error"
              title={normalizedError.title}
              description={normalizedError.description}
            />
          )}

          {configuration !== null && !configuration.enabled && (
            <InlineAlert
              tone="warning"
              title="此构建未启用在线更新"
              description={`当前版本 ${currentVersionLabel}，仍可离线使用。只有发行流水线固定清单地址和签名公钥后才会开放检查；不会从运行时输入接受更新源。`}
            />
          )}

          {configuration?.enabled === true && (
            <>
              <ul className="privacy-list">
                <li>
                  当前版本 {currentVersionLabel}，{channelLabel(configuration.channel)}。
                </li>
                <li>更新请求不携带账户、项目、正文、提示词、密钥或设备标识。</li>
                <li>重定向、跨源下载、私网目标、超限响应和摘要不一致均会失败关闭。</li>
                <li>
                  当前版本只能下载并验证更新包，不能自动安装；页面不会显示无法执行的安装按钮。
                </li>
              </ul>
              {!online && (
                <InlineAlert
                  tone="warning"
                  title="离线时不能检查更新"
                  description="本地写作、读取、备份和导出不受影响；联网后可重新检查签名清单。"
                />
              )}
              <div className="settings-actions">
                <Button
                  variant="secondary"
                  loading={busy === "checking"}
                  disabled={!online || busy !== null}
                  onClick={() => void check()}
                >
                  检查签名更新
                </Button>
              </div>
            </>
          )}

          {plan !== null && <UpdatePlanSummary plan={plan} />}

          {plan !== null &&
            plan.planId !== null &&
            plan.state === "update_available" &&
            receipt === null && (
              <div className="settings-actions">
                <Button
                  loading={busy === "staging"}
                  disabled={busy !== null || !online}
                  onClick={() => void stage()}
                >
                  下载并校验更新包（不安装）
                </Button>
              </div>
            )}

          {receipt !== null && (
            <InlineAlert
              tone="info"
              title="更新包已完成摘要校验并隔离暂存"
              description={`版本 ${receipt.releaseVersion}，${formatBytes(receipt.artifactSizeBytes)}。当前版本不具备安装能力，已验证的下载包不会被自动执行；请按照官方发行说明完成后续安装。`}
            />
          )}
          {plan !== null && <ReleaseNotesLink url={plan.releaseNotesUrl} />}
        </div>
      </CardContent>
    </Card>
  );
}

function ReleaseNotesLink({ url }: Readonly<{ url: string | null }>) {
  if (url === null || !isSafeReleaseUrl(url)) {
    return (
      <p role="note">
        此发行清单没有提供可验证的官方说明链接；墨影不会猜测下载地址或引导安装未核验的软件包。
      </p>
    );
  }
  return (
    <p>
      <a href={url} target="_blank" rel="noreferrer">
        查看官方发行说明
      </a>
    </p>
  );
}

function isSafeReleaseUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function channelLabel(channel: SecureUpdateConfiguration["channel"]): string {
  return channel === "stable" ? "稳定通道" : channel === "beta" ? "测试通道" : "无效通道";
}

function UpdatePlanSummary({ plan }: Readonly<{ plan: SignedUpdateCheck }>) {
  switch (plan.state) {
    case "up_to_date":
      return (
        <InlineAlert
          tone="info"
          title="当前已是签名清单中的版本"
          description={`当前版本与 ${plan.releaseVersion} 一致。`}
        />
      );
    case "manual_update_required":
      return (
        <InlineAlert
          tone="warning"
          title="需要人工更新"
          description={`当前版本低于安全更新器兼容下限，应用不会下载或运行 ${plan.releaseVersion}。请仅按照下方已验证的官方发行说明手动更新。`}
        />
      );
    case "rollback_available":
      return (
        <InlineAlert
          tone="warning"
          title="当前版本不能自动回退"
          description={`目标 ${plan.releaseVersion} 已通过清单验证，但当前版本没有安全的系统确认流程，因此不会下载或执行回退包。`}
        />
      );
    case "update_available":
      return (
        <InlineAlert
          tone={plan.mandatory ? "warning" : "info"}
          title={plan.mandatory ? "发现安全下限更新" : "发现签名更新"}
          description={`目标 ${plan.releaseVersion}，下载 ${formatBytes(plan.artifactSizeBytes)}。暂存不会关闭应用或执行安装。`}
        />
      );
  }
}

function formatBytes(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    return "大小未知";
  }
  if (value < 1024) {
    return `${String(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
