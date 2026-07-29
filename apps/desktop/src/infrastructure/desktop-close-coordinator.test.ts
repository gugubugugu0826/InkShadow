import { describe, expect, it, vi } from "vitest";

import { DesktopCloseCoordinator, createIdempotentAsyncCloser } from "./desktop-close-coordinator";
import { PersistenceLifecycleCoordinator } from "./persistence-lifecycle";

describe("DesktopCloseCoordinator", () => {
  it("destroys the window only after persistence and runtime close succeed", async () => {
    const events: string[] = [];
    const persistence = new PersistenceLifecycleCoordinator();
    persistence.register("editor:close-order", {
      hasPendingWork: () => true,
      flush: () => {
        events.push("persist");
        return Promise.resolve({ status: "success", flushed: true });
      },
    });
    const coordinator = new DesktopCloseCoordinator({
      persistence,
      closeRuntime: () => {
        events.push("runtime");
        return Promise.resolve();
      },
      destroyWindow: () => {
        events.push("destroy");
        return Promise.resolve();
      },
      reportPersistentNotice: vi.fn(),
    });

    await expect(coordinator.requestClose()).resolves.toEqual({ status: "destroyed" });
    expect(events).toEqual(["persist", "runtime", "destroy"]);
  });

  it("keeps the window open and reports a persistent notice when persistence fails", async () => {
    const persistence = new PersistenceLifecycleCoordinator();
    const failure = new Error("SQLITE_DISK_FULL");
    persistence.register("editor:disk-full", {
      hasPendingWork: () => true,
      flush: () => Promise.reject(failure),
    });
    const closeRuntime = vi.fn(() => Promise.resolve());
    const destroyWindow = vi.fn(() => Promise.resolve());
    const reportPersistentNotice = vi.fn();
    const coordinator = new DesktopCloseCoordinator({
      persistence,
      closeRuntime,
      destroyWindow,
      reportPersistentNotice,
    });

    await expect(coordinator.requestClose()).resolves.toEqual({ status: "failed" });
    expect(closeRuntime).not.toHaveBeenCalled();
    expect(destroyWindow).not.toHaveBeenCalled();
    expect(reportPersistentNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "PERSISTENCE_FAILED",
        cause: failure,
      }),
    );
  });

  it("coalesces duplicate close requests and permits retry only after a timed-out write settles", async () => {
    vi.useFakeTimers();
    try {
      let dirty = true;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const persistence = new PersistenceLifecycleCoordinator();
      const flush = vi.fn(async () => {
        await gate;
        dirty = false;
        return { status: "success", flushed: true } as const;
      });
      persistence.register("editor:slow-close", {
        hasPendingWork: () => dirty,
        flush,
      });
      const destroyWindow = vi.fn(() => Promise.resolve());
      const coordinator = new DesktopCloseCoordinator({
        persistence,
        closeRuntime: () => Promise.resolve(),
        destroyWindow,
        reportPersistentNotice: vi.fn(),
        persistenceTimeoutMs: 100,
      });

      const first = coordinator.requestClose();
      const duplicate = coordinator.requestClose();
      expect(duplicate).toBe(first);
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toEqual({ status: "timeout" });
      expect(coordinator.requestClose()).toBe(first);
      expect(flush).toHaveBeenCalledOnce();
      expect(destroyWindow).not.toHaveBeenCalled();

      release?.();
      await persistence.whenIdle();
      await Promise.resolve();
      await expect(coordinator.requestClose()).resolves.toEqual({ status: "destroyed" });
      expect(flush).toHaveBeenCalledOnce();
      expect(destroyWindow).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the window open when runtime close crosses its deadline", async () => {
    vi.useFakeTimers();
    try {
      const persistence = new PersistenceLifecycleCoordinator();
      let release: (() => void) | undefined;
      const runtimeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const closeRuntime = vi.fn(() => runtimeGate);
      const destroyWindow = vi.fn(() => Promise.resolve());
      const reportPersistentNotice = vi.fn();
      const coordinator = new DesktopCloseCoordinator({
        persistence,
        closeRuntime,
        destroyWindow,
        reportPersistentNotice,
        runtimeCloseTimeoutMs: 100,
      });

      const closing = coordinator.requestClose();
      await vi.advanceTimersByTimeAsync(100);
      await expect(closing).resolves.toEqual({ status: "timeout" });
      expect(destroyWindow).not.toHaveBeenCalled();
      expect(reportPersistentNotice).toHaveBeenCalledWith(
        expect.objectContaining({ code: "RUNTIME_CLOSE_TIMEOUT" }),
      );

      release?.();
      await runtimeGate;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createIdempotentAsyncCloser", () => {
  it("invokes the underlying close operation once for concurrent and later calls", async () => {
    const operation = vi.fn(() => Promise.resolve());
    const close = createIdempotentAsyncCloser(operation);
    const first = close();
    const duplicate = close();

    expect(duplicate).toBe(first);
    await first;
    await close();
    expect(operation).toHaveBeenCalledOnce();
  });
});
