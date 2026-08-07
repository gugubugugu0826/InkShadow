import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SecureUpdaterPort, SignedUpdateCheck } from "../infrastructure/secure-updater";
import { SecureUpdateCard } from "./secure-update-card";

const updatePlan: SignedUpdateCheck = {
  planId: "a".repeat(64),
  state: "update_available",
  currentVersion: "0.1.0",
  releaseVersion: "0.2.0",
  publishedAt: 2_000_000_000,
  expiresAt: 2_000_003_600,
  manifestSequence: 7,
  signingKeyId: "release-2026-a",
  mandatory: false,
  artifactSizeBytes: 1024,
  artifactSha256: "b".repeat(64),
  releaseNotesUrl: null,
  installerExecutionAllowed: false,
};

function configuredUpdater(overrides: Partial<SecureUpdaterPort> = {}): SecureUpdaterPort {
  return {
    inspectConfiguration: vi.fn().mockResolvedValue({
      enabled: true,
      currentVersion: "0.1.0",
      channel: "stable",
      disabledReason: null,
      executesInstaller: false,
    }),
    check: vi.fn().mockResolvedValue(updatePlan),
    stage: vi.fn().mockResolvedValue({
      planId: updatePlan.planId,
      releaseVersion: "0.2.0",
      manifestSequence: 7,
      signingKeyId: "release-2026-a",
      artifactSizeBytes: 1024,
      artifactSha256: "b".repeat(64),
      packageState: "digest_verified_inert_staging",
      authenticodeStatus: "not_verified",
      installationAllowed: false,
      nextRequiredAction: "VERIFY_AUTHENTICODE_PUBLISHER_IN_RELEASE_PIPELINE",
    }),
    ...overrides,
  };
}

describe("SecureUpdateCard", () => {
  it("shows a fail-closed disabled state without accepting a runtime source", async () => {
    const updater = configuredUpdater({
      inspectConfiguration: vi.fn().mockResolvedValue({
        enabled: false,
        currentVersion: "0.1.0",
        channel: "stable",
        disabledReason: "UPDATE_PUBLIC_KEY_NOT_PINNED",
        executesInstaller: false,
      }),
    });
    render(<SecureUpdateCard updater={updater} online />);

    expect(await screen.findByText("此构建未启用在线更新")).toBeVisible();
    expect(screen.queryByRole("button", { name: "检查签名更新" })).not.toBeInTheDocument();
    expect(screen.getByText(/UPDATE_PUBLIC_KEY_NOT_PINNED/u)).toBeVisible();
  });

  it("checks and stages an upgrade while keeping installation unavailable", async () => {
    const user = userEvent.setup();
    const stageUpdate = vi.fn().mockResolvedValue({
      planId: updatePlan.planId,
      releaseVersion: "0.2.0",
      manifestSequence: 7,
      signingKeyId: "release-2026-a",
      artifactSizeBytes: 1024,
      artifactSha256: "b".repeat(64),
      packageState: "digest_verified_inert_staging",
      authenticodeStatus: "not_verified",
      installationAllowed: false,
      nextRequiredAction: "VERIFY_AUTHENTICODE_PUBLISHER_IN_RELEASE_PIPELINE",
    });
    const updater = configuredUpdater({ stage: stageUpdate });
    render(<SecureUpdateCard updater={updater} online />);

    await user.click(await screen.findByRole("button", { name: "检查签名更新" }));
    expect(await screen.findByText("发现签名更新")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "下载并校验更新包（不安装）" }));

    expect(await screen.findByText("更新包已完成摘要校验并隔离暂存")).toBeVisible();
    expect(stageUpdate).toHaveBeenCalledWith("a".repeat(64));
    expect(screen.queryByRole("button", { name: /安装/u })).not.toBeInTheDocument();
    expect(screen.getByText(/当前版本不具备安装能力/u)).toBeVisible();
  });

  it("fails closed for a signed rollback until native confirmation exists", async () => {
    const user = userEvent.setup();
    const rollbackPlan: SignedUpdateCheck = {
      ...updatePlan,
      planId: null,
      state: "rollback_available",
      currentVersion: "0.2.0",
      releaseVersion: "0.1.0",
    };
    const stageRollback = vi.fn().mockResolvedValue({
      planId: updatePlan.planId,
      releaseVersion: "0.1.0",
      manifestSequence: 7,
      signingKeyId: "release-2026-a",
      artifactSizeBytes: 1024,
      artifactSha256: "b".repeat(64),
      packageState: "digest_verified_inert_staging",
      authenticodeStatus: "not_verified",
      installationAllowed: false,
      nextRequiredAction: "VERIFY_AUTHENTICODE_PUBLISHER_IN_RELEASE_PIPELINE",
    });
    const updater = configuredUpdater({
      check: vi.fn().mockResolvedValue(rollbackPlan),
      stage: stageRollback,
    });
    render(<SecureUpdateCard updater={updater} online />);

    await user.click(await screen.findByRole("button", { name: "检查签名更新" }));
    expect(await screen.findByText("当前版本不能自动回退")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "下载并校验更新包（不安装）" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(stageRollback).not.toHaveBeenCalled());
  });
});
