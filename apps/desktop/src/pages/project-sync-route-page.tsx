import { EmptyState, ErrorState } from "@inkshadow/ui";
import { parseUuidV7 } from "@inkshadow/domain";
import { useNavigate, useParams } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { CloudSyncControlPanel } from "./cloud-sync-control-panel";

export function ProjectSyncRoutePage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const params = useParams<{ projectId: string }>();
  const projectId = parseUuidV7(params.projectId ?? "");

  if (!projectId.ok) {
    return (
      <div className="desktop-page">
        <ErrorState
          headingLevel={1}
          title="无法打开项目同步"
          description="项目标识无效。请返回项目列表并重新选择。"
          errorCode="SYNC_CONTROL_ROUTE_INVALID"
          primaryAction={{ label: "返回项目列表", onClick: () => void navigate("/projects") }}
        />
      </div>
    );
  }
  if (runtime.cloudSyncControl === null) {
    return (
      <div className="desktop-page">
        <EmptyState
          headingLevel={1}
          kind="feature_limited"
          title="此构建未启用项目云同步"
          description="本机项目、编辑、备份与导出保持可用；浏览器开发模式不会伪装云端状态。"
          primaryAction={{
            label: "查看同步与安全设置",
            onClick: () => void navigate("/settings#sync-security"),
          }}
        />
      </div>
    );
  }

  return (
    <div className="desktop-page">
      <CloudSyncControlPanel
        projectId={projectId.value}
        service={runtime.cloudSyncControl}
        onOpenConflicts={() => navigate(`/projects/${projectId.value}/sync/conflicts`)}
        onOpenSecurity={() => navigate("/settings/sync")}
      />
    </div>
  );
}
