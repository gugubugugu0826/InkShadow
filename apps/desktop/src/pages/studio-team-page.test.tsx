/* eslint-disable @typescript-eslint/unbound-method -- Vitest mocks are context-free functions. */
import { CloudClientError } from "@inkshadow/cloud-client";
import type { CloudProjectAssignment, CloudTeam, CloudTeamMembership } from "@inkshadow/contracts";
import type {
  ProjectKeyBundle,
  TeamProjectKeyReceiptMetadata,
} from "@inkshadow/data/project-key-sqlite-store";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { CloudSessionCoordinatorError } from "../infrastructure/cloud-session-coordinator";
import type {
  CloudTeamProjectKeyEnvelopePort,
  CloudTeamProjectKeyPublicationPhase,
  CloudTeamProjectKeyPublicationState,
} from "../infrastructure/cloud-team-project-key-envelope-coordinator";
import type { CloudTeamWorkspacePort } from "../infrastructure/cloud-team-workspace-service";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";
import { StudioTeamPage } from "./studio-team-page";

const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000201";
const TEAM_ID = "019f9f4a-b3c7-7350-9226-000000000202";
const MEMBERSHIP_ID = "019f9f4a-b3c7-7350-9226-000000000203";
const SECOND_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000223";
const SECOND_MEMBERSHIP_ID = "019f9f4a-b3c7-7350-9226-000000000224";
const INVITATION_ID = "019f9f4a-b3c7-7350-9226-000000000204";
const PROJECT_ID = "019f9f4a-b3c7-7350-9226-000000000210";
const ASSIGNMENT_ID = "019f9f4a-b3c7-7350-9226-000000000211";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000212";
const ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000213";
const RECOVERY_ID = "019f9f4a-b3c7-7350-9226-000000000214";
const RECIPIENT_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000215";

describe("StudioTeamPage", () => {
  it("clears an invitation token before the request settles and prevents duplicate submission", async () => {
    const deferred = deferredPromise<never>();
    const service = createService();
    vi.mocked(service.acceptInvitation).mockReturnValue(deferred.promise);
    renderPage(service);
    const user = userEvent.setup();

    await screen.findByText("Studio Team");
    await user.type(screen.getByLabelText("邀请 ID"), INVITATION_ID);
    await user.clear(screen.getByLabelText("期望修订号"));
    await user.type(screen.getByLabelText("期望修订号"), "3");
    const tokenInput = screen.getByLabelText("一次性邀请 token");
    expect(tokenInput).toHaveAttribute("type", "password");
    await user.type(tokenInput, "super-secret-invitation-token");

    await user.click(screen.getByRole("button", { name: "接受邀请" }));

    expect(service.acceptInvitation).toHaveBeenCalledWith(
      INVITATION_ID,
      3,
      "super-secret-invitation-token",
    );
    expect(tokenInput).toHaveValue("");
    expect(screen.queryByDisplayValue("super-secret-invitation-token")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("super-secret-invitation-token");
    expect(screen.getByRole("button", { name: "正在处理" })).toBeDisabled();

    const pendingForm = screen.getByRole("button", { name: "正在处理" }).closest("form");
    if (pendingForm === null) {
      throw new Error("找不到邀请接受表单。");
    }
    fireEvent.submit(pendingForm);
    expect(service.acceptInvitation).toHaveBeenCalledTimes(1);

    deferred.reject(
      new CloudClientError({
        code: "REVISION_CONFLICT",
        message: "server accidentally echoed super-secret-invitation-token",
        status: 409,
        requestId: "019f9f4a-b3c7-7350-9226-000000000205",
        retryable: false,
      }),
    );
    await screen.findByText(/REVISION_CONFLICT · HTTP 409/u);
    expect(document.body.textContent).not.toContain("super-secret-invitation-token");
  });

  it("shows a signed-out state instead of fabricating an authenticated team result", async () => {
    const service = createService();
    vi.mocked(service.getCurrentAccountId).mockRejectedValue(
      new CloudSessionCoordinatorError(
        "reauth_required",
        "AUTH_SESSION_REQUIRED",
        "raw coordinator detail",
      ),
    );
    renderPage(service);

    expect(await screen.findByText("需要登录云账户")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往登录" })).toBeEnabled();
    expect(service.listTeams).not.toHaveBeenCalled();
  });

  it("renders a visible revision conflict and keeps retry/error states actionable", async () => {
    const service = createService();
    vi.mocked(service.createTeam).mockRejectedValue(
      new CloudClientError({
        code: "REVISION_CONFLICT",
        message: "untrusted server detail",
        status: 412,
        requestId: "019f9f4a-b3c7-7350-9226-000000000206",
        retryable: false,
      }),
    );
    renderPage(service);
    const user = userEvent.setup();

    await screen.findByText("Studio Team");
    await user.type(screen.getByLabelText("团队名称"), "New Studio");
    await user.click(screen.getByRole("button", { name: "创建团队" }));

    expect(await screen.findByText(/REVISION_CONFLICT · HTTP 412/u)).toBeInTheDocument();
    expect(screen.getByText(/最后一位所有者保护/u)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("untrusted server detail");
  });

  it("requires an impact confirmation before changing roles or project access", async () => {
    const service = createService();
    vi.mocked(service.listTeamMembers).mockResolvedValue({
      schemaVersion: 1,
      requestId: "019f9f4a-b3c7-7350-9226-000000000225",
      memberships: [membership(), secondaryMembership()],
      nextCursor: null,
    });
    renderPage(service);
    const user = userEvent.setup();

    const roleSelect = await screen.findByLabelText(`更改 ${SECOND_ACCOUNT_ID} 的角色`);
    await user.selectOptions(roleSelect, "reviewer");

    expect(service.changeMemberRole).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认更改成员角色" })).toBeVisible();
    expect(screen.getByText(/提交后会立即影响该成员的团队权限/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认提交" }));
    await waitFor(() =>
      expect(service.changeMemberRole).toHaveBeenCalledWith(
        TEAM_ID,
        SECOND_MEMBERSHIP_ID,
        1,
        "reviewer",
      ),
    );

    await loadProjectAssignments(user);
    await user.click(screen.getByRole("button", { name: "启用分配" }));

    expect(service.setProjectAssignment).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "确认授予项目权限" })).toBeVisible();
    expect(screen.getByText(/端到端密钥仍需单独发放/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "确认提交" }));
    await waitFor(() =>
      expect(service.setProjectAssignment).toHaveBeenCalledWith(
        TEAM_ID,
        PROJECT_ID,
        SECOND_MEMBERSHIP_ID,
        null,
        "active",
      ),
    );
  });

  it("auto-resolves the active local key version and publishes every eligible device", async () => {
    const service = createService();
    const keys = createKeyRuntime();
    renderPage(service, keys);
    const user = userEvent.setup();

    await loadProjectAssignments(user);
    expect(keys.getStatus).toHaveBeenCalledTimes(1);
    expect(keys.loadProjectKeyBundle).toHaveBeenCalledWith(PROJECT_ID, DEVICE_ID);
    expect(screen.getByText("已验证本地有效密钥版本 3。")).toBeInTheDocument();
    expect(screen.queryByLabelText(/密钥版本/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "为全部合资格设备发放密钥" }));

    const publishCall = vi.mocked(keys.keyService.publishAllEligibleRecipients).mock.calls[0];
    expect(publishCall?.slice(0, 3)).toEqual([TEAM_ID, PROJECT_ID, 3]);
    expect(publishCall?.[3]?.signal).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("已发布 2 / 2 个合资格设备")).toBeInTheDocument();
    expect(screen.getByText("团队项目密钥已发放至 2 个合资格设备。")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("A".repeat(87));
    expect(document.body.textContent).not.toContain("a".repeat(64));
    expect(document.body.textContent).not.toContain("ciphertext");
    expect(document.body.textContent).not.toContain("recovery-code");
  });

  it("accepts the authoritative current version and renders persisted open-ready metadata", async () => {
    const service = createService();
    const keys = createKeyRuntime();
    renderPage(service, keys);
    const user = userEvent.setup();

    await loadProjectAssignments(user);
    await user.click(screen.getByRole("button", { name: "验证并保存当前设备授权" }));

    const verifyCall = vi.mocked(keys.keyService.verifyCurrentDeviceEnvelope).mock.calls[0];
    expect(verifyCall?.slice(0, 2)).toEqual([TEAM_ID, PROJECT_ID]);
    expect(verifyCall?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText("当前设备的团队密钥授权已验证")).toBeInTheDocument();
    expect(screen.getByText(/授权版本 3，云端安全记录修订 9/u)).toBeInTheDocument();
    expect(screen.getByText(/本机状态 已新建/u)).toBeInTheDocument();
    expect(screen.getByText(/cccccccccccccccc…/u)).toBeInTheDocument();
    expect(screen.getByText(/撤销会阻止未来同步与新版本授权/u)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("ciphertext");
    expect(document.body.textContent).not.toContain("encapsulatedKey");
    expect(document.body.textContent).not.toContain("rawProjectDataKey");
    expect(document.body.textContent).not.toContain("privateKey");
  });

  it("shows partial and retryable states without fabricating success", async () => {
    const service = createService();
    const keys = createKeyRuntime();
    const transient = new CloudClientError({
      code: "CLOUD_NETWORK_UNAVAILABLE",
      message: "untrusted transport detail",
      status: null,
      requestId: null,
      retryable: true,
    });
    vi.mocked(keys.keyService.publishAllEligibleRecipients)
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient);
    vi.mocked(keys.keyService.getPublicationState)
      .mockReturnValueOnce(publicationState("partial", 1, 2))
      .mockReturnValueOnce(publicationState("retryable", 1, 2));
    renderPage(service, keys);
    const user = userEvent.setup();
    await loadProjectAssignments(user);
    const publish = screen.getByRole("button", { name: "为全部合资格设备发放密钥" });

    await user.click(publish);
    expect(await screen.findByText("部分完成")).toBeInTheDocument();
    expect(screen.getByText("已发布 1 / 2 个合资格设备")).toBeInTheDocument();
    expect(screen.queryByText(/团队项目密钥已发放至/u)).not.toBeInTheDocument();
    expect(publish).toBeEnabled();

    await user.click(publish);
    expect(await screen.findByText("可安全重试")).toBeInTheDocument();
    expect(screen.getByText("已发布 1 / 2 个合资格设备")).toBeInTheDocument();
    expect(screen.queryByText(/团队项目密钥已发放至/u)).not.toBeInTheDocument();
  });

  it("keeps publication disabled but allows authoritative verification without a local key", async () => {
    const service = createService();
    const keys = createKeyRuntime({ bundle: null });
    renderPage(service, keys);
    const user = userEvent.setup();

    await loadProjectAssignments(user);

    expect(await screen.findByText("当前设备没有该项目的有效本地密钥包。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "为全部合资格设备发放密钥" })).toBeDisabled();
    expect(keys.keyService.publishAllEligibleRecipients).not.toHaveBeenCalled();
    const verify = screen.getByRole("button", { name: "验证并保存当前设备授权" });
    expect(verify).toBeEnabled();
    expect(screen.getByText(/当前设备验收不依赖本地密钥包/u)).toBeInTheDocument();
    expect(screen.queryByLabelText(/密钥版本/u)).not.toBeInTheDocument();

    await user.click(verify);
    expect(await screen.findByText("当前设备的团队密钥授权已验证")).toBeInTheDocument();
    const verifyCall = vi.mocked(keys.keyService.verifyCurrentDeviceEnvelope).mock.calls[0];
    expect(verifyCall?.slice(0, 2)).toEqual([TEAM_ID, PROJECT_ID]);
    expect(verifyCall?.[2]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("restores persisted/open-ready team receipt truth after restart", async () => {
    const service = createService();
    const receipt = persistedTeamReceipt();
    const keys = createKeyRuntime({ bundle: null, receipt });
    renderPage(service, keys);
    const user = userEvent.setup();

    await loadProjectAssignments(user);

    expect(await screen.findByText("团队密钥已持久化且可离线开启")).toBeInTheDocument();
    expect(screen.getByText(/本机授权版本 3，状态 有效/u)).toBeInTheDocument();
    expect(keys.loadTeamProjectKeyReceipt).toHaveBeenCalledWith({
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
    });
    expect(keys.inspectTeamManagedProjectKeyReceipt).toHaveBeenCalledWith(
      receipt,
      "019f9f4a-b3c7-7350-9226-000000000222",
    );
  });

  it("requires the verified assignment-management permission before publication", async () => {
    const service = createService();
    vi.mocked(service.listProjectAssignments).mockResolvedValue(
      assignmentResponse([
        assignment({
          membershipId: "019f9f4a-b3c7-7350-9226-000000000216",
        }),
      ]),
    );
    const keys = createKeyRuntime();
    renderPage(service, keys);
    const user = userEvent.setup();

    await loadProjectAssignments(user);

    expect(
      screen.getAllByText("当前成员没有该项目的有效分配，不能管理项目成员。"),
    ).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "为全部合资格设备发放密钥" })).toBeDisabled();
    expect(keys.keyService.publishAllEligibleRecipients).not.toHaveBeenCalled();
  });

  it("keeps the assignment-versus-envelope warning when the key service is missing", async () => {
    const service = createService();
    renderPage(service);
    const user = userEvent.setup();

    await loadProjectAssignments(user);

    expect(
      await screen.findByText("当前运行环境未配置团队密钥发放所需的原生云身份与本地密钥存储。"),
    ).toBeInTheDocument();
    expect(screen.getByText("项目权限不等于端到端密钥授权")).toBeInTheDocument();
    expect(
      screen.getByText(
        "当前仅能管理云端业务访问范围，未配置团队项目密钥授权服务。项目权限不会自动产生端到端密钥授权。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "为全部合资格设备发放密钥" })).toBeDisabled();
  });

  it("opens the exact team/project encrypted-review route only after active assignment proof", async () => {
    const service = createService();
    renderPage(service, undefined, true);
    const user = userEvent.setup();

    await loadProjectAssignments(user);
    const openReview = screen.getByRole("button", { name: "打开加密审阅" });
    expect(openReview).toBeEnabled();
    await user.click(openReview);

    expect(screen.getByTestId("team-route-location")).toHaveTextContent(
      `/teams/${TEAM_ID}/projects/${PROJECT_ID}/reviews`,
    );
  });
});

function renderPage(
  service: CloudTeamWorkspacePort,
  keys?: ReturnType<typeof createKeyRuntime>,
  reviewAvailable = false,
): void {
  const base = createDevelopmentRuntime(window.localStorage);
  const runtime = {
    ...base,
    cloudTeams: service,
    cloudTeamProjectKeys: keys?.keyService ?? null,
    cloudIdentity:
      keys === undefined
        ? null
        : {
            getStatus: keys.getStatus,
          },
    cloudFoundation:
      keys === undefined
        ? null
        : {
            projectKeys: {
              loadProjectKeyBundle: keys.loadProjectKeyBundle,
              loadTeamProjectKeyReceipt: keys.loadTeamProjectKeyReceipt,
            },
          },
    projectSecurity:
      keys === undefined
        ? null
        : {
            inspectTeamManagedProjectKeyReceipt: keys.inspectTeamManagedProjectKeyReceipt,
          },
    studioReview: reviewAvailable ? ({} as DesktopRuntime["studioReview"]) : null,
  } as unknown as DesktopRuntime;
  render(
    <MemoryRouter initialEntries={["/teams"]}>
      <RuntimeProvider runtime={runtime}>
        <StudioTeamPage />
        <LocationProbe />
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

function LocationProbe() {
  return <output data-testid="team-route-location">{useLocation().pathname}</output>;
}

function createService(): CloudTeamWorkspacePort {
  return {
    getCurrentAccountId: vi.fn().mockResolvedValue(ACCOUNT_ID),
    createTeam: vi.fn(),
    listTeams: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: "019f9f4a-b3c7-7350-9226-000000000207",
      teams: [team()],
      nextCursor: null,
    }),
    listTeamMembers: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      requestId: "019f9f4a-b3c7-7350-9226-000000000208",
      memberships: [membership()],
      nextCursor: null,
    }),
    createInvitation: vi.fn(),
    acceptInvitation: vi.fn(),
    changeMemberRole: vi.fn(),
    revokeMembership: vi.fn(),
    listProjectAssignments: vi.fn().mockResolvedValue(assignmentResponse([assignment()])),
    setProjectAssignment: vi.fn(),
  };
}

async function loadProjectAssignments(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText(ACCOUNT_ID);
  await user.type(screen.getByLabelText("项目 ID"), PROJECT_ID);
  await waitFor(() => expect(screen.getByRole("button", { name: "读取分配" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "读取分配" }));
  await screen.findByText("设置成员项目权限");
}

function createKeyRuntime(
  options: {
    readonly bundle?: ProjectKeyBundle | null;
    readonly receipt?: TeamProjectKeyReceiptMetadata | null;
  } = {},
) {
  const bundle = options.bundle === undefined ? activeProjectKeyBundle() : options.bundle;
  const receipt = options.receipt ?? null;
  const getStatus = vi.fn().mockResolvedValue({
    configured: true,
    account: { accountId: ACCOUNT_ID },
    device: {
      device: {
        deviceId: DEVICE_ID,
      },
    },
    session: { sessionId: "019f9f4a-b3c7-7350-9226-000000000222" },
  });
  const loadProjectKeyBundle = vi.fn().mockResolvedValue({
    ok: true as const,
    value: bundle,
  });
  const loadTeamProjectKeyReceipt = vi.fn().mockResolvedValue({
    ok: true as const,
    value: receipt,
  });
  const inspectTeamManagedProjectKeyReceipt = vi
    .fn()
    .mockImplementation((value: TeamProjectKeyReceiptMetadata) =>
      Promise.resolve({
        receipt: value,
        nativeConfigured: true,
        openReady: value.state !== "credential_missing",
      }),
    );
  const publishAllEligibleRecipients = vi
    .fn<CloudTeamProjectKeyEnvelopePort["publishAllEligibleRecipients"]>()
    .mockResolvedValue(publicationState("published", 2, 2));
  const verifyCurrentDeviceEnvelope = vi
    .fn<CloudTeamProjectKeyEnvelopePort["verifyCurrentDeviceEnvelope"]>()
    .mockResolvedValue({
      capabilityState: "persisted_team_managed_receipt",
      keyVersionDiscovery: "authoritative_team_current_metadata",
      verificationState: "verified_native_hpke",
      persistenceState: "persisted_open_ready",
      recoveryModel: "redownload_current_device_envelope",
      nativeWriteState: "created",
      receipt: {
        schemaVersion: 1,
        receiptKind: "team_managed_device_envelope",
        envelopeId: ENVELOPE_ID,
        teamId: TEAM_ID,
        projectId: PROJECT_ID,
        keyVersion: 3,
        accountId: ACCOUNT_ID,
        deviceId: DEVICE_ID,
        currentServerRevision: 9,
        currentKeyUpdatedAt: "2026-01-01T00:00:00.000Z",
        membershipId: MEMBERSHIP_ID,
        membershipRevision: 1,
        assignmentId: ASSIGNMENT_ID,
        assignmentRevision: 1,
        senderDeviceId: RECIPIENT_DEVICE_ID,
        senderPublicKeyFingerprint: "b".repeat(64),
        recipientPublicKeyFingerprint: "a".repeat(64),
        projectKeyFingerprint: "c".repeat(64),
        nativeStorageRef: `team_project_key_receipt_v1_${"d".repeat(64)}`,
        nativeReceiptFingerprint: "e".repeat(64),
        envelopeCreatedAt: "2026-01-01T00:00:00.000Z",
        state: "active",
        receivedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: "2026-01-01T00:00:00.000Z",
        stateUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  const keyService = {
    publishAllEligibleRecipients,
    publishEligibleRecipient: vi.fn(),
    verifyCurrentDeviceEnvelope,
    getPublicationState: vi.fn().mockReturnValue(null),
  } satisfies CloudTeamProjectKeyEnvelopePort;
  return {
    getStatus,
    keyService,
    loadProjectKeyBundle,
    loadTeamProjectKeyReceipt,
    inspectTeamManagedProjectKeyReceipt,
  };
}

function assignmentResponse(assignments: readonly CloudProjectAssignment[]) {
  return {
    schemaVersion: 1 as const,
    requestId: "019f9f4a-b3c7-7350-9226-000000000217",
    assignments: [...assignments],
    nextCursor: null,
  };
}

function assignment(overrides: Readonly<{ membershipId?: string }> = {}): CloudProjectAssignment {
  return {
    schemaVersion: 1,
    assignmentId: ASSIGNMENT_ID,
    tenantId: "019f9f4a-b3c7-7350-9226-000000000209",
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    membershipId: overrides.membershipId ?? MEMBERSHIP_ID,
    state: "active",
    revision: 1,
    grantedByMembershipId: MEMBERSHIP_ID,
    revokedByMembershipId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
  };
}

function activeProjectKeyBundle(): ProjectKeyBundle {
  return {
    version: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      keyVersion: 3,
      algorithm: "AES-256-GCM",
      state: "active",
      revision: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      retiredAt: null,
    },
    deviceEnvelope: {
      schemaVersion: 1,
      algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
      envelopeId: ENVELOPE_ID,
      projectId: PROJECT_ID,
      keyVersion: 3,
      senderDeviceId: DEVICE_ID,
      senderPublicKey: "A".repeat(87),
      senderPublicKeyFingerprint: "a".repeat(64),
      recipientDeviceId: DEVICE_ID,
      recipientPublicKey: "A".repeat(87),
      recipientPublicKeyFingerprint: "a".repeat(64),
      encapsulatedKey: "B".repeat(87),
      ciphertext: "C".repeat(64),
      createdAt: "2026-01-01T00:00:00.000Z",
      revokedAt: null,
    },
    recoveryEnvelope: {
      schemaVersion: 1,
      algorithm: "ARGON2ID-AES256GCM",
      recoveryId: RECOVERY_ID,
      projectId: PROJECT_ID,
      keyVersion: 3,
      kdf: {
        algorithm: "ARGON2ID",
        version: 19,
        memoryKib: 65_536,
        timeCost: 3,
        parallelism: 4,
        outputBytes: 64,
      },
      salt: "D".repeat(22),
      nonce: "E".repeat(16),
      ciphertext: "F".repeat(64),
      verifier: "G".repeat(43),
      createdAt: "2026-01-01T00:00:00.000Z",
      confirmedAt: "2026-01-01T00:01:00.000Z",
      revokedAt: null,
    },
  };
}

function persistedTeamReceipt(): TeamProjectKeyReceiptMetadata {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    receiptKind: "team_managed_device_envelope",
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    envelopeId: ENVELOPE_ID,
    membershipId: MEMBERSHIP_ID,
    membershipRevision: 1,
    assignmentId: ASSIGNMENT_ID,
    assignmentRevision: 1,
    senderDeviceId: RECIPIENT_DEVICE_ID,
    senderPublicKeyFingerprint: "b".repeat(64),
    recipientPublicKeyFingerprint: "a".repeat(64),
    projectKeyFingerprint: "c".repeat(64),
    nativeStorageRef: `team_project_key_receipt_v1_${"d".repeat(64)}`,
    nativeReceiptFingerprint: "e".repeat(64),
    currentServerRevision: 9,
    currentKeyUpdatedAt: now,
    envelopeCreatedAt: now,
    state: "active",
    receivedAt: now,
    lastVerifiedAt: now,
    stateUpdatedAt: now,
  };
}

function publicationState(
  phase: CloudTeamProjectKeyPublicationPhase,
  publishedCount: number,
  recipientCount: number,
): CloudTeamProjectKeyPublicationState {
  return {
    teamId: TEAM_ID,
    projectId: PROJECT_ID,
    keyVersion: 3,
    senderDeviceId: DEVICE_ID,
    phase,
    recipientCount,
    publishedCount,
    recipients: Array.from({ length: recipientCount }, (_, index) => ({
      assignmentId: index === 0 ? ASSIGNMENT_ID : "019f9f4a-b3c7-7350-9226-000000000218",
      assignmentRevision: 1,
      envelopeId: index === 0 ? ENVELOPE_ID : "019f9f4a-b3c7-7350-9226-000000000219",
      membershipId: index === 0 ? MEMBERSHIP_ID : "019f9f4a-b3c7-7350-9226-000000000220",
      membershipRevision: 1,
      recipientDeviceId: index === 0 ? RECIPIENT_DEVICE_ID : "019f9f4a-b3c7-7350-9226-000000000221",
      status:
        index < publishedCount ? "published" : phase === "conflicted" ? "conflicted" : "sealed",
    })),
  };
}

function team(): CloudTeam {
  return {
    schemaVersion: 1,
    teamId: TEAM_ID,
    tenantId: "019f9f4a-b3c7-7350-9226-000000000209",
    displayName: "Studio Team",
    state: "active",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  };
}

function membership(): CloudTeamMembership {
  return {
    schemaVersion: 1,
    membershipId: MEMBERSHIP_ID,
    accountId: ACCOUNT_ID,
    tenantId: "019f9f4a-b3c7-7350-9226-000000000209",
    teamId: TEAM_ID,
    role: "owner",
    state: "active",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
  };
}

function secondaryMembership(): CloudTeamMembership {
  return {
    ...membership(),
    membershipId: SECOND_MEMBERSHIP_ID,
    accountId: SECOND_ACCOUNT_ID,
    role: "author",
  };
}

function deferredPromise<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}
