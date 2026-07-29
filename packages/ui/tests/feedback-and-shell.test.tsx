import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  AppShell,
  InlineAlert,
  PageStateBoundary,
  SaveStatus,
  Skeleton,
  ToastProvider,
  useToast,
} from "../src";

function ToastHarness() {
  const { toast } = useToast();

  return (
    <button
      type="button"
      onClick={() =>
        toast({
          title: "导入完成",
          description: "已导入两个文档",
          tone: "success",
        })
      }
    >
      显示通知
    </button>
  );
}

describe("feedback", () => {
  it("announces non-blocking toasts as status messages", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "显示通知" }));
    expect(screen.getByRole("status")).toHaveTextContent("导入完成");
    expect(screen.getByRole("button", { name: "关闭“导入完成”通知" })).toBeInTheDocument();
  });

  it("uses persistent alert semantics for errors and explicit save text", () => {
    render(
      <>
        <InlineAlert tone="error" title="保存失败" description="本地磁盘空间不足" />
        <SaveStatus state="pending_sync" />
      </>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
    expect(screen.getByRole("status")).toHaveTextContent("已保存，待同步");
  });

  it("hides skeleton geometry and preserves safe content during loading", () => {
    render(
      <PageStateBoundary
        state="loading"
        fallbacks={{ loading: <Skeleton data-testid="loading-shape" /> }}
      >
        <p>已有正文</p>
      </PageStateBoundary>,
    );

    expect(screen.getByText("已有正文")).toBeInTheDocument();
    expect(screen.getByTestId("loading-shape")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("已有正文").closest("section")).toHaveAttribute("aria-busy", "true");
  });
});

describe("AppShell", () => {
  it("provides stable landmarks and keeps responsive panels mounted", () => {
    render(
      <AppShell
        topBar={<div>顶部工具</div>}
        navigation={<a href="/projects">项目</a>}
        inspector={<div>属性</div>}
        statusBar={<SaveStatus state="clean" />}
        navigationOpen
        inspectorOpen
      >
        <h1>编辑器</h1>
      </AppShell>,
    );

    expect(screen.getByRole("banner")).toHaveTextContent("顶部工具");
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "主要内容" })).toHaveTextContent("编辑器");
    expect(screen.getByRole("complementary", { name: "检查器" })).toHaveTextContent("属性");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("已保存");
    expect(screen.getByRole("link", { name: "跳到主要内容" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^#ink-main-/),
    );
  });
});
