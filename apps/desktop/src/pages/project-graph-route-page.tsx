import { parseUuidV7 } from "@inkshadow/domain";
import { Navigate, useParams } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { ProjectGraphPage } from "./project-graph-page";

export function ProjectGraphRoutePage() {
  const runtime = useRuntime();
  const params = useParams<{ projectId: string }>();
  const parsedProjectId = parseUuidV7(params.projectId ?? "");
  const fallback = parsedProjectId.ok ? `/projects/${parsedProjectId.value}` : "/projects";

  if (!runtime.featureFlags.graphRag || runtime.storyGraph === null) {
    return <Navigate to={fallback} replace />;
  }
  if (!parsedProjectId.ok) {
    return <Navigate to="/projects" replace />;
  }

  return <ProjectGraphPage graph={runtime.storyGraph} projectId={parsedProjectId.value} />;
}
