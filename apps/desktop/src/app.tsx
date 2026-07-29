import { lazy, Suspense, useMemo } from "react";
import {
  createHashRouter,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
  Routes,
} from "react-router-dom";
import { EmptyState, ToastProvider } from "@inkshadow/ui";

import {
  DesktopPersistenceBoundary,
  PersistenceRouteBoundary,
} from "./components/desktop-persistence-boundary";
import { DesktopShell } from "./components/desktop-shell";
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
const SettingsPage = lazy(() =>
  import("./pages/settings-page").then(({ SettingsPage: Page }) => ({ default: Page })),
);
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
const WorkspacePage = lazy(() =>
  import("./pages/workspace-page").then(({ WorkspacePage: Page }) => ({ default: Page })),
);
const StartPage = lazy(() =>
  import("./pages/start-page").then(({ StartPage: Page }) => ({ default: Page })),
);
const CloudLoginPage = lazy(() =>
  import("./pages/cloud-login-page").then(({ CloudLoginPage: Page }) => ({ default: Page })),
);
const StudioTeamPage = lazy(() =>
  import("./pages/studio-team-page").then(({ StudioTeamPage: Page }) => ({ default: Page })),
);
const StudioUsagePage = lazy(() =>
  import("./pages/studio-usage-page").then(({ StudioUsagePage: Page }) => ({ default: Page })),
);
const StudioReviewRoutePage = lazy(() =>
  import("./pages/studio-review-route-page").then(({ StudioReviewRoutePage: Page }) => ({
    default: Page,
  })),
);
const StudioTeamTemplatesRoutePage = lazy(() =>
  import("./pages/studio-team-templates-route-page").then(
    ({ StudioTeamTemplatesRoutePage: Page }) => ({
      default: Page,
    }),
  ),
);
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
    <main className="studio-usage-page">
      <EmptyState
        kind="feature_limited"
        title="团队协作尚未启用"
        description="此构建没有获得 Studio 团队协作授权，因此不会发起团队、预算或评审云请求。现有本地个人项目与离线编辑不受影响。"
      />
    </main>
  );
}

function StudioTeamRoute() {
  const runtime = useRuntime();
  return runtime.featureFlags.teamCollaboration ? <StudioTeamPage /> : <TeamFeatureLimitedState />;
}

function StudioUsageRoute() {
  const runtime = useRuntime();
  return runtime.featureFlags.teamCollaboration ? <StudioUsagePage /> : <TeamFeatureLimitedState />;
}

function StudioReviewFeatureRoute() {
  const runtime = useRuntime();
  return runtime.featureFlags.teamCollaboration ? (
    <StudioReviewRoutePage />
  ) : (
    <TeamFeatureLimitedState />
  );
}

function StudioTeamTemplatesFeatureRoute() {
  const runtime = useRuntime();
  return runtime.featureFlags.teamCollaboration ? (
    <StudioTeamTemplatesRoutePage />
  ) : (
    <TeamFeatureLimitedState />
  );
}

export function DesktopRoutes() {
  return (
    <Suspense
      fallback={
        <div className="desktop-route-loading" role="status">
          正在打开本地页面
        </div>
      }
    >
      {WebViewStressController !== null && <WebViewStressController />}
      <Routes>
        <Route path="/" element={<StartPage />} />
        <Route path="/start" element={<StartPage />} />
        <Route path="/auth/login" element={<CloudIdentityRoute />} />
        <Route
          element={
            <DesktopShell>
              <Outlet />
            </DesktopShell>
          }
        >
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/ideation" element={<IdeationPage />} />
          <Route path="/marketplace" element={<MarketplaceRoutePage />} />
          <Route path="/projects/:projectId" element={<WorkspacePage />} />
          <Route path="/projects/:projectId/search" element={<ProjectSearchPage />} />
          <Route path="/projects/:projectId/graph" element={<ProjectGraphRoutePage />} />
          <Route
            path="/projects/:projectId/extraction"
            element={<AuthoritativeExtractionRoutePage />}
          />
          <Route path="/projects/:projectId/materials" element={<ProjectMaterialsPage />} />
          <Route path="/projects/:projectId/outline" element={<StoryOutlinePage />} />
          <Route path="/projects/:projectId/story" element={<StoryGovernancePage />} />
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
          <Route path="/settings" element={<SettingsPage />} />
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
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Route>
      </Routes>
    </Suspense>
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

export function App({ factory, router = "hash", runtime }: AppProps) {
  return (
    <RuntimeProvider
      {...(factory === undefined ? {} : { factory })}
      {...(runtime === undefined ? {} : { runtime })}
    >
      <ToastProvider>
        <DesktopPersistenceBoundary>
          {router === "hash" ? <HashRoutedDesktop /> : <DesktopRoutes />}
        </DesktopPersistenceBoundary>
      </ToastProvider>
    </RuntimeProvider>
  );
}
