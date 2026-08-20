import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CloudSyncControlSnapshot } from "../infrastructure/cloud-sync-control-service";
import {
  CloudSyncControlPanel,
  type CloudSyncControlPanelService,
} from "./cloud-sync-control-panel";

const PROJECT_ID = "019fa302-4000-7000-8000-000000000001";

describe("CloudSyncControlPanel", () => {
  it("durably pauses and then offers resume without hiding local availability", async () => {
    const user = userEvent.setup();
    const service = fakeService({
      inspectProject: vi.fn(() => Promise.resolve(syncSnapshot("synced"))),
      pauseProject: vi.fn(() => Promise.resolve(syncSnapshot("paused"))),
    });

    render(<CloudSyncControlPanel projectId={PROJECT_ID} service={service} />);

    expect(await screen.findByRole("heading", { name: "加密同步", level: 2 })).toBeInTheDocument();
    expect(await screen.findByText("加密同步已完成")).toBeVisible();
    expect(screen.getByText("本机工作始终可用")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "暂停同步" }));

    await waitFor(() => expect(service.pauseProject).toHaveBeenCalledWith(PROJECT_ID));
    expect(await screen.findByText("云同步已暂停")).toBeVisible();
    expect(screen.getByRole("button", { name: "恢复同步" })).toBeEnabled();
  });

  it("retries an offline project through the explicit retry command", async () => {
    const user = userEvent.setup();
    const service = fakeService({
      inspectProject: vi.fn(() =>
        Promise.resolve(syncSnapshot("offline", "SYNC_NETWORK_UNAVAILABLE")),
      ),
      retryProject: vi.fn(() => Promise.resolve(syncSnapshot("synced"))),
    });

    render(<CloudSyncControlPanel projectId={PROJECT_ID} service={service} />);

    expect(await screen.findByText("当前无法连接云端")).toBeVisible();
    expect(screen.getByText(/网络请求未完成/u)).toBeVisible();
    expect(screen.queryByText(/SYNC_NETWORK_UNAVAILABLE/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "立即重试" }));
    await waitFor(() =>
      expect(service.retryProject).toHaveBeenCalledWith(PROJECT_ID, expect.any(AbortSignal)),
    );
    expect(await screen.findByText("加密同步已完成")).toBeVisible();
  });

  it("routes conflicts to review and never presents retry as a silent overwrite", async () => {
    const user = userEvent.setup();
    const onOpenConflicts = vi.fn();
    const service = fakeService({
      inspectProject: vi.fn(() =>
        Promise.resolve(syncSnapshot("conflict", "SYNC_CONTENT_CONFLICT")),
      ),
    });

    render(
      <CloudSyncControlPanel
        projectId={PROJECT_ID}
        service={service}
        onOpenConflicts={onOpenConflicts}
      />,
    );

    expect(await screen.findByText("双方版本需要人工选择")).toBeVisible();
    expect(screen.queryByRole("button", { name: "立即重试" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "查看并解决冲突" }));
    expect(onOpenConflicts).toHaveBeenCalledTimes(1);
  });
});

function fakeService(
  overrides: Partial<CloudSyncControlPanelService> = {},
): CloudSyncControlPanelService {
  return {
    inspectProject: vi.fn(() => Promise.resolve(syncSnapshot("disabled"))),
    pauseProject: vi.fn(() => Promise.resolve(syncSnapshot("paused"))),
    resumeProject: vi.fn(() => Promise.resolve(syncSnapshot("synced"))),
    retryProject: vi.fn(() => Promise.resolve(syncSnapshot("synced"))),
    runProject: vi.fn(() => Promise.resolve(syncSnapshot("synced"))),
    ...overrides,
  };
}

function syncSnapshot(
  state: CloudSyncControlSnapshot["state"],
  lastErrorCode: string | null = null,
): CloudSyncControlSnapshot {
  const retryable = state === "offline" || state === "retry_wait";
  const active =
    state !== "disabled" && state !== "paused" && state !== "cancelled" && state !== "conflict";
  return {
    projectId: PROJECT_ID,
    state,
    registrationRevision: state === "disabled" ? null : 2,
    lastErrorCode,
    retryable,
    canPause: active,
    canResume: state === "paused" || state === "cancelled",
    canRetry: retryable || state === "attention_required",
    localWorkAvailable: true,
  };
}
