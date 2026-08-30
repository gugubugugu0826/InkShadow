import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { NovelSkillInvocationView } from "../infrastructure/novel-skill-runtime";
import { NovelSkillInvocationReference } from "./novel-skill-reference";

describe("NovelSkillInvocationReference", () => {
  it("shows the actual adoption count and a natural Chinese reason for every omitted skill", async () => {
    const user = userEvent.setup();
    const invocation: NovelSkillInvocationView = {
      taskType: "continuation",
      invocationMode: "draft",
      maximumSkillTokens: 1_200,
      usedSkillTokens: 480,
      createdAt: "2026-08-29T00:00:00.000Z",
      methods: [
        method("场景推进", true, "selected"),
        method("克制对白", false, "conflict", "user"),
        method("开头节奏", false, "task_mismatch"),
        method("氛围描写", false, "token_budget_exhausted"),
      ],
    };

    render(<NovelSkillInvocationReference invocation={invocation} />);

    expect(screen.getByText(/本次最多参考的写作技能数量：6 项/u)).toBeVisible();
    expect(screen.getByText(/发送给 AI 的文字量（不是金额）：约 480\/1,200/u)).toBeVisible();
    expect(screen.getByText("1 项采用")).toBeVisible();
    const discardedTrigger = screen.getByRole("button", {
      name: /查看本次未采用的写作技能及原因（3）/u,
    });
    expect(discardedTrigger).toHaveAttribute("aria-expanded", "false");
    discardedTrigger.focus();
    await user.keyboard("{Enter}");
    expect(discardedTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("它与本次优先级更高的技能冲突，因此未采用。")).toBeVisible();
    expect(screen.getByText("这项技能不适用于本次任务。")).toBeVisible();
    expect(
      screen.getByText("本次最多参考的写作技能数量或可参考文字量已用完，因此未采用。"),
    ).toBeVisible();
    await user.click(discardedTrigger);
    expect(discardedTrigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("这项技能不适用于本次任务。")).not.toBeInTheDocument();
    expect(screen.queryByText(/experimental|token_budget_exhausted|候选调用/u)).toBeNull();
  });
});

function method(
  displayName: string,
  included: boolean,
  selectionReason: NovelSkillInvocationView["methods"][number]["selectionReason"],
  ownerScope: NovelSkillInvocationView["methods"][number]["ownerScope"] = "builtin",
): NovelSkillInvocationView["methods"][number] {
  return {
    displayName,
    summary: `${displayName}的用途说明。`,
    version: "1.0.0",
    kind: ownerScope === "user" ? "custom" : "core",
    ownerScope,
    included,
    selectionReason,
    estimatedTokens: 120,
  };
}
