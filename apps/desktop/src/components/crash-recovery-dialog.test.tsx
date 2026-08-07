import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CrashRecoveryDialog } from "./crash-recovery-dialog";

const RECOVERY_PREVIEW_CHARACTER_LIMIT = 4_000;

describe("CrashRecoveryDialog", () => {
  it("keeps both bounded previews visible and requires an explicit recovery action", () => {
    const stable = "稳".repeat(RECOVERY_PREVIEW_CHARACTER_LIMIT + 20);
    const draft = "草稿正文";
    render(
      <CrashRecoveryDialog
        busy={false}
        canSaveAsCopy={true}
        draftContent={draft}
        draftUpdatedAt="2026-07-27T00:00:00.000Z"
        open={true}
        stableContent={stable}
        onKeepStable={vi.fn()}
        onRecoverDraft={vi.fn()}
        onSaveAsCopy={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "发现未完成的本地草稿" })).toBeVisible();
    expect(screen.getByText("草稿正文")).toBeVisible();
    expect(screen.getByText(/预览已截断/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "恢复草稿继续编辑" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
    expect(screen.queryByText(stable)).not.toBeInTheDocument();
  });

  it("disables duplicate copy creation after a safe copy exists", () => {
    render(
      <CrashRecoveryDialog
        busy={false}
        canSaveAsCopy={false}
        draftContent="draft"
        draftUpdatedAt="2026-07-27T00:00:00.000Z"
        open={true}
        stableContent="stable"
        onKeepStable={vi.fn()}
        onRecoverDraft={vi.fn()}
        onSaveAsCopy={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "草稿副本已创建" })).toBeDisabled();
  });
});
