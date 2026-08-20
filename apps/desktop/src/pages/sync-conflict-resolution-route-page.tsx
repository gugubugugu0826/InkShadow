import { EmptyState, ErrorState } from "@inkshadow/ui";
import { parseUuidV7 } from "@inkshadow/domain";
import { useNavigate, useParams } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { SyncConflictResolutionPage } from "./sync-conflict-resolution-page";

export function SyncConflictResolutionRoutePage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const params = useParams<{ projectId: string }>();
  const projectId = parseUuidV7(params.projectId ?? "");

  if (!projectId.ok) {
    return (
      <div className="desktop-page">
        <ErrorState
          headingLevel={1}
          title="无法打开冲突处理"
          description="项目标识无效。请返回项目列表并重新选择。"
          primaryAction={{ label: "返回项目列表", onClick: () => void navigate("/projects") }}
        />
      </div>
    );
  }
  if (runtime.syncConflictResolution === null) {
    return (
      <div className="desktop-page">
        <EmptyState
          headingLevel={1}
          kind="feature_limited"
          title="冲突处理运行时不可用"
          description="未启用云同步或缺少当前设备的密钥授权；双方版本不会被静默覆盖。"
          primaryAction={{
            label: "查看同步与安全设置",
            onClick: () => void navigate("/settings#sync-security"),
          }}
        />
      </div>
    );
  }

  return (
    <SyncConflictResolutionPage
      projectId={projectId.value}
      coordinator={runtime.syncConflictResolution}
    />
  );
}
