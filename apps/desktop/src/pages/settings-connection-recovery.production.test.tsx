import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import {
  createDevelopmentRuntime,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

describe("设置页失败连接生产恢复入口", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("编辑非敏感参数后明确重试成功，并保留原系统凭据", async () => {
    const seeded = await failedConnectionRuntime({
      checkConnection: () =>
        Promise.resolve({
          provider: "open_ai_compatible",
          endpointOrigin: "https://recovered.example",
          modelCount: 1,
          latencyMs: 17,
        }),
      listModels: () =>
        Promise.resolve({
          provider: "open_ai_compatible",
          models: [{ id: "writer-recovered", displayName: "恢复后的写作模型" }],
        }),
    });
    const user = userEvent.setup();
    renderRoute(seeded.runtime);

    await user.click(await screen.findByRole("button", { name: "编辑并重试" }));
    const baseUrl = await screen.findByLabelText("基础地址");
    await waitFor(() => expect(baseUrl).toHaveFocus());
    fireEvent.change(baseUrl, { target: { value: "https://recovered.example/v1" } });

    const retry = screen.getByRole("button", { name: "测试连接并发现模型" });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    expect(await screen.findByText(/17 毫秒/u)).toBeVisible();
    expect(await screen.findByRole("option", { name: "恢复后的写作模型" })).toBeVisible();
    expect(seeded.checkConnection).toHaveBeenCalledOnce();
    expect(seeded.listModels).toHaveBeenCalledOnce();
    expect(seeded.checkConnection.mock.calls[0]?.[0]).toMatchObject({
      providerId: seeded.connectionId,
      baseUrl: "https://recovered.example/v1",
      authentication: "bearer_keyring",
      retryLimit: 0,
    });
    expect(seeded.saveCredential).not.toHaveBeenCalled();
    expect(seeded.deleteCredential).not.toHaveBeenCalled();
    await expect(
      seeded.runtime.modelHub.findConnection(seeded.connectionId),
    ).resolves.toMatchObject({
      baseUrl: "https://recovered.example/v1",
      credentialRef: `keyring:model-hub:${seeded.connectionId}`,
      credentialState: "present",
      enabled: true,
      connectionStatus: "ready",
      lastErrorCode: null,
    });
    expect(screen.queryByRole("button", { name: "编辑并重试" })).not.toBeInTheDocument();
  });

  it("编辑后再次失败时保留活动连接、原系统凭据和再次编辑入口", async () => {
    const providerFailure = Object.assign(new Error("provider models unavailable"), {
      code: "MODEL_HTTP_NOT_FOUND",
      diagnostics: { httpStatus: 404 },
    });
    const seeded = await failedConnectionRuntime({
      checkConnection: () =>
        Promise.resolve({
          provider: "open_ai_compatible",
          endpointOrigin: "https://still-failing.example",
          modelCount: 0,
          latencyMs: 23,
        }),
      listModels: () => Promise.reject(providerFailure),
    });
    const user = userEvent.setup();
    renderRoute(seeded.runtime);

    await user.click(await screen.findByRole("button", { name: "编辑并重试" }));
    const baseUrl = await screen.findByLabelText("基础地址");
    fireEvent.change(baseUrl, { target: { value: "https://still-failing.example/v1" } });
    const retry = screen.getByRole("button", { name: "测试连接并发现模型" });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);

    expect(await screen.findByText(/AI 服务暂未完成本次操作/u)).toBeVisible();
    expect(seeded.checkConnection).toHaveBeenCalledOnce();
    expect(seeded.listModels).toHaveBeenCalledOnce();
    expect(seeded.saveCredential).not.toHaveBeenCalled();
    expect(seeded.deleteCredential).not.toHaveBeenCalled();
    await expect(
      seeded.runtime.modelHub.findConnection(seeded.connectionId),
    ).resolves.toMatchObject({
      baseUrl: "https://still-failing.example/v1",
      credentialRef: `keyring:model-hub:${seeded.connectionId}`,
      credentialState: "present",
      enabled: true,
      connectionStatus: "error",
      lastErrorCode: "MODEL_HTTP_NOT_FOUND",
    });
    expect(screen.getByRole("button", { name: "编辑并重试" })).toBeEnabled();
    expect(screen.queryByText("退役尚未完成")).not.toBeInTheDocument();
  });
});

async function failedConnectionRuntime(input: {
  readonly checkConnection: NativeModelGatewayClient["checkConnection"];
  readonly listModels: NativeModelGatewayClient["listModels"];
}): Promise<
  Readonly<{
    runtime: DesktopRuntime;
    connectionId: string;
    checkConnection: ReturnType<typeof vi.fn<NativeModelGatewayClient["checkConnection"]>>;
    listModels: ReturnType<typeof vi.fn<NativeModelGatewayClient["listModels"]>>;
    saveCredential: ReturnType<typeof vi.fn>;
    deleteCredential: ReturnType<typeof vi.fn>;
  }>
> {
  const development = createDevelopmentRuntime(window.localStorage);
  const connectionId = "failed-production-recovery";
  let connection = await development.modelHub.saveConnection({
    id: connectionId,
    providerKind: "custom_openai_compatible",
    displayName: "需要修复的写作连接",
    baseUrlOverride: "https://failed-before-edit.example/v1",
    credentialRef: `keyring:model-hub:${connectionId}`,
    credentialState: "present",
    authenticationMode: "bearer_keyring",
    enabled: true,
    expectedRevision: null,
  });
  connection = await development.modelHub.recordConnectionTest({
    connectionId,
    status: "error",
    errorCode: "MODEL_HTTP_NOT_FOUND",
    errorSummary: "旧地址检查未通过",
    expectedRevision: connection.revision,
  });
  void connection;

  const checkConnection = vi.fn<NativeModelGatewayClient["checkConnection"]>(input.checkConnection);
  const listModels = vi.fn<NativeModelGatewayClient["listModels"]>(input.listModels);
  const saveCredential = vi.fn(() => Promise.resolve({ configured: true, lastFour: "1234" }));
  const deleteCredential = vi.fn(() => Promise.resolve({ configured: false, lastFour: null }));
  const runtime: DesktopRuntime = {
    ...development,
    mode: "tauri",
    credentials: {
      getSummary: () => Promise.resolve({ configured: true, lastFour: "1234" }),
      save: saveCredential,
      delete: deleteCredential,
    },
    modelGateway: {
      available: true,
      checkConnection,
      listModels,
      generate: () => Promise.reject(new Error("文字生成不应在连接目录重试中执行")),
      embed: () => Promise.reject(new Error("向量生成不应在连接目录重试中执行")),
      cancelGeneration: () => Promise.resolve(false),
    },
  };
  return Object.freeze({
    runtime,
    connectionId,
    checkConnection,
    listModels,
    saveCredential,
    deleteCredential,
  });
}

function renderRoute(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter initialEntries={["/settings#model-center"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
