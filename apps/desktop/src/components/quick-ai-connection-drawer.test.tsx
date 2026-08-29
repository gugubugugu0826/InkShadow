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

  it("shows one shared read failure with a stable support number and an explicit reload action", async () => {
    const harness = createTauriHarness();
    vi.spyOn(harness.runtime.modelHub, "listConnections").mockRejectedValue(
      Object.assign(new Error("read failed"), { code: "MODEL_HUB_READ_FAILED" }),
    );
    const runtime: DesktopRuntime = harness.runtime;
    const user = userEvent.setup();
    renderDrawer(runtime);

    expect(await screen.findByText("当前 AI 状态：连接失败")).toBeVisible();
    const failureCopy = await screen.findByText(
      /问题编号：墨影-[0-9]{14}-[A-Z0-9]{6}.*请重新读取 AI 写作状态/u,
    );
    const supportId = /问题编号：(墨影-[0-9]{14}-[A-Z0-9]{6})/u.exec(failureCopy.textContent)?.[1];
    expect(supportId).toBeDefined();

    await user.click(screen.getByRole("button", { name: "重新读取模型中心状态" }));

    await waitFor(() => {
      expect(screen.getByText(new RegExp(`问题编号：${supportId ?? ""}`, "u"))).toBeVisible();
    });
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("offers common Chinese providers, GLM, Ollama and an independent compatible option", async () => {
    const harness = createTauriHarness();
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    expect(screen.getByText("模型连接不会跟随新数据目录")).toBeVisible();
    expect(screen.getByText(/不自动使用系统密钥.*恢复备份.*重新连接/u)).toBeVisible();

    const commonProvider = screen.getByRole("radio", { name: /DeepSeek.*常用/u });
    expect(commonProvider).toBeVisible();
    expect(commonProvider).toBeChecked();
    expect(screen.getByRole("radio", { name: /^OpenAI官方云端 API$/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /阿里云百炼 \/ Qwen/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /火山方舟 \/ 豆包/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /Ollama/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /智谱 GLM/u })).toBeVisible();
    expect(screen.getByRole("radio", { name: /自定义兼容接口/u })).toBeVisible();

    await user.click(screen.getByRole("radio", { name: /阿里云百炼 \/ Qwen/u }));
    expect(screen.getByLabelText("地域")).toHaveValue("china_beijing");
    expect(screen.getByLabelText(/^模型编号/u)).toBeRequired();
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
    await user.type(screen.getByLabelText(/^接口密钥/u), "test-qwen-key");
    await user.type(screen.getByLabelText(/^模型编号/u), "qwen-account-model");
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeEnabled();
  });

  it("keeps a custom compatible key optional while requiring its base URL", async () => {
    const harness = createTauriHarness();
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    await user.click(screen.getByRole("radio", { name: /自定义兼容接口/u }));
    expect(screen.getByLabelText("服务根地址")).toBeRequired();
    expect(screen.getByLabelText(/接口密钥（可选）/u)).not.toBeRequired();
    expect(screen.getByLabelText(/^模型编号/u)).not.toBeRequired();
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
    await user.type(screen.getByLabelText("服务根地址"), "https://models.example.test/v1");
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeEnabled();
  });

  it("explains every blocked connection and catalog continuation action", async () => {
    const harness = createTauriHarness();
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    const connect = screen.getByRole("button", { name: "测试连接并查找模型" });
    expect(connect).toBeDisabled();
    expect(connect).toHaveAccessibleDescription(
      "暂时不能测试连接：请填写接口密钥，或选择一条本机已保存的密钥。也可以先不连接，继续开书。",
    );
    expect(screen.getByText(/暂时不能测试连接.*继续开书/u)).toBeVisible();

    await user.type(screen.getByLabelText(/^接口密钥/u), "test-deepseek-key");
    await user.click(connect);
    expect(await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT)).toBeVisible();
    fireEvent.change(screen.getByLabelText("开书使用的模型"), {
      target: { value: "" },
    });

    const continueButton = screen.getByRole("button", { name: "查看固定验证说明" });
    expect(continueButton).toBeDisabled();
    expect(continueButton).toHaveAccessibleDescription(
      "暂时不能继续：请先选择一个开书模型；如果不想使用 AI，可以选择“我自己写”或“先看看示例”。",
    );
    expect(screen.getByText(/暂时不能继续.*我自己写.*先看看示例/u)).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

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
    await user.click(screen.getByRole("radio", { name: /^OpenAI官方云端 API$/u }));

    expect(
      await screen.findByText("已保存接口密钥（末四位 1234）", {}, ASYNC_UI_TIMEOUT),
    ).toBeVisible();
    await user.click(screen.getByRole("radio", { name: /DeepSeek/u }));

    expect(screen.queryByText("已保存接口密钥（末四位 1234）")).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^接口密钥/u)).toHaveAttribute("placeholder", "粘贴接口密钥");
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
  }, 30_000);

  it("discovers only masked InkShadow credentials and waits for explicit reuse confirmation", async () => {
    const harness = createTauriHarness(
      {},
      { discoveredSecrets: ["saved-orphan-3172"], trustedDiscovery: true },
    );
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    expect(await screen.findByText(/找到 1 个墨影曾保存的接口密钥/u)).toBeVisible();
    expect(screen.getByText(/末四位 3172/u)).toBeVisible();
    expect(document.body).not.toHaveTextContent("saved-orphan-3172");
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
    expect(harness.reuseDiscovered).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /使用末四位 3172 的已保存密钥/u }));
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeEnabled();
    expect(harness.reuseDiscovered).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
    expect(await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT)).toBeVisible();
    expect(harness.reuseDiscovered).toHaveBeenCalledOnce();
    expect(harness.saveCredential).not.toHaveBeenCalled();
  }, 30_000);

  it("uses a newly entered replacement without touching a discovered credential", async () => {
    const harness = createTauriHarness(
      {},
      { discoveredSecrets: ["saved-orphan-3172"], trustedDiscovery: true },
    );
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    await screen.findByText(/找到 1 个墨影曾保存的接口密钥/u);

    fireEvent.change(screen.getByLabelText(/^接口密钥/u), {
      target: { value: "replacement-key" },
    });
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
    expect(await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT)).toBeVisible();
    expect(harness.reuseDiscovered).not.toHaveBeenCalled();
    expect(harness.saveCredential).toHaveBeenCalledOnce();
    expect(harness.deleteDiscovered).not.toHaveBeenCalled();
  }, 30_000);

  it("requires a second action to delete a discovered credential and leaves it untouched on cancel", async () => {
    const harness = createTauriHarness(
      {},
      { discoveredSecrets: ["saved-orphan-3172"], trustedDiscovery: true },
    );
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderDrawer(harness.runtime, onOpenChange);
    await screen.findByText(/找到 1 个墨影曾保存的接口密钥/u);

    await user.click(screen.getByRole("button", { name: /删除末四位 3172 的已保存密钥/u }));
    expect(harness.deleteDiscovered).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /取消删除末四位 3172 的本机密钥/u }));
    expect(harness.deleteDiscovered).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "先不连接，继续开书" }));
    expect(harness.reuseDiscovered).not.toHaveBeenCalled();
    expect(harness.deleteDiscovered).not.toHaveBeenCalled();
    expect(harness.saveCredential).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  }, 30_000);

  it("deletes a discovered credential only after explicit confirmation", async () => {
    const harness = createTauriHarness(
      {},
      { discoveredSecrets: ["saved-orphan-3172"], trustedDiscovery: true },
    );
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    await screen.findByText(/找到 1 个墨影曾保存的接口密钥/u);

    await user.click(screen.getByRole("button", { name: /删除末四位 3172 的已保存密钥/u }));
    await user.click(screen.getByRole("button", { name: /确认删除末四位 3172 的本机密钥/u }));
    expect(harness.deleteDiscovered).toHaveBeenCalledOnce();
    expect(screen.queryByText(/末四位 3172/u)).not.toBeInTheDocument();
  }, 30_000);

  it("does not offer reuse or deletion when the original provider and account cannot be verified", async () => {
    const harness = createTauriHarness({}, { discoveredSecrets: ["unknown-origin-3172"] });
    renderDrawer(harness.runtime);

    expect(await screen.findByText(/无法确认原服务商或账号/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: /使用末四位 3172/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除末四位 3172/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeDisabled();
    expect(harness.reuseDiscovered).not.toHaveBeenCalled();
    expect(harness.deleteDiscovered).not.toHaveBeenCalled();
    expect(harness.saveCredential).not.toHaveBeenCalled();
  });

  it("shows a stable support number when safe credential discovery fails", async () => {
    const harness = createTauriHarness({}, { discoveryFails: true });
    renderDrawer(harness.runtime);

    expect(await screen.findByText(/暂时无法检查本机已保存的接口密钥/u)).toBeVisible();
    expect(screen.getByText(/问题编号：墨影-[0-9]{14}-[A-Z0-9]{6}/u)).toBeVisible();
    expect(document.body).not.toHaveTextContent("CREDENTIAL_STORE_UNAVAILABLE");
  });

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
    expect(await screen.findByLabelText(/^服务工作区编号/u)).toHaveValue("workspace-saved");
    expect(screen.getByLabelText(/^模型编号/u)).toHaveValue("qwen-saved-model");
    expect(await screen.findByText("已保存接口密钥（末四位 4321）")).toBeVisible();
    expect(screen.getByRole("button", { name: "测试连接并查找模型" })).toBeEnabled();
  });

  it("does not reuse an inactive retirement record for credential discovery, hints, or its model catalog", async () => {
    const harness = createTauriHarness({ deepseek: "retired-key-4321" });
    let inactive = await harness.runtime.modelHub.saveConnection({
      id: "deepseek",
      providerKind: "deepseek",
      displayName: "已退役 DeepSeek",
      credentialRef: "keyring:model-hub:deepseek",
      credentialState: "present",
      authenticationMode: "bearer_keyring",
      enabled: true,
      expectedRevision: null,
    });
    await harness.runtime.modelHub.syncCatalog({
      syncId: "retired-deepseek-sync",
      connectionId: inactive.id,
      source: "manual",
      status: "succeeded",
      models: [
        {
          id: "retired-deepseek-catalog",
          providerModelId: "retired-text-model",
          displayName: "Retired text model",
        },
      ],
    });
    inactive = await harness.runtime.modelHub.saveConnection({
      id: inactive.id,
      providerKind: inactive.providerKind,
      displayName: inactive.displayName,
      credentialRef: inactive.credentialRef,
      credentialState: inactive.credentialState,
      authenticationMode: inactive.authenticationMode,
      enabled: false,
      expectedRevision: inactive.revision + 1,
    });

    renderDrawer(harness.runtime);

    await waitFor(() => expect(harness.discoverModelCredentials).toHaveBeenCalled());
    expect(harness.discoverModelCredentials).toHaveBeenCalledWith([]);
    expect(screen.queryByText(/已保存接口密钥（末四位 4321）/u)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^接口密钥/u)).toHaveAttribute("placeholder", "粘贴接口密钥");
    expect(harness.getCredentialSummary).not.toHaveBeenCalledWith("deepseek");
    expect(document.body).not.toHaveTextContent("retired-text-model");
    expect(inactive.enabled).toBe(false);
  });

  it("lets the user return from an authentication failure, replace the key, and connect", async () => {
    const harness = createTauriHarness();
    const user = userEvent.setup();
    renderDrawer(harness.runtime);

    const keyInput = screen.getByLabelText(/^接口密钥/u);
    fireEvent.change(keyInput, { target: { value: "bad-key" } });
    expect(keyInput).toHaveValue("bad-key");
    const firstConnectButton = screen.getByRole("button", { name: "测试连接并查找模型" });
    await waitFor(() => expect(firstConnectButton).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(firstConnectButton);

    expect(
      await screen.findByRole("heading", { name: "连接没有完成" }, ASYNC_UI_TIMEOUT),
    ).toBeVisible();
    expect(screen.queryByText(/MODEL_HTTP_UNAUTHORIZED/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByLabelText(/^接口密钥/u)).toHaveValue("");

    const replacementKeyInput = screen.getByLabelText(/^接口密钥/u);
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
    const keyInput = screen.getByLabelText(/^接口密钥/u);
    fireEvent.change(keyInput, { target: { value: "good-key" } });
    expect(keyInput).toHaveValue("good-key");
    const connectButton = screen.getByRole("button", { name: "测试连接并查找模型" });
    await waitFor(() => expect(connectButton).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(connectButton);
    await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT);
    expect(harness.generate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
    expect(await screen.findByText("发送固定验证前确认")).toBeVisible();
    expect(screen.getByText(/最多向模型服务发送 1 次，自动重试 0 次/u)).toBeVisible();
    expect(screen.getByText(/不发送作品正文、灵感、设定或接口密钥/u)).toBeVisible();
    expect(harness.generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认 1 次固定验证并继续" }));
    expect(await screen.findByRole("button", { name: "返回选择" }, ASYNC_UI_TIMEOUT)).toBeEnabled();
    expect(harness.generate).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "返回选择" }));

    const modelSelect = screen.getByLabelText("开书使用的模型");
    const alternateOption = screen
      .getAllByRole("option")
      .find((option) => option.getAttribute("value") !== "" && !option.matches(":checked"));
    if (alternateOption === undefined) throw new Error("应保留至少两个可选模型");
    const alternateValue = alternateOption.getAttribute("value") ?? "";
    expect(alternateValue).not.toBe("");
    await user.selectOptions(modelSelect, alternateOption);
    expect(modelSelect).toHaveValue(alternateValue);
  }, 30_000);

  it("uses the same pure-text bootstrap choice across entry points and never defaults to an experimental vision model", async () => {
    const harness = createTauriHarness(
      {},
      {
        models: [
          { id: "deepseek-v4-flash-vision-exp", displayName: "deepseek-v4-flash-vision-exp" },
          { id: "deepseek-v4-flash", displayName: "deepseek-v4-flash" },
          { id: "deepseek-v4-pro", displayName: "deepseek-v4-pro" },
        ],
      },
    );
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    await user.click(screen.getByRole("radio", { name: /DeepSeek/u }));
    fireEvent.change(screen.getByLabelText(/^接口密钥/u), { target: { value: "good-key" } });
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));

    expect(await screen.findByLabelText("开书使用的模型")).toHaveDisplayValue("deepseek-v4-flash");
    await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
    expect(
      await screen.findByText(/“deepseek-v4-flash”发送固定短句/u, undefined, ASYNC_UI_TIMEOUT),
    ).toBeVisible();
    expect(screen.queryByText(/“deepseek-v4-flash-vision-exp”发送固定短句/u)).toBeNull();
  }, 30_000);

  it("keeps an experimental vision-only catalog unselected and explains the pure-text requirement", async () => {
    const harness = createTauriHarness(
      {},
      {
        models: [
          {
            id: "deepseek-v4-flash-vision-exp",
            displayName: "deepseek-v4-flash-vision-exp",
          },
        ],
      },
    );
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    fireEvent.change(screen.getByLabelText(/^接口密钥/u), { target: { value: "good-key" } });
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));

    expect(await screen.findByLabelText("开书使用的模型")).toHaveValue("");
    expect(screen.getByText(/实验性视觉模型不会被自动选作纯文字开书模型/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "查看固定验证说明" })).toBeDisabled();
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("offers only confirmed text models and hides vector or unknown-capability entries", async () => {
    const harness = createTauriHarness(
      {},
      {
        models: [
          { id: "text-embedding-3-small", displayName: "text-embedding-3-small" },
          { id: "unknown-account-model", displayName: "Unknown account model" },
          { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
        ],
      },
    );
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    await user.click(screen.getByRole("radio", { name: /^OpenAI官方云端 API$/u }));
    fireEvent.change(screen.getByLabelText(/^接口密钥/u), { target: { value: "good-key" } });
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));

    const modelSelect = await screen.findByLabelText("开书使用的模型");
    expect(modelSelect).toHaveDisplayValue("GPT-5.6 Sol · gpt-5.6-sol");
    expect(screen.getByRole("option", { name: "GPT-5.6 Sol · gpt-5.6-sol" })).toBeVisible();
    expect(screen.queryByRole("option", { name: /embedding/iu })).toBeNull();
    expect(screen.queryByRole("option", { name: /Unknown account model/iu })).toBeNull();
    expect(harness.generate).not.toHaveBeenCalled();
  }, 30_000);

  it("labels a pre-dispatch probe failure as local preparation with a stable support number", async () => {
    const harness = createTauriHarness({}, { probePreparationFails: true });
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    fireEvent.change(screen.getByLabelText(/^接口密钥/u), { target: { value: "good-key" } });
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
    await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT);
    await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
    const confirm = await screen.findByRole(
      "button",
      { name: "确认 1 次固定验证并继续" },
      ASYNC_UI_TIMEOUT,
    );
    await waitFor(() => expect(confirm).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(confirm);

    expect(
      await screen.findByRole("heading", { name: "模型能力检查未发送" }, ASYNC_UI_TIMEOUT),
    ).toBeVisible();
    expect(screen.getByText(/没有向模型服务发送内容/u)).toBeVisible();
    expect(screen.getByText(/问题编号：墨影-[0-9]{14}-[A-Z0-9]{4,8}/u)).toBeVisible();
    expect(screen.queryByText(/检查网络、Key 和账号权限/u)).toBeNull();
    expect(screen.queryByText("连接没成功")).toBeNull();
    expect(screen.getByRole("link", { name: "打开完整模型中心排查" })).toHaveAttribute(
      "href",
      "/settings?targetSection=model-capabilities#model-center",
    );
    const invocationId =
      harness.generate.mock.calls[0]?.[0].invocationDispatchLedger?.invocationId ?? "missing";
    const invocation = await harness.runtime.modelHub.findInvocation(invocationId);
    expect(invocation).toMatchObject({ attempt: 1 });
    expect(invocation?.providerDispatchStartedAt).toBeNull();
    expect(harness.generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
  }, 30_000);

  it("deduplicates a double confirmation into one fixed probe invocation", async () => {
    const harness = createTauriHarness();
    const user = userEvent.setup();
    const startInvocation = vi.spyOn(harness.runtime.modelHub, "startInvocation");
    renderDrawer(harness.runtime);
    fireEvent.change(screen.getByLabelText(/^接口密钥/u), { target: { value: "good-key" } });
    await user.click(screen.getByRole("button", { name: "测试连接并查找模型" }));
    await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT);
    await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));

    const confirm = await screen.findByRole(
      "button",
      { name: "确认 1 次固定验证并继续" },
      ASYNC_UI_TIMEOUT,
    );
    await waitFor(() => expect(confirm).toBeEnabled(), ASYNC_UI_TIMEOUT);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(harness.generate).toHaveBeenCalledOnce(), ASYNC_UI_TIMEOUT);
    const probeStarts = startInvocation.mock.calls.filter(
      ([input]) => input.task === "capability_probe",
    );
    expect(probeStarts).toHaveLength(1);
    const invocationId = probeStarts[0]?.[0].id ?? "missing";
    await expect(harness.runtime.modelHub.findInvocation(invocationId)).resolves.toMatchObject({
      attempt: 1,
    });
    expect(harness.generate.mock.calls[0]?.[0].config.retryLimit).toBe(0);
  }, 30_000);

  it("shows an uncertain fixed probe as pending review without offering another dispatch", async () => {
    const harness = createTauriHarness({}, { probeAmbiguous: true });
    const user = userEvent.setup();
    renderDrawer(harness.runtime);
    fireEvent.change(screen.getByLabelText(/^接口密钥/u), {
      target: { value: "good-key" },
    });
    const connectButton = screen.getByRole("button", { name: "测试连接并查找模型" });
    await waitFor(() => expect(connectButton).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(connectButton);
    await screen.findByText("连接成功 · 已找到模型", {}, ASYNC_UI_TIMEOUT);

    await user.click(screen.getByRole("button", { name: "查看固定验证说明" }));
    const confirm = await screen.findByRole(
      "button",
      { name: "确认 1 次固定验证并继续" },
      ASYNC_UI_TIMEOUT,
    );
    await waitFor(() => expect(confirm).toBeEnabled(), ASYNC_UI_TIMEOUT);
    await user.click(confirm);

    expect(
      await screen.findByRole("heading", { name: "模型能力检查结果待核对" }, ASYNC_UI_TIMEOUT),
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

    fireEvent.change(screen.getByLabelText(/^接口密钥/u), {
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
    await user.click(screen.getByRole("link", { name: "更多模型服务与完整模型中心设置" }));
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
    probePreparationFails?: boolean;
    twoModels?: boolean;
    models?: readonly { readonly id: string; readonly displayName: string }[];
    discoveredSecrets?: readonly string[];
    trustedDiscovery?: boolean;
    discoveryFails?: boolean;
  }> = {},
) {
  const base = createDevelopmentRuntime(window.localStorage);
  const secrets = new Map(Object.entries(initialSecrets));
  const discoveredSecrets = new Map(
    (options.discoveredSecrets ?? []).map((secret, index) => [
      "discovery-" + String(index + 1),
      secret,
    ]),
  );
  const reuseDiscovered = vi.fn((discoveryId: string, providerId: string) => {
    const secret = discoveredSecrets.get(discoveryId);
    if (secret === undefined) return Promise.reject(new Error("discovery expired"));
    secrets.set(providerId, secret);
    return Promise.resolve({ configured: true, lastFour: secret.slice(-4) });
  });
  const deleteDiscovered = vi.fn((discoveryId: string) => {
    discoveredSecrets.delete(discoveryId);
    return Promise.resolve({ configured: false, lastFour: null });
  });
  const saveCredential = vi.fn((providerId: string, secret: string) => {
    secrets.set(providerId, secret);
    return Promise.resolve({ configured: true, lastFour: secret.slice(-4) });
  });
  const getCredentialSummary = vi.fn((providerId: string) => {
    const secret = secrets.get(providerId);
    return Promise.resolve({
      configured: secret !== undefined,
      lastFour: secret?.slice(-4) ?? null,
    });
  });
  const discoverModelCredentials = vi.fn(() =>
    options.discoveryFails === true
      ? Promise.reject(
          Object.assign(new Error("credential discovery unavailable"), {
            code: "CREDENTIAL_STORE_UNAVAILABLE",
            requestId: "01a033ab-1234-7890-abcd-1234567890ab",
          }),
        )
      : Promise.resolve(
          [...discoveredSecrets.entries()].map(([discoveryId, secret]) => ({
            discoveryId,
            lastFour: secret.slice(-4),
            ...(options.trustedDiscovery === true
              ? { providerKind: "deepseek", sourceConnectionId: "deepseek" }
              : {}),
          })),
        ),
  );
  const credentials = {
    getSummary: getCredentialSummary,
    save: saveCredential,
    delete: vi.fn((providerId: string) => {
      secrets.delete(providerId);
      return Promise.resolve({ configured: false, lastFour: null });
    }),
    discoverModelCredentials,
    reuseDiscovered,
    deleteDiscovered,
  } as CredentialStore & {
    discoverModelCredentials(): Promise<readonly { discoveryId: string; lastFour: string }[]>;
    reuseDiscovered(
      discoveryId: string,
      providerId: string,
    ): Promise<{
      configured: boolean;
      lastFour: string | null;
    }>;
    deleteDiscovered(discoveryId: string): Promise<{
      configured: boolean;
      lastFour: string | null;
    }>;
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
  const generate = vi.fn<NativeModelGatewayClient["generate"]>(() =>
    options.probePreparationFails === true
      ? Promise.reject(
          Object.assign(new Error("native preparation stopped before dispatch"), {
            code: "MODEL_CREDENTIAL_MISSING",
            diagnostics: { stage: "request_preparation" },
          }),
        )
      : options.probeAmbiguous === true
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
    ...(options.probePreparationFails === true
      ? { supportsNativeInvocationDispatchLedger: true as const }
      : {}),
    checkConnection,
    listModels: (config) => {
      const defaults = config.baseUrl.includes("api.deepseek.com")
        ? [
            { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
            ...(options.twoModels === true
              ? [{ id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }]
              : []),
          ]
        : [
            { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
            ...(options.twoModels === true
              ? [{ id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" }]
              : []),
          ];
      return Promise.resolve({ provider: config.provider, models: options.models ?? defaults });
    },
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
  return {
    runtime,
    secrets,
    credentials,
    getCredentialSummary,
    discoverModelCredentials,
    saveCredential,
    reuseDiscovered,
    deleteDiscovered,
    checkConnection,
    generate,
  };
}
