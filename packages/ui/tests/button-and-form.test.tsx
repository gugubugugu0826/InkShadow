import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, FormField, Input, Select, Textarea } from "../src";

describe("Button", () => {
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
});
