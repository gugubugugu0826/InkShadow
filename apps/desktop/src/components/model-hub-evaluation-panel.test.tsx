import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ModelHubEvaluationPanel } from "./model-hub-evaluation-panel";

describe("model hub evaluation panel", () => {
  it("states the narrow scope and displays a completed basic evaluation", async () => {
    const user = userEvent.setup();
    const evaluate = vi.fn(() =>
      Promise.resolve({
        task: "continuation" as const,
        modelId: "writer-model",
        providerKind: "openai",
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
    render(<ModelHubEvaluationPanel service={{ evaluate }} />);

    expect(screen.getByText("这不是文学质量评分")).toBeInTheDocument();
    expect(screen.getByText(/可能产生少量供应商费用/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "运行两项基础测试" }));

    expect(evaluate).toHaveBeenCalledWith("continuation");
    expect(await screen.findByText(/2\/2 项严格遵循/u)).toBeInTheDocument();
    expect(screen.getByText(/不代表文笔、剧情或一致性质量/u)).toBeInTheDocument();
  });
});
