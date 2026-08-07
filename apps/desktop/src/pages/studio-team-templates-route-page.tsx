import { parseUuidV7 } from "@inkshadow/domain";
import { EmptyState, ErrorState, InlineAlert, PageStateBoundary } from "@inkshadow/ui";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { StudioTeamTemplateSessionContext } from "../infrastructure/studio-team-template-service";
import { normalizeUiError } from "../infrastructure/ui-error";
import { useRuntime } from "../runtime-context";
import { StudioTeamTemplatesPage } from "./studio-team-templates-page";

type RouteState =
  | Readonly<{ status: "loading" }>
  | Readonly<{
      status: "ready";
      teamId: string;
      projectId: string;
      context: StudioTeamTemplateSessionContext;
      projectRevision: number;
      projectWritable: boolean;
      pendingCloudReceipts: number;
      recoveryFailure: Readonly<{ code: string; description: string }> | null;
    }>
  | Readonly<{
      status: "error";
      teamId: string;
      projectId: string;
      code: string;
      description: string;
    }>;

/**
 * Reachable route adapter for encrypted Studio team templates.
 *
 * Team authority and device identity come from the authenticated session, while
 * the expected project revision comes from the local project repository. URL
 * state is treated only as an identifier, never as authorization.
 */
export function StudioTeamTemplatesRoutePage() {
  const runtime = useRuntime();
  const navigate = useNavigate();
  const params = useParams<{ teamId: string; projectId: string }>();
  const templateRuntime = runtime.studioTeamTemplates;
  const [online, setOnline] = useState(() => templateRuntime?.isOnline() ?? false);
  const [route, setRoute] = useState<RouteState>({ status: "loading" });

  useEffect(() => {
    const refresh = () => setOnline(templateRuntime?.isOnline() ?? false);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    };
  }, [templateRuntime]);

  useEffect(() => {
    const teamId = params.teamId;
    const projectId = params.projectId;
    const parsedProjectId = parseUuidV7(projectId ?? "");
    if (
      templateRuntime === null ||
      !online ||
      teamId === undefined ||
      projectId === undefined ||
      !parsedProjectId.ok
    ) {
      return;
    }

    const abort = new AbortController();
    void Promise.all([
      templateRuntime.resolveContext(teamId, projectId, abort.signal),
      runtime.repositories.projects.findById(parsedProjectId.value),
    ])
      .then(async ([context, projectResult]) => {
        if (!projectResult.ok) {
          throw projectResult.error;
        }
        const project = projectResult.value;
        if (project === null) {
          throw routeError(
            "TEAM_TEMPLATE_LOCAL_PROJECT_MISSING",
            "当前本地工作区中没有这个已分配的云项目。",
          );
        }
        const projectSnapshot = project.toSnapshot();
        let pendingCloudReceipts = 0;
        let recoveryFailure: Readonly<{ code: string; description: string }> | null = null;
        const canRecover =
          projectSnapshot.status === "active" &&
          templateRuntime.isMutationEnabled() &&
          templateRuntime.coordinator.capabilities(context).apply;
        if (canRecover) {
          try {
            const outcomes = await templateRuntime.recoverPendingApplications(context, {
              limit: 50,
              signal: abort.signal,
            });
            pendingCloudReceipts = outcomes.filter(
              (outcome) => outcome.status === "partial_retry",
            ).length;
          } catch (error: unknown) {
            if (abort.signal.aborted) {
              return;
            }
            recoveryFailure = normalizeUiError(error);
          }
        }
        if (!abort.signal.aborted) {
          setRoute({
            status: "ready",
            teamId,
            projectId,
            context,
            projectRevision: projectSnapshot.revision,
            projectWritable: projectSnapshot.status === "active",
            pendingCloudReceipts,
            recoveryFailure,
          });
        }
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) {
          return;
        }
        const visible = normalizeUiError(error);
        setRoute({
          status: "error",
          teamId,
          projectId,
          code: visible.code,
          description: visible.description,
        });
      });
    return () => abort.abort();
  }, [online, params.projectId, params.teamId, runtime.repositories.projects, templateRuntime]);

  const teamId = params.teamId;
  const projectId = params.projectId;
  if (teamId === undefined || projectId === undefined || !parseUuidV7(projectId).ok) {
    return (
      <div className="desktop-page">
        <ErrorState
          headingLevel={1}
          title="无法打开团队模板"
          description="模板入口缺少有效的团队或项目范围，请从团队工作区重新打开。"
          errorCode="TEAM_TEMPLATE_ROUTE_SCOPE_INVALID"
          primaryAction={{
            label: "返回团队工作区",
            onClick: () => void navigate("/teams"),
          }}
        />
      </div>
    );
  }
  if (templateRuntime === null) {
    return (
      <div className="desktop-page">
        <EmptyState
          headingLevel={1}
          kind="feature_limited"
          title="加密团队模板不可用"
          description="当前环境没有完整的原生云会话、项目密钥与本地事务能力；浏览器开发模式不会伪造远端成功。"
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
      <div className="desktop-page">
        <EmptyState
          headingLevel={1}
          kind="offline"
          title="团队模板需要联网"
          description="离线时不会伪造模板列表或写入成功；恢复网络后会重新验证权限并续传待确认回执。"
          primaryAction={{
            label: "返回团队工作区",
            onClick: () => void navigate("/teams"),
          }}
        />
      </div>
    );
  }

  const visibleRoute =
    route.status === "loading" || (route.teamId === teamId && route.projectId === projectId)
      ? route
      : ({ status: "loading" } as const);
  if (visibleRoute.status === "loading") {
    return (
      <div className="desktop-page">
        <PageStateBoundary state="loading" loadingLabel="正在验证团队模板权限与本地项目版本">
          <span />
        </PageStateBoundary>
      </div>
    );
  }
  if (visibleRoute.status === "error") {
    return (
      <div className="desktop-page">
        <ErrorState
          headingLevel={1}
          title="无法打开团队模板"
          description={visibleRoute.description}
          errorCode={visibleRoute.code}
          primaryAction={{
            label: "返回团队工作区",
            onClick: () => void navigate("/teams"),
          }}
        />
      </div>
    );
  }

  return (
    <div className="desktop-page">
      {!visibleRoute.projectWritable && (
        <InlineAlert
          tone="warning"
          title="本地项目为只读状态"
          description="加密模板历史仍可查看和导出，但归档或回收站中的项目不会接受模板变更。"
        />
      )}
      {visibleRoute.pendingCloudReceipts > 0 && (
        <InlineAlert
          tone="warning"
          title="云端回执仍待确认"
          description={`已有本地模板变更安全提交，但仍有 ${String(visibleRoute.pendingCloudReceipts)} 条元数据回执待重试；项目内容不会重复应用。`}
        />
      )}
      {visibleRoute.recoveryFailure !== null && (
        <InlineAlert
          tone="warning"
          title="待确认回执暂未恢复"
          description={`本地项目提交保持有效，下次进入时会安全重试。（${visibleRoute.recoveryFailure.code}）`}
        />
      )}
      <StudioTeamTemplatesPage
        coordinator={templateRuntime.coordinator}
        context={visibleRoute.context}
        online={online}
        mutationFeatureEnabled={templateRuntime.isMutationEnabled()}
        projectWritable={visibleRoute.projectWritable}
        expectedProjectRevision={visibleRoute.projectRevision}
        onProjectRevisionAdvanced={(projectRevision) =>
          setRoute((current) =>
            current.status !== "ready"
              ? current
              : {
                  ...current,
                  projectRevision,
                  pendingCloudReceipts: 0,
                  recoveryFailure: null,
                },
          )
        }
      />
    </div>
  );
}

function routeError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
