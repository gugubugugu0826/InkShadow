import { render, screen, waitFor, within } from "@testing-library/react";
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

describe("SettingsPage model routing", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists an exact primary and fallback model snapshot for a role", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await runtime.modelCenter.save({
      providerId: "remote-writer",
      provider: "open_ai_compatible",
      baseUrl: "https://models.example/v1",
      authentication: "none",
      selectedModel: "writer-pro",
      pricing: pricing("remote-2026-07"),
      expectedRevision: null,
    });
    await runtime.modelCenter.save({
      providerId: "local-writer",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: "qwen-local",
      pricing: pricing("local-zero-cost"),
      expectedRevision: null,
    });
    const user = userEvent.setup();
    renderRoute(runtime);

    const heading = await screen.findByRole("heading", { name: "模型角色路由" });
    const routingCard = heading.closest<HTMLElement>(".ink-card");
    if (routingCard === null) {
      throw new Error("Expected the model routing card.");
    }
    const routeControls = await within(routingCard).findAllByRole("combobox");
    const [roleControl, primaryControl, fallbackControl] = routeControls;
    if (
      roleControl === undefined ||
      primaryControl === undefined ||
      fallbackControl === undefined ||
      routeControls.length !== 3
    ) {
      throw new Error("Expected role, primary, and fallback model controls.");
    }
    await user.selectOptions(primaryControl, "remote-writer");
    await user.selectOptions(fallbackControl, "local-writer");
    await user.click(within(routingCard).getByRole("button", { name: "保存角色路由" }));

    await waitFor(async () => {
      await expect(runtime.modelRouting.findRoute("high_quality")).resolves.toMatchObject({
        role: "high_quality",
        primaryProviderId: "remote-writer",
        primaryModelId: "writer-pro",
        fallbackProviderId: "local-writer",
        fallbackModelId: "qwen-local",
        revision: 1,
      });
    });
    const reopened = createDevelopmentRuntime(window.localStorage);
    await expect(reopened.modelRouting.findRoute("high_quality")).resolves.toMatchObject({
      primaryProviderId: "remote-writer",
      primaryModelId: "writer-pro",
      fallbackProviderId: "local-writer",
      fallbackModelId: "qwen-local",
    });
  });

  it("checks loopback Ollama while offline and shows only a conservative capacity verdict", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const developmentRuntime = createDevelopmentRuntime(window.localStorage);
    await developmentRuntime.modelCenter.save({
      providerId: "ollama-local",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      authentication: "none",
      selectedModel: null,
      pricing: null,
      expectedRevision: null,
    });
    const checkConnection = vi.fn<NativeModelGatewayClient["checkConnection"]>(() =>
      Promise.resolve({
        provider: "ollama",
        endpointOrigin: "http://127.0.0.1:11434",
        modelCount: 1,
        latencyMs: 7,
      }),
    );
    const modelGateway: NativeModelGatewayClient = {
      available: true,
      checkConnection,
      listModels: () =>
        Promise.resolve({
          provider: "ollama",
          models: [
            {
              id: "qwen2.5:7b-instruct",
              displayName: "qwen2.5:7b-instruct",
              sizeBytes: 4 * 1024 ** 3,
            },
          ],
        }),
      inspectCapacity: () =>
        Promise.resolve({
          logicalCpuCount: 8,
          physicalMemory: {
            status: "measured",
            totalBytes: 16 * 1024 ** 3,
            availableBytes: 8 * 1024 ** 3,
            reason: null,
          },
          applicationDataDisk: {
            status: "measured",
            totalBytes: 512 * 1024 ** 3,
            availableBytes: 200 * 1024 ** 3,
            reason: null,
          },
          gpuMemory: {
            status: "unavailable",
            totalBytes: null,
            availableBytes: null,
            reason: "gpu_capacity_not_measured",
          },
        }),
      embed: () => Promise.reject(new Error("not used")),
      generate: () => Promise.reject(new Error("not used")),
      cancelGeneration: () => Promise.resolve(false),
    };
    const runtime: DesktopRuntime = {
      ...developmentRuntime,
      modelGateway,
    };
    const user = userEvent.setup();
    renderRoute(runtime);

    const checkButton = await screen.findByRole("button", {
      name: "检查连接并读取模型",
    });
    expect(checkButton).toBeEnabled();
    await user.click(checkButton);

    expect(await screen.findByText("本地模型容量初步体检")).toBeInTheDocument();
    expect(screen.getByText(/内存余量初步通过/u)).toHaveTextContent("GPU/显存未测量");
    expect(checkConnection).toHaveBeenCalledOnce();
  });
});

function renderRoute(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function pricing(pricingVersion: string) {
  return {
    contextWindowTokens: 32_000,
    currency: "USD",
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
    cachedInputMicrosPerMillionTokens: null,
    pricingVersion,
    priceUpdatedAt: "2026-07-27T00:00:00.000Z",
  } as const;
}
