import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  createHashRouter,
  Link,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
  Routes,
  useParams,
} from "react-router-dom";
import { EmptyState, ToastProvider } from "@inkshadow/ui";

import {
  DesktopPersistenceBoundary,
  PersistenceRouteBoundary,
} from "./components/desktop-persistence-boundary";
import { AppErrorBoundary } from "./components/app-error-boundary";
import { ComponentOwnershipBoundary } from "./components/component-ownership-path";
import { DesktopShell } from "./components/desktop-shell";
import { SettingsRouteBoundary } from "./components/settings-route-boundary";
import { recoverOrphanedOpeningInvocationsAtStartup } from "./infrastructure/opening-startup-recovery";
import { recoverOrphanedCapabilityProbeInvocationsAtStartup } from "./infrastructure/capability-probe-startup-recovery";
import { RuntimeProvider, useRuntime, type RuntimeProviderProps } from "./runtime-context";

const EditorPage = lazy(() =>
  import("./pages/editor-page").then(({ EditorPage: Page }) => ({ default: Page })),
);
const ProjectsPage = lazy(() =>
  import("./pages/projects-page").then(({ ProjectsPage: Page }) => ({ default: Page })),
);
const ProjectSearchPage = lazy(() =>
  import("./pages/project-search-page").then(({ ProjectSearchPage: Page }) => ({
    default: Page,
  })),
);
const ProjectMaterialsPage = lazy(() =>
  import("./pages/project-materials-page").then(({ ProjectMaterialsPage: Page }) => ({
    default: Page,
  })),
);
const ProjectChecksPage = lazy(() =>
  import("./pages/project-checks-page").then(({ ProjectChecksPage: Page }) => ({
    default: Page,
  })),
);
const ContextSourcesPage = lazy(() =>
  import("./pages/context-sources-page").then(({ ContextSourcesPage: Page }) => ({
    default: Page,
  })),
);
const ProjectGraphRoutePage = lazy(() =>
  import("./pages/project-graph-route-page").then(({ ProjectGraphRoutePage: Page }) => ({
    default: Page,
  })),
);
const AuthoritativeExtractionRoutePage = lazy(() =>
  import("./pages/authoritative-extraction-route-page").then(
    ({ AuthoritativeExtractionRoutePage: Page }) => ({
      default: Page,
    }),
  ),
);
const MultiAgentReviewRoutePage = lazy(() =>
  import("./pages/multi-agent-review-route-page").then(({ MultiAgentReviewRoutePage: Page }) => ({
    default: Page,
  })),
);
const FineTuningGovernanceRoutePage = lazy(() =>
  import("./pages/fine-tuning-governance-route-page").then(
    ({ FineTuningGovernanceRoutePage: Page }) => ({
      default: Page,
    }),
  ),
);
const MarketplaceRoutePage = lazy(() =>
  import("./pages/marketplace-route-page").then(({ MarketplaceRoutePage: Page }) => ({
    default: Page,
  })),
);
function loadSettingsPage() {
  return import("./pages/settings-page")
    .then(({ SettingsPage: Page }) => ({ default: Page }))
    .catch(() => {
      throw Object.assign(new Error("设置页面代码加载失败。"), {
        code: "UI_LAZY_LOAD_FAILED",
      });
    });
}
const SyncSecurityPage = lazy(() =>
  import("./pages/sync-security-page").then(({ SyncSecurityPage: Page }) => ({
    default: Page,
  })),
);
const StoryOutlinePage = lazy(() =>
  import("./pages/story-outline-page").then(({ StoryOutlinePage: Page }) => ({
    default: Page,
  })),
);
const StoryGovernancePage = lazy(() =>
  import("./pages/story-governance-page").then(({ StoryGovernancePage: Page }) => ({
    default: Page,
  })),
);
const TaskCenterPage = lazy(() =>
  import("./pages/task-center-page").then(({ TaskCenterPage: Page }) => ({ default: Page })),
);
const UsageCenterPage = lazy(() =>
  import("./pages/usage-center-page").then(({ UsageCenterPage: Page }) => ({ default: Page })),
);
const WorkspacePage = lazy(() =>
  import("./pages/workspace-page").then(({ WorkspacePage: Page }) => ({ default: Page })),
);

function WorkspaceRouteElement() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  return <WorkspacePage key={projectId} />;
}

function StoryOutlineRouteElement() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  return <StoryOutlinePage key={projectId} />;
}

function StoryGovernanceRouteElement() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  return <StoryGovernancePage key={projectId} />;
}

function ProjectChecksRouteElement() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  return <ProjectChecksPage key={projectId} />;
}
const StartPage = lazy(() =>
  import("./pages/start-page").then(({ StartPage: Page }) => ({ default: Page })),
);
const IdeaJourneyPage = lazy(() =>
  import("./pages/idea-journey-page").then(({ IdeaJourneyPage: Page }) => ({ default: Page })),
);
const ImportJourneyPage = lazy(() =>
  import("./pages/import-journey-page").then(({ ImportJourneyPage: Page }) => ({ default: Page })),
);
const ProfessionalCreatePage = lazy(() =>
  import("./pages/professional-create-page").then(({ ProfessionalCreatePage: Page }) => ({
    default: Page,
  })),
);
const CloudLoginPage = lazy(() =>
  import("./pages/cloud-login-page").then(({ CloudLoginPage: Page }) => ({ default: Page })),
);
const TEAM_COLLABORATION_ROUTES_BUNDLED =
  import.meta.env.MODE === "test" ||
  (import.meta.env.VITE_INKSHADOW_CLOUD_IDENTITY_ENABLED === "true" &&
    import.meta.env.VITE_INKSHADOW_TEAM_COLLABORATION_ENABLED === "true");
const StudioTeamPage = TEAM_COLLABORATION_ROUTES_BUNDLED
  ? lazy(() =>
      import("./pages/studio-team-page").then(({ StudioTeamPage: Page }) => ({ default: Page })),
    )
  : null;
const StudioUsagePage = TEAM_COLLABORATION_ROUTES_BUNDLED
  ? lazy(() =>
      import("./pages/studio-usage-page").then(({ StudioUsagePage: Page }) => ({ default: Page })),
    )
  : null;
const StudioReviewRoutePage = TEAM_COLLABORATION_ROUTES_BUNDLED
  ? lazy(() =>
      import("./pages/studio-review-route-page").then(({ StudioReviewRoutePage: Page }) => ({
        default: Page,
      })),
    )
  : null;
const StudioTeamTemplatesRoutePage = TEAM_COLLABORATION_ROUTES_BUNDLED
  ? lazy(() =>
      import("./pages/studio-team-templates-route-page").then(
        ({ StudioTeamTemplatesRoutePage: Page }) => ({
          default: Page,
        }),
      ),
    )
  : null;
const IdeationPage = lazy(() =>
  import("./pages/ideation-page").then(({ IdeationPage: Page }) => ({ default: Page })),
);
const GovernedCreativeExtensionsRoutePage = lazy(() =>
  import("./pages/governed-creative-extensions-route-page").then(
    ({ GovernedCreativeExtensionsRoutePage: Page }) => ({ default: Page }),
  ),
);
const ProjectSyncRoutePage = lazy(() =>
  import("./pages/project-sync-route-page").then(({ ProjectSyncRoutePage: Page }) => ({
    default: Page,
  })),
);
const SyncConflictResolutionRoutePage = lazy(() =>
  import("./pages/sync-conflict-resolution-route-page").then(
    ({ SyncConflictResolutionRoutePage: Page }) => ({ default: Page }),
  ),
);
const WebViewStressController =
  import.meta.env.DEV && import.meta.env.VITE_INKSHADOW_QA_WEBVIEW_STRESS === "1"
    ? lazy(() =>
        import("./qa/webview-stress-controller").then(
          ({ WebViewStressController: Controller }) => ({
            default: Controller,
          }),
        ),
      )
    : null;

export interface AppProps extends Pick<RuntimeProviderProps, "runtime" | "factory"> {
  readonly router?: "hash" | "none";
}

function CloudIdentityRoute() {
  const runtime = useRuntime();

  if (!runtime.featureFlags.cloudIdentity || runtime.cloudIdentity?.available !== true) {
    return <Navigate to="/start" replace />;
  }

  return <CloudLoginPage />;
}

function TeamFeatureLimitedState() {
  return (
    <div className="studio-usage-page">
      <EmptyState
        headingLevel={1}
        kind="feature_limited"
        title="团队协作尚未启用"
        description="此构建没有获得 Studio 团队协作授权，因此不会发起团队、预算或评审云请求。现有本地个人项目与离线编辑不受影响。"
      />
      <div className="settings-actions">
        <Link className="button-link" to="/projects">
          返回项目
        </Link>
      </div>
    </div>
  );
}

function NotFoundState() {
  return (
    <div className="desktop-page">
      <EmptyState
        headingLevel={1}
        kind="no_results"
        title="找不到这个页面"
        description="链接可能已经过期、地址不完整，或对应功能在当前版本中不可用。"
      />
      <div className="settings-actions">
        <Link className="button-link" to="/projects">
          返回项目
        </Link>
      </div>
    </div>
  );
}

function StudioTeamRoute() {
  const runtime = useRuntime();
  return runtime.featureFlags.teamCollaboration && StudioTeamPage !== null ? (
    <StudioTeamPage />
  ) : (
    <TeamFeatureLimitedState />
  );
}

function StudioUsageRoute() {
  const runtime = useRuntime();
  return runtime.featureFlags.teamCollaboration && StudioUsagePage !== null ? (
    <StudioUsagePage />
  ) : (
    <TeamFeatureLimitedState />
  );
}

function PersonalUsageRoute() {
  const runtime = useRuntime();
  if (runtime.usageCenter === null) {
    return (
      <div className="desktop-page">
        <EmptyState
          kind="feature_limited"
          title="费用记录只在桌面版读取"
          description="浏览器开发模式不会伪造服务请求、发送与返回文字量或费用数据。请在墨影桌面版中打开此页面；正文与本地创作不受影响。"
          primaryAction={{
            label: "返回创作首页",
            onClick: () => {
              window.location.hash = "#/start";
            },
          }}
        />
      </div>
    );
  }
  return <UsageCenterPage reader={runtime.usageCenter} />;
}

function StudioReviewFeatureRoute() {
  const runtime = useRuntime();
  return runtime.featureFlags.teamCollaboration && StudioReviewRoutePage !== null ? (
    <StudioReviewRoutePage />
  ) : (
    <TeamFeatureLimitedState />
  );
}

function StudioTeamTemplatesFeatureRoute() {
  const runtime = useRuntime();
  return runtime.featureFlags.teamCollaboration && StudioTeamTemplatesRoutePage !== null ? (
    <StudioTeamTemplatesRoutePage />
  ) : (
    <TeamFeatureLimitedState />
  );
}

function SettingsRouteElement() {
  const [RetryableSettingsPage, setRetryableSettingsPage] = useState(() => lazy(loadSettingsPage));
  return (
    <SettingsRouteBoundary onRetry={() => setRetryableSettingsPage(() => lazy(loadSettingsPage))}>
      <Suspense
        fallback={
          <div className="desktop-route-loading desktop-route-loading--local" role="status">
            正在打开设置页面
          </div>
        }
      >
        <RetryableSettingsPage />
      </Suspense>
    </SettingsRouteBoundary>
  );
}

export function DesktopRoutes() {
  return (
    <ComponentOwnershipBoundary name="DesktopRoutes">
      <Suspense
        fallback={
          <div className="desktop-route-loading" role="status">
            正在打开本地页面
          </div>
        }
      >
        {WebViewStressController !== null && <WebViewStressController />}
        <Routes>
          <Route path="/" element={<Navigate to="/start" replace />} />
          <Route path="/create/idea" element={<IdeaJourneyPage />} />
          <Route path="/create/import" element={<ImportJourneyPage />} />
          <Route path="/create/professional" element={<ProfessionalCreatePage />} />
          <Route path="/auth/login" element={<CloudIdentityRoute />} />
          <Route
            element={
              <DesktopShell>
                <Outlet />
              </DesktopShell>
            }
          >
            <Route path="/start" element={<StartPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/ideation" element={<IdeationPage />} />
            <Route path="/marketplace" element={<MarketplaceRoutePage />} />
            <Route path="/projects/:projectId" element={<WorkspaceRouteElement />} />
            <Route path="/projects/:projectId/search" element={<ProjectSearchPage />} />
            <Route path="/projects/:projectId/graph" element={<ProjectGraphRoutePage />} />
            <Route
              path="/projects/:projectId/extraction"
              element={<AuthoritativeExtractionRoutePage />}
            />
            <Route path="/projects/:projectId/materials" element={<ProjectMaterialsPage />} />
            <Route path="/projects/:projectId/outline" element={<StoryOutlineRouteElement />} />
            <Route path="/projects/:projectId/story" element={<StoryGovernanceRouteElement />} />
            <Route path="/projects/:projectId/checks" element={<ProjectChecksRouteElement />} />
            <Route path="/projects/:projectId/context" element={<ContextSourcesPage />} />
            <Route path="/projects/:projectId/sync" element={<ProjectSyncRoutePage />} />
            <Route
              path="/projects/:projectId/sync/conflicts"
              element={<SyncConflictResolutionRoutePage />}
            />
            <Route
              path="/projects/:projectId/multi-agent-review"
              element={<MultiAgentReviewRoutePage />}
            />
            <Route
              path="/projects/:projectId/fine-tuning"
              element={<FineTuningGovernanceRoutePage />}
            />
            <Route path="/projects/:projectId/chapters/:chapterId" element={<EditorPage />} />
            <Route
              path="/projects/:projectId/chapters/:chapterId/extensions"
              element={<GovernedCreativeExtensionsRoutePage />}
            />
            <Route
              path="/projects/:projectId/chapters/:chapterId/multi-agent-review"
              element={<MultiAgentReviewRoutePage />}
            />
            <Route path="/settings" element={<SettingsRouteElement />} />
            <Route path="/settings/sync" element={<SyncSecurityPage />} />
            <Route path="/teams" element={<StudioTeamRoute />} />
            <Route path="/teams/:teamId/usage" element={<StudioUsageRoute />} />
            <Route
              path="/teams/:teamId/projects/:projectId/reviews"
              element={<StudioReviewFeatureRoute />}
            />
            <Route
              path="/teams/:teamId/projects/:projectId/templates"
              element={<StudioTeamTemplatesFeatureRoute />}
            />
            <Route path="/tasks" element={<TaskCenterPage />} />
            <Route path="/usage" element={<PersonalUsageRoute />} />
            <Route path="*" element={<NotFoundState />} />
          </Route>
        </Routes>
      </Suspense>
    </ComponentOwnershipBoundary>
  );
}

function HashRoutedDesktop() {
  const router = useMemo(
    () =>
      createHashRouter([
        {
          path: "*",
          element: (
            <PersistenceRouteBoundary>
              <DesktopRoutes />
            </PersistenceRouteBoundary>
          ),
        },
      ]),
    [],
  );
  return <RouterProvider router={router} />;
}

export function StartupOpeningInvocationRecovery() {
  const runtime = useRuntime();

  useEffect(() => {
    void Promise.allSettled([
      recoverOrphanedOpeningInvocationsAtStartup(runtime),
      recoverOrphanedCapabilityProbeInvocationsAtStartup(runtime.modelHub),
    ]);
  }, [runtime]);

  return null;
}

export function App({ factory, router = "hash", runtime }: AppProps) {
  return (
    <RuntimeProvider
      {...(factory === undefined ? {} : { factory })}
      {...(runtime === undefined ? {} : { runtime })}
    >
      <ToastProvider>
        <AppErrorBoundary>
          <DesktopPersistenceBoundary>
            <StartupOpeningInvocationRecovery />
            {router === "hash" ? <HashRoutedDesktop /> : <DesktopRoutes />}
          </DesktopPersistenceBoundary>
        </AppErrorBoundary>
      </ToastProvider>
    </RuntimeProvider>
  );
}
