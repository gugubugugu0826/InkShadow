import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppShell, Badge, Button, InkIcon, SaveStatus } from "@inkshadow/ui";
import { Link, NavLink, useLocation } from "react-router-dom";

import { useAppearancePreference } from "../appearance-preference";
import { NOVEL_AI_TASKS } from "../infrastructure/model-hub-provider-registry";
import {
  MODEL_HUB_READINESS_CHANGED_EVENT,
  projectModelHubReadiness,
} from "../infrastructure/model-hub-readiness";
import { useRuntime } from "../runtime-context";
import { CommandPalette } from "./command-palette";

export interface DesktopShellProps {
  readonly children: ReactNode;
}

function pageTitle(pathname: string): string {
  if (pathname === "/start") {
    return "创作首页";
  }
  if (pathname === "/ideation") {
    return "从一个想法开始";
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
  if (pathname.startsWith("/teams/") && pathname.endsWith("/reviews")) {
    return "团队内容审阅";
  }
  if (pathname === "/settings/sync") {
    return "同步安全";
  }
  if (pathname.endsWith("/sync/conflicts")) {
    return "处理同步冲突";
  }
  if (pathname.endsWith("/sync")) {
    return "备份与同步";
  }
  if (pathname.startsWith("/settings")) {
    return "设置";
  }
  if (pathname === "/tasks") {
    return "任务与通知";
  }
  if (pathname === "/usage") {
    return "调用与费用";
  }
  if (pathname.endsWith("/multi-agent-review")) {
    return "深度审稿";
  }
  if (pathname.endsWith("/fine-tuning")) {
    return "AI 优化记录";
  }
  if (pathname.endsWith("/extensions")) {
    return "更多创作工具";
  }
  if (pathname.includes("/chapters/")) {
    return "正文";
  }
  if (pathname.endsWith("/context")) {
    return "本次参考";
  }
  if (pathname.endsWith("/checks")) {
    return "检查";
  }
  if (pathname.endsWith("/outline")) {
    return "规划";
  }
  if (pathname.endsWith("/materials")) {
    return "创作资料";
  }
  if (pathname.endsWith("/story")) {
    return "设定";
  }
  if (pathname.endsWith("/extraction")) {
    return "从正文更新设定";
  }
  if (pathname.endsWith("/graph")) {
    return "故事关联";
  }
  if (pathname.endsWith("/search")) {
    return "内容查找";
  }
  if (/^\/projects\/[^/]+$/u.test(pathname)) {
    return "正文";
  }
  if (pathname === "/projects") {
    return "作品库";
  }
  return "页面不存在";
}

export function DesktopShell({ children }: DesktopShellProps) {
  const runtime = useRuntime();
  const { resolvedSurface, setPreference: setAppearance } = useAppearancePreference();
  const location = useLocation();
  const [online, setOnline] = useState(navigator.onLine);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [aiReadiness, setAiReadiness] = useState(() =>
    projectModelHubReadiness({
      connections: [],
      catalog: [],
      routes: [],
      transientChecking: true,
    }),
  );
  const mainRef = useRef<HTMLElement>(null);
  const previousRouteRef = useRef<string | null>(null);
  const modelHubActive = location.pathname === "/settings" && location.hash === "#model-center";
  const settingsActive = location.pathname === "/settings" && !modelHubActive;
  const currentPageTitle = modelHubActive ? "Model Hub" : pageTitle(location.pathname);
  // Hash navigation is owned by the destination page so that an in-page
  // anchor can keep focus. Only full route changes should refocus the page h1.
  const routeIdentity = `${location.pathname}${location.search}`;
  const closeNavigation = useCallback(() => {
    setNavigationOpen(false);
  }, []);
  const setMainElement = useCallback((element: HTMLElement | null) => {
    mainRef.current = element;
  }, []);
  const projectId = /^\/projects\/([^/]+)/u.exec(location.pathname)?.[1] ?? null;
  const bodyAreaActive =
    projectId !== null &&
    /^\/projects\/[^/]+(?:\/context|\/chapters\/[^/]+(?:\/extensions|\/multi-agent-review)?)?$/u.test(
      location.pathname,
    );
  const checksAreaActive =
    projectId !== null &&
    /^\/projects\/[^/]+\/(?:checks|search|graph|extraction|materials|multi-agent-review|fine-tuning|sync(?:\/conflicts)?)$/u.test(
      location.pathname,
    );

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

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      setAiReadiness((current) =>
        projectModelHubReadiness({
          connections: [],
          catalog: [],
          routes: [],
          transientChecking: true,
          loadFailed: current.state === "connection_failed",
        }),
      );
      try {
        const connections = await runtime.modelHub.listConnections();
        const [catalog, routes] = await Promise.all([
          Promise.all(connections.map(({ id }) => runtime.modelHub.listCatalog(id))).then((rows) =>
            rows.flat(),
          ),
          Promise.all(NOVEL_AI_TASKS.map((task) => runtime.modelHub.findTaskRoute(task))).then(
            (rows) => rows.filter((route) => route !== null),
          ),
        ]);
        if (active) {
          setAiReadiness(projectModelHubReadiness({ connections, catalog, routes }));
        }
      } catch {
        if (active) {
          setAiReadiness(
            projectModelHubReadiness({
              connections: [],
              catalog: [],
              routes: [],
              loadFailed: true,
            }),
          );
        }
      }
    };
    const handleChanged = (): void => {
      void refresh();
    };
    window.addEventListener(MODEL_HUB_READINESS_CHANGED_EVENT, handleChanged);
    void refresh();
    return () => {
      active = false;
      window.removeEventListener(MODEL_HUB_READINESS_CHANGED_EVENT, handleChanged);
    };
  }, [runtime]);

  useEffect(() => {
    const handleCommandShortcut = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", handleCommandShortcut);
    return () => {
      document.removeEventListener("keydown", handleCommandShortcut);
    };
  }, []);

  useEffect(() => {
    document.title = `${currentPageTitle} · InkShadow 墨影`;
  }, [currentPageTitle]);

  useEffect(() => {
    if (previousRouteRef.current === null) {
      previousRouteRef.current = routeIdentity;
      return;
    }
    if (previousRouteRef.current === routeIdentity) {
      return;
    }
    previousRouteRef.current = routeIdentity;

    const main = mainRef.current;
    if (main === null) {
      return;
    }

    let focused = false;
    const focusRouteHeading = (): void => {
      const heading = main.querySelector<HTMLElement>('h1, [role="heading"][aria-level="1"]');
      if (heading === null) {
        return;
      }
      if (!heading.hasAttribute("tabindex")) {
        heading.tabIndex = -1;
      }
      heading.focus();
      focused = true;
      observer.disconnect();
    };
    const observer = new MutationObserver(focusRouteHeading);
    observer.observe(main, { childList: true, subtree: true });
    const frame = window.requestAnimationFrame(focusRouteHeading);
    const fallback = window.setTimeout(() => {
      if (!focused) {
        main.focus();
      }
      observer.disconnect();
    }, 1_000);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
    };
  }, [routeIdentity]);

  const topBar = (
    <div className="desktop-topbar">
      <div className="desktop-topbar__leading">
        <Button
          className="desktop-nav-toggle"
          variant="ghost"
          size="sm"
          aria-expanded={navigationOpen}
          aria-controls="desktop-primary-navigation"
          onClick={() => setNavigationOpen((current) => !current)}
        >
          <InkIcon name="more" decorative size={20} />
          <span className="desktop-navigation__label">导航</span>
        </Button>
        <Button
          className="desktop-nav-collapse"
          variant="ghost"
          size="sm"
          aria-pressed={navigationCollapsed}
          onClick={() => setNavigationCollapsed((current) => !current)}
        >
          <InkIcon
            name="chevron-right"
            decorative
            size={20}
            className={navigationCollapsed ? undefined : "desktop-icon--flip"}
          />
          <span className="sr-only">{navigationCollapsed ? "展开侧栏" : "收起侧栏"}</span>
        </Button>
        <NavLink
          className="desktop-brand"
          to="/start"
          aria-label="墨影开始创作"
          onClick={() => setNavigationOpen(false)}
        >
          <span className="desktop-brand__mark" aria-hidden="true">
            <InkIcon name="pen" decorative size={18} />
          </span>
          <span>InkShadow 墨影</span>
        </NavLink>
        <span className="desktop-topbar__context" aria-hidden="true">
          {currentPageTitle}
        </span>
      </div>
      <button
        type="button"
        className="desktop-topbar__command"
        aria-label="搜索页面与命令"
        aria-haspopup="dialog"
        onClick={() => setCommandPaletteOpen(true)}
      >
        <span className="desktop-topbar__command-label">
          <InkIcon name="search" decorative size={18} />
          <span>搜索页面与命令</span>
        </span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="desktop-topbar__meta">
        <Link
          className="desktop-topbar__ai-status"
          to="/settings#model-center"
          aria-label={`${aiReadiness.shortLabel}，打开 Model Hub`}
        >
          <Badge tone={aiReadiness.tone}>{aiReadiness.shortLabel}</Badge>
        </Link>
        <Button
          variant="ghost"
          size="sm"
          aria-label={resolvedSurface === "dark" ? "切换到浅色外观" : "切换到深色外观"}
          onClick={() => setAppearance(resolvedSurface === "dark" ? "light" : "dark")}
        >
          {resolvedSurface === "dark" ? "浅色" : "深色"}
        </Button>
      </div>
    </div>
  );

  const navigation = (
    <div className="desktop-navigation">
      <div className="desktop-navigation__body">
        <div className="desktop-navigation__section" aria-label="全局导航">
          <NavLink
            className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
            to="/start"
            aria-label="创作首页"
            onClick={() => setNavigationOpen(false)}
          >
            <span className="desktop-navigation__marker" aria-hidden="true">
              <InkIcon name="home" decorative size={20} />
            </span>
            <span className="desktop-navigation__label">创作首页</span>
          </NavLink>
          <NavLink
            end
            className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
            to="/projects"
            aria-label="作品库"
            onClick={() => setNavigationOpen(false)}
          >
            <span className="desktop-navigation__marker" aria-hidden="true">
              <InkIcon name="library" decorative size={20} />
            </span>
            <span className="desktop-navigation__label">作品库</span>
          </NavLink>
        </div>
        {projectId !== null && (
          <div className="desktop-navigation__section" role="group" aria-label="当前项目">
            <Link
              className={`desktop-navigation__link${bodyAreaActive ? " is-active" : ""}`}
              to={`/projects/${projectId}`}
              aria-label="正文"
              aria-current={bodyAreaActive ? "page" : undefined}
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                <InkIcon name="file-text" decorative size={20} />
              </span>
              <span className="desktop-navigation__label">正文</span>
            </Link>
            <NavLink
              className={({ isActive }) =>
                `desktop-navigation__link${isActive ? " is-active" : ""}`
              }
              to={`/projects/${projectId}/outline`}
              aria-label="规划"
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                <InkIcon name="pen" decorative size={20} />
              </span>
              <span className="desktop-navigation__label">规划</span>
            </NavLink>
            <NavLink
              className={({ isActive }) =>
                `desktop-navigation__link${isActive ? " is-active" : ""}`
              }
              to={`/projects/${projectId}/story`}
              aria-label="设定"
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                <InkIcon name="user" decorative size={20} />
              </span>
              <span className="desktop-navigation__label">设定</span>
            </NavLink>
            <Link
              className={`desktop-navigation__link${checksAreaActive ? " is-active" : ""}`}
              to={`/projects/${projectId}/checks`}
              aria-label="检查"
              aria-current={checksAreaActive ? "page" : undefined}
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                <InkIcon name="shield" decorative size={20} />
              </span>
              <span className="desktop-navigation__label">检查</span>
            </Link>
          </div>
        )}
      </div>
      <div className="desktop-navigation__footer">
        <div className="desktop-navigation__section" aria-label="工具导航">
          <NavLink
            className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
            to="/tasks"
            aria-label="任务与通知"
            onClick={() => setNavigationOpen(false)}
          >
            <span className="desktop-navigation__marker" aria-hidden="true">
              <InkIcon name="bell" decorative size={20} />
            </span>
            <span className="desktop-navigation__label">任务与通知</span>
          </NavLink>
          <NavLink
            className={({ isActive }) => `desktop-navigation__link${isActive ? " is-active" : ""}`}
            to="/usage"
            aria-label="调用与费用"
            onClick={() => setNavigationOpen(false)}
          >
            <span className="desktop-navigation__marker" aria-hidden="true">
              <InkIcon name="clock" decorative size={20} />
            </span>
            <span className="desktop-navigation__label">调用与费用</span>
          </NavLink>
          <Link
            className={`desktop-navigation__link${modelHubActive ? " is-active" : ""}`}
            to="/settings#model-center"
            aria-label="Model Hub"
            aria-current={modelHubActive ? "page" : undefined}
            onClick={() => setNavigationOpen(false)}
          >
            <span className="desktop-navigation__marker" aria-hidden="true">
              <InkIcon name="sparkles" decorative size={20} />
            </span>
            <span className="desktop-navigation__label">Model Hub</span>
          </Link>
          <Link
            className={`desktop-navigation__link${settingsActive ? " is-active" : ""}`}
            to="/settings"
            aria-label="设置"
            aria-current={settingsActive ? "page" : undefined}
            onClick={() => setNavigationOpen(false)}
          >
            <span className="desktop-navigation__marker" aria-hidden="true">
              <InkIcon name="settings" decorative size={20} />
            </span>
            <span className="desktop-navigation__label">设置</span>
          </Link>
        </div>
      </div>
    </div>
  );

  const statusBar = (
    <div className="desktop-statusbar">
      <span role="status" aria-live="polite" aria-atomic="true">
        {online ? "网络可用" : "离线，本地编辑仍可用"}
      </span>
      <span aria-hidden="true">·</span>
      <SaveStatus state="saved_local" labels={{ saved_local: "本地数据" }} />
    </div>
  );

  return (
    <>
      <AppShell
        topBar={topBar}
        navigation={navigation}
        navigationCollapsed={navigationCollapsed}
        statusBar={statusBar}
        navigationOpen={navigationOpen}
        navigationId="desktop-primary-navigation"
        navigationLabel="墨影主导航"
        mainLabel={currentPageTitle}
        mainRef={setMainElement}
        onNavigationDismiss={closeNavigation}
      >
        {runtime.mode === "browser-development" && (
          <div className="development-banner" role="status">
            仅开发环境：当前数据只保存在此浏览器中，不代表桌面正式版的持久化能力。
          </div>
        )}
        {children}
      </AppShell>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        projectId={projectId}
      />
    </>
  );
}
