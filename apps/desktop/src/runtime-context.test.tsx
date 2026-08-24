import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

const saveExportArtifact = vi.hoisted(() =>
  vi.fn((artifact: unknown, options: unknown) => {
    void artifact;
    void options;
    return Promise.resolve({
      format: "report" as const,
      fileName: "diagnostic.json",
      path: "浏览器下载位置（应用无法读取）",
      byteLength: 1,
      mediaType: "application/json",
      status: "browser_download" as const,
      verification: "path_not_available" as const,
    });
  }),
);
vi.mock("./infrastructure/export-artifact-download", () => ({ saveExportArtifact }));

import type { DesktopRuntime } from "./infrastructure/runtime";
import { RuntimeProvider } from "./runtime-context";

describe("RuntimeProvider native database bootstrap recovery", () => {
  it("reuses one in-flight runtime across the StrictMode setup cycle", async () => {
    const close = vi.fn(() => Promise.resolve());
    const runtime = { close } as unknown as DesktopRuntime;
    const factory = vi.fn(() => Promise.resolve(runtime));

    const view = render(
      <StrictMode>
        <RuntimeProvider factory={factory}>
          <span>ready</span>
        </RuntimeProvider>
      </StrictMode>,
    );

    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    view.unmount();
    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("offers a stable, actionable and redacted recovery surface for migration failures", async () => {
    saveExportArtifact.mockClear();
    const close = vi.fn(() => Promise.resolve());
    const runtime = { close } as unknown as DesktopRuntime;
    const factory = vi
      .fn<() => Promise<DesktopRuntime>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("C:\\Users\\author\\private\\inkshadow.db secret prose"), {
          code: "SQLITE_MIGRATION_INTEGRITY_FAILED",
          retryable: false,
          stage: "migration_history_validation",
          expectedVersion: 80,
          actualVersion: 80,
          reasonCode: "MIGRATION_CHECKSUM_UNKNOWN",
        }),
      )
      .mockResolvedValueOnce(runtime);

    render(
      <RuntimeProvider factory={factory}>
        <span>ready</span>
      </RuntimeProvider>,
    );

    expect(await screen.findByText(/墨影没有修改或替换原数据库/u)).toBeInTheDocument();
    expect(screen.queryByText("SQLITE_MIGRATION_INTEGRITY_FAILED")).not.toBeInTheDocument();
    expect(screen.queryByText(/secret prose|author|inkshadow\.db/u)).not.toBeInTheDocument();
    const supportNumber = screen.getByText(/^支持编号：墨影-\d{14}-\d{3,}$/u);
    expect(supportNumber).toBeVisible();
    expect(screen.getByRole("button", { name: "重新读取" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导出脱敏诊断" })).toBeVisible();
    const recoverySummary = screen.getByText("查看恢复说明");
    expect(recoverySummary.tagName).toBe("SUMMARY");
    expect(recoverySummary).toBeVisible();
    expect(screen.getByRole("button", { name: "安全退出" })).toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "导出脱敏诊断" }));
    await waitFor(() => {
      expect(saveExportArtifact).toHaveBeenCalledTimes(1);
    });
    const exportedCall = saveExportArtifact.mock.calls[0];
    if (exportedCall === undefined) throw new Error("The diagnostic export was not called.");
    const [exportedArtifact, exportOptions] = exportedCall;
    expect(exportOptions).toEqual({ format: "report", mode: "browser-development" });
    if (
      typeof exportedArtifact !== "object" ||
      exportedArtifact === null ||
      !("mediaType" in exportedArtifact) ||
      !("fileName" in exportedArtifact)
    ) {
      throw new Error("The diagnostic artifact shape was invalid.");
    }
    expect(exportedArtifact.mediaType).toBe("application/json");
    expect(exportedArtifact.fileName).toMatch(/^墨影-启动诊断-/u);
    expect(JSON.stringify(exportedArtifact)).not.toMatch(/secret prose|author|inkshadow\.db/u);
    expect(await screen.findByText("浏览器已开始下载脱敏诊断。")).toBeVisible();

    await user.click(recoverySummary);
    expect(recoverySummary.closest("details")).toHaveAttribute("open");
    expect(screen.getByText(/不要删除数据库，也不要清空作品/u)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "重新读取" }));
    expect(await screen.findByText("ready")).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("keeps reload available for explicitly retryable startup failures", async () => {
    const factory = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("The local database is temporarily unavailable."), {
          code: "SQLITE_BRIDGE_UNAVAILABLE",
          retryable: true,
        }),
      ),
    );

    render(
      <RuntimeProvider factory={factory}>
        <span>ready</span>
      </RuntimeProvider>,
    );

    expect(await screen.findByText(/本地数据访问失败/u)).toBeInTheDocument();
    expect(screen.queryByText("SQLITE_BRIDGE_UNAVAILABLE")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
