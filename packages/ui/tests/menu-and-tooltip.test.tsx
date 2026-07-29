import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DropdownMenu, Tooltip } from "../src";

describe("DropdownMenu", () => {
  it("opens from the keyboard, skips disabled items, and restores trigger focus", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <DropdownMenu
        trigger={<span aria-hidden="true">•••</span>}
        triggerLabel="更多操作"
        items={[
          { id: "rename", label: "重命名", onSelect },
          { id: "archive", label: "归档", onSelect: vi.fn(), disabled: true },
          { id: "delete", label: "删除", onSelect: vi.fn(), danger: true },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "更多操作" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "重命名" })).toHaveFocus();
    });

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "删除" })).toHaveFocus();

    await user.keyboard("{Home}{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("Tooltip", () => {
  it("associates delayed content with a focused trigger", async () => {
    const user = userEvent.setup();

    render(
      <Tooltip content="打开命令面板" delay={0}>
        {(triggerProps) => (
          <button type="button" {...triggerProps}>
            命令
          </button>
        )}
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "命令" });
    await user.tab();
    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("打开命令面板");
    });
    expect(trigger).toHaveAccessibleDescription("打开命令面板");

    await user.tab();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
