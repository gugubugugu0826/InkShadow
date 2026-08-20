import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { DesktopRuntime } from "./infrastructure/runtime";
import { RuntimeProvider } from "./runtime-context";

describe("RuntimeProvider native database bootstrap recovery", () => {
  it("reuses one in-flight runtime across the StrictMode setup cycle", async () => {
    const close = vi.fn(() => Promise.resolve());
    const runtime = { close } as unknown as DesktopRuntime;
    const factory = vi.fn(() => Promise.resolve(runtime));

    const view = render(
      <StrictMode>
        <RuntimeProvider factory={factory}>
          <span>ready</span>
        </RuntimeProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    view.unmount();
    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("does not offer an infinite reload loop for terminal migration integrity failures", async () => {
    const factory = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("internal"), {
          code: "SQLITE_MIGRATION_INTEGRITY_FAILED",
          retryable: false,
        }),
      ),
    );

    render(
      <RuntimeProvider factory={factory}>
        <span>ready</span>
      </RuntimeProvider>,
    );

    expect(await screen.findByText(/墨影没有修改或替换原数据库/u)).toBeInTheDocument();
    expect(screen.queryByText("SQLITE_MIGRATION_INTEGRITY_FAILED")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新加载" })).not.toBeInTheDocument();
  });

  it("keeps reload available for explicitly retryable startup failures", async () => {
    const factory = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("The local database is temporarily unavailable."), {
          code: "SQLITE_BRIDGE_UNAVAILABLE",
          retryable: true,
        }),
      ),
    );

    render(
      <RuntimeProvider factory={factory}>
        <span>ready</span>
      </RuntimeProvider>,
    );

    expect(await screen.findByText(/本地数据访问失败/u)).toBeInTheDocument();
    expect(screen.queryByText("SQLITE_BRIDGE_UNAVAILABLE")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
