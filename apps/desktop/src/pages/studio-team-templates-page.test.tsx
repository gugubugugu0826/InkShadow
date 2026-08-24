import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type {
  DecryptedStudioTeamTemplateListItem,
  StudioTeamTemplateApplicationPartialRetry,
  StudioTeamTemplateHistoryExport,
} from "../infrastructure/studio-team-template-coordinator";
import type { StudioTeamTemplateSessionContext } from "../infrastructure/studio-team-template-service";
import {
  StudioTeamTemplatesPage,
  type StudioTeamTemplatesPageCoordinator,
} from "./studio-team-templates-page";

describe("encrypted team-template injected page", () => {
  it("shows honest loading, empty and offline states without a fake remote success", async () => {
    let release: ((value: ReturnType<typeof listView>) => void) | undefined;
    const pending = new Promise<ReturnType<typeof listView>>((resolve) => {
      release = resolve;
    });
    const coordinator = fakeCoordinator({
      listTemplates: vi.fn(() => pending),
    });
    const view = render(
      <StudioTeamTemplatesPage
        coordinator={coordinator}
        context={AUTHOR}
        online
        mutationFeatureEnabled
        expectedProjectRevision={1}
      />,
    );

    expect(screen.getByText("正在读取加密团队模板…")).toBeVisible();
    release?.(listView([]));
    expect(await screen.findByText("还没有团队模板")).toBeVisible();

    view.rerender(
      <StudioTeamTemplatesPage
        coordinator={coordinator}
        context={AUTHOR}
        online={false}
        mutationFeatureEnabled
        expectedProjectRevision={1}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "团队模板当前离线", level: 1 }),
    ).toBeVisible();
    expect(screen.getByText(/离线时不会伪造远端成功/u)).toBeVisible();
  });

  it("does not issue a cloud read when the role has no template capability", async () => {
    const coordinator = fakeCoordinator({
      capabilities: vi.fn(() => noCapabilities()),
    });
    render(
      <StudioTeamTemplatesPage
        coordinator={coordinator}
        context={{ ...AUTHOR, role: "finance_admin" }}
        online
        mutationFeatureEnabled
        expectedProjectRevision={1}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "无权访问团队模板", level: 1 }),
    ).toBeVisible();
    expect(coordinator.listTemplates).not.toHaveBeenCalled();
  });

  it("shows decrypted titles to read-only roles but no mutation controls", async () => {
    const coordinator = fakeCoordinator({
      capabilities: vi.fn(() => ({ ...noCapabilities(), read: true })),
      listTemplates: vi.fn(() => Promise.resolve(listView([readyItem("Assigned private title")]))),
    });
    render(
      <StudioTeamTemplatesPage
        coordinator={coordinator}
        context={{ ...AUTHOR, role: "read_only" }}
        online
        mutationFeatureEnabled
        expectedProjectRevision={3}
      />,
    );

    expect(await screen.findByText("Assigned private title")).toBeVisible();
    expect(screen.getByText("模板历史为只读")).toBeVisible();
    expect(screen.queryByRole("button", { name: "应用一次到项目" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "克隆为草稿" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出版本历史" })).toBeVisible();
  });

  it("renders per-item decryption errors without inventing or leaking a title", async () => {
    const item = decryptErrorItem();
    const coordinator = fakeCoordinator({
      listTemplates: vi.fn(() => Promise.resolve(listView([item]))),
    });
    render(
      <StudioTeamTemplatesPage
        coordinator={coordinator}
        context={AUTHOR}
        online
        mutationFeatureEnabled
        expectedProjectRevision={3}
      />,
    );

    expect(await screen.findByText("无法解密此模板")).toBeVisible();
    expect(screen.getByText(/未通过解密或完整性校验/u)).toBeVisible();
    expect(screen.queryByText("TEAM_TEMPLATE_CIPHERTEXT_CORRUPT")).not.toBeInTheDocument();
    expect(screen.queryByText("Fallback template title")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用一次到项目" })).toBeDisabled();
  });

  it("keeps history readable while a rollout flag removes every mutation control", async () => {
    const coordinator = fakeCoordinator({
      capabilities: vi.fn(() => ({ ...noCapabilities(), read: true })),
      listTemplates: vi.fn(() => Promise.resolve(listView([readyItem("Historical title")]))),
    });
    render(
      <StudioTeamTemplatesPage
        coordinator={coordinator}
        context={AUTHOR}
        online
        mutationFeatureEnabled={false}
        expectedProjectRevision={3}
      />,
    );

    expect(await screen.findByText("Historical title")).toBeVisible();
    expect(screen.getByText("团队模板变更尚未启用")).toBeVisible();
    expect(screen.queryByRole("button", { name: "加密并创建草稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "应用一次到项目" })).not.toBeInTheDocument();
  });

  it("retries only the cloud receipt after a durable local application", async () => {
    const user = userEvent.setup();
    const partial = partialRetry();
    const advanced = vi.fn();
    const coordinator = fakeCoordinator({
      listTemplates: vi.fn(() => Promise.resolve(listView([readyItem("Apply exactly once")]))),
      applyPublished: vi.fn(() => Promise.resolve(partial)),
      retryApplicationRecord: vi.fn(() =>
        Promise.resolve({
          status: "recorded" as const,
          receipt: { ...partial.receipt, cloudRecordedAt: NOW },
          cloud: {
            schemaVersion: 1 as const,
            requestId: uuid(90),
            applicationId: partial.receipt.applicationId,
            tenantId: AUTHOR.tenantId,
            teamId: AUTHOR.teamId,
            projectId: AUTHOR.projectId,
            templateId: partial.receipt.templateId,
            versionId: partial.receipt.versionId,
            appliedByMembershipId: AUTHOR.membershipId,
            appliedAt: NOW,
            effect: "metadata_only_no_server_content_mutation" as const,
          },
        }),
      ),
    });
    render(
      <StudioTeamTemplatesPage
        coordinator={coordinator}
        context={AUTHOR}
        online
        mutationFeatureEnabled
        expectedProjectRevision={7}
        onProjectRevisionAdvanced={advanced}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "应用一次到项目" }));
    expect(await screen.findByText(/模板已安全提交到本地/u)).toBeVisible();
    expect(document.body).not.toHaveTextContent("NETWORK_TIMEOUT");
    await user.click(screen.getByRole("button", { name: "仅重试云端回执" }));

    await waitFor(() => expect(coordinator.retryApplicationRecord).toHaveBeenCalledTimes(1));
    expect(coordinator.applyPublished).toHaveBeenCalledTimes(1);
    expect(advanced).toHaveBeenCalledWith(8);
  });

  it("exports archived plaintext history only through the explicit local callback", async () => {
    const user = userEvent.setup();
    const item = readyItem("Archived private title", "archived");
    const history = historyExport(item);
    const exported = vi.fn();
    const coordinator = fakeCoordinator({
      listTemplates: vi.fn(() => Promise.resolve(listView([item]))),
      exportTemplateHistory: vi.fn(() => Promise.resolve(history)),
    });
    render(
      <StudioTeamTemplatesPage
        coordinator={coordinator}
        context={AUTHOR}
        online
        mutationFeatureEnabled
        expectedProjectRevision={3}
        onExportHistory={exported}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "导出版本历史" }));

    expect(coordinator.exportTemplateHistory).toHaveBeenCalledWith(
      AUTHOR,
      item.template.templateId,
      expect.any(AbortSignal),
    );
    expect(exported).toHaveBeenCalledWith(history);
  });
});

const NOW = "2026-07-28T10:00:00.000Z";
const CREATED = "2026-07-28T09:00:00.000Z";

const AUTHOR: StudioTeamTemplateSessionContext = {
  tenantId: uuid(1),
  teamId: uuid(2),
  projectId: uuid(3),
  membershipId: uuid(4),
  deviceId: uuid(5),
  role: "author",
  membershipState: "active",
  assignmentState: "active",
};

function fakeCoordinator(
  overrides: Partial<StudioTeamTemplatesPageCoordinator> = {},
): StudioTeamTemplatesPageCoordinator {
  return {
    capabilities: vi.fn(() => ({
      read: true,
      create: true,
      createVersion: true,
      clone: true,
      apply: true,
      publish: false,
      archive: false,
    })),
    listTemplates: vi.fn(() => Promise.resolve(listView([readyItem("Private template")]))),
    createDraft: vi.fn(),
    clonePublished: vi.fn(),
    publishDraft: vi.fn(),
    archiveTemplate: vi.fn(),
    applyPublished: vi.fn(),
    retryApplicationRecord: vi.fn(),
    exportTemplateHistory: vi.fn(),
    ...overrides,
  };
}

function noCapabilities() {
  return {
    read: false,
    create: false,
    createVersion: false,
    clone: false,
    apply: false,
    publish: false,
    archive: false,
  };
}

function listView(items: readonly DecryptedStudioTeamTemplateListItem[]) {
  return {
    requestId: uuid(80),
    items,
    nextCursor: null,
  };
}

function readyItem(
  title: string,
  state: "draft" | "published" | "archived" = "published",
): Extract<DecryptedStudioTeamTemplateListItem, { state: "ready" }> {
  const templateId = uuid(state === "archived" ? 60 : state === "draft" ? 61 : 62);
  const versionId = uuid(state === "archived" ? 63 : state === "draft" ? 64 : 65);
  return {
    state: "ready",
    template: {
      schemaVersion: 1,
      tenantId: AUTHOR.tenantId,
      teamId: AUTHOR.teamId,
      projectId: AUTHOR.projectId,
      templateId,
      state,
      revision: state === "draft" ? 1 : state === "published" ? 2 : 3,
      latestVersionNumber: 1,
      publishedVersionNumber: state === "draft" ? null : 1,
      createdByMembershipId: AUTHOR.membershipId,
      createdAt: CREATED,
      updatedAt: NOW,
      publishedAt: state === "draft" ? null : NOW,
      archivedAt: state === "archived" ? NOW : null,
    },
    displayVersion: {
      schemaVersion: 1,
      tenantId: AUTHOR.tenantId,
      teamId: AUTHOR.teamId,
      projectId: AUTHOR.projectId,
      templateId,
      versionId,
      versionNumber: 1,
      projectKeyVersion: 1,
      authorMembershipId: AUTHOR.membershipId,
      authorDeviceId: AUTHOR.deviceId,
      clonedFromTemplateId: null,
      clonedFromVersionId: null,
      createdAt: CREATED,
    },
    payload: {
      schemaVersion: 1,
      kind: "team_template",
      title,
      projectSettings: [{ key: "genre", value: "mystery" }],
      promptRegistryRefs: [],
      promptRules: [],
      reviewChecklist: [],
    },
  };
}

function decryptErrorItem(): Extract<
  DecryptedStudioTeamTemplateListItem,
  { state: "decrypt_error" }
> {
  const ready = readyItem("Fallback template title");
  return {
    state: "decrypt_error",
    template: ready.template,
    displayVersion: ready.displayVersion,
    errorCode: "TEAM_TEMPLATE_CIPHERTEXT_CORRUPT",
  };
}

function partialRetry(): StudioTeamTemplateApplicationPartialRetry {
  return {
    status: "partial_retry",
    receipt: {
      authority: "local_team_template_application",
      applicationId: uuid(70),
      tenantId: AUTHOR.tenantId,
      teamId: AUTHOR.teamId,
      projectId: AUTHOR.projectId,
      templateId: uuid(62),
      templateRevision: 2,
      versionId: uuid(65),
      versionNumber: 1,
      contentDigest: "a".repeat(64),
      projectRevisionBefore: 7,
      projectRevisionAfter: 8,
      cloudIdempotencyKey: "team-template.page.partial.0001",
      requestedByMembershipId: AUTHOR.membershipId,
      appliedAt: NOW,
      cloudRecordedAt: null,
      result: "applied",
    },
    failureCode: "NETWORK_TIMEOUT",
  };
}

function historyExport(
  item: Extract<DecryptedStudioTeamTemplateListItem, { state: "ready" }>,
): StudioTeamTemplateHistoryExport {
  return {
    schemaVersion: 1,
    kind: "inkshadow_team_template_history",
    template: item.template,
    versions: [
      {
        state: "ready",
        version: {
          ...item.displayVersion,
          payload: {
            algorithm: "AES-256-GCM",
            nonce: "AAAAAAAAAAAAAAAA",
            ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
            ciphertextSha256: "0".repeat(64),
            aad: {
              schemaVersion: 1,
              purpose: "inkshadow.studio.team-template",
              tenantId: AUTHOR.tenantId,
              teamId: AUTHOR.teamId,
              projectId: AUTHOR.projectId,
              templateId: item.template.templateId,
              versionId: item.displayVersion.versionId,
              versionNumber: 1,
              projectKeyVersion: 1,
            },
          },
        },
        payload: item.payload,
      },
    ],
  };
}

function uuid(value: number): string {
  return `019f9f4a-b3c7-7350-9226-${value.toString().padStart(12, "0")}`;
}
