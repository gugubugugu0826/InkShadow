import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModelHubEvaluationPanel } from "./model-hub-evaluation-panel";

describe("model hub evaluation panel", () => {
  it("states the narrow scope and displays a completed basic evaluation", async () => {
    const user = userEvent.setup();
    const prepare = vi.fn(() =>
      Promise.resolve({
        fingerprint: "a".repeat(64),
        task: "continuation" as const,
        connectionDisplayName: "我的写作服务",
        modelId: "writer-model",
        dataDestination: "remote" as const,
        privacy: "两条固定测试文字会发送到所选 AI 服务；不读取或发送任何作品内容。",
        sends: ["固定文字测试", "固定结构测试"],
        maximumProviderCalls: 2 as const,
        automaticRetryCount: 0 as const,
        estimatedMaximumCostMicros: null,
        currency: null,
      }),
    );
    const evaluate = vi.fn(() =>
      Promise.resolve({
        task: "continuation" as const,
        modelId: "writer-model",
        exactInstructionPassCount: 2,
        sampleCount: 2,
        scope: "basic_instruction_adherence" as const,
        result: {
          id: "evaluation-1",
          catalogEntryId: "catalog-1",
          task: "continuation" as const,
          scoreBasisPoints: 10_000,
          latencyP50Ms: 120,
          sampleCount: 2,
          evaluationSource: "local_evaluation" as const,
          evaluationVersion: "local-basic-instruction-adherence-v1",
          observedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-31T00:00:00.000Z",
        },
      }),
    );
    render(<ModelHubEvaluationPanel service={{ prepare, evaluate }} />);

    expect(screen.getByText("这不是文学质量评分")).toBeInTheDocument();
    expect(screen.getByText(/可能产生少量供应商费用/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看两项测试的发送信息" }));

    expect(prepare).toHaveBeenCalledWith("continuation");
    expect(evaluate).not.toHaveBeenCalled();
    expect(screen.getByText(/我的写作服务 · writer-model/u)).toBeInTheDocument();
    expect(screen.getByText(/自动重试 0 次/u)).toBeInTheDocument();
    expect(screen.getByText(/当前无法核定费用上限/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认并运行 2 次固定测试" }));

    expect(evaluate).toHaveBeenCalledWith({
      task: "continuation",
      disclosureFingerprint: "a".repeat(64),
      humanConfirmed: true,
    });
    expect(await screen.findByText(/2\/2 项严格遵循/u)).toBeInTheDocument();
    expect(screen.getByText(/不代表文笔、剧情或一致性质量/u)).toBeInTheDocument();
  });

  it("cancels after inspection without evaluating", async () => {
    const user = userEvent.setup();
    const prepare = vi.fn(() =>
      Promise.resolve({
        fingerprint: "b".repeat(64),
        task: "continuation" as const,
        connectionDisplayName: "本机模型",
        modelId: "local-writer",
        dataDestination: "local" as const,
        privacy: "只发送给本机模型。",
        sends: ["两条固定文字"],
        maximumProviderCalls: 2 as const,
        automaticRetryCount: 0 as const,
        estimatedMaximumCostMicros: "0",
        currency: "USD",
      }),
    );
    const evaluate = vi.fn();
    render(<ModelHubEvaluationPanel service={{ prepare, evaluate }} />);

    await user.click(screen.getByRole("button", { name: "查看两项测试的发送信息" }));
    await user.click(screen.getByRole("button", { name: "取消，不发送" }));

    expect(evaluate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("两项基础测试发送确认")).not.toBeInTheDocument();
  });
});
