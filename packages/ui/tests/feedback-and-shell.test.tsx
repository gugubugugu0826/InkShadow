import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  AppShell,
  CardTitle,
  EmptyState,
  ErrorState,
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

function ProtectedToastHarness() {
  const { toast } = useToast();

  return (
    <>
      <button type="button" onClick={() => toast({ title: "关键错误一", tone: "error" })}>
        错误一
      </button>
      <button
        type="button"
        onClick={() => toast({ title: "需要人工关闭", tone: "warning", duration: null })}
      >
        永久警告
      </button>
      <button type="button" onClick={() => toast({ title: "普通完成", tone: "success" })}>
        普通通知
      </button>
      <button type="button" onClick={() => toast({ title: "关键错误二", tone: "error" })}>
        错误二
      </button>
    </>
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

  it("visually and textually distinguishes an actionable save status", () => {
    render(<SaveStatus state="save_failed" onActivate={() => undefined} />);

    const action = screen.getByRole("button", { name: "保存失败" });
    expect(action).toHaveAttribute("data-interactive");
    expect(action).toHaveAttribute("title", "查看保存详情");
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

  it("never evicts errors or persistent notices when the visible limit is full", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider maxVisible={2}>
        <ProtectedToastHarness />
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "错误一" }));
    await user.click(screen.getByRole("button", { name: "永久警告" }));
    await user.click(screen.getByRole("button", { name: "普通通知" }));
    await user.click(screen.getByRole("button", { name: "错误二" }));

    const viewport = screen.getByLabelText("通知");
    expect(within(viewport).getByText("关键错误一")).toBeInTheDocument();
    expect(within(viewport).getByText("需要人工关闭")).toBeInTheDocument();
    expect(within(viewport).getByText("关键错误二")).toBeInTheDocument();
    expect(within(viewport).queryByText("普通完成")).not.toBeInTheDocument();
  });

  it("allows state headings to match their page or section context", () => {
    render(
      <>
        <CardTitle headingLevel={2}>卡片章节</CardTitle>
        <EmptyState headingLevel={1} title="空页面" description="暂无内容" />
        <ErrorState headingLevel={4} title="局部失败" description="稍后重试" />
      </>,
    );

    expect(screen.getByRole("heading", { name: "卡片章节", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "空页面", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "局部失败", level: 4 })).toBeInTheDocument();
  });
});

describe("AppShell", () => {
  it("provides stable landmarks and keeps responsive panels mounted", () => {
    const rendered = render(
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
    expect(rendered.container.querySelector(".ink-app-shell")).toHaveAttribute(
      "data-inspector-present",
      "true",
    );
  });

  it("does not reserve an inspector column when no inspector is rendered", () => {
    const rendered = render(
      <AppShell topBar={<div>顶部工具</div>} navigation={<a href="/projects">项目</a>}>
        <h1>编辑器</h1>
      </AppShell>,
    );

    expect(rendered.container.querySelector(".ink-app-shell")).not.toHaveAttribute(
      "data-inspector-present",
    );
    expect(screen.queryByRole("complementary", { name: "检查器" })).not.toBeInTheDocument();
  });

  it("treats the narrow navigation as a modal drawer and restores focus on dismiss", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(max-width: 39.9375rem)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    const user = userEvent.setup();

    function DrawerHarness() {
      const [open, setOpen] = useState(false);
      return (
        <AppShell
          topBar={
            <button
              type="button"
              aria-controls="test-navigation"
              aria-expanded={open}
              onClick={() => setOpen(true)}
            >
              打开导航
            </button>
          }
          navigation={
            <>
              <a href="/first">第一个入口</a>
              <a href="/last">最后一个入口</a>
            </>
          }
          navigationId="test-navigation"
          navigationOpen={open}
          onNavigationDismiss={() => setOpen(false)}
        >
          <h1>当前页面</h1>
        </AppShell>
      );
    }

    try {
      render(<DrawerHarness />);
      const trigger = screen.getByRole("button", { name: "打开导航" });
      const main = screen.getByRole("main");
      await user.click(trigger);

      await waitFor(() => {
        expect(screen.getByRole("link", { name: "第一个入口" })).toHaveFocus();
      });
      expect(main).toHaveAttribute("aria-hidden", "true");
      expect(main.inert).toBe(true);
      expect(screen.getByRole("button", { name: "关闭主导航" })).toBeInTheDocument();

      await user.tab();
      expect(screen.getByRole("link", { name: "最后一个入口" })).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("link", { name: "第一个入口" })).toHaveFocus();

      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(main).not.toHaveAttribute("aria-hidden");
      expect(main.inert).not.toBe(true);

      await user.click(trigger);
      await waitFor(() => {
        expect(screen.getByRole("link", { name: "第一个入口" })).toHaveFocus();
      });
      await user.click(screen.getByRole("button", { name: "关闭主导航" }));
      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
