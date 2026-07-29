import { useEffect, useState, type ReactNode } from "react";
import { AppShell, Badge, Button, SaveStatus } from "@inkshadow/ui";
import { NavLink, useLocation } from "react-router-dom";

import { useRuntime } from "../runtime-context";

export interface DesktopShellProps {
  readonly children: ReactNode;
}

function pageTitle(pathname: string): string {
  if (pathname === "/ideation") {
    return "开书与构思";
  }
  if (pathname === "/marketplace") {
    return "社区模板";
  }
  if (pathname === "/teams") {
    return "团队与权限";
  }
  if (pathname.startsWith("/teams/") && pathname.endsWith("/usage")) {
    return "AI 额度与用量";
  }
  if (pathname.startsWith("/teams/") && pathname.endsWith("/templates")) {
    return "加密团队模板";
  }
  if (pathname === "/settings/sync") {
    return "同步安全";
  }
  if (pathname.endsWith("/sync/conflicts")) {
    return "同步冲突处理";
  }
  if (pathname.endsWith("/sync")) {
    return "项目同步";
  }
  if (pathname.startsWith("/settings")) {
    return "设置";
  }
  if (pathname === "/tasks") {
    return "任务与通知";
  }
  if (pathname.endsWith("/multi-agent-review")) {
    return "多 Agent 审查";
  }
  if (pathname.endsWith("/fine-tuning")) {
    return "微调治理";
  }
  if (pathname.endsWith("/extensions")) {
    return "翻译与短剧";
  }
  if (pathname.includes("/chapters/")) {
    return "写作编辑器";
  }
  if (pathname.endsWith("/outline")) {
    return "故事大纲";
  }
  if (pathname.endsWith("/story")) {
    return "故事治理";
  }
  if (pathname.endsWith("/extraction")) {
    return "权威事实抽取";
  }
  if (pathname.endsWith("/graph")) {
    return "故事关系图";
  }
  if (pathname.endsWith("/search")) {
    return "项目搜索";
  }
  if (/^\/projects\/[^/]+$/u.test(pathname)) {
    return "项目工作区";
  }
  return "项目";
}

export function DesktopShell({ children }: DesktopShellProps) {
  const runtime = useRuntime();
  const location = useLocation();
  const [online, setOnline] = useState(navigator.onLine);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const projectId = /^\/projects\/([^/]+)/u.exec(location.pathname)?.[1] ?? null;
  const chapterId = /^\/projects\/[^/]+\/chapters\/([^/]+)/u.exec(location.pathname)?.[1] ?? null;
  const teamProjectScope = /^\/teams\/([^/]+)\/projects\/([^/]+)/u.exec(location.pathname) ?? null;
  const teamProjectTeamId = teamProjectScope?.[1] ?? null;
  const teamProjectId = teamProjectScope?.[2] ?? null;

  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const topBar = (
    <div className="desktop-topbar">
      <Button
        className="desktop-nav-toggle"
        variant="ghost"
        size="sm"
        aria-expanded={navigationOpen}
        onClick={() => setNavigationOpen((current) => !current)}
      >
        导航
      </Button>
      <NavLink
        className="desktop-brand"
        to="/projects"
        aria-label="墨影项目首页"
        onClick={() => setNavigationOpen(false)}
      >
        <span className="desktop-brand__mark" aria-hidden="true">
          墨
        </span>
        <span>InkShadow 墨影</span>
      </NavLink>
      <strong className="desktop-topbar__title">{pageTitle(location.pathname)}</strong>
      <div className="desktop-topbar__meta">
        <Badge tone={runtime.mode === "tauri" ? "success" : "warning"}>
          {runtime.mode === "tauri" ? "桌面本地数据库" : "浏览器开发模式"}
        </Badge>
      </div>
    </div>
  );

  const navigation = (
    <div className="desktop-navigation">
      <div className="desktop-navigation__section" aria-label="工作区">
        <NavLink
          className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
          to="/projects"
          onClick={() => setNavigationOpen(false)}
        >
          <span className="desktop-navigation__marker" aria-hidden="true">
            项
          </span>
          <span className="desktop-navigation__label">项目</span>
        </NavLink>
        <NavLink
          className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
          to="/marketplace"
          onClick={() => setNavigationOpen(false)}
        >
          <span className="desktop-navigation__marker" aria-hidden="true">
            市
          </span>
          <span className="desktop-navigation__label">社区模板</span>
        </NavLink>
        <NavLink
          className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
          to="/ideation"
          onClick={() => setNavigationOpen(false)}
        >
          <span className="desktop-navigation__marker" aria-hidden="true">
            构
          </span>
          <span className="desktop-navigation__label">开书与构思</span>
        </NavLink>
        <NavLink
          className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
          to="/tasks"
          onClick={() => setNavigationOpen(false)}
        >
          <span className="desktop-navigation__marker" aria-hidden="true">
            任
          </span>
          <span className="desktop-navigation__label">任务与通知</span>
        </NavLink>
        {runtime.featureFlags.multiAgent &&
          runtime.multiAgentReview !== null &&
          projectId !== null && (
            <NavLink
              className={({ isActive }) =>
                `desktop-navigation__link${isActive ? " is-active" : ""}`
              }
              to={`/projects/${projectId}/multi-agent-review`}
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                群
              </span>
              <span className="desktop-navigation__label">多 Agent 审查</span>
            </NavLink>
          )}
        {runtime.featureFlags.authoritativeExtraction &&
          runtime.authoritativeExtraction !== null &&
          projectId !== null && (
            <NavLink
              className={({ isActive }) =>
                `desktop-navigation__link${isActive ? " is-active" : ""}`
              }
              to={`/projects/${projectId}/extraction`}
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                抽
              </span>
              <span className="desktop-navigation__label">权威事实抽取</span>
            </NavLink>
          )}
        {runtime.featureFlags.fineTuning &&
          runtime.fineTuningGovernance?.availability.available === true &&
          projectId !== null && (
            <NavLink
              className={({ isActive }) =>
                `desktop-navigation__link${isActive ? " is-active" : ""}`
              }
              to={`/projects/${projectId}/fine-tuning`}
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                调
              </span>
              <span className="desktop-navigation__label">微调治理</span>
            </NavLink>
          )}
        {runtime.governedCreativeExtensions !== null &&
          projectId !== null &&
          chapterId !== null && (
            <NavLink
              className={({ isActive }) =>
                `desktop-navigation__link${isActive ? " is-active" : ""}`
              }
              to={`/projects/${projectId}/chapters/${chapterId}/extensions`}
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                扩
              </span>
              <span className="desktop-navigation__label">翻译与短剧</span>
            </NavLink>
          )}
        {runtime.cloudSyncControl !== null && projectId !== null && (
          <NavLink
            className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
            to={`/projects/${projectId}/sync`}
            onClick={() => setNavigationOpen(false)}
          >
            <span className="desktop-navigation__marker" aria-hidden="true">
              同
            </span>
            <span className="desktop-navigation__label">项目同步</span>
          </NavLink>
        )}
        {runtime.featureFlags.teamCollaboration && (
          <NavLink
            className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
            to="/teams"
            onClick={() => setNavigationOpen(false)}
          >
            <span className="desktop-navigation__marker" aria-hidden="true">
              团
            </span>
            <span className="desktop-navigation__label">团队与权限</span>
          </NavLink>
        )}
        {runtime.studioTeamTemplates !== null &&
          teamProjectTeamId !== null &&
          teamProjectId !== null && (
            <NavLink
              className={({ isActive }) =>
                `desktop-navigation__link${isActive ? " is-active" : ""}`
              }
              to={`/teams/${teamProjectTeamId}/projects/${teamProjectId}/templates`}
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                模
              </span>
              <span className="desktop-navigation__label">加密团队模板</span>
            </NavLink>
          )}
        <NavLink
          className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
          to="/settings"
          onClick={() => setNavigationOpen(false)}
        >
          <span className="desktop-navigation__marker" aria-hidden="true">
            设
          </span>
          <span className="desktop-navigation__label">设置</span>
        </NavLink>
      </div>
      <div className="desktop-navigation__privacy">
        <strong>本地优先</strong>
        <span>正文默认保留在当前设备。</span>
      </div>
    </div>
  );

  const statusBar = (
    <div className="desktop-statusbar">
      <span>{online ? "网络可用" : "离线，本地编辑仍可用"}</span>
      <span aria-hidden="true">·</span>
      <SaveStatus state="saved_local" labels={{ saved_local: "本地数据" }} />
    </div>
  );

  return (
    <AppShell
      topBar={topBar}
      navigation={navigation}
      statusBar={statusBar}
      navigationOpen={navigationOpen}
      navigationLabel="墨影主导航"
      mainLabel={pageTitle(location.pathname)}
    >
      {runtime.mode === "browser-development" && (
        <div className="development-banner" role="status">
          Development-only：当前数据保存在浏览器 localStorage，不代表桌面生产持久化。
        </div>
      )}
      {children}
    </AppShell>
  );
}
