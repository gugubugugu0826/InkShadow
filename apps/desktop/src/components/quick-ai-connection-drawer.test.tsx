import { ToastProvider } from "@inkshadow/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDevelopmentRuntime,
  type CredentialStore,
  type DesktopRuntime,
  type NativeModelGatewayClient,
} from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { QuickAiConnectionDrawer } from "./quick-ai-connection-drawer";

const ASYNC_UI_TIMEOUT = Object.freeze({ timeout: 15_000 });

describe("quick AI connection drawer", () => {
  beforeEach(() => window.localStorage.clear());

  it("offers common Chinese providers, GLM, Ollama and an independent compatible option", async () => {
    const harness = createTauriHarness();
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    expect(screen.getByRole("radio", { name: /DeepSeek/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /^OpenAI官方云端 API$/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /阿里云百炼 \/ Qwen/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /火山方舟 \/ 豆包/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /Ollama/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /智谱 GLM/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /自定义兼容接口/u })).toBeVisible();

    await user.click(screen.getByRole("radio", { name: /阿里云百炼 \/ Qwen/u }));
    expect(screen.getByLabelText("地域")).toHaveValue("china_beijing");
    expect(screen.getByLabelText(/^模型 ID/u)).toBeRequired();
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
    await user.type(screen.getByLabelText(/^API Key/u), "test-qwen-key");
    await user.type(screen.getByLabelText(/^模型 ID/u), "qwen-account-model");
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeEnabled();
  });

  it("keeps a custom compatible key optional while requiring its base URL", async () => {
    const harness = createTauriHarness();
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    await user.click(screen.getByRole("radio", { name: /自定义兼容接口/u }));
    expect(screen.getByLabelText("Base URL")).toBeRequired();
    expect(screen.getByLabelText(/API Key（可选）/u)).not.toBeRequired();
    expect(screen.getByLabelText(/^模型 ID/u)).not.toBeRequired();
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
    await user.type(screen.getByLabelText("Base URL"), "https://models.example.test/v1");
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeEnabled();
  });

  it("does not reuse an OpenAI credential hint after switching to DeepSeek", async () => {
    const harness = createTauriHarness({ openai: "saved-1234" });
    await harness.runtime.modelHub.saveConnection({
      id: "openai",
      providerKind: "openai",
      displayName: "OpenAI",
      credentialRef: "keyring:model-hub:openai",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    expect(
      await screen.findByText("已保存 Key（末四位 1234）", {}, ASYNC_UI_TIMEOUT),
    ).toBeVisible();
    await user.click(screen.getByRole("radio", { name: /DeepSeek/u }));

    expect(screen.queryByText("已保存 Key（末四位 1234）")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^API Key/u)).toHaveAttribute("placeholder", "粘贴 API Key");
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
  }, 30_000);

  it("restores saved Qwen region, workspace and manual model into quick setup", async () => {
    const harness = createTauriHarness({ alibaba_qwen: "saved-qwen-4321" });
    const saved = await harness.runtime.modelHub.saveConnection({
      id: "alibaba_qwen",
      providerKind: "alibaba_qwen",
      displayName: "阿里云百炼 / Qwen",
      region: "singapore",
      workspaceId: "workspace-saved",
      baseUrlOverride:
        "https://workspace-saved.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      credentialRef: "keyring:model-hub:alibaba_qwen",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    const ready = await harness.runtime.modelHub.recordConnectionTest({
      connectionId: saved.id,
      status: "ready",
      expectedRevision: saved.revision,
    });
    await harness.runtime.modelHub.syncCatalog({
      syncId: "saved-qwen-sync",
      connectionId: ready.id,
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "saved-qwen-catalog",
          providerModelId: "qwen-saved-model",
          displayName: "Qwen Saved Model",
        },
      ],
    });

    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    await user.click(screen.getByRole("radio", { name: /阿里云百炼 \/ Qwen/u }));

    await waitFor(() => expect(screen.getByLabelText("地域")).toHaveValue("singapore"));
    expect(await screen.findByLabelText(/^Workspace ID/u)).toHaveValue("workspace-saved");
    expect(screen.getByLabelText(/^模型 ID/u)).toHaveValue("qwen-saved-model");
    expect(await screen.findByText("已保存 Key（末四位 4321）")).toBeVisible();
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeEnabled();
  });

  it("lets the user return from an authentication failure, replace the key, and connect", async () => {
    const harness = createTauriHarness();
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    const keyInput = screen.getByLabelText(/^API Key/u);
    fireEvent.change(keyInput, { target: { value: "bad-key" } });
    expect(keyInput).toHaveValue("bad-key");
    const firstConnectButton = screen.getByRole("button", { name: "测试连接并查找模型" });
    await waitFor(() => expect(firstConnectButton).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(firstConnectButton);

    expect(
      await screen.findByRole("heading", { name: "连接没成功" }, ASYNC_UI_TIMEOUT),
    ).toBeVisible();
    expect(screen.queryByText(/MODEL_HTTP_UNAUTHORIZED/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByLabelText(/^API Key/u)).toHaveValue("");

    const replacementKeyInput = screen.getByLabelText(/^API Key/u);
    fireEvent.change(replacementKeyInput, { target: { value: "good-key" } });
    expect(replacementKeyInput).toHaveValue("good-key");
    const secondConnectButton = screen.getByRole("button", { name: "测试连接并查找模型" });
    await waitFor(() => expect(secondConnectButton).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(secondConnectButton);
    expect(await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT)).toBeVisible();
    expect(harness.secrets.has("openai")).toBe(false);
    expect(
      [...harness.secrets.entries()].filter(([providerId]) => providerId.startsWith("quick-key-")),
    ).toEqual([[expect.stringMatching(/^quick-key-/u), "good-key"]]);
    expect([...harness.secrets.keys()].some((key) => key.startsWith("quick-probe-"))).toBe(false);
  }, 30_000);

  it("returns from a failed model probe to the preserved catalog so another model can be selected", async () => {
    const harness = createTauriHarness({}, { probeFails: true, twoModels: true });
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    const keyInput = screen.getByLabelText(/^API Key/u);
    fireEvent.change(keyInput, { target: { value: "good-key" } });
    expect(keyInput).toHaveValue("good-key");
    const connectButton = screen.getByRole("button", { name: "测试连接并查找模型" });
    await waitFor(() => expect(connectButton).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(connectButton);
    await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT);
    expect(harness.generate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
    expect(await screen.findByText("发送固定验证前确认")).toBeVisible();
    expect(screen.getByText(/最多调用 1 次，自动重试 0 次/u)).toBeVisible();
    expect(screen.getByText(/不发送作品正文、灵感、设定或 API Key/u)).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认 1 次固定验证并继续" }));
    expect(await screen.findByRole("button", { name: "返回选择" }, ASYNC_UI_TIMEOUT)).toBeEnabled();
    expect(harness.generate).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "返回选择" }));

    const modelSelect = screen.getByLabelText("开书使用的模型");
    const alternateOption = screen
      .getAllByRole("option")
      .find((option) => !option.matches(":checked"));
    if (alternateOption === undefined) throw new Error("应保留至少两个可选模型");
    const alternateValue = alternateOption.getAttribute("value") ?? "";
    expect(alternateValue).not.toBe("");
    await user.selectOptions(modelSelect, alternateOption);
    expect(modelSelect).toHaveValue(alternateValue);
  }, 30_000);

  it("shows an uncertain fixed probe as pending review without offering another dispatch", async () => {
    const harness = createTauriHarness({}, { probeAmbiguous: true });
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    fireEvent.change(screen.getByLabelText(/^API Key/u), {
      target: { value: "good-key" },
    });
    const connectButton = screen.getByRole("button", { name: "测试连接并查找模型" });
    await waitFor(() => expect(connectButton).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(connectButton);
    await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT);

    await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
    await user.click(screen.getByRole("button", { name: "确认 1 次固定验证并继续" }));

    expect(
      await screen.findByRole("heading", { name: "固定能力验证结果待核对" }, ASYNC_UI_TIMEOUT),
    ).toBeVisible();
    expect(screen.getAllByText(/不会自动重发/u).length).toBeGreaterThan(0);
    expect(screen.queryByText("连接没成功")).not.toBeInTheDocument();
    expect(screen.queryByText(/你可以重试/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回选择" })).not.toBeInTheDocument();
    expect(harness.generate).toHaveBeenCalledOnce();
    const failures = await harness.runtime.modelHub.listRecentAiFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.diagnosticId.startsWith("model_invocation:")).toBe(true);
    expect(failures[0]?.normalizedErrorCode).toBe("PROVIDER_RESULT_AMBIGUOUS");
    const connections = await harness.runtime.modelHub.listConnections();
    expect(connections).toHaveLength(1);
    expect(connections[0]?.connectionStatus).toBe("ready");
  }, 30_000);

  it("cannot be dismissed while a credential and catalog check is still running", async () => {
    const harness = createTauriHarness();
    const onOpenChange = vi.fn();
    let finishConnection:
      | ((value: Awaited<ReturnType<NativeModelGatewayClient["checkConnection"]>>) => void)
      | undefined;
    harness.checkConnection.mockImplementationOnce((config) =>
      new Promise((resolve) => {
        finishConnection = resolve;
      }).then(() => ({
        provider: config.provider,
        endpointOrigin: new URL(config.baseUrl).origin,
        modelCount: 1,
        latencyMs: 9,
      })),
    );
    const user = userEvent.setup();
    renderDrawer(harness.runtime, onOpenChange);

    fireEvent.change(screen.getByLabelText(/^API Key/u), {
      target: { value: "slow-good-key" },
    });
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
    expect(await screen.findByText("正在安全完成连接")).toBeVisible();
    expect(screen.queryByRole("button", { name: "关闭 AI 连接" })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    const backdrop = document.querySelector<HTMLElement>(".ink-overlay");
    if (backdrop === null) throw new Error("应显示 AI 连接抽屉遮罩");
    fireEvent.mouseDown(backdrop);
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("link", { name: "更多供应商与完整模型中心设置" }));
    expect(onOpenChange).not.toHaveBeenCalled();

    if (finishConnection === undefined) throw new Error("连接检查尚未开始");
    finishConnection({
      provider: "open_ai_compatible",
      endpointOrigin: "https://api.openai.com",
      modelCount: 1,
      latencyMs: 9,
    });
    expect(await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT)).toBeVisible();
  }, 30_000);
});

function renderDrawer(runtime: DesktopRuntime, onOpenChange = vi.fn()) {
  return render(
    <MemoryRouter>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <QuickAiConnectionDrawer
            open
            onOpenChange={onOpenChange}
            onSkip={vi.fn()}
            onContinue={vi.fn()}
          />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function createTauriHarness(
  initialSecrets: Readonly<Record<string, string>> = {},
  options: Readonly<{
    probeFails?: boolean;
    probeAmbiguous?: boolean;
    twoModels?: boolean;
  }> = {},
) {
  const base = createDevelopmentRuntime(window.localStorage);
  const secrets = new Map(Object.entries(initialSecrets));
  const credentials: CredentialStore = {
    getSummary: vi.fn((providerId: string) => {
      const secret = secrets.get(providerId);
      return Promise.resolve({
        configured: secret !== undefined,
        lastFour: secret?.slice(-4) ?? null,
      });
    }),
    save: vi.fn((providerId: string, secret: string) => {
      secrets.set(providerId, secret);
      return Promise.resolve({ configured: true, lastFour: secret.slice(-4) });
    }),
    delete: vi.fn((providerId: string) => {
      secrets.delete(providerId);
      return Promise.resolve({ configured: false, lastFour: null });
    }),
  };
  const checkConnection = vi.fn(
    (config: Parameters<NativeModelGatewayClient["checkConnection"]>[0]) => {
      if (secrets.get(config.providerId) === "bad-key") {
        return Promise.reject(
          Object.assign(new Error("unauthorized"), { code: "MODEL_HTTP_UNAUTHORIZED" }),
        );
      }
      return Promise.resolve({
        provider: config.provider,
        endpointOrigin: new URL(config.baseUrl).origin,
        modelCount: 1,
        latencyMs: 9,
      });
    },
  );
  const generate = vi.fn(() =>
    options.probeAmbiguous === true
      ? Promise.reject(
          Object.assign(new Error("connection ended before a response"), {
            code: "MODEL_NETWORK_TIMEOUT",
            retryable: true,
            diagnostics: { stage: "transport" },
          }),
        )
      : options.probeFails === true
        ? Promise.reject(
            Object.assign(new Error("model does not support text"), {
              code: "MODEL_TEXT_UNSUPPORTED",
            }),
          )
        : Promise.resolve({ text: "OK", usage: null }),
  );
  const modelGateway: NativeModelGatewayClient = {
    available: true,
    checkConnection,
    listModels: (config) =>
      Promise.resolve({
        provider: config.provider,
        models: [
          { id: "novel-model", displayName: "Novel Model" },
          ...(options.twoModels === true
            ? [{ id: "backup-novel", displayName: "Backup Novel" }]
            : []),
        ],
      }),
    generate,
    cancelGeneration: () => Promise.resolve(false),
    embed: base.modelGateway.embed.bind(base.modelGateway),
    ...(base.modelGateway.rerank === undefined
      ? {}
      : { rerank: base.modelGateway.rerank.bind(base.modelGateway) }),
  };
  const runtime: DesktopRuntime = Object.freeze({
    ...base,
    mode: "tauri",
    credentials,
    modelGateway,
  });
  return { runtime, secrets, checkConnection, generate };
}
