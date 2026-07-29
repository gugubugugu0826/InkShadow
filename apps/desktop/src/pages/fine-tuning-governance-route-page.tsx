import { parseUuidV7 } from "@inkshadow/domain";
import { Navigate, useParams } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { FineTuningGovernancePage } from "./fine-tuning-governance-page";

export function FineTuningGovernanceRoutePage() {
  const runtime = useRuntime();
  const params = useParams<{ projectId: string }>();
  const projectId = parseUuidV7(params.projectId ?? "");

  if (!projectId.ok) {
    return <Navigate to="/projects" replace />;
  }
  if (runtime.fineTuningGovernance === null || runtime.fineTuningGovernance === undefined) {
    return <Navigate to={`/projects/${projectId.value}`} replace />;
  }

  return (
    <FineTuningGovernancePage
      runtime={runtime.fineTuningGovernance}
      projectId={projectId.value}
      actorId={runtime.story.actorId}
    />
  );
}
