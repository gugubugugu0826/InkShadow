import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  Link,
  RouterProvider,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { ToastProvider } from "@inkshadow/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  desktopPersistenceLifecycle,
  type PersistenceFlushContext,
} from "../infrastructure/persistence-lifecycle";
import {
  currentGenerationNavigationGuard,
  registerGenerationNavigationGuard,
} from "../infrastructure/generation-navigation-lifecycle";
import { createDevelopmentRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import {
  DesktopPersistenceBoundary,
  PersistenceRouteBoundary,
} from "./desktop-persistence-boundary";

const nativeWindowHarness = vi.hoisted(() => ({
  closeHandler: null as null | ((event: { preventDefault(): void }) => void),
  destroy: vi.fn(() => Promise.resolve()),
  unlisten: vi.fn(),
}));

vi.mock("../infrastructure/tauri-current-window", () => ({
  destroyCurrentWindow: nativeWindowHarness.destroy,
  listenCurrentWindowCloseRequested: (
    handler: (event: { preventDefault(): void }) => void,
  ): Promise<() => void> => {
    nativeWindowHarness.closeHandler = handler;
    return Promise.resolve(nativeWindowHarness.unlisten);
  },
}));

describe("PersistenceRouteBoundary", () => {
  it("flushes before Link, navigate, browser back, and browser forward transitions", async () => {
    const user = userEvent.setup();
    let pending = true;
    let flushCount = 0;
    let releaseFirstFlush: (() => void) | undefined;
    const firstFlushGate = new Promise<void>((resolve) => {
      releaseFirstFlush = resolve;
    });
    const flush = vi.fn(async (context: PersistenceFlushContext) => {
      expect(context.reason).toBe("route-change");
      expect(context.signal.aborted).toBe(false);
      flushCount += 1;
      if (flushCount === 1) {
        await firstFlushGate;
      }
      pending = false;
      return { status: "success", flushed: true } as const;
    });
    const unregister = desktopPersistenceLifecycle.register("test:route-boundary", {
      hasPendingWork: () => pending,
      flush,
    });
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <ToastProvider>
              <PersistenceRouteBoundary>
                <RouteControls />
              </PersistenceRouteBoundary>
            </ToastProvider>
          ),
        },
      ],
      { initialEntries: ["/start"] },
    );

    try {
      render(<RouterProvider router={router} />);

      await user.click(screen.getByRole("link", { name: "Link 跳转" }));
      expect(screen.getByTestId("route-path")).toHaveTextContent("/start");
      expect(flush).toHaveBeenCalledOnce();
      expect(screen.getByRole("status", { name: "正在保存并切换页面" })).toHaveTextContent(
        "正在保存本地更改",
      );
      releaseFirstFlush?.();
      await waitFor(() => {
        expect(screen.getByTestId("route-path")).toHaveTextContent("/linked");
      });
      expect(screen.queryByRole("status", { name: "正在保存并切换页面" })).not.toBeInTheDocument();

      pending = true;
      await user.click(screen.getByRole("button", { name: "navigate 跳转" }));
      await waitFor(() => {
        expect(screen.getByTestId("route-path")).toHaveTextContent("/programmatic");
      });

      pending = true;
      await act(async () => {
        await router.navigate(-1);
      });
      expect(screen.getByTestId("route-path")).toHaveTextContent("/linked");

      pending = true;
      await act(async () => {
        await router.navigate(1);
      });
      expect(screen.getByTestId("route-path")).toHaveTextContent("/programmatic");
      expect(flush).toHaveBeenCalledTimes(4);
      expect(flush.mock.calls.every(([context]) => context.reason === "route-change")).toBe(true);
    } finally {
      releaseFirstFlush?.();
      unregister();
    }
  });

  it("keeps a blocked route change in place without exposing the persistence code", async () => {
    const user = userEvent.setup();
    const unregister = desktopPersistenceLifecycle.register("test:blocked-route", {
      hasPendingWork: () => true,
      flush: vi.fn(() =>
        Promise.resolve({
          status: "blocked" as const,
          code: "COMPOSITION_ACTIVE" as const,
          message: "请先完成当前中文输入，再切换页面。",
        }),
      ),
    });
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <ToastProvider>
              <PersistenceRouteBoundary>
                <RouteControls />
              </PersistenceRouteBoundary>
            </ToastProvider>
          ),
        },
      ],
      { initialEntries: ["/start"] },
    );

    try {
      render(<RouterProvider router={router} />);
      await user.click(screen.getByRole("link", { name: "Link 跳转" }));

      expect(await screen.findByText("尚不能离开")).toBeVisible();
      expect(screen.getByText("请先完成当前中文输入，再切换页面。")).toBeVisible();
      expect(screen.queryByText(/PERSISTENCE_BLOCKED|COMPOSITION_ACTIVE/u)).not.toBeInTheDocument();
      expect(screen.getByTestId("route-path")).toHaveTextContent("/start");
    } finally {
      unregister();
    }
  });
});

describe("DesktopPersistenceBoundary", () => {
  let releaseGuard: (() => void) | null = null;

  beforeEach(() => {
    nativeWindowHarness.closeHandler = null;
    nativeWindowHarness.destroy.mockClear();
    nativeWindowHarness.unlisten.mockClear();
  });

  afterEach(() => {
    releaseGuard?.();
    releaseGuard = null;
  });

  it("requires the active generation to settle before a native window close", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const closeRuntime = vi.fn(() => Promise.resolve());
    Object.assign(runtime, { mode: "tauri" as const, close: closeRuntime });
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopAndPreserve = vi.fn(() => stopGate);
    releaseGuard = registerGenerationNavigationGuard({
      id: "native-close-generation",
      actionLabel: "续写",
      stopAndPreserve,
    });
    expect(currentGenerationNavigationGuard()).not.toBeNull();

    render(
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopPersistenceBoundary>
            <main>正文编辑器</main>
          </DesktopPersistenceBoundary>
        </ToastProvider>
      </RuntimeProvider>,
    );
    await waitFor(() => expect(nativeWindowHarness.closeHandler).not.toBeNull());
    const preventDefault = vi.fn();

    act(() => nativeWindowHarness.closeHandler?.({ preventDefault }));

    expect(preventDefault).toHaveBeenCalledOnce();
    const dialog = await screen.findByRole("dialog", { name: "停止本次生成并关闭？" });
    expect(closeRuntime).not.toHaveBeenCalled();
    expect(nativeWindowHarness.destroy).not.toHaveBeenCalled();

    screen.getByRole("button", { name: "停止生成并关闭" }).click();
    await waitFor(() => expect(stopAndPreserve).toHaveBeenCalledOnce());
    expect(closeRuntime).not.toHaveBeenCalled();
    releaseStop();

    await waitFor(() => expect(closeRuntime).toHaveBeenCalledOnce());
    await waitFor(() => expect(nativeWindowHarness.destroy).toHaveBeenCalledOnce());
    expect(dialog).not.toBeVisible();
  });
});

function RouteControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <main>
      <output data-testid="route-path">{location.pathname}</output>
      <Link to="/linked">Link 跳转</Link>
      <button type="button" onClick={() => void navigate("/programmatic")}>
        navigate 跳转
      </button>
    </main>
  );
}
