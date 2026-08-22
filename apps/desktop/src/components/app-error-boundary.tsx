import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "@inkshadow/ui";

import {
  recordUiRouteIncident,
  recoverUiRouteIncident,
} from "../infrastructure/ui-route-diagnostics";

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
  readonly diagnosticOwner?: object;
  readonly now?: () => string;
  readonly route?: () => string;
}

interface AppErrorBoundaryState {
  readonly failed: boolean;
  readonly diagnosticId: string | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public override state: AppErrorBoundaryState = { failed: false, diagnosticId: null };

  public static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true, diagnosticId: null };
  }

  public override componentDidCatch(cause: Error, errorInfo: ErrorInfo): void {
    const incident = recordUiRouteIncident(this.diagnosticOwner(), {
      route: this.props.route?.() ?? currentRoute(),
      phase: isLazyLoadFailure(cause) ? "lazy_load" : "render",
      cause,
      timestamp: this.timestamp(),
      componentName: "AppErrorBoundary",
      componentStack: errorInfo.componentStack ?? null,
    });
    this.setState({ failed: true, diagnosticId: incident.diagnosticId });
  }

  public override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }

    return (
      <main className="app-error-boundary">
        <ErrorState
          headingLevel={1}
          title="这个页面暂时没有正常打开"
          description={`可以重试当前页面，或先返回创作首页。支持编号：${this.state.diagnosticId ?? "正在生成"}。已保存的正文、版本和本地备份不会因为这个界面错误被删除。`}
          savedState="本地数据保持原样；未保存输入仍以恢复草稿策略为准。"
          primaryAction={{
            label: "重试当前页面",
            onClick: () => this.recover("retry"),
          }}
          secondaryAction={{
            label: "返回创作首页",
            onClick: () => {
              this.markRecovered("navigate_start");
              window.location.hash = "/start";
              this.setState({ failed: false, diagnosticId: null });
            },
          }}
        />
      </main>
    );
  }

  private recover(recoveryAction: "retry"): void {
    this.markRecovered(recoveryAction);
    this.setState({ failed: false, diagnosticId: null });
  }

  private markRecovered(recoveryAction: "retry" | "navigate_start"): void {
    if (this.state.diagnosticId === null) return;
    recoverUiRouteIncident(
      this.diagnosticOwner(),
      this.state.diagnosticId,
      this.timestamp(),
      recoveryAction,
    );
  }

  private diagnosticOwner(): object {
    return this.props.diagnosticOwner ?? window;
  }

  private timestamp(): string {
    return this.props.now?.() ?? new Date().toISOString();
  }
}

function currentRoute(): string {
  return window.location.href;
}

function isLazyLoadFailure(cause: Error): boolean {
  return "code" in cause && cause.code === "UI_LAZY_LOAD_FAILED";
}
