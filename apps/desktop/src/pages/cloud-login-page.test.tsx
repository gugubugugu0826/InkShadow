import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("cloud login route", () => {
  it("fails closed to the local start page when cloud identity is disabled", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);

    renderRoute(runtime);

    expect(
      await screen.findByRole("heading", { name: "一句想法，也能开始一部长篇", level: 1 }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "登录云账户" })).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "云账户登录" })).not.toBeInTheDocument();
  });

  it("submits only through the enabled cloud identity service and clears the password", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const loginError = Object.assign(new Error("remote detail must never reach the interface"), {
      code: "AUTH_INVALID_CREDENTIALS",
    });
    const login = vi.fn(() => Promise.reject(loginError));
    const runtime = {
      ...baseRuntime,
      mode: "tauri",
      featureFlags: {
        ...baseRuntime.featureFlags,
        cloudIdentity: true,
      },
      cloudIdentity: {
        available: true,
        getStatus: vi.fn().mockResolvedValue({
          configured: false,
          account: null,
          device: null,
          session: null,
          expiry: null,
        }),
        login,
      },
    } as unknown as DesktopRuntime;
    const user = userEvent.setup();

    renderRoute(runtime);

    expect(await screen.findByRole("heading", { name: "登录云账户", level: 1 })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "邮箱" }), "writer@example.test");
    await user.clear(screen.getByRole("textbox", { name: "设备名称" }));
    await user.type(screen.getByRole("textbox", { name: "设备名称" }), "书房电脑");
    await user.type(screen.getByLabelText("密码"), "test-password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(login).toHaveBeenCalledWith({
        email: "writer@example.test",
        password: "test-password",
        deviceDisplayName: "书房电脑",
      });
    });
    expect(await screen.findByText("邮箱或密码不正确，请重新输入。")).toBeVisible();
    expect(
      screen.queryByText("remote detail must never reach the interface"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });

  it("blocks both local-navigation links while native login is in flight", async () => {
    const pending = deferred<never>();
    const login = vi.fn(() => pending.promise);
    const runtime = createEnabledCloudRuntime({
      getStatus: vi.fn().mockResolvedValue(emptyStatus()),
      login,
    });
    const user = userEvent.setup();

    renderRoute(runtime);
    expect(await screen.findByRole("heading", { name: "登录云账户" })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "邮箱" }), "writer@example.test");
    await user.type(screen.getByLabelText("密码"), "test-password");
    await user.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(login).toHaveBeenCalledOnce());

    const back = screen.getByRole("link", { name: "返回本地开始" });
    const continueLocally = screen.getByRole("link", {
      name: "暂不登录，继续本地使用",
    });
    expect(back).toHaveAttribute("aria-disabled", "true");
    expect(continueLocally).toHaveAttribute("aria-disabled", "true");
    await user.click(back);
    await user.click(continueLocally);
    expect(screen.getByRole("heading", { name: "登录云账户" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "一句想法，也能开始一部长篇" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "项目" })).not.toBeInTheDocument();

    pending.reject({ code: "AUTH_INVALID_CREDENTIALS" });
    expect(await screen.findByText("邮箱或密码不正确，请重新输入。")).toBeVisible();
  });

  it("redirects an already configured native session without rendering the login form", async () => {
    const login = vi.fn();
    const runtime = createEnabledCloudRuntime({
      getStatus: vi.fn().mockResolvedValue({
        ...emptyStatus(),
        configured: true,
      }),
      login,
    });

    renderRoute(runtime);

    expect(await screen.findByRole("heading", { name: "项目", level: 1 })).toBeVisible();
    expect(screen.queryByRole("form", { name: "云账户登录" })).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("shows a retryable session-check error without leaving the login page", async () => {
    const getStatus = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary failure"), { code: "NETWORK" }))
      .mockResolvedValueOnce(emptyStatus());
    const runtime = createEnabledCloudRuntime({
      getStatus,
      login: vi.fn(),
    });
    const user = userEvent.setup();

    renderRoute(runtime);

    expect(await screen.findByText("无法检查云会话")).toBeVisible();
    expect(screen.getByText(/本地项目仍可正常使用/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重新检查" }));

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("heading", { name: "登录云账户", level: 1 })).toBeVisible();
    expect(screen.queryByText("无法检查云会话")).not.toBeInTheDocument();
  });

  it("registers, clears the password, verifies the email, and establishes the device session", async () => {
    const registerIdentity = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: "019fa300-0000-7000-8000-000000000001",
      accepted: true,
      challengeId: "019fa300-0000-7000-8000-000000000002",
      expiresAt: "2026-07-28T06:15:00.000Z",
    });
    const verifyEmail = vi.fn().mockResolvedValue({ ...emptyStatus(), configured: true });
    const runtime = createEnabledCloudRuntime({
      getStatus: vi.fn().mockResolvedValue(emptyStatus()),
      login: vi.fn(),
      registerIdentity,
      verifyEmail,
    });
    const user = userEvent.setup();

    renderRoute(runtime);
    expect(await screen.findByRole("heading", { name: "登录云账户" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "创建云账户" }));
    await user.type(screen.getByRole("textbox", { name: "邮箱" }), "new@example.test");
    await user.type(screen.getByLabelText("创建密码"), "test-registration-password");
    await user.type(screen.getByLabelText("确认密码"), "test-registration-password");
    await user.clear(screen.getByRole("textbox", { name: "设备名称" }));
    await user.type(screen.getByRole("textbox", { name: "设备名称" }), "移动工作站");
    await user.click(screen.getByRole("button", { name: "提交注册" }));

    await waitFor(() =>
      expect(registerIdentity).toHaveBeenCalledWith({
        email: "new@example.test",
        password: "test-registration-password",
      }),
    );
    expect(screen.queryByLabelText("创建密码")).not.toBeInTheDocument();
    expect(await screen.findByText(/注册请求已接受/u)).toBeVisible();

    await user.type(screen.getByRole("textbox", { name: "6 位验证码" }), "123456");
    await user.click(screen.getByRole("button", { name: "验证并登录" }));

    await waitFor(() =>
      expect(verifyEmail).toHaveBeenCalledWith({
        challengeId: "019fa300-0000-7000-8000-000000000002",
        code: "123456",
        deviceDisplayName: "移动工作站",
      }),
    );
    expect(await screen.findByRole("heading", { name: "项目", level: 1 })).toBeVisible();
  });

  it("completes the non-enumerating password-reset flow and returns to login", async () => {
    const requestPasswordReset = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: "019fa300-0000-7000-8000-000000000003",
      accepted: true,
      challengeId: "019fa300-0000-7000-8000-000000000004",
      expiresAt: "2026-07-28T06:15:00.000Z",
    });
    const confirmPasswordReset = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: "019fa300-0000-7000-8000-000000000005",
      accepted: true,
    });
    const runtime = createEnabledCloudRuntime({
      getStatus: vi.fn().mockResolvedValue(emptyStatus()),
      login: vi.fn(),
      requestPasswordReset,
      confirmPasswordReset,
    });
    const user = userEvent.setup();

    renderRoute(runtime);
    expect(await screen.findByRole("heading", { name: "登录云账户" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "忘记密码" }));
    await user.type(screen.getByRole("textbox", { name: "邮箱" }), "writer@example.test");
    await user.click(screen.getByRole("button", { name: "发送重置验证码" }));

    await waitFor(() => expect(requestPasswordReset).toHaveBeenCalledWith("writer@example.test"));
    expect(await screen.findByText(/如果该邮箱对应可用账户/u)).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "6 位验证码" }), "654321");
    await user.type(screen.getByLabelText("新密码"), "replacement-password");
    await user.type(screen.getByLabelText("确认新密码"), "replacement-password");
    await user.click(screen.getByRole("button", { name: "确认新密码" }));

    await waitFor(() =>
      expect(confirmPasswordReset).toHaveBeenCalledWith({
        challengeId: "019fa300-0000-7000-8000-000000000004",
        code: "654321",
        newPassword: "replacement-password",
      }),
    );
    expect(await screen.findByText(/密码已经更新/u)).toBeVisible();
    expect(screen.getByRole("form", { name: "云账户登录" })).toBeVisible();
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });
});

function createEnabledCloudRuntime(cloudIdentity: {
  readonly getStatus: () => Promise<unknown>;
  readonly login: (input: unknown) => Promise<unknown>;
  readonly registerIdentity?: (input: unknown) => Promise<unknown>;
  readonly verifyEmail?: (input: unknown) => Promise<unknown>;
  readonly requestPasswordReset?: (email: string) => Promise<unknown>;
  readonly confirmPasswordReset?: (input: unknown) => Promise<unknown>;
}): DesktopRuntime {
  const baseRuntime = createDevelopmentRuntime(window.localStorage);
  return {
    ...baseRuntime,
    mode: "tauri",
    featureFlags: {
      ...baseRuntime.featureFlags,
      cloudIdentity: true,
    },
    cloudIdentity: {
      available: true,
      ...cloudIdentity,
    },
  } as unknown as DesktopRuntime;
}

function emptyStatus() {
  return {
    configured: false,
    account: null,
    device: null,
    session: null,
    expiry: null,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function renderRoute(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter initialEntries={["/auth/login"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
