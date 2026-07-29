import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RuntimeProvider } from "./runtime-context";

describe("RuntimeProvider native database bootstrap recovery", () => {
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

    expect(await screen.findByText("SQLITE_MIGRATION_INTEGRITY_FAILED")).toBeInTheDocument();
    expect(screen.getByText(/墨影没有修改或替换原数据库/u)).toBeInTheDocument();
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

    expect(await screen.findByText("SQLITE_BRIDGE_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
