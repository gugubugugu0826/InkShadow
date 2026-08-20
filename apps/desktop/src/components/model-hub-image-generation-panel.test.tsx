import "@testing-library/jest-dom/vitest";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ModelHubImageGenerationInspection } from "../infrastructure/model-hub-image-generation-service";
import { ModelHubImageGenerationPanel } from "./model-hub-image-generation-panel";

describe("ModelHubImageGenerationPanel", () => {
  it("requires a plain-language cost/privacy acknowledgement and saves without inserting content", async () => {
    const user = userEvent.setup();
    const service = createService();
    render(<ModelHubImageGenerationPanel service={service} />);

    expect(await screen.findByText(/图片描述会发送到远程供应商/u)).toBeInTheDocument();
    await user.type(screen.getByLabelText("你想生成什么画面？"), "月色下的旧书店");
    const generate = screen.getByRole("button", { name: "选择保存位置并生成" });
    expect(generate).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /确认提示会发送/u }));
    await waitFor(() => expect(generate).toBeEnabled());
    expect(screen.getByText(/最多发起 1 次图片模型调用，自动重试 0 次/u)).toBeInTheDocument();
    expect(screen.getByText(/数据保留：遵循供应商默认政策/u)).toBeInTheDocument();
    expect(screen.getByText(/训练使用：未知/u)).toBeInTheDocument();
    await user.click(generate);

    await waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
    expect(service.generate).toHaveBeenCalledWith({
      prompt: "月色下的旧书店",
      destination: { ticket: "a".repeat(64), fileName: "illustration.png" },
      acknowledgedCostAndPrivacy: true,
      expectedConfirmationFingerprint: "b".repeat(64),
    });
    expect(service.inspect).toHaveBeenCalledWith("月色下的旧书店");
    expect(await screen.findByText(/不会自动插入正文/u)).toBeInTheDocument();
    expect(screen.getByText(/实际调用：OpenAI · provider-image-model/u)).toBeInTheDocument();
    expect(screen.queryByText(/实际调用：openai/u)).not.toBeInTheDocument();
  });

  it("does not dispatch or imply a charge when the save dialog is cancelled", async () => {
    const user = userEvent.setup();
    const service = createService();
    service.chooseDestination.mockResolvedValue(null);
    render(<ModelHubImageGenerationPanel service={service} />);

    await screen.findByText(/图片描述会发送到远程供应商/u);
    await user.type(screen.getByLabelText("你想生成什么画面？"), "一片森林");
    await user.click(screen.getByRole("button", { name: /确认提示会发送/u }));
    await user.click(screen.getByRole("button", { name: "选择保存位置并生成" }));

    expect(await screen.findByText(/没有向模型发送图片请求/u)).toBeInTheDocument();
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("explains how to enable the feature when no verified image route exists", async () => {
    const service = createService();
    service.inspect.mockRejectedValue(new Error("还没有为图片生成分配模型。"));
    render(<ModelHubImageGenerationPanel service={service} />);

    expect(await screen.findByText("图片生成暂不可用")).toBeInTheDocument();
    expect(screen.getByText(/AI 分工/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "选择保存位置并生成" })).not.toBeInTheDocument();
  });

  it("keeps provider and transport details out of ordinary errors", async () => {
    const user = userEvent.setup();
    const service = createService();
    service.generate.mockRejectedValue(
      Object.assign(new Error("SQLITE_SECRET_PATH C:\\Users\\author\\private.db"), {
        code: "UPSTREAM_IMAGE_INTERNAL_SENTINEL",
      }),
    );
    render(<ModelHubImageGenerationPanel service={service} />);

    await screen.findByText(/最多发起 1 次图片模型调用/u);
    await user.type(screen.getByLabelText("你想生成什么画面？"), "雨夜车站");
    await user.click(screen.getByRole("button", { name: /确认提示会发送/u }));
    await user.click(screen.getByRole("button", { name: "选择保存位置并生成" }));

    expect(await screen.findByText("图片生成未完成")).toBeInTheDocument();
    expect(screen.queryByText(/UPSTREAM_IMAGE_INTERNAL_SENTINEL/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/SQLITE_SECRET_PATH|private\.db/u)).not.toBeInTheDocument();
  });

  it("invalidates acknowledgement when the prompt changes and requires a fresh binding", async () => {
    const user = userEvent.setup();
    const service = createService();
    render(<ModelHubImageGenerationPanel service={service} />);

    await screen.findByText(/图片描述会发送到远程供应商/u);
    const prompt = screen.getByLabelText("你想生成什么画面？");
    const generate = screen.getByRole("button", { name: "选择保存位置并生成" });
    await user.type(prompt, "雨夜书店");
    await user.click(screen.getByRole("button", { name: /确认提示会发送/u }));
    await waitFor(() => expect(generate).toBeEnabled());

    await user.clear(prompt);
    await user.type(prompt, "晴日广场");
    expect(generate).toBeDisabled();
    expect(service.generate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /确认提示会发送/u }));
    await waitFor(() => expect(generate).toBeEnabled());
    await user.click(generate);

    await waitFor(() => expect(service.generate).toHaveBeenCalledOnce());
    expect(service.inspect).toHaveBeenCalledWith("雨夜书店");
    expect(service.inspect).toHaveBeenCalledWith("晴日广场");
    expect(service.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "晴日广场",
        expectedConfirmationFingerprint: "b".repeat(64),
      }),
    );
  });
});

function createService() {
  return {
    inspect: vi.fn((prompt?: string) =>
      Promise.resolve(inspection(prompt === undefined ? "f".repeat(64) : "b".repeat(64))),
    ),
    chooseDestination: vi.fn<() => Promise<Readonly<{ ticket: string; fileName: string }> | null>>(
      () => Promise.resolve({ ticket: "a".repeat(64), fileName: "illustration.png" }),
    ),
    generate: vi.fn(() =>
      Promise.resolve({
        file: {
          provider: "open_ai_compatible" as const,
          endpointOrigin: "https://images.example",
          model: "provider-image-model",
          fileName: "illustration.png",
          mediaType: "image/png" as const,
          bytesWritten: 2_048,
          usage: null,
        },
        invocation: {} as never,
        connectionId: "connection-1",
        catalogEntryId: "catalog-1",
        providerKind: "openai" as const,
        modelId: "provider-image-model",
        usedFallback: false,
      }),
    ),
  };
}

function inspection(confirmationFingerprint: string): ModelHubImageGenerationInspection {
  return {
    task: "image_generation",
    connectionId: "connection-1",
    connectionDisplayName: "OpenAI",
    catalogEntryId: "catalog-1",
    providerKind: "openai",
    modelId: "provider-image-model",
    dataDestination: "remote",
    retentionPolicy: "provider_default",
    trainingPolicy: "unknown",
    privacyEvidenceSource: "user_confirmed",
    capabilityEvidence: [
      {
        id: "evidence-1",
        source: "user_confirmed",
        version: "test-v1",
        observedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: null,
      },
    ],
    pricingNotice: "per_image_price_not_modeled",
    maximumPromptCharacters: 1_000,
    outputFormat: "png",
    usedFallback: false,
    confirmationFingerprint,
  };
}
