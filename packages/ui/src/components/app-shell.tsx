import { useId, type HTMLAttributes, type ReactNode } from "react";

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
  inspectorOpen?: boolean;
};

export function AppShell({
  children,
  className,
  inspector,
  inspectorLabel = "检查器",
  inspectorOpen = false,
  mainLabel = "主要内容",
  navigation,
  navigationCollapsed = false,
  navigationLabel = "主导航",
  navigationOpen = false,
  skipLinkLabel = "跳到主要内容",
  statusBar,
  topBar,
  ...props
}: AppShellProps): ReactNode {
  const mainId = `ink-main-${useId()}`;

  return (
    <div
      {...props}
      className={cn("ink-app-shell", className)}
      data-navigation-collapsed={navigationCollapsed || undefined}
      data-navigation-open={navigationOpen || undefined}
      data-inspector-open={inspectorOpen || undefined}
    >
      <a className="ink-app-shell__skip-link" href={`#${mainId}`}>
        {skipLinkLabel}
      </a>
      <header className="ink-app-shell__topbar">{topBar}</header>
      <nav className="ink-app-shell__navigation" aria-label={navigationLabel}>
        {navigation}
      </nav>
      <main id={mainId} className="ink-app-shell__main" aria-label={mainLabel} tabIndex={-1}>
        {children}
      </main>
      {inspector !== undefined && (
        <aside className="ink-app-shell__inspector" aria-label={inspectorLabel}>
          {inspector}
        </aside>
      )}
      {statusBar !== undefined && <footer className="ink-app-shell__statusbar">{statusBar}</footer>}
    </div>
  );
}
