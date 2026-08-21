import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SyncContentConflict } from "@inkshadow/data";
import { describe, expect, it, vi } from "vitest";

import type {
  ReadySyncConflictReview,
  SyncConflictListItem,
  SyncConflictReview,
} from "../infrastructure/sync-conflict-resolution-coordinator";
import {
  SyncConflictResolutionPage,
  type SyncConflictResolutionPageCoordinator,
} from "./sync-conflict-resolution-page";

const PROJECT_ID = id(1);
const CONFLICT_ID = id(2);
const CHAPTER_ID = id(3);
const LOCAL_VERSION_ID = id(4);
const REMOTE_VERSION_ID = id(5);
const BASE_VERSION_ID = id(6);
const REMOTE_OPERATION_ID = id(7);
const DEVICE_ID = id(8);
const NOW = "2026-07-28T04:00:00.000Z";

describe("SyncConflictResolutionPage", () => {
  it("shows all three branches and requires explicit confirmation before accepting one", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn<SyncConflictResolutionPageCoordinator["resolve"]>(() =>
      Promise.resolve({
        conflictId: CONFLICT_ID,
        action: "accept_remote",
        stableVersionId: id(20),
        projectionJobId: id(21),
        keptRemoteChapterId: null,
        keptRemoteVersionId: null,
        replayed: false,
      }),
    );
    const listUnresolved = vi
      .fn<SyncConflictResolutionPageCoordinator["listUnresolved"]>()
      .mockResolvedValueOnce([listItem()])
      .mockResolvedValueOnce([]);
    const coordinator = fakeCoordinator({ listUnresolved, resolve });

    render(<SyncConflictResolutionPage projectId={PROJECT_ID} coordinator={coordinator} />);

    expect(
      within(await screen.findByRole("region", { name: "共同基线" })).getByText("base content"),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "本机版本" })).getByText("local content"),
    ).toBeVisible();
    expect(
      within(screen.getByRole("region", { name: "远端版本" })).getByText("remote content"),
    ).toBeVisible();
    expect(screen.getByText(/远端设备/u)).toBeVisible();
    expect(document.body).not.toHaveTextContent(DEVICE_ID);
    expect(document.body).not.toHaveTextContent(DEVICE_ID.slice(0, 8));

    await user.click(screen.getByRole("button", { name: "采用远端版本" }));
    const submit = screen.getByRole("button", { name: "确认并创建稳定版本" });
    expect(submit).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "我已检查三个版本，确认执行“采用远端版本”",
      }),
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({
        conflictId: CONFLICT_ID,
        reviewToken: "c".repeat(64),
        action: "accept_remote",
        confirmed: true,
      }),
    );
    expect(await screen.findByText("所有版本都已安全归位")).toBeVisible();
  });

  it("submits edited manual content only after the post-edit confirmation", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn<SyncConflictResolutionPageCoordinator["resolve"]>(() =>
      Promise.resolve({
        conflictId: CONFLICT_ID,
        action: "manual_merge",
        stableVersionId: id(20),
        projectionJobId: id(21),
        keptRemoteChapterId: null,
        keptRemoteVersionId: null,
        replayed: false,
      }),
    );
    const coordinator = fakeCoordinator({
      listUnresolved: vi
        .fn<SyncConflictResolutionPageCoordinator["listUnresolved"]>()
        .mockResolvedValueOnce([listItem()])
        .mockResolvedValueOnce([]),
      resolve,
    });

    render(<SyncConflictResolutionPage projectId={PROJECT_ID} coordinator={coordinator} />);

    await user.click(await screen.findByRole("button", { name: "手动合并" }));
    const title = screen.getByRole("textbox", { name: "章节标题" });
    const content = screen.getByRole("textbox", { name: "合并后的正文" });
    await user.clear(title);
    await user.type(title, "Merged title");
    await user.clear(content);
    await user.type(content, "Merged content");
    await user.click(
      screen.getByRole("checkbox", {
        name: "我已检查三个版本，确认执行“手动合并”",
      }),
    );
    await user.click(screen.getByRole("button", { name: "确认并创建稳定版本" }));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({
        conflictId: CONFLICT_ID,
        reviewToken: "c".repeat(64),
        action: "manual_merge",
        confirmed: true,
        mergedTitle: "Merged title",
        mergedContent: "Merged content",
      }),
    );
  });

  it("fails closed for a remote-delete conflict and keeps local work available", async () => {
    const coordinator = fakeCoordinator({
      loadReview: vi.fn(() => Promise.resolve(remoteDeleteReview())),
    });

    render(<SyncConflictResolutionPage projectId={PROJECT_ID} coordinator={coordinator} />);

    expect(await screen.findByText("远端删除与本机修改发生冲突")).toBeVisible();
    expect(screen.getByText("local content")).toBeVisible();
    expect(
      screen.getByText("你可以继续本机编辑、备份或导出；云端状态不会阻断这些操作。"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "采用远端版本" })).toBeNull();
    expect(coordinator.resolve).not.toHaveBeenCalled();
  });
});

function fakeCoordinator(
  overrides: Partial<SyncConflictResolutionPageCoordinator> = {},
): SyncConflictResolutionPageCoordinator {
  return {
    listUnresolved: vi.fn(() => Promise.resolve([listItem()])),
    loadReview: vi.fn(() => Promise.resolve(readyReview())),
    resolve: vi.fn(() => Promise.reject(new Error("Unexpected resolution."))),
    ...overrides,
  };
}

function listItem(): SyncConflictListItem {
  return {
    conflictId: CONFLICT_ID,
    projectId: PROJECT_ID,
    objectType: "chapter_version" as const,
    objectId: CHAPTER_ID,
    remoteKind: "upsert",
    remoteDeviceId: DEVICE_ID,
    createdAt: NOW,
  };
}

function readyReview(): ReadySyncConflictReview {
  return {
    status: "ready",
    reviewToken: "c".repeat(64),
    conflict: unresolvedConflict("upsert"),
    local: {
      chapterId: CHAPTER_ID,
      title: "Local title",
      content: "local content",
      versionId: LOCAL_VERSION_ID,
      revision: 2,
      contentChecksum: "a".repeat(64),
      updatedAt: NOW,
      deviceId: null,
    },
    remote: {
      chapterId: CHAPTER_ID,
      title: "Remote title",
      content: "remote content",
      versionId: REMOTE_VERSION_ID,
      revision: 2,
      contentChecksum: "b".repeat(64),
      updatedAt: NOW,
      deviceId: DEVICE_ID,
    },
    base: {
      versionId: BASE_VERSION_ID,
      content: "base content",
      contentChecksum: "d".repeat(64),
    },
  };
}

function remoteDeleteReview(): SyncConflictReview {
  return {
    status: "remote_delete",
    conflict: unresolvedConflict("delete"),
    local: readyReview().local,
  };
}

function unresolvedConflict(
  remoteKind: "upsert",
): Extract<SyncContentConflict, { status: "unresolved"; remoteKind: "upsert" }>;
function unresolvedConflict(
  remoteKind: "delete",
): Extract<SyncContentConflict, { status: "unresolved"; remoteKind: "delete" }>;
function unresolvedConflict(remoteKind: "upsert" | "delete"): SyncContentConflict {
  const common = {
    conflictId: CONFLICT_ID,
    projectId: PROJECT_ID,
    objectType: "chapter_version" as const,
    objectId: CHAPTER_ID,
    objectGeneration: 1,
    localVector: { [id(40)]: 2 },
    remoteVector: { [DEVICE_ID]: 3 },
    remoteOperationId: REMOTE_OPERATION_ID,
    status: "unresolved" as const,
    resolution: null,
    resolutionOperationId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
  };
  return remoteKind === "upsert"
    ? {
        ...common,
        remoteKind: "upsert",
        remotePayloadSha256: "b".repeat(64),
      }
    : {
        ...common,
        remoteKind: "delete",
        remotePayloadSha256: null,
      };
}

function id(value: number): string {
  return `019fa302-3000-7000-8000-${value.toString().padStart(12, "0")}`;
}
