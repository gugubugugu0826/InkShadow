import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@inkshadow/ui";
import { describe, expect, it } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("local-first start page", () => {
  it("enters the complete local workspace without exposing disabled cloud identity", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <RuntimeProvider runtime={runtime}>
          <ToastProvider>
            <DesktopRoutes />
          </ToastProvider>
        </RuntimeProvider>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "从你的设备开始创作", level: 1 }),
    ).toBeVisible();
    expect(screen.queryByRole("link", { name: "登录已有云账户" })).not.toBeInTheDocument();
    expect(screen.getByText("云账户稍后登录；本地工作区功能保持完整。")).toBeVisible();

    await user.click(screen.getByRole("link", { name: "本地开始" }));
    expect(await screen.findByRole("heading", { name: "项目", level: 1 })).toBeVisible();
  });

  it("does not expose a dead login link after cloud identity fails closed", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const runtime = {
      ...baseRuntime,
      mode: "tauri",
      featureFlags: {
        ...baseRuntime.featureFlags,
        cloudIdentity: true,
      },
      cloudIdentity: {
        available: false,
      },
    } as unknown as DesktopRuntime;

    render(
      <MemoryRouter initialEntries={["/start"]}>
        <RuntimeProvider runtime={runtime}>
          <ToastProvider>
            <DesktopRoutes />
          </ToastProvider>
        </RuntimeProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("云账户稍后登录；本地工作区功能保持完整。")).toBeVisible();
    expect(screen.queryByRole("link", { name: "登录已有云账户" })).not.toBeInTheDocument();
  });
});
