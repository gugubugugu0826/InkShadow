import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppShell, Badge, Button, DropdownMenu, InkIcon, SaveStatus } from "@inkshadow/ui";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";

import { useAppearancePreference } from "../appearance-preference";
import {
  GENERATION_PREFLIGHT_CHANGED_EVENT,
  clearSafeGenerationPreflightScope,
  isGenerationPreflightEventForRuntime,
  readSafeGenerationPreflightForScope,
  type SafeGenerationPreflightDiagnostic,
} from "../infrastructure/generation-preflight-diagnostics";
import {
  MODEL_HUB_READINESS_CHANGED_EVENT,
  MODEL_HUB_READINESS_REFRESH_INTERVAL_MS,
  modelHubReadinessBlockerLabel,
  modelHubReadinessTaskLabel,
  projectModelHubReadiness,
} from "../infrastructure/model-hub-readiness";
import { useWritingExperience } from "../hooks/use-writing-experience";
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
    return "模型使用与费用";
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

function generationPreflightRepair(
  code: string,
  projectId: string | null,
): Readonly<{ href: string; guidance: string; linkAction: string }> {
  if (code === "PRIVATE_CHAPTER_LOCAL_ONLY") {
    return Object.freeze({
      href: "/settings#model-center",
      guidance:
        "当前章节保持仅限本地；如需 AI，请在当前章节明确调整隐私，或在模型中心配置并验证本地模型",
      linkAction: "打开模型中心配置本地模型",
    });
  }
  if (code === "MODEL_CONTEXT_WINDOW_EXHAUSTED" || code === "MODEL_HUB_CONTEXT_LIMIT_EXCEEDED") {
    return Object.freeze({
      href: "/settings#model-center",
      guidance: "请在当前续写设置中缩短输出或上下文，或在模型中心选择更长上下文的模型",
      linkAction: "打开模型中心检查模型窗口",
    });
  }
  if (code === "STORY_CONTEXT_COMPILATION_FAILED" && projectId !== null) {
    return Object.freeze({
      href: `/projects/${projectId}/context`,
      guidance: "请打开“本次参考”检查当前作品的正式设定和上下文预算",
      linkAction: "打开本次参考",
    });
  }
  return Object.freeze({
    href: "/settings#model-center",
    guidance: "请在模型中心的“连接与模型”中修复后重试",
    linkAction: "打开模型中心",
  });
}

export function DesktopShell({ children }: DesktopShellProps) {
  const runtime = useRuntime();
  const { resolvedSurface, setPreference: setAppearance } = useAppearancePreference();
  const location = useLocation();
  const navigate = useNavigate();
  const writingExperience = useWritingExperience();
  const [online, setOnline] = useState(navigator.onLine);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const directMode = writingExperience.preference?.mode !== "professional";
  const [aiReadiness, setAiReadiness] = useState(() =>
    projectModelHubReadiness({
      connections: [],
      catalog: [],
      routes: [],
      transientChecking: true,
    }),
  );
  const [scopedGenerationPreflight, setScopedGenerationPreflight] =
    useState<SafeGenerationPreflightDiagnostic | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const previousRouteRef = useRef<string | null>(null);
  const modelHubActive = location.pathname === "/settings" && location.hash === "#model-center";
  const settingsActive = location.pathname === "/settings" && !modelHubActive;
  const currentPageTitle = modelHubActive ? "模型中心" : pageTitle(location.pathname);
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
  const chapterId = /^\/projects\/[^/]+\/chapters\/([^/]+)/u.exec(location.pathname)?.[1] ?? null;
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
    const refresh = (): void => {
      if (projectId === null) {
        setScopedGenerationPreflight(null);
        return;
      }
      setScopedGenerationPreflight(
        readSafeGenerationPreflightForScope(runtime, { projectId, chapterId }),
      );
    };
    const handleChanged = (event: Event): void => {
      if (isGenerationPreflightEventForRuntime(event, runtime)) refresh();
    };
    window.addEventListener(GENERATION_PREFLIGHT_CHANGED_EVENT, handleChanged);
    refresh();
    return () => {
      window.removeEventListener(GENERATION_PREFLIGHT_CHANGED_EVENT, handleChanged);
    };
  }, [chapterId, projectId, runtime]);

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
    let refreshSequence = 0;
    const isActive = (): boolean => active;
    const refresh = async (showChecking: boolean): Promise<void> => {
      const sequence = refreshSequence + 1;
      refreshSequence = sequence;
      if (showChecking) {
        setAiReadiness((current) =>
          projectModelHubReadiness({
            connections: [],
            catalog: [],
            routes: [],
            transientChecking: true,
            loadFailed: current.state === "connection_failed",
          }),
        );
      }
      try {
        const { loadAuthoritativeModelHubReadiness } =
          await import("../infrastructure/model-hub-authoritative-readiness");
        const readiness = await loadAuthoritativeModelHubReadiness(runtime);
        if (!isActive() || sequence !== refreshSequence) return;
        setAiReadiness(readiness);
      } catch {
        if (active && sequence === refreshSequence) {
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
      clearSafeGenerationPreflightScope(runtime);
      setScopedGenerationPreflight(null);
      void refresh(true);
    };
    window.addEventListener(MODEL_HUB_READINESS_CHANGED_EVENT, handleChanged);
    const refreshTimer = window.setInterval(() => {
      void refresh(false);
    }, MODEL_HUB_READINESS_REFRESH_INTERVAL_MS);
    void refresh(true);
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      window.removeEventListener(MODEL_HUB_READINESS_CHANGED_EVENT, handleChanged);
    };
  }, [runtime]);

  useEffect(() => {
    if (directMode) {
      return;
    }
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
  }, [directMode]);

  useEffect(() => {
    document.title = directMode ? `${currentPageTitle} · 墨影` : `${currentPageTitle} · 墨影`;
  }, [currentPageTitle, directMode]);

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

  const scopedBlockerCode =
    scopedGenerationPreflight?.readiness === "BLOCKED"
      ? (scopedGenerationPreflight.blockerCodes[0] ?? "MODEL_HUB_PREFLIGHT_FAILED")
      : null;
  const scopedTaskLabel = modelHubReadinessTaskLabel(
    scopedGenerationPreflight?.taskType ?? "continuation",
  );
  const scopedRepair = generationPreflightRepair(
    scopedBlockerCode ?? "MODEL_HUB_PREFLIGHT_FAILED",
    projectId,
  );
  const aiStatusShortLabel =
    scopedBlockerCode === null ? aiReadiness.shortLabel : `当前${scopedTaskLabel}需修复`;
  const aiStatusDescription =
    scopedBlockerCode === null
      ? aiReadiness.description
      : `${scopedTaskLabel}受影响：${modelHubReadinessBlockerLabel(scopedBlockerCode)}。${scopedRepair.guidance}；正文、不可变版本和隔离建议均未改变。`;
  const aiStatusTone = scopedBlockerCode === null ? aiReadiness.tone : "warning";
  const currentAppearanceLabel = resolvedSurface === "dark" ? "深色" : "浅色";
  const nextAppearanceLabel = resolvedSurface === "dark" ? "浅色" : "深色";
  const appearanceSwitchLabel = `当前${currentAppearanceLabel}外观，切换到${nextAppearanceLabel}外观`;

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
          <span>墨影</span>
        </NavLink>
        <span className="desktop-topbar__context" aria-hidden="true">
          {currentPageTitle}
        </span>
      </div>
      {!directMode && (
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
      )}
      <div className="desktop-topbar__meta">
        {directMode ? (
          <DropdownMenu
            align="end"
            trigger={
              <span aria-hidden="true">
                <InkIcon name="more" decorative size={20} />
              </span>
            }
            triggerLabel="打开更多选项"
            menuLabel="更多选项"
            items={[
              {
                id: "settings",
                label: "设置",
                onSelect: () => void navigate("/settings"),
              },
              {
                id: "appearance",
                label: `外观：当前${currentAppearanceLabel}，切换到${nextAppearanceLabel}`,
                onSelect: () => setAppearance(resolvedSurface === "dark" ? "light" : "dark"),
              },
              {
                id: "professional-mode",
                label: "切换专业模式",
                disabled: writingExperience.preference === null || writingExperience.switching,
                separatorBefore: true,
                onSelect: () => {
                  setCommandPaletteOpen(false);
                  void writingExperience.switchMode("professional");
                },
              },
            ]}
          />
        ) : (
          <>
            <Link
              className="desktop-topbar__ai-status"
              to={scopedBlockerCode === null ? "/settings#model-center" : scopedRepair.href}
              aria-label={`${aiStatusDescription} ${scopedBlockerCode === null ? "打开模型中心" : scopedRepair.linkAction}`}
              title={aiStatusDescription}
            >
              <Badge tone={aiStatusTone}>{aiStatusShortLabel}</Badge>
            </Link>
            <Button
              variant="ghost"
              size="sm"
              aria-label={appearanceSwitchLabel}
              title={appearanceSwitchLabel}
              onClick={() => setAppearance(resolvedSurface === "dark" ? "light" : "dark")}
            >
              {currentAppearanceLabel}
            </Button>
          </>
        )}
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
      {writingExperience.preference !== null && (
        <div className="desktop-navigation__footer">
          <div className="desktop-navigation__section" aria-label="工具导航">
            {!directMode && (
              <NavLink
                className={({ isActive }) =>
                  `desktop-navigation__link${isActive ? " is-active" : ""}`
                }
                to="/tasks"
                aria-label="任务与通知"
                onClick={() => setNavigationOpen(false)}
              >
                <span className="desktop-navigation__marker" aria-hidden="true">
                  <InkIcon name="bell" decorative size={20} />
                </span>
                <span className="desktop-navigation__label">任务与通知</span>
              </NavLink>
            )}
            <NavLink
              className={({ isActive }) =>
                `desktop-navigation__link${isActive ? " is-active" : ""}`
              }
              to="/usage"
              aria-label="模型使用与费用"
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                <InkIcon name="clock" decorative size={20} />
              </span>
              <span className="desktop-navigation__label">模型使用与费用</span>
            </NavLink>
            <Link
              className={`desktop-navigation__link${modelHubActive ? " is-active" : ""}`}
              to="/settings#model-center"
              aria-label="模型中心"
              aria-current={modelHubActive ? "page" : undefined}
              onClick={() => setNavigationOpen(false)}
            >
              <span className="desktop-navigation__marker" aria-hidden="true">
                <InkIcon name="sparkles" decorative size={20} />
              </span>
              <span className="desktop-navigation__label">模型中心</span>
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
      )}
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
        statusBar={directMode ? undefined : statusBar}
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
      {!directMode && (
        <CommandPalette
          open={commandPaletteOpen}
          onOpenChange={setCommandPaletteOpen}
          projectId={projectId}
        />
      )}
    </>
  );
}
