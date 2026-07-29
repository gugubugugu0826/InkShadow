import { describe, expect, it, vi } from "vitest";

import {
  PersistenceLifecycleCoordinator,
  SerializedPersistenceQueue,
} from "./persistence-lifecycle";

describe("PersistenceLifecycleCoordinator", () => {
  it("drains every pending handler and skips clean handlers", async () => {
    const coordinator = new PersistenceLifecycleCoordinator();
    const dirtyFlush = vi.fn(() => Promise.resolve({ status: "success", flushed: true } as const));
    const cleanFlush = vi.fn(() => Promise.resolve({ status: "success", flushed: false } as const));
    coordinator.register("editor:one", {
      hasPendingWork: () => true,
      flush: dirtyFlush,
    });
    coordinator.register("editor:clean", {
      hasPendingWork: () => false,
      flush: cleanFlush,
    });

    await expect(coordinator.flush("route-change", 1_000)).resolves.toEqual({
      status: "success",
      flushedHandlerIds: ["editor:one"],
    });
    expect(dirtyFlush).toHaveBeenCalledOnce();
    expect(cleanFlush).not.toHaveBeenCalled();
  });

  it("returns a stable failure instead of reporting false success", async () => {
    const coordinator = new PersistenceLifecycleCoordinator();
    const failure = Object.assign(new Error("The local disk is full."), {
      code: "SQLITE_DISK_FULL",
    });
    coordinator.register("editor:failure", {
      hasPendingWork: () => true,
      flush: () => Promise.reject(failure),
    });

    const outcome = await coordinator.flush("window-close", 1_000);
    expect(outcome).toEqual({
      status: "failed",
      failures: [{ handlerId: "editor:failure", cause: failure }],
    });
  });

  it("times out without converting unfinished work into success", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new PersistenceLifecycleCoordinator();
      coordinator.register("editor:slow", {
        hasPendingWork: () => true,
        flush: () => new Promise(() => undefined),
      });

      const flushing = coordinator.flush("window-close", 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(flushing).resolves.toEqual({
        status: "timeout",
        timeoutMs: 100,
        pendingHandlerIds: ["editor:slow"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-enter a timed-out handler when the user immediately retries", async () => {
    vi.useFakeTimers();
    try {
      let pendingWork = true;
      let resolveHandler: (() => void) | undefined;
      const handlerGate = new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });
      const coordinator = new PersistenceLifecycleCoordinator();
      const handler = vi.fn(async () => {
        await handlerGate;
        pendingWork = false;
        return { status: "success", flushed: true } as const;
      });
      coordinator.register("editor:timeout-retry", {
        hasPendingWork: () => pendingWork,
        flush: handler,
      });

      const first = coordinator.flush("window-close", 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(first).resolves.toMatchObject({ status: "timeout" });

      const immediateRetry = coordinator.flush("window-close", 100);
      expect(immediateRetry).toBe(first);
      expect(handler).toHaveBeenCalledOnce();

      resolveHandler?.();
      await vi.runAllTimersAsync();
      await Promise.resolve();
      await expect(coordinator.flush("window-close", 100)).resolves.toEqual({
        status: "success",
        flushedHandlerIds: [],
      });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces duplicate close flushes into one operation", async () => {
    let resolveFlush: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });
    const coordinator = new PersistenceLifecycleCoordinator();
    const handler = vi.fn(async () => {
      await pending;
      return { status: "success", flushed: true } as const;
    });
    coordinator.register("editor:dedupe", {
      hasPendingWork: () => true,
      flush: handler,
    });

    const first = coordinator.flush("window-close", 1_000);
    const duplicate = coordinator.flush("window-close", 1_000);
    expect(duplicate).toBe(first);
    resolveFlush?.();

    await expect(first).resolves.toEqual({
      status: "success",
      flushedHandlerIds: ["editor:dedupe"],
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("fails closed when composition blocks a flush", async () => {
    const coordinator = new PersistenceLifecycleCoordinator();
    coordinator.register("editor:ime", {
      hasPendingWork: () => true,
      flush: () =>
        Promise.resolve({
          status: "blocked",
          code: "COMPOSITION_ACTIVE",
          message: "Finish text composition before leaving.",
        }),
    });

    await expect(coordinator.flush("route-change", 1_000)).resolves.toEqual({
      status: "blocked",
      blockers: [
        {
          handlerId: "editor:ime",
          code: "COMPOSITION_ACTIVE",
          message: "Finish text composition before leaving.",
        },
      ],
    });
  });

  it("unregisters only the registration that owns the handler id", () => {
    const coordinator = new PersistenceLifecycleCoordinator();
    const unregister = coordinator.register("editor:one", {
      hasPendingWork: () => true,
      flush: () => Promise.resolve({ status: "success", flushed: true }),
    });
    expect(coordinator.hasPendingWork()).toBe(true);
    unregister();
    unregister();
    expect(coordinator.hasPendingWork()).toBe(false);
  });
});

describe("SerializedPersistenceQueue", () => {
  it("drains already queued operations in order", async () => {
    const queue = new SerializedPersistenceQueue();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.enqueue(async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    const second = queue.enqueue(() => {
      events.push("second");
      return Promise.resolve();
    });

    expect(queue.hasPendingWork()).toBe(true);
    const drained = queue.drain();
    release?.();
    await Promise.all([first, second, drained]);

    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(queue.hasPendingWork()).toBe(false);
  });

  it("surfaces an operation error and permits a later retry", async () => {
    const queue = new SerializedPersistenceQueue();
    const failure = new Error("SQLITE_BUSY");
    const failed = queue.enqueue(() => Promise.reject(failure));
    await expect(failed).rejects.toBe(failure);
    await expect(queue.drain()).rejects.toBe(failure);

    await expect(queue.enqueue(() => Promise.resolve())).resolves.toBeUndefined();
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
