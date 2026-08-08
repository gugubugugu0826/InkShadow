import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, FormField, IconButton, InkIcon, Input, Select, Textarea } from "../src";

describe("Button", () => {
  it("uses the DESIGN primary and secondary default height classes", () => {
    render(
      <>
        <Button>主操作</Button>
        <Button variant="secondary">次操作</Button>
        <Button size="sm" variant="ghost">
          行内操作
        </Button>
      </>,
    );

    expect(screen.getByRole("button", { name: "主操作" })).toHaveClass("ink-button--lg");
    expect(screen.getByRole("button", { name: "次操作" })).toHaveClass("ink-button--md");
    expect(screen.getByRole("button", { name: "行内操作" })).toHaveClass("ink-button--sm");
  });

  it("keeps standalone icon controls on the 44px touch-target class", () => {
    render(<IconButton label="搜索" icon={<InkIcon name="search" decorative />} />);

    expect(screen.getByRole("button", { name: "搜索" })).toHaveClass("ink-button--lg");
  });

  it("exposes its loading state and blocks duplicate activation", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    render(
      <Button loading loadingLabel="正在保存" onClick={onClick}>
        保存
      </Button>,
    );

    const button = screen.getByRole("button", { name: "正在保存" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps both normal and loading labels in the same layout slot", () => {
    const { rerender } = render(<Button loadingLabel="保存中">保存这一章</Button>);

    const button = screen.getByRole("button", { name: "保存这一章" });
    const labels = button.querySelectorAll(".ink-button__label-copy");
    expect(labels).toHaveLength(2);
    expect(labels[0]).toHaveAttribute("data-visible");
    expect(labels[1]).not.toHaveAttribute("data-visible");

    rerender(
      <Button loading loadingLabel="保存中">
        保存这一章
      </Button>,
    );
    expect(screen.getByRole("button", { name: "保存中" })).toBeInTheDocument();
    const loadingLabels = button.querySelectorAll(".ink-button__label-copy");
    expect(loadingLabels[0]).not.toHaveAttribute("data-visible");
    expect(loadingLabels[1]).toHaveAttribute("data-visible");
  });
});

describe("form controls", () => {
  it("connects labels, help, errors, and required state to the control", () => {
    render(
      <FormField label="项目名称" hint="显示在项目列表中" error="名称不能为空" required>
        {(fieldProps) => <Input {...fieldProps} />}
      </FormField>,
    );

    const input = screen.getByRole("textbox", { name: "项目名称" });
    expect(input).toHaveAccessibleDescription("显示在项目列表中 名称不能为空");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("名称不能为空");
  });

  it("renders native select and textarea semantics", () => {
    render(
      <>
        <Select
          aria-label="语言"
          placeholder="请选择"
          options={[
            { value: "zh", label: "中文" },
            { value: "en", label: "English", disabled: true },
          ]}
        />
        <Textarea aria-label="简介" currentLength={3} maxLength={20} />
      </>,
    );

    expect(screen.getByRole("combobox", { name: "语言" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "English" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "简介" })).toHaveAttribute("maxlength", "20");
    expect(screen.getByText("3 / 20 字符")).toBeInTheDocument();
  });

  it("keeps textarea counters in sync without requiring duplicate length props", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <Textarea aria-label="受控简介" value="墨影" maxLength={20} readOnly />
        <Textarea aria-label="自由简介" defaultValue="开篇" maxLength={20} />
      </>,
    );

    expect(screen.getAllByText("2 / 20 字符")).toHaveLength(2);

    await user.type(screen.getByRole("textbox", { name: "自由简介" }), "继续");
    expect(screen.getByText("4 / 20 字符")).toBeInTheDocument();

    rerender(
      <Textarea
        aria-label="显式计数"
        value="这段值更长"
        currentLength={1}
        maxLength={20}
        readOnly
      />,
    );
    expect(screen.getByText("1 / 20 字符")).toBeInTheDocument();
  });

  it("lets users reveal and verify password-style values", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="API Key" type="password" defaultValue="sk-test-secret" />);

    const input = screen.getByLabelText("API Key");
    const reveal = screen.getByRole("button", { name: "显示内容" });
    expect(input).toHaveAttribute("type", "password");

    await user.click(reveal);
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "隐藏内容" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not add a reveal control to non-password inputs", () => {
    render(<Input aria-label="普通字段" revealable />);

    expect(screen.queryByRole("button", { name: "显示内容" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "普通字段" })).not.toHaveAttribute(
      "type",
      "password",
    );
  });
});
