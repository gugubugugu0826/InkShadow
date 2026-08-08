import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppErrorBoundary } from "./app-error-boundary";

function BrokenView(): never {
  throw new Error("private remote detail");
}

describe("AppErrorBoundary", () => {
  it("shows safe recovery actions without rendering raw exception detail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <AppErrorBoundary>
        <BrokenView />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "这个页面暂时没有正常打开" })).toBeVisible();
    expect(screen.getByText("UI_RENDER_FAILED")).toBeVisible();
    expect(screen.getByText(/^UI-/u)).toBeVisible();
    expect(screen.queryByText("private remote detail")).not.toBeInTheDocument();
    expect(screen.getByText(/已保存的正文、版本和本地备份不会/u)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "返回创作首页" }));
    expect(window.location.hash).toBe("#/start");
    consoleError.mockRestore();
  });
});
