import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ErrorState, PageStateBoundary } from "@inkshadow/ui";

import type { StudioReviewSessionContext } from "../infrastructure/studio-review-service";
import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";
import { StudioReviewPage } from "./studio-review-page";

type AuthorityState =
  | Readonly<{ status: "loading" }>
  | Readonly<{
      status: "ready";
      teamId: string;
      projectId: string;
      context: StudioReviewSessionContext;
    }>
  | Readonly<{
      status: "error";
      teamId: string;
      projectId: string;
      code: string;
      description: string;
    }>;

/**
 * Reachable route adapter for Studio review.
 *
 * Team role, tenant, membership, and exact project assignment are resolved
 * from the authenticated cloud session on every mount. None of those
 * authorities are accepted from URL/query state.
 */
export function StudioReviewRoutePage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const params = useParams<{ teamId: string; projectId: string }>();
  const reviewRuntime = runtime.studioReview;
  const [online, setOnline] = useState(() => reviewRuntime?.isOnline() ?? false);
  const [authority, setAuthority] = useState<AuthorityState>({ status: "loading" });

  useEffect(() => {
    const refresh = () => {
      const next = reviewRuntime?.isOnline() ?? false;
      setOnline(next);
      if (!next) {
        setAuthority({ status: "loading" });
      }
    };
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    };
  }, [reviewRuntime]);

  useEffect(() => {
    if (reviewRuntime === null) {
      return;
    }
    if (!online) {
      return;
    }
    const teamId = params.teamId;
    const projectId = params.projectId;
    if (teamId === undefined || projectId === undefined) {
      return;
    }
    const abort = new AbortController();
    void reviewRuntime
      .resolveContext(teamId, projectId, abort.signal)
      .then((context) => {
        if (!abort.signal.aborted) {
          setAuthority({ status: "ready", teamId, projectId, context });
        }
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) {
          return;
        }
        const visible = normalizeUiError(error);
        setAuthority({
          status: "error",
          teamId,
          projectId,
          code: visible.code,
          description: visible.description,
        });
      });
    return () => abort.abort();
  }, [online, params.projectId, params.teamId, reviewRuntime]);

  if (reviewRuntime === null) {
    return (
      <div className="studio-review-page">
        <ErrorState
          headingLevel={1}
          title="团队加密审阅不可用"
          description="当前运行环境没有完整的原生云会话、已落盘密文投影和项目密钥能力。浏览器开发模式不会模拟远端成功。"
          errorCode="REVIEW_RUNTIME_UNAVAILABLE"
          primaryAction={{
            label: "返回团队工作区",
            onClick: () => void navigate("/teams"),
          }}
        />
      </div>
    );
  }

  if (!online) {
    return (
      <div className="studio-review-page">
        <ErrorState
          headingLevel={1}
          title="团队审阅需要联网"
          description="离线时不会伪造审阅列表或提交成功。恢复网络后，本页会重新验证团队与项目权限。"
          errorCode="REVIEW_OFFLINE"
          primaryAction={{
            label: "返回团队工作区",
            onClick: () => void navigate("/teams"),
          }}
        />
      </div>
    );
  }

  const teamId = params.teamId;
  const projectId = params.projectId;
  if (teamId === undefined || projectId === undefined) {
    return (
      <div className="studio-review-page">
        <ErrorState
          headingLevel={1}
          title="无法打开团队审阅"
          description="审阅入口缺少团队或项目范围，请从团队工作区重新打开。"
          errorCode="REVIEW_ROUTE_SCOPE_INVALID"
          primaryAction={{
            label: "返回团队工作区",
            onClick: () => void navigate("/teams"),
          }}
        />
      </div>
    );
  }
  const visibleAuthority =
    authority.status === "loading" ||
    (authority.teamId === teamId && authority.projectId === projectId)
      ? authority
      : ({ status: "loading" } as const);

  if (visibleAuthority.status === "loading") {
    return (
      <div className="studio-review-page">
        <PageStateBoundary state="loading" loadingLabel="正在验证团队审阅权限">
          <span />
        </PageStateBoundary>
      </div>
    );
  }

  if (visibleAuthority.status === "error") {
    return (
      <div className="studio-review-page">
        <ErrorState
          headingLevel={1}
          title="无法打开团队审阅"
          description={visibleAuthority.description}
          errorCode={visibleAuthority.code}
          primaryAction={{
            label: "返回团队工作区",
            onClick: () => void navigate("/teams"),
          }}
        />
      </div>
    );
  }

  return (
    <StudioReviewPage
      coordinator={reviewRuntime.coordinator}
      context={visibleAuthority.context}
      online={online}
    />
  );
}
