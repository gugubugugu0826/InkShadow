import { ErrorState } from "@inkshadow/ui";
import { parseUuidV7 } from "@inkshadow/domain";
import { useNavigate, useParams } from "react-router-dom";

import { useRuntime } from "../runtime-context";
import { MultiAgentReviewPage } from "./multi-agent-review-page";
import { chapterCandidateLocation } from "./multi-agent-review-route";

export function MultiAgentReviewRoutePage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const params = useParams<{ projectId: string; chapterId?: string }>();
  const projectId = parseUuidV7(params.projectId ?? "");
  const chapterId = params.chapterId === undefined ? null : parseUuidV7(params.chapterId);

  if (!projectId.ok || (chapterId !== null && !chapterId.ok)) {
    return (
      <div className="desktop-page">
        <ErrorState
          headingLevel={1}
          title="无法打开多智能体审查"
          description="项目或章节标识无效。请返回项目列表并重新选择。"
          errorCode="MULTI_AGENT_ROUTE_INVALID"
          primaryAction={{ label: "返回项目列表", onClick: () => void navigate("/projects") }}
        />
      </div>
    );
  }

  return (
    <MultiAgentReviewPage
      runtime={runtime.multiAgentReview}
      projectId={projectId.value}
      chapterId={chapterId?.value ?? null}
      featureEnabled={runtime.featureFlags.multiAgent && runtime.multiAgentReview !== null}
      onOpenChapterCandidate={(candidateId, targetChapterId) => {
        if (targetChapterId !== null) {
          void navigate(chapterCandidateLocation(projectId.value, targetChapterId, candidateId));
        }
      }}
    />
  );
}
