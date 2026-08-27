import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriHarness = vi.hoisted(() => ({
  invoke: vi.fn(() => Promise.resolve()),
  listen: vi.fn(
    (
      _event: string,
      _handler: () => Promise<void>,
      _options: Readonly<{ target: Readonly<{ kind: string; label: string }> }>,
    ) => {
      void _event;
      void _handler;
      void _options;
      return Promise.resolve(vi.fn());
    },
  ),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriHarness.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauriHarness.listen }));

import {
  closeCurrentWindow,
  destroyCurrentWindow,
  listenCurrentWindowCloseRequested,
} from "./tauri-current-window";

describe("tauri current window lifecycle adapter", () => {
  beforeEach(() => {
    tauriHarness.invoke.mockClear();
    tauriHarness.listen.mockClear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { metadata: { currentWindow: { label: "main" } } },
    });
  });

  it("closes and destroys only the injected current window", async () => {
    await closeCurrentWindow();
    await destroyCurrentWindow();

    expect(tauriHarness.invoke).toHaveBeenNthCalledWith(1, "plugin:window|close", {
      label: "main",
    });
    expect(tauriHarness.invoke).toHaveBeenNthCalledWith(2, "plugin:window|destroy", {
      label: "main",
    });
  });

  it("targets the current window and preserves synchronous close prevention", async () => {
    await listenCurrentWindowCloseRequested((event) => event.preventDefault());

    expect(tauriHarness.listen).toHaveBeenCalledWith(
      "tauri://close-requested",
      expect.any(Function),
      { target: { kind: "Window", label: "main" } },
    );
    const listener = tauriHarness.listen.mock.calls[0]?.[1] as (() => Promise<void>) | undefined;
    await listener?.();
    expect(tauriHarness.invoke).not.toHaveBeenCalled();
  });

  it("matches Tauri's default by destroying when a listener does not prevent close", async () => {
    await listenCurrentWindowCloseRequested(() => undefined);

    const listener = tauriHarness.listen.mock.calls[0]?.[1] as (() => Promise<void>) | undefined;
    await listener?.();
    expect(tauriHarness.invoke).toHaveBeenCalledOnce();
    expect(tauriHarness.invoke).toHaveBeenCalledWith("plugin:window|destroy", { label: "main" });
  });
});
