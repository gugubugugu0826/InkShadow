import { describe, expect, it, vi } from "vitest";
import type { InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import { AppError } from "@inkshadow/domain";
import type { DevicePublicKeyRecord } from "@inkshadow/data/project-key-sqlite-store";

import { CloudIdentityService } from "./cloud-identity-service";
import type { ProjectKeyLifecycleService } from "./project-key-lifecycle";
import type { CloudSessionVaultStatus } from "./cloud-session-vault";

const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000101";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000102";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000103";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000104";
const NEXT_SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000105";

describe("CloudIdentityService", () => {
  it("persists public grant metadata while session tokens remain behind native IPC", async () => {
    const fixture = createFixture();

    const status = await fixture.service.login({
      email: "writer@example.test",
      password: "test-secure-password",
      deviceDisplayName: "Writer laptop",
    });

    expect(fixture.projectSecurity.ensureLocalDeviceIdentity).toHaveBeenCalledWith({
      displayName: "Writer laptop",
    });
    expect(fixture.vault.login).toHaveBeenCalledWith({
      email: "writer@example.test",
      password: "test-secure-password",
      deviceId: DEVICE_ID,
      displayName: "Writer laptop",
    });
    expect(fixture.projectKeys.saveDevicePublicKey).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        keyOrigin: "local_os_credential",
      }),
    );
    expect(fixture.access.saveCurrentSessionGrantMetadata).toHaveBeenCalledWith({
      account: status.account,
      device: status.device?.device,
      session: status.session,
      supersededAt: "2026-07-27T02:00:00.000Z",
    });
    expect(JSON.stringify(status)).not.toMatch(/accessToken|refreshToken/u);
  });

  it("compensates a failed local metadata commit by revoking the native grant", async () => {
    const fixture = createFixture();
    fixture.access.saveCurrentSessionGrantMetadata.mockResolvedValueOnce({
      ok: false,
      error: new AppError({
        code: "REPOSITORY_ERROR",
        message: "test persistence failure",
      }),
    });

    await expect(
      fixture.service.login({
        email: "writer@example.test",
        password: "test-secure-password",
        deviceDisplayName: "Writer laptop",
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_ERROR" });

    expect(fixture.vault.logout).toHaveBeenCalledWith(SESSION_ID);
    expect(fixture.vault.clear).not.toHaveBeenCalled();
  });

  it("fails closed when neither native revocation nor conditional clearing can compensate", async () => {
    const fixture = createFixture();
    fixture.access.saveCurrentSessionGrantMetadata.mockResolvedValueOnce({
      ok: false,
      error: new AppError({
        code: "REPOSITORY_ERROR",
        message: "test persistence failure",
      }),
    });
    fixture.vault.logout.mockRejectedValueOnce(new Error("test network failure"));
    fixture.vault.clear.mockRejectedValueOnce(new Error("test credential-store failure"));

    await expect(
      fixture.service.login({
        email: "writer@example.test",
        password: "test-secure-password",
        deviceDisplayName: "Writer laptop",
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_ERROR" });

    expect(fixture.vault.clear).toHaveBeenCalledWith(SESSION_ID);
    expect(fixture.service.available).toBe(false);
    expect(() => fixture.service.getStatus()).toThrow(
      "Cloud identity requires the native desktop credential boundary.",
    );
  });

  it("revokes the rotated native session when refreshed local-device metadata cannot load", async () => {
    const fixture = createFixture();
    fixture.vault.refresh.mockResolvedValueOnce({
      ...configuredStatus(),
      session: {
        ...configuredStatus().session,
        sessionId: NEXT_SESSION_ID,
      },
    });
    fixture.projectKeys.findDevicePublicKey.mockResolvedValueOnce({
      ok: false,
      error: new AppError({
        code: "REPOSITORY_ERROR",
        message: "test device read failure",
      }),
    });

    await expect(fixture.service.refresh(SESSION_ID)).rejects.toMatchObject({
      code: "REPOSITORY_ERROR",
    });
    expect(fixture.vault.logout).toHaveBeenCalledWith(NEXT_SESSION_ID);
  });

  it("persists a refreshed grant as the only current local device session", async () => {
    const fixture = createFixture();
    const refreshed = {
      ...configuredStatus(),
      session: {
        ...configuredStatus().session,
        sessionId: NEXT_SESSION_ID,
      },
    };
    fixture.vault.refresh.mockResolvedValueOnce(refreshed);

    await expect(fixture.service.refresh(SESSION_ID)).resolves.toEqual(refreshed);
    expect(fixture.access.saveCurrentSessionGrantMetadata).toHaveBeenCalledWith({
      account: refreshed.account,
      device: refreshed.device.device,
      session: refreshed.session,
      supersededAt: "2026-07-27T02:00:00.000Z",
    });
  });

  it("fails closed and clears the grant when native metadata mismatches the local key", async () => {
    const fixture = createFixture();
    fixture.vault.login.mockResolvedValueOnce({
      ...configuredStatus(),
      device: {
        ...configuredStatus().device,
        publicKey: {
          ...configuredStatus().device.publicKey,
          publicKey: "B".repeat(87),
        },
      },
    });
    fixture.vault.logout.mockRejectedValueOnce(new Error("test network failure"));

    await expect(
      fixture.service.login({
        email: "writer@example.test",
        password: "test-secure-password",
        deviceDisplayName: "Writer laptop",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

    expect(fixture.access.saveCurrentSessionGrantMetadata).not.toHaveBeenCalled();
    expect(fixture.vault.clear).toHaveBeenCalledWith(SESSION_ID);
  });

  it("marks local session metadata revoked after native sign-out", async () => {
    const fixture = createFixture();
    fixture.vault.getStatus.mockResolvedValueOnce(configuredStatus());
    fixture.vault.logout.mockResolvedValueOnce(emptyStatus());

    await expect(fixture.service.logout(SESSION_ID)).resolves.toEqual(emptyStatus());
    expect(fixture.access.saveSessionMetadata).toHaveBeenCalledWith({
      ...configuredStatus().session,
      revokedAt: "2026-07-27T02:00:00.000Z",
    });
  });

  it("disables cloud identity if local revocation cannot follow native sign-out", async () => {
    const fixture = createFixture();
    fixture.vault.getStatus.mockResolvedValueOnce(configuredStatus());
    fixture.vault.logout.mockResolvedValueOnce(emptyStatus());
    fixture.access.saveSessionMetadata.mockResolvedValueOnce({
      ok: false,
      error: new AppError({
        code: "REPOSITORY_ERROR",
        message: "test revocation persistence failure",
      }),
    });

    await expect(fixture.service.logout(SESSION_ID)).rejects.toMatchObject({
      code: "REPOSITORY_ERROR",
    });
    expect(fixture.service.available).toBe(false);
  });

  it("reconciles a native session into an empty local metadata cache on startup", async () => {
    const fixture = createFixture();
    fixture.projectKeys.findDevicePublicKey.mockResolvedValueOnce({
      ok: true,
      value: null,
    });

    await expect(fixture.service.reconcileLocalState()).resolves.toEqual(configuredStatus());
    expect(fixture.projectSecurity.getVerifiedLocalDeviceIdentity).toHaveBeenCalledWith(DEVICE_ID);
    expect(fixture.projectKeys.saveDevicePublicKey).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        keyOrigin: "local_os_credential",
        publicKey: "A".repeat(87),
      }),
    );
    expect(fixture.access.saveCurrentSessionGrantMetadata).toHaveBeenCalledOnce();
  });

  it("does not rebuild trusted metadata when the OS device private key is missing", async () => {
    const fixture = createFixture();
    fixture.projectKeys.findDevicePublicKey.mockResolvedValueOnce({
      ok: true,
      value: null,
    });
    fixture.projectSecurity.getVerifiedLocalDeviceIdentity.mockResolvedValueOnce(null);
    fixture.vault.logout.mockRejectedValueOnce(new Error("test missing-key logout failure"));

    await expect(fixture.service.reconcileLocalState()).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(fixture.vault.clear).toHaveBeenCalledWith(SESSION_ID);
    expect(fixture.projectKeys.saveDevicePublicKey).not.toHaveBeenCalled();
    expect(fixture.access.saveCurrentSessionGrantMetadata).not.toHaveBeenCalled();
  });

  it("marks cached local-device sessions unusable when the native vault is empty", async () => {
    const fixture = createFixture();
    fixture.vault.getStatus.mockResolvedValueOnce(emptyStatus());
    fixture.projectKeys.listLocalDevicePublicKeys.mockResolvedValueOnce({
      ok: true,
      value: [localDevice()],
    });

    await expect(fixture.service.reconcileLocalState()).resolves.toEqual(emptyStatus());
    expect(fixture.access.revokeDeviceSessionMetadata).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      revokedAt: "2026-07-27T02:00:00.000Z",
    });
  });
});

function createFixture() {
  const device = localDevice();
  const vault = {
    available: true,
    login: vi.fn().mockResolvedValue(configuredStatus()),
    verifyEmail: vi.fn().mockResolvedValue(configuredStatus()),
    refresh: vi.fn().mockResolvedValue(configuredStatus()),
    getStatus: vi.fn().mockResolvedValue(configuredStatus()),
    logout: vi.fn().mockResolvedValue(emptyStatus()),
    clear: vi.fn().mockResolvedValue(emptyStatus()),
  };
  const projectSecurity = {
    ensureLocalDeviceIdentity: vi.fn().mockResolvedValue(device),
    getVerifiedLocalDeviceIdentity: vi.fn().mockResolvedValue(nativeIdentity()),
  };
  const access = {
    saveCurrentSessionGrantMetadata: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    saveSessionMetadata: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    revokeDeviceSessionMetadata: vi.fn().mockResolvedValue({ ok: true, value: 1 }),
  };
  const projectKeys = {
    findDevicePublicKey: vi.fn().mockResolvedValue({ ok: true, value: device }),
    listLocalDevicePublicKeys: vi.fn().mockResolvedValue({ ok: true, value: [device] }),
    saveDevicePublicKey: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
  const api = {
    registerIdentity: vi.fn(),
    requestPasswordReset: vi.fn(),
    confirmPasswordReset: vi.fn(),
  };
  const ids = { next: vi.fn().mockReturnValue(REQUEST_ID) };
  const clock = { now: vi.fn().mockReturnValue("2026-07-27T02:00:00.000Z") };
  const service = new CloudIdentityService(
    vault,
    api as unknown as InkShadowCloudApiClient,
    projectSecurity as unknown as ProjectKeyLifecycleService,
    access,
    projectKeys,
    ids,
    clock,
  );
  return { service, vault, projectSecurity, access, projectKeys };
}

function localDevice(): DevicePublicKeyRecord {
  return {
    schemaVersion: 1,
    deviceId: DEVICE_ID,
    accountId: null,
    algorithm: "DHKEM-P256-HKDF-SHA256",
    publicKey: "A".repeat(87),
    publicKeyFingerprint: "a".repeat(64),
    displayName: "Writer laptop",
    keyOrigin: "local_os_credential",
    state: "trusted",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    revokedAt: null,
  };
}

function nativeIdentity() {
  return {
    schemaVersion: 1 as const,
    deviceId: DEVICE_ID,
    algorithm: "DHKEM-P256-HKDF-SHA256" as const,
    publicKey: "A".repeat(87),
    publicKeyFingerprint: "a".repeat(64),
    privateKeyStorage: "os_credential_store" as const,
  };
}

function configuredStatus() {
  const createdAt = "2026-07-27T00:00:00.000Z";
  const accessExpiresAt = "2026-07-27T01:00:00.000Z";
  const fingerprint = "a".repeat(64);
  return {
    configured: true,
    account: {
      schemaVersion: 1,
      accountId: ACCOUNT_ID,
      state: "active",
      revision: 1,
      verifiedAt: createdAt,
      deletionScheduledFor: null,
      createdAt,
      updatedAt: createdAt,
    },
    device: {
      schemaVersion: 1,
      device: {
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        state: "trusted",
        publicKeyFingerprint: fingerprint,
        createdAt,
        revokedAt: null,
      },
      publicKey: {
        schemaVersion: 1,
        deviceId: DEVICE_ID,
        accountId: ACCOUNT_ID,
        algorithm: "DHKEM-P256-HKDF-SHA256",
        publicKey: "A".repeat(87),
        publicKeyFingerprint: fingerprint,
        createdAt,
        revokedAt: null,
      },
      displayName: "Writer laptop",
      revision: 1,
    },
    session: {
      schemaVersion: 1,
      sessionId: SESSION_ID,
      accountId: ACCOUNT_ID,
      deviceId: DEVICE_ID,
      clientVersion: "0.1.0",
      minimumClientVersion: "0.1.0",
      issuedAt: createdAt,
      expiresAt: accessExpiresAt,
      revokedAt: null,
    },
    expiry: {
      accessExpiresAt,
      refreshExpiresAt: "2026-08-26T00:00:00.000Z",
    },
  } satisfies CloudSessionVaultStatus;
}

function emptyStatus(): CloudSessionVaultStatus {
  return {
    configured: false,
    account: null,
    device: null,
    session: null,
    expiry: null,
  };
}
