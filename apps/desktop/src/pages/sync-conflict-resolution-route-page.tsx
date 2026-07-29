import { EmptyState, ErrorState } from "@inkshadow/ui";
import { parseUuidV7 } from "@inkshadow/domain";
import { useParams } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { SyncConflictResolutionPage } from "./sync-conflict-resolution-page";

export function SyncConflictResolutionRoutePage() {
  const runtime = useRuntime();
  const params = useParams<{ projectId: string }>();
  const projectId = parseUuidV7(params.projectId ?? "");

  if (!projectId.ok) {
    return (
      <main className="desktop-page">
        <ErrorState
          title="无法打开冲突处理"
          description="项目标识无效。"
          errorCode="SYNC_CONFLICT_ROUTE_INVALID"
        />
      </main>
    );
  }
  if (runtime.syncConflictResolution === null) {
    return (
      <main className="desktop-page">
        <EmptyState
          kind="feature_limited"
          title="冲突处理运行时不可用"
          description="未启用云同步或缺少当前设备的密钥授权；双方版本不会被静默覆盖。"
        />
      </main>
    );
  }

  return (
    <SyncConflictResolutionPage
      projectId={projectId.value}
      coordinator={runtime.syncConflictResolution}
    />
  );
}
