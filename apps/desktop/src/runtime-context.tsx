import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ErrorState, PageStateBoundary } from "@inkshadow/ui";
import { isTauri } from "@tauri-apps/api/core";

import { AppearancePreferenceProvider } from "./appearance-preference";
import { saveExportArtifact } from "./infrastructure/export-artifact-download";
import type { DesktopRuntime } from "./infrastructure/runtime";
import {
  clearStartupFailure,
  collectStartupDiagnosticArtifact,
  isMigrationStartupFailure,
  recordStartupFailure,
  type StartupFailureIncident,
} from "./infrastructure/startup-diagnostics";
import { isUiErrorRetryable, projectOrdinaryUiError } from "./infrastructure/ui-error";

async function createDefaultDesktopRuntime(): Promise<DesktopRuntime> {
  const { createDesktopRuntime } = await import("./infrastructure/runtime");
  return createDesktopRuntime();
}

const RuntimeContext = createContext<DesktopRuntime | null>(null);

interface RuntimeBootstrap {
  readonly factory: () => Promise<DesktopRuntime>;
  readonly promise: Promise<DesktopRuntime>;
  consumers: number;
  runtime: DesktopRuntime | null;
  closeStarted: boolean;
}

export interface RuntimeProviderProps {
  readonly children: ReactNode;
  readonly runtime?: DesktopRuntime;
  readonly factory?: () => Promise<DesktopRuntime>;
}

export function RuntimeProvider({ children, factory, runtime }: RuntimeProviderProps) {
  return (
    <AppearancePreferenceProvider>
      <RuntimeProviderContent
        {...(factory === undefined ? {} : { factory })}
        {...(runtime === undefined ? {} : { runtime })}
      >
        {children}
      </RuntimeProviderContent>
    </AppearancePreferenceProvider>
  );
}

function RuntimeProviderContent({
  children,
  factory = createDefaultDesktopRuntime,
  runtime: providedRuntime,
}: RuntimeProviderProps) {
  const [runtime, setRuntime] = useState<DesktopRuntime | null>(providedRuntime ?? null);
  const [error, setError] = useState<unknown>(null);
  const [startupIncident, setStartupIncident] = useState<StartupFailureIncident | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [diagnosticExportStatus, setDiagnosticExportStatus] = useState<string | null>(null);
  const [diagnosticExporting, setDiagnosticExporting] = useState(false);
  const bootstrapRef = useRef<RuntimeBootstrap | null>(null);

  useEffect(() => {
    if (providedRuntime !== undefined) {
      return;
    }

    let bootstrap = bootstrapRef.current;
    if (bootstrap?.factory !== factory) {
      bootstrap = {
        factory,
        promise: Promise.resolve().then(factory),
        consumers: 0,
        runtime: null,
        closeStarted: false,
      };
      bootstrapRef.current = bootstrap;
    }
    bootstrap.consumers += 1;
    const currentBootstrap = bootstrap;
    let active = true;

    const closeIfUnused = () => {
      if (
        currentBootstrap.consumers !== 0 ||
        currentBootstrap.runtime === null ||
        currentBootstrap.closeStarted
      ) {
        return;
      }
      currentBootstrap.closeStarted = true;
      if (bootstrapRef.current === currentBootstrap) {
        bootstrapRef.current = null;
      }
      void currentBootstrap.runtime.close();
    };

    void currentBootstrap.promise
      .then((value) => {
        currentBootstrap.runtime = value;
        if (active) {
          clearStartupFailure();
          setStartupIncident(null);
          setError(null);
          setRuntime(value);
        } else if (currentBootstrap.consumers === 0) {
          closeIfUnused();
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setStartupIncident(
            isMigrationStartupFailure(reason) ? recordStartupFailure(reason) : null,
          );
          setError(reason);
        }
      });

    return () => {
      active = false;
      currentBootstrap.consumers -= 1;
      // React StrictMode intentionally tears down and recreates effects once.
      // Deferring release by one microtask lets that immediate replacement
      // reuse the same in-flight runtime instead of closing it underneath the
      // second bootstrap.
      queueMicrotask(closeIfUnused);
    };
  }, [bootstrapAttempt, factory, providedRuntime]);

  const retryMigrationRead = () => {
    bootstrapRef.current = null;
    setRuntime(null);
    setError(null);
    setStartupIncident(null);
    setDiagnosticExportStatus(null);
    setDiagnosticExporting(false);
    setBootstrapAttempt((attempt) => attempt + 1);
  };

  const exportMigrationDiagnostic = async () => {
    if (startupIncident === null || diagnosticExporting) return;
    setDiagnosticExporting(true);
    setDiagnosticExportStatus(null);
    try {
      const receipt = await saveExportArtifact(collectStartupDiagnosticArtifact(startupIncident), {
        format: "report",
        mode: isTauri() ? "tauri" : "browser-development",
      });
      setDiagnosticExportStatus(
        receipt.status === "cancelled"
          ? "未选择保存位置，诊断未写入。"
          : receipt.status === "browser_download"
            ? "浏览器已开始下载脱敏诊断。"
            : "脱敏诊断已保存并核验。",
      );
    } catch {
      setDiagnosticExportStatus("诊断未导出。请保留支持编号，检查保存权限后重试。");
    } finally {
      setDiagnosticExporting(false);
    }
  };

  const exitAfterMigrationFailure = async () => {
    if (isTauri()) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
        return;
      } catch {
        setDiagnosticExportStatus("无法自动退出，请关闭当前窗口。");
        return;
      }
    }
    window.close();
  };

  if (error !== null) {
    const normalized = projectOrdinaryUiError(error);
    if (startupIncident !== null && isMigrationStartupFailure(error)) {
      return (
        <main className="desktop-bootstrap">
          <section className="desktop-page" aria-label="本地数据恢复">
            <ErrorState title="无法启动墨影" description={normalized.description} />
            <p>支持编号：{startupIncident.supportId}</p>
            <div className="settings-actions" role="group" aria-label="启动恢复操作">
              <Button onClick={retryMigrationRead}>重新读取</Button>
              <Button
                variant="secondary"
                loading={diagnosticExporting}
                loadingLabel="正在导出"
                onClick={() => void exportMigrationDiagnostic()}
              >
                导出脱敏诊断
              </Button>

              <Button variant="ghost" onClick={() => void exitAfterMigrationFailure()}>
                安全退出
              </Button>
            </div>
            <details id="startup-migration-recovery" className="ink-error-state__details">
              <summary>查看恢复说明</summary>
              <strong>请先保留当前数据</strong>
              <p>
                不要删除数据库，也不要清空作品。请保留数据库原件并重新读取；仍无法打开时，导出脱敏诊断并连同支持编号交给支持人员。
              </p>
              <p>确认安装来源和备份完整后，才可使用匹配该数据库的已发布版本或经验证备份恢复。</p>
            </details>
            {diagnosticExportStatus !== null && <p role="status">{diagnosticExportStatus}</p>}
          </section>
        </main>
      );
    }
    const actionProps = isUiErrorRetryable(error)
      ? {
          primaryAction: {
            label: "重新加载",
            onClick: () => {
              window.location.reload();
            },
          },
        }
      : {};
    return (
      <main className="desktop-bootstrap">
        <ErrorState title="无法启动墨影" description={normalized.description} {...actionProps} />
      </main>
    );
  }

  if (runtime === null) {
    return (
      <main className="desktop-bootstrap">
        <PageStateBoundary state="loading" loadingLabel="正在打开本地工作区">
          <span />
        </PageStateBoundary>
      </main>
    );
  }

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

// This module intentionally exports the provider and its paired consumer hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useRuntime(): DesktopRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) {
    throw new Error("useRuntime must be used inside RuntimeProvider.");
  }
  return runtime;
}
