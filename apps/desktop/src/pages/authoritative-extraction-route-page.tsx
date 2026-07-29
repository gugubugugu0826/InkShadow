import { parseUuidV7 } from "@inkshadow/domain";
import { Navigate, useParams } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { AuthoritativeExtractionPage } from "./authoritative-extraction-page";

export function AuthoritativeExtractionRoutePage() {
  const runtime = useRuntime();
  const params = useParams<{ projectId: string }>();
  const projectId = parseUuidV7(params.projectId ?? "");

  if (!projectId.ok) {
    return <Navigate to="/projects" replace />;
  }
  if (!runtime.featureFlags.authoritativeExtraction || runtime.authoritativeExtraction === null) {
    return <Navigate to={`/projects/${projectId.value}`} replace />;
  }

  return (
    <AuthoritativeExtractionPage
      runtime={runtime.authoritativeExtraction}
      projectId={projectId.value}
      actorId={runtime.story.actorId}
      {...(runtime.authoritativeExtraction.goldenSuite === undefined
        ? {}
        : { goldenSuite: runtime.authoritativeExtraction.goldenSuite })}
    />
  );
}
