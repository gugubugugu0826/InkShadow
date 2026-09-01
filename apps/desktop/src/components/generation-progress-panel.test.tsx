// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GenerationProgressPanel } from "./generation-progress-panel";

describe("GenerationProgressPanel", () => {
  it("shows the real route, reasoning policy, plain-language length, received text and stop action", async () => {
    const onStop = vi.fn();
    render(
      <GenerationProgressPanel
        actionLabel="生成开头"
        providerLabel="DeepSeek"
        modelLabel="deepseek-chat"
        reasoningMode="disabled"
        lengthSummary="中 · 一个完整场景"
        receivedVisibleCharacters={384}
        stage="generating"
        preview="雨声落在窗台。"
        cancelBusy={false}
        onStop={onStop}
      />,
    );

    expect(screen.getByLabelText("生成开头进度")).toBeTruthy();
    expect(screen.getByText("开头生成中")).toBeTruthy();
    expect(screen.getByText("DeepSeek · deepseek-chat")).toBeTruthy();
    expect(screen.getByText("已关闭，只请求可见正文")).toBeTruthy();
    expect(screen.getByText("中 · 一个完整场景")).toBeTruthy();
    expect(screen.queryByText(/1,800|2,500/u)).toBeNull();
    expect(screen.getByText("384 字符")).toBeTruthy();
    expect(screen.getByText("正在接收可见正文")).toBeTruthy();
    expect(screen.getByText("雨声落在窗台。")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
