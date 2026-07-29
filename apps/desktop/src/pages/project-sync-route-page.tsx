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
      <main className="desktop-page">
        <ErrorState
          title="无法打开项目同步"
          description="项目标识无效。"
          errorCode="SYNC_CONTROL_ROUTE_INVALID"
        />
      </main>
    );
  }
  if (runtime.cloudSyncControl === null) {
    return (
      <main className="desktop-page">
        <EmptyState
          kind="feature_limited"
          title="此构建未启用项目云同步"
          description="本机项目、编辑、备份与导出保持可用；浏览器开发模式不会伪装云端状态。"
        />
      </main>
    );
  }

  return (
    <main className="desktop-page">
      <CloudSyncControlPanel
        projectId={projectId.value}
        service={runtime.cloudSyncControl}
        onOpenConflicts={() => navigate(`/projects/${projectId.value}/sync/conflicts`)}
        onOpenSecurity={() => navigate("/settings/sync")}
      />
    </main>
  );
}
