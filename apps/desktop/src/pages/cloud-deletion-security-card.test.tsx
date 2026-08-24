import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CloudDeletionJournal } from "@inkshadow/data";
import type { Project } from "@inkshadow/domain";
import { describe, expect, it, vi } from "vitest";

import type {
  CloudDeletionLifecycleResult,
  CloudDeletionLifecycleService,
} from "../infrastructure/cloud-deletion-lifecycle-service";
import { CloudDeletionSecurityCard } from "./cloud-deletion-security-card";

const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000401";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000402";
const JOURNAL_ID = "019f9f4a-b3c7-7350-9226-000000000403";
const MUTATION_ID = "019f9f4a-b3c7-7350-9226-000000000404";
const CONFIRMATION_ID = "019f9f4a-b3c7-7350-9226-000000000405";
const DELETION_REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000406";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000407";
const NOW = "2026-07-28T03:00:00.000Z";
const PROJECT_NAME = "雾港纪事";
const PASSWORD = "test-valid-deletion-password";
const EMAIL = "writer@example.com";

describe("CloudDeletionSecurityCard", () => {
  it("keeps safe focus, requires the exact project name, and clears password before await", async () => {
    const deferred = createDeferred<CloudDeletionLifecycleResult>();
    const service = createService();
    service.requestProjectDeletion.mockImplementation((input) => {
      input.clearPassword();
      return deferred.promise;
    });
    const user = userEvent.setup();
    render(<CloudDeletionSecurityCard selectedProject={project()} service={asService(service)} />);

    await user.click(await screen.findByRole("button", { name: "永久删除此项目的云端数据" }));
    const dialog = await screen.findByRole("dialog", {
      name: "永久删除此项目的云端数据？",
    });
    const confirmation = within(dialog).getByLabelText(`精确输入项目名“${PROJECT_NAME}”`);
    const password = within(dialog).getByLabelText("当前云账户密码");
    const danger = within(dialog).getByRole("button", { name: "进入 30 日删除宽限期" });
    await waitFor(() => expect(confirmation).toHaveFocus());
    expect(danger).not.toHaveFocus();

    await user.type(confirmation, ` ${PROJECT_NAME}`);
    await user.type(password, PASSWORD);
    expect(danger).toBeDisabled();
    await user.clear(confirmation);
    await user.type(confirmation, PROJECT_NAME);
    expect(danger).toBeEnabled();
    await user.click(danger);

    await waitFor(() => expect(password).toHaveValue(""));
    const request = service.requestProjectDeletion.mock.calls[0]?.[0];
    expect(request?.projectId).toBe(PROJECT_ID);
    expect(request?.password).toBe(PASSWORD);
    expect(typeof request?.clearPassword).toBe("function");
    deferred.resolve(lifecycleResult(projectJournal()));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "永久删除此项目的云端数据？" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("requires canonical email confirmation and exposes no-session account lookup/cancel recovery", async () => {
    const account = accountJournal();
    const service = createService();
    service.listRecoverable.mockResolvedValue([account]);
    service.lookupAccountDeletion.mockImplementation((input) => {
      input.clearPassword();
      return Promise.resolve(lifecycleResult(account));
    });
    service.cancelAccountDeletion.mockImplementation((input) => {
      input.clearPassword();
      return Promise.resolve(
        lifecycleResult(
          accountJournal({
            state: "cancelled",
            canCancel: false,
            revision: 2,
            completedAt: "2026-07-28T03:02:00.000Z",
          }),
        ),
      );
    });
    const user = userEvent.setup();
    render(<CloudDeletionSecurityCard selectedProject={project()} service={asService(service)} />);

    await user.click(await screen.findByRole("button", { name: "使用邮箱和密码查询" }));
    let dialog = await screen.findByRole("dialog", { name: "查询账户删除状态" });
    expect(within(dialog).getByText("已安全保存删除请求凭据")).toBeVisible();
    expect(within(dialog).queryByText(DELETION_REQUEST_ID)).not.toBeInTheDocument();
    const lookupPassword = within(dialog).getByLabelText("当前云账户密码");
    await waitFor(() => expect(lookupPassword).toHaveFocus());
    expect(within(dialog).getByRole("button", { name: "查询状态" })).not.toHaveFocus();
    await user.type(lookupPassword, PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "查询状态" }));
    await waitFor(() => expect(service.lookupAccountDeletion).toHaveBeenCalledTimes(1));
    expect(service.lookupAccountDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        journalId: JOURNAL_ID,
        email: EMAIL,
        password: PASSWORD,
      }),
    );

    await user.click(await screen.findByRole("button", { name: "在宽限期内取消账户删除" }));
    dialog = await screen.findByRole("dialog", { name: "取消账户删除？" });
    await user.type(within(dialog).getByLabelText("当前云账户密码"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "确认取消账户删除" }));
    await waitFor(() => expect(service.cancelAccountDeletion).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("账户删除已取消；需要重新登录才能继续使用云能力。"),
    ).toBeVisible();
  });

  it("does not enable account submission until the canonical email is typed exactly", async () => {
    const service = createService();
    const user = userEvent.setup();
    render(<CloudDeletionSecurityCard selectedProject={project()} service={asService(service)} />);

    await user.click(await screen.findByRole("button", { name: "申请永久删除云账户" }));
    const dialog = await screen.findByRole("dialog", { name: "永久删除整个云账户？" });
    await user.type(within(dialog).getByLabelText("云账户邮箱"), "Writer@Example.com");
    await user.type(within(dialog).getByLabelText("再次精确输入规范化邮箱"), "Writer@Example.com");
    await user.type(within(dialog).getByLabelText("当前云账户密码"), PASSWORD);
    const submit = within(dialog).getByRole("button", {
      name: "退出会话并进入删除宽限期",
    });
    expect(submit).toBeDisabled();

    await user.clear(within(dialog).getByLabelText("再次精确输入规范化邮箱"));
    await user.type(within(dialog).getByLabelText("再次精确输入规范化邮箱"), EMAIL);
    expect(submit).toBeEnabled();
  });

  it("offers confirmation-id receipt recovery when account acceptance may have lost its response", async () => {
    const pending = pendingAccountJournal();
    const recovered = accountJournal();
    const service = createService();
    service.listRecoverable.mockResolvedValue([pending]);
    service.lookupAccountDeletion.mockImplementation((input) => {
      input.clearPassword();
      return Promise.resolve(lifecycleResult(recovered));
    });
    const user = userEvent.setup();
    render(<CloudDeletionSecurityCard selectedProject={project()} service={asService(service)} />);

    expect(
      await screen.findByText(
        "本机已保存恢复同一次删除申请所需的安全记录；若云会话已失效，可直接用邮箱和密码恢复服务端回执。密码不会从本机恢复或持久化。",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "使用邮箱和密码恢复删除回执" }));
    const dialog = await screen.findByRole("dialog", { name: "查询账户删除状态" });
    expect(within(dialog).getByText("已安全保存确认号")).toBeVisible();
    await user.type(within(dialog).getByLabelText("当前云账户密码"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "查询状态" }));

    await waitFor(() => expect(service.lookupAccountDeletion).toHaveBeenCalledTimes(1));
    expect(service.lookupAccountDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        journalId: JOURNAL_ID,
        email: EMAIL,
        password: PASSWORD,
      }),
    );
  });

  it("maps a durable deletion phase to ordinary Chinese instead of exposing the internal value", async () => {
    const service = createService();
    service.findProject.mockResolvedValue(projectJournal());

    render(<CloudDeletionSecurityCard selectedProject={project()} service={asService(service)} />);

    expect(await screen.findByText("冻结云端变更")).toBeVisible();
    expect(screen.queryByText("freeze")).not.toBeInTheDocument();
  });

  it("keeps cloud deletion diagnostics out of the ordinary error alert", async () => {
    const service = createService();
    service.listRecoverable.mockRejectedValue({
      code: "CLOUD_DELETE_PRIVATE_CAUSE",
      message: "Authorization: Bearer must-not-render",
    });

    render(<CloudDeletionSecurityCard selectedProject={project()} service={asService(service)} />);

    expect(await screen.findByText("云端删除操作未完成")).toBeVisible();
    expect(screen.getByText(/云端操作未完成。本地正文仍可使用/u)).toBeVisible();
    expect(
      screen.queryByText(/CLOUD_DELETE_PRIVATE_CAUSE|Authorization: Bearer/u),
    ).not.toBeInTheDocument();
  });
});

function createService() {
  return {
    findProject: vi.fn<CloudDeletionLifecycleService["findProject"]>().mockResolvedValue(null),
    listRecoverable: vi
      .fn<CloudDeletionLifecycleService["listRecoverable"]>()
      .mockResolvedValue([]),
    requestProjectDeletion: vi.fn<CloudDeletionLifecycleService["requestProjectDeletion"]>(),
    refreshProjectDeletion: vi.fn<CloudDeletionLifecycleService["refreshProjectDeletion"]>(),
    cancelProjectDeletion: vi.fn<CloudDeletionLifecycleService["cancelProjectDeletion"]>(),
    requestAccountDeletion: vi.fn<CloudDeletionLifecycleService["requestAccountDeletion"]>(),
    lookupAccountDeletion: vi.fn<CloudDeletionLifecycleService["lookupAccountDeletion"]>(),
    cancelAccountDeletion: vi.fn<CloudDeletionLifecycleService["cancelAccountDeletion"]>(),
  };
}

function asService(service: ReturnType<typeof createService>): CloudDeletionLifecycleService {
  return service as unknown as CloudDeletionLifecycleService;
}

function project(): Project {
  return {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    status: "active",
  } as unknown as Project;
}

function lifecycleResult(journal: CloudDeletionJournal): CloudDeletionLifecycleResult {
  if (journal.latestReceipt === null) {
    throw new Error("Test journal needs a receipt.");
  }
  return { journal, receipt: journal.latestReceipt };
}

function projectJournal(): CloudDeletionJournal {
  return journal("project", PROJECT_ID, null);
}

function accountJournal(
  overrides: {
    readonly state?: "cancelled" | "grace_period";
    readonly canCancel?: boolean;
    readonly revision?: number;
    readonly completedAt?: string | null;
  } = {},
): CloudDeletionJournal {
  return journal("account", ACCOUNT_ID, EMAIL, overrides);
}

function pendingAccountJournal(): CloudDeletionJournal {
  const accepted = accountJournal();
  if (accepted.activeMutation === null) {
    throw new Error("The account deletion fixture needs an active mutation.");
  }
  return {
    ...accepted,
    activeMutation: {
      ...accepted.activeMutation,
      lastErrorCode: "CLOUD_NETWORK_UNAVAILABLE",
      responseRequestId: null,
      responseRevision: null,
      state: "retryable_error",
    },
    deletionRequestId: null,
    latestReceipt: null,
    recoveryAction: "submit",
    lastErrorCode: "CLOUD_NETWORK_UNAVAILABLE",
  };
}

function journal(
  targetKind: "account" | "project",
  targetId: string,
  accountEmail: string | null,
  overrides: {
    readonly state?: "cancelled" | "grace_period";
    readonly canCancel?: boolean;
    readonly revision?: number;
    readonly completedAt?: string | null;
  } = {},
): CloudDeletionJournal {
  const state = overrides.state ?? "grace_period";
  const receipt = {
    schemaVersion: 1 as const,
    requestId: REQUEST_ID,
    deletionRequest: {
      schemaVersion: 1 as const,
      deletionRequestId: DELETION_REQUEST_ID,
      targetKind,
      targetId,
      state,
      phase: "freeze" as const,
      revision: overrides.revision ?? 1,
      requestedAt: NOW,
      scheduledFor: "2026-08-27T03:00:00.000Z",
      cancellableUntil: "2026-08-27T03:00:00.000Z",
      commitStartedAt: null,
      liveDataPurgedAt: null,
      backupRetainedUntil: null,
      completedAt: overrides.completedAt ?? null,
      blockedReason: null,
      canCancel: overrides.canCancel ?? true,
      impactSummary: {
        projectCount: targetKind === "project" ? 1 : 2,
        syncOperationCount: 12,
        encryptedChunkCount: 4,
        keyEnvelopeCount: 3,
        deviceCount: targetKind === "account" ? 2 : 0,
        sessionCount: targetKind === "account" ? 2 : 0,
      },
    },
  };
  return {
    journalId: JOURNAL_ID,
    targetKind,
    targetId,
    accountEmail,
    activeMutation: {
      mutationId: MUTATION_ID,
      journalId: JOURNAL_ID,
      requestType: "submission",
      confirmationId: CONFIRMATION_ID,
      idempotencyKey: "deletion-idempotency-0401",
      expectedRevision: 1,
      requestBodySha256: "a".repeat(64),
      state: "accepted",
      responseRequestId: REQUEST_ID,
      responseRevision: overrides.revision ?? 1,
      lastErrorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    deletionRequestId: DELETION_REQUEST_ID,
    latestReceipt: receipt,
    recoveryAction:
      state === "cancelled" ? "none" : targetKind === "account" ? "lookup" : "refresh",
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function createDeferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
