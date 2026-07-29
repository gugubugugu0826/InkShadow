import { useToast } from "@inkshadow/ui";
import { useBlocker } from "react-router-dom";
import { useEffect, useRef, type ReactNode } from "react";

import {
  DesktopCloseCoordinator,
  type PersistentLifecycleNotice,
} from "../infrastructure/desktop-close-coordinator";
import {
  desktopPersistenceLifecycle,
  type PersistenceFlushOutcome,
} from "../infrastructure/persistence-lifecycle";
import { useRuntime } from "../runtime-context";

const ROUTE_FLUSH_TIMEOUT_MS = 8_000;

export function DesktopPersistenceBoundary({ children }: { readonly children: ReactNode }) {
  const runtime = useRuntime();
  const { toast } = useToast();
  const closeListenerActiveRef = useRef<boolean>(false);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!desktopPersistenceLifecycle.hasPendingWork()) {
        return;
      }
      event.preventDefault();
      Reflect.set(event, "returnValue", "");
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    if (runtime.mode !== "tauri") {
      return;
    }

    closeListenerActiveRef.current = true;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (isListenerInactive(closeListenerActiveRef)) {
          return;
        }
        const appWindow = getCurrentWindow();
        const coordinator = new DesktopCloseCoordinator({
          persistence: desktopPersistenceLifecycle,
          closeRuntime: () => runtime.close(),
          destroyWindow: () => appWindow.destroy(),
          reportPersistentNotice: (notice) => showPersistentNotice(toast, notice),
        });
        const stopListening = await appWindow.onCloseRequested((event) => {
          // Tauri requires this to happen synchronously in the callback. The
          // coordinator destroys the window only after every bounded gate.
          event.preventDefault();
          void coordinator.requestClose();
        });
        unlisten = stopListening;
        if (isListenerInactive(closeListenerActiveRef)) {
          stopListening();
          unlisten = null;
        }
      })
      .catch((cause: unknown) => {
        showPersistentNotice(toast, {
          code: "RUNTIME_CLOSE_FAILED",
          title: "关闭保护未能启动",
          description: "请保持应用打开并重试；在关闭保护恢复前不要强制结束进程。",
          cause,
        });
      });

    return () => {
      closeListenerActiveRef.current = false;
      unlisten?.();
    };
  }, [runtime, toast]);

  return children;
}

function isListenerInactive(activeRef: Readonly<{ current: boolean }>): boolean {
  return !activeRef.current;
}

/**
 * Must be rendered inside a React Router data router. Declarative HashRouter
 * does not expose the blocker state machine required for an asynchronous,
 * fail-closed route transition.
 */
export function PersistenceRouteBoundary({ children }: { readonly children: ReactNode }) {
  const { toast } = useToast();
  const processingRef = useRef<Promise<void> | null>(null);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      desktopPersistenceLifecycle.hasPendingWork() &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  );

  useEffect(() => {
    if (blocker.state !== "blocked" || processingRef.current !== null) {
      return;
    }

    const cycle = desktopPersistenceLifecycle
      .flush("route-change", ROUTE_FLUSH_TIMEOUT_MS)
      .then((outcome) => {
        if (outcome.status === "success") {
          blocker.proceed();
          return;
        }
        showRouteFlushFailure(toast, outcome);
        blocker.reset();
      })
      .finally(() => {
        if (processingRef.current === cycle) {
          processingRef.current = null;
        }
      });
    processingRef.current = cycle;
  }, [blocker, toast]);

  return children;
}

function showPersistentNotice(
  toast: ReturnType<typeof useToast>["toast"],
  notice: PersistentLifecycleNotice,
): void {
  toast({
    title: `${notice.title}（${notice.code}）`,
    description: notice.description,
    tone: "error",
    duration: null,
  });
}

function showRouteFlushFailure(
  toast: ReturnType<typeof useToast>["toast"],
  outcome: Exclude<PersistenceFlushOutcome, { status: "success" }>,
): void {
  switch (outcome.status) {
    case "blocked":
      toast({
        title: "尚不能离开（PERSISTENCE_BLOCKED）",
        description: outcome.blockers[0]?.message ?? "请先完成当前输入，再切换页面。",
        tone: "warning",
        duration: null,
      });
      return;
    case "failed":
      toast({
        title: "本地草稿保存失败（PERSISTENCE_FAILED）",
        description: "页面切换已取消。请重试保存或导出草稿。",
        tone: "error",
        duration: null,
      });
      return;
    case "timeout":
      toast({
        title: "本地草稿保存超时（PERSISTENCE_TIMEOUT）",
        description: "页面切换已取消。请等待当前写入完成后重试。",
        tone: "error",
        duration: null,
      });
  }
}
