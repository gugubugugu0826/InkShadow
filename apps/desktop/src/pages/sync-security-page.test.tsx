import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ok } from "@inkshadow/domain";
import type {
  DevicePublicKeyRecord,
  ProjectKeyBundle,
} from "@inkshadow/data/project-key-sqlite-store";
import type { ProjectSyncRegistration } from "@inkshadow/data";
import { ToastProvider } from "@inkshadow/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopRoutes } from "../app";
import { createDevelopmentRuntime, type DesktopRuntime } from "../infrastructure/runtime";
import { RuntimeProvider } from "../runtime-context";

const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const ENVELOPE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const RECOVERY_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const OTHER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const OTHER_SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000008";
const NOW = "2026-07-27T03:00:00.000Z";
const RECOVERY_CODE_FOR_INTERACTION = "test-only-recovery-code";

describe("SyncSecurityPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("fails closed in browser development without emulating device secrets", async () => {
    const runtime = createDevelopmentRuntime(window.localStorage);
    await seedProject(runtime);

    renderRoute(runtime);

    expect(await screen.findByRole("heading", { name: "同步安全", level: 1 })).toBeVisible();
    expect(screen.getByText(/浏览器开发模式不会创建、模拟或保存设备私钥和恢复码/u)).toBeVisible();
    expect(await screen.findByRole("button", { name: "创建设备身份" })).toBeDisabled();
  });

  it("requires an explicit one-time recovery confirmation before activation", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const projectId = await seedProject(baseRuntime);
    let device: DevicePublicKeyRecord | null = null;
    let bundle: ProjectKeyBundle | null = null;

    const projectKeys = {
      listLocalDevicePublicKeys: vi.fn(() =>
        Promise.resolve(ok<readonly DevicePublicKeyRecord[]>(device === null ? [] : [device])),
      ),
      loadProjectKeyBundle: vi.fn(() => Promise.resolve(ok(bundle))),
    };
    const projectSecurity = {
      ensureLocalDeviceIdentity: vi.fn(({ displayName }: { displayName: string }) => {
        device = deviceRecord(displayName);
        return Promise.resolve(device);
      }),
      prepareInitialProjectKey: vi.fn(() => {
        bundle = pendingBundle(projectId);
        return Promise.resolve({
          projectId,
          keyVersion: 1,
          deviceId: DEVICE_ID,
          projectKeyFingerprint: "b".repeat(64),
          recoveryCode: RECOVERY_CODE_FOR_INTERACTION,
        });
      }),
      confirmPendingProjectKey: vi.fn(() => {
        if (bundle === null) {
          return Promise.reject(new Error("Missing pending bundle"));
        }
        bundle = {
          ...bundle,
          version: { ...bundle.version, state: "active", revision: 2 },
          recoveryEnvelope: {
            ...bundle.recoveryEnvelope,
            confirmedAt: "2026-07-27T03:01:00.000Z",
          },
        };
        return Promise.resolve(bundle);
      }),
      abandonPendingProjectKeySetup: vi.fn(() => {
        bundle = null;
        return Promise.resolve();
      }),
    };
    const runtime = {
      ...baseRuntime,
      mode: "tauri",
      cloudFoundation: {
        sync: {},
        access: {},
        projectKeys,
      },
      projectSecurity,
    } as unknown as DesktopRuntime;
    const user = userEvent.setup();
    renderRoute(runtime);

    await user.click(await screen.findByRole("button", { name: "创建设备身份" }));
    expect(await screen.findByText("设备可信")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "生成项目密钥与恢复码" }));
    const recoveryDialog = await screen.findByRole("dialog", {
      name: "保存一次性项目恢复码",
    });
    expect(recoveryDialog).toBeVisible();

    await user.type(
      within(recoveryDialog).getByLabelText("再次输入已保存的恢复码"),
      RECOVERY_CODE_FOR_INTERACTION,
    );
    await user.click(
      within(recoveryDialog).getByRole("checkbox", {
        name: "我已将恢复码保存到安全位置，并理解丢失全部设备和恢复码的后果。",
      }),
    );
    await user.click(within(recoveryDialog).getByRole("button", { name: "验证并激活" }));

    await waitFor(() => {
      expect(projectSecurity.confirmPendingProjectKey).toHaveBeenCalledTimes(1);
      expect(bundle?.version.state).toBe("active");
    });
    expect(await screen.findByText("项目密钥已在本机激活")).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "保存一次性项目恢复码" })).not.toBeInTheDocument();
  });

  it("does not enable project sync until the explicit consent checkbox is selected", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const projectId = await seedProject(baseRuntime);
    const fixture = createEnrollmentRuntime(baseRuntime, [projectId]);
    const user = userEvent.setup();
    renderRoute(fixture.runtime);

    await user.click(await screen.findByRole("button", { name: "启用云同步" }));
    const dialog = await screen.findByRole("dialog", { name: "为此项目启用云同步？" });
    const confirm = within(dialog).getByRole("button", { name: "确认启用云同步" });

    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(fixture.enableProject).not.toHaveBeenCalled();
  });

  it("enables the selected project exactly once after explicit consent", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const projectId = await seedProject(baseRuntime);
    const fixture = createEnrollmentRuntime(baseRuntime, [projectId]);
    const user = userEvent.setup();
    renderRoute(fixture.runtime);

    await user.click(await screen.findByRole("button", { name: "启用云同步" }));
    const dialog = await screen.findByRole("dialog", { name: "为此项目启用云同步？" });
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /我明确同意为当前项目启用端到端加密云同步/u,
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "确认启用云同步" }));

    await waitFor(() => {
      expect(fixture.enableProject).toHaveBeenCalledTimes(1);
      expect(fixture.enableProject).toHaveBeenCalledWith(projectId);
    });
    expect(await screen.findByText("此项目的云同步已启用")).toBeVisible();
  });

  it("requires a separate confirmation before disabling without deleting cloud ciphertext", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const projectId = await seedProject(baseRuntime);
    const fixture = createEnrollmentRuntime(baseRuntime, [projectId], "enabled");
    const user = userEvent.setup();
    renderRoute(fixture.runtime);

    await user.click(await screen.findByRole("button", { name: "关闭云同步" }));
    const dialog = await screen.findByRole("dialog", { name: "关闭此项目的云同步？" });
    expect(fixture.disableProject).not.toHaveBeenCalled();
    expect(within(dialog).getByText("云端密文不会被删除")).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "确认关闭云同步" }));
    await waitFor(() => {
      expect(fixture.disableProject).toHaveBeenCalledTimes(1);
      expect(fixture.disableProject).toHaveBeenCalledWith(projectId);
    });
    expect(await screen.findByText("此项目的云同步已关闭")).toBeVisible();
  });

  it("explains an enrollment failure without exposing its internal sync code", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const projectId = await seedProject(baseRuntime);
    const fixture = createEnrollmentRuntime(baseRuntime, [projectId], "error");

    renderRoute(fixture.runtime);

    expect(await screen.findByText("此项目的云同步需要处理")).toBeVisible();
    expect(screen.getByText(/云端操作未完成/u)).toBeVisible();
    expect(screen.queryByText(/SYNC_TEST_BLOCKED/u)).not.toBeInTheDocument();
  });

  it("loads durable state when switching projects without implicitly enabling either project", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const firstProjectId = await seedProject(baseRuntime);
    const secondProjectResult = await baseRuntime.useCases.createProject.execute({
      name: "第二个同步项目",
    });
    if (!secondProjectResult.ok) {
      throw secondProjectResult.error;
    }
    const secondProjectId = secondProjectResult.value.id;
    const fixture = createEnrollmentRuntime(baseRuntime, [firstProjectId, secondProjectId]);
    const user = userEvent.setup();
    renderRoute(fixture.runtime);

    await screen.findByText("此项目尚未授权云同步");
    await user.selectOptions(screen.getByLabelText("项目"), secondProjectId);

    await waitFor(() => {
      expect(fixture.loadProjectRegistration).toHaveBeenCalledWith(secondProjectId);
    });
    expect(fixture.enableProject).not.toHaveBeenCalled();
  });

  it("fails closed when a selected project's durable enrollment state cannot be read", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    const firstProjectId = await seedProject(baseRuntime);
    const secondProjectResult = await baseRuntime.useCases.createProject.execute({
      name: "授权状态读取失败项目",
    });
    if (!secondProjectResult.ok) {
      throw secondProjectResult.error;
    }
    const secondProjectId = secondProjectResult.value.id;
    const fixture = createEnrollmentRuntime(baseRuntime, [firstProjectId, secondProjectId]);
    const user = userEvent.setup();
    renderRoute(fixture.runtime);

    await screen.findByText("此项目尚未授权云同步");
    fixture.loadProjectRegistration.mockRejectedValueOnce(
      new Error("durable registration unavailable"),
    );
    await user.selectOptions(screen.getByLabelText("项目"), secondProjectId);

    expect(await screen.findByText("无法确认此项目的云同步授权状态")).toBeVisible();
    expect(screen.getByText(/云同步操作已保持锁定/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "启用云同步" })).not.toBeInTheDocument();
    expect(fixture.enableProject).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "重试读取" }));
    expect(await screen.findByText("此项目尚未授权云同步")).toBeVisible();
    expect(screen.queryByText("无法确认此项目的云同步授权状态")).not.toBeInTheDocument();
  });

  it("lists cloud devices and requires confirmation before remote revocation", async () => {
    const baseRuntime = createDevelopmentRuntime(window.localStorage);
    await seedProject(baseRuntime);
    const initial = cloudSnapshot(false);
    const cloudAccount = {
      load: vi.fn().mockResolvedValue(initial),
      revokeDevice: vi.fn().mockResolvedValue(cloudSnapshot(true)),
      revokeSession: vi.fn(),
    };
    const runtime = {
      ...baseRuntime,
      cloudAccount,
    } as unknown as DesktopRuntime;
    const user = userEvent.setup();
    renderRoute(runtime);

    expect(await screen.findByRole("heading", { name: "云账户设备与会话" })).toBeVisible();
    expect(await screen.findAllByText("备用电脑")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "撤销设备" }));

    const dialog = await screen.findByRole("dialog", { name: "撤销这台设备？" });
    expect(dialog).toBeVisible();
    expect(cloudAccount.revokeDevice).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "确认撤销设备" }));

    await waitFor(() => {
      expect(cloudAccount.revokeDevice).toHaveBeenCalledWith(OTHER_DEVICE_ID);
    });
    expect(screen.queryByText("备用电脑")).not.toBeInTheDocument();
  });
});

function renderRoute(runtime: DesktopRuntime) {
  return render(
    <MemoryRouter initialEntries={["/settings/sync"]}>
      <RuntimeProvider runtime={runtime}>
        <ToastProvider>
          <DesktopRoutes />
        </ToastProvider>
      </RuntimeProvider>
    </MemoryRouter>,
  );
}

async function seedProject(runtime: DesktopRuntime): Promise<string> {
  const result = await runtime.useCases.createProject.execute({
    name: "端到端加密测试项目",
  });
  if (!result.ok) {
    throw result.error;
  }
  return result.value.id;
}

function deviceRecord(displayName: string): DevicePublicKeyRecord {
  return {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    accountId: null,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: "A".repeat(87),
    publicKeyFingerprint: "a".repeat(64),
    displayName,
    keyOrigin: "local_os_credential",
    state: "trusted",
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}

function pendingBundle(projectId: string): ProjectKeyBundle {
  return {
    version: {
      schemaVersion: 1,
      projectId,
      keyVersion: 1,
      algorithm: "AES-256-GCM",
      state: "pending_confirmation",
      revision: 1,
      createdAt: NOW,
      retiredAt: null,
    },
    deviceEnvelope: {
      schemaVersion: 1,
      algorithm: "HPKE-AUTH-P256-HKDF-SHA256-AES128GCM",
      envelopeId: ENVELOPE_ID,
      projectId,
      keyVersion: 1,
      senderDeviceId: DEVICE_ID,
      senderPublicKey: "A".repeat(87),
      senderPublicKeyFingerprint: "a".repeat(64),
      recipientDeviceId: DEVICE_ID,
      recipientPublicKey: "A".repeat(87),
      recipientPublicKeyFingerprint: "a".repeat(64),
      encapsulatedKey: "B".repeat(87),
      ciphertext: "C".repeat(64),
      createdAt: NOW,
      revokedAt: null,
    },
    recoveryEnvelope: {
      schemaVersion: 1,
      algorithm: "ARGON2ID-AES256GCM",
      recoveryId: RECOVERY_ID,
      projectId,
      keyVersion: 1,
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
      createdAt: NOW,
      confirmedAt: null,
      revokedAt: null,
    },
  };
}

function activeBundle(projectId: string): ProjectKeyBundle {
  const pending = pendingBundle(projectId);
  return {
    ...pending,
    version: {
      ...pending.version,
      state: "active",
      revision: 2,
    },
    recoveryEnvelope: {
      ...pending.recoveryEnvelope,
      confirmedAt: "2026-07-27T03:01:00.000Z",
    },
  };
}

function projectRegistration(
  projectId: string,
  state: ProjectSyncRegistration["state"],
): ProjectSyncRegistration {
  return {
    projectId,
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    state,
    consentRevision: 1,
    keyVersion: 1,
    revision: state === "disabled" ? 3 : 2,
    plaintextBootstrapCompleted: state === "enabled",
    lastErrorCode: state === "error" ? "SYNC_TEST_BLOCKED" : null,
    createdAt: NOW,
    updatedAt: NOW,
    enabledAt: state === "enabled" ? NOW : null,
    pausedAt: state === "paused" || state === "disabled" ? NOW : null,
  };
}

function createEnrollmentRuntime(
  baseRuntime: DesktopRuntime,
  projectIds: readonly string[],
  initialState?: ProjectSyncRegistration["state"],
) {
  const registrations = new Map<string, ProjectSyncRegistration>();
  if (initialState !== undefined) {
    for (const projectId of projectIds) {
      registrations.set(projectId, projectRegistration(projectId, initialState));
    }
  }
  const loadProjectRegistration = vi.fn((projectId: string) =>
    Promise.resolve(registrations.get(projectId) ?? null),
  );
  const enableProject = vi.fn((projectId: string) => {
    const registration = projectRegistration(projectId, "enabled");
    registrations.set(projectId, registration);
    return Promise.resolve({
      operation: "enable" as const,
      projectId,
      state: "enabled" as const,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      consentRevision: 1,
      keyVersion: 1,
      registration,
      runtime: null,
      failure: null,
    });
  });
  const disableProject = vi.fn((projectId: string) => {
    const registration = projectRegistration(projectId, "disabled");
    registrations.set(projectId, registration);
    return Promise.resolve({
      operation: "disable" as const,
      projectId,
      state: "disabled" as const,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      consentRevision: 1,
      registration,
    });
  });
  const device = deviceRecord("我的电脑");
  const runtime = {
    ...baseRuntime,
    mode: "tauri",
    cloudFoundation: {
      sync: {},
      access: {},
      projectKeys: {
        listLocalDevicePublicKeys: vi.fn(() =>
          Promise.resolve(ok<readonly DevicePublicKeyRecord[]>([device])),
        ),
        loadProjectKeyBundle: vi.fn((projectId: string) =>
          Promise.resolve(ok(activeBundle(projectId))),
        ),
      },
    },
    projectSecurity: {},
    cloudSyncEnrollment: {
      isEnabled: true,
      loadProjectRegistration,
      enableProject,
      disableProject,
    },
  } as unknown as DesktopRuntime;
  return {
    runtime,
    loadProjectRegistration,
    enableProject,
    disableProject,
  };
}

function cloudSnapshot(otherRevoked: boolean) {
  const currentDevice = cloudDevice(DEVICE_ID, "我的电脑", "a", false);
  const otherDevice = cloudDevice(OTHER_DEVICE_ID, "备用电脑", "b", otherRevoked);
  return {
    accountId: ACCOUNT_ID,
    currentDeviceId: DEVICE_ID,
    currentSessionId: SESSION_ID,
    devices: [currentDevice, otherDevice],
    sessions: [
      cloudSession(SESSION_ID, DEVICE_ID, false),
      cloudSession(OTHER_SESSION_ID, OTHER_DEVICE_ID, otherRevoked),
    ],
  };
}

function cloudDevice(
  deviceId: string,
  displayName: string,
  fingerprintCharacter: string,
  revoked: boolean,
) {
  const revokedAt = revoked ? "2026-07-27T04:00:00.000Z" : null;
  return {
    schemaVersion: 1 as const,
    device: {
      schemaVersion: 1 as const,
      deviceId,
      accountId: ACCOUNT_ID,
      state: revoked ? ("revoked" as const) : ("trusted" as const),
      publicKeyFingerprint: fingerprintCharacter.repeat(64),
      createdAt: NOW,
      revokedAt,
    },
    publicKey: {
      schemaVersion: 1 as const,
      deviceId,
      accountId: ACCOUNT_ID,
      algorithm: "DHKEM-P256-HKDF-SHA256" as const,
      publicKey: fingerprintCharacter.toUpperCase().repeat(87),
      publicKeyFingerprint: fingerprintCharacter.repeat(64),
      createdAt: NOW,
      revokedAt,
    },
    displayName,
    revision: revoked ? 2 : 1,
  };
}

function cloudSession(sessionId: string, deviceId: string, revoked: boolean) {
  return {
    schemaVersion: 1 as const,
    sessionId,
    accountId: ACCOUNT_ID,
    deviceId,
    clientVersion: "0.1.0",
    minimumClientVersion: "0.1.0",
    issuedAt: NOW,
    expiresAt: "2026-08-27T03:00:00.000Z",
    revokedAt: revoked ? "2026-07-27T04:00:00.000Z" : null,
  };
}
