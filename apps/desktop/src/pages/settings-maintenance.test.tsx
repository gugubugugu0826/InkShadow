import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NativePathTicket } from "@inkshadow/data";
import { AppError } from "@inkshadow/domain";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomaticBackupRuntime } from "../infrastructure/automatic-backup-runtime";
import { createDevelopmentRuntime, type RuntimeMaintenance } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { SettingsPage } from "./settings-page";

const backupTicket = "a".repeat(64) as NativePathTicket;
const rollbackTicket = "b".repeat(64) as NativePathTicket;
const restoreTicket = "c".repeat(64) as NativePathTicket;

beforeEach(() => {
  window.localStorage.clear();
});

describe("SettingsPage native maintenance tickets", () => {
  it("passes only opaque native tickets through backup and restore", async () => {
    const user = userEvent.setup();
    const inspect = vi.fn<RuntimeMaintenance["inspect"]>().mockResolvedValue({
      ok: true,
      value: {
        healthy: true,
        integrityMessages: ["ok"],
        foreignKeyViolations: [],
      },
    });
    const chooseBackupDestination = vi
      .fn<RuntimeMaintenance["chooseBackupDestination"]>()
      .mockResolvedValue(backupTicket);
    const choosePreRestoreBackupDestination = vi
      .fn<RuntimeMaintenance["choosePreRestoreBackupDestination"]>()
      .mockResolvedValue(rollbackTicket);
    const chooseRestoreSource = vi
      .fn<RuntimeMaintenance["chooseRestoreSource"]>()
      .mockResolvedValue(restoreTicket);
    const createConsistentBackup = vi
      .fn<RuntimeMaintenance["createConsistentBackup"]>()
      .mockResolvedValue({
        ok: true,
        value: {
          destinationKind: "user_selected_file",
          integrityVerified: true,
        },
      });
    const restoreConsistentBackup = vi
      .fn<RuntimeMaintenance["restoreConsistentBackup"]>()
      .mockResolvedValue({
        ok: false,
        error: new AppError({
          code: "REPOSITORY_ERROR",
          message: "Synthetic post-authorization restore failure.",
        }),
      });
    const maintenance: RuntimeMaintenance = {
      inspect,
      chooseBackupDestination,
      choosePreRestoreBackupDestination,
      chooseRestoreSource,
      createConsistentBackup,
      restoreConsistentBackup,
    };
    renderSettings(maintenance);

    const backupButton = await screen.findByRole("button", {
      name: "创建一致性备份",
    });
    await waitFor(() => expect(backupButton).toBeEnabled());
    await user.click(backupButton);
    await waitFor(() => {
      expect(createConsistentBackup).toHaveBeenCalledWith(backupTicket);
    });

    const restoreButton = screen.getByRole("button", { name: "从备份恢复" });
    await waitFor(() => expect(restoreButton).toBeEnabled());
    await user.click(restoreButton);
    const confirmation = await screen.findByRole("dialog", {
      name: "确认恢复本地备份",
    });
    await user.click(
      screen.getByRole("button", {
        name: "创建回滚备份并恢复",
      }),
    );

    await waitFor(() => {
      expect(choosePreRestoreBackupDestination).toHaveBeenCalledOnce();
      expect(createConsistentBackup).toHaveBeenNthCalledWith(2, rollbackTicket);
      expect(restoreConsistentBackup).toHaveBeenCalledWith(restoreTicket);
    });
    expect(confirmation).toBeVisible();
    expect(document.body.textContent).not.toContain(backupTicket);
    expect(document.body.textContent).not.toContain(rollbackTicket);
    expect(document.body.textContent).not.toContain(restoreTicket);
  });

  it("redacts a native ticket failure even if a hostile message contains a path", async () => {
    const user = userEvent.setup();
    const rawPath = "C:\\Users\\writer\\private\\novel-backup.sqlite3";
    const chooseBackupDestination = vi
      .fn<RuntimeMaintenance["chooseBackupDestination"]>()
      .mockRejectedValue(
        Object.assign(new Error(rawPath), {
          code: "SQLITE_PATH_TICKET_INVALID",
          retryable: false,
        }),
      );
    const maintenance = {
      ...healthyMaintenance(),
      chooseBackupDestination,
    };
    renderSettings(maintenance);

    const backupButton = await screen.findByRole("button", {
      name: "创建一致性备份",
    });
    await waitFor(() => expect(backupButton).toBeEnabled());
    await user.click(backupButton);

    expect(await screen.findByText(/SQLITE_PATH_TICKET_INVALID/u)).toBeVisible();
    expect(
      screen.getByText(/所选本地数据库文件授权已失效或不再匹配。请重新选择文件后再试。/u),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain(rawPath);
  });

  it("shows the real automatic-backup policy and latest desktop check result", async () => {
    const user = userEvent.setup();
    const checkNow = vi.fn<AutomaticBackupRuntime["checkNow"]>().mockResolvedValue({
      state: "ready",
      run: {
        status: "completed",
        dueSlot: "2026-08-08",
        nextDueAt: "2026-08-09T17:00:00.000Z",
        createdBackup: {
          backupId: "019f9f4a-b3c7-7350-9226-000000000001",
          createdBy: "inkshadow_automatic_backup_service",
          scheduleSlot: "2026-08-08",
          fileName:
            "inkshadow-auto-v1-20260808T170000000Z-019f9f4a-b3c7-7350-9226-000000000001.sqlite3",
          absolutePath: "D:\\managed\\automatic-backup.sqlite3",
          createdAt: "2026-08-08T17:00:00.000Z",
          retentionUntil: "2026-09-07T17:00:00.000Z",
          status: "ready",
          byteLength: 4_096,
          sha256: "a".repeat(64),
        },
        recoveredPendingCount: 0,
        prunedCount: 1,
        missedSlotCount: 1,
      },
      errorCode: null,
    });
    const automaticBackup: AutomaticBackupRuntime = {
      available: true,
      start: vi.fn(),
      checkNow,
      stop: vi.fn().mockResolvedValue(undefined),
    };

    renderSettings(healthyMaintenance(), automaticBackup);

    expect(await screen.findByRole("heading", { name: "自动备份" })).toBeVisible();
    expect(screen.getByText(/每天本地时间 03:00/u)).toBeVisible();
    expect(await screen.findByText("今天的自动备份已完成")).toBeVisible();
    expect(screen.getByText(/4\.0 KiB/u)).toBeVisible();
    expect(screen.getByText(/清理了 1 份过期备份/u)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "立即检查自动备份" }));
    await waitFor(() => expect(checkNow).toHaveBeenCalledTimes(2));
  });
});

function healthyMaintenance(): RuntimeMaintenance {
  return {
    inspect: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        healthy: true,
        integrityMessages: ["ok"],
        foreignKeyViolations: [],
      },
    }),
    chooseBackupDestination: vi.fn().mockResolvedValue(null),
    choosePreRestoreBackupDestination: vi.fn().mockResolvedValue(null),
    chooseRestoreSource: vi.fn().mockResolvedValue(null),
    createConsistentBackup: vi.fn(),
    restoreConsistentBackup: vi.fn(),
  };
}

function renderSettings(
  maintenance: RuntimeMaintenance,
  automaticBackup: AutomaticBackupRuntime | null = null,
): void {
  const runtime = createDevelopmentRuntime(window.localStorage);
  Object.assign(runtime, { automaticBackup, maintenance });
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <SettingsPage />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}
