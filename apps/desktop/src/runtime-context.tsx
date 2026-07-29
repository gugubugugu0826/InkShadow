import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ErrorState, PageStateBoundary } from "@inkshadow/ui";

import type { DesktopRuntime } from "./infrastructure/runtime";
import { isUiErrorRetryable, normalizeUiError } from "./infrastructure/ui-error";

async function createDefaultDesktopRuntime(): Promise<DesktopRuntime> {
  const { createDesktopRuntime } = await import("./infrastructure/runtime");
  return createDesktopRuntime();
}

const RuntimeContext = createContext<DesktopRuntime | null>(null);

export interface RuntimeProviderProps {
  readonly children: ReactNode;
  readonly runtime?: DesktopRuntime;
  readonly factory?: () => Promise<DesktopRuntime>;
}

export function RuntimeProvider({
  children,
  factory = createDefaultDesktopRuntime,
  runtime: providedRuntime,
}: RuntimeProviderProps) {
  const [runtime, setRuntime] = useState<DesktopRuntime | null>(providedRuntime ?? null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (providedRuntime !== undefined) {
      return;
    }

    let active = true;
    let createdRuntime: DesktopRuntime | null = null;
    void factory()
      .then((value) => {
        createdRuntime = value;
        if (active) {
          setRuntime(value);
        } else {
          void value.close();
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason);
        }
      });

    return () => {
      active = false;
      if (createdRuntime !== null) {
        void createdRuntime.close();
      }
    };
  }, [factory, providedRuntime]);

  if (error !== null) {
    const normalized = normalizeUiError(error);
    const actionProps = isUiErrorRetryable(error)
      ? {
          primaryAction: {
            label: "重新加载",
            onClick: () => {
              window.location.reload();
            },
          },
        }
      : {};
    return (
      <main className="desktop-bootstrap" data-surface="dark">
        <ErrorState
          title="无法启动墨影"
          description={normalized.description}
          errorCode={normalized.code}
          {...actionProps}
        />
      </main>
    );
  }

  if (runtime === null) {
    return (
      <main className="desktop-bootstrap" data-surface="dark">
        <PageStateBoundary state="loading" loadingLabel="正在打开本地工作区">
          <span />
        </PageStateBoundary>
      </main>
    );
  }

  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

// This module intentionally exports the provider and its paired consumer hook.
// eslint-disable-next-line react-refresh/only-export-components
export function useRuntime(): DesktopRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) {
    throw new Error("useRuntime must be used inside RuntimeProvider.");
  }
  return runtime;
}
