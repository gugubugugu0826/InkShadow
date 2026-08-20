import { useMemo } from "react";
import { parseUuidV7 } from "@inkshadow/domain";
import { Navigate, useParams, useSearchParams } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { CausalFactAuthoringService } from "../infrastructure/causal-fact-authoring-service";
import { ProjectGraphPage } from "./project-graph-page";
import { CausalStoryLinksPage } from "./causal-story-links-page";

export function ProjectGraphRoutePage() {
  const runtime = useRuntime();
  const params = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const parsedProjectId = parseUuidV7(params.projectId ?? "");
  // The model-backed what-if path does not yet expose a persisted
  // prepare/disclosure/confirmation receipt to ordinary users. Keep it closed
  // even when the lower-level experimental flag is enabled.
  const governedWhatIfConfirmationAvailable = false;
  const causalAuthoring = useMemo(
    () =>
      new CausalFactAuthoringService({
        chapters: runtime.repositories.chapters,
        chapterVersions: runtime.repositories.chapterVersions,
        facts: runtime.story.factService,
        factStore: runtime.story.facts,
        projector: runtime.story.causalProjector,
      }),
    [runtime],
  );
  if (!parsedProjectId.ok) {
    return <Navigate to="/projects" replace />;
  }

  if (
    searchParams.get("legacy") === "1" &&
    runtime.featureFlags.graphRag &&
    runtime.storyGraph !== null
  ) {
    return <ProjectGraphPage graph={runtime.storyGraph} projectId={parsedProjectId.value} />;
  }

  return (
    <CausalStoryLinksPage
      graph={runtime.story.causalGraph}
      projector={runtime.story.causalProjector}
      whatIf={runtime.story.causalWhatIf}
      whatIfEnabled={runtime.featureFlags.whatIf && governedWhatIfConfirmationAvailable}
      authoring={causalAuthoring}
      chapters={runtime.repositories.chapters}
      actorId={runtime.story.actorId}
      projectId={parsedProjectId.value}
      legacyProjectionAvailable={runtime.featureFlags.graphRag && runtime.storyGraph !== null}
    />
  );
}
