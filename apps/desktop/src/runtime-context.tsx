import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ErrorState, PageStateBoundary } from "@inkshadow/ui";

import { AppearancePreferenceProvider } from "./appearance-preference";
import type { DesktopRuntime } from "./infrastructure/runtime";
import { isUiErrorRetryable, projectOrdinaryUiError } from "./infrastructure/ui-error";

async function createDefaultDesktopRuntime(): Promise<DesktopRuntime> {
  const { createDesktopRuntime } = await import("./infrastructure/runtime");
  return createDesktopRuntime();
}

const RuntimeContext = createContext<DesktopRuntime | null>(null);

interface RuntimeBootstrap {
  readonly factory: () => Promise<DesktopRuntime>;
  readonly promise: Promise<DesktopRuntime>;
  consumers: number;
  runtime: DesktopRuntime | null;
  closeStarted: boolean;
}

export interface RuntimeProviderProps {
  readonly children: ReactNode;
  readonly runtime?: DesktopRuntime;
  readonly factory?: () => Promise<DesktopRuntime>;
}

export function RuntimeProvider({ children, factory, runtime }: RuntimeProviderProps) {
  return (
    <AppearancePreferenceProvider>
      <RuntimeProviderContent
        {...(factory === undefined ? {} : { factory })}
        {...(runtime === undefined ? {} : { runtime })}
      >
        {children}
      </RuntimeProviderContent>
    </AppearancePreferenceProvider>
  );
}

function RuntimeProviderContent({
  children,
  factory = createDefaultDesktopRuntime,
  runtime: providedRuntime,
}: RuntimeProviderProps) {
  const [runtime, setRuntime] = useState<DesktopRuntime | null>(providedRuntime ?? null);
  const [error, setError] = useState<unknown>(null);
  const bootstrapRef = useRef<RuntimeBootstrap | null>(null);

  useEffect(() => {
    if (providedRuntime !== undefined) {
      return;
    }

    let bootstrap = bootstrapRef.current;
    if (bootstrap?.factory !== factory) {
      bootstrap = {
        factory,
        promise: Promise.resolve().then(factory),
        consumers: 0,
        runtime: null,
        closeStarted: false,
      };
      bootstrapRef.current = bootstrap;
    }
    bootstrap.consumers += 1;
    const currentBootstrap = bootstrap;
    let active = true;

    const closeIfUnused = () => {
      if (
        currentBootstrap.consumers !== 0 ||
        currentBootstrap.runtime === null ||
        currentBootstrap.closeStarted
      ) {
        return;
      }
      currentBootstrap.closeStarted = true;
      if (bootstrapRef.current === currentBootstrap) {
        bootstrapRef.current = null;
      }
      void currentBootstrap.runtime.close();
    };

    void currentBootstrap.promise
      .then((value) => {
        currentBootstrap.runtime = value;
        if (active) {
          setRuntime(value);
        } else if (currentBootstrap.consumers === 0) {
          closeIfUnused();
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason);
        }
      });

    return () => {
      active = false;
      currentBootstrap.consumers -= 1;
      // React StrictMode intentionally tears down and recreates effects once.
      // Deferring release by one microtask lets that immediate replacement
      // reuse the same in-flight runtime instead of closing it underneath the
      // second bootstrap.
      queueMicrotask(closeIfUnused);
    };
  }, [factory, providedRuntime]);

  if (error !== null) {
    const normalized = projectOrdinaryUiError(error);
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
      <main className="desktop-bootstrap">
        <ErrorState title="无法启动墨影" description={normalized.description} {...actionProps} />
      </main>
    );
  }

  if (runtime === null) {
    return (
      <main className="desktop-bootstrap">
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
