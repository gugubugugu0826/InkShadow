import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";

export type AppShellProps = HTMLAttributes<HTMLDivElement> & {
  topBar: ReactNode;
  navigation: ReactNode;
  children: ReactNode;
  inspector?: ReactNode;
  statusBar?: ReactNode;
  navigationLabel?: string;
  mainLabel?: string;
  inspectorLabel?: string;
  skipLinkLabel?: string;
  navigationCollapsed?: boolean;
  navigationOpen?: boolean;
  navigationId?: string;
  navigationDismissLabel?: string;
  onNavigationDismiss?: () => void;
  inspectorOpen?: boolean;
  mainRef?: (element: HTMLElement | null) => void;
};

const narrowNavigationQuery = "(max-width: 59.9375rem)";
const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}

function getNarrowNavigationMedia(): MediaQueryList | null {
  const matchMedia: unknown = Reflect.get(globalThis, "matchMedia");
  return typeof matchMedia === "function"
    ? (Reflect.apply(matchMedia, globalThis, [narrowNavigationQuery]) as MediaQueryList)
    : null;
}

function useNarrowNavigation(): boolean {
  const [narrow, setNarrow] = useState(() => getNarrowNavigationMedia()?.matches ?? false);

  useEffect(() => {
    const media = getNarrowNavigationMedia();
    if (media === null) {
      return;
    }
    const update = (): void => {
      setNarrow(media.matches);
    };
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
    };
  }, []);

  return narrow;
}

export function AppShell({
  children,
  className,
  inspector,
  inspectorLabel = "检查器",
  inspectorOpen = false,
  mainLabel = "主要内容",
  mainRef: providedMainRef,
  navigation,
  navigationCollapsed = false,
  navigationDismissLabel = "关闭主导航",
  navigationId: providedNavigationId,
  navigationLabel = "主导航",
  navigationOpen = false,
  onNavigationDismiss,
  skipLinkLabel = "跳到主要内容",
  statusBar,
  topBar,
  ...props
}: AppShellProps): ReactNode {
  const mainId = `ink-main-${useId()}`;
  const generatedNavigationId = `ink-navigation-${useId()}`;
  const navigationId = providedNavigationId ?? generatedNavigationId;
  const navigationRef = useRef<HTMLElement>(null);
  const internalMainRef = useRef<HTMLElement>(null);
  const topBarRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const statusBarRef = useRef<HTMLElement>(null);
  const narrowNavigation = useNarrowNavigation();
  const drawerActive = narrowNavigation && navigationOpen;

  useEffect(() => {
    if (!drawerActive) {
      return;
    }

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backgroundElements = [
      topBarRef.current,
      internalMainRef.current,
      inspectorRef.current,
      statusBarRef.current,
    ].filter((element): element is HTMLElement => element !== null);
    const backgroundState = backgroundElements.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    backgroundElements.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });

    const focusFrame = window.requestAnimationFrame(() => {
      const panel = navigationRef.current;
      (panel === null ? undefined : (focusableElements(panel)[0] ?? panel))?.focus();
    });

    function handleKeyDown(event: KeyboardEvent): void {
      const panel = navigationRef.current;
      if (panel === null) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onNavigationDismiss?.();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = focusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      backgroundState.forEach(({ ariaHidden, element, inert }) => {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", ariaHidden);
        }
      });
      previouslyFocused?.focus();
    };
  }, [drawerActive, onNavigationDismiss]);

  const setMainRef = (element: HTMLElement | null): void => {
    internalMainRef.current = element;
    providedMainRef?.(element);
  };

  return (
    <div
      {...props}
      className={cn("ink-app-shell", className)}
      data-navigation-collapsed={navigationCollapsed || undefined}
      data-navigation-open={navigationOpen || undefined}
      data-inspector-present={inspector !== undefined || undefined}
      data-inspector-open={inspectorOpen || undefined}
    >
      <a className="ink-app-shell__skip-link" href={`#${mainId}`}>
        {skipLinkLabel}
      </a>
      <header ref={topBarRef} className="ink-app-shell__topbar">
        {topBar}
      </header>
      <nav
        ref={navigationRef}
        id={navigationId}
        className="ink-app-shell__navigation"
        aria-label={navigationLabel}
        data-drawer-active={drawerActive || undefined}
        tabIndex={drawerActive ? -1 : undefined}
      >
        {navigation}
      </nav>
      {navigationOpen && (
        <button
          type="button"
          className="ink-app-shell__backdrop"
          aria-label={navigationDismissLabel}
          tabIndex={-1}
          onClick={onNavigationDismiss}
        />
      )}
      <main
        ref={setMainRef}
        id={mainId}
        className="ink-app-shell__main"
        aria-label={mainLabel}
        tabIndex={-1}
      >
        {children}
      </main>
      {inspector !== undefined && (
        <aside ref={inspectorRef} className="ink-app-shell__inspector" aria-label={inspectorLabel}>
          {inspector}
        </aside>
      )}
      {statusBar !== undefined && (
        <footer ref={statusBarRef} className="ink-app-shell__statusbar">
          {statusBar}
        </footer>
      )}
    </div>
  );
}
