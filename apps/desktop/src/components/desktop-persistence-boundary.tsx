import { Button, Dialog, InlineAlert, useToast } from "@inkshadow/ui";
import { useBlocker } from "react-router-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  DesktopCloseCoordinator,
  type PersistentLifecycleNotice,
} from "../infrastructure/desktop-close-coordinator";
import {
  desktopPersistenceLifecycle,
  type PersistenceFlushOutcome,
} from "../infrastructure/persistence-lifecycle";
import {
  destroyCurrentWindow,
  listenCurrentWindowCloseRequested,
} from "../infrastructure/tauri-current-window";
import {
  currentGenerationNavigationGuard,
  hasActiveGenerationNavigationGuard,
  subscribeGenerationNavigationGuard,
  type ActiveGenerationNavigationGuard,
} from "../infrastructure/generation-navigation-lifecycle";
import { useRuntime } from "../runtime-context";
import { ComponentOwnershipBoundary } from "./component-ownership-path";

const ROUTE_FLUSH_TIMEOUT_MS = 8_000;

export function DesktopPersistenceBoundary({ children }: { readonly children: ReactNode }) {
  const runtime = useRuntime();
  const { toast } = useToast();
  const closeListenerActiveRef = useRef<boolean>(false);
  const closeCoordinatorRef = useRef<DesktopCloseCoordinator | null>(null);
  const [nativeCloseGuard, setNativeCloseGuard] = useState<ActiveGenerationNavigationGuard | null>(
    null,
  );

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!desktopPersistenceLifecycle.hasPendingWork() && !hasActiveGenerationNavigationGuard()) {
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
    void Promise.resolve()
      .then(async () => {
        if (isListenerInactive(closeListenerActiveRef)) {
          return;
        }
        const coordinator = new DesktopCloseCoordinator({
          persistence: desktopPersistenceLifecycle,
          closeRuntime: () => runtime.close(),
          destroyWindow: destroyCurrentWindow,
          reportPersistentNotice: (notice) => showPersistentNotice(toast, notice),
        });
        closeCoordinatorRef.current = coordinator;
        const stopListening = await listenCurrentWindowCloseRequested((event) => {
          // Tauri requires this to happen synchronously in the callback. The
          // coordinator destroys the window only after every bounded gate.
          event.preventDefault();
          const guard = currentGenerationNavigationGuard();
          if (guard !== null) {
            setNativeCloseGuard(guard);
            return;
          }
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
      closeCoordinatorRef.current = null;
      unlisten?.();
    };
  }, [runtime, toast]);

  return (
    <ComponentOwnershipBoundary name="DesktopPersistenceBoundary">
      {children}
      {nativeCloseGuard !== null && (
        <GenerationExitDialog
          guard={nativeCloseGuard}
          destination="关闭"
          onStay={() => setNativeCloseGuard(null)}
          onStopped={async () => {
            const coordinator = closeCoordinatorRef.current;
            if (coordinator !== null && (await coordinator.requestClose()).status === "destroyed") {
              setNativeCloseGuard(null);
            }
          }}
        />
      )}
    </ComponentOwnershipBoundary>
  );
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
  const [generationGuard, setGenerationGuard] = useState<ActiveGenerationNavigationGuard | null>(
    currentGenerationNavigationGuard,
  );

  useEffect(
    () =>
      subscribeGenerationNavigationGuard(() => {
        setGenerationGuard(currentGenerationNavigationGuard());
      }),
    [],
  );

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (desktopPersistenceLifecycle.hasPendingWork() || hasActiveGenerationNavigationGuard()) &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  );

  useEffect(() => {
    if (
      blocker.state !== "blocked" ||
      processingRef.current !== null ||
      currentGenerationNavigationGuard() !== null
    ) {
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

  return (
    <>
      {children}
      {blocker.state === "blocked" && generationGuard !== null && (
        <GenerationExitDialog
          guard={generationGuard}
          destination="离开"
          onStay={() => blocker.reset()}
          onFailure={() => blocker.reset()}
          onStopped={async () => {
            const cycle = desktopPersistenceLifecycle.flush("route-change", ROUTE_FLUSH_TIMEOUT_MS);
            processingRef.current = cycle.then(() => undefined);
            const outcome = await cycle.finally(() => {
              processingRef.current = null;
            });
            if (outcome.status !== "success") {
              showRouteFlushFailure(toast, outcome);
              blocker.reset();
              return;
            }
            blocker.proceed();
          }}
        />
      )}
      {blocker.state === "blocked" && generationGuard === null && (
        <div
          className="ink-navigation-save-status"
          role="status"
          aria-label="正在保存并切换页面"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="ink-spinner" aria-hidden="true" />
          <span>正在保存本地更改，保存完成后将自动切换页面…</span>
        </div>
      )}
    </>
  );
}

function GenerationExitDialog({
  guard,
  destination,
  onStay,
  onFailure,
  onStopped,
}: {
  readonly guard: ActiveGenerationNavigationGuard;
  readonly destination: "关闭" | "离开";
  readonly onStay: () => void;
  readonly onFailure?: () => void;
  readonly onStopped: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [unsafeFragmentReadyFor, setUnsafeFragmentReadyFor] = useState<string | null>(null);
  const closing = destination === "关闭";
  const unsafeFragment =
    guard.unsafeFragment !== undefined &&
    (unsafeFragmentReadyFor === guard.id || guard.unsafeFragment.isPresent())
      ? guard.unsafeFragment
      : null;
  const stop = (): void => {
    if (busy) return;
    setBusy(true);
    void guard
      .stopAndPreserve()
      .then(onStopped)
      .catch(() => {
        if (guard.unsafeFragment?.isPresent() === true) {
          setUnsafeFragmentReadyFor(guard.id);
          return;
        }
        toast({
          title: `尚不能安全${destination}`,
          description: `本次生成没有完成安全结算。${closing ? "应用" : "页面"}仍保持打开，请稍后重试或先保存可见内容。`,
          tone: "error",
          duration: null,
        });
        onFailure?.();
      })
      .finally(() => setBusy(false));
  };
  const resolveUnsafeFragment = (operation: () => void | Promise<void>): void => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve()
      .then(operation)
      .then(onStopped)
      .catch(() => {
        toast({
          title: `尚不能安全${destination}`,
          description: "片段处理没有完成，页面仍保持打开；请重试复制，或明确放弃这段未保存内容。",
          tone: "error",
          duration: null,
        });
        onFailure?.();
      })
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      open
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open) onStay();
      }}
      title={
        unsafeFragment === null
          ? `停止本次生成并${destination}？`
          : `处理未保存片段并${destination}？`
      }
      description={
        unsafeFragment === null
          ? `${closing ? "关闭应用" : "离开"}将停止本次${guard.actionLabel}。你也可以留在${closing ? "应用中" : "当前页面"}继续等待。`
          : `本次${guard.actionLabel}已经结束，但收到的片段未能安全保存。复制或明确放弃后即可${destination}；正文和版本没有变化。`
      }
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onStay}>
            留在{closing ? "应用" : "当前页面"}
          </Button>
          {unsafeFragment === null ? (
            <Button loading={busy} onClick={stop}>
              停止生成并{destination}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => resolveUnsafeFragment(unsafeFragment.copyAndRelease)}
              >
                复制片段并{destination}
              </Button>
              <Button
                loading={busy}
                onClick={() => resolveUnsafeFragment(unsafeFragment.discardAndRelease)}
              >
                放弃片段并{destination}
              </Button>
            </>
          )}
        </>
      }
    >
      {unsafeFragment === null ? (
        <InlineAlert
          tone="warning"
          title="请求已经开始，停止不代表从未发送"
          description="墨影会先结算本次请求；已收到的内容会保持为隔离的未完成建议，正文不会改变，也不会自动重发。"
        />
      ) : (
        <InlineAlert
          tone="warning"
          title="片段尚未写入本机"
          description="复制会把片段放入剪贴板；放弃只会清除这段未保存内容。两种选择都不会改动正文、版本或已有建议。"
        />
      )}
    </Dialog>
  );
}

function showPersistentNotice(
  toast: ReturnType<typeof useToast>["toast"],
  notice: PersistentLifecycleNotice,
): void {
  toast({
    title: notice.title,
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
        title: "尚不能离开",
        description: outcome.blockers[0]?.message ?? "请先完成当前输入，再切换页面。",
        tone: "warning",
        duration: null,
      });
      return;
    case "failed":
      toast({
        title: "本地草稿保存失败",
        description: "页面切换已取消。请重试保存或导出草稿。",
        tone: "error",
        duration: null,
      });
      return;
    case "timeout":
      toast({
        title: "本地草稿保存超时",
        description: "页面切换已取消。请等待当前写入完成后重试。",
        tone: "error",
        duration: null,
      });
  }
}
