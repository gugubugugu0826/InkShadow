import type { InkShadowCloudApiClient } from "@inkshadow/cloud-client";
import type { CloudDeviceContract, CloudSessionContract } from "@inkshadow/contracts";
import { AppError, type Clock, type UuidV7Generator } from "@inkshadow/domain";
import type { DevicePublicKeyRecord } from "@inkshadow/data/project-key-sqlite-store";
import { describe, expect, it, vi } from "vitest";

import { CloudAccountManagementService } from "./cloud-account-management-service";
import type {
  CloudSessionCoordinator,
  ConfiguredCloudSessionStatus,
} from "./cloud-session-coordinator";
import type { CloudSessionVaultStatus } from "./cloud-session-vault";

const ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000001";
const OTHER_ACCOUNT_ID = "019f9f4a-b3c7-7350-9226-000000000002";
const DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000003";
const OTHER_DEVICE_ID = "019f9f4a-b3c7-7350-9226-000000000004";
const SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000005";
const OTHER_SESSION_ID = "019f9f4a-b3c7-7350-9226-000000000006";
const REQUEST_ID = "019f9f4a-b3c7-7350-9226-000000000007";
const IDEMPOTENCY_KEY = "019f9f4a-b3c7-7350-9226-000000000008";
const NOW = "2026-07-27T00:00:00.000Z";
const REVOKED_AT = "2026-07-27T00:10:00.000Z";

describe("CloudAccountManagementService", () => {
  it("loads bounded pages and atomically caches only public account metadata", async () => {
    const fixture = createFixture();
    fixture.api.listDevices
      .mockResolvedValueOnce(deviceList([currentDevice()], "next_devices"))
      .mockResolvedValueOnce(deviceList([otherDevice()], null));
    fixture.api.listSessions.mockResolvedValueOnce(
      sessionList([currentSession(), otherSession()], null),
    );

    await expect(fixture.service.load()).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      currentDeviceId: DEVICE_ID,
      currentSessionId: SESSION_ID,
      devices: [{ device: { deviceId: DEVICE_ID } }, { device: { deviceId: OTHER_DEVICE_ID } }],
      sessions: [{ sessionId: SESSION_ID }, { sessionId: OTHER_SESSION_ID }],
    });
    expect(fixture.api.listDevices).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "next_devices", limit: 128 }),
    );
    expect(fixture.access.saveAccountManagementMetadata).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      devices: [currentDevice().device, otherDevice().device],
      sessions: [currentSession(), otherSession()],
    });
    expect(fixture.projectKeys.saveDevicePublicKey).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fixture.access.saveAccountManagementMetadata.mock.calls)).not.toMatch(
      /accessToken|refreshToken|password|authorization/iu,
    );
  });

  it("rejects cursor stalls and cross-account records without touching local metadata", async () => {
    const stalled = createFixture();
    stalled.api.listDevices.mockResolvedValue(deviceList([currentDevice()], "same_cursor"));
    stalled.api.listSessions.mockResolvedValue(sessionList([currentSession()], null));

    await expect(stalled.service.load()).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(stalled.access.saveAccountManagementMetadata).not.toHaveBeenCalled();

    const crossed = createFixture();
    crossed.api.listDevices.mockResolvedValue(
      deviceList([
        currentDevice(),
        {
          ...otherDevice(),
          device: { ...otherDevice().device, accountId: OTHER_ACCOUNT_ID },
          publicKey: { ...otherDevice().publicKey, accountId: OTHER_ACCOUNT_ID },
        },
      ]),
    );
    crossed.api.listSessions.mockResolvedValue(sessionList([currentSession()], null));

    await expect(crossed.service.load()).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(crossed.access.saveAccountManagementMetadata).not.toHaveBeenCalled();
  });

  it("checks frozen account and device authority inside the metadata-read session callback", async () => {
    const fixture = createFixture();
    const changed = currentStatus();
    const changedFingerprint = "c".repeat(64);
    fixture.session.runWithSession.mockImplementation((operation) =>
      operation({
        ...changed,
        device: {
          ...changed.device,
          device: {
            ...changed.device.device,
            publicKeyFingerprint: changedFingerprint,
          },
          publicKey: {
            ...changed.device.publicKey,
            publicKeyFingerprint: changedFingerprint,
          },
        },
      }),
    );

    await expect(
      fixture.service.load({
        expectedAuthority: {
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          devicePublicKeyFingerprint: "a".repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      details: { reasonCode: "CLOUD_ACCOUNT_MANAGEMENT_AUTHORITY_CHANGED" },
    });

    expect(fixture.api.listDevices).not.toHaveBeenCalled();
    expect(fixture.api.listSessions).not.toHaveBeenCalled();
    expect(fixture.access.saveAccountManagementMetadata).not.toHaveBeenCalled();
  });

  it("accepts a refreshed session id when the frozen account and device stay exact", async () => {
    const fixture = createFixture();
    const refreshed = {
      ...currentStatus(),
      session: {
        ...currentSession(),
        sessionId: OTHER_SESSION_ID,
      },
    };
    fixture.session.runWithSession.mockImplementation((operation) => operation(refreshed));
    fixture.api.listDevices.mockResolvedValue(deviceList([currentDevice()], null));
    fixture.api.listSessions.mockResolvedValue(sessionList([refreshed.session], null));

    await expect(
      fixture.service.load({
        expectedAuthority: {
          accountId: ACCOUNT_ID,
          deviceId: DEVICE_ID,
          devicePublicKeyFingerprint: "a".repeat(64),
        },
      }),
    ).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      currentDeviceId: DEVICE_ID,
      currentSessionId: OTHER_SESSION_ID,
    });
  });

  it("revokes another device and all of its cached sessions without clearing this device", async () => {
    const fixture = createFixture();
    fixture.api.listDevices.mockResolvedValue(deviceList([currentDevice(), otherDevice()], null));
    fixture.api.listSessions.mockResolvedValue(
      sessionList([currentSession(), otherSession()], null),
    );
    fixture.api.revokeDevice.mockResolvedValue({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      device: revokedDevice(otherDevice()),
    });

    const result = await fixture.service.revokeDevice(OTHER_DEVICE_ID);

    expect(result).toMatchObject({
      devices: [
        { device: { deviceId: DEVICE_ID, state: "trusted" } },
        { device: { deviceId: OTHER_DEVICE_ID, state: "revoked" } },
      ],
      sessions: [
        { sessionId: SESSION_ID, revokedAt: null },
        { sessionId: OTHER_SESSION_ID, revokedAt: REVOKED_AT },
      ],
    });
    expect(fixture.api.revokeDevice).toHaveBeenCalledWith(OTHER_DEVICE_ID, {
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    expect(fixture.identity.clearLocalSession).not.toHaveBeenCalled();
    expect(fixture.projectKeys.saveDevicePublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: OTHER_DEVICE_ID, state: "revoked" }),
    );
  });

  it("clears the native grant after revoking the active session", async () => {
    const fixture = createFixture();
    fixture.api.listDevices.mockResolvedValue(deviceList([currentDevice()], null));
    fixture.api.listSessions.mockResolvedValue(sessionList([currentSession()], null));
    fixture.api.revokeSession.mockResolvedValue({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      accepted: true,
      completedAt: REVOKED_AT,
    });

    await expect(fixture.service.revokeSession(SESSION_ID)).resolves.toBeNull();

    expect(fixture.access.saveAccountManagementMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: [expect.objectContaining({ sessionId: SESSION_ID, revokedAt: REVOKED_AT })],
      }),
    );
    expect(fixture.identity.clearLocalSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("clears the native grant even when current-device cache reconciliation fails", async () => {
    const fixture = createFixture();
    fixture.api.listDevices.mockResolvedValue(deviceList([currentDevice()], null));
    fixture.api.listSessions.mockResolvedValue(sessionList([currentSession()], null));
    fixture.api.revokeDevice.mockResolvedValue({
      schemaVersion: 1,
      requestId: REQUEST_ID,
      device: revokedDevice(currentDevice()),
    });
    fixture.access.saveAccountManagementMetadata.mockResolvedValueOnce({
      ok: false,
      error: new AppError({
        code: "REPOSITORY_ERROR",
        message: "test local persistence failure",
      }),
    });

    await expect(fixture.service.revokeDevice(DEVICE_ID)).rejects.toThrow(
      "test local persistence failure",
    );
    expect(fixture.identity.clearLocalSession).toHaveBeenCalledWith(SESSION_ID);
    expect(fixture.identity.disableAfterReconciliationFailure).toHaveBeenCalled();
  });
});

function createFixture() {
  const current = currentStatus();
  const api = {
    listDevices: vi.fn(),
    listSessions: vi.fn(),
    revokeDevice: vi.fn(),
    revokeSession: vi.fn(),
  };
  const session = {
    ensureReady: vi.fn().mockResolvedValue(current),
    runWithSession: vi.fn((operation: (status: ConfiguredCloudSessionStatus) => Promise<unknown>) =>
      operation(current),
    ),
  };
  const empty = emptyStatus();
  const identity = {
    getStatus: vi.fn().mockResolvedValue(current),
    clearLocalSession: vi.fn().mockResolvedValue(empty),
    disableAfterReconciliationFailure: vi.fn(),
  };
  const access = {
    saveAccountManagementMetadata: vi
      .fn()
      .mockResolvedValue({ ok: true as const, value: undefined }),
  };
  const projectKeys = {
    findDevicePublicKey: vi.fn((deviceId: string) =>
      Promise.resolve({
        ok: true as const,
        value: deviceId === DEVICE_ID ? existingLocalDevice() : null,
      }),
    ),
    saveDevicePublicKey: vi.fn().mockResolvedValue({ ok: true as const, value: undefined }),
  };
  const ids = {
    next: vi.fn().mockReturnValue(IDEMPOTENCY_KEY),
  } as unknown as UuidV7Generator;
  const clock = { now: vi.fn().mockReturnValue(NOW) } as unknown as Clock;
  const service = new CloudAccountManagementService(
    api as unknown as InkShadowCloudApiClient,
    session as unknown as CloudSessionCoordinator,
    identity,
    access,
    projectKeys,
    ids,
    clock,
  );
  return { service, api, session, identity, access, projectKeys };
}

function currentStatus(): ConfiguredCloudSessionStatus {
  return {
    configured: true,
    account: {
      schemaVersion: 1,
      accountId: ACCOUNT_ID,
      state: "active",
      revision: 1,
      verifiedAt: NOW,
      deletionScheduledFor: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    device: currentDevice(),
    session: currentSession(),
    expiry: {
      accessExpiresAt: "2026-07-27T01:00:00.000Z",
      refreshExpiresAt: "2026-08-27T00:00:00.000Z",
    },
  };
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

function currentDevice(): CloudDeviceContract {
  return device(DEVICE_ID, "我的电脑", "a", 1);
}

function otherDevice(): CloudDeviceContract {
  return device(OTHER_DEVICE_ID, "备用电脑", "b", 1);
}

function device(
  deviceId: string,
  displayName: string,
  fingerprintCharacter: string,
  revision: number,
): CloudDeviceContract {
  return {
    schemaVersion: 1,
    device: {
      schemaVersion: 1,
      deviceId,
      accountId: ACCOUNT_ID,
      state: "trusted",
      publicKeyFingerprint: fingerprintCharacter.repeat(64),
      createdAt: NOW,
      revokedAt: null,
    },
    publicKey: {
      schemaVersion: 1,
      deviceId,
      accountId: ACCOUNT_ID,
      algorithm: "DHKEM-P256-HKDF-SHA256",
      publicKey: fingerprintCharacter.toUpperCase().repeat(87),
      publicKeyFingerprint: fingerprintCharacter.repeat(64),
      createdAt: NOW,
      revokedAt: null,
    },
    displayName,
    revision,
  };
}

function revokedDevice(value: CloudDeviceContract): CloudDeviceContract {
  return {
    ...value,
    revision: value.revision + 1,
    device: { ...value.device, state: "revoked", revokedAt: REVOKED_AT },
    publicKey: { ...value.publicKey, revokedAt: REVOKED_AT },
  };
}

function currentSession(): CloudSessionContract {
  return session(SESSION_ID, DEVICE_ID);
}

function otherSession(): CloudSessionContract {
  return session(OTHER_SESSION_ID, OTHER_DEVICE_ID);
}

function session(sessionId: string, deviceId: string): CloudSessionContract {
  return {
    schemaVersion: 1,
    sessionId,
    accountId: ACCOUNT_ID,
    deviceId,
    clientVersion: "0.1.0",
    minimumClientVersion: "0.1.0",
    issuedAt: NOW,
    expiresAt: "2026-08-27T00:00:00.000Z",
    revokedAt: null,
  };
}

function deviceList(devices: readonly CloudDeviceContract[], nextCursor: string | null = null) {
  return {
    schemaVersion: 1 as const,
    requestId: REQUEST_ID,
    devices,
    nextCursor,
  };
}

function sessionList(sessions: readonly CloudSessionContract[], nextCursor: string | null = null) {
  return {
    schemaVersion: 1 as const,
    requestId: REQUEST_ID,
    sessions,
    nextCursor,
  };
}

function existingLocalDevice(): DevicePublicKeyRecord {
  const value = currentDevice();
  return {
    schemaVersion: 1,
    deviceId: value.device.deviceId,
    accountId: ACCOUNT_ID,
    algorithm: value.publicKey.algorithm,
    publicKey: value.publicKey.publicKey,
    publicKeyFingerprint: value.publicKey.publicKeyFingerprint,
    displayName: value.displayName,
    keyOrigin: "local_os_credential",
    state: "trusted",
    createdAt: NOW,
    updatedAt: NOW,
    revokedAt: null,
  };
}
