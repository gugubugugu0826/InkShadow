import { Component, type ReactNode } from "react";
import { ErrorState } from "@inkshadow/ui";

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
}

interface AppErrorBoundaryState {
  readonly error: Error | null;
  readonly incidentId: string | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  public override state: AppErrorBoundaryState = { error: null, incidentId: null };

  public static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      error,
      incidentId: `UI-${Date.now().toString(36).toUpperCase()}`,
    };
  }

  public override componentDidCatch(): void {
    // The error UI intentionally does not persist raw exception text because a
    // provider or filesystem error can contain local paths or remote details.
  }

  public override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }

    return (
      <main className="app-error-boundary">
        <ErrorState
          headingLevel={1}
          title="这个页面暂时没有正常打开"
          description="可以重试当前页面，或先返回创作首页。已保存的正文、版本和本地备份不会因为这个界面错误被删除。"
          errorCode="UI_RENDER_FAILED"
          requestId={this.state.incidentId ?? "UI-UNKNOWN"}
          savedState="本地数据保持原样；未保存输入仍以恢复草稿策略为准。"
          primaryAction={{
            label: "重试当前页面",
            onClick: () => this.setState({ error: null, incidentId: null }),
          }}
          secondaryAction={{
            label: "返回创作首页",
            onClick: () => {
              window.location.hash = "/start";
              this.setState({ error: null, incidentId: null });
            },
          }}
        />
      </main>
    );
  }
}
