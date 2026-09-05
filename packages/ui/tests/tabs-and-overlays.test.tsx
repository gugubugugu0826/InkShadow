import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button, Dialog, Tabs, TabsContent, TabsList, TabsTrigger } from "../src";

describe("Tabs", () => {
  it("supports roving focus with Arrow and Home/End keys", async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="outline">
        <TabsList label="工作区">
          <TabsTrigger value="outline">大纲</TabsTrigger>
          <TabsTrigger value="draft">正文</TabsTrigger>
          <TabsTrigger value="notes" disabled>
            笔记
          </TabsTrigger>
        </TabsList>
        <TabsContent value="outline">大纲内容</TabsContent>
        <TabsContent value="draft">正文内容</TabsContent>
        <TabsContent value="notes">笔记内容</TabsContent>
      </Tabs>,
    );

    const outline = screen.getByRole("tab", { name: "大纲" });
    const draft = screen.getByRole("tab", { name: "正文" });
    outline.focus();
    await user.keyboard("{ArrowRight}");

    expect(draft).toHaveFocus();
    expect(draft).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "正文" })).toHaveTextContent("正文内容");

    await user.keyboard("{Home}");
    expect(outline).toHaveFocus();
  });
});

function DialogHarness() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>打开设置</Button>
      <Dialog open={open} onOpenChange={setOpen} title="项目设置" description="修改当前项目">
        <Button>保存设置</Button>
        <Button variant="secondary">取消编辑</Button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("focuses expandable details and excludes controls inside closed details from its focus trap", async () => {
    const user = userEvent.setup();
    render(
      <Dialog
        open
        onOpenChange={() => undefined}
        title="发送前说明"
        footer={<Button>确认发送</Button>}
      >
        <details>
          <summary>查看详情</summary>
          <Button>查看原文</Button>
        </details>
      </Dialog>,
    );
    const summary = screen.getByText("查看详情");
    await waitFor(() => expect(summary).toHaveFocus());
    await user.tab();
    expect(screen.getByRole("button", { name: "确认发送" })).toHaveFocus();
    await user.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    summary.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "查看原文" })).toHaveFocus();
  });
  it("labels the modal, traps focus, closes with Escape, and restores focus", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    const opener = screen.getByRole("button", { name: "打开设置" });
    await user.click(opener);

    const dialog = screen.getByRole("dialog", { name: "项目设置" });
    expect(dialog).toHaveAccessibleDescription("修改当前项目");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "保存设置" })).toHaveFocus();
    });

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
