import { Component, type ReactNode } from "react";
import { ErrorState } from "@inkshadow/ui";
import { useLocation, useNavigate } from "react-router-dom";

import {
  recoverUiRouteIncident,
  recordUiRouteIncident,
  safeSettingsRoute,
} from "../infrastructure/ui-route-diagnostics";
import { useRuntime } from "../runtime-context";

interface SettingsRouteErrorBoundaryProps {
  readonly children: ReactNode;
  readonly owner: object;
  readonly route: string;
  readonly now: () => string;
  readonly onReturnHome: () => void;
  readonly onRetry: () => void;
}

interface SettingsRouteBoundaryState {
  readonly failed: boolean;
  readonly incidentId: string | null;
}

class SettingsRouteErrorBoundary extends Component<
  SettingsRouteErrorBoundaryProps,
  SettingsRouteBoundaryState
> {
  public override state: SettingsRouteBoundaryState = { failed: false, incidentId: null };

  public static getDerivedStateFromError(): SettingsRouteBoundaryState {
    return { failed: true, incidentId: null };
  }

  public override componentDidCatch(cause: unknown): void {
    const incident = recordUiRouteIncident(this.props.owner, {
      route: this.props.route,
      phase:
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "UI_LAZY_LOAD_FAILED"
          ? "lazy_load"
          : "render",
      cause,
      timestamp: this.props.now(),
    });
    this.setState({ failed: true, incidentId: incident.diagnosticId });
  }

  public override componentDidUpdate(previousProps: SettingsRouteErrorBoundaryProps): void {
    if (previousProps.route === this.props.route || !this.state.failed) return;
    if (this.state.incidentId !== null) {
      recoverUiRouteIncident(this.props.owner, this.state.incidentId, this.props.now());
    }
    this.setState({ failed: false, incidentId: null });
  }

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    const recover = (recoveryAction: "retry" | "navigate_start"): void => {
      if (this.state.incidentId !== null) {
        recoverUiRouteIncident(
          this.props.owner,
          this.state.incidentId,
          this.props.now(),
          recoveryAction,
        );
      }
    };
    return (
      <section
        className="desktop-route-loading settings-route-error-boundary"
        aria-label="设置页面恢复"
      >
        <ErrorState
          title="设置页面暂时没有正常打开"
          description="可以只重试这个设置页面，或先返回创作首页。已保存的正文、版本和本地凭据不会因为这个界面错误被修改。"
          savedState="本地数据保持原样；错误详情只记录脱敏后的页面与恢复阶段。"
          primaryAction={{
            label: "重试设置页面",
            onClick: () => {
              recover("retry");
              this.props.onRetry();
              this.setState({ failed: false, incidentId: null });
            },
          }}
          secondaryAction={{
            label: "返回创作首页",
            onClick: () => {
              recover("navigate_start");
              this.props.onReturnHome();
            },
          }}
        />
      </section>
    );
  }
}

export interface SettingsRouteBoundaryProps {
  readonly children: ReactNode;
  readonly onRetry?: () => void;
}

export function SettingsRouteBoundary({ children, onRetry }: SettingsRouteBoundaryProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const runtime = useRuntime();
  const route = safeSettingsRoute(location.pathname, location.hash);

  return (
    <SettingsRouteErrorBoundary
      owner={runtime}
      route={route}
      now={() => runtime.clock.now()}
      onReturnHome={() => void navigate("/start")}
      onRetry={onRetry ?? (() => undefined)}
    >
      {children}
    </SettingsRouteErrorBoundary>
  );
}
